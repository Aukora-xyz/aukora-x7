/** A spoken turn may take as long as her work takes; a turn that truly failed is never silent;
 * a call's reservation is trimmed to what it used on every end path; the status names why a call or a turn ended.
 * Real Worker, real VoiceBridgeDO, the real turn journal; fake provider and tab sockets, a manual clock. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ADMISSION_KEY, BACKCHANNEL, BYE_ENDS, EARLY_CUE, FAIL_LINES, HISTORY_KEY, LOST_PLACE, parseTabFrame } from '../voice-bridge-do.mjs'
import { VOICE_CALL_ENDS, VOICE_SDK_KINDS, VOICE_STATUS_CALLS, VOICE_STATUS_TURNS, VOICE_TURN_OUTCOMES } from '../voice-bridge.mjs'
import { VOICE_SESSION_LIMITS } from '../voice-session-policy.mjs'
import { AT, OWNER, agentFrames, fixture, transcript } from './voice-bridge-fakes.mjs'

const admission = async fx => (await fx.bridgeStorage.get(ADMISSION_KEY)) ?? null
const history = async fx => (await fx.bridgeStorage.get(HISTORY_KEY)) ?? { calls: [], turns: [] }
const spoken = (provider, eventId) => agentFrames(provider).filter(frame => frame.event_id === eventId).map(frame => frame.content)
const statusOf = async fx => (await fx.ownerDoor({ body: { action: 'managed_status' } })).json()

test('a turn that truly failed speaks ONE line for its code; the owner\'s own cut and a done turn speak none of them', async () => {
  for (const [code, line] of [
    ['VOICE_TURN_TIMEOUT', FAIL_LINES.VOICE_TURN_TIMEOUT], ['VOICE_TURN_CEILING', FAIL_LINES.VOICE_TURN_CEILING],
    ['VOICE_TURN_FAILED', FAIL_LINES.VOICE_TURN_FAILED], ['VOICE_TURN_BUSY', FAIL_LINES.VOICE_TURN_BUSY],
    ['VOICE_LOOK_ONLY_REFUSED', FAIL_LINES.VOICE_LOOK_ONLY_REFUSED], ['VOICE_TURN_INVALID', LOST_PLACE], ['VOICE_TURN_CANCELLED', null],
  ]) {
    const fx = fixture()
    const { conv, tab, provider } = await fx.connect()
    provider.json(transcript(1, 'look something up'))
    await fx.settle()
    tab.json({ t: 'fail', turn: `eleven:${conv}:1`, code })
    await fx.settle()
    assert.deepEqual(spoken(provider, 1), line === null ? [''] : [line, ''], code)
  }
  // A done turn: exactly her words, nothing added.
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'hello'))
  await fx.settle()
  tab.json({ t: 'delta', turn: `eleven:${conv}:1`, seq: 0, text: 'Here I am.' })
  tab.json({ t: 'done', turn: `eleven:${conv}:1` })
  await fx.settle()
  assert.deepEqual(spoken(provider, 1), ['Here I am.', ''])
  // A turn that already said something and then fails: nothing more (the page's own line went up as words).
  provider.json(transcript(2, 'and then?'))
  await fx.settle()
  tab.json({ t: 'delta', turn: `eleven:${conv}:2`, seq: 0, text: 'Looking. ' })
  tab.json({ t: 'fail', turn: `eleven:${conv}:2`, code: 'VOICE_TURN_FAILED' })
  await fx.settle()
  assert.deepEqual(spoken(provider, 2), ['Looking. ', ''])
})

test('the lookup case at the edge: her turn stays open through 90 s of quiet; one "one sec", then her words, in order, on the same event', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  const turn = `eleven:${conv}:1`
  provider.json(transcript(1, 'what is the weather in Ubud'))
  await fx.settle()
  fx.clock.advance(13_500)
  await fx.settle()
  assert.deepEqual(spoken(provider, 1), [EARLY_CUE, BACKCHANNEL])
  // The provider asks again for the same event while she works: re-attached, nothing new starts, nothing repeated.
  provider.json(transcript(1, 'what is the weather in Ubud'))
  fx.clock.advance(76_500)
  await fx.settle()
  assert.deepEqual(spoken(provider, 1), [EARLY_CUE, BACKCHANNEL])
  tab.json({ t: 'delta', turn, seq: 0, text: 'Warm and wet. ' })
  await fx.settle()
  fx.clock.advance(90_000)
  await fx.settle()
  tab.json({ t: 'delta', turn, seq: 1, text: 'Rain after four.' })
  tab.json({ t: 'done', turn })
  await fx.settle()
  assert.deepEqual(spoken(provider, 1), [EARLY_CUE, BACKCHANNEL, 'Warm and wet. ', 'Rain after four.', ''])
  // Her first words came after the provider's 15 s wait: the turn is a late answer, with its numbers, and no text.
  // The outcome is one of
  // answered | cancelled | failed | handed | refused, with a closed reason, marks, counts and tool calls (names only).
  const { turns } = await history(fx)
  assert.deepEqual(turns, [{ outcome: 'answered', reason: null, journalMs: 0, endMs: 180_000, calls: 0, merged: 0, grown: 0, resumed: 0, cues: 2, toolRounds: [],
    firstWordsSeconds: 90, longestQuietSeconds: 90, journaledMs: 0, handedMs: 0, firstTextMs: 90_000,
    firstSpeechMs: 90_000, modelFirstMs: null, cue: 'timeout', path: 'governed', atMs: AT + 180_000 }])
})

test('the provider gives up mid-turn (it closes): the edge tells the tab provider-closed, then end; the page carries her turn (page spec)', async () => {
  const fx = fixture()
  const { conv, tab, provider } = await fx.connect()
  provider.json(transcript(1, 'research this'))
  await fx.settle()
  fx.clock.advance(40_000)
  provider.json({ type: 'close' })
  await fx.settle()
  assert.deepEqual(tab.frames().slice(2), [{ t: 'cancel', turn: `eleven:${conv}:1`, reason: 'provider-closed' }, { t: 'end', reason: 'provider-closed' }])
  const { calls, turns } = await history(fx)
  assert.deepEqual(turns.map(item => item.outcome), ['cancelled'])
  assert.deepEqual(calls, [{ grantedSeconds: 1200, ended: 'provider-closed', lastedSeconds: 40, atMs: AT + 40_000 }])
})

test('seconds: the reservation is trimmed to what the call used on every end path', async () => {
  const used = async (fx, ms) => {
    const record = await admission(fx)
    assert.deepEqual(Object.keys(record.slots), [])
    assert.equal(record.daySeconds, Math.ceil(ms / 1000))
    assert.equal(record.monthSeconds, Math.ceil(ms / 1000))
  }
  // deadline: the whole reservation was used.
  const deadline = fixture()
  await deadline.connect()
  deadline.clock.advance(1_200_000)
  await deadline.settle()
  await used(deadline, 1_200_000)
  // provider-closed after 61.2 s: 62 s.
  const closed = fixture()
  const live = await closed.connect()
  closed.clock.advance(61_200)
  live.provider.json({ type: 'close' })
  await closed.settle()
  await used(closed, 61_200)
  // owner-stop (bye) after 5 minutes.
  const bye = fixture()
  const byeLive = await bye.connect()
  bye.clock.advance(300_000)
  byeLive.tab.json({ t: 'bye' })
  await bye.settle()
  await used(bye, 300_000)
  // unclaimed: the provider came, no tab ever said hello; ended after the 10 s hold.
  const unclaimed = fixture()
  assert.equal((await unclaimed.ownerDoor()).status, 200)
  const lone = (await unclaimed.openProvider()).webSocket
  lone.json({ type: 'init', conversation_id: 'conv_1' })
  await unclaimed.settle()
  unclaimed.clock.advance(10_000)
  await unclaimed.settle()
  await used(unclaimed, 10_000)
  // journal-unavailable: a barge-in cancel that never settles (5 tries over 15 s) ends the call.
  const down = fixture({ journalFault: body => (body.action === 'cancel' ? Response.json({ ok: false }, { status: 503 }) : undefined) })
  const downLive = await down.connect()
  downLive.provider.json(transcript(1, 'first'))
  await down.settle()
  downLive.provider.json(transcript(2, 'second'))
  await down.settle()
  for (const step of [1000, 2000, 4000, 8000]) { down.clock.advance(step); await down.settle() }
  assert.deepEqual(downLive.tab.frames().at(-1), { t: 'end', reason: 'journal-unavailable' })
  await used(down, 15_000)
  const ends = []
  for (const fx of [deadline, closed, bye, unclaimed, down]) ends.push((await history(fx)).calls.map(call => call.ended))
  assert.deepEqual(ends, [['deadline'], ['provider-closed'], ['owner-stop'], ['unclaimed'], ['journal-unavailable']])
  // error: a claimed call whose slot ran out with no end recorded keeps its seconds and is recorded as `error`.
  const lost = fixture()
  await lost.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-13', daySeconds: 1200, month: '2026-11', monthSeconds: 1200, slots: {
    'slot-x': { seconds: 1200, day: '2026-11-13', month: '2026-11', until: AT - 1, conv: 'conv_old', owner: OWNER, seedId: 'a'.repeat(64), mintedAt: AT - 1_230_001, helloAt: AT - 1_200_001, deadline: AT - 1 } } })
  assert.equal((await lost.ownerDoor()).status, 200)
  assert.deepEqual((await history(lost)).calls, [{ grantedSeconds: 1200, ended: 'error', lastedSeconds: 1200, atMs: AT - 1 }])
  assert.equal((await admission(lost)).daySeconds, 2400)
})

test('seconds: 5,356,800 a month and no smaller day; a call stays 1,200; under 60 s left is still VOICE_QUOTA', async () => {
  assert.deepEqual([VOICE_SESSION_LIMITS.seconds, VOICE_SESSION_LIMITS.daySeconds, VOICE_SESSION_LIMITS.monthSeconds, VOICE_SESSION_LIMITS.silenceSeconds], [1200, 5356800, 5356800, 180])
  const fx = fixture()
  await fx.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-13', daySeconds: 5356741, month: '2026-11', monthSeconds: 5356741, slots: {} })
  assert.deepEqual(await (await fx.ownerDoor()).json(), { ok: false, code: 'VOICE_QUOTA' })
  assert.equal(fx.calls.provider.length, 0)
  // Trimming gives seconds back: after a short call ends, the day has room again.
  const room = fixture()
  await room.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-13', daySeconds: 5355600, month: '2026-11', monthSeconds: 5355600, slots: {} })
  const live = await room.connect()
  assert.equal(live.answer.maxDurationSeconds, 1200)
  room.clock.advance(30_000)
  live.tab.json({ t: 'bye' })
  await room.settle()
  assert.equal((await admission(room)).daySeconds, 5355630)
  assert.deepEqual((await statusOf(room)).secondsLeft, { today: 1170, month: 1170 })
})

// CHANGED 2026-11-18: 12 calls are kept and shown (was 4), so one more call than that is made to prove the bound; every
// call takes 5 s, so the newest rows' times move with the count.
test('status: the last 12 calls and 24 turns, newest first, closed values and numbers only, no transcript text or id', async () => {
  const fx = fixture()
  const secret = 'SYNTHETIC OWNER WORDS'
  const made = VOICE_STATUS_CALLS + 1
  for (let call = 0; call < made; call++) {
    const { conv, tab, provider } = await fx.connect()
    for (let event = 1; event <= 2; event++) {
      provider.json(transcript(event, `${secret} ${String(call)} ${String(event)}`))
      await fx.settle()
      fx.clock.advance(2000)
      tab.json({ t: 'delta', turn: `eleven:${conv}:${String(event)}`, seq: 0, text: 'Yes.' })
      tab.json({ t: event === 2 ? 'fail' : 'done', turn: `eleven:${conv}:${String(event)}`, ...(event === 2 ? { code: 'VOICE_TURN_TIMEOUT' } : {}) })
      await fx.settle()
    }
    fx.clock.advance(1000)
    tab.json({ t: 'bye' })
    await fx.settle()
  }
  const body = await statusOf(fx)
  assert.equal(body.calls.length, VOICE_STATUS_CALLS)
  assert.equal(VOICE_STATUS_CALLS, 12)
  // The outcome is one of
  // answered | cancelled | failed | handed | refused, with a closed reason, marks, counts and tool calls (names only).
  assert.equal(body.turns.length, Math.min(VOICE_STATUS_TURNS, 2 * made))
  assert.deepEqual(body.calls[0], { grantedSeconds: 1200, ended: 'owner-stop', lastedSeconds: 5, atMs: AT + made * 5000 })
  assert.ok(body.calls.every((item, index) => index === 0 || item.atMs <= body.calls[index - 1].atMs))
  assert.deepEqual(body.turns.slice(0, 2), [
    // 'Yes.' was still gathered (no clause end yet) when the fail came: the edge's line was said, not hers.
    { outcome: 'failed', firstWordsSeconds: null, longestQuietSeconds: 2, journaledMs: 0, handedMs: 0, firstTextMs: 2000, firstSpeechMs: null, modelFirstMs: null,
      reason: 'turn_bound', journalMs: 0, endMs: 2000, calls: 0, merged: 0, grown: 0, resumed: 0, cues: 0, toolRounds: [], cue: 'none', path: 'governed', atMs: AT + made * 5000 - 1000 },
    { outcome: 'answered', firstWordsSeconds: 2, longestQuietSeconds: 2, journaledMs: 0, handedMs: 0, firstTextMs: 2000, firstSpeechMs: 2000, modelFirstMs: null,
      reason: null, journalMs: 0, endMs: 2000, calls: 0, merged: 0, grown: 0, resumed: 0, cues: 0, toolRounds: [], cue: 'none', path: 'governed', atMs: AT + made * 5000 - 3000 },
  ])
  for (const item of body.calls) assert.ok(VOICE_CALL_ENDS.includes(item.ended))
  for (const item of body.turns) assert.ok(VOICE_TURN_OUTCOMES.includes(item.outcome))
  const text = JSON.stringify(body)
  for (const leak of [secret, 'conv_', 'eleven:', 'Yes.', OWNER]) assert.equal(text.includes(leak), false, leak)
  assert.equal(JSON.stringify(await history(fx)).includes(secret), false)
  // A timeout the page reports with nothing said is recorded as a timeout.
  const quiet = fixture()
  const { conv, tab, provider } = await quiet.connect()
  provider.json(transcript(1, 'think hard'))
  await quiet.settle()
  quiet.clock.advance(60_000)
  tab.json({ t: 'fail', turn: `eleven:${conv}:1`, code: 'VOICE_TURN_TIMEOUT' })
  await quiet.settle()
  // The edge's own line for it is not her first words: firstWordsSeconds stays null (review SHOULD 2).
  assert.deepEqual(spoken(provider, 1), [EARLY_CUE, BACKCHANNEL, FAIL_LINES.VOICE_TURN_TIMEOUT, ''])
  assert.deepEqual((await statusOf(quiet)).turns, [{ outcome: 'failed', reason: 'turn_bound', journalMs: 0, endMs: 60_000, calls: 0, merged: 0, grown: 0, resumed: 0, cues: 2, toolRounds: [],
    firstWordsSeconds: null, longestQuietSeconds: 60, journaledMs: 0, handedMs: 0,
    firstTextMs: null, firstSpeechMs: null, modelFirstMs: null, cue: 'timeout', path: 'governed', atMs: AT + 60_000 }])
  // Hostile history rows (wrong values, text, extra fields) never reach the answer.
  const bad = fixture()
  await bad.bridgeStorage.put(HISTORY_KEY, { calls: [{ grantedSeconds: 1200, ended: 'hacked', lastedSeconds: 1, atMs: AT }, { grantedSeconds: 60, ended: 'deadline', lastedSeconds: 60, atMs: AT, text: secret }],
    turns: [{ outcome: 'done', firstWordsSeconds: 'x', longestQuietSeconds: 1, atMs: AT }, { outcome: 'done', firstWordsSeconds: null, longestQuietSeconds: 1, atMs: AT, words: secret },
      { outcome: 'done', firstWordsSeconds: 1, longestQuietSeconds: 1, journaledMs: -1, handedMs: 1.5, firstTextMs: secret, firstSpeechMs: 900, modelFirstMs: 'x', cue: 'hacked', path: 'hacked', atMs: AT }] })
  const read = await statusOf(bad)
  // An entry from before 2026-11-16 (no timings, no cue) and wrong timing or cue values read as null.
  assert.deepEqual([read.calls, read.turns], [[{ grantedSeconds: 60, ended: 'deadline', lastedSeconds: 60, atMs: AT }], [
    { outcome: 'answered', firstWordsSeconds: 1, longestQuietSeconds: 1, journaledMs: null, handedMs: null, firstTextMs: null, firstSpeechMs: 900, modelFirstMs: null,
      reason: null, journalMs: null, endMs: null, calls: 0, merged: 0, grown: 0, resumed: 0, cues: 0, toolRounds: [], cue: null, path: null, atMs: AT },
    { outcome: 'answered', firstWordsSeconds: null, longestQuietSeconds: 1, journaledMs: null, handedMs: null, firstTextMs: null, firstSpeechMs: null, modelFirstMs: null,
      reason: null, journalMs: null, endMs: null, calls: 0, merged: 0, grown: 0, resumed: 0, cues: 0, toolRounds: [], cue: null, path: null, atMs: AT }]])
  assert.equal(JSON.stringify(read).includes(secret), false)
  // The switch off: nothing is read from the object.
  const off = fixture({ env: { VOICE_MANAGED: undefined } })
  const offBody = await statusOf(off)
  assert.deepEqual([offBody.calls, offBody.turns, offBody.secondsLeft, off.bridgeBuilt], [[], [], null, false])
})

test('bye names why the page ended the call: Stop, its own timer, the provider hanging up, or an error; each is recorded so (review SHOULD 1)', async () => {
  assert.deepEqual(BYE_ENDS, { stop: 'owner-stop', timer: 'deadline', disconnected: 'provider-closed', error: 'error' })
  for (const [why, ended] of [['stop', 'owner-stop'], ['timer', 'deadline'], ['disconnected', 'provider-closed'], ['error', 'error'], [undefined, 'owner-stop']]) {
    const fx = fixture()
    const { tab, provider } = await fx.connect()
    fx.clock.advance(42_000)
    tab.json(why === undefined ? { t: 'bye' } : { t: 'bye', why })
    await fx.settle()
    assert.equal(provider.closedCode, 1000, String(why))
    const { calls } = await history(fx)
    assert.deepEqual(calls, [{ grantedSeconds: 1200, ended, lastedSeconds: 42, atMs: AT + 42_000 }], String(why))
    // Every one of them is trimmed to what the call used.
    const record = await admission(fx)
    assert.deepEqual([Object.keys(record.slots), record.daySeconds, record.monthSeconds], [[], 42, 42], String(why))
  }
  // Closed list only: an unknown or non-string `why`, or another key, is not a frame.
  for (const frame of [{ t: 'bye', why: 'hacked' }, { t: 'bye', why: ['stop'] }, { t: 'bye', why: 'toString' }, { t: 'bye', why: 'stop', more: 1 }]) {
    assert.equal(parseTabFrame(JSON.stringify(frame)), null, JSON.stringify(frame))
  }
})

test('bye may carry the closed sdk kind; it is recorded on the call and the status shows it; an unlisted one is refused (the voice tools part 2)', async () => {
  assert.deepEqual(VOICE_SDK_KINDS, ['socket', 'server', 'audio', 'permission', 'other'])
  for (const sdk of VOICE_SDK_KINDS) {
    const fx = fixture()
    const { tab, provider } = await fx.connect()
    fx.clock.advance(30_000)
    tab.json({ t: 'bye', why: 'error', sdk })
    await fx.settle()
    assert.equal(provider.closedCode, 1000, sdk)
    assert.deepEqual((await history(fx)).calls, [{ grantedSeconds: 1200, ended: 'error', lastedSeconds: 30, atMs: AT + 30_000, sdk }], sdk)
    assert.deepEqual((await statusOf(fx)).calls, [{ grantedSeconds: 1200, ended: 'error', lastedSeconds: 30, atMs: AT + 30_000, sdk }], sdk)
  }
  // Without it (a page from before this, or a call with no SDK error) the row has no sdk at all.
  const bare = fixture()
  const { tab } = await bare.connect()
  tab.json({ t: 'bye', why: 'disconnected' })
  await bare.settle()
  assert.deepEqual((await history(bare)).calls.map(call => Object.keys(call)), [['grantedSeconds', 'ended', 'lastedSeconds', 'atMs']])
  assert.equal('sdk' in (await statusOf(bare)).calls[0], false)
  // Closed list only, and only beside a why: anything else is not a frame, and the tab is refused as for an unknown why.
  for (const frame of [{ t: 'bye', why: 'error', sdk: 'hacked' }, { t: 'bye', why: 'error', sdk: 'toString' }, { t: 'bye', why: 'error', sdk: ['socket'] },
    { t: 'bye', why: 'error', sdk: 'Server error: words' }, { t: 'bye', sdk: 'socket' }, { t: 'bye', why: 'error', sdk: 'socket', more: 1 }]) {
    assert.equal(parseTabFrame(JSON.stringify(frame)), null, JSON.stringify(frame))
  }
  const refused = fixture()
  const live = await refused.connect()
  live.tab.json({ t: 'bye', why: 'error', sdk: 'hacked' })
  await refused.settle()
  assert.equal((await history(refused)).calls.some(call => 'sdk' in call), false)
  // A stored row whose sdk is outside the list (never written by this bridge) is read without it.
  const odd = fixture()
  await odd.bridgeStorage.put(HISTORY_KEY, { calls: [{ grantedSeconds: 60, ended: 'error', lastedSeconds: 5, atMs: AT, sdk: 'words words' }], turns: [] })
  assert.deepEqual((await statusOf(odd)).calls, [{ grantedSeconds: 60, ended: 'error', lastedSeconds: 5, atMs: AT }])
})

test('a lost turn (her tab went away) speaks the fixed sentence, and that sentence is not her first words (review SHOULD 2)', async () => {
  const fx = fixture()
  const { tab, provider } = await fx.connect()
  provider.json(transcript(1, 'are you there'))
  await fx.settle()
  fx.clock.advance(5000)
  tab.close(1001)
  await fx.settle()
  assert.deepEqual(spoken(provider, 1), [EARLY_CUE, LOST_PLACE, ''])
  const { turns } = await history(fx)
  // The outcome is one of
  // answered | cancelled | failed | handed | refused, with a closed reason, marks, counts and tool calls (names only).
  assert.deepEqual(turns, [{ outcome: 'failed', reason: 'tab_lost', journalMs: 0, endMs: 5000, calls: 0, merged: 0, grown: 0, resumed: 0, cues: 1, toolRounds: [],
    firstWordsSeconds: null, longestQuietSeconds: 5, journaledMs: 0, handedMs: 0, firstTextMs: null,
    firstSpeechMs: null, modelFirstMs: null, cue: 'early', path: 'governed', atMs: AT + 5000 }])
})
