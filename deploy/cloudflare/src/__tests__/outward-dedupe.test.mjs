/** Synthetic transactional reservations and injected GitHub responses only; no live posts. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { X61HeadDurableObject } from '../head-do.mjs'
import { handleCloudBroker } from '../cloud-brokers.mjs'
import { createWorker } from '../worker.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'

const ORIGIN = 'https://outward.example.invalid', NOW = 1794367000000
const COUNT = 'head:outward:v1:count', PREFIX = 'head:outward:v1:body:'
const body = { action: 'api', method: 'POST', endpoint: '/repos/your_org_x/your-node/issues', body: { title: 'Synthetic title', body: 'Synthetic body' } }
const bindingFor = input => ({ schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/github', bodySha256: createHash('sha256').update(canonicalJson(input)).digest('hex') })

function fixture(initial = new Map()) {
  let rows = structuredClone(initial), tail = Promise.resolve(), consumed = 0
  const storage = { transaction: operation => {
    const next = tail.then(async () => {
      const nextRows = structuredClone(rows)
      const tx = { get: async key => structuredClone(nextRows.get(key)), put: async (key, value) => nextRows.set(key, structuredClone(value)),
        list: async ({ prefix, limit }) => new Map([...nextRows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) }
      const value = await operation(tx)
      rows = nextRows
      return value
    })
    tail = next.catch(() => {})
    return next
  } }
  const head = Object.create(X61HeadDurableObject.prototype)
  head.state = { storage }
  head.aumlokStore = {
    consumeApproval: () => assert.fail('Outward effects must reserve in the approval transaction'),
    consumeApprovalInTransaction: async (tx, token, binding) => {
      if (token === 'invalid' || await tx.get('approval:' + token)) throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
      await tx.put('approval:' + token, true); consumed++
      return { ok: true, binding, expiresAt: NOW + 60000 }
    },
  }
  return { head, storage, snapshot: () => structuredClone(rows), get consumed() { return consumed } }
}

test('outward reservation and approval consumption commit atomically with content-free metadata', async () => {
  const f = fixture(), binding = bindingFor(body)
  const result = await f.head.consumeClass3('one', binding, ORIGIN)
  assert.equal(result.ok, true); assert.deepEqual(result.binding, binding)
  const rows = f.snapshot()
  assert.equal(rows.get(COUNT), 1); assert.equal(rows.get('approval:one'), true)
  assert.equal(rows.get(PREFIX + binding.bodySha256).bodySha256, binding.bodySha256)
  assert.equal(JSON.stringify([...rows]).includes('Synthetic body'), false)
  await assert.rejects(f.head.consumeClass3('two', binding, ORIGIN), { code: 'OUTWARD_BODY_ALREADY_RESERVED' })
  assert.equal(f.snapshot().has('approval:two'), false)
  assert.equal(f.snapshot().get(COUNT), 1)
})

test('concurrent distinct approvals for one body admit exactly one durable reservation', async () => {
  const f = fixture(), binding = bindingFor(body)
  const results = await Promise.allSettled(['one', 'two', 'three'].map(token => f.head.consumeClass3(token, binding, ORIGIN)))
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1)
  assert.deepEqual(results.filter(value => value.status === 'rejected').map(value => value.reason.code), ['OUTWARD_BODY_ALREADY_RESERVED', 'OUTWARD_BODY_ALREADY_RESERVED'])
  assert.equal(f.snapshot().get(COUNT), 1)
  assert.equal([...f.snapshot().keys()].filter(key => key.startsWith('approval:')).length, 1)
})

test('invalid approvals never create reservations; distinct approved bodies remain independent', async () => {
  const f = fixture(), binding = bindingFor(body)
  await assert.rejects(f.head.consumeClass3('invalid', binding, ORIGIN), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  assert.equal(f.snapshot().size, 0)
  await f.head.consumeClass3('one', binding, ORIGIN)
  await f.head.consumeClass3('two', bindingFor({ ...body, body: { ...body.body, body: 'Different synthetic body' } }), ORIGIN)
  assert.equal(f.snapshot().get(COUNT), 2)
})

test('missing, malformed and exhausted ledger counts fail closed without consuming approval', async () => {
  for (const initial of [new Map([[COUNT, -1]]), new Map([[COUNT, null]]), new Map([[COUNT, NaN]]), new Map([[COUNT, '1']]), new Map([[COUNT, 4096]]), new Map([[PREFIX + 'a'.repeat(64), { bodySha256: 'a'.repeat(64) }]])]) {
    const f = fixture(initial), before = f.snapshot()
    await assert.rejects(f.head.consumeClass3('one', bindingFor(body), ORIGIN), error => ['OUTWARD_LEDGER_INVALID', 'OUTWARD_LEDGER_FULL'].includes(error.code))
    assert.deepEqual(f.snapshot(), before); assert.equal(f.consumed, 0)
  }
})

test('transaction failure rolls back approval and reservation together', async () => {
  const f = fixture(), original = f.head.aumlokStore.consumeApprovalInTransaction
  f.head.aumlokStore.consumeApprovalInTransaction = async (...args) => { await original(...args); throw new Error('Synthetic storage failure') }
  await assert.rejects(f.head.consumeClass3('one', bindingFor(body), ORIGIN), /Synthetic storage failure/)
  assert.equal(f.snapshot().size, 0)
})

test('non-outward approval types keep their existing owner-specific consumption path', async () => {
  const f = fixture()
  f.head.aumlokStore.consumeApproval = async (_token, binding) => ({ ok: true, binding })
  const binding = { ...bindingFor(body), pathname: '/_host/repo' }
  assert.equal((await f.head.consumeClass3('one', binding, ORIGIN)).ok, true)
  assert.equal(f.snapshot().size, 0)
})

async function brokerPost(f, token, networkFetch) {
  const request = new Request(ORIGIN + '/_host/github', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await handleCloudBroker(request, { GITHUB_TOKEN: 'synthetic-token-fixture' }, { bootstrap: { ready: true }, now: () => NOW,
    authorizeClass3: value => f.head.consumeClass3(token, bindingFor(value), ORIGIN), networkFetch })
  return { status: result.status, value: await result.json() }
}

test('broker dispatch stays single after a reload with a fresh approval', async () => {
  const f = fixture(); let writes = 0
  const response = async (_url, init) => {
    assert.equal(init.method, 'POST'); writes++
    return Response.json({ id: 101, number: 1, state: 'open', title: body.body.title, body: body.body.body, html_url: 'https://github.com/your_org_x/your-node/issues/1' })
  }
  assert.equal((await brokerPost(f, 'one', response)).status, 200)
  const replay = await brokerPost(f, 'two', response)
  assert.equal(replay.status, 409); assert.equal(replay.value.code, 'OUTWARD_BODY_ALREADY_RESERVED'); assert.equal(writes, 1)
})

test('unknown provider outcome retains the reservation and cannot automatically repost', async () => {
  const f = fixture(); let writes = 0
  const response = async () => { writes++; throw new Error('Synthetic lost response after dispatch') }
  assert.equal((await brokerPost(f, 'one', response)).value.code, 'GITHUB_MUTATION_OUTCOME_UNKNOWN')
  assert.equal((await brokerPost(f, 'two', response)).value.code, 'OUTWARD_BODY_ALREADY_RESERVED')
  assert.equal(writes, 1); assert.equal(f.snapshot().get(COUNT), 1)
})


test('real Worker and HEAD routes preserve duplicate and capacity refusal semantics', async t => {
  for (const full of [false, true]) {
    const f = fixture(full ? new Map([[COUNT, 4096]]) : new Map()), at = Date.now()
    const status = { ok: true, phase: 'complete', seedId: 'a'.repeat(64), ballId: 'b'.repeat(64), epoch: 2 }
    const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: 'owner@example.invalid', GITHUB_TOKEN: 'synthetic-token-fixture', ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture' }
    const head = new X61HeadDurableObject({ storage: f.storage, getWebSockets: () => [] }, env)
    t.after(() => head.wakeStore.dispose())
    head.store.bootstrapStatus = async () => status
    head.aumlokStore = f.head.aumlokStore
    env.HEAD = { idFromName: name => name, get: () => ({ fetch: request => head.fetch(request) }) }
    env.MIRROR = { idFromName: name => name, get: () => ({ fetch: async request => {
      assert.equal(new URL(request.url).pathname, '/_mirror/bootstrap-status')
      return Response.json({ ...status, phase: 'ready' })
    } }) }
    let writes = 0
    const worker = createWorker({ now: () => NOW, verifyAccess: async () => ({ type: 'owner', email: env.OWNER_EMAIL, expires: at / 1000 + 3600 }),
      networkFetch: async (_url, init) => {
        assert.equal(init.method, 'POST'); writes++
        return Response.json({ id: 101, number: 1, state: 'open', title: body.body.title, body: body.body.body, html_url: 'https://github.com/your_org_x/your-node/issues/1' })
      } })
    const send = token => worker.fetch(new Request(ORIGIN + '/_host/github', { method: 'POST', headers: {
      origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-x6-class3-approval': token,
    }, body: JSON.stringify(body) }), env)
    if (!full) { const first = await send('one'); assert.equal(first.status, 200, await first.text()) }
    const refused = await send('two'), value = await refused.json()
    assert.equal(refused.status, full ? 507 : 409, JSON.stringify(value))
    assert.equal(value.code, full ? 'OUTWARD_LEDGER_FULL' : 'OUTWARD_BODY_ALREADY_RESERVED')
    assert.equal(writes, full ? 0 : 1)
    assert.equal(f.snapshot().has('approval:two'), false)
  }
})
