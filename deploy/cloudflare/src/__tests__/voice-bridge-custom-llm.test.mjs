/** The Custom LLM fallback adapter: a tested skeleton that refuses. Its turn identity (conversation, user-message count
 * and hash), supersession, streaming framing and fixed refusal; it is not routed (voice-bridge-provider-door.test.mjs). */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CUSTOM_LLM_ADAPTER, CUSTOM_LLM_CONVERSATION_HEADER, CUSTOM_LLM_READY } from '../voice-provider-custom-llm.mjs'

const headers = conv => new Headers(conv === null ? {} : { [CUSTOM_LLM_CONVERSATION_HEADER]: conv })
const body = (...users) => JSON.stringify({ model: 'auma-voice-home', stream: true, messages: [{ role: 'system', content: 'ignored' }, ...users.flatMap(text => [{ role: 'user', content: text }, { role: 'assistant', content: 'reply' }])] })

test('turn identity: the conversation header, the count of user messages as the event id, and a hash of them', async () => {
  const one = await CUSTOM_LLM_ADAPTER.toBridgeEvents(body('hello'), headers('conv_1'))
  // the voice fix A (CHANGED): the transcript event also says the history's shape (its last message is hers, one is his).
  assert.deepEqual(one.events, [{ kind: 'init', conv: 'conv_1' }, { kind: 'transcript', eventId: 1, text: 'hello', tail: 'agent', users: 1 }])
  assert.match(one.hash, /^[0-9a-f]{64}$/)
  const retry = await CUSTOM_LLM_ADAPTER.toBridgeEvents(body('hello'), headers('conv_1'))
  assert.equal(retry.hash, one.hash)
  assert.equal(CUSTOM_LLM_ADAPTER.supersedes(retry, one), false)
  const two = await CUSTOM_LLM_ADAPTER.toBridgeEvents(body('hello', 'and then?'), headers('conv_1'))
  assert.deepEqual(two.events[1], { kind: 'transcript', eventId: 2, text: 'and then?', tail: 'agent', users: 2 })
  assert.equal(CUSTOM_LLM_ADAPTER.supersedes(two, one), true)
  assert.equal(CUSTOM_LLM_ADAPTER.supersedes(await CUSTOM_LLM_ADAPTER.toBridgeEvents(body('hello', 'x'), headers('conv_2')), one), false)
})

test('closed shapes: no conversation header, a bad id, no stream, no user message, another role or an oversized body is refused', async () => {
  for (const [text, conv] of [[body('x'), null], [body('x'), 'conv/../1'], [JSON.stringify({ stream: false, messages: [{ role: 'user', content: 'x' }] }), 'conv_1'],
    [JSON.stringify({ stream: true, messages: [{ role: 'system', content: 'x' }] }), 'conv_1'], [JSON.stringify({ stream: true, messages: [{ role: 'tool', content: 'x' }] }), 'conv_1'],
    ['{', 'conv_1'], [JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x'.repeat(262144) }] }), 'conv_1']]) {
    assert.equal(await CUSTOM_LLM_ADAPTER.toBridgeEvents(text, headers(conv)), null, text.slice(0, 60))
  }
})

test('the streaming framing and the refusal it answers until it is finished', async () => {
  assert.equal(CUSTOM_LLM_READY, false)
  assert.equal(CUSTOM_LLM_ADAPTER.chunk(1, 'Hi. '), 'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi. "},"finish_reason":null}]}\n\n')
  assert.ok(CUSTOM_LLM_ADAPTER.final(1).endsWith('data: [DONE]\n\n'))
  const refusal = CUSTOM_LLM_ADAPTER.refuse()
  assert.deepEqual([refusal.status, await refusal.json()], [503, { ok: false, code: 'VOICE_ADAPTER_UNAVAILABLE' }])
})
