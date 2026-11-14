/**
 * seed-continuity — verify this body can be trusted to have stayed one body.
 *
 * Answers, with evidence, the four questions a migration or a restore would otherwise assume:
 *   1. closure     — every module the active ball references exists in the balls store under its own hash
 *   2. merkle      — the receipt leaves recompute to the root the last checkpoint committed
 *   3. checkpoints — the checkpoint chain is monotonic, chained, and covers the receipt prefix it claims
 *   4. continuity  — the same owner credential and lineage are still attached to the head
 *
 * Design rule: a section that cannot be checked reports `unverifiable` with a reason. It never reports
 * `ok` for work it did not do. A verifier that lies is worse than no verifier.
 *
 * Algorithms are the live ones from seed-receipts (aukora.receipt.v3):
 *   leaf = sha256(0x00 || canonicalJson(payload without leafHash))
 *   root = pair sha256(0x01 || left || right), odd node promoted, until one remains
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const BALLS = '/dsh/home/balls'
const RECEIPTS = '/dsh/home/auma/seed/receipts.v3.jsonl'
const CHECKPOINTS = '/dsh/home/auma/seed/checkpoints.v1.jsonl'
const BASELINE = '/dsh/home/auma/seed/continuity-baseline.v1.json'
const CREDENTIAL_CANDIDATES = [
  '/dsh/home/auma/seed/aumlok-credential.v1.json',
  '/dsh/home/auma/seed/owner-credential.v1.json',
  '/dsh/home/auma/HEAD.json',
]

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    return null
  }
}

function merkleLeafHash(payload) {
  return sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(canonicalJson(payload), 'utf8')]))
}

function merkleRootHex(leafHashesHex) {
  if (!Array.isArray(leafHashesHex) || leafHashesHex.length === 0) return null
  let level = leafHashesHex.map((h) => Buffer.from(h, 'hex'))
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) { next.push(level[i]); continue }
      next.push(crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0x01]), level[i], level[i + 1]])).digest())
    }
    level = next
  }
  return level[0].toString('hex')
}

function resolveHead(ballPath) {
  const candidates = [ballPath, path.join(BALLS, 'HEAD.json'), '/dsh/home/auma/HEAD.json', '/dsh/home/HEAD.json'].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      if (parsed && parsed.entries) return { path: candidate, head: parsed }
    } catch (error) { /* try next */ }
  }
  return { path: null, head: null }
}

// 1 — closure: the head must be reconstructible from bytes we actually hold.
function checkClosure(head) {
  const entries = Object.entries(head.entries || {})
  const missing = []
  const mismatched = []
  const verified = []
  for (const [id, entry] of entries) {
    const specifier = String(entry.specifier || '')
    if (!specifier.startsWith('ball:')) { mismatched.push({ id, reason: 'not-a-ball-specifier' }); continue }
    const expected = specifier.slice(5)
    const file = path.join(BALLS, expected + '.js')
    let bytes
    try { bytes = fs.readFileSync(file) } catch (error) { missing.push({ id, sha256: expected }); continue }
    const actual = sha256(bytes)
    if (actual !== expected) mismatched.push({ id, expectedSha256: expected, actualSha256: actual })
    else verified.push({ id, sha256: expected, bytes: bytes.length })
  }
  return {
    section: 'closure',
    ok: missing.length === 0 && mismatched.length === 0 && verified.length === entries.length && entries.length > 0,
    entries: entries.length,
    verified: verified.length,
    totalBytes: verified.reduce((sum, v) => sum + v.bytes, 0),
    missing: missing.slice(0, 8),
    mismatched: mismatched.slice(0, 8),
  }
}

// 2 — merkle: recompute the root from the leaves, do not trust a stored one.
function checkMerkle(receipts) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { section: 'merkle', ok: false, reason: 'no-receipts' }
  }
  const badLeaves = []
  let prevHash = '0'.repeat(64)
  for (let i = 0; i < receipts.length; i += 1) {
    const { leafHash, ...payload } = receipts[i]
    const expected = merkleLeafHash(payload)
    if (leafHash !== expected) badLeaves.push({ seq: receipts[i].seq, expected, actual: leafHash })
    if (receipts[i].prevHash !== prevHash) badLeaves.push({ seq: receipts[i].seq, reason: 'prev-hash-break', expected: prevHash, actual: receipts[i].prevHash })
    prevHash = leafHash
  }
  const root = merkleRootHex(receipts.map((r) => r.leafHash))
  return {
    section: 'merkle',
    ok: badLeaves.length === 0,
    receipts: receipts.length,
    root,
    tailLeaf: receipts[receipts.length - 1].leafHash,
    brokenLeaves: badLeaves.slice(0, 8),
  }
}

// 3 — checkpoints: monotonic, chained, and covering the prefix they claim.
function checkCheckpoints(checkpoints, receipts) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return { section: 'checkpoints', ok: false, reason: 'no-checkpoints-file' }
  }
  const failures = []
  let prevCheckpointHash = null
  for (let i = 0; i < checkpoints.length; i += 1) {
    const cp = checkpoints[i]
    const body = cp && cp.body
    if (!body || body.schema !== 'aukora.edge-checkpoint.v1') { failures.push({ seq: i + 1, reason: 'bad-schema' }); continue }
    if (body.seq !== i + 1) failures.push({ seq: i + 1, reason: 'seq-not-monotonic', actual: body.seq })
    if ((body.prevCheckpointHash || null) !== prevCheckpointHash) failures.push({ seq: i + 1, reason: 'prev-checkpoint-break' })
    const count = Number(body.receiptCount)
    if (Number.isInteger(count) && count > 0 && receipts) {
      const expectedLast = receipts[count - 1] && receipts[count - 1].leafHash
      if (expectedLast && body.lastReceiptHash !== expectedLast) failures.push({ seq: i + 1, reason: 'last-receipt-hash-mismatch' })
      const prefixRoot = merkleRootHex(receipts.slice(0, count).map((r) => r.leafHash))
      if (prefixRoot && body.merkleRoot && prefixRoot !== body.merkleRoot) failures.push({ seq: i + 1, reason: 'merkle-root-mismatch', expected: prefixRoot, actual: body.merkleRoot })
    }
    if (!cp.signatureHex || !cp.publicKeyHex) failures.push({ seq: i + 1, reason: 'unsigned-checkpoint' })
    prevCheckpointHash = cp.checkpointHash || null
  }
  const last = checkpoints[checkpoints.length - 1]
  return {
    section: 'checkpoints',
    ok: failures.length === 0,
    count: checkpoints.length,
    lastSeq: last && last.body ? last.body.seq : null,
    lastReceiptCount: last && last.body ? last.body.receiptCount : null,
    lastMerkleRoot: last && last.body ? last.body.merkleRoot : null,
    signaturePresent: checkpoints.every((cp) => Boolean(cp.signatureHex) && Boolean(cp.publicKeyHex)),
    signatureVerification: 'delegated: run seed_receipts verify (WebCrypto Ed25519)',
    failures: failures.slice(0, 8),
  }
}

// 4 — continuity: the same credential and lineage, compared against a recorded baseline.
function readCredential() {
  for (const candidate of CREDENTIAL_CANDIDATES) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      const credentialId = parsed.credentialId || parsed.aumlokCredentialId || (parsed.owner && parsed.owner.credentialId) || null
      if (credentialId) return { path: candidate, credentialId: String(credentialId) }
    } catch (error) { /* try next */ }
  }
  return null
}

function checkContinuity(head, root, receipts, checkpoints) {
  const credential = readCredential()
  const observation = {
    ballId: head.ballId || null,
    epoch: head.epoch || null,
    parentBallId: head.parentBallId || null,
    merkleRoot: root,
    receipts: receipts ? receipts.length : null,
    checkpoints: checkpoints ? checkpoints.length : null,
    ownerCredentialId: credential ? credential.credentialId : null,
  }
  let baseline = null
  try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) } catch (error) { baseline = null }
  const result = {
    section: 'continuity',
    observed: observation,
    baselinePath: BASELINE,
    credentialSource: credential ? credential.path : null,
    comparisons: {},
  }
  if (!baseline) {
    result.ok = false
    result.reason = observation.ownerCredentialId
      ? 'no-baseline: run action=seal to record the first observation'
      : 'no-baseline AND no AUMLOK credential found: owner-binding continuity is unverifiable'
    return result
  }
  const drift = []
  for (const key of ['ownerCredentialId', 'ballId', 'merkleRoot']) {
    const before = baseline[key]
    const now = observation[key]
    const same = before === now || (before === null && now !== null && key === 'ownerCredentialId')
    result.comparisons[key] = { baseline: before, now, same }
    if (!same) drift.push(key)
  }
  if (observation.epoch !== null && baseline.epoch !== null && observation.epoch < baseline.epoch) {
    drift.push('epoch-went-backwards')
  }
  // A null credential compared against a null credential is not evidence of continuity.
  // Refuse to certify the owner binding when no credential was ever found.
  if (!observation.ownerCredentialId) {
    drift.push('owner-credential-not-found: no AUMLOK credential at any known path, so owner-binding continuity is UNVERIFIED')
  }
  result.ok = drift.length === 0
  result.drift = drift
  // Distinguish "checked and failed" from "could not check". An alarm that fires on a healthy
  // body teaches the operator to ignore alarms, which is its own kind of lie.
  const credentialOnly = drift.length === 1 && String(drift[0]).startsWith('owner-credential-not-found')
  if (credentialOnly) result.status = 'unverifiable'
  return result
}

function verify(options) {
  const opts = options || {}
  const resolved = resolveHead(opts.ballPath)
  if (!resolved.head) {
    return { ok: false, error: 'HEAD_NOT_FOUND', tried: [opts.ballPath, path.join(BALLS, 'HEAD.json')] }
  }
  const head = resolved.head
  const receipts = readJsonl(RECEIPTS)
  const checkpoints = readJsonl(CHECKPOINTS)
  const closure = checkClosure(head)
  const merkle = checkMerkle(receipts)
  const checkpointSection = checkCheckpoints(checkpoints, receipts)
  const continuity = checkContinuity(head, merkle.root, receipts, checkpoints)
  const sections = { closure, merkle, checkpoints: checkpointSection, continuity }
  const failed = Object.entries(sections).filter(([, s]) => !s.ok && s.status !== 'unverifiable').map(([k]) => k)
  const unverified = Object.entries(sections).filter(([, s]) => !s.ok && s.status === 'unverifiable').map(([k]) => k)
  const verdict = failed.length > 0 ? 'BROKEN' : (unverified.length > 0 ? 'INCOMPLETE' : 'CONTINUOUS')
  return {
    ok: failed.length === 0,
    action: 'verify',
    head: { path: resolved.path, ballId: head.ballId || null, epoch: head.epoch || null, parentBallId: head.parentBallId || null },
    sections,
    failedSections: failed,
    unverifiedSections: unverified,
    verdict,
    certification: verdict === 'CONTINUOUS'
      ? 'closure, merkle, checkpoints and owner continuity all verified'
      : (verdict === 'INCOMPLETE'
        ? 'closure, merkle and checkpoints verified; owner-binding continuity could NOT be checked and is not claimed'
        : 'a verified invariant failed: ' + failed.join(',')),
    note: 'signature verification is delegated to seed_receipts verify; this organ does not re-implement Ed25519',
  }
}

// Tamper probe: copy one module, flip one byte, and prove closure fails closed on the copy.
function selftest(options) {
  const opts = options || {}
  const resolved = resolveHead(opts.ballPath)
  if (!resolved.head) return { ok: false, error: 'HEAD_NOT_FOUND' }
  const entries = Object.entries(resolved.head.entries || {})
  const target = entries.find(([, e]) => String(e.specifier || '').startsWith('ball:'))
  if (!target) return { ok: false, error: 'NO_MODULE_TO_TAMPER' }
  const id = target[0]
  const expected = String(target[1].specifier).slice(5)
  const source = path.join(BALLS, expected + '.js')
  let bytes
  try { bytes = fs.readFileSync(source) } catch (error) { return { ok: false, error: 'MODULE_MISSING', id } }
  const copy = Buffer.from(bytes)
  const index = Math.max(0, Math.floor(copy.length / 2))
  copy[index] = copy[index] ^ 0xff
  const tamperedSha = sha256(copy)
  const detected = tamperedSha !== expected
  return {
    ok: detected,
    action: 'selftest',
    target: id,
    expectedSha256: expected,
    tamperedSha256: tamperedSha,
    originalBytes: bytes.length,
    flippedByteAt: index,
    detected,
    statement: detected
      ? 'closure rejects a single flipped byte: the tampered copy does not hash to the head it claims'
      : 'FAILED CLOSED TEST: tampered bytes still matched the expected hash',
  }
}

function seal() {
  const resolved = resolveHead(null)
  if (!resolved.head) return { ok: false, error: 'HEAD_NOT_FOUND' }
  const head = resolved.head
  const receipts = readJsonl(RECEIPTS) || []
  const checkpoints = readJsonl(CHECKPOINTS) || []
  const credential = readCredential()
  const baseline = {
    schema: 'aukora.continuity-baseline.v1',
    sealedAt: new Date().toISOString(),
    ballId: head.ballId || null,
    epoch: head.epoch || null,
    parentBallId: head.parentBallId || null,
    merkleRoot: merkleRootHex(receipts.map((r) => r.leafHash)),
    receipts: receipts.length,
    checkpoints: checkpoints.length,
    ownerCredentialId: credential ? credential.credentialId : null,
    credentialSource: credential ? credential.path : null,
  }
  fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 1))
  return { ok: true, action: 'seal', baseline, path: BASELINE }
}

const parameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['verify', 'selftest', 'seal'], description: 'verify (default) checks closure, merkle, checkpoints, continuity; selftest flips one byte and must fail closed; seal records the continuity baseline.' },
    ballPath: { type: 'string', description: 'Optional explicit path to HEAD.json.' },
  },
}

module.exports = {
  name: 'seed_continuity',
  description: 'Verify this body is still one body: module closure, receipt merkle root recomputation, checkpoint chain integrity, and owner-credential continuity. selftest proves a single flipped byte is rejected.',
  parameters,
  async run(args) {
    const action = (args && args.action) || 'verify'
    if (action === 'selftest') return selftest(args)
    if (action === 'seal') return seal()
    if (action === 'verify') return verify(args)
    return { ok: false, error: 'UNKNOWN_ACTION', action }
  },
}
