/** The outside review of the VoiceBridge (an outside review), each decided item pinned with the review's
 * own input: the real Worker, the real VoiceBridgeDO and HEAD's real turn journal, a fake provider that signs its own
 * JWT, a fake tab socket, a manual clock. Every case here failed on the code before this change (RAN, logged in the
 * lane's handoff) and passes after it. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { BACKCHANNEL, BRIDGE_LIMITS, EARLY_CUE, JOURNAL_RETRY_MS, LOST_PLACE, PROVIDER_HOLD_MS, ADMISSION_KEY, cutClause } from '../voice-bridge-do.mjs'
import { PROVIDER_JSON_MAX_BYTES } from '../voice-bridge.mjs'
import { BRIDGE_INDEX_KEY, BRIDGE_INDEX_LIMITS, BRIDGE_TURN_ID_RE, handleInternalTurnJournalRoute } from '../turn-journal.mjs'
import { BRIDGE_TURN_ID_RE as DO_TURN_ID_RE } from '../voice-bridge-do.mjs'
import { AT, TOKEN, agentFrames, fixture, memoryStorage, transcript } from './voice-bridge-fakes.mjs'

const chunks = (provider, eventId) => agentFrames(provider).filter(frame => frame.event_id === eventId)
const spoken = (provider, eventId) => chunks(provider, eventId).filter(frame => !frame.is_final).map(frame => frame.content)
const ticks = async (n = 10) => { for (let index = 0; index < n; index++) await new Promise(resolve => setImmediate(resolve)) }
const NOTHING = { conversations: 0, sockets: 0, writes: 0, timers: 0 }
const down = () => Response.json({ ok: false, code: 'DOWN' }, { status: 503 })
const admission = async fx => (await fx.bridgeStorage.get(ADMISSION_KEY)) ?? null

/** Run one turn of her reply cut into `parts`, then done; what reached the provider for it. */
async function reply(parts, { done = true } = {}) {
  const fx = fixture()
  const live = await fx.connect()
  live.provider.json(transcript(1, 'say it'))
  await fx.settle()
  const turn = `eleven:${live.conv}:1`
  for (const [seq, text] of parts.entries()) { live.tab.json({ t: 'delta', turn, seq, text }); if (seq % 64 === 63) await fx.settle() }
  if (done) live.tab.json({ t: 'done', turn })
  await fx.settle()
  return { fx, ...live, said: spoken(live.provider, 1), finals: chunks(live.provider, 1).filter(frame => frame.is_final).length }
}
const everyCharacter = text => [...text]

// ── MUST 1: whole units, however the text arrives ──────────────────────────────────────────────────────────────────
test('MUST 1: an inline code span is protected before sentence splitting (the review\'s input, whole and cut at every character)', async () => {
  const text = 'Here: `console.log("first. PRIVATE_MIDDLE. last")`.'
  for (const parts of [[text, ' '], everyCharacter(text + ' ')]) {
    const run = await reply(parts)
    assert.deepEqual(run.said, [], `${parts.length} parts`)
    assert.equal(run.finals, 1)
    assert.equal(run.fx.bridge.counts.clausesDropped, 1)
  }
  // What follows the refused clause is judged on its own.
  for (const parts of [[text + ' Next part. '], everyCharacter(text + ' Next part. ')]) {
    assert.deepEqual((await reply(parts)).said, ['Next part. '], `${parts.length} parts`)
  }
  // The span state itself.
  assert.equal(cutClause('a `b. c` d', false), null)
  assert.deepEqual(cutClause('a `b. c` d. e', false), { clause: 'a `b. c` d. ', rest: 'e', cut: 'boundary' })
  assert.deepEqual(cutClause('a ``b ` c. d`` e. f', false).clause, 'a ``b ` c. d`` e. ')
})

test('MUST 1: a refused token cut by the 600-character cap keeps its refusal to its end (the review\'s input, whole and cut at every character)', async () => {
  const head = 'sk-' + 'A'.repeat(597)
  for (const parts of [[head, 'A'.repeat(103)], everyCharacter(head + 'A'.repeat(103))]) {
    const run = await reply(parts)
    assert.deepEqual(run.said, [], `${parts.length} parts`)
    assert.equal(JSON.stringify(run.provider.frames()).includes('AAAA'), false)
    assert.equal(run.finals, 1)
  }
  // The refusal ends with its clause: the next sentence is spoken.
  for (const parts of [[head, 'A'.repeat(103) + '. Next part. '], everyCharacter(head + 'A'.repeat(103) + '. Next part. ')]) {
    assert.deepEqual((await reply(parts)).said, ['Next part. '], `${parts.length} parts`)
  }
  // A clause cut at a space by the cap and refused: the rest of that clause is dropped too.
  const words = 'word '.repeat(110) + 'sk-ant-abcdefghijklmnopqrstuvwx and more words here. Fine now. '
  assert.deepEqual((await reply([words])).said, ['Fine now. '])
  assert.deepEqual((await reply(everyCharacter(words))).said, ['Fine now. '])
})

// ── MUST 2: no speech without an announced tab and a journal row ──────────────────────────────────────────────────
test('MUST 2: a transcript before hello is not run and not answered; the newest one becomes the turn at hello', async () => {
  const fx = fixture()
  assert.equal((await fx.ownerDoor()).status, 200)
  const provider = (await fx.openProvider()).webSocket
  provider.json({ type: 'init', conversation_id: 'conv_1' })
  await fx.settle()
  provider.json(transcript(1, 'first words'))
  provider.json(transcript(2, 'newest words'))
  await fx.settle()
  assert.deepEqual(agentFrames(provider), [])
  assert.deepEqual(await fx.rows(), [])
  const tab = (await fx.openTab()).webSocket
  tab.json({ t: 'hello', conv: 'conv_1' })
  await fx.settle()
  assert.deepEqual(tab.frames().map(frame => frame.t === 'turn' ? [frame.t, frame.eventId, frame.transcript] : [frame.t]), [['ready'], ['turn', 2, 'newest words']])
  assert.deepEqual((await fx.rows()).map(row => row.turnId), ['eleven:conv_1:2'])
  assert.deepEqual(agentFrames(provider), [])
  tab.json({ t: 'bye' })
  await fx.settle()
  assert.deepEqual(fx.empty(), NOTHING)
})

test('MUST 2: a transcript with no tab inside the hold: nothing journaled, nothing said, the conversation ended', async () => {
  const fx = fixture()
  assert.equal((await fx.ownerDoor()).status, 200)
  const provider = (await fx.openProvider()).webSocket
  provider.json({ type: 'init', conversation_id: 'conv_1' })
  provider.json(transcript(1, 'hello?'))
  await fx.settle()
  fx.clock.advance(PROVIDER_HOLD_MS)
  await fx.settle()
  assert.deepEqual(agentFrames(provider), [])
  assert.deepEqual(await fx.rows(), [])
  assert.equal(provider.closedCode, 1008)
  assert.deepEqual(fx.empty(), NOTHING)
  assert.deepEqual(Object.keys((await admission(fx)).slots), [])
})

test('MUST 2: a journal write that is not confirmed: no sentence at all, the empty final, the tab told, counted', async () => {
  const fx = fixture({ journalFault: body => (body.action === undefined ? down() : undefined) })
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'are you there'))
  await fx.settle()
  assert.deepEqual(chunks(provider, 1), [{ type: 'agent_response', content: '', event_id: 1, is_final: true }])
  assert.deepEqual(tab.frames().slice(1), [{ t: 'cancel', turn: `eleven:${conv}:1`, reason: 'unjournaled' }])
  assert.equal(fx.bridge.counts.unjournaled, 1)
  assert.deepEqual(await fx.rows(), [])
  // A provider retry of that event is answered the same way and starts nothing.
  provider.json(transcript(1, 'are you there'))
  await fx.settle()
  assert.deepEqual(chunks(provider, 1).map(frame => frame.content), ['', ''])
  assert.equal(tab.frames().filter(frame => frame.t === 'turn').length, 0)
  tab.json({ t: 'bye' })
  await fx.settle()
  assert.deepEqual(fx.empty(), NOTHING)
})

// ── MUST 3: the interruption comes first ──────────────────────────────────────────────────────────────────────────
test('MUST 3: a newer unusable transcript (whitespace, over the limit) still cancels the older turn; its late text is dropped', async () => {
  for (const unusable of ['   ', 'x'.repeat(4001)]) {
    const fx = fixture()
    const { conv, tab, provider } = await fx.connect()
    provider.json(transcript(1, 'tell me a story'))
    await fx.settle()
    provider.json(transcript(2, unusable))
    await fx.settle()
    tab.json({ t: 'delta', turn: `eleven:${conv}:1`, seq: 0, text: 'Stale response. ' })
    await fx.settle()
    assert.deepEqual(chunks(provider, 1), [], unusable.slice(0, 5))
    assert.deepEqual(chunks(provider, 2), [{ type: 'agent_response', content: '', event_id: 2, is_final: true }])
    assert.deepEqual(tab.frames().at(-1), { t: 'cancel', turn: `eleven:${conv}:1`, reason: 'superseded' })
    assert.deepEqual((await fx.rows()).map(row => [row.turnId, row.cancelled, row.cancelReason]), [[`eleven:${conv}:1`, true, 'barge_in']])
    assert.equal(fx.bridge.counts.transcriptsRefused, 1)
  }
})

// ── MUST 4: the wait for a tab belongs to the conversation ────────────────────────────────────────────────────────
test('MUST 4: the hold survives a provider socket being replaced, and its expiry ends the conversation and removes it', async () => {
  const fx = fixture()
  assert.equal((await fx.ownerDoor()).status, 200)
  const first = (await fx.openProvider()).webSocket
  first.json({ type: 'init', conversation_id: 'conv_1' })
  await fx.settle()
  fx.clock.advance(4000)
  const second = (await fx.openProvider()).webSocket
  second.json({ type: 'init', conversation_id: 'conv_1' })
  await fx.settle()
  assert.equal(first.closedCode, 1000)
  assert.equal(second.closedCode, null)
  fx.clock.advance(PROVIDER_HOLD_MS - 4000)
  await fx.settle()
  assert.equal(second.closedCode, 1008)
  assert.deepEqual(fx.empty(), NOTHING)
  assert.throws(() => second.json(transcript(1, 'too late')), /socket closed/)
  assert.deepEqual(await fx.rows(), [])
  assert.deepEqual(Object.keys((await admission(fx)).slots), [])
})

// ── MUST 5: terminal journal writes are retried and reported ──────────────────────────────────────────────────────
test('MUST 5: a completion that fails is retried (spaced, counted) while the final goes out at once', async () => {
  let failures = 2
  const fx = fixture({ journalFault: body => (body.action === 'complete' && failures-- > 0 ? down() : undefined) })
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'q'))
  await fx.settle()
  tab.json({ t: 'delta', turn: `eleven:${conv}:1`, seq: 0, text: 'Answer. ' })
  tab.json({ t: 'done', turn: `eleven:${conv}:1` })
  await fx.settle()
  assert.deepEqual(chunks(provider, 1).map(frame => frame.content), ['Answer. ', ''])
  assert.equal((await fx.rows())[0].completed, undefined)
  assert.deepEqual([fx.bridge.journalWritesPending, fx.bridge.counts.journalRetries], [1, 1])
  fx.clock.advance(JOURNAL_RETRY_MS[0])
  await fx.settle()
  assert.deepEqual([fx.bridge.journalWritesPending, fx.bridge.counts.journalRetries], [1, 2])
  fx.clock.advance(JOURNAL_RETRY_MS[1])
  await fx.settle()
  assert.equal((await fx.rows())[0].completed, true)
  assert.deepEqual([fx.bridge.journalWritesPending, fx.bridge.counts.journalWritesLost], [0, 0])
  // Never confirmed: five tries in all, then counted as lost; the conversation goes on.
  const lost = fixture({ journalFault: body => (body.action === 'complete' ? down() : undefined) })
  const live = await lost.connect()
  live.provider.json(transcript(1, 'q'))
  await lost.settle()
  live.tab.json({ t: 'done', turn: `eleven:${live.conv}:1` })
  await lost.settle()
  for (const ms of JOURNAL_RETRY_MS) { lost.clock.advance(ms); await lost.settle() }
  assert.equal(lost.calls.journal.filter(body => body.action === 'complete').length, BRIDGE_LIMITS.journalTries)
  assert.deepEqual([lost.bridge.journalWritesPending, lost.bridge.counts.journalWritesLost], [0, 1])
  assert.equal(live.provider.closedCode, null)
})

test('MUST 5: while a cancel is unconfirmed the next turn waits; confirmed, it starts; never confirmed, the conversation ends', async () => {
  let cancelFails = 1
  const fx = fixture({ journalFault: body => (body.action === 'cancel' && cancelFails-- > 0 ? down() : undefined) })
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'first'))
  await fx.settle()
  provider.json(transcript(2, 'second'))
  await fx.settle()
  // The local fence is immediate: N's late text is dropped; N+1 is not started while N's cancel is unconfirmed.
  tab.json({ t: 'delta', turn: `eleven:${conv}:1`, seq: 0, text: 'Late. ' })
  await fx.settle()
  assert.deepEqual(chunks(provider, 1), [])
  assert.deepEqual(tab.frames().filter(frame => frame.t === 'turn').map(frame => frame.eventId), [1])
  assert.deepEqual((await fx.rows()).map(row => row.turnId), [`eleven:${conv}:1`])
  fx.clock.advance(JOURNAL_RETRY_MS[0])
  await fx.settle()
  assert.deepEqual(tab.frames().filter(frame => frame.t === 'turn').map(frame => frame.eventId), [1, 2])
  assert.deepEqual((await fx.rows()).map(row => [row.turnId, row.cancelled ?? false]), [[`eleven:${conv}:1`, true], [`eleven:${conv}:2`, false]])
  // Never confirmed: after the five tries the conversation ends with journal-unavailable; N+1 never ran.
  const stuck = fixture({ journalFault: body => (body.action === 'cancel' ? down() : undefined) })
  const live = await stuck.connect()
  live.provider.json(transcript(1, 'first'))
  await stuck.settle()
  live.provider.json(transcript(2, 'second'))
  await stuck.settle()
  for (const ms of JOURNAL_RETRY_MS) { stuck.clock.advance(ms); await stuck.settle() }
  assert.deepEqual(live.tab.frames().at(-1), { t: 'end', reason: 'journal-unavailable' })
  assert.deepEqual(live.tab.frames().filter(frame => frame.t === 'turn').map(frame => frame.eventId), [1])
  assert.equal((await stuck.rows()).length, 1)
  assert.deepEqual(stuck.empty(), NOTHING)
  assert.equal(stuck.bridge.counts.journalWritesLost, 1)
})

// ── MUST 6: bounds, each with its cleanup ─────────────────────────────────────────────────────────────────────────
test('MUST 6: her pending text is bounded at 64 KiB (the review\'s input: 200 deltas behind an unterminated [field tag)', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'q'))
  await fx.settle()
  const turnId = `eleven:${conv}:1`
  const turn = () => [...fx.bridge.convs.get(conv).turns.values()].find(item => item.turnId === turnId)
  let most = 0
  for (let seq = 0; seq < 200; seq++) {
    tab.json({ t: 'delta', turn: turnId, seq, text: (seq === 0 ? '[field ' : '') + 'x'.repeat(4000 - (seq === 0 ? 7 : 0)) })
    await fx.settle()
    most = Math.max(most, turn().pending.length)
  }
  assert.ok(most <= BRIDGE_LIMITS.pendingBytes, String(most))
  assert.ok(fx.bridge.counts.pendingOverflows >= 1)
  tab.json({ t: 'delta', turn: turnId, seq: 200, text: ' tail. Spoken again. ' })
  tab.json({ t: 'done', turn: turnId })
  await fx.settle()
  assert.deepEqual(spoken(provider, 1), ['Spoken again. '])
})

test('MUST 6: reply chunks kept for a retry are bounded at 256; a retry of that event then gets the empty final only', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'count'))
  await fx.settle()
  for (let seq = 0; seq < 300; seq++) tab.json({ t: 'delta', turn: `eleven:${conv}:1`, seq, text: `Number ${String(seq)}. ` })
  tab.json({ t: 'done', turn: `eleven:${conv}:1` })
  await fx.settle()
  const turn = fx.bridge.convs.get(conv).turns.get(1)
  assert.deepEqual([turn.sent.length, turn.sentTruncated, fx.bridge.counts.replyChunksDropped], [256, true, 44])
  const before = chunks(provider, 1).length
  provider.json(transcript(1, 'count'))
  await fx.settle()
  assert.deepEqual(chunks(provider, 1).slice(before), [{ type: 'agent_response', content: '', event_id: 1, is_final: true }])
})

test('MUST 6: at most 64 KiB queued per socket before validation, and at most eight sockets waiting for hello or init', async () => {
  const fx = fixture()
  const { tab } = await fx.connect()
  for (let index = 0; index < 8; index++) tab.send('x'.repeat(8192))
  assert.equal(tab.closedCode, null)
  tab.send('x'.repeat(8192))
  assert.equal(tab.closedCode, 1008)
  assert.equal(fx.bridge.counts.queueOverflows, 1)
  await fx.settle()
  // Waiting sockets: eight in all (tabs and providers); the ninth is closed at once; a place frees as one binds.
  const run = fixture()
  const waiting = []
  for (let index = 0; index < 5; index++) waiting.push((await run.openTab()).webSocket)
  for (let index = 0; index < 3; index++) waiting.push((await run.openProvider()).webSocket)
  assert.deepEqual(waiting.map(socket => socket.closedCode), Array(8).fill(null))
  const ninth = (await run.openProvider()).webSocket
  assert.equal(ninth.closedCode, 1013)
  assert.equal(run.bridge.counts.socketsRefused, 1)
  assert.equal(run.bridge.waiting.size, 8)
  run.clock.advance(10000)
  await run.settle()
  assert.deepEqual(waiting.map(socket => socket.closedCode), Array(8).fill(1008))
  assert.deepEqual(run.empty(), NOTHING)
})

// ── MUST 7: the provider's answers are read with the limit applied while reading ──────────────────────────────────
test('MUST 7: a provider answer with no length that streams 327,680 bytes is cancelled at 64 KiB, not read whole', async () => {
  for (const which of ['read', 'mint']) {
    let pulled = 0, cancelled = false
    const streaming = () => new Response(new ReadableStream({
      pull(controller) { if (pulled >= 327680) { controller.close(); return } pulled += 16384; controller.enqueue(new Uint8Array(16384).fill(32)) },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } })
    const fx = fixture({ providerFetch: url => (url.includes('/conversation/token') === (which === 'mint') ? streaming()
      : url.includes('/conversation/token') ? Response.json({ token: TOKEN, conversation_id: 'conv_1' }) : Response.json({ conversation: { max_duration_seconds: 1200 } })) })
    const response = await fx.ownerDoor()
    // An oversized saved-duration read is a failed read: the reserved seconds and a mint (VOICE job 2 item 1).
    const expected = which === 'read' ? [200, { token: TOKEN, maxDurationSeconds: 1200 }] : [503, { ok: false, code: 'VOICE_PROVIDER_UNAVAILABLE' }]
    assert.deepEqual([response.status, await response.json()], expected, which)
    assert.equal(cancelled, true, which)
    assert.ok(pulled <= PROVIDER_JSON_MAX_BYTES + 2 * 16384, `${which} pulled ${pulled}`)
  }
})

// ── MUST 8: the backchannel counts from the transcript's arrival ──────────────────────────────────────────────────
test('MUST 8: a journal answer delayed 4.9 s still gets the backchannel 13.5 s after the transcript ARRIVED (the early cue, past due, goes with the turn)', async () => {
  let gate = null, release = () => {}
  const fx = fixture({ journalGate: body => (body.action === undefined && gate ? gate : undefined) })
  const { provider } = await fx.connect()
  gate = new Promise(resolve => { release = resolve })
  const arrived = fx.clock.now()
  provider.json(transcript(1, 'think hard'))
  await ticks()
  fx.clock.advance(4900)
  gate = null
  release()
  await fx.settle()
  fx.clock.advance(arrived + 13499 - fx.clock.now())
  await fx.settle()
  assert.deepEqual(spoken(provider, 1), [EARLY_CUE])
  fx.clock.advance(1)
  assert.deepEqual(spoken(provider, 1), [EARLY_CUE, BACKCHANNEL])
  // A journal that answers after the moment has passed: the backchannel goes with the turn, at once.
  const late = fixture({ journalGate: body => (body.action === undefined && gate ? gate : undefined) })
  const live = await late.connect()
  gate = new Promise(resolve => { release = resolve })
  live.provider.json(transcript(1, 'think'))
  await ticks()
  late.clock.advance(14000)
  gate = null
  release()
  await late.settle()
  assert.deepEqual(spoken(live.provider, 1), [BACKCHANNEL])
})

// ── MUST 9: no raw words in a managed-voice journal row ───────────────────────────────────────────────────────────
test('MUST 9: a credential-like transcript is not stored in the journal row (hashes and the byte count only)', async () => {
  const fx = fixture()
  const { provider } = await fx.connect()
  const secret = 'my key is sk-ant-SYNTHETICabcdefghijklmnop0123456789'
  provider.json(transcript(1, secret))
  await fx.settle()
  const [row] = await fx.rows()
  assert.deepEqual([row.utterancePreview, row.utteranceBytes], ['', secret.length])
  assert.match(row.utteranceSha256, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify([...fx.headStorage.data.values()]).includes('SYNTHETIC'), false)
  assert.equal(JSON.stringify(fx.calls.journal).includes('SYNTHETIC'), false)
})

// ── SHOULD 1: admission reserves what is left, down to 60 s ───────────────────────────────────────────────────────
// 2026-11-18: the numbers below sit under the 5,356,800 s ceiling (the day has none of its own).
test('SHOULD 1: admission reserves min(1,200 s, what is left of the day and month); under 60 s left it refuses', async () => {
  for (const [used, saved, expect] of [[5356740, 60, 60], [5356740, 1200, 60], [5356200, 1200, 600], [5356200, 300, 300], [0, 1200, 1200]]) {
    const fx = fixture({ duration: saved })
    await fx.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-13', daySeconds: used, month: '2026-11', monthSeconds: used, slots: {} })
    const response = await fx.ownerDoor()
    assert.deepEqual(await response.json(), { token: TOKEN, maxDurationSeconds: expect }, `${used} ${saved}`)
    const record = await admission(fx)
    assert.deepEqual([record.daySeconds, Object.values(record.slots)[0].seconds], [used + expect, expect])
  }
  const short = fixture()
  await short.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-13', daySeconds: 5356741, month: '2026-11', monthSeconds: 5356741, slots: {} })
  assert.deepEqual(await (await short.ownerDoor()).json(), { ok: false, code: 'VOICE_QUOTA' })
  assert.equal(short.calls.provider.length, 0)
  const month = fixture()
  await month.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-13', daySeconds: 0, month: '2026-11', monthSeconds: 5356750, slots: {} })
  assert.deepEqual(await (await month.ownerDoor()).json(), { ok: false, code: 'VOICE_QUOTA' })
  // The bridge itself ends the conversation at the reserved number.
  const fx = fixture()
  await fx.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-13', daySeconds: 5356200, month: '2026-11', monthSeconds: 5356200, slots: {} })
  const { tab, provider, answer } = await fx.connect()
  assert.equal(answer.maxDurationSeconds, 600)
  fx.clock.advance(599999)
  await fx.settle()
  assert.equal(provider.closedCode, null)
  fx.clock.advance(1)
  await fx.settle()
  assert.deepEqual(tab.frames().at(-1), { t: 'end', reason: 'deadline' })
  assert.deepEqual(fx.empty(), NOTHING)
})

// ── SHOULD 2: retention of bridge turn indexes ────────────────────────────────────────────────────────────────────
test('SHOULD 2: bridge turn indexes are capped at 2,048 (oldest terminal first) and expire 24 h after their turn ended; an active one stays', async () => {
  const storage = memoryStorage()
  let now = AT
  const post = async body => (await handleInternalTurnJournalRoute(storage, 'POST', body, () => now)).json()
  const append = turnId => post({ turnId, provider: 'eleven-managed-voice', endpoint: '/door/voice-brain', requestSha256: 'c'.repeat(64), utteranceSha256: 'd'.repeat(64), modality: 'voice' })
  const indexes = () => [...storage.data.keys()].filter(key => key.startsWith('head:turn-journal:turn:eleven:'))
  // The cap: 2,049 finished turns leave 2,048 indexes; the oldest went first.
  for (let event = 1; event <= BRIDGE_INDEX_LIMITS.max + 1; event++) {
    assert.equal((await append(`eleven:conv_a:${String(event)}`)).ok, true)
    assert.equal((await post({ action: 'complete', turnId: `eleven:conv_a:${String(event)}` })).ok, true)
  }
  assert.equal(indexes().length, BRIDGE_INDEX_LIMITS.max)
  assert.equal(storage.data.has('head:turn-journal:turn:eleven:conv_a:1'), false)
  assert.equal(storage.data.has(`head:turn-journal:turn:eleven:conv_a:${String(BRIDGE_INDEX_LIMITS.max + 1)}`), true)
  assert.equal((await storage.get(BRIDGE_INDEX_KEY)).length, BRIDGE_INDEX_LIMITS.max)
  // A day later every one of them is swept (a few dozen per append).
  now = AT + BRIDGE_INDEX_LIMITS.keepMs + 1
  for (let event = 0; event < 40; event++) await append(`eleven:conv_b:${String(event)}`)
  assert.deepEqual(indexes().filter(key => key.includes('conv_a')), [])
  // Expiry counts from the turn's end, and an index of a turn still active is never removed.
  const fresh = memoryStorage()
  now = AT
  const postTo = async body => (await handleInternalTurnJournalRoute(fresh, 'POST', body, () => now)).json()
  const add = turnId => postTo({ turnId, provider: 'eleven-managed-voice', endpoint: '/door/voice-brain', requestSha256: 'c'.repeat(64), utteranceSha256: 'd'.repeat(64), modality: 'voice' })
  await add('eleven:conv_x:0')
  for (let event = 1; event <= 10; event++) { await add(`eleven:conv_x:${String(event)}`); await postTo({ action: event === 10 ? 'complete' : 'cancel', turnId: `eleven:conv_x:${String(event)}`, reason: 'barge_in' }) }
  now = AT + BRIDGE_INDEX_LIMITS.keepMs
  await add('eleven:conv_y:0')
  const left = () => [...fresh.data.keys()].filter(key => key.startsWith('head:turn-journal:turn:eleven:')).sort()
  assert.deepEqual(left(), ['head:turn-journal:turn:eleven:conv_x:0', 'head:turn-journal:turn:eleven:conv_y:0'])
  now = AT + 3 * BRIDGE_INDEX_LIMITS.keepMs
  await add('eleven:conv_y:1')
  assert.equal(left().includes('head:turn-journal:turn:eleven:conv_x:0'), true)
  assert.equal(DO_TURN_ID_RE.source, BRIDGE_TURN_ID_RE.source)
})

// ── SHOULD 3: a reservation or binding call that throws ───────────────────────────────────────────────────────────
test('SHOULD 3: a reservation, trim or binding call that throws answers VOICE_PROVIDER_UNAVAILABLE; given back only before the provider was called', async () => {
  const throwing = action => async request => { const path = new URL(request.url).pathname; if (path === '/voice-bridge/admit' && (await request.json()).action === action) throw new Error('object down') }
  const reserve = fixture({ bridgeFault: throwing('reserve') })
  assert.deepEqual([(await reserve.ownerDoor()).status, reserve.calls.provider.length], [503, 0])
  const trim = fixture({ duration: 600, bridgeFault: throwing('trim') })
  const trimmed = await trim.ownerDoor()
  assert.deepEqual([trimmed.status, await trimmed.json()], [503, { ok: false, code: 'VOICE_PROVIDER_UNAVAILABLE' }])
  assert.deepEqual([(await admission(trim)).daySeconds, Object.keys((await admission(trim)).slots).length], [0, 0])
  const bind = fixture({ bridgeFault: throwing('bind') })
  const bound = await bind.ownerDoor()
  assert.deepEqual([bound.status, await bound.json()], [503, { ok: false, code: 'VOICE_PROVIDER_UNAVAILABLE' }])
  assert.deepEqual([(await admission(bind)).daySeconds, Object.keys((await admission(bind)).slots).length], [1200, 0])
})

// ── The browser half's deviations (lead's item 18) ────────────────────────────────────────────────────────────────
test('item 18: the page\'s barge_in for a bridge turn id is accepted and idempotent with the bridge\'s own cancel, in both orders', async () => {
  const bargeIn = (fx, turnId) => fx.ownerDoor({ body: { action: 'barge_in', turnId } })
  // The bridge first (N+1 supersedes N), then the page.
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'first'))
  await fx.settle()
  provider.json(transcript(2, 'second'))
  await fx.settle()
  const after = await bargeIn(fx, `eleven:${conv}:1`)
  assert.deepEqual([after.status, (await after.json()).cancelled], [200, true])
  assert.deepEqual((await fx.rows())[0].cancelReason, 'barge_in')
  // The page first (its own interruption: barge_in, then fail VOICE_TURN_CANCELLED), then the provider's N+1.
  const run = fixture()
  const live = await run.connect()
  live.provider.json(transcript(1, 'first'))
  await run.settle()
  const before = await bargeIn(run, `eleven:${live.conv}:1`)
  assert.deepEqual([before.status, (await before.json()).cancelled], [200, true])
  live.tab.json({ t: 'fail', turn: `eleven:${live.conv}:1`, code: 'VOICE_TURN_CANCELLED' })
  await run.settle()
  live.provider.json(transcript(2, 'second'))
  await run.settle()
  assert.deepEqual(chunks(live.provider, 1), [{ type: 'agent_response', content: '', event_id: 1, is_final: true }])
  assert.deepEqual((await run.rows()).map(row => [row.turnId, row.cancelled, row.cancelReason]), [[`eleven:${live.conv}:1`, true, 'barge_in'], [`eleven:${live.conv}:2`, undefined, undefined]])
  assert.equal(run.bridge.journalWritesPending, 0)
  assert.equal(JSON.stringify(live.provider.frames()).includes(LOST_PLACE), false)
  assert.equal(tab.frames().some(frame => frame.t === 'end'), false)
})

test('item 18: a fail code is /^[A-Z_]{3,40}$/ and nothing else', async () => {
  for (const [code, ok] of [['VOICE_TURN_CANCELLED', true], ['ABC', true], ['A'.repeat(40), true], ['AB', false], ['A'.repeat(41), false], ['VOICE_TURN_1', false], ['voice_turn', false]]) {
    const fx = fixture()
    const { conv, tab, provider } = await fx.connect()
    provider.json(transcript(1, 'q'))
    await fx.settle()
    tab.json({ t: 'fail', turn: `eleven:${conv}:1`, code })
    await fx.settle()
    assert.equal(tab.closedCode === null, ok, code)
  }
})
