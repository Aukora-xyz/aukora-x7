/**
 * The page carries the memory frames between the edge's bridge and her home. The REAL controller.mjs over
 * a fake tab door; her worker's `/__x6__/voice-memory` route is a fake that answers as storage/voice-memory.ts does (that
 * route's own rules are proven in packages/experimental/webworker-runtime/tests/x6/voice-memory.spec.ts and
 * voice-fast-tools.spec.ts). After `ready` the page sends `memory_have` with her home's head; each `memory` frame is ONE
 * append, answered by one `memory_ack` or one `memory_nack` with her home's head; nothing waits on it. No network.
 */
import { describe, expect, it } from 'vitest'

type Frame = Record<string, unknown> & { t: string }
type MemoryBody = { action: 'head' } | { action: 'append'; items: unknown[] }
type MemoryAnswer = { ok: boolean; code?: string; seq: number; digest: string } | null

const scripts = new URL('../scripts/stock-apps/managed-voice/', import.meta.url)
const { createManagedConversation } = await import(new URL('controller.mjs', scripts).href) as {
  createManagedConversation: (deps: Record<string, unknown>) => { start: () => Promise<string>; stop: () => void }
}
const policy = await import(new URL('policy.mjs', scripts).href) as { MANAGED_VOICE: { frameBytes: number; memoryFrameBytes: number } }
const live = await import(new URL('../public/app/genesis-live.js', import.meta.url).href) as {
  createGenesisLive: (deps: Record<string, unknown>) => { voiceMemory: (body: MemoryBody) => Promise<MemoryAnswer> }
  VOICE_MEMORY_PATH: string
}

const ZERO = '0'.repeat(64)
const D = (n: number) => n.toString(16).padStart(2, '0').repeat(32)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => { setTimeout(r, 0) }) }
const item = (seq: number, pad = 0) => ({ record: { v: 1, seq, prev: D(seq - 1), kind: 'exchange', pad: 'x'.repeat(pad) }, words: { seq, salt: '1'.repeat(32), heard: 'h', said: 's' } })

function call(memory: ((body: MemoryBody) => Promise<MemoryAnswer>) | null, runTurn: () => Promise<unknown> = async () => ({ ok: true })) {
  type Door = {
    sent: Frame[]
    readyState: number
    onopen: (() => void) | null
    onmessage: ((event: { data: unknown }) => void) | null
    send: (text: string) => void
    close: () => void
  }
  const sockets: Door[] = []
  let next = 0
  const timers = { setTimeout: () => ++next, clearTimeout: () => {}, setInterval: () => ++next, clearInterval: () => {} }
  const session = { endSession: async () => {}, setMicMuted: () => {}, getInputVolume: () => 0, getOutputVolume: () => 0,
    sendUserMessage: () => {}, sendUserActivity: () => {}, getId: () => 'conv_1' }
  const controller = createManagedConversation({
    timers, ...(memory ? { memory } : {}), runTurn,
    request: async () => json({ token: 'p'.repeat(64), maxDurationSeconds: 1200 }),
    startSession: async (config: { onConversationCreated: (value: unknown) => void; onConnect: () => void }) => {
      config.onConversationCreated(session)
      config.onConnect()
      return session
    },
    openBridge: () => {
      const socket: Door = { sent: [], readyState: 0, onopen: null, onmessage: null,
        send(text: string) { this.sent.push(JSON.parse(text) as Frame) }, close() { this.readyState = 3 } }
      sockets.push(socket)
      return socket
    },
  })
  const connect = async () => {
    expect(await controller.start()).toBe('started')
    const socket = sockets.at(-1)
    if (!socket) throw new Error('no tab door')
    socket.readyState = 1
    socket.onopen?.()
    socket.onmessage?.({ data: JSON.stringify({ t: 'ready', conv: 'conv_1', maxDurationSeconds: 1200 }) })
    return socket
  }
  return { controller, connect }
}
const memoryFrames = (sent: Frame[]) => sent.filter(frame => frame.t.startsWith('memory'))
type Receiver = { onmessage: ((event: { data: unknown }) => void) | null }
const deliver = (socket: Receiver, frame: unknown) => { socket.onmessage?.({ data: JSON.stringify(frame) }) }

describe('the page carries the memory frames', () => {
  it('ready leads to memory_have with her home\'s head (seq 0 and 64 zeros for an empty home)', async () => {
    for (const head of [{ ok: true, seq: 0, digest: ZERO }, { ok: true, seq: 7, digest: D(7) }]) {
      const asked: MemoryBody[] = []
      const { connect } = call(async (body) => { asked.push(body); return head })
      const socket = await connect()
      await flush()
      expect(asked).toEqual([{ action: 'head' }])
      expect(memoryFrames(socket.sent)).toEqual([{ t: 'memory_have', seq: head.seq, digest: head.digest }])
    }
  })

  it('a memory frame leads to ONE append with its items and ONE ack with her home\'s new head', async () => {
    const asked: MemoryBody[] = []
    const { connect } = call(async (body) => { asked.push(body); return body.action === 'head' ? { ok: true, seq: 1, digest: D(1) } : { ok: true, seq: 3, digest: D(3) } })
    const socket = await connect()
    await flush()
    const items = [item(2), item(3)]
    deliver(socket, { t: 'memory', items })
    await flush()
    expect(asked).toEqual([{ action: 'head' }, { action: 'append', items }])
    expect(memoryFrames(socket.sent).slice(1)).toEqual([{ t: 'memory_ack', seq: 3, digest: D(3) }])
  })

  it('a nack carries her home\'s head: GAP and FORK as they are; any other refusal is WRITE_FAILED', async () => {
    for (const [code, sentCode] of [['GAP', 'GAP'], ['FORK', 'FORK'], ['COMMITMENT', 'WRITE_FAILED'], ['ITEM_INVALID', 'WRITE_FAILED'], ['WRITE_FAILED', 'WRITE_FAILED']]) {
      const { connect } = call(async (body): Promise<MemoryAnswer> => (body.action === 'head'
        ? { ok: true, seq: 4, digest: D(4) } : { ok: false, code: String(code), seq: 4, digest: D(4) }))
      const socket = await connect()
      await flush()
      deliver(socket, { t: 'memory', items: [item(9)] })
      await flush()
      expect(memoryFrames(socket.sent).slice(1)).toEqual([{ t: 'memory_nack', code: sentCode, seq: 4, digest: D(4) }])
    }
  })

  it('a write that does not answer is WRITE_FAILED with the head read again; it is not retried in a loop, the next frame tries again', async () => {
    let appends = 0
    const { connect } = call(async (body) => {
      if (body.action === 'head') return { ok: true, seq: 2, digest: D(2) }
      appends += 1
      throw new Error('worker gone')
    })
    const socket = await connect()
    await flush()
    deliver(socket, { t: 'memory', items: [item(3)] })
    await flush()
    await flush()
    expect(appends).toBe(1)
    expect(memoryFrames(socket.sent).slice(1)).toEqual([{ t: 'memory_nack', code: 'WRITE_FAILED', seq: 2, digest: D(2) }])
    deliver(socket, { t: 'memory', items: [item(3)] })
    await flush()
    expect(appends).toBe(2)
  })

  it('frames outside the shape are not appended; a memory frame up to 48,000 bytes is read (above the 8 KiB of other frames)', async () => {
    const asked: MemoryBody[] = []
    const { connect } = call(async (body) => { asked.push(body); return { ok: true, seq: 1, digest: D(1) } })
    const socket = await connect()
    await flush()
    for (const bad of [{ t: 'memory' }, { t: 'memory', items: [] }, { t: 'memory', items: 'x' }, { t: 'memory', items: Array.from({ length: 9 }, (_, i) => item(i + 2)) },
      { t: 'memory', items: [null] }]) deliver(socket, bad)
    await flush()
    expect(asked.filter(body => body.action === 'append')).toEqual([])
    const big = { t: 'memory', items: [item(2, 20_000)] }
    expect(JSON.stringify(big).length).toBeGreaterThan(policy.MANAGED_VOICE.frameBytes)
    expect(policy.MANAGED_VOICE.memoryFrameBytes).toBe(48_000)
    deliver(socket, big)
    await flush()
    expect(asked.filter(body => body.action === 'append')).toHaveLength(1)
    deliver(socket, { t: 'memory', items: [item(3, 48_000)] })
    await flush()
    expect(asked.filter(body => body.action === 'append')).toHaveLength(1)
  })

  it('nothing waits on her home: a turn runs while an append is still open', async () => {
    let turns = 0
    const { connect } = call(async body => (body.action === 'head' ? { ok: true, seq: 1, digest: D(1) } : new Promise<MemoryAnswer>(() => {})),
      async () => { turns += 1; return { ok: true } })
    const socket = await connect()
    await flush()
    deliver(socket, { t: 'memory', items: [item(2)] })
    deliver(socket, { t: 'turn', turn: 'eleven:conv_1:5', transcript: 'what did we say yesterday' })
    await flush()
    expect(turns).toBe(1)
  })

  it('review frames 1: an unreadable home (ok:false HOME_UNREADABLE, seq 0) is never told to the edge as an empty one', async () => {
    const UNREADABLE = { ok: false, code: 'HOME_UNREADABLE', seq: 0, digest: ZERO }
    const { connect } = call(async () => UNREADABLE)
    const socket = await connect()
    await flush()
    expect(memoryFrames(socket.sent)).toEqual([])
    deliver(socket, { t: 'memory', items: [item(1)] })
    await flush()
    await flush()
    expect(memoryFrames(socket.sent)).toEqual([])
  })

  it('review frames 2: a head read that failed at ready is tried again (after her next turn), and memory_have is sent once', async () => {
    let heads = 0
    const { connect } = call(async (body) => {
      if (body.action !== 'head') return { ok: true, seq: 3, digest: D(3) }
      heads += 1
      if (heads === 1) throw new Error('worker restarting')
      return { ok: true, seq: 2, digest: D(2) }
    })
    const socket = await connect()
    await flush()
    expect(memoryFrames(socket.sent)).toEqual([])
    deliver(socket, { t: 'turn', turn: 'eleven:conv_1:5', transcript: 'hello again' })
    await flush()
    await flush()
    expect(memoryFrames(socket.sent)).toEqual([{ t: 'memory_have', seq: 2, digest: D(2) }])
    deliver(socket, { t: 'turn', turn: 'eleven:conv_1:6', transcript: 'and once more' })
    await flush()
    await flush()
    expect(memoryFrames(socket.sent)).toEqual([{ t: 'memory_have', seq: 2, digest: D(2) }])
    expect(heads).toBe(2)
  })

  it('without a memory route the page sends nothing about memory', async () => {
    const { connect } = call(null)
    const socket = await connect()
    deliver(socket, { t: 'memory', items: [item(2)] })
    await flush()
    expect(memoryFrames(socket.sent)).toEqual([])
  })

  it('genesis-live voiceMemory posts to her worker\'s route and answers its body (null when it cannot)', async () => {
    const posts: Array<{ path: string; body: unknown }> = []
    const transport = {
      fetch: async (path: string, init: { body: string }) => {
        posts.push({ path, body: JSON.parse(init.body) as unknown })
        return json({ ok: true, seq: 0, digest: ZERO })
      },
    }
    const storage = { getItem: () => null, setItem: () => {} }
    const g = live.createGenesisLive({ transport: Promise.resolve(transport), nativeFetch: async () => json({}), storage })
    expect(await g.voiceMemory({ action: 'head' })).toEqual({ ok: true, seq: 0, digest: ZERO })
    expect(posts).toEqual([{ path: live.VOICE_MEMORY_PATH, body: { action: 'head' } }])
    expect(live.VOICE_MEMORY_PATH).toBe('/api/__x6__/voice-memory')
    const down = live.createGenesisLive({ transport: Promise.resolve({ fetch: async () => { throw new Error('gone') } }), nativeFetch: async () => json({}),
      storage: { getItem: () => null, setItem: () => {} } })
    expect(await down.voiceMemory({ action: 'head' })).toBe(null)
  })
})
