/** HER LITTLE WORDS SAY WHAT SHE IS DOING. Every cue is chosen
 * from the turn's state (voice-bridge-do.mjs cueState) and, for the first one, from the kind of his words
 * (heardQuestion); every word is on voice-director.mjs's closed list. The real Worker and VoiceBridgeDO, HEAD's real turn
 * journal, budget and dispatcher; only the provider's network and her tab are faked, on a manual clock. No network, no
 * paid call. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFrames, fixtureAfterHello as fixture, transcript } from './voice-bridge-fakes.mjs'
import {
  BACKCHANNEL, BACKCHANNEL_LEAD_MS, DEEP_CUE, DEEP_FELL_BACK_CUE, EARLY_CUE, HANDOFF_ECHO_CUE, STILL_THINKING_CUE, THINK_CUE, EARLY_CUE_MS, FIRST_CUES, PRESENCE_CUES, STATE_CUES, TOOL_CUE, WORK_CUE_AFTER_MS, WORK_CUE_EVERY_MS, WORK_CUE_MAX,
  cueState, heardQuestion,
  earlyCueOn,
} from '../voice-bridge-do.mjs'
import { idleVoiceDirective } from '../voice-director.mjs'
import { HAND_OFF_TOOL, LOOK_TOOL } from '../voice-fast.mjs'
import { SPEECH_ENGINE_TIMEOUT_SECONDS } from '../voice-provider-speech-engine.mjs'

const FAST_ENV = Object.freeze({ DEEPSEEK_API_KEY: 'sk-synthetic-fast-voice-key-0123456789abcdef', PROVIDER_BUDGET_WINDOW_MS: '60000',
  PROVIDER_BUDGET_REQUESTS: '1000', PROVIDER_BUDGET_TOKENS: '50000000', PROVIDER_MAX_OUTPUT_TOKENS: '256000' })
const encoder = new TextEncoder()
const data = value => `data: ${JSON.stringify(value)}\n\n`
const delta = text => data({ choices: [{ index: 0, delta: { content: text } }] })
const DONE = 'data: [DONE]\n\n'
function callChunks(calls) {
  return calls.map((call, index) => data({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: `m${String(index)}`, type: 'function', function: { name: call.name, arguments: call.args } }] } }] })).join('')
    + data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
}
const look = (tool, args = {}) => ({ name: LOOK_TOOL, args: JSON.stringify({ tool, args }) })
function liveStream() {
  let control
  const stream = { cancelled: false }
  stream.response = new Response(new ReadableStream({ start(value) { control = value }, cancel() { stream.cancelled = true } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  stream.push = text => { if (!stream.cancelled) control.enqueue(encoder.encode(text)) }
  stream.end = () => { if (!stream.cancelled) control.close() }
  return stream
}
const whole = (...chunks) => { const stream = liveStream(); for (const chunk of chunks) stream.push(chunk); stream.end(); return stream.response }
const drain = async fx => { for (let index = 0; index < 4; index++) await fx.settle() }
const spoken = (provider, eventId) => agentFrames(provider).filter(frame => frame.event_id === eventId).map(frame => frame.content)
const allSpoken = provider => agentFrames(provider).map(frame => frame.content)
const toolFrames = tab => tab.frames().filter(frame => frame.t === 'tool')
const ALL_STATE_WORDS = Object.values(STATE_CUES).flat()
const cuesOf = said => said.filter(text => ALL_STATE_WORDS.includes(text) || text === BACKCHANNEL)
/** Advance the clock in 1 s steps (each step drains), `seconds` times. */
const seconds = async (fx, count) => { for (let index = 0; index < count; index++) { fx.clock.advance(1000); await drain(fx) } }

async function fastCall(options = {}) {
  let n = 0
  const answers = options.answers ?? [whole(delta('Hello.'), DONE)]
  const fx = fixture({ ...options, env: { ...FAST_ENV, ...options.env }, modelFetch: () => {
    const next = answers[Math.min(n++, answers.length - 1)]
    return typeof next === 'function' ? next() : next
  } })
  const call = await fx.connect()
  return { fx, ...call, id: `eleven:${call.conv}:1` }
}
async function answerTools(fx, tab, text = '{}', answered = new Set()) {
  for (const frame of toolFrames(tab)) {
    if (answered.has(frame.call)) continue
    answered.add(frame.call)
    tab.json({ t: 'tool_result', turn: frame.turn, call: frame.call, ok: true, text })
  }
  await drain(fx)
  return answered
}

// ── The word lists ──────────────────────────────────────────────────────────────────────────────────────────────────
test('every cue word is on the closed list, and the lists are as built', () => {
  assert.deepEqual(STATE_CUES, {
    thinking: ['let me think... ', 'thinking it through... '],
    looking: ['one sec, looking... ', 'still looking... '],
    composing: ['putting it together... ', 'almost there... '],
    handed: ['my working self is on it... '],
  })
  assert.deepEqual(PRESENCE_CUES, { thinking: "I'm here, thinking... ", looking: "I'm here, still looking... ", composing: "I'm here, almost there... ",
    handed: "I'm here; my working self is on it... " })
  assert.deepEqual(FIRST_CUES, { question: 'hmm... ', statement: 'mm-hm... ' })
  assert.equal(EARLY_CUE, 'mm-hm... ')
  assert.equal(BACKCHANNEL, 'one sec... ')
  assert.equal(TOOL_CUE, STATE_CUES.looking[0])
  const allowed = idleVoiceDirective().allowedBackchannels
  for (const cue of [...ALL_STATE_WORDS, ...Object.values(PRESENCE_CUES), ...Object.values(FIRST_CUES), EARLY_CUE, BACKCHANNEL, TOOL_CUE,
    DEEP_CUE, THINK_CUE, STILL_THINKING_CUE, DEEP_FELL_BACK_CUE, HANDOFF_ECHO_CUE]) {
    assert.equal(cue.endsWith('... '), true, cue)
    assert.equal(allowed.includes(cue.slice(0, -4)), true, cue)
  }
  // The timings are today's (the words matter here, not the clock).
  assert.deepEqual([EARLY_CUE_MS, WORK_CUE_AFTER_MS, WORK_CUE_EVERY_MS, WORK_CUE_MAX, BACKCHANNEL_LEAD_MS], [2500, 5000, 8000, 3, 1500])
})

// ── The state of a live turn ────────────────────────────────────────────────────────────────────────────────────────
test('cueState gives each state from what the bridge already tracks', () => {
  const fast = (extra = {}) => ({ status: 'running', pending: new Map(), handoff: false, answered: false, ...extra })
  const running = (fastExtra = {}, turnExtra = {}) => ({ state: 'running', path: 'fast', fast: fast(fastExtra), ...turnExtra })
  assert.equal(cueState(running()), 'thinking')
  assert.equal(cueState(running({ pending: new Map([['call_1', {}]]) })), 'looking')
  assert.equal(cueState(running({}, { toolLog: [{ tool: 'look', sentMs: 10, backMs: 900, result: 'ok' }] })), 'composing')
  // A second call's look pending after a first came back is looking, never composing.
  assert.equal(cueState(running({ pending: new Map([['call_2', {}]]) }, { toolLog: [{ tool: 'look', sentMs: 10, backMs: 900, result: 'ok' }, { tool: 'look', sentMs: 1000, backMs: null, result: null }] })), 'looking')
  // A call sent and not back is not a result.
  assert.equal(cueState(running({}, { toolLog: [{ tool: 'look', sentMs: 10, backMs: null, result: null }] })), 'thinking')
  // Review: a call that came back WITHOUT a result (refused, timed out, cancelled) is not a result: still thinking.
  for (const result of ['refused', 'timeout', 'cancelled']) {
    assert.equal(cueState(running({}, { toolLog: [{ tool: 'other', sentMs: 10, backMs: 10, result }] })), 'thinking', result)
  }
  assert.equal(cueState(running({}, { deep: true })), 'deep')
  assert.equal(cueState({ state: 'running', path: 'fast', handedAt: 5, fast: fast({ status: 'ended', handoff: true }) }), 'handed')
  assert.equal(cueState({ state: 'running', path: 'fast_fell_back', handedAt: 5, deep: true, fast: fast({ status: 'failed' }) }), 'handed')
  assert.equal(cueState({ state: 'running', path: 'governed', fast: null }), 'governed')
  // Her fast call is over and nothing was handed: no state fits, so no work cue claims anything.
  assert.equal(cueState({ state: 'running', path: 'fast', fast: fast({ status: 'ended' }) }), null)
})

// ── The first cue ───────────────────────────────────────────────────────────────────────────────────────────────────
test('the closed question test', () => {
  for (const text of ['Omar, what time is it', 'is it done', 'what is the time', 'Why did it fail', 'how far along are you', 'can you read YOURTEAM-1',
    'the build is green?', 'Auma, does it work', 'um, did you push', 'so when is the call', 'Have you looked?', 'which one', 'should I merge it',
    'Wait — were you there?']) assert.equal(heardQuestion(text), true, text)
  for (const text of ['okay do it', 'tell me about the garden', 'the build is green', 'read me YOURTEAM-1', 'I think it works', 'Omar, go ahead and look',
    'what', 'what?', '']) assert.equal(heardQuestion(text), text === 'what' || text === 'what?', text)
  // Review: a contraction's question word, and a lead-in word before it, still make a question.
  for (const text of ["Omar? what's the newest", "Omar, what's the newest", "Auma, how's it going", 'hey Auma what time is it', "right, what's next",
    'and what about Linear', "where's the card"]) assert.equal(heardQuestion(text), true, text)
  // Review: a request or a short reply that starts with do / have / can / will / could is not a question.
  for (const text of ['please do it', 'so do it', 'Auma, do it', 'do it', 'Have a look at Linear', 'please have a look', 'will do', 'Can do',
    'could be', 'do that']) assert.equal(heardQuestion(text), false, text)
})

test('the first cue fits his words: "hmm" for a question, "mm-hm" for anything else', async () => {
  const run = async words => {
    const hung = liveStream()
    const { fx, provider } = await fastCall({ answers: [() => hung.response] })
    provider.json(transcript(1, words))
    await drain(fx)
    fx.clock.advance(EARLY_CUE_MS - 1)
    await drain(fx)
    const before = spoken(provider, 1)
    fx.clock.advance(1)
    await drain(fx)
    return [before, spoken(provider, 1)[0]]
  }
  assert.deepEqual(await run('Omar, what time is it'), [[], FIRST_CUES.question])
  assert.deepEqual(await run('is it done'), [[], FIRST_CUES.question])
  assert.deepEqual(await run('okay do it'), [[], FIRST_CUES.statement])
  assert.deepEqual(await run('the build is green'), [[], FIRST_CUES.statement])
  assert.deepEqual(await run('the build is green?'), [[], FIRST_CUES.question])
})

test('a governed-only turn (fast voice off) keeps today\'s cues, whatever he asked', async () => {
  const { fx, provider } = await fastCall({ env: { VOICE_FAST: 'off' } })
  provider.json(transcript(1, 'what is the time'))
  await drain(fx)
  fx.clock.advance(SPEECH_ENGINE_TIMEOUT_SECONDS * 1000 - BACKCHANNEL_LEAD_MS)
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), [EARLY_CUE, BACKCHANNEL])
})

// ── The cues while she works ────────────────────────────────────────────────────────────────────────────────────────
test('a turn that only thinks for 14 s says "let me think" then "thinking it through", never "looking"', async () => {
  const hung = liveStream()
  const { fx, provider } = await fastCall({ answers: [() => hung.response] })
  provider.json(transcript(1, 'why is the sky blue'))
  await drain(fx)
  hung.push(delta('Good question. '))
  await drain(fx)
  await seconds(fx, 14)
  const said = spoken(provider, 1)
  assert.deepEqual(said, ['Good question. ', STATE_CUES.thinking[0], STATE_CUES.thinking[1]])
  assert.equal(said.some(text => text.includes('looking')), false)
})

test('a look pending for 14 s says "one sec, looking" then "still looking"', async () => {
  const hung = liveStream()
  // Her tab never answers: the first look times out at 8 s and the next call asks for another look at once.
  const { fx, provider, tab } = await fastCall({ answers: [() => whole(delta('Let me look. '), callChunks([look('x6_linear', { action: 'issues' })]), DONE),
    () => whole(callChunks([look('x6_repo', { action: 'promotion_status' })]), DONE), () => hung.response] })
  provider.json(transcript(1, 'what is on Linear'))
  await drain(fx)
  await seconds(fx, 14)
  assert.equal(toolFrames(tab).length, 2)
  assert.deepEqual(spoken(provider, 1), ['Let me look. ', STATE_CUES.looking[0], STATE_CUES.looking[1]])
})

test('after the result, a slow second call says "putting it together", then "almost there"', async () => {
  const hung = liveStream()
  const { fx, provider, tab } = await fastCall({ answers: [() => whole(delta('Let me look. '), callChunks([look('x6_voice_status')]), DONE), () => hung.response] })
  provider.json(transcript(1, 'what model are you on'))
  await drain(fx)
  await seconds(fx, 1)
  await answerTools(fx, tab)
  await seconds(fx, 13)
  assert.deepEqual(spoken(provider, 1), ['Let me look. ', STATE_CUES.composing[0], STATE_CUES.composing[1]])
  hung.push(delta('You are on deepseek-chat. '))
  hung.push(DONE)
  hung.end()
  await drain(fx)
  assert.deepEqual(spoken(provider, 1).slice(-2), ['You are on deepseek-chat. ', ''])
})

test('thinking, then looking, then composing: each cue says the state of its moment, no word twice, never more than three', async () => {
  const first = liveStream()
  const second = liveStream()
  const { fx, provider, tab } = await fastCall({ answers: [() => first.response, () => second.response] })
  provider.json(transcript(1, 'what changed today'))
  await drain(fx)
  first.push(delta('Let me see. '))
  await drain(fx)
  await seconds(fx, 6)
  // 5 s: she is only thinking.
  first.push(callChunks([look('x6_repo', { action: 'log' })]) + DONE)
  first.end()
  await drain(fx)
  await seconds(fx, 7)
  // 13 s: her look is pending. Review (CHANGED): it is answered at 13 s, inside its 8 s wait (sent at 6 s); at 14 s it
  // had already timed out, so the old run's "result" was a timeout, which is no result.
  await answerTools(fx, tab)
  assert.equal(fx.bridge.counts.toolTimeouts, 0)
  await seconds(fx, 11)
  // 21 s: the result came back and the second call works.
  const said = spoken(provider, 1)
  assert.deepEqual(cuesOf(said), [STATE_CUES.thinking[0], STATE_CUES.looking[0], STATE_CUES.composing[0]])
  assert.equal(new Set(cuesOf(said)).size, cuesOf(said).length)
  await seconds(fx, 10)
  assert.equal(cuesOf(spoken(provider, 1)).length, WORK_CUE_MAX)
})

test('review: a look refused at once is no result: she says she is thinking, never "putting it together" or "almost there"', async () => {
  const hung = liveStream()
  // The model asks for a tool that is not offered (refused at once, nothing goes to the tab); the next call hangs.
  const { fx, provider, tab } = await fastCall({ answers: [() => whole(delta('Let me see. '), callChunks([{ name: 'not_offered', args: '{}' }]), DONE),
    () => hung.response] })
  provider.json(transcript(1, 'what changed today'))
  await drain(fx)
  await seconds(fx, 14)
  assert.equal(toolFrames(tab).length, 0)
  assert.deepEqual(spoken(provider, 1), ['Let me see. ', STATE_CUES.thinking[0], STATE_CUES.thinking[1]])
  assert.equal(spoken(provider, 1).some(text => STATE_CUES.composing.includes(text)), false)
})

test('when the state\'s words are used up, silence, never a repeat', async () => {
  const hung = liveStream()
  const { fx, provider } = await fastCall({ answers: [() => hung.response] })
  provider.json(transcript(1, 'tell me a long story'))
  await drain(fx)
  hung.push(delta('Alright. '))
  await drain(fx)
  // The whole-turn bound (25 s) ends it; the third slot (21 s) finds no unused thinking word and says nothing.
  await seconds(fx, 24)
  assert.deepEqual(spoken(provider, 1), ['Alright. ', STATE_CUES.thinking[0], STATE_CUES.thinking[1]])
})

// ── When he asks whether she is there ───────────────────────────────────────────────────────────────────────────────
test('presence says "I\'m here" and what she is doing: thinking, looking, composing', async () => {
  {
    const hung = liveStream()
    const { fx, provider } = await fastCall({ answers: [() => hung.response] })
    provider.json(transcript(1, 'why is the sky blue'))
    await drain(fx)
    fx.clock.advance(1000)
    provider.json(transcript(2, 'are you there'))
    await drain(fx)
    assert.deepEqual(spoken(provider, 2), [PRESENCE_CUES.thinking])
  }
  {
    const { fx, provider } = await fastCall({ answers: [() => whole(callChunks([look('x6_voice_status')]), DONE), () => liveStream().response] })
    provider.json(transcript(1, 'what model are you on'))
    await drain(fx)
    provider.json(transcript(2, 'Omar?'))
    await drain(fx)
    assert.deepEqual(spoken(provider, 1), [TOOL_CUE])
    assert.deepEqual(spoken(provider, 2), [PRESENCE_CUES.looking])
  }
  {
    const hung = liveStream()
    const { fx, provider, tab } = await fastCall({ answers: [() => whole(callChunks([look('x6_voice_status')]), DONE), () => hung.response] })
    provider.json(transcript(1, 'what model are you on'))
    await drain(fx)
    await answerTools(fx, tab)
    provider.json(transcript(2, 'are you still there'))
    await drain(fx)
    assert.deepEqual(spoken(provider, 2), [PRESENCE_CUES.composing])
  }
})

test('a handed turn says "my working self is on it" once; presence there says so too', async () => {
  const { fx, tab, provider, id } = await fastCall({ answers: [() => whole(delta('Handing that to my working self. '), callChunks([{ name: HAND_OFF_TOOL, args: '{}' }]), DONE)] })
  provider.json(transcript(1, 'build the card'))
  await drain(fx)
  assert.deepEqual(tab.frames().filter(frame => frame.t === 'turn').map(frame => frame.turn), [id])
  fx.clock.advance(WORK_CUE_AFTER_MS - 1)
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), ['Handing that to my working self. '])
  fx.clock.advance(1)
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), ['Handing that to my working self. ', STATE_CUES.handed[0]])
  await seconds(fx, 30)
  assert.equal(allSpoken(provider).filter(text => text === STATE_CUES.handed[0]).length, 1)
  provider.json(transcript(2, 'are you there'))
  await drain(fx)
  assert.deepEqual(spoken(provider, 2), [PRESENCE_CUES.handed])
  tab.json({ t: 'delta', turn: id, seq: 0, text: 'Built. ' })
  tab.json({ t: 'done', turn: id })
  await drain(fx)
  assert.deepEqual(spoken(provider, 2), [PRESENCE_CUES.handed, 'Built. ', ''])
})

test('review: once her working self has begun its answer, "are you there" gets no cue between her words', async () => {
  const { fx, tab, provider, id } = await fastCall({ answers: [() => whole(delta('Handing that to my working self. '), callChunks([{ name: HAND_OFF_TOOL, args: '{}' }]), DONE)] })
  provider.json(transcript(1, 'build the card'))
  await drain(fx)
  await seconds(fx, 10)
  tab.json({ t: 'delta', turn: id, seq: 0, text: 'The card is built. ' })
  await drain(fx)
  assert.deepEqual(spoken(provider, 1).slice(-1), ['The card is built. '])
  provider.json(transcript(2, 'are you there'))
  await drain(fx)
  assert.deepEqual(spoken(provider, 2), [])
  tab.json({ t: 'delta', turn: id, seq: 1, text: 'It has three rows. ' })
  tab.json({ t: 'done', turn: id })
  await drain(fx)
  assert.deepEqual(spoken(provider, 2), ['It has three rows. ', ''])
  assert.equal(allSpoken(provider).some(text => Object.values(PRESENCE_CUES).includes(text)), false)
})

// ── The provider-wait protection ────────────────────────────────────────────────────────────────────────────────────
test('the provider-wait cue fires at the same time, once per carried event, in the words of the state', async () => {
  const wait = SPEECH_ENGINE_TIMEOUT_SECONDS * 1000 - BACKCHANNEL_LEAD_MS
  // Her fast call fails at once (no first event in 2 s): the turn falls back to her working self, saying nothing.
  const { fx, provider } = await fastCall({ answers: [() => liveStream().response] })
  provider.json(transcript(1, 'build the card'))
  await drain(fx)
  fx.clock.advance(wait - 1)
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), [FIRST_CUES.statement])
  fx.clock.advance(1)
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), [FIRST_CUES.statement, STATE_CUES.handed[0]])
  fx.clock.advance(5000)
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), [FIRST_CUES.statement, STATE_CUES.handed[0]])
  // His "okay" carries it to event 2: the wait starts again from that arrival; the handed words are used up: "one sec".
  provider.json(transcript(2, 'okay'))
  await drain(fx)
  fx.clock.advance(wait - 1)
  await drain(fx)
  assert.deepEqual(spoken(provider, 2), [])
  fx.clock.advance(1)
  await drain(fx)
  assert.deepEqual(spoken(provider, 2), [BACKCHANNEL])
  fx.clock.advance(wait * 2)
  await drain(fx)
  assert.deepEqual(spoken(provider, 2), [BACKCHANNEL])
})

test('on a fast turn that said nothing, the provider-wait cue takes the next unused words of the state', async () => {
  const hung = liveStream()
  // The tool cue "one sec, looking" is said at once; the look times out at 8 s (no result: thinking); the second call
  // works on. Review (CHANGED): a timed-out look is no result, so the words are "let me think", never "putting it together".
  const { fx, provider } = await fastCall({ answers: [() => whole(callChunks([look('x6_voice_status')]), DONE), () => hung.response] })
  provider.json(transcript(1, 'what model are you on'))
  await drain(fx)
  const wait = SPEECH_ENGINE_TIMEOUT_SECONDS * 1000 - BACKCHANNEL_LEAD_MS
  fx.clock.advance(wait - 1)
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), [TOOL_CUE])
  fx.clock.advance(1)
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), [TOOL_CUE, STATE_CUES.thinking[0]])
})

// 2026-11-18,
// The fixtures keep VOICE_EARLY_CUE on (so the machinery above stays tested); these run the SHIPPED setting.
test('the shipped setting says no early "mm-hm" or "hmm": her first sound is her own words, and the provider-wait "one sec" still comes', async () => {
  const shipped = /^VOICE_EARLY_CUE = "(\w+)"$/m.exec((await import('node:fs')).readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8'))
  assert.equal(shipped?.[1], 'off', 'wrangler.toml ships the early cue off')
  for (const value of ['off', undefined, '1', 'ON', 'true']) assert.equal(earlyCueOn({ VOICE_EARLY_CUE: value }), false, String(value))
  assert.equal(earlyCueOn({ VOICE_EARLY_CUE: 'on' }), true)
  for (const words of ['what now', 'tell me about the garden']) {
    const fx = fixture({ env: { VOICE_EARLY_CUE: 'off' } })
    const { conv, tab, provider } = await fx.connect()
    provider.json(transcript(1, words))
    await drain(fx)
    // Well past the 2.5 s where the early cue was said: nothing has gone out.
    fx.clock.advance(EARLY_CUE_MS + 4000)
    await drain(fx)
    assert.deepEqual(agentFrames(provider).map(frame => frame.content), [], words)
    // The provider-wait cue is not the early cue: it still goes out 1.5 s before the provider's wait runs out.
    fx.clock.advance(SPEECH_ENGINE_TIMEOUT_SECONDS * 1000 - BACKCHANNEL_LEAD_MS - EARLY_CUE_MS - 4000)
    await drain(fx)
    assert.deepEqual(agentFrames(provider).map(frame => frame.content), [BACKCHANNEL], words)
    tab.json({ t: 'delta', turn: `eleven:${conv}:1`, seq: 0, text: 'Here. ' })
    tab.json({ t: 'done', turn: `eleven:${conv}:1` })
    await drain(fx)
    const said = agentFrames(provider).map(frame => frame.content)
    assert.deepEqual(said, [BACKCHANNEL, 'Here. ', ''], words)
    assert.equal(said.some(content => content === EARLY_CUE || content === FIRST_CUES.question), false)
  }
})
