/**
 * Round 35: Auma's new hands, as the worker exposes them. Her safety gate lets the new reads through (`x6_repo`
 * selftest and tree, `x6_github` GETs) and one narrow GitHub write (an issue or an issue comment on this repository),
 * and keeps every other GitHub call owner-only; `x6_consult` asks one model or a council through the host's doors.
 */
import { describe, expect, it } from 'vitest'
import { classifyActionIrreversibility, consultProviders, CONSULT_LIMITS } from '../../src/x6/ball-loader.ts'

const ORIGIN = 'https://x61.example.invalid'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('the worker safety gate for the Round 35 hands', () => {
  it('x6_repo selftest, diagnostics, tree, read, bytes and state_diff are reads; write, push and exec are not', () => {
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'selftest' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'diagnostics' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'tree', path: 'deploy/' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'read', path: 'server/aura-rules.mjs' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'bytes', path: 'package.json', offset: 0, length: 64 })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'state_diff' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'write', path: 'server/aura-rules.mjs' })).toBe(1)
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'push' })).toBe(3)
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'exec', command: 'ls' })).toBe(3)
  })
  it('x6_github: a plain GET of this repository is a read; an issue or a comment on this repository is a reversible write', () => {
    const api = (more: Record<string, unknown>) => classifyActionIrreversibility({ tool: 'x6_github', action: 'api', ...more })
    expect(classifyActionIrreversibility({ tool: 'x6_github', action: 'status' })).toBe(0)
    expect(api({ endpoint: 'repos/your_org_x/your-node/commits' })).toBe(0)
    expect(api({ method: 'GET', endpoint: '/repos/your_org_x/your-node/issues/1' })).toBe(0)
    expect(api({ method: 'GET', endpoint: 'repos/your_org_x/your-node/issues?state=open' })).toBe(0)
    expect(api({ method: 'POST', endpoint: 'repos/your_org_x/your-node/issues/1/comments', body: { body: 'Round 35 report: 17/17 green.' } })).toBe(1)
    expect(api({ method: 'post', endpoint: '/repos/your_org_x/your-node/issues', body: { title: 'Seam found', body: 'Details.' } })).toBe(1)
  })
  it('x6_github: everything else stays owner-only, including a write dressed as a read and a comment that runs a command', () => {
    const api = (more: Record<string, unknown>) => classifyActionIrreversibility({ tool: 'x6_github', action: 'api', ...more })
    const comment = 'repos/your_org_x/your-node/issues/1/comments'
    for (const [label, more] of [
      ['no method, with a body', { endpoint: 'repos/your_org_x/your-node/pulls', body: { title: 'x' } }],
      ['graphql', { endpoint: 'graphql', body: { query: 'mutation { deleteRef }' } }],
      ['graphql read', { endpoint: 'graphql' }],
      ['another repository', { endpoint: 'repos/your_org_x/another-repository/commits' }],
      ['encoded step', { endpoint: 'repos/your_org_x/your-node/%2e%2e/x' }],
      ['cli args on api', { endpoint: 'repos/your_org_x/your-node/commits', args: ['-X', 'DELETE'] }],
      ['a PR approval command', { method: 'POST', endpoint: comment, body: { body: '/delegate @someone' } }],
      ['a mention', { method: 'POST', endpoint: comment, body: { body: 'cc @owner please look' } }],
      ['extra keys', { method: 'POST', endpoint: comment, body: { body: 'ok', labels: ['x'] } }],
      ['an issue with assignees', { method: 'POST', endpoint: 'repos/your_org_x/your-node/issues', body: { title: 't', assignees: ['x'] } }],
      ['empty comment', { method: 'POST', endpoint: comment, body: { body: '  ' } }],
      ['another repository write', { method: 'POST', endpoint: 'repos/your_org_x/another-repository/issues/1/comments', body: { body: 'x' } }],
      ['a query on a write', { method: 'POST', endpoint: comment + '?x=1', body: { body: 'x' } }],
      ['a pull request', { method: 'POST', endpoint: 'repos/your_org_x/your-node/pulls', body: { title: 'x' } }],
      ['a ref', { method: 'POST', endpoint: 'repos/your_org_x/your-node/git/refs', body: { ref: 'x' } }],
      ['an edit', { method: 'PATCH', endpoint: 'repos/your_org_x/your-node/issues/1', body: { body: 'x' } }],
      ['a delete', { method: 'DELETE', endpoint: 'repos/your_org_x/your-node/issues/comments/9' }],
      ['a file write', { method: 'PUT', endpoint: 'repos/your_org_x/your-node/contents/server/x.mjs', body: { content: 'x' } }],
      ['no endpoint', { method: 'POST', endpoint: '', body: { body: 'x' } }],
    ] as const) expect([label, api(more)]).toEqual([label, 3])
    expect(classifyActionIrreversibility({ tool: 'x6_github', action: 'cli', args: ['issue', 'comment', '1'] })).toBe(3)
    expect(classifyActionIrreversibility({ tool: 'x6_cloudflare', action: 'wrangler' })).toBe(3)
  })
})

describe('x6_consult: one model or a council, through the host doors', () => {
  it('a single Anthropic target goes to the anthropic door on the worker origin, same-origin, and its text comes back', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return json({ content: [{ type: 'text', text: 'Hello ' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'the owner' }] })
    }) as unknown as typeof fetch
    const result = await consultProviders({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'Review this.', system: 'Be brief.' },
      { origin: ORIGIN, fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.answers?.[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', ok: true, status: 200, text: 'Hello the owner', code: null })
    expect(calls[0]?.url).toBe(`${ORIGIN}/door/anthropic/v1/messages`)
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ model: 'claude-opus-5-5', max_tokens: 2048, system: 'Be brief.',
      messages: [{ role: 'user', content: 'Review this.' }] })
  })
  it('takes the composer pill names: each picks its door and the exact id the pill runs; a raw id still needs its provider', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return url.endsWith('/v1/messages') ? json({ content: [{ type: 'text', text: 'ok' }] }) : json({ choices: [{ message: { content: 'ok' } }] })
    }) as unknown as typeof fetch
    const result = await consultProviders({ prompt: 'Hi', targets: [
      { model: 'Opus 5.5' }, { model: 'fable-5.2' }, { model: 'GPT-6.1 SOL', role: 'critic' }, { model: 'Grok 4.7' }, { model: ' Gemini  Argon ' },
    ] }, { origin: ORIGIN, fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.answers?.map(answer => [answer.provider, answer.model, answer.role])).toEqual([
      ['anthropic', 'claude-opus-5-5', null], ['anthropic', 'claude-fable-5-2', null], ['openrouter', 'openai/gpt-6.1-sol', 'critic'],
      ['openrouter', 'x-ai/grok-4.7', null], ['openrouter', 'google/gemini-4-argon', null],
    ])
    expect(calls.map(call => [call.url.slice(ORIGIN.length), call.body.model])).toEqual([
      ['/door/anthropic/v1/messages', 'claude-opus-5-5'], ['/door/anthropic/v1/messages', 'claude-fable-5-2'],
      ['/door/openrouter/v1/chat/completions', 'openai/gpt-6.1-sol'], ['/door/openrouter/v1/chat/completions', 'x-ai/grok-4.7'],
      ['/door/openrouter/v1/chat/completions', 'google/gemini-4-argon'],
    ])
    expect(await consultProviders({ prompt: 'Hi', model: 'x-ai/grok-4.7' }, { origin: ORIGIN, fetchImpl })).toEqual({ ok: false, code: 'CONSULT_PROVIDER_UNKNOWN' })
    // A provider she names is kept: xAI's own grok-4.7 goes to the xAI door, not OpenRouter's.
    calls.length = 0
    const named = await consultProviders({ prompt: 'Hi', provider: 'xai', model: 'grok-4.7' }, { origin: ORIGIN, fetchImpl })
    expect(named.answers?.map(answer => [answer.provider, answer.model])).toEqual([['xai', 'grok-4.7']])
    expect(calls.map(call => call.url.slice(ORIGIN.length))).toEqual(['/door/xai/v1/chat/completions'])
  })
  it('a council runs in parallel: each answer with its role and latency; a refusal or a timeout never stops the others', async () => {
    let clock = 0
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      clock += 10
      const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string }> }
      if (url.includes('/door/xai/')) return json({ ok: false, code: 'PROVIDER_SECRET_NOT_CONFIGURED' }, 503)
      if (body.model === 'slow/model') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      expect(url.endsWith('/v1/chat/completions')).toBe(true)
      return json({ choices: [{ message: { role: 'assistant', content: `${body.model}: ${body.messages[0]?.content ?? ''}` } }] })
    }) as unknown as typeof fetch
    const result = await consultProviders({
      targets: [
        { provider: 'openrouter', model: 'x-ai/grok-4', role: 'red team' },
        { provider: 'xai', model: 'grok-4' },
        { provider: 'openrouter', model: 'slow/model' },
      ],
      prompt: 'Find the flaw.', system: 'You review designs.',
    }, { origin: ORIGIN, fetchImpl, now: () => clock })
    expect(result.ok).toBe(true)
    expect(result.answers?.map(a => [a.provider, a.model, a.role, a.ok, a.code])).toEqual([
      ['openrouter', 'x-ai/grok-4', 'red team', true, null],
      ['xai', 'grok-4', null, false, 'PROVIDER_SECRET_NOT_CONFIGURED'],
      ['openrouter', 'slow/model', null, false, 'CONSULT_TIMEOUT'],
    ])
    // The role reaches that model as part of its system prompt; the others get the shared system prompt alone.
    expect(result.answers?.[0]?.text).toBe('x-ai/grok-4: You review designs.\n\nYour role in this council: red team.')
  })
  it('refuses a malformed request before any door is asked, and caps what comes back', async () => {
    let asked = 0
    const fetchImpl = (async () => { asked += 1; return json({ choices: [{ message: { content: 'x'.repeat(CONSULT_LIMITS.answerChars + 5) } }] }) }) as unknown as typeof fetch
    const bad = [
      [{ provider: 'anthropic', model: 'm', prompt: '' }, 'CONSULT_PROMPT_INVALID'],
      [{ provider: 'mystery', model: 'm', prompt: 'p' }, 'CONSULT_PROVIDER_UNKNOWN'],
      [{ provider: 'openai', model: 'bad model!', prompt: 'p' }, 'CONSULT_MODEL_INVALID'],
      [{ provider: 'openai', model: 'm', prompt: 'p', maxTokens: 999_999 }, 'CONSULT_MAX_TOKENS_INVALID'],
      [{ provider: 'openai', model: 'm', prompt: 'p', timeoutMs: 10 }, 'CONSULT_TIMEOUT_INVALID'],
      [{ targets: Array.from({ length: 7 }, () => ({ provider: 'openai', model: 'm' })), prompt: 'p' }, 'CONSULT_TARGETS_INVALID'],
      [{ provider: 'openai', model: 'm', prompt: 'x'.repeat(CONSULT_LIMITS.promptChars + 1) }, 'CONSULT_PROMPT_INVALID'],
    ] as const
    for (const [input, code] of bad) expect(await consultProviders(input, { origin: ORIGIN, fetchImpl })).toEqual({ ok: false, code })
    expect(await consultProviders({ provider: 'openai', model: 'm', prompt: 'p' }, { origin: undefined, fetchImpl })).toEqual({ ok: false, code: 'CONSULT_ORIGIN_UNAVAILABLE' })
    expect(asked).toBe(0)
    const long = await consultProviders({ provider: 'openai', model: 'gpt-x', prompt: 'p' }, { origin: ORIGIN, fetchImpl })
    expect(long.answers?.[0]).toMatchObject({ ok: true, truncated: true })
    expect(long.answers?.[0]?.text).toHaveLength(CONSULT_LIMITS.answerChars)
  })
  it('speaks each provider\'s wire: OpenAI takes max_completion_tokens; a provider stop at the cap is a cut-off; its refusal is said', async () => {
    const bodies: Record<string, Record<string, unknown>> = {}
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const provider = url.split('/door/')[1]?.split('/')[0] ?? ''
      bodies[provider] = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (provider === 'deepseek') return json({ error: { type: 'invalid_request_error', message: 'Incorrect API key sk-abcdefghijklmnop provided' } }, 401)
      if (provider === 'openrouter') return json({ choices: [{ message: { content: '   ' } }] })
      if (provider === 'anthropic') return json({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Half an answ' }] })
      return json({ choices: [{ finish_reason: 'length', message: { content: 'Cut' } }] })
    }) as unknown as typeof fetch
    const result = await consultProviders({ targets: [
      { provider: 'openai', model: 'o-model' }, { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'openrouter', model: 'x/y' }, { provider: 'anthropic', model: 'claude-opus-5-5' },
    ], prompt: 'p', maxTokens: 64 }, { origin: ORIGIN, fetchImpl })
    expect(bodies.openai).toMatchObject({ max_completion_tokens: 64 })
    expect(bodies.openai).not.toHaveProperty('max_tokens')
    expect(bodies.deepseek).toMatchObject({ max_tokens: 64 })
    const [openai, deepseek, openrouter, anthropic] = result.answers ?? []
    expect([openai?.ok, openai?.truncated, openai?.text]).toEqual([true, true, 'Cut'])
    expect([anthropic?.ok, anthropic?.truncated]).toEqual([true, true])
    expect([openrouter?.ok, openrouter?.code]).toEqual([false, 'CONSULT_ANSWER_EMPTY'])
    expect([deepseek?.ok, deepseek?.code]).toEqual([false, 'HTTP_401'])
    expect(deepseek?.detail).toBe('invalid_request_error: Incorrect API key [masked] provided')
  })
})

describe('consult parent cancellation', () => {
  it('gives every council and fallback attempt a distinct id under one captured parent', async () => {
    const headers: Headers[] = []
    const fetchImpl: typeof fetch = async (resource, init) => {
      headers.push(new Headers(init?.headers))
      if (String(resource).includes('/anthropic/')) return json({ code: 'PROVIDER_SECRET_NOT_CONFIGURED' }, 503)
      return json({ choices: [{ message: { content: 'synthetic' } }] })
    }
    const out = await consultProviders({ prompt: 'synthetic', targets: [
      { provider: 'anthropic', model: 'claude-opus' }, { provider: 'deepseek', model: 'deepseek-chat' },
    ] }, { origin: ORIGIN, parentTurnId: 'parent-A', signal: new AbortController().signal, fetchImpl })
    expect(out.ok).toBe(true)
    expect(headers).toHaveLength(3)
    expect(headers.every(header => header.get('x-x6-turn-id') === 'parent-A')).toBe(true)
    expect(new Set(headers.map(header => header.get('x-x6-request-id'))).size).toBe(3)
  })

  it('cancels during body consumption and never starts a fallback after cancellation', async () => {
    const abort = new AbortController()
    let calls = 0
    const fetchImpl: typeof fetch = async (_resource, init) => {
      calls++
      expect(init?.signal?.aborted).toBe(false)
      const response = json({ code: 'PROVIDER_SECRET_NOT_CONFIGURED' }, 503)
      response.json = async () => { abort.abort(); return { code: 'PROVIDER_SECRET_NOT_CONFIGURED' } }
      return response
    }
    const result = await consultProviders({ provider: 'anthropic', model: 'claude-opus', prompt: 'synthetic' },
      { origin: ORIGIN, parentTurnId: 'parent-A', signal: abort.signal, fetchImpl })
    expect(result.answers?.[0]).toMatchObject({ ok: false, code: 'CONSULT_CANCELLED', text: null })
    expect(calls).toBe(1)
    await consultProviders({ provider: 'anthropic', model: 'claude-opus', prompt: 'synthetic' },
      { origin: ORIGIN, parentTurnId: 'parent-A', signal: abort.signal, fetchImpl })
    expect(calls).toBe(1)
  })

  it('forwards caller abort to pending fetches and discards late successful bodies', async () => {
    const abort = new AbortController()
    let providerSignal: AbortSignal | null | undefined
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const fetchImpl: typeof fetch = async (_resource, init) => {
      providerSignal = init?.signal
      await wait
      return json({ choices: [{ message: { content: 'must not escape' } }] })
    }
    const pending = consultProviders({ provider: 'deepseek', model: 'deepseek-chat', prompt: 'synthetic' },
      { origin: ORIGIN, parentTurnId: 'parent-A', signal: abort.signal, fetchImpl })
    abort.abort()
    expect(providerSignal?.aborted).toBe(true)
    release()
    expect((await pending).answers?.[0]).toMatchObject({ ok: false, code: 'CONSULT_CANCELLED', text: null })
  })

  it('suppresses already-completed council members when the parent is cancelled before the council returns', async () => {
    const abort = new AbortController(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const fetchImpl: typeof fetch = async (resource) => {
      if (String(resource).includes('/deepseek/')) { entered.resolve(undefined); await release.promise }
      return json({ choices: [{ message: { content: 'must not escape' } }] })
    }
    const pending = consultProviders({ prompt: 'synthetic', targets: [
      { provider: 'openrouter', model: 'reviewer' }, { provider: 'deepseek', model: 'deepseek-chat' },
    ] }, { origin: ORIGIN, parentTurnId: 'parent-A', signal: abort.signal, fetchImpl })
    await entered.promise
    abort.abort()
    release.resolve(undefined)
    const result = await pending
    expect(result).toMatchObject({ ok: false, answers: [
      { ok: false, text: null, code: 'CONSULT_CANCELLED' }, { ok: false, text: null, code: 'CONSULT_CANCELLED' },
    ] })
  })

  it('forwards abort into an active fallback and never starts the next fallback', async () => {
    const abort = new AbortController()
    const seen: Headers[] = []
    const fetchImpl: typeof fetch = async (_resource, init) => {
      seen.push(new Headers(init?.headers))
      if (seen.length === 1) return json({ code: 'PROVIDER_SECRET_NOT_CONFIGURED' }, 503)
      abort.abort()
      expect(init?.signal?.aborted).toBe(true)
      return json({ choices: [{ message: { content: 'late fallback' } }] })
    }
    const result = await consultProviders({ provider: 'anthropic', model: 'claude-opus', prompt: 'synthetic' },
      { origin: ORIGIN, parentTurnId: 'parent-A', signal: abort.signal, fetchImpl })
    expect(result.answers?.[0]).toMatchObject({ ok: false, text: null, code: 'CONSULT_CANCELLED' })
    expect(seen).toHaveLength(2)
    expect(seen.every(headers => headers.get('x-x6-turn-id') === 'parent-A')).toBe(true)
    expect(new Set(seen.map(headers => headers.get('x-x6-request-id'))).size).toBe(2)
  })

})
