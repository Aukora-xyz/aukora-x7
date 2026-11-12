/**
 * One storage allowance for a world: vault pieces (`blob`) and thread appends (`lines`) share one total, and each kind
 * has its own allowance per UTC day. The state is one row, `world:v1:budget`:
 *   { day: 'YYYY-MM-DD' (UTC), dayBytes: { blob, lines }, totalBytes }
 * plus, for a call that names a `ref` (a vault piece's SHA-256), one small row per ref, `world:v1:budget:ref:<kind>:<ref>`:
 *   { bytes, day, state: 'reserved' | 'stored' }
 * The day rolls over by itself: a row from an earlier day counts as zero for today's allowance (the total stays).
 *
 * The `...In(tx, ...)` forms work inside a transaction the CALLER already holds; none of them opens one or takes
 * `storage` (a transaction inside a transaction is UNVERIFIED on a real Durable Object). `worldBudgetCall` is the only
 * function here that opens a transaction, exactly one, for the internal MIRROR route.
 *   check   reads and writes nothing: `{ ok: true }` or the refusal.
 *   charge  checks and counts in one transaction; a refusal writes nothing, so an append that is refused or rolled
 *           back counts nothing. With a `ref` it is once per ref: a ref already charged answers `{ ok: true }` and
 *           counts nothing more, and the ref row is written `reserved`.
 *   count   counts bytes that are ALREADY stored; it never refuses. With a `ref` it settles: a ref already charged is
 *           marked `stored` and counts nothing more; a ref never charged (or released) is counted once now.
 *   release with a `ref` only: takes a `reserved` ref's bytes off again (off the total, and off today's allowance when
 *           it was charged today) and removes its row. A `stored` ref, or none, is left as it is.
 * Refusals: over the total `{ ok:false, code:'WORLD_FULL', status:507 }`; over the day
 * `{ ok:false, code:'DAY_ALLOWANCE', status:429, retryAfterMs }` (until the next UTC midnight).
 *
 * How the vault uses it, said plainly: it charges a piece (with its hash as `ref`) BEFORE the put, so the check and
 * the count are one step in MIRROR, which serves one request at a time: concurrent uploads cannot pass one allowance
 * together, from any isolate. After a put that stored (or found the piece there) it counts with the ref, which settles
 * the reservation. After a put that failed and a `head` that does not find the piece, it releases. After a CHARGE whose
 * answer never came it releases too (no put follows). After a put whose answer never came, it keeps the reservation
 * (the bytes may still land).
 * The bounds, exactly (S = the bytes of the world's pieces in the bucket, row = `totalBytes`):
 *   MORE than stored (row > S): by the sum of |P| over the distinct pieces P whose ref row is `reserved` while no object
 *     exists, each at most one piece (2 MiB), each once (a charge is once per ref). That needs one of: a put answer lost
 *     and the put never landed; a failed put whose head-then-release did not complete; a lost charge answer whose release
 *     failed, or arrived at MIRROR before the late charge did. Reconciled ONLY by a later PUT of the same piece (its
 *     charge is a no-op, the put stores it, the count settles it): the kit's retries, or its next run while the same
 *     bytes are still in that browser. Nothing else takes such a reservation off (no sweep exists in this version).
 *   PAST the cap (row = S > cap): by at most |P| per distinct piece raced, once per piece ever: a release (failed put or
 *     lost charge) that runs after another upload of the SAME piece charged (finding the ref reserved, counting nothing)
 *     and before it settles frees the room; the room can be taken; that upload's count then counts P with no check. It
 *     needs two uploads of one piece at once: two windows, or a kit retry while her edge still runs the request the kit
 *     gave up on at its deadline. After it, every new charge is 507 until there is room.
 *   LESS than stored (row < S): by |P| when, after such a release, the storing upload's count also failed; the next PUT
 *     of that piece counts it once (the found-again path).
 */

export const WORLD_BUDGET_KEY = 'world:v1:budget'
export const WORLD_BUDGET_REF_PREFIX = 'world:v1:budget:ref:'
export const WORLD_BUDGET_OPS = Object.freeze(['check', 'charge', 'count', 'release'])
export const WORLD_BUDGET_KINDS = Object.freeze(['blob', 'lines'])
export const WORLD_BUDGET_DEFAULTS = Object.freeze({
  totalBytes: 2 * 1024 * 1024 * 1024,
  blobDayBytes: 1024 * 1024 * 1024,
  linesDayBytes: 128 * 1024 * 1024,
})
const DAY_MS = 24 * 60 * 60 * 1000

/** @param {unknown} value */
const positiveSafeInteger = value => {
  if (typeof value !== 'string' || !/^[0-9]{1,16}$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * Limits from the environment: `VAULT_MAX_BYTES` (total), `VAULT_DAY_BYTES` (blob per day), `THREAD_DAY_BYTES`
 * (lines per day), each a decimal string. Anything that is not a positive safe integer is ignored (default kept).
 * @param {Record<string, unknown> | undefined | null} env
 */
export function worldBudgetLimits(env) {
  const source = env && typeof env === 'object' ? env : {}
  return {
    totalBytes: positiveSafeInteger(source.VAULT_MAX_BYTES) ?? WORLD_BUDGET_DEFAULTS.totalBytes,
    blobDayBytes: positiveSafeInteger(source.VAULT_DAY_BYTES) ?? WORLD_BUDGET_DEFAULTS.blobDayBytes,
    linesDayBytes: positiveSafeInteger(source.THREAD_DAY_BYTES) ?? WORLD_BUDGET_DEFAULTS.linesDayBytes,
  }
}

/** @param {unknown} limits */
const resolveLimits = limits => {
  const given = limits && typeof limits === 'object' ? /** @type {Record<string, unknown>} */ (limits) : {}
  /** @param {string} name */
  const pick = name => {
    const value = given[name]
    return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0 ? /** @type {number} */ (value)
      : WORLD_BUDGET_DEFAULTS[/** @type {keyof typeof WORLD_BUDGET_DEFAULTS} */ (name)]
  }
  return { totalBytes: pick('totalBytes'), blobDayBytes: pick('blobDayBytes'), linesDayBytes: pick('linesDayBytes') }
}

/** @param {unknown} now */
const resolveNow = now => {
  const value = typeof now === 'function' ? now() : now === undefined ? Date.now() : now
  if (!Number.isFinite(value)) throw new TypeError('WORLD_BUDGET_CLOCK_INVALID')
  return /** @type {number} */ (value)
}

const REF = /^[0-9a-f]{64}$/

/** @param {{ kind?: unknown, bytes?: unknown, ref?: unknown }} input */
const validateCall = input => {
  if (!WORLD_BUDGET_KINDS.includes(/** @type {string} */ (input.kind))) throw new TypeError('WORLD_BUDGET_KIND_INVALID')
  if (!Number.isSafeInteger(input.bytes) || /** @type {number} */ (input.bytes) < 0) throw new TypeError('WORLD_BUDGET_BYTES_INVALID')
  if (input.ref !== undefined && (typeof input.ref !== 'string' || !REF.test(input.ref))) throw new TypeError('WORLD_BUDGET_REF_INVALID')
}

/**
 * The row that remembers one ref.
 * @param {string} kind @param {string} ref
 */
export const worldBudgetRefKey = (kind, ref) => `${WORLD_BUDGET_REF_PREFIX}${kind}:${ref}`

/**
 * The internal route's body, checked: `{ op, kind, bytes }` or `{ op, kind, bytes, ref }` with nothing else, or null.
 * `release` needs a ref. For MIRROR's `POST /_mirror/world/budget`.
 * @param {unknown} input
 * @returns {{ op: 'check' | 'charge' | 'count' | 'release', kind: string, bytes: number, ref?: string } | null}
 */
export function worldBudgetInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const x = /** @type {Record<string, unknown>} */ (input)
  const keys = Object.keys(x).sort().join()
  if (keys !== 'bytes,kind,op' && keys !== 'bytes,kind,op,ref') return null
  if (!WORLD_BUDGET_OPS.includes(/** @type {string} */ (x.op))) return null
  if (!WORLD_BUDGET_KINDS.includes(/** @type {string} */ (x.kind))) return null
  if (!Number.isSafeInteger(x.bytes) || /** @type {number} */ (x.bytes) < 0) return null
  if ('ref' in x && (typeof x.ref !== 'string' || !REF.test(x.ref))) return null
  if (x.op === 'release' && !('ref' in x)) return null
  return /** @type {any} */ ({ op: x.op, kind: x.kind, bytes: x.bytes, ...('ref' in x ? { ref: x.ref } : {}) })
}

/**
 * A ref's row, or null. A malformed row is an error (never silently reset).
 * @param {{ get: (key: string) => Promise<unknown> }} tx @param {string} kind @param {string} ref
 */
async function readRef(tx, kind, ref) {
  const row = await tx.get(worldBudgetRefKey(kind, ref))
  if (row === undefined || row === null) return null
  const r = /** @type {any} */ (row)
  if (typeof r !== 'object' || !isCount(r.bytes) || typeof r.day !== 'string' || (r.state !== 'reserved' && r.state !== 'stored')) {
    throw new Error('WORLD_BUDGET_ROW_INVALID')
  }
  return /** @type {{ bytes: number, day: string, state: 'reserved' | 'stored' }} */ (r)
}

/** @param {number} at */
const utcDay = at => new Date(at).toISOString().slice(0, 10)

/** @param {unknown} n */
const isCount = n => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0

/**
 * The stored row, rolled to today. A missing row is an empty one; a malformed row is an error (never silently reset).
 * @param {{ get: (key: string) => Promise<unknown> }} tx
 * @param {number} at
 */
async function readRolled(tx, at) {
  const today = utcDay(at)
  const row = await tx.get(WORLD_BUDGET_KEY)
  if (row === undefined || row === null) return { day: today, dayBytes: { blob: 0, lines: 0 }, totalBytes: 0 }
  const r = /** @type {any} */ (row)
  if (typeof r !== 'object' || typeof r.day !== 'string' || !r.dayBytes || typeof r.dayBytes !== 'object'
    || !isCount(r.dayBytes.blob) || !isCount(r.dayBytes.lines) || !isCount(r.totalBytes)) {
    throw new Error('WORLD_BUDGET_ROW_INVALID')
  }
  if (r.day !== today) return { day: today, dayBytes: { blob: 0, lines: 0 }, totalBytes: r.totalBytes }
  return { day: today, dayBytes: { blob: r.dayBytes.blob, lines: r.dayBytes.lines }, totalBytes: r.totalBytes }
}

/**
 * @param {{ dayBytes: { blob: number, lines: number }, totalBytes: number }} row
 * @param {string} kind
 * @param {number} bytes
 * @param {number} at
 * @param {{ totalBytes: number, blobDayBytes: number, linesDayBytes: number }} limits
 */
function decide(row, kind, bytes, at, limits) {
  if (row.totalBytes + bytes > limits.totalBytes) return { ok: false, code: 'WORLD_FULL', status: 507 }
  const dayLimit = kind === 'blob' ? limits.blobDayBytes : limits.linesDayBytes
  const used = kind === 'blob' ? row.dayBytes.blob : row.dayBytes.lines
  if (used + bytes > dayLimit) {
    const nextMidnight = (Math.floor(at / DAY_MS) + 1) * DAY_MS
    return { ok: false, code: 'DAY_ALLOWANCE', status: 429, retryAfterMs: Math.max(1, nextMidnight - at) }
  }
  return { ok: true }
}

/**
 * @param {{ day: string, dayBytes: { blob: number, lines: number }, totalBytes: number }} row
 * @param {string} kind
 * @param {number} bytes
 */
const added = (row, kind, bytes) => ({
  day: row.day,
  dayBytes: { blob: row.dayBytes.blob + (kind === 'blob' ? bytes : 0), lines: row.dayBytes.lines + (kind === 'lines' ? bytes : 0) },
  totalBytes: row.totalBytes + bytes,
})

/**
 * Reads the row and answers; writes nothing.
 * @param {{ get: (key: string) => Promise<unknown> }} tx
 * @param {{ kind: string, bytes: number, now?: number | (() => number), limits?: object }} input
 */
export async function checkWorldBudgetIn(tx, { kind, bytes, now, limits }) {
  validateCall({ kind, bytes })
  const at = resolveNow(now)
  const row = await readRolled(tx, at)
  return decide(row, kind, bytes, at, resolveLimits(limits))
}

/**
 * Checks and counts inside the caller's open transaction. A refusal writes nothing. With a ref: once per ref.
 * @param {{ get: (key: string) => Promise<unknown>, put: (key: string, value: unknown) => Promise<unknown> }} tx
 * @param {{ kind: string, bytes: number, ref?: string, now?: number | (() => number), limits?: object }} input
 */
export async function chargeWorldBudgetIn(tx, { kind, bytes, ref, now, limits }) {
  validateCall({ kind, bytes, ref })
  const at = resolveNow(now)
  if (ref !== undefined && await readRef(tx, kind, ref)) return { ok: true }
  const row = await readRolled(tx, at)
  const verdict = decide(row, kind, bytes, at, resolveLimits(limits))
  if (!verdict.ok) return verdict
  await tx.put(WORLD_BUDGET_KEY, added(row, kind, bytes))
  if (ref !== undefined) await tx.put(worldBudgetRefKey(kind, ref), { bytes, day: row.day, state: 'reserved' })
  return { ok: true }
}

/**
 * Counts bytes that are already stored. Never refuses (a total past its limit only makes later checks refuse).
 * With a ref: settles it (a charged ref counts nothing more; an unknown ref is counted once).
 * @param {{ get: (key: string) => Promise<unknown>, put: (key: string, value: unknown) => Promise<unknown> }} tx
 * @param {{ kind: string, bytes: number, ref?: string, now?: number | (() => number), limits?: object }} input
 */
export async function countWorldBudgetIn(tx, { kind, bytes, ref, now }) {
  validateCall({ kind, bytes, ref })
  const at = resolveNow(now)
  if (ref !== undefined) {
    const held = await readRef(tx, kind, ref)
    if (held) {
      if (held.state !== 'stored') await tx.put(worldBudgetRefKey(kind, ref), { ...held, state: 'stored' })
      return { ok: true }
    }
  }
  const row = await readRolled(tx, at)
  await tx.put(WORLD_BUDGET_KEY, added(row, kind, bytes))
  if (ref !== undefined) await tx.put(worldBudgetRefKey(kind, ref), { bytes, day: row.day, state: 'stored' })
  return { ok: true }
}

/**
 * Takes a still-reserved ref's bytes off again and removes its row. A stored ref, or none, is left as it is.
 * @param {{ get: (key: string) => Promise<unknown>, put: (key: string, value: unknown) => Promise<unknown>, delete: (key: string) => Promise<unknown> }} tx
 * @param {{ kind: string, bytes: number, ref?: string, now?: number | (() => number), limits?: object }} input
 */
export async function releaseWorldBudgetIn(tx, { kind, bytes, ref, now }) {
  validateCall({ kind, bytes, ref })
  if (ref === undefined) throw new TypeError('WORLD_BUDGET_REF_INVALID')
  const at = resolveNow(now)
  const held = await readRef(tx, kind, ref)
  if (!held || held.state !== 'reserved') return { ok: true }
  const row = await readRolled(tx, at)
  const sameDay = held.day === row.day
  const day = kind === 'blob' ? row.dayBytes.blob : row.dayBytes.lines
  const dayLeft = sameDay ? Math.max(0, day - held.bytes) : day
  await tx.put(WORLD_BUDGET_KEY, {
    day: row.day,
    dayBytes: { blob: kind === 'blob' ? dayLeft : row.dayBytes.blob, lines: kind === 'lines' ? dayLeft : row.dayBytes.lines },
    totalBytes: Math.max(0, row.totalBytes - held.bytes),
  })
  await tx.delete(worldBudgetRefKey(kind, ref))
  return { ok: true }
}

/**
 * The one entry that opens a transaction (exactly one `storage.transaction`), for the internal MIRROR route.
 * @param {{ transaction: (fn: (tx: any) => Promise<unknown>) => Promise<unknown> }} storage
 * @param {{ op: 'check' | 'charge' | 'count' | 'release', kind: string, bytes: number, ref?: string, now?: number | (() => number), limits?: object }} input
 */
export async function worldBudgetCall(storage, { op, kind, bytes, ref, now, limits }) {
  const run = op === 'check' ? checkWorldBudgetIn : op === 'charge' ? chargeWorldBudgetIn : op === 'count' ? countWorldBudgetIn
    : op === 'release' ? releaseWorldBudgetIn : null
  if (!run) throw new TypeError('WORLD_BUDGET_OP_INVALID')
  validateCall({ kind, bytes, ref })
  if (op === 'release' && ref === undefined) throw new TypeError('WORLD_BUDGET_REF_INVALID')
  return storage.transaction(tx => run(tx, { kind, bytes, ref, now, limits }))
}
