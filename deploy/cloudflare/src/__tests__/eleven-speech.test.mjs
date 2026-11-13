/** Her ElevenLabs voice at the edge: owner-only single-use speech passes, the day's ledger in HEAD, reserve-then-settle.
 * HEAD is faked the way speech-pass.test.mjs fakes it, except that `/_head/eleven-speech` is answered by the REAL ledger
 * route over a fake transactional storage, so the Worker, the director hook and the ledger are tested together. One test
 * goes through the real `X61HeadDurableObject.fetch`, so taking the head-do.mjs hook away fails it. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createWorker } from '../worker.mjs'
import { handleEdgeVoiceRequest } from '../voice-director.mjs'
import { X61HeadDurableObject } from '../head-do.mjs'
import { handleElevenSpeechHeadRoute, herVoiceField, ELEVEN_TOKEN_URL, ELEVEN_SPEECH_HEAD_ROUTE, ELEVEN_OPEN_RESERVATIONS_MAX } from '../eleven-speech.mjs'

const ORIGIN = 'https://speech.example.invalid'
const SEED = 'a'.repeat(64)
const AT = Date.UTC(2026, 10, 13, 12, 0, 0)
const DAY = '2026-11-13'
const YESTERDAY = '2026-11-12'
const KEY = 'synthetic-elevenlabs-account-key'
const VOICE = 'VoiceId_12345'
const ACCESS = Object.freeze({ type: 'owner', email: 'owner@example.invalid', expires: AT / 1000 + 5 * 86400 })
const PASS = 'sutkn_synthetic_single_use'
const LIMITS = Object.freeze({ maxChars: 100000, maxCost: 4, pricePer1k: 0.04, slice: 5000 })
const grant = () => Response.json({ token: PASS })
const dayKey = day => `head:eleven-speech:v1:day:${day}`
const record = (fields = {}) => ({ chars: 0, mints: 0, turns: 0, firstAudio: { count: 0, sumMs: 0, maxMs: 0 },
  errors: { mint: 0, open: 0, first_audio: 0, closed: 0, ceiling: 0, unconfirmed: 0 }, open: {}, ...fields })
const NO_FA = Object.freeze({ count: 0, sumMs: 0, maxMs: 0 })
const usageBody = (fields = {}) => ({ action: 'speech_usage', reservation: null, seq: 1, chars: 0, turns: 0, firstAudio: { ...NO_FA }, errors: {}, final: false, ...fields })
/** The edge's ceiling refusal at AT (noon UTC): its own day, and the seconds until that day ends by its clock. */
const ceilingBody = (setting, day = DAY, resetInSeconds = 43200) => ({ ok: false, code: 'ELEVEN_SPEECH_CEILING', setting, day, resetInSeconds })

function memoryStorage(options = {}) {
  const map = new Map(Object.entries(options.initial ?? {}))
  return {
    map,
    async transaction(fn) {
      if (options.fail) throw new Error('storage unavailable')
      return await fn({ get: async key => (map.has(key) ? structuredClone(map.get(key)) : undefined), put: async (key, value) => { map.set(key, structuredClone(value)) } })
    },
  }
}

function fixture(options = {}) {
  const calls = { head: [], provider: [], paths: [] }
  const storage = options.storage ?? memoryStorage()
  let headAt = options.headAt ?? AT
  const env = {
    PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: ACCESS.email, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32),
    DEEPGRAM_API_KEY: 'synthetic-deepgram-master-key', ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: VOICE, ...options.env,
  }
  const status = phase => Response.json({ ok: true, phase, seedId: SEED, ballId: 'b'.repeat(64), epoch: 167 })
  env.HEAD = { idFromName: name => { assert.equal(name, 'node-main-v1'); return name }, get: () => ({ fetch: async request => {
    const url = new URL(request.url)
    calls.paths.push(url.pathname)
    if (url.pathname === '/_head/bootstrap-status') return status('complete')
    if (url.pathname === '/_head/speech-pass-budget') return Response.json({ ok: true, remaining: 5 })
    assert.equal(url.pathname, ELEVEN_SPEECH_HEAD_ROUTE)
    calls.head.push(request.clone())
    if (options.headFetch) return options.headFetch(request)
    return handleElevenSpeechHeadRoute(request, { url, seedId: SEED, storage, ownerEmail: ACCESS.email, now: () => headAt })
  } }) }
  env.MIRROR = { idFromName: () => 'mirror', get: () => ({ fetch: async () => status('ready') }) }
  const networkFetch = async (url, init) => {
    calls.provider.push({ url, init })
    if (String(url).includes('deepgram')) return Response.json({ access_token: 'synthetic.short-lived.token', expires_in: 30 })
    return (options.networkFetch ?? grant)(url, init)
  }
  const access = Object.hasOwn(options, 'access') ? options.access : ACCESS
  const now = () => AT
  const worker = createWorker({ verifyAccess: async () => access, networkFetch, now })
  const request = (extra = {}) => {
    const headers = new Headers({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })
    for (const [key, value] of Object.entries(extra.headers ?? {})) value === null ? headers.delete(key) : headers.set(key, value)
    return new Request(ORIGIN + (extra.path ?? '/_host/voice'), {
      method: extra.method ?? 'POST', headers, signal: extra.signal,
      ...(extra.method === 'GET' ? {} : { body: JSON.stringify(extra.body ?? { action: 'speech_pass_tts' }) }),
    })
  }
  const invoke = (extra = {}) => worker.fetch(request(extra), env)
  const direct = (extra = {}, dependencies = {}) => {
    const req = request(extra)
    return handleEdgeVoiceRequest({ request: req, url: new URL(req.url), env, seedId: SEED, access, networkFetch, now, ...dependencies })
  }
  const report = fields => invoke({ body: usageBody(fields) })
  const day = () => storage.map.get(dayKey(DAY))
  return { calls, env, storage, request, invoke, direct, report, day, setHeadAt: value => { headAt = value } }
}

const usage = (chars = 0, counted = chars + 5000, limits = LIMITS) => ({ day: DAY, chars, counted, maxChars: limits.maxChars,
  cost: Math.round(chars / 1000 * limits.pricePer1k * 10000) / 10000, maxCost: limits.maxCost, pricePer1k: limits.pricePer1k, slice: limits.slice })

test('a good pass: owner identity to the ledger, a reservation made first, the key only in the provider header, nothing of it in any answer', async () => {
  const fx = fixture({ networkFetch: () => Response.json({ token: PASS, api_key: KEY, extra: 'discard' }, { headers: { 'set-cookie': KEY } }) })
  const response = await fx.invoke({ body: { action: 'speech_pass_tts', voiceId: 'forged-voice-id', endpoint: 'https://foreign.invalid' } })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.deepEqual(JSON.parse(text), { ok: true, provider: 'elevenlabs', pass: PASS, voiceId: VOICE, modelId: 'eleven_flash_v2_5',
    reservation: `${DAY}.1`, usage: usage(0) })
  assert.equal(text.includes(KEY), false)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.has('set-cookie'), false)
  assert.equal(fx.calls.head.length, 1)
  const internal = fx.calls.head[0]
  assert.equal(internal.headers.get('x-x6-internal-authorized'), '1')
  assert.equal(internal.headers.get('x-x6-bootstrap-seed'), SEED)
  assert.deepEqual(JSON.parse(internal.headers.get('x-x6-verified-access')), ACCESS)
  assert.deepEqual(await internal.json(), { op: 'mint', limits: LIMITS })
  assert.equal(JSON.stringify([...internal.headers]).includes(KEY), false)
  assert.equal(fx.calls.provider.length, 1)
  const { url, init } = fx.calls.provider[0]
  assert.equal(url, ELEVEN_TOKEN_URL)
  assert.equal(url, 'https://api.elevenlabs.io/v1/single-use-token/tts_websocket')
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'error')
  assert.deepEqual([...new Headers(init.headers)], [['xi-api-key', KEY]])
  assert.equal(init.body, undefined)
  // The slice was reserved BEFORE the pass was given.
  assert.deepEqual(fx.day(), record({ mints: 1, open: { [`${DAY}.1`]: { slice: 5000, used: 0, seq: 0 } } }))
})

test('the configuration table: each missing name, both, a voice id that cannot go in a URL path', async () => {
  const rows = [
    [{ ELEVENLABS_API_KEY: undefined }, ['ELEVENLABS_API_KEY']], [{ ELEVENLABS_API_KEY: ' \t ' }, ['ELEVENLABS_API_KEY']],
    [{ ELEVENLABS_API_KEY: 12 }, ['ELEVENLABS_API_KEY']],
    [{ ELEVENLABS_VOICE_ID: '' }, ['ELEVENLABS_VOICE_ID']], [{ ELEVENLABS_VOICE_ID: undefined }, ['ELEVENLABS_VOICE_ID']],
    [{ ELEVENLABS_VOICE_ID: 'short' }, ['ELEVENLABS_VOICE_ID']], [{ ELEVENLABS_VOICE_ID: '../../voices/x' }, ['ELEVENLABS_VOICE_ID']],
    [{ ELEVENLABS_VOICE_ID: 'v'.repeat(65) }, ['ELEVENLABS_VOICE_ID']], [{ ELEVENLABS_VOICE_ID: 'voice id 12' }, ['ELEVENLABS_VOICE_ID']],
    [{ ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '' }, ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']],
  ]
  for (const [env, missing] of rows) {
    const fx = fixture({ env })
    const response = await fx.invoke()
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { ok: false, code: 'ELEVEN_SPEECH_UNCONFIGURED', missing })
    assert.equal(fx.calls.head.length, 0)
    assert.equal(fx.calls.provider.length, 0)
  }
  const trimmed = fixture({ env: { ELEVENLABS_VOICE_ID: ` ${VOICE} ` } })
  assert.equal((await (await trimmed.invoke()).json()).voiceId, VOICE)
})

test('a signed-out or non-owner caller is refused before any word about configuration, and cross-origin is refused', async () => {
  for (const env of [{}, { ELEVENLABS_API_KEY: undefined, ELEVENLABS_VOICE_ID: undefined }]) {
    for (const access of [null, undefined, {}, { ...ACCESS, type: 'access' }, { ...ACCESS, email: 'other@example.invalid' },
      { ...ACCESS, expires: AT / 1000 }, { ...ACCESS, expires: String(ACCESS.expires) }]) {
      for (const body of [{ action: 'speech_pass_tts' }, { action: 'speech_extend', reservation: `${DAY}.1` }, usageBody({ reservation: `${DAY}.1`, chars: 1 }), { action: 'speech_usage_read' }, { action: 'speech_pass' }]) {
        const fx = fixture({ access, env })
        const response = await fx.direct({ body })
        assert.equal(response.status, 403)
        const text = await response.text()
        assert.deepEqual(JSON.parse(text), { ok: false, code: 'OWNER_ACCESS_REQUIRED' })
        assert.equal(/ELEVEN|herVoice/.test(text), false)
        assert.equal(fx.calls.head.length + fx.calls.provider.length, 0)
      }
    }
  }
  // Through the Worker a signed-out browser never reaches the director.
  const signedOut = fixture({ access: null, env: { ELEVENLABS_API_KEY: undefined } })
  const refused = await signedOut.invoke()
  assert.equal(refused.status, 401)
  assert.equal(/ELEVEN/.test(await refused.text()), false)
  for (const headers of [{ origin: null }, { origin: 'https://foreign.invalid' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    const fx = fixture({ env: { ELEVENLABS_API_KEY: undefined } })
    const response = await fx.invoke({ headers })
    assert.equal(response.status, 403)
    assert.equal(/ELEVEN/.test(await response.text()), false)
    const direct = await fixture({ env: { ELEVENLABS_API_KEY: undefined } }).direct({ headers })
    assert.deepEqual(await direct.json(), { ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' })
    const pass = await fixture().direct({ headers, body: { action: 'speech_pass' } })
    assert.equal(/herVoice/.test(await pass.text()), false)
  }
})

test('missing HEAD, seed or transport fail closed without a provider call', async () => {
  for (const dependencies of [{ networkFetch: undefined }, { seedId: 'wrong' }]) {
    const fx = fixture()
    const response = await fx.direct({}, dependencies)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { ok: false, code: 'ELEVEN_SPEECH_UNAVAILABLE' })
    assert.equal(fx.calls.provider.length, 0)
  }
  const noHead = fixture()
  delete noHead.env.HEAD
  assert.deepEqual(await (await noHead.direct()).json(), { ok: false, code: 'ELEVEN_SPEECH_UNAVAILABLE' })
})

test('provider non-200, redirect, oversize, not JSON, a bad or key-bearing pass: fixed codes, and the reserved slice is released', async () => {
  for (const networkFetch of [
    async () => { throw Object.assign(new Error(KEY), { code: KEY }) },
    ...[301, 302, 401, 422, 429, 500].map(status => () => new Response(KEY, { status, headers: { location: 'https://foreign.invalid' } })),
    () => Object.defineProperty(grant(), 'redirected', { value: true }),
    () => new Response('x'.repeat(8193), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '8193' } }),
    () => new Response('not json', { headers: { 'content-type': 'application/json' } }),
    () => new Response(JSON.stringify({ token: PASS }), { headers: { 'content-type': 'text/plain' } }),
    ...[null, [], {}, { token: '' }, { token: 'short' }, { token: 'has space in it' }, { token: 'a'.repeat(513) }, { token: 7 },
      { token: `pre_${KEY}_post` }, { access_token: PASS }].map(value => () => Response.json(value)),
  ]) {
    const fx = fixture({ networkFetch })
    const response = await fx.invoke()
    assert.equal(response.status, 502)
    const text = await response.text()
    assert.deepEqual(JSON.parse(text), { ok: false, code: 'ELEVEN_SPEECH_PROVIDER_FAILED' })
    assert.equal(text.includes(KEY), false)
    assert.equal(fx.calls.provider.length, 1)
    // The pass was never given, so its slice is not left counted for the day.
    assert.deepEqual(fx.day(), record({ mints: 1 }))
    assert.deepEqual(await fx.calls.head[1].json(), { op: 'release', reservation: `${DAY}.1` })
  }
})

for (const phase of ['ledger', 'provider-headers', 'provider-body']) {
  test(`one 5-second deadline bounds the ${phase}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const started = Promise.withResolvers()
    let signal
    const stalled = (input, init) => {
      signal = init?.signal ?? input.signal
      if (phase !== 'provider-body') { started.resolve(); return new Promise(() => {}) }
      return new Response(new ReadableStream({ pull() { started.resolve(); return new Promise(() => {}) } }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } })
    }
    const fx = fixture(phase === 'ledger' ? { headFetch: stalled } : { networkFetch: stalled })
    const pending = fx.direct()
    await started.promise
    t.mock.timers.tick(5000)
    const response = await pending
    assert.equal(response.status, 504)
    assert.deepEqual(await response.json(), { ok: false, code: 'ELEVEN_SPEECH_PROVIDER_TIMEOUT' })
    assert.equal(signal.aborted, true)
    if (phase === 'ledger') assert.equal(fx.calls.provider.length, 0)
    else assert.deepEqual(fx.day(), record({ mints: 1 }))
  })
}

test('reserve, then settle; a slice never settled stays counted; a report larger than its slice counts in full', async () => {
  const fx = fixture({ env: { ELEVENLABS_MAX_CHARS_PER_DAY: '20000' } })
  const limits = { ...LIMITS, maxChars: 20000 }
  // Four passes reserve the whole day before a word is spoken; the fifth is refused, naming the setting and the day.
  for (let index = 1; index <= 4; index += 1) {
    const answer = await (await fx.invoke()).json()
    assert.equal(answer.reservation, `${DAY}.${index}`)
    assert.deepEqual(answer.usage, usage(0, index * 5000, limits))
  }
  let refused = await fx.invoke()
  assert.equal(refused.status, 429)
  assert.deepEqual(await refused.json(), ceilingBody('ELEVENLABS_MAX_CHARS_PER_DAY'))
  assert.equal(fx.calls.provider.length, 4)
  // A report below its slice that is not final keeps the whole slice counted; a page that never reports changes nothing.
  assert.equal((await fx.report({ reservation: `${DAY}.1`, chars: 1200, turns: 1 })).status, 200)
  refused = await fx.invoke()
  assert.equal(refused.status, 429)
  // A final report settles a slice down to what was spoken (here nothing): room for one more pass.
  assert.equal((await fx.report({ reservation: `${DAY}.2`, chars: 0, final: true })).status, 200)
  assert.deepEqual(fx.day().open[`${DAY}.2`], undefined)
  const fifth = await (await fx.invoke()).json()
  assert.equal(fifth.reservation, `${DAY}.5`)
  // 1,200 spoken; slice .1 still open (3,800 of it unspoken), .3, .4 and the new .5 whole.
  assert.deepEqual(fifth.usage, usage(1200, 1200 + 3800 + 3 * 5000, limits))
  // A report larger than its slice is counted in full, with no clamp, and the remainder is never discarded.
  assert.equal((await fx.report({ reservation: `${DAY}.3`, chars: 7300, turns: 2, final: true })).status, 200)
  const read = await (await fx.invoke({ body: { action: 'speech_usage_read' } })).json()
  assert.equal(read.usage.chars, 8500)
  assert.equal(read.usage.counted, 8500 + 3800 + 2 * 5000)
  assert.equal((await fx.invoke()).status, 429)
  // A report against a reservation already settled adds nothing: reports are cumulative, so its final already counted
  // the largest total of that pass (replaced by order, MUST 1: it used to add its 40 again).
  assert.equal((await fx.report({ reservation: `${DAY}.3`, seq: 2, chars: 7340, final: true })).status, 200)
  assert.equal(fx.day().chars, 8500)
  // A report from a page that spoke without a reservation cannot carry characters.
  const bad = await fx.report({ reservation: null, chars: 5 })
  assert.equal(bad.status, 400)
})

test('a report settles the day its pass was minted: yesterday is settled there, an older day is refused', async () => {
  const storage = memoryStorage({ initial: { [dayKey(YESTERDAY)]: record({ mints: 3, open: { [`${YESTERDAY}.3`]: { slice: 5000, used: 0, seq: 0 } } }) } })
  const fx = fixture({ storage })
  assert.equal((await fx.report({ reservation: `${YESTERDAY}.3`, chars: 900, turns: 1, final: true })).status, 200)
  assert.deepEqual(storage.map.get(dayKey(YESTERDAY)), record({ mints: 3, chars: 900, turns: 1 }))
  assert.equal(storage.map.has(dayKey(DAY)), false)
  const stale = await fx.report({ reservation: '2026-11-11.1', chars: 900, final: true })
  assert.equal(stale.status, 400)
  assert.deepEqual(await stale.json(), { ok: false, code: 'ELEVEN_SPEECH_USAGE_STALE' })
})

test('the ceiling by characters, by cost, the 0 off switch and a malformed setting', async () => {
  const atCeiling = fixture({ storage: memoryStorage({ initial: { [dayKey(DAY)]: record({ chars: 95001 }) } }) })
  let response = await atCeiling.invoke()
  assert.equal(response.status, 429)
  assert.deepEqual(await response.json(), ceilingBody('ELEVENLABS_MAX_CHARS_PER_DAY'))
  assert.equal(atCeiling.calls.provider.length, 0)
  const justUnder = fixture({ storage: memoryStorage({ initial: { [dayKey(DAY)]: record({ chars: 95000 }) } }) })
  assert.equal((await justUnder.invoke()).status, 200)
  const costEnv = { ELEVENLABS_MAX_CHARS_PER_DAY: '1000000', ELEVENLABS_PRICE_PER_1K_CHARS: '1', ELEVENLABS_CHARS_PER_PASS: '1000' }
  const byCost = fixture({ env: costEnv, storage: memoryStorage({ initial: { [dayKey(DAY)]: record({ chars: 3001 }) } }) })
  response = await byCost.invoke()
  assert.deepEqual(await response.json(), ceilingBody('ELEVENLABS_MAX_COST_PER_DAY'))
  const under = fixture({ env: costEnv, storage: memoryStorage({ initial: { [dayKey(DAY)]: record({ chars: 3000 }) } }) })
  assert.equal((await under.invoke()).status, 200)
  for (const name of ['ELEVENLABS_MAX_CHARS_PER_DAY', 'ELEVENLABS_MAX_COST_PER_DAY']) {
    const off = fixture({ env: { [name]: '0' } })
    response = await off.invoke()
    assert.equal(response.status, 429)
    assert.deepEqual(await response.json(), ceilingBody(name))
    assert.equal(off.calls.provider.length, 0)
  }
  for (const name of ['ELEVENLABS_MAX_CHARS_PER_DAY', 'ELEVENLABS_MAX_COST_PER_DAY', 'ELEVENLABS_PRICE_PER_1K_CHARS', 'ELEVENLABS_CHARS_PER_PASS']) {
    for (const value of ['-1', '1e3', ' 5', '5 ', 'abc', '01', '1.', '.5', 'Infinity', '0x10', 5]) {
      const fx = fixture({ env: { [name]: value } })
      response = await fx.invoke()
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { ok: false, code: 'ELEVEN_SPEECH_LIMIT_INVALID', setting: name })
      assert.equal(fx.calls.head.length + fx.calls.provider.length, 0)
    }
  }
  // A slice of nothing would let passes out unreserved, and a slice is whole characters.
  for (const value of ['0', '1.5', '1000001']) {
    assert.deepEqual(await (await fixture({ env: { ELEVENLABS_CHARS_PER_PASS: value } }).invoke()).json(), { ok: false, code: 'ELEVEN_SPEECH_LIMIT_INVALID', setting: 'ELEVENLABS_CHARS_PER_PASS' })
  }
  // Unset or empty: the defaults.
  for (const value of [undefined, '']) {
    const fx = fixture({ env: { ELEVENLABS_MAX_CHARS_PER_DAY: value, ELEVENLABS_MAX_COST_PER_DAY: value, ELEVENLABS_PRICE_PER_1K_CHARS: value, ELEVENLABS_CHARS_PER_PASS: value } })
    assert.equal((await fx.invoke()).status, 200)
    assert.deepEqual(await fx.calls.head[0].json(), { op: 'mint', limits: LIMITS })
  }
})

test('six passes a rolling minute, then 429 with Retry-After; open reservations are bounded; a day rollover starts a new count', async () => {
  const fx = fixture()
  for (let index = 0; index < 6; index += 1) assert.equal((await fx.invoke()).status, 200)
  const limited = await fx.invoke()
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '60')
  assert.deepEqual(await limited.json(), { ok: false, code: 'ELEVEN_SPEECH_RATE_LIMITED' })
  assert.equal(fx.calls.provider.length, 6)
  fx.setHeadAt(AT + 60000)
  assert.equal((await fx.invoke()).status, 200)
  assert.equal(fx.day().mints, 7)
  const open = Object.fromEntries(Array.from({ length: ELEVEN_OPEN_RESERVATIONS_MAX }, (_, index) => [`${DAY}.${index + 1}`, { slice: 1, used: 0, seq: 0 }]))
  const full = fixture({ storage: memoryStorage({ initial: { [dayKey(DAY)]: record({ mints: ELEVEN_OPEN_RESERVATIONS_MAX, open }) } }) })
  const busy = await full.invoke()
  assert.equal(busy.status, 429)
  assert.deepEqual(await busy.json(), { ok: false, code: 'ELEVEN_SPEECH_PASSES_OPEN' })
  const rollover = fixture({ storage: memoryStorage({ initial: { [dayKey(DAY)]: record({ chars: 100000 }) } }) })
  assert.equal((await rollover.invoke()).status, 429)
  rollover.setHeadAt(AT + 86400000)
  const next = await rollover.invoke()
  assert.equal(next.status, 200)
  const answer = await next.json()
  assert.equal(answer.reservation, '2026-11-14.1')
  assert.deepEqual(answer.usage, { ...usage(0), day: '2026-11-14' })
})

test('a ledger that cannot be read refuses, never opens', async () => {
  for (const options of [
    { storage: memoryStorage({ fail: true }) },
    { storage: memoryStorage({ initial: { [dayKey(DAY)]: { chars: -1 } } }) },
    { storage: memoryStorage({ initial: { [dayKey(DAY)]: record({ chars: 1.5 }) } }) },
    { storage: memoryStorage({ initial: { [dayKey(DAY)]: { ...record(), extra: 1 } } }) },
    { storage: memoryStorage({ initial: { [dayKey(DAY)]: record({ open: { 'not-an-id': { slice: 1, used: 0 } } }) } }) },
    { storage: memoryStorage({ initial: { [dayKey(DAY)]: record({ open: { [`${DAY}.1`]: { slice: 0, used: 0, seq: 0 } } }) } }) },
    { storage: memoryStorage({ initial: { [dayKey(DAY)]: record({ open: { [`${DAY}.1`]: { slice: 1, used: 0 } } }) } }) },
    { storage: memoryStorage({ initial: { 'head:eleven-speech:v1:mints': ['x'] } }) },
    { headFetch: () => Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 }) },
    { headFetch: () => Response.json({ ok: true }) },
    { headFetch: () => Response.json({ ok: true, day: DAY, record: { ...record(), chars: '5' }, counted: 0 }) },
    { headFetch: () => Response.json({ ok: true, day: DAY, record: record(), counted: 0 }) },
    { headFetch: () => new Response('x'.repeat(9000), { headers: { 'content-type': 'application/json' } }) },
    { headFetch: () => { throw new Error('binding gone') } },
  ]) {
    const fx = fixture(options)
    const response = await fx.invoke()
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { ok: false, code: 'ELEVEN_SPEECH_LEDGER_UNAVAILABLE' })
    assert.equal(fx.calls.provider.length, 0)
  }
})

test('a usage report can only add, within bounds; the read answers today, what is counted, and the limits', async () => {
  const fx = fixture()
  const minted = await (await fx.invoke()).json()
  const reservation = minted.reservation
  assert.deepEqual(await (await fx.report({ reservation, chars: 120, turns: 1, firstAudio: { count: 1, sumMs: 310, maxMs: 310 }, errors: { closed: 1 } })).json(), { ok: true, action: 'speech_usage' })
  assert.equal((await fx.report({ reservation, seq: 2, chars: 200, turns: 1 })).status, 200)
  assert.equal((await fx.report({ reservation, seq: 3, chars: 250200, turns: 1, firstAudio: { count: 1, sumMs: 60000, maxMs: 60000 }, errors: { mint: 10000, ceiling: 2 }, final: true })).status, 200)
  assert.equal((await fx.report({ errors: { mint: 1 } })).status, 200)
  for (const bad of [{ chars: -1 }, { chars: 1.5 }, { chars: '5' }, { turns: 10001 }, { reservation: 'x' }, { reservation: 7 }, { final: 1 },
    { seq: 0 }, { seq: 1.5 }, { seq: '1' }, { seq: 1000000001 }, { seq: undefined },
    { firstAudio: { count: 0, sumMs: 1, maxMs: 0 } }, { firstAudio: { count: 1, sumMs: 60001, maxMs: 60000 } }, { firstAudio: { count: 1, sumMs: 1, maxMs: 60001 } },
    { firstAudio: null }, { errors: { other: 1 } }, { errors: { mint: 10001 } }, { errors: { mint: -1 } }, { errors: [] }, { errors: null }, { extra: 1 }]) {
    const response = await fx.report({ reservation, chars: 1, ...bad })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { ok: false, code: 'ELEVEN_SPEECH_USAGE_INVALID' })
  }
  const kept = record({ chars: 250200, mints: 1, turns: 3, firstAudio: { count: 2, sumMs: 60310, maxMs: 60000 },
    errors: { mint: 10001, open: 0, first_audio: 0, closed: 1, ceiling: 2, unconfirmed: 0 } })
  assert.deepEqual(fx.day(), kept)
  const read = await fx.invoke({ body: { action: 'speech_usage_read' } })
  assert.equal(read.status, 200)
  assert.deepEqual(await read.json(), { ok: true, action: 'speech_usage_read', day: DAY,
    usage: { ...kept, counted: 250200, cost: 10.008 }, limits: LIMITS })
  // Past the ceiling now: the next pass is refused.
  assert.equal((await fx.invoke()).status, 429)
  // A usage report needs neither the key nor the voice id; a storage failure is refused.
  assert.equal((await fixture({ env: { ELEVENLABS_API_KEY: undefined } }).report({ errors: { mint: 1 } })).status, 200)
  const down = await fixture({ storage: memoryStorage({ fail: true }) }).report({ errors: { mint: 1 } })
  assert.equal(down.status, 503)
})

test('the HEAD route makes every check itself', async () => {
  const storage = memoryStorage()
  const call = (extra = {}) => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED,
      'x-x6-verified-access': JSON.stringify(ACCESS) })
    for (const [key, value] of Object.entries(extra.headers ?? {})) value === null ? headers.delete(key) : headers.set(key, value)
    const url = new URL(`https://x61.internal${extra.path ?? ELEVEN_SPEECH_HEAD_ROUTE}`)
    const request = new Request(url, { method: extra.method ?? 'POST', headers, ...(extra.method === 'GET' ? {} : { body: extra.raw ?? JSON.stringify(extra.body ?? { op: 'read' }) }) })
    return handleElevenSpeechHeadRoute(request, { url, seedId: SEED, storage, ownerEmail: ACCESS.email, now: () => AT })
  }
  const code = async response => [response.status, (await response.json()).code]
  assert.deepEqual(await code(await call({ headers: { 'x-x6-internal-authorized': null } })), [401, 'UNAUTHORIZED'])
  assert.deepEqual(await code(await call({ method: 'GET' })), [405, 'METHOD_UNAVAILABLE'])
  assert.deepEqual(await code(await call({ path: `${ELEVEN_SPEECH_HEAD_ROUTE}?x=1` })), [404, 'NOT_FOUND'])
  assert.deepEqual(await code(await call({ headers: { 'x-x6-bootstrap-seed': 'b'.repeat(64) } })), [503, 'BOOTSTRAP_REQUIRED'])
  for (const access of ['null', '{', JSON.stringify({ ...ACCESS, email: 'other@example.invalid' }), JSON.stringify({ ...ACCESS, expires: AT / 1000 - 1 })]) {
    assert.deepEqual(await code(await call({ headers: { 'x-x6-verified-access': access } })), [403, 'ELEVEN_SPEECH_OWNER_REQUIRED'])
  }
  assert.deepEqual(await code(await call({ headers: { 'content-type': 'text/plain' } })), [400, 'ELEVEN_SPEECH_LEDGER_REQUEST_INVALID'])
  const usageOp = (fields = {}) => ({ op: 'usage', reservation: null, seq: 1, chars: 0, turns: 0, firstAudio: { ...NO_FA }, errors: {}, final: false, ...fields })
  for (const body of [{ op: 'read', extra: 1 }, { op: 'mint' }, { op: 'mint', limits: { maxChars: -1, maxCost: 4, pricePer1k: 0.04, slice: 5000 } },
    { op: 'mint', limits: { maxChars: 1, maxCost: 4, pricePer1k: 0.04 } }, { op: 'mint', limits: { ...LIMITS, slice: 0 } },
    { op: 'usage', chars: 1 }, usageOp({ chars: -5 }), usageOp({ extra: 1 }), usageOp({ seq: 0 }), { op: 'release' }, { op: 'release', reservation: 'x' },
    { op: 'extend', reservation: `${DAY}.1` }, { op: 'extend', reservation: 'x', limits: LIMITS }, { op: 'delete' }]) {
    assert.deepEqual(await code(await call({ body })), [400, 'ELEVEN_SPEECH_LEDGER_REQUEST_INVALID'], JSON.stringify(body))
  }
  assert.deepEqual(await code(await call({ raw: `{"op":"read","pad":"${'x'.repeat(1100)}"}` })), [400, 'ELEVEN_SPEECH_LEDGER_REQUEST_INVALID'])
  assert.equal(storage.map.size, 0)
  const ok = await call({ body: { op: 'read' } })
  assert.deepEqual(await ok.json(), { ok: true, day: DAY, record: record(), counted: 0 })
  // Only its own keys are ever written.
  await call({ body: { op: 'mint', limits: { ...LIMITS, maxChars: 10000, slice: 10 } } })
  await call({ body: usageOp({ reservation: `${DAY}.1`, chars: 3, turns: 1, firstAudio: { count: 1, sumMs: 100, maxMs: 100 } }) })
  // A release frees only a slice nothing was reported against.
  await call({ body: { op: 'release', reservation: `${DAY}.1` } })
  assert.deepEqual(storage.map.get(dayKey(DAY)).open, { [`${DAY}.1`]: { slice: 10, used: 3, seq: 1 } })
  assert.deepEqual([...storage.map.keys()].sort(), [dayKey(DAY), 'head:eleven-speech:v1:mints'])
})

test('at the edge: Deepgram\'s speech_pass answer gains one field only when a setting is present; with none it is byte for byte as before', async () => {
  const fx = fixture()
  const direct = await fx.invoke({ path: ELEVEN_SPEECH_HEAD_ROUTE, body: { op: 'read' } })
  assert.equal(direct.ok, false)
  assert.equal(fx.calls.paths.includes(ELEVEN_SPEECH_HEAD_ROUTE), false)
  assert.equal(fx.storage.map.size, 0)
  const answer = async (env) => {
    const run = fixture({ env })
    const response = await run.invoke({ body: { action: 'speech_pass' } })
    assert.equal(run.calls.head.length, 0)
    assert.deepEqual(run.calls.provider.map(call => call.url), ['https://api.deepgram.com/v1/auth/grant'])
    return [response.status, [...response.headers].filter(([name]) => name !== 'date').sort(), await response.text()]
  }
  const none = { ELEVENLABS_API_KEY: undefined, ELEVENLABS_VOICE_ID: undefined }
  const before = await answer(none)
  // The deployed [vars] (the numbers only), and a voice id set to nothing: no key, exactly the same bytes.
  assert.deepEqual(await answer({ ...none, ELEVENLABS_VOICE_ID: '', ELEVENLABS_MAX_CHARS_PER_DAY: '100000', ELEVENLABS_MAX_COST_PER_DAY: '4',
    ELEVENLABS_PRICE_PER_1K_CHARS: '0.04', ELEVENLABS_CHARS_PER_PASS: '5000' }), before)
  assert.deepEqual(JSON.parse(before[2]), { ok: true, provider: 'deepgram', accessToken: 'synthetic.short-lived.token', expiresInSeconds: 30 })
  const base = JSON.parse(before[2])
  assert.deepEqual(JSON.parse((await answer({}))[2]), { ...base, herVoice: { configured: true } })
  assert.deepEqual(JSON.parse((await answer({ ELEVENLABS_VOICE_ID: '' }))[2]), { ...base, herVoice: { configured: false, missing: ['ELEVENLABS_VOICE_ID'] } })
  assert.deepEqual(JSON.parse((await answer({ ELEVENLABS_API_KEY: undefined }))[2]), { ...base, herVoice: { configured: false, missing: ['ELEVENLABS_API_KEY'] } })
  // The key itself never rides on it.
  assert.equal((await answer({}))[2].includes(KEY), false)
  assert.deepEqual(herVoiceField({ ELEVENLABS_API_KEY: '  ', ELEVENLABS_VOICE_ID: 'short' }), { herVoice: { configured: false, missing: ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'] } })
})

test('review: wrangler.toml [vars] never carries the key and never an empty voice id, so a deploy cannot wipe her voice', () => {
  const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')
  assert.match(toml, /^ELEVENLABS_CHARS_PER_PASS = "5000"$/m)
  assert.doesNotMatch(toml, /^\s*ELEVENLABS_API_KEY\s*=/m, 'the key is a Worker secret, never a line here')
  // The voice id is an identifier: it is either absent (then a Worker secret supplies it) or a valid id, never empty.
  const pinned = [...toml.matchAll(/^\s*ELEVENLABS_VOICE_ID\s*=\s*"([^"]*)"\s*$/gm)].map(match => match[1])
  assert.ok(pinned.length <= 1, 'one voice id line at most')
  assert.equal(toml.match(/^\s*ELEVENLABS_VOICE_ID\s*=/gm)?.length ?? 0, pinned.length, 'the voice id line is a plain quoted string')
  for (const id of pinned) assert.deepEqual(herVoiceField({ ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: id }), { herVoice: { configured: true } })
})

test('mint, usage and read go through the real X61HeadDurableObject.fetch', async (t) => {
  t.mock.method(Date, 'now', () => AT)
  const rows = new Map([['bootstrap:v1', { phase: 'complete', seedId: SEED }], ['head:current', { ballId: 'b'.repeat(64), epoch: 2, entries: {} }]])
  let tail = Promise.resolve()
  const view = data => ({
    get: async key => structuredClone(data.get(key)), put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => structuredClone(new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit))),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  })
  const storage = {
    get: key => view(rows).get(key),
    transaction(operation) {
      const result = tail.then(async () => { const data = new Map(structuredClone([...rows])); const value = await operation(view(data)); for (const [key, item] of data) rows.set(key, item); return value })
      tail = result.catch(() => {})
      return result
    },
  }
  const env = { OWNER_EMAIL: ACCESS.email }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  t.after(() => head.wakeStore?.dispose?.())
  head.broadcast = async () => {}
  const fx = fixture({ headFetch: request => head.fetch(request) })
  const minted = await fx.invoke()
  assert.equal(minted.status, 200)
  const { reservation } = await minted.json()
  assert.equal(reservation, `${DAY}.1`)
  assert.equal((await fx.report({ reservation, chars: 42, turns: 1, final: true })).status, 200)
  const read = await (await fx.invoke({ body: { action: 'speech_usage_read' } })).json()
  assert.equal(read.usage.chars, 42)
  assert.equal(read.usage.mints, 1)
  assert.equal(read.usage.counted, 42)
  assert.deepEqual(rows.get(dayKey(DAY)), record({ chars: 42, mints: 1, turns: 1 }))
  assert.equal(fx.storage.map.size, 0)
})

// ---- MUST 1, 2 and 5 at the edge ----

test('his sequence: the report of N never arrives, the page goes away and its final carries the cumulative N: N is counted', async () => {
  const fx = fixture()
  const { reservation } = await (await fx.invoke()).json()
  // seq 1 (chars 900) hangs and never reaches HEAD; the final (seq 2) carries the same cumulative total.
  assert.equal((await fx.report({ reservation, seq: 2, chars: 900, turns: 1, final: true })).status, 200)
  assert.deepEqual(fx.day(), record({ mints: 1, chars: 900, turns: 1 }))
  // The late seq 1 finally arrives: the pass is settled, so it adds nothing.
  assert.equal((await fx.report({ reservation, seq: 1, chars: 900, turns: 1 })).status, 200)
  assert.deepEqual(fx.day(), record({ mints: 1, chars: 900, turns: 1 }))
})

test('an older or repeated report is ignored, a final lower than a seen total settles at the larger, and only then releases', async () => {
  const fx = fixture()
  const { reservation } = await (await fx.invoke()).json()
  assert.equal((await fx.report({ reservation, seq: 3, chars: 1200, turns: 1, errors: { closed: 1 } })).status, 200)
  assert.deepEqual(fx.day().open[reservation], { slice: 5000, used: 1200, seq: 3 })
  // A report arriving after a later one, and the same report again: nothing changes (telemetry not doubled either).
  for (const seq of [2, 3]) assert.equal((await fx.report({ reservation, seq, chars: seq === 2 ? 700 : 1200, turns: 1, errors: { closed: 1 } })).status, 200)
  assert.deepEqual(fx.day(), record({ mints: 1, chars: 1200, turns: 1, errors: { ...record().errors, closed: 1 }, open: { [reservation]: { slice: 5000, used: 1200, seq: 3 } } }))
  assert.equal((await (await fx.invoke({ body: { action: 'speech_usage_read' } })).json()).usage.counted, 5000)
  // A final with a LOWER total (even with no characters at all) settles at the larger, then the rest is released.
  assert.equal((await fx.report({ reservation, seq: 4, chars: 0, final: true })).status, 200)
  assert.equal(fx.day().chars, 1200)
  assert.deepEqual(fx.day().open, {})
  assert.equal((await (await fx.invoke({ body: { action: 'speech_usage_read' } })).json()).usage.counted, 1200)
  // A higher total than seen is counted in full (no clamp, cumulative: only the difference is added).
  const second = (await (await fx.invoke()).json()).reservation
  assert.equal((await fx.report({ reservation: second, seq: 1, chars: 30000 })).status, 200)
  assert.equal((await fx.report({ reservation: second, seq: 2, chars: 30500, final: true })).status, 200)
  assert.equal(fx.day().chars, 1200 + 30500)
})

test('speech_extend reserves one further slice for the same open pass, under the same gates, rate and ceiling', async () => {
  const fx = fixture({ env: { ELEVENLABS_MAX_CHARS_PER_DAY: '15000' } })
  const limits = { ...LIMITS, maxChars: 15000 }
  const { reservation } = await (await fx.invoke()).json()
  const extended = await fx.invoke({ body: { action: 'speech_extend', reservation } })
  assert.equal(extended.status, 200)
  assert.deepEqual(await extended.json(), { ok: true, action: 'speech_extend', reservation, reserved: 10000, usage: usage(0, 10000, limits) })
  assert.deepEqual(fx.day().open[reservation], { slice: 10000, used: 0, seq: 0 })
  assert.equal(fx.calls.provider.length, 1)
  // His sequence: 5,000 reserved, 9,000 to speak: the page extends first, and if every report is lost, 10,000 stay counted.
  assert.equal((await (await fx.invoke({ body: { action: 'speech_usage_read' } })).json()).usage.counted, 10000)
  assert.equal((await fx.invoke({ body: { action: 'speech_extend', reservation } })).status, 200)
  // Past the ceiling: refused with the edge's day and the seconds until its midnight.
  const refused = await fx.invoke({ body: { action: 'speech_extend', reservation } })
  assert.equal(refused.status, 429)
  assert.deepEqual(await refused.json(), ceilingBody('ELEVENLABS_MAX_CHARS_PER_DAY'))
  assert.deepEqual(fx.day().open[reservation], { slice: 15000, used: 0, seq: 0 })
  // A settled pass cannot be extended; a malformed or foreign-shaped request is refused before HEAD.
  assert.equal((await fx.report({ reservation, seq: 1, chars: 9000, final: true })).status, 200)
  const stale = await fx.invoke({ body: { action: 'speech_extend', reservation } })
  assert.equal(stale.status, 400)
  assert.deepEqual(await stale.json(), { ok: false, code: 'ELEVEN_SPEECH_USAGE_STALE' })
  const heads = fx.calls.head.length
  for (const body of [{ action: 'speech_extend' }, { action: 'speech_extend', reservation: 'x' }, { action: 'speech_extend', reservation, chars: 1 }]) {
    const response = await fx.invoke({ body })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { ok: false, code: 'ELEVEN_SPEECH_EXTEND_INVALID' })
  }
  assert.equal(fx.calls.head.length, heads)
  // Extensions share the six-a-minute limit with passes.
  const rate = fixture()
  const pass = (await (await rate.invoke()).json()).reservation
  for (let index = 0; index < 5; index += 1) assert.equal((await rate.invoke({ body: { action: 'speech_extend', reservation: pass } })).status, 200)
  const limited = await rate.invoke({ body: { action: 'speech_extend', reservation: pass } })
  assert.equal(limited.status, 429)
  assert.deepEqual(await limited.json(), { ok: false, code: 'ELEVEN_SPEECH_RATE_LIMITED' })
})

test('the ceiling refusal carries the edge\'s day and the seconds until its own midnight', async () => {
  const lateNight = Date.UTC(2026, 10, 13, 23, 59, 50)
  const full = () => memoryStorage({ initial: { [dayKey(DAY)]: record({ chars: 100000, mints: 1, open: { [`${DAY}.1`]: { slice: 5000, used: 0, seq: 0 } } }) } })
  const fx = fixture({ headAt: lateNight, storage: full() })
  assert.deepEqual(await (await fx.invoke()).json(), ceilingBody('ELEVENLABS_MAX_CHARS_PER_DAY', DAY, 10))
  // An extension of a pass minted before midnight is never made after it (review): refused as ended, not as a ceiling.
  const after = fixture({ headAt: Date.UTC(2026, 10, 14, 0, 0, 3), storage: full() })
  const ended = await after.invoke({ body: { action: 'speech_extend', reservation: `${DAY}.1` } })
  assert.equal(ended.status, 409)
  assert.deepEqual(await ended.json(), { ok: false, code: 'ELEVEN_SPEECH_PASS_DAY_ENDED' })
  // A pass on the edge's new day is not refused.
  assert.equal((await after.invoke()).status, 200)
  // A refusal from HEAD without a valid resetInSeconds is a ledger that cannot be read.
  for (const resetInSeconds of [undefined, -1, 1.5, 86401, '10']) {
    const odd = fixture({ headFetch: () => Response.json({ ok: false, code: 'ELEVEN_SPEECH_CEILING', setting: 'ELEVENLABS_MAX_CHARS_PER_DAY', day: DAY, resetInSeconds }, { status: 429 }) })
    assert.deepEqual(await (await odd.invoke()).json(), { ok: false, code: 'ELEVEN_SPEECH_LEDGER_UNAVAILABLE' })
  }
})

test('review: a pass minted before the edge\'s midnight is never extended after it: refused as ended (not a ceiling), its day untouched, its report still settles there', async () => {
  const yesterdayPass = `${YESTERDAY}.4`
  const initial = () => ({ [dayKey(YESTERDAY)]: record({ chars: 1000, mints: 4, open: { [yesterdayPass]: { slice: 5000, used: 0, seq: 0 } } }) })
  for (const full of [false, true]) {
    const storage = memoryStorage({ initial: { ...initial(), ...(full ? { [dayKey(DAY)]: record({ chars: 100000 }) } : {}) } })
    const fx = fixture({ storage })
    const before = structuredClone(storage.map.get(dayKey(YESTERDAY)))
    const refused = await fx.invoke({ body: { action: 'speech_extend', reservation: yesterdayPass } })
    assert.equal(refused.status, 409)
    assert.deepEqual(await refused.json(), { ok: false, code: 'ELEVEN_SPEECH_PASS_DAY_ENDED' })
    assert.deepEqual(storage.map.get(dayKey(YESTERDAY)), before)
    assert.equal(storage.map.get(dayKey(DAY))?.chars ?? 0, full ? 100000 : 0)
    // What it spoke is still settled on the day it was reserved.
    assert.equal((await fx.report({ reservation: yesterdayPass, seq: 1, chars: 900, final: true })).status, 200)
    assert.deepEqual(storage.map.get(dayKey(YESTERDAY)), record({ chars: 1900, mints: 4 }))
  }
  // A pass of today is extended as before.
  const fx = fixture()
  const { reservation } = await (await fx.invoke()).json()
  assert.equal((await fx.invoke({ body: { action: 'speech_extend', reservation } })).status, 200)
})
