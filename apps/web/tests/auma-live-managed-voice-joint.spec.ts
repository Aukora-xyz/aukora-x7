/**
 * THE MANAGED VOICE, BOTH HALVES TOGETHER.
 * On the page side: the REAL session controller (managed-voice/controller.mjs) and the REAL governed turn
 * (managed-voice/governed-turn.mjs) running her turn through the REAL genesis-live.js, with a fake SDK session and a
 * fake governed session that streams her text in pieces. On the edge side: the REAL Worker entry and the REAL
 * VoiceBridgeDO with HEAD's REAL turn journal (deploy/cloudflare/src/__tests__/voice-bridge-fakes.mjs), and the fake
 * provider that signs its own JWT. Between them, an in-memory socket pair carrying exactly the bytes each side sends:
 * no frame is mocked between the two halves, and the page's requests (managed_session, barge_in) go to the real Worker.
 * Every case ends by checking that the bridge holds no conversation, no socket, no journal write and no timer.
 */
import { describe, expect, it } from 'vitest'

type Frame = Record<string, unknown> & { t: string }
type AgentFrame = { type: string; content: string; event_id: number; is_final: boolean }
type Row = Record<string, unknown> & { turnId: string }
type EdgeSocket = {
  closedCode: number | null
  received: string[]
  send: (data: string) => void
  close: (code?: number) => void
  json: (value: unknown) => void
  frames: () => Array<Record<string, unknown>>
  addEventListener: (type: string, fn: (event: { data?: unknown }) => void) => void
}
type Empty = { conversations: number; sockets: number; writes: number; timers: number }
type Edge = {
  clock: { now: () => number; advance: (ms: number) => void }
  calls: { journal: Array<Record<string, unknown>>; provider: Array<{ url: string }> }
  send: (request: Request) => Promise<Response>
  openTab: (extra?: { path?: string }) => Promise<Response & { webSocket: EdgeSocket }>
  openProvider: () => Promise<Response & { webSocket: EdgeSocket }>
  rows: () => Promise<Row[]>
  empty: () => Empty
  settle: () => Promise<void>
  readonly bridgeBuilt: boolean
  readonly bridge: { counts: Record<string, number> }
}
type Session = {
  endSession: () => Promise<void>
  setMicMuted: (muted: boolean) => void
  getInputVolume: () => number
  getOutputVolume: () => number
  sendUserMessage: (text: string) => void
  sendUserActivity: () => void
  getId: () => string
}
type SessionConfig = Record<string, unknown> & {
  onConversationCreated: (value: Session) => void
  onConnect: () => void
  onInterruption: () => void
  onMessage: (message: Record<string, unknown>) => void
}
type Controller = { start: () => Promise<string>; stop: () => void; readonly state: string; readonly openTurns: number }
type Turn = { turnId: string; transcript: string; signal: AbortSignal; say: (text: string) => void }

const fakes = await import(new URL('../../../deploy/cloudflare/src/__tests__/voice-bridge-fakes.mjs', import.meta.url).href) as {
  fixture: (options?: Record<string, unknown>) => Edge
  transcript: (eventId: number, text: string) => Record<string, unknown>
  agentFrames: (socket: EdgeSocket) => AgentFrame[]
  ORIGIN: string
}
const bridgeDo = await import(new URL('../../../deploy/cloudflare/src/voice-bridge-do.mjs', import.meta.url).href) as { LOST_PLACE: string; PROVIDER_HOLD_MS: number }
const scripts = new URL('../scripts/stock-apps/managed-voice/', import.meta.url)
const { createManagedConversation } = await import(new URL('controller.mjs', scripts).href) as {
  createManagedConversation: (deps: Record<string, unknown>) => Controller
}
const { createGovernedTurnRunner } = await import(new URL('governed-turn.mjs', scripts).href) as {
  createGovernedTurnRunner: (deps: Record<string, unknown>) => (turn: Turn) => Promise<{ ok: boolean; code?: string }>
}
const policy = await import(new URL('policy.mjs', scripts).href) as { LINES: Record<string, string>; REFUSAL_LINES: Record<string, string> }
const live = await import(new URL('../public/app/genesis-live.js', import.meta.url).href) as {
  createGenesisLive: (deps: Record<string, unknown>) => { bridgedSpokenTurn: (turn: Record<string, unknown>) => Promise<unknown> }
  VOICE_UNCONFIRMED_SAY: string
}
const { makeDirectiveFilter } = await import(new URL('../public/app/field-directives.js', import.meta.url).href) as {
  makeDirectiveFilter: (apply: (tag: string) => void) => { push: (text: string) => string; flush: () => string }
}

// The two memory halves were built in two checkouts. This spec joins them: her home's
// REAL store (webworker-runtime/src/storage/voice-memory.ts over an in-memory file map) behind the REAL controller, and
// the REAL bridge, with no memory frame mocked between them.
const homeMemory = await import(new URL('../../../packages/experimental/webworker-runtime/src/storage/voice-memory.ts', import.meta.url).href) as {
  createVoiceMemoryStore: (vfs: Record<string, unknown>) => {
    head: () => Promise<Record<string, unknown>>
    append: (items: unknown) => Promise<Record<string, unknown>>
  }
  recordDigest: (record: unknown) => Promise<string>
  VOICE_MEMORY_CHAIN: string
  VOICE_MEMORY_WORDS: string
  VOICE_MEMORY_ZERO: string
}
const edgeMemory = await import(new URL('../../../deploy/cloudflare/src/voice-memory.mjs', import.meta.url).href) as {
  MEMORY_KEYS: { head: string; tail: string; synced: string }
}
const edgeFakes = fakes as unknown as { memoryStorage: () => { get: (key: string) => Promise<unknown> } }

const NOTHING: Empty = { conversations: 0, sockets: 0, writes: 0, timers: 0 }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const HOME = 'session-voice-1'

/** The page's end of the tab door: a browser-like WebSocket whose bytes go to, and come from, the REAL Worker's door. */
class PageSocket {
  readyState = 0
  sent: Frame[] = []
  heard: Frame[] = []
  edge: EdgeSocket | null = null
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(fx: Edge, path: string, gate: Promise<void>) { void this.connect(fx, path, gate) }
  async connect(fx: Edge, path: string, gate: Promise<void>) {
    await gate
    if (this.readyState === 3) return
    const response = await fx.openTab({ path })
    if (response.status !== 101) { this.readyState = 3; this.onclose?.(); return }
    const edge = response.webSocket
    this.edge = edge
    edge.addEventListener('message', (event) => {
      this.heard.push(JSON.parse(String(event.data)) as Frame)
      this.onmessage?.({ data: event.data })
    })
    edge.addEventListener('close', () => { if (this.readyState !== 3) { this.readyState = 3; this.onclose?.() } })
    this.readyState = 1
    this.onopen?.()
  }
  send(text: string) {
    if (this.readyState !== 1 || !this.edge) throw new Error('not open')
    this.sent.push(JSON.parse(text) as Frame)
    this.edge.send(text)
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.edge?.close(1000) }
  frames(kind: string) { return this.sent.filter(frame => frame.t === kind) }
}

type Stream = { push: (frame: unknown) => void }
/** Her worker as the page sees it: the look-only mark, her voice home, and a session that streams her text in pieces. */
function governed(options: { mark?: () => Response; reply?: string[] | null }) {
  const streams: Stream[] = []
  const prompts: string[] = []
  const calls: string[] = []
  let turnNo = 100
  const respond = (stream: Stream | undefined, requestId: string, pieces: string[], end = true) => {
    const turn = ++turnNo
    stream?.push({ type: 'event', event: { type: 'turn/start', data: { turn } } })
    stream?.push({ type: 'event', event: { type: 'user/message', data: { turn, source: { rpcId: requestId } } } })
    stream?.push({ type: 'assistant-stream', frame: { type: 'start', turn, step: 0 } })
    for (const text of pieces) stream?.push({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text } } })
    if (end) {
      stream?.push({ type: 'assistant-stream', frame: { type: 'end' } })
      stream?.push({ type: 'event', event: { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } } })
    }
    return {
      more: (text: string) => stream?.push({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text } } }),
      finish: () => {
        stream?.push({ type: 'assistant-stream', frame: { type: 'end' } })
        stream?.push({ type: 'event', event: { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } } })
      },
    }
  }
  const items = [{ sessionId: HOME, title: '[voice] Auma Live', updatedAt: 1 }]
  const transport = {
    fetch: async (path: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { payload?: { args?: Record<string, unknown> } }
      if (path.startsWith('/api/__x6__/')) {
        const name = path.slice('/api/__x6__/'.length)
        calls.push(`x6:${name}`)
        if (name === 'voice-mark') return (options.mark ?? (() => json({ ok: true, code: 'VOICE_LOOK_ONLY', lookOnly: true })))()
        return json({ ok: true, savedDefault: false })
      }
      const method = path.replace('/api/', '')
      calls.push(`rpc:${method}`)
      const args = body.payload?.args ?? {}
      if (method === 'session/list') return json({ result: { ok: true, value: { items } } })
      if (method === 'session/state') return json({ result: { ok: true, value: { queue: [] } } })
      if (method === 'session/prompt') {
        const requestId = (args.request as { requestId: string }).requestId
        prompts.push(requestId)
        const stream = streams.at(-1)
        if (options.reply) { const pieces = options.reply; setTimeout(() => { respond(stream, requestId, pieces) }, 0) }
      }
      return json({ result: { ok: true, value: { accepted: true } } })
    },
    openStream: (_name: string, _args: unknown, signal: AbortSignal) => {
      const queue: unknown[] = [{ type: 'snapshot', records: [], cursor: 0, hasMore: false, projections: { asOfSeq: 0, values: {} } }]
      let wake: (() => void) | null = null
      let done = false
      streams.push({ push: (frame: unknown) => { queue.push(frame); wake?.() } })
      signal.addEventListener('abort', () => { done = true; wake?.() })
      return { [Symbol.asyncIterator]: () => ({
        next: async () => {
          for (;;) {
            if (queue.length > 0) return { done: false, value: queue.shift() }
            if (done) { if (signal.aborted) throw new Error('aborted'); return { done: true, value: undefined } }
            await new Promise<void>((resolve) => { wake = resolve })
            wake = null
          }
        },
        return: async () => { done = true; return { done: true, value: undefined } },
      }) }
    },
  }
  return { transport, streams, prompts, calls, respond }
}

/** Both halves, wired. */
type JointOptions = {
  edge?: Record<string, unknown>
  mark?: () => Response
  reply?: string[] | null
  gate?: Promise<void>
  memory?: (body: Record<string, unknown>) => Promise<unknown>
}
function joint(options: JointOptions = {}) {
  const fx = fakes.fixture(options.edge ?? {})
  type PageInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
  const pageFetch = async (path: string, init: PageInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('origin', fakes.ORIGIN)
    headers.set('sec-fetch-site', 'same-origin')
    return fx.send(new Request(fakes.ORIGIN + path, { method: init.method ?? 'GET', headers, ...(init.body === undefined ? {} : { body: init.body }), ...(init.signal ? { signal: init.signal } : {}) }))
  }
  const her = governed({ ...(options.mark ? { mark: options.mark } : {}), reply: options.reply === undefined ? ['The voice ', 'bridge. [field hue=teal energy=0.4] It ', 'speaks.'] : options.reply })
  const store = new Map<string, string>()
  const g = live.createGenesisLive({
    transport: Promise.resolve(her.transport), nativeFetch: pageFetch, now: () => 10_000,
    storage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } },
  })
  const pageTimers = {
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  }
  const fields: string[] = []
  const notices: string[] = []
  const lines: Array<[string, string]> = []
  const sockets: PageSocket[] = []
  const sdk = { configs: [] as SessionConfig[], ended: 0, sessions: [] as Session[] }
  const runTurn = createGovernedTurnRunner({
    bridged: g.bridgedSpokenTurn, sanitize: (text: string) => text.trim(), timers: pageTimers,
    directives: () => makeDirectiveFilter((tag: string) => { fields.push(tag) }),
  })
  const controller = createManagedConversation({
    timers: pageTimers, runTurn,
    request: pageFetch,
    openBridge: (path: string) => {
      const socket = new PageSocket(fx, path, options.gate ?? Promise.resolve())
      sockets.push(socket)
      return socket
    },
    startSession: async (config: SessionConfig) => {
      sdk.configs.push(config)
      const conv = `conv_${String(fx.calls.provider.filter(call => call.url.includes('/conversation/token')).length)}`
      const session: Session = {
        endSession: async () => { sdk.ended += 1 }, setMicMuted: () => {}, getInputVolume: () => 0, getOutputVolume: () => 0,
        sendUserMessage: () => {}, sendUserActivity: () => {}, getId: () => conv,
      }
      sdk.sessions.push(session)
      config.onConversationCreated(session)
      config.onConnect()
      return session
    },
    onTranscript: (role: string, text: string) => { lines.push([role, text]) },
    onNotice: (line: string) => { notices.push(line) },
    ...(options.memory ? { memory: options.memory } : {}),
  })
  /** Let both halves run until nothing moves. */
  const flush = async (rounds = 25) => {
    for (let index = 0; index < rounds; index += 1) {
      await fx.settle()
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    }
  }
  /** The provider's socket at the brain door, signed, with `init` for the page's conversation. */
  const provider = async (conv: string) => {
    const socket = (await fx.openProvider()).webSocket
    socket.json({ type: 'init', conversation_id: conv })
    await flush()
    return socket
  }
  return { fx, her, controller, sockets, sdk, fields, notices, lines, flush, provider, page: () => sockets.at(-1) as PageSocket }
}

const said = (socket: EdgeSocket, eventId: number) => fakes.agentFrames(socket).filter(frame => frame.event_id === eventId).map(frame => (frame.is_final ? '<final>' : frame.content))
const rowsOf = async (fx: Edge) => (await fx.rows()).map(row => [row.turnId, row.completed ?? false, row.cancelled ?? false])

describe('the page and the edge, one protocol (no frame mocked between them)', () => {
  it('one full turn: mint, hello, ready, the transcript journaled then handed over, her deltas in order, done; the provider speaks only her words', async () => {
    const j = joint()
    expect(await j.controller.start()).toBe('started')
    await j.flush()
    const page = j.page()
    expect(page.sent[0]).toEqual({ t: 'hello', conv: 'conv_1' })
    expect(page.heard[0]).toEqual({ t: 'ready', conv: 'conv_1', maxDurationSeconds: 1200 })
    const provider = await j.provider('conv_1')
    provider.json(fakes.transcript(1, 'what are you building'))
    j.sdk.configs[0]?.onMessage({ role: 'user', message: 'what are you building', event_id: 1 })
    await j.flush(60)
    // The edge journaled it (look-only, no words stored) BEFORE the page heard it, and the page ran exactly one turn.
    expect(page.heard.filter(frame => frame.t === 'turn')).toEqual([{ t: 'turn', turn: 'eleven:conv_1:1', eventId: 1, transcript: 'what are you building' }])
    expect(j.her.prompts).toHaveLength(1)
    expect(j.her.calls.indexOf('x6:voice-mark')).toBeLessThan(j.her.calls.indexOf('rpc:session/prompt'))
    const deltas = page.frames('delta')
    expect(deltas.map(frame => frame.seq)).toEqual(deltas.map((_, index) => index))
    expect(deltas.map(frame => String(frame.text)).join('')).not.toContain('[field')
    expect(j.fields).toEqual(['[field hue=teal energy=0.4]'])
    expect(page.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_1:1' }])
    expect(said(provider, 1).map(text => text.trim())).toEqual(['The voice bridge.', 'It speaks.', '<final>'])
    const [row] = await j.fx.rows()
    expect([row?.turnId, row?.signerRole, row?.voiceAuthority, row?.utterancePreview, row?.completed]).toEqual(['eleven:conv_1:1', 'voice-transcript-unconfirmed', 'none', '', true])
    expect(j.lines).toEqual([['you', 'what are you building']])
    j.controller.stop()
    await j.flush()
    expect(provider.closedCode).toBe(1000)
    expect(j.fx.empty()).toEqual(NOTHING)
  })

  it('an interruption: event N+1 while N streams cancels the page\'s turn N by id; nothing of N reaches the provider after; N+1 runs', async () => {
    const j = joint({ reply: null })
    await j.controller.start()
    await j.flush()
    const page = j.page()
    const provider = await j.provider('conv_1')
    provider.json(fakes.transcript(1, 'tell me about the scion'))
    await j.flush(60)
    const first = j.her.respond(j.her.streams.at(-1), j.her.prompts[0] as string, ['The scion is her copy. '], false)
    await j.flush(40)
    expect(said(provider, 1)).toEqual(['The scion is her copy. '])
    provider.json(fakes.transcript(2, 'wait, what about Kira?'))
    await j.flush(60)
    expect(page.heard.filter(frame => frame.t === 'cancel')).toEqual([{ t: 'cancel', turn: 'eleven:conv_1:1', reason: 'superseded' }])
    first.more('A late tail. ')
    await j.flush(40)
    expect(said(provider, 1)).toEqual(['The scion is her copy. '])
    expect(page.frames('delta').filter(frame => frame.turn === 'eleven:conv_1:1').map(frame => frame.text)).toEqual(['The scion is her copy. '])
    // The page's cut reached the edge's journal under the bridge's turn id too (barge_in), idempotent with the bridge's own.
    expect(j.fx.calls.journal.filter(body => body.action === 'cancel' && body.turnId === 'eleven:conv_1:1').map(body => body.reason)).toEqual(['barge_in', 'barge_in'])
    expect(j.her.prompts).toHaveLength(2)
    j.her.respond(j.her.streams.at(-1), j.her.prompts[1] as string, ['Kira is memory.'])
    await j.flush(60)
    expect(said(provider, 2)).toEqual(['Kira is memory.', '<final>'])
    expect(await rowsOf(j.fx)).toEqual([['eleven:conv_1:1', false, true], ['eleven:conv_1:2', true, false]])
    j.controller.stop()
    await j.flush()
    expect(j.fx.empty()).toEqual(NOTHING)
  })

  // CHANGED: only the edge decides an
  // interruption. The SDK's own interruption no longer cuts the page's turn: her work goes on and its answer is spoken.
  it('the SDK\'s own interruption: the page keeps its turn running; no fail, no cancel; her answer reaches the edge whole', async () => {
    const j = joint({ reply: null })
    await j.controller.start()
    await j.flush()
    const page = j.page()
    const provider = await j.provider('conv_1')
    provider.json(fakes.transcript(1, 'go on'))
    await j.flush(60)
    const reply = j.her.respond(j.her.streams.at(-1), j.her.prompts[0] as string, ['Partial thought. '], false)
    await j.flush(40)
    j.sdk.configs[0]?.onInterruption()
    await j.flush(60)
    expect(page.frames('fail')).toEqual([])
    expect(j.her.calls.filter(call => call === 'rpc:session/cancel')).toEqual([])
    reply.more('And the rest of it.')
    reply.finish()
    await j.flush(60)
    expect(page.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_1:1' }])
    expect(said(provider, 1)).toEqual(['Partial thought. ', 'And the rest of it.', '<final>'])
    expect(JSON.stringify(provider.frames())).not.toContain(bridgeDo.LOST_PLACE)
    expect(await rowsOf(j.fx)).toEqual([['eleven:conv_1:1', true, false]])
    j.controller.stop()
    await j.flush()
    expect(j.fx.empty()).toEqual(NOTHING)
  })

  it('a sentence the page writes itself (a look-only refusal) is SPOKEN by the provider and ends in done', async () => {
    const j = joint({ mark: () => json({ ok: false, code: 'VOICE_LOOK_ONLY_UNAVAILABLE' }, 503) })
    await j.controller.start()
    await j.flush()
    const page = j.page()
    const provider = await j.provider('conv_1')
    provider.json(fakes.transcript(1, 'delete my files'))
    await j.flush(60)
    expect(j.her.prompts).toEqual([])
    expect(page.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_1:1' }])
    expect(page.frames('fail')).toEqual([])
    expect(said(provider, 1)).toEqual([live.VOICE_UNCONFIRMED_SAY, '<final>'])
    expect(await rowsOf(j.fx)).toEqual([['eleven:conv_1:1', true, false]])
    j.controller.stop()
    await j.flush()
    expect(j.fx.empty()).toEqual(NOTHING)
  })

  it('the tab closes mid-turn: the fixed sentence, the row abandoned; the provider left alone is let go after the hold', async () => {
    const j = joint({ reply: null })
    await j.controller.start()
    await j.flush()
    const page = j.page()
    const provider = await j.provider('conv_1')
    provider.json(fakes.transcript(1, 'are you still there'))
    await j.flush(60)
    page.edge?.close(1001)   // the tab's connection dies (not a Stop: no bye)
    await j.flush(40)
    expect(said(provider, 1)).toEqual([bridgeDo.LOST_PLACE, '<final>'])
    expect(await rowsOf(j.fx)).toEqual([['eleven:conv_1:1', false, true]])
    expect((await j.fx.rows())[0]?.cancelReason).toBe('turn_abandon')
    expect(j.controller.state).toBe('idle')
    expect(j.sdk.ended).toBe(1)
    expect(j.notices).toEqual([policy.LINES.link])
    j.fx.clock.advance(bridgeDo.PROVIDER_HOLD_MS)
    await j.flush()
    expect(provider.closedCode).toBe(1008)
    expect(j.fx.empty()).toEqual(NOTHING)
  })

  it('Stop mid-turn: bye, both sockets closed, the running turn cut, nothing left in the bridge', async () => {
    const j = joint({ reply: null })
    await j.controller.start()
    await j.flush()
    const page = j.page()
    const provider = await j.provider('conv_1')
    // Real words, not "one moment": since the voice fix that phrase is one of his stop phrases and starts no turn at all.
    provider.json(fakes.transcript(1, 'read me the whole note'))
    await j.flush(60)
    j.controller.stop()
    await j.flush(40)
    expect(page.sent.at(-1)).toEqual({ t: 'bye', why: 'stop' })
    expect(page.readyState).toBe(3)
    expect(provider.closedCode).toBe(1000)
    expect(j.sdk.ended).toBe(1)
    expect(await rowsOf(j.fx)).toEqual([['eleven:conv_1:1', false, true]])
    expect(said(provider, 1)).toEqual(['<final>'])
    expect(j.fx.empty()).toEqual(NOTHING)
  })

  it('the duration runs out: the edge ends the conversation, the page gets end and the SDK session is ended', async () => {
    const j = joint()
    await j.controller.start()
    await j.flush()
    const page = j.page()
    const provider = await j.provider('conv_1')
    j.fx.clock.advance(1200 * 1000)
    await j.flush(40)
    expect(page.heard.at(-1)).toEqual({ t: 'end', reason: 'deadline' })
    expect(j.controller.state).toBe('idle')
    expect(j.sdk.ended).toBe(1)
    expect(j.notices).toEqual([policy.LINES.ended])
    expect(provider.closedCode).toBe(1000)
    expect(j.fx.empty()).toEqual(NOTHING)
  })

  it('a transcript before hello is held (not run, not answered) and becomes the turn when the page says hello', async () => {
    let open = () => {}
    const gate = new Promise<void>((resolve) => { open = resolve })
    const j = joint({ gate })
    expect(await j.controller.start()).toBe('started')
    const provider = await j.provider('conv_1')
    provider.json(fakes.transcript(1, 'early words'))
    await j.flush(40)
    expect(fakes.agentFrames(provider)).toEqual([])
    expect(await j.fx.rows()).toEqual([])
    open()
    await j.flush(80)
    const page = j.page()
    expect(page.heard.map(frame => frame.t)).toEqual(['ready', 'turn'])
    expect(said(provider, 1).map(text => text.trim())).toEqual(['The voice bridge.', 'It speaks.', '<final>'])
    j.controller.stop()
    await j.flush()
    expect(j.fx.empty()).toEqual(NOTHING)
  })

  it('a transcript before hello with no hello inside the hold: nothing said, the conversation ended, and the late page refused', async () => {
    let open = () => {}
    const gate = new Promise<void>((resolve) => { open = resolve })
    const j = joint({ gate })
    await j.controller.start()
    const provider = await j.provider('conv_1')
    provider.json(fakes.transcript(1, 'early words'))
    await j.flush(20)
    j.fx.clock.advance(bridgeDo.PROVIDER_HOLD_MS)
    await j.flush(20)
    expect(provider.closedCode).toBe(1008)
    expect(fakes.agentFrames(provider)).toEqual([])
    open()
    await j.flush(40)
    expect(j.controller.state).toBe('idle')
    expect(j.notices).toEqual([policy.LINES.link])
    expect(await j.fx.rows()).toEqual([])
    expect(j.fx.empty()).toEqual(NOTHING)
  })

  it('a turn the edge could not journal: never run, never answered with words; the page is told', async () => {
    const j = joint({ edge: { journalFault: (body: Record<string, unknown>) => (body.action === undefined ? json({ ok: false, code: 'DOWN' }, 503) : undefined) } })
    await j.controller.start()
    await j.flush()
    const page = j.page()
    const provider = await j.provider('conv_1')
    provider.json(fakes.transcript(1, 'are you there'))
    await j.flush(60)
    expect(page.heard.filter(frame => frame.t !== 'ready')).toEqual([{ t: 'cancel', turn: 'eleven:conv_1:1', reason: 'unjournaled' }])
    expect(j.her.prompts).toEqual([])
    expect(page.frames('delta')).toEqual([])
    expect(said(provider, 1)).toEqual(['<final>'])
    expect(j.notices).toEqual([policy.LINES.unjournaled])
    expect(await j.fx.rows()).toEqual([])
    j.controller.stop()
    await j.flush()
    expect(j.fx.empty()).toEqual(NOTHING)
  })

  it('the switch off: the orb rests with the "not set up" line (no other voice), no SDK session is made, and the bridge is never constructed', async () => {
    const j = joint({ edge: { env: { VOICE_MANAGED: '0' } } })
    expect(await j.controller.start()).toBe('off')
    // "0" now means no voice at all, said in one line; typing works.
    expect(j.notices).toEqual([policy.REFUSAL_LINES.VOICE_NOT_CONFIGURED])
    await j.flush()
    expect(j.sdk.configs).toEqual([])
    expect(j.sockets).toEqual([])
    expect(j.fx.bridgeBuilt).toBe(false)
    expect(j.fx.empty()).toEqual(NOTHING)
  })

  it('voice memory, both halves: her home says what it has, the edge sends the exchange, her home appends it and the edge marks it', async () => {
    // Her home: the real store over a file map.
    const files = new Map<string, string>()
    const folders = new Set<string>(['/', '/dsh', '/dsh/home', '/dsh/home/auma'])
    const vfs = {
      existsSync: (path: string) => files.has(path) || folders.has(path),
      statSync: (path: string) => ({ isDirectory: () => folders.has(path), isFile: () => files.has(path) }),
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readFileSync: (path: string) => { const text = files.get(path); if (text === undefined) throw new Error('ENOENT'); return text },
      writeFileSync: (path: string, data: string) => { files.set(path, data) },
      mkdirSync: (path: string) => { let at = ''; for (const part of path.split('/').filter(Boolean)) { at += `/${part}`; folders.add(at) } },
      unlinkSync: (path: string) => { files.delete(path) },
    }
    const home = homeMemory.createVoiceMemoryStore(vfs)
    const memory = (body: Record<string, unknown>) => (body.action === 'head' ? home.head() : home.append(body.items))
    // The edge: the fast voice on (a made-up key, a made-up model answer), its storage kept so the test can read it.
    const bridgeStorage = edgeFakes.memoryStorage()
    const encoder = new TextEncoder()
    const answer = () => new Response(new ReadableStream({ start(control) {
      control.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'It is noon.' } }] })}\n\n`))
      control.enqueue(encoder.encode('data: [DONE]\n\n'))
      control.close()
    } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const j = joint({ memory, edge: { bridgeStorage, modelFetch: answer, env: { DEEPSEEK_API_KEY: 'sk-synthetic-fast-voice-key-0123456789abcdef',
      PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '1000', PROVIDER_BUDGET_TOKENS: '50000000', PROVIDER_MAX_OUTPUT_TOKENS: '256000' } } })
    await j.controller.start()
    await j.flush()
    const page = j.page()
    const provider = await j.provider('conv_1')
    // Her home had nothing: the page said so once, in the shape the tab door accepts (the door is still open).
    expect(page.frames('memory_have')).toEqual([{ t: 'memory_have', seq: 0, digest: homeMemory.VOICE_MEMORY_ZERO }])
    expect(page.readyState).toBe(1)
    // He first speaks well after hello (the first-frame wait for the awareness is not what this case is about).
    j.fx.clock.advance(3000)
    provider.json(fakes.transcript(1, 'what time is it'))
    await j.flush(80)
    expect(said(provider, 1).join('')).toContain('It is noon.')
    // The edge sent the exchange; her home appended it; the page acknowledged it; the door never closed.
    const sent = page.heard.filter(frame => frame.t === 'memory')
    expect(sent).toHaveLength(1)
    const chain = (files.get(homeMemory.VOICE_MEMORY_CHAIN) ?? '').split('\n').filter(Boolean)
    const words = (files.get(homeMemory.VOICE_MEMORY_WORDS) ?? '').split('\n').filter(Boolean)
    expect(chain).toHaveLength(1)
    expect(words).toHaveLength(1)
    const record = JSON.parse(chain[0] as string) as { seq: number; prev: string; ended: string; path: string }
    expect([record.seq, record.prev, record.ended, record.path]).toEqual([1, homeMemory.VOICE_MEMORY_ZERO, 'answered', 'fast'])
    expect(JSON.parse(words[0] as string)).toMatchObject({ seq: 1, heard: 'what time is it', said: 'It is noon.' })
    const digest = await homeMemory.recordDigest(record)
    expect(page.frames('memory_ack')).toEqual([{ t: 'memory_ack', seq: 1, digest }])
    expect(page.frames('memory_nack')).toEqual([])
    expect(page.readyState).toBe(1)
    // Both holders name the same head, and the edge knows her home has it.
    expect(await bridgeStorage.get(edgeMemory.MEMORY_KEYS.head)).toMatchObject({ seq: 1, digest })
    expect(await bridgeStorage.get(edgeMemory.MEMORY_KEYS.synced)).toBe(1)
    // A second exchange links to the first in her home as it does at the edge.
    provider.json(fakes.transcript(2, 'and tomorrow'))
    await j.flush(80)
    const chain2 = (files.get(homeMemory.VOICE_MEMORY_CHAIN) ?? '').split('\n').filter(Boolean)
    expect(chain2).toHaveLength(2)
    expect((JSON.parse(chain2[1] as string) as { seq: number; prev: string })).toMatchObject({ seq: 2, prev: digest })
    expect(await bridgeStorage.get(edgeMemory.MEMORY_KEYS.synced)).toBe(2)
    j.controller.stop()
    await j.flush(40)
    expect(j.fx.empty()).toEqual(NOTHING)
  })
})
