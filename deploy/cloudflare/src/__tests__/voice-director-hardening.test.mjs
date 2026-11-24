/** Voice text filtering, UTF-8 isolation, and unsupported renderer refusal. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRendererAuthHeaders, compileVoiceStateSlot, handleEdgeVoiceRequest, projectVoiceStatus, validateSpeakableClause } from '../voice-director.mjs'

const origin = 'https://voice.example.invalid'
function invoke(request, env = {}, extra = {}) {
  return handleEdgeVoiceRequest({ request, url: new URL(request.url), env, seedId: 'a'.repeat(64), ...extra })
}
function post(body) {
  return new Request(`${origin}/_host/voice`, { method: 'POST', body, ...(typeof body === 'string' ? {} : { duplex: 'half' }) })
}

test('refuses embedded secret, hash, stack, code, and JSON payloads', () => {
  for (const payload of [
    `sk-ant-${'a'.repeat(16)}`, `sk-${'a'.repeat(16)}`, `ghp_${'a'.repeat(20)}`,
    `github_pat_${'a'.repeat(20)}`, ...'baprs'.split('').map(kind => `xox${kind}-123-abc`),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature', 'eyJhbGciOiJIUzI1NiJ9',
    '-----BEGIN PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----',
    'a'.repeat(40), 'B'.repeat(64),
    'Error: unavailable\n    at run (/srv/worker.mjs:40:2)',
    'Traceback (most recent call last):', 'File "worker.py", line 12',
    '`const answer = 42`', '`{a}`', '{"token":"value"}', '[{"a":1}]',
    '[1,2]', '[true,false]', '["one","two"]', '{}', '[]',
  ]) {
    assert.throws(() => validateSpeakableClause({ turnId: 't1', text: `Result: ${payload} ends here.` }),
      { code: 'VOICE_CLAUSE_RAW_PAYLOAD_REFUSED' }, payload)
  }
  assert.equal(validateSpeakableClause({ turnId: 't1', text: 'The result is ready. Use `help` for details.' }).mode, 'forced_text_stream')
})

test('refuses unbalanced braces, tool arguments, and raw or unmatched backtick spans', async () => {
  for (const payload of [
    '{incomplete', 'incomplete}', '{ready}', 'path=docs/guide.md', '_arg2=aa',
    'target=https://renderer.example.invalid/audio', 'turn_id=turn-1',
    '`' + 'q'.repeat(41) + '`', '`first; second`', '`call()`', '`(value`', '`value)`', '`x=y`',
    '`unclosed', 'unopened`', '`help` and `unfinished',
  ]) {
    const clause = { turnId: 't1', text: `Result: ${payload} ends here.` }
    assert.throws(() => validateSpeakableClause(clause), { code: 'VOICE_CLAUSE_RAW_PAYLOAD_REFUSED', status: 400 }, payload)
    await assert.rejects(invoke(post(JSON.stringify({ action: 'validate_clause', clause }))),
      { code: 'VOICE_CLAUSE_RAW_PAYLOAD_REFUSED', status: 400 }, payload)
  }
  for (const text of [
    'The result is ready. Use `help` or `status` for details.',
    'The label is `' + 'q'.repeat(40) + '`.',
    'One letter is x=a and a spaced equation is x = aa.',
    'The answer (after review) is ready; no further work is needed.',
  ]) assert.equal(validateSpeakableClause({ turnId: 't1', text }).text, text)
})

test('renderer authentication includes the optional Access pair only when both strings are nonempty', () => {
  const token = 'synthetic-renderer-token'
  const clientId = 'synthetic-access-id'
  const clientSecret = 'synthetic-access-secret'
  assert.deepEqual(buildRendererAuthHeaders(), {})
  assert.deepEqual(buildRendererAuthHeaders({ PERSONAPLEX_AUTH_TOKEN: ' \t ' }), {})
  assert.deepEqual(buildRendererAuthHeaders({ PERSONAPLEX_AUTH_TOKEN: token }), { authorization: `Bearer ${token}` })
  const pair = { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret }
  assert.deepEqual(buildRendererAuthHeaders({ CF_ACCESS_CLIENT_ID: clientId, CF_ACCESS_CLIENT_SECRET: clientSecret }), pair)
  assert.deepEqual(buildRendererAuthHeaders({
    PERSONAPLEX_AUTH_TOKEN: ` ${token} `, CF_ACCESS_CLIENT_ID: ` ${clientId} `, CF_ACCESS_CLIENT_SECRET: ` ${clientSecret} `,
  }), { authorization: `Bearer ${token}`, ...pair })
  for (const missing of [undefined, null, '', ' \t ', 0, false]) {
    for (const credentials of [
      { CF_ACCESS_CLIENT_ID: missing, CF_ACCESS_CLIENT_SECRET: clientSecret },
      { CF_ACCESS_CLIENT_ID: clientId, CF_ACCESS_CLIENT_SECRET: missing },
    ]) assert.deepEqual(buildRendererAuthHeaders({ PERSONAPLEX_AUTH_TOKEN: token, ...credentials }), { authorization: `Bearer ${token}` })
  }
})

test('renderer hostname pin applies to status and the fail-closed voice door', async () => {
  const host = 'renderer.example.invalid'
  for (const [raw, pin, configured] of [
    [`wss://${host}/audio`, undefined, true],
    [`wss://${host}/audio`, '', true],
    [`wss://${host}/audio`, host, true],
    [`wss://${host.toUpperCase()}:8443/audio`, ` ${host.toUpperCase()} `, true],
    [`wss://${host}.other.invalid/audio`, host, false],
    [`wss://sub.${host}/audio`, host, false],
    [`wss://other.invalid/audio`, host, false],
    [`wss://${host}@other.invalid/audio`, host, false],
    [`wss://user:password@${host}/audio`, host, false],
    [`ws://${host}/audio`, host, false],
    [`https://${host}/audio`, host, false],
    ['not a URL', host, false],
    [`wss://${host}/audio`, `wss://${host}`, false],
    [`wss://${host}/audio`, `${host}:443`, false],
    [`wss://${host}/audio`, ' ', false],
    [`wss://${host}/audio`, null, false],
  ]) {
    const env = {
      PERSONAPLEX_WS_URL: raw, PERSONAPLEX_ALLOWED_HOST: pin,
      PERSONAPLEX_AUTH_TOKEN: 'synthetic-renderer-token',
      CF_ACCESS_CLIENT_ID: 'synthetic-access-id', CF_ACCESS_CLIENT_SECRET: 'synthetic-access-secret',
    }
    const status = projectVoiceStatus(env)
    assert.equal(status.configured, configured, `${raw} pinned to ${String(pin)}`)
    assert.equal(status.bridgeAvailable, false)
    const response = await invoke(new Request(`${origin}/door/voice`, { headers: { upgrade: 'websocket' } }), env)
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.code, configured ? 'VOICE_RENDERER_PROTOCOL_UNSUPPORTED' : 'VOICE_RENDERER_UNCONFIGURED')
    for (const value of ['synthetic-renderer-token', 'synthetic-access-id', 'synthetic-access-secret']) {
      assert.equal(JSON.stringify(status).includes(value), false)
      assert.equal(JSON.stringify(body).includes(value), false)
    }
  }
})

test('bounds multibyte state slots at complete UTF-8 code points', () => {
  for (const character of ['é', '界', '😀', 'a😀']) {
    for (let offset = 0; offset < 4; offset++) {
      const slot = compileVoiceStateSlot({ topic: 'x'.repeat(offset) + character.repeat(400), activeWish: character.repeat(300), openThreads: Array(6).fill(character.repeat(140)) })
      assert.ok(slot.byteLength <= 1200)
      assert.equal(slot.byteLength, new TextEncoder().encode(slot.slotText).byteLength)
      assert.ok(!slot.slotText.includes('\ufffd'))
      assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(slot.slotText)), slot.slotText)
    }
  }
})

test('concurrent chunked requests cannot share a streaming UTF-8 decoder', async () => {
  let firstController
  const first = new ReadableStream({ start(controller) { firstController = controller } })
  const pending = invoke(post(first))
  const prefix = new TextEncoder().encode('{"action":"compile_state_slot","state":{"topic":"')
  firstController.enqueue(prefix)
  firstController.enqueue(new Uint8Array([0xe2]))
  // Flush the first decoder's partial code point before the independent request runs.
  await new Promise(resolve => setImmediate(resolve))
  const other = await invoke(post(JSON.stringify({ action: 'compile_state_slot', state: { topic: 'independent' } })))
  assert.equal((await other.json()).slot.slotText.includes('independent'), true)
  firstController.enqueue(new Uint8Array([0x82, 0xac]))
  firstController.enqueue(new TextEncoder().encode('"}}'))
  firstController.close()
  assert.equal((await (await pending).json()).slot.slotText.includes('€'), true)
})

test('malformed UTF-8 cannot poison the next request', async () => {
  await assert.rejects(invoke(post(new Uint8Array([0xe2]))), { code: 'VOICE_JSON_INVALID', status: 400 })
  assert.equal((await invoke(post('{"action":"validate_clause"}'))).status, 200)
})

test('configured raw WebSocket renderer remains unavailable even with spoofed session flags', async () => {
  let fetched = false
  const env = { PERSONAPLEX_WS_URL: 'wss://renderer.example.invalid/audio' }
  for (const suffix of ['', '?turnId=known-turn', '?turnId=cancelled-turn&voice=NATF1']) {
    const response = await invoke(new Request(`${origin}/door/voice${suffix}`, {
      headers: { upgrade: 'websocket', 'x-aukora-voice-authority': 'owner', 'x-voice-session-ticket': 'spoof' },
    }), env, { networkFetch: async () => { fetched = true; throw new Error('must not fetch') } })
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, 'VOICE_RENDERER_PROTOCOL_UNSUPPORTED')
  }
  assert.equal(fetched, false)
  assert.equal(projectVoiceStatus(env).bridgeAvailable, false)
  assert.equal(projectVoiceStatus(env).rendererEnforcement, 'unavailable')
})

test('barge_in and turn_abandon await the durable cancellation result', async () => {
  for (const action of ['barge_in', 'turn_abandon']) {
    let complete, payload
    const env = { HEAD: { idFromName: () => 'head', get: () => ({ fetch: async request => {
      payload = await request.json()
      await new Promise(resolve => { complete = resolve })
      return Response.json({ ok: true, activeTurnCancelled: true })
    } }) } }
    let settled = false
    const pending = invoke(post(JSON.stringify({ action, turnId: 'voice-1' })), env).then(value => { settled = true; return value })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    assert.deepEqual(payload, { action: 'cancel', turnId: 'voice-1', reason: action })
    complete()
    const body = await (await pending).json()
    assert.equal(body.action, action)
    assert.equal(body.cancelled, true)
    assert.equal(body.idleDirective.allowSubstantiveGeneration, false)
  }
})

test('field caps retain complete emoji after an odd ASCII prefix without replacement characters', () => {
  for (const [field, limit, label] of [['topic', 320, 'topic'], ['activeWish', 240, 'active_wish'], ['openThreads', 120, 'open_threads']]) {
    const expected = 'a'.repeat(limit - 1) + '😀'
    const input = expected + 'excluded'
    const state = { [field]: field === 'openThreads' ? [input] : input }
    const slot = compileVoiceStateSlot(state)
    assert.ok(slot.slotText.includes(`${label}: ${expected}`), field)
    assert.ok(!slot.slotText.includes('excluded'), field)
    assert.ok(!slot.slotText.includes('\ufffd'), field)
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(slot.slotText)), slot.slotText, field)
    assert.ok(slot.byteLength <= 1200)
  }
})
