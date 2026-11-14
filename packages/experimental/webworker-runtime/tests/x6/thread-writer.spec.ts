/**
 * Her one writer copies each thread's new lines to her cloud as they are written, against her REAL
 * thread log, world lease and budget in memory (thread-writer-fixture.ts). Who writes, what is sent, once and in order,
 * what is never sent, and how each refusal is met. No browser, no network, no IndexedDB write.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HydrationFacts } from '../../src/storage/idb-persist.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { NONE_ON_FOOTER, threadSyncSelfState, threadSyncState } from '../../src/storage/thread-sync.ts'
import { threadIdFor } from '../../src/storage/thread-sync-plan.ts'
import type { ThreadPersistenceView, ThreadSyncMode, ThreadSyncRole } from '../../src/storage/thread-store-types.ts'
import { localThreadPaths, startThreadWriter, THREAD_WRITER_LOCK, writerEligible, type ThreadWriterLocks } from '../../src/storage/thread-writer.ts'
import { EDGE_PIECE, edgeWriterNet, HELD_CLIENT, herEdge, joined, lines, type HerEdge } from './thread-writer-fixture.ts'

const A = '/dsh/home/sessions/--dsh-home-auma--/session-a/session.v4.jsonl'
const B = '/dsh/home/sessions/--dsh-home-auma--/session-b/session.v4.jsonl'
const C = '/dsh/home/sessions/--dsh-home-auma--/session-c/session.v4.jsonl'
const OTHER = '5e000007-0000-4000-8000-000000000007'
const T0 = new Date(2026, 10, 14, 9, 30, 0).getTime()
const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

const his = (over: Partial<HydrationFacts> = {}): HydrationFacts => ({ transport: 'cloud', storedRows: true, seq: 41, clientId: HELD_CLIENT,
  storedRevision: 2190, queuedBatches: 0, reconciliation: false, heldPaths: 0, cloud: 'confirmed', cloudRevision: 2190, ...over })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.assign(threadSyncState, { mode: null, role: null, sent: 0, pending: 0, lastOkAtMs: null, lastError: null })
})

/** A held lock that never runs the loop: the test drives `step()` itself. */
const heldLock: ThreadWriterLocks = { request: () => new Promise(() => {}) }

interface SetupOptions { hydration?: HydrationFacts; locks?: ThreadWriterLocks | null; drop?: (path: string) => boolean }
function setup(edge: HerEdge, files: ReadonlyArray<readonly [string, Uint8Array]>, options: SetupOptions = {}) {
  const vfs = new MemoryVfs()
  for (const [path, bytes] of files) {
    vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
    vfs.writeFileSync(path, bytes)
  }
  const persistence: ThreadPersistenceView = { readOnly: false, hydration: options.hydration ?? his(), conflict: null,
    localSave: { error: null } }
  const net = edgeWriterNet(edge, options.drop === undefined ? {} : { dropAnswerOf: options.drop })
  const clock = { t: T0 }
  const said: Array<{ mode: ThreadSyncMode; footer: string; role: ThreadSyncRole | undefined }> = []
  const boot = { publish: (mode: ThreadSyncMode, footer: string, role?: ThreadSyncRole) => { said.push({ mode, footer, role }) } }
  const start = async () => await startThreadWriter({ vfs, persistence, net, boot, mode: 'on', now: () => clock.t, piece: EDGE_PIECE, tabId: 'writer-tab',
    locks: options.locks === undefined ? heldLock : options.locks, log: () => {} })
  return { vfs, persistence, net, clock, said, start }
}
const appends = (edge: HerEdge) => edge.log.filter(call => call.method === 'POST' && call.path.startsWith('/_thread/append'))
const leaseCalls = (edge: HerEdge) => edge.log.filter(call => call.method === 'POST' && call.path === '/_mirror/lease')
const indexRow = async (edge: HerEdge, path: string) => {
  const body = await (await edge.fetch('/_thread/index?limit=200')).json() as { threads: Array<{ path: string; bytes: number; lineEnd: number }> }
  return body.threads.find(row => row.path === path) ?? null
}

describe('who is her writer (A3)', () => {
  it.each([
    ['this browser never saved', his({ seq: 0 }), /has not saved her before|no acknowledged save/],
    ['her cloud moved on since this browser\'s last save (diverged)', his({ cloud: 'diverged' }), /did not confirm/],
    ['her cloud did not answer at this boot', his({ cloud: 'unreachable', cloudRevision: null }), /did not confirm/],
    ['no mirror client id', his({ clientId: null }), /client id/],
  ])('%s: not her writer, no lease, no append, and the page is told so', async (_name, hydration, why) => {
    const edge = herEdge({ mode: 'on' })
    await joined(edge, A, lines(3000, 'a'))
    const s = setup(edge, [[A, join(lines(3000, 'a'), lines(400, 'more'))]], { hydration })
    expect(writerEligible(hydration).ok).toBe(false)
    expect(await s.start()).toBeNull()
    expect(threadSyncState.lastError).toMatch(why)
    expect([appends(edge), leaseCalls(edge)]).toEqual([[], []])
    expect(s.said).toEqual([{ mode: 'on', footer: NONE_ON_FOOTER, role: 'none' }])
  })

  it('her newest conversation in her cloud was last written by another browser: not her writer', async () => {
    const edge = herEdge({ mode: 'on' })
    await joined(edge, A, lines(3000, 'a'), OTHER)
    const s = setup(edge, [[A, lines(3000, 'a')]])
    expect(await s.start()).toBeNull()
    expect(threadSyncState.lastError).toMatch(/another browser/)
    expect([appends(edge), leaseCalls(edge)]).toEqual([[], []])
  })

  it('no Web Locks in this engine: no writer; the lock taken by another tab: no loop, role none, no call', async () => {
    const edge = herEdge({ mode: 'on' })
    await joined(edge, A, lines(3000, 'a'))
    expect(await setup(edge, [[A, lines(3000, 'a')]], { locks: null }).start()).toBeNull()
    const asked: string[] = []
    const busy: ThreadWriterLocks = { request: async (name, _options, callback) => { asked.push(name); await callback(null) } }
    const started = await setup(edge, [[A, join(lines(3000, 'a'), lines(200, 'b'))]], { locks: busy }).start()
    await started?.running
    expect(asked).toEqual([THREAD_WRITER_LOCK])
    expect(threadSyncState.role).toBe('none')
    expect([appends(edge), leaseCalls(edge)]).toEqual([[], []])
  })

  it('the mode read at boot is not `on`: nothing starts', async () => {
    const edge = herEdge({ mode: 'pull' })
    const s = setup(edge, [[A, lines(3000, 'a')]])
    expect(await startThreadWriter({ vfs: s.vfs, persistence: s.persistence, net: s.net, boot: { publish: () => {} }, mode: 'pull', locks: heldLock })).toBeNull()
    expect(edge.log).toEqual([])
  })
})

describe('what her writer sends (A1, A2, A4)', () => {
  it('a joined thread grows by three lines: once settled, exactly those bytes go, once, at the cloud\'s length; her cloud then holds the local file byte for byte', async () => {
    const edge = herEdge({ mode: 'on' })
    const base = lines(3 * EDGE_PIECE + 500, 'a')
    await joined(edge, A, base)
    const more = lines(240, 'turn')
    const local = join(base, more)
    const s = setup(edge, [[A, local]])
    const started = await s.start()
    expect(started).not.toBeNull()
    const writer = started!.writer
    expect(await writer.step()).toBe('idle') // first sight: not settled for ROLLBACK_SETTLE_MS yet; the lease is taken
    expect(leaseCalls(edge)).toHaveLength(1)
    s.clock.t += 2_001
    expect(await writer.step()).toBe('appended')
    expect(appends(edge).map(call => call.path)).toEqual([`/_thread/append?p=1&id=${await threadIdFor(A)}&at=${String(base.byteLength)}`])
    expect(await indexRow(edge, A)).toMatchObject({ bytes: local.byteLength, lineEnd: local.byteLength })
    expect(Buffer.from(await edge.cloudBytes(await threadIdFor(A)) ?? new Uint8Array()).equals(Buffer.from(local))).toBe(true)
    expect(threadSyncSelfState()).toMatchObject({ sent: 3, pending: 0, lastError: null, lastOkAtMs: s.clock.t })
    expect(s.said.at(-1)).toEqual({ mode: 'on', footer: 'In her cloud 09:30.', role: 'writer' })
    // Nothing more to send: no further append.
    s.clock.t += 2_001
    expect(await writer.step()).toBe('idle')
    expect(appends(edge)).toHaveLength(1)
  })

  it('a thread her cloud lacks is created at 8 MiB or less (here scaled); a larger one gets no call and is counted', async () => {
    const edge = herEdge({ mode: 'on' })
    const small = lines(5_000, 'b'), large = lines(20_000, 'c')
    const s = setup(edge, [[B, small], [C, large]])
    const started = await startThreadWriter({ vfs: s.vfs, persistence: s.persistence, net: s.net, boot: { publish: () => {} }, mode: 'on', now: () => s.clock.t,
      piece: EDGE_PIECE, locks: heldLock, limits: { createMaxBytes: 10_000 }, log: () => {} })
    const writer = started!.writer
    await writer.step()
    const steps: string[] = []
    for (let n = 0; n < 6; n += 1) { s.clock.t += 2_001; steps.push(await writer.step()) }
    // 5,000 bytes at one piece (4,096 here) a body: two appends, whole lines each, then nothing.
    expect(steps).toEqual(['appended', 'appended', 'idle', 'idle', 'idle', 'idle'])
    const idB = await threadIdFor(B)
    expect(appends(edge).map(call => call.path.split('&at=')[0])).toEqual([`/_thread/append?p=1&id=${idB}`, `/_thread/append?p=1&id=${idB}`])
    expect(Buffer.from(await edge.cloudBytes(idB) ?? new Uint8Array()).equals(Buffer.from(small))).toBe(true)
    expect(await indexRow(edge, B)).toMatchObject({ bytes: small.byteLength })
    expect(await indexRow(edge, C)).toBeNull()
    expect(threadSyncState.pending).toBe(1)
    expect(threadSyncState.lastError).toMatch(/not in her cloud yet; Join on \/rescue sends it/)
  })

  it('a lost answer is retried at the same `at` and answered ALREADY: her cloud holds the lines once', async () => {
    const edge = herEdge({ mode: 'on' })
    const base = lines(2_000, 'a')
    await joined(edge, A, base)
    const local = join(base, lines(300, 'turn'))
    let dropped = 0
    const s = setup(edge, [[A, local]], { drop: path => path.startsWith('/_thread/append') && dropped++ === 0 })
    const writer = (await s.start())!.writer
    await writer.step()
    s.clock.t += 2_001
    expect(await writer.step()).toBe('backoff')
    s.clock.t += 2_001
    expect(await writer.step()).toBe('already')
    const ats = appends(edge).map(call => new URL(`https://x${call.path}`).searchParams.get('at'))
    expect(ats).toEqual([String(base.byteLength), String(base.byteLength)])
    expect(Buffer.from(await edge.cloudBytes(await threadIdFor(A)) ?? new Uint8Array()).equals(Buffer.from(local))).toBe(true)
    expect(threadSyncState.sent).toBe(0) // ALREADY: her cloud had them; nothing new was counted twice
  })

  it('a file shorter than her cloud\'s copy, or one that does not extend it, gets no call (never a retract, never a pull), and is counted', async () => {
    const edge = herEdge({ mode: 'on' })
    const base = lines(3_000, 'a')
    await joined(edge, A, base)
    const forked = join(lines(2_000, 'z'), lines(1_500, 'turn'))
    const s = setup(edge, [[A, base.slice(0, 2_000)]])
    const fromJoin = edge.log.length
    const writer = (await s.start())!.writer
    await writer.step()
    s.clock.t += 2_001
    expect(await writer.step()).toBe('idle')
    expect(s.said.at(-1)?.footer).toBe('1 conversation stopped copying and needs your card.')
    s.vfs.writeFileSync(A, forked)
    s.clock.t += 2_001
    await writer.step()
    s.clock.t += 2_001
    expect(await writer.step()).toBe('idle')
    expect(appends(edge)).toEqual([])
    expect(edge.log.slice(fromJoin).filter(call => /retract|keep|import/.test(call.path))).toEqual([])
  })

  it('her writer never writes: a VFS spy sees zero writes, seeds or removals across a whole run', async () => {
    const edge = herEdge({ mode: 'on' })
    await joined(edge, A, lines(2_000, 'a'))
    const s = setup(edge, [[A, join(lines(2_000, 'a'), lines(400, 'b'))], [B, lines(900, 'b')]])
    const spies = (['writeFileSync', 'appendFileSync', 'seed', 'rmSync', 'mkdirSync', 'renameSync', 'truncateSync', 'unlinkSync'] as const)
      .filter(name => typeof (s.vfs as unknown as Record<string, unknown>)[name] === 'function')
      .map(name => vi.spyOn(s.vfs as unknown as Record<string, (...args: unknown[]) => unknown>, name))
    const writer = (await s.start())!.writer
    for (let n = 0; n < 6; n += 1) { await writer.step(); s.clock.t += 2_001 }
    expect(appends(edge).length).toBe(2)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

describe('how her writer meets each answer (A3b, A4)', () => {
  it('the mode turns off: at the next renew it reads the mode, releases her turn and sends nothing; back on, it resumes', async () => {
    const edge = herEdge({ mode: 'on' })
    const base = lines(2_000, 'a')
    await joined(edge, A, base)
    const s = setup(edge, [[A, join(base, lines(200, 'one'))]])
    const writer = (await s.start())!.writer
    await writer.step(); s.clock.t += 2_001
    expect(await writer.step()).toBe('appended')
    edge.state.mode = 'off'
    s.vfs.appendFileSync(A, lines(200, 'two'))
    s.clock.t += 30_001
    expect(await writer.step()).toBe('paused')
    const released = edge.log.filter(call => call.path === '/_mirror/lease').length
    expect(s.said.at(-1)).toMatchObject({ footer: 'Copying to her cloud is paused. New lines stay in this browser.', role: 'none' })
    s.clock.t += 30_001
    expect(await writer.step()).toBe('paused')
    expect(appends(edge)).toHaveLength(1)
    edge.state.mode = 'on'
    s.clock.t += 30_001
    // Her turn is taken again; the new lines are first seen now, so they go once settled.
    expect(await writer.step()).toBe('idle')
    s.clock.t += 2_001
    expect(await writer.step()).toBe('appended')
    expect(appends(edge)).toHaveLength(2)
    expect(released).toBeGreaterThanOrEqual(2)
  })

  it('this browser\'s own store is held (a conflict, a failed local save): no call at all', async () => {
    const edge = herEdge({ mode: 'on' })
    await joined(edge, A, lines(2_000, 'a'))
    const s = setup(edge, [[A, join(lines(2_000, 'a'), lines(200, 'b'))]])
    const writer = (await s.start())!.writer
    const before = edge.log.length
    ;(s.persistence as { conflict: string | null }).conflict = 'MIRROR_GLOBAL_FENCE_CONFLICT: test'
    expect(await writer.step()).toBe('store-held')
    expect(edge.log.length).toBe(before)
  })

  it('another browser holds her turn (423): no append, and the page is told who', async () => {
    const edge = herEdge({ mode: 'on' })
    await joined(edge, A, lines(2_000, 'a'))
    const other = await edge.fetch('/_mirror/lease', { method: 'POST', body: JSON.stringify({ action: 'acquire', clientId: OTHER, tabId: 'other', label: 'Safari on the iPad' }) })
    expect(other.status).toBe(200)
    const s = setup(edge, [[A, join(lines(2_000, 'a'), lines(200, 'b'))]])
    const writer = (await s.start())!.writer
    expect(await writer.step()).toBe('lease-refused')
    expect(s.said.at(-1)?.footer).toBe('She is answering in Safari on the iPad. This browser\'s new lines stay here.')
    expect(appends(edge)).toEqual([])
  })

  it('a 409 is never resent blind: her index is read again once; a second 409 on the same thread holds it for this load', async () => {
    const edge = herEdge({ mode: 'on' })
    await joined(edge, A, lines(2_000, 'a'))
    const s = setup(edge, [[A, join(lines(2_000, 'a'), lines(200, 'b'))]])
    const real = s.net.post.bind(s.net)
    s.net.post = async (path, body, headers, deadline) => (path.startsWith('/_thread/append')
      ? { status: 409, headers: new Headers(), bytes: new TextEncoder().encode('{"ok":false,"code":"DIVERGED"}') }
      : await real(path, body, headers, deadline))
    const writer = (await s.start())!.writer
    await writer.step(); s.clock.t += 2_001
    expect(await writer.step()).toBe('replan')
    const indexReads = () => edge.log.filter(call => call.path.startsWith('/_thread/index?limit=200')).length
    const before = indexReads()
    s.clock.t += 2_001
    expect(await writer.step()).toBe('thread-held')
    expect(indexReads()).toBe(before + 1)
    s.clock.t += 2_001
    expect(await writer.step()).toBe('idle')
  })

  it('the local journal paths it reads are exactly the thread routes\' own', () => {
    const vfs = new MemoryVfs()
    for (const path of [A, '/dsh/home/auma/session/messages.jsonl', '/dsh/home/sessions/p/id/notes.md', '/dsh/home/auma/notes.md']) {
      vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
      vfs.writeFileSync(path, '{}\n')
    }
    expect(localThreadPaths(vfs)).toEqual([A, '/dsh/home/auma/session/messages.jsonl'].sort())
  })
})
