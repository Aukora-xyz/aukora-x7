/**
 * A retired browser slot is a TOMBSTONE, never a deletion.
 *
 * The edge cannot see a browser's unsent saves: they live only in that browser's IndexedDB. A
 * browser away for 31 days with unsent work looks exactly like a browser gone for ever, so
 * retiring its slot must keep everything the edge needs to recognise it when it returns: its id,
 * the last sequence and digest the edge acknowledged, the cloud base that save produced, and when.
 *
 * What "the slot" is: the 256-client cap counts `mirror:v2:head:<clientId>` rows. A slot IS a
 * client id's head row, keyed by that id. Retiring frees one place in the COUNT (the head and its
 * receipts are removed); no number, row or sequence is ever handed to another id. Another browser
 * that takes the freed place starts its own head under its own id at sequence 1. The retired id
 * itself can never start again by itself (not even at sequence 1): every request carrying it is
 * answered CLIENT_SLOT_RETIRED until the owner forgets it.
 *
 * Bound: at most SLOT_TOMBSTONE_LIMITS.count tombstones. At the bound no further slot is retired
 * (a new browser at a full table gets today's 507 MIRROR_CLIENT_LIMIT) until the owner forgets
 * tombstones, which needs his passkey and a tombstone at least `graceMs` old. Nothing drops a
 * tombstone automatically, ever.
 */

/** Row prefix, beside the world lease rows: `world:v1:retired:<clientId>`. */
export const SLOT_TOMBSTONE = 'world:v1:retired:'
const DAY_MS = 86400000
/**
 * At most 4,096 tombstones (about 300 bytes each, about 1.2 MB), so about 22 new browsers a day
 * for the whole 180-day grace before the bound is met; one may be forgotten (by the owner only)
 * 180 days after it was written.
 */
export const SLOT_TOMBSTONE_LIMITS = Object.freeze({ count: 4096, graceMs: 180 * DAY_MS })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const time = value => Number.isSafeInteger(value) && value >= 0
const positive = value => Number.isSafeInteger(value) && value > 0
const validBase = base => object(base) && UUID.test(base.lineageId) && positive(base.revision)

/** A well-formed tombstone of exactly this client id. */
export function validTombstone(row, clientId) {
  return object(row) && row.v === 1 && typeof clientId === 'string' && UUID.test(clientId) && row.clientId === clientId
    && (row.state === 'retired' || row.state === 'reader') && row.reason === 'idle'
    && time(row.retiredAt) && time(row.lastSeenAt) && positive(row.seq) && typeof row.digest === 'string' && HASH.test(row.digest)
    && validBase(row.base) && (row.state === 'retired' ? row.resurrectedAt === null : time(row.resurrectedAt))
}

/**
 * The tombstone of this client id inside the caller's transaction: null when there is none (or the
 * id is not a client id), `{ corrupt: true }` when the row exists but is malformed.
 */
export async function readTombstone(tx, clientId) {
  if (typeof clientId !== 'string' || !UUID.test(clientId)) return null
  const row = await tx.get(SLOT_TOMBSTONE + clientId)
  if (row === undefined) return null
  return validTombstone(row, clientId) ? row : { corrupt: true }
}

/** A malformed tombstone is never read as "no tombstone": nothing is accepted, the browser retries later. */
export const TOMBSTONE_UNAVAILABLE = Object.freeze({ ok: false, status: 503, code: 'SLOT_TOMBSTONE_UNAVAILABLE' })

const day = at => new Date(at).toISOString().slice(0, 10)

/**
 * The named answer to a returning retired browser. 409 with its own code, the date, and the way
 * back. NEVER a `conflictCode` field. `kind` is 'delta' (a home save or another write) or 'lease'.
 * @returns {{ok: false, status: 409, code: 'CLIENT_SLOT_RETIRED'}} plus the fields below.
 */
export function retiredReply(row, kind = 'delta') {
  const on = day(row.retiredAt)
  const reader = row.state === 'reader'
  const message = kind === 'delta'
    ? `This browser has unsent work from before ${on}; it is kept here; open /rescue to copy it to her cloud.`
    : reader
      ? `This browser reads her world again. Its unsent work from before ${on} is kept here; open /rescue to copy it to her cloud.`
      : `This browser was set aside on ${on} after 30 days away. Anything it had not sent is kept here and was not applied. Bring it back as a reader, then open /rescue to copy that work to her cloud.`
  return {
    ok: false, status: 409, code: 'CLIENT_SLOT_RETIRED', state: row.state, retiredAt: row.retiredAt, retiredOn: on,
    slot: { seq: row.seq, base: { lineageId: row.base.lineageId, revision: row.base.revision }, lastSeenAt: row.lastSeenAt, resurrectedAt: row.resurrectedAt },
    wayBack: reader ? { open: '/rescue' } : { route: '/_mirror/lease', action: 'resurrect', then: '/rescue' },
    message,
  }
}
