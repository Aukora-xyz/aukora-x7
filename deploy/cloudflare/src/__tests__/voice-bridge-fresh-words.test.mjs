/** She answers only what is new, and once. The provider's history
 * (`user` and `agent` entries, as its speech-engine upstream page documents them) is read by the adapter (A); only his
 * words that are new since she last answered start a turn (B); a model call never says its answer when his merged words
 * wait: they are folded in and the call runs again (C). The real Worker, the real VoiceBridgeDO, HEAD's REAL turn journal,
 * budget and dispatcher (voice-bridge-fakes.mjs); only the provider's network and her tab are faked. No network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFrames, fixtureAfterHello, settle, storedMemory } from './voice-bridge-fakes.mjs'
import { HISTORY_KEY, heardAfter, plainWords } from '../voice-bridge-do.mjs'
import { FAST_HEARD_FENCE, LOOK_TOOL, searchHeard } from '../voice-fast.mjs'
import { PROVIDER_ENTRY_MAX_CHARS, PROVIDER_TRANSCRIPT_MAX_CHARS, parse } from '../voice-provider-speech-engine.mjs'
import { CUSTOM_LLM_ADAPTER, CUSTOM_LLM_CONVERSATION_HEADER } from '../voice-provider-custom-llm.mjs'

const frame = (eventId, history) => JSON.stringify({ type: 'user_transcript', event_id: eventId, user_transcript: history })
const user = content => ({ role: 'user', content })
const agent = content => ({ role: 'agent', content })

// ── A. The adapter says what the history is ────────────────────────────────────────────────────────────────────────
test('parse says whether the history ends with his entry or hers, and how many entries are his', () => {
  assert.deepEqual(parse(frame(3, [user('hello'), agent('Hi.'), user('The rain stopped. Yeah.')])),
    { kind: 'transcript', eventId: 3, text: 'The rain stopped. Yeah.', tail: 'user', users: 2, agent: 'Hi.', agentAfter: 1 })
  assert.deepEqual(parse(frame(4, [user('hello'), agent('Hi.'), user('what time is it'), agent('Noon.')])),
    { kind: 'transcript', eventId: 4, text: 'what time is it', tail: 'agent', users: 2, agent: 'Noon.', agentAfter: 2 })
  // The shape also carries `agent`, her last entry as the provider holds it, and `agentAfter`, how
  // many entries of his come before it (both undefined when there is none).
  assert.deepEqual(parse(frame(1, [])), { kind: 'transcript', eventId: 1, text: '', tail: undefined, users: 0, agent: undefined, agentAfter: undefined })
  assert.deepEqual(parse(frame(2, [user('hi'), { role: 'system', content: 'x' }])), { kind: 'transcript', eventId: 2, text: 'hi', tail: undefined, users: 1, agent: undefined, agentAfter: undefined })
  assert.deepEqual(parse(frame(2, [user('hi'), 'not an entry'])), { kind: 'transcript', eventId: 2, text: 'hi', tail: undefined, users: 1, agent: undefined, agentAfter: undefined })
})

test('the entry bound is 32,000 characters (over it: empty, as before); the 4,000 bound stays for one turn', () => {
  assert.deepEqual([PROVIDER_ENTRY_MAX_CHARS, PROVIDER_TRANSCRIPT_MAX_CHARS], [32000, 4000])
  const long = 'word '.repeat(1200).trim()
  assert.equal(parse(frame(1, [user(long)])).text, long)
  assert.equal(parse(frame(1, [user('x'.repeat(PROVIDER_ENTRY_MAX_CHARS))])).text.length, PROVIDER_ENTRY_MAX_CHARS)
  assert.equal(parse(frame(1, [user('x'.repeat(PROVIDER_ENTRY_MAX_CHARS + 1))])).text, '')
})

test('the provider door passes the history shape to transcript()', async () => {
  const fx = fixtureAfterHello()
  const { provider } = await fx.connect()
  const seen = []
  const real = fx.bridge.transcript.bind(fx.bridge)
  fx.bridge.transcript = (record, eventId, text, arrivedAt, shape) => { seen.push({ eventId, text, shape }); return real(record, eventId, text, arrivedAt, shape) }
  provider.json(frame(1, [user('hello'), agent('Hi.'), user('what time is it')]))
  await settle(fx.bridge)
  assert.deepEqual(seen, [{ eventId: 1, text: 'what time is it', shape: { tail: 'user', users: 2, agent: 'Hi.', agentAfter: 1 } }])
})

test('the custom-LLM skeleton says the same: users from its count, tail from its last message', async () => {
  const headers = new Headers({ [CUSTOM_LLM_CONVERSATION_HEADER]: 'conv_1' })
  const body = messages => JSON.stringify({ model: 'auma-voice-home', stream: true, messages })
  const ends = async messages => (await CUSTOM_LLM_ADAPTER.toBridgeEvents(body(messages), headers)).events[1]
  assert.deepEqual(await ends([{ role: 'system', content: 's' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]),
    { kind: 'transcript', eventId: 2, text: 'c', tail: 'user', users: 2 })
  assert.deepEqual(await ends([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]), { kind: 'transcript', eventId: 1, text: 'a', tail: 'agent', users: 1 })
  assert.deepEqual(await ends([{ role: 'user', content: 'a' }, { role: 'system', content: 'b' }]), { kind: 'transcript', eventId: 1, text: 'a', tail: undefined, users: 1 })
})

// ── B. Only what is new is answered ────────────────────────────────────────────────────────────────────────────────
// The fast voice on the anthropic wire, as live (voice-bridge-fast-claude.test.mjs writes the same stream shapes).
const CLAUDE_ENV = Object.freeze({ VOICE_FAST_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-claude-test-value-not-a-key-0123456789',
  PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '1000', PROVIDER_BUDGET_TOKENS: '50000000', PROVIDER_MAX_OUTPUT_TOKENS: '256000' })
const encoder = new TextEncoder()
const sse = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
const start = () => sse({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-fable-5-2', content: [] } })
const textOpen = () => sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
const textPiece = text => sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
const textClose = () => sse({ type: 'content_block_stop', index: 0 })
const stop = () => sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }) + sse({ type: 'message_stop' })
const thinking = () => sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
  + sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } })
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
/** What the model was told he said in a request: the part of his last message after the label OWNER SAID line. */
const ownerSaid = call => { const content = bodyOf(call).messages.findLast(message => message.role === 'user' && typeof message.content === 'string').content; return content.slice(content.lastIndexOf(FAST_HEARD_FENCE) + FAST_HEARD_FENCE.length + 1) }
const finals = (provider, eventId) => agentFrames(provider).filter(item => item.event_id === eventId && item.is_final === true).length
const said = (provider, eventId) => agentFrames(provider).filter(item => item.event_id === eventId && item.content).map(item => item.content).join('')
async function call(answers) {
  let n = 0
  const fx = fixtureAfterHello({ env: CLAUDE_ENV, modelFetch: () => { const next = answers[Math.min(n++, answers.length - 1)]; return typeof next === 'function' ? next() : next } })
  return { fx, ...await fx.connect() }
}

test('heardAfter gives his own text after the words finished with', () => {
  assert.equal(heardAfter("The rain stopped. Yeah. We don't want to get wet now.", 4), "We don't want to get wet now.")
  // Counted on plain words: "uh huh" is two here, so an entry that grows by "huh …" after an "uh" is still seen to grow.
  assert.equal(heardAfter('uh huh what now', 1), 'huh what now')
  assert.equal(heardAfter('Uh, huh! ok', 2), 'ok')
  assert.equal(heardAfter('Hello — wait, what?', 1), 'wait, what?')
  assert.equal(heardAfter("it's 5 o'clock, well-known fact", 3), 'well-known fact')
  assert.equal(heardAfter('one two', 2), '')
  assert.equal(heardAfter('  all of it  ', 0), 'all of it')
  // A cut inside a run with no space, or more words asked than the text has: null (the caller takes the whole entry).
  assert.equal(heardAfter('goodbye.Yeah', 1), null)
  assert.equal(heardAfter('one two', 3), null)
  for (const [text, count] of [['mañana por la tarde vamos', 2], ['one   two\n\nthree', 1], ['🙂 hello there 🙂 friend', 1]]) {
    assert.deepEqual(plainWords(heardAfter(text, count)), plainWords(text).slice(count), text)
  }
})

test('an invented sequence of the live shape: an entry that grows while she answers; each turn is told only his new sentence', async () => {
  const A = 'The rain stopped. Yeah.'
  const B = "We don't want to get wet now."
  const C = "He said, 'Later.'"
  const streams = [liveStream(), liveStream(), liveStream()]
  const { fx, provider } = await call(streams.map(stream => () => stream.response))
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  streams[0].push(start() + textOpen() + textPiece('Good that it stopped, and I hope it stays dry. And then'))
  await drain(fx)
  assert.equal(said(provider, 1).trim(), 'Good that it stopped, and I hope it stays dry.')
  // He (or the room) speaks again: the provider sends the SAME entry, grown.
  provider.json(frame(2, [user(`${A} ${B}`)]))
  await drain(fx)
  assert.equal(fx.calls.model.length, 2)
  assert.equal(ownerSaid(fx.calls.model[1]), B)
  streams[1].push(start() + textOpen() + textPiece('That is all right, we can stay in. We may'))
  await drain(fx)
  provider.json(frame(3, [user(`${A} ${B} ${C}`)]))
  await drain(fx)
  assert.equal(fx.calls.model.length, 3)
  assert.equal(ownerSaid(fx.calls.model[2]), C)
  streams[2].push(start() + textOpen() + textPiece('Then we stay in.') + textClose() + stop())
  streams[2].end()
  await drain(fx)
  // Her memory holds each of his sentences once, never an earlier one again; the cut answers are marked.
  const memory = await storedMemory(fx.bridgeStorage)
  assert.deepEqual(memory.exchanges.map(item => item.heard), [A, B, C])
  assert.deepEqual(memory.exchanges.map(item => item.ended), ['cut', 'cut', 'answered'])
  // The third request's history shows the first two as interrupted replies, his words once each.
  const history = bodyOf(fx.calls.model[2]).messages.filter(message => message.role === 'user').map(message => message.content)
  assert.deepEqual(history.slice(0, 2), [A, B])
  assert.deepEqual([fx.bridge.counts.grownTurns, fx.bridge.counts.nothingNew], [2, 0])
  const turns = (await fx.bridgeStorage.get(HISTORY_KEY)).turns
  // As stored, oldest first: the first turn took the whole entry, the next two only its new words.
  assert.deepEqual(turns.map(item => item.grown), [0, 1, 1])
})

test('the same entry again after her answer (the history ends with her entry) starts no turn; a retry of that id is answered', async () => {
  const A = 'what time is it'
  const { fx, provider } = await call([() => whole('It is noon.'), () => whole('Noon, as I said.')])
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  assert.equal(said(provider, 1), 'It is noon.')
  // He stays silent and the provider asks again: the same history, now ending with her reply.
  provider.json(frame(2, [user(A), agent('It is noon.')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 2), finals(provider, 2)], [1, '', 1])
  provider.json(frame(2, [user(A), agent('It is noon.')]))
  await drain(fx)
  assert.equal(finals(provider, 2), 2)
  // (The retry of id 2 is answered before anything is counted.)
  assert.deepEqual([fx.bridge.counts.nothingNew, fx.bridge.counts.agentTailEvents], [1, 1])
  // Her memory holds the one exchange, once.
  assert.deepEqual((await storedMemory(fx.bridgeStorage)).exchanges.map(item => item.heard), [A])
  // The same entry again with HIS entry last: the provider holds no reply of hers after it (he may not have heard it to
  // the end), so it is answered, as before this lane.
  provider.json(frame(3, [user(A)]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 3), fx.bridge.counts.nothingNew], [2, 'Noon, as I said.', 1])
})

test('the same words as a NEW entry (he said them again) are a new turn', async () => {
  const A = 'hello?'
  const { fx, provider } = await call([() => whole('I am here.'), () => whole('Still here.')])
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  // the voice fix (CHANGED: time now passes before he speaks again; in no time at all she cannot have spoken her answer,
  // and "hello?" would pick it up instead, see voice-bridge-resume.test.mjs).
  fx.clock.advance(5000)
  provider.json(frame(2, [user(A), agent('I am here.'), user(A)]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 2), ownerSaid(fx.calls.model[1])], [2, 'Still here.', A])
  assert.equal(fx.bridge.counts.nothingNew, 0)
})

test('words she has not answered stay in the next turn (a turn cut while it only worked)', async () => {
  const A = 'what is the build number'
  const more = 'no wait, look at main'
  const working = liveStream()
  const { fx, provider } = await call([() => working.response, () => whole('Main is green.')])
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  working.push(start() + thinking())
  await drain(fx)
  // His words hold a stop phrase, so they are never merged: her working turn is cut. It said nothing: A is still open.
  provider.json(frame(2, [user(`${A} ${more}`)]))
  await drain(fx)
  assert.equal(ownerSaid(fx.calls.model[1]), `${A} ${more}`)
  assert.equal(said(provider, 2), 'Main is green.')
  assert.equal(fx.bridge.counts.grownTurns, 0)
})

test('after her answer, an entry that grew by his stop is his stop: no turn', async () => {
  const A = 'tell me about the witness'
  const { fx, provider } = await call([() => whole('It stamps my record.')])
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  provider.json(frame(2, [user(`${A} Okay, stop.`)]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, fx.bridge.counts.stops, finals(provider, 2), said(provider, 2)], [1, 1, 1, ''])
  // What he says after his stop is new: only those words.
  provider.json(frame(3, [user(`${A} Okay, stop. And the relays?`)]))
  await drain(fx)
  assert.equal(ownerSaid(fx.calls.model[1]), 'And the relays?')
})

test('A/B: an entry that grew past 4,000 characters is answered on its short new words; 4,000 new characters are refused', async () => {
  const A = 'word '.repeat(798).trim()
  const B = 'and what about tomorrow?'
  const { fx, provider } = await call([() => whole('Yes.'), () => whole('Tomorrow is free.')])
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  assert.equal(said(provider, 1), 'Yes.')
  assert.ok(`${A} ${B}`.length > PROVIDER_TRANSCRIPT_MAX_CHARS)
  provider.json(frame(2, [user(`${A} ${B}`)]))
  await drain(fx)
  assert.deepEqual([ownerSaid(fx.calls.model[1]), said(provider, 2)], [B, 'Tomorrow is free.'])
  // A new entry whose own words are over the bound: refused with the empty final, as before.
  const refused = fx.bridge.counts.transcriptsRefused
  provider.json(frame(3, [user(A), agent('Yes.'), user('x'.repeat(PROVIDER_TRANSCRIPT_MAX_CHARS + 1))]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, fx.bridge.counts.transcriptsRefused - refused, finals(provider, 3)], [2, 1, 1])
})

test('an adapter that says nothing of the history: an exact repeat is a new turn as before; a grown entry still gives only its new words', async () => {
  const A = 'what time is it'
  const { fx, provider, conv } = await call([() => whole('Noon.'), () => whole('Still noon.'), () => whole('Sunny.')])
  const record = fx.bridge.convs.get(conv)
  const hear = (eventId, text) => fx.bridge.serial(() => fx.bridge.transcript(record, eventId, text, fx.clock.now()))
  await hear(1, A)
  await drain(fx)
  await hear(2, A)
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 2), fx.bridge.counts.nothingNew], [2, 'Still noon.', 0])
  await hear(3, `${A} and the weather`)
  await drain(fx)
  assert.equal(ownerSaid(fx.calls.model[2]), 'and the weather')
})

// ── Review fixes (two independent reviewers, 2026-11-18) ────────────────
const toolUse = (index, id, name, input) => sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } })
  + sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) + sse({ type: 'content_block_stop', index })
const stopForTools = () => sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }) + sse({ type: 'message_stop' })

test('words he added that her answer never read stay open when the follow-up call is cut', async () => {
  const A = 'what is the build number'
  const B = 'and is the witness on'
  const C = 'no wait, tell me the relay count'
  const streams = [liveStream(), liveStream(), liveStream()]
  const { fx, provider } = await call(streams.map(stream => () => stream.response))
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  streams[0].push(start())
  await drain(fx)
  provider.json(frame(2, [user(`${A} ${B}`)]))
  await drain(fx)
  assert.equal(fx.bridge.counts.wordsMerged, 1)
  // Her answer to A is spoken whole; the follow-up call for B starts and has said nothing.
  streams[0].push(textOpen() + textPiece('The build is forty two.') + textClose() + stop())
  streams[0].end()
  await drain(fx)
  assert.equal(fx.calls.model.length, 2)
  // His next words hold a stop phrase (never merged): the follow-up call is cut. B was never answered: it stays in.
  provider.json(frame(3, [user(`${A} ${B} ${C}`)]))
  await drain(fx)
  assert.equal(streams[1].cancelled, true)
  assert.equal(ownerSaid(fx.calls.model[2]), `${B} ${C}`)
})

test('a line said before a look is not an answer: his words stay open while the look runs', async () => {
  const A = 'what is the build number on main'
  const more = 'no wait, on the deploy branch'
  const { fx, provider } = await call([
    () => { const stream = liveStream(); stream.push(start() + textOpen() + textPiece('Let me look. ') + textClose() + toolUse(1, 'toolu_01Look', LOOK_TOOL, { tool: 'x6_self_state', arguments: '{}' }) + stopForTools()); stream.end(); return stream.response },
    () => whole('It is build nine on deploy.'),
  ])
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  assert.equal(said(provider, 1).includes('Let me look.'), true)
  // Her look is still running at the tab (never answered here). His words hold a stop phrase: the turn is cut.
  provider.json(frame(2, [user(`${A} ${more}`)]))
  await drain(fx)
  assert.equal(ownerSaid(fx.calls.model[1]), `${A} ${more}`)
})

test('the same words as a new entry are answered even when the history ends with her entry', async () => {
  const { fx, provider } = await call([() => whole('Done. Shall I also check main?'), () => whole('Main is green.')])
  provider.json(frame(1, [user('yes')]))
  await drain(fx)
  // the voice fix (CHANGED: time passes, as above; her six words were spoken before his second "yes").
  fx.clock.advance(5000)
  provider.json(frame(2, [user('yes'), agent('Done. Shall I also check main?'), user('yes'), agent('Mm.')]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, said(provider, 2), fx.bridge.counts.nothingNew], [2, 'Main is green.', 0])
})

test('a grown turn that waits and is sent again under a new id is answered once and counted once', async () => {
  let failCancel = 1
  let n = 0
  const first = liveStream()
  const answers = [() => first.response, () => whole('Then we stay in.'), () => whole('extra')]
  const fx = fixtureAfterHello({ env: CLAUDE_ENV, modelFetch: () => answers[Math.min(n++, answers.length - 1)](),
    journalFault: body => (body.action === 'cancel' && failCancel-- > 0 ? Response.json({ ok: false, code: 'DOWN' }, { status: 503 }) : undefined) })
  const { provider, conv } = await fx.connect()
  const grownEntry = "The rain stopped. Yeah. We don't want to go."
  provider.json(frame(1, [user('The rain stopped. Yeah.')]))
  await drain(fx)
  first.push(start() + textOpen() + textPiece('Good that it stopped, and I hope it stays dry. And then'))
  await drain(fx)
  provider.json(frame(2, [user(grownEntry)]))
  await drain(fx)
  assert.equal(fx.bridge.convs.get(conv).turns.get(2).state, 'held')
  provider.json(frame(3, [user(grownEntry)]))
  await drain(fx)
  fx.clock.advance(5000)
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, ownerSaid(fx.calls.model[1]), fx.bridge.counts.grownTurns, fx.bridge.counts.transcriptsRefused], [2, "We don't want to go.", 1, 0])
  assert.equal(said(provider, 3).includes('Then we stay in.'), true)
})

test('an assent word added to a grown turn that is still thinking is a keep, never a barge-in', async () => {
  const A = 'what is the build'
  const B = 'and is main green'
  const streams = [liveStream(), liveStream(), liveStream()]
  const { fx, provider } = await call(streams.map(stream => () => stream.response))
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  streams[0].push(start() + textOpen() + textPiece('It is build nine, the one from this morning. And'))
  await drain(fx)
  provider.json(frame(2, [user(`${A} ${B}`)]))
  await drain(fx)
  streams[1].push(start() + thinking())
  await drain(fx)
  provider.json(frame(3, [user(`${A} ${B} okay`)]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, fx.bridge.counts.backchannelsKept, streams[1].cancelled], [2, 1, false])
})

test('after his stop while she answers, his next words do not bring back what he stopped', async () => {
  const A = 'tell me everything about the witness'
  const streams = [liveStream(), liveStream()]
  const { fx, provider } = await call(streams.map(stream => () => stream.response))
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  streams[0].push(start() + textOpen() + textPiece('The witness stamps my record. It'))
  await drain(fx)
  provider.json(frame(2, [user(`${A} stop`)]))
  await drain(fx)
  provider.json(frame(3, [user(`${A} stop what time is it`)]))
  await drain(fx)
  assert.deepEqual(fx.calls.model.slice(1).map(ownerSaid), ['what time is it'])
})

test('an entry that grows by "huh …" after an answered "uh" still gives only the new words', async () => {
  const { fx, provider } = await call([() => whole('It is noon.'), () => whole('Sunny.')])
  provider.json(frame(1, [user('what time is it uh')]))
  await drain(fx)
  provider.json(frame(2, [user('what time is it uh huh and the weather')]))
  await drain(fx)
  assert.equal(ownerSaid(fx.calls.model[1]), 'huh and the weather')
})

test('a cut that would fall inside a run with no space takes his whole entry', async () => {
  const { fx, provider } = await call([() => whole('Goodbye.'), () => whole('Yes?')])
  provider.json(frame(1, [user('goodbye')]))
  await drain(fx)
  provider.json(frame(2, [user('goodbye.Yeah what now')]))
  await drain(fx)
  assert.deepEqual([ownerSaid(fx.calls.model[1]), fx.bridge.counts.grownTurns], ['goodbye.Yeah what now', 0])
})

test('words over the bound of one turn, added while she works, are refused as before (never merged)', async () => {
  const working = liveStream()
  const { fx, provider } = await call([() => working.response])
  provider.json(frame(1, [user('what is the build')]))
  await drain(fx)
  working.push(start() + thinking())
  await drain(fx)
  provider.json(frame(2, [user(`what is the build ${'word '.repeat(900).trim()}`)]))
  await drain(fx)
  assert.deepEqual([fx.calls.model.length, fx.bridge.counts.wordsMerged, fx.bridge.counts.transcriptsRefused, finals(provider, 2), working.cancelled], [1, 0, 1, 1, true])
})

test('an assent said as a NEW entry while she answers moves the place: what grows after it is new', async () => {
  const A = 'what time is it'
  const answering = liveStream()
  const { fx, provider } = await call([() => answering.response, () => whole('Sunny.')])
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  answering.push(start() + textOpen() + textPiece('It is noon. And'))
  await drain(fx)
  provider.json(frame(2, [user(A), user('okay')]))
  await drain(fx)
  answering.push(textPiece(' the day is clear.') + textClose() + stop())
  answering.end()
  await drain(fx)
  assert.equal(fx.bridge.counts.backchannelsKept, 1)
  provider.json(frame(3, [user(A), user('okay and the weather')]))
  await drain(fx)
  assert.equal(ownerSaid(fx.calls.model[1]), 'and the weather')
})

test('the spoken-search rule reads his whole entry and his added words, not only the new part', () => {
  const fx = fixtureAfterHello()
  const turn = { full: 'search the web for the Bali weather tomorrow and Jakarta too', transcript: 'and Jakarta too', fast: { added: ['in celsius please'] } }
  assert.equal(fx.bridge.heardWhole(turn), 'search the web for the Bali weather tomorrow and Jakarta too / in celsius please')
  assert.equal(searchHeard(fx.bridge.heardWhole(turn), { query: 'Bali weather tomorrow' }), true)
  assert.equal(searchHeard(turn.transcript, { query: 'Bali weather tomorrow' }), false)
})

test('an answer cut in its first few words leaves his words open; one cut after more does not', async () => {
  const A = 'tell me about the witness'
  const B = 'and the relays'
  for (const [begun, told] of [['It stamps. And', `${A} ${B}`], ['It stamps my record every four hours, outside my reach. And', B]]) {
    const first = liveStream()
    const { fx, provider } = await call([() => first.response, () => whole('Three relays hold it.')])
    provider.json(frame(1, [user(A)]))
    await drain(fx)
    first.push(start() + textOpen() + textPiece(begun))
    await drain(fx)
    provider.json(frame(2, [user(`${A} ${B}`)]))
    await drain(fx)
    assert.equal(ownerSaid(fx.calls.model[1]), told, begun)
  }
})

// ── Second review (one more independent reviewer on the review fixes) ─────
test('2: a longer line before a look, its last clause released after the tool call, is still no answer', async () => {
  const A = 'what is the build number on main'
  const more = 'no wait, on the deploy branch'
  const { fx, provider } = await call([
    () => { const stream = liveStream(); stream.push(start() + textOpen() + textPiece('Let me look that up in your repository for you.') + textClose() + toolUse(1, 'toolu_01Look', LOOK_TOOL, { tool: 'x6_self_state', arguments: '{}' }) + stopForTools()); stream.end(); return stream.response },
    () => whole('It is build nine on deploy.'),
  ])
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  assert.equal(said(provider, 1).includes('in your repository for you.'), true)
  provider.json(frame(2, [user(`${A} ${more}`)]))
  await drain(fx)
  assert.equal(ownerSaid(fx.calls.model[1]), `${A} ${more}`)
})

test('2: an assent during the follow-up call never marks his unread added words answered', async () => {
  const A = 'what is the build number'
  const B = 'and is the witness on'
  const C = 'no wait, tell me the relay count'
  const streams = [liveStream(), liveStream(), liveStream()]
  const { fx, provider } = await call(streams.map(stream => () => stream.response))
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  streams[0].push(start())
  await drain(fx)
  provider.json(frame(2, [user(`${A} ${B}`)]))
  await drain(fx)
  streams[0].push(textOpen() + textPiece('The build is forty two.') + textClose() + stop())
  streams[0].end()
  await drain(fx)
  streams[1].push(start() + thinking())
  await drain(fx)
  provider.json(frame(3, [user(`${A} ${B} okay`)]))
  await drain(fx)
  assert.equal(fx.bridge.counts.backchannelsKept, 1)
  provider.json(frame(4, [user(`${A} ${B} okay ${C}`)]))
  await drain(fx)
  assert.equal(ownerSaid(fx.calls.model[2]), `${B} okay ${C}`)
})

test('2: the follow-up call fails: she says she did not get his added words, and they stay open', async () => {
  const A = 'what is the build number'
  const B = 'and is the witness on'
  const C = 'and the relays'
  const first = liveStream()
  const { fx, provider } = await call([() => first.response, () => new Response('down', { status: 500 }), () => whole('It is on, and three relays hold it.')])
  provider.json(frame(1, [user(A)]))
  await drain(fx)
  first.push(start())
  await drain(fx)
  provider.json(frame(2, [user(`${A} ${B}`)]))
  await drain(fx)
  first.push(textOpen() + textPiece('The build is forty two.') + textClose() + stop())
  first.end()
  await drain(fx)
  assert.equal(said(provider, 2).includes('I did not get to what you just added.'), true)
  provider.json(frame(3, [user(`${A} ${B} ${C}`)]))
  await drain(fx)
  assert.equal(ownerSaid(fx.calls.model.at(-1)), `${B} ${C}`)
})
