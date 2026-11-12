import { describe, expect, it, vi } from 'vitest'
import {
  builtinModels,
  getBuiltinModels,
  openAICompletionsApi,
} from '../../src/node/external_packages/pi-ai.ts'

function model(provider: string, id?: string) {
  const models = getBuiltinModels(provider)
  const resolved = id === undefined ? models[0] : models.find(entry => entry.id === id)
  if (resolved === undefined) throw new Error(`Missing test model ${provider}/${id ?? '*'}`)
  return resolved
}

function sseResponse(chunks: unknown[], bytewise = false): Response {
  const text = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('')}data: [DONE]\r\n\r\n`
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close()
        return
      }
      const end = bytewise ? offset + 1 : bytes.length
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = []
  for await (const event of stream) events.push(event)
  return events
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
  const body: unknown = JSON.parse(init.body)
  return body
}

const USER = { role: 'user', content: 'Hello', timestamp: 0 } as const

describe('browser pi-ai OpenAI completions', () => {
  it.each([
    ['moonshotai', 'kimi-k2.6', 'https://api.moonshot.ai/v1/chat/completions'],
    ['moonshotai-cn', 'kimi-k2.6', 'https://api.moonshot.cn/v1/chat/completions'],
    ['deepseek', 'deepseek-flash', 'https://api.deepseek.com/chat/completions'],
  ])('uses the configured model and credential at %s', async (provider, id, endpoint) => {
    const fetchMock = vi.fn<typeof fetch>(async () => sseResponse([
      { id: 'response-1', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
    ]))

    const events = await collect(builtinModels().streamSimple(model(provider, id), { messages: [USER] }, {
      apiKey: 'request-key',
      maxTokens: 99,
      fetch: fetchMock,
    }))

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(endpoint)
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer request-key')
    expect(requestBody(init)).toMatchObject({ model: id, stream: true, max_tokens: 99 })
    expect(events.map(event => event.type)).toEqual(['start', 'text_start', 'text_delta', 'text_end', 'done'])
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop', message: { responseId: 'response-1' } })
  })

  it.each([
    ['openrouter-door', 'https://openrouter.ai/api/v1', 'x-ai/grok-4.7', '/door/openrouter/v1/chat/completions'],
    ['anthropic-door', 'https://api.anthropic.com/v1', 'claude-opus-5-5', '/door/anthropic/v1/chat/completions'],
  ])('in the page, sends the composer route %s through its edge door, in a body the edge budget accepts', async (provider, baseUrl, id, doorPath) => {
    const fetchMock = vi.fn<typeof fetch>(async () => sseResponse([
      { id: 'response-door', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]))
    // The edge's and the Mac's own request check (deploy/cloudflare/src/provider-budget.mjs), as the door runs it.
    const budget: unknown = await import(new URL('../../../../../deploy/cloudflare/src/provider-budget.mjs', import.meta.url).href)
    type Reserve = (bytes: Uint8Array, limits: unknown, path: string) => { requestedModel: string }
    const reservation = (budget as { providerRequestReservation: Reserve }).providerRequestReservation
    vi.stubGlobal('location', { origin: 'https://x61.example.invalid' })
    try {
      // The route as packages/bundle/web-app/cordis.patch.yml declares it: text-only, non-reasoning, no streamed usage.
      const routed = { ...model('deepseek'), provider, id, name: id, baseUrl, input: ['text' as const], reasoning: false,
        compat: { maxTokensField: 'max_tokens' as const, supportsDeveloperRole: false, supportsUsageInStreaming: false } }
      const read = { name: 'read', description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
      const events = await collect(openAICompletionsApi().streamSimple(routed, {
        systemPrompt: 'Follow instructions',
        tools: [read],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Read a.ts' }, { type: 'text', text: 'then say ok' }], timestamp: 0 },
          { role: 'assistant', content: [{ type: 'text', text: 'Reading.' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } }], timestamp: 0 },
          { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'contents' }], timestamp: 0 },
        ],
      } as never, { apiKey: 'x5-edge-door', maxTokens: 128_000, fetch: fetchMock }))
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://x61.example.invalid' + doorPath)
      const sent = fetchMock.mock.calls[0]?.[1]?.body
      expect(typeof sent).toBe('string')
      const limits = { windowMs: 60_000, requests: 1000, tokens: 50_000_000, maxOutputTokens: 256_000 }
      expect(reservation(new TextEncoder().encode(String(sent)), limits, doorPath).requestedModel).toBe(id)
      expect(requestBody(fetchMock.mock.calls[0]?.[1])).toMatchObject({ model: id, stream: true, max_tokens: 128_000 })
      expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
    } finally { vi.unstubAllGlobals() }
  })

  it('streams UTF-8 reasoning and one tool call across fragmented SSE', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sseResponse([
      { id: 'response-2', choices: [{ delta: { reasoning_content: '思考' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      {
        choices: [],
        usage: { prompt_tokens: 12, prompt_cache_hit_tokens: 2, completion_tokens: 3 },
      },
    ], true))

    const events = await collect(openAICompletionsApi().streamSimple(model('moonshotai'), { messages: [USER] }, {
      apiKey: 'test-key',
      fetch: fetchMock,
    }))

    expect(events.map(event => event.type)).toEqual([
      'start',
      'thinking_start', 'thinking_delta',
      'text_start', 'text_delta',
      'toolcall_start', 'toolcall_delta', 'toolcall_delta',
      'thinking_end', 'text_end', 'toolcall_end',
      'done',
    ])
    expect(events.filter(event => event.type === 'toolcall_start')).toHaveLength(1)
    expect(events.find(event => event.type === 'toolcall_end')).toMatchObject({
      contentIndex: 2,
      toolCall: { id: 'call-1', name: 'read', arguments: { path: 'x' } },
    })
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      reason: 'toolUse',
      message: {
        responseId: 'response-2',
        usage: { input: 10, output: 3, cacheRead: 2, totalTokens: 15 },
      },
    })
  })

  it('serializes tools, reasoning effort, and assistant tool history', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sseResponse([
      { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
    ]))
    const read = {
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }

    await collect(openAICompletionsApi().streamSimple(model('moonshotai', 'kimi-k3'), {
      systemPrompt: 'Follow instructions',
      tools: [read],
      messages: [
        USER,
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'inspect', thinkingSignature: 'reasoning_content' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
          ],
          timestamp: 0,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'contents' }],
          timestamp: 0,
        },
      ],
    }, { apiKey: 'test-key', reasoning: 'high', fetch: fetchMock }))

    const body = requestBody(fetchMock.mock.calls[0]?.[1])
    expect(body).toMatchObject({
      reasoning_effort: 'high',
      tools: [{ type: 'function', function: { name: 'read' } }],
      messages: [
        { role: 'system', content: 'Follow instructions' },
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          reasoning_content: 'inspect',
          tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"path":"a.ts"}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'contents' },
      ],
    })
  })

  it('resolves a stored provider credential through the model collection', async () => {
    const read = vi.fn(async (_providerId: string, _options?: { signal?: AbortSignal }) => ({ type: 'api_key', key: 'stored-key' }))
    const fetchMock = vi.fn<typeof fetch>(async () => sseResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]))
    const models = builtinModels({
      credentials: { read },
      authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
    })

    await collect(models.streamSimple(model('deepseek'), { messages: [USER] }, { fetch: fetchMock }))

    expect(read).toHaveBeenCalledOnce()
    expect(read.mock.calls[0]?.[0]).toBe('deepseek')
    expect(read.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer stored-key')
  })

  it('turns HTTP and malformed-stream failures into terminal errors', async () => {
    const unauthorized = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }))
    const httpEvents = await collect(openAICompletionsApi().streamSimple(model('deepseek'), { messages: [USER] }, {
      apiKey: 'bad-key',
      fetch: unauthorized,
    }))
    expect(httpEvents).toHaveLength(1)
    expect(httpEvents[0]).toMatchObject({ type: 'error', reason: 'error', error: { errorMessage: '401 bad key' } })

    const malformed = vi.fn<typeof fetch>(async () => new Response('data: not-json\n\n', { status: 200 }))
    const streamEvents = await collect(openAICompletionsApi().streamSimple(model('deepseek'), { messages: [USER] }, {
      apiKey: 'test-key',
      fetch: malformed,
    }))
    expect(streamEvents.map(event => event.type)).toEqual(['start', 'error'])
    expect(streamEvents.at(-1)).toMatchObject({ error: { errorMessage: 'Provider stream contains invalid JSON' } })
  })

  it('refuses missing credentials and unapproved endpoints without fetching', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    expect(() => openAICompletionsApi().streamSimple(model('deepseek'), { messages: [USER] }, { fetch: fetchMock }))
      .toThrow('No API key for provider: deepseek')

    const events = await collect(openAICompletionsApi().streamSimple({
      ...model('deepseek'),
      baseUrl: 'https://example.com/v1',
    }, { messages: [USER] }, { apiKey: 'test-key', fetch: fetchMock }))
    expect(events).toHaveLength(1)
    const failure = events[0]
    if (failure?.type !== 'error') throw new Error('Expected an endpoint failure')
    expect(failure.error.errorMessage).toContain('not available')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cancels an outstanding body read and terminates as aborted', async () => {
    const controller = new AbortController()
    const signals: (AbortSignal | undefined)[] = []
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal ?? undefined
      signals.push(signal)
      const rejection = (): Error => signal?.reason instanceof Error ? signal.reason : new Error('aborted')
      return new Response(new ReadableStream<Uint8Array>({
        pull() {
          return new Promise((_resolve, reject) => {
            if (signal?.aborted) {
              reject(rejection())
              return
            }
            signal?.addEventListener('abort', () => { reject(rejection()) }, { once: true })
          })
        },
      }), { status: 200 })
    })
    const stream = openAICompletionsApi().streamSimple(model('moonshotai'), { messages: [USER] }, {
      apiKey: 'test-key',
      signal: controller.signal,
      fetch: fetchMock,
    })
    const iterator = stream[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ done: false, value: { type: 'start' } })

    const pending = iterator.next()
    controller.abort(new Error('caller stopped'))

    expect(await pending).toMatchObject({ done: false, value: { type: 'error', reason: 'aborted' } })
    expect(signals).toEqual([controller.signal])
    await iterator.return?.(undefined)
  })
})
