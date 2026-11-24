/** The owner mandate: one owner passkey, on exact terms, lets Auma do a closed list of reversible things for a
 * bounded number of times each UTC day, until a date at most 30 days away, while his tab is closed.
 * Pure, keyless policy, copied from night-grant.mjs. HEAD (head-do.mjs, MANDATE blocks) owns storage, the passkey
 * consumption and the one-transaction use. Nothing consumes a mandate yet: with his tab open his session stays the
 * authority, and no tool asks for one.
 * What it can NEVER express: merge, deploy, keys or secrets, deletes, domains, passkeys, head promotion. The scope set is
 * closed: any other string is refused at issue (MANDATE_SCOPE_UNKNOWN), so none of those can be granted at all.
 * Every refusal is closed and named, and a refusal writes nothing.
 */
import { canonicalJson } from '../../../server/ball-transition.mjs'

export const OWNER_MANDATE_SCHEMA = 'aukora.owner-mandate.v1'
export const OWNER_MANDATE_RECORD_SCHEMA = 'aukora.owner-mandate.record.v1'
export const OWNER_MANDATE_RECEIPT_SCHEMA = 'aukora.owner-mandate.receipt.v1'
export const OWNER_MANDATE_COUNT_SCHEMA = 'aukora.owner-mandate.count.v1'
export const OWNER_MANDATE_ROUTE = '/_head/mandate'
export const OWNER_MANDATE_KEY = 'head:owner-mandate'
export const OWNER_MANDATE_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
/** HEAD's clock and the page's may differ a little; an approval lives 5 minutes. */
export const OWNER_MANDATE_ISSUE_SKEW_MS = 10 * 60 * 1000
/** Status shows at most this many use receipts, newest first. */
export const OWNER_MANDATE_STATUS_RECEIPTS = 20

/** The closed scope set. Nothing outside it can be issued. */
export const OWNER_MANDATE_SCOPES = Object.freeze(['repo.read', 'repo.write.branch', 'exec.run', 'proposal.stage', 'linear.comment', 'relay.post', 'model.call'])
/** The counted kinds, in order, with the default bound, the hard ceiling and the one scope each belongs to. */
export const OWNER_MANDATE_KINDS = Object.freeze(['commits', 'branchCreates', 'execRuns', 'execMinutes', 'proposalStages', 'linearComments', 'relayPosts'])
export const OWNER_MANDATE_DEFAULT_PER_DAY = Object.freeze({ commits: 24, branchCreates: 8, execRuns: 24, execMinutes: 240, proposalStages: 12, linearComments: 24, relayPosts: 24 })
export const OWNER_MANDATE_CEILINGS = Object.freeze({ commits: 48, branchCreates: 16, execRuns: 48, execMinutes: 600, proposalStages: 24, linearComments: 48, relayPosts: 48 })
export const OWNER_MANDATE_KIND_SCOPE = Object.freeze({ commits: 'repo.write.branch', branchCreates: 'repo.write.branch', execRuns: 'exec.run',
  execMinutes: 'exec.run', proposalStages: 'proposal.stage', linearComments: 'linear.comment', relayPosts: 'relay.post' })
const TERM_FIELDS = Object.freeze(['schema', 'id', 'principal', 'agent', 'scopes', 'perDay', 'issuedAt', 'expiresAt', 'nonce'])
const SCOPE_WORDS = Object.freeze({ 'repo.read': 'read her repository', 'repo.write.branch': 'write on her own branches', 'exec.run': 'run jobs on the runner',
  'proposal.stage': 'stage proposal cards for you', 'linear.comment': 'comment in Linear', 'relay.post': 'post on the crew relay', 'model.call': 'call her model' })
const ID = /^[A-Za-z0-9_-]{16,64}$/
const NONCE = /^[A-Za-z0-9_-]{16,128}$/
const HEX_64 = /^[0-9a-f]{64}$/
const DAY_MS = 24 * 60 * 60 * 1000

/** Throw a public refusal; never includes request contents. */
export function ownerMandateFailure(code, status = 403, extra = {}) {
  throw Object.assign(new Error(code), { code, status, extra })
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const safeCount = (value, min, max) => typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max

/** The UTC day a time falls on, as YYYY-MM-DD; the day count rolls over at UTC midnight. */
export function ownerMandateDay(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The next UTC midnight after `ms`: when a reached bound opens again. */
export function ownerMandateNextDay(ms) {
  return (Math.floor(ms / DAY_MS) + 1) * DAY_MS
}

/** Validate the exact terms the owner approves. Nothing is defaulted, narrowed or widened.
 * @param {unknown} input Candidate terms from the request body.
 * @param {{ now: number }} context HEAD's clock, never the caller's.
 * @returns {object} Frozen copy of the terms.
 */
export function normalizeOwnerMandateTerms(input, { now }) {
  if (!exactKeys(input, TERM_FIELDS) || input.schema !== OWNER_MANDATE_SCHEMA) ownerMandateFailure('MANDATE_TERMS_INVALID', 400)
  if (typeof input.id !== 'string' || !ID.test(input.id) || typeof input.nonce !== 'string' || !NONCE.test(input.nonce)) ownerMandateFailure('MANDATE_TERMS_INVALID', 400)
  if (input.principal !== 'owner' || input.agent !== 'auma') ownerMandateFailure('MANDATE_TERMS_INVALID', 400)
  if (!Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > OWNER_MANDATE_SCOPES.length) ownerMandateFailure('MANDATE_TERMS_INVALID', 400)
  for (const scope of input.scopes) if (typeof scope !== 'string' || !OWNER_MANDATE_SCOPES.includes(scope)) ownerMandateFailure('MANDATE_SCOPE_UNKNOWN')
  if (new Set(input.scopes).size !== input.scopes.length) ownerMandateFailure('MANDATE_TERMS_INVALID', 400)
  if (!exactKeys(input.perDay, OWNER_MANDATE_KINDS)) ownerMandateFailure('MANDATE_TERMS_INVALID', 400)
  for (const kind of OWNER_MANDATE_KINDS) {
    const bound = input.perDay[kind]
    if (!safeCount(bound, 0, Number.MAX_SAFE_INTEGER)) ownerMandateFailure('MANDATE_TERMS_INVALID', 400)
    if (bound > OWNER_MANDATE_CEILINGS[kind]) ownerMandateFailure('MANDATE_BOUND_REFUSED')
  }
  if (!safeCount(now, 0, Number.MAX_SAFE_INTEGER) || !safeCount(input.issuedAt, 0, Number.MAX_SAFE_INTEGER)
    || !safeCount(input.expiresAt, 0, Number.MAX_SAFE_INTEGER)) ownerMandateFailure('MANDATE_TERMS_INVALID', 400)
  if (Math.abs(input.issuedAt - now) > OWNER_MANDATE_ISSUE_SKEW_MS) ownerMandateFailure('MANDATE_ISSUED_AT_REFUSED', 409)
  if (input.expiresAt <= now || input.expiresAt <= input.issuedAt) ownerMandateFailure('MANDATE_EXPIRED')
  if (input.expiresAt - input.issuedAt > OWNER_MANDATE_MAX_LIFETIME_MS) ownerMandateFailure('MANDATE_LIFETIME_REFUSED')
  return Object.freeze({ ...Object.fromEntries(TERM_FIELDS.map(key => [key, input[key]])),
    scopes: Object.freeze([...input.scopes]), perDay: Object.freeze(Object.fromEntries(OWNER_MANDATE_KINDS.map(kind => [kind, input.perDay[kind]]))) })
}

/** The canonical bytes the terms hash covers: exactly as the night grant makes them. */
export function ownerMandateCanonicalTerms(terms) {
  return canonicalJson(terms)
}

/** One plain-words description, shared by HEAD responses and the card (mandate.ts keeps a copy; a parity spec holds them equal). */
export function ownerMandatePlainWords(terms) {
  const until = new Date(terms.expiresAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const d = terms.perDay
  return Object.freeze([
    'Let Auma work while I am away.',
    `Until ${until}.`,
    `She may: ${OWNER_MANDATE_SCOPES.filter(scope => terms.scopes.includes(scope)).map(scope => SCOPE_WORDS[scope]).join(', ')}.`,
    `Each day at most: ${String(d.commits)} commits on her own branches, ${String(d.branchCreates)} new branches, ${String(d.execRuns)} runner jobs (${String(d.execMinutes)} minutes), ${String(d.proposalStages)} proposal cards, ${String(d.linearComments)} comments, ${String(d.relayPosts)} relay posts.`,
    'Never without my fingerprint: merge, deploy, keys, deletes.',
    `Mandate ${terms.id}. You can stop it at any time; stopping needs no fingerprint.`,
  ])
}

// ---- WAKE block begin ----
/** Every field of stored terms well formed, exactly as issue would have made them.
 * A stored record that is anything else (for example `terms: {}`) is never `active`: it reads as `invalid`. */
function storedTermsWellFormed(terms) {
  if (!exactKeys(terms, TERM_FIELDS) || terms.schema !== OWNER_MANDATE_SCHEMA || typeof terms.id !== 'string' || !ID.test(terms.id)
    || typeof terms.nonce !== 'string' || !NONCE.test(terms.nonce) || terms.principal !== 'owner' || terms.agent !== 'auma') return false
  if (!Array.isArray(terms.scopes) || terms.scopes.length < 1 || terms.scopes.length > OWNER_MANDATE_SCOPES.length
    || terms.scopes.some(scope => typeof scope !== 'string' || !OWNER_MANDATE_SCOPES.includes(scope)) || new Set(terms.scopes).size !== terms.scopes.length) return false
  if (!exactKeys(terms.perDay, OWNER_MANDATE_KINDS) || OWNER_MANDATE_KINDS.some(kind => !safeCount(terms.perDay[kind], 0, OWNER_MANDATE_CEILINGS[kind]))) return false
  return safeCount(terms.issuedAt, 0, Number.MAX_SAFE_INTEGER) && safeCount(terms.expiresAt, 0, Number.MAX_SAFE_INTEGER)
    && terms.expiresAt > terms.issuedAt && terms.expiresAt - terms.issuedAt <= OWNER_MANDATE_MAX_LIFETIME_MS
}
// ---- WAKE block end ----

/** Public state of a stored record at `now`; never reports an unusable mandate as active.
 * Nothing stored is `missing`; something stored that is not a well-formed record is `invalid` (MANDATE_STATE_INVALID). */
export function ownerMandateState(record, now) {
  if (record === undefined || record === null) return 'missing'
  if (!plain(record) || record.schema !== OWNER_MANDATE_RECORD_SCHEMA || !plain(record.terms) || !storedTermsWellFormed(record.terms)
    || !(record.revokedAt === null || safeCount(record.revokedAt, 0, Number.MAX_SAFE_INTEGER))) return 'invalid'
  if (record.revokedAt !== null) return 'revoked'
  if (!safeCount(now, 0, Number.MAX_SAFE_INTEGER) || now >= record.terms.expiresAt) return 'expired'
  return 'active'
}

const STATE_REFUSAL = Object.freeze({ missing: 'MANDATE_REQUIRED', revoked: 'MANDATE_REVOKED', expired: 'MANDATE_EXPIRED', invalid: 'MANDATE_STATE_INVALID' })
const STATE_STATUS = Object.freeze({ missing: 403, revoked: 403, expired: 403, invalid: 503 })

/** A day's counts, every kind present (missing or malformed storage counts from zero only when absent). */
export function ownerMandateCounts(stored, { mandateId, day }) {
  if (stored === undefined || stored === null) {
    return Object.freeze({ schema: OWNER_MANDATE_COUNT_SCHEMA, mandateId, day, seq: 0, ...Object.fromEntries(OWNER_MANDATE_KINDS.map(kind => [kind, 0])) })
  }
  if (!plain(stored) || stored.schema !== OWNER_MANDATE_COUNT_SCHEMA || stored.mandateId !== mandateId || stored.day !== day
    || !safeCount(stored.seq, 0, 9999) || OWNER_MANDATE_KINDS.some(kind => !safeCount(stored[kind], 0, OWNER_MANDATE_CEILINGS[kind]))) return null
  return Object.freeze({ schema: OWNER_MANDATE_COUNT_SCHEMA, mandateId, day, seq: stored.seq, ...Object.fromEntries(OWNER_MANDATE_KINDS.map(kind => [kind, stored[kind]])) })
}

/** Decide one spend of one or more counted kinds of one scope, all or nothing. Pure: no write; every refusal is closed. */
function decideSpend({ record, storedCounts, scope, parts, actionSha256, now }) {
  const refuse = (code, status = 403, extra = {}) => Object.freeze({ ok: false, code, status, ...extra })
  const state = ownerMandateState(record, now)
  if (state !== 'active') return refuse(STATE_REFUSAL[state], STATE_STATUS[state]) // A malformed record answers 503
  const { terms } = record
  if (typeof scope !== 'string' || !terms.scopes.includes(scope)) return refuse('MANDATE_OUT_OF_SCOPE')
  for (const [kind] of parts) {
    if (typeof kind !== 'string' || !OWNER_MANDATE_KINDS.includes(kind) || OWNER_MANDATE_KIND_SCOPE[kind] !== scope) return refuse('MANDATE_OUT_OF_SCOPE')
  }
  for (const [kind, units] of parts) if (!safeCount(units, 1, OWNER_MANDATE_CEILINGS[kind])) return refuse('MANDATE_USE_INVALID', 400)
  if (typeof actionSha256 !== 'string' || !HEX_64.test(actionSha256)) return refuse('MANDATE_USE_INVALID', 400)
  const day = ownerMandateDay(now)
  const counts = ownerMandateCounts(storedCounts, { mandateId: terms.id, day })
  if (counts === null) return refuse('MANDATE_STATE_INVALID', 503)
  for (const [kind, units] of parts) {
    if (counts[kind] + units > terms.perDay[kind]) return refuse('MANDATE_BOUND_REACHED', 429, { kind, retryAt: ownerMandateNextDay(now) })
  }
  if (counts.seq >= 9999) return refuse('MANDATE_BOUND_REACHED', 429, { kind: parts[0][0], retryAt: ownerMandateNextDay(now) })
  const seq = counts.seq + 1
  const next = Object.freeze({ ...counts, seq, ...Object.fromEntries(parts.map(([kind, units]) => [kind, counts[kind] + units])) })
  return Object.freeze({ ok: true, counts: next, day, seq, mandateId: terms.id,
    receiptKey: `${OWNER_MANDATE_KEY}:use:${terms.id}:${day}:${String(seq).padStart(4, '0')}`, countKey: ownerMandateCountKey(terms.id, day) })
}

const spent = (decision, receipt) => Object.freeze({ ok: true, counts: decision.counts, receipt: Object.freeze(receipt),
  receiptKey: decision.receiptKey, countKey: decision.countKey })

/** Decide one use. Pure: no write, and every refusal is one of the closed codes.
 * @returns {{ ok: true, counts: object, receipt: object, receiptKey: string, countKey: string }
 *   | { ok: false, code: string, status: number, kind?: string, retryAt?: number }}
 */
export function ownerMandateUse({ record, storedCounts, scope, kind, units, actionSha256, now }) {
  const decision = decideSpend({ record, storedCounts, scope, parts: [[kind, units]], actionSha256, now })
  if (!decision.ok) return decision
  return spent(decision, { schema: OWNER_MANDATE_RECEIPT_SCHEMA, kind: 'use', mandateId: decision.mandateId, scope, use: kind, units, actionSha256,
    day: decision.day, seq: decision.seq, at: now })
}

/** Decide ONE runner job: one of execRuns and `minutes` of execMinutes, both bounds checked, as a single use with one
 * receipt. Pure; a refusal for either bound spends neither (two separate uses could leave the first spent). */
export function ownerMandateUseExecJob({ record, storedCounts, minutes, actionSha256, now }) {
  const decision = decideSpend({ record, storedCounts, scope: 'exec.run', parts: [['execRuns', 1], ['execMinutes', minutes]], actionSha256, now })
  if (!decision.ok) return decision
  return spent(decision, { schema: OWNER_MANDATE_RECEIPT_SCHEMA, kind: 'use', mandateId: decision.mandateId, scope: 'exec.run', use: 'execJob',
    units: Object.freeze({ execRuns: 1, execMinutes: minutes }), actionSha256, day: decision.day, seq: decision.seq, at: now })
}

/** Where a day's counts live. */
export function ownerMandateCountKey(mandateId, day) {
  return `${OWNER_MANDATE_KEY}:count:${mandateId}:${day}`
}

/** The scopes that own a counted kind: their acts must spend a use, never pass on a cover check. */
export const OWNER_MANDATE_COUNTED_SCOPES = Object.freeze([...new Set(Object.values(OWNER_MANDATE_KIND_SCOPE))])

/** Read-only: whether the mandate covers a scope now, ONLY for the uncounted scopes (repo.read, model.call). Writes nothing.
 * A counted scope is answered MANDATE_USE_REQUIRED whatever the mandate holds: the caller must spend a use
 * (useOwnerMandate / useOwnerMandateExecJob), so this check can never pass a day bound without a count. */
export function ownerMandateCovers({ record, scope, now }) {
  // A malformed stored record answers MANDATE_STATE_INVALID to every question, the counted scopes' too.
  if (ownerMandateState(record, now) === 'invalid') return Object.freeze({ ok: false, code: 'MANDATE_STATE_INVALID', status: 503 })
  if (OWNER_MANDATE_COUNTED_SCOPES.includes(scope)) return Object.freeze({ ok: false, code: 'MANDATE_USE_REQUIRED', status: 409 })
  const state = ownerMandateState(record, now)
  if (state !== 'active') return Object.freeze({ ok: false, code: STATE_REFUSAL[state], status: STATE_STATUS[state] })
  if (typeof scope !== 'string' || !record.terms.scopes.includes(scope)) return Object.freeze({ ok: false, code: 'MANDATE_OUT_OF_SCOPE', status: 403 })
  return Object.freeze({ ok: true, mandateId: record.terms.id, expiresAt: record.terms.expiresAt })
}

// Host passes are a distinct owner-mandate kind, not Away/wake authority.
export const OWNER_HOST_PASS_KIND = 'host-pass'
export const OWNER_HOST_PASS_SCHEMA = 'aukora.owner-mandate.host-pass.v1'
export const OWNER_HOST_PASS_RECORD_SCHEMA = 'aukora.owner-mandate.host-pass.record.v1'
export const OWNER_HOST_PASS_KEY_PREFIX = 'head:owner-host-pass:'
export const OWNER_HOST_PASS_ROUTE = '/_head/mandate/host-pass'
export const OWNER_HOST_PASS_SCOPES = Object.freeze(['core.record', 'core.threads', 'core.tail', 'core.memory'])
const HOST_TERMS_FIELDS = Object.freeze(['schema', 'kind', 'id', 'hostLabel', 'threadId', 'scopes', 'durationDays', 'issuedAt', 'expiresAt', 'nonce'])
const HOST_RECORD_FIELDS = Object.freeze(['schema', 'kind', 'terms', 'passHash', 'revokedAt'])
const hostPassHashShape = value => typeof value === 'string' && HEX_64.test(value)

function hostPassTermsWellFormed(terms) {
  return exactKeys(terms, HOST_TERMS_FIELDS) && terms.schema === OWNER_HOST_PASS_SCHEMA && terms.kind === OWNER_HOST_PASS_KIND
    && typeof terms.id === 'string' && ID.test(terms.id) && typeof terms.nonce === 'string' && NONCE.test(terms.nonce)
    && typeof terms.hostLabel === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,47}$/.test(terms.hostLabel)
    && terms.hostLabel.trim() === terms.hostLabel && hostPassHashShape(terms.threadId) && Array.isArray(terms.scopes) && terms.scopes.length >= 1
    && terms.scopes.length <= OWNER_HOST_PASS_SCOPES.length && new Set(terms.scopes).size === terms.scopes.length
    && Array.from(terms.scopes).every(scope => OWNER_HOST_PASS_SCOPES.includes(scope))
    && (terms.durationDays === 1 || terms.durationDays === 7)
    && safeCount(terms.issuedAt, 0, Number.MAX_SAFE_INTEGER) && safeCount(terms.expiresAt, 0, Number.MAX_SAFE_INTEGER)
    && terms.expiresAt - terms.issuedAt === terms.durationDays * DAY_MS
}

export function normalizeOwnerHostPassTerms(input, { now }) {
  if (!hostPassTermsWellFormed(input) || !safeCount(now, 0, Number.MAX_SAFE_INTEGER)) {
    ownerMandateFailure('HOST_PASS_TERMS_INVALID', 400)
  }
  if (Math.abs(input.issuedAt - now) > OWNER_MANDATE_ISSUE_SKEW_MS || input.expiresAt <= now) {
    ownerMandateFailure('HOST_PASS_ISSUE_TIME_REFUSED', 409)
  }
  return Object.freeze({ ...Object.fromEntries(HOST_TERMS_FIELDS.map(key => [key, input[key]])),
    scopes: Object.freeze([...input.scopes]) })
}

/** The passkey card approves these exact terms using a host-pass-only approval purpose. */
export const ownerHostPassCanonicalTerms = terms => canonicalJson(terms)

export async function hashOwnerHostPass(token) {
  if (!hostPassHashShape(token)) return null
  const bytes = new TextEncoder().encode('aukora.core.read-pass.v0\n' + token)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** A candidate only: HEAD must consume approval and commit the record before returning the token. */
export async function draftOwnerHostPassIssue(input, { now }) {
  const terms = normalizeOwnerHostPassTerms(input, { now })
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
  const record = Object.freeze({ schema: OWNER_HOST_PASS_RECORD_SCHEMA, kind: OWNER_HOST_PASS_KIND,
    terms, passHash: await hashOwnerHostPass(token), revokedAt: null })
  return { record, token }
}

function ownerHostPassRecordValid(record) {
  return exactKeys(record, HOST_RECORD_FIELDS) && record.schema === OWNER_HOST_PASS_RECORD_SCHEMA
    && record.kind === OWNER_HOST_PASS_KIND && hostPassHashShape(record.passHash)
    && hostPassTermsWellFormed(record.terms)
    && (record.revokedAt === null || safeCount(record.revokedAt, 0, Number.MAX_SAFE_INTEGER))
}

export function ownerHostPassReadAllowed({ record, passHash, scope, now }) {
  return ownerHostPassRecordValid(record) && record.revokedAt === null && hostPassHashShape(passHash)
    && record.passHash === passHash && safeCount(now, 0, Number.MAX_SAFE_INTEGER)
    && record.terms.issuedAt <= now && now < record.terms.expiresAt && record.terms.scopes.includes(scope)
}

/** Pure revocation transition. The caller must verify a current owner session before storing it. */
export function revokeOwnerHostPassRecord(record, { now }) {
  if (!ownerHostPassRecordValid(record) || !safeCount(now, 0, Number.MAX_SAFE_INTEGER)) {
    ownerMandateFailure('HOST_PASS_REVOKE_REFUSED', 409)
  }
  return record.revokedAt === null ? Object.freeze({ ...record, revokedAt: now }) : record
}

/** For owner controls only. Never include a bearer, hash, nonce or approval token. */
export function ownerHostPassMetadata(record, { now }) {
  if (!ownerHostPassRecordValid(record) || !safeCount(now, 0, Number.MAX_SAFE_INTEGER)) return null
  const { id, hostLabel, threadId, scopes, durationDays, issuedAt, expiresAt } = record.terms
  return { id, hostLabel, threadId, scopes: [...scopes], durationDays, issuedAt, expiresAt, revokedAt: record.revokedAt,
    state: record.revokedAt !== null ? 'revoked' : now < issuedAt ? 'scheduled' : now < expiresAt ? 'active' : 'expired' }
}
