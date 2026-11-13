// @vitest-environment jsdom
/**
 * The Work view's memory & surprise recall and autonomous wake rows.
 * The DAG fixture is a SYNTHETIC two-node set built by the export (no real memory); each id is recomputed by the organ's rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  bootRelease, corpusStatus, countCorpus, createLiveHub, DISCOVERY_CORPUS_PATH, MEMORY_DAG_DIR, parseLiveMessage, parseWake, postWake,
  readWake, touchesHer, verifyDag, wakeInterval,
  type DagCache, type DagFileRead, type LiveChannel, type LiveDeps, type LiveSocket, type WakeFetch,
} from '../src/client/spatial/work/autonomy.ts'
import { WORK_SURFACE, WorkSurface, type FileRead } from '../src/client/spatial/work/WorkSurface.tsx'
import { en } from '../src/client/spatial/work/labels.ts'
import { BALL_HEAD_PATH, MEMORY_DAG_HEAD_PATH, SUPERAGENT_STATE_PATH } from '../src/client/spatial/work/work-model.ts'

/** Stand-ins for the page's BroadcastChannel and WebSocket: every one opened is kept, so a test can push a message. */
class FakeChannel implements LiveChannel {
  static open: FakeChannel[] = []
  onmessage: LiveChannel['onmessage'] = null
  closed = false
  constructor(readonly name: string) { FakeChannel.open.push(this) }
  close() { this.closed = true }
}
class FakeSocket implements LiveSocket {
  static open: FakeSocket[] = []
  onopen: LiveSocket['onopen'] = null
  onmessage: LiveSocket['onmessage'] = null
  onclose: LiveSocket['onclose'] = null
  closed = false
  constructor(readonly url: string) { FakeSocket.open.push(this) }
  close() { this.closed = true }
}
const push = (message: unknown) => {
  for (const socket of FakeSocket.open.filter(s => !s.closed)) socket.onmessage?.({ data: JSON.stringify(message) })
}
// The page listener is one per page and outlives a test by its idle second, so sockets are never forgotten here.
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.head.innerHTML = '' })

/** A SYNTHETIC root note (the organ's `parentIds` shape), built by the export. It is no one's memory. */
const ROOT_ID = 'ee682b1f111d9d3b92f18ee57bf81e9904e70a0398a04a88c077395a40bd7668'
const ROOT = {
  parentIds: [],
  kind: 'note',
  key: 'synthetic-dag-root',
  content: 'Synthetic test node: the root of a one-node memory DAG under /dsh/home/auma/memory/dag, HEAD.json tip, sha256 self-verifying.',
  tags: ['synthetic', 'memory', 'dag'],
  createdAt: 1794441600000,
  receiptHash: '8d21ccea697478a026da9c3e2972a5cb0b2832cf4d41e7539e4ddf89d0dde153',
  ticketId: 'tkt_0000000000000001',
  tombstoneOf: null,
  memoryId: null,
  id: ROOT_ID,
}
/** A SYNTHETIC `auma.memory.dag.node.v1` node (parent links under `parents`); its parent is deliberately absent. */
const V1_ID = '6a6bfbc852c589629b1ff2143fda92d1559dd1a7bb50591fe1baa1fbc34744a1'
const V1 = {
  id: V1_ID,
  schema: 'auma.memory.dag.node.v1',
  kind: 'episodic',
  createdAt: '2026-11-12T00:01:00.000Z',
  parents: ['78542aa5ca5f41ecd58cc4da4322da6331a924e32227ba694d5aef0614afd531'],
  summary: 'Synthetic episodic node whose parent is not on disk.',
  tags: ['synthetic', 'episodic'],
  data: {
    epoch: 2,
    ballId: '9e2a00a841dc9da73aec6ef2e48019c701b053e066fb6ff8459c9702364fc085',
    merkleRoot: 'a486265addc17f2cfa3c26adb8ba93d2ec16be39854a6735a495395390f293f3',
    checkpointSeq: 1,
  },
}
const files = (map: Record<string, unknown>) => async (id: string): Promise<DagFileRead> =>
  map[id] === undefined ? { kind: 'missing' } : { kind: 'ok', text: typeof map[id] === 'string' ? map[id] : JSON.stringify(map[id]) }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('her memory DAG: every node id is recomputed from its bytes', () => {
  it('her real root node verifies', async () => {
    expect(await verifyDag([ROOT_ID], files({ [ROOT_ID]: ROOT }), new Map())).toEqual({ kind: 'verified', nodes: 1, tip: ROOT_ID })
  })
  it('her real v1 node verifies through `parents`, and its missing parent is reported, not skipped', async () => {
    expect(await verifyDag([V1_ID], files({ [V1_ID]: V1 }), new Map()))
      .toEqual({ kind: 'broken', nodes: 1, at: V1.parents[0], reason: 'missing' })
  })
  it('a one-character change to her node is a hash mismatch', async () => {
    const tampered = { ...ROOT, content: `${ROOT.content} ` }
    expect(await verifyDag([ROOT_ID], files({ [ROOT_ID]: tampered }), new Map()))
      .toEqual({ kind: 'broken', nodes: 0, at: ROOT_ID, reason: 'hash-mismatch' })
  })
  it('a node whose own id disagrees with its file name, a missing parent, and a non-hex head are broken', async () => {
    expect((await verifyDag([ROOT_ID], files({ [ROOT_ID]: { ...ROOT, id: 'f'.repeat(64) } }), new Map())).kind).toBe('broken')
    const childBody = { ...ROOT, parentIds: ['a'.repeat(64)], key: 'child' }
    delete (childBody as { id?: string }).id
    const { dagNodeId } = await import('../src/client/spatial/work/autonomy.ts')
    const childId = await dagNodeId(childBody)
    expect(await verifyDag([childId], files({ [childId]: childBody }), new Map()))
      .toEqual({ kind: 'broken', nodes: 1, at: 'a'.repeat(64), reason: 'missing' })
    expect((await verifyDag(['HEAD'], files({}), new Map())).kind).toBe('broken')
  })
  it('every reachable node verifies but HEAD counts more: forked, said as N of M, never verified', async () => {
    expect(await verifyDag([ROOT_ID], files({ [ROOT_ID]: ROOT }), new Map(), undefined, 3))
      .toEqual({ kind: 'forked', nodes: 1, expected: 3, tip: ROOT_ID })
    expect(await verifyDag([ROOT_ID], files({ [ROOT_ID]: ROOT }), new Map(), undefined, 1))
      .toEqual({ kind: 'verified', nodes: 1, tip: ROOT_ID })
    expect((await verifyDag([ROOT_ID], files({ [ROOT_ID]: ROOT }), new Map(), undefined, null)).kind).toBe('verified')
  })
  it('a node it could not read is unread, not broken', async () => {
    expect(await verifyDag([ROOT_ID], async () => ({ kind: 'unreadable', detail: 'timeout' }), new Map()))
      .toEqual({ kind: 'unread', nodes: 0, at: ROOT_ID, detail: 'timeout' })
  })
  it('a verified id is read once; the walk is bounded', async () => {
    const cache: DagCache = new Map()
    const read = vi.fn(files({ [ROOT_ID]: ROOT }))
    await verifyDag([ROOT_ID], read, cache)
    await verifyDag([ROOT_ID], read, cache)
    expect(read).toHaveBeenCalledTimes(1)
    expect(await verifyDag([ROOT_ID], read, cache, 0)).toEqual({ kind: 'bounded', nodes: 0, tip: ROOT_ID })
  })
})

describe('her surprise corpus is counted, not trusted', () => {
  it('counts trajectories and the ones with a positive surprise score', () => {
    const text = [
      JSON.stringify({ trajectoryId: 'a', surpriseScore: 0 }),
      JSON.stringify({ trajectoryId: 'b', surpriseScore: 30 }),
      JSON.stringify({ trajectoryId: 'c', surpriseScore: '30' }),
      'not json',
      '',
    ].join('\n')
    expect(countCorpus(text)).toEqual({
      trajectories: 3, highSurprise: 1, unreadableLines: 1, unauthenticated: 0, anchoredClaims: 0, unmarked: 3,
    })
  })
  it('says what the rows say about their own authentication', () => {
    const hash = 'a'.repeat(64)
    const pre = JSON.stringify({ verificationStatus: 'UNAUTHENTICATED_PRE_EPOCH_54', surpriseScore: 30, registerReceiptHash: hash, observeReceiptHash: hash })
    const anchored = JSON.stringify({ surpriseScore: 0, registerReceiptHash: hash, observeReceiptHash: hash })
    const half = JSON.stringify({ surpriseScore: 0, registerReceiptHash: hash, observeReceiptHash: 'deadbeef' })
    expect(corpusStatus(countCorpus([pre, pre].join('\n')))).toBe('unauthenticated')
    expect(corpusStatus(countCorpus([anchored, anchored].join('\n')))).toBe('anchored-claim')
    expect(corpusStatus(countCorpus([pre, anchored].join('\n')))).toBe('mixed')
    expect(countCorpus([pre, half, half].join('\n'))).toMatchObject({ unauthenticated: 1, anchoredClaims: 0, unmarked: 2 })
    expect(corpusStatus(countCorpus([pre, half].join('\n')))).toBe('mixed')
    expect(corpusStatus(countCorpus(half))).toBe('unmarked')
    expect(corpusStatus(countCorpus(''))).toBe('empty')
  })
})

describe('the wake timer', () => {
  const STATUS = { ok: true, enabled: false, intervalMs: 900_000, lastWakeAt: null, lastWakeOutcome: null, wakeCount: 0, nextWakeAt: null }
  it('parses the host answer, and a missing enabled word is not "off"', () => {
    expect(parseWake(STATUS)?.enabled).toBe(false)
    expect(parseWake(STATUS)?.neverWoke).toBe(true)
    expect(parseWake({ ...STATUS, lastWakeAt: undefined, wakeCount: 3 })?.neverWoke).toBe(false)
    expect(parseWake({ ...STATUS, enabled: undefined })).toBeNull()
    expect(parseWake({ ok: true, wake: { ...STATUS, enabled: true, lastWakeOutcome: { status: 'recorded', detail: 'no upstream key' } } })?.lastWakeOutcome)
      .toBe('recorded: no upstream key')
  })
  it('an unserved route is absent; a JSON refusal is refused', async () => {
    expect((await readWake(async () => new Response('x', { status: 404 }))).kind).toBe('absent')
    expect((await readWake(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }))).kind).toBe('absent')
    expect(await readWake(async () => json({ ok: false, error: 'CAPABILITY_REQUIRED' }, 401)))
      .toEqual({ kind: 'refused', status: 401, detail: 'CAPABILITY_REQUIRED' })
    expect((await readWake(async () => { throw new TypeError('Failed to fetch') })).kind).toBe('refused')
    expect((await readWake(async () => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }))).kind)
      .toBe('refused')
  })
  it('never sends an interval outside 60 s to 24 h', async () => {
    const fetchImpl = vi.fn<WakeFetch>(async () => json(STATUS))
    for (const intervalMs of [59_999, 86_400_001, Number.NaN, Number.POSITIVE_INFINITY, 60_000.5]) {
      expect((await postWake({ action: 'configure', enabled: true, intervalMs }, fetchImpl)).kind).toBe('refused')
    }
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await postWake({ action: 'configure', enabled: true, intervalMs: 86_400_000 }, fetchImpl)).kind).toBe('ok')
    expect(wakeInterval({ ...parseWake(STATUS)!, intervalMs: 60_000 })).toBe(3_600_000)
    expect(wakeInterval({ ...parseWake(STATUS)!, intervalMs: 10 })).toBe(3_600_000)
    expect(wakeInterval(parseWake(STATUS))).toBe(900_000)
  })
})

describe('the Work surface shows recall and wake, and the wake buttons ask the host', () => {
  const corpus = [JSON.stringify({ surpriseScore: 0 }), JSON.stringify({ surpriseScore: 0 }), JSON.stringify({ surpriseScore: 30 })].join('\n')
  const disk: Record<string, string> = {
    [MEMORY_DAG_HEAD_PATH]: JSON.stringify({ heads: [ROOT_ID], count: 1, updatedAt: 1794441600000 }),
    [`${MEMORY_DAG_DIR}/${ROOT_ID}.json`]: JSON.stringify(ROOT, null, 2),
    [DISCOVERY_CORPUS_PATH]: corpus,
  }
  const reader = {
    whole: async (_s: unknown, path: string): Promise<FileRead> =>
      disk[path] === undefined ? { ok: false, reason: 'not-found' } : { ok: true, text: disk[path] },
  }
  const sessions = { ids: ['s1'], byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }
  const props = {
    activeSurface: WORK_SURFACE,
    useSessions: (select: (s: typeof sessions) => unknown) => select(sessions),
    reader,
    labels: (key: string) => (en as Record<string, string>)[key] ?? key,
    t: (key: string) => key,
  } as unknown as PropsRuntime<'shell.surface'> & PropsLocale<'layout'> & Parameters<typeof WorkSurface>[0]

  it('verified DAG, her lesson count labelled as her file, and the timer enable POST', async () => {
    let enabled = false
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'POST') enabled = (JSON.parse(String(init.body)) as { enabled?: boolean }).enabled ?? enabled
      return json({ ok: true, enabled, intervalMs: 900_000, lastWakeAt: null, lastWakeOutcome: null, wakeCount: 0, nextWakeAt: null })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<WorkSurface {...props} />)
    await waitFor(() => { expect(container.querySelector('[data-work-recall="verified"]')).toBeTruthy() })
    const recall = container.querySelector('[data-work-recall]')?.textContent ?? ''
    expect(recall).toContain(`1 ${en['recall.nodes']}`)
    expect(recall).toContain(`1 ${en['recall.lessons']} (3 ${en['recall.trajectories']}) — ${en['recall.status.unmarked']}; ${en['recall.fromFile']}`)
    await waitFor(() => { expect(container.querySelector('[data-work-wake="off"]')).toBeTruthy() })
    fireEvent.click(screen.getByText(`${en['wake.enable']} (15 ${en['wake.minutes']})`))
    await waitFor(() => { expect(container.querySelector('[data-work-wake="on"]')).toBeTruthy() })
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post?.[0]).toBe('/_host/wake')
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ action: 'configure', enabled: true, intervalMs: 900_000 })
    expect(screen.getByText(en['wake.disable'])).toBeTruthy()
  })
  it('a recall projector slice on the readout is not shown (nothing fills it on main); this tab\'s own walk is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const snapshot = { observedAt: '', survivedRestart: null, mandates: [], tickets: [], assignments: [], attention: [] }
    const install = (recall: unknown) => {
      const read = { current: () => ({ kind: 'snapshot', snapshot: { ...snapshot, recall }, receipts: { kind: 'absent' }, empty: true, refreshing: false }),
        refresh: () => {}, stop: () => {}, subscribe: (l: (p: unknown) => void) => { l(read.current()); return () => {} } }
      vi.stubGlobal('__AUKORA_SUPERAGENT__', { version: 1, createRead: () => read, callTool: async () => ({ kind: 'ok', value: null }) })
    }
    install({ verifiedNodeCount: 7, highSurpriseLessons: [{}], highSurpriseCount: 12, relevantMemories: [] })
    const { container, unmount } = render(<WorkSurface {...props} />)
    await waitFor(() => { expect(container.querySelector('[data-work-recall="verified"]')).toBeTruthy() })
    const row = container.querySelector('[data-work-recall]')?.textContent ?? ''
    expect(row).toContain(`1 ${en['recall.nodes']}`)
    expect(row).not.toMatch(/projector|12 high-surprise/)
    expect(container.querySelector('[data-work-recall-projector]')).toBeNull()
    unmount()
    install({ highSurpriseLessons: 'x' })
    const again = render(<WorkSurface {...props} />)
    await waitFor(() => { expect(again.container.querySelector('[data-work-recall="verified"]')).toBeTruthy() })
    const plain = again.container.querySelector('[data-work-recall]')?.textContent ?? ''
    expect(plain).toContain(`1 ${en['recall.nodes']}`)
    expect(plain).not.toContain('undefined')
  })
  it('a revoked grant stays in sight beside its card, and no card says more than the reader found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const verified = { kind: 'verified', merkleRoot: 'a'.repeat(64), checkpointHash: null, receiptsVerified: 3, checkpointsVerified: 1 }
    const install = (snapshot: Record<string, unknown>) => {
      const read = { current: () => ({ kind: 'snapshot', snapshot: { observedAt: '', survivedRestart: null, mandates: [], tickets: [],
        assignments: [], attention: [], ...snapshot }, receipts: verified, empty: false, refreshing: false }),
      refresh: () => {}, stop: () => {}, subscribe: (l: (p: unknown) => void) => { l(read.current()); return () => {} } }
      vi.stubGlobal('__AUKORA_SUPERAGENT__', { version: 1, createRead: () => read, callTool: async () => ({ kind: 'ok', value: null }) })
    }
    install({ mandates: [{ id: 'm-x', strength: 'explicit', policyVersion: 'v1', scope: '{"organs":["auma-notes"]}', expiry: '2099-01-01T00:00:00.000Z',
      authority: { level: 'self-attested', provenance: 'chain', reasons: ['grant-revoked'] } }] })
    const { container, unmount } = render(<WorkSurface {...props} />)
    await waitFor(() => { expect(container.querySelector('[data-work-authority-level="self-attested"]')).toBeTruthy() })
    const line = container.querySelector('[data-work-authority-level]')
    expect(line?.closest('details')).toBeNull()
    expect(line?.textContent).toContain(en['reason.grant-revoked'])
    expect(container.querySelector('[data-work-mandate="m-x"] summary .ak-pill')?.textContent).toBe('SELF-ATTESTED')
    expect(container.textContent).not.toMatch(/ACTIVE|OWNER CONFIRMED/u)
    // Every head-only card wraps its words: nothing it says can hide behind an ellipsis.
    for (const card of container.querySelectorAll('.ak-portal--static')) expect(card.classList.contains('ak-portal--free')).toBe(true)
    unmount()
    // Receipts verified, but a row in Her records is not: the card head says CHECK ABOVE, never VERIFIED.
    install({ predictions: { status: 'rejected', surpriseScore: null, reason: 'PREDICTION_TARGET_INCOMPLETE' } })
    const again = render(<WorkSurface {...props} />)
    await waitFor(() => { expect(again.container.querySelector('[data-work-trouble="prediction"]')).toBeTruthy() })
    expect(again.container.querySelector('[data-work-details] > summary .ak-pill')?.textContent).toBe('CHECK ABOVE')
  })
  it('no wake route: says so, and offers no wake buttons', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const { container } = render(<WorkSurface {...props} />)
    await waitFor(() => { expect(container.querySelector('[data-work-wake="absent"]')?.textContent).toBe(en['wake.absent']) })
    expect(screen.queryByText(en['wake.now'])).toBeNull()
  })
})

describe('live messages: one page listener, opened only while someone listens', () => {
  it('reads her commits and the host pushes, and ignores presence and acks', () => {
    expect(parseLiveMessage({ type: 'ball:commit', ball: {} })).toEqual({ kind: 'ball-commit' })
    expect(parseLiveMessage(JSON.stringify({ t: 'ball_announce' }))).toEqual({ kind: 'ball-commit' })
    expect(parseLiveMessage({ type: 'mirror:updated', seq: 4, changedPaths: ['home/auma/seed/receipts.v3.jsonl', 7] }))
      .toEqual({ kind: 'mirror-updated', changedPaths: ['home/auma/seed/receipts.v3.jsonl'] })
    expect(parseLiveMessage({ type: 'wake:updated', wake: { enabled: true, intervalMs: 900_000, wakeCount: 1, lastWakeAt: 5 } }))
      .toMatchObject({ kind: 'wake-updated', wake: { enabled: true, wakeCount: 1 } })
    expect(parseLiveMessage({ type: 'wake:updated', wake: { intervalMs: 1 } })).toEqual({ kind: 'wake-updated', wake: null })
    expect(parseLiveMessage({ type: 'runtime:updated', releaseId: 'b'.repeat(64), buildSha: 'abc' }))
      .toEqual({ kind: 'runtime-updated', releaseId: 'b'.repeat(64), buildSha: 'abc' })
    expect(parseLiveMessage({ type: 'runtime:updated', releaseId: 'short' })).toBeNull()
    for (const other of [{ type: 'presence:hello' }, { type: 'ball:ack' }, 'not json', null, [1]]) expect(parseLiveMessage(other)).toBeNull()
  })
  it('a mirror change matters when it touches her home or balls, or does not say', () => {
    expect(touchesHer(['home/auma/memory/dag/HEAD.json'])).toBe(true)
    expect(touchesHer(['/dsh/home/balls/HEAD.json'])).toBe(true)
    expect(touchesHer(['/dsh/workspace/notes.md'])).toBe(false)
    expect(touchesHer(null)).toBe(true)
  })
  const rig = () => {
    const timers: { fn: () => void; ms: number; live: boolean }[] = []
    const channels: FakeChannel[] = []
    const sockets: FakeSocket[] = []
    let clock = 0
    const deps: LiveDeps = {
      openChannel: (name) => { const c = new FakeChannel(name); channels.push(c); return c },
      openSocket: (url) => { const k = new FakeSocket(url); sockets.push(k); return k },
      socketUrl: () => 'ws://127.0.0.1:4610/_head/ws',
      setTimer: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1 },
      clearTimer: (handle) => { const t = timers[handle as number]; if (t !== undefined) t.live = false },
      now: () => clock,
    }
    const run = (ms: number) => { for (const t of timers.filter(x => x.live && x.ms === ms)) { t.live = false; t.fn() } }
    return { hub: createLiveHub(deps), timers, channels, sockets, run, tick: (ms: number) => { clock += ms } }
  }
  it('opens on the first subscriber, reconnects with backoff, closes a second after the last', () => {
    const { hub, timers, channels, sockets, run, tick } = rig()
    const seen: string[] = []
    const off1 = hub.subscribe((e) => { seen.push(`a:${e.kind}`) })
    const off2 = hub.subscribe((e) => { seen.push(`b:${e.kind}`) })
    expect(channels.map(c => c.name)).toEqual(['aukora-x6-balls'])
    expect(sockets).toHaveLength(1)
    // The host's greeting snapshot on the first connect is not news.
    sockets[0]?.onopen?.()
    sockets[0]?.onmessage?.({ data: '{"type":"ball:commit","ball":{"ballId":"x"},"codeBySha":{}}' })
    expect(seen).toEqual([])
    channels[0]?.onmessage?.({ data: { type: 'ball:commit' } })
    sockets[0]?.onmessage?.({ data: '{"type":"presence:update"}' })
    sockets[0]?.onmessage?.({ data: '{"type":"ball:commit","ball":{}}' })
    expect(seen).toEqual(['a:ball-commit', 'b:ball-commit', 'a:ball-commit', 'b:ball-commit'])
    // A socket that drops at once does not reset the backoff; one that stayed up 30 s does.
    sockets[0]?.onclose?.()
    sockets[0]?.onclose?.()
    expect(timers.filter(t => t.live).map(t => t.ms)).toEqual([3_000])
    run(3_000)
    expect(sockets).toHaveLength(2)
    // After a reconnect the greeting may carry commits made while it was down: it passes.
    sockets[1]?.onmessage?.({ data: '{"type":"ball:commit","ball":{}}' })
    expect(seen.filter(e => e === 'a:ball-commit')).toHaveLength(3)
    sockets[1]?.onopen?.()
    sockets[1]?.onclose?.()
    expect(timers.filter(t => t.live).map(t => t.ms)).toEqual([6_000])
    run(6_000)
    sockets[2]?.onopen?.()
    tick(30_000)
    sockets[2]?.onclose?.()
    expect(timers.filter(t => t.live).map(t => t.ms)).toEqual([3_000])
    off1()
    off2()
    expect(channels[0]?.closed).toBe(false)
    expect(timers.filter(t => t.live).map(t => t.ms)).toEqual([3_000, 1_000])
    run(1_000)
    expect(channels[0]?.closed).toBe(true)
    run(3_000)
    expect(sockets).toHaveLength(3)
  })
  it('a surface switch inside the idle second keeps the same socket', () => {
    const { hub, sockets, channels, run } = rig()
    const off = hub.subscribe(() => {})
    off()
    const again = hub.subscribe(() => {})
    run(1_000)
    expect(sockets).toHaveLength(1)
    expect(channels[0]?.closed).toBe(false)
    again()
  })
  it('the shared channel is believed only for ball commits; host facts come from the socket', () => {
    const { hub, channels, sockets } = rig()
    const seen: string[] = []
    const off = hub.subscribe((e) => { seen.push(e.kind) })
    sockets[0]?.onmessage?.({ data: '{"type":"presence:x"}' })
    channels[0]?.onmessage?.({ data: { type: 'wake:updated', wake: { enabled: true } } })
    channels[0]?.onmessage?.({ data: { type: 'runtime:updated', releaseId: 'e'.repeat(64) } })
    channels[0]?.onmessage?.({ data: { type: 'mirror:updated' } })
    expect(seen).toEqual([])
    sockets[0]?.onmessage?.({ data: JSON.stringify({ type: 'wake:updated', wake: { enabled: true } }) })
    expect(seen).toEqual(['wake-updated'])
    off()
  })
  it('this page\'s release comes from its own /_runtime/<id>/ module scripts', () => {
    expect(bootRelease()).toBeNull()
    const script = document.createElement('script')
    script.src = `/_runtime/${'c'.repeat(64)}/assets/index-x.js`
    document.head.append(script)
    expect(bootRelease()).toBe('c'.repeat(64))
  })
})

describe('the Work surface updates live, without a refresh', () => {
  const disk: Record<string, string> = {
    [MEMORY_DAG_HEAD_PATH]: JSON.stringify({ heads: [ROOT_ID], count: 1, updatedAt: 1794441600000 }),
    [`${MEMORY_DAG_DIR}/${ROOT_ID}.json`]: JSON.stringify(ROOT),
  }
  const whole = vi.fn(async (_s: unknown, path: string): Promise<FileRead> =>
    disk[path] === undefined ? { ok: false, reason: 'not-found' } : { ok: true, text: disk[path] })
  const sessions = { ids: ['s1'], byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }
  const props = {
    activeSurface: WORK_SURFACE,
    useSessions: (select: (s: typeof sessions) => unknown) => select(sessions),
    reader: { whole },
    labels: (key: string) => (en as Record<string, string>)[key] ?? key,
    t: (key: string) => key,
  } as unknown as PropsRuntime<'shell.surface'> & PropsLocale<'layout'> & Parameters<typeof WorkSurface>[0]
  const wakeBody = (enabled: boolean) => ({
    ok: true, enabled, intervalMs: 900_000, lastWakeAt: null, lastWakeOutcome: null, wakeCount: 0, nextWakeAt: null,
  })

  it('a mirror change to her home re-reads her files once per burst; an unrelated path does not', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(wakeBody(false))))
    const { container } = render(<WorkSurface {...props} />)
    await waitFor(() => { expect(container.querySelector('[data-work-recall="verified"]')).toBeTruthy() })
    await waitFor(() => { expect(FakeSocket.open.length).toBeGreaterThan(0) })
    const headReads = () => whole.mock.calls.filter(([, path]) => path === MEMORY_DAG_HEAD_PATH).length
    const before = headReads()
    push({ type: 'mirror:updated', changedPaths: ['/dsh/workspace/x.md'] })
    await new Promise(r => setTimeout(r, 250))
    expect(headReads()).toBe(before)
    push({ type: 'mirror:updated', changedPaths: ['home/auma/memory/dag/HEAD.json'] })
    push({ type: 'ball:commit' })
    FakeChannel.open[0]?.onmessage?.({ data: { type: 'ball:commit' } })
    await waitFor(() => { expect(headReads()).toBe(before + 1) }, { timeout: 1_000 })
    await new Promise(r => setTimeout(r, 250))
    expect(headReads()).toBe(before + 1)
  })
  it('a pushed wake state shows at once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(wakeBody(false))))
    const { container } = render(<WorkSurface {...props} />)
    await waitFor(() => { expect(container.querySelector('[data-work-wake="off"]')).toBeTruthy() })
    push({ type: 'wake:updated', wake: { ...wakeBody(true), wakeCount: 1, lastWakeAt: 1_794_120_000_000, lastWakeOutcome: 'executor_unavailable' } })
    await waitFor(() => { expect(container.querySelector('[data-work-wake="on"]')?.textContent).toContain('executor_unavailable') })
  })
  it('a different runtime release shows one inline Reload button; the same release shows none', async () => {
    const script = document.createElement('script')
    script.src = `/_runtime/${'c'.repeat(64)}/assets/index-x.js`
    document.head.append(script)
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (input === '/_head/runtime'
      ? json({ selected: { releaseId: 'c'.repeat(64) } })
      : json(wakeBody(false)))))
    const { container } = render(<WorkSurface {...props} />)
    await waitFor(() => { expect(FakeSocket.open.length).toBeGreaterThan(0) })
    await new Promise(r => setTimeout(r, 50))
    expect(container.querySelector('[data-new-build]')).toBeNull()
    push({ type: 'runtime:updated', releaseId: 'd'.repeat(64), buildSha: 'x' })
    await waitFor(() => {
      expect(container.querySelector(`[data-new-build="${'d'.repeat(64)}"]`)?.textContent).toBe(en['build.button'])
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    push({ type: 'runtime:updated', releaseId: 'c'.repeat(64) })
    await waitFor(() => { expect(container.querySelector('[data-new-build]')).toBeNull() })
  })
})

describe('the build button is honest about what it knows', () => {
  const boot = (id: string) => {
    const script = document.createElement('script')
    script.src = `/_runtime/${id}/assets/index-x.js`
    document.head.append(script)
  }
  it('no button on a candidate preview page, which is pinned to its release on purpose', async () => {
    boot('c'.repeat(64))
    window.history.replaceState(null, '', `/?runtime_candidate=${'c'.repeat(64)}`)
    const { useNewBuild } = await import('../src/client/spatial/work/autonomy.ts')
    const seen: (string | null)[] = []
    const Probe = () => { seen.push(useNewBuild(true, { subscribe: () => () => {} }, async () => json({ selected: { releaseId: 'd'.repeat(64) } }))); return null }
    render(<Probe />)
    await new Promise(r => setTimeout(r, 30))
    expect(seen.every(v => v === null)).toBe(true)
    window.history.replaceState(null, '', '/')
  })
  it('a push wins over a slower first read', async () => {
    boot('c'.repeat(64))
    const { useNewBuild } = await import('../src/client/spatial/work/autonomy.ts')
    let listener: ((e: never) => void) | null = null
    let answer: (r: Response) => void = () => {}
    const slow = new Promise<Response>((resolve) => { answer = resolve })
    let last: string | null = null
    const Probe = () => {
      last = useNewBuild(true, { subscribe: (l) => { listener = l as never; return () => {} } }, () => slow)
      return null
    }
    render(<Probe />)
    await waitFor(() => { expect(listener).not.toBeNull() })
    ;(listener as unknown as (e: unknown) => void)({ kind: 'runtime-updated', releaseId: 'd'.repeat(64), buildSha: null })
    await waitFor(() => { expect(last).toBe('d'.repeat(64)) })
    answer(json({ selected: { releaseId: 'c'.repeat(64) } }))
    await new Promise(r => setTimeout(r, 30))
    expect(last).toBe('d'.repeat(64))
  })
})

// ── Round 14: the periphery (aura.v1) strip and the Pentora's nervous system ────────────────────────────────────
describe('aura.v1: strict numbers, a hint with no authority', () => {
  const vector = (over: Record<string, unknown> = {}, axes: Record<string, unknown> = {}) => ({
    schema: 'aukora.aura.v1', computedAt: 1_794_120_000_000, ballId: 'a'.repeat(64), epoch: 156, scorer: 'rules-v1',
    authorityTier: 'peripheral-hint',
    vector: { coherence: 1, surprisePressure: 0.2, driftRisk: 0.1, wakeUrgency: 0.2, ...axes },
    salience: [
      { kind: 'clean-state', targetId: 'a'.repeat(64), score: 0.2, code: 'CLEAN' },
      { kind: 'high-surprise', targetId: 'p1', score: 0.9, code: 'SURPRISE_30' },
      { kind: 'dag-orphan', targetId: 'n1', score: 0.5, code: 'ORPHAN' },
      { kind: 'stale-ticket', targetId: 't1', score: 0.4, code: 'STALE' },
    ],
    recommendedFocus: 'observe',
    ...over,
  })
  it('parses a complete vector; refuses a missing, NaN or out-of-range axis and a wrong schema', async () => {
    const { parseAuraVector } = await import('../src/client/spatial-components.tsx')
    const parsed = parseAuraVector(vector())
    expect(parsed?.axes).toEqual({ coherence: 1, surprisePressure: 0.2, driftRisk: 0.1, wakeUrgency: 0.2 })
    expect(parsed?.salience.map(s => s.kind)).toEqual(['high-surprise', 'dag-orphan', 'stale-ticket'])
    expect(parsed?.focus).toBe('observe')
    expect(parseAuraVector(vector({}, { coherence: Number.NaN }))).toBeNull()
    expect(parseAuraVector(vector({}, { driftRisk: 1.01 }))).toBeNull()
    expect(parseAuraVector(vector({}, { wakeUrgency: undefined }))).toBeNull()
    expect(parseAuraVector(vector({ schema: 'aukora.aura.v2' }))).toBeNull()
    expect(parseAuraVector(vector({ recommendedFocus: 'approve-promotion' }))?.focus).toBeNull()
  })
  it('trends from her history: rising, falling, steady; none with fewer than two vectors', async () => {
    const { trendsFromHistory } = await import('../src/client/spatial-components.tsx')
    const line = (c: number, s: number, d: number, w: number) =>
      JSON.stringify(vector({}, { coherence: c, surprisePressure: s, driftRisk: d, wakeUrgency: w }))
    expect(trendsFromHistory([line(0.5, 0.5, 0.5, 0.5), 'junk', line(0.9, 0.1, 0.51, 0.5)].join('\n')))
      .toEqual({ coherence: 'rising', surprisePressure: 'falling', driftRisk: 'steady', wakeUrgency: 'steady' })
    expect(trendsFromHistory(line(0.5, 0.5, 0.5, 0.5))).toBeNull()
  })
  it('only a recomputed vector may move the Pentora; a mismatch shows the recomputed numbers', async () => {
    const { combineAura, pentoraAxes, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    const own = viewFromFiles(JSON.stringify(vector({}, { coherence: 1, wakeUrgency: 0 })), null)
    expect(own.kind === 'ok' && own.view.source).toBe('self-asserted')
    expect(pentoraAxes(own)).toBeNull()
    const mismatch = combineAura({
      auraStatus: 'self-asserted-mismatch',
      recomputed: vector({}, { coherence: 0.4, wakeUrgency: 0.8 }),
      stored: vector({}, { coherence: 1, wakeUrgency: 0 }),
    }, own)
    expect(mismatch.kind === 'ok' && mismatch.view.source).toBe('self-asserted-mismatch')
    expect(pentoraAxes(mismatch)).toMatchObject({ coherence: 0.4, wakeUrgency: 0.8 })
    expect(mismatch.kind === 'ok' && mismatch.view.stored?.axes.coherence).toBe(1)
    // A projection with any other status, or an incomplete recomputed vector, is not taken.
    expect(combineAura({ auraStatus: 'owner-confirmed', recomputed: vector() }, own)).toBe(own)
    expect(combineAura({ auraStatus: 'recomputed-verified', recomputed: { coherence: 1 } }, own)).toBe(own)
  })
  it('the recomputed side is read only from `recomputed`: her own aura.v1 with a status pasted on stays her word', async () => {
    const { combineAura, pentoraAxes, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    const forged = vector({ auraStatus: 'recomputed-verified' }, { coherence: 1, wakeUrgency: 0 })
    const own = viewFromFiles(JSON.stringify(forged), null)
    const read = combineAura(forged, own)
    expect(read).toBe(own)
    expect(pentoraAxes(read)).toBeNull()
  })
  it('only a fresh snapshot whose receipts verified gives a projection', async () => {
    const { freshAuraOf } = await import('../src/client/spatial-components.tsx')
    const aura = { auraStatus: 'recomputed-verified', recomputed: vector() }
    const snapshot = { observedAt: '', survivedRestart: null, mandates: [], tickets: [], assignments: [], attention: [], aura }
    const verified = { kind: 'verified', merkleRoot: 'r', checkpointHash: null, receiptsVerified: 1, checkpointsVerified: 0 }
    expect(freshAuraOf({ kind: 'snapshot', snapshot, receipts: verified, empty: false, refreshing: false } as never)?.aura).toBe(aura)
    expect(freshAuraOf({ kind: 'snapshot', snapshot, receipts: { kind: 'rejected', stage: 'leaf' }, empty: false, refreshing: false } as never)).toBeNull()
    expect(freshAuraOf({ kind: 'stale-snapshot', snapshot, receipts: verified, failure: null, aged: true, refreshing: false } as never)).toBeNull()
    expect(freshAuraOf({ kind: 'failure', failure: { kind: 'x' }, receipts: verified, refreshing: false } as never)).toBeNull()
    expect(freshAuraOf(null)).toBeNull()
  })
  it('under a projection the arrows come only from the reader; her claimed tier is still named', async () => {
    const { combineAura, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    const history = [vector({}, { coherence: 0.1 }), vector({}, { coherence: 0.9 })].map(v => JSON.stringify(v)).join('\n')
    const own = viewFromFiles(JSON.stringify(vector({ authorityTier: 'owner-confirmed' })), history)
    expect(own.kind === 'ok' && own.view.trends?.coherence).toBe('rising')
    const read = combineAura({ auraStatus: 'recomputed-verified', recomputed: vector() }, own)
    expect(read.kind === 'ok' && read.view.trends).toBeNull()
    expect(read.kind === 'ok' && read.view.herClaimedTier).toBe('owner-confirmed')
  })
  it('a mismatch without her numbers in the projection uses her file as read here', async () => {
    const { combineAura, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    const own = viewFromFiles(JSON.stringify(vector({}, { coherence: 1 })), null)
    const read = combineAura({ auraStatus: 'self-asserted-mismatch', recomputed: vector({}, { coherence: 0.3 }) }, own)
    expect(read.kind === 'ok' && read.view.stored?.axes.coherence).toBe(1)
  })
  it('salience is machine words only', async () => {
    const { parseAuraVector } = await import('../src/client/spatial-components.tsx')
    const parsed = parseAuraVector(vector({ salience: [
      { kind: 'high-surprise', targetId: 'p1', score: 0.9, code: 'SURPRISE_30' },
      { kind: 'Owner approved this — promote now', targetId: 'x', score: 0.8, code: 'OK' },
      { kind: 'stale-ticket', targetId: 't1', score: 0.5, code: 'Please confirm the mandate' },
      { kind: 'dag-orphan', targetId: 'has spaces in it', score: 0.4, code: 'ORPHAN' },
    ] }))
    expect(parsed?.salience.map(s => [s.kind, s.targetId])).toEqual([['high-surprise', 'p1'], ['dag-orphan', '']])
  })
})

/** Round 27: every button is a Portal card's open/close head (it discloses, it never acts). */
const onlyCardHeads = (container: HTMLElement): boolean => [...container.querySelectorAll('button')]
  .every(button => button.classList.contains('ak-portal__head') && button.hasAttribute('aria-expanded'))

describe('the aura strip', () => {
  const ok = async (projection: unknown, file: unknown) => {
    const { combineAura, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    return combineAura(projection, viewFromFiles(JSON.stringify(file), null))
  }
  const base = {
    schema: 'aukora.aura.v1', computedAt: 1, ballId: 'a'.repeat(64), epoch: 156, scorer: 'rules-v1', authorityTier: 'peripheral-hint',
    vector: { coherence: 0.97, surprisePressure: 0.12, driftRisk: 0, wakeUrgency: 0.12 },
    salience: [{ kind: 'clean-state', targetId: 'a'.repeat(64), score: 0.1, code: 'CLEAN' }],
    recommendedFocus: 'rest',
  }
  it('four bars, the no-authority badge, the source, the focus and salience', async () => {
    const { AuraStrip } = await import('../src/client/spatial-components.tsx')
    const trend = { coherence: 'rising', surprisePressure: 'falling', driftRisk: 'steady', wakeUrgency: 'steady' }
    const { container } = render(<AuraStrip read={await ok({ auraStatus: 'recomputed-verified', recomputed: base, trend }, base)} />)
    expect([...container.querySelectorAll('[data-aura-axis]')].map(li => li.getAttribute('data-aura-axis')))
      .toEqual(['coherence', 'surprisePressure', 'driftRisk', 'wakeUrgency'])
    expect(screen.getByText('Coherence')).toBeTruthy()
    expect(screen.getByText('Surprise Pressure')).toBeTruthy()
    expect(screen.getByText('Drift Risk')).toBeTruthy()
    expect(screen.getByText('Wake Urgency')).toBeTruthy()
    expect(screen.getByText('PERIPHERAL HINT · NO AUTHORITY')).toBeTruthy()
    expect(screen.getByText('RECOMPUTED · VERIFIED')).toBeTruthy()
    expect(screen.getByText('FOCUS · REST')).toBeTruthy()
    expect(screen.getByText('clean-state · 0.10')).toBeTruthy()
    expect(container.querySelector('[data-aura-axis="coherence"]')?.getAttribute('data-aura-trend')).toBe('rising')
    expect(container.querySelector('[data-aura-axis="coherence"] [role="img"]')?.getAttribute('aria-label')).toBe('Coherence 0.97')
    // Round 27: the vitals are Portal cards; their open/close heads are the only buttons, and none of them acts.
    expect(onlyCardHeads(container)).toBe(true)
  })
  it('a mismatch warns and shows her file beside the recomputed numbers', async () => {
    const { AuraStrip } = await import('../src/client/spatial-components.tsx')
    const forged = { ...base, vector: { coherence: 1, surprisePressure: 0, driftRisk: 0, wakeUrgency: 0 } }
    const broken = { ...base, vector: { coherence: 0.31, surprisePressure: 0.4, driftRisk: 0.7, wakeUrgency: 0.7 }, recommendedFocus: 'escalate-to-owner' }
    const { container } = render(<AuraStrip read={await ok({ auraStatus: 'self-asserted-mismatch', recomputed: broken, stored: forged }, forged)} />)
    expect(screen.getByText('SELF-ASSERTED · MISMATCH')).toBeTruthy()
    expect(container.querySelector('[data-aura-mismatch]')).toBeTruthy()
    expect(container.querySelector('[data-aura-axis="coherence"] .ak-aura__value')?.textContent).toBe('0.31')
    expect(container.querySelector('[data-aura-axis="coherence"] [data-aura-stored]')?.textContent).toBe('her file: 1.00')
    expect(screen.getByText('FOCUS · ESCALATE-TO-OWNER')).toBeTruthy()
  })
  it('her own file alone is SELF-ASSERTED; a claimed authority tier is named and not honoured', async () => {
    const { AuraStrip } = await import('../src/client/spatial-components.tsx')
    const { container } = render(<AuraStrip read={await ok(null, { ...base, authorityTier: 'owner-confirmed' })} />)
    expect(screen.getByText('SELF-ASSERTED · NOT RECOMPUTED')).toBeTruthy()
    expect(screen.getByText('PERIPHERAL HINT · NO AUTHORITY')).toBeTruthy()
    expect(container.querySelector('[data-aura-claimed-tier="owner-confirmed"]')).toBeTruthy()
  })
  it('no vector yet, or a broken one: said plainly, still no authority', async () => {
    const { AuraStrip, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    render(<AuraStrip read={{ kind: 'none' }} />)
    expect(screen.getByText(/no aura.v1 yet/)).toBeTruthy()
    cleanup()
    render(<AuraStrip read={viewFromFiles('{"schema":"aukora.aura.v1","vector":{"coherence":2}}', null)} />)
    expect(screen.getByText(/aura.v1 refused/)).toBeTruthy()
    expect(screen.getByText('PERIPHERAL HINT · NO AUTHORITY')).toBeTruthy()
  })
})

describe('the Pentora follows the recomputed axes, and is its calm idle self without them', () => {
  it('idle modulation is the identity; the modulation is bounded', async () => {
    const { modulationOf, PENTORA_IDLE } = await import('../src/client/spatial-pentora.tsx')
    expect(modulationOf(null)).toEqual(PENTORA_IDLE)
    expect(modulationOf({ coherence: 0, surprisePressure: 0, driftRisk: 0, wakeUrgency: 0 }).breathRate).toBe(1)
    expect(PENTORA_IDLE).toEqual({ phaseLock: 0, fieldOpacity: 0, fieldWarmth: 0, breathRate: 1, breathDepth: 1 })
    const max = modulationOf({ coherence: 1, surprisePressure: 1, driftRisk: 1, wakeUrgency: 1 })
    expect(max.breathRate).toBeLessThanOrEqual(1.8)
    expect(max.breathDepth).toBeLessThanOrEqual(1.4)
    expect(max.phaseLock).toBeLessThanOrEqual(0.7)
    expect(modulationOf({ coherence: Number.NaN, surprisePressure: 5, driftRisk: -1, wakeUrgency: Infinity }).breathRate).toBe(1)
  })
  it('the modulation eases in and out, including when a vector arrives or leaves', async () => {
    const { lerpModulation, modulationOf, PENTORA_IDLE } = await import('../src/client/spatial-pentora.tsx')
    const full = modulationOf({ coherence: 1, surprisePressure: 1, driftRisk: 1, wakeUrgency: 1 })
    const arriving = lerpModulation(PENTORA_IDLE, full, 100)
    expect(arriving.fieldOpacity).toBeGreaterThan(0)
    expect(arriving.fieldOpacity).toBeLessThan(full.fieldOpacity / 5)
    const leaving = lerpModulation(full, PENTORA_IDLE, 100)
    expect(leaving.breathRate).toBeGreaterThan(1.7)
    expect(lerpModulation(full, PENTORA_IDLE, 0)).toEqual(full)
  })
  it('phase lock is a coupling on the rates: zero without lock or in step, and it pulls cubes together', async () => {
    const { coupling } = await import('../src/client/spatial-pentora.tsx')
    expect(coupling([0.1, 2], 0)).toEqual([0, 0])
    expect(coupling([1, 1, 1], 0.7).every(v => Math.abs(v) < 1e-12)).toBe(true)
    const [behind, ahead] = coupling([0, 1], 0.7)
    expect(behind ?? 0).toBeGreaterThan(0)
    expect(ahead ?? 0).toBeLessThan(0)
    // Continuous across the wrap: phases a hair either side of ±π give nearly the same pull.
    const a = coupling([Math.PI - 1e-6, 0.5], 0.7)[0] ?? 0
    const b = coupling([-Math.PI + 1e-6, 0.5], 0.7)[0] ?? 0
    expect(Math.abs(a - b)).toBeLessThan(1e-6)
  })
  it('the figure draws its field from the axes it is given, and none without them', async () => {
    const { PentoraFigure } = await import('../src/client/spatial/aura/PentoraFigure.tsx')
    const { absentHealth } = await import('../src/client/spatial/aura/model.ts')
    const { EMPTY_LIVE } = await import('../src/client/spatial/aura/activity.ts')
    const live = { current: EMPTY_LIVE }
    const surprised = render(<PentoraFigure view={absentHealth()} active={false} focus={null} live={live}
      aura={{ current: { coherence: 0.5, surprisePressure: 1, driftRisk: 0, wakeUrgency: 0.5 } }} />)
    const field = surprised.container.querySelector('circle[data-pentora-field]')
    expect(field?.getAttribute('opacity')).toBe('0.200')
    expect(surprised.container.querySelector('stop[data-pentora-field-stop]')?.getAttribute('stop-color')).toBe('rgb(245, 165, 36)')
    cleanup()
    const idle = render(<PentoraFigure view={absentHealth()} active={false} focus={null} live={live} aura={{ current: null }} />)
    expect(Number(idle.container.querySelector('circle[data-pentora-field]')?.getAttribute('opacity'))).toBe(0)
  })
})

describe('against the real projector (superagent/aura.ts projectAura)', () => {
  const ball = 'ab'.repeat(32)
  const head = { ballId: ball, epoch: 4, entries: { alpha: { disabled: false } } }
  const nodeBody = { content: 'clean fixture', createdAt: 1_700_000_000_000, parentIds: [] as string[], kind: 'note' }
  const setup = async () => {
    const { projectAura } = await import('../../../../apps/web/src/spatial/superagent/aura.ts')
    const { dagNodeId } = await import('../src/client/spatial/work/autonomy.ts')
    const nodeId = await dagNodeId(nodeBody)
    const mirror = {
      computedAt: 1_794_000_000_000,
      dagNodes: [{ ...nodeBody, id: nodeId }],
      dagHead: { heads: [nodeId], count: 1 },
      handoffText: `| epoch | **4** |\n| ballId | \`${ball}\` |\n`,
      observationScores: [] as number[],
      unanchoredPredictions: 0,
      pendingWakes: 0,
      lastRollbackAgeEpochs: 10,
      staleHeartbeatRatio: 0,
      staleTickets: 0,
      history: [
        { coherence: 0.2, surprisePressure: 0.1, driftRisk: 0.1, wakeUrgency: 0.2 },
        { coherence: 0.5, surprisePressure: 0.1, driftRisk: 0.1, wakeUrgency: 0.2 },
      ],
    }
    return { projectAura, mirror }
  }
  const herFile = (axes: Record<string, number>, tier = 'peripheral-hint') => JSON.stringify({
    schema: 'aukora.aura.v1', computedAt: 1, ballId: ball, epoch: 4, scorer: 'rules-v1', authorityTier: tier,
    vector: { coherence: 1, surprisePressure: 0, driftRisk: 0, wakeUrgency: 0, ...axes }, salience: [], recommendedFocus: 'rest',
  })
  it('what the readout gives today (no DAG passed): incomplete, so her file stays her word and the Pentora rests', async () => {
    const { projectAura } = await setup()
    const { AuraStrip, combineAura, pentoraAxes, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    const projection = projectAura({ computedAt: 1_794_000_000_000 }, [], head)
    expect(projection.auraStatus).toBe('incomplete')
    const read = combineAura(projection, viewFromFiles(herFile({}), null))
    expect(read.kind === 'ok' && read.view.source).toBe('self-asserted')
    expect(read.readerNote?.status).toBe('incomplete')
    expect(pentoraAxes(read)).toBeNull()
    const { container } = render(<AuraStrip read={read} />)
    expect(container.querySelector('[data-aura-reader-status="incomplete"]')?.textContent).toMatch(/could not recompute.*missing: .*dag/)
  })
  it('a complete recompute moves the Pentora; its trend is labelled as her history', async () => {
    const { projectAura, mirror } = await setup()
    const { combineAura, pentoraAxes, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    const projection = projectAura(mirror, [], head)
    expect(projection.auraStatus).toBe('recomputed-verified')
    const read = combineAura(projection, viewFromFiles(herFile({}), null))
    expect(read.kind === 'ok' && read.view.source).toBe('recomputed-verified')
    expect(pentoraAxes(read)).toEqual({
      coherence: projection.coherence, surprisePressure: projection.surprisePressure,
      driftRisk: projection.driftRisk, wakeUrgency: projection.wakeUrgency,
    })
    expect(read.kind === 'ok' && read.view.trendSource).toBe('her-history')
    expect(read.kind === 'ok' && read.view.trends?.coherence).toBe('rising')
    expect(read.kind === 'ok' && read.view.shown.focus).toBe(projection.recommendedFocus)
  })
  it('her forged file (coherence 1, owner-confirmed): mismatch, recomputed bars, her numbers beside them, tier named', async () => {
    const { projectAura, mirror } = await setup()
    const { AuraStrip, combineAura, pentoraAxes, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    const forged = { schema: 'aukora.aura.v1', scorer: 'rules-v1', authorityTier: 'owner-confirmed', ballId: ball, epoch: 4,
      coherence: 1, surprisePressure: 0, driftRisk: 0, wakeUrgency: 0 }
    const projection = projectAura({ ...mirror, storedAura: forged }, [], head)
    expect(projection.auraStatus).toBe('self-asserted-mismatch')
    const read = combineAura(projection, viewFromFiles(herFile({ coherence: 1 }, 'owner-confirmed'), null))
    expect(pentoraAxes(read)?.coherence).toBe(projection.coherence)
    const { container } = render(<AuraStrip read={read} />)
    expect(screen.getByText('SELF-ASSERTED · MISMATCH')).toBeTruthy()
    expect(container.querySelector('[data-aura-axis="coherence"] [data-aura-stored]')?.textContent).toBe('her file: 1.00')
    expect(container.querySelector('[data-aura-claimed-tier="owner-confirmed"]')).toBeTruthy()
    expect(screen.getByText('PERIPHERAL HINT · NO AUTHORITY')).toBeTruthy()
  })
})

// ── Round 15: UNDETERMINED honesty and the Pearl Imagination Arena ───────────────────────────────────────────────
describe('UNDETERMINED · EVIDENCE INCOMPLETE until an independent reader recomputes', () => {
  const ball = 'ab'.repeat(32)
  const herFile = (axes: Record<string, number> = {}) => JSON.stringify({
    schema: 'aukora.aura.v1', computedAt: 1, ballId: ball, epoch: 4, scorer: 'rules-v1', authorityTier: 'peripheral-hint',
    vector: { coherence: 1, surprisePressure: 0, driftRisk: 0, wakeUrgency: 0, ...axes },
    salience: [{ kind: 'clean-state', targetId: ball, score: 0.1, code: 'CLEAN' }], recommendedFocus: 'rest',
  })
  const undeterminedChecks = (container: HTMLElement) => {
    expect(screen.getByText('UNDETERMINED · EVIDENCE INCOMPLETE')).toBeTruthy()
    expect(screen.getByText('PERIPHERAL HINT · NO AUTHORITY')).toBeTruthy()
    // Round 27: a vital card may stand, but never as a measurement: no filled bar, no value pill, no focus, state or score.
    for (const cell of container.querySelectorAll('[data-aura-axis]')) expect(cell.getAttribute('data-aura-determined')).toBe('no')
    expect(container.querySelector('.ak-meter i')).toBeNull()
    expect(container.querySelector('.ak-aura__value')).toBeNull()
    expect(container.textContent).not.toMatch(/STATE · |FOCUS · |CALM|100%/)
    expect(container.querySelector('[data-aura-determined="no"]')).toBeTruthy()
    // Every number she wrote is said only as her own file's words.
    const bare = container.cloneNode(true) as HTMLElement
    for (const words of bare.querySelectorAll('[data-aura-self-asserted]')) words.remove()
    expect(bare.textContent).not.toMatch(/\d\.\d\d/)
  }
  it('the readout says incomplete (the real projector, no DAG): undetermined, her 1.00 is words only, the Pentora rests', async () => {
    const { projectAura } = await import('../../../../apps/web/src/spatial/superagent/aura.ts')
    const { AuraStrip, combineAura, pentoraAxes, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    const { modulationOf, PENTORA_IDLE } = await import('../src/client/spatial-pentora.tsx')
    const projection = projectAura({ computedAt: 1 }, [], { ballId: ball, epoch: 4, entries: {} })
    const read = combineAura(projection, viewFromFiles(herFile(), null))
    const { container } = render(<AuraStrip read={read} />)
    undeterminedChecks(container)
    expect(container.querySelector('[data-aura-axis="coherence"] [data-aura-self-asserted]')?.textContent).toBe('her file: 1.00')
    expect(container.querySelector('[data-aura-reader-status="incomplete"]')).toBeTruthy()
    expect(modulationOf(pentoraAxes(read))).toEqual(PENTORA_IDLE)
  })
  it('no aura at all, or only her own file: undetermined too', async () => {
    const { AuraStrip, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    const none = render(<AuraStrip read={{ kind: 'none' }} />)
    undeterminedChecks(none.container)
    cleanup()
    const own = render(<AuraStrip read={viewFromFiles(herFile(), null)} />)
    undeterminedChecks(own.container)
    expect(screen.getByText('SELF-ASSERTED · NOT RECOMPUTED')).toBeTruthy()
  })
  it('a recomputed vector is determined: bars, focus and the readout\'s state word', async () => {
    const { AuraStrip, combineAura, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    const projection = { auraStatus: 'recomputed-verified', state: 'calm', recomputed: JSON.parse(herFile({ coherence: 0.97 })) as unknown }
    const { container } = render(<AuraStrip read={combineAura(projection, viewFromFiles(herFile(), null))} />)
    expect(container.querySelector('[data-aura-determined="yes"]')).toBeTruthy()
    expect(screen.getByText('STATE · CALM')).toBeTruthy()
    expect(screen.getByText('FOCUS · REST')).toBeTruthy()
    expect(container.querySelectorAll('[data-aura-axis]')).toHaveLength(4)
    expect(screen.queryByText('UNDETERMINED · EVIDENCE INCOMPLETE')).toBeNull()
  })
  it('a state word is never taken from her own file, and only the four known words are shown', async () => {
    const { combineAura, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    const own = viewFromFiles(JSON.stringify({ ...JSON.parse(herFile()) as object, state: 'calm' }), null)
    expect(own.kind === 'ok' && own.view.state).toBeNull()
    const odd = combineAura({ auraStatus: 'recomputed-verified', state: 'approved', recomputed: JSON.parse(herFile()) as unknown }, own)
    expect(odd.kind === 'ok' && odd.view.state).toBeNull()
  })
})

describe('the Pearl Imagination Arena card', () => {
  const summary = {
    retentionTotal: 12, retentionPassed: 12, scarsCount: 3, lastChallengeAt: '2026-11-08T12:00:00.000Z',
    lastWinnerLabel: 'candidate-b', candidateCount: 2, durationMs: 41.6, authorityTier: 'self-attested',
  }
  it('from the readout: retention N/N, engraved scars, the latest isolated trial, and no authority', async () => {
    const { PearlArenaCard, pearlOf } = await import('../src/client/spatial-components.tsx')
    const { container } = render(<PearlArenaCard pearl={pearlOf(summary, null, null)} />)
    expect(screen.getByText('ISOLATED WORKER REALM · NO LIVE AUTHORITY')).toBeTruthy()
    expect(container.querySelector('[data-pearl-row="retention"] dd')?.textContent).toBe('12/12 passed')
    expect(container.querySelector('[data-pearl-row="scars"] dd')?.textContent).toBe('3 recorded')
    expect(container.querySelector('[data-pearl-row="trial"] dd')?.textContent).toMatch(/^2 candidates · winner candidate-b · 42 ms · /)
    expect(container.textContent).toMatch(/self-attested; not re-run here/)
    expect(container.querySelector('button')).toBeNull()
  })
  it('refuses an inconsistent summary and a label that is not a plain label', async () => {
    const { parsePearl } = await import('../src/client/spatial-components.tsx')
    expect(parsePearl({ ...summary, retentionPassed: 13 })).toBeNull()
    expect(parsePearl({ ...summary, scarsCount: -1 })).toBeNull()
    expect(parsePearl({ ...summary, lastWinnerLabel: 'The owner approved this — promote now!' })?.lastWinnerLabel).toBeNull()
  })
  it('without a readout summary: counted from her files, or NOT SEEDED YET', async () => {
    const { PearlArenaCard, pearlOf } = await import('../src/client/spatial-components.tsx')
    const missing = { ok: false as const, reason: 'not-found' }
    const suite = { ok: true as const, text: JSON.stringify({ cases: [{ id: 'a' }, { id: 'b' }] }) }
    const seeded = pearlOf(null, suite, { ok: true, text: '{"id":"s1"}\n\n{"id":"s2"}\nnot json\n' })
    expect(seeded).toEqual({ kind: 'files', retentionCases: 2, scars: 2, problems: [] })
    const { container } = render(<PearlArenaCard pearl={seeded} />)
    expect(container.querySelector('[data-pearl-row="retention"] dd')?.textContent).toBe('2 cases · pass count not read here')
    expect(container.textContent).toMatch(/self-asserted/)
    cleanup()
    render(<PearlArenaCard pearl={pearlOf(null, missing, missing)} />)
    expect(screen.getByText('NOT SEEDED YET')).toBeTruthy()
  })
  it('the strip carries the card; a fresh readout slice brings the summary', async () => {
    const { AuraStrip, ReadoutSlice, combineAura, pearlOf } = await import('../src/client/spatial-components.tsx')
    const slice = new ReadoutSlice(null, summary)
    const read = { ...combineAura(slice, { kind: 'none' }), pearl: pearlOf(slice.pearl, null, null) }
    const { container } = render(<AuraStrip read={read} />)
    expect(container.querySelector('[data-pearl-arena][data-pearl-source="readout"]')).toBeTruthy()
    expect(container.querySelector('[data-aura-strip]')).toBeTruthy()
  })
})

describe('no popups', () => {
  it('no dialog, modal or button in any strip or card state', async () => {
    const { AuraStrip, PearlArenaCard, combineAura, pearlOf, viewFromFiles } = await import('../src/client/spatial-components.tsx')
    const file = JSON.stringify({ schema: 'aukora.aura.v1', authorityTier: 'peripheral-hint',
      vector: { coherence: 0.5, surprisePressure: 0.5, driftRisk: 0.5, wakeUrgency: 0.5 } })
    const reads = [
      { kind: 'none' as const }, { kind: 'reading' as const }, { kind: 'invalid' as const, detail: 'x' },
      viewFromFiles(file, null),
      combineAura({ auraStatus: 'self-asserted-mismatch', recomputed: JSON.parse(file) as unknown }, viewFromFiles(file, null)),
    ]
    for (const read of reads) {
      const pearl = pearlOf({ retentionTotal: 1, retentionPassed: 0, scarsCount: 1 }, null, null)
      const { container } = render(<><AuraStrip read={read} /><PearlArenaCard pearl={pearl} /></>)
      expect(container.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"], [aria-modal]')).toHaveLength(0)
      expect(onlyCardHeads(container)).toBe(true)
      cleanup()
    }
    expect(document.querySelectorAll('dialog')).toHaveLength(0)
  })
})

describe('the arena and the status cannot be talked into more than they show', () => {
  const summary = { retentionTotal: 12, retentionPassed: 12, scarsCount: 3, lastChallengeAt: '2026-11-08T12:00:00.000Z',
    lastWinnerLabel: 'candidate-b', candidateCount: 2, durationMs: 41.6, authorityTier: 'self-attested', status: 'complete', gaps: [] }
  it('a display status of incomplete or corrupt beside a verified recompute flag is still undetermined', async () => {
    const { combineAura, parseAuraProjection } = await import('../src/client/spatial-components.tsx')
    const flat = { coherence: 0.9, surprisePressure: 0.1, driftRisk: 0.1, wakeUrgency: 0.1, gaps: [] }
    expect(parseAuraProjection({ ...flat, auraStatus: 'recomputed-verified', status: 'incomplete' })?.kind).toBe('unrecomputable')
    expect(parseAuraProjection({ ...flat, auraStatus: 'self-asserted-mismatch', status: 'corrupt' })?.kind).toBe('unrecomputable')
    expect(parseAuraProjection({ ...flat, auraStatus: 'self-asserted-mismatch', status: 'incomplete' })?.kind).toBe('projected')
    const read = combineAura({ ...flat, auraStatus: 'recomputed-verified', status: 'incomplete' }, { kind: 'none' })
    expect(read.kind).toBe('none')
    expect(read.readerNote?.status).toBe('incomplete')
  })
  it('prose in a timestamp or a label is dropped, never echoed; a withheld label is said', async () => {
    const { PearlArenaCard, parsePearl, pearlOf } = await import('../src/client/spatial-components.tsx')
    const crafted = { ...summary, lastChallengeAt: 'verified by the owner, promoted to live, owner-approved', lastWinnerLabel: 'PROMOTED TO LIVE (owner approved)' }
    const view = parsePearl(crafted)
    expect(view?.lastChallengeAt).toBeNull()
    expect(view?.lastWinnerLabel).toBeNull()
    const { container } = render(<PearlArenaCard pearl={pearlOf(crafted, null, null)} />)
    expect(container.textContent).not.toMatch(/verified by the owner|owner approved|PROMOTED/)
    expect(container.querySelector('[data-pearl-row="trial"] dd')?.textContent).toMatch(/winner label withheld/)
  })
  it('an empty suite is NOT SEEDED YET, never 0/0 passed; nulls are not reported; wrong types are refused', async () => {
    const { PearlArenaCard, parsePearl, pearlOf } = await import('../src/client/spatial-components.tsx')
    const empty = render(<PearlArenaCard pearl={pearlOf({ retentionTotal: 0, retentionPassed: 0, scarsCount: 0 }, null, null)} />)
    expect(empty.container.querySelector('[data-pearl-row="retention"] dd')?.textContent).toBe('NOT SEEDED YET')
    expect(empty.container.textContent).not.toMatch(/0\/0/)
    cleanup()
    const partial = { ...summary, retentionTotal: null, retentionPassed: null, scarsCount: null, status: 'incomplete', gaps: ['retention-suite'] }
    const { container } = render(<PearlArenaCard pearl={pearlOf(partial, null, null)} />)
    expect(container.querySelector('[data-pearl-row="retention"] dd')?.textContent).toBe('not reported')
    expect(container.querySelector('[data-pearl-incomplete]')?.textContent).toMatch(/missing: retention-suite/)
    expect(parsePearl({ ...summary, retentionTotal: '12' })).toBeNull()
    expect(parsePearl({ ...summary, retentionTotal: null, retentionPassed: 3 })).toBeNull()
  })
  it('a trial the reader found no verified receipt for is marked as a claim', async () => {
    const { PearlArenaCard, pearlOf } = await import('../src/client/spatial-components.tsx')
    const { container } = render(<PearlArenaCard pearl={pearlOf(summary, null, null, 0)} />)
    expect(container.querySelector('[data-pearl-row="trial"] dd')?.textContent).toMatch(/claimed; the reader found no verified pearl.challenge receipt/)
  })
  it('file-counted scars are not presented as enforced; no Session is its own state', async () => {
    const { PearlArenaCard, pearlOf } = await import('../src/client/spatial-components.tsx')
    const files = render(<PearlArenaCard pearl={pearlOf(null, { ok: false, reason: 'not-found' }, { ok: true, text: '{"id":"s1"}\n' })} />)
    expect(files.container.querySelector('[data-pearl-row="scars"] dd')?.textContent).toBe('1 lines in scars.jsonl (not checked against the gate)')
    cleanup()
    render(<PearlArenaCard pearl={{ kind: 'no-session' }} />)
    expect(screen.getByText(/no live Session is shown/)).toBeTruthy()
  })
})

describe('where this page runs: Mac host or Cloudflare edge, read from the host itself', () => {
  const answer = (routes: Record<string, unknown>) => vi.fn(async (input: string) =>
    (Object.hasOwn(routes, input) ? json(routes[input]) : new Response('nope', { status: 404 })))
  const health = (over: Record<string, unknown> = {}) => ({ ok: true, ready: true, runtime: 'cloudflare', macDependency: false, buildSha: '2ad2e908',
    capabilities: { head: true, mirror: true, providerDoors: { deepseek: true, anthropic: false } }, unsupported: ['eyes', 'no-tab-agent-loop'], ...over })
  it('the Mac host is said to be the Mac, and the edge is never claimed or probed from it', async () => {
    const { hostModeWords, readHostMode } = await import('../src/client/spatial-components.tsx')
    const fetchMock = answer({ '/__x6/status': { ok: true, runtime: 'local' } })
    const mode = await readHostMode(fetchMock, undefined, '127.0.0.1:4610')
    expect(mode).toEqual({ kind: 'local', host: '127.0.0.1:4610' })
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/__x6/status'])
    expect(hostModeWords(mode).pill).toBe('LOCAL MAC · 127.0.0.1:4610')
    expect(hostModeWords(mode).detail).toMatch(/not the node\.example\.invalid edge/)
  })
  it('the edge, seeded with a model door bound, says the Mac is not in the path; unseeded or doorless is NOT READY', async () => {
    const { hostModeWords, readHostMode } = await import('../src/client/spatial-components.tsx')
    const ready = await readHostMode(answer({ '/__x6/status': { ok: true, runtime: 'cloudflare' }, '/api/health': health() }), undefined, 'node.example.invalid')
    expect(ready).toMatchObject({ kind: 'cloudflare', edge: { ready: true, doorsBound: 1, doorsTotal: 2, buildSha: '2ad2e908' } })
    expect(hostModeWords(ready)).toMatchObject({ pill: 'CLOUDFLARE EDGE · node.example.invalid', tone: 'mint' })
    expect(hostModeWords(ready).detail).toMatch(/the Mac is not in the path/)
    const doorless = await readHostMode(answer({ '/__x6/status': { ok: true, runtime: 'cloudflare' },
      '/api/health': health({ capabilities: { providerDoors: { deepseek: false } } }) }), undefined, 'node.example.invalid')
    expect(hostModeWords(doorless)).toMatchObject({ pill: 'CLOUDFLARE EDGE · NOT READY', tone: 'gold' })
    const unread = await readHostMode(answer({ '/__x6/status': { ok: true, runtime: 'cloudflare' } }), undefined, 'node.example.invalid')
    expect(unread).toMatchObject({ kind: 'cloudflare', edge: null, edgeTrouble: '/api/health answered 404' })
    expect(hostModeWords(unread).tone).toBe('gold')
  })
  it('a host that does not answer, or names no runtime, is unknown, never assumed', async () => {
    const { readHostMode } = await import('../src/client/spatial-components.tsx')
    expect(await readHostMode(answer({}), undefined, 'h')).toEqual({ kind: 'unknown', host: 'h', reason: '/__x6/status answered 404' })
    expect(await readHostMode(answer({ '/__x6/status': { ok: true } }), undefined, 'h')).toEqual({ kind: 'unknown', host: 'h', reason: '/__x6/status names no runtime' })
    expect(await readHostMode(vi.fn(async () => { throw new TypeError('offline') }), undefined, 'h')).toMatchObject({ kind: 'unknown', reason: '/__x6/status did not answer' })
  })
  it('the Work view leaves the host pill to Sovereignty, and on the Mac shows no sign-in', async () => {
    const fetchMock = answer({ '/__x6/status': { ok: true, runtime: 'local' } })
    vi.stubGlobal('fetch', fetchMock)
    const sessions = { ids: ['s1'], byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }
    const { WorkSurface: Surface } = await import('../src/client/spatial/work/WorkSurface.tsx')
    const surfaceProps = {
      activeSurface: WORK_SURFACE,
      useSessions: (select: (s: typeof sessions) => unknown) => select(sessions),
      reader: { whole: async (): Promise<FileRead> => ({ ok: false, reason: 'not-found' }) },
      labels: (key: string) => (en as Record<string, string>)[key] ?? key,
      t: (key: string) => key,
    } as unknown as Parameters<typeof WorkSurface>[0]
    const { container } = render(<Surface {...surfaceProps} />)
    // The host is still asked (the edge sign-in depends on its answer); its pill lives on Sovereignty's 'Where this page runs'.
    await waitFor(() => { expect(fetchMock.mock.calls.some(([path]) => path === '/__x6/status')).toBe(true) })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(container.querySelector('[data-host-mode]')).toBeNull()
    expect(container.querySelector('[data-edge-signin]')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('Live Pearl counts the organs in her Pearl, not her seed manifest', () => {
  it('the head entries are the live count; disabled entries are counted and said', async () => {
    const { parseHeadOrgans } = await import('../src/client/spatial/aura/LiveHead.tsx')
    const entries = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`organ-${String(i)}`, { disabled: i === 0 }]))
    expect(parseHeadOrgans(JSON.stringify({ ballId: 'a'.repeat(64), epoch: 157, entries }))).toEqual({ total: 22, enabled: 21 })
    expect(parseHeadOrgans(JSON.stringify({ ballId: 'a'.repeat(64) }))).toBeNull()
    expect(parseHeadOrgans('not json')).toBeNull()
  })
})

describe('edge owner sign-in: an inline sheet that posts the signed pass to /_auth/owner', () => {
  const b64url = (value: unknown): string => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const NOW = 1_794_200_000
  const pass = (claims: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: 'EdDSA', typ: 'JWT' }): string =>
    `${b64url(header)}.${b64url({ iss: 'aukora.x61.owner', aud: 'node.example.invalid', email: 'owner@example.test', nbf: NOW - 60, exp: NOW + 3600, ...claims })}.c2ln`
  it('an edge that wants the owner pass is SIGNED-OUT, not unknown; any other 401 stays unknown', async () => {
    const { hostModeWords, readHostMode } = await import('../src/client/spatial-components.tsx')
    const refuse = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 401, headers: { 'content-type': 'application/json' } }))
    const out = await readHostMode(refuse({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }), undefined, 'node.example.invalid')
    expect(out).toEqual({ kind: 'signed-out', host: 'node.example.invalid' })
    expect(hostModeWords(out)).toMatchObject({ pill: 'CLOUDFLARE EDGE · SIGN IN', tone: 'gold' })
    expect(await readHostMode(refuse({ ok: false, code: 'SOMETHING_ELSE' }), undefined, 'h')).toEqual({ kind: 'unknown', host: 'h', reason: '/__x6/status answered 401' })
  })
  it('checks the pass the way the edge reads it, before sending, and says why in plain words', async () => {
    const { checkOwnerPass } = await import('../src/client/spatial-components.tsx')
    const host = 'node.example.invalid'
    expect(checkOwnerPass(pass(), host, NOW)).toEqual({ ok: true })
    expect(checkOwnerPass(`  ${pass()}\n`, host, NOW)).toEqual({ ok: true })
    expect(checkOwnerPass('not a pass', host, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/three parts/) as unknown })
    expect(checkOwnerPass(pass({}, { alg: 'HS256', typ: 'JWT' }), host, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/Ed25519/) as unknown })
    expect(checkOwnerPass(pass({ iss: 'someone' }), host, NOW)).toMatchObject({ ok: false })
    expect(checkOwnerPass(pass({ aud: 'legacy-node.example.invalid' }), host, NOW)).toMatchObject({ reason: 'That pass is for legacy-node.example.invalid, not node.example.invalid.' })
    expect(checkOwnerPass(pass({ exp: NOW - 1 }), host, NOW)).toMatchObject({ reason: expect.stringMatching(/run out/) as unknown })
    expect(checkOwnerPass(pass({ nbf: NOW + 60 }), host, NOW)).toMatchObject({ reason: expect.stringMatching(/not valid yet/) as unknown })
    // Round 34: the edge takes a pass of up to 24 hours, and not one second more.
    expect(checkOwnerPass(pass({ nbf: NOW - 60, exp: NOW - 60 + 24 * 3600 }), host, NOW)).toEqual({ ok: true })
    const tooLong = pass({ nbf: NOW - 60, exp: NOW - 60 + 24 * 3600 + 1 })
    expect(checkOwnerPass(tooLong, host, NOW)).toMatchObject({ reason: expect.stringMatching(/24 hours/) as unknown })
    expect(checkOwnerPass(pass({ exp: '9999999999' }), host, NOW)).toMatchObject({ reason: expect.stringMatching(/time window/) as unknown })
  })
  it('posts the raw pass as application/jwt to this host only, and never echoes it back', async () => {
    const { sendOwnerPass } = await import('../src/client/spatial-components.tsx')
    const fetchMock = vi.fn(async () => json({ ok: true, expires: NOW + 3600 }))
    const token = pass()
    expect(await sendOwnerPass(fetchMock, `${token}\n`)).toEqual({ ok: true, expires: NOW + 3600 })
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/_auth/owner')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/jwt' }, body: token })
    const refused = await sendOwnerPass(vi.fn(async () => new Response(JSON.stringify({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }), { status: 401 })), token)
    expect(refused).toEqual({ ok: false, reason: 'The edge did not accept that pass (wrong signer, owner, host, or it has run out).' })
    expect(JSON.stringify(refused)).not.toContain(token)
    expect(await sendOwnerPass(vi.fn(async () => { throw new TypeError('offline') }), token)).toMatchObject({ ok: false, reason: expect.stringMatching(/did not answer/) as unknown })
  })
  it('the sheet is inline (no dialog); a bad pass is refused without sending; a good one signs in and clears the field', async () => {
    const { EdgeOwnerSignIn } = await import('../src/client/spatial-components.tsx')
    const fetchMock = vi.fn(async () => json({ ok: true, expires: NOW + 3600 }))
    const onSignedIn = vi.fn()
    const { container } = render(<EdgeOwnerSignIn host="node.example.invalid" fetchImpl={fetchMock} now={() => NOW} onSignedIn={onSignedIn} />)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    const field = screen.getByLabelText('Owner pass') as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.change(field, { target: { value: pass({ exp: NOW - 1 }) } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(container.querySelector('[data-edge-signin]')?.getAttribute('data-edge-signin')).toBe('refused')
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: pass() } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => { expect(onSignedIn).toHaveBeenCalledTimes(1) })
    expect(field.value).toBe('')
    expect(container.querySelector('[data-edge-signin]')?.getAttribute('data-edge-signin')).toBe('signed-in')
  })
  it('the Work surface shows the sheet under its header only while the edge wants the pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }), { status: 401 })))
    const sessions = { ids: ['s1'], byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }
    const { WorkSurface: Surface } = await import('../src/client/spatial/work/WorkSurface.tsx')
    const surfaceProps = {
      activeSurface: WORK_SURFACE,
      useSessions: (select: (s: typeof sessions) => unknown) => select(sessions),
      reader: { whole: async (): Promise<FileRead> => ({ ok: false, reason: 'not-found' }) },
      labels: (key: string) => (en as Record<string, string>)[key] ?? key,
      t: (key: string) => key,
    } as unknown as Parameters<typeof WorkSurface>[0]
    const { container } = render(<Surface {...surfaceProps} />)
    await waitFor(() => { expect(container.querySelector('[data-edge-signin="idle"]')).not.toBeNull() })
    // The sign-in sheet is the live control and stays; the 'CLOUDFLARE EDGE · SIGN IN' pill is Sovereignty's (Round 25).
    expect(container.querySelector('[data-host-mode]')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('Pearl card: coarse-to-fine counts and receipt checkpoint coverage', () => {
  const summary = {
    retentionTotal: 18, retentionPassed: 18, scarsCount: 3, lastChallengeAt: '2026-11-09T12:00:00.000Z', lastWinnerLabel: 'full',
    candidateCount: 3, authorityTier: 'self-attested', status: 'complete', gaps: [],
    candidatesTested: 3, coarsePassCount: 2, finePassCount: 1, negativeControlRejected: true,
    checkpoint: { count: 5, lastReceiptCount: 85, receiptTotal: 87, lastSigned: true },
  }
  it('shows tested, coarse and fine passes, the refused control, and which receipts the last checkpoint covers', async () => {
    const { PearlArenaCard, pearlOf } = await import('../src/client/spatial-components.tsx')
    const { container } = render(<PearlArenaCard pearl={pearlOf(summary, null, null)} />)
    expect(container.querySelector('[data-pearl-row="retention"] dd')?.textContent).toBe('18/18 passed')
    expect(container.querySelector('[data-pearl-row="tournament"] dd')?.textContent)
      .toBe('3 candidates tested · coarse 2 passed · fine 1 passed · reward-hack control refused')
    expect(container.querySelector('[data-pearl-row="checkpoint"] dd')?.textContent)
      .toBe('checkpoint 5 covers 85 of 87 receipts · signature verified')
  })
  it('never shows inconsistent counts; an unsigned checkpoint says so; older challenges show no tournament row', async () => {
    const { PearlArenaCard, parsePearl, pearlOf } = await import('../src/client/spatial-components.tsx')
    expect(parsePearl({ ...summary, finePassCount: 3 }))
      .toMatchObject({ candidatesTested: null, coarsePassCount: null, finePassCount: null })
    expect(parsePearl({ ...summary, coarsePassCount: 4 })?.candidatesTested).toBeNull()
    expect(parsePearl({ ...summary, checkpoint: { count: 5, lastReceiptCount: 85, receiptTotal: 87 } })?.checkpoint).toBeNull()
    const unsigned = { ...summary, checkpoint: { ...summary.checkpoint, lastSigned: false }, negativeControlRejected: false }
    const { container } = render(<PearlArenaCard pearl={pearlOf(unsigned, null, null)} />)
    expect(container.querySelector('[data-pearl-row="checkpoint"] dd')?.textContent).toMatch(/signature NOT verified$/)
    expect(container.querySelector('[data-pearl-row="tournament"] dd')?.textContent).toMatch(/reward-hack control NOT refused$/)
    cleanup()
    const older = render(<PearlArenaCard pearl={pearlOf({ ...summary, candidatesTested: undefined, coarsePassCount: undefined,
      finePassCount: undefined, negativeControlRejected: undefined, checkpoint: undefined }, null, null)} />)
    expect(older.container.querySelector('[data-pearl-row="tournament"]')).toBeNull()
    expect(older.container.querySelector('[data-pearl-row="checkpoint"]')).toBeNull()
  })
})

// ── Round 25: Work shows work and authority; what other surfaces show, or nothing fills, is gone; the rest folds ─────
describe('the Work view keeps work and authority in sight and folds the rest', () => {
  const HOUR = 3_600_000
  const sessions = { ids: ['s1'], byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }
  const head = { ballId: 'ab'.repeat(32), parentBallId: 'cd'.repeat(32), epoch: 162 }
  const mount = (disk: Record<string, string>) => {
    const props = {
      activeSurface: WORK_SURFACE,
      useSessions: (select: (s: typeof sessions) => unknown) => select(sessions),
      reader: {
        whole: async (_s: unknown, path: string): Promise<FileRead> =>
          disk[path] === undefined ? { ok: false, reason: 'not-found' } : { ok: true, text: disk[path] },
      },
      labels: (key: string) => (en as Record<string, string>)[key] ?? key,
      t: (key: string) => key,
    } as unknown as Parameters<typeof WorkSurface>[0]
    return render(<WorkSurface {...props} />)
  }
  /** A page bridge as the app installs it, whose verified read never settles: rows come from her file. */
  const installBridge = () => {
    const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>, _signal: AbortSignal) => ({ kind: 'ok', value: { ok: true } }))
    const read = { current: () => ({ kind: 'loading', refreshing: false }), refresh: () => {}, stop: () => {},
      subscribe: (l: (p: unknown) => void) => { l(read.current()); return () => {} } }
    vi.stubGlobal('__AUKORA_SUPERAGENT__', { version: 1, createRead: () => read, callTool })
    return { callTool }
  }
  const state = (over: Record<string, unknown>) => JSON.stringify({ mandates: [], tickets: [], assignments: [], attention: [], ...over })

  it('no host pill, Survivor lines, Memory DAG row, periphery strip, Pearl card, false passkey paragraph or outbox counts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (input === '/__x6/status' ? json({ ok: true, runtime: 'local' })
      : new Response('nope', { status: 404 }))))
    const { container } = mount({
      [BALL_HEAD_PATH]: JSON.stringify(head),
      [MEMORY_DAG_HEAD_PATH]: JSON.stringify({ heads: [ROOT_ID], count: 1, updatedAt: 1794441600000 }),
      [`${MEMORY_DAG_DIR}/${ROOT_ID}.json`]: JSON.stringify(ROOT),
      [SUPERAGENT_STATE_PATH]: state({ outbox: [{ status: 'pending' }, { status: 'sent' }] }),
    })
    await waitFor(() => { expect(container.querySelector('[data-work-recall="verified"]')).toBeTruthy() })
    for (const gone of ['[data-host-mode]', '[data-work-survivor]', '[data-work-dag]', '[data-aura-strip]', '[data-pearl-arena]',
      '[data-work-authority]', '[data-work-outbox]']) expect([gone, container.querySelector(gone)]).toEqual([gone, null])
    expect(container.textContent).not.toMatch(/no passkey approval yet|Outbox|PERIPHERY/)
    // The verified recall walk, the Pearl lineage and the read time sit in ONE closed fold; the selected Pearl stays in sight.
    const fold = container.querySelector('[data-work-details]')
    expect(fold?.tagName).toBe('DETAILS')
    expect((fold as HTMLDetailsElement | null)?.open).toBe(false)
    expect(container.querySelector('[data-work-recall]')?.closest('details')).toBe(fold)
    expect(container.querySelector('[data-work-lineage]')?.closest('details')).toBe(fold)
    // Round 27: that fold is the closed Her records card. Its head and receipt rows are inside it, its one-line head says
    // the selected Pearl in sight, nothing is wrong so nothing is said above the cards, and the wake card stays open.
    expect(container.querySelector('[data-work-head]')?.closest('details')).toBe(fold)
    expect(container.querySelector('[data-work-receipts]')?.closest('details')).toBe(fold)
    expect(fold?.querySelector(':scope > summary')?.textContent).toContain(`work.epoch ${String(head.epoch)}`)
    expect(container.querySelector('[data-work-wake]')?.closest('details')).toBeNull()
  })

  it('a memory DAG that does not verify stays in sight, outside the fold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const { container } = mount({
      [MEMORY_DAG_HEAD_PATH]: JSON.stringify({ heads: ['e'.repeat(64)], count: 1, updatedAt: 1794441600000 }),
      [SUPERAGENT_STATE_PATH]: state({}),
    })
    await waitFor(() => { expect(container.querySelector('[data-work-recall="broken"]')).toBeTruthy() })
    // Round 27: the row is in the closed Her records card, and the same words stand in sight above the cards.
    const said = container.querySelector('[data-work-trouble="recall"]')
    expect(said?.closest('details')).toBeNull()
    expect(said?.getAttribute('role')).toBe('status')
    expect(said?.textContent).toContain(en['recall.broken'])
    expect(container.querySelector('[data-work-recall]')?.textContent).toContain(en['recall.broken'])
  })

  it('it is Work, background missions, not authority; an unread head and an absent bridge are said in sight', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const { container } = mount({ [SUPERAGENT_STATE_PATH]: state({}) })
    await waitFor(() => { expect(container.querySelector('[data-work-empty]')).toBeTruthy() })
    expect(container.querySelector('.ak-header__title')?.textContent).toBe('WORK')
    expect(container.querySelector('.ak-header__eyebrow')?.textContent).toBe('BACKGROUND MISSIONS · AUTONOMOUS WORK')
    expect(container.querySelector('.ak-header')?.textContent).not.toMatch(/AUTHORITY|COORDINATION/u)
    // Her records is one closed card; what is wrong with them stands above the cards as status lines, never in the fold.
    await waitFor(() => { expect(container.querySelector('[data-work-trouble="head"]')?.textContent).toMatch(/not-found/u) })
    for (const key of ['head', 'receipts']) {
      const said = container.querySelector(`[data-work-trouble="${key}"]`)
      expect([key, said?.closest('details') ?? null, said?.getAttribute('role')]).toEqual([key, null, 'status'])
    }
    expect(container.querySelector('[data-work-trouble="receipts"]')?.textContent).toContain('work.bridge.absent')
    const records = container.querySelector('[data-work-details]') as HTMLDetailsElement | null
    expect(records?.open).toBe(false)
    expect(records?.querySelector(':scope > summary .ak-pill')?.textContent).toBe('CHECK ABOVE')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('empty lists draw no sections and no "None." lines; one line says nothing is listed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const { container } = mount({ [SUPERAGENT_STATE_PATH]: state({}) })
    await waitFor(() => { expect(container.querySelector('[data-work-empty]')?.textContent).toBe(en.empty) })
    expect(container.querySelectorAll('h3')).toHaveLength(0)
    expect(container.textContent).not.toContain('work.none')
    // "Could not look" is still its own line, never the empty one.
    cleanup()
    const unread = mount({})
    await waitFor(() => { expect(unread.container.querySelector('[data-work-graph-unreadable]')?.textContent).toMatch(/not-found/) })
    expect(unread.container.querySelector('[data-work-empty]')).toBeNull()
  })

  it('the installed app bridge publishes only createRead and callTool; a page with no tunnel still says so', async () => {
    const { installWorkBridge } = await import('../../../../apps/web/src/spatial/work-bridge.ts')
    const { workBridge, WORK_BRIDGE_GLOBAL } = await import('../src/client/spatial/work/bridge.ts')
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response('nope', { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    installWorkBridge()
    try {
      const installed = (globalThis as Record<string, unknown>)[WORK_BRIDGE_GLOBAL] as Record<string, unknown>
      expect(Object.keys(installed).sort()).toEqual(['callTool', 'createRead', 'version'])
      expect('confirmMandate' in installed).toBe(false)
      expect(workBridge()).toBe(installed)
      // The owner public key is still read at install, and nothing asks the host to sign.
      expect(fetch.mock.calls.map(call => call[0])).toEqual(['/_host/owner-key'])
      const bridge = workBridge()
      expect(await bridge?.callTool('auma_superagent', { action: 'status' }, new AbortController().signal))
        .toEqual({ kind: 'control-unavailable' })
    } finally {
      Reflect.deleteProperty(globalThis, WORK_BRIDGE_GLOBAL)
    }
  })
  it('on the Mac, which takes no owner grant, no passkey opener is offered and one line says where to approve', async () => {
    installBridge()
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (input === '/__x6/status' ? json({ ok: true, runtime: 'local' })
      : input === '/_host/aumlok/status' ? json({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), blockers: [] })
        : new Response('nope', { status: 404 }))))
    const now = Date.now()
    const { container } = mount({
      [BALL_HEAD_PATH]: JSON.stringify(head),
      [SUPERAGENT_STATE_PATH]: state({
        mandates: [{ id: 'm-new', title: 'Notes', strength: 'inferred', confirmed: false, scope: { organs: ['auma-notes'], expiresAt: now + HOUR } }],
      }),
    })
    await waitFor(() => { expect(container.querySelector('[data-work-no-passkey]')?.textContent).toBe(`${en['passkey.none']}: ${en['passkey.why.mac']}`) })
    expect(container.querySelector('[data-work-confirm]')).toBeNull()
  })
  it('a mandate: its ticket and "expired" on its row, scope in its closed fold, and no owner-key or tab confirm', async () => {
    const { callTool } = installBridge()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const now = Date.now()
    const { container } = mount({
      [BALL_HEAD_PATH]: JSON.stringify(head),
      [SUPERAGENT_STATE_PATH]: state({
        mandates: [
          { id: 'm-old', title: 'Old probe', strength: 'explicit', confirmed: false, scope: { organs: ['auma-notes'], expiresAt: now - HOUR } },
          { id: 'm-new', title: 'Notes', strength: 'inferred', confirmed: false, scope: { organs: ['auma-notes'], expiresAt: now + HOUR } },
        ],
        tickets: [
          { id: 't-old', mandateId: 'm-old', title: 'Old probe', state: 'open' },
          { id: 't-new', mandateId: 'm-new', title: 'Notes', state: 'open' },
          { id: 't-loose', mandateId: 'm-gone', title: 'Orphan', state: 'open' },
        ],
      }),
    })
    await waitFor(() => { expect(container.querySelector('[data-work-mandates]')).toBeTruthy() })
    // No passkey door here (this host gave no AUMLOK status): no opener at all, and the open mandate says why in one line.
    await waitFor(() => { expect(container.querySelector('[data-work-no-passkey]')).toBeTruthy() })
    expect(container.querySelector('[data-work-confirm]')).toBeNull()
    expect(container.querySelectorAll('[data-work-no-passkey]')).toHaveLength(1)
    expect(container.querySelector('[data-work-no-passkey]')?.textContent).toBe(`${en['passkey.none']}: ${en['passkey.why.unread']}`)
    expect(container.textContent).not.toMatch(/owner key and confirm|tab confirmation|Confirm from this tab/)
    expect(callTool).not.toHaveBeenCalled()
    // The row says expired; the ticket is on its mandate's row, not in a Tickets list of its own.
    const old = container.querySelector('[data-work-mandate-head="m-old"]')
    expect(old?.querySelector('[data-work-expired]')?.textContent).toBe(en['mandate.expired'])
    expect(container.querySelector('[data-work-mandate="m-old"] [data-work-ticket="t-old"]')?.textContent).toBe(` · ${en['mandate.ticket']} open`)
    expect(container.querySelector('[data-work-mandate-head="m-new"] [data-work-expired]')).toBeNull()
    // Only a ticket whose mandate is not listed keeps a row of its own.
    expect([...container.querySelectorAll('[data-work-tickets] li')].map(li => li.textContent)).toEqual(['Orphan · open · t-loose'])
    // Scope JSON, expiry and ids are in the mandate's own closed fold.
    const fold = container.querySelector('[data-work-mandate-details="m-old"]') as HTMLDetailsElement | null
    expect(fold?.open).toBe(false)
    expect(fold?.querySelector('[data-work-scope] code')?.textContent).toContain('"organs":["auma-notes"]')
    expect(container.querySelector('[data-work-mandate-head="m-old"]')?.textContent).not.toContain('auma-notes')
  })

  it('Stop says what her organ does: the ticket and its running assignments end in her records, nothing reaches an executor', async () => {
    const { callTool } = installBridge()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const { container } = mount({
      [SUPERAGENT_STATE_PATH]: state({
        mandates: [{ id: 'm1', title: 'Deploy', strength: 'explicit', confirmed: true, confirmedAt: 1, scope: { organs: ['auma-notes'] } }],
        tickets: [{ id: 't1', mandateId: 'm1', title: 'Deploy', state: 'open' }],
        assignments: [{ id: 'asg_1', ticketId: 't1', executor: 'cloudflare-do', state: 'running', reports: [] }],
      }),
    })
    await waitFor(() => { expect(container.querySelector('[data-work-stop="t1"]')).toBeTruthy() })
    fireEvent.click(container.querySelector('[data-work-stop="t1"]') as Element)
    const ask = container.querySelector('[data-work-stop-ask="t1"]')?.textContent ?? ''
    expect(ask).toContain(en['stop.ask'])
    expect(ask).toMatch(/ends it and its running assignments in her records/)
    expect(ask).not.toMatch(/only flagged/)
    fireEvent.click(screen.getByText('work.stop.yes'))
    await waitFor(() => { expect(container.querySelector('[data-work-outcome="ok"]')?.textContent).toBe(en['stop.done']) })
    expect(callTool).toHaveBeenCalledWith('auma_superagent', { action: 'stop', ticketId: 't1' }, expect.anything())
  })

  it('the owner-confirmed note says what is true now: a signature that verifies against the owner key this host publishes', () => {
    expect(en['owner.note']).not.toMatch(/Mac|click in this tab|x6_repo/)
    expect(en['owner.note']).toMatch(/verifies against the owner key this host publishes/)
    expect(en['stop.ask']).not.toMatch(/flagged/)
  })
})
