/** The status says why each turn ended and how long
 * each step took: closed codes and numbers only, the last 24 turns, the bridge's counts. The real Worker and VoiceBridgeDO
 * over the fakes; HEAD's real journal, budget and dispatcher; only the provider's network and her tab are faked. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { fixtureAfterHello as fixture, transcript } from './voice-bridge-fakes.mjs'
import { TURNS_KEPT } from '../voice-bridge-do.mjs'
import { VOICE_STATUS_COUNTS, VOICE_STATUS_TURNS, VOICE_TURN_OUTCOMES, VOICE_TURN_REASONS } from '../voice-bridge.mjs'
import { LOOK_TOOL } from '../voice-fast.mjs'

const FAST_ENV = Object.freeze({ DEEPSEEK_API_KEY: 'sk-synthetic-status-contract-0123456789', PROVIDER_BUDGET_WINDOW_MS: '60000',
  PROVIDER_BUDGET_REQUESTS: '1000', PROVIDER_BUDGET_TOKENS: '50000000', PROVIDER_MAX_OUTPUT_TOKENS: '256000' })
const encoder = new TextEncoder()
const data = value => `data: ${JSON.stringify(value)}\n\n`
const delta = text => data({ choices: [{ index: 0, delta: { content: text } }] })
const DONE = 'data: [DONE]\n\n'
const whole = (...chunks) => new Response(encoder.encode(chunks.join('')), { status: 200, headers: { 'content-type': 'text/event-stream' } })
const lookCall = args => data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'm0', type: 'function', function: { name: LOOK_TOOL, arguments: args } }] } }] })
  + data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
const drain = async fx => { for (let index = 0; index < 4; index++) await fx.settle() }
const statusOf = async fx => (await fx.ownerDoor({ body: { action: 'managed_status' } })).json()
const SECRET_WORDS = ['what is the plan', 'the plan is green', 'tell me everything', 'x6_threads', 'PRIVATE-RESULT']

async function call(answers) {
  let n = 0
  const fx = fixture({ env: FAST_ENV, modelFetch: () => { const next = answers[Math.min(n++, answers.length - 1)]; return typeof next === 'function' ? next() : next } })
  return { fx, ...await fx.connect() }
}

test('a 400 from the dispatch leaves failed / provider_status; the turn falls back to her working self', async () => {
  const { fx, tab, provider, conv } = await call([() => new Response('{"error":"bad"}', { status: 400 })])
  provider.json(transcript(1, 'what is the plan'))
  await drain(fx)
  tab.json({ t: 'delta', turn: `eleven:${conv}:1`, seq: 0, text: 'The plan is green. ' })
  tab.json({ t: 'done', turn: `eleven:${conv}:1` })
  await drain(fx)
  const [entry] = (await statusOf(fx)).turns
  // It fell back and her working self answered: handed, with the reason the fast call ended.
  assert.deepEqual([entry.outcome, entry.reason, entry.path, entry.calls], ['handed', 'provider_status', 'fast_fell_back', 1])
  // Spoken nothing at all and failed: failed / provider_status.
  const silent = await call([() => new Response('{}', { status: 400 })])
  silent.provider.json(transcript(1, 'what is the plan'))
  await drain(silent.fx)
  silent.tab.json({ t: 'fail', turn: `eleven:${silent.conv}:1`, code: 'VOICE_TURN_FAILED' })
  await drain(silent.fx)
  assert.deepEqual((await statusOf(silent.fx)).turns.map(item => [item.outcome, item.reason]), [['failed', 'provider_status']])
})

test('a barge-in leaves cancelled / barge_in, his stop cancelled / stop_words; marks, counts and toolRounds are numbers and names only, no words', async () => {
  const pending = () => whole(delta('Let me look. '), lookCall('{"tool":"x6_threads","args":{"action":"list"}}'), DONE)
  let control
  const flowing = new Response(new ReadableStream({ start(value) { control = value } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const { fx, tab, provider } = await call([pending, () => flowing, () => whole(delta('Tell me everything. '), DONE), pending])
  provider.json(transcript(1, 'what is the plan'))
  await drain(fx)
  const frame = tab.frames().find(item => item.t === 'tool')
  fx.clock.advance(300)
  tab.json({ t: 'tool_result', turn: frame.turn, call: frame.call, ok: true, text: 'PRIVATE-RESULT' })
  await drain(fx)
  control.enqueue(encoder.encode(delta('The plan is green. ')))
  await drain(fx)
  // Her answer is flowing: his real words are a barge-in.
  provider.json(transcript(2, 'tell me everything'))
  await drain(fx)
  // A third turn looks; his stop cuts it.
  provider.json(transcript(3, 'what is the plan now'))
  await drain(fx)
  provider.json(transcript(4, 'stop'))
  await drain(fx)
  const body = await statusOf(fx)
  // His stop words start no turn of their own: three entries, newest first.
  assert.equal(body.turns.length, 3)
  const [third, second, first] = body.turns
  assert.deepEqual([first.outcome, first.reason, second.outcome, second.reason], ['cancelled', 'barge_in', 'answered', null])
  assert.deepEqual([third.outcome, third.reason, third.calls], ['cancelled', 'stop_words', 1])
  assert.deepEqual(first.toolRounds, [{ tool: 'look', sentMs: 0, backMs: 300, result: 'ok' }])
  assert.deepEqual(third.toolRounds.map(item => [item.tool, item.result]), [['look', 'cancelled']])
  for (const entry of body.turns) {
    assert.ok(VOICE_TURN_OUTCOMES.includes(entry.outcome))
    assert.ok(entry.reason === null || VOICE_TURN_REASONS.includes(entry.reason))
    for (const name of ['journalMs', 'modelFirstMs', 'firstSpeechMs', 'endMs']) assert.ok(entry[name] === null || Number.isSafeInteger(entry[name]), name)
    for (const name of ['calls', 'merged', 'cues']) assert.ok(Number.isSafeInteger(entry[name]), name)
  }
  assert.deepEqual(Object.keys(body.counts), VOICE_STATUS_COUNTS)
  assert.equal(body.counts.stops, 1)
  for (const value of Object.values(body.counts)) assert.ok(Number.isSafeInteger(value))
  const text = JSON.stringify({ turns: body.turns, counts: body.counts, streamKeys: body.streamKeys })
  for (const words of SECRET_WORDS) assert.equal(text.includes(words), false, words)
  assert.deepEqual([TURNS_KEPT, VOICE_STATUS_TURNS], [24, 24])
})
