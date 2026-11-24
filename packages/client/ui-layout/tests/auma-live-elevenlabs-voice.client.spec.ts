/**
 * Auma Live speaks in her ElevenLabs voice (apps/web/public/app/elevenlabs-voice.js) while Deepgram keeps the ears and
 * stays the fallback. `speechSocketFor` wraps the Deepgram socket and takes over only the speech of one voice. Every
 * rule is tested here without the network: a fake WebSocket plays ElevenLabs (and, through the REAL deepgram-voice.js
 * where the pass-through is the point, Deepgram), a fake fetch plays the edge, and a fake clock runs every timer. Waits
 * are on an explicit state with a time limit that fails loudly, never on a count of Promise turns. What ElevenLabs
 * really answers is NOT verified here.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'

const appPath = (name: string) => ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}apps/web/public/app/${name}`)).find(existsSync) ?? `apps/web/public/app/${name}`
interface VoiceSocket {
  readyState: number
  cloud: string | null
  herVoiceLine: string | null
  herEcho: (transcript: string, audible: boolean, isSelfEcho: (heard: string, spoken: string) => boolean) => boolean
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  send(data: string | ArrayBuffer): void
  close(): void
}
type Factory = (url: string, deps: Record<string, unknown>) => VoiceSocket
const eleven = await import(pathToFileURL(appPath('elevenlabs-voice.js')).href) as {
  speechSocketFor: Factory
  phraseCut: (tail: string, first: boolean) => number
  showHerVoiceLine: (list: unknown, socket: unknown) => void
  ELEVEN_VOICE_PICK: string
  ELEVEN_NOTICES: { speaking: string; didNotAnswer: string; notConfirming: string }
  HER_VOICE_HINT: string
  FIRST_AUDIO_MS: number
  QUIET_BACKSTOP_MS: number
  CEILING_GRACE_MS: number
  REOPEN_SPACING_MS: number
  REPORT_RETRY_MS: number
  REPORT_ATTEMPTS: number
  ECHO_TAIL_MS: number
}
const deepgram = await import(pathToFileURL(appPath('deepgram-voice.js')).href) as {
  voiceSocketFor: Factory
  forgetNoPass: () => void
  DEEPGRAM_VOICES: readonly { id: string }[]
}
const duplex = await import(pathToFileURL(appPath('aumalive-duplex.js')).href) as { isSelfEcho: (heard: string, spoken: string) => boolean }

/** Waits on an explicit state, in real time, and fails loudly when it does not come. */
async function until(condition: () => boolean, label: string, limitMs = 2000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (condition()) return
    if (Date.now() - started > limitMs) throw new Error(`timed out after ${String(limitMs)} ms waiting for: ${label}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** Every address this file's code fetched or opened, for rule 9. */
const addresses: string[] = []

class Upstream {
  static all: Upstream[] = []
  binaryType = ''
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  sent: Array<string | ArrayBuffer> = []
  constructor(readonly url: string, readonly protocols?: string[]) { Upstream.all.push(this); addresses.push(url) }
  send(data: string | ArrayBuffer) { this.sent.push(data) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  json(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
  audio(bytes: number[]) { this.onmessage?.({ data: Uint8Array.from(bytes).buffer }) }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }) }
  get said() { return this.sent.filter((item): item is string => typeof item === 'string').map(item => JSON.parse(item) as Record<string, unknown>) }
}
const elevenSockets = () => Upstream.all.filter(socket => socket.url.startsWith('wss://api.elevenlabs.io/'))

/** The inner socket where the pass-through is not the point. Like deepgram-voice.js it asks its pass first (that answer
 * says whether her voice is set up), records what it is sent, and answers a cancel at once. */
class StubInner {
  readyState = 1
  cloud: string | null = 'Deepgram'
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  sent: Array<string | ArrayBuffer> = []
  send(data: string | ArrayBuffer) {
    this.sent.push(data)
    if (typeof data === 'string' && (JSON.parse(data) as { t: string }).t === 'tts_cancel') this.emit({ t: 'tts_cancelled' })
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }
  emit(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
  get said() { return this.sent.filter((item): item is string => typeof item === 'string').map(item => JSON.parse(item) as Record<string, unknown>) }
}

const PASS = 'sutkn_' + 'q'.repeat(30)
const DG_PASS = 'p'.repeat(40)
const VOICE_ID = 'VoiceId_12345'
const URL_ = 'wss://x61.example.invalid/stock-apps/auma-live/voice?owner=0000000000001:a:000001'
const NOON = Date.UTC(2026, 10, 13, 12, 0, 0)
const USAGE = { day: '2026-11-13', chars: 1200, counted: 6200, maxChars: 100000, cost: 0.048, maxCost: 4, pricePer1k: 0.04, slice: 5000 }
const GRANT = { ok: true, provider: 'elevenlabs', pass: PASS, voiceId: VOICE_ID, modelId: 'eleven_flash_v2_5', reservation: '2026-11-13.1', usage: USAGE }
const DG_ANSWER = { ok: true, provider: 'deepgram', accessToken: DG_PASS, expiresInSeconds: 30 }
const INNER_READY = { t: 'ready', voices: deepgram.DEEPGRAM_VOICES, default_voice: 'flux-sienna-en', cloud: 'Deepgram' }
const HER_ENTRY = { id: eleven.ELEVEN_VOICE_PICK, label: 'Her voice', hint: 'ElevenLabs Flash v2.5 · provider limit: set on the key', engine: 'elevenlabs' }
const SOCKET_URL = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/multi-stream-input?model_id=eleven_flash_v2_5`
  + `&output_format=pcm_24000&inactivity_timeout=180&auto_mode=true&single_use_token=${PASS}`
const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64')

type Answer = Response | 'hang' | 'throw'
interface Options {
  inner?: 'stub' | 'deepgram'
  herVoice?: unknown
  eleven?: () => Answer
  usageAnswer?: () => Answer
  at?: number
  usage?: typeof USAGE
  grant?: Record<string, unknown>
  extend?: (body: Record<string, unknown>) => Answer | Promise<Response>
  resetInSeconds?: number
  /** The page session the wrapper keeps across voice sockets; 'page' leaves it to the module (what the app does). */
  session?: { steppedAside: boolean } | 'page'
  /** The module to build the wrapper from (a fresh copy, for the module's own page session). */
  module?: { speechSocketFor: Factory }
}
/** A ceiling refusal as the edge words it. */
const ceilingRefusal = (setting: string, resetInSeconds: number, day = '2026-11-13') => Response.json({ ok: false, code: 'ELEVEN_SPEECH_CEILING', setting, day, resetInSeconds }, { status: 429 })
const harness = (options: Options = {}) => {
  // Two clocks: `at` is the page's calendar (passed on as `now`, which the wrapper never reads), `tick` is elapsed time
  // (`monotonic`), which every timer runs on.
  let at = options.at ?? NOON
  let tick = 0
  const timers: Array<{ fn: () => void; due: number; ms: number }> = []
  interface Asked { action: string; body: Record<string, unknown>; signal: AbortSignal | undefined; keepalive: unknown; answered: boolean }
  const asked: Asked[] = []
  let passesRead = 0
  let minted = 0
  // The edge, as far as slices go: what the day counts and what each pass has reserved, by the edge's own rule.
  const edgeUsage = options.usage ?? USAGE
  const edge = { counted: edgeUsage.counted, granted: [] as Array<{ reservation: string; reserved: number }> }
  const edgeCeiling = () => {
    const next = edge.counted + edgeUsage.slice
    if (next > edgeUsage.maxChars) return 'ELEVENLABS_MAX_CHARS_PER_DAY'
    if (next / 1000 * edgeUsage.pricePer1k > edgeUsage.maxCost + 1e-9) return 'ELEVENLABS_MAX_COST_PER_DAY'
    return null
  }
  const stub = new StubInner()
  const page = new EventTarget()
  const fetchImpl = async (path: string, init: { body: string; signal?: AbortSignal; keepalive?: unknown }) => {
    addresses.push(path)
    const body = JSON.parse(init.body) as Record<string, unknown>
    const entry = { action: String(body.action), body, signal: init.signal, keepalive: init.keepalive, answered: false }
    asked.push(entry)
    try {
      if (body.action === 'speech_pass') {
        const answer = { ...DG_ANSWER, ...(options.herVoice === undefined ? { herVoice: { configured: true } } : options.herVoice === 'absent' ? {} : { herVoice: options.herVoice }) }
        const response = Response.json(answer)
        const clone = response.clone.bind(response)
        // Counts when the wrapper has read its copy of this answer: the explicit state the tests wait on.
        const copied = () => {
          const copy = clone()
          const json = copy.json.bind(copy)
          return Object.assign(copy, { json: () => json().finally(() => { passesRead += 1 }) })
        }
        return Object.assign(response, { clone: copied })
      }
      if (body.action === 'speech_usage') {
        const answer = options.usageAnswer ? options.usageAnswer() : Response.json({ ok: true, action: 'speech_usage' })
        if (answer === 'hang') { entry.answered = true; return await new Promise<Response>(() => {}) }
        if (answer === 'throw') throw new TypeError('network')
        return answer
      }
      if (body.action === 'speech_extend') {
        const answer = options.extend ? await options.extend(body) : (() => {
          const pass = edge.granted.find(item => item.reservation === body.reservation)
          if (!pass) return Response.json({ ok: false, code: 'ELEVEN_SPEECH_USAGE_STALE' }, { status: 400 })
          const setting = edgeCeiling()
          if (setting) return ceilingRefusal(setting, options.resetInSeconds ?? 43200)
          edge.counted += edgeUsage.slice
          pass.reserved += edgeUsage.slice
          return Response.json({ ok: true, action: 'speech_extend', reservation: pass.reservation, reserved: pass.reserved, usage: { ...edgeUsage, counted: edge.counted } })
        })()
        if (answer === 'hang') { entry.answered = true; return await new Promise<Response>(() => {}) }
        if (answer === 'throw') throw new TypeError('network')
        return answer
      }
      minted += 1
      const emulated = () => {
        // The first pass's slice is already in the usage the test gave; each later pass reserves one more.
        if (edge.granted.length > 0) {
          const setting = edgeCeiling()
          if (setting) return ceilingRefusal(setting, options.resetInSeconds ?? 43200)
          edge.counted += edgeUsage.slice
        }
        const reservation = `2026-11-13.${String(minted)}`
        edge.granted.push({ reservation, reserved: edgeUsage.slice })
        return Response.json({ ...GRANT, reservation, usage: { ...edgeUsage, counted: edge.counted }, ...options.grant })
      }
      const answer = (options.eleven ?? emulated)()
      if (answer === 'hang') { entry.answered = true; return await new Promise<Response>(() => {}) }
      if (answer === 'throw') throw new TypeError('network')
      return answer
    } finally { entry.answered = true }
  }
  const deps: Record<string, unknown> = {
    WebSocketImpl: Upstream, BroadcastChannelImpl: undefined, fetchImpl, pageEvents: page,
    now: () => at, monotonic: () => tick,
    setTimer: (fn: () => void, ms: number) => { const timer = { fn, due: tick + ms, ms }; timers.push(timer); return timer },
    clearTimer: (handle: unknown) => { const index = timers.indexOf(handle as never); if (index >= 0) timers.splice(index, 1) },
    inner: options.inner === 'deepgram' ? deepgram.voiceSocketFor : (_url: string, innerDeps: { fetchImpl: typeof fetchImpl }) => {
      void innerDeps.fetchImpl('/_host/voice', { body: JSON.stringify({ action: 'speech_pass' }) }).then(response => response.json())
      return stub
    },
  }
  // Each test is its own page session unless it says otherwise.
  if (options.session !== 'page') deps.session = options.session ?? { steppedAside: false }
  const received: unknown[] = []
  const socket = (options.module ?? eleven).speechSocketFor(URL_, deps)
  socket.onmessage = (event) => { received.push(typeof event.data === 'string' ? JSON.parse(event.data) : new Uint8Array(event.data as ArrayBuffer)) }
  /** Runs the fake clock to `ms` later, firing each timer due on the way, and lets what each one starts settle. */
  const advance = async (ms: number) => {
    const end = tick + ms
    for (;;) {
      timers.sort((a, b) => a.due - b.due)
      const next = timers[0]
      if (!next || next.due > end) break
      timers.shift(); at += next.due - tick; tick = next.due; next.fn()
      await until(() => asked.every(entry => entry.answered), 'every request answered')
    }
    at += end - tick
    tick = end
  }
  const types = () => received.map(item => (item instanceof Uint8Array ? `pcm:${String(item.length)}` : (item as { t: string }).t))
  const binaries = () => received.filter(item => item instanceof Uint8Array).length
  const notices = () => received.filter((item): item is { t: string; say: string } => !(item instanceof Uint8Array) && (item as { t: string }).t === 'speech_notice').map(item => item.say)
  const tts = (id: number, text: string, first = false, voice = eleven.ELEVEN_VOICE_PICK) => {
    socket.send(JSON.stringify({ t: 'tts', id, text, voice, speed: 1, first }))
  }
  const passes = () => asked.filter(entry => entry.action === 'speech_pass_tts')
  const extends_ = () => asked.filter(entry => entry.action === 'speech_extend')
  const reports = () => asked.filter(entry => entry.action === 'speech_usage').map(entry => entry.body)
  /** The largest cumulative total reported for a pass (reports carry the pass's total so far, not a delta). */
  const total = (reservation: string) => Math.max(0, ...reports().filter(report => report.reservation === reservation)
    .map(report => report.chars as number))
  return { socket, stub, page, asked, received, types, binaries, notices, advance, tts, passes, extends: extends_, reports, total,
    timers, edge, settled: () => asked.every(entry => entry.answered), passRead: () => passesRead > 0, now: () => at, tick: () => tick,
    setNow: (value: number) => { at = value }, clear: () => { received.length = 0 } }
}
/** A wrapper over the stub whose ElevenLabs voice was offered, with its socket open. */
const chosen = async (options: Options = {}) => {
  const h = harness(options)
  await until(h.passRead, 'the Deepgram pass answer read')
  h.stub.emit(INNER_READY)
  await until(() => elevenSockets().length > 0, 'her socket opened')
  elevenSockets().at(-1)?.open()
  h.clear()
  return h
}
const said = (socket: Upstream | undefined) => socket?.said ?? []
const texts = (socket: Upstream | undefined) => said(socket).filter(message => typeof message.text === 'string')

beforeEach(() => { Upstream.all = []; deepgram.forgetNoPass() })

describe('not configured means exactly main', () => {
  /** The same Deepgram session, through deepgram-voice.js alone and through the wrapper; every request, every socket
   * and frame sent, every message delivered with the fake clock's time, and every timer set, recorded. */
  const script = async (wrap: boolean, herVoice: unknown) => {
    Upstream.all = []
    deepgram.forgetNoPass()
    let at = 5_000
    const timers: Array<{ fn: () => void; due: number; ms: number }> = []
    const timersSet: number[] = []
    const requests: string[] = []
    const delivered: Array<[number, unknown]> = []
    let answered = 0
    const fetchImpl = async (path: string, init: { body: string }) => {
      requests.push(`${path} ${init.body}`)
      answered += 1
      return Response.json({ ...DG_ANSWER, ...(herVoice === 'absent' ? {} : { herVoice }) })
    }
    const deps = { WebSocketImpl: Upstream, BroadcastChannelImpl: undefined, fetchImpl, now: () => at,
      setTimer: (fn: () => void, ms: number) => {
        const timer = { fn, due: at + ms, ms }
        timers.push(timer); timersSet.push(ms)
        return timer
      },
      clearTimer: (handle: unknown) => { const index = timers.indexOf(handle as never); if (index >= 0) timers.splice(index, 1) },
      inner: deepgram.voiceSocketFor }
    const socket = wrap ? eleven.speechSocketFor(URL_, deps) : deepgram.voiceSocketFor(URL_, deps)
    socket.onmessage = (event) => { delivered.push([at, typeof event.data === 'string' ? JSON.parse(event.data) : [...new Uint8Array(event.data as ArrayBuffer)]]) }
    await until(() => Upstream.all.some(item => item.url.includes('/v1/listen')), 'the listening socket opened')
    const listen = Upstream.all.find(item => item.url.includes('/v1/listen'))
    at += 7_500                                     // Deepgram answers late: 7.5 s, just inside the 8 s organ wait
    listen?.open()
    await until(() => delivered.length === 1, 'ready delivered')
    await until(() => Upstream.all.some(item => item.url.includes('/v2/speak')), 'the speaking socket opened')
    const speak = Upstream.all.find(item => item.url.includes('/v2/speak'))
    speak?.open(); speak?.json({ type: 'Connected', model_name: 'sienna' })
    socket.send(Uint8Array.of(1, 2, 3, 4).buffer)
    listen?.json({ type: 'SpeechStarted' })
    listen?.json({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'hello Auma' }] } })
    socket.send(JSON.stringify({ t: 'tts', id: 1, text: 'Hello the owner.', voice: 'flux-sienna-en', speed: 1, first: true }))
    await until(() => speak?.said.some(message => message.type === 'Flush') === true, 'the sentence sent to Deepgram')
    speak?.json({ type: 'SpeechStarted', speech_id: 's1' })
    speak?.audio([1, 0, 2, 0])
    speak?.json({ type: 'SpeechMetadata', speech_id: 's1' })
    socket.send(JSON.stringify({ t: 'tts', id: 2, text: 'And more.', voice: 'flux-sienna-en', speed: 1, first: false }))
    socket.send(JSON.stringify({ t: 'tts_cancel' }))
    for (let step = 0; step < 6; step += 1) {        // 30 s of keep-alives and timeouts
      timers.sort((a, b) => a.due - b.due)
      const next = timers.shift()
      if (!next) break
      at = next.due; next.fn()
    }
    const sockets = Upstream.all.map(item => ({ url: item.url, protocols: item.protocols, sent: item.sent.map(data => (typeof data === 'string' ? data : [...new Uint8Array(data)])) }))
    return { socket, requests, delivered, sockets, timersSet, answered }
  }
  for (const [name, herVoice, line] of [
    ['the deployed edge (no field: neither setting present)', 'absent', 'Her voice is not set up: ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are missing'],
    ['the key missing', { configured: false, missing: ['ELEVENLABS_API_KEY'] }, 'Her voice is not set up: ELEVENLABS_API_KEY is missing'],
    ['the voice id missing', { configured: false, missing: ['ELEVENLABS_VOICE_ID'] }, 'Her voice is not set up: ELEVENLABS_VOICE_ID is missing'],
  ] as const) {
    it(`${name}: the same requests, frames, messages at the same times, and timers as deepgram-voice.js alone`, async () => {
      const alone = await script(false, herVoice)
      const wrapped = await script(true, herVoice)
      expect(wrapped.requests).toEqual(alone.requests)
      expect(wrapped.requests).toEqual(['/_host/voice {"action":"speech_pass"}', '/_host/voice {"action":"speech_pass"}'])
      expect(wrapped.sockets).toEqual(alone.sockets)
      expect(wrapped.delivered).toEqual(alone.delivered)
      expect(wrapped.timersSet).toEqual(alone.timersSet)
      // Readiness is released at the very moment Deepgram's is, so the 8 s organ wait sees exactly what it sees on main.
      expect(wrapped.delivered[0]).toEqual([12_500, INNER_READY])
      expect(alone.delivered.map(([, item]) => (Array.isArray(item) ? 'pcm' : (item as { t: string }).t)))
        .toEqual(['ready', 'vad', 'final', 'tts_begin', 'pcm', 'tts_end', 'tts_cancelled'])
      // The one line naming the missing setting is for the voice list only.
      expect(wrapped.socket.herVoiceLine).toBe(line)
      expect(JSON.stringify(wrapped.delivered)).not.toContain('ELEVENLABS')
    })
  }

  it('the line is put first in the voice list, and only there; nothing when there is nothing to say', () => {
    interface Made {
      className: string
      attributes: Record<string, string>
      textContent: string
      title: string
      removed: boolean
      remove: () => void
      setAttribute: (name: string, value: string) => void
    }
    const made: Made[] = []
    const list = {
      children: [] as unknown[],
      ownerDocument: { createElement: () => {
        const node = { className: '', attributes: {} as Record<string, string>, textContent: '', title: '', removed: false,
          remove() { node.removed = true; list.children = list.children.filter(child => child !== node) },
          setAttribute(name: string, value: string) { node.attributes[name] = value } }
        made.push(node); return node
      } },
      querySelector: (selector: string) => (selector === '[data-her-voice-line]' ? made.find(node => !node.removed && 'data-her-voice-line' in node.attributes) ?? null : null),
      prepend(node: unknown) { list.children.unshift(node) },
    }
    eleven.showHerVoiceLine(list, { herVoiceLine: 'Her voice is not set up: ELEVENLABS_API_KEY is missing' })
    expect(list.children).toHaveLength(1)
    expect(made[0]).toMatchObject({ className: 'alv-vhint', textContent: 'Her voice is not set up: ELEVENLABS_API_KEY is missing' })
    eleven.showHerVoiceLine(list, { herVoiceLine: 'Her voice today: 10 characters by this app\'s count (estimate $0.00)' })
    expect(list.children).toHaveLength(1)
    expect(made[1]?.textContent).toBe('Her voice today: 10 characters by this app\'s count (estimate $0.00)')
    eleven.showHerVoiceLine(list, { herVoiceLine: null })
    eleven.showHerVoiceLine(list, null)
    expect(list.children).toHaveLength(0)
  })

  it('no Deepgram (the local sidecar answers): nothing is asked and nothing changes', async () => {
    const h = harness()
    await until(h.passRead, 'the pass answer read')
    h.stub.cloud = null
    const sidecarReady = { t: 'ready', voices: [{ id: 'auma', label: 'Auma', hint: '', engine: 'pocket' }], default_voice: 'auma' }
    h.stub.emit(sidecarReady)
    expect(h.received).toEqual([sidecarReady])
    h.tts(1, 'Hello.', true, 'auma')
    expect(h.stub.said).toEqual([{ t: 'tts', id: 1, text: 'Hello.', voice: 'auma', speed: 1, first: true }])
    expect(h.passes()).toEqual([])
  })
})

describe('her voice set up: offered at once, never held', () => {
  it('ready is delivered the moment the inner socket says it, with "Her voice" first and the default, while the pass is still being asked', async () => {
    const h = harness({ eleven: () => 'hang' })
    await until(h.passRead, 'the pass answer read')
    h.stub.emit(INNER_READY)
    const offered = { ...INNER_READY, default_voice: eleven.ELEVEN_VOICE_PICK, voices: [HER_ENTRY, ...deepgram.DEEPGRAM_VOICES] }
    expect(h.received).toEqual([offered])
    expect(HER_ENTRY.hint).toBe(eleven.HER_VOICE_HINT)
    await until(() => h.passes().length === 1, 'the pass asked for')
    expect(h.passes()[0]?.body).toEqual({ action: 'speech_pass_tts' })
    expect(elevenSockets()).toEqual([])
    // The request itself is cut at 5 s.
    const signal = h.passes()[0]?.signal
    await h.advance(4999)
    expect(signal?.aborted).toBe(false)
    await h.advance(1)
    expect(signal?.aborted).toBe(true)
  })

  it('a pass: the socket opens at once, she says so once, and the list line is today\'s count by this app', async () => {
    const h = harness()
    await until(h.passRead, 'the pass answer read')
    h.stub.emit(INNER_READY)
    await until(() => elevenSockets().length === 1, 'her socket opened')
    expect(elevenSockets().map(socket => socket.url)).toEqual([SOCKET_URL])
    expect(h.notices()).toEqual([eleven.ELEVEN_NOTICES.speaking])
    expect(h.socket.herVoiceLine).toBe('Her voice today: 1,200 characters by this app\'s count (estimate $0.05)')
    // No word on screen says the ceiling is a guarantee or names a provider limit as a number.
    expect(`${String(h.socket.herVoiceLine)} ${HER_ENTRY.hint}`).not.toMatch(/guarantee|never more than|at most|capped at/i)
  })

  it('the pass is only ever in the socket URL', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'Hello there.', true)
    socket?.json({ audio: b64([1, 0, 2, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    await until(() => h.reports().length > 0, 'a usage report')
    expect(socket?.url).toBe(SOCKET_URL)
    expect(JSON.stringify(h.received.filter(item => !(item instanceof Uint8Array)))).not.toContain(PASS)
    expect(said(socket).map(message => JSON.stringify(message)).join('\n')).not.toContain(PASS)
    expect(h.stub.said.map(message => JSON.stringify(message)).join('\n')).not.toContain(PASS)
    expect(JSON.stringify(h.reports())).not.toContain(PASS)
    expect(socket?.protocols).toBeUndefined()
  })

  for (const [name, answer] of [
    ['a malformed pass', () => Response.json({ ...GRANT, pass: 'has space in it' })],
    ['a bad voice id', () => Response.json({ ...GRANT, voiceId: '../../x' })],
    ['no reservation', () => Response.json({ ...GRANT, reservation: undefined })],
    ['no usage', () => Response.json({ ...GRANT, usage: null })],
    ['a provider failure', () => Response.json({ ok: false, code: 'ELEVEN_SPEECH_PROVIDER_FAILED' }, { status: 502 })],
    ['a network failure', () => 'throw' as const],
  ] as const) {
    it(`${name}: no socket; her first reply, waiting on that pass, goes to Deepgram, said once`, async () => {
      const h = harness({ eleven: answer })
      await until(h.passRead, 'the pass answer read')
      h.stub.emit(INNER_READY)
      h.tts(1, 'Hello there.', true)
      await until(() => h.stub.said.some(message => message.t === 'tts'), 'Deepgram speaks it')
      expect(elevenSockets()).toEqual([])
      expect(h.passes()).toHaveLength(1)
      expect(h.stub.said.filter(message => message.t === 'tts')).toEqual([{ t: 'tts', id: 1, text: 'Hello there.', voice: 'flux-sienna-en', speed: 1, first: false }])
      expect(h.notices()).toEqual([eleven.ELEVEN_NOTICES.didNotAnswer])
    })
  }
})

describe('rule 3: phraseCut, the only cadence for her voice', () => {
  const table: Array<[string, boolean, number]> = [
    ['', true, 0],
    ['Hello there', true, 0],
    ['Hello there.', true, 0],
    ['I counted to 3.', true, 0],
    ['I counted to 3. Then', true, 15],
    ['Hello there. How are you? Fine', true, 12],
    ['Hello there. How are you? Fine', false, 25],
    ['She said "go." And went', true, 14],
    ['Wait! ', true, 5],
    ['Well, I think so', true, 0],
    ['Well, I think that this is right, and so', true, 33],
    ['Well, I think that this is right, and so, then', true, 33],
    ['Well, I think that this is right, and so, then', false, 0],
    [`${'word '.repeat(13)}more, and the rest of it goes on`, false, 70],
    ['word '.repeat(30), true, 119],
    ['word '.repeat(20), true, 0],
    ['word '.repeat(50), false, 219],
    ['word '.repeat(40), false, 0],
  ]
  for (const [tail, first, expected] of table) {
    it(`${JSON.stringify(tail.length > 40 ? `${tail.slice(0, 40)}…(${String(tail.length)})` : tail)} first=${String(first)} -> ${String(expected)}`, () => {
      expect(eleven.phraseCut(tail, first)).toBe(expected)
    })
  }
})

describe('one phrase in flight; a phrase is heard only when ITS audio arrived', () => {
  // MUST 3: the two variants ended by a short silence (QUIET_END_MS) are gone with that rule; the backstop has
  // its own tests below.
  for (const camel of [true, false]) {
    it(`three phrases, one at a time, each in its own context, ended by final (${camel ? 'contextId/isFinal' : 'context_id/is_final'})`, async () => {
      const h = await chosen()
      const socket = elevenSockets()[0]
      const ctx = (id: string) => (camel ? { contextId: id } : { context_id: id })
      const end = async (id: string) => { socket?.json(camel ? { isFinal: true, contextId: id } : { is_final: true, context_id: id }) }
      h.tts(1, 'Hello there.', true)
      h.tts(2, 'How are you?')
      h.tts(3, 'I am well.')
      // Only the first is sent, its context closed at once (review); the others wait for its end.
      expect(said(socket)).toEqual([{ text: 'Hello there. ', context_id: 'auma-1', flush: true }, { context_id: 'auma-1', close_context: true }])
      socket?.json({ audio: b64([1, 0, 2]), ...ctx('auma-1') })
      socket?.json({ audio: b64([0, 3, 0]), ...ctx('auma-1') })
      await end('auma-1')
      expect(said(socket).slice(2)).toEqual([{ text: 'How are you? ', context_id: 'auma-2', flush: true }, { context_id: 'auma-2', close_context: true }])
      // A late frame of the first context is not the second's.
      socket?.json({ audio: b64([9, 9]), ...ctx('auma-1') })
      socket?.json({ audio: b64([4, 0]), ...ctx('auma-2') })
      await end('auma-2')
      socket?.json({ audio: b64([5, 0]), ...ctx('auma-3') })
      await end('auma-3')
      expect(texts(socket).map(message => message.text)).toEqual(['Hello there. ', 'How are you? ', 'I am well. '])
      expect(h.types()).toEqual(['tts_begin', 'pcm:2', 'pcm:4', 'tts_end', 'tts_begin', 'pcm:2', 'tts_end', 'tts_begin', 'pcm:2', 'tts_end'])
      expect(h.received.filter(item => !(item instanceof Uint8Array)).map(item => (item as { id: number }).id)).toEqual([1, 1, 2, 2, 3, 3])
      expect([...h.received[2] as Uint8Array]).toEqual([2, 0, 3, 0])
      await until(() => h.reports().length > 0, 'the turn reported')
    })
  }

  it('his sequence: A and B accepted, only A\'s first audio, then a disconnect: B is sent once on the new socket, A is ended and never resent', async () => {
    const h = await chosen()
    const first = elevenSockets()[0]
    h.tts(1, 'Phrase A is here.', true)
    h.tts(2, 'Phrase B follows.')
    first?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    expect(texts(first).map(message => message.text)).toEqual(['Phrase A is here. '])
    first?.drop()
    await until(() => elevenSockets().length === 2, 'a new socket')
    const second = elevenSockets()[1]
    second?.open()
    expect(texts(second)).toEqual([{ text: 'Phrase B follows. ', context_id: 'auma-2', flush: true }])
    second?.json({ audio: b64([2, 0]), contextId: 'auma-2' })
    second?.json({ isFinal: true, contextId: 'auma-2' })
    expect(h.types()).toEqual(['tts_begin', 'pcm:2', 'tts_end', 'tts_begin', 'pcm:2', 'tts_end'])
    expect(h.received.filter(item => !(item instanceof Uint8Array)).map(item => (item as { id: number }).id)).toEqual([1, 1, 2, 2])
    expect(h.stub.said.filter(message => message.t === 'tts')).toEqual([])
    expect([...texts(first), ...texts(second)].filter(message => message.text === 'Phrase B follows. ')).toHaveLength(1)
  })

  it('his sequence when the new socket fails too: B is spoken by Deepgram, once; A is not', async () => {
    const h = await chosen()
    h.tts(1, 'Phrase A is here.', true)
    h.tts(2, 'Phrase B follows.')
    elevenSockets()[0]?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    elevenSockets()[0]?.drop()
    await until(() => elevenSockets().length === 2, 'a new socket')
    elevenSockets()[1]?.open()
    elevenSockets()[1]?.drop()
    await until(() => h.stub.said.some(message => message.t === 'tts'), 'Deepgram speaks')
    expect(h.stub.said.filter(message => message.t === 'tts')).toEqual([{ t: 'tts', id: 2, text: 'Phrase B follows.', voice: 'flux-sienna-en', speed: 1, first: false }])
    expect(h.notices()).toEqual([eleven.ELEVEN_NOTICES.didNotAnswer])
    expect(h.types()).not.toContain('err')
  })

  it('review: once this socket ended a phrase itself (a final for the phrase in flight), an 800 ms stall does not cut the next phrase; silence ends one only after QUIET_BACKSTOP_MS', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'Hello there.', true)
    h.tts(2, 'This phrase stalls in the middle.')
    h.tts(3, 'Last one.')
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    socket?.json({ audio: b64([2, 0]), contextId: 'auma-2' })
    // The network or the page stalls for 800 ms, mid-phrase.
    await h.advance(800)
    // Not ended: no tts_end for it and the next phrase not sent (each context is closed once, right after its text).
    expect(h.types()).toEqual(['tts_begin', 'pcm:2', 'tts_end', 'tts_begin', 'pcm:2'])
    expect(texts(socket).map(message => message.text)).toEqual(['Hello there. ', 'This phrase stalls in the middle. '])
    expect(said(socket).filter(message => message.close_context === true).map(message => message.context_id)).toEqual(['auma-1', 'auma-2'])
    socket?.json({ audio: b64([3, 0]), contextId: 'auma-2' })
    socket?.json({ isFinal: true, contextId: 'auma-2' })
    expect(h.types()).toEqual(['tts_begin', 'pcm:2', 'tts_end', 'tts_begin', 'pcm:2', 'pcm:2', 'tts_end'])
    expect(texts(socket).map(message => message.text)).toEqual(['Hello there. ', 'This phrase stalls in the middle. ', 'Last one. '])
    // A final that never comes: the phrase is still ended, by QUIET_BACKSTOP_MS of silence after its last audio.
    socket?.json({ audio: b64([4, 0]), contextId: 'auma-3' })
    await h.advance(eleven.QUIET_BACKSTOP_MS - 1)
    expect(h.types().at(-1)).toBe('pcm:2')
    await h.advance(1)
    expect(h.types().slice(-2)).toEqual(['pcm:2', 'tts_end'])
  })
})

describe('a short silence never ends a phrase', () => {
  it('his sequence on a fresh socket: the first chunk, the next 800 ms later: the phrase plays whole and is not closed early', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'Good morning to you.', true)
    h.tts(2, 'Next.')
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    await h.advance(800)
    // Not ended early: no tts_end, and the next phrase is not sent; its context was closed once, right after its text.
    expect(h.types()).toEqual(['tts_begin', 'pcm:2'])
    expect(said(socket)).toEqual([{ text: 'Good morning to you. ', context_id: 'auma-1', flush: true }, { context_id: 'auma-1', close_context: true }])
    socket?.json({ audio: b64([2, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    expect(h.types()).toEqual(['tts_begin', 'pcm:2', 'pcm:2', 'tts_end'])
    expect(texts(socket).map(message => message.text)).toEqual(['Good morning to you. ', 'Next. '])
  })

  it('no final and QUIET_BACKSTOP_MS of silence ends the phrase as NOT confirmed complete, and the reply goes on', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'Good morning to you.', true)
    h.tts(2, 'Next.')
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    await h.advance(eleven.QUIET_BACKSTOP_MS - 1)
    expect(h.types()).toEqual(['tts_begin', 'pcm:2'])
    await h.advance(1)
    expect(h.types()).toEqual(['tts_begin', 'pcm:2', 'tts_end'])
    // The backstop sends nothing more for auma-1 (closed when its text went out); the next phrase goes.
    expect(said(socket).slice(2)).toEqual([{ text: 'Next. ', context_id: 'auma-2', flush: true }, { context_id: 'auma-2', close_context: true }])
    socket?.json({ audio: b64([2, 0]), contextId: 'auma-2' })
    socket?.json({ isFinal: true, contextId: 'auma-2' })
    // Recorded as not confirmed, never as completed; one alone does not step her voice aside.
    await until(() => h.reports().some(report => (report.errors as Record<string, number>).unconfirmed === 1), 'the unconfirmed phrase reported')
    expect(h.notices()).toEqual([])
    expect(h.stub.said.filter(message => message.t === 'tts')).toEqual([])
  })

  it('two in a row by the backstop on a socket that never sent a final: her voice steps aside for this page session, with one line', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'One.', true)
    h.tts(2, 'Two.')
    h.tts(3, 'Three.')
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    await h.advance(eleven.QUIET_BACKSTOP_MS)
    socket?.json({ audio: b64([2, 0]), contextId: 'auma-2' })
    await h.advance(eleven.QUIET_BACKSTOP_MS)
    // The rest of the reply goes to Deepgram, in order, and she says why once.
    expect(h.stub.said.filter(message => message.t === 'tts')).toEqual([{ t: 'tts', id: 3, text: 'Three.', voice: 'flux-sienna-en', speed: 1, first: false }])
    expect(h.notices()).toEqual([eleven.ELEVEN_NOTICES.notConfirming])
    expect(eleven.ELEVEN_NOTICES.notConfirming).toBe('Her voice is not confirming the end of phrases; Deepgram is speaking.')
    expect(h.socket.herVoiceLine).toBe(eleven.ELEVEN_NOTICES.notConfirming)
    expect(socket?.readyState).toBe(3)
    // Later replies go to Deepgram too, with no new pass, no retry, and no second notice.
    const asked = h.passes().length
    h.tts(4, 'A later reply.', true)
    h.stub.emit({ t: 'vad', speaking: true })
    await h.advance(eleven.REOPEN_SPACING_MS * 3)
    h.stub.emit({ t: 'vad', speaking: true })
    h.tts(5, 'And another.', true)
    expect(h.stub.said.filter(message => message.t === 'tts').map(message => message.id)).toEqual([3, 4, 5])
    expect(h.passes()).toHaveLength(asked)
    expect(elevenSockets()).toHaveLength(1)
    expect(h.notices()).toEqual([eleven.ELEVEN_NOTICES.notConfirming])
  })

  it('a backstop after this socket has sent finals does not step aside, nor do two', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'One.', true)
    h.tts(2, 'Two.')
    h.tts(3, 'Three.')
    h.tts(4, 'Four.')
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    socket?.json({ audio: b64([2, 0]), contextId: 'auma-2' })
    await h.advance(eleven.QUIET_BACKSTOP_MS)
    socket?.json({ audio: b64([3, 0]), contextId: 'auma-3' })
    await h.advance(eleven.QUIET_BACKSTOP_MS)
    expect(texts(socket).map(message => message.text)).toEqual(['One. ', 'Two. ', 'Three. ', 'Four. '])
    expect(h.notices()).toEqual([])
    expect(h.socket.herVoiceLine).toMatch(/^Her voice today: /)
    expect(h.stub.said.filter(message => message.t === 'tts')).toEqual([])
  })

  it('review: a provider that sends a context\'s final only once that context is closed: each phrase is closed right after its text, ends confirmed, and none waits for the backstop', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    if (!socket) throw new Error('no ElevenLabs socket')
    // This provider answers a context's text with its audio, and sends the context's final only after close_context.
    const record = socket.send.bind(socket)
    socket.send = (data) => {
      record(data)
      if (typeof data !== 'string') return
      const message = JSON.parse(data) as Record<string, unknown>
      const context = message.context_id
      if (typeof message.text === 'string') setImmediate(() => { socket.json({ audio: b64([1, 0]), contextId: context }) })
      if (message.close_context === true) setImmediate(() => { setImmediate(() => { socket.json({ isFinal: true, contextId: context }) }) })
    }
    h.tts(1, 'One.', true)
    h.tts(2, 'Two.')
    h.tts(3, 'Three.')
    await until(() => h.types().filter(type => type === 'tts_end').length === 3, 'three phrases ended by their finals, with no time passing')
    expect(h.tick()).toBe(0)
    expect(h.types()).toEqual(['tts_begin', 'pcm:2', 'tts_end', 'tts_begin', 'pcm:2', 'tts_end', 'tts_begin', 'pcm:2', 'tts_end'])
    // Every context is closed once, right after its text, and never again.
    expect(said(socket)).toEqual([
      { text: 'One. ', context_id: 'auma-1', flush: true }, { context_id: 'auma-1', close_context: true },
      { text: 'Two. ', context_id: 'auma-2', flush: true }, { context_id: 'auma-2', close_context: true },
      { text: 'Three. ', context_id: 'auma-3', flush: true }, { context_id: 'auma-3', close_context: true },
    ])
    await until(() => h.reports().length > 0 && h.settled(), 'the reply reported')
    expect(h.reports().filter(report => Object.keys(report.errors as Record<string, number>).length > 0)).toEqual([])
    expect(h.notices()).toEqual([])
    expect(h.stub.said.filter(message => message.t === 'tts')).toEqual([])
    // Then a reply is cut mid-phrase: its context was closed already, so nothing more is sent for it.
    h.tts(4, 'A reply that is cut.', true)
    h.socket.send(JSON.stringify({ t: 'tts_cancel' }))
    expect(said(socket).filter(message => message.context_id === 'auma-4')).toEqual([
      { text: 'A reply that is cut. ', context_id: 'auma-4', flush: true }, { context_id: 'auma-4', close_context: true },
    ])
  })

  /** Two phrases ended by the backstop on a socket that never sent a final: her voice steps aside. */
  const stepAside = async (h: Awaited<ReturnType<typeof chosen>>) => {
    const socket = elevenSockets()[0]
    h.tts(1, 'One.', true)
    h.tts(2, 'Two.')
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    await h.advance(eleven.QUIET_BACKSTOP_MS)
    socket?.json({ audio: b64([2, 0]), contextId: 'auma-2' })
    await h.advance(eleven.QUIET_BACKSTOP_MS)
    expect(h.notices()).toEqual([eleven.ELEVEN_NOTICES.notConfirming])
  }
  /** VoiceLink reconnects: a new wrapper over a new inner socket, on the same page. Her voice is not offered again. */
  const afterReconnect = async (again: ReturnType<typeof harness>) => {
    await until(again.passRead, 'the new Deepgram pass answer read')
    again.stub.emit(INNER_READY)
    again.tts(1, 'After the reconnect.', true)
    again.stub.emit({ t: 'vad', speaking: true })
    await again.advance(eleven.REOPEN_SPACING_MS * 2)
    again.tts(2, 'And later.', true)
    expect(again.stub.said.filter(message => message.t === 'tts').map(message => message.id)).toEqual([1, 2])
    expect(again.passes()).toHaveLength(0)
    expect(elevenSockets()).toHaveLength(1)
    expect(again.socket.herVoiceLine).toBe(eleven.ELEVEN_NOTICES.notConfirming)
    expect(again.notices()).toEqual([])
  }

  it('review: stepping aside lasts the page session: a voice socket made after VoiceLink reconnects does not ask for her voice again', async () => {
    const session = { steppedAside: false }
    await stepAside(await chosen({ session }))
    await afterReconnect(harness({ session }))
  })

  it('review: the app passes no session: the page session is the module\'s own, shared by every socket the page makes', async () => {
    const module = await import(`${pathToFileURL(appPath('elevenlabs-voice.js')).href}?page-session`) as { speechSocketFor: Factory }
    expect(module.speechSocketFor).not.toBe(eleven.speechSocketFor)
    await stepAside(await chosen({ session: 'page', module }))
    await afterReconnect(harness({ session: 'page', module }))
  })
})

describe('her turn is cut by turn, and two providers never feed the player at once', () => {
  it('after tts_cancel: old-context audio (camel, snake, none) delivers nothing, the context is closed, one tts_cancelled', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'A long reply.', true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    h.tts(2, 'Still going.')
    h.clear()
    const before = said(socket).length
    h.socket.send(JSON.stringify({ t: 'tts_cancel' }))
    // The context was closed when its text went out (review), so the cancel sends ElevenLabs nothing more.
    expect(said(socket).slice(0, 2)).toEqual([{ text: 'A long reply. ', context_id: 'auma-1', flush: true }, { context_id: 'auma-1', close_context: true }])
    expect(said(socket)).toHaveLength(before)
    expect(h.stub.said.filter(message => message.t === 'tts_cancel')).toHaveLength(1)
    expect(h.received).toEqual([{ t: 'tts_cancelled' }])
    socket?.json({ audio: b64([5, 0, 6, 0]), contextId: 'auma-1' })
    socket?.json({ audio: b64([5, 0, 6, 0]), context_id: 'auma-1' })
    socket?.json({ audio: b64([5, 0, 6, 0]) })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    await h.advance(eleven.QUIET_BACKSTOP_MS * 2)
    expect(h.binaries()).toBe(0)
    expect(texts(socket).map(message => message.text)).toEqual(['A long reply. '])
    h.tts(3, 'New turn.', true)
    expect(said(socket).slice(-2)).toEqual([{ text: 'New turn. ', context_id: 'auma-2', flush: true }, { context_id: 'auma-2', close_context: true }])
    socket?.json({ audio: b64([7, 0]), contextId: 'auma-1' })
    expect(h.binaries()).toBe(0)
    socket?.json({ audio: b64([7, 0]), contextId: 'auma-2' })
    expect(h.types()).toEqual(['tts_cancelled', 'tts_begin', 'pcm:2'])
  })

  it('a new first: true over an open turn ends every id the app waits for, closes the context, and no sample of the old turn comes after the new one\'s first', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'First reply.', true)
    h.tts(2, 'Still first.')
    socket?.json({ audio: b64([1, 0, 9]), contextId: 'auma-1' })
    h.clear()
    h.tts(3, 'Second reply.', true)
    // Id 1 is ended, id 2 (never begun) is begun and ended so the app pairs them; then the new phrase goes out.
    expect(h.received).toEqual([{ t: 'tts_end', id: 1 }, { t: 'tts_begin', id: 2, sr: 24000 }, { t: 'tts_end', id: 2 }])
    expect(said(socket)).toEqual([
      { text: 'First reply. ', context_id: 'auma-1', flush: true }, { context_id: 'auma-1', close_context: true },
      { text: 'Second reply. ', context_id: 'auma-2', flush: true }, { context_id: 'auma-2', close_context: true },
    ])
    socket?.json({ audio: b64([3, 0]), context_id: 'auma-2' })
    socket?.json({ audio: b64([1, 0]), context_id: 'auma-1' })
    socket?.json({ audio: b64([1, 0]) })
    const firstNew = h.received.findIndex(item => item instanceof Uint8Array)
    expect([...h.received[firstNew] as Uint8Array]).toEqual([3, 0])
    expect(h.received.slice(firstNew + 1).filter(item => item instanceof Uint8Array)).toEqual([])
    // Nothing was spoken by the inner socket, so it is not cancelled; the app asked for no cancel and gets none.
    expect(h.stub.said.filter(message => message.t === 'tts_cancel')).toHaveLength(0)
    expect(h.types()).not.toContain('tts_cancelled')
  })

  it('previewing another voice mid-reply ends her reply first: no frame of hers is delivered once the preview went to the inner socket', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'Her reply is long.', true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    h.clear()
    h.tts(7, 'This is me.', false, 'aura-2-thalia-en')
    expect(h.received).toEqual([{ t: 'tts_end', id: 1 }])
    expect(said(socket)).toEqual([{ text: 'Her reply is long. ', context_id: 'auma-1', flush: true }, { context_id: 'auma-1', close_context: true }])
    expect(h.stub.said.at(-1)).toEqual({ t: 'tts', id: 7, text: 'This is me.', voice: 'aura-2-thalia-en', speed: 1, first: false })
    socket?.json({ audio: b64([2, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    expect(h.binaries()).toBe(0)
    h.stub.emit({ t: 'tts_begin', id: 7, sr: 24000 })
    expect(h.types()).toEqual(['tts_end', 'tts_begin'])
  })

  it('her voice after a preview of another voice: what the inner socket still speaks is ended and cancelled before her first word goes out', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(7, 'This is me.', false, 'aura-2-thalia-en')
    h.stub.emit({ t: 'tts_begin', id: 7, sr: 24000 })
    h.clear()
    h.tts(8, 'Her turn now.', true)
    expect(h.received).toEqual([{ t: 'tts_end', id: 7 }])
    // The inner socket was cancelled for the wrapper itself (its answer is swallowed), then her phrase was sent.
    expect(h.stub.said.at(-1)).toEqual({ t: 'tts_cancel' })
    expect(h.types()).not.toContain('tts_cancelled')
    expect(said(socket)).toEqual([{ text: 'Her turn now. ', context_id: 'auma-1', flush: true }, { context_id: 'auma-1', close_context: true }])
  })

  it('a Deepgram voice picked while hers is offered: its own replies pass through and are never cut by the wrapper', async () => {
    const h = await chosen()
    h.tts(1, 'First sentence.', true, 'flux-sienna-en')
    h.tts(2, 'Second sentence.', false, 'flux-sienna-en')
    expect(h.stub.said.map(message => message.t)).toEqual(['tts', 'tts'])
    expect(h.received).toEqual([])
  })

  it('a reply that fell back: a new first: true stops Deepgram speaking it and ends the ids Deepgram still held', async () => {
    const h = await chosen()
    h.tts(1, 'Hello there.', true)
    h.tts(2, 'How are you?')
    elevenSockets()[0]?.drop()
    await until(() => elevenSockets().length === 2, 'a new socket')
    elevenSockets()[1]?.open()
    elevenSockets()[1]?.drop()
    await until(() => h.stub.said.filter(message => message.t === 'tts').length === 2, 'Deepgram speaks both')
    h.stub.emit({ t: 'tts_begin', id: 1, sr: 24000 })
    h.stub.emit({ t: 'tts_end', id: 1 })
    h.clear()
    const before = h.stub.said.length
    h.tts(3, 'New reply.', true)
    expect(h.stub.said.slice(before)).toEqual([{ t: 'tts_cancel' }])
    expect(h.received).toEqual([{ t: 'tts_begin', id: 2, sr: 24000 }, { t: 'tts_end', id: 2 }])
    await until(() => elevenSockets().length === 3, 'her socket again')
    const third = elevenSockets()[2]
    third?.open()
    expect(said(third)).toEqual([{ text: 'New reply. ', context_id: 'auma-3', flush: true }, { context_id: 'auma-3', close_context: true }])
    third?.json({ audio: b64([4, 0]), contextId: 'auma-3' })
    expect(h.types().slice(2)).toEqual(['tts_begin', 'pcm:2'])
  })
})

describe('reconnect, then Deepgram', () => {
  it('no audio within 6 s counts as a failure, and a refused pass goes straight to Deepgram', async () => {
    let answers = 0
    const h = await chosen({ eleven: () => (answers++ === 0 ? Response.json(GRANT) : Response.json({ ok: false, code: 'ELEVEN_SPEECH_PROVIDER_FAILED' }, { status: 502 })) })
    h.tts(1, 'Hello there.', true)
    await h.advance(eleven.FIRST_AUDIO_MS - 1)
    expect(h.stub.said.filter(message => message.t === 'tts')).toEqual([])
    await h.advance(1)
    await until(() => h.stub.said.some(message => message.t === 'tts'), 'Deepgram speaks')
    expect(h.stub.said.filter(message => message.t === 'tts').map(message => message.id)).toEqual([1])
    expect(h.notices()).toEqual([eleven.ELEVEN_NOTICES.didNotAnswer])
    await until(() => h.reports().some(report => (report.errors as Record<string, number>).mint === 1), 'the errors reported')
    const all = h.reports().map(report => report.errors as Record<string, number>)
    expect(all.reduce((sum, errors) => sum + (errors.first_audio ?? 0), 0)).toBe(1)
  })

  it('an idle socket that closed is warmed again by vad, at most once per 10 s', async () => {
    const h = await chosen()
    elevenSockets()[0]?.drop()
    h.stub.emit({ t: 'vad', speaking: true })
    expect(h.passes()).toHaveLength(1)
    await h.advance(eleven.REOPEN_SPACING_MS)
    h.stub.emit({ t: 'vad', speaking: true })
    await until(() => elevenSockets().length === 2, 'warmed')
    expect(h.passes()).toHaveLength(2)
    expect(h.received.filter(item => (item as { t: string }).t === 'vad')).toHaveLength(2)
  })
})

describe('at the page: every character against its reservation, never clamped, never dropped', () => {
  it('reports what was sent (a resend counts again) against the pass that carried it, as that pass\'s running total, and settles the pass when its socket ends', async () => {
    const h = await chosen()
    const first = elevenSockets()[0]
    h.tts(1, 'Hello there.', true)
    await h.advance(320)
    first?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    first?.json({ isFinal: true, contextId: 'auma-1' })
    h.tts(2, 'é'.repeat(3))
    first?.drop()
    await until(() => elevenSockets().length === 2, 'a new socket')
    elevenSockets()[1]?.open()
    elevenSockets()[1]?.json({ audio: b64([1, 0]), contextId: 'auma-3' })
    elevenSockets()[1]?.json({ isFinal: true, contextId: 'auma-3' })
    await until(() => h.reports().some(report => report.final === true), 'the first pass settled')
    // 13 + 4 sent on the first pass (the second phrase was in flight when it dropped), 4 again on the second.
    expect(h.total('2026-11-13.1')).toBe(13 + 4)
    await until(() => h.total('2026-11-13.2') === 4, 'the resend reported against the second pass')
    const final = h.reports().find(report => report.final === true)
    expect(final).toMatchObject({ reservation: '2026-11-13.1', chars: 17 })
    expect(h.reports().find(report => report.reservation === '2026-11-13.1' && (report.firstAudio as { count: number }).count === 1)?.firstAudio).toEqual({ count: 1, sumMs: 320, maxMs: 320 })
    expect(Object.keys(h.reports()[0] ?? {}).sort()).toEqual(['action', 'chars', 'errors', 'final', 'firstAudio', 'reservation', 'seq', 'turns'])
    // Each pass numbers its reports 1, 2, 3, ...; a report's total never goes down.
    for (const reservation of ['2026-11-13.1', '2026-11-13.2']) {
      const mine = h.reports().filter(report => report.reservation === reservation)
      expect(mine.map(report => report.seq)).toEqual(mine.map((_, index) => index + 1))
      expect(mine.map(report => report.chars)).toEqual([...mine.map(report => report.chars as number)].sort((a, b) => a - b))
    }
    // The turn is counted once, when it is replaced, against the pass that was carrying it by then.
    h.tts(5, 'Next.', true)
    await until(() => h.reports().reduce((sum, report) => sum + (report.turns as number), 0) === 1, 'the turn counted')
    expect(h.reports().filter(report => report.reservation === '2026-11-13.2').reduce((sum, report) => sum + (report.turns as number), 0)).toBe(1)
  })

  it('a turn of more than 20,000 characters, with allowance enough, is spoken and reported whole (no clamp)', async () => {
    const h = await chosen({ usage: { ...USAGE, chars: 0, counted: 5000 } })
    const socket = elevenSockets()[0]
    h.tts(1, 'x'.repeat(24999), true)
    // 25,000 characters need four more slices; the phrase goes only once all of them are reserved.
    await until(() => texts(socket).length === 1, 'the phrase sent after its slices')
    expect(h.extends()).toHaveLength(4)
    expect(h.edge.granted[0]?.reserved).toBe(25000)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    await until(() => h.total('2026-11-13.1') > 0, 'reported')
    expect(h.total('2026-11-13.1')).toBe(25000)
  })

  it('a phrase that would cross the slice waits for the next slice, and is sent only after the edge said yes', async () => {
    let answer: (response: Response) => void = () => {}
    const h = await chosen({ usage: { ...USAGE, slice: 20 }, extend: () => new Promise<Response>((resolve) => { answer = resolve }) })
    const socket = elevenSockets()[0]
    h.tts(1, 'Hello there.', true)
    h.tts(2, 'How are you today?')
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    // 13 sent of 20 reserved; the next 19 would cross it: the edge is asked, and nothing is sent meanwhile.
    await until(() => h.extends().length === 1, 'one more slice asked for')
    expect(h.extends()[0]?.body).toEqual({ action: 'speech_extend', reservation: '2026-11-13.1' })
    expect(texts(socket).map(message => message.text)).toEqual(['Hello there. '])
    answer(Response.json({ ok: true, action: 'speech_extend', reservation: '2026-11-13.1', reserved: 40, usage: USAGE }))
    await until(() => texts(socket).length === 2, 'sent after the yes')
    expect(texts(socket).at(-1)).toEqual({ text: 'How are you today? ', context_id: 'auma-2', flush: true })
    expect(h.stub.said.filter(message => message.t === 'tts')).toEqual([])
  })

  for (const [name, refusal, notice] of [
    ['an error', () => Response.json({ ok: false, code: 'ELEVEN_SPEECH_LEDGER_UNAVAILABLE' }, { status: 503 }), 'ElevenLabs did not answer. Deepgram is speaking this reply.'],
    ['the rate', () => Response.json({ ok: false, code: 'ELEVEN_SPEECH_RATE_LIMITED' }, { status: 429 }), 'ElevenLabs did not answer. Deepgram is speaking this reply.'],
    ['no answer', () => 'throw' as const, 'ElevenLabs did not answer. Deepgram is speaking this reply.'],
    ['the ceiling', () => ceilingRefusal('ELEVENLABS_MAX_CHARS_PER_DAY', 600), 'Today\'s ElevenLabs ceiling is reached (ELEVENLABS_MAX_CHARS_PER_DAY). Deepgram is speaking.'],
  ] as const) {
    it(`the next slice refused (${name}): that phrase and the rest of the reply go to Deepgram, never to ElevenLabs`, async () => {
      const h = await chosen({ usage: { ...USAGE, slice: 20 }, extend: refusal })
      const socket = elevenSockets()[0]
      h.tts(1, 'Hello there.', true)
      h.tts(2, 'How are you today?')
      h.tts(3, 'Fine.')
      socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
      socket?.json({ isFinal: true, contextId: 'auma-1' })
      await until(() => h.stub.said.some(message => message.t === 'tts'), 'Deepgram speaks')
      expect(texts(socket).map(message => message.text)).toEqual(['Hello there. '])
      expect(h.stub.said.filter(message => message.t === 'tts').map(message => message.id)).toEqual([2, 3])
      expect(h.notices()).toEqual([notice])
    })
  }

  it('review: the edge says the pass\'s day has ended (minted before its midnight): the pass is let go and settled, a new pass is asked, and the phrase is spoken in her voice', async () => {
    const h = await chosen({ extend: () => Response.json({ ok: false, code: 'ELEVEN_SPEECH_PASS_DAY_ENDED' }, { status: 409 }) })
    const socket = elevenSockets()[0]
    h.tts(1, 'x'.repeat(4990), true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    h.tts(2, 'Past midnight now.')
    await until(() => elevenSockets().length === 2, 'a new socket on a new pass')
    expect(socket?.readyState).toBe(3)
    await until(() => h.reports().some(report => report.reservation === '2026-11-13.1' && report.final === true && report.chars === 4991), 'the old pass settled at what it spoke')
    elevenSockets()[1]?.open()
    expect(texts(elevenSockets()[1])).toEqual([{ text: 'Past midnight now. ', context_id: 'auma-2', flush: true }])
    expect(h.extends()).toHaveLength(1)
    expect(h.stub.said.filter(message => message.t === 'tts')).toEqual([])
    expect(h.notices()).toEqual([])
    expect(h.socket.herVoiceLine).toMatch(/^Her voice today: /)
  })

  it('his sequence (reserve 5,000, speak 9,000, every report fails) cannot happen: nothing uncovered is ever sent, so 100,000 + 95,000 + ... is unreachable', async () => {
    const h = await chosen({ usage: { ...USAGE, chars: 0, counted: 5000, maxChars: 30000, maxCost: 1000 },
      usageAnswer: () => Response.json({ ok: false, code: 'ELEVEN_SPEECH_LEDGER_UNAVAILABLE' }, { status: 503 }) })
    const served = new Set<string>()
    /** ElevenLabs answers every phrase sent: one frame of audio and its final. */
    const serve = () => {
      for (const socket of elevenSockets()) {
        if (socket.readyState === 0) socket.open()
        for (const message of texts(socket)) {
          const context = String(message.context_id)
          if (served.has(context)) continue
          served.add(context)
          socket.json({ audio: b64([1, 0]), contextId: context })
          socket.json({ isFinal: true, contextId: context })
        }
      }
    }
    let id = 0
    for (let reply = 0; reply < 12 && !h.stub.said.some(message => message.t === 'tts'); reply += 1) {
      for (let phrase = 0; phrase < 4; phrase += 1) h.tts(++id, `${'y'.repeat(998)}.`, phrase === 0)
      for (let round = 0; round < 12; round += 1) { await until(h.settled, 'the edge answered'); serve() }
      await h.advance(eleven.REPORT_RETRY_MS)
    }
    // Every report failed, so nothing was ever settled. Yet each pass sent at most what the edge reserved for it ...
    // (Every phrase here is ASCII, so its length is its count of characters.)
    const sent = elevenSockets().map(socket => texts(socket).reduce((sum, message) => sum + String(message.text).length, 0))
    expect(sent.length).toBeGreaterThan(1)
    sent.forEach((chars, index) => { expect(chars).toBeLessThanOrEqual(h.edge.granted[index]?.reserved ?? 0) })
    // ... so the day's count (every reservation, none settled) is never less than what was spoken, and the ceiling held.
    const spoken = sent.reduce((sum, chars) => sum + chars, 0)
    expect(spoken).toBeGreaterThan(0)
    expect(h.edge.counted).toBeGreaterThanOrEqual(spoken)
    expect(h.edge.counted).toBeLessThanOrEqual(30000)
    expect(h.notices().at(-1)).toBe('Today\'s ElevenLabs ceiling is reached (ELEVENLABS_MAX_CHARS_PER_DAY). Deepgram is speaking.')
    // Not one report was delivered, and more than one pass was given up on.
    expect(h.reports().length).toBeGreaterThan(eleven.REPORT_ATTEMPTS)
  })

  it('a report that failed is sent again with the pass\'s whole total, and after five failures the pass is abandoned: nothing more is sent on it, never a final', async () => {
    let failing = true
    const h = await chosen({ usageAnswer: () => (failing ? Response.json({ ok: false, code: 'ELEVEN_SPEECH_LEDGER_UNAVAILABLE' }, { status: 503 }) : Response.json({ ok: true, action: 'speech_usage' })) })
    const socket = elevenSockets()[0]
    h.tts(1, 'Hello there.', true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    await until(() => h.reports().length === 1, 'the first attempt')
    expect(h.reports()[0]).toMatchObject({ seq: 1, chars: 13 })
    h.tts(2, 'Again.', true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-2' })
    socket?.json({ isFinal: true, contextId: 'auma-2' })
    failing = false
    await h.advance(eleven.REPORT_RETRY_MS)
    await until(() => h.settled() && h.reports().some(report => report.chars === 13 + 7), 'the retry carries the whole total')
    expect(h.reports().find(report => report.chars === 13 + 7)).toMatchObject({ seq: 2, final: false })
    // Five failures in a row: given up, never retried a sixth time.
    failing = true
    h.tts(3, 'Third.', true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-3' })
    socket?.json({ isFinal: true, contextId: 'auma-3' })
    const before = h.reports().length
    for (let attempt = 1; attempt < eleven.REPORT_ATTEMPTS; attempt += 1) {
      await until(() => h.reports().length - before === attempt && h.settled() && h.timers.some(timer => timer.ms === eleven.REPORT_RETRY_MS), `attempt ${String(attempt)} failed and a retry is set`)
      await h.advance(eleven.REPORT_RETRY_MS)
    }
    await until(() => h.reports().length - before === eleven.REPORT_ATTEMPTS && h.settled(), 'the last attempt')
    await until(() => h.timers.length === 0, 'no timer left after the last attempt')
    await h.advance(eleven.REPORT_RETRY_MS * 3)
    expect(h.reports().length - before).toBe(eleven.REPORT_ATTEMPTS)
    // Each attempt carried the same whole total: losing any of them loses nothing.
    expect(h.reports().slice(before).map(report => report.chars)).toEqual(Array(eleven.REPORT_ATTEMPTS).fill(13 + 7 + 7))
    // Abandoned: the edge is up again and she speaks again on that pass, its socket ends later, yet NOTHING more is sent
    // on that reservation, so its whole reservation stays counted at the edge.
    failing = false
    const onFirst = () => h.reports().filter(report => report.reservation === '2026-11-13.1').length
    const sentOnFirst = onFirst()
    h.tts(4, 'Still speaking.', true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-4' })
    socket?.json({ isFinal: true, contextId: 'auma-4' })
    socket?.drop()
    h.tts(5, 'A new pass.', true)
    await until(() => h.passes().length === 2 && h.settled(), 'a new pass asked and every request answered')
    h.page.dispatchEvent(new Event('pagehide'))
    await until(h.settled, 'every request answered')
    expect(onFirst()).toBe(sentOnFirst)
    expect(h.reports().filter(report => report.reservation === '2026-11-13.1' && report.final === true)).toEqual([])
    expect(h.extends()).toEqual([])
  })

  it('review: a report the edge refuses outright (the session lapsed) abandons its pass: nothing more is sent on it, even once he is signed in again', async () => {
    let refusing = true
    const h = await chosen({ usageAnswer: () => (refusing ? Response.json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, { status: 403 }) : Response.json({ ok: true, action: 'speech_usage' })) })
    const socket = elevenSockets()[0]
    h.tts(1, 'Hello there.', true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    await until(() => h.reports().length === 1 && h.settled(), 'the refused report')
    refusing = false
    // Replaced by order (MUST 1d): what is spoken later on that pass is no longer reported at all.
    h.tts(2, 'Signed in again.', true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-2' })
    socket?.json({ isFinal: true, contextId: 'auma-2' })
    socket?.drop()
    h.tts(3, 'A new pass.', true)
    await until(() => h.passes().length === 2 && h.settled(), 'a new pass asked and every request answered')
    expect(h.reports().filter(report => report.reservation === '2026-11-13.1')).toHaveLength(1)
    expect(h.reports().filter(report => report.reservation === '2026-11-13.1' && report.final === true)).toEqual([])
  })

  it('his sequence: a report of N hangs, the page goes away: the final carries the whole total at once, with keepalive, beside the report in flight', async () => {
    let first = true
    const h = await chosen({ usageAnswer: () => { if (first) { first = false; return 'hang' } return Response.json({ ok: true, action: 'speech_usage' }) } })
    const socket = elevenSockets()[0]
    h.tts(1, 'Hello there.', true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    await until(() => h.reports().length === 1, 'the first report on its way')
    expect(h.reports()[0]).toMatchObject({ seq: 1, chars: 13, final: false })
    h.tts(2, 'Bye.')
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-2' })
    socket?.json({ isFinal: true, contextId: 'auma-2' })
    expect(h.reports()).toHaveLength(1)
    h.page.dispatchEvent(new Event('pagehide'))
    await until(() => h.reports().some(report => report.final === true), 'the pass settled as the page goes')
    // Never a final of 0 over a report still in flight: the final carries every character, the hung N among them.
    expect(h.reports().at(-1)).toMatchObject({ reservation: '2026-11-13.1', seq: 2, chars: 13 + 5, final: true })
    const usage = h.asked.filter(entry => entry.action === 'speech_usage')
    expect(usage.map(entry => entry.keepalive)).toEqual(usage.map(() => true))
    // The page may come back from the back-forward cache: it never speaks again on the pass it settled.
    expect(socket?.readyState).toBe(3)
  })

  it('stops when the edge refuses the next slice at the ceiling: the next phrase goes to Deepgram with the ceiling line', async () => {
    const h = await chosen({ usage: { ...USAGE, chars: 95000, counted: 100000 } })
    const socket = elevenSockets()[0]
    h.tts(1, 'x'.repeat(4990), true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    h.tts(2, 'Twenty characters ok.')
    await until(() => h.stub.said.some(message => message.t === 'tts'), 'Deepgram speaks')
    expect(texts(socket)).toHaveLength(1)
    expect(h.stub.said.filter(message => message.t === 'tts').map(message => message.id)).toEqual([2])
    expect(h.notices()).toEqual(['Today\'s ElevenLabs ceiling is reached (ELEVENLABS_MAX_CHARS_PER_DAY). Deepgram is speaking.'])
    expect(h.socket.herVoiceLine).toBe('Her voice: today\'s ceiling is reached (ELEVENLABS_MAX_CHARS_PER_DAY)')
    h.tts(3, 'Next turn.', true)
    expect(texts(socket)).toHaveLength(1)
    expect(h.stub.said.at(-1)).toEqual({ t: 'tts', id: 3, text: 'Next turn.', voice: 'flux-sienna-en', speed: 1, first: true })
    await until(() => h.reports().some(report => (report.errors as Record<string, number>).ceiling === 1), 'the ceiling reported')
  })

  it('stops at the cost ceiling too', async () => {
    const h = await chosen({ usage: { ...USAGE, chars: 0, counted: 1000, maxChars: 1000000, pricePer1k: 4, maxCost: 4, slice: 1000 } })
    // Past its slice the next one would take the estimate past $4: the edge refuses it, and nothing is sent.
    h.tts(1, 'x'.repeat(1200), true)
    await until(() => h.notices().length > 0, 'the ceiling notice')
    expect(h.notices().at(-1)).toBe('Today\'s ElevenLabs ceiling is reached (ELEVENLABS_MAX_COST_PER_DAY). Deepgram is speaking.')
    expect(texts(elevenSockets()[0])).toEqual([])
  })
})

describe('her own voice is never taken for the owner\'s', () => {
  it('his sequence: "Good morning." then "Rain is coming later." while the first is audible; the recogniser returns "Good morning"', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'Good morning.', true)
    h.tts(2, 'Rain is coming later.')
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    // What the page compared with before (the last chunk it sent) does not catch it; the phrase list does.
    expect(duplex.isSelfEcho('Good morning', 'Rain is coming later.')).toBe(false)
    expect(h.socket.herEcho('Good morning', true, duplex.isSelfEcho)).toBe(true)
    expect(h.socket.herEcho('Good morning', false, duplex.isSelfEcho)).toBe(true)
    // A deliberate short interruption by the owner still gets through, and so do his own words.
    expect(h.socket.herEcho('Stop.', true, duplex.isSelfEcho)).toBe(false)
    expect(h.socket.herEcho('wait a second', true, duplex.isSelfEcho)).toBe(false)
    expect(h.socket.herEcho('what is the weather tomorrow', true, duplex.isSelfEcho)).toBe(false)
  })

  it('a phrase\'s window closes 1.5 s after its end once she is no longer audible', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'Good morning.', true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    await h.advance(eleven.ECHO_TAIL_MS)
    expect(h.socket.herEcho('Good morning', false, duplex.isSelfEcho)).toBe(true)
    await h.advance(1)
    expect(h.socket.herEcho('Good morning', false, duplex.isSelfEcho)).toBe(false)
    expect(h.socket.herEcho('Good morning', true, duplex.isSelfEcho)).toBe(true)
  })

  it('his sequence: "Good morning." playing, eight more accepted: the recogniser\'s "Good morning" is still her own voice', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'Good morning.', true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    for (let id = 2; id <= 9; id += 1) h.tts(id, `Phrase number ${String(id)} is about something else entirely.`)
    expect(h.socket.herEcho('Good morning', true, duplex.isSelfEcho)).toBe(true)
    expect(h.socket.herEcho('Good morning', false, duplex.isSelfEcho)).toBe(true)
    // Forty more, and 45 s of it still playing: a phrase whose audio has not ended is never dropped.
    for (let id = 10; id <= 50; id += 1) h.tts(id, `More text number ${String(id)} waiting its turn.`)
    for (let step = 0; step < 9; step += 1) { await h.advance(5_000); socket?.json({ audio: b64([2, 0]), contextId: 'auma-1' }) }
    expect(texts(socket)).toHaveLength(1)
    expect(h.socket.herEcho('Good morning', false, duplex.isSelfEcho)).toBe(true)
    // What he says still gets through.
    expect(h.socket.herEcho('what is the weather tomorrow', true, duplex.isSelfEcho)).toBe(false)
  })

  it('the bound: a phrase leaves the list ECHO_WINDOW_MS after its audio ended (by time), and a new reply ends the old one\'s phrases (by reply)', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'Good morning.', true)
    h.tts(2, 'Rain is coming later.')
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    // A new reply: the old reply's phrases are ended now, heard only while she is audible, for the window.
    h.tts(3, 'Something new.', true)
    await h.advance(eleven.ECHO_TAIL_MS + 1)
    expect(h.socket.herEcho('Rain is coming later', false, duplex.isSelfEcho)).toBe(false)
    expect(h.socket.herEcho('Rain is coming later', true, duplex.isSelfEcho)).toBe(true)
    await h.advance(30_000)
    h.tts(4, 'And one more.', true)
    expect(h.socket.herEcho('Rain is coming later', true, duplex.isSelfEcho)).toBe(false)
    expect(h.socket.herEcho('Good morning', true, duplex.isSelfEcho)).toBe(false)
  })

  it('review: while she is audible, every phrase of the reply now playing is her own voice, however long ago it was delivered', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'Good morning.', true)
    h.tts(2, 'Rain is coming later today.')
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    socket?.json({ audio: b64([2, 0]), contextId: 'auma-2' })
    socket?.json({ isFinal: true, contextId: 'auma-2' })
    // Delivered and finalled at once; 40 s later she is still audible (a long reply still in the player).
    await h.advance(40_000)
    expect(h.socket.herEcho('Good morning', true, duplex.isSelfEcho)).toBe(true)
    expect(h.socket.herEcho('Rain is coming later today', true, duplex.isSelfEcho)).toBe(true)
    expect(h.socket.herEcho('what is the weather tomorrow', true, duplex.isSelfEcho)).toBe(false)
    // Once she is not audible, each phrase's own end and the tail decide.
    expect(h.socket.herEcho('Good morning', false, duplex.isSelfEcho)).toBe(false)
  })

  it('review: a phrase ends when its audio has been HEARD: four seconds delivered at once still play for four seconds', async () => {
    const h = await chosen()
    const socket = elevenSockets()[0]
    h.tts(1, 'Good morning.', true)
    // Four seconds of 24 kHz 16-bit audio in one frame, then the final, with no time passing.
    socket?.json({ audio: b64(Array.from({ length: 4 * 48_000 }, () => 0)), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    expect(h.types()).toEqual(['tts_begin', `pcm:${String(4 * 48_000)}`, 'tts_end'])
    await h.advance(4_000 + eleven.ECHO_TAIL_MS)
    expect(h.socket.herEcho('Good morning', false, duplex.isSelfEcho)).toBe(true)
    await h.advance(1)
    expect(h.socket.herEcho('Good morning', false, duplex.isSelfEcho)).toBe(false)
  })
})

describe('the day is the edge\'s day; the page keeps no calendar', () => {
  // The edge refuses at 23:59:40 by its own clock, 20 s before its midnight. The page's calendar is set wrong in four ways.
  const EDGE_REFUSED_AT = Date.UTC(2026, 10, 13, 23, 59, 40)
  for (const [name, skewMs, changeMidHold] of [
    ['the page clock 20 s behind', -20_000, 0],
    ['the page clock 20 s ahead', 20_000, 0],
    ['the page clock 3 hours wrong', 3 * 3600_000, 0],
    ['the page clock changed by a day during the hold', 0, -86_400_000],
  ] as const) {
    it(`${name}: the stop clears within ${String(10)} s after the edge's midnight, and never before it`, async () => {
      let edgeAt = EDGE_REFUSED_AT
      let tickAtRefusal = 0
      let h: ReturnType<typeof harness> | null = null
      const edgeNow = () => EDGE_REFUSED_AT + ((h?.tick() ?? 0) - tickAtRefusal)
      h = harness({ at: EDGE_REFUSED_AT + skewMs, eleven: () => {
        edgeAt = edgeNow()
        const edgeDay = new Date(edgeAt).toISOString().slice(0, 10)
        if (edgeDay === '2026-11-13') return ceilingRefusal('ELEVENLABS_MAX_CHARS_PER_DAY', Math.ceil((Date.UTC(2026, 10, 14) - edgeAt) / 1000))
        return Response.json({ ...GRANT, reservation: '2026-11-14.1', usage: { ...USAGE, day: '2026-11-14', chars: 0, counted: 5000 } })
      } })
      const page = h
      tickAtRefusal = page.tick()
      await until(page.passRead, 'the pass answer read')
      page.stub.emit(INNER_READY)
      await until(() => page.socket.herVoiceLine === 'Her voice: today\'s ceiling is reached (ELEVENLABS_MAX_CHARS_PER_DAY)', 'the ceiling line')
      expect(page.passes()).toHaveLength(1)
      const deepgramIds = () => page.stub.said.filter(message => message.t === 'tts').map(message => message.id)
      // The edge's midnight comes 20 s later; the page's own calendar says whatever it says (and may jump a day).
      await page.advance(5_000)
      if (changeMidHold !== 0) page.setNow(page.now() + changeMidHold)
      page.tts(1, 'During the hold.', true)
      expect(deepgramIds()).toEqual([1])
      // While held, nothing is asked: not by a new reply, not by the listener hearing him.
      page.stub.emit({ t: 'vad', speaking: true })
      await page.advance(15_000)                             // the edge's midnight, exactly
      expect(new Date(edgeNow()).toISOString()).toBe('2026-11-14T00:00:00.000Z')
      page.stub.emit({ t: 'vad', speaking: true })
      page.tts(2, 'At the edge\'s midnight.', true)
      expect(deepgramIds()).toEqual([1, 2])
      await page.advance(eleven.CEILING_GRACE_MS - 1)
      page.tts(3, 'Just before the grace ends.', true)
      expect(deepgramIds()).toEqual([1, 2, 3])
      expect(page.passes()).toHaveLength(1)
      // 10 s after the edge's midnight: the stop is gone, the edge is asked again, and her voice speaks.
      await page.advance(1)
      expect(page.socket.herVoiceLine).toBeNull()
      page.tts(4, 'The new day.', true)
      await until(() => elevenSockets().length === 1, 'her socket on the edge\'s new day')
      expect(page.passes()).toHaveLength(2)
      elevenSockets()[0]?.open()
      expect(texts(elevenSockets()[0])).toEqual([{ text: 'The new day. ', context_id: 'auma-1', flush: true }])
      expect(deepgramIds()).toEqual([1, 2, 3])
    })
  }

  it('a ceiling reached on the next slice is held the same way: by the edge\'s seconds, then the edge is asked again', async () => {
    const h = await chosen({ usage: { ...USAGE, chars: 95000, counted: 100000 }, resetInSeconds: 30 })
    const socket = elevenSockets()[0]
    h.tts(1, 'x'.repeat(4990), true)
    socket?.json({ audio: b64([1, 0]), contextId: 'auma-1' })
    socket?.json({ isFinal: true, contextId: 'auma-1' })
    h.tts(2, 'Over the ceiling now.')
    await until(() => h.stub.said.some(message => message.t === 'tts'), 'Deepgram speaks')
    // The pass is spent and settled at once; nothing is asked until 30 s + the grace have passed.
    expect(socket?.readyState).toBe(3)
    await until(() => h.reports().some(report => report.final === true), 'the spent pass settled')
    h.setNow(h.now() - 86_400_000)
    await h.advance(30_000 + eleven.CEILING_GRACE_MS - 1)
    h.tts(3, 'Still held.', true)
    expect(h.passes()).toHaveLength(1)
    await h.advance(1)
    h.tts(4, 'Asked again.', true)
    await until(() => h.passes().length === 2, 'the edge asked again')
  })
})

const ELEVEN_SOCKET_RE = new RegExp(String.raw`^wss://api\.elevenlabs\.io/v1/text-to-speech/[A-Za-z0-9_-]{8,64}/multi-stream-input\?model_id=eleven_flash_v2_5&`)
describe('rule 9: speech output only', () => {
  it('every address fetched or opened in this file is on the allow-list, and the source names nothing else', () => {
    const elevenAddresses = addresses.filter(address => address.includes('elevenlabs'))
    expect(elevenAddresses.length).toBeGreaterThan(0)
    for (const address of addresses) {
      const allowed = address === '/_host/voice' || address.startsWith('wss://api.deepgram.com/') || address === URL_
        || ELEVEN_SOCKET_RE.test(address)
      expect(allowed, address).toBe(true)
    }
    const source = readFileSync(appPath('elevenlabs-voice.js'), 'utf8')
    for (const word of ['convai', 'agent_id', 'scribe', 'xi-api-key', 'xi_api_key', 'authorization', 'console.']) expect(source).not.toContain(word)
    expect(source.match(/wss:\/\/[^'"`\s]+/g)).toEqual(['wss://api.elevenlabs.io/v1/text-to-speech/'])
    expect(source.match(/https:\/\/[^'"`\s]+/g)).toBeNull()
  })
})
