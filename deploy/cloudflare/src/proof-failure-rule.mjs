/**
 * THE ONE RULE FOR WHAT COUNTS AS A FAILURE, MADE STRUCTURAL.
 *
 *   A failure budget moves ONLY when a cryptographic proof presented for a known credential or key was checked and was
 *   WRONG. Nothing else ever moves any failure budget: not capacity, not expiry, not an unknown, used or replaced
 *   challenge or approval, not a malformed or oversized request, not a missing header, not a refusal by policy, not a
 *   verifier that threw or answered something other than a boolean.
 *
 * Earlier reviews each found a call site where the rule was written again and got wrong (a truthiness test, a catch-all, a
 * miss counted in a catch block). So the rule now lives in TWO functions of this module and nowhere else:
 *
 *   proofOutcome(run, terms)  the ONLY caller of any verifier. It awaits `run()` and returns a frozen outcome this module
 *                             alone can make (a module-private WeakSet brands it): `ok` only when the answer is the boolean
 *                             `true` (for the WebAuthn library: its `verified: true` with user verification); `wrong` only
 *                             when it is the boolean `false` (the library's `verified: false`); `unavailable` for
 *                             EVERYTHING else: ANY throw or rejection (the library's own throws too, see below),
 *                             undefined, null, {}, [], 1, 0, '', 'true', any other value.
 *   countFailure(outcome, ledger)  the ONLY place a budget, a lock field or a code's miss count changes. It THROWS (a
 *                             programming error) unless given a branded `wrong` outcome whose code the ledger counts.
 *   clearFailures(outcome, state)  the only reset of AUMLOK's passkey budget: it needs a branded `ok` passkey outcome.
 *
 * A KNOWN MALFORMED request never gets here: a parser refuses it first (400) and no verifier ever sees it.
 * TWO PHASES: a WebAuthn answer is SCREENED first (webauthn-screen.mjs: our own parse of its type, challenge,
 * origin, RP id hash, flags, credential and encodings; a mismatch is refused uncounted, never through this module), and
 * only then CHECKED here. The library checks those same things before its signature operation and reports each by
 * THROWING, so a library throw after a passing screen means it disagreed with the screen or something broke: never a
 * signature checked and wrong. No exception is ever turned into `wrong` (the source scan's rule (c) enforces it).
 * An outcome travels with its refusal by identity (`proofError`, `withProof`, `proofOf`), never by code and status, so a
 * refusal that merely LOOKS like a wrong proof (a stub, a copied JSON body, a policy refusal reusing a code) counts nothing.
 * The source-scan test (__tests__/proof-failure-rule.test.mjs) fails if any verifier is called, or any budget field
 * written, anywhere else in the files that take part in owner identity.
 *
 * Budgets: 'webauthn' and 'phrase' are AUMLOK's. `null` is a proof HEAD's gate counts but AUMLOK never sees (the owner's
 * hybrid signature on a signed action, checked against the configured owner keys). A code's miss count is the
 * add-device door's own budget (DEVICE_CODE_MISSES).
 * No clock, no storage of its own; the only awaits are the verifier it is handed and the gate store it is handed.
 * @module proof-failure-rule
 */

/** `[code, status, budget]`: the only refusals that move AUMLOK's or HEAD's budgets. `budget`: AUMLOK's 'webauthn' or 'phrase', or null (HEAD's gate only). */
export const PROOF_FAILURES = Object.freeze([
  // The bound passkey's (or an enrolled device's) assertion, checked by the WebAuthn verifier and refused by it. (The same
  // verdict on bind's registration step also counts; that step exists only before any owner is bound: once bound, a bind
  // challenge is refused as ENROLLMENT_ALREADY_BOUND, so it can never lock a bound owner out.)
  Object.freeze(['AUMLOK_PROOF_INVALID', 403, 'webauthn']),
  // The node key's Ed25519 signature over the ceremony's intent (bind, refresh), checked and wrong.
  Object.freeze(['AUMLOK_NODE_PROOF_INVALID', 403, 'webauthn']),
  // The node key's signature over an invite or a revocation, checked and wrong.
  Object.freeze(['AUMLOK_INVITE_SIGNATURE_INVALID', 403, 'webauthn']),
  // The recovery phrase's commitment, checked against the stored recovery MAC and wrong (the phrase budget).
  Object.freeze(['AUMLOK_RECOVERY_COMMITMENT_MISMATCH', 403, 'phrase']),
  // HEAD's gate only: the owner's Ed25519 + ML-DSA signature on a signed action (promote, ball), the
  // envelope well-formed and its key ids matching the configured owner keys, checked and wrong.
  Object.freeze(['HYBRID_SIGNATURE_INVALID', 403, null]),
  // HEAD's owner-login gate only: the owner JWT's Ed25519 signature, the JWT well-formed, in its window and for
  // this audience, issuer and owner, checked by the Worker (access.mjs) and wrong. It reaches HEAD as relayWrong's claim.
  Object.freeze(['OWNER_LOGIN_SIGNATURE_INVALID', 403, null]),
])
/** The add-device code's misses (passkey-devices.mjs): its remainder checked and wrong, or its registration judged wrong. */
export const DEVICE_CODE_MISSES = Object.freeze(['AUMLOK_DEVICE_CODE_INVALID', 'AUMLOK_PROOF_INVALID'])

const listed = refusal => {
  const code = refusal?.code, status = refusal?.status
  if (typeof code !== 'string' || typeof status !== 'number') return undefined
  return PROOF_FAILURES.find(([entry, entryStatus]) => entry === code && entryStatus === status)
}

/**
 * Which of AUMLOK's budgets a refusal's code and status name, if any. A NAME ONLY: nothing moves by it (countFailure
 * moves a budget, and only for a branded outcome).
 * @param {{ code?: unknown, status?: unknown } | null | undefined} refusal A refusal's code and HTTP status.
 * @returns {'webauthn' | 'phrase' | null} The budget, or null.
 */
export function proofFailureBudget(refusal) {
  return listed(refusal)?.[2] ?? null
}

/**
 * Whether a refusal's code and status are on the list (a NAME ONLY, as proofFailureBudget).
 * @param {{ code?: unknown, status?: unknown } | null | undefined} refusal A refusal's code and HTTP status.
 * @returns {boolean} Whether it is a listed proof refusal.
 */
export const countsAsProofFailure = refusal => listed(refusal) !== undefined

// ── The outcomes. Nothing outside this module can make one: the brand is this WeakSet, which is never exported. ──
const branded = new WeakSet()
const carried = new WeakMap()
const make = fields => {
  const outcome = Object.freeze(fields)
  branded.add(outcome)
  return outcome
}
const is = (value, kind) => branded.has(value) && value.kind === kind
/** A programming error: the rule's own functions were used against the rule. Never a refusal a request can cause. */
const violation = what => Object.assign(new TypeError('PROOF_RULE_VIOLATION: ' + what), { code: 'PROOF_RULE_VIOLATION' })

/**
 * Run ONE verifier and classify its answer. The only place in owner identity a verifier is called.
 * @param {() => unknown} run Calls the verifier (crypto.subtle.verify, the WebAuthn library, Ed25519, ML-DSA, an HMAC or
 *   hash comparison used as a proof check) and returns its answer as it is.
 * @param {object} terms `code` (required): the stable refusal code a WRONG answer is refused with; `status` (403);
 *   `unavailableCode` ('AUMLOK_UNAVAILABLE'): the code of a 503 when no verdict was reached; `judge`: 'boolean' (the
 *   answer itself must be a boolean), 'webauthn-authentication' or 'webauthn-registration' (the library's result object:
 *   its `verified` must be the boolean, and on true its info must say the user was verified). Under every judge a throw
 *   or a rejection is `unavailable`.
 * @returns {Promise<object>} A frozen, branded outcome: { kind: 'ok', value } | { kind: 'wrong', code, status, reason }
 *   | { kind: 'unavailable', code, status: 503 }.
 */
export async function proofOutcome(run, { code, status = 403, unavailableCode = 'AUMLOK_UNAVAILABLE', judge = 'boolean' } = {}) {
  if (typeof run !== 'function' || typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{1,79}$/.test(code) || status !== 403
    || typeof unavailableCode !== 'string' || !['boolean', 'webauthn-authentication', 'webauthn-registration'].includes(judge)) throw violation('proofOutcome terms')
  const unavailable = () => make({ kind: 'unavailable', code: unavailableCode, status: 503 })
  const wrong = reason => make({ kind: 'wrong', code, status, reason })
  let answer
  // AN EXCEPTION IS NEVER A WRONG SIGNATURE: whatever was thrown, no verdict was reached.
  try { answer = await run() } catch (_error) { return unavailable() }
  if (judge === 'boolean') return answer === true ? make({ kind: 'ok', value: true }) : answer === false ? wrong('verdict') : unavailable()
  // The library's result: `verified` strictly boolean; on true, the verified-user flag it reports must be true as well
  // (both ceremonies require user verification, so anything else means the library did not do what it was asked).
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return unavailable()
  if (answer.verified === false) return wrong('verdict')
  if (answer.verified !== true) return unavailable()
  const info = judge === 'webauthn-authentication' ? answer.authenticationInfo : answer.registrationInfo
  if (info === null || typeof info !== 'object' || info.userVerified !== true) return unavailable()
  return make({ kind: 'ok', value: answer })
}

/** Whether `value` is a branded outcome of this kind ('ok', 'wrong', 'unavailable'). */
export const proofIs = (value, kind) => is(value, kind)

/**
 * The refusal an outcome stands for, as an Error carrying the outcome by identity (`proofOf(error)` finds it).
 * @param {object} outcome A branded `wrong` or `unavailable` outcome.
 * @returns {Error} code and status set; a `wrong` outcome travels with it.
 */
export function proofError(outcome) {
  if (!is(outcome, 'wrong') && !is(outcome, 'unavailable')) throw violation('proofError needs a wrong or unavailable outcome')
  const error = Object.assign(new Error(outcome.code), { code: outcome.code, status: outcome.status })
  if (outcome.kind === 'wrong') carried.set(error, outcome)
  return error
}

/**
 * Use an outcome: `ok` gives the verifier's answer, anything else throws its refusal (proofError).
 * @param {object} outcome A branded outcome.
 * @returns {unknown} The `ok` outcome's value.
 */
export function settleProof(outcome) {
  if (is(outcome, 'ok')) return outcome.value
  throw proofError(outcome)
}

/**
 * Attach a branded `wrong` outcome to a refusal object or error (a result answered in place of a throw), so the code that
 * counts can find it by identity. Anything else attaches nothing.
 * @param {object} target The refusal.
 * @param {object|null} outcome A branded `wrong` outcome, or null.
 * @returns {object} The same target.
 */
export function withProof(target, outcome) {
  if (target !== null && typeof target === 'object' && is(outcome, 'wrong')) carried.set(target, outcome)
  return target
}

/**
 * The branded `wrong` outcome a refusal carries, or null. A refusal made any other way (a plain object or error with the
 * same code and status) carries none.
 * @param {unknown} target A refusal object or error.
 * @returns {object|null} The outcome.
 */
export const proofOf = target => (target !== null && typeof target === 'object' && carried.get(target)) || null

/**
 * THE ONE PROOF OUTCOME THAT CROSSES A PROCESS BOUNDARY. The brand cannot cross JSON, so the Worker's checked-wrong
 * owner-JWT signature travels to HEAD's login gate as a closed field of the internal call: `relayWrong(outcome)` is its
 * only source (it needs the branded `wrong` outcome itself), `relayedWrong(claim)` its only reader (HEAD's
 * /_head/gate-lockout route; the source scan allows it nowhere else). The claim's text lives in this module only.
 * WHY HEAD MAY BELIEVE IT: HEAD is a Durable Object with no public address; its only caller is this Worker's binding, and
 * HEAD admits nothing without the internal header the Worker sets. The Worker forwards a client's request to HEAD only on
 * an allow-list of paths, and /_head/gate-lockout is not on it (it falls to the Worker's catch-all refusal), so the only
 * request that ever reaches that route is the one ownerLoginGate (worker.mjs) builds itself after its own check.
 */
const RELAYED = Object.freeze({ OWNER_LOGIN_SIGNATURE_INVALID: 'aukora.owner-login.ed25519-checked-wrong.v1' })

/**
 * The closed field the Worker sends HEAD for a branded `wrong` outcome whose code may be relayed.
 * @param {object} outcome A branded `wrong` outcome (OWNER_LOGIN_SIGNATURE_INVALID). Anything else throws PROOF_RULE_VIOLATION.
 * @returns {string} The claim.
 */
export function relayWrong(outcome) {
  if (!is(outcome, 'wrong') || !Object.hasOwn(RELAYED, outcome.code)) throw violation('relayWrong needs a relayable branded wrong outcome')
  return RELAYED[outcome.code]
}

/**
 * HEAD's reading of the Worker's closed field: the branded `wrong` outcome it names, or null for anything that is not
 * exactly one of the claims (a missing field, another string, any other value).
 * @param {unknown} claim The field as HEAD received it.
 * @returns {object|null} A branded `wrong` outcome, or null.
 */
export function relayedWrong(claim) {
  const code = typeof claim === 'string' ? Object.keys(RELAYED).find(key => RELAYED[key] === claim) : undefined
  return code === undefined ? null : make({ kind: 'wrong', code, status: 403, reason: 'relayed' })
}

/**
 * THE ONLY PLACE A FAILURE BUDGET MOVES.
 * @param {object} outcome A branded `wrong` outcome. Anything else throws PROOF_RULE_VIOLATION.
 * @param {object} ledger Which budget:
 *   { kind: 'aumlok', state, at, limits }: AUMLOK's 'webauthn' or 'phrase' budget (by the outcome's listed code), in place;
 *   { kind: 'gate', store, subject }: HEAD's owner gate (a listed code), through the gate store's recordFailure;
 *   { kind: 'device-code', pending }: the add-device code's misses (DEVICE_CODE_MISSES), in place.
 * @returns {unknown} The gate store's decision; the code's misses after the count; nothing for AUMLOK.
 */
export function countFailure(outcome, ledger) {
  if (!is(outcome, 'wrong')) throw violation('countFailure needs a branded wrong outcome')
  if (ledger?.kind === 'aumlok') {
    const budget = proofFailureBudget(outcome)
    if (budget !== 'webauthn' && budget !== 'phrase') throw violation(`${outcome.code} moves no AUMLOK budget`)
    const { state, at, limits } = ledger
    const [count, history, next] = budget === 'phrase' ? ['phraseFailures', 'phraseFailedAt', 'phraseNextAllowedAt'] : ['failures', 'failedAt', 'nextAllowedAt']
    state[count] = Math.min(limits.hardLockFailures, state[count] + 1)
    state[history] = [...state[history].filter(value => value > at - 3600000), at]
    state[next] = at + limits.backoffMs * 2 ** (state[count] - 1)
    return undefined
  }
  if (ledger?.kind === 'gate') {
    if (!countsAsProofFailure(outcome)) throw violation(`${outcome.code} moves no gate`)
    return ledger.store.recordFailure(ledger.subject)
  }
  if (ledger?.kind === 'device-code') {
    if (!DEVICE_CODE_MISSES.includes(outcome.code) || outcome.status !== 403) throw violation(`${outcome.code} is no miss`)
    ledger.pending.misses++
    return ledger.pending.misses
  }
  throw violation('unknown ledger')
}

/**
 * The only reset of AUMLOK's passkey budget: a fresh, cryptographically verified passkey assertion (a branded `ok` from a
 * WebAuthn judge). The phrase budget is never reset.
 * @param {object} outcome A branded `ok` WebAuthn outcome.
 * @param {object} state aumlok:v1, changed in place.
 */
export function clearFailures(outcome, state) {
  if (!is(outcome, 'ok') || outcome.value === true) throw violation('clearFailures needs a verified passkey')
  state.failures = 0
  state.failedAt = []
  state.nextAllowedAt = 0
}
