/**
 * At voice level open a spoken turn may take as long as
 * her work takes (first sign of life within 60 s, at most 180 s between two events, one 10-minute ceiling); the call
 * ending by itself never cuts her work (it is carried, and her answer lands in her thread and the transcript); the
 * owner's interruption and Stop still cut at once. At any other level the 18 s / 22 s watchdog and today's behaviour stay.
 * The controller and the governed turn run whole with a fake SDK session, a fake tab door, a fake bridged turn and one
 * manual clock. No network, no provider.
 */
import { describe, expect, it } from 'vitest'

type Frame = Record<string, unknown> & { t: string }
type Outcome = { ok: true } | { ok: false; code: string }
type Turn = { turnId: string; transcript: string; signal: AbortSignal; say: (text: string) => void; carry?: () => void }
type SdkStatus = {
  errors: number
  lastErrorSeconds: number | null
  kind: string | null
  disconnectReason: string | null
  disconnectCode: number | null
}
type Controller = {
  start: () => Promise<string>
  stop: () => void
  readonly state: string
  readonly openTurns: number
  readonly status: { sdk: SdkStatus }
}
type SdkConfig = Record<string, (value?: unknown, context?: unknown) => void>

const scripts = new URL('../scripts/stock-apps/managed-voice/', import.meta.url)
const { createManagedConversation } = await import(new URL('controller.mjs', scripts).href) as {
  createManagedConversation: (deps: Record<string, unknown>) => Controller
}
const { createGovernedTurnRunner } = await import(new URL('governed-turn.mjs', scripts).href) as {
  createGovernedTurnRunner: (deps: Record<string, unknown>) => (turn: Turn) => Promise<Outcome>
}
const policy = await import(new URL('policy.mjs', scripts).href) as {
  MANAGED_VOICE: Record<string, number>
  TURN_LINES: Record<string, string>
  FAIL_CODES: Record<string, string>
  LINES: Record<string, string>
  CALL_END_REASONS: readonly string[]
  SDK_ERROR_KINDS: readonly string[]
  SDK_WATCH_MS: number
  OPEN_DROP_MS: number
  classifySdkError: (message: unknown, context?: unknown) => string
}
const edge = await import(new URL('../../../deploy/cloudflare/src/voice-bridge-do.mjs', import.meta.url).href) as {
  FAIL_LINES: Record<string, string>
}

const settle = async (rounds = 20) => { for (let i = 0; i < rounds; i += 1) await new Promise((r) => { setTimeout(r, 0) }) }

/** One manual clock for every timer of the page (controller and turn). */
function clock() {
  let now = 0, next = 0
  const queue = new Map<number, { at: number; fn: () => void; every: number }>()
  const timers = {
    setTimeout: (fn: () => void, ms: number) => { const id = ++next; queue.set(id, { at: now + ms, fn, every: 0 }); return id },
    clearTimeout: (id: number) => { queue.delete(id) },
    setInterval: (fn: () => void, ms: number) => { const id = ++next; queue.set(id, { at: now + ms, fn, every: ms }); return id },
    clearInterval: (id: number) => { queue.delete(id) },
  }
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = [...queue].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at
      if (due[1].every) due[1].at += due[1].every
      else queue.delete(due[0])
      due[1].fn()
      await settle(2)
    }
    now = until
    await settle()
  }
  return { timers, advance, get now() { return now } }
}

/** A bridged turn (genesis-live.js bridgedSpokenTurn) the test drives: activity, words, the end. */
function herSession() {
  const turns: Array<{ activity: () => void; write: (text: string) => void; finish: () => void; signal: AbortSignal }> = []
  const bridged = (turn: { signal: AbortSignal; onActivity: () => void; onToken: (text: string) => void }) => new Promise((resolve) => {
    let text = ''
    turn.signal.addEventListener('abort', () => { resolve({ reason: 'aborted', text }) }, { once: true })
    turns.push({
      activity: () => { turn.onActivity() },
      write: (value) => { text += value; turn.onToken(value) },
      finish: () => { resolve({ reason: 'completed', text }) },
      signal: turn.signal,
    })
  })
  return { bridged, turns }
}

function runner(level: string, c: ReturnType<typeof clock>, her = herSession()) {
  const lines: Array<[string, string, boolean]> = []
  const run = createGovernedTurnRunner({
    bridged: her.bridged, directives: () => ({ push: (text: string) => text, flush: () => '' }),
    timers: c.timers,
    voiceLevel: async () => level,
    onHer: (turnId: string, text: string, final: boolean) => { lines.push([turnId, text, final]) },
  })
  return { run, her, lines }
}

function start(r: ReturnType<typeof runner>, signal = new AbortController().signal) {
  const said: string[] = []
  let carried = false
  let outcome: Outcome | null = null
  const done = r.run({ turnId: 'eleven:c:1', transcript: 'look it up', signal, say: (text) => { said.push(text) }, carry: () => { carried = true } })
    .then((value) => { outcome = value; return value })
  return { said, done, get outcome() { return outcome }, get carried() { return carried } }
}

describe('her turn at voice level open', () => {
  it('quiet for 25 s, 60 s and 170 s between activity events is never cut; her answer then completes', async () => {
    const c = clock()
    const r = runner('open', c)
    const t = start(r)
    await settle()
    expect(t.carried).toBe(true)
    const [turn] = r.her.turns
    for (const gap of [25_000, 60_000, 170_000]) {
      await c.advance(gap)
      expect(turn?.signal.aborted).toBe(false)
      turn?.activity()
    }
    turn?.write('It is warm in Ubud.')
    turn?.finish()
    expect(await t.done).toEqual({ ok: true })
    expect(t.said).toEqual(['It is warm in Ubud.'])
  })

  it('no first sign of life within 60 s is a timeout; with nothing said, the page says nothing and the edge speaks the line', async () => {
    const c = clock()
    const r = runner('open', c)
    const t = start(r)
    await settle()
    await c.advance(59_999)
    expect(r.her.turns[0]?.signal.aborted).toBe(false)
    await c.advance(1)
    expect(await t.done).toEqual({ ok: false, code: policy.FAIL_CODES.timeout })
    expect(t.said).toEqual([])
    expect(r.lines.at(-1)).toEqual(['eleven:c:1', policy.TURN_LINES.quiet, true])
  })

  it('180 s without any event after the first is a timeout (179.999 s is not)', async () => {
    const c = clock()
    const r = runner('open', c)
    const t = start(r)
    await settle()
    await c.advance(1000)
    r.her.turns[0]?.activity()
    await c.advance(179_999)
    expect(r.her.turns[0]?.signal.aborted).toBe(false)
    await c.advance(1)
    expect(await t.done).toEqual({ ok: false, code: policy.FAIL_CODES.timeout })
  })

  it('the 10-minute ceiling is a timeout with a failure line, however busy she is', async () => {
    const c = clock()
    const r = runner('open', c)
    const t = start(r)
    await settle()
    const [turn] = r.her.turns
    turn?.write('Starting on it. ')
    for (let at = 0; at < 600_000; at += 100_000) {
      await c.advance(100_000 - (at === 500_000 ? 1 : 0))
      if (at < 500_000) turn?.activity()
    }
    expect(turn?.signal.aborted).toBe(false)
    await c.advance(1)
    expect(await t.done).toEqual({ ok: false, code: policy.FAIL_CODES.ceiling })
    // She had said something, so the page says the one line itself (the turn then ends in done).
    expect(t.said).toEqual(['Starting on it. ', policy.TURN_LINES.ceiling])
    expect(policy.MANAGED_VOICE).toMatchObject({ openFirstEventMs: 60_000, openIdleMs: 180_000, openTurnMs: 600_000 })
  })

  it('the owner\'s interruption and Stop still cut at once, whatever the level', async () => {
    for (const level of ['open', 'look-only']) {
      const c = clock()
      const r = runner(level, c)
      const owner = new AbortController()
      const t = start(r, owner.signal)
      await settle()
      await c.advance(5000)
      owner.abort()
      expect(await t.done).toEqual({ ok: false, code: policy.FAIL_CODES.cancelled })
      expect(r.her.turns[0]?.signal.aborted).toBe(true)
    }
  })
})

describe('any other level: exactly today', () => {
  it('look-only: the first sign of life within 18 s, then 22 s of quiet; the page says the quiet line; nothing is carried', async () => {
    const c = clock()
    const r = runner('look-only', c)
    const first = start(r)
    await settle()
    expect(first.carried).toBe(false)
    await c.advance(17_999)
    expect(r.her.turns[0]?.signal.aborted).toBe(false)
    await c.advance(1)
    expect(await first.done).toEqual({ ok: false, code: policy.FAIL_CODES.timeout })
    expect(first.said).toEqual([policy.TURN_LINES.quiet])
    const second = start(r)
    await settle()
    r.her.turns[1]?.activity()
    await c.advance(21_999)
    expect(r.her.turns[1]?.signal.aborted).toBe(false)
    await c.advance(1)
    expect(await second.done).toEqual({ ok: false, code: policy.FAIL_CODES.timeout })
    expect(policy.MANAGED_VOICE).toMatchObject({ firstEventMs: 18_000, idleMs: 22_000 })
  })
})

class FakeSocket {
  readyState = 0
  sent: Frame[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send(text: string) { this.sent.push(JSON.parse(text) as Frame) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  deliver(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  frames(kind: string) { return this.sent.filter(frame => frame.t === kind) }
}

/** The page controller with her governed turn at `level`, one manual clock, a fake SDK session and tab door. */
function page(level: string, seconds = 1200, beforeConnect?: (given: SdkConfig) => void) {
  const c = clock()
  const r = runner(level, c)
  const sockets: FakeSocket[] = []
  const notices: string[] = []
  let config: SdkConfig = {}
  const session = { endSession: async () => {}, setMicMuted: () => {}, getInputVolume: () => 0, getOutputVolume: () => 0, sendUserMessage: () => {}, sendUserActivity: () => {}, getId: () => 'conv_long' }
  const controller = createManagedConversation({
    timers: c.timers,
    now: () => c.now,
    request: async () => new Response(JSON.stringify({ token: 'p'.repeat(64), maxDurationSeconds: seconds }), { status: 200 }),
    startSession: async (given: SdkConfig) => {
      config = given
      given.onConversationCreated?.(session)
      beforeConnect?.(given)
      given.onConnect?.()
      return session
    },
    openBridge: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    runTurn: r.run,
    onNotice: (line: string) => { notices.push(line) },
  })
  const connect = async () => {
    expect(await controller.start()).toBe('started')
    const socket = sockets.at(-1) as FakeSocket
    socket.open()
    socket.deliver({ t: 'ready', conv: 'conv_long', maxDurationSeconds: 1200 })
    return socket
  }
  return { c, r, controller, connect, notices, sdk: () => config, sockets }
}

describe('the lookup case through the page controller', () => {
  it('the owner speaks; she writes nothing for 40 s (a tool runs), then answers: the answer is delivered and the turn ends done', async () => {
    const p = page('open')
    const socket = await p.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_long:1', transcript: 'what is the weather in Ubud' })
    await settle()
    const [turn] = p.r.her.turns
    turn?.activity()
    await p.c.advance(40_000)
    expect(turn?.signal.aborted).toBe(false)
    turn?.write('Warm, with rain after four.')
    turn?.finish()
    await settle()
    expect(socket.frames('delta')).toEqual([{ t: 'delta', turn: 'eleven:conv_long:1', seq: 0, text: 'Warm, with rain after four.' }])
    expect(socket.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_long:1' }])
    expect(socket.frames('fail')).toEqual([])
  })

  it('she writes one sentence, is quiet for 90 s, then writes the rest: both are sent, in order', async () => {
    const p = page('open')
    const socket = await p.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_long:2', transcript: 'find the paper' })
    await settle()
    const [turn] = p.r.her.turns
    turn?.write('Let me look that up. ')
    await p.c.advance(90_000)
    expect(turn?.signal.aborted).toBe(false)
    turn?.write('Found it: the 2024 survey.')
    turn?.finish()
    await settle()
    expect(socket.frames('delta').map(frame => [frame.seq, frame.text])).toEqual([[0, 'Let me look that up. '], [1, 'Found it: the 2024 survey.']])
    expect(socket.frames('done')).toHaveLength(1)
    // 90 s of the manual clock is many small steps: on a loaded machine they passed the default 5 s of real time once
    // (a gate on a loaded machine, load average 10). The assertions are unchanged; only the real-time allowance is.
  }, 30_000)

  it('at look-only the same 40 s of quiet is cut at 22 s, exactly as today', async () => {
    const p = page('look-only')
    const socket = await p.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_long:3', transcript: 'what is the weather' })
    await settle()
    p.r.her.turns[0]?.activity()
    await p.c.advance(40_000)
    expect(p.r.her.turns[0]?.signal.aborted).toBe(true)
    expect(socket.frames('delta').map(frame => frame.text)).toEqual([policy.TURN_LINES.quiet])
    expect(socket.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_long:3' }])
  })
})

describe('the provider gives up mid-turn', () => {
  it('the edge ends the call (cancel provider-closed, then end): at open her turn carries on and her answer lands in the transcript', async () => {
    const p = page('open')
    const socket = await p.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_long:4', transcript: 'research this for me' })
    await settle()
    const [turn] = p.r.her.turns
    turn?.activity()
    await p.c.advance(30_000)
    socket.deliver({ t: 'cancel', turn: 'eleven:conv_long:4', reason: 'provider-closed' })
    socket.deliver({ t: 'end', reason: 'provider-closed' })
    await settle()
    expect(p.controller.state).toBe('idle')
    expect(p.notices).toEqual([policy.LINES.ended])
    expect(turn?.signal.aborted).toBe(false)
    const sent = socket.sent.length
    await p.c.advance(60_000)
    turn?.write('Here is what I found.')
    turn?.finish()
    await settle()
    // Her answer is her line in the transcript (and in her voice thread, which her session keeps); nothing goes up the door.
    expect(p.r.lines.at(-1)).toEqual(['eleven:conv_long:4', 'Here is what I found.', true])
    expect(socket.sent.length).toBe(sent)
    expect(policy.CALL_END_REASONS).toEqual(['deadline', 'provider-closed', 'unclaimed', 'journal-unavailable'])
  })

  it('the provider hangs up the call itself (the SDK disconnects): carried too; the owner\'s Stop afterwards cuts it', async () => {
    const p = page('open')
    const socket = await p.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_long:5', transcript: 'keep going' })
    await settle()
    const [turn] = p.r.her.turns
    // A healthy call: the end comes past the open-drop window (2026-11-18), and is silent as before.
    await p.c.advance(policy.OPEN_DROP_MS)
    p.sdk().onDisconnect?.({ reason: 'agent' })
    await settle()
    expect(p.controller.state).toBe('idle')
    expect(p.notices).toEqual([])
    expect(turn?.signal.aborted).toBe(false)
    p.controller.stop()
    expect(turn?.signal.aborted).toBe(true)
  })

  it('at look-only the same end cuts her turn, as before; a cancel for barge-in cuts at any level', async () => {
    const p = page('look-only')
    const socket = await p.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_long:6', transcript: 'research this' })
    await settle()
    socket.deliver({ t: 'cancel', turn: 'eleven:conv_long:6', reason: 'provider-closed' })
    await settle()
    expect(p.r.her.turns[0]?.signal.aborted).toBe(true)
    const o = page('open')
    const door = await o.connect()
    door.deliver({ t: 'turn', turn: 'eleven:conv_long:7', transcript: 'research this' })
    await settle()
    door.deliver({ t: 'cancel', turn: 'eleven:conv_long:7', reason: 'superseded' })
    await settle()
    expect(o.r.her.turns[0]?.signal.aborted).toBe(true)
  })
})

describe('a turn that truly failed is never silent', () => {
  it('at open, a turn timed out with nothing said ends in fail VOICE_TURN_TIMEOUT, and the edge speaks the page\'s own words for it', async () => {
    const p = page('open')
    const socket = await p.connect()
    socket.deliver({ t: 'turn', turn: 'eleven:conv_long:8', transcript: 'think' })
    await settle()
    await p.c.advance(60_000)
    expect(socket.frames('delta')).toEqual([])
    expect(socket.frames('fail')).toEqual([{ t: 'fail', turn: 'eleven:conv_long:8', code: 'VOICE_TURN_TIMEOUT' }])
    // One line per code, the same words on both sides; the owner's own cut has none.
    expect(edge.FAIL_LINES.VOICE_TURN_TIMEOUT).toBe(policy.TURN_LINES.quiet)
    expect(edge.FAIL_LINES.VOICE_TURN_CEILING).toBe(policy.TURN_LINES.ceiling)
    expect(edge.FAIL_LINES.VOICE_TURN_FAILED).toBe(policy.TURN_LINES.flicker)
    expect(Object.hasOwn(edge.FAIL_LINES, 'VOICE_TURN_CANCELLED')).toBe(false)
    expect(policy.FAIL_CODES.cancelled).toBe('VOICE_TURN_CANCELLED')
  })

  it('a turn whose runner throws ends in fail VOICE_TURN_FAILED (the edge speaks one line); a done turn sends no fail', async () => {
    const c = clock()
    const sockets: FakeSocket[] = []
    const session = { endSession: async () => {}, setMicMuted: () => {}, getInputVolume: () => 0, getOutputVolume: () => 0, getId: () => 'conv_long' }
    const controller = createManagedConversation({
      timers: c.timers,
      request: async () => new Response(JSON.stringify({ token: 'p'.repeat(64), maxDurationSeconds: 1200 }), { status: 200 }),
      startSession: async (given: SdkConfig) => {
        given.onConversationCreated?.(session)
        given.onConnect?.()
        return session
      },
      openBridge: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
      runTurn: async (turn: Turn) => { if (turn.transcript === 'boom') throw new Error('x'); turn.say('Fine.'); return { ok: true } },
    })
    expect(await controller.start()).toBe('started')
    const socket = sockets[0] as FakeSocket
    socket.open()
    socket.deliver({ t: 'ready', conv: 'conv_long', maxDurationSeconds: 1200 })
    socket.deliver({ t: 'turn', turn: 'eleven:conv_long:9', transcript: 'boom' })
    socket.deliver({ t: 'turn', turn: 'eleven:conv_long:10', transcript: 'fine?' })
    await settle()
    expect(socket.frames('fail')).toEqual([{ t: 'fail', turn: 'eleven:conv_long:9', code: 'VOICE_TURN_FAILED' }])
    expect(socket.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_long:10' }])
  })
})

describe('review fixes (2026-11-14)', () => {
  it('bye names why the page ended the call: Stop, its own duration timer, the provider hanging up, an error', async () => {
    const stopped = page('open')
    const a = await stopped.connect()
    stopped.controller.stop()
    expect(a.frames('bye')).toEqual([{ t: 'bye', why: 'stop' }])
    // The page's own duration timer (a 60 s call, so the 50 ms meter does not make the clock crawl).
    const timed = page('open', 60)
    const b = await timed.connect()
    await timed.c.advance(59_999)
    expect(b.frames('bye')).toEqual([])
    await timed.c.advance(1)
    expect(b.frames('bye')).toEqual([{ t: 'bye', why: 'timer' }])
    expect(timed.notices).toEqual([policy.LINES.resting])
    const hung = page('open')
    const d = await hung.connect()
    await hung.c.advance(policy.OPEN_DROP_MS)
    hung.sdk().onModeChange?.({ mode: 'speaking' })
    hung.sdk().onDisconnect?.({ reason: 'agent' })
    expect(hung.notices).toEqual([])
    expect(d.frames('bye')).toEqual([{ t: 'bye', why: 'disconnected' }])
    const broke = page('open')
    const e = await broke.connect()
    broke.sdk().onDisconnect?.({ reason: 'error' })
    expect(e.frames('bye')).toEqual([{ t: 'bye', why: 'error' }])
    const erred = page('open')
    const f = await erred.connect()
    // the voice tools part 2: an SDK error alone no longer ends the call; with no sign of life for SDK_WATCH_MS it does.
    erred.sdk().onError?.('socket failed')
    expect(f.frames('bye')).toEqual([])
    await erred.c.advance(policy.SDK_WATCH_MS)
    expect(f.frames('bye')).toEqual([{ t: 'bye', why: 'error', sdk: 'socket' }])
  })

  it('a turn carried past its call is cut when he asks something new in the next call; the new turn runs and is answered', async () => {
    const p = page('open')
    const first = await p.connect()
    first.deliver({ t: 'turn', turn: 'eleven:conv_long:11', transcript: 'research this for an hour' })
    await settle()
    const [carried] = p.r.her.turns
    await p.c.advance(policy.OPEN_DROP_MS)
    p.sdk().onDisconnect?.({ reason: 'agent' })
    await settle()
    expect(p.notices).toEqual([])
    expect(carried?.signal.aborted).toBe(false)
    // The owner calls again and asks something else.
    const second = await p.connect()
    expect(second).not.toBe(first)
    second.deliver({ t: 'turn', turn: 'eleven:conv_long:12', transcript: 'what time is it' })
    await settle()
    expect(carried?.signal.aborted).toBe(true)
    const fresh = p.r.her.turns[1]
    expect(fresh?.signal.aborted).toBe(false)
    fresh?.write('Ten past nine.')
    fresh?.finish()
    await settle()
    expect(second.frames('delta')).toEqual([{ t: 'delta', turn: 'eleven:conv_long:12', seq: 0, text: 'Ten past nine.' }])
    expect(second.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_long:12' }])
    // Nothing of the cut carried turn goes up either door.
    expect([...first.sent, ...second.sent].some(frame => frame.turn === 'eleven:conv_long:11' && frame.t !== 'bye')).toBe(false)
  })
})

describe('a provider error alone no longer hangs up her call (the voice tools part 2, 2026-11-16)', () => {
  const SECRET = 'PROVIDER-WORDS-7f3a'
  const allText = (p: ReturnType<typeof page>) => JSON.stringify([p.sockets.map(socket => socket.sent), p.controller.status, p.notices])

  it('the closed kinds and the fixed table: the SDK words pick a kind, never travel', () => {
    expect(policy.SDK_ERROR_KINDS).toEqual(['socket', 'server', 'audio', 'permission', 'other'])
    expect(policy.SDK_WATCH_MS).toBe(20_000)
    expect(policy.classifySdkError('Server error: turn cancelled', { errorType: 'internal' })).toBe('server')
    expect(policy.classifySdkError('WebSocket closed unexpectedly')).toBe('socket')
    expect(policy.classifySdkError('Failed to start the audio worklet')).toBe('audio')
    expect(policy.classifySdkError('Permission denied by the user')).toBe('permission')
    expect(policy.classifySdkError('x', { type: 'connection' })).toBe('socket')
    expect(policy.classifySdkError('something odd')).toBe('other')
    expect(policy.classifySdkError(undefined)).toBe('other')
    expect(policy.classifySdkError({ toString: () => 'socket' })).toBe('other')
  })

  it('an onError on a live call does not end it; the next turn is answered; the reason is kept in closed fields', async () => {
    const p = page('open')
    const socket = await p.connect()
    await p.c.advance(7_000)
    p.sdk().onError?.(`Server error: ${SECRET}`, { errorType: 'internal', debugMessage: SECRET })
    await p.c.advance(5_000)
    expect(p.controller.state).not.toBe('idle')
    expect(socket.frames('bye')).toEqual([])
    expect(p.notices).toEqual([])
    socket.deliver({ t: 'turn', turn: 'eleven:conv_long:21', transcript: 'are you still there' })
    await settle()
    const [turn] = p.r.her.turns
    turn?.write('Still here.')
    turn?.finish()
    await settle()
    expect(socket.frames('done')).toEqual([{ t: 'done', turn: 'eleven:conv_long:21' }])
    expect(p.controller.status.sdk).toEqual({ errors: 1, lastErrorSeconds: 7, kind: 'server', disconnectReason: null, disconnectCode: null })
    // The turn frame was a sign of life: the watchdog is clear, the call is still up long after the window.
    await p.c.advance(60_000)
    expect(p.controller.state).not.toBe('idle')
    expect(socket.frames('bye')).toEqual([])
    expect(allText(p)).not.toContain(SECRET)
  })

  it('an onError followed by 20 s of nothing ends the call as before, with why error and the closed sdk kind', async () => {
    const p = page('open')
    const socket = await p.connect()
    p.sdk().onError?.(`${SECRET} websocket dropped`, { debugMessage: SECRET })
    await p.c.advance(policy.SDK_WATCH_MS - 1)
    expect(socket.frames('bye')).toEqual([])
    // A second error inside the window does not push the deadline back.
    p.sdk().onError?.(`Server error: ${SECRET}`)
    await p.c.advance(1)
    expect(socket.frames('bye')).toEqual([{ t: 'bye', why: 'error', sdk: 'server' }])
    expect(p.controller.state).toBe('idle')
    // CHANGED 2026-11-18: the call carried the override ('' opens silent) and the provider never showed life, so it is
    // a call dropped as it opened (auma-live-managed-voice.spec.ts covers the usual line after life).
    expect(p.notices).toEqual([policy.LINES.droppedOpening])
    // The last error came 19.999 s after the press: whole seconds, rounded down.
    expect(p.controller.status.sdk).toMatchObject({ errors: 2, kind: 'server', lastErrorSeconds: 19 })
    expect(allText(p)).not.toContain(SECRET)
  })

  it('a sign of life within the window clears the watchdog: her audio, a provider message or ping, a fresh transcript at the edge', async () => {
    const lives: Array<(p: ReturnType<typeof page>, socket: FakeSocket) => void> = [
      (p) => { p.sdk().onModeChange?.({ mode: 'speaking' }) },
      (p) => { p.sdk().onMessage?.({ role: 'user', message: 'hello?', event_id: 3 }) },
      (p) => { p.sdk().onPing?.({ event_id: 4, ping_ms: 80 }) },
      (_p, socket) => { socket.deliver({ t: 'turn', turn: 'eleven:conv_long:31', transcript: 'hi' }) },
      (_p, socket) => { socket.deliver({ t: 'cancel', turn: 'eleven:conv_long:32', reason: 'superseded' }) },
    ]
    for (const [index, life] of lives.entries()) {
      const p = page('open')
      const socket = await p.connect()
      p.sdk().onError?.('audio glitch')
      await p.c.advance(10_000)
      life(p, socket)
      // Past where the watchdog would have ended it (20 s after the error).
      await p.c.advance(12_000)
      expect(socket.frames('bye'), String(index)).toEqual([])
      expect(p.controller.state, String(index)).not.toBe('idle')
      // A later error arms it again, and with no life after it the call ends.
      p.sdk().onError?.('audio glitch')
      await p.c.advance(policy.SDK_WATCH_MS)
      expect(socket.frames('bye'), String(index)).toEqual([{ t: 'bye', why: 'error', sdk: 'audio' }])
    }
  }, 30_000)

  it('review 2026-11-16: the provider\'s pings keep a quiet call up after an error, through his interruption and a long silence', async () => {
    const p = page('open')
    const socket = await p.connect()
    p.sdk().onInterruption?.()
    p.sdk().onError?.('Server error: turn cancelled')
    // He thinks quietly for a minute; the provider pings every few seconds.
    for (let at = 0; at < 60_000; at += 5_000) { await p.c.advance(5_000); p.sdk().onPing?.({ event_id: at, ping_ms: 90 }) }
    expect(socket.frames('bye')).toEqual([])
    expect(p.controller.state).not.toBe('idle')
    expect(p.notices).toEqual([])
  })

  it('review 2026-11-16: an error before the connect completes is cleared by the connect itself', async () => {
    const p = page('open', 1200, (given) => { given.onError?.('Server error: warming up') })
    const socket = await p.connect()
    await p.c.advance(policy.SDK_WATCH_MS * 3)
    expect(socket.frames('bye')).toEqual([])
    expect(p.controller.state).not.toBe('idle')
    expect(p.controller.status.sdk).toMatchObject({ errors: 1, kind: 'server' })
  })

  it('review 2026-11-16: what does not prove the provider alive leaves the watchdog armed', async () => {
    const notLife: Array<(p: ReturnType<typeof page>, socket: FakeSocket) => void> = [
      // Her audio stopping flips the mode to listening: the symptom, not life.
      (p) => { p.sdk().onModeChange?.({ mode: 'listening' }) },
      // The edge's own fast voice, timers and call end, and a malformed frame.
      (_p, socket) => { socket.deliver({ t: 'spoken', turn: 'eleven:conv_long:40', heard: 'hi', said: 'Hello.' }) },
      (_p, socket) => { socket.deliver({ t: 'tool_cancel', turn: 'eleven:conv_long:41' }) },
      (_p, socket) => { socket.deliver({ t: 'cancel', turn: 'eleven:conv_long:42', reason: 'provider-closed' }) },
      (_p, socket) => { socket.deliver({ t: 'tool', turn: 'nope', call: 7 }) },
    ]
    for (const [index, sign] of notLife.entries()) {
      const p = page('open')
      const socket = await p.connect()
      p.sdk().onModeChange?.({ mode: 'speaking' })
      p.sdk().onError?.('Server error')
      await p.c.advance(800)
      sign(p, socket)
      await p.c.advance(policy.SDK_WATCH_MS)
      expect(socket.frames('bye'), String(index)).toEqual([{ t: 'bye', why: 'error', sdk: 'server' }])
      expect(p.controller.state, String(index)).toBe('idle')
    }
  }, 30_000)

  it('a real onDisconnect with reason error still ends it at once; its closed reason and close code are kept', async () => {
    const p = page('open')
    const socket = await p.connect()
    p.sdk().onDisconnect?.({ reason: 'error', message: SECRET, context: { type: 'close', reason: SECRET, code: 1011 }, closeCode: 1006, closeReason: SECRET })
    expect(socket.frames('bye')).toEqual([{ t: 'bye', why: 'error' }])
    expect(p.controller.state).toBe('idle')
    // CHANGED 2026-11-18: no provider life before this end on a call that carried the override: dropped as it opened.
    expect(p.notices).toEqual([policy.LINES.droppedOpening])
    expect(p.controller.status.sdk).toEqual({ errors: 0, lastErrorSeconds: null, kind: null, disconnectReason: 'error', disconnectCode: 1006 })
    expect(allText(p)).not.toContain(SECRET)
    // After an error inside the window, the disconnect ends it at once and the bye carries the kind.
    const q = page('open')
    const second = await q.connect()
    q.sdk().onError?.('WebSocket error')
    q.sdk().onDisconnect?.({ reason: 'agent', context: { type: 'close', code: 4000 } })
    expect(second.frames('bye')).toEqual([{ t: 'bye', why: 'disconnected', sdk: 'socket' }])
    expect(q.controller.status.sdk).toMatchObject({ disconnectReason: 'agent', disconnectCode: 4000 })
    // A reason outside the closed list, or a code that is not a whole number, is not kept.
    const r = page('open')
    await r.connect()
    r.sdk().onDisconnect?.({ reason: SECRET, closeCode: 'x' })
    expect(r.controller.status.sdk).toMatchObject({ disconnectReason: null, disconnectCode: null })
  })

  it('a new press starts the counts again; the override-refused retry is checked first and still retries', async () => {
    const p = page('open')
    const a = await p.connect()
    p.sdk().onError?.('socket closed')
    p.controller.stop()
    expect(a.frames('bye')).toEqual([{ t: 'bye', why: 'stop', sdk: 'socket' }])
    await p.connect()
    expect(p.controller.status.sdk).toEqual({ errors: 0, lastErrorSeconds: null, kind: null, disconnectReason: null, disconnectCode: null })
    // The override refusal (before the tab door is ready) is not counted and not watched: the press retries without it.
    const q = page('open')
    expect(await q.controller.start()).toBe('started')
    const first = q.sdk()
    first.onError?.('first_message override is not allowed for this agent')
    await settle()
    expect(q.sockets).toHaveLength(2)
    expect(q.controller.status.sdk.errors).toBe(0)
    await q.c.advance(policy.SDK_WATCH_MS * 2)
    expect(q.notices).toEqual([policy.LINES.connect])
  })
})
