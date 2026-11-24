/** Her Linear door through the real Worker (worker.mjs LINDOOR hooks). A fake Linear and a fake HEAD; nothing real. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker } from '../worker.mjs'

const ORIGIN = 'https://linear-door.example.invalid'
const SEED = 'a'.repeat(64)
const KEY = 'made-up-linear-key-for-the-worker-test-0001'
const UUID1 = '11111111-1111-4111-8111-111111111111'

function workerFixture(env = {}) {
  const reached = []
  const approvals = []
  const namespace = { idFromName: name => name, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    reached.push(path)
    if (path === '/_head/bootstrap-status') return Response.json({ ok: true, phase: 'complete', seedId: SEED, ballId: 'b'.repeat(64), epoch: 172 })
    if (path === '/_mirror/bootstrap-status') return Response.json({ ok: true, phase: 'ready', seedId: SEED, ballId: 'b'.repeat(64), epoch: 172 })
    if (path === '/_head/class3-authorize') {
      // HEAD consumes the one-time approval for exactly the binding the edge computed from the body it holds.
      const { token, binding } = await request.json()
      approvals.push({ token, binding })
      if (token !== 'made-up-good-approval' || approvals.filter(item => item.token === token).length > 1) return Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' }, { status: 403 })
      return Response.json({ ok: true, binding, expiresAt: Date.now() + 60_000 })
    }
    return Response.json({ ok: true, stub: path })
  } }) }
  const full = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: 'owner@example.invalid', OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64), HEAD: namespace, MIRROR: namespace,
    LINEAR_API_KEY: KEY, LINEAR_DOOR_LEVEL: 'open', ...env }
  let access = { type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }
  const worker = createWorker({ verifyAccess: async () => access })
  const call = (path, { method = 'POST', headers = {}, body } = {}) => worker.fetch(new Request(ORIGIN + path, {
    method,
    headers: Object.fromEntries(Object.entries({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers })
      .filter(([, value]) => value !== undefined)),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), full)
  return { call, reached, approvals, setAccess: value => { access = value } }
}

async function withLinear(answer, run) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url: String(url), authorization: init.headers.authorization, query: body.query, variables: body.variables })
    return Response.json(answer(body.query))
  }
  try { return await run(calls) } finally { globalThis.fetch = real }
}

const result = async response => {
  const text = await response.text()
  assert.ok(!text.includes(KEY))
  return { status: response.status, body: JSON.parse(text) }
}

test('through the Worker: the owner reads and writes from her own page; the key goes only to Linear', async () => {
  await withLinear(query => (/^mutation/.test(query) ? { data: { commentCreate: { success: true, comment: { id: 'c1' } } } } : { data: { teams: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }), async calls => {
    const f = workerFixture()
    assert.deepEqual(await result(await f.call('/_host/linear', { body: { action: 'teams' } })), { status: 200, body: { ok: true, action: 'teams', level: 'open', result: [], page: { hasNextPage: false, endCursor: null } } })
    const wrote = await result(await f.call('/_host/linear', { body: { action: 'comment', requestId: 'request-worker-0001', issue: UUID1, body: 'From Auma.' } }))
    assert.equal(wrote.status, 200)
    assert.equal(calls.length, 2)
    assert.ok(calls.every(call => call.url === 'https://api.linear.app/graphql' && call.authorization === KEY))
    assert.deepEqual([...new Set(f.reached)].sort(), ['/_head/bootstrap-status', '/_mirror/bootstrap-status'], 'an open write asks HEAD for nothing')
  })
})

test('through the Worker: the core is held without the passkey, then sent once with his one-time approval of these bytes', async () => {
  await withLinear(query => ({ data: { issueDelete: { success: true } } }), async calls => {
    const f = workerFixture()
    const body = { action: 'issue_delete', requestId: 'request-worker-0002', id: UUID1 }
    const held = await result(await f.call('/_host/linear', { body }))
    assert.deepEqual([held.status, held.body.code, held.body.reason], [403, 'CLASS3_WEBAUTHN_REQUIRED', 'delete'])
    assert.equal(calls.length, 0)
    const wrong = await result(await f.call('/_host/linear', { body, headers: { 'x-x6-class3-approval': 'made-up-other-approval' } }))
    assert.equal(wrong.status, 403)
    assert.equal(calls.length, 0)
    const sent = await result(await f.call('/_host/linear', { body, headers: { 'x-x6-class3-approval': 'made-up-good-approval' } }))
    assert.deepEqual([sent.status, sent.body.approved], [200, 'delete'])
    assert.equal(calls.length, 1)
    // HEAD was asked to consume exactly the binding of this path, method and body.
    const binding = f.approvals.at(-1).binding
    assert.deepEqual([binding.schema, binding.audience, binding.method, binding.pathname], ['aukora.class3.action.v1', ORIGIN, 'POST', '/_host/linear'])
    // The same approval again is spent; the same request again is the first answer, and Linear is not called twice.
    const again = await result(await f.call('/_host/linear', { body, headers: { 'x-x6-class3-approval': 'made-up-good-approval' } }))
    assert.deepEqual(again.body, { ...sent.body, repeated: true })
    assert.equal(calls.length, 1)
  })
})

test('through the Worker: another method, a query, another origin or no owner is refused before the body is read or HEAD is asked', async () => {
  await withLinear(() => ({ data: {} }), async calls => {
    const f = workerFixture()
    assert.deepEqual(await result(await f.call('/_host/linear', { method: 'GET' })), { status: 405, body: { ok: false, code: 'METHOD_UNAVAILABLE' } })
    assert.deepEqual(await result(await f.call('/_host/linear?x=1', { body: { action: 'teams' } })), { status: 404, body: { ok: false, code: 'NOT_FOUND' } })
    // Another origin or a cross-site fetch is refused by the Worker's own POST rules first; a missing Origin or fetch-site by the hook.
    for (const headers of [{ origin: 'https://evil.example' }, { origin: undefined }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': undefined }]) {
      const refused = await result(await f.call('/_host/linear', { body: { action: 'teams' }, headers }))
      assert.equal(refused.status, 403, JSON.stringify(headers))
      assert.ok(['ORIGIN_REFUSED', 'CROSS_SITE_REFUSED', 'SAME_ORIGIN_BROWSER_REQUIRED'].includes(refused.body.code), refused.body.code)
    }
    f.setAccess({ type: 'access', email: 'guest@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 })
    assert.deepEqual(await result(await f.call('/_host/linear', { body: { action: 'teams' } })), { status: 403, body: { ok: false, code: 'OWNER_ACCESS_REQUIRED' } })
    f.setAccess(null)
    assert.equal((await f.call('/_host/linear', { body: { action: 'teams' } })).status, 401)
    assert.equal(calls.length, 0)
    assert.deepEqual(f.reached, [], 'nothing reached HEAD or MIRROR')
  })
})

test('through the Worker: a body over 64 KiB is refused before it reaches the door', async () => {
  await withLinear(() => ({ data: {} }), async calls => {
    const f = workerFixture()
    const response = await f.call('/_host/linear', { body: { action: 'search', text: 'x'.repeat(70 * 1024) }, headers: { 'content-length': String(70 * 1024 + 40) } })
    assert.equal(response.status, 413)
    assert.equal(calls.length, 0)
  })
})

test('through the Worker: not configured answers LINEAR_NOT_CONFIGURED naming the NAME, and calls nothing', async () => {
  await withLinear(() => { throw new Error('must not be called') }, async calls => {
    const f = workerFixture({ LINEAR_API_KEY: undefined })
    assert.deepEqual(await result(await f.call('/_host/linear', { body: { action: 'teams' } })), { status: 503, body: { ok: false, code: 'LINEAR_NOT_CONFIGURED', missing: 'LINEAR_API_KEY' } })
    assert.equal(calls.length, 0)
  })
})
