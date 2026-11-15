/** `apply_patch`, a unified diff applied to her own branch in one commit, through the same fence as `commit`.
 * Fixed synthetic provider state: these tests never call GitHub. The fake follows repo-frozen-paths.test.mjs's shape. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { handleCloudBroker, parseUnifiedPatch, CLOUD_REPO_PATCH_LIMITS } from '../cloud-brokers.mjs'

const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const MAIN = 'a'.repeat(40), HEAD = 'b'.repeat(40), NEXT = 'c'.repeat(40), MAIN_TREE = 'd'.repeat(40), HEAD_TREE = 'e'.repeat(40)
const BRANCH = 'auma/sandbox/patch-fixture', NOW = 1794367000000, EMAIL = 'owner@fixture.example'
const BOOTSTRAP = { ready: true, head: { phase: 'complete', seedId: '1'.repeat(64) }, mirror: { phase: 'ready' } }
const blob = value => createHash('sha1').update(value).digest('hex')
const owner = { type: 'owner', email: EMAIL, expires: NOW / 1000 + 600 }
const json = value => Response.json(value)

const MULTI = Array.from({ length: 59 }, (_v, i) => `line ${i + 1}`).join('\n') + '\n'
const BASE_FILES = {
  'docs/auma/a.md': 'one\ntwo\nthree\n',
  'docs/auma/multi.md': MULTI,
  'docs/auma/noeol.md': 'one\ntwo\nthree',
  'docs/auma/crlf.md': 'a\r\nb\r\nc\r\n',
  'docs/auma/gone.md': 'bye\nnow\n',
  'packages/experimental/webworker-runtime/src/x6/ball-loader.ts': 'export {}\n',
  'packages/experimental/webworker-runtime/src/storage/memory.ts': 'export {}\n',
  'deploy/cloudflare/src/cloud-brokers.mjs': 'export {}\n',
  'server/tool.mjs': 'export {}\n',
}

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

// The default door level is 'open'; these tests pin the GUARDED level explicitly (`level`).
function fixture({ files = BASE_FILES, head = HEAD, slowRead = null, level = 'guarded' } = {}) { // HANDS hook: slowRead, a contents read answered by the test
  const refs = new Map([['main', MAIN], [BRANCH, head]]), commits = [], calls = []
  const env = { GITHUB_TOKEN: 'synthetic-token-value', OWNER_EMAIL: EMAIL, PUBLIC_HOST: 'fixture.example', SOURCE_REVISION: MAIN }
  const networkFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl); calls.push({ url: rawUrl, method: init.method })
    assert.equal(url.hostname, 'api.github.com')
    if (url.pathname === '/graphql') {
      const operation = JSON.parse(init.body), input = operation.variables.input
      assert.match(operation.query, /createCommitOnBranch/)
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
    if (url.pathname.startsWith(PREFIX + '/git/trees/')) return json(tree(files, url.pathname.split('/').at(-1)))
    if (url.pathname.startsWith(PREFIX + '/contents/')) {
      const path = decodeURIComponent(url.pathname.slice((PREFIX + '/contents/').length)), content = files[path]
      assert.equal(url.searchParams.get('ref'), head)
      const answered = slowRead ? await slowRead(path, init) : undefined // HANDS hook
      if (answered !== undefined) return answered
      if (content === undefined) return new Response('', { status: 404 })
      return json({ type: 'file', path, sha: blob(content), encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    throw new Error('Unexpected synthetic URL ' + url.pathname)
  }
  return {
    commits, calls, refs,
    async request(input) {
      const request = new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(input) })
      const response = await handleCloudBroker(request, env, { access: owner, bootstrap: BOOTSTRAP, now: () => NOW, networkFetch, ...(level === 'guarded' ? { repoDoorLevel: 'guarded' } : {}), authorizeClass3: async () => { assert.fail('apply_patch asked for a passkey') } })
      return { status: response.status, value: await response.json() }
    },
  }
}

const decode = addition => Buffer.from(addition.contents, 'base64').toString('utf8')
const apply = (broker, patch, extra = {}) => broker.request({ action: 'apply_patch', branch: BRANCH, baseSha: HEAD, patch, message: 'Bring the change home', ...extra })
const modify = (path, hunks) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${hunks}`
const ONE_HUNK = modify('docs/auma/a.md', '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n')

/** A refusal: its code, and nothing written (no commit was sent to GitHub). */
async function refusedWith(broker, patch, code, extra = {}, facts = {}) {
  const result = await apply(broker, patch, extra)
  assert.equal(result.value.ok, false, JSON.stringify(result.value))
  assert.equal(result.value.code, code, JSON.stringify(result.value))
  for (const [key, value] of Object.entries(facts)) assert.deepEqual(result.value[key], value, key)
  assert.equal(broker.commits.length, 0, 'nothing written')
  assert.equal(broker.calls.some(call => call.url.endsWith('/graphql')), false, 'no mutation sent')
  return result
}

test('one hunk: one commit with her message on the expected head, answering head and files', async () => {
  const broker = fixture(), result = await apply(broker, ONE_HUNK)
  assert.equal(result.status, 200, JSON.stringify(result.value))
  assert.deepEqual({ ok: result.value.ok, branch: result.value.branch, head: result.value.head, files: result.value.files },
    { ok: true, branch: BRANCH, head: NEXT, files: [{ path: 'docs/auma/a.md', status: 'modified' }] })
  assert.equal(broker.commits.length, 1)
  const [commit] = broker.commits
  assert.equal(commit.expectedHeadOid, HEAD)
  assert.deepEqual(commit.message, { headline: 'Bring the change home' })
  assert.deepEqual(commit.fileChanges.additions.map(item => [item.path, decode(item)]), [['docs/auma/a.md', 'one\nTWO\nthree\n']])
  assert.equal(commit.fileChanges.deletions, undefined)
  assert.equal(broker.refs.get('main'), MAIN, 'main untouched')
})

test('several hunks in one file, several files, a new file, a deleted file, no final newline, CRLF kept', async () => {
  const multi = MULTI.split('\n'); multi[2] = 'LINE 3'; multi[40] = 'LINE 41'; multi.splice(50, 0, 'inserted')
  const patch = [
    modify('docs/auma/crlf.md', '@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r\n'),
    'diff --git a/docs/auma/gone.md b/docs/auma/gone.md\ndeleted file mode 100644\nindex e5e6fb7..0000000\n--- a/docs/auma/gone.md\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-bye\n-now\n',
    modify('docs/auma/multi.md', '@@ -1,6 +1,6 @@\n line 1\n line 2\n-line 3\n+LINE 3\n line 4\n line 5\n line 6\n'
      + '@@ -38,7 +38,7 @@ line 37\n line 38\n line 39\n line 40\n-line 41\n+LINE 41\n line 42\n line 43\n line 44\n'
      + '@@ -48,6 +48,7 @@ line 47\n line 48\n line 49\n line 50\n+inserted\n line 51\n line 52\n line 53\n'),
    'diff --git a/docs/auma/new.md b/docs/auma/new.md\nnew file mode 100644\nindex 0000000..9d8f9d4\n--- /dev/null\n+++ b/docs/auma/new.md\n@@ -0,0 +1,2 @@\n+fresh\n+file\n',
    modify('docs/auma/noeol.md', '@@ -1,3 +1,3 @@\n one\n two\n-three\n\\ No newline at end of file\n+THREE\n\\ No newline at end of file\n'),
  ].join('')
  const broker = fixture(), result = await apply(broker, patch)
  assert.equal(result.status, 200, JSON.stringify(result.value))
  assert.deepEqual(result.value.files, [
    { path: 'docs/auma/crlf.md', status: 'modified' }, { path: 'docs/auma/gone.md', status: 'deleted' },
    { path: 'docs/auma/multi.md', status: 'modified' }, { path: 'docs/auma/new.md', status: 'added' }, { path: 'docs/auma/noeol.md', status: 'modified' }])
  assert.equal(broker.commits.length, 1)
  const changes = Object.fromEntries(broker.commits[0].fileChanges.additions.map(item => [item.path, decode(item)]))
  assert.deepEqual(changes, {
    'docs/auma/crlf.md': 'a\r\nB\r\nc\r\n', 'docs/auma/multi.md': multi.join('\n'), 'docs/auma/new.md': 'fresh\nfile\n', 'docs/auma/noeol.md': 'one\ntwo\nTHREE' })
  assert.deepEqual(broker.commits[0].fileChanges.deletions, [{ path: 'docs/auma/gone.md' }])
})

test('adding the missing final newline, and a new empty file', async () => {
  const patch = modify('docs/auma/noeol.md', '@@ -2,2 +2,2 @@\n two\n-three\n\\ No newline at end of file\n+three\n')
    + 'diff --git a/docs/auma/empty.md b/docs/auma/empty.md\nnew file mode 100644\nindex 0000000..e69de29\n'
  const broker = fixture(), result = await apply(broker, patch)
  assert.equal(result.status, 200, JSON.stringify(result.value))
  assert.deepEqual(Object.fromEntries(broker.commits[0].fileChanges.additions.map(item => [item.path, decode(item)])), { 'docs/auma/empty.md': '', 'docs/auma/noeol.md': 'one\ntwo\nthree\n' })
})

test('refuses a context line that differs, and a hunk at the wrong position, naming the file and hunk', async () => {
  await refusedWith(fixture(), modify('docs/auma/a.md', '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n THREE\n'), 'PATCH_CONTEXT_MISMATCH', {}, { path: 'docs/auma/a.md', hunk: 1 })
  // The right lines, one line off: no offset search.
  await refusedWith(fixture(), modify('docs/auma/a.md', '@@ -2,2 +2,2 @@\n one\n-two\n+TWO\n'), 'PATCH_CONTEXT_MISMATCH', {}, { path: 'docs/auma/a.md', hunk: 1 })
  // The second hunk wrong: the first one is not committed alone.
  await refusedWith(fixture(), modify('docs/auma/multi.md', '@@ -1,2 +1,2 @@\n line 1\n-line 2\n+LINE 2\n@@ -10,1 +10,1 @@\n-line 11\n+LINE 11\n'),
    'PATCH_CONTEXT_MISMATCH', {}, { path: 'docs/auma/multi.md', hunk: 2 })
  // A missing "no newline" marker is a mismatch too (the file has no final newline).
  await refusedWith(fixture(), modify('docs/auma/noeol.md', '@@ -3,1 +3,1 @@\n-three\n+THREE\n'), 'PATCH_CONTEXT_MISMATCH', {}, { path: 'docs/auma/noeol.md', hunk: 1 })
  // A new file that already exists, a change to a file that does not.
  await refusedWith(fixture(), 'diff --git a/docs/auma/a.md b/docs/auma/a.md\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/auma/a.md\n@@ -0,0 +1 @@\n+x\n',
    'PATCH_CONTEXT_MISMATCH', {}, { path: 'docs/auma/a.md', hunk: 0 })
  await refusedWith(fixture(), modify('docs/auma/none.md', '@@ -1 +1 @@\n-x\n+y\n'), 'PATCH_CONTEXT_MISMATCH', {}, { path: 'docs/auma/none.md' })
})

test('refuses a rename, a copy, a binary patch, a mode change and a submodule by name', async () => {
  const cases = [
    ['diff --git a/docs/auma/a.md b/docs/auma/b.md\nsimilarity index 100%\nrename from docs/auma/a.md\nrename to docs/auma/b.md\n', 'rename', 'docs/auma/a.md'],
    ['diff --git a/docs/auma/a.md b/docs/auma/b.md\nsimilarity index 90%\ncopy from docs/auma/a.md\ncopy to docs/auma/b.md\n', 'copy', 'docs/auma/a.md'],
    ['diff --git a/docs/auma/a.md b/docs/auma/a.md\nindex 1111111..2222222 100644\nBinary files a/docs/auma/a.md and b/docs/auma/a.md differ\n', 'binary', 'docs/auma/a.md'],
    ['diff --git a/docs/auma/a.md b/docs/auma/a.md\nindex 1111111..2222222\nGIT binary patch\nliteral 3\nKcmZ?wJ\n', 'binary', 'docs/auma/a.md'],
    ['diff --git a/docs/auma/a.md b/docs/auma/a.md\nold mode 100644\nnew mode 100755\n', 'mode', 'docs/auma/a.md'],
    ['diff --git a/docs/auma/run.sh b/docs/auma/run.sh\nnew file mode 100755\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/auma/run.sh\n@@ -0,0 +1 @@\n+x\n', 'mode', 'docs/auma/run.sh'],
    ['diff --git a/docs/auma/run.sh b/docs/auma/run.sh\nindex 1111111..2222222 100755\n--- a/docs/auma/run.sh\n+++ b/docs/auma/run.sh\n@@ -1 +1 @@\n-old\n+new\n', 'executable', 'docs/auma/run.sh'],
    ['diff --git a/docs/auma/sub b/docs/auma/sub\nnew file mode 160000\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/auma/sub\n@@ -0,0 +1 @@\n+Subproject commit ' + 'f'.repeat(40) + '\n', 'submodule', 'docs/auma/sub'],
  ]
  for (const [patch, what, path] of cases) await refusedWith(fixture(), patch, 'PATCH_UNSUPPORTED', {}, { what, path })
})

test('refuses a malformed patch with its line, a wrong shape, 65 files and 256 KiB + 1', async () => {
  await refusedWith(fixture(), '--- a/docs/auma/a.md\n+++ b/docs/auma/a.md\n@@ -1 +1 @@\n-one\n+ONE\n', 'PATCH_PARSE', {}, { line: 1 })
  await refusedWith(fixture(), modify('docs/auma/a.md', '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n'), 'PATCH_PARSE', {}, { line: 9 })
  await refusedWith(fixture(), modify('docs/auma/a.md', '@@ -1,3 +1,3 @@\n one\n\n+TWO\n three\n'), 'PATCH_PARSE', {}, { line: 7 })
  await refusedWith(fixture(), '', 'PATCH_SHAPE')
  await refusedWith(fixture(), undefined, 'PATCH_SHAPE')
  await refusedWith(fixture(), 'diff --git a/x b/x\u0000', 'PATCH_SHAPE')
  const many = Array.from({ length: CLOUD_REPO_PATCH_LIMITS.files + 1 }, (_v, i) => `diff --git a/docs/auma/n${i}.md b/docs/auma/n${i}.md\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/auma/n${i}.md\n@@ -0,0 +1 @@\n+x\n`).join('')
  assert.equal(CLOUD_REPO_PATCH_LIMITS.files, 64)
  await refusedWith(fixture(), many, 'PATCH_FILES_LIMIT')
  const head = 'diff --git a/docs/auma/big.md b/docs/auma/big.md\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/auma/big.md\n@@ -0,0 +1 @@\n+'
  const exact = head + 'x'.repeat(256 * 1024 - Buffer.byteLength(head) - 1) + '\n'
  assert.equal(Buffer.byteLength(exact), 256 * 1024)
  assert.equal(parseUnifiedPatch(exact).length, 1, 'exactly 256 KiB parses')
  await refusedWith(fixture(), exact + '\n', 'PATCH_TOO_LARGE')
})

test('the fence: paths outside the open paths, closed and frozen files, secret-shaped lines', async () => {
  const add = path => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`
  await refusedWith(fixture(), add('server/new-tool.mjs'), 'REPO_PATH_NOT_OPEN')
  await refusedWith(fixture(), modify('server/tool.mjs', '@@ -1 +1 @@\n-export {}\n+export const x = 1\n'), 'REPO_PATH_NOT_OPEN')
  await refusedWith(fixture(), modify('packages/experimental/webworker-runtime/src/x6/ball-loader.ts', '@@ -1 +1 @@\n-export {}\n+export const x = 1\n'), 'REPO_FROZEN_PATH_REFUSED')
  await refusedWith(fixture(), modify('packages/experimental/webworker-runtime/src/storage/memory.ts', '@@ -1 +1 @@\n-export {}\n+export const x = 1\n'), 'REPO_PATH_NOT_OPEN')
  await refusedWith(fixture(), modify('deploy/cloudflare/src/cloud-brokers.mjs', '@@ -1 +1 @@\n-export {}\n+export const x = 1\n'), 'REPO_FROZEN_PATH_REFUSED')
  await refusedWith(fixture(), add('.github/workflows/x.yml'), 'REPO_WORKFLOW_PATH_REFUSED')
  // One good file and one fenced file: the good one is not committed either.
  await refusedWith(fixture(), ONE_HUNK + add('server/new-tool.mjs'), 'REPO_PATH_NOT_OPEN')
  await refusedWith(fixture(), modify('docs/auma/a.md', '@@ -1,3 +1,3 @@\n one\n-two\n+token: ghp_' + 'A'.repeat(36) + '\n three\n'), 'BROKER_PRIVATE_CONTENT_REFUSED')
})

test('only her own branch, never main, and a moved head is refused with the head it found', async () => {
  await refusedWith(fixture(), ONE_HUNK, 'REPO_BRANCH_REFUSED', { branch: 'main' })
  await refusedWith(fixture(), ONE_HUNK, 'REPO_BRANCH_REFUSED', { branch: undefined })
  await refusedWith(fixture(), ONE_HUNK, 'REPO_BRANCH_REFUSED', { branch: 'feature/not-hers' })
  await refusedWith(fixture(), ONE_HUNK, 'REPO_BRANCH_REFUSED', { branch: 'auma/other/thing' })
  await refusedWith(fixture({ head: NEXT }), ONE_HUNK, 'REPO_HEAD_MOVED', {}, { headSha: NEXT })
  await refusedWith(fixture(), ONE_HUNK, 'REPO_BASE_SHA_REQUIRED', { baseSha: 'abc' })
  await refusedWith(fixture(), ONE_HUNK, 'REPO_COMMIT_MESSAGE_INVALID', { message: 'two\nlines' })
  await refusedWith(fixture(), ONE_HUNK, 'BROKER_QUERY_INVALID', { changes: [] })
})

test('apply_patch is not a cloud-wake action and needs the owner session', async () => {
  const { CLOUD_WAKE_REPO_ACTIONS } = await import('../cloud-brokers.mjs')
  assert.equal(Object.hasOwn(CLOUD_WAKE_REPO_ACTIONS, 'apply_patch'), false)
  const broker = fixture()
  const request = new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'apply_patch', branch: BRANCH, baseSha: HEAD, patch: ONE_HUNK, message: 'x' }) })
  const response = await handleCloudBroker(request, { GITHUB_TOKEN: 'synthetic-token-value', OWNER_EMAIL: EMAIL }, { access: { type: 'guest' }, bootstrap: BOOTSTRAP, now: () => NOW, networkFetch: async () => assert.fail('no network for a stranger') })
  assert.equal((await response.json()).code, 'OWNER_SESSION_REQUIRED')
  assert.equal(broker.commits.length, 0)
})

// ---- HANDS block begin: a successful write on her branch answers with the facts and a bounded hunk per file ----
const gitBlob = value => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex')

test('apply_patch answers changes: blob shas, sizes, lines and the hunk, beside the files it always named', async () => {
  const result = await apply(fixture(), ONE_HUNK)
  assert.equal(result.status, 200, JSON.stringify(result.value))
  assert.deepEqual(result.value.changes, [{ path: 'docs/auma/a.md', status: 'modified', oldBlobSha: gitBlob('one\ntwo\nthree\n'), newBlobSha: gitBlob('one\nTWO\nthree\n'),
    oldBytes: 14, newBytes: 14, linesAdded: 1, linesRemoved: 1, hunk: '--- a/docs/auma/a.md\n+++ b/docs/auma/a.md\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n', hunkOmittedBytes: 0 }])
  assert.equal(result.value.content, undefined, 'never the whole file')
})

test('a staged branch edit keeps content for the tab and adds the facts; a commit adds them for every file', async () => {
  const broker = fixture()
  const staged = await broker.request({ action: 'edit', branch: BRANCH, path: 'docs/auma/multi.md', oldString: 'line 30\n', newString: 'line thirty\n', ownerSession: true })
  assert.equal(staged.status, 200, JSON.stringify(staged.value))
  const after = MULTI.replace('line 30\n', 'line thirty\n')
  assert.equal(staged.value.content, after, 'the tab keeps the draft from content')
  assert.deepEqual(staged.value.changes, [{ path: 'docs/auma/multi.md', status: 'modified', oldBlobSha: gitBlob(MULTI), newBlobSha: gitBlob(after),
    oldBytes: Buffer.byteLength(MULTI), newBytes: Buffer.byteLength(after), linesAdded: 1, linesRemoved: 1,
    hunk: '--- a/docs/auma/multi.md\n+++ b/docs/auma/multi.md\n@@ -27,7 +27,7 @@\n line 27\n line 28\n line 29\n-line 30\n+line thirty\n line 31\n line 32\n line 33\n', hunkOmittedBytes: 0 }])
  const committed = await broker.request({ action: 'commit', branch: BRANCH, message: 'two files', ownerSession: true,
    changes: [{ path: 'docs/auma/a.md', content: 'one\ntwo\n' }, { path: 'docs/auma/new.md', content: 'fresh\n' }] })
  assert.equal(committed.status, 200, JSON.stringify(committed.value))
  assert.deepEqual({ commit: committed.value.commit, headSha: committed.value.headSha, paths: committed.value.paths }, { commit: NEXT, headSha: NEXT, paths: ['docs/auma/a.md', 'docs/auma/new.md'] })
  assert.deepEqual(committed.value.changes.map(({ hunk: _hunk, ...facts }) => facts), [
    { path: 'docs/auma/a.md', status: 'modified', oldBlobSha: gitBlob('one\ntwo\nthree\n'), newBlobSha: gitBlob('one\ntwo\n'), oldBytes: 14, newBytes: 8, linesAdded: 0, linesRemoved: 1, hunkOmittedBytes: 0 },
    { path: 'docs/auma/new.md', status: 'added', oldBlobSha: null, newBlobSha: gitBlob('fresh\n'), oldBytes: 0, newBytes: 6, linesAdded: 1, linesRemoved: 0, hunkOmittedBytes: 0 }])
  assert.equal(committed.value.changes[1].hunk, '--- /dev/null\n+++ b/docs/auma/new.md\n@@ -0,0 +1,1 @@\n+fresh\n')
})

test('hunks are bounded at 4 KiB per file and 16 KiB per call, naming what was left out; an unread old file has no hunk', async () => {
  const { repoChangeFacts, REPO_ECHO_LIMITS } = await import('../cloud-brokers.mjs')
  assert.deepEqual({ ...REPO_ECHO_LIMITS }, { contextLines: 3, fileHunkBytes: 4096, callHunkBytes: 16384, hunkFiles: 16, readBudgetMs: 3000, deadlineReserveMs: 8000, readsInFlight: 6 })
  const big = n => Array.from({ length: 400 }, (_v, i) => `row ${n} ${i} ${'x'.repeat(20)}`).join('\n') + '\n'
  const facts = await repoChangeFacts(Array.from({ length: 6 }, (_v, n) => ({ path: `docs/auma/f${n}.md`, before: big(n), after: big(n).toUpperCase() })))
  const sizes = facts.map(fact => Buffer.byteLength(fact.hunk))
  for (const fact of facts) assert.equal(fact.linesAdded, 400)
  assert.ok(sizes.every(bytes => bytes <= 4096), String(sizes))
  assert.ok(sizes.reduce((a, b) => a + b, 0) <= 16384, String(sizes))
  assert.ok(facts.every(fact => fact.hunkOmittedBytes > 0 && fact.hunk.split('\n').slice(0, -1).every(line => /^(---|\+\+\+|@@| |-|\+)/.test(line))))
  assert.equal(facts.at(-1).hunk, '', 'the call budget is spent')
  assert.equal(facts.at(-1).hunkOmittedBytes, sizes[0] + facts[0].hunkOmittedBytes, 'all of it, named')
  const unread = await repoChangeFacts([{ path: 'docs/auma/x.md', before: undefined, after: 'new\n', entry: { sha: 'f'.repeat(40), size: 9 } }])
  assert.deepEqual(unread, [{ path: 'docs/auma/x.md', status: 'modified', oldBlobSha: 'f'.repeat(40), newBlobSha: gitBlob('new\n'), oldBytes: 9, newBytes: 4,
    linesAdded: null, linesRemoved: null, hunk: null, hunkOmittedBytes: null, hunkReason: 'not_read' }])
  const many = await repoChangeFacts(Array.from({ length: 18 }, (_v, n) => ({ path: `docs/auma/m${n}.md`, before: 'a\n', after: 'b\n' })))
  assert.deepEqual(many.map(fact => fact.hunkReason ?? 'hunk'), [...Array(16).fill('hunk'), 'too_many_files', 'too_many_files'])
  assert.deepEqual([many[17].linesAdded, many[17].linesRemoved, many[17].hunk], [1, 1, null])
})
const MANY = Array.from({ length: 64 }, (_v, i) => `docs/auma/many/f${String(i).padStart(2, '0')}.md`)

test('64 files whose old-file reads hang past the deadline: the landed commit answers with its sha and facts for all 64, never unknown', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const files = { ...BASE_FILES, ...Object.fromEntries(MANY.map((path, i) => [path, `old ${i}\n`])) }
    const entered = Promise.withResolvers(), hanging = []
    const broker = fixture({ files, slowRead: (path, init) => {
      if (!MANY.includes(path) || MANY.indexOf(path) < 4) return undefined
      hanging.push(path); if (hanging.length === 6) entered.resolve() // the four quick reads are done: six readers hang
      return new Promise((_resolve, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) })
    } })
    let settled = false
    const pending = broker.request({ action: 'commit', branch: BRANCH, message: 'many files', ownerSession: true, changes: MANY.map((path, i) => ({ path, content: `new ${i}\n` })) })
    void pending.then(() => { settled = true })
    await entered.promise
    context.mock.timers.tick(3000)
    // The answer is built after the read budget ends (hashing, off the event loop), which takes a
    // machine-dependent number of turns. A fixed 100 turns was enough on the Mac and not on GitHub's runner, where this
    // test then fired the deadline itself and failed main's hosted baseline. Wait in real time (the clock is not
    // mocked, only setTimeout); only an answer that never comes meets the deadline below, as on the code before the fix.
    for (const started = performance.now(); !settled && performance.now() - started < 20_000;) await new Promise(resolve => setImmediate(resolve))
    if (!settled) context.mock.timers.tick(27001) // the call's 30 s deadline
    const result = await pending
    assert.equal(result.status, 200, JSON.stringify(result.value).slice(0, 400))
    assert.deepEqual({ ok: result.value.ok, commit: result.value.commit, headSha: result.value.headSha }, { ok: true, commit: NEXT, headSha: NEXT })
    assert.equal(broker.commits.length, 1)
    const changes = result.value.changes
    assert.deepEqual(changes.map(change => change.path), MANY)
    assert.ok(changes.every(change => /^[0-9a-f]{40}$/.test(change.newBlobSha) && change.newBytes > 0 && /^[0-9a-f]{40}$/.test(change.oldBlobSha)))
    assert.deepEqual(changes.map(change => change.hunk === null ? change.hunkReason : 'hunk'),
      [...Array(4).fill('hunk'), ...Array(12).fill('not_read_in_time'), ...Array(48).fill('too_many_files')])
    assert.ok(hanging.length <= 12 && hanging.every(path => MANY.indexOf(path) < 16), 'never a read past the 16 files with hunks')
  } finally { context.mock.timers.reset() }
})

test('a hunk that becomes a secret shape once its markers are in front is withheld; the answer stays a success', async () => {
  const before = 'a\n----BEGIN RSA PRIVATE KEY-----\nb\n'
  const broker = fixture({ files: { ...BASE_FILES, 'docs/auma/notes.md': before } })
  const staged = await broker.request({ action: 'edit', branch: BRANCH, path: 'docs/auma/notes.md', oldString: '----BEGIN RSA PRIVATE KEY-----\n', newString: '', ownerSession: true })
  assert.equal(staged.status, 200, JSON.stringify(staged.value))
  assert.equal(staged.value.content, 'a\nb\n')
  const [change] = staged.value.changes
  assert.deepEqual({ hunk: change.hunk, hunkReason: change.hunkReason, linesRemoved: change.linesRemoved, newBlobSha: change.newBlobSha }, { hunk: null, hunkReason: 'withheld', linesRemoved: 1, newBlobSha: gitBlob('a\nb\n') })
})

test('a failed old-file read still answers the write ok, with the facts from the tree and no hunk', async () => {
  const broker = fixture({ slowRead: path => path === 'docs/auma/a.md' ? new Response('', { status: 500 }) : undefined })
  const staged = await broker.request({ action: 'write', branch: BRANCH, path: 'docs/auma/a.md', content: 'one\n', ownerSession: true })
  assert.equal(staged.status, 200, JSON.stringify(staged.value))
  assert.deepEqual(staged.value.changes, [{ path: 'docs/auma/a.md', status: 'modified', oldBlobSha: blob('one\ntwo\nthree\n'), newBlobSha: gitBlob('one\n'), oldBytes: 14, newBytes: 4,
    linesAdded: null, linesRemoved: null, hunk: null, hunkOmittedBytes: null, hunkReason: 'not_read' }])
  const committed = await broker.request({ action: 'write', branch: BRANCH, path: 'docs/auma/a.md', content: 'one\n', message: 'one line', ownerSession: true })
  assert.deepEqual({ ok: committed.value.ok, headSha: committed.value.headSha, hunkReason: committed.value.changes[0].hunkReason }, { ok: true, headSha: NEXT, hunkReason: 'not_read' })
})
// ---- HANDS block end ----

// ---- Her repo door at level open ----
test('at open: apply_patch changes the edge, her tools, her storage, a server file, adds a workflow and deletes a file; a credential file stays refused', async () => {
  const files = { ...BASE_FILES, 'deploy/cloudflare/src/__tests__/old.test.mjs': 'old\n' }
  const one = '@@ -1 +1 @@\n-export {}\n+export const x = 1\n'
  const gone = 'diff --git a/deploy/cloudflare/src/__tests__/old.test.mjs b/deploy/cloudflare/src/__tests__/old.test.mjs\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/deploy/cloudflare/src/__tests__/old.test.mjs\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n'
  const added = path => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`
  const patch = [modify('deploy/cloudflare/src/cloud-brokers.mjs', one), modify('packages/experimental/webworker-runtime/src/storage/memory.ts', one),
    modify('packages/experimental/webworker-runtime/src/x6/ball-loader.ts', one), modify('server/tool.mjs', one), added('.github/workflows/x.yml'), gone].join('')
  const broker = fixture({ files, level: 'open' }), result = await apply(broker, patch)
  assert.equal(result.status, 200, JSON.stringify(result.value)); assert.equal(broker.commits.length, 1)
  assert.deepEqual(broker.commits[0].fileChanges.deletions, [{ path: 'deploy/cloudflare/src/__tests__/old.test.mjs' }])
  assert.equal(broker.refs.get('main'), MAIN, 'main untouched')
  // A secret-shaped path, and a path that is not plain, are refused before anything is read or written.
  await refusedWith(fixture({ level: 'open' }), added('server/.env'), 'REPO_PATH_REFUSED')
  await refusedWith(fixture({ level: 'open' }), added('deploy/cloudflare/src/owner-key.mjs'), 'REPO_PATH_REFUSED')
  await refusedWith(fixture({ level: 'open' }), added('deploy/cloudflare/src/ſigned-action.mjs'), 'REPO_PATH_NOT_PLAIN')
})
