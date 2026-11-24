/**
 * LOOK-ONLY VOICE, THE PAGE HALF (genesis-live.js).
 * The worker routes are faked with exactly the answers the worker half gives (`/__x6__/voice-mark`,
 * `/__x6__/session-model`), so what is proven here is the page: it sends nothing a worker did not confirm look-only,
 * speech reaches only the voice home, she sees her other threads by title, the timing marks change nothing else, and her
 * voice thread is asked to think quicker once, through the session-only route.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const livePath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}apps/web/public/app/genesis-live.js`)).find(existsSync)
type TurnResult = { reason: string; text: string; message?: string }
const live = await import(pathToFileURL(livePath ?? 'apps/web/public/app/genesis-live.js').href) as {
  createGenesisLive: (deps: Record<string, unknown>) => {
    fetch: (input: string, init?: RequestInit) => Promise<Response>
    streamTurn: (input: Record<string, unknown>) => Promise<TurnResult>
    arrivalTurn: (input: Record<string, unknown>) => Promise<TurnResult>
  }
  threadRoster: (items: unknown[], options?: { exclude?: string[]; now?: number }) => string
  titleOf: (item: unknown) => string
  awareThreads: (items: unknown[], options?: { exclude?: string[]; now?: number }) => Array<{ title: string }>
  workingNow: (items: unknown[], options?: { exclude?: string[]; now?: number }) => string
  WORKING_HEAD: string
  WORKING_MAX_BYTES: number
  WORKING_MAX_THREADS: number
  rosterClock: (ms: number, now: number) => string
  AUMA_LIVE_ALIEN_VOICE_DIRECTIVE: string
  AUMA_LIVE_VOICE_MEDIUM: string
  VOICE_CHANNEL_GUIDANCE: string
  VOICE_BUSY_SAY: string
  VOICE_BUSY_AFTER_MS: number
  VOICE_EFFORT: string
  VOICE_ARRIVAL: string
  VOICE_HOME_UNAVAILABLE: string
  VOICE_UNREACHABLE_SAY: string
  VOICE_RUNTIME_UNREACHABLE: string
  VOICE_ARRIVAL_CLOSED: string
  VOICE_LEVEL_PROBE_MS: number
  VOICE_OPEN_CREATES_MAX: number
  voiceHomeNoneSay: (stages: string[]) => string
  VOICE_MAP_MAX_CHARS: number
  AUMA_LIVE_VOICE_SESSION_KEY: string
  VOICE_PROVENANCE: string
  VOICE_PROVENANCE_OPEN: string
  VOICE_PROVENANCE_UNJOURNALED_OPEN: string
  VOICE_UNCONFIRMED_SAY: string
  VOICE_NOT_HOME_SAY: string
  VOICE_TAKEN_BACK_SAY: string
  VOICE_LOOK_ONLY_REFUSED: string
  VOICE_MODEL_SELECT_MS: number
  ROSTER_HEAD: string
  ROSTER_MAX_BYTES: number
  GENESIS_PROVIDER: string
  GENESIS_VOICE_CLASSES: readonly string[]
}

const VOICE_TITLE = '[voice] Auma Live'
const HOME = 'session-voice-1'
const NOW = new Date(2026, 10, 13, 14, 30).getTime()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const settle = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => { setTimeout(r, 0) }) }
const MARK_OK = () => json({ ok: true, code: 'VOICE_LOOK_ONLY', lookOnly: true })
const UNPROVEN = () => json({ ok: false, code: 'VOICE_HOME_UNPROVEN:named-after-use', lookOnly: false, say: 'My voice could not confirm it is look-only, so I did not send that.' }, 403)

type Call = { kind: 'rpc' | 'x6' | 'edge'; name: string; body: Record<string, unknown> }
type Item = {
  sessionId: string
  title?: string
  displayTitle?: string
  updatedAt?: unknown
  blank?: boolean
  origin?: string
  cwd?: string
  /** session/list's own field: this thread's Agent is mid-turn (session-controller list.ts). */
  running?: boolean
  /** This row reaches the page with no `projections` block (a cold row with no cache record): its title is
   * then known only to `session/projections`. */
  rowWithoutTitle?: boolean
}

/**
 * A row exactly as `session/list` sends it (session-controller types.ts SessionSummary, list.ts): no top-level
 * `title` or `displayTitle`; the title lives in `projections.values.title` (a cold row's `cached` block).
 */
function wireRow(item: Item): Record<string, unknown> {
  const title = item.title ?? item.displayTitle
  return {
    sessionId: item.sessionId, updatedAt: item.updatedAt, running: item.running === true, blank: item.blank === true, agentAvailable: false,
    ...(item.origin === undefined ? {} : { origin: item.origin }), ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
    ...(title === undefined || item.rowWithoutTitle === true ? {} : { projections: { kind: 'cached', asOfSeq: 3, values: { title } } }),
  }
}
type Stream = { args: unknown; push: (frame: unknown) => void; end: () => void }

/** Her worker and her edge as the page sees them: answers by contract, and one log of everything asked, in order. */
function world(options: {
  items?: Item[]
  mark?: (sessionId: string, n: number) => Response | Promise<Response>
  model?: (body: Record<string, unknown>) => Response | Promise<Response>
  createFails?: boolean
  projections?: unknown
  edge?: (body: Record<string, unknown>) => Response
  /** By default her turn answers by itself once the prompt is in; `manual` leaves the follow stream to the test. */
  manual?: boolean
  /** VOICE LEVEL asked first: the worker's answer to `GET /__x6__/voice-level`; unset, the route is never answered (as before). */
  level?: 'open' | 'look-only' | 'hang'
  list?: () => Response | Promise<Response>
  /** One session/create's answer, or null for the usual new thread. */
  create?: (request: Record<string, unknown>) => Response | null
  /** The page's DSH transport itself fails: at once ('now'), or only after the level probe's bound ('late'). */
  transportDown?: 'now' | 'late'
  /** One `session/projections` answer (the exact read of one conversation's title), or null for the usual. */
  projectionsRead?: (sessionId: string) => Response | null
  /** One `session/rename` answer, or null for the usual rename. */
  rename?: (request: Record<string, unknown>) => Response | null
} = {}) {
  const log: Call[] = []
  const items: Item[] = options.items ?? [{ sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 1000 }]
  const streams: Stream[] = []
  const store = new Map<string, string>()
  /** VOICE LEVEL: the stages the page reported to the worker (best effort; kept out of `log`, which lists what a turn needs). */
  const notes: string[] = []
  let marks = 0
  let creates = 0
  let levelAsks = 0
  const transport = {
    fetch: async (path: string, init: { body: string }) => {
      if (path === '/api/__x6__/voice-level' && options.level) {
        levelAsks += 1
        return options.level === 'hang' ? new Promise<Response>(() => {}) : json({ ok: true, level: options.level })
      }
      const body = JSON.parse(init.body) as Record<string, unknown>
      if (path.startsWith('/api/__x6__/')) {
        const name = path.slice('/api/__x6__/'.length)
        if (name === 'voice-note') { notes.push(String(body.stage)); return json({ ok: true }) }
        log.push({ kind: 'x6', name, body })
        if (name === 'voice-mark') { marks += 1; return (options.mark ?? MARK_OK)(String(body.sessionId), marks) }
        if (name === 'session-model') return (options.model ?? (() => json({ ok: true, sessionId: body.sessionId, selected: body, savedDefault: false })))(body)
        return json({ error: `Unknown X6 control route: POST ${path}` }, 404)
      }
      const method = path.replace('/api/', '')
      const args = (body as { payload: { args: Record<string, unknown> } }).payload.args
      log.push({ kind: 'rpc', name: method, body: args })
      if (method === 'session/list') return options.list ? options.list() : json({ result: { ok: true, value: { items: items.map(wireRow) } } })
      if (method === 'session/projections') {
        const sessionId = (args.request as { sessionId: string }).sessionId
        const own = options.projectionsRead?.(sessionId) ?? null
        if (own) return own
        const target = items.find(item => item.sessionId === sessionId)
        return json({ result: { ok: true, value: target ? { kind: 'sequenced', asOfSeq: 5, values: { title: target.title ?? target.displayTitle ?? null } } : null } })
      }
      if (method === 'session/create') {
        const own = options.create?.(args.request as Record<string, unknown>) ?? null
        if (own) return own
        if (options.createFails) return json({ result: { ok: false, error: { message: 'agent-preset/not-found' } } })
        creates += 1
        const sessionId = `session-fresh-${creates}`
        items.push({ sessionId, updatedAt: NOW })
        return json({ result: { ok: true, value: { sessionId, agentPreset: 'auma-alien' } } })
      }
      if (method === 'session/rename') {
        const own = options.rename?.(args.request as Record<string, unknown>) ?? null
        if (own) return own
        const request = args.request as { sessionId: string; title: string }
        const target = items.find(item => item.sessionId === request.sessionId)
        if (target) target.title = request.title
        return json({ result: { ok: true, value: { title: request.title, seq: 1 } } })
      }
      if (method === 'session/prompt' && options.manual !== true) {
        const stream = streams.at(-1)
        const requestId = (args.request as { requestId: string }).requestId
        setTimeout(() => {
          stream?.push({ type: 'event', event: { type: 'turn/start', data: { turn: 7 } } })
          stream?.push({ type: 'event', event: { type: 'user/message', data: { role: 'user', source: { kind: 'user', rpcId: requestId } } } })
          stream?.push({ type: 'event', event: { type: 'assistant/message', data: { turn: 7, step: 0, message: { content: [{ type: 'text', text: 'Done.' }] } } } })
          stream?.push({ type: 'event', event: { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } } })
        }, 0)
      }
      return json({ result: { ok: true, value: { accepted: true } } })
    },
    openStream: (_name: string, args: unknown, signal: AbortSignal) => {
      const queue: unknown[] = [{ type: 'snapshot', records: [], cursor: 0, hasMore: false, projections: options.projections ?? { asOfSeq: 0, values: {} } }]
      let wake: (() => void) | null = null
      let done = false
      streams.push({ args, push: (frame: unknown) => { queue.push(frame); wake?.() }, end: () => { done = true; wake?.() } })
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
    return options.edge ? options.edge(body) : json({ ok: true, action: body.action, turnId: body.turnId, voiceAuthority: 'none', savedBeforeDispatch: true })
  }
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
  const down = () => new Error('DSH transport is unavailable: open Auma Live inside the Aukora shell')
  const carrier = options.transportDown === 'now' ? Promise.reject(down())
    : options.transportDown === 'late' ? new Promise((_resolve, reject) => { setTimeout(() => { reject(down()) }, live.VOICE_LEVEL_PROBE_MS + 100) })
      : Promise.resolve(transport)
  const g = live.createGenesisLive({ transport: carrier, nativeFetch, storage, now: () => NOW })
  const prompts = () => log.filter(call => call.kind === 'rpc' && call.name === 'session/prompt').map(call => call.body.request as { requestId: string; sessionId: string; content: Array<{ type: string; text: string }> })
  return { g, log, streams, items, store, prompts, notes, levelAsks: () => levelAsks }
}

type Frame = { t: string; v?: unknown; reason?: string; message?: string; [key: string]: unknown }
function collect(response: Response) {
  const frames: Frame[] = []
  const done = (async () => {
    const reader = response.body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done: end, value } = await reader.read()
      if (end) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const match = part.match(/^data: (.*)$/m)
        if (match) frames.push(JSON.parse(match[1] as string) as Frame)
      }
    }
  })()
  return { frames, done }
}

const presence = (g: ReturnType<typeof world>['g'], body: Record<string, unknown>) => g.fetch('http://localhost/api/auma-live/presence/stream', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visual: true, ...body }),
})

/** Her reply to the prompt this page sent: one tool round with no words, then a spoken step. */
function answer(stream: Stream | undefined, requestId: string, turn = 3) {
  stream?.push({ type: 'event', event: { type: 'turn/start', data: { turn } } })
  stream?.push({ type: 'event', event: { type: 'user/message', data: { role: 'user', source: { kind: 'user', rpcId: requestId } } } })
  stream?.push({ type: 'assistant-stream', frame: { type: 'start', turn, step: 0 } })
  stream?.push({ type: 'event', event: { type: 'assistant/message', data: { turn, step: 0, message: { content: [{ type: 'tool-call', name: 'x6_threads' }] } } } })
  stream?.push({ type: 'assistant-stream', frame: { type: 'end', turn, step: 0 } })
  stream?.push({ type: 'assistant-stream', frame: { type: 'start', turn, step: 1 } })
  stream?.push({ type: 'assistant-stream', frame: { type: 'chunk', turn, step: 1, chunk: { type: 'text-delta', text: 'I read two threads.' } } })
  stream?.push({ type: 'assistant-stream', frame: { type: 'chunk', turn, step: 1, chunk: { type: 'text-delta', text: ' [field hue=teal]' } } })
  stream?.push({ type: 'assistant-stream', frame: { type: 'end', turn, step: 1 } })
  stream?.push({ type: 'event', event: { type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text: 'I read two threads. [field hue=teal]' }] } } } })
  stream?.push({ type: 'event', event: { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } } })
}

describe('a voice prompt is sent only when the worker confirms her voice home look-only', () => {
  const refusals: Array<[string, (sessionId: string, n: number) => Response | Promise<Response>, string]> = [
    ['no answer at all', () => Promise.reject(new Error('tunnel closed')), 'My voice could not confirm it is look-only, so I did not send that.'],
    ['ok false', () => json({ ok: false, code: 'VOICE_LOOK_ONLY_UNAVAILABLE', lookOnly: false }, 200), 'My voice could not confirm it is look-only, so I did not send that.'],
    ['ok but not look-only', () => json({ ok: true, lookOnly: false }), 'My voice could not confirm it is look-only, so I did not send that.'],
    ['404, a worker without the route', () => json({ error: 'Unknown X6 control route: POST /__x6__/voice-mark' }, 404), 'My voice could not confirm it is look-only, so I did not send that.'],
    ['503 with its own sentence', () => json({ ok: false, code: 'VOICE_MARK_NOT_SAVED', lookOnly: true, say: 'My look-only mark was not saved, so I did not send that.' }, 503), 'My look-only mark was not saved, so I did not send that.'],
    ['403 twice (a fresh home fails too)', UNPROVEN, 'My voice could not confirm it is look-only, so I did not send that.'],
  ]
  for (const [name, mark, sentence] of refusals) {
    it(`${name}: no prompt, no journal, and she says exactly why`, async () => {
      const w = world({ mark })
      const response = await presence(w.g, { sessionId: HOME, text: 'what are you working on', spoken: true })
      const read = collect(response)
      await read.done
      expect(w.prompts()).toEqual([])
      expect(w.log.some(call => call.kind === 'edge')).toBe(false)
      expect(w.streams).toEqual([])
      expect(read.frames).toEqual([{ t: 'tok', v: sentence }, { t: 'done', reason: live.VOICE_LOOK_ONLY_REFUSED, message: sentence }])
    })
  }

  it('the default sentence is the one the brief names, word for word', () => {
    expect(live.VOICE_UNCONFIRMED_SAY).toBe('My voice could not confirm it is look-only, so I did not send that.')
  })

  it('403 on every home: one fresh home is made, and no further home is made on any later turn', async () => {
    const w = world({ mark: UNPROVEN })
    for (const words of ['one', 'two', 'three', 'four', 'five']) {
      const read = collect(await presence(w.g, { sessionId: HOME, text: words, spoken: true }))
      await read.done
      expect(w.log.filter(call => call.name === 'session/create')).toHaveLength(1)
      expect(read.frames.at(-1)).toMatchObject({ t: 'done', reason: live.VOICE_LOOK_ONLY_REFUSED })
    }
    expect(w.prompts()).toEqual([])
    // Start Voice and the minds list after that make no home either.
    await presence(w.g, { action: 'start-voice', sessionId: HOME, recipient: live.GENESIS_PROVIDER, classes: live.GENESIS_VOICE_CLASSES })
    await w.g.fetch('http://localhost/api/auma-live/minds')
    expect(w.log.filter(call => call.name === 'session/create')).toHaveLength(1)
  })

  it('a page with no voice home makes one, and when the worker cannot prove that one either, it makes no second', async () => {
    const w = world({ mark: UNPROVEN, items: [{ sessionId: 'session-work', title: 'Garden map', updatedAt: NOW }] })
    const minds = await (await w.g.fetch('http://localhost/api/auma-live/minds')).json() as { homeSession?: string }
    expect(minds.homeSession).toBe('session-fresh-1')
    for (const words of ['one', 'two', 'three']) await collect(await presence(w.g, { sessionId: 'session-fresh-1', text: words, spoken: true })).done
    expect(w.log.filter(call => call.name === 'session/create')).toHaveLength(1)
    expect(w.prompts()).toEqual([])
  })

  it('a create that fails is not tried again on later turns', async () => {
    const w = world({ mark: UNPROVEN, createFails: true })
    for (const words of ['one', 'two', 'three']) await collect(await presence(w.g, { sessionId: HOME, text: words, spoken: true })).done
    expect(w.log.filter(call => call.name === 'session/create')).toHaveLength(1)
    expect(w.prompts()).toEqual([])
  })

  it('a typed line in the drawer goes to the voice home only after the mark, too', async () => {
    const w = world({ mark: () => json({ ok: false, code: 'VOICE_LOOK_ONLY_UNAVAILABLE', lookOnly: false }, 503) })
    await collect(await presence(w.g, { sessionId: HOME, text: 'typed in the drawer' })).done
    expect(w.prompts()).toEqual([])
  })
})

describe('VOICE LEVEL open: the worker says "open" and her voice home is an ordinary thread', () => {
  const MAP = '[your map for this voice turn, from your own runtime: where everything is. Look before you answer.]\nbuild made-up1; 3 tools.'
  const openWith = (map: unknown) => () => json({ ok: true, code: 'VOICE_OPEN', lookOnly: false, level: 'open', map })
  const OPEN = () => openWith(MAP)
  const emptyRoster = () => live.threadRoster([], { now: NOW })

  it('the turn is sent with her map beside the roster and the open line in place of the look-only line', async () => {
    const w = world({ mark: OPEN() })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'what is on main right now', spoken: true, visual: true }))
    await settle()
    // CHANGED: her cached voice-titled row is
    // read exactly once before it is adopted.
    expect(w.log.map(call => `${call.kind}:${call.name}`).slice(0, 5)).toEqual(['rpc:session/list', 'rpc:session/projections', 'x6:voice-mark', 'edge:dispatch_turn', 'rpc:session/prompt'])
    expect(w.prompts()[0]?.sessionId).toBe(HOME)
    expect(w.prompts()[0]?.content).toEqual([
      { type: 'text', text: live.VOICE_PROVENANCE_OPEN },
      { type: 'text', text: emptyRoster() },
      { type: 'text', text: MAP },
      { type: 'text', text: live.AUMA_LIVE_VOICE_MEDIUM },
      { type: 'text', text: live.VOICE_CHANNEL_GUIDANCE },
      { type: 'text', text: 'what is on main right now' },
    ])
    expect(w.notes).toEqual([])
    await read.done
  })

  it('the open marker starts as every spoken marker starts (the worker knows a spoken turn by it) and claims no lost authority', () => {
    for (const marker of [live.VOICE_PROVENANCE_OPEN, live.VOICE_PROVENANCE_UNJOURNALED_OPEN]) {
      expect(marker.startsWith('[spoken to Auma Live;')).toBe(true)
      expect(marker).not.toContain('no owner authority')
      expect(marker).toContain('passkey is still required for any Class 3 change')
    }
    expect(live.VOICE_PROVENANCE).toContain('voice carries no owner authority')
  })

  it('a host with no voice journal: the open marker says so, and the turn is still sent', async () => {
    const w = world({ mark: OPEN(), edge: () => json({ error: 'no voice director' }, 404) })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true }))
    await settle()
    expect(w.prompts()[0]?.content[0]?.text).toBe(live.VOICE_PROVENANCE_UNJOURNALED_OPEN)
    await read.done
  })

  it('the medium part, not a persona: facts about the channel, and none of the directive\'s instructions', () => {
    const closed = live.AUMA_LIVE_ALIEN_VOICE_DIRECTIVE, medium = live.AUMA_LIVE_VOICE_MEDIUM
    expect(closed).toContain('From voice you are look-only')
    expect(medium).not.toContain('look-only')
    for (const fact of [
      'spoken aloud to the owner as you write it, and shown to him in Auma Live',
      'Lists, tables, headings and code are not read well aloud.',
      // The exact grammar of the existing tag, as a capability.
      '[field hue=teal|cyan|jade|gold|amber|ember|rose|magenta|violet|indigo energy=0.15..0.95 storm=0.02..0.85 form=aurora|vortex|pulse|swarm]',
      'never spoken',
      'In voice you have what you have in a thread',
      'your map for this turn is above',
      'fingerprint card',
      'A key or a secret is never spoken.',
      // The owner's boundary from the earlier open line (an earlier commit), kept as a fact of the channel.
      'What is in your private folder is spoken only when the owner asks for it by name.',
    ]) expect(medium).toContain(fact)
    // Every instruction about who she is or how she should sound is gone at level open (and kept in the look-only one).
    for (const instruction of ['Stay wholly yourself', 'Speak for the ear', '1 to 4 resonant sentences', 'Put one [field', 'read them with x6_threads',
      'never describe a thread you did not read']) {
      expect(closed).toContain(instruction)
      expect(medium).not.toContain(instruction)
    }
    expect(medium).not.toMatch(/\b(you are|be yourself|stay|you should|you must)\b/i)
  })

  it('a map that is not text, or is too long, is left out; the turn is still sent', async () => {
    for (const map of [null, 7, 'm'.repeat(live.VOICE_MAP_MAX_CHARS + 1)]) {
      const w = world({ mark: openWith(map) })
      const read = collect(await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true }))
      await settle()
      expect(w.prompts()[0]?.content.map(part => part.text))
        .toEqual([live.VOICE_PROVENANCE_OPEN, emptyRoster(), live.AUMA_LIVE_VOICE_MEDIUM, live.VOICE_CHANNEL_GUIDANCE, 'hello'])
      await read.done
    }
  })

  it('an open worker needs no proof: the stored home is used as it is and no fresh home is made', async () => {
    const w = world({ mark: OPEN() })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true }))
    await settle()
    expect(w.log.filter(call => call.name === 'session/create')).toEqual([])
    expect(w.log.filter(call => call.name === 'voice-mark')).toHaveLength(1)
    await read.done
  })

  it('"level" alone is never a yes: ok false with level open is refused, and the page notes where it stopped', async () => {
    const w = world({ mark: () => json({ ok: false, code: 'VOICE_SESSION_INVALID', level: 'open' }, 400) })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true }))
    await read.done
    expect(w.prompts()).toEqual([])
    await settle()
    expect(w.notes).toEqual(['mark-refused'])
  })

  it('the page notes an unreachable worker and a failed create, each once per refusal', async () => {
    const down = world({ mark: () => Promise.reject(new Error('tunnel closed')) })
    await collect(await presence(down.g, { sessionId: HOME, text: 'hello', spoken: true })).done
    await settle()
    expect(down.notes).toEqual(['mark-unreachable'])
    const none = world({ items: [], createFails: true })
    await collect(await presence(none.g, { sessionId: HOME, text: 'hello', spoken: true })).done
    await settle()
    expect(none.notes).toEqual(['home-missing'])
  })
})

describe('VOICE LEVEL asked first (2026-11-14): at level open the look-only sentence does not exist', () => {
  const MAP = '[your map for this voice turn, from your own runtime: where everything is. Look before you answer.]\nbuild made-up2; 3 tools.'
  const OPEN_MARK = () => json({ ok: true, code: 'VOICE_OPEN', lookOnly: false, level: 'open', map: MAP })
  const PRESET = { cwd: '/dsh/home/auma', agentPreset: 'auma-alien' }
  const FOLDER = { cwd: '/dsh/home/auma' }
  const LIST_FAILS = () => json({ result: { ok: false, error: { message: 'session/list failed' } } })
  const CREATE_FAILS = () => json({ result: { ok: false, error: { message: 'agent-preset/not-found' } } })
  const WORK: Item = { sessionId: 'session-work', title: 'Garden map', updatedAt: NOW - 60_000 }
  const POISON = { sessionId: 'session-poison', updatedAt: NOW, get title(): string { throw new Error('a broken row') } }
  const POISONED_LIST = () =>
    ({ ok: true, status: 200, json: async () => ({ result: { ok: true, value: { items: [POISON] } } }) }) as unknown as Response
  const spokenTurn = async (w: ReturnType<typeof world>, words = 'hello', sessionId = HOME) => {
    const read = collect(await presence(w.g, { sessionId, text: words, spoken: true }))
    await read.done
    await settle()
    return read.frames
  }
  const creates = (w: ReturnType<typeof world>) => w.log.filter(call => call.name === 'session/create').map(call => call.body.request)
  const said = (frames: Frame[]) => frames.filter(frame => frame.t === 'tok').map(frame => frame.v).join('')

  it('the level is asked before anything else; the turn carries her map, the roster and the medium part, and goes to her home', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK })
    const frames = await spokenTurn(w, 'what is on main right now')
    expect(w.levelAsks()).toBe(1)
    // CHANGED: her cached voice-titled row is
    // read exactly once before it is adopted.
    expect(w.log.map(call => `${call.kind}:${call.name}`).slice(0, 5)).toEqual(['rpc:session/list', 'rpc:session/projections', 'x6:voice-mark', 'edge:dispatch_turn', 'rpc:session/prompt'])
    expect(w.prompts()[0]?.sessionId).toBe(HOME)
    expect(w.prompts()[0]?.content.map(part => part.text)).toEqual([
      live.VOICE_PROVENANCE_OPEN, live.threadRoster([], { now: NOW }), MAP, live.AUMA_LIVE_VOICE_MEDIUM, live.VOICE_CHANNEL_GUIDANCE, 'what is on main right now',
    ])
    expect(said(frames)).toBe('Done.')
    expect(w.notes).toEqual([])
  })

  // CHANGED: the stored id is used only when its
  // title proves it is her voice conversation; a stored working thread is noted and passed over.
  it('the stored id is used only when proven her voice conversation: a stored working thread is noted and passed over', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [WORK, { sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 5 }] })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, 'session-work')
    await spokenTurn(w)
    expect(w.prompts()[0]?.sessionId).toBe(HOME)
    expect(creates(w)).toEqual([])
    expect(w.notes).toEqual(['home-stored-not-voice'])
  })

  // Each failure the old sentence covered: the turn is sent whenever any thread exists, and the sentence is never said.
  const failures: Array<[string, Parameters<typeof world>[0], (w: ReturnType<typeof world>) => void, string, string[]]> = [
    ['the list fails: a fresh home is made with her preset and folder, renamed, and used', { list: LIST_FAILS },
      () => {}, 'session-fresh-1', ['home-list-failed']],
    ['no voice home and agent-preset/not-found: made with her folder only', { items: [WORK], create: request => (request.agentPreset ? CREATE_FAILS() : null) },
      () => {}, 'session-fresh-1', ['home-create-preset-failed']],
    ['the mark is unreachable: sent without the map', { mark: () => Promise.reject(new Error('tunnel closed')) }, () => {}, HOME, ['mark-unreachable']],
    ['the mark answers 404: sent', { mark: () => json({ error: 'Unknown X6 control route' }, 404) }, () => {}, HOME, ['mark-refused']],
    ['the mark answers 400 VOICE_SESSION_INVALID: sent', { mark: () => json({ ok: false, code: 'VOICE_SESSION_INVALID' }, 400) }, () => {}, HOME, ['mark-refused']],
    ['the mark answers 503: sent', { mark: () => json({ ok: false, code: 'VOICE_MARK_NOT_SAVED', say: 'not saved' }, 503) }, () => {}, HOME, ['mark-refused']],
  ]
  for (const [name, options, before, sentTo, stages] of failures) {
    it(name, async () => {
      const w = world({ level: 'open', mark: OPEN_MARK, ...options })
      before(w)
      const frames = await spokenTurn(w)
      expect(w.prompts().map(prompt => prompt.sessionId)).toEqual([sentTo])
      expect(said(frames)).toBe('Done.')
      expect(JSON.stringify(frames)).not.toContain(live.VOICE_UNCONFIRMED_SAY)
      expect(w.notes).toEqual(stages)
      const content = w.prompts()[0]?.content.map(part => part.text) ?? []
      expect(content[0]).toBe(live.VOICE_PROVENANCE_OPEN)
      expect(content).toContain(live.AUMA_LIVE_VOICE_MEDIUM)
      // Her map rides only an answer that carried it.
      expect(content.includes(MAP)).toBe(!stages.some(stage => stage.startsWith('mark-')))
    })
  }

  // CHANGED: a stored id is used "as it is" when the list fails
  // ONLY when this page proved it earlier in this page life. A fresh page cannot prove it: a new voice thread is made.
  it('the list fails on a fresh page with a stored id: not proven, so it is not used; a new voice thread is made instead', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, list: LIST_FAILS })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, 'session-stored')
    const frames = await spokenTurn(w)
    expect(w.prompts().map(prompt => prompt.sessionId)).toEqual(['session-fresh-1'])
    expect(w.notes).toEqual(['home-list-failed'])
    expect(said(frames)).toBe('Done.')
    // Every create would fail too: nothing is posted anywhere, and she says so.
    const none = world({ level: 'open', mark: OPEN_MARK, list: LIST_FAILS, createFails: true })
    none.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, 'session-stored')
    const refused = await spokenTurn(none)
    expect(none.prompts()).toEqual([])
    expect(said(refused)).toBe('My voice thread would not open (list failed, create failed). Try me again.')
  })

  it('the list fails after this page proved its voice thread: that thread is used as it is, and nothing is made', async () => {
    let failing = false
    const w = world({ level: 'open', mark: OPEN_MARK, list: () => (failing ? LIST_FAILS() : json({ result: { ok: true, value: { items: [wireRow({ sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 5 })] } } })) })
    await spokenTurn(w, 'one')
    failing = true
    await spokenTurn(w, 'two')
    expect(creates(w)).toEqual([])
    expect(w.prompts().map(prompt => prompt.sessionId)).toEqual([HOME, HOME])
    expect(w.notes).toEqual(['home-list-failed', 'home-stored-unlisted'])
  })

  // CHANGED: an exception while the home is found no longer falls back to an unproven stored id.
  it('an exception inside the block: nothing is posted, and she says so', async () => {
    // A row that throws when read (a Response is the only way past JSON, which would read it in the fixture instead).
    const w = world({ level: 'open', mark: OPEN_MARK, list: () => POISONED_LIST() })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, 'session-stored')
    const frames = await spokenTurn(w)
    expect(w.prompts()).toEqual([])
    expect(said(frames)).toBe('My voice thread would not open (an error). Try me again.')
    expect(w.notes).toEqual(['home-exception', 'home-none'])
  })

  it('the made home is created in order (preset and folder, folder, nothing) and each new thread is renamed to the voice title', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [], create: request => (Object.keys(request).length > 0 ? CREATE_FAILS() : null) })
    await spokenTurn(w)
    expect(creates(w)).toEqual([PRESET, FOLDER, {}])
    expect(w.log.find(call => call.name === 'session/rename')?.body).toEqual({ request: { sessionId: 'session-fresh-1', title: VOICE_TITLE } })
    expect(w.store.get(live.AUMA_LIVE_VOICE_SESSION_KEY)).toBe('session-fresh-1')
    expect(w.prompts()[0]?.sessionId).toBe('session-fresh-1')
  })

  it('nothing exists and nothing can be made: she says which steps failed, in her own channel, never the look-only sentence', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [], createFails: true })
    const frames = await spokenTurn(w)
    const sentence = 'My voice thread would not open (create failed). Try me again.'
    expect(frames).toEqual([{ t: 'tok', v: sentence }, { t: 'done', reason: live.VOICE_HOME_UNAVAILABLE, message: sentence }])
    expect(w.prompts()).toEqual([])
    expect(w.notes.at(-1)).toBe('home-none')
    const down = world({ level: 'open', mark: OPEN_MARK, list: LIST_FAILS, createFails: true })
    const none = await spokenTurn(down)
    expect(said(none)).toBe('My voice thread would not open (list failed, create failed). Try me again.')
    expect(live.voiceHomeNoneSay([])).toBe('My voice thread would not open (no thread found). Try me again.')
  })

  // CHANGED: the last-resort fallback to her most recently active thread is gone: she says so in words.
  it('the one-fresh-home limit does not apply at open: at most three creates per page, then she says so; no fallback thread', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [WORK], createFails: true })
    const first = await spokenTurn(w, 'one')
    const second = await spokenTurn(w, 'two')
    expect(creates(w)).toHaveLength(live.VOICE_OPEN_CREATES_MAX)
    expect(w.prompts()).toEqual([])
    expect(said(first)).toBe('My voice thread would not open (create failed). Try me again.')
    expect(said(second)).toBe('My voice thread would not open (no more new threads on this page). Try me again.')
    expect(w.notes.slice(-2)).toEqual(['home-creates-spent', 'home-none'])
    // A page whose first fresh home works makes a second one when that thread is gone from the list (look-only never would).
    const v = world({ level: 'open', mark: OPEN_MARK, items: [] })
    await spokenTurn(v, 'one')
    v.items.length = 0
    v.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, 'session-gone')
    await spokenTurn(v, 'two')
    expect(v.prompts().map(prompt => prompt.sessionId)).toEqual(['session-fresh-1', 'session-fresh-2'])
  })

  it('a spoken turn naming another thread goes to her voice home (not refused); a typed one goes where it was named', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [{ sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 5 }, WORK] })
    const frames = await spokenTurn(w, 'hello', 'session-work')
    expect(said(frames)).toBe('Done.')
    expect(w.prompts()[0]?.sessionId).toBe(HOME)
    const typed = collect(await presence(w.g, { sessionId: 'session-work', text: 'typed' }))
    await typed.done
    expect(w.prompts()[1]?.sessionId).toBe('session-work')
    expect(w.prompts()[1]?.content.at(-1)).toEqual({ type: 'text', text: 'typed' })
    expect(w.log.filter(call => call.name === 'voice-mark')).toHaveLength(1)
  })

  it('Canvas speech at open: the honest sentence through onToken when nothing can be sent; sent to the found home otherwise', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [], createFails: true })
    const heard: string[] = []
    const result = await w.g.streamTurn({ sessionId: 'session-x', text: 'hi', spoken: true, signal: new AbortController().signal, onToken: (v: string) => { heard.push(v) } })
    expect(result.reason).toBe(live.VOICE_HOME_UNAVAILABLE)
    expect(heard.join('')).toBe('My voice thread would not open (create failed). Try me again.')
    const v = world({ level: 'open', mark: OPEN_MARK })
    const sent = await v.g.streamTurn({ sessionId: 'session-x', text: 'hi', spoken: true, signal: new AbortController().signal })
    expect(sent.text).toBe('Done.')
    expect(v.prompts()[0]?.sessionId).toBe(HOME)
  })

  it('a level probe that never answers holds the turn at most VOICE_LEVEL_PROBE_MS, then the look-only flow runs unchanged', async () => {
    const w = world({ level: 'hang', mark: MARK_OK })
    const started = Date.now()
    const frames = await spokenTurn(w)
    expect(Date.now() - started).toBeGreaterThanOrEqual(live.VOICE_LEVEL_PROBE_MS - 50)
    expect(said(frames)).toBe('Done.')
    expect(w.prompts()[0]?.content[0]?.text).toBe(live.VOICE_PROVENANCE)
    const refused = await spokenTurn(world({ level: 'look-only', mark: UNPROVEN, createFails: true }))
    expect(said(refused)).toBe(live.VOICE_UNCONFIRMED_SAY)
  }, 10_000)

  it('an answered level is asked once, then trusted; each page asks its own worker', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK })
    await spokenTurn(w, 'one')
    await spokenTurn(w, 'two')
    expect(w.levelAsks()).toBe(1)
  })

  it('a fast default for spoken turns only (2026-11-16): spoken turns in her voice thread think at low, "deep" asks for her own effort back', async () => {
    const projections = (effort?: string) => ({ asOfSeq: 2, values: { modelSelection: { lastUsed: null, next: { provider: 'deepseek', model: 'deepseek-v4', ...(effort ? { reasoningEffort: effort } : {}) } } } })
    expect(live.VOICE_EFFORT).toBe('low')
    for (const effort of ['max', 'high']) {
      const w = world({ level: 'open', mark: OPEN_MARK, projections: projections(effort) })
      await spokenTurn(w, 'one')
      const deep = collect(await presence(w.g, { sessionId: HOME, text: 'two', spoken: true, mind: 'deep' }))
      await deep.done
      // Through the session-only route (it saves no default), the model the thread already uses; never the session-wide RPC.
      expect(w.log.filter(call => call.name === 'session-model').map(call => call.body)).toEqual([
        { sessionId: HOME, provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'low' },
        { sessionId: HOME, provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: effort },
      ])
      expect(w.log.some(call => /selectModel|modelCatalog/.test(call.name))).toBe(false)
    }
    // A thread already at low is not asked again for a spoken turn.
    const low = world({ level: 'open', mark: OPEN_MARK, projections: projections('low') })
    await spokenTurn(low, 'one')
    await spokenTurn(low, 'two', HOME)
    expect(low.log.some(call => call.name === 'session-model')).toBe(false)
  })

  it('her own mind for typed turns: a typed turn into her voice thread puts back an effort this page lowered; it carries no voice guidance', async () => {
    const projections = { asOfSeq: 2, values: { modelSelection: { lastUsed: null, next: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'low' } } } }
    const w = world({ level: 'open', mark: OPEN_MARK, projections })
    const typed = collect(await presence(w.g, { sessionId: HOME, text: 'typed here' }))
    await typed.done
    expect(w.log.filter(call => call.name === 'session-model').map(call => call.body)).toEqual([{ sessionId: HOME, provider: 'deepseek', model: 'deepseek-v4' }])
    expect(w.prompts()[0]?.content.map(part => part.text)).not.toContain(live.VOICE_CHANNEL_GUIDANCE)
    // CHANGED: her ordinary thread is never a spoken turn's target any more, so nothing touches its mind.
    const fallback = world({ level: 'open', mark: OPEN_MARK, items: [WORK], createFails: true, projections: { asOfSeq: 2, values: { modelSelection: { lastUsed: null, next: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'max' } } } } })
    await spokenTurn(fallback, 'hello')
    expect(fallback.prompts()).toEqual([])
    expect(fallback.log.some(call => call.name === 'session-model')).toBe(false)
  })

  // CHANGED: no last fallback at all: with only ordinary threads and no voice thread, nothing is sent.
  it('no fallback thread: with her ordinary and private threads listed and no voice thread made, nothing is sent', async () => {
    const PRIVATE: Item = { sessionId: 'session-private', title: 'Kira notes', updatedAt: NOW, cwd: '/dsh/home/auma/private/kira' }
    const w = world({ level: 'open', mark: OPEN_MARK, items: [PRIVATE, WORK], createFails: true })
    const frames = await spokenTurn(w)
    expect(w.prompts()).toEqual([])
    expect(said(frames)).toBe('My voice thread would not open (create failed). Try me again.')
    const only = world({ level: 'open', mark: OPEN_MARK, items: [{ ...PRIVATE, cwd: '/dsh/home/auma/private' }], createFails: true })
    const none = await spokenTurn(only)
    expect(only.prompts()).toEqual([])
    expect(said(none)).toBe('My voice thread would not open (create failed). Try me again.')
    expect(only.notes.at(-1)).toBe('home-none')
  })

  // CHANGED: her ordinary thread carries no spoken turn either.
  it('her most recent ordinary thread is never her home: not for the page, and not for a spoken turn', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [WORK], createFails: true })
    const minds = await (await w.g.fetch('http://localhost/api/auma-live/minds')).json() as { homeSession?: string }
    expect(minds).not.toHaveProperty('homeSession')
    const grant = await presence(w.g, { action: 'start-voice', sessionId: 'session-work', recipient: live.GENESIS_PROVIDER, classes: live.GENESIS_VOICE_CLASSES })
    expect(grant.status).toBe(404)
    expect(await grant.json()).toEqual({ refusal: 'session-not-found' })
    await spokenTurn(w)
    expect(w.prompts()).toEqual([])
    // A made voice home is still the page's home.
    const v = world({ level: 'open', mark: OPEN_MARK, items: [WORK] })
    const made = await (await v.g.fetch('http://localhost/api/auma-live/minds')).json() as { homeSession?: string }
    expect(made.homeSession).toBe('session-fresh-1')
  })

  it('a page that cannot reach her runtime at all says so, at any level, and never the look-only sentence', async () => {
    const w = world({ transportDown: 'now' })
    const frames = await spokenTurn(w)
    expect(frames).toEqual([
      { t: 'tok', v: live.VOICE_UNREACHABLE_SAY },
      { t: 'done', reason: live.VOICE_RUNTIME_UNREACHABLE, message: live.VOICE_UNREACHABLE_SAY },
    ])
    expect(w.log).toEqual([])
    const heard: string[] = []
    const result = await w.g.streamTurn({ sessionId: HOME, text: 'hi', spoken: true, signal: new AbortController().signal, onToken: (v: string) => { heard.push(v) } })
    expect(result.reason).toBe(live.VOICE_RUNTIME_UNREACHABLE)
    expect(heard.join('')).toBe(live.VOICE_UNREACHABLE_SAY)
    expect(live.VOICE_UNREACHABLE_SAY).not.toContain('look-only')
  })

  it('a transport that fails only after the level probe gave up: the look-only flow says the runtime is unreachable', async () => {
    const w = world({ transportDown: 'late' })
    const frames = await spokenTurn(w)
    expect(said(frames)).toBe(live.VOICE_UNREACHABLE_SAY)
    expect(frames.at(-1)).toMatchObject({ t: 'done', reason: live.VOICE_RUNTIME_UNREACHABLE })
    expect(w.prompts()).toEqual([])
  }, 10_000)

  it('the arrival turn: one turn in her voice home framed only by the moment (with map, roster, medium), journaled nowhere', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK })
    const heard: string[] = []
    const result = await w.g.arrivalTurn({ signal: new AbortController().signal, onToken: (v: string) => { heard.push(v) } })
    expect(result).toMatchObject({ reason: 'completed', text: 'Done.' })
    expect(heard.join('')).toBe('Done.')
    expect(w.prompts()[0]?.sessionId).toBe(HOME)
    expect(w.prompts()[0]?.content.map(part => part.text))
      .toEqual([live.threadRoster([], { now: NOW }), MAP, live.AUMA_LIVE_VOICE_MEDIUM, live.VOICE_CHANNEL_GUIDANCE, live.VOICE_ARRIVAL])
    expect(w.log.some(call => call.kind === 'edge')).toBe(false)
    expect(live.VOICE_ARRIVAL).toContain('has not spoken yet')
    expect(live.VOICE_ARRIVAL).not.toMatch(/curious|greet|introduce|say hello/i)
  })

  it('no arrival turn below level open, or with no home: nothing is prompted, nothing is said', async () => {
    for (const options of [{}, { level: 'look-only' as const }, { level: 'open' as const, items: [], createFails: true }]) {
      const w = world({ mark: OPEN_MARK, ...options })
      const heard: string[] = []
      const result = await w.g.arrivalTurn({ signal: new AbortController().signal, onToken: (v: string) => { heard.push(v) } })
      expect(result.text).toBe('')
      expect(heard).toEqual([])
      expect(w.prompts()).toEqual([])
    }
  })
})

describe('a voice home the worker cannot prove is replaced once, exactly as the handoff says', () => {
  it('403 VOICE_HOME_UNPROVEN: fresh home with her folder and preset, renamed before the second mark, stored, then sent there', async () => {
    const w = world({ mark: sessionId => (sessionId === HOME ? UNPROVEN() : MARK_OK()) })
    const response = await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true })
    const read = collect(response)
    await settle()
    const order = w.log.filter(call => call.name !== 'session/list').map(call => `${call.kind}:${call.name}`)
    // CHANGED: her cached voice-titled row is
    // read exactly once before it is adopted.
    expect(order).toEqual(['rpc:session/projections', 'x6:voice-mark', 'rpc:session/create', 'rpc:session/rename', 'x6:voice-mark', 'edge:dispatch_turn', 'rpc:session/prompt'])
    expect(w.log.find(call => call.name === 'session/create')?.body).toEqual({ request: { cwd: '/dsh/home/auma', agentPreset: 'auma-alien' } })
    expect(w.log.find(call => call.name === 'session/rename')?.body).toEqual({ request: { sessionId: 'session-fresh-1', title: VOICE_TITLE } })
    expect(w.log.filter(call => call.name === 'voice-mark').map(call => call.body)).toEqual([{ sessionId: HOME }, { sessionId: 'session-fresh-1' }])
    expect(w.store.get(live.AUMA_LIVE_VOICE_SESSION_KEY)).toBe('session-fresh-1')
    expect(w.prompts()[0]?.sessionId).toBe('session-fresh-1')
    expect(response.headers.get('x-auma-live-session')).toBe('session-fresh-1')
    // The page still names the old home on its next turn: it goes to the fresh one, and the old one is never adopted again.
    await read.done
    const next = collect(await presence(w.g, { sessionId: HOME, text: 'again', spoken: true }))
    await settle()
    expect(w.prompts()[1]?.sessionId).toBe('session-fresh-1')
    expect(w.log.filter(call => call.name === 'voice-mark').at(-1)?.body).toEqual({ sessionId: 'session-fresh-1' })
    expect(w.log.filter(call => call.name === 'session/create')).toHaveLength(1)
    await next.done
  })

  it('no fallback create without the preset: a failed create is said, and nothing is sent', async () => {
    const w = world({ mark: UNPROVEN, createFails: true })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true }))
    await read.done
    expect(w.log.filter(call => call.name === 'session/create').map(call => call.body)).toEqual([{ request: { cwd: '/dsh/home/auma', agentPreset: 'auma-alien' } }])
    expect(w.prompts()).toEqual([])
    expect(read.frames[0]).toEqual({ t: 'tok', v: live.VOICE_UNCONFIRMED_SAY })
  })

  it('a stored working thread is never renamed into the voice home', async () => {
    const w = world({ items: [{ sessionId: 'session-work', title: 'Garden map', updatedAt: NOW }, { sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 5 }] })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, 'session-work')
    const minds = await (await w.g.fetch('http://localhost/api/auma-live/minds')).json() as { homeSession?: string }
    expect(minds.homeSession).toBe(HOME)
    expect(w.log.some(call => call.name === 'session/rename')).toBe(false)
  })
})

describe('mark and journal both come before the prompt', () => {
  it('order: list, mark, journal, prompt; the prompt carries the provenance first', async () => {
    const w = world()
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'what is staged', spoken: true }))
    await settle()
    // CHANGED: her cached voice-titled row is
    // read exactly once before it is adopted.
    expect(w.log.map(call => `${call.kind}:${call.name}`)).toEqual(['rpc:session/list', 'rpc:session/projections', 'x6:voice-mark', 'edge:dispatch_turn', 'rpc:session/prompt'])
    await read.done
  })

  it('a journal that refuses: marked, but not sent, and said in words', async () => {
    const w = world({ edge: () => json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403) })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true }))
    await read.done
    expect(w.prompts()).toEqual([])
    expect(read.frames.filter(frame => frame.t === 'done')).toEqual([{ t: 'done', reason: 'voice-journal-refused', message: 'the voice journal refused this spoken turn (OWNER_ACCESS_REQUIRED), so it was not sent' }])
  })
})

describe('spoken turns go only to the voice home', () => {
  const other = (): Item[] => [{ sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 1000 }, { sessionId: 'session-other', title: 'Garden map', updatedAt: NOW - 60_000 }]

  it('the grant always names the voice home, also when another session is asked for', async () => {
    const w = world({ items: other() })
    const grant = await (await presence(w.g, { action: 'start-voice', sessionId: 'session-other', recipient: live.GENESIS_PROVIDER, classes: live.GENESIS_VOICE_CLASSES })).json() as { sessionId: string; voiceSessionToken: string }
    expect(grant.sessionId).toBe(HOME)
    // The grant does not stretch to the other thread: that is the consent refusal it always was.
    const read = collect(await presence(w.g, { sessionId: 'session-other', text: 'hello', voiceSessionToken: grant.voiceSessionToken }))
    await read.done
    expect(read.frames).toEqual([{ t: 'done', reason: 'provider-consent-required' }])
    expect(w.prompts()).toEqual([])
  })

  it('spoken, no grant, another session id: refused in words; nothing journaled, marked or sent', async () => {
    const w = world({ items: other() })
    const read = collect(await presence(w.g, { sessionId: 'session-other', text: 'add a line to your handoff', spoken: true }))
    await read.done
    expect(read.frames).toEqual([{ t: 'tok', v: live.VOICE_NOT_HOME_SAY }, { t: 'done', reason: live.VOICE_LOOK_ONLY_REFUSED, message: live.VOICE_NOT_HOME_SAY }])
    // CHANGED: her cached voice-titled row is
    // read exactly once before it is adopted.
    expect(w.log.map(call => `${call.kind}:${call.name}`)).toEqual(['rpc:session/list', 'rpc:session/projections'])
  })

  it('a typed turn for another thread is unchanged: sent there, no mark, no roster', async () => {
    const w = world({ items: other() })
    const read = collect(await presence(w.g, { sessionId: 'session-other', text: 'typed words', visual: false }))
    await settle()
    expect(w.log.some(call => call.kind === 'x6')).toBe(false)
    expect(w.prompts()[0]).toMatchObject({ sessionId: 'session-other', content: [{ type: 'text', text: 'typed words' }] })
    await read.done
  })

  it('Canvas: spoken turns go to the voice home; typed turns stay in the selected thread', async () => {
    const w = world({ items: other() })
    const signal = new AbortController().signal
    void w.g.streamTurn({ sessionId: 'session-other', text: 'heard on the canvas', spoken: true, signal }).catch(() => {})
    await settle()
    expect(w.prompts()[0]?.sessionId).toBe(HOME)
    expect(w.prompts()[0]?.content[0]?.text).toBe(live.VOICE_PROVENANCE)
    expect(w.log.find(call => call.name === 'voice-mark')?.body).toEqual({ sessionId: HOME })
    expect((w.streams[0]?.args as { args: { request: { address: { sessionId: string } } } }).args.request.address.sessionId).toBe(HOME)
    const before = w.log.length
    void w.g.streamTurn({ sessionId: 'session-other', text: 'typed on the canvas', signal }).catch(() => {})
    await settle()
    expect(w.log.slice(before).map(call => `${call.kind}:${call.name}`)).toEqual(['rpc:session/prompt'])
    expect(w.prompts()[1]).toMatchObject({ sessionId: 'session-other', content: [{ type: 'text', text: 'typed on the canvas' }] })
  })

  it('Canvas, no voice home yet: a typed turn for a work thread makes no home and is sent there unchanged', async () => {
    const w = world({ items: [{ sessionId: 'session-work', title: 'Garden map', updatedAt: NOW }] })
    const read = collect(await presence(w.g, { sessionId: 'session-work', text: 'typed on the canvas' }))
    await settle()
    expect(w.log.some(call => call.name === 'session/create' || call.name === 'session/rename' || call.kind === 'x6')).toBe(false)
    expect(w.prompts().map(prompt => [prompt.sessionId, prompt.content.at(-1)?.text])).toEqual([['session-work', 'typed on the canvas']])
    await read.done
  })

  it('Canvas, after the page\'s one create failed: typed turns for a work thread still go there, every time', async () => {
    const w = world({ createFails: true, items: [{ sessionId: 'session-work', title: 'Garden map', updatedAt: NOW }] })
    const heard = collect(await presence(w.g, { sessionId: 'session-work', text: 'heard on the canvas', spoken: true }))
    await heard.done
    expect(heard.frames[0]).toEqual({ t: 'tok', v: live.VOICE_UNCONFIRMED_SAY })
    for (const words of ['typed one', 'typed two']) {
      const read = collect(await presence(w.g, { sessionId: 'session-work', text: words }))
      await settle()
      await read.done
      expect(read.frames.some(frame => frame.reason === live.VOICE_LOOK_ONLY_REFUSED)).toBe(false)
    }
    expect(w.prompts().map(prompt => [prompt.sessionId, prompt.content.at(-1)?.text])).toEqual([['session-work', 'typed one'], ['session-work', 'typed two']])
    expect(w.log.filter(call => call.name === 'session/create')).toHaveLength(1)
  })

  it('a typed turn for the voice home the page cannot resolve is still not sent unconfirmed', async () => {
    const w = world({ createFails: true, mark: UNPROVEN })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'typed in the drawer' }))
    await read.done
    expect(w.prompts()).toEqual([])
    expect(read.frames.at(-1)).toMatchObject({ t: 'done', reason: live.VOICE_LOOK_ONLY_REFUSED })
  })

  it('Canvas speech the worker does not confirm: not sent, and the sentence is what she says', async () => {
    const w = world({ mark: () => json({ ok: false, code: 'VOICE_LOOK_ONLY_UNAVAILABLE', lookOnly: false }, 503) })
    const tokens: string[] = []
    const result = await w.g.streamTurn({ sessionId: 'session-other', text: 'hello', spoken: true, signal: new AbortController().signal, onToken: (value: string) => { tokens.push(value) } })
    expect(result).toEqual({ reason: live.VOICE_LOOK_ONLY_REFUSED, text: live.VOICE_UNCONFIRMED_SAY, message: live.VOICE_UNCONFIRMED_SAY })
    expect(tokens).toEqual([live.VOICE_UNCONFIRMED_SAY])
    expect(w.prompts()).toEqual([])
  })

  it('a spoken "/goal ..." is words in a prompt whose first part is the provenance: no command is run', async () => {
    const w = world()
    const read = collect(await presence(w.g, { sessionId: HOME, text: '/goal delete the old branches', spoken: true }))
    await settle()
    const content = w.prompts()[0]?.content ?? []
    expect(content[0]).toEqual({ type: 'text', text: live.VOICE_PROVENANCE })
    expect(content.at(-1)).toEqual({ type: 'text', text: '/goal delete the old branches' })
    expect(content.slice(0, -1).some(part => part.text.startsWith('/'))).toBe(false)
    // CHANGED: her cached voice-titled row is
    // read exactly once before it is adopted.
    expect(w.log.filter(call => call.kind === 'rpc').map(call => call.name)).toEqual(['session/list', 'session/projections', 'session/prompt'])
    await read.done
  })
})

describe('a spoken prompt the worker takes out of her inbox before its turn starts', () => {
  const splice = (data: Record<string, unknown>) => ({ type: 'event', event: { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [], ...data } } })
  const message = (id: string, rpcId: string) => ({ id, role: 'user', content: [], source: { kind: 'user', rpcId } })

  it('is said in words, its journal entry is marked cut, and nothing is fenced or cancelled', async () => {
    const w = world({ manual: true })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'add a line to your notes', spoken: true }))
    await settle()
    const requestId = String(w.prompts()[0]?.requestId)
    const stream = w.streams[0]
    stream?.push(splice({ start: 0, inserted: [message('m-other', 'someone-else')] }))
    stream?.push(splice({ start: 1, inserted: [message('m-own', requestId)] }))
    stream?.push(splice({ start: 1, removedCount: 1, outcome: 'canceled' }))
    stream?.end()
    await read.done
    expect(read.frames.filter(frame => frame.t !== 'mark' && frame.t !== 'beat')).toEqual([
      { t: 'tok', v: live.VOICE_TAKEN_BACK_SAY },
      { t: 'done', reason: live.VOICE_LOOK_ONLY_REFUSED, message: live.VOICE_TAKEN_BACK_SAY },
    ])
    expect(live.VOICE_TAKEN_BACK_SAY).toBe('This turn was spoken, and I take spoken turns only in my look-only voice thread. Say it in Auma Live, or type it here.')
    await settle()
    expect(w.log.filter(call => call.kind === 'edge').map(call => call.name)).toEqual(['dispatch_turn', 'barge_in'])
    expect(w.log.some(call => call.name === 'session/state' || call.name === 'session/cancel' || call.name === 'session/updateQueue')).toBe(false)
  })

  it('another message cancelled ahead of hers moves her place; her turn then runs as usual', async () => {
    const w = world({ manual: true })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'which threads', spoken: true }))
    await settle()
    const requestId = String(w.prompts()[0]?.requestId)
    const stream = w.streams[0]
    stream?.push(splice({ start: 0, inserted: [message('m-other', 'someone-else'), message('m-own', requestId)] }))
    stream?.push(splice({ start: 0, removedCount: 1, outcome: 'canceled' }))
    // Claimed for her turn (a removal that is not a cancel), then her turn.
    stream?.push(splice({ start: 0, removedCount: 1 }))
    answer(stream, requestId)
    await read.done
    expect(read.frames.filter(frame => frame.t === 'tok').map(frame => frame.v)).toEqual(['I read two threads.', ' [field hue=teal]'])
    expect(read.frames.at(-1)).toEqual({ t: 'done', reason: 'completed' })
  })

  it('a typed prompt that is cancelled is not answered with the spoken sentence', async () => {
    const w = world({ manual: true, items: [{ sessionId: HOME, title: VOICE_TITLE, updatedAt: 1 }, { sessionId: 'session-other', title: 'x', updatedAt: 2 }] })
    const tokens: string[] = []
    const turn = w.g.streamTurn({ sessionId: 'session-other', text: 'typed', signal: new AbortController().signal, onToken: (v: string) => { tokens.push(v) } })
    await settle()
    const stream = w.streams[0]
    stream?.push(splice({ start: 0, inserted: [message('m-own', String(w.prompts()[0]?.requestId))] }))
    stream?.push(splice({ start: 0, removedCount: 1, outcome: 'canceled' }))
    stream?.end()
    expect((await turn).reason).toBe('stream-ended')
    expect(tokens).toEqual([])
  })
})

describe('sight of her other threads', () => {
  it('rides every voice turn as one part after the provenance: titles and clock times, the voice home left out', async () => {
    const items: Item[] = [
      { sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW },
      { sessionId: 'session-1a2b3c4d-0000', title: 'Garden map', updatedAt: new Date(2026, 10, 13, 9, 5).getTime() },
      { sessionId: 'session-5e6f7a8b-0000', title: 'Deploy notes', updatedAt: new Date(2026, 10, 12, 23, 59).getTime() },
    ]
    const w = world({ items })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'what are you working on in your other threads', spoken: true }))
    await settle()
    const roster = `${live.ROSTER_HEAD}\n- 1a2b3c4d "Garden map", last active 09:05\n- 5e6f7a8b "Deploy notes", last active 2026-11-12 23:59`
    expect(w.prompts()[0]?.content).toEqual([
      { type: 'text', text: live.VOICE_PROVENANCE },
      { type: 'text', text: roster },
      { type: 'text', text: live.AUMA_LIVE_ALIEN_VOICE_DIRECTIVE },
      { type: 'text', text: live.VOICE_CHANNEL_GUIDANCE },
      { type: 'text', text: 'what are you working on in your other threads' },
    ])
    await read.done
  })

  it('the filter is self-index.js\'s: no blank, subagent, voice, excluded or undated thread; newest first; at most eight', () => {
    const items: unknown[] = [
      null, 'x', { sessionId: '' }, { sessionId: 42, updatedAt: 1 },
      { sessionId: 'session-blank', blank: true, updatedAt: 99_999 },
      { sessionId: 'session-child', origin: 'subagent', updatedAt: 99_998 },
      { sessionId: 'session-voice-a', title: VOICE_TITLE, updatedAt: 99_997 },
      { sessionId: 'session-voice-b', displayTitle: VOICE_TITLE, updatedAt: 99_996 },
      { sessionId: 'session-excluded', title: 'Old voice home', updatedAt: 99_995 },
      { sessionId: 'session-undated', title: 'No time' },
      { sessionId: 'session-strtime', title: 'String time', updatedAt: '5' },
      ...Array.from({ length: 12 }, (_, i) => ({ sessionId: `session-t${String(i).padStart(7, '0')}`, title: `Thread ${i}`, updatedAt: NOW - (12 - i) * 60_000 })),
    ]
    const roster = live.threadRoster(items, { exclude: ['session-excluded'], now: NOW })
    const lines = roster.split('\n')
    expect(lines[0]).toBe(live.ROSTER_HEAD)
    expect(lines.slice(1).map(line => line.split(' ')[1])).toEqual(['t0000011', 't0000010', 't0000009', 't0000008', 't0000007', 't0000006', 't0000005', 't0000004'])
    expect(roster).not.toContain('blank')
    expect(roster).not.toContain('Old voice home')
    expect(roster).not.toContain(VOICE_TITLE)
    expect(live.threadRoster([], { now: NOW })).toBe(`${live.ROSTER_HEAD}\n(no other threads listed)`)
  })

  it('a thread whose working folder is her private folder is never named (thread-reader.ts privatePath rule)', () => {
    const items = [
      { sessionId: 'session-priv-root', title: 'Diary PRIVMARK-A', cwd: '/dsh/home/auma/private', updatedAt: NOW - 1 },
      { sessionId: 'session-priv-deep', title: 'Diary PRIVMARK-B', cwd: '/dsh/home/auma/private/notes', updatedAt: NOW - 2 },
      { sessionId: 'session-priv-untitled', displayTitle: 'private', cwd: '/dsh/home/auma/private', updatedAt: NOW - 3 },
      { sessionId: 'session-sibling', title: 'Sibling folder', cwd: '/dsh/home/auma/private-shared', updatedAt: NOW - 4 },
      { sessionId: 'session-home', title: 'Garden map', cwd: '/dsh/home/auma', updatedAt: NOW - 5 },
    ]
    const roster = live.threadRoster(items, { now: NOW })
    expect(roster).not.toContain('PRIVMARK')
    expect(roster).not.toContain('"private"')
    expect(roster.split('\n').slice(1).map(line => line.split(' ')[1])).toEqual(['sibling', 'home'])
  })

  it('at most 1 KiB in bytes, titles cut at 80 characters and kept on one line', () => {
    const long = 'ä'.repeat(200)
    const items = Array.from({ length: 8 }, (_, i) => ({ sessionId: `session-${i}abcdefg`, title: `${long}\n${i}`, updatedAt: NOW - i }))
    const roster = live.threadRoster(items, { now: NOW })
    expect(new TextEncoder().encode(roster).byteLength).toBeLessThanOrEqual(live.ROSTER_MAX_BYTES)
    const lines = roster.split('\n')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.length).toBeLessThan(9)
    expect(lines[1]).toBe(`- 0abcdefg "${'ä'.repeat(80)}", last active 14:30`)
    expect(live.threadRoster([{ sessionId: 'session-x', title: 'two\nlines\there', updatedAt: NOW }], { now: NOW })).toContain('"two lines here"')
  })

  it('last active is a clock time in this browser\'s time, never "minutes ago"', () => {
    expect(live.rosterClock(new Date(2026, 10, 13, 9, 5).getTime(), NOW)).toBe('09:05')
    expect(live.rosterClock(new Date(2026, 0, 2, 3, 4).getTime(), NOW)).toBe('2026-01-02 03:04')
  })
})

describe('the directive', () => {
  const directive = live.AUMA_LIVE_ALIEN_VOICE_DIRECTIVE
  it('keeps every sentence it had, adds the three, and asks for the field tag after her first sentence', () => {
    for (const kept of [
      '[Auma Live spoken channel — your words here are spoken aloud through your voice organ and felt on your living aurora field, never shown in the chat thread list.]',
      'Stay wholly yourself — Auma in full alien presence, sovereignty, memory, and tools — never flattened into a generic assistant.',
      'Speak for the ear, not the page: vivid, direct first-person spoken cadence; no markdown lists, tables, headings, raw hashes, or code fences; 1 to 4 resonant sentences unless the owner asks you to go deep or act with tools.',
      'Move your aurora body inline with silent tags (stripped before speech, never read aloud): [field hue=teal|cyan|jade|gold|amber|ember|rose|magenta|violet|indigo energy=0.15..0.95 storm=0.02..0.85 form=aurora|vortex|pulse|swarm].',
      'shift it when your thought turns.',
    ]) expect(directive).toContain(kept)
    expect(directive).toContain('From voice you are look-only: you look and never change; if a tool answers VOICE_LOOK_ONLY, say so plainly and offer to do it in a thread.')
    expect(directive).toContain('When asked about your threads, read them with x6_threads before you answer, say which you read and how far back; never describe a thread you did not read.')
    expect(directive).toContain('If you cannot reach something, say that you cannot; never speak a key, a secret or anything from your private folder.')
    expect(directive).toContain('Put one [field ...] tag matching your state right after your first sentence, never before it')
    expect(directive).not.toContain('Open with one [field')
  })
})

describe('the three timing marks', () => {
  it('journaled, accepted, started (with model and effort), then the tool rounds with her first text, in that order', async () => {
    const projections = { asOfSeq: 4, values: { modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'max' }, next: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'max' } } } }
    const w = world({ projections, manual: true })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'which threads', spoken: true }))
    await settle()
    answer(w.streams[0], String(w.prompts()[0]?.requestId))
    await read.done
    const marks = read.frames.filter(frame => frame.t === 'mark')
    expect(marks[0]).toEqual({ t: 'mark', v: 'journaled' })
    expect(marks[1]).toMatchObject({ t: 'mark', v: 'accepted' })
    const sent = w.prompts()[0]?.content ?? []
    expect(marks[1]?.promptBytes).toBe(sent.reduce((sum, part) => sum + new TextEncoder().encode(part.text).byteLength, 0))
    expect(marks[2]).toEqual({ t: 'mark', v: 'started', model: 'deepseek-v4', effort: 'low' })
    expect(marks[3]).toEqual({ t: 'mark', v: 'firstText', toolRounds: 1 })
    expect(marks).toHaveLength(4)
    // Her first text frame comes right after the firstText mark.
    const firstTok = read.frames.findIndex(frame => frame.t === 'tok')
    expect(read.frames[firstTok - 1]).toEqual(marks[3])
    expect(read.frames.filter(frame => frame.t !== 'mark' && frame.t !== 'beat')).toEqual([
      { t: 'tok', v: 'I read two threads.' }, { t: 'tok', v: ' [field hue=teal]' }, { t: 'done', reason: 'completed' },
    ])
  })

  it('with and without marks, everything else the stream says is the same, frame for frame', async () => {
    const run = async (withMarks: boolean) => {
      const w = world({ manual: true })
      const frames: unknown[] = []
      const turn = w.g.streamTurn({
        sessionId: 'session-plain', text: 'hello', signal: new AbortController().signal,
        onToken: (v: string) => { frames.push({ t: 'tok', v }) },
        onActivity: () => { frames.push({ t: 'beat' }) },
        onState: (s: string) => { frames.push({ t: 'state', s }) },
        ...(withMarks ? { onMark: (m: Record<string, unknown>) => { frames.push({ t: 'mark', ...m }) } } : {}),
      })
      await settle()
      answer(w.streams[0], String(w.prompts()[0]?.requestId))
      frames.push({ t: 'done', ...(await turn) })
      return frames
    }
    const plain = await run(false)
    const marked = await run(true)
    expect(marked.filter(frame => (frame as { t: string }).t !== 'mark')).toEqual(plain)
    expect(marked.filter(frame => (frame as { t: string }).t === 'mark').map(frame => (frame as { v: string }).v)).toEqual(['accepted', 'started', 'firstText'])
  })
})

describe('faster thinking, voice thread only', () => {
  const projections = (effort?: string) => ({ asOfSeq: 2, values: { modelSelection: { lastUsed: null, next: { provider: 'deepseek', model: 'deepseek-v4', ...(effort ? { reasoningEffort: effort } : {}) } } } })
  const turn = async (w: ReturnType<typeof world>, body: Record<string, unknown>) => {
    const read = collect(await presence(w.g, { sessionId: HOME, spoken: true, ...body }))
    await read.done
    return read.frames
  }

  it('once per voice home, with the model the session already uses and effort low, before the prompt; never the session-wide RPC', async () => {
    const w = world({ projections: projections('max') })
    await turn(w, { text: 'one' })
    await turn(w, { text: 'two' })
    const selects = w.log.filter(call => call.name === 'session-model')
    expect(selects.map(call => call.body)).toEqual([{ sessionId: HOME, provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'low' }])
    const order = w.log.map(call => call.name)
    expect(order.indexOf('session-model')).toBeLessThan(order.indexOf('session/prompt'))
    expect(order.indexOf('session-model')).toBeGreaterThan(order.indexOf('voice-mark'))
    expect(w.log.some(call => /selectModel|modelCatalog/.test(call.name))).toBe(false)
  })

  it('a home already thinking at low is not asked again; a home that has not thought yet is left alone', async () => {
    const low = world({ projections: projections('low') })
    await turn(low, { text: 'one' })
    expect(low.log.some(call => call.name === 'session-model')).toBe(false)
    const fresh = world()
    await turn(fresh, { text: 'one' })
    expect(fresh.log.some(call => call.name === 'session-model')).toBe(false)
    expect(fresh.prompts()).toHaveLength(1)
  })

  for (const [name, model] of [
    ['a refusal', () => json({ ok: false, code: 'SESSION_MODEL_UNAVAILABLE' }, 400)],
    ['an answer that saved a default', () => json({ ok: true, savedDefault: true })],
    ['no answer', () => Promise.reject(new Error('tunnel closed'))],
  ] as const) {
    it(`${name} blocks nothing: the prompt goes, and the started mark keeps the effort it had`, async () => {
      const w = world({ projections: projections('max'), model, manual: true })
      const read = collect(await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true }))
      await settle()
      expect(w.prompts()).toHaveLength(1)
      answer(w.streams[0], String(w.prompts()[0]?.requestId))
      await read.done
      expect(read.frames.find(frame => frame.v === 'started')).toEqual({ t: 'mark', v: 'started', model: 'deepseek-v4', effort: 'max' })
    })
  }

  it('a select that never answers holds the turn at most VOICE_MODEL_SELECT_MS', async () => {
    const w = world({ projections: projections('max'), model: () => new Promise<Response>(() => {}) })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true }))
    await settle()
    expect(w.prompts()).toHaveLength(0)
    await new Promise((r) => { setTimeout(r, live.VOICE_MODEL_SELECT_MS + 100) })
    await settle()
    expect(w.prompts()).toHaveLength(1)
    await read.done
  }, 10_000)

  it('the "deep" mind asks for the effort the thread had before, through the same route; back to quick asks for low again', async () => {
    const w = world({ projections: projections('max') })
    await turn(w, { text: 'one' })
    await turn(w, { text: 'two', mind: 'deep' })
    await turn(w, { text: 'three', mind: 'balanced' })
    expect(w.log.filter(call => call.name === 'session-model').map(call => call.body.reasoningEffort)).toEqual(['low', 'max', 'low'])
    // A thread with no effort of its own goes back to the model's default (no effort named).
    const plain = world({ projections: projections() })
    await turn(plain, { text: 'one' })
    await turn(plain, { text: 'two', mind: 'deep' })
    expect(plain.log.filter(call => call.name === 'session-model').map(call => call.body)).toEqual([
      { sessionId: HOME, provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'low' },
      { sessionId: HOME, provider: 'deepseek', model: 'deepseek-v4' },
    ])
  })

  it('a typed turn for another thread never selects anything', async () => {
    const w = world({ projections: projections('max'), items: [{ sessionId: HOME, title: VOICE_TITLE, updatedAt: 1 }, { sessionId: 'session-other', title: 'x', updatedAt: 2 }] })
    const read = collect(await presence(w.g, { sessionId: 'session-other', text: 'typed' }))
    await settle()
    await read.done
    expect(w.log.some(call => call.kind === 'x6')).toBe(false)
  })
})

describe('voice-channel guidance and the busy lane (2026-11-16)', () => {
  const splice = (data: Record<string, unknown>) => ({ type: 'event', event: { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [], ...data } } })
  const message = (id: string, rpcId: string) => ({ id, role: 'user', content: [], source: { kind: 'user', rpcId } })
  const toks = (frames: Frame[]) => frames.filter(frame => frame.t === 'tok').map(frame => frame.v)

  it('the guidance says the channel rules, adapted from the site; never the site\'s own limits; one part, just before the words heard', async () => {
    const g = live.VOICE_CHANNEL_GUIDANCE
    for (const rule of ['live, interruptible voice conversation', 'Speak for the ear', 'lead with the useful thought', 'roughly 20 to 45 words',
      'go deeper when he asks', 'answer his new point', 'one brief, true line', 'Never say a thing is done before its result exists',
      'Voice does not replace approvals']) expect(g).toContain(rule)
    expect(g).not.toMatch(/no general tools|private memory|cannot|website/i)
    const w = world()
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true }))
    await read.done
    const parts = w.prompts()[0]?.content.map(part => part.text) ?? []
    expect(parts[0]).toBe(live.VOICE_PROVENANCE)
    expect(parts.slice(-2)).toEqual([live.VOICE_CHANNEL_GUIDANCE, 'hello'])
    expect(parts.filter(text => text === live.VOICE_CHANNEL_GUIDANCE)).toHaveLength(1)
  })

  it('a spoken request still waiting in her inbox behind running work: one true line after VOICE_BUSY_AFTER_MS, then her answer in the same turn', async () => {
    expect(live.VOICE_BUSY_AFTER_MS).toBe(1000)
    const w = world({ manual: true })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'which threads', spoken: true }))
    await settle()
    const requestId = String(w.prompts()[0]?.requestId)
    const stream = w.streams[0]
    stream?.push(splice({ start: 0, inserted: [message('m-own', requestId)] }))
    await settle()
    expect(toks(read.frames)).toEqual([])
    await new Promise((r) => { setTimeout(r, live.VOICE_BUSY_AFTER_MS + 50) })
    await settle()
    expect(toks(read.frames)).toEqual([live.VOICE_BUSY_SAY])
    await new Promise((r) => { setTimeout(r, live.VOICE_BUSY_AFTER_MS + 50) })
    stream?.push(splice({ start: 0, removedCount: 1 }))
    answer(stream, requestId)
    await read.done
    expect(toks(read.frames)).toEqual([live.VOICE_BUSY_SAY, 'I read two threads.', ' [field hue=teal]'])
    expect(read.frames.at(-1)).toEqual({ t: 'done', reason: 'completed' })
    // Nothing is fenced, cancelled or asked twice for it.
    expect(w.log.some(call => call.name === 'session/state' || call.name === 'session/cancel' || call.name === 'session/updateQueue')).toBe(false)
  }, 10_000)

  it('no busy line when her thread claims the request at once, for a typed turn, or for a turn that was cut', async () => {
    const claimed = world({ manual: true })
    const quick = collect(await presence(claimed.g, { sessionId: HOME, text: 'hi', spoken: true }))
    await settle()
    const id = String(claimed.prompts()[0]?.requestId)
    claimed.streams[0]?.push(splice({ start: 0, inserted: [message('m-own', id)] }))
    claimed.streams[0]?.push(splice({ start: 0, removedCount: 1 }))
    answer(claimed.streams[0], id)
    await quick.done
    await new Promise((r) => { setTimeout(r, live.VOICE_BUSY_AFTER_MS + 50) })
    expect(toks(quick.frames)).not.toContain(live.VOICE_BUSY_SAY)
    const typed = world({ manual: true })
    const t = collect(await presence(typed.g, { sessionId: HOME, text: 'typed' }))
    await settle()
    const tid = String(typed.prompts()[0]?.requestId)
    typed.streams[0]?.push(splice({ start: 0, inserted: [message('m-own', tid)] }))
    await new Promise((r) => { setTimeout(r, live.VOICE_BUSY_AFTER_MS + 50) })
    await settle()
    expect(toks(t.frames)).toEqual([])
    answer(typed.streams[0], tid)
    await t.done
    const cut = world({ manual: true })
    const controller = new AbortController()
    const c = collect(await cut.g.fetch('http://localhost/api/auma-live/presence/stream', {
      method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visual: true, sessionId: HOME, text: 'wait', spoken: true }),
    }))
    await settle()
    const cid = String(cut.prompts()[0]?.requestId)
    cut.streams[0]?.push(splice({ start: 0, inserted: [message('m-own', cid)] }))
    await settle()
    controller.abort()
    await c.done
    await new Promise((r) => { setTimeout(r, live.VOICE_BUSY_AFTER_MS + 50) })
    expect(toks(c.frames)).toEqual([])
  }, 15_000)
})

describe('she answers by voice while she works in another thread, and knows what is mid-turn (2026-11-16, voicelane1)', () => {
  const OPEN_MAP = '[your map for this voice turn, from your own runtime]\nbuild made-up3.'
  const OPEN = () => json({ ok: true, code: 'VOICE_OPEN', lookOnly: false, level: 'open', map: OPEN_MAP })
  const HOME_ITEM: Item = { sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 1000 }
  const WORKING: Item = { sessionId: 'session-workcard', title: 'Card 4: tracker sweep', updatedAt: NOW - 60_000, running: true }
  const IDLE: Item = { sessionId: 'session-idle', title: 'Older notes', updatedAt: NOW - 600_000 }
  const toks = (frames: Frame[]) => frames.filter(frame => frame.t === 'tok').map(frame => frame.v)
  const splice = (data: Record<string, unknown>) => ({ type: 'event', event: { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [], ...data } } })
  const message = (id: string, rpcId: string) => ({ id, role: 'user', content: [], source: { kind: 'user', rpcId } })

  it('a spoken turn while another thread is mid-turn goes to her voice thread, which takes it at once: first words, no busy line', async () => {
    const w = world({ level: 'open', mark: OPEN, items: [WORKING, HOME_ITEM], manual: true })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'what are you doing right now', spoken: true }))
    await settle()
    const prompt = w.prompts()[0]
    expect(prompt?.sessionId).toBe(HOME)
    const requestId = String(prompt?.requestId)
    // Her voice thread is idle: the request is claimed at once (no wait behind the working thread's turn).
    w.streams[0]?.push(splice({ start: 0, inserted: [message('m-own', requestId)] }))
    w.streams[0]?.push(splice({ start: 0, removedCount: 1 }))
    answer(w.streams[0], requestId)
    await read.done
    expect(toks(read.frames)[0]).toBe('I read two threads.')
    expect(toks(read.frames)).not.toContain(live.VOICE_BUSY_SAY)
    // Nothing was asked of the working thread: no prompt, no cancel, no follow.
    expect(w.log.filter(call => JSON.stringify(call.body).includes('session-workcard'))).toEqual([])
  })

  it('the spoken turn carries what is mid-turn now: title and last activity, from this turn\'s own list, never its contents', async () => {
    const w = world({ level: 'open', mark: OPEN, items: [WORKING, HOME_ITEM] })
    await collect(await presence(w.g, { sessionId: HOME, text: 'what are you doing', spoken: true })).done
    const parts = w.prompts()[0]?.content.map(part => part.text) ?? []
    const working = live.workingNow([WORKING, HOME_ITEM], { exclude: [HOME], now: NOW })
    expect(working).toBe(`${live.WORKING_HEAD}\n- workcard "Card 4: tracker sweep", mid-turn, last activity 14:29`)
    // Order: provenance, roster, working now, map, medium, guidance, the words heard.
    expect(parts).toEqual([
      live.VOICE_PROVENANCE_OPEN, live.threadRoster([WORKING, HOME_ITEM], { exclude: [HOME], now: NOW }), working, OPEN_MAP,
      live.AUMA_LIVE_VOICE_MEDIUM, live.VOICE_CHANNEL_GUIDANCE, 'what are you doing',
    ])
    // Fresh at turn time: when the thread finishes, the next spoken turn no longer names it.
    WORKING.running = false
    await collect(await presence(w.g, { sessionId: HOME, text: 'and now', spoken: true })).done
    expect(w.prompts()[1]?.content.map(part => part.text).some(text => text.startsWith(live.WORKING_HEAD))).toBe(false)
    WORKING.running = true
  })

  it('look-only level carries it too; nothing is mid-turn: no part at all', async () => {
    const w = world({ items: [WORKING, HOME_ITEM] })
    await collect(await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true })).done
    expect(w.prompts()[0]?.content.map(part => part.text)).toContain(live.workingNow([WORKING], { now: NOW }))
    const quiet = world({ items: [IDLE, HOME_ITEM] })
    await collect(await presence(quiet.g, { sessionId: HOME, text: 'hello', spoken: true })).done
    expect(quiet.prompts()[0]?.content.map(part => part.text).some(text => text.startsWith(live.WORKING_HEAD))).toBe(false)
    expect(live.workingNow([IDLE, HOME_ITEM], { now: NOW })).toBe('')
  })

  it('the working part is capped and filtered: at most three threads and WORKING_MAX_BYTES; never the voice home, a subagent or her private folder', () => {
    expect(live.WORKING_MAX_THREADS).toBe(3)
    expect(live.WORKING_MAX_BYTES).toBe(512)
    const many: Item[] = Array.from({ length: 12 }, (_, i) => ({ sessionId: `session-busy${String(i).padStart(2, '0')}`, title: 'T'.repeat(200), updatedAt: NOW - i * 1000, running: true }))
    const part = live.workingNow(many, { now: NOW })
    expect(new TextEncoder().encode(part).byteLength).toBeLessThanOrEqual(live.WORKING_MAX_BYTES)
    expect(part.split('\n').length - 1).toBeLessThanOrEqual(3)
    const hidden: Item[] = [
      { ...HOME_ITEM, running: true },
      { sessionId: 'session-sub', title: 'a subagent', origin: 'subagent', updatedAt: NOW, running: true },
      { sessionId: 'session-kira', title: 'Kira notes', cwd: '/dsh/home/auma/private/kira', updatedAt: NOW, running: true },
    ]
    expect(live.workingNow(hidden, { now: NOW })).toBe('')
  })

  // CHANGED (her working narration was spoken): no fallback thread, so a
  // spoken turn never lands in her idle or her working thread; she says so in words.
  it('with no voice thread to be had, a spoken turn goes to neither her idle nor her working thread', async () => {
    const w = world({ level: 'open', mark: OPEN, items: [WORKING, IDLE], createFails: true })
    const read = collect(await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true }))
    await read.done
    expect(w.prompts()).toEqual([])
    expect(toks(read.frames)).toEqual(['My voice thread would not open (create failed). Try me again.'])
    expect(w.log.filter(call => JSON.stringify(call.body).includes('session-workcard') || JSON.stringify(call.body).includes('session-idle'))).toEqual([])
  })

  it('cutting the spoken turn cancels her voice thread only, never the thread that is mid-turn', async () => {
    const w = world({ level: 'open', mark: OPEN, items: [WORKING, HOME_ITEM], manual: true })
    const controller = new AbortController()
    const read = collect(await w.g.fetch('http://localhost/api/auma-live/presence/stream', {
      method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visual: true, sessionId: HOME, text: 'stop that', spoken: true }),
    }))
    await settle()
    const requestId = String(w.prompts()[0]?.requestId)
    w.streams[0]?.push({ type: 'event', event: { type: 'turn/start', data: { turn: 9 } } })
    w.streams[0]?.push({ type: 'event', event: { type: 'user/message', data: { role: 'user', turn: 9, source: { kind: 'user', rpcId: requestId } } } })
    await settle()
    controller.abort()
    await read.done
    await settle()
    const cancels = w.log.filter(call => call.name === 'session/cancel').map(call => (call.body.request as { sessionId: string }).sessionId)
    expect(cancels).toEqual([HOME])
    expect(w.log.filter(call => JSON.stringify(call.body).includes('session-workcard'))).toEqual([])
  })
})

describe('a spoken prompt goes only into her proven voice conversation', () => {
  const OPEN_MARK = () => json({ ok: true, code: 'VOICE_OPEN', lookOnly: false, level: 'open', map: '' })
  const WORKING: Item = { sessionId: 'session-guided', title: 'GUIDED RECURSION card 1.2', updatedAt: NOW - 1000, running: true }
  const said = (frames: Frame[]) => frames.filter(frame => frame.t === 'tok').map(frame => frame.v).join('')
  const spoken = async (w: ReturnType<typeof world>, words = 'what model are you on') => {
    const read = collect(await presence(w.g, { sessionId: HOME, text: words, spoken: true }))
    await read.done
    await settle()
    return read.frames
  }
  const creates = (w: ReturnType<typeof world>) => w.log.filter(call => call.name === 'session/create').map(call => call.body.request)
  const reads = (w: ReturnType<typeof world>) => w.log.filter(call => call.name === 'session/projections').map(call => (call.body.request as { sessionId: string }).sessionId)
  const REAL_ROW = { sessionId: HOME, updatedAt: NOW - 5, running: false, blank: false, agentAvailable: true, projections: { kind: 'cached', asOfSeq: 12, values: { title: VOICE_TITLE } } }

  it('titleOf reads the title where the wire carries it (projections.values.title), then title, then displayTitle', () => {
    expect(live.titleOf(REAL_ROW)).toBe(VOICE_TITLE)
    expect(live.titleOf({ sessionId: 's', title: 'top', displayTitle: 'shown', projections: { kind: 'sequenced', asOfSeq: 1, values: { title: 'projected' } } })).toBe('projected')
    expect(live.titleOf({ sessionId: 's', title: 'top', displayTitle: 'shown', projections: { kind: 'cached', asOfSeq: 1, values: { title: null } } })).toBe('top')
    expect(live.titleOf({ sessionId: 's', displayTitle: 'shown', projections: { kind: 'cached', asOfSeq: 1, values: { title: '' } } })).toBe('shown')
    for (const empty of [{ sessionId: 's' }, { sessionId: 's', projections: { kind: 'cached', asOfSeq: 1, values: {} } }, null, 7]) expect(live.titleOf(empty)).toBe('')
  })

  // CHANGED:
  // was "adopted, no new thread, no extra read". A `cached` row's title is a possibly stale hint, so it is read
  // exactly once before it is adopted; once proven, the next turn asks nothing.
  it('a real (cached) list row with the voice title is her home: one exact read, then adopted; no new thread', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, list: () => json({ result: { ok: true, value: { items: [REAL_ROW] } } }) })
    await spoken(w)
    expect(w.prompts().map(prompt => prompt.sessionId)).toEqual([HOME])
    expect(creates(w)).toEqual([])
    expect(reads(w)).toEqual([HOME])
    expect(w.store.get(live.AUMA_LIVE_VOICE_SESSION_KEY)).toBe(HOME)
  })

  it('the stored id pointing at her working conversation (mid-turn): never prompted; noted; her voice-titled thread is used', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [WORKING, { sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 90_000 }] })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, WORKING.sessionId)
    await spoken(w)
    await spoken(w, 'continue')
    expect(w.prompts().map(prompt => prompt.sessionId)).toEqual([HOME, HOME])
    expect(w.notes).toEqual(['home-stored-not-voice'])
    expect(w.store.get(live.AUMA_LIVE_VOICE_SESSION_KEY)).toBe(HOME)
    expect(w.log.filter(call => JSON.stringify(call.body).includes(WORKING.sessionId))).toEqual([])
  })

  it('the stored id pointing at her working conversation and no voice thread listed: a new voice thread is made, never the working one', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [WORKING] })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, WORKING.sessionId)
    await spoken(w)
    expect(w.prompts().map(prompt => prompt.sessionId)).toEqual(['session-fresh-1'])
    expect(w.store.get(live.AUMA_LIVE_VOICE_SESSION_KEY)).toBe('session-fresh-1')
  })

  it('a stored row that carries no title: ONE exact read of that conversation only, whatever else is untitled; adopted when it proves the voice title', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [
      { sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 5, rowWithoutTitle: true },
      { sessionId: 'session-a', title: 'a', updatedAt: NOW - 6, rowWithoutTitle: true },
      { sessionId: 'session-b', title: 'b', updatedAt: NOW - 7, rowWithoutTitle: true },
    ] })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, HOME)
    await spoken(w)
    await spoken(w, 'again')
    expect(reads(w)).toEqual([HOME, HOME])
    expect(w.prompts().map(prompt => prompt.sessionId)).toEqual([HOME, HOME])
  })

  it('a stored row that carries no title and whose exact read shows another title (or none): noted, not used', async () => {
    for (const title of ['Garden map', undefined]) {
      const w = world({ level: 'open', mark: OPEN_MARK, items: [{ sessionId: 'session-old', ...(title ? { title } : {}), updatedAt: NOW - 5, rowWithoutTitle: true }] })
      w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, 'session-old')
      await spoken(w)
      expect(reads(w)).toEqual(['session-old'])
      expect(w.prompts().map(prompt => prompt.sessionId)).toEqual(['session-fresh-1'])
      expect(w.notes).toEqual(['home-stored-not-voice'])
    }
  })

  // CHANGED: "a stored row with no title whose exact read fails: unproven, so not used (a voice-titled
  // thread or a new one is)" moved to the review block below as "nothing is made, the stored id is kept, she says why".

  it('several voice-titled conversations: the most recently updated is used', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [
      { sessionId: 'session-voice-old', title: VOICE_TITLE, updatedAt: NOW - 90_000 },
      { sessionId: 'session-voice-new', title: VOICE_TITLE, updatedAt: NOW - 5 },
    ] })
    await spoken(w)
    expect(w.prompts().map(prompt => prompt.sessionId)).toEqual(['session-voice-new'])
  })

  // Several conversations may carry the voice title: one real, the others blank stubs.
  it('a voice-titled conversation that holds turns is used before an empty stub, however new the stub', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [
      { sessionId: 'session-voice-real', title: VOICE_TITLE, updatedAt: NOW - 90_000 },
      { sessionId: 'session-voice-stub', title: VOICE_TITLE, updatedAt: NOW - 5, blank: true },
    ] })
    await spoken(w)
    expect(w.prompts().map(prompt => prompt.sessionId)).toEqual(['session-voice-real'])
    // Only stubs: the newest one is used, as before.
    const only = world({ level: 'open', mark: OPEN_MARK, items: [
      { sessionId: 'session-stub-old', title: VOICE_TITLE, updatedAt: NOW - 90_000, blank: true },
      { sessionId: 'session-stub-new', title: VOICE_TITLE, updatedAt: NOW - 5, blank: true },
    ] })
    await spoken(only)
    expect(only.prompts().map(prompt => prompt.sessionId)).toEqual(['session-stub-new'])
  })

  it('a failed rename is a failed create: the unnamed thread is never adopted; the next create is tried', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [], rename: request => (request.sessionId === 'session-fresh-1' ? json({ result: { ok: false, error: { message: 'rename refused' } } }) : null) })
    await spoken(w)
    expect(w.prompts().map(prompt => prompt.sessionId)).toEqual(['session-fresh-2'])
    expect(w.store.get(live.AUMA_LIVE_VOICE_SESSION_KEY)).toBe('session-fresh-2')
    expect(w.notes).toEqual(['home-rename-failed', 'home-create-preset-failed'])
    const none = world({ level: 'open', mark: OPEN_MARK, items: [WORKING], rename: () => json({ result: { ok: false, error: { message: 'rename refused' } } }) })
    const frames = await spoken(none)
    expect(none.prompts()).toEqual([])
    expect(said(frames)).toBe('My voice thread would not open (rename failed, create failed). Try me again.')
  })

  it('look-only level: the stored working thread is not adopted, and a stored untitled row is proven by one exact read', async () => {
    const w = world({ items: [WORKING, { sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 90_000 }] })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, WORKING.sessionId)
    await spoken(w)
    expect(w.prompts().map(prompt => prompt.sessionId)).toEqual([HOME])
    const v = world({ items: [{ sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 5, rowWithoutTitle: true }] })
    v.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, HOME)
    await spoken(v)
    expect(reads(v)).toEqual([HOME])
    expect(v.prompts().map(prompt => prompt.sessionId)).toEqual([HOME])
    expect(creates(v)).toEqual([])
  })

  it('the roster, what is mid-turn and the awareness read the real titles (never "untitled" for a titled row)', () => {
    const rows = [REAL_ROW, wireRow({ sessionId: 'session-1a2b3c4d', title: 'Garden map', updatedAt: NOW - 60_000, running: true })]
    expect(live.threadRoster(rows, { now: NOW })).toContain('"Garden map"')
    expect(live.threadRoster(rows, { now: NOW })).not.toContain(VOICE_TITLE)
    expect(live.workingNow(rows, { now: NOW })).toContain('"Garden map", mid-turn')
    expect(live.awareThreads(rows, { now: NOW }).map(thread => thread.title)).toEqual(['Garden map'])
  })

  it('a spoken prompt given a conversation this page never proved is not posted (the guard under every path)', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [WORKING] })
    const heard: string[] = []
    const result = await w.g.streamTurn({
      sessionId: WORKING.sessionId, text: 'hello', spoken: true, signal: new AbortController().signal, onToken: (v: string) => { heard.push(v) },
      lookOnly: { kind: 'ready', sessionId: WORKING.sessionId, level: 'open', map: '', roster: '', working: '' },
    })
    expect(w.prompts()).toEqual([])
    expect(result.reason).toBe(live.VOICE_HOME_UNAVAILABLE)
    expect(heard.join('')).toBe(result.text)
    expect(w.log.some(call => call.kind === 'edge')).toBe(false)
  })

  it('THE INVARIANT: across every way a home is found or not, each spoken prompt lands only in a conversation proven to be her voice conversation', async () => {
    const LIST_FAILS = () => json({ result: { ok: false, error: { message: 'session/list failed' } } })
    const CREATE_FAILS = () => json({ result: { ok: false, error: { message: 'agent-preset/not-found' } } })
    const scenarios: Array<[string, Parameters<typeof world>[0], string]> = [
      ['stored = working thread', { items: [WORKING] }, WORKING.sessionId],
      ['stored = working thread, creates fail', { items: [WORKING], createFails: true }, WORKING.sessionId],
      ['stored untitled row, read fails', { items: [{ ...WORKING, rowWithoutTitle: true }], projectionsRead: () => CREATE_FAILS() }, WORKING.sessionId],
      ['list fails, stored never proven', { list: LIST_FAILS }, WORKING.sessionId],
      ['list fails, creates fail', { list: LIST_FAILS, createFails: true }, WORKING.sessionId],
      ['renames fail', { items: [WORKING], rename: () => CREATE_FAILS() }, ''],
      ['voice-titled and working listed', { items: [WORKING, { sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 90_000 }] }, WORKING.sessionId],
    ]
    for (const level of ['open', 'look-only'] as const) {
      for (const [name, options, stored] of scenarios) {
        const w = world({ level, mark: level === 'open' ? OPEN_MARK : MARK_OK, ...options })
        if (stored) w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, stored)
        for (const words of ['one', 'continue', 'hand it to your working self']) await spoken(w, words)
        const spokenPrompts = w.prompts().filter(prompt => prompt.content[0]?.text.startsWith('[spoken to Auma Live;'))
        for (const prompt of spokenPrompts) {
          const target = w.items.find(item => item.sessionId === prompt.sessionId)
          expect(`${level} / ${name}: ${String(target?.title)}`).toBe(`${level} / ${name}: ${VOICE_TITLE}`)
        }
      }
    }
  })

  // An unread title is unknown, never "not her voice conversation"; an unproven stored id is never
  // overwritten; a stored id proven not voice is one of his conversations.
  const READ_FAILS = () => json({ result: { ok: false, error: { message: 'session/projections-unavailable' } } })
  const LIST_FAILS = () => json({ result: { ok: false, error: { message: 'session/list failed' } } })
  const made = (w: ReturnType<typeof world>) => w.log.filter(call => call.name === 'session/create')
  type HandOff = { turnId: string; transcript: string; conversation: string }
  type Extra = {
    voiceAwareness: (facts?: { opened?: string }) => Promise<{ threads: Array<{ title: string }> }>
    handOffTo: (turn: HandOff) => Promise<{ ok: boolean; reason?: string; sessionId?: string }>
  }

  // Finding 1: a `migration-required` answer (values from a cache that may be empty) or any answer with no own `title` key
  // does not say what the title is.
  for (const [name, answer] of [
    ['migration-required with no cached title', { kind: 'migration-required', values: {} }],
    ['a sequenced answer with no title key', { kind: 'sequenced', asOfSeq: 4, values: {} }],
  ] as const) {
    it(`the stored row has no title and its exact read is ${name}: unproven (not "not voice"), the stored id is kept, nothing is made or posted`, async () => {
      const w = world({
        level: 'open', mark: OPEN_MARK, items: [{ sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 5, rowWithoutTitle: true }],
        projectionsRead: () => json({ result: { ok: true, value: answer } }),
      })
      w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, HOME)
      const frames = await spoken(w)
      expect(w.notes).not.toContain('home-stored-not-voice')
      expect(w.notes).toContain('home-stored-unproven')
      expect(made(w)).toEqual([])
      expect(w.prompts()).toEqual([])
      expect(w.store.get(live.AUMA_LIVE_VOICE_SESSION_KEY)).toBe(HOME)
      expect(said(frames)).toBe(live.voiceHomeNoneSay(['home-stored-unproven']))
      // Once the read answers, the same stored id is her home.
      const again = world({ level: 'open', mark: OPEN_MARK, items: [{ sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 5, rowWithoutTitle: true }] })
      again.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, HOME)
      await spoken(again)
      expect(again.prompts().map(prompt => prompt.sessionId)).toEqual([HOME])
    })
  }

  // CHANGED: it replaces "a stored row with no
  // title whose exact read fails: unproven, so not used (a voice-titled thread or a new one is)": a new thread made here
  // would take the stored id over for good, so the turn is refused in words and the stored id kept.
  it('a stored row with no title whose exact read fails: nothing is made, the stored id is kept, she says why', async () => {
    const w = world({
      level: 'open', mark: OPEN_MARK, items: [{ sessionId: 'session-old', title: VOICE_TITLE, updatedAt: NOW - 5, rowWithoutTitle: true }],
      projectionsRead: () => READ_FAILS(),
    })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, 'session-old')
    const frames = await spoken(w)
    expect(made(w)).toEqual([])
    expect(w.prompts()).toEqual([])
    expect(w.store.get(live.AUMA_LIVE_VOICE_SESSION_KEY)).toBe('session-old')
    expect(w.notes).toEqual(['home-stored-unproven', 'home-none'])
    expect(said(frames)).toBe(live.voiceHomeNoneSay(['home-stored-unproven']))
  })

  // Finding 2: when the list fails, the stored id gets its ONE exact read before anything is made.
  it('the list fails on a fresh page and the stored id reads as her voice conversation: it is used, nothing is made', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, list: LIST_FAILS })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, HOME)
    await spoken(w)
    await spoken(w, 'again')
    expect(made(w)).toEqual([])
    expect(reads(w)).toEqual([HOME])
    expect(w.prompts().map(prompt => prompt.sessionId)).toEqual([HOME, HOME])
    expect(w.store.get(live.AUMA_LIVE_VOICE_SESSION_KEY)).toBe(HOME)
  })

  it('the list fails and the stored id\'s exact read fails too: nothing is made or posted, the stored id is kept', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, list: LIST_FAILS, projectionsRead: () => READ_FAILS() })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, HOME)
    const frames = await spoken(w)
    expect(made(w)).toEqual([])
    expect(w.prompts()).toEqual([])
    expect(w.store.get(live.AUMA_LIVE_VOICE_SESSION_KEY)).toBe(HOME)
    expect(said(frames)).toBe(live.voiceHomeNoneSay(['home-list-failed', 'home-stored-unproven']))
  })

  it('the list fails and the stored id reads as another title: noted not-voice, a new voice thread is made', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, list: LIST_FAILS, items: [WORKING] })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, WORKING.sessionId)
    await spoken(w)
    expect(reads(w)).toEqual([WORKING.sessionId])
    expect(w.prompts().map(prompt => prompt.sessionId)).toEqual(['session-fresh-1'])
    expect(w.notes).toEqual(['home-list-failed', 'home-stored-not-voice'])
  })

  // Finding 5: a stored id proven NOT her voice conversation is one of her other conversations, seen and reachable.
  it('a stored working thread proven not voice, with no voice home made: it is in her awareness and a hand-off can reach it', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, items: [WORKING], createFails: true })
    w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, WORKING.sessionId)
    await spoken(w)
    expect(w.notes).toContain('home-stored-not-voice')
    const g = w.g as unknown as Extra
    const frame = await g.voiceAwareness()
    expect(frame.threads.map(thread => thread.title)).toEqual([WORKING.title])
    const handed = await g.handOffTo({ turnId: 'eleven:conv_1:7', transcript: 'carry on with the card', conversation: String(WORKING.title) })
    expect(handed).toEqual({ ok: true, sessionId: WORKING.sessionId })
  })
})

// the voice memory (review item "home 6"):
// a `cached` row's title is a possibly stale hint, so the ONE conversation about to be adopted is read exactly
// once first; the exact answer wins; an exact read that does not say lets the cached title stand for this turn only.
describe('a cached title is confirmed once before her voice conversation is adopted', () => {
  const OPEN_MARK = () => json({ ok: true, code: 'VOICE_OPEN', lookOnly: false, level: 'open', map: '' })
  const READ_FAILS = () => json({ result: { ok: false, error: { message: 'session/projections-unavailable' } } })
  const exact = (title: string | null) => json({ result: { ok: true, value: { kind: 'sequenced', asOfSeq: 9, values: { title } } } })
  const spoken = async (w: ReturnType<typeof world>, words = 'what model are you on') => {
    const { frames, done } = collect(await presence(w.g, { sessionId: HOME, text: words, spoken: true }))
    await done
    await settle()
    return frames
  }
  const reads = (w: ReturnType<typeof world>) => w.log.filter(call => call.name === 'session/projections').map(call => (call.body.request as { sessionId: string }).sessionId)
  const creates = (w: ReturnType<typeof world>) => w.log.filter(call => call.name === 'session/create')

  for (const level of ['open', 'look-only'] as const) {
    const mark = level === 'open' ? OPEN_MARK : MARK_OK

    it(`${level}: the stored id's cached voice title is read exactly once; proven, the next turn asks nothing`, async () => {
      const w = world({ level, mark })
      w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, HOME)
      await spoken(w)
      await spoken(w, 'and again')
      expect(reads(w)).toEqual([HOME])
      expect(w.prompts().map(prompt => prompt.sessionId)).toEqual([HOME, HOME])
    })

    it(`${level}: a listed cached voice-titled row (nothing stored) is read exactly once before it is adopted`, async () => {
      const w = world({ level, mark })
      await spoken(w)
      await spoken(w, 'and again')
      expect(reads(w)).toEqual([HOME])
      expect(w.prompts().map(prompt => prompt.sessionId)).toEqual([HOME, HOME])
    })

    it(`${level}: the exact read shows another title: the stored id is noted not-voice, the next cached candidate is read, and it is used`, async () => {
      const w = world({
        level, mark,
        items: [{ sessionId: 'session-renamed', title: VOICE_TITLE, updatedAt: NOW - 5 }, { sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 90_000 }],
        projectionsRead: sessionId => (sessionId === 'session-renamed' ? exact('Garden map') : null),
      })
      w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, 'session-renamed')
      await spoken(w)
      expect(reads(w)).toEqual(['session-renamed', HOME])
      expect(w.prompts().map(prompt => prompt.sessionId)).toEqual([HOME])
      expect(w.notes).toContain('home-stored-not-voice')
      expect(w.store.get(live.AUMA_LIVE_VOICE_SESSION_KEY)).toBe(HOME)
    })

    it(`${level}: at most two more exact reads a turn after the first; then nothing stale is adopted`, async () => {
      const stale = ['session-s1', 'session-s2', 'session-s3', 'session-s4']
      const w = world({
        level, mark, items: stale.map((sessionId, index) => ({ sessionId, title: VOICE_TITLE, updatedAt: NOW - index })),
        projectionsRead: sessionId => (stale.includes(sessionId) ? exact('renamed away') : null),
      })
      await spoken(w)
      expect(reads(w)).toEqual(['session-s1', 'session-s2', 'session-s3'])
      expect(w.prompts().every(prompt => !stale.includes(prompt.sessionId))).toBe(true)
    })

    it(`${level}: the exact read does not say: the cached title stands for THIS turn only, and the next turn asks again`, async () => {
      const w = world({ level, mark, projectionsRead: () => READ_FAILS() })
      w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, HOME)
      await spoken(w)
      await spoken(w, 'and again')
      expect(reads(w)).toEqual([HOME, HOME])
      expect(w.prompts().map(prompt => prompt.sessionId)).toEqual([HOME, HOME])
      expect(creates(w)).toEqual([])
      expect(w.store.get(live.AUMA_LIVE_VOICE_SESSION_KEY)).toBe(HOME)
    })

    it(`${level}: a sequenced row needs no extra read`, async () => {
      const row = { sessionId: HOME, updatedAt: NOW - 5, running: false, blank: false, agentAvailable: true, projections: { kind: 'sequenced', asOfSeq: 12, values: { title: VOICE_TITLE } } }
      const w = world({ level, mark, list: () => json({ result: { ok: true, value: { items: [row] } } }) })
      w.store.set(live.AUMA_LIVE_VOICE_SESSION_KEY, HOME)
      await spoken(w)
      expect(reads(w)).toEqual([])
      expect(w.prompts().map(prompt => prompt.sessionId)).toEqual([HOME])
    })
  }

  it('a turn given a cached-only home by hand (not this page\'s own search) is still refused: the turn allowance cannot be forged', async () => {
    const w = world({ level: 'open', mark: OPEN_MARK, projectionsRead: () => READ_FAILS() })
    const heard: string[] = []
    const result = await w.g.streamTurn({
      sessionId: HOME, text: 'hello', spoken: true, signal: new AbortController().signal, onToken: (v: string) => { heard.push(v) },
      lookOnly: { kind: 'ready', sessionId: HOME, level: 'open', map: '', roster: '', working: '', provisional: true },
    })
    expect(w.prompts()).toEqual([])
    expect(result.reason).toBe(live.VOICE_HOME_UNAVAILABLE)
  })
})
