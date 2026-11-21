/** VOICE job 2: the owner door is tolerant of the saved-duration read, the managed voice can use its own key, every
 * refusal after admission records one closed stage (and the provider door's refusals too), and the owner can read
 * them through POST /_host/voice {"action":"managed_status"}. Real Worker, real VoiceBridgeDO, fake provider answers. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ADMISSION_KEY, FAILURES_KEY, INIT_WAIT_MS } from '../voice-bridge-do.mjs'
import { DURATION_READ_DEADLINE_MS, PROVIDER_NOTE_INTERVAL_MS, VOICE_BRIDGE_SETTINGS, VOICE_FAILURE_STAGES } from '../voice-bridge.mjs'
import { ACCESS, AT, KEY, ORIGIN, RESOURCE, SECRET, TOKEN, fixture, signJwt } from './voice-bridge-fakes.mjs'

const VOICE_KEY = 'synthetic-voice-account-key-owning-the-engine'
const LEAK = 'PROVIDER-SECRET-DETAIL'
const read1200 = () => Response.json({ conversation: { max_duration_seconds: 1200 } })
const goodMint = () => Response.json({ token: TOKEN, conversation_id: 'conv_1' })
const isMint = url => url.includes('/conversation/token')
const stored = async fx => (await fx.bridgeStorage.get(FAILURES_KEY)) ?? null
const ownerStages = async fx => ((await stored(fx))?.owner ?? []).map(item => item.stage)
const providerStages = async fx => ((await stored(fx))?.provider ?? []).map(item => item.stage)
const status = async (fx, extra = {}) => {
  const response = await fx.ownerDoor({ body: { action: 'managed_status' }, ...extra })
  return [response.status, await response.json()]
}

// ── Item 1 ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('item 1: any failure of the saved-duration read uses the reserved seconds, mints, and is recorded as duration-read', async () => {
  const reads = {
    'status 500': () => new Response(LEAK, { status: 500 }),
    'status 401': () => Response.json({ detail: LEAK }, { status: 401 }),
    'status 404': () => new Response(LEAK, { status: 404 }),
    'redirect': () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }),
    'not json': () => new Response(LEAK, { headers: { 'content-type': 'text/plain' } }),
    'too large': () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '70000' } }),
    'broken json': () => new Response('{"conversation":', { headers: { 'content-type': 'application/json' } }),
    'throws': () => { throw new Error(LEAK) },
    'no field': () => Response.json({ name: 'x61', conversation_config: {} }),
    'longer than allowed': () => Response.json({ conversation: { max_duration_seconds: 7200 } }),
    'shorter than allowed': () => Response.json({ conversation: { max_duration_seconds: 59 } }),
    'a string': () => Response.json({ conversation: { max_duration_seconds: '600' } }),
  }
  for (const [name, read] of Object.entries(reads)) {
    const fx = fixture({ providerFetch: (url, init) => (isMint(url) ? goodMint() : read(url, init)) })
    const response = await fx.ownerDoor()
    assert.equal(response.status, 200, name)
    assert.deepEqual(await response.json(), { token: TOKEN, maxDurationSeconds: 1200 }, name)
    assert.equal(fx.calls.provider.filter(call => isMint(call.url)).length, 1, name)
    assert.deepEqual(await ownerStages(fx), ['duration-read'], name)
    const record = await fx.bridgeStorage.get(ADMISSION_KEY)
    assert.deepEqual([record.daySeconds, Object.values(record.slots)[0].seconds, Object.values(record.slots)[0].conv], [1200, 1200, 'conv_1'], name)
    assert.equal(JSON.stringify([...fx.bridgeStorage.data]).includes(LEAK), false, name)
  }
  // A good read records nothing.
  const good = fixture()
  assert.equal((await good.ownerDoor()).status, 200)
  assert.equal(await stored(good), null)
})

test('item 1: a read that never answers is given 3 s of the 12 s; the mint still gets its own time and succeeds', async () => {
  assert.equal(DURATION_READ_DEADLINE_MS, 3000)
  let mintSignal = null
  const fx = fixture({ providerFetch: (url, init) => {
    if (isMint(url)) { mintSignal = init.signal; return goodMint() }
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  } })
  const started = Date.now()
  const response = await fx.ownerDoor()
  const took = Date.now() - started
  assert.deepEqual([response.status, await response.json()], [200, { token: TOKEN, maxDurationSeconds: 1200 }])
  assert.ok(took >= 2900 && took < 6000, `the read was cut at 3 s (${String(took)} ms)`)
  assert.equal(mintSignal.aborted, false)
  assert.deepEqual(await ownerStages(fx), ['duration-read'])
})

// ── Item 2 ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('item 2: ELEVENLABS_VOICE_API_KEY, when set, is the key of BOTH provider calls and of the provider JWT check', async () => {
  assert.deepEqual(VOICE_BRIDGE_SETTINGS, ['VOICE_MANAGED', 'ELEVENLABS_VOICE_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_X61_VOICE_RESOURCE_ID', 'ELEVENLABS_BRIDGE_SECRET'])
  const fx = fixture({ env: { ELEVENLABS_VOICE_API_KEY: VOICE_KEY } })
  const response = await fx.ownerDoor()
  assert.equal(response.status, 200)
  assert.equal((await response.text()).includes(VOICE_KEY), false)
  assert.equal(fx.calls.provider.length, 2)
  for (const { init } of fx.calls.provider) assert.deepEqual([...new Headers(init.headers)], [['xi-api-key', VOICE_KEY]])
  assert.equal((await fx.openProvider({ jwt: await signJwt({}, { key: VOICE_KEY }) })).status, 101)
  assert.notEqual((await fx.openProvider({ jwt: await signJwt({}, { key: KEY }) })).status, 101)
  assert.deepEqual(await providerStages(fx), ['jwt-bad'])
  // A token holding the voice key is refused like one holding the old key.
  const holding = fixture({ env: { ELEVENLABS_VOICE_API_KEY: VOICE_KEY }, providerFetch: url => (isMint(url) ? Response.json({ token: `${'x'.repeat(40)}${VOICE_KEY}`, conversation_id: 'conv_1' }) : read1200()) })
  assert.equal((await holding.ownerDoor()).status, 503)
  assert.deepEqual(await ownerStages(holding), ['mint-shape'])
  // Unset or blank: the existing key, for both calls and the JWT.
  for (const value of [undefined, '', '   ']) {
    const old = fixture({ env: { ELEVENLABS_VOICE_API_KEY: value } })
    assert.equal((await old.ownerDoor()).status, 200, JSON.stringify(value))
    for (const { init } of old.calls.provider) assert.deepEqual([...new Headers(init.headers)], [['xi-api-key', KEY]])
    assert.equal((await old.openProvider()).status, 101)
  }
  // Only the voice key set is enough for the managed voice.
  const only = fixture({ env: { ELEVENLABS_VOICE_API_KEY: VOICE_KEY, ELEVENLABS_API_KEY: undefined } })
  assert.equal((await only.ownerDoor()).status, 200)
  // Today's text-to-speech is not touched: it never reads the new name.
  assert.equal(readFileSync(new URL('../eleven-speech.mjs', import.meta.url), 'utf8').includes('ELEVENLABS_VOICE_API_KEY'), false)
})

// ── Item 3, the owner door ─────────────────────────────────────────────────────────────────────────────────────────
test('item 3: every refusal after admission records exactly one closed stage, with no provider text, header or id', async () => {
  const mint = {
    'mint-401': () => Response.json({ detail: LEAK }, { status: 401 }),
    'mint-403': () => new Response(LEAK, { status: 403 }),
    'mint-404': () => new Response(LEAK, { status: 404 }),
    'mint-429': () => new Response(LEAK, { status: 429 }),
    'mint-5xx': () => new Response(LEAK, { status: 502 }),
    'mint-other': () => new Response(LEAK, { status: 402 }),
    'mint-other ': () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }),
    'mint-other  ': () => { throw new Error(LEAK) },
    'mint-shape': () => new Response(LEAK, { headers: { 'content-type': 'text/plain' } }),
    'mint-shape ': () => Response.json({ conversation_id: 'conv_1' }),
    'mint-shape  ': () => Response.json({ token: 'x'.repeat(39), conversation_id: 'conv_1' }),
    'mint-shape   ': () => Response.json({ token: TOKEN, conversation_id: 'conv/../1' }),
    'mint-shape    ': () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '70000' } }),
  }
  for (const [label, answer] of Object.entries(mint)) {
    const fx = fixture({ providerFetch: url => (isMint(url) ? answer() : read1200()) })
    const response = await fx.ownerDoor()
    const text = await response.text()
    assert.deepEqual([response.status, JSON.parse(text)], [503, { ok: false, code: 'VOICE_PROVIDER_UNAVAILABLE' }], label)
    assert.deepEqual(await ownerStages(fx), [label.trim()], label)
    const kept = JSON.stringify(await stored(fx))
    for (const secret of [LEAK, KEY, SECRET, RESOURCE, 'conv_1', TOKEN]) assert.equal(kept.includes(secret) || text.includes(secret), false, `${label} ${secret}`)
    assert.deepEqual((await stored(fx)).lastFailure, { door: 'owner', stage: label.trim(), atMs: AT })
    // The provider answered with a status or a redirect: no conversation can exist, the seconds come back (review MUST).
    // A network failure (the third mint-other) or a mint-shape keeps them.
    const answered = /^mint-(?:401|403|404|429|5xx)$/.test(label) || label === 'mint-other' || label === 'mint-other '
    const record = await fx.bridgeStorage.get(ADMISSION_KEY)
    assert.deepEqual([record.daySeconds, record.monthSeconds, Object.keys(record.slots).length], [answered ? 0 : 1200, answered ? 0 : 1200, 0], label)
  }
  // A failed bind (the object refused the slot): `bind`.
  const bind = fixture({ bridgeFault: async request => ((await request.json()).action === 'bind' ? Response.json({ ok: false, code: 'VOICE_ADMIT_INVALID' }) : undefined) })
  assert.equal((await bind.ownerDoor()).status, 503)
  assert.deepEqual(await ownerStages(bind), ['bind'])
  // Both a failed read and a failed mint: both recorded, in order.
  const both = fixture({ providerFetch: () => new Response(LEAK, { status: 401 }) })
  assert.equal((await both.ownerDoor()).status, 503)
  assert.deepEqual(await ownerStages(both), ['duration-read', 'mint-401'])
  // Refusals before admission record nothing.
  const quota = fixture()
  await quota.bridgeStorage.put(ADMISSION_KEY, { day: '2026-11-13', daySeconds: 5356800, month: '2026-11', monthSeconds: 5356800, slots: {} })
  assert.equal((await quota.ownerDoor()).status, 429)
  assert.equal(await stored(quota), null)
})

test('item 3: a mint that never answers is mint-timeout at the 12 s deadline', async () => {
  const fx = fixture({ providerFetch: (url, init) => (isMint(url) ? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) : read1200()) })
  const started = Date.now()
  assert.equal((await fx.ownerDoor()).status, 503)
  assert.ok(Date.now() - started >= 11000)
  assert.deepEqual(await ownerStages(fx), ['mint-timeout'])
  // No answer came back: whether a conversation exists is unknown, so the seconds stay reserved.
  assert.deepEqual([(await fx.bridgeStorage.get(ADMISSION_KEY)).daySeconds, Object.keys((await fx.bridgeStorage.get(ADMISSION_KEY)).slots).length], [1200, 0])
})

// ── Item 3, the provider door ──────────────────────────────────────────────────────────────────────────────────────
test('item 3: the provider door records jwt-bad, secret-missing, secret-bad, init-unbound and init-timeout (no JWT: nothing)', async () => {
  const fx = fixture({ access: null })
  const control = await fx.send(new Request(`${ORIGIN}/door/voice-brainx`, { headers: { upgrade: 'websocket' } }))
  const unknown = [control.status, await control.text()]
  for (const [stage, extra] of [
    [null, { headers: { 'x-elevenlabs-speech-engine-authorization': null } }],
    ['jwt-bad', { jwt: await signJwt({}, { key: 'another-account-key' }) }],
    ['secret-missing', { headers: { 'x-aukora-voice-bridge': null } }],
    ['secret-bad', { headers: { 'x-aukora-voice-bridge': 'wrong-secret-of-a-good-length-0123456789' } }],
  ]) {
    const response = await fx.openProvider(extra)
    assert.deepEqual([response.status, (await response.text()).replaceAll('/door/voice-brain', '/door/voice-brainx')], unknown, String(stage))
    assert.equal((await providerStages(fx)).at(-1), stage ?? undefined, String(stage))
  }
  assert.equal(fx.calls.bridge.some(path => path === '/voice-bridge/provider'), false, 'no refused request reached the provider upgrade')
  // A JWT and a secret both wrong: one stage, the JWT's.
  const one = fixture({ access: null })
  await one.openProvider({ jwt: 'not.a.jwt', headers: { 'x-aukora-voice-bridge': 'x' } })
  assert.deepEqual(await providerStages(one), ['jwt-bad'])
  // Accepted sockets: an init for a conversation nobody minted, and a socket that never says init.
  const owner = fixture()
  const unbound = (await owner.openProvider()).webSocket
  unbound.json({ type: 'init', conversation_id: 'conv_nobody' })
  await owner.settle()
  assert.equal(unbound.closedCode, 1008)
  const silent = (await owner.openProvider()).webSocket
  owner.clock.advance(INIT_WAIT_MS)
  await owner.settle()
  assert.equal(silent.closedCode, 1008)
  assert.deepEqual(await providerStages(owner), ['init-unbound', 'init-timeout'])
  for (const stage of [...VOICE_FAILURE_STAGES.owner, ...VOICE_FAILURE_STAGES.provider]) assert.match(stage, /^[a-z0-9-]+$/)
})

test('review SHOULD: the provider-door throttle is per isolate, not per env object; a request with no JWT is never recorded', async () => {
  const fx = fixture({ access: null })
  // Fifty strangers, each request with its own env object (as if the runtime handed out a fresh one each time): one write.
  for (let index = 0; index < 50; index++) {
    const request = new Request(`${ORIGIN}/door/voice-brain`, { headers: { upgrade: 'websocket', 'x-elevenlabs-speech-engine-authorization': `bad.${String(index)}.jwt`, 'x-aukora-voice-bridge': SECRET } })
    await fx.worker.fetch(request, { ...fx.env })
  }
  assert.equal(fx.calls.bridge.length, 1, 'one record per stage per minute per isolate, whatever the env object')
  // No JWT at all needs nothing from the caller: answered as an unknown path, and no object call, no record.
  const bare = fixture({ access: null })
  for (let index = 0; index < 5; index++) await bare.openProvider({ headers: { 'x-elevenlabs-speech-engine-authorization': null } })
  assert.equal(bare.calls.bridge.length, 0)
  assert.equal(await stored(bare), null)
  assert.equal(VOICE_FAILURE_STAGES.provider.includes('jwt-missing'), false)
})

test('item 3: a stranger cannot make the provider door a stream of writes, nor push out the owner door\'s record', async () => {
  const fx = fixture({ access: null })
  for (let index = 0; index < 50; index++) await fx.openProvider({ jwt: `bad.${String(index)}.jwt` })
  assert.equal(fx.calls.bridge.length, 1, 'one record per stage per minute')
  fx.clock.advance(PROVIDER_NOTE_INTERVAL_MS)
  await fx.openProvider({ jwt: 'bad.again.jwt' })
  assert.equal(fx.calls.bridge.length, 2)
  // A repeat of the newest stage only moves its time.
  assert.deepEqual((await stored(fx)).provider, [{ stage: 'jwt-bad', atMs: AT + PROVIDER_NOTE_INTERVAL_MS }])
  // Twelve alternating provider stages over time keep the last 8 of that door; the owner door's entry stays.
  const mixed = fixture({ providerFetch: url => (isMint(url) ? new Response('', { status: 401 }) : read1200()) })
  assert.equal((await mixed.ownerDoor()).status, 503)
  for (let index = 0; index < 12; index++) {
    mixed.clock.advance(PROVIDER_NOTE_INTERVAL_MS)
    await mixed.openProvider(index % 2 ? { jwt: 'bad.x.jwt' } : { headers: { 'x-aukora-voice-bridge': null } })
  }
  assert.equal((await providerStages(mixed)).length, 8)
  assert.deepEqual(await ownerStages(mixed), ['mint-401'])
})

// ── Item 5 ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('item 5: the conversation id is read as conversation_id or conversationId; a token without one is mint-shape', async () => {
  const camel = fixture({ providerFetch: url => (isMint(url) ? Response.json({ token: TOKEN, conversationId: 'conv_1' }) : read1200()) })
  assert.deepEqual(await (await camel.ownerDoor()).json(), { token: TOKEN, maxDurationSeconds: 1200 })
  assert.equal(Object.values((await camel.bridgeStorage.get(ADMISSION_KEY)).slots)[0].conv, 'conv_1')
  const none = fixture({ providerFetch: url => (isMint(url) ? Response.json({ token: TOKEN }) : read1200()) })
  assert.deepEqual(await (await none.ownerDoor()).json(), { ok: false, code: 'VOICE_PROVIDER_UNAVAILABLE' })
  assert.deepEqual(await ownerStages(none), ['mint-shape'])
  const record = await none.bridgeStorage.get(ADMISSION_KEY)
  assert.deepEqual([record.daySeconds, Object.keys(record.slots).length], [1200, 0], 'the mint was called: kept, slot let go')
})

// ── The status read ──────────────────────────────────────────────────────────────────────────────────────────────
test('managed_status: names, the key in use, the resource kind, live conversations and the stages; never a value', async () => {
  const fx = fixture({ providerFetch: () => new Response(LEAK, { status: 401 }) })
  assert.equal((await fx.ownerDoor()).status, 503)
  const [code, body] = await status(fx)
  assert.equal(code, 200)
  assert.deepEqual(body, {
    switch: 'on',
    names: { VOICE_MANAGED: 'set', ELEVENLABS_VOICE_API_KEY: 'missing', ELEVENLABS_API_KEY: 'set', ELEVENLABS_X61_VOICE_RESOURCE_ID: 'set', ELEVENLABS_BRIDGE_SECRET: 'set' },
    keyInUse: 'ELEVENLABS_API_KEY',
    resourceKind: 'speech-engine',
    live: 0,
    failures: [{ door: 'owner', stage: 'mint-401', atMs: AT }, { door: 'owner', stage: 'duration-read', atMs: AT }],
    calls: [],
    turns: [],
    secondsLeft: { today: 5356800, month: 5356800 },
    // The bridge's counts by name, and the last call's stream key names.
    // Four memory counts and the memory object.
    counts: { backchannelsKept: 0, wordsMerged: 0, stops: 0, presenceCues: 0, handoffsKept: 0, handoffEchoes: 0, fastFallbacks: 0, toolTimeouts: 0, awareFrames: 0, awareStoredLoads: 0, blocksTrimmed: 0, nothingNew: 0, grownTurns: 0, agentTailEvents: 0, resumes: 0, resumesByHistory: 0, resumeLimit: 0,
      memoryRecords: 0, memoryAcks: 0, memoryNacks: 0, memoryAdoptedFromHome: 0, memoryOtherOwner: 0,
      // CHANGED 2026-11-18 (additive): the brain door's and the tab door's counts, and starts nobody claimed.
      brainSockets: 0, brainInits: 0, brainFramesOther: 0, brainFramesRefused: 0, tabSockets: 0, tabHellos: 0, tabHellosRefused: 0, startsUnclaimed: 0 },
    streamKeys: {},
    memory: { seq: 0, digest12: '000000000000', synced: 0, unsynced: 0, gapFrom: null, adoptedFromHome: false, fork: false },
    // The provider's saved voice settings; this session's read failed, so none was read.
    provider: { readAtMs: null, speakingModel: 'not read', voice: 'not read', expressiveMode: 'not read', stability: 'not read', speed: 'not read', listeningModel: 'not read',
      listeningQuality: 'not read', turnEagerness: 'not read', silenceEndCallSeconds: 'not read', eventWaitSeconds: 'not read',
      // CHANGED 2026-11-18 (additive): more closed facts of the same read.
      brainUrl: 'not read', brainHeader: 'not read', overrideFirstMessage: 'not read', authEnabled: 'not read', dailyLimit: 'not read', concurrencyLimit: 'not read',
      maxDurationSeconds: 'not read', turnTimeoutSeconds: 'not read', initialWaitSeconds: 'not read', updatedAtSeconds: 'not read', updatedFrom: 'not read',
      waitMatches: 'not read' },
    // CHANGED 2026-11-18 (additive, the provider side): what the provider says about its own side, read at the status. This
    // fixture's provider answers 401 to everything, so both reads carry that closed word and nothing else.
    providerSide: { readAtMs: AT, account: { read: 'status-401' }, conversations: { read: 'status-401', rows: [] } },
    // Her fast voice's line (no fast key in this fixture): the provider NAME, the model id and the reason.
    fast: { on: false, provider: 'deepseek', model: 'deepseek-chat', why: 'provider-not-configured' },
  })
  const text = JSON.stringify(body)
  for (const secret of [KEY, SECRET, RESOURCE, LEAK, ACCESS.email]) assert.equal(text.includes(secret), false, secret)
  // A live conversation is counted; the voice key, an agent resource and a missing secret are named.
  const live = fixture()
  await live.connect()
  assert.equal((await status(live))[1].live, 1)
  const other = fixture({ env: { ELEVENLABS_VOICE_API_KEY: VOICE_KEY, ELEVENLABS_X61_VOICE_RESOURCE_ID: 'agent_x61test', ELEVENLABS_BRIDGE_SECRET: undefined } })
  const [, named] = await status(other)
  assert.deepEqual([named.keyInUse, named.resourceKind, named.names.ELEVENLABS_VOICE_API_KEY, named.names.ELEVENLABS_BRIDGE_SECRET], ['ELEVENLABS_VOICE_API_KEY', 'agent', 'set', 'missing'])
  const bad = fixture({ env: { ELEVENLABS_X61_VOICE_RESOURCE_ID: 'voice_x', ELEVENLABS_API_KEY: undefined } })
  const [, none] = await status(bad)
  assert.deepEqual([none.keyInUse, none.resourceKind, none.names.ELEVENLABS_X61_VOICE_RESOURCE_ID], [null, null, 'set'])
})

test('managed_status with the switch off still answers, and never builds the bridge object; managed_session stays unknown', async () => {
  for (const value of ['0', undefined]) {
    const fx = fixture({ env: { VOICE_MANAGED: value } })
    const [code, body] = await status(fx)
    assert.deepEqual([code, body.switch, body.names.VOICE_MANAGED, body.live, body.failures], [200, 'off', value === undefined ? 'missing' : 'set', 0, []])
    assert.equal(fx.bridgeBuilt, false)
    const managed = await fx.ownerDoor()
    assert.deepEqual([managed.status, await managed.json()], [400, { ok: false, code: 'VOICE_ACTION_INVALID' }])
  }
})

test('managed_status: the same owner and same-origin checks as the owner door, and exactly one key in the body', async () => {
  for (const access of [{ ...ACCESS, session: undefined }, { ...ACCESS, email: 'other@example.invalid' }, { ...ACCESS, expires: AT / 1000 }]) {
    const fx = fixture({ access })
    assert.deepEqual(await status(fx), [403, { ok: false, code: 'OWNER_ACCESS_REQUIRED' }])
    assert.equal(fx.calls.bridge.length, 0)
  }
  assert.deepEqual(await status(fixture({ access: null })), [401, { ok: false, code: 'OWNER_ACCESS_REQUIRED' }])
  for (const headers of [{ 'sec-fetch-site': 'same-site' }, { origin: 'https://foreign.invalid' }]) {
    const fx = fixture()
    assert.equal((await status(fx, { headers }))[0], 403)
    assert.equal(fx.calls.bridge.length, 0)
  }
  const extra = fixture()
  assert.deepEqual(await status(extra, { body: { action: 'managed_status', verbose: true } }), [400, { ok: false, code: 'VOICE_ACTION_INVALID' }])
  // The object unreachable: said as unknown (null), never as zero.
  const down = fixture({ bridgeFault: () => { throw new Error('object down') } })
  const [, body] = await status(down)
  assert.deepEqual([body.live, body.failures], [null, null])
})
