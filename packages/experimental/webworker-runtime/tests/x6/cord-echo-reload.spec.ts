/**
 * Her cord head survives a real page reload. The shelf (cord-run.ts) writes /dsh/home/cord/ in her VFS;
 * `idb-persist.ts` saves it to IndexedDB exactly as worker-host.ts attaches it; the next page load hydrates a NEW VFS
 * from IndexedDB alone (the cloud mirror unreachable), and a new shelf over a new cell host reads the same head and
 * continues from it. A browser with a cleared store and no cloud has no head, so the head came from IndexedDB.
 *
 * The IndexedDB and mirror stand-ins below are the ones `store-wiped-rehydrate.spec.ts` uses (copied, because a spec
 * cannot import another spec without running it): one store, string keys in code-unit order, structured-clone values,
 * transactions that commit after a task turn with nothing pending.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  DB_NAME, attachIdbPersistence, persistence, type AttachOptions, type MirrorBatch, type WireEntry,
} from '../../src/storage/idb-persist.ts'
import { CORD_DIR, createCordShelf } from '../../src/x6/cord-run.ts'
import { createCellHost, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'

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

type J = Record<string, unknown>
const REPO = new URL('../../../../../', import.meta.url)
const CELLS = new URL('apps/web/public/cells/', REPO)
const ORIGIN = 'https://cord-echo.example.invalid'
const ROOTS = ['/dsh/home', '/dsh/workspace']
const FAST: AttachOptions = { read: { backoffMs: [0, 0], idleMs: 2_000, sleep: async () => {} }, resync: { firstMs: 20, maxMs: 80 } }
const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

// ---------- her cell host on a Node worker (as cord-echo.spec.ts) ----------
const served = async (url: URL): Promise<Response> => {
  try { return new Response(new Uint8Array(await readFile(new URL(url.pathname.slice('/cells/'.length), CELLS)))) }
  catch { return new Response('no', { status: 404 }) }
}
const servedFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  return url.origin === ORIGIN && url.pathname.startsWith('/cells/') ? await served(url) : new Response('no', { status: 404 })
}
const hosts = new Set<CellHost>()
const workers = new Set<Worker>()
const nodeCellWorker = (source: string): CellWorker => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = value => parentPort.postMessage(value);
    parentPort.on('message', data => globalThis.onmessage({ data }));
    ${source}
  `, { eval: true, execArgv: [] })
  workers.add(worker)
  return {
    listen(onMessage, onFailure) { worker.on('message', onMessage); worker.on('error', onFailure); worker.on('messageerror', onFailure) },
    postMessage: (message) => { worker.postMessage(message) },
    async terminate() { await worker.terminate(); worker.removeAllListeners(); workers.delete(worker) },
  }
}
const browserHost = (): CellHost => {
  const host = createCellHost({ origin: ORIGIN, fetchImpl: servedFetch, createWorker: nodeCellWorker, now: () => 0 })
  hosts.add(host)
  return host
}

/** Every file under her cord shelf with the SHA-256 of its bytes. */
function storeDigest(vfs: MemoryVfs): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    if (!vfs.existsSync(dir)) return
    for (const name of [...vfs.readdirSync(dir)].map(String).sort()) {
      const path = `${dir}/${name}`
      if (vfs.statSync(path).isDirectory()) walk(path)
      else { const value = vfs.readFileSync(path); out[path] = sha(typeof value === 'string' ? value : Uint8Array.from(value)) }
    }
  }
  walk(CORD_DIR)
  return out
}

let mirror: FakeMirror
let idb: FakeIndexedDb
/** One page load: the image's empty home, then her store attached exactly as worker-host.ts attaches it. */
async function load(): Promise<MemoryVfs> {
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma', { recursive: true })
  vfs.mkdirSync('/dsh/workspace', { recursive: true })
  persistence.readOnly = false
  await attachIdbPersistence(vfs, ROOTS, FAST)
  return vfs
}
/** One page's shelf: a new cell host (a reload starts a new page), the same-origin cell files. */
const once = <T>(make: () => T): (() => T) => { let made: T | undefined; return () => (made ??= make()) }
const pageShelf = (vfs: MemoryVfs) => {
  const shelf = createCordShelf({ vfs, cells: once(browserHost), origin: ORIGIN, fetchImpl: servedFetch, now: () => 0 })
  return async (args: J) => await shelf.execute(args)
}

describe('her cord head across a real page reload (IndexedDB)', () => {
  beforeEach(() => {
    mirror = new FakeMirror()
    idb = new FakeIndexedDb()
    vi.stubGlobal('indexedDB', idb)
    vi.stubGlobal('IDBKeyRange', FakeKeyRange)
    vi.stubGlobal('location', { origin: 'https://node.example.invalid', hostname: 'node.example.invalid' })
    vi.stubGlobal('fetch', mirror.fetch)
  })
  afterEach(async () => {
    persistence.readOnly = true
    await pause(120)
    vi.unstubAllGlobals()
    try { await Promise.all([...hosts].map(host => host.dispose())) }
    finally {
      hosts.clear()
      await Promise.all([...workers].map(worker => worker.terminate()))
      workers.clear()
    }
  })

  it('the head, its checkpoints and their bytes come back from IndexedDB alone, and the next feed continues from that head', async () => {
    // Page 1: start, three legs here, then her store saves.
    const first = await load()
    const cells1 = once(browserHost)
    const shelf1 = createCordShelf({ vfs: first, cells: cells1, origin: ORIGIN, fetchImpl: servedFetch, now: () => 0 })
    const run1 = async (args: J) => await shelf1.execute(args)
    const started = await run1({ action: 'cord', step: 'start' })
    expect(started).toMatchObject({ ok: true, tick: 0 })
    let last: J = started
    for (let leg = 0; leg < 3; leg += 1) {
      last = await run1({ action: 'cord', step: 'feed', inputs: Array.from({ length: 10 }, (_, k) => (leg * 10 + k) * 97 % 65521), at: 'here' })
      expect(last).toMatchObject({ ok: true, tick: (leg + 1) * 10 })
    }
    const saved = storeDigest(first)
    const skill = started.skill as string
    expect(Object.keys(saved)).toContain(`${CORD_DIR}/${skill}/head.json`)
    expect(Object.keys(saved)).toContain(`${CORD_DIR}/${skill}/checkpoints/${last.head as string}.json`)
    await persistence.flush()
    // IndexedDB itself holds head.json, with the bytes page 1 wrote.
    const row = idb.dbs.get(DB_NAME)?.data.get(`${CORD_DIR}/${skill}/head.json`) as { kind: string; bytes: Uint8Array } | undefined
    expect(row?.kind).toBe('file')
    expect(sha(Uint8Array.from(row!.bytes))).toBe(saved[`${CORD_DIR}/${skill}/head.json`])

    // Page 2: a reload with the cloud unreachable. A new VFS is hydrated from IndexedDB alone; a new shelf and cell host.
    mirror.reachable = false
    const second = await load()
    expect(storeDigest(second)).toEqual(saved)
    const run2 = pageShelf(second)
    expect(await run2({ action: 'cord', step: 'status' })).toMatchObject({ ok: true, started: true, skill, head: last.head, tick: 30, generation: 4 })
    expect(await run2({ action: 'cord', step: 'start' })).toMatchObject({ ok: false, code: 'CORD_ALREADY_STARTED', head: last.head })
    expect(await run2({ action: 'cord', step: 'feed', inputs: [1, 2, 3], at: 'here' })).toMatchObject({ ok: true, parent: last.head, tick: 33 })

    // Control: a browser whose store was cleared, with no cloud, has no head; the head above came from IndexedDB.
    vi.stubGlobal('indexedDB', new FakeIndexedDb())
    const cleared = await load()
    expect(storeDigest(cleared)).toEqual({})
    expect(await pageShelf(cleared)({ action: 'cord', step: 'status' })).toMatchObject({ ok: true, started: false, head: null })
  }, 120_000)
})
