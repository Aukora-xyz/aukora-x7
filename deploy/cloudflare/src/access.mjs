/** Verify bounded owner JWTs or Cloudflare Access assertions; never create credentials.
 * Every signature check goes through proofOutcome (proof-failure-rule.mjs, job 10): only a strict true is ok. */
import { proofIs, proofOutcome } from './proof-failure-rule.mjs'

const MAX_TOKEN = 16384
const MAX_OWNER_LIFE = 24 * 60 * 60
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const decode = text => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('INVALID_ENCODING')
  const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), character => character.charCodeAt(0))
  if (encode(bytes) !== text) throw new Error('INVALID_ENCODING')
  return bytes
}
const parse = (text, canonical = false) => {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(decode(text))
  const value = JSON.parse(source)
  if (!value || typeof value !== 'object' || Array.isArray(value) || (canonical && JSON.stringify(value) !== source)) throw new Error('INVALID_JSON')
  return value
}
const usableEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value)
const usableHost = value => {
  if (typeof value !== 'string' || !value || value.length > 253) return false
  try { const url = new URL('https://' + value); return url.host === value && url.origin === 'https://' + value && !url.username && !url.password }
  catch { return false }
}
const accessConfigured = env => typeof env.ACCESS_TEAM === 'string' && /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM) && typeof env.ACCESS_AUD === 'string' && /^[^\s,]{1,1024}$/.test(env.ACCESS_AUD)
const ownerConfigured = env => typeof env.OWNER_PUBLIC_KEY_HEX === 'string' && /^[0-9a-fA-F]{64}$/.test(env.OWNER_PUBLIC_KEY_HEX)

const accessPresent = env => typeof env.ACCESS_TEAM === 'string' && env.ACCESS_TEAM.length > 0 && typeof env.ACCESS_AUD === 'string' && env.ACCESS_AUD.length > 0

/** Check readiness only; authentication separately validates issuer configuration and signatures. */
export function ownerAccessConfigured(env) {
  return usableHost(env.PUBLIC_HOST) && usableEmail(env.OWNER_EMAIL) && Boolean(accessPresent(env) || ownerConfigured(env))
}

/** Select one assertion; identical carriers agree, conflicting or repeated carriers fail closed. */
export function requestAssertion(request) {
  const candidates = []
  for (const name of ['cf-access-jwt-assertion', 'x-x6-owner-assertion']) {
    if (request.headers.has(name)) candidates.push(request.headers.get(name))
  }
  const cookies = request.headers.get('cookie')
  if (cookies !== null) {
    if (cookies.length > 32768 || cookies.includes(',')) return null
    const ownerCookies = cookies.split(';').map(value => value.trim()).filter(value => /^CF_Authorization(?:=|$)/.test(value))
    if (ownerCookies.length > 1) return null
    if (ownerCookies.length) candidates.push(ownerCookies[0].slice('CF_Authorization='.length))
  }
  if (!candidates.length || candidates.some(value => !value || value.length > MAX_TOKEN || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))) return null
  return candidates.every(value => value === candidates[0]) ? candidates[0] : null
}

const edgeFetchKeys = (url, init) => fetch(url, init?.redirect === 'error' ? { ...init, redirect: 'manual' } : init)
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/**
 * Screen one owner JWT (EdDSA) at `at` (ms): everything about it that is judged BEFORE its signature (no key, no durable
 * call, no counter): its shape and encoding, its header, its claims, its audience, issuer and owner, its window and
 * lifetime, the signature's length. Any of those refused: `refused`. No usable clock: `unavailable` (no window can be
 * judged, no verdict is reached). Otherwise `screened`, ready for checkOwnerJwt.
 * @returns {{kind: 'refused'} | {kind: 'unavailable', outcome: null} | {kind: 'screened', parts: string[], claims: object, signature: Uint8Array}}
 */
function screenOwnerJwt(token, env, at) {
  const refused = { kind: 'refused' }
  if (!ownerAccessConfigured(env) || !ownerConfigured(env) || typeof token !== 'string' || token.length > MAX_TOKEN || !JWT_SHAPE.test(token)) return refused
  if (!Number.isFinite(at)) return { kind: 'unavailable', outcome: null }
  const parts = token.split('.')
  let claims, signature
  try {
    const header = parse(parts[0], true)
    if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || Object.keys(header).some(key => !['alg', 'typ'].includes(key))) return refused
    claims = parse(parts[1], true)
    signature = decode(parts[2])
  } catch (_error) { return refused }
  const seconds = at / 1000
  if (Object.keys(claims).some(key => !['iss', 'aud', 'email', 'nbf', 'exp'].includes(key))) return refused
  if (claims.iss !== 'aukora.x61.owner' || claims.aud !== env.PUBLIC_HOST || typeof claims.email !== 'string' || claims.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) return refused
  if (!Number.isFinite(claims.nbf) || !Number.isFinite(claims.exp) || claims.nbf > seconds || claims.exp <= seconds || claims.exp <= claims.nbf || claims.exp - claims.nbf > MAX_OWNER_LIFE) return refused
  if (signature.length !== 64) return refused
  return { kind: 'screened', parts, claims, signature }
}

/**
 * The Ed25519 check of a screened owner JWT, through proofOutcome: `ok` with the identity; `wrong` with the branded
 * outcome (OWNER_LOGIN_SIGNATURE_INVALID); `unavailable` for any other answer, a throw, or a key that cannot be imported.
 * @returns {Promise<{kind: 'ok', identity: object} | {kind: 'wrong' | 'unavailable', outcome: object}>}
 */
async function checkOwnerJwt({ parts, claims, signature }, env) {
  const bytes = Uint8Array.from(env.OWNER_PUBLIC_KEY_HEX.match(/../g), value => parseInt(value, 16))
  const outcome = await proofOutcome(async () => crypto.subtle.verify('Ed25519', await crypto.subtle.importKey('raw', bytes, 'Ed25519', false, ['verify']),
    signature, new TextEncoder().encode(parts[0] + '.' + parts[1])), { code: 'OWNER_LOGIN_SIGNATURE_INVALID', unavailableCode: 'OWNER_LOGIN_UNAVAILABLE' })
  if (proofIs(outcome, 'ok')) return { kind: 'ok', identity: { email: claims.email, expires: claims.exp, type: 'owner' } }
  return { kind: outcome.kind, outcome }
}

/** Judge one owner JWT at `at`: screened, then (only if it passed) checked. Four answers: ok, refused, wrong, unavailable. */
async function judgeOwnerJwt(token, env, at) {
  const screened = screenOwnerJwt(token, env, at)
  return screened.kind === 'screened' ? checkOwnerJwt(screened, env) : screened
}

/**
 * The owner-login door's judge (worker.mjs /_auth/owner): only the posted JWT, only an owner JWT (no issuer keys are
 * fetched here). In two steps, so the door makes no durable call for a JWT it can refuse on its face:
 * the returned answer is `refused` or `unavailable` (screenOwnerJwt, nothing checked), or `screened` with `check()`,
 * which runs the signature check (checkOwnerJwt) once the login gate has admitted the address.
 */
export function createOwnerLoginVerifier({ now = Date.now } = {}) {
  return (token, env) => {
    const screened = screenOwnerJwt(token, env, now())
    return screened.kind === 'screened' ? { kind: 'screened', check: () => checkOwnerJwt(screened, env) } : screened
  }
}

/**
 * Job 11, SHOULD 3: what the Worker's access verifier answers for an ambient owner JWT whose check reached NO VERDICT (the
 * Ed25519 check threw or answered anything but a boolean, or no usable clock): not access, and not "signed out" either.
 * Compared by identity; only a verifier made with `unverified: OWNER_JWT_UNVERIFIED` ever answers it.
 */
export const OWNER_JWT_UNVERIFIED = Object.freeze({ unverified: true })

/**
 * Create an issuer-key cache owned by one Worker service instance.
 * `unverified` (null): what an owner JWT whose check reached no verdict answers. Null for every caller but the Worker (so
 * a caller that treats any non-null answer as access is never handed anything new); the Worker passes OWNER_JWT_UNVERIFIED.
 */
export function createAccessVerifier({ fetchKeys = edgeFetchKeys, now = Date.now, unverified = null } = {}) {
  let cached = null
  return async function verifyAccess(request, env) {
    if (!ownerAccessConfigured(env)) return null
    const token = requestAssertion(request)
    if (!token) return null
    try {
      const parts = token.split('.')
      const header = parse(parts[0])
      const at = now()
      // An owner JWT is judged as the login door judges it; here nothing counts. Refused or checked wrong: no access (null).
      // No verdict: `unverified`.
      if (header.alg === 'EdDSA') {
        const judged = await judgeOwnerJwt(token, env, at)
        return judged.kind === 'ok' ? judged.identity : judged.kind === 'unavailable' ? unverified : null
      }
      if (!Number.isFinite(at)) return null
      const seconds = at / 1000
      if (header.alg !== 'RS256' || !accessConfigured(env) || typeof header.kid !== 'string' || header.kid.length > 256 || header.crit !== undefined || header.b64 !== undefined) return null
      if (!cached || cached.team !== env.ACCESS_TEAM || cached.until <= at) {
        const response = await fetchKeys(`https://${env.ACCESS_TEAM}/cdn-cgi/access/certs`, { redirect: 'error', signal: AbortSignal.timeout(5000) })
        if (!response.ok || response.redirected) return null
        const keySet = await response.json()
        if (!Array.isArray(keySet.keys) || keySet.keys.length > 20) return null
        cached = { team: env.ACCESS_TEAM, until: at + 300000, keys: keySet.keys }
      }
      const keys = cached.keys.filter(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'))
      if (keys.length !== 1) return null
      const signature = decode(parts[2])
      const checked = await proofOutcome(async () => crypto.subtle.verify('RSASSA-PKCS1-v1_5', await crypto.subtle.importKey('jwk', keys[0], { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
        signature, new TextEncoder().encode(parts[0] + '.' + parts[1])), { code: 'ACCESS_SIGNATURE_INVALID', unavailableCode: 'ACCESS_UNAVAILABLE' })
      if (!proofIs(checked, 'ok')) return null
      const claims = parse(parts[1])
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
      if (!audiences.includes(env.ACCESS_AUD) || claims.iss !== `https://${env.ACCESS_TEAM}` || !Number.isFinite(claims.exp) || claims.exp <= seconds || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds)) || typeof claims.email !== 'string' || claims.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) return null
      return { email: claims.email, expires: claims.exp, type: 'access' }
    } catch (error) {
      // Invalid assertions and unavailable issuer keys both fail closed, without token logging. Nothing here counts.
      return null
    }
  }
}
