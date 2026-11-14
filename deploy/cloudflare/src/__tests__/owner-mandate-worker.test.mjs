/** The Worker side of /_head/mandate over a stub HEAD. Owner-only (his email, a live session) and same-origin,
 * like the night grant; no session is 401 and any other session 403 on all three routes (status, issue, revoke), and
 * neither reaches HEAD. The owner's request reaches HEAD unchanged, with his verified access and the approval header. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker } from '../worker.mjs'

const ORIGIN = 'https://mandate.example.invalid'
const OWNER = 'owner@example.invalid'
const SEED = 'a'.repeat(64)
const ROUTES = [['GET', undefined], ['POST', '{"action":"issue","terms":{}}'], ['POST', '{"action":"revoke","id":"mandate-0000000000000001"}']]

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
  const call = (path, { method = 'POST', headers = {}, body = method === 'GET' ? undefined : '{"action":"issue","terms":{}}' } = {}) => worker.fetch(new Request(ORIGIN + path, {
    method, headers: Object.fromEntries(Object.entries({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers })
      .filter(([, value]) => value !== undefined)),
    ...(body === undefined ? {} : { body }) }), env)
  return { call, reached, setAccess: value => { access = value } }
}

test('the owner reaches status, issue and revoke, same-origin, with his verified access and the approval header intact', async () => {
  const f = fixture()
  for (const [method, body] of ROUTES) {
    const response = await f.call('/_head/mandate', { method, body, headers: { 'x-x6-class3-approval': 'approval-fixture' } })
    assert.equal(response.status, 200, `${method} ${await response.clone().text()}`)
    assert.deepEqual(await response.json(), { ok: true, stub: '/_head/mandate' })
    const seen = f.reached.at(-1)
    assert.equal(seen.method, method)
    assert.deepEqual(JSON.parse(seen.access), { type: 'owner', email: OWNER, expires: JSON.parse(seen.access).expires })
    assert.equal(seen.approval, 'approval-fixture'); assert.equal(seen.internal, '1'); assert.equal(seen.seed, SEED)
  }
  assert.equal((await f.call('/_head/mandate', { method: 'GET', headers: { origin: undefined } })).status, 200)
})

test('no session is 401 and a session that is not the owner is 403 on all three routes; none reaches HEAD', async () => {
  const f = fixture()
  for (const access of [{ type: 'access', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 },
    { type: 'owner', email: 'someone@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 },
    { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) - 5 }]) {
    f.setAccess(access)
    for (const [method, body] of ROUTES) {
      const response = await f.call('/_head/mandate', { method, body, headers: { 'x-x6-class3-approval': 'approval-fixture' } })
      assert.equal(response.status, 403, `${method} ${JSON.stringify(access)}`); assert.equal((await response.json()).code, 'OWNER_ACCESS_REQUIRED')
    }
  }
  f.setAccess(null)
  for (const [method, body] of ROUTES) {
    const response = await f.call('/_head/mandate', { method, body, headers: { 'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: 4102444800 }), 'x-x6-internal-authorized': '1' } })
    assert.equal(response.status, 401, method); assert.equal((await response.json()).code, 'OWNER_ACCESS_REQUIRED')
  }
  assert.deepEqual(f.reached, [])
})

test('cross-origin, cross-site, a query and a wrong method are refused before HEAD', async () => {
  const f = fixture()
  const cases = [
    ['/_head/mandate', 'POST', { origin: 'https://evil.example' }, undefined, 403],
    ['/_head/mandate', 'POST', { 'sec-fetch-site': 'cross-site' }, undefined, 403],
    ['/_head/mandate', 'POST', { 'sec-fetch-site': 'same-site' }, undefined, 403],
    ['/_head/mandate', 'GET', { 'sec-fetch-site': 'cross-site' }, undefined, 403],
    ['/_head/mandate?x=1', 'POST', {}, undefined, 404],
    ['/_head/mandate', 'PUT', {}, undefined, 405],
    ['/_head/mandate', 'DELETE', {}, undefined, 405],
  ]
  for (const [path, method, headers, body, status] of cases) {
    const response = await f.call(path, { method, headers, ...(body === undefined ? {} : { body }) })
    assert.equal(response.status, status, `${method} ${path} ${JSON.stringify(headers)}`)
  }
  assert.deepEqual(f.reached, [])
})
