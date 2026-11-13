/** Fixed synthetic provider state; these tests never call GitHub or execute repository code. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { handleCloudBroker, CLOUD_REPO_PROPOSAL_LIMITS, CLOUD_REPO_BRANCH_LIMITS, CLOUD_REPO_READ_LIMITS } from '../cloud-brokers.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, manifestIdCanon } from '../head-do.mjs'

const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), NEXT = 'c'.repeat(40), BASE_TREE = 'd'.repeat(40), HEAD_TREE = 'e'.repeat(40)
const BRANCH = 'auma/proposal/fixture-fix', NOW = 1794367000000, EMAIL = 'owner@fixture.example'
const BOOTSTRAP = { ready: true, head: { phase: 'complete', seedId: '1'.repeat(64) }, mirror: { phase: 'ready' } }
const digest = value => createHash('sha256').update(value).digest('hex')
const blob = value => createHash('sha1').update(value).digest('hex')
const owner = { type: 'owner', email: EMAIL, expires: NOW / 1000 + 600 }
const json = value => Response.json(value)

function tree(files, sha, overrides = {}) {
  const entries = new Map()
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      entries.set(parent, { path: parent, mode: '040000', type: 'tree', sha: blob(parent + sha) })
    }
    entries.set(path, { path, mode: '100644', type: 'blob', sha: blob(content), size: Buffer.byteLength(content) })
  }
  return { sha, truncated: false, tree: [...entries.values()], ...overrides }
}

/** CI evidence is ONLY the latest push run of proposal-gate.yml (its four required jobs) AND of proposal-checks.yml (job
 * `checks`) on the exact branch and head, in that attempt (cloud-brokers proposalCi).
 * Other checks on the commit are never read as evidence. Unless a test says otherwise, proposal-checks passed too. */
const GATE_RUNS = '/actions/workflows/proposal-gate.yml/runs', GATE_JOBS = ['preflight', 'build', 'scrub-dist', 'bundle']
const CHECKS_RUNS = '/actions/workflows/proposal-checks.yml/runs', CHECKS_RUN_ID = 9001
const gateRun = (patch = {}) => ({ id: 7, workflow_id: 11, run_number: 3, run_attempt: 1, head_sha: HEAD, head_branch: BRANCH, event: 'push', path: '.github/workflows/proposal-gate.yml', status: 'completed', conclusion: 'success', ...patch })
const gateJob = (name, patch = {}) => ({ id: 100 + GATE_JOBS.indexOf(name) + 1, run_id: 7, head_sha: HEAD, name, status: 'completed', conclusion: 'success', ...patch })
const checksRun = (patch = {}) => ({ id: CHECKS_RUN_ID, workflow_id: 12, run_number: 3, run_attempt: 1, head_sha: HEAD, head_branch: BRANCH, event: 'push', path: '.github/workflows/proposal-checks.yml', status: 'completed', conclusion: 'success', ...patch })
const checksJob = (patch = {}) => ({ id: 9101, run_id: CHECKS_RUN_ID, head_sha: HEAD, name: 'checks', status: 'completed', conclusion: 'success', ...patch })
const gateCi = ({ runs = [gateRun()], jobs = GATE_JOBS.map(name => gateJob(name)), checks = [], checksRuns = [checksRun()], checksJobs = [checksJob()] } = {}) => url => url.pathname.endsWith(GATE_RUNS) ? json({ total_count: runs.length, workflow_runs: runs })
  : url.pathname.endsWith(CHECKS_RUNS) ? json({ total_count: checksRuns.length, workflow_runs: checksRuns })
  : url.pathname.endsWith(`/actions/runs/${CHECKS_RUN_ID}/attempts/1/jobs`) ? json({ total_count: checksJobs.length, jobs: checksJobs })
  : url.pathname.endsWith('/jobs') ? json({ total_count: jobs.length, jobs }) : json({ total_count: checks.length, check_runs: checks })
/** Both workflows passed on the exact proposal head: merges need it (cloud-brokers mergeProposal reads CI before approval). */
const PASSED_CI = gateCi()

function fixture({ before = { 'deploy/cloudflare/src/crew-relay-tool.mjs': 'old\n' }, after = { 'deploy/cloudflare/src/crew-relay-tool.mjs': 'new\n' }, access = owner, hook, treeOverride, ci, storage, bootstrap = BOOTSTRAP, now = () => NOW, env: extraEnv = {} } = {}) {
  const refs = new Map([['main', BASE], [BRANCH, HEAD]]), calls = [], tokens = new Map(), proposals = [], outcomes = []
  let staged = null, attempt = null, attemptOwner = null, consumed = 0, currentRequest
  const env = { GITHUB_TOKEN: 'synthetic-token-value', OWNER_EMAIL: EMAIL, PUBLIC_HOST: 'fixture.example', SOURCE_REVISION: BASE, ...extraEnv }
  env.HEAD ??= { idFromName: name => name, get: () => ({ fetch: async request => {
    const input = await request.json()
    assert.equal(request.headers.get('x-x6-internal-authorized'), '1')
    assert.deepEqual(JSON.parse(request.headers.get('x-x6-verified-access')), access)
    if (storage) return await storage(input)
    if (input.action === 'stage') { if (attempt) return json({ ok: false, code: 'REPO_MERGE_PENDING' }); staged = input.proposal; proposals.push(staged); return json({ ok: true }) }
    if (input.action === 'begin_merge') {
      if (attempt || !staged || canonicalJson(input.mergeBody) !== canonicalJson(staged.mergeBody) || canonicalJson(input.binding) !== canonicalJson(staged.binding)) return new Response(JSON.stringify({ ok: false, code: 'REPO_PROPOSAL_MISMATCH' }), { status: 409, headers: { 'content-type': 'application/json' } })
      // MUST 3a: HEAD consumes his approval in the same step that claims the attempt (as the real HeadDO does in
      // one storage transaction): a refused or expired approval claims nothing.
      const key = request.headers.get('x-x6-class3-approval'), approval = tokens.get(key)
      const refuse = code => new Response(JSON.stringify({ ok: false, code }), { status: 403, headers: { 'content-type': 'application/json' } })
      if (!approval || canonicalJson(approval.binding) !== canonicalJson(input.binding)) return refuse('CLASS3_WEBAUTHN_REQUIRED')
      if (approval.expiresAt <= now()) return refuse('CLASS3_APPROVAL_EXPIRED')
      tokens.delete(key); consumed++
      attempt = 'fixture-attempt-123456'; attemptOwner = input.owner
      return json({ ok: true, attemptId: attempt, startedAt: now(), approvalExpiresAt: approval.expiresAt })
    }
    if (input.action === 'mark_merge') { assert.equal(input.owner, attemptOwner); assert.equal(input.attemptId, attempt); outcomes.push({ state: 'marked' }); return json({ ok: true, attemptId: attempt, state: 'marked' }) }
    if (input.action === 'merge_outcome') {
      assert.equal(input.owner, attemptOwner); if (input.attemptId !== undefined) assert.equal(input.attemptId, attempt)
      outcomes.push(input.outcome); if (input.outcome.status === 'succeeded') staged = null; if (input.outcome.status !== 'unknown') attempt = null; return json({ ok: true })
    }
    // HEAD's answer when no earlier merge call left a durable attempt (every merge asks first: MUST 5).
    if (input.action === 'inspect_merge' && !attempt) return new Response(JSON.stringify({ ok: false, code: 'REPO_MERGE_ATTEMPT_MISSING' }), { status: 409, headers: { 'content-type': 'application/json' } })
    throw new Error('Unexpected HEAD action')
  } }) }
  const networkFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl); calls.push({ url: rawUrl, ...init })
    if (hook) { const result = await hook(url, init, { refs, calls, before, after }); if (result !== undefined) return result }
    assert.equal(url.hostname, 'api.github.com')
    assert.equal(init.redirect, 'error')
    if (url.pathname === '/graphql') {
      const operation = JSON.parse(init.body), input = operation.variables.input
      if (operation.query.includes('updateRefs')) {
        assert.equal(input.repositoryId, 'R_fixture')
        if (input.refUpdates.some(update => (refs.get(update.name.slice('refs/heads/'.length)) ?? '0'.repeat(40)) !== update.beforeOid)) return json({ data: { updateRefs: null }, errors: [{ type: 'STALE_DATA' }] })
        for (const update of input.refUpdates) {
          assert.equal(update.force, false)
          const branch = update.name.slice('refs/heads/'.length)
          if (update.afterOid === '0'.repeat(40)) refs.delete(branch); else refs.set(branch, update.afterOid)
        }
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
      const [base, head] = url.pathname.split('/compare/')[1].split('...')
      return json({ base_commit: { sha: base }, merge_base_commit: { sha: base }, ahead_by: base === head ? 0 : 1, behind_by: 0, status: base === head ? 'identical' : 'ahead', files: [] })
    }
    if (url.pathname.endsWith('/check-runs')) return ci ? await ci(url) : json({ total_count: 0, check_runs: [] })
    if (url.pathname.endsWith('/actions/runs') || url.pathname.endsWith(GATE_RUNS) || url.pathname.endsWith(CHECKS_RUNS)) return ci ? await ci(url) : json({ total_count: 0, workflow_runs: [] })
    if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(url.pathname)) return ci ? await ci(url) : json({ total_count: 0, jobs: [] })
    if (url.pathname.startsWith(PREFIX + '/commits/')) {
      const ref = decodeURIComponent(url.pathname.slice((PREFIX + '/commits/').length)), sha = refs.get(ref) ?? ref
      return json({ sha, commit: { tree: { sha: sha === BASE ? BASE_TREE : HEAD_TREE } } })
    }
    if (url.pathname.startsWith(PREFIX + '/git/trees/')) {
      const sha = url.pathname.split('/').at(-1), value = tree(sha === BASE_TREE ? before : after, sha)
      return json(treeOverride ? treeOverride(value) : value)
    }
    if (url.pathname.startsWith(PREFIX + '/contents/')) {
      const path = decodeURIComponent(url.pathname.slice((PREFIX + '/contents/').length)), files = url.searchParams.get('ref') === BASE ? before : after, content = files[path]
      if (content === undefined) return new Response('', { status: 404 })
      return json({ type: 'file', path, sha: blob(content), encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    throw new Error('Unexpected synthetic URL ' + url.pathname)
  }
  return { refs, calls, env, proposals, outcomes, get consumed() { return consumed },
    grant(input, changes = {}) {
      const token = 'fixture-approval-' + tokens.size + '-' + consumed
      tokens.set(token, { ok: true, expiresAt: NOW + 60000, binding: { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/repo', bodySha256: digest(canonicalJson(input)), ...changes } })
      return token
    },
    async request(input, { route = '/_host/repo', token, signal } = {}) {
      currentRequest = new Request(ORIGIN + route, { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(token ? { 'x-x6-class3-approval': token } : {}) }, body: JSON.stringify(input), signal })
      const response = await handleCloudBroker(currentRequest, env, { access, bootstrap, now, networkFetch, authorizeClass3: async value => {
        const key = currentRequest.headers.get('x-x6-class3-approval'), approval = tokens.get(key)
        if (!approval || approval.binding.bodySha256 !== digest(canonicalJson(value))) return { ok: false }
        tokens.delete(key); consumed++; return approval
      } })
      return { status: response.status, value: await response.json() }
    },
    async stage() {
      const result = await this.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix bounded fixture' })
      assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value.proposal
    },
  }
}

function mirror(files, gone = []) {
  const identity = { lineageId: '11111111-1111-1111-1111-111111111111', revision: 1 }
  return { idFromName: name => name, get: () => ({ fetch: async request => {
    if (new URL(request.url).pathname === '/_mirror/status') return json({ ok: true, ...identity, homeFiles: Object.keys(files).filter(path => path.startsWith('mirror/home/')).map(path => path.slice('mirror/home/'.length)), workspaceFiles: Object.keys(files).filter(path => !path.startsWith('mirror/')) })
    const { path } = await request.json(), repoPath = path.startsWith('/dsh/home/') ? 'mirror/home/' + path.slice('/dsh/home/'.length) : path.slice('/dsh/workspace/'.length)
    return json({ ok: true, path, ...identity, kind: gone.includes(repoPath) ? 'gone' : Object.hasOwn(files, repoPath) ? 'file' : 'missing', ...(Object.hasOwn(files, repoPath) ? { b64: Buffer.from(files[repoPath]).toString('base64') } : {}) })
  } }) }
}

test('private branch writes permit T2 source and bind caller drafts and commits to the observed branch', async () => {
  const broker = fixture(), path = 'deploy/cloudflare/src/crew-relay-tool.mjs'
  const draft = await broker.request({ action: 'write', branch: BRANCH, path, content: 'next\n', ownerSession: true })
  assert.equal(draft.status, 200); assert.equal(draft.value.scope, 'caller'); assert.equal(draft.value.baseSha, HEAD)
  assert.equal(broker.calls.some(call => call.method === 'POST'), false)
  const result = await broker.request({ action: 'commit', branch: BRANCH, message: 'Fix fixture', expectedHeadSha: HEAD, changes: [{ path, content: 'next\n' }] })
  assert.equal(result.status, 200); assert.equal(result.value.commitSha, NEXT); assert.equal(broker.refs.get('main'), BASE)
  const input = JSON.parse(broker.calls.find(call => call.method === 'POST').body).variables.input
  assert.equal(input.branch.branchName, BRANCH); assert.equal(input.expectedHeadOid, HEAD)
})

test('branch operations reject access sessions, expired owner, caller authority and invalid namespaces before network calls', async () => {
  for (const access of [null, { ...owner, type: 'access' }, { ...owner, expires: NOW / 1000 }, { ...owner, email: 'other@fixture.example' }]) {
    const broker = fixture({ access })
    const result = await broker.request({ action: 'branch_create', branch: BRANCH, ownerSession: true })
    assert.equal(result.value.code, 'OWNER_SESSION_REQUIRED'); assert.equal(broker.calls.length, 0)
  }
  for (const branch of ['main', 'auma/other/fix', 'auma/proposal/x', 'auma/proposal/a..b', 'auma/proposal/fix.lock', 'other/auma/proposal/xx']) {
    const broker = fixture(), result = await broker.request({ action: 'branch_create', branch })
    assert.equal(result.status, 403); assert.equal(broker.calls.length, 0)
  }
})

test('branch create/delete use exact absent/current ref CAS and leave main unchanged', async () => {
  const broker = fixture(), branch = 'auma/sandbox/fixture-new'
  assert.equal((await broker.request({ action: 'branch_create', branch })).value.headSha, BASE)
  assert.equal((await broker.request({ action: 'branch_create', branch })).value.created, false)
  assert.equal((await broker.request({ action: 'branch_delete', branch })).value.deleted, true)
  assert.equal(broker.refs.has(branch), false); assert.equal(broker.refs.get('main'), BASE)
  const mutations = broker.calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body).variables.input.refUpdates[0])
  assert.deepEqual(mutations.map(item => [item.beforeOid, item.afterOid]), [['0'.repeat(40), BASE], [BASE, '0'.repeat(40)]])
})

test('owner verification accepts case-normalized email from the trusted access object', async () => {
  const broker = fixture({ access: { ...owner, email: EMAIL.toUpperCase() } })
  assert.equal((await broker.request({ action: 'branch_create', branch: BRANCH })).status, 200)
})

test('workflow, traversal, private paths and content stay refused on sandbox branches', async () => {
  const broker = fixture()
  for (const path of ['.github/workflows/evil.yml', 'docs/../../.github/workflows/evil.yml', 'server/private/file.mjs', 'server/.env', 'packages/credentials/index.ts']) {
    assert.equal((await broker.request({ action: 'write', branch: BRANCH, path, content: 'safe' })).status, 403)
  }
  for (const content of ['synthetic-token-value', '-----BEGIN PRIVATE KEY-----', '{"access_token":"fixture"}']) {
    assert.equal((await broker.request({ action: 'write', branch: BRANCH, path: 'deploy/cloudflare/src/crew-relay-tool.mjs', content })).value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  }
  assert.equal(broker.calls.length, 0)
})

test('main T2 publication stays refused even with exact legacy Class 3 publication fields, naming the proposal route', async () => {
  const broker = fixture(), input = { action: 'write', path: 'deploy/cloudflare/src/crew-relay-tool.mjs', content: 'next', expectedHeadSha: BASE, idempotencyKey: 'fixture-idempotency', message: 'Fix' }
  const refused = (await broker.request(input, { token: broker.grant(input) })).value
  assert.equal(refused.code, 'REPO_PROPOSAL_REQUIRED'); assert.match(refused.next, /^proposal: branch_create auma\/proposal\/<name>/)
  assert.equal(broker.consumed, 0); assert.equal(broker.calls.length, 0)
})

test('branch edit reads exact branch bytes and refuses stale draft base', async () => {
  const broker = fixture(), input = { action: 'edit', branch: BRANCH, path: 'deploy/cloudflare/src/crew-relay-tool.mjs', oldString: 'new', newString: 'fixed' }
  assert.equal((await broker.request(input)).value.content, 'fixed\n')
  assert.equal((await broker.request({ ...input, expectedHeadSha: BASE })).value.code, 'REPO_HEAD_CONFLICT')
  assert.equal(broker.calls.some(call => call.method === 'POST'), false)
})

test('search overlays live files, includes mirror-only files and hides tombstones', async () => {
  const before = { 'docs/auma/a.md': 'old needle\n', 'docs/auma/gone.md': 'needle gone\n', 'server/fixture.mjs': 'Needle source\n' }
  const broker = fixture({ before, env: { MIRROR: mirror({ 'docs/auma/a.md': 'live needle\n', 'docs/auma/new.md': 'new needle\n' }, ['docs/auma/gone.md']) } })
  const result = await broker.request({ action: 'search', query: 'needle' })
  assert.equal(result.status, 200); assert.deepEqual(result.value.matches.map(item => item.text), ['live needle', 'new needle', 'Needle source'])
  assert.equal(result.value.filesScanned, 3); assert.equal(result.value.truncated, false)
})

test('branch searches never use MIRROR and disclose max-match truncation', async () => {
  const broker = fixture({ after: { 'server/fixture.mjs': 'needle one\nneedle two\n' }, env: { MIRROR: { idFromName() { throw new Error('MIRROR must not be read') } } } })
  const result = await broker.request({ action: 'search', branch: BRANCH, query: 'needle', maxMatches: 1 })
  assert.equal(result.status, 200); assert.equal(result.value.matches.length, 1); assert.equal(result.value.truncated, true)
})

test('regex search supports fixed-width atoms but refuses all variable backtracking operators', async () => {
  const broker = fixture({ after: { 'server/fixture.mjs': 'abc123\n' } })
  assert.equal((await broker.request({ action: 'search', branch: BRANCH, query: '^abc[0-9]\\d\\d$', regex: true })).value.matches.length, 1)
  for (const query of ['(a+)+$', 'a*a*b', '(a|aa)+$', 'a{1,10}', 'a?', '\\1', '(?=x)', '[abc']) {
    const count = broker.calls.length
    assert.equal((await broker.request({ action: 'search', branch: BRANCH, query, regex: true })).value.code, 'REPO_SEARCH_REGEX_UNSUPPORTED')
    assert.equal(broker.calls.length, count)
  }
})

test('compare_files returns deterministic unified hunks across github and VFS aliases', async () => {
  const path = 'server/fixture.mjs', before = { [path]: 'same\nold\nend\n' }
  const broker = fixture({ before, env: { MIRROR: mirror({ 'mirror/home/auma/seed/organs/fixture.js': 'same\nnew\nend' }) } })
  const input = { action: 'compare_files', leftPath: path, rightPath: '/dsh/home/auma/seed/organs/fixture.js', leftSource: 'github', rightSource: 'mirror', contextLines: 1 }
  const first = await broker.request(input), second = await broker.request(input)
  assert.equal(first.status, 200); assert.deepEqual(first.value, second.value)
  assert.match(first.value.diff, /@@ -1,3 \+1,3 @@/); assert.match(first.value.diff, /\\ No newline at end of file/)
  assert.equal(first.value.leftBytes, 13); assert.equal(first.value.rightBytes, 12)
})

test('compare_files safely delivers near-limit quoted text and screens unchanged secret content', async () => {
  const a = '"'.repeat(256 * 1024), b = '\\'.repeat(256 * 1024)
  const broker = fixture({ before: { 'server/a.mjs': a, 'server/b.mjs': b } })
  const result = await broker.request({ action: 'compare_files', leftPath: 'server/a.mjs', rightPath: 'server/b.mjs', leftSource: 'github', rightSource: 'github' })
  assert.equal(result.status, 200); assert.equal(result.value.leftBytes, 256 * 1024); assert.ok(result.value.diff.length > 512 * 1024)
  const secret = fixture({ before: { 'server/a.mjs': 'synthetic-token-value' } })
  assert.equal((await secret.request({ action: 'compare_files', leftPath: 'server/a.mjs', rightPath: 'server/a.mjs', leftSource: 'github', rightSource: 'github' })).value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
})

test('stage proposal derives complete changed paths and exact canonical binding without compare.files', async () => {
  const broker = fixture(), proposal = await broker.stage()
  assert.deepEqual(proposal.mergeBody, { action: 'merge_proposal', baseSha: BASE, branch: BRANCH, headSha: HEAD, treeSha: HEAD_TREE })
  assert.equal(proposal.binding.bodySha256, digest(canonicalJson(proposal.mergeBody))); assert.equal(proposal.binding.audience, ORIGIN)
  assert.equal(proposal.ciStatus, 'none'); assert.equal(proposal.changedFiles[0].t2Protected, true)
  assert.deepEqual(proposal.changedFiles[0], { path: 'deploy/cloudflare/src/crew-relay-tool.mjs', status: 'modified', additions: 1, deletions: 1, t2Protected: true })
  assert.equal(broker.calls.some(call => call.method === 'POST'), false)
})

test('stage_proposal admits core-sized immutable content with an actual compare response above 256 KiB', async () => {
  // A core-sized T2 file her proposals may change (ball-loader.ts itself is frozen: repo-frozen-paths.test.mjs; a file of
  // her own edge folder is open for ADDITION only, so a change stands on her relay tool).
  const path = 'deploy/cloudflare/src/crew-relay-tool.mjs'
  const content = 'export const marker = "new";\n' + '// source 😀 "quoted" \\value\n'.repeat(16000)
  assert.ok(Buffer.byteLength(content) > 400 * 1024)
  const compare = { base_commit: { sha: BASE }, merge_base_commit: { sha: BASE }, ahead_by: 1, behind_by: 0, status: 'ahead',
    files: [{ filename: path, status: 'modified', patch: '@@ -1 +1,16001 @@\n-old\n' + content.split('\n').slice(0, -1).map(line => '+' + line + '\n').join('') }] }
  assert.ok(Buffer.byteLength(JSON.stringify(compare)) > 256 * 1024)
  const hook = url => url.pathname.includes('/compare/') ? json(compare) : undefined
  const broker = fixture({ before: { [path]: 'old\n' }, after: { [path]: content }, hook })
  const proposal = await broker.stage()
  assert.deepEqual(proposal.changedFiles, [{ path, status: 'modified', additions: 16001, deletions: 1, t2Protected: true }])
  assert.deepEqual(proposal.mergeBody, { action: 'merge_proposal', baseSha: BASE, branch: BRANCH, headSha: HEAD, treeSha: HEAD_TREE })
  assert.equal(broker.proposals.length, 1); assert.equal(broker.calls.some(call => call.method === 'POST'), false)
  const forbidden = fixture({ before: { [path]: 'old\n' }, after: { [path]: content, '.github/workflows/hidden.yml': 'forbidden\n' }, hook })
  assert.equal((await forbidden.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix' })).status, 403)
  assert.equal(forbidden.proposals.length, 0)
})

test('stage_proposal refuses compare responses beyond the finite 8 MiB ancestry cap', async () => {
  const broker = fixture({ hook: url => url.pathname.includes('/compare/') ? json({ base_commit: { sha: BASE }, merge_base_commit: { sha: BASE }, ahead_by: 1, behind_by: 0, status: 'ahead',
    files: [{ filename: 'server/fixture.mjs', status: 'modified', patch: 'x'.repeat(8 * 1024 * 1024) }] }) : undefined })
  const result = await broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix' })
  assert.equal(result.status, 413); assert.equal(result.value.code, 'BROKER_BODY_TOO_LARGE')
  assert.equal(broker.proposals.length, 0); assert.equal(broker.calls.some(call => call.method === 'POST'), false)
})

test('proposal inspection refuses any forbidden changed path before allowed-path projection', async () => {
  for (const path of ['.github/workflows/evil.yml', 'server/private/fixture.mjs', 'server/.hidden/fixture.mjs', 'unapproved/file.mjs']) {
    const broker = fixture({ after: { 'deploy/cloudflare/src/crew-relay-tool.mjs': 'new\n', [path]: 'forbidden\n' } })
    assert.equal((await broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix' })).status, 403)
    assert.equal(broker.proposals.length, 0)
  }
})

test('proposal inspection refuses truncated trees, nonregular changes and oversized file lists', async () => {
  for (const override of [value => ({ ...value, truncated: true }), value => ({ ...value, tree: value.tree.map(entry => entry.type === 'blob' ? { ...entry, mode: '120000' } : entry) })]) {
    const broker = fixture({ treeOverride: override })
    assert.notEqual((await broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix' })).status, 200); assert.equal(broker.proposals.length, 0)
  }
  const after = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`deploy/cloudflare/src/auma/file-${index}.mjs`, 'new']))
  const large = fixture({ before: {}, after })
  assert.equal((await large.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix' })).value.code, 'REPO_PROPOSAL_TOO_LARGE')
})

test('CI evidence is the latest proposal-gate run on the exact branch and commit with every required job', async () => {
  const passed = fixture({ ci: PASSED_CI })
  assert.equal((await passed.stage()).ciStatus, 'passed')
  const query = new URL(passed.calls.find(call => call.url.includes(GATE_RUNS)).url)
  assert.deepEqual([query.searchParams.get('branch'), query.searchParams.get('head_sha'), query.searchParams.get('event')], [BRANCH, HEAD, 'push'])
  assert.ok(passed.calls.some(call => new URL(call.url).pathname.endsWith('/actions/runs/7/attempts/1/jobs')))
  assert.equal(passed.calls.some(call => call.url.includes('/check-runs')), false, 'other checks on the commit are not evidence')
  // An unrelated green check with no proposal-gate run is no evidence at all.
  assert.equal((await fixture({ ci: gateCi({ runs: [], checksRuns: [], checks: [{ id: 1, head_sha: HEAD, status: 'completed', conclusion: 'success' }] }) }).stage()).ciStatus, 'none')
  for (const [ci, ciStatus] of [
    [gateCi({ runs: [gateRun({ status: 'in_progress', conclusion: null })] }), 'pending'],
    [gateCi({ runs: [gateRun({ conclusion: 'failure' })] }), 'failed'],
    [gateCi({ jobs: GATE_JOBS.filter(name => name !== 'scrub-dist').map(name => gateJob(name)) }), 'failed'],
    [gateCi({ jobs: GATE_JOBS.map(name => gateJob(name, name === 'bundle' ? { conclusion: 'skipped' } : {})) }), 'failed'],
    [gateCi({ jobs: [...GATE_JOBS.map(name => gateJob(name)), gateJob('build', { id: 120 })] }), 'failed'],
    // The latest attempt of the latest run decides: a re-run that failed outranks the attempt that passed.
    [gateCi({ runs: [gateRun({ id: 8, run_attempt: 2, conclusion: 'failure' }), gateRun({ id: 7 })] }), 'failed'],
    [gateCi({ runs: [gateRun({ id: 6, run_number: 2, conclusion: 'failure' }), gateRun()] }), 'passed'],
  ]) assert.equal((await fixture({ ci }).stage()).ciStatus, ciStatus)
  for (const ci of [() => new Response('', { status: 503 }), gateCi({ runs: [gateRun({ head_sha: BASE })] }), gateCi({ runs: [gateRun({ head_branch: 'main' })] }),
    gateCi({ runs: [gateRun({ path: '.github/workflows/ci.yml' })] }), gateCi({ runs: [gateRun({ event: 'workflow_dispatch' })] }),
    gateCi({ jobs: GATE_JOBS.map(name => gateJob(name, { run_id: 99 })) }), gateCi({ jobs: GATE_JOBS.map(name => gateJob(name, { head_sha: BASE })) }),
    url => url.pathname.endsWith(GATE_RUNS) ? json({ total_count: 2, workflow_runs: [gateRun()] }) : PASSED_CI(url)]) {
    const broker = fixture({ ci }), result = await broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix' })
    assert.notEqual(result.status, 200); assert.equal(broker.proposals.length, 0)
  }
})

test('merge needs proposal-gate passed on the exact head now, not the card snapshot, and a refusal spends no approval', async () => {
  let current = { runs: [], checksRuns: [] }
  const broker = fixture({ ci: url => gateCi(current)(url) })
  const proposal = await broker.stage()
  assert.equal(proposal.ciStatus, 'none')
  const token = broker.grant(proposal.mergeBody)
  for (const [state, ciStatus] of [
    [{ runs: [], checksRuns: [] }, 'none'],
    // One unnamed successful check and zero proposal-gate runs is not "CI passed".
    [{ runs: [], checksRuns: [], checks: [{ id: 1, head_sha: HEAD, status: 'completed', conclusion: 'success' }] }, 'none'],
    [{ runs: [gateRun({ status: 'in_progress', conclusion: null })] }, 'pending'],
    [{ runs: [gateRun({ conclusion: 'failure' })] }, 'failed'],
    [{ runs: [gateRun({ conclusion: 'cancelled' })] }, 'failed'],
    [{ jobs: GATE_JOBS.slice(0, 3).map(name => gateJob(name)) }, 'failed'],
  ]) {
    current = state
    const result = await broker.request(proposal.mergeBody, { token })
    assert.equal(result.status, 409, ciStatus); assert.equal(result.value.code, 'REPO_PROPOSAL_CI_NOT_PASSED')
    assert.equal(result.value.ciStatus, ciStatus); assert.match(result.value.next, /proposal-gate/)
    assert.equal(broker.consumed, 0); assert.equal(broker.refs.get('main'), BASE); assert.deepEqual(broker.outcomes, [])
    assert.equal(broker.calls.some(call => call.method === 'POST'), false)
  }
  // The gate finishing green afterwards is enough: the same approval over the same card now merges.
  current = {}
  const merged = await broker.request(proposal.mergeBody, { token })
  assert.equal(merged.status, 200, JSON.stringify(merged.value)); assert.equal(broker.refs.get('main'), HEAD); assert.equal(broker.consumed, 1)
  // An unreadable CI answer refuses too.
  const unread = fixture({ ci: () => new Response('', { status: 503 }) }), input = { action: 'merge_proposal', branch: BRANCH, baseSha: BASE, headSha: HEAD, treeSha: HEAD_TREE }
  assert.notEqual((await unread.request(input, { token: unread.grant(input) })).status, 200)
  assert.equal(unread.consumed, 0); assert.equal(unread.calls.some(call => call.method === 'POST'), false)
})

test('merge consumes exact single-use approval and atomically binds both refs to the immutable approved head', async () => {
  const broker = fixture({ ci: PASSED_CI }), proposal = await broker.stage(), token = broker.grant(proposal.mergeBody)
  const result = await broker.request(proposal.mergeBody, { token })
  assert.equal(result.status, 200); assert.equal(result.value.commitSha, HEAD); assert.equal(broker.refs.get('main'), HEAD)
  const updates = JSON.parse(broker.calls.find(call => call.method === 'POST').body).variables.input.refUpdates
  assert.deepEqual(updates, [{ name: 'refs/heads/main', beforeOid: BASE, afterOid: HEAD, force: false }, { name: 'refs/heads/' + BRANCH, beforeOid: HEAD, afterOid: HEAD, force: false }])
  // The attempt is marked as reaching the ref update before the dispatch (MUST 5: by its owner), then settled.
  assert.deepEqual(broker.outcomes, [{ state: 'marked' }, { status: 'succeeded', commitSha: HEAD }]); assert.equal(broker.consumed, 1)
  // A replay now meets the moved main in the reads, before any approval is asked for (the token's single use is proven
  // where the reads still pass: repo-merge-approval.test.mjs).
  assert.equal((await broker.request(proposal.mergeBody, { token })).value.code, 'REPO_HEAD_CONFLICT')
  assert.equal(broker.consumed, 1); assert.equal(broker.calls.filter(call => call.method === 'POST').length, 1)
})

test('merge refuses mismatched route binding and preflight branch swap without mutations', async () => {
  const broker = fixture({ ci: PASSED_CI }), proposal = await broker.stage(), input = proposal.mergeBody
  assert.equal((await broker.request(input, { token: broker.grant(input, { pathname: '/_host/github' }) })).value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  broker.refs.set(BRANCH, NEXT)
  assert.equal((await broker.request(input, { token: broker.grant(input) })).value.code, 'REPO_HEAD_CONFLICT')
  assert.equal(broker.calls.some(call => call.method === 'POST'), false); assert.equal(broker.refs.get('main'), BASE)
})

test('atomic CAS rejects main or branch movement after preflight without landing unapproved bytes', async () => {
  for (const moved of ['main', BRANCH]) {
    const broker = fixture({ ci: PASSED_CI, hook: (url, init, { refs }) => { if (url.pathname === '/graphql') refs.set(moved, NEXT) } })
    const proposal = await broker.stage(), result = await broker.request(proposal.mergeBody, { token: broker.grant(proposal.mergeBody) })
    assert.equal(result.status, 503); assert.equal(result.value.code, 'REPO_REF_OUTCOME_UNKNOWN')
    assert.equal(broker.refs.get('main'), moved === 'main' ? NEXT : BASE)
    assert.deepEqual(broker.outcomes[0], { state: 'marked' }); assert.equal(broker.outcomes.at(-1).status, 'unknown')
  }
})

test('lost mutation response records unknown and never retries or substitutes a REST update', async () => {
  const broker = fixture({ ci: PASSED_CI, hook: (url, init, { refs }) => { if (url.pathname === '/graphql') { refs.set('main', HEAD); throw new Error('Lost provider response') } } })
  const proposal = await broker.stage(), result = await broker.request(proposal.mergeBody, { token: broker.grant(proposal.mergeBody) })
  assert.equal(result.value.code, 'REPO_REF_OUTCOME_UNKNOWN'); assert.equal(broker.outcomes.at(-1).status, 'unknown')
  assert.equal(broker.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(broker.calls.some(call => call.method === 'PATCH'), false)
})

test('unacknowledged durable stage or claim prevents all GitHub mutations', async () => {
  const broker = fixture({ ci: PASSED_CI, storage: () => new Response(JSON.stringify({ ok: false, code: 'REPO_PROPOSAL_STORAGE_FAILED' }), { status: 503, headers: { 'content-type': 'application/json' } }) })
  assert.equal((await broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix' })).status, 503)
  const input = { action: 'merge_proposal', branch: BRANCH, baseSha: BASE, headSha: HEAD, treeSha: HEAD_TREE }
  assert.equal((await broker.request(input, { token: broker.grant(input) })).status, 503)
  assert.equal(broker.calls.some(call => call.method === 'POST'), false)
})

test('job logs follow only one signed Azure redirect with auth stripped and project a UTF-8 tail', async () => {
  const log = '\u001b[31m' + '😀"'.repeat(30000) + '\u001b[0m', calls = []
  const broker = fixture({ hook: (url, init) => {
    calls.push({ url, init })
    if (url.hostname === 'api.github.com') { assert.match(init.headers.authorization, /^Bearer /); assert.equal(init.redirect, 'manual'); return new Response(null, { status: 302, headers: { location: 'https://fixturelogs.blob.core.windows.net/logs/job.txt?sig=fixture' } }) }
    assert.equal(init.headers.authorization, undefined); assert.deepEqual(init.headers, { accept: 'text/plain' }); assert.equal(init.redirect, 'error')
    return new Response(log)
  } })
  const result = await broker.request({ action: 'api', endpoint: PREFIX + '/actions/jobs/42/logs' }, { route: '/_host/github' })
  assert.equal(result.status, 200); assert.equal(result.value.json.truncated, true); assert.equal(result.value.json.log.includes('\u001b'), false)
  assert.ok(Buffer.byteLength(result.value.json.log) <= CLOUD_REPO_PROPOSAL_LIMITS.logTailBytes); assert.equal(result.value.json.log.includes('\ufffd'), false); assert.equal(calls.length, 2)
})

test('logs screen secret bytes before discarded tail and after stripping ANSI', async () => {
  for (const log of ['synthetic-token-value\n' + 'x'.repeat(140000), 'synthetic-\u001b[31mtoken-value', '{"access_token":"fixture"}\n']) {
    const broker = fixture({ hook: () => new Response(log) })
    const result = await broker.request({ action: 'api', endpoint: PREFIX + '/actions/jobs/42/logs' }, { route: '/_host/github' })
    assert.equal(result.status, 403); assert.equal(result.value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  }
})

test('logs refuse arbitrary hosts, redirect chains and oversize streams', async () => {
  for (const location of ['http://fixturelogs.blob.core.windows.net/log?sig=x', 'https://attacker.example/log?sig=x', 'https://fixturelogs.blob.core.windows.net/log', 'https://u:p@fixturelogs.blob.core.windows.net/log?sig=x']) {
    const broker = fixture({ hook: () => new Response(null, { status: 302, headers: { location } }) })
    assert.equal((await broker.request({ action: 'api', endpoint: PREFIX + '/actions/jobs/42/logs' }, { route: '/_host/github' })).value.code, 'BROKER_REDIRECT_REFUSED')
    assert.equal(broker.calls.length, 1)
  }
  const large = fixture({ hook: () => new Response('x'.repeat(CLOUD_REPO_PROPOSAL_LIMITS.logBytes + 1)) })
  assert.equal((await large.request({ action: 'api', endpoint: PREFIX + '/actions/jobs/42/logs' }, { route: '/_host/github' })).value.code, 'BROKER_BODY_TOO_LARGE')
})

test('Actions jobs expose only failed steps and branch queries accept only the Auma namespace', async () => {
  const broker = fixture({ hook: url => url.pathname.endsWith('/jobs') ? json({ total_count: 1, jobs: [{ id: 4, run_id: 2, name: 'unit', status: 'completed', conclusion: 'failure', runner_name: 'discard', steps: [
    { number: 1, name: 'setup', status: 'completed', conclusion: 'success' }, { number: 2, name: 'test', status: 'completed', conclusion: 'failure' },
  ] }] }) : undefined })
  const result = await broker.request({ action: 'api', endpoint: PREFIX + '/actions/runs/2/jobs' }, { route: '/_host/github' })
  assert.equal(result.status, 200); assert.deepEqual(result.value.json.items[0].steps.map(step => step.name), ['test']); assert.equal(JSON.stringify(result.value).includes('discard'), false)
  assert.equal((await broker.request({ action: 'api', endpoint: PREFIX + '/actions/runs?branch=auma%2Fproposal%2Ffixture-fix&per_page=100' }, { route: '/_host/github' })).status, 200)
  assert.equal((await broker.request({ action: 'api', endpoint: PREFIX + '/actions/runs?branch=attacker%2Fbranch' }, { route: '/_host/github' })).status, 403)
})

test('GraphQL internal errors after synthetic commits preserve unknown outcomes for merges and branch commits', async () => {
  for (const merge of [true, false]) {
    const broker = fixture({ ci: PASSED_CI, hook: (url, init, { refs }) => {
      if (url.pathname !== '/graphql') return
      refs.set(merge ? 'main' : BRANCH, merge ? HEAD : NEXT)
      return json({ data: null, errors: [{ type: 'INTERNAL', message: 'Resolver failed after write' }] })
    } })
    const input = merge ? (await broker.stage()).mergeBody : { action: 'commit', branch: BRANCH, message: 'Fix', changes: [{ path: 'deploy/cloudflare/src/crew-relay-tool.mjs', content: 'new' }] }
    const result = await broker.request(input, { token: merge ? broker.grant(input) : undefined })
    assert.equal(result.value.code, 'REPO_REF_OUTCOME_UNKNOWN'); assert.equal(broker.refs.get(merge ? 'main' : BRANCH), merge ? HEAD : NEXT)
    if (merge) assert.equal(broker.outcomes.at(-1).status, 'unknown')
    assert.equal(broker.calls.filter(call => call.method === 'POST').length, 1)
  }
})

test('proposal scans whole immutable trees even when a forbidden path would lie beyond a 300-file compare cap', async () => {
  const before = Object.fromEntries(Array.from({ length: 350 }, (_, index) => [`server/file-${index}.mjs`, 'before']))
  before['.github/workflows/run.yml'] = 'old'
  const after = Object.fromEntries(Object.entries(before).map(([path]) => [path, 'after']))
  const broker = fixture({ before, after })
  const result = await broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix' })
  assert.equal(result.value.code, 'REPO_PROPOSAL_PATH_REFUSED'); assert.equal(broker.proposals.length, 0)
})

test('proposal screens unchanged context within changed files and refuses exact tree mismatch before dispatch', async () => {
  const broker = fixture({ after: { 'deploy/cloudflare/src/crew-relay-tool.mjs': 'new\nsynthetic-token-value\n' } })
  assert.equal((await broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix' })).value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  const second = fixture({ ci: PASSED_CI }), staged = await second.stage(), input = { ...staged.mergeBody, treeSha: 'f'.repeat(40) }
  assert.equal((await second.request(input, { token: second.grant(input) })).value.code, 'REPO_HEAD_CONFLICT')
  assert.equal(second.calls.some(call => call.method === 'POST'), false)
})

test('complete paginated exact-head CI evidence reaches the second page and rejects wrong branch runs', async () => {
  const runs = Array.from({ length: 101 }, (_, index) => gateRun({ id: index + 1, run_number: index + 1, conclusion: index === 100 ? 'success' : 'failure' }))
  const page = url => runs.slice((Number(url.searchParams.get('page')) - 1) * 100, Number(url.searchParams.get('page')) * 100)
  const broker = fixture({ ci: url => url.pathname.endsWith(GATE_RUNS) ? json({ total_count: runs.length, workflow_runs: page(url) }) : gateCi({ jobs: GATE_JOBS.map(name => gateJob(name, { run_id: 101 })) })(url) })
  assert.equal((await broker.stage()).ciStatus, 'passed')
  assert.equal(broker.calls.filter(call => call.url.includes(GATE_RUNS)).length, 2)
  const wrong = fixture({ ci: gateCi({ runs: [gateRun({ head_branch: 'main' })] }) })
  assert.equal((await wrong.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix' })).value.code, 'REPO_CI_INCOMPLETE')
})

test('compare_files accepts immutable SHA refs and identical files return no hunk', async () => {
  const broker = fixture({ before: { 'server/fixture.mjs': 'old\n' }, after: { 'server/fixture.mjs': 'new\n' } })
  const result = await broker.request({ action: 'compare_files', ref: HEAD, leftPath: 'server/fixture.mjs', rightPath: 'server/fixture.mjs' })
  assert.equal(result.status, 200); assert.equal(result.value.identical, true); assert.equal(result.value.diff, '')
  assert.ok(broker.calls.filter(call => call.url.includes('/contents/')).every(call => new URL(call.url).searchParams.get('ref') === HEAD))
})

test('redirect chains remain refused and streamed complete log limits cannot be bypassed by missing length', async () => {
  const chained = fixture({ hook: () => new Response(null, { status: 302, headers: { location: 'https://fixturelogs.blob.core.windows.net/log?sig=fixture' } }) })
  assert.equal((await chained.request({ action: 'api', endpoint: PREFIX + '/actions/jobs/42/logs' }, { route: '/_host/github' })).value.code, 'BROKER_REDIRECT_REFUSED')
  assert.equal(chained.calls.length, 2)
  let cancelled = false, emitted = 0
  const streamed = fixture({ hook: () => new Response(new ReadableStream({ pull(controller) { emitted++; controller.enqueue(new Uint8Array(64 * 1024).fill(120)) }, cancel() { cancelled = true } })) })
  assert.equal((await streamed.request({ action: 'api', endpoint: PREFIX + '/actions/jobs/42/logs' }, { route: '/_host/github' })).value.code, 'BROKER_BODY_TOO_LARGE')
  assert.equal(cancelled, true); assert.ok(emitted <= 34)
})

test('real HeadDO persists broker proposal, claims exact merge, clears stage and projects receipt', async () => {
  let data = new Map(), tail = Promise.resolve()
  const view = map => ({ get: async key => structuredClone(map.get(key)), put: async (key, value) => { map.set(key, structuredClone(value)) }, delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit)), getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(data)[method](...args)]))
  storage.transaction = operation => { const task = tail.then(async () => { const next = structuredClone(data), result = await operation(view(next)); data = next; return result }); tail = task.catch(() => {}); return task }
  const env = { PUBLIC_HOST: 'fixture.example', OWNER_EMAIL: EMAIL, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), AUMLOK_CUSTODY_PEPPER: '22'.repeat(32) }, events = []
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  head.broadcast = async value => { events.push(value) }
  // The real HEAD consumes his approval in begin_merge's own transaction. AUMLOK needs a passkey ceremony, so a
  // single-use synthetic approval store stands in for it here.
  const used = new Set()
  head.aumlokStore = { consumeApprovalInTransaction: async (tx, token, binding) => {
    if (typeof token !== 'string' || !token.startsWith('fixture-approval-') || used.has(token)) throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
    used.add(token); return { ok: true, binding, approvalId: null, expiresAt: Date.now() + 60000 }
  } }
  const code = 'export const organ = "fixture";\n', sha = digest(code)
  const draft = { version: 'x6.1-ball/v1', epoch: 167, parentBallId: null, createdAt: '2026-11-11T00:00:00.000Z', authorPeerId: 'fixture-peer',
    entries: { 'seed-echo': { id: 'seed-echo', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } }, modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(code) } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }, payload = { version: BOOTSTRAP_VERSION, ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } }, seedId = digest(canonicalBootstrap(payload))
  assert.equal((await head.store.bootstrapPrepare({ ...payload, seedId })).ok, true)
  assert.equal((await head.store.bootstrapCommit(seedId, { ok: true, phase: 'ready', seedId, ballId: ball.ballId, epoch: 167, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  const access = { ...owner, expires: Math.floor(Date.now() / 1000) + 3600 }, broker = fixture({ ci: PASSED_CI, access, bootstrap: { ...BOOTSTRAP, head: { ...BOOTSTRAP.head, seedId } }, env: { ...env, HEAD: { idFromName: name => name, get: () => head } } })
  const status = async () => await (await head.fetch(new Request('https://x61.internal/_head/promotion-status', { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, 'x-x6-verified-access': JSON.stringify(access) } }))).json()
  const staged = await broker.stage()
  assert.deepEqual((await status()).stagedRepoProposal, staged)
  const result = await broker.request(staged.mergeBody, { token: broker.grant(staged.mergeBody) })
  assert.equal(result.status, 200, JSON.stringify(result.value))
  const final = await status()
  assert.equal(final.stagedRepoProposal, null); assert.equal(final.lastRepoMergeOutcome.status, 'succeeded'); assert.equal(final.lastRepoMergeOutcome.commitSha, HEAD)
  assert.equal(used.size, 1)
  assert.equal(events.some(event => event.type === 'repo:staged'), true); assert.equal(events.some(event => event.type === 'repo:merged' && event.commitSha === HEAD), true)
})

test('cancellation during proposal verification prevents a late ignored provider response from dispatching', async () => {
  const reached = Promise.withResolvers(), resume = Promise.withResolvers(), abort = new AbortController()
  let block = false
  const broker = fixture({ ci: PASSED_CI, hook: async (url, init) => {
    if (block && url.pathname.includes('/contents/')) { reached.resolve(); await resume.promise }
  } })
  const proposal = await broker.stage(); block = true
  const pending = broker.request(proposal.mergeBody, { token: broker.grant(proposal.mergeBody), signal: abort.signal })
  await reached.promise; abort.abort()
  const result = await pending
  assert.equal(result.status, 408)
  resume.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(broker.calls.some(call => call.method === 'POST'), false); assert.equal(broker.refs.get('main'), BASE)
})

test('approval expiry during immutable inspection prevents dispatch and finite owner clocks fail closed', async () => {
  let current = NOW, expire = false
  const broker = fixture({ ci: PASSED_CI, now: () => current, hook: url => { if (expire && url.pathname.includes('/contents/')) current = NOW + 60001 } })
  const proposal = await broker.stage(); expire = true
  const result = await broker.request(proposal.mergeBody, { token: broker.grant(proposal.mergeBody) })
  assert.equal(result.value.code, 'CLASS3_APPROVAL_EXPIRED'); assert.equal(broker.calls.some(call => call.method === 'POST'), false)
  // HEAD refuses the expired approval in the step that would claim the attempt, so nothing is claimed or spent.
  assert.deepEqual(broker.outcomes, []); assert.equal(broker.consumed, 0)
  for (const now of [() => NaN, () => Infinity, () => 0]) {
    const invalid = fixture({ now })
    assert.equal((await invalid.request({ action: 'branch_create', branch: BRANCH })).value.code, 'OWNER_SESSION_REQUIRED')
    assert.equal(invalid.calls.length, 0)
  }
})

test('one total deadline bounds sequential proposal reads rather than restarting for each fetch', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const first = Promise.withResolvers(), second = Promise.withResolvers()
    let reads = 0
    const broker = fixture({ hook: async (url, init) => {
      reads++
      if (reads === 1) first.resolve()
      if (reads === 2) second.resolve()
      await new Promise(resolve => setTimeout(resolve, 6000))
    } })
    const pending = broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix' })
    await first.promise
    context.mock.timers.tick(6000)
    await second.promise
    context.mock.timers.tick(4001)
    assert.equal((await pending).status, 408)
    context.mock.timers.tick(6000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(broker.calls.length, 2); assert.equal(broker.proposals.length, 0)
  } finally { context.mock.timers.reset() }
})

test('cancellation after provider dispatch is unknown even if the ignored request later commits', async () => {
  const reached = Promise.withResolvers(), resume = Promise.withResolvers(), abort = new AbortController()
  const broker = fixture({ ci: PASSED_CI, hook: async (url, init, { refs }) => {
    if (url.pathname !== '/graphql') return
    reached.resolve(); await resume.promise; refs.set('main', HEAD)
    return json({ data: null, errors: [{ type: 'INTERNAL' }] })
  } })
  const proposal = await broker.stage()
  const pending = broker.request(proposal.mergeBody, { token: broker.grant(proposal.mergeBody), signal: abort.signal })
  await reached.promise; abort.abort()
  const result = await pending
  assert.equal(result.value.code, 'REPO_REF_OUTCOME_UNKNOWN')
  resume.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(broker.refs.get('main'), HEAD); assert.equal(broker.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(broker.outcomes.some(outcome => outcome.status === 'failed'), false)
})

test('core-sized source over 400 KiB reads, edits, stages and commits exact bytes on a private branch', async () => {
  // A core-sized file her branches may carry (ball-loader.ts itself is frozen: repo-frozen-paths.test.mjs).
  const path = 'deploy/cloudflare/src/auma/ball-manifest.mjs'
  const content = 'export const marker = "old";\n' + '// source 😀 "quoted" \\value\n'.repeat(16000)
  assert.ok(Buffer.byteLength(content) > 400 * 1024); assert.ok(Buffer.byteLength(content) < CLOUD_REPO_READ_LIMITS.fileBytes)
  const broker = fixture({ before: {}, after: { [path]: content } })
  const read = await broker.request({ action: 'read', branch: BRANCH, path })
  assert.equal(read.status, 200); assert.equal(read.value.content, content)
  const edited = await broker.request({ action: 'edit', branch: BRANCH, path, oldString: 'marker = "old"', newString: 'marker = "new"', expectedHeadSha: HEAD })
  const expected = content.replace('marker = "old"', 'marker = "new"')
  assert.equal(edited.status, 200); assert.equal(edited.value.content, expected); assert.equal(edited.value.baseSha, HEAD)
  const result = await broker.request({ action: 'commit', branch: BRANCH, expectedHeadSha: HEAD, message: 'Fix core source', changes: [{ path, content: edited.value.content }] })
  assert.equal(result.status, 200)
  const input = JSON.parse(broker.calls.find(call => call.method === 'POST').body).variables.input
  assert.equal(Buffer.from(input.fileChanges.additions[0].contents, 'base64').toString('utf8'), expected)
  assert.equal(input.expectedHeadOid, HEAD); assert.equal(broker.refs.get('main'), BASE)
})

test('private file and commit byte caps stay finite across assembled edits and escaped envelopes', async () => {
  const path = 'deploy/cloudflare/src/auma/large.mjs', content = '\u0001'.repeat(CLOUD_REPO_BRANCH_LIMITS.fileBytes)
  const broker = fixture({ after: { [path]: content } })
  const staged = await broker.request({ action: 'write', branch: BRANCH, path, content })
  assert.equal(staged.status, 200); assert.equal(staged.value.content, content)
  const commit = await broker.request({ action: 'commit', branch: BRANCH, message: 'Two bounded files', changes: [{ path, content }, { path: 'deploy/cloudflare/src/auma/second.mjs', content }] })
  assert.equal(commit.status, 200)
  const over = await broker.request({ action: 'write', branch: BRANCH, path, content: content + 'x' })
  assert.equal(over.value.code, 'BROKER_CONTENT_INVALID')
  const aggregate = await broker.request({ action: 'commit', branch: BRANCH, message: 'Too many bytes', changes: [{ path, content }, { path: 'deploy/cloudflare/src/auma/second.mjs', content }, { path: 'deploy/cloudflare/src/auma/third.mjs', content: 'x' }] })
  assert.equal(aggregate.value.code, 'REPO_CHANGE_INVALID')
  const assembled = fixture({ after: { [path]: 'x'.repeat(CLOUD_REPO_BRANCH_LIMITS.fileBytes - 6) + 'TARGET' } })
  assert.equal((await assembled.request({ action: 'edit', branch: BRANCH, path, oldString: 'TARGET', newString: 'TOO-LONG' })).value.code, 'BROKER_CONTENT_INVALID')
  const legacy = fixture()
  assert.equal((await legacy.request({ action: 'write', path: 'README.md', content })).value.code, 'BROKER_BODY_TOO_LARGE')
})

test('larger source reads never widen the compare_files 256 KiB wire limit or secret checks', async () => {
  const path = 'deploy/cloudflare/src/auma/large.mjs', content = 'x'.repeat(300 * 1024)
  const broker = fixture({ after: { [path]: content } })
  assert.equal((await broker.request({ action: 'read', branch: BRANCH, path })).status, 200)
  assert.equal((await broker.request({ action: 'compare_files', ref: HEAD, leftPath: path, rightPath: path })).status, 413)
  assert.equal((await broker.request({ action: 'write', branch: BRANCH, path, content: content + '\nsynthetic-token-value' })).value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
})

test('mixed binary and UTF-8 source search skips only non-text and reports bounded paths', async () => {
  const after = { 'apps/fixture/a.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]), 'apps/fixture/b.wasm': Buffer.from([0, 0x61, 0x73, 0x6d]), 'apps/fixture/source.mjs': 'needle in source\n' }
  const broker = fixture({ after })
  const result = await broker.request({ action: 'search', branch: BRANCH, query: 'needle' })
  assert.equal(result.status, 200); assert.deepEqual(result.value.matches, [{ path: 'apps/fixture/source.mjs', line: 1, text: 'needle in source' }])
  assert.equal(result.value.filesScanned, 3); assert.equal(result.value.skippedFiles, 2); assert.equal(result.value.skippedPathsTruncated, false)
  assert.deepEqual(result.value.skippedPaths, [{ path: 'apps/fixture/a.png', reason: 'non_utf8' }, { path: 'apps/fixture/b.wasm', reason: 'binary' }])
  const many = fixture({ after: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`apps/fixture/${index}.bin`, Buffer.from([0])])) })
  const skipped = await many.request({ action: 'search', branch: BRANCH, query: 'needle' })
  assert.equal(skipped.value.skippedFiles, 40); assert.equal(skipped.value.skippedPaths.length, 32); assert.equal(skipped.value.skippedPathsTruncated, true)
  const secret = fixture({ after: { ...after, 'apps/fixture/z.mjs': 'synthetic-token-value\nneedle' } })
  assert.equal((await secret.request({ action: 'search', branch: BRANCH, query: 'needle' })).value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
})
