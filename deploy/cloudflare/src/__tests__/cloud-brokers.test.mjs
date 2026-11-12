/** Synthetic fixed-target broker fixtures. No real network, credentials or durable state. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { handleCloudBroker, cloudRepoMirrorPathAllowed, isT2ProtectedRepoPath, CLOUD_REPO_TREE_LIMITS, OWNER_MACHINE_PATH_NEXT } from '../cloud-brokers.mjs'

const ORIGIN = 'https://fixture.example', REPO = 'your_org_x/your-node', PREFIX = '/repos/' + REPO
const SHA = 'a'.repeat(40), TREE = 'b'.repeat(40), BLOB = 'c'.repeat(40), NEW = 'd'.repeat(40)
const NOW = 100000, digest = value => createHash('sha256').update(value).digest('hex')
const bootstrap = { ready: true, head: { phase: 'complete', seedId: 'synthetic-seed' }, mirror: { phase: 'ready' } }
const defaultEnv = () => ({ GITHUB_TOKEN: 'synthetic-broker-token-fixture', SOURCE_REVISION: SHA })
const file = (path, mode = '100644') => ({ path, mode, type: mode === '160000' ? 'commit' : 'blob', sha: BLOB, size: 10 })
function treeFor(paths, overrides = {}) {
  const entries = new Map()
  for (const path of paths) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/')
      entries.set(parent, { path: parent, mode: '040000', type: 'tree', sha: TREE })
    }
    entries.set(path, file(path))
  }
  return { sha: TREE, truncated: false, tree: [...entries.values()], ...overrides }
}
function harness({ env = defaultEnv(), fetch, approvals = false, ...options } = {}) {
  const calls = [], tokens = new Map()
  let request, consumed = 0
  const authorizeClass3 = async input => {
    const token = request.headers.get('x-x6-class3-approval'), approval = tokens.get(token)
    if (!approval || approval.binding.bodySha256 !== digest(canonicalJson(input))) return { ok: false }
    tokens.delete(token); consumed++
    return structuredClone(approval)
  }
  return { calls, env, tokens, get consumed() { return consumed },
    grant(input, route = '/_host/github', changes = {}) {
      const token = 'fixture-approval-' + tokens.size + '-' + consumed
      tokens.set(token, { ok: true, expiresAt: NOW + 60000, binding: { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: route, bodySha256: digest(canonicalJson(input)), ...changes } })
      return token
    },
    async request(route, input, { token, signal, headers = {}, method = input === undefined ? 'GET' : 'POST' } = {}) {
      const requestHeaders = new Headers({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(token ? { 'x-x6-class3-approval': token } : {}) })
      for (const [key, value] of Object.entries(headers)) value === null ? requestHeaders.delete(key) : requestHeaders.set(key, value)
      request = new Request(ORIGIN + route, { method, headers: requestHeaders, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal })
      const response = await handleCloudBroker(request, env, { bootstrap, now: () => NOW, ...options,
        ...(approvals ? { authorizeClass3 } : {}), networkFetch: async (url, init) => {
          calls.push({ url, ...init })
          assert.equal(new URL(url).hostname, 'api.github.com')
          assert.equal(init.redirect, 'error')
          if (!fetch) throw new Error('Unexpected synthetic fetch')
          return await fetch(url, init)
        } })
      return { status: response.status, value: await response.json() }
    },
  }
}
function sourceFetch(paths, content = 'synthetic source', changes = {}) {
  return (url, init) => {
    assert.equal(init.method, 'GET')
    const target = new URL(url)
    if (target.pathname === PREFIX + '/commits/main' || target.pathname === PREFIX + '/commits/' + SHA) return Response.json({ sha: SHA, commit: { message: 'Base', tree: { sha: TREE } } })
    if (target.pathname === PREFIX + '/git/trees/' + TREE || target.pathname === PREFIX + '/git/trees/main') return Response.json(treeFor(paths, changes))
    if (target.pathname.startsWith(PREFIX + '/contents/')) {
      assert.equal(target.search, '?ref=' + SHA)
      return Response.json({ type: 'file', path: target.pathname.slice((PREFIX + '/contents/').length), sha: BLOB, encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    throw new Error('Unexpected synthetic source URL')
  }
}

test('canonical Markdown docs bypass only T2 filename locks', () => {
  for (const path of [
    'docs/aumlok.md', 'docs/passkey-guide.md', 'docs/owner-grant-policy.md',
    'docs/security.v1/custody/keys.md', 'docs/safety/owner-grant-policy.md',
  ]) assert.equal(isT2ProtectedRepoPath(path), false, path)
  for (const path of [
    'server/aumlok.mjs', 'server/passkey.mjs', 'server/custody.mjs', 'server/owner-grant-policy.mjs',
    'server/keys.mjs', 'server/aura-rules.mjs', 'package.json',
    'deploy/cloudflare/src/worker.mjs', 'deploy/docs/aumlok.md', '.github/workflows/deploy.yml',
    'packages/experimental/webworker-runtime/src/x6/ball-loader.ts',
    'packages/experimental/webworker-runtime/src/x6/wasm-cells.ts',
    'packages/experimental/webworker-runtime/src/x6/cells/example.md', 'apps/web/public/cells/example.md',
    'docs/aumlok.mjs', 'docs/aumlok.MD', 'docs/aumlok.md.js', 'docs/aumlok.md/',
  ]) assert.equal(isT2ProtectedRepoPath(path), true, path)
})

test('malformed documentation paths cannot gain the Markdown filename exemption', () => {
  for (const path of [
    undefined, null, 42, '', '/docs/aumlok.md', '//docs/aumlok.md',
    'docs/./aumlok.md', 'docs/../aumlok.md', 'docs/nested/../../server/aumlok.md',
    'docs/aumlok/../guide.md', 'docs//aumlok.md', 'docs\\aumlok.md',
    'docs/aumlok%2emd', 'docs/%2e%2e/aumlok.md', 'docs/aumlok.md\u0000',
    'docs/aumlok.md?raw=1', 'docs/aumlok.md#section', 'docs/aumlok.md\n',
  ]) assert.equal(isT2ProtectedRepoPath(path), true, String(path))
})

test('owner doc writes and commits retain private-content screening after the T2 exemption', async () => {
  const broker = harness({ access: { authenticated: true, owner: true } })
  const path = 'docs/security/aumlok-passkey-guide.md'
  for (const input of [
    { action: 'write', path, content: '# Owner approval guide\n', dryRun: true },
    { action: 'commit', changes: [{ path, content: '# Owner approval guide\n' }], message: 'Update approval guide', dryRun: true },
  ]) {
    const result = await broker.request('/_host/repo', input)
    assert.equal(result.status, 200)
    assert.equal(result.value.tier, 'T1')
  }
  for (const content of ['{"privateKey":"synthetic"}', '-----BEGIN PRIVATE KEY-----', 'synthetic-broker-token-fixture']) {
    for (const input of [
      { action: 'write', path, content, dryRun: true },
      { action: 'write', path, content, message: 'Update approval guide', dryRun: true },
      { action: 'edit', path, oldString: 'guide', newString: content, dryRun: true },
      { action: 'commit', changes: [{ path, content }], message: 'Update approval guide', dryRun: true },
    ]) {
      const result = await broker.request('/_host/repo', input)
      assert.equal(result.status, 403)
      assert.equal(result.value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
      assert.equal(JSON.stringify(result).includes(content), false)
    }
  }
  // T2 on main is never this sink's route, passkey or not: the refusal names the route that works.
  for (const path of ['deploy/cloudflare/src/worker.mjs', '.github/workflows/deploy.yml', 'server/aumlok.mjs']) {
    const result = await broker.request('/_host/repo', { action: 'write', path, content: 'safe text', dryRun: true })
    assert.equal(result.status, 403)
    assert.equal(result.value.code, 'REPO_PROPOSAL_REQUIRED')
    assert.equal(result.value.tier, 'T2')
    assert.match(result.value.next, path.startsWith('.github/') ? /^workflow files are not changed through her tools/ : /^proposal: branch_create auma\/proposal\/<name>/)
  }
  // T2 files her proposal branches cannot carry: the refusal names the real route, never the proposal.
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsdown.config.ts']) {
    for (const input of [{ action: 'write', path, content: 'safe text', dryRun: true }, { action: 'commit', changes: [{ path, content: 'safe text' }], message: 'Change', dryRun: true }]) {
      const result = await broker.request('/_host/repo', input)
      assert.equal(result.status, 403, path)
      assert.equal(result.value.code, 'REPO_PROPOSAL_REQUIRED', path)
      assert.equal(result.value.tier, 'T2')
      assert.equal(result.value.protectedPath, path)
      assert.equal(result.value.next, OWNER_MACHINE_PATH_NEXT, path)
      assert.doesNotMatch(result.value.next, /branch_create|stage_proposal/)
    }
  }
  // T2 files a proposal can carry keep the proposal route.
  for (const path of ['package.json', 'tsconfig.client.json', 'server/build-preview.mjs']) {
    const result = await broker.request('/_host/repo', { action: 'write', path, content: 'safe text', dryRun: true })
    assert.match(result.value.next, /^proposal: branch_create auma\/proposal\/<name>/, path)
  }
  assert.equal(broker.calls.length, 0)
})

test('an owner session with no passkey commits to main only deploy-inert paths; deployed paths need the proposal card', async () => {
  const broker = harness({ access: { authenticated: true, owner: true }, approvals: true })
  for (const path of ['docs/plan/notes.md', 'README.md', 'NORTH-STAR.md']) {
    for (const input of [
      { action: 'commit', changes: [{ path, content: '# Notes\n' }], message: 'Update notes', dryRun: true },
      { action: 'write', path, content: '# Notes\n', message: 'Update notes', dryRun: true },
      { action: 'write', path, content: '# Notes\n', dryRun: true },
    ]) {
      const result = await broker.request('/_host/repo', input)
      assert.equal(result.status, 200, path)
      assert.equal(result.value.tier, 'T1')
    }
  }
  // Every path that reaches a deployed artifact: the UI, the worker runtime, server and build sources, baked mirror files.
  // The refusal is not a passkey request (CLASS3_WEBAUTHN_REQUIRED would make her tool stage a Touch ID card for the
  // same body, which this branch refuses again): it names the proposal route, and staging is refused too, so nothing
  // uncommittable is ever held for a later bare commit.
  for (const path of ['packages/client/ui-layout/src/client/spatial/AppFrame.tsx', 'apps/web/src/main.tsx',
    'packages/experimental/webworker-runtime/src/x6/scion.ts', 'server/local-host.mjs', 'scripts/fixture.mjs',
    'mirror/home/auma/HANDOFF.md', 'mirror/home/auma/seed/organs/seed-echo.js', 'apps/web/README.md']) {
    for (const input of [
      { action: 'commit', changes: [{ path, content: 'export const x = 1\n' }], message: 'Change', dryRun: true },
      { action: 'commit', changes: [{ path: 'docs/notes.md', content: '# n\n' }, { path, content: 'export const x = 1\n' }], message: 'Mixed change' },
      { action: 'write', path, content: 'export const x = 1\n', message: 'Change' },
      { action: 'write', path, content: 'export const x = 1\n' },
      { action: 'write', path, content: 'export const x = 1\n', dryRun: true },
      { action: 'edit', path, oldString: 'x = 1', newString: 'x = 2' },
      { action: 'edit', path, oldString: 'x = 1', newString: 'x = 2', message: 'Change' },
    ]) {
      for (const approved of [false, true]) {
        // A passkey approval over these exact bytes changes nothing: this sink is never the route for a deployed path.
        const result = await broker.request('/_host/repo', input, approved ? { token: broker.grant(input, '/_host/repo') } : {})
        assert.equal(result.status, 403, `${path} ${input.action}`)
        assert.equal(result.value.code, 'REPO_PROPOSAL_REQUIRED', `${path} ${JSON.stringify(input)}`)
        assert.equal(result.value.tier, undefined)
        assert.equal(result.value.protectedPath, path)
        assert.match(result.value.next, /^proposal: branch_create auma\/proposal\/<name>, commit there, stage_proposal/)
      }
    }
  }
  assert.equal(broker.consumed, 0)
  // Nothing was staged above, so a later bare commit of a staged doc is not blocked by a refused deployed path.
  const staged = await broker.request('/_host/repo', { action: 'write', path: 'docs/notes.md', content: '# n\n' })
  assert.equal(staged.status, 200)
  assert.equal(staged.value.staged, true)
  const fromStage = await broker.request('/_host/repo', { action: 'commit', message: 'Commit the staged doc', dryRun: true })
  assert.equal(fromStage.status, 200, JSON.stringify(fromStage.value))
  assert.deepEqual(fromStage.value.paths, ['docs/notes.md'])
  // T2 paths: the same workable refusal, never a passkey request this sink would refuse again, approved or not.
  for (const approved of [false, true]) {
    const input = { action: 'write', path: 'deploy/cloudflare/src/worker.mjs', content: 'x\n' }
    const t2 = await broker.request('/_host/repo', input, approved ? { token: broker.grant(input, '/_host/repo') } : {})
    assert.equal(t2.value.code, 'REPO_PROPOSAL_REQUIRED')
    assert.equal(t2.value.tier, 'T2')
    assert.match(t2.value.next, /^proposal: branch_create auma\/proposal\/<name>/)
  }
  assert.equal(broker.consumed, 0)
  assert.equal(broker.calls.length, 0)
})

test('new source reads use pinned GitHub trees without extending the private VFS reader', async () => {
  const paths = ['README.md', 'package.json', 'AGENTS.md', 'server/local-host.mjs', 'deploy/cloudflare/src/worker.mjs', 'packages/core/fixture.ts', 'apps/web/fixture.ts', 'scripts/fixture.mjs', 'bench/fixture.mjs', 'mirror/fixtures/example.js']
  let mirrorCalls = 0
  const broker = harness({ fetch: sourceFetch(paths), env: { ...defaultEnv(), MIRROR: { idFromName: value => value, get: () => ({ fetch: () => { mirrorCalls++; throw new Error('Not a VFS read') } }) } } })
  for (const path of paths) {
    const result = await broker.request('/_host/repo', { action: 'read', path })
    assert.equal(result.status, 200, path)
    assert.equal(result.value.commitSha, SHA)
    assert.equal(result.value.source, 'github-main')
  }
  assert.equal(mirrorCalls, 0)
  for (const path of ['/dsh/workspace/server/local-host.mjs', '/dsh/workspace/README.md', '/dsh/workspace/package.json', '/dsh/home/other/file.md']) assert.equal(cloudRepoMirrorPathAllowed(path), false)
  assert.equal(cloudRepoMirrorPathAllowed('/dsh/workspace/docs/fixture.md'), true)
  assert.equal(cloudRepoMirrorPathAllowed('/dsh/home/auma/memory/note.md'), true)
})

test('private live memory never gains a GitHub fallback and dangerous names refuse before network', async () => {
  const env = { ...defaultEnv(), MIRROR: { idFromName: value => value, get: () => ({ fetch: async request => Response.json({ ok: true, path: (await request.json()).path, kind: 'missing', lineageId: 'fixture-lineage', revision: 1 }) }) } }
  const broker = harness({ env })
  assert.equal((await broker.request('/_host/repo', { action: 'read', path: 'mirror/home/auma/memory/note.md' })).value.code, 'REPO_PRIVATE_FALLBACK_REFUSED')
  for (const path of ['docs/../README.md', 'server/.env', 'server/owner-key.mjs', 'deploy/private/file', 'packages/identity/index.ts', 'docs/file%2f.md', 'mirror/home/auma/seed/credentials.json']) {
    assert.equal((await broker.request('/_host/repo', { action: 'read', path })).value.code, 'REPO_PATH_REFUSED')
  }
  assert.equal(broker.calls.length, 0)
})

test('contents reads reject symlinks, gitlinks and symlink ancestors before fetching contents', async () => {
  for (const mode of ['120000', '160000']) {
    const broker = harness({ fetch: sourceFetch(['README.md'], 'not read', { tree: [file('README.md', mode)] }) })
    assert.equal((await broker.request('/_host/repo', { action: 'read', path: 'README.md' })).value.code, 'REPO_NONREGULAR_PATH_REFUSED')
    assert.equal(broker.calls.some(call => call.url.includes('/contents/')), false)
  }
  const broker = harness({ fetch: sourceFetch(['server/file.mjs'], '', { tree: [file('server', '120000'), file('server/file.mjs')] }) })
  assert.equal((await broker.request('/_host/repo', { action: 'read', path: 'server/file.mjs' })).value.code, 'REPO_NONREGULAR_PATH_REFUSED')
})

test('tree listings filter private paths and disclose both upstream and local truncation', async () => {
  const paths = ['README.md', 'server/file.mjs', 'server/owner-key.mjs', 'mirror/home/auma/memory/note.md', 'docs/private/file.md']
  const broker = harness({ fetch: sourceFetch(paths, '', { truncated: true }) })
  const result = await broker.request('/_host/repo', { action: 'tree' })
  assert.equal(result.status, 200)
  assert.equal(result.value.upstreamTruncated, true)
  assert.equal(result.value.truncated, true)
  assert.equal(result.value.entries.some(entry => /owner-key|memory|private/.test(entry.path)), false)
  const filtered = await broker.request('/_host/repo', { action: 'tree', prefix: 'server' })
  assert.deepEqual(filtered.value.entries.map(entry => entry.path), ['server', 'server/file.mjs'])
  const many = harness({ fetch: sourceFetch(Array.from({ length: 1002 }, (_, index) => `server/file-${index}.mjs`)) })
  const limited = (await many.request('/_host/repo', { action: 'tree' })).value
  assert.ok(limited.entries.length > 0 && limited.entries.length <= CLOUD_REPO_TREE_LIMITS.returnedEntries)
  assert.equal(limited.upstreamTruncated, false)
  assert.equal(limited.truncated, true)
})

test('malformed trees fail and truncated trees never invent an absent file', async () => {
  for (const changes of [{ truncated: 'false' }, { tree: [file('README.md'), file('README.md')] }, { tree: [file('../README.md')] }, { sha: NEW }]) {
    const broker = harness({ fetch: sourceFetch(['README.md'], '', changes) })
    assert.equal((await broker.request('/_host/repo', { action: 'read', path: 'README.md' })).value.code, 'REPO_TREE_INVALID')
  }
  const broker = harness({ fetch: sourceFetch([], '', { truncated: true }) })
  assert.equal((await broker.request('/_host/repo', { action: 'read', path: 'README.md' })).value.code, 'REPO_TREE_INCOMPLETE')
})

test('selftest projects validated metadata and counts without raw HEAD or AUMLOK state', async () => {
  const calls = []
  const env = { ...defaultEnv(), BUILD_INFO: { id: 'fixture-build', extra: 'discard-build' }, OPENAI_API_KEY: 'synthetic-openai-fixture',
    HEAD: { idFromName: value => value, get: () => ({ fetch: request => {
      const url = new URL(request.url); calls.push(url.pathname)
      assert.equal(url.origin, ORIGIN)
      return Response.json(url.pathname === '/_head/status' ? { ok: true, ballId: 'fixture-ball', epoch: 1, governancePromotion: true, modules: 'discard-modules' }
        : { ok: true, phase: 'BOUND', bound: true, enrollmentAvailable: false, enrollmentCount: 12, nodePubkeyHex: 'discard-id', approvedGrants: ['discard-grant'] })
    } }) },
    MIRROR: { idFromName: value => value, get: () => ({ fetch: request => {
      assert.equal(new URL(request.url).search, '?compact=1')
      return Response.json({ ok: true, lineageId: 'fixture-lineage', revision: 8, homeFiles: ['discard-memory'] })
    } }) },
  }
  const broker = harness({ env, trustedDocsHttpsFetch: () => { throw new Error('No web fetch from selftest') } })
  for (const [route, input] of [['/_host/selftest', undefined], ['/_host/repo', { action: 'selftest' }]]) {
    const { status, value } = await broker.request(route, input)
    assert.equal(status, 200)
    assert.equal(value.buildSha, SHA)
    assert.equal(value.head.governancePromotion, true)
    assert.equal(value.aumlok.credentialCount, 1)
    assert.equal(value.providerDoors.openai, true)
    assert.equal(value.providerDoors.anthropic, false)
    assert.equal(value.brokers.webEyesConfigured, false)
    assert.equal(value.brokers.trustedDocsConfigured, true)
    assert.equal(JSON.stringify(value).includes('discard-'), false)
    assert.equal(JSON.stringify(value).includes(env.GITHUB_TOKEN), false)
  }
  assert.equal(calls.length, 4)
  assert.equal(broker.calls.length, 0)
})

test('selftest fails explicitly for unavailable/invalid state, unpaired bootstrap and cancellation', async () => {
  const unavailable = await harness().request('/_host/selftest')
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.value.ok, false)
  assert.equal(unavailable.value.head.state, 'unavailable')
  const invalid = harness({ env: { ...defaultEnv(), HEAD: { idFromName: value => value, get: () => ({ fetch: () => Response.json({ ok: true, phase: 'BOUND', bound: false, enrollmentAvailable: false }) }) } } })
  assert.equal((await invalid.request('/_host/selftest')).value.aumlok.state, 'invalid')
  assert.equal((await harness({ bootstrap: { ready: false } }).request('/_host/selftest')).value.code, 'BOOTSTRAP_REQUIRED')
  const controller = new AbortController(); controller.abort()
  assert.equal((await invalid.request('/_host/selftest', undefined, { signal: controller.signal })).value.code, 'BROKER_TIMEOUT')
  assert.equal((await invalid.request('/_host/selftest', { action: 'selftest' })).status, 405)
  assert.equal((await invalid.request('/_host/other')).value.code, 'BROKER_ROUTE_UNAVAILABLE')
})

const issue = (number, body = 'A bounded body', extra = {}) => ({ id: 100 + number, number, state: 'open', title: 'A bounded title', body, html_url: `https://github.com/${REPO}/issues/${number}`, ...extra })
const issueInput = () => ({ action: 'api', method: 'POST', endpoint: PREFIX + '/issues', body: { title: 'A bounded title', body: 'A bounded body' } })

test('GitHub issue posts require exact single-use route, audience and immutable request consent', async () => {
  let writes = 0
  const broker = harness({ approvals: true, fetch: async (_url, init) => { assert.equal(init.method, 'POST'); writes++; return Response.json(issue(1)) } })
  const input = issueInput()
  assert.equal((await broker.request('/_host/github', input)).value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  for (const changed of [{ audience: 'https://other.example' }, { method: 'PUT' }, { pathname: '/_host/repo' }]) {
    assert.equal((await broker.request('/_host/github', input, { token: broker.grant(input, '/_host/github', changed) })).value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  }
  const token = broker.grant(input)
  const changedBody = { ...input, body: { ...input.body, body: 'changed' } }
  assert.equal((await broker.request('/_host/github', changedBody, { token })).value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  const result = await broker.request('/_host/github', input, { token })
  assert.equal(result.status, 200)
  assert.equal(result.value.replaySafe, false)
  assert.equal((await broker.request('/_host/github', input, { token })).value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(writes, 1)
})

test('issue comments refuse PR targets and dangerous routes before consuming approval', async () => {
  const input = { action: 'api', method: 'POST', endpoint: PREFIX + '/issues/2/comments', body: { body: 'A comment' } }
  const broker = harness({ approvals: true, fetch: () => Response.json(issue(2, '', { pull_request: {}, html_url: `https://github.com/${REPO}/pull/2` })) })
  assert.equal((await broker.request('/_host/github', input, { token: broker.grant(input) })).value.code, 'GITHUB_ISSUE_TARGET_REQUIRED')
  assert.equal(broker.consumed, 0)
  const calls = broker.calls.length
  for (const endpoint of [PREFIX + '/pulls', PREFIX + '/issues/2/lock', PREFIX + '/actions/runs/3/rerun', '/repos/other/repo/issues']) {
    const value = { ...issueInput(), endpoint }
    assert.equal((await broker.request('/_host/github', value, { token: broker.grant(value) })).status, 403)
  }
  assert.equal(broker.calls.length, calls)
  assert.equal(broker.consumed, 0)
})

test('every post-dispatch failure remains unknown and never resends the issue', async () => {
  for (const response of [() => { throw new Error('Lost after post') }, () => new Response('{', { headers: { 'content-type': 'application/json' } }), () => Response.json(issue(1, 'synthetic-broker-token-fixture')), () => Response.json(issue(1, 'changed')), () => Response.json({ id: 1 })]) {
    const broker = harness({ approvals: true, fetch: response }), input = issueInput(), token = broker.grant(input)
    const first = await broker.request('/_host/github', input, { token })
    assert.equal(first.value.code, 'GITHUB_MUTATION_OUTCOME_UNKNOWN')
    assert.equal(first.value.retry, 'inspect-github-before-new-approval')
    assert.equal(first.value.outcome, 'unknown')
    assert.equal((await broker.request('/_host/github', input, { token })).value.code, 'CLASS3_WEBAUTHN_REQUIRED')
    assert.equal(broker.calls.length, 1)
  }
})

test('safeText remains conservative for security source and outbound web URLs', async () => {
  const broker = harness({ fetch: sourceFetch(['server/file.mjs'], 'const x = { "privateKey": "synthetic" }') })
  assert.equal((await broker.request('/_host/repo', { action: 'read', path: 'server/file.mjs' })).value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  let fetches = 0
  const web = harness({ trustedDocsHttpsFetch: async () => { fetches++; return new Response('safe', { headers: { 'content-type': 'text/plain' } }) } })
  for (const url of ['https://developer.mozilla.org/synthetic-broker-token-fixture', 'https://developer.mozilla.org/synthetic%2dbroker-token-fixture', 'https://developer.mozilla.org/?token=other']) {
    assert.equal((await web.request('/_host/web-eyes', { action: 'fetch', url })).status, 403)
  }
  assert.equal(fetches, 0)
  const result = await web.request('/_host/web-eyes', { action: 'fetch', url: 'https://developer.mozilla.org/docs' })
  assert.equal(result.value.capability, 'trusted-docs-fetch')
  assert.equal(fetches, 1)
  const metadataEcho = harness({ trustedDocsHttpsFetch: async () => new Response('safe', { headers: { 'content-type': 'text/plain; fixture=synthetic-broker-token-fixture' } }) })
  const refused = await metadataEcho.request('/_host/web-eyes', { action: 'fetch', url: 'https://developer.mozilla.org/docs' })
  assert.equal(refused.value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  assert.equal(JSON.stringify(refused).includes('synthetic-broker-token-fixture'), false)
})

test('large repository trees remain bounded with honest projection truncation', async () => {
  const paths = Array.from({ length: 22000 }, (_, index) => `packages/group-${Math.floor(index / 100)}/file-${index}.ts`)
  const broker = harness({ fetch: sourceFetch(paths) })
  const response = await broker.request('/_host/github', { action: 'api', endpoint: PREFIX + '/git/trees/main?recursive=1' })
  assert.equal(response.status, 200)
  assert.equal(response.value.json.upstreamTruncated, false)
  assert.equal(response.value.json.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(response.value)) < 256 * 1024)
  assert.equal(broker.calls.length, 1)
})

test('diff excludes private rename origins and refuses nonregular changed paths', async () => {
  let compareCalls = 0
  const broker = harness({ fetch: (url, init) => {
    if (url.includes('/compare/')) {
      compareCalls++
      assert.equal(url, `https://api.github.com${PREFIX}/compare/${SHA}...${SHA}`)
      return Response.json({ base_commit: { sha: SHA }, merge_base_commit: { sha: SHA }, status: 'identical', ahead_by: 0, behind_by: 0, files: [
        { filename: 'README.md', previous_filename: 'mirror/home/auma/memory/note.md', status: 'renamed', patch: 'private-memory-never-returned' },
        { filename: 'server/file.mjs', status: 'modified', patch: '+safe' },
      ] })
    }
    return sourceFetch(['README.md', 'server/file.mjs'])(url, init)
  } })
  const result = await broker.request('/_host/repo', { action: 'diff', base: SHA })
  assert.equal(result.status, 200)
  assert.deepEqual(result.value.files, [{ path: 'server/file.mjs', status: 'modified', patch: '+safe' }])
  assert.equal(JSON.stringify(result.value).includes('private-memory'), false)
  assert.equal(compareCalls, 1)
  const link = harness({ fetch: (url, init) => url.includes('/compare/') ? Response.json({ base_commit: { sha: SHA }, merge_base_commit: { sha: SHA }, status: 'identical', ahead_by: 0, behind_by: 0, files: [{ filename: 'README.md', status: 'modified', patch: '+private-location' }] })
    : sourceFetch(['README.md'], '', { tree: [file('README.md', '120000')] })(url, init) })
  assert.equal((await link.request('/_host/repo', { action: 'diff', base: SHA })).value.code, 'REPO_NONREGULAR_PATH_REFUSED')
})

test('source publication retains atomic HEAD binding and verifies replay content without another mutation', async () => {
  let published = null, writes = 0
  const input = { action: 'write', path: 'README.md', content: 'synthetic source', message: 'A bounded change', expectedHeadSha: SHA, idempotencyKey: 'fixture-publication-123' }
  const broker = harness({ approvals: true, approveRepoPublication: terms => {
    assert.equal(Object.isFrozen(terms.files[0]), true)
    assert.equal(Object.isFrozen(terms.binding.files), true)
    return { approved: true, canonical: terms.canonical }
  }, fetch: (url, init) => {
    if (init.method === 'POST') {
      writes++
      const action = JSON.parse(init.body).variables.input
      assert.equal(action.expectedHeadOid, SHA)
      assert.deepEqual(action.fileChanges.additions, [{ path: 'README.md', contents: Buffer.from(input.content).toString('base64') }])
      published = { sha: NEW, commit: { message: action.message.headline + '\n\n' + action.message.body, tree: { sha: TREE } }, parents: [{ sha: SHA }], files: [{ filename: 'README.md', status: 'modified' }] }
      throw new Error('Lost response after synthetic write')
    }
    if (url.includes('/commits?')) return Response.json(published ? [published] : [{ sha: SHA, commit: { message: 'Base' } }])
    if (url.endsWith('/commits/' + NEW)) return Response.json(published)
    if (url.includes('/contents/')) return Response.json({ type: 'file', path: 'README.md', encoding: 'base64', sha: BLOB, content: Buffer.from(input.content).toString('base64') })
    return sourceFetch(['README.md'])(url, init)
  } })
  const firstToken = broker.grant(input, '/_host/repo')
  const first = await broker.request('/_host/repo', input, { token: firstToken })
  assert.equal(first.value.code, 'REPO_PUBLICATION_OUTCOME_UNKNOWN')
  assert.equal(first.value.retry, 'repeat-the-identical-request-to-reconcile')
  const beforeReplay = broker.calls.length
  assert.equal((await broker.request('/_host/repo', input, { token: firstToken })).value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(broker.calls.length, beforeReplay)
  const replay = await broker.request('/_host/repo', input, { token: broker.grant(input, '/_host/repo') })
  assert.equal(replay.status, 200)
  assert.equal(replay.value.replayed, true)
  assert.equal(writes, 1)
  const changed = { ...input, content: 'different content' }
  assert.equal((await broker.request('/_host/repo', changed, { token: broker.grant(changed, '/_host/repo') })).value.code, 'REPO_REPLAY_CONFLICT')
  const stale = { ...input, idempotencyKey: 'another-publication-123' }
  assert.equal((await broker.request('/_host/repo', stale, { token: broker.grant(stale, '/_host/repo') })).value.code, 'REPO_HEAD_CONFLICT')
  assert.equal(writes, 1)
})

test('source publication rejects private mirrors and nonregular files without a mutation', async () => {
  const input = { action: 'write', path: 'README.md', content: 'synthetic source', message: 'A bounded change', expectedHeadSha: SHA, idempotencyKey: 'fixture-publication-123' }
  const broker = harness({ approvals: true, fetch: (url, init) => url.includes('/commits?') ? Response.json([{ sha: SHA, commit: { message: 'Base' } }]) : sourceFetch(['README.md'], '', { tree: [file('README.md', '120000')] })(url, init) })
  for (const path of ['mirror/home/auma/memory/note.md', 'mirror/workspace/HANDOFF.md', 'server/private/file.mjs']) {
    const value = { ...input, path }
    assert.equal((await broker.request('/_host/repo', value, { token: broker.grant(value, '/_host/repo') })).value.code, 'REPO_PATH_REFUSED')
  }
  assert.equal(broker.consumed, 0)
  assert.equal((await broker.request('/_host/repo', input, { token: broker.grant(input, '/_host/repo') })).value.code, 'REPO_NONREGULAR_PATH_REFUSED')
  assert.equal(broker.calls.some(call => call.method !== 'GET'), false)
})

test('GitHub GET projections strip unknown metadata and limit fixed subroutes and query fields', async () => {
  const broker = harness({ fetch: url => {
    const path = new URL(url).pathname
    if (path.endsWith('/actions/runs')) return Response.json({ total_count: 1, workflow_runs: [{ id: 3, name: 'CI', status: 'completed', conclusion: 'success', head_sha: SHA, html_url: `https://github.com/${REPO}/actions/runs/3`, logs_url: 'discard-logs' }] })
    if (path.endsWith('/pulls/2')) return Response.json(issue(2, null, { html_url: `https://github.com/${REPO}/pull/2`, diff_url: 'discard-diff' }))
    if (path.endsWith('/issues')) return Response.json([issue(1, null, { user: { email: 'discard-email' } })])
    throw new Error('Unexpected route')
  } })
  for (const endpoint of [PREFIX + '/issues?per_page=1', PREFIX + '/pulls/2', PREFIX + '/actions/runs?per_page=1&page=1']) {
    const result = await broker.request('/_host/github', { action: 'api', endpoint })
    assert.equal(result.status, 200)
    assert.equal(JSON.stringify(result.value).includes('discard-'), false)
  }
  const before = broker.calls.length
  for (const endpoint of [PREFIX + '/issues?per_page=31', PREFIX + '/issues?page=1&page=2', PREFIX + '/actions/runs/1/logs', PREFIX + '/pulls/1/merge', PREFIX + '/issues/1/lock', PREFIX + '/git/trees/main?recursive=0', PREFIX + '/issues?unknown=1', PREFIX + '/contents/mirror/workspace/HANDOFF.md']) {
    assert.equal((await broker.request('/_host/github', { action: 'api', endpoint })).status, 403)
  }
  assert.equal(broker.calls.length, before)
})

test('issue comments send the exact approved body to a verified issue only once', async () => {
  const input = { action: 'api', method: 'POST', endpoint: PREFIX + '/issues/2/comments', body: { body: 'A comment' } }
  let writes = 0
  const broker = harness({ approvals: true, fetch: (url, init) => {
    if (init.method === 'GET') return Response.json(issue(2))
    writes++
    assert.equal(url, 'https://api.github.com' + input.endpoint)
    assert.deepEqual(JSON.parse(init.body), input.body)
    return Response.json({ id: 99, body: 'A comment', html_url: `https://github.com/${REPO}/issues/2#issuecomment-99` })
  } })
  const token = broker.grant(input)
  assert.equal((await broker.request('/_host/github', input, { token })).status, 200)
  assert.equal((await broker.request('/_host/github', input, { token })).value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(writes, 1)
})

test('complete streamed tree bounds and cancellation stop reads without content requests', async () => {
  let cancelled = false
  const oversized = harness({ fetch: () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'application/json' } }) })
  assert.equal((await oversized.request('/_host/repo', { action: 'tree' })).value.code, 'BROKER_BODY_TOO_LARGE')
  assert.equal(cancelled, true)
  let reached
  const entered = new Promise(resolve => { reached = resolve }), controller = new AbortController()
  const hanging = harness({ fetch: (_url, init) => { reached(init.signal); return new Promise(() => {}) } })
  const pending = hanging.request('/_host/repo', { action: 'tree' }, { signal: controller.signal })
  const upstreamSignal = await entered
  controller.abort()
  assert.equal((await pending).value.code, 'BROKER_TIMEOUT')
  assert.equal(upstreamSignal.aborted, true)
  assert.equal(hanging.calls.length, 1)
})

test('GitHub posts cannot mutate their payload after exact approval and expiry prevents dispatch', async () => {
  const input = issueInput()
  let sent
  const exactApproval = value => ({ ok: true, expiresAt: NOW + 1000, binding: { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/github', bodySha256: digest(canonicalJson(value)) } })
  const broker = harness({ authorizeClass3: value => {
    assert.equal(Object.isFrozen(value), true)
    assert.equal(Object.isFrozen(value.body), true)
    assert.throws(() => { value.body.body = 'Changed without approval' }, TypeError)
    return exactApproval(value)
  }, fetch: (_url, init) => { sent = JSON.parse(init.body); return Response.json(issue(1)) } })
  assert.equal((await broker.request('/_host/github', input)).status, 200)
  assert.deepEqual(sent, input.body)
  const expired = harness({ authorizeClass3: value => ({ ...exactApproval(value), expiresAt: NOW }) })
  assert.equal((await expired.request('/_host/github', input)).value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(expired.calls.length, 0)
})

test('only the new GET selftest admits browser-omitted Origin with exact same-origin metadata', async () => {
  const broker = harness()
  for (const referer of [null, ORIGIN + '/preview.html']) {
    const result = await broker.request('/_host/selftest', undefined, { headers: { origin: null, referer } })
    assert.equal(result.value.code, 'SELFTEST_INCOMPLETE')
  }
  for (const headers of [{ origin: null, 'sec-fetch-site': null }, { origin: null, 'sec-fetch-site': 'same-site' }, { origin: 'https://elsewhere.example' },
    { origin: null, referer: 'https://elsewhere.example/' }, { origin: null, referer: 'not a URL' }, { origin: null, referer: 'https://name@fixture.example/' }]) {
    assert.equal((await broker.request('/_host/selftest', undefined, { headers })).value.code, 'SAME_ORIGIN_BROWSER_REQUIRED')
  }
  assert.equal((await broker.request('/_host/repo', { action: 'selftest' }, { headers: { origin: null } })).value.code, 'SAME_ORIGIN_BROWSER_REQUIRED')
  for (const route of ['/_host/repo', '/_host/github', '/_host/cloudflare']) assert.equal((await broker.request(route, undefined, { headers: { origin: null } })).value.code, 'SAME_ORIGIN_BROWSER_REQUIRED')
})

test('publication scrubs filenames before approval or any network call', async () => {
  const env = { ...defaultEnv(), GITHUB_TOKEN: 'opaque-fixture-value' }
  const broker = harness({ env, approvals: true })
  for (const path of ['server/opaque-fixture-value.mjs', 'server/sk-proj-abcdefghijklmnopqrstuv.mjs']) {
    const input = { action: 'write', path, content: 'safe source', message: 'A bounded change', expectedHeadSha: SHA, idempotencyKey: 'fixture-publication-123' }
    assert.equal((await broker.request('/_host/repo', input, { token: broker.grant(input, '/_host/repo') })).value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  }
  assert.equal(broker.consumed, 0)
  assert.equal(broker.calls.length, 0)
})

test('publication output-validation failure after a successful commit remains a repository unknown outcome', async () => {
  const env = { ...defaultEnv(), GITHUB_TOKEN: NEW }
  const input = { action: 'write', path: 'README.md', content: 'safe source', message: 'A bounded change', expectedHeadSha: SHA, idempotencyKey: 'fixture-publication-123' }
  let writes = 0
  const broker = harness({ env, approvals: true, fetch: (url, init) => {
    if (init.method === 'POST') { writes++; return Response.json({ data: { createCommitOnBranch: { commit: { oid: NEW } } } }) }
    if (url.includes('/commits?')) return Response.json([{ sha: SHA, commit: { message: 'Base' } }])
    return sourceFetch(['README.md'])(url, init)
  } })
  const token = broker.grant(input, '/_host/repo'), result = await broker.request('/_host/repo', input, { token })
  assert.equal(result.value.code, 'REPO_PUBLICATION_OUTCOME_UNKNOWN')
  assert.equal(result.value.retry, 'repeat-the-identical-request-to-reconcile')
  assert.equal(result.value.requiresFreshClass3Approval, true)
  assert.equal(JSON.stringify(result.value).includes(NEW), false)
  assert.equal((await broker.request('/_host/repo', input, { token })).value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(writes, 1)
})

test('historical commit metadata requires one bounded proof of main ancestry', async () => {
  for (const status of ['diverged', 'behind', 'ahead']) {
    const broker = harness({ fetch: url => {
      if (url.endsWith('/commits/main')) return Response.json({ sha: NEW, commit: { message: 'Main' } })
      if (url.includes('/compare/')) return Response.json({ base_commit: { sha: SHA }, merge_base_commit: { sha: status === 'ahead' ? SHA : BLOB }, status, ahead_by: 2, behind_by: status === 'ahead' ? 0 : 1 })
      assert.equal(status, 'ahead', 'Unmerged metadata must not be fetched')
      assert.equal(url, `https://api.github.com${PREFIX}/commits/${SHA}`)
      return Response.json({ sha: SHA, commit: { message: 'Verified main ancestor' } })
    } })
    const result = await broker.request('/_host/github', { action: 'api', endpoint: PREFIX + '/commits/' + SHA })
    if (status === 'ahead') { assert.equal(result.status, 200); assert.equal(result.value.json.sha, SHA); assert.equal(broker.calls.length, 3) }
    else { assert.equal(result.value.code, 'REPO_MAIN_ANCESTRY_REQUIRED'); assert.equal(broker.calls.length, 2) }
  }
})

test('comparison rejects divergent bases and caller-selected heads without returning private branch patches', async () => {
  const broker = harness({ fetch: (url, init) => url.includes('/compare/')
    ? Response.json({ base_commit: { sha: NEW }, merge_base_commit: { sha: BLOB }, status: 'diverged', ahead_by: 1, behind_by: 1, files: [{ filename: 'README.md', status: 'modified', patch: 'unmerged branch text' }] })
    : sourceFetch(['README.md'])(url, init) })
  const result = await broker.request('/_host/repo', { action: 'diff', base: NEW })
  assert.equal(result.value.code, 'REPO_MAIN_ANCESTRY_REQUIRED')
  assert.equal(JSON.stringify(result.value).includes('unmerged'), false)
  const calls = broker.calls.length
  assert.equal((await broker.request('/_host/github', { action: 'api', endpoint: `${PREFIX}/compare/${SHA}...${NEW}` })).value.code, 'GITHUB_ENDPOINT_REFUSED')
  assert.equal(broker.calls.length, calls)
})

test('valid main-ancestor comparisons admit normal paths and require an explicit rename source', async () => {
  let status = 'modified'
  const broker = harness({ fetch: (url, init) => {
    if (url.endsWith('/commits/main')) return Response.json({ sha: NEW, commit: { message: 'Main', tree: { sha: TREE } } })
    if (url.includes('/compare/')) {
      assert.equal(url, `https://api.github.com${PREFIX}/compare/${SHA}...${NEW}`)
      return Response.json({ base_commit: { sha: SHA }, merge_base_commit: { sha: SHA }, status: 'ahead', ahead_by: 1, behind_by: 0,
        files: [{ filename: 'README.md', status, patch: '+A main change' }] })
    }
    return sourceFetch(['README.md'])(url, init)
  } })
  const result = await broker.request('/_host/repo', { action: 'diff', base: SHA })
  assert.equal(result.status, 200)
  assert.equal(result.value.head, NEW)
  assert.deepEqual(result.value.files, [{ path: 'README.md', status: 'modified', patch: '+A main change' }])
  for (status of ['renamed', 'copied']) assert.equal((await broker.request('/_host/repo', { action: 'diff', base: SHA })).value.code, 'BROKER_RESPONSE_INVALID')
})
