/**
 * Readers that pull her threads, against a fake edge (thread-sync-fixture.ts).
 *
 * The role comes from local facts only. A browser that never saved and holds her cloud's home is a reader in EVERY
 * mode and on EVERY failure to read the mode: `persistence.readOnly` is true before any call of thread sync and before
 * her tree would boot, and a write by the tree afterwards sends nothing to her cloud. A reader in `pull` pulls each
 * thread whole, checked part by part, chain and open end, and puts it in memory only; nothing is written to IndexedDB.
 * The real idb-persist.ts boots each store, as worker-host.ts attaches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { attachIdbPersistence, persistence, DB_NAME, type AttachOptions } from '../../src/storage/idb-persist.ts'
import {
  bootThreadSync, localFactsFromHydration, NONE_ON_FOOTER, pullIsFresh, pullThreads, READER_OLDER_FOOTER, readerPulledFooter, readerRefusal,
  THREAD_SYNC_CHANNEL, THREAD_SYNC_LIMITS, threadReader, type ThreadPullReport,
  type ThreadSyncBootOptions, type ThreadSyncChannel,
} from '../../src/storage/thread-sync.ts'
import type { HydrationFacts } from '../../src/storage/idb-persist.ts'
import type { ThreadNet, ThreadPersistenceView } from '../../src/storage/thread-store-types.ts'
import {
  FakeDb, FakeIndexedDb, FakeKeyRange, fakeEdge, join, journal, READER_LINEAGE, readerStore, sha256, type CloudThread, type FakeEdgeOptions,
} from './thread-sync-fixture.ts'

const ORIGIN = 'https://node.example.invalid'
const ROOTS = ['/dsh/home', '/dsh/workspace']
const FAST: AttachOptions = { read: { backoffMs: [0, 0], idleMs: 2_000, sleep: async () => {} }, resync: { firstMs: 20, maxMs: 80 } }
const PIECE = 4096
const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })
const A = '/dsh/home/sessions/--dsh-home-auma--/session-a/session.v4.jsonl'
const B = '/dsh/home/sessions/--dsh-home-auma--/session-b/session.v4.jsonl'
const C = '/dsh/home/sessions/--dsh-home-auma--/session-c/session.v4.jsonl'
const A_BYTES = journal(5 * PIECE + 777, 'a')
const B_OLD = journal(PIECE + 300, 'b')
const B_BYTES = join(B_OLD, journal(2 * PIECE + 91, 'b-later'))
const C_BYTES = journal(PIECE + 50, 'c')

let fakeDb: FakeDb
function install(rows: ReadonlyMap<string, unknown>): void {
  const idb = new FakeIndexedDb()
  fakeDb = new FakeDb()
  fakeDb.data = new Map([...rows].map(([key, value]) => [key, structuredClone(value)]))
  idb.dbs.set(DB_NAME, fakeDb)
  vi.stubGlobal('indexedDB', idb)
}
const rowsNow = (): Map<string, unknown> => new Map([...fakeDb.data].map(([key, value]) => [key, structuredClone(value)]))
const sameRows = (left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>): boolean =>
  left.size === right.size && [...left].every(([key, value]) => right.has(key) && JSON.stringify(value, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)) === JSON.stringify(right.get(key), (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)))

/** One page load: her store attached exactly as worker-host.ts attaches it, then thread sync, as worker-host.ts runs it. */
async function load(rows: ReadonlyMap<string, unknown>, edge: Omit<FakeEdgeOptions, 'origin' | 'piece' | 'fence' | 'readOnly'> & { piece?: number },
  sync: Partial<ThreadSyncBootOptions> = {}) {
  install(rows)
  const fake = await fakeEdge({ origin: ORIGIN, piece: PIECE, fence: { lineageId: READER_LINEAGE, revision: 2190 },
    readOnly: () => persistence.readOnly, ...edge })
  vi.stubGlobal('fetch', fake.fetch)
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma', { recursive: true })
  vfs.mkdirSync('/dsh/workspace', { recursive: true })
  persistence.readOnly = false
  await attachIdbPersistence(vfs, ROOTS, FAST)
  const before = rowsNow()
  const boot = await bootThreadSync({ vfs, origin: ORIGIN, log: () => {}, ...sync })
  const readOnlyAtBoot = persistence.readOnly
  return { vfs, boot, fake, before, readOnlyAtBoot }
}
const THREAD_ROUTE = /^\/_(thread|vault|mirror\/lease)/
const threadCalls = <T extends { path: string }>(calls: readonly T[]): T[] => calls.filter(call => THREAD_ROUTE.test(call.path))
const deltas = (calls: ReadonlyArray<{ method: string; path: string }>) => calls.filter(call => call.path.startsWith('/_mirror/delta'))
const bytesAt = (vfs: MemoryVfs, path: string): Uint8Array => new Uint8Array(vfs.readFileSync(path) as Uint8Array)

beforeEach(() => {
  threadReader.footer = null
  vi.stubGlobal('IDBKeyRange', FakeKeyRange)
  vi.stubGlobal('location', { origin: ORIGIN, hostname: 'node.example.invalid' })
})
afterEach(async () => {
  persistence.readOnly = true
  threadReader.footer = null
  await pause(120)
  vi.unstubAllGlobals()
})

/** Hydration facts as attach records them; each row of the role table overrides what it is about. */
const facts = (over: Partial<HydrationFacts> = {}): HydrationFacts => ({ transport: 'cloud', storedRows: true, seq: 0,
  clientId: '9a7c1e55-2b3d-4f60-8a91-b2c3d4e5f607', storedRevision: 2190, queuedBatches: 0, reconciliation: false, heldPaths: 0,
  cloud: 'confirmed', cloudRevision: 2190, ...over })
/** A view whose `inspect` must never be called (no new IndexedDB transaction before her tree boots). */
const viewOf = (hydration: HydrationFacts | null): ThreadPersistenceView & { inspected: number } => {
  const view = { readOnly: false, hydration, inspected: 0, inspect: async () => { view.inspected += 1; throw new Error('inspect must not be called') } }
  return view
}

describe('the role comes from attach\'s hydration facts only', () => {
  it.each([
    ['seq 0, nothing held, her cloud\'s home at revision 2190 (stored and answered)', facts(), 'never-saved-cloud-home', 'reader', true],
    ['the local transport (the Mac host)', facts({ transport: 'local', storedRevision: null, cloudRevision: null, cloud: 'local' }), 'local', 'none', false],
    ['a new world: her cloud answered at this boot that her home is empty (revision 0)', facts({ storedRows: false, seq: null, storedRevision: null, cloudRevision: 0 }), 'empty-node', 'none', false],
    ['a stored revision-0 fence that her cloud confirms at revision 0', facts({ storedRevision: 0, cloudRevision: 0 }), 'empty-node', 'none', false],
    // An empty browser whose snapshot answered 503 at boot is UNCONFIRMED, never a writer.
    ['an empty browser whose cloud did not answer at boot (snapshot 503)', facts({ storedRows: false, seq: null, storedRevision: null, cloud: 'unreachable', cloudRevision: null }), 'unconfirmed', 'reader', true],
    // Stale revision-0 metadata from an import of an empty node, the cloud since moved on.
    ['stale revision-0 metadata, her cloud now at 2190 (diverged)', facts({ storedRevision: 0, cloud: 'diverged', cloudRevision: 2190 }), 'never-saved-cloud-home', 'reader', true],
    ['stale revision-0 metadata, her cloud silent at this boot', facts({ storedRevision: 0, cloud: 'unreachable', cloudRevision: null }), 'unconfirmed', 'reader', true],
    ['seq above 0', facts({ seq: 41 }), 'saved-before', 'none', false],
    ['seq above 0 and her cloud silent at this boot (his Chrome offline)', facts({ seq: 41, cloud: 'unreachable', cloudRevision: null }), 'saved-before', 'none', false],
    ['a queued batch', facts({ queuedBatches: 1 }), 'saved-before', 'none', false],
    ['seq 0 with a reconciliation hold', facts({ reconciliation: true }), 'saved-before', 'none', false],
    ['seq 0 with held paths (an unsent removal, a waiting journal)', facts({ heldPaths: 1 }), 'saved-before', 'none', false],
    ['stored rows with no meta at all (local work, never made read-only)', facts({ seq: null, storedRevision: null, cloud: 'unreachable', cloudRevision: null }), 'saved-before', 'none', false],
    ['no facts (no IndexedDB, or attach did not run)', null, 'unknown', 'none', false],
  ] as ReadonlyArray<readonly [string, HydrationFacts | null, string, string, boolean]>)('%s', async (_name, hydration, local, role, readOnly) => {
    expect(localFactsFromHydration(hydration)).toBe(local)
    const view = viewOf(hydration)
    const fake = await fakeEdge({ origin: ORIGIN, piece: PIECE, threads: [], sync: 'pull', fence: { lineageId: READER_LINEAGE, revision: 2190 } })
    vi.stubGlobal('fetch', fake.fetch)
    const boot = await bootThreadSync({ vfs: new MemoryVfs(), persistence: view, origin: ORIGIN, log: () => {} })
    expect(boot.role).toBe(role)
    expect(view.readOnly).toBe(readOnly)
    expect(view.inspected).toBe(0)
    // A reader starts no turn: the worker's fetch wrapper refuses a model door with the reader sentence.
    expect(readerRefusal('https://api.deepseek.com/chat/completions', ORIGIN, 'POST') !== null).toBe(role === 'reader')
    await boot.settled
    expect(threadCalls(fake.calls).map(call => call.path)).toEqual(['/_thread/index?limit=200'])
  })

  it('MUST 3: the boot opens no IndexedDB transaction of its own (inspect is never called), and a saved-before boot returns before the index answers', async () => {
    const view = viewOf(facts({ seq: 41, queuedBatches: 1 }))
    const fake = await fakeEdge({ origin: ORIGIN, piece: PIECE, threads: [], index: 'silent', fence: { lineageId: READER_LINEAGE, revision: 2190 } })
    vi.stubGlobal('fetch', fake.fetch)
    const started = Date.now()
    const boot = await bootThreadSync({ vfs: new MemoryVfs(), persistence: view, origin: ORIGIN, log: () => {},
      limits: { modeReadMs: 400 } })
    expect(Date.now() - started).toBeLessThan(200)
    expect([view.readOnly, view.inspected]).toEqual([false, 0])
    expect(await boot.settled).toEqual({ mode: 'off', report: null })
    expect(boot.latest()).toBeNull()
  })

  it('MUST 3 on the real store: after attach, the boot reads persistence.hydration and never inspect', async () => {
    install(readerStore([[B, B_OLD]]))
    const fake = await fakeEdge({ origin: ORIGIN, piece: PIECE, threads: [], sync: 'off', fence: { lineageId: READER_LINEAGE, revision: 2190 } })
    vi.stubGlobal('fetch', fake.fetch)
    const vfs = new MemoryVfs()
    vfs.mkdirSync('/dsh/home/auma', { recursive: true })
    persistence.readOnly = false
    await attachIdbPersistence(vfs, ROOTS, FAST)
    const realInspect = persistence.inspect
    let inspected = 0
    persistence.inspect = async (limit?: number) => { inspected += 1; return await realInspect(limit) }
    try {
      const boot = await bootThreadSync({ vfs, origin: ORIGIN, log: () => {} })
      expect(boot.hydration).toMatchObject({ transport: 'cloud', seq: 0, storedRevision: 2190, cloud: 'confirmed', cloudRevision: 2190, queuedBatches: 0 })
      expect([boot.role, inspected]).toEqual(['reader', 0])
    } finally { persistence.inspect = realInspect }
  })

  it('MUST 1 on the real store: an empty browser whose /api/snapshot answers 503 is a reader, read-only, and refuses a turn', async () => {
    install(new Map([['@x6-content-revision', { kind: 'content-revision', seq: 0 }]]))
    const fake = await fakeEdge({ origin: ORIGIN, piece: PIECE, threads: [], sync: 'off', fence: { lineageId: READER_LINEAGE, revision: 2190 } })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), ORIGIN)
      if (url.pathname === '/api/snapshot') return Response.json({ ok: false, code: 'UNAVAILABLE' }, { status: 503 })
      return await fake.fetch(input, init)
    })
    const vfs = new MemoryVfs()
    vfs.mkdirSync('/dsh/home/auma', { recursive: true })
    persistence.readOnly = false
    await attachIdbPersistence(vfs, ROOTS, FAST)
    expect(persistence.hydration).toMatchObject({ storedRows: false, seq: null, cloud: 'unreachable', cloudRevision: null })
    const boot = await bootThreadSync({ vfs, origin: ORIGIN, log: () => {} })
    expect([boot.facts, boot.role, persistence.readOnly]).toEqual(['unconfirmed', 'reader', true])
    expect(readerRefusal('https://api.deepseek.com/chat/completions', ORIGIN, 'POST')).toBe(READER_OLDER_FOOTER)
    expect(readerRefusal(`${ORIGIN}/door/deepseek/chat/completions`, ORIGIN, 'POST')).toBe(READER_OLDER_FOOTER)
  })

  it('MUST 1 on the real store: stale revision-0 metadata (an import of an empty node) after her cloud moved to 2190 is a reader', async () => {
    install(readerStore([[B, B_OLD]], 0))
    const { boot } = await (async () => {
      const fake = await fakeEdge({ origin: ORIGIN, piece: PIECE, threads: [], sync: 'off', fence: { lineageId: READER_LINEAGE, revision: 2190 } })
      vi.stubGlobal('fetch', fake.fetch)
      const vfs = new MemoryVfs()
      vfs.mkdirSync('/dsh/home/auma', { recursive: true })
      persistence.readOnly = false
      await attachIdbPersistence(vfs, ROOTS, FAST)
      return { boot: await bootThreadSync({ vfs, origin: ORIGIN, log: () => {} }) }
    })()
    expect(boot.hydration).toMatchObject({ seq: 0, storedRevision: 0, cloud: 'diverged', cloudRevision: 2190 })
    expect([boot.facts, boot.role, persistence.readOnly]).toEqual(['never-saved-cloud-home', 'reader', true])
  })

  it('a browser at seq 0 that saved lines behind a cloud hold (the reconciliation marker in her store) stays a writer of its own work', async () => {
    // The rows a held save leaves (idb-persist.ts:1570-1592): the content row, the marker, the content revision one up,
    // and the meta untouched at seq 0.
    const rows = readerStore([[B, B_OLD]])
    rows.set('/dsh/home/auma/typed-here.md', { kind: 'file', bytes: new TextEncoder().encode('saved in this browser only\n'), mode: 0o644, mtimeMs: 1_762_000_000_500 })
    rows.set('@x6-cloud-reconciliation', { kind: 'cloud-reconciliation', firstRevision: 2, lastRevision: 2, scope: 'all-persisted-mirror-content', cause: 'transient' })
    rows.set('@x6-content-revision', { kind: 'content-revision', seq: 2 })
    const { boot, readOnlyAtBoot, fake } = await load(rows, { threads: [{ path: B, bytes: B_BYTES }], sync: 'pull' })
    expect(boot.hydration).toMatchObject({ queuedBatches: 0, seq: 0, reconciliation: true })
    expect([boot.facts, boot.role, readOnlyAtBoot, threadReader.footer]).toEqual(['saved-before', 'none', false, null])
    await boot.settled
    expect(fake.calls.filter(call => call.path.startsWith('/_thread/manifest') || call.path.startsWith('/_vault/'))).toEqual([])
  })

  it('local facts unknown, mode on: the page is told this browser does not hold her home; mode off: nothing is posted', async () => {
    for (const [sync, footer] of [['on', NONE_ON_FOOTER], ['off', null]] as const) {
      const view = viewOf(null)
      const fake = await fakeEdge({ origin: ORIGIN, piece: PIECE, threads: [], sync, fence: { lineageId: READER_LINEAGE, revision: 2190 } })
      vi.stubGlobal('fetch', fake.fetch)
      const posted: unknown[] = []
      const boot = await bootThreadSync({ vfs: new MemoryVfs(), persistence: view, origin: ORIGIN, log: () => {},
        channel: () => ({ postMessage: (message) => { posted.push(message) }, onmessage: null }) })
      await boot.settled
      expect(posted.map(message => (message as { footer: string }).footer)).toEqual(footer === null ? [] : [footer])
    }
  })

  it('every message carries the page id its page gave the worker (the d3marks SHOULD); a malformed id is left out', async () => {
    for (const [pageId, worker] of [['0123456789abcdef', '0123456789abcdef'], ['not an id', undefined]] as const) {
      const fake = await fakeEdge({ origin: ORIGIN, piece: PIECE, threads: [], sync: 'off', fence: { lineageId: READER_LINEAGE, revision: 2190 } })
      vi.stubGlobal('fetch', fake.fetch)
      const posted: Array<Record<string, unknown>> = []
      const boot = await bootThreadSync({ vfs: new MemoryVfs(), persistence: viewOf(facts()), origin: ORIGIN, log: () => {}, pageId,
        channel: () => ({ postMessage: (message) => { posted.push(message as Record<string, unknown>) }, onmessage: null }) })
      await boot.settled
      expect(posted.length).toBeGreaterThan(0)
      for (const message of posted) expect(message.worker).toBe(worker)
      threadReader.footer = null
    }
  })

  it('review SHOULD 1: a reader answers only its own page\'s ask; another tab\'s ask (or one with no id) never makes it re-post the reader state', async () => {
    const own = '0123456789abcdef0123456789abcdef'
    const fake = await fakeEdge({ origin: ORIGIN, piece: PIECE, threads: [], sync: 'off', fence: { lineageId: READER_LINEAGE, revision: 2190 } })
    vi.stubGlobal('fetch', fake.fetch)
    let channel: ThreadSyncChannel | null = null
    const posted: Array<Record<string, unknown>> = []
    const boot = await bootThreadSync({ vfs: new MemoryVfs(), persistence: viewOf(facts()), origin: ORIGIN, log: () => {}, pageId: own,
      channel: () => {
        channel = { postMessage: (message) => { posted.push(message as Record<string, unknown>) }, onmessage: null }
        return channel
      } })
    await boot.settled
    expect(boot.role).toBe('reader')
    const count = posted.length
    expect(count).toBeGreaterThan(0)
    const ask = (data: unknown) => { channel?.onmessage?.({ data }) }
    ask({ v: 1, kind: 'ask', worker: 'f'.repeat(32) })
    ask({ v: 1, kind: 'ask' })
    expect(posted).toHaveLength(count)
    ask({ v: 1, kind: 'ask', worker: own })
    expect(posted).toHaveLength(count + 1)
    expect(posted.at(-1)).toMatchObject({ kind: 'state', role: 'reader', worker: own })
    threadReader.footer = null
  })

  it('MUST 2 in the worker: a reader refuses the GETs that change her node, and lets her reads through', () => {
    threadReader.footer = READER_OLDER_FOOTER
    expect(readerRefusal(`${ORIGIN}/_head/promotion-status`, ORIGIN, 'GET')).toBe(READER_OLDER_FOOTER)
    expect(readerRefusal(`${ORIGIN}/_head/transcript`, ORIGIN, 'GET')).toBe(READER_OLDER_FOOTER)
    expect(readerRefusal(`${ORIGIN}/_host/wake`, ORIGIN, 'POST')).toBe(READER_OLDER_FOOTER)
    expect(readerRefusal(`${ORIGIN}/_thread/index?limit=200`, ORIGIN, 'GET')).toBeNull()
    expect(readerRefusal(`${ORIGIN}/_host/wake`, ORIGIN, 'GET')).toBeNull()
    threadReader.footer = null
    expect(readerRefusal(`${ORIGIN}/_head/promotion-status`, ORIGIN, 'GET')).toBeNull()
  })
})

describe('a browser that never saved is a reader in every mode and on every failure to read the mode', () => {
  const rows = readerStore([[B, B_OLD]])
  it.each([
    ['index 503', { index: 503 }],
    ['index 401 (signed out)', { index: 401 }],
    ['no sync field', {}],
    ['sync off', { sync: 'off' }],
    ['a malformed body', { index: 'malformed' }],
    ['an unknown word', { sync: 'everything' }],
  ] as ReadonlyArray<readonly [string, Partial<FakeEdgeOptions>]>)('%s: readOnly before the tree boots, no pull, zero /_mirror/delta calls, no row changes', async (_name, edge) => {
    const { vfs, boot, fake, before, readOnlyAtBoot } = await load(rows, { threads: [{ path: B, bytes: B_BYTES }], ...edge })
    expect(boot.role).toBe('reader')
    expect(readOnlyAtBoot).toBe(true)
    // Before any call of thread sync: the one index read already saw readOnly set.
    expect(threadCalls(fake.calls)).toEqual([{ method: 'GET', path: '/_thread/index?limit=200', readOnlyAtCall: true }])
    expect(threadReader.footer).toBe(READER_OLDER_FOOTER)
    expect(boot.latest()).toMatchObject({ v: 1, kind: 'state', mode: 'off', role: 'reader', footer: READER_OLDER_FOOTER })
    // The first import's copy is shown, untouched.
    expect(sha256(bytesAt(vfs, B))).toBe(sha256(B_OLD))
    // Her tree writes (its boot writes balls/HEAD.json and more): nothing is saved, nothing goes to her cloud.
    vfs.writeFileSync('/dsh/home/auma/notes.md', 'written by the tree in a reader\n')
    vfs.appendFileSync(B, '{"typed":"in the reader"}\n')
    await pause(700)
    expect(deltas(fake.calls)).toEqual([])
    expect(fake.calls.filter(call => call.method !== 'GET' && call.method !== 'HEAD')).toEqual([])
    expect(sameRows(before, rowsNow())).toBe(true)
    expect(persistence.readOnly).toBe(true)
  })

  it('a 4 s silence (the default deadline) reads as off: still a reader, and the boot goes on', { timeout: 20_000 }, async () => {
    expect(THREAD_SYNC_LIMITS.modeReadMs).toBe(4_000)
    const started = Date.now()
    const { boot, fake, before, readOnlyAtBoot, vfs } = await load(rows, { threads: [{ path: B, bytes: B_BYTES }], index: 'silent' })
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(3_900)
    expect(waited).toBeLessThan(8_000)
    expect([boot.role, readOnlyAtBoot, threadReader.footer]).toEqual(['reader', true, READER_OLDER_FOOTER])
    expect(threadCalls(fake.calls)).toHaveLength(1)
    vfs.writeFileSync('/dsh/home/auma/notes.md', 'written by the tree in a reader\n')
    await pause(700)
    expect(deltas(fake.calls)).toEqual([])
    expect(sameRows(before, rowsNow())).toBe(true)
  })

  it('control: without thread sync the same store saves and sends a tree write (so the cases above can fail)', async () => {
    install(rows)
    const fake = await fakeEdge({ origin: ORIGIN, piece: PIECE, threads: [], fence: { lineageId: READER_LINEAGE, revision: 2190 } })
    vi.stubGlobal('fetch', fake.fetch)
    const vfs = new MemoryVfs()
    vfs.mkdirSync('/dsh/home/auma', { recursive: true })
    persistence.readOnly = false
    await attachIdbPersistence(vfs, ROOTS, FAST)
    vfs.writeFileSync('/dsh/home/auma/notes.md', 'written by the tree\n')
    await pause(900)
    expect(deltas(fake.calls).length).toBeGreaterThan(0)
  })

  it('what attach records for this store (the facts the role is read from)', async () => {
    const { boot } = await load(rows, { threads: [], sync: 'off' })
    expect(boot.hydration).toEqual({ transport: 'cloud', storedRows: true, seq: 0, clientId: '9a7c1e55-2b3d-4f60-8a91-b2c3d4e5f607',
      storedRevision: 2190, queuedBatches: 0, reconciliation: false, heldPaths: 0, cloud: 'confirmed', cloudRevision: 2190 })
  })
})

describe('a reader in pull pulls each thread whole, checked, into memory only', () => {
  it('newest first; an older local copy is extended, a different one is kept; nothing is written to IndexedDB; no POST', async () => {
    const differs = journal(PIECE + 50, 'mine')
    const rows = readerStore([[B, B_OLD], [C, differs]])
    const threads: CloudThread[] = [
      { path: A, bytes: A_BYTES, activeAt: 3_000 }, { path: B, bytes: B_BYTES, activeAt: 2_000 },
      { path: C, bytes: C_BYTES, activeAt: 5_000 },
    ]
    const entered: number[] = []
    const { vfs, boot, fake, before } = await load(rows, { threads, sync: 'pull', lease: { label: 'Chrome on the Mac', since: 1, seenAt: 2, live: true, asked: false } },
      { enter: () => { entered.push(Date.now()) }, now: () => new Date(2026, 10, 13, 9, 41, 0).getTime() })
    const settled = await boot.settled
    expect(settled.mode).toBe('pull')
    expect(settled.report).toMatchObject({ wanted: 3, seeded: [A, B], same: [], kept: [C], failed: [], long: 0, leftForLater: 0 })
    expect(sha256(bytesAt(vfs, A))).toBe(sha256(A_BYTES))
    expect(sha256(bytesAt(vfs, B))).toBe(sha256(B_BYTES))
    expect(sha256(bytesAt(vfs, C))).toBe(sha256(differs))
    // Newest first (C, A, B), by their manifests.
    const manifests = fake.calls.filter(call => call.path.startsWith('/_thread/manifest')).map(call => call.path.slice('/_thread/manifest?id='.length, -'&page=0'.length))
    expect(manifests).toEqual([C, A, B].map(sha256))
    // Parts: A five, B three, C one (C is read and checked, then kept local); every call a GET, made while read-only.
    expect(fake.calls.filter(call => call.path.startsWith('/_vault/blob/'))).toHaveLength(5 + 3 + 1)
    expect(threadCalls(fake.calls).every(call => call.method === 'GET' && call.readOnlyAtCall)).toBe(true)
    // Before thread sync, idb-persist read only the fence (its own GET); nothing but GETs at all.
    expect(fake.calls.filter(call => !threadCalls([call]).length).map(call => `${call.method} ${call.path}`)).toEqual(['GET /_mirror/status?compact=1'])
    expect(entered.length).toBe(1 + 3)
    const footer = readerPulledFooter(new Date(2026, 10, 13, 9, 41, 0).getTime(), 'Chrome on the Mac', 0)
    expect(footer).toBe('Reading her from her cloud, read at 09:41. She answers in Chrome on the Mac. Nothing typed here is saved.')
    expect(threadReader.footer).toBe(footer)
    expect(boot.latest()).toMatchObject({ mode: 'pull', role: 'reader', footer })
    await pause(400)
    expect(sameRows(before, rowsNow())).toBe(true)
  })

  it('one flipped byte in a part, a chain mismatch, a torn open end: nothing of that thread is seeded, the rest go on', async () => {
    const torn = join(journal(PIECE + 10, 't'), new TextEncoder().encode('{"role":"assistant","text":"half a li'))
    const T = '/dsh/home/sessions/--dsh-home-auma--/session-t/session.v4.jsonl'
    const threads: CloudThread[] = [
      { path: A, bytes: A_BYTES }, { path: B, bytes: B_BYTES }, { path: T, bytes: torn }, { path: C, bytes: C_BYTES },
    ]
    const lines: string[] = []
    const { vfs, boot } = await load(readerStore([]), { threads, sync: 'pull', flipPartOf: A, wrongChainOf: B }, { log: (line) => { lines.push(line) } })
    const { report } = await boot.settled
    expect(report?.seeded).toEqual([C])
    expect(report?.failed.sort()).toEqual([
      `${A}: part 1 of 5 does not hash to its name`,
      `${B}: the chain of its parts does not match its manifest`,
      `${T}: its open end ends inside a line`,
    ].sort())
    for (const path of [A, B, T]) expect(vfs.existsSync(path)).toBe(false)
    expect(sha256(bytesAt(vfs, C))).toBe(sha256(C_BYTES))
    expect(lines.filter(line => line.includes('is not shown from her cloud'))).toHaveLength(3)
    // The three not shown are counted where a person reads it.
    expect(threadReader.footer).toMatch(/ Nothing typed here is saved\. 3 threads stay in her cloud\.$/)
  })

  it('every wanted thread fails its checks: the footer says it reads an older copy, never a fresh read', async () => {
    const { boot } = await load(readerStore([[B, B_OLD]]), { threads: [{ path: A, bytes: A_BYTES }, { path: B, bytes: B_BYTES }],
      sync: 'pull', flipPartOf: A, wrongChainOf: B })
    const { report } = await boot.settled
    expect(report).toMatchObject({ wanted: 2, seeded: [], same: [] })
    expect(report?.failed).toHaveLength(2)
    expect(threadReader.footer).toBe(READER_OLDER_FOOTER)
    expect(boot.latest()).toMatchObject({ mode: 'pull', role: 'reader', footer: READER_OLDER_FOOTER })
  })

  it('a thread whose last whole line ends in its sealed parts keeps [0, lineEnd), checked part by part, and reads no open end', async () => {
    const whole = journal(2 * PIECE, 'sealed')
    const torn = join(whole, new TextEncoder().encode('{"role":"assistant","text":"half a li'))
    const T = '/dsh/home/sessions/--dsh-home-auma--/session-t/session.v4.jsonl'
    const { vfs, boot, fake } = await load(readerStore([]), { threads: [{ path: T, bytes: torn }], sync: 'pull' })
    const { report } = await boot.settled
    expect(report).toMatchObject({ wanted: 1, seeded: [T], failed: [] })
    expect(sha256(bytesAt(vfs, T))).toBe(sha256(whole))
    expect(fake.calls.filter(call => call.path.startsWith('/_vault/blob/'))).toHaveLength(2)
    expect(fake.calls.filter(call => call.path.startsWith('/_thread/tail'))).toEqual([])
  })

  it('the pull holds at most readerTotalBytes in memory: a thread that would pass it is not asked for, a smaller older one still is, and the footer counts it', async () => {
    expect(THREAD_SYNC_LIMITS.readerTotalBytes).toBe(128 * 1024 * 1024)
    const threads: CloudThread[] = [
      { path: C, bytes: C_BYTES, activeAt: 9 }, { path: A, bytes: A_BYTES, activeAt: 8 }, { path: B, bytes: B_BYTES, activeAt: 7 },
    ]
    const room = C_BYTES.byteLength + B_BYTES.byteLength
    expect(room).toBeLessThan(C_BYTES.byteLength + A_BYTES.byteLength)
    const { vfs, boot, fake } = await load(readerStore([]), { threads, sync: 'pull' }, { limits: { readerTotalBytes: room } })
    const { report } = await boot.settled
    expect(report).toMatchObject({ wanted: 3, seeded: [C, B], failed: [], overRoom: 1, leftForLater: 0 })
    expect(vfs.existsSync(A)).toBe(false)
    expect(fake.calls.some(call => call.path.includes(sha256(A)))).toBe(false)
    expect(threadReader.footer).toMatch(/ Nothing typed here is saved\. 1 thread stays in her cloud\.$/)
  })

  it('a thread above 64 MiB is left in her cloud (no manifest read) and the footer counts it', { timeout: 60_000 }, async () => {
    expect(THREAD_SYNC_LIMITS.readerMaxThreadBytes).toBe(64 * 1024 * 1024)
    const size = 64 * 1024 * 1024 + 1
    const big = new Uint8Array(size).fill(0x61)
    for (let at = 99; at < size; at += 100) big[at] = 10
    big[size - 1] = 10
    const BIG = '/dsh/home/sessions/--dsh-home-auma--/session-main/session.v4.jsonl'
    const { vfs, boot, fake } = await load(readerStore([]), { threads: [{ path: BIG, bytes: big, activeAt: 9_000 }, { path: C, bytes: C_BYTES }], sync: 'pull', piece: 2_097_152 },
      { now: () => new Date(2026, 10, 13, 9, 5, 0).getTime() })
    const { report } = await boot.settled
    expect(report).toMatchObject({ wanted: 1, long: 1, seeded: [C] })
    expect(vfs.existsSync(BIG)).toBe(false)
    expect(fake.calls.some(call => call.path.includes(sha256(BIG)))).toBe(false)
    expect(threadReader.footer).toBe('Reading her from her cloud, read at 09:05. She answers in the browser that holds her home. Nothing typed here is saved. 1 long thread stays in her cloud.')
  })

  it('the budget runs out: the boot still goes on, what did not fit stays in her cloud, the reader stays read-only', async () => {
    const threads: CloudThread[] = [{ path: A, bytes: A_BYTES, activeAt: 9 }, { path: C, bytes: C_BYTES, activeAt: 1 }]
    const started = Date.now()
    const { vfs, boot, readOnlyAtBoot } = await load(readerStore([]), { threads, sync: 'on', silentBlobsOf: A },
      { limits: { pullBudgetMs: 600, requestMs: 700 } })
    expect(Date.now() - started).toBeLessThan(3_000)
    const { report } = await boot.settled
    expect(report).toMatchObject({ wanted: 2, seeded: [], leftForLater: 2 })
    expect(vfs.existsSync(A)).toBe(false)
    expect(readOnlyAtBoot).toBe(true)
    // Nothing was read from her cloud: the footer must not claim a fresh read.
    expect(threadReader.footer).toBe(READER_OLDER_FOOTER)
  })

  it('the footer counts what stays in her cloud: "long" only when every one is long', () => {
    const at = new Date(2026, 10, 13, 9, 5, 0).getTime()
    const head = 'Reading her from her cloud, read at 09:05. She answers in the browser that holds her home. Nothing typed here is saved.'
    expect(readerPulledFooter(at, null, 0, 0)).toBe(head)
    expect(readerPulledFooter(at, null, 2, 0)).toBe(`${head} 2 long threads stay in her cloud.`)
    expect(readerPulledFooter(at, null, 1, 1)).toBe(`${head} 2 threads stay in her cloud.`)
    expect(readerPulledFooter(at, null, 0, 1)).toBe(`${head} 1 thread stays in her cloud.`)
    expect(readerPulledFooter(at, 'x'.repeat(60), 900, 900).length).toBeLessThanOrEqual(200)
  })

  it('the page asks on the channel and hears the latest state', async () => {
    let channel: ThreadSyncChannel | null = null
    const posted: unknown[] = []
    const { boot } = await load(readerStore([]), { threads: [{ path: C, bytes: C_BYTES }], sync: 'pull' },
      { channel: () => { channel = { postMessage: (message) => { posted.push(message) }, onmessage: null }; return channel } })
    await boot.settled
    // MUST 2: the reader is told at once (before any call, older-copy sentence), then once more after the pull.
    expect(posted).toHaveLength(2)
    expect(posted[0]).toMatchObject({ v: 1, kind: 'state', mode: 'off', role: 'reader', footer: READER_OLDER_FOOTER })
    ;(channel as ThreadSyncChannel | null)?.onmessage?.({ data: { v: 1, kind: 'ask' } })
    ;(channel as ThreadSyncChannel | null)?.onmessage?.({ data: { v: 2, kind: 'ask' } })
    expect(posted).toHaveLength(3)
    expect(posted[2]).toEqual(posted[1])
    expect(THREAD_SYNC_CHANNEL).toBe('aukora-x6-thread-sync')
    expect((posted[1] as { footer: string }).footer.length).toBeLessThanOrEqual(200)
  })
})

describe('MUST 4: an incomplete pull never claims "read at HH:MM"', () => {
  const page = (threads: unknown[], next: string | null) => new TextEncoder().encode(JSON.stringify({ ok: true, threads, next, sync: 'pull', lease: null }))
  const reply = (bytes: Uint8Array) => ({ status: 200, headers: new Headers(), bytes })
  const row = (path: string, bytes: number) => ({ id: sha256(path), path, bytes, activeAt: 5, updatedAt: 5 })

  it('page one lists a thread and `next`; the next index pages use up the budget: nothing verified, the older-copy sentence', async () => {
    const first = page([row(A, 100)], 'f'.repeat(64))
    let clock = 0
    const net: ThreadNet = {
      async get(path) {
        if (path.startsWith('/_thread/index?limit=')) return reply(first)
        // Every later index page is answered only after the whole budget has passed.
        clock += 1_000
        return { status: 0, headers: new Headers(), bytes: new Uint8Array(0) }
      },
    }
    const boot = await bootThreadSync({ vfs: new MemoryVfs(), persistence: viewOf(facts()), origin: ORIGIN, net, log: () => {},
      now: () => clock, limits: { pullBudgetMs: 500 } })
    const { report } = await boot.settled
    expect(report?.incomplete).toBe(true)
    expect(report?.seeded).toEqual([])
    expect(threadReader.footer).toBe(READER_OLDER_FOOTER)
    expect(boot.latest()?.footer).toBe(READER_OLDER_FOOTER)
  })

  it('an index that lists only threads too long for a reader: nothing verified, the older-copy sentence', async () => {
    const net: ThreadNet = { get: async () => reply(page([row(A, 10_000)], null)) }
    const boot = await bootThreadSync({ vfs: new MemoryVfs(), persistence: viewOf(facts()), origin: ORIGIN, net, log: () => {},
      limits: { readerMaxThreadBytes: 1_000 } })
    const { report } = await boot.settled
    expect(report).toMatchObject({ wanted: 0, long: 1, incomplete: false })
    expect(threadReader.footer).toBe(READER_OLDER_FOOTER)
  })

  it('a page of her index that does not read: the pull is incomplete even when an earlier thread was verified', async () => {
    const store = new MemoryVfs()
    const listed = { [A]: A_BYTES }
    const fake = await fakeEdge({ origin: ORIGIN, piece: PIECE, threads: [{ path: A, bytes: listed[A] }], sync: 'pull', fence: { lineageId: READER_LINEAGE, revision: 2190 } })
    const net: ThreadNet = {
      async get(path, deadlineMs, maxBytes) {
        if (path.includes('after=')) return { status: 503, headers: new Headers(), bytes: new Uint8Array(0) }
        const answer = await fake.fetch(`${ORIGIN}${path}`)
        const bytes = new Uint8Array(await answer.arrayBuffer())
        if (path.startsWith('/_thread/index?limit=')) {
          const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
          return reply(new TextEncoder().encode(JSON.stringify({ ...body, next: 'e'.repeat(64) })))
        }
        void deadlineMs; void maxBytes
        return { status: answer.status, headers: answer.headers, bytes }
      },
    }
    const boot = await bootThreadSync({ vfs: store, persistence: viewOf(facts()), origin: ORIGIN, net, log: () => {} })
    const { report } = await boot.settled
    expect(report).toMatchObject({ seeded: [A], incomplete: true })
    expect(threadReader.footer).toBe(READER_OLDER_FOOTER)
  })

  it('pullIsFresh: fresh only when read whole and a conversation was verified, or her index is truly empty', () => {
    const base: ThreadPullReport = { wanted: 0, seeded: [], same: [], kept: [], failed: [], long: 0, leftForLater: 0, overRoom: 0,
      incomplete: false }
    expect(pullIsFresh(base)).toBe(true)
    expect(pullIsFresh({ ...base, incomplete: true })).toBe(false)
    expect(pullIsFresh({ ...base, long: 2 })).toBe(false)
    expect(pullIsFresh({ ...base, wanted: 1, failed: ['x: y'] })).toBe(false)
    expect(pullIsFresh({ ...base, wanted: 1, kept: [A] })).toBe(false)
    expect(pullIsFresh({ ...base, wanted: 2, seeded: [A], failed: ['x: y'] })).toBe(true)
    expect(pullIsFresh({ ...base, wanted: 2, seeded: [A], incomplete: true })).toBe(false)
    void pullThreads
  })
})
