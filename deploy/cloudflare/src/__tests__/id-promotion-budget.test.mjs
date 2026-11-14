import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJson, headPromotionBinding } from '../owner-grant-policy.mjs'
import { bootstrapPackage, createDurableHeadStore, digest, manifestId, manifestIdCanon, X61HeadDurableObject } from '../head-do.mjs'

const WINDOW = 12 * 60 * 60 * 1000
const MARKER = 'head:id-promotion-budget:initialized:v1'
const LEDGER = 'head:id-promotion-budget:ledger:v1'
function storageFixture() {
  let data = new Map(), tail = Promise.resolve(), onPut = () => {}
  const view = map => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)); onPut(key, value) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
  })
  return {
    onPut(callback) { onPut = callback },
    ...Object.fromEntries(['get', 'put', 'delete', 'list'].map(method => [method, (...args) => view(data)[method](...args)])),
    transaction(operation) {
      const result = tail.then(async () => {
        const copy = structuredClone(data), value = await operation(view(copy))
        data = copy
        return value
      })
      tail = result.catch(() => undefined)
      return result
    },
  }
}
async function fixture(options = {}) {
  const storage = storageFixture()
  let time = 1_800_000_000_000
  const create = () => createDurableHeadStore(storage, { now: () => time, allowPasskeyOnlyGovernance: true, ...options })
  const store = create(), code = 'module.exports={name:"seed-echo",run(){return 1}}', sha = await digest(code)
  const ball = { version: 'x6.1-ball/v1', epoch: 1, parentBallId: null, authorPeerId: 'writer',
    entries: { 'seed-echo': { id: 'seed-echo', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  ball.ballId = await manifestIdCanon(ball)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } })
  assert.equal((await store.bootstrapPrepare(seed)).ok, true)
  assert.equal((await store.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId, ballId: ball.ballId,
    epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  let lease
  const acquire = async (object = store) => {
    lease = (await object.lease({ action: 'acquire', ownerPeerId: 'writer' })).lease
    assert.ok(lease)
  }
  await acquire()
  const request = async (n, extra = {}) => ({ action: 'reserve-id-promotion', ownerPeerId: 'writer', generation: lease.generation,
    expectedBallId: ball.ballId, organId: 'seed-echo', candidateSha: await digest(`candidate ${n}`), ...extra })
  const reserve = async (n, extra = {}, object = store) => object.lease(await request(n, extra))
  const candidate = async () => {
    const code = 'module.exports={name:"seed-echo",run(){return 2}}', sha = await digest(code)
    const next = structuredClone(ball)
    next.parentBallId = ball.ballId; next.epoch++
    next.entries['seed-echo'].specifier = `ball:${sha}`
    next.modules[sha] = { sha256: sha, specifier: `ball:${sha}` }
    next.ballId = await manifestIdCanon(next)
    return { ball: next, codeBySha: { [sha]: code }, expectedParentBallId: ball.ballId, expectedEpoch: ball.epoch, writerLease: lease }
  }
  return { storage, store, create, ball, seed, acquire, request, reserve, candidate, now: () => time,
    advance: amount => { time += amount }, setTime: value => { time = value } }
}

test('rolling limit charges twelve distinct operations and refuses the thirteenth', async () => {
  const f = await fixture()
  for (let n = 0; n < 12; n++) {
    const result = await f.reserve(n)
    assert.equal(result.ok, true); assert.equal(result.used, n + 1)
    assert.equal(result.limit, 12); assert.equal(result.windowMs, WINDOW)
    assert.equal(result.expiresAt, result.reservedAt + WINDOW)
    assert.equal(result.authorityNow, f.now())
  }
  assert.equal((await f.reserve(12)).code, 'ID_PROMOTION_LIMIT_REACHED')
})

test('same operation is idempotent across object recreation and lost acknowledgement', async () => {
  const f = await fixture(), first = await f.reserve(0), recreated = f.create()
  const retry = await f.reserve(0, {}, recreated)
  assert.equal(retry.ok, true); assert.equal(retry.idempotent, true)
  assert.equal(retry.operationId, first.operationId); assert.equal(retry.used, 1)
  assert.equal((await f.storage.get(LEDGER)).reservations.length, 1)
})

test('concurrent independent object requests cannot overrun durable count', async () => {
  const f = await fixture(), other = f.create()
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.reserve(i, {}, i % 2 ? other : f.store)))
  assert.equal(results.filter(row => row.ok).length, 12)
  assert.equal(results.filter(row => row.code === 'ID_PROMOTION_LIMIT_REACHED').length, 8)
})

test('failure or uncertainty does not release a slot; no completion report is necessary', async () => {
  const f = await fixture()
  for (let i = 0; i < 12; i++) assert.equal((await f.reserve(i)).ok, true)
  // No activation or publication follows these acknowledged reservations.
  assert.equal((await f.reserve(12)).code, 'ID_PROMOTION_LIMIT_REACHED')
})

test('rolling boundary releases old counts but expired same-operation retries refuse without recharge', async () => {
  const f = await fixture()
  for (let i = 0; i < 12; i++) await f.reserve(i)
  f.advance(WINDOW - 1); await f.acquire()
  assert.equal((await f.reserve(12)).code, 'ID_PROMOTION_LIMIT_REACHED')
  f.advance(1)
  assert.equal((await f.reserve(0)).code, 'ID_PROMOTION_RESERVATION_EXPIRED')
  const next = await f.reserve(12)
  assert.equal(next.ok, true); assert.equal(next.used, 1)
  assert.equal((await f.storage.get(LEDGER)).reservations.length, 13)
})

for (const key of [MARKER, LEDGER]) test(`missing authority key ${key} cannot be reset by request or recreation`, async () => {
  const f = await fixture(); await f.reserve(0); await f.storage.delete(key)
  assert.equal((await f.reserve(1)).code, 'ID_PROMOTION_AUTHORITY_INVALID')
  assert.equal((await f.reserve(1, {}, f.create())).code, 'ID_PROMOTION_AUTHORITY_INVALID')
  assert.equal(await f.storage.get(key), undefined)
})

for (const mutation of ['schema', 'future', 'duplicate', 'hash']) test(`malformed authority ${mutation} refuses`, async () => {
  const f = await fixture(); await f.reserve(0)
  const ledger = await f.storage.get(LEDGER)
  if (mutation === 'schema') ledger.schema = 'forged'
  if (mutation === 'future') ledger.observedAt = f.now() + 1
  if (mutation === 'duplicate') ledger.reservations.push(ledger.reservations[0])
  if (mutation === 'hash') ledger.reservations[0].candidateSha = 'f'.repeat(64)
  await f.storage.put(LEDGER, ledger)
  assert.equal((await f.reserve(1)).code, 'ID_PROMOTION_AUTHORITY_INVALID')
})

test('server clock rollback fails closed', async () => {
  const f = await fixture(); await f.reserve(0); f.advance(-1)
  assert.equal((await f.reserve(1)).code, 'ID_PROMOTION_AUTHORITY_INVALID')
})

for (const extra of [{ generation: 999 }, { ownerPeerId: 'other' }]) test(`wrong writer lease ${JSON.stringify(extra)} refuses`, async () => {
  const f = await fixture()
  assert.equal((await f.reserve(0, extra)).code, 'WRITER_LEASE_STALE')
})

test('stale HEAD, invalid sha and governance targets cannot reserve', async () => {
  const f = await fixture()
  assert.equal((await f.reserve(0, { expectedBallId: 'f'.repeat(64) })).code, 'ID_PROMOTION_HEAD_STALE')
  assert.equal((await f.reserve(0, { candidateSha: 'not-a-sha' })).code, 'ID_PROMOTION_REQUEST_INVALID')
  assert.equal((await f.reserve(0, { organId: 'seed-pearl' })).code, 'ID_PROMOTION_SCOPE_REFUSED')
  assert.equal((await f.storage.get(LEDGER)).reservations.length, 0)
})

test('ordinary direct publication cannot bypass reservation, and a matching reservation publishes', async () => {
  const f = await fixture(), input = await f.candidate()
  const options = { ownerSessionApproved: true, ownerSessionExpiresAt: f.now() + 60000 }
  assert.equal((await f.store.publish(input, options)).code, 'ID_PROMOTION_RESERVATION_REQUIRED')
  const sha = input.ball.entries['seed-echo'].specifier.slice(5)
  assert.equal((await f.reserve(0, { candidateSha: sha })).ok, true)
  assert.equal((await f.store.publish(input, options)).ok, true)
  assert.equal((await f.reserve(0, { candidateSha: sha })).code, 'ID_PROMOTION_HEAD_STALE')
})

test('a reservation for different candidate bytes cannot authorize publication', async () => {
  const f = await fixture(), input = await f.candidate(); await f.reserve(0)
  assert.equal((await f.store.publish(input, { ownerSessionApproved: true, ownerSessionExpiresAt: f.now() + 60000 })).code,
    'ID_PROMOTION_RESERVATION_REQUIRED')
})


test('legacy noncanonical and config-changing ordinary qualification cannot bypass budget', async () => {
  const f = await fixture({ verifyTransitionQualification: async request => ({ transitionSha256: request.transitionSha256,
    qualificationId: 'fixture-qualification-valid', expiresAt: 1_800_000_060_000 }) })
  for (const mode of ['noncanonical', 'config-change']) {
    const input = await f.candidate()
    if (mode === 'noncanonical') input.ball.ballId = await manifestId(input.ball)
    else { input.ball.entries['seed-echo'].config = { changed: true }; input.ball.ballId = await manifestIdCanon(input.ball) }
    const result = await f.store.publish(input)
    assert.equal(result.code, 'ID_PROMOTION_RESERVATION_REQUIRED', JSON.stringify(result))
  }
})

test('existing HEAD with neither key refuses across recreation and read requests', async () => {
  const f = await fixture()
  await f.storage.delete(MARKER); await f.storage.delete(LEDGER)
  const recreated = f.create()
  await recreated.inspectLease(); await recreated.read()
  assert.equal((await f.reserve(0, {}, recreated)).code, 'ID_PROMOTION_AUTHORITY_MISSING')
  assert.equal(await f.storage.get(MARKER), undefined)
  assert.equal(await f.storage.get(LEDGER), undefined)
})

test('authority storage failure fails closed', async () => {
  const f = await fixture(), transaction = f.storage.transaction
  f.storage.transaction = async () => { throw Error('storage unavailable') }
  await assert.rejects(f.reserve(0), /storage unavailable/)
  f.storage.transaction = transaction
  assert.equal((await f.storage.get(LEDGER)).reservations.length, 0)
})


test('retained expired operation receipts are bounded below the durable value-size ceiling', async () => {
  const f = await fixture(), ledger = await f.storage.get(LEDGER)
  for (let i = 0; i < 256; i++) {
    const request = await f.request(i)
    const row = { expectedBallId: request.expectedBallId, organId: request.organId, candidateSha: request.candidateSha }
    row.operationId = await digest(JSON.stringify({ candidateSha: row.candidateSha, expectedBallId: row.expectedBallId,
      organId: row.organId, schema: 'aukora.id-promotion-operation.v1' }))
    row.reservedAt = f.now(); ledger.reservations.push(row)
  }
  assert.ok(Buffer.byteLength(JSON.stringify(ledger)) < 120 * 1024)
  await f.storage.put(LEDGER, ledger); f.advance(WINDOW); await f.acquire()
  assert.equal((await f.reserve(256)).code, 'ID_PROMOTION_CAPACITY')
  assert.equal((await f.reserve(0)).code, 'ID_PROMOTION_RESERVATION_EXPIRED')
})

test('oversized malformed authority cannot enter an oversized storage rewrite', async () => {
  const f = await fixture(), ledger = await f.storage.get(LEDGER)
  ledger.extra = 'x'.repeat(120 * 1024)
  await f.storage.put(LEDGER, ledger)
  assert.equal((await f.reserve(0)).code, 'ID_PROMOTION_AUTHORITY_INVALID')
})


test('malformed ledger with thirteen live reservations cannot authorize existing receipt', async () => {
  const f = await fixture()
  for (let i = 0; i < 12; i++) await f.reserve(i)
  const ledger = await f.storage.get(LEDGER), request = await f.request(12)
  const operationId = await digest(JSON.stringify({ candidateSha: request.candidateSha, expectedBallId: request.expectedBallId,
    organId: request.organId, schema: 'aukora.id-promotion-operation.v1' }))
  ledger.reservations.push({ operationId, expectedBallId: request.expectedBallId, candidateSha: request.candidateSha,
    organId: request.organId, reservedAt: f.now() })
  await f.storage.put(LEDGER, ledger)
  assert.equal((await f.reserve(0)).code, 'ID_PROMOTION_AUTHORITY_INVALID')
})


test('missing or malformed lease identity cannot match corrupted durable lease fields', async () => {
  const f = await fixture()
  await f.storage.put('lease', { expiresAt: f.now() + 30000 })
  assert.equal((await f.reserve(0, { generation: undefined, ownerPeerId: undefined })).code, 'INVALID_WRITER_LEASE')
})


for (const route of ['store', 'http']) test(`reservation expiring during module staging rolls publication back (${route})`, async () => {
  const f = await fixture(), initial = await f.candidate()
  const candidateSha = initial.ball.entries['seed-echo'].specifier.slice(5)
  const reserved = await f.reserve(0, { candidateSha })
  assert.equal(reserved.ok, true)
  f.advance(WINDOW - 10); await f.acquire()
  const input = await f.candidate(), before = await f.storage.get(LEDGER)
  let crossed = false
  f.storage.onPut(key => {
    if (!crossed && key === `module:${candidateSha}:0`) { crossed = true; f.advance(11) }
  })
  if (route === 'store') {
    await assert.rejects(f.store.publish(input, { ownerSessionApproved: true, ownerSessionExpiresAt: f.now() + 60000 }),
      { code: 'ID_PROMOTION_RESERVATION_EXPIRED', status: 409 })
  } else {
    const owner = 'fixture@example.invalid', origin = 'https://budget.example.invalid'
    const object = new X61HeadDurableObject({ storage: f.storage, getWebSockets: () => [] },
      { PUBLIC_HOST: new URL(origin).host, OWNER_EMAIL: owner, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32) }, { now: f.now })
    const response = await object.fetch(new Request(origin + '/_head/ball', { method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin',
        'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': f.seed.seedId,
        'x-x6-verified-access': JSON.stringify({ type: 'owner', email: owner, expires: (f.now() + 60000) / 1000 }) },
      body: JSON.stringify(input) }))
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'ID_PROMOTION_RESERVATION_EXPIRED')
  }
  assert.equal(crossed, true, 'expiry advanced after the first check while staging candidate bytes')
  assert.equal((await f.store.read()).ball.ballId, f.ball.ballId)
  assert.deepEqual(await f.storage.get(LEDGER), before, 'the earlier reservation remains charged')
  assert.equal(await f.storage.get(`module:${candidateSha}:count`), undefined, 'staging transaction rolled back')
})


async function protectedCandidate(f, label = 'one') {
  const source = `module.exports={name:'seed-continuity',run(){return ${JSON.stringify(label)}}}`
  const sha = await digest(source), ball = structuredClone(f.ball)
  ball.parentBallId = f.ball.ballId; ball.epoch++
  ball.entries['seed-continuity'] = { id: 'seed-continuity', specifier: `ball:${sha}`, disabled: false,
    config: { governance: true }, previousSpecifiers: [] }
  ball.modules[sha] = { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(source) }
  ball.ballId = await manifestIdCanon(ball)
  return { ball, codeBySha: { [sha]: source }, expectedParentBallId: f.ball.ballId, expectedEpoch: f.ball.epoch,
    writerLease: (await f.store.inspectLease()).lease }
}
async function approvalFixture(approvalLifetime = 60000) {
  let f, approvedBinding, consumed = 0
  f = await fixture({ consumeGovernanceApproval: async (_tx, token, binding) => {
    if (token !== 'exact-approved' || canonicalJson(binding) !== canonicalJson(approvedBinding)) {
      throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
    }
    consumed++
    return { ok: true, binding, expiresAt: f.now() + approvalLifetime }
  } })
  const audience = 'https://budget.example.invalid'
  return { ...f, audience, consumed: () => consumed,
    approve: async input => { approvedBinding = await headPromotionBinding({ audience, ball: input.ball,
      entryId: 'seed-continuity', previous: f.ball }) } }
}

test('only actual exact-change Class3 approval initializes both absent keys atomically', async () => {
  const f = await approvalFixture(), input = await protectedCandidate(f)
  await f.storage.delete(MARKER); await f.storage.delete(LEDGER)
  const missing = await f.store.publish(input, { audience: f.audience, ownerSessionApproved: true, ownerSessionExpiresAt: f.now() + 60000 })
  assert.equal(missing.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(await f.storage.get(MARKER), undefined)
  await f.approve(input)
  await assert.rejects(f.store.publish(input, { audience: f.audience, approvalToken: 'forged' }), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  assert.equal(await f.storage.get(LEDGER), undefined)
  const wrongBytes = await protectedCandidate(f, 'different')
  await assert.rejects(f.store.publish(wrongBytes, { audience: f.audience, approvalToken: 'exact-approved' }), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  assert.equal(await f.storage.get(MARKER), undefined)
  assert.equal((await f.store.publish(input, { audience: f.audience, approvalToken: 'exact-approved' })).ok, true)
  assert.equal(f.consumed(), 1)
  assert.deepEqual((await f.storage.get(LEDGER)).reservations, [])
  assert.equal((await f.store.read()).ball.ballId, input.ball.ballId)
})

for (const damage of ['none', 'marker-missing', 'ledger-missing', 'malformed', 'marker-malformed']) test(`passkey initialization never resets present authority (${damage})`, async () => {
  const f = await approvalFixture(); await f.reserve(0)
  if (damage === 'marker-missing') await f.storage.delete(MARKER)
  if (damage === 'ledger-missing') await f.storage.delete(LEDGER)
  if (damage === 'malformed') await f.storage.put(LEDGER, { malformed: true })
  if (damage === 'marker-malformed') await f.storage.put(MARKER, { malformed: true })
  const before = await f.storage.get(LEDGER), markerBefore = await f.storage.get(MARKER), input = await protectedCandidate(f)
  await f.approve(input)
  assert.equal((await f.store.publish(input, { audience: f.audience, approvalToken: 'exact-approved' })).ok, true)
  assert.equal((await f.store.read()).ball.ballId, input.ball.ballId)
  assert.deepEqual(await f.storage.get(LEDGER), before)
  assert.deepEqual(await f.storage.get(MARKER), markerBefore)
  if (damage !== 'none') assert.equal((await f.reserve(1, { expectedBallId: input.ball.ballId })).code, 'ID_PROMOTION_AUTHORITY_INVALID')
})

test('an exhausted ordinary-id budget cannot charge or block an exact-change protected passkey publication', async () => {
  const f = await approvalFixture()
  for (let i = 0; i < 12; i++) assert.equal((await f.reserve(i)).ok, true)
  const before = await f.storage.get(LEDGER), input = await protectedCandidate(f)
  await f.approve(input)
  assert.equal((await f.store.publish(input, { audience: f.audience, approvalToken: 'exact-approved' })).ok, true)
  assert.deepEqual(await f.storage.get(LEDGER), before, 'protected publication adds no charge or timestamp change')
  assert.equal((await f.reserve(12, { expectedBallId: input.ball.ballId })).code, 'ID_PROMOTION_LIMIT_REACHED')
})

test('successful publication moves its original slot so delayed publications cannot bunch past twelve', async () => {
  const f = await fixture(), initial = await f.candidate(), candidateSha = initial.ball.entries['seed-echo'].specifier.slice(5)
  const reservation = await f.reserve(0, { candidateSha })
  for (let i = 1; i < 12; i++) await f.reserve(i)
  f.advance(WINDOW - 60000); await f.acquire()
  const input = await f.candidate(), publicationTime = f.now()
  assert.equal((await f.store.publish(input, { ownerSessionApproved: true, ownerSessionExpiresAt: f.now() + 60000 })).ok, true)
  const ledger = await f.storage.get(LEDGER), published = ledger.reservations.find(row => row.operationId === reservation.operationId)
  assert.equal(ledger.reservations.length, 12, 'publication adds no second charge')
  assert.equal(published.reservedAt, reservation.reservedAt); assert.equal(published.publishedAt, publicationTime)
  f.advance(60001); await f.acquire()
  for (let i = 20; i < 31; i++) {
    const result = await f.reserve(i, { expectedBallId: input.ball.ballId })
    assert.equal(result.ok, true); assert.equal(result.used, i - 18)
  }
  assert.equal((await f.reserve(31, { expectedBallId: input.ball.ballId })).code, 'ID_PROMOTION_LIMIT_REACHED')
  assert.equal((await f.storage.get(LEDGER)).reservations.length, 12, 'old failures age out but delayed publication remains charged')
})


test('an expired approval cannot leave initialization behind when Class3 selection rolls back', async () => {
  const f = await approvalFixture(-1), input = await protectedCandidate(f)
  await f.storage.delete(MARKER); await f.storage.delete(LEDGER); await f.approve(input)
  await assert.rejects(f.store.publish(input, { audience: f.audience, approvalToken: 'exact-approved' }), { code: 'CLASS3_TRANSITION_EXPIRED' })
  assert.equal(await f.storage.get(MARKER), undefined)
  assert.equal(await f.storage.get(LEDGER), undefined)
  assert.equal((await f.store.read()).ball.ballId, f.ball.ballId)
})

test('a failed publication keeps the original reservation timestamp and adds no published charge', async () => {
  const f = await fixture(), input = await f.candidate(), candidateSha = input.ball.entries['seed-echo'].specifier.slice(5)
  await f.reserve(0, { candidateSha })
  const before = await f.storage.get(LEDGER)
  f.storage.onPut(key => { if (key === 'head') throw Error('injected selection failure') })
  await assert.rejects(f.store.publish(input, { ownerSessionApproved: true, ownerSessionExpiresAt: f.now() + 60000 }), /injected selection failure/)
  assert.deepEqual(await f.storage.get(LEDGER), before)
  assert.equal((await f.store.read()).ball.ballId, f.ball.ballId)
})
