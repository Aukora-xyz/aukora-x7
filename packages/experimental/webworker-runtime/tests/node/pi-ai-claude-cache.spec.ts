/**
 * Caching on her Claude Messages wire. Rules from the provider's reference only
 * (claude-api shared/prompt-caching.md): render order is tools -> system -> messages and a mark on the last system block
 * caches tools and system together (line 11, 37); the growing conversation is read back through a mark on the last
 * content block of the newest message (47-51); a mark may stand on text, tool_use and tool_result blocks (128); tools are
 * serialized deterministically, sorted by name (97); a moving mark is not an invalidator, so prefixes are compared with
 * every mark removed (206). The digest that guards replayed thinking blocks ignores marks, so a moved mark never drops one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicMessagesApi } from '../../src/node/external_packages/pi-ai.ts'

const ORIGIN = 'https://node.example.invalid'
const LIMITS = { windowMs: 60_000, requests: 1000, tokens: 50_000_000, maxOutputTokens: 256_000 }
const MARK = { type: 'ephemeral' }

function claude(id = 'claude-fable-5-2') {
  return {
    id, name: id, api: 'anthropic-messages', provider: 'anthropic-door', baseUrl: 'https://api.anthropic.com/v1',
    input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000,
    maxTokens: 128_000, reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  }
}

function sse(events: unknown[]): Response {
  const text = events.map(event => `event: ${String((event as { type?: unknown }).type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(new TextEncoder().encode(text), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const DONE = [
  { type: 'message_start', message: { id: 'msg_done', model: 'claude-fable-5-2', usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]

function thinkingTurn(signature: string, toolId: string): unknown[] {
  return [
    { type: 'message_start', message: { id: `msg_${signature}`, model: 'claude-fable-5-2', usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'read it first' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: toolId, name: 'read', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = []
  for await (const event of stream) events.push(event)
  return events
}

type EdgeCheck = (bytes: Uint8Array, limits: unknown, path: string) => { requestedModel: string }
async function edgeCheck(): Promise<EdgeCheck> {
  const budget: unknown = await import(new URL('../../../../../deploy/cloudflare/src/provider-budget.mjs', import.meta.url).href)
  return (budget as { providerRequestReservation: never }).providerRequestReservation
}

/** One step: the body that left and the assistant message that came back. */
type Step = { text: string; body: Record<string, unknown>; message: Record<string, unknown> }
async function step(context: unknown, events: unknown[]): Promise<Step> {
  vi.stubGlobal('location', { origin: ORIGIN })
  const fetchMock = vi.fn<typeof fetch>(async () => sse(events))
  const out = await collect(anthropicMessagesApi().streamSimple(claude() as never, context as never,
    { apiKey: 'x5-edge-door', reasoning: 'medium', fetch: fetchMock }))
  const done = out.at(-1) as unknown as { type: string; message: Record<string, unknown> }
  expect(done.type).toBe('done')
  const text = fetchMock.mock.calls[0]?.[1]?.body
  if (typeof text !== 'string') throw new Error('Expected a JSON request body')
  return { text, body: JSON.parse(text) as Record<string, unknown>, message: done.message }
}

/** The body with every `cache_control` removed (the reference's own diff method, prompt-caching.md line 206). */
function unmarked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unmarked)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, child]) => [key, unmarked(child)]))
}

const tool = (name: string) => ({ name, description: `${name} a file`, parameters: { type: 'object', properties: { path: { type: 'string' } } } })
const read = tool('read')
const user = { role: 'user', content: 'Read a.ts', timestamp: 0 }
const result = (id: string) => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: 'contents of a.ts' }], timestamp: 0 })

afterEach(() => { vi.unstubAllGlobals() })

describe('two cache marks on her Claude Messages wire', () => {
  it('system is one text block carrying the mark; the last block of the newest message carries the second; nothing else', async () => {
    const { text, body } = await step({ systemPrompt: 'Rules v1', tools: [read], messages: [user] }, DONE)
    expect(text.split('"cache_control"').length - 1).toBe(2)
    expect(body.system).toEqual([{ type: 'text', text: 'Rules v1', cache_control: MARK }])
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Read a.ts', cache_control: MARK }] }])
    expect(JSON.stringify(body.tools)).not.toContain('cache_control')
    expect((await edgeCheck())(new TextEncoder().encode(text), LIMITS, '/v1/messages').requestedModel).toBe('claude-fable-5-2')
  })

  it('at a tool result the mark stands on the tool_result block itself (its string content unchanged)', async () => {
    const first = await step({ systemPrompt: 'Rules v1', tools: [read], messages: [user] }, thinkingTurn('sig-tr', 'toolu_tr'))
    const { text, body } = await step({ systemPrompt: 'Rules v1', tools: [read], messages: [user, first.message, result('toolu_tr')] }, DONE)
    expect(text.split('"cache_control"').length - 1).toBe(2)
    expect((body.messages as unknown[]).at(-1)).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_tr', content: 'contents of a.ts', cache_control: MARK }] })
    expect((await edgeCheck())(new TextEncoder().encode(text), LIMITS, '/v1/messages').requestedModel).toBe('claude-fable-5-2')
  })

  it('two consecutive steps of one turn: with marks removed, the first body\'s system, tools and messages are a byte prefix of the second\'s', async () => {
    const tools = [tool('write'), read, tool('edit')]
    const first = await step({ systemPrompt: 'Rules v1', tools, messages: [user] }, thinkingTurn('sig-pre', 'toolu_p'))
    const second = await step({ systemPrompt: 'Rules v1', tools, messages: [user, first.message, result('toolu_p')] }, DONE)
    const a = unmarked(first.body) as Record<string, unknown>
    const b = unmarked(second.body) as Record<string, unknown>
    expect(JSON.stringify(b.system)).toBe(JSON.stringify(a.system))
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools))
    const before = JSON.stringify(a.messages)
    expect(JSON.stringify(b.messages).startsWith(before.slice(0, -1))).toBe(true)
    expect((b.messages as unknown[]).length).toBeGreaterThan((a.messages as unknown[]).length)
  })

  it('a thinking block made at step N is replayed at step N+1, after the mark moved off the message before it', async () => {
    const first = await step({ systemPrompt: 'Rules v1', tools: [read], messages: [user] }, thinkingTurn('sig-moved', 'toolu_m'))
    // At step N the user message carried the mark; at step N+1 the mark is on the tool result.
    expect(JSON.stringify((first.body.messages as unknown[])[0])).toContain('cache_control')
    const second = await step({ systemPrompt: 'Rules v1', tools: [read], messages: [user, first.message, result('toolu_m')] }, DONE)
    expect(JSON.stringify((second.body.messages as unknown[])[0])).not.toContain('cache_control')
    expect((second.body.messages as unknown[])[1]).toEqual({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'read it first', signature: 'sig-moved' },
      { type: 'tool_use', id: 'toolu_m', name: 'read', input: { path: 'a.ts' } },
    ] })
  })

  it('with no system text the first mark stands on the last tool definition', async () => {
    const { text, body } = await step({ tools: [tool('write'), read], messages: [user] }, DONE)
    expect(body).not.toHaveProperty('system')
    expect(text.split('"cache_control"').length - 1).toBe(2)
    expect(body.tools).toEqual([{ name: 'read', description: 'read a file', input_schema: read.parameters },
      { name: 'write', description: 'write a file', input_schema: read.parameters, cache_control: MARK }])
    expect((await edgeCheck())(new TextEncoder().encode(text), LIMITS, '/v1/messages').requestedModel).toBe('claude-fable-5-2')
  })

  it('tools are sent sorted by name, the same for any registration order', async () => {
    const names = ['write', 'read', 'edit', 'apply_patch', 'Zeta']
    const orders = [names, [...names].reverse(), ['edit', 'Zeta', 'write', 'apply_patch', 'read']]
    const sent: string[] = []
    for (const order of orders) {
      const { body } = await step({ systemPrompt: 'Rules v1', tools: order.map(tool), messages: [user] }, DONE)
      sent.push(JSON.stringify(body.tools))
      expect((body.tools as { name: string }[]).map(item => item.name)).toEqual(['Zeta', 'apply_patch', 'edit', 'read', 'write'])
    }
    expect(new Set(sent).size).toBe(1)
  })
})
