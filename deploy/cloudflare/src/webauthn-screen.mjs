/**
 * THE SCREEN: a passkey check has two phases, and only the second can count.
 *
 *   PHASE ONE, THE SCREEN (this module: our own code, no key use, no verifier, nothing counted). Before the WebAuthn
 *   library is asked anything, the answer's bytes are parsed here and everything that is POLICY, not cryptography, is
 *   compared: the shape and encodings (base64url, lengths), the client data's type, challenge (against the outstanding
 *   one) and origin, the authenticator data's RP id hash and its user-present and user-verified flags, the credential id
 *   against the known credential, the signature's form for the stored key's algorithm, and (registration) the
 *   attestation's format and the new key's algorithm. A mismatch is a REFUSAL THAT MOVES NO BUDGET: the caller answers it
 *   with the status and code its page already knows, and never through proofOutcome.
 *   PHASE TWO, THE CHECK (proof-failure-rule.mjs proofOutcome, the only thing that can count): the library call. After a
 *   passing screen the library's `verified: true` is ok and `verified: false` is wrong; ANY throw is `unavailable`
 *   (it means the library disagreed with this screen, or something broke: neither is a signature checked and wrong).
 *
 * The library (@simplewebauthn/server 14.1.0) checks challenge, origin, RP id, flags and the counter BEFORE its signature
 * operation and reports each by throwing. Before this screen, selected throws were branded `wrong`, so an assertion for a
 * made-up challenge moved the owner's budget with no signature checked. __tests__/webauthn-screen.test.mjs feeds the same
 * malformed and mismatched answers to this screen and to the library alone: every answer the library throws on is refused
 * here first (or, for the counter, reported `stale`). That table is how the next library upgrade is caught.
 *
 * Refusals (`refusal`): 'malformed' (the bytes are not such an answer: 400 where it is answered), 'unsupported' (a
 * well-formed attestation of a format or key algorithm this node does not register), 'cross-origin' (client data from a
 * frame), 'credential' (another credential than the one this ceremony knows, or a known ES256/Ed25519
 * credential whose stored key is no usable key of its algorithm), the POLICY mismatches of SCREEN_POLICY (403 where they
 * are answered, uncounted), and 'unavailable' (this screen's own hash could not run: 503).
 *
 * the library also throws, before its signature operation, on an
 * answer whose backup-state flag (BS) is set while its backup-eligible flag (BE) is clear (the WebAuthn data model forbids
 * BS without BE), and on a stored ES256 key that is not a point of P-256 (its key import throws). Both passed this screen
 * and became a repeatable 503. Now BS without BE is the policy refusal 'backup-state' in both screens, and an ES256 key
 * off the curve is refused where it enters (registration: 'malformed') and where it is used (assertion: 'credential').
 * @module webauthn-screen
 */
import { decodeAttestationObject, decodeClientDataJSON, decodeCredentialPublicKey, isoBase64URL, parseAuthenticatorData } from '@simplewebauthn/server/helpers'

/** The policy mismatches: a well-formed answer for something else. Answered 403 by the routes, and never counted. */
export const SCREEN_POLICY = Object.freeze(['type', 'challenge', 'origin', 'rp-id', 'user-presence', 'user-verification', 'backup-state'])
const TRANSPORTS = Object.freeze(['usb', 'nfc', 'ble', 'internal', 'hybrid'])
const encoder = new TextEncoder()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const b64 = (value, max) => {
  if (typeof value !== 'string' || !value.length || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) return false
  try { return isoBase64URL.fromBuffer(isoBase64URL.toBuffer(value)) === value } catch (_error) { return false }
}

/** P-256 (SEC 2): the field prime and the curve's b (a = -3). */
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
const bigOf = bytes => bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)
/**
 * whether (x, y) is a point of P-256 (both coordinates below p, y^2 = x^3 - 3x + b mod p). Arithmetic only,
 * no key and no crypto call: the library's key import throws on anything else, after a screen that let it through.
 */
const onP256 = (xBytes, yBytes) => {
  const x = bigOf(xBytes), y = bigOf(yBytes)
  return x < P256_P && y < P256_P && (y * y - (x * x * x - 3n * x + P256_B)) % P256_P === 0n
}
/** A COSE key's algorithm as this node registers it ('ES256' on P-256, its point on the curve; 'Ed25519'), or null for anything else. */
export const keyAlgorithm = key => {
  if (!(key instanceof Map)) return null
  const kty = key.get(1), alg = key.get(3), crv = key.get(-1), x = key.get(-2), y = key.get(-3)
  if (kty === 2 && alg === -7 && crv === 1 && x instanceof Uint8Array && x.length === 32 && y instanceof Uint8Array && y.length === 32 && onP256(x, y)) return 'ES256'
  if (kty === 1 && alg === -8 && crv === 6 && x instanceof Uint8Array && x.length === 32) return 'Ed25519'
  return null
}
/**
 * The stored credential's algorithm, or null for a key this node never registers (left to the verifier, as before), or
 * 'unusable': a key that says ES256 or Ed25519 (alg -7 or -8) and is no usable key of it.
 */
const storedKeyAlgorithm = publicKeyB64 => {
  let key
  try { key = decodeCredentialPublicKey(isoBase64URL.toBuffer(publicKeyB64)) } catch (_error) { return null }
  const algorithm = keyAlgorithm(key)
  return algorithm === null && key instanceof Map && [-7, -8].includes(key.get(3)) ? 'unusable' : algorithm
}
/** One DER INTEGER at `offset`: minimal, positive, non-zero, at most 256 bits. Returns the offset after it, or -1. */
const derInteger = (bytes, offset) => {
  if (bytes[offset] !== 0x02) return -1
  const length = bytes[offset + 1], first = bytes[offset + 2]
  if (!(length >= 1 && length <= 33) || offset + 2 + length > bytes.length) return -1
  if ((first & 0x80) !== 0 || (length === 1 && first === 0)) return -1
  if (length > 1 && first === 0 && (bytes[offset + 3] & 0x80) === 0) return -1
  if (length === 33 && first !== 0) return -1
  return offset + 2 + length
}
const es256SignatureShape = bytes => {
  if (bytes.length < 8 || bytes.length > 72 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) return false
  const afterR = derInteger(bytes, 2)
  return afterR !== -1 && derInteger(bytes, afterR) === bytes.length
}
/**
 * THE SIGNATURE'S OWN ENCODING (job 7 review): strict DER (SEQUENCE of two minimal, positive INTEGERs of at most 256 bits,
 * nothing left over) for ES256, exactly 64 bytes for Ed25519. Anything else is malformed, refused before any verifier.
 * @param {string} publicKeyB64 The stored COSE key.
 * @param {string} signatureB64 The signature as sent (base64url, already bounded).
 * @returns {boolean} Whether it has the shape of the stored key's algorithm.
 */
export function signatureShape(publicKeyB64, signatureB64) {
  const algorithm = storedKeyAlgorithm(publicKeyB64), bytes = isoBase64URL.toBuffer(signatureB64)
  if (algorithm === 'Ed25519') return bytes.length === 64
  if (algorithm === 'ES256') return es256SignatureShape(bytes)
  return true
}

/** The client data as the library reads it (the same decoder), or null when it is not one JSON object. */
const clientData = text => {
  try {
    const data = decodeClientDataJSON(text)
    return object(data) ? data : null
  } catch (_error) { return null }
}
const sameBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((value, index) => value === b[index])
/** SHA-256 of the RP id, as the authenticator hashes it; null when this node's own hash could not run (503, never a refusal). */
const rpIdHash = async rpId => {
  try { return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(rpId))) } catch (_error) { return null }
}
const refused = refusal => Object.freeze({ pass: false, refusal })

/**
 * Screen one get() answer (an assertion) for one known credential.
 * @param {unknown} credential The answer as sent.
 * @param {object} terms `challenge`, `origin`, `rpId`: what this ceremony issued; `stored`: the known credential
 *   { id, publicKeyB64, counter }; `counterRule` (true): report `stale` when the answer's counter is not past the stored one
 *   (the library's own counter rule, which it applies before the signature).
 * @returns {Promise<Readonly<{ pass: true, counter: number, stale: boolean } | { pass: false, refusal: string }>>}
 */
export async function screenAssertion(credential, { challenge, origin, rpId, stored, counterRule = true }) {
  let data, auth
  try {
    if (!object(credential) || !b64(credential.id, 2048) || credential.rawId !== credential.id || credential.type !== 'public-key') return refused('malformed')
    const response = credential.response
    if (!object(response) || !b64(response.clientDataJSON, 8192) || !b64(response.authenticatorData, 2048) || !b64(response.signature, 2048)
      || (response.userHandle !== undefined && response.userHandle !== null && !b64(response.userHandle, 256))) return refused('malformed')
    data = clientData(response.clientDataJSON)
    // A token binding, if any, of a known status; no topOrigin (only a cross-origin frame sends one).
    if (data === null || typeof data.type !== 'string' || typeof data.challenge !== 'string' || typeof data.origin !== 'string' || data.topOrigin !== undefined
      || (data.tokenBinding && (!object(data.tokenBinding) || !['present', 'supported', 'notSupported'].includes(data.tokenBinding.status)))) return refused('malformed')
    // The authenticator data must parse exactly (no short data, no bytes left over, extensions that decode).
    auth = parseAuthenticatorData(isoBase64URL.toBuffer(response.authenticatorData))
    if (!signatureShape(stored.publicKeyB64, response.signature)) return refused('malformed')
    if (credential.id !== stored.id) return refused('credential')
    if (storedKeyAlgorithm(stored.publicKeyB64) === 'unusable') return refused('credential')
  } catch (_error) { return refused('malformed') }
  if (data.type !== 'webauthn.get') return refused('type')
  if (data.challenge !== challenge) return refused('challenge')
  if (data.origin !== origin) return refused('origin')
  const expected = await rpIdHash(rpId)
  if (expected === null) return refused('unavailable')
  if (!sameBytes(auth.rpIdHash, expected)) return refused('rp-id')
  if (!auth.flags.up) return refused('user-presence')
  if (!auth.flags.uv) return refused('user-verification')
  // backed up but not backup-eligible is no state an authenticator can be in (the library throws on it).
  if (auth.flags.bs && !auth.flags.be) return refused('backup-state')
  const stale = counterRule === true && (auth.counter > 0 || stored.counter > 0) && auth.counter <= stored.counter
  return Object.freeze({ pass: true, counter: auth.counter, stale })
}

/**
 * Screen one create() answer (a registration, attestation format 'none').
 * @param {unknown} credential The answer as sent.
 * @param {object} terms `challenge`, `origin`, `rpId`: what this ceremony issued.
 * @returns {Promise<Readonly<{ pass: true } | { pass: false, refusal: string }>>}
 */
export async function screenRegistration(credential, { challenge, origin, rpId }) {
  let data, auth
  try {
    if (!object(credential) || !b64(credential.id, 2048) || credential.rawId !== credential.id || credential.type !== 'public-key') return refused('malformed')
    const response = credential.response
    if (!object(response) || !b64(response.clientDataJSON, 8192) || !b64(response.attestationObject, 16384)
      || (response.transports !== undefined && (!Array.isArray(response.transports) || response.transports.length > 8 || response.transports.some(value => !TRANSPORTS.includes(value))))) return refused('malformed')
    data = clientData(response.clientDataJSON)
    if (data === null || typeof data.type !== 'string' || typeof data.challenge !== 'string' || typeof data.origin !== 'string'
      || (data.tokenBinding && (!object(data.tokenBinding) || !['present', 'supported', 'not-supported'].includes(data.tokenBinding.status)))) return refused('malformed')
    if ((data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) return refused('cross-origin')
    const decoded = decodeAttestationObject(isoBase64URL.toBuffer(response.attestationObject))
    const authData = decoded instanceof Map ? decoded.get('authData') : null
    if (!(authData instanceof Uint8Array) || typeof decoded.get('fmt') !== 'string' || !(decoded.get('attStmt') instanceof Map)) return refused('malformed')
    if (decoded.get('fmt') !== 'none') return refused('unsupported')
    // A 'none' statement is empty (WebAuthn section 8.7): anything in it is malformed.
    if (decoded.get('attStmt').size !== 0) return refused('malformed')
    auth = parseAuthenticatorData(authData)
    if (!auth.flags.at || !(auth.aaguid instanceof Uint8Array) || !auth.credentialID?.byteLength || !auth.credentialPublicKey?.byteLength) return refused('malformed')
    const key = decodeCredentialPublicKey(auth.credentialPublicKey)
    if (!(key instanceof Map) || !Number.isSafeInteger(key.get(3))) return refused('malformed')
    if (![-7, -8].includes(key.get(3))) return refused('unsupported')
    if (keyAlgorithm(key) === null) return refused('malformed')
    // The credential the authenticator data names is the one the answer names.
    if (isoBase64URL.fromBuffer(auth.credentialID) !== credential.id) return refused('malformed')
  } catch (_error) { return refused('malformed') }
  if (data.type !== 'webauthn.create') return refused('type')
  if (data.challenge !== challenge) return refused('challenge')
  if (data.origin !== origin) return refused('origin')
  const expected = await rpIdHash(rpId)
  if (expected === null) return refused('unavailable')
  if (!sameBytes(auth.rpIdHash, expected)) return refused('rp-id')
  if (!auth.flags.up) return refused('user-presence')
  if (!auth.flags.uv) return refused('user-verification')
  if (auth.flags.bs && !auth.flags.be) return refused('backup-state')
  return Object.freeze({ pass: true })
}
