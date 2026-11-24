/** She picks her words up after a cut. The provider stops her
 * audio the moment it hears him and throws away what it had not spoken yet; her model writes far faster than she speaks,
 * so the rest of her answer had usually been SENT already and was lost. A wait or assent word, a reaction or "are you
 * there" now gets the unspoken rest again under the new event id, with no model turn. Real words still interrupt.
 * The real Worker, the real VoiceBridgeDO, HEAD's real turn journal (voice-bridge-fakes.mjs); only the provider's network
 * and her tab are faked, and the clock is the fixture's manual clock. No network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFrames, fixtureAfterHello, storedMemory } from './voice-bridge-fakes.mjs'
import { HISTORY_KEY, REACT_PHRASES, RESUME, heardKind, heardReaction, plainWords, splitAtWords, spokenByClock, spokenByHistory, unspoken } from '../voice-bridge-do.mjs'
import { FAST_HEARD_FENCE, LOOK_TOOL } from '../voice-fast.mjs'
import { parse } from '../voice-provider-speech-engine.mjs'

const frame = (eventId, history) => JSON.stringify({ type: 'user_transcript', event_id: eventId, user_transcript: history })
const user = content => ({ role: 'user', content })
const agent = content => ({ role: 'agent', content })
const CLAUDE_ENV = Object.freeze({ VOICE_FAST_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-claude-test-value-not-a-key-0123456789',
  PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '1000', PROVIDER_BUDGET_TOKENS: '50000000', PROVIDER_MAX_OUTPUT_TOKENS: '256000' })
const encoder = new TextEncoder()
const sse = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
const start = () => sse({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-fable-5-2', content: [] } })
const textOpen = () => sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
const textPiece = text => sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
const textClose = () => sse({ type: 'content_block_stop', index: 0 })
const stop = () => sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }) + sse({ type: 'message_stop' })
const toolUse = (index, id, name, input) => sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } })
  + sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) + sse({ type: 'content_block_stop', index })
const stopForTools = () => sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }) + sse({ type: 'message_stop' })
function liveStream() {
  let control
  const stream = { cancelled: false }
  stream.response = new Response(new ReadableStream({ start(value) { control = value }, cancel() { stream.cancelled = true } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  stream.push = text => { if (!stream.cancelled) control.enqueue(encoder.encode(text)) }
  stream.end = () => { if (!stream.cancelled) control.close() }
  return stream
}
const whole = text => { const stream = liveStream(); stream.push(start() + textOpen() + textPiece(text) + textClose() + stop()); stream.end(); return stream.response }
const drain = async fx => { for (let index = 0; index < 4; index++) await fx.settle() }
const bodyOf = call => JSON.parse(new TextDecoder().decode(call.init.body))
const ownerSaid = call => { const content = bodyOf(call).messages.findLast(message => message.role === 'user' && typeof message.content === 'string').content; return content.slice(content.lastIndexOf(FAST_HEARD_FENCE) + FAST_HEARD_FENCE.length + 1) }
const finals = (provider, eventId) => agentFrames(provider).filter(item => item.event_id === eventId && item.is_final === true).length
const said = (provider, eventId) => agentFrames(provider).filter(item => item.event_id === eventId && item.content).map(item => item.content).join('')
async function call(answers) {
  let n = 0
  const fx = fixtureAfterHello({ env: CLAUDE_ENV, modelFetch: () => { const next = answers[Math.min(n++, answers.length - 1)]; return typeof next === 'function' ? next() : next } })
  return { fx, ...await fx.connect() }
}
const turnsOf = async fx => (await fx.bridgeStorage.get(HISTORY_KEY))?.turns ?? []

const ASK = 'tell me about the garden'
// Eighteen words in three sentences: 4, 10 and 4.
const ANSWER = 'It has three beds. The roses are in the second one, by the wall. The third is empty.'
const REST = 'The roses are in the second one, by the wall. The third is empty.'
/** Her answer to ASK has been written and sent whole (the turn is done at the edge), and `ms` have passed. */
async function answered(ms, more = []) {
  const made = await call([() => whole(ANSWER), ...more])
  made.provider.json(frame(1, [user(ASK)]))
  await drain(made.fx)
  assert.equal(said(made.provider, 1).trim(), ANSWER)
  assert.equal(finals(made.provider, 1), 1)
  made.fx.clock.advance(ms)
  return made
}

// ── The pure parts ───────────────────────────────────────────────────────────────────────────────────────────────────
test('splitAtWords cuts her own text after a count of words, and never inside a run with no space', () => {
  assert.deepEqual(splitAtWords('It has three beds. The roses', 4), ['It has three beds. ', 'The roses'])
  assert.deepEqual(splitAtWords('one two three', 0), ['', 'one two three'])
  assert.deepEqual(splitAtWords('one two', 2), ['one two', ''])
  assert.deepEqual(splitAtWords('one two', 9), ['one two', ''])
  assert.deepEqual(splitAtWords("it's 5 o'clock, well-known fact", 3), ["it's 5 o'clock, ", 'well-known fact'])
  // "goodbye.Yeah" is one run holding two words: a cut inside it puts the whole run after.
  assert.deepEqual(splitAtWords('say goodbye.Yeah now', 2), ['say ', 'goodbye.Yeah now'])
  assert.deepEqual(splitAtWords('— one — two', 1), ['— one — ', 'two'])
  for (const [text, count] of [['mañana por la tarde vamos', 2], ['one   two\n\nthree', 1], ['🙂 hello there 🙂 friend', 2]]) {
    const [before, after] = splitAtWords(text, count)
    assert.equal(before + after, text)
    assert.deepEqual([plainWords(before), plainWords(after)], [plainWords(text).slice(0, count), plainWords(text).slice(count)], text)
  }
})

test('spokenByHistory: the start of what she was sent that her entry ends with; a cut last word is not counted; little evidence is none', () => {
  const sent = plainWords(ANSWER)
  assert.equal(spokenByHistory('It has three beds. The roses', sent), 6)
  assert.equal(spokenByHistory('It has three beds. The roses are in the sec', sent), 9)
  assert.equal(spokenByHistory(ANSWER, sent), 18)
  // Her entry may hold earlier words too (a cue, an earlier clause): the end of it is what lines up.
  assert.equal(spokenByHistory('Mm-hm. It has three beds.', sent), 4)
  // One or two words that happen to line up are not evidence, unless they are her whole entry.
  assert.equal(spokenByHistory('Noon it has', sent), null)
  assert.equal(spokenByHistory('It has', sent), 2)
  assert.equal(spokenByHistory('It', sent), 1)
  assert.equal(spokenByHistory('Something else entirely.', sent), null)
  assert.equal(spokenByHistory('', sent), null)
  assert.equal(spokenByHistory('It has three', []), null)
})

const CHUNKS = ['It has three beds. ', 'The roses are in the second one, ', 'by the wall. ', 'The third is empty.']
const HERS = ['hers', 'hers', 'hers', 'hers']
/** Every chunk went out at time zero (her model wrote the answer at once), and his words arrive at `now`. */
const atOnce = (now, more = {}) => ({ chunks: CHUNKS, kinds: HERS, ats: [0, 0, 0, 0], now, ...more })

test('spokenByClock: each chunk is spoken after the one before it and never before it was sent; a pause is silence', () => {
  const sizes = [4, 7, 3, 4]
  // All sent at once, 2.4 words a second after 500 ms: 4 words by 2,167 ms, 11 by 5,084 ms, all 18 at 8,000 ms.
  assert.deepEqual([0, 500, 917, 2166, 2167, 5083, 5084, 7900, 8100, 60000].map(now => spokenByClock(sizes, [0, 0, 0, 0], now, 500, 2.4)), [0, 0, 1, 3, 4, 10, 11, 17, 18, 18])
  // The last three chunks went out 15 s later (a look): at 15,400 ms only the first four words can have been spoken.
  assert.deepEqual([3000, 15400, 15500, 16000, 17000].map(now => spokenByClock(sizes, [0, 15000, 15000, 15000], now, 500, 2.4)), [4, 4, 4, 5, 7])
  assert.equal(spokenByClock([], [], 1000, 500, 2.4), 0)
})

test('unspoken: where the cut fell by her own entry, the cut sentence said again from its start, cues never said again', () => {
  assert.deepEqual(unspoken(atOnce(3000, { agent: 'It has three beds. The roses' })), { text: REST, by: 'history', spoken: 6, total: 18 })
  // Cut exactly between two sentences: the next one, nothing said twice.
  assert.equal(unspoken(atOnce(3000, { agent: 'It has three beds.' })).text, REST)
  // Cut in the last sentence, with enough of it left.
  assert.equal(unspoken(atOnce(9000, { agent: ANSWER.slice(0, -17) })).text, 'The third is empty.')
  // Fewer than three words left by her own entry: nothing is picked up (it is the end of her answer).
  assert.equal(unspoken(atOnce(9000, { agent: ANSWER.slice(0, -7) })), null)
  assert.equal(unspoken(atOnce(9000, { agent: ANSWER })), null)
  // A later pick-up of the same answer goes straight on from the cut.
  assert.equal(unspoken(atOnce(3000, { agent: 'It has three beds. The roses', again: true })).text, 'are in the second one, by the wall. The third is empty.')
  // A cue that went out first is counted as spoken words but never said again; only cues is nothing.
  const cued = unspoken({ chunks: ['mm-hm... ', ...CHUNKS], kinds: ['cue', ...HERS], ats: [0, 0, 0, 0, 0], now: 3000, agent: 'mm-hm... It has three beds. The roses' })
  // "mm-hm" is one word to the counter.
  assert.deepEqual([cued.text, cued.spoken, cued.total], [REST, 7, 19])
  assert.equal(unspoken({ chunks: ['mm-hm... ', ...CHUNKS], kinds: ['cue', ...HERS], ats: [0, 0, 0, 0, 0], now: 0 }).text, ANSWER)
  assert.equal(unspoken({ chunks: ['mm-hm... ', 'one sec... '], kinds: ['cue', 'cue'], ats: [0, 0], now: 0 }), null)
  assert.equal(unspoken({ chunks: [], kinds: [], ats: [], now: 0 }), null)
  // More than fourteen words of the cut sentence were spoken: she goes straight on.
  const long = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen.'
  assert.equal(unspoken({ chunks: [long], kinds: ['hers'], ats: [0], now: 9000, agent: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen' }).text, 'sixteen seventeen eighteen.')
})

test('unspoken: with no usable entry of hers the clock decides WHETHER (a fast reading) and WHERE (a careful one); near the end of her answer it never picks up', () => {
  assert.deepEqual([RESUME.max, RESUME.heardMs, RESUME.leadMs, RESUME.wordsPerSecond, RESUME.fastLeadMs, RESUME.fastWordsPerSecond, RESUME.fastestWordsPerSecond, RESUME.clockMinWords, RESUME.historyMinWords, RESUME.sentenceWords],
    [3, 700, 500, 2.4, 300, 3.4, 4.5, 5, 3, 14])
  // 4,000 ms; his voice began 700 ms earlier, and both readings stop there. Fast reading: ten of eighteen can have been
  // spoken, eight are left: a pick-up. Careful reading: six words count as spoken.
  assert.deepEqual(unspoken(atOnce(4000)), { text: REST, by: 'clock', spoken: 6, total: 18 })
  assert.equal(unspoken(atOnce(0)).text, ANSWER)
  assert.equal(unspoken(atOnce(1200)).text, ANSWER)
  // The fast reading has fourteen of the eighteen words spoken 4,418 ms in (300 ms + 14 words at 3.4 a second), which
  // is 5,118 ms when his words arrive: from there fewer than five are left, his word may be a reply to what she just
  // said, and nothing is picked up.
  assert.deepEqual([4500, 5000, 5100, 5200, 5594, 60000].map(now => unspoken(atOnce(now))?.by ?? null), ['clock', 'clock', 'clock', null, null, null])
  // A short answer cut early is picked up (nine words, his word two seconds in: three can have been spoken, six are left).
  assert.deepEqual(unspoken({ chunks: ['The roses are by the wall, I think so.'], kinds: ['hers'], ats: [0], now: 2000 }), { text: 'The roses are by the wall, I think so.', by: 'clock', spoken: 1, total: 9 })
  // Never the tail of her closing question, on either evidence: his word may be the answer to it.
  const offer = ['I found two files in the folder you named. ', 'Shall I open the first one?']
  assert.equal(unspoken({ chunks: offer, kinds: ['hers', 'hers'], ats: [0, 0], now: 5000, agent: 'I found two files in the folder you named. Shall I open' }), null)
  assert.equal(unspoken({ chunks: offer, kinds: ['hers', 'hers'], ats: [0, 0], now: 5000 }), null)
  // Early in the first sentence the clock picks up as for any answer (five of fifteen words spoken).
  assert.equal(unspoken({ chunks: offer, kinds: ['hers', 'hers'], ats: [0, 0], now: 3500 }).spoken, 5)
  // With a whole sentence still before the question, it is a cut like any other.
  assert.equal(unspoken({ chunks: offer, kinds: ['hers', 'hers'], ats: [0, 0], now: 2500, agent: 'I found two' }).text, offer.join(''))
  // An entry that does not line up is not evidence: the clock.
  assert.equal(unspoken(atOnce(4000, { agent: 'Something else.' })).by, 'clock')
  // An entry that claims more than she could have spoken in the time (the provider may keep her whole text): the clock.
  assert.deepEqual(unspoken(atOnce(2000, { agent: ANSWER })), { text: ANSWER, by: 'clock', spoken: 1, total: 18 })
  // Clock off (he said nothing, so nothing cut her): only her entry may say words were dropped.
  assert.equal(unspoken(atOnce(4000, { clock: false })), null)
  assert.equal(unspoken(atOnce(4000, { agent: 'Something else.', clock: false })), null)
  assert.equal(unspoken(atOnce(4000, { agent: 'It has three beds. The roses', clock: false })).by, 'history')
  // A pause is silence: the last three chunks went out at 15,000 ms; his word at 17,000 ms cut an answer barely begun.
  assert.deepEqual(unspoken({ chunks: CHUNKS, kinds: HERS, ats: [0, 15000, 15000, 15000], now: 17000 }), { text: REST, by: 'clock', spoken: 5, total: 18 })
})

test('heardReaction: a reaction asks nothing; a question, a stop, real words and long runs are never one', () => {
  for (const text of ['wow', 'Oh my god.', 'holy shit', 'Whoa, okay.', 'oh wow yeah', 'haha nice', 'no way', 'Auma, wow', 'um, amazing', 'fuck yeah']) assert.equal(heardReaction(text), true, text)
  for (const text of ['what?', 'really?', 'wow?', 'wow what is that', 'stop', 'oh wait', 'wow stop', 'and the fourth bed', '', 'um', 'wow wow wow wow wow wow wow']) assert.equal(heardReaction(text), false, text)
  // The reactions are a list of their own: none is a stop phrase, and alone they stay ordinary words to the classifier.
  for (const phrase of REACT_PHRASES) assert.equal(heardKind(phrase), 'words', phrase)
})

test('the adapter hands over her last entry as the provider holds it', () => {
  const shape = history => { const { agent: text, agentAfter } = parse(frame(2, history)); return [text, agentAfter] }
  assert.deepEqual(shape([user(ASK), agent(' It has three beds. The roses '), user('yeah')]), ['It has three beds. The roses', 1])
  // The LAST entry of hers, and how many entries of his come before it.
  assert.deepEqual(shape([user(ASK), agent('Earlier.'), user('x'), agent('Later one'), user('yeah')]), ['Later one', 2])
  assert.deepEqual(shape([agent('Hello first.'), user(ASK)]), ['Hello first.', 0])
  for (const history of [[user(ASK)], [user(ASK), agent('')], [user(ASK), agent('x'.repeat(32001))], [user(ASK), { role: 'agent', content: 7 }]]) {
    assert.deepEqual(shape(history), [undefined, undefined])
  }
})

// ── Her answer is finished here and still playing there ────────────────────────────────────────────────────────────
test('his "yeah" while her finished answer still plays starts no model turn: the cut sentence is said again from its start, then the final', async () => {
  const { fx, provider } = await answered(4000)
  // The provider sends his entry grown by the word (no entry of hers in this history): the clock says six words were spoken.
  provider.json(frame(2, [user(`${ASK} yeah`)]))
  await drain(fx)
  assert.equal(fx.calls.model.length, 1, 'no model turn for a word that only cut her audio')
  assert.equal(said(provider, 2), REST)
  assert.equal(finals(provider, 2), 1)
  assert.deepEqual([fx.bridge.counts.resumes, fx.bridge.counts.resumesByHistory, fx.bridge.counts.resumeLimit], [1, 0, 0])
  // Nothing new was said: her memory holds the one exchange, her words once.
  assert.deepEqual((await storedMemory(fx.bridgeStorage)).exchanges.map(item => [item.heard, item.said]), [[ASK, ANSWER]])
  assert.equal((await turnsOf(fx)).length, 1)
})

test('with her own entry in the history the cut is exact (a word cut short is said again), and it is counted as read from the history', async () => {
  const { fx, provider } = await answered(3000)
  provider.json(frame(2, [user(ASK), agent('It has three beds. The roses are in the sec'), user('Yeah.')]))
  await drain(fx)
  assert.equal(fx.calls.model.length, 1)
  assert.equal(said(provider, 2), REST)
  assert.deepEqual([fx.bridge.counts.resumes, fx.bridge.counts.resumesByHistory], [1, 1])
})

test('an entry of hers that claims the whole answer was spoken in no time is not believed: she says it all again', async () => {
  const { fx, provider } = await answered(0)
  provider.json(frame(2, [user(ASK), agent(ANSWER), user('okay')]))
  await drain(fx)
  assert.equal(fx.calls.model.length, 1)
  assert.equal(said(provider, 2), ANSWER)
  assert.deepEqual([fx.bridge.counts.resumes, fx.bridge.counts.resumesByHistory], [1, 0])
})

test('a reaction and "are you there" pick her up too; a question, real words and a stop do not', async () => {
  for (const words of ['Oh my god.', 'holy shit', 'wow', 'are you there', 'Auma?']) {
    const { fx, provider } = await answered(4000)
    provider.json(frame(2, [user(ASK), user(words)]))
    await drain(fx)
    assert.deepEqual([fx.calls.model.length, said(provider, 2), finals(provider, 2)], [1, REST, 1], words)
  }
  for (const words of ['what?', 'and what is in the fourth bed', 'wow, and the fourth?']) {
    const { fx, provider } = await answered(4000, [() => whole('There is no fourth bed.')])
    provider.json(frame(2, [user(ASK), user(words)]))
    await drain(fx)
    assert.deepEqual([fx.calls.model.length, said(provider, 2).trim(), ownerSaid(fx.calls.model[1])], [2, 'There is no fourth bed.', words], words)
    assert.equal(fx.bridge.counts.resumes, 0)
  }
  const { fx, provider } = await answered(4000)
  provider.json(frame(2, [user(ASK), user('okay, stop')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 2), finals(provider, 2), fx.bridge.counts.stops, fx.bridge.counts.resumes], [1, '', 1, 1, 0])
})

test('long after she finished speaking the same word is a turn of his own, as before', async () => {
  const { fx, provider } = await answered(60000, [() => whole('Glad it helps.')])
  provider.json(frame(2, [user(ASK), agent(ANSWER), user('okay')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 2).trim(), ownerSaid(fx.calls.model[1]), fx.bridge.counts.resumes], [2, 'Glad it helps.', 'okay', 0])
})

test('his words after a pick-up are answered alone: the word that cut her is finished with', async () => {
  const { fx, provider } = await answered(4000, [() => whole('There is no fourth bed.')])
  provider.json(frame(2, [user(`${ASK} yeah`)]))
  await drain(fx)
  fx.clock.advance(30000)
  provider.json(frame(3, [user(`${ASK} yeah and the fourth bed`)]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, ownerSaid(fx.calls.model[1]), said(provider, 3).trim()], [2, 'and the fourth bed', 'There is no fourth bed.'])
})

test('a room that keeps cutting her still moves forward: later pick-ups go straight on, three at most, then his word is a turn again', async () => {
  const { fx, provider } = await answered(4000, [() => whole('Yes?')])
  provider.json(frame(2, [user(ASK), user('yeah')]))
  await drain(fx)
  assert.equal(said(provider, 2), REST)
  // 3,000 ms into the pick-up (fourteen words): four count as spoken; no sentence is started over this time.
  fx.clock.advance(3000)
  provider.json(frame(3, [user(ASK), user('yeah'), user('mm-hm')]))
  await drain(fx)
  assert.equal(said(provider, 3), 'the second one, by the wall. The third is empty.')
  // 2,000 ms into that one (ten words): one more word counts as spoken.
  fx.clock.advance(2000)
  provider.json(frame(4, [user(ASK), user('yeah'), user('mm-hm'), user('right')]))
  await drain(fx)
  assert.equal(said(provider, 4), 'second one, by the wall. The third is empty.')
  assert.deepEqual([fx.calls.model.length, fx.bridge.counts.resumes, fx.bridge.counts.resumeLimit], [1, 3, 0])
  // The fourth cut of the same answer is not picked up: his word is a turn of his own, as it was before this lane.
  fx.clock.advance(1000)
  provider.json(frame(5, [user(ASK), user('yeah'), user('mm-hm'), user('right'), user('okay')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, ownerSaid(fx.calls.model[1]), said(provider, 5).trim(), fx.bridge.counts.resumes, fx.bridge.counts.resumeLimit], [2, 'okay', 'Yes?', 3, 1])
})

test('a provider retry of a picked-up event replays its words and the final, and starts nothing', async () => {
  const { fx, provider } = await answered(4000)
  provider.json(frame(2, [user(`${ASK} yeah`)]))
  await drain(fx)
  const mark = agentFrames(provider).length
  provider.json(frame(2, [user(`${ASK} yeah`)]))
  await drain(fx)
  assert.deepEqual(agentFrames(provider).slice(mark).map(item => [item.event_id, item.content ?? '', item.is_final === true]), [[2, REST, false], [2, '', true]])
  assert.deepEqual([fx.calls.model.length, fx.bridge.counts.resumes], [1, 1])
})

// ── Her answer is still being written ────────────────────────────────────────────────────────────────────────────────
test('her turn is live and he says "okay": the words already sent are said again under the new id, her later words follow, and her memory holds them once', async () => {
  const stream = liveStream()
  const { fx, provider } = await call([() => stream.response])
  provider.json(frame(1, [user(ASK)]))
  await drain(fx)
  stream.push(start() + textOpen() + textPiece('It has three beds. The roses are in the second one, by the wall. And then'))
  await drain(fx)
  assert.equal(said(provider, 1).trim(), 'It has three beds. The roses are in the second one, by the wall.')
  // One second later nothing of it can have been spoken yet.
  fx.clock.advance(1000)
  provider.json(frame(2, [user(`${ASK} okay`)]))
  await drain(fx)
  assert.equal(stream.cancelled, false)
  assert.equal(said(provider, 2).trim(), 'It has three beds. The roses are in the second one, by the wall.')
  stream.push(textPiece(' the third is empty.') + textClose() + stop())
  stream.end()
  await drain(fx)
  assert.equal(said(provider, 2).replace(/\s+/g, ' ').trim(), 'It has three beds. The roses are in the second one, by the wall. And then the third is empty.')
  assert.deepEqual([finals(provider, 1), finals(provider, 2), fx.calls.model.length], [0, 1, 1])
  assert.deepEqual((await storedMemory(fx.bridgeStorage)).exchanges.map(item => item.said.replace(/\s+/g, ' ').trim()), ['It has three beds. The roses are in the second one, by the wall. And then the third is empty.'])
  const [turn] = await turnsOf(fx)
  assert.deepEqual([turn.outcome, turn.resumed], ['answered', 1])
  assert.deepEqual([fx.bridge.counts.resumes, fx.bridge.counts.backchannelsKept], [1, 1])
})

test('her turn is live and he says "wow": a reaction is carried as a keep is, and her words go on; real words still cut the turn', async () => {
  const stream = liveStream()
  const { fx, provider } = await call([() => stream.response, () => whole('There is no fourth bed.')])
  provider.json(frame(1, [user(ASK)]))
  await drain(fx)
  stream.push(start() + textOpen() + textPiece('It has three beds. The roses are in the second one, by the wall. And then'))
  await drain(fx)
  fx.clock.advance(4000)
  provider.json(frame(2, [user(ASK), agent('It has three beds. The roses'), user('Wow.')]))
  await drain(fx)
  assert.equal(stream.cancelled, false)
  assert.equal(said(provider, 2).trim(), 'The roses are in the second one, by the wall.')
  assert.deepEqual([fx.bridge.counts.resumes, fx.bridge.counts.resumesByHistory], [1, 1])
  fx.clock.advance(1000)
  provider.json(frame(3, [user(ASK), agent('It has three beds. The roses'), user('Wow.'), user('and the fourth bed')]))
  await drain(fx)
  assert.equal(stream.cancelled, true)
  assert.deepEqual([fx.calls.model.length, said(provider, 3).trim()], [2, 'There is no fourth bed.'])
})

test('the same words again under a new id cut nothing: nothing is said twice without her own entry saying so', async () => {
  const stream = liveStream()
  const { fx, provider } = await call([() => stream.response])
  provider.json(frame(1, [user(ASK)]))
  await drain(fx)
  stream.push(start() + textOpen() + textPiece('It has three beds. The roses are in the second one, by the wall. And then'))
  await drain(fx)
  fx.clock.advance(1000)
  // The provider sends the same entry again (he said nothing): no clock guess, so nothing is repeated.
  provider.json(frame(2, [user(ASK)]))
  await drain(fx)
  assert.deepEqual([said(provider, 2), fx.bridge.counts.resumes], ['', 0])
  // The same again, and this time her entry shows where her audio stopped: the rest is said again.
  fx.clock.advance(3000)
  provider.json(frame(3, [user(ASK), agent('It has three beds. The roses')]))
  await drain(fx)
  assert.equal(said(provider, 3).trim(), 'The roses are in the second one, by the wall.')
  assert.deepEqual([fx.bridge.counts.resumes, fx.bridge.counts.resumesByHistory], [1, 1])
})


// ── The review of 2026-11-18 (one independent reviewer, eight failing probes on the first version) ──────────────────
test('REVIEW: his "yes" to a question she just asked is answered, never swallowed by a pick-up; a second "yes" too', async () => {
  const OFFER = 'I found two files. Shall I open the first one?'
  const { fx, provider } = await call([() => whole(OFFER), () => whole('Opening it now.'), () => whole('It is open.')])
  provider.json(frame(1, [user('find the voice spec')]))
  await drain(fx)
  // Ten words take about five seconds to say: his "yes" comes as she finishes.
  fx.clock.advance(5000)
  provider.json(frame(2, [user('find the voice spec'), user('yes')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 2).trim(), ownerSaid(fx.calls.model[1]), fx.bridge.counts.resumes], [2, 'Opening it now.', 'yes', 0])
  fx.clock.advance(3000)
  provider.json(frame(3, [user('find the voice spec'), user('yes'), user('yes')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 3).trim(), fx.bridge.counts.resumes], [3, 'It is open.', 0])
  // The same words in the same place for every assent that is also an answer.
  for (const words of ['okay', 'sure', 'go ahead', 'of course', 'exactly', 'hello']) {
    const again = await call([() => whole(OFFER), () => whole('Opening it now.')])
    again.provider.json(frame(1, [user('find the voice spec')]))
    await drain(again.fx)
    again.fx.clock.advance(5000)
    again.provider.json(frame(2, [user('find the voice spec'), user(words)]))
    await drain(again.fx)
    assert.deepEqual([again.fx.calls.model.length, again.fx.bridge.counts.resumes], [2, 0], words)
  }
})

test('REVIEW: a look is silence, never speech: a "yeah" two seconds into the answer that followed it picks the answer up', async () => {
  const { fx, provider, tab } = await call([
    () => { const stream = liveStream(); stream.push(start() + textOpen() + textPiece('Let me look. ') + textClose() + toolUse(1, 'toolu_01Look', LOOK_TOOL, { tool: 'x6_self_state', arguments: '{}' }) + stopForTools()); stream.end(); return stream.response },
    () => whole(ANSWER), () => whole('Mm-hm.')])
  provider.json(frame(1, [user(ASK)]))
  await drain(fx)
  fx.clock.advance(15000)
  for (const item of tab.frames().filter(sent => sent.t === 'tool')) tab.json({ t: 'tool_result', turn: item.turn, call: item.call, ok: true, text: '{}' })
  await drain(fx)
  assert.equal(said(provider, 1).includes('The third is empty.'), true)
  fx.clock.advance(2000)
  provider.json(frame(2, [user(ASK), user('yeah')]))
  await drain(fx)
  assert.equal(fx.calls.model.length, 2, 'no model turn on "yeah"')
  // The preface before the look was spoken long ago and is not said again; her answer is, from its start.
  assert.equal(said(provider, 2).trim(), ANSWER)
})

test('REVIEW: a pause in her stream is silence too: words sent one second before his "yeah" are picked up', async () => {
  const stream = liveStream()
  const { fx, provider } = await call([() => stream.response])
  provider.json(frame(1, [user(ASK)]))
  await drain(fx)
  stream.push(start() + textOpen() + textPiece('It has three beds. '))
  await drain(fx)
  fx.clock.advance(12000)
  stream.push(textPiece(REST) + textClose() + stop())
  stream.end()
  await drain(fx)
  fx.clock.advance(1000)
  provider.json(frame(2, [user(ASK), user('yeah')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 2).trim()], [1, REST])
})

test('REVIEW: a question is never a reaction, also when the provider sends it as his entry grown ("true?", "wow?", "no way?")', async () => {
  for (const question of ['true?', 'wow?', 'no way?', 'right?']) {
    const stream = liveStream()
    const { fx, provider } = await call([() => stream.response, () => whole('Yes, really.')])
    provider.json(frame(1, [user(ASK)]))
    await drain(fx)
    stream.push(start() + textOpen() + textPiece('It has three beds. The roses are in the second one, by the wall. And then'))
    await drain(fx)
    fx.clock.advance(3000)
    provider.json(frame(2, [user(`${ASK} ${question}`)]))
    await drain(fx)
    if (question === 'right?') {
      // "right" is a keep word: a live turn is carried on it as it always was (and her words go on); it is no reaction.
      assert.deepEqual([stream.cancelled, fx.calls.model.length], [false, 1], question)
      continue
    }
    assert.deepEqual([stream.cancelled, fx.calls.model.length, ownerSaid(fx.calls.model[1])], [true, 2, question], question)
  }
  // With her answer finished here, a keep word said as a question is his question: a turn of his own.
  const { fx, provider } = await answered(4000, [() => whole('Yes, by the wall.')])
  provider.json(frame(2, [user(ASK), user('Right?')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, ownerSaid(fx.calls.model[1]), fx.bridge.counts.resumes], [2, 'Right?', 0])
})

test('REVIEW: her OLDER reply in the history, even the same words, says nothing about this one ("say that again")', async () => {
  const { fx, provider } = await call([() => whole(ANSWER), () => whole(ANSWER), () => whole('Mm.')])
  provider.json(frame(1, [user(ASK)]))
  await drain(fx)
  fx.clock.advance(20000)
  provider.json(frame(2, [user(ASK), agent(ANSWER), user('say that again')]))
  await drain(fx)
  assert.equal(said(provider, 2).trim(), ANSWER)
  fx.clock.advance(4000)
  // Her last entry is still the FIRST answer (it comes before "say that again"): the clock decides, not that entry.
  provider.json(frame(3, [user(ASK), agent(ANSWER), user('say that again'), user('yeah')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 3), fx.bridge.counts.resumes, fx.bridge.counts.resumesByHistory], [2, REST, 1, 0])
})

test('REVIEW: a turn handed to her working self that has only said its hand-off line is not "talking": nothing of it is said twice', async () => {
  const { fx } = await answered(0)
  // The guard is read from the source: a handed turn with no words from her tab yet never asks what was unspoken.
  assert.equal(typeof fx.bridge.unspokenOf, 'function')
  const source = (await import('node:fs')).readFileSync(new URL('../voice-bridge-do.mjs', import.meta.url), 'utf8')
  assert.match(source, /const talking = !\(fastWorking && !fast\.answering\) && !\(handed && older\.tabWordsAt === undefined\)/)
})

// ── The second review (one more independent reviewer, six failing probes on the first fixes) ─────────────────────────
test('REVIEW 2: a "yeah" early in a SHORT answer picks it up (the clock stops where his voice began, not where his words arrived)', async () => {
  for (const [answer, ms] of [['The roses are by the wall, I think.', 2000], ['The roses are in the second bed, right by the wall.', 2500]]) {
    const { fx, provider } = await call([() => whole(answer), () => whole('Mm-hm.')])
    provider.json(frame(1, [user(ASK)]))
    await drain(fx)
    fx.clock.advance(ms)
    provider.json(frame(2, [user(ASK), user('yeah')]))
    await drain(fx)
    assert.deepEqual([fx.calls.model.length, said(provider, 2).trim()], [1, answer], answer)
  }
})

test('REVIEW 2: a frame with nothing new on a FINISHED answer whose entry shows dropped words picks them up; the clock is not asked', async () => {
  const { fx, provider } = await answered(3000)
  // A sound cut her audio and left no words of his: the history ends with her entry, cut after six words.
  provider.json(frame(2, [user(ASK), agent('It has three beds. The roses')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 2).trim(), finals(provider, 2), fx.bridge.counts.resumes, fx.bridge.counts.resumesByHistory, fx.bridge.counts.nothingNew], [1, REST, 1, 1, 1, 1])
  // The same frame with no entry of hers that shows a cut: closed empty, as before.
  const other = await answered(3000)
  other.provider.json(frame(2, [user(ASK), agent('Something older.')]))
  await drain(other.fx)
  assert.deepEqual([said(other.provider, 2), finals(other.provider, 2), other.fx.bridge.counts.resumes], ['', 1, 0])
})

test('REVIEW 2: an event closed empty remembers the answer before it: a later "yeah" still finds her words', async () => {
  const { fx, provider } = await answered(1000)
  // The provider holds her whole sent text (more than she can have spoken in a second): not believed, nothing picked up.
  provider.json(frame(2, [user(ASK), agent(ANSWER)]))
  await drain(fx)
  assert.deepEqual([said(provider, 2), fx.bridge.counts.resumes], ['', 0])
  fx.clock.advance(2000)
  provider.json(frame(3, [user(ASK), agent(ANSWER), user('yeah')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 3), fx.bridge.counts.resumes], [1, REST, 1])
  // After his stop nothing is picked up, whatever came before it.
  const stopped = await answered(2000, [() => whole('Yes?')])
  stopped.provider.json(frame(2, [user(ASK), user('stop')]))
  await drain(stopped.fx)
  stopped.fx.clock.advance(500)
  stopped.provider.json(frame(3, [user(ASK), user('stop'), user('okay')]))
  await drain(stopped.fx)
  assert.deepEqual([stopped.fx.calls.model.length, stopped.fx.bridge.counts.resumes], [2, 0])
})

test('REVIEW 2: his "yes" when her own entry shows only the end of her closing question unspoken is answered, not swallowed', async () => {
  const OFFER = 'I found two files in the folder you named. Shall I open the first one?'
  const { fx, provider } = await call([() => whole(OFFER), () => whole('Opening it now.')])
  provider.json(frame(1, [user('find the voice spec')]))
  await drain(fx)
  fx.clock.advance(5000)
  provider.json(frame(2, [user('find the voice spec'), agent('I found two files in the folder you named. Shall I open'), user('yes')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 2).trim(), ownerSaid(fx.calls.model[1]), fx.bridge.counts.resumes], [2, 'Opening it now.', 'yes', 0])
})
