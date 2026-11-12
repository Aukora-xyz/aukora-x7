/**
 * In-memory fakes for the vault (exports only, no test here). A later job imports them to run the rescue kit against
 * the real handler: `createVaultBucket` (an R2 bucket that stores BYTES, honours `onlyIf` given as Headers and records
 * every call in order), `createRollbackStorage` (a Durable Object storage whose `transaction` really rolls back when its
 * closure throws), `createVaultBudget` (the real world budget over that storage, recording calls) and `createVaultFetch`
 * (a `fetch` that sends same-origin requests to `handleVaultRequest`).
 */
import { handleVaultRequest } from '../vault.mjs'
import { worldBudgetCall } from '../world-budget.mjs'

/** Every bucket made here, so a suite can check that none was ever asked to delete or overwrite. */
export const allVaultBuckets = []

/** @param {Uint8Array | ArrayBuffer} bytes */
export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** @param {unknown} value */
const toBytes = value => {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  throw new TypeError('fake bucket: unsupported value')
}

/** @param {Uint8Array} bytes */
const bodyOf = bytes => new ReadableStream({ start(controller) { if (bytes.byteLength) controller.enqueue(new Uint8Array(bytes)); controller.close() } })

/**
 * @param {{ intercept?: Record<string, (key: string, ...rest: unknown[]) => unknown> }} [options]
 * `intercept[op]` runs after the call is recorded and before the fake acts: it may throw, wait, or return
 * `{ override: value }` to answer in place of the fake (the fake then does nothing).
 */
export function createVaultBucket({ intercept = {} } = {}) {
  /** @type {Map<string, { bytes: Uint8Array, customMetadata: Record<string, string>, httpMetadata: unknown, uploaded: Date }>} */
  const objects = new Map()
  /** @type {Array<{ op: string, key?: string, options?: unknown }>} */
  const calls = []
  /** @type {Map<string, number>} */
  const writes = new Map()
  const stats = { overwrites: 0, refusedByCondition: 0 }
  /** @param {string} key @param {{ bytes: Uint8Array, customMetadata: Record<string, string> }} entry */
  const meta = (key, entry) => ({ key, size: entry.bytes.byteLength, etag: `e-${key.length}-${entry.bytes.byteLength}`, customMetadata: { ...entry.customMetadata }, uploaded: new Date(0) })
  /** @param {string} op @param {string | undefined} key @param {unknown[]} rest */
  const hook = async (op, key, rest) => {
    const fn = intercept[op]
    if (typeof fn !== 'function') return null
    return (await fn(key ?? '', ...rest)) ?? null
  }
  const bucket = {
    objects, calls, writes, stats, intercept,
    /** @param {string} key @param {unknown} value @param {any} [options] */
    async put(key, value, options = {}) {
      calls.push({ op: 'put', key, options })
      const hooked = await hook('put', key, [value, options])
      if (hooked && 'override' in hooked) return hooked.override
      const bytes = toBytes(value)
      const onlyIf = options.onlyIf
      if (onlyIf instanceof Headers && onlyIf.get('if-none-match') === '*' && objects.has(key)) {
        stats.refusedByCondition += 1
        return null
      }
      if (typeof options.sha256 === 'string' && options.sha256 !== await sha256Hex(bytes)) throw new Error('fake bucket: sha256 mismatch')
      if (objects.has(key)) stats.overwrites += 1
      const entry = { bytes, customMetadata: { ...(options.customMetadata ?? {}) }, httpMetadata: options.httpMetadata ?? {}, uploaded: new Date(0) }
      objects.set(key, entry)
      writes.set(key, (writes.get(key) ?? 0) + 1)
      return meta(key, entry)
    },
    /** @param {string} key */
    async head(key) {
      calls.push({ op: 'head', key })
      const hooked = await hook('head', key, [])
      if (hooked && 'override' in hooked) return hooked.override
      const entry = objects.get(key)
      return entry ? meta(key, entry) : null
    },
    /** @param {string} key */
    async get(key) {
      calls.push({ op: 'get', key })
      const hooked = await hook('get', key, [])
      if (hooked && 'override' in hooked) return hooked.override
      const entry = objects.get(key)
      if (!entry) return null
      const bytes = new Uint8Array(entry.bytes)
      return {
        ...meta(key, entry),
        body: bodyOf(bytes),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      }
    },
    /** @param {{ prefix?: string, limit?: number, include?: string[] }} [options] */
    async list(options = {}) {
      calls.push({ op: 'list', options })
      const hooked = await hook('list', options.prefix, [options])
      if (hooked && 'override' in hooked) return hooked.override
      const prefix = options.prefix ?? ''
      const limit = Math.min(1000, options.limit ?? 1000)
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort()
      const page = keys.slice(0, limit)
      const withMeta = Array.isArray(options.include) && options.include.includes('customMetadata')
      return {
        objects: page.map(key => {
          const entry = /** @type {{ bytes: Uint8Array, customMetadata: Record<string, string> }} */ (objects.get(key))
          const out = meta(key, entry)
          if (!withMeta) delete /** @type {any} */ (out).customMetadata
          return out
        }),
        truncated: keys.length > limit,
        cursor: keys.length > limit ? String(limit) : undefined,
        delimitedPrefixes: [],
      }
    },
    /** @param {string | string[]} key */
    async delete(key) {
      calls.push({ op: 'delete', key: String(key) })
      for (const k of Array.isArray(key) ? key : [key]) objects.delete(k)
    },
  }
  allVaultBuckets.push(bucket)
  return bucket
}

/** A Durable Object storage whose `transaction` commits only when its closure returns, and rolls back when it throws. */
export function createRollbackStorage() {
  let data = new Map()
  let transactions = 0
  /** @param {Map<string, unknown>} map */
  const viewOf = map => ({
    get: async (/** @type {string} */ key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
    put: async (/** @type {string} */ key, /** @type {unknown} */ value) => { map.set(key, structuredClone(value)) },
    delete: async (/** @type {string} */ key) => map.delete(key),
  })
  const storage = {
    ...viewOf(data),
    /** @template T @param {(tx: ReturnType<typeof viewOf>) => Promise<T>} fn */
    async transaction(fn) {
      transactions += 1
      const staged = new Map([...data].map(([k, v]) => [k, structuredClone(v)]))
      const result = await fn(viewOf(staged))
      data = staged
      Object.assign(storage, viewOf(data))
      return result
    },
    transactions: () => transactions,
    snapshot: () => Object.fromEntries([...data].map(([k, v]) => [k, structuredClone(v)])),
  }
  return storage
}

/**
 * The real world budget (world-budget.mjs) over a rollback storage, shaped as the vault's `{ charge, count, release }`
 * (and `check`, which the vault no longer calls). Calls run ONE AT A TIME, as MIRROR serves them: its `handleRequest`
 * chains every request on `this.queue` (SOURCE mirror-do.mjs `handleRequest`, the internal budget route included).
 * @param {{ storage?: ReturnType<typeof createRollbackStorage>, limits?: object, now?: () => number }} [options]
 */
export function createVaultBudget({ storage = createRollbackStorage(), limits, now = () => Date.now() } = {}) {
  /** @type {Array<{ op: string, kind: string, bytes: number, ref?: string }>} */
  const calls = []
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve()
  /** @param {'check' | 'charge' | 'count' | 'release'} op @param {{ kind: string, bytes: number, ref?: string }} input */
  const ask = (op, { kind, bytes, ref }) => {
    calls.push({ op, kind, bytes, ...(ref === undefined ? {} : { ref }) })
    const answer = queue.then(() => worldBudgetCall(storage, { op, kind, bytes, ...(ref === undefined ? {} : { ref }), now: now(), limits }))
    queue = answer.catch(() => {})
    return answer
  }
  return {
    storage, calls,
    /** @param {{ kind: string, bytes: number, ref?: string }} input */
    check: input => ask('check', input),
    /** @param {{ kind: string, bytes: number, ref?: string }} input */
    charge: input => ask('charge', input),
    /** @param {{ kind: string, bytes: number, ref?: string }} input */
    count: input => ask('count', input),
    /** @param {{ kind: string, bytes: number, ref?: string }} input */
    release: input => ask('release', input),
  }
}

/**
 * A `fetch` that sends every call to `handleVaultRequest` as a same-origin browser request.
 * @param {{ bucket?: unknown, budget?: unknown, world?: string, ready?: boolean, env?: Record<string, unknown>,
 *   now?: () => number, deadlines?: object, limits?: object, origin?: string, log?: (m: string, d?: unknown) => void }} [options]
 */
export function createVaultFetch({ bucket = createVaultBucket(), budget = createVaultBudget(), world = 'node-main-v1', ready = true, env = {},
  now, deadlines, limits, origin = 'https://x61.example.invalid', log = () => {} } = {}) {
  /** @param {string | URL | Request} input @param {RequestInit} [init] */
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin)
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('sec-fetch-site', 'same-origin')
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const body = init.body ?? null
    const request = new Request(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? null : body, ...(body && typeof body === 'object' && 'getReader' in body ? { duplex: 'half' } : {}) })
    return handleVaultRequest({ request, url, env: { ARCHIVE_BUCKET: bucket, ...env }, world, ready, budget: /** @type {any} */ (budget), now, deadlines, limits, log })
  }
}

/**
 * Build a rescue index the way the kit does (rows sorted by key; the row rule), with its pieces.
 * @param {{ piece: number, rows: Array<{ key: string, type: string, bytes?: Uint8Array }>, source?: string, clientId?: string | null }} input
 */
export async function buildRescue({ piece, rows, source = 'memory', clientId = null }) {
  /** @type {Map<string, Uint8Array>} */
  const pieces = new Map()
  const out = []
  for (const row of [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (row.type === 'dir' || row.type === 'gone') { out.push({ key: row.key, type: row.type, bytes: 0, sha256: null, pieces: [] }); continue }
    const bytes = row.bytes ?? new Uint8Array(0)
    const names = []
    for (let at = 0; at < bytes.byteLength; at += piece) {
      const part = bytes.slice(at, at + piece)
      const name = await sha256Hex(part)
      pieces.set(name, part)
      names.push(name)
    }
    out.push({ key: row.key, type: row.type, bytes: bytes.byteLength, sha256: await sha256Hex(bytes), pieces: names })
  }
  const index = { v: 1, piece, source, client: { clientId, base: null, reconciliation: null }, rows: out, skipped: [], totals: { threads: 0, homeFiles: out.filter(r => r.type === 'file').length, bytes: out.reduce((s, r) => s + r.bytes, 0) } }
  const indexBytes = new TextEncoder().encode(JSON.stringify(index))
  const id = (await sha256Hex(indexBytes)).slice(0, 32)
  return { index, indexBytes, id, pieces }
}
