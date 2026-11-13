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
  }
  threadRoster: (items: unknown[], options?: { exclude?: string[]; now?: number }) => string
  rosterClock: (ms: number, now: number) => string
  AUMA_LIVE_ALIEN_VOICE_DIRECTIVE: string
  AUMA_LIVE_VOICE_SESSION_KEY: string
  VOICE_PROVENANCE: string
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
type Item = { sessionId: string; title?: string; displayTitle?: string; updatedAt?: unknown; blank?: boolean; origin?: string }
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
} = {}) {
  const log: Call[] = []
  const items: Item[] = options.items ?? [{ sessionId: HOME, title: VOICE_TITLE, updatedAt: NOW - 1000 }]
  const streams: Stream[] = []
  const store = new Map<string, string>()
  let marks = 0
  let creates = 0
  const transport = {
    fetch: async (path: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>
      if (path.startsWith('/api/__x6__/')) {
        const name = path.slice('/api/__x6__/'.length)
        log.push({ kind: 'x6', name, body })
        if (name === 'voice-mark') { marks += 1; return (options.mark ?? MARK_OK)(String(body.sessionId), marks) }
        if (name === 'session-model') return (options.model ?? (() => json({ ok: true, sessionId: body.sessionId, selected: body, savedDefault: false })))(body)
        return json({ error: `Unknown X6 control route: POST ${path}` }, 404)
      }
      const method = path.replace('/api/', '')
      const args = (body as { payload: { args: Record<string, unknown> } }).payload.args
      log.push({ kind: 'rpc', name: method, body: args })
      if (method === 'session/list') return json({ result: { ok: true, value: { items } } })
      if (method === 'session/create') {
        if (options.createFails) return json({ result: { ok: false, error: { message: 'agent-preset/not-found' } } })
        creates += 1
        const sessionId = `session-fresh-${creates}`
        items.push({ sessionId, displayTitle: 'auma', updatedAt: NOW })
        return json({ result: { ok: true, value: { sessionId, agentPreset: 'auma-alien' } } })
      }
      if (method === 'session/rename') {
        const request = args.request as { sessionId: string; title: string }
        const target = items.find(item => item.sessionId === request.sessionId)
        if (target) { target.title = request.title; target.displayTitle = request.title }
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
  const g = live.createGenesisLive({ transport: Promise.resolve(transport), nativeFetch, storage, now: () => NOW })
  const prompts = () => log.filter(call => call.kind === 'rpc' && call.name === 'session/prompt').map(call => call.body.request as { requestId: string; sessionId: string; content: Array<{ type: string; text: string }> })
  return { g, log, streams, items, store, prompts }
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

describe('a voice home the worker cannot prove is replaced once, exactly as the handoff says', () => {
  it('403 VOICE_HOME_UNPROVEN: fresh home with her folder and preset, renamed before the second mark, stored, then sent there', async () => {
    const w = world({ mark: sessionId => (sessionId === HOME ? UNPROVEN() : MARK_OK()) })
    const response = await presence(w.g, { sessionId: HOME, text: 'hello', spoken: true })
    const read = collect(response)
    await settle()
    const order = w.log.filter(call => call.name !== 'session/list').map(call => `${call.kind}:${call.name}`)
    expect(order).toEqual(['x6:voice-mark', 'rpc:session/create', 'rpc:session/rename', 'x6:voice-mark', 'edge:dispatch_turn', 'rpc:session/prompt'])
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
    expect(w.log.map(call => `${call.kind}:${call.name}`)).toEqual(['rpc:session/list', 'x6:voice-mark', 'edge:dispatch_turn', 'rpc:session/prompt'])
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
    expect(w.log.map(call => `${call.kind}:${call.name}`)).toEqual(['rpc:session/list'])
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
    expect(w.log.filter(call => call.kind === 'rpc').map(call => call.name)).toEqual(['session/list', 'session/prompt'])
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
