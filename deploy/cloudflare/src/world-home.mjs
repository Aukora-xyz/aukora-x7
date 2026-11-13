/**
 * Her world's home rows in MIRROR, beside the lease (world-lease.mjs) and the slot tombstones
 * (mirror-slot-tombstone.mjs). Every function here runs inside the caller's OPEN transaction and
 * never opens one; a storage error propagates so the caller's transaction rolls back.
 *
 * `world:v1:wrote` answers "when did this browser last WRITE", on the edge clock: it is
 * written only when a home save is applied or a thread append, import or retract commits. Unlike
 * `world:v1:seen` (acquire, renew, take and leased writes), a lease call never moves it, so a browser
 * that only renews is never mistaken for one that worked.
 *
 * `world:v1:home-pending` is RECORDED only in this wave (`HOME_FREEZE=record`, plan 3.4): nothing is
 * refused because of it. It names the rescue whose home is not the cloud's, and the browser it came from.
 */
import { SLOT_TOMBSTONE, SLOT_TOMBSTONE_LIMITS } from './mirror-slot-tombstone.mjs'
import { holderSummary } from './world-holder.mjs' // HOME hook: her body, on the index

export const WORLD_WROTE = 'world:v1:wrote'
export const WORLD_HOME_PENDING = 'world:v1:home-pending'
/** thread-log.mjs keeps its world counts under this key (`{threads, tailBytes}`); read here, never written. */
const THREAD_WORLD = 'thread:v1:world'
/** Fixed bounds: 256 browsers in `wrote` (newest kept), the same bound as `seen`. */
export const WORLD_HOME_LIMITS = Object.freeze({ wrote: 256 })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RESCUE_ID = /^[0-9a-f]{32}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const time = value => Number.isSafeInteger(value) && value >= 0
const clientIdOf = value => (typeof value === 'string' && UUID.test(value) ? value : null)

async function readWrote(tx) {
  const stored = await tx.get(WORLD_WROTE)
  return object(stored) ? Object.fromEntries(Object.entries(stored).filter(([id, at]) => UUID.test(id) && time(at))) : {}
}

/**
 * Note that this browser's write committed, at `now` (edge ms). A clientId that is not a browser id
 * notes nothing. The time never moves backwards; 256 ids at most, the newest kept.
 * @returns {Promise<boolean>} true when the row was written.
 */
export async function noteWrote(tx, clientId, now) {
  const id = clientIdOf(clientId)
  if (id === null || !time(now)) return false
  const wrote = await readWrote(tx)
  if (time(wrote[id]) && wrote[id] >= now) return false
  wrote[id] = now
  const kept = Object.entries(wrote).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, WORLD_HOME_LIMITS.wrote)
  await tx.put(WORLD_WROTE, Object.fromEntries(kept))
  return true
}

/** When the edge last saw this browser's write commit (edge ms), or null. */
export async function clientWroteAt(tx, clientId) {
  const id = clientIdOf(clientId)
  if (id === null) return null
  const wrote = await readWrote(tx)
  return time(wrote[id]) ? wrote[id] : null
}

/** Every browser's last committed write, `{ clientId: ms }` (bounded at 256). */
export async function wroteTimes(tx) {
  return readWrote(tx)
}

const validFence = fence => object(fence) && typeof fence.lineageId === 'string' && UUID.test(fence.lineageId) && time(fence.revision)

/**
 * Whether a rescued browser's home is the cloud's. `base` is the kit's `client.base`: the browser's
 * `@x6-mirror-meta.cloudBase`, `{lineageId, revision}` (rescue-kit.mjs collect; idb-persist.ts MirrorMeta).
 * "In step" is exactly the fence: the same lineageId AND the same revision. Anything else is behind:
 * a lower revision, another lineage (the cloud was reset since), a missing or malformed base (that
 * browser never had a cloud base), and a revision past the fence (impossible; unknown is not fresh).
 */
export function homeBaseBehind(base, fence) {
  if (!validFence(fence)) return true
  if (!object(base) || typeof base.lineageId !== 'string' || !time(base.revision)) return true
  return base.lineageId !== fence.lineageId || base.revision !== fence.revision
}

/** A verifiedAt as edge ms: the vault writes an ISO string (vault.mjs manifest), a number is taken as ms. */
export function verifiedAtMs(value) {
  if (time(value)) return value
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null
  const ms = Date.parse(value)
  return time(ms) ? ms : null
}

/** The exact shape the Worker sends beside a committing import: `{rescue, clientId, base, reconciliation, verifiedAt}`. */
export function validHomeInput(home) {
  if (!object(home)) return false
  const keys = Object.keys(home).sort().join(',')
  if (keys !== 'base,clientId,reconciliation,rescue,verifiedAt') return false
  return typeof home.rescue === 'string' && RESCUE_ID.test(home.rescue)
    && (home.clientId === null || typeof home.clientId === 'string')
    && verifiedAtMs(home.verifiedAt) !== null
}

const validPending = row => object(row) && RESCUE_ID.test(row.rescue) && UUID.test(row.clientId) && time(row.since) && time(row.verifiedAt)

/**
 * Record that her home is pending (plan 3.4, O11), inside the import's own transaction. Sets
 * `world:v1:home-pending` `{rescue, clientId, since, verifiedAt}` when the rescue names a browser
 * (a UUID clientId) AND (its base is behind the fence OR it carries a reconciliation mark). A null
 * or malformed clientId records NOTHING, ever. Once set, the pointer only moves FORWARD: to a rescue
 * of the SAME browser with a later verifiedAt (`since` stays when it first became pending). Nothing
 * here refuses anything: wave 3 records only.
 * @param {object} tx The import's open transaction.
 * @param {object} home `{rescue, clientId, base, reconciliation, verifiedAt}` from the Worker.
 * @param {{lineageId: string, revision: number}} fence The global fence read in this transaction.
 * @param {number} now The edge clock.
 * @returns {Promise<{recorded: boolean, reason: string}>}
 */
export async function recordHomePending(tx, home, fence, now) {
  if (!validHomeInput(home) || !time(now)) return { recorded: false, reason: 'invalid' }
  const clientId = clientIdOf(home.clientId)
  if (clientId === null) return { recorded: false, reason: 'no-client' }
  if (!homeBaseBehind(home.base, fence) && (home.reconciliation === null || home.reconciliation === undefined)) return { recorded: false, reason: 'in-step' }
  const verifiedAt = verifiedAtMs(home.verifiedAt)
  const current = await tx.get(WORLD_HOME_PENDING)
  if (current !== undefined) {
    // A row this code cannot read is never replaced blind.
    if (!validPending(current)) return { recorded: false, reason: 'unreadable' }
    if (current.clientId !== clientId) return { recorded: false, reason: 'other-client' }
    if (current.rescue === home.rescue || verifiedAt <= current.verifiedAt) return { recorded: false, reason: 'not-newer' }
    await tx.put(WORLD_HOME_PENDING, { rescue: home.rescue, clientId, since: current.since, verifiedAt })
    return { recorded: true, reason: 'moved' }
  }
  await tx.put(WORLD_HOME_PENDING, { rescue: home.rescue, clientId, since: now, verifiedAt })
  return { recorded: true, reason: 'set' }
}

/** The pending home as the index and the status show it: `{pending, rescue, freeze}`, no browser id. */
export async function homeSummary(tx, freeze) {
  const row = await tx.get(WORLD_HOME_PENDING)
  const mode = freeze === 'enforce' ? 'enforce' : 'record'
  const held = await holderSummary(tx) // HOME hook: no read unless the lease row read before it is marked; `holder` only with a body
  const holder = held ? { holder: held } : {} // HOME hook
  if (row === undefined) return { pending: false, rescue: null, freeze: mode, ...holder } // HOME hook: `...holder`
  return { pending: true, rescue: validPending(row) ? row.rescue : null, freeze: mode, ...holder } // HOME hook: `...holder`
}

/**
 * The thread index's view of her world: `{lease, home, threads, tailBytes, retired}`. `lease` is the caller's
 * `leaseSummary` (no leaseId, ever); `retired` counts slot tombstones (bounded listing). Read
 * only by `/_thread/index` (mirror-do.mjs), never by the status her app polls.
 */
export async function worldStatus(tx, { lease = null, freeze } = {}) {
  const counts = await tx.get(THREAD_WORLD)
  const retired = await tx.list({ prefix: SLOT_TOMBSTONE, limit: SLOT_TOMBSTONE_LIMITS.count + 1 })
  return {
    lease,
    home: await homeSummary(tx, freeze),
    threads: object(counts) && time(counts.threads) ? counts.threads : 0,
    tailBytes: object(counts) && time(counts.tailBytes) ? counts.tailBytes : 0,
    retired: retired.size,
  }
}
