/** KIRA (AURA HANDOFF-3 REQUEST): her receipt ledger travels with the head, only as an append-only extension of main's
 * copy. Synthetic HEAD, MIRROR and GitHub only; no network, credentials or durable state. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { handleCloudBroker, receiptsAppendDecision, gitBlobSha, RECEIPTS_LEDGER_PATH } from '../cloud-brokers.mjs'
import { canonicalJson } from '../../../../server/ball-transition.mjs'

const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const SHA = 'a'.repeat(40), TREE = 'b'.repeat(40), BLOB = 'c'.repeat(40), NEW = 'd'.repeat(40)
const NOW = 100000
// A real self-hashed head: the sync copies only the edge's own verified manifest (deploy/ci/mirror-copy.mjs).
const BALL_BODY = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 170, entries: {}, modules: {} }
const BALL_ID = createHash('sha256').update(canonicalJson(BALL_BODY)).digest('hex')
const ROW = n => JSON.stringify({ seq: n, kind: n > 2 ? 'head.promote' : 'ball.promote', epoch: 166 + n }) + '\n'
const MAIN = ROW(1) + ROW(2)

const B = text => new TextEncoder().encode(text)
const blobSha = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')

test('the append-only rule, on bytes', () => {
  assert.equal(receiptsAppendDecision(B(MAIN), B(MAIN)), 'up-to-date')
  assert.equal(receiptsAppendDecision(B(MAIN + ROW(3) + ROW(4)), B(MAIN)), 'appended')
  assert.equal(receiptsAppendDecision(B(MAIN), null), 'appended')
  assert.equal(receiptsAppendDecision(B(ROW(9) + ROW(2) + ROW(3)), B(MAIN)), 'not-append-only')
  assert.equal(receiptsAppendDecision(B(ROW(1)), B(MAIN)), 'not-append-only')
  assert.equal(receiptsAppendDecision(B(MAIN + '{"seq":3'), B(MAIN)), 'incomplete-row')
  assert.equal(receiptsAppendDecision(B(MAIN.slice(0, -1) + ',"x":1}\n'), B(MAIN.slice(0, -1))), 'not-append-only')
  // A BOM is a byte prefix like any other: dropping it is an edit of main's history.
  assert.equal(receiptsAppendDecision(B(MAIN + ROW(3)), B('\uFEFF' + MAIN)), 'not-append-only')
})

test('the git blob id matches git', async () => {
  assert.equal(await gitBlobSha(B(MAIN)), blobSha(MAIN))
  assert.equal(await gitBlobSha(B('')), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
})

function world({ mirrorLedger, mainLedger, mainContentsStatus = 200, mainServed = mainLedger }) {
  const commits = [], telemetry = []
  const ball = { ...BALL_BODY, ballId: BALL_ID }
  const env = {
    GITHUB_TOKEN: 'synthetic-broker-token-fixture', SOURCE_REVISION: SHA,
    HEAD: { idFromName: name => name, get: () => ({ fetch: async request => {
      const path = new URL(request.url).pathname
      if (path === '/_head/ball') return Response.json({ ok: true, ball, codeBySha: {} })
      if (path === '/_head/telemetry') { telemetry.push(await request.json()); return Response.json({ ok: true }) }
      throw new Error('Unexpected HEAD path ' + path)
    } }) },
    MIRROR: { idFromName: name => name, get: () => ({ fetch: async request => {
      const { path } = await request.json()
      const base = { ok: true, path, lineageId: 'lineage', revision: 3 }
      if (path === '/dsh/home/auma/seed/receipts.v3.jsonl' && mirrorLedger !== undefined) {
        return Response.json({ ...base, kind: 'file', b64: Buffer.from(mirrorLedger).toString('base64') })
      }
      return Response.json({ ...base, kind: 'missing' })
    } }) },
  }
  const paths = ['mirror/home/balls/HEAD.json', ...(mainLedger === null ? [] : [RECEIPTS_LEDGER_PATH])]
  const tree = () => {
    const entries = new Map()
    for (const path of paths) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) entries.set(parts.slice(0, i).join('/'), { path: parts.slice(0, i).join('/'), mode: '040000', type: 'tree', sha: TREE })
      entries.set(path, { path, mode: '100644', type: 'blob', sha: path === RECEIPTS_LEDGER_PATH ? blobSha(mainLedger) : BLOB, size: 10 })
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
      assert.equal(target.search, '?ref=' + SHA)
      if (path === RECEIPTS_LEDGER_PATH && mainContentsStatus !== 200) return new Response('nope', { status: mainContentsStatus })
      const content = path === RECEIPTS_LEDGER_PATH ? mainServed : JSON.stringify({ ballId: 'f'.repeat(64), epoch: 169 })
      // The answer CLAIMS the pinned tree's sha whatever bytes it carries (the truncation case relies on this).
      const sha = path === RECEIPTS_LEDGER_PATH ? blobSha(mainLedger) : BLOB
      return Response.json({ type: 'file', path, sha, encoding: 'base64', content: Buffer.from(content).toString('base64') })
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
  return { run, commits, telemetry }
}
const added = commit => commit.fileChanges.additions.map(item => [item.path, Buffer.from(item.contents, 'base64').toString('utf8')])

test('new rows travel with HEAD.json in ONE commit guarded by expectedHeadOid', async () => {
  const w = world({ mirrorLedger: MAIN + ROW(3) + ROW(4), mainLedger: MAIN })
  const { status, value } = await w.run()
  assert.equal(status, 200)
  assert.equal(value.receiptsSync, 'appended')
  assert.equal(w.commits.length, 1)
  assert.equal(w.commits[0].expectedHeadOid, SHA)
  const files = new Map(added(w.commits[0]))
  assert.equal(files.get(RECEIPTS_LEDGER_PATH), MAIN + ROW(3) + ROW(4))
  assert.ok(files.has('mirror/home/balls/HEAD.json') && files.has('mirror/home/auma/HEAD.json'))
  assert.equal(w.telemetry.at(-1).record.receiptsSync, 'appended')
})

test('a ledger that edits a row main holds is not committed, is reported, and HEAD.json still syncs', async () => {
  const w = world({ mirrorLedger: ROW(1).replace('ball.promote', 'head.promote') + ROW(2) + ROW(3), mainLedger: MAIN })
  const { value } = await w.run()
  assert.equal(value.receiptsSync, 'not-append-only')
  assert.equal(w.commits.length, 1)
  const paths = added(w.commits[0]).map(([path]) => path)
  assert.equal(paths.includes(RECEIPTS_LEDGER_PATH), false)
  assert.ok(paths.includes('mirror/home/balls/HEAD.json'))
  assert.equal(w.telemetry.at(-1).record.receiptsSync, 'not-append-only')
})

test('a main copy that cannot be read is doubt: nothing of the ledger is published', async () => {
  const w = world({ mirrorLedger: MAIN + ROW(3), mainLedger: MAIN, mainContentsStatus: 500 })
  const { value } = await w.run()
  assert.equal(value.receiptsSync, 'unread')
  assert.equal(added(w.commits[0]).some(([path]) => path === RECEIPTS_LEDGER_PATH), false)
})

test('an identical ledger is up to date and adds nothing', async () => {
  const w = world({ mirrorLedger: MAIN, mainLedger: MAIN })
  const { value } = await w.run()
  assert.equal(value.receiptsSync, 'up-to-date')
  assert.equal(added(w.commits[0]).some(([path]) => path === RECEIPTS_LEDGER_PATH), false)
})

// An answer claiming the pinned sha but carrying only row 1 let mirror rows 1,9 replace main's 1,2.
test('a main answer whose bytes do not hash to the pinned blob is unread: nothing of the ledger is published', async () => {
  const w = world({ mirrorLedger: ROW(1) + ROW(9), mainLedger: MAIN, mainServed: ROW(1) })
  const { value } = await w.run()
  assert.equal(value.receiptsSync, 'unread')
  assert.equal(added(w.commits[0]).some(([path]) => path === RECEIPTS_LEDGER_PATH), false)
})

test('a UTF-8 BOM is preserved byte for byte when new rows are published', async () => {
  const w = world({ mirrorLedger: '\uFEFF' + MAIN + ROW(3), mainLedger: '\uFEFF' + MAIN })
  const { value } = await w.run()
  assert.equal(value.receiptsSync, 'appended')
  const published = w.commits[0].fileChanges.additions.find(item => item.path === RECEIPTS_LEDGER_PATH)
  assert.deepEqual([...Buffer.from(published.contents, 'base64')], [...Buffer.from('\uFEFF' + MAIN + ROW(3))])
})

// A failed, truncated or substituted ledger read still reported synced:true.
for (const [label, options] of [
  ['failed', { mainContentsStatus: 500 }],
  ['truncated', { mainServed: ROW(1) }],
  ['substituted', { mainServed: ROW(1).replace('ball.promote', 'head.promot!') + ROW(2) }],
]) {
  test(`a ${label} main read: the head still syncs, the ledger is never written, and the result says exactly that`, async () => {
    const w = world({ mirrorLedger: MAIN + ROW(3), mainLedger: MAIN, ...options })
    const { status, value } = await w.run()
    assert.equal(status, 200)
    assert.equal(value.synced, false)
    assert.equal(value.headSynced, true)
    assert.equal(value.ledgerSynced, false)
    assert.equal(value.ledgerReason, 'unread')
    assert.equal(value.ledgerPath, RECEIPTS_LEDGER_PATH)
    const paths = added(w.commits[0]).map(([path]) => path)
    assert.equal(paths.includes(RECEIPTS_LEDGER_PATH), false)
    assert.ok(paths.includes('mirror/home/balls/HEAD.json'))
    assert.equal(w.telemetry.at(-1).record.ledgerSynced, false)
  })
}

test('a ledger that synced or had nothing to sync reports synced:true with both parts named', async () => {
  const w = world({ mirrorLedger: MAIN + ROW(3), mainLedger: MAIN })
  const { value } = await w.run()
  assert.deepEqual([value.synced, value.headSynced, value.ledgerSynced, value.receiptsSync], [true, true, true, 'appended'])
  assert.equal('ledgerReason' in value, false)
})
