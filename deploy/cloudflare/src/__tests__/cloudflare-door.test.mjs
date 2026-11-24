/** Her Cloudflare door reaches the whole account. Synthetic fixtures only: no real Cloudflare, no real
 * key, no network, no durable state. The fake Cloudflare below answers only the ids it lists. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { handleCloudBroker } from '../cloud-brokers.mjs'
import { bodyCarriesCredential, boundStorageIds, cloudflareAnswerCarriesCredential, cloudflareUrlsInText, classifyCloudflareRequest, cloudflareProtectionOf, cloudflareProtectionShape, cloudflareStagedBytes, CLOUDFLARE_BINDING_PLAIN, CLOUDFLARE_BINDING_TYPES, CLOUDFLARE_STAGED_SCHEMA, cloudflareAsksAt, cloudflareAuth, cloudflareAuthKind, cloudflareDoorLevel, cloudflareDoorStatus, credentialShaped, liveWorkerFacts, normalHost, CLOUDFLARE_ACCOUNT_OPEN, CLOUDFLARE_CHARGES, CLOUDFLARE_CREDENTIAL_VOCABULARY, CLOUDFLARE_PROTECTED_FAMILIES, CLOUDFLARE_CORE, CLOUDFLARE_DOOR_LEVEL_TABLE, CLOUDFLARE_DOOR_LEVELS, CLOUDFLARE_ANSWER_ALLOWED, CLOUDFLARE_BOUND_KINDS, CLOUDFLARE_DOOR_LIMITS, CLOUDFLARE_LIVE_HOME, CLOUDFLARE_NEXT, CLOUDFLARE_PROTECTED_REASONS } from '../cloudflare-door.mjs'
import { CLOUD_BROKER_LIMITS } from '../cloud-brokers.mjs'

const ORIGIN = 'https://fixture.example', NOW = 100000, API = 'https://api.cloudflare.com/client/v4'
const ACCOUNT = '0123456789abcdef0123456789abcdef', LIVE = 'f'.repeat(32), OTHER = 'e'.repeat(32)
const KEY = 'synthetic-global-key-fixture-0000', EMAIL = 'owner@example.org'
const digest = value => createHash('sha256').update(value).digest('hex')
const bootstrap = { ready: true, head: { phase: 'complete', seedId: 'synthetic-seed' }, mirror: { phase: 'ready' } }
const env = (extra = {}) => ({ CLOUDFLARE_API_TOKEN: KEY, CLOUDFLARE_EMAIL: EMAIL, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, SOURCE_REVISION: 'a'.repeat(40), ...extra })
const api = (method, path, more = {}) => ({ action: 'api', method, path, ...more })

// What the fake Cloudflare knows: her zone and another, a record and a route on hers, two custom domains, two Workers by id.
const FACTS = {
  [`/zones/${LIVE}`]: { id: LIVE, name: 'example.invalid' },
  [`/zones/${OTHER}`]: { id: OTHER, name: 'example.org' },
  [`/zones/${LIVE}/dns_records/rec-live`]: { id: 'rec-live', name: 'node.example.invalid', type: 'CNAME' },
  [`/zones/${LIVE}/dns_records/rec-docs`]: { id: 'rec-docs', name: 'docs.example.invalid', type: 'CNAME' },
  [`/zones/${LIVE}/workers/routes/route-live`]: { id: 'route-live', pattern: 'node.example.invalid/*', script: 'your-node' },
  [`/zones/${LIVE}/workers/routes/route-docs`]: { id: 'route-docs', pattern: 'docs.example.invalid/*', script: 'docs-site' },
  [`/accounts/${ACCOUNT}/workers/domains/dom-live`]: { id: 'dom-live', hostname: 'node.example.invalid', service: 'your-node' },
  [`/accounts/${ACCOUNT}/workers/domains/dom-docs`]: { id: 'dom-docs', hostname: 'docs.example.org', service: 'docs-site' },
  [`/accounts/${ACCOUNT}/workers/workers/0a1b2c`]: { id: '0a1b2c', name: 'your-node' },
  [`/accounts/${ACCOUNT}/workers/workers/9f8e7d`]: { id: '9f8e7d', name: 'hello-world' },
  // Job 7: the products a write reaches through a relation. Pages projects (none on the live zone but `live-site`),
  // load-balancer references, tunnel configurations.
  [`/accounts/${ACCOUNT}/pages/projects/demo`]: { name: 'demo', domains: ['demo.pages.dev'], deployment_configs: { production: { env_vars: { AUTH: { type: 'secret_text' }, MODE: { type: 'plain_text', value: 'x' } } } } },
  [`/accounts/${ACCOUNT}/pages/projects/helper`]: { name: 'helper', domains: ['helper.pages.dev'] },
  [`/accounts/${ACCOUNT}/pages/projects/p`]: { name: 'p', domains: ['p.pages.dev'] },
  [`/accounts/${ACCOUNT}/pages/projects/live-site`]: { name: 'live-site', domains: ['live-site.pages.dev', 'www.example.invalid'] },
  [`/accounts/${ACCOUNT}/load_balancers/pools/pool1/references`]: [{ reference_type: 'referrer', resource_id: 'lb1', resource_name: 'lb.example.org', resource_type: 'load_balancer' }],
  [`/accounts/${ACCOUNT}/load_balancers/pools/pool-live/references`]: [{ reference_type: 'referrer', resource_id: 'lb2', resource_name: 'app.example.invalid', resource_type: 'load_balancer' }],
  [`/accounts/${ACCOUNT}/load_balancers/monitors/mon1/references`]: [{ reference_type: 'referrer', resource_id: 'pool1', resource_name: 'pool-a', resource_type: 'pool' }],
  [`/accounts/${ACCOUNT}/cfd_tunnel/t1/configurations`]: { tunnel_id: 't1', source: 'cloudflare', config: { ingress: [{ hostname: 'tools.example.org', service: 'http://localhost:8080' }, { service: 'http_status:404' }] } },
  [`/accounts/${ACCOUNT}/cfd_tunnel/t-live/configurations`]: { tunnel_id: 't-live', source: 'cloudflare', config: { ingress: [{ hostname: 'api.example.invalid', service: 'http://localhost:8080' }] } },
  [`/accounts/${ACCOUNT}/cfd_tunnel/t-local/configurations`]: { tunnel_id: 't-local', source: 'local', config: null },
  // Job 7: Worker custom domains whose lookup carries their zone; queues by id.
  [`/accounts/${ACCOUNT}/workers/domains/dom-sibling`]: { id: 'dom-sibling', hostname: 'docs.example.invalid', service: 'docs', zone_id: LIVE, zone_name: 'example.invalid' },
  [`/accounts/${ACCOUNT}/workers/domains/dom-zone`]: { id: 'dom-zone', hostname: 'weird.example.net', service: 'docs', zone_id: LIVE, zone_name: 'example.invalid' },
  [`/accounts/${ACCOUNT}/queues/${'9'.repeat(32)}`]: { queue_id: '9'.repeat(32), queue_name: 'live-tasks', consumers: [] },
  [`/accounts/${ACCOUNT}/queues/${'8'.repeat(32)}`]: { queue_id: '8'.repeat(32), queue_name: 'jobs', consumers: [{ type: 'worker', script: 'your-node' }] },
  [`/accounts/${ACCOUNT}/queues/${'7'.repeat(32)}`]: { queue_id: '7'.repeat(32), queue_name: 'jobs-other', consumers: [{ type: 'worker', script: 'notes-site' }] },
}
// Job 7: the zones the fake account has, by name (GET /zones?name=<name>), for the live zone's id.
const ZONE_LIST = { 'example.invalid': { id: LIVE, name: 'example.invalid' }, 'example.org': { id: OTHER, name: 'example.org' } }

// Job 3: the Durable Object namespaces the fake Cloudflare lists. Made-up ids only.
const HEAD_NS = '5ead0000000000000000000000000a01', MIRROR_NS = '5ead0000000000000000000000000a02', VOICE_NS = '5ead0000000000000000000000000a04'
const WITNESS_NS = '5ead0000000000000000000000000a05', OTHER_NS = '0123456789abcdef0123456789aaaa03'
const NAMESPACES = { success: true, errors: [], messages: [], result_info: { page: 1, per_page: 1000, count: 5, total_count: 5, total_pages: 1 }, result: [
  { id: HEAD_NS, name: 'your-node_X61HeadDurableObject', script: 'your-node', class: 'X61HeadDurableObject', use_sqlite: true },
  { id: MIRROR_NS, name: 'your-node_MirrorDO', script: 'your-node', class: 'MirrorDO', use_sqlite: true },
  // The managed voice's bridge is the live Worker's third Durable Object class (wrangler.toml, migration x61-v2-voice-bridge).
  { id: VOICE_NS, name: 'your-node_VoiceBridgeDO', script: 'your-node', class: 'VoiceBridgeDO', use_sqlite: true },
  // The outside witness is the fourth (wrangler.toml, migration x61-v3-witness).
  { id: WITNESS_NS, name: 'your-node_WitnessDO', script: 'your-node', class: 'WitnessDO', use_sqlite: true },
  { id: OTHER_NS, name: 'helper_Counter', script: 'helper', class: 'Counter', use_sqlite: true },
] }
const NAMESPACE_PATH = /^\/accounts\/[0-9a-f]{32}\/workers\/durable_objects\/namespaces$/
// The live Worker's own settings (C2) for any account, as deploy/cloudflare/wrangler.toml binds it today: two Durable
// Object classes, one R2 bucket, the static assets; no service, tail consumer or dispatch namespace. The broker reads it
// only once cfdoor REQUEST-5-broker.diff lands; until then nothing asks for it.
const LIVE_SETTINGS = { success: true, errors: [], messages: [], result: { bindings: [{ type: 'assets', name: 'ASSETS' },
  { type: 'durable_object_namespace', name: 'HEAD', class_name: 'X61HeadDurableObject' }, { type: 'durable_object_namespace', name: 'MIRROR', class_name: 'MirrorDO' },
  { type: 'r2_bucket', name: 'ARCHIVE_BUCKET', bucket_name: 'your-node-archive' }], tail_consumers: [] } }
const LIVE_SETTINGS_PATH = /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/your-node\/settings$/

const zoneList = url => { const zone = ZONE_LIST[new URL(url).searchParams.get('name')]; return Response.json({ success: true, errors: [], messages: [], result: zone ? [zone] : [], result_info: { page: 1, count: zone ? 1 : 0 } }) }
function harness({ environment = env(), answer = null, lose = false, namespaces = () => Response.json(NAMESPACES), settings = () => Response.json(LIVE_SETTINGS), zones = zoneList, clock = () => NOW } = {}) {
  const calls = [], writes = [], tokens = new Map()
  let request, consumed = 0, asked = 0
  // HEAD's consumer, as the edge wires it: no header is a refusal; a token is spent once, only on its exact body.
  const authorizeClass3 = async input => {
    asked++
    const token = request.headers.get('x-x6-class3-approval'), approval = tokens.get(token)
    if (!approval) throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
    if (approval.binding.bodySha256 !== digest(canonicalJson(input))) return { ok: false }
    tokens.delete(token); consumed++
    return structuredClone(approval)
  }
  const networkFetch = async (url, init) => {
    const target = new URL(url)
    assert.equal(target.origin, 'https://api.cloudflare.com')
    assert.equal(init.redirect, 'error')
    const headers = new Headers(init.headers)
    calls.push({ url, method: init.method, headers, body: init.body })
    const path = target.pathname.slice('/client/v4'.length)
    if (init.method === 'GET' && NAMESPACE_PATH.test(path) && target.search === '?per_page=1000') return namespaces(url, init)
    if (init.method === 'GET' && LIVE_SETTINGS_PATH.test(path) && !target.search) return settings(url, init)
    if (init.method === 'GET' && path === '/zones' && target.searchParams.has('name')) return zones(url, init)
    // The fake's facts are about one account; a test that uses another account id reads the same products.
    const fact = path.replace(/^\/accounts\/[0-9a-f]{32}\//, `/accounts/${ACCOUNT}/`)
    if (init.method === 'GET' && !target.search && Object.hasOwn(FACTS, fact) && (fact === path || /\/(?:pages|load_balancers|cfd_tunnel)\//.test(fact))) return Response.json({ success: true, errors: [], messages: [], result: FACTS[fact] })
    if (init.method !== 'GET') {
      writes.push({ url, method: init.method, body: init.body, headers })
      if (lose) throw new Error('connection reset after the request left')
    }
    if (answer) return answer(url, init)
    if (init.method === 'GET' && /\/(?:missing|0{32})(?:\/|$)/.test(path)) return Response.json({ success: false, errors: [{ code: 7003, message: 'Could not route' }], messages: [], result: null }, { status: 404 })
    return Response.json({ success: true, errors: [], messages: [], result: { id: 'created' }, result_info: null })
  }
  return { calls, writes, tokens, get consumed() { return consumed }, get asked() { return asked },
    grant(input, changes = {}) {
      const token = 'approval-' + tokens.size + '-' + consumed
      tokens.set(token, { ok: true, expiresAt: NOW + 60000, binding: { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/cloudflare', bodySha256: digest(canonicalJson(input)), ...changes } })
      return token
    },
    async send(input, { token } = {}) {
      const headers = new Headers({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(token ? { 'x-x6-class3-approval': token } : {}) })
      request = new Request(ORIGIN + '/_host/cloudflare', { method: 'POST', headers, body: JSON.stringify(input) })
      const response = await handleCloudBroker(request, environment, { bootstrap, now: clock, authorizeClass3, networkFetch })
      return { status: response.status, value: await response.json() }
    },
    // Job 7: what the owner's card does: the held answer's protection rides as `expect` on the exact
    // request, and the approval covers that object. `expect` given: no held answer is asked for first.
    async approve(input, { expect } = {}) {
      const protection = expect ?? (await this.send(input)).value.protection
      const approved = { ...input, expect: protection }
      return await this.send(approved, { token: this.grant(approved) })
    } }
}
const neverCarries = value => {
  const text = JSON.stringify(value)
  assert.equal(text.includes(KEY), false, 'the key never comes back')
  assert.equal(text.includes(EMAIL), false, 'the login email never comes back')
  assert.equal(/x-auth-|authorization/i.test(text), false, 'no request header comes back')
}

test('auth: a Global API Key goes as X-Auth-Email and X-Auth-Key, never with Authorization; an API token goes as Bearer', async () => {
  const global = harness()
  const read = await global.send(api('GET', '/zones'))
  assert.equal(read.status, 200)
  assert.equal(global.calls[0].headers.get('x-auth-email'), EMAIL)
  assert.equal(global.calls[0].headers.get('x-auth-key'), KEY)
  assert.equal(global.calls[0].headers.get('authorization'), null)
  neverCarries(read.value)
  for (const email of [undefined, '', 'not an email', 'owner@', 'owner@example', 'a@b.c\r\nx-evil: 1']) {
    const bearer = harness({ environment: env({ CLOUDFLARE_EMAIL: email }) })
    assert.equal((await bearer.send(api('GET', '/zones'))).status, 200)
    assert.equal(bearer.calls[0].headers.get('authorization'), 'Bearer ' + KEY)
    assert.equal(bearer.calls[0].headers.get('x-auth-email'), null)
    assert.equal(bearer.calls[0].headers.get('x-auth-key'), null)
  }
  assert.deepEqual(cloudflareAuth(env()).headers, { 'x-auth-email': EMAIL, 'x-auth-key': KEY })
  assert.equal(cloudflareAuth(env()).authKind, 'global-key')
  assert.equal(cloudflareAuth(env({ CLOUDFLARE_EMAIL: undefined })).authKind, 'api-token')
  for (const [value, code] of [[undefined, 'CLOUDFLARE_BROKER_TOKEN_UNCONFIGURED'], ['', 'CLOUDFLARE_BROKER_TOKEN_UNCONFIGURED'],
    ['a b', 'CLOUDFLARE_BROKER_CONFIG_INVALID'], ['x'.repeat(4097), 'CLOUDFLARE_BROKER_CONFIG_INVALID']]) {
    assert.throws(() => cloudflareAuth(env({ CLOUDFLARE_API_TOKEN: value })), { code })
    const refused = harness({ environment: env({ CLOUDFLARE_API_TOKEN: value }) })
    const answer = await refused.send(api('GET', '/zones'))
    assert.equal(answer.value.code, code)
    assert.equal(refused.calls.length, 0)
  }
  assert.equal(cloudflareAuthKind(env()), 'global-key')
  assert.equal(cloudflareAuthKind(env({ CLOUDFLARE_EMAIL: undefined })), 'api-token')
  assert.equal(cloudflareAuthKind(env({ CLOUDFLARE_API_TOKEN: undefined })), 'none')
  const status = await harness().send({ action: 'status' })
  assert.equal(status.value.authKind, 'global-key')
  assert.equal(status.value.accountConfigured, true)
  neverCarries(status.value)
  assert.equal((await harness({ environment: env({ CLOUDFLARE_ACCOUNT_ID: 'nope', CLOUDFLARE_EMAIL: undefined }) }).send({ action: 'status' })).value.accountConfigured, false)
})

test('versions uses the same auth helper (a Global API Key works there too)', async () => {
  const door = harness({ answer: () => Response.json({ success: true, result: { items: [{ id: 'version-1', metadata: { created_on: '2026-11-13T00:00:00Z' } }] } }) })
  const answer = await door.send({ action: 'versions', remote: true })
  assert.equal(answer.status, 200)
  assert.equal(answer.value.versions[0].id, 'version-1')
  assert.equal(door.calls[0].url, `${API}/accounts/${ACCOUNT}/workers/scripts/your-node/versions`)
  assert.equal(door.calls[0].headers.get('x-auth-key'), KEY)
  assert.equal(door.calls[0].headers.get('authorization'), null)
  neverCarries(answer.value)
})

test('the path rule: every refused shape is refused before anything is sent', async () => {
  const bad = ['zones', '', '/', '//zones', '/zones/', '/zones//x', '/zones/./x', '/zones/../user', '/zones/...', '/zones/%2e%2e', '/zones?x=1',
    '/zones#x', '/zones\\x', '/zones/a b', '/zones/\tx', '/zones/x\n', '/{acct}/x', '/accounts/{account}x/workers', '/accounts/x{account}',
    `${API}/zones`, '/' + 'a'.repeat(1100), '/zones/*', '/zones/a,b', 42, null, undefined, ['/zones']]
  for (const path of bad) {
    const door = harness(), answer = await door.send(api('GET', path))
    assert.deepEqual([path, answer.status, answer.value.code], [path, 400, 'CLOUDFLARE_PATH_REFUSED'])
    assert.equal(typeof answer.value.next, 'string')
    assert.equal(door.calls.length, 0)
  }
  for (const input of [api('HEAD', '/zones'), api('OPTIONS', '/zones'), api('CONNECT', '/zones'), api('', '/zones'), api(undefined, '/zones'),
    api('GET', '/zones', { query: Object.fromEntries(Array.from({ length: 33 }, (_, index) => ['k' + index, index])) }),
    api('GET', '/zones', { query: { a: { b: 1 } } }), api('GET', '/zones', { query: { a: [1] } }), api('GET', '/zones', { query: { a: null } }),
    api('GET', '/zones', { query: { 'a b': 1 } }), api('GET', '/zones', { query: { a: Infinity } }), api('GET', '/zones', { query: 'name=x' }),
    api('GET', '/zones', { body: {} }), api('POST', '/zones', { body: 'text' }), api('POST', '/zones', { body: 'x', bodyKind: 'text', contentType: 'text/html' }),
    api('POST', '/zones', { body: {}, contentType: 'text/plain' }), api('GET', '/zones', { headers: { 'x-auth-key': 'x' } }), { action: 'api', path: '/zones' }]) {
    const door = harness(), answer = await door.send(input)
    assert.deepEqual([JSON.stringify(input).slice(0, 80), answer.value.code], [JSON.stringify(input).slice(0, 80), 'CLOUDFLARE_REQUEST_INVALID'])
    assert.equal(door.calls.length, 0)
  }
  // Job 2: `multipart` is a body kind now (its own test below); any other kind is still refused, naming the three.
  for (const bodyKind of ['form-data', 'multipart/form-data', 'binary']) {
    const door = harness(), answer = await door.send(api('PUT', '/accounts/{account}/workers/scripts/hello', { body: {}, bodyKind }))
    assert.equal(answer.value.code, 'CLOUDFLARE_BODY_KIND_UNSUPPORTED')
    assert.match(answer.value.next, /multipart/)
    assert.equal(door.calls.length, 0)
  }
  // The classifier itself is closed: a path that does not parse is refused, never passed.
  assert.equal(classifyCloudflareRequest(api('GET', '/zones/../x'), { accountId: ACCOUNT }).verdict, 'refused')
})

test('{account} is filled at the edge only; the answer keeps the placeholder; no account configured is a refusal', async () => {
  const door = harness()
  const answer = await door.send(api('GET', '/accounts/{account}/workers/scripts', { query: { per_page: 50, name: 'a b&c', match: true } }))
  assert.equal(answer.status, 200)
  // Job 3: the query goes in canonical key order, whatever order she wrote it in.
  assert.equal(door.calls[0].url, `${API}/accounts/${ACCOUNT}/workers/scripts?match=true&name=a+b%26c&per_page=50`)
  assert.equal(answer.value.path, '/accounts/{account}/workers/scripts')
  assert.equal(JSON.stringify(answer.value).includes(ACCOUNT), false)
  assert.deepEqual(Object.keys(answer.value).sort(), ['action', 'errors', 'messages', 'method', 'ok', 'path', 'result', 'resultInfo', 'status', 'success'])
  const none = harness({ environment: env({ CLOUDFLARE_ACCOUNT_ID: undefined }) })
  const refused = await none.send(api('GET', '/accounts/{account}/workers/scripts'))
  assert.equal(refused.value.code, 'CLOUDFLARE_BROKER_CONFIG_INVALID')
  assert.equal(typeof refused.value.next, 'string')
  assert.equal(none.calls.length, 0)
  assert.equal((await none.send(api('GET', '/zones'))).status, 200, 'a path without {account} needs no account id')
  assert.equal(classifyCloudflareRequest(api('GET', '/accounts/{account}'), { accountId: null }).verdict, 'refused')
})

// Every family that asks for the owner's passkey, with at least two spellings each. Job 7: a fourth column is
// the `also` list, every other reason that matched (a Worker secret is an application's secret first; a renewal is a charge).
const P1 = reason => ({ family: 'P1', reason })
const PROTECTED = [
  // P1 her live home: the Worker by name, any route to it.
  ['P2', 'app-secret', api('PUT', '/accounts/{account}/workers/scripts/your-node/secrets', { body: { name: 'X', text: 'y', type: 'secret_text' } }), [P1('live-worker')]],
  ['P1', 'live-worker', api('PATCH', '/accounts/{account}/workers/scripts/YOUR-NODE/settings', { body: { logpush: true } })],
  ['P1', 'live-worker', api('POST', '/accounts/{account}/workers/scripts/Your-noDe/deployments', { body: { strategy: 'percentage', versions: [] } })],
  ['P1', 'live-worker', api('PUT', '/accounts/{account}/workers/scripts/your-node/schedules', { body: [{ cron: '* * * * *' }] })],
  ['P1', 'live-worker', api('POST', '/accounts/{account}/workers/scripts/your-node/subdomain', { body: { enabled: true } })],
  ['P1', 'live-worker', api('DELETE', '/accounts/{account}/workers/scripts/your-node')],
  ['P1', 'live-worker', api('PATCH', '/accounts/{account}/workers/services/your-node/environments/production', { body: {} })],
  ['P1', 'live-worker', api('DELETE', '/accounts/{account}/workers/services/YOUR-Node')],
  ['P1', 'live-worker', api('DELETE', '/accounts/{account}/workers/workers/0a1b2c')],
  ['P1', 'live-worker', api('POST', '/accounts/{account}/workers/workers/0a1b2c/versions', { body: { modules: [] } })],
  ['P1', 'live-worker', api('PATCH', '/accounts/{account}/workers/workers/Your-noDe', { body: {} })],
  ['P1', 'live-worker', api('POST', '/accounts/{account}/workers/deployments/by-script/0a1b2c/rollback', { body: {} })],
  ['P1', 'live-worker-settings', api('PUT', '/accounts/{account}/workers/account-settings', { body: { default_usage_model: 'standard' } })],
  ['P1', 'live-worker-settings', api('PUT', '/accounts/{account}/workers/subdomain', { body: { subdomain: 'x' } })],
  // P1 routes and custom domains that are or can match the live host (wildcards count), by body and by id.
  ['P1', 'live-host', api('POST', `/zones/${LIVE}/workers/routes`, { body: { pattern: 'node.example.invalid/*', script: 'other' } }), [P1('live-route')]],
  ['P1', 'live-host', api('POST', `/zones/${LIVE}/workers/routes`, { body: { pattern: '*.example.invalid/*', script: 'other' } }), [P1('live-route'), P1('live-zone')]],
  ['P1', 'live-route', api('POST', `/zones/${LIVE}/workers/routes`, { body: { pattern: '*/*', script: 'other' } })],
  ['P1', 'live-route', api('PUT', `/zones/${LIVE}/workers/routes/route-live`, { body: { pattern: 'old.example.invalid/*', script: 'other' } }), [P1('live-zone')]],
  ['P1', 'live-route', api('DELETE', `/zones/${LIVE}/workers/routes/route-live`)],
  ['P1', 'live-worker', api('PUT', `/zones/${OTHER}/workers/routes/r1`, { body: { pattern: 'a.example.org/*', script: 'Your-noDe' } })],
  ['P1', 'live-host', api('PUT', '/accounts/{account}/workers/domains', { body: { hostname: 'NODE.EXAMPLE.INVALID', service: 'other', zone_id: LIVE } }), [P1('live-zone')]],
  ['P1', 'live-host', api('DELETE', '/accounts/{account}/workers/domains/dom-live')],
  // P1 DNS records whose name is the live host or a wildcard covering it (relative names count), by body and by id.
  ['P1', 'live-dns', api('POST', `/zones/${LIVE}/dns_records`, { body: { type: 'CNAME', name: 'x61', content: 'elsewhere.example.net' } })],
  ['P1', 'live-dns', api('POST', `/zones/${LIVE}/dns_records`, { body: { type: 'A', name: '*.example.invalid', content: '192.0.2.1' } }), [P1('live-host'), P1('live-zone')]],
  ['P1', 'live-dns', api('POST', `/zones/${LIVE}/dns_records`, { body: { type: 'A', name: '*', content: '192.0.2.1' } })],
  ['P1', 'live-dns', api('POST', `/zones/${LIVE}/dns_records`, { body: { type: 'A', name: 'Node.examplE.invalid.', content: '192.0.2.1' } }), [P1('live-host')]],
  ['P1', 'live-dns', api('PATCH', `/zones/${LIVE}/dns_records/rec-live`, { body: { content: '192.0.2.9' } })],
  ['P1', 'live-dns', api('DELETE', `/zones/${LIVE}/dns_records/rec-live`)],
  ['P1', 'live-dns', api('PATCH', `/zones/${LIVE}/dns_records/rec-docs`, { body: { name: 'x61' } })],
  ['P1', 'live-dns', api('POST', `/zones/${LIVE}/dns_records/batch`, { body: { deletes: [{ id: 'rec-docs' }] } })],
  // P1 every storage object the Worker is bound to.
  ['P1', 'bound-storage', api('DELETE', '/accounts/{account}/r2/buckets/your-node-archive')],
  ['P1', 'bound-storage', api('PUT', '/accounts/{account}/r2/buckets/YOUR-NODE-ARCHIVE/cors', { body: { rules: [] } })],
  ['P1', 'bound-storage', api('POST', '/accounts/{account}/workers/durable_objects/namespaces', { body: { name: 'x' } })],
  ['P1', 'bound-storage', api('POST', '/accounts/{account}/workers/workers/9f8e7d/versions', { body: { bindings: [{ type: 'durable_object_namespace', name: 'H', class_name: 'X61HeadDurableObject', script_name: 'other' }] } })],
  ['P1', 'bound-storage', api('POST', '/accounts/{account}/workers/workers/9f8e7d/versions', { body: { migrations: { deleted_classes: ['mirrordo'] } } })],
  // P1 zone-wide switches on the zone that serves the live host.
  ['P1', 'live-zone', api('PATCH', `/zones/${LIVE}/settings/ssl`, { body: { value: 'off' } })],
  ['P1', 'live-zone', api('PUT', `/zones/${LIVE}/rulesets/phases/http_request_firewall_custom/entrypoint`, { body: { rules: [] } })],
  ['P1', 'live-zone', api('POST', `/zones/${LIVE}/purge_cache`, { body: { purge_everything: true } })],
  ['P1', 'live-zone', api('POST', `/zones/${LIVE}/firewall/rules`, { body: [] })],
  ['P1', 'live-zone', api('POST', `/zones/${LIVE}/pagerules`, { body: {} })],
  ['P1', 'live-zone', api('PATCH', `/zones/${LIVE}`, { body: { paused: true } })],
  // Job 7: the registrar record of the live domain is a charge first (C5); the live domain is said too.
  ['P4', 'registrar-renewal', api('PUT', '/accounts/{account}/registrar/domains/example.invalid', { body: { auto_renew: false } }), [P1('live-domain')]],
  ['P4', 'registrar-renewal', api('PUT', '/accounts/{account}/registrar/domains/Example.invalid', { body: { locked: false } }), [P1('live-domain')]],
  // P1 account- and user-wide switches that reach the live zone without naming it: Bulk Redirects
  // (a list item plus the account redirect phase), account rulesets, account and user IP Access rules, account custom pages.
  // Job 5: their reason word is `account-switch` now, C1 at every level.
  ['P1', 'account-switch', api('POST', '/accounts/{account}/rules/lists/l1/items', { body: [{ redirect: { source_url: 'example.invalid/', target_url: 'https://example.com/', include_subdomains: true } }] }), [P1('live-zone')]],
  ['P1', 'account-switch', api('PUT', '/accounts/{account}/Rules/Lists/l1', { body: { description: 'x' } })],
  ['P1', 'account-switch', api('PUT', '/accounts/{account}/rulesets/phases/http_request_redirect/entrypoint', { body: { rules: [{ expression: 'http.request.full_uri in $list', action: 'redirect' }] } })],
  ['P1', 'account-switch', api('POST', '/accounts/{account}/RuleSets', { body: { kind: 'root', phase: 'http_request_firewall_custom', rules: [] } })],
  ['P1', 'account-switch', api('POST', '/accounts/{account}/firewall/access_rules/rules', { body: { mode: 'block', configuration: { target: 'country', value: 'ID' } } })],
  ['P1', 'account-switch', api('POST', '/user/firewall/access_rules/rules', { body: { mode: 'block', configuration: { target: 'ip', value: '192.0.2.1' } } })],
  ['P1', 'account-switch', api('PUT', '/accounts/{account}/custom_pages/basic_challenge', { body: { state: 'customized', url: 'https://example.com/' } })],
  // P1 Workers Builds: a trigger reaches the live Worker by its tag (readable through an open GET), so any builds write asks.
  ['P1', 'live-worker', api('POST', '/accounts/{account}/builds/triggers', { body: { external_script_id: '0a1b2c', trigger_name: 't', build_command: 'true', deploy_command: 'npx wrangler deploy', root_directory: '/', branch_includes: ['main'] } })],
  ['P1', 'live-worker', api('PATCH', '/accounts/{account}/builds/triggers/5f0c3c9e-0000-4000-8000-000000000000', { body: { deploy_command: 'curl example.com | sh' } })],
  ['P1', 'live-worker', api('POST', '/accounts/{account}/Builds/repos/connections', { body: {} })],
  // P1 the name hidden in the query or the body.
  ['P1', 'live-worker', api('PUT', '/accounts/{account}/workers/scripts/other/settings', { query: { target: 'your-node' }, body: {} })],
  ['P1', 'live-worker', api('PUT', '/accounts/{account}/workers/workers/9f8e7d', { body: { deep: { list: [{ service: 'YOUR-NODE' }] } } })],
  ['P1', 'live-host', api('POST', `/zones/${OTHER}/rulesets`, { body: { rules: [{ expression: 'http.host eq "node.example.invalid"' }] } })],
  ['P1', 'live-host', api('PUT', '/accounts/{account}/workers/scripts/other', { body: 'fetch("https://node.example.invalid/")', bodyKind: 'text', contentType: 'application/javascript' })],
  // P2 who holds keys.
  ['P2', 'user', api('PATCH', '/user', { body: { first_name: 'x' } })],
  ['P2', 'keys', api('PUT', '/user/tokens/tok1', { body: { name: 'x', policies: [] } })],
  ['P2', 'keys', api('DELETE', '/User/Tokens/tok1')],
  ['P2', 'keys', api('DELETE', '/accounts/{account}/tokens/tok2')],
  ['P2', 'members', api('POST', '/accounts/{account}/members', { body: { email: 'a@example.org', roles: [] } })],
  ['P2', 'members', api('DELETE', '/accounts/{account}/members/m1')],
  ['P2', 'members', api('PUT', '/memberships/m2', { body: { status: 'accepted' } })],
  ['P2', 'members', api('DELETE', '/memberships/m2')],
  ['P2', 'members', api('POST', '/accounts/{account}/iam/user_groups', { body: { name: 'x' } })],
  ['P2', 'account', api('PUT', '/accounts/{account}', { body: { name: 'x' } })],
  ['P2', 'account', api('POST', '/accounts', { body: { name: 'x' } })],
  ['P2', 'access', api('POST', '/accounts/{account}/access/apps', { body: { name: 'x' } })],
  ['P2', 'access', api('DELETE', `/zones/${OTHER}/access/apps/a1`)],
  // P3 whole-thing deletion.
  ['P3', 'zone-deletion', api('DELETE', `/zones/${OTHER}`)],
  ['P3', 'zone-deletion', api('DELETE', `/zones/${LIVE}`), [P1('live-zone')]],
  ['P3', 'account-deletion', api('DELETE', '/accounts/{account}'), [{ family: 'P2', reason: 'account' }]],
  ['P3', 'account-deletion', api('DELETE', '/Accounts/{account}'), [{ family: 'P2', reason: 'account' }]],
]

test('every protected family answers 403 CLASS3_WEBAUTHN_REQUIRED with its reason word and sends nothing', async () => {
  for (const [family, reason, input, also] of PROTECTED) {
    const door = harness(), answer = await door.send(input)
    const label = `${input.method} ${input.path}`
    assert.deepEqual([label, answer.status, answer.value.code, answer.value.protection], [label, 403, 'CLASS3_WEBAUTHN_REQUIRED', { family, reason, ...(also ? { also } : {}) }])
    assert.equal(door.writes.length, 0, label)
    assert.ok(door.calls.every(call => call.method === 'GET'), label)
    neverCarries(answer.value)
  }
})

test('every other write is open: sent once with no approval asked', async () => {
  // Job 5: the live zone's other DNS names and routes, a registrar setting (C5) and a TURN key rename (R5a) left this
  // list; they ask now (job 5 rows below).
  for (const input of [
    api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'A', name: 'docs.example.org', content: '192.0.2.1' } }),
    api('PUT', '/accounts/{account}/workers/scripts/hello-world', { body: "addEventListener('fetch', e => e.respondWith(new Response('hi')))", bodyKind: 'text', contentType: 'application/javascript' }),
    api('PUT', '/accounts/{account}/workers/scripts/your-node-friend', { body: 'export default {}', bodyKind: 'text', contentType: 'application/javascript' }),
    api('POST', '/accounts/{account}/storage/kv/namespaces', { body: { title: 'notes' } }),
    api('POST', `/zones/${OTHER}/workers/routes`, { body: { pattern: 'docs.example.org/*', script: 'docs-site' } }),
    api('DELETE', '/accounts/{account}/workers/domains/dom-docs'),
    api('DELETE', '/accounts/{account}/workers/workers/9f8e7d'),
    api('PATCH', `/zones/${OTHER}/settings/ssl`, { body: { value: 'strict' } }),
    api('POST', '/zones', { body: { name: 'example.net', account: { id: ACCOUNT } } }),
    api('DELETE', `/zones/${OTHER}/dns_records/anything`),
    api('POST', '/accounts/{account}/r2/buckets', { body: { name: 'photos' } }),
  ]) {
    const door = harness(), label = `${input.method} ${input.path}`
    const token = door.grant(input)
    const answer = await door.send(input, { token })
    assert.deepEqual([label, answer.status, answer.value.ok], [label, 200, true])
    assert.equal(door.writes.length, 1, label)
    assert.equal(door.asked, 0, label + ': no approval is asked for an open write')
    assert.equal(door.consumed, 0, label + ': an attached approval is not spent on an open write')
    assert.equal(answer.value.method, input.method)
    assert.equal(answer.value.path, input.path)
    if (input.bodyKind === 'text') {
      assert.equal(door.writes[0].body, input.body)
      assert.equal(door.writes[0].headers.get('content-type'), 'application/javascript')
    } else if (input.body !== undefined) {
      assert.deepEqual(JSON.parse(door.writes[0].body), input.body)
      assert.equal(door.writes[0].headers.get('content-type'), 'application/json')
    }
  }
})

test('reads are open on every path, her own home included, and POST /graphql is a read', async () => {
  for (const input of [api('GET', `/zones/${LIVE}/settings`), api('GET', '/accounts/{account}/workers/scripts/your-node/settings'),
    api('GET', '/accounts/{account}/members'), api('GET', '/user/tokens'), api('GET', '/accounts/{account}/r2/buckets/your-node-archive'),
    api('GET', '/accounts/{account}/builds/triggers'), api('GET', '/accounts/{account}/rulesets'),
    api('POST', '/graphql', { body: { query: '{ viewer { zones(filter: {}) { zoneTag } } }' } })]) {
    const door = harness(), answer = await door.send(input)
    assert.equal(answer.status, 200, input.path)
    assert.equal(door.asked, 0, input.path)
  }
})

test('paths whose answer is credential material are refused for every method, before anything is sent, even with an approval', async () => {
  for (const input of [api('GET', '/accounts/{account}/cfd_tunnel/t1/token'), api('GET', '/accounts/{account}/warp_connector/w1/token'),
    api('POST', '/accounts/{account}/r2/temp-access-credentials', { body: { bucket: 'photos', permission: 'object-read-only', ttlSeconds: 60 } }),
    api('POST', '/user/tokens', { body: { name: 'x', policies: [] } }), api('PUT', '/user/tokens/t1/value', { body: {} }),
    api('POST', '/accounts/{account}/tokens', { body: { name: 'x' } }), api('PUT', '/accounts/{account}/tokens/t2/value', { body: {} }),
    api('GET', '/accounts/{account}/images/v1/keys'), api('GET', '/accounts/{account}/challenges/widgets/0x4AAA'),
    api('POST', '/accounts/{account}/challenges/widgets/0x4AAA/rotate_secret', { body: {} }),
    api('POST', '/accounts/{account}/access/service_tokens', { body: { name: 'x' } }), api('POST', '/accounts/{account}/stream/keys'),
    // Review: a new Calls TURN key answers its key value; the regenerate path the review names; a Pages upload JWT.
    api('POST', '/accounts/{account}/calls/turn_keys', { body: { name: 'k' } }), api('PUT', '/accounts/{account}/calls/turn_keys/k1/token', { body: {} }),
    api('GET', '/accounts/{account}/pages/projects/site/upload-token')]) {
    const door = harness(), token = door.grant(input), answer = await door.send(input, { token })
    assert.deepEqual([input.path, answer.status, answer.value.code], [input.path, 403, 'CLOUDFLARE_CREDENTIAL_PATH_REFUSED'])
    assert.match(answer.value.next, /dashboard/)
    assert.equal(door.calls.length, 0)
    assert.equal(door.consumed, 0)
  }
})

test('the response screen withholds the whole answer when any of it is shaped like a secret', async () => {
  const marker = 'marker-zone-name'
  for (const [label, body] of [
    ['the configured key', { success: true, result: [{ name: marker, echo: KEY }] }],
    ['a private key', { success: true, result: [{ name: marker, pem: 'x' }], note: '-----BEGIN PRIVATE KEY-----\nAAAA' }],
    ['a client secret', { success: true, result: { name: marker, client_secret: 'abc123' } }],
    ['a tunnel credentials file', { success: true, result: { name: marker, credentials_file: { TunnelSecret: 'c2VjcmV0' } } }],
    ['a stream key', { success: true, result: { name: marker, rtmps: { streamKey: 'k-123' } } }],
  ]) {
    const door = harness({ answer: () => Response.json(body) }), answer = await door.send(api('GET', '/zones'))
    assert.deepEqual([label, answer.status, answer.value.code, answer.value.status, answer.value.ok], [label, 200, 'CLOUDFLARE_RESPONSE_WITHHELD', 200, true])
    assert.equal(JSON.stringify(answer.value).includes(marker), false, label)
    assert.equal(Object.hasOwn(answer.value, 'result'), false, label)
    assert.equal(typeof answer.value.next, 'string')
  }
  // A withheld answer to a write still says it was sent (the card must not call it refused).
  const write = harness({ answer: () => Response.json({ success: true, result: { client_secret: 'abc123' } }) })
  const answer = await write.send(api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'A', name: 'a.example.org', content: '192.0.2.1' } }))
  assert.deepEqual([answer.status, answer.value.ok, answer.value.code, answer.value.outcome], [200, true, 'CLOUDFLARE_RESPONSE_WITHHELD', undefined])
  assert.equal(credentialShaped({ result: [{ name: 'zone', status: 'active', value: 'on' }] }), false)
  assert.equal(credentialShaped({ result: { secret: '' } }), false)
  assert.equal(credentialShaped({ result: { nested: [{ private_key: 'x' }] } }), true)
})

test('a protected write: one passkey approval on the exact bytes, spent once; a changed body is refused', async () => {
  const input = api('PATCH', `/zones/${LIVE}/settings/ssl`, { body: { value: 'full' } })
  const door = harness()
  const none = await door.send(input)
  assert.deepEqual([none.status, none.value.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'])
  assert.equal(door.writes.length, 0)
  // Job 7: the approved bytes carry `expect`, the protection the card showed.
  const approved = { ...input, expect: none.value.protection }
  const token = door.grant(approved)
  const sent = await door.send(approved, { token })
  assert.deepEqual([sent.status, sent.value.ok, sent.value.status, sent.value.success], [200, true, 200, true])
  assert.equal(door.consumed, 1)
  assert.equal(door.writes.length, 1)
  assert.equal(door.writes[0].method, 'PATCH')
  assert.equal(door.writes[0].url, `${API}/zones/${LIVE}/settings/ssl`)
  assert.deepEqual(JSON.parse(door.writes[0].body), { value: 'full' })
  const again = await door.send(approved, { token })
  assert.deepEqual([again.status, again.value.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'])
  assert.equal(door.writes.length, 1, 'a spent approval sends nothing')
  const second = door.grant(approved)
  const changed = await door.send({ ...approved, body: { value: 'off' } }, { token: second })
  assert.deepEqual([changed.status, changed.value.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'])
  assert.equal(door.writes.length, 1, 'an approval for other bytes sends nothing')
  const elsewhere = door.grant(approved, { pathname: '/_host/github' })
  assert.equal((await door.send(approved, { token: elsewhere })).status, 403)
  const expired = door.grant(approved, {})
  door.tokens.get(expired).expiresAt = NOW
  assert.equal((await door.send(approved, { token: expired })).status, 403)
  assert.equal(door.writes.length, 1)
})

// ---- the reason is part of the bytes the fingerprint covers,
// and the edge checks it against its own reason, classified again with fresh facts, before it spends the approval.
test('job 7 MUST 12: the review\'s swap (a zone deletion staged as bound storage) is refused CLOUDFLARE_REASON_CHANGED; nothing is written, the approval is not spent', async () => {
  const input = api('DELETE', `/zones/${OTHER}`)
  const door = harness()
  const held = await door.send(input)
  assert.deepEqual([held.status, held.value.protection], [403, { family: 'P3', reason: 'zone-deletion' }])
  // The reviewer's swap: the same request, staged with another reason.
  const swapped = { ...input, expect: { family: 'P1', reason: 'bound-storage' } }
  const token = door.grant(swapped), askedBefore = door.asked
  const refused = await door.send(swapped, { token })
  assert.deepEqual([refused.status, refused.value.code, refused.value.protection, refused.value.next], [409, 'CLOUDFLARE_REASON_CHANGED', { family: 'P3', reason: 'zone-deletion' }, CLOUDFLARE_NEXT.reasonChanged])
  assert.deepEqual([door.writes.length, door.asked - askedBefore, door.consumed, door.tokens.has(token)], [0, 0, 0, true], 'nothing written, the approval neither asked for nor spent')
  assert.ok(door.calls.every(call => call.method === 'GET'), 'only the reads of the live facts went out')
  // A true `expect` proceeds, once.
  const truthful = { ...input, expect: held.value.protection }
  const sent = await door.send(truthful, { token: door.grant(truthful) })
  assert.deepEqual([sent.status, door.consumed, door.writes.length], [200, 1, 1])
})

test('job 7 MUST 12: a missing `expect` on an approved write, `expect` on an unapproved request, and `expect` on a write that is open now are refused', async () => {
  const input = api('PATCH', `/zones/${LIVE}/settings/ssl`, { body: { value: 'off' } })
  // Approved without `expect`: the edge does not know what the card said, so it sends nothing and spends nothing.
  const missing = harness(), token = missing.grant(input), answer = await missing.send(input, { token })
  assert.deepEqual([answer.status, answer.value.code, answer.value.protection], [409, 'CLOUDFLARE_REASON_CHANGED', { family: 'P1', reason: 'live-zone' }])
  assert.deepEqual([missing.writes.length, missing.consumed, missing.tokens.has(token)], [0, 0, true])
  // `expect` without an approval: she never sends it; refused before anything is read.
  const unapproved = harness(), invalid = await unapproved.send({ ...input, expect: { family: 'P1', reason: 'live-zone' } })
  assert.deepEqual([invalid.status, invalid.value.code, unapproved.calls.length], [400, 'CLOUDFLARE_REQUEST_INVALID', 0])
  // `expect` on a write that is open now: refused, its protection is "open", nothing spent.
  const open = api('PATCH', `/zones/${OTHER}/settings/ssl`, { body: { value: 'strict' } })
  const wasHeld = { ...open, expect: { family: 'P1', reason: 'live-zone' } }
  const door = harness(), now = await door.send(wasHeld, { token: door.grant(wasHeld) })
  assert.deepEqual([now.status, now.value.code, now.value.protection, door.writes.length, door.consumed], [409, 'CLOUDFLARE_REASON_CHANGED', 'open', 0, 0])
  // An open write with an approval attached and no `expect` goes as an open write (the approval is not spent).
  const plain = harness(), through = await plain.send(open, { token: plain.grant(open) })
  assert.deepEqual([through.status, plain.writes.length, plain.consumed], [200, 1, 0])
})

test('job 7 MUST 12: a request whose reason changed between staging and approval (a binding added) is refused; restaged, it goes', async () => {
  // Staged while the live Worker does not bind the namespace: open... so a new store: bind it, then the card's `expect` is stale.
  const call = api('DELETE', `/accounts/{account}/storage/kv/namespaces/${'6b76' + '0'.repeat(26) + 'b1'}`)
  let bound = false
  const door = harness({ environment: LEVEL_ENVS.open, settings: () => Response.json(bound ? settingsWith({ type: 'kv_namespace', name: 'NOTES', namespace_id: '6b76' + '0'.repeat(26) + 'b1' }) : LIVE_SETTINGS) })
  // A write that is held for one reason when staged: the live zone's id carried in its query.
  const staged = { ...call, query: { note: LIVE } }
  const first = await door.send(staged)
  assert.deepEqual(first.value.protection, { family: 'P1', reason: 'live-zone' })
  // Before the owner approves, an outside deploy binds the namespace: the edge's own reason is now two reasons.
  bound = true
  const approved = { ...staged, expect: first.value.protection }
  const token = door.grant(approved)
  const refused = await door.send(approved, { token })
  assert.deepEqual([refused.status, refused.value.code, refused.value.protection], [409, 'CLOUDFLARE_REASON_CHANGED', { family: 'P1', reason: 'bound-storage', also: [{ family: 'P1', reason: 'live-zone' }] }])
  assert.deepEqual([door.writes.length, door.consumed, door.tokens.has(token)], [0, 0, true])
  // Asked again, the card shows both reasons; that approval sends it once.
  const through = await door.approve(staged)
  assert.deepEqual([through.status, door.consumed, door.writes.length], [200, 1, 1])
})

test('a lost answer after a write left says "outcome unknown" and is never retried', async () => {
  const input = api('PATCH', `/zones/${LIVE}/settings/ssl`, { body: { value: 'full' } })
  const protectedDoor = harness({ lose: true })
  const lost = await protectedDoor.approve(input)
  assert.deepEqual([lost.status, lost.value.code, lost.value.outcome, lost.value.replaySafe, lost.value.requiresFreshClass3Approval],
    [503, 'CLOUDFLARE_MUTATION_OUTCOME_UNKNOWN', 'unknown', false, true])
  assert.equal(protectedDoor.writes.length, 1)
  const open = harness({ lose: true })
  const openLost = await open.send(api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'A', name: 'a.example.org', content: '192.0.2.1' } }))
  assert.deepEqual([openLost.status, openLost.value.code, openLost.value.outcome, openLost.value.requiresFreshClass3Approval], [503, 'CLOUDFLARE_MUTATION_OUTCOME_UNKNOWN', 'unknown', false])
  assert.equal(open.writes.length, 1)
  // Cloudflare's own 5xx after a write is unknown too; its 4xx is its refusal, passed through.
  const failing = harness({ answer: () => Response.json({ success: false, errors: [{ code: 10000, message: 'internal' }] }, { status: 502 }) })
  const five = await failing.send(api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'A', name: 'a.example.org', content: '192.0.2.1' } }))
  assert.deepEqual([five.value.ok, five.value.status, five.value.outcome], [false, 502, 'unknown'])
  const refusing = harness({ answer: () => Response.json({ success: false, errors: [{ code: 1004, message: 'DNS Validation Error' }], messages: [], result: null }, { status: 400 }) })
  const four = await refusing.send(api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'A', name: 'a.example.org', content: 'nope' } }))
  assert.deepEqual([four.value.ok, four.value.status, four.value.code, four.value.errors[0].code, four.value.outcome], [false, 400, 'CLOUDFLARE_API_ERROR', 1004, undefined])
  // A read that fails is a plain failure, not a write of unknown outcome.
  const readLost = harness({ answer: () => { throw new Error('reset') } })
  const read = await readLost.send(api('GET', '/zones'))
  assert.equal(read.value.code, 'CLOUDFLARE_UPSTREAM_FAILED')
  assert.equal(read.value.outcome, undefined)
})

test('a target the edge cannot look up is refused, not guessed; answers are bounded at 1 MiB', async () => {
  // Job 5: a record on the live zone asks without its own lookup, so a missing Worker custom domain stands in for it.
  for (const input of [api('DELETE', '/accounts/{account}/workers/domains/missing'), api('DELETE', '/accounts/{account}/workers/workers/missing')]) {
    const door = harness(), answer = await door.send(input)
    assert.equal(answer.value.code, 'CLOUDFLARE_TARGET_UNRESOLVED', input.path)
    assert.equal(typeof answer.value.next, 'string')
    assert.equal(door.writes.length, 0)
  }
  // Job 5: a zone the edge cannot resolve could be the live one, so it asks the fingerprint instead (never opens).
  const unresolvedZone = await harness().send(api('PATCH', `/zones/${'0'.repeat(32)}/settings/ssl`, { body: { value: 'off' } }))
  assert.deepEqual([unresolvedZone.value.code, unresolvedZone.value.protection], ['CLASS3_WEBAUTHN_REQUIRED', { family: 'P1', reason: 'zone-unresolved' }])
  assert.ok(CLOUDFLARE_DOOR_LIMITS.answerBytes <= 1024 * 1024)
  const big = Array.from({ length: 2400 }, (_, index) => ({ id: String(index).padStart(32, '0'), name: `zone-${index}.example.org`, status: 'active', note: 'n'.repeat(160) }))
  const list = await harness({ answer: () => Response.json({ success: true, result: big, result_info: { page: 1, count: big.length } }) }).send(api('GET', '/zones'))
  assert.ok(JSON.stringify(list.value).length > 256 * 1024)
  assert.equal(list.value.result.length, 2400)
  assert.deepEqual(list.value.resultInfo, { page: 1, count: 2400 })
  const huge = await harness({ answer: () => Response.json({ success: true, result: 'x'.repeat(1024 * 1024) }) }).send(api('GET', '/zones'))
  assert.equal(huge.value.code, 'BROKER_BODY_TOO_LARGE')
  const wrangler = await harness().send({ action: 'wrangler', args: ['whoami'] })
  assert.equal(wrangler.value.code, 'CLOUDFLARE_ACTION_UNAVAILABLE')
  assert.match(wrangler.value.next, /api/)
})

test('every storage object wrangler.toml binds is on the protected list; a new binding kind forces a decision', () => {
  const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')
  const tables = [...toml.matchAll(/^\s*\[\[?\s*([A-Za-z0-9_.-]+)\s*\]\]?\s*(?:#.*)?$/gm)].map(match => match[1])
  // Decided: these are not storage, or their storage is checked below. Anything else must be decided in cloudflare-door.mjs first.
  const decided = new Set(['assets', 'vars', 'durable_objects.bindings', 'r2_buckets', 'migrations', 'observability', 'limits', 'placement', 'triggers', 'build', 'dev'])
  for (const table of tables) assert.ok(decided.has(table), `wrangler.toml binds [${table}]: decide whether it is her live home's storage, put its resource on CLOUDFLARE_LIVE_HOME.storage (deploy/cloudflare/src/cloudflare-door.mjs), then add it to this test's decided list`)
  // Job 3: every storage kind bound today says how a write that addresses it BY ID is caught:
  // Durable Object namespaces by the edge's lookup of the live Worker's namespace ids, an R2 bucket by its name (its only id).
  const storageTables = tables.filter(table => ['durable_objects.bindings', 'r2_buckets', 'kv_namespaces', 'd1_databases', 'queues.producers', 'queues.consumers', 'hyperdrive', 'vectorize'].includes(table))
  for (const table of new Set(storageTables)) assert.ok(Object.hasOwn(CLOUDFLARE_BOUND_KINDS, table), `wrangler.toml binds [${table}]: say in CLOUDFLARE_BOUND_KINDS how a write that addresses it by id is caught`)
  assert.deepEqual(Object.keys(CLOUDFLARE_BOUND_KINDS).sort(), [...new Set(storageTables)].sort(), 'CLOUDFLARE_BOUND_KINDS names exactly the storage kinds wrangler.toml binds')
  const liveIds = boundStorageIds(NAMESPACES)
  assert.deepEqual(liveIds, [HEAD_NS, MIRROR_NS, VOICE_NS, WITNESS_NS])
  for (const id of liveIds) {
    const byId = classifyCloudflareRequest(api('POST', '/accounts/{account}/workers/workers/9f8e7d/versions', { body: { bindings: [{ type: 'durable_object_namespace', name: 'B', namespace_id: id }] } }), { accountId: ACCOUNT, facts: { workers: { [`${ACCOUNT}/9f8e7d`]: 'hello-world' }, boundIds: liveIds } })
    assert.deepEqual([id, byId.verdict, byId.family, byId.reason], [id, 'protected', 'P1', 'bound-storage'])
  }
  assert.doesNotMatch(toml, /^\s*(?:kv_namespaces|d1_databases|r2_buckets|queues|services|durable_objects|hyperdrive|vectorize|analytics_engine_datasets|dispatch_namespaces|workflows|pipelines|secrets_store_secrets|mtls_certificates|send_email|browser|ai|images|unsafe)\s*=/m,
    'an inline binding array in wrangler.toml: write it as a table and decide it above')
  const blocks = toml.split(/^(?=\s*\[)/m)
  const named = []
  for (const block of blocks) {
    const header = block.match(/^\s*\[\[?\s*([A-Za-z0-9_.-]+)/)?.[1]
    const field = key => block.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1]
    if (header === 'durable_objects.bindings') {
      named.push(field('class_name'))
      const script = field('script_name')
      if (script !== undefined) assert.equal(script.toLowerCase(), CLOUDFLARE_LIVE_HOME.worker)
    }
    if (header === 'r2_buckets') named.push(field('bucket_name'))
  }
  assert.ok(named.length >= 3 && named.every(name => typeof name === 'string'))
  const listed = new Set(CLOUDFLARE_LIVE_HOME.storage.map(item => item.name.toLowerCase()))
  for (const name of named) {
    assert.ok(listed.has(name.toLowerCase()), `${name} is bound in wrangler.toml but not protected in CLOUDFLARE_LIVE_HOME.storage`)
    const verdict = classifyCloudflareRequest(api('POST', '/accounts/{account}/workers/workers/9f8e7d/versions', { body: { bindings: [{ name: 'B', value: name }] } }), { accountId: ACCOUNT, facts: { workers: { [`${ACCOUNT}/9f8e7d`]: 'hello-world' } } })
    assert.deepEqual([name, verdict.verdict, verdict.family, verdict.reason], [name, 'protected', 'P1', 'bound-storage'])
  }
  assert.equal(toml.match(/^name\s*=\s*"([^"]+)"/m)?.[1], CLOUDFLARE_LIVE_HOME.worker)
  assert.ok(CLOUDFLARE_LIVE_HOME.hosts.includes(toml.match(/^PUBLIC_HOST\s*=\s*"([^"]+)"/m)?.[1]))
  for (const pattern of [...toml.matchAll(/pattern\s*=\s*"([^"/]+)/g)].map(match => match[1])) assert.ok(CLOUDFLARE_LIVE_HOME.hosts.includes(pattern))
})

// ---- the Cloudflare door -------------------------------------------------------------------------------------------------

// B. The account level turned around: one OPEN row per family on CLOUDFLARE_ACCOUNT_OPEN (each a write the live home
// does not reach), and the fingerprint for everything else at the account level.
const ACCOUNT_OPEN_ROWS = [
  ['workers/scripts', api('PUT', '/accounts/{account}/workers/scripts/notes-site/content', { body: 'export default {}', bodyKind: 'text', contentType: 'application/javascript' })],
  ['workers/workers', api('POST', '/accounts/{account}/workers/workers', { body: { name: 'notes-site' } })],
  ['workers/domains', api('PUT', '/accounts/{account}/workers/domains', { body: { hostname: 'notes.example.org', service: 'notes-site', zone_id: OTHER } })],
  ['workers/observability', api('POST', '/accounts/{account}/workers/observability/telemetry/query', { body: { queryId: 'q1', timeframe: { from: 1, to: 2 } } })],
  ['storage/kv', api('PUT', '/accounts/{account}/storage/kv/namespaces/ns1/values/greeting', { body: 'hello', bodyKind: 'text', contentType: 'text/plain' })],
  ['r2/buckets', api('PUT', '/accounts/{account}/r2/buckets/photos/cors', { body: { rules: [] } })],
  ['d1/database', api('POST', '/accounts/{account}/d1/database', { body: { name: 'notes' } })],
  ['queues', api('POST', '/accounts/{account}/queues', { body: { queue_name: 'jobs' } })],
  ['pages/projects', api('POST', '/accounts/{account}/pages/projects', { body: { name: 'notes', production_branch: 'main' } })],
  ['vectorize', api('POST', '/accounts/{account}/vectorize/v2/indexes', { body: { name: 'idx', config: { dimensions: 32, metric: 'cosine' } } })],
  ['ai', api('POST', '/accounts/{account}/ai/run/@cf/meta/llama-3.1-8b-instruct', { body: { prompt: 'hello' } })],
  // Job 5: Hyperdrive and Calls (credential vocabulary, C3) and the registrar (C5) left the open list; a new Stream live
  // input answers its stream key (C3), so the Stream row edits a video.
  ['stream', api('POST', '/accounts/{account}/stream/vid1', { body: { meta: { name: 'talk' } } })],
  ['images', api('POST', '/accounts/{account}/images/v1/variants', { body: { id: 'thumb', options: { fit: 'scale-down', width: 100, height: 100 } } })],
  ['analytics_engine/sql', api('POST', '/accounts/{account}/analytics_engine/sql', { body: 'SHOW TABLES', bodyKind: 'text', contentType: 'text/plain' })],
]
// The three families a review found (they stay P1: they reach the live zone or Worker), the three job 1
// listed as unreviewed, and five made-up names: all go to the fingerprint, none is refused outright, none is open.
const ACCOUNT_ASKS = [
  ['P1', 'account-switch', undefined, api('PUT', '/accounts/{account}/rulesets/phases/http_request_redirect/entrypoint', { body: { rules: [] } })],
  ['P1', 'account-switch', undefined, api('POST', '/accounts/{account}/rules/lists', { body: { name: 'l', kind: 'redirect' } })],
  ['P1', 'live-worker', undefined, api('POST', '/accounts/{account}/builds/triggers', { body: { trigger_name: 't' } })],
  ['account-wide-unclassified', 'unclassified', 'load_balancers', api('POST', '/accounts/{account}/load_balancers/pools', { body: { name: 'p', origins: [{ name: 'o', address: '192.0.2.1' }] } })],
  ['account-wide-unclassified', 'unclassified', 'gateway', api('POST', '/accounts/{account}/gateway/rules', { body: { name: 'r', action: 'block', filters: ['dns'], traffic: 'any(dns.domains[*] == "example.com")' } })],
  ['account-wide-unclassified', 'unclassified', 'workers/dispatch', api('POST', '/accounts/{account}/workers/dispatch/namespaces', { body: { name: 'tenants' } })],
  ['account-wide-unclassified', 'unclassified', 'quantum_tunnels', api('POST', '/accounts/{account}/quantum_tunnels', { body: { name: 'x' } })],
  ['account-wide-unclassified', 'unclassified', 'zz-made-up', api('PUT', '/accounts/{account}/zz-made-up/1/settings', { body: { on: true } })],
  ['account-wide-unclassified', 'unclassified', 'teleport', api('DELETE', '/accounts/{account}/teleport/abc')],
  ['account-wide-unclassified', 'unclassified', 'shadow_settings', api('PATCH', '/accounts/{account}/Shadow_Settings', { body: { mode: 'all' } })],
  ['account-wide-unclassified', 'unclassified', 'future-thing', api('POST', `/accounts/${ACCOUNT}/future-thing/v9/items`, { body: [] })],
  // A known family under a sub-family that is not on the list, and services (no reference page found for it today).
  ['account-wide-unclassified', 'unclassified', 'r2/slurper', api('POST', '/accounts/{account}/r2/slurper/jobs', { body: {} })],
  ['account-wide-unclassified', 'unclassified', 'workers/services', api('PATCH', '/accounts/{account}/workers/services/notes-site/environments/production', { body: {} })],
  ['account-wide-unclassified', 'unclassified', 'workers', api('POST', '/accounts/{account}/workers', { body: {} })],
  // Job 5: an account Logpush job carries live request data out: an account switch, C1.
  ['P1', 'account-switch', undefined, api('POST', '/accounts/{account}/logpush/jobs', { body: { destination_conf: 'r2://x' } })],
  // /user/** writes are P2 (who holds keys), wherever under /user they go; an invitation is `members` (R5a).
  ['P2', 'members', undefined, api('POST', '/user/invites/i1', { body: { status: 'accepted' } })],
  ['P2', 'user', undefined, api('POST', '/user/load_balancers/pools', { body: {} })],
]

test('job 2 B: every family on the open account list is open; each entry says why and names the reference page it came from', async () => {
  const families = new Set(CLOUDFLARE_ACCOUNT_OPEN.map(entry => entry.sub === undefined ? entry.family : `${entry.family}/${entry.sub}`))
  assert.deepEqual([...families].sort(), ACCOUNT_OPEN_ROWS.map(([family]) => family).sort(), 'one open row per listed family, no more, no less')
  for (const entry of CLOUDFLARE_ACCOUNT_OPEN) {
    assert.ok(entry.reason.length > 20, entry.family)
    assert.match(entry.reference, /^https:\/\/developers\.cloudflare\.com\//, entry.family)
    assert.ok(Object.isFrozen(entry))
  }
  assert.ok(Object.isFrozen(CLOUDFLARE_ACCOUNT_OPEN))
  for (const [family, input] of ACCOUNT_OPEN_ROWS) {
    const door = harness(), answer = await door.send(input)
    assert.deepEqual([family, answer.status, answer.value.ok, answer.value.code], [family, 200, true, undefined])
    assert.equal(door.writes.length, 1, family)
    assert.equal(door.asked, 0, family)
  }
})

test('job 2 B: every other account-level write asks for the fingerprint and names its family; /user/** asks as P2', async () => {
  for (const [family, reason, apiFamily, input] of ACCOUNT_ASKS) {
    const door = harness(), answer = await door.send(input), label = `${input.method} ${input.path}`
    assert.deepEqual([label, answer.status, answer.value.code, answer.value.protection],
      [label, 403, 'CLASS3_WEBAUTHN_REQUIRED', { family, reason, ...(apiFamily === undefined ? {} : { apiFamily }) }])
    assert.equal(door.writes.length, 0, label)
    neverCarries(answer.value)
    // Never refused outright: the owner's passkey on these exact bytes sends it, once.
    const approved = harness(), sent = await approved.approve(input)
    assert.deepEqual([label, sent.status, sent.value.ok], [label, 200, true])
    assert.deepEqual([approved.writes.length, approved.consumed], [1, 1], label)
  }
  // The live name inside an otherwise open family still asks as P1, and reads stay open at the account level.
  assert.deepEqual((await harness().send(api('POST', '/accounts/{account}/queues/q1/consumers', { body: { script_name: 'your-node' } }))).value.protection, { family: 'P1', reason: 'live-worker' })
  assert.deepEqual((await harness().send(api('PUT', '/accounts/{account}/pages/projects/notes/domains', { body: { name: 'NODE.example.invalid' } }))).value.protection, { family: 'P1', reason: 'live-host' })
  for (const path of ['/accounts/{account}/load_balancers/pools', '/accounts/{account}/gateway/rules', '/accounts/{account}/quantum_tunnels']) {
    assert.equal((await harness().send(api('GET', path))).status, 200, path)
  }
  // Other zones stay fully open; the classifier names no apiFamily outside the account level.
  const verdict = classifyCloudflareRequest(api('POST', '/accounts/{account}/quantum_tunnels', { body: {} }), { accountId: ACCOUNT })
  assert.deepEqual([verdict.verdict, verdict.family, verdict.apiFamily], ['protected', 'account-wide-unclassified', 'quantum_tunnels'])
  assert.equal(classifyCloudflareRequest(api('PATCH', `/zones/${OTHER}/settings/ssl`, { body: { value: 'strict' } }), { accountId: ACCOUNT, facts: { zones: { [OTHER]: 'example.org' } } }).verdict, 'open')
})

// C. Multipart: text and json parts only, the edge's own boundary, every part read by the P1 name rules.
const moduleWorker = (name, more = {}) => api('PUT', `/accounts/{account}/workers/scripts/${name}`, { bodyKind: 'multipart', parts: [
  { name: 'metadata', contentType: 'application/json', json: { main_module: 'worker.js', compatibility_date: '2026-11-01',
    bindings: [{ type: 'kv_namespace', name: 'NOTES', namespace_id: 'ns1' }, { type: 'plain_text', name: 'GREETING', text: 'hi' }] } },
  { name: 'worker.js', filename: 'worker.js', contentType: 'application/javascript+module', text: 'export default { async fetch(request, env) { return new Response(env.GREETING) } }' },
], ...more })

test('job 2 C: a module Worker with metadata and bindings goes as one multipart body the edge builds, open for a new name', async () => {
  assert.equal(CLOUDFLARE_DOOR_LIMITS.multipartBytes, CLOUD_BROKER_LIMITS.requestBytes, 'the multipart bound is the door\'s request bound')
  const input = moduleWorker('notes-site'), door = harness(), answer = await door.send(input)
  assert.deepEqual([answer.status, answer.value.ok, door.asked, door.writes.length], [200, true, 0, 1])
  const write = door.writes[0], type = write.headers.get('content-type')
  assert.match(type, /^multipart\/form-data; boundary=aukora-cfdoor-[0-9a-z]{8}$/)
  const boundary = type.split('boundary=')[1]
  assert.equal(write.url, `${API}/accounts/${ACCOUNT}/workers/scripts/notes-site`)
  assert.equal(write.method, 'PUT')
  // The body parses back to exactly her parts (the platform's own multipart reader).
  const form = await new Request('https://parse.invalid/', { method: 'POST', headers: { 'content-type': type }, body: write.body }).formData()
  assert.deepEqual([...form.keys()], ['metadata', 'worker.js'])
  assert.deepEqual(JSON.parse(await new Response(form.get('metadata')).text()), input.parts[0].json)
  const file = form.get('worker.js')
  assert.equal(file.name, 'worker.js')
  assert.equal(file.type, 'application/javascript+module')
  assert.equal(await file.text(), input.parts[1].text)
  assert.ok(write.body.endsWith(`--${boundary}--\r\n`))
  // The boundary is the edge's own: a part that carries the first candidate moves it on; the build is deterministic.
  const sly = moduleWorker('notes-site')
  sly.parts[1] = { ...sly.parts[1], text: '// aukora-cfdoor-00000000 --aukora-cfdoor-00000000--\nexport default {}' }
  const moved = classifyCloudflareRequest(sly, { accountId: ACCOUNT })
  assert.equal(moved.contentType, 'multipart/form-data; boundary=aukora-cfdoor-00000001')
  assert.equal(classifyCloudflareRequest(sly, { accountId: ACCOUNT }).body, moved.body)
  neverCarries(answer.value)
})

test('job 2 C: P1 looks inside every text and json part, and a protected multipart write is staged bytes like any other', async () => {
  const hidden = [
    ['live-worker', moduleWorker('your-node')],
    ['live-worker', (() => { const input = moduleWorker('notes-site'); input.parts[0].json.bindings.push({ type: 'service', name: 'HOME', service: 'YOUR-NODE' }); return input })()],
    ['bound-storage', (() => { const input = moduleWorker('notes-site'); input.parts[0].json.bindings.push({ type: 'r2_bucket', name: 'B', bucket_name: 'your-node-archive' }); return input })()],
    ['live-host', (() => { const input = moduleWorker('notes-site'); input.parts[1].text = 'export default { fetch() { return fetch("https://node.example.invalid/_host/repo") } }'; return input })()],
    ['live-worker', (() => { const input = moduleWorker('notes-site'); input.parts.push({ name: 'your-node.js', contentType: 'text/javascript', text: '1' }); return input })()],
    // Review: metadata sent as a TEXT part is read by Cloudflare as JSON, so its escapes are read decoded too.
    ...['application/json', 'text/plain'].flatMap(contentType => {
      const asText = metadata => { const input = moduleWorker('notes-site'); input.parts[0] = { name: 'metadata', contentType, text: metadata }; return input }
      return [
        ['bound-storage', asText('{"main_module":"worker.js","bindings":[{"type":"durable_object_namespace","name":"H","class_name":"X61HeadDurable\\u004fbject"}]}')],
        ['bound-storage', asText('{"main_module":"worker.js","bindings":[{"type":"r2_bucket","name":"B","bucket_name":"your\\u002dnode\\u002darchive"}]}')],
        ['live-worker', asText('{"main_module":"worker.js","bindings":[{"type":"service","name":"H","service":"your\\u002dnode"}]}')],
        ['live-worker', asText('{"main_module":"worker.js","bindings":[{"type":"durable_object_namespace","name":"H","class_name":"Other","script_name":"\\u0079our\\u002dnode"}]}')],
        ['live-host', asText('{"main_module":"worker.js","routes":["node\\u002eexample\\u002einvalid/*"]}')],
        ['live-worker', asText('{"main_module":"worker.js","bindings":[{"type":"service","name":"H","\\u0073ervice":"YOUR\\u002DNODE"}]}')],
      ]
    }),
    // The same escapes in a source part (JS \x and \u{}) and in a whole text body.
    ['live-worker', (() => { const input = moduleWorker('notes-site'); input.parts[1].text = 'export default { fetch(r, env) { return env["your\\x2dnode"] } }'; return input })()],
    ['bound-storage', (() => { const input = moduleWorker('notes-site'); input.parts[1].text = 'const b = "your\\u{2d}node\\u{2d}archive"; export default {}'; return input })()],
  ]
  for (const [reason, input] of hidden) {
    const door = harness(), answer = await door.send(input)
    assert.deepEqual([reason, answer.status, answer.value.protection], [reason, 403, { family: 'P1', reason }])
    assert.equal(door.writes.length, 0)
    const approved = harness(), sent = await approved.approve(input)
    assert.deepEqual([reason, sent.value.ok, approved.consumed, approved.writes.length], [reason, true, 1, 1])
    assert.match(approved.writes[0].headers.get('content-type'), /^multipart\/form-data; boundary=/)
  }
})

test('A whole text body is read decoded too (JSON, \\x, \\u{} and \\U escapes hide no live name)', async () => {
  const text = (body, contentType = 'text/plain') => api('PUT', '/accounts/{account}/storage/kv/namespaces/ns1/values/greeting', { body, bodyKind: 'text', contentType })
  const hidden = [
    ['bound-storage', text('{"bucket_name":"your\\u002dnode\\u002darchive"}')],
    ['live-worker', text('{"service":"your\\u002dnode"}')],
    ['live-host', text('{"pattern":"node\\u002eexample\\u002einvalid/*"}')],
    ['live-worker', text('env["your\\x2dnode"]', 'application/javascript')],
    ['bound-storage', text('class_name = "X61HeadDurable\\U0000004fbject"', 'application/toml')],
  ]
  for (const [reason, input] of hidden) {
    const door = harness(), answer = await door.send(input)
    assert.deepEqual([input.body, answer.status, answer.value.protection], [input.body, 403, { family: 'P1', reason }])
    assert.equal(door.writes.length, 0)
  }
  // A body that only looks escaped (or does not parse) stays as open as before.
  for (const body of ['hello', '{"a":"\\u0068i"}', '{"broken": "aukora\\u002d', 'C:\\\\users\\\\x61']) {
    const door = harness(), answer = await door.send(text(body))
    assert.deepEqual([body, answer.status, door.asked, door.writes.length], [body, 200, 0, 1])
  }
})

test('job 2 C: a malformed multipart is refused before anything is sent; binary parts wait for job 3', async () => {
  const good = moduleWorker('notes-site')
  const part = (more, drop = []) => { const value = { ...good.parts[1], ...more }; for (const key of drop) delete value[key]; return value }
  const invalid = [
    { ...good, parts: [] }, { ...good, parts: Array.from({ length: 17 }, (_, index) => part({ name: `m${index}.js` })) }, { ...good, parts: 'x' },
    { ...good, parts: undefined }, { ...good, body: {} }, { ...good, contentType: 'multipart/form-data' }, { ...good, method: 'GET' },
    { ...good, parts: [part({ name: '' })] }, { ...good, parts: [part({ name: 'a"b' })] }, { ...good, parts: [part({ name: 'a\r\nX: 1' })] },
    { ...good, parts: [part({ name: '../x.js' })] }, { ...good, parts: [part({ filename: 'x.js"; name="y' })] }, { ...good, parts: [part({}), part({})] },
    { ...good, parts: [part({ contentType: 'text/html' })] }, { ...good, parts: [part({ json: { a: 1 } })] }, { ...good, parts: [part({}, ['text'])] },
    { ...good, parts: [part({ text: 7 })] }, { ...good, parts: [part({ extra: 1 })] }, { ...good, parts: [{ name: 'm', contentType: 'text/plain', json: { a: 1 } }] },
    { ...good, parts: [{ name: 'm', contentType: 'application/json', json: 'string' }] }, { ...good, parts: [null] },
    api('PUT', '/accounts/{account}/workers/scripts/x', { parts: good.parts }),
  ]
  for (const input of invalid) {
    const door = harness(), answer = await door.send(input)
    assert.deepEqual([JSON.stringify(input).slice(0, 90), answer.status, answer.value.code], [JSON.stringify(input).slice(0, 90), 400, 'CLOUDFLARE_REQUEST_INVALID'])
    assert.equal(typeof answer.value.next, 'string')
    assert.equal(door.calls.length, 0)
  }
  for (const contentType of ['application/wasm', 'application/octet-stream', 'image/png', 'Application/WASM']) {
    const door = harness(), answer = await door.send({ ...good, parts: [good.parts[0], { name: 'm.wasm', contentType, text: 'AGFzbQ' }] })
    assert.deepEqual([contentType, answer.value.code], [contentType, 'CLOUDFLARE_BODY_KIND_UNSUPPORTED'])
    assert.match(answer.value.next, /binary|Wasm/)
    assert.equal(door.calls.length, 0)
  }
  const big = classifyCloudflareRequest({ ...good, parts: [good.parts[0], part({ text: 'x'.repeat(CLOUDFLARE_DOOR_LIMITS.multipartBytes) })] }, { accountId: ACCOUNT })
  assert.deepEqual([big.verdict, big.code, big.status], ['refused', 'CLOUDFLARE_BODY_TOO_LARGE', 413])
})

// ---- the outside review. Each ruling with the reviewer's exact input.

test('R1: live storage bound BY ID asks the fingerprint; the lookup is one cached read; a failed one asks too', async () => {
  // The reviewer's exact input, with a made-up id that the fake Cloudflare lists as the live HEAD namespace.
  const reviewer = ns => api('PATCH', '/accounts/{account}/pages/projects/helper', { body: { deployment_configs: { production: { durable_object_namespaces: { H: { namespace_id: ns } } } } } })
  let made = 0
  const fresh = () => env({ CLOUDFLARE_ACCOUNT_ID: (++made).toString(16).padStart(32, 'd') })
  // resolved-live
  const live = harness({ environment: fresh() }), held = await live.send(reviewer(HEAD_NS))
  assert.deepEqual([held.status, held.value.code, held.value.protection], [403, 'CLASS3_WEBAUTHN_REQUIRED', { family: 'P1', reason: 'bound-storage' }])
  assert.equal(live.writes.length, 0)
  const lookup = live.calls.filter(call => call.url.includes('/durable_objects/namespaces'))
  assert.equal(lookup.length, 1, 'one read')
  assert.equal(lookup[0].method, 'GET')
  assert.match(lookup[0].url, /\/accounts\/[0-9a-f]{32}\/workers\/durable_objects\/namespaces\?per_page=1000$/)
  assert.equal(lookup[0].headers.get('x-auth-key'), KEY, 'the same auth helper')
  // resolved-other: a namespace of another Worker is open
  const other = harness({ environment: fresh() }), sent = await other.send(reviewer(OTHER_NS))
  assert.deepEqual([sent.status, sent.value.ok, other.writes.length, other.asked], [200, true, 1, 0])
  // Every spelling of the live id, everywhere: upper case, dashed, in a Worker binding by id, the query, the path, a text part.
  for (const input of [reviewer(HEAD_NS.toUpperCase()), reviewer('5ead0000-0000-0000-0000-000000000a01'), reviewer(HEAD_NS.replace('a01', 'ａ０１')),
    api('PUT', '/accounts/{account}/workers/scripts/helper', { bodyKind: 'multipart', parts: [{ name: 'metadata', contentType: 'application/json', json: { main_module: 'w.js', bindings: [{ type: 'durable_object_namespace', name: 'H', namespace_id: MIRROR_NS }] } }, { name: 'w.js', contentType: 'application/javascript+module', text: 'export default {}' }] }),
    api('PUT', '/accounts/{account}/workers/scripts/helper', { bodyKind: 'multipart', parts: [{ name: 'metadata', contentType: 'text/plain', text: `{"main_module":"w.js","bindings":[{"type":"durable_object_namespace","name":"H","namespace_id":"${MIRROR_NS.replace('a', '\\u0061')}"}]}` }, { name: 'w.js', contentType: 'application/javascript+module', text: 'export default {}' }] }),
    api('PATCH', '/accounts/{account}/pages/projects/helper', { query: { namespace: HEAD_NS }, body: {} }),
    api('POST', `/accounts/{account}/queues/q1/consumers`, { body: { type: 'worker', settings: { dead_letter: HEAD_NS } } })]) {
    const door = harness(), answer = await door.send(input)
    assert.deepEqual([JSON.stringify(input).slice(0, 100), answer.status, answer.value.protection], [JSON.stringify(input).slice(0, 100), 403, { family: 'P1', reason: 'bound-storage' }])
    assert.equal(door.writes.length, 0)
  }
  // failed: an error answer, a thrown fetch, a timeout, more than one page, a bound class missing, no account configured.
  // Job 7: the namespace list is one of the live home's own facts, read for every write; one that fails, times
  // out or is not well formed holds the write as `live-facts-unresolved` (it was `bound-id-unresolved`).
  const failures = [
    () => Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 }),
    () => { throw new Error('connection reset') },
    () => { throw Object.assign(new Error('BROKER_TIMEOUT'), { code: 'BROKER_TIMEOUT', status: 408 }) },
    () => Response.json({ ...NAMESPACES, result_info: { ...NAMESPACES.result_info, total_pages: 2, total_count: 1001 } }),
    () => Response.json({ ...NAMESPACES, result: NAMESPACES.result.filter(item => item.class !== 'MirrorDO') }),
    () => Response.json({ ...NAMESPACES, result: [{ ...NAMESPACES.result[0], id: 'not-an-id' }, NAMESPACES.result[1]] }),
    () => new Response('<html>busy</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  ]
  for (const [index, namespaces] of failures.entries()) {
    const door = harness({ environment: fresh(), namespaces }), answer = await door.send(reviewer(OTHER_NS))
    assert.deepEqual([index, answer.status, answer.value.code, answer.value.protection], [index, 403, 'CLASS3_WEBAUTHN_REQUIRED', { family: 'P1', reason: 'live-facts-unresolved' }])
    assert.equal(door.writes.length, 0)
    // Never refused outright: The owner's passkey on these exact bytes sends it.
    const approved = harness({ environment: fresh(), namespaces }), through = await approved.approve(reviewer(OTHER_NS))
    assert.deepEqual([index, through.status, approved.consumed, approved.writes.length], [index, 200, 1, 1])
  }
  const noAccount = classifyCloudflareRequest(api('PATCH', `/zones/${OTHER}/dns_records/r1`, { body: { comment: HEAD_NS } }), { accountId: null, facts: { zones: { [OTHER]: 'example.org' } } })
  assert.deepEqual([noAccount.family, noAccount.reason], ['P1', 'bound-id-unresolved'])
  // Job 7: every write reads the live home's facts first, whatever its path or body (a plain write too); with
  // no account configured they cannot be read, so the write is held.
  const plain = harness({ environment: fresh() })
  assert.equal((await plain.send(api('POST', '/accounts/{account}/storage/kv/namespaces', { body: { title: 'notes' } }))).status, 200)
  assert.equal(plain.calls.filter(call => call.url.includes('/durable_objects/')).length, 1)
  const unconfigured = await harness({ environment: env({ CLOUDFLARE_ACCOUNT_ID: undefined }) }).send(api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'A', name: 'a.example.org', content: '192.0.2.1' } }))
  assert.deepEqual([unconfigured.status, unconfigured.value.protection], [403, { family: 'P1', reason: 'live-facts-unresolved' }])
  assert.ok(CLOUDFLARE_PROTECTED_REASONS.includes('bound-id-unresolved'))
})

// Job 7: this test said the bound ids were kept for five minutes. Nothing about the live
// Worker is kept across requests now: the list is read for every write, so a namespace another deploy binds is seen at once.
test('job 7 MUST 4: the Durable Object namespace list is read for every write, never kept; a namespace an outside deploy binds is held at once', async () => {
  const account = 'cace0000000000000000000000000001', environment = env({ CLOUDFLARE_ACCOUNT_ID: account })
  const NEW_NS = '5ead0000000000000000000000000a07'
  const write = ns => api('PATCH', '/accounts/{account}/pages/projects/demo', { body: { deployment_configs: { production: { durable_object_namespaces: { EXTRA: { namespace_id: ns } } } } } })
  let at = 1_000_000, reads = 0, deployed = false
  const counted = () => { reads++; return Response.json(deployed ? { ...NAMESPACES, result: [...NAMESPACES.result, { id: NEW_NS, name: 'your-node_ExtraStore', script: 'your-node', class: 'ExtraStore' }] } : NAMESPACES) }
  const settings = () => Response.json(deployed ? settingsWith({ type: 'durable_object_namespace', name: 'EXTRA', class_name: 'ExtraStore' }) : LIVE_SETTINGS)
  for (const step of [0, 60_000, 299_000]) {
    at = 1_000_000 + step
    assert.equal((await harness({ environment, namespaces: counted, settings, clock: () => at }).send(write(NEW_NS))).status, 200)
  }
  assert.equal(reads, 3, 'one read per write, none kept')
  // The reviewer's case: an external deployment adds the binding and its namespace; the very next write is held.
  deployed = true
  const held = await harness({ environment, namespaces: counted, settings, clock: () => at }).send(write(NEW_NS))
  assert.deepEqual([held.status, held.value.protection], [403, { family: 'P1', reason: 'bound-storage' }])
  // A class the settings bind on the live Worker that the list does not have: the facts are unresolved, held.
  const missing = await harness({ environment, namespaces: () => Response.json(NAMESPACES), settings }).send(write(OTHER_NS))
  assert.deepEqual([missing.status, missing.value.protection], [403, { family: 'P1', reason: 'live-facts-unresolved' }])
  assert.equal(Object.hasOwn(CLOUDFLARE_DOOR_LIMITS, 'boundIdCacheMs'), false, 'no cache time: nothing is kept')
})

test('R2: another API root asks (root-unclassified); Organization membership and access are P2; another account asks', async () => {
  // The reviewer's exact input.
  const reviewer = api('POST', '/organizations/0123456789abcdef0123456789abcdef/members', { body: { member: { user: { email: 'review@example.com' } } } })
  const rows = [
    [reviewer, { family: 'P2', reason: 'members' }],
    [api('DELETE', '/organizations/0123456789abcdef0123456789abcdef/members/m1'), { family: 'P2', reason: 'members' }],
    [api('PUT', '/Organizations/o1/Access/policies', { body: {} }), { family: 'P2', reason: 'access' }],
    [api('POST', '/organizations/o1/invites', { body: {} }), { family: 'P2', reason: 'members' }],
    [api('PUT', '/organizations/o1/profile', { body: { business_name: 'x' } }), { family: 'account-wide-unclassified', reason: 'root-unclassified', apiFamily: 'organizations' }],
    [api('POST', '/organizations', { body: { name: 'x' } }), { family: 'account-wide-unclassified', reason: 'root-unclassified', apiFamily: 'organizations' }],
    [api('POST', '/tenants/t1/accounts', { body: {} }), { family: 'account-wide-unclassified', reason: 'root-unclassified', apiFamily: 'tenants' }],
    [api('POST', '/radar/datasets', { body: {} }), { family: 'account-wide-unclassified', reason: 'root-unclassified', apiFamily: 'radar' }],
    // Job 5 (R5a): the Origin CA root is in the credential vocabulary, so it asks (C3) on every level; job 7: an origin
    // certificate is an application's (`app-secret`).
    [api('PUT', '/certificates/c1', { body: {} }), { family: 'P2', reason: 'app-secret' }],
    [api('PATCH', '/Something-New', { body: {} }), { family: 'account-wide-unclassified', reason: 'root-unclassified', apiFamily: 'something-new' }],
    [api('PUT', '/graphql', { body: {} }), { family: 'account-wide-unclassified', reason: 'root-unclassified', apiFamily: 'graphql' }],
    // Another account id in the path, at any family, even one open on the configured account.
    [api('PUT', `/accounts/${OTHER}/workers/scripts/hello`, { body: 'export default {}', bodyKind: 'text', contentType: 'application/javascript' }), { family: 'account-wide-unclassified', reason: 'other-account', apiFamily: 'workers/scripts' }],
    [api('POST', `/accounts/${OTHER}/storage/kv/namespaces`, { body: { title: 'x' } }), { family: 'account-wide-unclassified', reason: 'other-account', apiFamily: 'storage/kv' }],
  ]
  for (const [input, protection] of rows) {
    const door = harness(), answer = await door.send(input), label = `${input.method} ${input.path}`
    assert.deepEqual([label, answer.status, answer.value.code, answer.value.protection], [label, 403, 'CLASS3_WEBAUTHN_REQUIRED', protection])
    assert.equal(door.writes.length, 0, label)
    neverCarries(answer.value)
  }
  // Reads stay open on every root.
  for (const path of ['/organizations', '/organizations/o1/members', '/tenants/t1', '/radar/http/summary/device_type', `/accounts/${OTHER}/workers/scripts`]) {
    assert.equal((await harness().send(api('GET', path))).status, 200, path)
  }
  // The configured id written out (any case) is the configured account, not another one.
  const same = await harness().send(api('POST', `/accounts/${ACCOUNT.toUpperCase()}/storage/kv/namespaces`, { body: { title: 'x' } }))
  assert.deepEqual([same.status, same.value.ok], [200, true])
  // With no account configured, a literal account id cannot be checked, so it asks.
  const unconfigured = classifyCloudflareRequest(api('POST', `/accounts/${ACCOUNT}/storage/kv/namespaces`, { body: { title: 'x' } }), { accountId: null })
  assert.deepEqual([unconfigured.family, unconfigured.reason], ['account-wide-unclassified', 'other-account'])
})

test('R3: an endpoint whose answer mints an upload credential is refused; the answer screen reads credential names', async () => {
  // The reviewer's exact input.
  const reviewer = api('POST', '/accounts/{account}/workers/scripts/helper/assets-upload-session', { body: { manifest: { '/index.html': { hash: '0123456789abcdef0123456789abcdef', size: 1 } } } })
  for (const input of [reviewer, api('POST', '/accounts/{account}/workers/dispatch/namespaces/ns/scripts/helper/assets-upload-session', { body: { manifest: {} } }),
    api('POST', '/accounts/{account}/workers/assets/upload', { query: { base64: true }, bodyKind: 'multipart', parts: [{ name: 'h', contentType: 'text/plain', text: 'x' }] })]) {
    const door = harness({ answer: () => Response.json({ success: true, result: { jwt: 'eyJ'.padEnd(80, 'x'), buckets: [] } }) })
    const token = door.grant(input), answer = await door.send(input, { token })
    assert.deepEqual([input.path, answer.status, answer.value.code, answer.value.next], [input.path, 403, 'CLOUDFLARE_CREDENTIAL_PATH_REFUSED', CLOUDFLARE_NEXT.assets])
    assert.equal(door.calls.length, 0)
    assert.equal(door.consumed, 0)
  }
  const long = 'v'.repeat(40)
  for (const [field, value] of [['jwt', 'eyJhbGciOi'], ['secret', 's'], ['client_secret', 'c'], ['private_key', 'p'], ['api_key', 'k'], ['password', 'p'],
    ['credentials', { a: 1 }], ['webhook_secret', 'w'], ['upload_jwt', 'u'], ['signing_private_key', 'k'], ['token', long], ['access_token', long],
    ['session_token', 'short'], ['Upload_JWT', 'u'], ['clientSecret', 'c'], ['psk', 'p']]) {
    const door = harness({ answer: () => Response.json({ success: true, result: [{ name: 'marker', nested: { [field]: value } }] }) })
    const answer = await door.send(api('GET', '/accounts/{account}/workers/scripts'))
    assert.deepEqual([field, answer.value.code], [field, 'CLOUDFLARE_RESPONSE_WITHHELD'])
    assert.equal(JSON.stringify(answer.value).includes('marker'), false)
  }
  // A name ending in token with a short value, and a boolean or empty field, stay readable.
  for (const result of [{ next_token: 'abc' }, { has_secret: true }, { secret: '' }, { token_count: 3 }, { prompt_tokens: 12 }]) {
    const answer = await harness({ answer: () => Response.json({ success: true, result }) }).send(api('GET', '/zones'))
    assert.deepEqual([JSON.stringify(result), answer.value.ok, answer.value.result], [JSON.stringify(result), true, result])
  }
  // The one harmless token-named list field found in the reference: the Images v2 page cursor, readable on that path only.
  const cursor = 'c'.repeat(32), page = { success: true, result: { images: [{ id: 'i1', filename: 'a.png' }], continuation_token: cursor } }
  const images = await harness({ answer: () => Response.json(page) }).send(api('GET', '/accounts/{account}/images/v2', { query: { per_page: 100 } }))
  assert.deepEqual([images.value.ok, images.value.result.continuation_token], [true, cursor])
  const elsewhere = await harness({ answer: () => Response.json(page) }).send(api('GET', '/accounts/{account}/images/v1'))
  assert.equal(elsewhere.value.code, 'CLOUDFLARE_RESPONSE_WITHHELD')
  assert.equal(credentialShaped(page, { allowed: ['continuation_token'] }), false)
  assert.equal(credentialShaped({ ...page, result: { ...page.result, jwt: 'x' } }, { allowed: ['continuation_token'] }), true, 'the exception relaxes only its field')
  // Review: the public Web Analytics beacon value on the Pages project and deployment answers and on the RUM
  // site list was readable before the `token` rule and must stay so, on those paths only, GET only.
  const beacon = '0123456789abcdef0123456789abcdef'
  const pagesProject = { name: 'site', build_config: { web_analytics_tag: 't1', web_analytics_token: beacon }, latest_deployment: { build_config: { web_analytics_token: beacon } } }
  const rumSite = { site_tag: 't1', site_token: beacon, snippet: `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${beacon}"}'></script>` }
  for (const [path, result] of [['/accounts/{account}/pages/projects', [pagesProject]], ['/accounts/{account}/pages/projects/site', pagesProject],
    ['/accounts/{account}/pages/projects/site/deployments', [pagesProject.latest_deployment]], ['/accounts/{account}/pages/projects/site/deployments/d1', pagesProject.latest_deployment],
    ['/accounts/{account}/rum/site_info/list', [rumSite]], ['/accounts/{account}/rum/site_info/s1', rumSite]]) {
    const answer = await harness({ answer: () => Response.json({ success: true, result }) }).send(api('GET', path))
    assert.deepEqual([path, answer.value.ok, answer.value.result], [path, true, result])
  }
  // Each relaxes only its own field on its own path: another credential beside it, or the same field elsewhere, is withheld.
  for (const [path, result] of [['/accounts/{account}/pages/projects', [{ ...pagesProject, deploy_secret: 'x' }]], ['/accounts/{account}/rum/site_info/list', [{ ...rumSite, web_analytics_token: beacon }]],
    ['/accounts/{account}/workers/scripts', [{ web_analytics_token: beacon }]], ['/accounts/{account}/workers/scripts', [{ site_token: beacon }]]]) {
    const answer = await harness({ answer: () => Response.json({ success: true, result }) }).send(api('GET', path))
    assert.deepEqual([path, answer.value.code], [path, 'CLOUDFLARE_RESPONSE_WITHHELD'])
  }
  assert.deepEqual(CLOUDFLARE_ANSWER_ALLOWED.map(entry => [entry.field, entry.methods.join(), typeof entry.reason]),
    [['continuation_token', 'GET', 'string'], ['web_analytics_token', 'GET', 'string'], ['site_token', 'GET', 'string']])
})

test('R4: the screen runs on the content, whatever its declared type; a credential-shaped stored value is withheld', async () => {
  // The reviewer's exact input and mocked answer.
  const reviewer = api('GET', '/accounts/{account}/storage/kv/namespaces/ns1/values/credentials')
  const kv = await harness({ answer: () => new Response('{"api_key":"fresh-provider-credential"}', { headers: { 'content-type': 'text/plain' } }) }).send(reviewer)
  assert.deepEqual([kv.status, kv.value.code, kv.value.next], [200, 'CLOUDFLARE_RESPONSE_WITHHELD', CLOUDFLARE_NEXT.stored])
  assert.equal(JSON.stringify(kv.value).includes('fresh-provider-credential'), false)
  for (const [label, body, type] of [
    ['no content type', '{"api_key":"fresh-provider-credential"}', ''],
    ['octet-stream', '{"password":"hunter2"}', 'application/octet-stream'],
    ['html', '  {"result":{"jwt":"eyJ0"}}', 'text/html'],
    ['a byte-order mark', '﻿{"secret":"s"}', 'text/plain'],
    ['escaped key name', '{"api\\u005fkey":"x"}', 'text/plain'],
    ['NDJSON', '{"ok":1}\n{"client_secret":"c"}\n', 'application/x-ndjson'],
    ['JSON inside a JSON string', JSON.stringify({ success: true, result: { value: JSON.stringify({ private_key: 'k' }) } }), 'application/json'],
    ['JSON inside a string inside text', JSON.stringify({ note: JSON.stringify({ deeper: JSON.stringify({ password: 'p' }) }) }), 'text/plain'],
    ['a multipart answer part', '--b1\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{"secret":"x"}\r\n--b1--\r\n', 'multipart/form-data; boundary=b1'],
    ['a private key in plain text', 'value: -----BEGIN PRIVATE KEY-----\nAAAA', 'text/plain'],
  ]) {
    const answer = await harness({ answer: () => new Response(body, { headers: type ? { 'content-type': type } : {} }) }).send(reviewer)
    assert.deepEqual([label, answer.value.code], [label, 'CLOUDFLARE_RESPONSE_WITHHELD'])
    assert.equal(Object.hasOwn(answer.value, 'result'), false, label)
  }
  // A harmless stored value stays readable, as the text it is.
  const plain = await harness({ answer: () => new Response('{"greeting":"hello"}', { headers: { 'content-type': 'text/plain' } }) }).send(api('GET', '/accounts/{account}/storage/kv/namespaces/ns1/values/greeting'))
  assert.deepEqual([plain.value.ok, plain.value.result], [true, '{"greeting":"hello"}'])
  // The other door's next for anything that is not a stored value.
  const other = await harness({ answer: () => new Response('{"secret":"s"}', { headers: { 'content-type': 'text/plain' } }) }).send(api('GET', '/zones'))
  assert.equal(other.value.next, CLOUDFLARE_NEXT.withheld)
})

test('R5: the values the door sent as authentication never come back: the key withholds all, the email is replaced', async () => {
  const words = "[the account's sign-in address]"
  // The reviewer's exact input, with the documented user answer echoing the sign-in email.
  const user = { success: true, errors: [], messages: [], result: { id: 'u1', email: EMAIL, first_name: 'Owner', organizations: [{ name: `${EMAIL}'s Account` }] } }
  const answer = await harness({ answer: () => Response.json(user) }).send(api('GET', '/user'))
  assert.deepEqual([answer.status, answer.value.ok, answer.value.result.email, answer.value.redacted], [200, true, words, ['account-email']])
  assert.equal(answer.value.result.organizations[0].name, `${words}'s Account`)
  neverCarries(answer.value)
  // Any case, a JSON escape, a text answer, Cloudflare's own error words: replaced everywhere.
  for (const [label, response] of [
    ['upper case', () => Response.json({ success: true, result: { email: EMAIL.toUpperCase() } })],
    ['escaped @', () => new Response(`{"success":true,"result":{"email":"owner\\u0040example.org"}}`, { headers: { 'content-type': 'application/json' } })],
    ['text', () => new Response(`signed in as ${EMAIL}`, { headers: { 'content-type': 'text/plain' } })],
    ['an error', () => Response.json({ success: false, errors: [{ code: 9109, message: `Unauthorized for ${EMAIL}` }], messages: [], result: null }, { status: 403 })],
  ]) {
    const value = (await harness({ answer: response }).send(api('GET', '/user'))).value
    assert.deepEqual([label, value.redacted], [label, ['account-email']])
    assert.equal(JSON.stringify(value).toLowerCase().includes(EMAIL), false, label)
    assert.ok(JSON.stringify(value).includes(words.replace(/'/g, "'")), label)
  }
  // Review: the email only in its JSON-escaped form, in an answer NOT declared JSON (the reviewer's text/plain
  // GET /user, a stored KV value, an NDJSON line, a multipart part). The text would go back as written, so none of it is shown.
  const escaped = 'owner\\u0040example.org', hidden = text => text.toLowerCase().includes(escaped) || text.toLowerCase().includes(EMAIL)
  for (const [label, path, body, type] of [
    ['reviewer: text/plain /user', '/user', `{"result":{"email":"${escaped}"}}`, 'text/plain'],
    ['a stored KV value', '/accounts/{account}/storage/kv/namespaces/ns1/values/who', `{"email":"${escaped}"}`, 'text/plain'],
    ['no content type', '/user', `{"result":{"email":"${escaped}"}}`, ''],
    ['an NDJSON line', '/user', `{"ok":1}\n{"email":"${escaped}"}\n`, 'application/x-ndjson'],
    ['a multipart part', '/user', `--b1\r\nContent-Disposition: form-data; name="m"\r\nContent-Type: application/json\r\n\r\n{"email":"${escaped}"}\r\n--b1--\r\n`, 'multipart/form-data; boundary=b1'],
  ]) {
    const value = (await harness({ answer: () => new Response(body, { headers: type ? { 'content-type': type } : {} }) }).send(api('GET', path))).value
    assert.deepEqual([label, value.code, Object.hasOwn(value, 'result')], [label, 'CLOUDFLARE_RESPONSE_WITHHELD', false])
    assert.equal(hidden(JSON.stringify(value)), false, label)
    neverCarries(value)
  }
  // A text answer with the email written out plainly is still shown, with the email replaced (not withheld).
  const plainText = (await harness({ answer: () => new Response(`{"result":{"email":"${EMAIL}"}}`, { headers: { 'content-type': 'text/plain' } }) }).send(api('GET', '/user'))).value
  assert.deepEqual([plainText.ok, plainText.result, plainText.redacted], [true, `{"result":{"email":"${words}"}}`, ['account-email']])
  // The key anywhere in the answer, in any position or escape: none of it is shown.
  for (const body of [`{"result":{"note":"${KEY}"}}`, `prefix ${KEY} suffix`, `{"result":{"note":"${KEY.replace('s', '\\u0073')}"}}`]) {
    const value = (await harness({ answer: () => new Response(body, { headers: { 'content-type': body.startsWith('{') ? 'application/json' : 'text/plain' } }) }).send(api('GET', '/zones'))).value
    assert.deepEqual([body.slice(0, 30), value.code], [body.slice(0, 30), 'CLOUDFLARE_RESPONSE_WITHHELD'])
    neverCarries(value)
  }
  // An API token is the Bearer value: it too withholds all; there is no email to replace.
  const bearer = await harness({ environment: env({ CLOUDFLARE_EMAIL: undefined }), answer: () => Response.json({ success: true, result: { echo: KEY } }) }).send(api('GET', '/zones'))
  assert.equal(bearer.value.code, 'CLOUDFLARE_RESPONSE_WITHHELD')
  // Never in an error, never in a log: a failure that carries both, from Cloudflare and from the network, leaves neither.
  const logged = [], kept = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) { kept[level] = console[level]; console[level] = (...args) => { logged.push(args.map(String).join(' ')) } }
  try {
    for (const failing of [() => { throw new Error(`fetch failed for ${EMAIL} with ${KEY}`) },
      () => new Response(`<html>${EMAIL} ${KEY}</html>`, { status: 500, headers: { 'content-type': 'text/html' } }),
      () => new Response(`{"broken": "${EMAIL}`, { status: 200, headers: { 'content-type': 'application/json' } })]) {
      for (const input of [api('GET', '/user'), api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'A', name: 'a.example.org', content: '192.0.2.1' } })]) {
        const value = (await harness({ answer: failing }).send(input)).value
        assert.equal(value.ok, false)
        neverCarries(value)
      }
    }
  } finally { for (const [level, original] of Object.entries(kept)) console[level] = original }
  assert.equal(logged.filter(line => line.includes(EMAIL) || line.includes(KEY)).length, 0, 'nothing logged carries them')
})

test('R6 (SHOULD): what is sent is the canonical input the approval covers: key order changes no byte that leaves', async () => {
  // The reviewer's exact pair.
  const first = { action: 'api', method: 'PUT', path: '/accounts/{account}/workers/scripts/your-node', body: { a: 1, b: 2 }, query: { a: 1, b: 2 } }
  const second = { action: 'api', method: 'PUT', path: '/accounts/{account}/workers/scripts/your-node', body: { b: 2, a: 1 }, query: { b: 2, a: 1 } }
  assert.equal(canonicalJson(first), canonicalJson(second), 'one approval input')
  const sent = []
  for (const input of [first, second]) {
    const door = harness(), answer = await door.approve(input)
    assert.deepEqual([answer.status, door.consumed], [200, 1])
    sent.push({ url: door.writes[0].url, body: door.writes[0].body })
  }
  assert.deepEqual(sent[0], sent[1], 'one identical outgoing request')
  assert.equal(sent[0].url, `${API}/accounts/${ACCOUNT}/workers/scripts/your-node?a=1&b=2`)
  assert.equal(sent[0].body, canonicalJson(first.body))
  // Nested objects, an open write, and a json part of a multipart body too.
  const nested = order => api('POST', `/zones/${OTHER}/dns_records`, { body: order ? { type: 'A', name: 'n.example.org', content: '192.0.2.1', data: { y: 1, x: [{ q: 1, p: 2 }] } } : { data: { x: [{ p: 2, q: 1 }], y: 1 }, content: '192.0.2.1', name: 'n.example.org', type: 'A' } })
  const bodies = []
  for (const order of [true, false]) { const door = harness(); await door.send(nested(order)); bodies.push(door.writes[0].body) }
  assert.equal(bodies[0], bodies[1])
  const part = json => classifyCloudflareRequest(api('PUT', '/accounts/{account}/workers/scripts/notes', { bodyKind: 'multipart', parts: [{ name: 'metadata', contentType: 'application/json', json }] }), { accountId: ACCOUNT })
  assert.equal(part({ main_module: 'w.js', bindings: [] }).body, part({ bindings: [], main_module: 'w.js' }).body)
})

test('R7a: host names are normalised before every live-host comparison; a name that cannot be read asks', async () => {
  const routes = pattern => api('POST', `/zones/${LIVE}/workers/routes`, { body: { pattern, script: 'other' } })
  const record = (name, type = 'A') => api('POST', `/zones/${LIVE}/dns_records`, { body: { type, name, content: '192.0.2.1' } })
  for (const input of [
    routes('ｎｏｄｅ．ｅｘａｍｐｌｅ．ｉｎｖａｌｉｄ/*'), routes('NODE.EXAMPLE.INVALID./*'), routes('node.example.invalid./*'), routes('node。example。invalid/*'), routes('*.ＥＸＡＭＰＬｅ.ｉｎｖａｌｉｄ/*'),
    routes('https://x61.auk­ora.org/*'), record('ｘ６１'), record('Node.examplE.invalid..'), record('x61.auk­ora.org'),
    api('PUT', '/accounts/{account}/workers/domains', { body: { hostname: 'node。example。invalid', service: 'other', zone_id: LIVE } }),
    api('PUT', '/accounts/{account}/workers/scripts/other', { body: 'fetch("https://node。example。invalid/_host/repo")', bodyKind: 'text', contentType: 'application/javascript' }),
  ]) {
    const door = harness(), answer = await door.send(input)
    assert.equal(answer.status, 403, JSON.stringify(input.body))
    assert.equal(answer.value.protection.family, 'P1', JSON.stringify(input.body))
    assert.equal(door.writes.length, 0)
  }
  // A punycode form of an IDN live host, and the IDN form of a punycode live host (PUBLIC_HOST may be either).
  const idn = { accountId: ACCOUNT, hosts: ['node.example.invalid', 'bücher.example'], facts: { zones: { [OTHER]: 'xn--bcher-kva.example' } } }
  for (const name of ['BÜCHER.example.', 'xn--bcher-kva.example', '@', 'Bücher.example']) {
    const verdict = classifyCloudflareRequest(api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'A', name, content: '192.0.2.1' } }), idn)
    assert.deepEqual([name, verdict.verdict, verdict.family], [name, 'protected', 'P1'])
  }
  const puny = classifyCloudflareRequest(api('POST', `/zones/${OTHER}/workers/routes`, { body: { pattern: '*.bücher.example/*', script: 'x' } }), { ...idn, hosts: ['node.example.invalid', 'www.xn--bcher-kva.example'] })
  assert.deepEqual([puny.verdict, puny.family], ['protected', 'P1'])
  assert.equal(normalHost('ｎｏｄｅ．ｅｘａｍｐｌｅ．ｉｎｖａｌｉｄ.'), 'node.example.invalid')
  assert.equal(normalHost('BÜCHER.example'), 'xn--bcher-kva.example')
  assert.equal(normalHost('xn--zz.example'), null)
  // Ill-formed Punycode cannot be read on ANY runtime: the decoding is the door's own. (Node 24.11 refused `xn--zz`; Node
  // 24.22 on the hosted runners returned it, so main's own baseline was red there on 2026-11-13 and 2026-11-14.)
  const illFormed = ['xn--zz', 'xn--.example', 'xn--bcher-kva-.example', 'xn--9999999999.example', 'www.xn--zz.example.invalid',
    '*.xn--zz.example']
  for (const name of illFormed) assert.equal(normalHost(name), null, name)
  // Well-formed names stay readable in their one ASCII form (two RFC 3492 section 7.1 samples among them).
  const wellFormed = ['xn--mnchen-3ya.de', 'xn--egbpdaj6bu4bxfgehfvwxn.example', 'xn--ihqwcrb4cv8a8dqg056pqjye.example',
    '*.xn--bcher-kva.example']
  for (const name of wellFormed) assert.equal(normalHost(name), name, name)
  // Names that cannot be normalised: the fingerprint, as host-unreadable (never open, never a refusal). Job 7:
  // a route pattern that names a host on the live zone says that first (`live-zone`), the unreadable name after it.
  const unreadable = { family: 'P1', reason: 'host-unreadable' }
  for (const [input, expected] of [[record('xn--zz'), unreadable], [record('a b'), unreadable], [routes('xn--zz.example.invalid/*'), { family: 'P1', reason: 'live-zone', also: [unreadable] }],
    [api('PUT', '/accounts/{account}/workers/domains', { body: { hostname: 'xn--zz.example.org', service: 'other', zone_id: OTHER } }), unreadable]]) {
    const door = harness(), answer = await door.send(input)
    assert.deepEqual([JSON.stringify(input.body), answer.status, answer.value.protection], [JSON.stringify(input.body), 403, expected])
  }
  // Job 5: other names on the live zone ask too now (every write to the live zone asks), as `live-dns` and
  // `live-route`; the same names on another zone stay open. Job 7: a route names its host, a host on the live zone.
  for (const [reason, input, also] of [['live-dns', record('ｄｏｃｓ')], ['live-route', routes('docs.example.invalid./*'), [{ family: 'P1', reason: 'live-zone' }]]]) {
    assert.deepEqual([reason, (await harness().send(input)).value.protection], [reason, { family: 'P1', reason, ...(also ? { also } : {}) }])
  }
  for (const input of [api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'A', name: 'ｄｏｃｓ', content: '192.0.2.1' } }),
    api('POST', `/zones/${OTHER}/workers/routes`, { body: { pattern: 'docs.example.org./*', script: 'other' } })]) assert.equal((await harness().send(input)).status, 200)
})

test('R7b: a whole text body on DNS record and route endpoints is read as the JSON Cloudflare reads (the reviewer\'s text/plain case)', async () => {
  const text = (path, body) => api('POST', `/zones/${LIVE}/${path}`, { body, bodyKind: 'text', contentType: 'text/plain' })
  for (const [reason, input] of [
    ['live-dns', text('dns_records', '{"type":"CNAME","name":"x61","content":"elsewhere.example.net"}')],
    ['live-dns', text('dns_records', '[{"type":"A","name":"*","content":"192.0.2.1"}]')],
    ['live-route', text('workers/routes', '{"pattern":"*/*","script":"other"}')],
    ['live-dns', text('dns_records', 'name=x61 type=A')],
    ['live-route', text('workers/routes', 'pattern: */*')],
  ]) {
    const door = harness(), answer = await door.send(input)
    assert.deepEqual([input.body, answer.status, answer.value.protection], [input.body, 403, { family: 'P1', reason }])
    assert.equal(door.writes.length, 0)
  }
  // Job 5: any other name on the live zone asks too; on another zone the same text bodies stay open.
  for (const [reason, input, also] of [['live-dns', text('dns_records', '{"type":"CNAME","name":"docs","content":"x.example.net"}')], ['live-route', text('workers/routes', '{"pattern":"docs.example.invalid/*","script":"docs"}'), [{ family: 'P1', reason: 'live-zone' }]]]) {
    assert.deepEqual([input.body, (await harness().send(input)).value.protection], [input.body, { family: 'P1', reason, ...(also ? { also } : {}) }])
  }
  for (const path of ['dns_records', 'workers/routes']) {
    const input = api('POST', `/zones/${OTHER}/${path}`, { body: path === 'dns_records' ? '{"type":"CNAME","name":"docs","content":"x.example.net"}' : '{"pattern":"docs.example.org/*","script":"docs"}', bodyKind: 'text', contentType: 'text/plain' })
    assert.equal((await harness().send(input)).status, 200, input.body)
  }
  // A multipart body on the live zone's records cannot be read as a record: it asks.
  const multi = await harness().send(api('POST', `/zones/${LIVE}/dns_records`, { bodyKind: 'multipart', parts: [{ name: 'file', contentType: 'text/plain', text: 'x61 300 IN A 192.0.2.1' }] }))
  assert.deepEqual([multi.status, multi.value.protection?.family], [403, 'P1'])
})

test('the review\'s "checked and found sound" list, as tests: every multipart type, mixed-case names, redirects refused', async () => {
  for (const contentType of ['application/javascript+module', 'application/javascript', 'text/javascript', 'application/json', 'text/plain', 'application/toml', 'text/x-python', 'application/source-map']) {
    const input = api('PUT', '/accounts/{account}/workers/scripts/notes', { bodyKind: 'multipart', parts: [{ name: 'p', contentType, text: '{"service":"YoUr-noDe"}' }] })
    const answer = await harness().send(input)
    assert.deepEqual([contentType, answer.status, answer.value.protection], [contentType, 403, { family: 'P1', reason: 'live-worker' }])
  }
  // A redirect is refused for a read; after a write left, it is an unknown outcome, never followed.
  const redirect = () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } })
  const read = await harness({ answer: redirect }).send(api('GET', '/zones'))
  assert.equal(read.value.code, 'BROKER_REDIRECT_REFUSED')
  const write = await harness({ answer: redirect }).send(api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'A', name: 'a.example.org', content: '192.0.2.1' } }))
  assert.deepEqual([write.value.code, write.value.outcome], ['CLOUDFLARE_MUTATION_OUTCOME_UNKNOWN', 'unknown'])
})

// Job 4: the door has LEVELS. What each job 2 and job 3 reason does at `open`, written out here and not read from the door, so a moved row in the door's table fails this test.
const CORE_AT_OPEN = ['live-worker', 'live-worker-settings', 'live-host', 'live-route', 'live-dns', 'live-domain', 'host-unreadable',
  'bound-storage', 'bound-id-unresolved', 'keys', 'members', 'access', 'account', 'zone-deletion', 'account-deletion',
  // Job 5: R1 (every write to the live zone, a zone that cannot be resolved), R2, R3, and C5's charge words.
  'live-zone', 'zone-unresolved', 'account-switch', 'live-dependency', 'live-dependency-unresolved',
  'paid-subscription', 'paid-subscription-bulk', 'paid-subscription-action', 'registrar-purchase', 'registrar-renewal', 'registrar-transfer',
  'billing-payment', 'paid-routing-enable', 'paid-storage-enable', 'paid-certificate-order', 'credit-purchase', 'billing',
  // Job 7: an application's secret (C3), the live home's facts unread and a request read only in part (C1).
  'app-secret', 'live-facts-unresolved', 'inspection-limit']
const OPEN_AT_OPEN = ['user', 'unclassified', 'other-account', 'root-unclassified']
const LEVEL_ENVS = { open: env({ CLOUDFLARE_DOOR_LEVEL: 'open' }), guarded: env({ CLOUDFLARE_DOOR_LEVEL: 'guarded' }), absent: env(),
  unknown: env({ CLOUDFLARE_DOOR_LEVEL: 'OPEN' }) }
const protectionOf = (family, reason, apiFamily, also) => ({ family, reason, ...(apiFamily === undefined ? {} : { apiFamily }), ...(also === undefined ? {} : { also }) })
// One row per input: [label, input, at guarded (the job 2/3 protection, or 'open'), at open (a protection, or 'open')].
// Job 5: no row changes its reason between the levels any more (R1 and R2 ask with the same words at both).
const verdictAtOpen = protection => CORE_AT_OPEN.includes(protection.reason) ? protection : OPEN_AT_OPEN.includes(protection.reason) ? 'open' : assert.fail(`no level decision for ${protection.reason}`)
const LEVEL_ROWS = [
  ...PROTECTED.map(([family, reason, input, also]) => [protectionOf(family, reason, undefined, also), input]),
  ...ACCOUNT_ASKS.map(([family, reason, apiFamily, input]) => [protectionOf(family, reason, apiFamily), input]),
  // A review's roots and accounts, and the four new rows the brief names (open at `open`, asked at `guarded`).
  [protectionOf('P2', 'members'), api('POST', '/organizations/0123456789abcdef0123456789abcdef/members', { body: { member: { user: { email: 'review@example.com' } } } })],
  [protectionOf('P2', 'access'), api('PUT', '/Organizations/o1/Access/policies', { body: {} })],
  [protectionOf('P2', 'members'), api('DELETE', '/user/organizations/o1')],
  [protectionOf('account-wide-unclassified', 'root-unclassified', 'organizations'), api('PUT', '/organizations/o1/profile', { body: { business_name: 'x' } })],
  [protectionOf('account-wide-unclassified', 'root-unclassified', 'tenants'), api('POST', '/tenants/t1/accounts', { body: {} })],
  [protectionOf('account-wide-unclassified', 'other-account', 'workers/scripts'), api('PUT', `/accounts/${OTHER}/workers/scripts/hello`, { body: 'export default {}', bodyKind: 'text', contentType: 'application/javascript' })],
  [protectionOf('account-wide-unclassified', 'other-account', 'storage/kv'), api('POST', `/accounts/${OTHER}/storage/kv/namespaces`, { body: { title: 'x' } })],
  [protectionOf('P1', 'live-zone'), api('PATCH', `/zones/${LIVE}/settings/always_use_https`, { body: { value: 'on' } })],
  [protectionOf('P1', 'account-switch'), api('POST', '/accounts/{account}/rulesets', { body: { kind: 'custom', phase: 'http_request_firewall_custom', rules: [{ expression: 'ip.src eq 192.0.2.1', action: 'block' }] } })],
  [protectionOf('account-wide-unclassified', 'unclassified', 'magic'), api('POST', '/accounts/{account}/magic/sites', { body: { name: 'x' } })],
  [protectionOf('account-wide-unclassified', 'root-unclassified', 'brand-new-root'), api('POST', '/brand-new-root/x', { body: {} })],
].map(([protection, input]) => [`${input.method} ${input.path}`, input, protection, verdictAtOpen(protection)])

test('job 4: one table says, for every protected family, at which levels it asks; the core asks at both', () => {
  assert.deepEqual(CLOUDFLARE_DOOR_LEVELS, ['open', 'guarded'])
  assert.deepEqual(Object.keys(CLOUDFLARE_CORE), ['C1', 'C2', 'C3', 'C4', 'C5'])
  assert.deepEqual(CLOUDFLARE_DOOR_LEVEL_TABLE.map(row => row.reason).sort(), [...CLOUDFLARE_PROTECTED_REASONS].sort(), 'one row per reason word, no more')
  for (const row of CLOUDFLARE_DOOR_LEVEL_TABLE) {
    assert.ok(row.asks.includes('guarded'), `${row.reason} asks at guarded`)
    assert.equal(row.asks.includes('open'), CORE_AT_OPEN.includes(row.reason), `${row.reason} at open`)
    assert.equal(row.core !== null, CORE_AT_OPEN.includes(row.reason), `${row.reason} is core exactly when it asks at open`)
    if (row.core !== null) assert.ok(Object.hasOwn(CLOUDFLARE_CORE, row.core), row.reason)
    assert.ok(Object.isFrozen(row), row.reason)
  }
  assert.deepEqual([...CORE_AT_OPEN, ...OPEN_AT_OPEN].sort(), [...CLOUDFLARE_PROTECTED_REASONS].sort())
  // An absent or unknown level is `guarded`; only the exact word "open" opens.
  for (const value of [undefined, null, '', 'guarded', 'OPEN', ' open', 'open ', 'closed', 'Open', 1, true, ['open'], { open: true }]) {
    assert.equal(cloudflareDoorLevel({ CLOUDFLARE_DOOR_LEVEL: value }), 'guarded', JSON.stringify(value))
  }
  assert.equal(cloudflareDoorLevel(undefined), 'guarded')
  assert.equal(cloudflareDoorLevel({ CLOUDFLARE_DOOR_LEVEL: 'open' }), 'open')
  // A reason the table does not know asks at every level.
  assert.equal(cloudflareAsksAt('open', 'made-up-reason'), true)
  assert.equal(cloudflareAsksAt('anything', 'live-zone'), true, 'an unknown level reads as guarded')
  // The deployed level is `open`, one plain var in wrangler.toml, quoting the owner and naming the other value.
  const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')
  const lines = toml.split('\n').filter(line => /CLOUDFLARE_DOOR_LEVEL/.test(line))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^CLOUDFLARE_DOOR_LEVEL = "open" # the owner's choice; the other value is "guarded"$/)
  assert.ok(toml.indexOf(lines[0]) > toml.indexOf('[vars]') && toml.indexOf(lines[0]) < toml.indexOf('[[durable_objects.bindings]]'), 'under [vars]')
})

test('job 4: every family row from jobs 2 and 3 at both levels; an absent or unknown level behaves as guarded', async () => {
  assert.ok(LEVEL_ROWS.length > 90)
  for (const [label, input, guarded, atOpen] of LEVEL_ROWS) {
    for (const [name, environment] of Object.entries(LEVEL_ENVS)) {
      const expected = name === 'open' ? atOpen : guarded
      const door = harness({ environment }), answer = await door.send(input)
      if (expected === 'open') {
        assert.deepEqual([name, label, answer.status, answer.value.ok], [name, label, 200, true])
        assert.deepEqual([name, label, door.writes.length, door.asked], [name, label, 1, 0])
      } else {
        assert.deepEqual([name, label, answer.status, answer.value.code, answer.value.protection], [name, label, 403, 'CLASS3_WEBAUTHN_REQUIRED', expected])
        assert.equal(door.writes.length, 0, `${name} ${label}`)
      }
      neverCarries(answer.value)
    }
  }
  // The open writes of jobs 2 and 3 stay open at both levels.
  for (const [, input] of ACCOUNT_OPEN_ROWS) {
    for (const environment of [LEVEL_ENVS.open, LEVEL_ENVS.guarded]) {
      const door = harness({ environment }), answer = await door.send(input)
      assert.deepEqual([input.path, answer.status, door.writes.length, door.asked], [input.path, 200, 1, 0])
    }
  }
  // The card's WHY at `open` is one of the core sentences only: every ask there is P1 (C1, C2), P2 (C3), P3 (C4) or P4
  // (C5), never `account-wide-unclassified`, whose sentence is the unclassified one.
  const asked = LEVEL_ROWS.map(row => row[3]).filter(verdict => verdict !== 'open')
  assert.ok(asked.length > 50)
  for (const protection of asked) {
    assert.ok(['P1', 'P2', 'P3', 'P4'].includes(protection.family), JSON.stringify(protection))
    assert.equal(protection.apiFamily, undefined)
    assert.ok(CORE_AT_OPEN.includes(protection.reason), protection.reason)
  }
})

test('job 4: C1 to C4 ask at both levels, in at least three spellings each; she cannot change the level through this door', async () => {
  const CORE = {
    C1: [
      [{ family: 'P1', reason: 'live-worker' }, api('PATCH', '/accounts/{account}/workers/scripts/YOUR-NODE/settings', { body: { bindings: [{ type: 'plain_text', name: 'CLOUDFLARE_DOOR_LEVEL', text: 'open' }] } })],
      [{ family: 'P2', reason: 'app-secret', also: [{ family: 'P1', reason: 'live-worker' }] }, api('PUT', '/accounts/{account}/workers/scripts/your-node/secrets', { body: { name: 'CLOUDFLARE_DOOR_LEVEL', text: 'open', type: 'secret_text' } })],
      [{ family: 'P1', reason: 'live-worker' }, api('PUT', '/accounts/{account}/workers/scripts/Your-noDe', { bodyKind: 'multipart', parts: [{ name: 'metadata', contentType: 'application/json', json: { main_module: 'w.js', bindings: [{ type: 'plain_text', name: 'CLOUDFLARE_DOOR_LEVEL', text: 'open' }] } }, { name: 'w.js', contentType: 'application/javascript+module', text: 'export default {}' }] })],
      [{ family: 'P1', reason: 'live-worker' }, api('PATCH', '/accounts/{account}/workers/workers/0a1b2c', { body: { tags: [] } })],
      [{ family: 'P1', reason: 'live-worker' }, api('POST', '/accounts/{account}/builds/triggers', { body: { external_script_id: '0a1b2c', trigger_name: 't' } })],
      [{ family: 'P1', reason: 'live-worker-settings' }, api('PATCH', '/accounts/{account}/workers/account-settings', { body: { default_usage_model: 'unbound' } })],
      [{ family: 'P1', reason: 'live-host', also: [{ family: 'P1', reason: 'live-route' }] }, api('POST', `/zones/${LIVE}/workers/routes`, { body: { pattern: 'ｎｏｄｅ．ｅｘａｍｐｌｅ．ｉｎｖａｌｉｄ/*', script: 'other' } })],
      [{ family: 'P1', reason: 'live-dns' }, api('POST', `/zones/${LIVE}/dns_records`, { body: { type: 'CNAME', name: 'X61', content: 'elsewhere.example.net' } })],
      [{ family: 'P1', reason: 'live-host', also: [{ family: 'P1', reason: 'live-zone' }] }, api('PUT', '/accounts/{account}/workers/domains', { body: { hostname: 'node.example.invalid.', service: 'other', zone_id: LIVE } })],
      // Job 5: every list write is an account switch now, at both levels, whatever its source (one that names the
      // live host still says `live-host`).
      [{ family: 'P1', reason: 'account-switch', also: [{ family: 'P1', reason: 'live-zone' }] }, api('PUT', '/accounts/{account}/rules/lists/l1/items', { body: [{ redirect: { source_url: 'https://EXAMPLe.invalid/', target_url: 'https://example.com/', include_subdomains: true } }] })],
      // Job 7: both reasons; `account-switch` sorts first.
      [{ family: 'P1', reason: 'account-switch', also: [{ family: 'P1', reason: 'live-host' }] }, api('POST', '/accounts/{account}/rules/lists/l1/items', { body: [{ redirect: { source_url: 'node.example.invalid/', target_url: 'https://example.com/' } }] })],
      [{ family: 'P1', reason: 'account-switch' }, api('POST', '/accounts/{account}/rules/lists/l1/items', { body: [{ redirect: { source_url: 'a b/', target_url: 'https://example.com/' } }] })],
      [{ family: 'P1', reason: 'live-zone' }, api('PATCH', `/zones/${LIVE}/settings/ssl`, { body: { value: 'off' } })],
      [{ family: 'P1', reason: 'live-dns' }, api('POST', `/Zones/${LIVE}/DNS_Records`, { body: { type: 'TXT', name: 'anything', content: 'x' } })],
      [{ family: 'P4', reason: 'registrar-renewal', also: [{ family: 'P1', reason: 'live-domain' }] }, api('PATCH', '/accounts/{account}/registrar/domains/EXAMPLE.INVALID', { body: { locked: false } })],
    ],
    C2: [
      [{ family: 'P1', reason: 'bound-storage' }, api('DELETE', '/accounts/{account}/r2/buckets/YOUR-NODE-ARCHIVE')],
      [{ family: 'P1', reason: 'bound-storage' }, api('PUT', '/accounts/{account}/workers/scripts/helper', { body: 'export default {}', query: { binding: 'X61HeadDurableObject' }, bodyKind: 'text', contentType: 'application/javascript' })],
      [{ family: 'P1', reason: 'bound-storage' }, api('PATCH', '/accounts/{account}/pages/projects/helper', { body: { deployment_configs: { production: { durable_object_namespaces: { H: { namespace_id: '5ead0000-0000-0000-0000-000000000A01' } } } } } })],
      [{ family: 'P1', reason: 'bound-storage' }, api('DELETE', '/accounts/{account}/workers/durable_objects/namespaces/x')],
    ],
    C3: [
      [{ family: 'P2', reason: 'keys' }, api('PUT', '/user/tokens/tok1', { body: { name: 'x', policies: [] } })],
      [{ family: 'P2', reason: 'keys' }, api('DELETE', '/Accounts/{account}/Tokens/tok2')],
      [{ family: 'P2', reason: 'members' }, api('POST', '/accounts/{account}/members', { body: { email: 'a@example.org', roles: [] } })],
      [{ family: 'P2', reason: 'members' }, api('DELETE', '/memberships/m2')],
      [{ family: 'P2', reason: 'members' }, api('POST', '/organizations/o1/members', { body: {} })],
      [{ family: 'P2', reason: 'access' }, api('POST', '/accounts/{account}/access/apps', { body: { name: 'x' } })],
      [{ family: 'P2', reason: 'access' }, api('PUT', `/zones/${OTHER}/access/apps/a1/policies/p1`, { body: { decision: 'allow' } })],
      [{ family: 'P2', reason: 'account' }, api('PATCH', '/accounts/{account}', { body: { settings: { enforce_twofactor: false } } })],
      // Review (MUST): dashboard SSO decides how every user of an email domain signs in; moving the account into
      // or out of an Organization decides who holds implicit Super Administrator access. Both were `unclassified`.
      [{ family: 'P2', reason: 'access' }, api('POST', '/accounts/{account}/sso_connectors', { body: { email_domain: 'owner-brand.example' } })],
      [{ family: 'P2', reason: 'access' }, api('PATCH', '/accounts/{account}/SSO_Connectors/c1', { body: { enabled: true } })],
      [{ family: 'P2', reason: 'access' }, api('POST', '/accounts/{account}/sso_connectors/c1/begin_verification', { body: {} })],
      [{ family: 'P2', reason: 'members' }, api('POST', '/accounts/{account}/move', { body: { destination_organization_id: 'o1' } })],
      [{ family: 'P2', reason: 'members' }, api('POST', '/Accounts/Move', { body: { account_ids: [ACCOUNT], destination_organization_id: 'o1' } })],
      [{ family: 'P2', reason: 'members' }, api('POST', '/organizations/o1/accounts', { body: { account_id: ACCOUNT } })],
    ],
    C4: [
      [{ family: 'P3', reason: 'zone-deletion', also: [{ family: 'P1', reason: 'live-zone' }] }, api('DELETE', `/zones/${LIVE}`)],
      [{ family: 'P3', reason: 'zone-deletion' }, api('DELETE', `/Zones/${OTHER}`)],
      [{ family: 'P3', reason: 'account-deletion', also: [{ family: 'P2', reason: 'account' }] }, api('DELETE', '/accounts/{account}')],
      // Job 7: another account is said too where the level asks for it (`guarded`).
      [{ family: 'P3', reason: 'account-deletion', also: [{ family: 'P2', reason: 'account' }] }, api('DELETE', `/accounts/${OTHER}`),
        { family: 'P3', reason: 'account-deletion', also: [{ family: 'P2', reason: 'account' }, { family: 'account-wide-unclassified', reason: 'other-account' }] }],
    ],
    // Job 5: C5, anything that commits the owner to a charge (family P4), in three spellings.
    C5: [
      [{ family: 'P4', reason: 'paid-subscription' }, api('POST', '/accounts/{account}/subscriptions', { body: { rate_plan: { id: 'paid' } } })],
      [{ family: 'P4', reason: 'paid-subscription' }, api('PUT', `/ZONES/${OTHER}/Subscription`, { body: { rate_plan: { id: 'paid' } } })],
      [{ family: 'P4', reason: 'registrar-purchase' }, api('POST', '/Accounts/{account}/Registrar/Registrations', { body: { domain_name: 'example.com' } })],
    ],
  }
  for (const [group, rows] of Object.entries(CORE)) {
    assert.ok(rows.length >= 3, group)
    // A third column is the verdict at `guarded` where it differs (a Bulk Redirect list asks there as job 2 built it, `live-zone`).
    for (const [protection, input, atGuarded = protection] of rows) {
      for (const [name, environment] of Object.entries(LEVEL_ENVS)) {
        const door = harness({ environment }), answer = await door.send(input), label = `${group} ${name} ${input.method} ${input.path}`
        assert.deepEqual([label, answer.status, answer.value.code, answer.value.protection], [label, 403, 'CLASS3_WEBAUTHN_REQUIRED', name === 'open' ? protection : atGuarded])
        assert.equal(door.writes.length, 0, label)
        // The owner's passkey on these exact bytes sends it, at either level, once.
        const approved = harness({ environment }), through = await approved.approve(input)
        assert.deepEqual([label, through.status, approved.consumed, approved.writes.length], [label, 200, 1, 1])
      }
    }
  }
  // With no account id configured, a literal account's Worker settings, deployments and storage could be the live home's:
  // at `open` the other-account rule is passed over and the core rules below it still hold them. Job 7: with no
  // account the live Worker's facts cannot be read, so that is said too.
  const unconfigured = env({ CLOUDFLARE_DOOR_LEVEL: 'open', CLOUDFLARE_ACCOUNT_ID: undefined })
  for (const [reason, input] of [['live-worker-settings', api('PUT', `/accounts/${ACCOUNT}/workers/account-settings`, { body: {} })],
    ['live-worker', api('POST', `/accounts/${ACCOUNT}/workers/deployments`, { body: {} })],
    ['bound-storage', api('POST', `/accounts/${ACCOUNT}/workers/durable_objects/namespaces`, { body: {} })]]) {
    const door = harness({ environment: unconfigured }), answer = await door.send(input)
    assert.deepEqual([input.path, answer.status, answer.value.protection], [input.path, 403, { family: 'P1', reason, also: [{ family: 'P1', reason: 'live-facts-unresolved' }] }])
    assert.equal(door.writes.length, 0)
  }
  // Job 5: at `open` a zone-wide switch asks on the live zone; nothing is written. Job 7: the edge reads
  // the live Worker's settings and its namespace list first (the live zone's id is kept once learned), and needs no other
  // lookup for the live zone.
  const zoneWide = harness({ environment: LEVEL_ENVS.open })
  assert.equal((await zoneWide.send(api('PATCH', `/zones/${LIVE}/settings/ssl`, { body: { value: 'off' } }))).status, 403)
  assert.deepEqual(zoneWide.calls.filter(call => !/\/zones\?name=/.test(call.url)).map(call => [call.method, new URL(call.url).pathname.split('/').slice(-1)[0]]), [['GET', 'settings'], ['GET', 'namespaces']])
  // The classifier itself: an unknown level is guarded, and the verdicts are the same objects' shape at both. An
  // unclassified account family is the level's line now (account rulesets are an account switch at both).
  const magic = api('POST', '/accounts/{account}/magic/sites', { body: { name: 'x' } })
  for (const level of [undefined, 'guarded', 'OPEN', 'closed', 7]) {
    assert.equal(classifyCloudflareRequest(magic, { accountId: ACCOUNT, level }).verdict, 'protected', String(level))
  }
  assert.equal(classifyCloudflareRequest(magic, { accountId: ACCOUNT, level: 'open' }).verdict, 'open')
})

test('On example.invalid, the zone record and the rules that redirect, block or reroute every request are C1 at both levels', async () => {
  const redirectAll = { rules: [{ expression: 'true', action: 'redirect', action_parameters: { from_value: { target_url: { value: 'https://example.net' } } } }] }
  // Job 5: every write to the live zone is C1 now, as `live-zone` at both levels (the phase list is gone: a list of
  // phases can never be complete).
  const zoneWide = { family: 'P1', reason: 'live-zone' }, c1 = zoneWide
  const held = [
    api('PUT', `/zones/${LIVE}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, { body: redirectAll }),
    api('PUT', `/zones/${LIVE}/rulesets/phases/HTTP_REQUEST_FIREWALL_CUSTOM/entrypoint`, { body: { rules: [{ expression: 'true', action: 'block' }] } }),
    api('PUT', `/zones/${LIVE}/rulesets/phases/http_request_origin/entrypoint`, { body: { rules: [] } }),
    api('PUT', `/zones/${LIVE}/rulesets/phases/http_ratelimit/entrypoint`, { body: { rules: [] } }),
    api('PUT', `/zones/${LIVE}/rulesets/phases/http_request_transform/entrypoint`, { body: { rules: [] } }),
    api('POST', `/zones/${LIVE}/rulesets/phases/http_request_snippets/entrypoint/rules`, { body: { expression: 'true' } }),
    api('POST', `/zones/${LIVE}/rulesets`, { body: { kind: 'zone', name: 'r', phase: 'http_request_dynamic_redirect', rules: [] } }),
    api('POST', `/zones/${LIVE}/rulesets`, { body: { kind: 'zone', name: 'r', rules: [] } }),
    api('POST', `/zones/${LIVE}/rulesets`, { body: '{"phase":', bodyKind: 'text', contentType: 'text/plain' }),
    // By id the phase is not in the request, so the edge cannot tell: it asks.
    api('PUT', `/zones/${LIVE}/rulesets/r1`, { body: redirectAll }),
    api('POST', `/zones/${LIVE}/rulesets/r1/rules`, { body: { expression: 'true', action: 'block' } }),
    api('PATCH', `/zones/${LIVE}`, { body: { paused: true } }),
    api('PUT', `/Zones/${LIVE}`, { body: { type: 'partial' } }),
    api('PUT', `/zones/${LIVE}/snippets/s1`, { bodyKind: 'multipart', parts: [{ name: 'metadata', contentType: 'application/json', json: { main_module: 's.js' } }, { name: 's.js', contentType: 'application/javascript+module', text: 'export default { fetch: () => new Response(null, { status: 503 }) }' }] }),
    api('PUT', `/zones/${LIVE}/snippets/snippet_rules`, { body: { rules: [{ expression: 'true', snippet_name: 's1' }] } }),
  ]
  for (const input of held) {
    for (const [name, environment] of Object.entries(LEVEL_ENVS)) {
      const door = harness({ environment }), answer = await door.send(input), label = `${name} ${input.method} ${input.path}`
      assert.deepEqual([label, answer.status, answer.value.protection], [label, 403, name === 'open' ? c1 : zoneWide])
      assert.equal(door.writes.length, 0, label)
    }
  }
  // Job 5: the other phases and switches on example.invalid ask too now, at both levels.
  for (const input of [api('PUT', `/zones/${LIVE}/rulesets/phases/http_request_cache_settings/entrypoint`, { body: { rules: [] } }),
    api('POST', `/zones/${LIVE}/rulesets`, { body: { kind: 'zone', name: 'r', phase: 'http_response_headers_transform', rules: [] } }),
    api('PATCH', `/zones/${LIVE}/settings/always_use_https`, { body: { value: 'on' } })]) {
    for (const [name, environment] of Object.entries(LEVEL_ENVS)) {
      const door = harness({ environment }), answer = await door.send(input), label = `${name} ${input.method} ${input.path}`
      assert.deepEqual([label, answer.status, answer.value.protection, door.writes.length], [label, 403, zoneWide, 0])
    }
  }
  // Still open at `open`: every ruleset, zone record and snippet on another zone.
  const stillOpen = [
    [api('PUT', `/zones/${OTHER}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, { body: redirectAll }), 'open'],
    [api('PATCH', `/zones/${OTHER}`, { body: { paused: true } }), 'open'],
    [api('PUT', `/zones/${OTHER}/rulesets/r1`, { body: redirectAll }), 'open'],
    [api('PUT', `/zones/${OTHER}/snippets/snippet_rules`, { body: { rules: [] } }), 'open'],
  ]
  for (const [input, atGuarded] of stillOpen) {
    for (const [name, environment] of Object.entries(LEVEL_ENVS)) {
      const door = harness({ environment }), answer = await door.send(input), label = `${name} ${input.method} ${input.path}`
      const expected = name === 'open' ? 'open' : atGuarded
      if (expected === 'open') assert.deepEqual([label, answer.status, door.writes.length], [label, 200, 1])
      else assert.deepEqual([label, answer.status, answer.value.protection, door.writes.length], [label, 403, expected, 0])
    }
  }
  // The owner's passkey on the exact bytes sends a held one at `open`, once.
  const approved = harness({ environment: LEVEL_ENVS.open }), through = await approved.approve(held[11])
  assert.deepEqual([through.status, approved.consumed, approved.writes.length], [200, 1, 1])
})

test('job 4: status says the level and, for reviewers, what asks at it and at guarded; never a key', async () => {
  const open = (await harness({ environment: LEVEL_ENVS.open }).send({ action: 'status' })).value
  assert.equal(open.level, 'open')
  assert.deepEqual([...open.asksAtThisLevel].sort(), [...CORE_AT_OPEN].sort())
  assert.deepEqual([...open.asksAtGuarded].sort(), [...CLOUDFLARE_PROTECTED_REASONS].sort())
  neverCarries(open)
  for (const environment of [LEVEL_ENVS.guarded, LEVEL_ENVS.absent, LEVEL_ENVS.unknown]) {
    const guarded = (await harness({ environment }).send({ action: 'status' })).value
    assert.equal(guarded.level, 'guarded')
    assert.deepEqual(guarded.asksAtThisLevel, guarded.asksAtGuarded)
    neverCarries(guarded)
  }
  assert.deepEqual(cloudflareDoorStatus({ CLOUDFLARE_DOOR_LEVEL: 'open' }), { level: 'open', asksAtThisLevel: CLOUDFLARE_DOOR_LEVEL_TABLE.filter(row => row.asks.includes('open')).map(row => row.reason), asksAtGuarded: CLOUDFLARE_DOOR_LEVEL_TABLE.map(row => row.reason) })
})

test('job 4: the review\'s MUST 1 to 5 keep their verdicts at `open`: ids resolved, Organization members, credential answers refused, content screened, the sign-in address never returned', async () => {
  const open = extra => env({ CLOUDFLARE_DOOR_LEVEL: 'open', ...extra })
  // MUST 1: live storage bound by id; a lookup that fails asks too.
  const reviewer = ns => api('PATCH', '/accounts/{account}/pages/projects/helper', { body: { deployment_configs: { production: { durable_object_namespaces: { H: { namespace_id: ns } } } } } })
  const live = await harness({ environment: open({ CLOUDFLARE_ACCOUNT_ID: '10e1000000000000000000000000000a' }) }).send(reviewer(HEAD_NS))
  assert.deepEqual([live.status, live.value.protection], [403, { family: 'P1', reason: 'bound-storage' }])
  const failed = await harness({ environment: open({ CLOUDFLARE_ACCOUNT_ID: '10e1000000000000000000000000000b' }), namespaces: () => { throw new Error('reset') } }).send(reviewer(OTHER_NS))
  assert.deepEqual([failed.status, failed.value.protection], [403, { family: 'P1', reason: 'live-facts-unresolved' }])
  const other = await harness({ environment: open({ CLOUDFLARE_ACCOUNT_ID: '10e1000000000000000000000000000c' }) }).send(reviewer(OTHER_NS))
  assert.deepEqual([other.status, other.value.ok], [200, true])
  // MUST 2: Organization membership.
  const members = await harness({ environment: open() }).send(api('POST', '/organizations/0123456789abcdef0123456789abcdef/members', { body: { member: { user: { email: 'review@example.com' } } } }))
  assert.deepEqual([members.status, members.value.protection], [403, { family: 'P2', reason: 'members' }])
  // MUST 3: an answer that mints a credential is refused, even with an approval, before anything is sent.
  const assets = api('POST', '/accounts/{account}/workers/scripts/helper/assets-upload-session', { body: { manifest: { '/index.html': { hash: '0123456789abcdef0123456789abcdef', size: 1 } } } })
  const door = harness({ environment: open() }), refused = await door.send(assets, { token: door.grant(assets) })
  assert.deepEqual([refused.status, refused.value.code, door.calls.length, door.consumed], [403, 'CLOUDFLARE_CREDENTIAL_PATH_REFUSED', 0, 0])
  for (const path of ['/accounts/{account}/cfd_tunnel/t1/token', '/user/tokens/t1/value', '/accounts/{account}/r2/temp-access-credentials']) {
    const credential = await harness({ environment: open() }).send(api('PUT', path, { body: {} }))
    assert.deepEqual([path, credential.value.code], [path, 'CLOUDFLARE_CREDENTIAL_PATH_REFUSED'])
  }
  // MUST 4: the screen reads the content, whatever its type, on an open write's answer too.
  const kv = await harness({ environment: open(), answer: () => new Response('{"api_key":"fresh-provider-credential"}', { headers: { 'content-type': 'text/plain' } }) })
    .send(api('GET', '/accounts/{account}/storage/kv/namespaces/ns1/values/credentials'))
  assert.deepEqual([kv.value.code, JSON.stringify(kv.value).includes('fresh-provider-credential')], ['CLOUDFLARE_RESPONSE_WITHHELD', false])
  const written = await harness({ environment: open(), answer: () => Response.json({ success: true, result: { id: 'r', client_secret: 'c' } }) })
    .send(api('POST', '/accounts/{account}/magic/sites', { body: { name: 'x' } }))
  assert.equal(written.value.code, 'CLOUDFLARE_RESPONSE_WITHHELD')
  // MUST 5: the sign-in address is replaced and the key withholds the whole answer.
  const user = await harness({ environment: open(), answer: () => Response.json({ success: true, result: { email: EMAIL } }) }).send(api('GET', '/user'))
  assert.deepEqual([user.value.result.email, user.value.redacted], ["[the account's sign-in address]", ['account-email']])
  const key = await harness({ environment: open(), answer: () => Response.json({ success: true, result: { echo: KEY } }) }).send(api('POST', '/brand-new-root/x', { body: {} }))
  assert.equal(key.value.code, 'CLOUDFLARE_RESPONSE_WITHHELD')
  for (const value of [live.value, failed.value, members.value, refused.value, kv.value, written.value, user.value, key.value]) neverCarries(value)
})

// ---- the second outside review (an outside review). Every input it marks RAN is a row named by
// its item number, with the verdict it must have now at `open` AND at `guarded` (the core holds by structure, not by a
// list of families). A row is [name, input, { open, guarded }]: a protection, 'open', or { refused: code }.
const both = verdict => ({ open: verdict, guarded: verdict })
const atLevels = (open, guarded) => ({ open, guarded })
const LIVE_ZONE = { family: 'P1', reason: 'live-zone' }, SWITCH = { family: 'P1', reason: 'account-switch' }
const KEYS = { family: 'P2', reason: 'keys' }, MEMBERS = { family: 'P2', reason: 'members' }, ACCESS = { family: 'P2', reason: 'access' }
// Job 7: an application's secret, certificate or credential is `app-secret`;
// `keys` is only what opens the account itself or who can sign in. The rows below that said KEYS for an application's
// secret say APP_SECRET now.
const APP_SECRET = { family: 'P2', reason: 'app-secret' }
const withAlso = (protection, ...also) => ({ ...protection, also })
const charge = reason => ({ family: 'P4', reason })
const unclassifiedAt = apiFamily => ({ family: 'account-wide-unclassified', reason: 'unclassified', apiFamily })
const CREDENTIAL_REFUSED = { refused: 'CLOUDFLARE_CREDENTIAL_PATH_REFUSED' }
const blockAll = { rules: [{ expression: 'true', action: 'block' }] }
const paidPlan = { rate_plan: { id: 'synthetic-paid-plan' }, frequency: 'monthly' }
const REVIEW2_ROWS = [
  ['MUST 1a account entry point blocks every request', api('PUT', '/accounts/{account}/rulesets/phases/http_request_firewall_custom/entrypoint', { body: blockAll }), both(SWITCH)],
  ['MUST 1b account ruleset by id', api('PUT', '/accounts/{account}/rulesets/rs1', { body: blockAll }), both(SWITCH)],
  ['MUST 1c account ruleset collection', api('POST', '/accounts/{account}/rulesets', { body: { name: 'r', kind: 'root', phase: 'http_request_firewall_custom', rules: [] } }), both(SWITCH)],
  ['MUST 2a existing list items replaced', api('PUT', '/accounts/{account}/rules/lists/l1/items', { body: [] }), both(SWITCH)],
  ['MUST 2b existing list deleted', api('DELETE', '/accounts/{account}/rules/lists/l1'), both(SWITCH)],
  ['MUST 3a live managed WAF phase', api('PUT', `/zones/${LIVE}/rulesets/phases/http_request_firewall_managed/entrypoint`, { body: { rules: [] } }), both(LIVE_ZONE)],
  ['MUST 3b live ruleset collection in an unlisted phase', api('POST', `/zones/${LIVE}/rulesets`, { body: { name: 'waf', kind: 'zone', phase: 'http_request_firewall_managed', rules: [] } }), both(LIVE_ZONE)],
  ['MUST 3c live late transform phase', api('PUT', `/zones/${LIVE}/rulesets/phases/http_request_late_transform/entrypoint`, { body: { rules: [] } }), both(LIVE_ZONE)],
  ['MUST 3d the same phase on another zone stays open', api('PUT', `/zones/${OTHER}/rulesets/phases/http_request_firewall_managed/entrypoint`, { body: { rules: [] } }), both('open')],
  ['MUST 4a account IP Access rule', api('POST', '/accounts/{account}/firewall/access_rules/rules', { body: { mode: 'block', configuration: { target: 'country', value: 'ID' } } }), both(SWITCH)],
  ['MUST 4b user IP Access rule', api('POST', '/user/firewall/access_rules/rules', { body: { mode: 'block', configuration: { target: 'country', value: 'ID' } } }), both(SWITCH)],
  ['MUST 4c live firewall rules', api('POST', `/zones/${LIVE}/firewall/rules`, { body: [{ filter: { expression: 'true' }, action: 'block' }] }), both(LIVE_ZONE)],
  ['MUST 4d live bot fight mode', api('PUT', `/zones/${LIVE}/bot_management`, { body: { fight_mode: true } }), both(LIVE_ZONE)],
  ['MUST 5a live page rule by id', api('PATCH', `/zones/${LIVE}/pagerules/pr1`, { body: { status: 'disabled' } }), both(LIVE_ZONE)],
  ['MUST 5b live waiting room by id', api('PATCH', `/zones/${LIVE}/waiting_rooms/wr1`, { body: { queue_all: true } }), both(LIVE_ZONE)],
  ['MUST 6a live SSL off', api('PATCH', `/zones/${LIVE}/settings/ssl`, { body: { value: 'off' } }), both(LIVE_ZONE)],
  ['MUST 6b live bulk settings', api('PATCH', `/zones/${LIVE}/settings`, { body: { items: [{ id: 'ssl', value: 'off' }] } }), both(LIVE_ZONE)],
  ['MUST 6c live Universal SSL off', api('PATCH', `/zones/${LIVE}/ssl/universal/settings`, { body: { enabled: false } }), both(LIVE_ZONE)],
  ['MUST 7a account DNS-only enforcement', api('PATCH', '/accounts/{account}/dns_settings', { body: { enforce_dns_only: true } }), both(SWITCH)],
  ['MUST 7b live DNSSEC disabled', api('PATCH', `/zones/${LIVE}/dnssec`, { body: { status: 'disabled' } }), both(LIVE_ZONE)],
  ['MUST 7c live DNSSEC deleted', api('DELETE', `/zones/${LIVE}/dnssec`), both(LIVE_ZONE)],
  ['MUST 7d live nameserver type', api('PATCH', `/zones/${LIVE}/dns_settings`, { body: { nameservers: { type: 'cloudflare.advanced' } } }), both(LIVE_ZONE)],
  ['MUST 7e live legacy custom nameservers', api('PUT', `/zones/${LIVE}/custom_ns`, { body: { enabled: true, ns_set: 1 } }), both(LIVE_ZONE)],
  ['MUST 8a live secondary DNS incoming', api('PUT', `/zones/${LIVE}/secondary_dns/incoming`, { body: { auto_refresh_seconds: 300, peers: ['p1'] } }), both(LIVE_ZONE)],
  ['MUST 8b account secondary DNS peer', api('POST', '/accounts/{account}/secondary_dns/peers', { body: { name: 'p' } }), both(SWITCH)],
  ['MUST 8c account TSIG', api('POST', '/accounts/{account}/secondary_dns/tsigs', { body: { name: 't', algo: 'hmac-sha256.' } }), both(SWITCH)],
  ['MUST 9 live apex CAA record', api('POST', `/zones/${LIVE}/dns_records`, { body: { type: 'CAA', name: '@', data: { flags: 0, tag: 'issue', value: ';' }, ttl: 1 } }), both({ family: 'P1', reason: 'live-dns' })],
  ['MUST 10 live Email Routing DNS', api('DELETE', `/zones/${LIVE}/email/routing/dns`), both(LIVE_ZONE)],
  ['MUST 11 account custom page', api('PUT', '/accounts/{account}/custom_pages/basic_challenge', { body: { state: 'customized', url: 'https://example.net/' } }), both(SWITCH)],
  ['MUST 12a Pages project deleted (no live Pages project: open)', api('DELETE', '/accounts/{account}/pages/projects/demo'), both('open')],
  ['MUST 12b Pages rollback (no live Pages project: open)', api('POST', '/accounts/{account}/pages/projects/demo/deployments/d1/rollback', { body: {} }), both('open')],
  ['MUST 13 dispatch namespace deleted (no live dependency known here)', api('DELETE', '/accounts/{account}/workers/dispatch/namespaces/ns1'), atLevels('open', unclassifiedAt('workers/dispatch'))],
  ['MUST 14a live load balancer', api('PATCH', `/zones/${LIVE}/load_balancers/lb1`, { body: { enabled: false } }), both(LIVE_ZONE)],
  ['MUST 14b account pool (not a switch: open)', api('PATCH', '/accounts/{account}/load_balancers/pools/pool1', { body: { origins: [{ name: 'new', address: '192.0.2.1' }] } }), atLevels('open', unclassifiedAt('load_balancers'))],
  ['MUST 15a live custom hostname', api('PATCH', `/zones/${LIVE}/custom_hostnames/ch1`, { body: { custom_origin_server: 'other.example.net' } }), both(LIVE_ZONE)],
  ['MUST 15b live fallback origin', api('PUT', `/zones/${LIVE}/custom_hostnames/fallback_origin`, { body: { origin: 'other.example.net' } }), both(LIVE_ZONE)],
  ['MUST 15c live Spectrum app', api('DELETE', `/zones/${LIVE}/spectrum/apps/app1`), both(LIVE_ZONE)],
  ['MUST 16a tunnel deleted (serves the live host only through a live-zone record: open)', api('DELETE', '/accounts/{account}/cfd_tunnel/t1'), atLevels('open', unclassifiedAt('cfd_tunnel'))],
  ['MUST 16b tunnel ingress (open)', api('PUT', '/accounts/{account}/cfd_tunnel/t1/configurations', { body: { config: { ingress: [{ service: 'http_status:404' }] } } }), atLevels('open', unclassifiedAt('cfd_tunnel'))],
  ['MUST 16c hostname route (open)', api('DELETE', '/accounts/{account}/zerotrust/routes/hostname/r1'), atLevels('open', unclassifiedAt('zerotrust'))],
  ['MUST 16d network route (open)', api('PATCH', '/accounts/{account}/teamnet/routes/r1', { body: { tunnel_id: 't1' } }), atLevels('open', unclassifiedAt('teamnet'))],
  ['MUST 16e tunnel created with its secret', api('POST', '/accounts/{account}/cfd_tunnel', { body: { name: 't', tunnel_secret: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0' } }), both(APP_SECRET)],
  ['MUST 17a observability destination', api('PATCH', '/accounts/{account}/workers/observability/destinations/logsink', { body: { enabled: true, configuration: { type: 'logpush', url: 'https://example.net/', headers: {} } } }), both(SWITCH)],
  ['MUST 17b account Logpush job', api('POST', '/accounts/{account}/logpush/jobs', { body: { name: 'logs', dataset: 'workers_trace_events', enabled: true, destination_conf: 'https://example.net/' } }), both(SWITCH)],
  ['MUST 18a live schema validation', api('PUT', `/zones/${LIVE}/schema_validation/settings`, { body: { validation_default_mitigation_action: 'block' } }), both(LIVE_ZONE)],
  ['MUST 18b live schema validation operations', api('PATCH', `/zones/${LIVE}/schema_validation/settings/operations`, { body: { op1: { mitigation_action: 'block' } } }), both(LIVE_ZONE)],
  ['MUST 18c trusted JWT key deleted', api('DELETE', `/zones/${LIVE}/token_validation/config/c1`), both(withAlso(APP_SECRET, LIVE_ZONE))],
  ['MUST 18d JWT rule disabled', api('PATCH', `/zones/${LIVE}/token_validation/rules/r1`, { body: { enabled: false } }), both(withAlso(APP_SECRET, LIVE_ZONE))],
  ['MUST 18e JWT rule on another zone', api('PATCH', `/zones/${OTHER}/token_validation/rules/r1`, { body: { enabled: false } }), both(APP_SECRET)],
  ['MUST 18f JWT key credentials', api('PUT', `/zones/${OTHER}/token_validation/config/c1/credentials`, { body: { keys: [] } }), both(APP_SECRET)],
  ['MUST 19a user invitation accepted', api('PATCH', '/user/invites/i1', { body: { status: 'accepted' } }), both(MEMBERS)],
  ['MUST 19b dashboard SCIM deprovision', api('PATCH', '/accounts/{account}/scim/v2/Users/u1', { body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] } }), both(MEMBERS)],
  ['MUST 20a device registration revoked', api('DELETE', '/accounts/{account}/devices/registrations/r1'), both(ACCESS)],
  ['MUST 20b device settings', api('PATCH', '/accounts/{account}/devices/settings', { body: { disable_for_time: 3600 } }), both(ACCESS)],
  ['MUST 20c gateway configuration', api('PUT', '/accounts/{account}/gateway/configuration', { body: { settings: { tls_decrypt: { enabled: false } } } }), both(ACCESS)],
  ['MUST 20d gateway logging', api('PUT', '/accounts/{account}/gateway/logging', { body: { redact_pii: false, settings_by_rule_type: { http: { log_all: false, log_blocks: false } } } }), both(ACCESS)],
  ['MUST 21a another Worker secret', api('PUT', '/accounts/{account}/workers/scripts/helper/secrets', { body: { name: 'AUTH', text: 'synthetic-value', type: 'secret_text' } }), both(APP_SECRET)],
  ['MUST 21b another Worker secret deleted', api('DELETE', '/accounts/{account}/workers/scripts/helper/secrets/AUTH'), both(APP_SECRET)],
  ['MUST 21c Pages production secret', api('PATCH', '/accounts/{account}/pages/projects/demo', { body: { deployment_configs: { production: { env_vars: { AUTH: { type: 'secret_text', value: 'synthetic-value' } } } } } }), both(APP_SECRET)],
  ['MUST 21d Pages preview secret', api('PATCH', '/accounts/{account}/pages/projects/demo', { body: { deployment_configs: { preview: { env_vars: { AUTH: { type: 'secret_text', value: 'synthetic-value' } } } } } }), both(APP_SECRET)],
  ['MUST 22a Secrets Store secret', api('POST', '/accounts/{account}/secrets_store/stores/s1/secrets', { body: [{ name: 'AUTH', value: 'synthetic-value', scopes: ['workers'] }] }), both(APP_SECRET)],
  ['MUST 22b Hyperdrive password', api('PATCH', '/accounts/{account}/hyperdrive/configs/h1', { body: { origin: { password: 'synthetic-value' } } }), both(APP_SECRET)],
  ['MUST 23a Turnstile widget deleted', api('DELETE', '/accounts/{account}/challenges/widgets/w1'), both(APP_SECRET)],
  ['MUST 23b Stream signing key deleted', api('DELETE', '/accounts/{account}/stream/keys/k1'), both(APP_SECRET)],
  ['MUST 23c Calls app created', api('POST', '/accounts/{account}/calls/apps', { body: { name: 'demo' } }), both(APP_SECRET)],
  ['MUST 23d Calls app deleted', api('DELETE', '/accounts/{account}/calls/apps/a1'), both(APP_SECRET)],
  ['MUST 23e TURN key deleted', api('DELETE', '/accounts/{account}/calls/turn_keys/k1'), both(APP_SECRET)],
  ['MUST 23f Stream live input created (answers a stream key)', api('POST', '/accounts/{account}/stream/live_inputs', { body: { meta: { name: 'talk' } } }), both(APP_SECRET)],
  ['MUST 24a mTLS certificate with private key', api('POST', '/accounts/{account}/mtls_certificates', { body: { certificates: '<certificate>', private_key: '<private-key>' } }), both(APP_SECRET)],
  ['MUST 24b client certificate issued', api('POST', `/zones/${OTHER}/client_certificates`, { body: { csr: '<csr>', validity_days: 365 } }), both(APP_SECRET)],
  ['MUST 24c Origin CA certificate revoked', api('DELETE', '/certificates/c1'), both(APP_SECRET)],
  ['MUST 24d authenticated origin pulls off', api('PUT', `/zones/${OTHER}/origin_tls_client_auth/settings`, { body: { enabled: false } }), both(APP_SECRET)],
  ['MUST 25a device override codes', api('GET', '/accounts/{account}/devices/registrations/r1/override_codes'), both(CREDENTIAL_REFUSED)],
  ['MUST 25b device override codes, legacy path', api('GET', '/accounts/{account}/devices/d1/override_codes'), both(CREDENTIAL_REFUSED)],
  ['MUST 26a Images direct upload', api('POST', '/accounts/{account}/images/v2/direct_upload', { bodyKind: 'multipart', parts: [{ name: 'id', contentType: 'text/plain', text: 'img1' }] }), both(CREDENTIAL_REFUSED)],
  ['MUST 26b Stream direct upload', api('POST', '/accounts/{account}/stream/direct_upload', { body: { maxDurationSeconds: 60 } }), both(CREDENTIAL_REFUSED)],
  ['MUST 30a account subscription', api('POST', '/accounts/{account}/subscriptions', { body: paidPlan }), both(charge('paid-subscription'))],
  ['MUST 30b zone subscriptions', api('POST', `/zones/${OTHER}/subscriptions`, { body: paidPlan }), both(charge('paid-subscription'))],
  ['MUST 30c zone subscription created', api('POST', `/zones/${OTHER}/subscription`, { body: paidPlan }), both(charge('paid-subscription'))],
  ['MUST 30d zone subscription changed', api('PUT', `/zones/${OTHER}/subscription`, { body: paidPlan }), both(charge('paid-subscription'))],
  ['MUST 30e account subscription changed', api('PUT', '/accounts/{account}/subscriptions/s1', { body: paidPlan }), both(charge('paid-subscription'))],
  ['MUST 30f user subscription changed', api('PUT', '/user/subscriptions/s1', { body: paidPlan }), both(charge('paid-subscription'))],
  ['MUST 31a bulk subscriptions', api('POST', '/accounts/{account}/bulk/subscriptions', { body: { subscriptions: [paidPlan] } }), both(withAlso(charge('paid-subscription'), charge('paid-subscription-bulk')))],
  ['MUST 31b subscription append action', api('POST', '/accounts/{account}/subscriptions/s1/action/append', { body: paidPlan }), both(withAlso(charge('paid-subscription'), charge('paid-subscription-action')))],
  ['MUST 31c cancel a downgrade', api('POST', '/accounts/{account}/subscriptions/cancel-downgrade', { body: { subscription_ids: ['s1'] } }), both(charge('paid-subscription-action'))],
  ['MUST 32a domain registration', api('POST', '/accounts/{account}/registrar/registrations', { body: { domain_name: 'example.com' } }), both(charge('registrar-purchase'))],
  ['MUST 32b renewal authorised', api('PATCH', '/accounts/{account}/registrar/registrations/example.com', { body: { auto_renew: true } }), both(charge('registrar-renewal'))],
  ['MUST 32c legacy renewal authorised', api('PUT', '/accounts/{account}/registrar/domains/example.com', { body: { auto_renew: true } }), both(charge('registrar-renewal'))],
  ['MUST 32d transfer in', api('POST', '/accounts/{account}/registrar/registrations/example.com/transfer-in', { body: { auth_code: '<transfer-code>' } }), both(withAlso(charge('registrar-transfer'), APP_SECRET))],
  ['MUST 33a invoice paid', api('POST', '/accounts/{account}/pay-invoice', { body: { invoice_id: 'i1' } }), both(charge('billing-payment'))],
  ['MUST 33b bad debt paid', api('POST', '/accounts/{account}/pay-bad-debt', { body: {} }), both(charge('billing-payment'))],
  ['MUST 33c Argo enabled', api('PATCH', `/zones/${OTHER}/argo/smart_routing`, { body: { value: 'on' } }), both(charge('paid-routing-enable'))],
  ['MUST 33d Cache Reserve enabled', api('PATCH', `/zones/${OTHER}/cache/cache_reserve`, { body: { value: 'on' } }), both(charge('paid-storage-enable'))],
  ['SHOULD 1 live zone hold removed', api('DELETE', `/zones/${LIVE}/hold`), both(LIVE_ZONE)],
  ['SHOULD 2 live environment rollback', api('POST', `/zones/${LIVE}/environments/e1/rollback`, { body: {} }), both(LIVE_ZONE)],
  ['SHOULD 3a live catch-all mail rule', api('PUT', `/zones/${LIVE}/email/routing/rules/catch_all`, { body: { enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'forward', value: ['recipient@example.net'] }] } }), both(LIVE_ZONE)],
  ['SHOULD 3b catch-all on another zone (open)', api('PUT', `/zones/${OTHER}/email/routing/rules/catch_all`, { body: { enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'forward', value: ['recipient@example.net'] }] } }), both('open')],
  ['SHOULD 4 certificate pack order', api('POST', `/zones/${OTHER}/ssl/certificate_packs/order`, { body: { certificate_authority: 'lets_encrypt', hosts: ['example.com'], type: 'advanced', validation_method: 'txt', validity_days: 90 } }), both(charge('paid-certificate-order'))],
  ['SHOULD 5a AI Gateway top-up', api('POST', '/accounts/{account}/ai-gateway/billing/topup', { body: { amount: 1000 } }), both(charge('credit-purchase'))],
  ['SHOULD 5b AI Gateway automatic top-up', api('POST', '/accounts/{account}/ai-gateway/billing/topup/config', { body: { amount: 1000, threshold: 500 } }), both(charge('credit-purchase'))],
  ['SHOULD 6 metered AI run (a stated limit: open)', api('POST', '/accounts/{account}/ai/run/@cf/meta/llama-3.1-8b-instruct', { body: { prompt: 'hello' } }), both('open')],
]

/** What the door did with one request at one level, in the row's terms. */
async function verdictAt(level, input) {
  const door = harness({ environment: LEVEL_ENVS[level] }), answer = await door.send(input)
  neverCarries(answer.value)
  if (answer.value.code === 'CLASS3_WEBAUTHN_REQUIRED' && door.writes.length === 0) return answer.value.protection ?? 'held-without-reason'
  if (answer.status === 200 && door.writes.length === 1 && door.asked === 0) return 'open'
  if (door.writes.length === 0 && door.calls.every(call => call.method === 'GET') && typeof answer.value.code === 'string') return { refused: answer.value.code }
  return { other: answer.status, code: answer.value.code, writes: door.writes.length }
}

for (const [name, input, expected] of REVIEW2_ROWS) {
  test(`job 5 review row ${name}`, async () => {
    for (const level of ['open', 'guarded']) assert.deepEqual([level, await verdictAt(level, input)], [level, expected[level]])
  })
}

// MUST 27 to 29: answers that carry credentials. [name, path, answer, withheld].
const REVIEW2_ANSWERS = [
  ['MUST 27 plural client secrets', '/accounts/{account}/subscriptions', { success: true, result: { id: 's1', client_secrets: ['pi_synthetic_secret_0000000000000000'] } }, true],
  ['MUST 28a Logpush destination with an Authorization header', `/zones/${OTHER}/logpush/jobs/1`, { success: true, result: { id: 1, destination_conf: 'https://logs.example.net/ingest?header_Authorization=Bearer%20synthetic-0000' } }, true],
  ['MUST 28b Logpush R2 destination with access keys', '/accounts/{account}/logpush/jobs', { success: true, result: [{ id: 1, destination_conf: 'r2://logs/{DATE}?account-id=a1&access-key-id=k1&secret-access-key=s1' }] }, true],
  ['MUST 28c observability destination headers', '/accounts/{account}/workers/observability/destinations', { success: true, result: [{ slug: 'logsink', configuration: { url: 'https://example.net/', headers: { Authorization: 'Bearer synthetic' } } }] }, true],
  ['MUST 28d a Cookie header', '/accounts/{account}/workers/observability/destinations', { success: true, result: [{ configuration: { headers: { Cookie: 'session=synthetic' } } }] }, true],
  ['MUST 28e an X-Auth header', '/accounts/{account}/workers/observability/destinations', { success: true, result: [{ configuration: { headers: { 'X-Auth-Key': 'synthetic' } } }] }, true],
  ['MUST 28f a URL with user-info', '/accounts/{account}/queues', { success: true, result: [{ endpoint: 'https://user:synthetic@example.net/hook' }] }, true],
  ['MUST 28g a URL with a credential in its query', '/accounts/{account}/queues', { success: true, result: [{ endpoint: 'https://example.net/hook?token=synthetic' }] }, true],
  ['MUST 26c an uploadURL', '/accounts/{account}/images/v1', { success: true, result: { id: 'i1', uploadURL: 'https://upload.imagedelivery.net/synthetic/i1' } }, true],
  ['MUST 29a a cfk_ credential as plain data', '/accounts/{account}/storage/kv/namespaces/ns1/metadata/k', { success: true, result: { note: 'cfk_' + 'A'.repeat(40) } }, true],
  ['MUST 29b a cfut_ credential', '/zones', { success: true, result: [{ name: 'cfut_' + 'b'.repeat(40) }] }, true],
  ['MUST 29c a cfat_ credential', '/zones', { success: true, result: [{ name: 'x', comment: 'use cfat_' + 'C1'.repeat(20) }] }, true],
  ['MUST 28 a destination without a credential stays readable', `/zones/${OTHER}/logpush/jobs/1`, { success: true, result: { id: 1, destination_conf: 'https://logs.example.net/ingest' } }, false],
  ['MUST 28 a plain URL and empty headers stay readable', '/accounts/{account}/workers/observability/destinations', { success: true, result: [{ configuration: { url: 'https://example.net/a?page=2', headers: {} } }] }, false],
  ['MUST 29 (stated limit) an opaque stored credential is not recognised', '/accounts/{account}/storage/kv/namespaces/ns1/metadata/k', { success: true, result: { value: 'q8Zr2LkP0vXy7mNs3TaW' } }, false],
]
for (const [name, path, body, withheld] of REVIEW2_ANSWERS) {
  test(`job 5 answer row ${name}`, async () => {
    const answer = await harness({ environment: LEVEL_ENVS.open, answer: () => Response.json(body) }).send(api('GET', path))
    assert.deepEqual([name, answer.value.code === 'CLOUDFLARE_RESPONSE_WITHHELD'], [name, withheld])
    if (withheld) assert.equal(Object.hasOwn(answer.value, 'result'), false)
  })
}

test('job 5 R1: twenty live-zone writes of any family ask at both levels; the same paths on another zone are open; an unresolved zone asks', async () => {
  const paths = [['PATCH', 'settings/ssl'], ['PATCH', 'settings'], ['PUT', 'rulesets/phases/http_request_cache_settings/entrypoint'], ['POST', 'rulesets'],
    ['PUT', 'rulesets/r1'], ['POST', 'firewall/rules'], ['PUT', 'bot_management'], ['PATCH', 'pagerules/p1'], ['PATCH', 'waiting_rooms/w1'],
    ['PATCH', 'dnssec'], ['PUT', 'secondary_dns/incoming'], ['DELETE', 'email/routing/dns'], ['PUT', 'custom_hostnames/fallback_origin'],
    ['DELETE', 'spectrum/apps/a1'], ['PATCH', 'load_balancers/lb1'], ['PUT', 'schema_validation/settings'], ['DELETE', 'hold'],
    ['POST', 'environments/e1/rollback'], ['POST', 'logpush/jobs'], ['POST', 'something_new/x'], ['PUT', 'never_heard_of/deep/er'], ['POST', 'purge_cache']]
  assert.ok(paths.length >= 20)
  const input = (zone, [method, rest]) => api(method, `/zones/${zone}/${rest}`, method === 'DELETE' ? {} : { body: { value: 'x' } })
  for (const row of paths) {
    for (const level of ['open', 'guarded']) {
      assert.deepEqual([level, row.join(' '), await verdictAt(level, input(LIVE, row))], [level, row.join(' '), LIVE_ZONE])
      assert.deepEqual([level, row.join(' '), await verdictAt(level, input(OTHER, row))], [level, row.join(' '), 'open'])
    }
  }
  // A zone id the edge could not resolve (the lookup said null): it could be the live one, so it asks at both levels.
  for (const level of ['open', 'guarded']) {
    const verdict = classifyCloudflareRequest(input('1'.repeat(32), paths[19]), { accountId: ACCOUNT, level, facts: { zones: { ['1'.repeat(32)]: null } } })
    assert.deepEqual([level, verdict.verdict, verdict.family, verdict.reason], [level, 'protected', 'P1', 'zone-unresolved'])
    // Through the broker a failed zone lookup asks the fingerprint and sends nothing (it never opens).
    const door = harness({ environment: LEVEL_ENVS[level] }), answer = await door.send(input('0'.repeat(32), paths[19]))
    assert.deepEqual([answer.value.code, answer.value.protection, door.writes.length], ['CLASS3_WEBAUTHN_REQUIRED', { family: 'P1', reason: 'zone-unresolved' }, 0])
  }
})

test('job 5 R5a: every row of the credential vocabulary asks at both levels, in three spellings each', () => {
  // One example per row: [the row's run joined, the path under {account} (or the root it lives under), method].
  const examples = {
    secrets: '/accounts/{account}/workers/scripts/helper/secrets', secrets_store: '/accounts/{account}/secrets_store/stores/s1',
    keys: '/accounts/{account}/stream/keys/k1', turn_keys: '/accounts/{account}/calls/turn_keys/k1', credentials: `/zones/${OTHER}/token_validation/config/c1/credentials`,
    tokens: '/accounts/{account}/workers/scripts/helper/tokens', token: '/accounts/{account}/new_product/t1/token', token_validation: `/zones/${OTHER}/token_validation/rules/r1`,
    certificates: '/certificates/c1', client_certificates: `/zones/${OTHER}/client_certificates/c1`, mtls_certificates: '/accounts/{account}/mtls_certificates/m1',
    origin_tls_client_auth: `/zones/${OTHER}/origin_tls_client_auth/settings`, hyperdrive: '/accounts/{account}/hyperdrive/configs/h1',
    'challenges/widgets': '/accounts/{account}/challenges/widgets/w1', 'calls/apps': '/accounts/{account}/calls/apps/a1', 'stream/live_inputs': '/accounts/{account}/stream/live_inputs',
    'cfd_tunnel/*/management': '/accounts/{account}/cfd_tunnel/t1/management', scim: '/accounts/{account}/scim/v2/Groups/g1', invites: '/user/invites/i1',
    members: '/accounts/{account}/new_product/members/m1', roles: '/accounts/{account}/new_product/roles/r1', sso_connectors: '/accounts/{account}/sso_connectors/c1',
    devices: '/accounts/{account}/devices/posture/p1', 'gateway/configuration': '/accounts/{account}/gateway/configuration', 'gateway/logging': '/accounts/{account}/gateway/logging',
  }
  assert.deepEqual(CLOUDFLARE_CREDENTIAL_VOCABULARY.map(row => row.run.join('/')).sort(), Object.keys(examples).sort(), 'one example per row, no more')
  for (const row of CLOUDFLARE_CREDENTIAL_VOCABULARY) {
    assert.ok(['keys', 'app-secret', 'members', 'access'].includes(row.reason) && row.why.length > 10 && Object.isFrozen(row), row.run.join('/'))
    const path = examples[row.run.join('/')], method = row.methods?.[0] ?? 'PUT'
    const spellings = [api(method, path, { body: { v: 1 } }), api(method, path.toUpperCase().replace('{ACCOUNT}', '{account}'), { body: { v: 1 } }),
      api(row.methods ? method : 'DELETE', path.replace(/[a-z]/g, (letter, index) => (index % 2 ? letter.toUpperCase() : letter)).replace(/\{account\}/i, '{account}'))]
    for (const input of spellings) {
      for (const level of ['open', 'guarded']) {
        const verdict = classifyCloudflareRequest(input, { accountId: ACCOUNT, level, facts: { zones: { [OTHER]: 'example.org' } } })
        assert.deepEqual([level, input.method, input.path, verdict.verdict, verdict.family, verdict.reason], [level, input.method, input.path, 'protected', 'P2', row.reason])
      }
    }
  }
  // A method the row does not name passes it over (a live input edited, not made); reads stay open.
  assert.equal(classifyCloudflareRequest(api('PUT', '/accounts/{account}/stream/live_inputs/i1', { body: { meta: {} } }), { accountId: ACCOUNT, level: 'open' }).verdict, 'open')
  assert.equal(classifyCloudflareRequest(api('GET', '/accounts/{account}/workers/scripts/helper/secrets'), { accountId: ACCOUNT, level: 'open' }).verdict, 'open')
})

// Job 7: a credential a request carries is an application's (`app-secret`); only a Cloudflare
// credential format opens the account itself (`keys`). This test said `keys` for all of them.
test('job 5 R5b: a credential-shaped body asks (app-secret) on any path, at any depth, in any part; without it the same write is open', () => {
  const at = (input, level = 'open') => classifyCloudflareRequest(input, { accountId: ACCOUNT, level, facts: { zones: { [OTHER]: 'example.org' } } })
  const deep = { config: { origin: { auth: { client_secret: 'synthetic' } } } }, plain = { config: { origin: { auth: { client_id: 'synthetic' } } } }
  for (const path of [`/zones/${OTHER}/never_heard_of/x`, '/accounts/{account}/never-heard-of/x', '/brand-new-root/x']) {
    for (const level of ['open', 'guarded']) {
      const held = at(api('PUT', path, { body: deep }), level)
      assert.deepEqual([path, level, held.verdict, held.family, held.reason], [path, level, 'protected', 'P2', 'app-secret'])
    }
    assert.equal(at(api('PUT', path, { body: plain })).verdict, 'open', path)
  }
  // Every credential shape, in a body: the field names (plural too), a secret binding, a credential URL, a header.
  for (const body of [{ a: { b: { password: 'p' } } }, { a: [{ api_keys: ['k'] }] }, { client_secrets: ['s'] }, { a: { b: { auth_code: 'c' } } },
    { env_vars: { AUTH: { type: 'secret_text', value: 'v' } } }, { bindings: [{ type: 'Secret_Key', name: 'K' }] }, { a: { session_token: 'short' } },
    { destination_conf: 'https://logs.example.net/?header_Authorization=Bearer%20x' }, { hook: 'https://u:p@example.net/' }, { headers: { Authorization: 'Bearer x' } },
    { note: 'cfut_' + 'Zq'.repeat(20) }, [{ name: 'AUTH', value: 'v', private_keys: ['k'] }]]) {
    assert.deepEqual([JSON.stringify(body), at(api('POST', `/zones/${OTHER}/never_heard_of`, { body })).reason], [JSON.stringify(body), JSON.stringify(body).includes('cfut_') ? 'keys' : 'app-secret'])
  }
  // A text body and a multipart metadata part are read as JSON; a Worker's code is not.
  assert.equal(at(api('PUT', '/accounts/{account}/storage/kv/namespaces/ns1/values/k', { body: '{"a":{"b":{"pass\\u0077ord":"x"}}}', bodyKind: 'text', contentType: 'text/plain' })).reason, 'app-secret')
  const worker = (metadata, code = 'export default {}') => api('PUT', '/accounts/{account}/workers/scripts/notes-site', { bodyKind: 'multipart', parts: [
    { name: 'metadata', contentType: 'application/json', json: metadata }, { name: 'w.js', contentType: 'application/javascript+module', text: code }] })
  assert.equal(at(worker({ main_module: 'w.js', bindings: [{ type: 'secret_text', name: 'AUTH', text: 'v' }] })).reason, 'app-secret')
  assert.equal(at(worker({ main_module: 'w.js', bindings: [{ type: 'plain_text', name: 'API_KEY_NAME', text: 'public' }] }, 'const password = "not JSON"; export default {}')).verdict, 'open')
  // Harmless look-alikes stay open: numbers and booleans under credential names, token counts, empty values.
  for (const body of [{ max_tokens: 256, prompt: 'hi' }, { has_secret: true, secret: '' }, { requires_password: false }, { keys: [{ kty: 'RSA', n: 'x', e: 'AQAB' }] }]) {
    assert.deepEqual([JSON.stringify(body), at(api('POST', `/zones/${OTHER}/never_heard_of`, { body })).verdict], [JSON.stringify(body), 'open'])
  }
})

test('job 5 C5: a charge-shaped path asks at both levels under a family nobody listed; metered use stays open', () => {
  for (const [path, reason] of [['/accounts/{account}/new-product/subscriptions', 'paid-subscription'], [`/zones/${OTHER}/brand_new/Subscriptions/x`, 'paid-subscription'],
    ['/accounts/{account}/new-product/billing/plan', 'billing'], ['/brand-new-root/x/pay-invoice', 'billing-payment'], ['/accounts/{account}/x/TopUp', 'credit-purchase'],
    [`/zones/${LIVE}/argo/smart_routing`, 'paid-routing-enable'], ['/accounts/{account}/registrar/domains/example.org/transfer-out', 'registrar-transfer']]) {
    for (const level of ['open', 'guarded']) {
      // Job 7: every rule reads the request, the zone rule too, so a pure call gives the zones' names.
      const verdict = classifyCloudflareRequest(api('PATCH', path, { body: { value: 'on' } }), { accountId: ACCOUNT, level, facts: { zones: { [OTHER]: 'example.org', [LIVE]: 'example.invalid' } } })
      assert.deepEqual([path, level, verdict.verdict, verdict.family, verdict.reason], [path, level, 'protected', 'P4', reason])
    }
  }
  assert.ok(CLOUDFLARE_CHARGES.every(row => row.why.length > 10 && Object.isFrozen(row)))
  // The edge passes P4 through to her answer; the owner's passkey on the exact bytes sends it, once.
  assert.ok(CLOUDFLARE_PROTECTED_FAMILIES.includes('P4'))
  // Metered use is not held (a stated limit): a model run, a stored object, a GET of the bill.
  for (const input of [api('POST', '/accounts/{account}/ai/run/@cf/meta/llama-3.1-8b-instruct', { body: { prompt: 'hi' } }),
    api('PUT', '/accounts/{account}/storage/kv/namespaces/ns1/values/k', { body: 'v', bodyKind: 'text', contentType: 'text/plain' }), api('GET', '/accounts/{account}/subscriptions')]) {
    assert.equal(classifyCloudflareRequest(input, { accountId: ACCOUNT, level: 'open' }).verdict, 'open', input.path)
  }
})

test('job 5 C5: a held charge reaches her with its reason, and the owner\'s passkey sends it once', async () => {
  const input = api('POST', '/accounts/{account}/subscriptions', { body: { rate_plan: { id: 'paid' } } })
  const door = harness({ environment: LEVEL_ENVS.open }), held = await door.send(input)
  assert.deepEqual([held.status, held.value.code, held.value.protection], [403, 'CLASS3_WEBAUTHN_REQUIRED', { family: 'P4', reason: 'paid-subscription' }])
  const approved = harness({ environment: LEVEL_ENVS.open }), through = await approved.approve(input)
  assert.deepEqual([through.status, approved.consumed, approved.writes.length], [200, 1, 1])
})

test('job 5 plural rule: plural credential names are credential names, in answers and bodies', () => {
  for (const [field, value] of [['client_secrets', ['s']], ['api_keys', ['k']], ['passwords', ['p']], ['private_keys', ['k']], ['access_tokens', ['t'.repeat(24)]], ['uploadURLs', ['u']], ['jwts', ['j']]]) {
    assert.equal(credentialShaped({ result: { [field]: value } }), true, field)
    assert.equal(bodyCarriesCredential({ a: { [field]: value } }), true, field)
  }
  assert.equal(credentialShaped({ result: { prompt_tokens: 12, statuses: ['ok'], has_secrets: false } }), false)
})

test('job 5 R3 and C2: the live Worker\'s own settings say what it is made of; a failed read asks; without the lookup the checkout decides', () => {
  const settings = { success: true, result: { bindings: [
    { type: 'service', name: 'AUTH', service: 'auth-helper', environment: 'production' }, { type: 'dispatch_namespace', name: 'T', namespace: 'tenants' },
    { type: 'kv_namespace', name: 'K', namespace_id: 'abcdef0123456789abcdef0123456789' }, { type: 'd1', name: 'D', id: '0d100000-0000-4000-8000-00000000d1d1' },
    { type: 'r2_bucket', name: 'B', bucket_name: 'photos-live' }, { type: 'queue', name: 'Q', queue_name: 'jobs-live' },
    { type: 'durable_object_namespace', name: 'H', class_name: 'X61HeadDurableObject' }, { type: 'plain_text', name: 'P', text: 'production' }],
  tail_consumers: [{ service: 'tail-logger' }] } }
  const known = liveWorkerFacts(settings)
  assert.deepEqual(known.workers.sort(), ['auth-helper', 'tail-logger'])
  assert.deepEqual(known.dispatch, ['tenants'])
  assert.deepEqual(known.storage.sort(), ['0d100000-0000-4000-8000-00000000d1d1', 'abcdef0123456789abcdef0123456789', 'jobs-live', 'photos-live'])
  for (const bad of [null, {}, { success: false, result: { bindings: [] } }, { success: true, result: {} }, { success: true, result: { bindings: [1] } }, { success: true, result: { bindings: [], tail_consumers: 'x' } }]) {
    assert.equal(liveWorkerFacts(bad), null, JSON.stringify(bad))
  }
  const facts = liveWorker => ({ boundIds: [HEAD_NS, MIRROR_NS], liveWorker, workers: { [`${ACCOUNT}/7a11`]: 'tail-logger' }, pages: { [`${ACCOUNT}/p`]: { domains: ['p.pages.dev'], envVars: {} } } })
  const at = (input, liveWorker, level = 'open', lookups = []) => classifyCloudflareRequest(input, { accountId: ACCOUNT, level, lookups, facts: facts(liveWorker) })
  const held = [
    ['live-dependency', api('PUT', '/accounts/{account}/workers/scripts/AUTH-HELPER', { body: 'export default {}', bodyKind: 'text', contentType: 'application/javascript' })],
    ['live-dependency', api('DELETE', '/accounts/{account}/workers/scripts/tail-logger')],
    ['live-dependency', api('PATCH', '/accounts/{account}/workers/services/auth-helper/environments/production', { body: {} })],
    ['live-dependency', api('DELETE', '/accounts/{account}/workers/dispatch/namespaces/tenants')],
    ['live-dependency', api('PUT', '/accounts/{account}/workers/dispatch/namespaces/Tenants/scripts/any', { body: 'x', bodyKind: 'text', contentType: 'application/javascript' })],
    ['live-dependency', api('DELETE', '/accounts/{account}/workers/workers/7a11')],
    ['bound-storage', api('DELETE', '/accounts/{account}/storage/kv/namespaces/abcdef0123456789abcdef0123456789')],
    ['bound-storage', api('DELETE', '/accounts/{account}/d1/database/0D10000000004000800000000000D1D1')],
    ['bound-storage', api('DELETE', '/accounts/{account}/r2/buckets/Photos-Live')],
    ['bound-storage', api('PATCH', '/accounts/{account}/pages/projects/p', { body: { deployment_configs: { production: { r2_buckets: { B: { name: 'photos-live' } } } } } })],
  ]
  for (const [reason, input] of held) {
    for (const level of ['open', 'guarded']) {
      const verdict = at(input, known, level)
      assert.deepEqual([input.path, level, verdict.verdict, verdict.reason], [input.path, level, 'protected', reason])
    }
    // Job 7: a failed read holds EVERY write as `live-facts-unresolved`. This row said a
    // store NAME in another family's body (the Pages project) was a stated limit and opened when the read failed: it is
    // held now, like every other write. With no lookup in this caller, the checkout's list decides (none of these is on it).
    const unread = at(input, null)
    assert.deepEqual([input.path, unread.verdict, unread.protection.family, unread.protection.reason === 'live-facts-unresolved' || unread.protection.also?.some(pair => pair.reason === 'live-facts-unresolved')], [input.path, 'protected', 'P1', true])
    assert.equal(at(input, undefined).verdict, 'open', input.path)
  }
  assert.equal(at(api('PATCH', '/accounts/{account}/pages/projects/p', { body: { kv: '0d100000-0000-4000-8000-00000000d1d1' } }), null).reason, 'live-facts-unresolved')
  // Her own other Workers and stores stay open when the read says the live Worker does not use them.
  for (const input of [api('DELETE', '/accounts/{account}/workers/scripts/notes-site'), api('DELETE', '/accounts/{account}/r2/buckets/photos'),
    api('DELETE', '/accounts/{account}/workers/dispatch/namespaces/other-tenants')]) {
    assert.equal(at(input, known).verdict, 'open', input.path)
  }
  // Job 7: a caller that can read the live home's facts (the broker: 'live') is asked for them first, for
  // EVERY write, whatever its family (it was: only for a Worker, dispatch namespace or store write); never for a read.
  const asked = at(api('DELETE', '/accounts/{account}/workers/scripts/notes-site'), undefined, 'open', ['live'])
  assert.deepEqual(asked.needs, [{ kind: 'live', account: ACCOUNT }])
  assert.equal(at(api('GET', '/accounts/{account}/workers/scripts/notes-site'), undefined, 'open', ['live']).verdict, 'open')
  assert.deepEqual(at(api('POST', '/accounts/{account}/ai/run/m', { body: { prompt: 'x' } }), undefined, 'open', ['live']).needs, [{ kind: 'live', account: ACCOUNT }])
})

// ---- R1 by reference and C5 by body. Same row shape as REVIEW2_ROWS.
// SHOULD 1: an account-level endpoint that writes a record into example.invalid by a zone id (or zone name) in its body, or by
// a custom-domain host on that zone, is a write to the live zone. SHOULD 2: a zone's paid plan changed through Edit Zone.
const REVIEW3_ROWS = [
  ['SHOULD 1a R2 custom domain on the live zone by zoneId', api('POST', '/accounts/{account}/r2/buckets/pub/domains/custom', { body: { domain: 'files.example.invalid', zoneId: LIVE, enabled: true } }), both(LIVE_ZONE)],
  ['SHOULD 1b Worker custom domain on the live zone by zone_id', api('PUT', '/accounts/{account}/workers/domains', { body: { hostname: 'docs.example.invalid', zone_id: LIVE, service: 'docs' } }), both(LIVE_ZONE)],
  ['SHOULD 1c Worker custom domain on the live zone with no zone id (its host)', api('PUT', '/accounts/{account}/workers/domains', { body: { hostname: 'Docs.Example.invalid', service: 'docs' } }), both(LIVE_ZONE)],
  ['SHOULD 1d R2 custom domain on the live zone removed by its path', api('DELETE', '/accounts/{account}/r2/buckets/pub/domains/custom/files.example.invalid'), both(LIVE_ZONE)],
  ['SHOULD 1e Pages custom domain on the live zone', api('POST', '/accounts/{account}/pages/projects/notes/domains', { body: { name: 'notes.example.invalid' } }), both(LIVE_ZONE)],
  ['SHOULD 1f a live zone id at depth in an unlisted account family', api('POST', '/accounts/{account}/brand_new/x', { body: { target: { zone_id: LIVE } } }), both(LIVE_ZONE)],
  ['SHOULD 1g the live zone by name in an unlisted account family', api('POST', '/accounts/{account}/brand_new/x', { body: { zoneName: 'EXAMPLE.INVALID' } }), both(LIVE_ZONE)],
  ['SHOULD 1h a zone id that is not an id asks', api('POST', '/accounts/{account}/r2/buckets/pub/domains/custom', { body: { domain: 'files.example.org', zoneId: 'not-an-id', enabled: true } }), both({ family: 'P1', reason: 'zone-unresolved' })],
  ['SHOULD 1i R2 custom domain on another zone stays open', api('POST', '/accounts/{account}/r2/buckets/pub/domains/custom', { body: { domain: 'files.example.org', zoneId: OTHER, enabled: true } }), both('open')],
  ['SHOULD 1j Worker custom domain on another zone stays open', api('PUT', '/accounts/{account}/workers/domains', { body: { hostname: 'docs.example.org', zone_id: OTHER, service: 'docs' } }), both('open')],
  ['SHOULD 2a a paid plan through Edit Zone on another zone', api('PATCH', `/zones/${OTHER}`, { body: { plan: { id: 'synthetic-pro-plan' } } }), both(charge('paid-subscription'))],
  ['SHOULD 2b a rate plan at depth on a path nobody listed', api('POST', '/accounts/{account}/brand_new/x', { body: { items: [{ rate_plan: { id: 'synthetic-paid-plan' } }] } }), both(charge('paid-subscription'))],
  ['SHOULD 2c Edit Zone without a plan on another zone stays open', api('PATCH', `/zones/${OTHER}`, { body: { paused: false } }), both('open')],
]
for (const [name, input, expected] of REVIEW3_ROWS) {
  test(`review row ${name}`, async () => {
    for (const level of ['open', 'guarded']) assert.deepEqual([level, await verdictAt(level, input)], [level, expected[level]])
  })
}

test('A zone named by reference is looked up like a zone in the path; one the edge cannot resolve asks', () => {
  const input = api('PUT', '/accounts/{account}/workers/domains', { body: { hostname: 'docs.example.net', zone_id: '1'.repeat(32), service: 'docs' } })
  const first = classifyCloudflareRequest(input, { accountId: ACCOUNT, level: 'open', facts: { boundIds: [] } })
  assert.deepEqual(first.needs, [{ kind: 'zone', zoneId: '1'.repeat(32) }])
  for (const level of ['open', 'guarded']) {
    const unresolved = classifyCloudflareRequest(input, { accountId: ACCOUNT, level, facts: { boundIds: [], zones: { ['1'.repeat(32)]: null } } })
    assert.deepEqual([level, unresolved.verdict, unresolved.reason], [level, 'protected', 'zone-unresolved'])
    const live = classifyCloudflareRequest(input, { accountId: ACCOUNT, level, facts: { boundIds: [], zones: { ['1'.repeat(32)]: 'example.invalid' } } })
    assert.deepEqual([level, live.verdict, live.reason], [level, 'protected', 'live-zone'])
  }
  assert.equal(classifyCloudflareRequest(input, { accountId: ACCOUNT, level: 'open', facts: { boundIds: [], zones: { ['1'.repeat(32)]: 'example.net' } } }).verdict, 'open')
  // Through the broker a zone id that fails its lookup asks the fingerprint (it never opens).
  return harness({ environment: LEVEL_ENVS.open }).send(api('PUT', '/accounts/{account}/workers/domains', { body: { hostname: 'docs.example.net', zone_id: '0'.repeat(32), service: 'docs' } }))
    .then(answer => assert.deepEqual([answer.value.code, answer.value.protection], ['CLASS3_WEBAUTHN_REQUIRED', { family: 'P1', reason: 'zone-unresolved' }]))
})

// Job 6: the door end to end at the level in force (`open`), one row per core family and three open requests: her tool
// call, the classifier, hold or pass, the owner's approval for a held one (the suite's synthetic approval), the request
// the fake Cloudflare receives, and the answer she gets after the screen. A held request not approved reaches Cloudflare
// zero times. The same rows (requests and sentences) are on the owner's card in outward-cloudflare.client.spec.ts.
const LIFECYCLE = { rules: [{ id: 'expire-old', enabled: true, conditions: { prefix: 'tmp/' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } } }] }
const END_TO_END = [
  ['C1 live zone', api('PATCH', `/zones/${LIVE}/settings/ssl`, { body: { value: 'flexible' } }), { family: 'P1', reason: 'live-zone' }],
  ['C1 account switch', api('POST', '/accounts/{account}/rulesets', { body: { kind: 'custom', phase: 'http_request_firewall_custom', rules: [{ expression: '(ip.src==192.0.2.1)', action: 'block' }] } }), { family: 'P1', reason: 'account-switch' }],
  ['C2 storage', api('PUT', '/accounts/{account}/r2/buckets/your-node-archive/lifecycle', { body: LIFECYCLE }), { family: 'P1', reason: 'bound-storage' }],
  ['C3 credentials', api('POST', '/accounts/{account}/members', { body: { email: 'friend@example.org', roles: ['0123456789abcdef0123456789abcdef'], status: 'pending' } }), { family: 'P2', reason: 'members' }],
  ['C4 deletion', api('DELETE', `/zones/${OTHER}`), { family: 'P3', reason: 'zone-deletion' }],
  ['C5 charge', api('POST', '/accounts/{account}/subscriptions', { body: { rate_plan: { id: 'business' }, frequency: 'monthly' } }), { family: 'P4', reason: 'paid-subscription' }],
  ['open: another zone\'s DNS record', api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'CNAME', name: 'docs.example.org', content: 'notes-site.example.net', proxied: true } }), 'open'],
  ['open: her own Worker\'s code', api('PUT', '/accounts/{account}/workers/scripts/notes-site', { body: "export default { fetch() { return new Response('notes') } }", bodyKind: 'text', contentType: 'application/javascript' }), 'open'],
  ['open: an R2 bucket not bound to the live home', api('PUT', '/accounts/{account}/r2/buckets/notes-photos/lifecycle', { body: LIFECYCLE }), 'open'],
]
// The facts the broker looks up for these rows, as the fake Cloudflare answers them.
const END_TO_END_FACTS = () => ({ zones: { [LIVE]: 'example.invalid', [OTHER]: 'example.org' }, dnsRecords: {}, routes: {}, domains: {}, workers: {},
  boundIds: [HEAD_NS, MIRROR_NS], liveWorker: liveWorkerFacts(LIVE_SETTINGS) })
for (const [name, call, expected] of END_TO_END) {
  test(`job 6 end to end at open: ${name}`, async () => {
    // The classifier, with the facts the broker would have looked up.
    const verdict = classifyCloudflareRequest(call, { accountId: ACCOUNT, level: 'open', facts: END_TO_END_FACTS(), lookups: ['liveWorker'] })
    if (expected === 'open') assert.equal(verdict.verdict, 'open', name)
    else assert.deepEqual([verdict.verdict, verdict.family, verdict.reason], ['protected', expected.family, expected.reason], name)
    const door = harness({ environment: LEVEL_ENVS.open })
    const target = `${API}${call.path.replace('{account}', ACCOUNT)}`
    const reachedTarget = () => door.calls.filter(item => item.url === target && item.method === call.method).length
    let answer
    if (expected === 'open') {
      // Open: sent once, no approval asked.
      answer = await door.send(call)
      assert.deepEqual([answer.status, door.asked, door.consumed], [200, 0, 0], name)
    } else {
      // Held: nothing reaches Cloudflare; she gets the reason; it waits for the owner.
      const held = await door.send(call)
      assert.deepEqual([held.status, held.value.code, held.value.protection], [403, 'CLASS3_WEBAUTHN_REQUIRED', expected], name)
      assert.deepEqual([reachedTarget(), door.writes.length], [0, 0], name + ': a held request not approved reaches Cloudflare zero times')
      // An approval for other bytes does not send it either.
      const other = await door.send({ ...call, expect: held.value.protection }, { token: door.grant({ ...call, path: call.path + '-other', expect: held.value.protection }) })
      assert.equal(other.status, 403, name)
      assert.deepEqual([reachedTarget(), door.writes.length], [0, 0], name + ': an approval of other bytes sends nothing')
      // The owner's passkey on these exact bytes: sent once, the approval spent.
      answer = await door.approve(call, { expect: held.value.protection })
      assert.deepEqual([answer.status, door.consumed], [200, 1], name)
    }
    // What the fake Cloudflare received: the one write, to the path she named (account filled in), with the canonical bytes.
    assert.deepEqual([reachedTarget(), door.writes.length], [1, 1], name)
    assert.equal(door.writes[0].url, target, name)
    assert.equal(door.writes[0].method, call.method, name)
    if (call.body === undefined) assert.equal(door.writes[0].body, undefined, name)
    else if (call.bodyKind === 'text') assert.equal(door.writes[0].body, call.body, name)
    else assert.equal(door.writes[0].body, canonicalJson(call.body), name)
    // The answer she gets after the screen: Cloudflare's result, her own path, nothing withheld, no key, no sign-in address.
    assert.equal(answer.value.ok, true, name)
    assert.deepEqual([answer.value.method, answer.value.path, answer.value.result], [call.method, call.path, { id: 'created' }], name)
    assert.equal(answer.value.withheld, undefined, name)
    neverCarries(answer.value)
  })
}

test('job 6: a plain-text answer carrying a Cloudflare credential format is withheld whole; the same text without it is not', async () => {
  const text = body => () => new Response(body, { headers: { 'content-type': 'text/plain' } })
  const read = api('GET', `/zones/${OTHER}/dns_records/export`)
  for (const prefix of ['cfk_', 'cfut_', 'cfat_']) {
    const answer = await harness({ answer: text(`docs.example.org. 300 IN TXT "${prefix}${'A1b2'.repeat(6)}"\n`) }).send(read)
    assert.deepEqual([prefix, answer.value.code, answer.value.withheld], [prefix, 'CLOUDFLARE_RESPONSE_WITHHELD', true])
    assert.equal(JSON.stringify(answer.value).includes(prefix + 'A1b2'), false, prefix)
  }
  const plain = await harness({ answer: text('docs.example.org. 300 IN TXT "hello"\n') }).send(read)
  assert.deepEqual([plain.status, plain.value.ok, plain.value.withheld], [200, true, undefined])
})

// ---- Review (SHOULD 1 and 2): the broker's own read of the live Worker's settings (C2), through the
// harness: a store bound only there asks, a failed read asks, the read is made again for every write that needs it, and
// the kept Durable Object ids are dropped around an approved write. Made-up ids only.
const KV_LIVE = '6b76' + '0'.repeat(26) + 'b1', KV_OTHER = '6b76' + '0'.repeat(26) + 'c2'
const KV_BINDING = { type: 'kv_namespace', name: 'NOTES', namespace_id: KV_LIVE }
const settingsWith = (...extra) => ({ ...LIVE_SETTINGS, result: { ...LIVE_SETTINGS.result, bindings: [...LIVE_SETTINGS.result.bindings, ...extra] } })
const settingsReads = door => door.calls.filter(call => call.method === 'GET' && LIVE_SETTINGS_PATH.test(new URL(call.url).pathname.slice('/client/v4'.length))).length
const herWorker = api('PUT', '/accounts/{account}/workers/scripts/notes-site', { body: 'export default {}', bodyKind: 'text', contentType: 'application/javascript' })

test('A store the live Worker binds only in its settings asks (bound-storage); approved, it goes once', async () => {
  const call = api('DELETE', `/accounts/{account}/storage/kv/namespaces/${KV_LIVE}`), target = `${API}/accounts/${ACCOUNT}/storage/kv/namespaces/${KV_LIVE}`
  const door = harness({ environment: LEVEL_ENVS.open, settings: () => Response.json(settingsWith(KV_BINDING)) })
  const held = await door.send(call)
  assert.deepEqual([held.status, held.value.code, held.value.protection], [403, 'CLASS3_WEBAUTHN_REQUIRED', { family: 'P1', reason: 'bound-storage' }])
  assert.deepEqual([door.writes.length, settingsReads(door)], [0, 1], 'held after one read of the settings; nothing sent')
  assert.equal(door.calls.find(item => LIVE_SETTINGS_PATH.test(new URL(item.url).pathname.slice('/client/v4'.length))).headers.get('x-auth-key'), KEY, 'the same auth helper')
  const approved = await door.approve(call, { expect: held.value.protection })
  assert.deepEqual([approved.status, door.consumed, door.writes.length, door.writes[0].url, door.writes[0].method], [200, 1, 1, target, 'DELETE'])
  // The same namespace while the live Worker does not bind it: open, so it was the settings read that held it.
  const unbound = harness({ environment: LEVEL_ENVS.open })
  assert.deepEqual([(await unbound.send(call)).status, unbound.asked, unbound.writes.length, settingsReads(unbound)], [200, 0, 1, 1])
})

// Job 7: this test said a failed settings read held a store as `bound-id-unresolved`
// and a Worker as `live-dependency-unresolved`. It holds every write now, as `live-facts-unresolved`; and a settings
// answer that is a success but not understood whole (a binding without its type or identifier, a type the door does not
// know) is unresolved too, never an empty inventory.
test('and job 7: a failed or malformed settings read holds every write (live-facts-unresolved) and sends nothing', async () => {
  const failures = [
    () => Response.json({ success: false, errors: [{ code: 10000, message: 'Internal error' }], result: null }, { status: 500 }),
    () => { throw new Error('connection reset') },
    () => new Response('<html>busy</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => Response.json({ success: true, errors: [], messages: [], result: { bindings: 'not a list' } }),
    // The review's malformed successes: a binding with nothing in it; a KV binding without its namespace id; a type nobody knows.
    () => Response.json({ success: true, errors: [], messages: [], result: { bindings: [{}] } }),
    () => Response.json(settingsWith({ type: 'kv_namespace', name: 'DATA' })),
    () => Response.json(settingsWith({ type: 'brand_new_binding', name: 'X', thing_id: 'x' })),
  ]
  const store = api('DELETE', `/accounts/{account}/storage/kv/namespaces/${KV_OTHER}`), bucket = api('DELETE', '/accounts/{account}/r2/buckets/live-data-bucket')
  for (const [index, settings] of failures.entries()) {
    for (const call of [store, herWorker, bucket]) {
      const reason = 'live-facts-unresolved'
      const door = harness({ environment: LEVEL_ENVS.open, settings }), answer = await door.send(call)
      assert.deepEqual([index, reason, answer.status, answer.value.code, answer.value.protection], [index, reason, 403, 'CLASS3_WEBAUTHN_REQUIRED', { family: 'P1', reason }])
      assert.deepEqual([index, reason, door.writes.length, settingsReads(door)], [index, reason, 0, 1])
      // Never refused outright: The owner's passkey on these exact bytes sends it.
      const through = await door.approve(call, { expect: answer.value.protection })
      assert.deepEqual([index, reason, through.status, door.consumed, door.writes.length], [index, reason, 200, 1, 1])
    }
  }
})

test('The settings are read again for every write that needs them, so a binding an approved write adds holds the next write', async () => {
  let bound = false
  const door = harness({ environment: LEVEL_ENVS.open, settings: () => Response.json(bound ? settingsWith(KV_BINDING) : LIVE_SETTINGS),
    answer: (_url, init) => { if (init.method !== 'GET') bound = bound || init.body?.includes?.(KV_LIVE) === true; return Response.json({ success: true, errors: [], messages: [], result: { id: 'created' } }) } })
  for (const round of [1, 2, 3]) {
    assert.equal((await door.send(herWorker)).status, 200)
    assert.equal(settingsReads(door), round, 'one read per write, none kept')
  }
  // The reviewer's case: a new version of the live Worker (by id) that binds a new KV namespace and names the live host,
  // approved by the owner. It is held as `live-host` first and, job 7, `live-worker` too.
  const version = api('POST', '/accounts/{account}/workers/workers/0a1b2c/versions', { body: { main_module: 'worker.js', bindings: [KV_BINDING], vars: { PUBLIC_HOST: 'node.example.invalid' } } })
  const held = await door.send(version)
  assert.deepEqual([held.status, held.value.protection], [403, { family: 'P1', reason: 'live-host', also: [{ family: 'P1', reason: 'live-worker' }] }])
  assert.equal((await door.approve(version, { expect: held.value.protection })).status, 200)
  assert.equal(bound, true)
  // Within the same minute, a delete of the namespace it now binds asks the fingerprint and sends nothing.
  const writes = door.writes.length, reads = settingsReads(door)
  const remove = await door.send(api('DELETE', `/accounts/{account}/storage/kv/namespaces/${KV_LIVE}`))
  assert.deepEqual([remove.status, remove.value.protection], [403, { family: 'P1', reason: 'bound-storage' }])
  assert.deepEqual([door.writes.length, settingsReads(door)], [writes, reads + 1])
})

// Job 7: this test said the Durable Object ids were kept between plain writes and dropped around an approved
// one. Nothing is kept now: every write reads the list, including one made while an approved write is in flight.
test('job 7: the Durable Object namespace list is read for every write, also while an approved write is in flight; none is kept', async () => {
  const environment = env({ CLOUDFLARE_ACCOUNT_ID: 'c1ea0000000000000000000000000002', CLOUDFLARE_DOOR_LEVEL: 'open' })
  const write = api('PATCH', '/accounts/{account}/pages/projects/helper', { body: { deployment_configs: { production: { durable_object_namespaces: { H: { namespace_id: OTHER_NS } } } } } })
  let reads = 0
  const namespaces = () => { reads++; return Response.json(NAMESPACES) }
  const plain = () => harness({ environment, namespaces })
  assert.equal((await plain().send(write)).status, 200)
  assert.equal((await plain().send(write)).status, 200)
  assert.equal(reads, 2, 'read for each plain write')
  const deletion = api('DELETE', `/zones/${OTHER}`)
  let during = null
  const door = harness({ environment, namespaces, answer: async (url, init) => {
    if (init.method === 'DELETE') { during = reads; assert.equal((await plain().send(write)).status, 200) }
    return Response.json({ success: true, errors: [], messages: [], result: { id: 'created' } })
  } })
  assert.equal((await door.approve(deletion, { expect: { family: 'P3', reason: 'zone-deletion' } })).status, 200)
  assert.deepEqual([during, reads], [3, 4], 'the approved write read it once; the write in flight read it again')
  assert.equal((await plain().send(write)).status, 200)
  assert.equal(reads, 5)
})

// ---- the third outside review (an outside review), closed by structure: one set of views read by
// every rule, the live home's facts before any decision, every reason collected.
// Each row is the review's exact input (made-up ids and names), failing on an earlier commit and passing here.
const held = async (input, environment = LEVEL_ENVS.open, more = {}) => {
  const door = harness({ environment, ...more }), answer = await door.send(input)
  assert.equal(door.writes.length, 0, `${input.method} ${input.path}: nothing written`)
  return answer.status === 403 && answer.value.code === 'CLASS3_WEBAUTHN_REQUIRED' ? answer.value.protection : { status: answer.status, code: answer.value.code }
}
const bothLevels = async (input, expected, more = {}) => {
  for (const level of ['open', 'guarded']) assert.deepEqual([level, input.method, input.path, await held(input, LEVEL_ENVS[level], more)], [level, input.method, input.path, expected])
}

test('job 7 MUST 1: the settings parser reads every identifier the binding schema carries; a write to any of them is held', async () => {
  const outbound = { type: 'dispatch_namespace', name: 'TENANTS', namespace: 'tenant-scripts', outbound: { worker: { service: 'outbound-helper' } } }
  const counter = { type: 'durable_object_namespace', name: 'COUNTER', class_name: 'Counter', script_name: 'counter-worker', dispatch_namespace: 'tenant-scripts' }
  const workflow = { type: 'workflow', name: 'WORKFLOW', workflow_name: 'live-jobs', script_name: 'workflow-helper', class_name: 'Jobs' }
  // The review's three pairs.
  for (const [binding, input] of [[outbound, api('DELETE', '/accounts/{account}/workers/scripts/outbound-helper')],
    [counter, api('DELETE', '/accounts/{account}/workers/dispatch/namespaces/tenant-scripts')], [workflow, api('DELETE', '/accounts/{account}/workflows/live-jobs')]]) {
    await bothLevels(input, { family: 'P1', reason: 'live-dependency' }, { settings: () => Response.json(settingsWith(binding)) })
    // The same request while the live Worker does not bind it: open at `open`.
    assert.equal(await verdictAt('open', input), 'open', input.path)
  }
  // Every type and member of the table, read by liveWorkerFacts.
  const all = settingsWith(outbound, counter, workflow, { type: 'service', name: 'S', service: 'svc-helper' }, { type: 'queue', name: 'Q', queue_name: 'live-tasks' },
    { type: 'kv_namespace', name: 'K', namespace_id: KV_LIVE }, { type: 'd1', name: 'D', database_id: 'd1d1d1d1-0000-4000-8000-00000000d1d1' }, { type: 'r2_bucket', name: 'B', bucket_name: 'live-data-bucket' },
    { type: 'hyperdrive', name: 'H', id: 'hd000000000000000000000000000001' }, { type: 'vectorize', name: 'V', index_name: 'live-index' }, { type: 'analytics_engine', name: 'A', dataset: 'live-events' },
    { type: 'mtls_certificate', name: 'M', certificate_id: 'mtls-cert-1' }, { type: 'secrets_store_secret', name: 'SS', store_id: 'store-one', secret_name: 'live-secret' },
    { type: 'pipelines', name: 'P', pipeline: 'live-pipeline' }, ...CLOUDFLARE_BINDING_PLAIN.map(type => ({ type, name: type.toUpperCase() })))
  const known = liveWorkerFacts(all)
  assert.deepEqual([known.workers.sort(), known.dispatch.sort(), known.workflows, known.queues], [['counter-worker', 'outbound-helper', 'svc-helper', 'workflow-helper'], ['tenant-scripts'], ['live-jobs'], ['live-tasks']])
  assert.deepEqual(known.storage.sort(), ['your-node-archive', 'd1d1d1d1-0000-4000-8000-00000000d1d1', 'hd000000000000000000000000000001', KV_LIVE, 'live-data-bucket', 'live-events', 'live-index', 'live-pipeline', 'live-secret', 'live-tasks', 'mtls-cert-1', 'store-one'].sort())
  for (const input of [api('DELETE', '/accounts/{account}/vectorize/v2/indexes/live-index'), api('DELETE', '/accounts/{account}/pipelines/live-pipeline'),
    api('DELETE', '/accounts/{account}/workers/scripts/svc-helper')]) {
    const protection = await held(input, LEVEL_ENVS.open, { settings: () => Response.json(all) })
    assert.equal(protection.family, 'P1', input.path)
  }
  // A known type without its identifying member, or an unknown type, is not understood: null (held as unresolved).
  for (const binding of [{ type: 'kv_namespace', name: 'DATA' }, { type: 'd1', name: 'D' }, { type: 'workflow', name: 'W' }, { type: 'queue', name: 'Q' }, {}, { type: 'brand_new', name: 'X' },
    { type: 'secrets_store_secret', name: 'S', store_id: 'store-one' }, { type: 'dispatch_namespace', name: 'T' }]) {
    assert.equal(liveWorkerFacts(settingsWith(binding)), null, JSON.stringify(binding))
  }
  assert.equal(liveWorkerFacts({ ...LIVE_SETTINGS, result: { ...LIVE_SETTINGS.result, tail_consumers: [{ environment: 'x' }] } }), null, 'a tail consumer without its service')
})

test('job 7 MUST 1: every binding type deploy/cloudflare/wrangler.toml declares is one the settings parser knows', () => {
  const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')
  // wrangler.toml table -> the binding type the live Worker's settings answer carries for it.
  const typeOf = { assets: 'assets', vars: 'plain_text', 'durable_objects.bindings': 'durable_object_namespace', r2_buckets: 'r2_bucket', kv_namespaces: 'kv_namespace',
    d1_databases: 'd1', 'queues.producers': 'queue', services: 'service', dispatch_namespaces: 'dispatch_namespace', workflows: 'workflow', hyperdrive: 'hyperdrive',
    vectorize: 'vectorize', analytics_engine_datasets: 'analytics_engine', mtls_certificates: 'mtls_certificate', secrets_store_secrets: 'secrets_store_secret',
    pipelines: 'pipelines', ai: 'ai', browser: 'browser', images: 'images', version_metadata: 'version_metadata', send_email: 'send_email' }
  const notBindings = new Set(['migrations', 'observability', 'limits', 'placement', 'triggers', 'build', 'dev', 'queues.consumers', 'tail_consumers'])
  const known = new Set([...Object.keys(CLOUDFLARE_BINDING_TYPES), ...CLOUDFLARE_BINDING_PLAIN])
  for (const table of [...toml.matchAll(/^\s*\[\[?\s*([A-Za-z0-9_.-]+)\s*\]\]?\s*(?:#.*)?$/gm)].map(match => match[1])) {
    if (notBindings.has(table)) continue
    assert.ok(Object.hasOwn(typeOf, table), `wrangler.toml declares [${table}]: name the binding type it gives in this test, and teach liveWorkerFacts (cloudflare-door.mjs) its identifiers`)
    assert.ok(known.has(typeOf[table]), `wrangler.toml binds ${typeOf[table]}, a type the settings parser does not know: every write would be held as live-facts-unresolved`)
  }
  // A var whose value is not a string is a json binding: known too.
  assert.ok(known.has('json'))
})

test('job 7 MUST 2: a storage name in another product\'s body reads the live Worker\'s settings first and is held', async () => {
  const settings = () => Response.json(settingsWith({ type: 'r2_bucket', name: 'DATA', bucket_name: 'live-data-bucket' }))
  // The review's exact input.
  const reviewer = api('POST', '/accounts/{account}/pages/projects', { body: { name: 'demo', deployment_configs: { production: { r2_buckets: { DATA: { name: 'live-data-bucket' } } } } } })
  const door = harness({ environment: LEVEL_ENVS.open, settings }), answer = await door.send(reviewer)
  assert.deepEqual([answer.status, answer.value.protection, door.writes.length, settingsReads(door)], [403, { family: 'P1', reason: 'bound-storage' }, 0, 1])
  // Without that binding it is an ordinary new project: open.
  assert.equal(await verdictAt('open', reviewer), 'open')
})

test('job 7 MUST 3: a queue addressed by id is looked up (its name and consumers) and held when the live Worker binds it or consumes it', async () => {
  const settings = () => Response.json(settingsWith({ type: 'queue', name: 'TASKS', queue_name: 'live-tasks' }))
  const purge = id => api('POST', `/accounts/{account}/queues/${id}/purge`)
  // The review's exact input: the bound queue, by its id.
  await bothLevels(purge('9'.repeat(32)), { family: 'P1', reason: 'bound-storage' }, { settings })
  // A queue the live Worker consumes is held even when it binds no queue (a purge and a delete are always looked up).
  await bothLevels(api('DELETE', `/accounts/{account}/queues/${'8'.repeat(32)}`), { family: 'P1', reason: 'live-dependency' })
  await bothLevels(purge('8'.repeat(32)), { family: 'P1', reason: 'live-dependency' })
  // A queue that cannot be looked up is held; another queue is open.
  await bothLevels(purge('6'.repeat(32)), { family: 'P1', reason: 'bound-id-unresolved' })
  assert.equal(await verdictAt('open', purge('7'.repeat(32))), 'open')
  // A message write to a queue: looked up only when the live Worker binds a queue.
  const message = api('POST', `/accounts/{account}/queues/${'7'.repeat(32)}/messages`, { body: { body: 'x' } })
  const plain = harness({ environment: LEVEL_ENVS.open })
  assert.equal((await plain.send(message)).status, 200)
  assert.equal(plain.calls.filter(call => /\/queues\/7{32}$/.test(call.url)).length, 0, 'no queue binding: no lookup')
  const bound = harness({ environment: LEVEL_ENVS.open, settings })
  assert.equal((await bound.send(message)).status, 200)
  assert.equal(bound.calls.filter(call => /\/queues\/7{32}$/.test(call.url)).length, 1, 'a queue binding: one lookup, then open')
})

test('job 7 MUST 5: deleting a Worker custom domain by id keeps its zone, and a sibling on the live zone is held', async () => {
  await bothLevels(api('DELETE', '/accounts/{account}/workers/domains/dom-sibling'), { family: 'P1', reason: 'live-zone' })
  await bothLevels(api('PUT', '/accounts/{account}/workers/domains/dom-zone', { body: { environment: 'production' } }), { family: 'P1', reason: 'live-zone' })
  assert.equal(await verdictAt('open', api('DELETE', '/accounts/{account}/workers/domains/dom-docs')), 'open')
})

test('job 7 MUST 6: a zone lookup that succeeds with a name that is not a host name is unresolved, and held', async () => {
  for (const name of ['', 'not a zone', 'localhost']) {
    const zone = 'a'.repeat(31) + (name.length % 10)
    const door = harness({ environment: LEVEL_ENVS.open, answer: (url, init) => (init.method === 'GET' && url.endsWith(`/zones/${zone}`) ? Response.json({ success: true, result: { id: zone, name } }) : Response.json({ success: true, result: { id: 'created' } })) })
    const answer = await door.send(api('PATCH', `/zones/${zone}/settings/ssl`, { body: { value: 'off' } }))
    assert.deepEqual([name, answer.status, answer.value.protection, door.writes.length], [name, 403, { family: 'P1', reason: 'zone-unresolved' }, 0])
  }
  // The live zone's own facts: a zone list that is not well formed holds every write (a host never seen before, so nothing kept).
  const fresh = env({ CLOUDFLARE_DOOR_LEVEL: 'open', PUBLIC_HOST: 'home.unseen-zone.test' })
  for (const zones of [() => Response.json({ success: true, result: [{ id: 'not-an-id', name: 'unseen-zone.test' }] }), () => Response.json({ success: true, result: { id: 'x' } }), () => { throw new Error('reset') }]) {
    const door = harness({ environment: fresh, zones }), answer = await door.send(api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'A', name: 'a.example.org', content: '192.0.2.1' } }))
    assert.deepEqual([answer.status, answer.value.protection, door.writes.length], [403, { family: 'P1', reason: 'live-facts-unresolved' }, 0])
  }
})

test('job 7 MUST 7: the live zone named anywhere in the views is held, before any root falls through; the boundaries are exact', async () => {
  const other = '/accounts/{account}/workers/scripts/other'
  const rows = [
    api('PUT', other, { body: { zone: LIVE } }), api('PUT', other, { body: { target: LIVE } }),
    api('PUT', other, { body: { url: `https://api.cloudflare.com/client/v4/zones/${LIVE}/dns_records` } }),
    api('PUT', other, { body: { payload: JSON.stringify({ zone_id: LIVE }) } }),
    api('PUT', other, { body: { rules: [{ expression: 'http.host eq "shop.example.invalid"' }] } }),
    api('PUT', other, { query: { zone_id: LIVE }, body: {} }), api('PUT', other, { query: { hostname: 'shop.example.invalid' }, body: {} }),
    api('PUT', '/accounts/{account}/workers/domains', { bodyKind: 'multipart', parts: [{ name: 'metadata', contentType: 'application/json', json: { hostname: 'shop.example.invalid', service: 'other' } }] }),
    api('POST', '/future/action', { body: { zone_id: LIVE } }),
    api('PUT', other, { body: { note: 'https://example.invalid/x' } }), api('PUT', other, { body: 'see shop.example.invalid.', bodyKind: 'text', contentType: 'text/plain' }),
  ]
  for (const input of rows) await bothLevels(input, { family: 'P1', reason: 'live-zone' })
  // Another zone id inside a /zones/<id> URL is resolved like a zone in the path; one that cannot be resolved is held.
  await bothLevels(api('PUT', other, { body: { url: `https://api.cloudflare.com/client/v4/zones/${'0'.repeat(32)}/settings` } }), { family: 'P1', reason: 'zone-unresolved' })
  assert.equal(await verdictAt('open', api('PUT', other, { body: { url: `https://api.cloudflare.com/client/v4/zones/${OTHER}/settings` } })), 'open')
  // Not on the live zone: a longer name that ends in its letters, and the zone name followed by more labels.
  for (const text of ['notexample.invalid', 'example.invalid.evil.test', 'https://example.invalidity.example/x', 'example-invalid']) {
    assert.equal(await verdictAt('open', api('PUT', other, { body: { note: text } })), 'open', text)
  }
})

test('job 7 MUST 8: a compound credential segment is read word by word; the client-secret endpoint is refused before sending', async () => {
  const door = harness(), refused = await door.send(api('POST', '/accounts/{account}/client-secret'))
  assert.deepEqual([refused.status, refused.value.code, door.calls.length], [403, 'CLOUDFLARE_CREDENTIAL_PATH_REFUSED', 0])
  for (const path of ['/accounts/{account}/new_product/api-key', '/accounts/{account}/new_product/x/rotate_secret', '/accounts/{account}/new_product/signing.credential', '/accounts/{account}/new_product/service-tokens']) {
    const expected = path.endsWith('service-tokens') ? { family: 'P2', reason: 'keys' } : { family: 'P2', reason: 'app-secret' }
    await bothLevels(api('POST', path, { body: { name: 'x' } }), expected)
  }
  // A segment that is a row itself is read by the row; a singular other than secret, key, credential is not a credential.
  assert.equal(await verdictAt('open', api('DELETE', `/zones/${OTHER}/ssl/certificate_packs/p1`)), 'open')
})

test('job 7 MUST 9 and SHOULD 1: credential names and values in every representation: multipart parts, text, query, any value type', async () => {
  const other = '/accounts/{account}/workers/scripts/other'
  const rows = [
    // The review's exact inputs.
    [api('PUT', other, { bodyKind: 'multipart', parts: [{ name: 'password', contentType: 'text/plain', text: 'fixture' }] }), 'app-secret'],
    [api('PUT', other, { bodyKind: 'multipart', parts: [{ name: 'data', contentType: 'text/plain', text: 'cfat_' + 'x'.repeat(20) }] }), 'keys'],
    [api('PUT', other, { body: { passwd: 'fixture' } }), 'app-secret'], [api('PUT', other, { body: { authorization: 'Bearer fixture' } }), 'app-secret'],
    [api('PUT', other, { body: { password: 123456 } }), 'app-secret'],
    [api('PUT', other, { body: { material: '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----' } }), 'app-secret'],
    [api('PUT', other, { query: { password: 'fixture' }, body: {} }), 'app-secret'], [api('PUT', other, { query: { v: 'cfat_' + 'x'.repeat(20) }, body: {} }), 'keys'],
    // The aliases, each once; an object value under a credential name; a Bearer value under another name; an NDJSON text body.
    ...['pwd', 'private_key', 'privatekey', 'api_key', 'apikey', 'access_key', 'client_secret', 'signing_key', 'credential', 'credentials'].map(name => [api('PUT', other, { body: { [name]: 'fixture' } }), 'app-secret']),
    [api('PUT', other, { body: { credentials: { user: 'u' } } }), 'app-secret'], [api('PUT', other, { body: { note: 'Bearer abcdef123' } }), 'app-secret'],
    [api('PUT', other, { body: '{"a":1}\n{"secret":"x"}\n', bodyKind: 'text', contentType: 'text/plain' }), 'app-secret'],
  ]
  for (const [input, reason] of rows) await bothLevels(input, { family: 'P2', reason })
  // No alias turns an ordinary request into a held one: booleans, empty values, token counts, a word in prose.
  for (const body of [{ has_password: true }, { passwd: '' }, { pwd_hint_shown: false }, { max_tokens: 256 }, { note: 'the Bearer of this note' }, { key: 'greeting' }]) {
    assert.equal(await verdictAt('open', api('PUT', other, { body })), 'open', JSON.stringify(body))
  }
})

test('job 7 MUST 10: encoded JSON is read layer after layer by every rule; past the limit it is held, never passed', async () => {
  const other = '/accounts/{account}/workers/scripts/other'
  const wrap = (value, layers) => { for (let index = 0; index < layers; index++) value = JSON.stringify({ doc: value }); return value }
  for (const layers of [1, 2, 3]) await bothLevels(api('PUT', other, { body: { doc: wrap({ password: 'fixture' }, layers) } }), { family: 'P2', reason: 'app-secret' })
  // The review's exact construction: five layers. Something is left unread: held, as the inspection limit.
  await bothLevels(api('PUT', other, { body: { doc: wrap({ password: 'fixture' }, 5) } }), { family: 'P1', reason: 'inspection-limit' })
  // The charge rule reads the same views: the review's encoded rate plan.
  await bothLevels(api('PUT', other, { body: { doc: '{"rate_plan":{"id":"paid"}}' } }), { family: 'P4', reason: 'paid-subscription' })
  // A layered string with nothing in it is still open.
  assert.equal(await verdictAt('open', api('PUT', other, { body: { doc: wrap({ greeting: 'hi' }, 3) } })), 'open')
})

test('job 7 MUST 11: the answer screen reads raw text, multipart parts and NDJSON lines with the same recognisers', async () => {
  const kv = api('GET', '/accounts/{account}/storage/kv/namespaces/ns1/values/saved')
  for (const [label, body, type] of [
    ['the review\'s text answer', 'https://upload.example/path?token=synthetic-secret', 'text/plain'],
    ['a URL inside prose', 'saved: https://upload.example/path?signature=abc123 for later', 'text/plain'],
    ['a plain-text multipart part', '--b1\r\nContent-Disposition: form-data; name="m"\r\nContent-Type: text/plain\r\n\r\nhttps://upload.example/p?token=synthetic\r\n--b1--\r\n', 'multipart/form-data; boundary=b1'],
    ['an NDJSON quoted string', '"https://upload.example/p?token=synthetic"\n"other"\n', 'application/x-ndjson'],
    ['a Bearer value', 'Authorization: Bearer synthetic-value-1', 'text/plain'],
  ]) {
    const answer = await harness({ answer: () => new Response(body, { headers: { 'content-type': type } }) }).send(kv)
    assert.deepEqual([label, answer.value.code, answer.value.withheld, Object.hasOwn(answer.value, 'result')], [label, 'CLOUDFLARE_RESPONSE_WITHHELD', true, false])
    assert.equal(JSON.stringify(answer.value).includes('synthetic'), false, label)
  }
  // An ordinary opaque value is still returned (the stated limit), and so is a URL with no credential in it.
  for (const body of ['q8Zr2LkP0vXy7mNs3TaW', 'https://example.net/a?page=2']) {
    const answer = await harness({ answer: () => new Response(body, { headers: { 'content-type': 'text/plain' } }) }).send(kv)
    assert.deepEqual([body, answer.value.ok, answer.value.result], [body, true, body])
  }
})

test('job 7 MUST 13: a charge is never hidden: the review\'s two inputs answer P4 first with the live home in `also`', async () => {
  await bothLevels(api('PUT', '/accounts/{account}/registrar/domains/example.invalid', { body: { auto_renew: true } }), { family: 'P4', reason: 'registrar-renewal', also: [{ family: 'P1', reason: 'live-domain' }] })
  await bothLevels(api('POST', '/accounts/{account}/subscriptions', { body: { rate_plan: { id: 'business' }, description: 'node.example.invalid' } }), { family: 'P4', reason: 'paid-subscription', also: [{ family: 'P1', reason: 'live-host' }] })
})

test('the protection object follows the door contract exactly', () => {
  const pairs = reasons => reasons.map(([family, reason]) => ({ family, reason }))
  // Precedence: P3, P4, P2, P1, then unclassified; inside a family a reason that names the target beats one that could not check.
  assert.deepEqual(cloudflareProtectionOf(pairs([['P1', 'live-zone'], ['P2', 'keys'], ['P4', 'billing'], ['P3', 'zone-deletion']])),
    { family: 'P3', reason: 'zone-deletion', also: pairs([['P1', 'live-zone'], ['P2', 'keys'], ['P4', 'billing']]) })
  assert.deepEqual(cloudflareProtectionOf(pairs([['P1', 'bound-id-unresolved'], ['P1', 'live-zone'], ['P1', 'inspection-limit'], ['P1', 'host-unreadable']])),
    { family: 'P1', reason: 'live-zone', also: pairs([['P1', 'bound-id-unresolved'], ['P1', 'host-unreadable'], ['P1', 'inspection-limit']]) })
  assert.deepEqual(cloudflareProtectionOf([{ family: 'account-wide-unclassified', reason: 'unclassified', apiFamily: 'magic' }]), { family: 'account-wide-unclassified', reason: 'unclassified', apiFamily: 'magic' })
  // More than eight others: the eight highest by precedence are kept, then sorted.
  const many = pairs([['P3', 'zone-deletion'], ['P1', 'zone-unresolved'], ['P1', 'live-zone'], ['P1', 'live-worker'], ['P1', 'live-host'], ['P1', 'bound-storage'], ['P1', 'live-dns'], ['P1', 'live-route'], ['P2', 'keys'], ['P4', 'billing']])
  const built = cloudflareProtectionOf(many)
  assert.deepEqual([built.reason, built.also.length, built.also.some(pair => pair.reason === 'zone-unresolved')], ['zone-deletion', 8, false])
  assert.deepEqual(cloudflareProtectionShape(built), JSON.parse(JSON.stringify(built)))
  // The shape check: `also` 1 to 8, exactly two members each, sorted, no duplicate, never the primary pair.
  const good = { family: 'P1', reason: 'live-zone', also: pairs([['P1', 'live-host'], ['P4', 'billing']]) }
  assert.deepEqual(cloudflareProtectionShape(good), good)
  for (const also of [[], pairs([['P4', 'billing'], ['P1', 'live-host']]), pairs([['P1', 'live-host'], ['P1', 'live-host']]), pairs([['P1', 'live-zone']]),
    [{ family: 'P1', reason: 'live-host', extra: 1 }], [{ family: 'P9', reason: 'x' }], pairs(Array.from({ length: 9 }, (_, index) => ['P1', 'r' + 'abcdefghi'[index]])), 'live-host']) {
    assert.equal(cloudflareProtectionShape({ ...good, also }), null, JSON.stringify(also))
  }
})

test('job 7 SHOULD 2: a request nested in a body is classified as its own request; its reasons join; too deep is held', async () => {
  const batch = body => api('POST', '/batch', { body })
  await bothLevels(batch([{ method: 'DELETE', path: `/zones/${OTHER}` }]), { family: 'P3', reason: 'zone-deletion' })
  await bothLevels(batch([{ method: 'DELETE', path: '/accounts/{account}/tokens/resource' }]), { family: 'P2', reason: 'keys' })
  await bothLevels(batch([{ method: 'POST', path: '/accounts/{account}/subscriptions', body: {} }]), { family: 'P4', reason: 'paid-subscription' })
  await bothLevels(batch([{ method: 'PATCH', url: `https://api.cloudflare.com/client/v4/zones/${LIVE}/settings/ssl`, body: { value: 'off' } }]), { family: 'P1', reason: 'live-zone' })
  // Nested past the depth limit: held.
  let deep = { method: 'POST', path: '/batch', body: [] }
  for (let index = 0; index < 4; index++) deep = { method: 'POST', path: '/batch', body: [deep] }
  // (At `guarded` the nested requests to an unknown root are said too.)
  assert.deepEqual(await held(batch([deep]), LEVEL_ENVS.open), { family: 'P1', reason: 'inspection-limit' })
  assert.deepEqual(await held(batch([deep]), LEVEL_ENVS.guarded), { family: 'P1', reason: 'inspection-limit', also: [{ family: 'account-wide-unclassified', reason: 'root-unclassified' }] })
  // A read, or a method and URL that are not a Cloudflare request (a webhook), are not requests of this door.
  assert.equal(await verdictAt('open', api('PUT', `/zones/${OTHER}/never_heard_of`, { body: [{ method: 'GET', path: `/zones/${OTHER}/dns_records` }, { method: 'POST', url: 'https://hooks.example.net/x' }] })), 'open')
})

test('job 7 SHOULD 3: Pages projects, load-balancer pools and monitors, tunnels: one lookup each, held when they serve the live zone', async () => {
  const pages = '/accounts/{account}/pages/projects'
  for (const input of [api('DELETE', `${pages}/live-site`), api('POST', `${pages}/live-site/deployments/d1/rollback`, { body: {} }), api('POST', `${pages}/live-site/deployments/d1/retry`, { body: {} }),
    api('DELETE', `${pages}/live-site/deployments/d1`), api('PATCH', `${pages}/live-site`, { body: { production_branch: 'main' } })]) {
    await bothLevels(input, { family: 'P1', reason: 'live-zone' })
  }
  // The review's M12 inputs: a project that serves nothing on the live zone stays open; one that cannot be read is held.
  assert.equal(await verdictAt('open', api('DELETE', `${pages}/demo`)), 'open')
  assert.equal(await verdictAt('open', api('POST', `${pages}/demo/deployments/resource/rollback`, { body: {} })), 'open')
  await bothLevels(api('DELETE', `${pages}/missing`), { family: 'P1', reason: 'live-dependency-unresolved' })
  // The review's M21 input: an existing secret set to null, or given another type, is an application's secret; a plain one is not.
  await bothLevels(api('PATCH', `${pages}/demo`, { body: { deployment_configs: { production: { env_vars: { AUTH: null } } } } }), { family: 'P2', reason: 'app-secret' })
  await bothLevels(api('PATCH', `${pages}/demo`, { body: { deployment_configs: { production: { env_vars: { AUTH: { type: 'plain_text', value: 'x' } } } } } }), { family: 'P2', reason: 'app-secret' })
  assert.equal(await verdictAt('open', api('PATCH', `${pages}/demo`, { body: { deployment_configs: { production: { env_vars: { MODE: null } } } } })), 'open')
  // Account load balancing (the review's M14): a pool or monitor whose references name a load balancer on the live zone.
  await bothLevels(api('PATCH', '/accounts/{account}/load_balancers/pools/pool-live', { body: { origins: [{ name: 'new', address: '192.0.2.1' }] } }), { family: 'P1', reason: 'live-zone' })
  assert.equal(await verdictAt('open', api('PATCH', '/accounts/{account}/load_balancers/pools/pool1', { body: { origins: [{ name: 'new', address: '192.0.2.1' }] } })), 'open')
  assert.equal(await verdictAt('open', api('DELETE', '/accounts/{account}/load_balancers/monitors/mon1')), 'open')
  await bothLevels(api('DELETE', '/accounts/{account}/load_balancers/pools/pool-gone'), { family: 'P1', reason: 'live-dependency-unresolved' })
  // Tunnels (the review's M16): ingress on the live zone, locally managed or unreadable is held; private-network routes stay open.
  await bothLevels(api('DELETE', '/accounts/{account}/cfd_tunnel/t-live'), { family: 'P1', reason: 'live-zone' })
  await bothLevels(api('PUT', '/accounts/{account}/cfd_tunnel/t-local/configurations', { body: { config: { ingress: [{ service: 'http_status:404' }] } } }), { family: 'P1', reason: 'live-dependency-unresolved' })
  await bothLevels(api('DELETE', '/accounts/{account}/cfd_tunnel/t-gone/connections'), { family: 'P1', reason: 'live-dependency-unresolved' })
  assert.equal(await verdictAt('open', api('DELETE', '/accounts/{account}/cfd_tunnel/t1')), 'open')
  assert.equal(await verdictAt('open', api('DELETE', '/accounts/{account}/zerotrust/routes/hostname/resource')), 'open')
  assert.equal(await verdictAt('open', api('PATCH', '/accounts/{account}/teamnet/routes/resource', { body: { tunnel_id: 'resource' } })), 'open')
})

test('job 7 SHOULD 4: a held request is accepted only if its staged file fits the card; one byte more is refused before staging', async () => {
  const live = n => api('PUT', '/accounts/{account}/workers/scripts/your-node', { body: '//' + 'x'.repeat(n), bodyKind: 'text', contentType: 'application/javascript' })
  const room = CLOUDFLARE_DOOR_LIMITS.stagedBytes - cloudflareStagedBytes(live(0))
  assert.equal(cloudflareStagedBytes(live(room)), CLOUDFLARE_DOOR_LIMITS.stagedBytes)
  const fits = await harness({ environment: LEVEL_ENVS.open }).send(live(room))
  assert.deepEqual([fits.status, fits.value.code, fits.value.protection], [403, 'CLASS3_WEBAUTHN_REQUIRED', { family: 'P1', reason: 'live-worker' }])
  for (const n of [room + 1, 261800]) {
    const door = harness({ environment: LEVEL_ENVS.open }), over = await door.send(live(n))
    assert.deepEqual([n, over.status, over.value.code, over.value.next, door.writes.length], [n, 413, 'CLOUDFLARE_REQUEST_TOO_LARGE', CLOUDFLARE_NEXT.tooLarge, 0])
  }
  // An open write of the same size is not staged, so it is not bound by the card.
  const open = api('PUT', '/accounts/{account}/workers/scripts/notes-site', { body: '//' + 'x'.repeat(room + 1), bodyKind: 'text', contentType: 'application/javascript' })
  assert.equal((await harness({ environment: LEVEL_ENVS.open }).send(open)).status, 200)
  // The edge measures the file her runtime writes, with the card's bound: same schema, same bound, written indented.
  const runtime = readFileSync(new URL('../../../../packages/experimental/webworker-runtime/src/x6/ball-loader.ts', import.meta.url), 'utf8')
  const card = readFileSync(new URL('../../../../packages/client/ui-layout/src/client/spatial/aumlok/outward-class3.ts', import.meta.url), 'utf8')
  assert.match(runtime, new RegExp(`STAGED_OUTWARD_SCHEMA = '${CLOUDFLARE_STAGED_SCHEMA.replace(/\./g, '\\.')}'`))
  for (const source of [runtime, card]) assert.match(source, /STAGED_OUTWARD_MAX_BYTES = 256 \* 1024/)
  assert.equal(CLOUDFLARE_DOOR_LIMITS.stagedBytes, 256 * 1024)
  assert.match(runtime, /\.\.\.\(protection !== null \? \{ protection \} : \{\}\) \}, null, 2\) \+ '\\n'/, 'the runtime writes the staged file indented, as the edge measures it')
})

test('job 7: what a plain open write costs: the live Worker\'s settings and its namespace list, read once each (the live zone\'s id is kept once learned)', async () => {
  const door = harness({ environment: LEVEL_ENVS.open })
  await door.send(api('POST', `/zones/${OTHER}/dns_records`, { body: { type: 'A', name: 'a.example.org', content: '192.0.2.1' } }))
  const reads = door.calls.filter(call => call.method === 'GET').map(call => new URL(call.url).pathname.replace(/^\/client\/v4/, '').replace(/[0-9a-f]{32}/g, '<id>'))
  assert.deepEqual(reads.sort(), ['/accounts/<id>/workers/durable_objects/namespaces', '/accounts/<id>/workers/scripts/your-node/settings', '/zones/<id>'].sort())
  assert.equal(door.writes.length, 1)
  // Two extra reads for every open write, plus the zone a /zones path names (looked up as before).
  const account = harness({ environment: LEVEL_ENVS.open })
  await account.send(api('POST', '/accounts/{account}/storage/kv/namespaces', { body: { title: 'notes' } }))
  assert.equal(account.calls.filter(call => call.method === 'GET').length, 2)
})

// ---- two faults a review found, and the ordinary source her Workers carry.
const JOB8_WORKER = '/accounts/{account}/workers/scripts/other'
const reasonsOf = input => {
  const verdict = classifyCloudflareRequest(input, { accountId: ACCOUNT, level: 'open' })
  return verdict.verdict === 'protected' ? verdict.matched.map(pair => pair.reason) : verdict.verdict
}
const timed = input => {
  const started = performance.now(), reasons = reasonsOf(input)
  return { reasons, ms: performance.now() - started }
}

test('job 8 fix 1: the live-zone host match reads at most a host name to the left: the review\'s long run of `a.` classifies in under 200 ms', () => {
  const run = kb => 'a.'.repeat(kb * 512)
  const twoLayers = text => JSON.stringify({ doc: JSON.stringify({ note: text }) })
  const rows = [
    // The review's exact input (a 100 KB text body of `a.` repeated: 6.2 s before), 250 KB, and inside two JSON-in-string layers.
    ['review: 100 KB text body', api('PUT', JOB8_WORKER, { body: run(100), bodyKind: 'text', contentType: 'text/plain' }), 'open'],
    ['250 KB text body', api('PUT', JOB8_WORKER, { body: run(250), bodyKind: 'text', contentType: 'text/plain' }), 'open'],
    ['100 KB JSON field', api('PUT', JOB8_WORKER, { body: { note: run(100) } }), 'open'],
    ['100 KB in two JSON-in-string layers', api('PUT', JOB8_WORKER, { body: { doc: twoLayers(run(100)) } }), 'open'],
    ['250 KB in two JSON-in-string layers', api('PUT', JOB8_WORKER, { body: { doc: twoLayers(run(250)) } }), 'open'],
    // The same run ending in the live zone, and in the live host: a name longer than any host name is not the live host,
    // so it is on the live zone and held (as the unbounded match held it).
    ['250 KB run ending in the live zone', api('PUT', JOB8_WORKER, { body: run(250) + 'example.invalid', bodyKind: 'text', contentType: 'text/plain' }), ['live-zone']],
    ['250 KB run ending in the live host, two layers', api('PUT', JOB8_WORKER, { body: { doc: twoLayers(run(250) + 'node.example.invalid') } }), ['live-zone']],
  ]
  for (const [label, input, expected] of rows) {
    const { reasons, ms } = timed(input)
    assert.ok(ms < 200, `${label}: ${ms.toFixed(1)} ms`)
    assert.deepEqual([label, reasons], [label, expected])
  }
})

test('job 8 fix 1: host names at the boundaries: six on the live zone are held, six that are not stay open; the live host itself is live-host', () => {
  const label = (letter, length) => letter.repeat(length)
  // Letters that are not hex digits, so no label reads as an id run. A 253-character name on the live zone: three
  // 63-character labels, one of 45, and the zone (63*3 + 45 + 4 dots + 15). The last one runs past any host name's length.
  const longest = [label('g', 63), label('h', 63), label('k', 63), label('m', 45), 'example.invalid'].join('.')
  assert.equal(longest.length, 253)
  const onZone = [`${label('z', 63)}.example.invalid`, `${label('z', 64)}.example.invalid`, longest, 'shop.example.invalid.', 'SHOP.EXAMPLE.INVALID', `${'z.'.repeat(150)}example.invalid`]
  for (const host of onZone) {
    assert.deepEqual([host, reasonsOf(api('PUT', JOB8_WORKER, { body: { note: `see ${host} now` } }))], [host, ['live-zone']])
    assert.deepEqual([host, reasonsOf(api('PUT', JOB8_WORKER, { body: `route: ${host}`, bodyKind: 'text', contentType: 'text/plain' }))], [host, ['live-zone']])
  }
  // Not on the live zone: 253 characters under another zone that carries the zone's letters, a 64-character label, a name
  // that only ends with the zone name inside a longer label, upper case, a final dot.
  const elsewhere = `${label('p', 63)}.${label('q', 165)}.example.invalid.example`
  assert.equal(elsewhere.length, 253)
  const notOnZone = ['notexample.invalid', `${label('z', 53)}example.invalid`, 'NOTEXAMPLE.INVALID', 'example.invalid.evil.test.', elsewhere, `${label('z', 64)}.example.invalid-x.example`]
  for (const host of notOnZone) assert.deepEqual([host, reasonsOf(api('PUT', JOB8_WORKER, { body: { note: `see ${host} now` } }))], [host, 'open'])
  // The live host itself, in upper case and with a final dot: live-host (it names the live host), never live-zone.
  for (const host of ['NODE.EXAMPLE.INVALID', 'node.example.invalid.']) assert.deepEqual([host, reasonsOf(api('PUT', JOB8_WORKER, { body: { note: `see ${host} now` } }))], [host, ['live-host']])
})

test('job 8 fix 1: the bounded match gives the answer the unbounded expression gave, for every short text', () => {
  // The expression job 7 used (cloudflare-door.mjs at an earlier commit), as the oracle: fine on short texts, quadratic on long ones.
  const oracle = new RegExp('(?<![a-z0-9-])((?:[a-z0-9-]+\\.)*)(example\\.invalid)(?=\\.?(?:$|[^a-z0-9.-]))', 'gi')
  const unbounded = text => [...new Set([text, text.normalize('NFKC')])].some(value => [...value.matchAll(oracle)].some(match => (match[1] + match[2]).toLowerCase() !== 'node.example.invalid'))
  const pieces = ['a', 'B', '7', '-', '.', '..', 'node', 'NODE.', 'example', 'example.invalid', 'EXAMPLE.INVALID', '.invalid', ' ', '/', '_', 'ｅｘａｍｐｌｅ．ｉｎｖａｌｉｄ', 'shop.', 'not', '"']
  let seed = 8
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let index = 0; index < 3000; index++) {
    let text = ''
    for (let count = 1 + Math.floor(next() * 8); count > 0; count--) text += pieces[Math.floor(next() * pieces.length)]
    const reasons = reasonsOf(api('PUT', JOB8_WORKER, { body: { note: text } }))
    assert.equal(Array.isArray(reasons) && reasons.includes('live-zone'), unbounded(text), JSON.stringify(text))
  }
})

test('job 8 fix 1: the URL scan reads each scheme run once: a long run of scheme characters classifies in under 200 ms', () => {
  for (const kb of [100, 250]) {
    const { reasons, ms } = timed(api('PUT', JOB8_WORKER, { body: { note: 'x://y ' + 'g.'.repeat(kb * 512) } }))
    assert.ok(ms < 200, `${kb} KB: ${ms.toFixed(1)} ms`)
    assert.equal(reasons, 'open')
  }
  // A credential after a long scheme-shaped run is still found.
  assert.deepEqual(reasonsOf(api('PUT', JOB8_WORKER, { body: { note: 'g.'.repeat(5000) + 'https://upload.example/p?token=synthetic-literal' } })), ['app-secret'])
})

const job8Module = body => api('PUT', JOB8_WORKER, { body, bodyKind: 'text', contentType: 'application/javascript' })
const job8Part = text => api('PUT', JOB8_WORKER, { bodyKind: 'multipart', parts: [{ name: 'metadata', contentType: 'application/json', json: { main_module: 'index.js' } },
  { name: 'index.js', filename: 'index.js', contentType: 'application/javascript+module', text }] })

test('job 8 fix 2: a URL whose credential-named parameter is an expression or a placeholder is ordinary source; a literal value is held', async () => {
  // The review's exact input: open before job 7, held by it, open again.
  assert.equal(await verdictAt('open', job8Module('fetch(`https://api.example.com/v1?key=${env.K}`)')), 'open')
  assert.equal(await verdictAt('guarded', job8Module('fetch(`https://api.example.com/v1?key=${env.K}`)')), 'open')
  // The same with a literal 32-character value is held.
  const literal = 'q8Zr2LkP0vXy7mNs3TaWq8Zr2LkP0vXy'
  assert.equal(literal.length, 32)
  await bothLevels(job8Module(`fetch(\`https://api.example.com/v1?key=${literal}\`)`), { family: 'P2', reason: 'app-secret' })
  await bothLevels(job8Module(`fetch("https://api.example.com/v1?key=${literal}")`), { family: 'P2', reason: 'app-secret' })
  // Concatenation, templates and placeholders, in a text body and in a module part: open.
  for (const source of ['fetch("https://api.example.com/v1?token=" + env.T)', "fetch('https://api.example.com/v1?api_key=' + env.API_KEY)",
    'const url = `https://api.example.com/v1?signature=${sign(body)}&page=2`', 'const docs = "https://api.example.com/v1?token={{TOKEN}}"',
    'const docs = "https://api.example.com/v1?secret={secret}"', 'const docs = "https://api.example.com/v1?password=<password>"', 'const u = `https://x.example/?token=`+t']) {
    assert.equal(await verdictAt('open', job8Module(source)), 'open', source)
    assert.equal(await verdictAt('open', job8Part(source)), 'open', source)
  }
  // A literal value after an expression in the same URL is still read; so is a JSON field holding a literal signed URL.
  await bothLevels(job8Module('fetch(`https://api.example.com/v1?page=${n}&token=synthetic-literal-1`)'), { family: 'P2', reason: 'app-secret' })
  await bothLevels(api('PUT', JOB8_WORKER, { body: { note: 'https://upload.example/path?signature=abc123def456' } }), { family: 'P2', reason: 'app-secret' })
  await bothLevels(api('PUT', JOB8_WORKER, { body: { doc: JSON.stringify({ url: 'https://upload.example/path?token=synthetic-literal' }) } }), { family: 'P2', reason: 'app-secret' })
})

test('job 8 item 3: four ordinary Worker modules stay open in a text body and in a module part; a Cloudflare key or a PEM private key in source is held', async () => {
  const modules = {
    'reads env.API_KEY': 'export default {\n  async fetch(request, env) {\n    const key = env.API_KEY\n    return new Response(key ? "configured" : "missing")\n  }\n}\n',
    'a password comment and a secret variable': '// the password is checked by the upstream service, never here\nexport default {\n  async fetch(request, env) {\n    const secret = env.SIGNING_SECRET\n    return new Response(String(Boolean(secret)))\n  }\n}\n',
    'an Authorization header from env': 'export default {\n  async fetch(request, env) {\n    const headers = { Authorization: `Bearer ${env.API_TOKEN}`, "content-type": "application/json" }\n    const other = { authorization: "Bearer " + env.API_TOKEN }\n    return fetch("https://api.example.com/v1/items", { headers, ...other })\n  }\n}\n',
    'a PEM certificate (public)': 'const CA = `-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUSyntheticFixtureOnlyNotARealCertificate0wCgYIKoZIzj0EAwIw\n-----END CERTIFICATE-----`\nexport default { fetch() { return new Response(CA) } }\n',
  }
  for (const [name, source] of Object.entries(modules)) {
    for (const level of ['open', 'guarded']) {
      assert.deepEqual([name, level, 'text', await verdictAt(level, job8Module(source))], [name, level, 'text', 'open'])
      assert.deepEqual([name, level, 'part', await verdictAt(level, job8Part(source))], [name, level, 'part', 'open'])
    }
  }
  // Still held in source: a literal Cloudflare key format, and a PEM private-key block.
  await bothLevels(job8Module(`const KEY = "cfat_${'x'.repeat(24)}"\nexport default {}\n`), { family: 'P2', reason: 'keys' })
  await bothLevels(job8Part('const PEM = `-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----`\nexport default {}\n'), { family: 'P2', reason: 'app-secret' })
})

// ---- a literal value that starts with `+`, a Bearer word in prose, the URL scan's exact answer,
// and the live-zone host in source (kept as job 7 MUST 7 wrote it; a later change decides).
test('job 8 review: a literal query value that starts with `+` (raw base64) is still a credential, in a request and in an answer', async () => {
  const literal = '+q8Zr2LkP0vXy7mNs3TaWq8Zr2LkP0vXy'
  // The review's input: a JSON field holding a signed URL whose value starts with `+`.
  await bothLevels(api('PUT', JOB8_WORKER, { body: { note: `https://upload.example/p?token=${literal}` } }), { family: 'P2', reason: 'app-secret' })
  // The same literal in source, as a text body and as a module part.
  for (const source of [`fetch("https://upload.example/p?token=${literal}")`, `const u = \`https://upload.example/p?sig=${literal}\``]) {
    await bothLevels(job8Module(source), { family: 'P2', reason: 'app-secret' })
    await bothLevels(job8Part(source), { family: 'P2', reason: 'app-secret' })
  }
  // The answer screen withholds it.
  assert.equal(cloudflareAnswerCarriesCredential('x https://h/p?token=+abcdefgh'), true)
  // A `+` that joins an expression is outside the string, so the value is empty: still open.
  assert.equal(await verdictAt('open', job8Module('fetch("https://upload.example/p?token=" + env.T)')), 'open')
  assert.equal(await verdictAt('guarded', job8Part('fetch("https://upload.example/p?token=" +env.T)')), 'open')
})

test('job 8 review: the word Bearer in prose is ordinary source; a Bearer value with a digit, or 20 characters long, is held', async () => {
  for (const source of ['// Sends Bearer tokens upstream\nexport default {}\n', '/* Bearer authentication is set below. */\nexport default {}\n',
    '// see: Bearer tokens.\nexport default {}\n', 'const doc = "uses Bearer credentials"\nexport default {}\n']) {
    for (const level of ['open', 'guarded']) {
      assert.deepEqual([source, level, 'text', await verdictAt(level, job8Module(source))], [source, level, 'text', 'open'])
      assert.deepEqual([source, level, 'part', await verdictAt(level, job8Part(source))], [source, level, 'part', 'open'])
    }
  }
  for (const source of ['const h = { authorization: "Bearer abc123def456" }\nexport default {}\n', 'const h = "Bearer abcdefghijklmnopqrstuvwxyz"\nexport default {}\n',
    'const h = "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig"\nexport default {}\n']) {
    await bothLevels(job8Module(source), { family: 'P2', reason: 'app-secret' })
    await bothLevels(job8Part(source), { family: 'P2', reason: 'app-secret' })
  }
  assert.equal(cloudflareAnswerCarriesCredential('Authorization: Bearer abc123def456'), true)
  assert.equal(cloudflareAnswerCarriesCredential('Sends Bearer tokens upstream'), false)
})

test('job 8 review: the URL scan finds exactly the URLs the unbounded expression found, including a scheme run with no letter in its last 32 characters', () => {
  // The review's input: a letter, then 40 digits, then `://` and a literal credential. The unbounded form found it.
  const reasons = reasonsOf(api('PUT', JOB8_WORKER, { body: { note: 'a' + '1'.repeat(40) + '://h.example/?token=literalsecret123' } }))
  assert.ok(Array.isArray(reasons) && reasons.includes('app-secret'), JSON.stringify(reasons))
  // The expression job 7 used (cloudflare-door.mjs at an earlier commit), as the oracle.
  const oracle = text => [...text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>\\]+/gi)].map(match => match[0])
  const pieces = ['a', 'Z', '1', '+', '.', '-', ':', '/', '//', '://', 'h://', '1://', '?', 'token=', '&', '@', ' ', '"', '`', '\u00a0', 'é', '1'.repeat(40)]
  let seed = 88
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let index = 0; index < 5000; index++) {
    let text = ''
    for (let count = 1 + Math.floor(next() * 10); count > 0; count--) text += pieces[Math.floor(next() * pieces.length)]
    assert.deepEqual(cloudflareUrlsInText(text), oracle(text), JSON.stringify(text))
  }
  // Linear time on the shapes that are hard for it: long scheme runs with and without a letter, many `://`.
  const long = 250 * 1024
  for (const [text, count] of [['a'.repeat(long), 0], ['a'.repeat(long) + '1'.repeat(40) + '://h', 1], ['1'.repeat(long) + '://h', 0], ['a.'.repeat(long / 2) + '://h', 1],
    ['1://'.repeat(64 * 1024), 0], ['a://'.repeat(64 * 1024), 1], ['a://h '.repeat(50 * 1024), 50 * 1024], ['a:// '.repeat(50 * 1024), 0], ['1://h '.repeat(50 * 1024), 0]]) {
    const started = performance.now(), found = cloudflareUrlsInText(text), ms = performance.now() - started
    assert.ok(ms < 200, `${text.slice(0, 8)}: ${ms.toFixed(1)} ms`)
    assert.equal(found.length, count, text.slice(0, 8))
  }
})

test('job 8 review: a host on the live zone named in Worker source is held as live-zone (job 7 MUST 7 reads every string; a later change decides)', async () => {
  for (const source of ['// docs at https://docs.example.invalid\nexport default {}\n', 'export default { fetch() { return fetch("https://docs.example.invalid/api") } }\n']) {
    await bothLevels(job8Module(source), { family: 'P1', reason: 'live-zone' })
    await bothLevels(job8Part(source), { family: 'P1', reason: 'live-zone' })
  }
})
