/**
 * Aukora: Durable IndexedDB + Ordered Local Mirror for `/dsh/home` and `/dsh/workspace`.
 *
 * Hydration seeds persisted entries over the base VFS image before the Cordis tree boots;
 * afterwards committed VFS mutations are written to IndexedDB (200ms debounce) and pushed
 * through the acknowledged `/_mirror/delta` outbox. `/api/snapshot` is hydration-only.
 * Local saves and delivery acknowledgements are distinct; no cloud backup is implied.
 */
import type { MemoryVfs } from './memory.ts'
import type { VfsMutation } from './types.ts'
import { sha256HexSync } from '../module-system/module-loader.ts'

export const DB_NAME = 'aukora-x6-vfs'
export const STORE = 'entries'
const DEBOUNCE_MS = 200
// Fixed duplicate-payload admission bounds for this writer, not browser quota estimates.
const MAX_PENDING_BATCHES = 256
// One batch must hold the largest cloud request (a 24 MiB file is 32 MiB of base64 plus its envelope).
const MAX_PENDING_BYTES = 40 * 1024 * 1024
const MAX_BATCH_ENTRIES = 50000 // Local ordered mirror protocol's entry limit.
const CLOUD_PROTOCOL = 'x61-cloud-mirror/v1'
/**
 * The cloud mirror's admission limits, mirrored from deploy/cloudflare/src/mirror-do.mjs `MIRROR_LIMITS`
 * (requestBytes, batchEntries, fileBytes, snapshotBytes). A file at the 24 MiB ceiling is 32 MiB once
 * base64-encoded, so the request ceiling is 34 MiB; tests/x6/mirror-limits.spec.ts pins the parity.
 */
export const CLOUD_MIRROR_LIMITS = Object.freeze({
  requestBytes: 34 * 1024 * 1024,
  entries: 10000,
  fileBytes: 24 * 1024 * 1024,
  snapshotBytes: 96 * 1024 * 1024,
})
const CLOUD_MAX_BODY = CLOUD_MIRROR_LIMITS.requestBytes
const CLOUD_MAX_ENTRIES = CLOUD_MIRROR_LIMITS.entries
const CLOUD_MAX_FILE = CLOUD_MIRROR_LIMITS.fileBytes
const MAX_SNAPSHOT_RESPONSE_BYTES = CLOUD_MIRROR_LIMITS.snapshotBytes
const SNAPSHOT_ROOT = '/dsh/home/auma/snapshots'
/**
 * Redundant VFS dumps under the snapshot root, which the cloud mirror refuses (mirror-do.mjs
 * `mirrorPathExcluded`). The directory and LATEST.json stay. Only the cloud outbox drops them: SKIP_REMOTE
 * also guards private identity during hydration, where a reset over a dump must not read as a secret.
 */
export const snapshotDumpExcluded = (path: string): boolean => path.startsWith(`${SNAPSHOT_ROOT}/`) && path !== `${SNAPSHOT_ROOT}/LATEST.json`
/**
 * Local conflict backups: any path with a `.conflict-backup` segment (the journal supersede writes them under
 * JOURNAL_BACKUP_ROOT). They stay in this tab and on the Mac host; the cloud outbox drops them silently, as it does
 * snapshot dumps, so they never bloat or fail a cloud mirror delta.
 */
export const conflictBackupExcluded = (path: string): boolean => path.split('/').includes('.conflict-backup')
/** Every path the cloud outbox drops without sending: snapshot dumps and conflict backups. */
export const cloudOutboxExcluded = (path: string): boolean => snapshotDumpExcluded(path) || conflictBackupExcluded(path)
/**
 * HER SESSION JOURNALS TRAVEL IN THEIR OWN LANE (Round 20). Her live chat journal
 * (`/dsh/home/sessions/<project>/<id>/session.v4.jsonl`) is 20 MB, 27 MB of base64, and it rode inside every save: each
 * turn re-sent all of it, and a slow upload held her seed and balls behind it. Past 2 MiB a save now only marks it
 * waiting. It goes out on its own, as its newest stored bytes, once every other queued save is delivered, at most once
 * per interval (a minute on the cloud). When the cloud does not take it (408, its upload limit; 413, a size it refuses)
 * and its fence still stands exactly where the journal expected (so nothing applied it, now or in an attempt whose
 * answer was lost), it steps out of the queue so the saves behind it still go, and it is tried again later.
 */
export const SESSION_JOURNAL_POLICY = Object.freeze({
  minBytes: 2 * 1024 * 1024, localIntervalMs: 5_000, cloudIntervalMs: 60_000, retryMs: 120_000, maxRetryMs: 1_800_000,
})
const SESSION_JOURNAL = /^\/dsh\/home\/(?:sessions\/[^/]+\/[^/]+\/session\.v\d+\.jsonl|[^/]+\/session\/messages\.jsonl)$/
/** A session journal big enough to travel in its own lane instead of inside every save. */
export const deferredJournal = (path: string, fileBytes: number | null): boolean =>
  fileBytes !== null && fileBytes > SESSION_JOURNAL_POLICY.minBytes && SESSION_JOURNAL.test(path)
/** Whether one outbox entry carries a session journal past the lane threshold (its decoded size, from the base64). */
const carriesJournal = ([path, wire]: readonly [string, WireEntry]): boolean => wire.kind === 'file'
  && deferredJournal(path, Math.floor((wire.b64.length * 3) / 4) - (wire.b64.endsWith('==') ? 2 : wire.b64.endsWith('=') ? 1 : 0))
/** Wait before a journal the cloud provably did not take is tried again: doubling, capped; a size refusal waits longest. */
export const journalRetryMs = (failures: number, refusedSize: boolean): number => refusedSize
  ? SESSION_JOURNAL_POLICY.maxRetryMs
  : Math.min(SESSION_JOURNAL_POLICY.maxRetryMs, SESSION_JOURNAL_POLICY.retryMs * 2 ** Math.max(0, Math.min(failures - 1, 20)))
/** Answers that say this delivery was not applied: the cloud stopped reading the body (408) or refused its size (413). */
export const deliveryNeverApplied = (status: number): boolean => status === 408 || status === 413
const MAX_ACK_RESPONSE_BYTES = 64 * 1024
type CapacityRefusal = 'queue-full' | 'batch-too-large'
/** A cloud save held back for a reason with a cause (Round 19): transient and capacity holds are re-sent automatically. */
class CloudHold extends Error {
  constructor(readonly hold: ReconciliationCause, detail: string) { super(detail) }
}
class MirrorCapacityError extends Error {
  constructor(readonly refusal: CapacityRefusal, detail: string) {
    super(`${refusal === 'queue-full' ? 'MIRROR_QUEUE_FULL' : 'MIRROR_BATCH_TOO_LARGE'}: ${detail}. New changes remain unsaved in this open tab; keep it open and preserve them before leaving.`)
  }
}
const recordBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
const BATCH_PREFIX = '@x6-mirror-batch:'
const META_KEY = '@x6-mirror-meta'
const CONTENT_KEY = '@x6-content-revision'
const RECONCILE_KEY = '@x6-cloud-reconciliation'
/**
 * Why local content is not in the cloud yet: `transient` (the cloud did not answer), `capacity` (the outbox was full) or
 * `genuine` (divergence, a cleared root, a corrupt sequence, a seed file the cloud cannot hold). A record without a
 * cause predates Round 19 and counts as genuine. The cause decides what the page SAYS (resync pending vs reconciliation
 * required). Any hold, whatever its cause, is re-sent automatically only when the cloud fence equals this browser's
 * last acknowledged base with nothing queued; planCloudResync refuses root clears and seed files the cloud cannot hold,
 * and a moved fence fails closed.
 */
export type ReconciliationCause = 'transient' | 'capacity' | 'genuine'
interface CloudReconciliation {
  kind: 'cloud-reconciliation'
  firstRevision: number
  lastRevision: number
  scope: 'all-persisted-mirror-content'
  cause?: ReconciliationCause
}
const CAUSE_RANK: Record<ReconciliationCause, number> = { transient: 0, capacity: 1, genuine: 2 }
/** The stronger of two causes: genuine outranks capacity, which outranks transient; a legacy record is genuine. */
export const mergeCause = (previous: ReconciliationCause | undefined | null, next: ReconciliationCause): ReconciliationCause =>
  previous === undefined ? 'genuine' : previous === null || CAUSE_RANK[next] > CAUSE_RANK[previous] ? next : previous
interface ContentRevision { kind: 'content-revision'; seq: number }
const validRevision = (value: unknown): value is ContentRevision => isRecord(value) && value.kind === 'content-revision' && typeof value.seq === 'number' && Number.isSafeInteger(value.seq) && value.seq >= 0
const RESET_PREFIX = '@x6-vfs-reset:'
const batchRange = (): IDBKeyRange => IDBKeyRange.bound(BATCH_PREFIX, BATCH_PREFIX + '\uffff')
/** One waiting session journal: its path, the earliest time it may go, and how often the cloud has not taken it. */
const JOURNAL_PREFIX = '@x6-deferred-journal:'
interface DeferredJournalMarker { kind: 'deferred-journal'; path: string; notBefore: number; failures: number }
const journalRange = (): IDBKeyRange => IDBKeyRange.bound(JOURNAL_PREFIX, JOURNAL_PREFIX + '\uffff')
/** The paths of the waiting-journal rows among a store's keys. */
const journalPaths = (keys: readonly IDBValidKey[]): string[] =>
  keys.filter((key): key is string => typeof key === 'string' && key.startsWith(JOURNAL_PREFIX)).map(key => key.slice(JOURNAL_PREFIX.length))
export interface MirrorBatch {
  kind: 'mirror-batch'
  batch: { clientId: string; seq: number; id: string; entries: Array<[string, WireEntry]>; cloudBase?: CloudBase }
  digest: string
  /** A session journal in its own lane: never merged into, and moved aside when the cloud's fence shows it was not applied. */
  deferred?: true
  /** How often the cloud had already not taken this journal, so its wait keeps growing across new saves of it. */
  failures?: number
}
export interface CloudBase { lineageId: string; revision: number }
export interface MirrorMeta { kind: 'mirror-meta'; clientId: string; seq: number; cloudBase?: CloudBase; cloudAcknowledgedSeq?: number }
const validCloudBase = (value: unknown): value is CloudBase => isRecord(value) && typeof value.lineageId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.lineageId) && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0
const sameCloudBase = (left: CloudBase, right: CloudBase): boolean => left.lineageId === right.lineageId && left.revision === right.revision

// Only immutable, contiguous queued revisions extend the acknowledged base.
function projectedCloudBase(meta: MirrorMeta, queued: readonly MirrorBatch[]): CloudBase {
  if (!validCloudBase(meta.cloudBase)) throw new Error('MIRROR_GLOBAL_FENCE_REQUIRED: durable cloud base missing; explicit reconciliation required')
  if (meta.kind !== 'mirror-meta' || !Number.isSafeInteger(meta.seq) || typeof meta.cloudAcknowledgedSeq !== 'number' || !Number.isSafeInteger(meta.cloudAcknowledgedSeq) || meta.cloudAcknowledgedSeq < 0 || meta.cloudAcknowledgedSeq > meta.seq || meta.seq - meta.cloudAcknowledgedSeq !== queued.length) throw new Error('MIRROR_GLOBAL_FENCE_CONFLICT: corrupt cloud sequence metadata')
  let base = { ...meta.cloudBase }
  let sequence = meta.cloudAcknowledgedSeq
  for (const record of queued) {
    sequence += 1
    if (record.kind !== 'mirror-batch' || !record.batch || record.batch.clientId !== meta.clientId || record.batch.seq !== sequence || record.batch.id !== `${meta.clientId}:${String(sequence)}` || !validCloudBase(record.batch.cloudBase) || !sameCloudBase(base, record.batch.cloudBase) || record.digest !== sha256HexSync(JSON.stringify(record.batch))) throw new Error('MIRROR_GLOBAL_FENCE_CONFLICT: ambiguous queued cloud revisions retained for reconciliation')
    if (base.revision === Number.MAX_SAFE_INTEGER) throw new Error('Cloud revision exhausted')
    base = { ...base, revision: base.revision + 1 }
  }
  return base
}
const overlaps = (left: string, right: string): boolean => left === right || left.startsWith(right + '/') || right.startsWith(left + '/')

export type CloudFenceVerdict =
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'initialize' }
  | { readonly kind: 'in-step' }
  | { readonly kind: 'replay-pending'; readonly applied: number }
  | { readonly kind: 'diverged'; readonly reason: string }

/**
 * Where this browser stands against the cloud fence (Round 19, cloud audit A6/A7/A27). Only `diverged` is a conflict.
 * `replay-pending` is a reload or close mid-save: the cloud already holds some of this browser's own queued batches
 * whose acknowledgements were never recorded. Each queued batch is re-sent in order; the cloud answers its own
 * receipt for those (replayed) and fences any other, so a different writer still surfaces as a conflict.
 */
export function classifyCloudFence(
  hasDurableHistory: boolean, meta: MirrorMeta | undefined, queued: readonly MirrorBatch[], cloud: CloudBase | null,
): CloudFenceVerdict {
  if (cloud === null) return { kind: 'unreachable' }
  if (!hasDurableHistory) return { kind: 'initialize' }
  if (!meta || !validCloudBase(meta.cloudBase)) {
    return { kind: 'diverged', reason: 'MIRROR_GLOBAL_FENCE_REQUIRED: existing data has no cloud base; explicit reconciliation required' }
  }
  let projected: CloudBase
  try { projected = projectedCloudBase(meta, queued) } catch (error) {
    return { kind: 'diverged', reason: error instanceof Error ? error.message : String(error) }
  }
  const base = meta.cloudBase
  const moved = 'MIRROR_GLOBAL_FENCE_CONFLICT: cloud changed since this browser last saved; queued work retained for explicit reconciliation'
  if (cloud.lineageId !== base.lineageId) return { kind: 'diverged', reason: moved }
  if (cloud.revision === base.revision) return { kind: 'in-step' }
  if (cloud.revision > base.revision && cloud.revision <= projected.revision) return { kind: 'replay-pending', applied: cloud.revision - base.revision }
  return { kind: 'diverged', reason: moved }
}

/** Her seed (receipts, checkpoints, organs, pearl): a change there that cannot reach the cloud fails closed. */
const CRITICAL_ROOT = '/dsh/home/auma/seed'
export const criticalCloudPath = (path: string): boolean => path === CRITICAL_ROOT || path.startsWith(CRITICAL_ROOT + '/')
export type CloudAdmission = 'send' | 'quarantine' | 'genuine'
/**
 * Whether one outbox entry can go to the cloud (Round 19, cloud audit A29). A name the cloud refuses, or a file over
 * its per-file limit, is set aside and reported instead of locking the browser; the same failure under her seed fails
 * closed, because silently leaving a receipt or organ behind would fork her chain.
 */
export function cloudAdmission(path: string, fileBytes: number | null): CloudAdmission {
  const fits = fileBytes === null || fileBytes <= CLOUD_MAX_FILE
  if (cloudPathAllowed(path) && fits) return 'send'
  return criticalCloudPath(path) ? 'genuine' : 'quarantine'
}

export interface CloudResyncPlan {
  readonly batches: readonly Array<[string, WireEntry]>[]
  readonly refused: string | null
  readonly quarantined: readonly string[]
  /** Session journals that differ from the cloud: not in these batches, they wait for their own lane. */
  readonly deferred: readonly string[]
}
const sameEntry = (left: Entry, right: Entry): boolean => left.kind === right.kind && (
  left.kind === 'gone'
  || (left.kind === 'dir' && right.kind === 'dir' && left.mode === right.mode)
  || (left.kind === 'file' && right.kind === 'file' && left.mode === right.mode && left.bytes.byteLength === right.bytes.byteLength
    && left.bytes.every((byte, index) => byte === right.bytes[index])))
const toWire = (entry: Entry): WireEntry => entry.kind === 'file'
  ? { kind: 'file', b64: toB64(entry.bytes), mode: entry.mode, mtimeMs: entry.mtimeMs }
  : entry.kind === 'dir' ? { kind: 'dir', mode: entry.mode } : { kind: 'gone' }

/**
 * What to send so the cloud equals this browser's saved content, given that the cloud has not moved since this
 * browser's last acknowledged save (the caller checks that fence first). Only paths this browser saved are compared:
 * its stored rows, its deletions (tombstone roots) and its subtree resets; everything else is unchanged on both sides.
 * Refuses (nothing sent) a change that clears a mirror root or puts a seed file over the cloud limit. Batches respect
 * the cloud's entry and request limits; parents sort before children.
 */
export function planCloudResync(
  rows: ReadonlyMap<string, Entry>, resets: ReadonlySet<string>, cloud: ReadonlyMap<string, Entry>,
  limits: { readonly entries: number; readonly requestBytes: number } = { entries: CLOUD_MAX_ENTRIES, requestBytes: CLOUD_MAX_BODY },
): CloudResyncPlan {
  const roots = ['/dsh/home', '/dsh/workspace']
  const tombstones = [...rows].filter(([, entry]) => entry.kind === 'gone').map(([path]) => path)
  if ([...tombstones, ...resets].some(path => roots.includes(path))) {
    return { batches: [], refused: 'a mirror root was cleared in this browser', quarantined: [], deferred: [] }
  }
  const quarantined: string[] = []
  const deferred: string[] = []
  const admitted = (path: string, entry: Entry | undefined): boolean => {
    if (!outboxAdmits(path, false)) return false
    const verdict = cloudAdmission(path, entry?.kind === 'file' ? entry.bytes.byteLength : null)
    if (verdict === 'send') return true
    if (verdict === 'genuine') throw new Error(path)
    quarantined.push(path)
    return false
  }
  const wire: Array<[string, WireEntry]> = []
  const byPath = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0)
  const under = (path: string, among: Iterable<string>): boolean => [...among].some(root => path.startsWith(root + '/'))
  try {
    // A deletion removes the cloud subtree, so one per outermost deleted root; rows beneath it are stale (as at load).
    const goneSent = new Set<string>()
    for (const root of [...tombstones].sort()) {
      if (under(root, tombstones)) continue
      if (!cloud.has(root) && ![...cloud.keys()].some(path => path.startsWith(root + '/'))) continue
      if (admitted(root, undefined)) { wire.push([root, { kind: 'gone' }]); goneSent.add(root) }
    }
    // A subtree reset cleared everything beneath it; what this browser re-added is in its rows.
    for (const [path] of [...cloud].sort(byPath)) {
      if (rows.has(path) || path === '' || under(path, goneSent) || !under(path, resets)) continue
      if (admitted(path, undefined)) { wire.push([path, { kind: 'gone' }]); goneSent.add(path) }
    }
    for (const [path, entry] of [...rows].sort(byPath)) {
      if (entry.kind === 'gone' || under(path, tombstones)) continue
      const remote = cloud.get(path)
      if (remote !== undefined && sameEntry(entry, remote)) continue
      if (!admitted(path, entry)) continue
      if (entry.kind === 'file' && deferredJournal(path, entry.bytes.byteLength)) deferred.push(path)
      else wire.push([path, toWire(entry)])
    }
  } catch (error) {
    return { batches: [], refused: `a seed file cannot be sent to the cloud: ${error instanceof Error ? error.message : String(error)}`, quarantined, deferred: [] }
  }
  const batches: Array<[string, WireEntry]>[] = []
  let current: Array<[string, WireEntry]> = [], bytes = 0
  const slack = 4096
  for (const item of wire) {
    const size = recordBytes(item) + 1
    if (size + slack > limits.requestBytes) return { batches: [], refused: `${item[0]} is larger than one cloud request`, quarantined, deferred: [] }
    if (current.length && (current.length + 1 > limits.entries || bytes + size + slack > limits.requestBytes)) {
      batches.push(current); current = []; bytes = 0
    }
    current.push(item); bytes += size
  }
  if (current.length) batches.push(current)
  return { batches, refused: null, quarantined, deferred }
}

/**
 * Append-only journals. A mirror copy that extends every local copy line for line loses nothing by replacing
 * them, so unsent local saves of an older, shorter copy must not hold it back (Round 16: a tab stayed on 64
 * receipts while the mirror had 85, and its queued 64-line write would have cut the mirror back on delivery).
 */
export const APPEND_ONLY_JOURNALS: ReadonlySet<string> = new Set([
  '/dsh/home/auma/seed/receipts.v3.jsonl',
  '/dsh/home/auma/seed/checkpoints.v1.jsonl',
])
export const JOURNAL_BACKUP_ROOT = '/dsh/home/auma/seed/.conflict-backup'
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
/** True when `head` is a whole-line byte prefix of the strictly longer `whole`. */
export function extendsJournal(head: Uint8Array, whole: Uint8Array): boolean {
  if (head.byteLength >= whole.byteLength || (head.byteLength > 0 && head[head.byteLength - 1] !== 0x0a)) return false
  for (let index = 0; index < head.byteLength; index += 1) if (head[index] !== whole[index]) return false
  return true
}
export type JournalPlan = 'supersede' | 'diverged' | 'not-applicable'
/**
 * Decide whether the mirror's copy of a journal may replace the copies this tab holds back.
 * `local` is the tab's current bytes (null when it has no such file); `queued` are unsent outbox entries that
 * touch the path. Deletions, non-directory ancestors and tombstones keep today's rule (the local intent waits).
 * 'supersede' only when every local copy equals the mirror copy or is a whole-line prefix of it.
 */
export function planJournalSupersede(
  path: string, mirror: Uint8Array, local: Uint8Array | null,
  queued: readonly (readonly [string, WireEntry])[], tombstones: Iterable<string>,
): JournalPlan {
  if (!APPEND_ONLY_JOURNALS.has(path) || local === null) return 'not-applicable'
  for (const root of tombstones) if (overlaps(path, root)) return 'not-applicable'
  const copies = [local]
  for (const [queuedPath, wire] of queued) {
    if (queuedPath === path) {
      if (wire.kind !== 'file') return 'not-applicable'
      copies.push(fromB64(wire.b64))
    } else if (overlaps(queuedPath, path) && !(path.startsWith(queuedPath + '/') && wire.kind === 'dir')) return 'not-applicable'
  }
  return copies.every(copy => sameBytes(copy, mirror) || extendsJournal(copy, mirror)) ? 'supersede' : 'diverged'
}
/**
 * A queued older copy of a superseded journal would cut the mirror back on delivery, so it carries the
 * mirror's bytes instead. Seq, id, entry count and order are kept; only the digest changes. Should the host
 * already hold this seq (a lost acknowledgement), it answers MIRROR_REPLAY_CONFLICT and nothing is written.
 * Returns null when the batch touches no superseded journal.
 */
export function rewriteQueuedJournals(
  record: MirrorBatch, superseded: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly mode: number; readonly mtimeMs: number }>,
): MirrorBatch | null {
  let rewritten = false
  const entries = record.batch.entries.map(([path, wire]): [string, WireEntry] => {
    const mirror = superseded.get(path)
    if (!mirror || wire.kind !== 'file') return [path, wire]
    rewritten = true
    return [path, { kind: 'file', b64: toB64(mirror.bytes), mode: mirror.mode, mtimeMs: mirror.mtimeMs }]
  })
  if (!rewritten) return null
  const batch = { ...record.batch, entries }
  return { ...record, batch, digest: sha256HexSync(JSON.stringify(batch)) }
}
/**
 * The queue with each FILE or DIRECTORY entry for a path matching the secret-path rule turned into a `gone` for the same
 * path, or null when it holds none. The edge takes such a `gone` as an applied no-op
 * (mirror-do.mjs publishableMirrorEntries) and refuses the file or directory, so the save keeps its place: seq, id, cloud
 * base and entry count are kept, its digest is recomputed, and a save holding no such entry is returned exactly as it was
 * (same record, same digest). Nothing is renumbered and the meta is not touched. A `gone` already matching the rule is
 * left as it is (the edge answers it). Only valid while no queued save has reached the mirror and the queue as stored is
 * intact: the caller checks both first.
 */
export interface SecretScrubPlan { records: MirrorBatch[]; dropped: string[] }
export function planSecretScrub(records: readonly MirrorBatch[]): SecretScrubPlan | null {
  const dropped: string[] = []
  const shaped = ([path, wire]: readonly [string, WireEntry]): boolean => wire.kind !== 'gone' && secretShapedGone([path, { kind: 'gone' }])
  const next = records.map((record): MirrorBatch => {
    if (!record.batch.entries.some(shaped)) return record
    const entries = record.batch.entries.map((item): [string, WireEntry] => {
      if (!shaped(item)) return item
      dropped.push(item[0])
      return [item[0], { kind: 'gone' }]
    })
    const batch = { ...record.batch, entries }
    return { ...record, batch, digest: sha256HexSync(JSON.stringify(batch)) }
  })
  return dropped.length ? { records: next, dropped } : null
}
/**
 * A `gone` entry the cloud mirror takes as an applied no-op (twin of mirror-do.mjs `hiddenStoredPath`, as
 * publishableMirrorEntries applies it): a canonical path under a mirror root whose only exclusion is the secret-path rule.
 * The drain sends it unchanged: a save queued before the rule (or its lost-acknowledgement replay) is never held for it.
 */
export function secretShapedGone([path, wire]: readonly [string, WireEntry]): boolean {
  if (wire.kind !== 'gone' || !cloudPathSyntax(path) || !secretShapedPath(path)) return false
  if (path === '/dsh/home/balls' || path.startsWith('/dsh/home/balls/')) return false
  if (path.startsWith('/dsh/home/auma/snapshots/') && path !== '/dsh/home/auma/snapshots/LATEST.json') return false
  return !path.split('/').some(part => part === '.DS_Store' || part === '.conflict-backup')
}
/** A canonical VFS path under a mirror root, as the cloud mirror checks its syntax before any exclusion. */
function cloudPathSyntax(path: string): boolean {
  const size = (value: string): number => new TextEncoder().encode(value).byteLength
  if (typeof path !== 'string' || size(path) > 4096 || /[\\\0-\x1f\x7f]/.test(path)) return false
  const parts = path.split('/')
  if (parts[0] !== '' || parts.slice(1).some(part => !part || part === '.' || part === '..' || size(part) > 255)) return false
  return ['/dsh/home', '/dsh/workspace'].some(root => path.startsWith(root + '/'))
}
const mirrorAllowed = (path: string): boolean => !SKIP_REMOTE(path) && path !== '/dsh/home' && path !== '/dsh/home/balls' && !path.startsWith('/dsh/home/balls/')
/** Whether a changed path is written into an outbox batch: the Mac host takes every mirrored path; the cloud fewer. */
export const outboxAdmits = (path: string, localTransport: boolean): boolean =>
  mirrorAllowed(path) && (localTransport || !cloudOutboxExcluded(path))

// Matches the cloud mirror's canonical-path and secret-name admission rules.
export function cloudPathAllowed(path: string): boolean {
  const size = (value: string): number => new TextEncoder().encode(value).byteLength
  if (typeof path !== 'string' || size(path) > 4096 || /[\\\0-\x1f\x7f]/.test(path)) return false
  const parts = path.split('/')
  if (parts[0] !== '' || parts.slice(1).some(part => !part || part === '.' || part === '..' || size(part) > 255)) return false
  if (!['/dsh/home', '/dsh/workspace'].some(root => path.startsWith(root + '/'))) return false
  if (path === '/dsh/home/balls' || path.startsWith('/dsh/home/balls/')) return false
  // A conflict backup is never sent: one in a batch queued before the outbox dropped them stops at the drain guard.
  return !parts.some(part => secretShapedPart(part) || part === '.DS_Store' || part === '.conflict-backup')
}

/**
 * THE SECRET-PATH RULE: one rule for this browser and the cloud mirror. Twin of
 * deploy/cloudflare/src/mirror-secret-paths.mjs `MIRROR_SECRET_NAMES` / `MIRROR_SECRET_PREFIXES` / `MIRROR_SECRET_SUFFIX` /
 * `secretShapedPart` (deploy/ may not import packages/); tests/x6/mirror-secret-paths.spec.ts fails when the two differ.
 * A part matches when it is STEM, then zero or more SUFFIX segments, then an optional single trailing `~`: STEM is a
 * secret name or that name with ONE extra leading dot (`.session.cap`, `..credentials.yaml`); a SUFFIX segment is `.`,
 * `~`, `-` or `_` plus a token from a closed list (6 to 64 hex characters, digits only, or tmp, temp, lock, bak, backup,
 * old, new, next, prev, orig, swp, swo, part, partial, takeover): `.credentials.yaml.3fa9c1d2e4b5.tmp`,
 * `.credentials.yaml.lock.takeover-0123456789abcdef`, `credentials.yaml.bak~`, `.session.cap~`; or it starts with `.env`,
 * `.aukora-` or `pepper.v1.`. Nothing else (`credentials.yaml-notes.md`, `.ssh-config-docs`, `.session.capx` are ordinary).
 * Such a path is never queued, sent or served; a sibling is kept in this browser exactly as the secret it derives from
 * is (see SKIP and SKIP_REMOTE).
 */
export const MIRROR_SECRET_NAMES: readonly string[] = Object.freeze(['.credentials.yaml', 'credentials.yaml', 'session.cap', '.afferent-probe',
  'ed25519-keypair.json', '.credentials', '.ssh', '.aws', '.transport', 'pepper.v1'])
export const MIRROR_SECRET_PREFIXES: readonly string[] = Object.freeze(['.env', '.aukora-', 'pepper.v1.'])
// What may follow a stem: suffix segments, then at most one `~`. One way to match each token (digits 1 to 5 or 65 and more;
// 6 to 64 are hex) and a lone `~` cannot start a segment, so the time stays linear in the name.
export const MIRROR_SECRET_SUFFIX = new RegExp('^(?:[.~_-](?:[0-9a-fA-F]{6,64}|[0-9]{1,5}|[0-9]{65,}|'
  + 'tmp|temp|lock|bak|backup|old|new|next|prev|orig|swp|swo|part|partial|takeover))*~?$')
/** The secret name a part is, or derives from by the rule's stem, suffixes and tilde (the longest that fits), or null. Prefixes aside. */
const secretFamily = (part: string): string | null => {
  let found: string | null = null
  for (const name of MIRROR_SECRET_NAMES) {
    const fits = [name, `.${name}`].some(stem => part.startsWith(stem) && MIRROR_SECRET_SUFFIX.test(part.slice(stem.length)))
    if (fits && (found === null || name.length > found.length)) found = name
  }
  return found
}
export const secretShapedPart = (part: string): boolean =>
  MIRROR_SECRET_PREFIXES.some(prefix => part.startsWith(prefix)) || secretFamily(part) !== null
export const secretShapedPath = (path: string): boolean => path.split('/').some(secretShapedPart)


export type Entry =
  | { readonly kind: 'file'; readonly bytes: Uint8Array; readonly mode: number; readonly mtimeMs: number }
  | { readonly kind: 'dir'; readonly mode: number }
  | { readonly kind: 'gone' }

export type WireEntry =
  | { readonly kind: 'file'; readonly b64: string; readonly mode: number; readonly mtimeMs: number }
  | { readonly kind: 'dir'; readonly mode: number }
  | { readonly kind: 'gone' }

export const persistence = {
  readOnly: false,
  durable: false,
  conflict: null as string | null,
  flush: async (): Promise<void> => { throw new Error('Persistence is not initialized') },
  upload: async (): Promise<void> => { throw new Error('Persistence is not initialized') },
  sync: async (): Promise<void> => { throw new Error('Persistence is not initialized') },
  /**
   * Re-check the cloud fence now and send any held-back saves, only while the cloud has not moved since this browser's
   * last acknowledged save; anything else fails closed. Resolves to what happened, in one word.
   */
  retryCloudSync: async (): Promise<string> => { throw new Error('Persistence is not initialized') },
  /**
   * Lane E4 (`x6_browser_estate`): a read-only, bounded view of the queue this tab holds: queued mirror batches (sequence,
   * id, digest, entry count and the first paths with their kind; never file bytes), the mirror meta, a reconciliation
   * hold, tombstone and reset roots, and the paths still waiting for a local save. Opens one readonly transaction.
   */
  inspect: async (_limit?: number): Promise<Record<string, unknown>> => ({ available: false, code: 'PERSISTENCE_NOT_INITIALIZED' }),
  localSave: { error: null as string | null, capacity: null as CapacityRefusal | null, pendingPaths: 0 },
  mirror: {
    conflict: null as string | null,
    reconciliationRequired: false,
    usageIsAdvisory: true,
    pendingBatches: 0,
    pendingBytes: 0,
    maxPendingBatches: MAX_PENDING_BATCHES,
    maxPendingBytes: MAX_PENDING_BYTES,
    maxBatchEntries: MAX_BATCH_ENTRIES,
    sending: false,
    lastAcknowledgedAt: null as number | null,
    error: null as string | null,
    target: null as string | null,
    /** Journals whose mirror copy differs from this tab's and does not extend it; the local copy is kept. */
    shadowedJournals: [] as string[],
    /** The cloud did not answer (offline, slow, a 5xx, an expired pass): saves are kept and re-sent automatically. */
    transient: null as string | null,
    /** Saves held back by a transient failure or a full outbox, waiting for the automatic resync. */
    resyncPending: false,
    /** Paths the cloud cannot hold (name or size), kept in this browser and named here; never a lockout. */
    quarantinedPaths: [] as string[],
    /** Session journals waiting for their own lane (Round 20): saved here, sent after every other queued save. */
    deferredJournals: [] as string[],
    /** Why a waiting journal last stepped aside (the cloud's upload limit or a size refusal), until it is delivered. */
    journalNote: null as string | null,
  },
}

function mintUuidV4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => { resolve(req.result) }
    req.onerror = () => { reject(req.error ?? new Error('indexedDB request failed')) }
  })
}

function queuedUsage(store: IDBObjectStore): Promise<{ count: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    const cursor = store.openCursor(batchRange())
    let count = 0; let bytes = 0
    cursor.onerror = () => { reject(cursor.error ?? new Error('Mirror queue could not be measured')) }
    cursor.onsuccess = () => {
      try {
        const row = cursor.result
        if (!row) { resolve({ count, bytes }); return }
        count += 1; bytes += recordBytes(row.value)
        if (!Number.isSafeInteger(bytes)) throw new Error('Mirror queue byte count is invalid')
        row.continue()
      } catch (error) { reject(error) }
    }
  })
}

/** A cloud read refused for want of the owner's session (AUMLOK HANDOFF-4 REQUEST 1): said as that, never as an outage. */
export const OWNER_SIGN_IN_REQUIRED = 'MIRROR_OWNER_PASS_REQUIRED: she needs the owner to sign in on this browser'
/** What a fresh browser shows while its first snapshot is refused that way. */
export const FRESH_SIGN_IN_MESSAGE = `${OWNER_SIGN_IN_REQUIRED} before her cloud memory can load here; nothing is saved in this browser until then`

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Version 2 fences legacy blind writers. Existing connections may close
    // cooperatively; a noncooperating tab blocks upgrade, never gets force-closed.
    const req = indexedDB.open(DB_NAME, 2)
    let abandoned = false
    req.onblocked = () => {
      abandoned = true
      reject(new Error('STORAGE_UPGRADE_BLOCKED: an older Auma tab still owns storage; save its work and close it before opening the upgraded app. No data was migrated.'))
    }
    req.onupgradeneeded = (event) => {
      if (abandoned) { req.transaction?.abort(); return }
      const store = event.oldVersion < 1 ? req.result.createObjectStore(STORE) : req.transaction?.objectStore(STORE)
      if (!store) { req.transaction?.abort(); return }
      if (event.oldVersion < 2) store.put({ kind: 'content-revision', seq: 0 } satisfies ContentRevision, CONTENT_KEY)
    }
    req.onsuccess = () => { if (abandoned) req.result.close(); else resolve(req.result) }
    req.onerror = () => { reject(req.error ?? new Error('indexedDB open failed')) }
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => { resolve() }
    tx.onerror = () => { reject(tx.error ?? new Error('indexedDB transaction failed')) }
    tx.onabort = () => { reject(tx.error ?? new Error('indexedDB transaction aborted')) }
  })
}

const under = (path: string, roots: readonly string[]): boolean =>
  roots.some(root => path === root || path.startsWith(root + '/'))

/**
 * Never stored in this browser: the session lock, and the boot-seeded credentials document and afferent probe, with
 * every temp, lock or backup sibling of them (each tree boot writes the credentials document through
 * `.credentials.yaml.<hex>.tmp` and `.credentials.yaml.lock`; stored, each left a tombstone and a reset root behind).
 */
const EPHEMERAL_SECRETS: ReadonlySet<string> = new Set(['.credentials.yaml', '.afferent-probe'])
const SKIP = (path: string): boolean => {
  if (/\/session\.lock$/.test(path)) return true
  const family = secretFamily(path.slice(path.lastIndexOf('/') + 1))
  return family !== null && EPHEMERAL_SECRETS.has(family)
}

// Private signing identity and secret files remain local in IndexedDB and never enter a mirror payload. The AUMLOK
// escrow pepper (Round 22) wraps the sealed node roots at rest, so no copy of it may ever travel either.
const SKIP_REMOTE = (path: string): boolean => SKIP(path) || path.split('/').some(part => secretShapedPart(part) || part === '.DS_Store')

function toB64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(out)
}

function fromB64(text: string): Uint8Array {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

// Compare the complete durable read-set, including local-only rows and outbox/reset
// metadata. A mirror sequence alone cannot detect another tab's private saves.
function storedRowsStamp(keys: readonly IDBValidKey[], values: readonly unknown[]): string {
  return sha256HexSync(JSON.stringify(keys.map((key, index) => [key, values[index]]), (_key, value: unknown) =>
    value instanceof Uint8Array ? { byteLength: value.byteLength, bytesSha256: sha256HexSync(value) } : value))
}

function decodeMirrorSnapshot(
  value: unknown,
  roots: readonly string[],
): { entries: Array<[string, Entry]>; resetPaths: string[] } {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.entries)) throw new Error('Invalid mirror snapshot response')
  const entries: Array<[string, Entry]> = []
  const seen = new Map<string, Entry>()
  const resetPaths: string[] = []
  const seenResets = new Set<string>()
  const encoder = new TextEncoder()
  if (value.resetPaths !== undefined) {
    if (!Array.isArray(value.resetPaths)) throw new Error('Invalid mirror snapshot resetPaths')
    for (const rawReset of value.resetPaths) {
      if (
        typeof rawReset !== 'string' ||
        !rawReset.startsWith('/') ||
        rawReset.includes('\\') ||
        rawReset.includes('\0') ||
        encoder.encode(rawReset).length > 4096 ||
        !under(rawReset, roots) ||
        roots.includes(rawReset) ||
        rawReset.split('/').slice(1).some(part => !part || part === '.' || part === '..' || encoder.encode(part).length > 255) ||
        !mirrorAllowed(rawReset) ||
        rawReset === '/dsh/workspace' ||
        seenResets.has(rawReset)
      ) {
        throw new Error('Invalid or duplicate mirror snapshot reset path')
      }
      seenResets.add(rawReset)
      resetPaths.push(rawReset)
    }
  }
  for (const item of value.entries) {
    if (!Array.isArray(item) || item.length !== 2) throw new Error('Invalid mirror snapshot tuple')
    const path: unknown = item[0]
    const wire: unknown = item[1]
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\\') || path.includes('\0') || encoder.encode(path).length > 4096 || !under(path, roots) || path.split('/').slice(1).some(part => !part || part === '.' || part === '..' || encoder.encode(part).length > 255) || seen.has(path)) throw new Error('Invalid or duplicate mirror snapshot path')
    if (!isRecord(wire) || (wire.kind !== 'dir' && wire.kind !== 'file') || typeof wire.mode !== 'number' || !Number.isInteger(wire.mode) || wire.mode < 0 || wire.mode > 0o777) throw new Error('Invalid mirror snapshot entry')
    let entry: Entry
    if (wire.kind === 'dir') entry = { kind: 'dir', mode: wire.mode }
    else {
      if (roots.includes(path) || typeof wire.b64 !== 'string' || wire.b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(wire.b64) || typeof wire.mtimeMs !== 'number' || !Number.isFinite(wire.mtimeMs) || wire.mtimeMs < 0 || !Number.isFinite(new Date(wire.mtimeMs).getTime())) throw new Error('Invalid mirror snapshot file')
      const bytes = fromB64(wire.b64)
      if (toB64(bytes) !== wire.b64) throw new Error('Noncanonical mirror snapshot base64')
      entry = { kind: 'file', bytes, mode: wire.mode, mtimeMs: wire.mtimeMs }
    }
    seen.set(path, entry)
    entries.push([path, entry])
  }
  for (const [path] of entries) {
    for (let parent = path.slice(0, path.lastIndexOf('/')); parent; parent = parent.slice(0, parent.lastIndexOf('/'))) {
      if (seen.get(parent)?.kind === 'file') throw new Error('Mirror snapshot file has descendants')
    }
  }
  return {
    entries: entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    resetPaths: resetPaths.sort(),
  }
}

function preflightMirrorImport(vfs: MemoryVfs, entries: readonly [string, Entry][], replacementRoots: ReadonlySet<string>): void {
  const planned = new Map(entries)
  const privateCheck = (path: string): void => {
    if (SKIP_REMOTE(path) && !SKIP(path)) throw new Error('Mirror replacement would remove local private identity')
    if (vfs.statSync(path).isDirectory()) for (const child of vfs.readdirSync(path)) privateCheck(path + '/' + String(child))
  }
  for (const root of replacementRoots) if (vfs.existsSync(root)) privateCheck(root)
  for (const [path] of entries) {
    for (let parent = path.slice(0, path.lastIndexOf('/')); parent; parent = parent.slice(0, parent.lastIndexOf('/'))) {
      const selected = planned.get(parent)
      if (selected?.kind === 'file') throw new Error('Mirror import parent is a selected file')
      const cleared = [...replacementRoots].some(root => parent === root || parent.startsWith(root + '/'))
      if (!selected && !cleared && vfs.existsSync(parent) && !vfs.statSync(parent).isDirectory()) throw new Error('Mirror import parent is a retained local file')
    }
  }
}

function apiUrl(path: string): string | null {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  if (!origin || origin === 'null') return null
  return new URL(path, origin).href
}

// The deadline covers headers and the complete UTF-8 body; failures return no partial text. With `idleMs`, a read
// that makes progress may run to `ms`, but one that receives nothing for `idleMs` is abandoned (a stall, not a size).
async function timedFetchText(
  url: string,
  init: RequestInit,
  ms: number,
  maxSuccessBytes: number,
  idleMs: number = ms,
): Promise<{ ok: boolean; status: number; text: string }> {
  const ctl = new AbortController()
  const deadline = performance.now() + ms
  const timer = setTimeout(() => { ctl.abort() }, ms)
  let idle = setTimeout(() => { ctl.abort() }, idleMs)
  const progressed = (): void => { clearTimeout(idle); idle = setTimeout(() => { ctl.abort() }, idleMs) }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const checkDeadline = (): void => {
    if (performance.now() >= deadline) ctl.abort()
    ctl.signal.throwIfAborted()
  }
  try {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init, signal: ctl.signal })
    checkDeadline()
    const maxBytes = response.ok ? maxSuccessBytes : MAX_ACK_RESPONSE_BYTES
    const contentLength = response.headers.get('content-length')
    const expectedBytes = contentLength === null ? null : Number(contentLength)
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(expectedBytes) || expectedBytes === null || expectedBytes > maxBytes)) throw new Error('Mirror response Content-Length is invalid or exceeds the byte limit')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0
    let text = ''
    reader = response.body?.getReader()
    if (reader) {
      for (;;) {
        const chunk = await reader.read()
        checkDeadline()
        progressed()
        if (chunk.done) break
        if (chunk.value.byteLength > maxBytes - bytes) throw new Error('Mirror response exceeds the byte limit')
        bytes += chunk.value.byteLength
        text += decoder.decode(chunk.value, { stream: true })
      }
    }
    text += decoder.decode()
    // Fetch exposes decompressed bytes; Content-Length describes the encoded body.
    const encoding = response.headers.get('content-encoding')
    if (expectedBytes !== null && (encoding === null || encoding.trim().toLowerCase() === 'identity') && bytes !== expectedBytes) throw new Error('Mirror response body does not match Content-Length')
    checkDeadline()
    return { ok: response.ok, status: response.status, text }
  } catch (error) {
    ctl.abort()
    throw error
  } finally {
    clearTimeout(timer)
    clearTimeout(idle)
    reader?.releaseLock()
  }
}

/**
 * Remote mirror reads (Round 19, cloud audit A6). A whole-snapshot read used to have eight seconds for every byte, so
 * a 43 MB snapshot on Wi-Fi or cellular failed and the browser was locked for good. Now a read is abandoned only after
 * 30 s with no bytes (a stall), may run to ten minutes while bytes arrive, and a transient failure is retried with
 * exponential backoff. A returning cloud browser reads only the small `/_mirror/status` fence, never the snapshot.
 */
export const MIRROR_READ_POLICY = Object.freeze({
  idleMs: 30_000, bootIdleMs: 10_000, snapshotCeilingMs: 600_000, statusCeilingMs: 30_000, statusBytes: 16 * 1024 * 1024,
  backoffMs: Object.freeze([1_000, 2_000, 4_000]),
})
/**
 * One outbox POST may take as long as its body needs at a slow 256 KiB/s uplink, never under 30 s nor over 10 min.
 * A fixed 15 s failed every save of her 20 MB session log on an ordinary connection (Round 19, A6).
 */
export const deliveryDeadlineMs = (bodyBytes: number): number =>
  Math.min(600_000, Math.max(30_000, Math.ceil(bodyBytes / 262_144) * 1_000))
export type DeliveryRefusal =
  | { readonly kind: 'fence'; readonly code: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'signed-out' | 'too-slow' | 'transient'; readonly code: string }
/**
 * What a refused cloud delivery means (Round 19, review #4/#16). A fence, replay or sequence conflict is a conflict,
 * including the 507 the cloud sends when its conflict store is full (`conflictCode`). A refusal that retrying cannot
 * change (413 limits, 400 invalid entries, 507 client or revision limits) stops re-sending and is named. 408 is the
 * cloud's 30 s upload limit; 401 an expired pass; other 5xx/429 are transient.
 */
export function deliveryRefusal(status: number, text: string): DeliveryRefusal {
  let body: unknown = null
  try { body = JSON.parse(text) } catch { /* the status decides */ }
  const field = (key: string): string | null => (isRecord(body) && typeof body[key] === 'string' && /^[A-Z0-9_]{1,64}$/.test(body[key]) ? body[key] : null)
  const code = field('code') ?? `HTTP_${String(status)}`
  if (status === 409 || field('conflictCode') !== null) return { kind: 'fence', code: field('conflictCode') ?? code }
  if (status === 401) return { kind: 'signed-out', code }
  if (status === 408) return { kind: 'too-slow', code }
  if (status === 400 || status === 413 || status === 507 || status === 404 || status === 403) return { kind: 'refused', code }
  return { kind: 'transient', code }
}
/** Background cloud resync after a transient failure: first wait, doubling, capped. */
export const CLOUD_RESYNC_POLICY = Object.freeze({ firstMs: 5_000, maxMs: 300_000 })

/** HTTP statuses that say "try again later" rather than "this is wrong". 401 is an expired or missing pass. */
const TRANSIENT_STATUSES = new Set([401, 408, 425, 429, 500, 502, 503, 504])
export const transientStatus = (status: number): boolean => TRANSIENT_STATUSES.has(status)
/** A thrown fetch failure (offline, DNS, reset, our own deadline) is transient; a malformed answer is not. */
export const transientError = (error: unknown): boolean =>
  error instanceof TypeError || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))

export interface MirrorReadOptions {
  readonly idleMs?: number
  readonly backoffMs?: readonly number[]
  readonly sleep?: (ms: number) => Promise<void>
}
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * Read with retries: each transient failure (thrown or status) waits the next backoff and tries again; anything else
 * returns at once. The last answer or error is what the caller sees.
 */
export async function readWithRetry(
  read: () => Promise<{ ok: boolean; status: number; text: string }>, options: MirrorReadOptions = {},
): Promise<{ ok: boolean; status: number; text: string }> {
  const backoff = options.backoffMs ?? MIRROR_READ_POLICY.backoffMs
  const sleep = options.sleep ?? realSleep
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await read()
      if (answer.ok || !transientStatus(answer.status) || answer.status === 401 || attempt >= backoff.length) return answer
    } catch (error) {
      if (!transientError(error) || attempt >= backoff.length) throw error
    }
    await sleep(backoff[attempt] ?? 0)
  }
}


/** One outbox at a time across this origin's tabs: deliveries, and the resync's fence-and-record read. */
async function withOutboxLock<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('aukora-x6-mirror-outbox', work) as Promise<T>
  return work()
}

/** Only the newest attachment's timers act on the shared `persistence` state; an older one goes quiet. */
let attachGeneration = 0

/**
 * The cloud outbox holds one maximal batch in flight plus one more (Round 19, review #5): at 40 MiB, two saves of her
 * 20 MB session log (27 MB base64 each) could never both queue, so nearly every turn became a full-snapshot resync.
 * The Mac host keeps the original budget.
 */
export const CLOUD_PENDING_BYTES = 2 * CLOUD_MIRROR_LIMITS.requestBytes + 8 * 1024 * 1024

/** Test seams for timing and queue size; production uses the defaults. */
export interface AttachOptions {
  readonly read?: MirrorReadOptions
  readonly resync?: { readonly firstMs?: number; readonly maxMs?: number }
  readonly queue?: { readonly maxPendingBytes?: number }
  readonly journal?: { readonly intervalMs?: number }
}

export async function attachIdbPersistence(
  vfs: MemoryVfs, roots: readonly string[], options: AttachOptions = {},
): Promise<() => Promise<void>> {
  if (typeof indexedDB === 'undefined') {
    persistence.durable = false
    return async () => {}
  }
  const generation = ++attachGeneration
  const current = (): boolean => generation === attachGeneration
  persistence.durable = false
  persistence.conflict = null
  persistence.mirror.conflict = null; persistence.mirror.error = null; persistence.mirror.reconciliationRequired = false
  persistence.mirror.shadowedJournals = []
  persistence.mirror.transient = null; persistence.mirror.resyncPending = false; persistence.mirror.quarantinedPaths = []
  persistence.mirror.deferredJournals = []; persistence.mirror.journalNote = null
  persistence.localSave.error = null; persistence.localSave.capacity = null; persistence.localSave.pendingPaths = 0
  // A refused IndexedDB stays a visible boot failure (a memory-only fallback let writes, sync
  // and close resolve with her data in memory only, with no warning anyone saw).
  const db = await openDb()
  const hostname = (globalThis as { location?: { hostname?: string } }).location?.hostname
  const localTransport = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  const pendingBytesLimit = options.queue?.maxPendingBytes ?? (localTransport ? MAX_PENDING_BYTES : CLOUD_PENDING_BYTES)
  persistence.mirror.maxPendingBytes = pendingBytesLimit
  let cloudSnapshot: CloudBase | null = null
  /** A cloud browser with no durable history whose cloud never answered: it saves nothing until her memory loads. */
  let freshBlocked = false
  /** The cloud refused or diverged from this browser's fence: queued batches are not re-posted until reconciled. */
  let fenced = false
  let hydratedReconciliation: CloudReconciliation | undefined
  let hydratedMeta: MirrorMeta | undefined
  let hasDurableHistory = false
  const hydratedQueue: MirrorBatch[] = []

  // 1. Hydrate from IndexedDB first
  let restoredIdb = 0
  let hydratedStamp: string
  let contentRevision: number
  const pendingPaths = new Set<string>()
  const tombstoneRoots = new Set<string>()
  const resetRoots = new Set<string>()
  {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
    hydratedStamp = storedRowsStamp(keys, values)
    hydratedReconciliation = values[keys.findIndex(key => key === RECONCILE_KEY)] as CloudReconciliation | undefined
    hydratedMeta = values[keys.findIndex(key => key === META_KEY)] as MirrorMeta | undefined
    hasDurableHistory = keys.some(key => key !== CONTENT_KEY)
    const revision: unknown = values[keys.findIndex(key => key === CONTENT_KEY)]
    if (!validRevision(revision)) throw new Error('Durable content revision is missing or corrupt; stored data retained')
    contentRevision = revision.seq
    hasDurableHistory ||= contentRevision !== 0
    for (const key of keys) if (String(key).startsWith(RESET_PREFIX)) {
      const root = String(key).slice(RESET_PREFIX.length)
      if (under(root, roots) && !SKIP(root)) resetRoots.add(root)
    }
    for (const root of resetRoots) if (vfs.existsSync(root)) vfs.rmSync(root, { recursive: true, force: true })
    for (let index = 0; index < keys.length; index += 1) {
      if (String(keys[index]).startsWith(BATCH_PREFIX)) {
        const record = values[index] as MirrorBatch
        if (record.kind !== 'mirror-batch' || !Array.isArray(record.batch?.entries)) throw new Error('Mirror outbox is corrupt; retained for recovery')
        hydratedQueue.push(record)
        for (const [path] of record.batch.entries) pendingPaths.add(path)
      }
    }
    // A waiting journal is unsent local work like a queued batch: an older mirror copy must not replace it.
    for (const path of journalPaths(keys)) {
      pendingPaths.add(path)
      persistence.mirror.deferredJournals.push(path)
    }
    const rows = keys.map((key, index) => [String(key), values[index] as Entry] as const)
      .filter(([path]) => under(path, roots) && !SKIP(path))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    for (const [path, entry] of rows) if (entry.kind === 'gone') tombstoneRoots.add(path)
    // Files the cloud cannot hold stay named across reloads (review #6), recounted from what this browser stored.
    if (!localTransport) {
      persistence.mirror.quarantinedPaths = rows.filter(([path, entry]) => entry.kind !== 'gone' && outboxAdmits(path, false)
        && cloudAdmission(path, entry.kind === 'file' ? entry.bytes.byteLength : null) === 'quarantine').map(([path]) => path).slice(-50)
    }
    for (const [path, entry] of rows) {
      if ([...tombstoneRoots].some(root => path.startsWith(root + '/'))) continue
      try {
        if (entry.kind === 'gone') {
          if (vfs.existsSync(path)) vfs.rmSync(path, { recursive: true, force: true })
        } else if (entry.kind === 'dir') {
          if (vfs.existsSync(path) && !vfs.statSync(path).isDirectory()) vfs.rmSync(path, { force: true })
          vfs.seedDirectory(path, { mode: entry.mode })
        } else {
          if (vfs.existsSync(path) && vfs.statSync(path).isDirectory()) vfs.rmSync(path, { recursive: true, force: true })
          vfs.seed(path, entry.bytes, { mode: entry.mode, mtimeMs: entry.mtimeMs })
        }
        restoredIdb += 1
      } catch (error) {
        throw new Error(`IDB hydration failed at ${path}; persisted data retained`, { cause: error })
      }
    }
  }

  // 2. Optional mirror reads may be offline. Once rows are imported, however,
  // their IDB transaction must commit before VFS mutation or persistence readiness.
  let mirrorEntries: Array<[string, Entry]> | null = null
  let mirrorResets: string[] = []
  const readOptions: MirrorReadOptions = options.read ?? {}
  const idleMs = readOptions.idleMs ?? MIRROR_READ_POLICY.idleMs
  type SnapshotRead = { kind: 'snapshot'; entries: Array<[string, Entry]>; resets: string[]; base: CloudBase | null } | { kind: 'unreachable'; reason: string }
  /** The whole snapshot (a fresh browser, or the Mac host), retried on transient failures, abandoned only on a stall. */
  const readSnapshot = async (atBoot = false): Promise<SnapshotRead> => {
    const snapUrl = apiUrl('/api/snapshot?snapshotFormat=x61-mirror-snapshot%2Fv2')
    if (snapUrl === null) return { kind: 'unreachable', reason: 'no page origin' }
    // At boot one retry at most: the page waits on this; the background resync keeps trying after. The Mac host keeps
    // its original single 8 s read: it is on this machine, and a stalled host should not hold the page longer.
    const policy = atBoot ? { ...readOptions, backoffMs: (readOptions.backoffMs ?? MIRROR_READ_POLICY.backoffMs).slice(0, 1) } : readOptions
    try {
      const res = localTransport
        ? await timedFetchText(snapUrl, {}, 8000, MAX_SNAPSHOT_RESPONSE_BYTES)
        : await readWithRetry(
          () => timedFetchText(snapUrl, {}, MIRROR_READ_POLICY.snapshotCeilingMs, MAX_SNAPSHOT_RESPONSE_BYTES, idleMs), policy)
      if (res.status === 401) return { kind: 'unreachable', reason: OWNER_SIGN_IN_REQUIRED }
      if (!res.ok) return { kind: 'unreachable', reason: `/api/snapshot answered ${String(res.status)}` }
      const snap: unknown = JSON.parse(res.text)
      const decoded = decodeMirrorSnapshot(snap, roots)
      let base: CloudBase | null = null
      if (!localTransport) {
        if (!isRecord(snap) || snap.protocol !== CLOUD_PROTOCOL || snap.snapshotFormat !== 'x61-mirror-snapshot/v2'
          || !Array.isArray(snap.resetPaths) || !validCloudBase(snap)) throw new Error('Authenticated cloud snapshot has no valid v2 global revision')
        base = { lineageId: snap.lineageId, revision: snap.revision }
      }
      return { kind: 'snapshot', entries: decoded.entries, resets: decoded.resetPaths, base }
    } catch (error) {
      return { kind: 'unreachable', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  /**
   * Only the cloud fence (a returning cloud browser, every resync check, and before a journal steps aside). `compact=1`
   * asks for the fence alone instead of every file name (Round 20, mirror-do); an older edge ignores the query and
   * answers the full status, which carries the same fence.
   */
  const readCloudFence = async (atBoot = false): Promise<{ kind: 'fence'; base: CloudBase } | { kind: 'unreachable'; reason: string }> => {
    const statusUrl = apiUrl('/_mirror/status?compact=1')
    if (statusUrl === null) return { kind: 'unreachable', reason: 'no page origin' }
    // At boot one short attempt (the page waits on it); the background resync retries with backoff.
    const policy = atBoot ? { ...readOptions, backoffMs: [] } : readOptions
    const statusIdle = atBoot ? Math.min(idleMs, MIRROR_READ_POLICY.bootIdleMs) : idleMs
    try {
      const res = await readWithRetry(
        () => timedFetchText(statusUrl, {}, MIRROR_READ_POLICY.statusCeilingMs, MIRROR_READ_POLICY.statusBytes, statusIdle), policy)
      if (res.status === 401) return { kind: 'unreachable', reason: 'MIRROR_OWNER_PASS_REQUIRED: sign in again; saves stay in this browser and are sent after' }
      if (!res.ok) return { kind: 'unreachable', reason: `/_mirror/status answered ${String(res.status)}` }
      const status: unknown = JSON.parse(res.text)
      if (!isRecord(status) || status.ok !== true || status.protocol !== CLOUD_PROTOCOL || !validCloudBase(status)) return { kind: 'unreachable', reason: '/_mirror/status has no cloud fence' }
      return { kind: 'fence', base: { lineageId: status.lineageId, revision: status.revision } }
    } catch (error) {
      return { kind: 'unreachable', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  const unreachable = (reason: string): string => `MIRROR_CLOUD_UNREACHABLE: ${reason}; saves stay in this browser and are sent when the cloud answers`
  let bootFailure: string | null = null
  if (localTransport || !hasDurableHistory) {
    const snap = await readSnapshot(true)
    if (snap.kind === 'snapshot') { mirrorEntries = snap.entries; mirrorResets = snap.resets; cloudSnapshot = snap.base }
    else { bootFailure = snap.reason; console.warn('x6-persist: optional mirror unavailable or rejected before import', snap.reason) }
  } else {
    const fence = await readCloudFence(true)
    if (fence.kind === 'fence') cloudSnapshot = fence.base
    else bootFailure = fence.reason
  }
  if (!localTransport) {
    persistence.mirror.maxBatchEntries = CLOUD_MAX_ENTRIES
    const verdict = classifyCloudFence(hasDurableHistory, hydratedMeta, hydratedQueue, cloudSnapshot)
    if (verdict.kind === 'unreachable') {
      if (hasDurableHistory) persistence.mirror.transient = unreachable(bootFailure ?? 'no answer')
      else {
        freshBlocked = true
        persistence.mirror.transient = bootFailure?.startsWith('MIRROR_OWNER_PASS_REQUIRED') === true ? FRESH_SIGN_IN_MESSAGE
          : `MIRROR_CLOUD_UNREACHABLE: ${bootFailure ?? 'no answer'}; her cloud memory has not loaded in this browser, `
            + 'so nothing is saved here until it does; reload when the cloud answers'
      }
    } else if (verdict.kind === 'diverged') { persistence.mirror.conflict = verdict.reason; fenced = true }
    else if (verdict.kind === 'replay-pending') {
      console.info(`x6-persist: the cloud already holds ${String(verdict.applied)} of this browser's queued saves; re-sending them in order to confirm`)
    }
    if (hydratedReconciliation) {
      const cause = verdict.kind === 'diverged' ? 'genuine' : mergeCause(hydratedReconciliation.cause, 'transient')
      if (cause === 'genuine') {
        persistence.mirror.reconciliationRequired = true
        persistence.mirror.conflict ??= 'MIRROR_RECONCILIATION_REQUIRED: locally saved changes need explicit cloud reconciliation'
      } else {
        persistence.mirror.resyncPending = true
        persistence.mirror.transient ??= 'MIRROR_RESYNC_PENDING: saves held back while the cloud was unreachable are sent when it answers in step'
      }
    }
    // Never merge existing cloud data by mtime or silently assign it a newer base.
    if (hasDurableHistory || persistence.mirror.conflict) {
      mirrorEntries = null
      mirrorResets = []
    }
  } else {
    persistence.mirror.maxBatchEntries = MAX_BATCH_ENTRIES
    if (hydratedMeta?.cloudBase !== undefined) persistence.mirror.conflict = 'MIRROR_GLOBAL_FENCE_CONFLICT: cloud storage cannot publish through the local protocol'
  }
  let initializeCloud = !localTransport && cloudSnapshot !== null && !hasDurableHistory
  if (mirrorEntries !== null && (mirrorEntries.length || mirrorResets.length || initializeCloud)) {
    const imported: Array<[string, Entry]> = []
    const replacementRoots = new Set<string>()
    // Entries held back because unsent local work overlaps them; logged so a partial first load is explainable.
    const deferred = { entries: 0, blockers: new Set<string>() }
    const pendingBlocker = (path: string): boolean => {
      const blocker = [...pendingPaths, ...tombstoneRoots].find(pending => overlaps(path, pending))
      if (blocker === undefined) return false
      deferred.entries += 1
      if (deferred.blockers.size < 5) deferred.blockers.add(blocker)
      return true
    }
    // Append-only journals the mirror extends: imported despite unsent saves; queued writes are rewritten below.
    const superseded = new Map<string, Entry & { kind: 'file' }>()
    const journalBlocked = (path: string, wire: Entry & { kind: 'file' }): boolean => {
      if (!localTransport || !APPEND_ONLY_JOURNALS.has(path) || ![...pendingPaths].some(pending => overlaps(path, pending))) return false
      const local = vfs.existsSync(path) && !vfs.statSync(path).isDirectory() ? new Uint8Array(vfs.readFileSync(path) as Uint8Array) : null
      const queued = hydratedQueue.flatMap(record => record.batch.entries.filter(([queuedPath]) => overlaps(queuedPath, path)))
      const plan = planJournalSupersede(path, wire.bytes, local, queued, tombstoneRoots)
      if (plan === 'diverged') persistence.mirror.shadowedJournals.push(path)
      if (plan !== 'supersede' || local === null) return false
      superseded.set(path, wire)
      if (!sameBytes(local, wire.bytes)) {
        const name = `${path.slice(path.lastIndexOf('/') + 1)}.${sha256HexSync(local).slice(0, 16)}.bak`
        imported.push([`${JOURNAL_BACKUP_ROOT}/${name}`, { kind: 'file', bytes: local, mode: 0o600, mtimeMs: Date.now() }])
        imported.push([path, wire])
      }
      return true
    }
    try {
      for (const resetRoot of mirrorResets) {
        if (!under(resetRoot, roots) || SKIP_REMOTE(resetRoot) || pendingBlocker(resetRoot)) continue
        replacementRoots.add(resetRoot)
      }
      for (const [path, wire] of mirrorEntries) {
        if (!under(path, roots) || SKIP_REMOTE(path)) continue
        if (wire.kind === 'file' && journalBlocked(path, wire)) continue
        if (pendingBlocker(path)) continue
        if (wire.kind === 'dir') {
          const exists = vfs.existsSync(path)
          if (initializeCloud || !exists || !vfs.statSync(path).isDirectory()) {
            if (exists && !vfs.statSync(path).isDirectory()) replacementRoots.add(path)
            imported.push([path, { kind: 'dir', mode: wire.mode }])
          }
        } else if (wire.kind === 'file') {
          const exists = vfs.existsSync(path)
          const localMtime = exists && !vfs.statSync(path).isDirectory() ? vfs.statSync(path).mtimeMs : 0
          if (initializeCloud || !exists || wire.mtimeMs > localMtime) {
            if (exists && vfs.statSync(path).isDirectory()) replacementRoots.add(path)
            imported.push([path, wire])
          }
        }
      }
      if (deferred.entries > 0) {
        console.info(`x6-persist: ${String(deferred.entries)} mirror snapshot entries deferred behind ${String(pendingPaths.size + tombstoneRoots.size)} unsent local saves (${[...deferred.blockers].join(', ')}); they import on a later load once those saves are delivered`)
      }
      if (persistence.mirror.shadowedJournals.length) {
        console.warn(`x6-persist: mirror journals differ from this tab's and do not extend them; local copies kept: ${persistence.mirror.shadowedJournals.join(', ')}`)
      }
      preflightMirrorImport(vfs, imported, replacementRoots)
    } catch (error) {
      superseded.clear()
      if (initializeCloud) {
        persistence.mirror.conflict = 'MIRROR_RECONCILIATION_REQUIRED: snapshot could not be safely imported; local saves remain available'
        initializeCloud = false; cloudSnapshot = null
      }
      imported.length = 0; replacementRoots.clear()
      console.warn('x6-persist: optional mirror import rejected before durable writes', error instanceof Error ? error.message : String(error))
    }
    if (imported.length || replacementRoots.size || initializeCloud || superseded.size) {
      let importedCommitted = false
      const tx = db.transaction(STORE, 'readwrite')
      const completed = done(tx)
      try {
        const store = tx.objectStore(STORE)
        const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
        const revision: unknown = values[keys.findIndex(key => key === CONTENT_KEY)]
        if (!validRevision(revision)) throw new Error('Durable content revision is corrupt')
        if (storedRowsStamp(keys, values) !== hydratedStamp) {
          if (initializeCloud || revision.seq !== contentRevision) persistence.conflict = 'DURABLE_CONTENT_CONFLICT: another tab saved during hydration; reload to read its committed state before writing'
          await completed
          console.info('x6-persist: optional mirror import skipped after concurrent durable changes')
        } else {
          for (const key of keys) {
            const path = String(key)
            if ([...replacementRoots].some(root => path === root || path.startsWith(root + '/'))) {
              if (SKIP_REMOTE(path) && !SKIP(path)) throw new Error('Mirror replacement would remove local private identity')
              store.delete(key)
            }
            if (path.startsWith(RESET_PREFIX) && [...replacementRoots].some(root => path.slice(RESET_PREFIX.length).startsWith(root + '/'))) store.delete(key)
          }
          for (const root of replacementRoots) store.put({ kind: 'subtree-reset', path: root }, RESET_PREFIX + root)
          for (const [path, entry] of imported) store.put(entry, path)
          if (superseded.size) for (let index = 0; index < keys.length; index += 1) {
            if (!String(keys[index]).startsWith(BATCH_PREFIX)) continue
            const rewritten = rewriteQueuedJournals(values[index] as MirrorBatch, superseded)
            if (rewritten) store.put(rewritten, keys[index])
          }
          if (superseded.size) {
            console.info(`x6-persist: ${String(superseded.size)} append-only journals taken from the longer mirror copy (${[...superseded.keys()].join(', ')}); older local copies kept under ${JOURNAL_BACKUP_ROOT}`)
          }
          if (initializeCloud && cloudSnapshot) {
            const initMeta: MirrorMeta = {
              kind: 'mirror-meta',
              clientId: mintUuidV4(),
              seq: 0,
              cloudBase: cloudSnapshot,
              cloudAcknowledgedSeq: 0,
            }
            store.put(initMeta, META_KEY)
          }
          if (contentRevision === Number.MAX_SAFE_INTEGER) throw new Error('Durable content revision exhausted')
          store.put({ kind: 'content-revision', seq: contentRevision + 1 } satisfies ContentRevision, CONTENT_KEY)
          await completed
          contentRevision += 1
          importedCommitted = true
        }
      } catch (error) {
        try { tx.abort() } catch {}
        await completed.catch(() => {})
        throw new Error('Mirror hydration was not durably committed; boot stopped with stored data retained', { cause: error })
      }
      if (importedCommitted) {
        for (const root of replacementRoots) if (vfs.existsSync(root)) vfs.rmSync(root, { recursive: true, force: true })
        for (const [path, entry] of imported) {
          if (entry.kind === 'dir') vfs.seedDirectory(path, { mode: entry.mode })
          else if (entry.kind === 'file') {
            if (vfs.existsSync(path) && vfs.statSync(path).isDirectory()) vfs.rmSync(path, { recursive: true, force: true })
            vfs.seed(path, entry.bytes, { mode: entry.mode, mtimeMs: entry.mtimeMs })
          }
        }
        console.info(`x6-persist: durably hydrated ${String(imported.length)} entries from repo mirror`)
      }
    }
  }

  // Seed an in-memory-only dummy Vault credential reference (`mode: 0600`) using the exact
  // `refs: DEEPSEEK_API_KEY: x5-edge-door` schema expected by `@deepseek-ai/dsh-credentials-local`
  // so `worker-host.ts` routes model calls to `/door/deepseek/*`, where the host injects the Vault key.
  try {
    const dummyCreds = new TextEncoder().encode(
      'version: 1\nrefs:\n  DEEPSEEK_API_KEY: x5-edge-door\n  ANTHROPIC_API_KEY: x5-edge-door\n  OPENROUTER_API_KEY: x5-edge-door\n',
    )
    vfs.seed('/dsh/home/.credentials.yaml', dummyCreds, { mode: 0o600, mtimeMs: Date.now() })
    const cleanTx = db.transaction(STORE, 'readwrite')
    cleanTx.objectStore(STORE).delete('/dsh/home/.credentials.yaml')
  } catch {}

  console.info(`x6-persist: active (idb=${String(restoredIdb)} entries under ${roots.join(', ')})`)

  const dirty = new Set<string>()
  const removed = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()
  let pumping: Promise<void> | null = null
  let retryMs = 1000
  let capacityRefusalUsage: { count: number; bytes: number } | null = null
  const deltaUrl = apiUrl('/_mirror/delta')
  persistence.mirror.target = deltaUrl

  const queuePump = (delay = 0): void => {
    if (!deltaUrl || retryTimer !== undefined) return
    retryTimer = setTimeout(() => { retryTimer = undefined; if (current()) void sync().catch(() => {}) }, delay)
  }

  // SESSION JOURNAL LANE (Round 20, SESSION_JOURNAL_POLICY): when each waiting journal may go next.
  const journalInterval = options.journal?.intervalMs
    ?? (localTransport ? SESSION_JOURNAL_POLICY.localIntervalMs : SESSION_JOURNAL_POLICY.cloudIntervalMs)
  const journalSentAt = new Map<string, number>()
  let journalTimer: ReturnType<typeof setTimeout> | undefined
  /** During an explicit upload: the journals it already sent, so each goes at most once (null outside an upload). */
  let forcedJournals: Set<string> | null = null
  /** Why each waiting journal last stepped aside; `journalNote` shows the newest one still waiting. */
  const journalNotes = new Map<string, string>()
  /** Names this lane put in quarantinedPaths (a size refusal or a batch too large), cleared again when delivered. */
  const journalNamed = new Set<string>()
  const noteJournal = (path: string, note: string | null): void => {
    if (note === null) journalNotes.delete(path); else journalNotes.set(path, note)
    persistence.mirror.journalNote = [...journalNotes.values()].at(-1) ?? null
  }
  const wakeJournals = (at: number): void => {
    if (journalTimer !== undefined) clearTimeout(journalTimer)
    journalTimer = setTimeout(() => { journalTimer = undefined; if (current()) queuePump() }, Math.max(0, at - Date.now()))
  }

  // CLOUD RESYNC (Round 19, cloud audit A6/A26/A27): held-back saves go out once the cloud answers in step.
  const resyncFirstMs = options.resync?.firstMs ?? CLOUD_RESYNC_POLICY.firstMs
  const resyncMaxMs = options.resync?.maxMs ?? CLOUD_RESYNC_POLICY.maxMs
  let slowDeliveries = 0
  let slowBatch: string | null = null
  let resyncTimer: ReturnType<typeof setTimeout> | undefined
  let resyncDelay = resyncFirstMs
  let resyncRunning: Promise<string> | null = null
  let resyncDue = Number.POSITIVE_INFINITY
  const scheduleResync = (delay: number = resyncDelay): void => {
    if (localTransport) return
    const due = performance.now() + delay
    if (resyncTimer !== undefined) {
      if (due >= resyncDue) return
      clearTimeout(resyncTimer)
    }
    resyncDue = due
    resyncTimer = setTimeout(() => {
      resyncTimer = undefined; resyncDue = Number.POSITIVE_INFINITY
      if (!current()) return
      retryCloudSync().catch((error: unknown) => {
        persistence.mirror.transient = unreachable(error instanceof Error ? error.message : String(error))
        backoffResync('error')
      })
    }, delay)
  }
  const backoffResync = (state: string): string => {
    resyncDelay = Math.min(resyncDelay * 2, resyncMaxMs)
    scheduleResync(resyncDelay)
    return state
  }
  /** Divergence: stop, keep everything, and mark any hold genuine so nothing is sent until reconciliation. */
  const failClosed = async (reason: string): Promise<string> => {
    persistence.mirror.conflict = reason
    persistence.mirror.transient = null
    fenced = true
    const tx = db.transaction(STORE, 'readwrite')
    const completed = done(tx)
    const store = tx.objectStore(STORE)
    const marker = await request(store.get(RECONCILE_KEY)) as CloudReconciliation | undefined
    if (marker) store.put({ ...marker, cause: 'genuine' } satisfies CloudReconciliation, RECONCILE_KEY)
    await completed
    if (marker) { persistence.mirror.reconciliationRequired = true; persistence.mirror.resyncPending = false }
    return 'conflict'
  }
  /** Plan from the stored rows and queue the fenced batches, in the save chain so no local save interleaves. */
  const enqueueResync = (cloud: ReadonlyMap<string, Entry>, base: CloudBase): Promise<string> => {
    const run = chain.then(async (): Promise<string> => {
      const tx = db.transaction(STORE, 'readwrite')
      const completed = done(tx)
      const store = tx.objectStore(STORE)
      let refused: string | null = null
      let outcome = 'in-step'
      let quarantined: readonly string[] = []
      try {
        const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
        const at = (key: string): unknown => values[keys.findIndex(candidate => candidate === key)]
        const revision = at(CONTENT_KEY)
        const meta = at(META_KEY) as MirrorMeta | undefined
        const marker = at(RECONCILE_KEY) as CloudReconciliation | undefined
        // No content row changes here (only the queue, meta and the marker), so other tabs' content revision is left alone.
        if (!validRevision(revision)) { tx.abort(); await completed.catch(() => {}); return 'not-writable' }
        if (!marker) { await completed; return 'in-step' }
        const queuedNow = keys.some(key => String(key).startsWith(BATCH_PREFIX))
        const moved = !meta || !validCloudBase(meta.cloudBase) || !sameCloudBase(meta.cloudBase, base)
          || meta.cloudAcknowledgedSeq !== meta.seq
        if (queuedNow || moved) {
          tx.abort(); await completed.catch(() => {})
          return backoffResync('changed-while-planning')
        }
        const rows = new Map<string, Entry>()
        const resets = new Set<string>()
        keys.forEach((key, index) => {
          const path = String(key)
          if (path.startsWith(RESET_PREFIX)) {
            const root = path.slice(RESET_PREFIX.length)
            if (under(root, roots) && !SKIP(root)) resets.add(root)
            return
          }
          if (path.startsWith('@') || !under(path, roots) || SKIP(path)) return
          const entry = values[index] as Entry
          if (entry.kind === 'file' || entry.kind === 'dir' || entry.kind === 'gone') rows.set(path, entry)
        })
        const plan = planCloudResync(rows, resets, cloud)
        quarantined = plan.quarantined
        if (plan.refused !== null) { refused = plan.refused; tx.abort(); await completed.catch(() => {}) }
        else {
          // Queue what the local outbox can hold; anything left is planned again after these are delivered.
          let bytes = 0, count = 0
          const accepted: MirrorBatch[] = []
          for (const [index, entries] of plan.batches.entries()) {
            const seq = meta.seq + 1 + index
            const batch: MirrorBatch['batch'] = { clientId: meta.clientId, seq, id: `${meta.clientId}:${String(seq)}`, entries: [...entries],
              cloudBase: { lineageId: base.lineageId, revision: base.revision + index } }
            const record: MirrorBatch = { kind: 'mirror-batch', batch, digest: sha256HexSync(JSON.stringify(batch)) }
            const size = recordBytes(record)
            if (recordBytes({ v: 2, batch, digest: record.digest }) > CLOUD_MAX_BODY) {
              tx.abort(); await completed.catch(() => {})
              return failClosed('MIRROR_RECONCILIATION_REQUIRED: a resync batch would exceed one cloud request; saved locally, nothing sent')
            }
            if (accepted.length && (count + 1 > MAX_PENDING_BATCHES || bytes + size > pendingBytesLimit)) break
            accepted.push(record); bytes += size; count += 1
          }
          for (const record of accepted) store.put(record, BATCH_PREFIX + String(record.batch.seq).padStart(16, '0'))
          if (accepted.length) store.put({ ...meta, seq: meta.seq + accepted.length } satisfies MirrorMeta, META_KEY)
          const complete = accepted.length === plan.batches.length
          // Journals that differ wait for their own lane; once the plan is complete, any other waiting one is in step.
          const waiting = journalPaths(keys)
          if (complete) for (const path of waiting) if (!plan.deferred.includes(path)) store.delete(JOURNAL_PREFIX + path)
          for (const path of plan.deferred) {
            if (!waiting.includes(path)) store.put({ kind: 'deferred-journal', path, notBefore: 0, failures: 0 } satisfies DeferredJournalMarker, JOURNAL_PREFIX + path)
          }
          persistence.mirror.deferredJournals = [...new Set([...(complete ? [] : waiting), ...plan.deferred])]
          if (complete) store.delete(RECONCILE_KEY)
          await completed
          outcome = complete ? (accepted.length ? 'resynced' : 'in-step') : 'resyncing'
          if (complete) {
            persistence.mirror.resyncPending = false
            persistence.mirror.reconciliationRequired = false
            if (persistence.mirror.conflict?.startsWith('MIRROR_RECONCILIATION_REQUIRED') === true && !fenced) persistence.mirror.conflict = null
            persistence.mirror.transient = null
          }
          persistence.mirror.pendingBatches = accepted.length
          if (accepted.length) console.info(`x6-persist: resync queued ${String(accepted.length)} fenced batches of saves held back while the cloud was unreachable`)
        }
      } catch (error) {
        try { tx.abort() } catch {}
        await completed.catch(() => {})
        throw error
      }
      if (quarantined.length) {
        persistence.mirror.quarantinedPaths = [...new Set([...persistence.mirror.quarantinedPaths, ...quarantined])].slice(-50)
      }
      if (refused !== null) return failClosed(`MIRROR_RECONCILIATION_REQUIRED: ${refused}; saved locally, nothing sent`)
      resyncDelay = resyncFirstMs
      queuePump()
      return outcome
    })
    chain = run.then(() => {}, () => {})
    return run
  }
  /**
   * Check the cloud fence and send what is held back (any cause), only when the cloud is exactly where this browser last
   * left it with nothing queued. Never overwrites a cloud that moved: that fails closed. The timer and the page share it.
   */
  const retryCloudSync = (): Promise<string> => {
    if (resyncRunning) return resyncRunning
    resyncRunning = (async (): Promise<string> => {
      if (localTransport) return 'local-host'
      if (persistence.readOnly || persistence.conflict !== null) return 'not-writable'
      if (freshBlocked) {
        const probe = await readCloudFence(false)
        if (probe.kind !== 'fence') {
          // Still signed out: keep saying so (the fence read's own 401 words speak of saves this browser does not keep).
          if (probe.reason.startsWith('MIRROR_OWNER_PASS_REQUIRED')) persistence.mirror.transient = FRESH_SIGN_IN_MESSAGE
          return backoffResync('unreachable')
        }
        persistence.mirror.transient = 'MIRROR_CLOUD_REACHABLE: her cloud memory answers now; reload this page to load it here'
        return 'reload-required'
      }
      if (fenced) return 'conflict'
      // Queued batches carry their own fences; deliver them first (a lost acknowledgement replays here).
      try { await sync() } catch { if (fenced) return 'conflict' }
      // The fence and this browser's record are read together under the outbox lock, so no delivery lands between
      // them (a delivery in between would make a cloud that is merely behind look diverged).
      const observed = await withOutboxLock(async () => {
        const fence = await readCloudFence(false)
        if (fence.kind !== 'fence') return { fence, meta: undefined, marker: undefined, queued: [] as MirrorBatch[] }
        const readTx = db.transaction(STORE, 'readonly')
        const readDone = done(readTx)
        const readStore = readTx.objectStore(STORE)
        const [meta, marker, queued] = await Promise.all([
          request(readStore.get(META_KEY)) as Promise<MirrorMeta | undefined>,
          request(readStore.get(RECONCILE_KEY)) as Promise<CloudReconciliation | undefined>,
          request(readStore.getAll(batchRange())) as Promise<MirrorBatch[]>,
        ])
        await readDone
        return { fence, meta, marker, queued }
      })
      const { fence, meta, marker, queued } = observed
      if (fence.kind !== 'fence') {
        persistence.mirror.transient = fence.reason.startsWith('MIRROR_') ? fence.reason : unreachable(fence.reason)
        return backoffResync('unreachable')
      }
      if (queued.length > 0) {
        // Batches still wait: a cloud that moved past what they can replay is a conflict now, not after they fail.
        const waiting = classifyCloudFence(true, meta, queued, fence.base)
        if (waiting.kind === 'diverged') return failClosed(waiting.reason)
        return backoffResync('delivering')
      }
      const verdict = classifyCloudFence(true, meta, [], fence.base)
      if (verdict.kind !== 'in-step') return failClosed(verdict.kind === 'diverged' ? verdict.reason : 'MIRROR_GLOBAL_FENCE_CONFLICT: cloud changed')
      cloudSnapshot = fence.base
      if (!marker) {
        persistence.mirror.transient = null; persistence.mirror.resyncPending = false; resyncDelay = resyncFirstMs
        if (dirty.size || removed.size) void flush().catch(() => {})
        queuePump()
        return 'in-step'
      }
      const snap = await readSnapshot(false)
      if (snap.kind !== 'snapshot' || snap.base === null) {
        persistence.mirror.transient = unreachable(snap.kind === 'unreachable' ? snap.reason : 'snapshot has no fence')
        return backoffResync('unreachable')
      }
      if (!sameCloudBase(snap.base, fence.base)) return backoffResync('cloud-moving')
      return enqueueResync(new Map(snap.entries), fence.base)
    })().finally(() => { resyncRunning = null })
    return resyncRunning
  }
  const appendBatch = async (
    local: Array<[string, Entry]>,
    offered: Array<[string, WireEntry]>,
    clearRoots: readonly string[],
    journals: readonly string[] = [],
  ): Promise<void> => {
    if (freshBlocked) throw new Error(persistence.mirror.transient ?? 'MIRROR_CLOUD_UNREACHABLE: her cloud memory has not loaded; nothing is saved here yet')
    const cloudRootClear = !localTransport && [...clearRoots, ...local.filter(([, entry]) => entry.kind === 'gone').map(([path]) => path)].some(path => ['/dsh/home', '/dsh/workspace'].some(root => path === root || root.startsWith(path + '/')))
    // CLOUD ADMISSION (Round 19, A29): a path the cloud cannot hold is set aside and named, never a lockout; the same
    // failure under her seed fails closed (genuine), because leaving a receipt or organ behind would fork her chain.
    const sizes = new Map(local.map(([path, entry]) => [path, entry.kind === 'file' ? entry.bytes.byteLength : null]))
    const entries: Array<[string, WireEntry]> = []
    const quarantinedNow: string[] = []
    let refusedSeedPath: string | null = null
    for (const item of offered) {
      const verdict = localTransport ? 'send' : cloudAdmission(item[0], sizes.get(item[0]) ?? null)
      if (verdict === 'send') entries.push(item)
      else if (verdict === 'quarantine') quarantinedNow.push(item[0])
      else refusedSeedPath ??= item[0]
    }
    // Session journals past the lane threshold are marked waiting rather than queued (Round 20).
    const journalsNow: string[] = []
    for (const path of journals) {
      const verdict = localTransport ? 'send' : cloudAdmission(path, sizes.get(path) ?? null)
      if (verdict === 'send') journalsNow.push(path)
      else if (verdict === 'quarantine') quarantinedNow.push(path)
      else refusedSeedPath ??= path
    }
    const needsCloudTracking = entries.length > 0 || cloudRootClear || refusedSeedPath !== null
    const tx = db.transaction(STORE, 'readwrite')
    const completed = done(tx)
    const store = tx.objectStore(STORE)
    try {
      const [savedMeta, keys, revision, usage, queued, reconciliation] = await Promise.all([
        request(store.get(META_KEY)),
        request(store.getAllKeys()),
        request(store.get(CONTENT_KEY)),
        entries.length ? queuedUsage(store) : Promise.resolve(null),
        request(store.getAll(batchRange())) as Promise<MirrorBatch[]>,
        request(store.get(RECONCILE_KEY)) as Promise<CloudReconciliation | undefined>,
      ])
      if (!validRevision(revision)) throw new Error('Durable content revision is corrupt')
      if (revision.seq !== contentRevision) {
        persistence.conflict = 'DURABLE_CONTENT_CONFLICT: another tab saved; this tab retains its unsaved VFS changes and must reload or explicitly reconcile before writing'
        persistence.durable = false
        throw new Error(persistence.conflict)
      }
      if (contentRevision === Number.MAX_SAFE_INTEGER) throw new Error('Durable content revision exhausted')
      const meta: MirrorMeta = savedMeta ?? { kind: 'mirror-meta', clientId: mintUuidV4(), seq: 0 }
      let reconciliationReason: string | null = null
      let holdCause: ReconciliationCause = 'genuine'
      let record: MirrorBatch | null = null
      let coalesced: MirrorBatch | null = null
      let candidateBytes = 0
      try {
        if (cloudRootClear) throw new Error('MIRROR_RECONCILIATION_REQUIRED: mirror root cleared; saved locally, cloud reconciliation required')
        if (refusedSeedPath !== null) throw new Error(`MIRROR_RECONCILIATION_REQUIRED: ${refusedSeedPath} cannot be sent to the cloud (name or size); saved locally`)
        // A real conflict outranks any hold. A held-back browser sends nothing new: the resync sends everything it saved
        // since, in one fenced pass.
        if (!localTransport && needsCloudTracking && persistence.mirror.conflict) throw new Error(persistence.mirror.conflict)
        if (!localTransport && needsCloudTracking && reconciliation) {
          throw new CloudHold(mergeCause(reconciliation.cause, 'transient'), persistence.mirror.transient
            ?? 'MIRROR_RECONCILIATION_REQUIRED: durable local changes need reconciliation')
        }
        if (meta.kind !== 'mirror-meta' || !Number.isSafeInteger(meta.seq) || meta.seq < 0 || !/^[0-9a-f-]{36}$/.test(meta.clientId) || (!savedMeta && keys.some(key => String(key).startsWith(BATCH_PREFIX)))) throw new Error('Mirror identity/sequence metadata is corrupt')
        if (entries.length) {
          const seq = meta.seq + 1
          if (!Number.isSafeInteger(seq)) throw new Error('Mirror sequence exhausted')
          const batch: MirrorBatch['batch'] = { clientId: meta.clientId, seq, id: `${meta.clientId}:${String(seq)}`, entries }
          if (!localTransport) {
            if (!cloudSnapshot) throw new CloudHold('transient', unreachable('the cloud fence is not known yet'))
            batch.cloudBase = projectedCloudBase(meta, queued)
            if (batch.cloudBase.revision === Number.MAX_SAFE_INTEGER) throw new Error('Cloud revision exhausted')
          }
          if (!usage) throw new Error('Mirror queue measurement is unavailable')
          persistence.mirror.pendingBatches = usage.count; persistence.mirror.pendingBytes = usage.bytes
          // COALESCE (cloud): a save of a file already waiting in the queue's unsent TAIL replaces that copy instead of
          // queueing a second one. Only the tail of a queue of two or more is merged: the drain sends the head only,
          // so the tail is never in flight. Seq, id and fence stay; only its entries and digest change.
          const last = queued.length >= 2 ? queued[queued.length - 1] : undefined
          const tail = !localTransport && last?.deferred !== true ? last : undefined
          if (tail !== undefined) {
            const incoming = new Map(entries)
            const kept = tail.batch.entries.filter(([path, wire]) => {
              const next = incoming.get(path)
              return !(wire.kind === 'file' && next !== undefined && next.kind !== 'dir')
            })
            const mergedBatch: MirrorBatch['batch'] = { ...tail.batch, entries: [...kept, ...entries] }
            const merged: MirrorBatch = { kind: 'mirror-batch', batch: mergedBatch, digest: sha256HexSync(JSON.stringify(mergedBatch)) }
            const fits = mergedBatch.entries.length <= CLOUD_MAX_ENTRIES
              && recordBytes({ v: 2, batch: mergedBatch, digest: merged.digest }) <= CLOUD_MAX_BODY
            if (fits && usage.bytes - recordBytes(tail) + recordBytes(merged) <= pendingBytesLimit) {
              coalesced = merged
              candidateBytes = recordBytes(merged) - recordBytes(tail)
            }
          }
          if (coalesced === null) {
            record = { kind: 'mirror-batch', batch, digest: sha256HexSync(JSON.stringify(batch)) }
            candidateBytes = recordBytes(record)
            const oversize = entries.length > CLOUD_MAX_ENTRIES || recordBytes({ v: 2, batch, digest: record.digest }) > CLOUD_MAX_BODY
            if (!localTransport && oversize) {
              throw new CloudHold('capacity', 'MIRROR_RESYNC_PENDING: this change exceeds one cloud request; saved locally, the resync splits it')
            }
            if (entries.length > MAX_BATCH_ENTRIES || candidateBytes > pendingBytesLimit) throw new MirrorCapacityError('batch-too-large', 'This change exceeds one mirror batch limit; draining cannot make it fit')
            if (usage.count + 1 > MAX_PENDING_BATCHES || usage.bytes + candidateBytes > pendingBytesLimit) {
              capacityRefusalUsage = { ...usage }
              throw new MirrorCapacityError('queue-full', 'Deliver existing mirror work, then retry saving')
            }
            meta.seq = seq
          }
        }
      } catch (error) {
        if (localTransport) throw error
        record = null; coalesced = null; candidateBytes = 0
        if (error instanceof CloudHold) holdCause = error.hold
        else if (error instanceof MirrorCapacityError && error.refusal === 'queue-full') holdCause = 'capacity'
        reconciliationReason = error instanceof MirrorCapacityError
          ? `MIRROR_RESYNC_PENDING: the outbox is full (${error.refusal}); saved locally, sent when delivered work frees room`
          : error instanceof Error ? error.message : String(error)
        if (error instanceof MirrorCapacityError && error.refusal === 'batch-too-large') {
          reconciliationReason = 'MIRROR_RECONCILIATION_REQUIRED: one change exceeds a mirror batch; saved locally, cloud reconciliation required'
        }
      }
      // One bounded marker refers to authoritative IDB content, including tombstones and subtree resets. Its cause decides
      // what the page says (pending vs reconciliation required); the resync sends any hold only under an in-step fence.
      let markerCause: ReconciliationCause | null = null
      if (!localTransport && needsCloudTracking && (reconciliation || reconciliationReason)) {
        const validFirst = reconciliation && Number.isSafeInteger(reconciliation.firstRevision) && reconciliation.firstRevision >= 0
        const firstRevision = validFirst ? reconciliation.firstRevision : contentRevision + 1
        markerCause = mergeCause(reconciliation ? reconciliation.cause : null, holdCause)
        store.put({ kind: 'cloud-reconciliation', firstRevision, lastRevision: contentRevision + 1, scope: 'all-persisted-mirror-content', cause: markerCause } satisfies CloudReconciliation, RECONCILE_KEY)
      }
      // A waiting journal this save now sends, deletes or clears stops waiting; one saved again keeps its place and wait.
      const waiting = journalPaths(keys)
      const covered = (path: string): boolean => entries.some(([sent, wire]) => sent === path || (wire.kind === 'gone' && path.startsWith(sent + '/')))
        || clearRoots.some(root => path === root || path.startsWith(root + '/'))
      const released = waiting.filter(path => !journalsNow.includes(path) && covered(path))
      for (const path of released) store.delete(JOURNAL_PREFIX + path)
      for (const path of journalsNow) {
        if (waiting.includes(path)) continue
        const notBefore = (journalSentAt.get(path) ?? Number.NEGATIVE_INFINITY) + journalInterval
        store.put({ kind: 'deferred-journal', path, notBefore: Number.isFinite(notBefore) ? notBefore : 0, failures: 0 } satisfies DeferredJournalMarker,
          JOURNAL_PREFIX + path)
      }
      // Admission and durable revision checks precede every content/outbox mutation.
      for (const key of keys) if (clearRoots.some(root => String(key).startsWith(root + '/'))) store.delete(key)
      for (const root of clearRoots) store.put({ kind: 'subtree-reset', path: root }, RESET_PREFIX + root)
      for (const [path, entry] of local) store.put(entry, path)
      if (record) store.put(record, BATCH_PREFIX + String(meta.seq).padStart(16, '0'))
      if (coalesced) store.put(coalesced, BATCH_PREFIX + String(coalesced.batch.seq).padStart(16, '0'))
      if (localTransport || record) store.put(meta, META_KEY)
      store.put({ kind: 'content-revision', seq: contentRevision + 1 } satisfies ContentRevision, CONTENT_KEY)
      await completed
      contentRevision += 1
      if (markerCause === 'genuine') {
        persistence.mirror.reconciliationRequired = true
        persistence.mirror.conflict = reconciliationReason ?? 'MIRROR_RECONCILIATION_REQUIRED: durable local changes need reconciliation'
      } else if (markerCause !== null) {
        persistence.mirror.resyncPending = true
        persistence.mirror.transient ??= reconciliationReason
        scheduleResync()
      }
      if (quarantinedNow.length) {
        for (const path of quarantinedNow) journalNamed.delete(path)
        const fresh = quarantinedNow.filter(path => !persistence.mirror.quarantinedPaths.includes(path))
        persistence.mirror.quarantinedPaths = [...persistence.mirror.quarantinedPaths, ...fresh].slice(-50)
        if (fresh.length) console.warn(`x6-persist: kept in this browser only (the cloud cannot hold these names or sizes): ${fresh.slice(0, 5).join(', ')}`)
      }
      persistence.mirror.pendingBatches = keys.filter(key => String(key).startsWith(BATCH_PREFIX)).length + (record ? 1 : 0)
      if (coalesced) console.info(`x6-persist: merged this save into unsent batch ${String(coalesced.batch.seq)} instead of queueing another copy`)
      persistence.mirror.deferredJournals = [...new Set([...waiting.filter(path => !released.includes(path)), ...journalsNow])]
      if (usage) persistence.mirror.pendingBytes = usage.bytes + candidateBytes
      queuePump()
    } catch (error) {
      try { tx.abort() } catch {}
      await completed.catch(() => {})
      throw error
    }
  }
  const journalAside = (path: string): void => {
    journalNamed.add(path)
    persistence.mirror.quarantinedPaths = [...new Set([...persistence.mirror.quarantinedPaths, path])].slice(-50)
    console.warn(`x6-persist: kept in this browser only (the mirror cannot hold this session journal): ${path}`)
  }
  /**
   * Queue one waiting session journal as its own batch: its newest stored bytes, only into an empty queue, outside any
   * hold or conflict, once its wait is over (at once for an explicit upload). Runs inside the drain, under the outbox
   * lock. Returns whether the drain should look at the queue again: a journal was queued, or another batch (a resync's)
   * arrived after the drain last found the queue empty.
   */
  const enqueueJournal = async (): Promise<boolean> => {
    if (!localTransport && (fenced || freshBlocked || persistence.mirror.conflict !== null)) return false
    const tx = db.transaction(STORE, 'readwrite')
    const completed = done(tx)
    const store = tx.objectStore(STORE)
    try {
      const [markers, meta, queued, hold] = await Promise.all([
        request(store.getAll(journalRange())) as Promise<DeferredJournalMarker[]>,
        request(store.get(META_KEY)) as Promise<MirrorMeta | undefined>,
        request(store.count(batchRange())),
        request(store.get(RECONCILE_KEY)) as Promise<CloudReconciliation | undefined>,
      ])
      persistence.mirror.deferredJournals = markers.map(marker => marker.path)
      if (queued > 0) { await completed; return true }
      if (!markers.length || hold !== undefined || !meta) { await completed; return false }
      // A browser that never learned the fence learns it first; the resync's in-step answer pumps this lane again.
      if (!localTransport && cloudSnapshot === null) { await completed; scheduleResync(); return false }
      const now = Date.now()
      // An explicit upload skips the interval once per journal, never the wait after the cloud did not take one: a journal
      // written again while its forced copy uploads waits for its interval, so an upload always ends.
      const forced = forcedJournals
      const due = markers.filter(marker => marker.notBefore <= now
        || (forced !== null && marker.failures === 0 && !forced.has(marker.path)))
      if (!due.length) {
        await completed
        wakeJournals(Math.min(...markers.map(marker => marker.notBefore)))
        return false
      }
      const held: number[] = []
      // Too big for one batch here: kept and named, and offered again only after the longest wait, so it is not encoded
      // again on every pass (a 40 MB journal on the Mac would otherwise be re-encoded every few seconds).
      const holdOversize = (waiting: DeferredJournalMarker, bytes: number): void => {
        const notBefore = now + SESSION_JOURNAL_POLICY.maxRetryMs
        store.put({ ...waiting, notBefore, failures: waiting.failures + 1 } satisfies DeferredJournalMarker, JOURNAL_PREFIX + waiting.path)
        held.push(notBefore)
        journalAside(waiting.path)
        noteJournal(waiting.path, `MIRROR_JOURNAL_TOO_LARGE: a ${String(Math.round(bytes / 1048576))} MB session journal is larger `
          + `than one ${localTransport ? 'host' : 'cloud'} batch; it is kept here and offered again in 30 min`)
      }
      for (const waiting of due) {
        const key = JOURNAL_PREFIX + waiting.path
        const entry = await request(store.get(waiting.path)) as Entry | undefined
        // Deleted or replaced since: the save that did it carries that change, so there is nothing left to send.
        if (entry?.kind !== 'file' || !outboxAdmits(waiting.path, localTransport)) { store.delete(key); continue }
        if (!localTransport && cloudAdmission(waiting.path, entry.bytes.byteLength) !== 'send') {
          store.delete(key); journalAside(waiting.path); continue
        }
        const estimate = Math.ceil(entry.bytes.byteLength / 3) * 4 + 65_536
        if (estimate > pendingBytesLimit || (!localTransport && estimate > CLOUD_MAX_BODY)) {
          holdOversize(waiting, entry.bytes.byteLength); continue
        }
        const seq = meta.seq + 1
        if (!Number.isSafeInteger(seq)) throw new Error('Mirror sequence exhausted')
        const batch: MirrorBatch['batch'] = { clientId: meta.clientId, seq, id: `${meta.clientId}:${String(seq)}`, entries: [[waiting.path, toWire(entry)]] }
        if (!localTransport) batch.cloudBase = projectedCloudBase(meta, [])
        const record: MirrorBatch = { kind: 'mirror-batch', batch, digest: sha256HexSync(JSON.stringify(batch)), deferred: true,
          ...(waiting.failures > 0 ? { failures: waiting.failures } : {}) }
        const envelope = localTransport ? 0 : recordBytes({ v: 2, batch, digest: record.digest })
        if (recordBytes(record) > pendingBytesLimit || envelope > CLOUD_MAX_BODY) {
          holdOversize(waiting, entry.bytes.byteLength); continue
        }
        store.put(record, BATCH_PREFIX + String(seq).padStart(16, '0'))
        store.put({ ...meta, seq } satisfies MirrorMeta, META_KEY)
        store.delete(key)
        await completed
        journalSentAt.set(waiting.path, now)
        forcedJournals?.add(waiting.path)
        persistence.mirror.deferredJournals = persistence.mirror.deferredJournals.filter(path => path !== waiting.path)
        persistence.mirror.pendingBatches = 1
        return true
      }
      await completed
      // Nothing went this pass: wake for whichever journal may go next, so none waits for an unrelated save.
      const later = [...markers.filter(marker => !due.includes(marker)).map(marker => marker.notBefore), ...held]
      if (later.length) wakeJournals(Math.min(...later))
      return false
    } catch (error) {
      try { tx.abort() } catch {}
      await completed.catch(() => {})
      throw error
    }
  }
  /**
   * The cloud did not take the head of the queue (408 or 413) and that batch carries a session journal: a journal batch
   * of the lane, or an ordinary batch queued before Round 20 with her journal inside it. The journal steps out, so the
   * saves still go. That is safe only if nothing ever applied this batch, including an earlier attempt whose answer was
   * lost to a reload: so the cloud's fence is read first (the read waits behind any request the cloud is still
   * processing), and the batch changes only while that fence is exactly the base it was queued on. Then no batch id
   * from here on has a receipt in the cloud: the head keeps its seq and fence without the journal, or, when the journal
   * was all it held, it is removed and each later batch (never sent: only the head is ever sent) moves down one place.
   * The journal waits again for a growing interval, unless a later save already carries it.
   * @returns 'aside' when the journal stepped out; 'kept' when the cloud may hold this batch already (its fence is ahead
   *   but within this browser's own queued saves) or the head changed; 'diverged' when the fence is past everything this
   *   browser queued, or on another lineage (another writer: the caller fails closed); 'unknown' when the fence could
   *   not be read (the caller retries rather than refusing). Only 'aside' changes anything.
   */
  type AsideOutcome = 'aside' | 'kept' | 'diverged' | 'unknown'
  const setJournalAside = async (headKey: IDBValidKey, head: MirrorBatch, status: number): Promise<AsideOutcome> => {
    const expected = head.batch.cloudBase
    if (expected === undefined || !head.batch.entries.some(carriesJournal)) return 'kept'
    const fence = await readCloudFence(false)
    if (fence.kind !== 'fence') return 'unknown'
    if (!sameCloudBase(fence.base, expected)) {
      const queuedNow = await (async () => {
        const readTx = db.transaction(STORE, 'readonly')
        const readDone = done(readTx)
        const all = await request(readTx.objectStore(STORE).count(batchRange()))
        await readDone
        return all
      })()
      const beyond = fence.base.lineageId !== expected.lineageId || fence.base.revision > expected.revision + queuedNow
        || fence.base.revision < expected.revision
      return beyond ? 'diverged' : 'kept'
    }
    const tx = db.transaction(STORE, 'readwrite')
    const completed = done(tx)
    const store = tx.objectStore(STORE)
    const refusedSize = status === 413
    let failures = 0
    let restored: string[] = []
    let removedHead = false
    try {
      const [keys, records, meta] = await Promise.all([
        request(store.getAllKeys(batchRange())),
        request(store.getAll(batchRange())) as Promise<MirrorBatch[]>,
        request(store.get(META_KEY)) as Promise<MirrorMeta | undefined>,
      ])
      const first = records[0]
      if (keys[0] !== headKey || first?.digest !== head.digest || !meta || meta.seq !== first.batch.seq + records.length - 1) {
        tx.abort(); await completed.catch(() => {})
        return 'kept'
      }
      const journals = first.batch.entries.filter(carriesJournal)
      const others = first.batch.entries.filter(entry => !carriesJournal(entry))
      // Only the saves after the head can carry the journal's newer bytes: inside the head, a deletion before the journal
      // came before its write.
      const rest: MirrorBatch[] = records.slice(1)
      if (others.length > 0) {
        // The head keeps its place, seq, id and fence, without the journal (Round 19 and earlier saves carried it).
        const { deferred: _deferred, failures: _failures, ...plain } = first
        const batch: MirrorBatch['batch'] = { ...first.batch, entries: others }
        store.put({ ...plain, batch, digest: sha256HexSync(JSON.stringify(batch)) } satisfies MirrorBatch, keys[0])
      } else {
        removedHead = true
        for (const key of keys) store.delete(key)
        for (const record of records.slice(1)) {
          const seq = record.batch.seq - 1
          const cloudBase = record.batch.cloudBase
          const batch: MirrorBatch['batch'] = { ...record.batch, seq, id: `${record.batch.clientId}:${String(seq)}`,
            ...(cloudBase === undefined ? {} : { cloudBase: { ...cloudBase, revision: cloudBase.revision - 1 } }) }
          store.put({ ...record, batch, digest: sha256HexSync(JSON.stringify(batch)) } satisfies MirrorBatch,
            BATCH_PREFIX + String(seq).padStart(16, '0'))
        }
        store.put({ ...meta, seq: meta.seq - 1 } satisfies MirrorMeta, META_KEY)
      }
      // A later save that already carries this path (newer bytes, or a deletion above it) needs no waiting row.
      const carriedLater = (path: string): boolean => rest.some(record => record.batch.entries.some(([sent, wire]) =>
        sent === path || (wire.kind === 'gone' && path.startsWith(sent + '/'))))
      for (const [path] of journals) {
        const [entry, previous] = await Promise.all([
          request(store.get(path)) as Promise<Entry | undefined>,
          request(store.get(JOURNAL_PREFIX + path)) as Promise<DeferredJournalMarker | undefined>,
        ])
        if (entry?.kind !== 'file' || carriedLater(path)) continue
        failures = Math.max(failures, Math.max(head.failures ?? 0, previous?.failures ?? 0) + 1)
        const marker: DeferredJournalMarker = { kind: 'deferred-journal', path, notBefore: Date.now() + journalRetryMs(failures, refusedSize), failures }
        store.put(marker, JOURNAL_PREFIX + path)
        restored.push(path)
      }
      await completed
    } catch (error) {
      try { tx.abort() } catch {}
      await completed.catch(() => {})
      restored = []
      throw error
    }
    slowDeliveries = 0; slowBatch = null
    if (removedHead) persistence.mirror.pendingBatches = Math.max(0, persistence.mirror.pendingBatches - 1)
    persistence.mirror.deferredJournals = [...new Set([...persistence.mirror.deferredJournals, ...restored])]
    const megabytes = Math.round(recordBytes(head) / 1048576)
    const minutes = Math.round(journalRetryMs(Math.max(failures, 1), refusedSize) / 60_000)
    const note = refusedSize
      ? `MIRROR_JOURNAL_REFUSED: the cloud refused a ${String(megabytes)} MB save carrying her session journal (HTTP 413); the journal `
        + `is kept here, her other saves go on, and it is offered again in ${String(minutes)} min`
      : `MIRROR_JOURNAL_SLOW: a ${String(megabytes)} MB save carrying her session journal did not reach the cloud within its upload `
        + `limit; her other saves go first, and the journal is tried again in ${String(minutes)} min`
    for (const path of restored) noteJournal(path, note)
    if (refusedSize) for (const path of restored) journalAside(path)
    console.warn(`x6-persist: ${note}`)
    return 'aside'
  }
  /**
   * a save queued before the secret-path rule may hold a FILE or DIRECTORY entry for a path that
   * rule matches (a credentials temp copy written between its write and its rename), which the cloud refuses. Once per
   * page, under the outbox lock, each such entry becomes a `gone` for the same path (planSecretScrub): the cloud takes that
   * as an applied no-op, and the save keeps its seq, id and cloud base. A save holding no such entry is never rewritten.
   * Only while the queue as stored is intact (projectedCloudBase: every digest, id, seq and cloud base) and nothing queued
   * has reached the cloud (its fence equals this browser's acknowledged base); otherwise the queue is left exactly as it
   * is, and the drain's own checks judge it. A `gone` matching the rule is never rewritten (the drain sends it as queued).
   * The files are not touched. Returns false when the cloud fence could not be read, so the next drain tries again.
   */
  let outboxScrubbed = false
  const scrubSecretShapedOutbox = async (): Promise<boolean> => {
    const read = async (mode: IDBTransactionMode) => {
      const tx = db.transaction(STORE, mode)
      const completed = done(tx)
      const store = tx.objectStore(STORE)
      const [keys, records, meta] = await Promise.all([
        request(store.getAllKeys(batchRange())), request(store.getAll(batchRange())) as Promise<MirrorBatch[]>,
        request(store.get(META_KEY)) as Promise<MirrorMeta | undefined>,
      ])
      return { tx, completed, store, keys, records, meta }
    }
    /** The plan, only for a queue that is intact as stored; null leaves it unchanged. */
    const planFor = (records: readonly MirrorBatch[], meta: MirrorMeta | undefined): SecretScrubPlan | null => {
      if (!meta) return null
      try { projectedCloudBase(meta, records) } catch { return null }
      return planSecretScrub(records)
    }
    // The Mac host took these paths under the old outbox and has no fence to say what it applied: its queue is never
    // rewritten (a changed save could replay over one it already holds). New ones are not queued (outboxAdmits).
    if (localTransport) return true
    const seen = await read('readonly')
    await seen.completed
    if (planFor(seen.records, seen.meta) === null) return true
    if (fenced) return true
    const fence = await readCloudFence(false)
    if (fence.kind !== 'fence') return false
    if (!seen.meta || !validCloudBase(seen.meta.cloudBase) || !sameCloudBase(fence.base, seen.meta.cloudBase)) return true
    const live = await read('readwrite')
    try {
      const plan = planFor(live.records, live.meta)
      const unchanged = live.meta !== undefined && live.meta.seq === seen.meta.seq && live.records.length === seen.records.length
        && live.keys.length === seen.keys.length && live.records.every((record, index) => record.digest === seen.records[index]?.digest)
      if (plan === null || !unchanged) { live.tx.abort(); await live.completed.catch(() => {}); return true }
      plan.records.forEach((record, index) => {
        const key = live.keys[index]
        if (record !== live.records[index] && key !== undefined) live.store.put(record, key)
      })
      await live.completed
      console.info(`x6-persist: ${String(plan.dropped.length)} queued entries matching the secret-path rule now say only that `
        + 'the path is absent (the cloud takes that as a no-op); no save was renumbered; the files are untouched')
      return true
    } catch (error) {
      try { live.tx.abort() } catch {}
      await live.completed.catch(() => {})
      throw error
    }
  }
  const drain = async (): Promise<void> => {
    if (!deltaUrl) throw new Error('Mirror endpoint is unavailable')
    if (persistence.readOnly) throw new Error('Persistence is read-only')
    if (!outboxScrubbed) outboxScrubbed = await scrubSecretShapedOutbox()
    persistence.mirror.sending = true
    let freedCapacity = false
    let deliveredThisPass = false
    let measured = false
    try {
      for (;;) {
        const tx = db.transaction(STORE, 'readonly')
        const completed = done(tx)
        const store = tx.objectStore(STORE)
        const [cursor, count, usage] = await Promise.all([
          request(store.openCursor(batchRange())),
          request(store.count(batchRange())),
          measured ? Promise.resolve(null) : queuedUsage(store),
        ])
        await completed
        persistence.mirror.pendingBatches = count
        if (capacityRefusalUsage && count < capacityRefusalUsage.count) freedCapacity = true
        if (usage) {
          persistence.mirror.pendingBytes = usage.bytes; measured = true
          if (capacityRefusalUsage && usage.bytes < capacityRefusalUsage.bytes) freedCapacity = true
        }
        if (!cursor) {
          persistence.mirror.pendingBytes = 0
          const checkTx = db.transaction(STORE, 'readonly')
          const checkDone = done(checkTx)
          const unresolved = await request(checkTx.objectStore(STORE).get(RECONCILE_KEY)) as CloudReconciliation | undefined
          await checkDone
          // Any hold is re-sent once the queue is empty and the cloud is in step; a moved cloud fails closed there. Only a
          // pass that delivered something jumps the backoff; otherwise a failing resync keeps its growing wait.
          if (unresolved && !fenced) scheduleResync(deliveredThisPass ? 0 : resyncDelay)
          if (unresolved && mergeCause(unresolved.cause, 'transient') === 'genuine') {
            persistence.mirror.reconciliationRequired = true
            persistence.mirror.conflict ??= 'MIRROR_RECONCILIATION_REQUIRED: local content is durable but has not been published'
            throw new Error(persistence.mirror.conflict)
          }
          if (persistence.mirror.conflict) throw new Error(persistence.mirror.conflict)
          if (unresolved) persistence.mirror.resyncPending = true
          // Every other save is delivered: a waiting session journal may go now, on its own (Round 20).
          else if (await enqueueJournal()) continue
          break
        }
        // A browser in a real conflict sends nothing: re-posting a fenced batch only occupies the cloud's single queue
        // and slows the browser that is in step (Round 19, A28).
        if (!localTransport && fenced) throw new Error(persistence.mirror.conflict ?? 'MIRROR_GLOBAL_FENCE_CONFLICT')
        const record = cursor.value as MirrorBatch
        const { batch, digest } = record
        if (record.kind !== 'mirror-batch' || !batch || batch.id !== `${batch.clientId}:${String(batch.seq)}` || digest !== sha256HexSync(JSON.stringify(batch))) throw new Error('Mirror outbox integrity check failed')
        if (localTransport ? batch.cloudBase !== undefined : !validCloudBase(batch.cloudBase)) throw new Error('MIRROR_GLOBAL_FENCE_REQUIRED: queued batch has a different or unknown protocol; retained unchanged')
        // A `gone` whose only fault is the secret-path rule goes as queued: the cloud takes it as an applied no-op, and a
        // lost-acknowledgement replay of it must keep its original digest.
        if (!localTransport && batch.entries.some(item => !cloudPathAllowed(item[0]) && !secretShapedGone(item))) {
          persistence.mirror.conflict = 'MIRROR_RECONCILIATION_REQUIRED: retained batch contains a forbidden cloud path; nothing transmitted'
          throw new Error(persistence.mirror.conflict)
        }
        const body = JSON.stringify({ v: 2, batch, digest })
        const deadline = localTransport ? 15000 : deliveryDeadlineMs(body.length)
        const response = await timedFetchText(deltaUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, deadline, MAX_ACK_RESPONSE_BYTES)
        if (!response.ok) {
          const detail = `Mirror delivery HTTP ${String(response.status)}: ${response.text.slice(0, 2000)}`
          if (!localTransport) {
            const refusal = deliveryRefusal(response.status, response.text)
            // A save carrying her session journal that the cloud did not take: the journal steps aside, only while the
            // fence shows nothing applied it, so the saves are not held. A fence that cannot be read is a retry, not a refusal.
            if (deliveryNeverApplied(response.status) && record.batch.entries.some(carriesJournal)) {
              const aside = await setJournalAside(cursor.key, record, response.status)
              if (aside === 'aside') continue
              if (aside === 'diverged') {
                await failClosed('MIRROR_GLOBAL_FENCE_CONFLICT: the cloud moved past this browser\'s saves while it could not take her '
                  + 'session journal; queued work is kept for reconciliation')
                throw new Error(detail)
              }
              if (aside === 'unknown') {
                persistence.mirror.transient = unreachable('the cloud fence could not be read after it did not take her session journal')
                throw new Error(detail)
              }
            }
            if (refusal.kind === 'fence' || refusal.kind === 'refused') {
              persistence.mirror.conflict = refusal.kind === 'fence' ? detail
                : `MIRROR_DELIVERY_REFUSED: the cloud refused batch ${String(batch.seq)} (${refusal.code}, HTTP ${String(response.status)}); `
                  + 'it is kept in this browser and not re-sent'
              fenced = true
              persistence.mirror.transient = null
              persistence.mirror.resyncPending = false
            } else if (refusal.kind === 'signed-out') {
              persistence.mirror.transient = 'MIRROR_OWNER_PASS_REQUIRED: sign in again; saves stay in this browser and are sent after'
            } else if (refusal.kind === 'too-slow') {
              slowDeliveries = slowBatch === batch.id ? slowDeliveries + 1 : 1
              slowBatch = batch.id
              persistence.mirror.transient = slowDeliveries >= 3
                ? `MIRROR_DELIVERY_TOO_SLOW: the cloud stops reading an upload after 30 s and batch ${String(batch.seq)} `
                  + `(${String(Math.round(body.length / 1048576))} MB) has not fit through this connection; it is kept and retried`
                : unreachable(`delivery answered ${String(response.status)}`)
            } else persistence.mirror.transient ??= unreachable(`delivery answered ${String(response.status)}`)
          }
          throw new Error(detail)
        }
        const ack = JSON.parse(response.text) as {
          ok?: boolean
          id?: string
          digest?: string
          applied?: number
          protocol?: string
          lineageId?: string
          revision?: number
        }
        if (ack.ok !== true || ack.id !== batch.id || ack.digest !== digest || ack.applied !== batch.entries.length) throw new Error('Mirror acknowledgement does not match the queued batch')
        if (!localTransport && (!validCloudBase(batch.cloudBase) || ack.protocol !== CLOUD_PROTOCOL || !validCloudBase(ack) || ack.lineageId !== batch.cloudBase.lineageId || ack.revision !== batch.cloudBase.revision + 1)) throw new Error('Cloud acknowledgement does not match the immutable queued revision')
        const removeTx = db.transaction(STORE, 'readwrite')
        const removed = done(removeTx)
        const removeStore = removeTx.objectStore(STORE)
        let matches = false
        try {
          const [current, meta] = await Promise.all([
            request(removeStore.get(cursor.key)) as Promise<MirrorBatch | undefined>,
            request(removeStore.get(META_KEY)) as Promise<MirrorMeta | undefined>,
          ])
          matches = current?.digest === digest && current.batch.id === batch.id && JSON.stringify(current.batch) === JSON.stringify(batch)
          if (matches) {
            if (!localTransport) {
              if (!meta || !validCloudBase(meta.cloudBase) || !validCloudBase(batch.cloudBase) || !sameCloudBase(meta.cloudBase, batch.cloudBase) || typeof meta.cloudAcknowledgedSeq !== 'number' || !Number.isSafeInteger(meta.cloudAcknowledgedSeq) || meta.cloudAcknowledgedSeq < 0 || batch.seq !== meta.cloudAcknowledgedSeq + 1 || !Number.isSafeInteger(meta.seq) || meta.seq < batch.seq) throw new Error('MIRROR_GLOBAL_FENCE_CONFLICT: changed durable metadata; outbox retained')
              meta.cloudBase = { lineageId: batch.cloudBase.lineageId, revision: batch.cloudBase.revision + 1 }
              meta.cloudAcknowledgedSeq = batch.seq
              removeStore.put(meta, META_KEY)
            }
            removeStore.delete(cursor.key)
          }
          await removed
        } catch (error) {
          try { removeTx.abort() } catch {}
          await removed.catch(() => {})
          throw error
        }
        if (matches) {
          freedCapacity = true
          deliveredThisPass = true
          persistence.mirror.pendingBytes = Math.max(0, persistence.mirror.pendingBytes - recordBytes(record))
          if (record.deferred === true) {
            // Delivered after all: its note goes, and a name this lane gave it (not a size the cloud can never hold) too.
            const sent = record.batch.entries.map(([path]) => path)
            for (const path of sent) noteJournal(path, null)
            const unnamed = new Set(sent.filter(path => journalNamed.delete(path)))
            persistence.mirror.quarantinedPaths = persistence.mirror.quarantinedPaths.filter(path => !unnamed.has(path))
          }
        }
        persistence.mirror.lastAcknowledgedAt = Date.now()
        persistence.mirror.error = null
        retryMs = 1000
        slowDeliveries = 0; slowBatch = null
        // The cloud answered: a delivery-only outage is over; a boot without a known fence re-checks it.
        if (!localTransport && persistence.mirror.transient !== null && !freshBlocked) {
          if (cloudSnapshot !== null && !persistence.mirror.resyncPending) persistence.mirror.transient = null
          else scheduleResync(0)
        }
      }
    } finally {
      persistence.mirror.sending = false
      // Retry once after an ACK deletion here or a measured reduction from another tab's delivery.
      if (freedCapacity && persistence.localSave.capacity === 'queue-full' && (dirty.size || removed.size)) timer ??= setTimeout(() => { timer = undefined; void flush().catch(() => {}) }, DEBOUNCE_MS)
    }
  }
  const sync = (): Promise<void> => {
    if (pumping) return pumping
    pumping = (async () => {
      try {
        await withOutboxLock(drain)
      } catch (error) {
        persistence.mirror.error = error instanceof Error ? error.message : String(error)
        if (!localTransport && transientError(error)) persistence.mirror.transient ??= unreachable(persistence.mirror.error)
        queuePump(retryMs)
        retryMs = Math.min(retryMs * 2, 60000)
        throw error
      }
    })().finally(() => { pumping = null })
    return pumping
  }
  const outboxAllowed = (path: string): boolean => outboxAdmits(path, localTransport)
  const flushOnce = async (paths: readonly string[], removedPaths: readonly string[]): Promise<void> => {
    if (paths.length === 0 && removedPaths.length === 0) return
    const rootsToClear = removedPaths.filter(path => !removedPaths.some(other => other !== path && path.startsWith(other + '/')))
    const state = new Map<string, Entry>()
    const wire = new Map<string, WireEntry>()
    const journals = new Set<string>()
    const capture = (path: string, recursive = false): void => {
      if (SKIP(path)) return
      if (!vfs.existsSync(path)) {
        state.set(path, { kind: 'gone' }); if (outboxAllowed(path)) wire.set(path, { kind: 'gone' })
      } else {
        const st = vfs.statSync(path) as { isDirectory(): boolean; mode: number; mtimeMs: number }
        if (st.isDirectory()) {
          state.set(path, { kind: 'dir', mode: st.mode & 0o777 })
          if (outboxAllowed(path)) wire.set(path, { kind: 'dir', mode: st.mode & 0o777 })
          if (recursive) for (const child of vfs.readdirSync(path) as unknown as string[]) capture(path + '/' + String(child), true)
        } else {
          const bytes = new Uint8Array(vfs.readFileSync(path) as Uint8Array)
          state.set(path, { kind: 'file', bytes, mode: st.mode & 0o777, mtimeMs: st.mtimeMs })
          // A large session journal is not encoded here: it waits for its own lane, which sends its stored bytes.
          if (outboxAllowed(path) && deferredJournal(path, bytes.byteLength)) journals.add(path)
          else if (outboxAllowed(path)) wire.set(path, { kind: 'file', b64: toB64(bytes), mode: st.mode & 0o777, mtimeMs: st.mtimeMs })
        }
      }
    }
    for (const path of rootsToClear) capture(path, true)
    for (const path of paths) if (!rootsToClear.some(root => path === root || path.startsWith(root + '/'))) capture(path)
    const deletions: Array<[string, WireEntry]> = rootsToClear.filter(outboxAllowed).map(path => [path, { kind: 'gone' }])
    await appendBatch([...state], [...deletions, ...wire], rootsToClear, [...journals])
  }
  const flush = (): Promise<void> => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    const result = chain.then(async () => {
      if (persistence.readOnly) throw new Error('Persistence is read-only')
      if (persistence.conflict || !persistence.durable) throw new Error(persistence.conflict ?? 'Local persistence is not writable')
      const batch = [...dirty]; const removedBatch = [...removed]
      dirty.clear(); removed.clear()
      try {
        await flushOnce(batch, removedBatch)
        persistence.localSave.error = null; persistence.localSave.capacity = null; capacityRefusalUsage = null
      } catch (error) {
        for (const path of batch) dirty.add(path); for (const path of removedBatch) removed.add(path)
        persistence.localSave.error = error instanceof Error ? error.message : String(error)
        persistence.localSave.capacity = error instanceof MirrorCapacityError ? error.refusal : null
        if (persistence.localSave.capacity === 'queue-full') queuePump()
        throw error
      } finally { persistence.localSave.pendingPaths = new Set([...dirty, ...removed]).size }
    })
    chain = result.catch((error) => { console.warn('x6-persist: flush failed; dirty paths retained', error) })
    return result
  }
  // Checkpoint files are ordinary ordered deltas. Never publish a stale whole-VFS bootstrap.
  const uploadSnapshot = async (): Promise<void> => {
    try { await flush() }
    catch (error) {
      if (!(error instanceof MirrorCapacityError) || error.refusal !== 'queue-full') throw error
      await sync(); await flush()
    }
    await sync()
    // An explicit upload sends waiting session journals now, whatever their wait (each pass sends one).
    forcedJournals = new Set()
    try {
      for (let pass = 0; pass < 2 && persistence.mirror.deferredJournals.length > 0; pass += 1) await sync()
    } finally { forcedJournals = null }
    if (persistence.localSave.pendingPaths || persistence.localSave.error) throw new Error('Local changes remain unsaved; keep this tab open and retry after preserving them')
    // An upload is not complete while a session journal still waits (one the cloud did not take, or one too large).
    if (persistence.mirror.deferredJournals.length > 0) {
      const others = persistence.mirror.resyncPending || persistence.mirror.reconciliationRequired || persistence.mirror.conflict !== null
        ? 'her other saves are kept here and held for the resync' : 'everything else is saved and delivered'
      throw new Error(`MIRROR_JOURNAL_PENDING: ${String(persistence.mirror.deferredJournals.length)} session journal(s) not yet delivered`
        + `${persistence.mirror.journalNote === null ? '' : ` (${persistence.mirror.journalNote})`}; ${others}`)
    }
  }

  vfs.subscribe((mutation: VfsMutation) => {
    if (!under(mutation.path, roots) || SKIP(mutation.path) || persistence.readOnly) return
    dirty.add(mutation.path)
    if (mutation.kind === 'remove') removed.add(mutation.path)
    for (const root of tombstoneRoots) if (overlaps(root, mutation.path)) removed.add(root)
    persistence.localSave.pendingPaths = new Set([...dirty, ...removed]).size
    timer ??= setTimeout(() => { timer = undefined; if (current()) void flush().catch(() => {}) }, DEBOUNCE_MS)
  })
  persistence.flush = flush
  persistence.upload = uploadSnapshot
  persistence.sync = sync
  persistence.retryCloudSync = () => retryCloudSync()
  persistence.inspect = async (limit = 64): Promise<Record<string, unknown>> => {
    const cap = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 64, 1), 256)
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    const [batchKeys, batches, meta, reconcile] = await Promise.all([
      request(store.getAllKeys(batchRange())), request(store.getAll(batchRange(), cap)),
      request(store.get(META_KEY)), request(store.get(RECONCILE_KEY)),
    ])
    // Her private tree is reported by existence and count only: never a file name, never bytes.
    const PRIVATE = '/dsh/home/auma/private'
    const shown = (path: string): string => path === PRIVATE || path.startsWith(PRIVATE + '/') ? `${PRIVATE}/[redacted]` : path
    const sorted = (values: Iterable<string>): string[] => [...new Set([...values].map(shown))].sort()
    const listed = (values: Iterable<string>): { count: number; paths: string[]; truncated: boolean } => {
      const all = sorted(values)
      return { count: all.length, paths: all.slice(0, cap), truncated: all.length > cap }
    }
    return {
      available: true,
      queuedBatches: batchKeys.length,
      batches: (batches as MirrorBatch[]).filter(item => isRecord(item) && item.kind === 'mirror-batch').map(item => ({
        seq: item.batch.seq, id: item.batch.id, digest: item.digest, entries: item.batch.entries.length,
        bytes: recordBytes(item),
        paths: item.batch.entries.slice(0, 16).map(([path, entry]) => ({ path: shown(path), kind: entry.kind })),
        pathsTruncated: item.batch.entries.length > 16,
      })),
      batchesTruncated: batchKeys.length > cap,
      meta: isRecord(meta)
        ? { seq: meta.seq, cloudAcknowledgedSeq: meta.cloudAcknowledgedSeq ?? null, cloudBase: meta.cloudBase ?? null }
        : null,
      reconciliation: isRecord(reconcile) ? { firstRevision: reconcile.firstRevision, lastRevision: reconcile.lastRevision, cause: reconcile.cause ?? 'genuine' } : null,
      tombstoneRoots: listed(tombstoneRoots),
      resetRoots: listed(resetRoots),
      pendingLocal: { dirty: listed(dirty), removed: listed(removed) },
      conflict: persistence.conflict,
      mirrorConflict: persistence.mirror.conflict,
    }
  }
  if (!localTransport) {
    const online = (): void => { if (current()) { resyncDelay = resyncFirstMs; scheduleResync(0) } }
    try { (globalThis as { addEventListener?: (type: string, listener: () => void) => void }).addEventListener?.('online', online) } catch {}
    if (persistence.mirror.transient !== null || persistence.mirror.resyncPending) scheduleResync(resyncFirstMs)
  }
  persistence.durable = persistence.conflict === null
  db.onversionchange = () => { persistence.conflict = 'STORAGE_VERSION_CHANGED: this tab retains its VFS but must reload before saving'; persistence.durable = false; db.close() }
  db.onclose = () => { persistence.durable = false; persistence.conflict ??= 'STORAGE_CLOSED: this tab retains its VFS but cannot acknowledge saves' }
  queuePump()
  // Migrate prior durable deletions through the ordered protocol, without publishing a stale full snapshot.
  for (const root of tombstoneRoots) if (!resetRoots.has(root)) { dirty.add(root); removed.add(root) }
  if (dirty.size) void flush().catch(() => {})
  // Resume retained work only. Unchanged image/hydration bytes are not new writes.
  return flush
}
