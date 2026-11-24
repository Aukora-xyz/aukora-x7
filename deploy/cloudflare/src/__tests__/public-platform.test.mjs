/** Offline platform-adapter tests. Stubbed global fetch does not prove production DNS/IP enforcement. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlatformPublicHttpsTransport, platformPublicHttpsAvailable } from '../public-https-transport.mjs'
import { createWorker } from '../worker.mjs'
import { CLOUD_BROKER_LIMITS } from '../cloud-brokers.mjs'

const ORIGIN = 'https://public-fixture.example.invalid', PUBLIC_HOST = new URL(ORIGIN).host
const flags = { global_fetch_strictly_public: true, no_cots_on_external_fetch: true }
const plain = (body = 'Public fixture', headers = {}) => new Response(body, { headers: { 'content-type': 'text/plain', ...headers } })
const target = 'https://public.example.com/article?q=bounded'

function platform(t, value, fetch) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'Cloudflare'), oldFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'Cloudflare', { configurable: true, value })
  globalThis.fetch = fetch
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'Cloudflare', saved); else delete globalThis.Cloudflare; globalThis.fetch = oldFetch })
}

function fixture() {
  const seedId = 'a'.repeat(64), ballId = 'b'.repeat(64)
  const env = { PUBLIC_HOST, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture', OWNER_EMAIL: 'owner@example.invalid',
    API_KEY: 'synthetic-platform-secret', OWNER_ED25519_SECRET_KEY: 'synthetic-signing-secret', global_fetch_strictly_public: true, no_cots_on_external_fetch: true }
  const binding = name => ({ idFromName: value => value, get: () => ({ async fetch(request) {
    const path = new URL(request.url).pathname
    if (path.endsWith('bootstrap-status')) return Response.json({ ok: true, seedId, ballId, epoch: 1, phase: name === 'HEAD' ? 'complete' : 'ready' })
    if (path === '/_head/status') return Response.json({ ok: true, ballId, epoch: 1, governancePromotion: false })
    if (path === '/_mirror/status') return Response.json({ ok: true, lineageId: '11111111-1111-4111-8111-111111111111', revision: 1 })
    if (path === '/_host/aumlok/status') return Response.json({ ok: true, phase: 'UNBOUND', bound: false, enrollmentAvailable: false })
    assert.fail('Unexpected binding read')
  } }) })
  env.HEAD = binding('HEAD'); env.MIRROR = binding('MIRROR')
  const worker = createWorker({ verifyAccess: async request => request.headers.get('x-test-owner') === 'yes', networkFetch: () => assert.fail('Public reads must not use an injected or privileged binding fetch') })
  const request = (path, input, headers = {}) => worker.fetch(new Request(ORIGIN + path, { method: input === undefined ? 'GET' : 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-test-owner': 'yes', 'content-type': 'application/json', ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) }), env)
  return { request, env }
}

test('public platform transport requires both actual enable flags and ignores environment permission claims', async t => {
  platform(t, undefined, () => assert.fail('Missing platform must not fetch'))
  for (const value of [undefined, {}, { compatibilityFlags: {} }, { compatibilityFlags: { ...flags, global_fetch_strictly_public: false } },
    { compatibilityFlags: { global_fetch_strictly_public: true, cots_on_external_fetch: false } },
    { compatibilityFlags: { ...flags, no_cots_on_external_fetch: 'true' } }]) {
    Object.defineProperty(globalThis, 'Cloudflare', { configurable: true, value })
    assert.equal(platformPublicHttpsAvailable(), false)
    assert.equal(createPlatformPublicHttpsTransport({ publicHost: PUBLIC_HOST }), null)
  }
  const cloud = fixture()
  const health = await (await cloud.request('/api/health')).json()
  assert.equal(health.capabilities.publicWebFetch, false)
  assert.equal(health.capabilities.publicWebNetworkPolicy, null)
  assert.ok(health.unsupported.includes('public-web-fetch'))
  const denied = await cloud.request('/_host/web-eyes', { action: 'fetch', url: target })
  assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'TRUSTED_DOCS_ORIGIN_REFUSED')
})

test('flagged public reads use captured global fetch with fixed anonymous options, not supplied egress', async t => {
  const calls = []
  platform(t, { compatibilityFlags: Object.freeze({ ...flags }) }, async (url, init) => { calls.push({ url, init }); return plain('Fixture', { 'set-cookie': 'private', authorization: 'private' }) })
  assert.equal(platformPublicHttpsAvailable(), true)
  assert.throws(() => createPlatformPublicHttpsTransport({ publicHost: PUBLIC_HOST, networkFetch: () => assert.fail() }))
  const transport = createPlatformPublicHttpsTransport({ publicHost: PUBLIC_HOST })
  assert.equal(transport.networkPolicy, 'cloudflare-global-fetch-strictly-public')
  const response = await transport(target, { method: 'GET', credentials: 'omit', redirect: 'manual', headers: { cookie: 'private', authorization: 'private', host: 'localhost' } })
  assert.equal(calls.length, 1); assert.equal(calls[0].url, target)
  assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.redirect, 'manual')
  assert.equal(calls[0].init.referrer, ''); assert.equal(calls[0].init.referrerPolicy, 'no-referrer')
  assert.deepEqual(calls[0].init.headers, { accept: 'text/html, text/plain, application/json, application/xhtml+xml', 'accept-encoding': 'identity', 'user-agent': 'your-node-trusted-docs' })
  assert.equal(response.headers.has('set-cookie'), false); assert.equal(response.headers.has('authorization'), false)
  Object.defineProperty(globalThis, 'Cloudflare', { configurable: true, value: { compatibilityFlags: {} } })
  await assert.rejects(transport(target), { code: 'PUBLIC_NETWORK_GUARD_UNAVAILABLE' })
  assert.equal(calls.length, 1)
})

test('public platform policy refuses direct private/credential targets and never follows redirects', async t => {
  let calls = 0
  platform(t, { compatibilityFlags: flags }, async () => { calls++; return new Response('Redirect', { status: 302, headers: { location: 'https://127.0.0.1/' } }) })
  const transport = createPlatformPublicHttpsTransport({ publicHost: PUBLIC_HOST })
  for (const url of ['http://example.com/', 'https://127.0.0.1/', 'https://169.254.169.254/', 'https://[::1]/', 'https://host.local/', 'https://metadata.google.internal/',
    'https://user:pass@example.com/', 'https://example.com:444/', 'https://example.com/#fragment', ORIGIN + '/']) await assert.rejects(transport(url))
  for (const init of [{ method: 'POST' }, { credentials: 'include' }, { redirect: 'follow' }, { cf: { resolveOverride: 'private' } }, { body: 'private' }]) await assert.rejects(transport(target, init))
  assert.equal(calls, 0)
  await assert.rejects(transport(target), { code: 'WEB_EYES_REDIRECT_REFUSED' }); assert.equal(calls, 1)
})

test('public adapter shares complete-body byte, type, encoding and cancellation limits', async t => {
  let response = plain(), signal
  platform(t, { compatibilityFlags: flags }, async (_url, init) => { signal = init.signal; return response })
  const transport = createPlatformPublicHttpsTransport({ publicHost: PUBLIC_HOST, timeoutMs: 5 })
  for (const [value, code] of [
    [plain('x'.repeat(CLOUD_BROKER_LIMITS.responseBytes + 1)), 'WEB_EYES_BODY_TOO_LARGE'],
    [plain('x', { 'content-length': '2' }), 'WEB_EYES_BODY_INVALID'],
    [plain('x', { 'content-type': 'image/png' }), 'WEB_EYES_CONTENT_TYPE_REFUSED'],
    [plain('x', { 'content-encoding': 'gzip' }), 'WEB_EYES_CONTENT_TYPE_REFUSED'],
    [plain(Uint8Array.of(255)), 'WEB_EYES_ENCODING_INVALID'],
  ]) { response = value; await assert.rejects(transport(target), { code }) }
  let cancelled = false
  response = plain(new ReadableStream({ cancel() { cancelled = true } }))
  await assert.rejects(transport(target), { code: 'WEB_EYES_TIMEOUT' })
  assert.equal(signal.aborted, true); assert.equal(cancelled, true)
})

test('real Worker advertises platform public reads honestly and screens secrets before and after egress', async t => {
  let calls = 0, output = 'Public fixture'
  platform(t, { compatibilityFlags: flags }, async () => { calls++; return plain(output) })
  const cloud = fixture()
  const health = await (await cloud.request('/api/health')).json()
  assert.equal(health.capabilities.publicWebFetch, true)
  assert.equal(health.capabilities.publicWebNetworkPolicy, 'cloudflare-global-fetch-strictly-public')
  assert.equal(health.unsupported.includes('public-web-fetch'), false)
  assert.equal((await (await cloud.request('/_host/selftest')).json()).brokers.webEyesConfigured, true)
  const fetched = await (await cloud.request('/_host/web-eyes', { action: 'fetch', url: target })).json()
  assert.equal(fetched.ok, true); assert.equal(fetched.capability, 'public-web-fetch')
  assert.equal(fetched.networkPolicy, 'cloudflare-global-fetch-strictly-public'); assert.equal(calls, 1)
  const secret = cloud.env.API_KEY, encoded = [...secret].map(char => '%' + char.charCodeAt(0).toString(16)).join('')
  for (const url of ['https://example.com/' + secret, 'https://example.com/' + encoded, 'https://example.com/' + cloud.env.OWNER_ED25519_SECRET_KEY, 'https://example.com/?access_token=fixture']) assert.equal((await cloud.request('/_host/web-eyes', { action: 'fetch', url })).status, 403)
  assert.equal((await cloud.request('/_host/web-eyes', { action: 'fetch', url: target }, { 'x-test-owner': 'no' })).status, 401)
  assert.equal((await cloud.request('/_host/web-eyes', { action: 'fetch', url: target }, { origin: 'https://foreign.invalid' })).status, 403)
  assert.equal(calls, 1)
  output = secret
  const refused = await cloud.request('/_host/web-eyes', { action: 'fetch', url: target })
  assert.equal(refused.status, 403); assert.equal((await refused.json()).code, 'BROKER_PRIVATE_CONTENT_REFUSED'); assert.equal(calls, 2)
  output = cloud.env.OWNER_ED25519_SECRET_KEY
  assert.equal((await cloud.request('/_host/web-eyes', { action: 'fetch', url: target })).status, 403)
})
