/**
 * Her working self on Claude chooses its
 * effort. In the browser her Claude routes speak the Messages wire through the same-origin Anthropic door, and the
 * chosen level travels as `output_config.effort` with its own output room, exactly as her fast voice sends it
 * (deploy/cloudflare/src/voice-fast.mjs THE LEVEL TABLE). The bodies here are checked by the edge's own request check.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  anthropicMessagesApi,
  getSupportedThinkingLevels,
  openAICompletionsApi,
} from '../../src/node/external_packages/pi-ai.ts'
import { CLAUDE_EFFORT_ROOM, CLAUDE_EFFORTS } from '../../src/claude-efforts.ts'

const ORIGIN = 'https://node.example.invalid'
const DOOR = '/door/anthropic/v1/messages'
const LIMITS = { windowMs: 60_000, requests: 1000, tokens: 50_000_000, maxOutputTokens: 256_000 }
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']

/** One of her Claude routes, as packages/bundle/web-app/cordis.patch.yml materializes it. */
function claude(id = 'claude-fable-5-2', maxTokens = 128_000) {
  return {
    id, name: id, api: 'anthropic-messages', provider: 'anthropic-door', baseUrl: 'https://api.anthropic.com/v1',
    input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000,
    maxTokens, reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  }
}

function sse(events: unknown[]): Response {
  const text = events.map(event => `event: ${String((event as { type?: unknown }).type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(new TextEncoder().encode(text), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const DONE = [
  { type: 'message_start', message: { id: 'msg_1', model: 'claude-fable-5-2', usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]

function sentText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
  return init.body
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = []
  for await (const event of stream) events.push(event)
  return events
}

type EdgeCheck = (bytes: Uint8Array, limits: unknown, path: string) => { requestedModel: string; outputTokens: number }
async function edgeCheck(): Promise<EdgeCheck> {
  const budget: unknown = await import(new URL('../../../../../deploy/cloudflare/src/provider-budget.mjs', import.meta.url).href)
  return (budget as { providerRequestReservation: never }).providerRequestReservation
}

const read = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
const HISTORY = {
  systemPrompt: 'Follow instructions',
  tools: [read],
  messages: [
    { role: 'user', content: 'Read a.ts', timestamp: 0 },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '', thinkingSignature: 'sig-1' },
      { type: 'text', text: 'Reading.' },
      { type: 'toolCall', id: 'toolu_1', name: 'read', arguments: { path: 'a.ts' } },
    ], timestamp: 0 },
    { role: 'toolResult', toolCallId: 'toolu_1', toolName: 'read', content: [{ type: 'text', text: 'contents' }], timestamp: 0 },
  ],
}

afterEach(() => { vi.unstubAllGlobals() })

describe('her Claude routes offer the five levels', () => {
  it('uses the voice level table for each level room, unchanged', async () => {
    const voice: unknown = await import(new URL('../../../../../deploy/cloudflare/src/voice-fast.mjs', import.meta.url).href)
    const table = (voice as { FAST_EFFORT_LEVELS: Record<string, { maxTokens: number }> }).FAST_EFFORT_LEVELS
    expect(CLAUDE_EFFORTS).toEqual(FIVE)
    expect(Object.fromEntries(CLAUDE_EFFORTS.map(level => [level, CLAUDE_EFFORT_ROOM[level]])))
      .toEqual(Object.fromEntries(Object.entries(table).map(([level, row]) => [level, row.maxTokens])))
  })

  it('offers low, medium, high, xhigh and max, in that order, on each of the three models', () => {
    for (const id of ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
      expect(getSupportedThinkingLevels(claude(id) as never)).toEqual(FIVE)
    }
  })

  it('does not offer a level whose output room does not fit the model output cap', () => {
    expect(getSupportedThinkingLevels(claude('claude-fable-5-2', 32_000) as never)).toEqual(['low', 'medium', 'high'])
  })
})

describe('the chosen level reaches the provider through the door, and only a known one', () => {
  it.each(FIVE)('sends %s as output_config.effort with its own room, in a body the edge check accepts', async (level) => {
    vi.stubGlobal('location', { origin: ORIGIN })
    const fetchMock = vi.fn<typeof fetch>(async () => sse(DONE))
    const events = await collect(anthropicMessagesApi().streamSimple(claude() as never, HISTORY as never,
      { apiKey: 'x5-edge-door', reasoning: level as never, fetch: fetchMock }))
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(ORIGIN + DOOR)
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-api-key')).toBeNull()
    const body = JSON.parse(sentText(init)) as Record<string, unknown>
    expect(body.output_config).toEqual({ effort: level })
    expect(body.max_tokens).toBe(CLAUDE_EFFORT_ROOM[level as keyof typeof CLAUDE_EFFORT_ROOM])
    // System is one text block carrying the first cache mark.
    expect(body).toMatchObject({ model: 'claude-fable-5-2', stream: true,
      system: [{ type: 'text', text: 'Follow instructions', cache_control: { type: 'ephemeral' } }] })
    // Thinking is always on for these models: no `thinking` field and no sampling field is ever sent.
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('temperature')
    expect(body.messages).toEqual([
      // User turns go as content blocks; the newest block carries the second cache mark.
      { role: 'user', content: [{ type: 'text', text: 'Read a.ts' }] },
      // sig-1 was not made in this browser, so its prefix is unknown and it is not replayed (review fix below).
      { role: 'assistant', content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents', cache_control: { type: 'ephemeral' } }] },
    ])
    expect(body.tools).toEqual([{ name: 'read', description: 'Read a file', input_schema: read.parameters }])
    const check = await edgeCheck()
    const reservation = check(new TextEncoder().encode(sentText(init)), LIMITS, '/v1/messages')
    expect(reservation.requestedModel).toBe('claude-fable-5-2')
    expect(reservation.outputTokens).toBe(body.max_tokens)
  })

  it('keeps a larger output room the conversation already asks for', async () => {
    vi.stubGlobal('location', { origin: ORIGIN })
    const fetchMock = vi.fn<typeof fetch>(async () => sse(DONE))
    await collect(anthropicMessagesApi().streamSimple(claude() as never, HISTORY as never,
      { apiKey: 'x5-edge-door', reasoning: 'medium', maxTokens: 128_000, fetch: fetchMock }))
    expect(JSON.parse(sentText(fetchMock.mock.calls[0]?.[1]))).toMatchObject({ max_tokens: 128_000, output_config: { effort: 'medium' } })
  })

  it.each([['extreme', 'REASONING_EFFORT_UNKNOWN'], ['minimal', 'REASONING_EFFORT_UNKNOWN'], ['MAX', 'REASONING_EFFORT_UNKNOWN']])(
    'refuses the effort %s with %s before any request leaves', async (effort, code) => {
      vi.stubGlobal('location', { origin: ORIGIN })
      const fetchMock = vi.fn<typeof fetch>(async () => sse(DONE))
      const events = await collect(anthropicMessagesApi().streamSimple(claude() as never, HISTORY as never,
        { apiKey: 'x5-edge-door', reasoning: effort as never, fetch: fetchMock }))
      expect(fetchMock).not.toHaveBeenCalled()
      expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'error' })
      expect((events.at(-1) as { error: { errorMessage: string } }).error.errorMessage).toContain(code)
    })

  it('refuses a level the model output cap cannot carry, before any request leaves', async () => {
    vi.stubGlobal('location', { origin: ORIGIN })
    const fetchMock = vi.fn<typeof fetch>(async () => sse(DONE))
    const events = await collect(anthropicMessagesApi().streamSimple(claude('claude-fable-5-2', 32_000) as never, HISTORY as never,
      { apiKey: 'x5-edge-door', reasoning: 'max', fetch: fetchMock }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect((events.at(-1) as { error: { errorMessage: string } }).error.errorMessage).toContain('REASONING_EFFORT_NOT_OFFERED')
  })

  it('never calls the provider directly outside a page door', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(DONE))
    const events = await collect(anthropicMessagesApi().streamSimple(claude() as never, HISTORY as never,
      { apiKey: 'x5-edge-door', reasoning: 'low', fetch: fetchMock }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({ type: 'error' })
  })
})

describe('the Messages stream comes back as her events', () => {
  it('reads thinking with its signature, text and one tool call, and stops for the tool', async () => {
    vi.stubGlobal('location', { origin: ORIGIN })
    const fetchMock = vi.fn<typeof fetch>(async () => sse([
      { type: 'message_start', message: { id: 'msg_2', model: 'claude-fable-5-2', usage: { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 1 } } },
      { type: 'ping' },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-2' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'it.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"b.ts"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]))
    const events = await collect(anthropicMessagesApi().streamSimple(claude() as never, HISTORY as never,
      { apiKey: 'x5-edge-door', reasoning: 'high', fetch: fetchMock }))
    expect(events.map(event => (event as { type: string }).type)).toEqual([
      'start', 'thinking_start', 'thinking_end', 'text_start', 'text_delta', 'text_delta', 'text_end',
      'toolcall_start', 'toolcall_delta', 'toolcall_delta', 'toolcall_end', 'done',
    ])
    type Usage = { input: number; output: number; cacheRead: number }
    const done = events.at(-1) as { reason: string; message: { content: unknown[]; usage: Usage; responseId: string } }
    expect(done.reason).toBe('toolUse')
    expect(done.message.responseId).toBe('msg_2')
    expect(done.message.content).toEqual([
      { type: 'thinking', thinking: '', thinkingSignature: 'sig-2' },
      { type: 'text', text: 'Reading it.' },
      { type: 'toolCall', id: 'toolu_2', name: 'read', arguments: { path: 'b.ts' } },
    ])
    expect(done.message.usage).toMatchObject({ input: 20, cacheRead: 5, output: 9 })
  })

  it('stops at the output room as length', async () => {
    vi.stubGlobal('location', { origin: ORIGIN })
    const fetchMock = vi.fn<typeof fetch>(async () => sse([...DONE.slice(0, 4),
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } }, { type: 'message_stop' }]))
    const events = await collect(anthropicMessagesApi().streamSimple(claude() as never, HISTORY as never,
      { apiKey: 'x5-edge-door', reasoning: 'low', fetch: fetchMock }))
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'length' })
  })

  it('reports a provider refusal and a stream error as errors, never as an answer', async () => {
    vi.stubGlobal('location', { origin: ORIGIN })
    for (const tail of [
      [{ type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }],
      [{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
      [],
    ]) {
      const fetchMock = vi.fn<typeof fetch>(async () => sse([...DONE.slice(0, 4), ...tail]))
      const events = await collect(anthropicMessagesApi().streamSimple(claude() as never, HISTORY as never,
        { apiKey: 'x5-edge-door', reasoning: 'low', fetch: fetchMock }))
      expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'error' })
    }
  })
})

/**
 * Review fix (2026-11-17): a replayed thinking block is valid only while the `system`, the `tools` and every earlier
 * message are byte-identical to when it was made (the provider's history-editing check, enforced on every account on
 * Fable 5.2). On this route the harness rewrites the head prompt in place and the shim folds every section or tool
 * change into `system` and `tools`, so a block goes back only when its prefix is unchanged; otherwise it and every
 * block before it are dropped (blocks may be removed from the front, never from the middle).
 */
describe('thinking goes back only into the conversation prefix that made it', () => {
  const write = { name: 'write', description: 'Write a file', parameters: { type: 'object', properties: {} } }

  function thinkingTurn(signature: string, toolId: string): unknown[] {
    return [
      { type: 'message_start', message: { id: `msg_${signature}`, model: 'claude-fable-5-2', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: toolId, name: 'read', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]
  }

  async function turn(context: unknown, events: unknown[]): Promise<{ body: Record<string, unknown>; message: Record<string, unknown> }> {
    vi.stubGlobal('location', { origin: ORIGIN })
    const fetchMock = vi.fn<typeof fetch>(async () => sse(events))
    const out = await collect(anthropicMessagesApi().streamSimple(claude() as never, context as never,
      { apiKey: 'x5-edge-door', reasoning: 'medium', fetch: fetchMock }))
    const done = out.at(-1) as unknown as { type: string; message: Record<string, unknown> }
    expect(done.type).toBe('done')
    return { body: JSON.parse(sentText(fetchMock.mock.calls[0]?.[1])) as Record<string, unknown>, message: done.message }
  }

  function replayed(body: Record<string, unknown>): unknown[] {
    return (body.messages as { content: unknown }[]).flatMap((message): unknown[] => Array.isArray(message.content)
      ? (message.content as { type?: unknown }[]).filter(block => block.type === 'thinking') : [])
  }

  function result(id: string) {
    return { role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: 'contents' }], timestamp: 0 }
  }

  it('replays a block this conversation made while its system, tools and earlier messages are unchanged', async () => {
    const user = { role: 'user', content: 'Read a.ts', timestamp: 0 }
    const first = await turn({ systemPrompt: 'Rules v1', tools: [read], messages: [user] }, thinkingTurn('sig-same', 'toolu_s'))
    const { body } = await turn({ systemPrompt: 'Rules v1', tools: [read], messages: [user, first.message, result('toolu_s')] }, DONE)
    expect(replayed(body)).toEqual([{ type: 'thinking', thinking: '', signature: 'sig-same' }])
  })

  it('drops the block after the head system prompt is rewritten in place', async () => {
    const user = { role: 'user', content: 'Read a.ts', timestamp: 0 }
    const first = await turn({ systemPrompt: 'System prompt v1', tools: [read], messages: [user] }, thinkingTurn('sig-head', 'toolu_h'))
    const { body } = await turn({ systemPrompt: 'System prompt v2 with a new organ', tools: [read], messages: [user, first.message, result('toolu_h')] }, DONE)
    expect(body.system).toEqual([{ type: 'text', text: 'System prompt v2 with a new organ', cache_control: { type: 'ephemeral' } }])
    expect(replayed(body)).toEqual([])
    expect((body.messages as unknown[])[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_h', name: 'read', input: { path: 'a.ts' } }] })
  })

  it('drops the block after a mid-conversation section or tool change folds into system and tools', async () => {
    const user = { role: 'user', content: 'Read a.ts', timestamp: 0 }
    const first = await turn({ systemPrompt: 'Rules v1', tools: [read], messages: [user] }, thinkingTurn('sig-mid', 'toolu_m'))
    const change = { role: 'system', content: '', sections: { facts: 'updated fact' }, toolsAdded: [write], timestamp: 1 }
    const { body } = await turn({ systemPrompt: 'Rules v1', tools: [read], messages: [user, first.message, result('toolu_m'), change, { role: 'user', content: 'next', timestamp: 2 }] }, DONE)
    expect(body.system).toEqual([{ type: 'text', text: 'Rules v1\n\nupdated fact', cache_control: { type: 'ephemeral' } }])
    expect((body.tools as { name: string }[]).map(tool => tool.name)).toEqual(['read', 'write'])
    expect(replayed(body)).toEqual([])
  })

  it('after a change keeps only the blocks made under the new prefix (dropped from the front)', async () => {
    const user = { role: 'user', content: 'Read a.ts', timestamp: 0 }
    const first = await turn({ systemPrompt: 'Rules v1', tools: [read], messages: [user] }, thinkingTurn('sig-old', 'toolu_o'))
    const next = { role: 'user', content: 'again', timestamp: 2 }
    const before = [user, first.message, result('toolu_o'), next]
    const second = await turn({ systemPrompt: 'Rules v2', tools: [read], messages: before }, thinkingTurn('sig-new', 'toolu_n'))
    const { body } = await turn({ systemPrompt: 'Rules v2', tools: [read], messages: [...before, second.message, result('toolu_n')] }, DONE)
    expect(replayed(body)).toEqual([{ type: 'thinking', thinking: '', signature: 'sig-new' }])
  })

  it('never replays a block whose making this browser did not see (its prefix is unknown)', async () => {
    const { body } = await turn(HISTORY, DONE)
    expect(replayed(body)).toEqual([])
  })
})

/**
 * `auto`, her default, is the absence of a level. With no level the shim sends
 * what her Claude route sent before the effort build (an earlier commit): the chat-compatible wire through the same door, the
 * same bytes, no effort field and no thinking replay. `auto` itself is never a level on the wire.
 */
describe('auto: no level is the chat wire she ran before', () => {
  /** Her Claude route as the web bundle materialized it at an earlier commit. */
  function before(id = 'claude-fable-5-2') {
    const { thinkingLevelMap: _map, ...rest } = claude(id)
    return { ...rest, api: 'openai-completions', reasoning: false,
      compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false, supportsStore: false, supportsUsageInStreaming: false } }
  }
  const CHAT = [{ id: 'c1', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]
  function chatSse(): Response {
    return new Response(`${CHAT.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const SIGNED = {
    ...HISTORY,
    messages: [...HISTORY.messages,
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thought', thinkingSignature: 'sig-made-on-messages' }, { type: 'text', text: 'Read it.' }], model: 'claude-fable-5-2', timestamp: 0 },
      { role: 'user', content: 'Next.', timestamp: 0 }],
  }

  it.each([['stream'], ['streamSimple']])('%s with no level sends the same URL, headers and body as before the effort build', async (entry) => {
    vi.stubGlobal('location', { origin: ORIGIN })
    // One clock for both runs, so the events compare whole (each carries its timestamp).
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-17T09:30:00Z'))
    onTestFinished(() => { vi.useRealTimers() })
    for (const context of [HISTORY, SIGNED]) {
      const old = vi.fn<typeof fetch>(async () => chatSse())
      const now = vi.fn<typeof fetch>(async () => chatSse())
      const options = { apiKey: 'x5-edge-door', maxTokens: 128_000, headers: { 'x-dsh-test': '1' } }
      const run = (api: typeof openAICompletionsApi, model: unknown, fetchMock: typeof fetch) => {
        const streams = api() as unknown as Record<string, (model: never, context: never, options: never) => AsyncIterable<unknown>>
        return collect(streams[entry]!(model as never, context as never, { ...options, fetch: fetchMock } as never))
      }
      const oldEvents = await run(openAICompletionsApi, before(), old)
      const nowEvents = await run(anthropicMessagesApi, claude(), now)
      expect(nowEvents.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
      expect(nowEvents).toEqual(oldEvents)
      const [oldUrl, oldInit] = old.mock.calls[0] ?? []
      const [nowUrl, nowInit] = now.mock.calls[0] ?? []
      expect(nowUrl).toBe(`${ORIGIN}/door/anthropic/v1/chat/completions`)
      expect(nowUrl).toBe(oldUrl)
      expect(sentText(nowInit)).toBe(sentText(oldInit))
      expect(Object.fromEntries(new Headers(nowInit?.headers))).toEqual(Object.fromEntries(new Headers(oldInit?.headers)))
      expect(nowInit?.credentials).toBe(oldInit?.credentials)
      // No effort field, and a thinking block made on the Messages wire never goes out on the chat wire.
      expect(sentText(nowInit)).not.toContain('effort')
      expect(sentText(nowInit)).not.toContain('sig-made-on-messages')
      expect(sentText(nowInit)).not.toContain('secret thought')
    }
  })

  it('refuses auto as a level on the Messages wire: it is the absence of one, never a field', async () => {
    vi.stubGlobal('location', { origin: ORIGIN })
    const fetchMock = vi.fn<typeof fetch>(async () => sse(DONE))
    const events = await collect(anthropicMessagesApi().streamSimple(claude() as never, HISTORY as never,
      { apiKey: 'x5-edge-door', reasoning: 'auto' as never, fetch: fetchMock }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect((events.at(-1) as { error: { errorMessage: string } }).error.errorMessage).toContain('REASONING_EFFORT_UNKNOWN')
  })

  it('a named level still goes by the Messages wire', async () => {
    vi.stubGlobal('location', { origin: ORIGIN })
    const fetchMock = vi.fn<typeof fetch>(async () => sse(DONE))
    await collect(anthropicMessagesApi().streamSimple(claude() as never, HISTORY as never,
      { apiKey: 'x5-edge-door', reasoning: 'low', fetch: fetchMock }))
    expect(fetchMock.mock.calls[0]?.[0]).toBe(ORIGIN + DOOR)
  })
})
