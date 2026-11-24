/**
 * A large browser store must be byte-identical after the STORAGE LAYER boots.
 *
 * The shape (made up for this spec): 13 session journals, the main one over the cloud mirror's 24 MiB per-file limit;
 * 250 files under /dsh/home/auma; a cloud base seven revisions behind the cloud on the same lineage; a genuine
 * reconciliation hold; 1,700 deletion rows and 1,700 reset rows named /dsh/home/.credentials.yaml.<hex>.tmp; one
 * queued save. A tab holding such a store may be reloaded onto a newer build. This spec builds a store of that shape directly in an
 * in-memory IndexedDB, boots `idb-persist.ts` over it exactly as `store-wiped-rehydrate.spec.ts` `load()` does, and
 * asserts that no path row (file, dir or gone) and no reset row changes, appears or vanishes.
 *
 * SCOPE: this is the storage layer's boot (`attachIdbPersistence`) only, NOT her whole app. The real app boot also
 * writes /dsh/home/balls/HEAD.json (src/x6/ball-loader.ts:2465), which is a save, and with it moves the content revision
 * `@x6-content-revision`. "Byte-identical after boot" here never means the whole app's boot.
 *
 * Scale: the main journal here is 25 MiB plus one byte (over the cloud's per-file limit).
 *
 * BOOKKEEPING rows (keys starting `@x6-`) may differ only when listed in ALLOWED below, each with the line of
 * idb-persist.ts that writes it during boot and why that is harmless. Path rows and reset rows are never listed.
 *
 * The IndexedDB stand-in is copied from `store-wiped-rehydrate.spec.ts` (a spec cannot import another spec): one store,
 * string keys in code-unit order, structured-clone values, transactions that commit after a task turn.
 */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  attachIdbPersistence, persistence, DB_NAME, type AttachOptions, type MirrorBatch, type WireEntry,
} from '../../src/storage/idb-persist.ts'

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

const ROOTS = ['/dsh/home', '/dsh/workspace']
const FAST: AttachOptions = { read: { backoffMs: [0, 0], idleMs: 2_000, sleep: async () => {} }, resync: { firstMs: 20, maxMs: 80 } }
const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

// ---------------------------------------------------------------------------------------------------------------------
// The store, built row by row (shape SOURCE idb-persist.ts:13-14, 89-125, 368-370).
// ---------------------------------------------------------------------------------------------------------------------
const LINEAGE = '5e000005-0000-4000-8000-000000000005'
const CLIENT = '5e000006-0000-4000-8000-000000000006'
const MAIN_JOURNAL = '/dsh/home/sessions/--dsh-home-auma--/session-main/session.v4.jsonl'
const MAIN_BYTES = 25 * 1024 * 1024 + 1
const QUEUED_PATH = '/dsh/home/auma/notes/note-001.md'
const META_KEY = '@x6-mirror-meta'
const CONTENT_KEY = '@x6-content-revision'
const RECONCILE_KEY = '@x6-cloud-reconciliation'
const RESET_PREFIX = '@x6-vfs-reset:'
const BATCH_KEY = `@x6-mirror-batch:${'41'.padStart(16, '0')}`
const JOURNAL_MARKER = `@x6-deferred-journal:${MAIN_JOURNAL}`
const CONTENT_SEQ = 5_100

/** A deterministic PRNG, so a changed byte anywhere is found (mulberry32). */
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
const ALPHABET = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz0123456789 ')
/** JSONL lines of `size` bytes in all, each a whole line ending in `\n`, content from `seed`. */
function jsonl(size: number, seed: number, lineBytes = 128): Uint8Array {
  const out = new Uint8Array(size)
  const next = prng(seed)
  const encoder = new TextEncoder()
  let at = 0
  let line = 0
  while (at < size) {
    const remaining = size - at
    const length = remaining < 2 * lineBytes ? remaining : lineBytes
    const head = encoder.encode(`{"i":${String(line).padStart(8, '0')},"k":"turn","p":"`)
    const tail = encoder.encode('"}\n')
    if (length < head.length + tail.length) throw new Error('line too short')
    out.set(head, at)
    const bodyEnd = at + length - tail.length
    for (let index = at + head.length; index < bodyEnd; index += 1) out[index] = ALPHABET[Math.floor(next() * ALPHABET.length)] ?? 0x61
    out.set(tail, bodyEnd)
    at += length
    line += 1
  }
  return out
}
const MAIN_TEMPLATE = jsonl(MAIN_BYTES, 0xa0ae)
const fileRow = (bytes: Uint8Array, mtimeMs: number) => ({ kind: 'file', bytes, mode: 0o644, mtimeMs })
const dirRow = () => ({ kind: 'dir', mode: 0o755 })
const wireOf = (bytes: Uint8Array, mtimeMs: number): WireEntry =>
  ({ kind: 'file', b64: Buffer.from(bytes).toString('base64'), mode: 0o644, mtimeMs })
const hex16 = (index: number): string => sha256(`credentials-temp-${String(index)}`).slice(0, 16)

type Variant = 'held' | 'in-step'
/**
 * 'held': base revision 2083, one queued save (seq one above cloudAcknowledgedSeq), a genuine reconciliation hold.
 * 'in-step': base revision 2090, no reconciliation row and no queued save; every other row the same.
 */
function buildStore(variant: Variant): Map<string, unknown> {
  const rows = new Map<string, unknown>()
  const dir = (path: string): void => { rows.set(path, dirRow()) }
  for (const path of ['/dsh/home', '/dsh/home/sessions', '/dsh/home/auma', '/dsh/workspace']) dir(path)
  // The main journal, over the cloud's 24 MiB per-file limit, and the 12 small journals.
  dir('/dsh/home/sessions/--dsh-home-auma--'); dir('/dsh/home/sessions/--dsh-home-auma--/session-main')
  rows.set(MAIN_JOURNAL, fileRow(MAIN_TEMPLATE.slice(), 1_762_900_000_000))
  dir('/dsh/home/sessions/--dsh-home-auma--/session-side')
  rows.set('/dsh/home/sessions/--dsh-home-auma--/session-side/session.v4.jsonl', fileRow(jsonl(40_000, 7), 1_762_800_000_000))
  dir('/dsh/home/sessions/--dsh-home-auma-one--')
  for (let index = 0; index < 11; index += 1) {
    const base = `/dsh/home/sessions/--dsh-home-auma-one--/session-${String(index).padStart(2, '0')}`
    dir(base)
    rows.set(`${base}/session.v4.jsonl`, fileRow(jsonl(2_000 + index * 997, 100 + index), 1_762_700_000_000 + index))
  }
  // 250 files under /dsh/home/auma, with their directories; the two append-only seed journals among them.
  const authored = ['seed', 'seed/organs', 'notes', 'memory', 'pearl', 'work', 'aura']
  for (const sub of authored) dir(`/dsh/home/auma/${sub}`)
  rows.set('/dsh/home/auma/seed/receipts.v3.jsonl', fileRow(jsonl(9_000, 21), 1_762_600_000_001))
  rows.set('/dsh/home/auma/seed/checkpoints.v1.jsonl', fileRow(jsonl(5_000, 22), 1_762_600_000_002))
  for (let index = 0; index < 248; index += 1) {
    const sub = ['seed/organs', 'notes', 'memory', 'pearl', 'work', 'aura'][index % 6] ?? 'notes'
    const name = sub === 'notes' ? `note-${String(index).padStart(3, '0')}.md` : `item-${String(index).padStart(3, '0')}.json`
    rows.set(`/dsh/home/auma/${sub}/${name}`, fileRow(jsonl(200 + (index % 17) * 31, 1_000 + index, 100), 1_762_500_000_000 + index))
  }
  // 1,700 deletion rows and 1,700 reset rows, all named after a credentials temp file.
  for (let index = 0; index < 1_700; index += 1) {
    const path = `/dsh/home/.credentials.yaml.${hex16(index)}.tmp`
    rows.set(path, { kind: 'gone' })
    rows.set(RESET_PREFIX + path, { kind: 'subtree-reset', path })
  }
  // Bookkeeping.
  rows.set(CONTENT_KEY, { kind: 'content-revision', seq: CONTENT_SEQ })
  rows.set(JOURNAL_MARKER, { kind: 'deferred-journal', path: MAIN_JOURNAL, notBefore: 0, failures: 0 })
  if (variant === 'held') {
    rows.set(META_KEY, { kind: 'mirror-meta', clientId: CLIENT, seq: 41, cloudBase: { lineageId: LINEAGE, revision: 2083 }, cloudAcknowledgedSeq: 40 })
    rows.set(RECONCILE_KEY, { kind: 'cloud-reconciliation', firstRevision: 4_800, lastRevision: CONTENT_SEQ, scope: 'all-persisted-mirror-content', cause: 'genuine' })
    // One queued save, valid by projectedCloudBase (idb-persist.ts:139-152): seq 41 = acknowledged 40 + 1, its id, its
    // fence at the acknowledged base, its digest the SHA-256 of JSON.stringify(batch). It carries a file whose row matches.
    const queued = rows.get(QUEUED_PATH) as { bytes: Uint8Array; mtimeMs: number }
    const batch: MirrorBatch['batch'] = {
      clientId: CLIENT, seq: 41, id: `${CLIENT}:41`, entries: [[QUEUED_PATH, wireOf(queued.bytes, queued.mtimeMs)]],
      cloudBase: { lineageId: LINEAGE, revision: 2083 },
    }
    rows.set(BATCH_KEY, { kind: 'mirror-batch', batch, digest: sha256(JSON.stringify(batch)) } satisfies MirrorBatch)
  } else {
    rows.set(META_KEY, { kind: 'mirror-meta', clientId: CLIENT, seq: 41, cloudBase: { lineageId: LINEAGE, revision: 2090 }, cloudAcknowledgedSeq: 41 })
  }
  return rows
}

// ---------------------------------------------------------------------------------------------------------------------
// The rule: no path row and no reset row may change, appear or vanish; a bookkeeping row only as ALLOWED says.
// ---------------------------------------------------------------------------------------------------------------------
type Change = 'appear' | 'vanish' | 'change'
interface Allowed { readonly key: string; readonly change: Change; readonly writtenAt: string; readonly harmless: string }
/**
 * Bookkeeping rows the storage layer's boot may change, per case. Never a path row, never a reset row.
 * The held case (A, and the second tab's boot in D) allows nothing: full identity.
 */
const ALLOWED: Readonly<Record<'held' | 'in-step', readonly Allowed[]>> = {
  held: [],
  'in-step': [
    {
      key: JOURNAL_MARKER,
      change: 'vanish',
      writtenAt: 'idb-persist.ts:1610-1611 (enqueueJournal, reached at boot through queuePump at :2064 and the empty-queue drain at :1798)',
      harmless: 'the marker only schedules a cloud send of a journal over the cloud\'s 24 MiB per-file limit, which the cloud '
        + 'can never take; the journal row itself is untouched, and its name is kept in quarantinedPaths, recounted from '
        + 'the stored rows on every boot (idb-persist.ts:855-858).',
    },
  ],
}

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
    return a.length === b.length && a.every(key => Object.hasOwn(right, key)
      && sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
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
  return diff
}
/** Every difference the rule does not allow, as `<change> <key>` (keys only, never contents). */
function violations(diff: Diff, allowed: readonly Allowed[]): string[] {
  const out: string[] = []
  for (const change of ['appear', 'vanish', 'change'] as const) {
    for (const key of diff[change]) {
      const bookkeeping = key.startsWith('@x6-') && !key.startsWith(RESET_PREFIX)
      if (!bookkeeping || !allowed.some(entry => entry.key === key && entry.change === change)) out.push(`${change} ${key}`)
    }
  }
  return out.sort()
}
const snapshot = (rows: ReadonlyMap<string, unknown>): Map<string, unknown> =>
  new Map([...rows].map(([key, value]) => [key, structuredClone(value)]))

// ---------------------------------------------------------------------------------------------------------------------
// The cloud: `GET /_mirror/status?compact=1` answers the same lineage at revision 2090; everything else is recorded, 401.
// ---------------------------------------------------------------------------------------------------------------------
interface Seen { method: string; path: string }
let seen: Seen[] = []
const cloud = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input))
  const method = (init?.method ?? 'GET').toUpperCase()
  seen.push({ method, path: url.pathname + url.search })
  if (method === 'GET' && url.pathname === '/_mirror/status' && url.searchParams.get('compact') === '1') {
    return Response.json({ ok: true, protocol: 'x61-cloud-mirror/v1', lineageId: LINEAGE, revision: 2090, runtime: 'cloudflare' })
  }
  return Response.json({ ok: false, code: 'MIRROR_OWNER_PASS_REQUIRED' }, { status: 401 })
}
const posts = (): Seen[] => seen.filter(request => request.method === 'POST')
const snapshotReads = (): Seen[] => seen.filter(request => request.path.startsWith('/api/snapshot'))

let fakeDb: FakeDb
/** Put a store into a fresh in-memory IndexedDB as the browser holds it (no upgrade runs: the database exists at v2). */
function install(rows: ReadonlyMap<string, unknown>): void {
  const idb = new FakeIndexedDb()
  fakeDb = new FakeDb()
  fakeDb.data = snapshot(rows)
  idb.dbs.set(DB_NAME, fakeDb)
  vi.stubGlobal('indexedDB', idb)
}

type Persist = typeof import('../../src/storage/idb-persist.ts')
/** One page load, exactly as `store-wiped-rehydrate.spec.ts` `load()`: the image's empty home, then her store attached. */
async function load(layer: Pick<Persist, 'attachIdbPersistence' | 'persistence'> = { attachIdbPersistence, persistence }): Promise<MemoryVfs> {
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma', { recursive: true })
  vfs.mkdirSync('/dsh/workspace', { recursive: true })
  layer.persistence.readOnly = false
  await layer.attachIdbPersistence(vfs, ROOTS, FAST)
  return vfs
}
/** Boot, then let the first drain, its first retry and the first resync window (20 ms here) pass. */
const SETTLE_MS = 1_500
const bytesOf = (vfs: MemoryVfs, path: string): Uint8Array => new Uint8Array(vfs.readFileSync(path) as Uint8Array)
const rowBytes = (key: string): Uint8Array | null => {
  const row = fakeDb.data.get(key) as { kind?: string; bytes?: Uint8Array } | undefined
  return row?.kind === 'file' && row.bytes instanceof Uint8Array ? row.bytes : null
}
async function waitForRowLength(key: string, length: number, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (rowBytes(key)?.byteLength === length) return
    await pause(25)
  }
}
const TURN = new TextEncoder().encode(`${'{"i":"appended","k":"turn","p":"'.padEnd(197, 'z')}"}\n`)
const contentSeq = (): number => (fakeDb.data.get(CONTENT_KEY) as { seq: number }).seq
const others: Array<Persist['persistence']> = []

describe('a large store is byte-identical after the storage layer boots', () => {
  beforeEach(() => {
    seen = []
    vi.stubGlobal('IDBKeyRange', FakeKeyRange)
    vi.stubGlobal('location', { origin: 'https://node.example.invalid', hostname: 'node.example.invalid' })
    vi.stubGlobal('fetch', cloud)
  })
  afterEach(async () => {
    persistence.readOnly = true
    for (const other of others.splice(0)) other.readOnly = true
    await pause(120)
    vi.unstubAllGlobals()
  })

  it('A, the held case: boot changes no row, sends nothing, and reports the conflict', { timeout: 120_000 }, async () => {
    expect(TURN.byteLength).toBe(200)
    const before = buildStore('held')
    install(before)
    const vfs = await load()
    await pause(SETTLE_MS)

    expect(violations(diffRows(before, fakeDb.data), ALLOWED.held)).toEqual([])
    expect(posts()).toEqual([])
    expect(snapshotReads()).toEqual([])
    expect(seen.some(request => request.method === 'GET' && request.path === '/_mirror/status?compact=1')).toBe(true)
    expect(persistence.mirror.conflict).toMatch(/^MIRROR_/)
    expect(persistence.mirror.reconciliationRequired).toBe(true)
    expect(persistence.durable).toBe(true)
    expect(persistence.conflict).toBeNull()
    const journal = bytesOf(vfs, MAIN_JOURNAL)
    expect(journal.byteLength).toBe(MAIN_BYTES)
    expect(sha256(journal)).toBe(sha256(MAIN_TEMPLATE))
  })

  it('B, working on in that state: a 200-byte turn is saved and nothing else moves', { timeout: 120_000 }, async () => {
    const before = buildStore('held')
    install(before)
    const vfs = await load()
    await pause(SETTLE_MS)
    expect(violations(diffRows(before, fakeDb.data), ALLOWED.held)).toEqual([])
    const booted = snapshot(fakeDb.data)

    vfs.appendFileSync(MAIN_JOURNAL, TURN)
    await waitForRowLength(MAIN_JOURNAL, MAIN_BYTES + TURN.byteLength)
    await pause(300)

    const saved = rowBytes(MAIN_JOURNAL)
    expect(saved?.byteLength).toBe(MAIN_BYTES + TURN.byteLength)
    expect(sha256(saved ?? new Uint8Array())).toBe(sha256(Buffer.concat([MAIN_TEMPLATE, TURN])))
    const diff = diffRows(booted, fakeDb.data)
    expect(diff.vanish).toEqual([])
    expect(diff.appear).toEqual([])
    // The save writes the journal row and its own content revision (idb-persist.ts:1523, 1527); nothing else.
    expect(diff.change.sort()).toEqual([CONTENT_KEY, MAIN_JOURNAL].sort())
    expect(contentSeq()).toBe(CONTENT_SEQ + 1)
    expect(posts()).toEqual([])
    expect(persistence.conflict).toBeNull()
  })

  it('C, a browser in step: boot changes no path or reset row', { timeout: 120_000 }, async () => {
    const before = buildStore('in-step')
    install(before)
    await load()
    await pause(SETTLE_MS)

    expect(violations(diffRows(before, fakeDb.data), ALLOWED['in-step'])).toEqual([])
    expect(posts()).toEqual([])
    expect(persistence.mirror.conflict).toBeNull()
    expect(persistence.conflict).toBeNull()
    expect(persistence.durable).toBe(true)
  })

  it('D, a second tab: its boot alone does not stop the first tab saving', { timeout: 120_000 }, async () => {
    const before = buildStore('held')
    install(before)
    const vfs = await load()
    await pause(SETTLE_MS)

    // A second tab: a fresh module instance of the storage layer over the same database; nothing written through it.
    vi.resetModules()
    const second: Persist = await import('../../src/storage/idb-persist.ts')
    expect(second.persistence).not.toBe(persistence)
    others.push(second.persistence)
    await load(second)
    await pause(SETTLE_MS)
    expect(violations(diffRows(before, fakeDb.data), ALLOWED.held)).toEqual([])
    expect(contentSeq()).toBe(CONTENT_SEQ)

    vfs.appendFileSync(MAIN_JOURNAL, TURN)
    await waitForRowLength(MAIN_JOURNAL, MAIN_BYTES + TURN.byteLength)
    await pause(300)

    const saved = rowBytes(MAIN_JOURNAL)
    expect(saved?.byteLength).toBe(MAIN_BYTES + TURN.byteLength)
    expect(sha256(saved ?? new Uint8Array())).toBe(sha256(Buffer.concat([MAIN_TEMPLATE, TURN])))
    expect(persistence.conflict).toBeNull()
    expect(persistence.durable).toBe(true)
    expect(contentSeq()).toBe(CONTENT_SEQ + 1)
    expect(posts()).toEqual([])
  })
})
