/**
 * Her tools speak to Prime Intellect through the edge's `/door/prime`, where its key and its day and month spend
 * cap live. A cap refusal comes back to her as its own code; nothing switches her to another provider.
 */
import { describe, expect, it } from 'vitest'
import { CONSULT_PROVIDERS, consultProviders } from '../../src/x6/ball-loader.ts'
import { MODEL_DOORS, modelDoorFor } from '../../src/model-doors.ts'

const ORIGIN = 'https://node.example.invalid'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('the prime provider in her tools', () => {
  it('x6_consult and x6_swarm accept provider prime, on the OpenAI wire', () => {
    expect(CONSULT_PROVIDERS.prime).toBe('openai')
  })

  it('a prime consult goes to the prime door, streamed, with max_tokens', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init?.body as string) as Record<string, unknown> })
      return json({ choices: [{ message: { role: 'assistant', content: 'From Prime.' } }] })
    }) as unknown as typeof fetch
    const result = await consultProviders({ prompt: 'Hi', provider: 'prime', model: 'deepseek/deepseek-v4-flash', maxTokens: 500 }, { origin: ORIGIN, fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.answers?.map(answer => [answer.provider, answer.model, answer.ok])).toEqual([['prime', 'deepseek/deepseek-v4-flash', true]])
    expect(calls.map(call => call.url)).toEqual([`${ORIGIN}/door/prime/v1/chat/completions`])
    expect(calls[0]?.body).toMatchObject({ model: 'deepseek/deepseek-v4-flash', max_tokens: 500, stream: true })
    expect(calls[0]?.body).not.toHaveProperty('max_completion_tokens')
  })

  it('over a cap the door refuses with SPEND_CAP_EXCEEDED and she is told so; no other provider is tried', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      return json({ ok: false, code: 'SPEND_CAP_EXCEEDED', provider: 'prime', window: 'day', retryAt: Date.UTC(2026, 10, 15) }, 429)
    }) as unknown as typeof fetch
    const result = await consultProviders({ prompt: 'Hi', provider: 'prime', model: 'deepseek/deepseek-v4-flash' }, { origin: ORIGIN, fetchImpl })
    expect(result.answers?.map(answer => [answer.provider, answer.ok, answer.code])).toEqual([['prime', false, 'SPEND_CAP_EXCEEDED']])
    expect(urls).toEqual([`${ORIGIN}/door/prime/v1/chat/completions`])
  })

  it('the Prime address rewrites to the same-origin prime door', () => {
    expect(MODEL_DOORS).toContainEqual(['https://api.pinference.ai/api/', 'prime'])
    expect(modelDoorFor('https://api.pinference.ai/api/v1/chat/completions', ORIGIN)).toBe(`${ORIGIN}/door/prime/v1/chat/completions`)
    expect(modelDoorFor('https://api.pinference.ai/other/v1/chat/completions', ORIGIN)).toBe('https://api.pinference.ai/other/v1/chat/completions')
  })
})
