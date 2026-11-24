/** Local enrollment policy without host startup, credentials, or capability-derived identity. */
import { createAccessVerifier } from '../deploy/cloudflare/src/access.mjs'
import { createOwnerEnrollmentVerifier, OWNER_ENROLLMENT_HEADER } from '../deploy/cloudflare/src/enrollment-approval.mjs'

/** Resolve explicitly configured local owner identity independently of the capability cookie.
 * @param {object} config Exact loopback origin, owner email/public key and optional enrollment mode.
 * @param {Iterable<string>} allowedOrigins Host-owned origin allowlist.
 * @returns {object} Optional enrollment verifier and a cryptographically verified request context.
 * Missing/invalid configuration leaves enrollment unavailable. JWT audience is the configured
 * host:port, never a caller-supplied host or the production audience. No Access key fetching occurs.
 */
export function createLocalEnrollmentPolicy({ origin, ownerEmail, ownerPublicKeyHex, mode } = {}, allowedOrigins = []) {
  let env = null, authorizeEnrollment
  try {
    const url = new URL(origin)
    if (new Set(allowedOrigins).has(origin) && url.origin === origin && url.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(url.hostname)) {
      authorizeEnrollment = createOwnerEnrollmentVerifier({ origin, ownerEmail, ownerPublicKeyHex, mode, allowLoopback: true })
      if (authorizeEnrollment) env = { PUBLIC_HOST: url.host, OWNER_EMAIL: ownerEmail, OWNER_PUBLIC_KEY_HEX: ownerPublicKeyHex }
    }
  } catch (_error) { /* Missing/invalid explicit origin leaves enrollment unavailable. */ }
  const verifyAccess = createAccessVerifier()
  return Object.freeze({
    authorizeEnrollment,
    context: async (request, action) => ({
      access: env && new URL(request.url).origin === origin ? await verifyAccess(request, env) : null,
      ...(action === 'bind' ? { enrollmentApproval: request.headers.get(OWNER_ENROLLMENT_HEADER) } : {}),
    }),
  })
}
