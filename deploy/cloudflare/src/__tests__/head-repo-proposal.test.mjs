/** Repo proposal claims and receipts use only synthetic owner, storage, and transport fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest, manifestIdCanon } from '../head-do.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { createWorker } from '../worker.mjs'

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

test('stage persists the exact proposal, emits its event, and leaves legacy HEAD storage unchanged', async () => {
  const fx = await fixture(), p = await proposal(), before = fx.storage.snapshot()
  assert.deepEqual((await fx.status()).body.stagedRepoProposal, null)
  const staged = await fx.stage(p)
  assert.equal(staged.status, 200)
  assert.deepEqual(staged.body, { ok: true, proposal: p })
  const after = fx.storage.snapshot()
  after.delete(STAGE)
  assert.deepEqual(after, before)
  const status = (await fx.status(fx.create())).body
  assert.deepEqual(status.stagedRepoProposal, p)
  assert.equal(status.lastRepoMergeOutcome, null)
  assert.equal(status.repoMergeAttempt, null)
  assert.deepEqual(fx.notifications, [{ type: 'repo:staged', proposal: p }])
  const sandbox = await proposal('sandbox', 'auma/sandbox/test-change')
  failure(await fx.stage(sandbox), 400, 'REPO_PROPOSAL_INVALID')
  assert.deepEqual((await fx.status()).body.stagedRepoProposal, p)
})

test('all mutation actions require internal auth, matching bootstrap, and strict unexpired owner identity', async () => {
  const fx = await fixture(), p = await proposal(), before = fx.storage.snapshot()
  const cases = [
    [{ 'x-x6-internal-authorized': null }, 401, 'UNAUTHORIZED'],
    [{ 'x-x6-bootstrap-seed': null }, 503, 'BOOTSTRAP_REQUIRED'],
    [{ 'x-x6-bootstrap-seed': 'f'.repeat(64) }, 503, 'BOOTSTRAP_REQUIRED'],
    [{ 'x-x6-verified-access': '{' }, 403, 'REPO_PROPOSAL_OWNER_REQUIRED'],
    ...[null, {}, { ...fx.access, type: 'access' }, { ...fx.access, email: 'other@example.invalid' },
      { ...fx.access, expires: 1 }, { ...fx.access, expires: String(fx.access.expires) }]
      .map(access => [{ 'x-x6-verified-access': JSON.stringify(access) }, 403, 'REPO_PROPOSAL_OWNER_REQUIRED']),
  ]
  for (const [headers, status, code] of cases) {
    for (const body of [{ action: 'stage', proposal: p }, { action: 'begin_merge', mergeBody: p.mergeBody, binding: p.binding },
      { action: 'merge_outcome', attemptId: crypto.randomUUID(), outcome: { status: 'succeeded', commitSha: p.headSha } }]) {
      failure(await fx.call(body, { headers }), status, code)
      assert.deepEqual(fx.storage.snapshot(), before)
    }
  }
  assert.equal((await fx.stage(p, { headers: { 'x-x6-verified-access': JSON.stringify({ ...fx.access, email: fx.access.email.toUpperCase() }) } })).status, 200)
  for (const override of [{ OWNER_EMAIL: undefined }, { PUBLIC_HOST: undefined }, { PUBLIC_HOST: 'repo.example.invalid/path' }]) {
    const original = { ...fx.env }
    Object.assign(fx.env, override)
    failure(await fx.stage(p), 403, 'REPO_PROPOSAL_OWNER_REQUIRED')
    Object.assign(fx.env, original)
  }
})

test('route rejects methods, query strings, invalid JSON, encoding, and oversized bodies', async () => {
  const fx = await fixture(), p = await proposal()
  failure(await fx.call(undefined), 405, 'METHOD_UNAVAILABLE')
  failure(await fx.stage(p, { path: ROUTE + '?' }), 404, 'NOT_FOUND')
  failure(await fx.stage(p, { path: ROUTE + '#unexpected' }), 404, 'NOT_FOUND')
  failure(await fx.stage(p, { headers: { 'content-type': 'text/plain' } }), 400, 'REPO_PROPOSAL_INVALID')
  failure(await fx.stage(p, { raw: '{' }), 400, 'INVALID_JSON')
  failure(await fx.stage(p, { headers: { 'content-encoding': 'gzip' } }), 400, 'REQUEST_ENCODING_UNSUPPORTED')
  failure(await fx.stage(p, { raw: ' '.repeat(98 * 1024) }), 413, 'REQUEST_BODY_TOO_LARGE')
})

test('exact bounded metadata and five-field merge request and binding refuse tampering', async () => {
  const fx = await fixture(), p = await proposal(), before = fx.storage.snapshot()
  const mutations = [
    v => { v.extra = true }, v => { v.title = '' }, v => { v.title = 'x'.repeat(201) }, v => { v.summary = 'x'.repeat(4001) },
    v => { v.headSha = '9'.repeat(40) }, v => { v.stagedAt = -1 }, v => { v.ciStatus = 'green' },
    v => { v.mergeBody.token = 'caller-selected' }, v => { v.mergeBody.headSha = '9'.repeat(40) },
    v => { v.binding.extra = true }, v => { v.binding.audience = 'https://foreign.invalid' },
    v => { v.binding.bodySha256 = '0'.repeat(64) }, v => { v.binding.method = 'GET' }, v => { v.binding.pathname = '/_head/repo-proposal' },
    v => { v.changedFiles[0].path = '.github/workflows/ci.yml' }, v => { v.changedFiles[0].path = 'docs/../private.txt' },
    v => { v.changedFiles[0].path = 'docs\\private.txt' }, v => { v.changedFiles[0].additions = -1 },
    v => { v.changedFiles[0].deletions = 1e9 + 1 }, v => { v.changedFiles[0].status = 'renamed' },
    v => { v.changedFiles[0].t2Protected = 'true' }, v => { v.changedFiles.push({ ...v.changedFiles[0] }) },
    v => { v.changedFiles = Array.from({ length: 101 }, (_, i) => ({ ...v.changedFiles[0], path: `docs/${i}.md` })) },
    v => { v.changedFiles = Array.from({ length: 100 }, (_, i) => ({ ...v.changedFiles[0], path: `docs/${i}-${'x'.repeat(990)}.md` })) },
  ]
  for (const mutate of mutations) {
    const bad = structuredClone(p); mutate(bad)
    const result = await fx.stage(bad)
    assert.ok([400, 413].includes(result.status), JSON.stringify(result))
    assert.deepEqual(fx.storage.snapshot(), before)
  }
  failure(await fx.call({ action: 'stage', proposal: p, owner: fx.access }), 400, 'REPO_PROPOSAL_INVALID')
  failure(await fx.call({ action: 'unknown' }), 400, 'REPO_PROPOSAL_ACTION_INVALID')
})

test('begin matches the current stage and never consumes approval inside HeadDO', async () => {
  const fx = await fixture(), a = await proposal(), b = await proposal('second')
  fx.head.aumlokStore = { consumeApprovalInTransaction: () => { assert.fail('broker alone consumes repo approval') } }
  failure(await fx.begin(a), 409, 'REPO_PROPOSAL_MISSING')
  await fx.stage(a)
  failure(await fx.begin({ ...a, binding: { ...a.binding, audience: 'https://foreign.invalid' } }), 400, 'REPO_MERGE_BINDING_INVALID')
  await fx.stage(b)
  failure(await fx.begin(a), 409, 'REPO_PROPOSAL_CHANGED')
  const started = await fx.begin(b)
  assert.equal(started.status, 200)
  assert.match(started.body.attemptId, /^[0-9a-f-]{36}$/)
  const remounted = (await fx.status(fx.create())).body
  assert.equal(remounted.repoMergeAttempt.attemptId, started.body.attemptId)
  assert.equal(remounted.repoMergeAttempt.status, 'pending')
  assert.deepEqual(remounted.stagedRepoProposal, b)
})

test('overlapping stages serialize and a durable merge claim excludes another merge and replacement', async () => {
  const fx = await fixture(), a = await proposal(), b = await proposal('second')
  const stageHold = fx.storage.pauseOnce('put', STAGE)
  const firstStage = fx.stage(a)
  await stageHold.reached
  const secondStage = fx.stage(b)
  stageHold.resume()
  assert.deepEqual((await Promise.all([firstStage, secondStage])).map(value => value.status), [200, 200])
  assert.deepEqual((await fx.status()).body.stagedRepoProposal, b)
  const claimHold = fx.storage.pauseOnce('put', ATTEMPT)
  const first = fx.begin(b)
  await claimHold.reached
  const second = fx.begin(b, { head: fx.create() }), replacement = fx.stage(a)
  claimHold.resume()
  const [claimed, denied, refused] = await Promise.all([first, second, replacement])
  assert.equal(claimed.status, 200)
  failure(denied, 409, 'REPO_MERGE_PENDING')
  failure(refused, 409, 'REPO_MERGE_PENDING')
  assert.deepEqual((await fx.status()).body.stagedRepoProposal, b)
})

test('successful outcome atomically clears its matching stage and survives remount', async () => {
  const fx = await fixture(), p = await proposal()
  await fx.stage(p)
  const { attemptId } = (await fx.begin(p)).body
  failure(await fx.outcome(attemptId, { status: 'succeeded', commitSha: 'f'.repeat(40) }), 400, 'REPO_MERGE_OUTCOME_INVALID')
  const result = await fx.outcome(attemptId, { status: 'succeeded', commitSha: p.headSha })
  assert.equal(result.status, 200)
  assert.equal(result.body.outcome.status, 'succeeded')
  assert.equal(Object.hasOwn(result.body, 'notification'), false)
  const view = (await fx.status(fx.create())).body
  assert.equal(view.stagedRepoProposal, null)
  assert.equal(view.repoMergeAttempt, null)
  assert.equal(view.lastRepoMergeOutcome.commitSha, p.headSha)
  assert.deepEqual(fx.notifications.at(-1), { type: 'repo:merged', commitSha: p.headSha, branch: p.branch })
  failure(await fx.outcome(attemptId, { status: 'failed', code: 'LATE_FAILURE' }), 409, 'REPO_MERGE_ATTEMPT_STALE')
  assert.equal((await fx.status()).body.lastRepoMergeOutcome.status, 'succeeded')
})

test('definite failure releases the claim but preserves stage; a stale attempt cannot alter the replacement', async () => {
  const fx = await fixture(), p = await proposal()
  await fx.stage(p)
  const first = (await fx.begin(p)).body.attemptId
  assert.equal((await fx.outcome(first, { status: 'failed', code: 'CLASS3_WEBAUTHN_REQUIRED' })).status, 200)
  const second = (await fx.begin(p)).body.attemptId
  assert.notEqual(first, second)
  failure(await fx.outcome(first, { status: 'succeeded', commitSha: p.headSha }), 409, 'REPO_MERGE_ATTEMPT_STALE')
  assert.equal((await fx.status()).body.repoMergeAttempt.attemptId, second)
  assert.deepEqual((await fx.status()).body.stagedRepoProposal, p)
})

test('unknown outcomes remain blocked after recreation and cannot become a retryable failure', async () => {
  const fx = await fixture(), p = await proposal()
  await fx.stage(p)
  const { attemptId } = (await fx.begin(p)).body
  assert.equal((await fx.outcome(attemptId, { status: 'unknown', code: 'REPO_OUTCOME_UNKNOWN' })).status, 200)
  const head = fx.create()
  failure(await fx.stage(await proposal('second'), { head }), 409, 'REPO_MERGE_PENDING')
  failure(await fx.begin(p, { head }), 409, 'REPO_MERGE_PENDING')
  failure(await fx.outcome(attemptId, { status: 'failed', code: 'PROVIDER_REFUSED' }, { head }), 409, 'REPO_MERGE_OUTCOME_UNKNOWN')
  const view = (await fx.status(head)).body
  assert.equal(view.lastRepoMergeOutcome.status, 'unknown')
  assert.equal(view.repoMergeAttempt.status, 'unknown')
  assert.deepEqual(view.stagedRepoProposal, p)
  await fx.storage.delete(ATTEMPT)
  failure(await fx.begin(p), 409, 'REPO_MERGE_PENDING')
})

test('a success receipt never clears an unrelated stage record', async () => {
  const fx = await fixture(), a = await proposal(), b = await proposal('second')
  await fx.stage(a)
  const { attemptId } = (await fx.begin(a)).body
  await fx.storage.put(STAGE, b)
  assert.equal((await fx.outcome(attemptId, { status: 'succeeded', commitSha: a.headSha })).status, 200)
  const view = (await fx.status()).body
  assert.deepEqual(view.stagedRepoProposal, b)
  assert.equal(view.lastRepoMergeOutcome.commitSha, a.headSha)
})

test('stage and claim storage failures roll back without granting remote dispatch', async () => {
  const fx = await fixture(), p = await proposal(), before = fx.storage.snapshot()
  fx.storage.failOnce('put', STAGE)
  failure(await fx.stage(p), 503, 'REPO_PROPOSAL_STORAGE_UNAVAILABLE')
  assert.deepEqual(fx.storage.snapshot(), before)
  assert.deepEqual(fx.notifications, [])
  await fx.stage(p)
  const staged = fx.storage.snapshot()
  fx.storage.failOnce('put', ATTEMPT)
  failure(await fx.begin(p), 503, 'REPO_PROPOSAL_STORAGE_UNAVAILABLE')
  assert.deepEqual(fx.storage.snapshot(), staged)
})

test('receipt failures leave the pending claim and stage intact, including a failure after receipt put', async () => {
  for (const [method, key] of [['put', OUTCOME], ['delete', ATTEMPT], ['delete', STAGE]]) {
    const fx = await fixture(), p = await proposal()
    await fx.stage(p)
    const { attemptId } = (await fx.begin(p)).body, before = fx.storage.snapshot()
    fx.storage.failOnce(method, key)
    failure(await fx.outcome(attemptId, { status: 'succeeded', commitSha: p.headSha }), 503, 'REPO_PROPOSAL_STORAGE_UNAVAILABLE')
    assert.deepEqual(fx.storage.snapshot(), before)
    failure(await fx.begin(p, { head: fx.create() }), 409, 'REPO_MERGE_PENDING')
    assert.equal(fx.notifications.filter(event => event.type === 'repo:merged').length, 0)
  }
})

test('notification failures do not erase committed proposal or merge receipts', async () => {
  const fx = await fixture(), p = await proposal()
  fx.head.broadcast = async () => { throw new Error('synthetic notification failure') }
  assert.equal((await fx.stage(p)).status, 200)
  const { attemptId } = (await fx.begin(p)).body
  assert.equal((await fx.outcome(attemptId, { status: 'succeeded', commitSha: p.headSha })).status, 200)
  assert.equal((await fx.status(fx.create())).body.lastRepoMergeOutcome.status, 'succeeded')
})

test('malformed outcomes and damaged durable claims fail closed', async () => {
  const fx = await fixture(), p = await proposal()
  await fx.stage(p)
  const { attemptId } = (await fx.begin(p)).body, before = fx.storage.snapshot()
  for (const value of [{ status: 'succeeded', commitSha: p.headSha, code: 'EXTRA' }, { status: 'failed' },
    { status: 'failed', code: 'raw message with private content' }, { status: 'unknown', code: 'UNKNOWN', commitSha: p.headSha },
    { status: 'pending' }, { status: 'failed', code: 'FAILED', authority: true }]) {
    failure(await fx.outcome(attemptId, value), 400, 'REPO_MERGE_OUTCOME_INVALID')
    assert.deepEqual(fx.storage.snapshot(), before)
  }
  const pending = await fx.storage.get(ATTEMPT)
  await fx.storage.put(ATTEMPT, { ...pending, binding: { ...pending.binding, audience: 'https://foreign.invalid' } })
  failure(await fx.outcome(attemptId, { status: 'succeeded', commitSha: p.headSha }), 503, 'REPO_PROPOSAL_STORAGE_INVALID')
  failure(await fx.status(), 503, 'REPO_PROPOSAL_STORAGE_INVALID')
  assert.deepEqual(await fx.storage.get(STAGE), p)
})

test('the public Worker never forwards the internal repo-proposal route even with forged trusted headers', async () => {
  const fx = await fixture(), calls = []
  const bootstrap = phase => Response.json({ ok: true, phase, seedId: fx.seedId, ballId: fx.ball.ballId, epoch: 167 })
  fx.env.HEAD = { idFromName: name => name, get: () => ({ fetch: async request => {
    calls.push(new URL(request.url).pathname)
    assert.equal(new URL(request.url).pathname, '/_head/bootstrap-status')
    return bootstrap('complete')
  } }) }
  fx.env.MIRROR = { idFromName: name => name, get: () => ({ fetch: async () => bootstrap('ready') }) }
  const worker = createWorker({ verifyAccess: async () => fx.access, networkFetch: async () => { assert.fail('no provider') } })
  const response = await worker.fetch(new Request(ORIGIN + ROUTE, { method: 'POST', headers: {
    'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin',
    'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': fx.seedId, 'x-x6-verified-access': JSON.stringify(fx.access),
  }, body: JSON.stringify({ action: 'stage', proposal: await proposal() }) }), fx.env)
  assert.ok(response.status >= 400)
  assert.equal(calls.includes(ROUTE), false)
  assert.equal(await fx.storage.get(STAGE), undefined)
})


test('promotion status rejects corrupt or additional persisted fields instead of exposing arbitrary storage', async () => {
  for (const corrupt of [
    async fx => { const value = await fx.storage.get(STAGE); value.secret = 'synthetic private content'; await fx.storage.put(STAGE, value) },
    async fx => { const value = await fx.storage.get(STAGE); value.binding.bodySha256 = '0'.repeat(64); await fx.storage.put(STAGE, value) },
    async fx => { const value = await fx.storage.get(STAGE); value.changedFiles[0].path = '.github/workflows/ci.yml'; await fx.storage.put(STAGE, value) },
    async fx => { await fx.storage.put(OUTCOME, { status: 'succeeded', secret: 'synthetic private content' }) },
    async fx => { await fx.storage.put(ATTEMPT, { status: 'pending', secret: 'synthetic private content' }) },
  ]) {
    const fx = await fixture(), p = await proposal()
    await fx.stage(p)
    await corrupt(fx)
    const result = await fx.status(fx.create())
    failure(result, 503, 'REPO_PROPOSAL_STORAGE_INVALID')
    assert.equal(JSON.stringify(result).includes('synthetic private content'), false)
    assert.equal(Object.hasOwn(result.body, 'stagedRepoProposal'), false)
  }
  const fx = await fixture(), p = await proposal()
  await fx.stage(p)
  const { attemptId } = (await fx.begin(p)).body
  await fx.outcome(attemptId, { status: 'succeeded', commitSha: p.headSha })
  const last = await fx.storage.get(OUTCOME)
  await fx.storage.put(OUTCOME, { ...last, arbitraryField: 'synthetic private content' })
  failure(await fx.status(), 503, 'REPO_PROPOSAL_STORAGE_INVALID')
})


test('damaged prior receipts never authorize a replacement stage or another merge claim', async () => {
  for (const damaged of [null, {}, { status: 'failed' }, { status: 'succeeded', commitSha: '2'.repeat(40) }, { status: 'unknown' }]) {
    const fx = await fixture(), p = await proposal()
    await fx.stage(p)
    await fx.storage.put(OUTCOME, damaged)
    const before = fx.storage.snapshot()
    failure(await fx.stage(await proposal('second')), 503, 'REPO_PROPOSAL_STORAGE_INVALID')
    failure(await fx.begin(p), 503, 'REPO_PROPOSAL_STORAGE_INVALID')
    assert.deepEqual(fx.storage.snapshot(), before)
  }
})
