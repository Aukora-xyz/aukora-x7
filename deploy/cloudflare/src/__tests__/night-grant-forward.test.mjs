/** The Worker side of AURA's night grant routes, over a stub HEAD (the DO routes live on AURA's branch): owner-only,
 * same-origin, exactly like /_head/promote; the request reaches HEAD unchanged with the owner's verified access. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker } from '../worker.mjs'

const ORIGIN = 'https://night-grant.example.invalid'
const OWNER = 'owner@example.invalid'
const SEED = 'a'.repeat(64)

function fixture() {
  const reached = []
  const answer = (path, request) => {
    if (path === '/_head/bootstrap-status') return { ok: true, phase: 'complete', seedId: SEED, ballId: 'b'.repeat(64), epoch: 169 }
    if (path === '/_mirror/bootstrap-status') return { ok: true, phase: 'ready', seedId: SEED, ballId: 'b'.repeat(64), epoch: 169 }
    reached.push({ path, method: request.method, access: request.headers.get('x-x6-verified-access'), approval: request.headers.get('x-x6-class3-approval'),
      internal: request.headers.get('x-x6-internal-authorized'), seed: request.headers.get('x-x6-bootstrap-seed') })
    return { ok: true, stub: path }
  }
  const namespace = { idFromName: name => name, get: () => ({ fetch: async request => Response.json(answer(new URL(request.url).pathname, request)) }) }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64), HEAD: namespace, MIRROR: namespace }
  let access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  const worker = createWorker({ verifyAccess: async () => access })
  const call = (path, { method = 'POST', headers = {}, body = method === 'GET' ? undefined : '{"action":"issue"}' } = {}) => worker.fetch(new Request(ORIGIN + path, {
    method, headers: Object.fromEntries(Object.entries({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers })
      .filter(([, value]) => value !== undefined)),
    ...(body === undefined ? {} : { body }) }), env)
  return { call, reached, setAccess: value => { access = value } }
}

test('the owner reaches the three night grant routes, same-origin, with the approval header and owner access intact', async () => {
  const f = fixture()
  for (const [path, method] of [['/_head/night-grant', 'GET'], ['/_head/night-grant', 'POST'], ['/_head/night-grant/promote', 'POST']]) {
    const response = await f.call(path, { method, headers: { 'x-x6-class3-approval': 'approval-token-fixture' } })
    assert.equal(response.status, 200, `${method} ${path} ${await response.clone().text()}`)
    assert.deepEqual(await response.json(), { ok: true, stub: path })
    const seen = f.reached.at(-1)
    assert.equal(seen.path, path); assert.equal(seen.method, method)
    assert.equal(JSON.parse(seen.access).type, 'owner')
    assert.equal(seen.approval, 'approval-token-fixture')
    assert.equal(seen.seed, SEED)
  }
  // A GET without an Origin header (a plain same-origin read) is admitted like other owner reads.
  assert.equal((await f.call('/_head/night-grant', { method: 'GET', headers: { origin: undefined } })).status, 200)
})

test('non-owner, signed-out, cross-origin, cross-site, wrong method and query callers are refused before HEAD', async () => {
  const f = fixture()
  const cases = []
  for (const path of ['/_head/night-grant', '/_head/night-grant/promote']) {
    cases.push([path, 'POST', { origin: 'https://evil.example' }, 403, 'ORIGIN_REFUSED'])
    cases.push([path, 'POST', { 'sec-fetch-site': 'cross-site' }, 403, 'CROSS_SITE_REFUSED'])
    cases.push([path, 'POST', { 'sec-fetch-site': 'same-site' }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'])
    cases.push([path + '?x=1', 'POST', {}, 404, 'NOT_FOUND'])
    cases.push([path, 'PUT', {}, 405, 'METHOD_UNAVAILABLE'])
  }
  cases.push(['/_head/night-grant/promote', 'GET', {}, 405, 'METHOD_UNAVAILABLE'])
  cases.push(['/_head/night-grant', 'GET', { 'sec-fetch-site': 'cross-site' }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'])
  for (const [path, method, headers, status, code] of cases) {
    const response = await f.call(path, { method, headers })
    assert.equal(response.status, status, `${method} ${path} ${JSON.stringify(headers)}`)
    assert.equal((await response.json()).code, code, `${method} ${path}`)
  }
  // Signed in through Cloudflare Access but not as the owner type, as /_head/promote refuses it.
  f.setAccess({ type: 'access', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 })
  for (const [path, method] of [['/_head/night-grant', 'GET'], ['/_head/night-grant', 'POST'], ['/_head/night-grant/promote', 'POST']]) {
    const response = await f.call(path, { method })
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'OWNER_ACCESS_REQUIRED')
  }
  f.setAccess(null)
  for (const [path, method] of [['/_head/night-grant', 'GET'], ['/_head/night-grant', 'POST'], ['/_head/night-grant/promote', 'POST']]) {
    const response = await f.call(path, { method, headers: { 'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: 4102444800 }), 'x-x6-internal-authorized': '1' } })
    assert.equal(response.status, 401); assert.equal((await response.json()).code, 'OWNER_ACCESS_REQUIRED')
  }
  assert.deepEqual(f.reached, [])
})
