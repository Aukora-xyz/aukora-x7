/** Her no-tab acts under the owner's mandate. Every act is paid from the mandate FIRST, on her
 * own branches only, through a principal of its own (never an owner-shaped access). Synthetic storage, a made-up model,
 * GitHub and Linear: no network, no credential, no real run. RT-MANDATE-1, RT-WAKE-1 and RT-WAKE-2 are the review's
 * reproducers, kept here with credit. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, CLOUD_WAKE_ACT_TOOL_NAMES, CLOUD_WAKE_ACT_LIMITS, cloudWakeActToolNames, cloudWakeToolNames, cloudWakeActOffer, cloudWakeCause } from '../head-do.mjs'
import { OWNER_MANDATE_KEY, OWNER_MANDATE_RECORD_SCHEMA, OWNER_MANDATE_SCHEMA, OWNER_MANDATE_DEFAULT_PER_DAY, OWNER_MANDATE_SCOPES, ownerMandateState,
  ownerMandateCovers, ownerMandateCountKey, ownerMandateDay } from '../owner-mandate.mjs'
import { cloudWakeMandateAct, cloudWakeMandateActShape, handleCloudBroker, CLOUD_WAKE_MANDATE_ACTS } from '../cloud-brokers.mjs'
import { CLOUD_WAKE_EVIDENCE_TOOLS } from '../wake-evidence.mjs'
import { linearWakeRead, linearWakeComment, WAKE_LINEAR_READER } from '../linear-door.mjs'
import { relayWakeRead, WAKE_RELAY_READER } from '../crew-relay.mjs'

const ORIGIN = 'https://wake3.example.invalid'
const OWNER = 'owner@example.invalid'
const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64)
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0)
const MANDATE = 'mandate-wake3-000000001'
const OTHER = 'mandate-wake3-000000002'
const MAIN_SHA = '1'.repeat(40), HER_SHA = '2'.repeat(40)
const GH = 'github-synthetic-credential-0000'
const BUDGET = { PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '1000', PROVIDER_BUDGET_TOKENS: '1000000', PROVIDER_MAX_OUTPUT_TOKENS: '4096' }
const ENV = { WAKE_EXECUTOR_ENABLED: '1', WAKE_ACTS_ENABLED: '1', CLOUD_WAKE_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'deepseek-synthetic-key', GITHUB_TOKEN: GH,
  LINEAR_API_KEY: 'lin-synthetic-key-0000', PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, ...BUDGET }

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

const terms = (id = MANDATE, extra = {}) => ({ schema: OWNER_MANDATE_SCHEMA, id, principal: 'owner', agent: 'auma', scopes: [...OWNER_MANDATE_SCOPES],
  perDay: { ...OWNER_MANDATE_DEFAULT_PER_DAY }, issuedAt: T0 - 60000, expiresAt: T0 + 86400000, nonce: 'nonce-wake3-0000001', ...extra })
const mandateRecord = (id = MANDATE, extra = {}, termsExtra = {}) => ({ schema: OWNER_MANDATE_RECORD_SCHEMA, terms: terms(id, termsExtra), termsSha256: 'c'.repeat(64),
  issuedAt: T0 - 60000, revokedAt: null, replaces: null, ...extra })
const wishOf = (extra = {}) => ({ wish_id: 'wish-wake3-1', intent: 'Fix one thing on her branch', acceptance: 'A commit on her branch', status: 'running',
  stepsCompleted: 0, maxSteps: 4, mandateId: MANDATE, ...extra })

/** The seven mandate conditions every act is refused under, with the code each answers. */
const CONDITIONS = Object.freeze({
  'no mandate': { record: null, code: 'MANDATE_REQUIRED' },
  expired: { record: mandateRecord(MANDATE, {}, { issuedAt: T0 - 86400000, expiresAt: T0 - 1 }), code: 'MANDATE_EXPIRED' },
  revoked: { record: mandateRecord(MANDATE, { revokedAt: T0 - 5 }), code: 'MANDATE_REVOKED' },
  'malformed stored': { record: { schema: OWNER_MANDATE_RECORD_SCHEMA, terms: {}, revokedAt: null }, code: 'MANDATE_STATE_INVALID' },
  "another mandate's id": { record: mandateRecord(OTHER), code: 'MANDATE_ID_MISMATCH' },
})

/** A HEAD with a made-up world; every request (model, GitHub, Linear) is recorded in order with storage puts. */
function world({ env = {}, record = mandateRecord(), wish = wishOf(), extra = [], answer, clock } = {}) {
  const events = []
  const initial = [['bootstrap:v1', { phase: 'complete', seedId: SEED }], ['head:current', { ballId: BALL, epoch: 176, entries: { organ: {} } }]]
  if (wish !== null) initial.push(['head:wish:active', wish])
  if (record !== null) initial.push([OWNER_MANDATE_KEY, record]) // null: no mandate stored
  const storage = memoryStorage([...initial, ...extra], events)
  const requests = []
  const fetchImpl = async (raw, init = {}) => {
    const url = new URL(typeof raw === 'string' ? raw : raw.url)
    const body = typeof init.body === 'string' ? init.body : undefined
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries())
    requests.push({ method: init.method ?? 'GET', url, body, headers })
    events.push({ kind: 'fetch', host: url.host, path: url.pathname, method: init.method ?? 'GET' })
    const value = answer ? await answer(url, init, body) : undefined
    if (value !== undefined) return value
    throw new Error('Unexpected synthetic request ' + (init.method ?? 'GET') + ' ' + url.href)
  }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, { ...ENV, ...env },
    { now: () => T0, wakeLinearFetch: fetchImpl, ...(clock ? { wakeActClock: clock } : {}) })
  head.broadcast = async () => {}
  return { head, storage, events, requests, fetchImpl }
}

const receiptsOf = storage => [...storage.snapshot().keys()].filter(key => key.startsWith(`${OWNER_MANDATE_KEY}:use:`))
const outcomesOf = storage => [...storage.snapshot()].filter(([key]) => key.startsWith('head:wake-act-outcome:')).map(([, value]) => value)
const ACT_ARGS = Object.freeze({
  act_branch_create: { branch: 'auma/sandbox/wake3-try' },
  act_commit: { branch: 'auma/sandbox/wake3-try', expectedHeadSha: HER_SHA, message: 'docs: one line', changes: [{ path: 'docs/auma/notes-wake3.md', content: 'one line\n' }] },
  act_apply_patch: { branch: 'auma/sandbox/wake3-try', baseSha: HER_SHA, message: 'docs: one line', patch: 'diff --git a/docs/auma/notes-wake3.md b/docs/auma/notes-wake3.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/auma/notes-wake3.md\n@@ -0,0 +1 @@\n+one line\n' },
  act_exec_start: { ref: 'auma/sandbox/wake3-try', command: 'node -v', timeout_minutes: 5, label: 'wake3-check' },
  act_stage_proposal: { branch: 'auma/proposal/wake3-card', title: 'One small fix' },
  act_linear_comment: { issue: 'YOURTEAM-463', body: 'Step done: one commit on my sandbox branch.' },
})
const freshState = () => ({ acts: 0, linearComments: 0, readableIssues: new Set(['YOURTEAM-463']) })
const act = (head, tool, { offer = { offered: true, cause: null, mandateId: MANDATE }, actState = freshState(), stepDeadlineAt = Date.now() + 30000, networkFetch } = {}) =>
  head.runWakeAct({ tool, args: structuredClone(ACT_ARGS[tool]), offer, actState, wishId: 'wish-wake3-1', step: 1, seedId: SEED, signal: new AbortController().signal,
    networkFetch: networkFetch ?? (async () => { throw new Error('no upstream request may leave') }), stepDeadlineAt, admitNow: () => T0 })

// ---------------------------------------------------------------------------------------------------------------- item 0

test('RT-MANDATE-1: a malformed stored mandate fails closed MANDATE_STATE_INVALID (503) from state, use, exec-job use, check and read', async () => {
  const bad = { schema: OWNER_MANDATE_RECORD_SCHEMA, terms: {}, revokedAt: null }
  assert.equal(ownerMandateState(bad, T0), 'invalid')
  assert.equal(ownerMandateState(undefined, T0), 'missing')
  assert.equal(ownerMandateState(mandateRecord(), T0), 'active')
  for (const scope of ['repo.read', 'repo.write.branch']) assert.deepEqual({ ...ownerMandateCovers({ record: bad, scope, now: T0 }) }, { ok: false, code: 'MANDATE_STATE_INVALID', status: 503 })
  for (const malformed of [{ ...mandateRecord(), terms: { ...terms(), perDay: {} } }, { ...mandateRecord(), terms: { ...terms(), expiresAt: 'soon' } },
    { ...mandateRecord(), terms: { ...terms(), scopes: ['merge'] } }, { ...mandateRecord(), revokedAt: 'never' }, { schema: 'other', terms: terms() }]) {
    assert.equal(ownerMandateState(malformed, T0), 'invalid')
  }
  const { head } = world({ record: bad })
  assert.deepEqual(await head.store.useOwnerMandate({ scope: 'repo.write.branch', kind: 'commits', units: 1, actionSha256: 'ab'.repeat(32) }), { ok: false, code: 'MANDATE_STATE_INVALID', status: 503 })
  assert.deepEqual(await head.store.useOwnerMandateExecJob({ minutes: 5, actionSha256: 'ab'.repeat(32) }), { ok: false, code: 'MANDATE_STATE_INVALID', status: 503 })
  assert.deepEqual(await head.store.checkOwnerMandate({ scope: 'repo.read' }), { ok: false, code: 'MANDATE_STATE_INVALID', status: 503 })
  assert.equal((await head.store.readOwnerMandate()).code, 'MANDATE_STATE_INVALID')
  const response = await head.fetch(new Request(ORIGIN + '/_head/mandate', { method: 'GET', headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED,
    // The route checks the session against the real clock (head-do.mjs ownerMandateRoute), so the fixture's session must not be pinned to T0:
    // it expired for good at T0 + 1 h and the case then answered 403 before it reached the mandate.
    'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }) } }))
  assert.equal(response.status, 503, 'the route passes 503 through, never 403')
  assert.equal((await response.json()).code, 'MANDATE_STATE_INVALID')
})

test('RT-WAKE-1: a 402 (no balance) is named: provider_refused with httpStatus 402 (the review expected provider_http_error; the closed word stays provider_refused)', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402, headers: { 'content-type': 'application/json' } }))
  const { head, storage } = world({ wish: wishOf({ mandateId: undefined }) })
  const out = await head.executeCloudWakeStep({ now: T0, forceWishStep: true })
  assert.equal(out.reason, 'provider_refused')
  assert.equal(out.cause, 'provider_refused')
  assert.equal(out.httpStatus, 402)
  const wish = await storage.get('head:wish:active')
  assert.equal(wish.steps.length, 1)
  assert.equal(wish.stepFailures.at(-1).httpStatus, 402)
  assert.deepEqual(cloudWakeCause({ code: 'PROVIDER_HTTP_ERROR', status: 402 }), { cause: 'provider_refused', statusClass: '4xx', httpStatus: 402 })
})

test('RT-WAKE-2: a thinking model gets its reasoning_content back on round 2 of the same step, and it is never journaled', async t => {
  let round = 0
  const SECRETLESS = 'Need to inspect head wish metadata before writing a note.'
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body)
    if (round++ === 0) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: SECRETLESS,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'inspectHeadWish', arguments: '{}' } }] } }] })
    const prev = body.messages.find(msg => msg.role === 'assistant' && Array.isArray(msg.tool_calls))
    if (typeof prev?.reasoning_content !== 'string') return new Response(JSON.stringify({ error: { message: 'Missing reasoning_content' } }), { status: 400 })
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Inspected wish metadata without claiming completion.' } }] })
  })
  const { head, storage } = world({ env: { CLOUD_MODEL_DEEPSEEK: 'deepseek-reasoner' }, wish: wishOf({ mandateId: undefined }) })
  const out = await head.executeCloudWakeStep({ now: T0, forceWishStep: true })
  assert.equal(out.status, 'success')
  const journal = [...storage.snapshot()].filter(([key]) => key.startsWith('head:transcript:row:')).map(([, row]) => row.content).join('\n')
  assert.ok(journal.length > 0)
  assert.equal(journal.includes(SECRETLESS), false, 'her reasoning never reaches the transcript')
  assert.equal(JSON.stringify(await storage.get('head:wish:active')).includes(SECRETLESS), false, 'nor the wish')
})

// ------------------------------------------------------------------------------------------------------- items 1 and 2

test('every act is refused with no mandate, expired, revoked, malformed, another mandate\'s id: closed code, zero upstream, zero spend', async () => {
  for (const tool of CLOUD_WAKE_ACT_TOOL_NAMES) {
    for (const [name, condition] of Object.entries(CONDITIONS)) {
      const { head, storage, requests } = world({ record: condition.record })
      const out = await act(head, tool)
      assert.equal(out.ok, false, `${tool} ${name}`)
      assert.equal(out.code, condition.code, `${tool} ${name}`)
      assert.equal(requests.length, 0, `${tool} ${name}: zero upstream`)
      assert.deepEqual(receiptsOf(storage), [], `${tool} ${name}: zero spend`)
      assert.deepEqual(outcomesOf(storage), [], `${tool} ${name}: nothing acted`)
    }
  }
})

test('every act is refused over its day count (MANDATE_BOUND_REACHED, retryAt) and with the switch off (acts_disabled): zero upstream, zero new spend', async () => {
  const day = ownerMandateDay(T0)
  const full = { schema: 'aukora.owner-mandate.count.v1', mandateId: MANDATE, day, seq: 40, ...Object.fromEntries(Object.entries(OWNER_MANDATE_DEFAULT_PER_DAY)) }
  for (const tool of CLOUD_WAKE_ACT_TOOL_NAMES) {
    const over = world({ extra: [[ownerMandateCountKey(MANDATE, day), full]] })
    const out = await act(over.head, tool)
    assert.equal(out.code, 'MANDATE_BOUND_REACHED', tool)
    assert.ok(Number.isSafeInteger(out.retryAt), tool)
    assert.equal(over.requests.length, 0, tool)
    assert.deepEqual(receiptsOf(over.storage), [], tool)
    assert.deepEqual((await over.storage.get(ownerMandateCountKey(MANDATE, day))), full, `${tool}: the count does not move`)
    const off = world({ env: { WAKE_ACTS_ENABLED: '0' } })
    const refused = await act(off.head, tool)
    assert.equal(refused.code, 'WAKE_ACTS_DISABLED', tool)
    assert.equal(refused.cause, 'acts_disabled', tool)
    assert.equal(off.requests.length, 0, tool)
    assert.deepEqual(receiptsOf(off.storage), [], tool)
  }
})

test('refused by shape before any spend: not her branch, main, a frozen path, a ref that is not her branch, an unread issue, a second comment, a fourth act, and no time left', async () => {
  const cases = [
    ['act_branch_create', { branch: 'feature/not-hers' }, 'REPO_BRANCH_REFUSED'],
    ['act_branch_create', { branch: 'main' }, 'REPO_BRANCH_REFUSED'],
    ['act_commit', { ...ACT_ARGS.act_commit, branch: 'main' }, 'REPO_BRANCH_REFUSED'],
    ['act_commit', { ...ACT_ARGS.act_commit, changes: [{ path: 'deploy/cloudflare/src/head-do.mjs', content: 'x' }] }, null],
    ['act_commit', { ...ACT_ARGS.act_commit, changes: [{ path: '.github/workflows/x.yml', content: 'x' }] }, 'REPO_WORKFLOW_PATH_REFUSED'],
    ['act_apply_patch', { ...ACT_ARGS.act_apply_patch, patch: 'diff --git a/deploy/ci/frozen-paths.mjs b/deploy/ci/frozen-paths.mjs\n--- a/deploy/ci/frozen-paths.mjs\n+++ b/deploy/ci/frozen-paths.mjs\n@@ -1 +1 @@\n-a\n+b\n' }, null],
    ['act_exec_start', { ...ACT_ARGS.act_exec_start, ref: 'main' }, 'EXEC_REF_INVALID'],
    ['act_exec_start', { ...ACT_ARGS.act_exec_start, ref: MAIN_SHA }, 'EXEC_REF_INVALID'],
    ['act_exec_start', { ...ACT_ARGS.act_exec_start, timeout_minutes: 31 }, 'EXEC_TIMEOUT_INVALID'],
    ['act_stage_proposal', { branch: 'auma/sandbox/not-a-proposal', title: 'x' }, 'REPO_BRANCH_REFUSED'],
  ]
  for (const [tool, args, code] of cases) {
    const { head, storage, requests } = world()
    const out = await head.runWakeAct({ tool, args, offer: { offered: true, cause: null, mandateId: MANDATE }, actState: freshState(), wishId: 'wish-wake3-1', step: 1, seedId: SEED,
      signal: new AbortController().signal, networkFetch: async () => { throw new Error('no request') }, stepDeadlineAt: Date.now() + 30000, admitNow: () => T0 })
    assert.equal(out.ok, false, tool)
    if (code) assert.equal(out.code, code, `${tool} ${JSON.stringify(args).slice(0, 60)}`)
    else assert.match(out.code, /^(?:PROPOSAL|REPO)_[A-Z_]+$/, `${tool}: the frozen-path judgement refuses ${out.code}`)
    assert.equal(requests.length, 0, tool)
    assert.deepEqual(receiptsOf(storage), [], tool)
  }
  const unread = world()
  assert.equal((await act(unread.head, 'act_linear_comment', { actState: { ...freshState(), readableIssues: new Set() } })).code, 'LINEAR_ISSUE_NOT_READABLE')
  const second = world()
  assert.equal((await act(second.head, 'act_linear_comment', { actState: { ...freshState(), linearComments: 1, acts: 1 } })).code, 'CLOUD_WAKE_ACT_COMMENT_LIMIT')
  const fourth = world()
  assert.equal((await act(fourth.head, 'act_branch_create', { actState: { ...freshState(), acts: CLOUD_WAKE_ACT_LIMITS.perStep } })).code, 'CLOUD_WAKE_ACT_LIMIT')
  const late = world()
  const timedOut = await act(late.head, 'act_branch_create', { stepDeadlineAt: Date.now() + 1000 })
  assert.equal(timedOut.code, 'STEP_TIMEOUT')
  assert.equal(timedOut.cause, 'step_timeout')
  for (const each of [unread, second, fourth, late]) {
    assert.equal(each.requests.length, 0)
    assert.deepEqual(receiptsOf(each.storage), [])
  }
})

test('staging over a DIFFERENT branch\'s card is refused before any spend; her own branch\'s card may be replaced (stageWakeProposal)', async () => {
  const card = { branch: 'auma/proposal/someone-else' }
  const { head, storage, requests } = world({ extra: [['head:staged-repo-proposal', card]] })
  const out = await act(head, 'act_stage_proposal')
  assert.equal(out.code, 'PROPOSAL_ALREADY_STAGED')
  assert.equal(requests.length, 0)
  assert.deepEqual(receiptsOf(storage), [])
  assert.deepEqual(await storage.get('head:staged-repo-proposal'), card, 'his card is untouched')
})

/** A made-up GitHub for branch_create: the branch is new, main is at MAIN_SHA, the ref update succeeds (or fails). */
function githubForBranchCreate({ refUpdateFails = false } = {}) {
  let created = false
  return async (url, init, body) => {
    if (url.host === 'api.deepseek.com') return undefined
    if (url.host !== 'api.github.com') return undefined
    const path = url.pathname
    if (path === '/repos/your_org_x/your-node/git/ref/heads/auma/sandbox/wake3-try') return created ? Response.json({ ref: 'refs/heads/auma/sandbox/wake3-try', object: { type: 'commit', sha: MAIN_SHA } }) : new Response('{}', { status: 404 })
    if (path === '/repos/your_org_x/your-node/git/ref/heads/main') return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: MAIN_SHA } })
    if (path === '/repos/your_org_x/your-node') return Response.json({ full_name: 'your_org_x/your-node', default_branch: 'main', node_id: 'R_synthetic' })
    if (path === '/graphql' && init.method === 'POST') {
      if (refUpdateFails) return new Response('{}', { status: 500 })
      created = true
      return Response.json({ data: { updateRefs: { clientMutationId: JSON.parse(body).variables.input.clientMutationId } } })
    }
    return undefined
  }
}

test('branch_create: the use receipt is written BEFORE the first upstream request; the act goes through; an outcome row is kept; no owner-shaped object reaches a fake', async () => {
  const answer = githubForBranchCreate()
  const { head, storage, events, requests, fetchImpl } = world({ answer })
  const out = await act(head, 'act_branch_create', { networkFetch: fetchImpl })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.headSha, MAIN_SHA)
  assert.deepEqual(out.mandateUse.seq, 1)
  const receiptAt = events.findIndex(event => event.kind === 'put' && event.key.startsWith(`${OWNER_MANDATE_KEY}:use:${MANDATE}:`))
  const firstFetch = events.findIndex(event => event.kind === 'fetch')
  assert.ok(receiptAt >= 0 && firstFetch > receiptAt, 'receipt first, then GitHub')
  const [receiptKey] = receiptsOf(storage)
  const receipt = await storage.get(receiptKey)
  assert.equal(receipt.scope, 'repo.write.branch')
  assert.equal(receipt.use, 'branchCreates')
  const [outcome] = outcomesOf(storage)
  assert.equal(outcome.status, 'done')
  assert.equal(outcome.act, 'branch_create')
  assert.equal(outcome.headSha, MAIN_SHA)
  assert.equal(outcome.receiptKey, receiptKey)
  for (const request of requests) {
    const seen = JSON.stringify({ body: request.body ?? null, headers: request.headers })
    assert.equal(/"type":"(?:owner|access)"/.test(seen), false, 'no owner-shaped access is ever built on the wake path')
    assert.equal(Object.hasOwn(request.headers, 'x-x6-verified-access'), false)
  }
  assert.ok(requests.some(request => request.url.pathname === '/graphql' && request.body.includes('updateRefs')))
  const read = await head.store.readOwnerMandate()
  assert.equal(read.outcomes.length, 1, 'the mandate read shows the outcome')
})

test('an upstream failure after the spend still keeps an outcome row (unknown when the write may have left); the use is not refunded', async () => {
  const { head, storage, fetchImpl } = world({ answer: githubForBranchCreate({ refUpdateFails: true }) })
  const out = await act(head, 'act_branch_create', { networkFetch: fetchImpl })
  assert.equal(out.ok, false)
  assert.equal(out.outcome, 'unknown')
  assert.equal(receiptsOf(storage).length, 1, 'spent, never refunded')
  const [outcome] = outcomesOf(storage)
  assert.equal(outcome.status, 'unknown')
  assert.match(outcome.code, /^[A-Z_]+$/)
})

test('exec_start: ONE combined runner use (execRuns 1 + its minutes), one runner reservation through execDoor, then one dispatch on her branch (never main)', async () => {
  const answer = async (url, init) => url.host === 'api.github.com' && init.method === 'POST' && url.pathname.endsWith('/actions/workflows/auma-exec.yml/dispatches') ? new Response(null, { status: 204 }) : undefined
  const { head, storage, events, requests, fetchImpl } = world({ answer })
  const out = await act(head, 'act_exec_start', { networkFetch: fetchImpl })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.runName, 'auma-exec wake3-check @ auma/sandbox/wake3-try')
  assert.equal(requests.length, 1)
  const sent = JSON.parse(requests[0].body)
  assert.equal(sent.inputs.ref, 'auma/sandbox/wake3-try')
  assert.equal(sent.inputs.timeout_minutes, '5')
  const [receiptKey] = receiptsOf(storage)
  const receipt = await storage.get(receiptKey)
  assert.deepEqual(receipt.units, { execRuns: 1, execMinutes: 5 })
  const counts = await storage.get(ownerMandateCountKey(MANDATE, ownerMandateDay(T0)))
  assert.equal(counts.execRuns, 1)
  assert.equal(counts.execMinutes, 5)
  const reservations = [...storage.snapshot()].filter(([key]) => key.startsWith('aum456:budget:v1:') && key.includes(':request:wake3-'))
  assert.equal(reservations.length, 1, 'execDoor records exactly one durable runner reservation')
  assert.equal(reservations[0][1].minutes, 5)
  assert.equal(reservations[0][1].kind, 'runner')
  const receiptAt = events.findIndex(event => event.kind === 'put' && event.key === receiptKey)
  assert.ok(receiptAt < events.findIndex(event => event.kind === 'fetch'))
  assert.equal(outcomesOf(storage)[0].runName, out.runName)
})

test('excluded calls are refused for this principal before any request: branch_delete, merge, dispatch_workflow, sync_head_to_github, a write to main, Cloudflare, secrets, relay post, other Linear writes', async () => {
  const principal = { type: 'wake-mandate', mandateId: MANDATE }
  for (const name of ['branch_delete', 'merge_proposal', 'dispatch_workflow', 'sync_head_to_github', 'write', 'edit', 'push', 'release_attempt', 'reconcile_proposal',
    'cloudflare', 'secret_put', 'relay_post', 'linear_issue_create', 'comment_update', 'delete', 'linear_comment']) {
    let calls = 0
    const out = await cloudWakeMandateAct(principal, { act: name, branch: 'auma/sandbox/wake3-try' }, ENV, { seedId: SEED, networkFetch: async () => { calls++; throw new Error('no') }, signal: new AbortController().signal })
    assert.deepEqual(out, { ok: false, code: 'WAKE_ACT_REFUSED', dispatched: false }, name)
    assert.equal(calls, 0, name)
  }
  assert.deepEqual(Object.keys(CLOUD_WAKE_MANDATE_ACTS), ['branch_create', 'commit', 'apply_patch', 'exec_start', 'stage_proposal'])
  // An owner-shaped principal, or any other shape, is not this principal.
  for (const bad of [{ type: 'owner', email: OWNER, expires: T0 / 1000 + 60 }, { type: 'access' }, { type: 'wake-mandate' }, { type: 'wake-mandate', mandateId: MANDATE, extra: 1 }]) {
    assert.throws(() => cloudWakeMandateActShape(bad, { act: 'branch_create', branch: 'auma/sandbox/wake3-try' }, ENV), { code: 'WAKE_MANDATE_PRINCIPAL_INVALID' })
  }
})

test('repo() and the owner-only routes refuse the principal: the broker with a wake-mandate access answers OWNER_SESSION_REQUIRED and sends nothing', async () => {
  for (const input of [{ action: 'branch_create', branch: 'auma/sandbox/wake3-try' }, { action: 'branch_delete', branch: 'auma/sandbox/wake3-try' },
    { action: 'commit', branch: 'auma/sandbox/wake3-try', changes: [{ path: 'docs/x.md', content: 'x' }], message: 'x' }, { action: 'stage_proposal', branch: 'auma/proposal/x1', title: 'x' },
    { action: 'dispatch_workflow', workflow: 'auma-exec.yml', inputs: { ref: 'auma/sandbox/wake3-try', command: 'x', label: 'x1' } }, { action: 'sync_head_to_github' }]) {
    let calls = 0
    const response = await handleCloudBroker(new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify(input) }), ENV, { access: { type: 'wake-mandate', mandateId: MANDATE }, bootstrap: { ready: true, head: { seedId: SEED } },
      networkFetch: async () => { calls++; throw new Error('no') }, now: () => T0 })
    assert.ok(response.status >= 400 && response.status < 500, `${input.action}: ${response.status}`)
    if (input.action !== 'sync_head_to_github') assert.equal((await response.json()).code, 'OWNER_SESSION_REQUIRED', input.action)
    assert.equal(calls, 0, input.action)
  }
  // HEAD's owner route refuses an internal request that carries no owner access.
  const { head } = world()
  const response = await head.fetch(new Request(ORIGIN + '/_head/mandate', { method: 'GET', headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED,
    'x-x6-verified-access': JSON.stringify({ type: 'wake-mandate', mandateId: MANDATE }) } }))
  assert.equal(response.status, 403)
})

// ---------------------------------------------------------------------------------------------------------------- item 3

/** A made-up model: round 1 answers `calls`, round 2 a plain line. Records each request's tool names. */
function scriptedModel(calls) {
  const seen = []
  let round = 0
  return { seen, answer: async (url, init) => {
    if (url.host !== 'api.deepseek.com') return undefined
    const body = JSON.parse(init.body)
    seen.push((body.tools ?? []).map(tool => tool.function.name))
    if (round++ === 0 && calls.length) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls } }] })
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Step done.' } }] })
  } }
}

test('act tools reach the model ONLY while the wish\'s own mandate is active and the switch is on; they are never evidence tools', async t => {
  assert.deepEqual(cloudWakeActToolNames(), CLOUD_WAKE_ACT_TOOL_NAMES)
  for (const name of CLOUD_WAKE_ACT_TOOL_NAMES) {
    assert.equal(CLOUD_WAKE_EVIDENCE_TOOLS.includes(name), false, name)
    assert.equal(cloudWakeToolNames().includes(name), false, `${name} is not in the look-only list`)
  }
  const situations = [
    ['active', {}, true],
    ['no mandateId on the wish (look-only, as today)', { wish: wishOf({ mandateId: undefined }) }, false],
    ...Object.entries(CONDITIONS).map(([name, condition]) => [name, { record: condition.record }, false]),
    ['switch off', { env: { WAKE_ACTS_ENABLED: 'yes' } }, false],
  ]
  for (const [name, options, offered] of situations) {
    const model = scriptedModel([])
    const { head } = world({ ...options, answer: model.answer })
    t.mock.method(globalThis, 'fetch', async (url, init) => model.answer(new URL(url), init))
    const out = await head.executeCloudWakeStep({ now: T0, forceWishStep: true })
    assert.equal(out.status, 'success', `${name}: ${JSON.stringify(out)}`)
    for (const tool of CLOUD_WAKE_ACT_TOOL_NAMES) assert.equal(model.seen[0].includes(tool), offered, `${name}: ${tool}`)
    t.mock.restoreAll()
  }
  assert.deepEqual(cloudWakeActOffer({ WAKE_ACTS_ENABLED: '1' }, wishOf(), mandateRecord(), T0), { offered: true, cause: null, mandateId: MANDATE })
  assert.equal(cloudWakeActOffer({}, wishOf(), mandateRecord(), T0).cause, 'acts_disabled')
})

test('a hallucinated act call without an active mandate is refused in the step, with no request to GitHub and no spend', async t => {
  const model = scriptedModel([{ id: 'call_1', type: 'function', function: { name: 'act_branch_create', arguments: JSON.stringify(ACT_ARGS.act_branch_create) } }])
  const { head, storage, requests } = world({ record: mandateRecord(MANDATE, { revokedAt: T0 - 1 }), answer: model.answer })
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push({ url: new URL(url) }); return model.answer(new URL(url), init) })
  const out = await head.executeCloudWakeStep({ now: T0, forceWishStep: true })
  assert.equal(out.status, 'success')
  assert.deepEqual(out.toolRefusals, [{ tool: 'act_branch_create', code: 'wake_acts_not_offered' }])
  assert.equal(requests.filter(request => request.url.host === 'api.github.com').length, 0)
  assert.deepEqual(receiptsOf(storage), [])
})

test('x6_wish create keeps mandateId (owner only, the active one); a running mandated wish is never silently replaced; probe reports acts', async () => {
  // The wish routes check the mandate against the real clock (as the session check above does), so this case's mandate must not
  // end at T0 + 24 h: it expired for good and every wish_create then answered MANDATE_EXPIRED first.
  const { head, storage } = world({ wish: null, record: mandateRecord(MANDATE, {}, { expiresAt: Date.now() + 86400000 }) })
  const ownerHeaders = { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED, 'content-type': 'application/json',
    'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }) }
  const post = (body, headers = ownerHeaders) => head.fetch(new Request(ORIGIN + '/_head/transcript', { method: 'POST', headers, body: JSON.stringify(body) }))
  const visitor = { ...ownerHeaders, 'x-x6-verified-access': JSON.stringify({ type: 'access', email: 'friend@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }) }
  assert.equal((await (await post({ action: 'wish_create', intent: 'x', mandateId: MANDATE }, visitor)).json()).code, 'OWNER_ACCESS_REQUIRED')
  assert.equal((await (await post({ action: 'wish_create', intent: 'x', mandateId: OTHER })).json()).code, 'MANDATE_ID_MISMATCH')
  assert.equal((await (await post({ action: 'wish_create', intent: 'x', mandateId: 'bad id' })).json()).code, 'WISH_MANDATE_INVALID')
  const created = await (await post({ action: 'wish_create', intent: 'Fix one thing', mandateId: MANDATE })).json()
  assert.equal(created.ok, true)
  assert.equal((await storage.get('head:wish:active')).mandateId, MANDATE)
  const replaced = await post({ action: 'wish_create', intent: 'Something else' })
  assert.equal(replaced.status, 409)
  assert.equal((await replaced.json()).code, 'WISH_MANDATE_LINKED')
  assert.equal((await storage.get('head:wish:active')).intent, 'Fix one thing', 'the mandated wish is kept')
  const probe = await (await post({ action: 'wish_probe' })).json()
  assert.equal(probe.probe.acts.switchOn, true)
  assert.equal(probe.probe.acts.offered, true)
  assert.equal(probe.probe.acts.mandateId, MANDATE)
  assert.equal(probe.probe.acts.mandateState, 'active')
  assert.deepEqual(probe.probe.acts.today.commits, { used: 0, bound: OWNER_MANDATE_DEFAULT_PER_DAY.commits })
  assert.deepEqual(probe.probe.acts.perStep, { acts: 3, linearComments: 1, toolCalls: 8 })
  await post({ action: 'wish_stop' })
  assert.equal((await (await post({ action: 'wish_create', intent: 'Look only' })).json()).ok, true, 'after stop a new wish may be made')
  assert.equal((await storage.get('head:wish:active')).mandateId, undefined)
})

// ---------------------------------------------------------------------------------------------------------------- item 5

/** A made-up Linear: one issue assigned to her, one that is not hers. */
function linearFake(log = []) {
  return async (url, init) => {
    if (url.host !== 'api.linear.app') return undefined
    const { query, variables } = JSON.parse(init.body)
    log.push(query.split('(')[0])
    const issue = id => id === 'YOURTEAM-463' || id === 'issue-463'
      ? { id: 'issue-463', identifier: 'YOURTEAM-463', title: 'Wake acts', url: 'https://linear.app/x/YOURTEAM-463', updatedAt: '2026-11-14T00:00:00.000Z', state: { name: 'Todo' },
        assignee: { id: 'viewer-auma' }, labels: { nodes: [] }, description: 'Do it.', comments: { nodes: [{ id: 'c1', body: 'Go.', createdAt: '2026-11-14T00:00:00.000Z', user: { name: 'The owner' } }] } }
      : { id: 'issue-1', identifier: 'YOURTEAM-1', title: 'Not hers', url: 'https://linear.app/x/YOURTEAM-1', updatedAt: '2026-11-14T00:00:00.000Z', state: { name: 'Todo' },
        assignee: { id: 'someone' }, labels: { nodes: [{ name: 'other' }] }, description: '', comments: { nodes: [] } }
    if (query.startsWith('query LinearWakeIssues')) return Response.json({ data: { viewer: { id: 'viewer-auma' }, issues: { nodes: [issue('YOURTEAM-463'), issue('YOURTEAM-1')] } } })
    if (query.startsWith('query LinearWakeIssue(')) return Response.json({ data: { viewer: { id: 'viewer-auma' }, issue: issue(variables.id) } })
    if (query.startsWith('mutation LinearDoorComment')) return Response.json({ data: { commentCreate: { success: true, comment: { id: 'comment-new', url: 'https://linear.app/c', createdAt: '2026-11-14T00:00:00.000Z' } } } })
    if (query.startsWith('query CrewRelayIssue')) {
      const node = { id: 'relay', identifier: 'YOURTEAM-398', title: 'Relay', comments: { nodes: [{ id: 'r1', body: 'old', createdAt: '2026-11-14T00:00:00.000Z', user: { name: 'Dot' } },
        { id: 'r2', body: 'new', createdAt: '2026-11-14T01:00:00.000Z', user: { name: 'Dot' } }], pageInfo: { hasNextPage: false } } }
      return Response.json({ data: { issues: { nodes: [node] } } })
    }
    return undefined
  }
}

test('linearWakeRead and relayWakeRead: the internal reader only, her issues only, bounded and marked untrusted; never a write', async () => {
  const log = [], fake = linearFake(log)
  const fetchImpl = async (raw, init) => fake(new URL(raw), init)
  const env = { LINEAR_API_KEY: ENV.LINEAR_API_KEY }
  const list = await linearWakeRead(WAKE_LINEAR_READER, { action: 'issues' }, env, { fetchImpl })
  assert.equal(list.ok, true)
  assert.equal(list.untrusted, true)
  assert.deepEqual(list.issues.map(issue => issue.identifier), ['YOURTEAM-463'], 'only the issue assigned to her')
  assert.equal((await linearWakeRead(WAKE_LINEAR_READER, { action: 'issue', issue: 'YOURTEAM-1' }, env, { fetchImpl })).code, 'LINEAR_ISSUE_NOT_READABLE')
  assert.equal((await linearWakeRead({ kind: 'wake-linear-reader' }, { action: 'issues' }, env, { fetchImpl })).code, 'LINEAR_WAKE_READER_REQUIRED', 'a look-alike is refused')
  assert.equal((await linearWakeRead(WAKE_LINEAR_READER, { action: 'comment', issue: 'YOURTEAM-463' }, env, { fetchImpl })).code, 'LINEAR_ACTION_UNKNOWN')
  const relay = await relayWakeRead(WAKE_RELAY_READER, { after: '2026-11-14T00:30:00.000Z' }, env, { fetchImpl })
  assert.equal(relay.ok, true)
  assert.deepEqual(relay.comments.map(comment => comment.body), ['new'])
  assert.equal(relay.cursor, '2026-11-14T01:00:00.000Z')
  assert.equal((await relayWakeRead({ kind: 'wake-relay-reader' }, {}, env, { fetchImpl })).code, 'RELAY_WAKE_READER_REQUIRED')
  assert.equal(log.some(name => name.startsWith('mutation')), false, 'no write left')
  // The comment has its own principal; the reader (and any look-alike) can never write.
  for (const notCommenter of [WAKE_LINEAR_READER, { kind: 'wake-linear-reader' }, { kind: 'wake-linear-commenter' }]) {
    assert.equal((await linearWakeComment(notCommenter, { issue: 'YOURTEAM-463', body: 'x', requestId: 'r'.repeat(20) }, env, { fetchImpl })).code, 'LINEAR_WAKE_COMMENTER_REQUIRED')
  }
  assert.equal(log.some(name => name.startsWith('mutation')), false, 'still no write left')
})

test('a full step: linearRead (counted in HEAD per day, evidence) then ONE paid comment on that issue; a second comment in the step is refused', async t => {
  const linear = linearFake()
  const model = scriptedModel([
    { id: 'call_1', type: 'function', function: { name: 'linearRead', arguments: JSON.stringify({ issue: 'YOURTEAM-463' }) } },
    { id: 'call_2', type: 'function', function: { name: 'act_linear_comment', arguments: JSON.stringify({ issue: 'YOURTEAM-463', body: 'Step done.' }) } },
    { id: 'call_3', type: 'function', function: { name: 'act_linear_comment', arguments: JSON.stringify({ issue: 'YOURTEAM-463', body: 'Again.' }) } },
    { id: 'call_4', type: 'function', function: { name: 'act_linear_comment', arguments: JSON.stringify({ issue: 'YOURTEAM-1', body: 'Not hers.' }) } },
  ])
  const answer = async (url, init, body) => (await model.answer(url, init, body)) ?? (await linear(url, init, body))
  const { head, storage, events } = world({ answer })
  t.mock.method(globalThis, 'fetch', async (url, init) => answer(new URL(url), init))
  const out = await head.executeCloudWakeStep({ now: T0, forceWishStep: true })
  assert.equal(out.status, 'success', JSON.stringify(out))
  assert.equal(out.evidenceCount, 1, 'linearRead is evidence; the act is not')
  assert.deepEqual(out.toolRefusals, [{ tool: 'act_linear_comment', code: 'cloud_wake_act_comment_limit' }, { tool: 'act_linear_comment', code: 'linear_issue_not_readable' }])
  assert.equal(receiptsOf(storage).length, 1, 'one comment paid')
  assert.equal(outcomesOf(storage)[0].commentId, 'comment-new')
  assert.equal(await storage.get(`head:wake-talk-read:linear:${ownerMandateDay(T0)}`), 1)
  const receiptAt = events.findIndex(event => event.kind === 'put' && event.key.startsWith(`${OWNER_MANDATE_KEY}:use:`))
  const commentAt = events.findIndex(event => event.kind === 'fetch' && event.host === 'api.linear.app' && event.method === 'POST' && events.indexOf(event) > receiptAt)
  assert.ok(receiptAt > 0 && commentAt > receiptAt)
})
