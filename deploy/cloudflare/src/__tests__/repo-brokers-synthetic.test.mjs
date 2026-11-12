/** Synthetic-only broker tests: no ambient fetch, credentials, or provider mutations. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { handleCloudBroker, CLOUD_BROKER_LIMITS } from '../cloud-brokers.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'

const ORIGIN = 'https://fixture.example', NOW = 1794367000000
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), TREE = 'c'.repeat(40)
const BRANCH = 'auma/proposal/fixture-fix', ATTEMPT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const owner = { type: 'owner', email: 'owner@fixture.example', expires: NOW / 1000 + 600 }
const body = { action: 'merge_proposal', branch: BRANCH, baseSha: BASE, headSha: HEAD, treeSha: TREE }
const binding = { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/repo', bodySha256: createHash('sha256').update(canonicalJson(body)).digest('hex') }

function fixture({ access = owner, main = HEAD, branch = HEAD, pending = {}, hook, storage } = {}) {
  const calls = [], messages = []
  const env = { OWNER_EMAIL: owner.email, GITHUB_TOKEN: 'fixture-token', HEAD: { idFromName: name => name, get: () => ({ fetch: async request => {
    assert.equal(request.headers.get('x-x6-internal-authorized'), '1')
    assert.deepEqual(JSON.parse(request.headers.get('x-x6-verified-access')), owner)
    const input = await request.json(); messages.push(input)
    if (storage) return storage(input)
    if (input.action === 'inspect_merge') return Response.json({ ok: true, attemptId: ATTEMPT, mergeBody: body, binding, ...pending })
    assert.equal(input.action, 'reconcile_merge')
    return Response.json({ ok: true, status: input.verification.mainSha === HEAD ? 'succeeded' : 'unknown', attemptId: ATTEMPT })
  } }) } }
  return { calls, messages, async request(input, signal) {
    const request = new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(input), signal })
    const response = await handleCloudBroker(request, env, { access, bootstrap: { ready: true, head: { seedId: '1'.repeat(64) } }, now: () => NOW,
      authorizeClass3: () => { throw new Error('Read-only reconciliation must not consume approval') },
      networkFetch: async (raw, init) => {
        const url = new URL(raw); calls.push({ url, init })
        assert.equal(url.origin, 'https://api.github.com'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error')
        if (hook) { const value = await hook(url, init); if (value !== undefined) return value }
        if (url.pathname.endsWith('/git/ref/heads/main')) return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: main } })
        if (url.pathname.endsWith('/git/ref/heads/' + BRANCH)) return branch === null ? new Response(null, { status: 404 }) : Response.json({ ref: 'refs/heads/' + BRANCH, object: { type: 'commit', sha: branch } })
        if (url.pathname.endsWith('/commits/' + HEAD)) return Response.json({ sha: HEAD, commit: { tree: { sha: TREE } } })
        throw new Error('Unexpected synthetic provider read ' + url.pathname)
      } })
    return { status: response.status, value: await response.json() }
  } }
}

test('stage_proposal refuses sandbox and malformed proposal branches before provider or storage access', async () => {
  for (const branch of ['auma/sandbox/fixture-fix', 'main', 'auma/proposal/a', 'auma/proposal/' + 'a'.repeat(62), 'auma/proposal/Upper', 'auma/proposal/a/b', 'auma/proposal/ab..cd', 'auma/proposal/ab.', 'auma/proposal/ab.lock', null]) {
    const broker = fixture(), result = await broker.request({ action: 'stage_proposal', branch, title: 'Fix' })
    assert.equal(result.status, 403, String(branch)); assert.equal(result.value.code, 'REPO_BRANCH_REFUSED')
    assert.equal(broker.calls.length, 0); assert.equal(broker.messages.length, 0)
  }
})

test('valid proposal namespace reaches provider inspection including suffix length bounds', async () => {
  for (const branch of ['auma/proposal/ab', 'auma/proposal/' + 'a'.repeat(61), 'auma/proposal/fix_1.2-3']) {
    const broker = fixture({ hook: () => new Response(null, { status: 404 }) })
    const result = await broker.request({ action: 'stage_proposal', branch, title: 'Fix' })
    assert.equal(result.value.code, 'BROKER_NOT_FOUND'); assert.equal(broker.calls.length, 1)
  }
})

test('reconcile_proposal reads exact durable attempt and submits correlated verification without provider writes', async () => {
  const broker = fixture(), result = await broker.request({ action: 'reconcile_proposal' })
  assert.equal(result.status, 200); assert.equal(result.value.status, 'succeeded'); assert.equal(result.value.action, 'reconcile_proposal')
  assert.equal(broker.calls.length, 3)
  assert.deepEqual(broker.messages, [{ action: 'inspect_merge' }, { action: 'reconcile_merge', attemptId: ATTEMPT, mergeBody: body, binding,
    verification: { mainSha: HEAD, branchSha: HEAD, treeSha: TREE, checkedAt: NOW } }])
})

test('base, divergence and deleted proposal refs remain observations for the durable owner', async () => {
  for (const main of [BASE, 'd'.repeat(40)]) {
    const broker = fixture({ main, branch: null }), result = await broker.request({ action: 'reconcile_proposal' })
    assert.equal(result.value.status, 'unknown'); assert.equal(broker.messages[1].verification.branchSha, null)
    assert.equal(broker.messages[1].verification.mainSha, main); assert.equal(broker.calls.length, 3)
  }
})

test('reconciliation refuses non-owner and caller-supplied evidence before storage or provider reads', async () => {
  for (const access of [null, { ...owner, type: 'guest' }, { ...owner, email: 'other@fixture.example' }, { ...owner, expires: NOW / 1000 }]) {
    const broker = fixture({ access }), result = await broker.request({ action: 'reconcile_proposal' })
    assert.equal(result.value.code, 'OWNER_SESSION_REQUIRED'); assert.equal(broker.messages.length, 0); assert.equal(broker.calls.length, 0)
  }
  for (const extra of [{ mergeBody: body }, { verification: { mainSha: HEAD } }, { attemptId: ATTEMPT }, { ownerSession: 'forged' }]) {
    const broker = fixture(), result = await broker.request({ action: 'reconcile_proposal', ...extra })
    assert.equal(result.value.code, 'BROKER_QUERY_INVALID'); assert.equal(broker.messages.length, 0)
  }
})

test('invalid stored merge identity and binding fail closed before provider reads', async () => {
  for (const pending of [{ attemptId: 'bad' }, { mergeBody: { ...body, branch: 'auma/sandbox/fixture-fix' } }, { binding: { ...binding, bodySha256: '0'.repeat(64) } }, { mergeBody: { ...body, unexpected: true } }]) {
    const broker = fixture({ pending }), result = await broker.request({ action: 'reconcile_proposal' })
    assert.equal(result.value.code, 'REPO_PROPOSAL_STORAGE_FAILED'); assert.equal(broker.calls.length, 0); assert.equal(broker.messages.length, 1)
  }
})

test('malformed, redirected and oversized provider observations never reach durable reconciliation', async () => {
  for (const hook of [
    () => Response.json({ ref: 'refs/heads/other', object: { type: 'commit', sha: HEAD } }),
    () => new Response(null, { status: 302, headers: { location: 'https://other.example' } }),
    () => Response.json({ padding: 'x'.repeat(CLOUD_BROKER_LIMITS.responseBytes) }),
    url => url.pathname.includes('/commits/') ? Response.json({ sha: BASE, commit: { tree: { sha: TREE } } }) : undefined,
  ]) {
    const broker = fixture({ hook }), result = await broker.request({ action: 'reconcile_proposal' })
    assert.notEqual(result.status, 200); assert.equal(broker.messages.length, 1)
  }
})

test('reconciliation propagates a durable attempt conflict without retrying provider reads', async () => {
  const broker = fixture({ storage: input => input.action === 'inspect_merge' ? Response.json({ ok: true, attemptId: ATTEMPT, mergeBody: body, binding }) : Response.json({ ok: false, code: 'REPO_PROPOSAL_MISMATCH' }, { status: 409 }) })
  const result = await broker.request({ action: 'reconcile_proposal' })
  assert.equal(result.status, 409); assert.equal(result.value.code, 'REPO_PROPOSAL_MISMATCH'); assert.equal(broker.calls.length, 3)
})

test('one total deadline bounds reconciliation reads and prevents late durable completion', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const first = Promise.withResolvers(), second = Promise.withResolvers()
    let count = 0
    const broker = fixture({ hook: async () => {
      count++; (count === 1 ? first : second).resolve()
      await new Promise(resolve => setTimeout(resolve, 6000))
    } })
    const pending = broker.request({ action: 'reconcile_proposal' })
    await first.promise; context.mock.timers.tick(6000)
    await second.promise; context.mock.timers.tick(4001)
    assert.equal((await pending).status, 408)
    context.mock.timers.tick(6000); await new Promise(resolve => setImmediate(resolve))
    assert.equal(broker.calls.length, 2); assert.equal(broker.messages.length, 1)
  } finally { context.mock.timers.reset() }
})

test('owner cancellation during reconciliation never sends a late durable observation', async () => {
  const reached = Promise.withResolvers(), resume = Promise.withResolvers(), abort = new AbortController()
  const broker = fixture({ hook: async () => { reached.resolve(); await resume.promise } })
  const pending = broker.request({ action: 'reconcile_proposal' }, abort.signal)
  await reached.promise; abort.abort()
  assert.equal((await pending).status, 408)
  resume.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(broker.calls.length, 1); assert.equal(broker.messages.length, 1)
})
