/** the promotion change edge pin (day 4). The fixed browser path `x6_repo promote_staged` (ball-loader.ts executePromoteStaged)
 * sends three requests to HEAD: a lease acquire, a `reserve-id-promotion` under that lease, then the publish. This file
 * sends those EXACT bodies (shapes copied from the browser source, named below) to a REAL X61HeadDurableObject with
 * production wiring and the passkey-session header, on the frozen epoch-173 parent shared with pubfix-t1-publish.test.mjs,
 * so the browser's request shapes are proven against the real HEAD and not only a stand-in.
 *  - acquire: `{ action: 'acquire', ownerPeerId }` (executePromoteStaged, no ttlMs: HEAD's default 30 s);
 *  - reserve: `{ action, ownerPeerId, generation, expectedBallId, organId, candidateSha }` (id-promotion-budget.ts);
 *  - publish: the staged envelope body spread, then `ball, codeBySha, expectedParentBallId, expectedEpoch, writerLease`
 *    with `writerLease` = `{ ownerPeerId, generation }` (executePromoteStaged `publishPayload`). */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest, manifestIdCanon } from '../head-do.mjs'

const W = new URL('../../../../', import.meta.url).pathname
const ORIGIN = 'https://head.example.invalid'
const sha256 = text => createHash('sha256').update(text).digest('hex')
const TARGET = 'auma-cortex'
const LEDGER = 'head:id-promotion-budget:ledger:v1'
const FIXTURE = W + 'packages/experimental/webworker-runtime/tests/x6/fixtures/frozen-head/'
const HEAD = JSON.parse(readFileSync(FIXTURE + 'HEAD.json', 'utf8'))
const N = HEAD.epoch
const code = sha => {
  const frozen = `${FIXTURE}balls/${sha}.js`
  const text = readFileSync(existsSync(frozen) ? frozen : `${W}mirror/home/balls/${sha}.js`, 'utf8')
  assert.equal(sha256(text), sha, `module ${sha} does not match its sha`)
  return text
}
assert.equal(await manifestIdCanon(HEAD), HEAD.ballId, 'the frozen parent head is not its own canonical manifest')

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
    const result = tail.then(async () => { const copy = structuredClone(data); const out = await operation(view(copy)); data = copy; return out })
    tail = result.catch(() => {})
    return result
  }
  return storage
}

async function productionHead() {
  const env = { PUBLIC_HOST: 'head.example.invalid', OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), OWNER_EMAIL: 'owner@example.invalid', AUMLOK_CUSTODY_PEPPER: '22'.repeat(32) }
  const storage = storageFixture()
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env) // production: no options
  const codeBySha = Object.fromEntries(Object.keys(HEAD.modules).map(sha => [sha, code(sha)]))
  const payload = { version: BOOTSTRAP_VERSION, ball: HEAD, codeBySha, mirror: { entryCount: 0, batchDigests: [] } }
  const seedId = await digest(canonicalBootstrap(payload))
  assert.equal((await head.store.bootstrapPrepare({ ...payload, seedId })).ok, true)
  assert.equal((await head.store.bootstrapCommit(seedId, { ok: true, phase: 'ready', seedId, ballId: HEAD.ballId, epoch: HEAD.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  const call = async (path, body) => {
    const response = await head.fetch(new Request(ORIGIN + path, { method: 'POST', body: JSON.stringify(body), headers: {
      'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      'x-x6-verified-access': JSON.stringify({ type: 'owner', email: env.OWNER_EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 }) } }))
    return { status: response.status, body: await response.json() }
  }
  return { head, call, storage, codeBySha }
}

/** A staged T1 candidate as her staging tools write it: one ordinary organ's module replaced, canonical id. */
function stagedEnvelopeBody(peerId) {
  const prevEntry = HEAD.entries[TARGET]
  const source = code(prevEntry.specifier.slice(5)) + '\n// promo1 staged fix\n'
  const sha = sha256(source), specifier = `ball:${sha}`
  const entries = { ...HEAD.entries, [TARGET]: { ...prevEntry, specifier,
    previousSpecifiers: [...prevEntry.previousSpecifiers, prevEntry.specifier], updatedAt: Date.now() } }
  const modules = { ...HEAD.modules, [sha]: { sha256: sha, specifier, name: TARGET, description: `Cordis ball plugin ${TARGET}`, size: Buffer.byteLength(source), createdAt: Date.now() } }
  const body = { version: 'x6.1-ball/v1', parentBallId: HEAD.ballId, epoch: HEAD.epoch + 1, createdAt: Date.now(), authorPeerId: peerId, entries, modules }
  const ball = { ...body, ballId: sha256(canonicalBootstrap(body)) }
  return { body: { ball, codeBySha: { [sha]: source }, expectedParentBallId: HEAD.ballId, expectedEpoch: HEAD.epoch }, sha, source }
}

test('real HEAD: acquire, reserve-id-promotion, then /_head/ball with the browser bodies publishes T1 at epoch N + 1 and stamps the charged row', async () => {
  const { head, call, storage, codeBySha } = await productionHead()
  const peerId = 'auma-peer'
  const staged = stagedEnvelopeBody(peerId)
  const ball = staged.body.ball
  const lease = await call('/_head/lease', { action: 'acquire', ownerPeerId: peerId })
  assert.equal(lease.status, 200, JSON.stringify(lease.body))
  const heldLease = lease.body.lease
  const before = await storage.get(LEDGER)
  assert.deepEqual(before.reservations, [])
  const reserve = await call('/_head/lease', { action: 'reserve-id-promotion', ownerPeerId: heldLease.ownerPeerId,
    generation: heldLease.generation, expectedBallId: ball.parentBallId, organId: TARGET, candidateSha: staged.sha })
  assert.equal(reserve.status, 200, JSON.stringify(reserve.body))
  assert.equal(reserve.body.ok, true)
  assert.equal(reserve.body.used, 1)
  assert.equal(reserve.body.limit, 12)
  assert.equal(reserve.body.idempotent, false)
  const publishPayload = { ...staged.body, ball, codeBySha: { ...codeBySha, [staged.sha]: staged.source },
    expectedParentBallId: ball.parentBallId, expectedEpoch: ball.epoch - 1,
    writerLease: { ownerPeerId: heldLease.ownerPeerId, generation: heldLease.generation } }
  const published = await call('/_head/ball', publishPayload)
  assert.equal(published.status, 200, JSON.stringify(published.body))
  assert.equal(published.body.ok, true)
  assert.equal(published.body.tier, 'T1')
  assert.equal(published.body.epoch, N + 1)
  assert.equal(published.body.ballId, ball.ballId)
  assert.equal((await head.store.read()).ball.ballId, ball.ballId)
  const after = await storage.get(LEDGER)
  assert.equal(after.reservations.length, 1)
  const [row] = after.reservations
  assert.equal(row.operationId, reserve.body.operationId)
  assert.equal(row.expectedBallId, HEAD.ballId)
  assert.equal(row.organId, TARGET)
  assert.equal(row.candidateSha, staged.sha)
  assert.ok(Number.isSafeInteger(row.publishedAt) && row.publishedAt >= row.reservedAt, JSON.stringify(row))
  const released = await call('/_head/lease', { action: 'release', ownerPeerId: heldLease.ownerPeerId, generation: heldLease.generation })
  assert.equal(released.body.ok, true)
})

test('real HEAD: the same publish body without the reservation is still refused ID_PROMOTION_RESERVATION_REQUIRED (the rule stays)', async () => {
  const { head, call, codeBySha } = await productionHead()
  const staged = stagedEnvelopeBody('auma-peer')
  const ball = staged.body.ball
  const lease = (await call('/_head/lease', { action: 'acquire', ownerPeerId: 'auma-peer' })).body.lease
  const published = await call('/_head/ball', { ...staged.body, ball, codeBySha: { ...codeBySha, [staged.sha]: staged.source },
    expectedParentBallId: ball.parentBallId, expectedEpoch: ball.epoch - 1, writerLease: { ownerPeerId: lease.ownerPeerId, generation: lease.generation } })
  assert.equal(published.status, 403)
  assert.equal(published.body.code, 'ID_PROMOTION_RESERVATION_REQUIRED')
  assert.equal((await head.store.read()).ball.ballId, HEAD.ballId)
})
