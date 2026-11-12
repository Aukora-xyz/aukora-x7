/** The cloud model door. Stub transport only: no live provider is ever called. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { callCloudModel, pickCloudModelProvider, cloudModelDoorStatus, toAnthropicMessages, CLOUD_MODEL_DOOR_LIMITS } from '../cloud-model-door.mjs'

const KEY = 'sk-ant-api03-FIXTURE-not-a-real-key-0123456789'
const OR_KEY = 'sk-or-v1-FIXTURE-not-a-real-key-0123456789'
const TOOLS = [{ type: 'function', function: { name: 'inspectHeadWish', description: 'Inspect.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }]

function stub(reply) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const next = typeof reply === 'function' ? reply(calls.length) : reply
    if (next instanceof Error) throw next
    return next
  }
  return { calls, fetchImpl }
}
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
const leaks = (value, ...secrets) => secrets.some(secret => JSON.stringify(value).includes(secret))

test('a missing secret is refused by code before any network call', async () => {
  for (const provider of ['anthropic', 'openrouter', 'deepseek', 'openai']) {
    const t = stub(json({}))
    const out = await callCloudModel({ env: {}, provider, messages: [{ role: 'user', content: 'hi' }], fetchImpl: t.fetchImpl })
    assert.deepEqual(out, { ok: false, code: 'PROVIDER_SECRET_NOT_CONFIGURED', provider })
    assert.equal(t.calls.length, 0)
  }
  const unknown = await callCloudModel({ env: { ANTHROPIC_API_KEY: KEY }, provider: 'mystery', messages: [{ role: 'user', content: 'hi' }] })
  assert.deepEqual(unknown, { ok: false, code: 'PROVIDER_UNAVAILABLE' })
})

test('the picker chooses only among the providers it is handed, and reports presence by name only', () => {
  const env = { DEEPSEEK_API_KEY: 'sk-deepseek-FIXTURE-xxxxxxxx', OPENROUTER_API_KEY: OR_KEY }
  assert.deepEqual(pickCloudModelProvider(env, ['anthropic', 'openrouter', 'deepseek']), { ok: true, provider: 'openrouter' })
  assert.deepEqual(pickCloudModelProvider(env, ['anthropic']), { ok: false, code: 'PROVIDER_SECRET_NOT_CONFIGURED', tried: ['anthropic'] })
  assert.deepEqual(pickCloudModelProvider(env, ['nope']), { ok: false, code: 'PROVIDER_UNAVAILABLE' })
  const status = cloudModelDoorStatus(env)
  assert.deepEqual(status, { anthropic: false, openrouter: true, deepseek: true, openai: false })
  assert.equal(leaks(status, OR_KEY), false)
})

test('anthropic: a cap too small for thinking is refused unbilled; otherwise tools and messages go out as the Messages API', async () => {
  const t = stub(json({ id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_1', name: 'inspectHeadWish', input: {} }] }))
  const small = await callCloudModel({ env: { ANTHROPIC_API_KEY: KEY }, provider: 'anthropic', maxTokens: 400, tools: TOOLS,
    messages: [{ role: 'user', content: 'x' }], fetchImpl: t.fetchImpl })
  assert.deepEqual(small, { ok: false, code: 'PROVIDER_OUTPUT_LIMIT_TOO_SMALL', provider: 'anthropic' })
  assert.equal(t.calls.length, 0)
  const out = await callCloudModel({ env: { ANTHROPIC_API_KEY: KEY }, provider: 'anthropic', maxTokens: 2048, tools: TOOLS,
    messages: [{ role: 'system', content: 'You are Auma.' }, { role: 'user', content: '{"head":1}' }], fetchImpl: t.fetchImpl })
  const [call] = t.calls
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(call.init.redirect, 'manual')
  assert.equal(call.init.headers['x-api-key'], KEY)
  assert.equal(call.init.headers['anthropic-version'], '2023-06-01')
  assert.equal(call.init.headers.authorization, undefined)
  assert.deepEqual(call.body, {
    model: 'claude-opus-5-5', max_tokens: 2048, system: 'You are Auma.',
    messages: [{ role: 'user', content: [{ type: 'text', text: '{"head":1}' }] }],
    tools: [{ name: 'inspectHeadWish', description: 'Inspect.', input_schema: TOOLS[0].function.parameters }], tool_choice: { type: 'auto' },
  })
  assert.equal('temperature' in call.body, false)
  assert.equal(out.ok, true)
  assert.equal(out.message.content, 'Looking.')
  assert.deepEqual(out.message.tool_calls, [{ id: 'toolu_1', type: 'function', function: { name: 'inspectHeadWish', arguments: '{}' } }])
  assert.equal(out.stopReason, 'tool_use')
  assert.equal(leaks(out, KEY), false)
})

test('anthropic: the next round sends her own blocks back verbatim, thinking included, and tool results as one user turn', () => {
  const blocks = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name: 'a', input: {} }, { type: 'tool_use', id: 'toolu_2', name: 'b', input: {} }]
  const { system, messages } = toAnthropicMessages([
    { role: 'system', content: 'S' }, { role: 'user', content: 'U' },
    { role: 'assistant', content: null, tool_calls: [], anthropicContent: blocks },
    { role: 'tool', tool_call_id: 'toolu_1', content: '{"ok":true}' }, { role: 'tool', tool_call_id: 'toolu_2', content: '{"ok":false}' },
  ])
  assert.equal(system, 'S')
  assert.deepEqual(messages, [
    { role: 'user', content: [{ type: 'text', text: 'U' }] },
    { role: 'assistant', content: blocks },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }, { type: 'tool_result', tool_use_id: 'toolu_2', content: '{"ok":false}' }] },
  ])
})

test('anthropic: an OAuth subscription token goes on Authorization with its beta, never x-api-key', async () => {
  const token = 'sk-ant-oat01-FIXTURE-not-a-real-token'
  const t = stub(json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }))
  await callCloudModel({ env: { ANTHROPIC_API_KEY: `Bearer ${token}` }, provider: 'anthropic', messages: [{ role: 'user', content: 'hi' }], fetchImpl: t.fetchImpl })
  assert.equal(t.calls[0].init.headers.authorization, `Bearer ${token}`)
  assert.equal(t.calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20')
  assert.equal(t.calls[0].init.headers['x-api-key'], undefined)
})

test('anthropic: a refusal, and a reply cut off before any word, are refused by code', async () => {
  const env = { ANTHROPIC_API_KEY: KEY }
  const refused = await callCloudModel({ env, provider: 'anthropic', messages: [{ role: 'user', content: 'x' }],
    fetchImpl: stub(json({ content: [], stop_reason: 'refusal' })).fetchImpl })
  assert.deepEqual(refused, { ok: false, code: 'PROVIDER_REFUSED', provider: 'anthropic' })
  const cut = await callCloudModel({ env, provider: 'anthropic', messages: [{ role: 'user', content: 'x' }],
    fetchImpl: stub(json({ content: [{ type: 'thinking', thinking: '' }], stop_reason: 'max_tokens' })).fetchImpl })
  assert.deepEqual(cut, { ok: false, code: 'PROVIDER_OUTPUT_TRUNCATED', provider: 'anthropic' })
})

test('openrouter: needs a named model, then speaks the OpenAI shape with Bearer and drops replay-only fields', async () => {
  const messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'a', anthropicContent: [{ type: 'text', text: 'a' }] }, { role: 'user', content: 'again' }]
  const none = await callCloudModel({ env: { OPENROUTER_API_KEY: OR_KEY }, provider: 'openrouter', messages, fetchImpl: stub(json({})).fetchImpl })
  assert.deepEqual(none, { ok: false, code: 'PROVIDER_MODEL_NOT_CONFIGURED', provider: 'openrouter' })
  const t = stub(json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'inspectHeadWish', arguments: '{}' } }] } }] }))
  const out = await callCloudModel({ env: { OPENROUTER_API_KEY: OR_KEY, CLOUD_MODEL_OPENROUTER: 'vendor/model-x' }, provider: 'openrouter',
    messages, tools: TOOLS, maxTokens: 400, fetchImpl: t.fetchImpl })
  const [call] = t.calls
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(call.init.headers.authorization, `Bearer ${OR_KEY}`)
  assert.deepEqual(call.body, { model: 'vendor/model-x', stream: false, max_tokens: 400, tools: TOOLS, tool_choice: 'auto',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'again' }] })
  assert.equal(out.ok, true)
  assert.equal(out.message.tool_calls[0].id, 'call_1')
  assert.equal(leaks(out, OR_KEY), false)
})

test('a provider error is reported by status only: its body (which may quote the key) never travels', async () => {
  const body = { error: { message: `invalid x-api-key ${KEY}` } }
  const out = await callCloudModel({ env: { ANTHROPIC_API_KEY: KEY }, provider: 'anthropic', messages: [{ role: 'user', content: 'x' }],
    fetchImpl: stub(json(body, 401)).fetchImpl })
  assert.deepEqual(out, { ok: false, code: 'PROVIDER_AUTH_REFUSED', provider: 'anthropic', status: 401 })
  assert.equal(leaks(out, KEY), false)
  const limited = await callCloudModel({ env: { ANTHROPIC_API_KEY: KEY }, provider: 'anthropic', messages: [{ role: 'user', content: 'x' }],
    fetchImpl: stub(json({}, 429)).fetchImpl })
  assert.equal(limited.code, 'PROVIDER_RATE_LIMITED')
})

test('redirects are refused, oversized replies are refused, and a lost reply after dispatch is outcome-unknown', async () => {
  const env = { ANTHROPIC_API_KEY: KEY }
  const msg = [{ role: 'user', content: 'x' }]
  const moved = await callCloudModel({ env, provider: 'anthropic', messages: msg,
    fetchImpl: stub(new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } })).fetchImpl })
  assert.equal(moved.code, 'PROVIDER_REDIRECT_REFUSED')
  const huge = await callCloudModel({ env, provider: 'anthropic', messages: msg,
    fetchImpl: stub(new Response('x'.repeat(CLOUD_MODEL_DOOR_LIMITS.responseBytes + 1), { status: 200 })).fetchImpl })
  assert.equal(huge.code, 'PROVIDER_RESPONSE_TOO_LARGE')
  const lost = await callCloudModel({ env, provider: 'anthropic', messages: msg, fetchImpl: stub(new Error('socket hang up')).fetchImpl })
  assert.deepEqual(lost, { ok: false, code: 'PROVIDER_OUTCOME_UNKNOWN', provider: 'anthropic' })
})

test('a request over the byte cap is refused before dispatch, and an aborted caller is told so', async () => {
  const env = { ANTHROPIC_API_KEY: KEY }
  const t = stub(json({}))
  const big = await callCloudModel({ env, provider: 'anthropic', messages: [{ role: 'user', content: 'x'.repeat(CLOUD_MODEL_DOOR_LIMITS.requestBytes) }], fetchImpl: t.fetchImpl })
  assert.equal(big.code, 'PROVIDER_REQUEST_TOO_LARGE')
  assert.equal(t.calls.length, 0)
  const controller = new AbortController()
  controller.abort(new Error('stop'))
  const cancelled = await callCloudModel({ env, provider: 'anthropic', messages: [{ role: 'user', content: 'x' }], signal: controller.signal, fetchImpl: t.fetchImpl })
  assert.equal(cancelled.code, 'PROVIDER_CALL_CANCELLED')
  assert.equal(t.calls.length, 0)
})
