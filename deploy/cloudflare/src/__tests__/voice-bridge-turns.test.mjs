/** VoiceBridge turns: the real Worker and the real VoiceBridgeDO, HEAD's real turn journal, a fake provider socket that
 * signs its own JWT, and a fake tab socket. A turn, a streamed reply, the interruption, a provider retry, a lost tab, the
 * slow-reply backchannel, unbound init, a second hello, bad frames on both sockets and the clause rules. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ADMISSION_KEY, BACKCHANNEL, LOST_PLACE, nextClause, parseTabFrame } from '../voice-bridge-do.mjs'
import { handleInternalTurnJournalRoute } from '../turn-journal.mjs'
import { AT, agentFrames, fixture, memoryStorage, transcript } from './voice-bridge-fakes.mjs'

const chunks = (provider, eventId) => agentFrames(provider).filter(frame => frame.event_id === eventId)
const tabFrames = tab => tab.frames().filter(frame => frame.t !== 'ready')

test('a full turn: transcript journaled look-only BEFORE the tab hears it; her clause spoken; done completes the row', async () => {
  const fx = fixture()
  const { conv, tab, provider, answer } = await fx.connect()
  assert.deepEqual(answer, { token: 'T'.repeat(64), maxDurationSeconds: 1200 })
  assert.deepEqual(tab.frames(), [{ t: 'ready', conv, maxDurationSeconds: 1200 }])
  provider.json(transcript(1, '  what are you building today?  ', [{ role: 'user', content: 'earlier' }, { role: 'agent', content: 'reply' }]))
  await fx.settle()
  const turnId = `eleven:${conv}:1`
  assert.deepEqual(tabFrames(tab), [{ t: 'turn', turn: turnId, eventId: 1, transcript: 'what are you building today?' }])
  const [row] = await fx.rows()
  assert.equal(row.turnId, turnId)
  assert.equal(row.signerRole, 'voice-transcript-unconfirmed')
  assert.equal(row.voiceAuthority, 'none')
  assert.equal(row.modality, 'voice')
  assert.equal(row.provider, 'eleven-managed-voice')
  // MUST 9: hashes and the byte count only; the owner's speech is not in the row.
  assert.equal(row.utterancePreview, '')
  assert.equal(row.utteranceBytes, 'what are you building today?'.length)
  assert.equal(JSON.stringify(row).includes('building'), false)
  tab.json({ t: 'delta', turn: turnId, seq: 0, text: 'The voice bridge. ' })
  tab.json({ t: 'done', turn: turnId })
  await fx.settle()
  assert.deepEqual(chunks(provider, 1), [
    { type: 'agent_response', content: 'The voice bridge. ', event_id: 1, is_final: false },
    { type: 'agent_response', content: '', event_id: 1, is_final: true },
  ])
  const [done] = await fx.rows()
  assert.equal(done.completed, true)
  assert.equal(done.cancelled, undefined)
})

test('a three-chunk streamed reply arrives in order, clause by clause, and the tail is flushed at done', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(4, 'tell me three things'))
  await fx.settle()
  const turn = `eleven:${conv}:4`
  for (const [seq, text] of ['First thought. Sec', 'ond thought! ', 'And the third'].entries()) tab.json({ t: 'delta', turn, seq, text })
  await fx.settle()
  assert.deepEqual(chunks(provider, 4).map(frame => frame.content), ['First thought. ', 'Second thought! '])
  tab.json({ t: 'done', turn })
  await fx.settle()
  assert.deepEqual(chunks(provider, 4).map(frame => [frame.content, frame.is_final]), [['First thought. ', false], ['Second thought! ', false], ['And the third', false], ['', true]])
})

test('the interruption: N+1 cancels N with the existing barge-in cancel, tells the tab, and a late delta for N is dropped', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'explain the scion'))
  await fx.settle()
  const first = `eleven:${conv}:1`, second = `eleven:${conv}:2`
  tab.json({ t: 'delta', turn: first, seq: 0, text: 'The scion is her copy. ' })
  await fx.settle()
  provider.json(transcript(2, 'wait, what about Kira?'))
  await fx.settle()
  assert.deepEqual(tabFrames(tab).slice(1), [
    { t: 'cancel', turn: first, reason: 'superseded' },
    { t: 'turn', turn: second, eventId: 2, transcript: 'wait, what about Kira?' },
  ])
  const rows = await fx.rows()
  assert.deepEqual([rows[0].cancelled, rows[0].cancelReason], [true, 'barge_in'])
  assert.equal(rows[1].turnId, second)
  tab.json({ t: 'delta', turn: first, seq: 1, text: 'A late tail. ' })
  tab.json({ t: 'done', turn: first })
  tab.json({ t: 'delta', turn: second, seq: 0, text: 'Kira is memory. ' })
  await fx.settle()
  assert.deepEqual(chunks(provider, 1).map(frame => frame.content), ['The scion is her copy. '])
  assert.deepEqual(chunks(provider, 2).map(frame => frame.content), ['Kira is memory. '])
  assert.equal(fx.bridge.counts.deltasDropped, 2)
  // A stale event id (lower than the current one) starts nothing.
  provider.json(transcript(1, 'explain the scion'))
  await fx.settle()
  assert.equal((await fx.rows()).length, 2)
  assert.equal(fx.bridge.counts.staleEvents, 1)
})

test('a provider retry of N re-attaches: one journal row, one turn frame; a retry after done replays, never restarts', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(7, 'are you there'))
  provider.json(transcript(7, 'are you there'))
  await fx.settle()
  assert.equal((await fx.rows()).length, 1)
  assert.equal(tabFrames(tab).filter(frame => frame.t === 'turn').length, 1)
  const turn = `eleven:${conv}:7`
  tab.json({ t: 'delta', turn, seq: 0, text: 'I am here. ' })
  tab.json({ t: 'done', turn })
  await fx.settle()
  provider.json(transcript(7, 'are you there'))
  await fx.settle()
  assert.equal((await fx.rows()).length, 1)
  assert.equal(tabFrames(tab).filter(frame => frame.t === 'turn').length, 1)
  assert.deepEqual(chunks(provider, 7).slice(2).map(frame => [frame.content, frame.is_final]), [['I am here. ', false], ['', true]])
})

test('the tab gone: a JOURNALED turn gets the one honest sentence and its row is abandoned; a later one is not run or answered', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'first question'))
  await fx.settle()
  tab.close(1001)
  await fx.settle()
  assert.deepEqual(chunks(provider, 1).map(frame => [frame.content, frame.is_final]), [[LOST_PLACE, false], ['', true]])
  // MUST 2: with no tab, the next transcript is held, never journaled and never answered with a sentence; with no tab
  // back inside the hold, the conversation ends and leaves nothing.
  provider.json(transcript(2, 'second question'))
  await fx.settle()
  assert.deepEqual(chunks(provider, 2), [])
  const rows = await fx.rows()
  assert.deepEqual(rows.map(row => [row.turnId, row.cancelled, row.cancelReason]), [[`eleven:${conv}:1`, true, 'turn_abandon']])
  fx.clock.advance(10000)
  await fx.settle()
  assert.equal(provider.closedCode, 1008)
  assert.deepEqual(fx.empty(), { conversations: 0, sockets: 0, writes: 0, timers: 0 })
  assert.deepEqual(chunks(provider, 2), [])
  // A tab that reports it could not run her turn (`fail`): abandoned and NEVER spoken for (decisions 2 and
  // 18): the empty final only, the row closed as abandoned.
  const again = fixture()
  const live = await again.connect()
  live.provider.json(transcript(3, 'third'))
  await again.settle()
  live.tab.json({ t: 'fail', turn: `eleven:${live.conv}:3`, code: 'VOICE_TURN_CANCELLED' })
  await again.settle()
  assert.deepEqual(chunks(live.provider, 3).map(frame => [frame.content, frame.is_final]), [['', true]])
  assert.equal((await again.rows())[0].cancelReason, 'turn_abandon')
})

test('a slow reply: the one allowed backchannel goes out exactly once, 1.5 s before the provider timeout', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'think hard'))
  await fx.settle()
  fx.clock.advance(13499)
  await fx.settle()
  assert.equal(chunks(provider, 1).length, 0)
  fx.clock.advance(1)
  await fx.settle()
  fx.clock.advance(60000)
  await fx.settle()
  assert.deepEqual(chunks(provider, 1).map(frame => frame.content), [BACKCHANNEL])
  assert.equal(BACKCHANNEL, 'one sec... ')
  tab.json({ t: 'delta', turn: `eleven:${conv}:1`, seq: 0, text: 'Here it is. ' })
  tab.json({ t: 'done', turn: `eleven:${conv}:1` })
  await fx.settle()
  assert.deepEqual(chunks(provider, 1).map(frame => frame.content), [BACKCHANNEL, 'Here it is. ', ''])
  // A reply that starts in time gets no backchannel at all.
  provider.json(transcript(2, 'quick one'))
  await fx.settle()
  tab.json({ t: 'delta', turn: `eleven:${conv}:2`, seq: 0, text: 'Quick. ' })
  await fx.settle()
  fx.clock.advance(20000)
  await fx.settle()
  assert.deepEqual(chunks(provider, 2).map(frame => frame.content), ['Quick. '])
  // The tab lost after the backchannel alone: the honest sentence still follows, never 'one sec' and then silence.
  const lost = fixture()
  const live = await lost.connect()
  live.provider.json(transcript(1, 'think very hard'))
  await lost.settle()
  lost.clock.advance(13500)
  await lost.settle()
  live.tab.close(1001)
  await lost.settle()
  assert.deepEqual(chunks(live.provider, 1).map(frame => [frame.content, frame.is_final]), [[BACKCHANNEL, false], [LOST_PLACE, false], ['', true]])
})

test('init: an unknown conversation closes at once; a minted one with no hello is held at most 10 s, then closed', async () => {
  const fx = fixture()
  const stranger = (await fx.openProvider()).webSocket
  stranger.json({ type: 'init', conversation_id: 'conv_999' })
  await fx.settle()
  assert.equal(stranger.closedCode, 1008)
  assert.equal((await fx.ownerDoor()).status, 200)
  const held = (await fx.openProvider()).webSocket
  held.json({ type: 'init', conversation_id: 'conv_1' })
  await fx.settle()
  assert.equal(held.closedCode, null)
  fx.clock.advance(9999)
  await fx.settle()
  assert.equal(held.closedCode, null)
  fx.clock.advance(1)
  await fx.settle()
  assert.equal(held.closedCode, 1008)
  // A provider socket that never sends init is closed after 10 s; one whose tab says hello inside the hold stays.
  const silent = (await fx.openProvider()).webSocket
  fx.clock.advance(10000)
  await fx.settle()
  assert.equal(silent.closedCode, 1008)
  assert.equal((await fx.ownerDoor()).status, 200)
  const kept = (await fx.openProvider()).webSocket
  kept.json({ type: 'init', conversation_id: 'conv_2' })
  await fx.settle()
  const tab = (await fx.openTab()).webSocket
  tab.json({ t: 'hello', conv: 'conv_2' })
  await fx.settle()
  fx.clock.advance(20000)
  await fx.settle()
  assert.equal(kept.closedCode, null)
  kept.json({ type: 'ping', event_id: 3 })
  await fx.settle()
  assert.deepEqual(kept.frames().at(-1), { type: 'pong', event_id: 3 })
})

test('a second hello for the same conversation closes the older tab; turns go to the newer one', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  const newer = (await fx.openTab()).webSocket
  newer.json({ t: 'hello', conv })
  await fx.settle()
  assert.equal(tab.closedCode, 1000)
  assert.deepEqual(newer.frames(), [{ t: 'ready', conv, maxDurationSeconds: 1200 }])
  provider.json(transcript(1, 'still here?'))
  await fx.settle()
  assert.equal(newer.frames().at(-1).t, 'turn')
  assert.equal(tab.frames().some(frame => frame.t === 'turn'), false)
  // A hello for a conversation this owner never minted closes the socket.
  const wrong = (await fx.openTab()).webSocket
  wrong.json({ t: 'hello', conv: 'conv_404' })
  await fx.settle()
  assert.equal(wrong.closedCode, 1008)
})

test('bad frames close the socket: oversized, malformed, extra keys, out of order, binary (tab); oversized, unknown, before init (provider)', async () => {
  const fx = fixture()
  const { conv } = await fx.connect()
  const bad = ['x'.repeat(8193), '{', '[]', JSON.stringify({ t: 'hello', conv, extra: 1 }), JSON.stringify({ t: 'delta', turn: `eleven:${conv}:1`, seq: 0, text: 'x' }),
    JSON.stringify({ t: 'hello', conv: '../etc' }), JSON.stringify({ t: 'noise' })]
  for (const frame of bad) {
    const tab = (await fx.openTab()).webSocket
    tab.send(frame)
    await fx.settle()
    assert.equal(tab.closedCode, 1008, frame.slice(0, 60))
  }
  const binary = (await fx.openTab()).webSocket
  binary.send(new Uint8Array([1, 2, 3]))
  await fx.settle()
  assert.equal(binary.closedCode, 1008)
  // Once bound: a second hello, an extra key and a skipped seq each close it.
  for (const frame of [{ t: 'hello', conv }, { t: 'bye', more: true }, { t: 'delta', turn: `eleven:${conv}:1`, seq: 5, text: 'x' }]) {
    const run = fixture()
    const live = await run.connect()
    live.provider.json(transcript(1, 'q'))
    await run.settle()
    live.tab.json({ ...frame, ...(frame.t === 'hello' ? { conv: live.conv } : {}), ...(frame.turn ? { turn: `eleven:${live.conv}:1` } : {}) })
    await run.settle()
    assert.equal(live.tab.closedCode, 1008, JSON.stringify(frame))
  }
  for (const frame of ['x'.repeat(262145), JSON.stringify({ type: 'agent_response', content: 'x' }), JSON.stringify({ type: 'user_transcript', event_id: -1, user_transcript: [] }), 'nope']) {
    const provider = (await fx.openProvider()).webSocket
    provider.send(frame)
    await fx.settle()
    assert.equal(provider.closedCode, 1008, frame.slice(0, 60))
  }
  const early = (await fx.openProvider()).webSocket
  early.json(transcript(1, 'before init'))
  await fx.settle()
  assert.equal(early.closedCode, 1008)
  assert.equal(parseTabFrame(JSON.stringify({ t: 'delta', turn: 'eleven:c:1', seq: 0, text: 'x'.repeat(4001) })), null)
})

test('the clause rules: tags stripped; raw JSON, code and secrets in her text never reach the provider (dropped and counted)', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'show me'))
  await fx.settle()
  const turn = `eleven:${conv}:1`
  const parts = ['Hello [field glow 0.4]there. ', 'The key is sk-ant-abcdefghijklmnopqrstuvwx. ', 'Here: {"tool_call_id": 1}. ',
    'Hash 0123456789abcdef0123456789abcdef01234567 here. ', 'Run `rm -rf /; echo()` now. ', 'All good [fie', 'ld calm] now.']
  for (const [seq, text] of parts.entries()) tab.json({ t: 'delta', turn, seq, text })
  tab.json({ t: 'done', turn })
  await fx.settle()
  assert.deepEqual(chunks(provider, 1).map(frame => frame.content), ['Hello there. ', 'All good  now.', ''])
  assert.equal(fx.bridge.counts.clausesDropped, 4)
  const spoken = JSON.stringify(provider.frames())
  for (const leaked of ['sk-ant', 'tool_call_id', '0123456789abcdef', 'rm -rf', '[field']) assert.equal(spoken.includes(leaked), false, leaked)
})

test('the clause rules: a fenced code block or a multi-line JSON object is ONE refused unit, even split across deltas', async () => {
  const text = 'Here it is.\n```js\nconst owner = getOwner();\nlet x = 1\n```\n{\n  "owner": "owner@example.com",\n  "plan": "night grant"\n}\nDone. '
  // The review's exact input, whole and cut at every awkward place (inside the fence marks, the braces and a string).
  for (const cuts of [[], [14, 15, 40, 50, 51, 58, 70, 100], [...Array(text.length).keys()].slice(1)]) {
    const fx = fixture()
    const { conv, tab, provider } = await fx.connect()
    provider.json(transcript(1, 'show me the code'))
    await fx.settle()
    const turn = `eleven:${conv}:1`
    const parts = [0, ...cuts, text.length].slice(1).map((end, index, ends) => text.slice(index ? ends[index - 1] : 0, end)).filter(Boolean)
    for (const [seq, part] of parts.entries()) tab.json({ t: 'delta', turn, seq, text: part })
    tab.json({ t: 'done', turn })
    await fx.settle()
    const spoken = chunks(provider, 1).map(frame => frame.content)
    assert.deepEqual(spoken, ['Here it is.\n', 'Done. ', ''], `cuts ${cuts.length}`)
    assert.equal(fx.bridge.counts.clausesDropped, 2, `cuts ${cuts.length}`)
    for (const leaked of ['getOwner', 'let x', 'owner@example.com', 'night grant', 'owner', '```', '{', '}']) assert.equal(JSON.stringify(spoken).includes(leaked), false, leaked)
  }
  // A JSON array laid out over lines, and a block never closed before done: dropped whole too.
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'list them'))
  await fx.settle()
  const turn = `eleven:${conv}:1`
  for (const [seq, part] of ['Two items.\n[\n  "alpha",\n  "beta"\n]\nThen code.\n', '```\nsecret_line()\n', 'more()\n'].entries()) tab.json({ t: 'delta', turn, seq, text: part })
  tab.json({ t: 'done', turn })
  await fx.settle()
  assert.deepEqual(chunks(provider, 1).map(frame => frame.content), ['Two items.\n', 'Then code.\n', ''])
  assert.equal(fx.bridge.counts.clausesDropped, 2)
})

test('provider close ends the conversation: the running turn cancelled (provider-closed), the tab told end, the slot let go', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'goodbye soon'))
  await fx.settle()
  provider.json({ type: 'close' })
  await fx.settle()
  assert.deepEqual(tabFrames(tab).slice(1), [{ t: 'cancel', turn: `eleven:${conv}:1`, reason: 'provider-closed' }, { t: 'end', reason: 'provider-closed' }])
  assert.equal(tab.closedCode, 1000)
  assert.deepEqual([(await fx.rows())[0].cancelled, (await fx.rows())[0].cancelReason], [true, 'provider-closed'])
  assert.deepEqual(Object.keys((await fx.bridgeStorage.get(ADMISSION_KEY)).slots), [])
  // A dead socket (no close message) does the same; bye from the tab ends it too.
  const dead = fixture()
  const live = await dead.connect()
  live.provider.close(1006)
  await dead.settle()
  assert.deepEqual(live.tab.frames().at(-1), { t: 'end', reason: 'provider-closed' })
  const byeRun = fixture()
  const byeLive = await byeRun.connect()
  byeLive.tab.json({ t: 'bye' })
  await byeRun.settle()
  assert.equal(byeLive.provider.closedCode, 1000)
  assert.deepEqual(Object.keys((await byeRun.bridgeStorage.get(ADMISSION_KEY)).slots), [])
})

test('the reserved duration ends the conversation (deadline) and an empty transcript is refused without a journal row', async () => {
  const fx = fixture()
  const { tab, provider } = await fx.connect()
  provider.json(transcript(1, '   '))
  await fx.settle()
  assert.equal((await fx.rows()).length, 0)
  assert.equal(fx.bridge.counts.transcriptsRefused, 1)
  assert.deepEqual(chunks(provider, 1), [{ type: 'agent_response', content: '', event_id: 1, is_final: true }])
  fx.clock.advance(1200 * 1000)
  await fx.settle()
  assert.deepEqual(tab.frames().at(-1), { t: 'end', reason: 'deadline' })
  assert.equal(provider.closedCode, 1000)
})

test('nextClause keeps whitespace, waits for a sentence end, caps a clause and holds an unterminated tag', () => {
  assert.equal(nextClause('No end yet', false), null)
  assert.deepEqual(nextClause('No end yet', true), ['No end yet', ''])
  assert.deepEqual(nextClause('Pi is 3.14 exactly. Next', false), ['Pi is 3.14 exactly. ', 'Next'])
  assert.equal(nextClause('Hold [field glo', false), null)
  const long = 'word '.repeat(200)
  const [clause] = nextClause(long, false)
  assert.ok(clause.length <= 600 && clause.endsWith(' '))
})

test('the journal\'s complete action: bridge voice rows only, never a cancelled or dispatched one; again answers the same row', async () => {
  const storage = memoryStorage()
  const post = async body => { const response = await handleInternalTurnJournalRoute(storage, 'POST', body, () => AT); return [response.status, await response.json()] }
  const row = (turnId, extra = {}) => ({ turnId, provider: 'eleven-managed-voice', endpoint: '/door/voice-brain', requestSha256: 'c'.repeat(64), utteranceSha256: 'd'.repeat(64), ...extra })
  assert.equal((await post(row('eleven:conv_1:1', { modality: 'voice' })))[0], 200)
  const [status, first] = await post({ action: 'complete', turnId: 'eleven:conv_1:1' })
  assert.deepEqual([status, first.completed, first.idempotent, first.entry.completedAt], [200, true, false, AT])
  assert.deepEqual((await post({ action: 'complete', turnId: 'eleven:conv_1:1' }))[1].idempotent, true)
  assert.deepEqual((await post({ action: 'cancel', turnId: 'eleven:conv_1:1', reason: 'barge_in' }))[0], 409)
  assert.equal((await post(row('eleven:conv_1:2', { modality: 'voice' })))[0], 200)
  assert.equal((await post({ action: 'cancel', turnId: 'eleven:conv_1:2', reason: 'barge_in' }))[0], 200)
  assert.deepEqual(await post({ action: 'complete', turnId: 'eleven:conv_1:2' }), [409, { ok: false, status: 409, code: 'TURN_CANCELLED', turnId: 'eleven:conv_1:2' }])
  // SHOULD 5: a turn id that is not of the bridge's form is refused before anything is read (a door row, a page voice row).
  assert.equal((await post(row('door-turn-1')))[0], 200)
  assert.deepEqual(await post({ action: 'complete', turnId: 'door-turn-1' }), [400, { ok: false, code: 'TURN_JOURNAL_ID_INVALID' }])
  assert.equal((await post(row('auma-live:page-1', { modality: 'voice' })))[0], 200)
  assert.deepEqual(await post({ action: 'complete', turnId: 'auma-live:page-1' }), [400, { ok: false, code: 'TURN_JOURNAL_ID_INVALID' }])
  const pageRow = [...storage.data.values()].find(value => value?.turnId === 'auma-live:page-1' && value.schema)
  assert.equal(pageRow.completed, undefined)
  assert.equal((await post({ action: 'complete', turnId: 'eleven:conv_1:99' }))[0], 404)
  assert.equal((await post({ action: 'complete', turnId: 'missing' }))[0], 400)
  assert.equal((await post({ action: 'complete', turnId: 'bad id!' }))[0], 400)
  // The browser half ran the same turn with HEAD's turn_start: complete also settles head:turn:active for THAT turn
  // (as cancel does), so the active turn never stays 'running' until the heartbeat sweep calls it abandoned.
  assert.equal((await post(row('eleven:conv_1:3', { modality: 'voice' })))[0], 200)
  const running = { turn_id: 'eleven:conv_1:3', tab_id: 'tab-a', generation: 4, leaseToken: 'lease', started_at: AT - 5, heartbeat_at: AT - 1, status: 'running' }
  await storage.put('head:turn:active', running)
  const [settled, answer] = await post({ action: 'complete', turnId: 'eleven:conv_1:3' })
  assert.deepEqual([settled, answer.activeTurnCompleted], [200, true])
  assert.deepEqual(await storage.get('head:turn:active'), { ...running, status: 'completed', outcome: 'ok', completed_at: AT })
  // Another turn's active record is never touched.
  assert.equal((await post(row('eleven:conv_1:4', { modality: 'voice' })))[0], 200)
  const other = { ...running, turn_id: 'eleven:conv_1:5' }
  await storage.put('head:turn:active', other)
  assert.equal((await post({ action: 'complete', turnId: 'eleven:conv_1:4' }))[1].activeTurnCompleted, false)
  assert.deepEqual(await storage.get('head:turn:active'), other)
})
