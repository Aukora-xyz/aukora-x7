/** Organ set: one owner passkey adds one or several ordinary organs, bound to the exact list; governance stays one per approval. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { canonicalJson, classifyHeadTransition, organAdditionSet } from '../owner-grant-policy.mjs'

const ORIGIN = 'https://organ-set.example.invalid'
const OWNER = 'owner@example.invalid'
const APPROVAL = { 'x-x6-class3-approval': 'fixture-approval' }

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
    const result = tail.then(async () => {
      const copy = structuredClone(data)
      const value = await operation(view(copy))
      data = copy
      return value
    })
    tail = result.catch(() => undefined)
    return result
  }
  return storage
}

async function organ(name) {
  const code = `export const organ = ${JSON.stringify(name)};`, sha = await digest(code)
  return { code, sha, entry: { id: name, specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] },
    module: { sha256: sha, specifier: `ball:${sha}`, size: code.length } }
}

async function fixture({ env: extraEnv = {}, options = {} } = {}) {
  const storage = storageFixture()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), ...extraEnv }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env, { networkFetch: async () => { throw new Error('External network forbidden') }, ...options })
  const base = await organ('ordinary-a')
  const ball = { version: 'x6.1-ball/v1', epoch: 169, parentBallId: null, authorPeerId: 'fixture-writer',
    entries: { 'ordinary-a': base.entry }, modules: { [base.sha]: base.module } }
  ball.ballId = await manifestIdCanon(ball)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [base.sha]: base.code }, mirror: { entryCount: 0, batchDigests: [] } })
  assert.equal((await head.store.bootstrapPrepare(seed)).ok, true)
  assert.equal((await head.store.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId,
    ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  const approvals = []
  head.aumlokStore = { consumeApprovalInTransaction: async (tx, token, binding) => {
    if (token !== 'fixture-approval') throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
    approvals.push(binding)
    await tx.put(`fixture:approval:${approvals.length}`, binding)
    return { ok: true, binding, expiresAt: Date.now() + 60000 }
  } }
  const call = async (path, body, extra = {}, method = body === undefined ? 'GET' : 'POST') => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seed.seedId,
      'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: Date.now() / 1000 + 3600 }), ...extra })
    const response = await head.fetch(new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    return { status: response.status, body: await response.json() }
  }
  /** Stage a candidate built from the selected head by `edit(next, add)`. */
  const stage = async edit => {
    const raw = (await call('/_head/ball')).body
    const prev = raw.ball ?? raw
    const next = { ...structuredClone(prev), epoch: prev.epoch + 1, parentBallId: prev.ballId, authorPeerId: 'fixture-writer' }
    delete next.ballId
    const codeBySha = {}
    const add = async (name, extra = {}) => {
      const made = await organ(name)
      next.entries[name] = { ...made.entry, ...extra }
      next.modules[made.sha] = made.module
      codeBySha[made.sha] = made.code
      return made
    }
    await edit(next, add)
    next.ballId = await manifestIdCanon(next)
    const staged = await call('/_head/stage', { ball: next, codeBySha, expectedParentBallId: prev.ballId, expectedEpoch: prev.epoch })
    assert.equal(staged.status, 200, JSON.stringify(staged.body))
    return { ball: next, staged: staged.body.staged }
  }
  const promote = (body, extra = APPROVAL) => call('/_head/promote', body, extra)
  const headNow = async () => (await call('/_head/status')).body
  return { storage, head, call, stage, promote, approvals, ball, headNow }
}

const plainAdds = names => async (_next, add) => { for (const name of names) await add(name) }

test('one passkey adds three ordinary organs; the approval binds the exact list and the organs stay ordinary', async () => {
  const fx = await fixture()
  const { ball, staged } = await fx.stage(plainAdds(['voice-slot', 'repo-forge', 'auma-cortex']))
  assert.equal(staged.governanceClass, 1)
  assert.deepEqual(staged.organSet.organs.map(organ => organ.organId), ['auma-cortex', 'repo-forge', 'voice-slot'])
  assert.ok(staged.organSet.organs.every(organ => /^[0-9a-f]{64}$/.test(organ.sha256) && organ.bytes > 0))
  assert.equal(staged.organSet.ballId, ball.ballId)
  const landed = await fx.promote(staged.organSet)
  assert.equal(landed.status, 200, JSON.stringify(landed.body))
  assert.equal((await fx.headNow()).ballId, ball.ballId)
  assert.equal(fx.approvals.length, 1)
  assert.deepEqual(fx.approvals[0], { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_head/promote',
    bodySha256: await digest(canonicalJson(staged.organSet)) })
  assert.deepEqual((await fx.storage.get('head:last-publish-outcome')).organSet, staged.organSet.organs)
  // Part (a): the added organ is not governance, so its later code update is an ordinary change.
  const next = structuredClone(ball)
  next.entries['voice-slot'] = { ...next.entries['voice-slot'], specifier: 'ball:' + 'cd'.repeat(32) }
  assert.equal(classifyHeadTransition(ball, next).class, 1)
})

test('a single plain add is offered and lands without declaring governance', async () => {
  const fx = await fixture()
  const { ball, staged } = await fx.stage(plainAdds(['repo-forge']))
  assert.equal(staged.organSet.organs.length, 1)
  assert.equal((await fx.promote(staged.organSet)).status, 200)
  assert.equal((await fx.headNow()).ballId, ball.ballId)
  const live = (await fx.call('/_head/ball')).body
  const entry = (live.ball ?? live).entries['repo-forge']
  assert.equal(Object.hasOwn(entry, 'governance'), false)
  assert.deepEqual(entry.config, {})
})

test('the passkey path without an organ-set body is unchanged for an ordinary add', async () => {
  const fx = await fixture()
  const { ball } = await fx.stage(plainAdds(['repo-forge']))
  const refused = await fx.promote({ ballId: ball.ballId })
  assert.equal(refused.body.code, 'PEARL_QUALIFICATION_UNVERIFIABLE')
  assert.equal(fx.approvals.length, 0)
})

const mutate = (body, change) => { const copy = structuredClone(body); change(copy); return copy }
for (const [label, edit, bodyOf, code] of [
  ['an organ left off the approved list', plainAdds(['a-one', 'a-two']), body => mutate(body, b => { b.organs.pop() }), 'ORGAN_SET_BODY_MISMATCH'],
  ['a wrong byte count', plainAdds(['a-one']), body => mutate(body, b => { b.organs[0].bytes += 1 }), 'ORGAN_SET_BODY_MISMATCH'],
  ['a wrong module sha', plainAdds(['a-one']), body => mutate(body, b => { b.organs[0].sha256 = 'ee'.repeat(32) }), 'ORGAN_SET_BODY_MISMATCH'],
  ['an extra field', plainAdds(['a-one']), body => ({ ...body, note: 'x' }), 'ORGAN_SET_BODY_MISMATCH'],
  ['a governance organ', plainAdds(['grant-ledger']), null, 'ORGAN_SET_SCOPE_REFUSED'],
  ['a governance declaration', async (_n, add) => { await add('quiet-judge', { governance: true }) }, null, 'ORGAN_SET_SCOPE_REFUSED'],
  ['a governance declaration in config', async (_n, add) => { await add('quiet-judge', { config: { governance: 1 } }) }, null, 'ORGAN_SET_SCOPE_REFUSED'],
  ['an add riding with an update', async (next, add) => { await add('a-one'); next.entries['ordinary-a'] = { ...next.entries['ordinary-a'], config: { x: 1 } } }, null, 'ORGAN_SET_SCOPE_REFUSED'],
  ['an add riding with a removal', async (next, add) => { await add('a-one'); delete next.entries['ordinary-a'] }, null, 'ORGAN_SET_SCOPE_REFUSED'],
  ['a disabled add', async (_n, add) => { await add('a-one', { disabled: true }) }, null, 'ORGAN_SET_SCOPE_REFUSED'],
  ['nine adds', plainAdds(Array.from({ length: 9 }, (_, i) => `organ-${i}`)), null, 'ORGAN_SET_SCOPE_REFUSED'],
  ['an add carrying its own rollback history', async (next, add) => {
    const made = await add('a-one')
    next.entries['a-one'] = { ...made.entry, previousSpecifiers: [next.entries['ordinary-a'].specifier] }
  }, null, 'ORGAN_SET_SCOPE_REFUSED'],
  ['an add with settings', async (_n, add) => { await add('a-one', { config: { mode: 'wide' } }) }, null, 'ORGAN_SET_SCOPE_REFUSED'],
]) {
  test(`organ set refuses ${label} and spends no approval`, async () => {
    const fx = await fixture()
    const { ball, staged } = await fx.stage(edit)
    const before = (await fx.headNow()).ballId
    const ids = Object.keys(ball.entries).filter(id => id !== 'ordinary-a').sort()
    const derived = { schema: 'aukora.head-organ-set.v1', ballId: ball.ballId, epoch: ball.epoch, parentBallId: ball.parentBallId,
      organs: ids.map(organId => ({ organId, sha256: ball.entries[organId].specifier.slice(5), bytes: 1 })) }
    const body = bodyOf === null ? (staged.organSet ?? derived) : bodyOf(staged.organSet)
    if (bodyOf === null) assert.equal(staged.organSet, null)
    const refused = await fx.promote(body)
    assert.equal(refused.body.code, code)
    assert.equal(fx.approvals.length, 0)
    assert.equal((await fx.headNow()).ballId, before)
  })
}

test('no passkey, or a refused passkey, lands nothing', async () => {
  for (const headers of [{}, { 'x-x6-class3-approval': 'forged' }]) {
    const fx = await fixture()
    const { staged } = await fx.stage(plainAdds(['a-one']))
    const before = (await fx.headNow()).ballId
    const refused = await fx.promote(staged.organSet, headers)
    assert.equal(refused.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
    assert.equal((await fx.headNow()).ballId, before)
  }
})

test('a Pearl-qualifying deployment never accepts an organ-set approval', async () => {
  const fx = await fixture({ options: { verifyTransitionQualification: async () => { throw new Error('no qualification in this test') } } })
  const { staged } = await fx.stage(plainAdds(['a-one']))
  assert.equal((await fx.promote(staged.organSet)).body.code, 'ORGAN_SET_UNAVAILABLE')
})

test('policy: only pure ordinary additions form a set', async () => {
  const base = await organ('base-organ'), add = await organ('new-organ')
  const previous = { version: 'x6.1-ball/v1', entries: { 'base-organ': base.entry }, modules: { [base.sha]: base.module } }
  const candidate = structuredClone(previous)
  candidate.entries['new-organ'] = add.entry
  candidate.modules[add.sha] = add.module
  assert.deepEqual(organAdditionSet(previous, candidate), [{ organId: 'new-organ', sha256: add.sha }])
  const dropped = structuredClone(candidate)
  dropped.modules[base.sha] = { ...dropped.modules[base.sha], size: 1 }
  assert.equal(organAdditionSet(previous, dropped), null)
  assert.equal(organAdditionSet(previous, { ...candidate, version: 'x6.1-ball/v2' }), null)
  assert.equal(organAdditionSet(previous, previous), null)
  const missing = structuredClone(candidate)
  delete missing.modules[add.sha]
  assert.equal(organAdditionSet(previous, missing), null)
})

test('Over HTTP: one organ shown, an unlisted module and extra root metadata riding along: never promoted', async () => {
  for (const variant of ['module', 'root']) {
    const fx = await fixture()
    const { ball, staged } = await fx.stage(async (next, add) => {
      await add('voice-slot')
      if (variant === 'module') { await add('stowaway'); delete next.entries.stowaway }
      else next.note = 'extra root metadata'
    })
    assert.equal(staged.organSet, null, variant)
    // The body a card would have drawn for the one listed organ.
    const shown = { schema: 'aukora.head-organ-set.v1', ballId: ball.ballId, epoch: ball.epoch, parentBallId: ball.parentBallId,
      organs: [{ organId: 'voice-slot', sha256: ball.entries['voice-slot'].specifier.slice(5), bytes: Buffer.byteLength(`export const organ = ${JSON.stringify('voice-slot')};`) }] }
    const before = (await fx.headNow()).ballId
    const refused = await fx.promote(shown)
    assert.notEqual(refused.status, 200, variant)
    assert.equal(refused.body.code, 'ORGAN_SET_SCOPE_REFUSED', variant)
    assert.equal(fx.approvals.length, 0)
    assert.equal((await fx.headNow()).ballId, before)
  }
})

test('Over HTTP: a new module whose declared size differs from its verified bytes is never offered or promoted', async () => {
  const fx = await fixture()
  const { ball, staged } = await fx.stage(async (next, add) => {
    const made = await add('voice-slot')
    next.modules[made.sha] = { ...next.modules[made.sha], size: 999 }
  })
  assert.equal(staged.organSet, null)
  const code = `export const organ = ${JSON.stringify('voice-slot')};`
  const body = { schema: 'aukora.head-organ-set.v1', ballId: ball.ballId, epoch: ball.epoch, parentBallId: ball.parentBallId,
    organs: [{ organId: 'voice-slot', sha256: ball.entries['voice-slot'].specifier.slice(5), bytes: Buffer.byteLength(code) }] }
  const before = (await fx.headNow()).ballId
  const refused = await fx.promote(body)
  assert.equal(refused.body.code, 'ORGAN_SET_SCOPE_REFUSED')
  assert.equal(fx.approvals.length, 0)
  assert.equal((await fx.headNow()).ballId, before)
})
