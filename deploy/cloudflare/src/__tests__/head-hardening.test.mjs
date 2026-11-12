/** Durable Head staging, cancellation, outcomes, and owner-gate regressions. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest, manifestIdCanon } from '../head-do.mjs'
import { proofOutcome, withProof } from '../proof-failure-rule.mjs'

/**
 * A stand-in store's refusal of a proof its VERIFIER judged wrong: the stand-in verifier answers `false` through
 * proof-failure-rule.mjs, so the refusal carries a branded wrong outcome by identity. A plain object with the same code and
 * status carries none, and HEAD's gate never counts it.
 */
const wrongProof = async () => withProof({ ok: false, code: 'AUMLOK_PROOF_INVALID', status: 403 },
  await proofOutcome(async () => false, { code: 'AUMLOK_PROOF_INVALID' }))

const ORIGIN = 'https://head.example.invalid'

// Transactions serialize and commit a private snapshot only on success.
function storageFixture() {
  let data = new Map(), tail = Promise.resolve()
  const view = map => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(data)[method](...args)]))
  storage.transaction = operation => {
    const result = tail.then(async () => {
      const copy = structuredClone(data)
      const result = await operation(view(copy))
      data = copy
      return result
    })
    tail = result.catch(() => {})
    return result
  }
  return storage
}

async function fixture() {
  const storage = storageFixture()
  const env = { PUBLIC_HOST: 'head.example.invalid', OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), OWNER_EMAIL: 'owner@example.invalid', AUMLOK_CUSTODY_PEPPER: '22'.repeat(32) }
  const create = () => new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  const head = create()
  const source = 'export const organ = "seed-echo";\n', sha = await digest(source)
  const draft = { version: 'x6.1-ball/v1', epoch: 167, parentBallId: null, createdAt: '2026-11-11T00:00:00.000Z', authorPeerId: 'fixture-peer',
    entries: { 'seed-echo': { id: 'seed-echo', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(source) } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }
  const payload = { version: BOOTSTRAP_VERSION, ball, codeBySha: { [sha]: source }, mirror: { entryCount: 0, batchDigests: [] } }
  const seedId = await digest(canonicalBootstrap(payload))
  assert.equal((await head.store.bootstrapPrepare({ ...payload, seedId })).ok, true)
  assert.equal((await head.store.bootstrapCommit(seedId, { ok: true, phase: 'ready', seedId, ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  const request = (path, body, extra = {}) => new Request(ORIGIN + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      'x-x6-verified-access': JSON.stringify({ type: 'owner', email: env.OWNER_EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const call = async (path, body, extra, object = head) => {
    const response = await object.fetch(request(path, body, extra))
    return { status: response.status, body: await response.json() }
  }
  const candidate = async label => {
    const code = `export const continuity = ${JSON.stringify(label)};\n`, hash = await digest(code)
    const next = { ...ball, epoch: 168, parentBallId: ball.ballId, createdAt: '2026-11-11T00:01:00.000Z',
      entries: { ...ball.entries, 'seed-continuity': { id: 'seed-continuity', specifier: `ball:${hash}`, disabled: false, config: { governance: true }, previousSpecifiers: [] } },
      modules: { ...ball.modules, [hash]: { sha256: hash, specifier: `ball:${hash}`, size: Buffer.byteLength(code) } } }
    delete next.ballId
    return { ball: { ...next, ballId: await manifestIdCanon(next) }, codeBySha: { [hash]: code }, expectedParentBallId: ball.ballId, expectedEpoch: 167 }
  }
  return { storage, head, create, call, request, candidate, ball }
}

test('stage preserves identical stagedAt and requires explicit replacement of a competing candidate', async () => {
  const fx = await fixture(), a = await fx.candidate('a'), b = await fx.candidate('b')
  const first = await fx.call('/_head/stage', a)
  assert.equal(first.status, 200)
  assert.equal((await fx.call('/_head/stage', a)).body.staged.stagedAt, first.body.staged.stagedAt)
  const competing = await fx.call('/_head/stage', b)
  assert.equal(competing.status, 409)
  assert.equal(competing.body.code, 'CANDIDATE_ALREADY_STAGED')
  assert.equal((await fx.call('/_head/stage', { ...b, replaceStaged: true })).status, 200)
  assert.equal((await fx.head.store.readStaged()).staged.ballId, b.ball.ballId)
})

test('publish refuses a superseded candidate before consuming owner approval', async () => {
  const fx = await fixture(), a = await fx.candidate('a'), b = await fx.candidate('b')
  await fx.call('/_head/stage', a)
  await fx.call('/_head/stage', { ...b, replaceStaged: true })
  let consumed = 0
  fx.head.aumlokStore = { consumeApprovalInTransaction: async () => { consumed++; return { ok: true, expiresAt: Date.now() + 60000 } } }
  const lease = await fx.head.store.lease({ action: 'acquire', ownerPeerId: a.ball.authorPeerId })
  const result = await fx.head.store.publish({ ...a, writerLease: lease.lease }, { approvalToken: 'test-approval', audience: ORIGIN, stagedBallId: a.ball.ballId })
  assert.equal(result.code, 'CANDIDATE_SUPERSEDED')
  assert.equal(consumed, 0)
  assert.equal((await fx.head.store.read()).head.ballId, fx.ball.ballId)
})

test('promotion rechecks the captured staged candidate after an intervening replacement', async () => {
  const fx = await fixture(), a = await fx.candidate('a'), b = await fx.candidate('b')
  await fx.call('/_head/stage', a)
  let consumed = 0
  fx.head.aumlokStore = { consumeApprovalInTransaction: async () => { consumed++; return { ok: true, expiresAt: Date.now() + 60000 } } }
  const read = fx.head.store.readStaged
  fx.head.store.readStaged = async () => {
    const captured = await read()
    assert.equal((await fx.head.store.stage({ ...b, replaceStaged: true }, { audience: ORIGIN })).ok, true)
    return captured
  }
  const result = await fx.call('/_head/promote', { ballId: a.ball.ballId }, { 'x-x6-class3-approval': 'test-approval' })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'CANDIDATE_SUPERSEDED')
  assert.equal(consumed, 0)
  assert.equal((await fx.head.store.read()).head.ballId, fx.ball.ballId)
})

test('early missing-approval publish outcome survives HeadDO recreation', async () => {
  const fx = await fixture(), a = await fx.candidate('a')
  const response = await fx.call('/_head/promote', { ballId: a.ball.ballId })
  assert.equal(response.status, 403)
  const recreated = fx.create()
  const status = await fx.call('/_head/promotion-status', undefined, undefined, recreated)
  assert.equal(status.body.lastPublishOutcome.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(status.body.lastPublishOutcome.candidateBallId, a.ball.ballId)
  assert.equal(status.body.lastPublishOutcome.hasApprovalToken, false)
})

async function journal(fx, turnId) {
  const result = await fx.call('/_head/turn-journal', { turnId, provider: 'personaplex-voice', endpoint: '/_host/voice/dispatch', requestSha256: 'a'.repeat(64), utteranceSha256: 'b'.repeat(64), utterancePreview: 'Hello', utteranceBytes: 5, modality: 'voice' })
  assert.equal(result.status, 200)
  return result.body.entry
}

test('cancelled journal tombstone fences call_dispatch after row eviction and active replacement', async () => {
  const fx = await fixture(), row = await journal(fx, 'cancelled-turn')
  assert.equal((await fx.call('/_head/turn-journal', { action: 'cancel', turnId: 'cancelled-turn' })).status, 200)
  await fx.storage.delete(`head:turn-journal:row:${row.seq}`)
  assert.equal((await fx.call('/_head/transcript', { action: 'turn_start', turn_id: 'replacement-turn', tab_id: 'tab' })).status, 200)
  const result = await fx.call('/_head/transcript', { action: 'call_dispatch', turn_id: 'cancelled-turn', call_id: 'late-call' })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'TURN_ALREADY_CANCELLED')
  assert.equal(await fx.storage.get('head:call:late-call'), undefined)
})

test('turn_complete cannot overwrite an abandoned turn and abandonment survives active replacement', async () => {
  const fx = await fixture()
  await journal(fx, 'abandoned-turn')
  await fx.call('/_head/transcript', { action: 'turn_start', turn_id: 'abandoned-turn', tab_id: 'tab' })
  assert.equal((await fx.call('/_head/transcript', { action: 'turn_abandon', turn_id: 'abandoned-turn' })).status, 200)
  const complete = await fx.call('/_head/transcript', { action: 'turn_complete', turn_id: 'abandoned-turn' })
  assert.equal(complete.status, 409)
  assert.equal(complete.body.code, 'TURN_ALREADY_CANCELLED')
  await fx.call('/_head/transcript', { action: 'turn_start', turn_id: 'next-turn', tab_id: 'tab' })
  const dispatch = await fx.call('/_head/transcript', { action: 'call_dispatch', turn_id: 'abandoned-turn', call_id: 'abandoned-call' })
  assert.equal(dispatch.status, 409)
  assert.equal(dispatch.body.code, 'TURN_ALREADY_CANCELLED')
})

for (const action of ['approve', 'bind']) {
  test(`AUMLOK ${action} persists five-failure lockout across HeadDO recreation`, async () => {
    const fx = await fixture()
    let attempted = 0
    // Job 6, the one rule (proof-failure-rule.mjs): only a proof checked and found wrong moves the gate. A refusal that is
    // not one (here an unlisted code) is answered as it is, ten times, and the gate is never written. Job 9: neither is a
    // refusal that only LOOKS like one (the listed code and status, no verifier behind it).
    fx.head.aumlokStore = { complete: async () => ({ ok: false, code: 'AUMLOK_TEST_REFUSED', status: 403 }) }
    for (let i = 0; i < 10; i++) assert.equal((await fx.call(`/_host/aumlok/${action}`, {})).status, 403)
    fx.head.aumlokStore = { complete: async () => ({ ok: false, code: 'AUMLOK_PROOF_INVALID', status: 403 }) }
    for (let i = 0; i < 10; i++) assert.equal((await fx.call(`/_host/aumlok/${action}`, {})).status, 403)
    assert.equal(await fx.storage.get('gate-lockout:v1'), undefined)
    const fake = { complete: async () => { attempted++; return wrongProof() } }
    fx.head.aumlokStore = fake
    for (let i = 0; i < 5; i++) assert.equal((await fx.call(`/_host/aumlok/${action}`, {})).status, i === 4 ? 429 : 403)
    const restarted = fx.create(); restarted.aumlokStore = fake
    assert.equal((await fx.call(`/_host/aumlok/${action}`, {}, undefined, restarted)).status, 429)
    assert.equal(attempted, 5)
  })
}

test('promotion lockout covers direct publication with an approval token', async () => {
  const fx = await fixture()
  // Job 6, the one rule: a promotion without a valid approval (an unknown, used or expired bearer) is refused, never a
  // failed passkey: ten refusals leave the gate unwritten.
  for (let i = 0; i < 10; i++) assert.equal((await fx.call('/_head/promote', {})).status, 403)
  assert.equal(await fx.storage.get('gate-lockout:v1'), undefined)
  // A lock that IS active on the promotion subject still covers both staged and direct publication.
  const subject = `head-gate:${await digest('/_head/promote\0' + 'owner@example.invalid')}`
  for (let i = 0; i < 5; i++) await fx.head.gateLockout.recordFailure(subject)
  assert.equal((await fx.call('/_head/promote', {})).body.code, 'GATE_LOCKOUT_ACTIVE')
  const result = await fx.call('/_head/ball', await fx.candidate('blocked'), { 'x-x6-class3-approval': 'token' })
  assert.equal(result.status, 429)
  assert.equal(result.body.code, 'GATE_LOCKOUT_ACTIVE')
})

test('successful gate attempt resets failures and concurrent attempts cannot falsely refuse committed success', async () => {
  const fx = await fixture()
  let entered, release
  const enteredPromise = new Promise(resolve => { entered = resolve })
  const hold = new Promise(resolve => { release = resolve })
  let count = 0
  fx.head.aumlokStore = { complete: async (_action, body) => {
    count++
    if (body.success) { entered(); await hold; return { ok: true } }
    // A wrong proof (the one rule: only such a refusal moves the gate).
    return wrongProof()
  } }
  for (let i = 0; i < 4; i++) assert.equal((await fx.call('/_host/aumlok/approve', {})).status, 403)
  const success = fx.call('/_host/aumlok/approve', { success: true })
  await enteredPromise
  const failures = Array.from({ length: 5 }, () => fx.call('/_host/aumlok/approve', {}))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(count, 5, 'concurrent checks must wait for the owning gate action')
  release()
  assert.equal((await success).status, 200)
  assert.deepEqual((await Promise.all(failures)).map(result => result.status), [403, 403, 403, 403, 429])
})

test('turn_start cannot resurrect a durably cancelled turn ID', async () => {
  const fx = await fixture()
  await journal(fx, 'cancelled-start')
  await fx.call('/_head/turn-journal', { action: 'cancel', turnId: 'cancelled-start' })
  const restarted = await fx.call('/_head/transcript', { action: 'turn_start', turn_id: 'cancelled-start', tab_id: 'tab' })
  assert.equal(restarted.status, 409)
  assert.equal(restarted.body.code, 'TURN_ALREADY_CANCELLED')
  assert.notEqual((await fx.storage.get('head:turn:active'))?.status, 'running')
})

test('successful promotion outcome survives recreation with committed candidate identity', async () => {
  const fx = await fixture(), candidate = await fx.candidate('promoted')
  await fx.call('/_head/stage', candidate)
  fx.head.aumlokStore = { consumeApprovalInTransaction: async (tx, token) => {
    assert.equal(token, 'approved-token')
    await tx.put('test:consumed-approval', token)
    return { ok: true, expiresAt: Date.now() + 60000 }
  } }
  const result = await fx.call('/_head/promote', { ballId: candidate.ball.ballId }, { 'x-x6-class3-approval': 'approved-token' })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(await fx.storage.get('test:consumed-approval'), 'approved-token')
  const status = await fx.call('/_head/promotion-status', undefined, undefined, fx.create())
  assert.equal(status.body.lastPublishOutcome.ok, true)
  assert.equal(status.body.lastPublishOutcome.resultingBallId, candidate.ball.ballId)
  assert.equal(status.body.lastPublishOutcome.hasApprovalToken, true)
  assert.equal(status.body.staged, null)
})

test('expired approval rolls back both consumption and HEAD selection', async () => {
  const fx = await fixture(), candidate = await fx.candidate('expires')
  await fx.call('/_head/stage', candidate)
  fx.head.aumlokStore = { consumeApprovalInTransaction: async tx => {
    await tx.put('test:consumed-approval', 'expired-token')
    return { ok: true, expiresAt: Date.now() - 1 }
  } }
  const result = await fx.call('/_head/promote', { ballId: candidate.ball.ballId }, { 'x-x6-class3-approval': 'expired-token' })
  assert.equal(result.status, 409, JSON.stringify(result.body))
  assert.equal(result.body.code, 'CLASS3_TRANSITION_EXPIRED')
  assert.equal(await fx.storage.get('test:consumed-approval'), undefined)
  assert.equal((await fx.head.store.read()).head.ballId, fx.ball.ballId)
})

test('late completion cannot revive abandoned calls or replay them into another turn', async () => {
  const fx = await fixture()
  const transcript = input => fx.call('/_head/transcript', input)
  await transcript({ action: 'turn_start', turn_id: 'A', tab_id: 'tab' })
  assert.equal((await transcript({ action: 'call_dispatch', turn_id: 'A', call_id: 'callA', tool: 'consult', args_sha256: 'a'.repeat(64) })).status, 200)
  await transcript({ action: 'turn_abandon', turn_id: 'A' })
  await transcript({ action: 'turn_start', turn_id: 'B', tab_id: 'tab' })
  assert.equal((await transcript({ action: 'call_complete', turn_id: 'A', call_id: 'callA', result: 'late A' })).status, 409)
  assert.equal((await transcript({ action: 'call_dispatch', turn_id: 'B', call_id: 'callA', tool: 'consult', args_sha256: 'a'.repeat(64) })).status, 409)
  assert.equal((await fx.storage.get('head:call:callA')).status, 'dispatched')
})

test('call completion requires dispatch and exact owner while replay binds tool and arguments', async () => {
  const fx = await fixture(), transcript = input => fx.call('/_head/transcript', input)
  await transcript({ action: 'turn_start', turn_id: 'A', tab_id: 'tab' })
  assert.equal((await transcript({ action: 'call_complete', turn_id: 'A', call_id: 'missing', result: 'invented' })).status, 409)
  assert.equal(await fx.storage.get('head:call:missing'), undefined)
  const dispatch = { action: 'call_dispatch', turn_id: 'A', call_id: 'callA', tool: 'consult', args_sha256: 'a'.repeat(64) }
  await transcript(dispatch)
  assert.equal((await transcript({ action: 'call_complete', turn_id: 'B', call_id: 'callA', result: 'wrong owner' })).status, 409)
  assert.equal((await transcript({ action: 'call_complete', turn_id: 'A', call_id: 'callA', result: 'correct', result_digest: 'b'.repeat(64) })).status, 200)
  assert.equal((await transcript(dispatch)).body.replayed, true)
  assert.equal((await transcript({ ...dispatch, tool: 'other' })).status, 409)
  assert.equal((await transcript({ ...dispatch, args_sha256: 'c'.repeat(64) })).status, 409)
  assert.equal((await transcript({ action: 'call_complete', turn_id: 'A', call_id: 'callA', result: 'replacement' })).status, 409)
  assert.equal((await fx.storage.get('head:call:callA')).result, 'correct')
})


test('metadata writes are rejected before publication or gate storage access', async () => {
  const fx = await fixture()
  let transactions = 0
  fx.storage.transaction = async () => { transactions++; throw new Error('metadata cannot write') }
  for (const route of ['/_head/ball?meta=1', '/_head/ball?meta=0', '/_head/ball?meta=1&extra=1']) {
    const result = await fx.call(route, {}, { 'x-x6-class3-approval': 'irrelevant' })
    assert.equal(result.status, 405)
  }
  assert.equal(transactions, 0)
})

for (const route of ['/_head/promote', '/_head/ball']) {
  test(`${route} commits outcome before broadcast and failures/retries preserve its owner receipt`, async () => {
    const fx = await fixture(), candidate = await fx.candidate('outcome')
    await fx.call('/_head/stage', candidate)
    let consumed = 0, broadcasts = 0
    fx.head.aumlokStore = { consumeApprovalInTransaction: async () => {
      consumed++; return { ok: true, expiresAt: Date.now() + 60000 }
    } }
    fx.head.broadcast = async event => {
      if (event.type !== 'ball:commit') return
      broadcasts++
      const durable = await fx.storage.get('head:last-publish-outcome')
      assert.equal(durable.ok, true)
      assert.equal(durable.resultingBallId, event.ball.ballId)
      assert.equal(durable.hasApprovalToken, true)
      assert.deepEqual(fx.head.lastPublishOutcome, durable)
      const read = await fx.call('/_head/promotion-status', undefined, undefined, fx.create())
      assert.deepEqual(read.body.lastPublishOutcome, durable)
    }
    const lease = route === '/_head/ball'
      ? (await fx.head.store.lease({ action: 'acquire', ownerPeerId: candidate.ball.authorPeerId })).lease : null
    const body = lease ? { ...candidate, writerLease: lease } : { ballId: candidate.ball.ballId }
    const published = await fx.call(route, body, { 'x-x6-class3-approval': 'approved-token' })
    assert.equal(published.status, 200, JSON.stringify(published.body))
    assert.equal(broadcasts, 1)
    const committed = await fx.storage.get('head:last-publish-outcome')
    const status = await fx.call('/_head/promotion-status')
    assert.equal(status.body.staged, null)
    assert.equal(status.body.supersededStaged.state, 'published')
    const retry = await fx.call('/_head/promote', { ballId: candidate.ball.ballId }, { 'x-x6-class3-approval': 'used-token' })
    assert.equal(retry.status, 409)
    assert.equal(retry.body.code, 'ALREADY_PUBLISHED')
    assert.equal(retry.body.supersededStaged.ballId, candidate.ball.ballId)
    assert.equal((await fx.call('/_head/promote', { ballId: candidate.ball.ballId })).status, 403)
    assert.equal((await fx.call('/_head/ball', {})).status, 400)
    const replay = await fx.call('/_head/ball', candidate)
    assert.equal(replay.body.idempotent, true)
    assert.deepEqual(await fx.storage.get('head:last-publish-outcome'), committed)
    assert.equal(consumed, 1)
    assert.equal(broadcasts, 1)
  })
}

test('publication outcome storage failure rolls back HEAD and approval before broadcast', async () => {
  const fx = await fixture(), candidate = await fx.candidate('rollback-outcome')
  await fx.call('/_head/stage', candidate)
  fx.head.aumlokStore = { consumeApprovalInTransaction: async tx => {
    await tx.put('test:approval', true); return { ok: true, expiresAt: Date.now() + 60000 }
  } }
  let broadcasts = 0
  fx.head.broadcast = async () => { broadcasts++ }
  const transaction = fx.storage.transaction
  fx.storage.transaction = operation => transaction(tx => operation({ ...tx, put: async (key, value) => {
    if (key === 'head:last-publish-outcome' && value.ok === true) throw new Error('synthetic outcome storage failure')
    return tx.put(key, value)
  } }))
  assert.equal((await fx.call('/_head/promote', { ballId: candidate.ball.ballId }, { 'x-x6-class3-approval': 'token' })).status, 503)
  assert.equal((await fx.head.store.read()).head.ballId, fx.ball.ballId)
  assert.equal(await fx.storage.get('test:approval'), undefined)
  assert.equal(broadcasts, 0)
})

test('generated lifecycle IDs are random and completed IDs remain terminal after replacement', async () => {
  const fx = await fixture(), transcript = input => fx.call('/_head/transcript', input)
  const first = await transcript({ action: 'turn_start', tab_id: 'tab' })
  assert.match(first.body.turn.turn_id, /^turn-[a-f0-9-]{36}$/)
  await transcript({ action: 'turn_complete', turn_id: first.body.turn.turn_id })
  assert.equal((await transcript({ action: 'turn_abandon', turn_id: first.body.turn.turn_id })).status, 409)
  assert.equal((await fx.storage.get('head:turn:active')).status, 'completed')
  const second = await transcript({ action: 'turn_start', tab_id: 'tab' })
  assert.notEqual(first.body.turn.turn_id, second.body.turn.turn_id)
  assert.equal((await transcript({ action: 'turn_start', turn_id: first.body.turn.turn_id, tab_id: 'tab' })).status, 409)
  assert.equal((await transcript({ action: 'call_dispatch', turn_id: first.body.turn.turn_id, call_id: 'late' })).status, 409)
  assert.equal((await fx.storage.get(`head:turn-journal:turn:${first.body.turn.turn_id}`)).completed, true)
})


test('chat parent turns settle durably and completed leases cannot be reused', async t => {
  const fx = await fixture()
  t.after(() => fx.head.wakeStore.dispose())
  const turnId = 'chat-11111111-2222-4333-8444-555555555555', tabId = 'synthetic-chat-tab'
  const start = await fx.call('/_head/transcript', { action: 'turn_start', turn_id: turnId, tab_id: tabId })
  assert.equal(start.status, 200)
  assert.equal(start.body.turn.turn_id, turnId)
  const settle = { action: 'turn_complete', turn_id: turnId, tab_id: tabId, leaseToken: start.body.leaseToken }
  const mismatch = await fx.call('/_head/transcript', { ...settle, leaseToken: 'wrong-lease' })
  assert.equal(mismatch.status, 409)
  assert.equal(mismatch.body.code, 'TURN_LEASE_MISMATCH')
  const completed = await fx.call('/_head/transcript', settle)
  assert.equal(completed.status, 200)
  assert.equal(completed.body.turn.status, 'completed')
  assert.equal(completed.body.turn.outcome, 'ok')
  assert.equal((await fx.storage.get(`head:turn-journal:turn:${turnId}`)).completed, true)
  const recreated = fx.create()
  t.after(() => recreated.wakeStore.dispose())
  const replay = await fx.call('/_head/transcript', { action: 'turn_start', turn_id: turnId, tab_id: tabId }, undefined, recreated)
  assert.equal(replay.status, 409)
  assert.equal(replay.body.code, 'TURN_ALREADY_COMPLETED')
  const late = await fx.call('/_head/transcript', { action: 'call_dispatch', turn_id: turnId, call_id: 'late-chat-call', tab_id: tabId, leaseToken: start.body.leaseToken })
  assert.equal(late.status, 409)
  assert.equal(await fx.storage.get('head:call:late-chat-call'), undefined)
})

test('both edge status aliases expose the cloudflare runtime', async t => {
  const fx = await fixture()
  t.after(() => fx.head.wakeStore.dispose())
  for (const path of ['/__x6/status', '/api/x61/status']) {
    const result = await fx.call(path)
    assert.equal(result.status, 200)
    assert.equal(result.body.runtime, 'cloudflare')
  }
})
