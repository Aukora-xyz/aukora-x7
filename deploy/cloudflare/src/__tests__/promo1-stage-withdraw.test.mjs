/** A staged head candidate can be taken back. `POST /_head/stage-withdraw` with exactly
 * `{ ballId }` deletes the one key `head:staged-promotion` when it names the staged candidate, and nothing else: not HEAD,
 * not blobs, not the id-promotion ledger, not approvals, not receipts. No passkey (it only removes a request).
 * Owner-only and same-origin at the Worker exactly like `/_head/stage`; a reader window is refused at the wall and in HEAD.
 * An approval the owner already made for the withdrawn candidate stays unspent: `/_head/promote` finds nothing staged.
 * HEAD cases run against the REAL X61HeadDurableObject (as organ-set.test.mjs does); Worker cases over a stub HEAD
 * (as night-grant-forward.test.mjs does). No network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { createWorker } from '../worker.mjs'
import { READER_WINDOW_COOKIE } from '../reader-window.mjs'

const ORIGIN = 'https://stage-withdraw.example.invalid'
const OWNER = 'owner@example.invalid'
const APPROVAL = { 'x-x6-class3-approval': 'fixture-approval' }
const STAGED_KEY = 'head:staged-promotion'
const READER = { cookie: `${READER_WINDOW_COOKIE}=reader` }

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

async function headFixture({ env: extraEnv = {} } = {}) {
  const storage = storageFixture()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), ...extraEnv }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env, { networkFetch: async () => { throw new Error('External network forbidden') } })
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
  const broadcasts = []
  const broadcast = head.broadcast.bind(head)
  head.broadcast = async (value) => { broadcasts.push(structuredClone(value)); return await broadcast(value) }
  const call = async (path, body, extra = {}, method = body === undefined ? 'GET' : 'POST') => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seed.seedId,
      'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: Date.now() / 1000 + 3600 }), ...extra })
    const response = await head.fetch(new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }))
    return { status: response.status, body: await response.json() }
  }
  /** Build (not stage) a candidate on the selected head: `edit(next, add)` changes it. */
  const candidate = async edit => {
    const raw = (await call('/_head/ball')).body
    const prev = raw.ball ?? raw
    const next = { ...structuredClone(prev), epoch: prev.epoch + 1, parentBallId: prev.ballId, authorPeerId: 'fixture-writer' }
    delete next.ballId
    const codeBySha = {}
    const add = async (name, variant = '') => {
      const made = await organ(name, variant)
      next.entries[name] = made.entry
      next.modules[made.sha] = made.module
      codeBySha[made.sha] = made.code
      return made
    }
    await edit(next, add)
    next.ballId = await manifestIdCanon(next)
    return { ball: next, codeBySha, expectedParentBallId: prev.ballId, expectedEpoch: prev.epoch }
  }
  const stage = body => call('/_head/stage', body)
  const withdraw = (body, extra = {}) => call('/_head/stage-withdraw', body, extra)
  const headNow = async () => (await call('/_head/status')).body
  return { storage, head, call, candidate, stage, withdraw, approvals, broadcasts, headNow }
}

/** Every key and value of storage, to compare before and after. */
const diff = (before, after) => {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort()
  return keys.filter(key => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)))
}

test('match: the owner takes back the staged candidate; only the one key goes, open pages are told, a new candidate then stages without replaceStaged', async () => {
  const fx = await headFixture()
  const a = await fx.candidate(async (_next, add) => { await add('ordinary-a', ':v2') })
  const b = await fx.candidate(async (_next, add) => { await add('ordinary-a', ':v3') })
  assert.equal((await fx.stage(a)).status, 200)
  // The trap she hit: a second candidate on the same head is refused while the first holds the one slot.
  const blocked = await fx.stage(b)
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.code, 'CANDIDATE_ALREADY_STAGED')
  const before = fx.storage.snapshot()
  const headBefore = await fx.headNow()
  fx.broadcasts.length = 0
  const out = await fx.withdraw({ ballId: a.ball.ballId })
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.deepEqual(out.body, { ok: true, withdrawn: true, ballId: a.ball.ballId })
  assert.deepEqual(diff(before, fx.storage.snapshot()), [STAGED_KEY], 'only the staged record changed')
  assert.equal(fx.storage.snapshot().has(STAGED_KEY), false)
  assert.deepEqual(await fx.headNow(), headBefore)
  assert.deepEqual(fx.broadcasts, [{ type: 'head:staged', staged: null, withdrawn: true, ballId: a.ball.ballId }])
  assert.equal(fx.approvals.length, 0)
  // The cure: the next candidate stages with no replaceStaged.
  const next = await fx.stage(b)
  assert.equal(next.status, 200, JSON.stringify(next.body))
  assert.equal(next.body.staged.ballId, b.ball.ballId)
})

test('mismatch: another candidate is staged: 409 CANDIDATE_SUPERSEDED names it and nothing is cleared or told', async () => {
  const fx = await headFixture()
  const a = await fx.candidate(async (_next, add) => { await add('ordinary-a', ':v2') })
  const b = await fx.candidate(async (_next, add) => { await add('ordinary-a', ':v3') })
  assert.equal((await fx.stage(a)).status, 200)
  const before = fx.storage.snapshot()
  fx.broadcasts.length = 0
  const out = await fx.withdraw({ ballId: b.ball.ballId })
  assert.equal(out.status, 409)
  assert.equal(out.body.code, 'CANDIDATE_SUPERSEDED')
  assert.equal(out.body.stagedBallId, a.ball.ballId)
  assert.deepEqual(diff(before, fx.storage.snapshot()), [])
  assert.deepEqual(fx.broadcasts, [])
})

test('nothing staged: an idempotent answer, no write, no push', async () => {
  const fx = await headFixture()
  const a = await fx.candidate(async (_next, add) => { await add('ordinary-a', ':v2') })
  const before = fx.storage.snapshot()
  const out = await fx.withdraw({ ballId: a.ball.ballId })
  assert.equal(out.status, 200)
  assert.deepEqual(out.body, { ok: true, withdrawn: false, staged: null })
  assert.deepEqual(diff(before, fx.storage.snapshot()), [])
  assert.deepEqual(fx.broadcasts, [])
  // Twice in a row after a real withdrawal: the second is the same idempotent answer.
  assert.equal((await fx.stage(a)).status, 200)
  assert.equal((await fx.withdraw({ ballId: a.ball.ballId })).body.withdrawn, true)
  assert.deepEqual((await fx.withdraw({ ballId: a.ball.ballId })).body, { ok: true, withdrawn: false, staged: null })
})

test('malformed bodies are refused 400 STAGE_WITHDRAW_INVALID and change nothing', async () => {
  const fx = await headFixture()
  const a = await fx.candidate(async (_next, add) => { await add('ordinary-a', ':v2') })
  assert.equal((await fx.stage(a)).status, 200)
  const before = fx.storage.snapshot()
  const id = a.ball.ballId
  for (const body of [{}, { ballId: id, extra: 1 }, { ballId: id.toUpperCase() }, { ballId: id.slice(1) }, { ballId: 7 }, [id], '"x"', 'null', { stagedBallId: id }]) {
    const out = await fx.withdraw(body)
    assert.equal(out.status, 400, JSON.stringify(body))
    assert.equal(out.body.code, 'STAGE_WITHDRAW_INVALID', JSON.stringify(body))
  }
  const garbled = await fx.withdraw('{not json')
  assert.equal(garbled.status, 400)
  assert.equal(garbled.body.code, 'INVALID_JSON')
  assert.deepEqual(diff(before, fx.storage.snapshot()), [])
})

test('an approval already made for the withdrawn candidate stays unspent: the promote finds nothing staged', async () => {
  const fx = await headFixture()
  const add = await fx.candidate(async (_next, addOrgan) => { await addOrgan('repo-forge') })
  const staged = await fx.stage(add)
  assert.equal(staged.status, 200)
  const organSet = staged.body.staged.organSet
  assert.ok(organSet, 'a pure add is offered on the Add organs card')
  const headBefore = await fx.headNow()
  assert.equal((await fx.withdraw({ ballId: add.ball.ballId })).body.withdrawn, true)
  const promoted = await fx.call('/_head/promote', organSet, APPROVAL)
  assert.equal(promoted.status, 404, JSON.stringify(promoted.body))
  assert.equal(promoted.body.code, 'CANDIDATE_UNKNOWN')
  assert.equal(fx.approvals.length, 0, 'no approval was consumed')
  assert.deepEqual(await fx.headNow(), headBefore)
})

// Review B-M1: a staged record HEAD has already published is never withdrawn; HEAD keeps it, so "already published" stays true.
for (const legacy of [false, true]) {
  test(`a published candidate (${legacy ? 'legacy: unmarked, HEAD is it' : 'marked publishedEpoch'}) is not withdrawn: 409 ALREADY_PUBLISHED, record kept`, async () => {
    const fx = await headFixture()
    const add = await fx.candidate(async (_next, addOrgan) => { await addOrgan('repo-forge') })
    const staged = await fx.stage(add)
    const landed = await fx.call('/_head/promote', staged.body.staged.organSet, APPROVAL)
    assert.equal(landed.status, 200, JSON.stringify(landed.body))
    assert.equal((await fx.headNow()).ballId, add.ball.ballId)
    if (legacy) {
      const { publishedEpoch: _marker, ...unmarked } = await fx.storage.get(STAGED_KEY)
      await fx.storage.put(STAGED_KEY, unmarked)
    }
    const kept = await fx.storage.get(STAGED_KEY)
    assert.equal(kept.ballId, add.ball.ballId)
    assert.equal(Number.isSafeInteger(kept.publishedEpoch), !legacy)
    const before = fx.storage.snapshot()
    fx.broadcasts.length = 0
    const out = await fx.withdraw({ ballId: add.ball.ballId })
    assert.equal(out.status, 409, JSON.stringify(out.body))
    assert.equal(out.body.code, 'ALREADY_PUBLISHED')
    assert.equal(out.body.ballId, add.ball.ballId)
    assert.deepEqual(diff(before, fx.storage.snapshot()), [], 'nothing deleted')
    assert.deepEqual(fx.broadcasts, [])
    // The facts that rely on the kept record still hold.
    const again = await fx.call('/_head/promote', staged.body.staged.organSet, APPROVAL)
    assert.equal(again.status, 409, JSON.stringify(again.body))
    assert.equal(again.body.code, 'ALREADY_PUBLISHED')
    const status = await fx.call('/_head/promotion-status')
    assert.equal(status.body.staged, null)
    assert.equal(status.body.supersededStaged.ballId, add.ball.ballId)
    assert.equal(status.body.supersededStaged.state, 'published')
  })
}

test('a superseded, never-published record may still be withdrawn', async () => {
  const fx = await headFixture()
  const record = { schema: 'aukora.staged-head-promotion.v1', ballId: 'ab'.repeat(32), epoch: 160, parentBallId: 'cd'.repeat(32), stagedAt: 1 }
  await fx.storage.put(STAGED_KEY, record)
  const status = await fx.call('/_head/promotion-status')
  assert.equal(status.body.supersededStaged.state, 'superseded')
  const out = await fx.withdraw({ ballId: record.ballId })
  assert.deepEqual(out.body, { ok: true, withdrawn: true, ballId: record.ballId })
  assert.equal(fx.storage.snapshot().has(STAGED_KEY), false)
})

test('a reader window is refused inside HEAD too, and the candidate stays', async () => {
  const fx = await headFixture({ env: { THREAD_SYNC: 'on' } })
  const a = await fx.candidate(async (_next, add) => { await add('ordinary-a', ':v2') })
  assert.equal((await fx.stage(a)).status, 200)
  const before = fx.storage.snapshot()
  const out = await fx.withdraw({ ballId: a.ball.ballId }, READER)
  assert.equal(out.status, 403)
  assert.equal(out.body.code, 'READER_WINDOW')
  assert.deepEqual(diff(before, fx.storage.snapshot()), [])
})

// ---- the Worker: guards identical to /_head/stage ----
const SEED = 'a'.repeat(64)
function workerFixture(extraEnv = {}) {
  const reached = []
  const answer = (path, request) => {
    if (path === '/_head/bootstrap-status') return { ok: true, phase: 'complete', seedId: SEED, ballId: 'b'.repeat(64), epoch: 169 }
    if (path === '/_mirror/bootstrap-status') return { ok: true, phase: 'ready', seedId: SEED, ballId: 'b'.repeat(64), epoch: 169 }
    reached.push({ path, method: request.method, access: request.headers.get('x-x6-verified-access'), seed: request.headers.get('x-x6-bootstrap-seed') })
    return { ok: true, stub: path }
  }
  const namespace = { idFromName: name => name, get: () => ({ fetch: async request => Response.json(answer(new URL(request.url).pathname, request)) }) }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64), HEAD: namespace, MIRROR: namespace, ...extraEnv }
  let access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  const worker = createWorker({ verifyAccess: async () => access })
  const call = (path, { method = 'POST', headers = {}, body = JSON.stringify({ ballId: 'c'.repeat(64) }) } = {}) => worker.fetch(new Request(ORIGIN + path, {
    method, headers: Object.fromEntries(Object.entries({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers })
      .filter(([, value]) => value !== undefined)),
    ...(method === 'GET' ? {} : { body }) }), env)
  return { call, reached, setAccess: value => { access = value } }
}

test('Worker: the owner, same-origin, reaches HEAD with owner access', async () => {
  const f = workerFixture()
  const response = await f.call('/_head/stage-withdraw')
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual(await response.json(), { ok: true, stub: '/_head/stage-withdraw' })
  assert.equal(f.reached.length, 1)
  assert.equal(JSON.parse(f.reached[0].access).type, 'owner')
  assert.equal(f.reached[0].seed, SEED)
})

test('Worker: not the owner, a foreign origin, cross-site, wrong method or a query, and a reader window are refused before HEAD, as /_head/stage', async () => {
  const codesBy = {}
  for (const path of ['/_head/stage-withdraw', '/_head/stage']) {
    const f = workerFixture()
    const cases = [
      [path, 'POST', { origin: 'https://evil.example' }, 403],
      [path, 'POST', { 'sec-fetch-site': 'cross-site' }, 403],
      [path, 'POST', { 'sec-fetch-site': 'same-site' }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
      [path + '?x=1', 'POST', {}, 404, 'NOT_FOUND'],
      [path, 'GET', {}, 405, 'METHOD_UNAVAILABLE'],
    ]
    const codes = []
    for (const [target, method, headers, status, code] of cases) {
      const response = await f.call(target, { method, headers })
      assert.equal(response.status, status, `${method} ${target} ${JSON.stringify(headers)}`)
      const body = await response.json()
      if (code) assert.equal(body.code, code, `${method} ${target}`)
      codes.push(body.code)
    }
    f.setAccess({ type: 'access', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 })
    const notOwner = await f.call(path)
    assert.equal(notOwner.status, 403); assert.equal((await notOwner.json()).code, 'OWNER_ACCESS_REQUIRED')
    f.setAccess(null)
    const signedOut = await f.call(path)
    assert.equal(signedOut.status, 401)
    assert.deepEqual(f.reached, [], `${path}: nothing reached HEAD`)
    codesBy[path] = codes
  }
  assert.deepEqual(codesBy['/_head/stage-withdraw'], codesBy['/_head/stage'], 'the same refusals as /_head/stage')
  const reader = workerFixture({ THREAD_SYNC: 'on' })
  const refused = await reader.call('/_head/stage-withdraw', { headers: READER })
  assert.equal(refused.status, 403)
  assert.equal((await refused.json()).code, 'READER_WINDOW')
  assert.deepEqual(reader.reached, [])
})
