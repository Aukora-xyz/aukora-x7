/**
 * The dry run on a large store.
 *
 * The fixture is WRITTEN BY TODAY'S CODE: `idb-persist.ts` as it stood on main at an earlier commit, vendored unchanged except its
 * three import paths (reconcile-fixtures/idb-persist.before-rebase.ts), driving the REAL edge code (`MirrorDO`, `bootstrapMirror`,
 * `publishMirror`, `appendMirrorWakeCheckpoint`, all from deploy/cloudflare/src/mirror-do.mjs) on in-memory Durable Object
 * storage. Every request of her tab reaches the real `MirrorDO.fetch` with the internal mark the Worker adds.
 *   F1 the cloud: a seed of about 420 files and 17 session journals (revision 1).
 *   F1b an earlier browser and two wake checkpoints move the cloud to 2060 (each publish through the real publishMirror).
 *   F2 her tab fresh-boots (old code), imports the snapshot, then makes 23 saves, each delivered for real: in step at 2083.
 *   F3 three variants to 2090: `wake` (seven wake checkpoints); `phone` (a second old-code browser fresh-boots and saves
 *      cordis.yml, an organ file, LATEST.json and one steps.jsonl frame, then three checkpoints); `phone-overlap` (as phone,
 *      plus a note her tab edits later, then two checkpoints).
 *   F4 her tab keeps working: her next save is refused for real (409, a retained conflict) and she is held; then 3,200 held
 *      local saves (small files, new files, steps.jsonl, LATEST.json, her notes) and two session journals grown to 24 MiB
 *      plus one byte (one the cloud holds an older small copy of, one it never saw). The refused batch is then posted, as
 *      her tab posted it, to the two phone variants' clouds too (her rows do not depend on which cloud refused it).
 *   F4b the 1,700 credentials-temp deletion rows and 1,700 reset rows, INJECTED directly in their old-old shape.
 *   F5 freeze: a deep copy of her IndexedDB map and of each variant's DO storage map.
 * From each frozen pair, OLD (the vendored code) and NEW (this branch) boot through worker-host's order: image (a stand-in),
 * attachIdbPersistence, bootThreadSyncIfOn, prepareProfile's one write (cordis.yml), mountX6BallRuntime; then the resync
 * settles. EVERY IndexedDB key and EVERY edge storage key is compared.
 *
 * KNOWN GAPS between this fixture and her real store:
 *  - the image is a stand-in (two directories), not her real seed image; prepareProfile is its one write, not the call;
 *  - OLD is an earlier main's idb-persist.ts, not verified to be byte-equal to the build live in her tab; ball-loader.ts is
 *    today's in both boots (this lane did not change it);
 *  - the fixture's saves go through the storage layer (vfs writes and flush), not through her organs or a model turn;
 *  - the phone's writes are section 2's list done by hand on a real old-code storage layer, not a booted phone app;
 *  - her real main journal is about 100 MB; here two journals of 24 MiB plus one byte; her real store has about 250 files
 *    under /dsh/home/auma and her real queue/meta/marker numbers are read from her, not known here;
 *  - the page origin ends in `.invalid`, so the runtime's boot catch-up (GitHub notes sync, retro receipts) does not run;
 *  - a single-file tombstone this browser recorded is carried out at her cloud, with the cloud's bytes kept as a backup
 *    row and named in the rebase record; a deletion no tombstone explains, and every reset root, still
 *    makes `chrome-wins` refuse, REBASE_DELETION_UNSUPPORTED, by name;
 *  - the Worker layer (sign-in, the route's own query check) is not in this loop: requests enter at MirrorDO.fetch.
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MemoryVfs as MemoryVfsType } from '../../src/storage/memory.ts'

type Json = Record<string, unknown>
type Persist = typeof import('../../src/storage/idb-persist.ts')
const PERSIST = '../../src/storage/idb-persist.ts'
const OLD_PERSIST = './reconcile-fixtures/idb-persist.before-rebase.ts'
const edgeModule = async (relative: string): Promise<Json> =>
  await import(new URL(`../../../../../deploy/cloudflare/src/${relative}`, import.meta.url).href) as Json
interface Storage {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; limit?: number }): Promise<Map<string, unknown>>
  transaction<T>(operation: (tx: Storage) => Promise<T>): Promise<T>
}
interface Mirror { fetch(request: Request): Promise<Response> }
interface Edge {
  MirrorDO: new (state: { storage: Storage }, env: Json) => Mirror
  bootstrapMirror(storage: Storage, input: Json): Promise<Json>
  publishMirror(storage: Storage, envelope: Json): Promise<Json>
  appendMirrorWakeCheckpoint(storage: Storage, input: Json, options: Json): Promise<Json>
  mirrorDigest(value: unknown): Promise<string>
  canonicalBootstrap(value: unknown): string
  digest(value: string): Promise<string>
}
const E = Object.assign({}, ...await Promise.all(['mirror-do.mjs', 'head-do.mjs'].map(edgeModule))) as Edge

// ---------------------------------------------------------------------------------------------------------------------
// The browser's IndexedDB stand-in (copied from large-store-boot.spec.ts: a spec cannot import a spec), with setImmediate
// for the task turn and one test seam: `failPut` aborts the transaction of a put whose key it names (the crash case).
// ---------------------------------------------------------------------------------------------------------------------
class FakeRequest<T = unknown> {
  result!: T
  succeed(value: T): void { this.result = value; this.onsuccess?.() }
  error: Error | null = null
  transaction: FakeTx | null = null
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  onupgradeneeded: ((event: { oldVersion: number }) => void) | null = null
  onblocked: (() => void) | null = null
}
interface FakeRange { lower: string; upper: string }
const inRange = (key: string, range?: FakeRange): boolean => range === undefined || (key >= range.lower && key <= range.upper)
class FakeDb {
  data = new Map<string, unknown>()
  queue: FakeTx[] = []
  failPut: ((key: string) => boolean) | null = null
  /** voice-marks.ts opens its own database (never hers) and asks this during its upgrade. */
  readonly objectStoreNames = { contains: (_name: string): boolean => false }
  onversionchange: (() => void) | null = null
  onclose: (() => void) | null = null
  transaction(_store: string, mode: 'readonly' | 'readwrite' = 'readonly'): FakeTx {
    const tx = new FakeTx(this, mode)
    this.queue.push(tx); this.pump()
    return tx
  }
  pump(): void {
    this.queue = this.queue.filter(tx => !tx.finished)
    for (const [index, tx] of this.queue.entries()) {
      if (tx.started) continue
      const earlier = this.queue.slice(0, index)
      if (earlier.length === 0 || (tx.mode === 'readonly' && earlier.every(other => other.mode === 'readonly'))) tx.start()
    }
  }
  close(): void {}
  createObjectStore(): FakeStore { return new FakeStore(null, this) }
}
class FakeTx {
  started = false
  finished = false
  pending = 0
  working = new Map<string, unknown>()
  ops: Array<() => void> = []
  error: Error | null = null
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor(readonly db: FakeDb, readonly mode: 'readonly' | 'readwrite') {}
  objectStore(): FakeStore { return new FakeStore(this, this.db) }
  start(): void {
    this.started = true
    this.working = new Map(this.db.data)
    const ops = this.ops; this.ops = []
    for (const op of ops) op()
    this.settle()
  }
  run<T>(work: (data: Map<string, unknown>) => T): FakeRequest<T> {
    const req = new FakeRequest<T>()
    if (this.finished) throw new Error('TransactionInactiveError')
    this.pending += 1
    const op = (): void => {
      setImmediate(() => {
        this.pending -= 1
        if (this.finished) return
        try { req.result = work(this.working); req.onsuccess?.() }
        catch (error) { req.error = error as Error; req.onerror?.(); this.abort() }
        this.settle()
      })
    }
    if (this.started) op(); else this.ops.push(op)
    return req
  }
  settle(): void {
    setImmediate(() => {
      if (this.finished || this.pending > 0 || this.ops.length > 0) return
      this.finished = true
      if (this.mode === 'readwrite') this.db.data = this.working
      this.oncomplete?.(); this.db.pump()
    })
  }
  abort(): void {
    if (this.finished) return
    this.finished = true
    this.error = new Error('AbortError')
    setImmediate(() => { this.onabort?.(); this.db.pump() })
  }
}
class FakeCursor {
  constructor(readonly key: string, readonly value: unknown, readonly next: () => void) {}
  continue(): void { this.next() }
}
class FakeStore {
  constructor(readonly tx: FakeTx | null, readonly db: FakeDb) {}
  private exec<T>(work: (data: Map<string, unknown>) => T): FakeRequest<T> {
    if (this.tx === null) { const req = new FakeRequest<T>(); req.result = work(this.db.data); return req }
    return this.tx.run(work)
  }
  private sorted(data: Map<string, unknown>, range?: FakeRange): string[] {
    return [...data.keys()].filter(key => inRange(key, range)).sort()
  }
  get(key: string) { return this.exec(data => (data.has(key) ? structuredClone(data.get(key)) : undefined)) }
  put(value: unknown, key: string) {
    return this.exec((data) => {
      if (this.db.failPut?.(key) === true) throw new Error(`INJECTED_CRASH at ${key}`)
      data.set(key, structuredClone(value)); return key
    })
  }
  delete(key: string) { return this.exec((data) => { data.delete(key) }) }
  getAll(range?: FakeRange, count?: number) {
    return this.exec(data => this.sorted(data, range).slice(0, count ?? Infinity).map(key => structuredClone(data.get(key))))
  }
  getAllKeys(range?: FakeRange) { return this.exec(data => this.sorted(data, range)) }
  count(range?: FakeRange) { return this.exec(data => this.sorted(data, range).length) }
  openCursor(range?: FakeRange): FakeRequest<FakeCursor | null> {
    const tx = this.tx
    if (tx === null) throw new Error('cursor outside a transaction')
    const req = new FakeRequest<FakeCursor | null>()
    let keys: string[] | null = null
    let index = 0
    const advance = (): void => {
      const inner = tx.run((data) => {
        keys ??= this.sorted(data, range)
        const key = keys[index]
        index += 1
        return key === undefined ? null : new FakeCursor(key, structuredClone(data.get(key)), advance)
      })
      inner.onsuccess = () => { req.result = inner.result; req.onsuccess?.() }
      inner.onerror = () => { req.error = inner.error; req.onerror?.() }
    }
    advance()
    return req
  }
}
class FakeIndexedDb {
  readonly dbs = new Map<string, FakeDb>()
  open(name: string, version: number): FakeRequest<FakeDb> {
    const req = new FakeRequest<FakeDb>()
    setImmediate(() => {
      let db = this.dbs.get(name)
      const oldVersion = db === undefined ? 0 : version
      if (db === undefined) { db = new FakeDb(); this.dbs.set(name, db) }
      req.result = db
      if (oldVersion < version) { req.transaction = null; req.onupgradeneeded?.({ oldVersion }) }
      req.onsuccess?.()
    })
    return req
  }
}
const FakeKeyRange = { bound: (lower: string, upper: string): FakeRange => ({ lower, upper }) }

// ---------------------------------------------------------------------------------------------------------------------
// Durable Object storage in memory: transactions see their own writes and commit them all at once, or none on a throw.
// ---------------------------------------------------------------------------------------------------------------------
const GONE = Symbol('gone')
function memoryStorage(initial: Map<string, unknown> = new Map()) {
  const rows = initial
  let tail: Promise<unknown> = Promise.resolve()
  const listOf = (read: (key: string) => unknown, keys: Iterable<string>, { prefix = '', limit = Infinity } = {}): Map<string, unknown> => {
    const out = new Map<string, unknown>()
    for (const key of [...new Set(keys)].filter(key => key.startsWith(prefix)).sort()) {
      if (out.size >= limit) break
      const value = read(key)
      if (value !== undefined) out.set(key, structuredClone(value))
    }
    return out
  }
  const storage: Storage = {
    get: async key => structuredClone(rows.get(key)),
    put: async (key, value) => { rows.set(key, structuredClone(value)) },
    delete: async (key) => { rows.delete(key) },
    list: async options => listOf(key => rows.get(key), rows.keys(), options),
    transaction<T>(operation: (tx: Storage) => Promise<T>): Promise<T> {
      const result = tail.then(async () => {
        const overlay = new Map<string, unknown>()
        const read = (key: string): unknown => {
          if (!overlay.has(key)) return rows.get(key)
          const value = overlay.get(key)
          return value === GONE ? undefined : value
        }
        const view: Storage = {
          get: async key => structuredClone(read(key)),
          put: async (key, value) => { overlay.set(key, structuredClone(value)) },
          delete: async (key) => { overlay.set(key, GONE) },
          list: async options => listOf(read, [...rows.keys(), ...overlay.keys()], options),
          transaction: async () => { throw new Error('nested transaction') },
        }
        const value = await operation(view)
        for (const [key, next] of overlay) { if (next === GONE) rows.delete(key); else rows.set(key, next) }
        return value
      })
      tail = result.catch(() => {})
      return result
    },
  }
  return { storage, rows: () => rows }
}
type DoStore = ReturnType<typeof memoryStorage>
const cloneRows = (rows: ReadonlyMap<string, unknown>): Map<string, unknown> =>
  new Map([...rows].map(([key, value]) => [key, structuredClone(value)]))

// ---------------------------------------------------------------------------------------------------------------------
// Her store's shape.
// ---------------------------------------------------------------------------------------------------------------------
const ORIGIN = 'https://x61-reconcile.invalid'
const SEED = 'a1'.repeat(32), BALL = 'b2'.repeat(32)
const ROOTS = ['/dsh/home', '/dsh/workspace']
const FAST = { read: { backoffMs: [0, 0], idleMs: 2_000, sleep: async () => {} }, resync: { firstMs: 20, maxMs: 80 } }
const EARLY = 'e0e0e0e0-1111-4222-8333-444455556666'
const CHECKPOINT = '/dsh/home/auma/seed/cloud-wake-checkpoints.v1.jsonl'
const STEPS = '/dsh/home/auma/wake/steps.jsonl'
const LATEST = '/dsh/home/auma/snapshots/LATEST.json'
const CORDIS = '/dsh/home/profiles/default/cordis.yml'
const OVERLAP_NOTE = '/dsh/home/auma/notes/note-007.md'
const JOURNAL_A = '/dsh/home/sessions/--dsh-home-auma--/session-main/session.v4.jsonl'
const JOURNAL_B = '/dsh/home/sessions/--dsh-home-auma--/session-held/session.v4.jsonl'
const BIG = 24 * 1024 * 1024 + 1
const ORGAN_CODE = 'module.exports = { apply() {} }; // an organ a phone wrote\n'
const META_KEY = '@x6-mirror-meta', CONTENT_KEY = '@x6-content-revision', RECONCILE_KEY = '@x6-cloud-reconciliation'
const RESET_PREFIX = '@x6-vfs-reset:', BATCH_PREFIX = '@x6-mirror-batch:', REBASE_PREFIX = '@x6-rebase:'
const HELD_SAVES = 3_200
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })

function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const ALPHABET = text('abcdefghijklmnopqrstuvwxyz0123456789 ')
/** JSONL lines of `size` bytes in all, each a whole line, content from `seed` (large-store-boot.spec.ts `jsonl`). */
function jsonl(size: number, seed: number, lineBytes = 128): Uint8Array {
  const out = new Uint8Array(size), next = prng(seed)
  let at = 0, line = 0
  while (at < size) {
    const remaining = size - at
    const length = remaining < 2 * lineBytes ? remaining : lineBytes
    const head = text(`{"i":${String(line).padStart(8, '0')},"k":"turn","p":"`), tail = text('"}\n')
    out.set(head, at)
    const bodyEnd = at + length - tail.length
    for (let index = at + head.length; index < bodyEnd; index += 1) out[index] = ALPHABET[Math.floor(next() * ALPHABET.length)] ?? 0x61
    out.set(tail, bodyEnd)
    at += length; line += 1
  }
  return out
}
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const wireFile = (bytes: Uint8Array, mtimeMs: number, mode = 0o644): Json => ({ kind: 'file', mode, mtimeMs, b64: b64(bytes) })

/** F1: the seed inventory, sorted, with its own directories. */
function seedInventory(): Array<[string, Json]> {
  const entries = new Map<string, Json>()
  const dir = (path: string): void => { entries.set(path, { kind: 'dir', mode: 0o755 }) }
  const put = (path: string, bytes: Uint8Array, at: number): void => {
    for (let parent = path.slice(0, path.lastIndexOf('/')); parent.split('/').length > 3; parent = parent.slice(0, parent.lastIndexOf('/'))) dir(parent)
    entries.set(path, wireFile(bytes, at))
  }
  const T = 1_762_000_000_000
  put('/dsh/home/auma/HANDOFF.md', jsonl(9_000, 1), T); put('/dsh/home/auma/WISH.md', jsonl(800, 2), T)
  for (const [sub, count, ext] of [['notes', 90, 'md'], ['memory', 80, 'json'], ['pearl', 60, 'json'], ['work', 60, 'md'], ['aura', 60, 'json']] as const) {
    for (let index = 0; index < count; index += 1) put(`/dsh/home/auma/${sub}/${sub === 'notes' ? 'note' : 'item'}-${String(index).padStart(3, '0')}.${ext}`, jsonl(200 + (index % 17) * 31, 1_000 + index * 7 + sub.length, 100), T + index)
  }
  for (let index = 0; index < 20; index += 1) put(`/dsh/home/auma/seed/organs/item-${String(index).padStart(3, '0')}.json`, jsonl(300, 3_000 + index, 100), T)
  put('/dsh/home/auma/seed/receipts.v3.jsonl', jsonl(9_000, 21), T); put('/dsh/home/auma/seed/checkpoints.v1.jsonl', jsonl(5_000, 22), T)
  put(STEPS, jsonl(150 * 128, 23), T); put(LATEST, text('{"snapshotId":"seed","createdAt":1}\n'), T); put(CORDIS, text('[]\n'), T)
  put(JOURNAL_A, jsonl(40_000, 7), T)
  for (let index = 0; index < 16; index += 1) put(`/dsh/home/sessions/--dsh-home-auma-one--/session-${String(index).padStart(2, '0')}/session.v4.jsonl`, jsonl(2_000 + index * 997, 100 + index), T + index)
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

let wakeNumber = 0
/** One real wake checkpoint (the cloud's own writer). */
async function wake(store: DoStore): Promise<Json> {
  wakeNumber += 1
  return await E.appendMirrorWakeCheckpoint(store.storage, { at: 1_762_950_000_000 + wakeNumber * 1000, id: sha(`wake-${String(wakeNumber)}`),
    head: { ballId: BALL, epoch: 80 }, evidence: [{ tool: 'readMirrorText', digest: sha(`evidence-${String(wakeNumber)}`) }] }, { seedId: SEED })
}
const fenceOf = (store: DoStore): { lineageId: string; revision: number } => store.rows().get('mirror:v2:global-fence') as { lineageId: string; revision: number }

// ---------------------------------------------------------------------------------------------------------------------
// Her tab's fetch: every same-origin request goes to the real MirrorDO with the Worker's internal mark, or to a small HEAD.
// ---------------------------------------------------------------------------------------------------------------------
interface Seen { method: string; path: string; status: number }
const head = (() => {
  const code = 'module.exports = { apply() {} }; // reconcile dry-run organ'
  const codeSha = sha(code)
  const entry = { id: 'organ-a', specifier: `ball:${codeSha}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 }
  const draft = { version: 'x6.1-ball/v1', ballId: '', parentBallId: null, epoch: 7, createdAt: 1000, authorPeerId: 'fixture-author',
    entries: { 'organ-a': entry }, modules: { [codeSha]: { sha256: codeSha, specifier: `ball:${codeSha}`, name: 'organ-a', description: 'Synthetic', size: Buffer.byteLength(code), createdAt: 1000 } } }
  const ballId = sha(JSON.stringify({ version: draft.version, parentBallId: draft.parentBallId, epoch: draft.epoch,
    entries: [entry], modules: [draft.modules[codeSha]] }))
  return { ball: { ...draft, ballId }, codeBySha: { [codeSha]: code } }
})()
const router = { store: null as DoStore | null, mode: 'off', seen: [] as Seen[], beforeDelta: null as (() => Promise<void>) | null }
async function edgeFetch(resource: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(resource, init), url = new URL(request.url)
  if (url.origin !== ORIGIN) throw new Error('External network is forbidden')
  const store = router.store
  if (store === null) throw new TypeError('no cloud in this fixture step')
  let response: Response
  if (url.pathname.startsWith('/_mirror/') || url.pathname === '/api/snapshot') {
    if (request.method === 'POST' && url.pathname === '/_mirror/delta' && router.beforeDelta) { const hook = router.beforeDelta; router.beforeDelta = null; await hook() }
    const headers = new Headers(request.headers)
    headers.set('x-x6-internal-authorized', '1'); headers.set('x-x6-bootstrap-seed', SEED)
    const init: RequestInit = { method: request.method, headers }
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer()
    response = await new E.MirrorDO({ storage: store.storage }, router.mode === 'off' ? {} : { MIRROR_REBASE: router.mode })
      .fetch(new Request(`https://x61.internal${url.pathname}${url.search}`, init))
  } else if (url.pathname === '/_head/ball' && request.method === 'GET') response = Response.json({ ok: true, ...head })
  else response = Response.json({ ok: false, code: 'NOT_IN_FIXTURE' }, { status: 404 })
  router.seen.push({ method: request.method, path: url.pathname + url.search, status: response.status })
  return response
}

// ---------------------------------------------------------------------------------------------------------------------
// Row rules: every key compared, contents never printed.
// ---------------------------------------------------------------------------------------------------------------------
function sameValue(left: unknown, right: unknown): boolean {
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return left instanceof Uint8Array && right instanceof Uint8Array && Buffer.from(left.buffer, left.byteOffset, left.byteLength)
      .equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength))
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]))
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const a = Object.keys(left), b = Object.keys(right)
    return a.length === b.length && a.every(key => Object.hasOwn(right, key) && sameValue((left as Json)[key], (right as Json)[key]))
  }
  return Object.is(left, right)
}
interface Diff { appear: string[]; vanish: string[]; change: string[] }
function diffRows(before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>): Diff {
  const diff: Diff = { appear: [], vanish: [], change: [] }
  for (const [key, value] of before) {
    if (!after.has(key)) diff.vanish.push(key)
    else if (!sameValue(value, after.get(key))) diff.change.push(key)
  }
  for (const key of after.keys()) if (!before.has(key)) diff.appear.push(key)
  diff.appear.sort(); diff.vanish.sort(); diff.change.sort()
  return diff
}
const changedKeys = (diff: Diff): string[] => [...diff.appear, ...diff.vanish, ...diff.change].sort()
const fileRow = (rows: ReadonlyMap<string, unknown>, key: string): { bytes: Uint8Array; mode: number } | null => {
  const row = rows.get(key) as { kind?: string; bytes?: Uint8Array; mode?: number } | undefined
  return row?.kind === 'file' && row.bytes instanceof Uint8Array ? { bytes: row.bytes, mode: row.mode ?? 0 } : null
}
const isPathRow = (key: string): boolean => key.startsWith('/')
/** The edge's files, decoded from its own storage rows (metadata plus base64 chunks). */
function cloudFiles(rows: ReadonlyMap<string, unknown>): Map<string, { kind: string; mode: number; bytes: Uint8Array | null }> {
  const out = new Map<string, { kind: string; mode: number; bytes: Uint8Array | null }>()
  for (const [key, value] of rows) {
    if (!key.startsWith('mirror:v2:entry:')) continue
    const meta = value as { path: string; kind: string; mode: number; chunks?: number }
    if (meta.kind !== 'file') { out.set(meta.path, { kind: meta.kind, mode: meta.mode, bytes: null }); continue }
    let joined = ''
    for (let index = 0; index < (meta.chunks ?? 0); index += 1) joined += rows.get(`mirror:v2:chunk:${key.slice('mirror:v2:entry:'.length)}:${String(index)}`) as string
    out.set(meta.path, { kind: 'file', mode: meta.mode, bytes: new Uint8Array(Buffer.from(joined, 'base64')) })
  }
  return out
}
const prefixed = (rows: ReadonlyMap<string, unknown>, prefix: string): string[] =>
  [...rows.keys()].filter(key => key.startsWith(prefix)).sort()

// ---------------------------------------------------------------------------------------------------------------------
// Fixture building, with the old code.
// ---------------------------------------------------------------------------------------------------------------------
type Variant = 'wake' | 'phone' | 'phone-overlap'
interface Frozen { idb: Map<string, unknown>; cloud: Record<Variant, Map<string, unknown>>; clientId: string; quarantined: string[] }
let frozen: Frozen
const REPORT: Json[] = []
const mountErrors: string[] = []

async function freshTab(store: DoStore): Promise<{ layer: Persist; vfs: MemoryVfsType; db: FakeDb }> {
  vi.resetModules()
  const layer = await import(OLD_PERSIST) as Persist
  const { MemoryVfs } = await import('../../src/storage/memory.ts')
  const idb = new FakeIndexedDb()
  vi.stubGlobal('indexedDB', idb)
  router.store = store
  const vfs = new MemoryVfs()
  vfs.seedDirectory('/dsh/home/auma'); vfs.seedDirectory('/dsh/workspace')
  layer.persistence.readOnly = false
  await layer.attachIdbPersistence(vfs, ROOTS, FAST)
  const db = idb.dbs.get(layer.DB_NAME)
  if (!db) throw new Error('no database')
  return { layer, vfs, db }
}
/** One save, delivered for real: written, flushed, its batch posted and acknowledged. */
async function deliver(tab: { layer: Persist; vfs: MemoryVfsType }, path: string, bytes: Uint8Array): Promise<void> {
  tab.vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  tab.vfs.writeFileSync(path, bytes)
  await tab.layer.persistence.flush()
  await tab.layer.persistence.sync()
  if (tab.layer.persistence.mirror.pendingBatches !== 0 || tab.layer.persistence.mirror.conflict !== null) throw new Error(`not delivered: ${path}`)
}
const stepsFrame = (previous: Uint8Array, tag: string): Uint8Array => {
  const lines = new TextDecoder().decode(previous).split('\n').filter(Boolean).slice(-199)
  return text(`${[...lines, JSON.stringify({ at: tag, kind: 'wake:updated' })].join('\n')}\n`)
}

async function buildFixture(): Promise<Frozen> {
  const started = Date.now()
  // F1: the cloud's seed, revision 1.
  const cloud = memoryStorage()
  const inventory = seedInventory()
  const batchDigest = await E.digest(E.canonicalBootstrap(inventory))
  await E.bootstrapMirror(cloud.storage, { action: 'begin', seedId: SEED, ballId: BALL, epoch: 1, mirror: { batchDigests: [batchDigest], entryCount: inventory.length } })
  await E.bootstrapMirror(cloud.storage, { action: 'batch', seedId: SEED, index: 0, entries: inventory })
  const ready = await E.bootstrapMirror(cloud.storage, { action: 'commit', seedId: SEED })
  const lineageId = ready.lineageId as string
  // F1b: an earlier browser's saves and two wake checkpoints, each through the real writers, to 2060.
  let earlySeq = 0
  while (fenceOf(cloud).revision < 2060) {
    const revision = fenceOf(cloud).revision
    if (revision === 2000 || revision === 2050) { await wake(cloud); continue }
    earlySeq += 1
    const batch = { clientId: EARLY, seq: earlySeq, id: `${EARLY}:${String(earlySeq)}`, cloudBase: { lineageId, revision },
      entries: [['/dsh/home/auma/notes/note-000.md', wireFile(text(`early save ${String(earlySeq)}\n`), 1_762_100_000_000 + earlySeq)]] }
    const answer = await E.publishMirror(cloud.storage, { v: 2, batch, digest: await E.mirrorDigest(batch) })
    if (answer.ok !== true) throw new Error(`early save refused: ${String(answer.code)}`)
  }
  // F2: her tab, fresh, imports the snapshot at 2060, then 23 saves delivered for real: in step at 2083.
  const her = await freshTab(cloud)
  for (let index = 0; fenceOf(cloud).revision < 2083; index += 1) {
    await deliver(her, `/dsh/home/auma/${['notes/note-010.md', 'memory/item-004.json', 'HANDOFF.md', STEPS][index % 4] ?? 'WISH.md'}`, jsonl(400 + index, 50_000 + index, 100))
  }
  const herMeta = her.db.data.get(META_KEY) as { clientId: string; cloudBase: { revision: number } }
  if (herMeta.cloudBase.revision !== 2083) throw new Error('her tab is not in step at 2083')
  const at2183 = cloneRows(cloud.rows())
  // F3: the three clouds.
  const clouds = { wake: memoryStorage(cloneRows(at2183)), phone: memoryStorage(cloneRows(at2183)), 'phone-overlap': memoryStorage(cloneRows(at2183)) }
  for (let index = 0; index < 7; index += 1) await wake(clouds.wake)
  for (const variant of ['phone', 'phone-overlap'] as const) {
    const store = clouds[variant]
    const phone = await freshTab(store)
    await deliver(phone, CORDIS, text('[]\n'))
    await deliver(phone, `/dsh/home/organs/${sha(ORGAN_CODE)}.js`, text(ORGAN_CODE))
    await deliver(phone, LATEST, text(`{"snapshotId":"phone","createdAt":${String(Date.now())},"label":"boot-verified"}\n`))
    await deliver(phone, STEPS, stepsFrame(new Uint8Array(phone.vfs.readFileSync(STEPS) as Uint8Array), 'phone'))
    if (variant === 'phone-overlap') await deliver(phone, OVERLAP_NOTE, text('the phone wrote this note\n'))
    phone.layer.persistence.readOnly = true
    while (fenceOf(store).revision < 2090) await wake(store)
  }
  vi.stubGlobal('indexedDB', undefined)
  // F4: her next save is refused for real by the wake cloud; then the held saves.
  router.store = clouds.wake
  her.vfs.writeFileSync('/dsh/home/auma/notes/note-001.md', text('her first save after the cloud moved\n'))
  await her.layer.persistence.flush()
  await her.layer.persistence.sync().catch(() => {})
  if (her.layer.persistence.mirror.conflict === null || prefixed(her.db.data, BATCH_PREFIX).length !== 1) throw new Error('her save was not refused')
  const authored = /^\/dsh\/home\/auma\/(notes|memory|work|pearl|aura)\//
  const files = [...her.db.data.keys()].filter(key => authored.test(key) && fileRow(her.db.data, key))
  for (let index = 0; index < HELD_SAVES; index += 1) {
    let path: string, bytes: Uint8Array
    if (index % 100 === 50) { path = STEPS; bytes = stepsFrame(new Uint8Array(her.vfs.readFileSync(STEPS) as Uint8Array), `her-${String(index)}`) }
    else if (index % 400 === 10) { path = LATEST; bytes = text(`{"snapshotId":"hers-${String(index)}","createdAt":${String(1_763_000_000_000 + index)}}\n`) }
    else if (index === 1200 || index === 2400) { path = OVERLAP_NOTE; bytes = text(`her note, edited at save ${String(index)}\n`) }
    else if (index % 7 === 3) { path = `/dsh/home/auma/work/held-${String(index).padStart(4, '0')}.md`; bytes = jsonl(180, 70_000 + index, 90) }
    else { path = files[(index * 13) % files.length] ?? '/dsh/home/auma/WISH.md'; bytes = jsonl(220 + (index % 50), 90_000 + index, 100) }
    her.vfs.writeFileSync(path, bytes)
    if (index === 500 || index === 1500) her.vfs.appendFileSync(JOURNAL_A, jsonl(8 * 1024 * 1024, 7_000 + index))
    if (index === 2500) her.vfs.appendFileSync(JOURNAL_A, jsonl(BIG - (her.vfs.statSync(JOURNAL_A) as { size: number }).size, 9_999))
    if (index === 800) { her.vfs.mkdirSync(JOURNAL_B.slice(0, JOURNAL_B.lastIndexOf('/')), { recursive: true }); her.vfs.writeFileSync(JOURNAL_B, jsonl(12 * 1024 * 1024, 4_242)) }
    if (index === 2800) her.vfs.appendFileSync(JOURNAL_B, jsonl(BIG - 12 * 1024 * 1024, 4_343))
    await her.layer.persistence.flush()
  }
  her.layer.persistence.readOnly = true
  await pause(300)
  if ((fileRow(her.db.data, JOURNAL_A)?.bytes.byteLength ?? 0) !== BIG || (fileRow(her.db.data, JOURNAL_B)?.bytes.byteLength ?? 0) !== BIG) throw new Error('journals not grown')
  // Her refused batch, posted to the phone clouds exactly as her tab posted it to the wake cloud.
  const refusedKey = prefixed(her.db.data, BATCH_PREFIX)[0] ?? ''
  const refused = her.db.data.get(refusedKey) as { batch: Json; digest: string }
  for (const variant of ['phone', 'phone-overlap'] as const) {
    router.store = clouds[variant]
    const answer = await edgeFetch(`${ORIGIN}/_mirror/delta`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 2, batch: refused.batch, digest: refused.digest }) })
    if (answer.status !== 409) throw new Error(`the ${variant} cloud did not refuse her batch`)
  }
  // F4b: the old-old credentials-temp rows, INJECTED (no code writes this shape any more).
  for (let index = 0; index < 1_700; index += 1) {
    const path = `/dsh/home/.credentials.yaml.${sha(`credentials-temp-${String(index)}`).slice(0, 16)}.tmp`
    her.db.data.set(path, { kind: 'gone' }); her.db.data.set(RESET_PREFIX + path, { kind: 'subtree-reset', path })
  }
  router.store = null
  const marker = her.db.data.get(RECONCILE_KEY) as Json | undefined
  REPORT.push({ fixture: { ms: Date.now() - started, idbKeys: her.db.data.size, pathRows: [...her.db.data.keys()].filter(isPathRow).length,
    contentSeq: (her.db.data.get(CONTENT_KEY) as { seq: number }).seq, meta: her.db.data.get(META_KEY), marker,
    cloudKeys: Object.fromEntries(Object.entries(clouds).map(([name, store]) => [name, store.rows().size])),
    fences: Object.fromEntries(Object.entries(clouds).map(([name, store]) => [name, fenceOf(store).revision])) } })
  return { idb: cloneRows(her.db.data), cloud: { wake: cloneRows(clouds.wake.rows()), phone: cloneRows(clouds.phone.rows()),
    'phone-overlap': cloneRows(clouds['phone-overlap'].rows()) }, clientId: herMeta.clientId, quarantined: [JOURNAL_A, JOURNAL_B] }
}

// ---------------------------------------------------------------------------------------------------------------------
// One page load through worker-host's order, OLD or NEW, over fresh copies.
// ---------------------------------------------------------------------------------------------------------------------
interface Booted { layer: Persist; idb: FakeDb; cloud: DoStore; seen: Seen[] }
interface BootOptions { full?: boolean; settle?: 'fixed' | 'in-step'; crash?: boolean; beforeDelta?: (cloud: DoStore) => Promise<void> }
async function boot(code: 'old' | 'new', idbRows: ReadonlyMap<string, unknown>, cloudRows: ReadonlyMap<string, unknown>, mode: string,
  options: BootOptions = {}): Promise<Booted> {
  vi.resetModules()
  if (code === 'old') vi.doMock(PERSIST, async () => await import(OLD_PERSIST) as Persist); else vi.doUnmock(PERSIST)
  const layer = await import(PERSIST) as Persist
  const { MemoryVfs } = await import('../../src/storage/memory.ts')
  const { bootThreadSyncIfOn } = await import('../../src/storage/thread-sync.ts')
  const { mountX6BallRuntime } = await import('../../src/x6/ball-loader.ts')
  const { WorkerModuleLoader } = await import('../../src/module-system/module-loader.ts')
  const idb = new FakeIndexedDb(), db = new FakeDb()
  db.data = cloneRows(idbRows)
  if (options.crash === true) db.failPut = key => key.startsWith(REBASE_PREFIX)
  idb.dbs.set(layer.DB_NAME, db)
  vi.stubGlobal('indexedDB', idb)
  const cloud = memoryStorage(cloneRows(cloudRows))
  router.store = cloud; router.mode = mode; router.seen = []
  router.beforeDelta = options.beforeDelta ? async () => { await options.beforeDelta?.(cloud) } : null
  // The image (stand-in): seeded silently, as loadVfsImage does (worker-host.ts:353-358).
  const vfs = new MemoryVfs()
  vfs.seedDirectory('/dsh/home/auma'); vfs.seedDirectory('/dsh/workspace')
  layer.persistence.readOnly = false
  await layer.attachIdbPersistence(vfs, ROOTS, FAST)
  await bootThreadSyncIfOn(undefined, { vfs, enter: () => {}, pageId: null })
  if (options.full !== false) {
    // prepareProfile's one write (worker-host.ts:651), then her runtime (worker-host.ts:436).
    vfs.mkdirSync(CORDIS.slice(0, CORDIS.lastIndexOf('/')), { recursive: true })
    vfs.writeFileSync(CORDIS, '[]\n')
    const provided = new Map<string, unknown>()
    const registry = new Map<string, unknown>()
    const tools = {
      register: (definition: unknown) => {
        const name = (definition as { name: string }).name
        registry.set(name, definition)
        return () => { registry.delete(name) }
      },
      get: (name: string) => registry.get(name),
      definitions: () => [...registry.values()],
    }
    const context = { tools, get: (name: string) => provided.get(name),
      provide: (name: string, value?: unknown) => { provided.set(name, value) }, plugin: async () => ({ dispose() {} }) }
    const staticModules = { '@deepseek-ai/dsh-tools': () => ({ defineTool: (value: unknown) => value }) }
    const loader = new WorkerModuleLoader({ vfs, staticModules })
    // worker-host.ts:434-439: a runtime that fails to mount is logged and the page goes on.
    try { await mountX6BallRuntime(context as unknown as Parameters<typeof mountX6BallRuntime>[0], vfs, loader) }
    catch (error) { mountErrors.push(String(error)) }
  }
  if (options.settle === 'in-step') await settleInStep(db, cloud)
  else await pause(1_500)
  layer.persistence.readOnly = true
  return { layer, idb: db, cloud, seen: router.seen }
}
const inStep = (db: FakeDb, cloud: DoStore): boolean => {
  const meta = db.data.get(META_KEY) as { seq: number; cloudAcknowledgedSeq: number; cloudBase: { revision: number } } | undefined
  return meta !== undefined && meta.seq === meta.cloudAcknowledgedSeq && meta.cloudBase.revision === fenceOf(cloud).revision
    && !db.data.has(RECONCILE_KEY) && prefixed(db.data, BATCH_PREFIX).length === 0
}
async function settleInStep(db: FakeDb, cloud: DoStore): Promise<void> {
  const deadline = Date.now() + 180_000
  let stable = 0
  while (Date.now() < deadline && stable < 3) { await pause(250); stable = inStep(db, cloud) ? stable + 1 : 0 }
}

// ---------------------------------------------------------------------------------------------------------------------
// Assertions shared by the cases.
// ---------------------------------------------------------------------------------------------------------------------
let oldWrites: Record<Variant, string[]>
/** The path rows a boot writes by itself in OLD: SOURCE worker-host.ts:651 (cordis.yml), ball-loader.ts:9740 (LATEST.json and
 * its local-only dump under snapshots/), the selected head's code and HEAD.json under /dsh/home/balls (local-only), and the
 * head organ's content-addressed copies under /dsh/home/organs and seed/organs. */
const bootWritePaths = (keys: readonly string[]): string[] => keys.filter(isPathRow)
const BOOT_WRITE = (path: string): boolean => path === CORDIS || path === LATEST
  || /^\/dsh\/home\/auma\/snapshots\/[0-9a-f]{64}\.json$/.test(path)
  || path === '/dsh/home/balls' || path.startsWith('/dsh/home/balls/') || path === '/dsh/home/organs'
  || /^\/dsh\/home\/organs\/[0-9a-f]{64}\.js$/.test(path)
  || path === '/dsh/home/auma/seed/organs/organ-a.js'
const cloudAdmitted = (layer: Persist, path: string, row: { kind: string; bytes?: Uint8Array }): boolean =>
  layer.outboxAdmits(path, false) && layer.cloudAdmission(path, row.kind === 'file' ? (row.bytes?.byteLength ?? 0) : null) === 'send'
/** For every cloud-admissible row she holds, the cloud's entry equals it (kind, mode, bytes). */
function cloudEqualsHerRows(layer: Persist, idb: ReadonlyMap<string, unknown>, cloud: ReadonlyMap<string, unknown>): string[] {
  const files = cloudFiles(cloud)
  const wrong: string[] = []
  const gone = [...idb].filter(([key, row]) => isPathRow(key) && (row as { kind: string }).kind === 'gone').map(([key]) => key)
  for (const [key, value] of idb) {
    const row = value as { kind: string; bytes?: Uint8Array; mode: number }
    if (!isPathRow(key) || row.kind === 'gone' || ['/dsh/home', '/dsh/workspace'].includes(key) || gone.some(root => key.startsWith(root + '/'))) continue
    if (!cloudAdmitted(layer, key, row)) continue
    const theirs = files.get(key)
    if (!theirs || theirs.kind !== row.kind || theirs.mode !== row.mode || (row.kind === 'file' && !sameValue(theirs.bytes, row.bytes))) wrong.push(key)
  }
  return wrong
}
const secretAtEdge = (layer: Persist, cloud: ReadonlyMap<string, unknown>): string[] =>
  [...cloudFiles(cloud).keys()].filter(path => layer.secretShapedPath(path))

describe('dry run on a large store', () => {
  beforeAll(async () => {
    vi.stubGlobal('IDBKeyRange', FakeKeyRange)
    vi.stubGlobal('location', { origin: ORIGIN, hostname: 'x61-reconcile.invalid' })
    vi.stubGlobal('fetch', edgeFetch)
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.stubGlobal('WebSocket', undefined)
    vi.stubGlobal('__X6_SERVICES__', {})
    vi.stubGlobal('__X6_BALL__', undefined)
    vi.stubGlobal('__X6_BUILD_IDENTITY__', undefined)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    frozen = await buildFixture()
  }, 900_000)
  afterAll(() => {
    // The numbers per case, for the handoff: written only when the runner names a file (never by default).
    REPORT.push({ mountErrors })
    const out = process.env.RECONCILE_DRYRUN_REPORT
    if (out) writeFileSync(out, REPORT.map(line => `DRYRUN ${JSON.stringify(line)}`).join('\n') + '\n')
    vi.doUnmock(PERSIST); vi.unstubAllGlobals(); vi.restoreAllMocks()
  })

  it('the fixture has her shape: base 2083, one refused queued save, a genuine hold, two quarantined journals, 1,700 old rows', () => {
    const meta = frozen.idb.get(META_KEY) as { seq: number; cloudAcknowledgedSeq: number; cloudBase: { revision: number } }
    expect(meta.cloudBase.revision).toBe(2083)
    expect(meta.seq).toBe(meta.cloudAcknowledgedSeq + 1)
    expect(prefixed(frozen.idb, BATCH_PREFIX)).toHaveLength(1)
    expect((frozen.idb.get(RECONCILE_KEY) as { cause: string }).cause).toBe('genuine')
    expect((frozen.idb.get(CONTENT_KEY) as { seq: number }).seq).toBeGreaterThan(HELD_SAVES)
    for (const journal of frozen.quarantined) expect(fileRow(frozen.idb, journal)?.bytes.byteLength).toBe(BIG)
    expect(prefixed(frozen.idb, '/dsh/home/.credentials.yaml.')).toHaveLength(1_700)
    for (const variant of ['wake', 'phone', 'phone-overlap'] as const) {
      expect(fenceOf(memoryStorage(frozen.cloud[variant])).revision).toBe(2090)
      expect(prefixed(frozen.cloud[variant], 'mirror:v2:conflict:')).toHaveLength(1)
    }
  })

  it('1. OLD, every variant: only the boot\'s own writes, nothing delivered, every edge key byte-identical', { timeout: 300_000 }, async () => {
    oldWrites = { wake: [], phone: [], 'phone-overlap': [] }
    for (const variant of ['wake', 'phone', 'phone-overlap'] as const) {
      const booted = await boot('old', frozen.idb, frozen.cloud[variant], 'apply')
      const diff = diffRows(frozen.idb, booted.idb.data)
      oldWrites[variant] = changedKeys(diff)
      REPORT.push({ case: `old/${variant}`, idbChanged: oldWrites[variant], cloudChanged: changedKeys(diffRows(frozen.cloud[variant], booted.cloud.rows())),
        requests: booted.seen.map(item => `${item.method} ${item.path.split('?')[0] ?? ''} ${String(item.status)}`) })
      expect(diff.vanish).toEqual([])
      expect(bootWritePaths(oldWrites[variant]).filter(path => !BOOT_WRITE(path))).toEqual([])
      expect(bootWritePaths(oldWrites[variant])).toEqual(expect.arrayContaining([CORDIS, LATEST, '/dsh/home/balls/HEAD.json']))
      expect(diff.change.filter(isPathRow).sort()).toEqual([CORDIS, LATEST].filter(path => frozen.idb.has(path)).sort())
      expect(oldWrites[variant].filter(key => !isPathRow(key)).sort()).toEqual([CONTENT_KEY, RECONCILE_KEY].sort())
      expect(booted.seen.filter(item => item.method === 'POST')).toEqual([])
      expect(changedKeys(diffRows(frozen.cloud[variant], booted.cloud.rows()))).toEqual([])
      expect(booted.layer.persistence.mirror.conflict).toMatch(/^MIRROR_/)
    }
  })

  it('2. NEW, wake: back in step at 2090, the checkpoint file adopted with her bytes backed up, the cloud equal to her rows', { timeout: 300_000 }, async () => {
    const booted = await boot('new', frozen.idb, frozen.cloud.wake, 'apply', { settle: 'in-step' })
    const after = booted.idb.data, cloudAfter = booted.cloud.rows()
    const record = after.get(`${REBASE_PREFIX}2090`) as { from: number; to: number; ack: number; adopted: Array<{ path: string; backup: string | null }>; droppedQueue: Array<{ seq: number }> }
    const frozenMeta = frozen.idb.get(META_KEY) as { seq: number; cloudAcknowledgedSeq: number }
    expect(booted.layer.persistence.mirror.rebase).toMatchObject({ state: 'applied', from: 2083, to: 2090, mode: 'apply' })
    expect([record.from, record.to, record.ack]).toEqual([2083, 2090, frozenMeta.cloudAcknowledgedSeq])
    expect(record.droppedQueue.map(item => item.seq)).toEqual([frozenMeta.seq])
    expect(record.adopted.map(item => item.path)).toEqual([CHECKPOINT])
    const cloudCheckpoint = cloudFiles(frozen.cloud.wake).get(CHECKPOINT)
    expect(sameValue(fileRow(after, CHECKPOINT)?.bytes, cloudCheckpoint?.bytes)).toBe(true)
    const backup = record.adopted[0]?.backup ?? ''
    expect(sameValue(fileRow(after, backup)?.bytes, fileRow(frozen.idb, CHECKPOINT)?.bytes)).toBe(true)
    // Every other path row is byte-identical, apart from the same boot writes as OLD.
    const diff = diffRows(frozen.idb, after)
    const pathChanges = changedKeys(diff).filter(isPathRow)
    expect(pathChanges.sort()).toEqual([CHECKPOINT, backup, ...bootWritePaths(oldWrites.wake)].sort())
    expect(diff.vanish.filter(isPathRow)).toEqual([])
    for (const journal of frozen.quarantined) {
      expect(sameValue(fileRow(after, journal)?.bytes, fileRow(frozen.idb, journal)?.bytes)).toBe(true)
    }
    // After settling: in step, the cloud equals her rows, the checkpoint unchanged, only her receipts, no new conflict.
    expect(inStep(booted.idb, booted.cloud)).toBe(true)
    expect(cloudEqualsHerRows(booted.layer, after, cloudAfter)).toEqual([])
    expect(sameValue(cloudFiles(cloudAfter).get(CHECKPOINT)?.bytes, cloudCheckpoint?.bytes)).toBe(true)
    const newReceipts = prefixed(cloudAfter, 'mirror:v2:receipt:').filter(key => !frozen.cloud.wake.has(key))
    const seqs = newReceipts.map(key => Number(key.split(':').at(-1))).sort((a, b) => a - b)
    expect(newReceipts.every(key => key.startsWith(`mirror:v2:receipt:${frozen.clientId}:`))).toBe(true)
    expect(seqs).toEqual(seqs.map((_, index) => frozenMeta.cloudAcknowledgedSeq + 1 + index))
    expect(prefixed(cloudAfter, 'mirror:v2:conflict:')).toEqual(prefixed(frozen.cloud.wake, 'mirror:v2:conflict:'))
    expect(secretAtEdge(booted.layer, cloudAfter)).toEqual([])
    expect(sameValue(cloudFiles(cloudAfter).get(JOURNAL_A)?.bytes, cloudFiles(frozen.cloud.wake).get(JOURNAL_A)?.bytes)).toBe(true)
    expect(cloudFiles(cloudAfter).has(JOURNAL_B)).toBe(false)
    REPORT.push({ case: 'new/wake', rebase: booted.layer.persistence.mirror.rebase, idbChanged: changedKeys(diff).length, pathRowsChanged: pathChanges,
      deliveries: booted.seen.filter(item => item.method === 'POST').length, newReceipts: newReceipts.length, fence: fenceOf(booted.cloud).revision })
    // 3. Idempotent: a second boot is in step, calls no changes route, and changes no row but the boot's own writes.
    const again = await boot('new', after, cloudAfter, 'apply', { settle: 'in-step' })
    expect(again.seen.some(item => item.path.startsWith('/_mirror/changes'))).toBe(false)
    const second = changedKeys(diffRows(after, again.idb.data))
    expect(second.filter(isPathRow).filter(key => !bootWritePaths(oldWrites.wake).includes(key))).toEqual([])
    expect(second.filter(key => !isPathRow(key)).filter(key => ![META_KEY, CONTENT_KEY].includes(key))).toEqual([])
    expect(again.layer.persistence.mirror.rebase).toBeNull()
    expect(inStep(again.idb, again.cloud)).toBe(true)
    REPORT.push({ case: 'new/wake/idempotent', changesCalls: 0, idbChanged: second })
  })

  for (const variant of ['phone', 'phone-overlap'] as const) {
    it(`6. NEW, ${variant} (v1): refusal, both sides byte-identical`, { timeout: 300_000 }, async () => {
      const booted = await boot('new', frozen.idb, frozen.cloud[variant], 'apply')
      const changed = changedKeys(diffRows(frozen.idb, booted.idb.data))
      expect(changed).toEqual(oldWrites[variant])
      expect(prefixed(booted.idb.data, REBASE_PREFIX)).toEqual([])
      expect(changedKeys(diffRows(frozen.cloud[variant], booted.cloud.rows()))).toEqual([])
      expect(booted.seen.filter(item => item.method === 'POST')).toEqual([])
      const rebase = booted.layer.persistence.mirror.rebase
      expect(rebase).toMatchObject({ state: 'refused', code: 'REBASE_CHANGES_UNKNOWN', from: 2083, to: 2090 })
      const browsers = (rebase?.versions ?? []).filter(item => item.writer === 'browser')
      expect(browsers.length).toBe(variant === 'phone' ? 4 : 5)
      expect(browsers.every(item => item.at > 0 && item.client.length === 8)).toBe(true)
      expect(rebase?.detail).toMatch(/2084 by browser [0-9a-f]{8} at 20/)
      REPORT.push({ case: `new/${variant}/v1`, idbChanged: changed, cloudChanged: 0, code: rebase?.code, versions: rebase?.versions })
    })

    it(`6b. NEW, ${variant} under chrome-wins: back in step, her rows kept, the cloud equal to them, cloud-only files kept, overrides recorded`, { timeout: 300_000 }, async () => {
      const booted = await boot('new', frozen.idb, frozen.cloud[variant], 'chrome-wins', { settle: 'in-step' })
      const after = booted.idb.data, cloudAfter = booted.cloud.rows()
      expect(inStep(booted.idb, booted.cloud)).toBe(true)
      const record = after.get(`${REBASE_PREFIX}2090`) as { mode: string; adopted: Array<{ path: string; backup: string | null }>; overridden: Array<{ path: string; cloudBackup: string | null; cloudSha: string | null; localSha: string | null }> }
      expect(record.mode).toBe('chrome-wins')
      expect(record.adopted.map(item => item.path)).toEqual([CHECKPOINT])
      // The record lists exactly the paths where the cloud held an entry that differs from hers (and she sends hers).
      const frozenCloud = cloudFiles(frozen.cloud[variant])
      const expected = [...frozen.idb].filter(([key, value]) => {
        const row = value as { kind: string; bytes?: Uint8Array; mode: number }
        const theirs = frozenCloud.get(key)
        return isPathRow(key) && key !== CHECKPOINT && row.kind !== 'gone' && theirs !== undefined && cloudAdmitted(booted.layer, key, row)
          && (theirs.kind !== row.kind || theirs.mode !== row.mode || (row.kind === 'file' && !sameValue(theirs.bytes, row.bytes)))
      }).map(([key]) => key).sort()
      expect(record.overridden.map(item => item.path).sort()).toEqual(expected)
      expect(expected).toContain(LATEST); expect(expected).toContain(STEPS)
      if (variant === 'phone-overlap') expect(expected).toContain(OVERLAP_NOTE)
      for (const item of record.overridden) {
        if (item.cloudBackup === null) continue
        expect(sha(fileRow(after, item.cloudBackup)?.bytes ?? new Uint8Array())).toBe(item.cloudSha)
      }
      // Every one of her rows is byte-identical, apart from the adopted journal, the backups and the boot's own writes.
      const diff = diffRows(frozen.idb, after)
      const backups = new Set([...record.adopted.map(item => item.backup), ...record.overridden.map(item => item.cloudBackup)]
        .filter((key): key is string => key !== null))
      const booted2 = bootWritePaths(oldWrites[variant])
      const other = changedKeys(diff).filter(isPathRow).filter(key => key !== CHECKPOINT && !backups.has(key) && !booted2.includes(key))
      expect(other).toEqual([])
      expect(diff.vanish.filter(isPathRow)).toEqual([])
      // The cloud equals her rows for every path she holds; files only the cloud had are still there, unchanged.
      expect(cloudEqualsHerRows(booted.layer, after, cloudAfter)).toEqual([])
      const cloudOnly = [...frozenCloud.keys()].filter(path => !frozen.idb.has(path))
      expect(cloudOnly).toContain(`/dsh/home/organs/${sha(ORGAN_CODE)}.js`)
      const finalCloud = cloudFiles(cloudAfter)
      for (const path of cloudOnly) expect(sameValue(finalCloud.get(path), frozenCloud.get(path))).toBe(true)
      expect(secretAtEdge(booted.layer, cloudAfter)).toEqual([])
      expect(finalCloud.has(JOURNAL_B)).toBe(false)
      REPORT.push({ case: `new/${variant}/chrome-wins`, overridden: record.overridden.length, cloudBackups: backups.size - 1, cloudOnlyKept: cloudOnly.length,
        deliveries: booted.seen.filter(item => item.method === 'POST').length, fence: fenceOf(booted.cloud).revision, rebase: booted.layer.persistence.mirror.rebase })
    })
  }

  it('4. NEW, the cloud moves mid-run: her first resync batch is refused, she is held, nothing is lost; the next boot rebases over one version', { timeout: 300_000 }, async () => {
    let injected: Json | null = null
    const first = await boot('new', frozen.idb, frozen.cloud.wake, 'apply', { beforeDelta: async (cloud) => { injected = await wake(cloud) } })
    await pause(1_000)
    expect(injected).toMatchObject({ ok: true, revision: 2091 })
    expect(first.layer.persistence.mirror.conflict).toMatch(/MIRROR_GLOBAL_FENCE_CONFLICT|409/)
    const held = first.idb.data
    expect(prefixed(held, BATCH_PREFIX).length).toBeGreaterThan(0)
    expect(prefixed(first.cloud.rows(), 'mirror:v2:conflict:').length).toBe(2)
    // Nothing lost: every path row of the frozen store is still there with the same bytes (apart from the adopted journal and boot writes).
    const bootPaths = bootWritePaths(oldWrites.wake)
    const lost = changedKeys(diffRows(frozen.idb, held)).filter(isPathRow)
      .filter(key => frozen.idb.has(key) && key !== CHECKPOINT && !bootPaths.includes(key))
    expect(lost).toEqual([])
    const second = await boot('new', held, first.cloud.rows(), 'apply', { settle: 'in-step' })
    expect(second.layer.persistence.mirror.rebase).toMatchObject({ state: 'applied', from: 2090, to: 2091 })
    expect(prefixed(second.idb.data, REBASE_PREFIX)).toEqual([`${REBASE_PREFIX}2090`, `${REBASE_PREFIX}2091`])
    expect(inStep(second.idb, second.cloud)).toBe(true)
    expect(cloudEqualsHerRows(second.layer, second.idb.data, second.cloud.rows())).toEqual([])
    REPORT.push({ case: 'new/wake/cloud-moves', heldBatches: prefixed(held, BATCH_PREFIX).length, secondRebase: second.layer.persistence.mirror.rebase,
      fence: fenceOf(second.cloud).revision })
  })

  it('5. NEW, crash: the apply transaction aborts; IndexedDB and the edge are byte-identical to before the boot', { timeout: 300_000 }, async () => {
    const booted = await boot('new', frozen.idb, frozen.cloud.wake, 'apply', { full: false, crash: true })
    expect(booted.layer.persistence.mirror.rebase).toMatchObject({ state: 'failed' })
    expect(changedKeys(diffRows(frozen.idb, booted.idb.data))).toEqual([])
    expect(changedKeys(diffRows(frozen.cloud.wake, booted.cloud.rows()))).toEqual([])
    expect(booted.seen.filter(item => item.method === 'POST')).toEqual([])
    REPORT.push({ case: 'new/wake/crash', idbChanged: 0, cloudChanged: 0, rebase: booted.layer.persistence.mirror.rebase })
  })

  it('report mode changes nothing on either side and says what it would adopt', { timeout: 300_000 }, async () => {
    const booted = await boot('new', frozen.idb, frozen.cloud.wake, 'report')
    expect(booted.layer.persistence.mirror.rebase).toMatchObject({ state: 'would-adopt', adopted: [CHECKPOINT], from: 2083, to: 2090 })
    expect(changedKeys(diffRows(frozen.idb, booted.idb.data))).toEqual(oldWrites.wake)
    expect(changedKeys(diffRows(frozen.cloud.wake, booted.cloud.rows()))).toEqual([])
    REPORT.push({ case: 'new/wake/report', rebase: booted.layer.persistence.mirror.rebase })
  })
})
