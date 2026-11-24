import { describe, expect, it } from 'vitest'
import {
  PROVIDER_LIMITS,
  applyVoiceLimits,
  handleProviderLimits,
  readCallLimits,
  readLimitsPair,
} from '../voice-provider-limits.mjs'

const KEY = 'test-key-never-returned-0123456789'
const RESOURCE = 'seng_abc123'
const PATH = `/v1/speech-engine/${RESOURCE}`

const resourceBody = (callLimits, extra = {}) => ({ speech_engine: { id: RESOURCE, name: 'Auma' }, call_limits: callLimits, ...extra })

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A transport that plays a scripted list of answers and records every request it was given. */
function transport(answers) {
  const seen = []
  const fetch = async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? null : JSON.parse(init.body) })
    const next = answers.shift()
    if (typeof next === 'function') return next()
    return next
  }
  return { fetch, seen }
}

const readAnswers = limits => [() => reply(resourceBody(limits))]

describe('readCallLimits', () => {
  it('keeps plain keys with plain values and drops anything else', () => {
    expect(readCallLimits({ daily_limit: 100, cascade_timeout_seconds: 4, agent_concurrency_limit: 3, nested: { a: 1 }, list: [1], 'bad-key': 1, name: 'x'.repeat(65) }))
      .toEqual({ daily_limit: 100, cascade_timeout_seconds: 4, agent_concurrency_limit: 3 })
  })

  it('answers null for anything that is not an object', () => {
    expect(readCallLimits(null)).toBeNull()
    expect(readCallLimits([])).toBeNull()
    expect(readCallLimits('x')).toBeNull()
  })
})

describe('readLimitsPair', () => {
  it('reports only the two limits, null when absent — never zero', () => {
    expect(readLimitsPair({ daily_limit: 7 })).toEqual({ dailyLimit: 7, cascadeTimeoutSeconds: null })
    expect(readLimitsPair({})).toEqual({ dailyLimit: null, cascadeTimeoutSeconds: null })
    expect(readLimitsPair(null)).toBeNull()
  })
})

describe('applyVoiceLimits', () => {
  it('writes both limits, sends the whole call_limits object as read, and proves it with a second read', async () => {
    const before = { daily_limit: 40, cascade_timeout_seconds: 4, agent_concurrency_limit: 2, max_duration_seconds: 600 }
    const after = { ...before, daily_limit: PROVIDER_LIMITS.dailyLimit, cascade_timeout_seconds: PROVIDER_LIMITS.cascadeTimeoutSeconds }
    const t = transport([
      () => reply(resourceBody(before)),
      () => reply(resourceBody(after)),
      () => reply(resourceBody(after)),
    ])

    const answer = await applyVoiceLimits({ networkFetch: t.fetch, apiKey: KEY, resourceId: RESOURCE })

    expect(answer.ok).toBe(true)
    expect(answer.read).toBe('ok')
    expect(answer.patch).toBe('ok')
    expect(answer.changed).toBe(true)
    expect(answer.before).toEqual({ dailyLimit: 40, cascadeTimeoutSeconds: 4 })
    expect(answer.after).toEqual({ dailyLimit: 100000, cascadeTimeoutSeconds: 15 })

    expect(t.seen.map(call => call.method)).toEqual(['GET', 'PATCH', 'GET'])
    expect(t.seen.every(call => call.url === PROVIDER_LIMITS.origin + PATH)).toBe(true)
    expect(t.seen.every(call => call.headers['xi-api-key'] === KEY)).toBe(true)
    // The whole object goes back, not just the two fields: a PATCH that sends two keys would silently drop the rest.
    expect(t.seen[1].body).toEqual({
      call_limits: { ...before, daily_limit: 100000, cascade_timeout_seconds: 15 },
    })
    expect(t.seen[0].body).toBeNull()
  })

  it('writes nothing when the provider already holds both values', async () => {
    const already = { daily_limit: PROVIDER_LIMITS.dailyLimit, cascade_timeout_seconds: PROVIDER_LIMITS.cascadeTimeoutSeconds }
    const t = transport(readAnswers(already))

    const answer = await applyVoiceLimits({ networkFetch: t.fetch, apiKey: KEY, resourceId: RESOURCE })

    expect(answer.ok).toBe(true)
    expect(answer.patch).toBe('unchanged')
    expect(answer.changed).toBe(false)
    expect(t.seen.map(call => call.method)).toEqual(['GET'])
  })

  it('sends one PATCH when only one of the two needs changing', async () => {
    const before = { daily_limit: PROVIDER_LIMITS.dailyLimit, cascade_timeout_seconds: 4 }
    const after = { ...before, cascade_timeout_seconds: PROVIDER_LIMITS.cascadeTimeoutSeconds }
    const t = transport([() => reply(resourceBody(before)), () => reply(resourceBody(after)), () => reply(resourceBody(after))])

    const answer = await applyVoiceLimits({ networkFetch: t.fetch, apiKey: KEY, resourceId: RESOURCE })

    expect(answer.changed).toBe(true)
    expect(answer.after.cascadeTimeoutSeconds).toBe(15)
    expect(t.seen.map(call => call.method)).toEqual(['GET', 'PATCH', 'GET'])
  })

  it('refuses locally, and writes nothing, when the read carries no call_limits object', async () => {
    const t = transport([() => reply({ speech_engine: { id: RESOURCE } })])

    const answer = await applyVoiceLimits({ networkFetch: t.fetch, apiKey: KEY, resourceId: RESOURCE })

    expect(answer.ok).toBe(false)
    expect(answer.read).toBe('shape')
    expect(answer.patch).toBe('refused-local')
    expect(t.seen.map(call => call.method)).toEqual(['GET'])
  })

  it('writes nothing when the read is refused', async () => {
    const t = transport([() => reply({ detail: 'no' }, 401)])

    const answer = await applyVoiceLimits({ networkFetch: t.fetch, apiKey: KEY, resourceId: RESOURCE })

    expect(answer.ok).toBe(false)
    expect(answer.read).toBe('status-401')
    expect(answer.patch).toBe('refused-local')
    expect(t.seen.map(call => call.method)).toEqual(['GET'])
  })

  it('reports a failed PATCH without claiming the change', async () => {
    const before = { daily_limit: 40, cascade_timeout_seconds: 4 }
    const t = transport([() => reply(resourceBody(before)), () => reply({ detail: 'no' }, 422)])

    const answer = await applyVoiceLimits({ networkFetch: t.fetch, apiKey: KEY, resourceId: RESOURCE })

    expect(answer.ok).toBe(false)
    expect(answer.patch).toBe('status-422')
    expect(answer.changed).toBe(false)
    expect(answer.after).toBeNull()
    expect(t.seen.map(call => call.method)).toEqual(['GET', 'PATCH'])
  })

  it('claims nothing when the second read fails, even though the PATCH succeeded', async () => {
    const before = { daily_limit: 40, cascade_timeout_seconds: 4 }
    const t = transport([() => reply(resourceBody(before)), () => reply(resourceBody(before)), () => { throw new Error('offline') }])

    const answer = await applyVoiceLimits({ networkFetch: t.fetch, apiKey: KEY, resourceId: RESOURCE })

    expect(answer.ok).toBe(false)
    expect(answer.patch).toBe('ok')
    expect(answer.after).toBeNull()
  })

  it('refuses locally without any request when the key or the resource is missing', async () => {
    const t = transport([])

    expect((await applyVoiceLimits({ networkFetch: t.fetch, apiKey: '', resourceId: RESOURCE })).read).toBe('not-configured')
    expect((await applyVoiceLimits({ networkFetch: t.fetch, apiKey: KEY, resourceId: 'not-a-resource' })).read).toBe('not-configured')
    expect((await applyVoiceLimits({ networkFetch: t.fetch, apiKey: undefined, resourceId: RESOURCE })).read).toBe('not-configured')
    expect(t.seen).toEqual([])
  })

  it('never puts the key in an answer', async () => {
    const before = { daily_limit: 40, cascade_timeout_seconds: 4 }
    const after = { ...before, daily_limit: PROVIDER_LIMITS.dailyLimit, cascade_timeout_seconds: PROVIDER_LIMITS.cascadeTimeoutSeconds }
    const t = transport([() => reply(resourceBody(before)), () => reply(resourceBody(after)), () => reply(resourceBody(after))])

    const answer = await applyVoiceLimits({ networkFetch: t.fetch, apiKey: KEY, resourceId: RESOURCE })

    expect(JSON.stringify(answer)).not.toContain(KEY)
    expect(JSON.stringify(answer)).not.toContain('xi-api-key')
  })
})

describe('handleProviderLimits', () => {
  it('refuses a caller who is not the owner, before any request to the provider', async () => {
    const t = transport([])
    const env = { OWNER_EMAIL: 'owner@example.com', ELEVENLABS_VOICE_API_KEY: KEY, ELEVENLABS_X61_VOICE_RESOURCE_ID: RESOURCE }

    for (const access of [null, undefined, { type: 'anon' }, { type: 'owner' }, { type: 'owner', email: 'someone@else.test' }]) {
      const response = await handleProviderLimits({ request: new Request('https://node.example.invalid/_host/voice', { method: 'POST' }), env, access, networkFetch: t.fetch })
      expect(response.status).toBe(403)
      expect((await response.json()).code).toBe('OWNER_ACCESS_REQUIRED')
    }
    expect(t.seen).toEqual([])
  })

  it('refuses a request whose Origin is another site', async () => {
    const t = transport([])
    const env = { OWNER_EMAIL: 'owner@example.com', ELEVENLABS_VOICE_API_KEY: KEY, ELEVENLABS_X61_VOICE_RESOURCE_ID: RESOURCE }
    const access = { type: 'owner', email: 'owner@example.com' }

    const response = await handleProviderLimits({
      request: new Request('https://node.example.invalid/_host/voice', { method: 'POST', headers: { Origin: 'https://evil.test' } }),
      env,
      access,
      networkFetch: t.fetch,
    })

    // Either the owner judge refuses first (403 OWNER_ACCESS_REQUIRED) or the origin does; both are refusals, and
    // neither reaches the provider. Asserting the weaker of the two keeps this test honest about which gate fired.
    expect(response.status).toBe(403)
    expect(t.seen).toEqual([])
  })
})
