// The edge lets a cache mark through, and only a real one. The provider's reference
// (claude-api shared/prompt-caching.md, "API reference", lines 122-128) gives the two values, `{ "type": "ephemeral" }`
// and the same with `"ttl": "1h"` (the 5-minute default may be named `"5m"`), and the blocks that may carry one:
// system text blocks, tool definitions, and message content blocks (text, image, tool_use, tool_result, document).
// This edge accepts the mark on text blocks, tool definitions, tool_use and tool_result blocks, checks its value
// everywhere, and still refuses it on a thinking or image block, at the top level, or with any other value.
import assert from 'node:assert/strict'
import test from 'node:test'
import { providerRequestReservation } from '../provider-budget.mjs'

const LIMITS = Object.freeze({ windowMs: 60000, requests: 1000, tokens: 50000000, maxOutputTokens: 256000 })
const PATH = '/v1/messages'
const bytes = body => new TextEncoder().encode(JSON.stringify(body))
const accepted = body => assert.equal(providerRequestReservation(bytes(body), LIMITS, PATH).requestedModel, 'claude-fable-5-2')
const refused = (body, why) => assert.throws(() => providerRequestReservation(bytes(body), LIMITS, PATH),
  error => error.code === 'PROVIDER_REQUEST_SHAPE_UNSUPPORTED', why)

const GOOD = [{ type: 'ephemeral' }, { type: 'ephemeral', ttl: '5m' }, { type: 'ephemeral', ttl: '1h' }]
const BAD = [{}, { type: 'persistent' }, { type: 'ephemeral', ttl: '10m' }, { type: 'ephemeral', ttl: 3600 }, { type: 'ephemeral', ttl: null },
  { type: 'ephemeral', scope: 'global' }, { type: 'EPHEMERAL' }, 'ephemeral', true, null, []]

const TOOL = { name: 'read_file', description: 'Read a file.', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }
/** One agent step on the Messages wire: system, tools, a tool call and its result; `mark` lands where `at` says. */
function step(at, mark) {
  const put = (where, block) => (at === where ? { ...block, cache_control: mark } : block)
  return {
    model: 'claude-fable-5-2', max_tokens: 8192, stream: true,
    system: [put('system', { type: 'text', text: 'rules' })],
    tools: [put('tool', TOOL)],
    messages: [
      { role: 'user', content: [put('text', { type: 'text', text: 'read it' })] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'look first', signature: 'sig-1' },
        put('tool_use', { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.md' } }),
      ] },
      { role: 'user', content: [
        put('tool_result', { type: 'tool_result', tool_use_id: 'toolu_1', content: 'the file' }),
      ] },
      { role: 'user', content: [put('inner', { type: 'tool_result', tool_use_id: 'toolu_2', content: [put('inner_text', { type: 'text', text: 'two' })] })] },
    ],
  }
}

test('a real mark is accepted on system text, a tool definition, message text, tool_use and tool_result blocks', () => {
  accepted(step('none'))
  for (const at of ['system', 'tool', 'text', 'tool_use', 'tool_result', 'inner_text']) {
    for (const mark of GOOD) accepted(step(at, mark))
  }
})

test('any other value is refused wherever a mark may stand', () => {
  for (const at of ['system', 'tool', 'text', 'tool_use', 'tool_result', 'inner_text']) {
    for (const mark of BAD) refused(step(at, mark), `${at}: ${JSON.stringify(mark)}`)
  }
})

test('a mark on a thinking or image block, or a top-level mark, is still refused', () => {
  for (const mark of GOOD) {
    const thinking = step('none')
    thinking.messages[1].content[0] = { ...thinking.messages[1].content[0], cache_control: mark }
    refused(thinking, 'thinking')
    const image = step('none')
    image.messages[0].content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, cache_control: mark })
    refused(image, 'image')
    refused({ ...step('none'), cache_control: mark }, 'top level')
  }
})

test('the chat wire still carries no mark anywhere', () => {
  const chat = { model: 'claude-fable-5-2', max_tokens: 8192, stream: true, messages: [{ role: 'user', content: 'hello', cache_control: { type: 'ephemeral' } }] }
  assert.throws(() => providerRequestReservation(bytes(chat), LIMITS, '/v1/chat/completions'), error => error.code === 'PROVIDER_REQUEST_SHAPE_UNSUPPORTED')
})
