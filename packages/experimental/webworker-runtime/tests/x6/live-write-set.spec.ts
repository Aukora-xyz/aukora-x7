/**
 * Lane E6 task 2: the WO-3 write-set inventory runs live. Every write the mounted runtime (ball-loader) and the page-eyes
 * bridge make through their VFS is recorded and classified against RUNTIME_WRITE_SET; a path outside the inventory is
 * flagged; the ring is bounded; status() carries the snapshot. Local fixtures only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { eyesWithPageFallback } from '../../src/x6/page-eyes-bridge.ts'
import { createLiveWriteSetRecorder, liveWriteSet, type LiveWriteSetSnapshot } from '../../src/x6/write-set-inventory.ts'
import { createHeardFeed, createTimelineCapture, createTimelineStore, HEARD_CURSOR, TIMELINE_CHAIN, TIMELINE_WORDS } from '../../src/storage/memory-timeline.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })
const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3))

describe('live write-set recorder (unit)', () => {
  it('classifies inventoried writes, flags an off-inventory one, passes reads through and stays bounded', () => {
    const recorder = createLiveWriteSetRecorder(4)
    const raw = new MemoryVfs()
    const vfs = recorder.wrap(raw, 'unit')
    expect(recorder.wrap(vfs, 'unit')).toBe(vfs)
    vfs.mkdirSync('/dsh/home/balls', { recursive: true })
    vfs.writeFileSync('/dsh/home/balls/HEAD.json', '{}')
    vfs.mkdirSync('/dsh/home/auma/wake', { recursive: true })
    vfs.appendFileSync('/dsh/home/auma/wake/steps.jsonl', '{}\n')
    vfs.writeFileSync('/dsh/home/auma/rogue.txt', 'x')
    expect(vfs.readFileSync('/dsh/home/auma/rogue.txt', 'utf8')).toBe('x')
    expect(raw.existsSync('/dsh/home/auma/rogue.txt')).toBe(true)
    let snap = recorder.snapshot()
    expect(snap.recent.map(item => [item.op, item.entryId, item.class, item.flagged])).toEqual([
      ['write', 'head-manifest', 'authority', false], ['append', 'wake-steps', 'authority', false], ['write', null, 'uninventoried', true],
    ])
    expect(snap.flagged.map(item => item.path)).toEqual(['/dsh/home/auma/rogue.txt'])
    expect(snap.counters).toMatchObject({ writes: 3, flagged: 1, byClass: { authority: 2, uninventoried: 1 } })
    vfs.renameSync('/dsh/home/auma/rogue.txt', '/dsh/home/auma/HANDOFF.md')
    vfs.unlinkSync('/dsh/home/auma/HANDOFF.md')
    for (let i = 0; i < 6; i += 1) vfs.writeFileSync(`/dsh/home/auma/r${String(i)}.txt`, 'y')
    snap = recorder.snapshot()
    expect(snap.recent).toHaveLength(4)
    expect(snap.flagged).toHaveLength(4)
    expect(snap.counters).toMatchObject({ writes: 11, flagged: 7 })
    expect(Object.isFrozen(snap) && Object.isFrozen(snap.recent) && Object.isFrozen(snap.recent[0])).toBe(true)
    // A failed write is not recorded as an effect.
    const before = recorder.snapshot().counters.writes
    expect(() => vfs.writeFileSync('/no/such/dir/file', 'z')).toThrow()
    expect(recorder.snapshot().counters.writes).toBe(before)
  })
})

describe('review (landing): her timeline\'s real writes are inventoried continuity writes', () => {
  it('a captured turn, written by her real timeline store through the recorder, is never flagged (both files)', async () => {
    const recorder = createLiveWriteSetRecorder(16)
    const vfs = recorder.wrap(new MemoryVfs(), 'unit')
    const store = createTimelineStore(vfs)
    const capture = createTimelineCapture({ store, nowMs: () => 1_763_294_400_000, screen: text => text, isSpoken: () => false, titleOf: () => 'Garden' })
    const session = { id: 'thread-a', header: { version: 4, id: 'thread-a', createdAt: 1, isSeeded: false, cwd: '/dsh/home/auma' } }
    capture.observe(session, { type: 'turn/start', data: { turn: 1 } })
    capture.observe(session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'plan the beds' }] } })
    capture.observe(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await capture.idle()
    expect(capture.failures().count).toBe(0)
    const writes = recorder.snapshot().recent
    expect(writes.map(item => item.path).sort()).toEqual([TIMELINE_CHAIN, TIMELINE_WORDS])
    for (const item of writes) expect([item.path, item.entryId, item.class, item.flagged]).toEqual([item.path, 'memory-timeline', 'continuity', false])
    expect(recorder.snapshot().flagged).toEqual([])
  })

  it('the heard cursor, written by her real feed through the store when a block is logged, is never flagged', async () => {
    const recorder = createLiveWriteSetRecorder(16)
    const vfs = recorder.wrap(new MemoryVfs(), 'unit')
    const store = createTimelineStore(vfs)
    expect(await store.append({ v: 1, at: 1_763_294_400_000, kind: 'turn', conv: 'thread-b', title: 'Garden', turn: '1', ended: 'completed', steps: 1, tools: [] },
      { his: 'plan the beds', hers: 'Done.' })).toMatchObject({ ok: true })
    const feed = createHeardFeed({ vfs, store, nowMs: () => 1_763_294_460_000, screen: text => text, newId: () => 'm-heard', isVoice: () => false })
    const hello = { id: 'm-hello', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
    const decision = await feed.preStep({ agent: { id: 'thread-a', session: { id: 'thread-a', header: {} } }, messages: [hello], turn: 1, step: 1 },
      () => Promise.resolve({ kind: 'enter', messages: [hello] as unknown[] }))
    for (const message of decision.messages) feed.logged('thread-a', { type: 'user/message', data: message })
    await feed.idle()
    expect(feed.cursorFailures().count).toBe(0)
    const cursor = recorder.snapshot().recent.filter(item => item.path === HEARD_CURSOR)
    expect(cursor.map(item => [item.op, item.entryId, item.class, item.flagged])).toEqual([['write', 'memory-heard-cursor', 'continuity', false]])
    expect(recorder.snapshot().flagged).toEqual([])
  })
})

describe('live write-set recorder on the runtime write paths', () => {
  it('records the mounted runtime\'s own writes (HEAD adoption and a HANDOFF append) and exposes them in status()', async () => {
    const start = liveWriteSet.snapshot().counters.writes
    const { tool, status, vfs } = await mountE4()
    for (const dir of ['/dsh/home/auma-one', '/dsh/workspace']) vfs.mkdirSync(dir, { recursive: true })
    await tool('auma_handoff').execute({ action: 'append', content: 'lane e6 live write-set' })
    const snap = (await status()).writeSet as LiveWriteSetSnapshot
    expect(snap.schema).toBe('aukora.runtime-write-set.live.v1')
    expect(snap.counters.writes).toBeGreaterThan(start)
    const mine = snap.recent.filter(item => item.source === 'ball-loader')
    expect(mine.some(item => item.path === '/dsh/home/auma/HANDOFF.md' && item.entryId === 'self-authored-state' && !item.flagged)).toBe(true)
    expect(mine.some(item => item.entryId === 'head-manifest' && item.class === 'authority')).toBe(true)
  })

  it('records page-eyes captures as observation writes under /dsh/home/auma', async () => {
    const vfs = new MemoryVfs()
    const listeners: Array<(event: MessageEvent) => void> = []
    const channel = {
      addEventListener: (_type: string, listener: EventListener) => {
        listeners.push(listener as unknown as (event: MessageEvent) => void)
      },
      removeEventListener: () => {},
      close: () => {},
      postMessage: (message: { id: string }) => {
        queueMicrotask(() => { for (const listener of listeners) listener({ data: { t: 'eyes-answer', id: message.id, projection: { nodes: [] }, pngBase64: PNG, watermark: { at: '9', sha256: 'd'.repeat(64) } } } as MessageEvent) })
      },
    }
    const seq = liveWriteSet.snapshot().counters.writes
    await eyesWithPageFallback(async () => new Response(null, { status: 501 }), '{}', { vfs: () => vfs, channel, id: 'req-e6', timeoutMs: 1000 })
    const eyes = liveWriteSet.snapshot().recent.filter(item => item.seq > seq && item.source === 'page-eyes-bridge')
    expect(eyes.length).toBeGreaterThanOrEqual(3)
    expect(eyes.every(item => item.entryId === 'page-eyes-captures' && item.class === 'observation' && !item.flagged)).toBe(true)
    expect(eyes.some(item => item.path === '/dsh/home/auma/captures/ring/9-dddddddddddd.png')).toBe(true)
  })
})
