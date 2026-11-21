/**
 * HER WITNESS RECORD AND ITS CHAIN. Pure functions: no storage, no network, no clock.
 *
 * One record per tick (every 4 hours), each naming the digest of the one before:
 *   { v: 2, seq, prev: <digest of record seq-1, 64 zeros for seq 1>, at: <ms>,
 *     facts: { head: { ballId, epoch } | null, receipts: { leafHash, rows } | null,
 *              journals: [ { path, bytes, last } ] | null, nightly: { set, sha256 } | null },
 *     missing: [ <one closed reason code per null fact, sorted> ] }
 *   digest = sha256hex(utf8(canonical(record))), with the ONE canonical form the voice memory uses (voice-memory.mjs).
 * The version rule. Two versions, each with its own exact set of facts, and both valid for ever:
 *  - v 1 (every record made before the nightly commitment): facts exactly head, receipts, journals. Its shape is frozen as it is.
 *  - v 2 (every record made since): the same three facts and `nightly`, the newest COMPLETE nightly copy of her cloud
 *    (nightly-copy.mjs: nightly/LATEST.json), as exactly its set name (a UTC time stamp, `2026-11-18T19-17-00Z`) and
 *    the SHA-256 of that set's manifest; or null with nightly-none, nightly-off or nightly-unavailable.
 * A v 1 record with a `nightly` fact, or a v 2 record without one, is not a record. A chain may hold both versions in
 * any order (a v 1 record after a v 2 one is what a rollback to an older build makes); a v 1 record commits to no copy.
 * `journals` names her append-only chain files as her mirror holds them, in a fixed order: each file's byte length and
 * the SHA-256 of its last line (an absent file is `bytes: 0, last: ""`). A fact that could not be read within its bound
 * is null with its reason; it is never guessed.
 *
 * Only the 32-byte digest of a record ever leaves her edge (to the timestamp calendars and, inside a signed event, to
 * five Nostr relays). The record itself stays in the witness object and is shown only to the owner (and to anyone at
 * /api/witness/record once WITNESS_RECORD_PUBLIC is "on"; it ships "off").
 *
 * The end of this file is HEAD's side (wired by the WITNESS hook in head-do.mjs): two internal routes with storage handed
 * in, the facts read and the sign route. The Worker never forwards an outside caller to either.
 */
import { canonical, recordDigest } from './voice-memory.mjs'
import { readMessagesIdentityInTransaction, signNodeEventInTransaction, verifyNostrEvent } from './messages-store.mjs'
import { readMirrorReceiptsHead } from './nostr-anchor.mjs'

/** The version every NEW record takes (2). Every version in WITNESS_VERSIONS stays valid for ever. */
export const WITNESS_VERSION = 2
export const WITNESS_VERSIONS = Object.freeze([1, 2])
export const WITNESS_ZERO = '0'.repeat(64)
/** The Nostr kind of a witness event: a regular kind (1000-9999), so relays keep every one and replace none. */
export const WITNESS_KIND = 4871
export const WITNESS_CHAIN_TAG = 'witness.v1'
/** Her append-only chain files, in record order. The timeline chain arrives with another lane; absent is bytes 0. */
export const WITNESS_JOURNAL_PATHS = Object.freeze(['/dsh/home/auma/voice/chain.v1.jsonl', '/dsh/home/auma/timeline/chain.v1.jsonl'])
/** The closed reasons a fact may be null for, per fact: version 1's facts (kept exactly as they were). */
export const WITNESS_MISSING = Object.freeze({
  head: Object.freeze(['head-none', 'head-unavailable']),
  receipts: Object.freeze(['receipts-unavailable']),
  journals: Object.freeze(['journals-over-bound', 'journals-unavailable']),
})
/**
 * The closed reasons the nightly fact may be null for: no complete set yet (none), the nightly copy switched off
 * (off), the pointer or its manifest not read and checked within the bound (unavailable).
 */
export const WITNESS_NIGHTLY_MISSING = Object.freeze(['nightly-none', 'nightly-off', 'nightly-unavailable'])
/** Version 2's closed reasons: version 1's and the nightly fact's. */
export const WITNESS_MISSING_V2 = Object.freeze({ ...WITNESS_MISSING, nightly: WITNESS_NIGHTLY_MISSING })
/** Each version's facts, in record order, and its closed reasons. */
const FACTS_OF = Object.freeze({ 1: Object.freeze(['head', 'receipts', 'journals']), 2: Object.freeze(['head', 'receipts', 'journals', 'nightly']) })
const MISSING_OF = Object.freeze({ 1: WITNESS_MISSING, 2: WITNESS_MISSING_V2 })
const knownVersion = v => WITNESS_VERSIONS.includes(v)

const HEX_64 = /^[0-9a-f]{64}$/
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const count = value => Number.isSafeInteger(value) && value >= 0
const refuse = code => { throw Object.assign(new Error(code), { code }) }

const validHead = head => head === null || (exactKeys(head, ['ballId', 'epoch']) && typeof head.ballId === 'string' && HEX_64.test(head.ballId) && count(head.epoch))
const validReceipts = receipts => receipts === null
  || (exactKeys(receipts, ['leafHash', 'rows']) && typeof receipts.leafHash === 'string' && HEX_64.test(receipts.leafHash) && count(receipts.rows) && receipts.rows >= 1)
const validJournals = journals => journals === null || (Array.isArray(journals) && journals.length === WITNESS_JOURNAL_PATHS.length
  && journals.every((journal, index) => exactKeys(journal, ['path', 'bytes', 'last']) && journal.path === WITNESS_JOURNAL_PATHS[index]
    && count(journal.bytes) && (journal.bytes === 0 ? journal.last === '' : typeof journal.last === 'string' && HEX_64.test(journal.last))))
/**
 * A nightly set name exactly as nightly-copy.mjs names a set: the UTC start time to the second, `:` written `-`,
 * and a real time (2026-02-30 is not one): it must name the time it reads as, character for character.
 */
const NIGHTLY_SET = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/
export function witnessNightlySetValid(set) {
  if (typeof set !== 'string' || !NIGHTLY_SET.test(set)) return false
  const time = Date.parse(set.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z'))
  return Number.isFinite(time) && new Date(time).toISOString().replace(/\.000Z$/, 'Z').replace(/:/g, '-') === set
}
/** The nightly fact: exactly { set, sha256 } (fingerprints only: a time stamp and 64 lower-case hex), or null. */
const validNightly = nightly => nightly === null
  || (exactKeys(nightly, ['set', 'sha256']) && witnessNightlySetValid(nightly.set) && typeof nightly.sha256 === 'string' && HEX_64.test(nightly.sha256))
/** Whether one fact's value has its shape (null included). */
export const witnessFactValid = (fact, value) => fact === 'head' ? validHead(value) : fact === 'receipts' ? validReceipts(value)
  : fact === 'journals' ? validJournals(value) : fact === 'nightly' ? validNightly(value) : false
/** Whether `facts` holds exactly version v's facts, each of its shape. */
const validFacts = (facts, v) => knownVersion(v) && exactKeys(facts, FACTS_OF[v]) && FACTS_OF[v].every(fact => witnessFactValid(fact, facts[fact]))

/** The `missing` list a version-v record with these facts must carry: one closed code per null fact, sorted. */
function missingFor(facts, reasons, v) {
  const out = []
  for (const fact of FACTS_OF[v]) {
    const reason = reasons[fact]
    if (facts[fact] !== null) {
      if (reason !== undefined) return null
      continue
    }
    if (!MISSING_OF[v][fact].includes(reason)) return null
    out.push(reason)
  }
  return out.sort()
}

/**
 * Whether `record` is a witness record exactly (shape, links rule for seq 1, missing matching its null facts), of
 * either version: v 1 with exactly its three facts, v 2 with exactly its four.
 */
export function validWitnessRecord(record) {
  if (!exactKeys(record, ['v', 'seq', 'prev', 'at', 'facts', 'missing']) || !knownVersion(record.v)) return false
  const v = record.v
  if (!Number.isSafeInteger(record.seq) || record.seq < 1 || !count(record.at)) return false
  if (typeof record.prev !== 'string' || !HEX_64.test(record.prev) || (record.seq === 1) !== (record.prev === WITNESS_ZERO)) return false
  if (!validFacts(record.facts, v) || !Array.isArray(record.missing)) return false
  const reasons = {}
  for (const code of record.missing) {
    const fact = FACTS_OF[v].find(name => MISSING_OF[v][name].includes(code))
    if (fact === undefined || Object.hasOwn(reasons, fact)) return false
    reasons[fact] = code
  }
  const expected = missingFor(record.facts, reasons, v)
  return expected !== null && canonical(expected) === canonical(record.missing)
}

/**
 * Build one record. A null fact takes its reason from `reasons` (a closed code of its version's list) or, with none
 * given, the fact's plain "-unavailable" code. Refuses WITNESS_RECORD_INVALID for anything outside the shape.
 * `v` names the version; left out, it is read from the facts (a `nightly` fact: 2; none: 1). The witness object
 * always passes v: WITNESS_VERSION, so every record it makes is a v 2 record or none.
 */
export function buildWitnessRecord({ seq, prev, at, facts, reasons = {}, v }) {
  if (!isObject(facts) || !isObject(reasons)) refuse('WITNESS_RECORD_INVALID')
  const version = v === undefined ? (Object.hasOwn(facts, 'nightly') ? 2 : 1) : v
  if (!knownVersion(version) || Object.keys(reasons).some(key => !FACTS_OF[version].includes(key))) refuse('WITNESS_RECORD_INVALID')
  const filled = { ...reasons }
  for (const fact of FACTS_OF[version]) if (facts[fact] === null && filled[fact] === undefined) filled[fact] = `${fact}-unavailable`
  if (!validFacts(facts, version)) refuse('WITNESS_RECORD_INVALID')
  const missing = missingFor(facts, filled, version)
  if (missing === null) refuse('WITNESS_RECORD_INVALID')
  const record = { v: version, seq, prev, at, facts: structuredClone(facts), missing }
  if (!validWitnessRecord(record)) refuse('WITNESS_RECORD_INVALID')
  return record
}

/** digest(record) = sha256hex(utf8(canonical(record))): what is stamped, what the event names, the next record's prev. */
export async function witnessDigest(record) {
  if (!validWitnessRecord(record)) refuse('WITNESS_RECORD_INVALID')
  return await recordDigest(record)
}

/**
 * Check a run of records from seq 1: each valid, seq without gaps, each prev the digest of the one before. Each
 * record is checked under its own version (v 1 and v 2 both), so an old chain, and an old chain with new records after
 * it, verify; the digest rule is the same for both.
 * @returns {Promise<{ok: true, seq: number, digest: string} | {ok: false, code: string, seq: number}>}
 */
export async function verifyWitnessChain(records) {
  let prev = WITNESS_ZERO, seq = 0
  for (const record of records) {
    if (!validWitnessRecord(record)) return { ok: false, code: 'WITNESS_RECORD_INVALID', seq: Number.isSafeInteger(record?.seq) ? record.seq : seq + 1 }
    if (record.seq !== seq + 1) return { ok: false, code: 'WITNESS_CHAIN_GAP', seq: record.seq }
    if (record.prev !== prev) return { ok: false, code: 'WITNESS_CHAIN_BROKEN', seq: record.seq }
    prev = await recordDigest(record)
    seq = record.seq
  }
  return { ok: true, seq, digest: prev }
}

/**
 * The unsigned Nostr event for record `seq`, built only from these closed values (HEAD calls this; no caller composes
 * an event): kind 4871, empty content, tags exactly e (the event of record seq-1; absent for seq 1), seq, digest, chain.
 */
export function witnessEventTemplate({ pubkey, createdAt, seq, digest, prevEventId }) {
  if (typeof pubkey !== 'string' || !HEX_64.test(pubkey) || !count(createdAt) || !Number.isSafeInteger(seq) || seq < 1
    || typeof digest !== 'string' || !HEX_64.test(digest)
    || (seq === 1 ? prevEventId !== null : typeof prevEventId !== 'string' || !HEX_64.test(prevEventId))) refuse('WITNESS_SIGN_INVALID')
  const tags = [...(seq === 1 ? [] : [['e', prevEventId]]), ['seq', String(seq)], ['digest', digest], ['chain', WITNESS_CHAIN_TAG]]
  return { pubkey, created_at: createdAt, kind: WITNESS_KIND, tags, content: '' }
}

/**
 * The owner's switch (wrangler.toml [vars] WITNESS_SWITCH). Only exactly "on" is on; anything else, or nothing, is off.
 * Off: the hourly tick makes no call, the witness object's tick answers WITNESS_OFF before any storage read or outbound
 * call, and HEAD's sign route signs nothing. (Named WITNESS_SWITCH because `WITNESS` is the witness object's binding.)
 */
export const witnessSwitchOn = env => env?.WITNESS_SWITCH === 'on'

// ---- HEAD's side: the two internal routes (head-do.mjs WITNESS hook) ----

export const WITNESS_HEAD_ROUTES = Object.freeze({ facts: '/_head/witness/facts', sign: '/_head/witness/sign' })
/** HEAD's memory of the last witness event it signed: { seq, id, digest, prevEventId, event }. One key, replaced. */
export const WITNESS_SIGNER_KEY = 'witness:signer:last'
export const WITNESS_HEAD_LIMITS = Object.freeze({ requestBytes: 1024 })

const headReply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
const headRefuse = (code, status) => { throw Object.assign(new Error(code), { code, status }) }
const bodyless = request => request.body === null && !request.headers.has('transfer-encoding') && (!request.headers.has('content-length') || request.headers.get('content-length') === '0')

async function boundedJson(request, limit) {
  const reader = request.body?.getReader()
  const chunks = []
  let size = 0
  try {
    if (reader) for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) { void reader.cancel().catch(() => {}); headRefuse('WITNESS_SIGN_INVALID', 400) }
      chunks.push(chunk.value)
    }
  } finally { reader?.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (_error) { headRefuse('WITNESS_SIGN_INVALID', 400) }
}

const validSigned = stored => exactKeys(stored, ['seq', 'id', 'digest', 'prevEventId', 'event']) && Number.isSafeInteger(stored.seq) && stored.seq >= 1
  && typeof stored.id === 'string' && HEX_64.test(stored.id) && typeof stored.digest === 'string' && HEX_64.test(stored.digest)
  && isObject(stored.event) && stored.event.id === stored.id

/**
 * The facts read: the selected head (ball id and epoch), the receipts head the mirror has verified for it (the Nostr
 * anchor's own read, readMirrorReceiptsHead), and the node's public key. Each fact HEAD cannot read is null with its
 * closed reason; the read itself always answers. Signs nothing and writes nothing.
 */
export async function readWitnessFacts({ storage, bootstrap, env, now = Date.now, readSelectedHead, signal }) {
  const reasons = {}
  let head = null, pubkey = null, receipts = null
  try {
    const selected = await storage.transaction(async tx => await readSelectedHead(tx))
    if (selected === null || selected === undefined) reasons.head = 'head-none'
    else if (isObject(selected) && typeof selected.ballId === 'string' && HEX_64.test(selected.ballId) && count(selected.epoch)) head = { ballId: selected.ballId, epoch: selected.epoch }
    else reasons.head = 'head-unavailable'
  } catch (_error) { reasons.head = 'head-unavailable' }
  try {
    const identity = await storage.transaction(async tx => await readMessagesIdentityInTransaction(tx))
    if (identity && typeof identity.pubkey === 'string' && HEX_64.test(identity.pubkey)) pubkey = identity.pubkey
  } catch (_error) { pubkey = null }
  if (head) {
    try {
      const read = await readMirrorReceiptsHead(env, { seedId: bootstrap.seedId, head, nowMs: now(), signal })
      if (validReceipts(read)) receipts = { leafHash: read.leafHash, rows: read.rows }
    } catch (_error) { receipts = null }
  }
  if (receipts === null) reasons.receipts = 'receipts-unavailable'
  return { seedId: bootstrap.seedId, pubkey, head, receipts, reasons }
}

/**
 * The sign route's one transaction. Refuses unless `seq` is exactly one more than the last witness seq this HEAD signed
 * and `prevEventId` is the id it returned then; a repeat of the SAME request answers the same stored event; the same seq
 * with anything else is a fork and is refused. The event is built here from the closed template only, signed through the
 * node's one signing path, re-verified, and remembered. Never provisions a key.
 */
export async function signWitnessEvent({ storage, input, now = Date.now }) {
  if (!exactKeys(input, ['seq', 'digest', 'prevEventId']) || !Number.isSafeInteger(input.seq) || input.seq < 1
    || typeof input.digest !== 'string' || !HEX_64.test(input.digest)
    || (input.seq === 1 ? input.prevEventId !== null : typeof input.prevEventId !== 'string' || !HEX_64.test(input.prevEventId))) headRefuse('WITNESS_SIGN_INVALID', 400)
  const { seq, digest, prevEventId } = input
  return storage.transaction(async tx => {
    const last = await tx.get(WITNESS_SIGNER_KEY)
    if (last !== undefined && !validSigned(last)) headRefuse('WITNESS_SIGNER_CORRUPT', 503)
    if (last?.seq === seq) {
      if (last.digest === digest && last.prevEventId === prevEventId) return last.event
      headRefuse('WITNESS_SIGN_FORK', 409)
    }
    if (seq !== (last?.seq ?? 0) + 1) headRefuse('WITNESS_SIGN_SEQ', 409)
    if (seq > 1 && prevEventId !== last.id) headRefuse('WITNESS_SIGN_PREV', 409)
    const identity = await readMessagesIdentityInTransaction(tx)
    if (!identity) headRefuse('WITNESS_IDENTITY_REQUIRED', 409)
    const clock = now()
    if (!count(clock)) headRefuse('WITNESS_CLOCK_UNAVAILABLE', 503)
    const createdAt = Math.max(Math.floor(clock / 1000), last?.event?.created_at ?? 0)
    const unsigned = witnessEventTemplate({ pubkey: identity.pubkey, createdAt, seq, digest, prevEventId })
    const event = await signNodeEventInTransaction(tx, unsigned)
    if (!await verifyNostrEvent(event) || canonical({ ...event, id: '', sig: '' }) !== canonical({ ...unsigned, id: '', sig: '' })) headRefuse('WITNESS_SIGNING_UNAVAILABLE', 503)
    await tx.put(WITNESS_SIGNER_KEY, { seq, id: event.id, digest, prevEventId, event })
    return event
  })
}

/**
 * HEAD's two witness routes (head-do.mjs WITNESS hook, after HEAD's internal-mark and bootstrap checks).
 * @param {Request} request Internal request from the witness object.
 * @param {object} context url, bootstrap ({seedId}), storage, env (MIRROR), now, readSelectedHead(tx).
 */
export async function handleWitnessHeadRoute(request, { url, bootstrap, storage, env, now = Date.now, readSelectedHead }) {
  try {
    if (request.headers.get('x-x6-internal-authorized') !== '1') return headReply({ ok: false, code: 'UNAUTHORIZED' }, 401)
    if (url.href.includes('?') || url.hash) return headReply({ ok: false, code: 'NOT_FOUND' }, 404)
    if (url.pathname === WITNESS_HEAD_ROUTES.facts) {
      if (request.method !== 'GET') return headReply({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
      if (!bodyless(request)) return headReply({ ok: false, code: 'WITNESS_REQUEST_INVALID' }, 400)
      return headReply({ ok: true, ...await readWitnessFacts({ storage, bootstrap, env, now, readSelectedHead, signal: request.signal }) })
    }
    if (url.pathname !== WITNESS_HEAD_ROUTES.sign) return headReply({ ok: false, code: 'NOT_FOUND' }, 404)
    if (request.method !== 'POST') return headReply({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
    // The owner's switch: off signs nothing (her node key never signs a witness event), whoever calls.
    if (!witnessSwitchOn(env)) return headReply({ ok: false, code: 'WITNESS_OFF' }, 503)
    const input = await boundedJson(request, WITNESS_HEAD_LIMITS.requestBytes)
    return headReply({ ok: true, event: await signWitnessEvent({ storage, input, now }) })
  } catch (error) {
    const code = typeof error?.code === 'string' && /^(?:WITNESS_|MESSAGES_)[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'WITNESS_SIGNING_UNAVAILABLE'
    const status = [400, 409, 503].includes(error?.status) ? error.status : 503
    return headReply({ ok: false, code: code === 'MESSAGES_IDENTITY_REQUIRED' ? 'WITNESS_IDENTITY_REQUIRED' : code }, status)
  }
}
