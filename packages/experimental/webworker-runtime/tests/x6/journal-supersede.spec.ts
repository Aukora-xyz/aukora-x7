import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256HexSync } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  APPEND_ONLY_JOURNALS, attachIdbPersistence, classifyCloudFence, cloudAdmission, cloudOutboxExcluded, cloudPathAllowed,
  FRESH_SIGN_IN_MESSAGE,
  conflictBackupExcluded,
  criticalCloudPath, deferredJournal, deliveryDeadlineMs, deliveryNeverApplied, deliveryRefusal, extendsJournal, JOURNAL_BACKUP_ROOT,
  journalRetryMs, mergeCause, MIRROR_READ_POLICY, outboxAdmits,
  persistence, SESSION_JOURNAL_POLICY,
  planCloudResync, planJournalSupersede, readWithRetry, rewriteQueuedJournals, snapshotDumpExcluded, transientStatus,
  type AttachOptions, type CloudBase, type Entry, type MirrorBatch, type MirrorMeta, type ReconciliationCause, type WireEntry,
} from '../../src/storage/idb-persist.ts'

const RECEIPTS = '/dsh/home/auma/seed/receipts.v3.jsonl'
const SEED = '/dsh/home/auma/seed'
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const b64 = (text: string): string => btoa(text)
const lines = (count: number): string => Array.from({ length: count }, (_, index) => `{"seq":${String(index + 1)}}\n`).join('')
const file = (text: string): WireEntry => ({ kind: 'file', b64: b64(text), mode: 0o644, mtimeMs: 1 })
const CLIENT = '0f0e0d0c-0b0a-4908-8706-050403020100'
function queuedBatch(seq: number, entries: Array<[string, WireEntry]>): MirrorBatch {
  const batch = { clientId: CLIENT, seq, id: `${CLIENT}:${String(seq)}`, entries }
  return { kind: 'mirror-batch', batch, digest: sha256HexSync(JSON.stringify(batch)) }
}

describe('append-only journals: a longer mirror copy is not held back by older unsent saves', () => {
  it('covers the receipt chain and its checkpoints', () => {
    expect([...APPEND_ONLY_JOURNALS]).toEqual([RECEIPTS, `${SEED}/checkpoints.v1.jsonl`])
  })

  it('extends only on whole-line byte prefixes of a strictly longer copy', () => {
    expect(extendsJournal(encode(lines(64)), encode(lines(85)))).toBe(true)
    expect(extendsJournal(encode(''), encode(lines(1)))).toBe(true)
    expect(extendsJournal(encode(lines(85)), encode(lines(85)))).toBe(false)
    expect(extendsJournal(encode(lines(85)), encode(lines(64)))).toBe(false)
    expect(extendsJournal(encode('{"seq":1'), encode(lines(2)))).toBe(false)
    expect(extendsJournal(encode('{"seq":9}\n'), encode(lines(2)))).toBe(false)
  })

  it('the Round 16 case: a 64-line tab and a queued 64-line write give way to the 85-line mirror', () => {
    const queued: Array<[string, WireEntry]> = [[SEED, { kind: 'dir', mode: 0o755 }], [RECEIPTS, file(lines(60))], [RECEIPTS, file(lines(64))]]
    expect(planJournalSupersede(RECEIPTS, encode(lines(85)), encode(lines(64)), queued, [])).toBe('supersede')
    expect(planJournalSupersede(RECEIPTS, encode(lines(85)), encode(lines(85)), queued, [])).toBe('supersede')
  })

  it('keeps the local copy when any local copy has lines the mirror lacks', () => {
    const forked = `${lines(64)}{"seq":65,"tab":"only"}\n`
    expect(planJournalSupersede(RECEIPTS, encode(lines(85)), encode(forked), [], [])).toBe('diverged')
    expect(planJournalSupersede(RECEIPTS, encode(lines(85)), encode(lines(64)), [[RECEIPTS, file(forked)]], [])).toBe('diverged')
    expect(planJournalSupersede(RECEIPTS, encode(lines(64)), encode(lines(85)), [], [])).toBe('diverged')
  })

  it('never overrides deletions, other paths, a missing local file or a tombstoned parent', () => {
    const mirror = encode(lines(85)), local = encode(lines(64))
    expect(planJournalSupersede(`${SEED}/notes.md`, mirror, local, [], [])).toBe('not-applicable')
    expect(planJournalSupersede(RECEIPTS, mirror, null, [], [])).toBe('not-applicable')
    expect(planJournalSupersede(RECEIPTS, mirror, local, [[RECEIPTS, { kind: 'gone' }]], [])).toBe('not-applicable')
    expect(planJournalSupersede(RECEIPTS, mirror, local, [[SEED, { kind: 'gone' }]], [])).toBe('not-applicable')
    expect(planJournalSupersede(RECEIPTS, mirror, local, [], [SEED])).toBe('not-applicable')
  })

  it('rewrites only the superseded journal in a queued batch, keeping seq, order and a valid digest', () => {
    const other: [string, WireEntry] = [`${SEED}/notes.md`, file('hello\n')]
    const record = queuedBatch(7, [other, [RECEIPTS, file(lines(64))]])
    const mirror = { bytes: encode(lines(85)), mode: 0o600, mtimeMs: 42 }
    const rewritten = rewriteQueuedJournals(record, new Map([[RECEIPTS, mirror]]))
    expect(rewritten).not.toBeNull()
    expect(rewritten?.batch.seq).toBe(7)
    expect(rewritten?.batch.id).toBe(record.batch.id)
    expect(rewritten?.batch.entries[0]).toEqual(other)
    expect(rewritten?.batch.entries[1]).toEqual([RECEIPTS, { kind: 'file', b64: b64(lines(85)), mode: 0o600, mtimeMs: 42 }])
    expect(rewritten?.digest).toBe(sha256HexSync(JSON.stringify(rewritten?.batch)))
    expect(rewritten?.digest).not.toBe(record.digest)
    expect(rewriteQueuedJournals(queuedBatch(8, [other]), new Map([[RECEIPTS, mirror]]))).toBeNull()
  })
})

describe('conflict backups stay local: the cloud outbox drops them, the Mac host keeps them', () => {
  it('any .conflict-backup segment is excluded from cloud deltas, and nothing else new is', () => {
    for (const path of [
      `${SEED}/.conflict-backup`,
      `${SEED}/.conflict-backup/receipts.v3.jsonl.0123456789abcdef.bak`,
      `${SEED}/.conflict-backup/receipts.v3.jsonl.local-64lines`,
      '/dsh/workspace/project/.conflict-backup/notes.md',
    ]) {
      expect([path, conflictBackupExcluded(path), cloudOutboxExcluded(path)]).toEqual([path, true, true])
      expect([path, outboxAdmits(path, false)]).toEqual([path, false])
      expect([path, outboxAdmits(path, true)]).toEqual([path, true])
    }
    for (const path of [RECEIPTS, `${SEED}/conflict-backup/x`, `${SEED}/.conflict-backups/x`, '/dsh/home/auma/snapshots/LATEST.json']) {
      expect([path, cloudOutboxExcluded(path), outboxAdmits(path, false)]).toEqual([path, false, true])
    }
  })
  it('snapshot dumps are still dropped from the cloud outbox exactly as before', () => {
    const dump = '/dsh/home/auma/snapshots/d3620ad73f50553db7d3d967b97701023316ec29ebc858020e9915e2c7a2cd79.json'
    expect([snapshotDumpExcluded(dump), cloudOutboxExcluded(dump), outboxAdmits(dump, false), outboxAdmits(dump, true)])
      .toEqual([true, true, false, true])
  })
  it('a cloud batch queued before this rule, holding a backup, stops at the drain guard instead of being sent', () => {
    expect(cloudPathAllowed(`${SEED}/.conflict-backup/receipts.v3.jsonl.local-64lines`)).toBe(false)
    expect(cloudPathAllowed(RECEIPTS)).toBe(true)
  })
  it('the AUMLOK escrow pepper never enters any mirror payload, local or cloud (Round 22)', () => {
    for (const path of ['/dsh/home/auma/pepper.v1', '/dsh/home/auma/aumlok/pepper.v1', '/dsh/workspace/pepper.v1.json', '/dsh/home/pepper.v1/x']) {
      expect([path, outboxAdmits(path, false), outboxAdmits(path, true), cloudPathAllowed(path)]).toEqual([path, false, false, false])
    }
    for (const path of ['/dsh/home/auma/pepper.md', '/dsh/home/auma/notes/pepper.v10']) {
      expect([path, outboxAdmits(path, false), cloudPathAllowed(path)]).toEqual([path, true, true])
    }
  })
  it('the supersede writes its backups under a .conflict-backup directory', () => {
    expect(conflictBackupExcluded(`${JOURNAL_BACKUP_ROOT}/receipts.v3.jsonl.0123456789abcdef.bak`)).toBe(true)
  })
})

// ── ROUND 19: CLOUD-SYNC LOCKOUT FIXES (cloud audit A6, A26-A29) ────────────────────────────────────────────────────

/**
 * A small in-memory IndexedDB: one database, one object store, string keys in code-unit order, structured-clone
 * values, transactions that run one at a time (readonly ones may overlap) and commit when no request is pending after
 * a task turn, as the real one does. Only what idb-persist calls is here.
 */
class FakeRequest<T = unknown> {
  result!: T
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

/** A cloud mirror with one fence, its entries, and per-batch receipts; it fences, replays and refuses as mirror-do does. */
class FakeCloud {
  lineageId = '11111111-2222-4333-8444-555555555555'
  revision = 1
  entries = new Map<string, WireEntry>()
  receipts = new Map<string, Record<string, unknown>>()
  reachable = true
  loseNextAck = false
  posts = 0
  reads = new Map<string, number>()
  /** A status every delivery answers with until cleared (401, 503, 413 ...), with an optional error code. */
  deliveryRefusal: { status: number; code: string } | null = null
  /** The Mac host: the local ordered protocol, with no cloud fence on batches. */
  local = false
  /** The entry paths of every delivery, in the order they arrived. */
  posted: string[][] = []
  /** The query string of every fence read. */
  statusQueries: string[] = []
  /** The fence read answers 503 while set (the delta route still works). */
  statusFails = false
  /** Every read answers 401 while set: the owner's session is missing on this browser. */
  signedOut = false
  /** Answer one delivery by its paths: a refusal, null to apply it, or a throw for no answer at all. */
  answer: ((paths: string[]) => Promise<{ status: number; code: string } | null>) | null = null
  constructor() { this.entries.set('/dsh/home/auma', { kind: 'dir', mode: 0o755 }) }
  fence() { return { protocol: 'x61-cloud-mirror/v1', lineageId: this.lineageId, revision: this.revision } }
  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (!this.reachable) throw new TypeError('fetch failed')
    this.reads.set(url.pathname, (this.reads.get(url.pathname) ?? 0) + 1)
    if (this.signedOut) return Response.json({ ok: false, code: 'OWNER_SESSION_REQUIRED' }, { status: 401 })
    if (url.pathname === '/_mirror/status') {
      this.statusQueries.push(url.search)
      if (this.statusFails) return Response.json({ ok: false, code: 'MIRROR_STORAGE_FAILED' }, { status: 503 })
      return Response.json({ ok: true, ...this.fence(), runtime: 'cloudflare' })
    }
    if (url.pathname === '/api/snapshot') {
      return Response.json({ ok: true, ...this.fence(), snapshotFormat: 'x61-mirror-snapshot/v2', resetPaths: [], entries: [...this.entries] })
    }
    if (url.pathname === '/_mirror/delta' && init?.method === 'POST') {
      this.posts += 1
      const { batch, digest } = JSON.parse(String(init.body)) as { batch: MirrorBatch['batch']; digest: string }
      this.posted.push(batch.entries.map(([path]) => path))
      const refusal = this.deliveryRefusal ?? (this.answer === null ? null : await this.answer(batch.entries.map(([path]) => path)))
      if (refusal) return Response.json({ ok: false, code: refusal.code }, { status: refusal.status })
      const existing = this.receipts.get(batch.id)
      // As mirror-do: a known id replays its receipt; the same id with other bytes is a replay conflict.
      if (existing && existing.digest !== digest) {
        return Response.json({ ok: false, code: 'MIRROR_REPLAY_CONFLICT', conflictCode: 'MIRROR_REPLAY_CONFLICT' }, { status: 409 })
      }
      if (existing) return Response.json({ ...existing, replayed: true })
      if (!this.local && (batch.cloudBase?.lineageId !== this.lineageId || batch.cloudBase.revision !== this.revision)) {
        return Response.json({ ok: false, code: 'MIRROR_GLOBAL_FENCE_CONFLICT' }, { status: 409 })
      }
      for (const [path, wire] of batch.entries) {
        if (wire.kind === 'gone') { for (const key of [...this.entries.keys()]) if (key === path || key.startsWith(path + '/')) this.entries.delete(key) }
        else this.entries.set(path, wire)
      }
      this.revision += 1
      const receipt = {
        ok: true, ...this.fence(), id: batch.id, clientId: batch.clientId, seq: batch.seq, digest, applied: batch.entries.length,
      }
      this.receipts.set(batch.id, receipt)
      if (this.loseNextAck) { this.loseNextAck = false; throw new TypeError('connection reset after commit') }
      return Response.json(receipt)
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
const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })
let idb: FakeIndexedDb
let cloud: FakeCloud

async function boot(options: AttachOptions = FAST): Promise<MemoryVfs> {
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma', { recursive: true })
  vfs.mkdirSync('/dsh/workspace', { recursive: true })
  persistence.readOnly = false
  await attachIdbPersistence(vfs, ROOTS, options)
  return vfs
}
async function save(vfs: MemoryVfs, path: string, text: string): Promise<void> {
  vfs.writeFileSync(path, text)
  await persistence.flush().catch(() => {})
}
async function rows(): Promise<Map<string, unknown>> { return idb.dbs.get('aukora-x6-vfs')?.data ?? new Map() }
const marker = async () => (await rows()).get('@x6-cloud-reconciliation') as { cause?: string } | undefined
const queuedCount = async () => [...(await rows()).keys()].filter(key => key.startsWith('@x6-mirror-batch:')).length
/** A chat journal path (synthetic session id), and a body past the 2 MiB lane threshold. */
const JOURNAL = '/dsh/home/sessions/--dsh-home-auma-one--/session-00000000/session.v4.jsonl'
const big = (fill: string): string => `${fill.repeat(SESSION_JOURNAL_POLICY.minBytes + 4096)}\n`
const journalDir = (vfs: MemoryVfs): void => { vfs.mkdirSync(JOURNAL.slice(0, JOURNAL.lastIndexOf('/')), { recursive: true }) }
const waitingJournal = async () => (await rows()).get(`@x6-deferred-journal:${JOURNAL}`) as { notBefore: number; failures: number } | undefined
async function until(check: () => boolean): Promise<void> { for (let i = 0; i < 100 && !check(); i += 1) await pause(20) }

describe('a cloud browser is never locked out by a transient failure', () => {
  beforeEach(() => {
    idb = new FakeIndexedDb()
    cloud = new FakeCloud()
    vi.stubGlobal('indexedDB', idb)
    vi.stubGlobal('IDBKeyRange', FakeKeyRange)
    vi.stubGlobal('location', { origin: 'https://node.example.invalid', hostname: 'node.example.invalid' })
    vi.stubGlobal('fetch', cloud.fetch)
  })
  afterEach(async () => {
    persistence.readOnly = true
    await pause(120)
    vi.unstubAllGlobals()
  })

  // AUMLOK HANDOFF-4 REQUEST 1: a 401 on the first snapshot said "answered 401"; it now says the owner must sign in.
  it('a fresh browser refused for want of the owner\'s session says she needs the owner to sign in, and keeps saying it', async () => {
    cloud.signedOut = true
    const vfs = await boot()
    expect(persistence.mirror.transient).toBe(FRESH_SIGN_IN_MESSAGE)
    expect(persistence.mirror.transient).toMatch(/sign in/)
    expect(persistence.mirror.transient).not.toMatch(/answered 401/)
    vfs.writeFileSync('/dsh/home/auma/note.md', 'not kept\n')
    await expect(persistence.flush()).rejects.toThrow(/sign in/)
    expect(await persistence.retryCloudSync()).toBe('unreachable')
    expect(persistence.mirror.transient).toBe(FRESH_SIGN_IN_MESSAGE)
    cloud.signedOut = false
    expect(await persistence.retryCloudSync()).toBe('reload-required')
    expect(persistence.mirror.transient).toMatch(/^MIRROR_CLOUD_REACHABLE/)
  })

  it('a fresh browser initializes from the cloud and delivers its saves under the fence', async () => {
    const vfs = await boot()
    expect(persistence.mirror.conflict).toBeNull()
    await save(vfs, '/dsh/home/auma/note.md', 'one\n')
    await persistence.sync()
    expect(cloud.text('/dsh/home/auma/note.md')).toBe('one\n')
    expect(cloud.revision).toBe(2)
  })

  it('A6: a returning browser whose cloud does not answer keeps saving, marks the hold transient, and resyncs when it answers', async () => {
    let vfs = await boot()
    await save(vfs, '/dsh/home/auma/a.md', 'a\n'); await persistence.sync()
    cloud.reachable = false
    vfs = await boot()
    expect(persistence.mirror.conflict).toBeNull()
    expect(persistence.mirror.transient).toMatch(/^MIRROR_CLOUD_UNREACHABLE/)
    await save(vfs, '/dsh/home/auma/b.md', 'held\n')
    expect((await marker())?.cause).toBe('transient')
    expect(persistence.mirror.reconciliationRequired).toBe(false)
    expect(await queuedCount()).toBe(0)
    cloud.reachable = true
    expect(await persistence.retryCloudSync()).toBe('resynced')
    await persistence.sync()
    expect(cloud.text('/dsh/home/auma/b.md')).toBe('held\n')
    expect(await marker()).toBeUndefined()
    expect(persistence.mirror.transient).toBeNull()
    await save(vfs, '/dsh/home/auma/c.md', 'after\n'); await persistence.sync()
    expect(cloud.text('/dsh/home/auma/c.md')).toBe('after\n')
  })

  it('the automatic retry resends a transient hold without anyone asking', async () => {
    let vfs = await boot()
    await save(vfs, '/dsh/home/auma/a.md', 'a\n'); await persistence.sync()
    cloud.reachable = false
    vfs = await boot()
    await save(vfs, '/dsh/home/auma/auto.md', 'auto\n')
    cloud.reachable = true
    for (let i = 0; i < 50 && cloud.text('/dsh/home/auma/auto.md') === null; i += 1) await pause(20)
    expect(cloud.text('/dsh/home/auma/auto.md')).toBe('auto\n')
    expect(await marker()).toBeUndefined()
  })

  it('fails closed when the cloud moved while this browser was away: nothing is sent, the hold becomes genuine', async () => {
    let vfs = await boot()
    await save(vfs, '/dsh/home/auma/a.md', 'a\n'); await persistence.sync()
    cloud.reachable = false
    vfs = await boot()
    await save(vfs, '/dsh/home/auma/mine.md', 'mine\n')
    cloud.revision += 1
    cloud.entries.set('/dsh/home/auma/theirs.md', { kind: 'file', b64: btoa('theirs\n'), mode: 0o644, mtimeMs: 1 })
    cloud.reachable = true
    const postsBefore = cloud.posts
    expect(await persistence.retryCloudSync()).toBe('conflict')
    expect((await marker())?.cause).toBe('genuine')
    expect(persistence.mirror.reconciliationRequired).toBe(true)
    expect(cloud.text('/dsh/home/auma/mine.md')).toBeNull()
    await persistence.sync().catch(() => {})
    expect(cloud.posts).toBe(postsBefore)
  })

  it('A27: a reload after the cloud committed a save whose acknowledgement was lost replays it instead of locking', async () => {
    let vfs = await boot()
    await save(vfs, '/dsh/home/auma/a.md', 'a\n'); await persistence.sync()
    cloud.loseNextAck = true
    await save(vfs, '/dsh/home/auma/lost-ack.md', 'committed\n')
    await persistence.sync().catch(() => {})
    expect(cloud.text('/dsh/home/auma/lost-ack.md')).toBe('committed\n')
    expect(await queuedCount()).toBe(1)
    vfs = await boot()
    expect(persistence.mirror.conflict).toBeNull()
    await persistence.sync()
    expect(await queuedCount()).toBe(0)
    await save(vfs, '/dsh/home/auma/next.md', 'next\n'); await persistence.sync()
    expect(cloud.text('/dsh/home/auma/next.md')).toBe('next\n')
    expect(await marker()).toBeUndefined()
  })

  it('a fresh browser whose cloud never answered saves nothing, so its next load can still initialize', async () => {
    cloud.reachable = false
    const vfs = await boot()
    expect(persistence.mirror.transient).toMatch(/nothing is saved here/)
    vfs.writeFileSync('/dsh/home/auma/image-only.md', 'not her memory\n')
    await expect(persistence.flush()).rejects.toThrow(/MIRROR_CLOUD_UNREACHABLE/)
    expect(((await rows()).get('@x6-content-revision') as { seq: number }).seq).toBe(0)
    cloud.reachable = true
    expect(await persistence.retryCloudSync()).toBe('reload-required')
    await boot()
    expect(persistence.mirror.conflict).toBeNull()
    expect(persistence.mirror.transient).toBeNull()
  })

  it('A29: a name the cloud cannot hold is kept in this browser and named; the rest of the save goes out', async () => {
    const vfs = await boot()
    const odd = `/dsh/workspace/${'n'.repeat(300)}.md`
    vfs.writeFileSync(odd, 'too long a name\n')
    await save(vfs, '/dsh/home/auma/fine.md', 'fine\n')
    await persistence.sync()
    expect(cloud.text('/dsh/home/auma/fine.md')).toBe('fine\n')
    expect(cloud.entries.has(odd)).toBe(false)
    expect(persistence.mirror.quarantinedPaths).toContain(odd)
    expect(await marker()).toBeUndefined()
    expect(persistence.mirror.conflict).toBeNull()
  })

  it('a legacy hold (no cause) is re-sent only while the cloud is exactly where this browser left it', async () => {
    let vfs = await boot()
    await save(vfs, '/dsh/home/auma/a.md', 'a\n'); await persistence.sync()
    cloud.reachable = false
    vfs = await boot()
    await save(vfs, '/dsh/home/auma/legacy.md', 'legacy\n')
    const db = idb.dbs.get('aukora-x6-vfs')
    const record = db?.data.get('@x6-cloud-reconciliation') as Record<string, unknown>
    delete record.cause
    db?.data.set('@x6-cloud-reconciliation', record)
    cloud.reachable = true
    vfs = await boot()
    expect(persistence.mirror.reconciliationRequired).toBe(true)
    expect(cloud.text('/dsh/home/auma/legacy.md')).toBeNull()
    expect(await persistence.retryCloudSync()).toBe('resynced')
    await persistence.sync()
    expect(cloud.text('/dsh/home/auma/legacy.md')).toBe('legacy\n')
    expect(persistence.mirror.reconciliationRequired).toBe(false)
    expect(persistence.mirror.conflict).toBeNull()
  })

  it('A6: a slow snapshot that keeps arriving loads; one that stalls past the idle limit is transient, never a lockout', async () => {
    const slow = (gapMs: number, chunks: number) => vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (!new URL(String(input)).pathname.startsWith('/api/snapshot')) return cloud.fetch(input, init)
      const body = JSON.stringify({ ok: true, ...cloud.fence(), snapshotFormat: 'x61-mirror-snapshot/v2', resetPaths: [], entries: [...cloud.entries] })
      const size = Math.ceil(body.length / chunks)
      const signal = init?.signal
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < chunks; i += 1) {
            await pause(gapMs)
            if (signal?.aborted) { controller.error(new DOMException('aborted', 'AbortError')); return }
            controller.enqueue(new TextEncoder().encode(body.slice(i * size, (i + 1) * size)))
          }
          controller.close()
        },
      }))
    })
    vi.stubGlobal('fetch', slow(40, 8))
    await boot({ ...FAST, read: { ...FAST.read, idleMs: 120 } })
    expect(persistence.mirror.transient).toBeNull()
    expect(persistence.mirror.conflict).toBeNull()
    vi.stubGlobal('fetch', slow(300, 2))
    idb = new FakeIndexedDb(); vi.stubGlobal('indexedDB', idb)
    await boot({ ...FAST, read: { ...FAST.read, idleMs: 120 } })
    expect(persistence.mirror.transient).toMatch(/MIRROR_CLOUD_UNREACHABLE/)
    expect(persistence.mirror.conflict).toBeNull()
  })

  it('A28: a batch the cloud fences (409) is posted once; the fenced browser then sends nothing', async () => {
    const vfs = await boot()
    await save(vfs, '/dsh/home/auma/a.md', 'a\n'); await persistence.sync()
    cloud.revision += 1
    await save(vfs, '/dsh/home/auma/fenced.md', 'fenced\n')
    const before = cloud.posts
    await persistence.sync().catch(() => {})
    expect(cloud.posts).toBe(before + 1)
    expect(persistence.mirror.conflict).toMatch(/409/)
    for (let i = 0; i < 3; i += 1) await persistence.sync().catch(() => {})
    expect(cloud.posts).toBe(before + 1)
    expect(await persistence.retryCloudSync()).toBe('conflict')
  })

  it('a refusal retrying cannot change (413) is named and not re-sent', async () => {
    const vfs = await boot()
    cloud.deliveryRefusal = { status: 413, code: 'MIRROR_STORAGE_LIMIT' }
    await save(vfs, '/dsh/home/auma/too-much.md', 'x\n')
    await persistence.sync().catch(() => {})
    expect(persistence.mirror.conflict).toMatch(/^MIRROR_DELIVERY_REFUSED: .*MIRROR_STORAGE_LIMIT, HTTP 413/)
    const posts = cloud.posts
    await persistence.sync().catch(() => {})
    expect(cloud.posts).toBe(posts)
  })

  it('a legacy hold with a cloud that moved is never re-sent: it fails closed', async () => {
    let vfs = await boot()
    await save(vfs, '/dsh/home/auma/a.md', 'a\n'); await persistence.sync()
    cloud.reachable = false
    vfs = await boot()
    await save(vfs, '/dsh/home/auma/legacy.md', 'legacy\n')
    const db = idb.dbs.get('aukora-x6-vfs')
    const record = db?.data.get('@x6-cloud-reconciliation') as Record<string, unknown>
    delete record.cause
    db?.data.set('@x6-cloud-reconciliation', record)
    cloud.revision += 1
    cloud.reachable = true
    await boot()
    expect(await persistence.retryCloudSync()).toBe('conflict')
    const held = await marker()
    expect(held).toBeDefined()
    expect(mergeCause(held?.cause as ReconciliationCause | undefined, 'transient')).toBe('genuine')
    expect(persistence.mirror.reconciliationRequired).toBe(true)
    expect(cloud.text('/dsh/home/auma/legacy.md')).toBeNull()
  })

  it('a seed file the cloud cannot hold fails closed instead of being set aside', async () => {
    const vfs = await boot()
    const before = cloud.posts
    vfs.mkdirSync(SEED, { recursive: true })
    vfs.writeFileSync(`${SEED}/receipts.v3.jsonl`, new Uint8Array(25 * 1024 * 1024))
    await persistence.flush().catch(() => {})
    expect((await marker())?.cause).toBe('genuine')
    expect(persistence.mirror.conflict).toMatch(/receipts\.v3\.jsonl cannot be sent/)
    await persistence.sync().catch(() => {})
    expect(cloud.posts).toBe(before)
  })

  it('an expired pass during delivery keeps later saves as ordinary fenced batches, and both go out after sign-in', async () => {
    const vfs = await boot()
    cloud.deliveryRefusal = { status: 401, code: 'OWNER_ACCESS_REQUIRED' }
    await save(vfs, '/dsh/home/auma/one.md', 'one\n')
    await persistence.sync().catch(() => {})
    expect(persistence.mirror.transient).toMatch(/^MIRROR_OWNER_PASS_REQUIRED/)
    await save(vfs, '/dsh/home/auma/two.md', 'two\n')
    expect(await marker()).toBeUndefined()
    expect(await queuedCount()).toBe(2)
    cloud.deliveryRefusal = null
    await persistence.sync()
    expect([cloud.text('/dsh/home/auma/one.md'), cloud.text('/dsh/home/auma/two.md')]).toEqual(['one\n', 'two\n'])
    expect(persistence.mirror.transient).toBeNull()
  })

  it('a returning browser reads only the small fence, never the whole snapshot', async () => {
    let vfs = await boot()
    await save(vfs, '/dsh/home/auma/a.md', 'a\n'); await persistence.sync()
    const snapshots = cloud.reads.get('/api/snapshot') ?? 0
    vfs = await boot()
    expect(cloud.reads.get('/api/snapshot') ?? 0).toBe(snapshots)
    expect(cloud.reads.get('/_mirror/status')).toBe(1)
    // Round 20: the fence alone, not every file name.
    expect(cloud.statusQueries).toEqual(['?compact=1'])
    void vfs
  })

  it('repeated saves of one file while delivery waits merge into the unsent tail instead of piling up', async () => {
    const vfs = await boot()
    cloud.deliveryRefusal = { status: 503, code: 'MIRROR_STORAGE_FAILED' }
    for (const [i, text] of ['v1\n', 'v2\n', 'v3\n', 'v4\n'].entries()) {
      await save(vfs, i === 0 ? '/dsh/home/auma/head.md' : '/dsh/home/auma/log.md', text)
      await persistence.sync().catch(() => {})
    }
    expect(await queuedCount()).toBe(2)
    cloud.deliveryRefusal = null
    await persistence.sync()
    expect(cloud.text('/dsh/home/auma/log.md')).toBe('v4\n')
    expect(cloud.text('/dsh/home/auma/head.md')).toBe('v1\n')
  })

  it('a full outbox holds the save as capacity and the resync sends it once room is free', async () => {
    const vfs = await boot({ ...FAST, queue: { maxPendingBytes: 1_600 } })
    cloud.deliveryRefusal = { status: 503, code: 'MIRROR_STORAGE_FAILED' }
    await save(vfs, '/dsh/home/auma/first.md', 'x'.repeat(600))
    await save(vfs, '/dsh/home/auma/second.md', 'y'.repeat(600))
    expect((await marker())?.cause).toBe('capacity')
    expect(persistence.mirror.reconciliationRequired).toBe(false)
    cloud.deliveryRefusal = null
    await persistence.sync()
    for (let i = 0; i < 50 && cloud.text('/dsh/home/auma/second.md') === null; i += 1) await pause(20)
    expect(cloud.text('/dsh/home/auma/second.md')).toBe('y'.repeat(600))
    expect(await marker()).toBeUndefined()
  })

  it('a resync changes no content rows, so other tabs of this browser can still save', async () => {
    let vfs = await boot()
    await save(vfs, '/dsh/home/auma/a.md', 'a\n'); await persistence.sync()
    cloud.reachable = false
    vfs = await boot()
    await save(vfs, '/dsh/home/auma/b.md', 'b\n')
    const revision = ((await rows()).get('@x6-content-revision') as { seq: number }).seq
    cloud.reachable = true
    expect(await persistence.retryCloudSync()).toBe('resynced')
    expect(((await rows()).get('@x6-content-revision') as { seq: number }).seq).toBe(revision)
  })

  it('boot makes one short fence attempt and leaves the rest to the background retry', async () => {
    await boot()
    await save((await boot()), '/dsh/home/auma/a.md', 'a\n')
    let statusCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname !== '/_mirror/status') return cloud.fetch(input, init)
      statusCalls += 1
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new DOMException('stalled', 'AbortError')) }) })
    }))
    const started = performance.now()
    await boot({ ...FAST, read: { ...FAST.read, idleMs: 100 } })
    expect(performance.now() - started).toBeLessThan(1_500)
    expect(statusCalls).toBe(1)
    expect(persistence.mirror.transient).toMatch(/MIRROR_CLOUD_UNREACHABLE/)
  })
})

function stubHost(origin: string, hostname: string): void {
  idb = new FakeIndexedDb()
  cloud = new FakeCloud()
  vi.stubGlobal('indexedDB', idb)
  vi.stubGlobal('IDBKeyRange', FakeKeyRange)
  vi.stubGlobal('location', { origin, hostname })
  vi.stubGlobal('fetch', cloud.fetch)
}
const text = (vfs: MemoryVfs, path: string): string => new TextDecoder().decode(vfs.readFileSync(path) as Uint8Array)

describe('Round 20: her session journal travels in its own lane, never in front of her seed', () => {
  beforeEach(() => { stubHost('https://node.example.invalid', 'node.example.invalid') })
  afterEach(async () => {
    persistence.readOnly = true
    await pause(120)
    vi.unstubAllGlobals()
  })

  it('a save of a large journal sends the seed change first and the journal alone, after it', async () => {
    const vfs = await boot()
    journalDir(vfs)
    vfs.mkdirSync(SEED, { recursive: true })
    vfs.writeFileSync(`${SEED}/organ.js`, 'v1\n')
    vfs.writeFileSync(JOURNAL, big('a'))
    await persistence.flush()
    await persistence.sync()
    await until(() => cloud.text(JOURNAL) !== null)
    expect(cloud.text(`${SEED}/organ.js`)).toBe('v1\n')
    expect(cloud.text(JOURNAL)).toBe(big('a'))
    const seedPost = cloud.posted.findIndex(paths => paths.includes(`${SEED}/organ.js`))
    const journalPosts = cloud.posted.filter(paths => paths.includes(JOURNAL))
    expect(journalPosts).toEqual([[JOURNAL]])
    expect(cloud.posted.indexOf(journalPosts[0] as string[])).toBeGreaterThan(seedPost)
    expect(persistence.mirror.deferredJournals).toEqual([])
    expect(await waitingJournal()).toBeUndefined()
  })

  it('a journal saved again within the interval waits; an explicit upload sends it at once', async () => {
    const vfs = await boot()
    journalDir(vfs)
    await save(vfs, JOURNAL, big('a'))
    await persistence.sync()
    await until(() => cloud.text(JOURNAL) !== null)
    await save(vfs, JOURNAL, big('b'))
    await save(vfs, '/dsh/home/auma/other.md', 'other\n')
    await persistence.sync()
    expect(cloud.text('/dsh/home/auma/other.md')).toBe('other\n')
    expect(cloud.text(JOURNAL)).toBe(big('a'))
    expect(persistence.mirror.deferredJournals).toEqual([JOURNAL])
    expect((await waitingJournal())?.notBefore).toBeGreaterThan(Date.now() + 30_000)
    expect(cloud.posted.filter(paths => paths.includes(JOURNAL))).toHaveLength(1)
    await persistence.upload()
    expect(cloud.text(JOURNAL)).toBe(big('b'))
    expect(persistence.mirror.deferredJournals).toEqual([])
  })

  it('the cloud upload limit (408) moves the journal aside: the seed save behind it still goes, and the journal follows later', async () => {
    const vfs = await boot()
    journalDir(vfs)
    vfs.mkdirSync(SEED, { recursive: true })
    let seedSaved = false
    cloud.answer = async (paths) => {
      if (!paths.includes(JOURNAL)) return null
      // A seed save lands while the journal is still uploading, so it queues behind it.
      if (!seedSaved) { seedSaved = true; await save(vfs, `${SEED}/organ.js`, 'v1\n') }
      return { status: 408, code: 'REQUEST_BODY_TIMEOUT' }
    }
    await save(vfs, JOURNAL, big('a'))
    await persistence.sync().catch(() => {})
    await until(() => cloud.text(`${SEED}/organ.js`) !== null)
    expect(cloud.text(`${SEED}/organ.js`)).toBe('v1\n')
    expect(cloud.text(JOURNAL)).toBeNull()
    expect(persistence.mirror.conflict).toBeNull()
    expect(persistence.mirror.reconciliationRequired).toBe(false)
    expect(persistence.mirror.journalNote).toMatch(/^MIRROR_JOURNAL_SLOW/)
    const waiting = await waitingJournal()
    expect(waiting?.failures).toBe(1)
    expect(waiting?.notBefore).toBeGreaterThan(Date.now() + 60_000)
    expect(await queuedCount()).toBe(0)
    // A second slow attempt while she keeps talking: the wait grows, it does not restart with the new save.
    let resaved = false
    cloud.answer = async (paths) => {
      if (!paths.includes(JOURNAL)) return null
      if (!resaved) { resaved = true; await save(vfs, JOURNAL, big('b')) }
      return { status: 408, code: 'REQUEST_BODY_TIMEOUT' }
    }
    ;(await rows()).set(`@x6-deferred-journal:${JOURNAL}`, { ...waiting, notBefore: 0 })
    await persistence.sync().catch(() => {})
    for (let i = 0; i < 100 && (await waitingJournal())?.failures !== 2; i += 1) await pause(20)
    const again = await waitingJournal()
    expect(again?.failures).toBe(2)
    expect(again?.notBefore).toBeGreaterThan(Date.now() + 3 * 60_000)
    // The wait passes and the connection is faster: the newest journal is delivered on its own.
    cloud.answer = null
    ;(await rows()).set(`@x6-deferred-journal:${JOURNAL}`, { ...again, notBefore: 0 })
    await persistence.sync()
    await until(() => cloud.text(JOURNAL) !== null)
    expect(cloud.text(JOURNAL)).toBe(big('b'))
    expect(persistence.mirror.journalNote).toBeNull()
    expect(await waitingJournal()).toBeUndefined()
  })

  it('a size refusal (413) sets the journal aside and names it, and is not a lockout', async () => {
    const vfs = await boot()
    journalDir(vfs)
    cloud.answer = async paths => (paths.includes(JOURNAL) ? { status: 413, code: 'MIRROR_FILE_TOO_LARGE' } : null)
    await save(vfs, JOURNAL, big('a'))
    await persistence.sync().catch(() => {})
    await until(() => persistence.mirror.journalNote !== null)
    expect(persistence.mirror.journalNote).toMatch(/^MIRROR_JOURNAL_REFUSED/)
    expect(persistence.mirror.quarantinedPaths).toContain(JOURNAL)
    expect((await waitingJournal())?.notBefore).toBeGreaterThan(Date.now() + SESSION_JOURNAL_POLICY.maxRetryMs - 60_000)
    expect(persistence.mirror.conflict).toBeNull()
    await save(vfs, '/dsh/home/auma/after.md', 'after\n')
    await persistence.sync()
    expect(cloud.text('/dsh/home/auma/after.md')).toBe('after\n')
    // An explicit upload does not override that wait, and does not report a journal that is still waiting as delivered.
    await expect(persistence.upload()).rejects
      .toThrow(/^MIRROR_JOURNAL_PENDING: 1 session journal\(s\) not yet delivered \(MIRROR_JOURNAL_REFUSED/)
    expect(cloud.posted.filter(paths => paths.includes(JOURNAL))).toHaveLength(1)
  })

  it('a journal the cloud applied but whose answer was lost is never moved aside: the fence shows it, and the saves behind it wait', async () => {
    const vfs = await boot()
    journalDir(vfs)
    await save(vfs, '/dsh/home/auma/first.md', 'first\n')
    await persistence.sync()
    cloud.loseNextAck = true
    await save(vfs, JOURNAL, big('a'))
    await persistence.sync().catch(() => {})
    await until(() => cloud.text(JOURNAL) !== null)
    // The cloud holds the journal; this browser never heard so. A later save queues behind it, and the journal's next
    // attempt is too slow. Moving it aside now would re-use its id for other bytes (a replay conflict): it must stay.
    await save(vfs, '/dsh/home/auma/behind.md', 'behind\n')
    cloud.answer = async paths => (paths.includes(JOURNAL) ? { status: 408, code: 'REQUEST_BODY_TIMEOUT' } : null)
    await persistence.sync().catch(() => {})
    expect(await queuedCount()).toBe(2)
    expect(persistence.mirror.conflict).toBeNull()
    expect(cloud.text('/dsh/home/auma/behind.md')).toBeNull()
    // Once the connection carries it, the cloud replays its own receipt and the save behind it goes.
    cloud.answer = null
    await persistence.sync()
    await until(() => cloud.text('/dsh/home/auma/behind.md') !== null)
    expect(cloud.text('/dsh/home/auma/behind.md')).toBe('behind\n')
    expect(persistence.mirror.conflict).toBeNull()
    expect(await queuedCount()).toBe(0)
  })

  it('a journal attempt that got no answer and was not applied still moves aside on the next 408, so nothing stays stuck', async () => {
    const vfs = await boot()
    journalDir(vfs)
    let attempts = 0
    cloud.answer = async (paths) => {
      if (!paths.includes(JOURNAL)) return null
      attempts += 1
      if (attempts === 1) throw new TypeError('connection reset before the cloud read it')
      return { status: 408, code: 'REQUEST_BODY_TIMEOUT' }
    }
    await save(vfs, JOURNAL, big('a'))
    await persistence.sync().catch(() => {})
    await until(() => attempts >= 1)
    await save(vfs, '/dsh/home/auma/behind.md', 'behind\n')
    await persistence.sync().catch(() => {})
    await until(() => cloud.text('/dsh/home/auma/behind.md') !== null)
    expect(cloud.text('/dsh/home/auma/behind.md')).toBe('behind\n')
    expect(cloud.text(JOURNAL)).toBeNull()
    expect((await waitingJournal())?.failures).toBe(1)
    expect(persistence.mirror.conflict).toBeNull()
  })

  it('a journal that falls below the threshold, or whose folder is deleted, stops waiting and goes as an ordinary save', async () => {
    const vfs = await boot()
    journalDir(vfs)
    await save(vfs, JOURNAL, big('a'))
    await persistence.sync()
    await until(() => cloud.text(JOURNAL) !== null)
    await save(vfs, JOURNAL, big('b'))
    expect(await waitingJournal()).toBeDefined()
    await save(vfs, JOURNAL, 'compacted\n')
    await persistence.sync()
    expect(await waitingJournal()).toBeUndefined()
    expect(cloud.text(JOURNAL)).toBe('compacted\n')
    await save(vfs, JOURNAL, big('c'))
    expect(await waitingJournal()).toBeDefined()
    vfs.rmSync(JOURNAL.slice(0, JOURNAL.lastIndexOf('/')), { recursive: true, force: true })
    await persistence.flush()
    await persistence.sync()
    expect(await waitingJournal()).toBeUndefined()
    expect(cloud.text(JOURNAL)).toBeNull()
    expect(persistence.mirror.deferredJournals).toEqual([])
  })

  it('a journal too large for one batch is kept, named and held for the longest wait instead of re-encoded each pass', async () => {
    // A journal of 2 MiB is about 2.7 MiB once encoded: past this outbox's 2.5 MiB budget.
    const vfs = await boot({ ...FAST, queue: { maxPendingBytes: 2.5 * 1024 * 1024 } })
    journalDir(vfs)
    await save(vfs, JOURNAL, big('a'))
    await persistence.sync().catch(() => {})
    await until(() => persistence.mirror.journalNote !== null)
    expect(persistence.mirror.journalNote).toMatch(/^MIRROR_JOURNAL_TOO_LARGE/)
    expect(persistence.mirror.quarantinedPaths).toContain(JOURNAL)
    const held = await waitingJournal()
    expect(held?.notBefore).toBeGreaterThan(Date.now() + SESSION_JOURNAL_POLICY.maxRetryMs - 60_000)
    await save(vfs, JOURNAL, big('b'))
    await persistence.sync()
    expect((await waitingJournal())?.notBefore).toBe(held?.notBefore)
    expect(cloud.posted.filter(paths => paths.includes(JOURNAL))).toHaveLength(0)
    await expect(persistence.upload()).rejects.toThrow(/^MIRROR_JOURNAL_PENDING: 1 session journal/)
  })

  it('a save queued before Round 20 with her journal inside it: on a 408 the journal steps out and the rest of that save goes', async () => {
    const vfs = await boot()
    journalDir(vfs)
    await save(vfs, '/dsh/home/auma/first.md', 'first\n')
    await persistence.sync()
    // What Round 19 queued on every turn: one batch carrying a small save and the whole journal.
    const data = await rows()
    const meta = data.get('@x6-mirror-meta') as MirrorMeta
    const seq = meta.seq + 1
    const body = big('a')
    data.set(JOURNAL, { kind: 'file', bytes: encode(body), mode: 0o600, mtimeMs: 2 })
    const batch: MirrorBatch['batch'] = { clientId: meta.clientId, seq, id: `${meta.clientId}:${String(seq)}`,
      entries: [['/dsh/home/auma/note.md', file('note\n')], [JOURNAL, file(body)]], cloudBase: { lineageId: cloud.lineageId, revision: cloud.revision } }
    data.set(`@x6-mirror-batch:${String(seq).padStart(16, '0')}`, { kind: 'mirror-batch', batch, digest: sha256HexSync(JSON.stringify(batch)) })
    data.set('@x6-mirror-meta', { ...meta, seq })
    cloud.answer = async paths => (paths.includes(JOURNAL) ? { status: 408, code: 'REQUEST_BODY_TIMEOUT' } : null)
    await persistence.sync().catch(() => {})
    await until(() => cloud.text('/dsh/home/auma/note.md') !== null)
    expect(cloud.text('/dsh/home/auma/note.md')).toBe('note\n')
    expect(cloud.text(JOURNAL)).toBeNull()
    expect(persistence.mirror.conflict).toBeNull()
    expect((await waitingJournal())?.failures).toBe(1)
    cloud.answer = null
    ;(await rows()).set(`@x6-deferred-journal:${JOURNAL}`, { ...(await waitingJournal()), notBefore: 0 })
    await persistence.sync()
    await until(() => cloud.text(JOURNAL) !== null)
    expect(cloud.text(JOURNAL)).toBe(body)
    expect(cloud.posted.at(-1)).toEqual([JOURNAL])
  })

  it('a 408 on her journal after another writer moved the cloud past this browser fails closed instead of re-uploading forever', async () => {
    const vfs = await boot()
    journalDir(vfs)
    await save(vfs, '/dsh/home/auma/first.md', 'first\n')
    await persistence.sync()
    cloud.revision += 2
    cloud.answer = async paths => (paths.includes(JOURNAL) ? { status: 408, code: 'REQUEST_BODY_TIMEOUT' } : null)
    await save(vfs, JOURNAL, big('a'))
    await persistence.sync().catch(() => {})
    await until(() => persistence.mirror.conflict !== null)
    expect(persistence.mirror.conflict).toMatch(/^MIRROR_GLOBAL_FENCE_CONFLICT/)
    const posts = cloud.posted.filter(paths => paths.includes(JOURNAL)).length
    await persistence.sync().catch(() => {})
    expect(cloud.posted.filter(paths => paths.includes(JOURNAL))).toHaveLength(posts)
    expect(await queuedCount()).toBe(1)
  })

  it('an explicit upload sends each journal once and ends, even while she keeps writing to it', async () => {
    const vfs = await boot()
    journalDir(vfs)
    await save(vfs, JOURNAL, big('a'))
    await persistence.sync()
    await until(() => cloud.text(JOURNAL) !== null)
    await save(vfs, JOURNAL, big('b'))
    let writes = 0
    cloud.answer = async (paths) => {
      if (paths.includes(JOURNAL) && writes < 5) { writes += 1; await save(vfs, JOURNAL, big(String(writes))) }
      return null
    }
    await expect(persistence.upload()).rejects.toThrow(/^MIRROR_JOURNAL_PENDING: 1 session journal/)
    expect(cloud.posted.filter(paths => paths.includes(JOURNAL))).toHaveLength(2)
    expect(writes).toBe(1)
    expect(cloud.text(JOURNAL)).toBe(big('b'))
  })

  it('a 413 on her journal when the fence cannot be read is a retry, never a lockout', async () => {
    const vfs = await boot()
    journalDir(vfs)
    cloud.answer = async paths => (paths.includes(JOURNAL) ? { status: 413, code: 'MIRROR_STORAGE_LIMIT' } : null)
    cloud.statusFails = true
    await save(vfs, JOURNAL, big('a'))
    await persistence.sync().catch(() => {})
    await until(() => cloud.posted.some(paths => paths.includes(JOURNAL)))
    await pause(40)
    expect(persistence.mirror.conflict).toBeNull()
    expect(persistence.mirror.transient).toMatch(/fence could not be read/)
    expect(await queuedCount()).toBe(1)
    cloud.statusFails = false
    await persistence.sync().catch(() => {})
    await until(() => persistence.mirror.journalNote !== null)
    expect(persistence.mirror.journalNote).toMatch(/^MIRROR_JOURNAL_REFUSED/)
    expect(await queuedCount()).toBe(0)
    expect(persistence.mirror.conflict).toBeNull()
  })

  it('a journal compacted while its upload is in flight is not marked waiting again when the cloud does not take the old copy', async () => {
    const vfs = await boot()
    journalDir(vfs)
    let compacted = false
    cloud.answer = async (paths) => {
      if (!paths.includes(JOURNAL) || compacted) return null
      compacted = true
      await save(vfs, JOURNAL, 'compacted\n')
      return { status: 413, code: 'MIRROR_FILE_TOO_LARGE' }
    }
    await save(vfs, JOURNAL, big('a'))
    await persistence.sync().catch(() => {})
    await until(() => cloud.text(JOURNAL) !== null)
    expect(cloud.text(JOURNAL)).toBe('compacted\n')
    expect(await waitingJournal()).toBeUndefined()
    expect(persistence.mirror.deferredJournals).toEqual([])
  })

  it('a resync after a hold sends everything else, then hands the journal to its own lane', async () => {
    let vfs = await boot()
    await save(vfs, '/dsh/home/auma/a.md', 'a\n'); await persistence.sync()
    cloud.reachable = false
    vfs = await boot()
    journalDir(vfs)
    await save(vfs, '/dsh/home/auma/b.md', 'held\n')
    await save(vfs, JOURNAL, big('a'))
    expect((await marker())?.cause).toBe('transient')
    expect(await waitingJournal()).toBeDefined()
    cloud.reachable = true
    expect(await persistence.retryCloudSync()).toBe('resynced')
    await persistence.sync()
    await until(() => cloud.text(JOURNAL) !== null)
    expect(cloud.text('/dsh/home/auma/b.md')).toBe('held\n')
    expect(cloud.text(JOURNAL)).toBe(big('a'))
    const heldPost = cloud.posted.findIndex(paths => paths.includes('/dsh/home/auma/b.md'))
    expect(cloud.posted[heldPost]).not.toContain(JOURNAL)
    expect(cloud.posted.filter(paths => paths.includes(JOURNAL))).toEqual([[JOURNAL]])
    expect(await marker()).toBeUndefined()
    expect(await waitingJournal()).toBeUndefined()
  })

  it('a hold from before Round 20 (no waiting row) still hands her journal to the lane on resync', async () => {
    let vfs = await boot()
    await save(vfs, '/dsh/home/auma/a.md', 'a\n'); await persistence.sync()
    cloud.reachable = false
    vfs = await boot()
    journalDir(vfs)
    await save(vfs, '/dsh/home/auma/b.md', 'held\n')
    await save(vfs, JOURNAL, big('a'))
    // As a Round 19 browser left it: the journal is a saved row with a hold over it and no waiting row.
    ;(await rows()).delete(`@x6-deferred-journal:${JOURNAL}`)
    cloud.reachable = true
    expect(await persistence.retryCloudSync()).toBe('resynced')
    expect(await waitingJournal()).toBeDefined()
    await persistence.sync()
    await until(() => cloud.text(JOURNAL) !== null)
    expect(cloud.text(JOURNAL)).toBe(big('a'))
    expect(cloud.posted.filter(paths => paths.includes(JOURNAL))).toEqual([[JOURNAL]])
  })
})

describe('Round 20 on the Mac host: a waiting journal is unsent local work', () => {
  beforeEach(() => { stubHost('http://127.0.0.1:4610', '127.0.0.1'); cloud.local = true })
  afterEach(async () => {
    persistence.readOnly = true
    await pause(120)
    vi.unstubAllGlobals()
  })

  it('a reload never replaces a waiting journal with the mirror copy, and an upload sends it', async () => {
    const slow: AttachOptions = { ...FAST, journal: { intervalMs: 60_000 } }
    let vfs = await boot(slow)
    journalDir(vfs)
    await save(vfs, JOURNAL, big('a'))
    await persistence.sync()
    await until(() => cloud.text(JOURNAL) !== null)
    expect(cloud.text(JOURNAL)).toBe(big('a'))
    await save(vfs, JOURNAL, big('b'))
    await persistence.sync()
    expect(cloud.text(JOURNAL)).toBe(big('a'))
    expect(persistence.mirror.deferredJournals).toEqual([JOURNAL])
    // The host's copy now looks newer than this tab's; only the waiting mark keeps the reload from importing it.
    const hosted = cloud.entries.get(JOURNAL)
    if (hosted?.kind !== 'file') throw new Error('the host holds no journal')
    cloud.entries.set(JOURNAL, { ...hosted, mtimeMs: Date.now() + 3_600_000 })
    vfs = await boot(slow)
    expect(text(vfs, JOURNAL)).toBe(big('b'))
    expect(persistence.mirror.deferredJournals).toEqual([JOURNAL])
    await persistence.upload()
    expect(cloud.text(JOURNAL)).toBe(big('b'))
    expect(persistence.mirror.deferredJournals).toEqual([])
  })
})

describe('the pure rules behind the lockout fixes', () => {
  const BASE: CloudBase = { lineageId: '11111111-2222-4333-8444-555555555555', revision: 7 }
  const meta = (seq: number, acked: number, base: CloudBase = BASE): MirrorMeta =>
    ({ kind: 'mirror-meta', clientId: '0f0e0d0c-0b0a-4908-8706-050403020100', seq, cloudBase: base, cloudAcknowledgedSeq: acked })
  const queued = (count: number): MirrorBatch[] => Array.from({ length: count }, (_, i) => {
    const batch = { clientId: '0f0e0d0c-0b0a-4908-8706-050403020100', seq: i + 1, id: `0f0e0d0c-0b0a-4908-8706-050403020100:${String(i + 1)}`,
      entries: [['/dsh/home/x', { kind: 'gone' }]] as Array<[string, WireEntry]>, cloudBase: { ...BASE, revision: BASE.revision + i } }
    return { kind: 'mirror-batch' as const, batch, digest: sha256HexSync(JSON.stringify(batch)) }
  })
  it('the fence verdict separates unreachable, in step, replay and divergence', () => {
    expect(classifyCloudFence(true, meta(0, 0), [], null)).toEqual({ kind: 'unreachable' })
    expect(classifyCloudFence(false, undefined, [], BASE)).toEqual({ kind: 'initialize' })
    expect(classifyCloudFence(true, meta(0, 0), [], BASE)).toEqual({ kind: 'in-step' })
    expect(classifyCloudFence(true, meta(2, 0), queued(2), { ...BASE, revision: 8 })).toEqual({ kind: 'replay-pending', applied: 1 })
    expect(classifyCloudFence(true, meta(2, 0), queued(2), { ...BASE, revision: 9 })).toEqual({ kind: 'replay-pending', applied: 2 })
    expect(classifyCloudFence(true, meta(2, 0), queued(2), { ...BASE, revision: 10 }).kind).toBe('diverged')
    expect(classifyCloudFence(true, meta(0, 0), [], { ...BASE, revision: 8 }).kind).toBe('diverged')
    expect(classifyCloudFence(true, meta(0, 0), [], { ...BASE, lineageId: '99999999-2222-4333-8444-555555555555' }).kind).toBe('diverged')
    expect(classifyCloudFence(true, meta(0, 0), [], { ...BASE, revision: 6 }).kind).toBe('diverged')
    expect(classifyCloudFence(true, { kind: 'mirror-meta', clientId: 'x', seq: 0 }, [], BASE).kind).toBe('diverged')
  })
  it('causes merge toward genuine, and a record with no cause is genuine', () => {
    expect(mergeCause(null, 'transient')).toBe('transient')
    expect(mergeCause('transient', 'capacity')).toBe('capacity')
    expect(mergeCause('capacity', 'transient')).toBe('capacity')
    expect(mergeCause('transient', 'genuine')).toBe('genuine')
    expect(mergeCause(undefined, 'transient')).toBe('genuine')
  })
  it('cloud admission quarantines odd names and oversize files, but fails closed under her seed', () => {
    expect(cloudAdmission('/dsh/home/auma/note.md', 10)).toBe('send')
    expect(cloudAdmission(`/dsh/workspace/${'n'.repeat(300)}`, 10)).toBe('quarantine')
    expect(cloudAdmission('/dsh/workspace/big.bin', 30 * 1024 * 1024)).toBe('quarantine')
    expect(cloudAdmission(`${SEED}/receipts.v3.jsonl`, 30 * 1024 * 1024)).toBe('genuine')
    expect(criticalCloudPath(`${SEED}/organs/seed-aura.js`)).toBe(true)
    expect(criticalCloudPath('/dsh/home/auma/seedling')).toBe(false)
  })
  it('the resync plan sends exactly the saved differences, deletions once per root, and refuses a cleared root', () => {
    const file = (text: string, mode = 0o644): Entry => ({ kind: 'file', bytes: encode(text), mode, mtimeMs: 1 })
    const cloudSide = new Map<string, Entry>([
      ['/dsh/home/auma/same.md', file('same\n')], ['/dsh/home/auma/changed.md', file('old\n')],
      ['/dsh/home/auma/gone', { kind: 'dir', mode: 0o755 }], ['/dsh/home/auma/gone/a.md', file('a\n')], ['/dsh/home/auma/gone/b.md', file('b\n')],
      ['/dsh/home/auma/reset/kept.md', file('kept\n')], ['/dsh/home/auma/reset/dropped.md', file('dropped\n')],
    ])
    const local = new Map<string, Entry>([
      ['/dsh/home/auma/same.md', file('same\n')], ['/dsh/home/auma/changed.md', file('new\n')], ['/dsh/home/auma/added.md', file('added\n')],
      ['/dsh/home/auma/gone', { kind: 'gone' }], ['/dsh/home/auma/gone/a.md', file('stale row under a deletion\n')],
      ['/dsh/home/auma/reset/kept.md', file('kept\n')],
    ])
    const plan = planCloudResync(local, new Set(['/dsh/home/auma/reset']), cloudSide)
    expect(plan.refused).toBeNull()
    expect(plan.batches.flat().map(([path, wire]) => `${wire.kind} ${path}`)).toEqual([
      'gone /dsh/home/auma/gone', 'gone /dsh/home/auma/reset/dropped.md', 'file /dsh/home/auma/added.md', 'file /dsh/home/auma/changed.md',
    ])
    expect(planCloudResync(new Map([['/dsh/workspace', { kind: 'gone' }]]), new Set(), cloudSide).refused).toMatch(/root was cleared/)
    const huge: Entry = { kind: 'file', bytes: new Uint8Array(25 * 1024 * 1024), mode: 0o644, mtimeMs: 1 }
    expect(planCloudResync(new Map([[`${SEED}/receipts.v3.jsonl`, huge]]), new Set(), new Map()).refused).toMatch(/seed file/)
    const odd = `/dsh/workspace/${'n'.repeat(300)}`
    expect(planCloudResync(new Map([[odd, file('x')]]), new Set(), new Map())).toMatchObject({ refused: null, quarantined: [odd], batches: [] })
  })
  it('the resync plan splits into batches the cloud accepts', () => {
    const local = new Map<string, Entry>(Array.from({ length: 5 }, (_, i) => [`/dsh/home/auma/f${String(i)}.md`,
      { kind: 'file', bytes: encode('x'.repeat(1000)), mode: 0o644, mtimeMs: 1 } as Entry]))
    const sizes = (limits: { entries: number; requestBytes: number }) =>
      planCloudResync(local, new Set(), new Map(), limits).batches.map(batch => batch.length)
    expect(sizes({ entries: 2, requestBytes: 1_000_000 })).toEqual([2, 2, 1])
    expect(sizes({ entries: 100, requestBytes: 4096 + 3000 })).toEqual([2, 2, 1])
  })
  it('reads retry transient failures with backoff and nothing else', async () => {
    const waits: number[] = []
    const sleep = async (ms: number) => { waits.push(ms) }
    let calls = 0
    const flaky = async () => { calls += 1; if (calls < 3) throw new TypeError('offline'); return { ok: true, status: 200, text: '{}' } }
    expect(await readWithRetry(flaky, { backoffMs: [5, 10, 20], sleep })).toEqual({ ok: true, status: 200, text: '{}' })
    expect(waits).toEqual([5, 10])
    calls = 0
    expect((await readWithRetry(async () => { calls += 1; return { ok: false, status: 503, text: '' } }, { backoffMs: [1, 1], sleep })).status).toBe(503)
    expect(calls).toBe(3)
    for (const status of [401, 404, 409]) {
      calls = 0
      await readWithRetry(async () => { calls += 1; return { ok: false, status, text: '' } }, { backoffMs: [1, 1], sleep })
      expect([status, calls]).toEqual([status, 1])
    }
    await expect(readWithRetry(async () => { throw new SyntaxError('bad json') }, { backoffMs: [1], sleep })).rejects.toThrow(SyntaxError)
    expect(transientStatus(503) && transientStatus(401) && !transientStatus(409) && !transientStatus(413)).toBe(true)
  })
  it('delivery refusals: fence conflicts (even as 507), permanent refusals, the 30 s upload limit, an expired pass', () => {
    expect(deliveryRefusal(409, '{"code":"MIRROR_GLOBAL_FENCE_CONFLICT"}')).toEqual({ kind: 'fence', code: 'MIRROR_GLOBAL_FENCE_CONFLICT' })
    expect(deliveryRefusal(507, '{"code":"MIRROR_CONFLICT_CAPACITY_EXCEEDED","conflictCode":"MIRROR_REPLAY_EXPIRED"}'))
      .toEqual({ kind: 'fence', code: 'MIRROR_REPLAY_EXPIRED' })
    expect(deliveryRefusal(507, '{"code":"MIRROR_CLIENT_LIMIT"}')).toEqual({ kind: 'refused', code: 'MIRROR_CLIENT_LIMIT' })
    expect(deliveryRefusal(413, '{"code":"MIRROR_STORAGE_LIMIT"}').kind).toBe('refused')
    expect(deliveryRefusal(400, 'not json')).toEqual({ kind: 'refused', code: 'HTTP_400' })
    expect(deliveryRefusal(408, '{"code":"REQUEST_BODY_TIMEOUT"}').kind).toBe('too-slow')
    expect(deliveryRefusal(401, '').kind).toBe('signed-out')
    expect(deliveryRefusal(503, '').kind).toBe('transient')
  })
  it('a resync batch, serialized as it is sent, stays within one cloud request even with thousands of small entries', () => {
    const local = new Map<string, Entry>(Array.from({ length: 3000 }, (_, i) => [`/dsh/home/auma/n/${String(i)}`,
      { kind: 'file', bytes: encode('z'), mode: 0o644, mtimeMs: 1 } as Entry]))
    const limits = { entries: 10_000, requestBytes: 64 * 1024 }
    const plan = planCloudResync(local, new Set(), new Map(), limits)
    expect(plan.batches.length).toBeGreaterThan(1)
    for (const entries of plan.batches) {
      const batch = { clientId: '0f0e0d0c-0b0a-4908-8706-050403020100', seq: 9_007_199_254_740_991,
        id: '0f0e0d0c-0b0a-4908-8706-050403020100:9007199254740991', entries, cloudBase: { lineageId: BASE.lineageId, revision: 9_007_199_254_740_990 } }
      expect(new TextEncoder().encode(JSON.stringify({ v: 2, batch, digest: 'f'.repeat(64) })).byteLength).toBeLessThanOrEqual(limits.requestBytes)
    }
  })
  it('an outbox POST gets the time its size needs at a slow uplink, within bounds', () => {
    expect(MIRROR_READ_POLICY.idleMs).toBe(30_000)
    expect(deliveryDeadlineMs(1_000)).toBe(30_000)
    expect(deliveryDeadlineMs(26_535_656)).toBe(102_000)
    expect(deliveryDeadlineMs(10 ** 9)).toBe(600_000)
  })
  it('the journal lane: which files take it, how long they wait, and which answers prove nothing was applied', () => {
    const over = SESSION_JOURNAL_POLICY.minBytes + 1
    expect(deferredJournal(JOURNAL, over)).toBe(true)
    expect(deferredJournal('/dsh/home/sessions/p/s/session.v5.jsonl', over)).toBe(true)
    expect(deferredJournal('/dsh/home/auma/session/messages.jsonl', over)).toBe(true)
    expect(deferredJournal(JOURNAL, SESSION_JOURNAL_POLICY.minBytes)).toBe(false)
    expect(deferredJournal(JOURNAL, null)).toBe(false)
    expect(deferredJournal(`${SEED}/receipts.v3.jsonl`, 30 * 1024 * 1024)).toBe(false)
    expect(deferredJournal('/dsh/home/sessions/p/s/notes.md', over)).toBe(false)
    expect(deferredJournal('/dsh/workspace/sessions/p/s/session.v4.jsonl', over)).toBe(false)
    expect([1, 2, 3].map(failures => journalRetryMs(failures, false))).toEqual([120_000, 240_000, 480_000])
    expect(journalRetryMs(40, false)).toBe(SESSION_JOURNAL_POLICY.maxRetryMs)
    expect(journalRetryMs(1, true)).toBe(SESSION_JOURNAL_POLICY.maxRetryMs)
    expect([408, 413].every(deliveryNeverApplied)).toBe(true)
    expect([200, 400, 401, 409, 429, 500, 502, 503, 507].some(deliveryNeverApplied)).toBe(false)
    const journal: Entry = { kind: 'file', bytes: new Uint8Array(over), mode: 0o600, mtimeMs: 1 }
    const plan = planCloudResync(new Map<string, Entry>([[JOURNAL, journal], ['/dsh/home/auma/a.md', { kind: 'file', bytes: encode('a'), mode: 0o644, mtimeMs: 1 }]]),
      new Set(), new Map())
    expect(plan.batches.flat().map(([path]) => path)).toEqual(['/dsh/home/auma/a.md'])
    expect(plan.deferred).toEqual([JOURNAL])
    expect(planCloudResync(new Map([[JOURNAL, journal]]), new Set(), new Map([[JOURNAL, journal]])).deferred).toEqual([])
  })
})

describe('Lane E4: persistence.inspect (x6_browser_estate) reads the queue by metadata only', () => {
  beforeEach(() => {
    idb = new FakeIndexedDb()
    cloud = new FakeCloud()
    vi.stubGlobal('indexedDB', idb)
    vi.stubGlobal('IDBKeyRange', FakeKeyRange)
    vi.stubGlobal('location', { origin: 'https://node.example.invalid', hostname: 'node.example.invalid' })
    vi.stubGlobal('fetch', cloud.fetch)
  })
  afterEach(async () => {
    persistence.readOnly = true
    await pause(120)
    vi.unstubAllGlobals()
  })

  it('reports queued batches, roots and conflicts with no file bytes and no private file names', async () => {
    const vfs = await boot()
    cloud.deliveryRefusal = { status: 409, code: 'MIRROR_DELIVERY_PAUSED' }
    vfs.mkdirSync('/dsh/home/auma/private', { recursive: true })
    vfs.writeFileSync('/dsh/home/auma/notes.md', 'public-notes-body')
    await save(vfs, '/dsh/home/auma/private/owner-note.json', 'synthetic-private-marker')
    const view = await persistence.inspect(16)
    const text = JSON.stringify(view)
    expect(view).toMatchObject({ available: true })
    expect(Number(view.queuedBatches)).toBeGreaterThan(0)
    expect(text).toContain('/dsh/home/auma/notes.md')
    expect(text).toContain('/dsh/home/auma/private/[redacted]')
    expect(text).not.toContain('owner-note.json')
    expect(text).not.toContain('synthetic-private-marker')
    expect(text).not.toContain('public-notes-body')
    expect(view).toHaveProperty('tombstoneRoots')
    expect(view).toHaveProperty('pendingLocal')
    expect(view).toHaveProperty('conflict')
  })
})

// A refused IndexedDB stays a visible boot failure: never a silent memory-only boot.
describe('a browser that refuses IndexedDB fails the boot visibly', () => {
  const refusing = (event: 'onerror' | 'onblocked') => ({
    open() {
      const req: Record<string, unknown> & { error?: unknown } = {}
      setTimeout(() => {
        if (event === 'onerror') req.error = new DOMException('The operation is insecure.', 'SecurityError')
        ;(req[event] as (() => void) | undefined)?.()
      }, 0)
      return req
    },
  })
  afterEach(() => { persistence.readOnly = true; vi.unstubAllGlobals() })

  it('an open refused (a private window, VersionError, UnknownError) rejects the boot', async () => {
    vi.stubGlobal('indexedDB', refusing('onerror'))
    vi.stubGlobal('location', { origin: 'https://node.example.invalid', hostname: 'node.example.invalid' })
    await expect(boot()).rejects.toThrow(/insecure/)
  })

  it('an older tab still owning storage stays fatal, as before', async () => {
    vi.stubGlobal('indexedDB', refusing('onblocked'))
    vi.stubGlobal('location', { origin: 'https://node.example.invalid', hostname: 'node.example.invalid' })
    await expect(boot()).rejects.toThrow(/^STORAGE_UPGRADE_BLOCKED/)
  })
})
