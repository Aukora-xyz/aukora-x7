/** His tap on a green card answered 408 BROKER_TIMEOUT before his
 * approval was even used, because every read before it (the evidence, both workflows with their jobs, the repository id)
 * ran one after another inside the merge's single 10 s window. Now the reads have their own window (16 s, read
 * concurrently where independent, judged in today's order) and the window that protects him starts at begin_merge with
 * today's 10 s. Runs against the REAL HEAD durable object and a synthetic GitHub whose answers take real time, as
 * repo-merge-approval.test.mjs does. No network. Several cases take 10-26 s each: the windows are the real timers. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import * as brokers from '../cloud-brokers.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, REPO_MERGE_ACTION_DEADLINE_MS, canonicalBootstrap, manifestIdCanon } from '../head-do.mjs'

const { CLOUD_BROKER_LIMITS, MERGE_SETTLE_GRACE_MS, MERGE_AFTER_READS_RESERVE_MS, PROPOSAL_CI_NEXT, APPROVAL_SPENT_VOID_NEXT, handleCloudBroker } = brokers
/** The numbers this job sets, pinned here (the module's own constant is asserted equal below). */
const READ_WINDOW_MS = 16000, ACT_WINDOW_MS = 10000
const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), NEXT = 'c'.repeat(40), BASE_TREE = 'd'.repeat(40), HEAD_TREE = 'e'.repeat(40)
const BRANCH = 'auma/proposal/fixture-window', EMAIL = 'owner@fixture.example', FREE = 'deploy/cloudflare/src/crew-relay-tool.mjs'
const ATTEMPT = 'head:repo-merge-attempt', DOC = index => `docs/auma/merge1/f${String(index).padStart(2, '0')}.md`, ATTEMPT_OWNER = 'head:repo-merge-attempt-owner', OUTCOME = 'head:last-repo-merge-outcome'
const GATE_JOBS = ['preflight', 'build', 'scrub-dist', 'bundle']
const digest = value => createHash('sha256').update(value).digest('hex')
const blob = value => createHash('sha1').update(value).digest('hex')
const json = value => Response.json(value)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const refusal = (code, status = 403) => Object.assign(new Error(code), { code, status })

function tree(files, sha) {
  const entries = new Map()
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) { const parent = parts.slice(0, i).join('/'); entries.set(parent, { path: parent, mode: '040000', type: 'tree', sha: blob(parent + sha) }) }
    entries.set(path, { path, mode: '100644', type: 'blob', sha: blob(content), size: Buffer.byteLength(content) })
  }
  return { sha, truncated: false, tree: [...entries.values()] }
}

async function realHead() {
  let data = new Map(), tail = Promise.resolve()
  const view = map => ({ get: async key => structuredClone(map.get(key)), put: async (key, value) => { map.set(key, structuredClone(value)) }, delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit)), getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(data)[method](...args)]))
  storage.transaction = operation => { const task = tail.then(async () => { const next = structuredClone(data), result = await operation(view(next)); data = next; return result }); tail = task.catch(() => {}); return task }
  const env = { PUBLIC_HOST: 'fixture.example', OWNER_EMAIL: EMAIL, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), AUMLOK_CUSTODY_PEPPER: '22'.repeat(32) }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  head.broadcast = async () => {}
  const code = 'export const organ = "fixture";\n', sha = digest(code)
  const draft = { version: 'x6.1-ball/v1', epoch: 167, parentBallId: null, createdAt: '2026-11-11T00:00:00.000Z', authorPeerId: 'fixture-peer',
    entries: { 'seed-echo': { id: 'seed-echo', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } }, modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(code) } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }, payload = { version: BOOTSTRAP_VERSION, ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } }, seedId = digest(canonicalBootstrap(payload))
  assert.equal((await head.store.bootstrapPrepare({ ...payload, seedId })).ok, true)
  assert.equal((await head.store.bootstrapCommit(seedId, { ok: true, phase: 'ready', seedId, ballId: ball.ballId, epoch: 167, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  return { head, seedId, env, storage }
}

/** The broker over the real HEAD. `slow(url)` delays each GitHub answer; `ci` sets each workflow's conclusion;
 * `around(action, forward)` wraps each HEAD call; `begunAt` is when begin_merge left for HEAD. */
async function harness({ files = null } = {}) {
  const { head, seedId, env: headEnv, storage } = await realHead()
  const refs = new Map([['main', BASE], [BRANCH, HEAD]]), calls = [], actions = [], tokens = new Map()
  const state = { slow: () => 0, graphql: null, consumed: 0, around: null, begunAt: null, repoFails: false, ci: { 'proposal-gate.yml': 'success', 'proposal-checks.yml': 'success' }, checksMalformed: false }
  const access = { type: 'owner', email: EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 }
  const before = files?.before ?? { [FREE]: 'old\n' }, after = files?.after ?? { [FREE]: 'new\n' }
  head.aumlokStore = { consumeApprovalInTransaction: async (tx, token, binding, origin) => {
    const approval = tokens.get(token)
    if (!approval || canonicalJson(approval.binding) !== canonicalJson(binding) || origin !== ORIGIN || typeof tx?.put !== 'function') throw refusal('CLASS3_WEBAUTHN_REQUIRED')
    if (approval.expiresAt <= Date.now()) throw refusal('CLASS3_APPROVAL_EXPIRED')
    tokens.delete(token); state.consumed++
    return { ok: true, binding: approval.binding, approvalId: null, expiresAt: approval.expiresAt }
  } }
  const headBinding = { idFromName: name => name, get: () => ({ fetch: async request => {
    const { action } = request.method === 'POST' ? await request.clone().json() : { action: 'GET ' + new URL(request.url).pathname }
    if (request.method === 'POST') actions.push(action)
    if (action === 'begin_merge') state.begunAt = Date.now()
    const forward = () => head.fetch(request)
    return state.around ? await state.around(action, forward) : await forward()
  } }) }
  const env = { ...headEnv, GITHUB_TOKEN: 'synthetic-token-value', SOURCE_REVISION: BASE, HEAD: headBinding }
  const run = (workflow, id) => ({ id, workflow_id: id, run_number: 3, run_attempt: 1, head_sha: HEAD, head_branch: BRANCH, event: 'push', path: `.github/workflows/${workflow}`, status: 'completed', conclusion: state.ci[workflow] })
  const job = (name, runId, id) => ({ id, run_id: runId, head_sha: HEAD, name, status: 'completed', conclusion: 'success' })
  const networkFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl); calls.push({ url: rawUrl, path: url.pathname, method: init.method, at: Date.now(), after: actions.length, signal: init.signal })
    assert.equal(url.hostname, 'api.github.com')
    const delay = state.slow(url)
    if (delay) await sleep(delay)
    if (state.hook) { const answer = await state.hook(url, init); if (answer) return answer }
    if (url.pathname.endsWith('/actions/workflows/proposal-gate.yml/runs')) return json({ total_count: 1, workflow_runs: [run('proposal-gate.yml', 7)] })
    if (url.pathname.endsWith('/actions/workflows/proposal-checks.yml/runs')) return json(state.checksMalformed ? { total_count: 1, workflow_runs: [{ id: 8 }] } : { total_count: 1, workflow_runs: [run('proposal-checks.yml', 8)] })
    if (url.pathname.endsWith('/actions/runs/7/attempts/1/jobs')) return json({ total_count: 4, jobs: GATE_JOBS.map((name, index) => job(name, 7, 100 + index)) })
    if (url.pathname.endsWith('/actions/runs/8/attempts/1/jobs')) return json({ total_count: 1, jobs: [job('checks', 8, 200)] })
    if (url.pathname === '/graphql') {
      const input = JSON.parse(init.body).variables.input
      if (state.graphql) { const answer = await state.graphql(input, refs); if (answer) return answer }
      if (input.refUpdates.some(update => (refs.get(update.name.slice('refs/heads/'.length)) ?? '0'.repeat(40)) !== update.beforeOid)) return json({ data: { updateRefs: null }, errors: [{ type: 'STALE_DATA' }] })
      for (const update of input.refUpdates) refs.set(update.name.slice('refs/heads/'.length), update.afterOid)
      return json({ data: { updateRefs: { clientMutationId: input.clientMutationId } } })
    }
    if (url.pathname === PREFIX) return state.repoFails ? new Response('', { status: 500 }) : json({ full_name: 'your_org_x/your-node', default_branch: 'main', node_id: 'R_fixture' })
    if (url.pathname.startsWith(PREFIX + '/git/ref/heads/')) {
      const branch = decodeURIComponent(url.pathname.slice((PREFIX + '/git/ref/heads/').length)), sha = refs.get(branch)
      return sha ? json({ ref: 'refs/heads/' + branch, object: { type: 'commit', sha } }) : new Response('', { status: 404 })
    }
    if (url.pathname === PREFIX + '/commits' && url.search === '?sha=main&per_page=1') return json([{ sha: refs.get('main'), commit: { message: 'Base' }, parents: [] }])
    if (url.pathname.includes('/compare/')) {
      const [base, tip] = url.pathname.split('/compare/')[1].split('...')
      return json({ base_commit: { sha: base }, merge_base_commit: { sha: base }, ahead_by: base === tip ? 0 : 1, behind_by: 0, status: base === tip ? 'identical' : 'ahead', files: [] })
    }
    if (url.pathname.startsWith(PREFIX + '/commits/')) {
      const ref = decodeURIComponent(url.pathname.slice((PREFIX + '/commits/').length)), sha = refs.get(ref) ?? ref
      return json({ sha, commit: { tree: { sha: sha === BASE ? BASE_TREE : HEAD_TREE } } })
    }
    if (url.pathname.startsWith(PREFIX + '/git/trees/')) { const sha = url.pathname.split('/').at(-1); return json(tree(sha === BASE_TREE ? before : after, sha)) }
    if (url.pathname.startsWith(PREFIX + '/contents/')) {
      if (state.contentsFail) return new Response('', { status: 500 })
      const path = decodeURIComponent(url.pathname.slice((PREFIX + '/contents/').length)), content = (url.searchParams.get('ref') === BASE ? before : after)[path]
      if (content === undefined) return new Response('', { status: 404 })
      return json({ type: 'file', path, sha: blob(content), encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    throw new Error('Unexpected synthetic URL ' + url.pathname)
  }
  const request = async (input, { token, signal } = {}) => {
    const current = new Request(ORIGIN + '/_host/repo', { method: 'POST', ...(signal ? { signal } : {}), headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(token ? { 'x-x6-class3-approval': token } : {}) }, body: JSON.stringify(input) })
    const response = await handleCloudBroker(current, env, { access, bootstrap: { ready: true, head: { phase: 'complete', seedId }, mirror: { phase: 'ready' } }, now: () => Date.now(), networkFetch,
      authorizeClass3: async () => ({ ok: false }) })
    return { status: response.status, value: await response.json() }
  }
  const status = async () => await (await head.fetch(new Request('https://x61.internal/_head/promotion-status', { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, 'x-x6-verified-access': JSON.stringify(access) } }))).json()
  let issued = 0
  const grant = input => {
    const token = 'fixture-approval-' + ++issued
    tokens.set(token, { expiresAt: Date.now() + 120000, binding: { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/repo', bodySha256: digest(canonicalJson(input)) } })
    return token
  }
  const staged = await request({ action: 'stage_proposal', branch: BRANCH, title: 'Read window fixture' })
  assert.equal(staged.status, 200, JSON.stringify(staged.value))
  calls.length = 0; actions.length = 0
  const posts = () => calls.filter(call => call.method === 'POST').length
  /** Nothing of his was spent and HEAD holds nothing: read from HEAD's own storage and the approval store. */
  const unspent = async token => {
    assert.equal(state.consumed, 0, 'no approval consumed'); assert.equal(tokens.has(token), true, 'his approval is still there')
    assert.equal(await storage.get(ATTEMPT), undefined, 'HEAD holds no attempt'); assert.equal(await storage.get(ATTEMPT_OWNER), undefined)
    assert.equal(await storage.get(OUTCOME), undefined, 'no outcome written'); assert.equal(actions.includes('begin_merge'), false)
    assert.equal(posts(), 0, 'nothing sent'); assert.equal(refs.get('main'), BASE, 'main did not move')
  }
  return { state, refs, calls, actions, tokens, request, status, grant, posts, storage, access, before, after, unspent, mergeBody: staged.value.proposal.mergeBody }
}

test('the read window, the act window and the settle grace fit the broker\'s 30 s; the act window is HEAD\'s 10 s, unchanged', () => {
  assert.equal(brokers.MERGE_READ_WINDOW_MS, READ_WINDOW_MS)
  assert.equal(CLOUD_BROKER_LIMITS.mergeTimeoutMs, ACT_WINDOW_MS); assert.equal(REPO_MERGE_ACTION_DEADLINE_MS, ACT_WINDOW_MS)
  assert.equal(CLOUD_BROKER_LIMITS.timeoutMs, 30000)
  assert.ok(READ_WINDOW_MS + ACT_WINDOW_MS + MERGE_SETTLE_GRACE_MS <= CLOUD_BROKER_LIMITS.timeoutMs)
  assert.ok(MERGE_AFTER_READS_RESERVE_MS <= ACT_WINDOW_MS, 'a full act window always leaves the reserve')
})

test('reads that take 9.4 s one after another (the four workflow reads 1.7 s each, as when CI is green; both sides of the file 1 s) take under 5 s together; the merge succeeds and no read is dropped', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody)
  const delay = url => url.pathname.includes('/actions/') ? 1700 : url.pathname.includes('/contents/') ? 1000 : 60
  fx.state.slow = delay
  const started = Date.now(), result = await fx.request(fx.mergeBody, { token }), took = Date.now() - started
  assert.equal(result.status, 200, JSON.stringify(result.value)); assert.equal(fx.refs.get('main'), HEAD); assert.equal(fx.state.consumed, 1)
  const reads = fx.calls.filter(call => call.method === 'GET' && call.after < fx.actions.indexOf('begin_merge') + 1)
  const sequential = reads.reduce((total, call) => total + delay(new URL(call.url)), 0)
  assert.ok(sequential >= 9000, `sequential would take ${sequential} ms`)
  assert.ok(took < 5000, `took ${took} ms`)
  // Every read of today is still made: both refs, the comparison, both commits and trees, both sides of the file, both
  // workflows' runs and jobs, the repository; and both refs once more, last.
  const paths = new Set(reads.map(call => call.path.slice(PREFIX.length)))
  for (const path of ['/git/ref/heads/main', '/git/ref/heads/' + BRANCH, `/compare/${BASE}...${HEAD}`, `/commits/${BASE}`, `/commits/${HEAD}`, `/git/trees/${BASE_TREE}`, `/git/trees/${HEAD_TREE}`,
    '/contents/' + FREE, '/actions/workflows/proposal-gate.yml/runs', '/actions/workflows/proposal-checks.yml/runs', '/actions/runs/7/attempts/1/jobs', '/actions/runs/8/attempts/1/jobs', '']) {
    assert.ok(paths.has(path), `read ${path || 'repository'}: ${[...paths].join(', ')}`)
  }
  assert.equal(reads.filter(call => call.path.endsWith('/contents/' + FREE)).length, 2, 'both sides of the changed file')
  assert.equal(reads.filter(call => call.path.endsWith('/git/ref/heads/' + BRANCH)).length, 2, 'the branch read first and last')
  // The trees one after another (memory): the head tree is asked for only after the base tree answered.
  const at = path => reads.find(call => call.path.endsWith(path))
  assert.ok(at(`/commits/${HEAD}`).at >= at(`/git/trees/${BASE_TREE}`).at + 50, 'the head tree waits for the base tree')
})

test('reads past the read window answer 408 phase reads, approval unspent, main unmoved, HEAD holds nothing; the same approval merges later', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody)
  fx.state.slow = url => url.pathname.endsWith('/proposal-checks.yml/runs') ? READ_WINDOW_MS + 1000 : 0
  const started = Date.now(), result = await fx.request(fx.mergeBody, { token }), took = Date.now() - started
  assert.equal(result.status, 408, JSON.stringify(result.value)); assert.equal(result.value.code, 'BROKER_TIMEOUT')
  assert.equal(result.value.phase, 'reads'); assert.equal(result.value.approvalSpent, false); assert.equal(result.value.mainMoved, false)
  assert.equal(result.value.outcome, undefined, 'a definite answer'); assert.equal(result.value.requiresFreshClass3Approval, undefined)
  assert.ok(took >= READ_WINDOW_MS - 50 && took < READ_WINDOW_MS + 1500, `took ${took} ms`)
  await fx.unspent(token)
  assert.equal((await fx.status()).repoMergeAttempt, null)
  fx.state.slow = () => 0
  const merged = await fx.request(fx.mergeBody, { token })
  assert.equal(merged.status, 200, JSON.stringify(merged.value)); assert.equal(fx.refs.get('main'), HEAD); assert.equal(fx.state.consumed, 1)
})

test('reads of 15.7 s, a ref update that never answers, bookkeeping that never resolves: the act window is a full 10 s from begin_merge, the answer is the unknown outcome inside 30 s, never 200', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody)
  fx.state.slow = url => url.pathname.endsWith('/proposal-checks.yml/runs') ? 15700 : 0
  fx.state.graphql = () => new Promise(() => {})
  fx.state.around = async (action, forward) => action === 'merge_outcome' ? await new Promise(() => {}) : await forward()
  const started = Date.now(), result = await fx.request(fx.mergeBody, { token }), ended = Date.now()
  assert.notEqual(result.status, 200)
  assert.equal(result.value.code, 'REPO_REF_OUTCOME_UNKNOWN', JSON.stringify(result.value)); assert.equal(result.value.outcome, 'unknown')
  assert.equal(result.value.phase, undefined, 'after begin_merge the answer is never the reads one')
  const act = ended - fx.state.begunAt
  assert.ok(fx.state.begunAt - started >= 15600, `begin_merge at ${fx.state.begunAt - started} ms`)
  assert.ok(act >= ACT_WINDOW_MS - 150 && act < ACT_WINDOW_MS + MERGE_SETTLE_GRACE_MS, `act window ${act} ms`)
  assert.ok(ended - started <= CLOUD_BROKER_LIMITS.timeoutMs + 250, `whole call ${ended - started} ms`)
  assert.equal(fx.state.consumed, 1); assert.equal(fx.posts(), 1); assert.equal(fx.refs.get('main'), BASE)
  const view = await fx.status()
  assert.equal(view.repoMergeAttempt.state, 'marked', 'sent with its outcome unknown: held, never settled as success')
  assert.notEqual(view.lastRepoMergeOutcome?.status, 'succeeded')
})

test('after slow reads a mark answered past the act window is settled void in the same call, 10 s after begin_merge, nothing sent', async () => {
  const fx = await harness()
  fx.state.slow = url => url.pathname.includes('/actions/') ? 1500 : 0
  fx.state.around = async (action, forward) => { const response = await forward(); if (action === 'mark_merge') await sleep(ACT_WINDOW_MS + 300); return response }
  const result = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) }), act = Date.now() - fx.state.begunAt
  assert.equal(result.status, 409, JSON.stringify(result.value)); assert.equal(result.value.code, 'REPO_APPROVAL_SPENT_VOID'); assert.equal(result.value.next, APPROVAL_SPENT_VOID_NEXT)
  assert.ok(act >= ACT_WINDOW_MS - 100 && act < ACT_WINDOW_MS + MERGE_SETTLE_GRACE_MS, `act window ${act} ms`)
  assert.equal(fx.posts(), 0); assert.equal(fx.refs.get('main'), BASE)
  const view = await fx.status()
  assert.equal(view.repoMergeAttempt, null); assert.equal(view.lastRepoMergeOutcome.code, 'REPO_APPROVAL_SPENT_VOID')
})

test('judged in today\'s order: a moved branch or main and a refused path before any workflow or file read; a failed file read before a red workflow; a red workflow before the repository; all unspent', async () => {
  // The red workflow answers at once and the evidence slowly: the order of judgements is not the order of answers.
  const slowEvidence = url => url.pathname.includes('/actions/') ? 0 : 150
  for (const moved of [BRANCH, 'main']) {
    const fx = await harness(), token = fx.grant(fx.mergeBody)
    fx.state.slow = slowEvidence; fx.state.ci['proposal-gate.yml'] = 'failure'; fx.refs.set(moved, NEXT)
    const result = await fx.request(fx.mergeBody, { token })
    assert.equal(result.status, 409, JSON.stringify(result.value)); assert.equal(result.value.code, 'REPO_HEAD_CONFLICT')
    assert.equal(fx.calls.some(call => call.path.includes('/actions/') || call.path.includes('/contents/')), false, 'no workflow or file read, as today')
    fx.refs.set(moved, moved === 'main' ? BASE : HEAD)
    await fx.unspent(token)
  }
  {
    const fx = await harness(), token = fx.grant(fx.mergeBody)
    fx.state.slow = slowEvidence; fx.state.ci['proposal-checks.yml'] = 'failure'
    fx.after['.github/workflows/fixture.yml'] = 'on: push\n'
    const result = await fx.request(fx.mergeBody, { token })
    assert.equal(result.status, 403, JSON.stringify(result.value)); assert.equal(result.value.code, 'REPO_PROPOSAL_PATH_REFUSED')
    assert.equal(fx.calls.some(call => call.path.includes('/actions/') || call.path.includes('/contents/')), false, 'no workflow or file read, as today')
    await fx.unspent(token)
  }
  {
    // A file read that fails slowly is judged before a red workflow that answered at once.
    const fx = await harness(), token = fx.grant(fx.mergeBody)
    fx.state.slow = slowEvidence; fx.state.ci['proposal-gate.yml'] = 'failure'; fx.state.contentsFail = true
    const result = await fx.request(fx.mergeBody, { token })
    assert.equal(result.status, 502, JSON.stringify(result.value)); assert.equal(result.value.code, 'BROKER_UPSTREAM_FAILED')
    await fx.unspent(token)
  }
  {
    const fx = await harness(), token = fx.grant(fx.mergeBody)
    fx.state.ci['proposal-checks.yml'] = 'failure'; fx.state.repoFails = true
    const result = await fx.request(fx.mergeBody, { token })
    assert.equal(result.status, 409, JSON.stringify(result.value)); assert.equal(result.value.code, 'REPO_PROPOSAL_CI_NOT_PASSED')
    assert.equal(fx.calls.filter(call => call.path.endsWith('/contents/' + FREE)).length, 2, 'every file was read before the red workflow was judged')
    assert.equal(result.value.ciStatus, 'failed'); assert.equal(result.value.next, PROPOSAL_CI_NEXT)
    await fx.unspent(token)
  }
  {
    // A failed gate is the answer even when the checks workflow's answer is malformed (today the checks were never read).
    const fx = await harness(), token = fx.grant(fx.mergeBody)
    fx.state.ci['proposal-gate.yml'] = 'failure'; fx.state.checksMalformed = true
    const result = await fx.request(fx.mergeBody, { token })
    assert.equal(result.value.code, 'REPO_PROPOSAL_CI_NOT_PASSED', JSON.stringify(result.value)); assert.equal(result.value.ciStatus, 'failed')
    await fx.unspent(token)
  }
  {
    // Still pending: refused with its state, unspent.
    const fx = await harness(), token = fx.grant(fx.mergeBody)
    fx.state.ci['proposal-checks.yml'] = null
    const result = await fx.request(fx.mergeBody, { token })
    assert.equal(result.value.code, 'REPO_PROPOSAL_CI_NOT_PASSED', JSON.stringify(result.value))
    await fx.unspent(token)
  }
})

test('a session that would end inside the windows is refused before any read, with the closed code; one that outlasts them merges', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody)
  fx.access.expires = Math.floor((Date.now() + 20000) / 1000)
  const result = await fx.request(fx.mergeBody, { token })
  assert.equal(result.status, 403, JSON.stringify(result.value)); assert.equal(result.value.code, 'OWNER_SESSION_REQUIRED')
  assert.equal(fx.calls.length, 0, 'no GitHub read'); assert.deepEqual(fx.actions, [], 'no HEAD read')
  await fx.unspent(token)
  fx.access.expires = Math.floor((Date.now() + READ_WINDOW_MS + ACT_WINDOW_MS + MERGE_SETTLE_GRACE_MS + 5000) / 1000)
  const merged = await fx.request(fx.mergeBody, { token })
  assert.equal(merged.status, 200, JSON.stringify(merged.value)); assert.equal(fx.refs.get('main'), HEAD)
})

test('main moves 5 s into slow workflow reads: refused REPO_HEAD_CONFLICT at the last read, unspent, HEAD holds nothing, no ref update sent', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody)
  fx.state.slow = url => url.pathname.endsWith('/proposal-checks.yml/runs') ? 7000 : 0
  const moved = setTimeout(() => fx.refs.set('main', NEXT), 5000)
  const result = await fx.request(fx.mergeBody, { token })
  clearTimeout(moved)
  assert.equal(result.status, 409, JSON.stringify(result.value)); assert.equal(result.value.code, 'REPO_HEAD_CONFLICT')
  fx.refs.set('main', BASE)
  await fx.unspent(token)
  assert.equal(fx.calls.filter(call => call.path.endsWith('/git/ref/heads/main')).length, 2, 'main read at the start and again last')
})

test('a timeout while this call reconciles an EARLIER attempt carries no reads facts (that attempt may have moved main)', async () => {
  const fx = await harness()
  // The earlier attempt: its ref update landed, its answer was lost; it is held, dispatched, with main at its head.
  fx.state.graphql = async (input, refs) => { for (const update of input.refUpdates) refs.set(update.name.slice('refs/heads/'.length), update.afterOid); return json({ data: null, errors: [{ type: 'INTERNAL' }] }) }
  assert.equal((await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })).value.code, 'REPO_REF_OUTCOME_UNKNOWN')
  fx.state.graphql = null
  assert.equal((await fx.status()).repoMergeAttempt.state, 'dispatched'); assert.equal(fx.refs.get('main'), HEAD)
  // Reconciling it reads GitHub; that read runs past the read window.
  fx.state.slow = url => url.pathname.endsWith(`/commits/${HEAD}`) ? READ_WINDOW_MS + 1000 : 0
  const token = fx.grant(fx.mergeBody), result = await fx.request(fx.mergeBody, { token })
  assert.equal(result.status, 408, JSON.stringify(result.value)); assert.equal(result.value.code, 'BROKER_TIMEOUT')
  for (const key of ['phase', 'approvalSpent', 'mainMoved']) assert.equal(Object.hasOwn(result.value, key), false, key)
  assert.equal(fx.tokens.has(token), true); assert.equal(fx.state.consumed, 1)
})

test('the call\'s signal aborts at the last read: 408 with the reads facts, no begin_merge, HEAD\'s storage empty, approval unspent', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody), controller = new AbortController()
  let mainReads = 0
  fx.state.hook = url => { if (url.pathname.endsWith('/git/ref/heads/main') && ++mainReads === 2) controller.abort() }
  const result = await fx.request(fx.mergeBody, { token, signal: controller.signal })
  assert.equal(result.status, 408, JSON.stringify(result.value)); assert.equal(result.value.code, 'BROKER_TIMEOUT')
  assert.equal(result.value.phase, 'reads'); assert.equal(result.value.approvalSpent, false); assert.equal(result.value.mainMoved, false)
  assert.equal(mainReads, 2)
  await fx.unspent(token)
})

test('sixteen changed files through the read-ahead: each read exactly twice; one that pushes the byte bound over answers 413, unspent, no file read twice', async () => {
  const before = {}, after = {}
  for (let index = 1; index <= 16; index++) { before[DOC(index)] = `old ${index}\n`; after[DOC(index)] = `new ${index}\n` }
  const fx = await harness({ files: { before, after } }), token = fx.grant(fx.mergeBody)
  const merged = await fx.request(fx.mergeBody, { token })
  assert.equal(merged.status, 200, JSON.stringify(merged.value))
  for (let index = 1; index <= 16; index++) assert.equal(fx.calls.filter(call => call.path.endsWith('/contents/' + DOC(index))).length, 2, DOC(index))
  // Over the bound: each head side is 400 KiB; the 11th file passes 4 MiB.
  const big = await harness({ files: { before: { ...before }, after: { ...after } } }), spend = big.grant(big.mergeBody)
  for (let index = 1; index <= 16; index++) big.after[DOC(index)] = ('x'.repeat(1023) + '\n').repeat(400)
  const refused = await big.request(big.mergeBody, { token: spend })
  assert.equal(refused.status, 413, JSON.stringify(refused.value)); assert.equal(refused.value.code, 'REPO_PROPOSAL_TOO_LARGE')
  await big.unspent(spend)
  const counts = Array.from({ length: 16 }, (_, index) => big.calls.filter(call => call.path.endsWith('/contents/' + DOC(index + 1))).length)
  assert.ok(counts.every(count => count <= 2), JSON.stringify(counts)); assert.ok(counts.reduce((a, b) => a + b, 0) <= (11 + 4) * 2, JSON.stringify(counts))
  assert.equal(big.calls.some(call => call.path.includes('/actions/')), true, 'the workflows ran beside the files')
})

test('a read that rejects while siblings are in flight: the pending reads are aborted, and the order of judgements decides the code', async () => {
  // The checks workflow fails at once; a file answer is malformed later: the file is judged first.
  const fx = await harness(), token = fx.grant(fx.mergeBody)
  fx.state.slow = url => url.pathname.includes('/contents/') ? 300 : url.pathname === PREFIX ? 5000 : 0
  fx.state.hook = url => url.pathname.endsWith('/proposal-checks.yml/runs') ? new Response('', { status: 500 })
    : url.pathname.includes('/contents/') ? json({ type: 'file', path: 'other', sha: 'f'.repeat(40), encoding: 'base64', content: '' }) : undefined
  const started = Date.now(), first = await fx.request(fx.mergeBody, { token })
  assert.equal(first.status, 502, JSON.stringify(first.value)); assert.equal(first.value.code, 'BROKER_CONTENT_INVALID')
  assert.ok(Date.now() - started < 2500, 'the slow repository read did not hold the answer')
  assert.equal(fx.calls.find(call => call.path === PREFIX).signal.aborted, true, 'the pending repository read was aborted')
  await fx.unspent(token)
  // With the files good, the rejected workflow read is the answer, and the pending repository read is aborted too.
  const again = await harness(), spend = again.grant(again.mergeBody)
  again.state.slow = url => url.pathname === PREFIX ? 5000 : 0
  again.state.hook = url => url.pathname.endsWith('/proposal-checks.yml/runs') ? new Response('', { status: 500 }) : undefined
  const second = await again.request(again.mergeBody, { token: spend })
  assert.equal(second.status, 502, JSON.stringify(second.value)); assert.equal(second.value.code, 'BROKER_UPSTREAM_FAILED')
  assert.equal(again.calls.find(call => call.path === PREFIX).signal.aborted, true)
  await again.unspent(spend)
})

test('through the REAL HEAD, a reload\'s sync while a card can still merge commits nothing and says so', async () => {
  const fx = await harness()
  const result = await fx.request({ action: 'sync_head_to_github' })
  assert.equal(result.status, 200, JSON.stringify(result.value))
  assert.deepEqual(result.value, { ok: true, action: 'sync_head_to_github', deferred: true, code: 'SYNC_HELD_FOR_STAGED_PROPOSAL', branch: 'main' })
  assert.equal(fx.posts(), 0); assert.equal(fx.refs.get('main'), BASE)
  assert.notEqual((await fx.status()).stagedRepoProposal, null)
  // The card still merges.
  const merged = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(merged.status, 200, JSON.stringify(merged.value)); assert.equal(fx.refs.get('main'), HEAD)
})
