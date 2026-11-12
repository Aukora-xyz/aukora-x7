import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLOUD_BROKER_LIMITS, handleCloudBroker } from '../cloud-brokers.mjs'
import { createTrustedDocsHttpsTransport, TRUSTED_DOCS_HTTPS_ORIGINS } from '../public-https-transport.mjs'

const target = 'https://api.github.com/repos/example/project'
const publicHost = 'x61.example.com'
const plain = (body = 'public fixture', headers = {}) => new Response(body, { headers: { 'content-type': 'text/plain', ...headers } })
const create = (networkFetch, options = {}) => createTrustedDocsHttpsTransport({ networkFetch, publicHost, ...options })

test('fixed docs transport admits exactly four immutable origins and canonical numeric GitHub pagination', async () => {
  const calls = [], transport = create(async (url, init) => { calls.push({ url, init }); return plain() })
  assert.equal(Object.isFrozen(TRUSTED_DOCS_HTTPS_ORIGINS), true)
  assert.deepEqual(TRUSTED_DOCS_HTTPS_ORIGINS, ['https://api.github.com', 'https://developers.cloudflare.com', 'https://developer.mozilla.org', 'https://registry.npmjs.org'])
  assert.throws(() => TRUSTED_DOCS_HTTPS_ORIGINS.push('https://example.com'))
  for (const origin of TRUSTED_DOCS_HTTPS_ORIGINS) assert.equal(await (await transport(origin + '/docs')).text(), 'public fixture')
  await transport(target + '?page=1000&per_page=100')
  assert.equal(calls.length, 5)
  assert.equal(calls[4].url, target + '?page=1000&per_page=100')
})

test('fixed docs transport refuses noncanonical, private, credential-bearing, own and unlisted destinations before dispatch', async () => {
  let calls = 0
  const transport = create(async () => { calls++; return plain() })
  for (const value of [
    'http://api.github.com/', 'https://api.github.com:444/', 'https://user:pass@api.github.com/',
    'https://api.github.com/#fragment', 'https://api.github.com/#', 'https://api.github.com', 'https://API.GITHUB.COM/',
    'https://api.github.com./', 'https://api.github.com:443/', 'https://%61pi.github.com/',
    'https://example.com/', 'https://evil.api.github.com/', 'https://api.github.com.evil.com/',
    'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://169.254.169.254/',
    'https://host.local/', 'https://host.internal/', `https://${publicHost}/`,
  ]) await assert.rejects(transport(value), undefined, value)
  assert.equal(calls, 0)
  await assert.rejects(create(() => assert.fail(), { publicHost: 'api.github.com' })(target), { code: 'TRUSTED_DOCS_ORIGIN_REFUSED' })
  await assert.rejects(create(() => assert.fail(), { publicHost: 'api.github.com.' })(target), { code: 'TRUSTED_DOCS_ORIGIN_REFUSED' })
  await assert.rejects(create(() => assert.fail(), { allowedOrigins: ['https://example.com'] })('https://example.com/'), { code: 'TRUSTED_DOCS_ORIGIN_REFUSED' })
})

test('fixed docs transport refuses query aliases, duplicate pagination, auth, search text and docs/npm queries', async () => {
  let calls = 0
  const transport = create(async () => { calls++; return plain() })
  for (const suffix of ['?', '?page=0', '?page=1001', '?per_page=101', '?page=01', '?page=1&page=2', '?Page=1', '?%70age=1', '?page=%31', '?page=1&', '?page=1#', '?page=1.0', '?page=1e2', '?q=secret', '?access_token=secret', '?url=https%3A%2F%2Flocalhost']) {
    await assert.rejects(transport(target + suffix), undefined, suffix)
  }
  for (const origin of TRUSTED_DOCS_HTTPS_ORIGINS.slice(1)) await assert.rejects(transport(origin + '/?page=1'), { code: 'TRUSTED_DOCS_QUERY_REFUSED' })
  assert.equal(calls, 0)
})

test('fixed docs transport fixes GET, omits credentials, drops caller headers and projects only bounded response headers', async () => {
  let sent
  const transport = create(async (_url, init) => { sent = init; return plain('fixture', { 'set-cookie': 'secret', authorization: 'secret', location: 'https://evil.com', 'x-private': 'secret' }) })
  const response = await transport(target, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { authorization: 'Bearer secret', cookie: 'private', host: 'localhost', 'x-forwarded-host': 'localhost', 'cf-access-jwt-assertion': 'secret' } })
  assert.equal(sent.method, 'GET'); assert.equal(sent.redirect, 'manual'); assert.equal(sent.credentials, 'omit')
  assert.equal(sent.referrer, ''); assert.equal(sent.referrerPolicy, 'no-referrer'); assert.equal(sent.cache, 'no-store')
  assert.deepEqual(sent.headers, { accept: 'text/html, text/plain, application/json, application/xhtml+xml', 'accept-encoding': 'identity', 'user-agent': 'your-node-trusted-docs' })
  assert.deepEqual([...response.headers.keys()].sort(), ['cache-control', 'content-length', 'content-type'])
  assert.equal(await response.text(), 'fixture')
})

test('fixed docs transport rejects methods, redirect/credential changes and arbitrary platform options before dispatch', async () => {
  const transport = create(() => assert.fail('Invalid options must not dispatch'))
  for (const init of [{ method: 'POST' }, { method: 'HEAD' }, { redirect: 'follow' }, { redirect: 'error' }, { credentials: 'include' }, { body: 'secret' }, { cf: { resolveOverride: 'localhost' } }, { dispatcher: {} }, { signal: null }, null, []]) {
    await assert.rejects(transport(target, init), { code: 'WEB_EYES_REQUEST_INVALID' })
  }
  for (const options of [{}, { networkFetch: async () => plain() }, { networkFetch: async () => plain(), publicHost, timeoutMs: 10001 }, { networkFetch: async () => plain(), publicHost, timeoutMs: 0 }]) assert.throws(() => createTrustedDocsHttpsTransport(options))
})

test('fixed docs transport accepts private/reserved application hosts only as refusal identities', async () => {
  for (const ownHost of ['messages-fixture.example.invalid', 'app.internal', 'localhost']) {
    let calls = 0
    const transport = create(async () => { calls++; return plain() }, { publicHost: ownHost })
    assert.equal(await (await transport(target)).text(), 'public fixture')
    await assert.rejects(transport(`https://${ownHost}/`))
    assert.equal(calls, 1)
  }
  for (const ownHost of ['', 'host..invalid', '-bad.invalid', 'https://app.example', 'app.example:443', 'user@app.example']) assert.throws(() => create(async () => plain(), { publicHost: ownHost }))
})

test('fixed docs transport refuses every redirect and unexpected final URL without a second request', async () => {
  for (const status of [300, 301, 302, 303, 304, 307, 308]) {
    let calls = 0, cancelled = false
    const transport = create(async () => {
      calls++
      return new Response(status === 304 ? null : new ReadableStream({ cancel() { cancelled = true } }), { status, headers: { location: 'https://127.0.0.1/' } })
    })
    await assert.rejects(transport(target), { code: 'WEB_EYES_REDIRECT_REFUSED' })
    assert.equal(calls, 1); if (status !== 304) assert.equal(cancelled, true)
  }
  for (const property of ['redirected', 'url']) {
    const response = plain()
    Object.defineProperty(response, property, { value: property === 'redirected' ? true : 'https://evil.com/' })
    await assert.rejects(create(async () => response)(target), { code: 'WEB_EYES_REDIRECT_REFUSED' })
  }
})

test('fixed docs transport enforces actual and declared byte ceilings and complete bodies', async () => {
  assert.equal((await (await create(async () => plain('x'.repeat(CLOUD_BROKER_LIMITS.responseBytes)))(target)).arrayBuffer()).byteLength, CLOUD_BROKER_LIMITS.responseBytes)
  for (const [body, headers, code] of [
    ['x'.repeat(CLOUD_BROKER_LIMITS.responseBytes + 1), {}, 'WEB_EYES_BODY_TOO_LARGE'],
    ['x', { 'content-length': String(CLOUD_BROKER_LIMITS.responseBytes + 1) }, 'WEB_EYES_BODY_TOO_LARGE'],
    ['x', { 'content-length': '2' }, 'WEB_EYES_BODY_INVALID'],
    ['xx', { 'content-length': '1' }, 'WEB_EYES_BODY_INVALID'],
    ['x', { 'content-length': '-1' }, 'WEB_EYES_BODY_INVALID'],
    ['x', { 'content-length': '01' }, 'WEB_EYES_BODY_INVALID'],
    ['x', { 'content-length': '1, 1' }, 'WEB_EYES_BODY_INVALID'],
    ['x', { 'content-length': '9007199254740992' }, 'WEB_EYES_BODY_INVALID'],
  ]) await assert.rejects(create(async () => plain(body, headers))(target), { code })
  let cancelled = false, signal
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(CLOUD_BROKER_LIMITS.responseBytes)); controller.enqueue(Uint8Array.of(120)) }, cancel() { cancelled = true } })
  await assert.rejects(create(async (_url, init) => { signal = init.signal; return plain(body) })(target), { code: 'WEB_EYES_BODY_TOO_LARGE' })
  assert.equal(cancelled, true); assert.equal(signal.aborted, true)
})

test('fixed docs transport accepts allowed text types and refuses binary, compression, invalid UTF-8 and NUL', async () => {
  for (const type of ['text/plain', 'text/html; charset=utf-8', 'application/json', 'application/xhtml+xml']) assert.equal(await (await create(async () => plain('fixture', { 'content-type': type }))(target)).text(), 'fixture')
  for (const [body, headers, code] of [
    ['x', { 'content-type': 'application/octet-stream' }, 'WEB_EYES_CONTENT_TYPE_REFUSED'],
    ['x', { 'content-type': 'image/svg+xml' }, 'WEB_EYES_CONTENT_TYPE_REFUSED'],
    ['x', { 'content-type': 'text/plainx' }, 'WEB_EYES_CONTENT_TYPE_REFUSED'],
    ['x', { 'content-type': 'text/plain;' + 'x'.repeat(256) }, 'WEB_EYES_CONTENT_TYPE_REFUSED'],
    ['x', { 'content-encoding': 'gzip' }, 'WEB_EYES_CONTENT_TYPE_REFUSED'],
    [Uint8Array.of(255), {}, 'WEB_EYES_ENCODING_INVALID'],
    ['x\u0000', {}, 'WEB_EYES_ENCODING_INVALID'],
  ]) await assert.rejects(create(async () => plain(body, headers))(target), { code })
})

test('fixed docs transport aborts before dispatch and cancels late fetch responses', async () => {
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(create(() => assert.fail('Pre-aborted fetch must not dispatch'))(target, { signal: aborted.signal }), { code: 'WEB_EYES_TIMEOUT' })
  let resolveFetch, sentSignal, cancelled = false
  const controller = new AbortController()
  const pending = create((_url, init) => { sentSignal = init.signal; return new Promise(resolve => { resolveFetch = resolve }) })(target, { signal: controller.signal })
  await Promise.resolve(); controller.abort()
  await assert.rejects(pending, { code: 'WEB_EYES_TIMEOUT' }); assert.equal(sentSignal.aborted, true)
  resolveFetch(plain(new ReadableStream({ cancel() { cancelled = true } })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
})

test('fixed docs transport times out stalled fetch and body with cancellation', async () => {
  let signal
  await assert.rejects(create((_url, init) => { signal = init.signal; return new Promise(() => {}) }, { timeoutMs: 5 })(target), { code: 'WEB_EYES_TIMEOUT' })
  assert.equal(signal.aborted, true)
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  await assert.rejects(create(async (_url, init) => { signal = init.signal; return plain(body) }, { timeoutMs: 5 })(target), { code: 'WEB_EYES_TIMEOUT' })
  assert.equal(signal.aborted, true); assert.equal(cancelled, true)
})

test('fixed docs transport checks deadlines at headers and complete-body boundaries even before timer callbacks', async () => {
  for (const stage of ['headers', 'body']) {
    let elapsed = 0, signal
    const transport = create(async (_url, init) => {
      signal = init.signal
      if (stage === 'headers') { elapsed = 10000; return plain() }
      return plain(new ReadableStream({ pull(controller) { elapsed = 10000; controller.enqueue(Uint8Array.of(120)); controller.close() } }))
    }, { now: () => elapsed })
    await assert.rejects(transport(target), { code: 'WEB_EYES_TIMEOUT' }); assert.equal(signal.aborted, true)
  }
})

test('fixed docs transport suppresses upstream failures and never retries', async () => {
  let calls = 0
  await assert.rejects(create(async () => { calls++; throw new Error('private upstream detail') })(target), { code: 'WEB_EYES_UPSTREAM_FAILED', message: 'WEB_EYES_UPSTREAM_FAILED' })
  assert.equal(calls, 1)
  await assert.rejects(create(async () => new Response('private upstream detail', { status: 500 }))(target), { code: 'WEB_EYES_UPSTREAM_FAILED' })
  await assert.rejects(create(async () => plain(null))(target), { code: 'WEB_EYES_BODY_INVALID' })
  await assert.rejects(create(async () => ({ body: {} }))(target), { code: 'WEB_EYES_UPSTREAM_FAILED' })
  await assert.rejects(create(async () => plain(new ReadableStream({ start(controller) { controller.error(new Error('private stream detail')) } })))(target), { code: 'WEB_EYES_UPSTREAM_FAILED', message: 'WEB_EYES_UPSTREAM_FAILED' })
})

test('fixed docs transport cancels an active body on caller abort and releases the reader', async () => {
  let beginRead, cancelled = false, signal
  const reading = new Promise(resolve => { beginRead = resolve })
  const body = new ReadableStream({ pull() { beginRead() }, cancel() { cancelled = true } })
  const controller = new AbortController()
  const pending = create(async (_url, init) => { signal = init.signal; return plain(body) })(target, { signal: controller.signal })
  await reading; controller.abort()
  await assert.rejects(pending, { code: 'WEB_EYES_TIMEOUT' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(signal.aborted, true); assert.equal(cancelled, true); assert.equal(body.locked, false)
})

test('broker screens raw and encoded secret paths before fixed-provider dispatch and scrubs returned text', async () => {
  const origin = `https://${publicHost}`, secret = 'synthetic-configured-secret'
  let calls = 0, output = 'public fixture'
  const networkFetch = async () => { calls++; return plain(output) }
  const trustedDocsHttpsFetch = create(networkFetch)
  const request = url => handleCloudBroker(new Request(origin + '/_host/web-eyes', {
    method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'fetch', url }),
  }), { PUBLIC_HOST: publicHost, GITHUB_TOKEN: secret }, { networkFetch, trustedDocsHttpsFetch })
  const allowed = await (await request(target)).json()
  assert.equal(allowed.ok, true); assert.equal(allowed.capability, 'trusted-docs-fetch'); assert.equal(calls, 1)
  const encoded = [...secret].map(char => '%' + char.charCodeAt(0).toString(16)).join('')
  for (const suffix of [secret, encoded, encodeURIComponent(encoded), 'ghp_' + 'x'.repeat(30)]) {
    const response = await request(target + '/' + suffix)
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'BROKER_PRIVATE_CONTENT_REFUSED')
    assert.equal(calls, 1)
  }
  const credentialQuery = await request(target + '?access_token=secret')
  assert.equal(credentialQuery.status, 403); assert.equal(calls, 1)
  output = secret
  const refused = await request(target)
  assert.equal(refused.status, 403); assert.equal((await refused.json()).code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  assert.equal(calls, 2)
})
