// Her working self's Claude calls leave by /door/anthropic/v1/messages with `output_config.effort`.
// The edge's request check (providerRequestReservation, run by the provider door before HEAD reserves anything) accepts
// exactly the five documented levels there, for each of her three Claude models, and still refuses what it refused.
// Her sixth choice, `auto` (her default), is the absence of a level: it leaves by the chat
// wire with no effort field, as before the effort build, and `auto` itself is refused as a field on either wire.
import assert from 'node:assert/strict'
import test from 'node:test'
import { providerRequestReservation } from '../provider-budget.mjs'

const LIMITS = Object.freeze({ windowMs: 60000, requests: 1000, tokens: 50000000, maxOutputTokens: 256000 })
const MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5']
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']
const bytes = body => new TextEncoder().encode(JSON.stringify(body))
const messages = (model, extra) => ({ model, max_tokens: 8192, stream: true, system: 'rules',
  messages: [{ role: 'user', content: 'hello' }], ...extra })
const refusedWith = (body, path, code) => assert.throws(() => providerRequestReservation(bytes(body), LIMITS, path), error => error.code === code)

test('the messages wire accepts each of the five levels for each of her Claude models', () => {
  for (const model of MODELS) for (const effort of FIVE) {
    const reservation = providerRequestReservation(bytes(messages(model, { output_config: { effort } })), LIMITS, '/v1/messages')
    assert.equal(reservation.requestedModel, model)
    assert.equal(reservation.outputTokens, 8192)
  }
})

test('a sixth level, a wrong case, an empty or an extra field is refused before anything is reserved', () => {
  for (const output_config of [{ effort: 'minimal' }, { effort: 'off' }, { effort: 'auto' }, { effort: 'MAX' }, { effort: '' }, { effort: 30 }, {},
    { effort: 'high', task_budget: { type: 'tokens', total: 20000 } }, 'high', null]) {
    refusedWith(messages('claude-fable-5-2', { output_config }), '/v1/messages', 'PROVIDER_REQUEST_SHAPE_UNSUPPORTED')
  }
})

test('the chat wire still carries no effort field of any spelling', () => {
  const chat = extra => ({ model: 'claude-fable-5-2', max_tokens: 8192, stream: true, messages: [{ role: 'user', content: 'hello' }], ...extra })
  assert.equal(providerRequestReservation(bytes(chat({})), LIMITS, '/v1/chat/completions').requestedModel, 'claude-fable-5-2')
  for (const extra of [{ output_config: { effort: 'high' } }, { output_config: { effort: 'auto' } }, { reasoning_effort: 'high' },
    { reasoning_effort: 'auto' }, { reasoning: { effort: 'high' } }]) {
    refusedWith(chat(extra), '/v1/chat/completions', 'PROVIDER_REQUEST_SHAPE_UNSUPPORTED')
  }
})

test('auto: her Claude models leave by the chat wire with no effort field, at the room she asked before', () => {
  for (const model of MODELS) {
    const body = { model, messages: [{ role: 'user', content: 'hello' }], stream: true, max_tokens: 128000 }
    const reservation = providerRequestReservation(bytes(body), LIMITS, '/v1/chat/completions')
    assert.equal(reservation.requestedModel, model)
    assert.equal(reservation.outputTokens, 128000)
  }
})

test('no level raises the output ceiling: a room above PROVIDER_MAX_OUTPUT_TOKENS is still refused', () => {
  refusedWith(messages('claude-fable-5-2', { max_tokens: LIMITS.maxOutputTokens + 1, output_config: { effort: 'max' } }), '/v1/messages', 'PROVIDER_OUTPUT_LIMIT_REQUIRED')
})
