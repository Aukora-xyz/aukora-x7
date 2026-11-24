/** Bounded protocol ACK retention. Never deletes user journals or content records. */
import { BOOTSTRAP_LIMITS } from './head-do.mjs'
const RECEIPT = 'mirror:v2:receipt:'
const HEAD = 'mirror:v2:head:'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const PROTOCOL = 'x61-cloud-mirror/v1'
const corrupt = () => { throw Object.assign(new Error('MIRROR_REPLAY_METADATA_CORRUPT'), { code: 'MIRROR_REPLAY_METADATA_CORRUPT', status: 503 }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = value => Number.isSafeInteger(value) && value > 0

/** Fixed protocol bounds, including the overflow sentinel used by inventory reads. */
export const MIRROR_REPLAY_LIMITS = Object.freeze({ perClient: 64, receipts: 4096, clients: 256 })

/**
 * Read and validate committed ACKs and permanent client sequence fences in one transaction.
 * Existing fenced records need no rewrite. Missing, unfenced, incomplete or inconsistent
 * metadata stops publication; it is never guessed, evicted or silently migrated.
 * @param {object} tx The publication transaction, with get/list/put/delete operations.
 * @param {object} fence The validated current global lineage and revision.
 * @returns {Promise<object>} Validated receipt and client maps, with receipts ordered by revision.
 */
export async function readMirrorReplayState(tx, fence) {
  if (!object(fence) || !UUID.test(fence.lineageId) || !Number.isSafeInteger(fence.revision) || fence.revision < 0) corrupt()
  const receipts = await tx.list({ prefix: RECEIPT, limit: MIRROR_REPLAY_LIMITS.receipts + 1 })
  const heads = await tx.list({ prefix: HEAD, limit: MIRROR_REPLAY_LIMITS.clients + 1 })
  if (receipts.size > MIRROR_REPLAY_LIMITS.receipts || heads.size > MIRROR_REPLAY_LIMITS.clients) corrupt()
  const clients = new Map()
  for (const [key, head] of heads) {
    const clientId = key.slice(HEAD.length)
    if (!key.startsWith(HEAD) || !UUID.test(clientId) || !object(head) || !positive(head.seq) || typeof head.digest !== 'string' || !HASH.test(head.digest)) corrupt()
    clients.set(clientId, head)
  }
  const ordered = []
  const revisions = new Set()
  for (const [key, receipt] of receipts) {
    if (!object(receipt) || receipt.ok !== true || receipt.protocol !== PROTOCOL || !UUID.test(receipt.clientId) || !positive(receipt.seq) || receipt.id !== `${receipt.clientId}:${receipt.seq}` || key !== RECEIPT + receipt.id || typeof receipt.digest !== 'string' || !HASH.test(receipt.digest) || receipt.lineageId !== fence.lineageId || !positive(receipt.revision) || receipt.revision > fence.revision || revisions.has(receipt.revision) || !positive(receipt.applied) || receipt.applied > 10000 || !Number.isSafeInteger(receipt.acknowledgedAt) || receipt.acknowledgedAt < 0) corrupt()
    const head = clients.get(receipt.clientId)
    if (!head || receipt.seq > receipt.revision || receipt.seq > head.seq || (receipt.seq === head.seq && receipt.digest !== head.digest)) corrupt()
    revisions.add(receipt.revision)
    ordered.push([key, receipt])
  }
  ordered.sort((a, b) => a[1].revision - b[1].revision)
  // Only an empty namespace or a committed bootstrap may precede the first ACK.
  if (ordered.length ? ordered.at(-1)[1].revision !== fence.revision : fence.revision > 1) corrupt()
  if (!ordered.length && fence.revision === 1) {
    const bootstrap = await tx.get('mirror:bootstrap:v1')
    if (!object(bootstrap) || bootstrap.phase !== 'ready' || bootstrap.lineageId !== fence.lineageId || bootstrap.revision !== 1 || !HASH.test(bootstrap.seedId) || !HASH.test(bootstrap.ballId) || !positive(bootstrap.epoch) || !Array.isArray(bootstrap.batchDigests) || bootstrap.batchDigests.length > BOOTSTRAP_LIMITS.batches || bootstrap.batchDigests.some(hash => typeof hash !== 'string' || !HASH.test(hash)) || bootstrap.nextBatch !== bootstrap.batchDigests.length || !Number.isSafeInteger(bootstrap.entryCount) || bootstrap.entryCount < 0 || bootstrap.entryCount > BOOTSTRAP_LIMITS.entries || bootstrap.entryCount !== bootstrap.expectedEntries || (bootstrap.entryCount === 0) !== (bootstrap.batchDigests.length === 0)) corrupt()
  }
  const latest = new Map()
  for (const [, receipt] of ordered) {
    if ((latest.get(receipt.clientId)?.seq ?? 0) >= receipt.seq) corrupt()
    latest.set(receipt.clientId, receipt)
  }
  for (const [clientId, head] of clients) {
    if (latest.get(clientId)?.seq !== head.seq) corrupt()
  }
  return { receipts, clients, ordered }
}

/**
 * Plan only ACK-key deletions, reserving one slot for the next publication. Latest ACKs
 * for other clients remain protected. The publishing client's new ACK replaces its latest.
 * Caller must apply these deletions and all publication writes in the SAME transaction,
 * propagating every failure so storage rolls back. Caller first verifies the next sequence.
 * @param {object} state Validated result from readMirrorReplayState in this transaction.
 * @param {string} clientId Client publishing its next sequence.
 * @returns {string[]} Oldest-revision-first keys to delete before committing the new ACK.
 */
export function planMirrorReplayPrune(state, clientId) {
  const counts = new Map([[clientId, 1]])
  for (const [, receipt] of state.ordered) counts.set(receipt.clientId, (counts.get(receipt.clientId) ?? 0) + 1)
  const remove = new Set()
  const eligible = ([, receipt]) => receipt.clientId === clientId || receipt.seq !== state.clients.get(receipt.clientId).seq
  for (const [key, receipt] of state.ordered) {
    if (counts.get(receipt.clientId) > MIRROR_REPLAY_LIMITS.perClient && eligible([key, receipt])) {
      remove.add(key)
      counts.set(receipt.clientId, counts.get(receipt.clientId) - 1)
    }
  }
  let total = state.receipts.size + 1 - remove.size
  for (const item of state.ordered) {
    if (total <= MIRROR_REPLAY_LIMITS.receipts) break
    if (!remove.has(item[0]) && eligible(item)) { remove.add(item[0]); total -= 1 }
  }
  if (total > MIRROR_REPLAY_LIMITS.receipts) corrupt()
  return state.ordered.filter(([key]) => remove.has(key)).map(([key]) => key)
}
