/**
 * When the browser clears her local store (Safari's seven-day rule, iOS pressure, a private window),
 * the next load rehydrates her memory from the edge mirror instead of hanging or starting empty, and saving resumes
 * under the cloud fence. With the cloud unreachable as well, boot still finishes (bounded) and says so, and a later load
 * rehydrates. `idb-persist.ts` is driven end to end over an in-memory IndexedDB and a fake edge mirror.
 *
 * The IndexedDB stand-in below is the one `journal-supersede.spec.ts` uses (copied, because a spec cannot import
 * another spec without running it): one store, string keys in code-unit order, structured-clone values, transactions
 * that commit after a task turn with nothing pending.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  attachIdbPersistence, persistence, type AttachOptions, type MirrorBatch, type WireEntry,
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

/** The edge mirror: one fence, its entries, and the three routes a browser uses (status, snapshot, delta). */
class FakeMirror {
  lineageId = '11111111-2222-4333-8444-555555555555'
  revision = 1
  entries = new Map<string, WireEntry>()
  reachable = true
  snapshots = 0
  fence() { return { protocol: 'x61-cloud-mirror/v1', lineageId: this.lineageId, revision: this.revision } }
  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (!this.reachable) throw new TypeError('fetch failed')
    if (url.pathname === '/_mirror/status') return Response.json({ ok: true, ...this.fence(), runtime: 'cloudflare' })
    if (url.pathname === '/api/snapshot') {
      this.snapshots += 1
      return Response.json({ ok: true, ...this.fence(), snapshotFormat: 'x61-mirror-snapshot/v2', resetPaths: [], entries: [...this.entries] })
    }
    if (url.pathname === '/_mirror/delta' && init?.method === 'POST') {
      const { batch, digest } = JSON.parse(init.body as string) as { batch: MirrorBatch['batch']; digest: string }
      if (batch.cloudBase?.lineageId !== this.lineageId || batch.cloudBase.revision !== this.revision) {
        return Response.json({ ok: false, code: 'MIRROR_GLOBAL_FENCE_CONFLICT' }, { status: 409 })
      }
      for (const [path, wire] of batch.entries) {
        if (wire.kind === 'gone') { for (const key of [...this.entries.keys()]) if (key === path || key.startsWith(path + '/')) this.entries.delete(key) }
        else this.entries.set(path, wire)
      }
      this.revision += 1
      return Response.json({
        ok: true, ...this.fence(), id: batch.id, clientId: batch.clientId, seq: batch.seq, digest, applied: batch.entries.length,
      })
    }
    return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 })
  }
  text(path: string): string | null {
    const wire = this.entries.get(path)
    return wire?.kind === 'file' ? Buffer.from(wire.b64, 'base64').toString('utf8') : null
  }
}

const ROOTS = ['/dsh/home', '/dsh/workspace']
const FAST: AttachOptions = { read: { backoffMs: [0, 0], idleMs: 2_000, sleep: async () => {} }, resync: { firstMs: 20, maxMs: 80 } }
const MEMORY = '/dsh/home/auma/memory.md'
const NOTE = '/dsh/home/auma/note.md'
const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })
const file = (text: string): WireEntry => ({ kind: 'file', b64: Buffer.from(text).toString('base64'), mode: 0o644, mtimeMs: 1 })
const textOf = (vfs: MemoryVfs, path: string): string | null =>
  vfs.existsSync(path) ? new TextDecoder().decode(vfs.readFileSync(path) as Uint8Array) : null
let mirror: FakeMirror

/** One page load: the image's empty home, then her store attached exactly as worker-host.ts attaches it. */
async function load(): Promise<MemoryVfs> {
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma', { recursive: true })
  vfs.mkdirSync('/dsh/workspace', { recursive: true })
  persistence.readOnly = false
  await attachIdbPersistence(vfs, ROOTS, FAST)
  return vfs
}
/** The browser clears her local store. */
function evict(): void { vi.stubGlobal('indexedDB', new FakeIndexedDb()) }

describe('her local store is cleared by the browser: she comes back from the edge', () => {
  beforeEach(() => {
    mirror = new FakeMirror()
    mirror.entries.set('/dsh/home/auma', { kind: 'dir', mode: 0o755 })
    mirror.entries.set(MEMORY, file('she remembers the river\n'))
    evict()
    vi.stubGlobal('IDBKeyRange', FakeKeyRange)
    vi.stubGlobal('location', { origin: 'https://node.example.invalid', hostname: 'node.example.invalid' })
    vi.stubGlobal('fetch', mirror.fetch)
  })
  afterEach(async () => {
    persistence.readOnly = true
    await pause(120)
    vi.unstubAllGlobals()
  })

  it('a cleared store reloads every file she saved, and saving resumes under the fence', async () => {
    let vfs = await load()
    expect(textOf(vfs, MEMORY)).toBe('she remembers the river\n')
    vfs.writeFileSync(NOTE, 'written before the eviction\n')
    await persistence.flush()
    await persistence.sync()
    expect(mirror.text(NOTE)).toBe('written before the eviction\n')

    evict()
    vfs = await load()
    expect(textOf(vfs, MEMORY)).toBe('she remembers the river\n')
    expect(textOf(vfs, NOTE)).toBe('written before the eviction\n')
    expect(persistence.mirror.conflict).toBeNull()
    expect(persistence.mirror.transient).toBeNull()
    expect(mirror.snapshots).toBe(2)

    vfs.writeFileSync(NOTE, 'written after it\n')
    await persistence.flush()
    await persistence.sync()
    expect(mirror.text(NOTE)).toBe('written after it\n')
  })

  it('cleared store and no cloud: boot still finishes, says nothing is saved, and the next load rehydrates', async () => {
    mirror.reachable = false
    const started = Date.now()
    let vfs = await load()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(textOf(vfs, MEMORY)).toBeNull()
    expect(persistence.mirror.transient).toMatch(/nothing is saved here until it does/)

    mirror.reachable = true
    expect(await persistence.retryCloudSync()).toBe('reload-required')
    vfs = await load()
    expect(textOf(vfs, MEMORY)).toBe('she remembers the river\n')
    expect(persistence.mirror.transient).toBeNull()
  })
})
