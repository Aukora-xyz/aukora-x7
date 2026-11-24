/**
 * THE WITNESS OBJECT. Her record gets two outside holders: Bitcoin, through the OpenTimestamps
 * calendars ("this fingerprint existed by this block"), and five public Nostr relays (three until the promotion records) holding a chained series of signed
 * fingerprint events. Only 32-byte fingerprints leave: no content, no titles, no counts of what she did.
 *
 * Its own Durable Object (binding WITNESS), so a witness defect cannot touch HEAD's or the mirror's storage. It alone
 * stores witness state (records, proofs, events, relay answers) and it alone makes the outbound calls. Routes, all
 * internal (the Worker never forwards an outside caller to /_witness/*):
 *  - POST /_witness/tick: one bounded pass, no loops, no waiting on Bitcoin, no error escapes (the answer is counts and
 *    closed codes). (a) Upgrade: proofs pending at least an hour, at most 6 calendar GETs a tick, only https hosts under
 *    the reference client's calendar list; a reply holding a Bitcoin attestation is spliced in (confirmed, with its
 *    height); after 14 days a proof is stale and no longer tried. (b) Retry: a failed stamp again with the SAME nonce, and
 *    unpublished events to the relays not yet ok, at most 3 attempts each, ever; unsigned records are signed in order
 *    from the oldest (no outbound call: HEAD signs). (c) A new record only if none exists or the newest is at least
 *    3 h 59 min old: facts from HEAD (one internal read) and the mirror (one bounded read), then stamp, sign, publish.
 *    the nightly commitment: and, beside those reads, the newest COMPLETE nightly copy (readNightlyFact: nightly/LATEST.json and its
 *    manifest in ARCHIVE_BUCKET, the manifest's SHA-256 checked, at most about 5 s), so every new record (v 2) commits
 *    to the whole copy of her cloud; a pointer not read in time is the fact null with a closed reason, never a stall.
 *    (d) the promotion records, read-back: the newest published records (at most 4 a tick) ask each relay for their event by id, each
 *    relay at most once per record per 6 h; the public row shows how many relays HELD it beside how many accepted it.
 *    (e) the header check, hourly only: a confirmed proof is checked against the Bitcoin block header itself (bitcoin-header.mjs),
 *    from two explorers run by unrelated operators (a third only when one fails); at most 2 records a tick. Only block
 *    heights and block hashes leave. The public row shows `ots.header`.
 *    (f) the header check, while WITNESS_TSA is exactly "on": one RFC 3161 request to freetsa.org for each new record's digest (and,
 *    hourly, one older record), at most 3 tries per record; the reply is STORED and sanity-read (tsa.mjs), never checked
 *    as a signature here. The public row shows `tsa`; GET /_witness/tsa?seq=n gives the stored reply.
 *  - POST /_witness/kick: HEAD's word that a promotion committed. Answers at once and sets the alarm 15 s ahead
 *    (an earlier alarm is kept); alarm() runs one promotion-triggered tick, which makes a record without the 4-hour spacing
 *    only when HEAD's head differs from the newest record's, at least 60 s after it, at most 24 such records a rolling day.
 *  - GET /_witness/public: what the signed-out door serves (never facts, never the missing list, never the nonce).
 *  - GET /_witness/record?seq=n: the whole record with its facts, for the owner door.
 *  - GET /_witness/ots?seq=n: the stored `.ots` bytes.
 * The event for record n is built and signed by HEAD (/_head/witness/sign, witness.mjs), never by a caller.
 *
 * The end of this file is the Worker's side: the signed-out door (GET /api/witness and /api/witness/ots?seq=n, built
 * like the Nostr door), the owner's read of one whole record, and the hourly tick the `scheduled` handler runs.
 */
import { NIGHTLY_PAGE_ROUTE, nightlyPageResponse, nightlySha256 } from './nightly-copy.mjs'
import { WITNESS_CHAIN_TAG, WITNESS_HEAD_ROUTES, WITNESS_KIND, WITNESS_VERSION, WITNESS_ZERO, buildWitnessRecord, validWitnessRecord, witnessDigest, witnessFactValid,
  witnessNightlySetValid, witnessSwitchOn } from './witness.mjs'
import { OTS_LIMITS, bitcoinAttestations, buildDetached, parseOts, parseTree, pendingLeaves, spliceUpgrade, stampCommitment, treeBitcoinHeights, treeHasBitcoin, treeHasPending } from './ots.mjs'
import { verifyNostrEvent } from './messages-store.mjs'
import { createSharedCalls, SHARED_CALL_BUSY, SHARED_CALL_MAX_WAITS, SHARED_CALL_WAIT_MS } from './shared-call.mjs'
import { headerHash, leadingZeroBits, meetsOwnTarget, parseHeader, rebuildHeader } from './bitcoin-header.mjs'
import { TSA_AUTHORITY, TSA_QUERY_TYPE, TSA_REPLY_BYTES, TSA_REPLY_TYPE, TSA_URL, sanityReadReply, timestampQuery, tsaNonce } from './tsa.mjs'

export const WITNESS_ROUTES = Object.freeze({ tick: '/_witness/tick', kick: '/_witness/kick', public: '/_witness/public', record: '/_witness/record', ots: '/_witness/ots', tsa: '/_witness/tsa' })
export const WITNESS_MIRROR_ROUTE = '/_mirror/witness-journals'
/** The reference client's default calendars (`ots stamp` with no -c). */
export const WITNESS_CALENDARS = Object.freeze(['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org', 'https://a.pool.eternitywall.com', 'https://ots.btc.catallaxy.com'])
/** The reference client's upgrade list: a pending attestation's URI is followed only on these hosts, over https. */
export const WITNESS_UPGRADE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+calendar\.(?:opentimestamps\.org|eternitywall\.com|catallaxy\.com)$/
/** Five relays, so that one silent relay does not decide the holder count (the first three since the witness). */
export const WITNESS_RELAYS = Object.freeze(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://nostr.mom'])
/** NIP-01's machine-readable refusal prefixes (and NIP-42's auth-required); anything else is `refused:other`. */
export const WITNESS_RELAY_REFUSALS = Object.freeze(['auth-required', 'blocked', 'error', 'invalid', 'mute', 'pow', 'rate-limited', 'restricted'])
/** Every outbound header, as the reference clients send them; never a project or personal name. */
export const WITNESS_CALENDAR_HEADERS = Object.freeze({ Accept: 'application/vnd.opentimestamps.v1', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ots-client' })
export const WITNESS_UPGRADE_HEADERS = Object.freeze({ Accept: 'application/vnd.opentimestamps.v1', 'User-Agent': 'ots-client' })
export const WITNESS_LIMITS = Object.freeze({
  intervalMs: 4 * 3_600_000 - 60_000, upgradeAfterMs: 3_600_000, staleAfterMs: 14 * 86_400_000, upgradeGetsPerTick: 6,
  attempts: 3, callTimeoutMs: 5000, replyBytes: 10000, relayWaitMs: 5000, relayFrameChars: 4096, shown: 24, window: 96,
  signsPerTick: 4, publishesPerTick: 3, stampsPerTick: 2, internalTimeoutMs: 10000, internalBytes: 16 * 1024, minCalendars: 2,
  // A record at each promotion. HEAD's kick sets the alarm kickDelayMs ahead; the alarm's tick makes a record only
  // when the head moved, at least promotionFloorMs after the newest record, and at most promotionsPerWindow such records in
  // any rolling promotionWindowMs (past that the hourly schedule carries on alone).
  kickDelayMs: 15_000, promotionFloorMs: 60_000, promotionsPerWindow: 24, promotionWindowMs: 24 * 3_600_000,
  // The read-back. At most readbackRecords records a tick (the newest due ones), each relay asked at most once per
  // record per readbackEveryMs, each REQ waited on at most readbackWaitMs, and no new record started past readbackTotalMs.
  readbackRecords: 4, readbackEveryMs: 6 * 3_600_000, readbackWaitMs: 4000, readbackTotalMs: 16000,
  // Review: a read-back reads at most readbackFrames frames of one relay's answer; past that the relay does not hold it.
  readbackFrames: 8,
  // The header check, on the hourly tick only. At most headerRecordsPerTick confirmed records a tick; a failed check
  // again at most once per headerRetryMs and at most headerTries times (a merkle mismatch: never again; the header check: a
  // disagreement once more; an unavailable source sooner, see headerQuickTries).
  // Each explorer call: headerTimeoutMs, at most its source's `bytes` (headerReplyBytes for Esplora and blockcypher,
  // headerSmallReplyBytes for the other two). The whole pass has ONE deadline, headerTotalMs, handed to every
  // call, so it can never run past it; what is undecided then is HEADER_SOURCE_UNAVAILABLE.
  // headerMinZeroBits: the block hash must have at least 72 leading zero bits. Said plainly (review of the header check): a real
  // block today has about 79 or 80, so this floor is roughly 1/128 to 1/256 of ONE real block's work. It stops an explorer
  // that does not mine from making a header up for a merkle root of its choosing. It does NOT stop a large mining pool,
  // which could make such a header in about a minute, and the header's previous-hash link is not followed, so nothing
  // here shows the block is in the chain with the most work or that its bits are the ones the chain required at that
  // height (that needs the chain of headers). The main defence is two explorers run by unrelated operators agreeing on
  // the hash, with 6 confirmations by the LOWER of their tips.
  // A disagreement is tried once more after headerRetryMs, then it stays (headerDisagreeTries checks in all).
  headerRecordsPerTick: 2, headerRetryMs: 6 * 3_600_000, headerTries: 8, headerMinZeroBits: 72, headerConfirmations: 6,
  headerTimeoutMs: 8000, headerReplyBytes: 4096, headerSmallReplyBytes: 2048, headerTotalMs: 30000, headerDisagreeTries: 2,
  // HEADER_SOURCE_UNAVAILABLE (the sources simply did not answer) is tried again at the next hourly tick (at least
  // headerQuickRetryMs after the last try) while it has had fewer than headerQuickTries tries, then every headerRetryMs;
  // headerTries in all, as every other code.
  headerQuickTries: 3, headerQuickRetryMs: 30 * 60_000,
  // A check keeps, beside its code, at most headerTriedRows rows: each source asked and how it ended.
  headerTriedRows: 8,
  // The RFC 3161 token. At most tsaTries requests per record, ever, one a tick; each tsaTimeoutMs, a reply of at
  // most tsaReplyBytes. A new record gets its request in the tick that made it; besides that, at most tsaBackfillPerTick
  // older record a HOURLY tick (oldest first, a record whose earlier try failed included).
  tsaTries: 3, tsaTimeoutMs: 8000, tsaReplyBytes: TSA_REPLY_BYTES, tsaBackfillPerTick: 1,
})
/**
 * Reading the nightly pointer. The whole read (the pointer, then the manifest it names) has one deadline,
 * timeoutMs; the pointer may be at most pointerBytes and the manifest at most manifestBytes (today's manifests are a few
 * KiB: one row per 4 MiB page). Past any bound the fact is null with nightly-unavailable.
 */
export const WITNESS_NIGHTLY_LIMITS = Object.freeze({ timeoutMs: 5000, pointerBytes: 1024, manifestBytes: 1024 * 1024 })
export const WITNESS_NIGHTLY_POINTER = 'nightly/LATEST.json'
const nightlyMissing = reason => ({ nightly: null, reason })
/** An R2 object's text, or null when it says or turns out to be over `limit` bytes. */
async function boundedObjectText(object, limit) {
  if (Number.isSafeInteger(object.size) && object.size > limit) return null
  const text = await object.text()
  return typeof text === 'string' && new TextEncoder().encode(text).byteLength <= limit ? text : null
}
async function readNightlyPointer(bucket) {
  const pointerObject = await bucket.get(WITNESS_NIGHTLY_POINTER)
  if (pointerObject === null || pointerObject === undefined) return nightlyMissing('nightly-none')
  const pointerText = await boundedObjectText(pointerObject, WITNESS_NIGHTLY_LIMITS.pointerBytes)
  if (pointerText === null) return nightlyMissing('nightly-unavailable')
  const pointer = JSON.parse(pointerText)
  if (!isObject(pointer) || !witnessNightlySetValid(pointer.set) || typeof pointer.sha256 !== 'string' || !HEX_64.test(pointer.sha256)) return nightlyMissing('nightly-unavailable')
  const manifestObject = await bucket.get(`nightly/${pointer.set}/manifest.json`)
  if (manifestObject === null || manifestObject === undefined) return nightlyMissing('nightly-unavailable')
  const manifestText = await boundedObjectText(manifestObject, WITNESS_NIGHTLY_LIMITS.manifestBytes)
  if (manifestText === null || await nightlySha256(manifestText) !== pointer.sha256) return nightlyMissing('nightly-unavailable')
  const manifest = JSON.parse(manifestText)
  // The pointer names only complete sets (runNightlyCopy); checked again here, and the manifest must name the same set.
  if (!isObject(manifest) || manifest.set !== pointer.set || manifest.complete !== true) return nightlyMissing('nightly-unavailable')
  return { nightly: { set: pointer.set, sha256: pointer.sha256 }, reason: null }
}
/**
 * The newest COMPLETE nightly set, as the witness record's `nightly` fact: `{ nightly: { set, sha256 }, reason: null }`
 * or `{ nightly: null, reason }` with a closed code: nightly-off (NIGHTLY_COPY is not exactly "on": nothing is read),
 * nightly-none (no pointer yet), nightly-unavailable (no ARCHIVE_BUCKET binding, a read that failed, threw or did not
 * finish within timeoutMs, a pointer or manifest over its bound or not of its shape, a manifest whose SHA-256 is not the
 * pointer's, or one that is not complete or names another set). `sha256` is the SHA-256 of the manifest's exact bytes,
 * the value nightly/LATEST.json holds, recomputed here. (latestNightly in nightly-copy.mjs answers the manifest, not its
 * hash; recomputing the hash from a re-serialised manifest would be a guess, so this reads the bytes itself.) Never
 * throws, never waits past the deadline. Reads two R2 objects; writes nothing; no network.
 */
export async function readNightlyFact(env, { timeoutMs = WITNESS_NIGHTLY_LIMITS.timeoutMs } = {}) {
  if (env?.NIGHTLY_COPY !== 'on') return nightlyMissing('nightly-off')
  const bucket = env?.ARCHIVE_BUCKET
  if (!bucket || typeof bucket.get !== 'function') return nightlyMissing('nightly-unavailable')
  let timer = null
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(nightlyMissing('nightly-unavailable')), timeoutMs) })
  try {
    const read = (async () => readNightlyPointer(bucket))().catch(() => nightlyMissing('nightly-unavailable'))
    return await Promise.race([read, deadline])
  } catch (_error) { return nightlyMissing('nightly-unavailable') } finally { clearTimeout(timer) }
}
/** The owner's switch for the RFC 3161 request (wrangler.toml [vars]): only exactly "on" sends it. */
export const witnessTsaOn = env => env?.WITNESS_TSA === 'on'
/** A plain client: no project or personal name. */
export const WITNESS_TSA_HEADERS = Object.freeze({ 'Content-Type': TSA_QUERY_TYPE, Accept: TSA_REPLY_TYPE, 'User-Agent': 'tsa-client/1' })
/**
 * the header check B (2026-11-17: every check failed from the edge, so one or both primaries refuse or throttle Cloudflare's shared
 * addresses): the POOL the header check asks, in this order, two at a time, until two sources give headers that pass
 * their own checks. Each source has a kind, and one adapter per kind turns its reply into `{ host, hash, header }`:
 *  - esplora: GET <base>/block-height/:h (the block hash), <base>/block/:hash/header (80 bytes as hex),
 *    <base>/blocks/tip/height (the only kind that gives a tip);
 *  - fields: JSON fields rebuilt into the 80 header bytes (api.blockchain.info's haskoin store: GET
 *    /haskoin-store/btc/block/height/:h?notx=true, a list of one block; api.blockcypher.com: GET /v1/btc/main/blocks/:h);
 *  - raw: api.bitaps.com GET /btc/v1/blockchain/block/:h, `data.header` base64 whose first 80 bytes are the header.
 * blockstream.info answered nobody on 2026-11-17: it stays, LAST. Only block heights and block hashes leave.
 */
const source = (host, kind, base, fields = null) => Object.freeze({ host, kind, base, ...(fields ? { fields } : {}),
  bytes: kind === 'esplora' || fields === 'blockcypher' ? WITNESS_LIMITS.headerReplyBytes : WITNESS_LIMITS.headerSmallReplyBytes })
export const WITNESS_HEADER_SOURCES = Object.freeze([
  source('mempool.space', 'esplora', 'https://mempool.space/api'),
  source('btcscan.org', 'esplora', 'https://btcscan.org/api'),
  source('mempool.emzy.de', 'esplora', 'https://mempool.emzy.de/api'),
  source('api.blockchain.info', 'fields', 'https://api.blockchain.info/haskoin-store/btc', 'haskoin'),
  source('api.blockcypher.com', 'fields', 'https://api.blockcypher.com/v1/btc/main', 'blockcypher'),
  source('api.bitaps.com', 'raw', 'https://api.bitaps.com/btc/v1/blockchain'),
  source('blockstream.info', 'esplora', 'https://blockstream.info/api'),
])
/** The allow-list: exactly the pool's seven hosts (https, no port, no credentials, no redirect followed). */
export const WITNESS_HEADER_HOSTS = Object.freeze(new Set(WITNESS_HEADER_SOURCES.map(item => item.host)))
/** A plain client: no project or personal name. */
export const WITNESS_EXPLORER_HEADERS = Object.freeze({ Accept: '*/*', 'User-Agent': 'header-check/1' })
/** The closed codes of a failed header check. */
export const WITNESS_HEADER_CODES = Object.freeze(['HEADER_SOURCE_UNAVAILABLE', 'HEADER_SOURCES_DISAGREE', 'HEADER_HASH_MISMATCH', 'HEADER_WORK_TOO_LOW',
  'HEADER_MERKLE_MISMATCH', 'HEADER_TOO_FEW_CONFIRMATIONS', 'HEADER_PROOF_UNREADABLE'])
/**
 * How one source's asking ended, a closed word: ok; http-<the status, three digits>; timeout; redirect (never
 * followed); too-large; shape (answered, not the expected form); self-mismatch (its header does not hash to the hash it
 * names, misses its own target or the work floor, or names another height); error (anything else). A `tried` row is
 * `{ host, why }` and nothing else: an allow-listed host and one of these words.
 */
export const WITNESS_HEADER_WHY = /^(?:ok|http-[1-5][0-9]{2}|timeout|redirect|too-large|shape|self-mismatch|error)$/
/** The closed word for a fetch that threw: the deadline (ours or the pass's) is `timeout`, anything else `error`. */
const thrownWhy = error => error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'error'
/** The closed word for a reply that is not 200: a 3xx is a redirect (never followed); a status outside 100-599 is error. */
const statusWhy = status => Number.isSafeInteger(status) && status >= 300 && status < 400 ? 'redirect'
  : Number.isSafeInteger(status) && status >= 100 && status <= 599 ? `http-${status}` : 'error'
/** A body read to at most `limit` bytes: `{ bytes }` or `{ why }` (too-large, or timeout/error when the read broke). */
async function boundedRead(response, limit) {
  const reader = response.body?.getReader?.()
  if (!reader) return { bytes: new Uint8Array(0) }
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) { void reader.cancel().catch(() => {}); return { why: 'too-large' } }
      chunks.push(chunk.value)
    }
  } catch (error) { return { why: thrownWhy(error) } } finally { try { reader.releaseLock() } catch (_error) { /* released */ } }
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
  return { bytes: out }
}
/** Never retried: it stays shown until someone looks. (A disagreement: once more, see headerDisagreeTries.) */
const HEADER_FINAL = new Set(['HEADER_MERKLE_MISMATCH'])
/** A promise raced against `signal`: it rejects with a TimeoutError the moment the signal aborts. */
function bySignal(promise, signal) {
  if (signal.aborted) return Promise.reject(new DOMException('deadline', 'TimeoutError'))
  return new Promise((resolve, reject) => {
    const stop = () => reject(new DOMException('deadline', 'TimeoutError'))
    signal.addEventListener('abort', stop, { once: true })
    promise.then(value => { signal.removeEventListener('abort', stop); resolve(value) }, error => { signal.removeEventListener('abort', stop); reject(error) })
  })
}

/** Whether an explorer URL may be fetched: https, one of the pool's hosts exactly, no credentials, no port. */
export function headerUrlAllowed(text) {
  try {
    const url = new URL(text)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && WITNESS_HEADER_HOSTS.has(url.hostname)
  } catch (_error) { return false }
}
const META = 'witness:meta'
const recordKey = seq => `witness:record:${seq}`
const otsKey = seq => `witness:ots:${seq}`
const tsaKey = seq => `witness:tsa:${seq}`
const OK_STATES = new Set(['ok', 'duplicate'])
/**
 * The publish attempts one relay has had for this record. Kept per relay in `relayTries` beside the entry; an entry
 * stored before that field has had `publishAttempts` tries on each relay it names and none on a relay added since.
 */
const relayTries = (entry, url) => Number.isSafeInteger(entry.relayTries?.[url]) ? entry.relayTries[url]
  : isObject(entry.relays) && Object.hasOwn(entry.relays, url) && Number.isSafeInteger(entry.publishAttempts) ? entry.publishAttempts : 0
/** The relays this record is still owed a publish on: not yet ok, attempts left (at most WITNESS_LIMITS.attempts each, ever). */
const publishTargets = entry => entry.event ? WITNESS_RELAYS.filter(url => !OK_STATES.has(entry.relays?.[url]) && relayTries(entry, url) < WITNESS_LIMITS.attempts) : []
/** A signed record whose event has not reached every relay and has attempts left on one of them. */
const publishOwed = entry => publishTargets(entry).length > 0
const HEX_64 = /^[0-9a-f]{64}$/
const SEQ_QUERY = /^\?seq=([1-9][0-9]{0,15})$/

const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const fromHex = text => Uint8Array.from(text.match(/../g) ?? [], pair => Number.parseInt(pair, 16))
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const failed = code => Object.assign(new Error(code), { code })

/** A body read to at most `limit` bytes, or null (too large, cut off, unreadable). */
async function boundedBytes(response, limit) {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) { void reader.cancel().catch(() => {}); return null }
      chunks.push(chunk.value)
    }
  } catch (_error) { return null } finally { try { reader.releaseLock() } catch (_error) { /* released */ } }
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
  return out
}
async function boundedJson(response, limit) {
  const bytes = await boundedBytes(response, limit)
  if (bytes === null) return null
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (_error) { return null }
}

/** Whether a pending attestation's URI may be followed: https, a listed calendar host, no credentials, port, path or query. */
export function upgradeUriAllowed(uri) {
  try {
    const url = new URL(uri)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash
      && WITNESS_UPGRADE_HOST.test(url.hostname) && uri.replace(/\/$/, '') === url.origin
  } catch (_error) { return false }
}

/** One relay frame read against the event id: a closed state, or null when the frame does not answer this event. */
export function relayState(data, eventId) {
  if (typeof data !== 'string') return null
  let frame
  if (data.length > WITNESS_LIMITS.relayFrameChars) {
    // Review of the landing branch: an OK with a long human message is still this event's answer. Only the first
    // relayFrameChars characters are read: the frame type, the id, the flag and the start of the message (its
    // machine-readable prefix); a long frame that is not shaped so is not an answer.
    const head = /^\[\s*"OK"\s*,\s*"([0-9a-f]{64})"\s*,\s*(true|false)\s*,\s*"((?:[^"\\]|\\.)*)/.exec(data.slice(0, WITNESS_LIMITS.relayFrameChars))
    if (!head) return null
    frame = ['OK', head[1], head[2] === 'true', head[3]]
  } else {
    try { frame = JSON.parse(data) } catch (_error) { return null }
  }
  if (!Array.isArray(frame)) return null
  // An AUTH frame on its own is NIP-42's challenge, not a demand: keep waiting for the OK. Only an OK false whose prefix
  // is auth-required is the demand (refused:auth-required, below).
  if (frame[0] !== 'OK' || frame[1] !== eventId || typeof frame[2] !== 'boolean') return null
  const message = typeof frame[3] === 'string' ? frame[3] : ''
  const prefix = message.includes(':') ? message.slice(0, message.indexOf(':')).trim() : ''
  if (prefix === 'duplicate') return 'duplicate'
  if (frame[2]) return 'ok'
  return WITNESS_RELAY_REFUSALS.includes(prefix) ? `refused:${prefix}` : 'refused:other'
}

/** A relay frame as an array, or null (not a string, past the frame bound, not JSON, not an array). */
function readFrame(data) {
  if (typeof data !== 'string' || data.length > WITNESS_LIMITS.relayFrameChars) return null
  try { const frame = JSON.parse(data); return Array.isArray(frame) ? frame : null } catch (_error) { return null }
}
/**
 * Whether a returned event is the stored one, field by field. Review: the stored event was verified (id and
 * signature) when HEAD signed it, so an exact copy of it is a valid event; string compares, no signature check per frame.
 */
const HELD_FIELDS = ['id', 'pubkey', 'created_at', 'kind', 'content', 'sig']
function heldEvent(returned, stored) {
  return isObject(returned) && HELD_FIELDS.every(field => returned[field] === stored[field])
    && Array.isArray(returned.tags) && JSON.stringify(returned.tags) === JSON.stringify(stored.tags)
}

/** A relay's host name, the only part of it the public row shows. */
const relayHost = url => new URL(url).hostname
/** Every closed state a publish to one relay can be in (`none`: never sent). */
const SENT_STATES = new Set(['none', 'ok', 'duplicate', 'timeout', 'refused:other', ...WITNESS_RELAY_REFUSALS.map(prefix => `refused:${prefix}`)])
/**
 * One record's relay row. `ok` counts relays that accepted the publish; `held` counts relays whose newest read-back
 * returned the event (null until one was asked), `heldCheckedAt` is when the newest read-back ran; per relay its host,
 * its publish state and whether it held the event (null: never asked).
 */
function relaysRow(entry) {
  const rows = WITNESS_RELAYS.map(url => ({ relay: relayHost(url), sent: SENT_STATES.has(entry.relays?.[url]) ? entry.relays[url] : 'none',
    held: typeof entry.held?.[url]?.held === 'boolean' ? entry.held[url].held : null }))
  const checkedAt = rows.some(row => row.held !== null) && count(entry.heldCheckedAt) ? entry.heldCheckedAt : null
  return { ok: rows.filter(row => OK_STATES.has(row.sent)).length, of: WITNESS_RELAYS.length,
    held: checkedAt === null ? null : rows.filter(row => row.held === true).length, heldCheckedAt: checkedAt, rows }
}

const emptyResult = () => ({ ok: true, created: false, seq: null, upgraded: 0, confirmed: 0, stale: 0, stamped: 0, signed: 0, published: 0, codes: [] })

export class WitnessDO {
  /** @param {object} state Durable Object state. @param {object} env Worker env (HEAD and MIRROR are the bindings used).
   * @param {object} [options] Tests only: `now`, `fetch` (outbound HTTPS), `openSocket` (outbound WebSocket),
   * `randomBytes`, `timers` ({ set, clear }), `headerMinZeroBits` (a lower work floor, because a test cannot make a
   * header with 72 leading zero bits; the shipped object always uses WITNESS_LIMITS.headerMinZeroBits), `headerTotalMs`
   * (a shorter pass deadline, so a test need not wait 30 s; shipped: WITNESS_LIMITS.headerTotalMs), `nightlyTimeoutMs`
   * (a shorter nightly pointer deadline; shipped: WITNESS_NIGHTLY_LIMITS.timeoutMs). Cloudflare passes two arguments. */
  constructor(state, env, options = {}) {
    this.state = state
    this.storage = state.storage
    this.env = env ?? {}
    this.now = options.now ?? Date.now
    this.net = options.fetch ?? ((url, init) => fetch(url, init))
    this.openSocket = options.openSocket ?? (url => new WebSocket(url))
    this.randomBytes = options.randomBytes ?? (size => crypto.getRandomValues(new Uint8Array(size)))
    this.timers = options.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) }
    this.headerFloor = Number.isSafeInteger(options.headerMinZeroBits) ? options.headerMinZeroBits : WITNESS_LIMITS.headerMinZeroBits
    this.headerTotalMs = Number.isSafeInteger(options.headerTotalMs) ? options.headerTotalMs : WITNESS_LIMITS.headerTotalMs
    this.nightlyTimeoutMs = Number.isSafeInteger(options.nightlyTimeoutMs) ? options.nightlyTimeoutMs : WITNESS_NIGHTLY_LIMITS.timeoutMs
    this.ticking = false
  }

  async fetch(request) {
    if (new URL(request.url).pathname === NIGHTLY_PAGE_ROUTE) return nightlyPageResponse(request, this.storage, 'WITNESS')
    try {
      if (request.headers.get('x-x6-internal-authorized') !== '1') return reply({ ok: false, code: 'UNAUTHORIZED' }, 401)
      const url = new URL(request.url)
      if (url.hash) return reply({ ok: false, code: 'NOT_FOUND' }, 404)
      if (url.pathname === WITNESS_ROUTES.tick) {
        if (url.search || url.href.endsWith('?')) return reply({ ok: false, code: 'NOT_FOUND' }, 404)
        if (request.method !== 'POST') return reply({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
        // The owner's switch: off answers here, before any storage read, fetch, socket or call to HEAD or the mirror.
        if (!witnessSwitchOn(this.env)) return reply({ ok: false, code: 'WITNESS_OFF' })
        return reply(await this.tick())
      }
      // HEAD's kick after a promotion commits. Answers at once: it only sets the alarm (the tick calls back into
      // HEAD, so it never runs inside HEAD's own request). Switch off: answered before any storage read or alarm.
      if (url.pathname === WITNESS_ROUTES.kick) {
        if (url.search || url.href.endsWith('?')) return reply({ ok: false, code: 'NOT_FOUND' }, 404)
        if (request.method !== 'POST') return reply({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
        if (!witnessSwitchOn(this.env)) return reply({ ok: false, code: 'WITNESS_OFF' })
        return reply(await this.armKick())
      }
      if (![WITNESS_ROUTES.public, WITNESS_ROUTES.record, WITNESS_ROUTES.ots, WITNESS_ROUTES.tsa].includes(url.pathname)) return reply({ ok: false, code: 'NOT_FOUND' }, 404)
      if (request.method !== 'GET') return reply({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
      if (url.pathname === WITNESS_ROUTES.public) {
        if (url.search || url.href.endsWith('?')) return reply({ ok: false, code: 'NOT_FOUND' }, 404)
        return reply({ ok: true, public: await this.publicView() })
      }
      const match = SEQ_QUERY.exec(url.search)
      const seq = match ? Number(match[1]) : null
      if (!Number.isSafeInteger(seq)) return reply({ ok: false, code: 'NOT_FOUND' }, 404)
      const entry = await this.storage.get(recordKey(seq))
      if (!isObject(entry)) return reply({ ok: false, code: 'WITNESS_RECORD_NONE' }, 404)
      if (url.pathname === WITNESS_ROUTES.record) {
        return reply({ ok: true, seq, digest: entry.digest, record: entry.record, eventId: entry.eventId, event: entry.event,
          relays: entry.relays, ots: { state: entry.ots.state, height: entry.ots.height } })
      }
      // The stored RFC 3161 reply, as the authority sent it. Off: nothing is served.
      if (url.pathname === WITNESS_ROUTES.tsa) {
        const token = witnessTsaOn(this.env) ? await this.storage.get(tsaKey(seq)) : null
        if (typeof token !== 'string') return reply({ ok: false, code: 'WITNESS_TSA_NONE' }, 404)
        return new Response(fromHex(token), { status: 200, headers: { 'content-type': TSA_REPLY_TYPE, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
      }
      const proof = await this.storage.get(otsKey(seq))
      if (typeof proof !== 'string') return reply({ ok: false, code: 'WITNESS_OTS_NONE' }, 404)
      return new Response(fromHex(proof), { status: 200, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    } catch (_error) { return reply({ ok: false, code: 'WITNESS_UNAVAILABLE' }, 503) }
  }

  /** The alarm kickDelayMs from now, unless one is already set sooner. */
  async armKick() { return this.armAt(this.now() + WITNESS_LIMITS.kickDelayMs) }

  /** The alarm at `at`, unless one is already set sooner. */
  async armAt(at) {
    if (typeof this.storage.getAlarm !== 'function' || typeof this.storage.setAlarm !== 'function') return { ok: false, code: 'WITNESS_ALARM_UNAVAILABLE' }
    const current = await this.storage.getAlarm()
    if (Number.isFinite(current) && current <= at) return { ok: true, alarmAt: current, kept: true }
    await this.storage.setAlarm(at)
    return { ok: true, alarmAt: at, kept: false }
  }

  /**
   * The alarm a kick set runs ONE promotion-triggered tick. A tick already running (the hourly one) makes this one
   * busy: the alarm is set again kickDelayMs ahead, so the promotion is looked at once that tick is done. Never throws.
   */
  async alarm() {
    if (!witnessSwitchOn(this.env)) return { ok: false, code: 'WITNESS_OFF' }
    const result = await this.tick({ trigger: 'promotion' })
    if (result.codes?.includes('WITNESS_TICK_BUSY')) { try { await this.armKick() } catch (_error) { /* the next hourly tick still runs */ } }
    return result
  }

  /**
   * One bounded pass. Never throws: counts and closed codes. `trigger` 'promotion' (the alarm a kick set) skips the upgrade
   * pass (Bitcoin's pace; the hourly tick does it) and makes a record only by the promotion rule (promotionRecord).
   */
  async tick({ trigger = 'schedule' } = {}) {
    if (!witnessSwitchOn(this.env)) return { ok: false, code: 'WITNESS_OFF' }
    const promotion = trigger === 'promotion'
    const result = emptyResult()
    if (this.ticking) return { ...result, codes: ['WITNESS_TICK_BUSY'] }
    this.ticking = true
    const code = value => { if (!result.codes.includes(value)) result.codes.push(value) }
    try {
      const now = this.now()
      const meta = await this.storage.get(META) ?? { seq: 0, pubkey: null }
      const entries = await this.window(meta.seq)
      // The header check (hourly only) looks at the proofs confirmed BEFORE this tick's upgrade pass: a proof
      // confirmed in this tick waits for the next hour, when its block has more confirmations.
      const confirmedBefore = new Set(entries.filter(entry => entry.ots?.state === 'confirmed').map(entry => entry.seq))
      if (!promotion) await this.upgradePass(entries, now, result, code)
      await this.retryPass(entries, now, result, code)
      const newest = entries.at(-1)
      if (promotion) await this.promotionRecord(meta, entries, now, result, code)
      else if (!newest || now - newest.record.at >= WITNESS_LIMITS.intervalMs) await this.newRecord(meta, entries, now, result, code)
      // The RFC 3161 request for a record made this tick, and (hourly) one older record.
      await this.tsaPass(entries, now, result.created ? result.seq : null, promotion)
      // Review: the header check runs after the new record is made (and its timestamp asked for), so an explorer's
      // slowness never delays or loses a record.
      if (!promotion) await this.headerPass(entries, now, confirmedBefore)
      // Review: the read-back runs last, so a relay's answer can never keep a record from being made. It reads the window
      // as it was when the tick began: a record made this tick is read back on a later tick.
      await this.readbackPass(entries, now, code)
    } catch (error) {
      result.ok = false
      code(typeof error?.code === 'string' && error.code.startsWith('WITNESS_') ? error.code : 'WITNESS_STORAGE_UNAVAILABLE')
    } finally { this.ticking = false }
    result.codes.sort()
    return result
  }

  /** The newest WITNESS_LIMITS.window records, oldest first. */
  async window(lastSeq) {
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) throw failed('WITNESS_STATE_CORRUPT')
    const keys = []
    for (let seq = Math.max(1, lastSeq - WITNESS_LIMITS.window + 1); seq <= lastSeq; seq++) keys.push(recordKey(seq))
    if (!keys.length) return []
    const found = await this.storage.get(keys)
    return keys.map(key => found.get(key)).filter(isObject)
  }

  async put(entry) { await this.storage.put(recordKey(entry.seq), entry) }

  async upgradePass(entries, now, result, code) {
    let gets = 0
    for (const entry of entries) {
      if (entry.ots.state !== 'pending') continue
      if (now - entry.ots.at >= WITNESS_LIMITS.staleAfterMs) {
        entry.ots.state = 'stale'
        await this.put(entry)
        result.stale++
        continue
      }
      if (now - entry.ots.at < WITNESS_LIMITS.upgradeAfterMs || gets >= WITNESS_LIMITS.upgradeGetsPerTick) continue
      const stored = await this.storage.get(otsKey(entry.seq))
      if (typeof stored !== 'string') { code('WITNESS_OTS_MISSING'); continue }
      let proof = fromHex(stored), leaves
      try { leaves = await pendingLeaves(proof) } catch (_error) { code('WITNESS_OTS_UNREADABLE'); continue }
      for (const leaf of leaves) {
        if (gets >= WITNESS_LIMITS.upgradeGetsPerTick) break
        if (!upgradeUriAllowed(leaf.uri)) continue
        gets++
        result.upgraded++
        const tree = await this.askUpgrade(leaf)
        if (!tree) continue
        try {
          if (!treeHasBitcoin(tree)) continue
          proof = await spliceUpgrade(proof, leaf.commitment, tree)
          entry.ots.state = 'confirmed'
          entry.ots.height = treeBitcoinHeights(tree)[0]
          await this.storage.put(otsKey(entry.seq), toHex(proof))
          await this.put(entry)
          result.confirmed++
          break
        } catch (_error) { code('WITNESS_UPGRADE_UNUSABLE') }
      }
    }
  }

  /**
   * The header check. Records whose proof is confirmed and whose check is due: never tried, or failed with a code
   * that may be retried, fewer than headerTries tries, the last at least headerRetryMs ago (HEADER_SOURCE_UNAVAILABLE
   * with fewer than headerQuickTries tries, at least headerQuickRetryMs ago). At most headerRecordsPerTick a
   * tick: never-tried first, newest first; then the ones whose last try is oldest (so none starves). The result is kept
   * beside the record (`header`, `headerTries`), never in it.
   */
  async headerPass(entries, now, confirmedBefore) {
    const tries = entry => Number.isSafeInteger(entry.headerTries) ? entry.headerTries : 0
    const disagreements = entry => Number.isSafeInteger(entry.headerDisagreements) ? entry.headerDisagreements : 1
    const due = entry => {
      if (entry.ots?.state !== 'confirmed' || !count(entry.ots.height) || !confirmedBefore.has(entry.seq)) return false
      const header = entry.header
      if (!isObject(header)) return true
      if (header.checked !== false || HEADER_FINAL.has(header.code) || tries(entry) >= WITNESS_LIMITS.headerTries) return false
      // A disagreement is checked once more (a check stored before this counter counts as one), then it stays.
      if (header.code === 'HEADER_SOURCES_DISAGREE' && disagreements(entry) >= WITNESS_LIMITS.headerDisagreeTries) return false
      const wait = header.code === 'HEADER_SOURCE_UNAVAILABLE' && tries(entry) < WITNESS_LIMITS.headerQuickTries ? WITNESS_LIMITS.headerQuickRetryMs : WITNESS_LIMITS.headerRetryMs
      return !count(header.at) || now - header.at >= wait
    }
    const lastTry = entry => isObject(entry.header) && count(entry.header.at) ? entry.header.at : -1
    const records = entries.filter(due).sort((a, b) => lastTry(a) - lastTry(b) || b.seq - a.seq).slice(0, WITNESS_LIMITS.headerRecordsPerTick)
    if (!records.length) return
    // One deadline for the whole pass, handed to every explorer call; no record is started past it.
    const deadline = AbortSignal.timeout(this.headerTotalMs)
    const tips = new Map()
    for (const entry of records) {
      if (deadline.aborted) break
      const header = await this.checkHeader(entry, tips, deadline)
      if (header.code === 'HEADER_SOURCES_DISAGREE') entry.headerDisagreements = (Number.isSafeInteger(entry.headerDisagreements) ? entry.headerDisagreements : 0) + 1
      entry.header = { ...header, tried: header.tried.slice(0, WITNESS_LIMITS.headerTriedRows), at: now }
      entry.headerTries = tries(entry) + 1
      await this.put(entry)
    }
  }

  /**
   * One record's check: `{ checked: true, hash, time, confirmations, sources, tried }` or `{ checked: false, code, tried }`.
   * Review: a stored proof that is missing or holds no usable Bitcoin attestation is HEADER_PROOF_UNREADABLE (counted as a
   * try, so it cannot hold a slot every hour). The pool is asked two at a time, in order, until two sources give
   * headers that pass their own checks (hashes to the hash it names, meets its own target and the work floor, names this
   * height); a source that fails its own checks is `self-mismatch` and the next is asked. The first two good sources must
   * name the SAME hash (else HEADER_SOURCES_DISAGREE), then the merkle root must be the proof's value. Confirmations: the
   * LOWER tip of up to two Esplora sources (no tip: HEADER_TOO_FEW_CONFIRMATIONS). Undecided at the deadline:
   * HEADER_SOURCE_UNAVAILABLE. With fewer than two good sources: unavailable when any source did not answer (review), else
   * (every other source failed its own checks) a source's own failure names the code (HEADER_HASH_MISMATCH or WORK_TOO_LOW).
   */
  async checkHeader(entry, tips, deadline) {
    // Each source asked, in the order first asked, and how its asking ended. Review: a row keeps its FIRST
    // ending that is not ok (a tip asked after the header never hides a header's failure, self-mismatch above all).
    const tried = new Map()
    const note = (host, why) => { if (!tried.has(host) || tried.get(host) === 'ok') tried.set(host, why) }
    const rows = () => [...tried].map(([host, why]) => ({ host, why }))
    const refused = code => ({ checked: false, code, tried: rows() })
    const stored = await this.storage.get(otsKey(entry.seq))
    if (typeof stored !== 'string') return refused('HEADER_PROOF_UNREADABLE')
    let attestations
    try { attestations = await bitcoinAttestations(fromHex(stored)) } catch (_error) { return refused('HEADER_PROOF_UNREADABLE') }
    // The attestation at the height the upgrade recorded (the lowest, if none names it).
    const attestation = attestations.find(item => item.height === entry.ots.height) ?? attestations.sort((a, b) => a.height - b.height)[0]
    if (!attestation || !HEX_64.test(attestation.merkleRoot)) return refused('HEADER_PROOF_UNREADABLE')
    const height = attestation.height
    const good = []
    let selfCode = null
    // Review: a source that did not answer (anything but its own failed check) makes too few good sources unavailable.
    let unanswered = false
    for (let index = 0; good.length < 2 && index < WITNESS_HEADER_SOURCES.length; index += 2) {
      if (deadline.aborted) return refused('HEADER_SOURCE_UNAVAILABLE')
      const answers = await Promise.all(WITNESS_HEADER_SOURCES.slice(index, index + 2).map(item => this.sourceBlock(item, height, deadline)))
      for (const answer of answers) {
        if (answer.why) { note(answer.host, answer.why); unanswered ||= answer.why !== 'self-mismatch'; continue }
        const own = await this.ownCheck(answer)
        if (own) { note(answer.host, 'self-mismatch'); selfCode ??= own; continue }
        note(answer.host, 'ok')
        good.push(answer)
      }
    }
    if (good.length < 2) return refused(deadline.aborted || unanswered ? 'HEADER_SOURCE_UNAVAILABLE' : selfCode ?? 'HEADER_SOURCE_UNAVAILABLE')
    const [first, second] = good
    if (first.hash !== second.hash) return refused('HEADER_SOURCES_DISAGREE')
    const fields = parseHeader(first.header)
    if (fields.merkleRootHeaderOrder !== attestation.merkleRoot) return refused('HEADER_MERKLE_MISMATCH')
    // The tip: up to two Esplora sources, the agreeing ones first, then those not failed this check, in pool order. Asked
    // once per source per pass. Review: never a source that failed its own checks (self-mismatch): it gives no tip.
    const rank = item => item.host === first.host || item.host === second.host ? 0 : !tried.has(item.host) || tried.get(item.host) === 'ok' ? 1 : 2
    const tipSources = WITNESS_HEADER_SOURCES.filter(item => item.kind === 'esplora' && tried.get(item.host) !== 'self-mismatch').map((item, order) => ({ item, order }))
      .sort((a, b) => rank(a.item) - rank(b.item) || a.order - b.order).slice(0, 2).map(pair => pair.item)
    const tipAnswers = await Promise.all(tipSources.map(item => {
      if (!tips.has(item.host)) tips.set(item.host, this.esploraTip(item, deadline))
      return tips.get(item.host)
    }))
    for (const tip of tipAnswers) note(tip.host, tip.why ?? 'ok')
    const known = tipAnswers.filter(tip => !tip.why).map(tip => tip.value)
    if (!known.length) return refused(deadline.aborted ? 'HEADER_SOURCE_UNAVAILABLE' : 'HEADER_TOO_FEW_CONFIRMATIONS')
    // Review: the LOWER of the tips decides, so one source answering a wrong tip cannot make the count (with one tip
    // unknown, the one known decides).
    const confirmations = Math.min(...known) - height + 1
    if (confirmations < WITNESS_LIMITS.headerConfirmations) return refused('HEADER_TOO_FEW_CONFIRMATIONS')
    return { checked: true, hash: first.hash, time: fields.time, confirmations, sources: [first.host, second.host], tried: rows() }
  }

  /** A source's own checks: null when its header hashes to the hash it names and has the work; else the code it earns. */
  async ownCheck(answer) {
    if (await headerHash(answer.header) !== answer.hash) return 'HEADER_HASH_MISMATCH'
    if (!await meetsOwnTarget(answer.header) || leadingZeroBits(answer.hash) < this.headerFloor) return 'HEADER_WORK_TOO_LOW'
    return null
  }

  /**
   * The RFC 3161 pass. The record made this tick (if any), then, on the hourly tick only, the oldest record in the
   * window with no stored token and tries left. Switch off: nothing. Never throws.
   */
  async tsaPass(entries, now, newSeq, promotion) {
    if (!witnessTsaOn(this.env)) return
    const owed = entry => isObject(entry) && entry.tsa?.state !== 'stored' && (Number.isSafeInteger(entry.tsaTries) ? entry.tsaTries : 0) < WITNESS_LIMITS.tsaTries
    const records = []
    if (newSeq !== null) { const entry = await this.storage.get(recordKey(newSeq)); if (owed(entry)) records.push(entry) }
    if (!promotion) records.push(...entries.filter(entry => entry.seq !== newSeq && owed(entry)).slice(0, WITNESS_LIMITS.tsaBackfillPerTick))
    for (const entry of records) await this.requestTimestamp(entry, now)
  }

  /** One request to the authority for this record's digest; the reply stored when it passes the sanity read. */
  async requestTimestamp(entry, now) {
    let state = 'failed'
    try {
      const digest = fromHex(entry.digest), nonce = tsaNonce(this.randomBytes(8))
      const response = await this.net(TSA_URL, { method: 'POST', headers: { ...WITNESS_TSA_HEADERS }, body: timestampQuery(digest, nonce),
        redirect: 'manual', signal: AbortSignal.timeout(WITNESS_LIMITS.tsaTimeoutMs) })
      if (response.status !== 200) void response.body?.cancel().catch(() => {})
      else {
        const bytes = await boundedBytes(response, WITNESS_LIMITS.tsaReplyBytes)
        if (bytes !== null) {
          sanityReadReply(bytes, { digest, nonce })
          await this.storage.put(tsaKey(entry.seq), toHex(bytes))
          state = 'stored'
        }
      }
    } catch (_error) { /* failed: a closed state, retried while tries are left */ }
    entry.tsa = { state, at: now }
    entry.tsaTries = (Number.isSafeInteger(entry.tsaTries) ? entry.tsaTries : 0) + 1
    await this.put(entry)
  }

  /**
   * One explorer GET: `{ text }` (at most `limit` bytes, UTF-8, trimmed) or `{ why }` with the closed word for how it ended
   * (not allowed, not 200, a redirect, too large, slow, not UTF-8). Bounded by headerTimeoutMs and by the pass's deadline:
   * both go to the fetch as its signal, and the whole call is raced against them, so it cannot outlive either.
   */
  async explorerText(url, limit, deadline) {
    if (!headerUrlAllowed(url)) return { why: 'error' }
    const signal = AbortSignal.any([AbortSignal.timeout(WITNESS_LIMITS.headerTimeoutMs), deadline])
    try {
      return await bySignal((async () => {
        let response
        try {
          response = await this.net(url, { method: 'GET', headers: { ...WITNESS_EXPLORER_HEADERS }, redirect: 'manual', signal })
        } catch (error) { return { why: thrownWhy(error) } }
        if (response?.status !== 200) { void response?.body?.cancel?.().catch(() => {}); return { why: statusWhy(response?.status) } }
        const read = await boundedRead(response, limit)
        if (read.why) return read
        try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes).trim() } } catch (_error) { return { why: 'shape' } }
      })(), signal)
    } catch (error) { return { why: thrownWhy(error) } }
  }

  /** One source's block at `height` by its kind: `{ host, hash, header }` or `{ host, why }`. */
  async sourceBlock(item, height, deadline) {
    const answer = item.kind === 'esplora' ? await this.esploraBlock(item, height, deadline)
      : item.kind === 'fields' ? await this.fieldsBlock(item, height, deadline) : await this.rawBlock(item, height, deadline)
    return answer.why ? { host: item.host, why: answer.why } : { host: item.host, hash: answer.hash, header: answer.header }
  }

  /** Esplora: the hash it names for `height`, then that hash's 80 header bytes. */
  async esploraBlock(item, height, deadline) {
    const named = await this.explorerText(`${item.base}/block-height/${height}`, item.bytes, deadline)
    if (named.why) return named
    if (!HEX_64.test(named.text)) return { why: 'shape' }
    const header = await this.explorerText(`${item.base}/block/${named.text}/header`, item.bytes, deadline)
    if (header.why) return header
    if (!/^[0-9a-f]{160}$/.test(header.text)) return { why: 'shape' }
    return { hash: named.text, header: fromHex(header.text) }
  }

  /** Esplora: the tip height `{ host, value }`, or `{ host, why }`. */
  async esploraTip(item, deadline) {
    const tip = await this.explorerText(`${item.base}/blocks/tip/height`, item.bytes, deadline)
    if (tip.why) return { host: item.host, why: tip.why }
    return /^[0-9]{1,9}$/.test(tip.text) ? { host: item.host, value: Number(tip.text) } : { host: item.host, why: 'shape' }
  }

  /**
   * fields: a block's JSON fields rebuilt into the 80 header bytes. haskoin (api.blockchain.info): a list of ONE block,
   * `mainchain` true, `version`, `previous`, `merkle`, `time` in seconds, `bits`, `nonce`. blockcypher: one block, `ver`,
   * `prev_block`, `mrkl_root`, `time` an ISO string, `bits`, `nonce`. Both: `hash`, `height` (another height: self-mismatch).
   */
  async fieldsBlock(item, height, deadline) {
    const haskoin = item.fields === 'haskoin'
    const reply = await this.explorerText(haskoin ? `${item.base}/block/height/${height}?notx=true` : `${item.base}/blocks/${height}`, item.bytes, deadline)
    if (reply.why) return reply
    try {
      const parsed = JSON.parse(reply.text)
      const block = haskoin ? (Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null) : parsed
      if (!isObject(block) || typeof block.hash !== 'string' || !HEX_64.test(block.hash) || !Number.isSafeInteger(block.height)) return { why: 'shape' }
      if (haskoin && block.mainchain !== true) return { why: 'shape' }
      const time = haskoin ? block.time : typeof block.time === 'string' ? Date.parse(block.time) / 1000 : NaN
      if (!Number.isSafeInteger(time)) return { why: 'shape' }
      if (block.height !== height) return { why: 'self-mismatch' }
      const header = haskoin
        ? rebuildHeader({ version: block.version, prevHash: block.previous, merkleRoot: block.merkle, time, bits: block.bits, nonce: block.nonce })
        : rebuildHeader({ version: block.ver, prevHash: block.prev_block, merkleRoot: block.mrkl_root, time, bits: block.bits, nonce: block.nonce })
      return { hash: block.hash, header }
    } catch (_error) { return { why: 'shape' } }
  }

  /**
   * raw (api.bitaps.com): `{ data: { height, hash, header } }`, the header base64 of 80 to 89 bytes (the header, then the
   * block's transaction count), the first 80 taken. Another height: self-mismatch.
   */
  async rawBlock(item, height, deadline) {
    const reply = await this.explorerText(`${item.base}/block/${height}`, item.bytes, deadline)
    if (reply.why) return reply
    try {
      const block = JSON.parse(reply.text)?.data
      if (!isObject(block) || typeof block.hash !== 'string' || !HEX_64.test(block.hash) || !Number.isSafeInteger(block.height)
        || typeof block.header !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.header)) return { why: 'shape' }
      const bytes = Uint8Array.from(atob(block.header), char => char.charCodeAt(0))
      if (bytes.length < 80 || bytes.length > 89) return { why: 'shape' }
      if (block.height !== height) return { why: 'self-mismatch' }
      return { hash: block.hash, header: bytes.slice(0, 80) }
    } catch (_error) { return { why: 'shape' } }
  }

  /** GET <uri>/timestamp/<commitment>: the reply's tree, or null (not 200, too large, unparseable, any failure). */
  async askUpgrade(leaf) {
    try {
      const response = await this.net(`${leaf.uri.replace(/\/$/, '')}/timestamp/${leaf.commitment}`, { method: 'GET',
        headers: { ...WITNESS_UPGRADE_HEADERS }, redirect: 'manual', signal: AbortSignal.timeout(WITNESS_LIMITS.callTimeoutMs) })
      if (response.status !== 200) { void response.body?.cancel().catch(() => {}); return null }
      const bytes = await boundedBytes(response, WITNESS_LIMITS.replyBytes)
      return bytes === null ? null : parseTree(bytes)
    } catch (_error) { return null }
  }

  async retryPass(entries, now, result, code) {
    let stamps = 0
    for (const entry of entries) {
      if (stamps >= WITNESS_LIMITS.stampsPerTick) break
      // 'none' is a stamp that never finished (the object restarted, or a write failed mid-stamp): retried like 'failed'.
      if (!['failed', 'none'].includes(entry.ots.state) || entry.ots.attempts >= WITNESS_LIMITS.attempts) continue
      stamps++
      await this.stamp(entry, now, result, code)
    }
    // Review of the landing branch (MUST): a record signed before the window is not in `entries`, so its seq is kept in
    // meta.outside until its publish is done (every relay ok, or each relay's three attempts used) and it is sent first each tick.
    // At most publishesPerTick such records wait at once (signPending stops signing before the window when the list is
    // full), so every one of them has a publish slot in every tick until it is done.
    const outside = await this.outsidePending(entries)
    await this.signPending(entries, outside, result, code)
    let publishes = 0
    for (const entry of [...outside, ...entries]) {
      if (publishes >= WITNESS_LIMITS.publishesPerTick) break
      if (!publishOwed(entry)) continue
      publishes++
      await this.publish(entry, result)
    }
    await this.noteOutside(outside.filter(publishOwed).map(entry => entry.seq))
  }

  /** The records before the window still owed a publish (meta.outside), oldest first; at most publishesPerTick. */
  async outsidePending(entries) {
    const meta = await this.storage.get(META)
    if (!isObject(meta) || !Array.isArray(meta.outside)) return []
    const inWindow = new Set(entries.map(entry => entry.seq))
    const seqs = [...new Set(meta.outside)].filter(seq => Number.isSafeInteger(seq) && seq >= 1 && seq <= meta.seq && !inWindow.has(seq))
      .sort((a, b) => a - b).slice(0, WITNESS_LIMITS.publishesPerTick)
    if (!seqs.length) return []
    const found = await this.storage.get(seqs.map(recordKey))
    return seqs.map(seq => found.get(recordKey(seq))).filter(entry => isObject(entry) && publishOwed(entry))
  }

  /** meta.outside: the seqs of records before the window still owed a publish. */
  async noteOutside(seqs) {
    const meta = await this.storage.get(META)
    if (!isObject(meta)) return
    const before = Array.isArray(meta.outside) ? meta.outside : []
    if (JSON.stringify(before) === JSON.stringify(seqs)) return
    const { outside: _dropped, ...rest } = meta
    await this.storage.put(META, seqs.length ? { ...rest, outside: seqs } : rest)
  }

  /**
   * Sign unsigned records in seq order from the first unsigned one (meta.signed + 1), wherever it is, even before the
   * window: a record is signed only once the one before it has its event. At most WITNESS_LIMITS.signsPerTick signs and
   * WITNESS_LIMITS.window record reads a tick. A record before the window is signed only while `outside` (the records
   * before the window still owed a publish) holds fewer than publishesPerTick; each one signed here joins it (and
   * meta.outside), so the publish pass sends it this tick and retries it on later ones.
   */
  async signPending(entries, outside, result, code) {
    const meta = await this.storage.get(META)
    if (!isObject(meta) || !meta.seq) return []
    const inWindow = new Map(entries.map(entry => [entry.seq, entry]))
    const load = async seq => inWindow.get(seq) ?? await this.storage.get(recordKey(seq))
    const start = Number.isSafeInteger(meta.signed) && meta.signed >= 0 && meta.signed <= meta.seq ? meta.signed : 0
    let seq = start + 1, before = start ? await load(start) : null, reads = 0, signs = 0, contiguous = start
    const waiting = outside.length
    while (seq <= meta.seq && reads < WITNESS_LIMITS.window && signs < WITNESS_LIMITS.signsPerTick) {
      const entry = await load(seq)
      reads++
      if (!isObject(entry) || (seq > 1 && !before?.event)) { code('WITNESS_STATE_CORRUPT'); break }
      if (!entry.event) {
        if (!inWindow.has(seq) && outside.length >= WITNESS_LIMITS.publishesPerTick) break
        signs++
        if (!await this.sign(entry, before?.event?.id ?? null, code)) break
        result.signed++
        if (!inWindow.has(seq)) outside.push(entry)
      }
      contiguous = seq
      before = entry
      seq++
    }
    if (contiguous !== start) await this.noteSigned(contiguous)
    if (outside.length !== waiting) await this.noteOutside(outside.map(entry => entry.seq))
  }

  /** meta.signed: every record up to this seq has its event (where the next signing starts). */
  async noteSigned(seq, pubkey) {
    const meta = await this.storage.get(META)
    if (!isObject(meta)) return
    const signed = Math.max(Number.isSafeInteger(meta.signed) ? meta.signed : 0, seq)
    if (signed !== meta.signed || (pubkey && meta.pubkey !== pubkey)) await this.storage.put(META, { ...meta, signed, ...(pubkey ? { pubkey } : {}) })
  }

  /**
   * The promotion rule. A record only when the head HEAD reads now differs from the newest record's facts.head, at
   * least promotionFloorMs after the newest record, and fewer than promotionsPerWindow promotion records in the last
   * promotionWindowMs. The floor and the cap are checked before HEAD is asked anything.
   */
  async promotionRecord(meta, entries, now, result, code) {
    const newest = entries.at(-1)
    if (newest && now - newest.record.at < WITNESS_LIMITS.promotionFloorMs) {
      code('WITNESS_PROMOTION_TOO_SOON')
      // Review: a deferral, not a drop. The alarm is set for the floor's end (an earlier one is kept), so the last head of a
      // burst (a rollback inside the floor included) gets its record then, not at the next 4-hour record.
      try { await this.armAt(newest.record.at + WITNESS_LIMITS.promotionFloorMs) } catch (_error) { /* the next hourly tick still runs */ }
      return
    }
    const recent = entries.filter(entry => entry.trigger === 'promotion' && now - entry.record.at < WITNESS_LIMITS.promotionWindowMs).length
    if (recent >= WITNESS_LIMITS.promotionsPerWindow) { code('WITNESS_PROMOTION_CAP'); return }
    const read = await this.readFacts(code)
    const head = read.facts.head, before = newest?.record.facts.head ?? null
    if (head === null || (before !== null && before.ballId === head.ballId && before.epoch === head.epoch)) return
    await this.newRecord(meta, entries, now, result, code, { read, trigger: 'promotion' })
  }

  async newRecord(meta, entries, now, result, code, { read = null, trigger = 'schedule' } = {}) {
    const seq = meta.seq + 1
    const prev = entries.at(-1)?.digest ?? (meta.seq === 0 ? WITNESS_ZERO : null)
    if (prev === null) throw failed('WITNESS_STATE_CORRUPT')
    const { facts, reasons, pubkey } = read ?? await this.readFacts(code)
    // Always the current version (v 2, with the nightly fact): buildWitnessRecord refuses facts of any other shape.
    const record = buildWitnessRecord({ seq, prev, at: now, facts, reasons, v: WITNESS_VERSION })
    const digest = await witnessDigest(record)
    // `trigger` is kept beside the record, never inside it: the hashed record's shape does not change.
    const entry = { seq, digest, record, nonce: toHex(this.randomBytes(16)), eventId: null, event: null, relays: null, publishAttempts: 0,
      ots: { state: 'none', height: null, attempts: 0, at: null }, trigger }
    if (entry.nonce.length !== 32) throw failed('WITNESS_NONCE_UNAVAILABLE')
    await this.put(entry)
    // Re-read: the retry pass may have moved meta.signed (or the pubkey) since the tick began.
    const current = await this.storage.get(META) ?? meta
    await this.storage.put(META, { ...current, seq, pubkey: pubkey ?? current.pubkey ?? null })
    result.created = true
    result.seq = seq
    await this.stamp(entry, now, result, code)
    const before = entries.at(-1)
    if (seq === 1 || (before?.seq === seq - 1 && before.event && current.signed === seq - 1)) {
      if (await this.sign(entry, before?.event?.id ?? null, code)) {
        result.signed++
        await this.publish(entry, result)
      }
    }
  }

  /**
   * The facts: HEAD's one read (head, receipts, pubkey), then the mirror's one bounded journals read; the nightly commitment: beside them,
   * at the same time, the nightly pointer's one bounded read (it never throws and never outlasts its deadline).
   */
  async readFacts(code) {
    const facts = { head: null, receipts: null, journals: null, nightly: null }, reasons = {}
    let pubkey = null, seedId = null
    const nightlyRead = readNightlyFact(this.env, { timeoutMs: this.nightlyTimeoutMs })
    const answer = await this.internal('HEAD', WITNESS_HEAD_ROUTES.facts)
    if (answer?.ok === true) {
      seedId = typeof answer.seedId === 'string' && HEX_64.test(answer.seedId) ? answer.seedId : null
      pubkey = typeof answer.pubkey === 'string' && HEX_64.test(answer.pubkey) ? answer.pubkey : null
      facts.head = answer.head ?? null
      facts.receipts = answer.receipts ?? null
      if (facts.head === null) reasons.head = answer.reasons?.head === 'head-none' ? 'head-none' : 'head-unavailable'
      if (facts.receipts === null) reasons.receipts = 'receipts-unavailable'
    } else code('WITNESS_FACTS_UNAVAILABLE')
    if (seedId) {
      const journals = await this.internal('MIRROR', WITNESS_MIRROR_ROUTE, { seedId })
      if (journals?.ok === true && Array.isArray(journals.journals)) facts.journals = journals.journals
      else if (journals?.code === 'MIRROR_WITNESS_OVER_BOUND') reasons.journals = 'journals-over-bound'
    }
    if (facts.journals === null && !reasons.journals) reasons.journals = 'journals-unavailable'
    const nightly = await nightlyRead
    facts.nightly = nightly.nightly
    if (facts.nightly === null) reasons.nightly = nightly.reason ?? 'nightly-unavailable'
    // A fact whose shape does not check is null with its plain reason, never repaired.
    for (const fact of ['head', 'receipts', 'journals', 'nightly']) {
      if (facts[fact] !== null && !witnessFactValid(fact, facts[fact])) { facts[fact] = null; reasons[fact] = `${fact}-unavailable` }
    }
    return { facts, reasons, pubkey }
  }

  /** One internal call to HEAD or the mirror: its JSON answer (bounded, with its own deadline), or null. */
  async internal(name, path, { seedId, body } = {}) {
    const binding = this.env?.[name]
    if (!binding) return null
    try {
      const response = await binding.get(binding.idFromName('node-main-v1')).fetch(new Request('https://x61.internal' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-x6-internal-authorized': '1', ...(seedId ? { 'x-x6-bootstrap-seed': seedId } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(WITNESS_LIMITS.internalTimeoutMs),
      }))
      return await boundedJson(response, WITNESS_LIMITS.internalBytes)
    } catch (_error) { return null }
  }

  /** Submit sha256(digest || nonce) to the four calendars in parallel; two good replies make the proof. Same nonce always. */
  async stamp(entry, now, result, code) {
    entry.ots.attempts++
    try {
      const digest = fromHex(entry.digest), nonce = fromHex(entry.nonce)
      const commitment = await stampCommitment(digest, nonce)
      const replies = await Promise.all(WITNESS_CALENDARS.map(origin => this.submit(origin, commitment)))
      // A reply counts only if the edge can run every op on its path (no RIPEMD-160 / Keccak here, every message within
      // the bound): run it alone, from this digest and nonce, before it may join the proof.
      const good = []
      for (const bytes of replies) {
        if (!bytes) continue
        try { await pendingLeaves(buildDetached(digest, nonce, [bytes])); good.push(bytes) } catch (_error) { /* not counted */ }
      }
      if (good.length >= WITNESS_LIMITS.minCalendars) {
        const proof = buildDetached(digest, nonce, good)
        await pendingLeaves(proof)
        await this.storage.put(otsKey(entry.seq), toHex(proof))
        entry.ots = { state: 'pending', height: null, attempts: entry.ots.attempts, at: now }
        await this.put(entry)
        result.stamped++
        return
      }
    } catch (_error) { /* counted as a failed attempt below */ }
    entry.ots.state = 'failed'
    await this.put(entry)
    code('WITNESS_STAMP_FAILED')
  }

  /** One calendar's reply bytes when it is a tree ending in a pending attestation; null otherwise. */
  async submit(origin, commitment) {
    try {
      const response = await this.net(`${origin}/digest`, { method: 'POST', headers: { ...WITNESS_CALENDAR_HEADERS }, body: commitment,
        redirect: 'manual', signal: AbortSignal.timeout(WITNESS_LIMITS.callTimeoutMs) })
      if (response.status !== 200) { void response.body?.cancel().catch(() => {}); return null }
      const bytes = await boundedBytes(response, WITNESS_LIMITS.replyBytes)
      if (bytes === null) return null
      const tree = parseTree(bytes)
      return treeHasPending(tree) && !treeHasBitcoin(tree) ? bytes : null
    } catch (_error) { return null }
  }

  /** Ask HEAD to sign this record's event. True when the event came back exactly as asked and verifies. */
  async sign(entry, prevEventId, code) {
    const answer = await this.internal('HEAD', WITNESS_HEAD_ROUTES.sign, { body: { seq: entry.seq, digest: entry.digest, prevEventId } })
    if (answer?.ok !== true) {
      code(answer?.code === 'WITNESS_IDENTITY_REQUIRED' ? 'WITNESS_IDENTITY_REQUIRED' : answer?.code?.startsWith?.('WITNESS_SIGN_') ? 'WITNESS_SIGN_REFUSED' : 'WITNESS_SIGN_UNAVAILABLE')
      return false
    }
    const event = answer.event
    const expected = [...(entry.seq === 1 ? [] : [['e', prevEventId]]), ['seq', String(entry.seq)], ['digest', entry.digest], ['chain', WITNESS_CHAIN_TAG]]
    if (!isObject(event) || event.kind !== WITNESS_KIND || event.content !== '' || JSON.stringify(event.tags) !== JSON.stringify(expected) || !await verifyNostrEvent(event)) {
      code('WITNESS_SIGN_UNAVAILABLE')
      return false
    }
    entry.event = event
    entry.eventId = event.id
    entry.relays = Object.fromEntries(WITNESS_RELAYS.map(url => [url, 'none']))
    await this.put(entry)
    await this.noteSigned(entry.seq, event.pubkey)
    return true
  }

  /** Send the event to every relay not yet ok with attempts left, in parallel; one attempt each. */
  async publish(entry, result) {
    const targets = publishTargets(entry)
    const tries = Object.fromEntries(WITNESS_RELAYS.map(url => [url, relayTries(entry, url) + (targets.includes(url) ? 1 : 0)]))
    entry.publishAttempts++
    const states = await Promise.all(targets.map(url => this.sendToRelay(url, entry.event)))
    entry.relays = { ...Object.fromEntries(WITNESS_RELAYS.map(url => [url, entry.relays?.[url] ?? 'none'])), ...Object.fromEntries(targets.map((url, index) => [url, states[index]])) }
    entry.relayTries = tries
    await this.put(entry)
    result.published++
  }

  /**
   * The read-back. For the newest published records (at most readbackRecords) with a relay not asked in the last
   * readbackEveryMs, ask each such relay for the event by id, all of a record's relays at once. The answer is kept beside the
   * record (`held`: per relay { held, at }; `heldCheckedAt`), never in it. A relay that times out, holds nothing, answers a
   * wrong or badly signed event, or closes the subscription does not hold it.
   */
  async readbackPass(entries, now, code) {
    const due = (entry, url) => { const row = entry.held?.[url]; return !(isObject(row) && count(row.at) && now - row.at >= 0 && now - row.at < WITNESS_LIMITS.readbackEveryMs) }
    // Review: the 4 newest published records first, then only those due (never a walk back through older records).
    const records = entries.filter(entry => entry.event && entry.eventId && entry.publishAttempts >= 1)
      .slice(-WITNESS_LIMITS.readbackRecords).filter(entry => WITNESS_RELAYS.some(url => due(entry, url))).reverse()
    const started = Date.now()
    for (const entry of records) {
      if (Date.now() - started >= WITNESS_LIMITS.readbackTotalMs) { code('WITNESS_READBACK_OVER_TIME'); break }
      const urls = WITNESS_RELAYS.filter(url => due(entry, url))
      const held = await Promise.all(urls.map(url => this.readFromRelay(url, entry.event)))
      entry.held = { ...(isObject(entry.held) ? entry.held : {}), ...Object.fromEntries(urls.map((url, index) => [url, { held: held[index], at: now }])) }
      entry.heldCheckedAt = now
      await this.put(entry)
    }
  }

  /**
   * `["REQ", <first 16 hex of the id>, { ids: [id] }]` on one socket: true as soon as a returned event is this one exactly;
   * false on EOSE, CLOSED, the wait, or past readbackFrames frames. Nothing is read once it is decided.
   */
  readFromRelay(url, event) {
    return new Promise(resolve => {
      let done = false, socket = null, timer = null, frames = 0
      const sub = event.id.slice(0, 16)
      const finish = held => {
        if (done) return
        done = true
        if (timer !== null) this.timers.clear(timer)
        try { socket?.close() } catch (_error) { /* already closed */ }
        resolve(held)
      }
      timer = this.timers.set(() => finish(false), WITNESS_LIMITS.readbackWaitMs)
      try {
        socket = this.openSocket(url)
        socket.addEventListener('open', () => { try { socket.send(JSON.stringify(['REQ', sub, { ids: [event.id] }])) } catch (_error) { finish(false) } })
        socket.addEventListener('message', message => {
          if (done) return
          if (++frames > WITNESS_LIMITS.readbackFrames) { finish(false); return }
          const frame = readFrame(message?.data)
          if (!frame || frame[1] !== sub) return
          if (frame[0] === 'EVENT') { if (heldEvent(frame[2], event)) finish(true) }
          else if (frame[0] === 'EOSE' || frame[0] === 'CLOSED') finish(false)
        })
        socket.addEventListener('error', () => finish(false))
        socket.addEventListener('close', () => finish(false))
      } catch (_error) { finish(false) }
    })
  }

  /** `["EVENT", event]` on one socket; the relay's OK within WITNESS_LIMITS.relayWaitMs, as a closed state. */
  sendToRelay(url, event) {
    return new Promise(resolve => {
      let done = false, socket = null, timer = null
      const finish = state => {
        if (done) return
        done = true
        if (timer !== null) this.timers.clear(timer)
        try { socket?.close() } catch (_error) { /* already closed */ }
        resolve(state)
      }
      timer = this.timers.set(() => finish('timeout'), WITNESS_LIMITS.relayWaitMs)
      try {
        socket = this.openSocket(url)
        socket.addEventListener('open', () => { try { socket.send(JSON.stringify(['EVENT', event])) } catch (_error) { finish('timeout') } })
        socket.addEventListener('message', message => { const state = relayState(message?.data, event.id); if (state) finish(state) })
        socket.addEventListener('error', () => finish('timeout'))
        socket.addEventListener('close', () => finish('timeout'))
      } catch (_error) { finish('timeout') }
    })
  }

  /** The signed-out view: the newest records, newest first; fingerprints, links, counts, times and states only. */
  async publicView() {
    const meta = await this.storage.get(META) ?? { seq: 0, pubkey: null }
    const entries = (await this.window(meta.seq)).slice(-WITNESS_LIMITS.shown).reverse()
    const newest = entries[0]
    return {
      schema: 'witness.v1',
      pubkey: typeof meta.pubkey === 'string' && HEX_64.test(meta.pubkey) ? meta.pubkey : null,
      head: newest ? { seq: newest.seq, digest: newest.digest, at: newest.record.at } : null,
      records: entries.map(entry => ({ seq: entry.seq, at: entry.record.at, digest: entry.digest, prev: entry.record.prev, eventId: entry.eventId,
        // What made the record; a record stored before the field existed was made by the schedule.
        trigger: entry.trigger === 'promotion' ? 'promotion' : 'schedule',
        relays: relaysRow(entry),
        // The header check kept beside the record; a record stored before it reads null.
        ots: { state: entry.ots.state, height: entry.ots.height, header: publicHeader(entry.header) },
        // The RFC 3161 token's state (stored, never "verified"); null when off or never asked.
        tsa: witnessTsaOn(this.env) ? publicTsa(entry.tsa) : null })),
    }
  }
}

// ---- The Worker's side (worker.mjs WITNESS hooks) ----

export const WITNESS_PUBLIC_ROUTE = '/api/witness'
export const WITNESS_PUBLIC_OTS_ROUTE = '/api/witness/ots'
/** One whole hashed record for anyone, served only while WITNESS_RECORD_PUBLIC is exactly "on" (shipped "off"). */
export const WITNESS_PUBLIC_RECORD_ROUTE = '/api/witness/record'
/** The stored RFC 3161 reply for record n, as the authority sent it (application/timestamp-reply). */
export const WITNESS_PUBLIC_TSA_ROUTE = '/api/witness/tsa'
export const WITNESS_PUBLIC_ROUTES = Object.freeze(new Set([WITNESS_PUBLIC_ROUTE, WITNESS_PUBLIC_OTS_ROUTE, WITNESS_PUBLIC_RECORD_ROUTE, WITNESS_PUBLIC_TSA_ROUTE]))
/** The owner's switch for the outsider's record read (wrangler.toml [vars]): only exactly "on" serves it. */
export const witnessRecordPublic = env => env?.WITNESS_RECORD_PUBLIC === 'on'
/** The owner's read of one whole record, facts included (owner session, same-origin GET, as the other owner reads). */
export const WITNESS_OWNER_ROUTE = '/_head/witness/record'
export const WITNESS_DOOR_LIMITS = Object.freeze({ cacheMs: 60000, readTimeoutMs: 10000, tickTimeoutMs: 120000, cachedProofs: 32, recordBytes: 64 * 1024, kickTimeoutMs: 5000,
  // The public view's read. Five relay rows per record make 24 records about 19 KiB at their widest (past the
  // 16 KiB internalBytes it was read with); its own bound, internalBytes unchanged for every other internal answer.
  // Each header check may carry 8 tried rows, which takes the widest 24-record view to about 36 KiB (past 32).
  publicBytes: 48 * 1024 })
const OTS_STATES = new Set(['none', 'pending', 'confirmed', 'failed', 'stale'])
const HEADER_CODES = new Set(WITNESS_HEADER_CODES)
/**
 * A header check exactly, rebuilt from its own fields, or undefined when it is not one: null (not tried),
 * { checked: true, hash, time, confirmations (6 or more), sources: two distinct listed hosts, at },
 * { checked: false, code (closed), at }.
 */
function publicHeader(header) {
  if (header === null || header === undefined) return null
  if (!isObject(header) || !count(header.at)) return undefined
  // `tried` when there (at most headerTriedRows rows of an allow-listed host and a closed word); a check stored
  // before it has none and reads as before.
  const tried = header.tried === undefined ? undefined : publicTried(header.tried)
  if (tried === null) return undefined
  const withTried = shown => tried === undefined ? shown : { ...shown, tried }
  if (header.checked === false) return HEADER_CODES.has(header.code) ? withTried({ checked: false, code: header.code, at: header.at }) : undefined
  if (header.checked !== true || typeof header.hash !== 'string' || !HEX_64.test(header.hash) || !count(header.time) || header.time > 0xffffffff
    || !count(header.confirmations) || header.confirmations < WITNESS_LIMITS.headerConfirmations || !Array.isArray(header.sources) || header.sources.length !== 2
    || !header.sources.every(host => WITNESS_HEADER_HOSTS.has(host)) || header.sources[0] === header.sources[1]) return undefined
  return withTried({ checked: true, hash: header.hash, time: header.time, confirmations: header.confirmations, sources: [...header.sources], at: header.at })
}
/** The tried rows rebuilt from `host` and `why` only, or null when they are not exactly that. */
function publicTried(tried) {
  if (!Array.isArray(tried) || tried.length > WITNESS_LIMITS.headerTriedRows) return null
  if (!tried.every(row => isObject(row) && WITNESS_HEADER_HOSTS.has(row.host) && typeof row.why === 'string' && WITNESS_HEADER_WHY.test(row.why))) return null
  return tried.map(row => ({ host: row.host, why: row.why }))
}
const TSA_STATES = new Set(['stored', 'failed'])
/** A token's public state exactly, or null when there is none to show; undefined when it is not one. */
function publicTsa(tsa) {
  if (tsa === null || tsa === undefined) return null
  if (!isObject(tsa) || !TSA_STATES.has(tsa.state) || !count(tsa.at)) return undefined
  return { state: tsa.state, authority: TSA_AUTHORITY, at: tsa.at }
}
const WITNESS_TRIGGERS = new Set(['schedule', 'promotion'])
const count = value => Number.isSafeInteger(value) && value >= 0

/** One internal call to the witness object (the Worker's only way in). */
export function witnessCall(env, path, { method = 'GET', signal } = {}) {
  const binding = env?.WITNESS
  if (!binding) throw failed('WITNESS_BINDING_MISSING')
  return binding.get(binding.idFromName('node-main-v1')).fetch(new Request('https://x61.internal' + path, { method, headers: { 'x-x6-internal-authorized': '1' }, signal }))
}

/** The hourly tick (the Worker's `scheduled` handler). Never throws: the tick's answer, or null. */
export async function witnessTick(env) {
  if (!witnessSwitchOn(env)) return null // The owner's switch is off: no call at all.
  try {
    const response = await witnessCall(env, WITNESS_ROUTES.tick, { method: 'POST', signal: AbortSignal.timeout(WITNESS_DOOR_LIMITS.tickTimeoutMs) })
    return await boundedJson(response, WITNESS_LIMITS.internalBytes)
  } catch (_error) { return null }
}

/**
 * HEAD's one kick after a promotion commits (head-do.mjs WITNESS hook). True when the object took it, false on any
 * fault (no binding, a throw, a non-2xx answer, the deadline), null with the switch off (no call at all). Never throws.
 */
export async function witnessKick(env) {
  if (!witnessSwitchOn(env)) return null
  try {
    const response = await witnessCall(env, WITNESS_ROUTES.kick, { method: 'POST', signal: AbortSignal.timeout(WITNESS_DOOR_LIMITS.kickTimeoutMs) })
    void response.body?.cancel().catch(() => {})
    return response.ok
  } catch (_error) { return false }
}

/** A relays row exactly: five rows in relay order, closed states, and counts that agree with the rows. */
function validRelaysRow(relays) {
  if (!isObject(relays) || relays.of !== WITNESS_RELAYS.length || !count(relays.ok) || !Array.isArray(relays.rows) || relays.rows.length !== WITNESS_RELAYS.length) return false
  // Anything else a row carries is not served (the projection rebuilds each row from these three fields).
  const rowsValid = relays.rows.every((row, index) => isObject(row) && row.relay === relayHost(WITNESS_RELAYS[index])
    && SENT_STATES.has(row.sent) && [true, false, null].includes(row.held))
  if (!rowsValid || relays.ok !== relays.rows.filter(row => OK_STATES.has(row.sent)).length) return false
  if (relays.held === null) return relays.heldCheckedAt === null
  return count(relays.held) && count(relays.heldCheckedAt) && relays.held === relays.rows.filter(row => row.held === true).length
}

/** The public view rebuilt from its closed fields only, or null when anything does not check. */
export function projectWitnessPublic(view) {
  const hex = value => typeof value === 'string' && HEX_64.test(value)
  if (!isObject(view) || view.schema !== 'witness.v1' || !(view.pubkey === null || hex(view.pubkey)) || !Array.isArray(view.records) || view.records.length > WITNESS_LIMITS.shown) return null
  const head = view.head === null ? null : isObject(view.head) && count(view.head.seq) && view.head.seq >= 1 && hex(view.head.digest) && count(view.head.at)
    ? { seq: view.head.seq, digest: view.head.digest, at: view.head.at } : undefined
  if (head === undefined) return null
  const records = []
  for (const row of view.records) {
    if (!isObject(row) || !count(row.seq) || row.seq < 1 || !count(row.at) || !hex(row.digest) || !hex(row.prev) || !(row.eventId === null || hex(row.eventId))
      || !WITNESS_TRIGGERS.has(row.trigger)
      || !validRelaysRow(row.relays)
      || !isObject(row.ots) || !OTS_STATES.has(row.ots.state) || !(row.ots.height === null || count(row.ots.height))
      // The header field must be there (null or one exact shape).
      || !(row.ots.header === null || (row.ots.header !== undefined && publicHeader(row.ots.header) !== undefined))
      // Tsa must be there: null or one exact shape, from the one authority.
      || !(row.tsa === null || (isObject(row.tsa) && row.tsa.authority === TSA_AUTHORITY && publicTsa(row.tsa) !== undefined))) return null
    records.push({ seq: row.seq, at: row.at, digest: row.digest, prev: row.prev, eventId: row.eventId, trigger: row.trigger,
      relays: { ok: row.relays.ok, of: row.relays.of, held: row.relays.held, heldCheckedAt: row.relays.heldCheckedAt,
        rows: row.relays.rows.map(relay => ({ relay: relay.relay, sent: relay.sent, held: relay.held })) },
      ots: { state: row.ots.state, height: row.ots.height, header: publicHeader(row.ots.header) }, tsa: publicTsa(row.tsa) })
  }
  return { schema: 'witness.v1', pubkey: view.pubkey, head, records }
}

const publicHeaders = (type, cache) => ({ 'content-type': type, 'access-control-allow-origin': '*',
  'cache-control': cache ? 'public, max-age=60' : 'no-store', 'x-content-type-options': 'nosniff' })
const publicJson = (body, status, cache = false) => new Response(JSON.stringify(body), { status, headers: publicHeaders('application/json; charset=utf-8', cache) })

/**
 * The Worker's signed-out witness door, built like createNostrReadDoor: one instance per isolate, a 60 s cache per
 * answer (the public view, and each proof by seq: at most 32 proofs held), one in-flight read per answer
 * (shared-call.mjs), and the isolate shield on every cache miss. Never shows a record's facts or its missing list.
 * @returns {{serve: Function}} serve(request, url, read) -> Response; read(path, signal) -> the witness object's Response.
 */
export function createWitnessReadDoor({ now = Date.now, shield, subjectOf, cacheMs = WITNESS_DOOR_LIMITS.cacheMs, shareWaitMs = SHARED_CALL_WAIT_MS, shareMaxWaits = SHARED_CALL_MAX_WAITS }) {
  const cache = new Map(), seqs = new Map(), reads = createSharedCalls({ waitMs: shareWaitMs, maxWaits: shareMaxWaits, capacity: WITNESS_DOOR_LIMITS.cachedProofs + 1 })
  const answer = (key, value) => {
    if (value.state === 'unavailable') return publicJson({ ok: false, code: 'WITNESS_UNAVAILABLE' }, 503)
    if (value.state === 'none') return publicJson({ ok: false, code: key.startsWith('record:') ? 'WITNESS_RECORD_NONE' : key.startsWith('tsa:') ? 'WITNESS_TSA_NONE' : 'WITNESS_OTS_NONE' }, 404, true)
    // Exactly the hashed record and its digest; never the nonce, the event, the relay rows or the trigger.
    if (value.state === 'record') return publicJson({ ok: true, seq: value.seq, digest: value.digest, record: value.record }, 200, true)
    // The RFC 3161 reply, byte for byte as stored.
    if (value.state === 'token') {
      const headers = publicHeaders(TSA_REPLY_TYPE, true)
      headers['content-disposition'] = `attachment; filename="witness-${key.slice('tsa:'.length)}.tsr"`
      return new Response(value.bytes.slice(), { status: 200, headers })
    }
    if (value.state === 'proof') {
      const headers = publicHeaders('application/octet-stream', true)
      headers['content-disposition'] = `attachment; filename="witness-${key.slice('ots:'.length)}.ots"`
      return new Response(value.bytes.slice(), { status: 200, headers })
    }
    return publicJson(value.view, 200, true)
  }
  const load = async (key, read) => {
    try {
      const [kind, seqText] = key.split(':')
      const path = kind === 'public' ? WITNESS_ROUTES.public : `${kind === 'record' ? WITNESS_ROUTES.record : kind === 'tsa' ? WITNESS_ROUTES.tsa : WITNESS_ROUTES.ots}?seq=${seqText}`
      const response = await read(path, AbortSignal.timeout(WITNESS_DOOR_LIMITS.readTimeoutMs))
      if (key === 'public') {
        const body = response.ok ? await boundedJson(response, WITNESS_DOOR_LIMITS.publicBytes) : null
        const view = body?.ok === true ? projectWitnessPublic(body.public) : null
        return view ? { state: 'view', view } : { state: 'unavailable' }
      }
      if (kind === 'record') {
        if (response.status === 404) { void response.body?.cancel().catch(() => {}); return { state: 'none' } }
        const body = response.ok ? await boundedJson(response, WITNESS_DOOR_LIMITS.recordBytes) : null
        const seq = Number(seqText)
        // The record must be one exactly, of this seq, and its digest must recompute here; it is rebuilt from its own keys.
        if (body?.ok !== true || body.seq !== seq || !validWitnessRecord(body.record) || body.record.seq !== seq) return { state: 'unavailable' }
        const digest = await witnessDigest(body.record)
        if (body.digest !== digest) return { state: 'unavailable' }
        return { state: 'record', seq, digest, record: structuredClone(body.record) }
      }
      if (response.status === 404) { void response.body?.cancel().catch(() => {}); return { state: 'none' } }
      if (response.status !== 200) { void response.body?.cancel().catch(() => {}); return { state: 'unavailable' } }
      if (kind === 'tsa') {
        const bytes = await boundedBytes(response, TSA_REPLY_BYTES)
        if (bytes === null) return { state: 'unavailable' }
        sanityReadReply(bytes) // its shape only: the door does not know the digest or the nonce
        return { state: 'token', bytes }
      }
      const bytes = await boundedBytes(response, OTS_LIMITS.proofBytes)
      if (bytes === null) return { state: 'unavailable' }
      parseOts(bytes)
      return { state: 'proof', bytes }
    } catch (_error) { return { state: 'unavailable' } }
  }
  return Object.freeze({
    async serve(request, url, read, { recordPublic = false } = {}) {
      // The record read is off unless the Worker says exactly true (WITNESS_RECORD_PUBLIC "on"): no object call.
      if (url.pathname === WITNESS_PUBLIC_RECORD_ROUTE && recordPublic !== true) return publicJson({ ok: false, code: 'WITNESS_RECORD_NOT_PUBLIC' }, 404)
      if (url.hash) return publicJson({ ok: false, code: 'NOT_FOUND' }, 404)
      let key = 'public'
      if (url.pathname === WITNESS_PUBLIC_ROUTE) {
        if (url.href.includes('?')) return publicJson({ ok: false, code: 'NOT_FOUND' }, 404)
      } else {
        const match = SEQ_QUERY.exec(url.search)
        if (!match || !Number.isSafeInteger(Number(match[1]))) return publicJson({ ok: false, code: 'NOT_FOUND' }, 404)
        key = `${url.pathname === WITNESS_PUBLIC_RECORD_ROUTE ? 'record' : url.pathname === WITNESS_PUBLIC_TSA_ROUTE ? 'tsa' : 'ots'}:${Number(match[1])}`
      }
      if (request.method !== 'GET') {
        const refused = publicJson({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
        refused.headers.set('allow', 'GET')
        return refused
      }
      if (request.body !== null || request.headers.has('transfer-encoding') || (request.headers.has('content-length') && request.headers.get('content-length') !== '0')) {
        return publicJson({ ok: false, code: 'WITNESS_REQUEST_INVALID' }, 400)
      }
      const at = now()
      const cached = cache.get(key)
      if (cached && cached.until > at) return answer(key, cached.value)
      const taken = shield.take(subjectOf(request), at)
      if (!taken.ok) {
        const refused = publicJson({ ok: false, code: 'WITNESS_READ_BUSY' }, 429)
        if (Number.isFinite(taken.retryAfterMs)) refused.headers.set('retry-after', String(Math.max(1, Math.ceil(taken.retryAfterMs / 1000))))
        return refused
      }
      try {
        return answer(key, await reads.call(key, async ({ seq }) => {
          const value = await load(key, read)
          // A read that finishes late never replaces the answer of a read that started after it; failures are not kept.
          if (value.state !== 'unavailable' && seq > (seqs.get(key) ?? 0)) {
            cache.delete(key)
            cache.set(key, { value, until: now() + cacheMs })
            seqs.set(key, seq)
            while (cache.size > WITNESS_DOOR_LIMITS.cachedProofs + 1) { const oldest = cache.keys().next().value; cache.delete(oldest); seqs.delete(oldest) }
          }
          return value
        }))
      } catch (error) {
        if (error?.code !== SHARED_CALL_BUSY) throw error
        return answer(key, { state: 'unavailable' })
      }
    },
  })
}

/** The owner's read of one whole record (the Worker checks the owner session first). */
export async function witnessOwnerRecord(env, url, signal) {
  const match = SEQ_QUERY.exec(url.search)
  if (!match || url.hash) return reply({ ok: false, code: 'NOT_FOUND' }, 404)
  try {
    const response = await witnessCall(env, `${WITNESS_ROUTES.record}?seq=${Number(match[1])}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(WITNESS_DOOR_LIMITS.readTimeoutMs)]) : AbortSignal.timeout(WITNESS_DOOR_LIMITS.readTimeoutMs) })
    const body = await boundedJson(response, WITNESS_DOOR_LIMITS.recordBytes)
    if (response.status === 404) return reply({ ok: false, code: 'WITNESS_RECORD_NONE' }, 404)
    if (!response.ok || body?.ok !== true) return reply({ ok: false, code: 'WITNESS_UNAVAILABLE' }, 503)
    return reply({ ok: true, seq: body.seq, digest: body.digest, record: body.record, eventId: body.eventId, event: body.event, relays: body.relays, ots: body.ots })
  } catch (_error) { return reply({ ok: false, code: 'WITNESS_UNAVAILABLE' }, 503) }
}
