'use strict'
/**
 * Auma X5 <-> X6.1 Convergence Organ: `seed-receipts` (`seed_receipts`)
 *
 * Implements X5's exact `aukora.receipt.v3` hash-chained Merkle log and
 * `aukora.edge-checkpoint.v1` domain-separated WebCrypto Ed25519 signed checkpoints
 * (`aukora.x5.edge-head.v1\0` + RFC 8785 / C1 canonical JSON).
 * Creating checkpoint 15+ requires an authenticated host policy permitting a finite v1 window.
 * Hybrid windows fail before mutation until the runtime supplies a hybrid signer.
 * Verification separates signed checkpoint history from independent host-pinned signer trust.
 * An unavailable policy leaves verified history unanchored and permits receipt append, never checkpoint 15+ signing.
 * Local/caller keys establish consistency only; they cannot substitute for independent signer authority.
 * `publicKeyHex`, `genesisPublicKeyHex`, `signers` and `keyRotations` describe verified checkpoints;
 * `activePublicKeyHex` is separate, unsigned local-key metadata. Neither establishes owner consent.
 * `receiptSnapshot` binds verification to exact captured log bytes; `checkpointReceiptCount` is the
 * signed prefix length, not necessarily all receipts. Independent coverage also needs signerAnchored.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = '/dsh/home/auma/seed'
const RECEIPTS_FILE = path.join(ROOT, 'receipts.v3.jsonl')
const CHECKPOINTS_FILE = path.join(ROOT, 'checkpoints.v1.jsonl')
const KEYPAIR_FILE = path.join(ROOT, 'ed25519-keypair.json')
const DOMAIN_PREFIX = 'aukora.x5.edge-head.v1\0'

// --- Gate 0: the owner grant is checked by signature, not by calling convention ---------
// A `mandate.grant` leaf is written only around an Ed25519 owner grant that verifies against the owner key
// in owner-key.v1.json. That file is pinned by its SHA-256 here, so neither the file nor a caller can swap
// the trust root. The signed bytes match deploy/cloudflare/src/owner-grant-policy.mjs and
// apps/web/src/spatial/superagent/owner-grant.ts exactly: the domain, a NUL byte, then the canonical
// seven-field binding.
const OWNER_KEY_FILE = path.join(ROOT, 'owner-key.v1.json')
const OWNER_KEY_FILE_SHA256 = '23454c87b5ebf2f3b9fef7917c04656d80bfe79909e9a34935fc907b2c27bfa3'
const OWNER_GRANT_SCHEMA = 'aukora.x6.owner-grant.v1'
const OWNER_GRANT_DOMAIN = OWNER_GRANT_SCHEMA + '\0'
const OWNER_REJECTED_IDENTITIES = new Set(['spatial-tab', 'agent', 'agent-self-unverified', 'person'])
const BALL_HEAD_FILE = '/dsh/home/balls/HEAD.json'
// Historical sandbox identities accepted for chain consistency, never independent signer authority.
const KNOWN_SIGNER_KEYS = new Set([
  'baf94a77cb28f9575846eec092cfbd9094d4ac2c3af305a7fd8350d41c720c68',
  'a2ddc7222e4194dd856f7fc05ebddc9c18482b1eaa712d0dc9bd63da9af22e99',
])

function getFs(ctx) {
  if (ctx && ctx.fs && typeof ctx.fs.writeFileSync === 'function') return ctx.fs
  return fs
}

function canonicalJson(val) {
  if (val === null || typeof val !== 'object') return JSON.stringify(val)
  if (Array.isArray(val)) return '[' + val.map((x) => canonicalJson(x === undefined ? null : x)).join(',') + ']'
  const keys = Object.keys(val).filter((k) => val[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(val[k])).join(',') + '}'
}

function sha256Hex(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex')
}

function merkleLeafHash(payloadObj) {
  const canon = Buffer.from(canonicalJson(payloadObj), 'utf8')
  return crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), canon])).digest('hex')
}

function merkleRootHex(leafHashesHex) {
  if (!Array.isArray(leafHashesHex) || leafHashesHex.length === 0) {
    return sha256Hex('')
  }
  let level = leafHashesHex.map((h) => Buffer.from(h, 'hex'))
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        const combined = Buffer.concat([Buffer.from([0x01]), level[i], level[i + 1]])
        next.push(crypto.createHash('sha256').update(combined).digest())
      } else {
        next.push(level[i])
      }
    }
    level = next
  }
  return level[0].toString('hex')
}

// Digest and parse the same captured bytes; an absent log differs from an empty one.
function readJsonlSnapshot(vfs, filePath) {
  if (!vfs.existsSync(filePath)) return { rows: [], present: false, sha256: null }
  const bytes = Buffer.from(vfs.readFileSync(filePath))
  const raw = bytes.toString('utf8').trim()
  const rows = raw ? raw.split('\n').map((line) => {
    try {
      const parsed = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('record required')
      return parsed
    } catch { throw new Error('RECEIPT_LOG_CORRUPT: invalid record in ' + filePath) }
  }) : []
  return { rows, present: true, sha256: sha256Hex(bytes) }
}

function readJsonl(vfs, filePath) {
  return readJsonlSnapshot(vfs, filePath).rows
}

function appendJsonl(vfs, filePath, record) {
  vfs.mkdirSync(path.dirname(filePath), { recursive: true })
  const line = canonicalJson(record) + '\n'
  const prevText = vfs.existsSync(filePath) ? String(vfs.readFileSync(filePath, 'utf8') || '') : ''
  vfs.writeFileSync(filePath, prevText ? (prevText.endsWith('\n') ? prevText + line : prevText + '\n' + line) : line)
}

// Only the runtime's authenticated host reader supplies policy; caller arguments and VFS files cannot extend it.
async function checkpointPolicySnapshot(ctx) {
  if (!ctx || !ctx.checkpointPolicy || typeof ctx.checkpointPolicy.read !== 'function') {
    return { ok: true, ranges: null }
  }
  let policy
  try { policy = await ctx.checkpointPolicy.read() }
  catch (_error) { return { ok: false, error: 'CHECKPOINT_SIGNER_POLICY_UNAVAILABLE' } }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).length !== 3
      || policy.ok !== true || policy.schema !== 'aukora.checkpoint-policy.v1'
      || !Array.isArray(policy.ranges) || !policy.ranges.length || policy.ranges.length > 256) {
    return { ok: false, error: 'CHECKPOINT_SIGNER_POLICY_INVALID' }
  }
  let next = 1, hybridStarted = false
  const ranges = []
  for (const range of policy.ranges) {
    if (!range || typeof range !== 'object' || Array.isArray(range) || Object.keys(range).length !== 4
        || range.firstSeq !== next || !Number.isSafeInteger(range.lastSeq) || range.lastSeq < next
        || range.lastSeq >= Number.MAX_SAFE_INTEGER || !['v1', 'v2'].includes(range.envelope)
        || typeof range.publicKeyHex !== 'string' || !/^[a-f0-9]{64}$/.test(range.publicKeyHex)
        || (range.envelope === 'v1' ? hybridStarted : next < 15)) {
      return { ok: false, error: 'CHECKPOINT_SIGNER_POLICY_INVALID' }
    }
    if (range.envelope === 'v2') hybridStarted = true
    ranges.push({ ...range })
    next = range.lastSeq + 1
  }
  return { ok: true, ranges }
}

function checkpointSigningRange(policy, seq) {
  if (!policy.ok) return policy
  if (!policy.ranges) return seq <= 14 ? { ok: true, range: null } : { ok: false, error: 'CHECKPOINT_SIGNER_POLICY_UNAVAILABLE' }
  const selected = policy.ranges.find(range => seq >= range.firstSeq && seq <= range.lastSeq)
  if (!selected) return { ok: false, error: 'CHECKPOINT_SIGNER_POLICY_EXPIRED' }
  if (selected.envelope === 'v2') return { ok: false, error: 'CHECKPOINT_HYBRID_SIGNER_UNAVAILABLE' }
  return { ok: true, range: selected }
}

async function ensureEd25519Keypair(vfs) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle
  if (!subtle) throw new Error('WebCrypto crypto.subtle unavailable')
  if (vfs.existsSync(KEYPAIR_FILE)) {
    try {
      const saved = JSON.parse(String(vfs.readFileSync(KEYPAIR_FILE, 'utf8')))
      const privateKey = await subtle.importKey('jwk', saved.privateJwk, { name: 'Ed25519' }, true, ['sign'])
      const publicKey = await subtle.importKey('jwk', saved.publicJwk, { name: 'Ed25519' }, true, ['verify'])
      const rawPublic = Buffer.from(new Uint8Array(await subtle.exportKey('raw', publicKey))).toString('hex')
      if (rawPublic !== saved.publicKeyHex || saved.privateJwk.x !== saved.publicJwk.x) throw new Error('signing key identity mismatch')
      const challenge = new TextEncoder().encode(DOMAIN_PREFIX + 'key-continuity')
      const signature = await subtle.sign({ name: 'Ed25519' }, privateKey, challenge)
      if (!await subtle.verify({ name: 'Ed25519' }, publicKey, signature, challenge)) throw new Error('signing key pair mismatch')
      return { privateKey, publicKey, publicKeyHex: saved.publicKeyHex }
    } catch (error) {
      throw new Error('SIGNING_KEY_UNREADABLE: existing signing identity was preserved; restore it instead of regenerating: ' + String(error && error.message || error))
    }
  }
  const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const privateJwk = await subtle.exportKey('jwk', kp.privateKey)
  const publicJwk = await subtle.exportKey('jwk', kp.publicKey)
  const rawPub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey))
  const publicKeyHex = Buffer.from(rawPub).toString('hex')
  vfs.mkdirSync(ROOT, { recursive: true })
  vfs.writeFileSync(KEYPAIR_FILE, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', publicKeyHex, privateJwk, publicJwk }, null, 2) + '\n')
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicKeyHex }
}

function readOwnerKey(vfs) {
  let raw
  try { raw = vfs.readFileSync(OWNER_KEY_FILE) } catch { return { ok: false, reason: 'owner-key-missing' } }
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === 'string' ? raw : new Uint8Array(raw))
  if (sha256Hex(bytes) !== OWNER_KEY_FILE_SHA256) return { ok: false, reason: 'owner-key-pin-mismatch' }
  let key
  try { key = JSON.parse(bytes.toString('utf8')) } catch { return { ok: false, reason: 'owner-key-unreadable' } }
  if (!key || key.schema !== 'aukora.owner-key.v1' || key.algorithm !== 'Ed25519' || key.domain !== OWNER_GRANT_SCHEMA ||
      typeof key.publicKeyHex !== 'string' || !/^[0-9a-f]{64}$/.test(key.publicKeyHex)) return { ok: false, reason: 'owner-key-malformed' }
  return { ok: true, publicKeyHex: key.publicKeyHex }
}

function ownerGrantText(grant) {
  return canonicalJson({
    schema: OWNER_GRANT_SCHEMA, mandateId: grant.mandateId, ticketId: grant.ticketId,
    scope: grant.scope === undefined ? null : grant.scope, ballId: grant.ballId, epoch: grant.epoch,
    expiresAt: grant.expiresAt, identity: grant.identity,
  })
}

function readHead(vfs) {
  try { return JSON.parse(String(vfs.readFileSync(BALL_HEAD_FILE, 'utf8'))) } catch { return null }
}

/**
 * Verify an owner grant envelope and its binding to the receipt data and the selected head.
 * Returns null when it verifies, or the reason it does not. Never trusts a key the caller supplies.
 */
async function ownerGrantRefusal(vfs, envelope, data, receipts) {
  const grant = envelope
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return 'envelope-missing'
  if (grant.schema !== OWNER_GRANT_SCHEMA) return 'envelope-schema'
  if (typeof grant.mandateId !== 'string' || !grant.mandateId || grant.mandateId.length > 200) return 'envelope-mandate'
  if (grant.ticketId !== null && (typeof grant.ticketId !== 'string' || !grant.ticketId)) return 'envelope-ticket'
  if (typeof grant.identity !== 'string' || !grant.identity.trim() || OWNER_REJECTED_IDENTITIES.has(grant.identity.trim().toLowerCase())) return 'identity-rejected'
  if (typeof grant.ballId !== 'string' || !/^[0-9a-f]{64}$/.test(grant.ballId) || !Number.isSafeInteger(grant.epoch) || grant.epoch < 0) return 'envelope-head'
  if (grant.expiresAt !== null && (typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now())) return 'expired'
  if (typeof grant.publicKeyHex !== 'string' || !/^[0-9a-f]{64}$/.test(grant.publicKeyHex)) return 'envelope-key'
  if (typeof grant.signatureHex !== 'string' || !/^[0-9a-f]{128}$/.test(grant.signatureHex)) return 'envelope-signature'
  const owner = readOwnerKey(vfs)
  if (!owner.ok) return owner.reason
  if (grant.publicKeyHex !== owner.publicKeyHex) return 'untrusted-key'
  // The receipt must record exactly the terms the owner signed, on the head they were signed against.
  const d = data || {}
  if (d.mandateId !== grant.mandateId || (d.ticketId ?? null) !== grant.ticketId || d.identity !== grant.identity ||
      d.ballId !== grant.ballId || d.epoch !== grant.epoch ||
      canonicalJson(d.scope === undefined ? null : d.scope) !== canonicalJson(grant.scope === undefined ? null : grant.scope)) return 'binding-mismatch'
  const head = readHead(vfs)
  if (!head || head.ballId !== grant.ballId || head.epoch !== grant.epoch) return 'head-mismatch'
  if (receipts.some((r) => r.kind === 'mandate.grant' && r.data && r.data.ownerGrant && r.data.ownerGrant.signatureHex === grant.signatureHex)) return 'replayed'
  const subtle = globalThis.crypto && globalThis.crypto.subtle
  if (!subtle) return 'webcrypto-unavailable'
  try {
    const key = await subtle.importKey('raw', Buffer.from(owner.publicKeyHex, 'hex'), { name: 'Ed25519' }, false, ['verify'])
    const message = new TextEncoder().encode(OWNER_GRANT_DOMAIN + ownerGrantText(grant))
    return await subtle.verify({ name: 'Ed25519' }, key, Buffer.from(grant.signatureHex, 'hex'), message) ? null : 'bad-signature'
  } catch { return 'bad-signature' }
}

// Per-VFS serialization survives hot reload; it is not cross-tab or distributed CAS.
async function runReceiptOp(args, ctx, suppliedPolicy) {
    const vfs = getFs(ctx)
    const input = (args && typeof args === 'object') ? args : {}
    const action = input.action || 'list'
    // One detached host-policy snapshot covers both mutation preflight and signing.
    const policy = ['append', 'checkpoint', 'verify'].includes(action)
      ? suppliedPolicy || await checkpointPolicySnapshot(ctx) : null

    let verifiedHistory
    if (action === 'append' || action === 'checkpoint') {
      verifiedHistory = await runReceiptOp({ action: 'verify', expectedPublicKey: input.expectedPublicKey }, ctx, policy)
      if (!verifiedHistory.ok) return { ok: false, action, error: 'RECEIPT_CHAIN_INVALID', verification: verifiedHistory }
    }

    // Gate 0. An earlier epoch refused every `mandate.grant` append, which also shut out the one
    // legitimate writer (a confirmed grant in seed-superagent), so that organ wrote the log directly and
    // there were two writers. Now this organ is the only writer, and the grant is judged by its owner
    // signature: a forged or unsigned grant is refused here whoever the caller is.
    if (action === 'append' && String(input.kind || '') === 'mandate.grant') {
      const reason = await ownerGrantRefusal(vfs, input.envelope, input.data, readJsonl(vfs, RECEIPTS_FILE))
      if (reason) {
        return {
          ok: false,
          action,
          error: 'MANDATE_SIGNATURE_INVALID',
          kind: 'mandate.grant',
          reason,
          detail: 'mandate.grant needs an aukora.x6.owner-grant.v1 envelope signed by the owner key in owner-key.v1.json, bound to the receipt data and the selected head.',
        }
      }
    }

    if (action === 'append') {
      const receipts = readJsonl(vfs, RECEIPTS_FILE)
      const seq = receipts.length + 1
      const prevHash = receipts.length > 0 ? receipts[receipts.length - 1].leafHash : '0'.repeat(64)
      const payload = {
        schema: 'aukora.receipt.v3',
        seq,
        at: new Date().toISOString(),
        kind: String(input.kind || 'event'),
        prevHash,
        data: (input.data && typeof input.data === 'object') ? input.data : {},
      }
      if (payload.kind === 'mandate.grant') payload.data = { ...payload.data, ownerGrant: input.envelope }
      const leafHash = merkleLeafHash(payload)
      const record = { ...payload, leafHash }
      appendJsonl(vfs, RECEIPTS_FILE, record)
      const allLeaves = [...receipts.map((r) => r.leafHash), leafHash]
      return {
        ok: true,
        action: 'append',
        receipt: record,
        merkleRoot: merkleRootHex(allLeaves),
        totalReceipts: allLeaves.length,
        ...(verifiedHistory.checkpointPolicyError ? {
          chainSigned: verifiedHistory.chainSigned,
          signerAnchored: verifiedHistory.signerAnchored,
          signerStatus: verifiedHistory.signerStatus,
          identityAnchored: verifiedHistory.identityAnchored,
          verificationScope: verifiedHistory.verificationScope,
          checkpointReceiptCount: verifiedHistory.checkpointReceiptCount,
          checkpointPolicyError: verifiedHistory.checkpointPolicyError,
        } : {}),
      }
    }

    if (action === 'checkpoint') {
      const receipts = readJsonl(vfs, RECEIPTS_FILE)
      const checkpoints = readJsonl(vfs, CHECKPOINTS_FILE)
      const signing = checkpointSigningRange(policy, checkpoints.length + 1)
      if (!signing.ok) return { ...signing, action, nextCheckpointSeq: checkpoints.length + 1 }
      if ((checkpoints.length || signing.range) && !vfs.existsSync(KEYPAIR_FILE)) {
        return { ok: false, action, error: 'SIGNING_KEY_MISSING', detail: 'Restore the existing signing identity; checkpoint history was preserved.' }
      }
      const { privateKey, publicKeyHex } = await ensureEd25519Keypair(vfs)
      if (signing.range && signing.range.publicKeyHex !== publicKeyHex) {
        return { ok: false, action, error: 'CHECKPOINT_SIGNER_POLICY_MISMATCH' }
      }
      const leafHashes = receipts.map((r) => r.leafHash)
      const merkleRoot = merkleRootHex(leafHashes)
      const prevCheckpointHash = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].checkpointHash : null
      const livePeers = (ctx && ctx.presence && typeof ctx.presence.list === 'function')
        ? ctx.presence.list().map((p) => p.peerId)
        : []
      const body = {
        schema: 'aukora.edge-checkpoint.v1',
        seq: checkpoints.length + 1,
        at: new Date().toISOString(),
        receiptCount: receipts.length,
        lastReceiptHash: receipts.length > 0 ? receipts[receipts.length - 1].leafHash : '0'.repeat(64),
        merkleRoot,
        prevCheckpointHash,
        livePeers,
        ...(input.note ? { note: String(input.note) } : {}),
      }
      const messageBytes = new TextEncoder().encode(DOMAIN_PREFIX + canonicalJson(body))
      const sigBuf = await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, privateKey, messageBytes)
      const signatureHex = Buffer.from(new Uint8Array(sigBuf)).toString('hex')
      const checkpointHash = sha256Hex(canonicalJson({ body, publicKeyHex, signatureHex }))
      const envelope = {
        body,
        publicKeyHex,
        signatureHex,
        checkpointHash,
      }
      appendJsonl(vfs, CHECKPOINTS_FILE, envelope)
      return {
        ok: true,
        action: 'checkpoint',
        checkpoint: envelope,
      }
    }

    if (action === 'verify') {
      const receiptLog = readJsonlSnapshot(vfs, RECEIPTS_FILE)
      const checkpointLog = readJsonlSnapshot(vfs, CHECKPOINTS_FILE)
      const receipts = receiptLog.rows
      const checkpoints = checkpointLog.rows
      let prevHash = '0'.repeat(64)
      for (let i = 0; i < receipts.length; i++) {
        const r = receipts[i]
        const { leafHash, ...payload } = r
        const expectedLeaf = merkleLeafHash(payload)
        if (r.schema !== 'aukora.receipt.v3' || r.seq !== i + 1 || r.prevHash !== prevHash || leafHash !== expectedLeaf) {
          return {
            ok: false,
            action: 'verify',
            stage: 'receipt-chain',
            failedSeq: i + 1,
            expectedLeaf,
            actualLeaf: leafHash,
          }
        }
        prevHash = leafHash
      }

      const subtle = globalThis.crypto && globalThis.crypto.subtle
      const explicitExpectedKey = input.expectedPublicKey || null
      if (explicitExpectedKey && !/^[0-9a-f]{64}$/.test(explicitExpectedKey)) {
        return { ok: false, action: 'verify', stage: 'expected-public-key-invalid' }
      }
      let localKeypairPublicKey = null
      if (vfs.existsSync(KEYPAIR_FILE)) {
        try {
          const saved = JSON.parse(String(vfs.readFileSync(KEYPAIR_FILE, 'utf8')))
          if (typeof saved.publicKeyHex !== 'string' || !/^[0-9a-f]{64}$/.test(saved.publicKeyHex)) throw new Error('public key missing')
          localKeypairPublicKey = saved.publicKeyHex
        } catch {
          return { ok: false, action: 'verify', stage: 'signing-key-unreadable' }
        }
      }
      const allowedSigners = new Set(KNOWN_SIGNER_KEYS)
      if (localKeypairPublicKey) allowedSigners.add(localKeypairPublicKey)
      if (explicitExpectedKey) allowedSigners.add(explicitExpectedKey)

      const signers = []
      const keyRotations = []
      let prevCpHash = null
      let prevCount = 0
      const policyUnavailable = policy.ok ? !policy.ranges : policy.error === 'CHECKPOINT_SIGNER_POLICY_UNAVAILABLE'
      let policyMatches = Boolean(policy.ok && policy.ranges)
      for (let i = 0; i < checkpoints.length; i++) {
        const cp = checkpoints[i]
        if (!cp.body || cp.body.schema !== 'aukora.edge-checkpoint.v1' || cp.body.seq !== i + 1 ||
            !Number.isSafeInteger(cp.body.receiptCount) || cp.body.receiptCount < prevCount || cp.body.receiptCount > receipts.length ||
            cp.body.lastReceiptHash !== (cp.body.receiptCount ? receipts[cp.body.receiptCount - 1].leafHash : '0'.repeat(64))) {
          return { ok: false, action: 'verify', stage: 'checkpoint-fields', failedCheckpointSeq: i + 1 }
        }
        const expectedCheckpointHash = sha256Hex(canonicalJson({ body: cp.body, publicKeyHex: cp.publicKeyHex, signatureHex: cp.signatureHex }))
        if (cp.checkpointHash !== expectedCheckpointHash) {
          return { ok: false, action: 'verify', stage: 'checkpoint-hash', failedCheckpointSeq: i + 1 }
        }
        const validHex = typeof cp.publicKeyHex === 'string' && /^[0-9a-f]{64}$/.test(cp.publicKeyHex) &&
          typeof cp.signatureHex === 'string' && /^[0-9a-f]{128}$/.test(cp.signatureHex)
        const range = policy.ok && policy.ranges
          ? policy.ranges.find(range => i + 1 >= range.firstSeq && i + 1 <= range.lastSeq) : null
        const independentlyAdmitted = Boolean(range && range.envelope === 'v1' && range.publicKeyHex === cp.publicKeyHex)
        const trustedForChain = explicitExpectedKey
          ? cp.publicKeyHex === explicitExpectedKey
          : allowedSigners.has(cp.publicKeyHex) || independentlyAdmitted
        if (!validHex || !trustedForChain) {
          return { ok: false, action: 'verify', stage: 'checkpoint-signer', failedCheckpointSeq: i + 1 }
        }
        // An outage removes independent signer trust, not the cryptographic checks below.
        if (i + 1 > 14 && !policyUnavailable) {
          const signing = checkpointSigningRange(policy, i + 1)
          if (!signing.ok || !independentlyAdmitted) {
            return { ok: false, action: 'verify', stage: 'checkpoint-policy', failedCheckpointSeq: i + 1,
              error: signing.ok ? 'CHECKPOINT_SIGNER_POLICY_MISMATCH' : signing.error }
          }
        }
        if (!subtle) return { ok: false, action: 'verify', stage: 'webcrypto-unavailable' }
        if (cp.body.prevCheckpointHash !== prevCpHash) {
          return { ok: false, action: 'verify', stage: 'checkpoint-chain', failedCheckpointSeq: i + 1 }
        }
        const pubBytes = Buffer.from(cp.publicKeyHex, 'hex')
        const pubKey = await subtle.importKey('raw', pubBytes, { name: 'Ed25519' }, false, ['verify'])
        const msgBytes = new TextEncoder().encode(DOMAIN_PREFIX + canonicalJson(cp.body))
        const sigBytes = Buffer.from(cp.signatureHex, 'hex')
        const validSig = await subtle.verify({ name: 'Ed25519' }, pubKey, sigBytes, msgBytes)
        if (!validSig) {
          return { ok: false, action: 'verify', stage: 'ed25519-signature', failedCheckpointSeq: i + 1 }
        }
        const slicedLeaves = receipts.slice(0, cp.body.receiptCount).map((r) => r.leafHash)
        const expectedRoot = merkleRootHex(slicedLeaves)
        if (cp.body.merkleRoot !== expectedRoot) {
          return { ok: false, action: 'verify', stage: 'merkle-root', failedCheckpointSeq: i + 1, expectedRoot, actualRoot: cp.body.merkleRoot }
        }
        policyMatches = policyMatches && independentlyAdmitted
        if (!signers.includes(cp.publicKeyHex)) signers.push(cp.publicKeyHex)
        if (i > 0 && cp.publicKeyHex !== checkpoints[i - 1].publicKeyHex) {
          keyRotations.push({
            atCheckpointSeq: i + 1,
            fromPublicKeyHex: checkpoints[i - 1].publicKeyHex,
            toPublicKeyHex: cp.publicKeyHex,
            prevCheckpointHash: prevCpHash,
          })
        }
        prevCpHash = cp.checkpointHash
        prevCount = cp.body.receiptCount
      }

      const chainSigned = checkpoints.length > 0
      const signerAnchored = chainSigned && policyMatches
      const signerStatus = signerAnchored ? 'pinned'
        : policyUnavailable && checkpoints.length > 14 ? 'unanchored'
        : chainSigned && signers.every(key => KNOWN_SIGNER_KEYS.has(key)) ? 'historical-sandbox' : 'unanchored'
      return {
        ok: true,
        action: 'verify',
        chainSigned,
        signerAnchored,
        signerStatus,
        identityAnchored: signerAnchored,
        verificationScope: signerAnchored ? 'anchored-chain' : 'chain-consistency',
        ...(policyUnavailable ? { checkpointPolicyError: 'CHECKPOINT_SIGNER_POLICY_UNAVAILABLE' } : {}),
        publicKeyHex: chainSigned ? checkpoints[checkpoints.length - 1].publicKeyHex : null,
        genesisPublicKeyHex: chainSigned ? checkpoints[0].publicKeyHex : null,
        activePublicKeyHex: localKeypairPublicKey,
        signers,
        keyRotations,
        receiptsVerified: receipts.length,
        checkpointsVerified: checkpoints.length,
        checkpointReceiptCount: prevCount,
        receiptSnapshot: {
          receiptsPresent: receiptLog.present, receiptsSha256: receiptLog.sha256,
          checkpointsPresent: checkpointLog.present, checkpointsSha256: checkpointLog.sha256,
        },
        currentMerkleRoot: merkleRootHex(receipts.map((r) => r.leafHash)),
        latestCheckpointHash: prevCpHash,
      }
    }

    const receipts = readJsonl(vfs, RECEIPTS_FILE)
    const checkpoints = readJsonl(vfs, CHECKPOINTS_FILE)
    return {
      ok: true,
      action: 'list',
      receiptsCount: receipts.length,
      checkpointsCount: checkpoints.length,
      currentMerkleRoot: merkleRootHex(receipts.map((r) => r.leafHash)),
      recentReceipts: receipts.slice(-10),
      recentCheckpoints: checkpoints.slice(-5),
    }
}

module.exports = {
  name: 'seed-receipts',
  description:
    'Cryptographic Receipt Chain (`aukora.receipt.v3`) & Ed25519 Signed Edge Checkpoints (`aukora.edge-checkpoint.v1`). ' +
    'Uses RFC 8785 / C1 canonical JSON, domain-separated Merkle leaves (`0x00`) and internal nodes (`0x01`), and WebCrypto Ed25519 (`aukora.x5.edge-head.v1\\0`). ' +
    'Creating checkpoint 15+ requires an authenticated host policy with a finite matching v1 window; hybrid signing is unavailable and never downgraded. ' +
    'Unavailable policy permits cryptographically verified receipt append with checkpointPolicyError and unanchored signer status, never checkpoint 15+ signing. ' +
    'Verification reports chainSigned separately from signerAnchored; only authenticated host windows pin verified checkpoint signers. ' +
    'Local keys and expectedPublicKey are consistency checks, not independent trust or owner consent. ' +
    'Actions: `append`, `checkpoint`, `verify`, `list`. The only writer of receipts.v3.jsonl. A `mandate.grant` append needs `envelope`: ' +
    'an aukora.x6.owner-grant.v1 grant signed by the owner key in owner-key.v1.json; anything else is refused as MANDATE_SIGNATURE_INVALID.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['append', 'checkpoint', 'verify', 'list'],
        description: 'Receipt or checkpoint action.',
      },
      kind: { type: 'string', description: 'Receipt event kind (for action="append", e.g. "self.edit", "organ.grow").' },
      data: { type: 'object', description: 'Structured receipt payload (for action="append").' },
      envelope: { type: 'object', description: 'For kind="mandate.grant" only: the owner-signed aukora.x6.owner-grant.v1 grant.' },
      note: { type: 'string', description: 'Optional checkpoint note (for action="checkpoint").' },
      expectedPublicKey: { type: 'string', description: 'Optional Ed25519 public key hex required for every checkpoint; a consistency constraint, never independent signer authority.' },
    },
    required: ['action'],
  },
  run(args, ctx) {
    const action = args && args.action
    if (action !== 'append' && action !== 'checkpoint') return runReceiptOp(args, ctx)
    const vfs = getFs(ctx)
    const key = Symbol.for('aukora.receipt.mutation-queues.v1')
    const queues = globalThis[key] || (globalThis[key] = new WeakMap())
    const previous = queues.get(vfs) || Promise.resolve()
    const result = previous.then(() => runReceiptOp(args, ctx))
    queues.set(vfs, result.catch(() => {}))
    return result

  },
}
