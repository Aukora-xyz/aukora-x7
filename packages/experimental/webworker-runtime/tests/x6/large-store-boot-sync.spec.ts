/**
 * A large store (made up for this spec, as the large-store boot spec's) is untouched by thread sync, in every mode and with the
 * index failing. That browser has saved before (mirror seq 41, one queued save), so it is never set read-only, never
 * pulled into and never seeded; its boot waits on nothing new; it makes exactly one thread call (the index GET) and no
 * POST; and it goes on saving its turns locally.
 *
 * The store and the row rule are the large-store boot spec's (large-store-boot.spec.ts), copied unchanged below: the large-store boot spec exports nothing, a
 * spec cannot import another spec (it would run its cases), and the large-store boot spec must not be edited. Each case boots the real
 * idb-persist.ts as the large-store boot spec's `load()` does, then runs thread sync exactly as worker-host.ts runs it.
 */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { attachIdbPersistence, persistence, DB_NAME, type AttachOptions, type MirrorBatch, type WireEntry } from '../../src/storage/idb-persist.ts'
import { bootThreadSync, bootThreadSyncIfOn, threadReader, threadSyncSelfStateField, threadSyncSwitch } from '../../src/storage/thread-sync.ts'
import { FakeDb, FakeIndexedDb, FakeKeyRange, fakeEdge, journal, READER_LINEAGE, readerStore, type FakeEdgeOptions } from './thread-sync-fixture.ts'

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
 * 'in-step': base revision 2190, no reconciliation row and no queued save; every other row the same.
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
    rows.set(META_KEY, { kind: 'mirror-meta', clientId: CLIENT, seq: 41, cloudBase: { lineageId: LINEAGE, revision: 2190 }, cloudAcknowledgedSeq: 41 })
  }
  return rows
}

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
// The cases.
// ---------------------------------------------------------------------------------------------------------------------
const ORIGIN = 'https://node.example.invalid'
/** As the large-store boot spec: boot, then let the first drain, its first retry and the first resync window (20 ms here) pass. */
const SETTLE_MS = 1_500
const bytesOf = (vfs: MemoryVfs, path: string): Uint8Array => new Uint8Array(vfs.readFileSync(path) as Uint8Array)
let fakeDb: FakeDb
function install(rows: ReadonlyMap<string, unknown>): void {
  const idb = new FakeIndexedDb()
  fakeDb = new FakeDb()
  fakeDb.data = snapshot(rows)
  idb.dbs.set(DB_NAME, fakeDb)
  vi.stubGlobal('indexedDB', idb)
}
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
/** Her cloud holds some threads of her own, the main one among them (as after Join), so a pull would have work to do. */
const CLOUD_THREADS = [
  { path: MAIN_JOURNAL, bytes: journal(9_000, 'cloud-main') },
  { path: '/dsh/home/sessions/--dsh-home-auma--/session-side/session.v4.jsonl', bytes: journal(70_000, 'cloud-side') },
  { path: '/dsh/home/sessions/--dsh-home-auma--/session-new/session.v4.jsonl', bytes: journal(5_000, 'cloud-new') },
]

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

describe('the held store, thread sync in every mode: no row moves, never read-only, one index GET, no POST', () => {
  it.each([
    ['off', { sync: 'off' }],
    ['pull', { sync: 'pull' }],
    ['on', { sync: 'on' }],
    ['the index failing (503)', { sync: 'pull', index: 503 }],
    ['no sync field', {}],
    ['the index silent', { sync: 'pull', index: 'silent' as const }],
  ] as ReadonlyArray<readonly [string, Partial<FakeEdgeOptions>]>)('%s', { timeout: 120_000 }, async (_name, edgeOptions) => {
    const before = buildStore('held')
    install(before)
    const edge = await fakeEdge({ origin: ORIGIN, piece: 4096, threads: CLOUD_THREADS, fence: { lineageId: LINEAGE, revision: 2190 },
      readOnly: () => persistence.readOnly, ...edgeOptions })
    vi.stubGlobal('fetch', edge.fetch)
    const vfs = new MemoryVfs()
    vfs.mkdirSync('/dsh/home/auma', { recursive: true })
    vfs.mkdirSync('/dsh/workspace', { recursive: true })
    persistence.readOnly = false
    await attachIdbPersistence(vfs, ROOTS, FAST)

    const started = Date.now()
    const boot = await bootThreadSync({ vfs, origin: ORIGIN, log: () => {}, limits: { modeReadMs: 600 } })
    // Its boot waits on nothing new (only the one local inspect read).
    expect(Date.now() - started).toBeLessThan(300)
    expect([boot.facts, boot.role, persistence.readOnly]).toEqual(['saved-before', 'none', false])
    await boot.settled
    await pause(SETTLE_MS)

    expect(violations(diffRows(before, fakeDb.data), ALLOWED.held)).toEqual([])
    expect(contentSeq()).toBe(CONTENT_SEQ)
    expect(persistence.readOnly).toBe(false)
    expect(threadReader.footer).toBeNull()
    expect(boot.latest()).toBeNull()
    const threadCalls = edge.calls.filter(call => /^\/_(thread|vault|mirror\/lease)/.test(call.path))
    expect(threadCalls).toEqual([{ method: 'GET', path: '/_thread/index?limit=200', readOnlyAtCall: false }])
    expect(edge.calls.filter(call => call.method !== 'GET')).toEqual([])
    // Nothing pulled into its tree: its journal is its own, byte for byte; a thread only her cloud has is not here.
    expect(sha256(bytesOf(vfs, MAIN_JOURNAL))).toBe(sha256(MAIN_TEMPLATE))
    expect(vfs.existsSync('/dsh/home/sessions/--dsh-home-auma--/session-new/session.v4.jsonl')).toBe(false)

    // And he works on: a 200-byte turn is saved locally, as the large-store boot spec case B.
    vfs.appendFileSync(MAIN_JOURNAL, TURN)
    await waitForRowLength(MAIN_JOURNAL, MAIN_BYTES + TURN.byteLength)
    await pause(300)
    expect(sha256(rowBytes(MAIN_JOURNAL) ?? new Uint8Array())).toBe(sha256(Buffer.concat([MAIN_TEMPLATE, TURN])))
    expect(contentSeq()).toBe(CONTENT_SEQ + 1)
    expect(edge.calls.filter(call => call.method !== 'GET')).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Inert while the switch is unset. "Main" here is the same page load with no thread sync at all (attach,
// then nothing: what main's worker-host.ts does); "this branch" is attach, then `bootThreadSyncIfOn` exactly as
// worker-host.ts calls it, with what the boot document carried. Two browsers: the held one (saved her: seq 41, a queued save, a
// cloud hold) and one that never saved her (seq 0 on her cloud's home at 2190: a reader when the switch is on).
// ---------------------------------------------------------------------------------------------------------------------
type Store = 'held' | 'never-saved'
const neverSaved = (): Map<string, unknown> => readerStore([[MAIN_JOURNAL, journal(9_000, 'cloud-main')]])
const storeOf = (store: Store): Map<string, unknown> => (store === 'held' ? buildStore('held') : neverSaved())
const fenceOf = (store: Store) => (store === 'held' ? { lineageId: LINEAGE, revision: 2190 } : { lineageId: READER_LINEAGE, revision: 2190 })
/** Consecutive repeats of one call (the resync's timed retries) folded into one, so two runs compare by order. */
const folded = (calls: ReadonlyArray<{ method: string; path: string }>): string[] =>
  calls.map(call => `${call.method} ${call.path}`).filter((line, index, all) => index === 0 || all[index - 1] !== line)

interface Run {
  calls: Array<{ method: string; path: string }>
  atBoot: number
  rows: Map<string, unknown>
  before: Map<string, unknown>
  readOnly: boolean
  channels: number
  boot: Awaited<ReturnType<typeof bootThreadSyncIfOn>> | 'main'
}
/** One page load of `store` against an edge whose index says `sync`; `served` undefined with `main` true runs no thread sync. */
async function pageLoad(store: Store, sync: string, served: unknown, main: boolean): Promise<Run> {
  const before = storeOf(store)
  install(before)
  let channels = 0
  vi.stubGlobal('BroadcastChannel', class { constructor() { channels += 1 } postMessage() {} close() {} onmessage = null })
  const edge = await fakeEdge({ origin: ORIGIN, piece: 4096, threads: CLOUD_THREADS, fence: fenceOf(store),
    readOnly: () => persistence.readOnly, sync })
  vi.stubGlobal('fetch', edge.fetch)
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma', { recursive: true })
  vfs.mkdirSync('/dsh/workspace', { recursive: true })
  persistence.readOnly = false
  threadSyncSwitch.on = false
  await attachIdbPersistence(vfs, ROOTS, FAST)
  const atBoot = edge.calls.length
  let boot: Run['boot'] = 'main'
  if (!main) {
    boot = await bootThreadSyncIfOn(served, { vfs, origin: ORIGIN, log: () => {}, limits: { modeReadMs: 600 } })
    // Switched off, the gate itself asks nothing: not one call between attach and the tree's boot.
    if (boot === null) expect(edge.calls.length).toBe(atBoot)
  }
  const readOnly = persistence.readOnly
  if (boot !== 'main' && boot !== null) await boot.settled
  await pause(SETTLE_MS)
  const calls = edge.calls.map(call => ({ method: call.method, path: call.path }))
  return { calls, atBoot, rows: snapshot(fakeDb.data), before, readOnly, channels, boot }
}

describe('with the switch unset, a page load is main\'s: the same requests in the same order, no mark, no row moves', () => {
  it.each([
    // (a) the switch unset at the edge (its index says `off`), and the boot document carried no meta.
    ['(a) the held browser, switch unset', 'held', 'off'],
    ['(a) a browser that never saved her, switch unset', 'never-saved', 'off'],
    // (c) the switch ON at the edge, but this page's boot document is an old one with no meta: it behaves as unset.
    ['(c) the held browser, an old document while the edge is on', 'held', 'on'],
    ['(c) a browser that never saved her, an old document while the edge is on', 'never-saved', 'on'],
  ] as ReadonlyArray<readonly [string, Store, string]>)('%s', { timeout: 120_000 }, async (_name, store, sync) => {
    const control = await pageLoad(store, sync, undefined, true)
    threadReader.footer = null
    const run = await pageLoad(store, sync, undefined, false)
    expect(run.boot).toBeNull()
    // The same requests in the same order as main: identical up to the tree's boot, and the same order after it.
    expect(run.calls.slice(0, run.atBoot)).toEqual(control.calls.slice(0, control.atBoot))
    expect(folded(run.calls)).toEqual(folded(control.calls))
    expect(run.calls.filter(call => /^\/_(thread|vault|mirror\/lease)/.test(call.path))).toEqual([])
    // No mark: never read-only (main's value), no reader sentence, no channel opened, no `threadSync` in her self-state.
    expect(run.readOnly).toBe(control.readOnly)
    expect(run.readOnly).toBe(false)
    expect(threadReader.footer).toBeNull()
    expect(run.channels).toBe(0)
    expect(threadSyncSwitch.on).toBe(false)
    expect(threadSyncSelfStateField()).toEqual({})
    // No stored byte differs from main's: the same rows changed, each to the same value.
    const mainDiff = diffRows(control.before, control.rows), ourDiff = diffRows(run.before, run.rows)
    expect(ourDiff).toEqual(mainDiff)
    for (const key of [...ourDiff.appear, ...ourDiff.change]) expect(sameValue(run.rows.get(key), control.rows.get(key))).toBe(true)
    if (store === 'held') expect(violations(ourDiff, ALLOWED.held)).toEqual([])
  })

  it('control: the same never-saved browser with the document saying `on` IS a reader, read-only, and reads her index (so the cases above can fail)', { timeout: 60_000 }, async () => {
    const run = await pageLoad('never-saved', 'on', 'on', false)
    expect(run.boot).not.toBeNull()
    expect(run.boot !== 'main' && run.boot?.role).toBe('reader')
    expect(run.readOnly).toBe(true)
    expect(run.channels).toBeGreaterThan(0)
    expect(run.calls.some(call => call.path.startsWith('/_thread/index'))).toBe(true)
    expect(threadSyncSelfStateField()).toHaveProperty('threadSync')
    threadSyncSwitch.on = false
  })

  it.each([[undefined], [null], ['off'], ['pull'], ['ON'], [' on'], ['on '], [true], [1], [{ on: true }]])(
    'served %j: null at once, nothing of persistence read or set', async (served) => {
      const touched: string[] = []
      const view = new Proxy({ readOnly: false, hydration: null, inspect: async () => { throw new Error('no') } }, {
        get(target, key): unknown { touched.push(`get ${String(key)}`); return Reflect.get(target, key) as unknown },
        set(target, key, value) { touched.push(`set ${String(key)}`); return Reflect.set(target, key, value) },
      })
      vi.stubGlobal('fetch', () => { throw new Error('no request may leave') })
      expect(await bootThreadSyncIfOn(served, { vfs: new MemoryVfs(), persistence: view, origin: ORIGIN, log: () => {} })).toBeNull()
      expect(touched).toEqual([])
      expect(threadSyncSwitch.on).toBe(false)
    })
})
