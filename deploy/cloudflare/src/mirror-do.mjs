/** Ordered v2 mirror transport on Durable Object storage; no filesystem or local-host dependency. */
import { canonicalBootstrap, digest, BOOTSTRAP_LIMITS, readBoundedBootstrapJson, createMirrorUpdate, MIRROR_UPDATE_LIMITS, CLOUD_WAKE_PATHS, CLOUD_WAKE_LIMITS, CLOUD_WAKE_CHECKPOINT_PATH, cloudWakeTextSafe } from './head-do.mjs'
import { canonicalJson } from './owner-grant-policy.mjs'
import { staleHeartbeatFacts } from '../../../server/aura-rules.mjs'
import { verifyFactCheckpoints, projectBuildInfo } from '../../../server/verified-facts.mjs'
import { cloudRepoMirrorPathAllowed, CLOUD_REPO_READ_LIMITS } from './cloud-brokers.mjs'
import { readMirrorReplayState, planMirrorReplayPrune } from './mirror-replay.mjs'
import { PREDICTION_LIMITS, predictionUnavailable, projectPredictionReceipts } from './messages-store.mjs'
import { createEdgeDiagnostics } from './edge-diagnostics.mjs'
import { handleInternalMirrorArchiveRoute } from './cold-archive.mjs'
import { createGateLockoutStore } from './gate-lockout.mjs'
import { CLOUD_WAKE_EVIDENCE_TOOLS } from './wake-evidence.mjs'
import { MIRROR_SECRET_NAMES, MIRROR_SECRET_PREFIXES, MIRROR_SECRET_RULE_VERSION, secretShapedPart } from './mirror-secret-paths.mjs'
import { worldBudgetCall, worldBudgetLimits, worldBudgetInput } from './world-budget.mjs' // ANYBROWSER hook: one world budget row
import { chargeWorldBudgetIn } from './world-budget.mjs' // ANYBROWSER hook: thread lines are charged inside the append's own transaction
import { checkLease, edgeMayWrite, homeFreezeMode, leaseAction, leaseHeldAt, leaseMode, leaseStillNamed, leaseSummary } from './world-lease.mjs' // ANYBROWSER hook: one writer (leaseStillNamed, leaseHeldAt)
import { MIRROR_WAKE_CLIENT_ID, retireClientSlot, retiredClientAnswer, slotRetireMode } from './mirror-client-slots.mjs' // ANYBROWSER hook: slots are tombstoned, never lost (only under MIRROR_SLOT_RETIRE=retire)
import { readTombstone } from './mirror-slot-tombstone.mjs' // ANYBROWSER hook
import { noteWrote, recordHomePending, validHomeInput, worldStatus } from './world-home.mjs' // ANYBROWSER hook: when a browser last wrote; home pending
import { threadCommit, threadLimits } from './thread-log.mjs' // ANYBROWSER hook: the thread log's MIRROR half

const BOOTSTRAP = 'mirror:bootstrap:v1'
// JOIN hook (MUST 2b): the thread ops that write, and the named answer that rolls a committing transaction back.
const THREAD_WRITE_OPS = new Set(['append', 'seal', 'import', 'retract', 'keep']) // JOIN hook
const threadRollback = (status, code) => Object.assign(new Error(code), { threadRollback: { status, body: { ok: false, code } } }) // JOIN hook
const threadAnswerRollback = answer => Object.assign(new Error('THREAD_NOTHING_COMMITTED'), { threadRollback: { status: answer.status, body: answer.body } }) // JOIN hook
const LEASE_EXTENDING_CODES = new Set(['APPLIED', 'IMPORTED', 'RETRACTED', 'KEPT']) // JOIN hook: the thread writes that commit bytes
// JOIN hook: how long a thread step lets waiting home saves go first before it joins the queue anyway.
const THREAD_SAVE_FIRST_MS = 10000 // JOIN hook
const PREFIX = 'mirror:v2:'
const ENTRY = `${PREFIX}entry:`
const RECEIPT = `${PREFIX}receipt:`
const HEAD = `${PREFIX}head:`
const CHUNK = `${PREFIX}chunk:`
const FENCE = `${PREFIX}global-fence`
const RESET = `${PREFIX}reset:`
const SNAPSHOT_FORMAT = 'x61-mirror-snapshot/v2'
const CONFLICT = `${PREFIX}conflict:`
const CONFLICT_CHUNK = `${PREFIX}conflict-chunk:`
const PROTOCOL = 'x61-cloud-mirror/v1'
const PREDICTION_RECEIPTS_PATH = '/dsh/home/auma/seed/receipts.v3.jsonl'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CHUNK_CHARS = 96 * 1024
const encoder = new TextEncoder()
/** Fixed resource ceilings protect DO storage value sizes and bounded snapshot reads. */
export const MIRROR_LIMITS = Object.freeze({ requestBytes: BOOTSTRAP_LIMITS.requestBytes, valueBytes: 120 * 1024, snapshotBytes: 96 * 1024 * 1024, snapshotTimeoutMs: 60000, snapshotReaders: 2, batchEntries: 10000, fileBytes: 24 * 1024 * 1024, entries: 20000, stateBytes: 128 * 1024 * 1024, metadataBytes: 8 * 1024 * 1024, receipts: 4096, clients: 256, conflicts: 128, conflictBytes: 128 * 1024 * 1024 })
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }) }
const size = text => encoder.encode(text).length
const roots = ['/dsh/home', '/dsh/workspace']
/**
 * THE SECRET-PATH RULE (its grammar is in mirror-secret-paths.mjs, which this module re-exports so every
 * edge reader holds one copy). Twin of packages/experimental/webworker-runtime/src/storage/idb-persist.ts
 * `MIRROR_SECRET_NAMES` / `secretShapedPart` (deploy/ may not import packages/); tests/x6/mirror-secret-paths.spec.ts
 * fails when the two differ.
 */
export { MIRROR_SECRET_NAMES, MIRROR_SECRET_PREFIXES, MIRROR_SECRET_RULE_VERSION, MIRROR_SECRET_SUFFIX, secretShapedPart } from './mirror-secret-paths.mjs'
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

// Leave headroom below Durable Object's 128 KiB serialized per-value ceiling.
const putValue = (tx, key, value) => {
  const bytes = value instanceof Uint8Array ? value.byteLength : size(JSON.stringify(value))
  if (bytes > MIRROR_LIMITS.valueBytes) fail('MIRROR_VALUE_TOO_LARGE', 413)
  return tx.put(key, value)
}


/** Return a SHA-256 hex digest of the exact JSON batch representation. */
export async function mirrorDigest(batch) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(batch)))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const validCloudBase = base => base && typeof base === 'object' && typeof base.lineageId === 'string' && UUID.test(base.lineageId) && Number.isSafeInteger(base.revision) && base.revision >= 0
const protocolFields = base => ({ protocol: PROTOCOL, lineageId: base.lineageId, revision: base.revision })
/**
 * The snapshot's entity tag: the fence (lineage and revision) and the representation version.
 * The bytes a snapshot serves depend on the fence AND on the secret-path rule that filters them, so the tag carries the
 * rule's version (`:r<n>`): a validator issued under an older rule (no version, or another one) never gets 304 for bytes
 * filtered differently, and the cloud fence is never advanced to say so.
 */
const snapshotETag = fence => `"x61-mirror-snapshot-v2:${fence.lineageId}:${fence.revision}:r${MIRROR_SECRET_RULE_VERSION}"`
const matchesETag = (header, etag, weak = false) => header?.split(',').some(value => {
  const tag = value.trim()
  return tag === '*' || tag === etag || (weak && tag === `W/${etag}`)
})

// Existing unfenced namespaces require an explicit migration, never silent adoption.
const readFence = async tx => {
  const existing = await tx.get(FENCE)
  if (existing !== undefined) {
    if (!validCloudBase(existing)) fail('MIRROR_GLOBAL_FENCE_CORRUPT', 503)
    return existing
  }
  if ((await tx.list({ limit: 1 })).size) fail('MIRROR_GLOBAL_FENCE_INITIALIZATION_REQUIRED', 409)
  const initial = { lineageId: crypto.randomUUID(), revision: 0 }
  await putValue(tx, FENCE, initial)
  return initial
}

const retainConflict = async (tx, envelope, current, code) => {
  const { batch, digest } = envelope
  const id = await mirrorDigest([batch.id, digest])
  const existing = await tx.get(CONFLICT + id)
  const result = { ok: false, status: 409, code, ...protocolFields(current), currentCloudBase: current, retainedConflict: id }
  if (existing) return result
  const bytes = encoder.encode(JSON.stringify(envelope))
  const retained = await tx.list({ prefix: CONFLICT, limit: MIRROR_LIMITS.conflicts + 1 })
  const total = [...retained.values()].reduce((sum, metadata) => sum + metadata.bytes, 0)
  if (retained.size >= MIRROR_LIMITS.conflicts || total + bytes.length > MIRROR_LIMITS.conflictBytes) {
    return { ...result, status: 507, code: 'MIRROR_CONFLICT_CAPACITY_EXCEEDED', conflictCode: code, retainedConflict: null, error: 'Conflict retention is full. Keep the pending local output; no shared state was changed.' }
  }
  const chunks = Math.ceil(bytes.length / CHUNK_CHARS)
  for (let index = 0; index < chunks; index += 1) await putValue(tx, `${CONFLICT_CHUNK}${id}:${index}`, bytes.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS))
  const cloudBase = validCloudBase(batch.cloudBase) ? { lineageId: batch.cloudBase.lineageId, revision: batch.cloudBase.revision } : null
  await putValue(tx, CONFLICT + id, { id, clientId: batch.clientId, batchId: batch.id, seq: batch.seq, digest, code, cloudBase, observedCloudBase: current, retainedAt: Date.now(), bytes: bytes.length, chunks })
  return result
}

/**
 * A retained conflict envelope may carry a secret-shaped path admitted under the older rule (with its bytes): the
 * download then holds those entries back and says how many. Returns the replacement body, or null when nothing is held.
 */
const withheldConflict = async (storage, id, metadata) => {
  // A cheap pass first, one chunk in memory at a time: every secret-shaped part starts with one of these names, and a
  // retained envelope's only free text is its paths (contents are base64, which has no `.` or `-`, and every name has one).
  // Only when one is found is the envelope parsed; otherwise the caller streams it as it was.
  const needles = [...MIRROR_SECRET_NAMES, ...MIRROR_SECRET_PREFIXES]
  const carry = Math.max(...needles.map(needle => needle.length)) - 1
  let tail = new Uint8Array(0), found = false
  for (let index = 0; index < metadata.chunks && !found; index += 1) {
    const bytes = await storage.get(`${CONFLICT_CHUNK}${id}:${index}`)
    if (!(bytes instanceof Uint8Array)) fail('MIRROR_CONFLICT_CHUNK_MISSING', 503)
    const window = new Uint8Array(tail.length + bytes.length)
    window.set(tail)
    window.set(bytes, tail.length)
    const text = new TextDecoder('utf-8').decode(window)
    found = needles.some(needle => text.includes(needle))
    tail = window.slice(Math.max(0, window.length - carry))
  }
  if (!found) return null
  const parts = []
  for (let index = 0; index < metadata.chunks; index += 1) {
    const bytes = await storage.get(`${CONFLICT_CHUNK}${id}:${index}`)
    if (!(bytes instanceof Uint8Array)) fail('MIRROR_CONFLICT_CHUNK_MISSING', 503)
    parts.push(bytes)
  }
  let envelope
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await new Blob(parts).arrayBuffer())) }
  catch { fail('MIRROR_CONFLICT_CORRUPT', 503) }
  const entries = envelope?.batch?.entries
  if (!Array.isArray(entries)) fail('MIRROR_CONFLICT_CORRUPT', 503)
  const kept = entries.filter(item => !Array.isArray(item) || typeof item[0] !== 'string' || !item[0].split('/').some(secretShapedPart))
  if (kept.length === entries.length) return null
  // `digest` stays the digest of the batch as the browser sent it (it names that batch in its queue); `batch.entries` is
  // redacted, so the download says so beside it.
  const withheldEntries = entries.length - kept.length
  return encoder.encode(JSON.stringify({ ...envelope, batch: { ...envelope.batch, entries: kept }, withheldEntries,
    digestCovers: 'the batch as sent, before the entries matching the secret-path rule were withheld from batch.entries' }))
}

const conflictResponse = async (storage, url) => {
  const clientId = url.searchParams.get('clientId')
  if (!clientId || !UUID.test(clientId)) fail('INVALID_MIRROR_CLIENT')
  const id = url.searchParams.get('id')
  if (!id) {
    const retained = await storage.list({ prefix: CONFLICT, limit: MIRROR_LIMITS.conflicts + 1 })
    return reply({ ok: true, protocol: PROTOCOL, conflicts: [...retained.values()].filter(item => item.clientId === clientId).map(({ chunks, ...metadata }) => metadata) })
  }
  if (!/^[0-9a-f]{64}$/.test(id)) fail('INVALID_MIRROR_CONFLICT')
  const metadata = await storage.get(CONFLICT + id)
  if (!metadata || metadata.clientId !== clientId) fail('MIRROR_CONFLICT_NOT_FOUND', 404)
  const withheld = await withheldConflict(storage, id, metadata)
  if (withheld) return new Response(withheld, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="mirror-conflict-${id}.json"` } })
  const stream = new TransformStream()
  const writer = stream.writable.getWriter()
  const timeout = setTimeout(() => { void writer.abort(new Error('MIRROR_CONFLICT_DOWNLOAD_TIMEOUT')).catch(() => {}) }, 60000)
  const completion = (async () => {
    try {
      for (let index = 0; index < metadata.chunks; index += 1) {
        const bytes = await storage.get(`${CONFLICT_CHUNK}${id}:${index}`)
        if (!(bytes instanceof Uint8Array)) fail('MIRROR_CONFLICT_CHUNK_MISSING', 503)
        await writer.write(bytes)
      }
      await writer.close()
    } catch (error) { await writer.abort(error).catch(() => {}); throw error }
    finally { clearTimeout(timeout) }
  })()
  completion.catch(() => {})
  const response = new Response(stream.readable, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="mirror-conflict-${id}.json"` } })
  response.mirrorCompletion = completion
  return response
}

const SNAPSHOT_ROOT = '/dsh/home/auma/snapshots'
const SNAPSHOT_LATEST = `${SNAPSHOT_ROOT}/LATEST.json`

/** Redundant VFS dumps under the snapshot root. The directory and LATEST.json stay. */
const snapshotDumpExcluded = path => path.startsWith(`${SNAPSHOT_ROOT}/`) && path !== SNAPSHOT_LATEST

/** Cloud mirror and seed exclusions, including local conflict backups; malformed non-private paths fail. */
export const mirrorPathExcluded = path => typeof path === 'string' && (
  path === '/dsh/home/balls' || path.startsWith('/dsh/home/balls/') ||
  snapshotDumpExcluded(path) ||
  path.split('/').some(part => secretShapedPart(part) || part === '.DS_Store' || part === '.conflict-backup')
)

/**
 * A stored row whose path is well formed but excluded (a secret-shaped name admitted under an older, narrower rule) is
 * never served and never counted: every read skips it. It stays in storage untouched until an owner-approved purge.
 * A malformed path still fails closed.
 */
// The original path is judged as it is: its syntax first, then every exclusion other than the secret-path rule.
// No part is replaced before the check, so an invalid character or an over-long part is never erased, and a valid path
// near the length limit is never pushed over it.
export const hiddenStoredPath = path => mirrorPathSyntaxValid(path) && path.split('/').some(secretShapedPart)
  && !(path === '/dsh/home/balls' || path.startsWith('/dsh/home/balls/') || snapshotDumpExcluded(path)
    || path.split('/').some(part => part === '.DS_Store' || part === '.conflict-backup'))

/** A canonical VFS path under a mirror root: bounded, no control characters, no empty, `.` or `..` part. */
const mirrorPathSyntaxValid = path => {
  if (typeof path !== 'string' || size(path) > 4096 || /[\\\0-\x1f\x7f]/.test(path)) return false
  const parts = path.split('/')
  if (parts[0] !== '' || parts.slice(1).some(part => !part || part === '.' || part === '..' || size(part) > 255)) return false
  return roots.some(root => path.startsWith(root + '/'))
}

/** Validate canonical VFS paths, excluding roots, credentials and immutable ball ancestors. */
export function validateMirrorPath(path) {
  if (!mirrorPathSyntaxValid(path) || mirrorPathExcluded(path)) fail('INVALID_MIRROR_PATH')
  return path
}

/** Validate untrusted entries and return minimal wire values with no unknown fields. */
export function validateMirrorEntries(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MIRROR_LIMITS.batchEntries) fail('INVALID_MIRROR_ENTRIES')
  return entries.map(item => {
    if (!Array.isArray(item) || item.length !== 2) fail('INVALID_MIRROR_ENTRY')
    const path = validateMirrorPath(item[0])
    const wire = item[1]
    if (!wire || typeof wire !== 'object' || !['gone', 'dir', 'file'].includes(wire.kind)) fail('INVALID_MIRROR_ENTRY')
    if (wire.kind === 'gone') return [path, { kind: 'gone' }]
    if (!Number.isInteger(wire.mode) || wire.mode < 0 || wire.mode > 0o777) fail('INVALID_MIRROR_MODE')
    if (wire.kind === 'dir') return [path, { kind: 'dir', mode: wire.mode }]
    if (typeof wire.b64 !== 'string' || !Number.isFinite(wire.mtimeMs) || wire.mtimeMs < 0 || !Number.isFinite(new Date(wire.mtimeMs).getTime())) fail('INVALID_MIRROR_FILE')
    if (wire.b64.length > Math.ceil(MIRROR_LIMITS.fileBytes / 3) * 4) fail('MIRROR_FILE_TOO_LARGE', 413)
    // Flat character classes avoid recursive-regexp stack exhaustion on multi-MiB files.
    if (wire.b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(wire.b64)) fail('INVALID_MIRROR_FILE')
    const padding = wire.b64.endsWith('==') ? 2 : wire.b64.endsWith('=') ? 1 : 0
    const decodedBytes = wire.b64.length / 4 * 3 - padding
    if (decodedBytes > MIRROR_LIMITS.fileBytes) fail('MIRROR_FILE_TOO_LARGE', 413)
    // Alphabet, quartet length and final padding bits prove canonical base64
    // without allocating a second decoded copy of a file at the fileBytes ceiling.
    if (padding && btoa(atob(wire.b64.slice(-4))) !== wire.b64.slice(-4)) fail('INVALID_MIRROR_FILE')
    return [path, { kind: 'file', mode: wire.mode, b64: wire.b64, mtimeMs: wire.mtimeMs }]
  })
}

/**
 * AN OLD QUEUED SAVE IS NEVER REFUSED FOR A SECRET TEMP MARKER. Before the secret-shaped rule,
 * every page boot queued `[[…/.credentials.yaml.<hex>.tmp, gone], [….credentials.yaml.lock, gone]]`; such a save may
 * still sit in a browser that loaded the older page. A 400 on it would stop that browser's saves for good, so a `gone`
 * entry for a well-formed secret-shaped path (hiddenStoredPath) is an applied no-op: nothing is written, no deletion
 * marker is kept, and the rest of the batch applies. A FILE or DIRECTORY entry for such a path is still refused.
 * @param {unknown} entries - the batch's entries as sent.
 * @returns {Array} the validated entries that change the mirror (possibly none).
 */
export function publishableMirrorEntries(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MIRROR_LIMITS.batchEntries) fail('INVALID_MIRROR_ENTRIES')
  const inert = item => Array.isArray(item) && item.length === 2 && hiddenStoredPath(item[0])
    && item[1] !== null && typeof item[1] === 'object' && item[1].kind === 'gone'
  const kept = entries.filter(item => !inert(item))
  return kept.length ? validateMirrorEntries(kept) : []
}

// Resets survive recreation so packaged descendants cannot reappear in a fresh browser.
const compactResets = paths => new Set([...paths].filter(path => {
  for (let parent = path.slice(0, path.lastIndexOf('/')); parent; parent = parent.slice(0, parent.lastIndexOf('/'))) {
    if (paths.has(parent)) return false
  }
  return true
}))

// Internal chunk counters add at most 32 bytes per file. Budget the same wire
// metadata before and after persistence, including namespaces admitted earlier.
const entryMetadataBytes = (path, value) => {
  const { b64, chunks, bytes, ...metadata } = value
  return size(JSON.stringify([path, metadata]))
}

/**
 * Plan a batch over the current inventory. `importing` is the seed import of a complete inventory the mirror itself held
 * (a restore): a read-only directory may already hold children there, because its mode is the final one, applied after
 * its children existed. Every live write keeps the parent-writable rule.
 */
function planMirrorEntries(current, entries, priorResets = [], { importing = false, hiddenRows = 0 } = {}) {
  const next = new Map(current)
  const requestedResets = new Set(priorResets)
  for (const [path, wire] of entries) {
    const segments = path.split('/')
    for (let length = 3; length < segments.length; length += 1) {
      const parent = segments.slice(0, length).join('/')
      const previous = next.get(parent)
      if (previous && previous.kind !== 'dir') fail('MIRROR_PARENT_NOT_DIRECTORY')
      if (previous && !importing && (previous.mode & 0o300) !== 0o300) fail('MIRROR_PARENT_NOT_WRITABLE')
      if (!previous && wire.kind !== 'gone' && !roots.includes(parent)) next.set(parent, { kind: 'dir', mode: 0o755 })
    }
    if (wire.kind === 'gone' || (next.has(path) && next.get(path).kind !== wire.kind)) {
      requestedResets.add(path)
      for (const key of next.keys()) if (key === path || key.startsWith(path + '/')) next.delete(key)
    }
    if (wire.kind !== 'gone') next.set(path, wire)
  }
  const resets = compactResets(requestedResets)
  const metadataBytes = [...next].reduce((total, [path, value]) => total + entryMetadataBytes(path, value), 0)
  if (metadataBytes + size(JSON.stringify([...resets])) > MIRROR_LIMITS.metadataBytes) fail('MIRROR_METADATA_LIMIT', 413)
  if (next.size + resets.size + hiddenRows > MIRROR_LIMITS.entries || [...next.values()].reduce((total, wire) => total + (wire.bytes ?? (wire.b64 ? Math.floor(wire.b64.length / 4) * 3 - (wire.b64.endsWith('==') ? 2 : wire.b64.endsWith('=') ? 1 : 0) : 0)), 0) > MIRROR_LIMITS.stateBytes) fail('MIRROR_STORAGE_LIMIT', 413)
  return { entries: next, resets }
}

/** Pure ordered VFS simulation; a rejected batch has no partial effects. */
export function applyMirrorEntries(current, entries) {
  return planMirrorEntries(current, entries).entries
}

// `hidden`, when given, adds the stored rows each read skipped (hiddenStoredPath): they are not served, but they still
// occupy storage, so every write counts them toward the combined row limit (planMirrorEntries `hiddenRows`).
const readResets = async (storage, hidden) => {
  const rows = await storage.list({ prefix: RESET, limit: MIRROR_LIMITS.entries + 1 })
  if (rows.size > MIRROR_LIMITS.entries) fail('MIRROR_STORAGE_LIMIT', 503)
  const paths = [...rows.values()].filter(path => !hiddenStoredPath(path))
  if (hidden) hidden.rows += rows.size - paths.length
  for (const path of paths) validateMirrorPath(path)
  return paths.sort()
}

// Metadata is bounded independently of payload bytes. No mutation reads file content.
const readEntries = async (storage, hidden) => {
  const rows = await storage.list({ prefix: ENTRY, limit: MIRROR_LIMITS.entries + 1 })
  if (rows.size > MIRROR_LIMITS.entries) fail('MIRROR_STORAGE_LIMIT', 503)
  let metadataBytes = 0
  const kept = [...rows.values()].filter(row => !hiddenStoredPath(row?.path))
  if (hidden) hidden.rows += rows.size - kept.length
  return new Map(kept.map(({ path, ...value }) => {
    // Payload belongs only in chunk rows; wire input is never valid persisted metadata.
    validateMirrorPath(path)
    metadataBytes += entryMetadataBytes(path, value)
    if (metadataBytes > MIRROR_LIMITS.metadataBytes) fail('MIRROR_METADATA_LIMIT', 503)
    if (Object.hasOwn(value, 'b64') || !['file', 'dir'].includes(value.kind) || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777) fail('MIRROR_ENTRY_METADATA_CORRUPT', 503)
    if (value.kind === 'file') {
      fileCharacters(value)
      if (!Number.isFinite(value.mtimeMs) || value.mtimeMs < 0 || !Number.isFinite(new Date(value.mtimeMs).getTime())) fail('MIRROR_FILE_METADATA_CORRUPT', 503)
    } else if (value.chunks !== undefined || value.bytes !== undefined || value.mtimeMs !== undefined) fail('MIRROR_ENTRY_METADATA_CORRUPT', 503)
    return [path, value]
  }))
}
const pathKey = path => mirrorDigest(path)
const removeChunks = async (tx, id, value) => {
  for (let index = 0; index < (value?.chunks ?? 0); index += 1) await tx.delete(`${CHUNK}${id}:${index}`)
}
const storeEntry = async (tx, path, value, previous) => {
  const id = await pathKey(path)
  await removeChunks(tx, id, previous)
  if (value.kind === 'dir') return putValue(tx, ENTRY + id, { path, ...value })
  const { b64, ...metadata } = value
  const chunks = Math.ceil(b64.length / CHUNK_CHARS)
  for (let index = 0; index < chunks; index += 1) await putValue(tx, `${CHUNK}${id}:${index}`, b64.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS))
  const bytes = b64.length / 4 * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
  await putValue(tx, ENTRY + id, { path, ...metadata, chunks, bytes })
}

const snapshotPrefix = (fence, resetPaths) =>
  JSON.stringify({ ok: true, ...protocolFields(fence), snapshotFormat: SNAPSHOT_FORMAT, resetPaths }).slice(0, -1) + ',"entries":['

const fileCharacters = value => {
  if (typeof value.b64 === 'string') return value.b64.length
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MIRROR_LIMITS.fileBytes) fail('MIRROR_FILE_METADATA_CORRUPT', 503)
  const characters = Math.ceil(value.bytes / 3) * 4
  if (value.chunks !== Math.ceil(characters / CHUNK_CHARS)) fail('MIRROR_FILE_METADATA_CORRUPT', 503)
  return characters
}

const storedChunk = async (tx, id, metadata, index) => {
  const characters = fileCharacters(metadata), chunk = await tx.get(`${CHUNK}${id}:${index}`)
  const padding = index === metadata.chunks - 1 ? (3 - metadata.bytes % 3) % 3 : 0
  if (typeof chunk !== 'string' || chunk.length !== Math.min(CHUNK_CHARS, characters - index * CHUNK_CHARS)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk) || chunk.length - chunk.replace(/=+$/, '').length !== padding
    || (padding && btoa(atob(chunk.slice(-4))) !== chunk.slice(-4))) fail('MIRROR_FILE_CHUNK_CORRUPT', 503)
  return chunk
}

/** Canonical journals preserve their exact byte prefixes; existing content-addressed DAG nodes are immutable. */
const protectedHistory = path => path === CLOUD_WAKE_CHECKPOINT_PATH || /^\/dsh\/home\/auma\/seed\/(receipts\.v3|checkpoints\.v1)\.jsonl$/.test(path) ? 'append'
  : /^\/dsh\/home\/auma\/memory\/dag\/(nodes\/)?[a-f0-9]{64}\.json$/.test(path) ? 'immutable' : null

async function enforceHistoryPrefixes(tx, before, after) {
  for (const [path, previous] of before) {
    const policy = protectedHistory(path)
    if (!policy) continue
    const next = after.get(path)
    if (next === previous) continue
    if (previous.kind !== 'file' || !next || next.kind !== 'file' || typeof next.b64 !== 'string') fail('MIRROR_HISTORY_APPEND_ONLY', 409)
    const nextBytes = next.b64.length / 4 * 3 - (next.b64.endsWith('==') ? 2 : next.b64.endsWith('=') ? 1 : 0)
    if (nextBytes < previous.bytes || (policy === 'immutable' && nextBytes !== previous.bytes)) fail('MIRROR_HISTORY_APPEND_ONLY', 409)
    const id = await pathKey(path), fullCharacters = Math.floor(previous.bytes / 3) * 4
    for (let index = 0; index < previous.chunks; index++) {
      const chunk = await storedChunk(tx, id, previous, index), offset = index * CHUNK_CHARS
      const common = Math.max(0, Math.min(chunk.length, fullCharacters - offset))
      if (chunk.slice(0, common) !== next.b64.slice(offset, offset + common)) fail('MIRROR_HISTORY_APPEND_ONLY', 409)
      if (index === previous.chunks - 1 && previous.bytes % 3
        && !atob(next.b64.slice(fullCharacters, fullCharacters + 4)).startsWith(atob(chunk.slice(common)))) fail('MIRROR_HISTORY_APPEND_ONLY', 409)
    }
  }
}

async function wakeFileText(tx, path, limit) {
  const id = await pathKey(path), metadata = await tx.get(ENTRY + id)
  if (metadata === undefined) return null
  if (!auraObject(metadata) || metadata.path !== path || metadata.kind !== 'file' || Object.hasOwn(metadata, 'b64')
    || !Number.isInteger(metadata.mode) || metadata.mode < 0 || metadata.mode > 0o777
    || !Number.isFinite(metadata.mtimeMs) || metadata.mtimeMs < 0) fail('MIRROR_WAKE_FILE_INVALID', 503)
  fileCharacters(metadata)
  if (metadata.bytes > limit) fail('MIRROR_WAKE_FILE_LIMIT', 413)
  let b64 = ''
  for (let index = 0; index < metadata.chunks; index++) b64 += await storedChunk(tx, id, metadata, index)
  const binary = atob(b64)
  if (binary.length !== metadata.bytes) fail('MIRROR_WAKE_FILE_INVALID', 503)
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
}

async function wakeFence(tx, seedId) {
  const bootstrap = await tx.get(BOOTSTRAP), fence = await tx.get(FENCE)
  if (bootstrap?.phase !== 'ready' || bootstrap.seedId !== seedId || !auraHash(seedId)) fail('BOOTSTRAP_REQUIRED', 503)
  if (!validCloudBase(fence) || fence.lineageId !== bootstrap.lineageId || fence.revision < 1) fail('MIRROR_GLOBAL_FENCE_CORRUPT', 503)
  return fence
}

/** Read only finite continuity paths. Oversized, malformed, or credential-shaped files fail closed. */
export async function readMirrorWakeText(storage, { path, seedId, signal, env = {} } = {}) {
  if (!CLOUD_WAKE_PATHS.includes(path)) fail('MIRROR_WAKE_PATH_REFUSED', 403)
  return storage.transaction(async tx => {
    signal?.throwIfAborted()
    const fence = await wakeFence(tx, seedId)
    const text = await wakeFileText(tx, path, CLOUD_WAKE_LIMITS.textBytes)
    signal?.throwIfAborted()
    if (text === null) return { ok: false, code: 'MIRROR_WAKE_FILE_ABSENT' }
    if (!cloudWakeTextSafe(text, env)) fail('MIRROR_WAKE_TEXT_REFUSED', 403)
    return { ok: true, path, text, revision: fence.revision }
  })
}

/** Append only host-generated checkpoint metadata to a fixed bounded file; no arbitrary payload or path.
 * Atomic fence advancement makes concurrent browser batches stale, not silently overwritten.
 * Checkpoint ids are retained in the file for replay refusal; capacity exhaustion never evicts history.
 */
export async function appendMirrorWakeCheckpoint(storage, input, { seedId, signal, now = Date.now() /* ANYBROWSER hook */, mode /* JOIN hook */, slots /* JOIN hook */ } = {}) {
  if (!auraObject(input) || Object.keys(input).sort().join(',') !== 'at,evidence,head,id'
    || !auraHash(input.id) || !Number.isSafeInteger(input.at) || input.at < 0 || input.at > 8640000000000000
    || !auraObject(input.head) || Object.keys(input.head).sort().join(',') !== 'ballId,epoch' || !auraHash(input.head.ballId) || !auraCount(input.head.epoch)
    || !Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > CLOUD_WAKE_LIMITS.calls
    || input.evidence.some(row => !auraObject(row) || Object.keys(row).sort().join(',') !== 'digest,tool'
      || !CLOUD_WAKE_EVIDENCE_TOOLS.includes(row.tool) || !auraHash(row.digest))) fail('MIRROR_WAKE_CHECKPOINT_INVALID')
  return storage.transaction(async tx => {
    signal?.throwIfAborted()
    const fence = await wakeFence(tx, seedId)
    if (fence.revision === Number.MAX_SAFE_INTEGER) fail('MIRROR_GLOBAL_REVISION_LIMIT', 507)
    const text = await wakeFileText(tx, CLOUD_WAKE_CHECKPOINT_PATH, 65536) ?? ''
    if (text && !text.endsWith('\n')) fail('MIRROR_WAKE_CHECKPOINT_CORRUPT', 503)
    const rows = text ? text.slice(0, -1).split('\n').map(line => JSON.parse(line)) : []
    if (rows.length > 128 || rows.some(row => !auraObject(row) || row.schema !== 'aukora.cloud-wake-checkpoint.v1' || !auraHash(row.id))) fail('MIRROR_WAKE_CHECKPOINT_CORRUPT', 503)
    const payload = { schema: 'aukora.cloud-wake-checkpoint.v1', ...input }
    const previous = rows.find(row => row.id === input.id)
    if (previous) {
      if (canonicalJson(previous) !== canonicalJson(payload)) fail('MIRROR_WAKE_CHECKPOINT_CONFLICT', 409)
      return { ok: true, id: input.id, revision: fence.revision, replayed: true }
    }
    // ANYBROWSER hook: the cloud wake yields to her live browser: nothing is written while a lease is live (HEAD hands
    // ANYBROWSER hook: its model CLOUD_WAKE_CHECKPOINT_UNAVAILABLE and the wake step goes on without this checkpoint).
    // JOIN hook: only under WRITER_LEASE=enforce; in the default mode a lease is recorded, never enforced (main's answer).
    if (mode === 'enforce' && !(await edgeMayWrite(tx, now))) return { ok: false, code: 'MIRROR_WAKE_WRITER_LIVE', yielded: true } // ANYBROWSER hook
    const nextText = text + JSON.stringify(payload) + '\n'
    if (rows.length >= 128 || size(nextText) > 65536) fail('MIRROR_WAKE_CHECKPOINT_FULL', 507)
    // Use the existing ordered ACK protocol so the next browser publish can validate the fence.
    const replay = await readMirrorReplayState(tx, fence)
    const clientId = MIRROR_WAKE_CLIENT_ID // ANYBROWSER hook: the one exported constant (was this same id as a literal)
    // JOIN hook: the tombstone is read only when slots can be retired (MIRROR_SLOT_RETIRE=retire) or the lease is enforced;
    // JOIN hook: by default this is main's checkpoint exactly (no row of wave 3 is read).
    const wakeSlot = mode === 'enforce' || slots === 'retire' ? await readTombstone(tx, clientId) : null // ANYBROWSER hook: a tombstoned wake id is refused, never revived
    if (wakeSlot) fail(wakeSlot.corrupt ? 'SLOT_TOMBSTONE_UNAVAILABLE' : 'CLIENT_SLOT_RETIRED', wakeSlot.corrupt ? 503 : 409) // ANYBROWSER hook
    const client = replay.clients.get(clientId)
    if (!client && replay.clients.size >= MIRROR_LIMITS.clients) fail('MIRROR_CLIENT_LIMIT', 507)
    const seq = (client?.seq ?? 0) + 1, receiptDigest = await mirrorDigest(payload)
    const prune = planMirrorReplayPrune(replay, clientId)
    const hidden = { rows: 0 }
    const before = await readEntries(tx, hidden), resets = await readResets(tx, hidden)
    const bytes = encoder.encode(nextText)
    const value = { kind: 'file', mode: 0o600, mtimeMs: input.at, b64: btoa(String.fromCharCode(...bytes)) }
    const { entries: after } = planMirrorEntries(before, [[CLOUD_WAKE_CHECKPOINT_PATH, value]], resets, { hiddenRows: hidden.rows })
    const nextFence = { lineageId: fence.lineageId, revision: fence.revision + 1 }
    snapshotBytes(after, resets, nextFence)
    signal?.throwIfAborted()
    for (const [path, entry] of after) if (JSON.stringify(before.get(path)) !== JSON.stringify(entry)) await storeEntry(tx, path, entry, before.get(path))
    signal?.throwIfAborted()
    await putValue(tx, FENCE, nextFence)
    for (const key of prune) await tx.delete(key)
    await putValue(tx, RECEIPT + `${clientId}:${seq}`, { ok: true, ...protocolFields(nextFence), id: `${clientId}:${seq}`,
      clientId, seq, digest: receiptDigest, applied: 1, acknowledgedAt: input.at })
    await putValue(tx, HEAD + clientId, { seq, digest: receiptDigest })
    return { ok: true, id: input.id, revision: nextFence.revision, replayed: false }
  })
}

/** Read one allowlisted file coherently, never listing or initializing the namespace.
 * @param {object} storage Durable Object storage.
 * @param {object} options Canonical VFS path, matching bootstrap seed and optional cancellation signal.
 * @returns {Promise<object>} At most 256 KiB decoded file bytes in base64, directory, absence, or durable deletion. Only absence permits fallback.
 */
export async function readMirrorRepoFile(storage, { path, seedId, signal } = {}) {
  validateMirrorPath(path)
  if (!cloudRepoMirrorPathAllowed(path)) fail('MIRROR_REPO_PATH_REFUSED', 403)
  return storage.transaction(async tx => {
    const check = () => { signal?.throwIfAborted() }
    check()
    const bootstrap = await tx.get(BOOTSTRAP), fence = await tx.get(FENCE)
    if (bootstrap?.phase !== 'ready' || bootstrap.seedId !== seedId || !auraHash(seedId)) fail('BOOTSTRAP_REQUIRED', 503)
    if (!validCloudBase(fence) || fence.lineageId !== bootstrap.lineageId || fence.revision < 1) fail('MIRROR_GLOBAL_FENCE_CORRUPT', 503)
    const result = { ok: true, path, lineageId: fence.lineageId, revision: fence.revision }
    const id = await pathKey(path), metadata = await tx.get(ENTRY + id)
    if (metadata !== undefined) {
      if (!auraObject(metadata) || metadata.path !== path || !['file', 'dir'].includes(metadata.kind)
        || Object.hasOwn(metadata, 'b64') || !Number.isInteger(metadata.mode) || metadata.mode < 0 || metadata.mode > 0o777) fail('MIRROR_ENTRY_METADATA_CORRUPT', 503)
      if (metadata.kind === 'dir') return { ...result, kind: 'dir' }
      fileCharacters(metadata)
      if (metadata.bytes > CLOUD_REPO_READ_LIMITS.fileBytes) fail('MIRROR_REPO_FILE_TOO_LARGE', 413)
      if (!Number.isFinite(metadata.mtimeMs) || metadata.mtimeMs < 0) fail('MIRROR_FILE_METADATA_CORRUPT', 503)
      let b64 = ''
      for (let index = 0; index < metadata.chunks; index++) { check(); b64 += await storedChunk(tx, id, metadata, index) }
      check()
      return { ...result, kind: 'file', b64 }
    }
    // A recreated entry wins over its historical ancestor reset; an absent descendant never resurrects packaged bytes.
    for (let ancestor = path; ancestor; ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'))) {
      check()
      const reset = await tx.get(RESET + await pathKey(ancestor))
      if (reset !== undefined) {
        if (reset !== ancestor) fail('MIRROR_RESET_CORRUPT', 503)
        return { ...result, kind: 'gone' }
      }
    }
    return { ...result, kind: 'missing' }
  })
}

// Account for the exact UTF-8 JSON wire size without assembling file contents.
/**
 * THE MIRROR'S OWN SIZE ACCOUNTING, in two parts, so a restore's no-write preflight can apply exactly what the import
 * enforces: the export's opening and closing bytes (fence and deletion markers included), and one entry's bytes (its
 * metadata as JSON plus its base64 characters). The separating comma is added by the caller for every entry but the first.
 */
export const RESTORED_FENCE = Object.freeze({ lineageId: '00000000-0000-4000-8000-000000000000', revision: 1 })
export const mirrorSnapshotPrefixBytes = (resetPaths, fence = RESTORED_FENCE) => size(snapshotPrefix(fence, resetPaths)) + 2
export const mirrorSnapshotEntryBytes = (path, wire, characters) => size(JSON.stringify([path, wire])) + characters

const snapshotBytes = (entries, resetPaths, fence) => {
  if (entries.size + resetPaths.length > MIRROR_LIMITS.entries) fail('MIRROR_STORAGE_LIMIT', 503)
  let bytes = mirrorSnapshotPrefixBytes(resetPaths, fence)
  let count = 0
  for (const [path, value] of entries) {
    validateMirrorPath(path)
    if (!value || !['file', 'dir'].includes(value.kind) || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777) fail('MIRROR_ENTRY_METADATA_CORRUPT', 503)
    const wire = { kind: value.kind, mode: value.mode }
    let characters = 0
    if (value.kind === 'file') {
      if (!Number.isFinite(value.mtimeMs) || value.mtimeMs < 0 || !Number.isFinite(new Date(value.mtimeMs).getTime())) fail('MIRROR_FILE_METADATA_CORRUPT', 503)
      wire.mtimeMs = value.mtimeMs
      wire.b64 = ''
      characters = fileCharacters(value)
    }
    bytes += mirrorSnapshotEntryBytes(path, wire, characters) + (count++ ? 1 : 0)
    if (bytes > MIRROR_LIMITS.snapshotBytes) fail('MIRROR_SNAPSHOT_TOO_LARGE', 413)
  }
  if (bytes > MIRROR_LIMITS.snapshotBytes) fail('MIRROR_SNAPSHOT_TOO_LARGE', 413)
  return bytes
}

// Metadata and tombstones select one revision. Each chunk read checks that same
// revision inside its transaction; a concurrent write truncates, never tears, JSON.
const snapshotResponse = async (storage, request, reserveSnapshot) => {
  const format = new URL(request.url).searchParams.get('snapshotFormat')
  const captured = await storage.transaction(async tx => {
    const fence = await readFence(tx)
    const etag = snapshotETag(fence)
    if (request.headers.has('if-match') && !matchesETag(request.headers.get('if-match'), etag)) fail('MIRROR_SNAPSHOT_PRECONDITION_FAILED', 412)
    const resetPaths = await readResets(tx)
    // Older readers ignore reset metadata and would resurrect packaged files.
    if (resetPaths.length && format !== SNAPSHOT_FORMAT) fail('MIRROR_SNAPSHOT_UPGRADE_REQUIRED', 409)
    if (matchesETag(request.headers.get('if-none-match'), etag, true)) return { etag, unchanged: true }
    const stored = await readEntries(tx)
    const expectedBytes = snapshotBytes(stored, resetPaths, fence)
    return { fence, etag, resetPaths, stored, expectedBytes }
  })
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'etag': captured.etag }
  if (captured.unchanged) return new Response(null, { status: 304, headers })
  const release = reserveSnapshot?.() ?? (() => {})
  const { fence, resetPaths, stored, expectedBytes } = captured
  const entries = [...stored].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  let writtenBytes = 0
  const encode = text => {
    const bytes = encoder.encode(text)
    writtenBytes += bytes.length
    if (writtenBytes > expectedBytes || writtenBytes > MIRROR_LIMITS.snapshotBytes) fail('MIRROR_SNAPSHOT_SIZE_CHANGED', 503)
    return bytes
  }
  const checkFence = async tx => {
    const current = await tx.get(FENCE)
    if (!validCloudBase(current) || current.lineageId !== fence.lineageId || current.revision !== fence.revision) fail('MIRROR_SNAPSHOT_CHANGED', 409)
  }
  const pieces = (async function* () {
    yield encode(snapshotPrefix(fence, resetPaths))
    for (let index = 0; index < entries.length; index += 1) {
      const [path, value] = entries[index]
      yield encode((index ? ',' : '') + '[' + JSON.stringify(path) + ',')
      if (value.kind === 'dir') yield encode(JSON.stringify({ kind: 'dir', mode: value.mode }))
      else {
        yield encode('{"kind":"file","mode":' + value.mode + ',"mtimeMs":' + value.mtimeMs + ',"b64":"')
        const id = await pathKey(path)
        const characters = fileCharacters(value)
        for (let chunk = 0; chunk < value.chunks; chunk += 1) {
          const content = await storage.transaction(async tx => {
            await checkFence(tx)
            const content = await tx.get(`${CHUNK}${id}:${chunk}`)
            const expectedLength = Math.min(CHUNK_CHARS, characters - chunk * CHUNK_CHARS)
            const padding = chunk === value.chunks - 1 ? (3 - value.bytes % 3) % 3 : 0
            if (typeof content !== 'string' || content.length !== expectedLength || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length - content.replace(/=+$/, '').length !== padding) fail('MIRROR_CHUNK_CORRUPT', 503)
            if (padding && btoa(atob(content.slice(-4))) !== content.slice(-4)) fail('MIRROR_CHUNK_CORRUPT', 503)
            return content
          })
          yield encode(content)
        }
        yield encode('"}')
      }
      yield encode(']')
    }
    await storage.transaction(checkFence)
    const closing = encode(']}')
    if (writtenBytes !== expectedBytes) fail('MIRROR_SNAPSHOT_SIZE_CHANGED', 503)
    yield closing
  })()
  let stopped = false, pending = Promise.resolve(), timer, controller
  let resolveCompletion, rejectCompletion
  const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject })
  const finish = error => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    request.signal.removeEventListener('abort', abort)
    // A platform storage read cannot be cancelled. Keep its reader slot reserved
    // until it settles, even though the network body errors immediately.
    void pending.catch(() => {}).then(() => pieces.return()).finally(release).catch(() => {})
    if (error) rejectCompletion(error)
    else resolveCompletion()
  }
  const abort = () => {
    if (stopped) return
    const error = Object.assign(new Error('MIRROR_SNAPSHOT_ABORTED'), { code: 'MIRROR_SNAPSHOT_ABORTED' })
    controller.error(error)
    finish(error)
  }
  const stream = new ReadableStream({
    start(value) {
      controller = value
      request.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => {
        if (stopped) return
        const error = Object.assign(new Error('MIRROR_SNAPSHOT_TIMEOUT'), { code: 'MIRROR_SNAPSHOT_TIMEOUT' })
        controller.error(error)
        finish(error)
      }, MIRROR_LIMITS.snapshotTimeoutMs)
      if (request.signal.aborted) abort()
    },
    async pull(value) {
      try {
        pending = pieces.next()
        const part = await pending
        if (stopped) return
        if (part.done) { value.close(); finish() }
        else value.enqueue(part.value)
      } catch (error) {
        if (!stopped) { value.error(error); finish(error) }
      }
    },
    cancel() { finish(Object.assign(new Error('MIRROR_SNAPSHOT_ABORTED'), { code: 'MIRROR_SNAPSHOT_ABORTED' })) },
  }, { highWaterMark: 0 })
  completion.catch(() => {})
  const response = new Response(stream, { headers })
  response.mirrorCompletion = completion
  response.mirrorDetachedSnapshot = true
  return response
}

/** Atomically persist entries, global revision, bounded replay acknowledgments and client sequence. Stale output is retained separately, never rebased. */
export async function publishMirror(storage, envelope, { now = Date.now(), mode, retire, homeFreeze } = {} /* ANYBROWSER hook */) {
  // JOIN hook: with no setting (`mode` observe, `retire` off, `homeFreeze` record) a home save performs
  // JOIN hook: EXACTLY main's storage operations and answers: no tombstone, lease or write-time row is read or written.
  // JOIN hook: Tombstones are read when slots can be retired or the lease is enforced; the lease only when enforced;
  // JOIN hook: the write time only when the lease or the home freeze is enforced (the one reader of it, HOME_PENDING).
  const slotsRead = retire === 'retire' || mode === 'enforce', leased = mode === 'enforce', noteWrites = leased || homeFreeze === 'enforce' // JOIN hook
  const clock = typeof now === 'function' ? now : () => now // JOIN hook: read when judged, never captured before a wait
  if (envelope?.v !== 2) fail('MIRROR_OUTBOX_PROTOCOL_REQUIRED', 409)
  const { batch, digest } = envelope
  if (!batch || typeof batch.clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(batch.clientId) || !Number.isSafeInteger(batch.seq) || batch.seq < 1 || batch.id !== `${batch.clientId}:${batch.seq}` || typeof digest !== 'string' || await mirrorDigest(batch) !== digest) fail('INVALID_MIRROR_BATCH')
  // A path refused by the rule waits for one question: is this the exact batch (same id, same digest) the mirror already
  // applied, admitted under an older, narrower rule? Then it gets its stored receipt, so a browser whose answer was lost
  // is never stranded. Anything else stays refused, before any write.
  let entries = null, pathRefusal = null
  try { entries = publishableMirrorEntries(batch.entries) } catch (error) {
    if (error?.code !== 'INVALID_MIRROR_PATH') throw error
    pathRefusal = error
  }
  return storage.transaction(async tx => {
    const current = await readFence(tx)
    const replayState = await readMirrorReplayState(tx, current)
    const retired = slotsRead ? await retiredClientAnswer(tx, replayState, batch, { mode, fence: current }) : null // ANYBROWSER hook: a retired browser is answered by name, before anything else (an unknown one only under enforce)
    if (retired) return retired // ANYBROWSER hook
    const key = RECEIPT + batch.id
    const existing = replayState.receipts.get(key)
    if (existing && existing.digest === digest && existing.id === batch.id) return { ...existing, replayed: true }
    // ANYBROWSER hook: one writer, decided from the edge's lease row in this transaction; a replayed batch kept its receipt above.
    // JOIN hook: ONLY under WRITER_LEASE=enforce. In the default mode a home save never reads the lease (a reference it
    // JOIN hook: carries is ignored, as main ignores it): today's app knows no lease and re-posts a 423 or 410 batch (up to
    // JOIN hook: 34 MiB) every 60 s (idb-persist.ts deliveryRefusal). The tombstone was read just above (slotChecked).
    const writer = leased ? await checkLease(tx, envelope.lease ?? null, clock, { mode, clientId: batch.clientId, slotChecked: true }) : { ok: true } // ANYBROWSER hook
    if (!writer.ok) return writer // ANYBROWSER hook: 423, 410, or the named 409 CLIENT_SLOT_RETIRED; never a conflictCode
    if (pathRefusal) throw pathRefusal
    if (existing) return retainConflict(tx, envelope, current, 'MIRROR_REPLAY_CONFLICT')
    const head = replayState.clients.get(batch.clientId)
    if (head && batch.seq <= head.seq) return retainConflict(tx, envelope, current, 'MIRROR_REPLAY_EXPIRED')
    if (!validCloudBase(batch.cloudBase)) return retainConflict(tx, envelope, current, 'MIRROR_GLOBAL_FENCE_REQUIRED')
    if (batch.cloudBase.lineageId !== current.lineageId || batch.cloudBase.revision !== current.revision) return retainConflict(tx, envelope, current, 'MIRROR_GLOBAL_FENCE_CONFLICT')
    if (current.revision === Number.MAX_SAFE_INTEGER) fail('MIRROR_GLOBAL_REVISION_LIMIT', 507)
    if (batch.seq !== (head?.seq ?? 0) + 1) return retainConflict(tx, envelope, current, 'MIRROR_SEQUENCE_GAP')
    // ANYBROWSER hook (the ONE replacement): a full table retires one idle slot as a tombstone; 507 only when none may be retired.
    // JOIN hook: retirement needs MIRROR_SLOT_RETIRE=retire; by default a full table is main's 507, nothing is retired.
    if (!head && replayState.clients.size >= MIRROR_LIMITS.clients && !(retire === 'retire' && await retireClientSlot(tx, replayState, { incomingClientId: batch.clientId, now: clock() }))) fail('MIRROR_CLIENT_LIMIT', 507) // ANYBROWSER hook
    const pruneKeys = planMirrorReplayPrune(replayState, batch.clientId)
    const hidden = { rows: 0 }
    const before = await readEntries(tx, hidden)
    const priorResets = await readResets(tx, hidden)
    const { entries: after, resets } = planMirrorEntries(before, entries, priorResets, { hiddenRows: hidden.rows })
    await enforceHistoryPrefixes(tx, before, after)
    const nextFence = { lineageId: current.lineageId, revision: current.revision + 1 }
    snapshotBytes(after, [...resets].sort(), nextFence)
    for (const [path, previous] of before) if (!after.has(path)) {
      const id = await pathKey(path)
      await removeChunks(tx, id, previous)
      await tx.delete(ENTRY + id)
    }
    for (const [path, value] of after) if (JSON.stringify(before.get(path)) !== JSON.stringify(value)) await storeEntry(tx, path, value, before.get(path))
    for (const path of priorResets) if (!resets.has(path)) await tx.delete(RESET + await pathKey(path))
    const previousResets = new Set(priorResets)
    for (const path of resets) if (!previousResets.has(path)) await putValue(tx, RESET + await pathKey(path), path)
    // `applied` counts every entry of the batch as sent: an inert secret-shaped `gone` (publishableMirrorEntries) is applied
    // as the no-op it is, and the browser accepts only an acknowledgement that names its whole batch.
    const receipt = { ok: true, ...protocolFields(nextFence), id: batch.id, clientId: batch.clientId, seq: batch.seq, digest, applied: batch.entries.length, acknowledgedAt: Date.now() }
    for (const receiptKey of pruneKeys) await tx.delete(receiptKey)
    await putValue(tx, FENCE, nextFence)
    await putValue(tx, key, receipt)
    await putValue(tx, HEAD + batch.clientId, { seq: batch.seq, digest })
    if (noteWrites) await noteWrote(tx, batch.clientId, clock()) // ANYBROWSER hook: an APPLIED home save is a write; a replayed receipt is not (noted only when enforced; else lastWroteAt is null)
    return receipt
  })
}

async function readEnvelope(request) {
  try { return await readBoundedBootstrapJson(request, MIRROR_LIMITS.requestBytes) }
  catch (error) {
    if (error.code === 'REQUEST_BODY_TOO_LARGE') fail('MIRROR_REQUEST_TOO_LARGE', 413)
    if (['INVALID_JSON', 'INVALID_UTF8'].includes(error.code)) fail('INVALID_MIRROR_JSON')
    throw error
  }
}

const bootstrapView = record => ({
  ok: true, phase: record.phase, seedId: record.seedId, ballId: record.ballId, epoch: record.epoch,
  nextBatch: record.nextBatch, batchCount: record.batchDigests.length, entryCount: record.entryCount,
  lineageId: record.lineageId, revision: record.revision,
})

// A read may have allocated an empty revision-0 fence. No other prior state is adopted.
const emptyBootstrapTarget = async tx => {
  const rows = await tx.list({ limit: 2 })
  if (!rows.size) return true
  return rows.size === 1 && rows.has(FENCE) && validCloudBase(rows.get(FENCE)) && rows.get(FENCE).revision === 0
}

export async function mirrorBootstrapStatus(storage) {
  return storage.transaction(async tx => {
    const record = await tx.get(BOOTSTRAP)
    if (record) return bootstrapView(record)
    return { ok: true, phase: await emptyBootstrapTarget(tx) ? 'empty' : 'established', seedId: null }
  })
}

/**
 * The deletion markers a seed may carry (a restore of an inventory that had them): valid mirror paths, sorted, unique,
 * none under another, bounded. Absent means none. A recovery snapshot exported before the secret-shaped rule may
 * name a well-formed secret-shaped path (a credentials temp copy's deletion): it is dropped here, exactly as the export now
 * hides such a row, never refused and never written. Every other check still runs on the list as given.
 * @param {unknown} value - the request's `resetPaths`.
 * @returns {string[]} the markers that are kept.
 */
export function bootstrapResetPaths(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MIRROR_LIMITS.entries) fail('INVALID_BOOTSTRAP_RESETS')
  let previous = ''
  for (const path of value) {
    if (!hiddenStoredPath(path)) validateMirrorPath(path)
    if (path <= previous) fail('INVALID_BOOTSTRAP_RESETS')
    previous = path
  }
  if (compactResets(new Set(value)).size !== value.length) fail('INVALID_BOOTSTRAP_RESETS')
  // Their wire size counts against the mirror's metadata bound, as it does for a live mirror (planMirrorEntries).
  if (size(JSON.stringify(value)) > MIRROR_LIMITS.metadataBytes) fail('MIRROR_METADATA_LIMIT', 413)
  return value.filter(path => !hiddenStoredPath(path))
}

/** Staged seed writes are invisible until the Head owner confirms this matching receipt. */
export async function bootstrapMirror(storage, input) {
  if (!input || typeof input !== 'object' || !/^[0-9a-f]{64}$/.test(input.seedId)) fail('INVALID_BOOTSTRAP_REQUEST')
  if (input.action === 'begin') {
    const { seedId, ballId, epoch, mirror } = input
    const resetPaths = bootstrapResetPaths(input.resetPaths)
    if (!/^[0-9a-f]{64}$/.test(ballId) || !Number.isSafeInteger(epoch) || epoch < 1 || !mirror || !Array.isArray(mirror.batchDigests) || mirror.batchDigests.length > BOOTSTRAP_LIMITS.batches || mirror.batchDigests.some(hash => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) || !Number.isSafeInteger(mirror.entryCount) || mirror.entryCount < 0 || mirror.entryCount > MIRROR_LIMITS.entries || (mirror.entryCount === 0) !== (mirror.batchDigests.length === 0)) fail('INVALID_BOOTSTRAP_INVENTORY')
    return storage.transaction(async tx => {
      const prior = await tx.get(BOOTSTRAP)
      if (prior) {
        if (prior.seedId !== seedId || prior.ballId !== ballId || prior.epoch !== epoch || prior.expectedEntries !== mirror.entryCount || canonicalBootstrap(prior.batchDigests) !== canonicalBootstrap(mirror.batchDigests)
          || (prior.resetDigest ?? null) !== (resetPaths.length ? await digest(canonicalBootstrap(resetPaths)) : null)) fail('BOOTSTRAP_SEED_CONFLICT', 409)
        return { ...bootstrapView(prior), idempotent: true }
      }
      if (!await emptyBootstrapTarget(tx)) fail('MIRROR_ALREADY_INITIALIZED', 409)
      // Never reuse a revision-0 base previously issued to an empty browser.
      const fence = { lineageId: crypto.randomUUID(), revision: 0 }
      // Each deletion marker is its own row, the same RESET row a live mirror keeps (one path, at most 4 KiB): never one
      // record that grows with their number. They are invisible until the seed is ready.
      for (const path of resetPaths) await putValue(tx, RESET + await pathKey(path), path)
      const record = { phase: 'receiving', seedId, ballId, epoch, batchDigests: mirror.batchDigests, expectedEntries: mirror.entryCount, entryCount: 0, nextBatch: 0, lastPath: '',
        ...(resetPaths.length ? { resetCount: resetPaths.length, resetDigest: await digest(canonicalBootstrap(resetPaths)) } : {}), ...fence }
      await putValue(tx, FENCE, fence)
      await putValue(tx, BOOTSTRAP, record)
      return bootstrapView(record)
    })
  }
  if (input.action === 'batch') {
    if (!Number.isSafeInteger(input.index) || input.index < 0) fail('INVALID_BOOTSTRAP_BATCH')
    const entries = validateMirrorEntries(input.entries)
    if (entries.some(([, wire]) => wire.kind === 'gone')) fail('BOOTSTRAP_DELETION_FORBIDDEN')
    const batchDigest = await digest(canonicalBootstrap(entries))
    return storage.transaction(async tx => {
      const record = await tx.get(BOOTSTRAP)
      if (!record || record.seedId !== input.seedId) fail('BOOTSTRAP_SEED_CONFLICT', 409)
      if (record.batchDigests[input.index] !== batchDigest) fail('BOOTSTRAP_BATCH_DIGEST_MISMATCH', 409)
      const result = () => ({ ok: true, seedId: record.seedId, index: input.index, digest: batchDigest, nextBatch: record.nextBatch, phase: record.phase })
      if (input.index < record.nextBatch) return { ...result(), idempotent: true }
      if (record.phase !== 'receiving' || input.index !== record.nextBatch) fail('BOOTSTRAP_BATCH_SEQUENCE', 409)
      let previous = record.lastPath
      for (const [path] of entries) {
        if (path <= previous) fail('BOOTSTRAP_PATH_ORDER')
        previous = path
      }
      if (record.entryCount + entries.length > record.expectedEntries) fail('BOOTSTRAP_ENTRY_COUNT')
      const before = await readEntries(tx)
      const after = planMirrorEntries(before, entries, [], { importing: true }).entries
      // Full seed inventories contain their own directories. No implicit extra rows.
      if (after.size !== before.size + entries.length) fail('BOOTSTRAP_INVENTORY_INCOMPLETE')
      snapshotBytes(after, [], { lineageId: record.lineageId, revision: 1 })
      for (const [path, value] of entries) await storeEntry(tx, path, value, undefined)
      record.entryCount += entries.length
      record.nextBatch += 1
      record.lastPath = previous
      await putValue(tx, BOOTSTRAP, record)
      return result()
    })
  }
  if (input.action === 'commit') return storage.transaction(async tx => {
    const record = await tx.get(BOOTSTRAP)
    if (!record || record.seedId !== input.seedId) fail('BOOTSTRAP_SEED_CONFLICT', 409)
    if (record.phase === 'ready') return { ...bootstrapView(record), idempotent: true }
    if (record.nextBatch !== record.batchDigests.length || record.entryCount !== record.expectedEntries) fail('BOOTSTRAP_BATCHES_INCOMPLETE', 409)
    const entries = await readEntries(tx)
    if (entries.size !== record.entryCount) fail('BOOTSTRAP_ENTRY_COUNT', 503)
    // Deletion markers a restored inventory carried (rows written at begin): exactly the ones it declared.
    const resetPaths = await readResets(tx)
    if (resetPaths.length !== (record.resetCount ?? 0) || (resetPaths.length ? await digest(canonicalBootstrap(resetPaths)) : null) !== (record.resetDigest ?? null)) fail('BOOTSTRAP_RESETS_INCOMPLETE', 503)
    snapshotBytes(entries, resetPaths, { lineageId: record.lineageId, revision: 1 })
    record.phase = 'ready'
    record.revision = 1
    await putValue(tx, FENCE, { lineageId: record.lineageId, revision: record.revision })
    await putValue(tx, BOOTSTRAP, record)
    return bootstrapView(record)
  })
  fail('BOOTSTRAP_ACTION_INVALID')
}

/** Internal route adapter. Callers authenticate and serialize mutations and metadata capture.
 * Snapshot chunks recheck their captured fence; mirrorCompletion tracks body termination,
 * not a write lock. Optional reserveSnapshot returns a release callback for reader capacity;
 * without it the caller owns capacity limits. Conflict downloads still serialize completion.
 * Optional onUpdated receives metadata only after a new commit, without delaying its ACK.
 * Synchronous throws and rejected delivery promises cannot undo the committed receipt.
 * Omitted onUpdated performs no notification. Clients must poll after disconnect or missed delivery.
 */
export async function handleMirrorRequest(request, storage, { authorized = false, onUpdated, reserveSnapshot, writerLease = 'observe' /* ANYBROWSER hook */, homeFreeze = 'record' /* ANYBROWSER hook */, slotRetire = 'off' /* JOIN hook */ } = {}) {
  if (!authorized) return reply({ ok: false, code: 'UNAUTHORIZED' }, 401)
  try {
    const url = new URL(request.url)
    const path = url.pathname
    if (path === '/_mirror/status' && url.search && url.search !== '?compact=1') return reply({ ok: false, code: 'INVALID_MIRROR_STATUS_QUERY' }, 400)
    if (path === '/_mirror/delta' && request.method === 'POST') {
      const envelope = await readEnvelope(request)
      const result = await publishMirror(storage, envelope, { now: () => Date.now() /* JOIN hook: a clock */, mode: writerLease, retire: slotRetire, homeFreeze } /* ANYBROWSER hook */)
      // The notice names only what changed: an entry the secret-path rule took as a no-op (publishableMirrorEntries)
      // changed nothing and is never named, so a mixed batch still announces its ordinary paths.
      const changed = result.ok && !result.replayed ? envelope.batch.entries.map(([path]) => path).filter(path => !hiddenStoredPath(path)) : []
      if (changed.length && onUpdated) {
        try {
          void Promise.resolve(onUpdated(createMirrorUpdate(result, changed)))
            .catch(_error => { console.warn('Mirror update delivery failed; committed ACK retained and polling remains available') })
        }
        catch (_error) { console.warn('Mirror update delivery failed; committed ACK retained and polling remains available') }
      }
      return reply(result, result.status ?? 200)
    }
    if (path === '/_mirror/conflicts' && request.method === 'GET') return await conflictResponse(storage, url)
    if (path === '/api/snapshot' && request.method === 'GET') {
      return await snapshotResponse(storage, request, reserveSnapshot)
    }
    if (path === '/_mirror/status' && request.method === 'GET') {
      return reply(await storage.transaction(async tx => {
        const fence = await readFence(tx)
        if (url.searchParams.get('compact') === '1') return { ok: true, ...protocolFields(fence), runtime: 'cloudflare', snapshotFormat: SNAPSHOT_FORMAT, snapshotETag: snapshotETag(fence) }
        const entries = [...await readEntries(tx)]
        const resetPaths = await readResets(tx)
        // ANYBROWSER hook: `clients` = browser slots in use (their sequence heads; the cap is `limits.clients`). Counted, never read.
        const clients = (await tx.list({ prefix: 'mirror:v2:head:', limit: MIRROR_LIMITS.clients + 1 })).size // ANYBROWSER hook
        // JOIN hook: main's answer at main's cost, byte for byte: no `world` field and no wave 3 read here.
        // JOIN hook: the lease, her pending home and the thread counts are on `/_mirror/lease` status and `/_thread/index`.
        return { clients /* ANYBROWSER hook */, ok: true, ...protocolFields(fence), runtime: 'cloudflare', snapshotFormat: SNAPSHOT_FORMAT, resetCount: resetPaths.length, entryCount: entries.length, fileCount: entries.filter(([, wire]) => wire.kind === 'file').length, directoryCount: entries.filter(([, wire]) => wire.kind === 'dir').length, homeFiles: entries.filter(([path]) => path.startsWith('/dsh/home/')).map(([path]) => path.slice('/dsh/home/'.length)), workspaceFiles: entries.filter(([path]) => path.startsWith('/dsh/workspace/')).map(([path]) => path.slice('/dsh/workspace/'.length)), memoryHistorySupported: false, limits: MIRROR_LIMITS }
      }))
    }
    if (path === '/_mirror/memory-history' && request.method === 'GET') return reply({ ok: false, runtime: 'cloudflare', supported: false, code: 'MEMORY_HISTORY_NOT_IMPLEMENTED', error: 'Cloud storage retains current mirror state and replay receipts, not historical file versions.' }, 501)
    if (path === '/api/snapshot' && ['PUT', 'POST'].includes(request.method)) return reply({ ok: false, code: 'MIRROR_OUTBOX_PROTOCOL_REQUIRED' }, 409)
    return reply({ ok: false, code: 'NOT_FOUND' }, 404)
  } catch (error) {
    return reply({ ok: false, code: error.code ?? 'MIRROR_STORAGE_FAILED', error: error.code ?? 'Mirror operation failed; no partial batch was committed.' }, error.status ?? 503)
  }
}

// Read only the fixed receipt file. The owning DO queue keeps its metadata and
// chunks stable; this never lists snapshot content or writes a missing fence.
async function readPredictionReceipts(storage) {
  try {
    const id = await pathKey(PREDICTION_RECEIPTS_PATH)
    const metadata = await storage.get(ENTRY + id)
    if (metadata === undefined) return predictionUnavailable('PREDICTION_RECEIPTS_ABSENT', 'absent')
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.path !== PREDICTION_RECEIPTS_PATH || metadata.kind !== 'file' || Object.hasOwn(metadata, 'b64') || !Number.isInteger(metadata.mode) || metadata.mode < 0 || metadata.mode > 0o777 || !Number.isFinite(metadata.mtimeMs) || metadata.mtimeMs < 0 || !Number.isFinite(new Date(metadata.mtimeMs).getTime()) || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0) return predictionUnavailable('PREDICTION_RECEIPTS_CORRUPT', 'malformed')
    if (metadata.bytes > PREDICTION_LIMITS.bytes) return predictionUnavailable('PREDICTION_RECEIPTS_TOO_LARGE')
    const characters = Math.ceil(metadata.bytes / 3) * 4
    if (metadata.chunks !== Math.ceil(characters / CHUNK_CHARS)) return predictionUnavailable('PREDICTION_RECEIPTS_CORRUPT', 'malformed')
    const chunks = []
    for (let index = 0; index < metadata.chunks; index += 1) {
      const content = await storage.get(`${CHUNK}${id}:${index}`)
      const expectedLength = Math.min(CHUNK_CHARS, characters - index * CHUNK_CHARS)
      const padding = index === metadata.chunks - 1 ? (3 - metadata.bytes % 3) % 3 : 0
      if (typeof content !== 'string' || content.length !== expectedLength || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length - content.replace(/=+$/, '').length !== padding || (padding && btoa(atob(content.slice(-4))) !== content.slice(-4))) return predictionUnavailable('PREDICTION_RECEIPTS_CORRUPT', 'malformed')
      chunks.push(content)
    }
    let text
    try {
      const binary = atob(chunks.join(''))
      if (binary.length !== metadata.bytes) return predictionUnavailable('PREDICTION_RECEIPTS_CORRUPT', 'malformed')
      text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
    } catch (_error) { return predictionUnavailable('PREDICTION_RECEIPTS_CORRUPT', 'malformed') }
    return projectPredictionReceipts(text)
  } catch (_error) { return predictionUnavailable('PREDICTION_RECEIPTS_UNAVAILABLE') }
}


// Worker-safe equivalents of the local reader's bounded pure verifiers. Keep parity
// fixtures with readLocalAuraInputs; Node filesystem and crypto modules cannot enter this bundle.
const AURA_EDGE_LIMITS = Object.freeze({ files: 256, bytes: 4 * 1024 * 1024, jsonBytes: 256 * 1024, nodeBytes: 64 * 1024, rows: 2048, depth: 32, values: 20000 })
const auraHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const auraCount = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const auraObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const auraDigest = value => digest(canonicalJson(value))
const auraWithout = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
const auraRequire = (condition, code) => { if (!condition) fail(code, 503) }

function parseAuraJson(text) {
  const value = JSON.parse(text)
  const pending = [[value, 0]]
  let visited = 0
  while (pending.length) {
    const [item, depth] = pending.pop()
    auraRequire(++visited <= AURA_EDGE_LIMITS.values && depth <= AURA_EDGE_LIMITS.depth, 'AURA_JSON_LIMIT')
    if (typeof item === 'number') auraRequire(Number.isFinite(item) && !Object.is(item, -0), 'AURA_JSON_INVALID')
    if (item !== null && typeof item === 'object') for (const child of Object.values(item)) pending.push([child, depth + 1])
  }
  return value
}

function auraRows(text) {
  if (text === '') return []
  // A nonterminated append may be a torn journal, even when its last JSON value parses.
  auraRequire(text.endsWith('\n'), 'AURA_JOURNAL_TRUNCATED')
  const lines = text.slice(0, -1).split('\n')
  auraRequire(lines.length <= AURA_EDGE_LIMITS.rows, 'AURA_RECORD_LIMIT')
  return lines.map(line => {
    auraRequire(line.trim() !== '' && size(line) <= AURA_EDGE_LIMITS.nodeBytes, 'AURA_RECORD_INVALID')
    const row = parseAuraJson(line)
    auraRequire(auraObject(row), 'AURA_RECORD_INVALID')
    return row
  })
}

async function verifyAuraReceipts(rows, check = () => {}) {
  let previous = '0'.repeat(64)
  for (let index = 0; index < rows.length; index++) {
    check()
    const row = rows[index]
    auraRequire(row.schema === 'aukora.receipt.v3' && row.seq === index + 1 && row.prevHash === previous
      && typeof row.at === 'string' && row.at.length > 0 && row.at.length <= 80
      && typeof row.kind === 'string' && row.kind.length > 0 && row.kind.length <= 80 && auraObject(row.data), 'AURA_RECEIPT_CHAIN_INVALID')
    const claimed = row.leafHash ?? row.hash
    auraRequire(auraHash(claimed) && (row.hash === undefined || row.hash === claimed), 'AURA_RECEIPT_HASH_INVALID')
    const payload = auraWithout(row, row.leafHash === undefined ? 'hash' : 'leafHash')
    const recomputed = await digest('\0' + canonicalJson(payload))
    auraRequire(recomputed === claimed, 'AURA_RECEIPT_HASH_MISMATCH')
    previous = recomputed
  }
  return rows.map(row => ({ ...row, leafHash: row.leafHash ?? row.hash }))
}

async function verifyAuraDag(head, nodes, receipts, check = () => {}) {
  const ids = value => Array.isArray(value) && value.length <= 256 && value.every(auraHash) && new Set(value).size === value.length
  auraRequire(auraObject(head) && auraCount(head.count) && head.count <= 256 && ids(head.heads) && head.count === nodes.length, 'AURA_DAG_HEAD_INVALID')
  const byId = new Map()
  for (const node of nodes) {
    check()
    auraRequire(auraObject(node) && auraHash(node.id) && node.id === await auraDigest(auraWithout(node, 'id')) && !byId.has(node.id), 'AURA_DAG_HASH_MISMATCH')
    const parents = node.parentIds ?? node.parents
    auraRequire(ids(parents) && parents.length <= 16
      && (node.parentIds === undefined || node.parents === undefined || canonicalJson(node.parentIds) === canonicalJson(node.parents)), 'AURA_DAG_LINKS_INVALID')
    const receipt = receipts.find(row => row.kind === 'memory.dag.append' && (row.data.nodeId === node.id || row.data.id === node.id))
    // The node hashes its preceding receipt context; its append receipt is necessarily later.
    auraRequire(receipt !== undefined && (node.receiptHash === undefined || node.receiptHash === null
      || receipts.some(row => row.leafHash === node.receiptHash && row.seq < receipt.seq))
      && (receipt.data.content === undefined || receipt.data.content === node.content)
      && (receipt.data.summary === undefined || receipt.data.summary === node.summary), 'AURA_DAG_UNANCHORED')
    byId.set(node.id, parents)
  }
  const reachable = new Set(), visiting = new Set()
  const walk = (id, depth) => {
    auraRequire(depth <= AURA_EDGE_LIMITS.depth && !visiting.has(id) && byId.has(id), 'AURA_DAG_LINKS_INVALID')
    if (reachable.has(id)) return
    visiting.add(id)
    for (const parent of byId.get(id)) walk(parent, depth + 1)
    visiting.delete(id)
    reachable.add(id)
  }
  for (const id of head.heads) walk(id, 0)
  // Validate disconnected components too; corrupt or missing ancestors are not healthy orphans.
  const fromHeads = reachable.size
  for (const id of byId.keys()) walk(id, 0)
  return { reachableDagNodes: fromHeads, declaredDagNodes: head.count }
}

function verifyAuraPredictions(receipts, corpus, epoch) {
  const promotions = new Set(['ball.promote', 'tree.patch', 'tree.undo', 'snapshot.restore', 'seed.bootstrap'])
  const registrations = new Map(), observations = new Set(), trajectories = new Map(), scores = []
  let rollback = null
  const fieldsValid = (data, amount) => typeof data.predictionId === 'string' && data.predictionId.length > 0 && data.predictionId.length <= 200
    && auraHash(data.targetBallId) && auraCount(data.targetEpoch) && typeof data.metric === 'string' && data.metric.length > 0 && data.metric.length <= 80
    && typeof data[amount] === 'number' && Number.isFinite(data[amount]) && !Object.hasOwn(data, 'surpriseScore')
  for (const row of receipts) {
    if (row.kind === 'tree.undo' || row.kind === 'snapshot.restore') {
      auraRequire(auraCount(row.data.epoch) && row.data.epoch <= epoch, 'AURA_ROLLBACK_INVALID')
      rollback = row.data.epoch
    }
    if (row.kind === 'prediction.register') {
      auraRequire(fieldsValid(row.data, 'expected') && !registrations.has(row.data.predictionId), 'AURA_PREDICTION_INVALID')
      registrations.set(row.data.predictionId, row)
    }
    if (row.kind !== 'prediction.observe') continue
    auraRequire(fieldsValid(row.data, 'observed') && !observations.has(row.data.predictionId), 'AURA_PREDICTION_INVALID')
    const register = registrations.get(row.data.predictionId)
    auraRequire(register && ['targetBallId', 'targetEpoch', 'metric'].every(key => row.data[key] === register.data[key]), 'AURA_PREDICTION_BINDING_INVALID')
    const promotion = receipts.find(item => promotions.has(item.kind) && item.seq > register.seq && item.seq < row.seq
      && item.data.ballId === row.data.targetBallId && item.data.epoch === row.data.targetEpoch)
    auraRequire(promotion, 'AURA_PREDICTION_ORDER_INVALID')
    const parent = receipts.filter(item => item.seq < promotion.seq && item.data.ballId === promotion.data.parentBallId && auraCount(item.data.epoch)).at(-1)
    auraRequire(parent && parent.data.epoch < promotion.data.epoch, 'AURA_PREDICTION_PARENT_UNKNOWN')
    const score = Math.abs(row.data.observed - register.data.expected) / Math.max(Math.abs(register.data.expected), 1)
    auraRequire(Number.isFinite(score), 'AURA_PREDICTION_INVALID')
    const trajectoryId = `${register.leafHash}:${promotion.leafHash}:${row.leafHash}`
    trajectories.set(trajectoryId, { trajectoryId, pearlId: row.data.targetBallId, epochBefore: parent.data.epoch, epochAfter: row.data.targetEpoch,
      predicted: register.data.expected, observed: row.data.observed, surpriseScore: score, registerReceiptHash: register.leafHash,
      promotionReceiptHash: promotion.leafHash, observeReceiptHash: row.leafHash, exceptionRuleCandidate: score > 0 })
    observations.add(row.data.predictionId)
    scores.push(score)
  }
  auraRequire(corpus.length === trajectories.size, 'AURA_DISCOVERY_INCOMPLETE')
  for (const row of corpus) {
    const expected = trajectories.get(row.trajectoryId)
    auraRequire(expected && canonicalJson(row) === canonicalJson(expected), 'AURA_DISCOVERY_UNVERIFIED')
    trajectories.delete(row.trajectoryId)
  }
  return { observedSurpriseScores: scores, unanchoredPredictions: registrations.size - observations.size,
    lastRollbackAgeEpochs: rollback === null ? Number.MAX_SAFE_INTEGER : epoch - rollback }
}


/** Read a transactional, bounded evidence snapshot. No raw file content leaves this adapter.
 * Missing evidence never supplies partial metrics, and empty namespaces are never initialized.
 * @param {object} storage Durable Object storage.
 * @param {object} options Matching seed, selected head identity, timestamp and cancellation signal.
 * Optional checkpointSignerPin/checkpointSignerPolicy come from independent host configuration, never mirror content; absent trust remains unpinned.
 * @returns {Promise<object>} Verified metrics and revision, or explicit incomplete evidence. Optional build metadata is recorded source, not running-organ proof.
 */
export async function readMirrorAuraInputs(storage, { seedId, head, now, signal, checkFence, includeFacts = false, checkpointSignerPin, checkpointSignerPolicy, receiptsHeadOnly = false /* NOSTR hook */ } = {}) {
  let dagLayout = 'unknown'
  const incomplete = code => ({ ok: true, seedId, head, evidence: { status: 'incomplete', gaps: [code], dagLayout,
    organCounts: 'declared-enabled-not-runtime-health', selectionIsNotHealthProof: true } })
  try {
    return await storage.transaction(async tx => {
      const check = () => { signal?.throwIfAborted() }
      check()
      const bootstrap = await tx.get(BOOTSTRAP), fence = await tx.get(FENCE)
      auraRequire(bootstrap?.phase === 'ready' && bootstrap.seedId === seedId && auraHash(seedId), 'AURA_BOOTSTRAP_REQUIRED')
      auraRequire(validCloudBase(fence) && fence.lineageId === bootstrap.lineageId && fence.revision >= 1, 'AURA_FENCE_INVALID')
      if (checkFence !== undefined) {
        auraRequire(canonicalJson(checkFence) === canonicalJson(fence), 'AURA_SNAPSHOT_CHANGED')
        return { ok: true, seedId, fence }
      }
      auraRequire(auraObject(head) && auraHash(head.ballId) && auraCount(head.epoch) && auraCount(now) && now <= 8640000000000000, 'AURA_HEAD_INVALID')
      let consumed = 0
      const read = async (path, limit) => {
        check()
        const id = await pathKey(path), metadata = await tx.get(ENTRY + id)
        auraRequire(metadata !== undefined, 'AURA_SOURCE_ABSENT')
        auraRequire(auraObject(metadata) && metadata.path === path && metadata.kind === 'file' && !Object.hasOwn(metadata, 'b64')
          && auraCount(metadata.bytes) && Number.isInteger(metadata.mode) && metadata.mode >= 0 && metadata.mode <= 0o777
          && Number.isFinite(metadata.mtimeMs) && metadata.mtimeMs >= 0, 'AURA_SOURCE_INVALID')
        auraRequire(metadata.bytes <= limit && metadata.bytes <= AURA_EDGE_LIMITS.bytes - consumed, 'AURA_BYTE_LIMIT')
        const characters = Math.ceil(metadata.bytes / 3) * 4
        auraRequire(metadata.chunks === Math.ceil(characters / CHUNK_CHARS), 'AURA_SOURCE_INVALID')
        let encoded = ''
        for (let index = 0; index < metadata.chunks; index++) {
          check()
          const chunk = await tx.get(`${CHUNK}${id}:${index}`)
          const length = Math.min(CHUNK_CHARS, characters - index * CHUNK_CHARS)
          const padding = index === metadata.chunks - 1 ? (3 - metadata.bytes % 3) % 3 : 0
          auraRequire(typeof chunk === 'string' && chunk.length === length && /^[A-Za-z0-9+/]*={0,2}$/.test(chunk)
            && chunk.length - chunk.replace(/=+$/, '').length === padding
            && (!padding || btoa(atob(chunk.slice(-4))) === chunk.slice(-4)), 'AURA_SOURCE_INVALID')
          encoded += chunk
        }
        const binary = atob(encoded)
        auraRequire(binary.length === metadata.bytes, 'AURA_SOURCE_INVALID')
        consumed += binary.length
        check()
        return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
      }
      const base = '/dsh/home/auma/', dag = base + 'memory/dag/'
      // NOSTR hook: her signed head announcement needs only the verified receipts head. It reads the journal alone, under the
      // whole 4 MiB budget and 2048 rows, by the same chain check as below, so no other Aura file (HANDOFF.md cap, DAG, corpus,
      // heartbeat) can refuse it. Scoped by name: this answer carries no Aura metrics and is never Aura's evidence.
      if (receiptsHeadOnly) { // NOSTR hook
        const receipts = await verifyAuraReceipts(auraRows(await read(base + 'seed/receipts.v3.jsonl', AURA_EDGE_LIMITS.bytes)), check) // NOSTR hook
        check() // NOSTR hook
        auraRequire(canonicalJson(await tx.get(FENCE)) === canonicalJson(fence) && canonicalJson(await tx.get(BOOTSTRAP)) === canonicalJson(bootstrap), 'AURA_SNAPSHOT_CHANGED') // NOSTR hook
        return { ok: true, seedId, head, fence, scope: 'nostr-receipts-head', verifiedReceipts: receipts.length, receiptRows: receipts.length, // NOSTR hook
          receiptsLeafHash: receipts.length ? receipts.at(-1).leafHash : null, evidence: { status: 'complete', scope: 'nostr-receipts-head', gaps: [] } } // NOSTR hook
      } // NOSTR hook
      const handoff = await read(base + 'HANDOFF.md', AURA_EDGE_LIMITS.nodeBytes)
      const epochMatch = /epoch\s*\|\s*\*\*(\d+)\*\*/i.exec(handoff), ballMatch = /ballId\s*\|\s*`([0-9a-f]{64})`/i.exec(handoff)
      auraRequire(epochMatch && ballMatch && auraCount(Number(epochMatch[1])), 'AURA_HANDOFF_UNKNOWN')
      const dagHead = parseAuraJson(await read(dag + 'HEAD.json', AURA_EDGE_LIMITS.nodeBytes))
      const inventory = await tx.list({ prefix: ENTRY, limit: MIRROR_LIMITS.entries + 1 })
      auraRequire(inventory.size <= MIRROR_LIMITS.entries, 'AURA_INVENTORY_LIMIT')
      let metadataBytes = 0
      const nodes = [], names = [], paths = new Set()
      let hasNodes = false, flat = false, nested = false
      for (const [key, value] of inventory) {
        check()
        metadataBytes += size(JSON.stringify(value))
        auraRequire(metadataBytes <= MIRROR_LIMITS.metadataBytes, 'AURA_INVENTORY_LIMIT')
        auraRequire(auraObject(value) && typeof value.path === 'string', 'AURA_INVENTORY_INVALID')
        if (!value.path.startsWith(dag)) continue
        auraRequire(!paths.has(value.path) && key === ENTRY + await pathKey(value.path), 'AURA_INVENTORY_INVALID')
        paths.add(value.path)
        const relative = value.path.slice(dag.length)
        if (relative === 'HEAD.json') continue
        if (relative === 'nodes') { auraRequire(value.kind === 'dir', 'AURA_DAG_PATH_REFUSED'); hasNodes = true; continue }
        auraRequire(value.kind === 'file' && /^(nodes\/)?[a-f0-9]{64}\.json$/.test(relative), 'AURA_DAG_PATH_REFUSED')
        if (relative.startsWith('nodes/')) nested = true; else flat = true
        names.push(value.path)
        auraRequire(names.length <= AURA_EDGE_LIMITS.files, 'AURA_DAG_FILE_LIMIT')
      }
      auraRequire(!(flat && (hasNodes || nested)) && (!nested || hasNodes), 'AURA_DAG_LAYOUT_AMBIGUOUS')
      dagLayout = hasNodes ? 'nodes' : 'flat'
      for (const path of names.sort()) {
        const node = parseAuraJson(await read(path, AURA_EDGE_LIMITS.nodeBytes))
        auraRequire(auraObject(node) && node.id === path.split('/').at(-1).slice(0, -5), 'AURA_DAG_HASH_MISMATCH')
        nodes.push(node)
      }
      const receipts = await verifyAuraReceipts(auraRows(await read(base + 'seed/receipts.v3.jsonl', AURA_EDGE_LIMITS.bytes)), check)
      const facts = includeFacts ? await verifyFactCheckpoints(auraRows(await read(base + 'seed/checkpoints.v1.jsonl', AURA_EDGE_LIMITS.jsonBytes)), receipts, check, { checkpointSignerPin, checkpointSignerPolicy }) : undefined
      let receiptMerkleRoot
      if (includeFacts) {
        if (!receipts.length) {
          receiptMerkleRoot = await digest('')
        } else {
          let level = receipts.map(r => Uint8Array.from(r.leafHash.match(/../g), pair => parseInt(pair, 16)))
          while (level.length > 1) {
            const next = []
            for (let i = 0; i < level.length; i += 2) {
              check()
              if (i + 1 === level.length) next.push(level[i])
              else {
                const combined = new Uint8Array(1 + level[i].byteLength + level[i + 1].byteLength)
                combined[0] = 0x01
                combined.set(level[i], 1)
                combined.set(level[i + 1], 1 + level[i].byteLength)
                next.push(new Uint8Array(await crypto.subtle.digest('SHA-256', combined)))
              }
            }
            level = next
          }
          receiptMerkleRoot = [...level[0]].map(b => b.toString(16).padStart(2, '0')).join('')
        }
      }
      const corpus = auraRows(await read(base + 'seed/discovery-corpus.v1.jsonl', AURA_EDGE_LIMITS.bytes))
      const superagent = parseAuraJson(await read(base + 'superagent/state.json', AURA_EDGE_LIMITS.jsonBytes))
      const heartbeat = auraObject(superagent) ? staleHeartbeatFacts(superagent.assignments, now) : null
      auraRequire(heartbeat !== null, 'AURA_HEARTBEAT_UNKNOWN')
      const metrics = { ...await verifyAuraDag(dagHead, nodes, receipts, check), verifiedReceipts: receipts.length, totalReceipts: receipts.length,
        handOffEpochMismatch: Number(epochMatch[1]) !== head.epoch || ballMatch[1] !== head.ballId,
        ...verifyAuraPredictions(receipts, corpus, head.epoch), staleHeartbeatRatio: heartbeat.staleHeartbeatRatio }
      let sourceMetadata
      if (includeFacts) {
        const buildPath = base + 'seed/BUILD_INFO.json'
        const metadata = await tx.get(ENTRY + await pathKey(buildPath))
        if (metadata === undefined) sourceMetadata = projectBuildInfo(undefined)
        else {
          try { sourceMetadata = projectBuildInfo(await read(buildPath, 65536)) }
          catch (error) { check(); sourceMetadata = { status: 'invalid', organSourceCommit: null } }
        }
      }
      check()
      auraRequire(canonicalJson(await tx.get(FENCE)) === canonicalJson(fence)
        && canonicalJson(await tx.get(BOOTSTRAP)) === canonicalJson(bootstrap), 'AURA_SNAPSHOT_CHANGED')
      check()
      // NOSTR hook: the receipts head this answer has already verified above (last leaf and row count), for her signed head announcement.
      const nostrReceiptsHead = { receiptsLeafHash: receipts.length ? receipts.at(-1).leafHash : null, receiptRows: receipts.length } // NOSTR hook
      return { ok: true, seedId, head, fence, ...metrics, ...nostrReceiptsHead /* NOSTR hook */, ...(includeFacts ? { facts, sourceMetadata, receiptMerkleRoot } : {}), evidence: { status: 'complete', gaps: [], dagLayout,
        organCounts: 'declared-enabled-not-runtime-health', selectionIsNotHealthProof: true } }
    })
  } catch (error) {
    return incomplete(signal?.aborted ? 'AURA_ABORTED' : typeof error?.code === 'string' && error.code.startsWith('AURA_') ? error.code : 'AURA_SOURCE_INVALID')
  }
}

/** Bind only behind the authenticated worker; client authorization markers must be stripped there. */
/**
 * THE GUEST DOOR'S OWN RATE LIMIT (`POST /_host/aumlok/redeem` without a session). It lives here, in the mirror object,
 * under its own key: physically apart from the owner's sign-in lockout, the HEAD passkey gate and the AUMLOK WebAuthn
 * counters, so no number of guest failures can ever move any of them. Per caller address: five failures in fifteen
 * minutes lock that address for an hour.
 *
 * BOUNDED AND SELF-HEALING. The table holds at most `maxSubjects` rows (one storage value, at most `maxFailures` times
 * per row), so neither memory nor storage can grow with the number of callers. A row expires on its own once its
 * attempts are older than the window and no lock is running. A row goes IDLE `idleMs` after its last attempt; when
 * the table is full, the oldest idle row is evicted before a new address is refused, so many addresses that each sent
 * one request cannot keep invitees out for longer than `idleMs`. A row under an active lock is never idle and never
 * evicted early. Only when every row is locked or was used within `idleMs` is a new address refused (`GUEST_DOOR_BUSY`,
 * with the time until the first row frees up). The owner never comes through this door.
 *
 * ONE ROW PER NETWORK, PENALTIES CAPPED. The worker names a row by the caller's network (an IPv4 address, or an IPv6
 * /64), so one line cannot fill the table with its own addresses. At most `maxLocked` rows may be under a penalty at
 * once, so at least `maxSubjects - maxLocked` rows are always unlocked and free up within `idleMs` of their last
 * attempt: honest new networks always get in on the idle clock. A locked row keeps its whole penalty and is never
 * evicted. When the penalty rows are all taken, an attempt that would earn a new penalty is refused instead, counting
 * nothing (`GUEST_DOOR_BUSY`, with the time until the first penalty ends): that network has had `maxFailures - 1`
 * attempts on its row and gets no more while it holds that row.
 */
export const GUEST_GATE_KEY = 'guest-gate:v1'
export const GUEST_GATE_LIMITS = Object.freeze({ maxFailures: 5, windowMs: 15 * 60_000, lockoutMs: 60 * 60_000, maxSubjects: 256, idleMs: 60_000, maxLocked: 192 })
const GUEST_SUBJECT = /^guest-redeem:[0-9a-f]{64}$/

/** The oldest idle row (no running lock, last attempt at least `idleMs` ago), and how long until the first row frees up. */
function guestGateRoom(rows, now) {
  let victim = null, oldest = Infinity, wait = Infinity
  for (const [key, entry] of rows) {
    const last = entry.failedAt.length ? Math.max(...entry.failedAt) : 0
    const freeAt = Math.max(entry.lockedUntil, last + GUEST_GATE_LIMITS.idleMs)
    if (freeAt <= now) { if (last < oldest) { victim = key; oldest = last } }
    else wait = Math.min(wait, freeAt - now)
  }
  return { victim, retryAfterMs: victim === null ? wait : 0 }
}

/**
 * 'reserve' is the door's only admission: in ONE transaction it refuses a locked address (or a new one when the table is
 * full and no row is idle) and otherwise counts this attempt, so concurrent requests can never all pass one check. Every
 * attempt counts, a successful check included: five per address per fifteen minutes. 'check' and 'failure' remain for
 * reads and tests; 'check' never evicts.
 *
 * LEGACY PENALTIES (`legacy`, optional). Before rows stood for networks, a row stood for the caller's raw address, so a
 * penalty set then sits under that old subject. The worker sends the old subject too, and in the SAME transaction an
 * active penalty on it refuses this attempt exactly as its own row would (`GATE_LOCKOUT_ACTIVE`, its remaining wait,
 * counting nothing), so a deploy never hands a penalised address a fresh start. The check only READS: it never creates,
 * counts on or extends a legacy row, so legacy rows cannot grow; they leave the table on their own as they expire.
 * DELETE the `legacy` parameter, this check and the worker's `legacy` field in any deploy made more than two hours
 * after the first deploy carrying the /64 rows: every legacy penalty was set before that deploy (or by an isolate
 * still running the old code just after it) and lasts at most `lockoutMs` (one hour).
 */
export async function guestGateDecision(storage, action, subject, now = Date.now(), legacy = null) {
  if (!['check', 'failure', 'reserve'].includes(action) || !GUEST_SUBJECT.test(subject ?? '')) fail('GUEST_GATE_REQUEST_INVALID')
  if (legacy !== null && !GUEST_SUBJECT.test(legacy)) fail('GUEST_GATE_REQUEST_INVALID')
  return storage.transaction(async tx => {
    const stored = await tx.get(GUEST_GATE_KEY)
    let gate = createGateLockoutStore(GUEST_GATE_LIMITS, stored === undefined ? [] : stored)
    let result = gate.checkSubject(subject, now)
    // An active penalty under the caller's old raw-address subject still holds (read only; see LEGACY PENALTIES above).
    if (result.ok && legacy !== null && legacy !== subject) {
      const old = gate.checkSubject(legacy, now)
      if (!old.ok) result = { ok: false, code: 'GATE_LOCKOUT_ACTIVE', status: 429, retryAfterMs: old.retryAfterMs, legacy: true }
    }
    const rows = gate.snapshotSubjects()
    const known = rows.some(([key]) => key === subject)
    // An attempt that would earn this row a penalty while every penalty row is taken is refused, counting nothing.
    if (result.ok && action !== 'check' && (result.failures ?? 0) + 1 >= GUEST_GATE_LIMITS.maxFailures) {
      const locks = rows.filter(([, entry]) => entry.lockedUntil > now).map(([, entry]) => entry.lockedUntil - now)
      if (locks.length >= GUEST_GATE_LIMITS.maxLocked) result = { ok: false, code: 'GUEST_DOOR_BUSY', status: 429, retryAfterMs: Math.min(...locks) }
    }
    if (result.ok && !known && rows.length >= GUEST_GATE_LIMITS.maxSubjects) {
      const room = guestGateRoom(rows, now)
      if (room.victim === null) result = { ok: false, code: 'GUEST_DOOR_BUSY', status: 429, retryAfterMs: room.retryAfterMs }
      else if (action !== 'check') gate = createGateLockoutStore(GUEST_GATE_LIMITS, rows.filter(([key]) => key !== room.victim))
    }
    // A refusal above counts nothing.
    if (result.ok && action === 'failure') result = gate.recordFailure(subject, now)
    else if (result.ok && action === 'reserve') {
      // This attempt is admitted (it passed the check above); counting it may lock the NEXT one.
      const counted = gate.recordFailure(subject, now)
      result = counted.code === 'GATE_LOCKOUT_CAPACITY' ? { ok: false, code: 'GUEST_DOOR_BUSY', status: 429 } : { ok: true, admitted: true }
    }
    await tx.put(GUEST_GATE_KEY, gate.snapshotSubjects())
    return result
  })
}

import { holderStartUp } from './world-lease.mjs' // HOLDER hook: her body's record is read once at object start
export class MirrorDO {
  constructor(state, env) { this.state = state; this.storage = state.storage; this.env = env; this.queue = Promise.resolve(); this.notificationPending = false; this.snapshotReaders = 0; this.diagnostics = createEdgeDiagnostics('mirror-object-instance')
    this.queue = holderStartUp(this.storage) } // HOLDER hook: every request waits behind it (enqueue); with no holder row it is one get
  // One bounded attempt, no outbox or retries. Further events are dropped while a
  // request remains unsettled, even after timeout. Polling recovers missed delivery.
  async notifyHead(update, seedId) {
    if (!this.env?.HEAD || this.notificationPending) return
    this.notificationPending = true
    const controller = new AbortController()
    let timer, expired = false
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => { expired = true; controller.abort(); reject(new Error('MIRROR_UPDATE_TIMEOUT')) }, MIRROR_UPDATE_LIMITS.timeoutMs)
    })
    const operation = (async () => {
      try {
        const response = await this.env.HEAD.get(this.env.HEAD.idFromName('node-main-v1')).fetch(new Request('https://x61.internal/_head/mirror-updated', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId },
          body: JSON.stringify(update), signal: controller.signal,
        }))
        // No response contents are needed, and a noncooperative late response is discarded.
        void response.body?.cancel().catch(() => {})
        if (expired || !response.ok) throw new Error('MIRROR_UPDATE_UNAVAILABLE')
      } finally { this.notificationPending = false }
    })()
    try { await Promise.race([operation, timeout]) }
    finally { clearTimeout(timer) }
  }
  fetch(request) { return this.diagnostics.observe(request, () => this.handleRequest(request)) }
  // JOIN hook: one thread step at a time in this object, and a save that is waiting goes first. A home
  // save is counted from its arrival to its answer (a counter only: no storage operation, no change to its answer). A
  // `/_mirror/thread` call takes the one thread turn, then, while saves are waiting, lets them go first (at most
  // THREAD_SAVE_FIRST_MS), and only then joins the queue. So a save waits behind at most ONE import step, however many
  // importers (isolates, pages) there are.
  handleRequest(request) {
    const { pathname } = new URL(request.url) // JOIN hook
    if (request.method === 'POST' && pathname === '/_mirror/thread') return this.threadTurn(request) // JOIN hook
    if (request.method !== 'POST' || pathname !== '/_mirror/delta') return this.enqueue(request) // JOIN hook
    this.savesWaiting = (this.savesWaiting ?? 0) + 1 // JOIN hook
    const answered = this.enqueue(request) // JOIN hook
    const settle = () => { // JOIN hook
      this.savesWaiting -= 1 // JOIN hook
      if (this.savesWaiting === 0) for (const wake of (this.saveWaiters ?? []).splice(0)) wake() // JOIN hook
    } // JOIN hook
    answered.then(settle, settle) // JOIN hook
    return answered // JOIN hook
  }
  async threadTurn(request) { // JOIN hook
    const previous = this.threadQueue ?? Promise.resolve() // JOIN hook
    let release // JOIN hook
    this.threadQueue = new Promise(resolve => { release = resolve }) // JOIN hook
    try { // JOIN hook
      await previous // JOIN hook
      if (this.savesWaiting > 0) await new Promise(resolve => { // JOIN hook
        const timer = setTimeout(resolve, THREAD_SAVE_FIRST_MS) // JOIN hook
        ;(this.saveWaiters ??= []).push(() => { clearTimeout(timer); resolve() }) // JOIN hook
      }) // JOIN hook
      return await this.enqueue(request) // JOIN hook
    } finally { release() } // JOIN hook
  }
  enqueue(request) {
    const operation = this.queue.then(async () => {
      if (request.headers.get('x-x6-internal-authorized') !== '1') return reply({ ok: false, code: 'UNAUTHORIZED' }, 401)
      try {
        const url = new URL(request.url)
        const path = url.pathname
        if (path === '/_mirror/wake-read' || path === '/_mirror/wake-checkpoint') {
          if (url.search || url.href.endsWith('?') || url.hash || request.method !== 'POST'
            || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return reply({ ok: false, code: 'MIRROR_WAKE_REQUEST_INVALID' }, 400)
          const seedId = request.headers.get('x-x6-bootstrap-seed')
          if (!auraHash(seedId)) return reply({ ok: false, code: 'BOOTSTRAP_REQUIRED' }, 503)
          const input = await readBoundedBootstrapJson(request, 4096)
          if (path === '/_mirror/wake-read') {
            if (!auraObject(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'path')) return reply({ ok: false, code: 'MIRROR_WAKE_REQUEST_INVALID' }, 400)
            return reply(await readMirrorWakeText(this.storage, { path: input.path, seedId, signal: request.signal, env: this.env }))
          }
          return reply(await appendMirrorWakeCheckpoint(this.storage, input, { seedId, signal: request.signal, mode: leaseMode(this.env) /* JOIN hook */, slots: slotRetireMode(this.env) /* JOIN hook */ }))
        }
        if (path === '/_mirror/estate' && (request.method !== 'GET' || url.href.includes('?') || url.hash
          || request.body !== null || request.headers.has('transfer-encoding') || request.headers.has('content-length') && request.headers.get('content-length') !== '0')) return reply({ ok: false, code: 'ESTATE_REQUEST_INVALID' }, 400)
        if (path === '/_mirror/diagnostics' && (request.method !== 'GET' || url.href.includes('?') || url.hash
          || request.body !== null || request.headers.has('transfer-encoding') || request.headers.has('content-length') && request.headers.get('content-length') !== '0')) return reply({ ok: false, code: 'DIAGNOSTICS_REQUEST_INVALID' }, 400)
        if (path === '/_mirror/repo-read') {
          if (url.search || url.href.endsWith('?')) return reply({ ok: false, code: 'NOT_FOUND' }, 404)
          if (request.method !== 'POST') return reply({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return reply({ ok: false, code: 'INVALID_MIRROR_JSON' }, 400)
          if (!auraHash(request.headers.get('x-x6-bootstrap-seed'))) return reply({ ok: false, code: 'BOOTSTRAP_REQUIRED' }, 503)
          const input = await readBoundedBootstrapJson(request, 8192)
          if (!auraObject(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'path')) return reply({ ok: false, code: 'INVALID_MIRROR_REPO_REQUEST' }, 400)
          return reply(await readMirrorRepoFile(this.storage, { path: input.path, seedId: request.headers.get('x-x6-bootstrap-seed'), signal: request.signal }))
        }
        if (path === '/_mirror/prediction-status' || path === '/_mirror/aura-inputs') {
          if (!/^[0-9a-f]{64}$/.test(request.headers.get('x-x6-bootstrap-seed') || '')) return reply({ ok: false, code: 'BOOTSTRAP_REQUIRED' }, 503)
          if (url.search) return reply({ ok: false, code: 'NOT_FOUND' }, 404)
          if (request.method !== 'GET') return reply({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
        }
        if (path.startsWith('/_mirror/archive-')) { // every /_mirror/archive-* path goes to cold-archive.mjs, which answers 404 for an unknown one
          const body = request.method === 'POST' ? await readBoundedBootstrapJson(request) : null
          return await handleInternalMirrorArchiveRoute(this.storage, path, body, { mirrorBootstrapStatus })
        }
        if (path === '/_mirror/guest-gate') {
          if (request.method !== 'POST' || url.search || url.hash) return reply({ ok: false, code: 'GUEST_GATE_REQUEST_INVALID' }, 400)
          const input = await readBoundedBootstrapJson(request, 1024)
          // `{ action, subject }`, plus `legacy` (the old raw-address subject) while legacy penalties may still run.
          const keys = auraObject(input) ? Object.keys(input).sort().join() : ''
          if (keys !== 'action,subject' && keys !== 'action,legacy,subject') return reply({ ok: false, code: 'GUEST_GATE_REQUEST_INVALID' }, 400)
          return reply({ ok: true, gate: await guestGateDecision(this.storage, input.action, input.subject, undefined, input.legacy ?? null) })
        }
        if (path === '/_mirror/bootstrap-status' && request.method === 'GET') return reply(await mirrorBootstrapStatus(this.storage))
        if (path === '/_mirror/bootstrap' && request.method === 'POST') return reply(await bootstrapMirror(this.storage, await readEnvelope(request)))
        const bootstrap = await mirrorBootstrapStatus(this.storage)
        if (bootstrap.phase !== 'ready' || request.headers.get('x-x6-bootstrap-seed') !== bootstrap.seedId) return reply({ ok: false, code: 'BOOTSTRAP_REQUIRED', phase: bootstrap.phase }, 503)
        // ANYBROWSER hook: the world budget, internal only: the Worker forwards no public request to this path (it answers 501),
        // ANYBROWSER hook: and like every route here it needs the internal mark and this world's seed. One transaction per call.
        if (path === '/_mirror/world/budget') { // ANYBROWSER hook
          if (request.method !== 'POST' || url.search || url.href.endsWith('?') || url.hash || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return reply({ ok: false, code: 'WORLD_BUDGET_REQUEST_INVALID' }, 400) // ANYBROWSER hook
          // ANYBROWSER hook: `{op, kind, bytes}` or `{op, kind, bytes, ref}`, nothing else; op check|charge|count|release (release needs a ref).
          const input = worldBudgetInput(await readBoundedBootstrapJson(request, 1024)) // ANYBROWSER hook
          if (!input) return reply({ ok: false, code: 'WORLD_BUDGET_REQUEST_INVALID' }, 400) // ANYBROWSER hook
          return reply({ ok: true, budget: await worldBudgetCall(this.storage, { ...input, now: Date.now(), limits: worldBudgetLimits(this.env) }) }) // ANYBROWSER hook
        } // ANYBROWSER hook
        // ANYBROWSER hook: the world lease, internal only (the Worker forwards an owner's `{input, ownerApproved}`; it sets
        // ANYBROWSER hook: ownerApproved true only after his passkey approved that exact request). One transaction per call.
        if (path === '/_mirror/lease') { // ANYBROWSER hook
          if (request.method !== 'POST' || url.search || url.href.endsWith('?') || url.hash || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return reply({ ok: false, code: 'LEASE_REQUEST_INVALID' }, 400) // ANYBROWSER hook
          let body // ANYBROWSER hook
          try { body = await readBoundedBootstrapJson(request, 1024) } catch (error) { if (error?.status === 400) return reply({ ok: false, code: 'LEASE_REQUEST_INVALID' }, 400); throw error } // ANYBROWSER hook
          if (!auraObject(body) || Object.keys(body).sort().join() !== 'input,ownerApproved' || typeof body.ownerApproved !== 'boolean') return reply({ ok: false, code: 'LEASE_REQUEST_INVALID' }, 400) // ANYBROWSER hook
          const leased = await leaseAction(this.storage, body.input, { now: () => Date.now() /* JOIN hook: read after the row */, ownerApproved: body.ownerApproved === true, homeFreeze: homeFreezeMode(this.env) }) // ANYBROWSER hook
          return reply(leased.body, leased.status) // ANYBROWSER hook
        } // ANYBROWSER hook
        // ANYBROWSER hook: the thread log's MIRROR half, internal only: `{op, input, home?}` (3 MiB at most; `home` only beside an
        // ANYBROWSER hook: import). ONE transaction: the lease, the budget, the commit, `wrote`, and the pending home.
        if (path === '/_mirror/thread') { // ANYBROWSER hook
          if (request.method !== 'POST' || url.search || url.href.endsWith('?') || url.hash || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return reply({ ok: false, code: 'THREAD_REQUEST_INVALID' }, 400) // ANYBROWSER hook
          const body = await readBoundedBootstrapJson(request, 3 * 1024 * 1024) // ANYBROWSER hook
          const keys = auraObject(body) ? Object.keys(body).sort().join() : '' // ANYBROWSER hook
          if ((keys !== 'input,op' && keys !== 'home,input,op') || typeof body.op !== 'string' || (keys === 'home,input,op' && (body.op !== 'import' || !validHomeInput(body.home)))) return reply({ ok: false, code: 'THREAD_REQUEST_INVALID' }, 400) // ANYBROWSER hook
          const mode = leaseMode(this.env), limits = worldBudgetLimits(this.env) // ANYBROWSER hook
          let answer // ANYBROWSER hook
          try { // ANYBROWSER hook
            answer = await this.storage.transaction(async tx => { // ANYBROWSER hook
              // JOIN hook: the clock is read inside this transaction, and the lease is judged on a clock read
              // JOIN hook: AFTER its row was read (checkLease), never on one captured before a wait.
              const now = Date.now() // JOIN hook
              let holder = null, judged = null // ANYBROWSER hook: the lease holder (and its reference) this commit was judged under
              let heldUntil = null // JOIN hook: the lease's expiry BEFORE this transaction touched it (the earliest, if judged twice)
              const result = await threadCommit(tx, body.op, body.input, { now, limits: threadLimits(this.env), // ANYBROWSER hook
                checkLease: async (t, ref) => { const verdict = await checkLease(t, ref, () => Date.now(), { mode }); if (verdict.ok) { holder = verdict.clientId; judged = ref; heldUntil = heldUntil === null ? verdict.heldUntil ?? null : Math.min(heldUntil, verdict.heldUntil) } return verdict }, // ANYBROWSER hook (heldUntil)
                budget: { charge: (t, call) => chargeWorldBudgetIn(t, { ...call, now, limits }) } }) // ANYBROWSER hook
              const committed = result.status === 200 && ['APPLIED', 'IMPORTED', 'RETRACTED'].includes(result.body?.code) // ANYBROWSER hook
              if (committed) await noteWrote(tx, holder, now) // ANYBROWSER hook: a committed append, import or retract is a write
              if (committed && body.op === 'import' && body.home) await recordHomePending(tx, body.home, await readFence(tx), now) // ANYBROWSER hook: recorded only
              // JOIN hook: the index answers what full status no longer carries: the lease, her pending home, and the counts.
              if (body.op === 'index' && result.status === 200) { // JOIN hook
                const world = await worldStatus(tx, { lease: await leaseSummary(tx, now), freeze: homeFreezeMode(this.env) }) // JOIN hook
                return { status: 200, body: { ...result.body, home: world.home, lease: world.lease, world: { threads: world.threads, tailBytes: world.tailBytes, retired: world.retired } } } // JOIN hook
              } // JOIN hook
              // JOIN hook (MUST 2b; job 5, M1): the last word before a write returns success, inside its transaction. Its
              // JOIN hook: LAST await reads the lease row (still this lease?). After it nothing awaits: the clock is read once
              // JOIN hook: more and the lease's PRE-WRITE expiry must still be ahead of it (never the staged extension), and a
              // JOIN hook: request already cancelled is refused; either rolls every staged write back, the extension included.
              if (THREAD_WRITE_OPS.has(body.op) && result.status === 200) { // JOIN hook
                const named = judged ? await leaseStillNamed(tx, judged) : true // JOIN hook: the transaction's last await
                if (judged && !(named && leaseHeldAt(heldUntil, () => Date.now()))) throw threadRollback(410, 'WRITER_GONE') // JOIN hook
                if (request.signal?.aborted) throw threadRollback(503, 'THREAD_REQUEST_CANCELLED') // JOIN hook (after the last await)
              } // JOIN hook
              // JOIN hook: only a write that committed bytes extends the lease. A write judged under a lease and then
              // JOIN hook: refused (an answer, not a throw: 503 THREAD_MOVED, 400, 409, 507), or answered 200 with nothing
              // JOIN hook: written, rolls back WITH its own status and body: the lease row stays exactly as it was.
              if (judged && !(result.status === 200 && LEASE_EXTENDING_CODES.has(result.body?.code))) throw threadAnswerRollback(result) // JOIN hook
              return result // ANYBROWSER hook
            }) // ANYBROWSER hook
          } catch (error) { // ANYBROWSER hook: rolled back, nothing committed
            if (error?.threadRollback) return reply(error.threadRollback.body, error.threadRollback.status) // JOIN hook
            return reply({ ok: false, code: 'THREAD_STORAGE_UNAVAILABLE' }, 503) // ANYBROWSER hook
          } // ANYBROWSER hook
          return reply(answer.body, answer.status) // ANYBROWSER hook
        } // ANYBROWSER hook
        if (path === '/_mirror/estate') return reply(await this.storage.transaction(async tx => {
          // Read metadata only; never initialize fences or materialize file chunks.
          const fence = await tx.get(FENCE)
          if (!validCloudBase(fence) || fence.lineageId !== bootstrap.lineageId) fail('ESTATE_STATE_UNAVAILABLE', 503)
          const entries = await tx.list({ prefix: ENTRY, limit: MIRROR_LIMITS.entries + 1 })
          if (entries.size > MIRROR_LIMITS.entries) fail('ESTATE_STATE_UNAVAILABLE', 503)
          // A row matching the secret-path rule (hiddenStoredPath), admitted under an older rule, is never served, so it is
          // not counted as hers: it is reported apart, as a number and one plain line, never as a path. Every row is still
          // checked and bounded; only entry metadata is listed here (deletion markers are not read by the estate).
          let fileCount = 0, directoryCount = 0, bytes = 0, withheldEntries = 0
          for (const metadata of entries.values()) {
            request.signal.throwIfAborted()
            bytes += size(JSON.stringify(metadata))
            if (bytes > MIRROR_LIMITS.metadataBytes || !metadata || Object.hasOwn(metadata, 'b64') || !['file', 'dir'].includes(metadata.kind)) fail('ESTATE_STATE_UNAVAILABLE', 503)
            if (hiddenStoredPath(metadata.path)) withheldEntries++
            else if (metadata.kind === 'file') fileCount++
            else directoryCount++
          }
          return { ok: true, schema: 'aukora.mirror-estate.v1', entryCount: entries.size - withheldEntries, fileCount, directoryCount, highWater: fence.revision, snapshotETag: snapshotETag(fence),
            withheldEntries, pathRuleNote: `entries withheld by the secret-path rule: ${String(withheldEntries)}` }
        }))
        if (path === '/_mirror/diagnostics') return reply({ ok: true, ...this.diagnostics.snapshot() })
        if (path === '/_mirror/aura-inputs') {
          const head = { ballId: request.headers.get('x-x6-aura-head'), epoch: Number(request.headers.get('x-x6-aura-epoch')) }
          const now = Number(request.headers.get('x-x6-aura-now'))
          if (!/^(0|[1-9][0-9]*)$/.test(request.headers.get('x-x6-aura-epoch') || '')
            || !/^(0|[1-9][0-9]*)$/.test(request.headers.get('x-x6-aura-now') || '')) return reply({ ok: false, code: 'AURA_REQUEST_INVALID' }, 400)
          const rawFence = request.headers.get('x-x6-aura-fence')
          if (rawFence !== null && rawFence.length > 256) return reply({ ok: false, code: 'AURA_REQUEST_INVALID' }, 400)
          return reply(await readMirrorAuraInputs(this.storage, { seedId: bootstrap.seedId, head, now, signal: request.signal,
            includeFacts: request.headers.get('x-x6-aura-facts') === '1',
            receiptsHeadOnly: request.headers.get('x-x6-aura-receipts-head') === '1', // NOSTR hook (the Worker strips every x-x6-aura-* header from public requests)
            checkpointSignerPin: this.env?.CHECKPOINT_SIGNER_PIN, checkpointSignerPolicy: this.env?.CHECKPOINT_SIGNER_POLICY,
            ...(rawFence === null ? {} : { checkFence: JSON.parse(rawFence) }) }))
        }
        if (path === '/_mirror/prediction-status') return reply({ ok: true, seedId: bootstrap.seedId, prediction: await readPredictionReceipts(this.storage) })
        return await handleMirrorRequest(request, this.storage, { authorized: true, writerLease: leaseMode(this.env) /* ANYBROWSER hook */, homeFreeze: homeFreezeMode(this.env) /* ANYBROWSER hook */, slotRetire: slotRetireMode(this.env) /* JOIN hook */, reserveSnapshot: () => {
          if (this.snapshotReaders >= MIRROR_LIMITS.snapshotReaders) fail('MIRROR_SNAPSHOT_BUSY', 503)
          this.snapshotReaders++
          return () => { this.snapshotReaders-- }
        }, onUpdated: update => {
          const delivery = this.notifyHead(update, bootstrap.seedId)
          // Keep only this bounded delivery alive where the host offers request-lifetime support.
          if (typeof this.state.waitUntil === 'function') this.state.waitUntil(delivery.catch(() => {}))
          return delivery
        } })
      } catch (error) { return reply({ ok: false, code: error.code ?? 'BOOTSTRAP_STORAGE_FAILED' }, error.status ?? 503) }
    })
    this.queue = operation.then(response => response.mirrorDetachedSnapshot ? undefined : response.mirrorCompletion).catch(() => {})
    return operation
  }
}
