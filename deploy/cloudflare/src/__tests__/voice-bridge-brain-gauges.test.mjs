/** 2026-11-18 (production: every call ended by the provider about 2 s after it connected, and the owner's status read
 * could not say whether the provider ever reached the brain door, nor what its saved resource says): GAUGES, AND ONE
 * FRAGILITY REMOVED. The status counts what each door accepted, the provider frames ignored or refused, and a start
 * nobody claimed; it shows 12 calls; it carries more closed facts of the provider's saved resource (where its brain
 * socket points, what kind of value its secret header holds, its limits and waits), never the address or a header
 * value. A provider frame of a type the adapter does not know is counted and ignored instead of closing the call.
 * Real Worker and VoiceBridgeDO over the fakes; the provider's answers are faked. No network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ADMISSION_KEY, AWARE_FRAME_MAX_BYTES, CALLS_KEPT, FAILURES_KEY, HISTORY_KEY, INIT_WAIT_MS, PROVIDER_SEEN_KEY } from '../voice-bridge-do.mjs'
import { VOICE_BRIDGE_ROUTES, VOICE_FAILURE_STAGES, VOICE_PROVIDER_SETTINGS, VOICE_STATUS_CALLS, VOICE_STATUS_COUNTS, providerSettings,
  readProviderSettings } from '../voice-bridge.mjs'
import { PROVIDER_FRAME_MAX_BYTES, PROVIDER_HISTORY_MAX, parse } from '../voice-provider-speech-engine.mjs'
import { VOICE_CONNECT_WINDOW_MS, VOICE_MINT_WINDOW_MS } from '../voice-session-policy.mjs'
import { AT, ORIGIN, RESOURCE, TOKEN, fixture, transcript } from './voice-bridge-fakes.mjs'

const HOST = new URL(ORIGIN).host
const statusOf = async fx => (await fx.ownerDoor({ body: { action: 'managed_status' } })).json()
const countsOf = async fx => (await statusOf(fx)).counts
const NEW_COUNTS = ['brainSockets', 'brainInits', 'brainFramesOther', 'brainFramesRefused', 'tabSockets', 'tabHellos', 'tabHellosRefused', 'startsUnclaimed']
const pick = (counts, names = NEW_COUNTS) => Object.fromEntries(names.map(name => [name, counts[name]]))
const zero = Object.fromEntries(NEW_COUNTS.map(name => [name, 0]))

// ── Part 3: the adapter ─────────────────────────────────────────────────────────────────────────────────────────────
test('parse: a type it does not know, and a transcript with no event_id, are { kind: "other" } and keep nothing', () => {
  for (const frame of [{ type: 'agent_response', content: 'x' }, { type: 'conversation_metadata', secret: 'SOMETHING THE PROVIDER SENT' }, { type: '' },
    { type: 'user_transcript', user_transcript: [{ role: 'user', content: 'no id' }] }, { type: 'user_transcript' }]) {
    assert.deepEqual(parse(JSON.stringify(frame)), { kind: 'other' }, JSON.stringify(frame))
  }
  // The known kinds are unchanged.
  assert.deepEqual(parse(JSON.stringify({ type: 'init', conversation_id: 'conv_1' })), { kind: 'init', conv: 'conv_1' })
  assert.equal(parse(JSON.stringify(transcript(3, 'hi'))).kind, 'transcript')
  assert.deepEqual(parse(JSON.stringify({ type: 'ping', event_id: 4 })), { kind: 'ping', eventId: 4 })
  assert.deepEqual(parse(JSON.stringify({ type: 'close' })), { kind: 'close' })
  assert.deepEqual(parse(JSON.stringify({ type: 'error' })), { kind: 'error' })
})

test('parse: what stays unreadable (null): a present but invalid event id, a history not a list or too long, not JSON, not an object, no type, oversize, a bad init', () => {
  const over = Array.from({ length: PROVIDER_HISTORY_MAX + 1 }, () => ({ role: 'user', content: 'x' }))
  for (const text of [
    JSON.stringify({ type: 'user_transcript', event_id: -1, user_transcript: [] }),
    JSON.stringify({ type: 'user_transcript', event_id: null, user_transcript: [] }),
    JSON.stringify({ type: 'user_transcript', event_id: '1', user_transcript: [] }),
    JSON.stringify({ type: 'user_transcript', event_id: 1.5, user_transcript: [] }),
    JSON.stringify({ type: 'user_transcript', event_id: 1, user_transcript: 'not a list' }),
    JSON.stringify({ type: 'user_transcript', event_id: 1 }),
    JSON.stringify({ type: 'user_transcript', event_id: 1, user_transcript: over }),
    '{', 'nope', '', JSON.stringify([{ type: 'init' }]), '42', '"init"', 'null',
    JSON.stringify({ conversation_id: 'conv_1' }), JSON.stringify({ type: 7 }),
    JSON.stringify({ type: 'mystery', pad: 'x'.repeat(PROVIDER_FRAME_MAX_BYTES) }),
    JSON.stringify({ type: 'init' }), JSON.stringify({ type: 'init', conversation_id: '../etc' }),
  ]) assert.equal(parse(text), null, text.slice(0, 60))
  assert.equal(parse(undefined), null)
})

// ── Part 4: the object ─────────────────────────────────────────────────────────────────────────────────────────────
test('an unknown frame before init and after init leaves the socket open, is counted, and the init and transcript after it still work', async () => {
  const fx = fixture()
  assert.equal((await fx.ownerDoor()).status, 200)
  const provider = (await fx.openProvider()).webSocket
  provider.json({ type: 'conversation_initiation_metadata', words: 'NOTHING OF THIS IS KEPT' })
  await fx.settle()
  assert.equal(provider.closedCode, null)
  // It was not an init: the socket still waits for one.
  assert.equal(fx.bridge.waiting.size, 1)
  provider.json({ type: 'init', conversation_id: 'conv_1' })
  await fx.settle()
  const tab = (await fx.openTab()).webSocket
  tab.json({ t: 'hello', conv: 'conv_1' })
  await fx.settle()
  provider.json({ type: 'agent_response_correction', event_id: 1 })
  provider.json({ type: 'user_transcript', user_transcript: [{ role: 'user', content: 'an entry with no id' }] })
  await fx.settle()
  assert.equal(provider.closedCode, null)
  assert.equal(fx.calls.journal.length, 0, 'a transcript with no event id is not a turn')
  provider.json(transcript(1, 'are you there?'))
  await fx.settle()
  assert.equal(tab.frames().at(-1).t, 'turn')
  assert.deepEqual(pick(await countsOf(fx)), { ...zero, brainSockets: 1, brainInits: 1, brainFramesOther: 3, tabSockets: 1, tabHellos: 1 })
  const kept = JSON.stringify([await statusOf(fx), [...fx.bridgeStorage.data]])
  assert.equal(kept.includes('NOTHING OF THIS IS KEPT'), false)
  assert.equal(kept.includes('an entry with no id'), false)
})

test('an unknown frame does not stand in for init: the socket is still closed after the init wait (init-timeout)', async () => {
  const fx = fixture()
  const provider = (await fx.openProvider()).webSocket
  provider.json({ type: 'mystery' })
  await fx.settle()
  fx.clock.advance(INIT_WAIT_MS)
  await fx.settle()
  assert.equal(provider.closedCode, 1008)
  assert.deepEqual(((await fx.bridgeStorage.get(FAILURES_KEY))?.provider ?? []).map(item => item.stage), ['init-timeout'])
  assert.deepEqual(pick(await countsOf(fx)), { ...zero, brainSockets: 1, brainFramesOther: 1 })
})

test('an unreadable frame closes the socket 1008, is counted, and is recorded as frame-refused in the status failures', async () => {
  assert.ok(VOICE_FAILURE_STAGES.provider.includes('frame-refused'))
  const fx = fixture()
  const early = (await fx.openProvider()).webSocket
  early.send('not json at all')
  await fx.settle()
  assert.equal(early.closedCode, 1008)
  // After init, inside a live call: the call is let go exactly as an unreadable frame always did (provider-closed).
  const { tab, provider } = await fx.connect()
  provider.json({ type: 'user_transcript', event_id: 1, user_transcript: 'not a list' })
  await fx.settle()
  assert.equal(provider.closedCode, 1008)
  assert.equal(tab.frames().at(-1).t, 'end')
  const body = await statusOf(fx)
  assert.deepEqual(pick(body.counts), { ...zero, brainSockets: 2, brainInits: 1, brainFramesRefused: 2, tabSockets: 1, tabHellos: 1 })
  assert.deepEqual(body.failures.filter(item => item.door === 'provider').map(item => item.stage), ['frame-refused'])
  assert.equal(body.calls[0].ended, 'provider-closed')
  assert.equal(JSON.stringify(body).includes('not json'), false)
})

test('a provider frame refused as it arrives (over the socket cap, or too much queued) is counted and recorded as frame-refused too', async () => {
  // Larger than the brain socket's cap: listen() closes the socket before parse ever sees the frame.
  const oversize = fixture()
  const big = (await oversize.openProvider()).webSocket
  big.send('x'.repeat(PROVIDER_FRAME_MAX_BYTES + 1))
  await oversize.settle()
  assert.equal(big.closedCode, 1008)
  const bigBody = await statusOf(oversize)
  assert.deepEqual(pick(bigBody.counts), { ...zero, brainSockets: 1, brainFramesRefused: 1 })
  assert.deepEqual(bigBody.failures.filter(item => item.door === 'provider').map(item => item.stage), ['frame-refused'])
  assert.equal(oversize.bridge.counts.queueOverflows, 0)

  // Inside a live call, more than 64 KiB behind the frame in hand: the call is let go as before, and the frame that closed
  // the socket is counted once (the frames queued before it are dropped unread, as before).
  const overflow = fixture()
  const { tab, provider } = await overflow.connect()
  for (let index = 0; index < 8; index++) provider.send('x'.repeat(8192))
  assert.equal(provider.closedCode, null)
  provider.send('x'.repeat(8192))
  assert.equal(provider.closedCode, 1008)
  await overflow.settle()
  assert.equal(tab.frames().at(-1).t, 'end')
  const body = await statusOf(overflow)
  assert.deepEqual(pick(body.counts), { ...zero, brainSockets: 1, brainInits: 1, brainFramesRefused: 1, tabSockets: 1, tabHellos: 1 })
  assert.deepEqual(body.failures.filter(item => item.door === 'provider').map(item => item.stage), ['frame-refused'])
  assert.equal(body.calls[0].ended, 'provider-closed')
  assert.equal(overflow.bridge.counts.queueOverflows, 1)

  // The page's socket is not the brain door: a tab frame over its cap closes it as before and counts nothing here.
  const tabOnly = fixture()
  const page = (await tabOnly.openTab()).webSocket
  page.send('x'.repeat(AWARE_FRAME_MAX_BYTES + 1))
  await tabOnly.settle()
  assert.equal(page.closedCode, 1008)
  const tabBody = await statusOf(tabOnly)
  assert.deepEqual(pick(tabBody.counts), { ...zero, tabSockets: 1 })
  assert.deepEqual(tabBody.failures, [])
})

test('the door counts: sockets each door accepted, valid inits, hellos that claimed a place and hellos refused', async () => {
  const fx = fixture()
  // Refused in the Worker (a bad JWT): it never reaches the object, so it is not a brain socket.
  assert.notEqual((await fx.openProvider({ jwt: 'bad.jwt.here' })).status, 101)
  assert.deepEqual(pick(await countsOf(fx)), zero)
  const first = await fx.connect()
  const second = await fx.connect()
  assert.deepEqual(pick(await countsOf(fx)), { ...zero, brainSockets: 2, brainInits: 2, tabSockets: 2, tabHellos: 2 })
  // A hello for a conversation nobody minted: refused (and closed).
  const stranger = (await fx.openTab()).webSocket
  stranger.json({ t: 'hello', conv: 'conv_404' })
  await fx.settle()
  assert.equal(stranger.closedCode, 1008)
  // An init for a conversation nobody minted: closed, not a valid init.
  const unbound = (await fx.openProvider()).webSocket
  unbound.json({ type: 'init', conversation_id: 'conv_nobody' })
  await fx.settle()
  assert.equal(unbound.closedCode, 1008)
  assert.deepEqual(pick(await countsOf(fx)), { ...zero, brainSockets: 3, brainInits: 2, tabSockets: 3, tabHellos: 2, tabHellosRefused: 1 })
  assert.equal(first.provider.closedCode, null)
  assert.equal(second.provider.closedCode, null)
  // The status shows every count by its closed name, whole numbers only.
  const counts = await countsOf(fx)
  assert.deepEqual(Object.keys(counts), VOICE_STATUS_COUNTS)
  for (const name of NEW_COUNTS) assert.ok(VOICE_STATUS_COUNTS.includes(name), name)
  assert.ok(Object.values(counts).every(Number.isSafeInteger))
})

test('a bound start nobody claims leaves one "unclaimed" row (lastedSeconds 0) once its window passed and another transaction runs; its seconds stay spent', async () => {
  const fx = fixture()
  assert.equal((await fx.ownerDoor()).status, 200)
  assert.equal((await fx.bridgeStorage.get(ADMISSION_KEY)).daySeconds, 1200)
  fx.clock.advance(VOICE_CONNECT_WINDOW_MS + 1)
  // The status read alone writes nothing (it is a read).
  assert.deepEqual((await statusOf(fx)).calls, [])
  // The next start's admission finds the lapsed slot.
  assert.equal((await fx.ownerDoor()).status, 200)
  const body = await statusOf(fx)
  assert.deepEqual(body.calls, [{ grantedSeconds: 1200, ended: 'unclaimed', lastedSeconds: 0, atMs: AT + VOICE_CONNECT_WINDOW_MS }])
  assert.equal(body.counts.startsUnclaimed, 1)
  assert.equal((await fx.bridgeStorage.get(ADMISSION_KEY)).daySeconds, 2400)
  // Found once: later transactions do not push it again.
  await fx.bridge.admit({ action: 'status' })
  await fx.bridge.admit({ action: 'release', slot: 'slot-none' })
  assert.equal((await statusOf(fx)).calls.length, 1)
})

test('the "unclaimed" row is written once even when the transaction that found the lapsed slot then refuses', async () => {
  const fx = fixture()
  assert.equal((await fx.ownerDoor()).status, 200)
  fx.clock.advance(VOICE_CONNECT_WINDOW_MS + 1)
  // An invalid trim: the admission returns without writing its own record. The lapsed slot's deletion is written anyway.
  assert.deepEqual(await fx.bridge.admit({ action: 'trim', slot: 'slot-none', seconds: 60 }), { ok: false, code: 'VOICE_ADMIT_INVALID' })
  assert.deepEqual(await fx.bridge.admit({ action: 'bind', slot: 'slot-none', conv: 'conv_9' }), { ok: false, code: 'VOICE_ADMIT_INVALID' })
  assert.equal((await fx.ownerDoor()).status, 200)
  assert.deepEqual((await statusOf(fx)).calls.map(call => call.ended), ['unclaimed'])
  assert.equal((await countsOf(fx)).startsUnclaimed, 1)
})

test('a slot only reserved leaves no row; a claimed call and a provider-only start keep exactly the rows they had', async () => {
  const reserved = fixture()
  const at = reserved.clock.now()
  assert.equal((await reserved.bridge.admit({ action: 'reserve', seconds: 1200, at })).ok, true)
  reserved.clock.advance(VOICE_MINT_WINDOW_MS + 1)
  assert.equal((await reserved.bridge.admit({ action: 'reserve', seconds: 1200, at: reserved.clock.now() })).ok, true)
  assert.deepEqual((await statusOf(reserved)).calls, [])
  assert.equal((await countsOf(reserved)).startsUnclaimed, 0)

  // A claimed call that ended: its own row, nothing added when the windows pass and more starts come.
  const claimed = fixture()
  const { tab } = await claimed.connect()
  claimed.clock.advance(4000)
  tab.json({ t: 'bye' })
  await claimed.settle()
  const before = (await statusOf(claimed)).calls
  assert.deepEqual(before, [{ grantedSeconds: 1200, ended: 'owner-stop', lastedSeconds: 4, atMs: AT + 4000 }])
  claimed.clock.advance(VOICE_CONNECT_WINDOW_MS * 30)
  assert.equal((await claimed.ownerDoor()).status, 200)
  assert.deepEqual((await statusOf(claimed)).calls, before)
  assert.equal((await countsOf(claimed)).startsUnclaimed, 0)

  // The provider connected but no tab came: the conversation's own "unclaimed" end (after the 10 s hold), as before; the
  // lapsed window adds nothing to it.
  const providerOnly = fixture()
  assert.equal((await providerOnly.ownerDoor()).status, 200)
  const provider = (await providerOnly.openProvider()).webSocket
  provider.json({ type: 'init', conversation_id: 'conv_1' })
  await providerOnly.settle()
  providerOnly.clock.advance(10_000)
  await providerOnly.settle()
  const held = (await statusOf(providerOnly)).calls
  assert.deepEqual(held, [{ grantedSeconds: 1200, ended: 'unclaimed', lastedSeconds: 10, atMs: AT + 10_000 }])
  providerOnly.clock.advance(VOICE_CONNECT_WINDOW_MS)
  assert.equal((await providerOnly.ownerDoor()).status, 200)
  assert.deepEqual((await statusOf(providerOnly)).calls, held)
  assert.equal((await countsOf(providerOnly)).startsUnclaimed, 0)
})

test('her "last call ended" fact skips a start nobody claimed: it stays the claimed call\'s end', async () => {
  const fx = fixture()
  // A claimed call that ends (her last real call).
  const first = await fx.connect()
  fx.clock.advance(4000)
  first.tab.json({ t: 'bye' })
  await fx.settle()
  const claimedAt = AT + 4000
  // A bound start nobody claims; its window passes and the next start finds it.
  assert.equal((await fx.ownerDoor()).status, 200)
  fx.clock.advance(VOICE_CONNECT_WINDOW_MS + 1)
  const next = await fx.connect()
  const calls = (await fx.bridgeStorage.get(HISTORY_KEY)).calls
  assert.deepEqual(calls.map(call => [call.ended, call.atMs]), [['owner-stop', claimedAt], ['unclaimed', claimedAt + VOICE_CONNECT_WINDOW_MS]])
  // What the new call's fast turn opens with: the facts of her Memory line.
  const opened = await fx.bridge.openMemory(fx.bridge.convs.get(next.conv))
  assert.notEqual(opened.facts, null)
  assert.equal(opened.facts.lastCallAt, claimedAt)
  // The provider-only "unclaimed" end (a provider came, no tab) was a call, and stays her last call ended.
  const held = { grantedSeconds: 1200, ended: 'unclaimed', lastedSeconds: 10, atMs: claimedAt + VOICE_CONNECT_WINDOW_MS + 5 }
  await fx.bridge.pushHistory(fx.bridgeStorage, 'calls', held)
  assert.equal((await fx.bridge.openMemory(fx.bridge.convs.get(next.conv))).facts.lastCallAt, held.atMs)
})

test('twelve call rows are kept and shown, newest first', async () => {
  assert.deepEqual([VOICE_STATUS_CALLS, CALLS_KEPT], [12, 12])
  const fx = fixture()
  const row = index => ({ grantedSeconds: 1200, ended: 'deadline', lastedSeconds: index, atMs: AT + index })
  for (let index = 0; index < 15; index++) await fx.bridge.pushHistory(fx.bridgeStorage, 'calls', row(index))
  assert.deepEqual((await fx.bridgeStorage.get(HISTORY_KEY)).calls, Array.from({ length: 12 }, (_, index) => row(index + 3)))
  assert.deepEqual((await statusOf(fx)).calls, Array.from({ length: 12 }, (_, index) => row(14 - index)))
  // More rows stored than kept (an older object's), the status still shows 12.
  await fx.bridgeStorage.put(HISTORY_KEY, { calls: Array.from({ length: 20 }, (_, index) => row(index)), turns: [] })
  assert.deepEqual((await statusOf(fx)).calls, Array.from({ length: 12 }, (_, index) => row(19 - index)))
})

// ── Part 1: the provider's saved resource ──────────────────────────────────────────────────────────────────────────
const ADDRESS_ELSEWHERE = 'wss://brain-host-7f3a.example.invalid/door/voice-brain'
const HEADER_TEXT = 'HEADER-VALUE-SECRET-9c1e'
const ours = `wss://${HOST}${VOICE_BRIDGE_ROUTES.provider}`
/** Shaped like the provider's documented GET /v1/speech-engine/{id} answer. */
const documented = (engine = {}) => ({
  speech_engine_id: 'seng_x61test', name: 'x6.1 Auma Live',
  speech_engine: { ws_url: ours, request_headers: { 'x-aukora-voice-bridge': { secret_id: 'sec_ZZZ9' }, 'x-other': HEADER_TEXT } },
  overrides: { first_message: true },
  auth: { enable_auth: false },
  call_limits: { agent_concurrency_limit: -1, daily_limit: 100000, bursting_enabled: true },
  conversation: { max_duration_seconds: 1200 },
  turn: { turn_timeout: 7, initial_wait_time: null, silence_end_call_timeout: 180, turn_eagerness: 'normal' },
  cascade_timeout_seconds: 15,
  metadata: { created_at_unix_secs: 1763000000, updated_at_unix_secs: 1763400000, last_updated_from: 'ui' },
  ...engine,
})
const NEW_FACTS = { brainUrl: 'ours', brainHeader: 'secret', overrideFirstMessage: true, authEnabled: false, dailyLimit: 100000, concurrencyLimit: -1,
  maxDurationSeconds: 1200, turnTimeoutSeconds: 7, initialWaitSeconds: 'not read', updatedAtSeconds: 1763400000, updatedFrom: 'ui' }
const withEngine = (engine) => documented({ speech_engine: engine })

test('providerSettings on a resource shaped like the documented answer: each new fact, closed', () => {
  const read = providerSettings(RESOURCE, documented(), HOST)
  for (const [name, value] of Object.entries(NEW_FACTS)) assert.equal(read[name], value, name)
  assert.equal(read.turnEagerness, 'normal')
  assert.equal(read.eventWaitSeconds, 15)
  assert.deepEqual(Object.keys(read), [...VOICE_PROVIDER_SETTINGS, 'waitMatches'])
  // Closed again (the object and the Worker do): unchanged.
  assert.deepEqual(readProviderSettings(read), read)
  assert.deepEqual(readProviderSettings(readProviderSettings(read)), read)
  // A number the provider may save, and the edges of each shape.
  const other = providerSettings(RESOURCE, documented({ turn: { turn_timeout: 1.5, initial_wait_time: 2 }, call_limits: { agent_concurrency_limit: 3, daily_limit: '100' },
    overrides: { first_message: 'yes' }, auth: { enable_auth: true }, conversation: { max_duration_seconds: 12.5 },
    metadata: { updated_at_unix_secs: 4102444801, last_updated_from: 'browser' } }), HOST)
  assert.deepEqual(pick(other, Object.keys(NEW_FACTS)), { ...NEW_FACTS, turnTimeoutSeconds: 1.5, initialWaitSeconds: 2, concurrencyLimit: 3, dailyLimit: 'not read',
    overrideFirstMessage: 'not read', authEnabled: true, maxDurationSeconds: 'not read', updatedAtSeconds: 'not read', updatedFrom: 'not read' })
  for (const [at, expected] of [[0, 'not read'], [1, 1], [4102444800, 4102444800], [1.5, 'not read'], ['1763400000', 'not read']]) {
    assert.equal(providerSettings(RESOURCE, documented({ metadata: { updated_at_unix_secs: at } }), HOST).updatedAtSeconds, expected, String(at))
  }
  // An agent resource has none of these places: only its metadata is read.
  const agent = providerSettings('agent_x', { ...documented(), conversation_config: {} }, HOST)
  assert.deepEqual(pick(agent, Object.keys(NEW_FACTS)), { ...Object.fromEntries(Object.keys(NEW_FACTS).map(name => [name, 'not read'])), updatedAtSeconds: 1763400000, updatedFrom: 'ui' })
  assert.deepEqual(pick(providerSettings('agent_x', {}, HOST), Object.keys(NEW_FACTS)), Object.fromEntries(Object.keys(NEW_FACTS).map(name => [name, 'not read'])))
})

test('brainUrl: ours only for exactly wss://<this host><the provider door>; another host, a query, ws:, another path are other; none is missing', () => {
  const kind = (ws, host = HOST) => providerSettings(RESOURCE, withEngine({ ws_url: ws, request_headers: {} }), host).brainUrl
  assert.equal(kind(ours), 'ours')
  assert.equal(kind(`wss://${HOST.toUpperCase()}${VOICE_BRIDGE_ROUTES.provider}`), 'ours', 'a host name has no case')
  assert.equal(kind(ADDRESS_ELSEWHERE), 'other')
  assert.equal(kind(`${ours}?token=1`), 'other')
  assert.equal(kind(`${ours}#x`), 'other')
  assert.equal(kind(`ws://${HOST}${VOICE_BRIDGE_ROUTES.provider}`), 'other')
  assert.equal(kind(`https://${HOST}${VOICE_BRIDGE_ROUTES.provider}`), 'other')
  assert.equal(kind(`wss://${HOST}${VOICE_BRIDGE_ROUTES.provider}/`), 'other')
  assert.equal(kind(`wss://${HOST}:8443${VOICE_BRIDGE_ROUTES.provider}`), 'other')
  assert.equal(kind(`wss://${HOST}/_host/voice/bridge`), 'other')
  assert.equal(kind('not a url at all'), 'other')
  assert.equal(kind(''), 'missing')
  assert.equal(kind(42), 'missing')
  assert.equal(kind(undefined), 'missing')
  // Without the edge's own host, or without the speech_engine object, it cannot be said.
  assert.equal(providerSettings(RESOURCE, withEngine({ ws_url: ours }), undefined).brainUrl, 'not read')
  assert.equal(kind(ours, null), 'not read')
  assert.equal(kind(ours, ''), 'not read')
  assert.equal(providerSettings(RESOURCE, documented({ speech_engine: undefined }), HOST).brainUrl, 'not read')
  assert.equal(providerSettings(RESOURCE, documented({ speech_engine: 'wss://x' }), HOST).brainUrl, 'not read')
})

test('brainHeader: the kind of value saved under the bridge secret header (name without case): text, secret, variable, or missing', () => {
  const kind = headers => providerSettings(RESOURCE, withEngine({ ws_url: ours, request_headers: headers }), HOST).brainHeader
  assert.equal(kind({ 'x-aukora-voice-bridge': HEADER_TEXT }), 'text')
  assert.equal(kind({ 'X-Aukora-Voice-Bridge': { secret_id: 'sec_ZZZ9' } }), 'secret')
  assert.equal(kind({ 'x-aukora-voice-bridge': { variable_name: 'var_QQQ8' } }), 'variable')
  assert.equal(kind({ 'x-other': HEADER_TEXT }), 'missing')
  assert.equal(kind({}), 'missing')
  assert.equal(kind(undefined), 'missing')
  assert.equal(kind(null), 'missing')
  // Out of shape: a value of another kind, headers that are not an object, the header under two spellings.
  assert.equal(kind({ 'x-aukora-voice-bridge': 7 }), 'not read')
  assert.equal(kind({ 'x-aukora-voice-bridge': { secret_id: 9 } }), 'not read')
  assert.equal(kind([['x-aukora-voice-bridge', HEADER_TEXT]]), 'not read')
  assert.equal(kind({ 'x-aukora-voice-bridge': HEADER_TEXT, 'X-AUKORA-VOICE-BRIDGE': { secret_id: 'sec_ZZZ9' } }), 'not read')
})

test('neither the socket address nor any header value appears anywhere in what is kept', () => {
  for (const engine of [{ ws_url: ADDRESS_ELSEWHERE, request_headers: { 'x-aukora-voice-bridge': HEADER_TEXT } },
    { ws_url: `${ours}?q=${HEADER_TEXT}`, request_headers: { 'x-aukora-voice-bridge': { secret_id: 'sec_ZZZ9' } } },
    { ws_url: ours, request_headers: { 'x-aukora-voice-bridge': { variable_name: 'var_QQQ8' } } }]) {
    const text = JSON.stringify(readProviderSettings(providerSettings(RESOURCE, withEngine(engine), HOST)))
    for (const value of [ADDRESS_ELSEWHERE, 'brain-host-7f3a', HEADER_TEXT, 'sec_ZZZ9', 'var_QQQ8', HOST, 'wss:', VOICE_BRIDGE_ROUTES.provider]) {
      assert.equal(text.includes(value), false, value)
    }
  }
})

test('the facts survive the round trip: owner door, then the object\'s storage, then managed_status, unchanged', async () => {
  for (const [saved, brainUrl, brainHeader] of [[documented(), 'ours', 'secret'],
    [withEngine({ ws_url: ADDRESS_ELSEWHERE, request_headers: { 'x-aukora-voice-bridge': HEADER_TEXT } }), 'other', 'text']]) {
    const fx = fixture({ providerFetch: url => (new URL(url).pathname.startsWith('/v1/speech-engine/') ? Response.json(saved) : Response.json({ token: TOKEN, conversation_id: 'conv_1' })) })
    assert.equal((await fx.ownerDoor()).status, 200)
    const expected = providerSettings(RESOURCE, saved, HOST)
    assert.deepEqual([expected.brainUrl, expected.brainHeader], [brainUrl, brainHeader])
    assert.deepEqual((await fx.bridgeStorage.get(PROVIDER_SEEN_KEY)).settings, expected)
    const body = await statusOf(fx)
    assert.deepEqual(body.provider, { readAtMs: fx.clock.now(), ...expected })
    const kept = JSON.stringify([body, [...fx.bridgeStorage.data]])
    for (const value of [ADDRESS_ELSEWHERE, 'brain-host-7f3a', HEADER_TEXT, 'sec_ZZZ9', ours]) assert.equal(kept.includes(value), false, value)
    {
      // No new request by the SESSION: the one read of the saved resource, then the mint. The status read itself asks the
      // provider two more things since the provider side (2026-11-18): its account and its newest conversations.
      const paths = fx.calls.provider.map(call => new URL(call.url).pathname)
      assert.deepEqual([paths.length, paths.slice(2)], [4, ['/v1/user/subscription', '/v1/convai/conversations']])
    }
  }
})
