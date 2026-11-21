/**
 * Empty-browser hydration and subsequent saves through the real Worker, HEAD and MIRROR.
 * IndexedDB is copied from store-wiped-rehydrate.spec.ts because importing a spec registers its tests.
 * Durable Object storage and bootstrap wiring follow recovery-restore.test.mjs; only platform storage,
 * the owner's fixture identity, and same-origin transport are substituted. No edge reply is synthesized.
 */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  attachIdbPersistence, persistence, OWNER_SIGN_IN_REQUIRED, FRESH_SIGN_IN_MESSAGE,
  type AttachOptions, type WireEntry,
} from '../../src/storage/idb-persist.ts'

class FakeRequest<T = unknown> {
  result!: T
  /** Settle with a value (the fake's own requests assign `result` directly; this keeps the shape typed). */
  succeed(value: T): void { this.result = value; this.onsuccess?.() }
  error: Error | null = null
  transaction: FakeTx | null = null
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  onupgradeneeded: ((event: { oldVersion: number }) => void) | null = null
  onblocked: (() => void) | null = null
}
type FakeRange = { lower: string; upper: string }
const inRange = (key: string, range?: FakeRange): boolean => range === undefined || (key >= range.lower && key <= range.upper)
class FakeDb {
  data = new Map<string, unknown>()
  queue: FakeTx[] = []
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
      setTimeout(() => {
        this.pending -= 1
        if (this.finished) return
        try { req.result = work(this.working); req.onsuccess?.() }
        catch (error) { req.error = error as Error; req.onerror?.(); this.abort() }
        this.settle()
      }, 0)
    }
    if (this.started) op(); else this.ops.push(op)
    return req
  }
  settle(): void {
    setTimeout(() => {
      if (this.finished || this.pending > 0 || this.ops.length > 0) return
      this.finished = true
      if (this.mode === 'readwrite') this.db.data = this.working
      this.oncomplete?.(); this.db.pump()
    }, 0)
  }
  abort(): void {
    if (this.finished) return
    this.finished = true
    this.error = new Error('AbortError')
    setTimeout(() => { this.onabort?.(); this.db.pump() }, 0)
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
  put(value: unknown, key: string) { return this.exec((data) => { data.set(key, structuredClone(value)); return key }) }
  delete(key: string) { return this.exec((data) => { data.delete(key) }) }
  getAll(range?: FakeRange) { return this.exec(data => this.sorted(data, range).map(key => structuredClone(data.get(key)))) }
  getAllKeys(range?: FakeRange) { return this.exec(data => this.sorted(data, range)) }
  count(range?: FakeRange) { return this.exec(data => this.sorted(data, range).length) }
  openCursor(range?: FakeRange): FakeRequest<FakeCursor | null> {
    const tx = this.tx
    if (tx === null) throw new Error('cursor outside a transaction')
    const req = new FakeRequest<FakeCursor | null>()
    let keys: string[] | null = null
    let index = 0
    // Each step resolves the same request object, as IndexedDB cursors do.
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
    setTimeout(() => {
      let db = this.dbs.get(name)
      const oldVersion = db === undefined ? 0 : version
      if (db === undefined) { db = new FakeDb(); this.dbs.set(name, db) }
      req.result = db
      if (oldVersion < version) {
        req.transaction = null
        req.onupgradeneeded?.({ oldVersion })
      }
      req.onsuccess?.()
    }, 0)
    return req
  }
}
const FakeKeyRange = { bound: (lower: string, upper: string): FakeRange => ({ lower, upper }) }

type Json = Record<string, unknown>
interface EdgeObject { fetch(request: Request): Promise<Response>; queue?: Promise<unknown> }
interface EdgeModules {
  createWorker(options: {
    verifyAccess(request: Request): Promise<{ type: 'owner'; email: string; expires: number } | null>
    networkFetch(): Promise<never>
  }): { fetch(request: Request, env: Json): Promise<Response> }
  X61HeadDurableObject: new (state: Json, env: Json, options: Json) => EdgeObject
  MirrorDO: new (state: Json) => EdgeObject
  bootstrapPackage(input: Json): Promise<Json & { seedId: string }>
  canonicalBootstrap(input: unknown): string
  digest(input: string): Promise<string>
  manifestId(input: Json): Promise<string>
}
// Match thread-sync-edge.spec.ts: import JavaScript modules whole, then type only the members used here.
const edgeModule = async (relative: string): Promise<Json> => {
  const loaded: unknown = await import(new URL(`../../../../../deploy/cloudflare/src/${relative}`, import.meta.url).href)
  return loaded as Json
}
const E = Object.assign({}, ...await Promise.all(['worker.mjs', 'head-do.mjs', 'mirror-do.mjs'].map(edgeModule))) as EdgeModules

/** Transactional DO storage, including the platform's 128 KiB per-value ceiling. */
function memoryStorage() {
  let rows = new Map<string, unknown>()
  let queue: Promise<unknown> = Promise.resolve()
  let alarmAt: number | null = null
  const adapter = (map: Map<string, unknown>, alarm: { value: number | null }) => ({
    get: async (key: string) => structuredClone(map.get(key)),
    getAlarm: async () => alarm.value,
    setAlarm: async (value: number) => { alarm.value = value },
    deleteAlarm: async () => { alarm.value = null },
    put: async (key: string, value: unknown) => {
      expect(Buffer.byteLength(JSON.stringify(value)), 'DO value exceeds its platform limit').toBeLessThanOrEqual(128 * 1024)
      map.set(key, structuredClone(value))
    },
    delete: async (key: string) => map.delete(key),
    list: async ({ prefix = '', limit = Infinity }: { prefix?: string; limit?: number } = {}) =>
      new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
  })
  return {
    get: (key: string) => adapter(rows, { value: alarmAt }).get(key),
    list: (options?: { prefix?: string; limit?: number }) => adapter(rows, { value: alarmAt }).list(options),
    getAlarm: async () => alarmAt,
    setAlarm: async (value: number) => { alarmAt = value },
    deleteAlarm: async () => { alarmAt = null },
    transaction<T>(operation: (tx: ReturnType<typeof adapter>) => Promise<T>): Promise<T> {
      const pending = queue.then(async () => {
        const staged = structuredClone(rows), alarm = { value: alarmAt }
        const result = await operation(adapter(staged, alarm))
        rows = staged; alarmAt = alarm.value
        return result
      })
      // Retain the caller's rejection while allowing the next transaction to run.
      queue = pending.catch(() => {})
      return pending
    },
    snapshot: () => structuredClone(rows),
    idle: () => queue,
  }
}

const ORIGIN = 'https://restore-fixture.example.invalid'
const OWNER_EMAIL = 'owner@example.invalid'
const ROOTS = ['/dsh/home', '/dsh/workspace']
const FAST: AttachOptions = { read: { backoffMs: [0, 0], idleMs: 2_000, sleep: async () => {} }, resync: { firstMs: 20, maxMs: 80 } }
const MEMORY = '/dsh/home/auma/memory/note.md'
const NOTE = '/dsh/home/auma/new body.md'
type SeedEntry = [string, Exclude<WireEntry, { kind: 'gone' }>]
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const file = (value: string | Uint8Array): Exclude<WireEntry, { kind: 'gone' }> => ({
  kind: 'file', b64: (typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)).toString('base64'), mode: 0o600, mtimeMs: 1700000000000,
})

/** Distinct counter-hash blocks avoid a repeating byte ramp in the large-file fixture. */
function homeEntries(): SeedEntry[] {
  const large = Buffer.alloc(3 * 1024 * 1024 + 17)
  for (let offset = 0; offset < large.length; offset += 32) {
    createHash('sha256').update(`empty-browser:${String(offset)}`).digest().copy(large, offset)
  }
  const receipts = Array.from({ length: 5 }, (_, index) => JSON.stringify({
    schema: 'aukora.receipt.v3', seq: index + 1, hash: String(index + 1).padStart(64, 'a'),
  })).join('\n') + '\n'
  const dirs = ['/dsh/home/auma', '/dsh/home/auma/memory', '/dsh/home/auma/memory/nested',
    '/dsh/home/auma/memory/nested/empty folder', '/dsh/home/auma/seed', '/dsh/workspace/project']
  const entries: SeedEntry[] = dirs.map(path => [path, { kind: 'dir', mode: 0o700 }])
  entries.push(
    [MEMORY, file('she remembers the river\n')],
    ['/dsh/home/auma/seed/receipts.v3.jsonl', file(receipts)],
    ['/dsh/home/auma/seed/checkpoints.v1.jsonl', file('{"checkpoint":1}\n{"checkpoint":2}\n')],
    ['/dsh/home/auma/memory/nested/all bytes.bin', file(Uint8Array.from({ length: 256 }, (_, i) => i))],
    ['/dsh/home/auma/memory/nested/empty.txt', file('')],
    ['/dsh/home/auma/memory/nested/large.bin', file(large)],
    ['/dsh/home/auma/memory/Élodie 海の記憶.txt', file('a name with letters and spaces\n')],
    ['/dsh/workspace/project/readme.txt', file('workspace\n')],
  )
  return entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
}

function world() {
  const headStorage = memoryStorage(), mirrorStorage = memoryStorage()
  const env: Json = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture-audience', OWNER_EMAIL }
  const head = new E.X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, {})
  const mirror = new E.MirrorDO({ storage: mirrorStorage })
  for (const name of ['HEAD', 'MIRROR']) env[name] = {
    idFromName(value: string) { expect(value).toBe('node-main-v1'); return value },
    get() { return { fetch: (request: Request) => (name === 'HEAD' ? head : mirror).fetch(request) } },
  }
  env.ASSETS = { fetch: () => new Response('Fixture asset') }
  const transport = { signedIn: true, reachable: true, externalCalls: 0 }
  const forbidNetwork = async (): Promise<never> => {
    transport.externalCalls += 1
    throw new Error('External network is forbidden in this fixture')
  }
  const worker = E.createWorker({
    verifyAccess: async request => request.headers.get('cookie') === 'CF_Authorization=fixture-token'
      ? { type: 'owner', email: OWNER_EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 } : null,
    networkFetch: forbidNetwork,
  })
  const calls: Array<{ path: string; method: string; status: number; ack?: Json }> = []
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const target = new URL(input instanceof Request ? input.url : String(input), ORIGIN)
    if (target.origin !== ORIGIN) return forbidNetwork()
    if (!transport.reachable) throw new TypeError('fetch failed')
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    if (transport.signedIn) headers.set('cookie', 'CF_Authorization=fixture-token')
    else headers.delete('cookie')
    headers.set('origin', ORIGIN); headers.set('sec-fetch-site', 'same-origin')
    const request = new Request(input instanceof Request ? input : target, { ...init, headers })
    const response = await worker.fetch(request, env)
    const ack = target.pathname === '/_mirror/delta' ? await response.clone().json() as Json : undefined
    calls.push({ path: target.pathname, method: request.method, status: response.status, ...(ack === undefined ? {} : { ack }) })
    return response
  }
  return { fetchImpl, calls, transport, headStorage, mirrorStorage, mirror }
}

async function seed(edge: ReturnType<typeof world>, entries: SeedEntry[]): Promise<void> {
  const code = 'export default { fixture: true }', sha = await E.digest(code)
  const ball: Json = { version: 'x6.1-ball/v1', parentBallId: 'c'.repeat(64), epoch: 169,
    entries: { 'organ.fixture': { id: 'organ.fixture', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  ball.ballId = await E.manifestId(ball)
  const pkg = await E.bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code },
    mirror: { entryCount: entries.length, batchDigests: [await E.digest(E.canonicalBootstrap(entries))] } })
  for (const input of [{ action: 'prepare', package: pkg }, { action: 'batch', seedId: pkg.seedId, index: 0, entries }, { action: 'commit', seedId: pkg.seedId }]) {
    const response = await edge.fetchImpl('/_bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    expect(response.status, await response.text()).toBe(200)
  }
  edge.calls.length = 0
}

async function loadBrowser(packaged?: SeedEntry): Promise<MemoryVfs> {
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma', { recursive: true })
  vfs.mkdirSync('/dsh/workspace', { recursive: true })
  if (packaged?.[1].kind === 'file') vfs.seed(packaged[0], Buffer.from(packaged[1].b64, 'base64'))
  persistence.readOnly = false
  await attachIdbPersistence(vfs, ROOTS, FAST)
  return vfs
}

function expectHome(vfs: MemoryVfs, entries: SeedEntry[]): void {
  for (const [path, entry] of entries) {
    expect.soft(vfs.existsSync(path), path).toBe(true)
    if (!vfs.existsSync(path)) continue
    const stat = vfs.statSync(path)
    expect.soft(stat.isDirectory(), path).toBe(entry.kind === 'dir')
    if (entry.kind === 'file' && !stat.isDirectory()) {
      const actual = vfs.readFileSync(path) as Uint8Array
      const expected = Buffer.from(entry.b64, 'base64')
      expect.soft(actual.byteLength, path).toBe(expected.byteLength)
      expect.soft(sha256(actual), path).toBe(sha256(expected))
    }
  }
}

async function exported(edge: ReturnType<typeof world>): Promise<{ entries: SeedEntry[]; resetPaths: string[] }> {
  const response = await edge.fetchImpl('/_mirror/export')
  expect(response.status).toBe(200)
  return await response.json() as { entries: SeedEntry[]; resetPaths: string[] }
}

describe('an empty browser comes back from the real edge', () => {
  let edge: ReturnType<typeof world>
  let entries: SeedEntry[]
  let idb: FakeIndexedDb
  const stores: FakeIndexedDb[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let initialized = false
  const load = async (packaged?: SeedEntry): Promise<MemoryVfs> => {
    const vfs = await loadBrowser(packaged)
    initialized = true
    return vfs
  }
  const evict = (): void => {
    idb = new FakeIndexedDb(); stores.push(idb)
    vi.stubGlobal('indexedDB', idb)
  }
  beforeEach(async () => {
    initialized = false
    // Persistence has no dispose API. Own its timers so retries cannot outlive this test's globals.
    vi.stubGlobal('setTimeout', (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer = realSetTimeout(() => { timers.delete(timer); callback(...args) }, ms)
      timers.add(timer)
      return timer
    })
    edge = world(); entries = homeEntries()
    vi.stubGlobal('fetch', edge.fetchImpl)
    evict()
    vi.stubGlobal('IDBKeyRange', FakeKeyRange)
    vi.stubGlobal('location', { origin: ORIGIN, hostname: new URL(ORIGIN).hostname })
    await seed(edge, entries)
  })
  afterEach(async () => {
    persistence.readOnly = true
    try {
      if (initialized) await persistence.retryCloudSync()
      await vi.waitFor(() => {
        expect(persistence.mirror.sending).toBe(false)
        expect(stores.every(store => [...store.dbs.values()].every(db => db.queue.every(tx => tx.finished)))).toBe(true)
      }, { timeout: 2_000, interval: 10 })
      await edge.headStorage.idle(); await edge.mirrorStorage.idle(); await edge.mirror.queue
      expect(edge.transport.externalCalls).toBe(0)
    } finally {
      for (const timer of timers) realClearTimeout(timer)
      timers.clear(); stores.length = 0
      vi.unstubAllGlobals()
    }
  })

  it('an empty signed in browser loads every file and folder of her home byte for byte', async () => {
    expect(idb.dbs.size).toBe(0)
    const before = edge.mirrorStorage.snapshot()
    const vfs = await load()
    expectHome(vfs, entries)
    expect(persistence.mirror.conflict).toBeNull()
    expect(persistence.mirror.transient).toBeNull()
    expect(edge.calls.filter(call => call.path === '/api/snapshot')).toHaveLength(1)
    expect(edge.calls.every(call => call.method === 'GET')).toBe(true)
    expect(edge.mirrorStorage.snapshot()).toEqual(before)
  })

  it('a change in the new body is acknowledged by the mirror and reaches a second empty browser', async () => {
    let vfs = await load()
    const content = 'written in the new body\n'
    vfs.writeFileSync(NOTE, content)
    await persistence.flush()
    await persistence.sync()
    const deltas = edge.calls.filter(call => call.path === '/_mirror/delta')
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.every(call => call.status === 200 && call.ack?.ok === true)).toBe(true)
    expect(persistence.mirror.pendingBatches).toBe(0)
    expect((await exported(edge)).entries.find(([path]) => path === NOTE)?.[1]).toMatchObject({ kind: 'file', b64: Buffer.from(content).toString('base64') })
    evict()
    expect(idb.dbs.size).toBe(0)
    vfs = await load()
    expectHome(vfs, [...entries, [NOTE, file(content)]])
    expect(persistence.mirror.transient).toBeNull()
    expect(persistence.mirror.conflict).toBeNull()
  })

  it('a deleted file stays gone in the next empty browser even when the image contains it', async () => {
    let vfs = await load()
    expect(vfs.existsSync(MEMORY)).toBe(true)
    vfs.rmSync(MEMORY)
    await persistence.flush()
    await persistence.sync()
    const saved = await exported(edge)
    expect(saved.entries.some(([path]) => path === MEMORY)).toBe(false)
    expect(saved.resetPaths).toContain(MEMORY)
    evict()
    vfs = await load([MEMORY, file('packaged older memory\n')])
    expect(vfs.existsSync(MEMORY)).toBe(false)
    expectHome(vfs, entries.filter(([path]) => path !== MEMORY))
  })

  it('without the owner sign in an empty browser loads no home saves nothing and says why', async () => {
    edge.transport.signedIn = false
    const before = edge.mirrorStorage.snapshot()
    const vfs = await load()
    for (const [path, entry] of entries) if (entry.kind === 'file') expect(vfs.existsSync(path), path).toBe(false)
    expect(edge.calls.find(call => call.path === '/api/snapshot')?.status).toBe(401)
    const localBefore = [...idb.dbs].map(([name, db]) => [name, structuredClone(db.data)])
    vfs.writeFileSync(NOTE, 'must not be saved\n')
    await expect(persistence.flush()).rejects.toThrow(OWNER_SIGN_IN_REQUIRED)
    await persistence.sync()
    expect([...idb.dbs].map(([name, db]) => [name, db.data])).toEqual(localBefore)
    expect(edge.mirrorStorage.snapshot()).toEqual(before)
    expect(edge.calls.some(call => call.method !== 'GET')).toBe(false)
    expect(persistence.mirror.transient).toBe(FRESH_SIGN_IN_MESSAGE)
    expect(await persistence.retryCloudSync()).toBe('unreachable')
    expect(persistence.mirror.transient).toBe(FRESH_SIGN_IN_MESSAGE)
  })

  it('an unreachable edge does not stop boot and the next load recovers every file when it returns', async () => {
    edge.transport.reachable = false
    const started = performance.now()
    let vfs = await load()
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(vfs.existsSync(MEMORY)).toBe(false)
    expect(persistence.mirror.transient).toMatch(/nothing is saved here until it does/)
    const localBefore = [...idb.dbs].map(([name, db]) => [name, structuredClone(db.data)])
    vfs.writeFileSync(NOTE, 'offline and not saved\n')
    await expect(persistence.flush()).rejects.toThrow(/nothing is saved here until it does/)
    expect([...idb.dbs].map(([name, db]) => [name, db.data])).toEqual(localBefore)
    edge.transport.reachable = true
    expect(await persistence.retryCloudSync()).toBe('reload-required')
    vfs = await load()
    expectHome(vfs, entries)
    expect(vfs.existsSync(NOTE)).toBe(false)
    expect(persistence.mirror.transient).toBeNull()
  })

  it('a returning browser reads the real status and keeps every locally stored byte', async () => {
    await load()
    edge.calls.length = 0
    const vfs = await load()
    expectHome(vfs, entries)
    expect(edge.calls.some(call => call.path === '/api/snapshot')).toBe(false)
    expect(edge.calls.some(call => call.path === '/_mirror/status' && call.status === 200)).toBe(true)
    expect(persistence.mirror.transient).toBeNull()
    expect(persistence.mirror.conflict).toBeNull()
  })
})
