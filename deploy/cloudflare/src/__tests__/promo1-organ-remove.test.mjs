/**
 * The owner removes ONE ordinary organ with one passkey, bound to the exact removal body
 * (`aukora.head-organ-remove.v1`, ORGAN_REMOVE_PATH). Drives the real head-do.mjs through its fetch routes; the passkey
 * store is a stand-in that holds each approval to its exact binding and spends it once, inside HEAD's transaction (a
 * rolled-back transaction leaves it unspent, as the real AUMLOK store does).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { aumlokClass3Binding } from '../aumlok.mjs'
import { canonicalJson, ORGAN_REMOVE_PATH, ORGAN_REMOVE_SCHEMA, ORGAN_SET_PATH } from '../owner-grant-policy.mjs'
import { createWorker } from '../worker.mjs'

const ORIGIN = 'https://organ-remove.example.invalid'
const OWNER = 'owner@example.invalid'
const LEDGER = 'head:id-promotion-budget:ledger:v1'
const MARKER = 'head:id-promotion-budget:initialized:v1'

function storageFixture() {
  let data = new Map(), tail = Promise.resolve()
  const view = map => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(data)[method](...args)]))
  storage.snapshot = () => structuredClone(data)
  storage.transaction = operation => {
    const result = tail.then(async () => { const copy = structuredClone(data); const value = await operation(view(copy)); data = copy; return value })
    tail = result.catch(() => undefined)
    return result
  }
  return storage
}

async function organ(name, variant = '') {
  const code = `export const organ = ${JSON.stringify(name + variant)};`, sha = await digest(code)
  return { code, sha, entry: { id: name, specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] },
    module: { sha256: sha, specifier: `ball:${sha}`, size: code.length } }
}

async function fixture({ options = {} } = {}) {
  const storage = storageFixture()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32) }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env, { networkFetch: async () => { throw new Error('External network forbidden') }, ...options })
  // The head: two ordinary organs (one with rollback history), a fixed governance organ and a declared one.
  const a = await organ('ordinary-a'), b0 = await organ('ordinary-b', ':v0'), b1 = await organ('ordinary-b', ':v1')
  const pearl = await organ('seed-pearl'), judge = await organ('quiet-judge')
  const ball = { version: 'x6.1-ball/v1', epoch: 169, parentBallId: null, authorPeerId: 'fixture-writer', entries: {
    'ordinary-a': a.entry,
    'ordinary-b': { ...b1.entry, previousSpecifiers: [b0.entry.specifier], previousVersions: [{ specifier: b0.entry.specifier, config: {}, disabled: false }], updatedAt: 5 },
    'seed-pearl': pearl.entry,
    'quiet-judge': { ...judge.entry, governance: true },
  }, modules: Object.fromEntries([a, b0, b1, pearl, judge].map(made => [made.sha, made.module])) }
  ball.ballId = await manifestIdCanon(ball)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: Object.fromEntries([a, b0, b1, pearl, judge].map(made => [made.sha, made.code])),
    mirror: { entryCount: 0, batchDigests: [] } })
  assert.equal((await head.store.bootstrapPrepare(seed)).ok, true)
  assert.equal((await head.store.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId,
    ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  // Each approval is held to its exact binding and spent once, in HEAD's transaction.
  const issued = new Map()
  let next = 0
  const approve = async (pathname, body) => {
    const token = `approval-${String(++next)}`
    issued.set(token, await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname, body }))
    return token
  }
  head.aumlokStore = { consumeApprovalInTransaction: async (tx, token, binding) => {
    const held = issued.get(token)
    if (!held || canonicalJson(held) !== canonicalJson(binding) || await tx.get(`fixture:spent:${token}`) !== undefined) {
      throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
    }
    await tx.put(`fixture:spent:${token}`, binding)
    return { ok: true, binding, expiresAt: Date.now() + 60000 }
  } }
  const call = async (path, body, extra = {}, method = body === undefined ? 'GET' : 'POST') => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seed.seedId,
      'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: Date.now() / 1000 + 3600 }), ...extra })
    const response = await head.fetch(new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    return { status: response.status, body: await response.json() }
  }
  const live = async () => { const raw = (await call('/_head/ball')).body; return raw.ball ?? raw }
  /** Build a candidate from the selected head by `edit(next, add)` and stage it. */
  const stage = async (edit, { replaceStaged = false } = {}) => {
    const prev = await live()
    const cand = { ...structuredClone(prev), epoch: prev.epoch + 1, parentBallId: prev.ballId, authorPeerId: 'fixture-writer' }
    delete cand.ballId
    const codeBySha = {}
    const add = async name => { const made = await organ(name); cand.entries[name] = made.entry; cand.modules[made.sha] = made.module; codeBySha[made.sha] = made.code }
    await edit(cand, add)
    cand.ballId = await manifestIdCanon(cand)
    const staged = await call('/_head/stage', { ball: cand, codeBySha, expectedParentBallId: prev.ballId, expectedEpoch: prev.epoch, ...(replaceStaged ? { replaceStaged: true } : {}) })
    assert.equal(staged.status, 200, JSON.stringify(staged.body))
    return { prev, ball: cand, staged: staged.body.staged }
  }
  const promote = (body, token) => call('/_head/promote', body, token === null ? {} : { 'x-x6-class3-approval': token })
  const spent = () => [...storage.snapshot().keys()].filter(key => key.startsWith('fixture:spent:'))
  const headNow = async () => (await call('/_head/status')).body
  return { storage, head, call, live, stage, promote, approve, spent, headNow, ball }
}

const removeOne = id => cand => { delete cand.entries[id] }
const bodyFor = (ball, organId, sha256) => ({ schema: ORGAN_REMOVE_SCHEMA, ballId: ball.ballId, epoch: ball.epoch, parentBallId: ball.parentBallId, organ: { organId, sha256 } })

test('stage then one approval removes exactly the organ: epoch + 1, every other entry and every module byte-identical, the approval spent once', async () => {
  const fx = await fixture()
  const ledgerBefore = await fx.storage.get(LEDGER), markerBefore = await fx.storage.get(MARKER)
  assert.notEqual(ledgerBefore, undefined)
  const { prev, ball, staged } = await fx.stage(removeOne('ordinary-b'))
  assert.equal(staged.organSet, null)
  assert.equal(staged.tier, 'T2')
  assert.deepEqual(staged.organRemove, bodyFor(ball, 'ordinary-b', prev.entries['ordinary-b'].specifier.slice(5)))
  const token = await fx.approve(ORGAN_REMOVE_PATH, staged.organRemove)
  const landed = await fx.promote(staged.organRemove, token)
  assert.equal(landed.status, 200, JSON.stringify(landed.body))
  assert.equal(landed.body.epoch, prev.epoch + 1)
  const after = await fx.live()
  assert.equal(after.ballId, ball.ballId)
  assert.deepEqual(Object.keys(after.entries).sort(), Object.keys(prev.entries).filter(id => id !== 'ordinary-b').sort())
  for (const id of Object.keys(after.entries)) assert.equal(canonicalJson(after.entries[id]), canonicalJson(prev.entries[id]), id)
  assert.equal(canonicalJson(after.modules), canonicalJson(prev.modules))
  assert.deepEqual(fx.spent(), [`fixture:spent:${token}`])
  assert.deepEqual((await fx.storage.get('head:last-publish-outcome')).organRemove, staged.organRemove.organ)
  // A removal is not an id-promotion replacement: the budget is neither read for a charge nor written.
  assert.deepEqual(await fx.storage.get(LEDGER), ledgerBefore)
  assert.deepEqual(await fx.storage.get(MARKER), markerBefore)
  // Presented again: nothing more lands and nothing more is spent.
  const again = await fx.promote(staged.organRemove, token)
  assert.notEqual(again.status, 200)
  assert.equal((await fx.headNow()).ballId, ball.ballId)
  assert.equal(fx.spent().length, 1)
})

test('a plain organ removal lands; an absent budget stays absent (job 1 part C was not built, so a removal initializes nothing)', async () => {
  const fx = await fixture()
  await fx.storage.delete(LEDGER)
  await fx.storage.delete(MARKER)
  const { ball, staged } = await fx.stage(removeOne('ordinary-a'))
  assert.equal((await fx.promote(staged.organRemove, await fx.approve(ORGAN_REMOVE_PATH, staged.organRemove))).status, 200)
  assert.equal((await fx.headNow()).ballId, ball.ballId)
  assert.equal(await fx.storage.get(LEDGER), undefined)
  assert.equal(await fx.storage.get(MARKER), undefined)
})

/** Every refusal: HEAD does not move, nothing is spent, and the stored state is unchanged apart from the lease bookkeeping. */
async function refusedUnspent(fx, response, code) {
  assert.notEqual(response.status, 200, JSON.stringify(response.body))
  if (code) assert.equal(response.body.code, code)
  assert.equal((await fx.headNow()).ballId, fx.ball.ballId)
  assert.deepEqual(fx.spent(), [])
}

test('no approval: refused, unspent', async () => {
  const fx = await fixture()
  const { staged } = await fx.stage(removeOne('ordinary-a'))
  await refusedUnspent(fx, await fx.promote(staged.organRemove, null), 'CLASS3_WEBAUTHN_REQUIRED')
  await refusedUnspent(fx, await fx.promote(staged.organRemove, 'never-issued'), 'CLASS3_WEBAUTHN_REQUIRED')
})

test('an ADD approval presented for a removal is refused and stays unspent (its path is ORGAN_SET_PATH)', async () => {
  const fx = await fixture()
  const { staged } = await fx.stage(removeOne('ordinary-a'))
  // Bound to the organ set's path, over the very same removal body: the binding differs, nothing is spent.
  const token = await fx.approve(ORGAN_SET_PATH, staged.organRemove)
  await refusedUnspent(fx, await fx.promote(staged.organRemove, token), 'CLASS3_WEBAUTHN_REQUIRED')
})

test('a REMOVAL approval presented for an add is refused and stays unspent', async () => {
  const fx = await fixture()
  const { staged } = await fx.stage(async (_cand, add) => { await add('ordinary-new') })
  assert.notEqual(staged.organSet, null)
  assert.equal(staged.organRemove, undefined)
  const token = await fx.approve(ORGAN_REMOVE_PATH, staged.organSet)
  await refusedUnspent(fx, await fx.promote(staged.organSet, token), 'CLASS3_WEBAUTHN_REQUIRED')
  // And a removal body against an add candidate is out of scope before any approval is looked at.
  const forged = bodyFor(fx.ball, 'ordinary-a', 'ab'.repeat(32))
  await refusedUnspent(fx, await fx.promote({ ...forged, ballId: staged.ballId, epoch: staged.epoch, parentBallId: staged.parentBallId },
    await fx.approve(ORGAN_REMOVE_PATH, forged)), 'ORGAN_REMOVE_SCOPE_REFUSED')
})

test('a body whose organ differs from the candidate: refused ORGAN_REMOVE_BODY_MISMATCH, unspent', async () => {
  const fx = await fixture()
  const { ball, staged } = await fx.stage(removeOne('ordinary-a'))
  for (const body of [bodyFor(ball, 'ordinary-b', staged.organRemove.organ.sha256), bodyFor(ball, 'ordinary-a', 'ee'.repeat(32)),
    { ...staged.organRemove, note: 'x' }]) {
    await refusedUnspent(fx, await fx.promote(body, await fx.approve(ORGAN_REMOVE_PATH, body)), 'ORGAN_REMOVE_BODY_MISMATCH')
  }
})

for (const [label, edit, code] of [
  ['a governance organ by id', removeOne('seed-pearl'), 'ORGAN_REMOVE_SCOPE_REFUSED'],
  ['a governance organ by declaration', removeOne('quiet-judge'), 'ORGAN_REMOVE_SCOPE_REFUSED'],
  ['two organs', cand => { delete cand.entries['ordinary-a']; delete cand.entries['ordinary-b'] }, 'ORGAN_REMOVE_SCOPE_REFUSED'],
  ['a removal riding with a config change', cand => { delete cand.entries['ordinary-a']; cand.entries['ordinary-b'] = { ...cand.entries['ordinary-b'], config: { x: 1 } } }, 'ORGAN_REMOVE_SCOPE_REFUSED'],
  ['a removal riding with an add', async (cand, add) => { delete cand.entries['ordinary-a']; await add('ordinary-new') }, 'ORGAN_REMOVE_SCOPE_REFUSED'],
  ['a removal riding with a root field', cand => { delete cand.entries['ordinary-a']; cand.note = 'x' }, 'ORGAN_REMOVE_SCOPE_REFUSED'],
]) {
  test(`${label}: no removal body is recorded, and the one a card would draw is refused unspent`, async () => {
    const fx = await fixture()
    const { prev, ball, staged } = await fx.stage(edit)
    assert.equal(staged.organRemove, undefined)
    const gone = Object.keys(prev.entries).find(id => !Object.hasOwn(ball.entries, id))
    const body = bodyFor(ball, gone, prev.entries[gone].specifier.slice(5))
    await refusedUnspent(fx, await fx.promote(body, await fx.approve(ORGAN_REMOVE_PATH, body)), code)
  })
}

test('a stale parent: once HEAD moved, the staged removal is refused and its approval stays unspent', async () => {
  const fx = await fixture()
  const { staged } = await fx.stage(removeOne('ordinary-a'))
  const token = await fx.approve(ORGAN_REMOVE_PATH, staged.organRemove)
  // Another candidate takes the slot and lands (an add, by its own approval).
  const add = await fx.stage(async (_cand, addOrgan) => { await addOrgan('ordinary-new') }, { replaceStaged: true })
  const addToken = await fx.approve(ORGAN_SET_PATH, add.staged.organSet)
  assert.equal((await fx.promote(add.staged.organSet, addToken)).status, 200)
  const moved = (await fx.headNow()).ballId
  const refused = await fx.promote(staged.organRemove, token)
  assert.notEqual(refused.status, 200)
  assert.equal((await fx.headNow()).ballId, moved)
  assert.deepEqual(fx.spent(), [`fixture:spent:${addToken}`])
})

test('the night-grant route refuses a staged removal and spends nothing; a removal body never rides with the night grant', async () => {
  const fx = await fixture()
  const { ball, staged } = await fx.stage(removeOne('ordinary-a'))
  await refusedUnspent(fx, await fx.call('/_head/night-grant/promote', { ballId: ball.ballId }))
  const token = await fx.approve(ORGAN_REMOVE_PATH, staged.organRemove)
  const direct = await fx.head.store.publish({ ball, expectedParentBallId: fx.ball.ballId, expectedEpoch: fx.ball.epoch },
    { approvalToken: null, audience: ORIGIN, stagedBallId: ball.ballId, nightGrant: true, organRemoveBody: staged.organRemove })
  await refusedUnspent(fx, { status: direct.status, body: direct })
  assert.equal(token.length > 0, true)
})

test('the reader window refuses a removal exactly where it refuses the add (no approval), and nothing is spent', async () => {
  const fx = await fixture()
  const { ball, staged } = await fx.stage(removeOne('ordinary-a'))
  const input = { ball, expectedParentBallId: fx.ball.ballId, expectedEpoch: fx.ball.epoch }
  const removal = await fx.head.store.publish(input, { approvalToken: null, audience: ORIGIN, readerWindow: true, organRemoveBody: staged.organRemove })
  assert.equal(removal.code, 'READER_WINDOW')
  const addFx = await fixture()
  const add = await addFx.stage(async (_cand, addOrgan) => { await addOrgan('ordinary-new') })
  const added = await addFx.head.store.publish({ ball: add.ball, expectedParentBallId: addFx.ball.ballId, expectedEpoch: addFx.ball.epoch },
    { approvalToken: null, audience: ORIGIN, readerWindow: true, organSetBody: add.staged.organSet })
  assert.equal(added.code, 'READER_WINDOW')
  await refusedUnspent(fx, { status: 403, body: removal }, 'READER_WINDOW')
})

test('a Pearl-qualifying deployment never accepts a removal approval', async () => {
  const fx = await fixture({ options: { verifyTransitionQualification: async () => { throw new Error('no qualification in this test') } } })
  const { staged } = await fx.stage(removeOne('ordinary-a'))
  await refusedUnspent(fx, await fx.promote(staged.organRemove, await fx.approve(ORGAN_REMOVE_PATH, staged.organRemove)), 'ORGAN_REMOVE_UNAVAILABLE')
})

test('without a removal body the passkey path for a removal is unchanged: Pearl qualification is still required', async () => {
  const fx = await fixture()
  const { ball } = await fx.stage(removeOne('ordinary-a'))
  await refusedUnspent(fx, await fx.promote({ ballId: ball.ballId }, await fx.approve(ORGAN_REMOVE_PATH, { ballId: ball.ballId })), 'PEARL_QUALIFICATION_UNVERIFIABLE')
})

// ---- the Worker: /_head/promote keeps its guards for a removal body (foreign origin, not the owner) ----
const SEED = 'a'.repeat(64)
test('Worker: a removal body from a foreign origin, cross-site, or not the owner never reaches HEAD', async () => {
  const reached = []
  const answer = (path, request) => {
    if (path === '/_head/bootstrap-status') return { ok: true, phase: 'complete', seedId: SEED, ballId: 'b'.repeat(64), epoch: 169 }
    if (path === '/_mirror/bootstrap-status') return { ok: true, phase: 'ready', seedId: SEED, ballId: 'b'.repeat(64), epoch: 169 }
    reached.push({ path, method: request.method })
    return { ok: true, stub: path }
  }
  const namespace = { idFromName: name => name, get: () => ({ fetch: async request => Response.json(answer(new URL(request.url).pathname, request)) }) }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64), HEAD: namespace, MIRROR: namespace }
  let access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  const worker = createWorker({ verifyAccess: async () => access })
  const body = JSON.stringify(bodyFor({ ballId: 'c'.repeat(64), epoch: 170, parentBallId: 'b'.repeat(64) }, 'ordinary-a', 'd'.repeat(64)))
  const call = headers => worker.fetch(new Request(ORIGIN + '/_head/promote', { method: 'POST', body,
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-x6-class3-approval': 'x', ...headers } }), env)
  for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await call(headers)).status, 403, JSON.stringify(headers))
  }
  access = { type: 'access', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  const notOwner = await call({})
  assert.equal(notOwner.status, 403)
  assert.equal((await notOwner.json()).code, 'OWNER_ACCESS_REQUIRED')
  assert.deepEqual(reached, [])
  access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  assert.equal((await call({})).status, 200)
  assert.deepEqual(reached.map(item => item.path), ['/_head/promote'])
})
