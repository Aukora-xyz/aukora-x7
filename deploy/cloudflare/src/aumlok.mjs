/** AUMLOK public-proof ceremonies and private, peppered root-key escrow.
 * Construction performs no I/O or key use. Host activation requires an independently
 * verified owner session AND registration, a UV assertion and node possession.
 * Registration derives its COSE key with SimpleWebAuthn, then requires a separate signed
 * assertion and node-key possession proof. Commitments alone never authenticate anyone.
 * A copied client ciphertext can permit offline phrase guessing; this server wrapper
 * protects escrow at rest, not compromised browsers or infrastructure holding its pepper.
 */
import { verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server'
import { cose, decodeAttestationObject, decodeClientDataJSON, decodeCredentialPublicKey, isoBase64URL, parseAuthenticatorData } from '@simplewebauthn/server/helpers'
import { canonicalJson } from './owner-grant-policy.mjs'
import { clearFailures, countFailure, proofFailureBudget, proofIs, proofOf, proofOutcome, settleProof, withProof } from './proof-failure-rule.mjs'
import { SCREEN_POLICY, keyAlgorithm, screenAssertion, screenRegistration, signatureShape } from './webauthn-screen.mjs'
import { PASSKEY_DEVICES_PENDING_KEY, PASSKEY_DEVICE_LIMITS, PASSKEY_DEVICE_ADD_ACTION, PASSKEY_DEVICE_REMOVE_ACTION, PASSKEY_DEVICE_RECORD_SCHEMA,
  PASSKEY_DEVICE_CONFIRM_ACTION, PASSKEY_DEVICE_DECLINE_ACTION, PASSKEY_DEVICE_ROUTES, PASSKEY_DEVICE_ACTIONS, deviceLink, deviceCodeShape, deviceCodeHashes,
  deviceInstanceValid, deviceKeyPhrase, deviceLabelValid, deviceUserHandleValid, deviceRegistrationOptions, newDeviceCode, readDevicePending,
  registrationTransports, storedTransportsValid } from './passkey-devices.mjs'

export const AUMLOK_STORAGE_KEY = 'aumlok:v1'
export const AUMLOK_LIMITS = Object.freeze({ requestBytes: 32768, stateBytes: 98304, challenges: 4, challengeMs: 120000, inviteRecords: 32, monthlyInvites: 3,
  failuresPerHour: 5, hardLockFailures: 10, backoffMs: 1000, attemptRecords: 256, approvalRecords: 8, approvalMs: 300000 })
/**
 * OWNER SIGN-IN WITH THE BOUND PASSKEY (no Mac step). Its own storage key, apart from aumlok:v1's counters and its four
 * shared challenge slots: a stranger can neither fill a slot nor move a lockout counter through it.
 */
export const AUMLOK_SIGNIN_STORAGE_KEY = 'aumlok:signin:v1'
export const AUMLOK_SIGNIN_LIMITS = Object.freeze({ challengeMs: 120000, sessionMs: 8 * 3600000, sessions: 8, usedChallenges: 64 })
export const AUMLOK_SIGNIN_CHALLENGE_DOMAIN = 'aukora.aumlok.signin-challenge.v1'
export const AUMLOK_SIGNIN_ISSUANCE_DOMAIN = 'aukora.aumlok.signin-issuance.v1'
/** A challenge id's longest form: its canonical payload (credential id up to 2048, origin and RP id up to 253 each, a
 * 43-character nonce, numbers and keys) in base64url, a dot and a 64-hex MAC. */
export const AUMLOK_SIGNIN_CHALLENGE_MAX = Math.ceil((2048 + 253 + 253 + 43 + 512) * 4 / 3) + 1 + 64

/**
 * THE SIGN-IN CEREMONY PAYLOAD, one canonical text: schema, nonce, origin, RP id, identity generation, credential id,
 * issuedAt and expiresAt (exactly issuedAt + two minutes). The passkey signs a DIGEST OF ALL OF IT, not the nonce, so a
 * payload re-issued with a new expiry (by anyone holding the issuance key) is a different challenge and no assertion
 * made for the old one can ever be replayed against it. Shared by HEAD and the Worker.
 */
export function signinPayloadText({ nonce, origin, generation, credentialId, issuedAt }) {
  return canonicalJson({ schema: AUMLOK_SIGNIN_CHALLENGE_DOMAIN, nonce, origin, rpId: new URL(origin).hostname, generation, credentialId,
    issuedAt, expiresAt: issuedAt + AUMLOK_SIGNIN_LIMITS.challengeMs })
}
/** The WebAuthn challenge the authenticator signs: base64url SHA-256 of the domain and the whole payload text. */
export async function signinChallengeDigest(payloadText) {
  return isoBase64URL.fromBuffer(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(AUMLOK_SIGNIN_CHALLENGE_DOMAIN + '\0' + payloadText))))
}
/**
 * Read a payload strictly: exactly its eight fields, this origin, RP id, generation and credential, a two-minute life
 * that has begun (small clock skew allowed) and not ended. Returns the payload or the refusal code.
 */
export function signinPayloadCheck(text, { origin, generation, credentialId, now, skewMs = 5000 }) {
  let payload
  try { payload = JSON.parse(text) } catch (_error) { return { code: 'AUMLOK_SIGNIN_CHALLENGE_INVALID', status: 403 } }
  if (!exact(payload, ['schema', 'nonce', 'origin', 'rpId', 'generation', 'credentialId', 'issuedAt', 'expiresAt'])
    || payload.schema !== AUMLOK_SIGNIN_CHALLENGE_DOMAIN || !b64(payload.nonce, 43) || isoBase64URL.toBuffer(payload.nonce).length !== 32
    || payload.origin !== origin || payload.rpId !== new URL(origin).hostname || payload.generation !== generation || payload.credentialId !== credentialId
    || !timestamp(payload.issuedAt) || payload.expiresAt !== payload.issuedAt + AUMLOK_SIGNIN_LIMITS.challengeMs
    || canonicalJson(payload) !== text) return { code: 'AUMLOK_SIGNIN_CHALLENGE_INVALID', status: 403 }
  if (payload.issuedAt > now + skewMs || payload.expiresAt <= now) return { code: 'AUMLOK_SIGNIN_CHALLENGE_EXPIRED', status: 409 }
  return { payload }
}

/**
 * THE SESSION TOKEN IS AN ENVELOPE HEAD SIGNS: `<32 random bytes b64url>.<expiresAt>.<generation>.<HMAC hex>`, the MAC
 * under a per-generation session key HEAD derives from the pepper. The Worker authenticates it locally, so a fabricated
 * cookie costs no durable call; HEAD's own lookup of the stored hash stays the authority (revocation, sign-out).
 */
export const AUMLOK_SESSION_DOMAIN = 'aukora.aumlok.session-envelope.v1'
const SESSION_TOKEN = /^([A-Za-z0-9_-]{43})\.([1-9][0-9]{12,15})\.([1-9][0-9]{0,15})\.([0-9a-f]{64})$/
/** A session token's parts, or null when it is not an envelope at all. */
export function sessionTokenParts(token) {
  const match = typeof token === 'string' ? SESSION_TOKEN.exec(token) : null
  if (!match) return null
  const expiresAt = Number(match[2]), generation = Number(match[3])
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(generation)) return null
  return { expiresAt, generation, mac: match[4], body: AUMLOK_SESSION_DOMAIN + '\0' + match[1] + '.' + match[2] + '.' + match[3] }
}
/**
 * Verify an envelope's MAC under the session key (hex), with WebCrypto's fixed-size comparison. Strictly a boolean: true
 * only for the verifier's `true` (proof-failure-rule.mjs); a verifier that throws or answers anything but a boolean is
 * unavailable (throws 503 AUMLOK_UNAVAILABLE), never "authentic" and never "signed out". No budget is on this check.
 */
export async function sessionTokenAuthentic(sessionKeyHex, parts) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(sessionKeyHex.match(/../g), byte => parseInt(byte, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const outcome = await proofOutcome(() => crypto.subtle.verify('HMAC', key, Uint8Array.from(parts.mac.match(/../g), byte => parseInt(byte, 16)), encoder.encode(parts.body)),
    { code: 'AUMLOK_SESSION_INVALID' })
  if (proofIs(outcome, 'unavailable')) settleProof(outcome)
  return proofIs(outcome, 'ok')
}

/** HMAC-SHA256 of the challenge payload under the per-generation issuance key (hex). Shared by HEAD and the Worker. */
export async function signinChallengeMac(issuanceKeyHex, payloadText) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(issuanceKeyHex.match(/../g), byte => parseInt(byte, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payloadText)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
export const AUMLOK_INVITE_SCHEMA = 'aukora.invite.v1'
export const AUMLOK_INVITE_DOMAIN = 'aukora.invite.v1\n'
export const AUMLOK_NODE_DOMAIN = 'aukora.aumlok.node-possession.v1\n'
const INVITEE_COMMITMENT_DOMAIN = 'aukora.invite.invitee.v1\0'
const REVOCATION_SCHEMA = 'aukora.invite-revocation.v1'
const STATE_SCHEMA = 'aukora.aumlok.state.v2'
const STATUS_SCHEMA = 'aukora.aumlok.status.v1'
const SEPARATED_PEPPER_SCHEMA = 'aukora.aumlok.pepper.v2'
const EMPTY_AUDIT_HASH = '0'.repeat(64)
const encoder = new TextEncoder()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fields = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key))
const exact = (value, keys) => fields(value, keys) && Object.keys(value).length === keys.length
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 && !Object.is(value, -0)
const failure = (code, status = 400, extra = {}) => Object.assign(new Error(code), extra, { code, status })
const refuse = (code, status = 400, extra) => { throw failure(code, status, extra) }
/**
 * CAPACITY IS NOT A CREDENTIAL FAILURE. A ceremony slot or approval record that is busy refuses with the seconds until
 * one frees (`retryAfterSeconds`, also sent as Retry-After); it never moves the WebAuthn failure budget, because no proof
 * was judged wrong.
 */
const CAPACITY_CODES = Object.freeze(['AUMLOK_CHALLENGE_CAPACITY', 'AUMLOK_APPROVAL_CAPACITY'])
const retryAfterSeconds = (until, at) => Math.max(1, Math.ceil((until - at) / 1000))
const capacityRetry = error => CAPACITY_CODES.includes(error?.code) && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 1
  ? { retryAfterSeconds: error.retryAfterSeconds } : {}
const resultError = error => {
  const bodyErrors = { REQUEST_BODY_TOO_LARGE: 'AUMLOK_BODY_TOO_LARGE', REQUEST_BODY_TIMEOUT: 'AUMLOK_BODY_TIMEOUT', REQUEST_ABORTED: 'AUMLOK_BODY_ABORTED',
    INVALID_CONTENT_LENGTH: 'AUMLOK_BODY_INVALID', CONTENT_LENGTH_MISMATCH: 'AUMLOK_BODY_INVALID', INVALID_JSON: 'AUMLOK_JSON_INVALID', INVALID_UTF8: 'AUMLOK_JSON_INVALID', REQUEST_ENCODING_UNSUPPORTED: 'AUMLOK_ENCODING_UNSUPPORTED' }
  return { ok: false, code: /^AUMLOK_|^CLASS3_|^CLASS4_RAW_SECRET_FORBIDDEN$|^NODE_KEY_IS_NOT_OWNER_KEY$|^ENROLLMENT_ALREADY_BOUND$/.test(error?.code ?? '') ? error.code : bodyErrors[error?.code] ?? 'AUMLOK_UNAVAILABLE',
    status: [400, 403, 404, 405, 408, 409, 413, 429, 503, 507].includes(error?.status) ? error.status : 503, ...capacityRetry(error) }
}
const bytes = value => encoder.encode(value).byteLength
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
const random = () => isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)))
const monthAt = at => new Date(at).toISOString().slice(0, 7)
const b64 = (value, max = 8192) => {
  if (typeof value !== 'string' || !value.length || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) return false
  try { return isoBase64URL.fromBuffer(isoBase64URL.toBuffer(value)) === value } catch (_error) { return false }
}
const originValid = value => {
  if (typeof value !== 'string' || value.length > 253) return false
  try {
    const url = new URL(value)
    return url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  } catch (_error) { return false }
}
const domainValid = value => value === null || (originValid(value) && value.startsWith('https://') && new URL(value).port === '')
const rootFields = ['sealedRootKeyB64', 'kdfSaltB64', 'kdfIterations', 'ivB64']
const rootValid = value => exact(value, rootFields) && b64(value.sealedRootKeyB64, 64)
  && isoBase64URL.toBuffer(value.sealedRootKeyB64).length === 48
  && b64(value.kdfSaltB64, 43) && isoBase64URL.toBuffer(value.kdfSaltB64).length === 32
  && Number.isSafeInteger(value.kdfIterations) && value.kdfIterations >= 600000 && value.kdfIterations <= 2000000
  && b64(value.ivB64, 16) && isoBase64URL.toBuffer(value.ivB64).length === 12
const rootFrom = value => Object.fromEntries(rootFields.map(key => [key, value[key]]))
const escrowValid = value => (value?.schema === 'aukora.aumlok.escrow.v2' ? exact(value, ['schema', 'ivB64', 'ciphertextB64'])
  : ['aukora.aumlok.escrow.v3', 'aukora.aumlok.escrow.v4'].includes(value?.schema) && exact(value, ['schema', 'ivB64', 'ciphertextB64', 'kdfSaltB64'])
    && b64(value.kdfSaltB64, 43) && isoBase64URL.toBuffer(value.kdfSaltB64).length === 32)
  && b64(value.ivB64, 16) && isoBase64URL.toBuffer(value.ivB64).length === 12 && b64(value.ciphertextB64, 1024)
const actionValid = value => (exact(value, ['schema', 'audience', 'method', 'pathname', 'bodySha256'])
  && value.schema === 'aukora.class3.action.v1' && originValid(value.audience)
  && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method) && typeof value.pathname === 'string'
  && /^\/[A-Za-z0-9/_-]{1,180}$/.test(value.pathname) && sha(value.bodySha256))
  || (exact(value, ['schema', 'audience', 'action', 'ballId', 'epoch', 'organId', 'candidateSha256'])
    && value.schema === 'aukora.class3.head-promotion.v1' && originValid(value.audience) && value.action === 'head.promote'
    && sha(value.ballId) && Number.isSafeInteger(value.epoch) && value.epoch >= 0 && !Object.is(value.epoch, -0)
    && typeof value.organId === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(value.organId) && sha(value.candidateSha256))
const sameAction = (a, b) => actionValid(a) && actionValid(b) && canonicalJson(a) === canonicalJson(b)

/** Hash the complete parsed mutation body. Approval travels in a separate header.
 * @param {object} input Exact origin, uppercase method, pathname and parsed JSON body.
 * @returns {Promise<object>} Public binding verified again by the effect-owning host.
 */
export async function aumlokClass3Binding({ audience, method, pathname, body }) {
  const binding = { schema: 'aukora.class3.action.v1', audience, method, pathname, bodySha256: await hash(canonicalJson(body)) }
  if (!actionValid(binding)) refuse('CLASS3_ACTION_INVALID')
  return Object.freeze(binding)
}

async function pepperMaterial(state, pepperSecret) {
  const pepper = isoBase64URL.toBuffer(state['pepper.v1'])
  if (state.pepperProtection?.schema !== SEPARATED_PEPPER_SCHEMA) return pepper
  if (pepperSecret === undefined) refuse('AUMLOK_PEPPER_SECRET_REQUIRED', 503)
  const key = await crypto.subtle.importKey('raw', isoBase64URL.toBuffer(pepperSecret), 'HKDF', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: pepper,
    info: encoder.encode('aukora.aumlok.separated-pepper.v1') }, key, 256)
}
async function pepperMac(state, domain, value, pepperSecret) {
  const key = await crypto.subtle.importKey('raw', await pepperMaterial(state, pepperSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(domain + '\0' + value))
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
/** The pepper MAC's check as a branded outcome (proof-failure-rule.mjs); a WRONG one is refused with `code`. */
async function pepperMacOutcome(state, domain, value, signature, pepperSecret, code) {
  const key = await crypto.subtle.importKey('raw', await pepperMaterial(state, pepperSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  // WebCrypto verifies the fixed-size MAC without a JavaScript string comparison.
  return proofOutcome(() => crypto.subtle.verify('HMAC', key, Uint8Array.from(signature.match(/../g), byte => parseInt(byte, 16)), encoder.encode(domain + '\0' + value)), { code })
}
async function escrowKey(state, escrow, pepperSecret) {
  if (['aukora.aumlok.escrow.v3', 'aukora.aumlok.escrow.v4'].includes(escrow.schema)) {
    const key = await crypto.subtle.importKey('raw', await pepperMaterial(state, pepperSecret), 'HKDF', false, ['deriveKey'])
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: isoBase64URL.toBuffer(escrow.kdfSaltB64),
      info: encoder.encode(escrow.schema === 'aukora.aumlok.escrow.v4' ? 'aukora.aumlok.escrow-wrap.v3' : 'aukora.aumlok.escrow-wrap.v2') }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  }
  // Existing v2 ciphertext stays readable; it is never silently rewrapped on status.
  const derived = await pepperMac(state, 'aukora.aumlok.escrow-key.v2', '')
  return crypto.subtle.importKey('raw', Uint8Array.from(derived.match(/../g), value => parseInt(value, 16)), 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function sealRoot(state, root, nodePubkeyHex, recoveryCommitment, pepperSecret) {
  if (!rootValid(root)) refuse('AUMLOK_SEALED_ROOT_REQUIRED')
  const escrow = { schema: state.pepperProtection ? 'aukora.aumlok.escrow.v4' : 'aukora.aumlok.escrow.v3', kdfSaltB64: root.kdfSaltB64 }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: encoder.encode(escrow.schema + '\0' + nodePubkeyHex + '\0' + recoveryCommitment) }, await escrowKey(state, escrow, pepperSecret), encoder.encode(canonicalJson(root)))
  return { ...escrow, ivB64: isoBase64URL.fromBuffer(iv), ciphertextB64: isoBase64URL.fromBuffer(new Uint8Array(ciphertext)) }
}
async function openRoot(state, binding, pepperSecret) {
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: isoBase64URL.toBuffer(binding.rootEscrow.ivB64),
      additionalData: encoder.encode(binding.rootEscrow.schema + '\0' + binding.nodePubkeyHex + '\0' + binding.recoveryCommitment) },
    await escrowKey(state, binding.rootEscrow, pepperSecret), isoBase64URL.toBuffer(binding.rootEscrow.ciphertextB64))
    const root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    if (!rootValid(root)) refuse('AUMLOK_ESCROW_CORRUPT', 503)
    return root
  } catch (_error) { refuse('AUMLOK_ESCROW_CORRUPT', 503) }
}

/** Reject raw secret fields recursively before any persistence, including rejected proofs.
 * @param {unknown} input Parsed untrusted JSON.
 * @returns {void} Throws a content-free error for raw secrets or excessive structure.
 */
export function rejectAumlokRawSecrets(input) {
  const pending = [[input, 0]]
  let count = 0
  while (pending.length) {
    const [value, depth] = pending.pop()
    if (++count > 2048 || depth > 16) refuse('AUMLOK_STRUCTURE_LIMIT')
    if (value === null || typeof value !== 'object') continue
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
      if (/(?:phrase|words|mnemonic|biometric|fingerprint|faceprint|privatekey|secretkey|recoveryseed|seedphrase|password|passphrase)/.test(normalized)) refuse('CLASS4_RAW_SECRET_FORBIDDEN')
      pending.push([child, depth + 1])
    }
  }
}

function validateCredential(value, registration) {
  if (!fields(value, ['id', 'rawId', 'type', 'response', 'clientExtensionResults', 'authenticatorAttachment'])
    || !b64(value.id, 2048) || value.rawId !== value.id || value.type !== 'public-key'
    || !exact(value.clientExtensionResults, [])
    || (value.authenticatorAttachment !== undefined && !['platform', 'cross-platform'].includes(value.authenticatorAttachment))) refuse('AUMLOK_PROOF_INVALID')
  const response = value.response
  const keys = registration ? ['clientDataJSON', 'attestationObject', 'transports'] : ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle']
  if (!fields(response, keys) || !b64(response.clientDataJSON, 8192)) refuse('AUMLOK_PROOF_INVALID')
  if (registration) {
    if (!b64(response.attestationObject, 16384) || (response.transports !== undefined && (!Array.isArray(response.transports) || response.transports.length > 8 || response.transports.some(value => !['usb', 'nfc', 'ble', 'internal', 'hybrid'].includes(value))))) refuse('AUMLOK_PROOF_INVALID')
  } else if (!b64(response.authenticatorData, 2048) || !b64(response.signature, 2048) || (response.userHandle !== undefined && response.userHandle !== null && !b64(response.userHandle, 256))) refuse('AUMLOK_PROOF_INVALID')
  let data
  try { data = decodeClientDataJSON(response.clientDataJSON) } catch (_error) { refuse('AUMLOK_PROOF_INVALID') }
  // Registration verification does not itself reject cross-origin embedding in every library version.
  if (!object(data) || (data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) refuse('AUMLOK_CROSS_ORIGIN_PROOF')
  // Job 7 review: client data whose type, challenge or origin is not a string, or whose token binding is not one, is a
  // MALFORMED request (400, never counted); only well-formed client data goes on to be judged (a wrong value: 403).
  if (typeof data.type !== 'string' || typeof data.challenge !== 'string' || typeof data.origin !== 'string'
    || (data.tokenBinding !== undefined && (!object(data.tokenBinding) || !['present', 'supported', registration ? 'not-supported' : 'notSupported'].includes(data.tokenBinding.status)))) refuse('AUMLOK_PROOF_INVALID')
  // THE BYTES MUST PARSE (job 6 review): authenticator data shorter than 37 bytes or with bytes left over, and an
  // attestation object that does not decode to fmt, attStmt and parsable authData naming a credential and its key, are a
  // MALFORMED request (400, never counted by proof-failure-rule.mjs), refused before any verifier is asked to judge them.
  // THE ORDER (the WebAuthn data model): bytes that do not decode as an attestation object at all (a CBOR map of a
  // text `fmt`, a map `attStmt` and byte-string `authData`) are malformed: AUMLOK_PROOF_INVALID. A WELL-FORMED attestation
  // of a format this node does not take ('packed', 'tpm', 'apple', ... : only 'none' is taken, since nothing here checks
  // hardware attestation), or one whose credential key is well-formed COSE of an algorithm this node does not register
  // (only ES256 and Ed25519), is not malformed: AUMLOK_ATTESTATION_UNSUPPORTED (400, never counted), so the page can say
  // this kind of authenticator is not supported. Only after the format is known is the rest parsed for shape.
  try {
    if (registration) {
      const decoded = decodeAttestationObject(isoBase64URL.toBuffer(response.attestationObject))
      const authData = decoded instanceof Map ? decoded.get('authData') : null
      if (!(authData instanceof Uint8Array) || typeof decoded.get('fmt') !== 'string' || !(decoded.get('attStmt') instanceof Map)) refuse('AUMLOK_PROOF_INVALID')
      if (decoded.get('fmt') !== 'none') refuse('AUMLOK_ATTESTATION_UNSUPPORTED')
      // A 'none' statement is empty (WebAuthn section 8.7): anything in it is malformed.
      if (decoded.get('attStmt').size !== 0) refuse('AUMLOK_PROOF_INVALID')
      const parsed = parseAuthenticatorData(authData)
      if (!parsed.flags.at || !parsed.credentialID?.byteLength || !parsed.credentialPublicKey?.byteLength) refuse('AUMLOK_PROOF_INVALID')
      const key = decodeCredentialPublicKey(parsed.credentialPublicKey)
      if (!(key instanceof Map) || !Number.isSafeInteger(key.get(3))) refuse('AUMLOK_PROOF_INVALID')
      // Job 7 review: the key is one of the two this node registers (ES256 on P-256, or Ed25519). Another algorithm is
      // unsupported; one of these two with the wrong curve or coordinates is malformed.
      if (![-7, -8].includes(key.get(3))) refuse('AUMLOK_ATTESTATION_UNSUPPORTED')
      if (keyAlgorithm(key) === null) refuse('AUMLOK_PROOF_INVALID')
    } else parseAuthenticatorData(isoBase64URL.toBuffer(response.authenticatorData))
  } catch (error) {
    if (['AUMLOK_PROOF_INVALID', 'AUMLOK_ATTESTATION_UNSUPPORTED'].includes(error?.code)) throw error
    refuse('AUMLOK_PROOF_INVALID')
  }
}

// THE SIGNATURE'S OWN ENCODING (job 7 review), the COSE key algorithms this node registers, and the stored key's algorithm
// live in webauthn-screen.mjs, shared by every screen: a passkey signature is judged only once its bytes are what
// the credential's algorithm signs (strict DER for ES256, exactly 64 bytes for Ed25519); anything else is malformed (400).
/**
 * THE SCREEN'S REFUSAL AS A ROUTE ANSWERS IT. The screen ran BEFORE any verifier, so nothing here is ever counted
 * (no branded outcome travels with it). A policy mismatch (type, challenge, origin, RP id, presence, verification) keeps
 * the status and code the pages already understand for a refused passkey: 403 `code`. Bytes that are no such answer, or a
 * credential this ceremony does not know: `code` 400 (`malformed`, unless the route names its own). An unsupported
 * attestation and client data from a frame keep their own codes; the screen's own hash failing is 503.
 */
const screenRefuse = (refusal, { code = 'AUMLOK_PROOF_INVALID', malformed = code, credential = 400 } = {}) => {
  if (refusal === 'unavailable') refuse('AUMLOK_UNAVAILABLE', 503)
  if (refusal === 'unsupported') refuse('AUMLOK_ATTESTATION_UNSUPPORTED')
  if (refusal === 'cross-origin') refuse('AUMLOK_CROSS_ORIGIN_PROOF')
  if (refusal === 'credential') refuse(code, credential)
  if (SCREEN_POLICY.includes(refusal)) refuse(code, 403)
  refuse(malformed, 400)
}
/**
 * A sign-in assertion's SHAPE, shared by HEAD and the Worker: the RESPONSE BYTES only. The id, rawId and
 * type the verifier needs, client data that decodes (string type, challenge and origin; a token binding, if any, of a known
 * status; no topOrigin, which only a cross-origin frame sends and which the verifier refuses anyway), authenticator data
 * that parses, and a signature of the stored key's algorithm's form. False: malformed, refused 400 before any verifier
 * runs, so what the verifier then says is a verdict or no verdict, never a parser's complaint.
 * Job 9 review: NOT the approve ceremony's full validateCredential. The owner's sign-in page sends the browser's own
 * getClientExtensionResults(), which may hold members; the verifier ignores them, so any plain object (or none) is taken,
 * as is any other top-level or response field the verifier never reads. Sign-in refuses nothing here that 8904acd9's
 * verifier would have accepted.
 * @param {unknown} credential The assertion as sent.
 * @param {string} publicKeyB64 The enrolled credential's stored COSE key.
 * @returns {boolean} Whether it is shaped as an assertion of that key.
 */
export function signinAssertionShape(credential, publicKeyB64) {
  try {
    if (!object(credential) || !b64(credential.id, 2048) || credential.rawId !== credential.id || credential.type !== 'public-key'
      || (credential.clientExtensionResults !== undefined && !object(credential.clientExtensionResults))) return false
    const response = credential.response
    if (!object(response) || !b64(response.clientDataJSON, 8192) || !b64(response.authenticatorData, 2048) || !b64(response.signature, 2048)
      || (response.userHandle !== undefined && response.userHandle !== null && !b64(response.userHandle, 256))) return false
    const data = decodeClientDataJSON(response.clientDataJSON)
    if (!object(data) || typeof data.type !== 'string' || typeof data.challenge !== 'string' || typeof data.origin !== 'string'
      || data.topOrigin !== undefined
      || (data.tokenBinding && (!object(data.tokenBinding) || !['present', 'supported', 'notSupported'].includes(data.tokenBinding.status)))) return false
    parseAuthenticatorData(isoBase64URL.toBuffer(response.authenticatorData))
    return signatureShape(publicKeyB64, response.signature)
  } catch (_error) { return false }
}

/**
 * FOUR OUTCOMES OF A PRESENTED PROOF, kept apart everywhere one is judged (made structural in job 9):
 *   0. a KNOWN parsing failure: the request's bytes are not a proof at all. Refused BEFORE any verifier runs
 *      (validateCredential, signatureShape, nodeSignatureShape): 400, never counted;
 *   0b. a WebAuthn answer's POLICY (type, challenge, origin, RP id, presence, verification, credential, counter)
 *      is screened by our own code (webauthn-screen.mjs) before any verifier: a mismatch is refused (403 for policy,
 *      400 for bytes), never counted;
 *   1-3. everything a verifier says goes through proof-failure-rule.mjs `proofOutcome`: `ok` only for a strict true,
 *      `wrong` only for a strict false (the WebAuthn library's `verified: false`): 403, the only answer `countFailure`
 *      counts; `unavailable` for anything else (ANY throw, the library's own included, a rejection, a non-boolean answer
 *      such as undefined, null or {}): 503 AUMLOK_UNAVAILABLE, never counted, and the challenge it was asked for stays
 *      usable (the ceremonies' records and the add door's).
 */
/** A node-key (Ed25519) signature as sent: base64url of exactly 64 bytes. Anything else is malformed, never checked. */
const nodeSignatureShape = value => b64(value, 86) && isoBase64URL.toBuffer(value).length === 64

function inviteValid(value, signed = true) {
  const keys = ['schema', 'inviteId', 'sponsorPubkeyHex', 'inviteeCommitmentSha256', 'assignedDomainPointer', 'quotaMonth', 'monthlySequence', 'revoked', 'issuedAt', 'expiresAt']
  return exact(value, signed ? [...keys, 'signature'] : keys) && value.schema === AUMLOK_INVITE_SCHEMA
    && id(value.inviteId) && sha(value.sponsorPubkeyHex) && sha(value.inviteeCommitmentSha256)
    && domainValid(value.assignedDomainPointer) && typeof value.quotaMonth === 'string' && /^\d{4}-\d{2}$/.test(value.quotaMonth)
    && Number.isInteger(value.monthlySequence) && value.monthlySequence >= 1 && value.monthlySequence <= 3
    && value.revoked === false && timestamp(value.issuedAt) && timestamp(value.expiresAt)
    && value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 604800000
    && value.quotaMonth === monthAt(value.issuedAt) && (!signed || b64(value.signature, 86))
}

/** The signed invite preimage includes every semantic field, never a caller-provided signer.
 * @param {object} receipt Complete unsigned or signed aukora.invite.v1 receipt.
 * @returns {string} Domain-separated canonical public payload.
 */
export function aumlokInvitePreimage(receipt) {
  if (!inviteValid(receipt, Object.hasOwn(receipt, 'signature'))) refuse('AUMLOK_INVITE_INVALID')
  const { signature: _signature, ...payload } = receipt
  return AUMLOK_INVITE_DOMAIN + canonicalJson(payload)
}

/**
 * The node key's Ed25519 check (bind, refresh, invite, revocation, and the stored records' own) as a branded outcome
 * (proof-failure-rule.mjs; a WRONG one is refused with `code`). A key or signature that is not the right shape is no proof
 * at all: null, and no verifier is asked (a ceremony refuses such a signature 400 before it gets here).
 */
async function nodeSignatureOutcome(pubkey, signature, preimage, code) {
  if (!sha(pubkey) || !nodeSignatureShape(signature)) return null
  return proofOutcome(async () => crypto.subtle.verify('Ed25519',
    await crypto.subtle.importKey('raw', Uint8Array.from(pubkey.match(/../g), value => parseInt(value, 16)), { name: 'Ed25519' }, false, ['verify']),
    isoBase64URL.toBuffer(signature), encoder.encode(preimage)), { code })
}
/** An invite receipt's signature under the trusted node key, as nodeSignatureOutcome (null: not a well-formed receipt). */
async function inviteReceiptOutcome(receipt, trustedSponsorPubkeyHex) {
  if (!inviteValid(receipt) || !sha(trustedSponsorPubkeyHex) || receipt.sponsorPubkeyHex !== trustedSponsorPubkeyHex) return null
  return nodeSignatureOutcome(trustedSponsorPubkeyHex, receipt.signature, aumlokInvitePreimage(receipt), 'AUMLOK_INVITE_SIGNATURE_INVALID')
}
/** A ceremony's node-key check: not a proof at all (null) is malformed, 400; otherwise the outcome decides (settleProof). */
const settleSignature = (outcome, code) => outcome === null ? refuse(code, 400) : settleProof(outcome)
/** A stored record's signature: anything but `ok` means the state is not what this node signed (unavailable: 503 as it is). */
const storedSignature = outcome => {
  if (proofIs(outcome, 'unavailable')) settleProof(outcome)
  if (!proofIs(outcome, 'ok')) refuse('AUMLOK_INVITE_STATE_CORRUPT', 503)
}

/** Verify only an invitation signature using an independently supplied trusted sponsor key.
 * @param {object} receipt Public signed invite; domain pointers never establish identity.
 * @param {string} trustedSponsorPubkeyHex Key obtained from authoritative BOUND state, not the receipt.
 * @returns {Promise<boolean>} Signature validity only; does not establish redemption or current revocation. A backend
 *   that throws reads as not verified here (a report, never a budget); the ceremonies use inviteReceiptOutcome.
 */
export async function verifyAumlokInviteReceipt(receipt, trustedSponsorPubkeyHex) {
  try { return proofIs(await inviteReceiptOutcome(receipt, trustedSponsorPubkeyHex), 'ok') } catch (_error) { return false }
}

const initialAudit = () => ({ schema: 'aukora.aumlok.audit-retention.v1', retainedLimit: AUMLOK_LIMITS.attemptRecords,
  totalRecords: 0, prunedRecords: 0, prunedThroughHash: EMPTY_AUDIT_HASH, latestHash: EMPTY_AUDIT_HASH })
const initial = () => ({ schema: STATE_SCHEMA, generation: 0, binding: null, challenges: [], invites: [], revocations: [],
  'pepper.v1': null, pepperProtection: null, failures: 0, failedAt: [], nextAllowedAt: 0,
  phraseFailures: 0, phraseFailedAt: [], phraseNextAllowedAt: 0, lastRotationChallengeId: null,
  attempts: [], approvals: [], audit: initialAudit(), enrollmentCount: 0, enrollments: [] })
const auditHash = (previousHash, record) => hash('aukora.aumlok.audit.v1\0' + previousHash + '\0' + canonicalJson(record))
const credentialValid = value => exact(value, ['id', 'publicKeyB64', 'counter']) && b64(value.id, 2048) && b64(value.publicKeyB64, 512) && Number.isSafeInteger(value.counter) && value.counter >= 0
/** One enrolled device beside the binding (passkey-devices.mjs). Its MAC covers everything but the moving counter and time. */
// `instance`: the enrolment instance minted when the owner confirmed this exact key. A device removed and enrolled again
// is a NEW instance, so nothing made by the old one (an approval, a code) can ever count for the new one.
// `approvedBy`: the enrolled credential whose Class 3 approval confirmed this key.
const deviceRecordValid = value => exact(value, ['schema', 'credential', 'label', 'addedAt', 'lastVerifiedAt', 'approvedBy', 'instance', 'recordMac',
  ...(Object.hasOwn(value ?? {}, 'transports') ? ['transports'] : [])]) && (!Object.hasOwn(value, 'transports') || storedTransportsValid(value.transports))
  && value.schema === PASSKEY_DEVICE_RECORD_SCHEMA && credentialValid(value.credential) && deviceLabelValid(value.label)
  && timestamp(value.addedAt) && timestamp(value.lastVerifiedAt) && value.lastVerifiedAt >= value.addedAt && b64(value.approvedBy, 2048)
  && deviceInstanceValid(value.instance) && sha(value.recordMac)
const deviceMacPayload = value => canonicalJson({ schema: value.schema, id: value.credential.id, publicKeyB64: value.credential.publicKeyB64,
  label: value.label, addedAt: value.addedAt, approvedBy: value.approvedBy, instance: value.instance,
  ...(Object.hasOwn(value, 'transports') ? { transports: value.transports } : {}) })
function credentialAliasesNode(credential, nodePubkeyHex) {
  let key
  try { key = decodeCredentialPublicKey(isoBase64URL.toBuffer(credential.publicKeyB64)) }
  catch (_error) { refuse('AUMLOK_PROOF_INVALID', 403) }
  if (!(key instanceof Map)) refuse('AUMLOK_PROOF_INVALID', 403)
  const x = key.get(cose.COSEKEYS.x)
  if (cose.isCOSEPublicKeyOKP(key) && key.get(cose.COSEKEYS.alg) === cose.COSEALG.EdDSA
    && key.get(cose.COSEKEYS.crv) === cose.COSECRV.ED25519 && x instanceof Uint8Array && x.length === 32) {
    return [...x].map(byte => byte.toString(16).padStart(2, '0')).join('') === nodePubkeyHex
  }
  const y = key.get(cose.COSEKEYS.y)
  if (cose.isCOSEPublicKeyEC2(key) && key.get(cose.COSEKEYS.alg) === cose.COSEALG.ES256
    && key.get(cose.COSEKEYS.crv) === cose.COSECRV.P256 && x instanceof Uint8Array && x.length === 32
    && y instanceof Uint8Array && y.length === 32) return false
  refuse('AUMLOK_PROOF_INVALID', 403)
}
/**
 * THE KEY ITSELF, whatever its COSE encoding: an ES256 key as its uncompressed P-256 point (0x04 || x || y), an EdDSA key
 * as its 32 Ed25519 bytes. Two credentials naming one key in different encodings (map order, extra or missing
 * parameters, another algorithm label) give the same bytes. Any other key is refused.
 * @param {string} publicKeyB64 The stored COSE key.
 * @returns {Uint8Array} The canonical key bytes.
 */
function canonicalKeyBytes(publicKeyB64) {
  let key
  try { key = decodeCredentialPublicKey(isoBase64URL.toBuffer(publicKeyB64)) }
  catch (_error) { refuse('AUMLOK_PROOF_INVALID', 403) }
  if (!(key instanceof Map)) refuse('AUMLOK_PROOF_INVALID', 403)
  const x = key.get(cose.COSEKEYS.x), y = key.get(cose.COSEKEYS.y)
  if (cose.isCOSEPublicKeyOKP(key) && key.get(cose.COSEKEYS.crv) === cose.COSECRV.ED25519 && x instanceof Uint8Array && x.length === 32) return Uint8Array.from(x)
  if (cose.isCOSEPublicKeyEC2(key) && key.get(cose.COSEKEYS.crv) === cose.COSECRV.P256 && x instanceof Uint8Array && x.length === 32
    && y instanceof Uint8Array && y.length === 32) return Uint8Array.from([4, ...x, ...y])
  refuse('AUMLOK_PROOF_INVALID', 403)
}
/**
 * SHA-256 (lowercase hex) of a credential's canonical key bytes: the key's identity for duplicate refusal, the
 * confirmation phrase and the confirm approval's `keyHash`.
 * @param {string} publicKeyB64 The stored COSE key.
 * @returns {Promise<string>} 64 hex.
 */
export async function credentialKeyHash(publicKeyB64) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', canonicalKeyBytes(publicKeyB64)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function distinctCredentialKey(credential, nodePubkeyHex) {
  if (credentialAliasesNode(credential, nodePubkeyHex)) refuse('NODE_KEY_IS_NOT_OWNER_KEY', 403)
}
/**
 * THE ONE REGISTRATION VERIFIER, shared by the bind ceremony and "add a device" (passkey-devices.mjs): the response's
 * shape, attestation format 'none' only (no remote certificate/CRL lookups or claimed hardware attestation), the exact
 * challenge, origin and RP id, user presence AND user verification, ES256 or EdDSA, and a key that is not the node key.
 * @returns {Promise<object>} The verified credential {id, publicKeyB64, counter}; any failure throws a content-free code.
 */
async function verifiedRegistration(response, { challenge, origin, rpId, nodePubkeyHex }) {
  // Malformed (400) and a well-formed but unsupported attestation format or key (400) are refused here, before any verifier.
  validateCredential(response, true)
  // PHASE ONE, THE SCREEN: challenge, origin, type, RP id and both flags, compared here; a mismatch is 403 and
  // never counted (no verifier ran).
  const screened = await screenRegistration(response, { challenge, origin, rpId })
  if (!screened.pass) screenRefuse(screened.refusal)
  // PHASE TWO, THE CHECK: only a strict `verified: false` is wrong (counted by the caller through countFailure); any throw
  // or other answer is no verdict (503). proof-failure-rule.mjs.
  const verified = settleProof(await proofOutcome(() => verifyRegistrationResponse({ response, expectedChallenge: challenge,
    expectedOrigin: origin, expectedRPID: rpId, expectedType: 'webauthn.create', requireUserPresence: true,
    requireUserVerification: true, supportedAlgorithmIDs: [-7, -8] }), { code: 'AUMLOK_PROOF_INVALID', judge: 'webauthn-registration' }))
  // The credential the library read from authData must be the one the answer names: one that is not is inconsistent bytes
  // (400, never counted), not a proof judged wrong.
  if (verified.registrationInfo.credential?.id !== response.id) refuse('AUMLOK_PROOF_INVALID')
  const derived = verified.registrationInfo.credential
  const credential = { id: derived.id, publicKeyB64: isoBase64URL.fromBuffer(derived.publicKey), counter: derived.counter }
  if (!credentialValid(credential)) refuse('AUMLOK_PROOF_INVALID')
  distinctCredentialKey(credential, nodePubkeyHex)
  return credential
}
// `transports` (optional, additive): the registration's own transport hints, kept only when a bind under passkey devices
// recorded them. A binding without it (hers) is read exactly as before.
const bindingValid = value => exact(value, ['aumlokId', 'recoveryCommitment', 'rootEscrow', 'nodePubkeyHex', 'credential', 'boundAt', 'lastVerifiedAt', 'generation',
  ...(Object.hasOwn(value ?? {}, 'transports') ? ['transports'] : [])]) && (!Object.hasOwn(value, 'transports') || storedTransportsValid(value.transports))
  && sha(value.aumlokId) && sha(value.recoveryCommitment) && escrowValid(value.rootEscrow) && sha(value.nodePubkeyHex) && credentialValid(value.credential)
  && timestamp(value.boundAt) && timestamp(value.lastVerifiedAt) && value.lastVerifiedAt >= value.boundAt && Number.isSafeInteger(value.generation) && value.generation >= 1
const challengeKeys = ['id', 'requestId', 'requestHash', 'intentHash', 'purpose', 'stage', 'challenge', 'origin', 'rpId', 'recoveryCommitment', 'rootEscrow', 'nodePubkeyHex', 'generation', 'issuedAt', 'expiresAt', 'consumedAt', 'outcome', 'completionHash', 'nextChallengeId', 'credential', 'invite', 'revocation', 'binding', 'accessSubject']
const approvalPayload = value => ({ schema: 'aumlok.approval.v1', approvalId: value.approvalId, binding: value.binding,
  generation: value.generation, approvedAt: value.approvedAt, expiresAt: value.expiresAt })
const publicApproval = value => ({ ...approvalPayload(value), consumedAt: value.consumedAt, recordMac: value.recordMac })
/**
 * THE STATUS AS ITS ROUTE ANSWERS IT (`GET /_host/aumlok/status`, which any signed-in session reads): every approval
 * without its `recordMac`, the store's own integrity MAC over the approval's private fields. No reader of the route uses
 * it (aumlok-ceremony.ts, sovereignty-cards.ts and host-facts.ts read the other fields, all kept). In-process readers
 * (the verified-facts projection) still call `status()`, which carries it.
 * @param {object} status The store's `status()` result.
 * @returns {object} The same status, approvals without `recordMac`.
 */
export function aumlokStatusAnswer(status) {
  if (!object(status) || !Array.isArray(status.approvedGrants)) return status
  return { ...status, approvedGrants: status.approvedGrants.map(({ recordMac: _recordMac, ...grant }) => grant) }
}
const approvalMac = (state, approval, pepperSecret) => pepperMac(state, 'aukora.aumlok.approval.v1', canonicalJson({ ...approvalPayload(approval), tokenHash: approval.tokenHash,
  ...(approval.approvedBy === undefined ? {} : { approvedBy: approval.approvedBy }), ...(approval.approvedInstance === undefined ? {} : { approvedInstance: approval.approvedInstance }),
  ...(approval.userHandle === undefined ? {} : { userHandle: approval.userHandle }) }), pepperSecret)
function validateState(value) {
  if (value === undefined) return initial()
  if (value?.schema === 'aukora.aumlok.state.v1') refuse('AUMLOK_STATE_MIGRATION_REQUIRED', 503)
  const bad = () => refuse('AUMLOK_STATE_CORRUPT', 503)
  const auditPresent = object(value) && Object.hasOwn(value, 'audit')
  const stateFields = ['schema', 'generation', 'binding', 'challenges', 'invites', 'revocations', 'pepper.v1', 'failures', 'failedAt', 'nextAllowedAt', 'attempts', 'approvals']
  const phrasePresent = object(value) && ['phraseFailures', 'phraseFailedAt', 'phraseNextAllowedAt'].some(key => Object.hasOwn(value, key))
  if (phrasePresent) stateFields.push('phraseFailures', 'phraseFailedAt', 'phraseNextAllowedAt')
  if (object(value) && Object.hasOwn(value, 'pepperProtection')) stateFields.push('pepperProtection')
  if (object(value) && Object.hasOwn(value, 'lastRotationChallengeId')) stateFields.push('lastRotationChallengeId')
  const enrollmentPresent = object(value) && (Object.hasOwn(value, 'enrollmentCount') || Object.hasOwn(value, 'enrollments'))
  if (enrollmentPresent) stateFields.push('enrollmentCount', 'enrollments')
  // ADDITIVE: a store with no `devices` field (hers before passkey devices) is read exactly as before.
  const devicesPresent = object(value) && Object.hasOwn(value, 'devices')
  if (devicesPresent) stateFields.push('devices')
  if (!exact(value, auditPresent ? [...stateFields, 'audit'] : stateFields) || value.schema !== STATE_SCHEMA
    || !Number.isSafeInteger(value.generation) || value.generation < 0 || (value.binding === null ? value.generation !== 0 : !bindingValid(value.binding) || value.binding.generation !== value.generation)
    || !Array.isArray(value.challenges) || value.challenges.length > AUMLOK_LIMITS.challenges
    || !Array.isArray(value.invites) || value.invites.length > AUMLOK_LIMITS.inviteRecords
    || !Array.isArray(value.revocations) || value.revocations.length > value.invites.length
    || bytes(JSON.stringify(value)) > AUMLOK_LIMITS.stateBytes
    || !Array.isArray(value.attempts) || value.attempts.length > AUMLOK_LIMITS.attemptRecords
    || !(value['pepper.v1'] === null ? value.binding === null && value.challenges.length === 0 && value.attempts.length === 0 : b64(value['pepper.v1'], 43) && isoBase64URL.toBuffer(value['pepper.v1']).length === 32)
    || !Number.isSafeInteger(value.failures) || value.failures < 0 || value.failures > AUMLOK_LIMITS.hardLockFailures
    || !Array.isArray(value.failedAt) || value.failedAt.length > AUMLOK_LIMITS.hardLockFailures || value.failedAt.some(at => !timestamp(at))
    || !timestamp(value.nextAllowedAt)
    || !Array.isArray(value.approvals) || value.approvals.length > AUMLOK_LIMITS.approvalRecords) bad()
  if (phrasePresent && (!Number.isSafeInteger(value.phraseFailures) || value.phraseFailures < 0 || value.phraseFailures > AUMLOK_LIMITS.hardLockFailures
    || !Array.isArray(value.phraseFailedAt) || value.phraseFailedAt.length > AUMLOK_LIMITS.hardLockFailures || value.phraseFailedAt.some(at => !timestamp(at))
    || !timestamp(value.phraseNextAllowedAt))) bad()
  if (Object.hasOwn(value, 'pepperProtection') && value.pepperProtection !== null
    && (!exact(value.pepperProtection, ['schema', 'keyCheck']) || value.pepperProtection.schema !== SEPARATED_PEPPER_SCHEMA
      || !sha(value.pepperProtection.keyCheck) || value['pepper.v1'] === null)) bad()
  if (Object.hasOwn(value, 'lastRotationChallengeId') && value.lastRotationChallengeId !== null
    && (!id(value.lastRotationChallengeId) || value.generation < 2)) bad()
  const escrowMatchesProtection = escrow => (escrow.schema === 'aukora.aumlok.escrow.v4') === (value.pepperProtection != null)
  if (value.binding && !escrowMatchesProtection(value.binding.rootEscrow)) bad()
  if (enrollmentPresent) {
    if (value.enrollmentCount !== (value.binding === null ? 0 : 1) || !Array.isArray(value.enrollments)
      || value.enrollments.length > value.enrollmentCount) bad()
    for (const record of value.enrollments) {
      if (!exact(record, ['schema', 'at', 'intentHash', 'nodePubkeyHex', 'ownerPublicKeyHex', 'credentialId', 'recordMac'])
        || record.schema !== 'aumlok.enrollment.v1' || !timestamp(record.at) || record.at !== value.binding.boundAt
        || !sha(record.intentHash) || record.nodePubkeyHex !== value.binding.nodePubkeyHex || !sha(record.ownerPublicKeyHex)
        || record.ownerPublicKeyHex === record.nodePubkeyHex || record.credentialId !== value.binding.credential.id || !sha(record.recordMac)) bad()
    }
  }
  if (devicesPresent) {
    if (!Array.isArray(value.devices) || value.devices.length > PASSKEY_DEVICE_LIMITS.devices || (value.devices.length > 0 && value.binding === null)) bad()
    const deviceIds = new Set(value.binding ? [value.binding.credential.id] : [])
    for (const device of value.devices) {
      // `approvedBy` names the credential that approved the code; it may since have been removed, so it is not looked up.
      if (!deviceRecordValid(device) || deviceIds.has(device.credential.id)) bad()
      deviceIds.add(device.credential.id)
    }
  }
  let prunedRecords = 0
  if (auditPresent) {
    const audit = value.audit
    if (!exact(audit, ['schema', 'retainedLimit', 'totalRecords', 'prunedRecords', 'prunedThroughHash', 'latestHash'])
      || audit.schema !== 'aukora.aumlok.audit-retention.v1' || audit.retainedLimit !== AUMLOK_LIMITS.attemptRecords
      || !Number.isSafeInteger(audit.totalRecords) || audit.totalRecords < 0
      || !Number.isSafeInteger(audit.prunedRecords) || audit.prunedRecords < 0
      || audit.totalRecords - audit.prunedRecords !== value.attempts.length
      || value.attempts.length !== Math.min(audit.totalRecords, AUMLOK_LIMITS.attemptRecords)
      || !sha(audit.prunedThroughHash) || !sha(audit.latestHash)
      || (audit.prunedRecords === 0 && audit.prunedThroughHash !== EMPTY_AUDIT_HASH)
      || (audit.totalRecords === 0 && audit.latestHash !== EMPTY_AUDIT_HASH)) bad()
    prunedRecords = audit.prunedRecords
  }
  const ids = new Set(), requests = new Set()
  for (const record of value.challenges) {
    // A bind's assertion step may carry its registration's transports to the binding (optional, additive).
    const carriesTransports = object(record) && Object.hasOwn(record, 'transports')
    if (!exact(record, carriesTransports ? [...challengeKeys, 'transports'] : challengeKeys) || !id(record.id)
      || (carriesTransports && (!storedTransportsValid(record.transports) || record.purpose !== 'bind' || record.stage !== 'assertion')) || ids.has(record.id) || !requestId(record.requestId) || requests.has(record.requestId)
      || !sha(record.requestHash) || !sha(record.intentHash) || !['bind', 'refresh', 'invite', 'approve', 'unseal'].includes(record.purpose)
      || !['registration', 'assertion'].includes(record.stage) || (record.stage === 'registration' && record.purpose !== 'bind')
      || !b64(record.challenge, 43) || !originValid(record.origin) || record.rpId !== new URL(record.origin).hostname
      || !sha(record.recoveryCommitment) || !escrowValid(record.rootEscrow) || !escrowMatchesProtection(record.rootEscrow) || !sha(record.nodePubkeyHex) || !Number.isSafeInteger(record.generation) || record.generation < 0
      || !timestamp(record.issuedAt) || !timestamp(record.expiresAt) || record.expiresAt - record.issuedAt !== AUMLOK_LIMITS.challengeMs
      || (record.consumedAt !== null && (!timestamp(record.consumedAt) || record.consumedAt < record.issuedAt || record.consumedAt >= record.expiresAt))
      || (record.outcome !== null && !/^[A-Z0-9_]{1,80}$/.test(record.outcome))
      || ((record.consumedAt === null) !== (record.outcome === null))
      || (record.completionHash !== null && !sha(record.completionHash)) || ((record.consumedAt === null) !== (record.completionHash === null))
      || (record.nextChallengeId !== null && !id(record.nextChallengeId))
      || (record.credential !== null && !credentialValid(record.credential))
      || (record.invite !== null && !inviteValid(record.invite, false))
      || (record.revocation !== null && !revocationValid(record.revocation, false))
      || (record.purpose === 'approve' ? !actionValid(record.binding) || record.binding.audience !== record.origin : record.binding !== null)
      || (record.accessSubject !== null && !sha(record.accessSubject))) bad()
    ids.add(record.id); requests.add(record.requestId)
  }
  const inviteIds = new Set(), slots = new Set(), monthlyCounts = new Map()
  for (const invite of value.invites) {
    const slot = `${invite.sponsorPubkeyHex}:${invite.quotaMonth}:${invite.monthlySequence}`
    if (!inviteValid(invite) || inviteIds.has(invite.inviteId) || slots.has(slot) || !value.binding || invite.sponsorPubkeyHex !== value.binding.nodePubkeyHex) bad()
    inviteIds.add(invite.inviteId); slots.add(slot)
    monthlyCounts.set(invite.quotaMonth, (monthlyCounts.get(invite.quotaMonth) ?? 0) + 1)
  }
  for (const invite of value.invites) if (invite.monthlySequence > monthlyCounts.get(invite.quotaMonth)) bad()
  const revoked = new Set()
  for (const entry of value.revocations) {
    if (!revocationValid(entry, true) || !inviteIds.has(entry.inviteId) || revoked.has(entry.inviteId) || entry.sponsorPubkeyHex !== value.binding?.nodePubkeyHex
      || entry.revokedAt < value.invites.find(invite => invite.inviteId === entry.inviteId).issuedAt) bad()
    revoked.add(entry.inviteId)
  }
  for (const [index, attempt] of value.attempts.entries()) {
    // The record shape the build before devices reads, exactly: a device credential is named INSIDE `outcome`
    // (`VERIFIED_D_<16 HEX>`, attempt below), so a store whose devices are all removed is old-readable again.
    if (!exact(attempt, ['schema', 'sequence', 'at', 'purpose', 'outcome', 'ipHash32']) || attempt.schema !== 'aumlok.attempt.v1'
      || attempt.sequence !== prunedRecords + index + 1 || !timestamp(attempt.at) || typeof attempt.purpose !== 'string' || !/^[a-z-]{1,24}$/.test(attempt.purpose)
      || typeof attempt.outcome !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(attempt.outcome) || !/^[0-9a-f]{8}$/.test(attempt.ipHash32)) bad()
  }
  const tokens = new Set()
  const approvalIds = new Set()
  for (const approval of value.approvals) {
    const publicRecordPresent = ['approvalId', 'approvedAt', 'recordMac'].some(key => Object.hasOwn(approval, key))
    const approvalFields = ['tokenHash', 'binding', 'origin', 'generation', 'expiresAt', 'consumedAt']
    if (publicRecordPresent) approvalFields.push('approvalId', 'approvedAt', 'recordMac')
    // Private, optional, never public: which enrolled device approved (absent = the primary) and the user handle its
    // authenticator returned. Approvals made before passkey devices have neither and read exactly as before.
    if (Object.hasOwn(approval, 'approvedBy')) approvalFields.push('approvedBy', 'approvedInstance')
    if (Object.hasOwn(approval, 'userHandle')) approvalFields.push('userHandle')
    if (!exact(approval, approvalFields) || !sha(approval.tokenHash)
      || tokens.has(approval.tokenHash) || !actionValid(approval.binding) || approval.binding.audience !== approval.origin
      || !Number.isSafeInteger(approval.generation) || approval.generation < 1 || !timestamp(approval.expiresAt)
      || (approval.consumedAt !== null && (!timestamp(approval.consumedAt) || approval.consumedAt >= approval.expiresAt))) bad()
    if ((Object.hasOwn(approval, 'approvedBy') && (!b64(approval.approvedBy, 2048) || !deviceInstanceValid(approval.approvedInstance)))
      || (Object.hasOwn(approval, 'userHandle') && !deviceUserHandleValid(approval.userHandle))
      || ((Object.hasOwn(approval, 'approvedBy') || Object.hasOwn(approval, 'userHandle')) && !publicRecordPresent)) bad()
    if (publicRecordPresent && (!id(approval.approvalId) || approvalIds.has(approval.approvalId) || !timestamp(approval.approvedAt)
      || approval.expiresAt - approval.approvedAt !== AUMLOK_LIMITS.approvalMs || !sha(approval.recordMac)
      || (approval.consumedAt !== null && approval.consumedAt < approval.approvedAt))) bad()
    if (publicRecordPresent) approvalIds.add(approval.approvalId)
    tokens.add(approval.tokenHash)
  }
  return value
}
function revocationValid(value, signed) {
  const keys = ['schema', 'inviteId', 'sponsorPubkeyHex', 'revokedAt']
  return exact(value, signed ? [...keys, 'signature'] : keys) && value.schema === REVOCATION_SCHEMA && id(value.inviteId) && sha(value.sponsorPubkeyHex) && timestamp(value.revokedAt) && (!signed || b64(value.signature, 86))
}
const revocationPreimage = value => REVOCATION_SCHEMA + '\n' + canonicalJson(value)

async function publicStatus(state, at, available, ownerPublicKeyHex, pepperSecret) {
  const binding = state.binding, month = monthAt(at)
  const nodeIsAuthority = binding !== null && (binding.nodePubkeyHex === ownerPublicKeyHex || credentialAliasesNode(binding.credential, binding.nodePubkeyHex))
  return { ok: true, schema: STATUS_SCHEMA, phase: binding ? 'BOUND' : 'UNBOUND', bound: binding !== null,
    passkeyVerified: binding !== null, aumlokId: binding?.aumlokId ?? null, nodePubkeyHex: binding?.nodePubkeyHex ?? null,
    commitmentSha256: null, boundAt: binding?.boundAt ?? null, lastVerifiedAt: binding?.lastVerifiedAt ?? null,
    enrollmentCount: state.enrollmentCount, rotationSeq: binding ? state.generation - 1 : 0,
    lastRotationChallengeId: state.lastRotationChallengeId,
    pepperSeparated: binding !== null && state.pepperProtection !== null,
    pepperMigrationRequired: state['pepper.v1'] !== null && state.pepperProtection === null && pepperSecret !== undefined,
    phraseBlockers: state.phraseFailures >= AUMLOK_LIMITS.hardLockFailures ? ['AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED']
      : state.phraseFailedAt.filter(value => value > at - 3600000).length >= AUMLOK_LIMITS.failuresPerHour || at < state.phraseNextAllowedAt ? ['AUMLOK_PHRASE_RATE_LIMITED'] : [],
    keyCommitmentId: binding ? await pepperMac(state, 'aukora.aumlok.key-revision.v1', canonicalJson({ generation: state.generation, rootEscrow: binding.rootEscrow }), pepperSecret) : null,
    approvedGrants: state.approvals.filter(value => value.approvalId && value.expiresAt > at && value.generation === state.generation).map(publicApproval),
    authorityAvailable: (binding !== null || available) && sha(ownerPublicKeyHex) && !nodeIsAuthority,
    enrollmentAvailable: available && binding === null && state.enrollmentCount === 0,
    blockers: state.failures >= AUMLOK_LIMITS.hardLockFailures ? ['AUMLOK_GUARDIAN_QUORUM_REQUIRED']
      : !ownerPublicKeyHex ? ['AUMLOK_OWNER_KEY_UNAVAILABLE'] : nodeIsAuthority ? ['NODE_KEY_IS_NOT_OWNER_KEY']
        : binding || available ? [] : ['AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE'],
    biometricVerified: false, phraseRecoveryAvailable: false, identityIsKey: true, domainIsPointer: true,
    invite: { quotaMonth: month, issuedThisMonth: state.invites.filter(value => value.quotaMonth === month).length, limit: 3, revokedCount: state.revocations.length, lifetimeIssuedCount: state.invites.length } }
}
/** Every enrolled credential id: the primary first, then each device (none when unbound). */
const enrolledIds = state => state.binding ? [state.binding.credential.id, ...(state.devices ?? []).map(device => device.credential.id)] : []
/** The enrolled credential with this id: the primary's or a device's, else null. */
const enrolledCredential = (state, credentialId) => !state.binding ? null : state.binding.credential.id === credentialId ? state.binding.credential
  : (state.devices ?? []).find(device => device.credential.id === credentialId)?.credential ?? null
/** Store a verified device credential's new counter and time; the binding is untouched. */
const touchDevice = (state, credential, at) => {
  state.devices = state.devices.map(device => device.credential.id === credential.id ? { ...device, credential, lastVerifiedAt: Math.max(at, device.addedAt) } : device)
}
// `at`: the browser's timeout is what is LEFT of the ceremony at `at`, never its whole life (an idempotent re-ask of a
// ceremony issued earlier must not tell the browser to wait past the node's deadline: a late answer is refused).
function challengeView(record, allowIds = null, at = record.issuedAt) {
  const timeout = Math.max(1, Math.min(AUMLOK_LIMITS.challengeMs, record.expiresAt - at))
  const publicKey = record.stage === 'registration'
    ? { challenge: record.challenge, rp: { id: record.rpId, name: 'AUKORA' }, user: { id: record.id, name: record.id, displayName: 'AUMLOK identity' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }], timeout,
      attestation: 'none', authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } }
    : { challenge: record.challenge, rpId: record.rpId, timeout, userVerification: 'required',
      allowCredentials: (allowIds ?? [record.credential.id]).map(credentialId => ({ type: 'public-key', id: credentialId })) }
  return { ok: true, phase: record.stage === 'registration' ? 'PENDING_REGISTRATION' : 'PENDING_ASSERTION', challengeId: record.id,
    purpose: record.purpose, expiresAt: record.expiresAt, intentHash: record.intentHash,
    nodeProofPreimage: AUMLOK_NODE_DOMAIN + record.intentHash, publicKey,
    ...(record.binding ? { binding: record.binding } : {}),
    ...(record.invite ? { invite: record.invite, signaturePreimage: aumlokInvitePreimage(record.invite) } : {}),
    ...(record.revocation ? { revocation: record.revocation, signaturePreimage: revocationPreimage(record.revocation) } : {}) }
}

/** Create private custody and passkey approval storage with a host enrollment policy.
 * @param {object} storage Atomic transaction/get/put adapter, private and never mirror-backed.
 * @param {object} options Exact origins, clock, ownerPublicKeyHex, optional authorizeEnrollment and pepperSecret.
 * pepperSecret is an optional canonical base64url 32-byte Worker secret, never stored here.
 * authorizeEnrollment(intent, context) approves the exact cryptographically verified intent
 * under the host's policy. It returns {authorized:true,intentHash} and must be read-only,
 * bounded and retry-safe. Without it enrollment stays unavailable. The default host policy
 * trusts verified owner Access for genesis; explicit signature mode requires an additional
 * owner signature. Neither registration with fmt:none nor signed UV proves hardware custody.
 * challenge/complete/consumeApproval accept host-only context {access,ip,enrollmentApproval}; access is a result
 * from verifyAccess, never JSON or an unsanitized header. Raw IP is hashed then discarded.
 * enrollmentApproval is untrusted signature evidence for the independent verifier only.
 * A ceremony is durably counted as failed ONLY when a proof it presented was checked and was wrong (proof-failure-rule.mjs):
 * capacity, expiry, unknown or used challenges, malformed requests and policy refusals are refused and never counted. Fresh, cryptographically verified UV
 * resets WebAuthn failures before hard lock, never independent phrase guesses. Ten failures
 * in either budget require separate guardian recovery; locked WebAuthn has no UV bypass.
 * Unseal requires fresh UV, the phrase budget and an own lowercase 64-hex commitmentSha256
 * matching the recovery MAC before opening escrow. Missing or malformed commitments are
 * refused; there is no passkey-only release. Success returns only the client-encrypted root
 * and reports phraseVerified:true. Neither successful UV nor unseal resets phrase failures.
 * Audit retains the newest 256 events plus lifetime/pruned counts and a hash-chain anchor.
 * Pruned event contents are not archived. Retention never resets lockout or failure counters.
 * Pre-metadata v2 rows are preserved and normalized only in a detached read result; status
 * does not write. A later ceremony persists metadata alongside its ordinary audit append.
 * The chain detects inconsistent retained rows, not a malicious rewrite of all private state.
 * Independently held anchors are required to detect that infrastructure compromise.
 * New secret-backed stores use pepper.v2 metadata and escrow.v4. Initialized legacy stores,
 * including unbound stores, keep existing keys and report migration required if a secret is
 * added. There is no migration operation. Missing/changed separated secrets refuse reads and
 * writes explicitly, including status; restoring the original secret restores access.
 * Without separation the private state holds its whole pepper; state theft defeats wrapping.
 * Enrollment and Class 3 fail closed without an independently configured owner public key.
 * An Ed25519 passkey must also differ from the node key; node possession cannot substitute
 * for the configured owner session authority or the stored owner's WebAuthn assertion.
 * Public approval metadata is not authority. verifyApproval checks but never consumes the bearer;
 * consumeApprovalInTransaction consumes inside the effect owner's existing atomic transaction.
 * invites lists verified signed public records and lifetime issuance count. redeem accepts exactly
 * {invite, code}: a locally issued signed receipt and its 32-byte canonical base64url bearer code.
 * Owner recovery phrases are not invite codes and are never accepted. Guest sessions and isolated
 * guest resources are unavailable; successful verification explicitly reports that limitation.
 * It checks the domain-separated commitment and current local expiry/revocation only, without writes,
 * audit, consumption, credentials, enrollment or grants. Neither operation supplies an independent
 * freshness witness; restoration of a stale consistent state remains unsupported (WO-1).
 * @returns {object} Status, ceremonies, read-only verification and single-use approval operations.
 * Construction/status never creates pepper; valid ceremony transactions initialize it lazily.
 */
export function createAumlokStore(storage, { origins, now = Date.now, authorizeEnrollment, ownerPublicKeyHex, pepperSecret } = {}) {
  if (!Array.isArray(origins) || !origins.length || origins.some(value => !originValid(value)) || typeof now !== 'function'
    || (authorizeEnrollment !== undefined && typeof authorizeEnrollment !== 'function')
    || (ownerPublicKeyHex !== undefined && !sha(ownerPublicKeyHex))
    || (pepperSecret !== undefined && (!b64(pepperSecret, 43) || isoBase64URL.toBuffer(pepperSecret).length !== 32))) throw new TypeError('AUMLOK_CONFIGURATION_INVALID')
  const allowed = new Set(origins), available = typeof authorizeEnrollment === 'function' && sha(ownerPublicKeyHex)
  // Job 9 review: ids of OUTSTANDING ceremonies whose last completion reached no verdict (503). Kept so a later ceremony
  // of the same purpose by the same signed-in subject may take such a slot (issue below), since the owner's approval page
  // starts a new ceremony on every try. A hint for liveness only, never a safety rule: it is not persisted (the record
  // shape the build before devices reads stays as it is), so after this object is rebuilt the answer is again the
  // four-slot 429 with its wait, never counted. Bounded: pruned to the challenges the state holds on every addition.
  const noVerdict = new Set()
  const mac = (state, domain, value) => pepperMac(state, domain, value, pepperSecret)
  const initializePepper = async state => {
    if (state['pepper.v1'] !== null) return
    state['pepper.v1'] = random()
    if (pepperSecret !== undefined) {
      state.pepperProtection = { schema: SEPARATED_PEPPER_SCHEMA, keyCheck: EMPTY_AUDIT_HASH }
      state.pepperProtection.keyCheck = await mac(state, 'aukora.aumlok.pepper-check.v2', '')
    }
  }
  const time = () => { const at = now(); if (!timestamp(at) || at > 8640000000000000 - 604800000) refuse('AUMLOK_CLOCK_INVALID', 503); return at }
  const context = origin => { if (!allowed.has(origin)) refuse('AUMLOK_ORIGIN_REQUIRED', 403) }
  const read = async tx => {
    const state = validateState(structuredClone(await tx.get(AUMLOK_STORAGE_KEY)))
    if (!Object.hasOwn(state, 'pepperProtection')) state.pepperProtection = null
    if (state.pepperProtection !== null) {
      const check = await pepperMacOutcome(state, 'aukora.aumlok.pepper-check.v2', '', state.pepperProtection.keyCheck, pepperSecret, 'AUMLOK_PEPPER_SECRET_MISMATCH')
      if (proofIs(check, 'unavailable')) settleProof(check)
      if (!proofIs(check, 'ok')) refuse('AUMLOK_PEPPER_SECRET_MISMATCH', 503)
    }
    if (!Object.hasOwn(state, 'phraseFailures')) Object.assign(state, { phraseFailures: 0, phraseFailedAt: [], phraseNextAllowedAt: 0 })
    if (!Object.hasOwn(state, 'lastRotationChallengeId')) state.lastRotationChallengeId = null
    const auditPresent = Object.hasOwn(state, 'audit')
    let digest = auditPresent ? state.audit.prunedThroughHash : EMPTY_AUDIT_HASH
    for (const record of state.attempts) digest = await auditHash(digest, record)
    if (auditPresent) {
      if (digest !== state.audit.latestHash) refuse('AUMLOK_AUDIT_CORRUPT', 503)
    } else state.audit = { ...initialAudit(), totalRecords: state.attempts.length, latestHash: digest }
    if (!Object.hasOwn(state, 'enrollmentCount')) {
      state.enrollmentCount = state.binding === null ? 0 : 1
      state.enrollments = [] // Old bindings are not retroactively represented as audited enrollments.
    }
    for (const record of state.enrollments) {
      const { recordMac, ...payload } = record
      if (recordMac !== await mac(state, 'aukora.aumlok.enrollment.v1', canonicalJson(payload))) refuse('AUMLOK_AUDIT_CORRUPT', 503)
    }
    for (const approval of state.approvals) {
      if (approval.approvalId && approval.recordMac !== await approvalMac(state, approval, pepperSecret)) refuse('AUMLOK_APPROVAL_CORRUPT', 503)
    }
    for (const device of state.devices ?? []) {
      if (device.recordMac !== await mac(state, 'aukora.aumlok.device.v1', deviceMacPayload(device))) refuse('AUMLOK_AUDIT_CORRUPT', 503)
    }
    for (const invite of state.invites) storedSignature(await inviteReceiptOutcome(invite, state.binding.nodePubkeyHex))
    for (const revocation of state.revocations) {
      const { signature, ...payload } = revocation
      storedSignature(await nodeSignatureOutcome(state.binding.nodePubkeyHex, signature, revocationPreimage(payload), 'AUMLOK_INVITE_STATE_CORRUPT'))
    }
    return state
  }
  const write = async (tx, state) => {
    // Passkey devices: an approval's private fields (approvedBy, userHandle) leave with the approval once it has expired, so
    // after the last device is removed the next write stores only the shape the build before devices reads.
    const at = time()
    state.approvals = state.approvals.filter(approval => approval.expiresAt > at || (!Object.hasOwn(approval, 'approvedBy') && !Object.hasOwn(approval, 'userHandle')))
    // (approvedInstance travels only with approvedBy.)
    validateState(state)
    await tx.put(AUMLOK_STORAGE_KEY, state)
  }
  const trustedAccess = (value, at) => object(value) && ['owner', 'access'].includes(value.type)
    && typeof value.email === 'string' && /^[^\s@]{1,128}@[^\s@]{1,125}$/.test(value.email)
    && Number.isFinite(value.expires) && value.expires * 1000 > at
  const subject = async (state, transport, at) => trustedAccess(transport?.access, at)
    ? mac(state, 'aukora.aumlok.access.v2', transport.access.type + '\0' + transport.access.email.toLowerCase()) : null
  const budget = (state, at) => {
    if (state.failures >= AUMLOK_LIMITS.hardLockFailures) refuse('AUMLOK_GUARDIAN_QUORUM_REQUIRED', 403)
    if (state.failedAt.filter(value => value > at - 3600000).length >= AUMLOK_LIMITS.failuresPerHour || at < state.nextAllowedAt) refuse('AUMLOK_RATE_LIMITED', 429)
  }
  const phraseBudget = (state, at) => {
    if (state.phraseFailures >= AUMLOK_LIMITS.hardLockFailures) refuse('AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED', 403)
    if (state.phraseFailedAt.filter(value => value > at - 3600000).length >= AUMLOK_LIMITS.failuresPerHour || at < state.phraseNextAllowedAt) refuse('AUMLOK_PHRASE_RATE_LIMITED', 429)
  }
  const distinctOwnerKey = nodePubkeyHex => {
    if (!sha(ownerPublicKeyHex)) refuse('AUMLOK_OWNER_KEY_UNAVAILABLE', 503)
    if (nodePubkeyHex === ownerPublicKeyHex) refuse('NODE_KEY_IS_NOT_OWNER_KEY', 403)
  }
  const approvalFor = async (state, token, binding, origin, at) => {
    budget(state, at)
    distinctOwnerKey(state.binding?.nodePubkeyHex)
    if (state.binding) distinctCredentialKey(state.binding.credential, state.binding.nodePubkeyHex)
    if (!b64(token, 43) || isoBase64URL.toBuffer(token).length !== 32 || !actionValid(binding) || binding.audience !== origin) refuse('CLASS3_WEBAUTHN_REQUIRED', 403)
    const tokenHash = await hash(token), approval = state.approvals.find(value => value.tokenHash === tokenHash)
    const checkedAt = time()
    if (!approval || !state.binding || approval.consumedAt !== null || approval.expiresAt <= checkedAt || checkedAt < at
      || (approval.approvedAt !== undefined && approval.approvedAt > at)
      || approval.generation !== state.generation || approval.origin !== origin || !sameAction(approval.binding, binding)
      // An approval made by a device counts only while THAT enrolment instance is enrolled: a removal deletes it, and a
      // key enrolled again is a new instance, so an old approval can never come back to life.
      || (approval.approvedBy !== undefined && !(state.devices ?? []).some(device => device.credential.id === approval.approvedBy
        && device.instance === approval.approvedInstance))) refuse('CLASS3_WEBAUTHN_REQUIRED', 403)
    return approval
  }
  /** The audit's fixed-size name for a device credential (its id can be 342 characters; 256 records must stay small). */
  const auditCredential = async credentialId => (await hash('aukora.aumlok.audit-credential.v1\0' + credentialId)).slice(0, 16).toUpperCase()
  // `deviceCredential`: the enrolled DEVICE credential a verified sign-in or approval used (null: the primary, or none).
  // It is folded into the outcome (`VERIFIED_D_<16 HEX>`, within the old /^[A-Z0-9_]{1,80}$/), never a new record key:
  // the build before devices reads every audit row this build writes.
  // The audit row only: no budget moves here (proof-failure-rule.mjs countFailure is the only place one does).
  const attempt = async (state, at, purpose, code, transport, deviceCredential = null) => {
    if (state.audit.totalRecords === Number.MAX_SAFE_INTEGER) refuse('AUMLOK_AUDIT_SEQUENCE_EXHAUSTED', 507)
    const ip = typeof transport?.ip === 'string' && transport.ip.length <= 64 ? transport.ip : 'unknown'
    const record = { schema: 'aumlok.attempt.v1', sequence: state.audit.totalRecords + 1, at, purpose,
      outcome: deviceCredential === null ? code : `${code}_D_${await auditCredential(deviceCredential)}`,
      ipHash32: (await mac(state, 'aukora.aumlok.ip.v1', ip)).slice(0, 8) }
    state.audit.latestHash = await auditHash(state.audit.latestHash, record)
    state.audit.totalRecords++
    state.attempts.push(record)
    if (state.attempts.length > AUMLOK_LIMITS.attemptRecords) {
      const pruned = state.attempts.shift()
      state.audit.prunedThroughHash = await auditHash(state.audit.prunedThroughHash, pruned)
      state.audit.prunedRecords++
    }
  }
  // Return failures out of the transaction before throwing, so adapters commit counters.
  const run = async (purpose, transport, operation) => {
    let counted = null
    const outcome = await storage.transaction(async tx => {
      counted = null
      const state = await read(tx), at = time()
      let permitted = false, result, errorResult
      const before = structuredClone(state)
      // The operation names the device credential it verified (passkey devices), for the audit record of a success, and
      // the branded WRONG outcome its refusal stands for (`proven`), if a verifier judged a proof wrong.
      const note = { deviceCredential: null, proven: null }
      try {
        budget(state, at); permitted = true
        await initializePepper(state)
        result = await operation(state, at, note)
      } catch (error) {
        Object.assign(state, before)
        errorResult = resultError(error)
        note.proven = proofOf(error)
      }
      await initializePepper(state)
      const failureResult = errorResult ?? (result.ok === false ? result : null)
      const successCode = purpose === 'challenge' ? 'CHALLENGE_ISSUED' : result?.phase === 'PENDING_ASSERTION' ? 'REGISTERED' : 'VERIFIED'
      await attempt(state, at, purpose, failureResult?.code ?? successCode, transport, failureResult ? null : note.deviceCredential)
      // THE ONE RULE (proof-failure-rule.mjs): only a branded WRONG outcome moves a budget, through countFailure, and only
      // when it is the refusal being answered. Capacity, expiry, unknown/used/replaced challenges, malformed requests,
      // policy refusals and a verifier that reached no verdict carry none: refused, never counted.
      if (permitted && failureResult && note.proven !== null && note.proven.code === failureResult.code && note.proven.status === failureResult.status) {
        countFailure(note.proven, { kind: 'aumlok', state, at, limits: AUMLOK_LIMITS })
        counted = note.proven
      }
      await write(tx, state)
      return errorResult ? { error: errorResult } : { result }
    })
    // The counted outcome travels with the refusal by identity, so HEAD's gate counts exactly what was counted here.
    if (outcome.error) throw withProof(failure(outcome.error.code, outcome.error.status, capacityRetry(outcome.error)), counted)
    return withProof(outcome.result, counted)
  }
  /**
   * ONLY OUTSTANDING CEREMONIES HOLD A SLOT. The four records are the same four as ever (the array, its bound and every
   * record's shape are what the build before devices reads); a CONSUMED record stays only as a replay record until its own
   * expiry or until an outstanding ceremony needs its place, oldest consumed first. Single use stays exactly as strict: a
   * consumed record answers AUMLOK_CHALLENGE_USED, and once let go its id answers AUMLOK_CHALLENGE_UNKNOWN, while its 32
   * random challenge bytes match no other record, so no assertion made for it can complete anything. `keepId` (the
   * registration step being completed) is never let go. Next (job 9 review), an outstanding ceremony whose completion
   * reached no verdict (503) may be let go, oldest first, but only for a new ceremony of the SAME purpose asked by the SAME
   * signed-in subject (never a null subject): the asker has started over, and nobody else's ceremony is touched. Four
   * outstanding otherwise: AUMLOK_CHALLENGE_CAPACITY, with the seconds until the first of them expires.
   */
  const issue = async (state, input, origin, at, credential = null, accessSubject = null, transports = null, keepId = null) => {
    state.challenges = state.challenges.filter(value => value.expiresAt > at)
    if (state.challenges.length >= AUMLOK_LIMITS.challenges) {
      const spent = state.challenges.filter(value => value.consumedAt !== null && value.id !== keepId)
        .sort((a, b) => a.consumedAt - b.consumedAt || a.issuedAt - b.issuedAt)[0]
        ?? state.challenges.filter(value => value.consumedAt === null && value.id !== keepId && noVerdict.has(value.id) && accessSubject !== null
          && value.accessSubject === accessSubject && value.purpose === input.purpose).sort((a, b) => a.issuedAt - b.issuedAt)[0]
      if (spent === undefined) refuse('AUMLOK_CHALLENGE_CAPACITY', 429, { retryAfterSeconds: retryAfterSeconds(Math.min(...state.challenges.map(value => value.expiresAt)), at) })
      state.challenges = state.challenges.filter(value => value !== spent)
    }
    const recoveryCommitment = input.recoveryCommitment ?? await mac(state, 'aukora.aumlok.recovery.v2', input.commitmentSha256)
    const rootEscrow = input.rootEscrow ?? await sealRoot(state, rootFrom(input), input.nodePubkeyHex, recoveryCommitment, pepperSecret)
    const record = { id: random(), requestId: input.requestId, requestHash: await mac(state, 'aukora.aumlok.request.v2', canonicalJson(input)), intentHash: '',
      purpose: input.purpose, stage: credential ? 'assertion' : 'registration', challenge: random(), origin, rpId: new URL(origin).hostname,
      recoveryCommitment, rootEscrow, nodePubkeyHex: input.nodePubkeyHex, generation: state.generation,
      issuedAt: at, expiresAt: at + AUMLOK_LIMITS.challengeMs, consumedAt: null, outcome: null, completionHash: null, nextChallengeId: null, credential,
      invite: input.invite ?? null, revocation: input.revocation ?? null, binding: input.binding ?? null, accessSubject,
      ...(transports === null ? {} : { transports }) }
    record.intentHash = await hash(canonicalJson({ schema: 'aukora.aumlok.intent.v2', challengeId: record.id, challenge: record.challenge,
      purpose: record.purpose, origin, rpId: record.rpId, recoveryCommitment, rootEscrow, nodePubkeyHex: record.nodePubkeyHex,
      generation: record.generation, credentialId: credential?.id ?? null, expiresAt: record.expiresAt, invite: record.invite, revocation: record.revocation,
      binding: record.binding, accessSubject }))
    state.challenges.push(record)
    return record
  }
  // ── Owner sign-in: a stateless MAC'd challenge, the bound credential's UV assertion, a short server-side session ──
  const signinRecord = async tx => {
    const value = await tx.get(AUMLOK_SIGNIN_STORAGE_KEY)
    if (value === undefined) return { schema: 'aukora.aumlok.signin.v1', used: [], sessions: [] }
    if (!exact(value, ['schema', 'used', 'sessions']) || value.schema !== 'aukora.aumlok.signin.v1' || !Array.isArray(value.used) || !Array.isArray(value.sessions)
      || value.used.length > AUMLOK_SIGNIN_LIMITS.usedChallenges || value.sessions.length > AUMLOK_SIGNIN_LIMITS.sessions
      || value.used.some(item => !exact(item, ['nonceHash', 'expiresAt']) || !sha(item.nonceHash) || !timestamp(item.expiresAt))
      || value.sessions.some(item => !exact(item, Object.hasOwn(item ?? {}, 'device') ? ['tokenHash', 'createdAt', 'expiresAt', 'generation', 'device'] : ['tokenHash', 'createdAt', 'expiresAt', 'generation'])
        || (Object.hasOwn(item, 'device') && !b64(item.device, 2048)) || !sha(item.tokenHash)
        || !timestamp(item.createdAt) || !timestamp(item.expiresAt) || !Number.isSafeInteger(item.generation))) refuse('AUMLOK_SIGNIN_STATE_CORRUPT', 503)
    return structuredClone(value)
  }
  // The per-generation challenge key: derived from the pepper, never the pepper. The Worker holds it to mint and pre-check
  // challenges without asking HEAD; a re-bind (new generation) changes it.
  const issuanceKey = state => mac(state, AUMLOK_SIGNIN_ISSUANCE_DOMAIN, String(state.generation))
  const sessionKey = state => mac(state, AUMLOK_SESSION_DOMAIN, String(state.generation))
  const signinKey = async (input, origin) => {
    context(origin)
    if (!exact(input ?? {}, [])) refuse('AUMLOK_SIGNIN_INVALID')
    return storage.transaction(async tx => {
      const state = await read(tx)
      if (!state.binding || state['pepper.v1'] === null) refuse('AUMLOK_NOT_BOUND', 409)
      // The outstanding add code's lookup hash (never the code), so the Worker refuses every other code without a HEAD
      // call. It is named until HEAD ends the code, so its holder still hears "expired" rather than "unknown". An
      // unreadable pending record names none: sign-in never depends on it.
      // A code already used by a registration (a credential waiting to be confirmed) is named no more.
      const waiting = readDevicePending(await tx.get(PASSKEY_DEVICES_PENDING_KEY))?.pending ?? null
      const deviceCode = waiting !== null && waiting.joining === null ? waiting.lookup : null
      return { ok: true, schema: 'aukora.aumlok.signin-key.v1', generation: state.generation, rpId: new URL(origin).hostname,
        credentialId: state.binding.credential.id, publicKeyB64: state.binding.credential.publicKeyB64, issuanceKeyHex: await issuanceKey(state),
        sessionKeyHex: await sessionKey(state),
        // The transports each registration recorded, so a browser is told how to reach that passkey; absent when none were.
        ...(Object.hasOwn(state.binding, 'transports') ? { transports: state.binding.transports } : {}),
        // Enrolled devices' PUBLIC keys, named only when there are any (passkey-devices.mjs).
        ...(state.devices?.length ? { devices: state.devices.map(device => ({ id: device.credential.id, publicKeyB64: device.credential.publicKeyB64,
          ...(Object.hasOwn(device, 'transports') ? { transports: device.transports } : {}) })) } : {}),
        ...(deviceCode === null ? {} : { deviceCode }) }
    })
  }
  const signinChallenge = async (input, origin) => {
    context(origin)
    if (!exact(input ?? {}, [])) refuse('AUMLOK_SIGNIN_INVALID')
    return storage.transaction(async tx => {
      const state = await read(tx), at = time()
      if (!state.binding || state['pepper.v1'] === null) refuse('AUMLOK_NOT_BOUND', 409)
      const rpId = new URL(origin).hostname
      const payload = signinPayloadText({ nonce: random(), origin, generation: state.generation, credentialId: state.binding.credential.id, issuedAt: at })
      const expiresAt = at + AUMLOK_SIGNIN_LIMITS.challengeMs
      const challengeId = isoBase64URL.fromBuffer(encoder.encode(payload)) + '.' + await signinChallengeMac(await issuanceKey(state), payload)
      // Read only: nothing is stored for an issued challenge, so issuing them can fill nothing.
      return { ok: true, schema: 'aukora.aumlok.signin-challenge.v1', challengeId, expiresAt, publicKey: { challenge: await signinChallengeDigest(payload), rpId,
        allowCredentials: enrolledIds(state).map(credentialId => ({ type: 'public-key', id: credentialId })), userVerification: 'required', timeout: AUMLOK_SIGNIN_LIMITS.challengeMs } }
    })
  }
  const signin = async (input, origin, transport) => {
    context(origin)
    if (!exact(input, ['challengeId', 'credential']) || typeof input.challengeId !== 'string' || input.challengeId.length > AUMLOK_SIGNIN_CHALLENGE_MAX
      || !object(input.credential) || typeof input.credential.id !== 'string') refuse('AUMLOK_SIGNIN_INVALID')
    const [encoded, tag, extra] = input.challengeId.split('.')
    if (extra !== undefined || !b64(encoded, AUMLOK_SIGNIN_CHALLENGE_MAX) || !sha(tag)) refuse('AUMLOK_SIGNIN_CHALLENGE_INVALID', 403)
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(isoBase64URL.toBuffer(encoded)) } catch (_error) { refuse('AUMLOK_SIGNIN_CHALLENGE_INVALID', 403) }
    // A failure throws inside the transaction, so nothing is written and no owner counter moves.
    return storage.transaction(async tx => {
      const state = await read(tx), at = time()
      if (!state.binding || state['pepper.v1'] === null) refuse('AUMLOK_NOT_BOUND', 409)
      const key = await crypto.subtle.importKey('raw', Uint8Array.from((await issuanceKey(state)).match(/../g), byte => parseInt(byte, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
      // Sign-in moves no budget; its checks still have the same three outcomes: a wrong MAC or proof is
      // 403, a verifier that reached no verdict is 503 (the owner tries again), never "wrong".
      settleProof(await proofOutcome(() => crypto.subtle.verify('HMAC', key, Uint8Array.from(tag.match(/../g), byte => parseInt(byte, 16)), encoder.encode(text)),
        { code: 'AUMLOK_SIGNIN_CHALLENGE_INVALID' }))
      // HEAD judges every field and the lifetime itself, whatever the Worker already checked.
      const checked = signinPayloadCheck(text, { origin, generation: state.generation, credentialId: state.binding.credential.id, now: at })
      if (!checked.payload) refuse(checked.code, checked.status)
      const payload = checked.payload
      const ceremony = await signinChallengeDigest(text)
      const record = await signinRecord(tx)
      record.used = record.used.filter(item => item.expiresAt > at)
      // SINGLE USE BY THE CEREMONY, NEVER BY THE COUNTER (a platform passkey's counter stays 0): the digest is kept until
      // the payload's own expiry, after which the same assertion can match no live challenge, because the expiry is signed.
      const nonceHash = await hash(ceremony)
      if (record.used.some(item => item.nonceHash === nonceHash)) refuse('AUMLOK_SIGNIN_CHALLENGE_USED', 409)
      if (record.used.length >= AUMLOK_SIGNIN_LIMITS.usedChallenges) refuse('AUMLOK_SIGNIN_BUSY', 429)
      // Any enrolled credential: the primary, or a device (passkey-devices.mjs). The payload still names the binding's
      // credential and generation; the credential actually used is kept on the session and moves its own counter.
      const credential = enrolledCredential(state, input.credential.id)
      if (credential === null) refuse('AUMLOK_SIGNIN_PROOF_INVALID', 403)
      const device = credential.id !== state.binding.credential.id
      // Bytes that are not an assertion of this credential's algorithm are malformed (400), never handed to the verifier.
      if (!signinAssertionShape(input.credential, credential.publicKeyB64)) refuse('AUMLOK_SIGNIN_INVALID')
      // THE SCREEN: a policy mismatch, or a counter not past the stored one, is 403 (sign-in moves no budget anyway)
      // and is never handed to the verifier; only then the check, whose throw is 503 (the owner tries again).
      const screened = await screenAssertion(input.credential, { challenge: ceremony, origin, rpId: payload.rpId, stored: credential })
      if (!screened.pass) screenRefuse(screened.refusal, { code: 'AUMLOK_SIGNIN_PROOF_INVALID', malformed: 'AUMLOK_SIGNIN_INVALID', credential: 403 })
      if (screened.stale) refuse('AUMLOK_SIGNIN_PROOF_INVALID', 403)
      const verified = settleProof(await proofOutcome(() => verifyAuthenticationResponse({ response: input.credential, expectedChallenge: ceremony, expectedOrigin: origin,
        expectedRPID: payload.rpId, expectedType: 'webauthn.get', requireUserVerification: true,
        credential: { id: credential.id, publicKey: isoBase64URL.toBuffer(credential.publicKeyB64), counter: credential.counter } }),
      { code: 'AUMLOK_SIGNIN_PROOF_INVALID', judge: 'webauthn-authentication' }))
      const updated = { ...credential, counter: verified.authenticationInfo.newCounter }
      if (!credentialValid(updated)) refuse('AUMLOK_SIGNIN_PROOF_INVALID', 403)
      // The counter rule of every other ceremony: the verified counter is kept. Lockout counters are left as they are.
      if (device) touchDevice(state, updated, at)
      else state.binding = { ...state.binding, credential: updated, lastVerifiedAt: at }
      await attempt(state, at, device ? 'signin-device' : 'signin', 'VERIFIED', transport, device ? credential.id : null)
      await write(tx, state)
      const expiresAt = at + AUMLOK_SIGNIN_LIMITS.sessionMs
      const envelope = random() + '.' + String(expiresAt) + '.' + String(state.generation)
      const token = envelope + '.' + await signinChallengeMac(await sessionKey(state), AUMLOK_SESSION_DOMAIN + '\0' + envelope)
      record.used.push({ nonceHash, expiresAt: payload.expiresAt })
      record.sessions = [...record.sessions.filter(item => item.expiresAt > at && item.generation === state.generation),
        { tokenHash: await hash(token), createdAt: at, expiresAt, generation: state.generation, ...(device ? { device: credential.id } : {}) }].slice(-AUMLOK_SIGNIN_LIMITS.sessions)
      await tx.put(AUMLOK_SIGNIN_STORAGE_KEY, record)
      return { ok: true, schema: 'aukora.aumlok.signin.v1', sessionToken: token, expiresAt }
    })
  }
  const sessionCall = async (purpose, input, origin) => {
    context(origin)
    const parts = exact(input, ['token']) ? sessionTokenParts(input.token) : null
    if (parts === null) refuse('AUMLOK_SESSION_INVALID', 403)
    const tokenHash = await hash(input.token)
    return storage.transaction(async tx => {
      const state = await read(tx), at = time(), record = await signinRecord(tx)
      // HEAD checks the envelope too: a token it did not sign is never looked up, whatever the Worker decided.
      const authentic = state['pepper.v1'] !== null && await sessionTokenAuthentic(await sessionKey(state), parts)
      // Sign-out of a token this generation never signed: nothing exists to end.
      if (!authentic && purpose === 'signout') return { ok: true, signedOut: false }
      if (!authentic) refuse('AUMLOK_SESSION_INVALID', 403)
      const found = record.sessions.find(item => item.tokenHash === tokenHash)
      if (purpose === 'signout') {
        if (found) {
          record.sessions = record.sessions.filter(item => item !== found)
          await tx.put(AUMLOK_SIGNIN_STORAGE_KEY, record)
        }
        return { ok: true, signedOut: Boolean(found) }
      }
      // A re-bind or rotation (new generation) ends every session made before it.
      if (!found || found.expiresAt <= at || !state.binding || found.generation !== state.generation) refuse('AUMLOK_SESSION_INVALID', 403)
      // A session made by a device ends when that device is removed.
      if (found.device !== undefined && !(state.devices ?? []).some(item => item.credential.id === found.device)) refuse('AUMLOK_SESSION_INVALID', 403)
      return { ok: true, expiresAt: found.expiresAt }
    })
  }
  // ── Passkey devices (passkey-devices.mjs): owner actions under Class 3, and the code-bearing door ──
  const pendingRead = async tx => {
    const value = readDevicePending(await tx.get(PASSKEY_DEVICES_PENDING_KEY))
    if (value === null) refuse('AUMLOK_DEVICE_STATE_CORRUPT', 503)
    return value
  }
  /** Is the credential that approved this code still enrolled, as the SAME enrolment instance? */
  const codeApproverEnrolled = (state, pending) => pending.approvedInstance === null ? pending.approvedBy === state.binding.credential.id
    : (state.devices ?? []).some(device => device.credential.id === pending.approvedBy && device.instance === pending.approvedInstance)
  /**
   * One key, one credential: the new key (by its canonical bytes) must differ from the primary's and every device's, so
   * no two credential ids can speak for one key (attribution, and "a device cannot approve its own removal").
   * @returns {Promise<string>} The new key's hash.
   */
  const distinctEnrolledKey = async (state, credential) => {
    const keyHash = await credentialKeyHash(credential.publicKeyB64)
    for (const enrolled of [state.binding.credential, ...(state.devices ?? []).map(device => device.credential)]) {
      if (await credentialKeyHash(enrolled.publicKeyB64) === keyHash) refuse('AUMLOK_DEVICE_KEY_ALREADY_ENROLLED', 409)
    }
    return keyHash
  }
  /** The challenge a registration answer names (its client data's), or null when it names none readably. */
  const namedChallenge = credential => {
    const text = object(credential) && object(credential.response) ? credential.response.clientDataJSON : undefined
    if (!b64(text, 8192)) return null
    try {
      const data = decodeClientDataJSON(text)
      return object(data) && b64(data.challenge, 43) ? data.challenge : null
    } catch (_error) { return null }
  }
  /** A lapsed registration challenge's stored name: a domain-separated SHA-256 (the challenge itself is not kept). */
  const lapsedChallengeHash = challenge => hash('aukora.aumlok.device-challenge-lapsed.v1\0' + challenge)
  /** The joining credential still waiting for this generation, or null. */
  const joiningOf = (state, record, at) => record.pending !== null && record.pending.joining !== null && record.pending.generation === state.generation
    && record.pending.joining.expiresAt > at ? record.pending.joining : null
  /**
   * A JOINING ENDS (declined, confirmed, replaced after its expiry, or its code's maker removed): every OUTSTANDING
   * approval of its exact confirm body (which names its joining instance) is deleted in the same transaction. The
   * instance already makes such an approval useless for any other joining; this leaves none behind at all.
   * @param {object} state aumlok:v1, changed in place (the caller writes it).
   * @param {object|null} pending The pending record whose joining ends.
   */
  const endJoiningApprovals = async (state, pending) => {
    const joining = pending?.joining ?? null
    if (joining === null) return
    const bodySha256 = await hash(canonicalJson({ action: PASSKEY_DEVICE_CONFIRM_ACTION, deviceId: joining.credential.id, keyHash: joining.keyHash,
      instance: joining.instance, generation: pending.generation }))
    state.approvals = state.approvals.filter(item => item.consumedAt !== null || item.binding.schema !== 'aukora.class3.action.v1'
      || item.binding.pathname !== PASSKEY_DEVICE_ROUTES.confirm || item.binding.bodySha256 !== bodySha256)
  }
  const deviceOwnerCall = async (action, input, origin, transport) => {
    context(origin)
    rejectAumlokRawSecrets(input)
    if (action === 'devices') {
      if (!exact(input ?? {}, [])) refuse('AUMLOK_DEVICE_REQUEST_INVALID')
      return storage.transaction(async tx => {
        const state = await read(tx), record = await pendingRead(tx), at = time()
        if (!state.binding) refuse('AUMLOK_NOT_BOUND', 409)
        const joining = joiningOf(state, record, at)
        return { ok: true, schema: 'aukora.aumlok.devices.v1', generation: state.generation, hostNow: at, limit: PASSKEY_DEVICE_LIMITS.devices,
          primary: { id: state.binding.credential.id, boundAt: state.binding.boundAt, lastVerifiedAt: state.binding.lastVerifiedAt },
          devices: (state.devices ?? []).map(device => ({ id: device.credential.id, label: device.label, addedAt: device.addedAt, lastVerifiedAt: device.lastVerifiedAt })),
          pending: record.pending !== null && record.pending.joining === null && record.pending.expiresAt > at && record.pending.generation === state.generation
            ? { label: record.pending.label, expiresAt: record.pending.expiresAt } : null,
          // A new device asks to join: the owner confirms THIS key (its hash, and the phrase the new device shows).
          // `instance` names THIS joining: the confirm and the decline carry it back, so they can act on no other.
          joining: joining === null ? null : { id: joining.credential.id, label: record.pending.label, keyHash: joining.keyHash, instance: joining.instance,
            phrase: deviceKeyPhrase(joining.keyHash), registeredAt: joining.registeredAt, expiresAt: joining.expiresAt } }
      })
    }
    if (action === 'device-decline') {
      // A decline needs the owner's session only: it deletes a credential that was never enrolled, nothing else. It names
      // the joining instance, so a decline sent for one joining never turns away a later one.
      if (!exact(input, ['action', 'deviceId', 'instance', 'generation']) || input.action !== PASSKEY_DEVICE_DECLINE_ACTION || !b64(input.deviceId, 2048)
        || !deviceInstanceValid(input.instance) || !Number.isSafeInteger(input.generation)) refuse('AUMLOK_DEVICE_REQUEST_INVALID')
      return storage.transaction(async tx => {
        const state = await read(tx), record = await pendingRead(tx), at = time()
        if (!state.binding) refuse('AUMLOK_NOT_BOUND', 409)
        if (input.generation !== state.generation) refuse('AUMLOK_DEVICE_GENERATION_STALE', 409)
        if (record.pending?.joining?.credential.id !== input.deviceId || record.pending.joining.instance !== input.instance) refuse('AUMLOK_DEVICE_JOIN_NOT_FOUND', 404)
        // Its outstanding confirm approvals end with it.
        await endJoiningApprovals(state, record.pending)
        record.pending = null
        await tx.put(PASSKEY_DEVICES_PENDING_KEY, record)
        await attempt(state, at, 'device-decline', 'VERIFIED', transport)
        await write(tx, state)
        return { ok: true, schema: 'aukora.aumlok.device-declined.v1', deviceId: input.deviceId }
      })
    }
    const kind = action === 'device-code' ? 'code' : action === 'device-confirm' ? 'confirm' : 'remove'
    if (kind === 'code' ? !exact(input, ['action', 'label', 'expiresAt', 'generation']) || input.action !== PASSKEY_DEVICE_ADD_ACTION || !deviceLabelValid(input.label)
      || !timestamp(input.expiresAt) || !Number.isSafeInteger(input.generation)
      : kind === 'confirm' ? !exact(input, ['action', 'deviceId', 'keyHash', 'instance', 'generation']) || input.action !== PASSKEY_DEVICE_CONFIRM_ACTION || !b64(input.deviceId, 2048)
        || !sha(input.keyHash) || !deviceInstanceValid(input.instance) || !Number.isSafeInteger(input.generation)
        : !exact(input, ['action', 'deviceId', 'generation']) || input.action !== PASSKEY_DEVICE_REMOVE_ACTION || !b64(input.deviceId, 2048)
          || !Number.isSafeInteger(input.generation)) refuse('AUMLOK_DEVICE_REQUEST_INVALID')
    // Class 3 over the exact body: action, label, device or key (and the joining instance), expiry and identity generation.
    const binding = await aumlokClass3Binding({ audience: origin, method: 'POST', pathname: PASSKEY_DEVICE_ROUTES[kind], body: input })
    // Any refusal below throws inside the transaction: nothing is written and the approval is not spent.
    return storage.transaction(async tx => {
      const state = await read(tx), record = await pendingRead(tx), at = time()
      if (!state.binding) refuse('AUMLOK_NOT_BOUND', 409)
      if (input.generation !== state.generation) refuse('AUMLOK_DEVICE_GENERATION_STALE', 409)
      const devices = state.devices ?? []
      let joining = null
      if (kind === 'code') {
        if (devices.length >= PASSKEY_DEVICE_LIMITS.devices) refuse('AUMLOK_DEVICE_CAPACITY', 507)
        if (input.expiresAt <= at + 60000 || input.expiresAt > at + PASSKEY_DEVICE_LIMITS.codeMs + PASSKEY_DEVICE_LIMITS.skewMs) refuse('AUMLOK_DEVICE_EXPIRY_INVALID')
        // A new device asking to join is confirmed or declined first: a new code never silently turns it away (and the
        // approval is not spent). A code nobody has used yet is still replaced, as the portal says.
        if (joiningOf(state, record, at) !== null) refuse('AUMLOK_DEVICE_JOIN_WAITING', 409)
      } else if (kind === 'confirm') {
        joining = joiningOf(state, record, at)
        // THIS joining, by its instance: an approval made for an earlier joining (declined or expired, then the same id and
        // key registered again under a new code) names another instance and confirms nothing.
        if (joining === null || joining.credential.id !== input.deviceId || joining.keyHash !== input.keyHash || joining.instance !== input.instance) refuse('AUMLOK_DEVICE_JOIN_NOT_FOUND', 404)
        // The code's maker must still be enrolled as the same instance (a removal also ends its code atomically).
        if (!codeApproverEnrolled(state, record.pending)) refuse('AUMLOK_DEVICE_CODE_REVOKED', 409)
        if (devices.length >= PASSKEY_DEVICE_LIMITS.devices) refuse('AUMLOK_DEVICE_CAPACITY', 507)
        if (enrolledIds(state).includes(joining.credential.id)) refuse('AUMLOK_DEVICE_ALREADY_ENROLLED', 409)
        if (await distinctEnrolledKey(state, joining.credential) !== joining.keyHash) refuse('AUMLOK_DEVICE_STATE_CORRUPT', 503)
      } else {
        if (input.deviceId === state.binding.credential.id) refuse('AUMLOK_DEVICE_PRIMARY_NOT_REMOVABLE', 403)
        if (!devices.some(device => device.credential.id === input.deviceId)) refuse('AUMLOK_DEVICE_NOT_FOUND', 404)
      }
      const approval = await approvalFor(state, transport?.approval, binding, origin, at)
      // A device is removed by the primary or by a DIFFERENT enrolled device, never by itself.
      if (kind === 'remove' && approval.approvedBy === input.deviceId) refuse('AUMLOK_DEVICE_REMOVE_NEEDS_OTHER_PASSKEY', 403)
      approval.consumedAt = at
      const approver = approval.approvedBy ?? null
      let result
      if (kind === 'code') {
        const fresh = await newDeviceCode()
        // A joining this code replaces has expired (a live one refused above): its outstanding confirm approvals end here.
        await endJoiningApprovals(state, record.pending)
        // The binding's user handle, as the approving authenticator returned it; without one the new passkey gets its own.
        const userHandle = approval.userHandle ?? random()
        record.pending = { lookup: fresh.lookup, codeHash: fresh.codeHash, label: input.label, userHandle, approvedBy: approver ?? state.binding.credential.id,
          approvedInstance: approval.approvedInstance ?? null, generation: state.generation, issuedAt: at, expiresAt: Math.min(input.expiresAt, at + PASSKEY_DEVICE_LIMITS.codeMs),
          misses: 0, challenge: null, challengeExpiresAt: null, challengesIssued: 0, joining: null }
        await attempt(state, at, 'device-code', 'VERIFIED', transport, approver)
        await write(tx, state)
        await tx.put(PASSKEY_DEVICES_PENDING_KEY, record)
        result = { ok: true, schema: 'aukora.aumlok.device-code.v1', code: fresh.code, link: deviceLink(origin, fresh.code),
          label: input.label, expiresAt: record.pending.expiresAt, sameUserHandle: approval.userHandle !== undefined }
      } else if (kind === 'confirm') {
        // The owner approved THIS key: only now is it enrolled, as a new enrolment instance.
        const device = { schema: PASSKEY_DEVICE_RECORD_SCHEMA, credential: joining.credential, label: record.pending.label, addedAt: at, lastVerifiedAt: at,
          approvedBy: approver ?? state.binding.credential.id, instance: random(), recordMac: '', ...(joining.transports === null ? {} : { transports: joining.transports }) }
        device.recordMac = await mac(state, 'aukora.aumlok.device.v1', deviceMacPayload(device))
        state.devices = [...devices, device]
        // Any other approval of this same confirm (a second tab's) ends with the joining; the one used here stays, spent.
        await endJoiningApprovals(state, record.pending)
        await attempt(state, at, 'device-add', 'VERIFIED', transport, approver)
        await write(tx, state)
        record.pending = null
        await tx.put(PASSKEY_DEVICES_PENDING_KEY, record)
        result = { ok: true, schema: 'aukora.aumlok.device-added.v1', deviceId: device.credential.id, label: device.label, deviceCount: state.devices.length }
      } else {
        state.devices = devices.filter(device => device.credential.id !== input.deviceId)
        // Its outstanding approvals go with it, for good (a key enrolled again is a new instance and never revives them).
        state.approvals = state.approvals.filter(item => item.approvedBy !== input.deviceId)
        // The last removal leaves no `devices` key at all, the shape the build before devices reads.
        const deviceCount = state.devices.length
        if (deviceCount === 0) delete state.devices
        // A code that device made (waiting, or already used by a joining credential) ends in the same transaction, and so
        // do the outstanding confirm approvals of its joining.
        const endsCode = record.pending !== null && record.pending.approvedBy === input.deviceId
        if (endsCode) await endJoiningApprovals(state, record.pending)
        await attempt(state, at, 'device-remove', 'VERIFIED', transport, approver)
        await write(tx, state)
        if (endsCode) {
          record.pending = null
          await tx.put(PASSKEY_DEVICES_PENDING_KEY, record)
        }
        // Every session that device made ends now.
        const signins = await signinRecord(tx), kept = signins.sessions.filter(item => item.device !== input.deviceId)
        if (kept.length !== signins.sessions.length) await tx.put(AUMLOK_SIGNIN_STORAGE_KEY, { ...signins, sessions: kept })
        result = { ok: true, schema: 'aukora.aumlok.device-removed.v1', deviceId: input.deviceId, deviceCount }
      }
      const completedAt = time()
      if (completedAt < at || completedAt >= approval.expiresAt || (joining !== null && completedAt >= joining.expiresAt)) refuse('CLASS3_WEBAUTHN_REQUIRED', 403)
      return result
    })
  }
  /**
   * THE CODE-BEARING DOOR (no session). The pending record is found by the code's first 66 bits BEFORE anything else is
   * read: an unknown code writes nothing. A code's MISS COUNT IS A BUDGET: it moves only through countFailure, for
   * a branded WRONG outcome: the code's remainder checked and wrong, or a registration the verifier judged wrong. Nothing
   * else counts: not a missing, unknown or lapsed challenge, not a malformed registration, not an unsupported
   * authenticator, not a policy refusal (already enrolled, too large, the node's own key), not a verifier that reached no
   * verdict. The fifth miss burns the code. A good registration ENROLS NOTHING: the credential waits, as joining, for an
   * enrolled device to confirm its exact key (deviceOwnerCall 'device-confirm'), and the code is spent.
   * Nothing here moves an owner lockout counter.
   */
  const deviceDoorCall = async (action, input, origin, transport) => {
    context(origin)
    const adding = action === 'device-add'
    if (!exact(input, adding ? ['code', 'credential'] : ['code']) || !deviceCodeShape(input.code) || (adding && !object(input.credential))) refuse('AUMLOK_DEVICE_REQUEST_INVALID')
    if (adding) rejectAumlokRawSecrets(input.credential)
    const { lookup, codeHash } = await deviceCodeHashes(input.code)
    // Counted refusals leave the transaction as values, so the miss is committed before the refusal is thrown.
    const outcome = await storage.transaction(async tx => {
      const record = await pendingRead(tx), pending = record.pending, at = time()
      // A code already used by a registration is spent: at most one joining credential per code.
      if (pending === null || pending.lookup !== lookup || pending.joining !== null) return { error: failure('AUMLOK_DEVICE_CODE_INVALID', 403) }
      const end = async (code, status) => { record.pending = null; await tx.put(PASSKEY_DEVICES_PENDING_KEY, record); return { error: failure(code, status) } }
      // A MISS: only a branded WRONG outcome (countFailure throws for anything else).
      const miss = async wrong => {
        if (countFailure(wrong, { kind: 'device-code', pending }) >= PASSKEY_DEVICE_LIMITS.codeMisses) return end('AUMLOK_DEVICE_CODE_BURNED', 403)
        await tx.put(PASSKEY_DEVICES_PENDING_KEY, record)
        return { error: failure(wrong.code, wrong.status) }
      }
      if (pending.expiresAt <= at) return end('AUMLOK_DEVICE_CODE_EXPIRED', 409)
      // The code's remainder IS the proof here: its hash is compared to the stored one (both SHA-256 of a 256-bit code).
      const remainder = await proofOutcome(async () => pending.codeHash === codeHash, { code: 'AUMLOK_DEVICE_CODE_INVALID' })
      if (proofIs(remainder, 'wrong')) return miss(remainder)
      if (!proofIs(remainder, 'ok')) return { error: failure(remainder.code, remainder.status) }
      const state = await read(tx)
      // A re-bind or rotation since the code was made ends it.
      if (!state.binding || state.generation !== pending.generation) return end('AUMLOK_DEVICE_CODE_EXPIRED', 409)
      // So does the removal of the device that made it (the removal also ends it in its own transaction).
      if (!codeApproverEnrolled(state, pending)) return end('AUMLOK_DEVICE_CODE_REVOKED', 409)
      if ((state.devices ?? []).length >= PASSKEY_DEVICE_LIMITS.devices) return { error: failure('AUMLOK_DEVICE_CAPACITY', 507) }
      const rpId = new URL(origin).hostname
      if (!adding) {
        // The browser's timeout is what is LEFT of the challenge, never more: it cannot be told to wait past the node's deadline
        // (and never more than two minutes, even if this clock went back since the challenge was issued).
        const options = () => ({ result: { ok: true, schema: 'aukora.aumlok.device-registration.v1', label: pending.label, expiresAt: pending.challengeExpiresAt,
          publicKey: deviceRegistrationOptions({ challenge: pending.challenge, rpId, userHandle: pending.userHandle, label: pending.label, excludeIds: enrolledIds(state),
            timeout: Math.min(pending.challengeExpiresAt - at, PASSKEY_DEVICE_LIMITS.registrationMs) }) } })
        // A LIVE CHALLENGE IS HANDED OUT AGAIN, NEVER REPLACED, until it actually expires (and nothing is written): asking
        // again never invalidates a registration already in flight on the owner's new device, however little is left of it.
        if (pending.challenge !== null && pending.challengeExpiresAt > at) return options()
        // A new one only when there is none (never issued, or used by a registration) or it has expired; a code gets a
        // bounded number in its life. The request past the bound ends the code, with ONE audit entry (the code is gone, so
        // no later request reaches here).
        if (pending.challengesIssued >= PASSKEY_DEVICE_LIMITS.codeChallenges) {
          await attempt(state, at, 'device-challenge', 'CHALLENGE_LIMIT', transport)
          await write(tx, state)
          return end('AUMLOK_DEVICE_CODE_BURNED', 403)
        }
        // A challenge that LAPSED unused is remembered by its hash (at most one per issued challenge, so at most
        // `codeChallenges`), so a late answer to it is told it ran out of time instead of costing a miss.
        if (pending.challenge !== null) pending.lapsed = [...(pending.lapsed ?? []), await lapsedChallengeHash(pending.challenge)]
        pending.challenge = random()
        pending.challengeExpiresAt = Math.min(at + PASSKEY_DEVICE_LIMITS.registrationMs, pending.expiresAt)
        pending.challengesIssued++
        await tx.put(PASSKEY_DEVICES_PENDING_KEY, record)
        return options()
      }
      // THE CHALLENGE THE ANSWER NAMES IS READ FIRST: an answer to any other challenge is refused BEFORE the current one is
      // touched, so a late answer can never destroy the challenge a renewed attempt is using.
      const named = namedChallenge(input.credential)
      if (pending.challenge === null || named !== pending.challenge) {
        // An answer to an EARLIER challenge of this code that lapsed unused ran out of time: refused, no miss, nothing
        // written, the current challenge kept.
        if (named !== null && (pending.lapsed ?? []).includes(await lapsedChallengeHash(named))) return { error: failure('AUMLOK_DEVICE_CHALLENGE_EXPIRED', 409) }
        // No challenge outstanding, or one this code never issued (or one a registration already used): no proof was checked
        // (an unknown or used challenge never counts). Refused, nothing written, the current challenge kept.
        if (pending.challenge === null) return { error: failure('AUMLOK_DEVICE_CHALLENGE_REQUIRED', 409) }
        return { error: failure('AUMLOK_DEVICE_CHALLENGE_UNKNOWN', 409) }
      }
      // A registration that arrives after its challenge expired RAN OUT OF TIME: refused, but never counted as a miss, and
      // nothing is written (the expired challenge stays until the next request renews it). Only a holder of the whole
      // code reaches here.
      if (pending.challengeExpiresAt <= at) return { error: failure('AUMLOK_DEVICE_CHALLENGE_EXPIRED', 409) }
      const challenge = pending.challenge, challengeExpiresAt = pending.challengeExpiresAt
      let credential, keyHash, judged = null
      // The catch only keeps the refusal (the scan's rule (c): no catch counts); it is judged below.
      try {
        credential = await verifiedRegistration(input.credential, { challenge, origin, rpId, nodePubkeyHex: state.binding.nodePubkeyHex })
      } catch (error) { judged = error }
      if (judged !== null) {
        const wrong = proofOf(judged)
        // THE VERIFIER JUDGED IT WRONG (a strict `verified: false`): the challenge is used (single use), the code takes a miss.
        if (wrong !== null) {
          pending.challenge = null
          pending.challengeExpiresAt = null
          return miss(wrong)
        }
        // Malformed bytes, an unsupported authenticator, a SCREENED policy mismatch (a wrong origin, RP id, type or
        // flag, 403, no verifier ran), the node's own key, or no verdict at all (a verifier that threw or answered something
        // else): refused as it is, NOTHING written, no miss, and the outstanding challenge kept, so a retry needs no new
        // challenge (a transient failure never uses up the code's challenge issuance either).
        const refused = resultError(judged)
        return { error: failure(refused.code, refused.status) }
      }
      // A verified registration uses its challenge, whatever follows (single use).
      pending.challenge = null
      pending.challengeExpiresAt = null
      try {
        // A device credential id is held to 256 bytes, so four devices can never crowd the owner's private state.
        if (credential.id.length > PASSKEY_DEVICE_LIMITS.credentialIdChars) refuse('AUMLOK_DEVICE_CREDENTIAL_TOO_LARGE', 400)
        if (enrolledIds(state).includes(credential.id)) refuse('AUMLOK_DEVICE_ALREADY_ENROLLED', 409)
        keyHash = await distinctEnrolledKey(state, credential)
      } catch (error) {
        // A policy refusal of a GENUINE registration: no proof was wrong, so no miss; its challenge is used.
        const refused = resultError(error)
        if (refused.status < 500) await tx.put(PASSKEY_DEVICES_PENDING_KEY, record)
        return { error: failure(refused.code, refused.status) }
      }
      // THE DEADLINES AGAIN, just before the commit: verification takes time, and a clock that went back is refused.
      const committedAt = time()
      if (committedAt < at || committedAt >= challengeExpiresAt || committedAt >= pending.expiresAt) return end('AUMLOK_DEVICE_CODE_EXPIRED', 409)
      // A fresh JOINING INSTANCE: the confirm and the decline must name it, so nothing made for another joining acts on this one.
      pending.joining = { credential, keyHash, instance: random(), transports: registrationTransports(input.credential), registeredAt: committedAt,
        expiresAt: committedAt + PASSKEY_DEVICE_LIMITS.joinMs }
      await attempt(state, committedAt, 'device-join', 'REGISTERED', transport)
      await write(tx, state)
      await tx.put(PASSKEY_DEVICES_PENDING_KEY, record)
      // THE DEADLINES ONCE MORE, AFTER THE AWAITED WRITES (as the confirm's final check): time that passed, or a clock that
      // went back, while they ran throws, and the whole transaction rolls back: nothing joins.
      const writtenAt = time()
      if (writtenAt < committedAt || writtenAt >= challengeExpiresAt || writtenAt >= pending.expiresAt) refuse('AUMLOK_DEVICE_CODE_EXPIRED', 409)
      return { result: { ok: true, schema: 'aukora.aumlok.device-joining.v1', deviceId: credential.id, label: pending.label,
        phrase: deviceKeyPhrase(keyHash), expiresAt: pending.joining.expiresAt } }
    })
    if (outcome.error) refuse(outcome.error.code, outcome.error.status)
    return outcome.result
  }
  return Object.freeze({
    status: () => storage.transaction(async tx => publicStatus(await read(tx), time(), available, ownerPublicKeyHex, pepperSecret)),
    /**
     * Passkey devices (passkey-devices.mjs). `devices`, `device-code` and `device-remove` are owner actions (the host
     * checks verified owner access; the latter two also consume a Class 3 approval passed as transport.approval);
     * `device-add-challenge` and `device-add` are the code-bearing door.
     */
    devices: async (action, input, origin, transport) => {
      if (!PASSKEY_DEVICE_ACTIONS.includes(action)) refuse('AUMLOK_ROUTE_NOT_FOUND', 404)
      return ['device-add-challenge', 'device-add'].includes(action) ? deviceDoorCall(action, input, origin, transport) : deviceOwnerCall(action, input, origin, transport)
    },
    // Public signed records only. Local durable state is not an independent freshness witness.
    invites: () => storage.transaction(async tx => {
      const state = await read(tx)
      return { ok: true, schema: 'aukora.invite-list.v1', invites: state.invites, revocations: state.revocations,
        lifetimeIssuedCount: state.invites.length }
    }),
    // Read-only bearer-possession check; never consumes an invite or grants any authority.
    redeem: async (input, origin) => {
      context(origin)
      if (!exact(input, ['invite', 'code']) || !inviteValid(input.invite) || !b64(input.code, 43)
        || isoBase64URL.toBuffer(input.code).length !== 32) refuse('AUMLOK_INVITE_REDEEM_INVALID')
      return storage.transaction(async tx => {
        const state = await read(tx), at = time(), binding = state.binding
        if (!binding || input.invite.sponsorPubkeyHex !== binding.nodePubkeyHex) refuse('AUMLOK_INVITE_SPONSOR_UNTRUSTED', 403)
        const receipt = state.invites.find(value => value.inviteId === input.invite.inviteId)
        if (!receipt || canonicalJson(receipt) !== canonicalJson(input.invite)) refuse('AUMLOK_INVITE_NOT_FOUND', 404)
        if (state.revocations.some(value => value.inviteId === receipt.inviteId)) refuse('AUMLOK_INVITE_REVOKED', 409)
        if (at < receipt.issuedAt || at >= receipt.expiresAt) refuse('AUMLOK_INVITE_EXPIRED', 403)
        const code = isoBase64URL.toBuffer(input.code), domain = encoder.encode(INVITEE_COMMITMENT_DOMAIN)
        const preimage = new Uint8Array(domain.length + code.length)
        preimage.set(domain); preimage.set(code, domain.length)
        try {
          const commitment = await crypto.subtle.digest('SHA-256', preimage)
          const expected = Uint8Array.from(receipt.inviteeCommitmentSha256.match(/../g), byte => parseInt(byte, 16))
          // WebCrypto HMAC verification compares fixed-size values without a secret-dependent JS comparison.
          const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'])
          const tag = await crypto.subtle.sign('HMAC', key, expected)
          // A bearer check, no budget; its three outcomes still hold (a verifier with no verdict is 503, never "wrong").
          settleProof(await proofOutcome(() => crypto.subtle.verify('HMAC', key, tag, commitment), { code: 'AUMLOK_INVITE_CODE_INVALID' }))
        } finally { code.fill(0); preimage.fill(0) }
        const checkedAt = time()
        if (checkedAt < at || checkedAt >= receipt.expiresAt) refuse('AUMLOK_INVITE_EXPIRED', 403)
        return { ok: true, schema: 'aukora.invite-verification.v1', inviteId: receipt.inviteId,
          sponsorPubkeyHex: binding.nodePubkeyHex, recipientStatus: 'CODE_VERIFIED', verifiedAt: checkedAt,
          expiresAt: receipt.expiresAt, accessGranted: false, identityEnrolled: false, inviteConsumed: false,
          freshness: 'LOCAL_DURABLE_STATE_ONLY',
          guestAccess: { available: false, code: 'GUEST_ACCESS_UNAVAILABLE' } }
      })
    },
    challenge: async (input, origin, transport) => {
      rejectAumlokRawSecrets(input); context(origin)
      if (input?.purpose === 'bind' && !available) refuse('AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE', 503)
      return run('challenge', transport, async (state, at) => {
        if (!fields(input, ['purpose', 'requestId', 'commitmentSha256', 'nodePubkeyHex', 'inviteeCommitmentSha256', 'assignedDomainPointer', 'action', 'inviteId', 'binding', ...rootFields])
          || !['bind', 'refresh', 'invite', 'approve', 'unseal'].includes(input.purpose) || !requestId(input.requestId)) refuse('AUMLOK_REQUEST_INVALID')
        const binding = state.binding
        const requestHash = await mac(state, 'aukora.aumlok.request.v2', canonicalJson(input))
        const accessSubject = await subject(state, transport, at)
        const prior = state.challenges.find(value => value.requestId === input.requestId)
        if (prior) {
          if (prior.requestHash !== requestHash || prior.origin !== origin || prior.accessSubject !== accessSubject) refuse('AUMLOK_IDEMPOTENCY_CONFLICT', 409)
          if (prior.consumedAt !== null) refuse('AUMLOK_CHALLENGE_USED', 409)
          if (prior.expiresAt <= at) refuse('AUMLOK_CHALLENGE_EXPIRED', 409)
          return { ...challengeView(prior, prior.purpose === 'approve' ? enrolledIds(state) : null, at), idempotent: true }
        }
        let normalized = input, credential = binding?.credential ?? null
        if (input.purpose === 'bind') {
          if (!exact(input, ['purpose', 'requestId', 'commitmentSha256', 'nodePubkeyHex', ...rootFields]) || !sha(input.commitmentSha256) || !sha(input.nodePubkeyHex) || !rootValid(rootFrom(input))) refuse('AUMLOK_SEALED_ROOT_REQUIRED')
          if (binding || state.enrollmentCount !== 0) refuse('ENROLLMENT_ALREADY_BOUND', 409)
          if (!available) refuse('AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE', 503)
          if (accessSubject === null) refuse('AUMLOK_OWNER_ACCESS_REQUIRED', 403)
          distinctOwnerKey(input.nodePubkeyHex)
        } else {
          if (!binding) refuse('AUMLOK_NOT_BOUND', 409)
          if (input.purpose === 'refresh') {
            if (!exact(input, ['purpose', 'requestId', 'commitmentSha256', ...rootFields]) || !sha(input.commitmentSha256) || !rootValid(rootFrom(input))) refuse('AUMLOK_SEALED_ROOT_REQUIRED')
            normalized = { ...input, nodePubkeyHex: binding.nodePubkeyHex }
          } else if (input.purpose === 'approve' || input.purpose === 'unseal') {
            if (input.purpose === 'approve') { distinctOwnerKey(binding.nodePubkeyHex); distinctCredentialKey(binding.credential, binding.nodePubkeyHex) }
            if (!exact(input, input.purpose === 'approve' ? ['purpose', 'requestId', 'binding'] : ['purpose', 'requestId'])
              || (input.purpose === 'approve' && (!actionValid(input.binding) || input.binding.audience !== origin))) refuse('CLASS3_ACTION_INVALID')
            normalized = { ...input, recoveryCommitment: binding.recoveryCommitment, rootEscrow: binding.rootEscrow, nodePubkeyHex: binding.nodePubkeyHex }
          } else {
            if (input.action === 'revoke') {
              if (!exact(input, ['purpose', 'requestId', 'action', 'inviteId']) || !id(input.inviteId)) refuse('AUMLOK_REQUEST_INVALID')
              if (!state.invites.some(value => value.inviteId === input.inviteId)) refuse('AUMLOK_INVITE_NOT_FOUND', 404)
              if (state.revocations.some(value => value.inviteId === input.inviteId)) refuse('AUMLOK_INVITE_REVOKED', 409)
              normalized = { ...input, recoveryCommitment: binding.recoveryCommitment, rootEscrow: binding.rootEscrow, nodePubkeyHex: binding.nodePubkeyHex,
                revocation: { schema: REVOCATION_SCHEMA, inviteId: input.inviteId, sponsorPubkeyHex: binding.nodePubkeyHex, revokedAt: at } }
            } else {
              // Issuance reserves capacity for one later append-only revocation per invite.
              if (state.invites.length >= AUMLOK_LIMITS.inviteRecords) refuse('AUMLOK_INVITE_CAPACITY', 507)
              if (!exact(input, ['purpose', 'requestId', 'inviteeCommitmentSha256', 'assignedDomainPointer']) || !sha(input.inviteeCommitmentSha256) || !domainValid(input.assignedDomainPointer)) refuse('AUMLOK_REQUEST_INVALID')
              const quotaMonth = monthAt(at), count = state.invites.filter(value => value.quotaMonth === quotaMonth).length
              if (count >= 3) refuse('AUMLOK_INVITE_MONTHLY_LIMIT', 429)
              normalized = { ...input, recoveryCommitment: binding.recoveryCommitment, rootEscrow: binding.rootEscrow, nodePubkeyHex: binding.nodePubkeyHex,
                invite: { schema: AUMLOK_INVITE_SCHEMA, inviteId: random(), sponsorPubkeyHex: binding.nodePubkeyHex,
                  inviteeCommitmentSha256: input.inviteeCommitmentSha256, assignedDomainPointer: input.assignedDomainPointer,
                  quotaMonth, monthlySequence: count + 1, revoked: false, issuedAt: at, expiresAt: at + 604800000 } }
            }
          }
        }
        const record = await issue(state, normalized, origin, at, credential, accessSubject)
        record.requestHash = requestHash
        // A Class 3 approval accepts any enrolled credential: the primary or a device (passkey-devices.mjs).
        return { ...challengeView(record, record.purpose === 'approve' ? enrolledIds(state) : null), idempotent: false }
      })
    },
    complete: async (purpose, input, origin, transport) => {
      if (purpose === 'signin-challenge') return signinChallenge(input, origin)
      if (purpose === 'signin-key') return signinKey(input, origin)
      if (purpose === 'signin') return signin(input, origin, transport)
      if (purpose === 'session' || purpose === 'signout') return sessionCall(purpose, input, origin)
      rejectAumlokRawSecrets(input); context(origin)
      return run('complete', transport, async (state, at, note) => {
        if (!['bind', 'refresh', 'invite', 'approve', 'unseal'].includes(purpose) || !fields(input, ['challengeId', 'credential', 'nodeSignature', 'signature', 'commitmentSha256']) || !id(input.challengeId)) refuse('AUMLOK_REQUEST_INVALID')
        const record = state.challenges.find(value => value.id === input.challengeId)
        if (!record) refuse('AUMLOK_CHALLENGE_UNKNOWN', 409)
        if (record.expiresAt <= at) refuse('AUMLOK_CHALLENGE_EXPIRED', 409)
        if (record.origin !== origin || record.purpose !== purpose || record.accessSubject !== await subject(state, transport, at)) refuse('AUMLOK_CHALLENGE_BINDING_MISMATCH', 409)
        const completionHash = await hash(canonicalJson(input))
        if (record.consumedAt !== null) {
          if (purpose === 'approve' || purpose === 'unseal') refuse('AUMLOK_CHALLENGE_USED', 409)
          if (record.completionHash !== completionHash) refuse('AUMLOK_CHALLENGE_USED', 409)
          if (record.outcome === 'PENDING_ASSERTION') {
            const next = state.challenges.find(value => value.id === record.nextChallengeId)
            if (next && next.consumedAt === null && next.expiresAt > at) return { ...challengeView(next, null, at), idempotent: true }
          }
          if (record.outcome === 'VERIFIED') return { ...await publicStatus(state, at, available, ownerPublicKeyHex, pepperSecret), idempotent: true,
            ...(record.invite ? { invite: state.invites.find(value => value.inviteId === record.invite.inviteId) } : {}),
            ...(record.revocation ? { revocation: state.revocations.find(value => value.inviteId === record.revocation.inviteId) } : {}) }
          refuse('AUMLOK_CHALLENGE_USED', 409)
        }
        if (record.generation !== state.generation) refuse('AUMLOK_CHALLENGE_BINDING_MISMATCH', 409)
        record.consumedAt = at
        record.completionHash = completionHash
        // Failed validation consumes only this challenge. No partial binding, quota or
        // revocation survives a failed signature, approval, clock or capacity check.
        const before = { generation: state.generation, binding: state.binding, lastRotationChallengeId: state.lastRotationChallengeId, enrollmentCount: state.enrollmentCount, enrollments: [...state.enrollments],
          ...(Object.hasOwn(state, 'devices') ? { devices: state.devices } : {}),
          challenges: [...state.challenges], invites: [...state.invites], revocations: [...state.revocations], approvals: [...state.approvals] }
        let result, verifiedCredential, passkey = null
        try {
          if (purpose === 'bind' && !available) refuse('AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE', 503)
          validateCredential(input.credential, record.stage === 'registration')
          if (record.stage === 'registration') {
            if (!exact(input, ['challengeId', 'credential']) || state.binding !== null) refuse('AUMLOK_REQUEST_INVALID')
            // A subsequent signed assertion is mandatory, since a 'none' registration has no attestation signature.
            const credential = await verifiedRegistration(input.credential, { challenge: record.challenge, origin: record.origin, rpId: record.rpId, nodePubkeyHex: record.nodePubkeyHex })
            const next = await issue(state, { purpose: 'bind', requestId: random(), recoveryCommitment: record.recoveryCommitment,
              rootEscrow: record.rootEscrow, nodePubkeyHex: record.nodePubkeyHex }, origin, at, credential, record.accessSubject, registrationTransports(input.credential), record.id)
            result = challengeView(next)
            record.nextChallengeId = next.id
            record.outcome = 'PENDING_ASSERTION'
          } else {
            const expected = purpose === 'bind' || purpose === 'refresh' ? ['challengeId', 'credential', 'nodeSignature'] : purpose === 'invite' ? ['challengeId', 'credential', 'signature']
              : purpose === 'unseal' ? ['challengeId', 'credential', 'commitmentSha256'] : ['challengeId', 'credential']
            // Only an approval may be made by an enrolled device; every other ceremony stays with the primary.
            const deviceApproval = purpose === 'approve' && input.credential?.id !== record.credential.id && enrolledCredential(state, input.credential?.id) !== null
            if (!(purpose === 'unseal' ? fields(input, expected) : exact(input, expected)) || (input.credential.id !== record.credential.id && !deviceApproval)) refuse('AUMLOK_PROOF_INVALID')
            // A node or invite signature that is not 64 bytes is malformed (400, never counted); only a well-formed one is
            // checked against the node key, and only that check's NO is a proof failure (403).
            if ((purpose === 'bind' || purpose === 'refresh') && !nodeSignatureShape(input.nodeSignature)) refuse('AUMLOK_NODE_PROOF_INVALID', 400)
            if (purpose === 'invite' && !nodeSignatureShape(input.signature)) refuse('AUMLOK_INVITE_SIGNATURE_INVALID', 400)
            const binding = state.binding
            if (purpose !== 'bind' && (!binding || binding.credential.id !== record.credential.id || binding.nodePubkeyHex !== record.nodePubkeyHex)) refuse('AUMLOK_CHALLENGE_BINDING_MISMATCH', 409)
            const credential = purpose === 'bind' ? record.credential : deviceApproval ? enrolledCredential(state, input.credential.id) : binding.credential
            if (purpose === 'bind' || purpose === 'approve') distinctCredentialKey(credential, record.nodePubkeyHex)
            // UNSEAL'S SECOND FACTOR IS READ BEFORE THE PASSKEY IS (job 7 review): a phrase budget that is locked and a
            // commitment that is not one are refused here, before any proof is checked or consumed, so neither refusal can
            // move a counter in either direction (never raised, never reset). Only words checked and wrong count (403).
            if (purpose === 'unseal') {
              phraseBudget(state, time())
              if (!Object.hasOwn(input, 'commitmentSha256') || !exact(input, expected) || !sha(input.commitmentSha256)) refuse('AUMLOK_COMMITMENT_INVALID')
            }
            // PHASE ONE, THE SCREEN: our own parse and comparison of everything that is policy, not cryptography:
            // the signature's form for the credential's algorithm (job 7 review: 400), the type, the challenge this ceremony
            // issued, the origin, the RP id hash and both flags (403, NEVER counted: no signature was checked; the reviewer's
            // made-up challenge and wrong origin are refused here), and whether the counter is past the stored one.
            const screened = await screenAssertion(input.credential, { challenge: record.challenge, origin: record.origin, rpId: record.rpId, stored: credential })
            if (!screened.pass) screenRefuse(screened.refusal)
            const assertionTerms = { response: input.credential, expectedChallenge: record.challenge,
              expectedOrigin: record.origin, expectedRPID: record.rpId, expectedType: 'webauthn.get', requireUserVerification: true }
            // PHASE TWO, THE CHECK (proof-failure-rule.mjs, the only thing that can count): ok only for the library's strict
            // `verified: true` with UV; wrong only for its strict `verified: false` (403, counted); any throw or other answer
            // 503 (never counted, the challenge kept).
            const assertion = counter => proofOutcome(() => verifyAuthenticationResponse({ ...assertionTerms,
              credential: { id: credential.id, publicKey: isoBase64URL.toBuffer(credential.publicKeyB64), counter } }), { code: 'AUMLOK_PROOF_INVALID', judge: 'webauthn-authentication' })
            // THE COUNTER. OVERTAKEN, NOT FORGED: an assertion the owner signed before a newer ceremony (a sign-in) advanced
            // the counter. The screen saw it (`stale`); the signature is then checked with the counter rule set aside: a
            // genuine one is the stale-counter refusal (409, never counted; the owner retries with a fresh challenge), an
            // actual signature `false` counts as any wrong signature does, and no verdict is 503.
            passkey = await assertion(screened.stale ? 0 : credential.counter)
            if (screened.stale && proofIs(passkey, 'ok')) refuse('AUMLOK_ASSERTION_STALE', 409)
            const verified = settleProof(passkey)
            const updatedCredential = { ...credential, counter: verified.authenticationInfo.newCounter }
            if (!credentialValid(updatedCredential)) refuse('AUMLOK_PROOF_INVALID')
            verifiedCredential = updatedCredential
            if (purpose === 'bind') {
              if (binding !== null || state.enrollmentCount !== 0) refuse('ENROLLMENT_ALREADY_BOUND', 409)
              distinctOwnerKey(record.nodePubkeyHex)
              settleSignature(await nodeSignatureOutcome(record.nodePubkeyHex, input.nodeSignature, AUMLOK_NODE_DOMAIN + record.intentHash, 'AUMLOK_NODE_PROOF_INVALID'), 'AUMLOK_NODE_PROOF_INVALID')
              if (!trustedAccess(transport?.access, at) || record.accessSubject === null) refuse('AUMLOK_OWNER_ACCESS_REQUIRED', 403)
              const approval = await authorizeEnrollment(Object.freeze({ intentHash: record.intentHash,
                nodePubkeyHex: record.nodePubkeyHex, credentialId: credential.id, origin, expiresAt: record.expiresAt,
                genesis: true, registrationVerified: true, assertionVerified: true, nodeProofVerified: true }), transport)
              if (!exact(approval, ['authorized', 'intentHash']) || approval.authorized !== true || approval.intentHash !== record.intentHash) refuse('AUMLOK_TRUSTED_ENROLLMENT_REQUIRED', 403)
              const enrollment = { schema: 'aumlok.enrollment.v1', at, intentHash: record.intentHash,
                nodePubkeyHex: record.nodePubkeyHex, ownerPublicKeyHex, credentialId: credential.id }
              state.enrollments.push({ ...enrollment, recordMac: await mac(state, 'aukora.aumlok.enrollment.v1', canonicalJson(enrollment)) })
              state.enrollmentCount = 1
              state.generation++
              state.binding = { aumlokId: await hash('aukora.aumlok.identity.v1\n' + record.nodePubkeyHex), recoveryCommitment: record.recoveryCommitment, rootEscrow: record.rootEscrow,
                nodePubkeyHex: record.nodePubkeyHex, credential: updatedCredential, boundAt: at, lastVerifiedAt: at, generation: state.generation,
                ...(Object.hasOwn(record, 'transports') ? { transports: record.transports } : {}) }
            } else if (purpose === 'refresh') {
              settleSignature(await nodeSignatureOutcome(binding.nodePubkeyHex, input.nodeSignature, AUMLOK_NODE_DOMAIN + record.intentHash, 'AUMLOK_NODE_PROOF_INVALID'), 'AUMLOK_NODE_PROOF_INVALID')
              state.generation++
              state.binding = { ...binding, recoveryCommitment: record.recoveryCommitment, rootEscrow: record.rootEscrow, credential: updatedCredential, lastVerifiedAt: at, generation: state.generation }
              state.lastRotationChallengeId = record.id
            } else if (purpose === 'approve') {
              distinctOwnerKey(binding.nodePubkeyHex)
              state.approvals = state.approvals.filter(value => value.expiresAt > at)
              if (state.approvals.length >= AUMLOK_LIMITS.approvalRecords) refuse('AUMLOK_APPROVAL_CAPACITY', 429, { retryAfterSeconds: retryAfterSeconds(Math.min(...state.approvals.map(value => value.expiresAt)), at) })
              const approvalToken = random()
              const approvedAt = time()
              if (approvedAt < at || approvedAt >= record.expiresAt) refuse('AUMLOK_CHALLENGE_EXPIRED', 409)
              const userHandle = input.credential.response.userHandle
              const approval = { approvalId: random(), tokenHash: await hash(approvalToken), binding: record.binding, origin, generation: state.generation,
                approvedAt, expiresAt: approvedAt + AUMLOK_LIMITS.approvalMs, consumedAt: null,
                // Private: which device approved (absent = the primary) and the user handle its authenticator returned.
                // The handle is kept only for a device-code approval, which hands it to the new device's registration.
                ...(deviceApproval ? { approvedBy: credential.id, approvedInstance: state.devices.find(device => device.credential.id === credential.id).instance } : {}),
                ...(record.binding.pathname === PASSKEY_DEVICE_ROUTES.code && deviceUserHandleValid(userHandle) ? { userHandle } : {}) }
              approval.recordMac = await approvalMac(state, approval, pepperSecret)
              state.approvals.push(approval)
              if (deviceApproval) { touchDevice(state, updatedCredential, at); note.deviceCredential = credential.id }
              else state.binding = { ...binding, credential: updatedCredential, lastVerifiedAt: at }
              result = { approvalToken, approvedAt, expiresAt: approval.expiresAt, binding: record.binding, approval: publicApproval(approval) }
            } else if (purpose === 'unseal') {
              // The phrase budget and the commitment's syntax were read before the passkey (above).
              settleProof(await pepperMacOutcome(state, 'aukora.aumlok.recovery.v2', input.commitmentSha256, binding.recoveryCommitment, pepperSecret, 'AUMLOK_RECOVERY_COMMITMENT_MISMATCH'))
              result = { sealedRoot: await openRoot(state, binding, pepperSecret), phraseVerified: true }
              state.binding = { ...binding, credential: updatedCredential, lastVerifiedAt: at }
            } else {
              if (record.invite) {
                if (state.invites.length >= AUMLOK_LIMITS.inviteRecords) refuse('AUMLOK_INVITE_CAPACITY', 507)
                const count = state.invites.filter(value => value.quotaMonth === monthAt(at)).length
                if (record.invite.quotaMonth !== monthAt(at) || record.invite.monthlySequence !== count + 1) refuse('AUMLOK_INVITE_QUOTA_CHANGED', 409)
                if (count >= 3) refuse('AUMLOK_INVITE_MONTHLY_LIMIT', 429)
                const signed = { ...record.invite, signature: input.signature }
                settleSignature(await inviteReceiptOutcome(signed, binding.nodePubkeyHex), 'AUMLOK_INVITE_SIGNATURE_INVALID')
                state.invites.push(signed)
                result = { ok: true, invite: signed }
              } else if (record.revocation) {
                if (state.revocations.some(value => value.inviteId === record.revocation.inviteId)) refuse('AUMLOK_INVITE_REVOKED', 409)
                settleSignature(await nodeSignatureOutcome(binding.nodePubkeyHex, input.signature, revocationPreimage(record.revocation), 'AUMLOK_INVITE_SIGNATURE_INVALID'), 'AUMLOK_INVITE_SIGNATURE_INVALID')
                const signed = { ...record.revocation, signature: input.signature }
                state.revocations.push(signed)
                result = { ok: true, revocation: signed }
              } else refuse('AUMLOK_INVITE_INVALID')
              state.binding = { ...binding, credential: updatedCredential, lastVerifiedAt: at }
            }
            result = { ...await publicStatus(state, at, available, ownerPublicKeyHex, pepperSecret), ...result }
            record.outcome = 'VERIFIED'
          }
          const completedAt = time()
          if (completedAt < at || completedAt >= record.expiresAt) refuse('AUMLOK_CHALLENGE_EXPIRED', 409)
          if (purpose === 'bind' && !trustedAccess(transport?.access, completedAt)) refuse('AUMLOK_OWNER_ACCESS_REQUIRED', 403)
          validateState(state)
          if (verifiedCredential) clearFailures(passkey, state)
        } catch (error) {
          Object.assign(state, before)
          // An error without a code is this node's own fault (job 6 review), never a proof judged wrong: unavailable, uncounted.
          result = resultError(error.code ? error : failure('AUMLOK_UNAVAILABLE', 503))
          // The branded WRONG outcome this refusal stands for, if a verifier judged a proof wrong (run counts it).
          note.proven = proofOf(error)
          // Only a COUNTED phrase refusal (words checked and wrong) after a verified passkey keeps that passkey's effects (its
          // counter, and the reset of the passkey budget a correct passkey earns). Every refusal that does not count leaves
          // every counter exactly as it was, in both directions (job 7 review).
          if (verifiedCredential && note.proven !== null && proofFailureBudget(note.proven) === 'phrase') {
            const checkedAt = time()
            if (checkedAt < at || checkedAt >= record.expiresAt) {
              result = resultError(failure('AUMLOK_CHALLENGE_EXPIRED', 409))
              note.proven = null
            } else {
              // A fresh UV can succeed while the independent phrase factor is refused.
              // Consume its counter and challenge without releasing escrow or other effects.
              state.binding = { ...state.binding, credential: verifiedCredential, lastVerifiedAt: at }
              clearFailures(passkey, state)
            }
          }
          if (result.status === 503) {
            // NO VERDICT: a verifier that threw or answered anything but a boolean, or this node's own failure. No
            // effect at all, and the challenge stays outstanding, so a retry needs no new ceremony (and none is used up).
            record.consumedAt = null
            record.completionHash = null
            note.proven = null
            // Job 9 review: the same subject starting this purpose over may take its slot (issue). Pruned to what is held.
            for (const held of noVerdict) if (!state.challenges.some(value => value.id === held)) noVerdict.delete(held)
            noVerdict.add(record.id)
          } else {
            noVerdict.delete(record.id)
            record.outcome = result.code
            record.nextChallengeId = null
          }
        }
        return result
      })
    },
    consumeApproval: async (token, binding, origin, transport) => {
      context(origin)
      return run('consume-approval', transport, async (state, at) => {
        const approval = await approvalFor(state, token, binding, origin, at)
        approval.consumedAt = at
        return { ok: true, binding: approval.binding, approvalId: approval.approvalId ?? null, expiresAt: approval.expiresAt }
      })
    },
    verifyApproval: async (token, binding, origin) => {
      context(origin)
      return storage.transaction(async tx => {
        const approval = await approvalFor(await read(tx), token, binding, origin, time())
        return { ok: true, binding: approval.binding, approvalId: approval.approvalId ?? null, expiresAt: approval.expiresAt }
      })
    },
    consumeApprovalInTransaction: async (tx, token, binding, origin) => {
      context(origin)
      const state = await read(tx), at = time(), approval = await approvalFor(state, token, binding, origin, at)
      approval.consumedAt = at
      await attempt(state, at, 'consume-approval', 'VERIFIED', undefined)
      await write(tx, state)
      const completedAt = time()
      if (completedAt < at || completedAt >= approval.expiresAt) refuse('CLASS3_WEBAUTHN_REQUIRED', 403)
      return { ok: true, binding: approval.binding, approvalId: approval.approvalId ?? null, expiresAt: approval.expiresAt }
    },
  })
}

/** Route metadata validation, independent of transport authentication or human approval.
 * @param {Request} request Incoming authenticated request, retaining its original origin URL.
 * @param {string[]} origins Exact configured origins.
 * @returns {string} status/invites/redeem/challenge/bind/refresh/invite/approve/unseal action; invalid requests throw.
 */
export function aumlokRequestAction(request, origins) {
  const url = new URL(request.url), action = url.pathname.slice('/_host/aumlok/'.length)
  const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site')
  if (!origins.includes(url.origin) || (origin !== null && origin !== url.origin) || (site !== null && !['same-origin', 'none'].includes(site))
    || (request.method === 'POST' && (origin !== url.origin || site !== 'same-origin'))) refuse('AUMLOK_ORIGIN_REQUIRED', 403)
  if (!url.pathname.startsWith('/_host/aumlok/') || !['status', 'invites', 'redeem', 'challenge', 'bind', 'refresh', 'invite', 'approve', 'unseal', 'signin-challenge', 'signin-key', 'signin', 'session', 'signout', ...PASSKEY_DEVICE_ACTIONS].includes(action) || url.href.includes('?') || url.hash) refuse('AUMLOK_ROUTE_NOT_FOUND', 404)
  const readOnly = action === 'status' || action === 'invites' || action === 'devices'
  if (request.method !== (readOnly ? 'GET' : 'POST')) refuse('AUMLOK_METHOD_NOT_ALLOWED', 405)
  if (readOnly && (request.body !== null || request.headers.has('transfer-encoding') || (request.headers.has('content-length') && request.headers.get('content-length') !== '0'))) refuse('AUMLOK_BODY_NOT_ALLOWED')
  if (!readOnly && !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) refuse('AUMLOK_CONTENT_TYPE_REQUIRED')
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') refuse('AUMLOK_ENCODING_UNSUPPORTED')
  return action
}

/** Produce a content-free API failure without exposing proof bytes or dependency errors.
 * @param {unknown} error Failure at an AUMLOK request or storage boundary.
 * @returns {object} Stable code/status response.
 */
export function aumlokFailureResult(error) { return resultError(error) }

/**
 * The Retry-After header of a capacity refusal (whole seconds, as its body's `retryAfterSeconds`), else none.
 * @param {object} result A route result or failure result.
 * @returns {object} `{ 'retry-after': '<seconds>' }` or `{}`.
 */
export function aumlokRetryHeaders(result) {
  const { retryAfterSeconds: seconds } = capacityRetry(result)
  return seconds === undefined ? {} : { 'retry-after': String(seconds) }
}
