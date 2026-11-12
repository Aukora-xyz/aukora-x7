/**
 * The vault: a private, hash-named blob store and checked rescue indexes, Worker to R2 (`env.ARCHIVE_BUCKET`).
 * Every key lives under `w/<world>/`:
 *   w/<world>/blob/<sha256>                 one piece (PIECE bytes at most), named by the SHA-256 of its bytes
 *   w/<world>/rescue/<id>/pending.json      a rescue index, byte for byte as sent; <id> = first 32 hex of its SHA-256
 *   w/<world>/rescue/<id>/manifest.json     written ONCE, when every piece the index names was found at its size
 *   w/<world>/progress/<id>/<cursor>        written once per verify step: proof that this cursor was given out here
 *   w/<world>/rescue-slot/<n>               one per VERIFIED rescue, n below VAULT_MAX_RESCUES; body and customMetadata
 *                                           `rescue` name the rescue id; claimed before its manifest is written
 * Nothing here deletes or rewrites a key: every write is `if-none-match: *`, and there is no delete route and no
 * `bucket.delete` call. Pieces and indexes are hashed here and checked with `head` before their `put`, so a repeated
 * upload never leans on R2's condition. Two writers racing for ONE key do lean on it (UNVERIFIED on a real bucket):
 * two uploads of the same piece, two claims of the same rescue slot. A slot is never freed in this version: there is
 * no delete route, so a verified rescue keeps its slot; at the cap only raising VAULT_MAX_RESCUES makes room.
 *
 * The caller has checked the owner session and the world's readiness; `ready !== true` is still refused here before
 * any bucket or budget call. Every refusal is RETURNED as a Response (the Worker keeps only some thrown statuses), and
 * the handler never throws.
 *
 * Bodies: a request body is copied into ONE buffer of the route's limit (or of a sane content-length), never kept as a
 * chunk per read; only delivered bytes reset the idle wait, and more than EMPTY_READS_MAX empty reads is a stall. A GET
 * reads the stored object's body here, under its own deadlines, and answers the complete bytes with their length, or
 * 503 ARCHIVE_UNAVAILABLE with `retry-after` when the body stalls, ends short or runs long: never a 200 that can stall.
 *
 * `budget` is injected as `{ charge, count, release }` (world-budget.mjs behind MIRROR's internal route in the Worker;
 * a fake in tests), each called with `{ kind: 'blob', bytes, ref: <the piece's sha256> }`. A new piece is CHARGED
 * before its put (check and count in one MIRROR step, so concurrent uploads from any isolate cannot pass one
 * allowance together), counted with its ref after a put that stored it or found it there (which settles the
 * reservation, and counts a piece once if nothing had), and released after a put that failed when a `head` then does
 * not find it, or after a charge whose answer never came (no put follows it). A put whose answer never came keeps its
 * reservation. world-budget.mjs says what the row can drift by.
 */

/** The piece size: a protocol constant shared with the rescue kit. Never read from env. */
export const PIECE = 2097152
export const INDEX_MAX_BYTES = 4 * 1024 * 1024
export const INDEX_MAX_ROWS = 50000
export const VERIFY_STEP = 40
export const VAULT_DEFAULT_DEADLINES = Object.freeze({ r2Ms: 10000, budgetMs: 10000, idleMs: 30000, totalMs: 120000, getIdleMs: 10000, getTotalMs: 60000 })
/** A body read that gets this many empty chunks without a byte is treated as stalled (408): a second, CPU bound. */
export const EMPTY_READS_MAX = 4096
/** The wait a 503 from a stalled or short stored body asks for, in seconds. */
const STORED_RETRY_AFTER = '2'
export const VAULT_DEFAULT_LIMITS = Object.freeze({ maxRescues: 32, maxPending: 64 })
// One bounded list counts rescues: each rescue holds at most two keys under rescue/, so 2 * (240 + 240) < 1000.
const RESCUE_LIMIT_CEILING = 240
const LIST_LIMIT = 1000
const SLOT_NAME = /^(0|[1-9][0-9]{0,2})$/

const WORLD_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/
const ROW_TYPES = new Set(['file', 'dir', 'gone', 'meta', 'local'])
const EMPTY_ROW_TYPES = new Set(['dir', 'gone'])

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

/**
 * @param {unknown} value
 * @param {number} status
 * @param {Record<string, string>} [extra]
 */
const json = (value, status, extra = {}) => new Response(JSON.stringify(value), {
  status, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra },
})
/** @param {string} code @param {number} status @param {Record<string, unknown>} [fields] @param {Record<string, string>} [extra] */
const refuse = (code, status, fields = {}, extra = {}) => json({ ok: false, code, ...fields }, status, extra)

class Late extends Error {
  constructor() { super('DEADLINE'); this.name = 'Late' }
}

/**
 * Race one promise against a deadline. Late is a thrown `Late`; the callers turn it into a returned 503.
 * @template T
 * @param {Promise<T> | T} work
 * @param {number} ms
 * @returns {Promise<T>}
 */
async function withDeadline(work, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const late = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Late()), ms) })
  try {
    return await Promise.race([Promise.resolve(work), late])
  } finally {
    clearTimeout(timer)
  }
}

/** @param {Uint8Array} bytes */
async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', /** @type {Uint8Array<ArrayBuffer>} */ (bytes)))
  let out = ''
  for (const b of digest) out += b.toString(16).padStart(2, '0')
  return out
}

/** @param {unknown} value */
const positiveSafeInteger = value => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value !== 'string' || !/^[0-9]{1,16}$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * Drain a stream into ONE preallocated buffer: `capacity` bytes are allocated up front (never more than `limit`), no
 * chunk object is kept, an empty chunk neither resets the idle wait nor is kept, and more than EMPTY_READS_MAX empty
 * reads count as a stall. `idleMs` runs from the last DELIVERED byte; `totalMs` from the start.
 * Returns `{ bytes }` (a view of exactly the bytes read) or `{ fault }`: 'large' (past `limit`), 'long' (past
 * `capacity` but within `limit`), 'stall' (a deadline or the empty-read cap), 'error' (a read rejected: the sender's
 * stream broke off), 'broken' (no reader, or a chunk that is not bytes). Every fault cancels the stream. Never throws.
 * @param {ReadableStream} stream
 * @param {{ capacity: number, limit: number, idleMs: number, totalMs: number }} options
 * @returns {Promise<{ bytes: Uint8Array, fault?: undefined } | { fault: 'large' | 'long' | 'stall' | 'error' | 'broken', bytes?: undefined }>}
 */
async function drain(stream, { capacity, limit, idleMs, totalMs }) {
  /** @type {ReadableStreamDefaultReader<any>} */
  let reader
  try { reader = stream.getReader() } catch { return { fault: 'broken' } }
  const cancel = () => { try { void reader.cancel().catch(() => {}) } catch { /* already released */ } }
  const buffer = new Uint8Array(Math.min(capacity, limit))
  const started = Date.now()
  let lastByte = started
  let size = 0
  let empty = 0
  for (;;) {
    const now = Date.now()
    const left = Math.min(totalMs - (now - started), idleMs - (now - lastByte))
    if (left <= 0) { cancel(); return { fault: 'stall' } }
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    const stalled = new Promise(resolve => { timer = setTimeout(() => resolve(null), left) })
    /** @type {ReadableStreamReadResult<any> | null} */
    let step
    try {
      step = await Promise.race([reader.read(), stalled])
    } catch {
      clearTimeout(timer)
      cancel()
      return { fault: 'error' }
    }
    clearTimeout(timer)
    if (step === null) { cancel(); return { fault: 'stall' } }
    if (step.done) break
    const value = step.value
    const chunk = value instanceof Uint8Array ? value
      : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : value instanceof ArrayBuffer ? new Uint8Array(value) : null
    if (!chunk) { cancel(); return { fault: 'broken' } }
    if (chunk.byteLength === 0) {
      empty += 1
      if (empty > EMPTY_READS_MAX) { cancel(); return { fault: 'stall' } }
      continue
    }
    if (chunk.byteLength > limit - size) { cancel(); return { fault: 'large' } }
    if (chunk.byteLength > buffer.byteLength - size) { cancel(); return { fault: 'long' } }
    buffer.set(chunk, size)
    size += chunk.byteLength
    lastByte = Date.now()
  }
  return { bytes: size === buffer.byteLength ? buffer : buffer.slice(0, size) }
}

/**
 * Read a request body with a hard limit WHILE streaming (also with no content-length), bounded in memory by `drain`,
 * an idle deadline (no byte for idleMs) and a total deadline. Returns `{ bytes }` or `{ refusal }`; never throws for a
 * client fault. A content-length (when present) sizes the buffer and must match the bytes exactly. A read that rejects
 * (the upload broke off) is 408 REQUEST_BODY_TIMEOUT, as before this buffer, so the kit retries it; a chunk that is
 * not bytes, or a body with no reader, is 400 VAULT_REQUEST_INVALID.
 * @param {Request} request
 * @param {{ limit: number, tooLargeCode: string, idleMs: number, totalMs: number }} options
 * @returns {Promise<{ bytes: Uint8Array, refusal?: undefined } | { refusal: Response, bytes?: undefined }>}
 */
async function readBody(request, { limit, tooLargeCode, idleMs, totalMs }) {
  const length = request.headers.get('content-length')
  if (length !== null) {
    if (!/^[0-9]{1,16}$/.test(length) || !Number.isSafeInteger(Number(length))) return { refusal: refuse('VAULT_REQUEST_INVALID', 400) }
    if (Number(length) > limit) return { refusal: refuse(tooLargeCode, 413, { limit }) }
  }
  const encoding = request.headers.get('content-encoding')
  if (encoding && encoding.trim().toLowerCase() !== 'identity') return { refusal: refuse('VAULT_REQUEST_INVALID', 400) }
  if (!request.body) return { bytes: new Uint8Array(0) }
  const read = await drain(request.body, { capacity: length !== null ? Number(length) : limit, limit, idleMs, totalMs })
  if (read.fault === 'large') return { refusal: refuse(tooLargeCode, 413, { limit }) }
  if (read.fault === 'stall' || read.fault === 'error') return { refusal: refuse('REQUEST_BODY_TIMEOUT', 408) }
  if (read.fault) return { refusal: refuse('VAULT_REQUEST_INVALID', 400) }
  if (length !== null && read.bytes.byteLength !== Number(length)) return { refusal: refuse('VAULT_REQUEST_INVALID', 400) }
  return { bytes: read.bytes }
}

/**
 * A stored object's whole body, read here under the GET deadlines, at exactly its recorded size (at most `limit`).
 * @param {Ctx} ctx @param {any} found @param {number} limit
 * @returns {Promise<{ bytes: Uint8Array, refusal?: undefined } | { refusal: Response, bytes?: undefined }>}
 */
async function readStored(ctx, found, limit) {
  const unavailable = () => ({ refusal: refuse('ARCHIVE_UNAVAILABLE', 503, {}, { 'retry-after': STORED_RETRY_AFTER }) })
  const size = found?.size
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
    ctx.say('vault: a stored object has an unusable size', { size })
    try { void found?.body?.cancel?.().catch(() => {}) } catch { /* nothing to cancel */ }
    return unavailable()
  }
  const body = found.body
  if (!body || typeof body.getReader !== 'function') return size === 0 ? { bytes: new Uint8Array(0) } : unavailable()
  const read = await drain(body, { capacity: size, limit: size, idleMs: ctx.d.getIdleMs, totalMs: ctx.d.getTotalMs })
  if (read.fault || read.bytes.byteLength !== size) return unavailable()
  return { bytes: read.bytes }
}

/**
 * The row rule, word for word the one the rescue kit writes by: a dir or gone row has `bytes: 0`, `sha256: null`,
 * `pieces: []`; file, meta and local rows have all three; nothing else is required of a row.
 * @param {unknown} row
 * @param {number} piece
 */
function rowIsValid(row, piece) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  const r = /** @type {Record<string, unknown>} */ (row)
  if (typeof r.key !== 'string' || typeof r.type !== 'string' || !ROW_TYPES.has(r.type)) return false
  if (EMPTY_ROW_TYPES.has(r.type)) return r.bytes === 0 && r.sha256 === null && Array.isArray(r.pieces) && r.pieces.length === 0
  if (!Number.isSafeInteger(r.bytes) || /** @type {number} */ (r.bytes) < 0) return false
  if (typeof r.sha256 !== 'string' || !HEX64.test(r.sha256)) return false
  if (!Array.isArray(r.pieces) || r.pieces.length !== Math.ceil(/** @type {number} */ (r.bytes) / piece)) return false
  return r.pieces.every(p => typeof p === 'string' && HEX64.test(p))
}

/**
 * @param {unknown} index
 * @param {number} piece
 */
function indexIsValid(index, piece) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return false
  const x = /** @type {Record<string, any>} */ (index)
  if (x.v !== 1 || x.piece !== piece || (x.source !== 'indexeddb' && x.source !== 'memory')) return false
  const client = x.client
  if (!client || typeof client !== 'object' || Array.isArray(client)) return false
  if (!('clientId' in client) || !('base' in client) || !('reconciliation' in client)) return false
  if (client.clientId !== null && (typeof client.clientId !== 'string' || client.clientId.length > 256)) return false
  if (!Array.isArray(x.rows) || x.rows.length > INDEX_MAX_ROWS) return false
  if (!Array.isArray(x.skipped)) return false
  if (!x.totals || typeof x.totals !== 'object' || Array.isArray(x.totals)) return false
  if ('unlisted' in x && !unlistedIsValid(x.unlisted)) return false
  return x.rows.every(/** @param {unknown} row */ row => rowIsValid(row, piece))
}

/**
 * The kit's record of the listings its run could not read: `{ count, shapes: [{ shape, count }] }`, shapes in order,
 * each counted at least once, summing to `count`. An index without it was made by an older kit (`unlisted: null` below).
 * @param {unknown} value
 */
function unlistedIsValid(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const u = /** @type {Record<string, any>} */ (value)
  if (Object.keys(u).sort().join() !== 'count,shapes' || !Number.isSafeInteger(u.count) || u.count < 0 || !Array.isArray(u.shapes) || u.shapes.length > 64) return false
  let sum = 0
  for (let at = 0; at < u.shapes.length; at += 1) {
    const entry = u.shapes[at]
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join() !== 'count,shape' || typeof entry.shape !== 'string' || entry.shape.length > 200
      || !Number.isSafeInteger(entry.count) || entry.count < 1) return false
    if (at > 0 && !(u.shapes[at - 1].shape < entry.shape)) return false
    sum += entry.count
  }
  return sum === u.count
}

/**
 * Every piece the index names, in order, with the size it must have.
 * @param {{ rows: Array<{ type: string, bytes: number, pieces: string[] }> }} index
 * @param {number} piece
 */
function piecePlan(index, piece) {
  /** @type {Array<{ sha256: string, size: number }>} */
  const plan = []
  for (const row of index.rows) {
    if (EMPTY_ROW_TYPES.has(row.type)) continue
    const n = row.pieces.length
    for (let i = 0; i < n; i += 1) plan.push({ sha256: row.pieces[i], size: i < n - 1 ? piece : row.bytes - piece * (n - 1) })
  }
  return plan
}

/**
 * `unlisted`: how many listings the kit's run could not read (its own record, carried through), or null for an index
 * made before the kit recorded them. Any number above 0 means the copy is NOT complete, whatever its pieces.
 * @param {{ rows: Array<{ type: string, bytes: number }>, client: { clientId: string | null }, unlisted?: { count: number } }} index
 */
const summarize = index => ({
  rows: index.rows.length,
  files: index.rows.filter(row => row.type === 'file').length,
  bytes: index.rows.reduce((sum, row) => sum + row.bytes, 0),
  clientId: index.client.clientId,
  unlisted: index.unlisted ? index.unlisted.count : null,
})

/**
 * @param {unknown} bucket
 * @returns {bucket is { put: Function, get: Function, head: Function, list: Function }}
 */
const bucketUsable = bucket => !!bucket && typeof bucket === 'object'
  && ['put', 'get', 'head', 'list'].every(name => typeof /** @type {Record<string, unknown>} */ (bucket)[name] === 'function')

/**
 * Route one `/_vault/` request. Returns a Response for every path; never throws.
 * @param {{
 *   request: Request, url: URL, env: Record<string, any>, world: string, ready: boolean,
 *   budget: {
 *     charge: (input: { kind: 'blob', bytes: number, ref: string }) => Promise<any>,
 *     count: (input: { kind: 'blob', bytes: number, ref: string }) => Promise<any>,
 *     release: (input: { kind: 'blob', bytes: number, ref: string }) => Promise<any>,
 *   },
 *   now?: () => number, deadlines?: Partial<typeof VAULT_DEFAULT_DEADLINES>,
 *   limits?: { piece?: number, maxRescues?: number, maxPending?: number },
 *   log?: (message: string, detail?: unknown) => void,
 * }} input
 * @returns {Promise<Response>}
 */
export async function handleVaultRequest(input) {
  try {
    return await route(input)
  } catch (error) {
    try { (input?.log ?? console.warn)('vault: unexpected failure', error instanceof Error ? error.message : String(error)) } catch { /* logging only */ }
    return refuse('ARCHIVE_UNAVAILABLE', 503)
  }
}

/** @param {Parameters<typeof handleVaultRequest>[0]} input */
async function route({ request, url, env, world, ready, budget, now, deadlines, limits, log }) {
  if (ready !== true) return refuse('BOOTSTRAP_REQUIRED', 503)
  const say = typeof log === 'function' ? log : /** @type {(m: string, d?: unknown) => void} */ (console.warn)
  const clock = typeof now === 'function' ? now : () => Date.now()
  /** @type {Record<keyof typeof VAULT_DEFAULT_DEADLINES, number>} */
  const d = { ...VAULT_DEFAULT_DEADLINES }
  for (const name of /** @type {Array<keyof typeof VAULT_DEFAULT_DEADLINES>} */ (Object.keys(VAULT_DEFAULT_DEADLINES))) {
    const value = deadlines?.[name]
    if (Number.isFinite(value) && /** @type {number} */ (value) > 0) d[name] = /** @type {number} */ (value)
  }
  const piece = positiveSafeInteger(limits?.piece) ?? PIECE
  const maxRescues = Math.min(RESCUE_LIMIT_CEILING, positiveSafeInteger(limits?.maxRescues) ?? positiveSafeInteger(env?.VAULT_MAX_RESCUES) ?? VAULT_DEFAULT_LIMITS.maxRescues)
  const maxPending = Math.min(RESCUE_LIMIT_CEILING, positiveSafeInteger(limits?.maxPending) ?? positiveSafeInteger(env?.VAULT_MAX_PENDING) ?? VAULT_DEFAULT_LIMITS.maxPending)

  if (typeof world !== 'string' || !WORLD_NAME.test(world)) return refuse('ARCHIVE_UNAVAILABLE', 503)
  const bucket = env?.ARCHIVE_BUCKET
  if (!bucketUsable(bucket)) return refuse('ARCHIVE_UNAVAILABLE', 503)

  // Match the route: path, then method, then query.
  const path = url.pathname
  const method = request.method.toUpperCase()
  /** @type {null | { name: string, methods: string[], hash?: string, id?: string }} */
  let matched = null
  let m
  if ((m = /^\/_vault\/blob\/([^/]+)$/.exec(path)) && HEX64.test(m[1])) matched = { name: 'blob', methods: ['HEAD', 'GET', 'PUT'], hash: m[1] }
  else if (path === '/_vault/rescue') matched = { name: 'rescues', methods: ['GET'] }
  else if ((m = /^\/_vault\/rescue\/([^/]+)$/.exec(path)) && HEX32.test(m[1])) matched = { name: 'rescue', methods: ['GET', 'PUT'], id: m[1] }
  else if ((m = /^\/_vault\/rescue\/([^/]+)\/verify$/.exec(path)) && HEX32.test(m[1])) matched = { name: 'verify', methods: ['POST'], id: m[1] }
  if (!matched) return refuse('NOT_FOUND', 404)
  if (!matched.methods.includes(method)) return refuse('METHOD_UNAVAILABLE', 405, {}, { allow: matched.methods.join(', ') })
  const params = [...url.searchParams.keys()]
  if (matched.name === 'verify' ? params.some(key => key !== 'cursor') : url.search !== '') return refuse('NOT_FOUND', 404)
  const write = method === 'PUT' || method === 'POST'
  if (write && request.headers.get('sec-fetch-site') !== 'same-origin') return refuse('SAME_ORIGIN_BROWSER_REQUIRED', 403)

  const r2 = {
    /** @param {string} key */
    head: key => withDeadline(bucket.head(key), d.r2Ms),
    /** @param {string} key */
    get: key => withDeadline(bucket.get(key), d.r2Ms),
    /** @param {string} key @param {Uint8Array} bytes @param {Record<string, unknown>} options */
    putIfAbsent: (key, bytes, options) => withDeadline(bucket.put(key, bytes, { ...options, onlyIf: new Headers({ 'if-none-match': '*' }) }), d.r2Ms),
    // A listing that is not a list is a FAILED listing (thrown: 503 below), never an empty one: the rescue and slot
    // counts behind the caps are read from it.
    /** @param {Record<string, unknown>} options */
    list: async options => {
      const listed = await withDeadline(bucket.list(options), d.r2Ms)
      if (!listed || typeof listed !== 'object' || !Array.isArray(listed.objects)) throw new Error('VAULT_LIST_UNREADABLE')
      return listed
    },
  }
  const ctx = { request, world, budget, clock, d, piece, maxRescues, maxPending, r2, say }
  try {
    if (matched.name === 'blob') {
      const hash = /** @type {string} */ (matched.hash)
      if (method === 'PUT') return await putBlob(ctx, hash)
      return await readBlob(ctx, hash, method === 'HEAD')
    }
    if (matched.name === 'rescues') return await listRescues(ctx)
    if (matched.name === 'rescue') return method === 'PUT' ? await putRescue(ctx, /** @type {string} */ (matched.id)) : await getRescue(ctx, /** @type {string} */ (matched.id))
    return await verifyRescue(ctx, /** @type {string} */ (matched.id), url.searchParams.getAll('cursor'))
  } catch (error) {
    if (!(error instanceof Late)) say('vault: archive call failed', error instanceof Error ? error.message : String(error))
    return refuse('ARCHIVE_UNAVAILABLE', 503)
  }
}

/**
 * @typedef {{
 *   request: Request, world: string, budget: any, clock: () => number, d: Record<keyof typeof VAULT_DEFAULT_DEADLINES, number>, piece: number,
 *   maxRescues: number, maxPending: number, say: (m: string, d?: unknown) => void,
 *   r2: { head: (key: string) => Promise<any>, get: (key: string) => Promise<any>,
 *         putIfAbsent: (key: string, bytes: Uint8Array, options: Record<string, unknown>) => Promise<any>,
 *         list: (options: Record<string, unknown>) => Promise<any> },
 * }} Ctx
 */

/** @param {Ctx} ctx @param {string} hash @param {boolean} headOnly */
async function readBlob(ctx, hash, headOnly) {
  const key = `w/${ctx.world}/blob/${hash}`
  if (headOnly) {
    const found = await ctx.r2.head(key)
    if (!found) return refuse('BLOB_UNKNOWN', 404)
    return new Response(null, { status: 200, headers: { ...HEADERS, 'content-type': 'application/octet-stream', 'content-length': String(found.size) } })
  }
  const found = await ctx.r2.get(key)
  if (!found) return refuse('BLOB_UNKNOWN', 404)
  const read = await readStored(ctx, found, ctx.piece)
  if (read.refusal) return read.refusal
  return new Response(/** @type {Uint8Array<ArrayBuffer>} */ (read.bytes), { status: 200, headers: { ...HEADERS, 'content-type': 'application/octet-stream', 'content-length': String(read.bytes.byteLength) } })
}

/** @param {Ctx} ctx @param {string} hash */
async function putBlob(ctx, hash) {
  const read = await readBody(ctx.request, { limit: ctx.piece, tooLargeCode: 'PART_TOO_LARGE', idleMs: ctx.d.idleMs, totalMs: ctx.d.totalMs })
  if (read.refusal) return read.refusal
  const bytes = read.bytes
  if (await sha256Hex(bytes) !== hash) return refuse('BLOB_HASH_MISMATCH', 422)
  const key = `w/${ctx.world}/blob/${hash}`
  const charge = { kind: 'blob', bytes: bytes.byteLength, ref: hash }
  /** Settle (or count once) a piece that is stored. Never refuses; a failure is logged and found again next PUT. */
  const settle = async () => {
    try {
      if (!ctx.budget || typeof ctx.budget.count !== 'function') throw new Error('no count')
      await withDeadline(ctx.budget.count(charge), ctx.d.budgetMs)
    } catch (error) {
      ctx.say('vault: a stored piece was not counted', { key, bytes: bytes.byteLength, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // (1) Already there with the same size: nothing to write; counted once if nothing counted it yet.
  const existing = await ctx.r2.head(key)
  if (existing) {
    if (existing.size === bytes.byteLength) { await settle(); return json({ ok: true, stored: false }, 200) }
    ctx.say('vault: a stored piece has the wrong size', { key, size: existing.size })
    return refuse('BLOB_STORED_DIFFERS', 409)
  }
  // (2) Reserve the world's allowance (check and count in one MIRROR step). A refusal is returned as given and
  // reserves nothing; a failure stores nothing. A charge whose ANSWER did not arrive (late, or the call broke) may still
  // have reserved: this upload stores nothing, so it releases its own reservation by ref (a release is once per ref, and
  // a no-op for a ref never recorded or already stored). If the release fails too, or the charge lands after it, the
  // reservation stays until a later PUT of the same piece settles it (world-budget.mjs says the bound).
  /** @type {any} */
  let verdict
  try {
    if (!ctx.budget || typeof ctx.budget.charge !== 'function') throw new Error('no budget')
    verdict = await withDeadline(ctx.budget.charge(charge), ctx.d.budgetMs)
  } catch {
    try {
      if (ctx.budget && typeof ctx.budget.release === 'function') await withDeadline(ctx.budget.release(charge), ctx.d.budgetMs)
    } catch (error) {
      ctx.say('vault: a lost charge could not be released', { key, error: error instanceof Error ? error.message : String(error) })
    }
    return refuse('BUDGET_UNAVAILABLE', 503)
  }
  if (!verdict || verdict.ok !== true) {
    if (verdict?.code === 'WORLD_FULL' && verdict.status === 507) return refuse('WORLD_FULL', 507)
    if (verdict?.code === 'DAY_ALLOWANCE' && verdict.status === 429 && Number.isSafeInteger(verdict.retryAfterMs) && verdict.retryAfterMs >= 0) {
      return refuse('DAY_ALLOWANCE', 429, { retryAfterMs: verdict.retryAfterMs }, { 'retry-after': String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))) })
    }
    return refuse('BUDGET_UNAVAILABLE', 503)
  }
  // (3) Store only if absent. Null: the key appeared meanwhile (stored either way), settle. A late answer: keep the
  // reservation, the put may still land. A failure: release the reservation only when a head then does not find it.
  /** @type {any} */
  let stored
  try {
    stored = await ctx.r2.putIfAbsent(key, bytes, { sha256: hash, httpMetadata: { contentType: 'application/octet-stream' } })
  } catch (error) {
    if (!(error instanceof Late)) {
      ctx.say('vault: a piece put failed', error instanceof Error ? error.message : String(error))
      try {
        if (!(await ctx.r2.head(key)) && typeof ctx.budget.release === 'function') await withDeadline(ctx.budget.release(charge), ctx.d.budgetMs)
      } catch { /* the reservation stays: the row may show more than is stored, never less */ }
    }
    return refuse('ARCHIVE_UNAVAILABLE', 503)
  }
  // (4) Settle the reservation (marks it stored, so no later release can take it off).
  await settle()
  if (stored === null || stored === undefined) return json({ ok: true, stored: false }, 200)
  return json({ ok: true, stored: true }, 201)
}

/** @param {Ctx} ctx */
async function rescueKeys(ctx) {
  const prefix = `w/${ctx.world}/rescue/`
  const listed = await ctx.r2.list({ prefix, limit: LIST_LIMIT })
  /** @type {Map<string, { pending: boolean, manifest: boolean }>} */
  const rescues = new Map()
  for (const object of listed.objects) {
    const m = /^([0-9a-f]{32})\/(pending|manifest)\.json$/.exec(String(object.key).slice(prefix.length))
    if (!m) continue
    const entry = rescues.get(m[1]) ?? { pending: false, manifest: false }
    entry[/** @type {'pending' | 'manifest'} */ (m[2])] = true
    rescues.set(m[1], entry)
  }
  return { rescues, truncated: listed.truncated === true }
}

/** @param {Ctx} ctx @param {string} id */
async function putRescue(ctx, id) {
  const read = await readBody(ctx.request, { limit: INDEX_MAX_BYTES, tooLargeCode: 'REQUEST_BODY_TOO_LARGE', idleMs: ctx.d.idleMs, totalMs: ctx.d.totalMs })
  if (read.refusal) return read.refusal
  const bytes = read.bytes
  const indexSha = await sha256Hex(bytes)
  if (indexSha.slice(0, 32) !== id) return refuse('VAULT_REQUEST_INVALID', 400)
  /** @type {any} */
  let index
  try { index = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return refuse('VAULT_REQUEST_INVALID', 400) }
  if (!indexIsValid(index, ctx.piece)) return refuse('VAULT_REQUEST_INVALID', 400)
  const key = `w/${ctx.world}/rescue/${id}/pending.json`
  if (await ctx.r2.head(key)) return json({ ok: true, pending: true }, 200)
  const { rescues, truncated } = await rescueKeys(ctx)
  if (truncated) return refuse('ARCHIVE_UNAVAILABLE', 503)
  let verified = 0
  let pending = 0
  for (const entry of rescues.values()) {
    if (entry.manifest) verified += 1
    else pending += 1
  }
  if (verified >= ctx.maxRescues) return refuse('RESCUE_LIMIT', 507, { var: 'VAULT_MAX_RESCUES', limit: ctx.maxRescues })
  if (pending >= ctx.maxPending) return refuse('RESCUE_LIMIT', 507, { var: 'VAULT_MAX_PENDING', limit: ctx.maxPending })
  const summary = summarize(index)
  const stored = await ctx.r2.putIfAbsent(key, bytes, {
    sha256: indexSha,
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { vault: JSON.stringify({ files: summary.files, bytes: summary.bytes, clientId: summary.clientId }) },
  })
  // Null: the same index arrived meanwhile (same id, same bytes); it is stored either way.
  return json({ ok: true, pending: true }, stored === null || stored === undefined ? 200 : 201)
}

/** @param {Ctx} ctx @param {string} id */
async function getRescue(ctx, id) {
  const found = await ctx.r2.get(`w/${ctx.world}/rescue/${id}/pending.json`)
  if (!found) return refuse('RESCUE_UNKNOWN', 404)
  const read = await readStored(ctx, found, INDEX_MAX_BYTES)
  if (read.refusal) return read.refusal
  return new Response(/** @type {Uint8Array<ArrayBuffer>} */ (read.bytes), { status: 200, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': String(read.bytes.byteLength) } })
}

/** @param {unknown} raw */
const parseMeta = raw => {
  try {
    const value = JSON.parse(String(raw))
    return value && typeof value === 'object' ? value : null
  } catch { return null }
}

/** @param {Ctx} ctx */
async function listRescues(ctx) {
  const prefix = `w/${ctx.world}/rescue/`
  const listed = await ctx.r2.list({ prefix, limit: LIST_LIMIT, include: ['customMetadata'] })
  /** @type {Map<string, { verifiedAt: string | null, files: number | null, bytes: number | null, clientId: string | null, manifest: boolean }>} */
  const rescues = new Map()
  for (const object of listed.objects) {
    const m = /^([0-9a-f]{32})\/(pending|manifest)\.json$/.exec(String(object.key).slice(prefix.length))
    if (!m) continue
    const entry = rescues.get(m[1]) ?? { verifiedAt: null, files: null, bytes: null, clientId: null, manifest: false }
    const meta = parseMeta(object.customMetadata?.vault)
    if (m[2] === 'manifest') entry.manifest = true
    if (meta) {
      if (m[2] === 'manifest' && typeof meta.verifiedAt === 'string') entry.verifiedAt = meta.verifiedAt
      if (Number.isSafeInteger(meta.files)) entry.files = meta.files
      if (Number.isSafeInteger(meta.bytes)) entry.bytes = meta.bytes
      if (typeof meta.clientId === 'string') entry.clientId = meta.clientId
    }
    rescues.set(m[1], entry)
  }
  // A manifest whose metadata did not come back with the list is read itself (small, and bounded by the rescue limit).
  for (const [id, entry] of rescues) {
    if (!entry.manifest || entry.verifiedAt) continue
    const found = await ctx.r2.get(`${prefix}${id}/manifest.json`)
    const manifest = found ? parseMeta(await withDeadline(found.text(), ctx.d.r2Ms)) : null
    if (manifest && typeof manifest.verifiedAt === 'string') {
      entry.verifiedAt = manifest.verifiedAt
      entry.files = Number.isSafeInteger(manifest.files) ? manifest.files : entry.files
      entry.bytes = Number.isSafeInteger(manifest.bytes) ? manifest.bytes : entry.bytes
      entry.clientId = typeof manifest.clientId === 'string' ? manifest.clientId : entry.clientId
    }
  }
  const out = [...rescues].map(([id, e]) => ({ id, verifiedAt: e.verifiedAt, files: e.files, bytes: e.bytes, clientId: e.clientId }))
  return json({ ok: true, rescues: out, ...(listed.truncated === true ? { more: true } : {}) }, 200)
}

/** @param {Ctx} ctx @param {string} id @param {string[]} cursors */
async function verifyRescue(ctx, id, cursors) {
  if (cursors.length !== 1 || !/^(0|[1-9][0-9]{0,8})$/.test(cursors[0])) return refuse('VAULT_REQUEST_INVALID', 400)
  const cursor = Number(cursors[0])
  const base = `w/${ctx.world}/rescue/${id}`
  const found = await ctx.r2.get(`${base}/pending.json`)
  if (!found) return refuse('RESCUE_UNKNOWN', 404)
  const bytes = new Uint8Array(await withDeadline(found.arrayBuffer(), ctx.d.r2Ms))
  /** @type {any} */
  let index
  try { index = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return refuse('ARCHIVE_UNAVAILABLE', 503) }
  if (!indexIsValid(index, ctx.piece)) return refuse('ARCHIVE_UNAVAILABLE', 503)
  const plan = piecePlan(index, ctx.piece)
  const total = plan.length
  const summary = summarize(index)

  // Done already: the same answer, nothing written.
  const manifestKey = `${base}/manifest.json`
  const manifestFound = await ctx.r2.get(manifestKey)
  if (manifestFound) {
    const manifest = parseMeta(await withDeadline(manifestFound.text(), ctx.d.r2Ms))
    return json({ ok: true, cursor: total, done: true, verifiedAt: manifest?.verifiedAt ?? null, rows: summary.rows, files: summary.files, bytes: summary.bytes, unlisted: summary.unlisted }, 200)
  }
  // A cursor is a whole number only this vault gives out: past 0 it must have been written here as progress.
  if (cursor > total) return refuse('VAULT_REQUEST_INVALID', 400)
  const progress = `w/${ctx.world}/progress/${id}`
  if (cursor > 0 && !(await ctx.r2.head(`${progress}/${cursor}`))) return refuse('VAULT_REQUEST_INVALID', 400)

  const end = Math.min(total, cursor + VERIFY_STEP)
  /** @type {Map<string, number | null>} */
  const sizes = new Map()
  for (let i = cursor; i < end; i += 1) {
    const { sha256, size } = plan[i]
    if (!sizes.has(sha256)) {
      const head = await ctx.r2.head(`w/${ctx.world}/blob/${sha256}`)
      sizes.set(sha256, head ? head.size : null)
    }
    if (sizes.get(sha256) !== size) return refuse('RESCUE_BLOB_MISSING', 424, { sha256, cursor })
  }
  if (end < total) {
    const next = `${progress}/${end}`
    if (!(await ctx.r2.head(next))) await ctx.r2.putIfAbsent(next, new TextEncoder().encode(String(end)), {})
    return json({ ok: true, cursor: end, done: false }, 200)
  }
  // The verified cap holds HERE, at publication: a numbered slot is claimed first (idempotent per rescue).
  const slot = await claimSlot(ctx, id)
  if (slot.refusal) return slot.refusal
  const verifiedAt = new Date(ctx.clock()).toISOString()
  const manifest = { verified: true, verifiedAt, rows: summary.rows, files: summary.files, bytes: summary.bytes, clientId: summary.clientId, unlisted: summary.unlisted, indexSha: await sha256Hex(bytes) }
  const stored = await ctx.r2.putIfAbsent(manifestKey, new TextEncoder().encode(JSON.stringify(manifest)), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { vault: JSON.stringify({ verifiedAt, files: summary.files, bytes: summary.bytes, clientId: summary.clientId }) },
  })
  let answeredAt = verifiedAt
  if (stored === null || stored === undefined) {
    // Written meanwhile by another call: answer with what is stored.
    const again = await ctx.r2.get(manifestKey)
    const kept = again ? parseMeta(await withDeadline(again.text(), ctx.d.r2Ms)) : null
    answeredAt = kept?.verifiedAt ?? verifiedAt
  }
  return json({ ok: true, cursor: total, done: true, verifiedAt: answeredAt, rows: summary.rows, files: summary.files, bytes: summary.bytes, unlisted: summary.unlisted }, 200)
}

/**
 * Claim one of the world's VAULT_MAX_RESCUES slots for this rescue, `w/<world>/rescue-slot/<n>`, n below the cap.
 * A rescue that already holds a slot gets it again (a retry, or two calls for it at once); a claim lost to another
 * rescue at the same moment (`if-none-match: *` refused it) moves on to the next free n; with none left: 507
 * RESCUE_LIMIT naming VAULT_MAX_RESCUES, and the pending index and its pieces stay. One list (the cap is at most 240,
 * so it is never truncated: a truncated list fails closed 503); a slot whose owner the list did not carry is read by
 * `head`.
 * @param {Ctx} ctx @param {string} id
 * @returns {Promise<{ slot: number, refusal?: undefined } | { refusal: Response, slot?: undefined }>}
 */
async function claimSlot(ctx, id) {
  const prefix = `w/${ctx.world}/rescue-slot/`
  const listed = await ctx.r2.list({ prefix, limit: LIST_LIMIT, include: ['customMetadata'] })
  if (listed.truncated === true) return { refusal: refuse('ARCHIVE_UNAVAILABLE', 503) }
  /** @param {any} object */
  const ownerOf = async object => {
    const named = object?.customMetadata?.rescue
    if (typeof named === 'string') return named
    const head = await ctx.r2.head(String(object.key))
    return typeof head?.customMetadata?.rescue === 'string' ? head.customMetadata.rescue : null
  }
  /** @type {Set<number>} */
  const taken = new Set()
  for (const object of listed.objects) {
    const m = SLOT_NAME.exec(String(object.key).slice(prefix.length))
    if (!m) continue
    if (await ownerOf(object) === id) return { slot: Number(m[1]) }
    taken.add(Number(m[1]))
  }
  const full = () => ({ refusal: refuse('RESCUE_LIMIT', 507, { var: 'VAULT_MAX_RESCUES', limit: ctx.maxRescues }) })
  if (taken.size >= ctx.maxRescues) return full()
  for (let n = 0; n < ctx.maxRescues; n += 1) {
    if (taken.has(n)) continue
    const key = `${prefix}${n}`
    const stored = await ctx.r2.putIfAbsent(key, new TextEncoder().encode(id), {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      customMetadata: { rescue: id },
    })
    if (stored !== null && stored !== undefined) return { slot: n }
    if (await ownerOf({ key }) === id) return { slot: n }
    taken.add(n)
  }
  return full()
}
