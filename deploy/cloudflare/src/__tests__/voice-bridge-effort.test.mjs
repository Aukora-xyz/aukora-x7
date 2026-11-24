/** HOW DEEPLY SHE THINKS (the effort levels, 2026-11-16; voice-fast.mjs FAST_EFFORT_LEVELS, ownerEffort, THINK_TOOL;
 * voice-bridge-do.mjs). Five levels in one table; he can ask for one in his own words (one turn, or "stay on" for the
 * call); she can ask for one with `think_deeper` (the same turn again at that level, once); a deep turn is never silent.
 * The real Worker, the real VoiceBridgeDO, HEAD's REAL turn journal, budget and dispatcher; only the provider's network
 * and her tab are faked. The streams are written in the event shapes of the Claude API reference. No network, no paid
 * call; the key is a synthetic test value. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFrames, fixtureAfterHello as fixture, transcript } from './voice-bridge-fakes.mjs'
// He first speaks 2.5 s after the call opens (the first-frame wait is proven in voice-bridge-aware-store.test.mjs).
import { BACKCHANNEL, DEEP_CUE, DEEP_CUE_EVERY_MS, DEEP_FELL_BACK_CUE, HISTORY_KEY, STATE_CUES, THINK_CUE, STILL_THINKING_CUE } from '../voice-bridge-do.mjs'
import {
  FAST_EFFORT_LEVELS, FAST_VOICE_EFFORTS, FAST_VOICE_RULES, HAND_OFF_TOOL, LOOK_TOOL, THINK_LEVELS, THINK_LINES, THINK_TOOL,
  fastAnthropicBody, fastVoiceSettings, fastVoiceStatus, ownerEffort,
} from '../voice-fast.mjs'

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
const textBlock = (index, ...pieces) => blockStart(index, { type: 'text', text: '' }) + pieces.map(text => blockDelta(index, { type: 'text_delta', text })).join('') + blockStop(index)
const THOUGHT = 'PRIVATE-THOUGHT this needs real reasoning'
const SIGNATURE = 'c2lnbmF0dXJlLW9mLXRoZS10aGlua2luZy1ibG9jaw=='
const thinkingBlock = (index, thought = THOUGHT) => blockStart(index, { type: 'thinking', thinking: '' }) + blockDelta(index, { type: 'thinking_delta', thinking: thought })
  + blockDelta(index, { type: 'signature_delta', signature: SIGNATURE }) + blockStop(index)
const toolBlock = (index, id, name, input) => blockStart(index, { type: 'tool_use', id, name, input: {} })
  + blockDelta(index, { type: 'input_json_delta', partial_json: JSON.stringify(input) }) + blockStop(index)
function liveStream() {
  let control
  const stream = { cancelled: false }
  stream.response = new Response(new ReadableStream({ start(value) { control = value }, cancel() { stream.cancelled = true } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  stream.push = text => { if (!stream.cancelled) control.enqueue(encoder.encode(text)) }
  stream.end = () => { if (!stream.cancelled) control.close() }
  return stream
}
const whole = (...chunks) => { const stream = liveStream(); for (const chunk of chunks) stream.push(chunk); stream.end(); return stream.response }
const answer = text => () => whole(start(), thinkingBlock(0), textBlock(1, text), stopWith('end_turn'))
const deeper = (level, id = 'toolu_D1') => () => whole(start(), thinkingBlock(0), toolBlock(1, id, THINK_TOOL, { level }), stopWith('tool_use'))
const drain = async fx => { for (let index = 0; index < 4; index++) await fx.settle() }
const spoken = (provider, eventId) => agentFrames(provider).filter(frame => frame.event_id === eventId).map(frame => frame.content)
const bodyOf = call => JSON.parse(new TextDecoder().decode(call.init.body))
const bodies = fx => fx.calls.model.map(bodyOf)
const turnsOf = async fx => (await fx.bridgeStorage.get(HISTORY_KEY))?.turns ?? []
const status = async fx => (await (await fx.ownerDoor({ body: { action: 'managed_status' } })).json())

async function claudeCall(options = {}) {
  let n = 0
  const answers = options.answers ?? [answer('Hello.')]
  const fx = fixture({ ...options, env: { ...CLAUDE_ENV, ...options.env }, modelFetch: () => {
    const next = answers[Math.min(n++, answers.length - 1)]
    return typeof next === 'function' ? next() : next
  } })
  const call = await fx.connect()
  return { fx, ...call, id: `eleven:${call.conv}:1` }
}
/** One spoken turn on event `eventId`, run to its end. */
async function say(fx, provider, eventId, words) {
  provider.json(transcript(eventId, words))
  await drain(fx)
}

// ── 1. Five levels, one table ────────────────────────────────────────────────────────────────────────────────────
test('the level table: five levels, each its own output room and bounds; the default is low, and any of the five may be the default', () => {
  assert.deepEqual(FAST_VOICE_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(Object.keys(FAST_EFFORT_LEVELS), FAST_VOICE_EFFORTS)
  // claude-api shared/model-migration.md: at xhigh and max set max_tokens of at least 64000 ("Start at 64K").
  assert.deepEqual(Object.fromEntries(FAST_VOICE_EFFORTS.map(level => [level, [FAST_EFFORT_LEVELS[level].maxTokens, FAST_EFFORT_LEVELS[level].turnMs, FAST_EFFORT_LEVELS[level].firstEventMs]])), {
    low: [4096, 25000, 6000], medium: [8192, 45000, 8000], high: [16000, 90000, 12000], xhigh: [64000, 180000, 20000], max: [64000, 300000, 30000] })
  for (const level of FAST_VOICE_EFFORTS) {
    const settings = fastVoiceSettings({ ...CLAUDE_ENV, VOICE_FAST_EFFORT: level })
    assert.deepEqual([settings.on, settings.effort, settings.offered], [true, level, FAST_VOICE_EFFORTS], level)
    const body = JSON.parse(fastAnthropicBody({ model: 'claude-fable-5-2', effort: level, transcript: 'hi', aware: null, history: [], now: 0 }))
    assert.deepEqual([body.max_tokens, body.output_config], [FAST_EFFORT_LEVELS[level].maxTokens, { effort: level }], level)
  }
  assert.equal(fastVoiceSettings({ ...CLAUDE_ENV, VOICE_FAST_EFFORT: 'turbo' }).why, 'effort-invalid')
  assert.deepEqual(fastVoiceStatus(CLAUDE_ENV), { on: true, provider: 'anthropic', model: 'claude-fable-5-2', why: null, effort: 'low', offered: FAST_VOICE_EFFORTS, notOffered: [] })
})

test('the default turn: effort low in the request body with its own max_tokens; the status entry says default', async () => {
  const { fx, provider } = await claudeCall()
  await say(fx, provider, 1, 'what build is live')
  const [body] = bodies(fx)
  assert.deepEqual([body.output_config, body.max_tokens], [{ effort: 'low' }, 4096])
  for (const field of ['temperature', 'top_p', 'top_k', 'thinking']) assert.equal(Object.hasOwn(body, field), false, field)
  assert.deepEqual(body.tool_choice, { type: 'auto' })
  const [entry] = (await status(fx)).turns
  assert.deepEqual([entry.effort, entry.effortBy], ['low', 'default'])
})

// ── 2. He can say it ─────────────────────────────────────────────────────────────────────────────────────────────
test('his phrases: a closed table on whole words, any case; each family sets the level for that turn only', () => {
  const families = {
    max: ['max think', 'think max', 'go max'],
    xhigh: ['go extra', 'extra high', 'think harder', 'go deeper', 'think deeper', 'deep think'],
    high: ['think hard', 'high effort', 'think it through'],
    low: ['keep it low', 'on low', 'quick answer', 'just quick'],
  }
  for (const [level, phrases] of Object.entries(families)) {
    for (const phrase of phrases) {
      assert.deepEqual(ownerEffort(`Okay, ${phrase.toUpperCase()}: what should we do about the relay?`), { level, hold: undefined }, phrase)
    }
  }
  // Whole words only: "think harder" is not "think hard"; parts of words never match.
  assert.equal(ownerEffort('think harder about it').level, 'xhigh')
  for (const words of ['the maximal case', 'extraordinary', 'onmax', 'deep thinking about it', 'what is the high water mark', 'hello']) {
    assert.deepEqual(ownerEffort(words), { level: null, hold: undefined }, words)
  }
  // "stay on" / "keep it on" holds it for the call; "back to normal" / "back to low" clears it.
  assert.deepEqual(ownerEffort('stay on max for this'), { level: 'max', hold: 'max' })
  assert.deepEqual(ownerEffort('Keep it on high, please'), { level: 'high', hold: 'high' })
  assert.deepEqual(ownerEffort('keep it on extra high'), { level: 'xhigh', hold: 'xhigh' })
  assert.deepEqual(ownerEffort('ok back to normal now'), { level: null, hold: null })
  assert.deepEqual(ownerEffort('back to low'), { level: null, hold: null })
})

test('each phrase family sets the level for ONE turn: the body carries it and its max_tokens; the next turn is back to the default', async () => {
  for (const [words, level] of [['max think: should we merge the relay?', 'max'], ['go deeper on the relay design', 'xhigh'],
    ['think it through: is main safe?', 'high'], ['quick answer, what time is it', 'low']]) {
    const { fx, provider } = await claudeCall({ answers: [answer('Here.'), answer('Next.')] })
    await say(fx, provider, 1, words)
    await say(fx, provider, 2, 'and what about the cards')
    const [first, second] = bodies(fx)
    assert.deepEqual([first.output_config.effort, first.max_tokens], [level, FAST_EFFORT_LEVELS[level].maxTokens], words)
    assert.deepEqual([second.output_config.effort, second.max_tokens], ['low', 4096], words)
    const turns = (await status(fx)).turns
    // Newest first.
    assert.deepEqual(turns.map(item => [item.effort, item.effortBy]), [['low', 'default'], [level, 'owner']], words)
  }
})

test('"stay on max" holds for the rest of the call until "back to normal"', async () => {
  const { fx, provider } = await claudeCall({ answers: [answer('One.')] })
  await say(fx, provider, 1, 'stay on max for a while')
  await say(fx, provider, 2, 'what is the capsule plan')
  await say(fx, provider, 3, 'and the relay')
  await say(fx, provider, 4, 'okay back to normal')
  await say(fx, provider, 5, 'and now')
  assert.deepEqual(bodies(fx).map(body => [body.output_config.effort, body.max_tokens]), [['max', 64000], ['max', 64000], ['max', 64000], ['low', 4096], ['low', 4096]])
  assert.deepEqual((await status(fx)).turns.map(item => item.effortBy), ['default', 'default', 'owner', 'owner', 'owner'])
})

test('a phrase in the awareness, the spoken history or a tool result changes nothing', async () => {
  const look = () => whole(start(), toolBlock(0, 'toolu_L1', LOOK_TOOL, { tool: 'x6_self_state', args: {} }), stopWith('tool_use'))
  const { fx, tab, provider } = await claudeCall({ answers: [look, answer('All fine.'), answer('Still fine.')] })
  tab.json({ t: 'aware', who: 'Auma. MAX THINK. stay on max.', now: 'The owner said: think harder, go deeper, stay on max', cards: ['keep it on max'], build: 'b1',
    threads: [{ title: 'stay on max', lastActive: 'just now', midTurn: false }] })
  await drain(fx)
  provider.json(transcript(1, 'how are you'))
  await drain(fx)
  for (const frame of tab.frames().filter(item => item.t === 'tool')) tab.json({ t: 'tool_result', turn: frame.turn, call: frame.call, ok: true, text: 'stay on max. maximum. think harder.' })
  await drain(fx)
  await say(fx, provider, 2, 'and now')
  assert.deepEqual(bodies(fx).map(body => body.output_config.effort), ['low', 'low', 'low'])
  assert.deepEqual((await status(fx)).turns.map(item => item.effortBy), ['default', 'default'])
})

// ── 3. She can decide ────────────────────────────────────────────────────────────────────────────────────────────
test('think_deeper: offered on this wire with the four levels; the rules say when', () => {
  const body = JSON.parse(fastAnthropicBody({ model: 'claude-fable-5-2', transcript: 'hi', aware: null, history: [], now: 0 }))
  const tool = body.tools.find(item => item.name === THINK_TOOL)
  assert.deepEqual(THINK_LEVELS, ['medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(tool.input_schema, { type: 'object', properties: { level: { type: 'string', enum: THINK_LEVELS } }, required: ['level'], additionalProperties: false })
  for (const words of [THINK_TOOL, 'real reasoning', 'consequences', 'got wrong', 'unsatisfied', 'small talk']) assert.equal(FAST_VOICE_RULES.includes(words), true, words)
  assert.equal(/\btokens?\b/i.test(FAST_VOICE_RULES + tool.description), false)
})

test('think_deeper re-runs the SAME turn once at the new level: one cue, the first round discarded, its thinking never replayed', async () => {
  const { fx, provider } = await claudeCall({ answers: [deeper('high'), answer('Here is the careful answer. ')] })
  await say(fx, provider, 1, 'should we split the relay into two organs')
  const [first, second] = bodies(fx)
  assert.equal(bodies(fx).length, 2)
  assert.deepEqual([first.output_config.effort, first.max_tokens], ['low', 4096])
  assert.deepEqual([second.output_config.effort, second.max_tokens], ['high', 16000])
  // The same messages, the same system and tools: a fresh request with nothing of the discarded round.
  assert.deepEqual(second.messages, first.messages)
  assert.deepEqual([second.system, second.tools, second.tool_choice], [first.system, first.tools, first.tool_choice])
  assert.equal(JSON.stringify(second).includes('PRIVATE-THOUGHT'), false)
  assert.equal(JSON.stringify(second).includes(SIGNATURE), false)
  // Both calls journaled under their own ids (each single-use).
  const ids = fx.calls.journal.map(row => row.turnId).filter(id => id.includes('.fast'))
  assert.equal(new Set(ids).size, 2)
  const said = spoken(provider, 1)
  assert.equal(said.filter(item => item === THINK_CUE).length, 1)
  assert.deepEqual(said.slice(-2), ['Here is the careful answer. ', ''])
  assert.equal(JSON.stringify(said).includes('PRIVATE'), false)
  const [entry] = (await status(fx)).turns
  // The status contract's outcome names.
  assert.deepEqual([entry.effort, entry.effortBy, entry.outcome, entry.path], ['high', 'self', 'answered', 'fast'])
})

test('a second think_deeper in the same turn gets a tool_result: she is already at her chosen level', async () => {
  const { fx, provider } = await claudeCall({ answers: [deeper('high'), deeper('max', 'toolu_D2'), answer('Decided. ')] })
  await say(fx, provider, 1, 'is this the right design')
  const all = bodies(fx)
  assert.deepEqual(all.map(body => body.output_config.effort), ['low', 'high', 'high'])
  const results = all[2].messages.at(-1).content
  assert.deepEqual(results.map(item => [item.type, item.tool_use_id]), [['tool_result', 'toolu_D2']])
  assert.equal(results[0].content.includes(THINK_LINES.already), true)
  // The round that asked is replayed verbatim (its thinking block too): it is a tool round of the high-level request.
  assert.equal(all[2].messages.at(-2).role, 'assistant')
  assert.equal(spoken(provider, 1).filter(item => item === THINK_CUE).length, 1)
  assert.deepEqual(spoken(provider, 1).slice(-2), ['Decided. ', ''])
})

test('think_deeper never lowers the level and never goes past the table', async () => {
  const { fx, provider } = await claudeCall({ answers: [deeper('medium'), answer('Fine. ')] })
  await say(fx, provider, 1, 'think it through: is the gate green')
  const all = bodies(fx)
  assert.deepEqual(all.map(body => body.output_config.effort), ['high', 'high'])
  assert.equal(all[1].messages.at(-1).content[0].content.includes(THINK_LINES.notHigher), true)
  const odd = await claudeCall({ answers: [deeper('ultra'), answer('Fine. ')] })
  await say(odd.fx, odd.provider, 1, 'hello')
  assert.deepEqual(bodies(odd.fx).map(body => body.output_config.effort), ['low', 'low'])
  assert.equal(bodies(odd.fx)[1].messages.at(-1).content[0].content.includes(THINK_LINES.badLevel), true)
})

// ── The budget ceiling ───────────────────────────────────────────────────────────────────────────────────────────
test('a level the edge ceiling cannot carry is not offered: the status says so, his phrase and her tool do not run it smaller in silence', async () => {
  const env = { PROVIDER_MAX_OUTPUT_TOKENS: '32000' }
  assert.deepEqual(fastVoiceStatus({ ...CLAUDE_ENV, ...env }), { on: true, provider: 'anthropic', model: 'claude-fable-5-2', why: null, effort: 'low',
    offered: ['low', 'medium', 'high'], notOffered: ['xhigh', 'max'] })
  // A default the ceiling cannot carry: off, with the reason.
  assert.equal(fastVoiceSettings({ ...CLAUDE_ENV, ...env, VOICE_FAST_EFFORT: 'max' }).why, 'budget-not-configured')
  const { fx, provider } = await claudeCall({ env, answers: [answer('Quick one. '), deeper('xhigh'), answer('Still quick. ')] })
  await say(fx, provider, 1, 'max think: what is next')
  await say(fx, provider, 2, 'and the relay')
  const all = bodies(fx)
  assert.deepEqual(all.map(body => [body.output_config.effort, body.max_tokens]), [['low', 4096], ['low', 4096], ['low', 4096]])
  assert.equal(all[2].messages.at(-1).content[0].content.includes(THINK_LINES.notOffered), true)
  const turns = (await status(fx)).turns
  assert.deepEqual(turns.map(item => [item.effort, item.effortBy, item.effortNotOffered ?? null]), [['low', 'default', null], ['low', 'default', 'max']])
  assert.deepEqual((await status(fx)).fast.notOffered, ['xhigh', 'max'])
})

// ── 4. No dead air on a deep turn ────────────────────────────────────────────────────────────────────────────────
test('a deep turn with no text yet: a cue at its start, then "still thinking" at most every 12 s; a newer transcript cancels it cleanly', async () => {
  assert.equal(DEEP_CUE_EVERY_MS, 12000)
  const thinking = liveStream()
  const { fx, provider, tab } = await claudeCall({ answers: [() => thinking.response, answer('New turn. ')] })
  provider.json(transcript(1, 'max think: what should the capsule carry'))
  await drain(fx)
  thinking.push(start() + blockStart(0, { type: 'thinking', thinking: '' }) + blockDelta(0, { type: 'thinking_delta', thinking: 'PRIVATE-THOUGHT a' }))
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), [DEEP_CUE])
  fx.clock.advance(11_000)
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), [DEEP_CUE], 'not before 12 s')
  fx.clock.advance(1_000)
  thinking.push(blockDelta(0, { type: 'thinking_delta', thinking: 'PRIVATE-THOUGHT b' }))
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), [DEEP_CUE, STILL_THINKING_CUE])
  fx.clock.advance(12_000)
  await drain(fx)
  fx.clock.advance(12_000)
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), [DEEP_CUE, STILL_THINKING_CUE, STILL_THINKING_CUE, STILL_THINKING_CUE])
  // Past the low level's 25 s whole-turn bound, still running (max allows 300 s), never handed to the governed path.
  assert.deepEqual(tab.frames().filter(frame => frame.t === 'turn'), [])
  // A backchannel does not cut it; a newer real transcript does.
  provider.json(transcript(2, 'mm-hm'))
  await drain(fx)
  assert.equal(thinking.cancelled, false)
  // Real words before her answer are merged now; his
  // stop words still cut the turn, and no model turn starts for them.
  provider.json(transcript(3, 'never mind'))
  await drain(fx)
  assert.equal(thinking.cancelled, true)
  const before = spoken(provider, 1).length + spoken(provider, 2).length
  fx.clock.advance(60_000)
  await drain(fx)
  assert.equal(spoken(provider, 1).length + spoken(provider, 2).length, before, 'no cue after the cut')
  assert.equal(JSON.stringify(agentFrames(provider)).includes('PRIVATE'), false)
  assert.deepEqual(spoken(provider, 3), [''])
})

test('a low turn keeps its 25 s whole bound and the old cues (no keep-alive); think_deeper to max moves the bound and starts the keep-alive', async () => {
  const quiet = liveStream()
  const { fx, provider } = await claudeCall({ answers: [deeper('max'), () => quiet.response] })
  provider.json(transcript(1, 'should I sign this'))
  await drain(fx)
  quiet.push(start() + blockStart(0, { type: 'thinking', thinking: '' }) + blockDelta(0, { type: 'thinking_delta', thinking: 'PRIVATE-THOUGHT' }))
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), [THINK_CUE])
  fx.clock.advance(30_000)
  await drain(fx)
  assert.equal(quiet.cancelled, false, 'max allows 300 s')
  assert.deepEqual(spoken(provider, 1), [THINK_CUE, STILL_THINKING_CUE, STILL_THINKING_CUE])
  const [entry] = await turnsOf(fx)
  assert.equal(entry, undefined, 'still running')
})

// ── Review fixes (2026-11-16) ────────────────────────────────────────────────────────────────────────────────────
test('review: the keep-alive counts from the last thing he heard, not from whether she ever spoke; words then think_deeper to max keep "still thinking"', async () => {
  const quiet = liveStream()
  const words = () => whole(start(), thinkingBlock(0), textBlock(1, 'Hmm, let me think about that. '), toolBlock(2, 'toolu_D1', THINK_TOOL, { level: 'max' }), stopWith('tool_use'))
  const { fx, provider } = await claudeCall({ answers: [words, () => quiet.response] })
  provider.json(transcript(1, 'should I sign this contract'))
  await drain(fx)
  quiet.push(start() + blockStart(0, { type: 'thinking', thinking: '' }) + blockDelta(0, { type: 'thinking_delta', thinking: 'PRIVATE-THOUGHT' }))
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), ['Hmm, let me think about that. ', THINK_CUE])
  fx.clock.advance(12_000)
  await drain(fx)
  fx.clock.advance(12_000)
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), ['Hmm, let me think about that. ', THINK_CUE, STILL_THINKING_CUE, STILL_THINKING_CUE])
})

test('review: on a held deep level, her words then a look: the next round, thinking for minutes, still gets "still thinking" 12 s after her last chunk', async () => {
  const quiet = liveStream()
  const look = () => whole(start(), thinkingBlock(0), textBlock(1, 'Let me look. '), toolBlock(2, 'toolu_L1', LOOK_TOOL, { tool: 'x6_self_state', args: {} }), stopWith('tool_use'))
  const { fx, provider, tab } = await claudeCall({ answers: [look, () => quiet.response] })
  provider.json(transcript(1, 'max think: how is she doing'))
  await drain(fx)
  for (const frame of tab.frames().filter(item => item.t === 'tool')) tab.json({ t: 'tool_result', turn: frame.turn, call: frame.call, ok: true, text: 'fine' })
  await drain(fx)
  quiet.push(start() + blockStart(0, { type: 'thinking', thinking: '' }) + blockDelta(0, { type: 'thinking_delta', thinking: 'PRIVATE-THOUGHT' }))
  await drain(fx)
  const before = spoken(provider, 1)
  assert.deepEqual(before, [DEEP_CUE, 'Let me look. '])
  fx.clock.advance(12_000)
  await drain(fx)
  assert.deepEqual(spoken(provider, 1), [...before, STILL_THINKING_CUE])
})

test('review: a deep turn that hands off gets the governed timeout cue (and again when a backchannel carries it)', async () => {
  const handing = () => whole(start(), thinkingBlock(0), toolBlock(1, 'toolu_H1', HAND_OFF_TOOL, {}), stopWith('tool_use'))
  const { fx, provider, tab } = await claudeCall({ answers: [handing] })
  provider.json(transcript(1, 'max think: ask the council what they think of the plan'))
  await drain(fx)
  assert.equal(tab.frames().filter(frame => frame.t === 'turn').length, 1)
  assert.deepEqual(spoken(provider, 1), [DEEP_CUE])
  fx.clock.advance(20_000)
  await drain(fx)
  // The governed
  // timeout cue of a handed turn says what is true ("my working self is on it"); once its words are used up, "one sec".
  assert.deepEqual(spoken(provider, 1), [DEEP_CUE, STATE_CUES.handed[0]])
  provider.json(transcript(2, 'mm-hm'))
  await drain(fx)
  fx.clock.advance(20_000)
  await drain(fx)
  assert.deepEqual(spoken(provider, 2), [BACKCHANNEL])
})

test('review: think_deeper keeps the whole-turn bound from the turn start; a deep turn that ran out says so once, then the governed cue still comes', async () => {
  const first = liveStream()
  const quiet = liveStream()
  const { fx, provider, tab } = await claudeCall({ answers: [() => first.response, () => quiet.response] })
  provider.json(transcript(1, 'should we split the relay'))
  await drain(fx)
  first.push(start() + blockStart(0, { type: 'thinking', thinking: '' }) + blockDelta(0, { type: 'thinking_delta', thinking: 'PRIVATE-THOUGHT' }))
  await drain(fx)
  fx.clock.advance(20_000)
  first.push(blockDelta(0, { type: 'signature_delta', signature: SIGNATURE }) + blockStop(0) + toolBlock(1, 'toolu_D1', THINK_TOOL, { level: 'high' }) + stopWith('tool_use'))
  first.end()
  await drain(fx)
  quiet.push(start() + blockStart(0, { type: 'thinking', thinking: '' }) + blockDelta(0, { type: 'thinking_delta', thinking: 'PRIVATE-THOUGHT' }))
  await drain(fx)
  // high's whole bound is 90 s from the turn's start, not from the escalation at 20 s.
  fx.clock.advance(70_000)
  await drain(fx)
  assert.equal(quiet.cancelled, true, 'bounded at 90 s from the turn start')
  assert.equal(tab.frames().filter(frame => frame.t === 'turn').length, 1)
  assert.equal(spoken(provider, 1).at(-1), DEEP_FELL_BACK_CUE)
  fx.clock.advance(20_000)
  await drain(fx)
  // The handed words.
  assert.equal(spoken(provider, 1).at(-1), STATE_CUES.handed[0])
})

test('review: common words do not raise the level; "stay on" holds only when it is about her thinking', () => {
  for (const words of ['that is extra work', 'add an extra line', 'a maximum of three', 'turn the volume on max', 'tell the heater to stay on high',
    'the lights stay on max all night']) {
    assert.deepEqual(ownerEffort(words), { level: null, hold: undefined }, words)
  }
  assert.deepEqual(ownerEffort('stay on max'), { level: 'max', hold: 'max' })
  assert.deepEqual(ownerEffort('okay, keep thinking on high'), { level: 'high', hold: 'high' })
  assert.deepEqual(ownerEffort('please stay on max thinking for the rest of the call'), { level: 'max', hold: 'max' })
})

test('review: a level is offered only when its smallest real reservation fits the budget window', () => {
  // 64000 output twice is 128000, under the window; the rules, tools and framing are not.
  const env = { ...CLAUDE_ENV, PROVIDER_BUDGET_TOKENS: '130000', PROVIDER_MAX_OUTPUT_TOKENS: '128000' }
  const line = fastVoiceStatus(env)
  assert.deepEqual([line.offered, line.notOffered], [['low', 'medium', 'high'], ['xhigh', 'max']])
})

test('a merge extension of the whole-turn bound survives think_deeper', async () => {
  const first = liveStream()
  const quiet = liveStream()
  const { fx, provider } = await claudeCall({ answers: [() => first.response, () => quiet.response] })
  provider.json(transcript(1, 'should we split the relay'))
  await drain(fx)
  first.push(start() + blockStart(0, { type: 'thinking', thinking: '' }) + blockDelta(0, { type: 'thinking_delta', thinking: 'PRIVATE-THOUGHT' }))
  await drain(fx)
  fx.clock.advance(3000)
  provider.json(transcript(2, 'and the queue too'))
  await drain(fx)
  assert.equal(fx.bridge.counts.wordsMerged, 1)
  fx.clock.advance(3000)
  first.push(blockDelta(0, { type: 'signature_delta', signature: SIGNATURE }) + blockStop(0) + toolBlock(1, 'toolu_D1', THINK_TOOL, { level: 'medium' }) + stopWith('tool_use'))
  first.end()
  await drain(fx)
  quiet.push(start() + blockStart(0, { type: 'thinking', thinking: '' }) + blockDelta(0, { type: 'thinking_delta', thinking: 'PRIVATE-THOUGHT' }))
  await drain(fx)
  // medium's 45 s from the turn's start, plus the merge's 15 s: alive just before 60 s, stopped at 60 s.
  fx.clock.advance(60_000 - 6000 - 1)
  await drain(fx)
  assert.equal(quiet.cancelled, false, 'the merge extension is kept')
  fx.clock.advance(1)
  await drain(fx)
  assert.equal(quiet.cancelled, true)
})
