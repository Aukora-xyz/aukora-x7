/** MUST 5 and MUST 3 and 4: no approval is spent before every read is done; the approval and the attempt
 * are one thing, owned in HEAD; and every exit after consumption ends truthfully. The merge runs against the REAL HEAD
 * durable object (begin_merge consumes his approval in its own storage transaction; mark_merge, merge_outcome,
 * inspect_merge and reconcile_merge are its bookkeeping) and a synthetic GitHub whose answers can be slowed. AUMLOK needs
 * a passkey ceremony, so a single-use synthetic approval store stands in for it inside that transaction. HEAD's calls can
 * be held, slowed or have their answers lost. The broker's own ten-second deadline is the real timer, so two cases take
 * about ten seconds each. No network: every provider answer is fixed here.
 *
 * Each row of the outside review's exit table ("After consumption, the merge exits are") has a test
 * that names it: "exit row 1" .. "exit row 7". */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { APPROVAL_SPENT_VOID_NEXT, CLOUD_BROKER_LIMITS, MERGE_SETTLE_GRACE_MS, RELEASE_ATTEMPT_NEXT, handleCloudBroker } from '../cloud-brokers.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, REPO_MERGE_ACTION_DEADLINE_MS, REPO_MERGE_RECONCILE_AFTER_MS, canonicalBootstrap, manifestIdCanon } from '../head-do.mjs'

const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), NEXT = 'c'.repeat(40), BASE_TREE = 'd'.repeat(40), HEAD_TREE = 'e'.repeat(40)
// An open path (deploy/** is closed by default; her own folder is not).
const BRANCH = 'auma/proposal/fixture-approval', EMAIL = 'owner@fixture.example', FREE = 'deploy/cloudflare/src/crew-relay-tool.mjs'
const ATTEMPT = 'head:repo-merge-attempt'
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

/** The real HEAD object, bootstrapped the way repo-brokers.test.mjs does it, in memory. */
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

/**
 * The broker over the real HEAD. `slow(url)` gives each GitHub answer its delay in ms; `onAuthorize` runs while HEAD
 * consumes his approval (inside its transaction); `graphql` may answer the ref update itself; `around(action, forward)`
 * wraps each call to HEAD (hold it, slow it, lose its answer). `actions` lists HEAD's actions in order, `calls` GitHub's.
 */
async function harness() {
  const { head, seedId, env: headEnv, storage } = await realHead()
  const refs = new Map([['main', BASE], [BRANCH, HEAD]]), calls = [], actions = [], tokens = new Map()
  const state = { slow: () => 0, onAuthorize: null, graphql: null, consumed: 0, brokerAuthorize: 0, around: null }
  const access = { type: 'owner', email: EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 }
  const before = { [FREE]: 'old\n' }, after = { [FREE]: 'new\n' }
  // The approval store HEAD consumes from, single use, checked against the binding begin_merge claims.
  head.aumlokStore = { consumeApprovalInTransaction: async (tx, token, binding, origin) => {
    const approval = tokens.get(token)
    if (!approval || canonicalJson(approval.binding) !== canonicalJson(binding) || origin !== ORIGIN || typeof tx?.put !== 'function') throw refusal('CLASS3_WEBAUTHN_REQUIRED')
    const expiresAt = approval.ttlAfterConsumption === undefined ? approval.expiresAt : Date.now() + approval.ttlAfterConsumption
    if (expiresAt <= Date.now()) throw refusal('CLASS3_APPROVAL_EXPIRED')
    tokens.delete(token); state.consumed++
    if (state.onAuthorize) await state.onAuthorize(refs)
    return { ok: true, binding: approval.binding, approvalId: null, expiresAt }
  } }
  const headBinding = { idFromName: name => name, get: () => ({ fetch: async request => {
    const { action } = await request.clone().json()
    actions.push(action)
    const forward = () => head.fetch(request)
    return state.around ? await state.around(action, forward) : await forward()
  } }) }
  const env = { ...headEnv, GITHUB_TOKEN: 'synthetic-token-value', SOURCE_REVISION: BASE, HEAD: headBinding }
  const run = (workflow, id) => ({ id, workflow_id: id, run_number: 3, run_attempt: 1, head_sha: HEAD, head_branch: BRANCH, event: 'push', path: `.github/workflows/${workflow}`, status: 'completed', conclusion: 'success' })
  const job = (name, runId, id) => ({ id, run_id: runId, head_sha: HEAD, name, status: 'completed', conclusion: 'success' })
  const networkFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl); calls.push({ url: rawUrl, method: init.method, at: Date.now(), after: actions.length })
    assert.equal(url.hostname, 'api.github.com')
    const delay = state.slow(url)
    if (delay) await sleep(delay)
    if (url.pathname.endsWith('/actions/workflows/proposal-gate.yml/runs')) return json({ total_count: 1, workflow_runs: [run('proposal-gate.yml', 7)] })
    if (url.pathname.endsWith('/actions/workflows/proposal-checks.yml/runs')) return json({ total_count: 1, workflow_runs: [run('proposal-checks.yml', 8)] })
    if (url.pathname.endsWith('/actions/runs/7/attempts/1/jobs')) return json({ total_count: 4, jobs: GATE_JOBS.map((name, index) => job(name, 7, 100 + index)) })
    if (url.pathname.endsWith('/actions/runs/8/attempts/1/jobs')) return json({ total_count: 1, jobs: [job('checks', 8, 200)] })
    if (url.pathname === '/graphql') {
      const input = JSON.parse(init.body).variables.input
      if (state.graphql) { const answer = await state.graphql(input, refs); if (answer) return answer }
      if (input.refUpdates.some(update => (refs.get(update.name.slice('refs/heads/'.length)) ?? '0'.repeat(40)) !== update.beforeOid)) return json({ data: { updateRefs: null }, errors: [{ type: 'STALE_DATA' }] })
      for (const update of input.refUpdates) refs.set(update.name.slice('refs/heads/'.length), update.afterOid)
      return json({ data: { updateRefs: { clientMutationId: input.clientMutationId } } })
    }
    if (url.pathname === PREFIX) return json({ full_name: 'your_org_x/your-node', default_branch: 'main', node_id: 'R_fixture' })
    if (url.pathname.startsWith(PREFIX + '/git/ref/heads/')) {
      const branch = decodeURIComponent(url.pathname.slice((PREFIX + '/git/ref/heads/').length)), sha = refs.get(branch)
      return sha ? json({ ref: 'refs/heads/' + branch, object: { type: 'commit', sha } }) : new Response('', { status: 404 })
    }
    if (url.pathname.includes('/compare/')) {
      const [base, tip] = url.pathname.split('/compare/')[1].split('...')
      // SHOULD 1: a test may say the head is NOT in main (diverged), or make the compare fail.
      if (state.compare) { const answer = await state.compare(base, tip); if (answer) return answer }
      return json({ base_commit: { sha: base }, merge_base_commit: { sha: base }, ahead_by: base === tip ? 0 : 1, behind_by: 0, status: base === tip ? 'identical' : 'ahead', files: [] })
    }
    if (url.pathname.startsWith(PREFIX + '/commits/')) {
      const ref = decodeURIComponent(url.pathname.slice((PREFIX + '/commits/').length)), sha = refs.get(ref) ?? ref
      return json({ sha, commit: { tree: { sha: sha === BASE ? BASE_TREE : HEAD_TREE } } })
    }
    if (url.pathname.startsWith(PREFIX + '/git/trees/')) { const sha = url.pathname.split('/').at(-1); return json(tree(sha === BASE_TREE ? before : after, sha)) }
    if (url.pathname.startsWith(PREFIX + '/contents/')) {
      const path = decodeURIComponent(url.pathname.slice((PREFIX + '/contents/').length)), content = (url.searchParams.get('ref') === BASE ? before : after)[path]
      if (content === undefined) return new Response('', { status: 404 })
      return json({ type: 'file', path, sha: blob(content), encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    throw new Error('Unexpected synthetic URL ' + url.pathname)
  }
  const request = async (input, { token } = {}) => {
    const current = new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(token ? { 'x-x6-class3-approval': token } : {}) }, body: JSON.stringify(input) })
    // The Worker's own consumer is still handed in; a merge never uses it (HEAD consumes), so it only counts.
    const response = await handleCloudBroker(current, env, { access, bootstrap: { ready: true, head: { phase: 'complete', seedId }, mirror: { phase: 'ready' } }, now: () => Date.now(), networkFetch,
      authorizeClass3: async () => { state.brokerAuthorize++; return { ok: false } } })
    return { status: response.status, value: await response.json() }
  }
  const status = async () => await (await head.fetch(new Request('https://x61.internal/_head/promotion-status', { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, 'x-x6-verified-access': JSON.stringify(access) } }))).json()
  let issued = 0
  const grant = (input, options = {}) => {
    const token = 'fixture-approval-' + ++issued
    tokens.set(token, { expiresAt: Date.now() + 120000, ...options, binding: { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/repo', bodySha256: digest(canonicalJson(input)) } })
    return token
  }
  /** Make the held attempt older than HEAD's deadline plus margin. */
  const age = async () => { const attempt = await storage.get(ATTEMPT); await storage.put(ATTEMPT, { ...attempt, startedAt: Date.now() - REPO_MERGE_RECONCILE_AFTER_MS - 1 }) }
  const staged = await request({ action: 'stage_proposal', branch: BRANCH, title: 'Approval fixture' })
  assert.equal(staged.status, 200, JSON.stringify(staged.value))
  const posts = () => calls.filter(call => call.method === 'POST').length
  actions.length = 0
  /** MUST 4: the owner's release of the held attempt, over its own exact terms. */
  const releaseBody = async () => { const held = (await status()).repoMergeAttempt; return { action: 'release_attempt', attemptId: held.attemptId, baseSha: held.baseSha, headSha: held.headSha } }
  return { state, refs, calls, actions, tokens, request, status, grant, posts, age, storage, access, releaseBody, mergeBody: staged.value.proposal.mergeBody }
}

/** A gate a test opens by hand. */
function gate() { let open; const opened = new Promise(resolve => { open = resolve }); return { opened, open } }

test('HEAD\'s merge deadline is the broker\'s deadline; the margin is stated', () => {
  assert.equal(REPO_MERGE_ACTION_DEADLINE_MS, CLOUD_BROKER_LIMITS.timeoutMs)
  assert.equal(REPO_MERGE_RECONCILE_AFTER_MS, 60000)
})

test('the outside review\'s timing (each checks answer 4.45 s, every other 100 ms) times out in the reads: nothing claimed, nothing spent', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody)
  fx.state.slow = url => url.pathname.includes('proposal-checks.yml') || url.pathname.includes('/actions/runs/8/') ? 4450 : 100
  const started = Date.now(), result = await fx.request(fx.mergeBody, { token })
  assert.equal(result.status, 408, JSON.stringify(result.value)); assert.equal(result.value.code, 'BROKER_TIMEOUT')
  assert.ok(Date.now() - started < 11000)
  assert.equal(fx.state.consumed, 0); assert.equal(fx.posts(), 0); assert.equal(fx.refs.get('main'), BASE)
  assert.equal(fx.actions.includes('begin_merge'), false); assert.equal((await fx.status()).repoMergeAttempt, null)
  // The very same approval still merges once the answers are quick: it was never spent.
  fx.state.slow = () => 0
  const merged = await fx.request(fx.mergeBody, { token })
  assert.equal(merged.status, 200, JSON.stringify(merged.value)); assert.equal(fx.refs.get('main'), HEAD); assert.equal(fx.state.consumed, 1)
  assert.equal((await fx.status()).lastRepoMergeOutcome.status, 'succeeded')
  assert.equal(fx.state.brokerAuthorize, 0, 'a merge never consumes through the Worker: HEAD does, in begin_merge')
})

test('when the reads leave less than the reserve, the merge stops before the attempt and the approval', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody)
  fx.state.slow = url => url.pathname.includes('proposal-checks.yml') || url.pathname.includes('/actions/runs/8/') ? 3600 : 0
  const result = await fx.request(fx.mergeBody, { token })
  assert.equal(result.value.code, 'BROKER_TIMEOUT', JSON.stringify(result.value))
  assert.equal(fx.state.consumed, 0); assert.equal(fx.posts(), 0); assert.equal((await fx.status()).repoMergeAttempt, null)
})

test('exit row 7 (mutation and bookkeeping succeed), and MUST 3e: after consumption only the mark, the ref update and its bookkeeping; no ref read', async () => {
  const fx = await harness()
  const result = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(result.status, 200, JSON.stringify(result.value)); assert.equal(result.value.commitSha, HEAD); assert.equal(fx.refs.get('main'), HEAD)
  // Review: with no attempt held, the released one is read (HEAD only) before anything is claimed.
  assert.deepEqual(fx.actions, ['inspect_merge', 'inspect_released', 'begin_merge', 'mark_merge', 'merge_outcome'])
  const consumedAt = fx.actions.indexOf('begin_merge') + 1, afterConsumption = fx.calls.filter(call => call.after >= consumedAt)
  assert.deepEqual(afterConsumption.map(call => [call.method, new URL(call.url).pathname]), [['POST', '/graphql']])
  // The ref update carries GitHub's own atomic check: each ref's expected old value.
  assert.equal(fx.state.consumed, 1); assert.equal(fx.posts(), 1)
  const done = await fx.status()
  assert.equal(done.repoMergeAttempt, null); assert.equal(done.lastRepoMergeOutcome.status, 'succeeded'); assert.equal(done.stagedRepoProposal, null)
})

test('MUST 3: his duplicate POST with the SAME approval while the first holds it after consumption ends with one merge, never a silent loss', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody), held = gate(), reached = gate()
  // The first request's approval is consumed and its attempt claimed; its answer is held before the mark.
  fx.state.around = async (action, forward) => {
    const response = await forward()
    if (action === 'begin_merge' && fx.state.holdBegin !== false) { fx.state.holdBegin = false; reached.open(); await held.opened }
    return response
  }
  const first = fx.request(fx.mergeBody, { token })
  await reached.opened
  assert.equal(fx.state.consumed, 1)
  const claimed = await fx.status()
  assert.equal(claimed.repoMergeAttempt.state, 'claimed')
  // The retry, identical, same approval: nothing is released, nothing re-consumed, and the answer says how old the attempt is.
  const retry = await fx.request(fx.mergeBody, { token })
  assert.equal(retry.status, 409, JSON.stringify(retry.value)); assert.equal(retry.value.code, 'REPO_MERGE_PENDING'); assert.equal(retry.value.outcome, 'unknown')
  assert.equal(Number.isSafeInteger(retry.value.ageMs), true); assert.equal(retry.value.reconcileAfterMs, REPO_MERGE_RECONCILE_AFTER_MS)
  assert.equal(fx.state.consumed, 1); assert.equal(fx.posts(), 0)
  assert.equal((await fx.status()).repoMergeAttempt.attemptId, claimed.repoMergeAttempt.attemptId)
  // The first resumes: its mark finds its own attempt, and it merges.
  held.open()
  const done = await first
  assert.equal(done.status, 200, JSON.stringify(done.value)); assert.equal(fx.refs.get('main'), HEAD)
  assert.equal(fx.state.consumed, 1); assert.equal(fx.posts(), 1)
  assert.equal((await fx.status()).lastRepoMergeOutcome.status, 'succeeded')
})

test('MUST 3b: during a running call, a duplicate POST with no passkey or with ANOTHER approval disturbs nothing and spends nothing', async () => {
  const fx = await harness(), held = gate(), reached = gate()
  fx.state.around = async (action, forward) => {
    if (action === 'mark_merge' && !fx.state.released) { reached.open(); await held.opened; fx.state.released = true }
    return await forward()
  }
  const first = fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  await reached.opened
  const none = await fx.request(fx.mergeBody)
  assert.equal(none.status, 409, JSON.stringify(none.value)); assert.equal(none.value.code, 'REPO_MERGE_PENDING'); assert.equal(Number.isSafeInteger(none.value.ageMs), true)
  const another = fx.grant(fx.mergeBody), second = await fx.request(fx.mergeBody, { token: another })
  assert.equal(second.status, 409, JSON.stringify(second.value)); assert.equal(second.value.code, 'REPO_MERGE_PENDING')
  assert.equal(fx.tokens.has(another), true, 'the other approval is not consumed'); assert.equal(fx.state.consumed, 1)
  // Another proposal's merge is refused while the attempt is held.
  assert.equal((await fx.request({ ...fx.mergeBody, headSha: NEXT }, { token: fx.grant({ ...fx.mergeBody, headSha: NEXT }) })).value.code, 'REPO_MERGE_PENDING')
  held.open()
  const done = await first
  assert.equal(done.status, 200, JSON.stringify(done.value)); assert.equal(fx.refs.get('main'), HEAD); assert.equal(fx.posts(), 1); assert.equal(fx.state.consumed, 1)
})

test('MUST 3: two identical calls that both passed the reads: the first begin_merge to commit owns the attempt; the other is refused unspent', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody), other = fx.grant(fx.mergeBody), held = gate(), reached = gate()
  // The first call is held just BEFORE its begin_merge reaches HEAD.
  fx.state.around = async (action, forward) => {
    if (action === 'begin_merge' && !fx.state.firstHeld) { fx.state.firstHeld = true; reached.open(); await held.opened }
    return await forward()
  }
  const first = fx.request(fx.mergeBody, { token })
  await reached.opened
  const second = await fx.request(fx.mergeBody, { token: other })
  assert.equal(second.status, 200, JSON.stringify(second.value)); assert.equal(fx.refs.get('main'), HEAD)
  held.open()
  const late = await first
  assert.equal(late.status, 409, JSON.stringify(late.value))
  assert.equal(fx.tokens.has(token), true, 'the late call spent nothing'); assert.equal(fx.state.consumed, 1); assert.equal(fx.posts(), 1)
})

test('exit row 1 (the answer after consumption is lost or refused): a lost begin answer is settled void by its own nonce; an expired approval is refused unspent', async () => {
  const fx = await harness()
  fx.state.around = async (action, forward) => {
    const response = await forward()
    if (action === 'begin_merge') throw new Error('synthetic lost answer after HEAD committed')
    return response
  }
  const lost = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(lost.status, 409, JSON.stringify(lost.value)); assert.equal(lost.value.code, 'REPO_APPROVAL_SPENT_VOID'); assert.equal(lost.value.next, APPROVAL_SPENT_VOID_NEXT)
  assert.equal(fx.state.consumed, 1); assert.equal(fx.posts(), 0); assert.equal(fx.refs.get('main'), BASE)
  let view = await fx.status()
  assert.equal(view.repoMergeAttempt, null); assert.equal(view.lastRepoMergeOutcome.status, 'failed'); assert.equal(view.lastRepoMergeOutcome.code, 'REPO_APPROVAL_SPENT_VOID')
  // An approval that expired before HEAD could consume it: refused in the transaction, nothing claimed, nothing spent.
  fx.state.around = null
  const stale = fx.grant(fx.mergeBody, { ttlAfterConsumption: -1 }), expired = await fx.request(fx.mergeBody, { token: stale })
  assert.equal(expired.status, 403, JSON.stringify(expired.value)); assert.equal(expired.value.code, 'CLASS3_APPROVAL_EXPIRED')
  assert.equal(fx.state.consumed, 1); assert.equal(fx.tokens.has(stale), true); assert.equal((await fx.status()).repoMergeAttempt, null)
  // He approves again: it merges.
  const again = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(again.status, 200, JSON.stringify(again.value)); view = await fx.status(); assert.equal(view.lastRepoMergeOutcome.status, 'succeeded')
})

test('exit row 2 (a ref read after consumption fails, finds movement or times out): there is none; movement is caught by GitHub\'s own check and reconciled truthfully', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody)
  // The branch moves while HEAD consumes his approval. No read follows; the ref update's expected old value refuses it.
  fx.state.onAuthorize = async refs => { refs.set(BRANCH, NEXT) }
  const result = await fx.request(fx.mergeBody, { token })
  assert.equal(result.value.code, 'REPO_REF_OUTCOME_UNKNOWN', JSON.stringify(result.value))
  assert.equal(fx.refs.get('main'), BASE, 'nothing published'); assert.equal(fx.posts(), 1); assert.equal(fx.state.consumed, 1)
  const consumedAt = fx.actions.indexOf('begin_merge') + 1
  assert.deepEqual(fx.calls.filter(call => call.after >= consumedAt).map(call => call.method), ['POST'])
  assert.equal((await fx.status()).repoMergeAttempt.state, 'dispatched')
  // Young, it is held (no passkey asked, none spent). MUST 4 (rewritten by order; was: past the margin with main
  // at its base, void): time alone never voids a dispatched attempt, so past the margin it stays unknown and says so.
  fx.state.onAuthorize = null; fx.refs.set(BRANCH, HEAD)
  const held = await fx.request(fx.mergeBody)
  assert.equal(held.status, 409, JSON.stringify(held.value)); assert.equal(held.value.code, 'REPO_MERGE_PENDING')
  await fx.age()
  const unknown = await fx.request(fx.mergeBody)
  assert.equal(unknown.status, 409, JSON.stringify(unknown.value)); assert.equal(unknown.value.code, 'REPO_REF_OUTCOME_UNKNOWN'); assert.equal(unknown.value.next, RELEASE_ATTEMPT_NEXT)
  assert.equal(unknown.value.mainSha, BASE); assert.equal(unknown.value.baseSha, BASE); assert.equal(unknown.value.headSha, HEAD); assert.equal(unknown.value.ageMs > REPO_MERGE_RECONCILE_AFTER_MS, true)
  assert.equal((await fx.status()).repoMergeAttempt.state, 'dispatched')
  // The owner releases it with a fresh passkey over the release's own terms; then the spent approval is still single use.
  const terms = await fx.releaseBody(), released = await fx.request(terms, { token: fx.grant(terms) })
  assert.equal(released.status, 200, JSON.stringify(released.value)); assert.equal(released.value.outcome.state, 'void-by-owner')
  assert.equal((await fx.status()).repoMergeAttempt, null)
  const replay = await fx.request(fx.mergeBody, { token })
  assert.equal(replay.value.code, 'CLASS3_WEBAUTHN_REQUIRED', JSON.stringify(replay.value)); assert.equal(fx.posts(), 1)
})

test('exit row 3 (the mark fails before applying): settled void in the same call; nothing sent', async () => {
  const fx = await harness()
  fx.state.around = async (action, forward) => { if (action === 'mark_merge') throw new Error('synthetic failure before HEAD'); return await forward() }
  const result = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(result.status, 409, JSON.stringify(result.value)); assert.equal(result.value.code, 'REPO_APPROVAL_SPENT_VOID'); assert.equal(result.value.next, APPROVAL_SPENT_VOID_NEXT)
  assert.equal(fx.posts(), 0); assert.equal(fx.refs.get('main'), BASE); assert.equal(fx.state.consumed, 1)
  const view = await fx.status()
  assert.equal(view.repoMergeAttempt, null); assert.equal(view.lastRepoMergeOutcome.code, 'REPO_APPROVAL_SPENT_VOID'); assert.notEqual(view.stagedRepoProposal, null)
})

test('exit row 4 (the mark applies but its answer is lost): the owner knows nothing was sent and settles it void; he approves again and it merges', async () => {
  const fx = await harness()
  fx.state.around = async (action, forward) => {
    const response = await forward()
    if (action === 'mark_merge' && !fx.state.lostOnce) { fx.state.lostOnce = true; throw new Error('synthetic lost mark answer') }
    return response
  }
  const result = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(result.status, 409, JSON.stringify(result.value)); assert.equal(result.value.code, 'REPO_APPROVAL_SPENT_VOID')
  assert.equal(fx.posts(), 0); assert.equal((await fx.status()).repoMergeAttempt, null)
  const again = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(again.status, 200, JSON.stringify(again.value)); assert.equal(fx.refs.get('main'), HEAD); assert.equal(fx.state.consumed, 2); assert.equal(fx.posts(), 1)
})

test('exit row 5, MUST 4 timing (approval with 50 ms left, the mark takes 100 ms): refused before sending, void in the same call, approve again', async () => {
  const fx = await harness()
  fx.state.around = async (action, forward) => { const response = await forward(); if (action === 'mark_merge') await sleep(100); return response }
  const result = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody, { ttlAfterConsumption: 50 }) })
  assert.equal(result.status, 409, JSON.stringify(result.value)); assert.equal(result.value.code, 'REPO_APPROVAL_SPENT_VOID')
  assert.equal(result.value.next, APPROVAL_SPENT_VOID_NEXT); assert.equal(result.value.outcome, undefined, 'a definite answer, not an unclear one')
  assert.equal(fx.posts(), 0); assert.equal(fx.refs.get('main'), BASE); assert.equal(fx.state.consumed, 1)
  // Review: with no attempt held, the released one is read (HEAD only) before anything is claimed.
  assert.deepEqual(fx.actions, ['inspect_merge', 'inspect_released', 'begin_merge', 'mark_merge', 'merge_outcome'])
  const view = await fx.status()
  assert.equal(view.repoMergeAttempt, null); assert.equal(view.lastRepoMergeOutcome.status, 'failed'); assert.equal(view.lastRepoMergeOutcome.code, 'REPO_APPROVAL_SPENT_VOID')
  fx.state.around = null
  const again = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(again.status, 200, JSON.stringify(again.value)); assert.equal(fx.refs.get('main'), HEAD)
})

test('exit row 5 (the call is cut off by its deadline after the mark, before sending): the SAME call settles it void and says so before answering; nothing sent', async () => {
  const fx = await harness()
  // The mark's answer arrives after the broker's ten-second deadline. Nothing runs after a Worker's response (there is no
  // waitUntil), so the void is written before the answer, and the answer says his approval is spent.
  fx.state.around = async (action, forward) => { const response = await forward(); if (action === 'mark_merge') await sleep(CLOUD_BROKER_LIMITS.timeoutMs + 300); return response }
  const started = Date.now(), result = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(result.status, 409, JSON.stringify(result.value)); assert.equal(result.value.code, 'REPO_APPROVAL_SPENT_VOID'); assert.equal(result.value.next, APPROVAL_SPENT_VOID_NEXT)
  assert.equal(result.value.outcome, undefined, 'a definite answer, not an unclear one')
  assert.ok(Date.now() - started < CLOUD_BROKER_LIMITS.timeoutMs + MERGE_SETTLE_GRACE_MS, String(Date.now() - started))
  const view = await fx.status()
  assert.equal(view.repoMergeAttempt, null, 'settled before the answer, not after it'); assert.equal(view.lastRepoMergeOutcome.code, 'REPO_APPROVAL_SPENT_VOID')
  assert.equal(fx.posts(), 0); assert.equal(fx.refs.get('main'), BASE); assert.equal(fx.state.consumed, 1)
})

test('exit row 5 (his owner session would run out during the call): refused before his approval is spent; nothing claimed; with a longer session the same approval merges', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody)
  // HEAD refuses an expired session, so a session that ran out after begin_merge could not even void the attempt: the
  // broker asks for a session that outlasts the deadline plus the settling time before anything is spent.
  fx.access.expires = Math.floor((Date.now() + CLOUD_BROKER_LIMITS.timeoutMs + 2000) / 1000)
  const result = await fx.request(fx.mergeBody, { token })
  assert.equal(result.status, 403, JSON.stringify(result.value)); assert.equal(result.value.code, 'OWNER_SESSION_REQUIRED')
  assert.equal(fx.state.consumed, 0); assert.equal(fx.tokens.has(token), true); assert.equal(fx.actions.includes('begin_merge'), false); assert.equal(fx.posts(), 0)
  assert.equal((await fx.status()).repoMergeAttempt, null)
  fx.access.expires = Math.floor(Date.now() / 1000) + 3600
  const merged = await fx.request(fx.mergeBody, { token })
  assert.equal(merged.status, 200, JSON.stringify(merged.value)); assert.equal(fx.refs.get('main'), HEAD); assert.equal(fx.state.consumed, 1)
})

test('exit row 6 (the ref update was sent, then its answer or its bookkeeping failed): unknown; a second call finishes it as merged with no passkey; one that did not land is never re-sent', async () => {
  const landed = await harness()
  landed.state.graphql = async (input, refs) => {
    for (const update of input.refUpdates) refs.set(update.name.slice('refs/heads/'.length), update.afterOid)
    return json({ data: null, errors: [{ type: 'INTERNAL', message: 'Resolver failed after write' }] })
  }
  const first = await landed.request(landed.mergeBody, { token: landed.grant(landed.mergeBody) })
  assert.equal(first.value.code, 'REPO_REF_OUTCOME_UNKNOWN', JSON.stringify(first.value))
  assert.equal((await landed.status()).repoMergeAttempt.status, 'unknown')
  landed.state.graphql = null
  const second = await landed.request(landed.mergeBody)
  assert.equal(second.status, 200, JSON.stringify(second.value)); assert.equal(second.value.resumed, true); assert.equal(second.value.commitSha, HEAD)
  assert.equal(landed.state.consumed, 1); assert.equal(landed.posts(), 1)
  const done = await landed.status()
  assert.equal(done.repoMergeAttempt, null); assert.equal(done.lastRepoMergeOutcome.status, 'succeeded'); assert.equal(done.stagedRepoProposal, null)

  // The ref update succeeds but HEAD's bookkeeping of it fails: the attempt stays; the next call reads main and finishes it.
  const books = await harness()
  books.state.around = async (action, forward) => {
    if (action === 'merge_outcome' && !books.state.failedOnce) { books.state.failedOnce = true; throw new Error('synthetic bookkeeping failure') }
    return await forward()
  }
  const unclear = await books.request(books.mergeBody, { token: books.grant(books.mergeBody) })
  assert.equal(unclear.value.code, 'REPO_REF_OUTCOME_UNKNOWN', JSON.stringify(unclear.value)); assert.equal(books.refs.get('main'), HEAD)
  const finished = await books.request(books.mergeBody)
  assert.equal(finished.status, 200, JSON.stringify(finished.value)); assert.equal(finished.value.resumed, true); assert.equal(books.posts(), 1)

  const lost = await harness()
  lost.state.graphql = async () => json({ data: null, errors: [{ type: 'INTERNAL' }] })
  assert.equal((await lost.request(lost.mergeBody, { token: lost.grant(lost.mergeBody) })).value.code, 'REPO_REF_OUTCOME_UNKNOWN')
  lost.state.graphql = null
  const reported = await lost.request(lost.mergeBody)
  assert.equal(reported.status, 409, JSON.stringify(reported.value)); assert.equal(reported.value.code, 'REPO_MERGE_PENDING'); assert.equal(reported.value.outcome, 'unknown')
  assert.equal(lost.posts(), 1, 'the ref update is never re-sent'); assert.equal(lost.refs.get('main'), BASE)
  // A fresh passkey does not release an attempt that reached the ref update, and is not spent on it.
  const fresh = lost.grant(lost.mergeBody), again = await lost.request(lost.mergeBody, { token: fresh })
  assert.equal(again.status, 409, JSON.stringify(again.value)); assert.equal(again.value.code, 'REPO_MERGE_PENDING'); assert.equal(again.value.outcome, 'unknown')
  assert.equal(lost.state.consumed, 1); assert.equal(lost.tokens.has(fresh), true); assert.equal(lost.posts(), 1)
  assert.equal((await lost.status()).repoMergeAttempt.status, 'unknown')
})

test('MUST 3d, rewritten as MUST 4: a dispatched attempt past the margin is merged when its head is in main, and otherwise stays unknown whatever main is', async () => {
  // A dispatched attempt whose owner is gone stands for each case: an unknown outcome after a lost answer.
  const leftover = async () => {
    const fx = await harness()
    fx.state.graphql = async () => json({ data: null, errors: [{ type: 'INTERNAL' }] })
    assert.equal((await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })).value.code, 'REPO_REF_OUTCOME_UNKNOWN')
    fx.state.graphql = null
    await fx.age()
    return fx
  }
  const diverged = (base, tip) => json({ base_commit: { sha: base }, merge_base_commit: { sha: BASE }, ahead_by: 1, behind_by: 1, status: 'diverged', files: [] })
  // 1. main equals the proposal's head: merged, with no passkey.
  const merged = await leftover()
  merged.refs.set('main', HEAD)
  const finished = await merged.request(merged.mergeBody)
  assert.equal(finished.status, 200, JSON.stringify(finished.value)); assert.equal(finished.value.resumed, true)
  assert.equal((await merged.status()).lastRepoMergeOutcome.status, 'succeeded')
  // 2. main unchanged from the attempt's base (was: void): unknown, with or without a passkey; the passkey is not spent.
  const base = await leftover()
  const told = await base.request(base.mergeBody)
  assert.equal(told.status, 409, JSON.stringify(told.value)); assert.equal(told.value.code, 'REPO_REF_OUTCOME_UNKNOWN'); assert.equal(told.value.mainSha, BASE)
  const fresh = base.grant(base.mergeBody), still = await base.request(base.mergeBody, { token: fresh })
  assert.equal(still.value.code, 'REPO_REF_OUTCOME_UNKNOWN', JSON.stringify(still.value)); assert.equal(base.tokens.has(fresh), true)
  assert.equal(base.state.consumed, 1); assert.equal(base.posts(), 1); assert.equal((await base.status()).repoMergeAttempt.state, 'dispatched')
  // 3. main at a third commit the head is NOT in: unknown with both values; a passkey is not spent on it.
  const other = await leftover()
  other.refs.set('main', NEXT); other.state.compare = diverged
  const kept = other.grant(other.mergeBody), stays = await other.request(other.mergeBody, { token: kept })
  assert.equal(stays.status, 409, JSON.stringify(stays.value)); assert.equal(stays.value.code, 'REPO_REF_OUTCOME_UNKNOWN')
  assert.equal(stays.value.mainSha, NEXT); assert.equal(stays.value.baseSha, BASE); assert.equal(stays.value.headSha, HEAD)
  assert.equal(other.tokens.has(kept), true); assert.equal((await other.status()).repoMergeAttempt.state, 'dispatched')
  const read = await other.request({ action: 'reconcile_proposal' })
  assert.equal(read.status, 200, JSON.stringify(read.value)); assert.equal(read.value.reconciled, false); assert.equal(read.value.outcome.code, 'REPO_REF_OUTCOME_UNKNOWN')
  // A compare that fails leaves it unknown too.
  other.state.compare = () => new Response('', { status: 500 })
  assert.equal((await other.request({ action: 'reconcile_proposal' })).value.outcome.code, 'REPO_REF_OUTCOME_UNKNOWN')
  // 4. main at a third commit that CONTAINS the head (SHOULD 1): merged, with no passkey.
  const ahead = await leftover()
  ahead.refs.set('main', NEXT)
  const contained = await ahead.request({ action: 'reconcile_proposal' })
  assert.equal(contained.status, 200, JSON.stringify(contained.value)); assert.equal(contained.value.reconciled, true); assert.equal(contained.value.outcome.state, 'merged')
  assert.ok(ahead.calls.some(call => new URL(call.url).pathname.endsWith(`/compare/${HEAD}...${NEXT}`)), 'one compare call asked GitHub')
  const view = await ahead.status()
  assert.equal(view.repoMergeAttempt, null); assert.equal(view.lastRepoMergeOutcome.status, 'succeeded'); assert.equal(ahead.state.consumed, 1)
})

test('his sequence (accepted at t=1, broker timeout at t=10, read at t=62, the compare-and-set lands at t=63) ends unknown at 62 and merged at the next read, never void', async () => {
  const fx = await harness(), seen = []
  // t=1: GitHub takes the ref update and holds its compare-and-set; the broker's own ten-second deadline cuts the call.
  fx.state.graphql = async () => { await sleep(CLOUD_BROKER_LIMITS.timeoutMs + 500); return json({ data: null, errors: [{ type: 'TIMEOUT' }] }) }
  const first = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(first.value.code, 'REPO_REF_OUTCOME_UNKNOWN', JSON.stringify(first.value)); assert.equal(fx.posts(), 1)
  const record = async () => { const view = await fx.status(); seen.push(view.lastRepoMergeOutcome?.status ?? null); return view }
  assert.equal((await record()).repoMergeAttempt.state, 'dispatched')
  // t=62: past the margin, main still at its base. Every read says unknown, with both values and the age; nothing is voided.
  await fx.age()
  for (const read of [await fx.request(fx.mergeBody), await fx.request({ action: 'reconcile_proposal' })]) {
    assert.equal(read.value.code ?? read.value.outcome?.code, 'REPO_REF_OUTCOME_UNKNOWN', JSON.stringify(read.value))
  }
  const at62 = await fx.request(fx.mergeBody)
  assert.equal(at62.value.mainSha, BASE); assert.equal(at62.value.baseSha, BASE); assert.equal(at62.value.headSha, HEAD); assert.equal(Number.isSafeInteger(at62.value.ageMs), true)
  assert.equal((await record()).repoMergeAttempt.state, 'dispatched')
  // t=63: the held compare-and-set applies base -> head.
  fx.refs.set('main', HEAD)
  const next = await fx.request({ action: 'reconcile_proposal' })
  assert.equal(next.status, 200, JSON.stringify(next.value)); assert.equal(next.value.reconciled, true); assert.equal(next.value.outcome.state, 'merged')
  const done = await record()
  assert.equal(done.repoMergeAttempt, null); assert.equal(done.lastRepoMergeOutcome.status, 'succeeded')
  assert.equal(seen.includes('failed'), false, `never void: ${JSON.stringify(seen)}`); assert.equal(fx.posts(), 1)
})

test('release_attempt needs the owner, a fresh approval over its own terms, and an attempt held past the margin; refused, nothing changes', async () => {
  const fx = await harness()
  fx.state.graphql = async () => json({ data: null, errors: [{ type: 'INTERNAL' }] })
  assert.equal((await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })).value.code, 'REPO_REF_OUTCOME_UNKNOWN')
  fx.state.graphql = null
  const terms = await fx.releaseBody(), unchanged = async () => {
    const view = await fx.status()
    assert.equal(view.repoMergeAttempt?.state, 'dispatched'); assert.equal(view.repoMergeReleased, null); assert.equal(view.lastRepoMergeOutcome.status, 'unknown')
  }
  // Young: its owning call may still run; nothing is spent.
  const young = fx.grant(terms), early = await fx.request(terms, { token: young })
  assert.equal(early.status, 409, JSON.stringify(early.value)); assert.equal(early.value.code, 'REPO_MERGE_PENDING'); assert.equal(fx.tokens.has(young), true)
  await unchanged()
  await fx.age()
  // No approval; a merge's approval; an approval for another attempt's terms; terms that name another base.
  const none = await fx.request(terms)
  assert.equal(none.status, 403, JSON.stringify(none.value)); assert.equal(none.value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  const mergeToken = fx.grant(fx.mergeBody), wrongKind = await fx.request(terms, { token: mergeToken })
  assert.equal(wrongKind.value.code, 'CLASS3_WEBAUTHN_REQUIRED', JSON.stringify(wrongKind.value)); assert.equal(fx.tokens.has(mergeToken), true)
  const another = { ...terms, attemptId: '00000000-0000-4000-8000-000000000000' }, anotherToken = fx.grant(another)
  assert.equal((await fx.request(terms, { token: anotherToken })).value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal((await fx.request(another, { token: anotherToken })).value.code, 'REPO_MERGE_ATTEMPT_STALE')
  assert.equal(fx.tokens.has(anotherToken), true)
  const otherBase = { ...terms, baseSha: NEXT }
  assert.equal((await fx.request(otherBase, { token: fx.grant(otherBase) })).value.code, 'REPO_MERGE_ATTEMPT_STALE')
  // Not the owner.
  const owner = fx.access.email, good = fx.grant(terms)
  fx.access.email = 'stranger@fixture.example'
  const stranger = await fx.request(terms, { token: good })
  fx.access.email = owner
  assert.equal(stranger.value.ok, false); assert.notEqual(stranger.status, 200); assert.equal(fx.tokens.has(good), true)
  // Extra fields are refused before anything is read.
  assert.equal((await fx.request({ ...terms, extra: 1 }, { token: good })).value.ok, false)
  await unchanged(); assert.equal(fx.state.consumed, 1); assert.equal(fx.posts(), 1)
  // His fresh approval over these exact terms: void-by-owner, and a new merge may begin.
  const released = await fx.request(terms, { token: good })
  assert.equal(released.status, 200, JSON.stringify(released.value)); assert.equal(released.value.released.state, 'void-by-owner'); assert.equal(released.value.outcome.state, 'void-by-owner')
  assert.equal(fx.tokens.has(good), false); assert.equal(fx.state.consumed, 2)
  const view = await fx.status()
  assert.equal(view.repoMergeAttempt, null); assert.equal(view.lastRepoMergeOutcome.code, 'REPO_ATTEMPT_VOID_BY_OWNER'); assert.equal(view.repoMergeReleased.state, 'void-by-owner')
  assert.notEqual(view.stagedRepoProposal, null, 'the stage stays, so he can approve it again')
  assert.equal((await fx.request(terms, { token: fx.grant(terms) })).value.code, 'REPO_MERGE_ATTEMPT_MISSING')
  const again = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(again.status, 200, JSON.stringify(again.value)); assert.equal(fx.refs.get('main'), HEAD); assert.equal(fx.posts(), 2)
})

test('main at a third commit the head is not in: unknown, released with a passkey; when the head later shows in main, the next read says merged after release', async () => {
  const fx = await harness()
  fx.state.graphql = async () => json({ data: null, errors: [{ type: 'INTERNAL' }] })
  assert.equal((await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })).value.code, 'REPO_REF_OUTCOME_UNKNOWN')
  fx.state.graphql = null
  await fx.age()
  fx.refs.set('main', NEXT)
  fx.state.compare = (base, tip) => json({ base_commit: { sha: base }, merge_base_commit: { sha: BASE }, ahead_by: 1, behind_by: 1, status: 'diverged', files: [] })
  assert.equal((await fx.request({ action: 'reconcile_proposal' })).value.outcome.code, 'REPO_REF_OUTCOME_UNKNOWN')
  const terms = await fx.releaseBody(), released = await fx.request(terms, { token: fx.grant(terms) })
  assert.equal(released.status, 200, JSON.stringify(released.value)); assert.equal(released.value.outcome.state, 'void-by-owner')
  // Still not in main: the read keeps it void-by-owner and says so.
  const quiet = await fx.request({ action: 'reconcile_proposal' })
  assert.equal(quiet.status, 200, JSON.stringify(quiet.value)); assert.equal(quiet.value.reconciled, false); assert.equal(quiet.value.released.state, 'void-by-owner')
  // Later the head shows as an ancestor of main: the next read corrects the stored outcome.
  fx.state.compare = null
  const later = await fx.request({ action: 'reconcile_proposal' })
  assert.equal(later.status, 200, JSON.stringify(later.value)); assert.equal(later.value.reconciled, true)
  assert.equal(later.value.outcome.state, 'merged-after-release'); assert.equal(later.value.released.state, 'merged-after-release')
  const view = await fx.status()
  assert.equal(view.lastRepoMergeOutcome.status, 'succeeded'); assert.equal(view.lastRepoMergeOutcome.commitSha, HEAD); assert.equal(view.repoMergeReleased.state, 'merged-after-release')
  assert.equal(view.stagedRepoProposal, null)
  // A further read changes nothing and asks GitHub nothing.
  const calls = fx.calls.length, after = await fx.request({ action: 'reconcile_proposal' })
  assert.equal(after.value.reconciled, false); assert.equal(fx.calls.length, calls)
})

test('A released merge that lands afterwards, approved again, is answered merged with no approval spent, never a conflict', async () => {
  const fx = await harness()
  fx.state.graphql = async () => json({ data: null, errors: [{ type: 'INTERNAL' }] })
  assert.equal((await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })).value.code, 'REPO_REF_OUTCOME_UNKNOWN')
  fx.state.graphql = null
  await fx.age()
  const terms = await fx.releaseBody(), released = await fx.request(terms, { token: fx.grant(terms) })
  assert.equal(released.status, 200, JSON.stringify(released.value)); assert.equal(released.value.outcome.state, 'void-by-owner')
  // GitHub's delayed compare-and-set lands after the release: main moves past the head (the head is an ancestor of main).
  fx.refs.set('main', NEXT)
  const consumed = fx.state.consumed, posts = fx.posts()
  // He approves the still-staged proposal again, with nothing reconciled in between.
  const again = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(again.status, 200, JSON.stringify(again.value))
  assert.equal(again.value.commitSha, HEAD); assert.equal(again.value.resumed, true); assert.equal(again.value.mergedAfterRelease, true)
  assert.equal(fx.state.consumed, consumed, 'no approval was spent'); assert.equal(fx.posts(), posts, 'nothing was sent')
  const view = await fx.status()
  assert.equal(view.lastRepoMergeOutcome.status, 'succeeded'); assert.equal(view.lastRepoMergeOutcome.commitSha, HEAD)
  assert.equal(view.repoMergeReleased.state, 'merged-after-release'); assert.equal(view.stagedRepoProposal, null)
})

test('a branch already moved consumes nothing and records nothing', async () => {
  const fx = await harness()
  fx.refs.set(BRANCH, NEXT)
  const result = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(result.value.code, 'REPO_HEAD_CONFLICT', JSON.stringify(result.value))
  assert.equal(fx.state.consumed, 0); assert.equal(fx.posts(), 0)
  assert.equal((await fx.status()).repoMergeAttempt, null)
})

test('his A then C through the broker: a newer attempt held, or released too, never hides an older release; A\'s late landing is reported merged after release', async () => {
  // A (an earlier proposal, another branch, head F) was released by the owner; its record is what HEAD keeps for it.
  const F = 'f'.repeat(40), A_ID = '11111111-2222-4333-8444-555555555555', RELEASED = 'head:repo-merge-released-by-attempt'
  const A = { attemptId: A_ID, branch: 'auma/proposal/fixture-aa', baseSha: BASE, headSha: F, treeSha: HEAD_TREE, releasedAt: Date.now() - 120000, state: 'void-by-owner' }
  const diverged = (base, tip) => base === HEAD ? json({ base_commit: { sha: base }, merge_base_commit: { sha: BASE }, ahead_by: 1, behind_by: 1, status: 'diverged', files: [] }) : null
  for (const releaseC of [false, true]) {
    const fx = await harness()
    await fx.storage.put(RELEASED, { [A_ID]: A })
    // C (this harness's proposal): its ref update's outcome is unknown, past the margin.
    fx.state.graphql = async () => json({ data: null, errors: [{ type: 'INTERNAL' }] })
    assert.equal((await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })).value.code, 'REPO_REF_OUTCOME_UNKNOWN')
    fx.state.graphql = null
    await fx.age()
    if (releaseC) {
      const terms = await fx.releaseBody(), released = await fx.request(terms, { token: fx.grant(terms) })
      assert.equal(released.status, 200, JSON.stringify(released.value)); assert.equal(released.value.outcome.state, 'void-by-owner')
    }
    // A's delayed compare-and-set lands: main is A's head; C's head is not in it.
    fx.refs.set('main', F); fx.state.compare = diverged
    const read = await fx.request({ action: 'reconcile_proposal' })
    assert.equal(read.status, 200, JSON.stringify(read.value))
    const releasedA = read.value.releasedReconciled.find(result => result.released?.attemptId === A_ID)
    assert.equal(releasedA?.reconciled, true, JSON.stringify(read.value)); assert.equal(releasedA.outcome.state, 'merged-after-release')
    if (releaseC) assert.equal(read.value.outcome.state, 'merged-after-release', 'with no attempt held, the answer is the release that settled merged')
    else assert.equal(read.value.outcome.code, 'REPO_REF_OUTCOME_UNKNOWN', 'the held attempt C stays unknown and is the answer')
    const view = await fx.status()
    const byId = Object.fromEntries(view.repoMergeReleases.map(item => [item.attemptId, item.state]))
    assert.equal(byId[A_ID], 'merged-after-release', JSON.stringify(view.repoMergeReleases))
    if (releaseC) { assert.equal(Object.keys(byId).length, 2); assert.equal(Object.values(byId).filter(state => state === 'void-by-owner').length, 1) }
    else assert.equal(view.repoMergeAttempt.state, 'dispatched')
    // A further read asks GitHub about C only (A is resolved): never about A again.
    const calls = fx.calls.length
    await fx.request({ action: 'reconcile_proposal' })
    assert.equal(fx.calls.slice(calls).some(call => call.url.includes(`/commits/${F}`)), false)
  }
})

test('at the bound through the broker: the refusal names the oldest unresolved release; his passkey over terms that forget it releases the held merge and keeps the other three', async () => {
  const RELEASED = 'head:repo-merge-released-by-attempt', at = Date.now() - 600000
  const ids = ['10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000004']
  const kept = Object.fromEntries(ids.map((attemptId, index) => [attemptId, { attemptId, branch: `auma/proposal/fixture-k${index}`, baseSha: BASE, headSha: String(index + 5).repeat(40),
    treeSha: HEAD_TREE, releasedAt: at + index, state: 'void-by-owner' }]))
  const fx = await harness()
  await fx.storage.put(RELEASED, kept)
  fx.state.graphql = async () => json({ data: null, errors: [{ type: 'INTERNAL' }] })
  assert.equal((await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })).value.code, 'REPO_REF_OUTCOME_UNKNOWN')
  fx.state.graphql = null
  await fx.age()
  fx.state.compare = (base, tip) => json({ base_commit: { sha: base }, merge_base_commit: { sha: BASE }, ahead_by: 1, behind_by: 1, status: 'diverged', files: [] })
  const terms = await fx.releaseBody(), plain = fx.grant(terms)
  const refused = await fx.request(terms, { token: plain })
  assert.equal(refused.status, 409, JSON.stringify(refused.value)); assert.equal(refused.value.code, 'REPO_RELEASE_LIMIT')
  assert.deepEqual(refused.value.oldest, { attemptId: ids[0], branch: 'auma/proposal/fixture-k0', headSha: '5'.repeat(40) })
  assert.equal(fx.tokens.has(plain), true, 'his approval was not spent')
  // Terms that name another release, or forget a malformed id: refused, nothing spent.
  const other = { ...terms, forgets: ids[2] }, otherToken = fx.grant(other)
  const stale = await fx.request(other, { token: otherToken })
  assert.equal(stale.status, 409, JSON.stringify(stale.value)); assert.equal(stale.value.code, 'REPO_RELEASE_FORGET_STALE'); assert.equal(fx.tokens.has(otherToken), true)
  assert.equal((await fx.request({ ...terms, forgets: 'not-an-id' }, { token: fx.grant({ ...terms, forgets: 'not-an-id' }) })).value.code, 'REPO_RELEASE_INVALID')
  // A passkey over the plain terms does not cover terms that forget: the forget is signed or it is not done.
  const forget = { ...terms, forgets: ids[0] }
  assert.equal((await fx.request(forget, { token: plain })).value.code, 'CLASS3_WEBAUTHN_REQUIRED'); assert.equal(fx.tokens.has(plain), true)
  const consumed = fx.state.consumed, released = await fx.request(forget, { token: fx.grant(forget) })
  assert.equal(released.status, 200, JSON.stringify(released.value)); assert.equal(released.value.outcome.state, 'void-by-owner'); assert.equal(fx.state.consumed, consumed + 1)
  const view = await fx.status()
  assert.equal(view.repoMergeAttempt, null)
  assert.deepEqual(view.repoMergeReleases.map(item => item.attemptId).sort(), [ids[1], ids[2], ids[3], terms.attemptId].sort())
  // The merge loop is unlocked: the staged proposal can be approved again.
  fx.state.compare = null
  const again = await fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  assert.equal(again.status, 200, JSON.stringify(again.value)); assert.equal(fx.refs.get('main'), HEAD)
})
