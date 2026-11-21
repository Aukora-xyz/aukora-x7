/**
 * Usage and cost are visible on her Claude Messages wire. Prices per million tokens are
 * copied from the provider's reference (claude-api shared/models.md lines 78, 83, 89; 5-minute cache writes at 1.25x
 * the input price, shared/prompt-caching.md line 144). A step's usage carries input (the uncached rest), cache read,
 * cache write and output; its cost is priced from that table; a model outside the table costs nothing it can be
 * blamed for (zero, never a guess). Cache writes count toward the overflow check.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicMessagesApi, isContextOverflow } from '../../src/node/external_packages/pi-ai.ts'
import { CLAUDE_PRICES, claudeStepUsd } from '../../src/claude-prices.ts'

const ORIGIN = 'https://node.example.invalid'

function claude(id: string) {
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

/** One answer whose usage says: 1,000 uncached, 200,000 read from the cache, 3,000 written to it, 500 out. */
const STEP = (model: string) => [
  { type: 'message_start', message: { id: 'msg_u', model, usage: { input_tokens: 1000, cache_read_input_tokens: 200_000,
    cache_creation_input_tokens: 3000, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } },
  { type: 'message_stop' },
]

async function usageOf(model: string): Promise<Record<string, unknown>> {
  vi.stubGlobal('location', { origin: ORIGIN })
  const fetchMock = vi.fn<typeof fetch>(async () => sse(STEP(model)))
  let last: unknown
  for await (const event of anthropicMessagesApi().streamSimple(claude(model),
    { systemPrompt: 'Rules', messages: [{ role: 'user', content: 'hi', timestamp: 0 }] } as never,
    { apiKey: 'x5-edge-door', reasoning: 'medium', fetch: fetchMock })) last = event
  expect(last).toMatchObject({ type: 'done' })
  return (last as { message: { usage: Record<string, unknown> } }).message.usage
}

const close = (value: unknown, expected: number) => { expect(value as number).toBeCloseTo(expected, 9) }

afterEach(() => { vi.unstubAllGlobals() })

describe('the price table is the reference\'s, per million tokens', () => {
  it('Fable 5.2, Opus 5.5 and Sonnet 5.5: input, output, cache read, 5-minute cache write', () => {
    expect(CLAUDE_PRICES).toEqual({
      'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
      'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    })
    expect(Object.isFrozen(CLAUDE_PRICES)).toBe(true)
  })

  it('prices one step, and says null for a model it has no price for', () => {
    close(claudeStepUsd('claude-fable-5-2', { input: 1000, cacheRead: 200_000, cacheWrite: 3000, output: 500 }), 0.008 + 0.04 + 0.03 + 0.02)
    expect(claudeStepUsd('claude-haiku-5-5', { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })).toBeNull()
    expect(claudeStepUsd('deepseek-flash', { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })).toBeNull()
  })
})

describe('a Messages step carries its usage and its cost', () => {
  it.each([
    ['claude-fable-5-2', { input: 0.008, cacheRead: 0.04, cacheWrite: 0.03, output: 0.02 }],
    ['claude-opus-5-5', { input: 0.004, cacheRead: 0.04, cacheWrite: 0.015, output: 0.01 }],
    ['claude-sonnet-5-5', { input: 0.002, cacheRead: 0.02, cacheWrite: 0.0075, output: 0.005 }],
  ])('%s', async (model, cost) => {
    const usage = await usageOf(model)
    expect(usage).toMatchObject({ input: 1000, cacheRead: 200_000, cacheWrite: 3000, output: 500, totalTokens: 204_500 })
    const got = usage.cost as Record<string, number>
    for (const key of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) close(got[key], cost[key])
    close(got.total, cost.input + cost.cacheRead + cost.cacheWrite + cost.output)
  })

  it('a model outside the table keeps a zero cost (no guess)', async () => {
    const usage = await usageOf('claude-haiku-5-5')
    expect(usage).toMatchObject({ input: 1000, cacheRead: 200_000, cacheWrite: 3000, output: 500 })
    expect(usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
  })
})

describe('cache writes count toward the overflow check', () => {
  const answer = (input: number, cacheRead: number, cacheWrite: number) => ({
    role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic-door', model: 'claude-fable-5-2', timestamp: 0,
    stopReason: 'stop', usage: { input, output: 10, cacheRead, cacheWrite, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  })
  it('a prompt whose uncached, read and written parts together pass the window is an overflow', () => {
    expect(isContextOverflow(answer(100, 500, 600) as never, 1000)).toBe(true)
    expect(isContextOverflow(answer(100, 500, 300) as never, 1000)).toBe(false)
  })
})
