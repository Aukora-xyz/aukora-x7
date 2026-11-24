/** Owner-only temporary speech grants use injected transport and never expose provider credentials. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker } from '../worker.mjs'
import { handleEdgeVoiceRequest } from '../voice-director.mjs'

const ORIGIN = 'https://speech.example.invalid'
const SEED = 'a'.repeat(64)
const AT = 1794351000000
const MASTER = 'synthetic-deepgram-master-key'
const ACCESS = Object.freeze({ type: 'owner', email: 'owner@example.invalid', expires: AT / 1000 + 3600 })
const token = 'synthetic.short-lived.token'
const grant = () => Response.json({ access_token: token, expires_in: 30 })
const budget = () => Response.json({ ok: true, remaining: 5 })
const deferred = () => Promise.withResolvers()

function fixture(options = {}) {
  const calls = { budget: [], provider: [] }
  const env = {
    PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: ACCESS.email, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32),
    DEEPGRAM_API_KEY: MASTER, ...options.env,
  }
  const status = phase => Response.json({ ok: true, phase, seedId: SEED, ballId: 'b'.repeat(64), epoch: 167 })
  env.HEAD = { idFromName: name => { assert.equal(name, 'node-main-v1'); return name }, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    if (path === '/_head/bootstrap-status') return status('complete')
    assert.equal(path, '/_head/speech-pass-budget')
    calls.budget.push(request)
    return (options.budgetFetch ?? budget)(request)
  } }) }
  env.MIRROR = { idFromName: () => 'mirror', get: () => ({ fetch: async () => status('ready') }) }
  const networkFetch = async (url, init) => {
    calls.provider.push({ url, init })
    return (options.networkFetch ?? grant)(url, init)
  }
  const access = Object.hasOwn(options, 'access') ? options.access : ACCESS
  const now = options.now ?? (() => AT)
  const worker = createWorker({ verifyAccess: async () => access, networkFetch, now })
  const request = (extra = {}) => {
    const headers = new Headers({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })
    for (const [key, value] of Object.entries(extra.headers ?? {})) value === null ? headers.delete(key) : headers.set(key, value)
    return new Request(ORIGIN + (extra.path ?? '/_host/voice'), {
      method: extra.method ?? 'POST', headers, signal: extra.signal,
      ...(extra.method === 'GET' ? {} : { body: JSON.stringify(extra.body ?? { action: 'speech_pass' }) }),
    })
  }
  const invoke = (extra = {}) => worker.fetch(request(extra), env)
  const direct = (extra = {}, dependencies = {}) => {
    const req = request(extra)
    return handleEdgeVoiceRequest({ request: req, url: new URL(req.url), env, seedId: SEED, access, networkFetch, now, ...dependencies })
  }
  return { calls, env, request, invoke, direct }
}

async function failure(response, status, code) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { ok: false, code })
}

test('Worker sends only trusted owner identity to the durable budget and fixed 30-second grant parameters', async () => {
  const fx = fixture({ networkFetch: async () => Response.json({ access_token: token, expires_in: 30, api_key: MASTER, extra: 'discard' }, { headers: { 'set-cookie': MASTER } }) })
  const response = await fx.invoke({ headers: {
    cookie: 'synthetic-client-cookie', authorization: 'Bearer synthetic-client-token',
    'x-x6-verified-access': JSON.stringify({ type: 'owner', email: 'forged@example.invalid', expires: 9999999999 }),
  }, body: { action: 'speech_pass', ownerSubject: 'forged', ttl_seconds: 3600, endpoint: 'https://foreign.invalid' } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, provider: 'deepgram', accessToken: token, expiresInSeconds: 30 })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.has('set-cookie'), false)
  assert.equal(fx.calls.budget.length, 1)
  const internal = fx.calls.budget[0]
  assert.equal(internal.method, 'POST')
  assert.equal(internal.headers.get('x-x6-internal-authorized'), '1')
  assert.equal(internal.headers.get('x-x6-bootstrap-seed'), SEED)
  assert.deepEqual(JSON.parse(internal.headers.get('x-x6-verified-access')), ACCESS)
  assert.deepEqual(await internal.json(), {})
  assert.equal(JSON.stringify([...internal.headers]).includes(MASTER), false)
  assert.equal(fx.calls.provider.length, 1)
  const { url, init } = fx.calls.provider[0]
  assert.equal(url, 'https://api.deepgram.com/v1/auth/grant')
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'error')
  assert.deepEqual(JSON.parse(init.body), { ttl_seconds: 30 })
  assert.deepEqual([...new Headers(init.headers)], [['authorization', `Token ${MASTER}`], ['content-type', 'application/json']])
})

test('strict owner type, matching verified email and unexpired identity precede reservation or provider access', async () => {
  for (const access of [null, undefined, true, {}, { ...ACCESS, type: 'access' }, { ...ACCESS, type: 'service' },
    { ...ACCESS, email: '' }, { ...ACCESS, email: 'owner' }, { ...ACCESS, email: 'other@example.invalid' },
    { ...ACCESS, email: ' owner@example.invalid' }, { ...ACCESS, email: 'x'.repeat(255) },
    { ...ACCESS, expires: undefined }, { ...ACCESS, expires: String(ACCESS.expires) }, { ...ACCESS, expires: Infinity },
    { ...ACCESS, expires: AT / 1000 }, { ...ACCESS, expires: AT / 1000 - 1 }]) {
    const fx = fixture({ access })
    await failure(await fx.invoke(), access ? 403 : 401, 'OWNER_ACCESS_REQUIRED')
    assert.equal(fx.calls.budget.length, 0)
    assert.equal(fx.calls.provider.length, 0)
  }
  const fx = fixture({ access: { ...ACCESS, email: ACCESS.email.toUpperCase() } })
  assert.equal((await fx.invoke()).status, 200)
  for (const env of [{ OWNER_EMAIL: undefined }, { OWNER_EMAIL: 'other@example.invalid' }]) {
    const denied = fixture({ env })
    await failure(await denied.direct(), 403, 'OWNER_ACCESS_REQUIRED')
  }
})

test('the actual owner verifier admits a signed owner assertion and ignores forged verified-access headers', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const fx = fixture()
  fx.env.OWNER_PUBLIC_KEY_HEX = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex')
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const input = encoded({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encoded({ iss: 'aukora.x61.owner', aud: fx.env.PUBLIC_HOST, email: ACCESS.email, nbf: AT / 1000 - 1, exp: ACCESS.expires })
  const signature = Buffer.from(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(input))).toString('base64url')
  let issued = 0
  const worker = createWorker({ now: () => AT, networkFetch: async () => { issued++; return grant() } })
  const signed = await worker.fetch(fx.request({ headers: { 'x-x6-owner-assertion': input + '.' + signature } }), fx.env)
  assert.equal(signed.status, 200)
  await failure(await worker.fetch(fx.request({ headers: { 'x-x6-verified-access': JSON.stringify(ACCESS) } }), fx.env), 401, 'OWNER_ACCESS_REQUIRED')
  assert.equal(issued, 1)
})

test('speech passes require POST with exact same-origin browser signals', async () => {
  for (const headers of [{ origin: null }, { origin: 'null' }, { origin: 'https://foreign.invalid' },
    { 'sec-fetch-site': null }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'none' }]) {
    const fx = fixture()
    const response = await fx.invoke({ headers })
    assert.equal(response.status, 403)
    assert.equal(fx.calls.budget.length, 0)
    assert.equal(fx.calls.provider.length, 0)
  }
  const fx = fixture()
  assert.equal((await fx.invoke({ method: 'PUT' })).status, 405)
  const status = await fx.invoke({ method: 'GET' })
  assert.equal(status.status, 200)
  assert.equal(Object.hasOwn(await status.json(), 'accessToken'), false)
  for (const path of ['/_host/voice?x=1', '/_host/voice?']) assert.equal((await fx.invoke({ path })).status, 404)
  assert.equal(fx.calls.provider.length, 0)
})

test('missing provider key or trusted dependencies fail closed without outbound requests', async () => {
  for (const key of [undefined, null, '', ' \t ', 123]) {
    const fx = fixture({ env: { DEEPGRAM_API_KEY: key } })
    await failure(await fx.invoke(), 503, 'SPEECH_PROVIDER_UNCONFIGURED')
    assert.equal(fx.calls.budget.length, 0)
    assert.equal(fx.calls.provider.length, 0)
  }
  for (const dependencies of [{ networkFetch: undefined }, { seedId: 'wrong' }, { env: { OWNER_EMAIL: ACCESS.email, DEEPGRAM_API_KEY: MASTER } }]) {
    const fx = fixture()
    await failure(await fx.direct({}, dependencies), 503, 'SPEECH_PROVIDER_UNAVAILABLE')
    assert.equal(fx.calls.provider.length, 0)
  }
})

test('budget acknowledgement is bounded, strict and fail closed; only valid rate limits return Retry-After', async () => {
  for (const budgetFetch of [
    async () => { throw new Error(MASTER) },
    () => Response.json({ ok: false, code: MASTER }, { status: 503 }),
    () => Response.json({ ok: true }), () => Response.json({ ok: true, remaining: -1 }),
    () => Response.json({ ok: true, remaining: 6 }), () => Response.json({ ok: true, remaining: '5' }),
    () => Response.json({ ok: false, code: 'SPEECH_PASS_RATE_LIMITED', retryAfterMs: 0 }, { status: 429 }),
    () => Response.json({ ok: false, code: 'SPEECH_PASS_RATE_LIMITED', retryAfterMs: 60001 }, { status: 429 }),
    () => new Response('x'.repeat(1025), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const fx = fixture({ budgetFetch })
    await failure(await fx.direct(), 503, 'SPEECH_PASS_BUDGET_UNAVAILABLE')
    assert.equal(fx.calls.provider.length, 0)
  }
  const fx = fixture({ budgetFetch: () => Response.json({ ok: false, code: 'SPEECH_PASS_RATE_LIMITED', retryAfterMs: 1001 }, { status: 429 }) })
  const limited = await fx.invoke()
  assert.equal(limited.headers.get('retry-after'), '2')
  await failure(limited, 429, 'SPEECH_PASS_RATE_LIMITED')
  assert.equal(fx.calls.provider.length, 0)
})

test('provider errors, redirects, credential echoes and malformed grants never expose master key or raw errors', async () => {
  for (const networkFetch of [
    async () => { throw Object.assign(new Error(MASTER), { code: MASTER }) },
    ...[301, 302, 307, 308, 401, 429, 500].map(status => () => new Response(MASTER, { status, headers: { location: 'https://foreign.invalid' } })),
    () => Object.defineProperty(grant(), 'redirected', { value: true }),
    ...[null, [], {}, { access_token: MASTER }, { access_token: 'prefix.' + MASTER + '.suffix' }, { access_token: '' },
      { access_token: 'a'.repeat(4097) }, { access_token: 'token with spaces' }, { access_token: 1 },
      ...[null, '30', 0, -1, 31, 1.5].map(expires_in => ({ access_token: token, expires_in }))].map(value => () => Response.json(value)),
  ]) {
    const fx = fixture({ networkFetch })
    await failure(await fx.invoke(), 502, 'SPEECH_PROVIDER_FAILED')
    assert.equal(fx.calls.provider.length, 1)
  }
  for (const expires_in of [undefined, 1, 30]) {
    const fx = fixture({ networkFetch: () => Response.json({ access_token: token, expires_in }) })
    assert.deepEqual(await (await fx.invoke()).json(), { ok: true, provider: 'deepgram', accessToken: token, expiresInSeconds: expires_in ?? 30 })
  }
})

test('grant bodies reject oversized, invalid UTF-8, non-JSON and declared-length payloads and cancel unread streams', async () => {
  for (const response of [
    new Response('x'.repeat(8193), { headers: { 'content-type': 'application/json' } }),
    new Response('é'.repeat(4097), { headers: { 'content-type': 'application/json' } }),
    new Response(Uint8Array.of(255), { headers: { 'content-type': 'application/json' } }),
    new Response('{"access_token":', { headers: { 'content-type': 'application/json' } }),
    new Response(null, { headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ access_token: token }), { headers: { 'content-type': 'text/plain' } }),
    ...['8193', '-1', 'invalid'].map(length => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': length } })),
  ]) await failure(await fixture({ networkFetch: () => response }).direct(), 502, 'SPEECH_PROVIDER_FAILED')
  let cancelled = false
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8193)) }, cancel() { cancelled = true } }), { headers: { 'content-type': 'application/json' } })
  await failure(await fixture({ networkFetch: () => response }).direct(), 502, 'SPEECH_PROVIDER_FAILED')
  assert.equal(cancelled, true)
})

for (const phase of ['budget-headers', 'budget-body', 'provider-headers', 'provider-body']) {
  test(`the 5-second deadline bounds ${phase}, even when transport or cancellation never settles`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const started = deferred()
    let signal, cancelled = false
    const stalled = (_url, init) => {
      signal = init?.signal ?? _url.signal
      if (phase.endsWith('headers')) { started.resolve(); return new Promise(() => {}) }
      return new Response(new ReadableStream({
        pull() { started.resolve(); return new Promise(() => {}) },
        cancel() { cancelled = true; return new Promise(() => {}) },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } })
    }
    const fx = fixture(phase.startsWith('budget') ? { budgetFetch: stalled } : { networkFetch: stalled })
    const pending = fx.direct()
    await started.promise
    t.mock.timers.tick(5000)
    await failure(await pending, 504, 'SPEECH_PROVIDER_TIMEOUT')
    assert.equal(signal.aborted, true)
    if (phase.endsWith('body')) assert.equal(cancelled, true)
    if (phase.startsWith('budget')) assert.equal(fx.calls.provider.length, 0)
  })
}

test('request cancellation prevents late grant delivery and cancels a late response body', async () => {
  const started = deferred(), release = deferred(), cancelled = deferred()
  const controller = new AbortController()
  let signal
  const fx = fixture({ networkFetch: (_url, init) => { signal = init.signal; started.resolve(); return release.promise } })
  const pending = fx.direct({ signal: controller.signal })
  await started.promise
  controller.abort()
  await failure(await pending, 499, 'SPEECH_REQUEST_CANCELLED')
  assert.equal(signal.aborted, true)
  release.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve() } }), { headers: { 'content-type': 'application/json' } }))
  await cancelled.promise
  const preAborted = fixture()
  await failure(await preAborted.direct({ signal: controller.signal }), 499, 'SPEECH_REQUEST_CANCELLED')
  assert.equal(preAborted.calls.budget.length, 0)
  assert.equal(preAborted.calls.provider.length, 0)
})

for (const phase of ['budget', 'provider']) {
  test(`caller abort cancels a stalled ${phase} body without converting a partial JSON grant to success`, async () => {
    const started = deferred()
    const controller = new AbortController()
    let signal, cancelled = false
    const stalled = (_url, init) => {
      signal = init?.signal ?? _url.signal
      let first = true
      return new Response(new ReadableStream({
        pull(stream) {
          if (first) {
            first = false
            stream.enqueue(new TextEncoder().encode(phase === 'budget' ? '{"ok":true,"remaining":5}' : JSON.stringify({ access_token: token, expires_in: 30 })))
          } else { started.resolve(); return new Promise(() => {}) }
        },
        cancel() { cancelled = true; return new Promise(() => {}) },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } })
    }
    const fx = fixture(phase === 'budget' ? { budgetFetch: stalled } : { networkFetch: stalled })
    const pending = fx.direct({ signal: controller.signal })
    await started.promise
    controller.abort()
    await failure(await pending, 499, 'SPEECH_REQUEST_CANCELLED')
    assert.equal(signal.aborted, true)
    assert.equal(cancelled, true)
    if (phase === 'budget') assert.equal(fx.calls.provider.length, 0)
  })
}

test('the Worker returns the same raw-payload refusal for all three stack trace families', async () => {
  const fx = fixture()
  for (const text of ['Error at fn(file.js:10:2)', 'Traceback (most recent call last):', "thread 'main' panicked at src/main.rs:10:2"]) {
    await failure(await fx.invoke({ body: { action: 'validate_clause', clause: { turnId: 'turn-1', text } } }), 400, 'VOICE_CLAUSE_RAW_PAYLOAD_REFUSED')
  }
  assert.equal(fx.calls.budget.length, 0)
  assert.equal(fx.calls.provider.length, 0)
})
