/** Read-only reconciliation uses real HeadDO with synthetic durable state and no provider calls. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest, manifestIdCanon } from '../head-do.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'

const ORIGIN = 'https://repo.example.invalid'
const ROUTE = '/_head/repo-proposal'
const STAGE = 'head:staged-repo-proposal'
const ATTEMPT = 'head:repo-merge-attempt'
const OUTCOME = 'head:last-repo-merge-outcome'
const deferred = () => Promise.withResolvers()

function storageFixture() {
  let data = new Map(), tail = Promise.resolve(), hook = null
  const view = map => ({
    get: async key => { await hook?.('get', key); return structuredClone(map.get(key)) },
    put: async (key, value) => { await hook?.('put', key); map.set(key, structuredClone(value)) },
    delete: async key => { await hook?.('delete', key); return map.delete(key) },
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
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
  storage.snapshot = () => structuredClone(data)
  storage.failOnce = (method, key) => { hook = async (actual, target) => {
    if (actual === method && target === key) { hook = null; throw new Error('synthetic storage fault') }
  } }
  storage.pauseOnce = (method, key) => {
    const reached = deferred(), resume = deferred()
    hook = async (actual, target) => {
      if (actual === method && target === key) { hook = null; reached.resolve(); await resume.promise }
    }
    return { reached: reached.promise, resume: resume.resolve }
  }
  return storage
}

async function proposal(label = 'first', branch = `auma/proposal/${label}`) {
  const mergeBody = { action: 'merge_proposal', baseSha: '1'.repeat(40), branch,
    headSha: label === 'first' ? '2'.repeat(40) : '3'.repeat(40), treeSha: '4'.repeat(40) }
  return { schema: 'aukora.staged-repo-proposal.v1', branch, title: `Improve ${label}`, summary: 'Synthetic change',
    baseSha: mergeBody.baseSha, headSha: mergeBody.headSha, treeSha: mergeBody.treeSha,
    changedFiles: [{ path: 'deploy/cloudflare/src/example.mjs', status: 'modified', additions: 3, deletions: 1, t2Protected: true }],
    ciStatus: 'passed', stagedAt: Date.now(), mergeBody,
    binding: { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/repo', bodySha256: await digest(canonicalJson(mergeBody)) } }
}

async function fixture() {
  const storage = storageFixture(), notifications = []
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: 'owner@example.invalid', OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), AUMLOK_CUSTODY_PEPPER: '22'.repeat(32) }
  const create = () => {
    const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
    head.broadcast = async value => { notifications.push(value) }
    return head
  }
  const head = create(), code = 'export const organ = "synthetic";\n', sha = await digest(code)
  const draft = { version: 'x6.1-ball/v1', epoch: 167, parentBallId: null, createdAt: '2026-11-11T00:00:00.000Z', authorPeerId: 'fixture-peer',
    entries: { 'seed-echo': { id: 'seed-echo', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(code) } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }
  const payload = { version: BOOTSTRAP_VERSION, ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } }
  const seedId = await digest(canonicalBootstrap(payload))
  assert.equal((await head.store.bootstrapPrepare({ ...payload, seedId })).ok, true)
  assert.equal((await head.store.bootstrapCommit(seedId, { ok: true, phase: 'ready', seedId, ballId: ball.ballId, epoch: 167, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  const access = { type: 'owner', email: env.OWNER_EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 }
  const call = async (body, options = {}) => {
    const headers = new Headers({ 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId,
      'x-x6-verified-access': JSON.stringify(access), 'content-type': 'application/json' })
    for (const [key, value] of Object.entries(options.headers ?? {})) value === null ? headers.delete(key) : headers.set(key, value)
    const method = options.method ?? (body === undefined ? 'GET' : 'POST')
    const response = await (options.head ?? head).fetch(new Request('https://x61.internal' + (options.path ?? ROUTE), {
      method, headers, ...(method === 'GET' ? {} : { body: options.raw ?? JSON.stringify(body) }),
    }))
    return { status: response.status, body: await response.json() }
  }
  const status = object => call(undefined, { path: '/_head/promotion-status', head: object })
  const stage = (p, options) => call({ action: 'stage', proposal: p }, options)
  const begin = (p, options) => call({ action: 'begin_merge', mergeBody: p.mergeBody, binding: p.binding }, options)
  const outcome = (attemptId, value, options) => call({ action: 'merge_outcome', attemptId, outcome: value }, options)
  return { storage, env, access, seedId, ball, head, create, notifications, call, stage, begin, outcome, status }
}

function failure(result, status, code) {
  assert.equal(result.status, status)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, code)
}

async function pendingFixture(unknown = true) {
  const fx = await fixture(), p = await proposal()
  assert.equal((await fx.stage(p)).status, 200)
  const { attemptId } = (await fx.begin(p)).body
  if (unknown) assert.equal((await fx.outcome(attemptId, { status: 'unknown', code: 'REPO_REF_OUTCOME_UNKNOWN' })).status, 200)
  const input = () => ({ action: 'reconcile_merge', attemptId, mergeBody: p.mergeBody, binding: p.binding,
    verification: { mainSha: p.headSha, branchSha: p.headSha, treeSha: p.treeSha, checkedAt: Date.now() } })
  return { ...fx, p, attemptId, input }
}

test('sandbox proposals cannot be staged or claimed by the real durable owner', async () => {
  const fx = await fixture(), p = await proposal('sandbox', 'auma/sandbox/fixture-fix'), before = fx.storage.snapshot()
  failure(await fx.stage(p), 400, 'REPO_PROPOSAL_INVALID')
  failure(await fx.begin(p), 400, 'REPO_MERGE_BINDING_INVALID')
  assert.deepEqual(fx.storage.snapshot(), before); assert.deepEqual(fx.notifications, [])
})

test('inspect and reconcile require internal identity, matching seed and an unexpired owner', async () => {
  const fx = await pendingFixture(), before = fx.storage.snapshot()
  for (const [headers, status, code] of [
    [{ 'x-x6-internal-authorized': null }, 401, 'UNAUTHORIZED'],
    [{ 'x-x6-bootstrap-seed': null }, 503, 'BOOTSTRAP_REQUIRED'],
    [{ 'x-x6-bootstrap-seed': 'f'.repeat(64) }, 503, 'BOOTSTRAP_REQUIRED'],
    [{ 'x-x6-verified-access': '{' }, 403, 'REPO_PROPOSAL_OWNER_REQUIRED'],
    ...[null, { ...fx.access, type: 'access' }, { ...fx.access, email: 'other@example.invalid' }, { ...fx.access, expires: 1 }]
      .map(access => [{ 'x-x6-verified-access': JSON.stringify(access) }, 403, 'REPO_PROPOSAL_OWNER_REQUIRED']),
  ]) {
    for (const input of [{ action: 'inspect_merge' }, fx.input()]) {
      failure(await fx.call(input, { headers }), status, code)
      assert.deepEqual(fx.storage.snapshot(), before)
    }
  }
})

test('inspection returns only correlated merge identity without mutating persisted state', async () => {
  const fx = await pendingFixture(), before = fx.storage.snapshot(), notifications = structuredClone(fx.notifications)
  assert.deepEqual((await fx.call({ action: 'inspect_merge' }, { head: fx.create() })).body,
    { ok: true, attemptId: fx.attemptId, mergeBody: fx.p.mergeBody, binding: fx.p.binding })
  assert.deepEqual(fx.storage.snapshot(), before); assert.deepEqual(fx.notifications, notifications)
  failure(await fx.call({ action: 'inspect_merge', attemptId: fx.attemptId }), 400, 'REPO_PROPOSAL_ACTION_INVALID')
  const empty = await fixture()
  failure(await empty.call({ action: 'inspect_merge' }), 409, 'REPO_MERGE_ATTEMPT_MISSING')
})

test('exact main and immutable tree resolve unknown once across recreation without consuming approval', async () => {
  for (const branchSha of [null, 'e'.repeat(40)]) {
    const fx = await pendingFixture(), input = fx.input()
    input.verification.branchSha = branchSha
    fx.head.aumlokStore = { consumeApprovalInTransaction: () => assert.fail('reconciliation is read-only toward providers') }
    const result = await fx.call(input)
    assert.equal(result.status, 200); assert.equal(result.body.reconciled, true)
    assert.equal(result.body.outcome.status, 'succeeded'); assert.equal(result.body.outcome.commitSha, fx.p.headSha)
    const view = (await fx.status(fx.create())).body
    assert.equal(view.stagedRepoProposal, null); assert.equal(view.repoMergeAttempt, null)
    assert.equal(view.lastRepoMergeOutcome.status, 'succeeded')
    const after = fx.storage.snapshot()
    failure(await fx.call(input), 409, 'REPO_MERGE_ATTEMPT_MISSING')
    assert.deepEqual(fx.storage.snapshot(), after)
    assert.equal(fx.notifications.filter(item => item.type === 'repo:merged').length, 1)
  }
})

test('base, divergent main and wrong tree preserve both pending and unknown records byte-for-byte', async () => {
  for (const unknown of [false, true]) {
    const fx = await pendingFixture(unknown), before = fx.storage.snapshot(), events = structuredClone(fx.notifications)
    for (const evidence of [{ mainSha: fx.p.baseSha }, { mainSha: 'e'.repeat(40) }, { treeSha: 'e'.repeat(40) }]) {
      const input = fx.input(); Object.assign(input.verification, evidence)
      const result = await fx.call(input)
      assert.equal(result.status, 200); assert.equal(result.body.reconciled, false)
      assert.deepEqual(result.body.outcome, { status: 'unknown', code: 'REPO_MERGE_PENDING' })
      assert.deepEqual(fx.storage.snapshot(), before); assert.deepEqual(fx.notifications, events)
    }
    failure(await fx.begin(fx.p), 409, 'REPO_MERGE_PENDING')
  }
})

test('stale attempts, changed valid bindings and stale observation times cannot complete a merge', async () => {
  const fx = await pendingFixture(), before = fx.storage.snapshot()
  const wrongAttempt = fx.input(); wrongAttempt.attemptId = crypto.randomUUID()
  failure(await fx.call(wrongAttempt), 409, 'REPO_MERGE_ATTEMPT_STALE')
  const other = await proposal('second'), changed = fx.input()
  changed.mergeBody = other.mergeBody; changed.binding = other.binding
  failure(await fx.call(changed), 409, 'REPO_MERGE_ATTEMPT_STALE')
  const startedAt = (await fx.storage.get(ATTEMPT)).startedAt
  for (const checkedAt of [startedAt - 1, Date.now() + 60000, Date.now() - 61000]) {
    const input = fx.input(); input.verification.checkedAt = checkedAt
    failure(await fx.call(input), 409, 'REPO_RECONCILE_STALE')
  }
  assert.deepEqual(fx.storage.snapshot(), before)
})

test('malformed evidence and caller-added authority are refused without writes', async () => {
  const fx = await pendingFixture(), before = fx.storage.snapshot()
  for (const mutate of [
    value => { value.attemptId = 'invalid' }, value => { value.binding.bodySha256 = '0'.repeat(64) },
    value => { value.binding.audience = 'https://other.invalid' }, value => { value.mergeBody.headSha = 'f'.repeat(40) },
    value => { value.verification.mainSha = 'bad' }, value => { value.verification.branchSha = false },
    value => { delete value.verification.treeSha }, value => { value.verification.treeSha = 'F'.repeat(40) },
    value => { value.verification.checkedAt = 0 }, value => { value.verification.checkedAt = 'now' },
    value => { value.verification.extra = true }, value => { value.owner = fx.access },
  ]) {
    const input = structuredClone(fx.input()); mutate(input)
    failure(await fx.call(input), 400, 'REPO_RECONCILE_INVALID')
    assert.deepEqual(fx.storage.snapshot(), before)
  }
})

test('damaged claims and prior receipts fail closed and never echo arbitrary durable fields', async () => {
  for (const [key, mutate] of [
    [ATTEMPT, value => ({ ...value, binding: { ...value.binding, bodySha256: '0'.repeat(64) } })],
    [ATTEMPT, value => ({ ...value, seedId: 'f'.repeat(64) })],
    [ATTEMPT, value => ({ ...value, extra: 'synthetic-private-content' })],
    [OUTCOME, value => ({ ...value, extra: 'synthetic-private-content' })],
  ]) {
    const fx = await pendingFixture()
    await fx.storage.put(key, mutate(await fx.storage.get(key)))
    const before = fx.storage.snapshot()
    for (const input of [{ action: 'inspect_merge' }, fx.input()]) {
      const result = await fx.call(input)
      failure(result, 503, 'REPO_PROPOSAL_STORAGE_INVALID')
      assert.equal(JSON.stringify(result).includes('synthetic-private-content'), false)
      assert.deepEqual(fx.storage.snapshot(), before)
    }
  }
})

test('successful remote observation preserves an unrelated replacement stage', async () => {
  const fx = await pendingFixture(), other = await proposal('second')
  await fx.storage.put(STAGE, other)
  assert.equal((await fx.call(fx.input())).body.reconciled, true)
  assert.deepEqual(await fx.storage.get(STAGE), other)
  assert.equal(await fx.storage.get(ATTEMPT), undefined)
  assert.equal((await fx.storage.get(OUTCOME)).commitSha, fx.p.headSha)
})

test('reconciliation receipt failures roll back every write and emit no success notification', async () => {
  for (const [method, key] of [['put', OUTCOME], ['delete', ATTEMPT], ['delete', STAGE]]) {
    const fx = await pendingFixture(), before = fx.storage.snapshot(), events = structuredClone(fx.notifications)
    fx.storage.failOnce(method, key)
    failure(await fx.call(fx.input()), 503, 'REPO_PROPOSAL_STORAGE_UNAVAILABLE')
    assert.deepEqual(fx.storage.snapshot(), before); assert.deepEqual(fx.notifications, events)
    assert.equal((await fx.call({ action: 'inspect_merge' }, { head: fx.create() })).body.attemptId, fx.attemptId)
  }
})
