/** Content-addressed cold R2 archive, owner-bound composite head commitment (D4b anti-silence),
 * and isolated fail-stop Durable Object rebuild drill for Aukora.
 *
 * Pure WebCrypto + standard Web APIs so identical code executes on Cloudflare Workers and Node tests.
 * Never reconstructs, defaults, or resets an owner binding: missing or divergent owner state fails closed.
 */
import { canonicalJson, verifyHybridEnvelopeV2 } from './owner-grant-policy.mjs'
import { AUMLOK_STORAGE_KEY, aumlokClass3Binding, createAumlokStore } from './aumlok.mjs'
import { legacyManifestPreimage, validateManifestStructure } from '../../../server/ball-manifest.mjs'
import { secretShapedPart } from './mirror-secret-paths.mjs'

export const COLD_ARCHIVE_SCHEMA = 'aukora.cold-archive.v1'
export const COMPOSITE_HEAD_SCHEMA = 'aukora.x61.composite-head.v1'
export const PINNED_HASH_ALGORITHM = 'sha256'
export const LIVE_PRODUCTION_DO_NAME = 'node-main-v1'

const HEAD_BOOTSTRAP_KEY = 'bootstrap:v1'
const MIRROR_BOOTSTRAP_KEY = 'mirror:bootstrap:v1'
const MIRROR_PREFIX = 'mirror:v2:'
const MIRROR_ENTRY = `${MIRROR_PREFIX}entry:`
const MIRROR_CHUNK = `${MIRROR_PREFIX}chunk:`
const MIRROR_FENCE = `${MIRROR_PREFIX}global-fence`
const MIRROR_RESET = `${MIRROR_PREFIX}reset:`
const MIRROR_CHUNK_CHARS = 96 * 1024
const HEAD_BLOB_CHUNK_CHARS = 24000
const RECEIPTS_PATH = '/dsh/home/auma/seed/receipts.v3.jsonl'
const CHECKPOINTS_PATH = '/dsh/home/auma/seed/checkpoints.v1.jsonl'
const CHECKPOINT_DOMAIN = 'aukora.x5.edge-head.v1\0'
const HEX_64 = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DRILL_NAME_RE = /^x61-drill-[a-z0-9-]{4,64}$/
// the only object names a drill attempt writes: `x61-drill-` and its attempt id, nothing a caller chose.
const DRILL_OBJECT_NAME_RE = /^x61-drill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const drillObjectNameOf = attemptId => `x61-drill-${attemptId}`
// the only bucket objects a drill may read: the full snapshots the service itself wrote (`snapshots/epoch-N-<ballId>.json`).
const SNAPSHOT_KEY_RE = /^snapshots\/epoch-(?:0|[1-9][0-9]{0,15})-[0-9a-f]{64}\.json$/
// any valid origin; the AUMLOK store needs one to be built, and loading its state never looks at it.
const OWNER_RECORD_CHECK_ORIGIN = 'https://owner-record-check.invalid'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const archiveError = (code, status = 400, extra = {}) => Object.assign(new Error(code), { code, status, ...extra })
const refuse = (code, status = 400, extra = {}) => { throw archiveError(code, status, extra) }

const bytesToHex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
const hexToBytes = hex => {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) refuse('ARCHIVE_HEX_INVALID', 400)
  return Uint8Array.from(hex.match(/../g) ?? [], pair => parseInt(pair, 16))
}

export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes))
}

const MIRROR_ENTRIES_CEILING = 20000
/**
 * the most a one-piece export or drill may carry, base64 file bodies plus module code. At that size the
 * measured cost model gives about 64 MiB of Worker memory (half the isolate's limit), and the drill's apply body stays under
 * the 34 MiB bootstrap request cap. Above it, export and drill refuse with ARCHIVE_TOO_LARGE_FOR_ONE_PIECE before any body is
 * read or written.
 */
export const ONE_PIECE_MAX = 16 * 1024 * 1024

/**
 * THE rule for "fits in one piece", judged on a serialized snapshot's UTF-8 byte count, the size the bucket
 * stores. Export applies it to the exact bytes it is about to write, a drill by key to the stored object's size, and status
 * to serializedBundleBytesAtMost, which is never below the bytes export would write. Export and the live drill also apply
 * it first to a floor (base64 bodies plus module bytes): a floor that does not fit means the real bytes cannot either.
 * @param {unknown} serializedBytes A serialized snapshot's byte count, or a bound on it.
 * @returns {boolean} True only for a safe, non-negative integer at most ONE_PIECE_MAX.
 */
export function fitsInOnePiece(serializedBytes) {
  return Number.isSafeInteger(serializedBytes) && serializedBytes >= 0 && serializedBytes <= ONE_PIECE_MAX
}
const refuseUnlessOnePiece = serializedBytes => {
  if (!fitsInOnePiece(serializedBytes)) refuse('ARCHIVE_TOO_LARGE_FOR_ONE_PIECE', 413, { limit: ONE_PIECE_MAX })
}

/** a string's UTF-8 byte count, without encoding it. A lone surrogate counts 3, as TextEncoder writes U+FFFD. */
function utf8ByteLength(text) {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}
// the UTF-8 bytes JSON.stringify writes for a value (a value it drops, undefined, is counted as `null`).
const jsonByteLength = value => utf8ByteLength(JSON.stringify(value) ?? 'null')
/**
 * the UTF-8 bytes JSON.stringify writes for a string, counted without building the escaped copy (which can be
 * six times the string). Quotes included. `"` `\` and \b \f \n \r \t take 2; any other control character and a lone
 * surrogate take 6 (\uXXXX); everything else its UTF-8 length (U+2028 and U+2029 are written raw).
 */
export function jsonStringByteLength(text) {
  let bytes = 2
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x0c || unit === 0x0a || unit === 0x0d || unit === 0x09) bytes += 2
    else if (unit < 0x20) bytes += 6
    else if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++ }
    else if (unit >= 0xd800 && unit <= 0xdfff) bytes += 6
    else bytes += 3
  }
  return bytes
}
// the most bytes JSON.stringify writes for any number ("-0.0000012345678901234567" is 25).
const NUMBER_JSON_MAX_BYTES = 25
// stands in for a file's sha256 (always 64 hex characters) when its entry is measured without its body.
const SHA256_PLACEHOLDER = '0'.repeat(64)

/**
 * what a status, or the size guard in front of export and drill, may read. Each is checked against what
 * the store's own metadata says BEFORE the read, and against the bytes actually read WHILE reading; over a limit the
 * answer is the named 413 code, never a partial summary. A home's two seed files and its module code
 * normally sit far below these limits.
 */
// Each of the two seed files (receipts, checkpoints): decoded bytes. The Mirror's Aura reader holds receipts to the same 4 MiB.
export const STATUS_SEED_FILE_MAX_BYTES = 4 * 1024 * 1024
// Chunk rows a seed file at that size takes (its base64 in MIRROR_CHUNK_CHARS pieces): 57.
export const STATUS_SEED_FILE_MAX_CHUNKS = Math.ceil(4 * Math.ceil(STATUS_SEED_FILE_MAX_BYTES / 3) / MIRROR_CHUNK_CHARS)
// HEAD's manifest (UTF-8 bytes). It never leaves HEAD for a status; HEAD returns the validated facts the composite needs.
export const STATUS_MANIFEST_MAX_BYTES = 4 * 1024 * 1024
// Modules named by the manifest (the bootstrap admits at most 256).
export const STATUS_MODULE_COUNT_MAX = 256
// One module's code (UTF-8 bytes). Modules are read one at a time, counted and dropped.
export const STATUS_MODULE_MAX_BYTES = 2 * 1024 * 1024
// Entry and reset rows' metadata, serialized. The Mirror's writer holds the same rows to 8 MiB by a slightly smaller
// measure (it leaves out `path` as a key and the chunk counters, at most 64 bytes a row over its 20,000 rows).
export const STATUS_METADATA_MAX_BYTES = 10 * 1024 * 1024
// 1d: rows per listing page while that metadata is counted. Past the budget, at most this many more values are held
// (each no larger than the storage's own value limit).
export const STATUS_METADATA_PAGE_ROWS = 64
// Each durable object reply the Worker reads for a status or a size guard.
export const STATUS_REPLY_MAX_BYTES = 256 * 1024

// the LATEST pointer is a few hundred bytes; the estate route reads it under the same cap.
const LATEST_POINTER_MAX = 8192
// how long a drill waits for each disposable object to prove itself empty.
const DRILL_WIPE_DEADLINE_MS = 10000
/**
 * how long a drill waits, in all, for its two applies and its two read-backs. Past it, both objects are
 * cleaned up and the drill answers DRILL_DEADLINE_EXCEEDED.
 */
const DRILL_DEADLINE_MS = 120000
/**
 * the one row a drill keeps in a disposable object of its own, `{ drillId, ended }`. An apply writes it
 * (ended false) in the same transaction as its rows, into an object that is otherwise empty, and so reserves the object for
 * its drill. A wipe of an object reserved by another drill touches nothing. A wipe sent while this drill's apply to that
 * object has not answered, and finding that apply not yet committed, writes it with ended true, so that apply, when it
 * lands, writes no row: it is refused and only removes the mark (the drill's reply says the mark is left). Every other
 * wipe leaves the object with no row at all.
 */
const DRILL_MARK_KEY = 'archive-drill:v1'
const DRILL_MARK_SCHEMA = 'aukora.archive-drill-mark.v1'
// a wipe that could not empty its object counts what is left, up to this many rows (listing returns values).
const DRILL_REMAINING_ROWS_COUNT_MAX = 64
const NO_STORE = { 'cache-control': 'no-store' }
const MIRROR_ROOTS = ['/dsh/home', '/dsh/workspace']
const MIRROR_SECRET_NAMES = new Set(['.credentials.yaml', 'credentials.yaml', 'session.cap', '.afferent-probe', 'ed25519-keypair.json', '.credentials', '.ssh', '.aws', '.transport'])
const mirrorDigest = value => sha256Hex(JSON.stringify(value))

function validateMirrorPath(p) {
  if (typeof p !== 'string' || encoder.encode(p).length > 4096 || /[\\\0-\x1f\x7f]/.test(p)) refuse('INVALID_MIRROR_PATH', 400)
  const parts = p.split('/')
  if (parts[0] !== '' || parts.slice(1).some(part => !part || part === '.' || part === '..' || encoder.encode(part).length > 255)) {
    refuse('INVALID_MIRROR_PATH', 400)
  }
  if (!MIRROR_ROOTS.some(root => p.startsWith(root + '/'))) refuse('INVALID_MIRROR_PATH', 400)
  const dumpExcluded = p.startsWith('/dsh/home/auma/snapshots/') && p !== '/dsh/home/auma/snapshots/LATEST.json'
  if (p === '/dsh/home/balls' || p.startsWith('/dsh/home/balls/') || dumpExcluded
    || parts.some(part => MIRROR_SECRET_NAMES.has(part) || part.startsWith('.env') || part.startsWith('.aukora-') || part === '.DS_Store' || part === '.conflict-backup')) {
    refuse('INVALID_MIRROR_PATH', 400)
  }
  return p
}

/**
 * a stored mirror row this archive's own rule above admits, whose path matches the cloud mirror's
 * secret-path rule (a credentials temp, lock or backup copy, a `pepper.v1` path), written before that rule. The mirror never
 * serves such a row, so the archive SKIPS it: never archived, never refused (a refusal would stop every archive of the
 * live mirror). A row the rule above refuses is still refused, as before.
 */
function archiveSkipsPath(p) {
  if (typeof p !== 'string' || !p.split('/').some(secretShapedPart)) return false
  try { validateMirrorPath(p) } catch { return false }
  return true
}

/** The live archive-state reader's rule: skip what archiveSkipsPath skips; refuse any other secret-shaped path. */
function archiveWithholdsPath(p) {
  if (typeof p !== 'string' || !p.split('/').some(secretShapedPart)) return false
  if (archiveSkipsPath(p)) return true
  validateMirrorPath(p) // throws INVALID_MIRROR_PATH: archiveSkipsPath declined it because this archive's rule refuses it
  return false
}

/**
 * a mirror list never cut short. The rows are listed one past the ceiling; a store holding more than the ceiling is
 * refused with a plain code instead of being archived without its last rows.
 */
async function listMirrorRows(tx, prefix) {
  const rows = await tx.list({ prefix, limit: MIRROR_ENTRIES_CEILING + 1 })
  if (rows.size > MIRROR_ENTRIES_CEILING) refuse('ARCHIVE_TOO_MANY_ENTRIES', 413, { limit: MIRROR_ENTRIES_CEILING })
  return rows
}

/**
 * the same rows as listMirrorRows, fetched STATUS_METADATA_PAGE_ROWS at a time. Every value is handed to
 * `countValue` (which refuses past the metadata budget) before the next page is asked for, and the ceiling is judged row by
 * row, so a store past either limit is refused with at most one page fetched beyond it. A page must continue strictly
 * after the previous key (`startAfter`): a store that answers the same rows again is refused, never looped over.
 */
async function pageMirrorRows(tx, prefix, countValue) {
  const rows = new Map()
  let after
  for (;;) {
    const page = await tx.list({ prefix, limit: STATUS_METADATA_PAGE_ROWS, ...(after === undefined ? {} : { startAfter: after }) })
    for (const [key, value] of page) {
      if (typeof key !== 'string' || !key.startsWith(prefix) || (after !== undefined && !(key > after))) refuse('ARCHIVE_MIRROR_LIST_INVALID', 503)
      after = key
      rows.set(key, value)
      if (rows.size > MIRROR_ENTRIES_CEILING) refuse('ARCHIVE_TOO_MANY_ENTRIES', 413, { limit: MIRROR_ENTRIES_CEILING })
      countValue(value)
    }
    if (page.size < STATUS_METADATA_PAGE_ROWS) return rows
  }
}

/**
 * one seed file's text, read by its own key (its entry row, then its chunks); null when it is not a file.
 * 1c: its size is judged from its entry row before any chunk is read (STATUS_SEED_FILE_MAX_BYTES, then
 * STATUS_SEED_FILE_MAX_CHUNKS, then the Mirror's own rule that the row's chunk count is its base64's), and every chunk
 * must be exactly as long as the row says before it is kept: a longer chunk is refused, never buffered.
 */
async function readSeedFileText(tx, path) {
  const id = await mirrorDigest(path)
  const meta = await tx.get(MIRROR_ENTRY + id)
  if (meta === undefined) return null
  if (!isObject(meta) || meta.path !== path) refuse('ARCHIVE_MIRROR_CORRUPT', 503)
  if (meta.kind !== 'file') return null
  if (!Number.isSafeInteger(meta.chunks) || meta.chunks < 0 || !Number.isSafeInteger(meta.bytes) || meta.bytes < 0) refuse('ARCHIVE_MIRROR_CORRUPT', 503)
  if (meta.bytes > STATUS_SEED_FILE_MAX_BYTES) refuse('ARCHIVE_STATUS_SEED_FILE_TOO_LARGE', 413, { limit: STATUS_SEED_FILE_MAX_BYTES })
  if (meta.chunks > STATUS_SEED_FILE_MAX_CHUNKS) refuse('ARCHIVE_STATUS_SEED_FILE_TOO_MANY_CHUNKS', 413, { limit: STATUS_SEED_FILE_MAX_CHUNKS })
  const characters = 4 * Math.ceil(meta.bytes / 3)
  if (meta.chunks !== Math.ceil(characters / MIRROR_CHUNK_CHARS)) refuse('ARCHIVE_MIRROR_CORRUPT', 503)
  const chunks = []
  for (let i = 0; i < meta.chunks; i++) {
    const chunk = await tx.get(`${MIRROR_CHUNK}${id}:${i}`)
    if (typeof chunk !== 'string') refuse('ARCHIVE_MIRROR_CHUNK_MISSING', 503, { path })
    if (chunk.length !== Math.min(MIRROR_CHUNK_CHARS, characters - i * MIRROR_CHUNK_CHARS)) refuse('ARCHIVE_MIRROR_CHUNK_CORRUPT', 503)
    chunks.push(chunk)
  }
  let raw
  try { raw = base64ToBytes(chunks.join('')) } catch { return refuse('ARCHIVE_MIRROR_CORRUPT', 503) }
  if (raw.byteLength !== meta.bytes) refuse('ARCHIVE_MIRROR_SIZE_MISMATCH', 503)
  try { return decoder.decode(raw) } catch { return refuse('ARCHIVE_MIRROR_CORRUPT', 503) }
}

/**
 * one HEAD blob for a status, under a byte limit. Every writer cuts a blob into HEAD_BLOB_CHUNK_CHARS
 * pieces, and a UTF-8 string is never fewer bytes than UTF-16 units, so a blob within the limit has at most
 * ceil(limit / HEAD_BLOB_CHUNK_CHARS) pieces: more is refused before any piece is read. While reading, a piece longer than
 * a writer makes is refused, and the bytes are counted before each piece is kept.
 */
async function readHeadBlobWithin(tx, key, maxBytes, tooLargeCode) {
  const count = await tx.get(`${key}:count`)
  if (count === undefined) return undefined
  if (!Number.isSafeInteger(count) || count < 0) refuse('ARCHIVE_HEAD_BLOB_CORRUPT', 503)
  if (count > Math.ceil(maxBytes / HEAD_BLOB_CHUNK_CHARS)) refuse(tooLargeCode, 413, { limit: maxBytes })
  const pieces = []
  let bytes = 0
  for (let i = 0; i < count; i++) {
    const chunk = await tx.get(`${key}:${i}`)
    if (typeof chunk !== 'string') refuse('ARCHIVE_HEAD_BLOB_INCOMPLETE', 503)
    if (chunk.length > HEAD_BLOB_CHUNK_CHARS) refuse('ARCHIVE_HEAD_BLOB_CORRUPT', 503)
    bytes += utf8ByteLength(chunk)
    // A surrogate pair cut between two pieces was counted 3 + 3; joined it is 4.
    const previous = pieces.length ? pieces[pieces.length - 1] : ''
    if (previous && (previous.charCodeAt(previous.length - 1) & 0xfc00) === 0xd800 && (chunk.charCodeAt(0) & 0xfc00) === 0xdc00) bytes -= 2
    if (bytes > maxBytes) refuse(tooLargeCode, 413, { limit: maxBytes })
    pieces.push(chunk)
  }
  return pieces.join('')
}

/** an internal archive route's reply; a coded refusal keeps its code and status, so the Worker reports it as is. */
async function archiveRouteReply(operation) {
  try {
    const value = await operation()
    return Response.json(value, { status: value?.ok === false ? 503 : 200, headers: NO_STORE })
  } catch (error) {
    if (typeof error?.code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(error.code)) throw error
    const status = [400, 403, 404, 409, 413, 503].includes(error.status) ? error.status : 503
    // 1c: a refusal over a named limit says the limit (a number, never content).
    return Response.json({ ok: false, code: error.code, ...(Number.isSafeInteger(error.limit) ? { limit: error.limit } : {}) }, { status, headers: NO_STORE })
  }
}

/**
 * a drill cleanup checked field by field before it leaves the Worker: `pending`; `targetName`, an
 * attempt's own generated object name; `objects`, at most HEAD and MIRROR, each with its rows left (a count, or null when
 * its wipe did not answer) and the two flags only when true. Any other field, or any field of another shape, and null
 * is returned: the cleanup is left out whole, never passed on in part.
 */
function checkedDrillCleanup(cleanup) {
  if (!isObject(cleanup) || Object.keys(cleanup).some(key => !['pending', 'targetName', 'objects'].includes(key))) return null
  if (typeof cleanup.pending !== 'boolean' || typeof cleanup.targetName !== 'string' || !DRILL_OBJECT_NAME_RE.test(cleanup.targetName)) return null
  if (!Array.isArray(cleanup.objects) || cleanup.objects.length > 2) return null
  const objects = []
  for (const entry of cleanup.objects) {
    if (!isObject(entry) || Object.keys(entry).some(key => !['object', 'remainingRows', 'remainingRowsAtLeast', 'endMarkLeft'].includes(key))) return null
    if (!['HEAD', 'MIRROR'].includes(entry.object) || objects.some(seen => seen.object === entry.object)) return null
    const rows = entry.remainingRows
    if (!(rows === null || (Number.isSafeInteger(rows) && rows >= 0 && rows <= DRILL_REMAINING_ROWS_COUNT_MAX + 1))) return null
    if (('remainingRowsAtLeast' in entry && entry.remainingRowsAtLeast !== true) || ('endMarkLeft' in entry && entry.endMarkLeft !== true)) return null
    objects.push({ object: entry.object, remainingRows: rows, ...(entry.remainingRowsAtLeast === true ? { remainingRowsAtLeast: true } : {}),
      ...(entry.endMarkLeft === true ? { endMarkLeft: true } : {}) })
  }
  return { pending: cleanup.pending, targetName: cleanup.targetName, objects }
}

/**
 * the owner's reply for an error thrown by executeEdgeArchiveOperation, for the Worker's archive route.
 * Null for an error without a well-formed code (the Worker's outer catch answers it, as before). A coded error answers
 * `{ ok: false, code }` with the status rule of the Worker's outer catch, plus exactly three details, each only in its own
 * shape: `cleanup` (checkedDrillCleanup), `step` (a short upper-case code) and `limit` (a non-negative safe integer).
 * No other field of the error is ever read into the reply.
 * @param {unknown} error
 * @returns {{ body: object, status: number } | null}
 */
export function archiveErrorReply(error) {
  const code = error?.code
  if (typeof code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(code)) return null
  const status = [400, 403, 408, 409, 413, 423, 429, 503].includes(error.status) ? error.status : 503
  const cleanup = checkedDrillCleanup(error.cleanup)
  const step = typeof error.step === 'string' && /^[A-Z][A-Z_]{0,39}$/.test(error.step) ? error.step : null
  const limit = Number.isSafeInteger(error.limit) && error.limit >= 0 ? error.limit : null
  return { status, body: { ok: false, code, ...(cleanup ? { cleanup } : {}), ...(step ? { step } : {}), ...(limit !== null ? { limit } : {}) } }
}

const isDrillMark = mark => isObject(mark) && mark.schema === DRILL_MARK_SCHEMA && UUID_RE.test(mark.drillId ?? '') && typeof mark.ended === 'boolean'
const drillMarkOf = (drillId, ended) => ({ schema: DRILL_MARK_SCHEMA, drillId, ended })

/**
 * an apply's first step, inside its own transaction. The object must be free: no mark and no row.
 * A mark of this drill that a wipe ended means this apply arrived after its drill gave up on it: refused, and the mark,
 * whose only job was to stop this apply, is removed. Any other mark belongs to another drill: refused, nothing touched.
 * Free, the object is reserved for this drill by its mark, written before any of the apply's rows.
 */
async function claimDrillTarget(tx, drillId) {
  const mark = await tx.get(DRILL_MARK_KEY)
  if (mark !== undefined) {
    if (isDrillMark(mark) && mark.drillId === drillId && mark.ended) {
      await tx.delete(DRILL_MARK_KEY)
      return 'DRILL_TARGET_ENDED'
    }
    return 'DRILL_TARGET_CLAIMED'
  }
  if ((await tx.list({ limit: 1 })).size > 0) return 'DRILL_TARGET_NOT_EMPTY'
  await tx.put(DRILL_MARK_KEY, drillMarkOf(drillId, false))
  return null
}
// The refusal is answered after the transaction, so removing an ended mark is kept (a throw would roll it back).
const drillRefusal = code => Response.json({ ok: false, code }, { status: 409, headers: NO_STORE })
const drillIdOf = body => (typeof body?.drillId === 'string' && UUID_RE.test(body.drillId) ? body.drillId : null)

/**
 * the rows left in a drill object, counted up to DRILL_REMAINING_ROWS_COUNT_MAX.
 * 1d: every key the listing returns is counted, the drill mark among them; nothing is subtracted and added back.
 * `markLeft` says whether the mark row is there (read by its own key, so a long listing cannot hide it).
 */
async function countDrillRows(storage) {
  const list = options => (typeof storage.list === 'function' ? storage.list(options) : storage.transaction(tx => tx.list(options)))
  const get = key => (typeof storage.get === 'function' ? storage.get(key) : storage.transaction(tx => tx.get(key)))
  const left = await list({ limit: DRILL_REMAINING_ROWS_COUNT_MAX + 1 })
  const markLeft = (await get(DRILL_MARK_KEY)) !== undefined
  const rows = left.size
  return { markLeft, ...(rows > DRILL_REMAINING_ROWS_COUNT_MAX ? { remainingRows: DRILL_REMAINING_ROWS_COUNT_MAX, remainingRowsAtLeast: true } : { remainingRows: rows }) }
}

/**
 * empty a disposable drill object and prove it. deleteAll, then its alarm, then a count of what is
 * left: the answer says wiped only when nothing is.
 * 1c, with a `drillId`: an object another drill has reserved is not touched (`ours: false`, nothing of this
 * drill is in it). With `end`, sent while this drill's apply to the object has not answered, the object is first marked
 * ended for this drill (so that apply, if it still lands, writes no row), and keeps only that mark.
 * 1c review: only while that apply has not committed. This drill's own mark not ended means its apply's transaction
 * already ran (it writes the mark with its rows), so no apply of this drill is left to stop: the wipe deletes everything
 * and leaves no mark. A mark it does leave is said in the answer (`endMarkLeft`, `remainingRows: 1`, not wiped).
 */
async function wipeDrillStorage(storage, { drillId = null, end = false } = {}) {
  let applyCommitted = false
  if (drillId !== null) {
    const mark = await storage.get(DRILL_MARK_KEY)
    if (mark !== undefined && !(isDrillMark(mark) && mark.drillId === drillId)) return { ok: true, wiped: false, ours: false, remainingRows: 0 }
    applyCommitted = mark !== undefined && mark.ended === false
  }
  const endMark = end && drillId !== null && !applyCommitted ? drillMarkOf(drillId, true) : null
  if (endMark) await storage.put(DRILL_MARK_KEY, endMark)
  let deleteFailed = false
  try {
    if (typeof storage.deleteAll === 'function') await storage.deleteAll()
    else {
      await storage.transaction(async tx => {
        const all = await tx.list()
        for (const k of all.keys()) await tx.delete(k)
      })
    }
  } catch {
    deleteFailed = true
  }
  if (endMark) await storage.put(DRILL_MARK_KEY, endMark)
  if (typeof storage.deleteAlarm === 'function') await storage.deleteAlarm()
  const { markLeft, ...left } = await countDrillRows(storage)
  // 1d: remainingRows is every key observed, the end mark included when one is left (endMarkLeft).
  const endMarkLeft = endMark !== null && markLeft
  const onlyEndMark = endMarkLeft && left.remainingRows === 1 && left.remainingRowsAtLeast !== true
  if (deleteFailed || (left.remainingRows !== 0 && !onlyEndMark)) {
    return { ok: false, code: 'DRILL_WIPE_INCOMPLETE', ...left, ...(endMarkLeft ? { endMarkLeft: true } : {}) }
  }
  // The object holds its end mark and nothing else, until the late apply removes it.
  return onlyEndMark ? { ok: true, wiped: false, endMarkLeft: true, remainingRows: 1 } : { ok: true, wiped: true, remainingRows: 0 }
}

async function validateManifest(ball) {
  const invalid = validateManifestStructure(ball)
  if (invalid) return invalid
  const { ballId: _ignore, ...rest } = ball
  const legacyId = await sha256Hex(legacyManifestPreimage(ball))
  const canonId = await sha256Hex(canonicalJson(rest))
  return (legacyId === ball.ballId || canonId === ball.ballId) ? null : 'MANIFEST_HASH_MISMATCH'
}

function base64ToBytes(b64) {
  if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    refuse('ARCHIVE_BASE64_INVALID', 400)
  }
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function merkleLeafHash(payloadObj) {
  const canon = encoder.encode(canonicalJson(payloadObj))
  const combined = new Uint8Array(1 + canon.byteLength)
  combined[0] = 0x00
  combined.set(canon, 1)
  return sha256Hex(combined)
}

async function merkleRootHex(leafHashesHex) {
  if (!Array.isArray(leafHashesHex) || leafHashesHex.length === 0) {
    return sha256Hex('')
  }
  let level = leafHashesHex.map(hexToBytes)
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        const combined = new Uint8Array(1 + level[i].byteLength + level[i + 1].byteLength)
        combined[0] = 0x01
        combined.set(level[i], 1)
        combined.set(level[i + 1], 1 + level[i].byteLength)
        next.push(new Uint8Array(await crypto.subtle.digest('SHA-256', combined)))
      } else {
        next.push(level[i])
      }
    }
    level = next
  }
  return bytesToHex(level[0])
}

/**
 * every prefix root of one leaf list, from subtree hashes computed once. merkleRootHex
 * carries an odd node up unchanged, so its root over n leaves is the right fold of the perfect subtrees that n's binary
 * digits name (the largest first, each starting where the one before ends, so each is a complete node of the level
 * built here). Building the levels costs fewer than n hashes; each prefix root then costs at most log2(n), where
 * merkleRootHex over each prefix cost about n per checkpoint.
 * @param {string[]} leafHashesHex The leaf hashes, in order.
 * @returns {Promise<(count: number) => Promise<string>>} The root of the first `count` leaves, as merkleRootHex gives it.
 */
async function merklePrefixRoots(leafHashesHex) {
  const nodeHash = async (left, right) => {
    const combined = new Uint8Array(1 + left.byteLength + right.byteLength)
    combined[0] = 0x01
    combined.set(left, 1)
    combined.set(right, 1 + left.byteLength)
    return new Uint8Array(await crypto.subtle.digest('SHA-256', combined))
  }
  const levels = [leafHashesHex.map(hexToBytes)]
  while (levels[levels.length - 1].length > 1) {
    const below = levels[levels.length - 1]
    const next = []
    for (let i = 0; i + 1 < below.length; i += 2) next.push(await nodeHash(below[i], below[i + 1]))
    levels.push(next)
  }
  return async count => {
    if (!Number.isSafeInteger(count) || count < 0 || count > leafHashesHex.length) refuse('ARCHIVE_CHECKPOINT_INVALID', 400)
    if (count === 0) return merkleRootHex([])
    let root = null
    for (let k = 0, size = 1; size <= count; k++, size *= 2) {
      if (Math.floor(count / size) % 2 === 0) continue
      // The subtree of `size` leaves for this binary digit starts where the larger ones end.
      const node = levels[k][Math.floor(count / (2 * size)) * 2]
      root = root === null ? node : await nodeHash(node, root)
    }
    return bytesToHex(root)
  }
}

async function readHeadBlob(tx, key) {
  const count = await tx.get(`${key}:count`)
  if (count === undefined) return undefined
  if (!Number.isSafeInteger(count) || count < 0) refuse('ARCHIVE_HEAD_BLOB_CORRUPT', 503)
  let value = ''
  for (let i = 0; i < count; i++) {
    const chunk = await tx.get(`${key}:${i}`)
    if (typeof chunk !== 'string') refuse('ARCHIVE_HEAD_BLOB_INCOMPLETE', 503)
    value += chunk
  }
  return value
}

async function writeHeadBlob(tx, key, value) {
  const count = Math.ceil(value.length / HEAD_BLOB_CHUNK_CHARS)
  for (let i = 0; i < count; i++) {
    await tx.put(`${key}:${i}`, value.slice(i * HEAD_BLOB_CHUNK_CHARS, (i + 1) * HEAD_BLOB_CHUNK_CHARS))
  }
  await tx.put(`${key}:count`, count)
}

/** each line of `text` between line feeds, trimmed, skipping the empty ones, without splitting the text. */
function* nonEmptyLines(text) {
  let start = 0
  while (start <= text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    const line = text.slice(start, end).trim()
    if (line) yield line
    start = end + 1
  }
}

/** Verify the complete hash-chained receipt log and Ed25519/hybrid signed checkpoints. */
export async function verifyArchiveReceiptChain(receiptsText, checkpointsText) {
  if (typeof receiptsText !== 'string') refuse('ARCHIVE_RECEIPTS_MISSING', 400)
  // the same lines as split('\n').map(trim).filter(Boolean), walked one at a time (an empty line never
  // becomes an array slot), and only each receipt's leaf hash is kept.
  const receipts = []
  let prevHash = '0'.repeat(64)
  let i = -1
  for (const line of nonEmptyLines(receiptsText)) {
    i++
    let parsed
    try { parsed = JSON.parse(line) } catch { refuse('ARCHIVE_RECEIPT_CHAIN_INVALID', 400, { seq: i + 1 }) }
    const claimed = isObject(parsed) ? (parsed.leafHash ?? parsed.hash) : undefined
    if (!isObject(parsed) || parsed.schema !== 'aukora.receipt.v3' || parsed.seq !== i + 1 || parsed.prevHash !== prevHash
      || !HEX_64.test(claimed ?? '') || (parsed.hash !== undefined && parsed.hash !== claimed)) {
      refuse('ARCHIVE_RECEIPT_CHAIN_INVALID', 400, { seq: i + 1 })
    }
    const payload = { ...parsed }
    if (parsed.leafHash === undefined) delete payload.hash
    else delete payload.leafHash
    const expectedLeaf = await merkleLeafHash(payload)
    if (expectedLeaf !== claimed) {
      refuse('ARCHIVE_RECEIPT_CHAIN_INVALID', 400, { seq: i + 1 })
    }
    prevHash = claimed
    receipts.push({ leafHash: claimed })
  }
  const merkleRoot = await merkleRootHex(receipts.map(r => r.leafHash))

  let prevCheckpointHash = null
  let prevReceiptCount = 0
  let checkpointCount = 0
  let prefixRootOf = null
  const checkpointSigners = new Set()
  for (const line of typeof checkpointsText === 'string' ? nonEmptyLines(checkpointsText) : []) {
    const i = checkpointCount++
    let cp
    try { cp = JSON.parse(line) } catch { refuse('ARCHIVE_CHECKPOINT_INVALID', 400, { seq: i + 1 }) }
    const hybrid = isObject(cp?.envelope)
    const body = hybrid ? cp.envelope?.payload : cp?.body
    if (!isObject(body) || body.schema !== 'aukora.edge-checkpoint.v1' || body.seq !== i + 1
      || !Number.isSafeInteger(body.receiptCount) || body.receiptCount < prevReceiptCount || body.receiptCount > receipts.length
      || (body.prevCheckpointHash ?? null) !== prevCheckpointHash) {
      refuse('ARCHIVE_CHECKPOINT_INVALID', 400, { seq: i + 1 })
    }
    const expectedLastLeaf = body.receiptCount === 0 ? '0'.repeat(64) : receipts[body.receiptCount - 1].leafHash
    if (body.lastReceiptHash !== expectedLastLeaf) {
      refuse('ARCHIVE_CHECKPOINT_INVALID', 400, { seq: i + 1 })
    }
    // 1c review: from subtree hashes built once for all checkpoints (merklePrefixRoots), never a tree per checkpoint.
    prefixRootOf ??= await merklePrefixRoots(receipts.map(r => r.leafHash))
    const expectedPrefixRoot = await prefixRootOf(body.receiptCount)
    if (body.merkleRoot !== expectedPrefixRoot) {
      refuse('ARCHIVE_CHECKPOINT_INVALID', 400, { seq: i + 1 })
    }
    let expectedCpHash
    if (hybrid) {
      const pubHex = cp.envelope?.signer?.ed25519PublicKeyHex
      const mlHex = cp.envelope?.signer?.mlDsaPublicKeyHex
      if (!HEX_64.test(pubHex ?? '')) refuse('ARCHIVE_CHECKPOINT_INVALID', 400, { seq: i + 1 })
      await verifyHybridEnvelopeV2(cp.envelope, {
        artifact: 'checkpoint',
        trustedKeys: { ed25519PublicKeyHex: pubHex, mlDsaPublicKeyHex: mlHex },
      })
      expectedCpHash = await sha256Hex(canonicalJson(cp.envelope))
      checkpointSigners.add(pubHex)
    } else {
      if (!HEX_64.test(cp?.publicKeyHex ?? '') || typeof cp?.signatureHex !== 'string' || !/^[0-9a-f]{128}$/.test(cp.signatureHex)) {
        refuse('ARCHIVE_CHECKPOINT_INVALID', 400, { seq: i + 1 })
      }
      const key = await crypto.subtle.importKey('raw', hexToBytes(cp.publicKeyHex), 'Ed25519', false, ['verify'])
      const ok = await crypto.subtle.verify('Ed25519', key, hexToBytes(cp.signatureHex), encoder.encode(CHECKPOINT_DOMAIN + canonicalJson(body)))
      if (!ok) refuse('ARCHIVE_CHECKPOINT_SIGNATURE_INVALID', 400, { seq: i + 1 })
      expectedCpHash = await sha256Hex(canonicalJson({ body, publicKeyHex: cp.publicKeyHex, signatureHex: cp.signatureHex }))
      checkpointSigners.add(cp.publicKeyHex)
    }
    if (cp.checkpointHash !== expectedCpHash) {
      refuse('ARCHIVE_CHECKPOINT_INVALID', 400, { seq: i + 1 })
    }
    prevCheckpointHash = cp.checkpointHash
    prevReceiptCount = body.receiptCount
  }

  return {
    receiptCount: receipts.length,
    lastReceiptHash: receipts.length > 0 ? receipts[receipts.length - 1].leafHash : '0'.repeat(64),
    merkleRoot,
    checkpointCount,
    lastCheckpointHash: prevCheckpointHash,
    lastCheckpointReceiptCount: checkpointCount > 0 ? prevReceiptCount : null,
    checkpointSigners: [...checkpointSigners].sort(),
  }
}

/** Extract and validate the BOUND AUMLOK owner record.
 * Terminal fail-stop (NO_NODE / OWNER_RECORD_MISSING): never reconstructs or defaults an owner.
 */
export function extractBoundOwnerSummary(aumlokState, expectedOwnerPublicKeyHex) {
  if (!HEX_64.test(expectedOwnerPublicKeyHex ?? '')) {
    refuse('OWNER_KEY_NOT_CONFIGURED', 503)
  }
  if (!isObject(aumlokState) || aumlokState.schema !== 'aukora.aumlok.state.v2' || !isObject(aumlokState.binding)) {
    refuse('OWNER_RECORD_MISSING', 409)
  }
  const binding = aumlokState.binding
  const cred = binding.credential
  if (!HEX_64.test(binding.aumlokId ?? '')
    || !HEX_64.test(binding.nodePubkeyHex ?? '')
    || !isObject(cred)
    || typeof cred.id !== 'string' || cred.id.length < 1 || cred.id.length > 2048
    || typeof cred.publicKeyB64 !== 'string' || cred.publicKeyB64.length < 1 || cred.publicKeyB64.length > 512
    || !Number.isSafeInteger(cred.counter) || cred.counter < 0
    || !Number.isSafeInteger(binding.generation) || binding.generation < 1) {
    refuse('OWNER_RECORD_CORRUPT', 409)
  }
  if (binding.nodePubkeyHex === expectedOwnerPublicKeyHex) {
    refuse('NODE_KEY_IS_NOT_OWNER_KEY', 403)
  }
  if (Array.isArray(aumlokState.enrollments) && aumlokState.enrollments.length > 0) {
    for (const enrollment of aumlokState.enrollments) {
      if (!isObject(enrollment) || enrollment.ownerPublicKeyHex !== expectedOwnerPublicKeyHex || enrollment.credentialId !== cred.id) {
        refuse('ARCHIVE_OWNER_AUTHORITY_DIVERGENCE', 409)
      }
    }
  }
  return Object.freeze({
    schema: 'aukora.x61.owner-record.v1',
    phase: 'BOUND',
    ownerPublicKeyHex: expectedOwnerPublicKeyHex,
    aumlokId: binding.aumlokId,
    nodePubkeyHex: binding.nodePubkeyHex,
    credentialId: cred.id,
    credentialPublicKeyB64: cred.publicKeyB64,
    signerCounter: cred.counter,
    generation: binding.generation,
  })
}

/**
 * a drill never reports a rebuilt owner it has not loaded. `extractBoundOwnerSummary` reads only the public
 * summary fields; this runs the whole AUMLOK `aumlok:v1` row through the AUMLOK store's own loader (the read every
 * ceremony and status starts with: field-exact schema, recovery commitment, escrow, pepper, challenges, approvals and
 * their MACs, enrollments, invites and their signatures, audit chain), with the service's own pepper secret when the
 * store separates it. A row that would not load is refused as `ARCHIVE_OWNER_RECORD_INVALID` (409); the loader's own
 * code rides along as `ownerRecordCode` for the service and its tests, never in a reply.
 * @param {unknown} aumlokState The row to check, or null when `storage` already holds it.
 * @param {object} options `expectedOwnerPublicKeyHex`, optional `pepperSecret`, optional `storage` (a restored HEAD
 *   store to load from in place; it is only read).
 * @returns {Promise<object>} The store's public status for the loaded row (phase BOUND).
 */
export async function verifyRestorableOwnerRecord(aumlokState, { expectedOwnerPublicKeyHex, pepperSecret, storage = null } = {}) {
  const row = structuredClone(aumlokState)
  const readOnly = {
    get: async key => (key === AUMLOK_STORAGE_KEY ? structuredClone(row) : undefined),
    put: async () => refuse('ARCHIVE_OWNER_RECORD_CHECK_WROTE', 503),
    delete: async () => refuse('ARCHIVE_OWNER_RECORD_CHECK_WROTE', 503),
  }
  const source = storage ?? { transaction: operation => operation(readOnly) }
  let status
  try {
    const store = createAumlokStore(source, { origins: [OWNER_RECORD_CHECK_ORIGIN], ownerPublicKeyHex: expectedOwnerPublicKeyHex,
      ...(pepperSecret === undefined ? {} : { pepperSecret }) })
    status = await store.status()
  } catch (error) {
    refuse('ARCHIVE_OWNER_RECORD_INVALID', 409, { ownerRecordCode: typeof error?.code === 'string' ? error.code : 'AUMLOK_UNAVAILABLE' })
  }
  if (status?.ok !== true || status.phase !== 'BOUND') refuse('ARCHIVE_OWNER_RECORD_INVALID', 409, { ownerRecordCode: 'AUMLOK_NOT_BOUND' })
  return status
}

/** The head checks every composite starts with; returns the head's module shas, sorted. */
async function compositeHeadModuleShas(head) {
  if (!isObject(head) || !isObject(head.modules) || !isObject(head.entries)) {
    refuse('ARCHIVE_HEAD_INVALID', 400)
  }
  const invalid = await validateManifest(head)
  if (invalid) refuse(invalid, 400)

  // Verify every entry's ball:<sha> specifier is present in head.modules
  for (const entry of Object.values(head.entries)) {
    const spec = entry?.specifier
    if (typeof spec === 'string' && spec.startsWith('ball:')) {
      const sha = spec.slice(5)
      if (!Object.hasOwn(head.modules, sha)) refuse('ARCHIVE_MODULE_MISSING', 400, { sha })
    }
  }
  return Object.keys(head.modules).sort()
}

/**
 * the module inventory a composite head commits to, [[sha, utf8Bytes]] in sha order. Every module's code must
 * hash to its key. HEAD's archive-summary route builds the same inventory one module at a time and keeps no code.
 */
export async function moduleInventoryOf(codeBySha) {
  if (!isObject(codeBySha)) refuse('ARCHIVE_MODULE_MISSING', 400)
  const moduleInventory = []
  for (const sha of Object.keys(codeBySha).sort()) {
    if (typeof codeBySha[sha] !== 'string') refuse('ARCHIVE_MODULE_MISSING', 400, { sha })
    if (await sha256Hex(codeBySha[sha]) !== sha) refuse('ARCHIVE_MODULE_HASH_MISMATCH', 400, { sha })
    moduleInventory.push([sha, encoder.encode(codeBySha[sha]).byteLength])
  }
  return moduleInventory
}

/** Compute the D4b anti-silence composite head commitment over head + module closure + owner + receipts + checkpoints. */
export async function computeCompositeHeadCommitment({
  head,
  codeBySha,
  ownerSummary,
  receiptsSummary,
}) {
  const moduleShas = await compositeHeadModuleShas(head)
  if (!isObject(codeBySha) || Object.keys(codeBySha).length !== moduleShas.length) {
    refuse('ARCHIVE_MODULE_MISSING', 400)
  }
  for (const sha of moduleShas) {
    if (!Object.hasOwn(codeBySha, sha) || typeof codeBySha[sha] !== 'string') {
      refuse('ARCHIVE_MODULE_MISSING', 400, { sha })
    }
  }
  return compositeFromInventory({ head, moduleInventory: await moduleInventoryOf(codeBySha), ownerSummary, receiptsSummary })
}

/**
 * the same composite head commitment from a module inventory instead of the code itself (the code was hashed
 * where it lives). The inventory must name exactly the head's modules, in sha order. Pinned equal to
 * computeCompositeHeadCommitment, which is this over moduleInventoryOf(codeBySha).
 */
export async function compositeFromInventory({
  head,
  moduleInventory: inventory,
  ownerSummary,
  receiptsSummary,
}) {
  const moduleShas = await compositeHeadModuleShas(head)
  return compositeOverModules({ head, moduleShas, inventory, ownerSummary, receiptsSummary })
}

/**
 * the same composite from the head FACTS HEAD sends after running the head checks itself (epoch, ballId,
 * parentBallId), so a status never carries the manifest. The inventory is then the module list: sha order, each sha named
 * once. compositeFromInventory is this over the facts of a checked head, so the two are equal by construction.
 */
export async function compositeFromHeadFacts({ head, moduleInventory: inventory, ownerSummary, receiptsSummary }) {
  if (!isObject(head) || !HEX_64.test(head.ballId ?? '') || (head.parentBallId !== null && !HEX_64.test(head.parentBallId ?? ''))) {
    refuse('ARCHIVE_HEAD_INVALID', 400)
  }
  if (!Array.isArray(inventory)) refuse('ARCHIVE_MODULE_MISSING', 400)
  const moduleShas = inventory.map(item => (Array.isArray(item) ? item[0] : null))
  if (moduleShas.some((sha, index) => !HEX_64.test(sha ?? '') || (index > 0 && !(moduleShas[index - 1] < sha)))) refuse('ARCHIVE_MODULE_MISSING', 400)
  return compositeOverModules({ head, moduleShas, inventory, ownerSummary, receiptsSummary })
}

async function compositeOverModules({ head, moduleShas, inventory, ownerSummary, receiptsSummary }) {
  if (!Array.isArray(inventory) || inventory.length !== moduleShas.length) refuse('ARCHIVE_MODULE_MISSING', 400)
  const moduleInventory = moduleShas.map((sha, index) => {
    const item = inventory[index]
    if (!Array.isArray(item) || item.length !== 2 || item[0] !== sha || !Number.isSafeInteger(item[1]) || item[1] < 0) {
      refuse('ARCHIVE_MODULE_MISSING', 400, { sha })
    }
    return [sha, item[1]]
  })

  const modulesStoreRoot = await sha256Hex('aukora.x61.modules-root.v1\0' + canonicalJson(moduleInventory))
  const ownerRecordCommitment = await sha256Hex('aukora.x61.owner-record.v1\0' + canonicalJson(ownerSummary))

  const payload = {
    schema: COMPOSITE_HEAD_SCHEMA,
    hashAlgorithm: PINNED_HASH_ALGORITHM,
    epoch: head.epoch,
    ballId: head.ballId,
    parentBallId: head.parentBallId ?? null,
    moduleCount: moduleShas.length,
    modulesStoreRoot,
    ownerRecordCommitment,
    credentialId: ownerSummary.credentialId,
    signerCounter: ownerSummary.signerCounter,
    receiptsRoot: receiptsSummary.merkleRoot,
    receiptCount: receiptsSummary.receiptCount,
    checkpointCounter: receiptsSummary.checkpointCount,
  }
  const compositeHeadHash = await sha256Hex(COMPOSITE_HEAD_SCHEMA + '\0' + canonicalJson(payload))
  return Object.freeze({ ...payload, compositeHeadHash })
}

/** Export a complete verified archive from HeadDO + MirrorDO, and write to R2 when bucket is bound. */
export async function exportColdArchive({
  headStorage,
  mirrorStorage,
  expectedOwnerPublicKeyHex,
  archiveBucket = null,
  now = Date.now,
}) {
  const headData = await headStorage.transaction(async tx => {
    const bootstrap = await tx.get(HEAD_BOOTSTRAP_KEY)
    const headId = await tx.get('head')
    if (!isObject(bootstrap) || bootstrap.phase !== 'complete' || !HEX_64.test(bootstrap.seedId ?? '') || !HEX_64.test(headId ?? '')) {
      refuse('ARCHIVE_HEAD_NOT_BOOTSTRAPPED', 503)
    }
    const rawManifest = await readHeadBlob(tx, `manifest:${headId}`)
    if (typeof rawManifest !== 'string') refuse('ARCHIVE_HEAD_INVALID', 503)
    const ball = JSON.parse(rawManifest)
    const codeBySha = {}
    for (const sha of Object.keys(ball?.modules ?? {})) {
      const code = await readHeadBlob(tx, `module:${sha}`)
      if (typeof code !== 'string') refuse('ARCHIVE_MODULE_MISSING', 503, { sha })
      if (await sha256Hex(code) !== sha) refuse('ARCHIVE_MODULE_HASH_MISMATCH', 503, { sha })
      codeBySha[sha] = code
    }
    const aumlokState = await tx.get(AUMLOK_STORAGE_KEY)
    return { bootstrap: structuredClone(bootstrap), ball, codeBySha, aumlokState: structuredClone(aumlokState) }
  })

  const mirrorData = await mirrorStorage.transaction(async tx => {
    const bootstrap = await tx.get(MIRROR_BOOTSTRAP_KEY)
    const fence = await tx.get(MIRROR_FENCE)
    if (!isObject(bootstrap) || bootstrap.phase !== 'ready' || bootstrap.seedId !== headData.bootstrap.seedId) {
      refuse('ARCHIVE_MIRROR_NOT_BOOTSTRAPPED', 503)
    }
    if (!isObject(fence) || !UUID_RE.test(fence.lineageId ?? '') || !Number.isSafeInteger(fence.revision) || fence.revision < 1) {
      refuse('ARCHIVE_MIRROR_FENCE_INVALID', 503)
    }
    const resetRows = await listMirrorRows(tx, MIRROR_RESET)
    const resetPaths = [...resetRows.values()].map(String).filter(p => !archiveSkipsPath(p)).sort()
    for (const p of resetPaths) validateMirrorPath(p)

    const entryRows = await listMirrorRows(tx, MIRROR_ENTRY)
    const entries = []
    for (const [, meta] of [...entryRows.entries()]) {
      if (!isObject(meta) || typeof meta.path !== 'string') refuse('ARCHIVE_MIRROR_CORRUPT', 503)
      if (archiveSkipsPath(meta.path)) continue
      validateMirrorPath(meta.path)
      if (meta.kind === 'dir') {
        entries.push([meta.path, { kind: 'dir', mode: meta.mode }])
      } else if (meta.kind === 'file') {
        let b64 = ''
        const id = await mirrorDigest(meta.path)
        for (let i = 0; i < meta.chunks; i++) {
          const chunk = await tx.get(`${MIRROR_CHUNK}${id}:${i}`)
          if (typeof chunk !== 'string') refuse('ARCHIVE_MIRROR_CHUNK_MISSING', 503, { path: meta.path })
          b64 += chunk
        }
        const rawBytes = base64ToBytes(b64)
        if (rawBytes.byteLength !== meta.bytes) refuse('ARCHIVE_MIRROR_SIZE_MISMATCH', 503, { path: meta.path })
        const fileSha256 = await sha256Hex(rawBytes)
        entries.push([meta.path, { kind: 'file', mode: meta.mode, mtimeMs: meta.mtimeMs, b64, sha256: fileSha256, bytes: meta.bytes }])
      } else {
        refuse('ARCHIVE_MIRROR_CORRUPT', 503)
      }
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return { bootstrap: structuredClone(bootstrap), fence: structuredClone(fence), resetPaths, entries }
  })

  const findUtf8 = targetPath => {
    const found = mirrorData.entries.find(([p, wire]) => p === targetPath && wire.kind === 'file')
    if (!found) return null
    return decoder.decode(base64ToBytes(found[1].b64))
  }

  const receiptsText = findUtf8(RECEIPTS_PATH)
  if (receiptsText === null) refuse('ARCHIVE_RECEIPTS_MISSING', 503)
  const checkpointsText = findUtf8(CHECKPOINTS_PATH) ?? ''
  const receiptsSummary = await verifyArchiveReceiptChain(receiptsText, checkpointsText)
  const ownerSummary = extractBoundOwnerSummary(headData.aumlokState, expectedOwnerPublicKeyHex)
  const compositeHead = await computeCompositeHeadCommitment({
    head: headData.ball,
    codeBySha: headData.codeBySha,
    ownerSummary,
    receiptsSummary,
  })

  const exportedAt = now()
  const unsignedBundle = {
    schema: COLD_ARCHIVE_SCHEMA,
    hashAlgorithm: PINNED_HASH_ALGORITHM,
    exportedAt,
    seedId: headData.bootstrap.seedId,
    compositeHead,
    ownerSummary,
    receiptsSummary,
    head: {
      bootstrap: headData.bootstrap,
      ball: headData.ball,
      codeBySha: headData.codeBySha,
      aumlokState: headData.aumlokState,
    },
    mirror: {
      snapshotFormat: 'x61-mirror-snapshot/v2',
      bootstrap: mirrorData.bootstrap,
      fence: mirrorData.fence,
      resetPaths: mirrorData.resetPaths,
      entries: mirrorData.entries,
    },
  }
  const archiveId = await sha256Hex(COLD_ARCHIVE_SCHEMA + '\0' + canonicalJson(unsignedBundle))
  const bundle = { archiveId, ...unsignedBundle }

  let r2Key = null
  let r2Stored = false
  if (archiveBucket && typeof archiveBucket.put === 'function') {
    // the snapshot is serialized before the first put and judged on those bytes; refused, nothing is written.
    const serialized = JSON.stringify(bundle)
    refuseUnlessOnePiece(utf8ByteLength(serialized))
    for (const [sha, code] of Object.entries(headData.codeBySha)) {
      await archiveBucket.put(`modules/${sha}.js`, code, {
        httpMetadata: { contentType: 'application/javascript; charset=utf-8' },
        customMetadata: { sha256: sha, hashAlgorithm: PINNED_HASH_ALGORITHM },
      })
    }
    for (const [, wire] of mirrorData.entries) {
      if (wire.kind === 'file') {
        await archiveBucket.put(`files/${wire.sha256}.b64`, wire.b64, {
          httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          customMetadata: { sha256: wire.sha256, bytes: String(wire.bytes) },
        })
      }
    }
    r2Key = `snapshots/epoch-${String(headData.ball.epoch)}-${headData.ball.ballId}.json`
    await archiveBucket.put(r2Key, serialized, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: {
        archiveId,
        compositeHeadHash: compositeHead.compositeHeadHash,
        epoch: String(headData.ball.epoch),
        ballId: headData.ball.ballId,
      },
    })
    await archiveBucket.put('snapshots/LATEST.json', JSON.stringify({
      schema: COLD_ARCHIVE_SCHEMA,
      archiveId,
      r2Key,
      exportedAt,
      epoch: headData.ball.epoch,
      ballId: headData.ball.ballId,
      moduleCount: compositeHead.moduleCount,
      receiptCount: receiptsSummary.receiptCount,
      merkleRoot: receiptsSummary.merkleRoot,
      checkpointCount: receiptsSummary.checkpointCount,
      compositeHeadHash: compositeHead.compositeHeadHash,
      credentialId: ownerSummary.credentialId,
      signerCounter: ownerSummary.signerCounter,
    }), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    })
    r2Stored = true
  }

  return {
    ok: true,
    archiveId,
    exportedAt,
    epoch: headData.ball.epoch,
    ballId: headData.ball.ballId,
    moduleCount: compositeHead.moduleCount,
    mirrorEntryCount: mirrorData.entries.length,
    receiptsSummary,
    ownerSummary,
    compositeHead,
    r2Stored,
    r2Key,
    bundle,
  }
}

/** Verify an untrusted archive bundle completely before any storage mutation. */
export async function verifyColdArchive(bundle, {
  expectedOwnerPublicKeyHex,
  minimumEpoch = 1,
  minimumReceiptCount = 1,
  minimumCheckpointCount = 0,
  expectedCompositeHeadHash = undefined,
} = {}) {
  if (!isObject(bundle) || bundle.schema !== COLD_ARCHIVE_SCHEMA || bundle.hashAlgorithm !== PINNED_HASH_ALGORITHM || !HEX_64.test(bundle.archiveId ?? '')) {
    refuse('ARCHIVE_ENVELOPE_INVALID', 400)
  }
  const { archiveId, ...unsignedBundle } = bundle
  const recomputedArchiveId = await sha256Hex(COLD_ARCHIVE_SCHEMA + '\0' + canonicalJson(unsignedBundle))
  if (recomputedArchiveId !== archiveId) {
    refuse('ARCHIVE_DIGEST_MISMATCH', 400)
  }
  // a copy whose owner-secret row was withheld is never a restore source: it would rebuild a node with no
  // owner record. Named here, before any owner or storage step, instead of failing later as a missing owner.
  if (bundle.ownerSecrets !== undefined) refuse('ARCHIVE_OWNER_SECRETS_WITHHELD', 409)

  const ball = bundle.head?.ball
  const codeBySha = bundle.head?.codeBySha
  const aumlokState = bundle.head?.aumlokState
  if (!isObject(ball) || !Number.isSafeInteger(ball.epoch) || ball.epoch < minimumEpoch) {
    refuse('ARCHIVE_EPOCH_REGRESSION_REFUSED', 409)
  }

  const ownerSummary = extractBoundOwnerSummary(aumlokState, expectedOwnerPublicKeyHex)
  if (canonicalJson(ownerSummary) !== canonicalJson(bundle.ownerSummary)) {
    refuse('ARCHIVE_OWNER_AUTHORITY_DIVERGENCE', 409)
  }

  const mirror = bundle.mirror
  if (!isObject(mirror) || mirror.snapshotFormat !== 'x61-mirror-snapshot/v2' || !Array.isArray(mirror.entries) || !Array.isArray(mirror.resetPaths)) {
    refuse('ARCHIVE_MIRROR_INVALID', 400)
  }
  if (!isObject(mirror.fence) || !UUID_RE.test(mirror.fence.lineageId ?? '') || !Number.isSafeInteger(mirror.fence.revision) || mirror.fence.revision < 1) {
    refuse('ARCHIVE_MIRROR_FENCE_INVALID', 400)
  }

  for (const p of mirror.resetPaths) validateMirrorPath(p)
  let receiptsText = null
  let checkpointsText = ''
  for (const item of mirror.entries) {
    if (!Array.isArray(item) || item.length !== 2) refuse('ARCHIVE_MIRROR_INVALID', 400)
    const [p, wire] = item
    validateMirrorPath(p)
    if (!isObject(wire) || !['dir', 'file'].includes(wire.kind)) refuse('ARCHIVE_MIRROR_INVALID', 400)
    if (wire.kind === 'file') {
      const decoded = base64ToBytes(wire.b64)
      if (decoded.byteLength !== wire.bytes || await sha256Hex(decoded) !== wire.sha256) {
        refuse('ARCHIVE_MIRROR_FILE_HASH_MISMATCH', 400, { path: p })
      }
      if (p === RECEIPTS_PATH) receiptsText = decoder.decode(decoded)
      if (p === CHECKPOINTS_PATH) checkpointsText = decoder.decode(decoded)
    }
  }
  if (receiptsText === null) refuse('ARCHIVE_RECEIPTS_MISSING', 400)

  const receiptsSummary = await verifyArchiveReceiptChain(receiptsText, checkpointsText)
  if (receiptsSummary.receiptCount < minimumReceiptCount || receiptsSummary.checkpointCount < minimumCheckpointCount) {
    refuse('ARCHIVE_RECEIPT_PREFIX_TRUNCATED', 409)
  }
  if (canonicalJson(receiptsSummary) !== canonicalJson(bundle.receiptsSummary)) {
    refuse('ARCHIVE_RECEIPTS_SUMMARY_MISMATCH', 400)
  }

  const compositeHead = await computeCompositeHeadCommitment({
    head: ball,
    codeBySha,
    ownerSummary,
    receiptsSummary,
  })
  if (canonicalJson(compositeHead) !== canonicalJson(bundle.compositeHead)) {
    refuse('ARCHIVE_COMPOSITE_HEAD_MISMATCH', 409)
  }
  if (expectedCompositeHeadHash !== undefined && compositeHead.compositeHeadHash !== expectedCompositeHeadHash) {
    refuse('ARCHIVE_COMPOSITE_HEAD_MISMATCH', 409)
  }

  return {
    ok: true,
    archiveId,
    epoch: ball.epoch,
    ballId: ball.ballId,
    moduleCount: compositeHead.moduleCount,
    mirrorEntryCount: mirror.entries.length,
    ownerSummary,
    receiptsSummary,
    compositeHead,
  }
}

/** Restore into an isolated, empty drill Durable Object pair, then verify full read-back parity.
 * Refuses production `node-main-v1` unconditionally. Never mutates storage if verification fails.
 */
export async function runDisposableRebuildDrill({
  targetName,
  bundle,
  targetHeadStorage,
  targetMirrorStorage,
  expectedOwnerPublicKeyHex,
  minimumEpoch = 1,
  minimumReceiptCount = 1,
  minimumCheckpointCount = 0,
  expectedCompositeHeadHash = undefined,
  aumlokPepperSecret = undefined,
}) {
  if (typeof targetName !== 'string' || targetName === LIVE_PRODUCTION_DO_NAME || !DRILL_NAME_RE.test(targetName)) {
    refuse('LIVE_HEAD_REFUSED', 403)
  }

  // Step 1: Full offline cryptographic & authority verification BEFORE any target storage read/write.
  const verified = await verifyColdArchive(bundle, {
    expectedOwnerPublicKeyHex,
    minimumEpoch,
    minimumReceiptCount,
    minimumCheckpointCount,
    expectedCompositeHeadHash,
  })
  // and the owner row must load in the AUMLOK store as it is, before anything is written.
  await verifyRestorableOwnerRecord(bundle.head.aumlokState, { expectedOwnerPublicKeyHex, pepperSecret: aumlokPepperSecret })

  // Step 2: Refuse non-empty target DO namespaces.
  const [headOccupied, mirrorOccupied] = await Promise.all([
    targetHeadStorage.transaction(async tx => (await tx.list({ limit: 1 })).size > 0),
    targetMirrorStorage.transaction(async tx => (await tx.list({ limit: 1 })).size > 0),
  ])
  if (headOccupied || mirrorOccupied) {
    refuse('DRILL_TARGET_NOT_EMPTY', 409)
  }

  // Step 3: Populate MirrorDO storage transactionally.
  await targetMirrorStorage.transaction(async tx => {
    await tx.put(MIRROR_FENCE, structuredClone(bundle.mirror.fence))
    for (const resetPath of bundle.mirror.resetPaths) {
      await tx.put(MIRROR_RESET + await mirrorDigest(resetPath), resetPath)
    }
    for (const [p, wire] of bundle.mirror.entries) {
      const id = await mirrorDigest(p)
      if (wire.kind === 'dir') {
        await tx.put(MIRROR_ENTRY + id, { path: p, kind: 'dir', mode: wire.mode })
      } else {
        const chunks = Math.ceil(wire.b64.length / MIRROR_CHUNK_CHARS)
        for (let i = 0; i < chunks; i++) {
          await tx.put(`${MIRROR_CHUNK}${id}:${i}`, wire.b64.slice(i * MIRROR_CHUNK_CHARS, (i + 1) * MIRROR_CHUNK_CHARS))
        }
        await tx.put(MIRROR_ENTRY + id, {
          path: p,
          kind: 'file',
          mode: wire.mode,
          mtimeMs: wire.mtimeMs,
          chunks,
          bytes: wire.bytes,
        })
      }
    }
    await tx.put(MIRROR_BOOTSTRAP_KEY, {
      ...structuredClone(bundle.mirror.bootstrap),
      phase: 'ready',
      seedId: bundle.seedId,
      ballId: bundle.head.ball.ballId,
      epoch: bundle.head.ball.epoch,
      lineageId: bundle.mirror.fence.lineageId,
      revision: bundle.mirror.fence.revision,
    })
  })

  // Step 4: Populate HeadDO storage transactionally (including exact BOUND AUMLOK credential state).
  await targetHeadStorage.transaction(async tx => {
    for (const [sha, code] of Object.entries(bundle.head.codeBySha)) {
      await writeHeadBlob(tx, `module:${sha}`, code)
    }
    await writeHeadBlob(tx, `manifest:${bundle.head.ball.ballId}`, JSON.stringify(bundle.head.ball))
    await tx.put('head', bundle.head.ball.ballId)
    await tx.put(HEAD_BOOTSTRAP_KEY, {
      ...structuredClone(bundle.head.bootstrap),
      phase: 'complete',
      seedId: bundle.seedId,
      ballId: bundle.head.ball.ballId,
      epoch: bundle.head.ball.epoch,
    })
    await tx.put(AUMLOK_STORAGE_KEY, structuredClone(bundle.head.aumlokState))
  })

  // Step 5: Independent read-back verification against restored HeadDO + MirrorDO stores!
  const reExported = await exportColdArchive({
    headStorage: targetHeadStorage,
    mirrorStorage: targetMirrorStorage,
    expectedOwnerPublicKeyHex,
  })
  const changedCount = canonicalJson(reExported.bundle.head.ball.entries) === canonicalJson(bundle.head.ball.entries) ? 0 : 1
  if (reExported.ballId !== bundle.head.ball.ballId
    || reExported.moduleCount !== verified.moduleCount
    || changedCount !== 0
    || reExported.compositeHead.compositeHeadHash !== verified.compositeHead.compositeHeadHash
    || reExported.ownerSummary.credentialId !== verified.ownerSummary.credentialId
    || reExported.ownerSummary.signerCounter !== verified.ownerSummary.signerCounter
    || reExported.receiptsSummary.merkleRoot !== verified.receiptsSummary.merkleRoot) {
    refuse('DRILL_READBACK_PARITY_FAILED', 503)
  }
  // the owner phase reported below is the one the restored HEAD store itself loads.
  const restoredOwner = await verifyRestorableOwnerRecord(null, { expectedOwnerPublicKeyHex, pepperSecret: aumlokPepperSecret, storage: targetHeadStorage })

  return {
    ok: true,
    targetName,
    archiveId: verified.archiveId,
    epoch: verified.epoch,
    ballId: verified.ballId,
    verifiedModules: reExported.moduleCount,
    mirrorEntryCount: reExported.mirrorEntryCount,
    stateDiffChanged: changedCount,
    receiptCount: reExported.receiptsSummary.receiptCount,
    merkleRoot: reExported.receiptsSummary.merkleRoot,
    checkpointCount: reExported.receiptsSummary.checkpointCount,
    ownerPhase: restoredOwner.phase,
    ownerCredentialId: reExported.ownerSummary.credentialId,
    ownerSignerCounter: reExported.ownerSummary.signerCounter,
    compositeHead: reExported.compositeHead,
  }
}

/** Internal HeadDO helper for Worker-driven cold archive export and disposable drill DOs. */
export async function handleInternalHeadArchiveRoute(storage, path, body, { createDurableHeadStore } = {}) {
  if (path === '/_head/archive-state') {
    const state = await storage.transaction(async tx => {
      const bootstrap = await tx.get(HEAD_BOOTSTRAP_KEY)
      const headId = await tx.get('head')
      if (!isObject(bootstrap) || bootstrap.phase !== 'complete' || !HEX_64.test(bootstrap.seedId ?? '') || !HEX_64.test(headId ?? '')) {
        refuse('ARCHIVE_HEAD_NOT_BOOTSTRAPPED', 503)
      }
      const rawManifest = await readHeadBlob(tx, `manifest:${headId}`)
      if (typeof rawManifest !== 'string') refuse('ARCHIVE_HEAD_INVALID', 503)
      const ball = JSON.parse(rawManifest)
      const codeBySha = {}
      for (const sha of Object.keys(ball?.modules ?? {})) {
        const code = await readHeadBlob(tx, `module:${sha}`)
        if (typeof code !== 'string') refuse('ARCHIVE_MODULE_MISSING', 503, { sha })
        if (await sha256Hex(code) !== sha) refuse('ARCHIVE_MODULE_HASH_MISMATCH', 503, { sha })
        codeBySha[sha] = code
      }
      const aumlokState = await tx.get(AUMLOK_STORAGE_KEY)
      return { ok: true, bootstrap, ball, codeBySha, aumlokState }
    })
    return Response.json(state, { headers: { 'cache-control': 'no-store' } })
  }
  if (path === '/_head/archive-summary') {
    // what status needs from HEAD, in one transaction and without the code or the owner row. Each
    // module is read, checked against its key, counted and dropped; the owner summary is made here, so `aumlok:v1` never
    // leaves HEAD for a status.
    return archiveRouteReply(async () => {
      if (!isObject(body)) refuse('ARCHIVE_REQUEST_INVALID', 400)
      // 1c review: the size guard in front of export and drill (`onePiece: true`) is held to the one-piece rule, never to
      // the status limits: a blob, and the module code in all, over ONE_PIECE_MAX is ARCHIVE_TOO_LARGE_FOR_ONE_PIECE (the
      // snapshot holds them, so it could not fit either), and only the head section's size is answered. Without it this
      // is a status, under the status limits.
      const guard = body.onePiece === true
      const blobLimit = (statusLimit, statusCode) => (guard ? [ONE_PIECE_MAX, 'ARCHIVE_TOO_LARGE_FOR_ONE_PIECE'] : [statusLimit, statusCode])
      return storage.transaction(async tx => {
        const bootstrap = await tx.get(HEAD_BOOTSTRAP_KEY)
        const headId = await tx.get('head')
        if (!isObject(bootstrap) || bootstrap.phase !== 'complete' || !HEX_64.test(bootstrap.seedId ?? '') || !HEX_64.test(headId ?? '')) {
          refuse('ARCHIVE_HEAD_NOT_BOOTSTRAPPED', 503)
        }
        // 1c: the manifest under its byte limit, and its module count checked before any module is read.
        const rawManifest = await readHeadBlobWithin(tx, `manifest:${headId}`, ...blobLimit(STATUS_MANIFEST_MAX_BYTES, 'ARCHIVE_STATUS_MANIFEST_TOO_LARGE'))
        if (typeof rawManifest !== 'string') refuse('ARCHIVE_HEAD_INVALID', 503)
        let ball
        try { ball = JSON.parse(rawManifest) } catch { refuse('ARCHIVE_HEAD_INVALID', 503) }
        if (!guard && isObject(ball?.modules) && Object.keys(ball.modules).length > STATUS_MODULE_COUNT_MAX) {
          refuse('ARCHIVE_STATUS_TOO_MANY_MODULES', 413, { limit: STATUS_MODULE_COUNT_MAX })
        }
        // 1c: the head checks the composite starts with run here, so only their result leaves HEAD (never the manifest).
        const moduleShas = await compositeHeadModuleShas(ball)
        const moduleInventory = []
        // the bytes `codeBySha` takes in a serialized snapshot ({"<sha>":"<code, JSON-escaped>",...}), counted
        // one module at a time, so status can bound the snapshot without the code leaving HEAD.
        let codeJsonBytes = 2
        for (const sha of moduleShas) {
          const code = await readHeadBlobWithin(tx, `module:${sha}`, ...blobLimit(STATUS_MODULE_MAX_BYTES, 'ARCHIVE_STATUS_MODULE_TOO_LARGE'))
          if (typeof code !== 'string') refuse('ARCHIVE_MODULE_MISSING', 503, { sha })
          if (await sha256Hex(code) !== sha) refuse('ARCHIVE_MODULE_HASH_MISMATCH', 503, { sha })
          codeJsonBytes += (moduleInventory.length ? 1 : 0) + jsonByteLength(sha) + 1 + jsonStringByteLength(code)
          moduleInventory.push([sha, utf8ByteLength(code)])
          if (guard && codeJsonBytes > ONE_PIECE_MAX) refuse('ARCHIVE_TOO_LARGE_FOR_ONE_PIECE', 413, { limit: ONE_PIECE_MAX })
        }
        const aumlokState = await tx.get(AUMLOK_STORAGE_KEY)
        const ownerSummary = extractBoundOwnerSummary(aumlokState, body.expectedOwnerPublicKeyHex)
        // the bytes of the snapshot's whole `head` section, as archive-state and export write it: the section
        // measured with an empty `codeBySha` ({}, 2 bytes) and a null owner row (4 bytes), plus their real sizes. A size only.
        const headJsonBytes = jsonByteLength({ bootstrap, ball, codeBySha: {}, aumlokState: null }) - 2 - 4
          + codeJsonBytes + jsonByteLength(aumlokState)
        if (guard) return { ok: true, headJsonBytes }
        // 1c: what the composite needs of the manifest, after the checks above, and nothing else of it.
        const head = { epoch: ball.epoch, ballId: ball.ballId, parentBallId: ball.parentBallId ?? null }
        return { ok: true, seedId: bootstrap.seedId, head, moduleInventory, ownerSummary, headJsonBytes }
      })
    })
  }
  if (path === '/_head/archive-drill-apply') {
    const targetName = body?.targetName
    if (typeof targetName !== 'string' || targetName === LIVE_PRODUCTION_DO_NAME || !DRILL_NAME_RE.test(targetName)) {
      return Response.json({ ok: false, code: 'LIVE_HEAD_REFUSED' }, { status: 403, headers: { 'cache-control': 'no-store' } })
    }
    // an apply belongs to one drill attempt, and writes only into an object free for it.
    const drillId = drillIdOf(body)
    if (drillId === null) return Response.json({ ok: false, code: 'DRILL_ID_INVALID' }, { status: 400, headers: NO_STORE })
    const { seedId, head } = body
    const refused = await storage.transaction(async tx => {
      const claim = await claimDrillTarget(tx, drillId)
      if (claim) return claim
      for (const [sha, code] of Object.entries(head.codeBySha)) {
        await writeHeadBlob(tx, `module:${sha}`, code)
      }
      await writeHeadBlob(tx, `manifest:${head.ball.ballId}`, JSON.stringify(head.ball))
      await tx.put('head', head.ball.ballId)
      await tx.put(HEAD_BOOTSTRAP_KEY, {
        ...head.bootstrap,
        phase: 'complete',
        seedId,
        ballId: head.ball.ballId,
        epoch: head.ball.epoch,
      })
      await tx.put(AUMLOK_STORAGE_KEY, head.aumlokState)
      return null
    })
    if (refused) return drillRefusal(refused)
    const headStore = createDurableHeadStore(storage)
    const [readBack, diffBack] = await Promise.all([
      headStore.read(),
      headStore.stateDiff(head.ball.ballId),
    ])
    return Response.json({
      ok: true,
      ballId: readBack.head?.ballId ?? null,
      moduleCount: Object.keys(readBack.modules ?? {}).length,
      stateDiffChanged: (diffBack?.added?.length ?? 0) + (diffBack?.removed?.length ?? 0) + (diffBack?.changed?.length ?? 0),
    }, { headers: { 'cache-control': 'no-store' } })
  }
  if (path === '/_head/archive-drill-wipe') {
    const targetName = body?.targetName
    if (typeof targetName !== 'string' || targetName === LIVE_PRODUCTION_DO_NAME || !DRILL_NAME_RE.test(targetName)) {
      return Response.json({ ok: false, code: 'LIVE_HEAD_REFUSED' }, { status: 403, headers: { 'cache-control': 'no-store' } })
    }
    // wiped only when proven empty. 1c: under this drill's id, and ended if its apply has not answered.
    return archiveRouteReply(() => wipeDrillStorage(storage, wipeOptionsOf(body)))
  }
  return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 })
}

// a wipe's drill id (none: the job-1 wipe, every row) and whether it ends the object for that drill.
const wipeOptionsOf = body => {
  if (body?.drillId === undefined) return {}
  const drillId = drillIdOf(body)
  if (drillId === null) refuse('DRILL_ID_INVALID', 400)
  return { drillId, end: body.end === true }
}

/** Internal MirrorDO helper for Worker-driven cold archive export and disposable drill DOs. */
export async function handleInternalMirrorArchiveRoute(storage, path, body, { mirrorBootstrapStatus } = {}) {
  if (path === '/_mirror/archive-state') {
    const state = await storage.transaction(async tx => {
      const bootstrap = await tx.get(MIRROR_BOOTSTRAP_KEY)
      const fence = await tx.get(MIRROR_FENCE)
      if (!isObject(bootstrap) || bootstrap.phase !== 'ready') refuse('ARCHIVE_MIRROR_NOT_BOOTSTRAPPED', 503)
      if (!isObject(fence) || !UUID_RE.test(fence.lineageId ?? '') || !Number.isSafeInteger(fence.revision) || fence.revision < 1) {
        refuse('ARCHIVE_MIRROR_FENCE_INVALID', 503)
      }
      // THE LIVE ARCHIVE ROUTE: this is what `/_host/archive` (executeEdgeArchiveOperation)
      // bundles and writes to R2. A row matching the secret-path rule is skipped here, exactly as exportColdArchive skips
      // it: its path is never listed and its bytes are never read. A row this archive's own rule refuses outright is
      // refused, never exported. Every other row is exported exactly as before.
      // more rows than the ceiling are refused (ARCHIVE_TOO_MANY_ENTRIES, 413), never cut short.
      const resetRows = await listMirrorRows(tx, MIRROR_RESET)
      const resetPaths = [...resetRows.values()].map(String).filter(p => !archiveWithholdsPath(p)).sort()
      const entryRows = await listMirrorRows(tx, MIRROR_ENTRY)
      const entries = []
      for (const [, meta] of [...entryRows.entries()]) {
        if (archiveWithholdsPath(meta?.path)) continue
        if (meta.kind === 'dir') {
          entries.push([meta.path, { kind: 'dir', mode: meta.mode }])
        } else if (meta.kind === 'file') {
          let b64 = ''
          const id = await mirrorDigest(meta.path)
          for (let i = 0; i < meta.chunks; i++) {
            const chunk = await tx.get(`${MIRROR_CHUNK}${id}:${i}`)
            if (typeof chunk !== 'string') refuse('ARCHIVE_MIRROR_CHUNK_MISSING', 503, { path: meta.path })
            b64 += chunk
          }
          const rawBytes = base64ToBytes(b64)
          // a body must be the size its row says (as exportColdArchive already requires). Canonical base64 of
          // `bytes` bytes is then exactly 4 * ceil(bytes / 3) characters, which is what archive-plan counts for it.
          if (rawBytes.byteLength !== meta.bytes) refuse('ARCHIVE_MIRROR_SIZE_MISMATCH', 503, { path: meta.path })
          const fileSha256 = await sha256Hex(rawBytes)
          entries.push([meta.path, { kind: 'file', mode: meta.mode, mtimeMs: meta.mtimeMs, b64, sha256: fileSha256, bytes: meta.bytes }])
        }
      }
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return { ok: true, bootstrap, fence, resetPaths, entries }
    })
    return Response.json(state, { headers: { 'cache-control': 'no-store' } })
  }
  if (path === '/_mirror/archive-plan') {
    // what status and the size guard need from the Mirror. Entry METADATA only, under the same
    // bootstrap, fence, ceiling and withhold rules as archive-state; no chunk is read except those of the receipts and
    // checkpoints files, which come by their own keys.
    // 1c: the two seed files are verified HERE and only their summary leaves (the text never does); a size guard asks
    // with `{ seedFiles: false }` and reads neither. The listed rows' metadata is held to STATUS_METADATA_MAX_BYTES.
    const seedFiles = body?.seedFiles !== false
    return archiveRouteReply(() => storage.transaction(async tx => {
      const bootstrap = await tx.get(MIRROR_BOOTSTRAP_KEY)
      const fence = await tx.get(MIRROR_FENCE)
      if (!isObject(bootstrap) || bootstrap.phase !== 'ready') refuse('ARCHIVE_MIRROR_NOT_BOOTSTRAPPED', 503)
      if (!isObject(fence) || !UUID_RE.test(fence.lineageId ?? '') || !Number.isSafeInteger(fence.revision) || fence.revision < 1) {
        refuse('ARCHIVE_MIRROR_FENCE_INVALID', 503)
      }
      let metadataBytes = 0
      const countMetadata = value => {
        metadataBytes += jsonByteLength(value)
        if (metadataBytes > STATUS_METADATA_MAX_BYTES) refuse('ARCHIVE_STATUS_METADATA_TOO_LARGE', 413, { limit: STATUS_METADATA_MAX_BYTES })
      }
      // 1d: counted page by page, before the next page is fetched.
      const resetRows = await pageMirrorRows(tx, MIRROR_RESET, countMetadata)
      const resetPaths = [...resetRows.values()].map(String).filter(p => !archiveWithholdsPath(p))
      const resetCount = resetPaths.length
      const entryRows = await pageMirrorRows(tx, MIRROR_ENTRY, countMetadata)
      const totals = { entries: 0, files: 0, dirs: 0, bodyB64Bytes: 0, largestFileB64: 0, resetCount }
      // the bytes each array takes in a serialized snapshot, one item at a time: what archive-state would put
      // there, with each body counted by its length instead of being read.
      let resetJsonBytes = 2
      for (const [index, p] of resetPaths.entries()) resetJsonBytes += (index ? 1 : 0) + jsonByteLength(p)
      let entriesJsonBytes = 2
      for (const [, meta] of entryRows) {
        if (archiveWithholdsPath(meta?.path)) continue
        let itemBytes
        if (meta?.kind === 'dir') {
          totals.dirs++
          itemBytes = jsonByteLength([meta.path, { kind: 'dir', mode: meta.mode }])
        } else if (meta?.kind === 'file') {
          if (!Number.isSafeInteger(meta.bytes) || meta.bytes < 0) refuse('ARCHIVE_MIRROR_CORRUPT', 503)
          const b64Bytes = 4 * Math.ceil(meta.bytes / 3)
          totals.files++
          totals.bodyB64Bytes += b64Bytes
          totals.largestFileB64 = Math.max(totals.largestFileB64, b64Bytes)
          // Base64 needs no JSON escaping, and archive-state refuses a body whose size is not `bytes`.
          itemBytes = jsonByteLength([meta.path, { kind: 'file', mode: meta.mode, mtimeMs: meta.mtimeMs, b64: '', sha256: SHA256_PLACEHOLDER, bytes: meta.bytes }])
            + b64Bytes
        } else {
          continue
        }
        entriesJsonBytes += (totals.entries ? 1 : 0) + itemBytes
        totals.entries++
      }
      // The snapshot's whole `mirror` section, measured with its two arrays empty ([] twice, 4 bytes) plus their real sizes.
      const mirrorJsonBytes = jsonByteLength({ snapshotFormat: 'x61-mirror-snapshot/v2', bootstrap, fence, resetPaths: [], entries: [] }) - 4
        + resetJsonBytes + entriesJsonBytes
      if (!seedFiles) return { ok: true, totals, mirrorJsonBytes }
      const receiptsText = await readSeedFileText(tx, RECEIPTS_PATH)
      if (typeof receiptsText !== 'string') refuse('ARCHIVE_RECEIPTS_MISSING', 503)
      const checkpointsText = await readSeedFileText(tx, CHECKPOINTS_PATH)
      return { ok: true, totals, mirrorJsonBytes, receiptsText, checkpointsText }
    }).then(async ({ receiptsText, checkpointsText, ...plan }) => (receiptsText === undefined ? plan
      // Verified after the transaction, so no storage read waits on it.
      : { ...plan, receiptsSummary: await verifyArchiveReceiptChain(receiptsText, checkpointsText ?? '') })))
  }
  if (path === '/_mirror/archive-drill-apply') {
    const targetName = body?.targetName
    if (typeof targetName !== 'string' || targetName === LIVE_PRODUCTION_DO_NAME || !DRILL_NAME_RE.test(targetName)) {
      return Response.json({ ok: false, code: 'LIVE_HEAD_REFUSED' }, { status: 403, headers: { 'cache-control': 'no-store' } })
    }
    // an apply belongs to one drill attempt, and writes only into an object free for it.
    const drillId = drillIdOf(body)
    if (drillId === null) return Response.json({ ok: false, code: 'DRILL_ID_INVALID' }, { status: 400, headers: NO_STORE })
    const { seedId, ballId, epoch, mirror } = body
    // 1c: every row key is hashed before the transaction, so it runs storage operations only, start to end.
    const resetIds = []
    for (const resetPath of mirror.resetPaths) resetIds.push(await mirrorDigest(resetPath))
    const entryIds = []
    for (const [p] of mirror.entries) entryIds.push(await mirrorDigest(p))
    const refused = await storage.transaction(async tx => {
      const claim = await claimDrillTarget(tx, drillId)
      if (claim) return claim
      await tx.put(MIRROR_FENCE, mirror.fence)
      for (const [index, resetPath] of mirror.resetPaths.entries()) {
        await tx.put(MIRROR_RESET + resetIds[index], resetPath)
      }
      for (const [index, [p, wire]] of mirror.entries.entries()) {
        const id = entryIds[index]
        if (wire.kind === 'dir') {
          await tx.put(MIRROR_ENTRY + id, { path: p, kind: 'dir', mode: wire.mode })
        } else {
          const chunks = Math.ceil(wire.b64.length / MIRROR_CHUNK_CHARS)
          for (let i = 0; i < chunks; i++) {
            await tx.put(`${MIRROR_CHUNK}${id}:${i}`, wire.b64.slice(i * MIRROR_CHUNK_CHARS, (i + 1) * MIRROR_CHUNK_CHARS))
          }
          await tx.put(MIRROR_ENTRY + id, {
            path: p,
            kind: 'file',
            mode: wire.mode,
            mtimeMs: wire.mtimeMs,
            chunks,
            bytes: wire.bytes,
          })
        }
      }
      await tx.put(MIRROR_BOOTSTRAP_KEY, {
        ...mirror.bootstrap,
        phase: 'ready',
        seedId,
        ballId,
        epoch,
        lineageId: mirror.fence.lineageId,
        revision: mirror.fence.revision,
      })
      return null
    })
    if (refused) return drillRefusal(refused)
    const bootStatus = typeof mirrorBootstrapStatus === 'function'
      ? await mirrorBootstrapStatus(storage)
      : await storage.get(MIRROR_BOOTSTRAP_KEY)
    return Response.json({ ok: true, phase: bootStatus?.phase ?? null }, { headers: { 'cache-control': 'no-store' } })
  }
  if (path === '/_mirror/archive-drill-wipe') {
    const targetName = body?.targetName
    if (typeof targetName !== 'string' || targetName === LIVE_PRODUCTION_DO_NAME || !DRILL_NAME_RE.test(targetName)) {
      return Response.json({ ok: false, code: 'LIVE_HEAD_REFUSED' }, { status: 403, headers: { 'cache-control': 'no-store' } })
    }
    // wiped only when proven empty. 1c: under this drill's id, and ended if its apply has not answered.
    return archiveRouteReply(() => wipeDrillStorage(storage, wipeOptionsOf(body)))
  }
  return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 })
}

/**
 * a durable object reply's text, read no further than `maxBytes` (the stream is cancelled past it and
 * ARCHIVE_STATUS_REPLY_TOO_LARGE answered). Without a limit, the whole reply (export and drill read whole states).
 */
async function readReplyText(resp, maxBytes) {
  if (maxBytes === undefined) return resp.text()
  const reader = resp.body?.getReader?.()
  if (!reader) {
    const text = await resp.text()
    if (utf8ByteLength(text) > maxBytes) refuse('ARCHIVE_STATUS_REPLY_TOO_LARGE', 413, { limit: maxBytes })
    return text
  }
  const parts = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maxBytes) {
      void reader.cancel().catch(() => {})
      refuse('ARCHIVE_STATUS_REPLY_TOO_LARGE', 413, { limit: maxBytes })
    }
    parts.push(value)
  }
  const all = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) { all.set(part, offset); offset += part.byteLength }
  return new TextDecoder().decode(all)
}

async function internalDoReply(binding, doName, path, seedId, body, maxReplyBytes) {
  const resp = await binding.get(binding.idFromName(doName)).fetch(new Request(`https://x61.internal${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-x6-internal-authorized': '1',
      ...(seedId ? { 'x-x6-bootstrap-seed': seedId } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const text = await readReplyText(resp, maxReplyBytes)
  let data = null
  try { data = JSON.parse(text) } catch { data = null }
  return { resp, data }
}

async function internalDoJson(binding, doName, path, seedId, body, maxReplyBytes = undefined) {
  return okData(await internalDoReply(binding, doName, path, seedId, body, maxReplyBytes))
}

/** A durable object reply's data when it says ok; otherwise its coded refusal, with its status (and named limit). */
function okData({ resp, data }) {
  if (!resp.ok || data?.ok !== true) {
    refuse(typeof data?.code === 'string' ? data.code : 'ARCHIVE_DO_CALL_FAILED', resp.status >= 400 ? resp.status : 503,
      Number.isSafeInteger(data?.limit) ? { limit: data.limit } : {})
  }
  return data
}

/**
 * the copy of an archive that may go back to a browser without the owner's passkey. HEAD's `aumlok:v1` row
 * (`head.aumlokState`) holds the recovery commitment, the root escrow, every challenge that copies them and, on a legacy
 * store, the pepper that keys both: with it anyone can test guesses of the owner's seven words offline. That whole row is
 * removed; everything else (Pearl, modules, mirror files, receipts, owner summary, composite head) stays. The copy says
 * `ownerSecrets: 'withheld'`, names the full archive it came from (`sourceArchiveId`), and gets its own `archiveId`
 * over exactly what it holds, so it verifies as itself. It is not a restore source: `verifyColdArchive` refuses it.
 * @param {object} bundle A complete archive bundle (as written to R2).
 * @returns {Promise<object>} The withheld copy.
 */
export async function withholdOwnerSecrets(bundle) {
  const { archiveId: sourceArchiveId, ...unsigned } = bundle
  const { aumlokState: _withheld, ...head } = unsigned.head
  const withheld = { ...unsigned, head, ownerSecrets: 'withheld', sourceArchiveId }
  return { archiveId: await sha256Hex(COLD_ARCHIVE_SCHEMA + '\0' + canonicalJson(withheld)), ...withheld }
}

/**
 * the full bundle (owner-secret row included) is released to a caller only under a Class 3 passkey approval
 * bound to this exact request body, consumed once by HEAD (`authorizeClass3`, the Worker's `edgeClass3`). No approval
 * header: null (the reply is withheld). A header that does not carry a valid, unexpired, unspent approval for exactly
 * this body: refused, nothing exported.
 */
async function ownerSecretsApproval({ request, input, authorizeClass3, now }) {
  if (!request?.headers?.has('x-x6-class3-approval')) return null
  if (typeof authorizeClass3 !== 'function') refuse('CLASS3_WEBAUTHN_REQUIRED', 403)
  const url = new URL(request.url)
  const expected = await aumlokClass3Binding({ audience: url.origin, method: request.method, pathname: url.pathname, body: input })
  const approval = await authorizeClass3(input)
  if (approval?.ok !== true || canonicalJson(approval.binding) !== canonicalJson(expected)
    || !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= now()) refuse('CLASS3_WEBAUTHN_REQUIRED', 403)
  return { expiresAt: approval.expiresAt }
}

/** the bucket's LATEST pointer, refused unread when the object is larger than a pointer can be. */
async function readLatestPointer(bucket) {
  if (!bucket || typeof bucket.get !== 'function') return null
  const pointer = await bucket.get('snapshots/LATEST.json')
  if (!pointer) return null
  if (!Number.isSafeInteger(pointer.size) || pointer.size < 0 || pointer.size > LATEST_POINTER_MAX) {
    if (typeof pointer.body?.cancel === 'function') void pointer.body.cancel().catch(() => {})
    refuse('ARCHIVE_METADATA_INVALID', 503)
  }
  const text = await pointer.text()
  if (encoder.encode(text).byteLength > LATEST_POINTER_MAX) refuse('ARCHIVE_METADATA_INVALID', 503)
  try { return JSON.parse(text) } catch { return refuse('ARCHIVE_METADATA_INVALID', 503) }
}

/**
 * wipe both disposable drill objects, each under its own deadline. True only when both answer that
 * they are proven empty; a wipe that fails, answers anything else or does not answer in time makes it false.
 */
async function wipeDrillPair(env, targetName, deadlineMs, { drillId, endHead = false, endMirror = false }) {
  // 1c: each object's own answer: clean (nothing of this drill left), or the rows left (null: no answer in time).
  const wipe = async (object, binding, path, end) => {
    let timer
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), deadlineMs) })
    try {
      const answer = await Promise.race([
        internalDoReply(binding, targetName, path, undefined, { targetName, drillId, end }, STATUS_REPLY_MAX_BYTES).then(({ data }) => data, () => null),
        deadline,
      ])
      const clean = answer?.ok === true && answer.remainingRows === 0 && (answer.wiped === true || answer.ours === false)
      const remainingRows = Number.isSafeInteger(answer?.remainingRows) && answer.remainingRows >= 0 ? answer.remainingRows : null
      // 1c review: an object left holding its end mark is not clean: the cleanup is pending, with that row counted.
      return { object, clean, remainingRows: clean ? 0 : remainingRows, ...(answer?.remainingRowsAtLeast === true ? { remainingRowsAtLeast: true } : {}),
        ...(answer?.endMarkLeft === true ? { endMarkLeft: true } : {}) }
    } finally {
      clearTimeout(timer)
    }
  }
  const objects = await Promise.all([
    wipe('HEAD', env.HEAD, '/_head/archive-drill-wipe', endHead),
    wipe('MIRROR', env.MIRROR, '/_mirror/archive-drill-wipe', endMirror),
  ])
  const clean = objects.every(entry => entry.clean)
  return { clean, cleanup: { pending: !clean, targetName, objects: objects.map(({ clean: _clean, ...entry }) => entry) } }
}

/**
 * one drill wait (an apply or a read-back) under the drill's deadline. Past it, DRILL_DEADLINE_EXCEEDED
 * names the step. The losing request is not cancelled, which is why a late apply must find its object ended.
 */
async function withinDrillDeadline(promise, deadlineAt, step) {
  let timer
  // The wall clock, not the injectable `now` (a test may hold that still).
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(archiveError('DRILL_DEADLINE_EXCEEDED', 503, { step })), Math.max(0, deadlineAt - Date.now()))
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * a bound, never below, on the bytes export would write for the live state status just summarized. The
 * snapshot's top level is measured as is, with its `head` and `mirror` sections as null (4 bytes each) and `exportedAt` as
 * 0 (1 byte); then HEAD's and the Mirror's exact section sizes are added, and the most any number can take for
 * `exportedAt`. Every other top-level field (archiveId: 64 hex; seedId, compositeHead, ownerSummary, receiptsSummary) is
 * the value export writes for the same state, so the bound exceeds the real size by at most 24 bytes.
 */
function serializedBundleBytesAtMost({ seedId, compositeHead, ownerSummary, receiptsSummary, headJsonBytes, mirrorJsonBytes }) {
  if (!Number.isSafeInteger(headJsonBytes) || headJsonBytes < 0 || !Number.isSafeInteger(mirrorJsonBytes) || mirrorJsonBytes < 0) {
    refuse('ARCHIVE_PLAN_INVALID', 503)
  }
  const frame = jsonByteLength({ archiveId: SHA256_PLACEHOLDER, schema: COLD_ARCHIVE_SCHEMA, hashAlgorithm: PINNED_HASH_ALGORITHM,
    exportedAt: 0, seedId, compositeHead, ownerSummary, receiptsSummary, head: null, mirror: null })
  return frame - 4 - 4 - 1 + headJsonBytes + mirrorJsonBytes + NUMBER_JSON_MAX_BYTES
}

/** Execute `/_host/archive` over live Worker bindings (`HEAD`, `MIRROR`, optional `ARCHIVE_BUCKET`). */
export async function executeEdgeArchiveOperation({ env, seedId, input, now = Date.now, request = null, authorizeClass3 = null,
  drillWipeDeadlineMs = DRILL_WIPE_DEADLINE_MS, drillDeadlineMs = DRILL_DEADLINE_MS }) {
  // an archive a client hands in is never drilled, verified or restored here, whatever it claims: its owner
  // record can be stripped and refilled with well-formed values and a recomputed digest. Every action works only on
  // what the service itself holds (the live HEAD and Mirror, or a snapshot it wrote to its own bucket).
  if (isObject(input) && Object.hasOwn(input, 'bundle')) refuse('ARCHIVE_CLIENT_BUNDLE_REFUSED', 400)
  const action = typeof input?.action === 'string' ? input.action : 'status'
  const expectedOwnerPublicKeyHex = env.OWNER_PUBLIC_KEY_HEX
  const archiveBucket = env.ARCHIVE_BUCKET ?? null
  const aumlokPepperSecret = env.AUMLOK_PEPPER_SECRET

  const buildLiveBundle = async () => {
    const [headState, mirrorState] = await Promise.all([
      internalDoJson(env.HEAD, LIVE_PRODUCTION_DO_NAME, '/_head/archive-state', seedId),
      internalDoJson(env.MIRROR, LIVE_PRODUCTION_DO_NAME, '/_mirror/archive-state', seedId),
    ])
    const findUtf8 = targetPath => {
      const found = mirrorState.entries.find(([p, wire]) => p === targetPath && wire.kind === 'file')
      return found ? decoder.decode(base64ToBytes(found[1].b64)) : null
    }
    const receiptsText = findUtf8(RECEIPTS_PATH)
    if (receiptsText === null) refuse('ARCHIVE_RECEIPTS_MISSING', 503)
    const checkpointsText = findUtf8(CHECKPOINTS_PATH) ?? ''
    const receiptsSummary = await verifyArchiveReceiptChain(receiptsText, checkpointsText)
    const ownerSummary = extractBoundOwnerSummary(headState.aumlokState, expectedOwnerPublicKeyHex)
    const compositeHead = await computeCompositeHeadCommitment({
      head: headState.ball,
      codeBySha: headState.codeBySha,
      ownerSummary,
      receiptsSummary,
    })
    const exportedAt = now()
    const unsignedBundle = {
      schema: COLD_ARCHIVE_SCHEMA,
      hashAlgorithm: PINNED_HASH_ALGORITHM,
      exportedAt,
      seedId: headState.bootstrap.seedId,
      compositeHead,
      ownerSummary,
      receiptsSummary,
      head: {
        bootstrap: headState.bootstrap,
        ball: headState.ball,
        codeBySha: headState.codeBySha,
        aumlokState: headState.aumlokState,
      },
      mirror: {
        snapshotFormat: 'x61-mirror-snapshot/v2',
        bootstrap: mirrorState.bootstrap,
        fence: mirrorState.fence,
        resetPaths: mirrorState.resetPaths,
        entries: mirrorState.entries,
      },
    }
    const archiveId = await sha256Hex(COLD_ARCHIVE_SCHEMA + '\0' + canonicalJson(unsignedBundle))
    return { archiveId, ...unsignedBundle }
  }

  // the live state's size and summaries from metadata only (HEAD's module inventory and owner summary,
  // the Mirror's entry totals and its two seed files). No body crosses the Worker.
  // 1c: each reply is read under STATUS_REPLY_MAX_BYTES; the seed files are verified in the Mirror (`seedFiles`, for a
  // status only) and HEAD sends the composite's head facts instead of its manifest.
  // 1c review: the size guard (`forStatus: false`) asks HEAD under the one-piece rule and needs only the two section sizes.
  const readLivePlan = async ({ forStatus }) => {
    const [headSummary, mirrorPlan] = await Promise.all([
      internalDoJson(env.HEAD, LIVE_PRODUCTION_DO_NAME, '/_head/archive-summary', seedId,
        { expectedOwnerPublicKeyHex, ...(forStatus ? {} : { onePiece: true }) }, STATUS_REPLY_MAX_BYTES),
      internalDoJson(env.MIRROR, LIVE_PRODUCTION_DO_NAME, '/_mirror/archive-plan', seedId, { seedFiles: forStatus }, STATUS_REPLY_MAX_BYTES),
    ])
    const { headJsonBytes } = headSummary
    const { mirrorJsonBytes } = mirrorPlan
    if (!Number.isSafeInteger(headJsonBytes) || headJsonBytes < 0 || !Number.isSafeInteger(mirrorJsonBytes) || mirrorJsonBytes < 0) {
      refuse('ARCHIVE_PLAN_INVALID', 503)
    }
    // a floor under the serialized snapshot: its `head` and `mirror` sections, each measured exactly where
    // it lives (headJsonBytes, mirrorJsonBytes). The snapshot holds both and more, so it is never smaller than their sum.
    const serializedBytesAtLeast = headJsonBytes + mirrorJsonBytes
    if (!forStatus) return { serializedBytesAtLeast }
    if (!Array.isArray(headSummary.moduleInventory) || headSummary.moduleInventory.length > STATUS_MODULE_COUNT_MAX
      || !isObject(mirrorPlan.totals)) refuse('ARCHIVE_PLAN_INVALID', 503)
    const moduleBytes = headSummary.moduleInventory.reduce((sum, item) => sum + (Array.isArray(item) && Number.isSafeInteger(item[1]) ? item[1] : 0), 0)
    const { entries, files, bodyB64Bytes, largestFileB64 } = mirrorPlan.totals
    const counts = { entries, files, bodyB64Bytes, largestFileB64, moduleCount: headSummary.moduleInventory.length, moduleBytes }
    return { headSummary, mirrorPlan, counts, serializedBytesAtLeast }
  }
  // the early size guard. A live state whose floor is already over one piece is refused before any body is read.
  const refuseOverOnePiece = async () => {
    const { serializedBytesAtLeast } = await readLivePlan({ forStatus: false })
    refuseUnlessOnePiece(serializedBytesAtLeast)
  }
  // the live bundle, refused unless its serialized bytes fit in one piece (the export writes exactly these).
  const buildOnePieceBundle = async () => {
    await refuseOverOnePiece()
    const bundle = await buildLiveBundle()
    const serialized = JSON.stringify(bundle)
    refuseUnlessOnePiece(utf8ByteLength(serialized))
    return { bundle, serialized }
  }

  if (action === 'status') {
    // status never builds a bundle; its five fields are computed from the plan exactly as before.
    // 1c: the receipts summary comes from the Mirror and the head facts from HEAD, each made from their bytes there.
    const { headSummary, mirrorPlan, counts } = await readLivePlan({ forStatus: true })
    if (!isObject(mirrorPlan.receiptsSummary) || !isObject(headSummary.ownerSummary)) refuse('ARCHIVE_PLAN_INVALID', 503)
    const { receiptsSummary } = mirrorPlan
    const ownerSummary = headSummary.ownerSummary
    const liveCompositeHead = await compositeFromHeadFacts({ head: headSummary.head, moduleInventory: headSummary.moduleInventory, ownerSummary, receiptsSummary })
    const serializedBytesAtMost = serializedBundleBytesAtMost({ seedId: headSummary.seedId, compositeHead: liveCompositeHead,
      ownerSummary, receiptsSummary, headJsonBytes: headSummary.headJsonBytes, mirrorJsonBytes: mirrorPlan.mirrorJsonBytes })
    const plan = { ...counts, serializedBytesAtMost, withinOnePiece: fitsInOnePiece(serializedBytesAtMost) }
    const latestR2 = await readLatestPointer(archiveBucket)
    return {
      ok: true,
      coldR2BackupConfigured: Boolean(archiveBucket),
      latestR2Snapshot: latestR2,
      liveCompositeHead,
      ownerSummary,
      receiptsSummary,
      plan,
    }
  }

  if (action === 'export') {
    const includeBundle = input?.includeBundle === true
    // judged (and the approval spent) before anything is read or written; only a bundle reply can carry the row.
    const approved = includeBundle ? await ownerSecretsApproval({ request, input, authorizeClass3, now }) : null
    // judged on the exact bytes written below, before the first put; refused, nothing is written.
    const { bundle, serialized } = await buildOnePieceBundle()
    let r2Key = null
    let r2Stored = false
    if (archiveBucket && typeof archiveBucket.put === 'function') {
      for (const [sha, code] of Object.entries(bundle.head.codeBySha)) {
        await archiveBucket.put(`modules/${sha}.js`, code, { customMetadata: { sha256: sha } })
      }
      for (const [, wire] of bundle.mirror.entries) {
        if (wire.kind === 'file') {
          await archiveBucket.put(`files/${wire.sha256}.b64`, wire.b64, { customMetadata: { sha256: wire.sha256 } })
        }
      }
      r2Key = `snapshots/epoch-${String(bundle.head.ball.epoch)}-${bundle.head.ball.ballId}.json`
      await archiveBucket.put(r2Key, serialized)
      await archiveBucket.put('snapshots/LATEST.json', JSON.stringify({
        schema: COLD_ARCHIVE_SCHEMA,
        archiveId: bundle.archiveId,
        r2Key,
        exportedAt: bundle.exportedAt,
        epoch: bundle.head.ball.epoch,
        ballId: bundle.head.ball.ballId,
        moduleCount: bundle.compositeHead.moduleCount,
        receiptCount: bundle.receiptsSummary.receiptCount,
        merkleRoot: bundle.receiptsSummary.merkleRoot,
        checkpointCount: bundle.receiptsSummary.checkpointCount,
        compositeHeadHash: bundle.compositeHead.compositeHeadHash,
        credentialId: bundle.ownerSummary.credentialId,
        signerCounter: bundle.ownerSummary.signerCounter,
      }))
      r2Stored = true
    }
    await internalDoJson(env.HEAD, LIVE_PRODUCTION_DO_NAME, '/_head/telemetry', seedId, {
      kind: 'archive',
      record: {
        archiveId: bundle.archiveId,
        exportedAt: bundle.exportedAt,
        epoch: bundle.head.ball.epoch,
        ballId: bundle.head.ball.ballId,
        moduleCount: bundle.compositeHead.moduleCount,
        receiptCount: bundle.receiptsSummary.receiptCount,
        receiptMerkleRoot: bundle.receiptsSummary.merkleRoot,
        checkpointCount: bundle.receiptsSummary.checkpointCount,
        compositeHeadHash: bundle.compositeHead.compositeHeadHash,
        r2Stored,
        r2Key,
      },
    }).catch(() => {})
    // the R2 copy above is the edge's own and keeps the row (a rebuild needs it); the reply keeps it only when
    // approved, and the approval must still be live when the reply leaves.
    if (approved && approved.expiresAt <= now()) refuse('CLASS3_APPROVAL_EXPIRED', 403)
    const replyBundle = !includeBundle ? null : approved ? bundle : await withholdOwnerSecrets(bundle)
    return {
      ok: true,
      archiveId: bundle.archiveId,
      exportedAt: bundle.exportedAt,
      epoch: bundle.head.ball.epoch,
      ballId: bundle.head.ball.ballId,
      moduleCount: bundle.compositeHead.moduleCount,
      mirrorEntryCount: bundle.mirror.entries.length,
      receiptsSummary: bundle.receiptsSummary,
      ownerSummary: bundle.ownerSummary,
      compositeHead: bundle.compositeHead,
      r2Stored,
      r2Key,
      ...(includeBundle ? { ownerSecrets: approved ? 'included' : 'withheld', bundle: replyBundle } : {}),
    }
  }

  if (action === 'rebuild_drill') {
    // a name the caller gives is only a LABEL, carried back in the reply; it never selects an object. It
    // is still refused when it is the live name or not a drill name, as before.
    const label = typeof input?.targetName === 'string' ? input.targetName : null
    if (label !== null && (label === LIVE_PRODUCTION_DO_NAME || !DRILL_NAME_RE.test(label))) {
      refuse('LIVE_HEAD_REFUSED', 403)
    }
    // the source is a snapshot the service wrote to its own bucket (by its exact key), or else the live state.
    // A key that is asked for is read from the bucket or refused; it never quietly falls back to the live state.
    let bundle
    if (input?.r2Key !== undefined) {
      if (typeof input.r2Key !== 'string' || !SNAPSHOT_KEY_RE.test(input.r2Key)) refuse('ARCHIVE_R2_KEY_INVALID', 400)
      if (!archiveBucket || typeof archiveBucket.get !== 'function') refuse('ARCHIVE_BUCKET_UNAVAILABLE', 503)
      const obj = await archiveBucket.get(input.r2Key)
      if (!obj) refuse('ARCHIVE_SNAPSHOT_NOT_FOUND', 404)
      // an object over one piece is refused before its text is read. 1b: judged by the same rule export
      // applied to these bytes when it wrote them (the object's size is their UTF-8 length).
      if (!fitsInOnePiece(obj.size)) {
        if (typeof obj.body?.cancel === 'function') void obj.body.cancel().catch(() => {})
        if (!Number.isSafeInteger(obj.size) || obj.size < 0) refuse('ARCHIVE_SNAPSHOT_CORRUPT', 409)
        refuseUnlessOnePiece(obj.size)
      }
      try { bundle = JSON.parse(await obj.text()) } catch { refuse('ARCHIVE_SNAPSHOT_CORRUPT', 409) }
    } else {
      // the live drill accepts exactly the states an export would write.
      bundle = (await buildOnePieceBundle()).bundle
    }
    const verified = await verifyColdArchive(bundle, {
      expectedOwnerPublicKeyHex,
      minimumEpoch: bundle.head?.ball?.epoch ?? 1,
      minimumReceiptCount: bundle.receiptsSummary?.receiptCount ?? 1,
      minimumCheckpointCount: bundle.receiptsSummary?.checkpointCount ?? 0,
      expectedCompositeHeadHash: bundle.compositeHead?.compositeHeadHash,
    })
    // the owner row must load in the AUMLOK store before either drill object is touched.
    await verifyRestorableOwnerRecord(bundle.head.aumlokState, { expectedOwnerPublicKeyHex, pepperSecret: aumlokPepperSecret })
    let readback = null
    let failure = null
    let failed = false
    // this attempt's own id. Each apply reserves its object for it; the cleanup touches only objects
    // that are this attempt's (or nobody's), and ends an object whose apply has not answered, so that apply writes no row.
    // 1d: the attempt's two disposable objects are named by that id alone (drillObjectNameOf), fresh for every
    // attempt, so no two attempts ever share an object and "cleaned" speaks only of objects this attempt could have written.
    const drillId = crypto.randomUUID().toLowerCase()
    const objectName = drillObjectNameOf(drillId)
    const applies = { HEAD: 'unsent', MIRROR: 'unsent' }
    const deadlineAt = Date.now() + drillDeadlineMs
    const apply = (object, binding, path, body) => {
      applies[object] = 'pending'
      const answered = internalDoReply(binding, objectName, path, undefined, { ...body, targetName: objectName, drillId })
        .then(reply => { applies[object] = 'answered'; return reply })
      return withinDrillDeadline(answered, deadlineAt, `${object}_APPLY`).then(okData)
    }
    const readBack = (binding, path, step) => withinDrillDeadline(internalDoJson(binding, objectName, path, bundle.seedId), deadlineAt, step)
    try {
      await apply('MIRROR', env.MIRROR, '/_mirror/archive-drill-apply', {
        seedId: bundle.seedId,
        ballId: bundle.head.ball.ballId,
        epoch: bundle.head.ball.epoch,
        mirror: bundle.mirror,
      })
      const headApply = await apply('HEAD', env.HEAD, '/_head/archive-drill-apply', {
        seedId: bundle.seedId,
        head: bundle.head,
      })
      const [restoredHead, restoredMirror] = await Promise.all([
        readBack(env.HEAD, '/_head/archive-state', 'HEAD_READBACK'),
        readBack(env.MIRROR, '/_mirror/archive-state', 'MIRROR_READBACK'),
      ])
      const restoredOwner = extractBoundOwnerSummary(restoredHead.aumlokState, expectedOwnerPublicKeyHex)
      // the row read back from the drill HEAD loads too, so the phase reported is one the store accepts.
      await verifyRestorableOwnerRecord(restoredHead.aumlokState, { expectedOwnerPublicKeyHex, pepperSecret: aumlokPepperSecret })
      const findRestoredUtf8 = targetPath => {
        const found = restoredMirror.entries.find(([p, wire]) => p === targetPath && wire.kind === 'file')
        return found ? decoder.decode(base64ToBytes(found[1].b64)) : null
      }
      const restoredReceipts = await verifyArchiveReceiptChain(
        findRestoredUtf8(RECEIPTS_PATH),
        findRestoredUtf8(CHECKPOINTS_PATH) ?? '',
      )
      const restoredComposite = await computeCompositeHeadCommitment({
        head: restoredHead.ball,
        codeBySha: restoredHead.codeBySha,
        ownerSummary: restoredOwner,
        receiptsSummary: restoredReceipts,
      })
      if (headApply.stateDiffChanged !== 0
        || headApply.moduleCount !== verified.moduleCount
        || restoredComposite.compositeHeadHash !== verified.compositeHead.compositeHeadHash
        || restoredOwner.credentialId !== verified.ownerSummary.credentialId
        || restoredOwner.signerCounter !== verified.ownerSummary.signerCounter
        || restoredReceipts.merkleRoot !== verified.receiptsSummary.merkleRoot) {
        refuse('DRILL_READBACK_PARITY_FAILED', 503)
      }
      readback = {
        archiveId: verified.archiveId,
        epoch: verified.epoch,
        ballId: verified.ballId,
        verifiedModules: headApply.moduleCount,
        mirrorEntryCount: restoredMirror.entries.length,
        stateDiffChanged: headApply.stateDiffChanged,
        receiptCount: restoredReceipts.receiptCount,
        merkleRoot: restoredReceipts.merkleRoot,
        checkpointCount: restoredReceipts.checkpointCount,
        ownerPhase: restoredOwner.phase,
        ownerCredentialId: restoredOwner.credentialId,
        ownerSignerCounter: restoredOwner.signerCounter,
        compositeHead: restoredComposite,
      }
    } catch (error) {
      failed = true
      failure = error
    }
    // both wipes run before any reply is built, each under its deadline. A failed read-back still
    // wipes and still answers with its own code; a good one is reported clean only when both objects proved empty.
    // 1c: an apply still pending (no answer by the deadline) gets its object ended. A failure keeps its own code
    // and carries the cleanup's status (`cleanup`: pending or not, the target, each object's rows left, null when its
    // wipe did not answer); with no failure, a cleanup that is not complete answers DRILL_CLEANUP_PENDING with the same.
    const { clean, cleanup } = await wipeDrillPair(env, objectName, drillWipeDeadlineMs,
      { drillId, endHead: applies.HEAD === 'pending', endMirror: applies.MIRROR === 'pending' })
    if (failed) {
      // 1d review: a failure without a well-formed code (a rejected object call, a TypeError in the read-back) becomes
      // DRILL_FAILED carrying the cleanup, so the owner's reply still says what is left behind; its message stays here.
      const coded = failure !== null && typeof failure === 'object' && typeof failure.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(failure.code)
      if (!coded) throw archiveError('DRILL_FAILED', 503, { cleanup })
      failure.cleanup = cleanup
      throw failure
    }
    if (!clean) refuse('DRILL_CLEANUP_PENDING', 503, { targetName: objectName, cleanup })
    // 1d: `label` is the caller's name (null when none was given); `targetName` is this attempt's own object name.
    return { ok: true, label, attemptId: drillId, targetName: objectName, disposableStorageCleanedUp: true, ...readback }
  }

  refuse('ARCHIVE_ACTION_INVALID', 400)
}
