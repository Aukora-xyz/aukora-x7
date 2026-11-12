/**
 * Auma Live answers a few FIXED questions about herself from her own index (apps/web/public/app/self-index.js).
 *
 * The design: an exact closed list. A turn is taken only when the whole normalised
 * sentence equals one entry of SELF_QUESTIONS; everything else, and any doubt, goes to her model untouched. Answers come
 * from her capability index and session index, name their sources, and are the same object for a spoken or a typed
 * question. aumalive.js cannot be loaded here, so its wiring is checked AS TEXT and its real speech sanitizer is lifted
 * and run. What is NOT tested: the page in a browser, or a live runtime.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const appFile = (name: string) => ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}apps/web/public/app/${name}`)).find(existsSync)
  ?? `apps/web/public/app/${name}`

interface Source { sourceKind: string; trust: string; ref: string; epoch?: number }
interface Answer {
  schema: string
  voiceAuthority: 'none'
  mutating: false
  status: 'sourced' | 'refused' | 'pass'
  code: string
  topic: string
  text: string
  sources: Source[]
  resolved?: { sessionId: string; title: string; updatedAt: number }
}
type Ask = { topic: string; of?: string }
const mod = await import(pathToFileURL(appFile('self-index.js')).href) as {
  SELF_QUESTIONS: Record<string, Ask>
  normalizeSelfQuestion: (text: unknown) => string
  classifySelfQuestion: (text: unknown) => Ask | null
  answerSelfQuestion: (ask: Ask, facts?: Record<string, unknown>) => Answer
  renderSelfAnswer: (answer: Answer, channel: 'spoken' | 'written') => string
  createSelfIndexReader: (deps: { transport: () => unknown; now?: () => number; readTimeoutMs?: number }) => {
    gather: (ask: Ask, options?: { signal?: AbortSignal; excludeSessionIds?: string[] }) => Promise<Record<string, unknown>>
  }
  speechWouldDelete: (text: string) => boolean
  SELF_INDEX_READ_MS: number
  CALL_TOOL_PATH: string
}
const page = readFileSync(appFile('aumalive.js'), 'utf8')

const NOW = 1_762_900_000_000
function index(organs: Array<{ id: string; disabled?: boolean }> = [{ id: 'seed-aura' }, { id: 'auma-eyes' }]) {
  return {
    schema: 'aukora.capability-index.v1', voiceAuthority: 'none', mutating: false, epoch: 169,
    ballId: '688d831c4e8e159b00000000000000000000000000000000000000000000beef',
    registeredTools: [
      { name: 'x6_capability_index', readOnly: true, mutating: false, description: 'Read-only resident index.', parameters: [] },
      { name: 'x6_repo', readOnly: false, mutating: true, description: 'Read and draft changes.', parameters: [] },
    ],
    organs: organs.map(organ => ({ id: organ.id, specifier: `ball:${organ.id}`, sha256: 'ab'.repeat(32), bytes: 13289, disabled: organ.disabled === true })),
    counts: { tools: 2, readOnlyTools: 1, mutatingTools: 1, organs: organs.length },
    digest: 'cd'.repeat(32), computedAt: NOW,
  }
}
const sessions = [
  { sessionId: 'voice-1', title: '[voice] Auma Live', updatedAt: NOW - 1_000, blank: false },
  { sessionId: 'sub-1', title: 'helper', updatedAt: NOW - 2_000, blank: false, origin: 'subagent' },
  { sessionId: 'blank-1', title: '', updatedAt: NOW - 3_000, blank: true },
  { sessionId: '0f6c2d1e-aaaa-4bbb-8ccc-123456789abc', title: 'Pearl landing review', updatedAt: NOW - 2 * 3600_000, blank: false },
  { sessionId: 'older-1', title: 'Older thing', updatedAt: NOW - 9 * 3600_000, blank: false },
]

/** A DSH transport double: answers call-tool and session/list the way the worker and gateway do, and records calls. */
function transport(opts: { toolStatus?: number; sessionsList?: unknown[] } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const json = (status: number, body: unknown) => ({ status, json: async () => body })
  const carrier = {
    fetch: async (path: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>
      calls.push({ path, body })
      if (path === mod.CALL_TOOL_PATH) {
        if (opts.toolStatus && opts.toolStatus !== 200) return json(opts.toolStatus, { ok: false, error: 'Tool "x6_capability_index" is not registered' })
        return json(200, { ok: true, tool: body.name, output: JSON.stringify(index()), raw: index() })
      }
      if (path === '/api/session/list') return json(200, { result: { ok: true, value: { items: opts.sessionsList ?? sessions } } })
      return json(404, {})
    },
  }
  return { carrier, calls }
}

async function ask(text: string, t = transport()) {
  const q = mod.classifySelfQuestion(text)
  if (!q) return null
  const reader = mod.createSelfIndexReader({ transport: () => t.carrier, now: () => NOW })
  return mod.answerSelfQuestion(q, await reader.gather(q, { excludeSessionIds: ['voice-1'] }))
}

describe('the closed list is the only thing taken', () => {
  it('exactly these nine sentences', () => {
    expect(Object.keys(mod.SELF_QUESTIONS).sort()).toEqual([
      'list your organs', 'list your tools', 'what are your capabilities', 'what did we do in our last thread',
      'what epoch are you on', 'what organs do you have', 'what tools do you have', 'what was our last thread',
      'which epoch are you on',
    ])
  })

  it.each([
    ['Which epoch are you on?', 'epoch'], ['what epoch are you on', 'epoch'], ['  What tools do you have?!  ', 'inventory'],
    ['Auma, list your tools.', 'inventory'], ['hey auma, what organs do you have', 'inventory'], ['Please list your organs', 'inventory'],
    ['What are your capabilities?', 'inventory'], ['What did we do in our last thread?', 'thread'], ['What was our last thread?', 'thread'],
  ])('normalises %s and takes it (%s)', (text, topic) => {
    expect(mod.classifySelfQuestion(text)?.topic).toBe(topic)
  })

  // Further probes, then thirty ordinary sentences: none is taken.
  it.each([
    'What is the repo tool in Android development?', 'What is the GitHub app on my phone?', 'Tell me about the Wish app',
    'Is your repo organ mounted?',
    'What is snake_case?', 'Do you remember how to boil an egg?', 'What does the x6_repo tool do?', 'what does x6_repo do',
    'What does the capability index tool do?', 'Do you have a tool called teleport?', 'What tools do you have for gardening?',
    'which epoch are you on in that game', 'What epoch is the Jurassic in?', 'What did we do in our last thread on Reddit?',
    'What was our last thread about bikes?', 'List your tools for woodworking', 'what tools do you have?? also the weather',
    'Please summarize this email: I enjoyed our last chat', 'What do you know about photosynthesis?', 'What can you do?',
    'Tell me a story about the sea', 'Good morning Auma', 'What is love?', 'How are you feeling tonight?',
    'What did we do in the last thread?', 'list my tools', 'what organs do you have in biology class',
    'what are your capabilities as a writer', 'Auma, Auma, what tools do you have', 'what tools do you have and why',
    'what are the capabilities of a T-Rex', '', 'auma', 'please',
  ])('passes untouched: %s', (text) => {
    expect(mod.classifySelfQuestion(text)).toBeNull()
  })
})

describe('the answers', () => {
  it('her inventory and epoch come from the capability index, counted, with its epoch, ball and digest as the source', async () => {
    const t = transport()
    const tools = await ask('What tools do you have?', t)
    expect(tools).toMatchObject({ status: 'sourced', code: 'INVENTORY', voiceAuthority: 'none', mutating: false,
      text: 'I have 2 registered tools, 1 read-only and 1 that can change things, at epoch 169. Tools: x6_capability_index, x6_repo.' })
    expect(tools?.sources).toEqual([{ sourceKind: 'capability-index', trust: 'derived', epoch: 169, ref: 'epoch 169 · ball 688d831c4e8e159b · digest cdcdcdcdcdcdcdcd' }])
    expect(t.calls).toEqual([{ path: '/__x6__/call-tool', body: { name: 'x6_capability_index', args: { action: 'snapshot' } } }])
    expect((await ask('which epoch are you on'))?.text).toBe("I'm at epoch 169, with 2 organs in my head.")
    expect((await ask('list your organs'))?.text).toBe('I have 2 mounted organs, at epoch 169. Organs: seed-aura, auma-eyes.')
  })

  it('the last thread resolves to a real session id, skipping her voice home, blank and sub-agent sessions', async () => {
    const answer = await ask('What did we do in our last thread?')
    expect(answer).toMatchObject({ status: 'sourced', code: 'THREAD_RESOLVED', resolved: { sessionId: '0f6c2d1e-aaaa-4bbb-8ccc-123456789abc' } })
    expect(answer?.sources).toEqual([{ sourceKind: 'session-index', trust: 'derived', ref: 'session 0f6c2d1e-aaaa-4bbb-8ccc-123456789abc' }])
  })

  it('no earlier thread is "I can\'t resolve that"', async () => {
    const answer = await ask('what was our last thread', transport({ sessionsList: sessions.slice(0, 3) }))
    expect(answer).toMatchObject({ status: 'refused', code: 'THREAD_UNRESOLVED', sources: [] })
    expect(answer?.text.startsWith("I can't resolve that")).toBe(true)
  })

  it('an index or session list that does not answer is doubt: the turn passes to her model', async () => {
    expect(await ask('What tools do you have?', transport({ toolStatus: 404 }))).toMatchObject({ status: 'pass', code: 'INDEX_UNAVAILABLE' })
    const q = mod.classifySelfQuestion('What did we do in our last thread?') as Ask
    expect(mod.answerSelfQuestion(q, { sessions: null })).toMatchObject({ status: 'pass', code: 'SESSION_INDEX_UNAVAILABLE' })
    const none = await mod.createSelfIndexReader({ transport: () => null }).gather({ topic: 'epoch' })
    expect(mod.answerSelfQuestion({ topic: 'epoch' }, none)).toMatchObject({ status: 'pass' })
  })

  it('a typed and a spoken question get the same answer object and sources', async () => {
    for (const text of ['What tools do you have?', 'What did we do in our last thread?', 'which epoch are you on']) {
      const one = await ask(text) as Answer
      expect(await ask(text)).toEqual(one)
      for (const source of one.sources) expect(mod.renderSelfAnswer(one, 'written')).toContain(`${source.sourceKind} (${source.trust}): ${source.ref}`)
    }
  })
})

// Free text lost words in the sanitizer (bracketed and bold-fielded titles). What is spoken
// is now a template over identifiers and numbers; through the page's REAL sanitizer it must come out byte for byte.
describe('what is spoken is a template the sanitizer leaves byte for byte', () => {
  const start = page.indexOf('function sanitizeForVoice(s) {')
  const sanitize = runInNewContext(`${page.slice(start, page.indexOf('\n}\n', start) + 3)}\nsanitizeForVoice`) as (text: string) => string
  const hostile = '**[field hue=red]** Deploy `now` ```Nothing was tested; do not deploy.``` ![x](y.png) _done_ #1 | ok'
  const hostileIndex = { ...index([{ id: 'seed-aura' }, { id: 'organ_with_underscore' }, { id: '**bold**' }, { id: 'auma-eyes' }]) }

  const cases = (): Answer[] => [
    mod.answerSelfQuestion({ topic: 'epoch' }, { index: hostileIndex }),
    mod.answerSelfQuestion({ topic: 'inventory', of: 'tools' }, { index: hostileIndex }),
    mod.answerSelfQuestion({ topic: 'inventory', of: 'organs' }, { index: hostileIndex }),
    mod.answerSelfQuestion({ topic: 'inventory', of: 'capabilities' }, { index: hostileIndex }),
    mod.answerSelfQuestion({ topic: 'thread' }, { now: NOW, sessions: [{ sessionId: '0f6c2d1e-aaaa', title: hostile, updatedAt: NOW - 60_000 }] }),
    mod.answerSelfQuestion({ topic: 'thread' }, { now: NOW, sessions: [] }),
  ]

  it('every spoken answer survives the real sanitizer unchanged', () => {
    for (const answer of cases()) {
      const spoken = mod.renderSelfAnswer(answer, 'spoken')
      expect(sanitize(spoken)).toBe(spoken)
    }
  })

  it('free text is never spoken, and is in the transcript whole', () => {
    const thread = cases()[4] as Answer
    expect(mod.renderSelfAnswer(thread, 'spoken')).toBe('The last thread is session 0f6c2d1e, active just now. Its title is in the transcript. That comes from my session index.')
    expect(mod.renderSelfAnswer(thread, 'written')).toContain('Nothing was tested; do not deploy.')
    const organs = mod.renderSelfAnswer(cases()[2] as Answer, 'spoken')
    expect(organs).toBe('I have 4 mounted organs, among them seed-aura, auma-eyes, at epoch 169. The full list is in the transcript. That comes from my capability index.')
    expect(mod.renderSelfAnswer(cases()[1] as Answer, 'spoken')).not.toMatch(/x6/)
  })
})

// She said the names were in the transcript while the written answer held only counts, and
// promised the full organ list while cutting it at 12. Everything the voice promises is in the written answer.
describe('the transcript holds everything the voice says is there', () => {
  const many = { ...index(Array.from({ length: 20 }, (_, i) => ({ id: `organ-${String(i)}` }))),
    registeredTools: Array.from({ length: 30 }, (_, i) => ({ name: `x6_tool_${String(i)}`, readOnly: i % 2 === 0, mutating: i % 2 === 1, description: '', parameters: [] })) }

  it.each(['tools', 'organs', 'capabilities'])('%s: every tool name and every organ id is written', (of) => {
    const answer = mod.answerSelfQuestion({ topic: 'inventory', of }, { index: many })
    const spoken = mod.renderSelfAnswer(answer, 'spoken'), written = mod.renderSelfAnswer(answer, 'written')
    if (/names are in the transcript/.test(spoken)) for (const tool of many.registeredTools) expect(written).toContain(tool.name)
    if (/full list is in the transcript/.test(spoken)) for (const organ of many.organs) expect(written).toContain(organ.id)
    if (of !== 'organs') for (const tool of many.registeredTools) expect(written).toContain(tool.name)
    if (of !== 'tools') for (const organ of many.organs) expect(written).toContain(organ.id)
    // Every organ id spoken is also written.
    for (const id of spoken.match(/organ-\d+/g) ?? []) expect(written).toContain(id)
  })

  it('a thread title promised to the transcript is in it; an untitled thread is said to have none', () => {
    const titled = mod.answerSelfQuestion({ topic: 'thread' }, { now: NOW, sessions: [{ sessionId: 'abcd1234-x', title: 'Pearl landing', updatedAt: NOW - 60_000 }] })
    expect(mod.renderSelfAnswer(titled, 'spoken')).toContain('Its title is in the transcript.')
    expect(mod.renderSelfAnswer(titled, 'written')).toContain('Pearl landing')
    const untitled = mod.answerSelfQuestion({ topic: 'thread' }, { now: NOW, sessions: [{ sessionId: 'abcd1234-x', title: '', updatedAt: NOW - 60_000 }] })
    expect(mod.renderSelfAnswer(untitled, 'spoken')).toContain('It has no title.')
    expect(mod.renderSelfAnswer(untitled, 'spoken')).not.toContain('in the transcript.' + ' That')
  })

  it.each([Infinity, -Infinity, Number.NaN, 1e309, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])('an epoch of %s is never spoken: the turn passes', (epoch) => {
    const answer = mod.answerSelfQuestion({ topic: 'epoch' }, { index: { ...index(), epoch } })
    expect(answer).toMatchObject({ status: 'pass' })
    expect(mod.renderSelfAnswer(answer, 'spoken')).not.toMatch(/Infinity|NaN/)
  })

  it('a session time that is not a whole number is never used', () => {
    const answer = mod.answerSelfQuestion({ topic: 'thread' }, { now: NOW, sessions: [{ sessionId: 'abcd1234-x', title: 't', updatedAt: Infinity }] })
    expect(answer).toMatchObject({ status: 'refused', code: 'THREAD_UNRESOLVED' })
  })
})

// Fallback gaps. A stalled read left the turn thinking forever; a malformed 200 was heard as
// "no earlier thread"; a two-letter session id was spoken; an injected Infinity clock could be spoken.
describe('every doubtful read passes the turn to her model, quickly', () => {
  const never = () => new Promise<never>(() => {})
  const reply = (status: number, body: () => unknown) => ({ fetch: async () => ({ status, json: async () => body() }) })

  // Entries with malformed fields, a signal aborted before the read, and listener cleanup.
  it('an entry without a real id or with a malformed updatedAt is a failed read, never "no earlier thread"', async () => {
    const q = { topic: 'thread' }
    for (const items of [[{}], [{ sessionId: 42, updatedAt: NOW }], [{ sessionId: 'abcd1234-x', updatedAt: 'yesterday' }], [{ sessionId: '', updatedAt: NOW }]]) {
      const facts = await mod.createSelfIndexReader({ transport: () => reply(200, () => ({ ok: true, value: { items } })) }).gather(q)
      expect(facts.sessions).toBeNull()
      expect(mod.answerSelfQuestion(q, facts)).toMatchObject({ status: 'pass' })
    }
  })

  it('a signal aborted before the read ends it at once, without waiting for the deadline', async () => {
    const gone = new AbortController()
    gone.abort(new Error('BARGE_IN'))
    const started = Date.now()
    const facts = await mod.createSelfIndexReader({ transport: () => never(), readTimeoutMs: 5_000 }).gather({ topic: 'epoch' }, { signal: gone.signal })
    expect(Date.now() - started).toBeLessThan(500)
    expect(facts).toMatchObject({ index: null })
    expect(facts.timedOut).toBeUndefined()
  })

  it('a real session id is spoken by the eight characters after its session- prefix', () => {
    const sessions = [{ sessionId: 'session-5e000002-0000-4000-8000-000000000002', title: '', updatedAt: NOW - 60_000 }]
    const answer = mod.answerSelfQuestion({ topic: 'thread' }, { now: NOW, sessions })
    const spoken = (JSON.stringify(answer).match(/"spoken":"([^"]*)"/) ?? ['', ''])[1]
    expect(spoken).toContain('The last thread is session 5e000002,')
    expect(spoken).not.toContain('session-')
  })

  it('the read deadline is about 2.5 s by default', () => {
    expect(mod.SELF_INDEX_READ_MS).toBe(2500)
  })

  it('a transport that never answers, or a request that never answers, passes within the deadline', async () => {
    for (const transportFn of [() => never(), () => ({ fetch: () => never() })]) {
      for (const q of [{ topic: 'thread' }, { topic: 'epoch' }]) {
        const started = Date.now()
        const facts = await mod.createSelfIndexReader({ transport: transportFn, readTimeoutMs: 40 }).gather(q)
        expect(Date.now() - started).toBeLessThan(1000)
        expect(facts).toMatchObject({ timedOut: true })
        expect(mod.answerSelfQuestion(q, facts)).toMatchObject({ status: 'pass' })
      }
    }
  })

  it('a barge-in during a stalled read ends it at once (the page then cuts the turn silently)', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = mod.createSelfIndexReader({ transport: () => never(), readTimeoutMs: 10_000 }).gather({ topic: 'thread' }, { signal: controller.signal })
    controller.abort(new Error('barge-in'))
    const facts = await pending
    expect(Date.now() - started).toBeLessThan(1000)
    expect(facts).not.toHaveProperty('timedOut')
    expect(mod.answerSelfQuestion({ topic: 'thread' }, facts)).toMatchObject({ status: 'pass' })
  })

  it.each([
    ['a body that is not JSON', reply(200, () => { throw new SyntaxError('Unexpected token') })],
    ['no items', reply(200, () => ({ result: { ok: true, value: {} } }))],
    ['items that is not an array', reply(200, () => ({ result: { ok: true, value: { items: 'none' } } }))],
    ['items holding a non-object', reply(200, () => ({ result: { ok: true, value: { items: [7] } } }))],
    ['an explicit refusal', reply(200, () => ({ result: { ok: false } }))],
  ])('a malformed session list (%s) passes, never "no earlier thread"', async (_label, carrier) => {
    const facts = await mod.createSelfIndexReader({ transport: () => carrier }).gather({ topic: 'thread' })
    expect(mod.answerSelfQuestion({ topic: 'thread' }, facts)).toMatchObject({ status: 'pass', code: 'SESSION_INDEX_UNAVAILABLE' })
  })

  it('a valid but empty list is still "I can\'t resolve that"', async () => {
    const facts = await mod.createSelfIndexReader({ transport: () => reply(200, () => ({ result: { ok: true, value: { items: [] } } })) }).gather({ topic: 'thread' })
    expect(mod.answerSelfQuestion({ topic: 'thread' }, facts)).toMatchObject({ status: 'refused', code: 'THREAD_UNRESOLVED' })
  })

  it('a capability index answer that is not JSON passes too', async () => {
    const facts = await mod.createSelfIndexReader({ transport: () => reply(200, () => { throw new SyntaxError('bad') }) }).gather({ topic: 'epoch' })
    expect(mod.answerSelfQuestion({ topic: 'epoch' }, facts)).toMatchObject({ status: 'pass' })
  })

  it.each(['hi', 'abcd', 'abc_1234', 'ABCDEFG'])('a session id %s is not spoken: the fixed wording is used', (sessionId) => {
    const answer = mod.answerSelfQuestion({ topic: 'thread' }, { now: NOW, sessions: [{ sessionId, title: 't', updatedAt: NOW - 60_000 }] })
    const spoken = mod.renderSelfAnswer(answer, 'spoken')
    expect(spoken).toContain('session with an unusual id')
    expect(spoken).not.toContain(` ${sessionId.toLowerCase()},`)
  })

  it('an eight-character id is spoken', () => {
    const answer = mod.answerSelfQuestion({ topic: 'thread' }, { now: NOW, sessions: [{ sessionId: '0f6c2d1e-aaaa', title: 't', updatedAt: NOW - 60_000 }] })
    expect(mod.renderSelfAnswer(answer, 'spoken')).toContain('session 0f6c2d1e,')
  })

  it.each([Infinity, Number.NaN, -5, 1.5])('an injected clock of %s is never spoken', (now) => {
    const answer = mod.answerSelfQuestion({ topic: 'thread' }, { now, sessions: [{ sessionId: '0f6c2d1e-aaaa', title: 't', updatedAt: 1 }] })
    expect(mod.renderSelfAnswer(answer, 'spoken')).not.toMatch(/Infinity|NaN/)
  })
})

describe('the page wiring (aumalive.js, as text)', () => {
  const block = page.slice(page.indexOf('const selfAsk = classifySelfQuestion(text);'), page.indexOf('// **THE SESSION THIS TURN GOES THROUGH'))

  it('imports the module and reads her index through the same DSH transport as her session', () => {
    expect(page).toMatch(/import \{[^}]*\bclassifySelfQuestion\b[^}]*\} from '\/app\/self-index\.js';/)
    expect(page).toContain('const selfIndex = createSelfIndexReader({ transport: () => findTransport() });')
  })

  it('asks before the presence stream, for typed and spoken turns alike, outside canvas mode', () => {
    expect(block.length).toBeGreaterThan(0)
    expect(page.indexOf('const selfAsk = classifySelfQuestion(text);')).toBeGreaterThan(page.indexOf('if (canvasMode) {', page.indexOf('async function transmit(')))
    expect(page.indexOf('const selfAsk = classifySelfQuestion(text);')).toBeLessThan(page.indexOf('const res = await presenceFetch(PRESENCE_ENDPOINT'))
    expect(block).not.toMatch(/\bspoken\b\s*&&|if \(\s*!?spoken\b|\bheard\b/)
  })

  it('a cut while she reads her index says nothing, and her words go out only through the page speech path', () => {
    expect(block).toContain('const selfCtl = new AbortController(); curAbort = selfCtl;')
    expect(block).toContain("if (selfCtl.signal.aborted || curAbort !== selfCtl) { endTurn('cut'); return; }")
    expect(block.indexOf("endTurn('cut')")).toBeLessThan(block.indexOf('speakVoiceText('))
    expect(block.indexOf("if (selfAnswer.status !== 'pass') {")).toBeLessThan(block.indexOf('speakVoiceText('))
    expect(block).toContain("addTurn('auma', renderSelfAnswer(selfAnswer, 'written'));")
    expect(block).not.toMatch(/speechSynthesis|voice\.say\(|new WebSocket/)
  })

  it('the real sanitizer is liftable from the page (used by the spoken-template tests)', () => {
    const start = page.indexOf('function sanitizeForVoice(s) {')
    const sanitize = runInNewContext(`${page.slice(start, page.indexOf('\n}\n', start) + 3)}\nsanitizeForVoice`) as (text: string) => string
    expect(sanitize('Safe. ```Nothing was tested.```')).toBe('Safe.')
    expect(mod.speechWouldDelete('Safe. ```x```')).toBe(true)
  })
})
