/** Her voice memory at the edge never
 * loses a word on a failed read, sends the first call's records, resends a gap byte for byte, checks her home's digest
 * below the tail, records an orphaned hand-off instead of replaying it forever, keeps the spoken order, says what is in
 * front of her, and the status never guesses an empty memory. The real Worker and VoiceBridgeDO; fakes for the network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { OWNER, fixtureAfterHello as fixture, memoryStorage, transcript } from './voice-bridge-fakes.mjs'
import { MEMORY_FLAGS_KEY, MEMORY_PENDING_KEY } from '../voice-bridge-do.mjs'
import { MEMORY_RULES, memoryFactLine, memoryHistory } from '../voice-fast.mjs'
import { MEMORY_KEYS, ZERO_DIGEST, canonical, makeExchange, recordDigest, validRecord } from '../voice-memory.mjs'

const FAST_ENV = Object.freeze({ DEEPSEEK_API_KEY: 'sk-synthetic-fast-voice-key-0123456789abcdef', PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '1000',
  PROVIDER_BUDGET_TOKENS: '50000000', PROVIDER_MAX_OUTPUT_TOKENS: '256000' })
const encoder = new TextEncoder()
const delta = text => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`
const DONE = 'data: [DONE]\n\n'
const whole = (...chunks) => new Response(new ReadableStream({ start(control) { for (const chunk of chunks) control.enqueue(encoder.encode(chunk)); control.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
const drain = async fx => { for (let index = 0; index < 4; index++) await fx.settle() }
const bodyOf = call => JSON.parse(new TextDecoder().decode(call.init.body))
const HOUR = 3_600_000
const memoryFrames = tab => tab.frames().filter(frame => frame.t === 'memory')
const have = (tab, seq, digest) => tab.json({ t: 'memory_have', seq, digest })

function memoryCall(options = {}) {
  let n = 0
  return fixture({ ...options, env: { ...FAST_ENV, ...options.env }, modelFetch: options.modelFetch ?? (() => whole(delta(`Answer ${String(++n)}.`), DONE)) })
}
async function exchanges(fx, provider, from, to) {
  for (let index = from; index <= to; index++) {
    provider.json(transcript(index, `question ${String(index)}`))
    await drain(fx)
  }
}
/** A storage whose next read of each named key throws once (a transient storage error). */
function flakyStorage() {
  const storage = memoryStorage()
  const failing = new Set()
  const get = storage.get
  storage.get = async key => {
    if (failing.has(key)) { failing.delete(key); throw new Error('transient storage error') }
    return await get(key)
  }
  storage.failOnce = (...keys) => { for (const key of keys) failing.add(key) }
  return storage
}

test('MUST: a transient storage error during memory_have leaves the head, the tail and the counts unchanged', async () => {
  for (const key of [MEMORY_KEYS.tail, MEMORY_KEYS.head]) {
    for (const homeAt of ['head', 1]) {
      const bridgeStorage = flakyStorage()
      const fx = memoryCall({ bridgeStorage })
      const { tab, provider } = await fx.connect()
      await exchanges(fx, provider, 1, 3)
      const head = await bridgeStorage.get(MEMORY_KEYS.head)
      const tail = await bridgeStorage.get(MEMORY_KEYS.tail)
      bridgeStorage.failOnce(key)
      have(tab, homeAt === 'head' ? 3 : 1, homeAt === 'head' ? head.digest : await recordDigest(tail[0].record))
      await drain(fx)
      assert.deepEqual(await bridgeStorage.get(MEMORY_KEYS.head), head, `${key} ${String(homeAt)}`)
      assert.deepEqual(await bridgeStorage.get(MEMORY_KEYS.tail), tail, `${key} ${String(homeAt)}`)
      assert.equal(fx.bridge.counts.memoryAdoptedFromHome, 0)
      assert.equal((await bridgeStorage.get(MEMORY_FLAGS_KEY))?.adoptedFromHome ?? false, false)
      // The next exchange still links to the edge's own head (seq 4), never to a head moved back.
      await exchanges(fx, provider, 4, 4)
      const after = await bridgeStorage.get(MEMORY_KEYS.tail)
      assert.deepEqual([after.at(-1).record.seq, after.at(-1).record.prev], [4, head.digest])
    }
  }
})

test('SHOULD: an empty edge and an empty home (memory_have 0) still send this call\'s records', async () => {
  const fx = memoryCall()
  const { tab, provider } = await fx.connect()
  have(tab, 0, ZERO_DIGEST)
  await drain(fx)
  await exchanges(fx, provider, 1, 1)
  const frames = memoryFrames(tab)
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0].items.map(item => item.record.seq), [1])
})

test('SHOULD: the same gap resent later is byte for byte the same record', async () => {
  const fx = memoryCall()
  const { tab, provider } = await fx.connect()
  await exchanges(fx, provider, 1, 2)
  const atTwo = (await fx.bridgeStorage.get(MEMORY_KEYS.head)).digest
  await exchanges(fx, provider, 3, 45)
  have(tab, 2, atTwo)
  await drain(fx)
  const first = memoryFrames(tab)[0].items[0].record
  assert.equal(first.kind, 'gap')
  fx.clock.advance(5 * 60_000)
  const before = memoryFrames(tab).length
  have(tab, 2, atTwo)
  await drain(fx)
  const again = memoryFrames(tab)[before].items[0].record
  assert.equal(canonical(again), canonical(first))
})

test('SHOULD: her home naming another digest below the tail is a FORK, and nothing is sent', async () => {
  const fx = memoryCall()
  const { tab, provider } = await fx.connect()
  await exchanges(fx, provider, 1, 45)
  assert.equal((await fx.bridgeStorage.get(MEMORY_KEYS.tail))[0].record.seq, 6)
  have(tab, 2, 'b'.repeat(64))
  await drain(fx)
  assert.equal(memoryFrames(tab).length, 0)
  assert.equal((await fx.bridgeStorage.get(MEMORY_FLAGS_KEY)).fork, true)
})

test('MUST/SHOULD: a hand-off left pending by a dead object is recorded once as failed, cleared, and never replayed as the newest exchange', async () => {
  const bridgeStorage = memoryStorage()
  const fx = memoryCall({ bridgeStorage })
  const atMs = fx.clock.now() - 24 * HOUR
  await bridgeStorage.put(MEMORY_PENDING_KEY, { owner: OWNER, conv: 'conv_old', turnId: 'eleven:conv_old:5', heard: 'please make the garden map blue',
    said: 'I will hand that to my working self. (handed to my working session)', atMs })
  const { provider } = await fx.connect()
  await exchanges(fx, provider, 1, 3)
  assert.equal(await bridgeStorage.get(MEMORY_PENDING_KEY), undefined)
  const messages = bodyOf(fx.calls.model.at(-1)).messages
  const texts = messages.slice(1, -1).map(message => message.content)
  // The day-old hand-off comes first (before this call's exchanges), with its age.
  assert.deepEqual(texts, ['(earlier call, 24 h ago) please make the garden map blue', 'I will hand that to my working self. (handed to my working session)',
    'question 1', 'Answer 1.', 'question 2', 'Answer 2.'])
  // It is in the chain once, as failed, with its own time.
  const tail = await bridgeStorage.get(MEMORY_KEYS.tail)
  const orphan = tail.filter(item => item.record.turn === 'eleven:conv_old:5')
  assert.equal(orphan.length, 1)
  assert.deepEqual([orphan[0].record.ended, orphan[0].record.path, orphan[0].record.at, orphan[0].record.seq], ['failed', 'governed', atMs, 1])
  assert.equal(validRecord(orphan[0].record), true)
})

test('SHOULD: the history keeps the spoken order within a call, and a pending hand-off sits by its time', () => {
  const now = 10 * HOUR
  const item = (seq, turn, at, heard, conv = 'c1') => ({ record: { kind: 'exchange', seq, at, turn, conv }, words: { seq, heard, said: `said ${heard}` } })
  // Turn 1 handed, turn 2 answered, then turn 1's done arrives: the record of turn 1 has the later seq.
  const tail = [item(1, 'eleven:c1:2', now - 3000, 'thanks, what build'), item(2, 'eleven:c1:1', now - 1000, 'make the map blue')]
  assert.deepEqual(memoryHistory(tail, null, 'c1', now).map(entry => entry.heard), ['make the map blue', 'thanks, what build'])
  // A pending hand-off older than the tail is not the newest exchange.
  const older = [item(1, 'eleven:c2:1', now - 2 * HOUR, 'two hours', 'c2'), item(2, 'eleven:c3:1', now - HOUR, 'one hour', 'c3')]
  const pending = { heard: 'five days', said: 'handed', atMs: now - 120 * HOUR, turnId: 'eleven:c0:4', conv: 'c0' }
  assert.deepEqual(memoryHistory(older, pending, 'c9', now).map(entry => entry.heard.replace(/^\(earlier call, [^)]*\) /, '')), ['five days', 'two hours', 'one hour'])
})

test('SHOULD: her Memory line says what is in her record and what is in front of her; her rules never claim word for word', () => {
  assert.equal(memoryFactLine({ exchanges: 57, inFront: 0, lastCallAt: null, notInHome: 0 }, 0),
    '- Memory: 57 exchanges kept (0 of them in front of you); no earlier call; record in step with your home.')
  assert.equal(/word for word/.test(MEMORY_RULES), false)
  assert.match(MEMORY_RULES, /does not hold/)
})

test('SHOULD: with the managed voice off the status shows memory as not read (null), never an empty memory', async () => {
  const fx = memoryCall({ env: { VOICE_MANAGED: '0' } })
  const body = await (await fx.ownerDoor({ body: { action: 'managed_status' } })).json()
  assert.equal(body.switch, 'off')
  assert.equal(body.memory, null)
})

test('another owner\'s record at the edge is never overwritten, adopted over or read; the exchange is not kept and is counted', async () => {
  const bridgeStorage = memoryStorage()
  // A record that belongs to someone else: a head, two tail pairs with words, and what her home acknowledged.
  const first = await makeExchange({ prev: ZERO_DIGEST, seq: 1, at: 1000, conv: 'conv_other', turn: 'eleven:conv_other:1', heard: 'their words', said: 'their answer', ended: 'answered', path: 'fast', calls: [] })
  const second = await makeExchange({ prev: await recordDigest(first.record), seq: 2, at: 2000, conv: 'conv_other', turn: 'eleven:conv_other:2', heard: 'more of theirs', said: 'and hers', ended: 'answered', path: 'fast', calls: [] })
  const theirs = { owner: 'someone-else@example.invalid', seq: 2, digest: await recordDigest(second.record), at: 2000 }
  await bridgeStorage.put(MEMORY_KEYS.head, theirs)
  await bridgeStorage.put(MEMORY_KEYS.tail, [first, second])
  await bridgeStorage.put(MEMORY_KEYS.synced, 1)
  const fx = memoryCall({ bridgeStorage })
  const { tab, provider } = await fx.connect()
  // This owner's home says it holds a longer chain: nothing here is adopted over the other record.
  have(tab, 7, 'ab'.repeat(32))
  await drain(fx)
  await exchanges(fx, provider, 1, 2)
  assert.deepEqual(await bridgeStorage.get(MEMORY_KEYS.head), theirs)
  assert.deepEqual(await bridgeStorage.get(MEMORY_KEYS.tail), [first, second])
  assert.equal(await bridgeStorage.get(MEMORY_KEYS.synced), 1)
  assert.equal(fx.bridge.counts.memoryOtherOwner, 2, 'one per exchange not kept')
  assert.equal(fx.bridge.counts.memoryRecords, 0)
  assert.equal(fx.bridge.counts.memoryAdoptedFromHome, 0)
  assert.deepEqual(memoryFrames(tab), [], 'nothing of either record goes to this owner\'s home')
  // The other owner's words never reach this owner's model: the second turn's request holds no history of theirs.
  const sent = JSON.stringify(fx.calls.model.map(call => JSON.parse(new TextDecoder().decode(call.init.body))))
  for (const words of ['their words', 'their answer', 'more of theirs', 'and hers']) assert.equal(sent.includes(words), false, words)
  // She still answered both turns: only the memory is withheld.
  assert.equal(fx.calls.model.length, 2)
})
