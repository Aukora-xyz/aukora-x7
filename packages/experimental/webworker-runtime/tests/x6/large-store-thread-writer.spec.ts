/**
 * Her runtime's storage boots on a large store (a browser that has
 * saved her before: mirror seq 41 acknowledged at her cloud's revision 2190, her conversations on disk, her notes), first
 * with the mode off, then on, against her REAL thread log and lease in memory (thread-writer-fixture.ts). It runs the
 * same three steps worker-host.ts runs: attach (the real idb-persist.ts), thread sync's boot, and her writer.
 * - Off: no lease, no append, no row of hers changes.
 * - On: nothing is lost and nothing is rewritten in place (every row and every local file byte-identical); each thread's
 *   new lines arrive at the edge once (no ALREADY), in order (each append at the length her cloud held after the one
 *   before), and her cloud then holds each local file byte for byte; a thread her cloud lacked is created.
 * - A second boot (a reload) sends nothing again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { attachIdbPersistence, persistence, DB_NAME, type AttachOptions } from '../../src/storage/idb-persist.ts'
import { bootThreadSync, threadReader, threadSyncState } from '../../src/storage/thread-sync.ts'
import { threadIdFor } from '../../src/storage/thread-sync-plan.ts'
import { startThreadWriter, type ThreadWriterLocks } from '../../src/storage/thread-writer.ts'
import { FakeDb, FakeIndexedDb, FakeKeyRange } from './thread-sync-fixture.ts'
import { EDGE_LINEAGE, EDGE_ORIGIN, EDGE_PIECE, edgeWriterNet, HELD_CLIENT, herEdge, joined, lines, sha, type HerEdge } from './thread-writer-fixture.ts'

const ROOTS = ['/dsh/home', '/dsh/workspace']
const FAST: AttachOptions = { read: { backoffMs: [0, 0], idleMs: 2_000, sleep: async () => {} }, resync: { firstMs: 20, maxMs: 80 } }
const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })
const MAIN = '/dsh/home/sessions/--dsh-home-auma--/session-main/session.v4.jsonl'
const SIDE = '/dsh/home/sessions/--dsh-home-auma--/session-side/session.v4.jsonl'
const LIVE = '/dsh/home/auma/session/messages.jsonl'
const NEW = '/dsh/home/sessions/--dsh-home-auma--/session-new/session.v4.jsonl'
const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

// What her cloud holds (Joined earlier from this browser), and what this browser holds now: each a proven extension.
const MAIN_CLOUD = lines(9 * EDGE_PIECE + 1_234, 'main'), SIDE_CLOUD = lines(EDGE_PIECE + 77, 'side'), LIVE_CLOUD = lines(3_000, 'live')
const CLOUD: Record<string, Uint8Array> = { [MAIN]: MAIN_CLOUD, [SIDE]: SIDE_CLOUD, [LIVE]: LIVE_CLOUD }
const LOCAL: Record<string, Uint8Array> = {
  [MAIN]: join(MAIN_CLOUD, lines(2 * EDGE_PIECE + 500, 'main-later')),
  [SIDE]: join(SIDE_CLOUD, lines(640, 'side-later')),
  [LIVE]: LIVE_CLOUD,
  [NEW]: lines(5_500, 'new'),
}

/** A large store: rows for every directory and file, a mirror meta at seq 41 in step with revision 2190. */
function hisStore(): Map<string, unknown> {
  const rows = new Map<string, unknown>()
  const dir = (path: string): void => { rows.set(path, { kind: 'dir', mode: 0o755 }) }
  for (const path of ['/dsh/home', '/dsh/home/auma', '/dsh/home/auma/notes', '/dsh/home/auma/session', '/dsh/home/sessions',
    '/dsh/home/sessions/--dsh-home-auma--', '/dsh/home/sessions/--dsh-home-auma--/session-main', '/dsh/home/sessions/--dsh-home-auma--/session-side',
    '/dsh/home/sessions/--dsh-home-auma--/session-new', '/dsh/workspace']) dir(path)
  rows.set('/dsh/home/auma/notes/note-001.md', { kind: 'file', bytes: new TextEncoder().encode('a note\n'), mode: 0o644, mtimeMs: 1_762_000_000_000 })
  for (const [path, bytes] of Object.entries(LOCAL)) rows.set(path, { kind: 'file', bytes, mode: 0o644, mtimeMs: 1_762_000_000_100 })
  rows.set('@x6-mirror-meta', { kind: 'mirror-meta', clientId: HELD_CLIENT, seq: 41, cloudBase: { lineageId: EDGE_LINEAGE, revision: 2190 }, cloudAcknowledgedSeq: 41 })
  rows.set('@x6-content-revision', { kind: 'content-revision', seq: 5_100 })
  return rows
}

let fakeDb: FakeDb
const bytesAt = (vfs: MemoryVfs, path: string): Uint8Array => new Uint8Array(vfs.readFileSync(path) as Uint8Array)
const hex = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v))
const rowsNow = (): Map<string, string> => new Map([...fakeDb.data].map(([key, value]) => [key, hex(value)]))

beforeEach(() => {
  const idb = new FakeIndexedDb()
  fakeDb = new FakeDb()
  fakeDb.data = hisStore()
  idb.dbs.set(DB_NAME, fakeDb)
  vi.stubGlobal('indexedDB', idb)
  vi.stubGlobal('IDBKeyRange', FakeKeyRange)
  vi.stubGlobal('location', { origin: EDGE_ORIGIN, hostname: 'node.example.invalid' })
  threadReader.footer = null
})
afterEach(async () => {
  persistence.readOnly = true
  threadReader.footer = null
  Object.assign(threadSyncState, { mode: null, role: null, sent: 0, pending: 0, lastOkAtMs: null, lastError: null })
  await pause(150)
  vi.unstubAllGlobals()
})

const heldLock: ThreadWriterLocks = { request: () => new Promise(() => {}) }

/** One page load, as worker-host.ts runs it: attach, thread sync's boot, then her writer (driven step by step here). */
async function pageLoad(edge: HerEdge) {
  vi.stubGlobal('fetch', edge.fetch)
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma', { recursive: true })
  vfs.mkdirSync('/dsh/workspace', { recursive: true })
  persistence.readOnly = false
  await attachIdbPersistence(vfs, ROOTS, FAST)
  const boot = await bootThreadSync({ vfs, origin: EDGE_ORIGIN, log: () => {} })
  const { mode } = await boot.settled
  const clock = { t: Date.now() }
  const started = await startThreadWriter({ vfs, persistence, net: edgeWriterNet(edge), boot, mode, now: () => clock.t, piece: EDGE_PIECE,
    locks: heldLock, log: () => {} })
  const drain = async (): Promise<string[]> => {
    const steps: string[] = []
    if (started === null) return steps
    for (let n = 0; n < 40; n += 1) {
      clock.t += 2_001
      const step = await started.writer.step()
      steps.push(step)
      if (steps.slice(-3).every(item => item === 'idle') && steps.length >= 3) break
    }
    return steps
  }
  return { vfs, boot, mode, started, drain }
}

async function cloudOf(edge: HerEdge): Promise<void> {
  for (const path of [MAIN, SIDE, LIVE]) await joined(edge, path, CLOUD[path] ?? new Uint8Array(), HELD_CLIENT)
}

describe('dry run on a large store: off, then on, then a reload', () => {
  it('mode off: the browser boots as before; no lease, no append, no row of it changes', async () => {
    const edge = herEdge({ mode: 'off' })
    await cloudOf(edge)
    const before = rowsNow()
    const from = edge.log.length
    const load = await pageLoad(edge)
    expect([load.boot.role, load.mode, load.started, persistence.readOnly]).toEqual(['none', 'off', null, false])
    expect(edge.log.slice(from).filter(call => call.method !== 'GET')).toEqual([])
    expect(edge.log.slice(from).filter(call => call.path.startsWith('/_thread/')).map(call => call.path)).toEqual(['/_thread/index?limit=200'])
    await pause(300)
    expect(rowsNow()).toEqual(before)
    for (const [path, bytes] of Object.entries(LOCAL)) expect(sha(bytesAt(load.vfs, path))).toBe(sha(bytes))
  })

  it('mode on: every new line arrives once and in order, her cloud holds each file byte for byte, nothing of it is rewritten; a reload sends nothing again', async () => {
    const edge = herEdge({ mode: 'on' })
    await cloudOf(edge)
    const before = rowsNow()
    const from = edge.log.length
    const load = await pageLoad(edge)
    expect(load.started).not.toBeNull()
    const steps = await load.drain()
    expect(steps).not.toContain('already')
    expect(steps.filter(step => !['idle', 'appended'].includes(step))).toEqual([])

    // Once and in order: per thread, each append starts where her cloud stood after the one before it.
    const posted = edge.log.slice(from).filter(call => call.method === 'POST' && call.path.startsWith('/_thread/append'))
      .map(call => new URL(`https://x${call.path}`).searchParams)
    for (const path of Object.keys(LOCAL)) {
      const id = await threadIdFor(path)
      const ats = posted.filter(query => query.get('id') === id).map(query => Number(query.get('at')))
      const start = CLOUD[path]?.byteLength ?? 0
      if (LOCAL[path]!.byteLength === start) { expect(ats).toEqual([]); continue }
      expect(ats[0]).toBe(start)
      for (let k = 1; k < ats.length; k += 1) expect(ats[k]).toBeGreaterThan(ats[k - 1]!)
      expect(new Set(ats).size).toBe(ats.length)
      // Her cloud now holds this browser's file, byte for byte.
      expect(sha(await edge.cloudBytes(id) ?? new Uint8Array())).toBe(sha(LOCAL[path]!))
    }
    // Nothing lost, nothing rewritten in place: every local file and every stored row as before.
    for (const [path, bytes] of Object.entries(LOCAL)) expect(sha(bytesAt(load.vfs, path))).toBe(sha(bytes))
    await pause(300)
    expect(rowsNow()).toEqual(before)
    expect(threadSyncState).toMatchObject({ role: 'none', pending: 0, lastError: null })
    expect(threadSyncState.sent).toBeGreaterThan(0)
    const sent = posted.length

    // A reload: the same store, the same cloud. Nothing is sent again.
    const mark = edge.log.length
    const again = await pageLoad(edge)
    await again.drain()
    expect(edge.log.slice(mark).filter(call => call.path.startsWith('/_thread/append'))).toEqual([])
    expect(sent).toBeGreaterThanOrEqual(4)
    await again.started?.writer.stop()
    await load.started?.writer.stop()
  })
})
