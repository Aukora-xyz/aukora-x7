/**
 * Thread log: one cloud thread is an append-only log made of sealed pieces (content-addressed blobs in R2) and a
 * short open end (64 KiB rows in MIRROR). The cloud mirror holds files whole and can never hold a growing journal;
 * this log takes only new bytes at the exact end.
 *
 * Two halves, so MIRROR (one request at a time, reads included) is never held by a slow body or a slow R2 call:
 * - the MIRROR half, `threadCommit(tx, op, input, ctx)`, runs as one short step inside the caller's open storage
 *   transaction and touches only `tx`;
 * - the Worker half, `handleThreadRequest(...)`, reads bodies, hashes, talks to R2 and then calls the MIRROR half.
 * Bytes cross the boundary between the halves as base64 strings, so every op input and every op answer is plain JSON.
 */

// <mirror-half> Shared helpers and the MIRROR half. Only `tx` is touched here: no R2, no network, no second step.

/** Protocol constants, never read from env: a sealed piece and one open-end row (32 rows a piece). */
export const THREAD_PROTOCOL = Object.freeze({ piece: 2097152, row: 65536 })
/** Default caps. `threadLimits(env)` reads THREAD_MAX, THREAD_TAIL_MAX_BYTES and THREAD_KEPT_MAX over these. */
export const THREAD_LIMITS = Object.freeze({ threads: 2048, tailBytes: 256 * 1024 * 1024, kept: 1024, preview: 512, title: 200 })
/** SHA-256 of zero bytes: the `tailSha` of an empty open end. */
export const THREAD_EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
/** The rolling chain before any sealed piece: 32 zero bytes. */
export const THREAD_ZERO_CHAIN = '0'.repeat(64)

const PAGE = 1024
const KEPT_PAGE = 64
const KEPT_PIECES_MAX = 256
const IMPORT_PARTS_MAX = 64 * PAGE
/**
 * The most ONE import call into MIRROR may do, so her app's save (MIRROR answers one request at a
 * time) always runs between two steps of an import. One step adds at most `pieces` sealed-piece hashes (1,024: that
 * many 64-byte chain hashes, at most two page rows read and written), reads the old open end (under 2 PIECE, at most
 * 64 rows), deletes at most those rows and writes the new open end (under 1 PIECE: at most 32 rows of 64 KiB). Its
 * body is under 3 MiB (MIRROR's limit for the route). A longer journal is imported in steps, each a committed byte
 * prefix of it; only the last carries the open end and the home.
 */
export const THREAD_IMPORT_STEP = Object.freeze({ pieces: PAGE })
const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/
const PATH_RULE = /^\/dsh\/home\/(?:sessions\/[^/]+\/[^/]+\/session\.v\d+\.jsonl|[^/]+\/session\/messages\.jsonl)$/
const INDEX = 'thread:v1:index:'
const PAGES = 'thread:v1:parts:'
const TAIL = 'thread:v1:tail:'
const KEPT = 'thread:v1:kept:'
const WORLD = 'thread:v1:world'
const encoder = new TextEncoder()

const pad = (n, width) => String(n).padStart(width, '0')
const indexKey = id => INDEX + id
const pageKey = (id, page) => `${PAGES}${id}:${pad(page, 6)}`
const tailPrefix = id => `${TAIL}${id}:`
const tailKey = (id, k) => tailPrefix(id) + pad(k, 10)
const keptPrefix = id => `${KEPT}${id}:`
const keptKey = (id, n) => keptPrefix(id) + pad(n, 6)
const uint = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const fromHex = text => {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}
const result = (status, body) => ({ status, body })
const refuse = (status, code, extra = {}) => result(status, { ok: false, code, ...extra })
const pairOf = t => ({ bytes: t.bytes, sealedBytes: t.sealedBytes, chain: t.chain, tailSha: t.tailSha })
const EMPTY_PAIR = Object.freeze({ bytes: 0, sealedBytes: 0, chain: THREAD_ZERO_CHAIN, tailSha: THREAD_EMPTY_SHA })
const samePair = (a, b) => (a === null || b === null || a === undefined || b === undefined)
  ? (a ?? null) === (b ?? null)
  : isObject(a) && isObject(b) && a.bytes === b.bytes && a.sealedBytes === b.sealedBytes && a.chain === b.chain && a.tailSha === b.tailSha
const equalBytes = (a, b) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
const concatBytes = list => {
  const out = new Uint8Array(list.reduce((sum, item) => sum + item.length, 0))
  let at = 0
  for (const item of list) { out.set(item, at); at += item.length }
  return out
}

/** SHA-256 hex digest of bytes. */
export async function sha256Hex(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

/** One rolling chain step: SHA-256 of the chain's 32 bytes followed by the piece hash's 32 bytes. */
export async function threadChain(chain, pieceSha) {
  const buffer = new Uint8Array(64)
  buffer.set(fromHex(chain))
  buffer.set(fromHex(pieceSha), 32)
  return sha256Hex(buffer)
}

/** The `have` a client sends with an append at the end: `<chain>.<tailSha>`. */
export const threadHave = pair => `${pair.chain}.${pair.tailSha}`

/** Standard base64 for bytes crossing the MIRROR boundary. */
export function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Strict standard base64 to bytes, or null. */
export function base64ToBytes(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
  let binary
  try { binary = atob(text) } catch { return null }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Validate a protocol (tests pass a small one); answers `{piece, row, rows}` or null. */
export function normalizeThreadProtocol(protocol = THREAD_PROTOCOL) {
  const piece = protocol?.piece
  const row = protocol?.row
  if (!uint(piece) || !uint(row) || piece === 0 || row === 0 || piece % row !== 0 || row > 65536 || piece / row > 64) return null
  return Object.freeze({ piece, row, rows: piece / row })
}

const positive = value => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Caps only (never protocol numbers): env overrides for the three named caps, frozen defaults otherwise. */
export function threadLimits(env = {}) {
  return Object.freeze({
    threads: positive(env?.THREAD_MAX) ?? THREAD_LIMITS.threads,
    tailBytes: positive(env?.THREAD_TAIL_MAX_BYTES) ?? THREAD_LIMITS.tailBytes,
    kept: positive(env?.THREAD_KEPT_MAX) ?? THREAD_LIMITS.kept,
    preview: THREAD_LIMITS.preview,
    title: THREAD_LIMITS.title,
  })
}

/** A journal path the log accepts: the fixed rule, 1,024 bytes at most, no dot segments. */
export function threadPathAllowed(path) {
  return typeof path === 'string' && encoder.encode(path).length <= 1024 && PATH_RULE.test(path)
    && !path.split('/').some(segment => segment === '.' || segment === '..')
}

/** Thread id = SHA-256 hex of the journal path; null for a path the rule refuses. */
export async function threadIdForPath(path) {
  return threadPathAllowed(path) ? sha256Hex(encoder.encode(path)) : null
}

const truncateChars = (text, max) => Array.from(text).slice(0, max).join('')
const truncateBytes = (text, max) => {
  let out = ''
  let used = 0
  for (const char of text) {
    const size = encoder.encode(char).length
    if (used + size > max) break
    out += char
    used += size
  }
  return out
}
const cleanMeta = (meta, limits) => {
  if (meta === undefined || meta === null) return { value: null }
  if (!isObject(meta) || Object.keys(meta).some(key => !['title', 'preview', 'activeAt'].includes(key))
    || (meta.title !== undefined && typeof meta.title !== 'string')
    || (meta.preview !== undefined && typeof meta.preview !== 'string')
    || (meta.activeAt !== undefined && !uint(meta.activeAt))) return { refusal: refuse(400, 'THREAD_META_INVALID') }
  return { value: {
    ...(meta.title !== undefined ? { title: truncateChars(meta.title, limits.title) } : {}),
    ...(meta.preview !== undefined ? { preview: truncateBytes(meta.preview, limits.preview) } : {}),
    ...(meta.activeAt !== undefined ? { activeAt: meta.activeAt } : {}),
  } }
}
const applyMeta = (row, meta, now) => meta
  ? { ...row, ...('title' in meta ? { title: meta.title } : {}), ...('preview' in meta ? { preview: meta.preview } : {}), activeAt: meta.activeAt ?? now }
  : row

// The lease ref is checked for shape before `checkLease` is ever called, in every mode.
const writerGate = async (tx, lease, ctx) => {
  if (!isObject(lease) || !HEX32.test(lease.leaseId) || !uint(lease.generation)) return { refusal: refuse(423, 'WRITER_REQUIRED') }
  if (typeof ctx.checkLease !== 'function') return { refusal: refuse(503, 'WRITER_UNAVAILABLE') }
  const answer = await ctx.checkLease(tx, { leaseId: lease.leaseId, generation: lease.generation }, ctx.now)
  if (!isObject(answer) || answer.ok !== true) {
    const status = Number.isInteger(answer?.status) && answer.status >= 400 && answer.status <= 599 ? answer.status : 423
    const code = typeof answer?.code === 'string' && answer.code ? answer.code : 'WRITER_REQUIRED'
    return { refusal: refuse(status, code, answer?.holder !== undefined ? { holder: answer.holder } : {}) }
  }
  if (typeof answer.clientId !== 'string' || answer.clientId === '') return { refusal: refuse(423, 'WRITER_REQUIRED') }
  return { clientId: answer.clientId }
}

// Gates every op that names an existing thread.
const threadGate = (t, proto, writing) => {
  if (t.piece !== proto.piece) return refuse(409, 'PIECE_MISMATCH', { piece: t.piece })
  if (writing && t.idle !== null) return refuse(503, 'THREAD_PARKED')
  return null
}

const readWorld = async tx => {
  const world = await tx.get(WORLD)
  return isObject(world) && uint(world.threads) && uint(world.tailBytes) ? world : { threads: 0, tailBytes: 0 }
}

// The whole open end, row by row; null when the rows do not tile [sealedBytes, bytes) exactly.
const readOpen = async (tx, t, proto) => {
  const prefix = tailPrefix(t.id)
  const rows = await tx.list({ prefix, limit: proto.rows * 2 + 1 })
  const first = t.sealedBytes / proto.row
  const chunks = []
  const ks = []
  let k = first
  for (const [key, value] of rows) {
    if (key !== tailKey(t.id, k) || !(value instanceof Uint8Array)) return null
    chunks.push(value)
    ks.push(k)
    k += 1
  }
  const bytes = concatBytes(chunks)
  if (bytes.length !== t.bytes - t.sealedBytes) return null
  for (let i = 0; i < chunks.length - 1; i++) if (chunks[i].length !== proto.row) return null
  if (chunks.length && (chunks.at(-1).length === 0 || chunks.at(-1).length > proto.row)) return null
  return { bytes, ks }
}

// Rows [fromK, ...) of an open end that starts at `sealedBytes`.
const writeOpenRows = async (tx, id, open, sealedBytes, fromK, proto) => {
  const endK = Math.ceil((sealedBytes + open.length) / proto.row)
  for (let k = fromK; k < endK; k++) {
    const start = k * proto.row - sealedBytes
    await tx.put(tailKey(id, k), open.slice(start, Math.min(start + proto.row, open.length)))
  }
}

// Piece hashes for indexes [from, to); null when a page is short.
const readPieceHashes = async (tx, id, from, to) => {
  const out = []
  for (let page = Math.floor(from / PAGE); from < to && page <= Math.floor((to - 1) / PAGE); page++) {
    const list = await tx.get(pageKey(id, page))
    if (!Array.isArray(list)) return null
    for (let i = Math.max(from, page * PAGE); i < Math.min(to, (page + 1) * PAGE); i++) {
      const sha = list[i - page * PAGE]
      if (!HEX64.test(sha)) return null
      out.push(sha)
    }
  }
  return out
}

const appendPieceHashes = async (tx, id, startIndex, hashes) => {
  let index = startIndex
  let offset = 0
  while (offset < hashes.length) {
    const page = Math.floor(index / PAGE)
    const existing = (await tx.get(pageKey(id, page))) ?? []
    const room = PAGE - (index - page * PAGE)
    const take = hashes.slice(offset, offset + room)
    await tx.put(pageKey(id, page), [...existing.slice(0, index - page * PAGE), ...take])
    index += take.length
    offset += take.length
  }
}

// `chain` (the rolling chain of the sealed pieces) and `tailSha` (the SHA-256 of the open end) are the pair
// an import's `expect` names: with `bytes` and `partCount` they change whenever the thread's bytes change, so the /rescue
// page can tell a thread that holds exactly a journal's bytes without an import call. Main's client never reads this index.
const summary = t => ({ id: t.id, path: t.path, bytes: t.bytes, lineEnd: t.lineEnd, partCount: t.partCount, keptCount: t.keptCount,
  chain: t.chain, tailSha: t.tailSha, title: t.title, preview: t.preview, activeAt: t.activeAt, updatedAt: t.updatedAt, idle: t.idle })

async function opIndex(tx, input) {
  const after = input.after ?? ''
  const limit = input.limit ?? 50
  if ((after !== '' && !HEX64.test(after)) || !uint(limit) || limit < 1 || limit > 200) return refuse(400, 'THREAD_INDEX_INVALID')
  const rows = [...(await tx.list({ prefix: INDEX, ...(after ? { startAfter: indexKey(after) } : {}), limit: limit + 1 })).values()]
  const threads = rows.slice(0, limit).map(summary)
  return result(200, { ok: true, threads, next: rows.length > limit ? threads.at(-1).id : null })
}

async function opManifest(tx, input, proto) {
  const page = input.page ?? 0
  if (!HEX64.test(input.id) || !uint(page)) return refuse(400, 'THREAD_MANIFEST_INVALID')
  const t = await tx.get(indexKey(input.id))
  if (!t) return refuse(404, 'THREAD_UNKNOWN')
  const gate = threadGate(t, proto, false)
  if (gate) return gate
  const list = (await tx.get(pageKey(t.id, page))) ?? []
  const kept = page * KEPT_PAGE < t.keptCount
    ? [...(await tx.list({ prefix: keptPrefix(t.id), start: keptKey(t.id, page * KEPT_PAGE), limit: KEPT_PAGE })).values()]
    : []
  return result(200, { ok: true, thread: t, page, pages: Math.ceil(t.partCount / PAGE), parts: list, kept,
    keptPages: Math.ceil(t.keptCount / KEPT_PAGE) })
}

async function opRange(tx, input, proto) {
  if (!HEX64.test(input.id) || !uint(input.from) || (input.to !== undefined && !uint(input.to))) return refuse(400, 'RANGE_INVALID')
  const t = await tx.get(indexKey(input.id))
  if (!t) return refuse(404, 'THREAD_UNKNOWN')
  const gate = threadGate(t, proto, false)
  if (gate) return gate
  const from = input.from
  const to = input.to ?? t.bytes
  const facts = { ...pairOf(t), lineEnd: t.lineEnd }
  if (from > to || to > t.bytes) return refuse(400, 'RANGE_INVALID', facts)
  if (to - from > 2 * proto.piece) return refuse(400, 'RANGE_TOO_LARGE', facts)
  const sealed = []
  const sealedEnd = Math.min(to, t.sealedBytes)
  if (from < sealedEnd) {
    const firstIndex = Math.floor(from / proto.piece)
    const hashes = await readPieceHashes(tx, t.id, firstIndex, Math.floor((sealedEnd - 1) / proto.piece) + 1)
    if (!hashes) return refuse(503, 'THREAD_CORRUPT')
    for (let at = from; at < sealedEnd;) {
      const index = Math.floor(at / proto.piece)
      const end = Math.min((index + 1) * proto.piece, sealedEnd)
      sealed.push({ sha256: hashes[index - firstIndex], index, offset: at - index * proto.piece, length: end - at, at })
      at = end
    }
  }
  let tail = ''
  if (to > t.sealedBytes) {
    const open = await readOpen(tx, t, proto)
    if (!open) return refuse(503, 'THREAD_CORRUPT')
    tail = bytesToBase64(open.bytes.subarray(Math.max(from, t.sealedBytes) - t.sealedBytes, to - t.sealedBytes))
  }
  return result(200, { ok: true, ...facts, sealedLineEnd: t.sealedLineEnd, run: t.run, from, to, sealed, tail })
}

// at < bytes: a retry compares bytes; it never writes.
async function compareExisting(tx, t, at, body, proto) {
  const facts = { ...pairOf(t), lineEnd: t.lineEnd }
  const end = at + body.length
  const openStart = Math.max(at, t.sealedBytes)
  const openEnd = Math.min(end, t.bytes)
  let tailEqual = true
  if (openEnd > openStart) {
    const open = await readOpen(tx, t, proto)
    if (!open) return refuse(503, 'THREAD_CORRUPT')
    tailEqual = equalBytes(body.subarray(openStart - at, openEnd - at), open.bytes.subarray(openStart - t.sealedBytes, openEnd - t.sealedBytes))
  }
  const overlap = end > t.bytes
  if (at < t.sealedBytes) {
    const range = await opRange(tx, { id: t.id, from: at, to: Math.min(end, t.sealedBytes) }, proto)
    if (range.status !== 200) return range
    return result(200, { code: 'COMPARE', sealed: range.body.sealed.map(({ sha256, offset, length, at: where }) => ({ sha256, offset, length, at: where })),
      tailEqual, overlap, ...facts })
  }
  if (!tailEqual) return refuse(409, 'DIVERGED', facts)
  if (overlap) return refuse(409, 'OVERLAP', facts)
  return result(200, { ok: true, code: 'ALREADY', ...facts })
}

async function opAppend(tx, input, ctx) {
  const { proto, limits, now } = ctx
  const writer = await writerGate(tx, input.lease, ctx)
  if (writer.refusal) return writer.refusal
  const { id, at, bodySha, have } = input
  if (!HEX64.test(id) || !uint(at) || !HEX64.test(bodySha) || typeof have !== 'string') return refuse(400, 'THREAD_APPEND_INVALID')
  const body = base64ToBytes(input.body)
  if (!body || body.length === 0 || body.length > proto.piece || await sha256Hex(body) !== bodySha) return refuse(400, 'THREAD_PART_INVALID')
  const meta = cleanMeta(input.meta, limits)
  if (meta.refusal) return meta.refusal
  const t = await tx.get(indexKey(id))
  if (t) {
    const gate = threadGate(t, proto, true)
    if (gate) return gate
  }
  const pair = t ? pairOf(t) : EMPTY_PAIR
  const lineEnd = t ? t.lineEnd : 0
  if (at > pair.bytes) return refuse(409, 'GAP', { bytes: pair.bytes })
  if (at < pair.bytes) return compareExisting(tx, t, at, body, proto)
  if (have !== threadHave(pair)) return refuse(409, 'DIVERGED', { ...pair, lineEnd })
  if (!t && await threadIdForPath(input.path) !== id) return refuse(400, 'THREAD_PATH_INVALID')
  const openLength = pair.bytes - pair.sealedBytes
  if (openLength + body.length >= 2 * proto.piece) return refuse(503, 'SEAL_PENDING', { ...pair, lineEnd })
  const world = await readWorld(tx)
  if (!t && world.threads + 1 > limits.threads) return refuse(507, 'WORLD_FULL', { var: 'THREAD_MAX' })
  if (world.tailBytes + body.length > limits.tailBytes) return refuse(507, 'WORLD_FULL', { var: 'THREAD_TAIL_MAX_BYTES' })
  const open = t ? await readOpen(tx, t, proto) : { bytes: new Uint8Array(0) }
  if (!open) return refuse(503, 'THREAD_CORRUPT')
  const charge = ctx.budget && typeof ctx.budget.charge === 'function'
    ? await ctx.budget.charge(tx, { kind: 'lines', bytes: body.length })
    : { ok: false, status: 503, code: 'BUDGET_UNAVAILABLE' }
  if (!isObject(charge) || charge.ok !== true) {
    const status = Number.isInteger(charge?.status) && charge.status >= 400 && charge.status <= 599 ? charge.status : 503
    return refuse(status, typeof charge?.code === 'string' ? charge.code : 'BUDGET_UNAVAILABLE',
      uint(charge?.retryAfterMs) ? { retryAfterMs: charge.retryAfterMs } : {})
  }
  // Every refusal is above this line: nothing below returns early.
  const next = concatBytes([open.bytes, body])
  await writeOpenRows(tx, id, next, pair.sealedBytes, Math.floor(at / proto.row), proto)
  const newline = body.lastIndexOf(10)
  const base = t ?? { v: 1, id, path: input.path, piece: proto.piece, bytes: 0, lineEnd: 0, sealedLineEnd: 0, sealedBytes: 0, partCount: 0,
    chain: THREAD_ZERO_CHAIN, tailSha: THREAD_EMPTY_SHA, title: '', preview: '', activeAt: now, updatedAt: now,
    run: { client: writer.clientId, from: 0 }, keptCount: 0, idle: null }
  const updated = applyMeta({ ...base, bytes: at + body.length, tailSha: await sha256Hex(next),
    lineEnd: newline >= 0 ? at + newline + 1 : lineEnd,
    run: base.run.client === writer.clientId ? base.run : { client: writer.clientId, from: at }, updatedAt: now }, meta.value, now)
  await tx.put(indexKey(id), updated)
  await tx.put(WORLD, { threads: world.threads + (t ? 0 : 1), tailBytes: world.tailBytes + body.length })
  return result(200, { ok: true, code: 'APPLIED', ...pairOf(updated), lineEnd: updated.lineEnd, sealDue: next.length >= proto.piece })
}

async function opSeal(tx, input, ctx) {
  const { proto, now } = ctx
  if (!HEX64.test(input.id) || !HEX64.test(input.sha256)) return refuse(400, 'THREAD_SEAL_INVALID')
  const t = await tx.get(indexKey(input.id))
  if (!t) return refuse(404, 'THREAD_UNKNOWN')
  const gate = threadGate(t, proto, true)
  if (gate) return gate
  if (t.bytes - t.sealedBytes < proto.piece) return result(200, { sealed: false })
  const open = await readOpen(tx, t, proto)
  if (!open) return result(200, { sealed: false })
  const first = open.bytes.subarray(0, proto.piece)
  if (await sha256Hex(first) !== input.sha256) return result(200, { sealed: false })
  const page = Math.floor(t.partCount / PAGE)
  const existing = (await tx.get(pageKey(t.id, page))) ?? []
  if (!Array.isArray(existing) || existing.length !== t.partCount - page * PAGE) return result(200, { sealed: false })
  const world = await readWorld(tx)
  // The hash matched: only now is anything written or deleted.
  await tx.put(pageKey(t.id, page), [...existing, input.sha256])
  for (const k of open.ks.slice(0, proto.rows)) await tx.delete(tailKey(t.id, k))
  const rest = open.bytes.subarray(proto.piece)
  const newline = first.lastIndexOf(10)
  const updated = { ...t, sealedBytes: t.sealedBytes + proto.piece, partCount: t.partCount + 1, chain: await threadChain(t.chain, input.sha256),
    tailSha: await sha256Hex(rest), sealedLineEnd: newline >= 0 ? t.sealedBytes + newline + 1 : t.sealedLineEnd, updatedAt: now }
  await tx.put(indexKey(t.id), updated)
  await tx.put(WORLD, { threads: world.threads, tailBytes: Math.max(0, world.tailBytes - proto.piece) })
  return result(200, { ok: true, sealed: true, ...pairOf(updated), lineEnd: updated.lineEnd })
}

// One import STEP (THREAD_IMPORT_STEP): `parts` holds the hashes of the NEW pieces only, from piece `from` on; `prefixChain` is
// the chain the Worker rolled over the RESCUE's first `from` piece hashes, so the rescue's prefix is proven to be her
// stored pieces by one comparison with the thread's own chain (never by reading every stored hash).
async function opImport(tx, input, ctx) {
  const { proto, limits, now } = ctx
  const writer = await writerGate(tx, input.lease, ctx)
  if (writer.refusal) return writer.refusal
  const { id, path, piece, lineEnd, sealedLineEnd, run, from } = input
  const list = input.parts
  if (!HEX64.test(id) || await threadIdForPath(path) !== id) return refuse(400, 'THREAD_PATH_INVALID')
  if (piece !== proto.piece) return refuse(409, 'PIECE_MISMATCH', { piece })
  const tail = base64ToBytes(input.tail)
  // `run.client` null: the rescue named no client, so the run belongs to the writer that holds the lease now.
  if (!uint(from) || typeof input.prefixChain !== 'string' || !HEX64.test(input.prefixChain)
    || !Array.isArray(list) || list.length > THREAD_IMPORT_STEP.pieces || from + list.length > IMPORT_PARTS_MAX || !list.every(sha => HEX64.test(sha)) || !tail || tail.length >= proto.piece
    || !isObject(run) || (run.client !== null && (typeof run.client !== 'string' || run.client === '')) || !uint(run.from)) return refuse(400, 'THREAD_IMPORT_INVALID')
  const meta = cleanMeta(input.meta, limits)
  if (meta.refusal) return meta.refusal
  const t = await tx.get(indexKey(id))
  if (t) {
    const gate = threadGate(t, proto, true)
    if (gate) return gate
  }
  if (!samePair(t ? pairOf(t) : null, input.expect ?? null)) return refuse(503, 'THREAD_MOVED')
  const known = t ? t.partCount : 0
  if (from !== known) return refuse(400, 'THREAD_IMPORT_INVALID')
  if (input.prefixChain !== (t ? t.chain : THREAD_ZERO_CHAIN)) return refuse(409, 'IMPORT_NOT_PREFIX')
  const newSealed = (from + list.length) * proto.piece
  const newBytes = newSealed + tail.length
  const newlineInTail = tail.lastIndexOf(10)
  if (!uint(lineEnd) || !uint(sealedLineEnd) || sealedLineEnd > newSealed
    || (newlineInTail >= 0 ? lineEnd !== newSealed + newlineInTail + 1 : lineEnd !== sealedLineEnd)) return refuse(400, 'THREAD_IMPORT_INVALID')
  let open = { bytes: new Uint8Array(0), ks: [] }
  if (t) {
    if (newBytes < t.bytes) return refuse(409, 'IMPORT_NOT_PREFIX')
    const read = await readOpen(tx, t, proto)
    if (!read) return refuse(503, 'THREAD_CORRUPT')
    open = read
    if (t.bytes > newSealed && !equalBytes(open.bytes.subarray(newSealed - t.sealedBytes), tail.subarray(0, t.bytes - newSealed))) return refuse(409, 'IMPORT_NOT_PREFIX')
  }
  const world = await readWorld(tx)
  if (!t && world.threads + 1 > limits.threads) return refuse(507, 'WORLD_FULL', { var: 'THREAD_MAX' })
  const growth = tail.length - (t ? t.bytes - t.sealedBytes : 0)
  if (growth > 0 && world.tailBytes + growth > limits.tailBytes) return refuse(507, 'WORLD_FULL', { var: 'THREAD_TAIL_MAX_BYTES' })
  let chain = t ? t.chain : THREAD_ZERO_CHAIN
  for (const sha of list) chain = await threadChain(chain, sha)
  // Every refusal is above this line.
  await appendPieceHashes(tx, id, known, list)
  for (const k of open.ks) if (k * proto.row < newSealed) await tx.delete(tailKey(id, k))
  await writeOpenRows(tx, id, tail, newSealed, newSealed / proto.row, proto)
  const base = t ?? { v: 1, id, path, piece: proto.piece, title: '', preview: '', activeAt: now, keptCount: 0, idle: null }
  const updated = applyMeta({ ...base, bytes: newBytes, lineEnd, sealedLineEnd, sealedBytes: newSealed, partCount: from + list.length, chain,
    tailSha: await sha256Hex(tail), run: { client: run.client ?? writer.clientId, from: run.from }, updatedAt: now }, meta.value, now)
  await tx.put(indexKey(id), updated)
  await tx.put(WORLD, { threads: world.threads + (t ? 0 : 1), tailBytes: Math.max(0, world.tailBytes + growth) })
  return result(200, { ok: true, code: 'IMPORTED', ...pairOf(updated), lineEnd })
}

const keptValid = (kept, piece) => isObject(kept) && uint(kept.bytes) && kept.bytes > 0 && HEX64.test(kept.sha256)
  && Array.isArray(kept.pieces) && kept.pieces.length === Math.ceil(kept.bytes / piece) && kept.pieces.length <= KEPT_PIECES_MAX
  && kept.pieces.every(sha => HEX64.test(sha))

async function opRetract(tx, input, ctx) {
  const { proto, limits, now } = ctx
  const writer = await writerGate(tx, input.lease, ctx)
  if (writer.refusal) return writer.refusal
  const { id, forkAt } = input
  if (!HEX64.test(id) || !uint(forkAt)) return refuse(400, 'RETRACT_INVALID')
  const t = await tx.get(indexKey(id))
  if (!t) return refuse(404, 'THREAD_UNKNOWN')
  const gate = threadGate(t, proto, true)
  if (gate) return gate
  if (!samePair(pairOf(t), input.expect ?? null)) return refuse(503, 'THREAD_MOVED')
  if (forkAt > t.bytes) return refuse(400, 'RETRACT_INVALID', { bytes: t.bytes })
  if (forkAt === t.bytes) return result(200, { ok: true, bytes: t.bytes })
  if (forkAt < t.sealedBytes) return refuse(409, 'RETRACT_TOO_DEEP', { sealedBytes: t.sealedBytes })
  const own = forkAt >= t.sealedBytes && forkAt >= t.run.from && t.run.client === writer.clientId
  if (!own && input.approved !== true) return refuse(403, 'CLASS3_WEBAUTHN_REQUIRED')
  if (t.keptCount >= limits.kept) return refuse(507, 'KEPT_FULL', { var: 'THREAD_KEPT_MAX' })
  const kept = input.kept
  if (!keptValid(kept, proto.piece) || kept.bytes !== t.bytes - forkAt) return refuse(400, 'KEPT_INVALID')
  const open = await readOpen(tx, t, proto)
  if (!open) return refuse(503, 'THREAD_CORRUPT')
  const removed = open.bytes.subarray(forkAt - t.sealedBytes)
  if (await sha256Hex(removed) !== kept.sha256) return refuse(409, 'KEPT_MISMATCH')
  for (let i = 0; i < kept.pieces.length; i++) {
    if (await sha256Hex(removed.subarray(i * proto.piece, (i + 1) * proto.piece)) !== kept.pieces[i]) return refuse(409, 'KEPT_MISMATCH')
  }
  const world = await readWorld(tx)
  // Every refusal is above this line; the removed bytes are proven in the kept blobs.
  await tx.put(keptKey(id, t.keptCount), { why: 'retract', at: now, by: writer.clientId, from: forkAt, bytes: kept.bytes, sha256: kept.sha256, pieces: kept.pieces })
  const remaining = open.bytes.subarray(0, forkAt - t.sealedBytes)
  for (const k of open.ks) {
    const start = k * proto.row
    if (start >= forkAt) await tx.delete(tailKey(id, k))
    else if (start + proto.row > forkAt) await tx.put(tailKey(id, k), remaining.slice(start - t.sealedBytes))
  }
  const newline = remaining.lastIndexOf(10)
  const updated = { ...t, bytes: forkAt, tailSha: await sha256Hex(remaining), lineEnd: newline >= 0 ? t.sealedBytes + newline + 1 : t.sealedLineEnd,
    run: { client: t.run.client, from: Math.min(t.run.from, forkAt) }, keptCount: t.keptCount + 1, updatedAt: now }
  await tx.put(indexKey(id), updated)
  await tx.put(WORLD, { threads: world.threads, tailBytes: Math.max(0, world.tailBytes - removed.length) })
  return result(200, { ok: true, code: 'RETRACTED', ...pairOf(updated), lineEnd: updated.lineEnd, kept: t.keptCount })
}

async function opKeep(tx, input, ctx) {
  const { proto, limits, now } = ctx
  const { id, forkAt, why } = input
  let by = input.by
  // A kept row written by an import is a write through import: it needs the lease, like every other import write.
  if (why === 'import-fork' || input.lease !== undefined) {
    const writer = await writerGate(tx, input.lease, ctx)
    if (writer.refusal) return writer.refusal
    if (why === 'import-fork' && by === null) by = writer.clientId
  }
  if (!HEX64.test(id) || !uint(forkAt) || !keptValid(input, proto.piece) || typeof by !== 'string' || by === '' || by.length > 256
    || typeof why !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(why)) return refuse(400, 'KEPT_INVALID')
  const t = await tx.get(indexKey(id))
  if (!t) return refuse(404, 'THREAD_UNKNOWN')
  const gate = threadGate(t, proto, true)
  if (gate) return gate
  const rows = await tx.list({ prefix: keptPrefix(id), limit: limits.kept + 1 })
  for (const row of rows.values()) if (row.from === forkAt && row.sha256 === input.sha256) return result(200, { ok: true, code: 'ALREADY' })
  if (t.keptCount >= limits.kept) return refuse(507, 'KEPT_FULL', { var: 'THREAD_KEPT_MAX' })
  await tx.put(keptKey(id, t.keptCount), { why, at: now, by, from: forkAt, bytes: input.bytes, sha256: input.sha256, pieces: input.pieces })
  await tx.put(indexKey(id), { ...t, keptCount: t.keptCount + 1, updatedAt: now })
  return result(200, { ok: true, code: 'KEPT', kept: t.keptCount })
}

/**
 * The MIRROR half: one short step inside the caller's open storage transaction.
 * Refusals are returned as `{status, body}`; a storage error propagates so the caller's transaction rolls back.
 * @param {object} tx Open transaction view: get, put, delete, list({prefix, start, startAfter, limit}).
 * @param {string} op index | manifest | range | append | seal | import | retract | keep.
 * @param {object} input Plain JSON input for the op.
 * @param {object} options `{ checkLease, budget, limits, protocol, now }`.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function threadCommit(tx, op, input, { checkLease, budget, limits = THREAD_LIMITS, protocol = THREAD_PROTOCOL, now = Date.now } = {}) {
  const proto = normalizeThreadProtocol(protocol)
  if (!proto) return refuse(500, 'THREAD_PROTOCOL_INVALID')
  if (!isObject(input)) return refuse(400, 'THREAD_INPUT_INVALID')
  const ctx = { checkLease, budget, limits, proto, now: typeof now === 'function' ? now() : now }
  if (op === 'index') return opIndex(tx, input)
  if (op === 'manifest') return opManifest(tx, input, proto)
  if (op === 'range') return opRange(tx, input, proto)
  if (op === 'append') return opAppend(tx, input, ctx)
  if (op === 'seal') return opSeal(tx, input, ctx)
  if (op === 'import') return opImport(tx, input, ctx)
  if (op === 'retract') return opRetract(tx, input, ctx)
  if (op === 'keep') return opKeep(tx, input, ctx)
  return refuse(400, 'THREAD_OP_UNKNOWN')
}

// </mirror-half>

// ---------------------------------------------------------------------------------------------------------------
// The Worker half: bodies, hashes and R2 live here; MIRROR is reached only through `mirror.call(op, input)`.

/** Defaults for the Worker half's waits, in milliseconds. */
export const THREAD_DEADLINES = Object.freeze({ r2Ms: 10000, idleMs: 30000, totalMs: 120000 })
const TAIL_MAX = 262144
const KEEP_ROUTE_PIECES_MAX = 40
const META_HEADER_MAX = 4096
const JSON_BODY_MAX = 8192
const RESCUE_SCAN_PIECES = 4
const LATE = Symbol('late')

/** The query keys each route reads; the JSON routes read none. */
const THREAD_QUERY = Object.freeze({ '/_thread/append': ['p', 'id', 'at'], '/_thread/index': ['after', 'limit'], '/_thread/manifest': ['id', 'page'], '/_thread/tail': ['id', 'before', 'max'] })

class ThreadStop extends Error {
  constructor(status, body) { super(body.code); this.status = status; this.body = body }
}
const stop = (status, code, extra = {}) => { throw new ThreadStop(status, { ok: false, code, ...extra }) }
const pairFrom = body => ({ bytes: body.bytes, sealedBytes: body.sealedBytes, chain: body.chain, tailSha: body.tailSha })
const facts = body => ({ ...pairFrom(body), lineEnd: body.lineEnd, have: threadHave(body) })
const reply = (status, body) => {
  const clean = { ...body }
  delete clean.conflictCode
  return Response.json(clean, { status, headers: { 'cache-control': 'no-store' } })
}

// Race one R2 or rescue call against its deadline; late or failed is 503 ARCHIVE_UNAVAILABLE.
async function within(ms, work) {
  let timer
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(LATE), ms) })
  try {
    const pending = Promise.resolve().then(work)
    pending.catch(() => {})
    const value = await Promise.race([pending, late])
    if (value === LATE) stop(503, 'ARCHIVE_UNAVAILABLE')
    return value
  } catch (error) {
    if (error instanceof ThreadStop) throw error
    return stop(503, 'ARCHIVE_UNAVAILABLE')
  } finally { clearTimeout(timer) }
}

// Read a whole body with a hard byte limit while streaming, an idle deadline and a total deadline.
// The vault's rules for a body (vault.mjs readBody): an encoding other
// than identity, a declared length that is not a plain number, or one that is not the body's length, is 400.
async function readBody(request, maxBytes, deadlines, tooLarge) {
  const declared = request.headers.get('content-length')
  const encoding = request.headers.get('content-encoding')
  if ((encoding && encoding.trim().toLowerCase() !== 'identity') || (declared !== null && !/^\d{1,15}$/.test(declared))) {
    void request.body?.cancel().catch(() => {})
    stop(400, 'THREAD_REQUEST_INVALID')
  }
  if (declared !== null && Number(declared) > maxBytes) {
    void request.body?.cancel().catch(() => {})
    stop(413, tooLarge)
  }
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  let totalTimer
  const totalLate = new Promise(resolve => { totalTimer = setTimeout(() => resolve(LATE), deadlines.totalMs) })
  try {
    for (;;) {
      let idleTimer
      const idleLate = new Promise(resolve => { idleTimer = setTimeout(() => resolve(LATE), deadlines.idleMs) })
      const read = reader.read()
      read.catch(() => {})
      let step
      try { step = await Promise.race([read, idleLate, totalLate]) }
      catch { stop(400, 'THREAD_BODY_UNREADABLE') }
      finally { clearTimeout(idleTimer) }
      if (step === LATE) {
        void reader.cancel().catch(() => {})
        stop(408, 'REQUEST_BODY_TIMEOUT')
      }
      if (step.done) break
      const value = step.value instanceof Uint8Array ? step.value : new Uint8Array(step.value)
      total += value.length
      if (total > maxBytes) {
        void reader.cancel().catch(() => {})
        stop(413, tooLarge)
      }
      chunks.push(value)
    }
  } finally { clearTimeout(totalTimer) }
  if (declared !== null && total !== Number(declared)) stop(400, 'THREAD_REQUEST_INVALID')
  return concatBytes(chunks)
}

async function readJson(request, maxBytes, deadlines, keys) {
  // A JSON body says so, as on the estate and owner-grant routes (worker.mjs).
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    void request.body?.cancel().catch(() => {})
    stop(400, 'THREAD_REQUEST_INVALID')
  }
  const bytes = await readBody(request, maxBytes, deadlines, 'THREAD_REQUEST_TOO_LARGE')
  let input
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { stop(400, 'THREAD_JSON_INVALID') }
  if (!isObject(input) || Object.keys(input).some(key => !keys.includes(key))) stop(400, 'THREAD_JSON_INVALID')
  return input
}

const leaseHeader = request => {
  const match = /^([0-9a-f]{32})\.(\d{1,15})$/.exec(request.headers.get('x-thread-lease') ?? '')
  return match ? { leaseId: match[1], generation: Number(match[2]) } : stop(423, 'WRITER_REQUIRED')
}

const metaHeader = request => {
  const raw = request.headers.get('x-thread-meta')
  if (raw === null) return undefined
  if (raw.length > META_HEADER_MAX || !/^[A-Za-z0-9_-]*$/.test(raw)) stop(400, 'THREAD_META_INVALID')
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4)
  const bytes = base64ToBytes(padded)
  let meta
  try { meta = bytes && JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { stop(400, 'THREAD_META_INVALID') }
  if (!isObject(meta)) stop(400, 'THREAD_META_INVALID')
  return meta
}

const intParam = (url, name, fallback) => {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return fallback
  return /^\d{1,15}$/.test(raw) ? Number(raw) : stop(400, 'THREAD_QUERY_INVALID', { field: name })
}

const idParam = url => {
  const id = url.searchParams.get('id') ?? ''
  return HEX64.test(id) ? id : stop(400, 'THREAD_ID_INVALID')
}

// `home` rides only on the one import call that commits (the mount posts it beside `{op, input}`); no other op has one.
function createCaller(mirror) {
  return async (op, input, home) => {
    let answer
    try { answer = await (home === undefined ? mirror.call(op, input) : mirror.call(op, input, home)) } catch { stop(503, 'THREAD_STORAGE_UNAVAILABLE') }
    if (!isObject(answer) || !Number.isInteger(answer.status) || !isObject(answer.body)) stop(503, 'THREAD_STORAGE_UNAVAILABLE')
    return answer
  }
}

// Pass a MIRROR answer through; the internal COMPARE never reaches the browser.
const forward = answer => answer.body.code === 'COMPARE' ? reply(503, { ok: false, code: 'THREAD_UNAVAILABLE' }) : reply(answer.status, answer.body)

// Head first, write once, head again and compare the size. A content key is never written twice.
async function ensurePart(env, sha, bytes) {
  const before = await within(env.deadlines.r2Ms, () => env.parts.head(sha))
  if (before && before.size === bytes.length) return
  if (before) stop(503, 'ARCHIVE_UNAVAILABLE')
  await within(env.deadlines.r2Ms, () => env.parts.put(sha, bytes))
  const after = await within(env.deadlines.r2Ms, () => env.parts.head(sha))
  if (!after || after.size !== bytes.length) stop(503, 'ARCHIVE_UNAVAILABLE')
}

async function getPart(env, sha, offset, length) {
  const bytes = await within(env.deadlines.r2Ms, () => env.parts.get(sha, { offset, length }))
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) stop(503, 'ARCHIVE_UNAVAILABLE')
  return bytes
}

// Seal the first piece of the open end now. Any failure answers null and changes nothing in MIRROR.
async function runSeal(env, call, id, pair) {
  try {
    const from = pair.sealedBytes
    const range = await call('range', { id, from, to: from + env.proto.piece })
    if (range.status !== 200 || range.body.sealed.length !== 0) return null
    const bytes = base64ToBytes(range.body.tail)
    if (!bytes || bytes.length !== env.proto.piece) return null
    const sha = await sha256Hex(bytes)
    await ensurePart(env, sha, bytes)
    const sealed = await call('seal', { id, sha256: sha })
    return sealed.status === 200 && sealed.body.sealed === true ? sealed.body : null
  } catch { return null }
}

// Bytes [from, to) of a thread: sealed stretches from R2, the open end from MIRROR, at most 2 PIECE per call.
async function readThreadBytes(env, call, id, from, to) {
  const out = []
  for (let at = from; at < to;) {
    const end = Math.min(to, at + 2 * env.proto.piece)
    const range = await call('range', { id, from: at, to: end })
    if (range.status !== 200) throw new ThreadStop(range.status, range.body)
    for (const ref of range.body.sealed) out.push(await getPart(env, ref.sha256, ref.offset, ref.length))
    const tail = base64ToBytes(range.body.tail)
    if (!tail) stop(503, 'THREAD_UNAVAILABLE')
    out.push(tail)
    at = end
  }
  const bytes = concatBytes(out)
  if (bytes.length !== to - from) stop(503, 'THREAD_UNAVAILABLE')
  return bytes
}

// Bytes [from, to) of a rescued file, from its pieces.
async function readFileBytes(env, rescue, from, to) {
  const out = []
  const piece = env.proto.piece
  for (let at = from; at < to;) {
    const index = Math.floor(at / piece)
    const end = Math.min(to, (index + 1) * piece)
    out.push(await getPart(env, rescue.pieces[index], at - index * piece, end - at))
    at = end
  }
  return concatBytes(out)
}

async function settleCompare(env, body, at, compare) {
  if (!Array.isArray(compare.sealed) || compare.sealed.length > 2) stop(503, 'THREAD_UNAVAILABLE')
  let equal = compare.tailEqual === true
  for (const ref of compare.sealed) {
    if (!equal) break
    const stored = await getPart(env, ref.sha256, ref.offset, ref.length)
    equal = equalBytes(stored, body.subarray(ref.at - at, ref.at - at + ref.length))
  }
  if (!equal) return reply(409, { ok: false, code: 'DIVERGED', ...facts(compare) })
  if (compare.overlap) return reply(409, { ok: false, code: 'OVERLAP', ...facts(compare) })
  return reply(200, { ok: true, code: 'ALREADY', ...facts(compare) })
}

async function routeAppend(env, call, request, url) {
  if (url.searchParams.get('p') !== '1') stop(426, 'PROTOCOL')
  const id = idParam(url)
  const at = intParam(url, 'at', null)
  if (at === null) stop(400, 'THREAD_QUERY_INVALID', { field: 'at' })
  const lease = leaseHeader(request)
  const have = request.headers.get('x-thread-have') ?? ''
  if (!/^[0-9a-f]{64}\.[0-9a-f]{64}$/.test(have)) stop(400, 'THREAD_HAVE_INVALID')
  const claimed = request.headers.get('x-thread-sha256') ?? ''
  if (!HEX64.test(claimed)) stop(400, 'THREAD_PART_INVALID')
  const path = request.headers.get('x-thread-path')
  if (path !== null && !threadPathAllowed(path)) stop(400, 'THREAD_PATH_INVALID')
  const meta = metaHeader(request)
  const body = await readBody(request, env.proto.piece, env.deadlines, 'PART_TOO_LARGE')
  if (body.length === 0 || await sha256Hex(body) !== claimed) stop(400, 'THREAD_PART_INVALID')
  const input = { id, at, body: bytesToBase64(body), bodySha: claimed, have, lease, ...(path !== null ? { path } : {}), ...(meta ? { meta } : {}) }
  let answer = await call('append', input)
  if (answer.body.code === 'SEAL_PENDING') {
    await runSeal(env, call, id, answer.body)
    answer = await call('append', input)
    if (answer.body.code === 'SEAL_PENDING') return reply(503, { ok: false, code: 'SEAL_PENDING', ...facts(answer.body) })
  }
  if (answer.status === 200 && answer.body.code === 'COMPARE') return settleCompare(env, body, at, answer.body)
  if (answer.status !== 200 || answer.body.code !== 'APPLIED') return forward(answer)
  let after = answer.body
  if (answer.body.sealDue === true) {
    const sealed = await runSeal(env, call, id, answer.body)
    if (sealed) after = sealed
    else {
      const manifest = await call('manifest', { id, page: 0 }).catch(() => null)
      if (manifest?.status === 200) after = manifest.body.thread
    }
  }
  return reply(200, { ok: true, code: 'APPLIED', ...facts(after) })
}

const rescueValid = (rescue, piece) => isObject(rescue) && rescue.piece === piece && uint(rescue.bytes) && rescue.bytes > 0
  && HEX64.test(rescue.sha256) && Array.isArray(rescue.pieces) && rescue.pieces.length === Math.ceil(rescue.bytes / piece)
  && rescue.pieces.every(sha => HEX64.test(sha)) && isObject(rescue.client)
  && (rescue.client.clientId === null || (typeof rescue.client.clientId === 'string' && rescue.client.clientId !== '' && rescue.client.clientId.length <= 256))

/**
 * One journal out of a VERIFIED vault rescue index (`pending.json` whose SHA-256 the rescue's `manifest.json` names):
 * `{v:1, piece, source, client:{clientId, base, reconciliation}, rows:[{key, type, bytes, sha256, pieces}], skipped, totals}`.
 * The journal is the one `file` row whose `key` is the journal path. A null `clientId` stays null here: the import then
 * gives the run to the writer that holds the lease.
 * @param {unknown} index The parsed, verified rescue index.
 * @param {string} path The journal path.
 * @returns {{piece: number, bytes: number, sha256: string, pieces: string[], client: {clientId: string|null, base: unknown, reconciliation: unknown}, path: string}|null}
 */
export function threadRescueFromVault(index, path) {
  if (!isObject(index) || index.v !== 1 || !isObject(index.client) || !Array.isArray(index.rows)) return null
  const rows = index.rows.filter(row => isObject(row) && row.key === path && row.type === 'file')
  if (rows.length !== 1) return null
  const [row] = rows
  const clientId = index.client.clientId === undefined ? null : index.client.clientId
  // The client's base and reconciliation mark ride along unread: MIRROR decides what they mean for her home (PLAN 3.4).
  const client = { clientId, base: index.client.base ?? null, reconciliation: index.client.reconciliation ?? null }
  const rescue = { piece: index.piece, bytes: row.bytes, sha256: row.sha256, pieces: row.pieces, client, path }
  return rescueValid(rescue, index.piece) ? rescue : null
}

// Is the first min(file, thread) bytes the same? Piece hashes first, then the bytes that no hash covers.
async function sharedPrefixEqual(env, call, rescue, thread, threadParts) {
  const piece = env.proto.piece
  const common = Math.min(rescue.bytes, thread.bytes)
  let k = 0
  while (k < thread.partCount && (k + 1) * piece <= common) {
    if (rescue.pieces[k] !== threadParts[k]) return false
    k += 1
  }
  if (k * piece >= common) return true
  const fileBytes = await readFileBytes(env, rescue, k * piece, common)
  const threadBytes = await readThreadBytes(env, call, thread.id, k * piece, common)
  return equalBytes(fileBytes, threadBytes)
}

// lineEnd and sealedLineEnd of the file, from its last pieces; a known line end of the thread is a floor.
async function rescueLineEnds(env, rescue, tail, newSealed, floor) {
  const piece = env.proto.piece
  let sealedLineEnd = floor
  const scanned = tail.length ? 1 : 0
  for (let index = newSealed / piece - 1, n = scanned; index >= 0 && n < RESCUE_SCAN_PIECES && (index + 1) * piece > floor; index--, n++) {
    const bytes = await readFileBytes(env, rescue, index * piece, (index + 1) * piece)
    const newline = bytes.lastIndexOf(10)
    if (newline >= 0) { sealedLineEnd = Math.max(floor, index * piece + newline + 1); break }
  }
  const newline = tail.lastIndexOf(10)
  return { lineEnd: newline >= 0 ? newSealed + newline + 1 : sealedLineEnd, sealedLineEnd }
}

async function routeImport(env, call, request) {
  const lease = leaseHeader(request)
  const input = await readJson(request, JSON_BODY_MAX, env.deadlines, ['path', 'rescue', 'meta'])
  const id = await threadIdForPath(input.path)
  if (!id) stop(400, 'THREAD_PATH_INVALID')
  if (typeof input.rescue !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.rescue)) stop(400, 'RESCUE_INVALID')
  if (input.meta !== undefined && !isObject(input.meta)) stop(400, 'THREAD_META_INVALID')
  // `rescues.get(id)`: `{ index, verifiedAt }` for a VERIFIED rescue, null for none, `{ unavailable: true }` when the
  // bucket could not be read whole just now.
  const found = await within(env.deadlines.r2Ms, () => env.rescues.get(input.rescue))
  if (found?.unavailable === true) stop(503, 'ARCHIVE_UNAVAILABLE')
  const index = found?.index
  if (!isObject(index)) stop(404, 'RESCUE_UNKNOWN')
  if (index.piece !== env.proto.piece) stop(409, 'PIECE_MISMATCH', { piece: index.piece })
  const rescue = threadRescueFromVault(index, input.path)
  if (!rescue) stop(404, 'RESCUE_UNKNOWN')
  const manifest = await call('manifest', { id, page: 0 })
  let thread = null
  const threadParts = []
  if (manifest.status === 200) {
    thread = manifest.body.thread
    threadParts.push(...manifest.body.parts)
    for (let page = 1; page < manifest.body.pages; page++) {
      const next = await call('manifest', { id, page })
      if (next.status !== 200) return forward(next)
      threadParts.push(...next.body.parts)
    }
  } else if (manifest.body.code !== 'THREAD_UNKNOWN') return forward(manifest)
  const before = thread ? thread.bytes : 0
  const pairNow = thread ? pairFrom(thread) : null
  if (before > 0 && !await sharedPrefixEqual(env, call, rescue, thread, threadParts)) {
    const kept = await call('keep', { id, forkAt: 0, bytes: rescue.bytes, sha256: rescue.sha256, pieces: rescue.pieces,
      by: rescue.client.clientId, why: 'import-fork', lease })
    if (kept.status !== 200) return forward(kept)
    return reply(200, { ok: true, code: 'IMPORT', outcome: 'kept-beside', ...facts(thread) })
  }
  if (before > 0 && rescue.bytes <= before) return reply(200, { ok: true, code: 'IMPORT', outcome: 'same', ...facts(thread) })
  const piece = env.proto.piece
  const fullPieces = Math.floor(rescue.bytes / piece)
  const newSealed = fullPieces * piece
  const tail = rescue.bytes > newSealed ? await readFileBytes(env, rescue, newSealed, rescue.bytes) : new Uint8Array(0)
  const floors = thread ? [thread.sealedLineEnd, ...(thread.lineEnd <= newSealed ? [thread.lineEnd] : [])] : [0]
  // Whose home this came from (judge's find 3): the rescue, its client, that client's base and reconciliation mark, and
  // when the vault verified it. Only on the one call that commits the whole journal (the last step); MIRROR records it.
  const home = { rescue: input.rescue, clientId: rescue.client.clientId, base: rescue.client.base, reconciliation: rescue.client.reconciliation,
    verifiedAt: typeof found.verifiedAt === 'string' ? found.verifiedAt : null }
  // The new pieces go to MIRROR in steps of at most THREAD_IMPORT_STEP.pieces, each a committed
  // byte prefix of the journal (a cut at a piece boundary, no open end), so her app's save runs between two steps. The
  // last step carries the open end and `home`. Each step proves the rescue's prefix by the chain over its piece hashes.
  const known = thread ? thread.partCount : 0
  let prefixChain = THREAD_ZERO_CHAIN
  for (const sha of rescue.pieces.slice(0, known)) prefixChain = await threadChain(prefixChain, sha)
  let expect = pairNow, floor = Math.max(...floors), answer = null
  // The first cut covers every byte the thread holds now (its open end is under 2 PIECE), whatever the step.
  const firstEnd = Math.min(fullPieces, Math.ceil(before / piece))
  for (let at = known; ;) {
    const end = Math.max(firstEnd, Math.min(fullPieces, at + env.importStep))
    const last = end === fullPieces
    const stepTail = last ? tail : new Uint8Array(0)
    const ends = await rescueLineEnds(env, rescue, stepTail, end * piece, floor)
    const parts = rescue.pieces.slice(at, end)
    answer = await call('import', { id, path: input.path, piece, from: at, prefixChain, parts, tail: bytesToBase64(stepTail),
      lineEnd: ends.lineEnd, sealedLineEnd: ends.sealedLineEnd, expect, run: { client: rescue.client.clientId, from: before }, lease,
      ...(input.meta !== undefined ? { meta: input.meta } : {}) }, last ? home : undefined)
    if (answer.status !== 200) return forward(answer)
    if (last) break
    for (const sha of parts) prefixChain = await threadChain(prefixChain, sha)
    expect = pairFrom(answer.body)
    floor = ends.sealedLineEnd
    at = end
  }
  return reply(200, { ok: true, code: 'IMPORT', outcome: before === 0 ? 'imported' : 'extended', ...facts(answer.body) })
}

// The retract body names the exact bytes the card showed: [forkAt, to) and their SHA-256. The passkey binds that body,
// and nothing else is removed: a thread that has moved since the card is 409 THREAD_MOVED before any blob is written.
async function routeRetract(env, call, request) {
  const lease = leaseHeader(request)
  const input = await readJson(request, 1024, env.deadlines, ['id', 'forkAt', 'to', 'sha256'])
  if (!HEX64.test(input.id) || !uint(input.forkAt) || !uint(input.to) || input.to < input.forkAt || !HEX64.test(input.sha256)) stop(400, 'RETRACT_INVALID')
  const { id, forkAt } = input
  const card = Object.freeze({ id, forkAt, to: input.to, sha256: input.sha256 })
  const range = await call('range', { id, from: forkAt })
  if (range.status !== 200) {
    if (uint(range.body.sealedBytes) && forkAt < range.body.sealedBytes) stop(409, 'RETRACT_TOO_DEEP', { sealedBytes: range.body.sealedBytes })
    if (range.body.code === 'RANGE_INVALID' && uint(range.body.bytes)) stop(400, 'RETRACT_INVALID', { bytes: range.body.bytes })
    return forward(range)
  }
  if (forkAt < range.body.sealedBytes) stop(409, 'RETRACT_TOO_DEEP', { sealedBytes: range.body.sealedBytes })
  const removed = base64ToBytes(range.body.tail)
  if (!removed || removed.length !== range.body.bytes - forkAt) stop(503, 'THREAD_UNAVAILABLE')
  if (range.body.bytes !== card.to || await sha256Hex(removed) !== card.sha256) stop(409, 'THREAD_MOVED', facts(range.body))
  const expect = pairFrom(range.body)
  let kept = null
  if (forkAt < range.body.bytes) {
    const pieces = []
    for (let at = 0; at < removed.length; at += env.proto.piece) {
      const bytes = removed.subarray(at, at + env.proto.piece)
      const sha = await sha256Hex(bytes)
      await ensurePart(env, sha, bytes)
      pieces.push(sha)
    }
    kept = { bytes: removed.length, sha256: await sha256Hex(removed), pieces }
  }
  const step = { id, forkAt, kept, expect, lease }
  const first = await call('retract', { ...step, approved: false })
  if (first.status !== 403 || first.body.code !== 'CLASS3_WEBAUTHN_REQUIRED') return forward(first)
  // Only now is the owner's passkey asked for, over exactly the body this handler parsed and checked.
  let approved = false
  if (typeof env.approve === 'function') {
    try { approved = (await env.approve(card)) === true } catch { approved = false }
  }
  if (!approved) return forward(first)
  return forward(await call('retract', { ...step, approved: true }))
}

async function routeKeep(env, call, request) {
  const input = await readJson(request, JSON_BODY_MAX, env.deadlines, ['id', 'forkAt', 'pieces', 'bytes', 'sha256'])
  if (!HEX64.test(input.id) || !uint(input.forkAt) || !uint(input.bytes) || input.bytes === 0 || !HEX64.test(input.sha256)
    || !Array.isArray(input.pieces) || input.pieces.length === 0 || input.pieces.length > KEEP_ROUTE_PIECES_MAX
    || !input.pieces.every(sha => HEX64.test(sha))) stop(400, 'KEPT_INVALID')
  let total = 0
  for (const sha of input.pieces) {
    const head = await within(env.deadlines.r2Ms, () => env.parts.head(sha))
    if (!head) stop(424, 'KEPT_BLOB_MISSING', { sha256: sha })
    total += head.size
  }
  if (total !== input.bytes) stop(400, 'KEPT_INVALID')
  return forward(await call('keep', { id: input.id, forkAt: input.forkAt, bytes: input.bytes, sha256: input.sha256, pieces: input.pieces,
    by: 'owner', why: 'keep' }))
}

// Whole lines ending at `before`; the edge looks only for newline bytes and never parses a line.
async function routeTail(env, call, url) {
  const id = idParam(url)
  const manifest = await call('manifest', { id, page: 0 })
  if (manifest.status !== 200) return forward(manifest)
  const thread = manifest.body.thread
  const before = Math.min(intParam(url, 'before', thread.lineEnd), thread.lineEnd)
  const max = Math.min(intParam(url, 'max', TAIL_MAX), TAIL_MAX)
  if (max < 1) stop(400, 'THREAD_QUERY_INVALID', { field: 'max' })
  const answer = (bytes, from, to, partial) => new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream',
    'cache-control': 'no-store', 'x-thread-from': String(from), 'x-thread-to': String(to), ...(partial ? { 'x-thread-partial': '1' } : {}) } })
  if (before === 0) return answer(new Uint8Array(0), 0, 0, false)
  const readFrom = Math.max(0, before - max - 1)
  const window = await readThreadBytes(env, call, id, readFrom, before)
  const lastNewline = window.lastIndexOf(10)
  if (lastNewline < 0) {
    const take = Math.min(max, window.length)
    return answer(window.slice(window.length - take), before - take, before, true)
  }
  const end = readFrom + lastNewline + 1
  const low = Math.max(0, end - max)
  if (low === 0) return answer(window.slice(0, end - readFrom), 0, end, false)
  const index = window.indexOf(10, Math.max(0, low - 1 - readFrom))
  if (index >= 0 && readFrom + index < end - 1) return answer(window.slice(index + 1, end - readFrom), readFrom + index + 1, end, false)
  return answer(window.slice(low - readFrom, end - readFrom), low, end, true)
}

/**
 * The Worker half: answers every `/_thread/` path with a Response; nothing is thrown past it.
 * `rescues.get(id)` answers `{ index, verifiedAt }` for a VERIFIED vault rescue (see `threadRescueFromVault`), null for
 * none, or `{ unavailable: true }` when the bucket could not be read just now (503). `mirror.call(op, input, home?)`.
 * `approve(card)` is the owner's passkey check over the exact parsed retract body `{id, forkAt, to, sha256}`; it is
 * called only when MIRROR answers that the retract needs it, and answers true only for a valid approval of that body.
 * @param {object} options `{ request, url, mirror, parts, rescues, limits, protocol, now, approve, deadlines, importStep }`.
 * @returns {Promise<Response>}
 */
export async function handleThreadRequest({ request, url, mirror, parts, rescues, limits = THREAD_LIMITS, protocol = THREAD_PROTOCOL, now: _now, approve, deadlines, importStep = THREAD_IMPORT_STEP.pieces } = {}) {
  try {
    const proto = normalizeThreadProtocol(protocol)
    if (!proto || !request || !mirror || typeof mirror.call !== 'function') stop(503, 'THREAD_UNAVAILABLE')
    const where = url ?? new URL(request.url)
    // `importStep`: pieces per import step, 1 to THREAD_IMPORT_STEP.pieces (MIRROR refuses a longer step).
    const step = Number.isSafeInteger(importStep) && importStep >= 1 ? Math.min(importStep, THREAD_IMPORT_STEP.pieces) : THREAD_IMPORT_STEP.pieces
    const env = { proto, limits, parts, rescues, approve, importStep: step, deadlines: { ...THREAD_DEADLINES, ...deadlines } }
    const call = createCaller(mirror)
    const route = where.pathname
    const posts = ['/_thread/append', '/_thread/import', '/_thread/retract', '/_thread/keep']
    const gets = ['/_thread/index', '/_thread/manifest', '/_thread/tail']
    if (!posts.includes(route) && !gets.includes(route)) stop(404, 'NOT_FOUND')
    if (request.method !== (posts.includes(route) ? 'POST' : 'GET')) stop(405, 'METHOD_UNAVAILABLE')
    // As the vault, a query key a route does not read, a repeated key, or any query on a
    // route that reads none (a bare `?` included) is 404, before anything else is read.
    const allowed = THREAD_QUERY[route] ?? []
    const keys = [...where.searchParams.keys()]
    if (keys.some(key => !allowed.includes(key)) || new Set(keys).size !== keys.length || (allowed.length === 0 && where.href.includes('?'))) {
      void request.body?.cancel().catch(() => {})
      stop(404, 'NOT_FOUND')
    }
    if (route === '/_thread/append') return await routeAppend(env, call, request, where)
    if (route === '/_thread/import') return await routeImport(env, call, request)
    if (route === '/_thread/retract') return await routeRetract(env, call, request)
    if (route === '/_thread/keep') return await routeKeep(env, call, request)
    if (route === '/_thread/index') return forward(await call('index', { after: where.searchParams.get('after') ?? '', limit: intParam(where, 'limit', 50) }))
    if (route === '/_thread/manifest') return forward(await call('manifest', { id: idParam(where), page: intParam(where, 'page', 0) }))
    return await routeTail(env, call, where)
  } catch (error) {
    if (error instanceof ThreadStop) return error.body.code === 'COMPARE' ? reply(503, { ok: false, code: 'THREAD_UNAVAILABLE' }) : reply(error.status, error.body)
    return reply(503, { ok: false, code: 'THREAD_UNAVAILABLE' })
  }
}

/**
 * R2 part store for one world: blobs under `w/<world>/blob/<sha256>`. Head first, write once with `onlyIf`, never delete.
 * @param {object} bucket An R2 bucket binding.
 * @param {string} world The world name in the key.
 */
export function createR2PartStore(bucket, world) {
  if (!bucket || typeof world !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(world)) throw new TypeError('THREAD_PART_STORE_INVALID')
  const key = sha => {
    if (!HEX64.test(sha)) throw new TypeError('THREAD_PART_SHA_INVALID')
    return `w/${world}/blob/${sha}`
  }
  return Object.freeze({
    async head(sha) {
      const object = await bucket.head(key(sha))
      return object ? { size: object.size } : null
    },
    async put(sha, bytes) {
      const existing = await bucket.head(key(sha))
      if (existing) return { size: existing.size, written: false }
      const object = await bucket.put(key(sha), bytes, { sha256: sha, onlyIf: new Headers({ 'if-none-match': '*' }) })
      return { size: object?.size ?? null, written: Boolean(object) }
    },
    async get(sha, { offset, length }) {
      const object = await bucket.get(key(sha), { range: { offset, length } })
      return object ? new Uint8Array(await object.arrayBuffer()) : null
    },
  })
}
