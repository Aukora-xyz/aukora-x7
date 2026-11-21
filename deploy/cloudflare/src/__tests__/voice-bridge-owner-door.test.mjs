/** VoiceBridge door 1, POST /_host/voice {"action":"managed_session"}: owner and origin first, then the switch and the
 * settings, then admission (atomic, before any provider call), then the saved duration and the mint under one 12 s
 * deadline. Real Worker, real VoiceBridgeDO, fake provider REST answers. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ADMISSION_KEY, HISTORY_KEY } from '../voice-bridge-do.mjs'
import { MANAGED_SESSION_REFUSALS, VOICE_BRIDGE_SETTINGS } from '../voice-bridge.mjs'
import { VOICE_SESSION_LIMITS } from '../voice-session-policy.mjs'
import { ACCESS, AT, KEY, RESOURCE, SECRET, TOKEN, fixture } from './voice-bridge-fakes.mjs'

const admission = async fx => (await fx.bridgeStorage.get(ADMISSION_KEY)) ?? null
const mints = fx => fx.calls.provider.filter(call => call.url.includes('/conversation/token')).length
async function refused(response, status, code) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { ok: false, code })
}

test('the answer is exactly { token, maxDurationSeconds }; the edge reads then mints for its ONE resource, key only in the header', async () => {
  const fx = fixture()
  const response = await fx.ownerDoor()
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.deepEqual(JSON.parse(text), { token: TOKEN, maxDurationSeconds: 1200 })
  assert.equal(text.includes(KEY), false)
  assert.deepEqual(fx.calls.provider.map(call => call.url), [`https://api.elevenlabs.io/v1/speech-engine/${RESOURCE}`, `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${RESOURCE}`])
  for (const { init } of fx.calls.provider) {
    assert.equal(init.redirect, 'manual')
    assert.deepEqual([...new Headers(init.headers)], [['xi-api-key', KEY]])
    assert.ok(init.signal instanceof AbortSignal)
  }
  const record = await admission(fx)
  assert.deepEqual([record.daySeconds, record.monthSeconds], [1200, 1200])
  const [slot] = Object.values(record.slots)
  assert.deepEqual([slot.conv, slot.owner, slot.seconds], ['conv_1', ACCESS.email, 1200])
  // An agent resource is read at the agents path (the website's documented read).
  const agent = fixture({ env: { ELEVENLABS_X61_VOICE_RESOURCE_ID: 'agent_x61test' } })
  assert.equal((await agent.ownerDoor()).status, 200)
  assert.equal(agent.calls.provider[0].url, 'https://api.elevenlabs.io/v1/convai/agents/agent_x61test')
})

test('the body is exactly {"action":"managed_session"}: a resource, model, tool or override from the client is refused before anything', async () => {
  for (const body of [{ action: 'managed_session', agent_id: 'agent_evil' }, { action: 'managed_session', overrides: {} }, { action: 'managed_session', model: 'x' },
    { action: 'managed_session', tools: [] }, { action: 'managed_session', maxDurationSeconds: 7200 }]) {
    const fx = fixture()
    await refused(await fx.ownerDoor({ body }), 400, 'VOICE_ACTION_INVALID')
    assert.deepEqual([fx.calls.provider.length, fx.calls.bridge.length], [0, 0])
  }
})

test('owner with a passkey session, origin and same-origin first: an ambient owner pass alone, another person or a foreign page gets nothing', async () => {
  for (const access of [{ ...ACCESS, session: undefined }, { ...ACCESS, session: '' }, { ...ACCESS, email: 'other@example.invalid' }, { ...ACCESS, type: 'access' },
    { ...ACCESS, expires: AT / 1000 }]) {
    const fx = fixture({ access })
    await refused(await fx.ownerDoor(), 403, 'OWNER_ACCESS_REQUIRED')
    assert.deepEqual([fx.calls.provider.length, fx.calls.bridge.length], [0, 0])
  }
  const signedOut = fixture({ access: null })
  await refused(await signedOut.ownerDoor(), 401, 'OWNER_ACCESS_REQUIRED')
  for (const headers of [{ 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': null }, { origin: 'https://foreign.invalid' }]) {
    const fx = fixture()
    assert.equal((await fx.ownerDoor({ headers })).status, 403)
    assert.deepEqual([fx.calls.provider.length, fx.calls.bridge.length], [0, 0])
  }
})

test('the switch: anything but exactly "1" and managed_session is not dispatched at all: byte for byte an unknown action', async () => {
  const shape = async response => [response.status, [...response.headers].filter(([name]) => name !== 'date').sort(), await response.text()]
  for (const value of ['0', undefined, '', 'true', ' 1', '1 ', 'on', '01']) {
    const fx = fixture({ env: { VOICE_MANAGED: value } })
    const managed = await shape(await fx.ownerDoor())
    const control = await shape(await fx.ownerDoor({ body: { action: 'no_such_action' } }))
    assert.deepEqual(managed, control, String(value))
    assert.deepEqual(managed.slice(0, 1).concat(managed.slice(2)), [400, JSON.stringify({ ok: false, code: 'VOICE_ACTION_INVALID' })])
    assert.deepEqual([fx.calls.provider.length, fx.calls.bridge.length, fx.bridgeBuilt], [0, 0, false])
  }
  // VOICE_MANAGED_OFF has left the edge's vocabulary.
  assert.equal(Object.hasOwn(MANAGED_SESSION_REFUSALS, 'VOICE_MANAGED_OFF'), false)
  for (const file of ['../voice-bridge.mjs', '../voice-bridge-do.mjs', '../voice-director.mjs']) {
    assert.equal(readFileSync(new URL(file, import.meta.url), 'utf8').includes('VOICE_MANAGED_OFF'), false, file)
  }
})

test('VOICE_NOT_CONFIGURED names nothing and calls nothing when a setting or the object is missing', async () => {
  assert.deepEqual(VOICE_BRIDGE_SETTINGS, ['VOICE_MANAGED', 'ELEVENLABS_VOICE_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_X61_VOICE_RESOURCE_ID', 'ELEVENLABS_BRIDGE_SECRET'])
  for (const env of [{ ELEVENLABS_API_KEY: undefined }, { ELEVENLABS_API_KEY: '  ' }, { ELEVENLABS_X61_VOICE_RESOURCE_ID: undefined }, { ELEVENLABS_X61_VOICE_RESOURCE_ID: 'voice_x' },
    { ELEVENLABS_X61_VOICE_RESOURCE_ID: 'agent_bad/../x' }, { ELEVENLABS_BRIDGE_SECRET: undefined }, { ELEVENLABS_BRIDGE_SECRET: 'short' }]) {
    const fx = fixture({ env })
    await refused(await fx.ownerDoor(), 503, 'VOICE_NOT_CONFIGURED')
    assert.deepEqual([fx.calls.provider.length, fx.calls.bridge.length], [0, 0], JSON.stringify(Object.keys(env)))
  }
  const unbound = fixture({ noBinding: true })
  await refused(await unbound.ownerDoor(), 503, 'VOICE_NOT_CONFIGURED')
  assert.equal(unbound.calls.provider.length, 0)
})

// 2026-11-18: the day has no ceiling of its own (it equals the month's 5,356,800 s).
test('admission ceilings: sixteen at once (VOICE_BUSY), 5,356,800 s a month and no smaller day (VOICE_QUOTA); refusals call no provider', async () => {
  assert.deepEqual([VOICE_SESSION_LIMITS.seconds, VOICE_SESSION_LIMITS.daySeconds, VOICE_SESSION_LIMITS.monthSeconds, VOICE_SESSION_LIMITS.silenceSeconds], [1200, 5356800, 5356800, 180])
  assert.deepEqual(MANAGED_SESSION_REFUSALS, { VOICE_NOT_CONFIGURED: 503, VOICE_QUOTA: 429, VOICE_PROVIDER_UNAVAILABLE: 503, VOICE_BUSY: 409 })
  // 2026-11-18 (CHANGED: the place count was 2): sixteen starts may be held or in flight at once; the next is refused.
  const PLACES = VOICE_SESSION_LIMITS.liveConversations
  assert.equal(PLACES, 16)
  const fx = fixture()
  for (let index = 1; index <= PLACES; index++) assert.equal((await fx.ownerDoor()).status, 200, String(index))
  await refused(await fx.ownerDoor(), 409, 'VOICE_BUSY')
  assert.equal(mints(fx), PLACES)
  // A minted conversation nobody claims lapses after its connect window (its seconds stay reserved): further starts in
  // the same day are all admitted.
  for (let index = PLACES + 1; index <= 19; index++) {
    fx.clock.advance(61000)
    assert.equal((await fx.ownerDoor()).status, 200, String(index))
  }
  assert.equal(mints(fx), 19)
  assert.equal((await admission(fx)).daySeconds, 19 * 1200)
  // The ceiling that is left: with one call's room in the day and the month, one start is admitted and the next refused.
  const last = fixture()
  await last.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-13', daySeconds: 5355600, month: '2026-11', monthSeconds: 5355600, slots: {} })
  assert.equal((await last.ownerDoor()).status, 200)
  last.clock.advance(61000)
  await refused(await last.ownerDoor(), 429, 'VOICE_QUOTA')
  assert.equal((await admission(last)).daySeconds, 5356800)
  // The next UTC day starts at zero; the month ceiling still counts.
  const month = fixture()
  await month.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-12', daySeconds: 21600, month: '2026-11', monthSeconds: 5355600, slots: {} })
  assert.equal((await month.ownerDoor()).status, 200)
  month.clock.advance(61000)
  await refused(await month.ownerDoor(), 429, 'VOICE_QUOTA')
  assert.deepEqual([(await admission(month)).daySeconds, (await admission(month)).monthSeconds], [1200, 5356800])
})

test('two requests racing for the last allocation: exactly one wins, exactly one mint', async () => {
  const fx = fixture()
  await fx.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-13', daySeconds: 5355600, month: '2026-11', monthSeconds: 5355600, slots: {} })
  const answers = await Promise.all([fx.ownerDoor(), fx.ownerDoor()])
  assert.deepEqual(answers.map(response => response.status).sort(), [200, 429])
  assert.equal(mints(fx), 1)
  assert.equal((await admission(fx)).daySeconds, 5356800)
})

test('a shorter saved provider duration is returned AND reserved; a longer or invalid one means the reserved seconds (job 2 item 1)', async () => {
  const fx = fixture({ duration: 600 })
  const response = await fx.ownerDoor()
  assert.deepEqual(await response.json(), { token: TOKEN, maxDurationSeconds: 600 })
  assert.deepEqual([(await admission(fx)).daySeconds, Object.values((await admission(fx)).slots)[0].seconds], [600, 600])
  for (const duration of [1201, 7200, 59, 0, -1, 600.5, '600', null]) {
    const bad = fixture({ duration })
    const answer = await bad.ownerDoor()
    assert.deepEqual([answer.status, await answer.json()], [200, { token: TOKEN, maxDurationSeconds: 1200 }], String(duration))
    assert.equal(mints(bad), 1, String(duration))
    const record = await admission(bad)
    assert.deepEqual([record.daySeconds, record.monthSeconds, Object.values(record.slots)[0].seconds], [1200, 1200, 1200], 'the reserved seconds')
  }
})

test('the provider unavailable: a failed read still mints (job 2 item 1); every mint failure is VOICE_PROVIDER_UNAVAILABLE with no provider text, kept', async () => {
  const leak = 'PROVIDER-SECRET-DETAIL'
  const read = (url, init) => Response.json({ conversation: { max_duration_seconds: 1200 } })
  const cases = {
    'read 500': () => new Response(leak, { status: 500 }),
    'read 429': () => Response.json({ detail: leak }, { status: 429 }),
    'read redirect': () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }),
    'read not json': () => new Response(leak, { headers: { 'content-type': 'text/plain' } }),
    'read throws': () => { throw new Error(leak) },
    'mint 500': (url, init, n) => (n === 1 ? read(url, init) : new Response(leak, { status: 500 })),
    'mint short token': (url, init, n) => (n === 1 ? read(url, init) : Response.json({ token: 'x'.repeat(39), conversation_id: 'conv_1' })),
    'mint long token': (url, init, n) => (n === 1 ? read(url, init) : Response.json({ token: 'x'.repeat(16385), conversation_id: 'conv_1' })),
    'mint token holding the key': (url, init, n) => (n === 1 ? read(url, init) : Response.json({ token: `${'x'.repeat(40)}${KEY}`, conversation_id: 'conv_1' })),
    'mint no conversation': (url, init, n) => (n === 1 ? read(url, init) : Response.json({ token: TOKEN })),
    'mint bad conversation': (url, init, n) => (n === 1 ? read(url, init) : Response.json({ token: TOKEN, conversation_id: 'conv/../1' })),
    'mint too large': (url, init, n) => (n === 1 ? read(url, init) : new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '70000' } })),
    'deadline': (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  }
  for (const [name, providerFetch] of Object.entries(cases)) {
    // A read that fails is answered by the reserved seconds and a mint (job 2 item 1).
    const fx = fixture({ providerFetch: name.startsWith('read') ? (url, init, n) => (url.includes('/conversation/token') ? Response.json({ token: TOKEN, conversation_id: 'conv_1' }) : providerFetch(url, init, n)) : providerFetch })
    const started = Date.now()
    const response = await fx.ownerDoor(name === 'deadline' ? { headers: {} } : {})
    if (name === 'deadline') assert.ok(Date.now() - started >= 11000, 'the 12 s deadline ended it')
    const text = await response.text()
    if (name.startsWith('read')) {
      assert.deepEqual([response.status, JSON.parse(text)], [200, { token: TOKEN, maxDurationSeconds: 1200 }], name)
      assert.equal(text.includes(leak), false, name)
      continue
    }
    assert.equal(response.status, 503, name)
    assert.deepEqual(JSON.parse(text), { ok: false, code: 'VOICE_PROVIDER_UNAVAILABLE' }, name)
    assert.equal(text.includes(leak) || text.includes(KEY) || text.includes(SECRET), false, name)
    const record = await admission(fx)
    // Every remaining case reached the mint (the deadline one after its 3 s read). A mint the provider answered with a
    // status (mint 500) started nothing: its seconds are given back (review MUST). A shape or a deadline keeps them.
    assert.equal(fx.calls.provider.some(call => call.url.includes('/conversation/token')), true, name)
    assert.deepEqual([record.daySeconds, Object.keys(record.slots).length], [name === 'mint 500' ? 0 : 1200, 0], name)
  }
})

test('a wrong key never locks the owner out (review MUST): thirty-one presses with the read AND the mint refused cost nothing, the next good start works', async () => {
  for (const status of [401, 403]) {
    let refuse = true
    const fx = fixture({ providerFetch: url => {
      if (refuse) return Response.json({ detail: 'nope' }, { status })
      return url.includes('/conversation/token') ? Response.json({ token: TOKEN, conversation_id: 'conv_1' }) : Response.json({ conversation: { max_duration_seconds: 1200 } })
    } })
    for (let index = 0; index < 31; index++) await refused(await fx.ownerDoor(), 503, 'VOICE_PROVIDER_UNAVAILABLE')
    assert.equal(mints(fx), 31, 'every press reached the mint (the read is best effort)')
    const spent = await admission(fx)
    assert.deepEqual([spent.daySeconds, spent.monthSeconds, Object.keys(spent.slots).length], [0, 0, 0], String(status))
    refuse = false
    const response = await fx.ownerDoor()
    assert.deepEqual([response.status, await response.json()], [200, { token: TOKEN, maxDurationSeconds: 1200 }], String(status))
    assert.deepEqual([(await admission(fx)).daySeconds, (await admission(fx)).monthSeconds], [1200, 1200], String(status))
  }
})

test('a broken provider read never locks the owner out: the session starts anyway on the reserved seconds (job 2 item 1)', async () => {
  const fx = fixture({ providerFetch: (url) => {
    if (!url.includes('/conversation/token')) return new Response('nope', { status: 404 })
    return Response.json({ token: TOKEN, conversation_id: 'conv_1' })
  } })
  const response = await fx.ownerDoor()
  assert.deepEqual([response.status, await response.json()], [200, { token: TOKEN, maxDurationSeconds: 1200 }])
  assert.deepEqual([(await admission(fx)).daySeconds, (await admission(fx)).monthSeconds], [1200, 1200])
})

// The edge restarted under live calls four times that day
// (deploys). Each call's slot stayed in storage for up to 20 minutes with nothing live behind it.
const lostSlot = (fx, conv, helloAgoMs) => {
  const now = fx.clock.now()
  return { seconds: 1200, day: '2026-11-13', month: '2026-11', conv, owner: 'owner-fixture', seedId: 'a'.repeat(64),
    mintedAt: now - helloAgoMs - 2000, helloAt: now - helloAgoMs, until: now - helloAgoMs + 1200000, deadline: now - helloAgoMs + 1228000 }
}
test('calls the edge lost in a restart do not hold their slots: the next start is admitted at once, their time is trimmed and recorded', async () => {
  const fx = fixture()
  assert.equal(new Date(fx.clock.now()).toISOString().slice(0, 10), '2026-11-13')
  // Every place is taken by a call that was claimed and live when the edge restarted: the slots are in storage, this
  // object holds none of them. (Two of them: 90 s and 30.5 s old; the rest 10 s old.)
  const PLACES = VOICE_SESSION_LIMITS.liveConversations
  // The two older ones come last, so their rows are among the few the call history keeps.
  const ages = Array.from({ length: PLACES }, (_, index) => index === PLACES - 2 ? 90000 : index === PLACES - 1 ? 30500 : 10000)
  await fx.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-13', daySeconds: PLACES * 1200, month: '2026-11', monthSeconds: PLACES * 1200,
    slots: Object.fromEntries(ages.map((age, index) => [`slot-lost-${String(index).padStart(2, '0')}`, lostSlot(fx, `conv_lost_${index}`, age)])) })
  const response = await fx.ownerDoor()
  assert.equal(response.status, 200, 'not VOICE_BUSY: nothing was live')
  assert.deepEqual(await response.json(), { token: TOKEN, maxDurationSeconds: 1200 })
  const record = await admission(fx)
  assert.deepEqual(Object.keys(record.slots).filter(id => id.startsWith('slot-lost')), [])
  assert.equal(Object.keys(record.slots).length, 1)
  // Each lost call keeps only the whole seconds since its hello (90, 31, and 10 each); plus the new call's 1,200.
  const used = 90 + 31 + (PLACES - 2) * 10
  assert.deepEqual([record.daySeconds, record.monthSeconds], [used + 1200, used + 1200])
  const calls = (await fx.bridgeStorage.get(HISTORY_KEY)).calls
  assert.equal(calls.every(call => call.ended === 'error' && call.grantedSeconds === 1200), true)
  assert.deepEqual(calls.map(call => call.lastedSeconds).sort((a, b) => b - a).slice(0, 3), [90, 31, 10])
})

test('a start that is not refused touches nothing; slots still waiting for their mint or their tab are never let go early', async () => {
  // One lost claimed slot and room for one more: the start is admitted WITHOUT letting anything go (nothing was full).
  const roomy = fixture()
  await roomy.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-13', daySeconds: 1200, month: '2026-11', monthSeconds: 1200, slots: { 'slot-lost-a': lostSlot(roomy, 'conv_lost_a', 60000) } })
  assert.equal((await roomy.ownerDoor()).status, 200)
  assert.equal(Object.keys((await admission(roomy)).slots).includes('slot-lost-a'), true)
  // Every place taken by a start in flight (minted, no tab yet): the next is still VOICE_BUSY, and none is let go early.
  const waiting = fixture()
  for (let index = 0; index < VOICE_SESSION_LIMITS.liveConversations; index++) assert.equal((await waiting.ownerDoor()).status, 200)
  await refused(await waiting.ownerDoor(), 409, 'VOICE_BUSY')
  assert.equal(Object.keys((await admission(waiting)).slots).length, VOICE_SESSION_LIMITS.liveConversations)
})

test('calls this object really holds are never let go: with every place held a start is VOICE_BUSY, and no call is touched', async () => {
  const fx = fixture()
  const held = []
  for (let index = 0; index < VOICE_SESSION_LIMITS.liveConversations; index++) held.push(await fx.connect())
  const [first, second] = held
  const before = await admission(fx)
  assert.equal(Object.values(before.slots).filter(slot => Number.isSafeInteger(slot.helloAt)).length, VOICE_SESSION_LIMITS.liveConversations, 'every call was claimed by a tab')
  await refused(await fx.ownerDoor(), 409, 'VOICE_BUSY')
  assert.deepEqual(await admission(fx), before)
  for (const call of held) assert.equal(call.provider.closedCode ?? null, null)
  // One of the two is a lost call (the object forgot it, as a restart does): the next start is admitted, the live call stays.
  fx.bridge.convs.delete(first.conv)
  assert.equal((await fx.ownerDoor()).status, 200)
  const after = await admission(fx)
  assert.deepEqual(Object.values(after.slots).map(slot => slot.conv).filter(conv => conv === first.conv || conv === second.conv), [second.conv])
})
