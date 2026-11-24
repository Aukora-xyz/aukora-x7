/** Every reload of her page runs sync_head_to_github a few seconds after
 * boot, which commits to main; a staged card merges only while main's head is its base, so a reload killed the card.
 * Now, while HEAD holds a staged proposal whose base is main's head, the sync commits nothing and says so. A dead card
 * (base no longer main's head), no card, or a status HEAD cannot answer: the sync runs exactly as before.
 * Synthetic HEAD, MIRROR and GitHub (the shape of head-sync-mirror-copy.test.mjs); no network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { handleCloudBroker } from '../cloud-brokers.mjs'
import { canonicalJson } from '../../../../server/ball-transition.mjs'
import { serializeHead } from '../../../ci/mirror-copy.mjs'

const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const SHA = 'a'.repeat(40), TREE = 'b'.repeat(40), BLOB = 'c'.repeat(40), NEW = 'd'.repeat(40), OLDER = 'e'.repeat(40), PROPOSAL_HEAD = 'f'.repeat(40)
const NOW = 100000
const sha256 = text => createHash('sha256').update(text).digest('hex')
const CODE_A = 'export const organ = "seed-a v2"\n', CODE_OLD = 'export const organ = "seed-a v1"\n'
const A = sha256(CODE_A), OLD = sha256(CODE_OLD)
const module_ = sha => ({ sha256: sha, specifier: `ball:${sha}`, name: 'seed-a', size: 1, createdAt: 1 })

function head({ epoch = 171, entrySha = A } = {}) {
  const body = { version: 'x6.1-ball/v1', parentBallId: null, epoch, createdAt: 1, authorPeerId: 'fixture',
    entries: { 'seed-a': { id: 'seed-a', specifier: `ball:${entrySha}`, config: {}, disabled: false, previousSpecifiers: [`ball:${OLD}`] } },
    modules: { [entrySha]: module_(entrySha), [OLD]: module_(OLD) } }
  return { ...body, ballId: createHash('sha256').update(canonicalJson(body)).digest('hex') }
}

/** `status`: what HEAD's /_head/promotion-status answers ('fail' answers 500). */
function world({ status }) {
  const commits = [], headPaths = [], posts = []
  const ball = head(), codeBySha = { [A]: CODE_A, [OLD]: CODE_OLD }, mainHead = head({ epoch: 170, entrySha: OLD })
  const env = {
    GITHUB_TOKEN: 'synthetic-broker-token-fixture', SOURCE_REVISION: SHA,
    HEAD: { idFromName: name => name, get: () => ({ fetch: async request => {
      const path = new URL(request.url).pathname
      headPaths.push({ path, method: request.method, internal: request.headers.get('x-x6-internal-authorized'), seed: request.headers.get('x-x6-bootstrap-seed') })
      if (path === '/_head/ball') return Response.json({ ok: true, ball, codeBySha })
      if (path === '/_head/telemetry') return Response.json({ ok: true })
      if (path === '/_head/promotion-status') return status === 'fail' ? new Response('', { status: 500 }) : Response.json(status)
      throw new Error('Unexpected HEAD path ' + path)
    } }) },
    MIRROR: { idFromName: name => name, get: () => ({ fetch: async request => {
      const { path } = await request.json()
      const base = { ok: true, path, lineageId: 'lineage', revision: 3 }
      return path === '/dsh/home/auma/HANDOFF.md' ? Response.json({ ...base, kind: 'file', b64: Buffer.from('# handoff\n').toString('base64') }) : Response.json({ ...base, kind: 'missing' })
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
    if (init.method !== 'GET') posts.push(target.pathname)
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
    const request = new Request(ORIGIN + '/_host/repo', { method: 'POST', body: JSON.stringify({ action: 'sync_head_to_github' }),
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } })
    const response = await handleCloudBroker(request, env, { bootstrap: { ready: true, head: { phase: 'complete', seedId: 'synthetic-seed' } },
      access: { type: 'owner', email: 'owner@fixture.example', expires: NOW }, now: () => NOW - 1, networkFetch })
    return { status: response.status, value: await response.json() }
  }
  return { run, commits, posts, headPaths }
}

const staged = baseSha => ({ ok: true, stagedRepoProposal: { schema: 'aukora.staged-repo-proposal.v1', branch: 'auma/proposal/fixture-sync', baseSha, headSha: PROPOSAL_HEAD,
  mergeBody: { action: 'merge_proposal', baseSha, branch: 'auma/proposal/fixture-sync', headSha: PROPOSAL_HEAD, treeSha: TREE } }, repoMergeAttempt: null })

test('a staged card that can still merge (its base is main\'s head): no GitHub write, the deferred answer, nothing changed', async () => {
  const w = world({ status: staged(SHA) })
  const { status, value } = await w.run()
  assert.equal(status, 200, JSON.stringify(value))
  assert.deepEqual(value, { ok: true, action: 'sync_head_to_github', deferred: true, code: 'SYNC_HELD_FOR_STAGED_PROPOSAL', branch: 'main' })
  assert.equal(w.commits.length, 0); assert.deepEqual(w.posts, [], 'zero GitHub writes')
  assert.equal(w.headPaths.some(item => item.path === '/_head/telemetry'), false, 'no HEAD write either')
  const read = w.headPaths.find(item => item.path === '/_head/promotion-status')
  assert.deepEqual(read, { path: '/_head/promotion-status', method: 'GET', internal: '1', seed: 'synthetic-seed' })
})

test('a dead card (its base is no longer main\'s head) does not hold the sync: it commits as before', async () => {
  const w = world({ status: staged(OLDER) })
  const { status, value } = await w.run()
  assert.equal(status, 200, JSON.stringify(value)); assert.equal(value.deferred, undefined); assert.equal(value.upToDate, false); assert.equal(value.commit, NEW)
  assert.equal(w.commits.length, 1); assert.equal(w.commits[0].expectedHeadOid, SHA)
})

test('nothing staged, or a status HEAD cannot answer: the sync commits as before (it is not the place to fail closed)', async () => {
  for (const status of [{ ok: true, stagedRepoProposal: null, repoMergeAttempt: null }, 'fail', { ok: false, code: 'REPO_PROPOSAL_STORAGE_INVALID' }]) {
    const w = world({ status })
    const { status: code, value } = await w.run()
    assert.equal(code, 200, JSON.stringify(value)); assert.equal(value.deferred, undefined, JSON.stringify(status)); assert.equal(value.commit, NEW)
    assert.equal(w.commits.length, 1)
  }
})
