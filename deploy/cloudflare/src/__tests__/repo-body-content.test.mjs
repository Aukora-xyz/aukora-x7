/** Her `write`, `edit`, `commit` and `apply_patch` carry the file in the request BODY, so a file
 * of ordinary size lands in one call; an oversized file answers a size code; a field the action does not take answers
 * BROKER_QUERY_INVALID naming that field (never mistaken for a size limit). Every path, branch and main refusal stays.
 * Fixed synthetic provider state: these tests never call GitHub (the fake follows repo-apply-patch.test.mjs). */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { handleCloudBroker, CLOUD_REPO_BRANCH_LIMITS } from '../cloud-brokers.mjs'

const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const MAIN = 'a'.repeat(40), HEAD = 'b'.repeat(40), NEXT = 'c'.repeat(40), MAIN_TREE = 'd'.repeat(40), HEAD_TREE = 'e'.repeat(40)
const BRANCH = 'auma/proposal/body-fixture', NOW = 1794367000000, EMAIL = 'owner@fixture.example'
const BOOTSTRAP = { ready: true, head: { phase: 'complete', seedId: '1'.repeat(64) }, mirror: { phase: 'ready' } }
const blob = value => createHash('sha1').update(value).digest('hex')
const owner = { type: 'owner', email: EMAIL, expires: NOW / 1000 + 600 }
const json = value => Response.json(value)
const FILES = { 'docs/auma/a.md': 'one\ntwo\nthree\n' }
/** `n` bytes of ordinary text: plain lines, nothing secret-shaped. */
const ordinary = n => Array.from({ length: Math.ceil(n / 64) }, (_v, i) => `ordinary line ${String(i).padStart(6, '0')} of plain text, written in one call`.padEnd(63, '.') + '\n').join('').slice(0, n)
const KB64 = ordinary(64 * 1024)

function tree(files, sha) {
  const entries = new Map()
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) entries.set(parts.slice(0, i).join('/'), { path: parts.slice(0, i).join('/'), mode: '040000', type: 'tree', sha: blob(parts.slice(0, i).join('/') + sha) })
    entries.set(path, { path, mode: '100644', type: 'blob', sha: blob(content), size: Buffer.byteLength(content) })
  }
  return { sha, truncated: false, tree: [...entries.values()] }
}

function fixture() {
  const refs = new Map([['main', MAIN], [BRANCH, HEAD]]), commits = []
  const env = { GITHUB_TOKEN: 'synthetic-token-value', OWNER_EMAIL: EMAIL, PUBLIC_HOST: 'fixture.example', SOURCE_REVISION: MAIN }
  const networkFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl)
    assert.equal(url.hostname, 'api.github.com')
    if (url.pathname === '/graphql') {
      const input = JSON.parse(init.body).variables.input
      assert.equal(refs.get(input.branch.branchName), input.expectedHeadOid)
      commits.push(input); refs.set(input.branch.branchName, NEXT)
      return json({ data: { createCommitOnBranch: { commit: { oid: NEXT } } } })
    }
    if (url.pathname.startsWith(PREFIX + '/git/ref/heads/')) {
      const branch = decodeURIComponent(url.pathname.slice((PREFIX + '/git/ref/heads/').length)), sha = refs.get(branch)
      return sha ? json({ ref: 'refs/heads/' + branch, object: { type: 'commit', sha } }) : new Response('', { status: 404 })
    }
    if (url.pathname.startsWith(PREFIX + '/commits/')) {
      const ref = decodeURIComponent(url.pathname.slice((PREFIX + '/commits/').length)), sha = refs.get(ref) ?? ref
      return json({ sha, commit: { tree: { sha: sha === MAIN ? MAIN_TREE : HEAD_TREE } } })
    }
    if (url.pathname.startsWith(PREFIX + '/git/trees/')) return json(tree(FILES, url.pathname.split('/').at(-1)))
    if (url.pathname.startsWith(PREFIX + '/contents/')) {
      const path = decodeURIComponent(url.pathname.slice((PREFIX + '/contents/').length)), content = FILES[path]
      if (content === undefined) return new Response('', { status: 404 })
      return json({ type: 'file', path, sha: blob(content), encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    throw new Error('Unexpected synthetic URL ' + url.pathname)
  }
  return {
    commits, refs,
    async request(input) {
      const body = JSON.stringify(input)
      const request = new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body })
      // Nothing about the content rides the URL or a header: only the body carries it.
      assert.equal(new URL(request.url).search, '')
      for (const [, value] of request.headers) assert.ok(value.length < 256)
      const response = await handleCloudBroker(request, env, { access: owner, bootstrap: BOOTSTRAP, now: () => NOW, networkFetch, authorizeClass3: async () => { assert.fail('asked for a passkey') } })
      return { status: response.status, value: await response.json() }
    },
  }
}
const decode = addition => Buffer.from(addition.contents, 'base64').toString('utf8')
const landed = (broker, path) => decode(broker.commits.at(-1).fileChanges.additions.find(item => item.path === path))

test('a 64 KB write of ordinary text to her proposal branch lands in one call', async () => {
  const broker = fixture(), result = await broker.request({ action: 'write', branch: BRANCH, path: 'docs/auma/big.md', content: KB64, message: 'Write the whole file', ownerSession: true })
  assert.equal(result.status, 200, JSON.stringify(result.value).slice(0, 400))
  assert.equal(result.value.ok, true)
  assert.equal(broker.commits.length, 1)
  assert.equal(landed(broker, 'docs/auma/big.md'), KB64)
})

test('a 64 KB write without a message is answered whole as her draft (one call, nothing committed)', async () => {
  const broker = fixture(), result = await broker.request({ action: 'write', branch: BRANCH, path: 'docs/auma/big.md', content: KB64, ownerSession: true })
  assert.equal(result.status, 200)
  assert.deepEqual({ ok: result.value.ok, staged: result.value.staged, scope: result.value.scope, content: result.value.content === KB64 }, { ok: true, staged: true, scope: 'caller', content: true })
  assert.equal(broker.commits.length, 0)
})

test('a 64 KB edit and a 64 KB commit land in one call each', async () => {
  const edit = fixture(), edited = await edit.request({ action: 'edit', branch: BRANCH, path: 'docs/auma/a.md', oldString: 'two\n', newString: KB64, message: 'Grow a.md', ownerSession: true })
  assert.equal(edited.status, 200, JSON.stringify(edited.value).slice(0, 400))
  assert.equal(landed(edit, 'docs/auma/a.md'), 'one\n' + KB64 + 'three\n')
  const commit = fixture(), committed = await commit.request({ action: 'commit', branch: BRANCH, changes: [{ path: 'docs/auma/big.md', content: KB64 }, { path: 'docs/auma/big2.md', content: KB64 }], message: 'Two files', ownerSession: true })
  assert.equal(committed.status, 200, JSON.stringify(committed.value).slice(0, 400))
  assert.equal(landed(commit, 'docs/auma/big2.md'), KB64)
})

test('a 64 KB apply_patch lands in one call', async () => {
  const lines = KB64.split('\n').filter(Boolean)
  const patch = `diff --git a/docs/auma/big.md b/docs/auma/big.md\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/auma/big.md\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`
  assert.equal(Buffer.byteLength(KB64), 64 * 1024)
  assert.ok(Buffer.byteLength(patch) > 64 * 1024)
  const broker = fixture(), result = await broker.request({ action: 'apply_patch', branch: BRANCH, baseSha: HEAD, patch, message: 'Bring it home', ownerSession: true })
  assert.equal(result.status, 200, JSON.stringify(result.value).slice(0, 400))
  assert.equal(landed(broker, 'docs/auma/big.md'), lines.join('\n') + '\n')
})

test('a file over the per-file limit answers REPO_FILE_TOO_LARGE (413, the limit named), never BROKER_QUERY_INVALID', async () => {
  const over = ordinary(CLOUD_REPO_BRANCH_LIMITS.fileBytes + 1)
  for (const input of [
    { action: 'write', branch: BRANCH, path: 'docs/auma/big.md', content: over, message: 'Too big', ownerSession: true },
    { action: 'edit', branch: BRANCH, path: 'docs/auma/a.md', oldString: 'two\n', newString: over, ownerSession: true },
    { action: 'commit', branch: BRANCH, changes: [{ path: 'docs/auma/big.md', content: over }], message: 'Too big', ownerSession: true },
  ]) {
    const broker = fixture(), result = await broker.request(input)
    assert.deepEqual({ status: result.status, ok: result.value.ok, code: result.value.code, limitBytes: result.value.limitBytes },
      { status: 413, ok: false, code: 'REPO_FILE_TOO_LARGE', limitBytes: 512 * 1024 }, input.action)
    assert.equal(broker.commits.length, 0)
  }
})

test('a field the action does not take answers BROKER_QUERY_INVALID naming it and the allowed fields', async () => {
  const broker = fixture(), result = await broker.request({ action: 'commit', branch: BRANCH, changes: [{ path: 'docs/auma/big.md', content: KB64 }], paths: ['docs/auma/big.md'], message: 'm', ownerSession: true })
  assert.equal(result.status, 400)
  assert.equal(result.value.code, 'BROKER_QUERY_INVALID')
  assert.deepEqual(result.value.unexpected, ['paths'])
  assert.ok(result.value.allowed.includes('changes') && !result.value.allowed.includes('ownerSession'))
  assert.match(result.value.next, /request body/)
  assert.equal(broker.commits.length, 0)
  const secret = await fixture().request({ action: 'write', branch: BRANCH, path: 'docs/auma/a.md', content: 'x', ghp_abcdefghijklmnopqrstuvwxyz0123: 1, ownerSession: true })
  assert.deepEqual({ code: secret.value.code, unexpected: secret.value.unexpected, unnamed: secret.value.unexpectedUnnamed }, { code: 'BROKER_QUERY_INVALID', unexpected: [], unnamed: 1 })
  assert.equal(JSON.stringify(secret.value).includes('ghp_'), false)
})

test('a secret-shaped path is still refused and a write to main of a deployed path still needs a proposal', async () => {
  for (const path of ['docs/auma/.env', 'docs/auma/private-key.md', 'docs/auma/secrets.md']) {
    const broker = fixture(), result = await broker.request({ action: 'write', branch: BRANCH, path, content: KB64, message: 'm', ownerSession: true })
    assert.equal(result.value.ok, false, path)
    assert.equal(broker.commits.length, 0, path)
  }
  const main = fixture(), refused = await main.request({ action: 'write', path: 'deploy/cloudflare/src/worker.mjs', content: KB64, message: 'm', ownerSession: true })
  assert.equal(refused.value.ok, false)
  assert.equal(refused.value.code, 'REPO_PROPOSAL_REQUIRED')
  assert.equal(main.commits.length, 0)
  const other = fixture(), branchRefused = await other.request({ action: 'write', branch: 'feature/not-hers', path: 'docs/auma/big.md', content: KB64, message: 'm', ownerSession: true })
  assert.equal(branchRefused.value.ok, false)
  assert.equal(other.commits.length, 0)
})
