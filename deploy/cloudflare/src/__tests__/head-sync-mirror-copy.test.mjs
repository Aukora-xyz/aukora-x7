/** sync_head_to_github commits to main with no passkey, so it may carry ONLY a verified copy of what the
 * edge HEAD already judged (deploy/ci/mirror-copy.mjs). Synthetic HEAD, MIRROR and GitHub only; no network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { handleCloudBroker } from '../cloud-brokers.mjs'
import { canonicalJson } from '../../../../server/ball-transition.mjs'
import { mirrorCopyRefusals, serializeHead } from '../../../ci/mirror-copy.mjs'

const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const SHA = 'a'.repeat(40), TREE = 'b'.repeat(40), BLOB = 'c'.repeat(40), NEW = 'd'.repeat(40)
const NOW = 100000
const sha256 = text => createHash('sha256').update(text).digest('hex')
const CODE_A = 'export const organ = "seed-a v2"\n', CODE_OLD = 'export const organ = "seed-a v1"\n', CODE_UNREFERENCED = 'export const injected = "not judged by any head"\n'
const CANDIDATE = 'export const pearl = "staged, never promoted"\n'
const A = sha256(CODE_A), OLD = sha256(CODE_OLD), STRAY = sha256(CODE_UNREFERENCED)
const module_ = sha => ({ sha256: sha, specifier: `ball:${sha}`, name: 'seed-a', size: 1, createdAt: 1 })

function head({ epoch = 171, entrySha = A, tamper = false } = {}) {
  const body = { version: 'x6.1-ball/v1', parentBallId: null, epoch, createdAt: 1, authorPeerId: 'fixture',
    entries: { 'seed-a': { id: 'seed-a', specifier: `ball:${entrySha}`, config: {}, disabled: false, previousSpecifiers: [`ball:${OLD}`] } },
    modules: { [entrySha]: module_(entrySha), [OLD]: module_(OLD) } }
  const ballId = createHash('sha256').update(canonicalJson(body)).digest('hex')
  return { ...body, ballId: tamper ? 'f'.repeat(64) : ballId }
}

function world({ ball = head(), codeBySha = { [A]: CODE_A, [OLD]: CODE_OLD, [STRAY]: CODE_UNREFERENCED }, handoffMarkdown } = {}) {
  const commits = []
  const mainHead = head({ epoch: 170, entrySha: OLD })
  const env = {
    GITHUB_TOKEN: 'synthetic-broker-token-fixture', SOURCE_REVISION: SHA,
    HEAD: { idFromName: name => name, get: () => ({ fetch: async request => {
      const path = new URL(request.url).pathname
      if (path === '/_head/ball') return Response.json({ ok: true, ball, codeBySha })
      if (path === '/_head/telemetry') return Response.json({ ok: true })
      throw new Error('Unexpected HEAD path ' + path)
    } }) },
    MIRROR: { idFromName: name => name, get: () => ({ fetch: async request => {
      const { path } = await request.json()
      const base = { ok: true, path, lineageId: 'lineage', revision: 3 }
      const files = { '/dsh/home/auma/seed/staging/seed-pearl.js': CANDIDATE, '/dsh/home/auma/seed/organs/seed-pearl.js': CANDIDATE, '/dsh/home/auma/HANDOFF.md': '# handoff\n' }
      return Object.hasOwn(files, path) ? Response.json({ ...base, kind: 'file', b64: Buffer.from(files[path]).toString('base64') }) : Response.json({ ...base, kind: 'missing' })
    } }) },
  }
  const paths = ['mirror/home/balls/HEAD.json', 'mirror/home/auma/HEAD.json', `mirror/home/balls/${OLD}.js`, 'mirror/home/auma/seed/organs/seed-a.js']
  const tree = () => {
    const entries = new Map()
    for (const path of paths) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) entries.set(parts.slice(0, i).join('/'), { path: parts.slice(0, i).join('/'), mode: '040000', type: 'tree', sha: TREE })
      entries.set(path, { path, mode: '100644', type: 'blob', sha: BLOB, size: 10 })
    }
    return { sha: TREE, truncated: false, tree: [...entries.values()] }
  }
  const networkFetch = async (url, init) => {
    const target = new URL(url)
    assert.equal(target.hostname, 'api.github.com')
    if (target.pathname === '/graphql') {
      commits.push(JSON.parse(init.body).variables.input)
      return Response.json({ data: { createCommitOnBranch: { commit: { oid: NEW } } } })
    }
    if (target.pathname === PREFIX + '/commits' && target.search === '?sha=main&per_page=1') return Response.json([{ sha: SHA, commit: { message: 'Base' }, parents: [] }])
    if (target.pathname === PREFIX + '/commits/' + SHA) return Response.json({ sha: SHA, commit: { message: 'Base', tree: { sha: TREE } } })
    if (target.pathname === PREFIX + '/git/trees/' + TREE) return Response.json(tree())
    if (target.pathname.startsWith(PREFIX + '/contents/')) {
      const path = decodeURIComponent(target.pathname.slice((PREFIX + '/contents/').length))
      const content = path === 'mirror/home/balls/HEAD.json' ? serializeHead(mainHead) : '# old handoff\n'
      return Response.json({ type: 'file', path, sha: BLOB, encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    throw new Error('Unexpected GitHub URL ' + url)
  }
  const run = async () => {
    const request = new Request(ORIGIN + '/_host/repo', { method: 'POST', body: JSON.stringify({ action: 'sync_head_to_github', ...(handoffMarkdown === undefined ? {} : { handoffMarkdown }) }),
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } })
    const response = await handleCloudBroker(request, env, { bootstrap: { ready: true, head: { phase: 'complete', seedId: 'synthetic-seed' } },
      access: { type: 'owner', email: 'owner@fixture.example', expires: NOW }, now: () => NOW - 1, networkFetch })
    return { status: response.status, value: await response.json() }
  }
  return { run, commits, ball }
}
const added = commit => commit.fileChanges.additions.map(item => ({ path: item.path, bytes: new Uint8Array(Buffer.from(item.contents, 'base64')) }))

test('a sync commits only verified copies of the judged head: no unreferenced module, no staged candidate', async () => {
  const w = world()
  const { status, value } = await w.run()
  assert.equal(status, 200, JSON.stringify(value))
  assert.equal(w.commits.length, 1)
  const files = added(w.commits[0])
  assert.deepEqual(files.map(file => file.path).sort(), [
    'mirror/home/auma/HANDOFF.md', 'mirror/home/auma/HEAD.json', 'mirror/home/auma/seed/organs/seed-a.js', `mirror/home/balls/${A}.js`, 'mirror/home/balls/HEAD.json',
  ].sort())
  // Every byte on its way to main passes the same rule CI re-checks from the repository alone.
  assert.deepEqual(await mirrorCopyRefusals(files, w.ball), [])
  const text = files.map(file => Buffer.from(file.bytes).toString('utf8')).join('\n')
  assert.equal(text.includes(CODE_UNREFERENCED), false, 'a module the head does not reference never reaches main')
  assert.equal(text.includes(CANDIDATE), false, 'a staged candidate is not a copy of anything judged')
  assert.equal(files.some(file => file.path === `mirror/home/balls/${STRAY}.js` || file.path === `mirror/home/balls/${sha256(CANDIDATE)}.js`), false)
  assert.equal(Buffer.from(files.find(file => file.path === 'mirror/home/balls/HEAD.json').bytes).toString('utf8'), serializeHead(w.ball))
  assert.equal(Buffer.from(files.find(file => file.path === 'mirror/home/auma/seed/organs/seed-a.js').bytes).toString('utf8'), CODE_A)
  assert.equal(value.skippedUnreferencedModules, 1)
})

test('a head that is not its own hash is refused whole: nothing reaches main', async () => {
  const w = world({ ball: head({ tamper: true }) })
  const { status, value } = await w.run()
  assert.equal(status, 502)
  assert.equal(value.code, 'HEAD_STATE_INVALID')
  assert.equal(w.commits.length, 0)
})

test('a referenced module whose bytes do not hash to its name is refused whole: nothing reaches main', async () => {
  const w = world({ codeBySha: { [A]: CODE_A.replace('v2', 'v2 // altered'), [OLD]: CODE_OLD } })
  const { status, value } = await w.run()
  assert.equal(status, 502)
  assert.equal(value.code, 'HEAD_SYNC_MODULE_HASH_MISMATCH')
  assert.equal(w.commits.length, 0)
})

test('the rule itself: only head copies, hash-named referenced modules, selected organ copies and the two records', async () => {
  const ball = head()
  const ok = [
    { path: 'mirror/home/balls/HEAD.json', bytes: serializeHead(ball) }, { path: 'mirror/home/auma/HEAD.json', bytes: serializeHead(ball) },
    { path: `mirror/home/balls/${A}.js`, bytes: CODE_A }, { path: `mirror/home/balls/${OLD}.js`, bytes: CODE_OLD },
    { path: 'mirror/home/auma/seed/organs/seed-a.js', bytes: CODE_A },
    { path: 'mirror/home/auma/HANDOFF.md', bytes: '# notes\n' }, { path: 'mirror/home/auma/seed/receipts.v3.jsonl', bytes: '{"seq":1}\n' },
  ]
  assert.deepEqual(await mirrorCopyRefusals(ok, ball), [])
  const reasons = async file => (await mirrorCopyRefusals([file], ball)).map(item => item.reason)
  assert.deepEqual(await reasons({ path: 'mirror/home/balls/HEAD.json', bytes: JSON.stringify(ball) }), ['HEAD_NOT_THE_SYNCED_HEAD'])
  assert.deepEqual(await reasons({ path: 'mirror/home/auma/HEAD.json', bytes: serializeHead(head({ epoch: 99 })) }), ['HEAD_NOT_THE_SYNCED_HEAD'])
  assert.deepEqual(await reasons({ path: `mirror/home/balls/${A}.js`, bytes: CODE_OLD }), ['MODULE_NAME_NOT_ITS_HASH'])
  assert.deepEqual(await reasons({ path: `mirror/home/balls/${STRAY}.js`, bytes: CODE_UNREFERENCED }), ['MODULE_NOT_REFERENCED_BY_HEAD'])
  assert.deepEqual(await reasons({ path: 'mirror/home/auma/seed/organs/seed-a.js', bytes: CODE_OLD }), ['ORGAN_NOT_THE_SELECTED_MODULE'])
  assert.deepEqual(await reasons({ path: 'mirror/home/auma/seed/organs/seed-b.js', bytes: CODE_A }), ['ORGAN_NOT_SELECTED_BY_HEAD'])
  for (const path of ['mirror/home/auma/seed/candidates/seed-a.js', 'mirror/home/auma/COVENANT.md', 'mirror/home/auma/seed/scars.jsonl',
    'mirror/home/auma/seed/pearl/retention-suite.v1.json', 'packages/client/web/src/main.ts', 'deploy/cloudflare/src/worker.mjs', `mirror/home/balls/${A}.meta.json`]) {
    assert.deepEqual(await reasons({ path, bytes: CODE_A }), ['PATH_OUTSIDE_MIRROR_COPY_RULE'], path)
  }
  assert.deepEqual((await mirrorCopyRefusals(ok, head({ tamper: true }))).map(item => item.reason), ok.map(() => 'HEAD_MANIFEST_HASH_MISMATCH'))
})
