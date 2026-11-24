/** Synthetic request metadata only: no external network, credentials, filesystem or live state. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createEdgeDiagnostics, projectDiagnostics, EDGE_DIAGNOSTIC_LIMITS } from '../edge-diagnostics.mjs'
import { createWorker } from '../worker.mjs'
import { X61HeadDurableObject } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { handleCloudBroker } from '../cloud-brokers.mjs'

const ORIGIN = 'https://diagnostics.example.invalid', SEED = 'a'.repeat(64), BALL = 'b'.repeat(64)
const SECRET = 'SYNTHETIC_SECRET_MARKER'
const metadata = { seedId: SEED, ballId: BALL, epoch: 1 }
const bootstrap = { ready: true, head: { ...metadata, phase: 'complete' }, mirror: { ...metadata, phase: 'ready' } }
const noNetwork = () => assert.fail('No real network may be used')

function memoryStorage(initial) {
  const rows = new Map(structuredClone(initial)), reads = []
  const tx = {
    async get(key) { reads.push(key); return structuredClone(rows.get(key)) },
    async list({ prefix = '', limit = Infinity } = {}) { return new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) },
    async put() { assert.fail('Diagnostics must not write durable storage') },
  }
  return { ...tx, rows, reads, transaction: operation => operation(tx) }
}

function fixture({ paired = true } = {}) {
  const headStorage = memoryStorage([['bootstrap:v1', { ...metadata, phase: 'complete' }]])
  const mirrorStorage = memoryStorage([['mirror:bootstrap:v1', { ...metadata, seedId: paired ? SEED : 'c'.repeat(64), phase: 'ready', batchDigests: [], nextBatch: 0, entryCount: 0 }]])
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture', OWNER_EMAIL: 'owner@example.invalid', API_KEY: SECRET }
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env)
  const mirror = new MirrorDO({ storage: mirrorStorage }, env)
  for (const [name, object] of [['HEAD', head], ['MIRROR', mirror]]) env[name] = { idFromName: name => name, get: () => object }
  const worker = createWorker({ verifyAccess: async request => request.headers.get('x-test-owner') === 'yes', networkFetch: noNetwork })
  const request = (path, { input, headers = {}, method = input === undefined ? 'GET' : 'POST' } = {}) => {
    const values = new Headers({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-test-owner': 'yes', 'content-type': 'application/json' })
    for (const [key, value] of Object.entries(headers)) value === null ? values.delete(key) : values.set(key, value)
    return worker.fetch(new Request(ORIGIN + path, { method, headers: values, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }), env)
  }
  return { worker, request, head, mirror, headStorage, mirrorStorage, env }
}

test('ring keeps only finite metadata, never touching request or response payloads', async () => {
  let now = 100
  const ring = createEdgeDiagnostics('worker-isolate', () => now++)
  const request = { url: ORIGIN + '/' + SECRET + '?' + SECRET, method: SECRET,
    get body() { assert.fail('Request body inspected') }, get headers() { assert.fail('Headers inspected') } }
  const response = { status: 101, get body() { assert.fail('Response body inspected') }, clone() { assert.fail('Response cloned') } }
  assert.equal(await ring.observe(request, async () => response), response)
  await assert.rejects(ring.observe(request, () => { throw new Error(SECRET) }))
  const result = ring.snapshot()
  assert.deepEqual(result.events, [
    { at: 100, method: 'OTHER', pathname: '/:other', status: 101, code: 'HTTP_101', durationMs: 1 },
    { at: 102, method: 'OTHER', pathname: '/:other', status: 500, code: 'HTTP_500', durationMs: 1 },
  ])
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  assert.equal(result.ephemeral, true); assert.equal(result.durableAudit, false); assert.equal(result.browserNetwork, false)
})

test('ring caps events and duration, copies snapshots and remains per instance', async () => {
  let now = 0
  const ring = createEdgeDiagnostics('head-object-instance', () => now)
  for (let index = 0; index < 120; index++) {
    now = index
    await ring.observe(new Request(ORIGIN + '/_head/status?secret=' + SECRET), async () => ({ status: 200 }))
  }
  const result = ring.snapshot()
  assert.equal(result.events.length, 100); assert.equal(result.events[0].at, 20)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < EDGE_DIAGNOSTIC_LIMITS.bytes)
  result.events[0].pathname = SECRET; result.events.length = 0
  assert.equal(ring.snapshot().events.length, 100)
  assert.equal(createEdgeDiagnostics('head-object-instance').snapshot().events.length, 0)
  await ring.observe(new Request(ORIGIN + '/door/' + SECRET), async () => { now += 999999999; return { status: 503 } })
  assert.equal(ring.snapshot().events.at(-1).durationMs, EDGE_DIAGNOSTIC_LIMITS.durationMs)
  assert.equal(ring.snapshot().events.at(-1).pathname, '/door/:provider')
})

test('ring observes response readiness without reading streams or claiming later transfer success', async () => {
  let now = 10, streamController
  const ring = createEdgeDiagnostics('worker-isolate', () => now)
  const response = new Response(new ReadableStream({ start(controller) { streamController = controller } }), { status: 200 })
  assert.equal(await ring.observe(new Request(ORIGIN + '/_host/repo'), async () => { now = 13; return response }), response)
  assert.equal(response.bodyUsed, false)
  const snapshot = ring.snapshot()
  assert.equal(snapshot.events[0].status, 200); assert.equal(snapshot.events[0].durationMs, 3)
  now = 1000; streamController.error(new Error('Synthetic transfer failure after headers'))
  await assert.rejects(response.text(), /Synthetic transfer failure/)
  assert.deepEqual(ring.snapshot(), snapshot, 'The ring does not observe or claim later body completion')
})

test('snapshot projection rejects forged routes, status codes, scopes and unbounded events', async () => {
  const ring = createEdgeDiagnostics('worker-isolate', () => 1)
  await ring.observe(new Request(ORIGIN + '/_host/repo'), async () => ({ status: 403 }))
  for (const change of [{ pathname: '/' + SECRET }, { method: SECRET }, { code: SECRET }, { code: 'HTTP_200' }, { status: 600 }, { at: -1 }, { durationMs: Infinity }]) {
    const value = ring.snapshot(); Object.assign(value.events[0], change)
    assert.throws(() => projectDiagnostics(value, 'worker-isolate'))
  }
  for (const change of [{ scope: SECRET }, { ephemeral: false }, { browserNetwork: true }, { events: Array(101).fill(ring.snapshot().events[0]) }]) assert.throws(() => projectDiagnostics({ ...ring.snapshot(), ...change }, 'worker-isolate'))
  const value = ring.snapshot(); value.headers = SECRET; value.events[0].body = SECRET
  assert.equal(JSON.stringify(projectDiagnostics(value, 'worker-isolate')).includes(SECRET), false)
})

test('real Worker and both DOs expose safe independent diagnostics without durable writes or module reads', async () => {
  const cloud = fixture()
  await cloud.request('/arbitrary-' + SECRET + '?token=' + SECRET, { headers: { cookie: SECRET, authorization: SECRET } })
  await cloud.request('/_host/repo', { input: { action: SECRET, content: SECRET } })
  const response = await cloud.request('/_host/diagnostics')
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  const value = await response.json()
  assert.equal(value.ok, true); assert.equal(value.action, 'diagnostics')
  for (const [name, scope] of [['worker', 'worker-isolate'], ['head', 'head-object-instance'], ['mirror', 'mirror-object-instance']]) {
    assert.equal(value[name].state, 'available'); assert.equal(value[name].scope, scope)
    assert.ok(value[name].events.length > 0)
  }
  assert.equal(value.worker.events.some(event => event.pathname === '/_host/diagnostics'), false, 'In-flight retrieval is not yet in the completed ring')
  assert.equal(JSON.stringify(value).includes(SECRET), false)
  assert.ok(value.worker.events.some(event => event.pathname === '/:other'))
  const action = await cloud.request('/_host/repo', { input: { action: 'diagnostics' } })
  assert.equal(action.status, 200)
  assert.equal((await action.json()).worker.events.at(-1).pathname, '/_host/diagnostics')
  assert.equal([...cloud.headStorage.reads, ...cloud.mirrorStorage.reads].some(key => key.startsWith('module:') || key.startsWith('manifest:') || key.startsWith('mirror:v2:entry:')), false)
})

test('diagnostics preserves owner, same-origin, route, method, body and paired-bootstrap checks', async () => {
  const cloud = fixture()
  for (const [path, options, status] of [
    ['/_host/diagnostics', { headers: { 'x-test-owner': null } }, 401],
    ['/_host/diagnostics', { headers: { origin: 'https://other.invalid' } }, 403],
    ['/_host/diagnostics', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    ['/_host/diagnostics', { headers: { 'sec-fetch-site': null } }, 403],
    ['/_host/diagnostics', { headers: { referer: 'https://other.invalid/' } }, 403],
    ['/_host/diagnostics', { headers: { 'content-length': '1' } }, 400],
    ['/_host/diagnostics', { headers: { 'transfer-encoding': 'chunked' } }, 400],
    ['/_host/diagnostics', { input: { action: 'diagnostics' } }, 405],
    ['/_host/diagnostics?', {}, 404], ['/_host/diagnostics?token=x', {}, 404], ['/_host/diagnostics#x', {}, 404],
    ['/_host/repo', { input: { action: 'diagnostics', path: SECRET } }, 400],
  ]) assert.equal((await cloud.request(path, options)).status, status, path + JSON.stringify(options))
  assert.equal((await cloud.request('/_host/diagnostics', { headers: { origin: null } })).status, 200)
  assert.equal((await fixture({ paired: false }).request('/_host/diagnostics')).status, 503)
  assert.equal((await fixture({ paired: false }).request('/_host/repo', { input: { action: 'diagnostics' } })).status, 503)
})

test('internal diagnostics routes require matching bootstrap and do not become public routes', async () => {
  const cloud = fixture()
  for (const [object, path] of [[cloud.head, '/_head/diagnostics'], [cloud.mirror, '/_mirror/diagnostics']]) {
    assert.equal((await object.fetch(new Request(ORIGIN + path))).status, 401)
    assert.equal((await object.fetch(new Request(ORIGIN + path, { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': 'c'.repeat(64) } }))).status, 503)
    const headers = { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }
    assert.equal((await object.fetch(new Request(ORIGIN + path + '?x=y', { headers }))).status, 400)
    assert.equal((await object.fetch(new Request(ORIGIN + path, { method: 'POST', headers, body: SECRET }))).status, 400)
    assert.equal((await cloud.request(path, { headers })).status, 501)
  }
})

test('broker isolates invalid or missing diagnostic snapshots without echoing binding errors', async () => {
  const ring = createEdgeDiagnostics('worker-isolate')
  const request = () => new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'diagnostics' }) })
  const options = { bootstrap, networkFetch: noNetwork, diagnostics: ring.snapshot }
  for (const behavior of [() => { throw new Error(SECRET) }, () => Response.json({ ok: true, ...ring.snapshot(), events: [{ pathname: SECRET }] }), () => Response.json({ ok: true, body: SECRET.repeat(4000) })]) {
    const binding = { idFromName: value => value, get: () => ({ fetch: behavior }) }
    const response = await handleCloudBroker(request(), { HEAD: binding, MIRROR: binding }, options)
    assert.equal(response.status, 503)
    const value = await response.json()
    assert.equal(value.code, 'DIAGNOSTICS_INCOMPLETE'); assert.equal(value.worker.state, 'available')
    assert.deepEqual(value.head, { state: 'unavailable', code: 'DIAGNOSTICS_UNAVAILABLE' })
    assert.equal(JSON.stringify(value).includes(SECRET), false)
  }
  assert.equal((await handleCloudBroker(request(), {}, { ...options, bootstrap: { ready: false } })).status, 503)
})
