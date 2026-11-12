/** Existing-key Ed25519 owner grants. No provisioning, rotation, writes, or browser owner-proof inference. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OWNER_GRANT_DOMAIN, OWNER_GRANT_SCHEMA, OWNER_GRANT_MAX_BODY_BYTES, normalizeOwnerGrantBinding, ownerGrantCanonical, ownerGrantFailure, ownerGrantRequestFailure, requireOwnerGrantApproval } from '../deploy/cloudflare/src/owner-grant-policy.mjs'
export { OWNER_GRANT_DOMAIN, OWNER_GRANT_SCHEMA, REJECTED_OWNER_IDENTITIES, canonicalJson, ownerGrantCanonical } from '../deploy/cloudflare/src/owner-grant-policy.mjs'

/** Canonical existing-key location. Resolving this path does not read or provision a key. */
export const OWNER_KEY_FILE = path.join(os.homedir(), '.aukora-x6-vault', 'owner-ed25519.json')
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const HEX_64 = /^[0-9a-f]{64}$/
const MAX_KEY_BYTES = 4096

/** Current edge Access policy permits at most twenty-four hours and no sub or iat claims. */
export const OWNER_JWT_MAX_HOURS = 24

function invalidKey() { ownerGrantFailure('OWNER_KEY_INVALID', 503) }

function privateDirectory(stat) {
  return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o7777) === 0o700
}

function privateFile(stat) {
  return stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && [0o400, 0o600].includes(stat.mode & 0o7777) && stat.size > 0 && stat.size <= MAX_KEY_BYTES
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

function loadExistingOwnerKey(keyFile) {
  let fd, directoryFd
  try {
    if (!Number.isInteger(fs.constants.O_NOFOLLOW) || !Number.isInteger(fs.constants.O_DIRECTORY)) invalidKey()
    if (fs.realpathSync(keyFile) !== path.resolve(keyFile)) invalidKey()
    const directory = path.dirname(keyFile)
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY)
    const directoryBefore = fs.fstatSync(directoryFd)
    if (!privateDirectory(directoryBefore)) invalidKey()
    fd = fs.openSync(keyFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const before = fs.fstatSync(fd)
    if (!privateFile(before)) invalidKey()
    const bytes = Buffer.alloc(MAX_KEY_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, length)
      if (read === 0) break
      length += read
    }
    const after = fs.fstatSync(fd)
    const atPath = fs.lstatSync(keyFile)
    const directoryAfter = fs.lstatSync(directory)
    if (length > MAX_KEY_BYTES || length !== before.size || !privateFile(after) || !privateFile(atPath) || !sameFile(before, after) || !sameFile(after, atPath) || !privateDirectory(directoryAfter) || directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino || fs.realpathSync(keyFile) !== path.resolve(keyFile)) invalidKey()
    let raw
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) }
    finally { bytes.fill(0) }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.version !== undefined && raw.version !== 1) || typeof raw.seedHex !== 'string' || !HEX_64.test(raw.seedHex) || typeof raw.publicKeyHex !== 'string' || !HEX_64.test(raw.publicKeyHex)) invalidKey()
    const keyId = `owner-ed25519-${raw.publicKeyHex.slice(0, 12)}`
    if (raw.keyId !== undefined && raw.keyId !== keyId) invalidKey()
    const encoded = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(raw.seedHex, 'hex')])
    let privateKey
    try { privateKey = crypto.createPrivateKey({ key: encoded, format: 'der', type: 'pkcs8' }) }
    finally { encoded.fill(0) }
    const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
    const supplied = Buffer.from(raw.publicKeyHex, 'hex')
    if (spki.length !== SPKI_ED25519_PREFIX.length + 32 || !spki.subarray(0, SPKI_ED25519_PREFIX.length).equals(SPKI_ED25519_PREFIX) || !crypto.timingSafeEqual(spki.subarray(SPKI_ED25519_PREFIX.length), supplied)) invalidKey()
    return { publicKeyHex: raw.publicKeyHex, keyId, privateKey }
  } catch (error) {
    // Never disclose the filesystem path, parser contents, seed, or crypto diagnostics.
    ownerGrantFailure(error?.code === 'ENOENT' ? 'OWNER_KEY_NOT_CONFIGURED' : 'OWNER_KEY_INVALID', 503)
  } finally {
    let closeFailed = false
    for (const descriptor of [fd, directoryFd]) {
      if (descriptor === undefined) continue
      try { fs.closeSync(descriptor) }
      catch { closeFailed = true }
    }
    if (closeFailed) invalidKey()
  }
}

/** Construct a trusted-process signer with an explicit key path; tests must supply an isolated fixture. */
export function createOwnerGrantSigner({ keyFile, now = Date.now } = {}) {
  if (typeof keyFile !== 'string' || !path.isAbsolute(keyFile) || typeof now !== 'function') ownerGrantFailure('OWNER_KEY_PATH_REQUIRED', 503)
  return Object.freeze({
    getOwnerPublicKey() {
      const { publicKeyHex, keyId } = loadExistingOwnerKey(keyFile)
      return { ok: true, publicKeyHex, keyId }
    },
    signOwnerGrant(input) {
      const binding = normalizeOwnerGrantBinding(input, { now: now() })
      const { publicKeyHex, keyId, privateKey } = loadExistingOwnerKey(keyFile)
      normalizeOwnerGrantBinding(binding, { now: now() })
      let signatureHex
      try { signatureHex = crypto.sign(null, Buffer.from(OWNER_GRANT_DOMAIN + ownerGrantCanonical(binding), 'utf8'), privateKey).toString('hex') }
      catch { ownerGrantFailure('OWNER_SIGNING_FAILED', 503) }
      return { ok: true, keyId, ownerGrant: { schema: OWNER_GRANT_SCHEMA, ...binding, publicKeyHex, signatureHex } }
    },
  })
}

/**
 * Create an explicit-key, trusted-process login-pass signer. Calling it creates a credential.
 * @param options - Isolated key path and clock; there is no implicit vault lookup or key creation.
 * @returns A signer with the fixed identity and lifetime accepted by the existing edge policy.
 */
export function createOwnerJwtSigner({ keyFile, now = Date.now } = {}) {
  if (typeof keyFile !== 'string' || !path.isAbsolute(keyFile) || typeof now !== 'function') ownerGrantFailure('OWNER_KEY_PATH_REQUIRED', 503)
  return Object.freeze({
    mint({ hours = OWNER_JWT_MAX_HOURS } = {}) {
      if (!Number.isInteger(hours) || hours < 1 || hours > OWNER_JWT_MAX_HOURS) ownerGrantFailure('OWNER_JWT_INVALID_HOURS')
      const at = now()
      if (!Number.isFinite(at) || at < 0 || !Number.isSafeInteger(Math.floor(at / 1000) + hours * 3600)) ownerGrantFailure('OWNER_JWT_INVALID_TIME')
      const claims = { iss: 'aukora.x61.owner', aud: process.env.X6_PUBLIC_HOST || 'node.example.invalid', email: process.env.X6_OWNER_EMAIL || 'owner@example.invalid', nbf: Math.floor(at / 1000), exp: Math.floor(at / 1000) + hours * 3600 }
      const preimage = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url')
      const { privateKey, publicKeyHex } = loadExistingOwnerKey(keyFile)
      const signedAt = now()
      if (!Number.isFinite(signedAt) || signedAt < at || signedAt >= claims.exp * 1000) ownerGrantFailure('OWNER_JWT_INVALID_TIME')
      let signature
      try { signature = crypto.sign(null, Buffer.from(preimage, 'utf8'), privateKey).toString('base64url') }
      catch (error) { ownerGrantFailure('OWNER_SIGNING_FAILED', 503) }
      return { token: preimage + '.' + signature, publicKeyHex }
    },
  })
}

/**
 * Issue grants only after an out-of-band provider approves the exact preimage and current HEAD.
 * @param options - Trusted HEAD reader, signer and optional approval provider. Absent approval refuses signing.
 * @returns An issuer; governance grants bind scope.candidateSha256 and require approval for each exact HEAD.
 * Issuance does not revoke older signatures; promotion consumers must enforce the target and candidate binding.
 */
export function createOwnerGrantIssuer({ readHead, signer, approveOwnerGrant, now = Date.now }) {
  async function currentHead() {
    try { return await readHead() }
    catch (error) { ownerGrantFailure('OWNER_GRANT_HEAD_UNAVAILABLE', 503) }
  }
  function requireCurrentHead(binding, head) {
    if (!head || typeof head.ballId !== 'string' || !HEX_64.test(head.ballId) || !Number.isSafeInteger(head.epoch) || head.epoch < 0) ownerGrantFailure('OWNER_GRANT_HEAD_UNAVAILABLE', 503)
    if (binding.ballId !== head.ballId || binding.epoch !== head.epoch) ownerGrantFailure('OWNER_GRANT_STALE_BINDING', 409)
  }
  return Object.freeze({
    async issue(input) {
      const binding = normalizeOwnerGrantBinding(input, { now: now() })
      if (typeof approveOwnerGrant !== 'function') ownerGrantFailure('OWNER_APPROVAL_REQUIRED', 403)
      requireCurrentHead(binding, await currentHead())
      const canonical = ownerGrantCanonical(binding)
      const preimageHash = crypto.createHash('sha256').update(OWNER_GRANT_DOMAIN + canonical, 'utf8').digest('hex')
      await requireOwnerGrantApproval(binding, async approved => {
        const result = await approveOwnerGrant(Object.freeze({ ...approved, preimageHash }))
        if (!result || Object.getOwnPropertyDescriptor(result, 'preimageHash')?.value !== preimageHash) ownerGrantFailure('OWNER_APPROVAL_REQUIRED', 403)
        return result
      })
      requireCurrentHead(binding, await currentHead())
      normalizeOwnerGrantBinding(binding, { now: now() })
      // The synchronous signer leaves no awaited step between the final HEAD check and signing.
      // External writers can still advance HEAD; consumers must reject stale grant bindings.
      return { ...signer.signOwnerGrant(binding), preimageHash }
    },
  })
}

/**
 * Handle owner routes after the caller's transport authentication, without installing an approval provider.
 * @param options - Trusted signer, HEAD reader, clock and optional separately authenticated approval provider.
 * @returns A Node request handler returning a no-secret JSON result; owner scopes do not bypass consent.
 */
export function createLocalOwnerGrantHandler({ readHead, signer = { getOwnerPublicKey, signOwnerGrant }, approveOwnerGrant, now = Date.now }) {
  const issuer = createOwnerGrantIssuer({ readHead, signer, approveOwnerGrant, now })
  return async function handleOwnerGrant(req, url) {
    try {
      const refusal = ownerGrantRequestFailure({ pathname: url.pathname, search: url.search, method: req.method, origin: req.headers.origin, fetchSite: req.headers['sec-fetch-site'], expectedOrigin: url.origin })
      if (refusal) ownerGrantFailure(refusal.code, refusal.status)
      if (req.method === 'GET') return { status: 200, body: signer.getOwnerPublicKey() }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || req.headers['content-encoding'] !== undefined) ownerGrantFailure('OWNER_GRANT_MALFORMED')
      const declared = req.headers['content-length']
      if (declared !== undefined && (typeof declared !== 'string' || !/^(0|[1-9][0-9]*)$/.test(declared))) ownerGrantFailure('OWNER_GRANT_MALFORMED')
      if (declared !== undefined && Number(declared) > OWNER_GRANT_MAX_BODY_BYTES) ownerGrantFailure('REQUEST_BODY_TOO_LARGE', 413)
      const chunks = []
      let length = 0
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.from(chunk)
        if (bytes.length > OWNER_GRANT_MAX_BODY_BYTES - length) ownerGrantFailure('REQUEST_BODY_TOO_LARGE', 413)
        length += bytes.length
        chunks.push(bytes)
      }
      if (declared !== undefined && Number(declared) !== length) ownerGrantFailure('OWNER_GRANT_MALFORMED')
      let input
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))) }
      catch (error) { ownerGrantFailure('OWNER_GRANT_MALFORMED') }
      return { status: 200, body: await issuer.issue(input) }
    } catch (error) {
      const code = /^(OWNER_|SAME_ORIGIN_BROWSER_REQUIRED$|METHOD_UNAVAILABLE$|REQUEST_BODY_TOO_LARGE$)/.test(error?.code ?? '') ? error.code : 'OWNER_GRANT_FAILED'
      return { status: error?.status ?? 503, body: { ok: false, code } }
    }
  }
}

/** Read existing metadata without creating a key or retaining a cached private record. */
export function getOwnerPublicKey() {
  return createOwnerGrantSigner({ keyFile: OWNER_KEY_FILE }).getOwnerPublicKey()
}

/** Trusted-process primitive; HTTP callers must use the approval-gated owner request handler. */
export function signOwnerGrant(input) {
  return createOwnerGrantSigner({ keyFile: OWNER_KEY_FILE }).signOwnerGrant(input)
}
