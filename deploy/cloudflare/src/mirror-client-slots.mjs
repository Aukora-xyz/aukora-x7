/**
 * Browser slots that can be recycled, as TOMBSTONES.
 * The 256-client cap stays; a full table frees one long-idle place in the count instead of
 * refusing the new browser for good. The retired browser keeps a tombstone (mirror-slot-tombstone.mjs)
 * with its last acknowledged sequence, digest and base, so when it returns it is named, never
 * silently accepted and never confused with another browser. Only `mirror:v2:head:` and
 * `mirror:v2:receipt:` rows of the retired id are removed: never a file, a journal or a conflict.
 */
import { MIRROR_REPLAY_LIMITS } from './mirror-replay.mjs'
import { SLOT_TOMBSTONE, SLOT_TOMBSTONE_LIMITS, TOMBSTONE_UNAVAILABLE, readTombstone, retiredReply } from './mirror-slot-tombstone.mjs'
import { leaseHolderClientId, seenTimes } from './world-lease.mjs'
import { holderSparedIds } from './world-holder.mjs' // HOME hook: her body's slot is never retired

const RECEIPT = 'mirror:v2:receipt:'
const HEAD = 'mirror:v2:head:'
const CONFLICT = 'mirror:v2:conflict:'
// mirror-do.mjs keeps at most 128 conflicts and never deletes one; a listing this long or longer is not trusted.
const CONFLICT_READ = 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DAY_MS = 86400000

/**
 * Retiring a slot at the 256-browser bound is OFF unless the deployment sets
 * `MIRROR_SLOT_RETIRE=retire`. Off (the default), a new browser at a full table gets main's 507 MIRROR_CLIENT_LIMIT,
 * nothing is retired, no tombstone is written or read, and no active browser can meet a fence conflict caused by one.
 */
export const slotRetireMode = env => (env?.MIRROR_SLOT_RETIRE === 'retire' ? 'retire' : 'off')

/** A slot is idle when the edge has neither acknowledged a save from it nor seen it at work for longer than this. */
export const MIRROR_SLOT_IDLE_MS = 30 * DAY_MS

/**
 * The fixed client id of HEAD's cloud wake checkpoint (mirror-do.mjs appendMirrorWakeCheckpoint).
 * One place: mirror-do.mjs should import it (MOUNT request). Its slot is NEVER retired: a retired
 * wake id would either fail every wake checkpoint (full table) or come back under a tombstone.
 */
export const MIRROR_WAKE_CLIENT_ID = '5e000004-0000-4000-8000-000000000004'

/**
 * Plan the retirement of one idle browser slot when a NEW browser meets a full table. Pure.
 * Idle: newest acknowledged save AND last time the edge saw it at work (`seen`, edge clock) both
 * older than `idleMs`. Never chosen: the cloud wake client, a browser with a kept conflict, the
 * lease holder, the writer of the newest receipt, an id that already has a tombstone.
 * Preferred among idle slots (a preference, NOT a proof: the edge cannot see unsent saves): one
 * not seen at work after its last acknowledged save; then the oldest first.
 * With the rows the edge keeps today, the only sequences it sees past an acknowledgement are in
 * kept conflicts, and those browsers are never chosen at all.
 * @param {object} replayState What `readMirrorReplayState` returned in this transaction.
 * @param {object} options `incomingClientId`; `conflictClientIds`; `leaseClientId`; `seen`
 *   (`{clientId: time}`); `tombstonedClientIds` (ids with a row under SLOT_TOMBSTONE);
 *   `tombstoneCount` (rows under SLOT_TOMBSTONE); `now`; `idleMs`; `clients`.
 * @returns {{retired: string, deleteKeys: string[], tombstoneKey: string, tombstone: object}|null}
 *   null when no slot may be freed (then the caller keeps today's 507 MIRROR_CLIENT_LIMIT).
 */
export function planClientSlotRetire(replayState, { incomingClientId, conflictClientIds = [], leaseClientId = null, seen = {}, tombstonedClientIds = [], tombstoneCount = 0, now, idleMs = MIRROR_SLOT_IDLE_MS, clients = MIRROR_REPLAY_LIMITS.clients } = {}) {
  if (!replayState?.clients || !replayState.receipts || !Array.isArray(replayState.ordered)) return null
  if (typeof incomingClientId !== 'string' || !UUID.test(incomingClientId) || !Number.isSafeInteger(now) || !Number.isSafeInteger(idleMs) || idleMs < 0) return null
  if (!Number.isSafeInteger(tombstoneCount) || tombstoneCount < 0 || tombstoneCount >= SLOT_TOMBSTONE_LIMITS.count) return null
  if (replayState.clients.has(incomingClientId) || replayState.clients.size < clients) return null
  const kept = new Set(conflictClientIds)
  const tombstoned = new Set(tombstonedClientIds)
  const newestOfAll = replayState.ordered.at(-1)?.[1]?.clientId ?? null
  const newest = new Map()
  for (const [, receipt] of replayState.ordered) newest.set(receipt.clientId, receipt)
  const seenAt = clientId => (seen && Number.isSafeInteger(seen[clientId]) ? seen[clientId] : null)
  let chosen = null
  for (const clientId of replayState.clients.keys()) {
    const receipt = newest.get(clientId)
    if (!receipt || !UUID.test(clientId) || clientId === MIRROR_WAKE_CLIENT_ID || kept.has(clientId) || tombstoned.has(clientId) || clientId === leaseClientId || clientId === newestOfAll) continue
    if (!Number.isSafeInteger(receipt.acknowledgedAt) || now - receipt.acknowledgedAt <= idleMs) continue
    // Seen at work within the idle window (a lease acquire, renew or write): not idle, whatever its last acknowledgement.
    if (seenAt(clientId) !== null && now - seenAt(clientId) <= idleMs) continue
    const tier = seenAt(clientId) !== null && seenAt(clientId) > receipt.acknowledgedAt ? 1 : 0
    const better = !chosen || tier < chosen.tier || (tier === chosen.tier && (receipt.acknowledgedAt < chosen.at || (receipt.acknowledgedAt === chosen.at && clientId < chosen.clientId)))
    if (better) chosen = { clientId, at: receipt.acknowledgedAt, tier }
  }
  if (!chosen) return null
  const deleteKeys = [HEAD + chosen.clientId]
  for (const [key, receipt] of replayState.receipts) {
    if (receipt?.clientId === chosen.clientId && key === RECEIPT + receipt.id) deleteKeys.push(key)
  }
  const head = replayState.clients.get(chosen.clientId)
  const last = newest.get(chosen.clientId)
  const tombstone = {
    v: 1, clientId: chosen.clientId, state: 'retired', reason: 'idle', retiredAt: now,
    lastSeenAt: Math.max(last.acknowledgedAt, seenAt(chosen.clientId) ?? 0),
    seq: head.seq, digest: head.digest, base: { lineageId: last.lineageId, revision: last.revision }, resurrectedAt: null,
  }
  return { retired: chosen.clientId, deleteKeys, tombstoneKey: SLOT_TOMBSTONE + chosen.clientId, tombstone }
}

/**
 * Retire one idle slot inside the caller's OPEN publication transaction: read what the plan needs,
 * write the tombstone, then remove that id's head and receipts. Returns null (nothing written) when
 * no slot may be freed: the caller keeps today's 507 MIRROR_CLIENT_LIMIT.
 * @param {object} tx The publication transaction.
 * @param {object} replayState What `readMirrorReplayState` returned in this transaction.
 * @param {{ incomingClientId: string, now: number, idleMs?: number }} options
 * @returns {Promise<{retired: string, tombstone: object}|null>}
 */
export async function retireClientSlot(tx, replayState, { incomingClientId, now, idleMs = MIRROR_SLOT_IDLE_MS } = {}) {
  if (await readTombstone(tx, incomingClientId)) return null
  const conflicts = await tx.list({ prefix: CONFLICT, limit: CONFLICT_READ })
  if (conflicts.size >= CONFLICT_READ) return null
  const lease = await leaseHolderClientId(tx)
  if (lease.corrupt) return null
  // HOME hook: with a holder row (the lease row is marked), her body and a reserved move's target are spared like
  // a browser with a kept conflict; an unreadable holder row retires nothing. Unmarked: nothing more is read.
  const spared = lease.marked ? await holderSparedIds(tx) : [] // HOME hook
  if (spared === null) return null // HOME hook
  // Below the bound this listing is complete, so every tombstoned id is skipped and the next idle slot is chosen.
  const tombstones = await tx.list({ prefix: SLOT_TOMBSTONE, limit: SLOT_TOMBSTONE_LIMITS.count + 1 })
  const plan = planClientSlotRetire(replayState, {
    incomingClientId, now, idleMs, leaseClientId: lease.clientId, seen: await seenTimes(tx), tombstoneCount: tombstones.size,
    tombstonedClientIds: [...tombstones.keys()].map(key => key.slice(SLOT_TOMBSTONE.length)),
    conflictClientIds: [...[...conflicts.values()].map(row => row?.clientId), ...spared], // HOME hook: `...spared`
  })
  // Never overwrite a tombstone (unreachable with the complete listing above; kept as a guard).
  if (!plan || await tx.get(plan.tombstoneKey) !== undefined) return null
  await tx.put(plan.tombstoneKey, plan.tombstone)
  for (const key of plan.deleteKeys) await tx.delete(key)
  return { retired: plan.retired, tombstone: plan.tombstone }
}

/**
 * The answer to a home save from a browser the edge does not count, BEFORE any row is written:
 * a tombstoned id gets the named 409 CLIENT_SLOT_RETIRED (whatever its sequence, 1 included); an
 * unknown id past its first sequence (one the owner forgot, or never seen) gets 410
 * MIRROR_CLIENT_UNKNOWN, but only under WRITER_LEASE=enforce and only when its base is of the
 * current lineage (in the default mode, and for a base of another lineage, publishMirror's
 * own fence and sequence checks answer and keep the conflict, exactly as main did; today's browser
 * reads a 410 as "try again" and would re-post the batch for ever). Null when publishMirror should judge.
 * @param {object} tx The publication transaction.
 * @param {object} replayState What `readMirrorReplayState` returned in this transaction.
 * @param {object} batch The home save's batch.
 * @param {{ mode?: string, fence?: {lineageId: string}|null }} [options] `mode` from `leaseMode`; `fence` the global
 *   fence read in this transaction.
 * @returns {Promise<object|null>}
 */
export async function retiredClientAnswer(tx, replayState, batch, { mode, fence = null } = {}) {
  if (!replayState?.clients || !batch || typeof batch.clientId !== 'string' || !Number.isSafeInteger(batch.seq)) return null
  const slot = await readTombstone(tx, batch.clientId)
  if (slot?.corrupt) return { ...TOMBSTONE_UNAVAILABLE }
  if (slot) return retiredReply(slot, 'delta')
  if (replayState.clients.has(batch.clientId) || batch.seq <= 1) return null
  if (mode !== 'enforce' || typeof fence?.lineageId !== 'string' || batch.cloudBase?.lineageId !== fence.lineageId) return null
  return { ok: false, code: 'MIRROR_CLIENT_UNKNOWN', status: 410 }
}

/** The tombstones, oldest first, for the owner's card: which may be forgotten, and from when. */
export async function retiredSlots(tx, now) {
  const rows = await tx.list({ prefix: SLOT_TOMBSTONE, limit: SLOT_TOMBSTONE_LIMITS.count + 1 })
  return [...rows.values()].filter(row => row && typeof row.clientId === 'string' && Number.isSafeInteger(row.retiredAt))
    .sort((a, b) => a.retiredAt - b.retiredAt || (a.clientId < b.clientId ? -1 : 1))
    .map(row => ({ clientId: row.clientId, state: row.state, retiredAt: row.retiredAt, lastSeenAt: row.lastSeenAt, forgettable: now - row.retiredAt >= SLOT_TOMBSTONE_LIMITS.graceMs }))
}
