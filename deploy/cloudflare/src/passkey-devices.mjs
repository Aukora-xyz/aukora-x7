/**
 * PASSKEY DEVICES: more than one enrolled passkey for the one owner, so "any computer" does not depend on one passkey
 * syncing. Additive and reversible:
 *
 *   1. A signed-in owner approves "add a device" with an EXISTING passkey (Class 3 over the exact body
 *      `{action:'aumlok.device.add', label, expiresAt, generation}`, POST /_host/aumlok/device-code). HEAD answers a
 *      one-time code: 256 random bits, stored only as hashes, ten minutes, single use, burned after five wrong tries.
 *   2. The new computer opens `https://<origin>/_auth/passkey/add#<code>` (the fragment never reaches a server), or opens
 *      that page from the sign-in page's link and types the code, and runs a WebAuthn registration: the same RP id and user handle as the binding, every
 *      enrolled credential in `excludeCredentials` (a keychain that already holds one refuses instead of overwriting it),
 *      a resident key and user verification required.
 *   3. `POST /_auth/passkey/add/challenge` and `POST /_auth/passkey/add` carry the code (no session exists yet). HEAD
 *      verifies the registration with the bind ceremony's own verifier and keeps the new credential as JOINING only,
 *      in the pending record (never in aumlok:v1): it cannot sign in, cannot approve and does not count as enrolled; it
 *      lives ten minutes from its registration; a code holds at most one, and the code is spent by it. The new page
 *      shows a six-digit phrase from SHA-256 of the new key's canonical bytes and waits. The joining record carries a
 *      fresh JOINING INSTANCE (32 random bytes) minted at that registration: every confirm and decline names it, so an
 *      approval made for one joining can never confirm a later one, even of the same id and key.
 *   4. THE OWNER APPROVES THE EXACT KEY: a signed-in ENROLLED passkey (the primary or a device) sees "A new device asks
 *      to join" with the same phrase and confirms by Class 3 over `{action:'aumlok.device.confirm', deviceId, keyHash,
 *      instance, generation}`. Only then is the credential stored in the additive `devices` list beside `binding` in
 *      aumlok:v1, with an enrolment instance id minted there. A decline (owner session, `{action, deviceId, instance,
 *      generation}`) deletes the joining credential, and whenever a joining ends (declined, confirmed, replaced after
 *      its expiry, or its code's maker removed) every outstanding confirm approval for it is deleted in the same
 *      transaction. So a code
 *      taken in transit, or a registration sent for a key its sender does not hold, enrols nothing without the owner's
 *      fingerprint on a device he already has. `binding` keeps its shape and stays the primary; a store with no
 *      `devices` field loads and behaves exactly as before.
 *   5. Sign-in and Class 3 approvals accept any enrolled credential. No two enrolled credentials may hold the same key
 *      (compared as decoded key bytes). Removing a device is Class 3 by a DIFFERENT enrolled credential or the primary;
 *      the primary is never removable here; a removal ends that device's sessions, its outstanding approvals and any
 *      code it made, in one transaction. Every add, confirm, decline and remove appends to the AUMLOK audit.
 *
 * This module holds what both sides share: limits, routes, code and label rules, the pending-code record, the
 * registration options, the Worker's code-bearing door and the Worker's view of the enrolled public keys. The durable
 * judgement lives in the AUMLOK store (aumlok.mjs `devices`), which owns the state.
 */
import { isoBase64URL } from '@simplewebauthn/server/helpers'

/** Pending add codes live under their own storage key, apart from aumlok:v1: a code-bearing caller can move nothing else. */
export const PASSKEY_DEVICES_PENDING_KEY = 'aumlok:devices:pending:v1'
// `codeChallenges`: registration challenges one code may be given in its whole life. A live one is handed out again,
// never replaced, until it expires, with `publicKey.timeout` set to what is left of it; a new one only after expiry (or
// after a registration used it), and the next request past the bound ends the code.
export const PASSKEY_DEVICE_LIMITS = Object.freeze({ devices: 4, codeMs: 600000, codeMisses: 5, registrationMs: 120000, labelChars: 40,
  requestBytes: 16384, skewMs: 30000, userHandleBytes: 64, joinMs: 600000, credentialIdChars: 342, codeChallenges: 6 })
export const PASSKEY_DEVICE_ADD_ACTION = 'aumlok.device.add'
export const PASSKEY_DEVICE_REMOVE_ACTION = 'aumlok.device.remove'
export const PASSKEY_DEVICE_CONFIRM_ACTION = 'aumlok.device.confirm'
export const PASSKEY_DEVICE_DECLINE_ACTION = 'aumlok.device.decline'
export const PASSKEY_DEVICE_RECORD_SCHEMA = 'aumlok.device.v1'
export const PASSKEY_DEVICE_PENDING_SCHEMA = 'aukora.aumlok.device-pending.v2'
export const PASSKEY_DEVICE_ROUTES = Object.freeze({ list: '/_host/aumlok/devices', code: '/_host/aumlok/device-code', remove: '/_host/aumlok/device-remove',
  confirm: '/_host/aumlok/device-confirm', decline: '/_host/aumlok/device-decline', addChallenge: '/_auth/passkey/add/challenge', add: '/_auth/passkey/add' })
/**
 * Store actions. The first five need verified owner access (`devices` is a GET read; code, remove and confirm also a
 * Class 3 approval); the last two are the code-bearing door.
 */
export const PASSKEY_DEVICE_OWNER_ACTIONS = Object.freeze(['devices', 'device-code', 'device-remove', 'device-confirm', 'device-decline'])
export const PASSKEY_DEVICE_DOOR_ACTIONS = Object.freeze(['device-add-challenge', 'device-add'])
export const PASSKEY_DEVICE_ACTIONS = Object.freeze([...PASSKEY_DEVICE_OWNER_ACTIONS, ...PASSKEY_DEVICE_DOOR_ACTIONS])
/**
 * The link the owner carries to the new computer: the add page, the code in the FRAGMENT (never sent in an HTTP request).
 * It is its own page, not the sign-in page: the sign-in page never reads its URL (its pinned rule), and stays as it is.
 */
export const deviceLink = (origin, code) => origin + PASSKEY_DEVICE_ROUTES.add + '#' + code

const encoder = new TextEncoder()
const LOOKUP_DOMAIN = 'aukora.aumlok.device-code.lookup.v1\0'
const CODE_DOMAIN = 'aukora.aumlok.device-code.v1\0'
/** The first 11 characters (66 bits) find the pending code; the whole 256-bit code must then match its hash. */
const LOOKUP_CHARS = 11
const hex = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000

/** Canonical base64url, at most `max` characters. */
export function deviceB64(value, max) {
  if (typeof value !== 'string' || !value.length || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) return false
  try { return isoBase64URL.fromBuffer(isoBase64URL.toBuffer(value)) === value } catch (_error) { return false }
}
/** A one-time code: exactly 32 random bytes in canonical base64url (43 characters). */
export const deviceCodeShape = value => deviceB64(value, 43) && value.length === 43 && isoBase64URL.toBuffer(value).length === 32
/** A device label the owner reads back: letters, digits, spaces and a little punctuation, trimmed, 1-40 characters. */
export const deviceLabelValid = value => typeof value === 'string' && value === value.trim() && value.length >= 1
  && value.length <= PASSKEY_DEVICE_LIMITS.labelChars && /^[\p{L}\p{N} .,'()_-]+$/u.test(value)
/** An enrolment instance id: 32 random bytes in canonical base64url, minted when a device is confirmed. */
export const deviceInstanceValid = value => deviceB64(value, 43) && value.length === 43 && isoBase64URL.toBuffer(value).length === 32
/** A WebAuthn user handle: 1-64 bytes in canonical base64url. */
export const deviceUserHandleValid = value => deviceB64(value, 86) && isoBase64URL.toBuffer(value).length >= 1
  && isoBase64URL.toBuffer(value).length <= PASSKEY_DEVICE_LIMITS.userHandleBytes

/**
 * TRANSPORTS: how a browser reaches a passkey ('internal' on this computer, 'hybrid' through a phone, a USB or NFC key).
 * The store keeps the ones a registration (bind or add) reported, from the bind verifier's own list, so a sign-in
 * challenge can name them in `allowCredentials`. They are hints for the browser, never authority: nothing is judged by
 * them, and a credential with none recorded is offered exactly as before.
 */
export const PASSKEY_STORED_TRANSPORTS = Object.freeze(['usb', 'nfc', 'ble', 'internal', 'hybrid'])
/** A stored transports list: 1-8 distinct names from the store's list. */
export const storedTransportsValid = value => Array.isArray(value) && value.length >= 1 && value.length <= 8 && new Set(value).size === value.length
  && value.every(item => PASSKEY_STORED_TRANSPORTS.includes(item))
/**
 * The transports to keep from a registration answer (already shape-checked by the bind verifier): distinct known names,
 * in the order given, or null when it named none.
 * @param {object} credential The browser's registration answer.
 * @returns {string[]|null} The list, or null.
 */
export function registrationTransports(credential) {
  const named = credential?.response?.transports
  if (!Array.isArray(named)) return null
  const kept = [...new Set(named)].filter(item => PASSKEY_STORED_TRANSPORTS.includes(item)).slice(0, 8)
  return kept.length ? kept : null
}
/** The names a sign-in challenge may pass on (WebAuthn's list); anything else is dropped, never trusted. */
const HINT_TRANSPORTS = new Set([...PASSKEY_STORED_TRANSPORTS, 'smart-card'])
const hintTransports = value => Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(item => HINT_TRANSPORTS.has(item))
  ? Object.freeze([...new Set(value)]) : null

/** A fresh code and the two hashes stored for it (the code itself is never stored). */
export async function newDeviceCode() {
  const code = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)))
  return { code, lookup: await hex(LOOKUP_DOMAIN + code.slice(0, LOOKUP_CHARS)), codeHash: await hex(CODE_DOMAIN + code) }
}
/** The hashes a presented code is judged by. */
export async function deviceCodeHashes(code) {
  return { lookup: await hex(LOOKUP_DOMAIN + code.slice(0, LOOKUP_CHARS)), codeHash: await hex(CODE_DOMAIN + code) }
}

/**
 * THE CONFIRMATION PHRASE: six digits from the first four bytes of SHA-256 of the new key's canonical bytes (`keyHash`,
 * lowercase hex), in two groups of three. The new device shows it; the enrolled device shows the same phrase beside
 * "A new device asks to join", derived from the very `keyHash` its Class 3 approval names.
 * @param {string} keyHash 64 lowercase hex.
 * @returns {string} For example '048 213'.
 */
export function deviceKeyPhrase(keyHash) {
  if (!sha(keyHash)) throw new TypeError('AUMLOK_DEVICE_KEY_HASH_INVALID')
  const digits = String(parseInt(keyHash.slice(0, 8), 16) % 1000000).padStart(6, '0')
  return digits.slice(0, 3) + ' ' + digits.slice(3)
}

const credentialShape = value => exact(value, ['id', 'publicKeyB64', 'counter']) && deviceB64(value.id, PASSKEY_DEVICE_LIMITS.credentialIdChars)
  && deviceB64(value.publicKeyB64, 512) && Number.isSafeInteger(value.counter) && value.counter >= 0
/**
 * A joining credential: registered under the code, waiting for an enrolled device to confirm its exact key. `instance`
 * is this joining's own nonce, minted at its registration and named by every confirm and decline of it.
 */
const joiningValid = (value, pending) => exact(value, ['credential', 'keyHash', 'instance', 'transports', 'registeredAt', 'expiresAt'])
  && credentialShape(value.credential) && sha(value.keyHash) && deviceInstanceValid(value.instance) && (value.transports === null || storedTransportsValid(value.transports))
  && timestamp(value.registeredAt) && timestamp(value.expiresAt) && value.registeredAt >= pending.issuedAt && value.registeredAt < pending.expiresAt
  && value.expiresAt > value.registeredAt && value.expiresAt - value.registeredAt <= PASSKEY_DEVICE_LIMITS.joinMs

/** The empty pending record (no code outstanding). */
export const emptyDevicePending = () => ({ schema: PASSKEY_DEVICE_PENDING_SCHEMA, pending: null })
/**
 * Read the pending-code record strictly: at most ONE code is ever outstanding (issuing another replaces it).
 * @param {unknown} value The stored value, or undefined.
 * @returns {object|null} The record, or null when it is corrupt.
 */
export function readDevicePending(value) {
  if (value === undefined) return emptyDevicePending()
  if (!exact(value, ['schema', 'pending']) || value.schema !== PASSKEY_DEVICE_PENDING_SCHEMA) return null
  const pending = value.pending
  if (pending === null) return structuredClone(value)
  // `approvedInstance` is null when the primary approved the code, else the approving device's enrolment instance.
  // `joining` is null until the code is used by a registration; then the code is spent and the credential waits.
  // `challengesIssued` counts the registration challenges this code was given (at most `codeChallenges`).
  // `lapsed` (optional, written only once a challenge has lapsed unused and been renewed): the hashes of those earlier
  // challenges, one per renewal, so never more than the challenges the code was given.
  const lapsedPresent = object(pending) && Object.hasOwn(pending, 'lapsed')
  if (!exact(pending, ['lookup', 'codeHash', 'label', 'userHandle', 'approvedBy', 'approvedInstance', 'generation', 'issuedAt', 'expiresAt', 'misses',
    'challenge', 'challengeExpiresAt', 'challengesIssued', 'joining', ...(lapsedPresent ? ['lapsed'] : [])])
    || (lapsedPresent && (!Array.isArray(pending.lapsed) || pending.lapsed.length < 1 || pending.lapsed.length >= pending.challengesIssued
      || new Set(pending.lapsed).size !== pending.lapsed.length || !pending.lapsed.every(sha)))
    || !sha(pending.lookup) || !sha(pending.codeHash) || !deviceLabelValid(pending.label) || !deviceUserHandleValid(pending.userHandle) || !deviceB64(pending.approvedBy, 2048)
    || (pending.approvedInstance !== null && !deviceInstanceValid(pending.approvedInstance))
    || !Number.isSafeInteger(pending.generation) || pending.generation < 1 || !timestamp(pending.issuedAt) || !timestamp(pending.expiresAt)
    || pending.expiresAt <= pending.issuedAt || pending.expiresAt - pending.issuedAt > PASSKEY_DEVICE_LIMITS.codeMs
    || !Number.isSafeInteger(pending.misses) || pending.misses < 0 || pending.misses >= PASSKEY_DEVICE_LIMITS.codeMisses
    || (pending.challenge === null) !== (pending.challengeExpiresAt === null)
    || (pending.challenge !== null && (!deviceB64(pending.challenge, 43) || !timestamp(pending.challengeExpiresAt) || pending.challengeExpiresAt > pending.expiresAt))
    || !Number.isSafeInteger(pending.challengesIssued) || pending.challengesIssued < 0 || pending.challengesIssued > PASSKEY_DEVICE_LIMITS.codeChallenges
    || (pending.challenge !== null && pending.challengesIssued < 1)
    || (pending.joining !== null && (pending.challenge !== null || !joiningValid(pending.joining, pending)))) return null
  return structuredClone(value)
}

/**
 * The WebAuthn creation options for a new device: the binding's RP id and user handle, every enrolled credential
 * excluded, a resident key and user verification required, the bind ceremony's algorithms and attestation.
 * `timeout` is the challenge's REMAINING life in milliseconds (a challenge handed out again has less than its full two
 * minutes): the browser is never told it has longer than the node will accept the answer.
 */
export function deviceRegistrationOptions({ challenge, rpId, userHandle, label, excludeIds, timeout }) {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > PASSKEY_DEVICE_LIMITS.registrationMs) throw new RangeError('registration timeout out of range')
  return { challenge, rp: { id: rpId, name: 'AUKORA' }, user: { id: userHandle, name: 'AUMLOK identity', displayName: `AUMLOK identity (${label})` },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }], timeout,
    attestation: 'none', excludeCredentials: excludeIds.map(id => ({ type: 'public-key', id })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' } }
}

// ── The Worker's side ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The enrolled devices HEAD's `signin-key` names beside the primary: an optional `devices` list of public keys.
 * @param {object} body HEAD's answer.
 * @returns {object[]|null} The devices (empty when absent), or null when the list is malformed.
 */
export function signinKeyDevices(body) {
  if (!Object.hasOwn(body ?? {}, 'devices')) return []
  const devices = body.devices
  if (!Array.isArray(devices) || devices.length < 1 || devices.length > PASSKEY_DEVICE_LIMITS.devices
    || devices.some(item => !exact(item, Object.hasOwn(item ?? {}, 'transports') ? ['id', 'publicKeyB64', 'transports'] : ['id', 'publicKeyB64'])
      || !deviceB64(item.id, 2048) || !deviceB64(item.publicKeyB64, 512))) return null
  // A device's transports are optional hints: a malformed list is dropped, the device is kept.
  return devices.map(item => {
    const transports = hintTransports(item.transports)
    return { id: item.id, publicKeyB64: item.publicKeyB64, ...(transports === null ? {} : { transports }) }
  })
}
/**
 * The outstanding add code's lookup hash HEAD's `signin-key` names (absent when none is outstanding). A malformed value
 * names none, so the add door refuses every code and sign-in is never affected.
 * @param {object} body HEAD's answer.
 * @returns {string|null} The lookup hash, or null.
 */
export const signinKeyDeviceCode = body => sha(body?.deviceCode) ? body.deviceCode : null
/**
 * Every credential a sign-in challenge allows: the primary first, then each device, each with the transports its
 * registration recorded (the key's own already-checked lists; none named, none sent).
 */
export const signinAllowCredentials = key => [{ id: key.credentialId, transports: key.transports }, ...(key.devices ?? [])]
  .map(item => ({ type: 'public-key', id: item.id, ...(item.transports ? { transports: item.transports } : {}) }))
/** The enrolled public key for one credential id, or null. */
export function signinCredentialFor(key, id) {
  if (typeof id !== 'string') return null
  if (id === key.credentialId) return { id, publicKeyB64: key.publicKeyB64 }
  return (key.devices ?? []).find(item => item.id === id) ?? null
}

const doorJson = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
/**
 * MATCHING-CODE CHALLENGE ASKS ARE ADMITTED, NEVER ANSWERED, AT THE EDGE. Nothing HEAD said is kept here: every admitted
 * ask goes to HEAD, which hands a live challenge out again unchanged and judges the code, the challenge and every
 * registration. What this isolate bounds is how many asks with the SAME WHOLE CODE (by its full hash, never the 66-bit
 * lookup) it lets through: at most `perWindow` in any `windowMs`, concurrent or not. The next is refused at once with 429
 * AUMLOK_DEVICE_CHALLENGE_BUSY and Retry-After (whole seconds until the oldest admission leaves the window), with no HEAD
 * call. The record is plain data: per code hash, the admission times as numbers (at most `perWindow` of them), for at
 * most `codes` code hashes (the oldest let go first). It never holds a promise, a Response or a function.
 */
export const PASSKEY_DEVICE_CHALLENGE_ADMISSION = Object.freeze({ perWindow: 6, windowMs: 2000, codes: 8 })
/**
 * (Job 11 review.) THE REGISTRATION POSTS ARE BOUNDED THE SAME WAY, in their own record (`deviceAddAdmissions`), so a
 * registration is never stopped by challenge asks: since job 11 a screened registration (a wrong origin, RP id, type or
 * flag) costs the code no miss and keeps the challenge, so a holder of the whole code could otherwise send HEAD one
 * transaction after another for as long as the challenge lives. The bound moves no budget (no miss, nothing written); the
 * next is refused at once with 429 AUMLOK_DEVICE_ADD_BUSY and Retry-After, with no HEAD call.
 */
const ADMISSION_RECORDS = Object.freeze(['deviceChallengeAdmissions', 'deviceAddAdmissions'])

/**
 * Admit one matching-code challenge ask, or refuse it with its wait.
 * @param {object} keys The Worker's per-isolate sign-in cache (holds `deviceChallengeAdmissions`).
 * @param {string} codeHash The whole code's hash.
 * @param {number} at This isolate's clock now.
 * @param {string} [record] Which record: challenge asks (the default) or registration posts ('deviceAddAdmissions').
 * @returns {{ ok: true } | { ok: false, retryAfterSeconds: number }} The decision.
 */
export function admitDeviceChallengeAsk(keys, codeHash, at, record = 'deviceChallengeAdmissions') {
  if (!ADMISSION_RECORDS.includes(record)) throw new TypeError('unknown admission record')
  const { perWindow, windowMs, codes } = PASSKEY_DEVICE_CHALLENGE_ADMISSION
  const table = keys[record] instanceof Map ? keys[record] : new Map()
  keys[record] = table
  // Times outside the window (or ahead of a clock that went back) are let go; an empty row goes with them.
  for (const [hash, times] of table) {
    const kept = times.filter(time => typeof time === 'number' && time <= at && at - time < windowMs)
    if (kept.length === 0) table.delete(hash)
    else table.set(hash, kept)
  }
  const times = table.get(codeHash) ?? []
  if (times.length >= perWindow) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((times[0] + windowMs - at) / 1000)) }
  table.delete(codeHash)
  table.set(codeHash, [...times, at])
  while (table.size > codes) table.delete(table.keys().next().value)
  return { ok: true }
}

/**
 * THE CODE-BEARING DOOR: `POST /_auth/passkey/add/challenge {code}` and `POST /_auth/passkey/add {code, credential}`,
 * reachable without a session. Shape, size, origin and the code's form are judged HERE, and so is the code itself: the
 * Worker's cached sign-in key names the outstanding code's lookup hash (its first 66 bits), and a code that does not
 * match is refused with no HEAD call, re-reading the key at most once per ten seconds per isolate in the sign-in door's
 * own shared 'stale' bound. Only a caller holding the outstanding code's first 66 bits reaches HEAD (one bounded call),
 * where the whole code is judged and every wrong remainder counts toward the five misses that burn it.
 * @param {Request} request The incoming request.
 * @param {object} env The Worker environment.
 * @param {URL} url Its URL.
 * @param {string|null} origin Its Origin header.
 * THE SHARED SIGN-IN KEY IS NEVER EXPIRED HERE. The door only ever takes the ONE code hint it judged
 * spent out of the held value (`deviceCode`), keeping every piece of usable sign-in material, and only when the held value
 * still names exactly that code; then main's `invalidated()` (signinKeysInvalidated) stops any key read already in flight,
 * which may carry the spent hint, from publishing. A refusal of the code's remainder (AUMLOK_DEVICE_CODE_INVALID) does not
 * prove the code is spent and changes nothing. The seed id is forgotten only if it is still the one this request used.
 * @param {object} deps The Worker's own `forward`, `boundedRequest`, sign-in key cache `keys`, `keyFor(mode)` reader and
 *   `invalidated()` (the sign-in key cache's invalidation).
 * @returns {Promise<Response>} HEAD's answer, or a content-free refusal.
 */
export async function passkeyDeviceDoor(request, env, url, origin, { forward, boundedRequest, keys, keyFor, invalidated }) {
  if (url.search || url.hash) return doorJson({ ok: false, code: 'NOT_FOUND' }, 404)
  // The add page itself: static HTML, no durable call, nothing from the request reflected.
  if (request.method === 'GET' && url.pathname === PASSKEY_DEVICE_ROUTES.add && wantsDocument(request)) return passkeyDeviceAddPage()
  if (request.method !== 'POST') return doorJson({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
  if (origin !== url.origin || request.headers.get('sec-fetch-site') !== 'same-origin') return doorJson({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) return doorJson({ ok: false, code: 'AUMLOK_CONTENT_TYPE_REQUIRED' }, 400)
  let input = null
  try {
    const bounded = await boundedRequest(request, PASSKEY_DEVICE_LIMITS.requestBytes, true, 10000)
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded.arrayBuffer()))
  } catch (_error) { input = null }
  const adding = url.pathname === PASSKEY_DEVICE_ROUTES.add
  if (!exact(input, adding ? ['code', 'credential'] : ['code']) || (adding && !object(input.credential))) return doorJson({ ok: false, code: 'AUMLOK_DEVICE_REQUEST_INVALID' }, 400)
  if (!deviceCodeShape(input.code)) return doorJson({ ok: false, code: 'AUMLOK_DEVICE_CODE_INVALID' }, 403)
  // THE GATE: only the outstanding code's first 66 bits pass to HEAD. Everyone else costs no durable call at all.
  const { lookup, codeHash } = await deviceCodeHashes(input.code)
  let key = await keyFor('cached')
  if (key.ok && key.deviceCode !== lookup) key = await keyFor('stale')
  if (!key.ok) return doorJson({ ok: false, code: /^[A-Z0-9_]{1,80}$/.test(key.code ?? '') ? key.code : 'AUMLOK_UNAVAILABLE' }, [409, 503].includes(key.status) ? key.status : 503)
  if (key.deviceCode !== lookup) return doorJson({ ok: false, code: 'AUMLOK_DEVICE_CODE_INVALID' }, 403)
  // A holder of the whole code may ask for the challenge, and post a registration (job 11 review: a screened one costs no
  // miss), only so often from this isolate, each in its own record; every admitted request goes to HEAD.
  const admitted = admitDeviceChallengeAsk(keys, codeHash, Date.now(), adding ? 'deviceAddAdmissions' : 'deviceChallengeAdmissions')
  if (!admitted.ok) {
    const refused = doorJson({ ok: false, code: adding ? 'AUMLOK_DEVICE_ADD_BUSY' : 'AUMLOK_DEVICE_CHALLENGE_BUSY', retryAfterSeconds: admitted.retryAfterSeconds }, 429)
    refused.headers.set('retry-after', String(admitted.retryAfterSeconds))
    return refused
  }
  const internal = new Request(new URL('/_host/aumlok/' + (adding ? 'device-add' : 'device-add-challenge'), url), { method: 'POST', signal: request.signal,
    headers: { 'content-type': 'application/json', origin: url.origin, 'sec-fetch-site': 'same-origin',
      ...(request.headers.has('cf-connecting-ip') ? { 'cf-connecting-ip': request.headers.get('cf-connecting-ip') } : {}) },
    body: JSON.stringify(input) })
  // No access is forwarded: HEAD judges the code alone, and refuses every owner action without verified owner access.
  const answer = await forward(internal, env.HEAD, 'HEAD', key.seedId, null)
  let body = null
  try { body = await answer.json() } catch (_error) { body = null }
  if (body?.code === 'BOOTSTRAP_REQUIRED' && keys.seedId === key.seedId) keys.seedId = null
  if (!answer.ok || body?.ok !== true) {
    // The code is spent (burned, expired or its maker removed): the cache stops naming it, so the next stranger is refused here.
    if (['AUMLOK_DEVICE_CODE_BURNED', 'AUMLOK_DEVICE_CODE_EXPIRED', 'AUMLOK_DEVICE_CODE_REVOKED'].includes(body?.code)) forgetDeviceCode(keys, lookup, invalidated)
    return doorJson({ ok: false, code: typeof body?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code) ? body.code : 'AUMLOK_UNAVAILABLE' },
      answer.ok ? 503 : [400, 403, 404, 409, 429, 503, 507].includes(answer.status) ? answer.status : 503)
  }
  // The code is used (a credential now waits to be confirmed): this isolate's sign-in key must stop naming it.
  if (adding) forgetDeviceCode(keys, lookup, invalidated)
  return doorJson(body)
}

/**
 * Take one spent code's hint out of the held sign-in key: only if the held value is a usable key naming
 * exactly this code; every other field (the keys, credentials, devices, its lifetime) is kept. Then no read already in
 * flight (begun before this, possibly carrying the spent hint) may publish: main's own invalidation.
 * @param {object} keys The Worker's sign-in key cache.
 * @param {string} lookup The spent code's lookup hash.
 * @param {() => void} [invalidated] The cache's invalidation (signinKeysInvalidated).
 */
function forgetDeviceCode(keys, lookup, invalidated) {
  if (keys.value?.ok === true && keys.value.deviceCode === lookup) keys.value = { ...keys.value, deviceCode: null }
  if (typeof invalidated === 'function') invalidated()
}

/** A browser's own document request (a navigation), never a script's fetch. */
function wantsDocument(request) {
  const mode = request.headers.get('sec-fetch-mode'), destination = request.headers.get('sec-fetch-dest')
  if ((mode !== null && mode !== 'navigate') || (destination !== null && destination !== 'document')) return false
  return (request.headers.get('accept') || '').split(',').some(value => value.split(';')[0].trim().toLowerCase() === 'text/html')
}

/** The link the sign-in page shows (static markup; the sign-in page's script is not touched). */
export const PASSKEY_DEVICE_SIGNIN_LINK = `<p id="device-add-link"><a href="${PASSKEY_DEVICE_ROUTES.add}">Add this device with a one-time code</a></p>`
/**
 * The sign-in page's rule for that link, carried inside its one hashed style block (worker.mjs adds it at its marked
 * DEVICES hook). The values are the Spatial tokens the sign-in page itself names.
 */
export const PASSKEY_DEVICE_SIGNIN_LINK_STYLE = `
#device-add-link { margin-top: 16px; font-size: 0.9375rem; }
/* --dsw-static-spatial-blue, --aukora-text */
#device-add-link a { color: rgb(150, 180, 255); text-underline-offset: 3px; }
#device-add-link a:hover { color: rgb(232, 234, 237); }
`

/*
 * THE ADD PAGE WEARS THE SIGN-IN PAGE'S LOOK, carried by value: it loads no file and no font, and its CSP admits only this
 * block by its hash. Every value is the Spatial palette's (packages/client/ui-layout/src/client/spatial/spatial-tokens.css,
 * dark half), the design platform's (packages/client/ui-theme/src/styles/design-platform.css) or its base sheet's
 * (packages/client/ui-theme/src/styles/base.css), the same values the sign-in page (worker.mjs) names; each line names
 * the token it came from.
 */
const ADD_STYLE = `
* { box-sizing: border-box; }
:root {
  color-scheme: dark;
  /* --dsh-font-family-text-default (base.css) */
  font: 100%/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  /* --aukora-text */
  color: rgb(232, 234, 237);
  /* --aukora-background */
  background-color: rgb(11, 13, 24);
}
body {
  margin: 0; padding: 16px; min-height: 100vh; display: grid; place-items: center;
  /* --dsw-specific-spatial-canvas, dark: --dsw-static-spatial-night-900 / -850 / -950 under the mint, violet and blue glows */
  background:
    radial-gradient(1200px 800px at 18% -10%, rgba(129, 212, 180, 0.1), transparent 60%),
    radial-gradient(1100px 760px at 82% 110%, rgba(196, 170, 255, 0.12), transparent 60%),
    radial-gradient(900px 700px at 50% 50%, rgba(150, 180, 255, 0.07), transparent 65%),
    linear-gradient(160deg, rgb(9, 10, 18) 0%, rgb(11, 13, 24) 55%, rgb(8, 9, 16) 100%);
  background-color: rgb(11, 13, 24);
}
main {
  width: 100%; max-width: 26rem; padding: clamp(20px, 6vw, 36px);
  /* --dsw-specific-spatial-lane (dark) on --aukora-border, --dsw-radius-panel */
  background: rgba(255, 255, 255, 0.043); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 28px;
}
h1 {
  margin: 0; font-size: 1.75rem; font-weight: 600; letter-spacing: 0.12em; line-height: 1.2;
  /* --dsw-static-neutral-bluish-00 */
  color: rgb(255, 255, 255);
}
.lede {
  margin: 6px 0 24px; font-size: 1rem;
  /* --dsw-static-spatial-blue (--aukora-blue) */
  color: rgb(150, 180, 255);
}
p { margin: 0; overflow-wrap: anywhere; }
label, input, button { display: block; width: 100%; }
label { margin-top: 20px; font-weight: 500; }
input, button {
  margin-top: 8px; padding: 12px 16px; font: inherit; line-height: 1.4;
  /* --dsw-radius-md */
  border-radius: 12px;
  /* --ds-transition-duration, --ds-ease-in-out */
  transition: background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
input {
  /* --aukora-backdrop, --aukora-text-muted, --aukora-text */
  background: rgba(8, 9, 16, 0.56); border: 1px solid rgb(139, 144, 153); color: rgb(232, 234, 237);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.02em;
}
#device-add-submit {
  margin-top: 16px; padding: 14px 16px; cursor: pointer; font-weight: 600;
  /* --dsw-static-spatial-blue fill, --dsw-static-spatial-night-950 label */
  background: rgb(150, 180, 255); border: 1px solid rgb(150, 180, 255); color: rgb(8, 9, 16);
}
/* --dsw-static-deepseek-300 */
#device-add-submit:hover:not(:disabled) { background: rgb(183, 200, 254); border-color: rgb(183, 200, 254); }
button:disabled { cursor: wait; opacity: 0.6; }
/* --dsw-static-spatial-blue */
:focus-visible { outline: 3px solid rgb(150, 180, 255); outline-offset: 3px; }
#device-add-help {
  font-size: 0.9375rem;
  /* --aukora-text-secondary */
  color: rgb(184, 188, 196);
}
[role="status"] {
  margin-top: 12px; min-height: 3em;
  /* --aukora-text-secondary */
  color: rgb(184, 188, 196);
}
#device-phrase {
  margin-top: 16px; font-size: 2rem; font-weight: 600; letter-spacing: 0.18em; text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  /* --dsw-static-neutral-bluish-00 */
  color: rgb(255, 255, 255);
}
#device-signin, #device-back { margin-top: 16px; }
/* --dsw-static-spatial-blue, --aukora-text */
a { color: rgb(150, 180, 255); text-underline-offset: 3px; }
a:hover { color: rgb(232, 234, 237); }
noscript { display: block; margin-top: 16px; color: rgb(184, 188, 196); }
@media (prefers-reduced-motion: reduce) { input, button { transition: none; } }
@media (forced-colors: active) {
  main, input, button { border: 1px solid CanvasText; }
  :focus-visible { outline-color: Highlight; }
}
`

/** The add page's one script. It reads the code from the fragment, then removes it from the address bar. */
export const PASSKEY_DEVICE_ADD_SCRIPT = `
(() => {
  const input = document.getElementById('device-code');
  const button = document.getElementById('device-add-submit');
  const status = document.getElementById('device-add-status');
  const fragment = location.hash.slice(1);
  if (/^[A-Za-z0-9_-]{43}$/.test(fragment)) input.value = fragment;
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (!window.PublicKeyCredential || !navigator.credentials || typeof navigator.credentials.create !== 'function') {
    status.textContent = 'This browser cannot make a passkey here.';
    return;
  }
  const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
  const decode = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), character => character.charCodeAt(0));
  const post = (path, value) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
    redirect: 'error', cache: 'no-store', body: JSON.stringify(value) });
  const said = async response => { try { const body = await response.json(); return typeof body.code === 'string' ? body.code : ''; } catch (error) { return ''; } };
  const RAN_OUT = 'This attempt ran out of time, so nothing was counted against the code. Press the button to try again while the code lasts.';
  const RAN_OUT_EARLY = 'This attempt ran out of time before the passkey prompt could open, so nothing was counted against the code. Press the button to try again while the code lasts.';
  const refusal = code => code === 'AUMLOK_DEVICE_CHALLENGE_EXPIRED' ? RAN_OUT
    : code === 'AUMLOK_DEVICE_CHALLENGE_BUSY' ? 'This code was just asked for several times. Wait a few seconds, then press the button again. Nothing was counted against the code.'
    : code === 'AUMLOK_DEVICE_ADD_BUSY' ? 'This code was just tried several times. Wait a few seconds, then press the button again. Nothing was counted against the code.'
    : code === 'AUMLOK_DEVICE_CODE_EXPIRED' ? 'This code has expired. Make a new one in the Identity app.'
    : code === 'AUMLOK_DEVICE_CODE_BURNED' ? 'This code was tried too many times and no longer works. Make a new one.'
    : code === 'AUMLOK_DEVICE_CODE_REVOKED' ? 'The device that made this code was removed, so the code no longer works. Make a new one.'
    : code === 'AUMLOK_DEVICE_CAPACITY' ? 'This identity already has the most devices it can hold. Remove one first.'
    : code === 'AUMLOK_DEVICE_ALREADY_ENROLLED' || code === 'AUMLOK_DEVICE_KEY_ALREADY_ENROLLED' ? 'This passkey is already enrolled for this owner. Sign in with it.'
    : code === 'AUMLOK_ATTESTATION_UNSUPPORTED' ? 'This kind of passkey is not one this node accepts. Nothing was counted against the code. Try this device\u2019s own passkey (Touch ID, Face ID or the device lock).'
    : code === 'AUMLOK_DEVICE_CHALLENGE_UNKNOWN' || code === 'AUMLOK_DEVICE_CHALLENGE_REQUIRED' ? 'This attempt does not match the code\u2019s current request. Nothing was counted against the code. Press the button to try again while the code lasts.'
    : 'This node did not accept the code. Check it, or make a new one in the Identity app.';
  // A refusal the node answered in words changed nothing; anything else (no answer, no words, a server failure) is unknown.
  const refused = (response, code) => response.status >= 400 && response.status < 500 && /^[A-Z0-9_]{1,80}$/.test(code);
  const LOST = 'The answer was lost, so this page cannot tell whether the node kept this passkey. Never confirm a device whose phrase you did not see here: on your signed-in device, decline it in Identity, Your devices, and make a new code.';
  let busy = false;
  button.disabled = false;
  button.addEventListener('click', async () => {
    if (busy) return;
    const code = input.value.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) { status.textContent = 'Type the 43-character code from the Identity app.'; input.focus(); return; }
    busy = true;
    button.disabled = true;
    status.textContent = 'Checking the code with this node…';
    let sent = false, timer = 0, late = false;
    try {
      // The node counted key.timeout from when it answered, which is no earlier than when this request began: the time the
      // request took (a monotonic clock) is taken off before the prompt opens.
      const began = performance.now();
      const issued = await post(${JSON.stringify(PASSKEY_DEVICE_ROUTES.addChallenge)}, { code });
      if (issued.status !== 200) { status.textContent = refusal(await said(issued)); return; }
      const key = (await issued.json()).publicKey;
      const left = Math.floor(key.timeout - (performance.now() - began));
      if (!(left >= 1)) { status.textContent = RAN_OUT_EARLY; return; }
      status.textContent = 'Make the passkey (Touch ID, Face ID or your device lock).';
      // The prompt is ended at the node's deadline for this challenge, never left open past it.
      const stop = new AbortController();
      timer = setTimeout(() => { late = true; stop.abort(); }, left);
      const made = await navigator.credentials.create({ signal: stop.signal, publicKey: { challenge: decode(key.challenge), rp: key.rp,
        user: { id: decode(key.user.id), name: key.user.name, displayName: key.user.displayName }, pubKeyCredParams: key.pubKeyCredParams,
        timeout: left, attestation: key.attestation, authenticatorSelection: key.authenticatorSelection,
        excludeCredentials: key.excludeCredentials.map(item => ({ type: 'public-key', id: decode(item.id) })) } });
      clearTimeout(timer);
      if (late) { status.textContent = RAN_OUT; return; }
      if (!made) { status.textContent = 'No passkey was made. Nothing was sent.'; return; }
      const answer = made.response;
      const transports = typeof answer.getTransports === 'function' ? answer.getTransports().filter(item => ['usb', 'nfc', 'ble', 'internal', 'hybrid'].includes(item)) : [];
      const credential = { id: made.id, rawId: encode(made.rawId), type: made.type, clientExtensionResults: {},
        response: { clientDataJSON: encode(answer.clientDataJSON), attestationObject: encode(answer.attestationObject), ...(transports.length ? { transports } : {}) } };
      status.textContent = 'Sending this passkey to the node…';
      sent = true;
      const done = await post(${JSON.stringify(PASSKEY_DEVICE_ROUTES.add)}, { code, credential });
      if (done.status !== 200) { const answerCode = await said(done); status.textContent = refused(done, answerCode) ? refusal(answerCode) : LOST; return; }
      let joined = null;
      try { joined = await done.json(); } catch (error) { joined = null; }
      if (!joined || typeof joined.phrase !== 'string' || !/^[0-9]{3} [0-9]{3}$/.test(joined.phrase)) { status.textContent = LOST; return; }
      input.value = '';
      input.hidden = true;
      document.querySelector('label[for="device-code"]').hidden = true;
      button.hidden = true;
      const phrase = document.getElementById('device-phrase');
      phrase.textContent = joined.phrase;
      phrase.hidden = false;
      status.textContent = 'Waiting for your other device to confirm. On it, open Identity, Your devices: confirm only if it shows this same phrase. Then sign in here with this passkey.';
      document.getElementById('device-signin').hidden = false;
      document.getElementById('device-back').hidden = true;
    } catch (error) {
      clearTimeout(timer);
      status.textContent = sent ? LOST : late ? RAN_OUT : error && error.name === 'InvalidStateError'
        ? 'This device already holds a passkey for this owner. Sign in with it.'
        : 'No passkey was made. Nothing was sent.';
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
})();
`

const ADD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Add this device</title><style>${ADD_STYLE}</style></head>
<body><main><h1>AUKORA</h1><p class="lede">Add this device</p>
<p id="device-add-help">On a computer that is already signed in, the Identity app makes a one-time code. It works once, for ten minutes.</p>
<label for="device-code">One-time code</label>
<input id="device-code" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="43" aria-describedby="device-add-help">
<button id="device-add-submit" type="button" disabled>Make a passkey on this device</button>
<p id="device-phrase" hidden></p>
<p id="device-add-status" role="status" aria-live="polite" aria-atomic="true"></p>
<p id="device-signin" hidden><a href="/">Go to sign-in</a></p>
<p id="device-back"><a href="/">Back to sign-in</a></p>
<noscript>Enable JavaScript to add this device.</noscript></main><script>${PASSKEY_DEVICE_ADD_SCRIPT}</script></body></html>`

const pageHash = async text => "'sha256-" + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))))) + "'"
// Only the RESOLVED policy text is held between requests, never a pending promise (as the sign-in page's, worker.mjs):
// a promise left here by a request the runtime then cancels would never settle. A request that finds no text computes it.
let addPolicy = null
/** The add page: its one script and one style admitted by hash, never framed, never cached, no referrer. */
async function passkeyDeviceAddPage() {
  let policy = addPolicy
  if (policy === null) {
    const [script, style] = await Promise.all([pageHash(PASSKEY_DEVICE_ADD_SCRIPT), pageHash(ADD_STYLE)])
    policy = addPolicy = `default-src 'none'; base-uri 'none'; object-src 'none'; script-src ${script}; style-src ${style}; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`
  }
  return new Response(ADD_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': policy } })
}
