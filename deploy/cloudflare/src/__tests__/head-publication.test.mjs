/** Offline publication atomicity, postcommit faults, and durable owner speech reservations. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { createWorker } from '../worker.mjs'
import { HYBRID_ENVELOPE_SCHEMA } from '../owner-grant-policy.mjs'
import { proofOutcome, withProof } from '../proof-failure-rule.mjs'

/**
 * A stand-in store's refusal of a proof its VERIFIER judged wrong: the stand-in verifier answers `false` through
 * proof-failure-rule.mjs, so the refusal carries a branded wrong outcome by identity. A plain object with the same code and
 * status carries none, and HEAD's gate never counts it.
 */
const wrongProof = async () => withProof({ ok: false, code: 'AUMLOK_PROOF_INVALID', status: 403 },
  await proofOutcome(async () => false, { code: 'AUMLOK_PROOF_INVALID' }))

const ORIGIN = 'https://head-wave4.example.invalid'
const OWNER = 'owner@example.invalid'
const BUDGET = '/_head/speech-pass-budget'
const approvalHeaders = { 'x-x6-class3-approval': 'fixture-approval' }

function storageFixture() {
  let data = new Map(), tail = Promise.resolve(), fault = () => {}
  const view = (map, transactional = false) => ({
    get: async key => { if (transactional) fault('get', key); return structuredClone(map.get(key)) },
    put: async (key, value) => { map.set(key, structuredClone(value)); if (transactional) fault('put', key, value) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(data)[method](...args)]))
  storage.snapshot = () => structuredClone(data)
  storage.inject = callback => { fault = callback }
  storage.transaction = operation => {
    const result = tail.then(async () => {
      const copy = structuredClone(data)
      const value = await operation(view(copy, true))
      data = copy
      return value
    })
    tail = result.catch(() => undefined)
    return result
  }
  return storage
}

async function fixture() {
  const storage = storageFixture()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32) }
  const create = (overrides = {}) => new X61HeadDurableObject({ storage, getWebSockets: () => [] }, { ...env, ...overrides }, {
    networkFetch: async () => { throw new Error('External network forbidden') },
  })
  const head = create(), code = 'export const organ = "echo";', sha = await digest(code)
  const ball = { version: 'x6.1-ball/v1', epoch: 167, parentBallId: null, authorPeerId: 'fixture-writer',
    entries: { 'seed-echo': { id: 'seed-echo', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  ball.ballId = await manifestIdCanon(ball)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } })
  assert.equal((await head.store.bootstrapPrepare(seed)).ok, true)
  assert.equal((await head.store.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId,
    ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  const request = (path, body, extra = {}) => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seed.seedId,
      'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: Date.now() / 1000 + 3600 }) })
    for (const [key, value] of Object.entries(extra)) { if (value === null) headers.delete(key); else headers.set(key, value) }
    return new Request(ORIGIN + path, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  const call = async (path, body, headers, object = head) => {
    const response = await object.fetch(request(path, body, headers))
    return { status: response.status, body: await response.json() }
  }
  const candidate = async () => {
    const code = 'export const continuity = true;', sha = await digest(code)
    const next = { ...structuredClone(ball), epoch: 168, parentBallId: ball.ballId }
    next.entries['seed-continuity'] = { id: 'seed-continuity', specifier: `ball:${sha}`, disabled: false, config: { governance: true }, previousSpecifiers: [] }
    next.modules[sha] = { sha256: sha, specifier: `ball:${sha}` }
    next.ballId = await manifestIdCanon(next)
    return { ball: next, codeBySha: { [sha]: code }, expectedParentBallId: ball.ballId, expectedEpoch: 167 }
  }
  const prepare = async (route = '/_head/ball') => {
    const input = await candidate()
    if (route === '/_head/promote') {
      assert.equal((await call('/_head/stage', input)).status, 200)
      return { input, body: { ballId: input.ball.ballId } }
    }
    input.writerLease = (await head.store.lease({ action: 'acquire', ownerPeerId: input.ball.authorPeerId })).lease
    return { input, body: input }
  }
  const approve = (expiresAt = Date.now() + 60000) => {
    head.aumlokStore = { consumeApprovalInTransaction: async tx => {
      await tx.put('fixture:approval-consumed', true)
      return { ok: true, expiresAt }
    } }
  }
  const refuse = () => {
    head.aumlokStore = { consumeApprovalInTransaction: async () => {
      throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
    } }
  }
  return { storage, head, create, request, call, candidate, prepare, approve, refuse, ball, seed, env }
}

for (const priorPromotion of [false, true]) {
  test(`direct approval refusal preserves all durable state with prior promotion history ${priorPromotion}`, async () => {
    const fx = await fixture(), { body } = await fx.prepare()
    fx.refuse()
    if (priorPromotion) assert.equal((await fx.call('/_head/promote', {})).status, 403)
    const before = fx.storage.snapshot()
    for (let i = 0; i < 2; i++) {
      const refused = await fx.call('/_head/ball', body, approvalHeaders)
      assert.equal(refused.status, 403)
      assert.equal(refused.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
      assert.deepEqual(fx.storage.snapshot(), before)
    }
  })
}

test('direct and staged refusals that are no proof never move the gate; wrong proofs on both share the durable fifth-attempt lock across recreation', async () => {
  const fx = await fixture(), { body } = await fx.prepare()
  fx.refuse()
  // An approval bearer that is unknown, used or expired is refused by policy, never a failed passkey: ten direct ones leave
  // every byte as it was; ten staged ones write only their own attempt diagnostics, never the gate.
  const before = fx.storage.snapshot()
  for (let i = 0; i < 10; i++) assert.equal((await fx.call('/_head/ball', body, approvalHeaders)).status, 403)
  assert.deepEqual(fx.storage.snapshot(), before)
  for (let i = 0; i < 10; i++) assert.equal((await fx.call('/_head/promote', {})).status, 403)
  assert.equal(await fx.storage.get('gate-lockout:v1'), undefined)
  // The mixed sequence this test always had (job 7 review: restored, step for step), now driven by proofs checked and
  // wrong: the owner's signature on the signed action, well formed, naming HEAD's configured keys, and wrong. Two direct
  // publications and one staged promotion fail; a fourth direct failure is held as before (no durable write); the fifth
  // attempt is locked out.
  const mlDsaPublicKeyHex = randomBytes(1952).toString('hex')
  const signing = fx.create({ OWNER_MLDSA_PUBLIC_KEY_HEX: mlDsaPublicKeyHex })
  const signed = { ...approvalHeaders, 'x-x6-signed-action': JSON.stringify(wronglySignedAction(fx.env.OWNER_PUBLIC_KEY_HEX, mlDsaPublicKeyHex)) }
  const wrong = async (path, payload) => {
    const refused = await fx.call(path, payload, signed, signing)
    assert.deepEqual([refused.status, refused.body.code], [403, 'HYBRID_SIGNATURE_INVALID'], path)
  }
  for (let i = 0; i < 2; i++) await wrong('/_head/ball', body)
  await wrong('/_head/promote', {})
  const held = fx.storage.snapshot()
  await wrong('/_head/ball', body)
  assert.deepEqual(fx.storage.snapshot(), held)
  const fifth = await fx.call('/_head/ball', body, signed, signing)
  assert.deepEqual([fifth.status, fifth.body.code], [429, 'GATE_LOCKOUT_ACTIVE'])
  // The lock is durable and covers both routes on a recreated HEAD.
  const recreated = fx.create()
  for (const path of ['/_head/ball', '/_head/promote']) {
    const result = await fx.call(path, body, approvalHeaders, recreated)
    assert.equal(result.status, 429)
    assert.equal(result.body.code, 'GATE_LOCKOUT_ACTIVE')
  }
})

/** A signed action whose envelope is well formed and names HEAD's configured owner keys, but whose signatures are wrong. */
function wronglySignedAction(ed25519PublicKeyHex, mlDsaPublicKeyHex) {
  const keyId = hex => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 12)
  return { schema: HYBRID_ENVELOPE_SCHEMA, artifact: 'signed-action', payload: { action: 'head.publish' },
    algManifest: { classical: { alg: 'Ed25519', keyId: keyId(ed25519PublicKeyHex) }, pq: { alg: 'ML-DSA-65', keyId: keyId(mlDsaPublicKeyHex) } },
    signatures: { ed25519SigHex: '0'.repeat(128), mlDsaSigHex: '0'.repeat(6618) } }
}

test('a rolled-back threshold write does not advance the transient failure history', async () => {
  // Job 6, the one rule: on direct publication the gate counts only a proof checked and wrong, here the owner's signature on
  // the signed action, checked against HEAD's configured keys and wrong (HYBRID_SIGNATURE_INVALID). The test is otherwise
  // the one it always was: four failures, a threshold write that fails, then the fifth.
  const fx = await fixture(), { body } = await fx.prepare()
  const mlDsaPublicKeyHex = randomBytes(1952).toString('hex')
  const head = fx.create({ OWNER_MLDSA_PUBLIC_KEY_HEX: mlDsaPublicKeyHex })
  const headers = { ...approvalHeaders, 'x-x6-signed-action': JSON.stringify(wronglySignedAction(fx.env.OWNER_PUBLIC_KEY_HEX, mlDsaPublicKeyHex)) }
  for (let i = 0; i < 4; i++) {
    const refused = await fx.call('/_head/ball', body, headers, head)
    assert.deepEqual([refused.status, refused.body.code], [403, 'HYBRID_SIGNATURE_INVALID'])
  }
  const before = fx.storage.snapshot()
  fx.storage.inject((operation, key) => { if (operation === 'put' && key === 'gate-lockout:v1') throw new Error('Gate write unavailable') })
  assert.equal((await fx.call('/_head/ball', body, headers, head)).status, 503)
  assert.deepEqual(fx.storage.snapshot(), before)
  fx.storage.inject(() => {})
  assert.equal((await fx.call('/_head/ball', body, headers, head)).status, 429)
  const entries = await fx.storage.get('gate-lockout:v1')
  assert.equal(entries[0][1].failedAt.length, 5)
})

test('a rolled-back failure write on the approval gate does not advance its failure history', async () => {
  // The same rollback on the gate whose failures are durable: four wrong proofs on approve, a failure write that fails
  // (503, nothing written), then the fifth locks with exactly five failures.
  const fx = await fixture()
  fx.head.aumlokStore = { complete: async () => wrongProof() }
  const browser = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }
  const approve = () => fx.call('/_host/aumlok/approve', {}, browser)
  for (let i = 0; i < 4; i++) {
    const refused = await approve()
    assert.deepEqual([refused.status, refused.body.code], [403, 'AUMLOK_PROOF_INVALID'])
  }
  const before = fx.storage.snapshot()
  fx.storage.inject((operation, key) => { if (operation === 'put' && key === 'gate-lockout:v1') throw new Error('Gate write unavailable') })
  assert.equal((await approve()).status, 503)
  assert.deepEqual(fx.storage.snapshot(), before)
  fx.storage.inject(() => {})
  const fifth = await approve()
  assert.deepEqual([fifth.status, fifth.body.code], [429, 'GATE_LOCKOUT_ACTIVE'])
  const entries = await fx.storage.get('gate-lockout:v1')
  assert.equal(entries[0][1].failedAt.length, 5)
})

test('a refusal that does not count never writes the gate: with every gate write failing, direct refusals keep their own answer', async () => {
  const fx = await fixture(), { body } = await fx.prepare()
  fx.refuse()
  const before = fx.storage.snapshot()
  fx.storage.inject((operation, key) => { if (operation === 'put' && key === 'gate-lockout:v1') throw new Error('Gate write unavailable') })
  for (let i = 0; i < 10; i++) {
    const refused = await fx.call('/_head/ball', body, approvalHeaders)
    assert.deepEqual([refused.status, refused.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'])
  }
  fx.storage.inject(() => {})
  assert.deepEqual(fx.storage.snapshot(), before)
})

for (const failure of ['outcome-write', 'final-expiry']) {
  test(`direct ${failure} rollback preserves approval, HEAD, diagnostics and gate state`, async t => {
    let now = 1800000000000
    t.mock.method(Date, 'now', () => now)
    t.mock.method(console, 'error', () => {})
    const fx = await fixture(), { body } = await fx.prepare(), expiresAt = now + 1000
    fx.approve(expiresAt)
    const before = fx.storage.snapshot()
    let broadcasts = 0, spent = false
    fx.head.broadcast = async () => { broadcasts++ }
    fx.storage.inject((operation, key) => {
      if (operation !== 'put') return
      if (key === 'fixture:approval-consumed') spent = true
      if (key === 'head:last-publish-outcome') {
        if (failure === 'outcome-write') throw new Error('Receipt write unavailable')
        now = expiresAt
      }
    })
    const response = await fx.call('/_head/ball', body, approvalHeaders)
    assert.equal(response.status, failure === 'outcome-write' ? 503 : 409)
    assert.equal(spent, true)
    assert.equal(broadcasts, 0)
    assert.deepEqual(fx.storage.snapshot(), before)
  })
}

for (const route of ['/_head/ball', '/_head/promote']) {
  for (const fault of ['gate-reset', 'postcommit-read', 'response-diagnostics', 'broadcast']) {
    test(`${route} preserves its committed receipt through ${fault} failure`, async t => {
      const warnings = []
      t.mock.method(console, 'warn', message => warnings.push(message))
      const fx = await fixture(), { input, body } = await fx.prepare(route)
      fx.approve()
      let broadcasts = 0, postcommitReads = 0
      fx.head.broadcast = async event => {
        broadcasts++
        assert.equal(event.ball.ballId, input.ball.ballId)
        assert.deepEqual(fx.head.lastPublishOutcome, await fx.storage.get('head:last-publish-outcome'))
        if (fault === 'broadcast') throw new Error('Notification unavailable')
      }
      if (fault === 'gate-reset') {
        const property = route === '/_head/ball' ? 'directPublishGateLockout' : 'gateLockout'
        fx.head[property] = { ...fx.head[property], recordSuccess: async () => { throw new Error('Gate reset unavailable') } }
      }
      if (fault === 'postcommit-read') {
        fx.head.store.read = async () => { postcommitReads++; throw new Error('Snapshot read unavailable') }
        fx.storage.inject((operation, key) => {
          if (operation === 'get' && key === 'head:last-publish-outcome' && fx.storage.snapshot().get('head') === input.ball.ballId) {
            postcommitReads++
            throw new Error('Diagnostic read unavailable')
          }
        })
      }
      if (fault === 'response-diagnostics') fx.head.diagnostics = { observe: async (_request, operation) => { await operation(); throw new Error('Observer unavailable') } }
      const result = await fx.call(route, body, approvalHeaders)
      assert.equal(result.status, 200, JSON.stringify(result.body))
      assert.equal(result.body.ballId, input.ball.ballId)
      assert.equal(await fx.storage.get('head'), input.ball.ballId)
      assert.equal(await fx.storage.get('fixture:approval-consumed'), true)
      assert.equal((await fx.storage.get('head:last-publish-outcome')).ok, true)
      assert.equal(broadcasts, 1)
      assert.equal(postcommitReads, 0)
      if (fault !== 'postcommit-read') assert.equal(warnings.length, 1)
    })
  }
}

test('failure-attempt diagnostic errors preserve the refused publication response', async t => {
  t.mock.method(console, 'warn', () => {})
  const fx = await fixture()
  fx.storage.inject((operation, key) => { if (operation === 'put' && key === 'head:last-publish-attempt') throw new Error('Diagnostic write unavailable') })
  const result = await fx.call('/_head/promote', {})
  assert.equal(result.status, 403)
  assert.equal(result.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(await fx.storage.get('head'), fx.ball.ballId)
  assert.equal(await fx.storage.get('head:last-publish-outcome'), undefined)
})

test('six speech reservations persist across recreation and the seventh is read-only', async t => {
  t.mock.method(Date, 'now', () => 1800000000000)
  const fx = await fixture()
  for (let i = 0; i < 6; i++) {
    const result = await fx.call(BUDGET, {}, undefined, i < 3 ? fx.head : fx.create())
    assert.deepEqual(result, { status: 200, body: { ok: true, remaining: 5 - i } })
  }
  const before = fx.storage.snapshot(), limited = await fx.call(BUDGET, {}, undefined, fx.create())
  assert.equal(limited.status, 429)
  assert.equal(limited.body.code, 'SPEECH_PASS_RATE_LIMITED')
  assert.equal(limited.body.retryAfterMs, 60000)
  assert.deepEqual(fx.storage.snapshot(), before)
  assert.equal(before.has('gate-lockout:v1'), false)
  assert.equal(before.has('head:last-publish-outcome'), false)
})

test('concurrent speech reservations across object instances cannot exceed six', async () => {
  const fx = await fixture(), recreated = fx.create()
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => fx.call(BUDGET, {}, undefined, i % 2 ? recreated : fx.head)))
  assert.equal(results.filter(result => result.status === 200).length, 6)
  assert.equal(results.filter(result => result.status === 429).length, 14)
  assert.deepEqual(results.filter(result => result.status === 200).map(result => result.body.remaining).sort(), [0, 1, 2, 3, 4, 5])
})

test('speech reservations expire individually at the rolling-minute boundary', async t => {
  let now = 1800000000000
  t.mock.method(Date, 'now', () => now)
  const fx = await fixture(), start = now
  for (let i = 0; i < 6; i++) {
    now = start + i * 1000
    assert.equal((await fx.call(BUDGET, {})).status, 200)
  }
  now = start + 59999
  assert.equal((await fx.call(BUDGET, {})).body.retryAfterMs, 1)
  now++
  assert.equal((await fx.call(BUDGET, {})).body.remaining, 0)
  assert.equal((await fx.call(BUDGET, {})).body.retryAfterMs, 1000)
})

test('speech budget uses normalized verified owner identity, never caller-selected subjects', async () => {
  const fx = await fixture(), access = email => ({ 'x-x6-verified-access': JSON.stringify({ type: 'owner', email, expires: Date.now() / 1000 + 3600 }) })
  for (let i = 0; i < 6; i++) assert.equal((await fx.call(BUDGET, {}, access(i % 2 ? OWNER.toUpperCase() : OWNER))).status, 200)
  assert.equal((await fx.call(BUDGET, {}, access(OWNER.toUpperCase()), fx.create({ OWNER_EMAIL: OWNER.toUpperCase() }))).status, 429)
  const before = fx.storage.snapshot()
  assert.equal((await fx.call(BUDGET, { ownerSubject: 'another-owner' })).status, 400)
  assert.equal((await fx.call(BUDGET, {}, access('other@example.invalid'))).status, 403)
  assert.deepEqual(fx.storage.snapshot(), before)
  assert.equal((await fx.call(BUDGET, {}, access('other@example.invalid'), fx.create({ OWNER_EMAIL: 'other@example.invalid' }))).body.remaining, 5)
})

test('speech reservations require internal authorization, matching bootstrap and a live owner', async () => {
  const fx = await fixture(), before = fx.storage.snapshot()
  const access = { type: 'owner', email: OWNER, expires: Date.now() / 1000 + 3600 }
  const cases = [
    [{ 'x-x6-internal-authorized': null }, 401],
    [{ 'x-x6-bootstrap-seed': null }, 503],
    [{ 'x-x6-bootstrap-seed': 'f'.repeat(64) }, 503],
    [{ 'x-x6-verified-access': null }, 403],
    [{ 'x-x6-verified-access': '{' }, 403],
    ...[null, {}, { ...access, type: 'access' }, { ...access, email: 'other@example.invalid' },
      { ...access, expires: Date.now() / 1000 }, { ...access, expires: String(access.expires) }, { ...access, expires: 1e300 }]
      .map(value => [{ 'x-x6-verified-access': JSON.stringify(value) }, 403]),
  ]
  for (const [headers, status] of cases) {
    assert.equal((await fx.call(BUDGET, {}, headers)).status, status)
    assert.deepEqual(fx.storage.snapshot(), before)
  }
  assert.equal((await fx.call(BUDGET, {}, undefined, fx.create({ OWNER_EMAIL: undefined }))).status, 403)
  const unseeded = new X61HeadDurableObject({ storage: storageFixture(), getWebSockets: () => [] }, { OWNER_EMAIL: OWNER })
  assert.equal((await fx.call(BUDGET, {}, undefined, unseeded)).status, 503)
})

test('speech budget refuses malformed transport and corrupt durable state without mutation', async () => {
  const fx = await fixture(), before = fx.storage.snapshot()
  for (const [path, body, headers, status] of [[BUDGET, undefined, {}, 405], [BUDGET + '?extra=1', {}, {}, 404],
    [BUDGET, [], {}, 400], [BUDGET, null, {}, 400], [BUDGET, {}, { 'content-type': 'text/plain' }, 400],
    [BUDGET, { oversized: 'a'.repeat(1024) }, {}, 413]]) {
    assert.equal((await fx.call(path, body, headers)).status, status)
    assert.deepEqual(fx.storage.snapshot(), before)
  }
  const key = `head:speech-pass-budget:v1:${await digest(OWNER)}`
  for (const corrupt of [{}, [Date.now() + 60000], [1, 0], Array(7).fill(0), [NaN]]) {
    await fx.storage.put(key, corrupt)
    const snapshot = fx.storage.snapshot()
    assert.equal((await fx.call(BUDGET, {})).status, 503)
    assert.deepEqual(fx.storage.snapshot(), snapshot)
  }
})

test('failed speech reservation writes roll back and never consume promotion state', async t => {
  t.mock.method(console, 'error', () => {})
  const fx = await fixture(), before = fx.storage.snapshot()
  fx.storage.inject((operation, key) => { if (operation === 'put' && key.startsWith('head:speech-pass-budget:v1:')) throw new Error('Budget write unavailable') })
  assert.equal((await fx.call(BUDGET, {})).status, 503)
  assert.deepEqual(fx.storage.snapshot(), before)
  fx.storage.inject(() => {})
  assert.equal((await fx.call(BUDGET, {})).body.remaining, 5)
})

test('Worker speech grants consume the real durable Head budget before injected provider calls', async () => {
  const fx = await fixture()
  let head = fx.head, providerCalls = 0
  const env = { ...fx.env, DEEPGRAM_API_KEY: 'fixture-master-key',
    HEAD: { idFromName: name => name, get: () => ({ fetch: request => head.fetch(request) }) },
    MIRROR: { idFromName: name => name, get: () => ({ fetch: async request => {
      assert.equal(new URL(request.url).pathname, '/_mirror/bootstrap-status')
      return Response.json({ ok: true, phase: 'ready', seedId: fx.seed.seedId, ballId: fx.ball.ballId, epoch: fx.ball.epoch })
    } }) },
  }
  const worker = createWorker({
    verifyAccess: async () => ({ type: 'owner', email: OWNER, expires: Date.now() / 1000 + 3600 }),
    networkFetch: async (url, init) => {
      providerCalls++
      assert.equal(url, 'https://api.deepgram.com/v1/auth/grant')
      assert.equal(init.headers.authorization, 'Token fixture-master-key')
      return Response.json({ access_token: 'fixture-short-lived-token', expires_in: 30 })
    },
  })
  for (let i = 0; i < 7; i++) {
    if (i === 3) head = fx.create()
    const response = await worker.fetch(new Request(ORIGIN + '/_host/voice', { method: 'POST',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
        'x-x6-verified-access': JSON.stringify({ type: 'owner', email: 'forged@example.invalid', expires: 9999999999 }) },
      body: JSON.stringify({ action: 'speech_pass', ownerSubject: 'forged-subject' }),
    }), env)
    const body = await response.json()
    assert.equal(response.status, i < 6 ? 200 : 429, JSON.stringify(body))
    if (i < 6) assert.equal(body.accessToken, 'fixture-short-lived-token')
    else assert.equal(body.code, 'SPEECH_PASS_RATE_LIMITED')
    assert.equal(JSON.stringify(body).includes('fixture-master-key'), false)
  }
  assert.equal(providerCalls, 6)
  assert.equal((await fx.storage.get(`head:speech-pass-budget:v1:${await digest(OWNER)}`)).length, 6)
})
