/** The loop fence and the second workflow at the edge. Fixed synthetic provider state:
 * these tests never call GitHub. The fake is repo-brokers.test.mjs's shape (a test file exports nothing, and
 * importing it would run its tests here), extended with proposal-checks.yml runs and the head sync's provider reads. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { handleCloudBroker, PROPOSAL_CI_NEXT, PROPOSAL_CI_WORKFLOWS } from '../cloud-brokers.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { canonicalJson as manifestJson } from '../../../../server/ball-transition.mjs'
import { FROZEN_PATH_NEXT, FROZEN_TEST_NEXT, FROZEN_TOOLS_NEXT, PATH_NOT_OPEN_NEXT, PATH_NOT_PLAIN_NEXT, proposalPathRefusal } from '../../../ci/frozen-paths.mjs'

const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), NEXT = 'c'.repeat(40), BASE_TREE = 'd'.repeat(40), HEAD_TREE = 'e'.repeat(40)
const BRANCH = 'auma/proposal/fixture-fence', NOW = 1794367000000, EMAIL = 'owner@fixture.example'
const BOOTSTRAP = { ready: true, head: { phase: 'complete', seedId: '1'.repeat(64) }, mirror: { phase: 'ready' } }
const digest = value => createHash('sha256').update(value).digest('hex')
const blob = value => createHash('sha1').update(value).digest('hex')
const owner = { type: 'owner', email: EMAIL, expires: NOW / 1000 + 600 }
const json = value => Response.json(value)
// An open path (under deploy/ only her relay tool is open to change; NEW files of her own folder and NEW
// auma-*.test.mjs files are open to addition only).
const FREE = 'deploy/cloudflare/src/crew-relay-tool.mjs'

function tree(files, sha) {
  const entries = new Map()
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      entries.set(parent, { path: parent, mode: '040000', type: 'tree', sha: blob(parent + sha) })
    }
    entries.set(path, { path, mode: '100644', type: 'blob', sha: blob(content), size: Buffer.byteLength(content) })
  }
  return { sha, truncated: false, tree: [...entries.values()] }
}

/** Runs of either workflow: `gate` and `checks` are { runs, jobs } overrides; the default is both green on HEAD. */
const GATE = PROPOSAL_CI_WORKFLOWS[0], CHECKS = PROPOSAL_CI_WORKFLOWS[1]
const run = (workflow, patch = {}) => ({ id: workflow === GATE ? 7 : 8, workflow_id: workflow === GATE ? 11 : 12, run_number: 3, run_attempt: 1, head_sha: HEAD, head_branch: BRANCH,
  event: 'push', path: workflow.path, status: 'completed', conclusion: 'success', ...patch })
const job = (workflow, name, patch = {}) => ({ id: (workflow === GATE ? 100 : 200) + workflow.jobs.indexOf(name), run_id: workflow === GATE ? 7 : 8, head_sha: HEAD, name,
  status: 'completed', conclusion: 'success', ...patch })
function ci({ gate = {}, checks = {} } = {}) {
  const state = workflow => { const o = workflow === GATE ? gate : checks; return { runs: o.runs ?? [run(workflow)], jobs: o.jobs ?? workflow.jobs.map(name => job(workflow, name)) } }
  return url => {
    for (const workflow of [GATE, CHECKS]) {
      if (url.pathname.endsWith(`/actions/workflows/${workflow.file}/runs`)) { const { runs } = state(workflow); return json({ total_count: runs.length, workflow_runs: runs }) }
      if (url.pathname.endsWith(`/actions/runs/${workflow === GATE ? 7 : 8}/attempts/1/jobs`)) { const { jobs } = state(workflow); return json({ total_count: jobs.length, jobs }) }
    }
    return undefined
  }
}

function fixture({ before = { [FREE]: 'old\n' }, after = { [FREE]: 'new\n' }, ciState, env: extraEnv = {}, access = owner, head } = {}) {
  const refs = new Map([['main', BASE], [BRANCH, HEAD]]), calls = [], tokens = new Map(), proposals = [], outcomes = []
  let staged = null, attempt = null, consumed = 0, authorizeCalls = 0, currentRequest
  const ciFetch = ci(ciState)
  const env = { GITHUB_TOKEN: 'synthetic-token-value', OWNER_EMAIL: EMAIL, PUBLIC_HOST: 'fixture.example', SOURCE_REVISION: BASE, ...extraEnv }
  env.HEAD ??= { idFromName: name => name, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    if (path === '/_head/ball') return json(head)
    if (path === '/_head/telemetry') return json({ ok: true })
    const input = await request.json()
    if (input.action === 'stage') { staged = input.proposal; proposals.push(staged); return json({ ok: true }) }
    if (input.action === 'begin_merge') {
      if (attempt || !staged || canonicalJson(input.mergeBody) !== canonicalJson(staged.mergeBody)) return Response.json({ ok: false, code: 'REPO_PROPOSAL_MISMATCH' }, { status: 409 })
      // HEAD consumes his approval in the same step that claims the attempt; this is when the passkey is "asked".
      authorizeCalls++
      const key = request.headers.get('x-x6-class3-approval'), approval = tokens.get(key)
      if (!approval || canonicalJson(approval.binding) !== canonicalJson(input.binding)) return Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' }, { status: 403 })
      tokens.delete(key); consumed++
      attempt = 'fixture-attempt-123456'; return json({ ok: true, attemptId: attempt, startedAt: NOW, approvalExpiresAt: approval.expiresAt })
    }
    if (input.action === 'mark_merge') return json({ ok: true, attemptId: attempt, state: 'marked' })
    if (input.action === 'merge_outcome') { outcomes.push(input.outcome); if (input.outcome.status !== 'unknown') attempt = null; return json({ ok: true }) }
    // HEAD's answer when no earlier merge call left a durable attempt (every merge asks first: MUST 5).
    if (input.action === 'inspect_merge' && !attempt) return Response.json({ ok: false, code: 'REPO_MERGE_ATTEMPT_MISSING' }, { status: 409 })
    throw new Error('Unexpected HEAD action ' + input.action)
  } }) }
  const networkFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl); calls.push({ url: rawUrl, method: init.method, body: init.body })
    assert.equal(url.hostname, 'api.github.com')
    const answered = ciFetch(url)
    if (answered !== undefined) return answered
    if (url.pathname === '/graphql') {
      const operation = JSON.parse(init.body), input = operation.variables.input
      if (operation.query.includes('updateRefs')) {
        if (input.refUpdates.some(update => (refs.get(update.name.slice('refs/heads/'.length)) ?? '0'.repeat(40)) !== update.beforeOid)) return json({ data: { updateRefs: null }, errors: [{ type: 'STALE_DATA' }] })
        for (const update of input.refUpdates) refs.set(update.name.slice('refs/heads/'.length), update.afterOid)
        return json({ data: { updateRefs: { clientMutationId: input.clientMutationId } } })
      }
      assert.equal(refs.get(input.branch.branchName), input.expectedHeadOid)
      refs.set(input.branch.branchName, NEXT)
      return json({ data: { createCommitOnBranch: { commit: { oid: NEXT } } } })
    }
    if (url.pathname === PREFIX) return json({ full_name: 'your_org_x/your-node', default_branch: 'main', node_id: 'R_fixture' })
    if (url.pathname.startsWith(PREFIX + '/git/ref/heads/')) {
      const branch = decodeURIComponent(url.pathname.slice((PREFIX + '/git/ref/heads/').length)), sha = refs.get(branch)
      return sha ? json({ ref: 'refs/heads/' + branch, object: { type: 'commit', sha } }) : new Response('', { status: 404 })
    }
    if (url.pathname.includes('/compare/')) {
      const [base, tip] = url.pathname.split('/compare/')[1].split('...')
      return json({ base_commit: { sha: base }, merge_base_commit: { sha: base }, ahead_by: base === tip ? 0 : 1, behind_by: 0, status: base === tip ? 'identical' : 'ahead', files: [] })
    }
    if (url.pathname.endsWith('/actions/runs') || /\/actions\/workflows\/[^/]+\/runs$/.test(url.pathname)) return json({ total_count: 0, workflow_runs: [] })
    if (url.pathname === PREFIX + '/commits' && url.searchParams.get('sha') === 'main') return json([{ sha: refs.get('main'), commit: { message: 'main' }, parents: [] }])
    if (url.pathname.startsWith(PREFIX + '/commits/')) {
      const ref = decodeURIComponent(url.pathname.slice((PREFIX + '/commits/').length)), sha = refs.get(ref) ?? ref
      return json({ sha, commit: { tree: { sha: sha === BASE ? BASE_TREE : HEAD_TREE } } })
    }
    if (url.pathname.startsWith(PREFIX + '/git/trees/')) {
      const sha = url.pathname.split('/').at(-1)
      return json(tree(sha === BASE_TREE ? before : after, sha))
    }
    if (url.pathname.startsWith(PREFIX + '/contents/')) {
      const path = decodeURIComponent(url.pathname.slice((PREFIX + '/contents/').length)), files = url.searchParams.get('ref') === BASE ? before : after, content = files[path]
      if (content === undefined) return new Response('', { status: 404 })
      return json({ type: 'file', path, sha: blob(content), encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    throw new Error('Unexpected synthetic URL ' + url.pathname)
  }
  return {
    refs, calls, proposals, outcomes, get consumed() { return consumed }, get authorizeCalls() { return authorizeCalls },
    get github() { return calls.length },
    grant(input) {
      const token = 'fixture-approval-' + tokens.size
      tokens.set(token, { ok: true, expiresAt: NOW + 60000, binding: { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/repo', bodySha256: digest(canonicalJson(input)) } })
      return token
    },
    async request(input, { token } = {}) {
      currentRequest = new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(token ? { 'x-x6-class3-approval': token } : {}) }, body: JSON.stringify(input) })
      // A merge never consumes through the Worker's consumer (HEAD does, in begin_merge): a call here is a failure.
      const response = await handleCloudBroker(currentRequest, env, { access, bootstrap: BOOTSTRAP, now: () => NOW, networkFetch, authorizeClass3: async () => { assert.fail('the merge consumed outside HEAD') } })
      return { status: response.status, value: await response.json() }
    },
  }
}
const mergeBody = { action: 'merge_proposal', baseSha: BASE, branch: BRANCH, headSha: HEAD, treeSha: HEAD_TREE }
const stage = broker => broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fence fixture' })
const refused = (result, path, next = FROZEN_PATH_NEXT) => {
  assert.equal(result.status, 403, JSON.stringify(result.value)); assert.equal(result.value.code, 'REPO_FROZEN_PATH_REFUSED')
  assert.equal(result.value.protectedPath, path); assert.equal(result.value.next, next)
}

test('a branch write, edit or commit naming a frozen path is refused and nothing reaches GitHub', async () => {
  for (const path of ['deploy/ci/x.mjs', 'mirror/home/auma/seed/organs/seed-judge.js', 'mirror/home/auma/HEAD.json', 'deploy/cloudflare/src/cloud-brokers.mjs',
    'deploy/cloudflare/src/head-do.mjs', 'deploy/cloudflare/src/worker.mjs', 'server/ball-transition.mjs', 'packages/experimental/webworker-runtime/src/x6/wasm-cells.ts',
    'packages/experimental/webworker-runtime/src/x6/ball-loader.ts']) {
    const next = path.endsWith('ball-loader.ts') ? FROZEN_TOOLS_NEXT : FROZEN_PATH_NEXT
    for (const input of [
      { action: 'write', branch: BRANCH, path, content: 'x\n' },
      { action: 'write', branch: BRANCH, path, content: 'x\n', message: 'Change', expectedHeadSha: HEAD },
      { action: 'edit', branch: BRANCH, path, oldString: 'a', newString: 'b' },
      { action: 'commit', branch: BRANCH, message: 'Change', changes: [{ path: FREE, content: 'x\n' }, { path, content: 'x\n' }] },
    ]) {
      const broker = fixture(), result = await broker.request(input)
      refused(result, path, next)
      assert.equal(broker.github, 0, `${path} ${input.action}`)
    }
  }
  // Not canonical stays refused as today; .github/ keeps its own code; a free path and a NEW test file still commit.
  for (const [path, code] of [['deploy//ci/x.mjs', 'REPO_PATH_REFUSED'], ['deploy/./ci/x.mjs', 'REPO_PATH_REFUSED'], ['.github/workflows/x.yml', 'REPO_WORKFLOW_PATH_REFUSED'], ['.GitHub/x', 'REPO_PATH_REFUSED']]) {
    const broker = fixture(), result = await broker.request({ action: 'write', branch: BRANCH, path, content: 'x\n' })
    assert.equal(result.value.code, code, path); assert.equal(broker.github, 0)
  }
  for (const path of [FREE, 'deploy/cloudflare/src/__tests__/auma-brand-new.test.mjs', 'deploy/cloudflare/src/__tests__/auma-old.test.mjs']) {
    const broker = fixture(), result = await broker.request({ action: 'commit', branch: BRANCH, message: 'Change', changes: [{ path, content: 'x\n' }] })
    assert.equal(result.status, 200, `${path} ${JSON.stringify(result.value)}`); assert.equal(broker.refs.get(BRANCH), NEXT)
  }
})

test('stage and merge refuse a frozen change, a rename out of a frozen path and a delete of one; the passkey is never asked', async () => {
  const cases = [
    ['a change', { [FREE]: 'old\n', 'deploy/cloudflare/src/access.mjs': 'old\n' }, { [FREE]: 'new\n', 'deploy/cloudflare/src/access.mjs': 'new\n' }, 'deploy/cloudflare/src/access.mjs'],
    ['a rename out', { 'deploy/ci/scrub-gate.mjs': 'gate\n' }, { 'deploy/scrub-gate.mjs': 'gate\n' }, 'deploy/ci/scrub-gate.mjs'],
    ['a rename in', { [FREE]: 'x\n' }, { 'server/build-preview.mjs': 'x\n' }, 'server/build-preview.mjs'],
    ['a delete', { [FREE]: 'old\n', 'mirror/home/auma/seed/organs/seed-judge.js': 'judge\n' }, { [FREE]: 'new\n' }, 'mirror/home/auma/seed/organs/seed-judge.js'],
    ['an add of a missing governance organ', { [FREE]: 'old\n' }, { [FREE]: 'old\n', 'mirror/home/auma/seed/organs/gate-judge.js': 'judge\n' }, 'mirror/home/auma/seed/organs/gate-judge.js'],
  ]
  for (const [name, before, after, path] of cases) {
    const staging = fixture({ before, after, ciState: {} })
    refused(await stage(staging), path)
    assert.equal(staging.proposals.length, 0, name)
    assert.equal(staging.calls.some(call => call.url.includes('/actions/')), false, `${name}: no CI read for a refused stage`)
    // A merge straight to the edge (no card): refused before CI is read and before the approval is asked for or spent.
    const merging = fixture({ before, after, ciState: {} })
    refused(await merging.request(mergeBody, { token: merging.grant(mergeBody) }), path)
    assert.equal(merging.authorizeCalls, 0, name); assert.equal(merging.consumed, 0, name)
    assert.equal(merging.calls.some(call => call.method === 'POST'), false, name)
    assert.equal(merging.calls.some(call => call.url.includes('/contents/') || call.url.includes('/actions/')), false, name)
    assert.equal(merging.refs.get('main'), BASE, name); assert.deepEqual(merging.outcomes, [], name)
  }
})

test('a test main already has may not be edited or deleted at stage or merge; a NEW test file passes', async () => {
  const existing = 'deploy/cloudflare/src/__tests__/repo-brokers.test.mjs', boot = 'packages/experimental/webworker-runtime/tests/x6/large-store-boot.spec.ts'
  for (const [before, after, path] of [
    [{ [existing]: 'strict\n' }, { [existing]: 'weaker\n' }, existing],
    [{ [existing]: 'strict\n', [FREE]: 'old\n' }, { [FREE]: 'new\n' }, existing],
    [{ [boot]: 'boot\n' }, { [boot]: 'boot2\n' }, boot],
    [{ [existing]: 'strict\n' }, { 'deploy/cloudflare/src/__tests__/auma-renamed.test.mjs': 'strict\n' }, existing],
  ]) {
    const staging = fixture({ before, after, ciState: {} })
    refused(await stage(staging), path, FROZEN_TEST_NEXT)
    assert.equal(staging.proposals.length, 0)
    const merging = fixture({ before, after, ciState: {} })
    refused(await merging.request(mergeBody, { token: merging.grant(mergeBody) }), path, FROZEN_TEST_NEXT)
    assert.equal(merging.authorizeCalls, 0); assert.equal(merging.consumed, 0)
  }
  const added = fixture({ before: { [existing]: 'strict\n' }, after: { [existing]: 'strict\n', 'deploy/cloudflare/src/__tests__/auma-her-new.test.mjs': 'new\n', [boot.replace('large-store-boot', 'her-boot')]: 'new\n' }, ciState: {} })
  const staged = await stage(added)
  assert.equal(staged.status, 200, JSON.stringify(staged.value))
  assert.deepEqual(staged.value.proposal.changedFiles.map(file => [file.path, file.status]),
    [['deploy/cloudflare/src/__tests__/auma-her-new.test.mjs', 'added'], ['packages/experimental/webworker-runtime/tests/x6/her-boot.spec.ts', 'added']])
  assert.equal(staged.value.proposal.ciStatus, 'passed')
  const merged = await added.request(staged.value.proposal.mergeBody, { token: added.grant(staged.value.proposal.mergeBody) })
  assert.equal(merged.status, 200, JSON.stringify(merged.value)); assert.equal(added.refs.get('main'), HEAD); assert.equal(added.consumed, 1)
})

test('the merge needs BOTH workflows green for the exact head; a missing, pending or failed checks run leaves the approval unspent', async () => {
  for (const [checks, ciStatus] of [
    [{ runs: [] }, 'pending'],
    [{ runs: [run(CHECKS, { status: 'in_progress', conclusion: null })] }, 'pending'],
    [{ runs: [run(CHECKS, { status: 'queued', conclusion: null })] }, 'pending'],
    [{ runs: [run(CHECKS, { conclusion: 'failure' })] }, 'failed'],
    [{ runs: [run(CHECKS, { conclusion: 'cancelled' })] }, 'failed'],
    [{ jobs: [] }, 'failed'],
    [{ jobs: [job(CHECKS, 'checks', { conclusion: 'skipped' })] }, 'failed'],
    [{ jobs: [job(CHECKS, 'checks'), job(CHECKS, 'checks', { id: 299 })] }, 'failed'],
    // The latest attempt decides: a re-run that failed outranks the attempt that passed.
    [{ runs: [run(CHECKS, { id: 9, run_attempt: 2, conclusion: 'failure' }), run(CHECKS)] }, 'failed'],
  ]) {
    const broker = fixture({ ciState: { checks } })
    const staged = await stage(broker)
    assert.equal(staged.value.proposal.ciStatus, ciStatus, JSON.stringify(checks))
    const result = await broker.request(mergeBody, { token: broker.grant(mergeBody) })
    assert.equal(result.status, 409); assert.equal(result.value.code, 'REPO_PROPOSAL_CI_NOT_PASSED'); assert.equal(result.value.ciStatus, ciStatus)
    assert.equal(result.value.next, PROPOSAL_CI_NEXT); assert.match(result.value.next, /proposal-gate/); assert.match(result.value.next, /proposal-checks/)
    assert.equal(broker.authorizeCalls, 0); assert.equal(broker.consumed, 0); assert.equal(broker.refs.get('main'), BASE)
    assert.equal(broker.calls.some(call => call.method === 'POST'), false)
  }
  // The gate's own failure is enough to refuse; neither workflow run at all is 'none'; checks green with no gate run is pending.
  for (const [state, ciStatus] of [[{ gate: { runs: [run(GATE, { conclusion: 'failure' })] } }, 'failed'], [{ gate: { runs: [] }, checks: { runs: [] } }, 'none'], [{ gate: { runs: [] } }, 'pending']]) {
    const broker = fixture({ ciState: state })
    assert.equal((await stage(broker)).value.proposal.ciStatus, ciStatus)
    const result = await broker.request(mergeBody, { token: broker.grant(mergeBody) })
    assert.equal(result.value.ciStatus, ciStatus); assert.equal(broker.consumed, 0)
  }
  // Both green: merges as today, one approval spent, both workflows read for this exact branch and head.
  const both = fixture({ ciState: {} }), staged = await stage(both)
  assert.equal(staged.value.proposal.ciStatus, 'passed')
  const merged = await both.request(staged.value.proposal.mergeBody, { token: both.grant(staged.value.proposal.mergeBody) })
  assert.equal(merged.status, 200, JSON.stringify(merged.value)); assert.equal(both.refs.get('main'), HEAD); assert.equal(both.consumed, 1)
  for (const file of ['proposal-gate.yml', 'proposal-checks.yml']) {
    const query = new URL(both.calls.find(call => call.url.includes(`/actions/workflows/${file}/runs`)).url)
    assert.deepEqual([query.searchParams.get('branch'), query.searchParams.get('head_sha'), query.searchParams.get('event')], [BRANCH, HEAD, 'push'])
  }
})

test('a checks run for another head, branch, event or workflow file is not evidence', async () => {
  // GitHub filters by head: a run of checks only for another head leaves this head with no checks run (pending).
  const other = fixture({ ciState: { checks: { runs: [] } } })
  assert.equal((await stage(other)).value.proposal.ciStatus, 'pending')
  // A run for another head, branch, event or path in the answer is a malformed answer: refused, approval unspent.
  for (const patch of [{ head_sha: NEXT }, { head_branch: 'auma/proposal/other-one' }, { event: 'workflow_dispatch' }, { path: GATE.path }, { path: '.github/workflows/ci.yml' }]) {
    const broker = fixture({ ciState: { checks: { runs: [run(CHECKS, patch)] } } })
    const result = await broker.request(mergeBody, { token: broker.grant(mergeBody) })
    assert.equal(result.value.code, 'REPO_CI_INCOMPLETE', JSON.stringify(patch)); assert.equal(broker.consumed, 0); assert.equal(broker.refs.get('main'), BASE)
  }
  // A job of another run or head inside the checks attempt is malformed too.
  for (const patch of [{ run_id: 7 }, { head_sha: NEXT }]) {
    const broker = fixture({ ciState: { checks: { jobs: [job(CHECKS, 'checks', patch)] } } })
    assert.equal((await broker.request(mergeBody, { token: broker.grant(mergeBody) })).value.code, 'REPO_CI_INCOMPLETE'); assert.equal(broker.consumed, 0)
  }
})

test('her other doors answer as before: the head sync still commits mirror/ on main, frozen organ and HEAD.json included', async () => {
  const organ = 'export const judge = "next";\n', sha = digest(organ)
  const body = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 172, entries: { 'seed-judge': { id: 'seed-judge', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  const ball = { ...body, ballId: digest(manifestJson(body)) }
  // main (BASE) has the organ's old copy; GitHub's HEAD.json is absent, so both head copies are written.
  const base = { 'mirror/home/auma/seed/organs/seed-judge.js': 'export const judge = "old";\n', 'mirror/home/auma/HEAD.json': '{}\n' }
  const broker = fixture({ before: base, after: base, head: { ball, codeBySha: { [sha]: organ } } })
  const result = await broker.request({ action: 'sync_head_to_github' })
  assert.equal(result.status, 200, JSON.stringify(result.value)); assert.equal(result.value.action, 'sync_head_to_github')
  assert.deepEqual([...result.value.paths].sort(), ['mirror/home/auma/HEAD.json', 'mirror/home/auma/seed/organs/seed-judge.js', 'mirror/home/balls/HEAD.json', `mirror/home/balls/${sha}.js`].sort())
  const input = JSON.parse(broker.calls.find(call => call.method === 'POST').body).variables.input
  assert.equal(input.branch.branchName, 'main'); assert.equal(broker.refs.get('main'), NEXT)
  // The docs door on main is unchanged too.
  const docs = fixture(), doc = await docs.request({ action: 'commit', changes: [{ path: 'docs/plan/notes.md', content: '# Notes\n' }], message: 'Notes', dryRun: true })
  assert.equal(doc.status, 200, JSON.stringify(doc.value)); assert.equal(doc.value.tier, 'T1')
})

test('the merge reads each exact tree once: the fence before the passkey adds no tree or commit read inside the one deadline', async () => {
  const broker = fixture({ ciState: {} }), staged = await stage(broker)
  assert.equal(staged.status, 200, JSON.stringify(staged.value))
  const from = broker.calls.length
  const merged = await broker.request(staged.value.proposal.mergeBody, { token: broker.grant(staged.value.proposal.mergeBody) })
  assert.equal(merged.status, 200, JSON.stringify(merged.value)); assert.equal(broker.refs.get('main'), HEAD); assert.equal(broker.consumed, 1)
  const paths = broker.calls.slice(from).map(call => new URL(call.url).pathname)
  assert.deepEqual(paths.filter(path => path.includes('/git/trees/')).sort(), [`${PREFIX}/git/trees/${BASE_TREE}`, `${PREFIX}/git/trees/${HEAD_TREE}`])
  assert.deepEqual(paths.filter(path => path.startsWith(PREFIX + '/commits/')).sort(), [`${PREFIX}/commits/${BASE}`, `${PREFIX}/commits/${HEAD}`])
  // A refused fence still reads nothing after it, and a moved branch after approval is still caught by the fresh ref reads.
  const moved = fixture({ ciState: {} }), body = (await stage(moved)).value.proposal.mergeBody
  moved.refs.set(BRANCH, NEXT)
  const conflict = await moved.request(body, { token: moved.grant(body) })
  assert.equal(conflict.value.code, 'REPO_HEAD_CONFLICT', JSON.stringify(conflict.value)); assert.equal(moved.refs.get('main'), BASE)
})

test('the branch diff is a read: it marks frozen files and refuses none of them; stage still refuses', async () => {
  const existing = 'deploy/cloudflare/src/__tests__/repo-brokers.test.mjs'
  const before = { [FREE]: 'old\n', [existing]: 'strict\n' }, after = { [FREE]: 'new\n', [existing]: 'weaker\n', 'deploy/ci/x.mjs': 'x\n', 'deploy/cloudflare/src/__tests__/auma-her-new.test.mjs': 'new\n' }
  const broker = fixture({ before, after })
  const result = await broker.request({ action: 'diff', branch: BRANCH })
  assert.equal(result.status, 200, JSON.stringify(result.value))
  assert.deepEqual(result.value.files.map(file => [file.path, file.status, file.frozen ?? false, file.next ?? null]), [
    ['deploy/ci/x.mjs', 'added', true, FROZEN_PATH_NEXT],
    ['deploy/cloudflare/src/__tests__/auma-her-new.test.mjs', 'added', false, null],
    [existing, 'modified', true, FROZEN_TEST_NEXT],
    [FREE, 'modified', false, null],
  ])
  assert.match(result.value.files.find(file => file.path === existing).patch, /weaker/)
  // A path filter naming a frozen file is a read too; .github/ keeps its own refusal; nothing was written.
  const filtered = await broker.request({ action: 'diff', branch: BRANCH, path: existing })
  assert.equal(filtered.status, 200, JSON.stringify(filtered.value)); assert.deepEqual(filtered.value.files.map(file => file.path), [existing])
  const worker = await broker.request({ action: 'diff', branch: BRANCH, path: 'deploy/cloudflare/src/worker.mjs' })
  assert.equal(worker.status, 200, JSON.stringify(worker.value)); assert.deepEqual(worker.value.files, [])
  assert.equal((await broker.request({ action: 'diff', branch: BRANCH, path: '.github/workflows/x.yml' })).value.code, 'REPO_WORKFLOW_PATH_REFUSED')
  assert.equal(broker.calls.some(call => call.method === 'POST'), false); assert.equal(broker.refs.get(BRANCH), HEAD)
  refused(await stage(fixture({ before, after, ciState: {} })), 'deploy/ci/x.mjs')
})

/** MUST 1-3: a refusal of `code` for `path` with its `next`, at write, at stage and at merge (no passkey asked). */
async function refusedEverywhere(path, code, next, { write = true, before = { [FREE]: 'old\n' }, after = { [FREE]: 'old\n', [path]: 'x\n' } } = {}) {
  if (write) {
    for (const input of [{ action: 'write', branch: BRANCH, path, content: 'x\n' }, { action: 'commit', branch: BRANCH, message: 'Change', changes: [{ path: FREE, content: 'x\n' }, { path, content: 'x\n' }] }]) {
      const broker = fixture(), result = await broker.request(input)
      assert.equal(result.status, 403, `${JSON.stringify(path)} ${input.action}: ${JSON.stringify(result.value)}`); assert.equal(result.value.code, code, JSON.stringify(path))
      assert.equal(result.value.protectedPath, path); assert.equal(result.value.next, next)
      assert.equal(broker.github, 0, `${JSON.stringify(path)} ${input.action}: nothing reaches GitHub`)
    }
  }
  const staging = fixture({ before, after, ciState: {} }), staged = await stage(staging)
  assert.equal(staged.status, 403, JSON.stringify(staged.value)); assert.equal(staged.value.code, code, JSON.stringify(path))
  assert.equal(staged.value.protectedPath, path); assert.equal(staged.value.next, next); assert.equal(staging.proposals.length, 0)
  const merging = fixture({ before, after, ciState: {} }), merged = await merging.request(mergeBody, { token: merging.grant(mergeBody) })
  assert.equal(merged.value.code, code, JSON.stringify(path)); assert.equal(merging.authorizeCalls, 0); assert.equal(merging.consumed, 0)
  assert.equal(merging.calls.some(call => call.method === 'POST' || call.url.includes('/actions/')), false); assert.equal(merging.refs.get('main'), BASE)
}

test('MUST 1: a path outside printable ASCII is refused at write, stage and merge as REPO_PATH_NOT_PLAIN', async () => {
  for (const path of ['deploy/cloudflare/src/\u017figned-action.mjs', 'packages/experimental/webworker-runtime/src/x6/wa\u017fm-cells.ts', 'docs/auma/caf\u00e9.md', 'docs/auma/cafe\u0301.md']) {
    await refusedEverywhere(path, 'REPO_PATH_NOT_PLAIN', PATH_NOT_PLAIN_NEXT)
  }
})

test('MUST 1: a case twin of a path in the base or head tree is refused at write, stage and merge', async () => {
  // A twin of a protected file is frozen by itself (judged in lower case).
  await refusedEverywhere('deploy/cloudflare/src/Signed-Action.mjs', 'REPO_FROZEN_PATH_REFUSED', FROZEN_PATH_NEXT)
  // A twin of an open file: the write reads the branch tree and refuses before any commit; stage and merge see both trees.
  // (Her own folder is open to additions, so the twin is an added file beside one both trees hold.)
  const twin = 'deploy/cloudflare/src/auma/Fixture.mjs', held = 'deploy/cloudflare/src/auma/fixture.mjs'
  const broker = fixture({ before: { [FREE]: 'old\n', [held]: 'x\n' }, after: { [FREE]: 'new\n', [held]: 'x\n' } })
  const result = await broker.request({ action: 'commit', branch: BRANCH, message: 'Twin', changes: [{ path: twin, content: 'x\n' }] })
  assert.equal(result.value.code, 'REPO_PATH_NOT_PLAIN'); assert.equal(result.value.protectedPath, twin); assert.equal(result.value.next, PATH_NOT_PLAIN_NEXT)
  assert.equal(broker.calls.some(call => call.method === 'POST'), false); assert.equal(broker.refs.get(BRANCH), HEAD)
  await refusedEverywhere(twin, 'REPO_PATH_NOT_PLAIN', PATH_NOT_PLAIN_NEXT, { write: false, before: { [FREE]: 'old\n', [held]: 'x\n' }, after: { [FREE]: 'old\n', [held]: 'x\n', [twin]: 'x\n' } })
  // A folder twin: Deploy/... lands inside deploy/ on a case-insensitive disk (also outside the open list by itself).
  await refusedEverywhere('Deploy/cloudflare/src/x.mjs', 'REPO_PATH_NOT_PLAIN', PATH_NOT_PLAIN_NEXT, { write: false })
})

test('MUST 2 and 3: the outside review\'s examples are refused at write, stage and merge; an open change and a new spec pass', async () => {
  for (const path of ['deploy/cloudflare/src/__tests__/package.json', 'deploy/cloudflare/src/package.json', 'packages/util/http-proxy/src/policy.ts', 'packages/shell/pwsh-local/src/resolve.ts']) {
    await refusedEverywhere(path, 'REPO_FROZEN_PATH_REFUSED', FROZEN_PATH_NEXT)
  }
  for (const path of ['deploy/cloudflare/src/__tests__/test-helper.mjs', 'packages/util/other/src/x.ts', 'apps/web/src/package.json']) {
    await refusedEverywhere(path, 'REPO_PATH_NOT_OPEN', PATH_NOT_OPEN_NEXT)
  }
  // An installed-package folder inside open code: the private-path rule already refuses it, at write and at stage.
  const shadow = 'packages/client/ui-layout/src/node_modules/react/index.js'
  assert.equal((await fixture().request({ action: 'write', branch: BRANCH, path: shadow, content: 'x\n' })).value.code, 'REPO_PATH_REFUSED')
  assert.equal((await stage(fixture({ after: { [FREE]: 'old\n', [shadow]: 'x\n' }, ciState: {} }))).value.code, 'REPO_PROPOSAL_PATH_REFUSED')
  // Root files the branch path rule already refuses at write keep that code there; stage and merge name the fence.
  for (const [path, code] of [['scripts/coverage-exempt.ts', 'REPO_FROZEN_PATH_REFUSED'], ['tsconfig.base.json', 'REPO_FROZEN_PATH_REFUSED'], ['server/fixture.mjs', 'REPO_PATH_NOT_OPEN']]) {
    const broker = fixture(), write = await broker.request({ action: 'write', branch: BRANCH, path, content: 'x\n' })
    assert.equal(write.status, 403, path); assert.equal(broker.github, 0)
    await refusedEverywhere(path, code, code === 'REPO_PATH_NOT_OPEN' ? PATH_NOT_OPEN_NEXT : FROZEN_PATH_NEXT, { write: false, before: { [FREE]: 'old\n', [path]: 'old\n' }, after: { [FREE]: 'old\n', [path]: 'new\n' } })
  }
  // A change to a spec main has is refused; a NEW spec and an open product change stage and merge.
  const spec = 'packages/client/ui-layout/tests/wave4-lane-b.client.spec.tsx'
  await refusedEverywhere(spec, 'REPO_PATH_NOT_OPEN', PATH_NOT_OPEN_NEXT, { write: false, before: { [FREE]: 'old\n', [spec]: 'strict\n' }, after: { [FREE]: 'old\n', [spec]: 'weaker\n' } })
  const open = fixture({ before: { [FREE]: 'old\n' }, after: { [FREE]: 'new\n', 'packages/client/ui-layout/tests/her-new.client.spec.tsx': 'new\n', 'docs/auma/note.md': 'note\n' }, ciState: {} })
  for (const path of ['packages/client/ui-layout/tests/her-new.client.spec.tsx', 'docs/auma/note.md']) {
    assert.equal((await open.request({ action: 'write', branch: BRANCH, path, content: 'x\n' })).status, 200, path)
  }
  const staged = await stage(open)
  assert.equal(staged.status, 200, JSON.stringify(staged.value))
  const merged = await open.request(staged.value.proposal.mergeBody, { token: open.grant(staged.value.proposal.mergeBody) })
  assert.equal(merged.status, 200, JSON.stringify(merged.value)); assert.equal(open.refs.get('main'), HEAD)
})

test('the branch diff marks a closed or a non-plain file with its code and next, and refuses none', async () => {
  const after = { [FREE]: 'new\n', 'server/fixture.mjs': 'x\n', 'deploy/cloudflare/src/\u017figned-action.mjs': 'x\n' }
  const broker = fixture({ before: { [FREE]: 'old\n' }, after })
  const result = await broker.request({ action: 'diff', branch: BRANCH })
  assert.equal(result.status, 200, JSON.stringify(result.value))
  assert.deepEqual(result.value.files.map(file => [file.path, file.refused ?? null, file.next ?? null]), [
    [FREE, null, null],
    ['deploy/cloudflare/src/\u017figned-action.mjs', 'REPO_PATH_NOT_PLAIN', PATH_NOT_PLAIN_NEXT],
    ['server/fixture.mjs', 'REPO_PATH_NOT_OPEN', PATH_NOT_OPEN_NEXT],
  ])
})

test('at the edge closed is the default; the modules that decide approvals and budgets are refused at write, stage and merge', async () => {
  // The outside review's examples and world-holder.mjs: none is listed anywhere; the
  // default closes them. Each is refused as a change (stage, merge) and at a write.
  for (const path of ['deploy/cloudflare/src/messages-store.mjs', 'deploy/cloudflare/src/cold-archive.mjs', 'deploy/cloudflare/src/nostr-anchor.mjs',
    'deploy/cloudflare/src/thread-log.mjs', 'deploy/cloudflare/src/thread-mount.mjs', 'deploy/cloudflare/src/world-lease.mjs',
    'deploy/cloudflare/src/world-holder.mjs', 'deploy/cloudflare/src/__tests__/new-helper.test.mjs', 'deploy/cloudflare/src/sub/x.mjs']) {
    // A test file is judged as an ADDITION (a change of one main has is refused as such, above).
    const added = path.includes('/__tests__/')
    await refusedEverywhere(path, 'REPO_PATH_NOT_OPEN', PATH_NOT_OPEN_NEXT, { before: { [FREE]: 'old\n', ...(added ? {} : { [path]: 'old\n' }) }, after: { [FREE]: 'old\n', [path]: 'new\n' } })
  }
  // vault.mjs: the private-path rule refuses it before the fence, at write and at stage; the fence closes it too.
  const vault = 'deploy/cloudflare/src/vault.mjs'
  assert.equal(proposalPathRefusal(vault, 'modified').code, 'REPO_PATH_NOT_OPEN')
  const writing = fixture(), written = await writing.request({ action: 'write', branch: BRANCH, path: vault, content: 'x\n' })
  assert.equal(written.status, 403); assert.equal(writing.github, 0)
  const staging = fixture({ before: { [FREE]: 'old\n', [vault]: 'old\n' }, after: { [FREE]: 'old\n', [vault]: 'new\n' }, ciState: {} })
  assert.equal((await stage(staging)).status, 403); assert.equal(staging.proposals.length, 0)
  // What stays open under deploy/: a change to her relay tool, a NEW file of her own folder and a NEW auma-*.test.mjs; they
  // stage and merge.
  const relay = 'deploy/cloudflare/src/crew-relay-tool.mjs', own = 'deploy/cloudflare/src/auma/her-module.mjs', spec = 'deploy/cloudflare/src/__tests__/auma-her-relay.test.mjs'
  assert.equal(FREE, relay)
  const open = fixture({ before: { [relay]: 'old\n' }, after: { [relay]: 'new\n', [own]: 'new\n', [spec]: 'new\n' }, ciState: {} })
  for (const path of [relay, own, spec]) assert.equal((await open.request({ action: 'write', branch: BRANCH, path, content: 'x\n' })).status, 200, path)
  const staged = await stage(open)
  assert.equal(staged.status, 200, JSON.stringify(staged.value))
  assert.deepEqual(staged.value.proposal.changedFiles.map(file => [file.path, file.status]),
    [[spec, 'added'], [own, 'added'], [relay, 'modified']])
  const merged = await open.request(staged.value.proposal.mergeBody, { token: open.grant(staged.value.proposal.mergeBody) })
  assert.equal(merged.status, 200, JSON.stringify(merged.value)); assert.equal(open.consumed, 1)
  // MUST 1b ( add-only): a change to, or a delete of, a file of her folder that main has
  // is refused at stage and merge: once a person imports it, it runs in the Worker.
  await refusedEverywhere(own, 'REPO_PATH_NOT_OPEN', PATH_NOT_OPEN_NEXT, { write: false, before: { [FREE]: 'old\n', [own]: 'old\n' }, after: { [FREE]: 'old\n', [own]: 'new\n' } })
  await refusedEverywhere(own, 'REPO_PATH_NOT_OPEN', PATH_NOT_OPEN_NEXT, { write: false, before: { [FREE]: 'old\n', [own]: 'old\n' }, after: { [FREE]: 'new\n' } })
  // A change to an auma-*.test.mjs main already has is refused like any test main has.
  await refusedEverywhere(spec, 'REPO_FROZEN_PATH_REFUSED', FROZEN_TEST_NEXT, { write: false, before: { [FREE]: 'old\n', [spec]: 'strict\n' }, after: { [FREE]: 'old\n', [spec]: 'weaker\n' } })
})
