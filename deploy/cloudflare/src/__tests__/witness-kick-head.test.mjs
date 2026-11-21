/** HEAD's side: once a promotion has committed, HEAD tells the witness object once (POST /_witness/kick,
 * the address witnessCall uses), after the commit and without waiting on it. A witness binding that throws, answers
 * 503 or never answers changes nothing in HEAD's answer; a fault is swallowed and counted. A refused promotion and the
 * switch off make no call. The promotion is the real one pubfix-t1-publish.test.mjs runs (a REAL X61HeadDurableObject
 * with production wiring, her frozen epoch-173 head, a reserved T1 organ update). No network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest } from '../head-do.mjs'

const W = new URL('../../../../', import.meta.url).pathname
const ORIGIN = 'https://head.example.invalid'
const sha256 = text => createHash('sha256').update(text).digest('hex')
const TARGET = 'auma-cortex'
const FIXTURE = W + 'packages/experimental/webworker-runtime/tests/x6/fixtures/frozen-head/'
const HEAD = JSON.parse(readFileSync(FIXTURE + 'HEAD.json', 'utf8'))
const code = sha => {
  const frozen = `${FIXTURE}balls/${sha}.js`
  const text = readFileSync(existsSync(frozen) ? frozen : `${W}mirror/home/balls/${sha}.js`, 'utf8')
  assert.equal(sha256(text), sha, `module ${sha} does not match its sha`)
  return text
}

/** The canonical T1 candidate pubfix-t1-publish.test.mjs builds (treePatch's shape, canonical id). */
function candidate() {
  const prevEntry = HEAD.entries[TARGET]
  const source = code(prevEntry.specifier.slice(5)).replace(/name:\s*'auma_cortex'/, "name: 'auma-cortex'") + '\n// witness kick\n'
  const sha = sha256(source), specifier = `ball:${sha}`
  const nextEntry = { id: TARGET, specifier, config: JSON.parse(JSON.stringify(prevEntry.config ?? {})), disabled: prevEntry.disabled ?? false,
    ...(prevEntry.governance === undefined ? {} : { governance: prevEntry.governance }),
    previousSpecifiers: [...prevEntry.previousSpecifiers, prevEntry.specifier],
    previousVersions: [...(prevEntry.previousVersions ?? []), { specifier: prevEntry.specifier, config: JSON.parse(JSON.stringify(prevEntry.config)), disabled: prevEntry.disabled }],
    updatedAt: Date.now() }
  const modules = { ...HEAD.modules, [sha]: { sha256: sha, specifier, name: TARGET, description: `Cordis ball plugin ${TARGET}`, size: Buffer.byteLength(source), createdAt: Date.now() } }
  const body = { version: 'x6.1-ball/v1', parentBallId: HEAD.ballId, epoch: HEAD.epoch + 1, createdAt: Date.now(), authorPeerId: 'auma-peer', entries: { ...HEAD.entries, [TARGET]: nextEntry }, modules }
  return { ball: { ...body, ballId: sha256(canonicalBootstrap(body)) }, codeBySha: { [sha]: source } }
}

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

/** A witness binding: `answer(request)` decides what its object does; every call is kept. */
function witnessBinding(answer) {
  const calls = []
  return { calls, binding: { idFromName: name => { calls.push(['idFromName', name]); return name }, get: id => ({ fetch: request => {
    calls.push([request.method, new URL(request.url).pathname, request.headers.get('x-x6-internal-authorized'), id])
    return answer(request)
  } }) } }
}

async function promote(witnessEnv, { refuse = false } = {}) {
  const env = { PUBLIC_HOST: 'head.example.invalid', OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), OWNER_EMAIL: 'owner@example.invalid', AUMLOK_CUSTODY_PEPPER: '22'.repeat(32), ...witnessEnv }
  const waited = []
  const head = new X61HeadDurableObject({ storage: storageFixture(), getWebSockets: () => [], waitUntil: promise => waited.push(promise) }, env)
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
  const next = candidate()
  const lease = await call('/_head/lease', { action: 'acquire', ownerPeerId: 'auma-peer', ttlMs: 30000 })
  assert.equal(lease.body.ok, true, JSON.stringify(lease.body))
  if (!refuse) {
    const reservation = await call('/_head/lease', { action: 'reserve-id-promotion', ownerPeerId: 'auma-peer', generation: lease.body.lease.generation,
      expectedBallId: HEAD.ballId, organId: TARGET, candidateSha: next.ball.entries[TARGET].specifier.slice(5) })
    assert.equal(reservation.body.ok, true, JSON.stringify(reservation.body))
  }
  const started = Date.now()
  const out = await call('/_head/ball', { type: 'ball:commit', fromPeerId: 'auma-peer', ball: next.ball, codeBySha: next.codeBySha,
    expectedParentBallId: next.ball.parentBallId, expectedEpoch: next.ball.epoch - 1, writerLease: lease.body.lease })
  return { ...out, elapsedMs: Date.now() - started, head, next, waited, selected: (await head.store.read()).ball }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

test('A (HEAD): a committed promotion kicks the witness object once, after the commit, at witnessCall\'s address', async () => {
  const witness = witnessBinding(async () => Response.json({ ok: true, alarmAt: 1, kept: false }))
  const out = await promote({ WITNESS_SWITCH: 'on', WITNESS: witness.binding })
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.equal(out.body.epoch, HEAD.epoch + 1)
  assert.equal(out.selected.ballId, out.next.ball.ballId)
  await settle()
  assert.deepEqual(witness.calls, [['idFromName', 'node-main-v1'], ['POST', '/_witness/kick', '1', 'node-main-v1']])
  assert.deepEqual(out.head.witnessKicks, { sent: 1, faults: 0 })
  assert.equal(out.waited.length, 1, 'the kick is handed to waitUntil, never awaited by the answer')
})

test('A (HEAD): a witness binding that throws, answers 503 or never answers does not change HEAD\'s answer; the fault is counted', async () => {
  const baseline = await promote({ WITNESS_SWITCH: 'on', WITNESS: witnessBinding(async () => Response.json({ ok: true })).binding })
  for (const [name, answer] of [
    ['throws', () => { throw new Error('witness object down') }],
    ['rejects', async () => { throw new Error('witness object down') }],
    ['503', async () => Response.json({ ok: false, code: 'WITNESS_UNAVAILABLE' }, { status: 503 })],
    ['never answers', () => new Promise(() => {})],
  ]) {
    const witness = witnessBinding(answer)
    const out = await promote({ WITNESS_SWITCH: 'on', WITNESS: witness.binding })
    assert.equal(out.status, 200, name)
    assert.deepEqual(Object.keys(out.body).sort(), Object.keys(baseline.body).sort(), name)
    assert.equal(out.body.ok, true, name)
    assert.equal(out.body.epoch, HEAD.epoch + 1, name)
    assert.equal(out.selected.ballId, out.next.ball.ballId, `${name}: the commit stands`)
    assert.ok(out.elapsedMs < 4000, `${name}: HEAD answered without waiting on the witness (${out.elapsedMs} ms)`)
    await settle()
    assert.equal(witness.calls.filter(call => call[1] === '/_witness/kick').length, 1, name)
    if (name !== 'never answers') assert.deepEqual(out.head.witnessKicks, { sent: 0, faults: 1 }, name)
  }
  // No binding at all is a fault too, and the promotion still stands.
  const bare = await promote({ WITNESS_SWITCH: 'on' })
  assert.equal(bare.status, 200)
  await settle()
  assert.deepEqual(bare.head.witnessKicks, { sent: 0, faults: 1 })
})

test('A (HEAD): the switch off makes no kick; a refused promotion makes no kick', async () => {
  for (const value of [undefined, 'off', 'On']) {
    const witness = witnessBinding(async () => assert.fail('no kick while the switch is off'))
    const out = await promote({ ...(value === undefined ? {} : { WITNESS_SWITCH: value }), WITNESS: witness.binding })
    assert.equal(out.status, 200)
    await settle()
    assert.deepEqual(witness.calls, [], String(value))
    assert.deepEqual(out.head.witnessKicks, { sent: 0, faults: 0 })
  }
  const witness = witnessBinding(async () => assert.fail('no kick for a refused promotion'))
  const refused = await promote({ WITNESS_SWITCH: 'on', WITNESS: witness.binding }, { refuse: true })
  assert.equal(refused.status, 403)
  assert.equal(refused.selected.ballId, HEAD.ballId)
  await settle()
  assert.deepEqual(witness.calls, [])
})
