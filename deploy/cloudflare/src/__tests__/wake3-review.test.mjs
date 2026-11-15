/** The fixes to the reviewer's findings on an earlier commit. Each test failed on that commit and
 * passes after the fix. Synthetic storage, a made-up GitHub, Linear and model: no network, no credential, no real run.
 * - the per-step act bounds are durable and judged inside the spend's own transaction, with the step's fence;
 * - the Linear and relay calls carry the step's abort signal;
 * - the comment has its own principal, and every act needs HEAD's receipt for its exact bytes;
 * - a card is refused for a pending merge before the spend;
 * - commit, apply_patch and stage_proposal succeed on fakes, receipt first, outcome row `done`;
 * - the reasoning field is admitted on the wake's path only;
 * - a runner job is refused by the runner's own bounds before the spend. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { X61HeadDurableObject, WAKE_ACT_STEP_KEY } from '../head-do.mjs'
import { OWNER_MANDATE_KEY, OWNER_MANDATE_RECORD_SCHEMA, OWNER_MANDATE_SCHEMA, OWNER_MANDATE_DEFAULT_PER_DAY, OWNER_MANDATE_SCOPES, OWNER_MANDATE_RECEIPT_SCHEMA } from '../owner-mandate.mjs'
import { cloudWakeMandateAct, wakeExecRateRefusal } from '../cloud-brokers.mjs'
import { linearWakeRead, linearWakeComment, WAKE_LINEAR_READER, WAKE_LINEAR_COMMENTER } from '../linear-door.mjs'
import { relayWakeRead, WAKE_RELAY_READER } from '../crew-relay.mjs'
import { providerBudgetLimits, providerRequestReservation } from '../provider-budget.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { createRunnerPickScope } from '../runner-budget-broker.mjs'

const ORIGIN = 'https://wake3.example.invalid'
const OWNER = 'owner@example.invalid'
const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64)
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0)
const MANDATE = 'mandate-wake3-000000001'
const MAIN_SHA = '1'.repeat(40), HER_SHA = '2'.repeat(40), NEXT_SHA = '3'.repeat(40)
const BUDGET = { PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '1000', PROVIDER_BUDGET_TOKENS: '1000000', PROVIDER_MAX_OUTPUT_TOKENS: '4096' }
const ENV = { WAKE_EXECUTOR_ENABLED: '1', WAKE_ACTS_ENABLED: '1', CLOUD_WAKE_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'deepseek-synthetic-key', GITHUB_TOKEN: 'github-synthetic-credential-0000',
  LINEAR_API_KEY: 'lin-synthetic-key-0000', PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, ...BUDGET }
const sha256 = text => createHash('sha256').update(text).digest('hex')
const PREFIX = '/repos/your_org_x/your-node'

function memoryStorage(initial = [], events = []) {
  let rows = new Map(initial), tail = Promise.resolve()
  const view = data => ({
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => { data.set(key, structuredClone(value)); events.push({ kind: 'put', key }) },
    delete: async key => data.delete(key),
    list: async ({ prefix = '', limit = Infinity, reverse = false } = {}) => {
      const entries = [...data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
      if (reverse) entries.reverse()
      return new Map(entries.slice(0, limit).map(([key, value]) => [key, structuredClone(value)]))
    },
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(key => [key, (...args) => view(rows)[key](...args)]))
  storage.transaction = operation => {
    const next = tail.then(async () => { const copy = structuredClone(rows); const result = await operation(view(copy)); rows = copy; return result })
    tail = next.catch(() => {})
    return next
  }
  storage.snapshot = () => structuredClone(rows)
  return storage
}

const terms = () => ({ schema: OWNER_MANDATE_SCHEMA, id: MANDATE, principal: 'owner', agent: 'auma', scopes: [...OWNER_MANDATE_SCOPES],
  perDay: { ...OWNER_MANDATE_DEFAULT_PER_DAY }, issuedAt: T0 - 60000, expiresAt: T0 + 86400000, nonce: 'nonce-wake3-0000001' })
const mandateRecord = () => ({ schema: OWNER_MANDATE_RECORD_SCHEMA, terms: terms(), termsSha256: 'c'.repeat(64), issuedAt: T0 - 60000, revokedAt: null, replaces: null })
const wishOf = (extra = {}) => ({ wish_id: 'wish-wake3-1', intent: 'Fix one thing on her branch', acceptance: 'A commit on her branch', status: 'running',
  stepsCompleted: 0, maxSteps: 4, mandateId: MANDATE, ...extra })

function world({ env = {}, wish = wishOf(), extra = [], answer, linearFetch } = {}) {
  const events = []
  const initial = [['bootstrap:v1', { phase: 'complete', seedId: SEED }], ['head:current', { ballId: BALL, epoch: 176, entries: { organ: {} } }], [OWNER_MANDATE_KEY, mandateRecord()]]
  if (wish !== null) initial.push(['head:wish:active', wish])
  const storage = memoryStorage([...initial, ...extra], events)
  const requests = []
  const fetchImpl = async (raw, init = {}) => {
    const url = new URL(typeof raw === 'string' ? raw : raw.url)
    const body = typeof init.body === 'string' ? init.body : undefined
    requests.push({ method: init.method ?? 'GET', url, body, headers: Object.fromEntries(new Headers(init.headers ?? {}).entries()) })
    events.push({ kind: 'fetch', host: url.host, path: url.pathname, method: init.method ?? 'GET' })
    const value = answer ? await answer(url, init, body) : undefined
    if (value !== undefined) return value
    throw new Error('Unexpected synthetic request ' + (init.method ?? 'GET') + ' ' + url.href)
  }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, { ...ENV, ...env }, { now: () => T0, wakeLinearFetch: linearFetch ?? fetchImpl })
  head.broadcast = async () => {}
  return { head, storage, events, requests, fetchImpl }
}

const receiptsOf = storage => [...storage.snapshot().keys()].filter(key => key.startsWith(`${OWNER_MANDATE_KEY}:use:`))
const outcomesOf = storage => [...storage.snapshot()].filter(([key]) => key.startsWith('head:wake-act-outcome:')).map(([, value]) => value)
const freshState = (issues = ['YOURTEAM-463']) => ({ acts: 0, linearComments: 0, readableIssues: new Set(issues) })
const noUpstream = async () => { throw new Error('no upstream request may leave') }
const act = (head, tool, args, { actState = freshState(), wishId = 'wish-wake3-1', step = 1, networkFetch = noUpstream, fence, signal = new AbortController().signal } = {}) =>
  head.runWakeAct({ tool, args: structuredClone(args), offer: { offered: true, cause: null, mandateId: MANDATE }, actState, wishId, step, seedId: SEED, signal,
    networkFetch, stepDeadlineAt: Date.now() + 30000, admitNow: () => T0, ...(fence ? { fence } : {}) })
const receiptFor = (request, scope, use, units = 1) => ({ schema: OWNER_MANDATE_RECEIPT_SCHEMA, kind: 'use', mandateId: MANDATE, scope, use, units,
  actionSha256: sha256(canonicalJson(request)), day: '2026-11-14', seq: 1, at: T0 })

/** A made-up GitHub of her repository: main at MAIN_SHA, her branches at HER_SHA; one commit moves a branch to NEXT_SHA. */
function githubFake({ mainFiles = { 'docs/auma/a.md': 'one\n' }, herFiles = { 'docs/auma/a.md': 'one\n', 'docs/auma/card.md': 'a card\n' }, refsExtra = {} } = {}) {
  const blob = value => createHash('sha1').update(value).digest('hex')
  const refs = new Map([['main', MAIN_SHA], ['auma/sandbox/wake3-try', HER_SHA], ['auma/proposal/wake3-card', HER_SHA], ...Object.entries(refsExtra)])
  const filesOf = sha => sha === MAIN_SHA ? mainFiles : sha === NEXT_SHA ? { ...herFiles, 'docs/auma/notes-wake3.md': 'one line\n' } : herFiles
  const treeOf = sha => ({ [MAIN_SHA]: 'd'.repeat(40), [HER_SHA]: 'e'.repeat(40), [NEXT_SHA]: 'f'.repeat(40) })[sha]
  const commitOfTree = tree => ({ ['d'.repeat(40)]: MAIN_SHA, ['e'.repeat(40)]: HER_SHA, ['f'.repeat(40)]: NEXT_SHA })[tree]
  const tree = (files, sha) => {
    const entries = new Map()
    for (const [path, content] of Object.entries(files)) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) { const parent = parts.slice(0, i).join('/'); entries.set(parent, { path: parent, mode: '040000', type: 'tree', sha: blob(parent + sha) }) }
      entries.set(path, { path, mode: '100644', type: 'blob', sha: blob(content), size: Buffer.byteLength(content) })
    }
    return { sha, truncated: false, tree: [...entries.values()] }
  }
  const mutations = []
  const answer = async (url, init, body) => {
    if (url.host !== 'api.github.com') return undefined
    const path = decodeURIComponent(url.pathname)
    if (path === PREFIX) return Response.json({ full_name: 'your_org_x/your-node', default_branch: 'main', node_id: 'R_synthetic' })
    if (path.startsWith(PREFIX + '/git/ref/heads/')) {
      const branch = path.slice((PREFIX + '/git/ref/heads/').length), sha = refs.get(branch)
      return sha ? Response.json({ ref: 'refs/heads/' + branch, object: { type: 'commit', sha } }) : new Response('{}', { status: 404 })
    }
    if (path.startsWith(PREFIX + '/commits/')) {
      const ref = path.slice((PREFIX + '/commits/').length), sha = refs.get(ref) ?? ref
      return Response.json({ sha, commit: { tree: { sha: treeOf(sha) } } })
    }
    if (path.startsWith(PREFIX + '/git/trees/')) { const sha = path.split('/').at(-1); return Response.json(tree(filesOf(commitOfTree(sha)), sha)) }
    if (path.startsWith(PREFIX + '/contents/')) {
      const file = path.slice((PREFIX + '/contents/').length), content = filesOf(url.searchParams.get('ref'))[file]
      if (content === undefined) return new Response('{}', { status: 404 })
      return Response.json({ type: 'file', path: file, sha: blob(content), encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    if (path === `${PREFIX}/compare/${MAIN_SHA}...${HER_SHA}`) return Response.json({ base_commit: { sha: MAIN_SHA }, merge_base_commit: { sha: MAIN_SHA }, status: 'ahead', ahead_by: 1, behind_by: 0 })
    if (/\/actions\/workflows\/proposal-(gate|checks)\.yml\/runs$/.test(path)) return Response.json({ total_count: 0, workflow_runs: [] })
    if (path === '/graphql' && init.method === 'POST') {
      const operation = JSON.parse(body), input = operation.variables.input
      mutations.push(operation.query.split('(')[0])
      assert.match(operation.query, /createCommitOnBranch/)
      assert.equal(refs.get(input.branch.branchName), input.expectedHeadOid, 'compare-and-swap on her branch head')
      refs.set(input.branch.branchName, NEXT_SHA)
      return Response.json({ data: { createCommitOnBranch: { commit: { oid: NEXT_SHA } } } })
    }
    return undefined
  }
  return { answer, refs, mutations }
}

const COMMIT = { branch: 'auma/sandbox/wake3-try', expectedHeadSha: HER_SHA, message: 'docs: one line', changes: [{ path: 'docs/auma/notes-wake3.md', content: 'one line\n' }] }
const PATCH = { branch: 'auma/sandbox/wake3-try', baseSha: HER_SHA, message: 'docs: one line',
  patch: 'diff --git a/docs/auma/notes-wake3.md b/docs/auma/notes-wake3.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/auma/notes-wake3.md\n@@ -0,0 +1 @@\n+one line\n' }
const STAGE = { branch: 'auma/proposal/wake3-card', title: 'One small card' }

function assertReceiptFirst(events, storage) {
  const receiptAt = events.findIndex(event => event.kind === 'put' && event.key.startsWith(`${OWNER_MANDATE_KEY}:use:${MANDATE}:`))
  const firstFetch = events.findIndex(event => event.kind === 'fetch')
  assert.ok(receiptAt >= 0 && firstFetch > receiptAt, 'the use receipt is written before the first upstream request')
  assert.equal(receiptsOf(storage).length, 1)
}

// ------------------------------------------------------------------------------------------- finding 1: durable bounds

test('two runs of ONE step (fresh in-memory counts each, at the same moment) together take at most 3 acts: the 4th is refused in the spend, unpaid', async () => {
  const github = githubFake({ refsExtra: { 'auma/sandbox/b1': HER_SHA, 'auma/sandbox/b2': HER_SHA, 'auma/sandbox/b3': HER_SHA, 'auma/sandbox/b4': HER_SHA } })
  const { head, storage, fetchImpl } = world({ answer: github.answer })
  const outs = await Promise.all(['b1', 'b2', 'b3', 'b4'].map(name => act(head, 'act_branch_create', { branch: `auma/sandbox/${name}` }, { networkFetch: fetchImpl })))
  assert.equal(outs.filter(out => out.ok).length, 3, JSON.stringify(outs))
  assert.deepEqual(outs.filter(out => !out.ok).map(out => out.code), ['CLOUD_WAKE_ACT_LIMIT'])
  assert.equal(receiptsOf(storage).length, 3, 'three paid, the fourth never spent')
  assert.deepEqual(await storage.get(WAKE_ACT_STEP_KEY), { wishId: 'wish-wake3-1', step: 1, acts: 3, linearComments: 0 })
  // A later run of the same step with fresh counts is refused before anything (the durable record says 3).
  const again = await act(head, 'act_branch_create', { branch: 'auma/sandbox/b1' }, { networkFetch: fetchImpl })
  assert.equal(again.code, 'CLOUD_WAKE_ACT_LIMIT')
  assert.equal(receiptsOf(storage).length, 3)
  // The NEXT step of the wish starts from zero.
  await storage.put('head:wish:active', wishOf({ stepsCompleted: 1 }))
  assert.equal((await act(head, 'act_branch_create', { branch: 'auma/sandbox/b1' }, { networkFetch: fetchImpl, step: 2 })).ok, true)
  assert.equal(receiptsOf(storage).length, 4)
})

test('a second Linear comment in one step from another run (fresh in-memory counts) is refused, unpaid', async () => {
  const linear = async (url, init) => {
    const { query } = JSON.parse(init.body)
    if (query.startsWith('query LinearWakeIssue(')) return Response.json({ data: { viewer: { id: 'viewer-auma' }, issue: { id: 'issue-463', identifier: 'YOURTEAM-463', title: 'x', url: 'https://linear.app/x', updatedAt: '2026-11-14T00:00:00.000Z',
      state: { name: 'Todo' }, assignee: { id: 'viewer-auma' }, labels: { nodes: [] }, description: '', comments: { nodes: [] } } } })
    if (query.startsWith('mutation LinearDoorComment')) return Response.json({ data: { commentCreate: { success: true, comment: { id: 'comment-new', url: 'https://linear.app/c', createdAt: '2026-11-14T00:00:00.000Z' } } } })
    return undefined
  }
  const { head, storage } = world({ answer: linear })
  const first = await act(head, 'act_linear_comment', { issue: 'YOURTEAM-463', body: 'Step done.' })
  assert.equal(first.ok, true, JSON.stringify(first))
  const second = await act(head, 'act_linear_comment', { issue: 'YOURTEAM-463', body: 'Again.' })
  assert.equal(second.code, 'CLOUD_WAKE_ACT_COMMENT_LIMIT')
  assert.equal(receiptsOf(storage).length, 1)
})

test('the step\'s fence runs INSIDE the spend: a step already overtaken, a stopped wish, a wish naming no mandate, or the step\'s own fence firing spends nothing and sends nothing', async () => {
  const situations = [
    ['overtaken (the step finished elsewhere)', { wish: wishOf({ stepsCompleted: 1 }) }, {}],
    ['stopped', { wish: wishOf({ status: 'stopped' }) }, {}],
    ['no mandate on the wish now', { wish: wishOf({ mandateId: undefined }) }, {}],
    ['the step\'s own fence', {}, { fence: async tx => { assert.equal(typeof tx.get, 'function', 'the fence gets the spend\'s transaction'); throw new Error('CLOUD_WAKE_FENCED') } }],
  ]
  for (const [name, options, extra] of situations) {
    const { head, storage, requests } = world(options)
    await assert.rejects(act(head, 'act_branch_create', { branch: 'auma/sandbox/wake3-try' }, extra), /CLOUD_WAKE_FENCED/, name)
    assert.deepEqual(receiptsOf(storage), [], `${name}: zero spend`)
    assert.equal(requests.length, 0, `${name}: zero upstream`)
    assert.equal(await storage.get(WAKE_ACT_STEP_KEY), undefined, `${name}: nothing counted`)
  }
})

// ------------------------------------------------------------------------------------------------- finding 2: signal

/** A fetch that never answers until its request's signal aborts. */
const hanging = sent => (_url, init = {}) => new Promise((_resolve, reject) => {
  sent.push(JSON.parse(init.body).query.split('(')[0])
  init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
})

test('the Linear and relay reads and the comment stop when the step\'s signal aborts (not after their own 8 s), and an aborted comment is never sent', async () => {
  const env = { LINEAR_API_KEY: ENV.LINEAR_API_KEY }
  const timed = async run => { const controller = new AbortController(), started = Date.now(); setTimeout(() => controller.abort(new Error('CLOUD_WAKE_DEADLINE')), 20); const out = await run(controller.signal); return { out, ms: Date.now() - started } }
  const sent = []
  const read = await timed(signal => linearWakeRead(WAKE_LINEAR_READER, { action: 'issues' }, env, { fetchImpl: hanging(sent), signal }))
  assert.equal(read.out.ok, false)
  assert.ok(read.ms < 2000, `linearWakeRead ended with the step (${read.ms} ms)`)
  const relay = await timed(signal => relayWakeRead(WAKE_RELAY_READER, {}, env, { fetchImpl: hanging(sent), signal }))
  assert.equal(relay.out.ok, false)
  assert.ok(relay.ms < 2000, `relayWakeRead ended with the step (${relay.ms} ms)`)
  const request = { act: 'linear_comment', issue: 'YOURTEAM-463', body: 'Step done.' }
  const comment = await timed(signal => linearWakeComment(WAKE_LINEAR_COMMENTER, { issue: 'YOURTEAM-463', body: 'Step done.', requestId: 'wake3-request-000001',
    spent: receiptFor(request, 'linear.comment', 'linearComments') }, env, { fetchImpl: hanging(sent), signal }))
  assert.equal(comment.out.ok, false)
  assert.equal(comment.out.dispatched, false, 'the read was cut, so the write never left')
  assert.ok(comment.ms < 2000, `linearWakeComment ended with the step (${comment.ms} ms)`)
  assert.equal(sent.some(name => name.startsWith('mutation')), false)
  // HEAD's own read passes its step signal on.
  const { head } = world({ linearFetch: hanging(sent) })
  const viaHead = await timed(signal => head.wakeTalkRead('linear', undefined, { now: T0, actState: freshState(), signal }))
  assert.equal(viaHead.out.ok, false)
  assert.ok(viaHead.ms < 2000, `HEAD's linearRead ended with the step (${viaHead.ms} ms)`)
})

// --------------------------------------------------------------------------------------- finding 3: principal and proof

test('the reader can never write, and every act needs HEAD\'s receipt for its exact bytes: none, other bytes or another mandate refuse before any request', async () => {
  const env = { LINEAR_API_KEY: ENV.LINEAR_API_KEY }
  let calls = 0
  const counting = async () => { calls++; throw new Error('no request') }
  const comment = { issue: 'YOURTEAM-463', body: 'Step done.', requestId: 'wake3-request-000001' }
  const paid = receiptFor({ act: 'linear_comment', issue: 'YOURTEAM-463', body: 'Step done.' }, 'linear.comment', 'linearComments')
  assert.equal((await linearWakeComment(WAKE_LINEAR_READER, { ...comment, spent: paid }, env, { fetchImpl: counting })).code, 'LINEAR_WAKE_COMMENTER_REQUIRED')
  for (const spent of [undefined, { ...paid, actionSha256: sha256('other bytes') }, { ...paid, use: 'relayPosts' }, { ...paid, kind: 'issue' }]) {
    assert.equal((await linearWakeComment(WAKE_LINEAR_COMMENTER, { ...comment, spent }, env, { fetchImpl: counting })).code, 'LINEAR_WAKE_SPEND_REQUIRED')
  }
  const principal = { type: 'wake-mandate', mandateId: MANDATE }
  const branch = { act: 'branch_create', branch: 'auma/sandbox/wake3-try' }
  const good = receiptFor(branch, 'repo.write.branch', 'branchCreates')
  for (const spent of [undefined, { ...good, actionSha256: sha256(canonicalJson({ ...branch, branch: 'auma/sandbox/other' })) }, { ...good, mandateId: 'mandate-wake3-000000002' },
    { ...good, use: 'commits' }, receiptFor(branch, 'exec.run', 'execJob')]) {
    const out = await cloudWakeMandateAct(principal, branch, ENV, { seedId: SEED, networkFetch: counting, signal: new AbortController().signal, spent })
    assert.deepEqual(out, { ok: false, code: 'WAKE_MANDATE_SPEND_REQUIRED', dispatched: false })
  }
  assert.equal(calls, 0, 'nothing left without a matching receipt')
  const withReceipt = await cloudWakeMandateAct(principal, branch, ENV, { seedId: SEED, networkFetch: counting, signal: new AbortController().signal, spent: good })
  assert.notEqual(withReceipt.code, 'WAKE_MANDATE_SPEND_REQUIRED', 'the matching receipt lets the act go on')
})

// ----------------------------------------------------------------------------------------- finding 4: a pending merge

test('a card while a merge is pending or its outcome unknown is refused REPO_MERGE_PENDING BEFORE the spend', async () => {
  for (const extra of [[['head:repo-merge-attempt', { status: 'claimed' }]], [['head:last-repo-merge-outcome', { status: 'unknown' }]]]) {
    const { head, storage, requests } = world({ extra })
    const out = await act(head, 'act_stage_proposal', STAGE)
    assert.equal(out.code, 'REPO_MERGE_PENDING')
    assert.deepEqual(receiptsOf(storage), [], 'no card use spent')
    assert.equal(requests.length, 0)
  }
})

// ---------------------------------------------------------------------------------- finding 5: the three success paths

test('commit: receipt first, one compare-and-swap commit on her branch, outcome row done with the new head', async () => {
  const github = githubFake()
  const { head, storage, events, fetchImpl } = world({ answer: github.answer })
  const out = await act(head, 'act_commit', COMMIT, { networkFetch: fetchImpl })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.headSha, NEXT_SHA)
  assert.deepEqual(out.paths, ['docs/auma/notes-wake3.md'])
  assertReceiptFirst(events, storage)
  assert.equal((await storage.get(receiptsOf(storage)[0])).use, 'commits')
  const [outcome] = outcomesOf(storage)
  assert.deepEqual([outcome.status, outcome.act, outcome.headSha, outcome.branch], ['done', 'commit', NEXT_SHA, 'auma/sandbox/wake3-try'])
  assert.equal(github.refs.get('auma/sandbox/wake3-try'), NEXT_SHA)
  assert.equal(github.refs.get('main'), MAIN_SHA, 'main never moves')
})

test('apply_patch: receipt first, the patch applied in one commit on her branch, outcome row done with the new head', async () => {
  const github = githubFake()
  const { head, storage, events, fetchImpl } = world({ answer: github.answer })
  const out = await act(head, 'act_apply_patch', PATCH, { networkFetch: fetchImpl })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.headSha, NEXT_SHA)
  assert.deepEqual(out.files, [{ path: 'docs/auma/notes-wake3.md', status: 'added' }])
  assertReceiptFirst(events, storage)
  const [outcome] = outcomesOf(storage)
  assert.deepEqual([outcome.status, outcome.act, outcome.headSha], ['done', 'apply_patch', NEXT_SHA])
  assert.deepEqual(github.mutations, ['mutation X61Publish'])
})

test('stage_proposal: receipt first, the card stored by HEAD for his tap (bound to this origin), outcome row done; never a merge', async () => {
  const github = githubFake()
  const { head, storage, events, fetchImpl, requests } = world({ answer: github.answer })
  const out = await act(head, 'act_stage_proposal', STAGE, { networkFetch: fetchImpl })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.headSha, HER_SHA)
  assert.equal(out.changedFiles, 1)
  assertReceiptFirst(events, storage)
  assert.equal((await storage.get(receiptsOf(storage)[0])).use, 'proposalStages')
  const card = await storage.get('head:staged-repo-proposal')
  assert.equal(card.branch, STAGE.branch)
  assert.equal(card.headSha, HER_SHA)
  assert.equal(card.baseSha, MAIN_SHA)
  assert.equal(card.binding.audience, new URL(ORIGIN).origin, 'his passkey approval binds to this origin')
  assert.equal(card.binding.pathname, '/_host/repo')
  assert.deepEqual(card.changedFiles.map(file => [file.path, file.status]), [['docs/auma/card.md', 'added']])
  // The card HEAD stored is one its own status read accepts (the same validRepoProposal judgement).
  const status = await head.fetch(new Request(ORIGIN + '/_head/promotion-status', { method: 'GET', headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED,
    'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }) } }))
  const staged = await status.json()
  assert.equal(status.status, 200, JSON.stringify(staged))
  assert.equal(staged.stagedRepoProposal?.branch, STAGE.branch, JSON.stringify(staged).slice(0, 400))
  const [outcome] = outcomesOf(storage)
  assert.deepEqual([outcome.status, outcome.act, outcome.headSha], ['done', 'stage_proposal', HER_SHA])
  assert.deepEqual(github.mutations, [], 'nothing written to GitHub')
  assert.equal(requests.some(request => request.method !== 'GET'), false, 'staging only reads GitHub')
})

// --------------------------------------------------------------------------------------- finding 6b: reasoning field

test('reasoning_content on an assistant turn is admitted on the wake\'s own path only; every browser provider door still refuses it', () => {
  const limits = providerBudgetLimits(BUDGET)
  const body = new TextEncoder().encode(JSON.stringify({ model: 'deepseek-reasoner', max_tokens: 100, messages: [{ role: 'user', content: 'hi' },
    { role: 'assistant', content: null, reasoning_content: 'thinking', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'inspectHeadWish', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{}' }] }))
  assert.throws(() => providerRequestReservation(body, limits, '/v1/chat/completions'), 'a browser door refuses the field')
  assert.throws(() => providerRequestReservation(body, limits, '/v1/chat/completions', {}), 'no option, no field')
  assert.equal(providerRequestReservation(body, limits, '/v1/chat/completions', { assistantReasoning: true }).requestedModel, 'deepseek-reasoner')
  const onUser = new TextEncoder().encode(JSON.stringify({ model: 'deepseek-reasoner', max_tokens: 100, messages: [{ role: 'user', content: 'hi', reasoning_content: 'x' }] }))
  assert.throws(() => providerRequestReservation(onUser, limits, '/v1/chat/completions', { assistantReasoning: true }), 'never on a user turn')
})

// ------------------------------------------------------------------------------------------ finding 7: runner bounds

test('a runner job over the durable day or pick bound is refused BEFORE the mandate is spent (no receipt, no reservation)', async () => {
  const prefix = `aum456:budget:v1:${JSON.stringify(['owner', 'node-main-v1'])}:`
  const dayStart = Math.floor(T0 / 86400000) * 86400000
  const pickId = 'wake:' + sha256('wish-wake3-1').slice(0, 40)
  const EXEC = { ref: 'auma/sandbox/wake3-try', command: 'node -v', timeout_minutes: 5, label: 'wake3-check' }
  for (const [extra, code] of [[[[`${prefix}day:${dayStart}`, { runnerMinutes: 598, wakeModelCalls: 0, wakeExhaustionNoted: false }]], 'EXEC_RATE_LIMITED'],
    [[[`${prefix}pick:${pickId}`, { runnerMinutes: 0, runnerJobs: 8, commits: 0, cards: 0, wakeSteps: 0 }]], 'PICK_RATE_LIMITED']]) {
    const { head, storage, requests } = world({ extra })
    const out = await act(head, 'act_exec_start', EXEC)
    assert.equal(out.code, code)
    assert.deepEqual(receiptsOf(storage), [], `${code}: the mandate is not spent`)
    assert.equal([...storage.snapshot().keys()].some(key => key.includes(':request:wake3-')), false, `${code}: no reservation`)
    assert.equal(requests.length, 0)
  }
})

// Last in this file: it fills execDoor's in-memory hour bound for the wake actor, which lives for the whole process.
test('a runner job over execDoor\'s in-memory hour bound is refused BEFORE the mandate is spent (no receipt, no reservation)', async () => {
  const principal = { type: 'wake-mandate', mandateId: MANDATE }
  const EXEC = { ref: 'auma/sandbox/wake3-try', command: 'node -v', timeout_minutes: 1, label: 'wake3-fill' }
  const request = { act: 'exec_start', ...EXEC }
  const dispatch = async () => new Response(null, { status: 204 })
  assert.equal(wakeExecRateRefusal(T0), null)
  for (let index = 0; index < 60; index++) {
    const out = await cloudWakeMandateAct(principal, request, ENV, { seedId: SEED, networkFetch: dispatch, signal: new AbortController().signal, now: () => T0,
      runnerPickScope: createRunnerPickScope('fixture-hour', { requestId: 'fixture-hour-' + String(index).padStart(4, '0'),
        reserveLocal: async () => ({ dispatch: true }) }),
      spent: receiptFor(request, 'exec.run', 'execJob', { execRuns: 1, execMinutes: 1 }) })
    assert.equal(out.ok, true, JSON.stringify(out))
  }
  assert.equal(wakeExecRateRefusal(T0).code, 'EXEC_RATE_LIMITED')
  const { head, storage, requests } = world()
  const out = await act(head, 'act_exec_start', EXEC)
  assert.equal(out.code, 'EXEC_RATE_LIMITED')
  assert.ok(Number.isSafeInteger(out.retryAt))
  assert.deepEqual(receiptsOf(storage), [], 'the mandate is not spent')
  assert.equal([...storage.snapshot().keys()].some(key => key.startsWith('aum456:budget:v1:')), false, 'no runner minutes reserved')
  assert.equal(requests.length, 0)
})

// ---- HANDS block begin: the wake commit passes facts: false, so it never reads an old file for them ----
test('a wake commit of an existing file reads no old file (facts: false) and answers headSha and paths only', async () => {
  const github = githubFake()
  const { head, requests, fetchImpl } = world({ answer: github.answer })
  const out = await act(head, 'act_commit', { ...COMMIT, changes: [{ path: 'docs/auma/a.md', content: 'two\n' }] }, { networkFetch: fetchImpl })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.headSha, NEXT_SHA)
  assert.deepEqual(out.paths, ['docs/auma/a.md'])
  assert.equal(Object.hasOwn(out, 'changes'), false)
  assert.deepEqual(requests.filter(request => request.url.pathname.includes('/contents/')).map(request => request.url.pathname), [], 'no old-file read')
})
// ---- HANDS block end ----
