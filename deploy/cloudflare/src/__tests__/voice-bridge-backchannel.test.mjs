/** A BACKCHANNEL NO LONGER CUTS HER OFF (the fast voice commit 2, 2026-11-16; voice-bridge-do.mjs isBackchannel).
 * The provider's documented upstream rule (scout-1113 VOICE-PROVIDER.md, from the provider's speech-engine-upstream page):
 * a newer `user_transcript` is the interruption, and `agent_response` with an outdated `event_id` is silently discarded.
 * So a transcript that is only a backchannel, while her turn is live, does not cancel it: her remaining clauses are
 * carried over to the newest event id. The real Worker and VoiceBridgeDO over the fakes. No network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFrames, fixtureAfterHello as fixture, transcript } from './voice-bridge-fakes.mjs'
// He first speaks 2.5 s after the call opens (the first-frame wait is proven in voice-bridge-aware-store.test.mjs).
import { BACKCHANNEL_MAX_WORDS, HISTORY_KEY, KEEP_PHRASES, PRESENCE_PHRASES, STOP_PHRASES, heardKind, isBackchannel } from '../voice-bridge-do.mjs'

const drain = async fx => { for (let index = 0; index < 3; index++) await fx.settle() }
const chunks = provider => agentFrames(provider).map(frame => [frame.event_id, frame.content])
const turnsOf = async fx => (await fx.bridgeStorage.get(HISTORY_KEY))?.turns ?? []

// The keep
// list is wider (continue, go on, yes, sure, take your time ...), up to six words, and the fillers (her name as heard, uh,
// um, hmm, please, so, well) are dropped first: "yes", "hmm" and "okay okay okay okay" are now kept.
test('the closed list: wait and assent words (spellings of those only), at most six words after the fillers', () => {
  for (const text of ['mm-hm', 'Mm-hmm.', 'mhm', 'Uh-huh!', 'uh huh', 'Yeah.', 'ok', 'OK.', 'Okay,', 'right', 'Right?', 'got it', 'Got it.', 'yeah, got it', 'okay okay', 'mm-hm right yeah',
    'yes', 'hmm', 'okay okay okay okay', 'Okay, continue.', 'Continue.', 'go on', 'take your time', 'okay Omar, keep going', 'I’m listening', 'i am listening', 'No rush.', 'thank you', 'Sounds good!', 'um', 'Uh, um.']) {
    assert.equal(isBackchannel(text), true, text)
  }
  for (const text of ['', ' ', 'no', 'wait', 'stop', 'yeah but wait', 'okay okay okay okay okay okay okay', 'got', 'right now', 'ok do it', 'okay stop talking', 'omar?', 'what model are you on']) {
    assert.equal(isBackchannel(text), false, text)
  }
  assert.equal(BACKCHANNEL_MAX_WORDS, 6)
})

test('the classifier has four closed kinds; no keep word is on the stop list', () => {
  const kinds = { keep: ['Okay, continue.', 'continue', 'go ahead', 'carry on please', 'yep yep', 'so, well, um', 'all right', 'okay omar keep going', 'perfect, thanks'],
    presence: ['omar?', 'Auma.', 'are you there', 'Omar, are you still there?', 'hello hello', 'can you hear me', 'um, alma'],
    // the voice fix (CHANGED: 'no wait, stop', 'okay stop talking' and 'stop stop stop stop stop' were words; a stop said
    // with assent words, "no" or again is his stop, contract A "She stays interruptible").
    stop: ['stop', 'Wait.', 'hold on', 'never mind', 'nevermind', 'forget it', 'be quiet', "that's enough", 'stop talking', 'one second', 'wait wait stop', 'Omar, stop.',
      'no wait, stop', 'okay stop talking', 'stop stop stop stop stop'],
    words: ['what model are you on', 'and check the conversation list too', 'stop the build', 'hi omar are you there',
      'wait what', 'hello there friend', 'are you there and what time is it', 'keep going and read the list'] }
  for (const [kind, texts] of Object.entries(kinds)) for (const text of texts) assert.equal(heardKind(text), kind, text)
  // "stop" is never keep; no phrase is on both lists; presence is exact.
  assert.equal(KEEP_PHRASES.some(phrase => STOP_PHRASES.includes(phrase)), false)
  assert.equal(heardKind('stop'), 'stop')
  assert.equal(PRESENCE_PHRASES.includes('are you there'), true)
})

test('her governed turn is live and he says "mm-hm": nothing is cancelled; her remaining clauses go out under the newest event id', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  const id = `eleven:${conv}:1`
  provider.json(transcript(1, 'tell me about the garden'))
  await drain(fx)
  tab.json({ t: 'delta', turn: id, seq: 0, text: 'The garden has three beds. ' })
  await drain(fx)
  // the voice fix (CHANGED: four seconds pass, so her first clause was spoken before his "mm-hm"; said in the same instant
  // it would be picked up again under the new id, see voice-bridge-resume.test.mjs).
  fx.clock.advance(4000)
  provider.json(transcript(2, 'Mm-hm.'))
  await drain(fx)
  // No cancel to the tab, no barge-in in the journal: the turn runs on.
  assert.equal(tab.frames().some(frame => frame.t === 'cancel'), false)
  assert.equal((await fx.rows()).find(row => row.turnId === id).cancelled, undefined)
  tab.json({ t: 'delta', turn: id, seq: 1, text: 'The roses are in the second. ' })
  tab.json({ t: 'done', turn: id })
  await drain(fx)
  assert.deepEqual(chunks(provider), [[1, 'The garden has three beds. '], [2, 'The roses are in the second. '], [2, '']])
  assert.equal((await fx.rows()).find(row => row.turnId === id).completed, true)
  // The status contract's outcome names.
  assert.deepEqual((await turnsOf(fx)).map(entry => entry.outcome), ['answered'])
  // A provider retry of the newest event replays what went out under THAT id (never the clause said under id 1), then
  // the final (review 2026-11-16).
  provider.json(transcript(2, 'Mm-hm.'))
  await drain(fx)
  assert.deepEqual(chunks(provider).slice(3), [[2, 'The roses are in the second. '], [2, '']])
})

test('a real newer transcript still interrupts, after a carried backchannel too; a backchannel with no live turn is a turn', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'read me the list'))
  await drain(fx)
  provider.json(transcript(2, 'yeah'))
  await drain(fx)
  // Real words interrupt.
  provider.json(transcript(3, 'no, read me the other one'))
  await drain(fx)
  assert.deepEqual(tab.frames().filter(frame => frame.t === 'cancel'), [{ t: 'cancel', turn: `eleven:${conv}:1`, reason: 'superseded' }])
  const first = (await fx.rows()).find(row => row.turnId === `eleven:${conv}:1`)
  assert.deepEqual([first.cancelled, first.cancelReason], [true, 'barge_in'])
  assert.deepEqual(tab.frames().filter(frame => frame.t === 'turn').map(frame => frame.eventId), [1, 3])
  // Turn 3 ends; then "okay" with nothing live is his turn like any other.
  tab.json({ t: 'delta', turn: `eleven:${conv}:3`, seq: 0, text: 'Stopped. Shall I go on?' })
  tab.json({ t: 'done', turn: `eleven:${conv}:3` })
  await drain(fx)
  // the voice fix (CHANGED: five seconds pass, so her answer was spoken; an "okay" that cut it would pick it up instead).
  fx.clock.advance(5000)
  provider.json(transcript(4, 'okay'))
  await drain(fx)
  assert.deepEqual(tab.frames().filter(frame => frame.t === 'turn').map(frame => [frame.eventId, frame.transcript]), [[1, 'read me the list'], [3, 'no, read me the other one'], [4, 'okay']])
  // Seven words is not a keep (CHANGED: the bound is six since the voice fix): it interrupts.
  const more = fixture()
  const other = await more.connect()
  other.provider.json(transcript(1, 'go on'))
  await drain(more)
  other.provider.json(transcript(2, 'okay okay okay okay okay okay okay'))
  await drain(more)
  assert.equal(other.tab.frames().filter(frame => frame.t === 'cancel').length, 1)
})

test('a backchannel while her turn is still being journaled carries it too; the turn is handed over and answers on the newest id', async () => {
  let release
  const held = new Promise(resolve => { release = resolve })
  const ticks = async () => { for (let index = 0; index < 30; index++) await new Promise(resolve => setImmediate(resolve)) }
  const fx = fixture({ journalGate: async body => { if (body.action === undefined && body.turnId?.endsWith(':1')) await held } })
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'what time is it'))
  await ticks()
  provider.json(transcript(2, 'right'))
  await ticks()
  release()
  await drain(fx)
  assert.deepEqual(tab.frames().filter(frame => frame.t === 'turn').map(frame => frame.turn), [`eleven:${conv}:1`])
  tab.json({ t: 'delta', turn: `eleven:${conv}:1`, seq: 0, text: 'It is noon.' })
  tab.json({ t: 'done', turn: `eleven:${conv}:1` })
  await drain(fx)
  assert.deepEqual(chunks(provider), [[2, 'It is noon.'], [2, '']])
})

test('her FAST turn is live and he says "got it": the model call goes on and her next clauses go out under the newest id', async () => {
  const encoder = new TextEncoder()
  let control
  let cancelled = false
  const response = new Response(new ReadableStream({ start(value) { control = value }, cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
  const delta = text => encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
  const fx = fixture({ env: { DEEPSEEK_API_KEY: 'sk-synthetic-backchannel-key', PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '1000',
    PROVIDER_BUDGET_TOKENS: '50000000', PROVIDER_MAX_OUTPUT_TOKENS: '256000' }, modelFetch: () => response })
  const { tab, provider } = await fx.connect()
  provider.json(transcript(1, 'what is new'))
  await drain(fx)
  control.enqueue(delta('Two things are new. '))
  await drain(fx)
  // the voice fix (CHANGED: four seconds pass, so her first clause was spoken before his "got it").
  fx.clock.advance(4000)
  provider.json(transcript(2, 'Got it.'))
  await drain(fx)
  control.enqueue(delta('The voice is faster.'))
  control.enqueue(encoder.encode('data: [DONE]\n\n'))
  control.close()
  await drain(fx)
  assert.equal(cancelled, false)
  assert.deepEqual(chunks(provider), [[1, 'Two things are new. '], [2, 'The voice is faster.'], [2, '']])
  assert.equal(tab.frames().some(frame => frame.t === 'cancel' || frame.t === 'turn'), false)
  // The status contract's outcome names.
  assert.deepEqual((await turnsOf(fx)).map(entry => [entry.outcome, entry.path]), [['answered', 'fast']])
})

test('the same words again under a new id carry the turn; an extension is judged only by what follows', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  const id = `eleven:${conv}:1`
  provider.json(transcript(1, 'what model are you on?'))
  await drain(fx)
  tab.json({ t: 'delta', turn: id, seq: 0, text: 'Let me see. ' })
  await drain(fx)
  // The provider sends his same words under a newer id: carried, never a cut.
  provider.json(transcript(2, 'What model are you on'))
  await drain(fx)
  // His unanswered words as one entry, then "Continue": only "Continue" is judged, a keep.
  provider.json(transcript(3, 'what model are you on? Continue.'))
  await drain(fx)
  assert.equal(tab.frames().some(frame => frame.t === 'cancel'), false)
  assert.deepEqual(tab.frames().filter(frame => frame.t === 'turn').map(frame => frame.eventId), [1])
  // An extension that is real words is judged as words: a governed turn is interrupted as before.
  provider.json(transcript(4, 'what model are you on? Continue. And what time is it'))
  await drain(fx)
  assert.deepEqual(tab.frames().filter(frame => frame.t === 'cancel'), [{ t: 'cancel', turn: id, reason: 'superseded' }])
  assert.deepEqual(tab.frames().filter(frame => frame.t === 'turn').map(frame => frame.eventId), [1, 4])
  assert.equal(fx.bridge.counts.backchannelsKept, 2)
})

test('a stop said with assent words, after "no", or repeated is a stop; "stop" is never keep', () => {
  for (const text of ['Okay, stop.', 'okay wait', 'no, stop', 'no wait, stop', 'No, wait.', 'yeah stop', 'stop stop stop stop stop', 'wait wait wait wait wait',
    'hold on hold on hold on', 'okay stop talking', 'shut up', 'Omar, okay, hold on.']) {
    assert.equal(heardKind(text), 'stop', text)
  }
  // Not stop: a stop phrase among other words (those are never merged: voice-bridge-fast-tools.test.mjs), "no" alone or
  // with assent only, and keep words alone.
  for (const [text, kind] of [['stop the build', 'words'], ['stop it', 'words'], ['no', 'words'], ['no continue', 'words'], ['okay okay', 'keep'], ['wait what', 'words']]) {
    assert.equal(heardKind(text), kind, text)
  }
})
