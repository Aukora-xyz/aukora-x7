/**
 * THE MANAGED VOICE, THE PAGE HALF.
 * The session controller (managed-voice/controller.mjs) runs here whole against a fake SDK session, a fake edge, a fake
 * tab door and fake timers; the governed turn (managed-voice/governed-turn.mjs) runs against the REAL genesis-live.js
 * over a fake worker and edge, so what reaches her is checked on the prompt itself. No network, no provider.
 * The first seven cases are the website's controller tests (AUKORA.xyz exact/voice/managed-conversation.test.mjs),
 * ported with the x6.1 route, roles and typed path; the rest are this lane's.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Frame = Record<string, unknown> & { t: string }
type TurnOutcome = { ok: true } | { ok: false; code: string }
type Turn = { turnId: string; transcript: string; signal: AbortSignal; say: (text: string) => void }
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
  conversationToken: string
  onConversationCreated: (value: Session) => void
  onConnect: () => void
  onDisconnect: (details: { reason: string; message?: string; context?: { type: string; reason?: string } }) => void
  onError: (message?: string, context?: unknown) => void
  onModeChange: (update: { mode: string }) => void
  onInterruption: () => void
  onMessage: (message: Record<string, unknown>) => void
  onAgentResponseCorrection: (correction: Record<string, unknown>) => void
}
type Controller = {
  start: () => Promise<string>
  stop: () => void
  sendText: (text: string) => string
  setMuted: (muted: boolean) => void
  readonly state: string
  readonly connected: boolean
  readonly openTurns: number
  readonly status: { sdk: Record<string, unknown>; openPlain: boolean }
}
type Timer = { fn: () => void; ms: number }

const scripts = new URL('../scripts/stock-apps/managed-voice/', import.meta.url)
const { createManagedConversation, deltaPieces, readSessionAnswer } = await import(new URL('controller.mjs', scripts).href) as {
  createManagedConversation: (deps: Record<string, unknown>) => Controller
  deltaPieces: (text: string) => string[]
  readSessionAnswer: (status: number, body: unknown) => { kind: string; code?: string; line?: string }
}
const { correctionMatches, createArrivalRunner, createGovernedTurnRunner, markCut, openingWords } = await import(new URL('governed-turn.mjs', scripts).href) as {
  correctionMatches: (lineText: string, original: string, corrected: string) => boolean
  createArrivalRunner: (deps: Record<string, unknown>) => (press: { signal: AbortSignal }) => Promise<string>
  createGovernedTurnRunner: (deps: Record<string, unknown>) => (turn: Turn) => Promise<TurnOutcome>
  markCut: (corrected: string) => string
  openingWords: (text: string, partial?: boolean) => string
}
const policy = await import(new URL('policy.mjs', scripts).href) as {
  REFUSAL_LINES: Record<string, string>
  LINES: Record<string, string>
  MANAGED_VOICE: Record<string, number>
  SILENT_OPENING: string
  FAIL_CODES: Record<string, string>
  SDK_WATCH_MS: number
  OPEN_DROP_MS: number
}
const live = await import(new URL('../public/app/genesis-live.js', import.meta.url).href) as {
  createGenesisLive: (deps: Record<string, unknown>) => {
    bridgedSpokenTurn: (turn: Record<string, unknown>) => Promise<{ reason: string; text: string; message?: string }>
    arrivalTurn: (turn: Record<string, unknown>) => Promise<{ reason: string; text: string; message?: string }>
    voiceLevel: () => Promise<string>
  }
  VOICE_PROVENANCE: string
  VOICE_PROVENANCE_OPEN: string
  VOICE_ARRIVAL: string
  AUMA_LIVE_VOICE_MEDIUM: string
  VOICE_UNCONFIRMED_SAY: string
  AUMA_LIVE_ALIEN_VOICE_DIRECTIVE: string
  VOICE_CHANNEL_GUIDANCE: string
  ROSTER_HEAD: string
}
const { makeDirectiveFilter } = await import(new URL('../public/app/field-directives.js', import.meta.url).href) as {
  makeDirectiveFilter: (apply: (tag: string) => void) => { push: (text: string) => string; flush: () => string }
}

const PASS = 'p'.repeat(64)
const CONV = 'conv_test_1'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const settle = async (rounds = 30) => { for (let i = 0; i < rounds; i += 1) await new Promise((r) => { setTimeout(r, 0) }) }

class FakeSocket {
  readyState = 0
  sent: Frame[] = []
  raw: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly path: string) {}
  send(text: string) { this.raw.push(text); this.sent.push(JSON.parse(text) as Frame) }
  close() { this.closed = true; this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  deliver(frame: unknown) { this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) }) }
  frames(kind: string) { return this.sent.filter(frame => frame.t === kind) }
}

function fixture(options: {
  answer?: () => Response | Promise<Response>
  startSession?: (config: SessionConfig, session: Session) => Promise<Session>
  runTurn?: (turn: Turn) => Promise<TurnOutcome>
  muted?: boolean
  arrival?: (press: { signal: AbortSignal }) => Promise<string>
} = {}) {
  const states: string[] = []
  const transcripts: Array<[string, string]> = []
  const notices: string[] = []
  const levels: Array<[number, number, boolean]> = []
  const corrections: Array<[string, string]> = []
  const requests: Array<{ path: string; init: RequestInit }> = []
  const sockets: FakeSocket[] = []
  const runs: Turn[] = []
  const muteCalls: boolean[] = []
  const typed: string[] = []
  const volumes = { input: 0.2, output: 0.5 }
  let config: SessionConfig | null = null
  const configs: SessionConfig[] = []
  let ended = 0, calls = 0, activity = 0
  const session: Session = {
    endSession: async () => { ended += 1 },
    setMicMuted: (muted) => { muteCalls.push(muted) },
    getInputVolume: () => volumes.input,
    getOutputVolume: () => volumes.output,
    sendUserMessage: (text) => { typed.push(text) },
    sendUserActivity: () => { activity += 1 },
    getId: () => CONV,
  }
  const timeouts = new Map<number, Timer>()
  const intervals = new Map<number, Timer>()
  let nextTimer = 0
  const timers = {
    setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timeouts.set(id, { fn, ms }); return id },
    clearTimeout: (id: number) => { timeouts.delete(id) },
    setInterval: (fn: () => void, ms: number) => { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id },
    clearInterval: (id: number) => { intervals.delete(id) },
  }
  /** The controller's clock (ms): moved only by `pass`, so "within OPEN_DROP_MS of the connect" is the test's choice. */
  const clock = { at: 1_000 }
  const controller = createManagedConversation({
    timers,
    now: () => clock.at,
    ...(options.muted === undefined ? {} : { muted: options.muted }),
    ...(options.arrival ? { arrival: options.arrival } : {}),
    request: async (path: string, init: RequestInit) => {
      requests.push({ path, init })
      return (options.answer ?? (() => json({ token: PASS, maxDurationSeconds: 1200 })))()
    },
    startSession: async (given: SessionConfig) => {
      calls += 1
      config = given
      configs.push(given)
      if (options.startSession) return options.startSession(given, session)
      given.onConversationCreated(session)
      given.onConnect()
      return session
    },
    openBridge: (path: string) => { const socket = new FakeSocket(path); sockets.push(socket); return socket },
    runTurn: options.runTurn ?? (async (turn: Turn) => { runs.push(turn); turn.say('Hello there.'); return { ok: true } }),
    onState: (state: string) => { states.push(state) },
    onTranscript: (role: string, text: string) => { transcripts.push([role, text]) },
    onCorrection: (original: string, corrected: string) => { corrections.push([original, corrected]) },
    onLevels: (mic: number, say: number, thinking: boolean) => { levels.push([mic, say, thinking]) },
    onNotice: (line: string) => { notices.push(line) },
  })
  const opts = () => { if (!config) throw new Error('startSession was not called'); return config }
  /** A connected call with the tab door open and ready. */
  const connect = async () => {
    expect(await controller.start()).toBe('started')
    const socket = sockets.at(-1)
    if (!socket) throw new Error('no tab door')
    socket.open()
    socket.deliver({ t: 'ready', conv: CONV, maxDurationSeconds: 1200 })
    return socket
  }
  const meterTick = () => { for (const timer of intervals.values()) timer.fn() }
  /** The clock moves on (no timer fires). */
  const pass = (ms: number) => { clock.at += ms }
  return {
    controller, pass, states, transcripts, notices, levels, corrections, requests, sockets, runs, muteCalls, typed, volumes,
    timeouts, intervals, opts, connect, meterTick, configs,
    get ended() { return ended }, get calls() { return calls }, get activity() { return activity },
  }
}

describe('the website\'s seven controller cases, ported', () => {
  it('provider transcripts reach one conversation; duplicate events do not repeat bubbles; a late event after Stop is dropped', async () => {
    const f = fixture()
    await f.connect()
    f.opts().onMessage({ role: 'user', message: 'hello', event_id: 1 })
    f.opts().onMessage({ role: 'user', message: 'hello', event_id: 1 })
    // Her line on screen is her own governed text, never the provider's copy of it.
    f.opts().onMessage({ role: 'agent', message: 'Hey.', event_id: 2 })
    expect(f.transcripts).toEqual([['you', 'hello']])
    expect(f.states).toContain('thinking')
    f.opts().onInterruption()
    expect(f.controller.state).toBe('listening')
    f.controller.stop()
    expect(f.ended).toBe(1)
    expect(f.controller.state).toBe('idle')
    f.opts().onMessage({ role: 'user', message: 'late words', event_id: 3 })
    expect(f.transcripts).toHaveLength(1)
  })

  it('stopping during connection closes a late session instead of reopening the microphone', async () => {
    let resolve: (value: Session) => void = () => {}
    const f = fixture({ startSession: async () => new Promise<Session>((r) => { resolve = r }) })
    const pending = f.controller.start()
    await settle()
    f.controller.stop()
    let lateEnded = 0
    const late = { endSession: async () => { lateEnded += 1 } } as unknown as Session
    f.opts().onConversationCreated(late)
    f.opts().onConnect()
    resolve(late)
    expect(await pending).toBe('stopped')
    expect(f.controller.state).toBe('idle')
    expect(f.controller.connected).toBe(false)
    expect(lateEnded).toBeGreaterThanOrEqual(1)
    expect(f.sockets).toHaveLength(0)
  })

  it('typing with no call never starts the provider or asks for audio: the page\'s own typed path takes it', async () => {
    const f = fixture()
    expect(f.controller.sendText('What is AUKORA?')).toBe('not-live')
    expect(f.calls).toBe(0)
    expect(f.requests).toHaveLength(0)
    expect(f.transcripts).toEqual([])
    expect(f.controller.state).toBe('idle')
  })

  it('a quota refusal never starts paid audio or leaves a green connected orb', async () => {
    const f = fixture({ answer: () => json({ ok: false, code: 'VOICE_QUOTA' }, 429) })
    expect(await f.controller.start()).toBe('refused')
    expect(f.calls).toBe(0)
    expect(f.controller.state).toBe('idle')
    expect(f.notices[0]).toMatch(/resting/)
  })

  it('the server duration sets the call\'s end and still closes at its deadline', async () => {
    const f = fixture()
    await f.connect()
    const active = [...f.timeouts.values()]
    expect(active).toHaveLength(1)
    expect(active[0]?.ms).toBe(20 * 60 * 1000)
    active[0]?.fn()
    expect(f.controller.state).toBe('idle')
    expect(f.ended).toBe(1)
    expect(f.timeouts.size).toBe(0)
    expect(f.notices).toEqual([policy.LINES.resting])
  })

  it('a shorter duration from the edge is honored', async () => {
    const f = fixture({ answer: () => json({ token: PASS, maxDurationSeconds: 300 }) })
    await f.connect()
    expect([...f.timeouts.values()][0]?.ms).toBe(300_000)
  })

  it('missing, unbounded or invalid durations cannot open the microphone', async () => {
    for (const maxDurationSeconds of [undefined, 0, -1, 59, 1200.5, 1201, '1200']) {
      const f = fixture({ answer: () => json({ token: PASS, maxDurationSeconds }) })
      // Not a valid call, so not a call: the provider is never started, and the orb rests with the one line (2026-11-14:
      // no other voice takes the press).
      expect(await f.controller.start()).toBe('refused')
      expect(f.calls).toBe(0)
      expect(f.controller.state).toBe('idle')
      expect(f.notices).toEqual([policy.LINES.unreachable])
    }
  })
})

describe('the edge\'s answer decides the transport', () => {
  it('asks exactly once, same origin, with exactly the managed_session body', async () => {
    const f = fixture()
    await f.connect()
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]?.path).toBe('/_host/voice')
    expect(f.requests[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"action":"managed_session"}' })
    const config = f.opts()
    expect(config).toMatchObject({
      conversationToken: PASS, connectionType: 'webrtc', micMuted: false, stripAudioTags: true,
      workletPaths: { rawAudioProcessor: '/app/eleven-raw-audio.js' },
      // No canned line: with no arrival turn the call opens silent, and she speaks when he does.
      overrides: { agent: { firstMessage: '' } },
    })
    expect(policy.SILENT_OPENING).toBe('')
    expect(Object.keys(policy)).not.toContain('FIRST_MESSAGE')
  })

  it('the switch off (an action the edge does not know), a 404 and a 501 rest the orb with the "not set up" line; nothing else starts', async () => {
    // "off" no longer means an older voice; it is the switch's "not set up" line.
    for (const answer of [
      () => json({ ok: false, code: 'NOT_FOUND' }, 404),
      () => new Response('not implemented', { status: 501 }),
      () => json({ ok: false, code: 'VOICE_ACTION_INVALID' }, 400),
    ]) {
      const f = fixture({ answer })
      expect(await f.controller.start()).toBe('off')
      expect(f.calls).toBe(0)
      expect(f.notices).toEqual([policy.REFUSAL_LINES.VOICE_NOT_CONFIGURED])
      expect(f.controller.state).toBe('idle')
      expect(f.timeouts.size).toBe(0)
      expect(f.intervals.size).toBe(0)
    }
    expect(policy.REFUSAL_LINES.VOICE_NOT_CONFIGURED).toBe('My voice is not set up on this host yet. Typing works.')
  })

  it('each refusal code leaves the orb idle with its one line, typing working, and nothing reconnecting by itself', async () => {
    for (const code of ['VOICE_QUOTA', 'VOICE_PROVIDER_UNAVAILABLE', 'VOICE_BUSY', 'VOICE_NOT_CONFIGURED']) {
      const f = fixture({ answer: () => json({ ok: false, code }, code === 'VOICE_QUOTA' ? 429 : 503) })
      expect(await f.controller.start()).toBe('refused')
      expect(f.controller.state).toBe('idle')
      expect(f.notices).toEqual([policy.REFUSAL_LINES[code]])
      expect(f.calls).toBe(0)
      // Nothing is left to fire later: no retry timer, no meter.
      expect(f.timeouts.size).toBe(0)
      expect(f.intervals.size).toBe(0)
      // Typing still works: the page's own typed path takes it, and the provider is not asked again.
      expect(f.controller.sendText('still here')).toBe('not-live')
      await settle()
      expect(f.requests).toHaveLength(1)
    }
    // The error shape `{ error: { code } }` reads the same.
    expect(readSessionAnswer(429, { ok: false, error: { code: 'VOICE_QUOTA' } })).toMatchObject({ kind: 'refused', code: 'VOICE_QUOTA' })
  })

  it('any other answer that is not a call rests the orb with one true line: 401/403 the sign-in line, a 5xx, a bad body or no answer "not reachable"', async () => {
    // nothing falls back to an older voice. An owner signed in without his fingerprint
    // session on this browser gets 401/403 from the managed door, and is told exactly that.
    expect(policy.LINES.signIn).toBe('My voice needs your fingerprint sign-in on this browser. Typing works.')
    expect(policy.LINES.unreachable).toBe('My voice is not reachable right now. Typing works.')
    expect(readSessionAnswer(403, { ok: false, code: 'OWNER_ACCESS_REQUIRED' })).toEqual({ kind: 'refused', code: 'OWNER_ACCESS_REQUIRED', line: policy.LINES.signIn })
    expect(readSessionAnswer(401, null)).toMatchObject({ kind: 'refused', line: policy.LINES.signIn })
    // The edge's same-origin refusal is a 403 that is not about sign-in: it is not called one.
    expect(readSessionAnswer(403, { ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' })).toMatchObject({ kind: 'refused', line: policy.LINES.unreachable })
    // A listed refusal keeps its own line, whatever its status.
    expect(readSessionAnswer(403, { ok: false, code: 'VOICE_BUSY' })).toMatchObject({ kind: 'refused', line: policy.REFUSAL_LINES.VOICE_BUSY })
    expect(readSessionAnswer(502, null)).toMatchObject({ kind: 'refused', line: policy.LINES.unreachable })
    expect(readSessionAnswer(409, { ok: false, code: 'VOICE_MANAGED_OFF' })).toMatchObject({ kind: 'refused', line: policy.LINES.unreachable })
    expect(readSessionAnswer(200, { token: 'short', maxDurationSeconds: 600 })).toMatchObject({ kind: 'refused', line: policy.LINES.unreachable })
    expect(readSessionAnswer(200, { token: PASS, maxDurationSeconds: 30 })).toMatchObject({ kind: 'refused', line: policy.LINES.unreachable })
    for (const [answer, line] of [
      [() => json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403), policy.LINES.signIn],
      [() => json({ ok: false }, 401), policy.LINES.signIn],
      [() => new Response('upstream', { status: 502 }), policy.LINES.unreachable],
      [() => new Response('not json', { status: 200 }), policy.LINES.unreachable],
      [() => { throw new TypeError('network down') }, policy.LINES.unreachable],
    ] as Array<[() => Response, string]>) {
      const f = fixture({ answer })
      expect(await f.controller.start()).toBe('refused')
      expect(f.calls).toBe(0)
      expect(f.notices).toEqual([line])
      expect(f.controller.state).toBe('idle')
      expect(f.timeouts.size).toBe(0)
      expect(f.intervals.size).toBe(0)
    }
  })

  it('an edge that does not answer in 12 s rests the orb with the "not reachable" line; a call that does not connect in 25 s is ended', async () => {
    const f = fixture({ answer: () => new Promise<Response>((_resolve, reject) => {
      f.requests[0]?.init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    }) })
    const asked = f.controller.start()
    await settle()
    expect([...f.timeouts.values()].map(timer => timer.ms).sort((a, b) => a - b)).toEqual([12_000, 25_000])
    ;[...f.timeouts.values()].find(timer => timer.ms === 12_000)?.fn()
    expect(f.requests[0]?.init.signal?.aborted).toBe(true)
    // An edge that does not answer: the orb rests with one line, no other voice starts, nothing is left running.
    expect(await asked).toBe('refused')
    expect(f.controller.state).toBe('idle')
    expect(f.notices).toEqual([policy.LINES.unreachable])
    expect(f.timeouts.size).toBe(0)
    expect(f.calls).toBe(0)

    const g = fixture({ startSession: async () => new Promise<Session>(() => {}) })
    void g.controller.start()
    await settle()
    ;[...g.timeouts.values()].find(timer => timer.ms === 25_000)?.fn()
    expect(g.controller.state).toBe('idle')
    expect(g.notices).toEqual([policy.LINES.connect])
  })
})

describe('the tab door', () => {
  it('says hello with the SDK\'s conversation id, waits for ready, and refuses a ready for another conversation', async () => {
    const f = fixture()
    expect(await f.controller.start()).toBe('started')
    const socket = f.sockets[0]
    expect(socket?.path).toBe('/_host/voice/bridge')
    socket?.open()
    expect(socket?.sent).toEqual([{ t: 'hello', conv: CONV }])
    // Before ready, a turn is not taken.
    socket?.deliver({ t: 'turn', turn: 'eleven:conv_test_1:1', eventId: 1, transcript: 'too early' })
    await settle()
    expect(f.runs).toHaveLength(0)
    socket?.deliver({ t: 'ready', conv: 'someone-else', maxDurationSeconds: 1200 })
    expect(f.controller.state).toBe('idle')
    expect(f.notices).toEqual([policy.LINES.link])
    expect(socket?.closed).toBe(true)
  })

  it('a turn frame runs exactly one governed turn and streams her text in order, seq rising from 0, each frame under 8 KiB', async () => {
    const long = 'x'.repeat(2500)
    const f = fixture({ runTurn: async (turn) => { f.runs.push(turn); turn.say('One. '); turn.say('Two. '); turn.say(long); return { ok: true } } })
    const socket = await f.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:4', eventId: 4, transcript: 'say three things' })
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:4', eventId: 4, transcript: 'say three things' })
    await settle()
    expect(f.runs).toHaveLength(1)
    expect(f.runs[0]?.transcript).toBe('say three things')
    const deltas = socket.frames('delta')
    expect(deltas.map(frame => frame.seq)).toEqual([0, 1, 2, 3, 4])
    expect(deltas.every(frame => frame.turn === 'eleven:conv_test_1:4')).toBe(true)
    expect(deltas.map(frame => frame.text).join('')).toBe(`One. Two. ${long}`)
    expect(socket.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_test_1:4' }])
    expect(socket.raw.every(text => new TextEncoder().encode(text).byteLength <= 8192)).toBe(true)
    // The worst case for one piece still fits: 1024 code points that each escape to six bytes.
    const worst = deltaPieces('\u0001'.repeat(3000))
    expect(worst.map(piece => Array.from(piece).length)).toEqual([1024, 1024, 952])
    expect(new TextEncoder().encode(JSON.stringify({ t: 'delta', turn: 'x'.repeat(128), seq: 99_999, text: worst[0] })).byteLength).toBeLessThan(8192)
    expect(deltaPieces('\u{1F600}'.repeat(1025)).map(piece => Array.from(piece).length)).toEqual([1024, 1])
  })

  it('a turn that said something ends in done, whatever its code; a turn with nothing to say ends in fail with its code', async () => {
    const f = fixture({ runTurn: async (turn) => {
      if (turn.transcript === 'say why') turn.say('This turn could not be secured in its thread, so I did not send it.')
      return { ok: false, code: 'VOICE_TURN_FAILED' }
    } })
    const socket = await f.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:30', transcript: 'say why' })
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:31', transcript: 'say nothing' })
    await settle()
    // The page's own sentence is that turn's reply: the edge is told done, so it speaks what it holds.
    expect(socket.frames('delta')).toEqual([{ t: 'delta', turn: 'eleven:conv_test_1:30', seq: 0, text: 'This turn could not be secured in its thread, so I did not send it.' }])
    expect(socket.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_test_1:30' }])
    expect(socket.frames('fail')).toEqual([{ t: 'fail', turn: 'eleven:conv_test_1:31', code: 'VOICE_TURN_FAILED' }])
  })

  it('an invalid or oversized turn is refused by code; a frame over 8 KiB is ignored', async () => {
    const f = fixture()
    const socket = await f.connect()
    socket.deliver({ t: 'turn', turn: 'bad turn id', transcript: 'x' })
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:5', transcript: 'y'.repeat(4001) })
    socket.deliver(JSON.stringify({ t: 'turn', turn: 'eleven:conv_test_1:6', transcript: 'z'.repeat(9000) }))
    await settle()
    expect(f.runs).toHaveLength(0)
    expect(socket.frames('fail')).toEqual([{ t: 'fail', turn: 'eleven:conv_test_1:5', code: 'VOICE_TURN_INVALID' }])
  })

  it('a turn the edge could not record (cancel, reason unjournaled) never runs; the owner is told once; a fail code is /^[A-Z_]{3,40}$/', async () => {
    const f = fixture({ runTurn: async () => ({ ok: false, code: 'VOICE_TURN_9' }) })
    const socket = await f.connect()
    socket.deliver({ t: 'cancel', turn: 'eleven:conv_test_1:40', reason: 'unjournaled' })
    socket.deliver({ t: 'cancel', turn: 'eleven:conv_test_1:40', reason: 'unjournaled' })
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:40', transcript: 'late copy' })
    socket.deliver({ t: 'cancel', turn: 'eleven:conv_test_1:41', reason: 'superseded' })
    await settle()
    expect(f.notices).toEqual([policy.LINES.unjournaled])
    expect(f.runs).toHaveLength(0)
    expect(f.controller.state).not.toBe('idle')
    // A code outside the edge's form is never sent: the turn's failure goes as VOICE_TURN_FAILED.
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:42', transcript: 'say nothing' })
    await settle()
    expect(socket.frames('fail')).toEqual([{ t: 'fail', turn: 'eleven:conv_test_1:42', code: 'VOICE_TURN_FAILED' }])
    for (const code of Object.values(policy.FAIL_CODES)) expect(code).toMatch(/^[A-Z_]{3,40}$/)
  })

  it('cancel cuts that turn by its id, and the edge, which asked, is told nothing more', async () => {
    const f = fixture({ runTurn: turn => new Promise<TurnOutcome>((resolve) => {
      f.runs.push(turn)
      turn.signal.addEventListener('abort', () => { resolve({ ok: false, code: 'VOICE_TURN_CANCELLED' }) })
    }) })
    const socket = await f.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:7', transcript: 'first' })
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:8', transcript: 'second' })
    await settle()
    socket.deliver({ t: 'cancel', turn: 'eleven:conv_test_1:7', reason: 'superseded' })
    await settle()
    expect(f.runs[0]?.signal.aborted).toBe(true)
    expect(f.runs[1]?.signal.aborted).toBe(false)
    expect(socket.frames('fail')).toEqual([])
    expect(socket.frames('done')).toEqual([])
    expect(f.controller.openTurns).toBe(1)
  })

  // CHANGED: the old rule ("two rapid
  // interruptions cut the turn that was running once") is gone. Only the edge decides an interruption: his talking over
  // her never cuts handed work on the page. Page turns end only by the edge's `cancel`, by Stop, and by the call ending.
  it('his talking over her (the provider\'s interruption) never cuts a page turn; the edge\'s cancel and Stop still do', async () => {
    const f = fixture({ runTurn: turn => new Promise<TurnOutcome>((resolve) => {
      f.runs.push(turn)
      turn.signal.addEventListener('abort', () => { resolve({ ok: false, code: 'VOICE_TURN_CANCELLED' }) })
    }) })
    const socket = await f.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:9', transcript: 'tell me a long story' })
    await settle()
    f.opts().onInterruption()
    f.opts().onInterruption()
    await settle()
    // The liveness mark and the change to listening stay; the turn runs on.
    expect(f.runs[0]?.signal.aborted).toBe(false)
    expect(f.controller.state).toBe('listening')
    expect(f.controller.openTurns).toBe(1)
    expect(socket.frames('fail')).toEqual([])
    // The edge decides: its cancel cuts the turn, and the page says nothing more for it.
    socket.deliver({ t: 'cancel', turn: 'eleven:conv_test_1:9', reason: 'superseded' })
    await settle()
    expect(f.runs[0]?.signal.aborted).toBe(true)
    expect(socket.frames('fail')).toEqual([])
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:10', transcript: 'actually, just the end' })
    await settle()
    f.opts().onInterruption()
    await settle()
    expect(f.runs[1]?.signal.aborted).toBe(false)
    // Stop still cuts it at once.
    f.controller.stop()
    await settle()
    expect(f.runs[1]?.signal.aborted).toBe(true)
    expect(socket.frames('done')).toEqual([])
  })

  it('end from the edge, or a tab door that drops, ends the call with one line and no reconnect', async () => {
    const f = fixture()
    const socket = await f.connect()
    socket.deliver({ t: 'end', reason: 'deadline' })
    expect(f.controller.state).toBe('idle')
    expect(f.notices).toEqual([policy.LINES.ended])
    expect(f.ended).toBe(1)

    const g = fixture()
    const door = await g.connect()
    door.readyState = 3
    door.onclose?.()
    expect(g.controller.state).toBe('idle')
    expect(g.notices).toEqual([policy.LINES.link])
    expect(g.sockets).toHaveLength(1)
    expect(g.requests).toHaveLength(1)
  })
})

describe('the call itself', () => {
  it('Stop ends everything: open turns cut, bye on the tab door, the door closed, the call ended, the meter at rest', async () => {
    const f = fixture({ runTurn: turn => new Promise<TurnOutcome>((resolve) => {
      f.runs.push(turn)
      turn.signal.addEventListener('abort', () => { resolve({ ok: false, code: 'VOICE_TURN_CANCELLED' }) })
    }) })
    const socket = await f.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:11', transcript: 'hold on' })
    await settle()
    f.controller.stop()
    await settle()
    expect(f.runs[0]?.signal.aborted).toBe(true)
    expect(socket.sent.at(-1)).toEqual({ t: 'bye', why: 'stop' })
    expect(socket.closed).toBe(true)
    expect(f.ended).toBe(1)
    expect(f.intervals.size).toBe(0)
    expect(f.timeouts.size).toBe(0)
    expect(f.levels.at(-1)).toEqual([0, 0, false])
    // No frame for the cut turn after bye.
    expect(socket.frames('fail')).toEqual([])
  })

  it('a correction is handed on once, and her line then shows what she said and where she was cut', async () => {
    const f = fixture()
    await f.connect()
    f.opts().onAgentResponseCorrection({ original_agent_response: 'The long answer goes on and on.', corrected_agent_response: 'The long answer' })
    expect(f.corrections).toEqual([['The long answer goes on and on.', 'The long answer']])
    expect(markCut('The long   answer')).toBe('The long answer —')
    expect(markCut('')).toBe('— (cut before she spoke)')
    // Which of her lines a correction belongs to: the one that begins as the provider's response begins.
    expect(correctionMatches('The long answer goes on and on.', 'The long answer goes on and on.', 'The long answer')).toBe(true)
    expect(correctionMatches('The  long answer goes on', '', 'the long answer')).toBe(true)
    // A corrected text that begins one of her other lines is not enough when the original names another response.
    expect(correctionMatches('The long way round.', 'Something else entirely.', 'The long')).toBe(false)
    // The edge's own "one sec" while a turn is slow is not one of her lines: her finished answer is left alone.
    expect(correctionMatches('Yes, the garden gate is open and the path is clear.', 'one sec...', 'one sec')).toBe(false)
    expect(correctionMatches('One second is all it took.', 'one sec...', 'one sec')).toBe(false)
    expect(correctionMatches('', 'anything', 'anything')).toBe(false)
    expect(correctionMatches('Hello there.', '', '')).toBe(false)
  })

  it('levels reach the field each 50 ms, x3 and clamped at 1; thinking holds from a turn frame until her first words', async () => {
    let speak: (text: string) => void = () => {}
    let finish: () => void = () => {}
    const f = fixture({ runTurn: turn => new Promise<TurnOutcome>((resolve) => {
      speak = turn.say
      finish = () => { resolve({ ok: true }) }
    }) })
    const socket = await f.connect()
    expect([...f.intervals.values()].map(timer => timer.ms)).toEqual([50])
    f.meterTick()
    expect(f.levels.at(-1)?.[0]).toBeCloseTo(0.6)
    expect(f.levels.at(-1)?.[1]).toBe(1)
    expect(f.levels.at(-1)?.[2]).toBe(false)
    f.volumes.input = 0.9; f.volumes.output = Number.NaN
    f.meterTick()
    expect(f.levels.at(-1)).toEqual([1, 0, false])
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:12', transcript: 'think about it' })
    await settle()
    f.meterTick()
    expect(f.levels.at(-1)?.[2]).toBe(true)
    speak('Here it is.')
    f.meterTick()
    expect(f.levels.at(-1)?.[2]).toBe(false)
    finish()
    await settle()
    expect(socket.frames('done')).toHaveLength(1)
  })

  it('mute changes the call\'s own capture and never opens a second one', async () => {
    const f = fixture()
    await f.connect()
    f.controller.setMuted(true)
    expect(f.muteCalls).toEqual([false, true])
    f.meterTick()
    expect(f.levels.at(-1)?.[0]).toBe(0)
    f.controller.setMuted(false)
    expect(f.muteCalls).toEqual([false, true, false])
    expect(f.calls).toBe(1)
    // Muted before the call: the call starts muted.
    const g = fixture()
    g.controller.setMuted(true)
    await g.connect()
    expect(g.opts().micMuted).toBe(true)
    expect(g.muteCalls).toEqual([true])
    // Made while the page is muted (the owner muted before his first press): the call starts muted, never live first.
    const h = fixture({ muted: true })
    await h.connect()
    expect(h.opts().micMuted).toBe(true)
    expect(h.muteCalls).toEqual([true])
  })

  it('typing in a live call goes into the same conversation (activity, then the message), shown once as the owner\'s line', async () => {
    const f = fixture()
    await f.connect()
    expect(f.controller.sendText('  type this  ')).toBe('sent')
    expect(f.activity).toBe(1)
    expect(f.typed).toEqual(['type this'])
    expect(f.transcripts).toEqual([['you', 'type this']])
    expect(f.calls).toBe(1)
  })

  it('typing while the call is still connecting does not cancel the connection', async () => {
    let answer: (value: Response) => void = () => {}
    const f = fixture({ answer: () => new Promise<Response>((r) => { answer = r }) })
    const pending = f.controller.start()
    await settle()
    expect(f.controller.state).toBe('connecting')
    expect(f.controller.sendText('hello?')).toBe('not-live')
    expect(f.controller.state).toBe('connecting')
    expect(f.requests[0]?.init.signal?.aborted).toBe(false)
    answer(json({ token: PASS, maxDurationSeconds: 1200 }))
    expect(await pending).toBe('started')
    expect(f.calls).toBe(1)
  })

  it('a microphone the browser refuses says how to allow it', async () => {
    const f = fixture({ startSession: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }) } })
    expect(await f.controller.start()).toBe('refused')
    expect(f.notices).toEqual([policy.LINES.micDenied])
  })
})

describe('the first message, when the provider refuses the override', () => {
  const REFUSED = 'Override for field \'first_message\' is not allowed by config.'

  it('a session the provider refuses for the override is tried once more without it, and the call comes up', async () => {
    let tries = 0
    const f = fixture({ startSession: async (config, session) => {
      tries += 1
      if (tries === 1) throw new Error(REFUSED)
      config.onConversationCreated(session)
      config.onConnect()
      return session
    } })
    expect(await f.controller.start()).toBe('started')
    expect(f.configs).toHaveLength(2)
    expect(f.configs[0]?.overrides).toEqual({ agent: { firstMessage: policy.SILENT_OPENING } })
    expect(f.configs[1]).not.toHaveProperty('overrides')
    expect(f.configs[1]?.conversationToken).toBe(PASS)
    expect(f.requests).toHaveLength(1)
    expect(f.notices).toEqual([])
    expect(f.controller.state).toBe('listening')
    expect(f.sockets).toHaveLength(1)
  })

  it('a refusal that arrives after connecting (before the tab door is ready) ends that session and retries once without it', async () => {
    const f = fixture()
    expect(await f.controller.start()).toBe('started')
    const first = f.opts()
    first.onError(REFUSED)
    await settle()
    expect(f.ended).toBe(1)
    expect(f.sockets[0]?.closed).toBe(true)
    expect(f.configs).toHaveLength(2)
    expect(f.configs[1]).not.toHaveProperty('overrides')
    expect(f.sockets).toHaveLength(2)
    // The first session's late words are dropped; the second call works.
    first.onMessage({ role: 'user', message: 'late', event_id: 1 })
    expect(f.transcripts).toEqual([])
    f.sockets[1]?.open()
    f.sockets[1]?.deliver({ t: 'ready', conv: CONV, maxDurationSeconds: 1200 })
    expect(f.controller.state).toBe('listening')
    expect(f.notices).toEqual([])
  })

  it('only once, only for the override, only before the tab door is ready', async () => {
    // Refused again without the override: the orb rests with the usual line, nothing more is tried.
    const f = fixture({ startSession: async () => { throw new Error(REFUSED) } })
    expect(await f.controller.start()).toBe('refused')
    expect(f.configs).toHaveLength(2)
    expect(f.notices).toEqual([policy.LINES.connect])
    // Any other failure is not blamed on the override.
    const g = fixture({ startSession: async () => { throw new Error('ICE failed') } })
    expect(await g.controller.start()).toBe('refused')
    expect(g.configs).toHaveLength(1)
    // Once the tab door is ready the call is up: an error then is not blamed on the override and nothing is retried.
    // the voice tools part 2: it no longer ends the call by itself; with no sign of life for the watch window it does.
    const h = fixture()
    await h.connect()
    h.opts().onError(REFUSED)
    expect(h.configs).toHaveLength(1)
    expect(h.controller.state).toBe('listening')
    expect(h.notices).toEqual([])
    const watch = [...h.timeouts.values()].find(timer => timer.ms === policy.SDK_WATCH_MS)
    expect(watch).toBeDefined()
    watch?.fn()
    expect(h.configs).toHaveLength(1)
    expect(h.controller.state).toBe('idle')
    // CHANGED 2026-11-18: this call carried the override ('' opens silent) and the provider never showed life, so it
    // dropped as it opened (see 'a call dropped as it opened' below; with life first, the line is still `disconnected`).
    expect(h.notices).toEqual([policy.LINES.droppedOpening])
    // A disconnect whose close reason names the override is read the same way.
    const k = fixture()
    expect(await k.controller.start()).toBe('started')
    k.opts().onDisconnect({ reason: 'error', message: 'closed', context: { type: 'close', reason: REFUSED } })
    await settle()
    expect(k.configs).toHaveLength(2)
    expect(k.configs[1]).not.toHaveProperty('overrides')
  })
})

describe('a call dropped as it opened (2026-11-18): the next press opens without the override', () => {
  const REFUSED = 'Override for field \'first_message\' is not allowed by config.'
  /** Every sign of provider life the SDK gives after it connects (onConnect itself is not one). */
  const lives: Array<[string, (config: SessionConfig) => void]> = [
    ['her audio', (config) => { config.onModeChange({ mode: 'speaking' }) }],
    ['a message', (config) => { config.onMessage({ role: 'user', message: 'hi', event_id: 9 }) }],
    ['a ping', (config) => { (config.onPing as (event: unknown) => void)({ event_id: 1, ping_ms: 80 }) }],
    ['an interruption', (config) => { config.onInterruption() }],
    ['a correction', (config) => { config.onAgentResponseCorrection({ original_agent_response: 'a b', corrected_agent_response: 'a' }) }],
  ]

  it('an override call the provider ends before any life (reason agent, or error) shows the new line and sets openPlain', async () => {
    for (const [reason, why] of [['agent', 'disconnected'], ['error', 'error']] as const) {
      const f = fixture()
      expect(await f.controller.start()).toBe('started')
      expect(f.configs[0]?.overrides).toEqual({ agent: { firstMessage: policy.SILENT_OPENING } })
      expect(f.controller.status.openPlain).toBe(false)
      const socket = f.sockets[0] as FakeSocket
      socket.open()
      // Before or after the tab door is ready, it is the same: no provider life followed the connect.
      if (reason === 'error') socket.deliver({ t: 'ready', conv: CONV, maxDurationSeconds: 1200 })
      f.opts().onDisconnect({ reason })
      expect(f.controller.state, reason).toBe('idle')
      expect(f.notices, reason).toEqual([policy.LINES.droppedOpening])
      expect(f.controller.status.openPlain, reason).toBe(true)
      // The edge is told why as before, and nothing new: the bye's shape is unchanged.
      expect(socket.frames('bye'), reason).toEqual([{ t: 'bye', why }])
      expect(f.configs, reason).toHaveLength(1)
    }
    expect(policy.LINES.droppedOpening).toBe('Voice dropped as it opened. Tap the orb to try once more, or keep typing.')
  })

  it('the next press sends no override and runs no arrival turn; it stays so for every press until the page reloads', async () => {
    let arrivals = 0
    const f = fixture({ arrival: async () => { arrivals += 1; return 'The owner, here.' } })
    expect(await f.controller.start()).toBe('started')
    expect(arrivals).toBe(1)
    expect(f.configs[0]?.overrides).toEqual({ agent: { firstMessage: 'The owner, here.' } })
    f.opts().onDisconnect({ reason: 'agent' })
    expect(f.controller.status.openPlain).toBe(true)
    expect(await f.controller.start()).toBe('started')
    expect(arrivals).toBe(1)
    expect(f.configs[1]).not.toHaveProperty('overrides')
    expect(f.configs[1]?.conversationToken).toBe(PASS)
    expect([...f.timeouts.values()].some(timer => timer.ms === policy.MANAGED_VOICE.arrivalMs)).toBe(false)
    // Her first words were shown once, for the first call only; the plain call has no line of hers.
    expect(f.transcripts).toEqual([['auma', 'The owner, here.']])
    expect(f.requests).toHaveLength(2)
    // A healthy plain call that ends later does not set it back.
    f.pass(policy.OPEN_DROP_MS)
    f.opts().onModeChange({ mode: 'speaking' })
    f.opts().onDisconnect({ reason: 'agent' })
    expect(f.controller.status.openPlain).toBe(true)
    expect(await f.controller.start()).toBe('started')
    expect(arrivals).toBe(1)
    expect(f.configs[2]).not.toHaveProperty('overrides')
    // A fresh page (a reload makes a new controller) asks for her first words again.
    const g = fixture({ arrival: async () => 'Again.' })
    expect(await g.controller.start()).toBe('started')
    expect(g.configs[0]?.overrides).toEqual({ agent: { firstMessage: 'Again.' } })
  })

  it('a healthy override call that shows life and later disconnects is exactly as before and does not set openPlain', async () => {
    for (const [name, life] of lives) {
      const f = fixture()
      const socket = await f.connect()
      // Past the open-drop window: a healthy call (CHANGED 2026-11-18 with OPEN_DROP_MS).
      f.pass(policy.OPEN_DROP_MS)
      life(f.opts())
      f.opts().onDisconnect({ reason: 'agent' })
      expect(f.controller.state, name).toBe('idle')
      // A provider hang-up after life is silent, as before.
      expect(f.notices, name).toEqual([])
      expect(socket.frames('bye'), name).toEqual([{ t: 'bye', why: 'disconnected' }])
      expect(f.controller.status.openPlain, name).toBe(false)
      const g = fixture()
      await g.connect()
      g.pass(policy.OPEN_DROP_MS)
      life(g.opts())
      g.opts().onDisconnect({ reason: 'error' })
      expect(g.notices, name).toEqual([policy.LINES.disconnected])
      expect(g.controller.status.openPlain, name).toBe(false)
      // The SDK watch after life: the usual line, not the new one.
      const h = fixture()
      await h.connect()
      life(h.opts())
      h.pass(policy.SDK_WATCH_MS)
      h.opts().onError('socket glitch')
      const watch = [...h.timeouts.values()].find(timer => timer.ms === policy.SDK_WATCH_MS)
      expect(watch, name).toBeDefined()
      watch?.fn()
      expect(h.notices, name).toEqual([policy.LINES.disconnected])
      expect(h.controller.status.openPlain, name).toBe(false)
    }
  })

  it('the SDK watch firing on an override call before any life is a dropped opening', async () => {
    const f = fixture()
    await f.connect()
    f.opts().onError('socket closed')
    const watch = [...f.timeouts.values()].find(timer => timer.ms === policy.SDK_WATCH_MS)
    watch?.fn()
    expect(f.notices).toEqual([policy.LINES.droppedOpening])
    expect(f.controller.status.openPlain).toBe(true)
    expect(f.sockets[0]?.frames('bye')).toEqual([{ t: 'bye', why: 'error', sdk: 'socket' }])
  })

  it('a plain call that drops before life shows LINES.disconnected for a non-error reason too; after life it stays silent', async () => {
    const f = fixture()
    expect(await f.controller.start()).toBe('started')
    f.opts().onDisconnect({ reason: 'agent' })
    expect(await f.controller.start()).toBe('started')
    expect(f.configs[1]).not.toHaveProperty('overrides')
    const plain = f.sockets[1] as FakeSocket
    plain.open()
    f.opts().onDisconnect({ reason: 'agent' })
    expect(f.notices).toEqual([policy.LINES.droppedOpening, policy.LINES.disconnected])
    expect(plain.frames('bye')).toEqual([{ t: 'bye', why: 'disconnected' }])
    expect(f.controller.state).toBe('idle')
    // Reason error before life: the usual line, as before.
    expect(await f.controller.start()).toBe('started')
    f.opts().onDisconnect({ reason: 'error' })
    expect(f.notices.at(-1)).toBe(policy.LINES.disconnected)
    // After life, a plain call's non-error end is silent, as before.
    expect(await f.controller.start()).toBe('started')
    f.pass(policy.OPEN_DROP_MS)
    ;(f.opts().onPing as (event: unknown) => void)({ event_id: 2, ping_ms: 50 })
    f.opts().onDisconnect({ reason: 'user' })
    expect(f.notices).toHaveLength(3)
    expect(f.controller.state).toBe('idle')
    // The retry's plain attempt is a plain call too: dropping before life says the usual line.
    let tries = 0
    const g = fixture({ startSession: async (config, session) => {
      tries += 1
      if (tries === 1) throw new Error(REFUSED)
      config.onConversationCreated(session)
      config.onConnect()
      return session
    } })
    expect(await g.controller.start()).toBe('started')
    g.opts().onDisconnect({ reason: 'agent' })
    expect(g.notices).toEqual([policy.LINES.disconnected])
    expect(g.controller.status.openPlain).toBe(false)
  })

  it('the override-refused retry is checked first, still works, and does not set openPlain when it succeeds', async () => {
    let tries = 0
    const f = fixture({ startSession: async (config, session) => {
      tries += 1
      if (tries === 1) throw new Error(REFUSED)
      config.onConversationCreated(session)
      config.onConnect()
      return session
    } })
    expect(await f.controller.start()).toBe('started')
    expect(f.configs).toHaveLength(2)
    expect(f.configs[1]).not.toHaveProperty('overrides')
    expect(f.notices).toEqual([])
    expect(f.controller.status.openPlain).toBe(false)
    // A disconnect whose words name the override (before ready, before life): the retry, not the new line.
    const k = fixture()
    expect(await k.controller.start()).toBe('started')
    k.opts().onDisconnect({ reason: 'error', message: 'closed', context: { type: 'close', reason: REFUSED } })
    await settle()
    expect(k.configs).toHaveLength(2)
    expect(k.configs[1]).not.toHaveProperty('overrides')
    expect(k.notices).toEqual([])
    expect(k.controller.status.openPlain).toBe(false)
    expect(k.controller.state).toBe('listening')
    // An onError that names it, the same.
    const e = fixture()
    expect(await e.controller.start()).toBe('started')
    e.opts().onError(REFUSED)
    await settle()
    expect(e.configs).toHaveLength(2)
    expect(e.notices).toEqual([])
    expect(e.controller.status.openPlain).toBe(false)
  })

  it('a startSession rejection (not NotAllowedError) on an override call sets openPlain and shows the new line', async () => {
    let tries = 0
    const f = fixture({ startSession: async (config, session) => {
      tries += 1
      if (tries === 1) throw new Error('ICE failed')
      config.onConversationCreated(session)
      config.onConnect()
      return session
    } })
    expect(await f.controller.start()).toBe('refused')
    expect(f.configs).toHaveLength(1)
    expect(f.notices).toEqual([policy.LINES.droppedOpening])
    expect(f.controller.status.openPlain).toBe(true)
    expect(f.controller.state).toBe('idle')
    expect(await f.controller.start()).toBe('started')
    expect(f.configs[1]).not.toHaveProperty('overrides')
    // Without the override a rejection says the usual line, as before.
    const g = fixture({ startSession: async () => { throw new Error('ICE failed') } })
    expect(await g.controller.start()).toBe('refused')
    expect(await g.controller.start()).toBe('refused')
    expect(g.configs.map(config => Object.hasOwn(config, 'overrides'))).toEqual([true, false])
    expect(g.notices).toEqual([policy.LINES.droppedOpening, policy.LINES.connect])
  })

  it('NotAllowedError still shows the microphone line and does not set openPlain', async () => {
    const f = fixture({ startSession: async () => { throw Object.assign(new Error('override refused'), { name: 'NotAllowedError' }) } })
    expect(await f.controller.start()).toBe('refused')
    expect(f.notices).toEqual([policy.LINES.micDenied])
    expect(f.controller.status.openPlain).toBe(false)
    expect(await f.controller.start()).toBe('refused')
    expect(f.configs.every(config => Object.hasOwn(config, 'overrides'))).toBe(true)
  })

  it('OPEN_DROP_MS: with the override, life then an end inside the window is still a dropped opening', async () => {
    expect(policy.OPEN_DROP_MS).toBe(8000)
    type Life = [string, (config: SessionConfig) => void]
    const early: Life[] = [lives[2] as Life, lives[0] as Life]
    for (const [name, life] of early) {
      const f = fixture()
      await f.connect()
      f.pass(policy.OPEN_DROP_MS - 1)
      life(f.opts())
      f.opts().onDisconnect({ reason: 'agent' })
      expect(f.notices, name).toEqual([policy.LINES.droppedOpening])
      expect(f.controller.status.openPlain, name).toBe(true)
    }
  })

  it('OPEN_DROP_MS: without the override, life then a non-error end inside the window says LINES.disconnected; just past it, silence', async () => {
    const plain = async (ms: number) => {
      const f = fixture()
      expect(await f.controller.start()).toBe('started')
      f.opts().onDisconnect({ reason: 'agent' })
      expect(await f.controller.start()).toBe('started')
      expect(f.configs[1]).not.toHaveProperty('overrides')
      f.pass(ms)
      ;(f.opts().onPing as (event: unknown) => void)({ event_id: 5, ping_ms: 40 })
      f.opts().onDisconnect({ reason: 'agent' })
      expect(f.controller.state).toBe('idle')
      return f.notices.slice(1)
    }
    expect(await plain(policy.OPEN_DROP_MS - 1)).toEqual([policy.LINES.disconnected])
    expect(await plain(policy.OPEN_DROP_MS)).toEqual([])
    // With the override, just past the window with life: today's silence, and openPlain stays off.
    const f = fixture()
    await f.connect()
    f.pass(policy.OPEN_DROP_MS)
    f.opts().onModeChange({ mode: 'speaking' })
    f.opts().onDisconnect({ reason: 'agent' })
    expect(f.notices).toEqual([])
    expect(f.controller.status.openPlain).toBe(false)
  })

  it('the edge\'s own turn and spoken frames prove the provider reached it: life for this attempt', async () => {
    for (const frame of [
      { t: 'turn', turn: 'eleven:conv_test_1:70', transcript: 'hello' },
      { t: 'spoken', turn: 'eleven:conv_test_1:71', heard: 'hi', said: 'Hello.' },
    ]) {
      const f = fixture()
      const socket = await f.connect()
      f.pass(policy.OPEN_DROP_MS)
      socket.deliver(frame)
      await settle()
      f.opts().onDisconnect({ reason: 'agent' })
      expect(f.notices, frame.t).toEqual([])
      expect(f.controller.status.openPlain, frame.t).toBe(false)
    }
  })

  it('the owner\'s own Stop inside the window sets nothing, and the dead session\'s later end is ignored', async () => {
    const f = fixture()
    const socket = await f.connect()
    const first = f.opts()
    f.controller.stop()
    first.onDisconnect({ reason: 'user' })
    first.onDisconnect({ reason: 'error' })
    expect(f.notices).toEqual([])
    expect(f.controller.status.openPlain).toBe(false)
    expect(socket.frames('bye')).toEqual([{ t: 'bye', why: 'stop' }])
    expect(await f.controller.start()).toBe('started')
    expect(f.configs[1]?.overrides).toEqual({ agent: { firstMessage: policy.SILENT_OPENING } })
  })

  it('status: openPlain is a closed boolean beside the sdk fields; a copy the page cannot change', async () => {
    const f = fixture()
    expect(Object.keys(f.controller.status).sort()).toEqual(['openPlain', 'sdk'])
    const status = f.controller.status as { openPlain: boolean }
    status.openPlain = true
    expect(f.controller.status.openPlain).toBe(false)
  })
})

// ---- her governed turn, through the REAL genesis-live.js ----

const VOICE_TITLE = '[voice] Auma Live'
const HOME = 'session-voice-1'
type Call = { kind: 'rpc' | 'x6' | 'edge'; name: string; body: Record<string, unknown> }
type Stream = { push: (frame: unknown) => void }

/** Her worker and her edge as the page sees them (the same contract as auma-live-voice-look-only's world). */
function world(options: { mark?: () => Response; reply?: string; manual?: boolean; level?: 'open' } = {}) {
  const log: Call[] = []
  const streams: Stream[] = []
  const store = new Map<string, string>()
  let lastRequestId = ''
  const items = [{ sessionId: HOME, title: VOICE_TITLE, updatedAt: 1 }, { sessionId: 'session-other', title: 'Work', updatedAt: 2 }]
  const transport = {
    fetch: async (path: string, init: { body: string }) => {
      // VOICE LEVEL: answered only when the test names a level (unanswered, the page runs the look-only flow as before).
      if (path === '/api/__x6__/voice-level' && options.level) return json({ ok: true, level: options.level })
      const body = JSON.parse(init.body) as Record<string, unknown>
      if (path.startsWith('/api/__x6__/')) {
        const name = path.slice('/api/__x6__/'.length)
        log.push({ kind: 'x6', name, body })
        if (name === 'voice-mark') return (options.mark ?? (() => json({ ok: true, code: 'VOICE_LOOK_ONLY', lookOnly: true })))()
        return json({ ok: true, savedDefault: false })
      }
      const method = path.replace('/api/', '')
      const args = (body as { payload: { args: Record<string, unknown> } }).payload.args
      log.push({ kind: 'rpc', name: method, body: args })
      if (method === 'session/list') return json({ result: { ok: true, value: { items } } })
      if (method === 'session/state') return json({ result: { ok: true, value: { queue: [{ id: 'queued-1', rpcId: lastRequestId }] } } })
      if (method === 'session/prompt') {
        lastRequestId = (args.request as { requestId: string }).requestId
        if (options.manual !== true) {
          const stream = streams.at(-1)
          const requestId = lastRequestId
          setTimeout(() => {
            stream?.push({ type: 'event', event: { type: 'turn/start', data: { turn: 7 } } })
            stream?.push({ type: 'event', event: { type: 'user/message', data: { source: { rpcId: requestId } } } })
            stream?.push({ type: 'event', event: { type: 'assistant/message', data: { turn: 7, step: 0, message: { content: [{ type: 'text', text: options.reply ?? 'Done.' }] } } } })
            stream?.push({ type: 'event', event: { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } } })
          }, 0)
        }
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
            await new Promise<void>((r) => { wake = r })
            wake = null
          }
        },
        return: async () => { done = true; return { done: true, value: undefined } },
      }) }
    },
  }
  const nativeFetch = async (_path: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>
    log.push({ kind: 'edge', name: String(body.action), body })
    return json({ ok: true, action: body.action, turnId: body.turnId, voiceAuthority: 'none' })
  }
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
  const g = live.createGenesisLive({ transport: Promise.resolve(transport), nativeFetch, storage, now: () => 10_000 })
  const fields: string[] = []
  const her: Array<[string, string, boolean]> = []
  const runTurn = createGovernedTurnRunner({
    bridged: g.bridgedSpokenTurn,
    sanitize: (text: string) => text.trim(),
    directives: () => makeDirectiveFilter((tag: string) => { fields.push(tag) }),
    onHer: (turnId: string, text: string, final: boolean) => { her.push([turnId, text, final]) },
  })
  const prompts = () => log.filter(call => call.kind === 'rpc' && call.name === 'session/prompt')
    .map(call => call.body.request as { requestId: string; sessionId: string; mode: string; content: Array<{ text: string }> })
  return { g, log, streams, runTurn, prompts, fields, her }
}

describe('her governed turn, for a turn the edge hands over (real genesis-live.js)', () => {
  it('runs as a spoken turn runs today minus the journal: look-only confirmed first, provenance first, roster, queue mode; her text streams back without tags', async () => {
    const w = world({ reply: 'Here I am. [field hue=teal energy=0.4] Still here.' })
    const f = fixture({ runTurn: w.runTurn })
    const socket = await f.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:20', eventId: 20, transcript: 'are you there' })
    await settle(80)
    const prompts = w.prompts()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.sessionId).toBe(HOME)
    expect(prompts[0]?.mode).toBe('queue')
    expect(prompts[0]?.content[0]?.text).toBe(live.VOICE_PROVENANCE)
    expect(prompts[0]?.content[1]?.text.startsWith(live.ROSTER_HEAD)).toBe(true)
    expect(prompts[0]?.content[2]?.text).toBe(live.AUMA_LIVE_ALIEN_VOICE_DIRECTIVE)
    expect(prompts[0]?.content[3]?.text).toBe(live.VOICE_CHANNEL_GUIDANCE)
    expect(prompts[0]?.content[4]?.text).toBe('are you there')
    expect(prompts[0]?.content).toHaveLength(5)
    // The look-only mark came before the prompt; the edge's journal was NOT called again.
    const order = w.log.map(call => `${call.kind}:${call.name}`)
    expect(order.indexOf('x6:voice-mark')).toBeLessThan(order.indexOf('rpc:session/prompt'))
    expect(w.log.filter(call => call.kind === 'edge')).toEqual([])
    const spoken = socket.frames('delta').map(frame => frame.text).join('')
    expect(spoken).not.toContain('[field')
    expect(spoken.replace(/\s+/g, ' ').trim()).toBe('Here I am. Still here.')
    expect(w.fields).toEqual(['[field hue=teal energy=0.4]'])
    expect(socket.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_test_1:20' }])
    expect(w.her.at(-1)?.[2]).toBe(true)
  })

  it('a look-only confirmation that fails says why as that turn\'s reply (done), and never prompts her', async () => {
    const w = world({ mark: () => json({ ok: false, code: 'VOICE_LOOK_ONLY_UNAVAILABLE' }, 503) })
    const f = fixture({ runTurn: w.runTurn })
    const socket = await f.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:21', transcript: 'delete my files' })
    await settle(80)
    expect(w.prompts()).toEqual([])
    expect(socket.frames('delta').map(frame => frame.text).join('')).toBe(live.VOICE_UNCONFIRMED_SAY)
    expect(socket.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_test_1:21' }])
    expect(socket.frames('fail')).toEqual([])
    // The runner still names the refusal; with nothing said it would go to the edge as fail VOICE_LOOK_ONLY_REFUSED.
    const outcome = await w.runTurn({ turnId: 't-look', transcript: 'delete my files', signal: new AbortController().signal, say: () => {} })
    expect(outcome).toEqual({ ok: false, code: 'VOICE_LOOK_ONLY_REFUSED' })
    expect(w.prompts()).toEqual([])
  })

  it('cancel before her turn starts fences the queued prompt and marks that turn id cut at the edge', async () => {
    const w = world({ manual: true })
    const f = fixture({ runTurn: w.runTurn })
    const socket = await f.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:22', transcript: 'wait for it' })
    await settle(80)
    expect(w.prompts()).toHaveLength(1)
    socket.deliver({ t: 'cancel', turn: 'eleven:conv_test_1:22', reason: 'superseded' })
    await settle(80)
    const removed = w.log.filter(call => call.name === 'session/updateQueue')
    expect(removed).toHaveLength(1)
    expect((removed[0]?.body.request as { action: unknown }).action).toEqual({ kind: 'remove' })
    expect(w.log.filter(call => call.name === 'session/cancel')).toEqual([])
    expect(w.log.filter(call => call.kind === 'edge').map(call => call.body)).toEqual([{ action: 'barge_in', turnId: 'eleven:conv_test_1:22' }])
    expect(socket.frames('fail')).toEqual([])
  })

  it('cancel while her turn runs cancels it in her session and marks that turn id cut at the edge', async () => {
    const w = world({ manual: true })
    const f = fixture({ runTurn: w.runTurn })
    const socket = await f.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:23', transcript: 'go on' })
    await settle(80)
    const requestId = w.prompts()[0]?.requestId
    const stream = w.streams.at(-1)
    stream?.push({ type: 'event', event: { type: 'turn/start', data: { turn: 9 } } })
    stream?.push({ type: 'event', event: { type: 'user/message', data: { turn: 9, source: { rpcId: requestId } } } })
    await settle(40)
    socket.deliver({ t: 'cancel', turn: 'eleven:conv_test_1:23', reason: 'superseded' })
    await settle(80)
    expect(w.log.filter(call => call.name === 'session/cancel')).toHaveLength(1)
    expect(w.log.filter(call => call.kind === 'edge').map(call => call.body)).toEqual([{ action: 'barge_in', turnId: 'eleven:conv_test_1:23' }])
    expect(socket.frames('done')).toEqual([])
  })

  it('a question about herself is answered from her index, sent as the turn\'s reply, and never prompts her', async () => {
    const said: string[] = []
    const written: string[] = []
    let prompted = 0
    const runTurn = createGovernedTurnRunner({
      bridged: async () => { prompted += 1; return { reason: 'completed', text: '' } },
      selfQuestion: {
        classify: (text: string) => (text === 'what can you do' ? { kind: 'capabilities' } : null),
        gather: async () => ({ ok: true }),
        answer: () => ({ status: 'answered' }),
        render: (_answer: unknown, mode: string) => (mode === 'spoken' ? 'I can look at my threads.' : 'I can look at my threads (index).'),
        wouldDelete: () => false,
      },
      directives: () => makeDirectiveFilter(() => {}),
      onHer: (_turnId: string, text: string) => { written.push(text) },
    })
    const outcome = await runTurn({ turnId: 't1', transcript: 'what can you do', signal: new AbortController().signal, say: (text: string) => { said.push(text) } })
    expect(outcome).toEqual({ ok: true })
    expect(said).toEqual(['I can look at my threads.'])
    expect(written).toEqual(['I can look at my threads (index).'])
    expect(prompted).toBe(0)
  })

  it('a turn with no words, or a failed stream, is said in the page\'s own sentence and returns its failure code', async () => {
    const said: string[] = []
    const run = (bridged: () => Promise<{ reason: string; text: string; message?: string }>) => createGovernedTurnRunner({
      bridged, directives: () => makeDirectiveFilter(() => {}),
    })({ turnId: 't2', transcript: 'hello', signal: new AbortController().signal, say: (text: string) => { said.push(text) } })
    expect(await run(async () => ({ reason: 'completed', text: '' }))).toEqual({ ok: false, code: 'VOICE_TURN_FAILED' })
    expect(await run(async () => { throw new Error('carrier lost') })).toEqual({ ok: false, code: 'VOICE_TURN_FAILED' })
    expect(said).toEqual([
      'I heard you, but my thinking channel returned no words. Say it once more.',
      'The channel flickered — I lost my thread. Say it again?',
    ])
  })
})

describe('nothing canned speaks for her (2026-11-14)', () => {
  const OPEN_MAP = '[your map for this voice turn]\nbuild made-up3.'
  const OPEN_MARK = () => json({ ok: true, code: 'VOICE_OPEN', lookOnly: false, level: 'open', map: OPEN_MAP })
  const arrivalTimer = (f: ReturnType<typeof fixture>) =>
    [...f.timeouts.values()].find(timer => timer.ms === policy.MANAGED_VOICE.arrivalMs)

  it('her arrival turn starts only once the edge answers with a call, and what she wrote is the call\'s first words and her line', async () => {
    let answer: (value: Response) => void = () => {}
    let asked: AbortSignal | null = null
    const f = fixture({
      answer: () => new Promise<Response>((r) => { answer = r }),
      arrival: async ({ signal }) => { asked = signal; return 'The owner. I was just reading the voice thread.' },
    })
    const pending = f.controller.start()
    await settle()
    // Nothing of hers runs before the edge has said a call is allowed: no home is found, made or prompted.
    expect(asked).toBeNull()
    expect(f.calls).toBe(0)
    answer(json({ token: PASS, maxDurationSeconds: 1200 }))
    expect(await pending).toBe('started')
    expect(asked).not.toBeNull()
    expect(f.configs[0]?.overrides).toEqual({ agent: { firstMessage: 'The owner. I was just reading the voice thread.' } })
    expect(f.transcripts).toEqual([['auma', 'The owner. I was just reading the voice thread.']])
    expect(arrivalTimer(f)).toBeUndefined()
    expect((asked as AbortSignal | null)?.aborted).toBe(false)
  })

  it('no answer within MANAGED_VOICE.arrivalMs of the edge\'s answer: her turn is cut and the call opens silent', async () => {
    let cut = false
    const f = fixture({ arrival: ({ signal }) => new Promise<string>((resolve) => { signal.addEventListener('abort', () => { cut = true; resolve('') }) }) })
    const pending = f.controller.start()
    await settle()
    expect(f.calls).toBe(0)
    expect(policy.MANAGED_VOICE.arrivalMs).toBeLessThanOrEqual(4000)
    arrivalTimer(f)?.fn()
    expect(await pending).toBe('started')
    expect(cut).toBe(true)
    expect(f.configs[0]?.overrides).toEqual({ agent: { firstMessage: '' } })
    expect(f.transcripts).toEqual([])
  })

  it('an arrival that ignores the cut is given a quarter second, then the call opens silent', async () => {
    const f = fixture({ arrival: () => new Promise<string>(() => {}) })
    const pending = f.controller.start()
    await settle()
    arrivalTimer(f)?.fn()
    await settle()
    const grace = [...f.timeouts.values()].find(timer => timer.ms === 250)
    expect(grace).toBeDefined()
    grace?.fn()
    expect(await pending).toBe('started')
    expect(f.configs[0]?.overrides).toEqual({ agent: { firstMessage: '' } })
  })

  it('an edge that is off, a refusal, or Stop before the answer never starts her arrival turn; Stop during it cuts it', async () => {
    const signals: AbortSignal[] = []
    const hold = ({ signal }: { signal: AbortSignal }) => { signals.push(signal); return new Promise<string>(() => {}) }
    const off = fixture({ answer: () => json({ ok: false, code: 'VOICE_ACTION_INVALID' }, 400), arrival: hold })
    expect(await off.controller.start()).toBe('off')
    const refused = fixture({ answer: () => json({ ok: false, code: 'VOICE_QUOTA' }, 429), arrival: hold })
    expect(await refused.controller.start()).toBe('refused')
    let late: (value: Response) => void = () => {}
    const early = fixture({ answer: () => new Promise<Response>((r) => { late = r }), arrival: hold })
    const before = early.controller.start()
    await settle()
    early.controller.stop()
    late(json({ token: PASS, maxDurationSeconds: 1200 }))
    expect(await before).toBe('stopped')
    // None of those presses asked her anything: no home, no thread, no prompt, no model spent.
    expect(signals).toEqual([])
    const stopped = fixture({ arrival: hold })
    const pending = stopped.controller.start()
    await settle()
    stopped.controller.stop()
    expect(await pending).toBe('stopped')
    expect(stopped.calls).toBe(0)
    expect(signals.map(signal => signal.aborted)).toEqual([true])
    const broken = fixture({ arrival: async () => { throw new Error('no thread') } })
    expect(await broken.controller.start()).toBe('started')
    expect(broken.configs[0]?.overrides).toEqual({ agent: { firstMessage: '' } })
  })

  it('a provider that refuses the override: the retry carries no override and shows no line of hers', async () => {
    let tries = 0
    const f = fixture({
      arrival: async () => 'Here.',
      startSession: async (config, session) => {
        tries += 1
        if (tries === 1) throw new Error('Override for field \'first_message\' is not allowed by config.')
        config.onConversationCreated(session)
        config.onConnect()
        return session
      },
    })
    expect(await f.controller.start()).toBe('started')
    expect(f.configs[0]?.overrides).toEqual({ agent: { firstMessage: 'Here.' } })
    expect(f.configs[1]).not.toHaveProperty('overrides')
    expect(f.transcripts).toEqual([])
  })

  it('the arrival runner through the REAL genesis-live at level open: her words, her field tags applied and taken out', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, reply: 'The owner. [field hue=gold energy=0.5] I was in the middle of something. **Come in.**' })
    const fields: string[] = []
    const arrival = createArrivalRunner({
      arrive: w.g.arrivalTurn, sanitize: (text: string) => text.replace(/\*\*/g, '').trim(),
      directives: () => makeDirectiveFilter((tag: string) => { fields.push(tag) }),
    })
    const words = await arrival({ signal: new AbortController().signal })
    expect(words).toBe('The owner. I was in the middle of something. Come in.')
    expect(fields).toEqual(['[field hue=gold energy=0.5]'])
    const content = w.prompts()[0]?.content.map(part => part.text) ?? []
    expect(content.at(-1)).toBe(live.VOICE_ARRIVAL)
    expect(content).toContain(live.AUMA_LIVE_VOICE_MEDIUM)
    expect(content).toContain(OPEN_MAP)
    expect(content.join('\n')).not.toMatch(/curious/i)
    expect(w.log.filter(call => call.kind === 'edge')).toEqual([])
    // Below level open there is no arrival turn: nothing is prompted, and the call opens silent.
    const closed = world()
    expect(await createArrivalRunner({ arrive: closed.g.arrivalTurn, directives: () => makeDirectiveFilter(() => {}) })({ signal: new AbortController().signal })).toBe('')
    expect(closed.prompts()).toEqual([])
  })

  it('cut at the deadline, the first words are only the sentences she finished; long words are cut at a sentence end', async () => {
    const arrival = createArrivalRunner({
      arrive: ({ onToken, signal }: { onToken: (value: string) => void; signal: AbortSignal }) => {
        onToken('I am here. Something I was ')
        return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ reason: 'aborted', text: '' }) }) })
      },
      directives: () => makeDirectiveFilter(() => {}),
    })
    const press = new AbortController()
    const words = arrival({ signal: press.signal })
    await settle()
    press.abort()
    expect(await words).toBe('I am here.')
    expect(openingWords('Half a thought', true)).toBe('')
    const long = `${'One sentence here. '.repeat(40)}Tail`
    const cut = openingWords(long)
    expect(policy.MANAGED_VOICE.openingCodePoints).toBe(500)
    expect(Array.from(cut).length).toBeLessThanOrEqual(500)
    expect(cut.endsWith('here.')).toBe(true)
  })

  it('at level open the self-question shortcut is off: every spoken turn goes to her; below it, the shortcut stays', async () => {
    const run = (level: string) => {
      let prompted = 0, gathered = 0
      const runTurn = createGovernedTurnRunner({
        bridged: async ({ onToken }: { onToken: (value: string) => void }) => { prompted += 1; onToken('Mine.'); return { reason: 'completed', text: 'Mine.' } },
        selfQuestion: {
          classify: () => ({ kind: 'capabilities' }),
          gather: async () => { gathered += 1; return { ok: true } },
          answer: () => ({ status: 'answered' }),
          render: () => 'From the index.',
          wouldDelete: () => false,
        },
        voiceLevel: async () => level,
        directives: () => makeDirectiveFilter(() => {}),
      })
      const said: string[] = []
      return runTurn({ turnId: 't-self', transcript: 'what can you do', signal: new AbortController().signal, say: (text: string) => { said.push(text) } })
        .then(outcome => ({ outcome, said, prompted, gathered }))
    }
    expect(await run('open')).toMatchObject({ outcome: { ok: true }, said: ['Mine.'], prompted: 1, gathered: 0 })
    expect(await run('look-only')).toMatchObject({ outcome: { ok: true }, said: ['From the index.'], prompted: 0, gathered: 1 })
  })

  it('at level open a mark that fails does not silence her: the turn is sent, and the look-only sentence is never said', async () => {
    const w = world({ level: 'open', mark: () => json({ ok: false, code: 'VOICE_MARK_NOT_SAVED' }, 503) })
    const f = fixture({ runTurn: w.runTurn })
    const socket = await f.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_test_1:30', transcript: 'are you there' })
    await settle(80)
    expect(w.prompts()).toHaveLength(1)
    expect(w.prompts()[0]?.content[0]?.text).toBe(live.VOICE_PROVENANCE_OPEN)
    const spoken = socket.frames('delta').map(frame => frame.text).join('')
    expect(spoken).toBe('Done.')
    expect(spoken).not.toContain(live.VOICE_UNCONFIRMED_SAY)
    expect(socket.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_test_1:30' }])
  })
})

describe('the seam in aumalive.js (read as text)', () => {
  const page = readFileSync(new URL('../public/app/aumalive.js', import.meta.url), 'utf8')
  const slice = (from: string, to: string) => {
    const start = page.indexOf(from)
    const end = page.indexOf(to, start + from.length)
    expect(start, from).toBeGreaterThan(0)
    expect(end, to).toBeGreaterThan(start)
    return page.slice(start, end)
  }

  it('the module is loaded only on a press; no answer, no module and Canvas ever start another voice (2026-11-14)', () => {
    expect(page.match(/import\(MANAGED_VOICE_MODULE\)/g)).toHaveLength(1)
    expect(page).toContain('const MANAGED_VOICE_MODULE = \'/app/managed-voice.js\';')
    expect(page).not.toMatch(/^import .*managed-voice/m)
    const open = slice('  async function openVoice() {', '  function stopManagedVoice() {')
    // The managed voice is the voice. Nothing in the press reaches the older channel.
    expect(open).not.toContain('openChannel')
    expect(open).toContain('if (canvasMode) { toast(CANVAS_VOICE_LINE, 7000); return; }')
    expect(open).toContain('if (!controller) { managedSettled(); toast(VOICE_UNREACHABLE_LINE, 7000); return; }')
    expect(open).toContain('await controller.start();')
    // The page's copy of the "not reachable" line is the controller's own.
    expect(page).toContain(`const VOICE_UNREACHABLE_LINE = '${policy.LINES.unreachable}';`)
    // The older channel is opened from nowhere: its function stays only until job 2 removes it.
    expect(page.match(/\bopenChannel\(/g)).toHaveLength(1)
    expect(page).toContain('  async function openChannel() {')
    expect(open).toContain('orb.setAttribute(\'aria-busy\', \'true\');')
    const click = slice('  orb.addEventListener(\'click\', () => {', '  });')
    expect(click).toContain('else if (managedState !== \'idle\') stopManagedVoice();')
    expect(click).toContain('else void openVoice();')
  })

  // CHANGED: hiding the page and
  // selecting another app no longer end the call (the old rule: "Stop, hiding the page, unloading and closing the app end
  // the managed call"). Stop, unload (pagehide, beforeunload) and closing the app still do.
  it('Stop, unloading and closing the app end the managed call; hiding the page and selecting another app do not', () => {
    expect(slice('  function closeChannel() {', '\n  }\n')).toMatch(/^ {2}function closeChannel\(\) \{\n {4}if \(!keepingCall\) stopManagedVoice\(\);\n/)
    const onVis = slice('  const onVis = () => {', '  };')
    expect(onVis).toContain('if (document.hidden) dropHer();')
    expect(onVis).not.toContain('stopManagedVoice')
    expect(page).toContain('window.addEventListener(\'pagehide\', stopManagedVoice);')
    expect(page).toContain('window.removeEventListener(\'pagehide\', stopManagedVoice);')
    // Unload and closing the app run closeChannel, which stops the call first.
    expect(page).toContain('const unload = () => { closeChannel();')
    const surface = slice('    if (message.type === \'surface-active\') {', '      return;')
    expect(surface).toContain('closeOldChannelOnly();')
    expect(surface).not.toMatch(/closeChannel\(\)|stopManagedVoice/)
    // The orb (Stop) still ends a live managed call.
    expect(slice('  orb.addEventListener(\'click\', () => {', '  });')).toContain('else if (managedState !== \'idle\') stopManagedVoice();')
  })

  it('mute reaches the call\'s own capture and opens nothing; typing in a live call goes to the call; levels go to the field', () => {
    const mute = slice('  function setMute(on) {', '  muteBtn.addEventListener')
    expect(mute).toContain('managedVoice?.setMuted(on);')
    expect(page.match(/getUserMedia/g)).toHaveLength(3)
    expect(slice('  compose.addEventListener(\'submit\', (e) => {', '  });')).toContain('if (managedVoice?.sendText(v) === \'sent\') return;')
    const levels = slice('        onLevels: (mic, say, thinking) => {', '        },')
    expect(levels).toContain('field.micEnv = mic; field.sayEnv = say;')
    expect(levels).toContain('if (thinking) field.think = 1;')
  })

  it('today\'s voice path at level open: the self-index shortcut is asked her level first and skipped at open', () => {
    const block = slice('    const selfAsk = classifySelfQuestion(text);', '    // **THE SESSION THIS TURN GOES THROUGH')
    expect(block).toContain('const herLevel = selfAsk ? await (presenceFetch.voiceLevel?.() ?? \'unknown\') : \'unknown\';')
    expect(block).toContain('if (selfAsk && herLevel !== \'open\') {')
    expect(block.indexOf('herLevel !== \'open\'')).toBeLessThan(block.indexOf('selfIndex.gather('))
  })

  it('the managed block writes the transcript only through addTurn and saveLog: the stored key prefix is unchanged', () => {
    const block = slice('  // ---- managed voice ----', '  // mute toggle')
    expect(block).not.toMatch(/localStorage|sessionStorage|indexedDB/)
    expect(readFileSync(new URL('../public/app/chat-log-key.js', import.meta.url), 'utf8')).toContain('export const CHAT_LOG_PREFIX = \'aukora-auma-live-log-v2:\'')
  })
})
