/** VoiceBridge door 3 (the provider's brain socket) and door 2 (the owner's tab socket): the provider's JWT and the
 * bridge secret, the switch (off: both doors answer byte for byte what an unknown path answers), and a walk of every
 * other route with the provider's credentials (it gets nothing). Real Worker, real VoiceBridgeDO. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ELEVEN_SPEECH_ACTIONS } from '../eleven-speech.mjs'
import { verifySpeechEngineJwt } from '../voice-provider-speech-engine.mjs'
import { CUSTOM_LLM_ROUTES } from '../voice-provider-custom-llm.mjs'
import { ACCESS, AT, KEY, ORIGIN, SECRET, fixture, signJwt } from './voice-bridge-fakes.mjs'

/** Status, headers (minus date) and body: what "byte for byte" compares. */
const shape = async (response, path, control) => [response.status, [...response.headers].filter(([name]) => name !== 'date').sort(),
  (await response.text()).replaceAll(path, control)]

test('the provider door opens only with a valid JWT AND the bridge secret; every bad one is answered as an unknown path', async () => {
  const fx = fixture({ access: null })
  assert.equal((await fx.openProvider()).status, 101)
  assert.equal((await fx.openProvider({ jwt: `Bearer ${await signJwt()}` })).status, 101)
  // 60 s of skew either side is allowed.
  assert.equal((await fx.openProvider({ jwt: await signJwt({ exp: AT / 1000 - 59 }) })).status, 101)
  assert.equal((await fx.openProvider({ jwt: await signJwt({ iat: AT / 1000 + 59, nbf: AT / 1000 + 59 }) })).status, 101)
  const opened = fx.calls.bridge.length
  const control = await shape(await fx.send(new Request(`${ORIGIN}/door/voice-brainx`, { headers: { upgrade: 'websocket' } })), '/door/voice-brainx', '/door/voice-brainx')
  const bad = {
    'wrong key': await signJwt({}, { key: 'another-account-key' }),
    'expired': await signJwt({ exp: AT / 1000 - 61 }),
    'no exp': await signJwt({ exp: undefined }),
    'wrong issuer': await signJwt({ iss: 'https://api.elevenlabs.io/convai/other' }),
    'wrong subject': await signJwt({ sub: 'someone_else' }),
    'issued in the future': await signJwt({ iat: AT / 1000 + 61 }),
    'not yet valid': await signJwt({ nbf: AT / 1000 + 61 }),
    'alg none': await signJwt({}, { header: { alg: 'none', typ: 'JWT' } }),
    'alg HS512': await signJwt({}, { header: { alg: 'HS512', typ: 'JWT' } }),
    'tampered claims': (await signJwt()).replace(/\.[^.]+\./, `.${Buffer.from(JSON.stringify({ iss: 'x' })).toString('base64url')}.`),
    'garbage': 'not.a.jwt', 'empty': '', 'two parts': 'a.b',
  }
  for (const [name, jwt] of Object.entries(bad)) {
    const response = await fx.openProvider({ jwt, path: '/door/voice-brain' })
    assert.deepEqual(await shape(response, '/door/voice-brain', '/door/voice-brainx'), control, name)
  }
  for (const headers of [{ 'x-aukora-voice-bridge': 'wrong-secret-of-a-good-length-0123456789' }, { 'x-aukora-voice-bridge': null }, { 'x-aukora-voice-bridge': SECRET.slice(0, -1) }, { 'x-aukora-voice-bridge': SECRET + 'x' },
    { 'x-elevenlabs-speech-engine-authorization': null }, { upgrade: null }]) {
    assert.deepEqual(await shape(await fx.openProvider({ headers }), '/door/voice-brain', '/door/voice-brainx'), control, JSON.stringify(headers))
  }
  for (const extra of [{ method: 'POST' }, { path: '/door/voice-brain?x=1' }]) {
    const response = await fx.openProvider(extra)
    assert.notEqual(response.status, 101, JSON.stringify(extra))
  }
  // No refused request reached the provider upgrade; the only object calls are the refusal records (job 2 item 3),
  // one per stage per minute per isolate: jwt-bad, secret-bad, secret-missing. A request with no JWT records nothing.
  assert.deepEqual(fx.calls.bridge.slice(opened), Array(3).fill('/voice-bridge/admit'), 'only three throttled refusal records')
  assert.deepEqual(((await fx.bridgeStorage.get('voice-bridge:failures'))?.provider ?? []).map(item => item.stage).sort(), ['jwt-bad', 'secret-bad', 'secret-missing'])
  assert.equal(fx.calls.provider.length, 0)
  assert.equal(await verifySpeechEngineJwt(await signJwt(), '', AT), false)
  assert.equal(await verifySpeechEngineJwt(null, KEY, AT), false)
})

test('the switch off: the provider and tab doors answer byte for byte what an unknown path answers; the owner action as an unknown action', async () => {
  for (const access of [null, ACCESS]) {
    for (const value of ['0', undefined, 'true']) {
      const fx = fixture({ access, env: { VOICE_MANAGED: value } })
      const provider = await shape(await fx.openProvider(), '/door/voice-brain', '/door/voice-braim')
      const providerControl = await shape(await fx.openProvider({ path: '/door/voice-braim' }), '/door/voice-braim', '/door/voice-braim')
      assert.deepEqual(provider, providerControl, `provider ${String(value)} ${access ? 'owner' : 'signed out'}`)
      const tab = await shape(await fx.openTab(), '/_host/voice/bridge', '/_host/voice/bridgf')
      const tabControl = await shape(await fx.openTab({ path: '/_host/voice/bridgf' }), '/_host/voice/bridgf', '/_host/voice/bridgf')
      assert.deepEqual(tab, tabControl, `tab ${String(value)} ${access ? 'owner' : 'signed out'}`)
      assert.equal(fx.calls.bridge.length, 0)
      if (access) assert.deepEqual(await shape(await fx.ownerDoor(), 'x', 'x'), await shape(await fx.ownerDoor({ body: { action: 'no_such_action' } }), 'x', 'x'))
      assert.equal(fx.bridgeBuilt, false)
    }
  }
})

test('the tab door: owner with a passkey session, from her own page, as a WebSocket; nothing else reaches the object', async () => {
  for (const [options, extra, status] of [
    [{ access: { ...ACCESS, session: undefined } }, {}, 403], [{ access: { ...ACCESS, email: 'x@example.invalid' } }, {}, 403], [{ access: null }, {}, 401],
    [{}, { headers: { origin: 'https://foreign.invalid' } }, 403], [{}, { headers: { origin: null } }, 403], [{}, { headers: { upgrade: null } }, 426],
    [{}, { method: 'POST' }, 405], [{}, { path: '/_host/voice/bridge?conv=1' }, 404], [{ env: { ELEVENLABS_BRIDGE_SECRET: undefined } }, {}, 503],
  ]) {
    const fx = fixture(options)
    const response = await fx.openTab(extra)
    assert.equal(response.status, status, JSON.stringify([options, extra]))
    assert.equal(fx.calls.bridge.length, 0)
  }
  const fx = fixture()
  assert.equal((await fx.openTab()).status, 101)
})

test('the provider\'s credentials open nothing else: every /_host/voice action and every other door answers as to anyone signed out', async () => {
  const fx = fixture({ access: null })
  const credentials = { 'x-elevenlabs-speech-engine-authorization': await signJwt(), 'x-aukora-voice-bridge': SECRET }
  const signedOut = JSON.stringify({ ok: false, code: 'OWNER_ACCESS_REQUIRED' })
  const actions = [...ELEVEN_SPEECH_ACTIONS, 'speech_pass', 'managed_session', 'managed_status', 'validate_clause', 'compile_state_slot', 'dispatch_turn', 'barge_in', 'turn_abandon']
  const requests = [
    new Request(`${ORIGIN}/_host/voice`, { headers: credentials }),
    ...actions.map(action => new Request(`${ORIGIN}/_host/voice`, { method: 'POST', headers: { ...credentials, 'content-type': 'application/json' }, body: JSON.stringify({ action, turnId: 'eleven:conv_1:1', transcript: 'x' }) })),
    ...['/_host/voice/bridge', '/door/voice', '/_head/ws', '/door/voice-brain/x', ...CUSTOM_LLM_ROUTES].map(path => new Request(ORIGIN + path, { headers: { ...credentials, upgrade: 'websocket' } })),
    ...CUSTOM_LLM_ROUTES.map(path => new Request(ORIGIN + path, { method: 'POST', headers: { ...credentials, authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: '{"stream":true,"messages":[]}' })),
    new Request(`${ORIGIN}/_host/turn-journal`, { headers: credentials }),
    new Request(`${ORIGIN}/door/voice-brain`, { method: 'POST', headers: credentials, body: '{}' }),
  ]
  for (const request of requests) {
    const label = `${request.method} ${new URL(request.url).pathname}`
    const response = await fx.send(request)
    assert.equal(response.status, 401, label)
    assert.equal(await response.text(), signedOut, label)
  }
  assert.deepEqual([fx.calls.bridge.length, fx.calls.provider.length, fx.calls.journal.length], [0, 0, 0])
  // With the switch on and an owner signed in, the Custom LLM fallback is still not routed (the skeleton refuses by absence).
  const owner = fixture()
  for (const path of CUSTOM_LLM_ROUTES) {
    const response = await owner.send(new Request(ORIGIN + path, { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{"stream":true,"messages":[]}' }))
    assert.deepEqual([response.status, await response.json()], [404, { ok: false, code: 'PROVIDER_UNAVAILABLE' }], path)
  }
  assert.equal(owner.calls.bridge.length, 0)
})
