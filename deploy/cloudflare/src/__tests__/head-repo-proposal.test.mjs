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
// The owner nonce, state and approval expiry live beside the attempt, so the attempt keeps the old shape.
const OWNER_KEY = 'head:repo-merge-attempt-owner'
// Released attempts, kept by attempt id beside the records the build before reads.
const RELEASED = 'head:repo-merge-released-by-attempt'
const deferred = () => Promise.withResolvers()
// The call that claims an attempt names it by this nonce; only it advances or settles the attempt (MUST 3b).
const OWNER = 'fixture-owner-nonce-0000000000001', APPROVAL = 'fixture-approval-token'

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
  // MUST 3: begin_merge consumes his approval inside HEAD's own transaction. A synthetic approval store stands in
  // for AUMLOK (the real one needs a passkey ceremony): it accepts the fixture token once per begin and counts each call.
  const approvals = { calls: [], refuse: null }
  const create = () => {
    const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
    head.broadcast = async value => { notifications.push(value) }
    head.aumlokStore = { consumeApprovalInTransaction: async (tx, token, binding, origin) => {
      approvals.calls.push({ token, binding, origin, inTransaction: typeof tx?.put === 'function' })
      if (approvals.refuse) { await approvals.refuse(tx); throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 }) }
      if (token !== APPROVAL) throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
      return { ok: true, binding, approvalId: null, expiresAt: Date.now() + 60000 }
    } }
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
  const begin = (p, options = {}) => call({ action: 'begin_merge', mergeBody: p.mergeBody, binding: p.binding, owner: options.owner ?? OWNER },
    { ...options, headers: { 'x-x6-class3-approval': APPROVAL, ...options.headers } })
  const outcome = (attemptId, value, options = {}) => call({ action: 'merge_outcome', attemptId, owner: options.owner ?? OWNER, outcome: value }, options)
  return { storage, env, access, seedId, ball, head, create, notifications, call, stage, begin, outcome, status, approvals }
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

test('begin matches the current stage, then consumes his approval and claims the attempt in ONE HeadDO transaction (MUST 3a)', async () => {
  const fx = await fixture(), a = await proposal(), b = await proposal('second')
  // Every refusal before consumption spends nothing: the approval store is not even asked.
  failure(await fx.begin(a), 409, 'REPO_PROPOSAL_MISSING')
  await fx.stage(a)
  failure(await fx.begin({ ...a, binding: { ...a.binding, audience: 'https://foreign.invalid' } }), 400, 'REPO_MERGE_BINDING_INVALID')
  failure(await fx.begin(a, { owner: 'short' }), 400, 'REPO_MERGE_BINDING_INVALID')
  await fx.stage(b)
  failure(await fx.begin(a), 409, 'REPO_PROPOSAL_CHANGED')
  assert.equal(fx.approvals.calls.length, 0)
  // A refused approval writes nothing: neither its own consumption (rolled back with the transaction) nor a claim.
  const staged = fx.storage.snapshot()
  fx.approvals.refuse = async tx => { await tx.put('aumlok-consumption-written-before-refusal', true) }
  failure(await fx.begin(b), 403, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(fx.storage.snapshot(), staged)
  fx.approvals.refuse = null
  failure(await fx.begin(b, { headers: { 'x-x6-class3-approval': 'another-token' } }), 403, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(fx.storage.snapshot(), staged)
  const started = await fx.begin(b)
  assert.equal(started.status, 200)
  assert.match(started.body.attemptId, /^[0-9a-f-]{36}$/)
  assert.equal(Number.isSafeInteger(started.body.approvalExpiresAt), true); assert.equal(Number.isSafeInteger(started.body.startedAt), true)
  // Consumed inside the transaction, with the STAGED binding at its own audience.
  assert.deepEqual(fx.approvals.calls.at(-1), { token: APPROVAL, binding: b.binding, origin: ORIGIN, inTransaction: true })
  assert.equal(fx.approvals.calls.length, 3)
  const remounted = (await fx.status(fx.create())).body
  assert.equal(remounted.repoMergeAttempt.attemptId, started.body.attemptId)
  assert.equal(remounted.repoMergeAttempt.status, 'pending'); assert.equal(remounted.repoMergeAttempt.state, 'claimed')
  assert.deepEqual(remounted.stagedRepoProposal, b)
  const claim = await fx.storage.get(ATTEMPT)
  assert.deepEqual(Object.keys(claim).sort(), ['attemptId', 'binding', 'mergeBody', 'proposalDigest', 'seedId', 'startedAt', 'status']); assert.equal(claim.status, 'pending')
  assert.deepEqual(await fx.storage.get(OWNER_KEY), { attemptId: started.body.attemptId, owner: OWNER, state: 'claimed', approvalExpiresAt: started.body.approvalExpiresAt })
  // A second begin while the attempt is held asks nothing of the approval store and says how old the attempt is.
  const again = await fx.begin(b)
  failure(again, 409, 'REPO_MERGE_PENDING')
  assert.equal(Number.isSafeInteger(again.body.ageMs), true); assert.equal(again.body.reconcileAfterMs, 60000)
  assert.equal(fx.approvals.calls.length, 3)
})

test('only the owning call (its nonce) marks or settles its attempt; a dispatched one never becomes void (MUST 3b and 4)', async () => {
  const fx = await fixture(), p = await proposal(), other = 'fixture-owner-nonce-0000000000002'
  await fx.stage(p)
  const { attemptId } = (await fx.begin(p)).body, held = fx.storage.snapshot()
  // Another call, with the same attempt id or none, cannot mark, settle or void it.
  failure(await fx.call({ action: 'mark_merge', attemptId, owner: other }), 409, 'REPO_MERGE_ATTEMPT_STALE')
  failure(await fx.outcome(attemptId, { status: 'failed', code: 'REPO_APPROVAL_SPENT_VOID' }, { owner: other }), 409, 'REPO_MERGE_ATTEMPT_STALE')
  failure(await fx.outcome(attemptId, { status: 'succeeded', commitSha: p.headSha }, { owner: other }), 409, 'REPO_MERGE_ATTEMPT_STALE')
  failure(await fx.call({ action: 'merge_outcome', owner: other, outcome: { status: 'unknown', code: 'X' } }), 409, 'REPO_MERGE_ATTEMPT_STALE')
  assert.deepEqual(fx.storage.snapshot(), held)
  // The owner marks it (twice: a retry after a lost answer is the same mark), and may still void it: nothing was sent.
  for (let i = 0; i < 2; i++) assert.deepEqual((await fx.call({ action: 'mark_merge', attemptId, owner: OWNER })).body, { ok: true, attemptId, state: 'marked' })
  assert.equal((await fx.status()).body.repoMergeAttempt.state, 'marked')
  const voided = await fx.call({ action: 'merge_outcome', owner: OWNER, outcome: { status: 'failed', code: 'REPO_APPROVAL_SPENT_VOID' } })
  assert.equal(voided.status, 200); assert.equal(voided.body.outcome.state, 'void'); assert.equal(voided.body.outcome.code, 'REPO_APPROVAL_SPENT_VOID')
  const view = (await fx.status()).body
  assert.equal(view.repoMergeAttempt, null); assert.equal(view.lastRepoMergeOutcome.status, 'failed'); assert.deepEqual(view.stagedRepoProposal, p)
  // Once the owner says it was dispatched, void is refused even to the owner, and a mark too.
  const second = (await fx.begin(p)).body.attemptId
  assert.equal((await fx.outcome(second, { status: 'unknown', code: 'REPO_REF_OUTCOME_UNKNOWN' })).body.outcome.state, 'dispatched')
  failure(await fx.outcome(second, { status: 'failed', code: 'REPO_APPROVAL_SPENT_VOID' }), 409, 'REPO_MERGE_OUTCOME_UNKNOWN')
  failure(await fx.call({ action: 'mark_merge', attemptId: second, owner: OWNER }), 409, 'REPO_MERGE_OUTCOME_UNKNOWN')
  assert.equal((await fx.status()).body.repoMergeAttempt.state, 'dispatched')
  // A record from before this change (no owner) is settled by nobody's nonce; only reconciliation reads it.
  const legacy = await fixture(), lp = await proposal()
  await legacy.stage(lp)
  const lid = (await legacy.begin(lp)).body.attemptId
  await legacy.storage.delete(OWNER_KEY)
  // Review: with no owner record it may have been sent, so it reads as marked (never claimed, which voids by time).
  assert.equal((await legacy.status()).body.repoMergeAttempt.state, 'marked')
  failure(await legacy.outcome(lid, { status: 'failed', code: 'REPO_APPROVAL_SPENT_VOID' }), 409, 'REPO_MERGE_ATTEMPT_STALE')
  // An owner record of another attempt (left behind by a rolled-back build) is ignored, never trusted.
  await legacy.storage.put(OWNER_KEY, { attemptId: crypto.randomUUID(), owner: OWNER, state: 'marked', approvalExpiresAt: Date.now() + 60000 })
  assert.equal((await legacy.status()).body.repoMergeAttempt.state, 'marked')
  failure(await legacy.call({ action: 'mark_merge', attemptId: lid, owner: OWNER }), 409, 'REPO_MERGE_ATTEMPT_STALE')
  failure(await legacy.outcome(lid, { status: 'failed', code: 'REPO_APPROVAL_SPENT_VOID' }), 409, 'REPO_MERGE_ATTEMPT_STALE')
})

test('every record a merge attempt writes is one the build before this change reads, so a rollback still answers the cards', async () => {
  // The key rules of an earlier commit's validRepoAttempt and validRepoStoredOutcome (head-do.mjs at origin/main): an extra key or
  // another status there makes /_head/promotion-status 503 for every approval card until someone edits storage by hand.
  const exact = (value, required, optional = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  const oldAttempt = value => value === undefined || exact(value, ['attemptId', 'status', 'startedAt', 'seedId', 'mergeBody', 'binding', 'proposalDigest']) && ['pending', 'unknown'].includes(value.status)
  const oldOutcome = value => value === undefined || exact(value, ['attemptId', 'status', 'at', 'branch', 'baseSha', 'headSha', 'treeSha'], ['commitSha', 'code'])
    && ['succeeded', 'failed', 'unknown'].includes(value.status)
  const readable = async (fx, step) => {
    assert.equal(oldAttempt(await fx.storage.get(ATTEMPT)), true, `${step}: attempt ${JSON.stringify(await fx.storage.get(ATTEMPT))}`)
    assert.equal(oldOutcome(await fx.storage.get(OUTCOME)), true, `${step}: outcome ${JSON.stringify(await fx.storage.get(OUTCOME))}`)
    assert.equal((await fx.status()).status, 200, step)
  }
  const verify = (p, mainSha) => ({ mainSha, branchSha: p.headSha, treeSha: p.treeSha, checkedAt: Date.now() })
  const old = async fx => { await fx.storage.put(ATTEMPT, { ...await fx.storage.get(ATTEMPT), startedAt: Date.now() - 60001 }) }
  // Claimed, marked, dispatched, then merged by reconciliation; and each owner outcome.
  const fx = await fixture(), p = await proposal()
  await fx.stage(p)
  const id = (await fx.begin(p)).body.attemptId
  await readable(fx, 'claimed')
  assert.equal((await fx.call({ action: 'mark_merge', attemptId: id, owner: OWNER })).status, 200); await readable(fx, 'marked')
  assert.equal((await fx.outcome(id, { status: 'unknown', code: 'REPO_REF_OUTCOME_UNKNOWN' })).body.outcome.state, 'dispatched'); await readable(fx, 'dispatched')
  const merged = await fx.call({ action: 'reconcile_merge', attemptId: id, mergeBody: p.mergeBody, binding: p.binding, verification: verify(p, p.headSha) })
  assert.equal(merged.body.outcome.state, 'merged', 'the answer still says merged'); await readable(fx, 'reconciled merged')
  for (const [label, value] of [['void', { status: 'failed', code: 'REPO_APPROVAL_SPENT_VOID' }], ['succeeded', { status: 'succeeded', commitSha: null }]]) {
    const each = await fixture(), q = await proposal(label)
    await each.stage(q)
    const qid = (await each.begin(q)).body.attemptId
    const answer = await each.outcome(qid, value.commitSha === null ? { status: 'succeeded', commitSha: q.headSha } : value)
    assert.equal(answer.status, 200); assert.equal(answer.body.outcome.state, label === 'void' ? 'void' : 'merged')
    await readable(each, label)
  }
  // Void by reconciliation past the margin.
  const late = await fixture(), r = await proposal('late')
  await late.stage(r)
  const rid = (await late.begin(r)).body.attemptId
  await old(late)
  const voided = await late.call({ action: 'reconcile_merge', attemptId: rid, mergeBody: r.mergeBody, binding: r.binding, verification: verify(r, r.baseSha) })
  assert.equal(voided.body.outcome.state, 'void'); await readable(late, 'reconciled void')
})

test('a release and a merge found after it write only records the build before this change reads (rollback), and the release is the owner\'s alone', async () => {
  const exact = (value, required, optional = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  const oldOutcome = value => value === undefined || exact(value, ['attemptId', 'status', 'at', 'branch', 'baseSha', 'headSha', 'treeSha'], ['commitSha', 'code'])
    && ['succeeded', 'failed', 'unknown'].includes(value.status) && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code ?? 'X')
  const fx = await fixture(), p = await proposal()
  await fx.stage(p)
  const id = (await fx.begin(p)).body.attemptId
  await fx.call({ action: 'mark_merge', attemptId: id, owner: OWNER })
  await fx.outcome(id, { status: 'unknown', code: 'REPO_REF_OUTCOME_UNKNOWN' })
  await fx.storage.put(ATTEMPT, { ...await fx.storage.get(ATTEMPT), startedAt: Date.now() - 60001 })
  const release = { action: 'release_attempt', attemptId: id, baseSha: p.baseSha, headSha: p.headSha }
  const binding = { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/repo', bodySha256: await digest(canonicalJson(release)) }
  const verification = (mainSha, headInMain) => ({ mainSha, branchSha: p.headSha, treeSha: p.treeSha, checkedAt: Date.now(), headInMain })
  const call = (body, headers = { 'x-x6-class3-approval': APPROVAL }) => fx.call(body, { headers })
  // Terms that are not the release's own, or verification that is not GitHub's shape: refused, nothing written.
  const before = fx.storage.snapshot()
  for (const bad of [{ ...binding, bodySha256: '0'.repeat(64) }, { ...binding, audience: 'https://other.invalid' }, { ...binding, pathname: '/_head/repo-proposal' }]) {
    failure(await call({ action: 'release_attempt', release, binding: bad, verification: verification(p.baseSha, false) }), 400, 'REPO_RELEASE_INVALID')
  }
  failure(await call({ action: 'release_attempt', release: { ...release, extra: 1 }, binding, verification: verification(p.baseSha, false) }), 400, 'REPO_RELEASE_INVALID')
  failure(await call({ action: 'release_attempt', release, binding, verification: { ...verification(p.baseSha, false), headInMain: 'yes' } }), 400, 'REPO_RELEASE_INVALID')
  // An approval HEAD's store refuses: the transaction rolls back, the attempt stays.
  failure(await call({ action: 'release_attempt', release, binding, verification: verification(p.baseSha, false) }, { 'x-x6-class3-approval': 'another-token' }), 403, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(fx.storage.snapshot(), before)
  const released = await call({ action: 'release_attempt', release, binding, verification: verification(p.baseSha, false) })
  assert.equal(released.status, 200, JSON.stringify(released.body)); assert.equal(released.body.outcome.state, 'void-by-owner'); assert.equal(released.body.released.state, 'void-by-owner')
  assert.deepEqual(fx.approvals.calls.at(-1), { token: APPROVAL, binding, origin: ORIGIN, inTransaction: true })
  assert.equal(await fx.storage.get(ATTEMPT), undefined); assert.equal(await fx.storage.get(OWNER_KEY), undefined)
  const stored = await fx.storage.get(OUTCOME)
  assert.equal(oldOutcome(stored), true, JSON.stringify(stored)); assert.equal(stored.status, 'failed'); assert.equal(stored.code, 'REPO_ATTEMPT_VOID_BY_OWNER')
  assert.equal((await fx.status()).status, 200); assert.equal((await fx.status()).body.repoMergeReleased.state, 'void-by-owner')
  // The new state lives only in the sibling key the build before never reads, kept by attempt id.
  assert.deepEqual(Object.keys(await fx.storage.get(RELEASED)), [id])
  assert.deepEqual(Object.keys((await fx.storage.get(RELEASED))[id]).sort(), ['attemptId', 'baseSha', 'branch', 'headSha', 'releasedAt', 'state', 'treeSha'])
  // A read that finds the head in main: merged after release, the outcome in the old shape.
  const quiet = await fx.call({ action: 'reconcile_released', attemptId: id, verification: verification('e'.repeat(40), false) })
  assert.equal(quiet.body.reconciled, false)
  failure(await fx.call({ action: 'reconcile_released', attemptId: crypto.randomUUID(), verification: verification('e'.repeat(40), true) }), 409, 'REPO_MERGE_ATTEMPT_STALE')
  const merged = await fx.call({ action: 'reconcile_released', attemptId: id, verification: verification('e'.repeat(40), true) })
  assert.equal(merged.body.reconciled, true); assert.equal(merged.body.outcome.state, 'merged-after-release')
  const after = await fx.storage.get(OUTCOME)
  assert.equal(oldOutcome(after), true, JSON.stringify(after)); assert.equal(after.status, 'succeeded'); assert.equal(after.commitSha, p.headSha)
  assert.equal((await fx.status()).body.repoMergeReleased.state, 'merged-after-release'); assert.deepEqual(fx.notifications.at(-1), { type: 'repo:merged', commitSha: p.headSha, branch: p.branch })
  // A damaged sibling record is never shown or trusted.
  await fx.storage.put(RELEASED, { [id]: { attemptId: id, state: 'merged-after-release', extra: 'synthetic-private-content' } })
  const damaged = await fx.status()
  assert.equal(damaged.status, 200); assert.equal(damaged.body.repoMergeReleased, null); assert.deepEqual(damaged.body.repoMergeReleases, [])
  failure(await fx.call({ action: 'inspect_released' }), 503, 'REPO_PROPOSAL_STORAGE_INVALID')
  // So is a record kept under another attempt's id.
  await fx.storage.put(RELEASED, { [crypto.randomUUID()]: (await fx.status()).body.repoMergeReleased ?? { attemptId: id } })
  failure(await fx.call({ action: 'inspect_released' }), 503, 'REPO_PROPOSAL_STORAGE_INVALID')
})

/** Review, MUST 2: take `p` through a merge whose outcome is unknown, past the margin, and the owner's release. */
async function releasedAttempt(fx, p) {
  assert.equal((await fx.stage(p)).status, 200)
  const id = (await fx.begin(p)).body.attemptId
  await fx.call({ action: 'mark_merge', attemptId: id, owner: OWNER })
  await fx.outcome(id, { status: 'unknown', code: 'REPO_REF_OUTCOME_UNKNOWN' })
  await fx.storage.put(ATTEMPT, { ...await fx.storage.get(ATTEMPT), startedAt: Date.now() - 60001 })
  return { id, release: forgets => releaseCall(fx, p, id, forgets) }
}
async function releaseCall(fx, p, id, forgets) {
  const release = { action: 'release_attempt', attemptId: id, baseSha: p.baseSha, headSha: p.headSha, ...(forgets === undefined ? {} : { forgets }) }
  const binding = { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/repo', bodySha256: await digest(canonicalJson(release)) }
  return await fx.call({ action: 'release_attempt', release, binding, verification: { mainSha: p.baseSha, branchSha: p.headSha, treeSha: p.treeSha, checkedAt: Date.now(), headInMain: false } },
    { headers: { 'x-x6-class3-approval': APPROVAL } })
}

test('his A then C: both releases are kept by attempt id; A\'s late landing is reported merged after release, C stays released; old shapes kept', async () => {
  const exact = (value, required, optional = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  const oldOutcome = value => value === undefined || exact(value, ['attemptId', 'status', 'at', 'branch', 'baseSha', 'headSha', 'treeSha'], ['commitSha', 'code'])
    && ['succeeded', 'failed', 'unknown'].includes(value.status) && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code ?? 'X')
  const fx = await fixture(), a = await proposal('first', 'auma/proposal/aa'), c = await proposal('second', 'auma/proposal/cc')
  assert.notEqual(a.headSha, c.headSha)
  const first = await releasedAttempt(fx, a)
  assert.equal((await first.release()).status, 200)
  const second = await releasedAttempt(fx, c)
  const releasedC = await second.release()
  assert.equal(releasedC.status, 200, JSON.stringify(releasedC.body)); assert.equal(releasedC.body.released.attemptId, second.id)
  // Both kept, each under its own id; C's release overwrote nothing.
  const kept = await fx.storage.get(RELEASED)
  assert.deepEqual(Object.keys(kept).sort(), [first.id, second.id].sort())
  assert.equal(kept[first.id].headSha, a.headSha); assert.equal(kept[second.id].headSha, c.headSha)
  const listed = (await fx.status()).body
  assert.deepEqual(listed.repoMergeReleases.map(item => [item.attemptId, item.state]), [[first.id, 'void-by-owner'], [second.id, 'void-by-owner']])
  assert.equal(listed.repoMergeReleased.attemptId, second.id, 'the newest')
  assert.deepEqual((await fx.call({ action: 'inspect_released' })).body.releases.map(item => item.attemptId), [first.id, second.id])
  // A's delayed compare-and-set applies: main is A's head. C's head is not in it.
  const verification = (mainSha, headInMain) => ({ mainSha, branchSha: null, treeSha: a.treeSha, checkedAt: Date.now(), headInMain })
  const onC = await fx.call({ action: 'reconcile_released', attemptId: second.id, verification: verification(a.headSha, false) })
  assert.equal(onC.status, 200); assert.equal(onC.body.reconciled, false); assert.equal(onC.body.released.state, 'void-by-owner')
  const onA = await fx.call({ action: 'reconcile_released', attemptId: first.id, verification: verification(a.headSha, true) })
  assert.equal(onA.status, 200, JSON.stringify(onA.body)); assert.equal(onA.body.reconciled, true); assert.equal(onA.body.outcome.state, 'merged-after-release')
  const view = (await fx.status()).body
  assert.deepEqual(view.repoMergeReleases.map(item => [item.attemptId, item.state]), [[first.id, 'merged-after-release'], [second.id, 'void-by-owner']])
  // The last outcome is C's (the newer attempt) and stays C's: A's correction lives in A's own record.
  assert.equal(view.lastRepoMergeOutcome.attemptId, second.id); assert.equal(view.lastRepoMergeOutcome.code, 'REPO_ATTEMPT_VOID_BY_OWNER')
  // ROLLBACK: the records the build at an earlier commit reads keep their shapes, whatever is kept beside them.
  assert.equal(oldOutcome(await fx.storage.get(OUTCOME)), true); assert.equal(await fx.storage.get(ATTEMPT), undefined); assert.equal(await fx.storage.get(OWNER_KEY), undefined)
  for (const key of fx.storage.snapshot().keys()) assert.ok(!key.startsWith('head:repo-merge-released') || key === RELEASED, key)
})

test('the bound: at most four kept; the oldest RESOLVED one goes first; when all four are unresolved a new release is refused, its approval unspent', async () => {
  const fx = await fixture(), ids = []
  const make = async (index) => { const p = await proposal(`n${index}`, `auma/proposal/n${index}`); return { p: { ...p, headSha: String(index + 5).repeat(40), mergeBody: { ...p.mergeBody, headSha: String(index + 5).repeat(40) } } } }
  const fixed = async ({ p }) => { const binding = { ...p.binding, bodySha256: await digest(canonicalJson(p.mergeBody)) }; return { ...p, binding } }
  for (let index = 0; index < 4; index++) {
    const p = await fixed(await make(index)), held = await releasedAttempt(fx, p)
    assert.equal((await held.release()).status, 200); ids.push(held.id)
  }
  assert.equal(Object.keys(await fx.storage.get(RELEASED)).length, 4)
  // A fifth while all four are unresolved: refused with the reason, nothing spent or written, the attempt still held.
  const fifth = await fixed(await make(4)), held = await releasedAttempt(fx, fifth)
  const before = fx.storage.snapshot(), approvalsBefore = fx.approvals.calls.length
  const refused = await held.release()
  failure(refused, 409, 'REPO_RELEASE_LIMIT'); assert.equal(refused.body.limit, 4); assert.equal(refused.body.unresolved, 4)
  assert.match(refused.body.reason, /^4 merges released earlier are still unresolved \(GitHub has not shown them in main\)/)
  assert.deepEqual(fx.storage.snapshot(), before); assert.equal(fx.approvals.calls.length, approvalsBefore, 'his approval was not asked for')
  assert.equal((await fx.status()).body.repoMergeAttempt.attemptId, held.id)
  // The second one shows in main (resolved): the fifth release drops it, the oldest resolved, and keeps every unresolved one.
  const v = { mainSha: '9'.repeat(40), branchSha: null, treeSha: '4'.repeat(40), checkedAt: Date.now(), headInMain: true }
  assert.equal((await fx.call({ action: 'reconcile_released', attemptId: ids[1], verification: v })).body.reconciled, true)
  assert.equal((await fx.call({ action: 'reconcile_released', attemptId: ids[3], verification: v })).body.reconciled, true)
  assert.equal((await held.release()).status, 200)
  assert.deepEqual(Object.keys(await fx.storage.get(RELEASED)).sort(), [ids[0], ids[2], ids[3], held.id].sort())
})

test('at the bound with all four unresolved, a release whose passkey terms name the oldest one (forgets) drops it in the same transaction; the other three are kept', async () => {
  const fx = await fixture(), ids = [], heads = []
  const make = async index => { const p = await proposal(`f${index}`, `auma/proposal/f${index}`), headSha = 'abcdef'[index].repeat(40)
    const mergeBody = { ...p.mergeBody, headSha }; return { ...p, headSha, mergeBody, binding: { ...p.binding, bodySha256: await digest(canonicalJson(mergeBody)) } } }
  for (let index = 0; index < 4; index++) {
    const p = await make(index), held = await releasedAttempt(fx, p)
    assert.equal((await held.release()).status, 200); ids.push(held.id); heads.push(p.headSha)
  }
  // Released one after another (a millisecond apart at least), so "oldest" is ids[0] whatever the ids sort as.
  const kept = await fx.storage.get(RELEASED)
  await fx.storage.put(RELEASED, Object.fromEntries(ids.map((id, index) => [id, { ...kept[id], releasedAt: kept[ids[0]].releasedAt + index }])))
  const fifth = await make(4), held = await releasedAttempt(fx, fifth)
  // The refusal names the oldest unresolved release (its id, branch and head), so the card can show it and his passkey can name it.
  const refused = await held.release()
  failure(refused, 409, 'REPO_RELEASE_LIMIT')
  assert.deepEqual(refused.body.oldest, { attemptId: ids[0], branch: 'auma/proposal/f0', headSha: heads[0] })
  // Naming any other release, or one that is not kept, is refused before his approval is asked for; nothing is written.
  const before = fx.storage.snapshot(), approvalsBefore = fx.approvals.calls.length
  for (const other of [ids[1], ids[3], crypto.randomUUID()]) failure(await held.release(other), 409, 'REPO_RELEASE_FORGET_STALE')
  // Naming itself is malformed terms.
  failure(await held.release(held.id), 400, 'REPO_RELEASE_INVALID')
  assert.deepEqual(fx.storage.snapshot(), before); assert.equal(fx.approvals.calls.length, approvalsBefore, 'his approval was not asked for')
  // His release over terms that name the oldest: accepted; it is forgotten in the same transaction, and the other three are kept.
  const accepted = await held.release(ids[0])
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body)); assert.equal(accepted.body.outcome.state, 'void-by-owner')
  assert.equal(fx.approvals.calls.length, approvalsBefore + 1)
  assert.equal(fx.approvals.calls.at(-1).binding.bodySha256, await digest(canonicalJson({ action: 'release_attempt', attemptId: held.id, baseSha: fifth.baseSha, headSha: fifth.headSha, forgets: ids[0] })), 'his passkey signed the forget')
  assert.deepEqual(Object.keys(await fx.storage.get(RELEASED)).sort(), [ids[1], ids[2], ids[3], held.id].sort())
  for (const id of [ids[1], ids[2], ids[3]]) assert.equal((await fx.storage.get(RELEASED))[id].state, 'void-by-owner')
  assert.equal((await fx.status()).body.repoMergeAttempt, null, 'the merge loop is unlocked')
  // Below the bound, or with a resolved one to drop first, naming one to forget is refused: nothing is forgotten that need not be.
  const sixth = await make(5), next = await releasedAttempt(fx, sixth)
  const v = { mainSha: '9'.repeat(40), branchSha: null, treeSha: '4'.repeat(40), checkedAt: Date.now(), headInMain: true }
  assert.equal((await fx.call({ action: 'reconcile_released', attemptId: ids[2], verification: v })).body.reconciled, true)
  failure(await next.release(ids[1]), 409, 'REPO_RELEASE_FORGET_STALE')
  assert.equal((await next.release()).status, 200)
  assert.deepEqual(Object.keys(await fx.storage.get(RELEASED)).sort(), [ids[1], ids[3], held.id, next.id].sort())
})

test('Past the margin, an attempt still CLAIMED is void whatever main is (nothing was sent); a marked or dispatched one is not', async () => {
  const elsewhere = 'e'.repeat(40)
  for (const step of ['claimed', 'marked', 'dispatched']) {
    const fx = await fixture(), p = await proposal(step)
    await fx.stage(p)
    const id = (await fx.begin(p)).body.attemptId
    if (step !== 'claimed') await fx.call({ action: 'mark_merge', attemptId: id, owner: OWNER })
    if (step === 'dispatched') await fx.outcome(id, { status: 'unknown', code: 'REPO_REF_OUTCOME_UNKNOWN' })
    await fx.storage.put(ATTEMPT, { ...await fx.storage.get(ATTEMPT), startedAt: Date.now() - 60001 })
    const answer = (await fx.call({ action: 'reconcile_merge', attemptId: id, mergeBody: p.mergeBody, binding: p.binding,
      verification: { mainSha: elsewhere, branchSha: p.headSha, treeSha: p.treeSha, checkedAt: Date.now() } })).body
    if (step === 'claimed') {
      assert.equal(answer.reconciled, true); assert.equal(answer.outcome.code, 'REPO_APPROVAL_SPENT_VOID'); assert.equal(answer.outcome.state, 'void')
      assert.equal((await fx.status()).body.repoMergeAttempt, null); assert.equal(await fx.storage.get(OWNER_KEY), undefined)
    } else {
      assert.equal(answer.reconciled, false, step); assert.equal(answer.outcome.code, 'REPO_REF_OUTCOME_UNKNOWN', step)
      assert.equal((await fx.status()).body.repoMergeAttempt.state, step)
    }
  }
  // A legacy attempt (no owner record: it may have been sent) is never voided this way.
  const legacy = await fixture(), lp = await proposal('legacy')
  await legacy.stage(lp)
  const lid = (await legacy.begin(lp)).body.attemptId
  await legacy.storage.delete(OWNER_KEY)
  await legacy.storage.put(ATTEMPT, { ...await legacy.storage.get(ATTEMPT), startedAt: Date.now() - 60001 })
  const kept = (await legacy.call({ action: 'reconcile_merge', attemptId: lid, mergeBody: lp.mergeBody, binding: lp.binding,
    verification: { mainSha: elsewhere, branchSha: lp.headSha, treeSha: lp.treeSha, checkedAt: Date.now() } })).body
  assert.equal(kept.reconciled, false); assert.equal(kept.outcome.code, 'REPO_REF_OUTCOME_UNKNOWN')
  // Review: status and inspect_merge say what reconcile does (held, may have been sent), so the card offers Release.
  assert.equal((await legacy.status()).body.repoMergeAttempt.state, 'marked')
  assert.equal((await legacy.call({ action: 'inspect_merge' })).body.state, 'marked')
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
