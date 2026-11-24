/**
 * one secret-shaped rule for this browser and the cloud mirror, and the credentials temp copies that
 * each tree boot writes (`/dsh/home/.credentials.yaml.<hex>.tmp`, through `@deepseek-ai/dsh-atomic-write`, when the
 * Connection plugin stores its browser-session signing record) never reach the outbox, the mirror, or a tombstone.
 * Saves queued before this rule lose those entries once, while nothing queued has reached the cloud.
 *
 * The IndexedDB stand-in is the one `store-wiped-rehydrate.spec.ts` and `journal-supersede.spec.ts` use (copied, because
 * a spec cannot import another spec without running it).
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error The cloud mirror is plain ESM without declarations; only its exported rule is read here.
import * as edge from '../../../../../deploy/cloudflare/src/mirror-do.mjs'
import { sha256HexSync } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  attachIdbPersistence, cloudPathAllowed, MIRROR_SECRET_NAMES, MIRROR_SECRET_PREFIXES, MIRROR_SECRET_SUFFIX, outboxAdmits, persistence,
  planSecretScrub, secretShapedGone, secretShapedPart, type AttachOptions, type MirrorBatch, type MirrorMeta, type WireEntry,
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

interface EdgeRule {
  MIRROR_SECRET_NAMES: readonly string[]
  MIRROR_SECRET_PREFIXES: readonly string[]
  MIRROR_SECRET_SUFFIX: RegExp
  secretShapedPart: (part: string) => boolean
  mirrorPathExcluded: (path: string) => boolean
  hiddenStoredPath: (path: string) => boolean
  publishableMirrorEntries: (entries: unknown) => Array<[string, WireEntry]>
}
const edgeRule = edge as EdgeRule
const TMP = '/dsh/home/.credentials.yaml.3fa9c1d2e4b5.tmp'
const TMP_2 = '/dsh/home/.credentials.yaml.77aa00bb11cc.tmp'
const LOCK = '/dsh/home/.credentials.yaml.lock'
const CREDENTIALS = '/dsh/home/.credentials.yaml'
const NOTE = '/dsh/home/auma/note.md'
const LINEAGE = '11111111-2222-4333-8444-555555555555'
const CLIENT = '0f0f0f0f-1111-4222-8333-444444444444'
/** Job 4: the shared rule table (the review's paths and atomic-write's real shapes), beside the edge's own test. */
const RULE_TABLE = JSON.parse(readFileSync(new URL('../../../../../deploy/cloudflare/src/__tests__/secret-path-rule-table.json', import.meta.url), 'utf8')) as {
  shaped: string[]
  ordinary: string[]
}
const PARTS = [
  ...MIRROR_SECRET_NAMES.flatMap(name => [name, `${name}.3fa9c1.tmp`, `${name}.3fa9.tmp`, `${name}~`, `${name}-old`, `${name}_bak`, `${name}-notes.md`,
    `.${name}.swp`, `.${name}~`, `${name}x`, `x${name}`]),
  ...RULE_TABLE.shaped, ...RULE_TABLE.ordinary,
  '.env', '.env.local', '.envrc', '.aukora-x6-vault', 'aukora-notes', 'pepper.v10', 'pepper.md', 'session.capture', 'credentials.md',
  'HANDOFF.md', 'sessions', '.sshconfig', 'awsome', 'transport', '.DS_Store', '.conflict-backup', 'ed25519-keypair.jsonl',
]

/** The edge mirror: one fence, its entries, and every path each delivery named. Refuses what the real mirror refuses. */
class FakeMirror {
  revision = 1
  entries = new Map<string, WireEntry>()
  posted: string[] = []
  /** Every delivery as sent: seq, digest and paths. */
  deliveries: Array<{ seq: number; digest: string; paths: string[] }> = []
  /** Receipts by batch id, as the edge keeps them: an exact replay gets its receipt before the path rule. */
  receipts = new Map<string, Record<string, unknown>>()
  fence() { return { protocol: 'x61-cloud-mirror/v1', lineageId: LINEAGE, revision: this.revision } }
  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (url.pathname === '/_mirror/status') return Response.json({ ok: true, ...this.fence(), runtime: 'cloudflare' })
    if (url.pathname === '/api/snapshot') {
      return Response.json({ ok: true, ...this.fence(), snapshotFormat: 'x61-mirror-snapshot/v2', resetPaths: [], entries: [...this.entries] })
    }
    if (url.pathname === '/_mirror/delta' && init?.method === 'POST') {
      const { batch, digest } = JSON.parse(init.body as string) as { batch: MirrorBatch['batch']; digest: string }
      this.posted.push(...batch.entries.map(([path]) => path))
      this.deliveries.push({ seq: batch.seq, digest, paths: batch.entries.map(([path]) => path) })
      const prior = this.receipts.get(batch.id)
      if (prior?.digest === digest) return Response.json({ ...prior, replayed: true })
      // The edge's own admission: a `gone` matching the secret-path rule is an applied no-op; any other excluded path refuses.
      let entries: Array<[string, WireEntry]>
      try { entries = edgeRule.publishableMirrorEntries(batch.entries) } catch { return Response.json({ ok: false, code: 'INVALID_MIRROR_PATH' }, { status: 400 }) }
      if (batch.cloudBase?.lineageId !== LINEAGE || batch.cloudBase.revision !== this.revision) {
        return Response.json({ ok: false, code: 'MIRROR_GLOBAL_FENCE_CONFLICT' }, { status: 409 })
      }
      for (const [path, wire] of entries) {
        if (wire.kind === 'gone') { for (const key of [...this.entries.keys()]) if (key === path || key.startsWith(path + '/')) this.entries.delete(key) }
        else this.entries.set(path, wire)
      }
      this.revision += 1
      const receipt = { ok: true, ...this.fence(), id: batch.id, clientId: batch.clientId, seq: batch.seq, digest,
        applied: batch.entries.length }
      this.receipts.set(batch.id, receipt)
      return Response.json(receipt)
    }
    return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 })
  }
}

const ROOTS = ['/dsh/home', '/dsh/workspace']
const FAST: AttachOptions = { read: { backoffMs: [0, 0], idleMs: 2_000, sleep: async () => {} }, resync: { firstMs: 20, maxMs: 80 } }
const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })
const file = (text: string): WireEntry => ({ kind: 'file', b64: Buffer.from(text).toString('base64'), mode: 0o644, mtimeMs: 1 })
let mirror: FakeMirror
let idb: FakeIndexedDb
const stored = (): Map<string, unknown> => idb.dbs.get('aukora-x6-vfs')?.data ?? new Map<string, unknown>()
const batchKey = (seq: number): string => `@x6-mirror-batch:${String(seq).padStart(16, '0')}`
const record = (seq: number, revision: number, entries: Array<[string, WireEntry]>): MirrorBatch => {
  const batch: MirrorBatch['batch'] = { clientId: CLIENT, seq, id: `${CLIENT}:${String(seq)}`, entries, cloudBase: { lineageId: LINEAGE, revision } }
  return { kind: 'mirror-batch', batch, digest: sha256HexSync(JSON.stringify(batch)) }
}

async function load(): Promise<MemoryVfs> {
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma', { recursive: true })
  vfs.mkdirSync('/dsh/workspace', { recursive: true })
  persistence.readOnly = false
  await attachIdbPersistence(vfs, ROOTS, FAST)
  return vfs
}
/** What `writeFileAtomic` under `withFileLock` does to the credentials document: lock, temp copy, rename, unlock. */
function atomicCredentialsWrite(vfs: MemoryVfs, temp: string): void {
  vfs.writeFileSync(LOCK, '{"pid":1}', { mode: 0o600 })
  vfs.writeFileSync(temp, 'version: 1\nrecords:\n  client-connection/browser-session: SYNTHETIC\n', { mode: 0o600 })
  vfs.renameSync(temp, CREDENTIALS)
  vfs.rmSync(LOCK, { force: true })
}
const secretKeys = (): string[] => [...stored().keys()].filter(key => key.includes('.credentials.yaml'))
const queuedPaths = (): string[] => [...stored()].filter(([key]) => key.startsWith('@x6-mirror-batch:'))
  .flatMap(([, value]) => (value as MirrorBatch).batch.entries.map(([path]) => path))

describe('one secret-shaped rule on both sides', () => {
  it('the browser and the cloud mirror hold the same list and the same predicate', () => {
    expect([...MIRROR_SECRET_NAMES]).toEqual([...edgeRule.MIRROR_SECRET_NAMES])
    expect([...MIRROR_SECRET_PREFIXES]).toEqual([...edgeRule.MIRROR_SECRET_PREFIXES])
    expect(String(MIRROR_SECRET_SUFFIX)).toBe(String(edgeRule.MIRROR_SECRET_SUFFIX))
    for (const part of PARTS) expect([part, secretShapedPart(part)]).toEqual([part, edgeRule.secretShapedPart(part)])
    for (const part of PARTS) {
      for (const path of [`/dsh/home/${part}`, `/dsh/home/auma/${part}`, `/dsh/workspace/${part}/inner.md`]) {
        expect([path, !cloudPathAllowed(path)]).toEqual([path, edgeRule.mirrorPathExcluded(path)])
      }
    }
  })

  it('a credentials temp, lock or backup sibling is never admitted to either outbox', () => {
    for (const path of [TMP, LOCK, '/dsh/home/credentials.yaml.bak', '/dsh/home/auma/session.cap.3fa9c1.tmp', '/dsh/home/auma/aumlok/pepper.v1.next',
      '/dsh/home/.ssh.bak/config']) {
      expect([path, cloudPathAllowed(path), outboxAdmits(path, false), outboxAdmits(path, true)]).toEqual([path, false, false, false])
    }
    // Job 4: ordinary names the rule no longer matches go to both outboxes like any other file.
    for (const path of [NOTE, '/dsh/home/auma/notes/pepper.v10', '/dsh/home/auma/session.capture.md', '/dsh/home/auma/credentials.yaml-notes.md',
      '/dsh/home/auma/session.cap.md', '/dsh/home/.transport-notes', '/dsh/workspace/.ssh-config-docs/readme.md', '/dsh/home/.credentials.yamlx']) {
      expect([path, cloudPathAllowed(path), outboxAdmits(path, false), outboxAdmits(path, true)]).toEqual([path, true, true, true])
    }
  })

  it('job 4: the drain lets through exactly the `gone` entries the edge takes as no-ops', () => {
    const paths = [TMP, LOCK, '/dsh/home/auma/aumlok/pepper.v1', '/dsh/workspace/.ssh/known_hosts', NOTE, '/dsh/home/balls/.credentials.yaml.tmp',
      '/dsh/home/../.credentials.yaml.tmp', '/dsh/home/.DS_Store/.credentials.yaml.tmp', '/dsh/home/auma/snapshots/.ssh', `/dsh/home/${'.credentials.yaml' + '.tmp'.repeat(70)}`]
    for (const path of paths) expect([path, secretShapedGone([path, { kind: 'gone' }])]).toEqual([path, edgeRule.hiddenStoredPath(path)])
    expect(secretShapedGone([TMP, { kind: 'file', b64: '', mode: 0o600, mtimeMs: 1 }])).toBe(false)
    expect(secretShapedGone([NOTE, { kind: 'gone' }])).toBe(false)
  })
})

describe('planSecretScrub: only a save holding a matching FILE or DIRECTORY entry changes, and only that entry', () => {
  it('turns such an entry into a `gone` at the same path; seq, id and cloud base stay; every other save is the same record', () => {
    const a = record(1, 7, [[TMP, { kind: 'gone' }], [LOCK, { kind: 'gone' }]])
    const b = record(2, 8, [[TMP, file('records: SYNTHETIC\n')]])
    const c = record(3, 9, [[NOTE, file('a\n')], [LOCK, { kind: 'dir', mode: 0o700 }], ['/dsh/home/auma/b.md', file('b\n')]])
    const d = record(4, 10, [['/dsh/home/auma/d.md', file('d\n')]])
    const plan = planSecretScrub([a, b, c, d])
    expect(plan?.dropped).toEqual([TMP, LOCK])
    const records = plan?.records ?? []
    // A save with no such entry (a `gone` matching the rule included) is returned as it was: never renumbered or re-digested.
    expect(records[0]).toBe(a)
    expect(records[3]).toBe(d)
    const shape = (item: MirrorBatch) => [item.batch.seq, item.batch.id, item.batch.cloudBase?.revision, item.batch.entries]
    expect(records.map(shape)).toEqual([
      shape(a), [2, `${CLIENT}:2`, 8, [[TMP, { kind: 'gone' }]]],
      [3, `${CLIENT}:3`, 9, [[NOTE, file('a\n')], [LOCK, { kind: 'gone' }], ['/dsh/home/auma/b.md', file('b\n')]]], shape(d),
    ])
    for (const item of records) expect(item.digest).toBe(sha256HexSync(JSON.stringify(item.batch)))
  })
  it('answers null for a queue with nothing to change (a clean queue, or only `gone` markers matching the rule)', () => {
    expect(planSecretScrub([record(1, 7, [[NOTE, file('a\n')]])])).toBeNull()
    expect(planSecretScrub([record(1, 7, [[TMP, { kind: 'gone' }], [NOTE, file('a\n')]])])).toBeNull()
    // A file the rule matches under a path the edge would refuse anyway (a ball path) is left for the drain guard.
    expect(planSecretScrub([record(1, 7, [['/dsh/home/balls/.credentials.yaml.tmp', file('x\n')]])])).toBeNull()
  })
})

describe('the credentials document written at every tree boot leaves nothing behind', () => {
  beforeEach(() => {
    mirror = new FakeMirror()
    mirror.entries.set('/dsh/home/auma', { kind: 'dir', mode: 0o755 })
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
  })

  it('a temp copy and lock never become a stored row, a tombstone, a reset root, or a delivery', async () => {
    const vfs = await load()
    // The exact shape atomic-write produces: `<file>.<12 hex>.tmp`, a fresh hex each boot.
    for (let boot = 0; boot < 3; boot += 1) atomicCredentialsWrite(vfs, boot === 0 ? TMP : `/dsh/home/.credentials.yaml.77aa00bb11c${String(boot)}.tmp`)
    vfs.writeFileSync(NOTE, 'saved alongside\n')
    await persistence.flush()
    await persistence.sync()
    expect(secretKeys()).toEqual([])
    expect(mirror.posted.filter(path => path.includes('.credentials.yaml'))).toEqual([])
    expect(mirror.posted).toContain(NOTE)
    const view = await persistence.inspect()
    expect(view.tombstoneRoots).toEqual({ count: 0, paths: [], truncated: false })
    expect(view.resetRoots).toEqual({ count: 0, paths: [], truncated: false })
    expect(persistence.mirror.conflict).toBeNull()
  })

  /** Saves queued after the browser's acknowledged base, each on the fence the one before it projects. Returns them as stored. */
  function plantQueue(meta: MirrorMeta, revision: number, saves: Array<Array<[string, WireEntry]>>): MirrorBatch[] {
    const data = stored()
    const planted = saves.map((entries, index): MirrorBatch => {
      const seq = meta.seq + 1 + index
      const batch: MirrorBatch['batch'] = { clientId: meta.clientId, seq, id: `${meta.clientId}:${String(seq)}`, entries,
        cloudBase: { lineageId: LINEAGE, revision: revision + index } }
      const item: MirrorBatch = { kind: 'mirror-batch', batch, digest: sha256HexSync(JSON.stringify(batch)) }
      data.set(batchKey(seq), item)
      return structuredClone(item)
    })
    data.set('@x6-mirror-meta', { ...meta, seq: meta.seq + saves.length })
    return planted
  }
  async function bootMeta(): Promise<MirrorMeta> {
    await load()
    await pause(50)
    const meta = stored().get('@x6-mirror-meta') as MirrorMeta
    expect(meta.cloudBase).toEqual({ lineageId: LINEAGE, revision: 1 })
    return meta
  }

  it('rows stored before the rule are ignored at boot; queued `gone` markers go as queued, the edge takes them as no-ops', async () => {
    const meta = await bootMeta()
    const data = stored()
    // What 1,695 boots left in her browser, in miniature: tombstones, reset roots, and queued saves naming the temp copies.
    for (const path of [TMP, TMP_2, LOCK]) {
      data.set(path, { kind: 'gone' })
      data.set(`@x6-vfs-reset:${path}`, { kind: 'subtree-reset', path })
    }
    const queued = plantQueue(meta, 1, [[[TMP, { kind: 'gone' }], [LOCK, { kind: 'gone' }]], [[TMP_2, { kind: 'gone' }], [NOTE, file('queued before the rule\n')]]])

    await load()
    const view = await persistence.inspect()
    expect(view.tombstoneRoots).toEqual({ count: 0, paths: [], truncated: false })
    expect(view.resetRoots).toEqual({ count: 0, paths: [], truncated: false })
    await persistence.sync()
    // Job 4: never rewritten; each save keeps its digest (it may be a replay), and only names travel, never content.
    expect(mirror.deliveries.map(({ seq, digest }) => [seq, digest])).toEqual(queued.map(item => [item.batch.seq, item.digest]))
    expect([...mirror.entries.keys()].sort()).toEqual(['/dsh/home/auma', NOTE])
    expect(Buffer.from((mirror.entries.get(NOTE) as { b64: string }).b64, 'base64').toString()).toBe('queued before the rule\n')
    expect(queuedPaths()).toEqual([])
    expect(persistence.mirror.conflict).toBeNull()
    expect((stored().get('@x6-mirror-meta') as MirrorMeta).cloudAcknowledgedSeq).toBe(meta.seq + 2)
  })

  it('job 4: a lost acknowledgement: the replay of a save holding a matching `gone` goes unchanged, gets its receipt, and the saves behind it flow', async () => {
    const meta = await bootMeta()
    const [first, second] = plantQueue(meta, 1, [[[TMP, { kind: 'gone' }], [NOTE, file('x\n')]], [['/dsh/home/auma/after.md', file('after\n')]]])
    if (first === undefined || second === undefined) throw new Error('two saves planted')
    // The cloud applied the first save; its answer never reached this browser.
    mirror.entries.set(NOTE, file('x\n'))
    mirror.revision = 2
    mirror.receipts.set(first.batch.id, { ok: true, ...mirror.fence(), id: first.batch.id, clientId: first.batch.clientId,
      seq: first.batch.seq, digest: first.digest, applied: 2 })
    await load()
    await persistence.sync()
    expect(mirror.deliveries.map(({ seq, digest }) => [seq, digest]))
      .toEqual([[first.batch.seq, first.digest], [second.batch.seq, second.digest]])
    expect(Buffer.from((mirror.entries.get('/dsh/home/auma/after.md') as { b64: string }).b64, 'base64').toString()).toBe('after\n')
    expect(queuedPaths()).toEqual([])
    expect(persistence.mirror.conflict).toBeNull()
    const after = stored().get('@x6-mirror-meta') as MirrorMeta
    expect([after.cloudAcknowledgedSeq, after.cloudBase]).toEqual([meta.seq + 2, { lineageId: LINEAGE, revision: 3 }])
  })

  it('job 4: a save holding a matching FILE entry, in step: only that entry becomes `gone`; no other save is renumbered or re-digested', async () => {
    const meta = await bootMeta()
    const queued = plantQueue(meta, 1, [[[NOTE, file('first\n')]], [[TMP, file('records: SYNTHETIC\n')]], [['/dsh/home/auma/c.md', file('c\n')]]])
    await load()
    await persistence.sync()
    const [a, b, c] = queued
    if (a === undefined || b === undefined || c === undefined) throw new Error('three saves planted')
    const changed = { ...b.batch, entries: [[TMP, { kind: 'gone' }]] }
    expect(mirror.deliveries.map(({ seq, digest, paths }) => [seq, digest, paths])).toEqual([
      [a.batch.seq, a.digest, [NOTE]], [b.batch.seq, sha256HexSync(JSON.stringify(changed)), [TMP]], [c.batch.seq, c.digest, ['/dsh/home/auma/c.md']],
    ])
    expect([...mirror.entries.keys()].sort()).toEqual(['/dsh/home/auma', '/dsh/home/auma/c.md', NOTE])
    expect(JSON.stringify([...mirror.entries.values()]).includes(Buffer.from('records: SYNTHETIC\n').toString('base64'))).toBe(false)
    expect(persistence.mirror.conflict).toBeNull()
  })

  it('job 4: a queue whose stored bytes fail their digest is never re-digested by the scrub (offline boot, then the cloud answers)', async () => {
    const meta = await bootMeta()
    const [a, b] = plantQueue(meta, 1, [[[TMP, file('records: SYNTHETIC\n')], [NOTE, file('a\n')]], [['/dsh/home/auma/b.md', file('b\n')]]])
    if (a === undefined || b === undefined) throw new Error('two saves planted')
    // The second save's bytes changed on disk after its digest was taken.
    const corrupted = { ...b, batch: { ...b.batch, entries: [['/dsh/home/auma/b.md', file('CORRUPTED\n')]] } }
    stored().set(batchKey(b.batch.seq), corrupted)
    const before = structuredClone([stored().get(batchKey(a.batch.seq)), stored().get(batchKey(b.batch.seq))])
    vi.stubGlobal('fetch', async () => { throw new TypeError('offline') })
    await load()
    vi.stubGlobal('fetch', mirror.fetch)
    await persistence.sync().catch(() => {})
    expect([stored().get(batchKey(a.batch.seq)), stored().get(batchKey(b.batch.seq))]).toEqual(before)
    expect(mirror.posted.includes('/dsh/home/auma/b.md')).toBe(false)
    expect(mirror.entries.has('/dsh/home/auma/b.md')).toBe(false)
    expect(persistence.mirror.conflict).not.toBeNull()
  })

  it('job 4: an ordinary name the narrower rule no longer matches is stored in this browser and saved to the cloud', async () => {
    const vfs = await load()
    for (const path of ['/dsh/home/.credentials.yaml-notes.md', '/dsh/home/auma/credentials.yaml-notes.md', '/dsh/home/.afferent-probe-notes.md']) {
      vfs.writeFileSync(path, `${path}\n`)
    }
    await persistence.flush()
    await persistence.sync()
    for (const path of ['/dsh/home/.credentials.yaml-notes.md', '/dsh/home/auma/credentials.yaml-notes.md', '/dsh/home/.afferent-probe-notes.md']) {
      expect([path, stored().has(path), mirror.entries.has(path)]).toEqual([path, true, true])
    }
    expect(persistence.mirror.conflict).toBeNull()
  })

  it('under the Mac host a queued save is never rewritten (the host may already hold it): it goes as it was queued', async () => {
    // The Mac host's own mirror: no fence, it takes what the old outbox admitted for it, and acknowledges every save.
    const posted: Array<{ seq: number; digest: string; paths: string[] }> = []
    vi.stubGlobal('location', { origin: 'http://localhost:4610', hostname: 'localhost' })
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input))
      if (url.pathname === '/api/snapshot') return Response.json({ ok: true, entries: [['/dsh/home/auma', { kind: 'dir', mode: 0o755 }]] })
      if (url.pathname === '/_mirror/delta' && init?.method === 'POST') {
        const { batch, digest } = JSON.parse(init.body as string) as { batch: MirrorBatch['batch']; digest: string }
        posted.push({ seq: batch.seq, digest, paths: batch.entries.map(([path]) => path) })
        return Response.json({ ok: true, id: batch.id, clientId: batch.clientId, seq: batch.seq, digest, applied: batch.entries.length })
      }
      return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 })
    })
    const first = await load()
    first.writeFileSync('/dsh/home/auma/first.md', 'first\n')
    await persistence.flush()
    await persistence.sync()
    const data = stored()
    const meta = data.get('@x6-mirror-meta') as MirrorMeta
    expect(meta.cloudBase).toBeUndefined()
    const batch: MirrorBatch['batch'] = { clientId: meta.clientId, seq: meta.seq + 1, id: `${meta.clientId}:${String(meta.seq + 1)}`,
      entries: [[TMP, { kind: 'gone' }], [NOTE, file('queued for the host\n')]] }
    const queued: MirrorBatch = { kind: 'mirror-batch', batch, digest: sha256HexSync(JSON.stringify(batch)) }
    data.set(batchKey(meta.seq + 1), queued)
    data.set('@x6-mirror-meta', { ...meta, seq: meta.seq + 1 })
    await load()
    await persistence.sync()
    expect(posted.filter(item => item.seq === meta.seq + 1)).toEqual([{ seq: meta.seq + 1, digest: queued.digest, paths: [TMP, NOTE] }])
    expect(persistence.mirror.conflict).toBeNull()
  })
})

describe('Review: the browser\'s rule answers in time linear in the name', () => {
  it('a 255-byte chain of digit segments is judged within 50 ms by every browser reader, and called ordinary', () => {
    // Digit segments that both the hex and the digits tokens match, then a character the rule fails: grown to 255 bytes.
    const chain = (n: number): string => `credentials.yaml${'.111111'.repeat(n)}x`
    expect(new TextEncoder().encode(chain(34)).byteLength).toBe(255)
    for (let n = 22; n <= 34; n += 1) {
      const part = chain(n)
      const path = `/dsh/home/auma/${part}`
      for (const [label, call, expected] of [
        ['secretShapedPart', () => secretShapedPart(part), false],
        ['cloudPathAllowed', () => cloudPathAllowed(path), true],
        ['outboxAdmits (cloud)', () => outboxAdmits(path, false), true],
        ['outboxAdmits (Mac host)', () => outboxAdmits(path, true), true],
        ['secretShapedGone', () => secretShapedGone([path, { kind: 'gone' }]), false],
      ] as const) {
        const started = performance.now()
        const answer = call()
        const elapsed = performance.now() - started
        expect([label, part.length, answer, elapsed < 50]).toEqual([label, part.length, expected, true])
      }
    }
    expect(secretShapedPart(chain(34).slice(0, -1))).toBe(true)
  })
})

describe('job 5: the dotted stem and the trailing tilde are in the browser\'s rule', () => {
  it('the browser copy answers the shared table itself, and keeps those names out of both outboxes', () => {
    for (const part of RULE_TABLE.shaped) expect([part, secretShapedPart(part)]).toEqual([part, true])
    for (const part of RULE_TABLE.ordinary) expect([part, secretShapedPart(part)]).toEqual([part, false])
    for (const path of ['/dsh/home/.session.cap', '/dsh/home/auma/.ed25519-keypair.json', '/dsh/home/..credentials.yaml', '/dsh/home/.session.cap~',
      '/dsh/home/credentials.yaml.bak~', '/dsh/home/.credentials.yaml.lock.takeover-0123456789abcdef']) {
      expect([path, cloudPathAllowed(path), outboxAdmits(path, false), outboxAdmits(path, true)]).toEqual([path, false, false, false])
    }
    for (const path of ['/dsh/home/auma/.session.capx', '/dsh/home/auma/session.cap.takeover-notes.md', '/dsh/home/auma/session.capture']) {
      expect([path, cloudPathAllowed(path), outboxAdmits(path, false), outboxAdmits(path, true)]).toEqual([path, true, true, true])
    }
  })

  it('the longest takeover-and-tilde chain of a 255-byte part is judged within 50 ms by every browser reader', () => {
    // The dotted stem, `~takeover~111111` segments, then one trailing `~` (shaped) or a failing character in its place.
    const body = `..credentials.yaml${'~takeover~111111'.repeat(14)}.111111.1234`
    for (const [part, shaped] of [[`${body}~`, true], [`${body}x`, false]] as const) {
      expect(new TextEncoder().encode(part).byteLength).toBe(255)
      const path = `/dsh/home/auma/${part}`
      for (const [label, call, expected] of [
        ['secretShapedPart', () => secretShapedPart(part), shaped],
        ['cloudPathAllowed', () => cloudPathAllowed(path), !shaped],
        ['outboxAdmits (cloud)', () => outboxAdmits(path, false), !shaped],
        ['outboxAdmits (Mac host)', () => outboxAdmits(path, true), !shaped],
        ['secretShapedGone', () => secretShapedGone([path, { kind: 'gone' }]), shaped],
      ] as const) {
        const started = performance.now()
        const answer = call()
        const elapsed = performance.now() - started
        expect([label, part.slice(-2), answer, elapsed < 50]).toEqual([label, part.slice(-2), expected, true])
      }
    }
  })
})
