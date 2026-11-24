/** Read-only first-enrollment authorization; never signs or provisions keys. */
import { canonicalJson } from './owner-grant-policy.mjs'
import { proofError, proofIs, proofOutcome } from './proof-failure-rule.mjs'

export const OWNER_ENROLLMENT_MODE = 'owner-signature-v1'
export const OWNER_ACCESS_ENROLLMENT_MODE = 'owner-access-genesis-v1'
export const OWNER_ENROLLMENT_SCHEMA = 'aukora.aumlok.enrollment-approval.v1'
export const OWNER_ENROLLMENT_DOMAIN = OWNER_ENROLLMENT_SCHEMA + '\0'
export const OWNER_ENROLLMENT_HEADER = 'x-x6-enrollment-approval'
const MAX_APPROVAL_BYTES = 4096
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 && !Object.is(value, -0)
const encoder = new TextEncoder()
const hexBytes = value => Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16))
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

/** Resolve absent mode to authenticated-owner genesis; unknown modes fail closed.
 * @param {object} options Trusted mode, exact origin, owner email/key and optional clock.
 * allowLoopback permits HTTP only on localhost or 127.0.0.1 for an explicitly configured local host.
 * @returns {Function|undefined} Exact-intent verifier, or undefined for absent/invalid configuration.
 * In signature mode the untrusted bounded header must be canonical JSON containing the six payload fields
 * and signatureHex. The configured Ed25519 owner key signs DOMAIN + canonicalJson(payload).
 * The default trusts a verified same-owner Access subject plus the verified ceremony.
 * Explicit owner-signature-v1 additionally requires the exact owner signature. Neither
 * policy establishes hardware attestation or a unique browser-session binding.
 */
export function createOwnerEnrollmentVerifier({ mode = OWNER_ACCESS_ENROLLMENT_MODE, origin, ownerEmail, ownerPublicKeyHex, now = Date.now, allowLoopback = false } = {}) {
  if (![OWNER_ENROLLMENT_MODE, OWNER_ACCESS_ENROLLMENT_MODE].includes(mode) || !sha(ownerPublicKeyHex) || typeof now !== 'function'
    || typeof ownerEmail !== 'string' || !/^[^\s@]{1,128}@[^\s@]{1,125}$/.test(ownerEmail)
    || typeof origin !== 'string' || origin.length > 253) return undefined
  try {
    const url = new URL(origin)
    if (url.origin !== origin || (url.protocol !== 'https:' && !(allowLoopback === true && url.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(url.hostname)))) return undefined
  } catch (_error) { return undefined }
  const owner = ownerEmail.toLowerCase()
  return async function authorizeEnrollment(intent, context) {
    const refused = { authorized: false }
    const access = context?.access
    const at = now()
    if (!timestamp(at) || !access || !['owner', 'access'].includes(access.type)
      || typeof access.email !== 'string' || access.email.toLowerCase() !== owner
      || !Number.isFinite(access.expires) || access.expires * 1000 <= at
      || intent?.genesis !== true || intent.registrationVerified !== true || intent.assertionVerified !== true || intent.nodeProofVerified !== true
      || intent.origin !== origin || !sha(intent.intentHash) || !sha(intent.nodePubkeyHex) || intent.nodePubkeyHex === ownerPublicKeyHex
      || typeof intent.credentialId !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(intent.credentialId)
      || !timestamp(intent.expiresAt) || intent.expiresAt <= at) return refused
    const accessExpiresAt = access.expires * 1000
    if (mode === OWNER_ACCESS_ENROLLMENT_MODE) {
      const checkedAt = now()
      if (!timestamp(checkedAt) || checkedAt < at || checkedAt >= intent.expiresAt || checkedAt >= accessExpiresAt) return refused
      return { authorized: true, intentHash: intent.intentHash }
    }
    const payload = { schema: OWNER_ENROLLMENT_SCHEMA, audience: origin, intentHash: intent.intentHash,
      nodePubkeyHex: intent.nodePubkeyHex, credentialId: intent.credentialId, expiresAt: intent.expiresAt }
    const raw = context?.enrollmentApproval
    if (typeof raw !== 'string' || !raw.length || raw.length > MAX_APPROVAL_BYTES || !/^[\x20-\x7e]+$/.test(raw)) return refused
    // The approval's bytes are read first; any refusal of their shape (a throw included) is a refusal, as before.
    let proof
    try {
      proof = JSON.parse(raw)
      if (!exact(proof, [...Object.keys(payload), 'signatureHex']) || canonicalJson(proof) !== raw
        || typeof proof.signatureHex !== 'string' || !/^[0-9a-f]{128}$/.test(proof.signatureHex)
        || Object.entries(payload).some(([key, value]) => proof[key] !== value)) return refused
    } catch (_error) { return refused }
    // Only a strict `true` authorizes (proof-failure-rule.mjs): a backend answering {} or 1 is no verdict. Job 10: NO VERDICT
    // IS NOT A REFUSAL. An answer that is neither true nor false, a throw, or a key that will not import is thrown as 503
    // (outside any catch that answers authorized:false), so the store keeps the bind challenge and the same ceremony can be
    // retried. Only a checked-wrong signature refuses (and uses the challenge; it counts nothing: no budget names it).
    const verdict = await proofOutcome(async () => crypto.subtle.verify('Ed25519', await crypto.subtle.importKey('raw', hexBytes(ownerPublicKeyHex), 'Ed25519', false, ['verify']),
      hexBytes(proof.signatureHex), encoder.encode(OWNER_ENROLLMENT_DOMAIN + canonicalJson(payload))),
      { code: 'AUMLOK_TRUSTED_ENROLLMENT_REQUIRED', unavailableCode: 'AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE' })
    if (proofIs(verdict, 'unavailable')) throw proofError(verdict)
    if (!proofIs(verdict, 'ok')) return refused
    const checkedAt = now()
    if (!timestamp(checkedAt) || checkedAt < at || checkedAt >= payload.expiresAt || checkedAt >= accessExpiresAt) return refused
    return { authorized: true, intentHash: payload.intentHash }
  }
}
