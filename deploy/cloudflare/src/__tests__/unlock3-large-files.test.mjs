/** Her repo tool reads, searches, edits and patches files up to 2 MiB on her branch (ball-loader.ts is about
 * 614 KB). A file over 512 KiB is read through GitHub's git blob API by its tree sha (the contents API carries no content
 * past 1 MB); the request carries only the edit or the patch, and the answer carries the per-file facts and a bounded
 * hunk, never the file. Fixed synthetic provider state (a fake GitHub that serves contents like the real one: no content
 * for a file over 1 MiB); these tests never call GitHub. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { handleCloudBroker, CLOUD_REPO_LARGE_FILE_LIMITS } from '../cloud-brokers.mjs'

const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const MAIN = 'a'.repeat(40), HEAD = 'b'.repeat(40), NEXT = 'c'.repeat(40), MAIN_TREE = 'd'.repeat(40), HEAD_TREE = 'e'.repeat(40)
const BRANCH = 'auma/sandbox/large-fixture', NOW = 1794367000000, EMAIL = 'owner@fixture.example'
const BOOTSTRAP = { ready: true, head: { phase: 'complete', seedId: '1'.repeat(64) }, mirror: { phase: 'ready' } }
const owner = { type: 'owner', email: EMAIL, expires: NOW / 1000 + 600 }
const gitSha = value => { const bytes = Buffer.from(value); return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex') }
const json = value => Response.json(value)

/** About 700 KB of plain source, one anchor line in the middle, a long line every 997 lines. */
const LINES = Array.from({ length: 14000 }, (_v, i) => i === 7000 ? 'export const ANCHOR_UNLOCK3 = true'
  : i % 997 === 0 ? `// long line ${i} ` + 'é'.repeat(400) : `export const value${i} = ${i} // line ${i + 1} of the large fixture`)
const BIG = LINES.join('\n') + '\n'
const ANCHOR_LINE = 7001
const HUGE = 'x'.repeat(3 * 1024 * 1024) + '\n'

const BASE_FILES = { 'server/big.mjs': BIG, 'server/huge.mjs': HUGE, 'server/small.mjs': 'export {}\n' }

function tree(files, sha) {
  const entries = new Map()
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      entries.set(parent, { path: parent, mode: '040000', type: 'tree', sha: gitSha(parent + sha) })
    }
    entries.set(path, { path, mode: '100644', type: 'blob', sha: gitSha(content), size: Buffer.byteLength(content) })
  }
  return { sha, truncated: false, tree: [...entries.values()] }
}

function fixture({ files = BASE_FILES, level } = {}) {
  const refs = new Map([['main', MAIN], [BRANCH, HEAD]]), commits = [], calls = []
  const bySha = new Map(Object.values(files).map(content => [gitSha(content), content]))
  const env = { GITHUB_TOKEN: 'synthetic-token-value', OWNER_EMAIL: EMAIL, PUBLIC_HOST: 'fixture.example', SOURCE_REVISION: MAIN }
  const networkFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl); calls.push({ path: url.pathname, method: init.method, bytes: init.body ? Buffer.byteLength(init.body) : 0 })
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
    if (url.pathname.startsWith(PREFIX + '/git/blobs/')) {
      const sha = url.pathname.split('/').at(-1), content = bySha.get(sha)
      if (content === undefined) return new Response('', { status: 404 })
      // GitHub wraps blob base64 in lines of 60 characters.
      return json({ sha, node_id: 'B_fixture', size: Buffer.byteLength(content), url: rawUrl, encoding: 'base64', content: Buffer.from(content).toString('base64').replace(/.{60}/g, '$&\n') })
    }
    if (url.pathname.startsWith(PREFIX + '/contents/')) {
      const path = decodeURIComponent(url.pathname.slice((PREFIX + '/contents/').length)), content = files[path]
      if (content === undefined) return new Response('', { status: 404 })
      // As GitHub: a file over 1 MB answers no content (encoding "none").
      if (Buffer.byteLength(content) > 1024 * 1024) return json({ type: 'file', path, sha: gitSha(content), size: Buffer.byteLength(content), encoding: 'none', content: '' })
      return json({ type: 'file', path, sha: gitSha(content), encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    throw new Error('Unexpected synthetic URL ' + url.pathname)
  }
  return {
    commits, calls,
    async request(input) {
      const request = new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(input) })
      const response = await handleCloudBroker(request, env, { access: owner, bootstrap: BOOTSTRAP, now: () => NOW, networkFetch, ...(level ? { repoDoorLevel: level } : {}), authorizeClass3: async () => { assert.fail('asked for a passkey') } })
      const text = await response.text()
      return { status: response.status, bytes: Buffer.byteLength(text), value: JSON.parse(text) }
    },
  }
}

const decode = addition => Buffer.from(addition.contents, 'base64').toString('utf8')

test('the fixture file is over 512 KiB and under 2 MiB, the huge one over 2 MiB', () => {
  assert.ok(Buffer.byteLength(BIG) > 690 * 1000 && Buffer.byteLength(BIG) < 1024 * 1024, String(Buffer.byteLength(BIG)))
  assert.equal(CLOUD_REPO_LARGE_FILE_LIMITS.fileBytes, 2 * 1024 * 1024)
})

test('a two-line anchored insert into a 700 KB file on her branch lands in one commit and answers the hunk only', async () => {
  const broker = fixture()
  const anchor = 'export const ANCHOR_UNLOCK3 = true\n'
  const inserted = anchor + 'export const ADDED_ONE = 1\nexport const ADDED_TWO = 2\n'
  const result = await broker.request({ action: 'edit', branch: BRANCH, path: 'server/big.mjs', oldString: anchor, newString: inserted, message: 'Add two lines', ownerSession: true })
  assert.equal(result.status, 200, JSON.stringify(result.value).slice(0, 400))
  assert.equal(result.value.ok, true); assert.equal(result.value.commit, NEXT)
  assert.equal(broker.commits.length, 1)
  const [addition] = broker.commits[0].fileChanges.additions
  assert.equal(addition.path, 'server/big.mjs')
  assert.equal(decode(addition), BIG.replace(anchor, inserted))
  // The answer: facts and a bounded hunk, never the file.
  assert.ok(result.bytes < 16 * 1024, `answer ${result.bytes} bytes`)
  assert.equal(result.value.content, undefined)
  const [change] = result.value.changes
  assert.equal(change.path, 'server/big.mjs'); assert.equal(change.linesAdded, 2); assert.equal(change.linesRemoved, 0)
  assert.equal(change.oldBytes, Buffer.byteLength(BIG)); assert.equal(change.newBytes, Buffer.byteLength(BIG.replace(anchor, inserted)))
  assert.match(change.hunk, /\+export const ADDED_ONE = 1\n\+export const ADDED_TWO = 2\n/)
  // The file was read through the blob API, never the contents API.
  assert.ok(broker.calls.some(call => call.path.startsWith(PREFIX + '/git/blobs/')))
  assert.equal(broker.calls.some(call => call.path.startsWith(PREFIX + '/contents/')), false)
})

test('an edit without message of a file over 512 KiB is refused by its size, with the one-call way named', async () => {
  const broker = fixture()
  const result = await broker.request({ action: 'edit', branch: BRANCH, path: 'server/big.mjs', oldString: 'export const ANCHOR_UNLOCK3 = true\n', newString: 'export const ANCHOR_UNLOCK3 = false\n', ownerSession: true })
  assert.equal(result.status, 413); assert.equal(result.value.code, 'REPO_FILE_TOO_LARGE')
  assert.equal(result.value.limitBytes, 512 * 1024); assert.match(result.value.next, /message/)
  assert.equal(broker.commits.length, 0)
})

test('apply_patch to the same 700 KB file lands', async () => {
  const broker = fixture()
  const at = ANCHOR_LINE
  const patch = `diff --git a/server/big.mjs b/server/big.mjs\nindex 1111111..2222222 100644\n--- a/server/big.mjs\n+++ b/server/big.mjs\n`
    + `@@ -${at},1 +${at},2 @@\n ${LINES[at - 1]}\n+export const PATCHED = true\n`
  const result = await broker.request({ action: 'apply_patch', branch: BRANCH, baseSha: HEAD, patch, message: 'Patch the large file', ownerSession: true })
  assert.equal(result.status, 200, JSON.stringify(result.value).slice(0, 400))
  assert.equal(result.value.commit, NEXT)
  const expected = LINES.slice(0, at).concat(['export const PATCHED = true'], LINES.slice(at)).join('\n') + '\n'
  assert.equal(decode(broker.commits[0].fileChanges.additions[0]), expected)
  assert.ok(result.bytes < 16 * 1024, `answer ${result.bytes} bytes`)
  assert.equal(result.value.changes[0].linesAdded, 1)
})

test('a search for a string that exists once in the large file finds it at its line, named or under a prefix', async () => {
  const broker = fixture()
  for (const prefix of ['server/big.mjs', 'server']) {
    const result = await broker.request({ action: 'search', branch: BRANCH, query: 'ANCHOR_UNLOCK3', prefix })
    assert.equal(result.status, 200, JSON.stringify(result.value).slice(0, 400))
    assert.deepEqual(result.value.matches.map(match => [match.path, match.line, match.text]), [['server/big.mjs', ANCHOR_LINE, 'export const ANCHOR_UNLOCK3 = true']], prefix)
    // A line after the long multi-byte lines keeps its number too.
    const late = await broker.request({ action: 'search', branch: BRANCH, query: 'line 13001 of the large fixture', prefix })
    assert.deepEqual(late.value.matches.map(match => match.line), [13001])
    // The 3 MiB file is still skipped by its size (only under the directory prefix), never read.
    if (prefix === 'server') assert.deepEqual(result.value.skippedPaths, [{ path: 'server/huge.mjs', reason: 'too_large' }])
  }
  assert.equal(broker.calls.some(call => call.path.endsWith('/huge.mjs')), false)
})

test('a read of the large file returns it byte-identical, whole and across pages', async () => {
  const broker = fixture(), bytes = Buffer.byteLength(BIG)
  const whole = await broker.request({ action: 'read', branch: BRANCH, path: 'server/big.mjs' })
  assert.equal(whole.status, 200, JSON.stringify(whole.value).slice(0, 300))
  assert.equal(whole.value.content, BIG); assert.equal(whole.value.totalBytes, bytes)
  let offset = 0, joined = '', pages = 0
  for (;;) {
    const page = await broker.request({ action: 'read', path: 'server/big.mjs', offset, length: 100003 })
    assert.equal(page.status, 200)
    joined += page.value.content; pages++
    if (page.value.nextOffset === null) break
    offset = page.value.nextOffset
  }
  assert.equal(joined, BIG); assert.ok(pages >= 7)
})

test('a 3 MiB file is refused with the size code on read, edit and apply_patch, and nothing is written', async () => {
  const broker = fixture()
  const read = await broker.request({ action: 'read', branch: BRANCH, path: 'server/huge.mjs' })
  assert.equal(read.status, 413); assert.equal(read.value.code, 'REPO_FILE_TOO_LARGE'); assert.equal(read.value.limitBytes, 2 * 1024 * 1024)
  const edit = await broker.request({ action: 'edit', branch: BRANCH, path: 'server/huge.mjs', oldString: 'xx\n', newString: 'xy\n', message: 'Too big', ownerSession: true })
  assert.equal(edit.value.code, 'REPO_FILE_TOO_LARGE'); assert.equal(edit.value.limitBytes, 2 * 1024 * 1024)
  const patch = `diff --git a/server/huge.mjs b/server/huge.mjs\nindex 1111111..2222222 100644\n--- a/server/huge.mjs\n+++ b/server/huge.mjs\n@@ -1,1 +1,1 @@\n-${'x'.repeat(10)}\n+y\n`
  const patched = await broker.request({ action: 'apply_patch', branch: BRANCH, baseSha: HEAD, patch, message: 'Too big', ownerSession: true })
  assert.equal(patched.value.code, 'REPO_FILE_TOO_LARGE')
  assert.equal(broker.commits.length, 0)
  assert.equal(broker.calls.some(call => call.path.includes('/git/blobs/') || call.path.endsWith('/huge.mjs')), false)
})

test('a full-content write keeps its 512 KiB limit', async () => {
  const broker = fixture()
  const result = await broker.request({ action: 'write', branch: BRANCH, path: 'server/new.mjs', content: 'y'.repeat(512 * 1024 + 1), message: 'Too big', ownerSession: true })
  assert.equal(result.status, 413); assert.equal(result.value.code, 'REPO_FILE_TOO_LARGE'); assert.equal(result.value.limitBytes, 512 * 1024)
  assert.equal(broker.commits.length, 0)
})

test('the refusals stay: a secret-shaped path, main, and a branch that is not hers', async () => {
  const broker = fixture({ level: 'guarded' })
  for (const path of ['server/.env', 'server/private/key.pem', 'server/owner-key.mjs']) {
    const result = await broker.request({ action: 'edit', branch: BRANCH, path, oldString: 'a', newString: 'b', message: 'No', ownerSession: true })
    assert.equal(result.value.ok, false, path); assert.ok([400, 403].includes(result.status), `${path} ${result.status} ${result.value.code}`)
  }
  const main = await broker.request({ action: 'edit', branch: 'main', path: 'server/big.mjs', oldString: 'export const ANCHOR_UNLOCK3 = true\n', newString: 'x\n', message: 'Straight to main', ownerSession: true })
  assert.equal(main.value.ok, false); assert.equal(main.value.code, 'REPO_PROPOSAL_REQUIRED')
  const patchMain = await broker.request({ action: 'apply_patch', branch: 'main', baseSha: MAIN, patch: 'diff --git a/server/small.mjs b/server/small.mjs\n--- a/server/small.mjs\n+++ b/server/small.mjs\n@@ -1 +1 @@\n-export {}\n+export { }\n', message: 'Main', ownerSession: true })
  assert.equal(patchMain.value.code, 'REPO_BRANCH_REFUSED')
  const other = await broker.request({ action: 'edit', branch: 'feature/not-hers', path: 'server/big.mjs', oldString: 'a', newString: 'b', message: 'No', ownerSession: true })
  assert.equal(other.value.ok, false)
  assert.equal(broker.commits.length, 0)
  assert.equal(broker.calls.some(call => call.path === '/graphql'), false)
})
