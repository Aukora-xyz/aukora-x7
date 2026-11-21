/** HER VOICE REMEMBERS. The real Worker, the real VoiceBridgeDO,
 * HEAD's real journal, budget and dispatcher; only the provider's network is faked (voice-bridge-fakes.mjs). No network,
 * no paid call. M2: the chain at the edge (head and tail in one transaction), a call that opens with memory however long
 * ago, nothing deleted by time. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { OWNER, fixtureAfterHello as fixture, manualClock, memoryStorage, transcript } from './voice-bridge-fakes.mjs'
import { LEGACY_SPOKEN_KEY, MEMORY_FLAGS_KEY } from '../voice-bridge-do.mjs'
import { FAST_FACTS_HEAD, FAST_VOICE_RULES, MEMORY_RULES, fastUserContent } from '../voice-fast.mjs'
import { MEMORY_KEYS, MEMORY_LIMITS, ZERO_DIGEST, answerDigest, makeGap, opens, recordDigest, validRecord } from '../voice-memory.mjs'

const FAST_ENV = Object.freeze({ DEEPSEEK_API_KEY: 'sk-synthetic-fast-voice-key-0123456789abcdef', PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '1000',
  PROVIDER_BUDGET_TOKENS: '50000000', PROVIDER_MAX_OUTPUT_TOKENS: '256000' })
const encoder = new TextEncoder()
const delta = text => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`
const DONE = 'data: [DONE]\n\n'
const whole = (...chunks) => new Response(new ReadableStream({ start(control) { for (const chunk of chunks) control.enqueue(encoder.encode(chunk)); control.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
const drain = async fx => { for (let index = 0; index < 4; index++) await fx.settle() }
const bodyOf = call => JSON.parse(new TextDecoder().decode(call.init.body))
const HOUR = 3_600_000

function memoryCall(options = {}) {
  let n = 0
  return fixture({ ...options, env: { ...FAST_ENV, ...options.env }, modelFetch: options.modelFetch ?? (() => whole(delta(`Answer ${String(++n)}.`), DONE)) })
}

test('two exchanges chain: one record each, its words beside it, head and tail in step; the old spoken store is read once and deleted', async () => {
  const bridgeStorage = memoryStorage()
  // A spoken store from before (no salt, no chain): read once and deleted, never converted.
  await bridgeStorage.put(LEGACY_SPOKEN_KEY, { owner: OWNER, exchanges: [{ heard: 'old words', said: 'old answer', atMs: 1 }] })
  const fx = memoryCall({ bridgeStorage })
  const { conv, provider } = await fx.connect()
  provider.json(transcript(1, 'first question'))
  await drain(fx)
  provider.json(transcript(2, 'second question'))
  await drain(fx)
  assert.equal(await bridgeStorage.get(LEGACY_SPOKEN_KEY), undefined)
  const tail = await bridgeStorage.get(MEMORY_KEYS.tail)
  const head = await bridgeStorage.get(MEMORY_KEYS.head)
  assert.equal(tail.length, 2)
  const [first, second] = tail
  assert.deepEqual([first.record.seq, first.record.prev, second.record.seq, second.record.prev], [1, ZERO_DIGEST, 2, await recordDigest(first.record)])
  assert.deepEqual(head, { owner: OWNER, seq: 2, digest: await recordDigest(second.record), at: second.record.at })
  for (const item of tail) {
    assert.equal(validRecord(item.record), true)
    assert.equal(await opens(item.record, item.words), true)
    assert.deepEqual([item.record.ended, item.record.path, item.record.conv], ['answered', 'fast', conv])
  }
  assert.deepEqual([first.words.heard, first.words.said, second.words.heard, second.words.said], ['first question', 'Answer 1.', 'second question', 'Answer 2.'])
  assert.equal(first.record.turn, `eleven:${conv}:1`)
  // The old store's words never reach the model; the first exchange of this call is in the second turn's history as is.
  const messages = bodyOf(fx.calls.model.at(-1)).messages
  assert.equal(JSON.stringify(messages).includes('old words'), false)
  assert.deepEqual(messages.slice(1, 3), [{ role: 'user', content: 'first question' }, { role: 'assistant', content: 'Answer 1.' }])
})

test('the tail holds 40; a new object hours later opens the call with the last 12 word for word and their ages; nothing is deleted by time', async () => {
  const clock = manualClock()
  const bridgeStorage = memoryStorage()
  const fx = memoryCall({ clock, bridgeStorage })
  const call = await fx.connect()
  for (let index = 1; index <= 41; index++) {
    call.provider.json(transcript(index, `question ${String(index)}`))
    await drain(fx)
  }
  const tail = await bridgeStorage.get(MEMORY_KEYS.tail)
  assert.equal(tail.length, MEMORY_LIMITS.tail)
  assert.deepEqual([tail[0].record.seq, tail.at(-1).record.seq, (await bridgeStorage.get(MEMORY_KEYS.head)).seq], [2, 41, 41])
  for (let index = 1; index < tail.length; index++) assert.equal(tail[index].record.prev, await recordDigest(tail[index - 1].record))
  call.tab.json({ t: 'bye', why: 'stop' })
  await drain(fx)
  // No sweep is set for the memory, and a day of alarms deletes none of it.
  assert.equal(bridgeStorage.alarmAt(), null)
  clock.advance(3 * HOUR)
  await fx.bridge.alarm()
  assert.equal((await bridgeStorage.get(MEMORY_KEYS.tail)).length, MEMORY_LIMITS.tail)
  // A new object instance over the same storage (as after an eviction), three hours later.
  const later = memoryCall({ clock, bridgeStorage })
  const again = await later.connect()
  again.provider.json(transcript(1, 'where were we'))
  await drain(later)
  const messages = bodyOf(later.calls.model.at(-1)).messages
  assert.equal(messages.length, 1 + 2 * MEMORY_LIMITS.history + 1)
  // Word for word, each marked with its age (older than this call).
  assert.deepEqual(messages.slice(1, 3), [{ role: 'user', content: '(earlier call, 3 h ago) question 30' }, { role: 'assistant', content: 'Answer 30.' }])
  assert.deepEqual(messages.slice(-3, -1), [{ role: 'user', content: '(earlier call, 3 h ago) question 41' }, { role: 'assistant', content: 'Answer 41.' }])
  const last = messages.at(-1).content
  // The facts block's Memory line: what is kept, when the last call ended, and whether her home is in step (not checked
  // here: her page never said where her home is).
  assert.match(last, new RegExp(`${FAST_FACTS_HEAD.replace(/[()]/g, '\\$&')}[\\s\\S]*- Memory: 41 exchanges kept \\(12 of them in front of you\\); last call ended 3 h ago; record not checked\\.`))
  assert.ok(last.endsWith(fastUserContent('', 'where were we').split('\n').slice(-1)[0]))
  // Her rules say where her memory of earlier calls comes from, and that she does not remember what it does not hold.
  assert.ok(FAST_VOICE_RULES.includes(MEMORY_RULES))
  assert.match(MEMORY_RULES, /x6_voice_memory/)
  assert.match(MEMORY_RULES, /does not hold/)
  // A day later still nothing is gone.
  clock.advance(24 * HOUR)
  await later.bridge.alarm()
  assert.equal((await bridgeStorage.get(MEMORY_KEYS.tail)).length, MEMORY_LIMITS.tail)
})

test('with the fast voice off the bridge keeps no words and no record', async () => {
  const fx = memoryCall({ env: { VOICE_FAST: 'off' } })
  const { tab, provider } = await fx.connect()
  provider.json(transcript(1, 'hello'))
  await drain(fx)
  const turn = tab.frames().find(frame => frame.t === 'turn').turn
  tab.json({ t: 'delta', turn, seq: 0, text: 'Hi.' })
  tab.json({ t: 'done', turn })
  await drain(fx)
  for (const key of Object.values(MEMORY_KEYS)) assert.equal(await fx.bridgeStorage.get(key), undefined)
})

// ── M3: the frames to her home ─────────────────────────────────────────────────────────────────────────────────────
const memoryFrames = tab => tab.frames().filter(frame => frame.t === 'memory')
const have = (tab, seq, digest) => tab.json({ t: 'memory_have', seq, digest })

async function exchanges(fx, provider, from, to) {
  for (let index = from; index <= to; index++) {
    provider.json(transcript(index, `question ${String(index)}`))
    await drain(fx)
  }
}

test('M3: an exchange produces one memory frame once her home said where it is; an ack moves synced', async () => {
  const fx = memoryCall()
  const { tab, provider } = await fx.connect()
  // Before her home has said where it is, nothing is sent (nothing could be sent twice).
  await exchanges(fx, provider, 1, 1)
  assert.equal(memoryFrames(tab).length, 0)
  have(tab, 1, (await fx.bridgeStorage.get(MEMORY_KEYS.head)).digest)
  await drain(fx)
  assert.equal(memoryFrames(tab).length, 0)
  await exchanges(fx, provider, 2, 2)
  const frames = memoryFrames(tab)
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0].items.map(item => [item.record.seq, item.words.heard]), [[2, 'question 2']])
  assert.deepEqual(frames[0].items[0], (await fx.bridgeStorage.get(MEMORY_KEYS.tail))[1])
  assert.equal(await fx.bridgeStorage.get(MEMORY_KEYS.synced), 1)
  tab.json({ t: 'memory_ack', seq: 2, digest: await recordDigest(frames[0].items[0].record) })
  await drain(fx)
  assert.equal(await fx.bridgeStorage.get(MEMORY_KEYS.synced), 2)
  // An ack naming a digest the edge does not hold moves nothing.
  await exchanges(fx, provider, 3, 3)
  tab.json({ t: 'memory_ack', seq: 3, digest: 'f'.repeat(64) })
  await drain(fx)
  assert.equal(await fx.bridgeStorage.get(MEMORY_KEYS.synced), 2)
  assert.deepEqual([fx.bridge.counts.memoryAcks, fx.bridge.counts.memoryRecords], [2, 3])
})

test('M3: a home behind the head gets the rest resent in order; a fork stops resends; a write failure is retried with the next frame', async () => {
  const bridgeStorage = memoryStorage()
  const clock = manualClock()
  const fx = memoryCall({ bridgeStorage, clock })
  const first = await fx.connect()
  await exchanges(fx, first.provider, 1, 3)
  first.tab.json({ t: 'bye', why: 'stop' })
  await drain(fx)
  const tail = await bridgeStorage.get(MEMORY_KEYS.tail)
  const second = await fx.connect()
  have(second.tab, 1, await recordDigest(tail[0].record))
  await drain(fx)
  assert.deepEqual(memoryFrames(second.tab).flatMap(frame => frame.items.map(item => item.record.seq)), [2, 3])
  // A write failure at her home: the next exchange's frame carries what she did not write, from her home's head.
  second.tab.json({ t: 'memory_nack', code: 'WRITE_FAILED', seq: 1, digest: await recordDigest(tail[0].record) })
  await drain(fx)
  await exchanges(fx, second.provider, 1, 1)
  assert.deepEqual(memoryFrames(second.tab).at(-1).items.map(item => item.record.seq), [2, 3, 4])
  // A fork: nothing more is sent, and it stays until a person decides.
  second.tab.json({ t: 'memory_nack', code: 'FORK', seq: 4, digest: 'e'.repeat(64) })
  await drain(fx)
  const before = memoryFrames(second.tab).length
  await exchanges(fx, second.provider, 2, 2)
  assert.equal(memoryFrames(second.tab).length, before)
  assert.equal((await bridgeStorage.get(MEMORY_FLAGS_KEY)).fork, true)
  assert.equal(fx.bridge.counts.memoryNacks, 2)
  // A home that reports another digest at a seq the edge holds is a fork too.
  const other = memoryCall()
  const call = await other.connect()
  await exchanges(other, call.provider, 1, 2)
  have(call.tab, 1, 'd'.repeat(64))
  await drain(other)
  assert.equal(memoryFrames(call.tab).length, 0)
  assert.equal((await other.bridgeStorage.get(MEMORY_FLAGS_KEY)).fork, true)
})

test('M3: an edge with no head adopts her home head (counted); the next record links to it', async () => {
  const fx = memoryCall()
  const { tab, provider } = await fx.connect()
  have(tab, 5, 'c'.repeat(64))
  await drain(fx)
  assert.deepEqual(await fx.bridgeStorage.get(MEMORY_KEYS.head), { owner: OWNER, seq: 5, digest: 'c'.repeat(64), at: fx.clock.now() })
  assert.equal(fx.bridge.counts.memoryAdoptedFromHome, 1)
  assert.equal((await fx.bridgeStorage.get(MEMORY_FLAGS_KEY)).adoptedFromHome, true)
  await exchanges(fx, provider, 1, 1)
  const [item] = memoryFrames(tab).at(-1).items
  assert.deepEqual([item.record.seq, item.record.prev], [6, 'c'.repeat(64)])
})

test('M3: what the tail no longer holds is a gap: shown, and bridged with a gap record before the resent records', async () => {
  const fx = memoryCall()
  const { tab, provider } = await fx.connect()
  await exchanges(fx, provider, 1, 2)
  // CHANGED (review): her home names the edge's real digest at seq 2 (another digest there is a FORK, checked through the
  // digest index); the gap record's time is the first resent record's (a resend is byte for byte the same).
  const atTwo = (await fx.bridgeStorage.get(MEMORY_KEYS.head)).digest
  await exchanges(fx, provider, 3, 45)
  const tail = await fx.bridgeStorage.get(MEMORY_KEYS.tail)
  assert.equal(tail[0].record.seq, 6)
  have(tab, 2, atTwo)
  await drain(fx)
  const frames = memoryFrames(tab)
  const items = frames.flatMap(frame => frame.items)
  assert.deepEqual(items[0], { record: makeGap({ missingFrom: 3, missingTo: 5, prev: tail[0].record.prev, at: tail[0].record.at }) })
  assert.deepEqual(items.slice(1).map(item => item.record.seq), Array.from({ length: 40 }, (_, index) => index + 6))
  for (const frame of frames) {
    assert.ok(frame.items.length <= MEMORY_LIMITS.frameItems)
    assert.ok(encoder.encode(JSON.stringify(frame)).byteLength <= MEMORY_LIMITS.frameBytes)
  }
  assert.equal((await fx.bridgeStorage.get(MEMORY_FLAGS_KEY)).gapFrom, 3)
})

test('M3: the tab door accepts exactly the three memory shapes; anything else closes it', async () => {
  for (const bad of [{ t: 'memory_have', seq: 1 }, { t: 'memory_have', seq: -1, digest: 'a'.repeat(64) }, { t: 'memory_have', seq: 1, digest: 'A'.repeat(64) },
    { t: 'memory_ack', seq: 1, digest: 'a'.repeat(64), extra: 1 }, { t: 'memory_nack', code: 'OTHER', seq: 1, digest: 'a'.repeat(64) },
    { t: 'memory_nack', code: 'GAP', seq: 1.5, digest: 'a'.repeat(64) }, { t: 'memory', items: [] }]) {
    const fx = memoryCall()
    const { tab } = await fx.connect()
    tab.json(bad)
    await drain(fx)
    assert.equal(tab.closedCode, 1008, JSON.stringify(bad))
  }
  for (const good of [{ t: 'memory_have', seq: 0, digest: ZERO_DIGEST }, { t: 'memory_ack', seq: 1, digest: 'a'.repeat(64) }, { t: 'memory_nack', code: 'GAP', seq: 0, digest: ZERO_DIGEST }]) {
    const fx = memoryCall()
    const { tab } = await fx.connect()
    tab.json(good)
    await drain(fx)
    assert.equal(tab.closedCode, null, JSON.stringify(good))
  }
})

// ── M4: the call receipts in each record ───────────────────────────────────────────────────────────────────────────
const sse = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
const claudeStart = sse({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-fable-5-2', content: [] } })
const claudeText = (index, text) => sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
  + sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }) + sse({ type: 'content_block_stop', index })
const claudeLook = index => sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'toolu_1', name: 'look', input: {} } })
  + sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"tool":"x6_self_state","args":{}}' } }) + sse({ type: 'content_block_stop', index })
const claudeStop = reason => sse({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 3 } }) + sse({ type: 'message_stop' })
const withId = (rid, ...chunks) => new Response(new ReadableStream({ start(control) { for (const chunk of chunks) control.enqueue(encoder.encode(chunk)); control.close() } }),
  { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': rid } })

test('M4: each record carries one receipt per model call: journal id, the journal row request digest, answer digest, served model, effort, provider request id', async () => {
  let n = 0
  const answers = [() => withId('req_011CTestOne', claudeStart, claudeText(0, 'Let me look. '), claudeLook(1), claudeStop('tool_use')),
    () => withId('not a valid id!', claudeStart, claudeText(0, 'All good.'), claudeStop('end_turn'))]
  const fx = fixture({ env: { VOICE_FAST_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-claude-test-value-not-a-key-0123456789', PROVIDER_BUDGET_WINDOW_MS: '60000',
    PROVIDER_BUDGET_REQUESTS: '1000', PROVIDER_BUDGET_TOKENS: '50000000', PROVIDER_MAX_OUTPUT_TOKENS: '256000' }, modelFetch: () => answers[n++]() })
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'how am I doing'))
  await drain(fx)
  for (const frame of tab.frames().filter(item => item.t === 'tool')) tab.json({ t: 'tool_result', turn: frame.turn, call: frame.call, ok: true, text: '{"ok":true}' })
  await drain(fx)
  const [item] = await fx.bridgeStorage.get(MEMORY_KEYS.tail)
  const turn = `eleven:${conv}:1`
  const rows = await fx.rows()
  const rowOf = id => rows.find(row => row.turnId === id)
  assert.deepEqual(item.record.calls.map(call => [call.id, call.req, call.model, call.effort, call.rid]), [
    [`${turn}.fast`, rowOf(`${turn}.fast`).requestSha256, 'claude-fable-5-2', 'low', 'req_011CTestOne'],
    [`${turn}.fast2`, rowOf(`${turn}.fast2`).requestSha256, 'claude-fable-5-2', 'low', '']])
  assert.equal(item.record.calls[1].res, await answerDigest({ blocks: [{ type: 'text', text: 'All good.' }], stop: 'end_turn' }))
  assert.equal(item.record.calls[0].res, await answerDigest({ blocks: [{ type: 'text', text: 'Let me look. ' }, { type: 'tool_use', id: 'toolu_1', name: 'look', input: { tool: 'x6_self_state', args: {} } }], stop: 'tool_use' }))
  assert.equal(validRecord(item.record), true)
  // The chat wire: its text and tool calls, no served model, no effort.
  const chat = memoryCall()
  const call = await chat.connect()
  call.provider.json(transcript(1, 'hi'))
  await drain(chat)
  const [kept] = await chat.bridgeStorage.get(MEMORY_KEYS.tail)
  assert.deepEqual(kept.record.calls, [{ id: `eleven:${call.conv}:1.fast`, req: (await chat.rows()).find(row => row.turnId === `eleven:${call.conv}:1.fast`).requestSha256,
    res: await answerDigest({ text: 'Answer 1.', calls: [] }), model: '', effort: '', rid: '' }])
})

// ── M6: the status ─────────────────────────────────────────────────────────────────────────────────────────────────
test('M6: managed_status shows the memory object and its counts, never a word', async () => {
  const fx = memoryCall()
  const { tab, provider } = await fx.connect()
  const empty = await (await fx.ownerDoor({ body: { action: 'managed_status' } })).json()
  assert.deepEqual(empty.memory, { seq: 0, digest12: '000000000000', synced: 0, unsynced: 0, gapFrom: null, adoptedFromHome: false, fork: false })
  await exchanges(fx, provider, 1, 2)
  const tail = await fx.bridgeStorage.get(MEMORY_KEYS.tail)
  have(tab, 1, await recordDigest(tail[0].record))
  await drain(fx)
  tab.json({ t: 'memory_nack', code: 'WRITE_FAILED', seq: 1, digest: await recordDigest(tail[0].record) })
  await drain(fx)
  const body = await (await fx.ownerDoor({ body: { action: 'managed_status' } })).json()
  const head = await fx.bridgeStorage.get(MEMORY_KEYS.head)
  assert.deepEqual(body.memory, { seq: 2, digest12: head.digest.slice(0, 12), synced: 1, unsynced: 1, gapFrom: null, adoptedFromHome: false, fork: false })
  assert.deepEqual([body.counts.memoryRecords, body.counts.memoryAcks, body.counts.memoryNacks, body.counts.memoryAdoptedFromHome], [2, 0, 1, 0])
  const text = JSON.stringify(body)
  for (const words of ['question', 'Answer', tail[0].words.salt, head.digest]) assert.equal(text.includes(words), false, words)
})

// ── M7: the stable part of the request is marked for the provider's cache ─────────────────────────────────────────
test('M7: on the anthropic wire the rules and the last history message carry a cache mark; the awareness and his words come after it; HEAD accepts it', async () => {
  let n = 0
  const fx = fixture({ env: { VOICE_FAST_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-claude-test-value-not-a-key-0123456789', PROVIDER_BUDGET_WINDOW_MS: '60000',
    PROVIDER_BUDGET_REQUESTS: '1000', PROVIDER_BUDGET_TOKENS: '50000000', PROVIDER_MAX_OUTPUT_TOKENS: '256000' },
  modelFetch: () => withId('req_x', claudeStart, claudeText(0, `Answer ${String(++n)}.`), claudeStop('end_turn')) })
  const { provider } = await fx.connect()
  await exchanges(fx, provider, 1, 2)
  // Both calls reached the provider: HEAD's request check and budget accepted the marked body.
  assert.equal(fx.calls.model.length, 2)
  const first = bodyOf(fx.calls.model[0])
  const second = bodyOf(fx.calls.model[1])
  const mark = { type: 'ephemeral' }
  assert.deepEqual(first.system, [{ type: 'text', text: FAST_VOICE_RULES, cache_control: mark }])
  assert.deepEqual(second.system, first.system)
  // No history on the first call: only the rules are marked. On the second, the last history message is.
  assert.equal(JSON.stringify(first.messages).includes('cache_control'), false)
  assert.deepEqual(second.messages.slice(0, 2), [{ role: 'user', content: 'question 1' }, { role: 'assistant', content: [{ type: 'text', text: 'Answer 1.', cache_control: mark }] }])
  assert.equal(typeof second.messages.at(-1).content, 'string')
  assert.match(second.messages.at(-1).content, /question 2$/)
})
