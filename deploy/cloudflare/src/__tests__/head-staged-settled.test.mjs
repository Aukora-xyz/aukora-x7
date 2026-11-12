/**
 * a staged Pearl that already landed must never read as "staged on another head" once HEAD moves past it.
 * Every case goes through HEAD's own routes and store; only the live-shaped case removes the marker this build adds, to
 * stand for the record an older build left behind (live: staged = published Epoch 171, selected = Epoch 172).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest, manifestIdCanon } from '../head-do.mjs'

const ORIGIN = 'https://head.example.invalid'

// Transactions serialize and commit a private snapshot only on success (as head-hardening.test.mjs).
function storageFixture() {
  let data = new Map(), tail = Promise.resolve()
  const view = map => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(data)[method](...args)]))
  storage.transaction = operation => {
    const result = tail.then(async () => {
      const copy = structuredClone(data)
      const result = await operation(view(copy))
      data = copy
      return result
    })
    tail = result.catch(() => {})
    return result
  }
  return storage
}

async function fixture() {
  const storage = storageFixture()
  const env = { PUBLIC_HOST: 'head.example.invalid', OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), OWNER_EMAIL: 'owner@example.invalid', AUMLOK_CUSTODY_PEPPER: '22'.repeat(32) }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  const source = 'export const organ = "seed-echo";\n', sha = await digest(source)
  const draft = { version: 'x6.1-ball/v1', epoch: 170, parentBallId: null, createdAt: '2026-11-12T00:00:00.000Z', authorPeerId: 'fixture-peer',
    entries: { 'seed-echo': { id: 'seed-echo', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(source) } } }
  const genesis = { ...draft, ballId: await manifestIdCanon(draft) }
  const payload = { version: BOOTSTRAP_VERSION, ball: genesis, codeBySha: { [sha]: source }, mirror: { entryCount: 0, batchDigests: [] } }
  const seedId = await digest(canonicalBootstrap(payload))
  assert.equal((await head.store.bootstrapPrepare({ ...payload, seedId })).ok, true)
  assert.equal((await head.store.bootstrapCommit(seedId, { ok: true, phase: 'ready', seedId, ballId: genesis.ballId, epoch: genesis.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  // The owner's passkey approval stands in as consumed: these tests are about the staged record, not the ceremony.
  let approvals = 0
  head.aumlokStore = { consumeApprovalInTransaction: async () => { approvals++; return { ok: true, expiresAt: Date.now() + 60000 } } }
  const call = async (path, body, extra = {}) => {
    const response = await head.fetch(new Request(ORIGIN + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
        'x-x6-verified-access': JSON.stringify({ type: 'owner', email: env.OWNER_EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))
    return { status: response.status, body: await response.json() }
  }
  // The next Pearl on `parent`: one governance organ's code (body-map stands in), so a passkey alone can land it.
  const candidate = async (parent, label) => {
    const code = `export const bodyMap = ${JSON.stringify(label)};\n`, hash = await digest(code)
    const next = { ...parent, epoch: parent.epoch + 1, parentBallId: parent.ballId, createdAt: `2026-11-12T00:${String(parent.epoch - 169).padStart(2, '0')}:00.000Z`,
      entries: { ...parent.entries, 'auma-body-map': { id: 'auma-body-map', specifier: `ball:${hash}`, disabled: false, config: {}, previousSpecifiers: [] } },
      modules: { ...parent.modules, [hash]: { sha256: hash, specifier: `ball:${hash}`, size: Buffer.byteLength(code) } } }
    delete next.ballId
    return { ball: { ...next, ballId: await manifestIdCanon(next) }, codeBySha: { [hash]: code }, expectedParentBallId: parent.ballId, expectedEpoch: parent.epoch }
  }
  // A publish that never went through the staged record (the route her worker or a night run publishes by).
  const publishDirect = async next => {
    const { lease } = await head.store.lease({ action: 'acquire', ownerPeerId: next.ball.authorPeerId })
    const published = await call('/_head/ball', { ...next, writerLease: lease }, { 'x-x6-class3-approval': 'approved' })
    await head.store.lease({ action: 'release', ownerPeerId: lease.ownerPeerId, generation: lease.generation })
    return published
  }
  return { storage, head, call, candidate, publishDirect, genesis, approvals: () => approvals }
}

test('a staged Pearl promoted, then passed by a publish that never touched the record, stays published (the Epoch 171 leftover)', async () => {
  const fx = await fixture()
  const e71 = await fx.candidate(fx.genesis, 'e71')
  assert.equal((await fx.call('/_head/stage', e71)).status, 200)
  const promoted = await fx.call('/_head/promote', { ballId: e71.ball.ballId }, { 'x-x6-class3-approval': 'approved' })
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body))
  // The record stays (an ALREADY_PUBLISHED answer names it) and is marked published in the publish transaction itself.
  assert.equal((await fx.storage.get('head:staged-promotion')).publishedEpoch, 171)
  const e72 = await fx.candidate(e71.ball, 'e72')
  const published = await fx.publishDirect(e72)
  assert.equal(published.status, 200, JSON.stringify(published.body))
  const status = await fx.call('/_head/promotion-status')
  assert.equal(status.body.epoch, 172)
  assert.equal(status.body.staged, null)
  // Before this fix HEAD said 'superseded' here: "staged on another head", read by the page as a proposal to go back.
  assert.deepEqual({ ballId: status.body.supersededStaged.ballId, state: status.body.supersededStaged.state }, { ballId: e71.ball.ballId, state: 'published' })
  // the same answer names HEAD and its ancestors, newest first (the only word the page hides a Pearl on).
  assert.deepEqual(status.body.publishedBallIds, [e72.ball.ballId, e71.ball.ballId, fx.genesis.ballId])
  // A retry of that promotion is told it already landed (the page reads this as landed), and no approval is spent.
  const spent = fx.approvals()
  const retry = await fx.call('/_head/promote', { ballId: e71.ball.ballId }, { 'x-x6-class3-approval': 'approved' })
  assert.equal(retry.status, 409)
  assert.equal(retry.body.code, 'ALREADY_PUBLISHED')
  assert.equal(retry.body.supersededStaged.ballId, e71.ball.ballId)
  assert.equal(fx.approvals(), spent)
})

test('the live-shaped store (staged = published Epoch 171 left unmarked by an older build, selected = 172) is tidied on the next read', async () => {
  const fx = await fixture()
  const e71 = await fx.candidate(fx.genesis, 'e71')
  await fx.call('/_head/stage', e71)
  assert.equal((await fx.call('/_head/promote', { ballId: e71.ball.ballId }, { 'x-x6-class3-approval': 'approved' })).status, 200)
  // An older build never marked the record: take the mark away to stand for the record live holds.
  const { publishedEpoch: _mark, ...unmarked } = await fx.storage.get('head:staged-promotion')
  await fx.storage.put('head:staged-promotion', unmarked)
  const e72 = await fx.candidate(e71.ball, 'e72')
  assert.equal((await fx.publishDirect(e72)).status, 200)
  // Two epochs past it, so HEAD reads its own chain back two steps.
  const e73 = await fx.candidate(e72.ball, 'e73')
  assert.equal((await fx.publishDirect(e73)).status, 200)
  assert.equal((await fx.storage.get('head:staged-promotion')).publishedEpoch, undefined)
  const first = await fx.call('/_head/promotion-status')
  assert.equal(first.body.supersededStaged.state, 'published')
  // Tidied once, by the read itself: the owner does nothing, and the next read needs no chain.
  assert.equal((await fx.storage.get('head:staged-promotion')).publishedEpoch, 171)
  const again = await fx.call('/_head/promotion-status')
  assert.deepEqual(again.body.supersededStaged, first.body.supersededStaged)
  const retry = await fx.call('/_head/promote', { ballId: e71.ball.ballId }, { 'x-x6-class3-approval': 'approved' })
  assert.equal(retry.body.code, 'ALREADY_PUBLISHED')
})

test('a candidate staged on a head that another Pearl replaced is still superseded, and is never marked published', async () => {
  const fx = await fixture()
  const lost = await fx.candidate(fx.genesis, 'lost')
  await fx.call('/_head/stage', lost)
  const lostRecord = await fx.storage.get('head:staged-promotion')
  const won = await fx.candidate(fx.genesis, 'won')
  assert.equal((await fx.call('/_head/stage', { ...won, replaceStaged: true })).status, 200)
  assert.equal((await fx.call('/_head/promote', { ballId: won.ball.ballId }, { 'x-x6-class3-approval': 'approved' })).status, 200)
  // The earlier candidate's record, as a build that kept it would hold it: on the same parent, never landed.
  await fx.storage.put('head:staged-promotion', lostRecord)
  const status = await fx.call('/_head/promotion-status')
  assert.equal(status.body.supersededStaged.state, 'superseded')
  // A fork on the same parent at the same epoch is never in HEAD's published list.
  assert.deepEqual(status.body.publishedBallIds, [won.ball.ballId, fx.genesis.ballId])
  assert.equal(status.body.publishedBallIds.includes(lost.ball.ballId), false)
  assert.equal((await fx.storage.get('head:staged-promotion')).publishedEpoch, undefined)
  const retry = await fx.call('/_head/promote', { ballId: lost.ball.ballId }, { 'x-x6-class3-approval': 'approved' })
  assert.equal(retry.status, 409)
  assert.equal(retry.body.code, 'CANDIDATE_SUPERSEDED')
})

test('a candidate that can land still waits for the same approval on the same bytes', async () => {
  const fx = await fixture()
  const e71 = await fx.candidate(fx.genesis, 'e71')
  await fx.call('/_head/stage', e71)
  assert.equal((await fx.call('/_head/promote', { ballId: e71.ball.ballId }, { 'x-x6-class3-approval': 'approved' })).status, 200)
  const e72 = await fx.candidate(e71.ball, 'e72')
  assert.equal((await fx.call('/_head/stage', e72)).status, 200)
  const status = await fx.call('/_head/promotion-status')
  assert.equal(status.body.staged.ballId, e72.ball.ballId)
  assert.equal(status.body.staged.state, 'awaiting_owner')
  assert.equal(status.body.supersededStaged, null)
  // The waiting candidate is not in the published list; HEAD and its parent are.
  assert.deepEqual(status.body.publishedBallIds, [e71.ball.ballId, fx.genesis.ballId])
  const spent = fx.approvals()
  const none = await fx.call('/_head/promote', { ballId: e72.ball.ballId })
  assert.equal(none.status, 403)
  assert.equal(none.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(fx.approvals(), spent)
  assert.equal((await fx.call('/_head/promotion-status')).body.epoch, 171)
  const landed = await fx.call('/_head/promote', { ballId: e72.ball.ballId }, { 'x-x6-class3-approval': 'approved' })
  assert.equal(landed.status, 200, JSON.stringify(landed.body))
  assert.equal(fx.approvals(), spent + 1)
})

test('promotion-status names HEAD and at most 8 ancestors, read with the staged record, and nothing when nothing is staged', async () => {
  const fx = await fixture()
  // No staged record at all: the list is still HEAD's own chain (here the genesis alone).
  assert.deepEqual((await fx.call('/_head/promotion-status')).body.publishedBallIds, [fx.genesis.ballId])
  let parent = fx.genesis
  const chain = [fx.genesis.ballId]
  for (let step = 0; step < 10; step++) {
    const next = await fx.candidate(parent, `chain-${String(step)}`)
    assert.equal((await fx.publishDirect(next)).status, 200)
    chain.unshift(next.ball.ballId)
    parent = next.ball
  }
  const status = await fx.call('/_head/promotion-status')
  assert.equal(status.body.epoch, 180)
  // HEAD (epoch 180) and exactly 8 ancestors (179..172): nine ids, newest first, the oldest two not named.
  assert.deepEqual(status.body.publishedBallIds, chain.slice(0, 9))
  // An ancestor whose manifest HEAD cannot read ends the list there: shorter, never longer.
  const missing = chain[3]
  for (const key of [...(await fx.storage.list({ prefix: `manifest:${missing}` })).keys()]) await fx.storage.delete(key)
  assert.deepEqual((await fx.call('/_head/promotion-status')).body.publishedBallIds, chain.slice(0, 3))
  // Readers that do not ask (the promote route) get no list.
  assert.equal('publishedBallIds' in await fx.head.store.readStaged(), false)
})

// an ancestor whose content is incomplete (its chunk count kept, a chunk
// gone) ends the walk there; the status read still answers with the staged record and the shorter list, never 503.
const breakChunk = async (storage, ballId) => {
  assert.equal(typeof await storage.get(`manifest:${ballId}:count`), 'number')
  assert.equal(await storage.delete(`manifest:${ballId}:0`), true)
}

test('an old ancestor with a missing chunk: the waiting candidate and the shorter published list are still answered', async () => {
  const fx = await fixture()
  const e71 = await fx.candidate(fx.genesis, 'e71')
  assert.equal((await fx.publishDirect(e71)).status, 200)
  const e72 = await fx.candidate(e71.ball, 'e72')
  assert.equal((await fx.publishDirect(e72)).status, 200)
  const e73 = await fx.candidate(e72.ball, 'e73')
  assert.equal((await fx.call('/_head/stage', e73)).status, 200)
  assert.deepEqual((await fx.call('/_head/promotion-status')).body.publishedBallIds, [e72.ball.ballId, e71.ball.ballId, fx.genesis.ballId])
  // The genesis manifest keeps its chunk count and loses a chunk: incomplete, not missing.
  await breakChunk(fx.storage, fx.genesis.ballId)
  const status = await fx.call('/_head/promotion-status')
  // Before this fix: 503 HEAD_STORAGE_UNAVAILABLE, though HEAD and the waiting candidate are readable.
  assert.equal(status.status, 200, JSON.stringify(status.body))
  assert.equal(status.body.staged.ballId, e73.ball.ballId)
  assert.equal(status.body.staged.state, 'awaiting_owner')
  assert.deepEqual(status.body.publishedBallIds, [e72.ball.ballId, e71.ball.ballId])
})

test('an unmarked old record whose chain crosses an incomplete ancestor is answered (not published, by HEAD\'s word), never 503', async () => {
  const fx = await fixture()
  const e71 = await fx.candidate(fx.genesis, 'e71')
  await fx.call('/_head/stage', e71)
  assert.equal((await fx.call('/_head/promote', { ballId: e71.ball.ballId }, { 'x-x6-class3-approval': 'approved' })).status, 200)
  const { publishedEpoch: _mark, ...unmarked } = await fx.storage.get('head:staged-promotion')
  await fx.storage.put('head:staged-promotion', unmarked)
  const e72 = await fx.candidate(e71.ball, 'e72')
  assert.equal((await fx.publishDirect(e72)).status, 200)
  const e73 = await fx.candidate(e72.ball, 'e73')
  assert.equal((await fx.publishDirect(e73)).status, 200)
  // Epoch 172's manifest is incomplete: neither walk can reach Epoch 171 through it.
  await breakChunk(fx.storage, e72.ball.ballId)
  const status = await fx.call('/_head/promotion-status')
  assert.equal(status.status, 200, JSON.stringify(status.body))
  assert.equal(status.body.staged, null)
  // HEAD cannot read that it is published, so it does not say so (and does not mark it): the shorter answer, not a guess.
  assert.equal(status.body.supersededStaged.ballId, e71.ball.ballId)
  assert.equal(status.body.supersededStaged.state, 'superseded')
  assert.deepEqual(status.body.publishedBallIds, [e73.ball.ballId])
  assert.equal((await fx.storage.get('head:staged-promotion')).publishedEpoch, undefined)
})
