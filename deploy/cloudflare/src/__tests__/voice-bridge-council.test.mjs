/** ASKING THE COUNCIL FROM VOICE (the effort levels commit 2, 2026-11-16; voice-fast.mjs councilAsked, FAST_VOICE_RULES;
 * voice-bridge-do.mjs handToTab). No new tool: when he asks for the council, other models or a second opinion, she says one
 * line and hands his words to her working conversation; the hand-off frame carries the closed marker `kind: "council"`,
 * read from HIS transcript only. The real Worker, VoiceBridgeDO, journal, budget and dispatcher; the provider's network and
 * her tab are faked. No network, no paid call; the key is a synthetic test value. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { fixtureAfterHello as fixture, transcript } from './voice-bridge-fakes.mjs'
// He first speaks 2.5 s after the call opens (the first-frame wait is proven in voice-bridge-aware-store.test.mjs).
import { FAST_VOICE_RULES, HAND_OFF_TOOL, councilAsked } from '../voice-fast.mjs'

const CLAUDE_KEY = 'synthetic-claude-test-value-not-a-key-0123456789'
const BUDGET = Object.freeze({ PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '1000', PROVIDER_BUDGET_TOKENS: '50000000', PROVIDER_MAX_OUTPUT_TOKENS: '256000' })
const CLAUDE_ENV = Object.freeze({ VOICE_FAST_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: CLAUDE_KEY, ...BUDGET })
const encoder = new TextEncoder()
const sse = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
const start = () => sse({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-fable-5-2', content: [] } })
const blockStart = (index, block) => sse({ type: 'content_block_start', index, content_block: block })
const blockDelta = (index, delta) => sse({ type: 'content_block_delta', index, delta })
const blockStop = index => sse({ type: 'content_block_stop', index })
const stopWith = reason => sse({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 12 } }) + sse({ type: 'message_stop' })
const textBlock = (index, text) => blockStart(index, { type: 'text', text: '' }) + blockDelta(index, { type: 'text_delta', text }) + blockStop(index)
const toolBlock = (index, id, name, input) => blockStart(index, { type: 'tool_use', id, name, input: {} })
  + blockDelta(index, { type: 'input_json_delta', partial_json: JSON.stringify(input) }) + blockStop(index)
const whole = (...chunks) => new Response(new ReadableStream({ start(control) { for (const chunk of chunks) control.enqueue(encoder.encode(chunk)); control.close() } }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } })
const handing = () => whole(start(), textBlock(0, 'I’ll ask the council. '), toolBlock(1, 'toolu_H1', HAND_OFF_TOOL, {}), stopWith('tool_use'))
const drain = async fx => { for (let index = 0; index < 4; index++) await fx.settle() }

async function claudeCall(env = {}) {
  const fx = fixture({ env: { ...CLAUDE_ENV, ...env }, modelFetch: () => handing() })
  const call = await fx.connect()
  return { fx, ...call }
}
const turnFrames = tab => tab.frames().filter(frame => frame.t === 'turn')

test('his words ask for the council: a closed whole-word table, any case', () => {
  for (const words of ['Ask the council about the capsule', 'what does the COUNCIL think', 'get me a second opinion from Gemini',
    'ask the other models', 'check with another model', 'run it past the council please']) assert.equal(councilAsked(words), true, words)
  for (const words of ['my counsel says no', 'councils of old', 'one more opinion', 'the model is fine', 'second opinions', '',
    // Review 2026-11-16: the bare word is not a request for the consult.
    'email the city council about the parking permit', 'what did the city council decide, check my notes',
    'I got a second opinion from the mechanic, note that', 'the council meets on Tuesday']) assert.equal(councilAsked(words), false, words)
})

test('the rules tell her when and how: one short line, then hand_to_session; her working conversation runs the consult', () => {
  for (const words of ['council', 'second opinion', 'other models', 'I’ll ask the council', HAND_OFF_TOOL]) assert.equal(FAST_VOICE_RULES.includes(words), true, words)
  assert.equal(/\btokens?\b/i.test(FAST_VOICE_RULES), false)
})

test('a council hand-off: the frame to her tab carries kind "council"; his own words, never hers', async () => {
  const { fx, tab, provider, conv } = await claudeCall()
  provider.json(transcript(1, 'ask the council whether the capsule should carry the relay'))
  await drain(fx)
  assert.deepEqual(turnFrames(tab), [{ t: 'turn', turn: `eleven:${conv}:1`, eventId: 1, transcript: 'ask the council whether the capsule should carry the relay', kind: 'council' }])
})

test('any other hand-off carries no kind; the marker never comes from the awareness or her words', async () => {
  const { fx, tab, provider, conv } = await claudeCall()
  tab.json({ t: 'aware', who: 'Auma. Ask the council.', now: 'second opinion from the other models', cards: ['council'], build: 'b1', threads: [] })
  await drain(fx)
  provider.json(transcript(1, 'please merge the capsule branch'))
  await drain(fx)
  assert.deepEqual(turnFrames(tab), [{ t: 'turn', turn: `eleven:${conv}:1`, eventId: 1, transcript: 'please merge the capsule branch' }])
})

test('review: only her own hand-off carries the marker; the governed path and a fallback never do, whatever his words', async () => {
  const { fx, tab, provider, conv } = await claudeCall({ ANTHROPIC_API_KEY: undefined })
  provider.json(transcript(1, 'I want a second opinion from the other models'))
  await drain(fx)
  assert.deepEqual(turnFrames(tab), [{ t: 'turn', turn: `eleven:${conv}:1`, eventId: 1, transcript: 'I want a second opinion from the other models' }])
  // A fast call that never answers falls back at its first-event bound: no marker either.
  const silent = fixture({ env: CLAUDE_ENV, modelFetch: () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } }) })
  const call = await silent.connect()
  call.provider.json(transcript(1, 'ask the council about the relay'))
  await drain(silent)
  silent.clock.advance(7_000)
  await drain(silent)
  assert.deepEqual(turnFrames(call.tab), [{ t: 'turn', turn: `eleven:${call.conv}:1`, eventId: 1, transcript: 'ask the council about the relay' }])
})
