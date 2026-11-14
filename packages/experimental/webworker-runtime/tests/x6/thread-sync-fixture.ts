/**
 * An in-memory IndexedDB, her edge's thread routes in memory, and the stores the
 * thread-sync specs boot. Not a spec.
 *
 * The IndexedDB stand-in is copied unchanged from large-store-boot.spec.ts: the large-store boot spec exports nothing and a spec
 * cannot import another spec (importing it would run its cases), and the large-store boot spec must not be edited. One store, string keys
 * in code-unit order, structured-clone values, transactions that commit after a task turn.
 */
import { createHash } from 'node:crypto'
import { rollingChain } from '../../src/storage/thread-sync-plan.ts'

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
type FakeRange = { lower: string; upper: string }
const inRange = (key: string, range?: FakeRange): boolean => range === undefined || (key >= range.lower && key <= range.upper)
export class FakeDb {
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
export class FakeIndexedDb {
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
export const FakeKeyRange = { bound: (lower: string, upper: string): FakeRange => ({ lower, upper }) }

// ---------------------------------------------------------------------------------------------------------------------
// Bytes.
// ---------------------------------------------------------------------------------------------------------------------
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const encoder = new TextEncoder()
export const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.byteLength }
  return out
}
/** Whole JSON lines, exactly `size` bytes, the last byte a newline (as her journals end). */
export function journal(size: number, tag: string): Uint8Array {
  const out = new Uint8Array(size)
  let at = 0, n = 0
  while (at < size) {
    const line = encoder.encode(`{"role":"user","t":"${tag}","n":${String(n++)},"text":"a line of a conversation"}\n`)
    out.set(line.subarray(0, Math.min(line.length, size - at)), at)
    at += line.length
  }
  out[size - 1] = 10
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Her edge's thread routes, in memory (the shapes of deploy/cloudflare/src/thread-log.mjs at an earlier commit plus the thread sync: the index
// summary, the manifest, `routeTail`, the vault's blob GET), plus `/_mirror/status` for idb-persist. Every call is
// recorded with whether `readOnly` was already set when it was made.
// ---------------------------------------------------------------------------------------------------------------------
export interface CloudThread {
  readonly path: string
  readonly bytes: Uint8Array
  readonly activeAt?: number
}
export interface EdgeCall {
  readonly method: string
  readonly path: string
  readonly readOnlyAtCall: boolean
}
export interface FakeEdgeOptions {
  readonly origin: string
  readonly piece: number
  readonly threads: readonly CloudThread[]
  /** The index's `sync` field; undefined leaves the field out. */
  readonly sync?: string
  /** The index's status (200 when unset); `silent` never answers the index. */
  readonly index?: number | 'silent' | 'malformed'
  readonly lease?: unknown
  readonly fence: { readonly lineageId: string; readonly revision: number }
  /** One flipped byte in the first part of this path; a wrong chain for this path; this path's blobs never answer. */
  readonly flipPartOf?: string
  readonly wrongChainOf?: string
  readonly silentBlobsOf?: string
  /** Index page size (default 200, as the client asks). */
  readonly pageSize?: number
  readonly readOnly?: () => boolean
}
interface Stored {
  readonly id: string
  readonly path: string
  readonly bytes: Uint8Array
  readonly piece: number
  readonly sealedBytes: number
  readonly partCount: number
  readonly lineEnd: number
  readonly parts: string[]
  readonly chain: string
  readonly tailSha: string
  readonly activeAt: number
}
const TAIL_MAX = 262_144
const never = (signal: AbortSignal | null | undefined): Promise<Response> => new Promise((_resolve, reject) => {
  signal?.addEventListener('abort', () => { reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')) }, { once: true })
})

export interface FakeEdge { fetch: typeof fetch; calls: EdgeCall[]; idOf: (path: string) => string }
export async function fakeEdge(options: FakeEdgeOptions): Promise<FakeEdge> {
  const calls: EdgeCall[] = []
  const blobs = new Map<string, Uint8Array>()
  const threads = new Map<string, Stored>()
  for (const [index, thread] of options.threads.entries()) {
    const length = thread.bytes.byteLength
    const partCount = length === 0 ? 0 : Math.floor((length - 1) / options.piece)
    const sealedBytes = partCount * options.piece
    const parts: string[] = []
    for (let k = 0; k < partCount; k += 1) {
      const part = thread.bytes.slice(k * options.piece, (k + 1) * options.piece)
      const name = sha256(part)
      parts.push(name)
      if (thread.path === options.flipPartOf && k === 0) part[17] = (part[17] ?? 0) ^ 0x01
      blobs.set(name, part)
    }
    const id = sha256(thread.path)
    threads.set(id, {
      id, path: thread.path, bytes: thread.bytes, piece: options.piece, sealedBytes, partCount, parts,
      lineEnd: thread.bytes.lastIndexOf(10) + 1,
      chain: thread.path === options.wrongChainOf ? sha256('not the chain') : await rollingChain(parts),
      tailSha: sha256(thread.bytes.subarray(sealedBytes)), activeAt: thread.activeAt ?? 1_000 + index,
    })
  }
  const summary = (t: Stored) => ({ id: t.id, path: t.path, bytes: t.bytes.byteLength, lineEnd: t.lineEnd, partCount: t.partCount,
    keptCount: 0, chain: t.chain, tailSha: t.tailSha, title: null, preview: null, activeAt: t.activeAt, updatedAt: t.activeAt, idle: null })
  const row = (t: Stored) => ({ v: 1, id: t.id, path: t.path, piece: t.piece, bytes: t.bytes.byteLength, lineEnd: t.lineEnd,
    sealedBytes: t.sealedBytes, partCount: t.partCount, chain: t.chain, tailSha: t.tailSha,
    run: { client: 'c0a8e9b2-1f3d-4c5e-8a7b-9d0e1f2a3b4c', from: 0 }, keptCount: 0 })
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const isRequest = input instanceof Request
    const url = new URL(isRequest ? input.url : String(input), options.origin)
    const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase()
    calls.push({ method, path: url.pathname + url.search, readOnlyAtCall: options.readOnly?.() ?? false })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    if (method === 'GET' && url.pathname === '/_mirror/status' && url.searchParams.get('compact') === '1') {
      return Response.json({ ok: true, protocol: 'x61-cloud-mirror/v1', lineageId: options.fence.lineageId, revision: options.fence.revision, runtime: 'cloudflare' })
    }
    if (method === 'GET' && url.pathname === '/_thread/index') {
      if (options.index === 'silent') return await never(init?.signal ?? (isRequest ? input.signal : undefined))
      if (options.index === 'malformed') return new Response('{"ok":tr', { status: 200, headers: { 'content-type': 'application/json' } })
      if (options.index !== undefined && options.index !== 200) return Response.json({ ok: false, code: 'FIXTURE' }, { status: options.index })
      const all = [...threads.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
      const after = url.searchParams.get('after') ?? ''
      const size = Math.min(Number(url.searchParams.get('limit') ?? 50), options.pageSize ?? 200)
      const rest = all.filter(t => t.id > after)
      const page = rest.slice(0, size)
      return Response.json({ ok: true, threads: page.map(summary), next: rest.length > size ? page.at(-1)?.id ?? null : null,
        home: { pending: true, rescue: null, freeze: 'record' }, lease: options.lease ?? null, world: { threads: all.length, tailBytes: 0, retired: 0 },
        ...(options.sync === undefined ? {} : { sync: options.sync }) })
    }
    if (method === 'GET' && url.pathname === '/_thread/manifest') {
      const t = threads.get(url.searchParams.get('id') ?? '')
      if (!t) return Response.json({ ok: false, code: 'THREAD_UNKNOWN' }, { status: 404 })
      const page = Number(url.searchParams.get('page') ?? 0)
      const parts = t.parts.slice(page * 1024, (page + 1) * 1024)
      return Response.json({ ok: true, thread: row(t), page, pages: Math.ceil(t.partCount / 1024), parts, kept: [], keptPages: 0 })
    }
    if (method === 'GET' && url.pathname.startsWith('/_vault/blob/')) {
      const name = url.pathname.slice('/_vault/blob/'.length)
      const owner = [...threads.values()].find(t => t.parts.includes(name))
      const signal = init?.signal ?? (isRequest ? input.signal : undefined)
      if (owner !== undefined && owner.path === options.silentBlobsOf) return await never(signal)
      const blob = blobs.get(name)
      return blob ? new Response(blob.slice(), { status: 200, headers: { 'content-type': 'application/octet-stream' } }) : Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 })
    }
    if (method === 'GET' && url.pathname === '/_thread/tail') {
      const t = threads.get(url.searchParams.get('id') ?? '')
      if (!t) return Response.json({ ok: false, code: 'THREAD_UNKNOWN' }, { status: 404 })
      // routeTail (thread-log.mjs), over the whole bytes.
      const before = Math.min(Number(url.searchParams.get('before') ?? t.lineEnd), t.lineEnd)
      const max = Math.min(Number(url.searchParams.get('max') ?? TAIL_MAX), TAIL_MAX)
      const answer = (bytes: Uint8Array, from: number, to: number, partial: boolean): Response => {
        const headers = { 'content-type': 'application/octet-stream', 'x-thread-from': String(from), 'x-thread-to': String(to) }
        return new Response(bytes.slice(), { status: 200, headers: partial ? { ...headers, 'x-thread-partial': '1' } : headers })
      }
      if (before === 0) return answer(new Uint8Array(0), 0, 0, false)
      const readFrom = Math.max(0, before - max - 1)
      const window = t.bytes.subarray(readFrom, before)
      const lastNewline = window.lastIndexOf(10)
      if (lastNewline < 0) {
        const take = Math.min(max, window.length)
        return answer(window.slice(window.length - take), before - take, before, true)
      }
      // As the edge now answers: a `before` inside a line is the bytes ending at it, marked partial.
      if (window[window.length - 1] !== 10) {
        const from = Math.max(readFrom + lastNewline + 1, before - max)
        return answer(window.slice(from - readFrom), from, before, true)
      }
      const end = readFrom + lastNewline + 1
      const low = Math.max(0, end - max)
      if (low === 0) return answer(window.slice(0, end - readFrom), 0, end, false)
      const index = window.indexOf(10, Math.max(0, low - 1 - readFrom))
      if (index >= 0 && readFrom + index < end - 1) return answer(window.slice(index + 1, end - readFrom), readFrom + index + 1, end, false)
      return answer(window.slice(low - readFrom, end - readFrom), low, end, true)
    }
    return Response.json({ ok: false, code: 'MIRROR_OWNER_PASS_REQUIRED' }, { status: 401 })
  }
  return { fetch: fetchImpl, calls, idOf: (path: string) => sha256(path) }
}

// ---------------------------------------------------------------------------------------------------------------------
// A browser that never saved and holds her cloud's home: the rows idb-persist leaves after a fresh import
// (idb-persist.ts:1139-1160 at an earlier commit: the imported rows, a meta at seq 0 on the cloud's fence, the content revision
// one up). A reload of it reads only `/_mirror/status` (it has durable history).
// ---------------------------------------------------------------------------------------------------------------------
export const READER_LINEAGE = '5e000005-0000-4000-8000-000000000005'
export const READER_CLIENT = '9a7c1e55-2b3d-4f60-8a91-b2c3d4e5f607'
export function readerStore(files: ReadonlyArray<readonly [string, Uint8Array]>, revision = 2190): Map<string, unknown> {
  const rows = new Map<string, unknown>()
  const dir = (path: string): void => { rows.set(path, { kind: 'dir', mode: 0o755 }) }
  for (const path of ['/dsh/home', '/dsh/home/auma', '/dsh/home/sessions', '/dsh/workspace']) dir(path)
  rows.set('/dsh/home/auma/notes.md', { kind: 'file', bytes: encoder.encode('her notes, as her cloud last held them\n'), mode: 0o644, mtimeMs: 1_762_000_000_000 })
  for (const [path, bytes] of files) {
    const parts = path.split('/').slice(1, -1)
    for (let n = 2; n <= parts.length; n += 1) dir(`/${parts.slice(0, n).join('/')}`)
    rows.set(path, { kind: 'file', bytes, mode: 0o644, mtimeMs: 1_762_000_000_001 })
  }
  rows.set('@x6-mirror-meta', { kind: 'mirror-meta', clientId: READER_CLIENT, seq: 0, cloudBase: { lineageId: READER_LINEAGE, revision }, cloudAcknowledgedSeq: 0 })
  rows.set('@x6-content-revision', { kind: 'content-revision', seq: 1 })
  return rows
}
