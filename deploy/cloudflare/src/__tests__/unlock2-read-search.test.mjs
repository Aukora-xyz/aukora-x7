/** the repository reads commit 2: `read` pages by UTF-8 bytes and never cuts a line; `search` is bounded and paged instead of timing
 * out. Fixed synthetic provider state (a fake GitHub with trees and contents); these tests never call GitHub. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { handleCloudBroker, CLOUD_REPO_SEARCH_LIMITS, CLOUD_REPO_PROPOSAL_LIMITS } from '../cloud-brokers.mjs'

const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const BRANCH = 'auma/proposal/fixture-read', NOW = 1794367000000, EMAIL = 'owner@fixture.example'
const BOOTSTRAP = { ready: true, head: { phase: 'complete', seedId: '1'.repeat(64) }, mirror: { phase: 'ready' } }
const owner = { type: 'owner', email: EMAIL, expires: NOW / 1000 + 600 }
const HEAD = '4e'.repeat(20), TREE = '5f'.repeat(20)
const sha1 = value => createHash('sha1').update(value).digest('hex')
const json = value => Response.json(value)

/** One commit (HEAD) on both main and her branch; `sizes` overrides a tree entry's size without serving the bytes. */
function fixture(files, { sizes = {}, delayMs = 0 } = {}) {
  const calls = []
  let inFlight = 0, maxInFlight = 0
  const entries = new Map()
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) entries.set(parts.slice(0, i).join('/'), { path: parts.slice(0, i).join('/'), mode: '040000', type: 'tree', sha: sha1('dir:' + parts.slice(0, i).join('/')) })
    entries.set(path, { path, mode: '100644', type: 'blob', sha: sha1(content), size: sizes[path] ?? Buffer.byteLength(content) })
  }
  const env = { GITHUB_TOKEN: 'synthetic-token-value', OWNER_EMAIL: EMAIL, PUBLIC_HOST: 'fixture.example', SOURCE_REVISION: HEAD }
  const networkFetch = async rawUrl => {
    const url = new URL(rawUrl); calls.push(url.pathname)
    if (url.pathname.startsWith(PREFIX + '/commits/')) return json({ sha: HEAD, commit: { tree: { sha: TREE } } })
    if (url.pathname === `${PREFIX}/git/trees/${TREE}`) return json({ sha: TREE, truncated: false, tree: [...entries.values()] })
    if (url.pathname.startsWith(PREFIX + '/contents/')) {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
        const path = decodeURIComponent(url.pathname.slice((PREFIX + '/contents/').length)), content = files[path]
        assert.equal(url.searchParams.get('ref'), HEAD)
        if (content === undefined) return new Response('', { status: 404 })
        return json({ type: 'file', path, sha: sha1(content), encoding: 'base64', content: Buffer.from(content).toString('base64') })
      } finally { inFlight-- }
    }
    throw new Error('Unexpected synthetic URL ' + url.pathname)
  }
  return { calls, get maxInFlight() { return maxInFlight },
    contentReads: () => calls.filter(path => path.startsWith(PREFIX + '/contents/')).length,
    async request(input) {
      const request = new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(input) })
      const response = await handleCloudBroker(request, env, { access: owner, bootstrap: BOOTSTRAP, now: () => NOW, networkFetch })
      return { status: response.status, value: await response.json() }
    },
  }
}

test('a 60 KB file with one 9,000-character line reads back byte-identical, whole and across byte pages', async () => {
  const longLine = 'é😀x'.repeat(3000) // 9,000 characters (UTF-16 units: 12,000), 21,000 bytes, no newline inside
  const body = Array.from({ length: 1400 }, (_, i) => `line ${i} of the fixture source;`).join('\n')
  const content = 'head\n' + longLine + '\n' + body + '\n'
  const bytes = Buffer.byteLength(content)
  assert.ok(bytes > 60 * 1024 && bytes < 100 * 1024)
  const broker = fixture({ 'server/big.mjs': content })
  const whole = await broker.request({ action: 'read', path: 'server/big.mjs' })
  assert.equal(whole.status, 200, JSON.stringify(whole.value).slice(0, 200))
  assert.equal(whole.value.content, content)
  assert.deepEqual([whole.value.offset, whole.value.length, whole.value.totalBytes, whole.value.nextOffset, whole.value.truncated, whole.value.unit], [0, bytes, bytes, null, false, 'bytes'])
  // Pages of 7,001 bytes (odd, so boundaries fall inside the 2- and 4-byte characters of the long line).
  let offset = 0, joined = '', pages = 0
  for (;;) {
    const page = await broker.request({ action: 'read', path: 'server/big.mjs', offset, length: 7001 })
    assert.equal(page.status, 200)
    assert.equal(page.value.offset, offset); assert.equal(page.value.totalBytes, bytes)
    assert.ok(page.value.length <= 7001 && (page.value.nextOffset === null || page.value.length > 7001 - 4))
    assert.equal(Buffer.byteLength(page.value.content), page.value.length)
    assert.equal(page.value.truncated, page.value.nextOffset !== null)
    joined += page.value.content; pages++
    if (page.value.nextOffset === null) break
    offset = page.value.nextOffset
  }
  assert.equal(joined, content); assert.equal(Buffer.byteLength(joined), bytes); assert.ok(pages >= 9)
  // An offset inside a character starts at that character (nothing skipped); a length shorter than one character
  // still returns that whole character.
  const inside = await broker.request({ action: 'read', path: 'server/big.mjs', offset: 5 + 3, length: 1 })
  assert.deepEqual([inside.value.offset, inside.value.content, inside.value.length], [7, '😀', 4])
  assert.equal((await broker.request({ action: 'read', path: 'server/big.mjs', offset: bytes + 1, length: 1 })).value.code, 'REPO_BYTE_RANGE_INVALID')
  const end = await broker.request({ action: 'read', path: 'server/big.mjs', offset: bytes, length: 10 })
  assert.deepEqual([end.value.content, end.value.nextOffset, end.value.truncated], ['', null, false])
})

test('search over 2,000 files answers each page within its bounds, with reads in parallel, and the cursor reaches every match once', async () => {
  const files = {}
  for (let i = 0; i < 2000; i++) files[`server/gen/file-${String(i).padStart(4, '0')}.mjs`] = i % 97 === 0 ? `export const a = 1\n// needle ${i}\n` : 'export const a = 1\n'
  files['server/gen/huge.mjs'] = 'needle huge\n'
  const broker = fixture(files, { sizes: { 'server/gen/huge.mjs': 3 * 1024 * 1024 } /* the large-file reads: files up to 2 MiB are searched now */, delayMs: 1 })
  const first = await broker.request({ action: 'search', branch: BRANCH, query: 'needle', prefix: 'server/gen' })
  assert.equal(first.status, 200, JSON.stringify(first.value).slice(0, 300))
  assert.equal(first.value.truncated, true)
  assert.equal(first.value.filesScanned, CLOUD_REPO_PROPOSAL_LIMITS.searchFiles)
  assert.deepEqual(first.value.next, { path: 'server/gen/file-0128.mjs', line: 0 })
  assert.match(first.value.nextHint, /cursor/)
  assert.ok(broker.maxInFlight > 1 && broker.maxInFlight <= CLOUD_REPO_SEARCH_LIMITS.readsAhead, `in flight ${broker.maxInFlight}`)
  const found = [...first.value.matches.map(match => match.text)]
  let next = first.value.next, pages = 1, skipped = []
  while (next) {
    const page = await broker.request({ action: 'search', branch: BRANCH, query: 'needle', prefix: 'server/gen', cursor: next })
    assert.equal(page.status, 200); assert.ok(page.value.filesScanned <= CLOUD_REPO_PROPOSAL_LIMITS.searchFiles)
    found.push(...page.value.matches.map(match => match.text)); skipped.push(...page.value.skippedPaths)
    next = page.value.next ?? null; pages++
    assert.ok(pages < 30)
  }
  const expected = Object.keys(files).filter(path => path !== 'server/gen/huge.mjs' && files[path].includes('needle')).map(path => files[path].split('\n')[1])
  assert.deepEqual(found, expected)
  // The 3 MiB file (over the 2 MiB search bound, the large-file reads) is skipped by its size and named, never read.
  assert.deepEqual(skipped, [{ path: 'server/gen/huge.mjs', reason: 'too_large' }])
  assert.equal(broker.calls.some(path => path.endsWith('/huge.mjs')), false)
})

test('a match cut by maxMatches continues from that line, never skipped and never repeated', async () => {
  const broker = fixture({ 'server/two.mjs': 'needle one\nplain\nneedle two\n', 'server/three.mjs': 'needle three\n' })
  const first = await broker.request({ action: 'search', branch: BRANCH, query: 'needle', maxMatches: 1 })
  assert.deepEqual(first.value.matches.map(match => [match.path, match.line]), [['server/three.mjs', 1]])
  assert.deepEqual(first.value.next, { path: 'server/two.mjs', line: 0 })
  const second = await broker.request({ action: 'search', branch: BRANCH, query: 'needle', maxMatches: 1, cursor: first.value.next })
  assert.deepEqual(second.value.matches.map(match => [match.path, match.line]), [['server/two.mjs', 1]])
  assert.deepEqual(second.value.next, { path: 'server/two.mjs', line: 2 })
  const third = await broker.request({ action: 'search', branch: BRANCH, query: 'needle', maxMatches: 1, cursor: second.value.next })
  assert.deepEqual(third.value.matches.map(match => [match.path, match.line]), [['server/two.mjs', 3]])
  assert.equal(third.value.next, undefined)
})

test('the screens stay: a secret-shaped path, a bad cursor and a configured secret value are refused', async () => {
  const broker = fixture({ 'server/plain.mjs': 'needle\n', 'server/leak.mjs': 'const value = "synthetic-token-value"\n' })
  for (const path of ['server/.env', 'server/private/key.pem', '../outside.mjs']) {
    const result = await broker.request({ action: 'read', path, offset: 0, length: 10 })
    assert.equal(result.value.ok, false, path); assert.ok([400, 403, 404].includes(result.status), `${path} ${result.status}`)
  }
  for (const cursor of [{ path: 'server/.env', line: 0 }, { path: 'server/plain.mjs', line: -1 }, { path: 'server/plain.mjs' }, { path: 'server/plain.mjs', line: 0, extra: 1 }, 'server/plain.mjs']) {
    assert.equal((await broker.request({ action: 'search', branch: BRANCH, query: 'needle', cursor })).value.code, 'REPO_SEARCH_CURSOR_INVALID', JSON.stringify(cursor))
  }
  assert.equal((await broker.request({ action: 'read', path: 'server/leak.mjs' })).value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  assert.equal((await broker.request({ action: 'read', path: 'server/leak.mjs', offset: 0, length: 5 })).value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  assert.equal((await broker.request({ action: 'search', branch: BRANCH, query: 'needle' })).value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
})
