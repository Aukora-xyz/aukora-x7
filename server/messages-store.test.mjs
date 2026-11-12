/** Offline messaging and wake checks: owned temporary storage and in-memory DOs, no app boot or network. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bech32 } from '@scure/base'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Readable } from 'node:stream'
import { createLocalMessagesStorage, createLocalWakeStorage, createLocalWakeScheduler, createLocalWakeRequestHandler, createLocalLiveUpdates, authorizeLocalHeadWebSocket, broadcastLocalUpdate, readLocalAuraInputs, createLocalMessagesRequestHandler } from './messages-store.mjs'
import { canonicalJson } from '../deploy/cloudflare/src/owner-grant-policy.mjs'
import { projectVerifiedFacts } from './verified-facts.mjs'
import { handleMessagesRequest, provisionMessagesIdentity, createWakeProbeRunner, createWakeAuraReader } from '../deploy/cloudflare/src/messages-store.mjs'
import { STALE_HEARTBEAT_MS, computeAura, overdueWakeRatio, staleHeartbeatFacts, validateAuraVector } from './aura-rules.mjs'
import { projectAura } from '../apps/web/src/spatial/superagent/aura.ts'
import { createRuntimeHead } from './runtime-head.mjs'
import { createMirrorPublisher } from './mirror-store.mjs'
import { createWorker } from '../deploy/cloudflare/src/worker.mjs'
import { X61HeadDurableObject, createDurableWakeStore, bootstrapPackage, digest, manifestId, createMirrorUpdate, validateMirrorUpdate } from '../deploy/cloudflare/src/head-do.mjs'
import { MirrorDO, mirrorDigest, validateMirrorEntries } from '../deploy/cloudflare/src/mirror-do.mjs'

const clone = value => structuredClone(value)
const ORIGIN = 'https://wake-fixture.example.invalid'
const LOCAL_ORIGIN = 'http://127.0.0.1:4610'
const FIXTURE_TIME = 1700000000000
const HEAD = { ballId: 'a'.repeat(64), epoch: 12 }

// The alarm is part of the transaction snapshot: a failed commit rolls back both.
function memoryStorage(initial = []) {
  let rows = new Map(clone(initial)), alarmAt = null, queue = Promise.resolve(), rejectAlarm = false, rejectPut = null, replayTransaction = false
  const adapter = (map, alarm) => ({
    get: async key => clone(map.get(key)),
    put: async (key, value) => { if (key === rejectPut) throw new Error('fixture put failure'); assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024); map.set(key, clone(value)) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, clone(value)])),
    getAlarm: async () => alarm.value,
    setAlarm: async value => { if (rejectAlarm) throw new Error('fixture alarm failure'); alarm.value = Number(value) },
    deleteAlarm: async () => { if (rejectAlarm) throw new Error('fixture alarm failure'); alarm.value = null },
  })
  return {
    get: key => adapter(rows, { value: alarmAt }).get(key),
    list: options => adapter(rows, { value: alarmAt }).list(options),
    getAlarm: async () => alarmAt,
    async setAlarm(value) { if (rejectAlarm) throw new Error('fixture alarm failure'); alarmAt = Number(value) },
    async deleteAlarm() { if (rejectAlarm) throw new Error('fixture alarm failure'); alarmAt = null },
    transaction(operation) {
      const result = queue.then(async () => {
        if (replayTransaction) { replayTransaction = false; await operation(adapter(clone(rows), { value: alarmAt })) }
        const staged = clone(rows), alarm = { value: alarmAt }
        const output = await operation(adapter(staged, alarm))
        rows = staged; alarmAt = alarm.value
        return output
      })
      queue = result.catch(() => {})
      return result
    },
    snapshot: () => clone(rows), idle: () => queue,
    failAlarm(value) { rejectAlarm = value },
    failPut(key) { rejectPut = key },
    retryTransaction() { replayTransaction = true },
  }
}

function manualTimers() {
  const pending = new Map()
  let sequence = 0
  return {
    setTimeout(callback, delay) { const timer = { id: ++sequence, unref() {} }; pending.set(timer, { callback, delay }); return timer },
    clearTimeout(timer) { pending.delete(timer) },
    get size() { return pending.size },
    delays: () => [...pending.values()].map(value => value.delay),
    async fire() {
      assert.equal(pending.size, 1)
      const [timer, value] = pending.entries().next().value
      pending.delete(timer)
      await value.callback()
    },
  }
}

async function localFixture(t, { readHead = async () => HEAD, ...options } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'x61-round12-fixture-'))
  await fs.chmod(root, 0o700)
  const schedulers = []
  t.after(async () => { for (const scheduler of schedulers) await scheduler.dispose(); await fs.rm(root, { recursive: true, force: true }) })
  let clock = FIXTURE_TIME
  const timers = manualTimers(), directory = path.join(root, 'private')
  const storage = createLocalWakeStorage({ directory })
  const create = (overrides = {}) => {
    const scheduler = createLocalWakeScheduler({ ...options, ...overrides, storage, readHead, now: () => clock, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
    schedulers.push(scheduler)
    return scheduler
  }
  return { root, directory, storage, timers, create, advance(ms) { clock += ms }, now: () => clock }
}

async function responseBody(response) {
  const text = await response.text()
  assert.ok(Buffer.byteLength(text) < 256 * 1024)
  return JSON.parse(text)
}

async function cloudFixture(t) {
  const storage = memoryStorage(), mirrorStorage = memoryStorage()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture', ACCESS_AUD: 'fixture', OWNER_EMAIL: 'fixture@example.invalid' }
  const peers = []
  const context = { storage, getWebSockets: () => peers.filter(peer => !peer.closed) }
  let head = new X61HeadDurableObject(context, env)
  const mirror = new MirrorDO({ storage: mirrorStorage }, env)
  let networkCalls = 0, assetCalls = 0
  for (const name of ['HEAD', 'MIRROR']) env[name] = {
    idFromName(value) { assert.equal(value, 'node-main-v1'); return value },
    get(value) { assert.equal(value, 'node-main-v1'); return { fetch: request => (name === 'HEAD' ? head : mirror).fetch(request) } },
  }
  env.ASSETS = { fetch() { assetCalls++; throw new Error('Unexpected asset fallback') } }
  const worker = createWorker({ verifyAccess: async request => request.headers.get('cookie') === 'CF_Authorization=fixture-token', networkFetch: async () => { networkCalls++; throw new Error('Network forbidden') } })
  const request = (value, overrides = {}) => {
    const headers = new Headers({ cookie: 'CF_Authorization=fixture-token', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })
    for (const [key, entry] of Object.entries(overrides.headers ?? {})) entry === null ? headers.delete(key) : headers.set(key, entry)
    return worker.fetch(new Request(ORIGIN + (overrides.path ?? '/_host/wake'), {
      method: overrides.method ?? (value === undefined ? 'GET' : 'POST'), headers,
      ...(value === undefined ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }),
    }), env)
  }
  const code = 'export default { syntheticWakeFixture: true }', sha = await digest(code)
  const ball = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 12, entries: { fixture: { id: 'fixture', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [] } }, modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  ball.ballId = await manifestId(ball)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } })
  t.after(async () => { await storage.idle(); await mirrorStorage.idle(); await mirror.queue; assert.equal(networkCalls, 0); assert.equal(assetCalls, 0) })
  return { storage, mirrorStorage, env, request, ball, seed,
    connect({ seedId = seed.seedId, throwing = false } = {}) {
      const messages = [], waiters = []
      const peer = { closed: false, messages, waitForMessages(count) { return messages.length >= count ? Promise.resolve() : new Promise(resolve => waiters.push({ count, resolve })) }, deserializeAttachment: () => ({ bootstrapSeed: seedId }), send(text) { if (throwing) throw new Error('fixture socket failure'); messages.push(JSON.parse(text)); for (const waiter of waiters) if (messages.length >= waiter.count) waiter.resolve() }, close() { peer.closed = true } }
      peers.push(peer)
      return peer
    },
    direct: request => head.fetch(request),
    alarm: info => head.alarm(info),
    recreate() { head = new X61HeadDurableObject(context, env) },
    async bootstrap() {
      for (const value of [{ action: 'prepare', package: seed }, { action: 'commit', seedId: seed.seedId }]) {
        const response = await request(value, { path: '/_bootstrap' })
        assert.equal(response.status, 200, JSON.stringify(await responseBody(response)))
      }
    },
  }
}

function localRequest(value, overrides = {}) {
  const body = value === undefined ? [] : [Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]
  const incoming = Readable.from(body)
  incoming.method = overrides.method ?? (value === undefined ? 'GET' : 'POST')
  incoming.headers = { host: new URL(LOCAL_ORIGIN).host, origin: LOCAL_ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-x6-capability': 'synthetic-capability', ...overrides.headers }
  return incoming
}

test('local wake is disabled by default, durable, bounded and separate from messages', async t => {
  const fixture = await localFixture(t), wake = fixture.create()
  const initial = await wake.status()
  assert.equal(initial.ok, true); assert.equal(initial.enabled, false); assert.equal(initial.intervalMs, 60000)
  assert.equal(initial.wakeCount, 0); assert.equal(initial.nextWakeAt, null); assert.equal(fixture.timers.size, 0)
  const messages = createLocalMessagesStorage({ directory: fixture.directory })
  assert.equal((await handleMessagesRequest(new Request(LOCAL_ORIGIN + '/aukora-messages/contacts.json'), messages, { authorized: true })).status, 200)
  const before = await messages.transaction(tx => tx.get('messages:v1'))
  const configured = await wake.configure({ enabled: true, intervalMs: 60000 })
  assert.equal(configured.enabled, true); assert.equal(configured.nextWakeAt, fixture.now() + 60000)
  assert.deepEqual(fixture.timers.delays(), [60000])
  await wake.dispose()
  const reopened = fixture.create()
  assert.equal((await reopened.status()).nextWakeAt, configured.nextWakeAt)
  assert.equal(fixture.timers.size, 1)
  fixture.advance(60000); await fixture.timers.fire()
  const fired = await reopened.status()
  assert.equal(fired.wakeCount, 1); assert.equal(fired.lastWakeOutcome, 'executor_unavailable')
  assert.equal(fired.nextWakeAt, fixture.now() + 60000)
  assert.equal(fired.receipts[0].trigger, 'alarm'); assert.equal(fired.receipts[0].headEpoch, HEAD.epoch)
  assert.equal(fired.receipts[0].headBallId, HEAD.ballId)
  assert.deepEqual(await messages.transaction(tx => tx.get('messages:v1')), before)
  const unchanged = await reopened.configure({ enabled: true })
  assert.equal(unchanged.nextWakeAt, fired.nextWakeAt)
  await reopened.configure({ enabled: false })
  assert.equal(fixture.timers.size, 0); assert.equal((await reopened.status()).nextWakeAt, null)
})

test('local manual wake has retained replay identity and never moves the periodic deadline', async t => {
  const fixture = await localFixture(t), wake = fixture.create()
  const configured = await wake.configure({ enabled: true, intervalMs: 60000 })
  const first = await wake.trigger({ requestId: 'local-manual-1' })
  const replay = await wake.trigger({ requestId: 'local-manual-1' })
  assert.equal(first.wakeCount, 1); assert.equal(replay.wakeCount, 1)
  assert.deepEqual(replay.receipts, first.receipts); assert.equal(replay.nextWakeAt, configured.nextWakeAt)
  for (let i = 0; i < 70; i++) await wake.trigger({ requestId: `manual-${i}` })
  const bounded = await wake.status()
  assert.equal(bounded.wakeCount, 71); assert.equal(bounded.receipts.length, 64)
  assert.equal(bounded.executor.invoked, false)
})

test('local wake rejects unsafe configuration and preserves corrupted state', async t => {
  const fixture = await localFixture(t), wake = fixture.create()
  await wake.start()
  for (const input of [{ intervalMs: 59999 }, { intervalMs: 86400001 }, { enabled: 'true' }, {}, { enabled: true, extra: 1 }]) {
    await assert.rejects(wake.configure(input))
  }
  assert.equal((await wake.status()).wakeCount, 0)
  await wake.dispose()
  await fixture.storage.transaction(tx => tx.put('wake:v1', { broken: true }))
  const before = await fixture.storage.transaction(tx => tx.get('wake:v1'))
  const reopened = fixture.create()
  assert.equal((await reopened.status()).ok, false)
  await assert.rejects(reopened.trigger())
  assert.deepEqual(await fixture.storage.transaction(tx => tx.get('wake:v1')), before)
  assert.equal(fixture.timers.size, 0)
})

test('actual local wake dispatcher rejects unauthorized or malformed requests before writes', async t => {
  const fixture = await localFixture(t), wake = fixture.create()
  const handler = createLocalWakeRequestHandler({ wake, sessionCapability: 'synthetic-capability', allowedOrigins: [LOCAL_ORIGIN], verifyHostAndOrigin: () => ({ ok: true }) })
  const call = (value, overrides = {}) => handler(localRequest(value, overrides), new URL(overrides.path ?? '/_host/wake', LOCAL_ORIGIN))
  for (const headers of [{ 'x-x6-capability': '' }, { origin: 'https://evil.invalid' }, { 'sec-fetch-site': 'cross-site' }, { origin: '' }]) {
    assert.equal((await call({ action: 'trigger' }, { headers })).status, 403)
  }
  for (const value of [{ action: 'unknown' }, { action: 'trigger', enabled: true }, { action: 'configure' }, 'x'.repeat(16385)]) {
    assert.ok((await call(value)).status >= 400)
  }
  assert.ok((await call(undefined, { path: '/_host/wake?extra=1' })).status >= 400)
  assert.equal((await call(undefined, { method: 'PUT' })).status, 405)
  assert.equal((await wake.status()).wakeCount, 0)
  const sent = await responseBody(await call({ action: 'trigger' }, { headers: { 'idempotency-key': 'http-local-1' } }))
  const replay = await responseBody(await call({ action: 'trigger' }, { headers: { 'idempotency-key': 'http-local-1' } }))
  assert.equal(sent.wakeCount, 1); assert.equal(replay.wakeCount, 1)
})

test('Worker wake routes require Access, bootstrap and exact same-origin mutation', async t => {
  const cloud = await cloudFixture(t), before = cloud.storage.snapshot()
  assert.equal((await cloud.request(undefined, { headers: { cookie: '' } })).status, 401)
  assert.equal((await cloud.request()).status, 503)
  assert.deepEqual(cloud.storage.snapshot(), before)
  await cloud.bootstrap()
  const ready = cloud.storage.snapshot()
  for (const headers of [{ cookie: '' }, { origin: null }, { 'sec-fetch-site': null }, { origin: 'https://evil.invalid' }]) {
    assert.ok((await cloud.request({ action: 'trigger' }, { headers })).status >= 400)
    assert.deepEqual(cloud.storage.snapshot(), ready)
  }
  assert.equal((await cloud.direct(new Request(ORIGIN + '/_host/wake', { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': '0'.repeat(64) } }))).status, 503)
  const status = await responseBody(await cloud.request())
  assert.equal(status.enabled, false); assert.equal(status.wakeCount, 0); assert.equal(status.nextWakeAt, null)
  assert.deepEqual(cloud.storage.snapshot(), ready)
  for (const value of [{ action: 'configure', enabled: true, intervalMs: 59999 }, { action: 'trigger', extra: true }, ' '.repeat(1025)]) {
    assert.ok((await cloud.request(value)).status >= 400)
    assert.deepEqual(cloud.storage.snapshot(), ready)
  }
})

test('Worker manual wake survives DO recreation without invoking a model or changing the head', async t => {
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  const first = await responseBody(await cloud.request({ action: 'trigger' }, { headers: { 'idempotency-key': 'edge-manual-1' } }))
  assert.equal(first.wakeCount, 1); assert.equal(first.lastWakeOutcome, 'executor_unavailable')
  assert.equal(first.receipts[0].headBallId, cloud.ball.ballId); assert.equal(first.receipts[0].headEpoch, 12)
  assert.equal(first.receipts[0].trigger, 'manual'); assert.equal(first.executor.invoked, false)
  cloud.recreate()
  const replay = await responseBody(await cloud.request({ action: 'trigger' }, { headers: { 'idempotency-key': 'edge-manual-1' } }))
  assert.equal(replay.wakeCount, 1); assert.deepEqual(replay.receipts, first.receipts)
  assert.equal(await cloud.storage.get('head'), cloud.ball.ballId)
})

test('durable alarms deduplicate retries, roll back failed scheduling and reveal a missing alarm', async t => {
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  let now = FIXTURE_TIME
  const create = () => createDurableWakeStore(cloud.storage, { now: () => now })
  let wake = create()
  const untouched = cloud.storage.snapshot()
  cloud.storage.failAlarm(true)
  await assert.rejects(wake.configure({ enabled: true }))
  assert.deepEqual(cloud.storage.snapshot(), untouched); assert.equal(await cloud.storage.getAlarm(), null)
  cloud.storage.failAlarm(false)
  assert.equal((await wake.configure({ enabled: true, intervalMs: 60000 })).nextWakeAt, now + 60000)
  assert.equal(await cloud.storage.getAlarm(), now + 60000)
  assert.equal((await wake.alarm()).skipped, 'not_due')
  now += 60000
  await cloud.storage.deleteAlarm()
  const [one, duplicate] = await Promise.all([wake.alarm(), wake.alarm()])
  assert.equal(one.wakeCount, 1); assert.equal(duplicate.wakeCount, 1)
  assert.equal(duplicate.skipped, 'not_due')
  assert.equal(await cloud.storage.getAlarm(), now + 60000)
  wake = create()
  now += 90000
  assert.equal((await wake.alarm({ isRetry: true })).wakeCount, 1)
  assert.equal((await wake.alarm()).wakeCount, 2)
  const beforeFailure = cloud.storage.snapshot()
  cloud.storage.failAlarm(true)
  await assert.rejects(wake.configure({ enabled: false }))
  assert.deepEqual(cloud.storage.snapshot(), beforeFailure)
  cloud.storage.failAlarm(false)
  await cloud.storage.deleteAlarm()
  const missing = await wake.status()
  assert.equal(missing.enabled, true); assert.equal(missing.scheduleStatus, 'alarm_missing'); assert.equal(missing.scheduledAlarmAt, null)
  assert.equal(await cloud.storage.getAlarm(), null, 'GET must not repair scheduling')
  await wake.trigger({ requestId: 'one-manual' })
  assert.equal(await cloud.storage.getAlarm(), null, 'Manual trigger is not periodic recovery')
  await wake.configure({ enabled: true })
  assert.equal((await wake.status()).scheduleStatus, 'scheduled')
  await wake.configure({ enabled: false })
  assert.equal(await cloud.storage.getAlarm(), null)
  assert.equal((await wake.alarm()).skipped, 'disabled')
})

test('unseeded alarms cannot create wake state and corrupted wake state cannot be reset', async t => {
  const empty = memoryStorage(), wake = createDurableWakeStore(empty, { now: () => FIXTURE_TIME })
  await empty.setAlarm(FIXTURE_TIME)
  assert.equal((await wake.alarm()).code, 'BOOTSTRAP_REQUIRED')
  assert.equal(await empty.getAlarm(), null); assert.equal(empty.snapshot().size, 0)
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  await cloud.storage.transaction(tx => tx.put('wake:v1', { version: 'corrupt' }))
  const before = cloud.storage.snapshot()
  assert.equal((await cloud.request()).status, 503)
  assert.equal((await cloud.request({ action: 'configure', enabled: false })).status, 503)
  assert.deepEqual(cloud.storage.snapshot(), before)
})

test('local overdue restart produces one receipt, and clock failure visibly suspends the timer', async t => {
  const fixture = await localFixture(t), wake = fixture.create()
  await wake.configure({ enabled: true })
  await wake.dispose()
  fixture.advance(60000 * 100)
  const resumed = fixture.create()
  await resumed.start()
  assert.deepEqual(fixture.timers.delays(), [0])
  await fixture.timers.fire()
  assert.equal((await resumed.status()).wakeCount, 1)
  assert.deepEqual(fixture.timers.delays(), [60000])
  fixture.advance(NaN)
  await assert.rejects(resumed.configure({ intervalMs: 120000 }))
  const failed = await resumed.status()
  assert.equal(failed.ok, false); assert.equal(failed.enabled, false); assert.equal(fixture.timers.size, 0)
})

test('local disposal waits for an admitted receipt and prevents another timer from being armed', async t => {
  let enter, release
  const entered = new Promise(resolve => { enter = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  t.after(() => release())
  const fixture = await localFixture(t, { readHead: async () => { enter(); await barrier; return HEAD } })
  const wake = fixture.create()
  await wake.configure({ enabled: true })
  const operation = wake.trigger()
  await entered
  let disposed = false
  const disposal = wake.dispose().then(() => { disposed = true })
  await Promise.resolve()
  assert.equal(disposed, false); assert.equal(fixture.timers.size, 0)
  release()
  await operation; await disposal
  assert.equal(disposed, true); assert.equal(fixture.timers.size, 0)
  assert.equal((await fixture.storage.transaction(tx => tx.get('wake:v1'))).wakeCount, 1)
  assert.equal((await wake.status()).ok, false)
})

const messageCall = (storage, route, body) => handleMessagesRequest(new Request(LOCAL_ORIGIN + '/aukora-messages/' + route, {
  method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), storage, { authorized: true, now: () => FIXTURE_TIME })

// Bitcoin BIP-0340 official test vector 0, retrieved from bitcoin/bips/test-vectors.csv.
// This publicly documented scalar is a disposable fixture, never a production identity.
const VECTOR_SECRET = '0'.repeat(63) + '3'
const VECTOR_PUBLIC = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const VECTOR_SIGNATURE = 'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0'
const raw = hex => new Uint8Array(Buffer.from(hex, 'hex'))

function verifyNip01(event) {
  const id = createHash('sha256').update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])).digest('hex')
  assert.equal(event.id, id)
  assert.equal(schnorr.verify(raw(event.sig), raw(id), raw(event.pubkey)), true)
  assert.equal(event.idScheme, 'nip01-schnorr/v1'); assert.equal(event.signatureStatus, 'signed')
}

test('maintained Schnorr dependency matches the official BIP-340 signing and rejection vector', () => {
  const signed = schnorr.sign(new Uint8Array(32), raw(VECTOR_SECRET), new Uint8Array(32))
  assert.equal(Buffer.from(signed).toString('hex'), VECTOR_SIGNATURE)
  assert.equal(Buffer.from(schnorr.getPublicKey(raw(VECTOR_SECRET))).toString('hex'), VECTOR_PUBLIC)
  assert.equal(schnorr.verify(raw(VECTOR_SIGNATURE), new Uint8Array(32), raw(VECTOR_PUBLIC)), true)
  const altered = raw(VECTOR_SIGNATURE); altered[63] ^= 1
  assert.equal(schnorr.verify(altered, new Uint8Array(32), raw(VECTOR_PUBLIC)), false)
})

test('identity provisioning requires explicit approval before storage and exposes only public identity', async () => {
  let calls = 0
  await assert.rejects(provisionMessagesIdentity({ transaction() { calls++; throw new Error('must not access') } }), { code: 'MESSAGES_IDENTITY_PROVISIONING_REQUIRED' })
  assert.equal(calls, 0)
  const storage = memoryStorage()
  const prior = await responseBody(await messageCall(storage, 'contacts.json'))
  assert.equal(prior.identity.signing, 'unavailable')
  assert.equal((await storage.get('messages:v1')).identity, undefined)
  const identity = await provisionMessagesIdentity(storage, { approved: true, now: () => FIXTURE_TIME })
  assert.deepEqual(Object.keys(identity).sort(), ['npub', 'pubkey', 'signing'])
  assert.equal(identity.signing, 'bip340-schnorr')
  assert.match(identity.pubkey, /^[a-f0-9]{64}$/)
  assert.deepEqual(bech32.decodeToBytes(identity.npub).bytes, raw(identity.pubkey))
  const saved = storage.snapshot()
  assert.deepEqual(await provisionMessagesIdentity(storage, { approved: true }), identity)
  assert.deepEqual(storage.snapshot(), saved)
  const output = await responseBody(await messageCall(storage, 'contacts.json'))
  assert.deepEqual(output.identity, identity)
  assert.equal(JSON.stringify(output).includes(saved.get('messages:v1').identity.secretKey), false)
  assert.equal(JSON.stringify(output).includes('secretKey'), false)
  assert.equal(output.relay.connected, false)
})

test('signed NIP-01 turns preserve legacy replay and bind distinct same-second requests', async () => {
  const storage = memoryStorage()
  const legacyInput = { conversationId: 'auma-pearl', content: 'Legacy synthetic note.', requestId: 'legacy-1' }
  const legacy = (await responseBody(await messageCall(storage, 'send', legacyInput))).event
  assert.equal(legacy.sig, null)
  await provisionMessagesIdentity(storage, { approved: true, now: () => FIXTURE_TIME })
  const legacyReplay = (await responseBody(await messageCall(storage, 'send', legacyInput))).event
  assert.deepEqual(legacyReplay, legacy)
  const input = { conversationId: 'auma-pearl', content: 'Synthetic signed note.', requestId: 'signed-1' }
  const first = (await responseBody(await messageCall(storage, 'send', input))).event
  verifyNip01(first)
  const second = (await responseBody(await messageCall(storage, 'send', { ...input, requestId: 'signed-2' }))).event
  verifyNip01(second)
  assert.notEqual(first.id, second.id); assert.equal(first.created_at, second.created_at)
  const saved = storage.snapshot()
  assert.deepEqual((await responseBody(await messageCall(storage, 'send', input))).event, first)
  assert.deepEqual(storage.snapshot(), saved)
  assert.equal((await messageCall(storage, 'send', { ...input, content: 'Conflicting synthetic note.' })).status, 409)
  assert.deepEqual(storage.snapshot(), saved)
  const thread = await responseBody(await messageCall(storage, 'thread', { conversationId: 'auma-pearl' }))
  assert.deepEqual(thread.turns, [legacy, first, second])
  assert.equal(JSON.stringify(thread).includes(saved.get('messages:v1').identity.secretKey), false)
})

test('signed state rejects signature, hash, replay metadata and private-identity tampering without repair', async () => {
  const storage = memoryStorage()
  await provisionMessagesIdentity(storage, { approved: true, now: () => FIXTURE_TIME })
  await messageCall(storage, 'send', { conversationId: 'auma-pearl', content: 'Integrity fixture.', requestId: 'integrity-1' })
  const original = await storage.get('messages:v1')
  for (const alter of [
    state => { state.turns[0].sig = '0'.repeat(128) },
    state => { state.turns[0].id = '0'.repeat(64) },
    state => { state.turns[0].requestId = 'different-request' },
    state => { state.identity.pubkey = '0'.repeat(64) },
    state => { state.identity.secretKey = '0'.repeat(64) },
    state => { delete state.identity },
  ]) {
    const changed = clone(original); alter(changed)
    const corrupt = memoryStorage([['messages:v1', changed]])
    const before = corrupt.snapshot()
    const response = await messageCall(corrupt, 'contacts.json')
    assert.equal(response.status, 503)
    assert.equal((await responseBody(response)).code, 'MESSAGES_STATE_CORRUPT')
    await assert.rejects(provisionMessagesIdentity(corrupt, { approved: true }), { code: 'MESSAGES_STATE_CORRUPT' })
    assert.deepEqual(corrupt.snapshot(), before)
  }
})

test('temporary local identity stays in private storage and signs after reopening', async t => {
  const fixture = await localFixture(t)
  const storage = createLocalMessagesStorage({ directory: fixture.directory })
  const identity = await provisionMessagesIdentity(storage, { approved: true, now: () => FIXTURE_TIME })
  const statePath = path.join(fixture.directory, 'messages.v1.json')
  assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(fixture.directory)).mode & 0o777, 0o700)
  const reopened = createLocalMessagesStorage({ directory: fixture.directory })
  assert.deepEqual((await responseBody(await messageCall(reopened, 'contacts.json'))).identity, identity)
  const event = (await responseBody(await messageCall(reopened, 'send', { conversationId: 'auma-pearl', content: 'Temporary key fixture.', requestId: 'private-storage-1' }))).event
  verifyNip01(event)
})

test('near-capacity signed and legacy reads retain their bounds and report validation cost', async t => {
  const blank = memoryStorage()
  await messageCall(blank, 'contacts.json')
  const initial = await blank.get('messages:v1')
  const signed = clone(initial), legacy = clone(initial)
  signed.identity = { version: 'aukora.messages.identity/v1', secretKey: VECTOR_SECRET, pubkey: VECTOR_PUBLIC, npub: bech32.encodeFromBytes('npub', raw(VECTOR_PUBLIC)) }
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
      : JSON.stringify(value)
  const hash = value => createHash('sha256').update(value).digest('hex')
  for (let index = 0; index < 512; index++) {
    const requestId = String(index), at = new Date(FIXTURE_TIME).toISOString(), conversationId = 'auma-pearl'
    const localTags = [['d', 'aukora-messages:' + conversationId], ['conversation', conversationId], ['protocol', 'microverse-local']]
    const turn = { id: '', idScheme: 'nip01-schnorr/v1', conversationId, requestId, content: 'x', at,
      created_at: Math.floor(FIXTURE_TIME / 1000), kind: 30078, tags: [...localTags, ['request', requestId], ['at', at]],
      pubkey: VECTOR_PUBLIC, sig: '', signatureStatus: 'signed', delivery: 'microverse-local', from: 'you', protocol: 'microverse-local' }
    turn.id = hash(JSON.stringify([0, turn.pubkey, turn.created_at, turn.kind, turn.tags, turn.content]))
    turn.sig = Buffer.from(schnorr.sign(raw(turn.id), raw(VECTOR_SECRET), new Uint8Array(32))).toString('hex')
    signed.turns.push(turn)
    if (Buffer.byteLength(JSON.stringify(signed)) > 112 * 1024) { signed.turns.pop(); break }
    const old = { ...turn, idScheme: 'aukora.messages.local/v1', pubkey: null, sig: null, signatureStatus: 'unavailable', tags: localTags }
    const { id: _id, ...binding } = old
    old.id = hash(canonical({ version: 'aukora.messages/v1', ...binding }))
    legacy.turns.push(old)
  }
  assert.ok(signed.turns.length > 150)
  assert.equal(signed.turns.length, legacy.turns.length)
  assert.ok(Buffer.byteLength(JSON.stringify(signed)) <= 112 * 1024)
  for (const [kind, state] of [['legacy', legacy], ['signed', signed]]) {
    const storage = memoryStorage([['messages:v1', state]])
    const before = process.memoryUsage(), started = performance.now()
    const response = await messageCall(storage, 'contacts.json')
    assert.equal(response.status, 200)
    await responseBody(response)
    const elapsedMs = performance.now() - started, after = process.memoryUsage()
    t.diagnostic(JSON.stringify({ kind, turns: state.turns.length, stateBytes: Buffer.byteLength(JSON.stringify(state)), elapsedMs: Number(elapsedMs.toFixed(2)), heapDeltaBytes: after.heapUsed - before.heapUsed, rssBytes: after.rss, rssDeltaBytes: after.rss - before.rss, processPeakRssKiB: process.resourceUsage().maxRSS }))
    assert.deepEqual(await storage.get('messages:v1'), state)
  }
})

test('real Worker and HeadDO require Class 3 approval even after isolated identity provisioning', async t => {
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  const before = await responseBody(await cloud.request(undefined, { path: '/aukora-messages/contacts.json' }))
  assert.equal(before.identity.signing, 'unavailable')
  assert.equal((await cloud.storage.get('messages:v1')).identity, undefined)
  const identity = await provisionMessagesIdentity(cloud.storage, { approved: true, now: () => FIXTURE_TIME })
  const saved = await cloud.storage.get('messages:v1')
  const response = await cloud.request({ conversationId: 'auma-pearl', content: 'Edge fixture note.', requestId: 'cloud-signed-1' }, { path: '/aukora-messages/send' })
  assert.equal(response.status, 403)
  assert.equal((await responseBody(response)).code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(await cloud.storage.get('messages:v1'), saved)
  cloud.recreate()
  const contacts = await responseBody(await cloud.request(undefined, { path: '/aukora-messages/contacts.json' }))
  assert.deepEqual(contacts.identity, identity)
  assert.equal(JSON.stringify(contacts).includes((await cloud.storage.get('messages:v1')).identity.secretKey), false)
  assert.equal(contacts.relay.connected, false)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('optional probe exposes only fixed outcomes and frozen head metadata', async t => {
  const absent = createWakeProbeRunner()
  t.after(() => absent.dispose())
  assert.deepEqual(await absent.run({ head: HEAD, now: FIXTURE_TIME }), { available: false, invoked: false, status: 'executor_unavailable' })
  for (const [value, status] of [[{ status: 'success' }, 'probe_succeeded'], [{ status: 'blocked' }, 'probe_blocked'], [{ status: 'failed' }, 'probe_failed'], [{ status: 'success', text: 'private fixture' }, 'probe_invalid'], [{ get status() { throw new Error('must not read accessor') } }, 'probe_invalid'], [null, 'probe_invalid']]) {
    const runner = createWakeProbeRunner({ runWakeProbe(input) {
      assert.deepEqual(Object.keys(input).sort(), ['head', 'now', 'signal'])
      assert.equal(Object.isFrozen(input), true); assert.equal(Object.isFrozen(input.head), true)
      assert.deepEqual(input.head, HEAD); assert.notEqual(input.head, HEAD)
      assert.equal(input.now, FIXTURE_TIME); assert.equal(input.signal.aborted, false)
      return value
    } })
    t.after(() => runner.dispose())
    assert.deepEqual(await runner.run({ head: HEAD, now: FIXTURE_TIME }), { available: true, invoked: true, status })
    assert.equal(runner.busy, false)
  }
  for (const runWakeProbe of [() => { throw new Error('secret failure fixture') }, () => Promise.reject(new Error('secret rejection fixture')), () => ({ then(_resolve, reject) { reject(new Error('secret thenable fixture')) } })]) {
    const runner = createWakeProbeRunner({ runWakeProbe })
    t.after(() => runner.dispose())
    assert.deepEqual(await runner.run({ head: null, now: FIXTURE_TIME }), { available: true, invoked: true, status: 'probe_failed' })
  }
})

test('probe timeout retains ownership until true settlement and ignores late success', async t => {
  const completion = deferred(), timers = manualTimers()
  let signal, calls = 0, elapsed = 0
  const runner = createWakeProbeRunner({ timeoutMs: 20, monotonicNow: () => elapsed, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    runWakeProbe(input) { calls++; signal = input.signal; return completion.promise } })
  t.after(async () => { completion.resolve({ status: 'success' }); await runner.dispose() })
  const request = runner.run({ head: HEAD, now: FIXTURE_TIME })
  elapsed = 20; await timers.fire()
  const result = await request
  assert.deepEqual(result, { available: true, invoked: true, status: 'probe_timeout' })
  assert.equal(signal.aborted, true); assert.equal(runner.busy, true)
  assert.equal((await runner.run({ head: HEAD, now: FIXTURE_TIME })).status, 'probe_busy')
  assert.equal(calls, 1)
  let quiescent = false
  const settlement = runner.whenSettled().then(() => { quiescent = true })
  await Promise.resolve(); assert.equal(quiescent, false)
  completion.resolve({ status: 'success' }); await settlement
  assert.equal(quiescent, true); assert.equal(runner.busy, false); assert.equal(result.status, 'probe_timeout')
})

test('probe monotonic deadline rejects success before a delayed timer can run', async t => {
  const timers = manualTimers()
  let elapsed = 0
  const runner = createWakeProbeRunner({ timeoutMs: 20, monotonicNow: () => elapsed, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    runWakeProbe() { elapsed = 21; return { status: 'success' } } })
  t.after(() => runner.dispose())
  assert.equal((await runner.run({ head: HEAD, now: FIXTURE_TIME })).status, 'probe_timeout')
  assert.equal(timers.size, 0); assert.equal(runner.busy, false)
})

test('probe disposal fences admission and awaits rejection after cancellation', async t => {
  const completion = deferred()
  let signal, calls = 0
  const runner = createWakeProbeRunner({ runWakeProbe(input) { signal = input.signal; calls++; return completion.promise } })
  t.after(async () => { completion.resolve({ status: 'success' }); await runner.dispose() })
  const request = runner.run({ head: null, now: FIXTURE_TIME })
  let disposed = false
  const disposal = runner.dispose().then(() => { disposed = true })
  assert.equal(signal.aborted, true)
  assert.equal((await request).status, 'probe_cancelled'); assert.equal(disposed, false)
  assert.equal((await runner.run({ head: null, now: FIXTURE_TIME })).status, 'probe_disposed')
  assert.equal(calls, 1)
  completion.reject(new Error('late private failure fixture')); await disposal
  assert.equal(disposed, true); assert.equal(runner.busy, false)
})

test('invalid probe options and unavailable clocks or timers never invoke the callback', async t => {
  for (const options of [{ runWakeProbe: true }, { timeoutMs: 0 }, { timeoutMs: 30001 }, { monotonicNow: null }]) assert.throws(() => createWakeProbeRunner(options))
  let calls = 0
  for (const options of [{ monotonicNow: () => NaN }, { setTimeout() { throw new Error('timer fixture') } }]) {
    const runner = createWakeProbeRunner({ ...options, runWakeProbe() { calls++; return { status: 'success' } } })
    t.after(() => runner.dispose())
    await assert.rejects(async () => runner.run({ head: HEAD, now: FIXTURE_TIME }))
    assert.equal(runner.busy, false)
  }
  const runner = createWakeProbeRunner({ runWakeProbe() { calls++; return { status: 'success' } } })
  t.after(() => runner.dispose())
  for (const input of [{ head: { ...HEAD, extra: true }, now: FIXTURE_TIME }, { head: HEAD, now: -1 }]) assert.throws(() => runner.run(input))
  assert.equal(calls, 0)
})

const CLIENT = '11111111-1111-4111-8111-111111111111'
async function envelope(entries, { seq = 1, cloudBase, clientId = CLIENT } = {}) {
  const batch = { id: `${clientId}:${seq}`, clientId, seq, entries, ...(cloudBase ? { cloudBase } : {}) }
  return { v: 2, batch, digest: await mirrorDigest(batch) }
}

test('local mirror emits bounded metadata only after durable publish, never replay or failure', async t => {
  const fixture = await localFixture(t), notices = [], applied = []
  const directory = path.join(fixture.root, 'mirror-fixture')
  const publisher = createMirrorPublisher({ directory, validateEntries: validateMirrorEntries, apply: async entries => { applied.push(...entries); return entries.length }, readSnapshot: async () => applied })
  const hooks = createLocalLiveUpdates({ mirrorPublisher: publisher, broadcast: value => notices.push(value) })
  const entries = Array.from({ length: 65 }, (_, index) => [`/dsh/home/fixture-${index}`, { kind: 'file', mode: 0o600, mtimeMs: FIXTURE_TIME, b64: Buffer.from('synthetic private content marker').toString('base64') }])
  const input = await envelope(entries), result = await hooks.publishMirror(input)
  assert.equal(result.ok, true); assert.equal(applied.length, 65); assert.equal(notices.length, 1)
  assert.equal(notices[0].type, 'mirror:updated'); assert.equal(notices[0].seq, 1)
  assert.equal(notices[0].changedPaths.length, 64); assert.equal(notices[0].changedPathsTruncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(notices[0])) < 16384)
  assert.equal(JSON.stringify(notices[0]).includes(entries[0][1].b64), false)
  const receipt = JSON.parse(await fs.readFile(path.join(directory, 'clients', CLIENT, '1.json'), 'utf8'))
  assert.equal(notices[0].acknowledgedAt, receipt.acknowledgedAt)
  assert.equal((await hooks.publishMirror(input)).replayed, true); assert.equal(notices.length, 1)
  assert.equal((await hooks.publishMirror(await envelope([['/dsh/home/other', { kind: 'gone' }]]))).ok, false)
  assert.equal(notices.length, 1)
  assert.equal((await hooks.publishMirror(await envelope([['/dsh/home/.ssh/id_ed25519', { kind: 'gone' }]], { seq: 2 }))).ok, false)
  assert.equal(notices.length, 1)
  const failing = createLocalLiveUpdates({ mirrorPublisher: createMirrorPublisher({ directory: path.join(fixture.root, 'failed-mirror'), validateEntries: validateMirrorEntries, apply: async () => 0 }), broadcast: value => notices.push(value) })
  assert.equal((await failing.publishMirror(await envelope([['/dsh/home/failure', { kind: 'gone' }]]))).ok, false)
  assert.equal(notices.length, 1)
  const unresponsive = createLocalLiveUpdates({ mirrorPublisher: publisher, broadcast: () => new Promise(() => {}) })
  assert.equal((await unresponsive.publishMirror(await envelope([['/dsh/home/another', { kind: 'gone' }]], { seq: 2 }))).ok, true)
})

test('local runtime hooks emit confirmed release changes with unknown build SHA and preserve CAS', async t => {
  const fixture = await localFixture(t), notices = []
  const runtime = createRuntimeHead({ repository: fixture.root, directory: path.join(fixture.root, 'runtime-fixture'), verifyRelease: async id => { if (!['a'.repeat(64), 'b'.repeat(64)].includes(id)) throw new Error('fixture release missing') } })
  const hooks = createLocalLiveUpdates({ runtimeHead: runtime, broadcast: value => notices.push(value) })
  const initial = await hooks.viewRuntime(); assert.equal(initial.selected.epoch, 0); assert.equal(notices.length, 0)
  const first = { operationId: '22222222-2222-4222-8222-222222222222', releaseId: 'a'.repeat(64), expectedEpoch: 0, expectedRecordId: null }
  const result = await hooks.selectRuntime(first)
  assert.equal(result.ok, true); assert.equal(result.booted, false)
  assert.deepEqual(notices, [{ type: 'runtime:updated', releaseId: first.releaseId, buildSha: null }])
  assert.equal((await hooks.selectRuntime(first)).replayed, true); await hooks.viewRuntime(); assert.equal(notices.length, 1)
  const stale = { ...first, operationId: '33333333-3333-4333-8333-333333333333', releaseId: 'b'.repeat(64) }
  assert.equal((await hooks.selectRuntime(stale)).code, 'RUNTIME_REBASE_REQUIRED'); assert.equal(notices.length, 1)
  const failed = { ...stale, expectedEpoch: 1, expectedRecordId: result.recordId, releaseId: 'c'.repeat(64) }
  assert.equal((await hooks.selectRuntime(failed)).ok, false); assert.equal(notices.length, 1)
  const external = await runtime.select({ ...failed, releaseId: 'b'.repeat(64) })
  assert.equal(external.ok, true); assert.equal(notices.length, 1, 'No watcher or forced refresh is installed')
  await hooks.viewRuntime(); assert.equal(notices.length, 2); assert.equal(notices[1].releaseId, external.releaseId)
  const hostile = createLocalLiveUpdates({ runtimeHead: runtime, broadcast() { throw new Error('fixture socket failure') } })
  await hostile.viewRuntime()
  assert.equal((await hostile.selectRuntime({ operationId: '44444444-4444-4444-8444-444444444444', releaseId: first.releaseId, expectedEpoch: external.epoch, expectedRecordId: external.recordId })).ok, true)
})

test('Worker mirror route notifies authenticated head peers only after new durable deltas', async t => {
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  const peer = cloud.connect(), stale = cloud.connect({ seedId: '0'.repeat(64) }), broken = cloud.connect({ throwing: true })
  const fence = await responseBody(await cloud.request(undefined, { path: '/_mirror/status' }))
  const input = await envelope([['/dsh/home/fixture-message.txt', { kind: 'file', mode: 0o600, mtimeMs: FIXTURE_TIME, b64: Buffer.from('synthetic cloud private marker').toString('base64') }]], { cloudBase: { lineageId: fence.lineageId, revision: fence.revision } })
  assert.equal((await cloud.request(input, { path: '/_mirror/delta', headers: { cookie: '' } })).status, 401)
  assert.equal(peer.messages.length, 0)
  const first = await responseBody(await cloud.request(input, { path: '/_mirror/delta' }))
  assert.equal(first.ok, true); await peer.waitForMessages(1); assert.equal(peer.messages.length, 1)
  assert.deepEqual(peer.messages[0], { type: 'mirror:updated', seq: 1, clientId: CLIENT, changedPaths: ['/dsh/home/fixture-message.txt'], changedPathsTruncated: false, acknowledgedAt: first.acknowledgedAt })
  assert.equal(stale.messages.length, 0); assert.equal(broken.messages.length, 0)
  assert.equal(JSON.stringify(peer.messages).includes(input.batch.entries[0][1].b64), false)
  assert.equal((await responseBody(await cloud.request(input, { path: '/_mirror/delta' }))).replayed, true)
  assert.equal(peer.messages.length, 1)
  const conflict = await envelope([['/dsh/home/changed.txt', { kind: 'gone' }]], { cloudBase: input.batch.cloudBase })
  assert.equal((await cloud.request(conflict, { path: '/_mirror/delta' })).status, 409)
  assert.equal(peer.messages.length, 1)
  assert.equal((await cloud.request(peer.messages[0], { path: '/_head/mirror-updated' })).status, 501, 'Internal notification is not a public Worker route')
  assert.equal((await cloud.direct(new Request(ORIGIN + '/_head/mirror-updated', { method: 'POST', headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': '0'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify(peer.messages[0]) }))).status, 503)
  assert.equal(peer.messages.length, 1)
})

test('Worker wake notifications follow committed mutations but not replay or failed scheduling', async t => {
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  const peer = cloud.connect()
  await cloud.request(); assert.equal(peer.messages.length, 0)
  const configured = await responseBody(await cloud.request({ action: 'configure', enabled: true, intervalMs: 60000 }))
  assert.equal(configured.ok, true); await peer.waitForMessages(1); assert.equal(peer.messages.length, 1)
  assert.equal(peer.messages[0].type, 'wake:updated'); assert.equal(peer.messages[0].wake.enabled, true)
  const first = await responseBody(await cloud.request({ action: 'trigger' }, { headers: { 'idempotency-key': 'notify-manual' } }))
  assert.equal(first.wakeCount, 1); await peer.waitForMessages(2); assert.equal(peer.messages.length, 2)
  assert.equal(first.aura, null, 'Missing metrics cannot generate a scored attention notification')
  assert.equal(peer.messages[1].wake.lastWakeOutcome, 'executor_unavailable')
  await cloud.request({ action: 'trigger' }, { headers: { 'idempotency-key': 'notify-manual' } })
  assert.equal(peer.messages.length, 2)
  cloud.storage.failAlarm(true)
  assert.equal((await cloud.request({ action: 'configure', enabled: false })).status, 503)
  assert.equal(peer.messages.length, 2)
  cloud.storage.failAlarm(false)
})

test('local probe claim survives timeout and reconstruction until true settlement', async t => {
  const completion = deferred(), started = deferred(), notices = []
  let calls = 0, elapsed = 0
  t.after(() => completion.resolve({ status: 'success' }))
  const fixture = await localFixture(t, { probeTimeoutMs: 20, monotonicNow: () => elapsed,
    runWakeProbe() { calls++; started.resolve(); return completion.promise }, onUpdated: value => notices.push(value) })
  const wake = fixture.create(), request = wake.trigger({ requestId: 'probe-timeout' })
  await started.promise
  const durable = await fixture.storage.transaction(tx => tx.get('wake:v1'))
  assert.equal(durable.pendingProbe.requestId, 'probe-timeout'); assert.equal(durable.wakeCount, 0)
  const reconstructed = fixture.create()
  assert.equal((await reconstructed.status()).code, 'LOCAL_WAKE_PROBE_RECOVERY_REQUIRED')
  await assert.rejects(reconstructed.trigger(), { code: 'LOCAL_WAKE_PROBE_RECOVERY_REQUIRED' })
  elapsed = 20; await fixture.timers.fire()
  const result = await request
  assert.equal(result.receipt.status, 'probe_timeout'); assert.equal(result.probePending, true)
  assert.equal(result.executor.status, 'probe_busy'); assert.equal(notices.length, 1)
  await assert.rejects(wake.trigger({ requestId: 'must-not-run' }), { code: 'LOCAL_WAKE_PROBE_BUSY' })
  assert.equal(calls, 1)
  assert.equal((await wake.trigger({ requestId: 'probe-timeout' })).replayed, true)
  let disposed = false
  const disposal = wake.dispose().then(() => { disposed = true })
  await Promise.resolve(); assert.equal(disposed, false)
  completion.resolve({ status: 'success' }); await disposal
  const settled = await fixture.storage.transaction(tx => tx.get('wake:v1'))
  assert.equal(settled.pendingProbe, undefined); assert.equal(settled.receipts[0].status, 'probe_timeout')
  assert.equal(settled.wakeCount, 1); assert.equal(calls, 1); assert.equal(fixture.timers.size, 0)
  const reopened = fixture.create({ runWakeProbe: undefined })
  assert.equal((await reopened.status()).ok, true)
})

test('local disposal during head lookup never starts optional probe work', async t => {
  const lookup = deferred(), started = deferred()
  let calls = 0
  t.after(() => lookup.resolve(HEAD))
  const fixture = await localFixture(t, { readHead: () => { started.resolve(); return lookup.promise }, runWakeProbe() { calls++; return { status: 'success' } } })
  const wake = fixture.create(), request = wake.trigger()
  await started.promise
  const disposal = wake.dispose()
  lookup.resolve(HEAD)
  await request; await disposal
  assert.equal(calls, 0)
  const state = await fixture.storage.transaction(tx => tx.get('wake:v1'))
  assert.equal(state.pendingProbe, undefined); assert.equal(state.receipts[0].executor.invoked, false)
  assert.equal(fixture.timers.size, 0)
})

test('local wake notifications omit private fields and follow schedule, alarm and committed probe results', async t => {
  const notices = []
  const hooks = createLocalLiveUpdates({ broadcast: value => { if (value.type === 'wake:updated') notices.push(value) } })
  const fixture = await localFixture(t, { onUpdated: hooks.wakeUpdated, runWakeProbe: () => ({ status: 'success' }) })
  const wake = fixture.create()
  await wake.status(); assert.equal(notices.length, 0)
  await wake.configure({ enabled: true }); assert.equal(notices.length, 1)
  fixture.advance(60000); await fixture.timers.fire()
  assert.equal(notices.length, 2); assert.equal(notices[1].wake.lastWakeOutcome, 'probe_succeeded')
  assert.equal(notices[1].wake.receipts[0].executor.invoked, true)
  assert.equal(JSON.stringify(notices).includes('pendingProbe'), false)
  assert.deepEqual(Object.keys(notices[1]).sort(), ['type', 'wake'])
  const first = await wake.trigger({ requestId: 'notification' })
  assert.equal(notices.length, 3)
  await wake.trigger({ requestId: 'notification' }); assert.equal(notices.length, 3)
  hooks.wakeUpdated({ ...first, privateText: 'private fixture', receipts: [{ ...first.receipts[0], secret: 'private fixture' }] })
  assert.equal(notices.length, 3)
})

test('edge probe runs once outside retriable transactions and notifications cannot block ACK', async t => {
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  let calls = 0, noticeCalls = 0
  const wake = createDurableWakeStore(cloud.storage, { now: () => FIXTURE_TIME, runWakeProbe() {
    calls++
    assert.ok(cloud.storage.snapshot().get('wake:probe-claim:v1'), 'Claim must already be durable')
    return { status: 'success' }
  }, onUpdated() { noticeCalls++; return new Promise(() => {}) } })
  t.after(() => wake.dispose())
  cloud.storage.retryTransaction()
  const result = await wake.trigger({ requestId: 'retry-safe' })
  assert.equal(result.receipt.status, 'probe_succeeded'); assert.equal(calls, 1)
  assert.equal(await cloud.storage.get('wake:probe-claim:v1'), undefined)
  assert.equal((await wake.trigger({ requestId: 'retry-safe' })).idempotent, true)
  assert.equal(calls, 1); assert.equal(noticeCalls, 1)
  await wake.configure({ enabled: true }); assert.equal(noticeCalls, 1, 'At most one unresolved optional notifier')
  assert.equal((await wake.trigger({ unexpected: true })).code, 'WAKE_REQUEST_INVALID')
})

test('edge probe timeout retains durable fencing through reconstruction and late settlement', async t => {
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  const completion = deferred(), started = deferred(), timers = manualTimers()
  let elapsed = 0, calls = 0
  const options = { now: () => FIXTURE_TIME, probeTimeoutMs: 20, monotonicNow: () => elapsed, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    runWakeProbe() { calls++; started.resolve(); return completion.promise } }
  const wake = createDurableWakeStore(cloud.storage, options)
  t.after(async () => { completion.resolve({ status: 'success' }); await wake.dispose() })
  const request = wake.trigger({ requestId: 'edge-timeout' })
  await started.promise
  const reconstructed = createDurableWakeStore(cloud.storage, options)
  t.after(() => reconstructed.dispose())
  assert.equal((await reconstructed.trigger()).code, 'WAKE_PROBE_BUSY')
  elapsed = 20; await timers.fire()
  const result = await request
  assert.equal(result.receipt.status, 'probe_timeout'); assert.equal(result.probePending, true)
  assert.equal((await wake.status()).executor.status, 'probe_busy')
  assert.equal((await wake.trigger()).code, 'WAKE_PROBE_BUSY'); assert.equal(calls, 1)
  let disposed = false
  const disposal = wake.dispose().then(() => { disposed = true })
  await Promise.resolve(); assert.equal(disposed, false)
  completion.resolve({ status: 'success' }); await disposal
  assert.equal(await cloud.storage.get('wake:probe-claim:v1'), undefined)
  assert.equal((await reconstructed.status()).receipts[0].status, 'probe_timeout')
  assert.equal(calls, 1); assert.equal(timers.size, 0)
})

test('edge probe failures preserve uncertain claims and never repeat callback effects', async t => {
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  let calls = 0
  const wake = createDurableWakeStore(cloud.storage, { now: () => FIXTURE_TIME, runWakeProbe() { calls++; cloud.storage.failPut('wake:v1'); return { status: 'success' } } })
  t.after(() => wake.dispose())
  cloud.storage.failPut('wake:probe-claim:v1')
  await assert.rejects(wake.trigger()); assert.equal(calls, 0)
  assert.equal(await cloud.storage.get('wake:probe-claim:v1'), undefined)
  cloud.storage.failPut(null)
  await assert.rejects(wake.trigger({ requestId: 'uncertain-result' })); assert.equal(calls, 1)
  assert.ok(await cloud.storage.get('wake:probe-claim:v1'))
  cloud.storage.failPut(null)
  const recreated = createDurableWakeStore(cloud.storage, { runWakeProbe() { calls++; return { status: 'success' } } })
  t.after(() => recreated.dispose())
  assert.equal((await recreated.trigger()).code, 'WAKE_PROBE_BUSY'); assert.equal(calls, 1)
  assert.equal((await recreated.status()).wakeCount, 0)
})

test('local head WebSocket requires an actual capability, not spoofable same-origin headers', () => {
  const policy = { sessionCapability: 'synthetic-capability', allowedOrigins: [LOCAL_ORIGIN], verifyHostAndOrigin: () => ({ ok: true }) }
  const call = (headers = {}, suffix = '', method = 'GET') => authorizeLocalHeadWebSocket({ method, headers: { host: new URL(LOCAL_ORIGIN).host, origin: LOCAL_ORIGIN, 'sec-fetch-site': 'same-origin', ...headers } }, new URL('/_head/ws' + suffix, LOCAL_ORIGIN), policy).ok
  assert.equal(call(), false)
  assert.equal(call({ referer: LOCAL_ORIGIN + '/' }), false)
  assert.equal(call({ 'x-x6-capability': 'wrong-fixture' }), false)
  assert.equal(call({ 'x-x6-capability': 'synthetic-capability' }), true)
  assert.equal(call({ cookie: '__x6_cap=synthetic-capability' }), true)
  assert.equal(call({}, '?cap=synthetic-capability'), true)
  assert.equal(call({}, '?cap=synthetic-capability&cap=other'), false)
  assert.equal(call({ cookie: '__x6_cap=synthetic-capability; __x6_cap=other' }), false)
  assert.equal(call({ 'x-x6-capability': 'synthetic-capability', origin: 'https://evil.invalid' }), false)
  assert.equal(call({ 'x-x6-capability': 'synthetic-capability', 'sec-fetch-site': 'cross-site' }), false)
  assert.equal(call({ 'x-x6-capability': 'synthetic-capability', host: 'evil.invalid' }), false)
  assert.equal(call({ 'x-x6-capability': 'synthetic-capability' }, '', 'POST'), false)
})

test('local invalidation broadcasting isolates failed, closed and backpressured peers', () => {
  const received = []
  const peer = { readyState: 1, bufferedAmount: 0, send: text => received.push(JSON.parse(text)) }
  const broken = { ...peer, send() { throw new Error('fixture peer failure') } }
  const closed = { ...peer, readyState: 3, send() { assert.fail('closed peer must not receive') } }
  const saturated = { ...peer, bufferedAmount: 256 * 1024 + 1, send() { assert.fail('saturated peer must not receive') } }
  broadcastLocalUpdate([broken, closed, saturated, peer], { type: 'runtime:updated', releaseId: 'a'.repeat(64), buildSha: null })
  assert.equal(received.length, 1); assert.equal(received[0].buildSha, null)
})

test('mirror invalidation bounds include JSON escaping and internal route rejects private payloads', async t => {
  const paths = Array.from({ length: 64 }, (_, index) => '/dsh/home/' + '"'.repeat(240) + index)
  const update = createMirrorUpdate({ seq: 1, clientId: CLIENT, acknowledgedAt: FIXTURE_TIME }, paths)
  assert.equal(update.changedPathsTruncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(update)) <= 16384)
  assert.ok(update.changedPaths.reduce((sum, value) => sum + Buffer.byteLength(value), 0) <= 8192)
  assert.deepEqual(validateMirrorUpdate(update), update)
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  const peer = cloud.connect()
  const send = value => cloud.direct(new Request(ORIGIN + '/_head/mirror-updated', { method: 'POST', headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': cloud.seed.seedId }, body: JSON.stringify(value) }))
  for (const invalid of [{ ...update, content: 'private fixture' }, { ...update, changedPaths: ['/dsh/home/.ssh/key'] }, { ...update, changedPaths: ['/dsh/home/a', '/dsh/home/a'] }, { ...update, seq: -1 }]) {
    assert.equal((await send(invalid)).status, 400)
  }
  assert.equal((await send({ ...update, content: 'x'.repeat(16384) })).status, 413)
  assert.equal(peer.messages.length, 0)
})

test('local probe persistence failures do not invoke early or clear uncertain effects', async t => {
  const fixture = await localFixture(t)
  let rejectPut = true, calls = 0
  const storage = { transaction: operation => fixture.storage.transaction(tx => operation({ ...tx, put: async (...args) => { if (rejectPut) throw new Error('synthetic write failure'); return tx.put(...args) } })) }
  const create = () => createLocalWakeScheduler({ storage, readHead: async () => HEAD, now: fixture.now, runWakeProbe() { calls++; rejectPut = true; return { status: 'success' } } })
  const beforeClaim = create()
  t.after(() => beforeClaim.dispose())
  await assert.rejects(beforeClaim.trigger()); assert.equal(calls, 0)
  assert.equal(await fixture.storage.transaction(tx => tx.get('wake:v1')), undefined)
  await beforeClaim.dispose(); rejectPut = false
  const afterCallback = create()
  t.after(() => afterCallback.dispose())
  await assert.rejects(afterCallback.trigger()); assert.equal(calls, 1)
  const uncertain = await fixture.storage.transaction(tx => tx.get('wake:v1'))
  assert.ok(uncertain.pendingProbe); assert.equal(uncertain.wakeCount, 0)
  rejectPut = false
  const reopened = fixture.create()
  assert.equal((await reopened.status()).code, 'LOCAL_WAKE_PROBE_RECOVERY_REQUIRED')
  await assert.rejects(reopened.trigger(), { code: 'LOCAL_WAKE_PROBE_RECOVERY_REQUIRED' })
  assert.equal(calls, 1)
})

test('a nonsettling local notifier is single-flight and never blocks committed wake work', async t => {
  let notices = 0
  const fixture = await localFixture(t, { onUpdated() { notices++; return new Promise(() => {}) } })
  const wake = fixture.create()
  await wake.configure({ enabled: true })
  await wake.trigger({ requestId: 'first' })
  await wake.trigger({ requestId: 'second' })
  assert.equal((await wake.status()).wakeCount, 2)
  assert.equal(notices, 1)
  await wake.dispose()
})

const auraInputs = (overrides = {}) => ({
  computedAt: FIXTURE_TIME, ballId: HEAD.ballId, epoch: HEAD.epoch,
  reachableDagNodes: 7, declaredDagNodes: 7, verifiedReceipts: 64, totalReceipts: 64,
  activeOrgans: 20, declaredOrgans: 20, observedSurpriseScores: [], handOffEpochMismatch: false,
  unanchoredPredictions: 0, pendingWakes: 0, lastRollbackAgeEpochs: 10, staleHeartbeatRatio: 0,
  ...overrides,
})

test('aura rules compute deterministic finite vectors and exact priority thresholds', () => {
  const clean = computeAura(auraInputs())
  assert.equal(validateAuraVector(clean), true)
  assert.deepEqual(clean.vector, { coherence: 1, surprisePressure: 0, driftRisk: 0, wakeUrgency: 0 })
  assert.equal(clean.recommendedFocus, 'rest'); assert.equal(clean.authorityTier, 'peripheral-hint')
  assert.deepEqual(computeAura(auraInputs()), clean)
  const inputs = auraInputs({ observedSurpriseScores: [1000, 1, 2, 3, 4, 5], reachableDagNodes: 3, declaredDagNodes: 4, verifiedReceipts: 1, totalReceipts: 2, activeOrgans: 2, declaredOrgans: 4 })
  const before = clone(inputs), partial = computeAura(inputs)
  assert.deepEqual(inputs, before)
  assert.equal(partial.vector.coherence, 0.75 * 0.5 * 0.5)
  assert.equal(partial.vector.surprisePressure, Math.tanh(3 / 25), 'Only last five observations count')
  assert.equal(partial.recommendedFocus, 'consolidate')
  assert.equal(computeAura(auraInputs({ observedSurpriseScores: [10] })).recommendedFocus, 'observe')
  assert.equal(computeAura(auraInputs({ handOffEpochMismatch: true, observedSurpriseScores: [10] })).recommendedFocus, 'verify')
  const escalation = computeAura(auraInputs({ handOffEpochMismatch: true, unanchoredPredictions: 1 }))
  assert.equal(escalation.vector.driftRisk, 0.8); assert.equal(escalation.recommendedFocus, 'escalate-to-owner')
  assert.equal(computeAura(auraInputs({ staleHeartbeatRatio: 0.7 })).recommendedFocus, 'escalate-to-owner')
  assert.equal(computeAura(auraInputs({ pendingWakes: 2, lastRollbackAgeEpochs: 2 })).vector.driftRisk, 0.30000000000000004)
  assert.equal(computeAura(auraInputs({ staleHeartbeatRatio: 50 })).vector.wakeUrgency, 1)
})

test('aura corruption fails safe and neither supplied authority nor forged vectors are accepted', () => {
  for (const overrides of [{ reachableDagNodes: NaN }, { verifiedReceipts: Infinity }, { staleHeartbeatRatio: -1 }, { observedSurpriseScores: [1, NaN] }, { handOffEpochMismatch: 'false' }, { declaredOrgans: undefined }, { reachableDagNodes: 14, verifiedReceipts: 32 }, { verifiedReceipts: 65 }, { activeOrgans: 21 }, { observedSurpriseScores: Array(10001).fill(0) }]) {
    assert.throws(() => computeAura(auraInputs(overrides)), { code: 'AURA_INPUTS_INCOMPLETE' })
  }
  const actual = computeAura(auraInputs({ authorityTier: 'owner-confirmed', vector: { coherence: 1 }, recommendedFocus: 'rest' }))
  assert.equal(actual.authorityTier, 'peripheral-hint')
  for (const invalid of [{ ...actual, authorityTier: 'owner-confirmed' }, { ...actual, ownerGrant: {} }, { ...actual, scorer: 'model-v1' }, { ...actual, vector: { ...actual.vector, coherence: NaN } }, { ...actual, recommendedFocus: 'promote' }, { ...actual, salience: [{ kind: 'clean-state', targetId: HEAD.ballId, score: 1, code: 'free form prose' }] }]) {
    assert.equal(validateAuraVector(invalid), false)
  }
  for (const metadata of [{ ballId: 'invented-head' }, { epoch: -1 }, { computedAt: Infinity }]) assert.throws(() => computeAura(auraInputs(metadata)))
})

test('aura salience is bounded, deterministic and carries no execution authority', () => {
  const result = computeAura(auraInputs({ reachableDagNodes: 1, declaredDagNodes: 7, verifiedReceipts: 1, totalReceipts: 64, activeOrgans: 1, declaredOrgans: 20,
    observedSurpriseScores: [100], handOffEpochMismatch: true, unanchoredPredictions: 2, pendingWakes: 3, lastRollbackAgeEpochs: 1, staleHeartbeatRatio: 0.8 }))
  assert.equal(result.salience.length, 3)
  for (const [index, item] of result.salience.entries()) {
    assert.deepEqual(Object.keys(item).sort(), ['code', 'kind', 'score', 'targetId'])
    assert.equal(item.targetId, HEAD.ballId)
    assert.ok(item.score >= 0 && item.score <= 1)
    if (index) assert.ok(result.salience[index - 1].score >= item.score)
  }
  assert.equal(result.authorityTier, 'peripheral-hint')
  assert.equal(Object.hasOwn(result, 'ownerGrant'), false)
  assert.deepEqual(computeAura(auraInputs({ reachableDagNodes: 1, declaredDagNodes: 7, verifiedReceipts: 1, totalReceipts: 64, activeOrgans: 1, declaredOrgans: 20,
    observedSurpriseScores: [100], handOffEpochMismatch: true, unanchoredPredictions: 2, pendingWakes: 3, lastRollbackAgeEpochs: 1, staleHeartbeatRatio: 0.8 })), result)
})

test('local aura rest records a no-op without invoking a probe and replay does not rescore', async t => {
  let probes = 0, reads = 0
  const fixture = await localFixture(t, { readAuraInputs() { reads++; return auraInputs({ ballId: 'f'.repeat(64), epoch: 99, computedAt: 0, authorityTier: 'owner-confirmed' }) }, runWakeProbe() { probes++; return { status: 'success' } } })
  const wake = fixture.create(), result = await wake.trigger({ requestId: 'rest-hint' })
  assert.equal(result.receipt.status, 'probe_skipped_rest'); assert.equal(result.receipt.executor.invoked, false)
  assert.equal(probes, 0); assert.equal(reads, 1)
  assert.equal(result.aura.authorityTier, 'peripheral-hint'); assert.equal(result.aura.ballId, HEAD.ballId)
  assert.equal(result.aura.epoch, HEAD.epoch); assert.equal(result.aura.computedAt, FIXTURE_TIME)
  assert.equal(result.aura.recommendedFocus, 'rest')
  const state = await fixture.storage.transaction(tx => tx.get('wake:v1'))
  assert.deepEqual(state['aura:latest'], result.aura)
  assert.equal((await wake.trigger({ requestId: 'rest-hint' })).replayed, true)
  assert.equal(reads, 1); assert.equal(probes, 0)
})

test('local aura emits an attention-only urgent frame after durable commit', async t => {
  const notices = []
  const hooks = createLocalLiveUpdates({ broadcast: value => notices.push(value) })
  const fixture = await localFixture(t, { readAuraInputs: () => auraInputs({ staleHeartbeatRatio: 0.8 }), onUpdated: hooks.wakeUpdated })
  const wake = fixture.create(), result = await wake.trigger()
  assert.equal(result.aura.recommendedFocus, 'escalate-to-owner')
  assert.deepEqual(notices.map(item => item.type), ['wake:updated', 'wake.changed'])
  assert.deepEqual(notices[1].aura, { wakeUrgency: 0.8, recommendedFocus: 'escalate-to-owner', authorityTier: 'peripheral-hint' })
  assert.equal(result.receipt.executor.invoked, false)
  assert.equal((await fixture.storage.transaction(tx => tx.get('wake:v1'))).wakeCount, 1)
  assert.equal(JSON.stringify(notices).includes('ownerGrant'), false)
})

test('local G6 pauses after three automatic ticks and only explicit resume clears the limit', async t => {
  let probes = 0
  const fixture = await localFixture(t, { readAuraInputs: () => auraInputs(), runWakeProbe() { probes++; return { status: 'success' } } })
  const wake = fixture.create()
  await wake.configure({ enabled: true })
  for (let index = 1; index <= 3; index++) {
    fixture.advance(60000); await fixture.timers.fire()
    assert.equal((await wake.status()).consecutiveUnacknowledgedWakes, index)
  }
  const paused = await wake.status()
  assert.equal(paused.enabled, false); assert.equal(paused.autoPaused, true); assert.equal(paused.nextWakeAt, null)
  assert.equal(fixture.timers.size, 0); assert.equal(probes, 0)
  await wake.trigger({ requestId: 'explicit-manual' })
  assert.equal((await wake.status()).consecutiveUnacknowledgedWakes, 3)
  await wake.configure({ intervalMs: 120000 }); assert.equal((await wake.status()).autoPaused, true)
  await wake.configure({ enabled: true })
  assert.equal((await wake.status()).consecutiveUnacknowledgedWakes, 0); assert.equal((await wake.status()).autoPaused, false)
  await wake.configure({ enabled: false }); assert.equal(fixture.timers.size, 0)
})

test('local status aliases expose validated aura only through the explicit wake reader seam', async t => {
  const fixture = await localFixture(t), wake = fixture.create({ readAuraInputs: () => auraInputs() })
  await wake.trigger()
  const messages = createLocalMessagesStorage({ directory: path.join(fixture.root, 'status-messages') })
  const policy = { storage: messages, sessionCapability: 'synthetic-capability', allowedOrigins: [LOCAL_ORIGIN], verifyHostAndOrigin: () => ({ ok: true }), readStatus: async () => ({ ok: true, head: HEAD, prediction: null }) }
  const handler = (await import('./messages-store.mjs')).createLocalMessagesRequestHandler({ ...policy, readWake: () => wake.status() })
  for (const route of ['/__x6/status', '/api/x61/status']) {
    const response = await handler(localRequest(undefined), new URL(route, LOCAL_ORIGIN))
    const status = await responseBody(response)
    assert.equal(status.head.ballId, HEAD.ballId); assert.equal(validateAuraVector(status.aura), true)
    assert.equal(status.aura.authorityTier, 'peripheral-hint'); assert.equal(status.wake.wakeCount, 1)
    assert.ok(Object.hasOwn(status, 'nostr'))
  }
  const forged = (await import('./messages-store.mjs')).createLocalMessagesRequestHandler({ ...policy, readWake: async () => ({ ...(await wake.status()), aura: { ...computeAura(auraInputs()), authorityTier: 'owner-confirmed' } }) })
  assert.equal((await responseBody(await forged(localRequest(undefined), new URL('/__x6/status', LOCAL_ORIGIN)))).aura, null)
  const stale = (await import('./messages-store.mjs')).createLocalMessagesRequestHandler({ ...policy, readStatus: async () => ({ ok: true, head: { ballId: 'f'.repeat(64), epoch: HEAD.epoch + 1 } }), readWake: () => wake.status() })
  const staleStatus = await responseBody(await stale(localRequest(undefined), new URL('/__x6/status', LOCAL_ORIGIN)))
  assert.equal(staleStatus.aura, null); assert.equal(staleStatus.wake.aura, null)
})

test('edge aura skip and G6 pause preserve selected HEAD and never grant authority', async t => {
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  let now = FIXTURE_TIME, probes = 0
  const before = await cloud.storage.get('head')
  const wake = createDurableWakeStore(cloud.storage, { now: () => now, readAuraInputs: () => auraInputs(), runWakeProbe() { probes++; return { status: 'success' } } })
  t.after(() => wake.dispose())
  await wake.configure({ enabled: true })
  for (let index = 1; index <= 3; index++) {
    now += 60000
    const result = await wake.alarm()
    assert.equal(result.receipt.status, 'probe_skipped_rest'); assert.equal(result.consecutiveUnacknowledgedWakes, index)
    assert.equal(validateAuraVector(result.aura), true); assert.equal(result.aura.authorityTier, 'peripheral-hint')
  }
  const status = await wake.status()
  assert.equal(status.enabled, false); assert.equal(status.autoPaused, true); assert.equal(await cloud.storage.getAlarm(), null)
  assert.equal((await wake.alarm()).skipped, 'disabled'); assert.equal(status.wakeCount, 3)
  assert.equal(probes, 0); assert.equal(await cloud.storage.get('head'), before)
  assert.deepEqual(await cloud.storage.get('aura:latest'), status.aura)
  await wake.trigger(); assert.equal((await wake.status()).consecutiveUnacknowledgedWakes, 3)
  await wake.configure({ enabled: true }); assert.equal((await wake.status()).consecutiveUnacknowledgedWakes, 0)
})

test('missing edge verification facts fail safe and stored healthy aura cannot suppress a probe', async t => {
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  let probes = 0
  const wake = createDurableWakeStore(cloud.storage, { now: () => FIXTURE_TIME, runWakeProbe() { probes++; return { status: 'success' } } })
  t.after(() => wake.dispose())
  await cloud.storage.transaction(tx => tx.put('aura:latest', computeAura(auraInputs({ ballId: cloud.ball.ballId, epoch: cloud.ball.epoch }))))
  const result = await wake.trigger()
  assert.equal(probes, 1); assert.equal(result.aura, null)
  assert.equal(await cloud.storage.get('aura:latest'), null)
  assert.equal(await cloud.storage.get('head'), cloud.ball.ballId)
})

test('bounded aura reader timeout retains durable fencing and does not start a probe', async t => {
  const cloud = await cloudFixture(t)
  await cloud.bootstrap()
  const completion = deferred(), started = deferred(), timers = manualTimers()
  let elapsed = 0, probes = 0
  const wake = createDurableWakeStore(cloud.storage, { now: () => FIXTURE_TIME, auraTimeoutMs: 20, monotonicNow: () => elapsed, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    readAuraInputs() { started.resolve(); return completion.promise }, runWakeProbe() { probes++; return { status: 'success' } } })
  t.after(async () => { completion.resolve(auraInputs()); await wake.dispose() })
  const operation = wake.trigger()
  await started.promise
  assert.ok(await cloud.storage.get('wake:probe-claim:v1'))
  elapsed = 20; await timers.fire()
  const result = await operation
  assert.equal(result.aura, null); assert.equal(result.probePending, true); assert.equal(probes, 0)
  assert.equal((await wake.trigger()).code, 'WAKE_PROBE_BUSY')
  completion.resolve(auraInputs()); await wake.dispose()
  assert.equal(await cloud.storage.get('wake:probe-claim:v1'), undefined)
  assert.equal(await cloud.storage.get('aura:latest'), null, 'Late inputs cannot replace committed unknown evidence')
})

// Runtime adapters and direct scoring must not disagree about admitted observation lists.
test('aura reader and pure scorer share the bounded observation limit', async t => {
  for (const length of [1025, 10000, 10001]) {
    const inputs = auraInputs({ observedSurpriseScores: Array(length).fill(0) })
    const reader = createWakeAuraReader({ readAuraInputs: async () => inputs })
    t.after(() => reader.dispose())
    if (length > 10000) {
      assert.equal(await reader.read({ head: HEAD, now: FIXTURE_TIME }), null)
      assert.throws(() => computeAura(inputs), { code: 'AURA_INPUTS_INCOMPLETE' })
    } else assert.deepEqual(await reader.read({ head: HEAD, now: FIXTURE_TIME }), computeAura(inputs))
  }
})

const fixtureAuraHash = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
const fixtureWakeMetadata = () => ({ ok: true, enabled: false, intervalMs: 60000, lastWakeAt: null,
  wakeCount: 0, nextWakeAt: null, consecutiveUnacknowledgedWakes: 0, probePending: false })

async function localAuraFixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'x61-aura-fixture-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const headBody = { version: 'x6.1-ball/v1', parentBallId: 'b'.repeat(64), epoch: 12,
    entries: { fixture: { id: 'fixture', specifier: 'fixture:only', disabled: false, config: {}, previousSpecifiers: [] } }, modules: {} }
  const head = { ...headBody, ballId: fixtureAuraHash(headBody) }
  const nodeBody = { content: 'Synthetic aura memory only', createdAt: FIXTURE_TIME, parentIds: [] }
  const node = { ...nodeBody, id: fixtureAuraHash(nodeBody) }
  const write = async (relative, content) => {
    const target = path.join(root, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content))
  }
  let receiptRows = []
  const receipts = async values => {
    let previous = '0'.repeat(64)
    receiptRows = values.map(({ kind, data }, index) => {
      const body = { schema: 'aukora.receipt.v3', seq: index + 1, at: new Date(FIXTURE_TIME).toISOString(), prevHash: previous, kind, data }
      previous = createHash('sha256').update(Buffer.from([0])).update(canonicalJson(body)).digest('hex')
      return { ...body, leafHash: previous }
    })
    await write('home/auma/seed/receipts.v3.jsonl', receiptRows.map(row => JSON.stringify(row)).join('\n') + (receiptRows.length ? '\n' : ''))
    return receiptRows
  }
  const memoryReceipt = { kind: 'memory.dag.append', data: { nodeId: node.id, content: node.content } }
  await write('balls/HEAD.json', head)
  await write('home/auma/HANDOFF.md', `| epoch | **${head.epoch}** |\n| ballId | \`${head.ballId}\` |\n`)
  await write('home/auma/memory/dag/HEAD.json', { heads: [node.id], count: 1 })
  await write(`home/auma/memory/dag/nodes/${node.id}.json`, node)
  await receipts([memoryReceipt])
  await write('home/auma/seed/discovery-corpus.v1.jsonl', '')
  await write('home/auma/superagent/state.json', { assignments: [] })
  return { root, head, node, write, receipts, memoryReceipt, get receiptRows() { return receiptRows },
    read: (options = {}) => readLocalAuraInputs({ mirrorDirectory: root, now: FIXTURE_TIME, wake: Object.freeze(fixtureWakeMetadata()), ...options }) }
}

function assertIncompleteAura(value, code) {
  assert.equal(value.evidence.status, 'incomplete')
  assert.equal(value.auraShadow.status, 'incomplete')
  assert.equal(value.auraShadow.focus, null)
  assert.equal(value.auraShadow.inputEvidence, null)
  assert.equal(value.aura.status, 'incomplete')
  assert.equal(value.aura.authorityTier, 'peripheral-hint')
  assert.equal(value.aura.vector, null)
  assert.equal(value.aura.recommendedFocus, 'verify')
  assert.equal(Object.hasOwn(value, 'verifiedReceipts'), false, 'Incomplete evidence cannot feed healthy scorer metrics')
  if (code) assert.ok(value.evidence.gaps.some(gap => gap.startsWith(code)), value.evidence.gaps.join(','))
}

test('local aura recomputes synthetic mirror evidence without exposing source bodies or claiming organ health', async t => {
  const fixture = await localAuraFixture(t)
  const result = await fixture.read({ head: fixture.head })
  assert.equal(result.evidence.status, 'complete')
  assert.equal(result.evidence.dagLayout, 'nodes')
  assert.equal(result.aura.status, 'calm')
  assert.equal(result.reachableDagNodes, 1); assert.equal(result.verifiedReceipts, 1)
  assert.equal(result.aura.vector.coherence, 1)
  assert.equal(result.auraShadow.status, 'complete')
  assert.equal(result.auraShadow.focus, 'rest')
  assert.equal(result.auraShadow.baselineComparison.status, 'agrees')
  assert.equal(result.auraShadow.ballId, fixture.head.ballId)
  assert.equal(result.auraShadow.epoch, fixture.head.epoch)
  assert.equal(result.auraShadow.computedAt, FIXTURE_TIME)
  assert.equal(result.auraShadow.role, 'diagnostic-only')
  assert.equal(validateAuraVector(result.auraShadow), false)
  assert.equal(result.aura.selectionIsNotHealthProof, true)
  assert.equal(result.evidence.organCounts, 'declared-enabled-not-runtime-health')
  assert.equal(JSON.stringify(result).includes(fixture.node.content), false)
  assert.equal(JSON.stringify(result).includes(fixture.node.id), false)
  assert.deepEqual(result.aura.vector, computeAura({ ...result, computedAt: FIXTURE_TIME, ...fixture.head }).vector)
  assertIncompleteAura(await fixture.read({ wake: undefined }), 'AURA_WAKE_UNKNOWN')
  assertIncompleteAura(await fixture.read({ head: { ballId: 'f'.repeat(64), epoch: 12 } }), 'AURA_HEAD_CHANGED')
  await fixture.write('home/auma/HANDOFF.md', `| epoch | **11** |\n| ballId | \`${fixture.head.ballId}\` |\n`)
  const drift = await fixture.read()
  assert.equal(drift.aura.status, 'strained'); assert.equal(drift.aura.vector.driftRisk, 0.4)
  assert.equal(drift.auraShadow.focus, 'verify')
  assert.equal(drift.auraShadow.baselineComparison.status, 'agrees')
})

test('local status exposes the focus shadow without making it a wake decision or storing a result', async t => {
  const fixture = await localAuraFixture(t)
  const input = await fixture.read({ head: fixture.head })
  const handler = createLocalMessagesRequestHandler({ sessionCapability: 'synthetic-capability', allowedOrigins: [LOCAL_ORIGIN],
    verifyHostAndOrigin: () => ({ ok: true }),
    readStatus: async () => ({ ok: true, head: fixture.head, aura: input.aura, auraShadow: input.auraShadow }) })
  const request = { method: 'GET', headers: { host: new URL(LOCAL_ORIGIN).host, 'x-x6-capability': 'synthetic-capability' } }
  for (const route of ['/__x6/status', '/api/x61/status']) {
    const result = await responseBody(await handler(request, new URL(route, LOCAL_ORIGIN)))
    assert.deepEqual(result.auraShadow, input.auraShadow)
    assert.deepEqual(result.aura, input.aura)
  }
  const forged = { ...input, auraShadow: { focus: 'escalate-to-owner', authorityTier: 'owner', granted: true } }
  const reader = createWakeAuraReader({ readAuraInputs: async () => forged })
  t.after(() => reader.dispose())
  const wakeAura = await reader.read({ head: { ballId: fixture.head.ballId, epoch: fixture.head.epoch }, now: FIXTURE_TIME })
  assert.equal(wakeAura.recommendedFocus, 'rest')
  assert.equal(Object.hasOwn(wakeAura, 'auraShadow'), false)
  assert.deepEqual(await fixture.read({ head: fixture.head }), input)
})

test('local facts reuse coherent bounded snapshots and reject absent or corrupt checkpoints', async t => {
  const fixture = await localAuraFixture(t)
  assert.equal(projectVerifiedFacts('local', await fixture.read({ includeFacts: true })).ok, false)
  await fixture.write('home/auma/seed/checkpoints.v1.jsonl', '')
  const input = await fixture.read({ includeFacts: true })
  const facts = projectVerifiedFacts('local', input)
  assert.equal(facts.ok, true); assert.equal(facts.receiptsVerified, 1)
  assert.equal(facts.checkpointsTotal, 0); assert.equal(facts.lastCheckpointSeq, null)
  assert.equal(facts.organCount, 1); assert.equal(facts.dagReachable, 1)
  assert.equal(JSON.stringify(facts).includes(fixture.node.content), false)
  assert.deepEqual(facts, projectVerifiedFacts('local', await fixture.read({ includeFacts: true })))
  await fixture.write('home/auma/seed/checkpoints.v1.jsonl', '{}\n')
  assertIncompleteAura(await fixture.read({ includeFacts: true }), 'AURA_CHECKPOINT_INVALID')
  await fixture.write('home/auma/seed/checkpoints.v1.jsonl', ' '.repeat(2 * 1024 * 1024))
  assertIncompleteAura(await fixture.read({ includeFacts: true }), 'AURA_BYTE_LIMIT')
})

test('local facts routes require capabilities and exact GET requests before reading evidence', async () => {
  let reads = 0
  const handler = createLocalMessagesRequestHandler({ sessionCapability: 'synthetic-capability', allowedOrigins: [LOCAL_ORIGIN],
    verifyHostAndOrigin: () => ({ ok: true }), readFacts: async () => { reads++; return projectVerifiedFacts('local', null) } })
  for (const route of ['/__x6/facts', '/api/x61/facts']) {
    const request = { method: 'GET', headers: { host: new URL(LOCAL_ORIGIN).host, 'x-x6-capability': 'synthetic-capability' } }
    const url = new URL(route, LOCAL_ORIGIN)
    assert.equal((await handler({ ...request, headers: { host: request.headers.host } }, url)).status, 403)
    assert.equal((await handler({ ...request, method: 'DELETE' }, url)).status, 405)
    assert.equal((await handler(request, new URL(route + '?x=1', LOCAL_ORIGIN))).status, 400)
    assert.equal((await handler({ ...request, headers: { ...request.headers, 'content-length': '1' } }, url)).status, 400)
    const before = reads
    assert.equal((await handler(request, url)).status, 503)
    assert.equal(reads, before + 1)
  }
  assert.equal(reads, 2)
})

test('local facts discard checkpoint counts when the checkpoint source changes during collection', async t => {
  const fixture = await localAuraFixture(t), lstat = fs.lstat
  await fixture.write('home/auma/seed/checkpoints.v1.jsonl', '')
  let replaced = false
  t.mock.method(fs, 'lstat', async function (file, ...args) {
    const result = await lstat.call(fs, file, ...args)
    if (!replaced && file === path.join(fixture.root, 'home/auma/seed/discovery-corpus.v1.jsonl')) {
      replaced = true
      await fixture.write('home/auma/seed/checkpoints.v1.jsonl', '{}\n')
    }
    return result
  })
  const input = await fixture.read({ includeFacts: true })
  assertIncompleteAura(input, 'AURA_SNAPSHOT_CHANGED')
  assert.equal(projectVerifiedFacts('local', input).checkpointsTotal, null)
})

test('an overdue enabled wake schedule raises the same pulse on host and browser readers', async t => {
  const fixture = await localAuraFixture(t)
  const browserOf = (wake, extra = {}) => projectAura({ computedAt: FIXTURE_TIME, dagHead: { heads: [fixture.node.id], count: 1 }, dagNodes: [fixture.node],
    handoffText: `| epoch | **${fixture.head.epoch}** |\n| ballId | \`${fixture.head.ballId}\` |\n`, observationScores: [],
    unanchoredPredictions: 0, pendingWakes: 0, staleHeartbeatRatio: 0, staleTickets: 0, wake, ...extra }, fixture.receiptRows, fixture.head)
  const agree = (host, browser, label) => {
    assert.equal(host.evidence.status, 'complete', label); assert.equal(browser.auraStatus, 'recomputed-verified', label)
    assert.equal(browser.status, host.aura.status, label)
    for (const axis of ['coherence', 'surprisePressure', 'driftRisk', 'wakeUrgency']) assert.equal(browser[axis], host.aura.vector[axis], `${label} ${axis}`)
    assert.equal(browser.recommendedFocus, host.aura.recommendedFocus, label)
    assert.deepEqual(browser.salience, host.aura.salience.map(({ kind, score }) => ({ kind, score })), label)
  }
  const cases = [
    ['on time', { enabled: true, nextWakeAt: FIXTURE_TIME + 30000 }, 0, 'calm'],
    ['a quarter interval late', { enabled: true, nextWakeAt: FIXTURE_TIME - 15000 }, 0.25, 'attentive'],
    ['ten intervals late', { enabled: true, nextWakeAt: FIXTURE_TIME - 10 * 60000 }, 1, 'alert'],
    ['disabled', { enabled: false, nextWakeAt: null }, 0, 'calm'],
  ]
  for (const [label, fields, ratio, status] of cases) {
    const wake = Object.freeze({ ...fixtureWakeMetadata(), ...fields })
    assert.equal(overdueWakeRatio(wake, FIXTURE_TIME), ratio, label)
    const host = await fixture.read({ wake })
    assert.equal(host.overdueWakeRatio, ratio, label); assert.equal(host.staleHeartbeatRatio, ratio, label)
    assert.equal(host.aura.status, status, label)
    agree(host, browserOf(wake), label)
  }
  const late = Object.freeze({ ...fixtureWakeMetadata(), enabled: true, nextWakeAt: FIXTURE_TIME - 30000 })
  const stuck = { id: 'asg_fixture', ticketId: 'tkt_fixture', state: 'running', startedAt: FIXTURE_TIME - 3 * STALE_HEARTBEAT_MS,
    heartbeatAt: FIXTURE_TIME - STALE_HEARTBEAT_MS - 1, reports: [] }
  await fixture.write('home/auma/superagent/state.json', { assignments: [stuck] })
  const worse = await fixture.read({ wake: late })
  assert.equal(worse.staleHeartbeatRatio, 1, 'the worse of a stuck assignment and an overdue wake wins')
  agree(worse, browserOf(late, staleHeartbeatFacts([stuck], FIXTURE_TIME)), 'stuck and late')
  // Cloudflare's HEAD DO says an enabled schedule has no alarm: a pulse that will never come.
  assert.equal(overdueWakeRatio({ enabled: true, intervalMs: 60000, nextWakeAt: FIXTURE_TIME + 30000, scheduleStatus: 'alarm_missing' }, FIXTURE_TIME), 1)
  assert.equal(browserOf({ enabled: true, intervalMs: 60000, nextWakeAt: FIXTURE_TIME + 30000, scheduleStatus: 'alarm_missing' }).wakeUrgency, 1)
  for (const unknown of [{ enabled: true, intervalMs: 60000, nextWakeAt: null }, { enabled: true, intervalMs: 0, nextWakeAt: FIXTURE_TIME },
    { enabled: 'yes' }, null]) {
    assert.equal(overdueWakeRatio(unknown, FIXTURE_TIME), null)
    const browser = browserOf(unknown)
    assert.equal(browser.auraStatus, 'incomplete'); assert.ok(browser.gaps.includes('wakes'))
  }
})

test('host and browser aura readers share one heartbeat definition and agree on status', async t => {
  const fixture = await localAuraFixture(t)
  const idle = await fixture.read()
  assert.equal(idle.evidence.status, 'complete')
  assert.equal(idle.staleHeartbeatRatio, 0); assert.equal(idle.overdueWakeRatio, 0)
  assert.equal(idle.aura.status, 'calm')
  const stuck = { id: 'asg_fixture', ticketId: 'tkt_fixture', state: 'running', startedAt: FIXTURE_TIME - 3 * STALE_HEARTBEAT_MS,
    heartbeatAt: FIXTURE_TIME - STALE_HEARTBEAT_MS - 1, reports: [] }
  const fresh = { ...stuck, id: 'asg_fresh', ticketId: 'tkt_fresh', heartbeatAt: FIXTURE_TIME - STALE_HEARTBEAT_MS }
  await fixture.write('home/auma/superagent/state.json', { assignments: [stuck] })
  const host = await fixture.read()
  const facts = staleHeartbeatFacts([stuck], FIXTURE_TIME)
  assert.deepEqual(facts, { staleHeartbeatRatio: 1, staleTickets: 1 })
  assert.equal(host.evidence.status, 'complete'); assert.equal(host.staleHeartbeatRatio, facts.staleHeartbeatRatio)
  const browser = projectAura({ computedAt: FIXTURE_TIME, dagHead: { heads: [fixture.node.id], count: 1 }, dagNodes: [fixture.node],
    handoffText: `| epoch | **${fixture.head.epoch}** |\n| ballId | \`${fixture.head.ballId}\` |\n`, observationScores: [],
    unanchoredPredictions: 0, pendingWakes: 0, ...facts }, fixture.receiptRows, fixture.head)
  assert.equal(browser.auraStatus, 'recomputed-verified')
  assert.equal(host.aura.status, 'alert'); assert.equal(browser.status, host.aura.status)
  for (const axis of ['coherence', 'surprisePressure', 'driftRisk', 'wakeUrgency']) assert.equal(browser[axis], host.aura.vector[axis], axis)
  assert.equal(browser.recommendedFocus, host.aura.recommendedFocus)
  assert.deepEqual(browser.salience, host.aura.salience.map(({ kind, score }) => ({ kind, score })))
  assert.deepEqual(staleHeartbeatFacts([stuck, fresh], FIXTURE_TIME), { staleHeartbeatRatio: 0.5, staleTickets: 1 })
  for (const unknown of [{ ...stuck, heartbeatAt: undefined, startedAt: undefined }, { ...stuck, heartbeatAt: 'not-a-time' },
    { ...stuck, heartbeatAt: FIXTURE_TIME + 300001 }]) {
    assert.equal(staleHeartbeatFacts([unknown], FIXTURE_TIME), null)
    await fixture.write('home/auma/superagent/state.json', { assignments: [unknown] })
    assertIncompleteAura(await fixture.read(), 'AURA_HEARTBEAT_UNKNOWN')
  }
  await fs.unlink(path.join(fixture.root, 'home/auma/superagent/state.json'))
  assertIncompleteAura(await fixture.read(), 'AURA_SOURCE_ABSENT')
})

test('local aura reads the current flat DAG writer without counting HEAD as a node', async t => {
  const fixture = await localAuraFixture(t), dag = path.join(fixture.root, 'home/auma/memory/dag')
  await fs.rename(path.join(dag, 'nodes', `${fixture.node.id}.json`), path.join(dag, `${fixture.node.id}.json`))
  await fs.rmdir(path.join(dag, 'nodes'))
  const current = await fixture.read()
  assert.equal(current.evidence.status, 'complete'); assert.equal(current.evidence.dagLayout, 'flat')
  assert.equal(current.declaredDagNodes, 1); assert.equal(current.reachableDagNodes, 1)
  const nodes = [fixture.node]
  for (let index = 1; index < 256; index++) {
    const body = { content: `Synthetic flat node ${index}`, createdAt: FIXTURE_TIME, parentIds: [] }
    const node = { ...body, id: fixtureAuraHash(body) }
    nodes.push(node)
    await fixture.write(`home/auma/memory/dag/${node.id}.json`, node)
  }
  await fixture.write('home/auma/memory/dag/HEAD.json', { heads: nodes.map(node => node.id), count: nodes.length })
  await fixture.receipts(nodes.map(node => ({ kind: 'memory.dag.append', data: { nodeId: node.id, content: node.content } })))
  const atLimit = await fixture.read()
  assert.equal(atLimit.evidence.status, 'complete'); assert.equal(atLimit.reachableDagNodes, 256)
  await fixture.write('home/auma/memory/dag/' + '0'.repeat(64) + '.json', {})
  assertIncompleteAura(await fixture.read(), 'AURA_DAG_FILE_LIMIT')
})

test('local aura refuses ambiguous, partial and symlinked DAG layouts rather than merging or falling back', async t => {
  await t.test('competing complete and partial layouts', async child => {
    const fixture = await localAuraFixture(child), dag = path.join(fixture.root, 'home/auma/memory/dag')
    await fixture.write(`home/auma/memory/dag/${fixture.node.id}.json`, fixture.node)
    assertIncompleteAura(await fixture.read(), 'AURA_DAG_LAYOUT_AMBIGUOUS')
    await fs.unlink(path.join(dag, 'nodes', `${fixture.node.id}.json`))
    assertIncompleteAura(await fixture.read(), 'AURA_DAG_LAYOUT_AMBIGUOUS')
    await fs.unlink(path.join(dag, `${fixture.node.id}.json`))
    const partialNested = await fixture.read()
    assert.equal(partialNested.evidence.dagLayout, 'nodes')
    assertIncompleteAura(partialNested, 'AURA_DAG_HEAD_INVALID')
    await fs.rmdir(path.join(dag, 'nodes'))
    const partialFlat = await fixture.read()
    assert.equal(partialFlat.evidence.dagLayout, 'flat')
    assertIncompleteAura(partialFlat, 'AURA_DAG_HEAD_INVALID')
  })
  await t.test('nodes symlink and unexpected root entry', async child => {
    const fixture = await localAuraFixture(child), dag = path.join(fixture.root, 'home/auma/memory/dag'), moved = path.join(fixture.root, 'synthetic-nodes')
    await fs.rename(path.join(dag, 'nodes'), moved)
    await fs.symlink(moved, path.join(dag, 'nodes'))
    assertIncompleteAura(await fixture.read(), 'AURA_DAG_PATH_REFUSED')
    await fs.unlink(path.join(dag, 'nodes'))
    await fs.rename(moved, path.join(dag, 'nodes'))
    await fixture.write('home/auma/memory/dag/HEAD.json.tmp', '{}')
    assertIncompleteAura(await fixture.read(), 'AURA_DAG_PATH_REFUSED')
  })
  await t.test('alternate layout appears during collection', async child => {
    const fixture = await localAuraFixture(child), lstat = fs.lstat
    let changed = false
    child.mock.method(fs, 'lstat', async function (file, ...args) {
      const result = await lstat.call(fs, file, ...args)
      if (!changed && file === path.join(fixture.root, 'home/auma/seed/discovery-corpus.v1.jsonl')) {
        changed = true
        await fixture.write(`home/auma/memory/dag/${fixture.node.id}.json`, fixture.node)
      }
      return result
    })
    assertIncompleteAura(await fixture.read(), 'AURA_SNAPSHOT_CHANGED')
    assert.equal(changed, true)
  })
})

test('local aura rejects missing, malformed, truncated, oversized and deeply nested evidence', async t => {
  const scenarios = [
    ['missing', async f => fs.unlink(path.join(f.root, 'home/auma/HANDOFF.md')), 'AURA_SOURCE_ABSENT'],
    ['invalid UTF-8', f => f.write('home/auma/HANDOFF.md', Buffer.from([0xff])), 'AURA_SOURCE_INVALID'],
    ['unparseable handoff', f => f.write('home/auma/HANDOFF.md', 'No selected epoch.'), 'AURA_HANDOFF_UNKNOWN'],
    ['torn journal', f => f.write('home/auma/seed/receipts.v3.jsonl', JSON.stringify(f.receiptRows[0])), 'AURA_JOURNAL_TRUNCATED'],
    ['oversized file', f => f.write('home/auma/HANDOFF.md', 'x'.repeat(65537)), 'AURA_BYTE_LIMIT'],
    ['deep JSON', f => f.write('home/auma/memory/dag/HEAD.json', '['.repeat(34) + '0' + ']'.repeat(34)), 'AURA_JSON_LIMIT'],
    ['nonfinite JSON', f => f.write('home/auma/memory/dag/HEAD.json', '{"count":1e999,"heads":[]}'), 'AURA_JSON_INVALID'],
    ['record budget', f => f.write('home/auma/seed/receipts.v3.jsonl', '{}\n'.repeat(2049)), 'AURA_RECORD_LIMIT'],
    ['missing DAG node', async f => fs.unlink(path.join(f.root, `home/auma/memory/dag/nodes/${f.node.id}.json`)), 'AURA_DAG_HEAD_INVALID'],
    ['forged count', f => f.write('home/auma/memory/dag/HEAD.json', { heads: [f.node.id], count: 2 }), 'AURA_DAG_HEAD_INVALID'],
  ]
  for (const [name, change, code] of scenarios) await t.test(name, async child => {
    const fixture = await localAuraFixture(child)
    await change(fixture)
    assertIncompleteAura(await fixture.read(), code)
  })
})

test('local aura independently checks receipt leaves, chain links, DAG ids, anchoring and manifest digest', async t => {
  const scenarios = [
    ['receipt content', async f => {
      const row = { ...f.receiptRows[0], intact: true, data: { nodeId: f.node.id, content: 'Forged' } }
      await f.write('home/auma/seed/receipts.v3.jsonl', JSON.stringify(row) + '\n')
    }, 'AURA_RECEIPT_HASH_MISMATCH'],
    ['chain gap', async f => {
      const body = { ...f.receiptRows[0], seq: 2 }; delete body.leafHash
      const leafHash = createHash('sha256').update(Buffer.from([0])).update(canonicalJson(body)).digest('hex')
      await f.write('home/auma/seed/receipts.v3.jsonl', JSON.stringify({ ...body, leafHash }) + '\n')
    }, 'AURA_RECEIPT_CHAIN_INVALID'],
    ['DAG content', f => f.write(`home/auma/memory/dag/nodes/${f.node.id}.json`, { ...f.node, content: 'Forged' }), 'AURA_DAG_HASH_MISMATCH'],
    ['DAG unanchored', f => f.receipts([{ kind: 'memory.dag.append', data: { nodeId: '0'.repeat(64) } }]), 'AURA_DAG_UNANCHORED'],
    ['manifest content', f => f.write('balls/HEAD.json', { ...f.head, epoch: 13 }), 'AURA_HEAD_HASH_MISMATCH'],
  ]
  for (const [name, change, code] of scenarios) await t.test(name, async child => {
    const fixture = await localAuraFixture(child)
    await change(fixture)
    assertIncompleteAura(await fixture.read(), code)
  })
})

test('local aura verifies DAG context receipts before their append anchors and checks ancestor reachability', async t => {
  const fixture = await localAuraFixture(t)
  const prior = { kind: 'fixture.context', data: {} }
  const [context] = await fixture.receipts([prior])
  const nodeBody = { content: 'Synthetic linked memory', createdAt: FIXTURE_TIME, parentIds: [fixture.node.id], receiptHash: context.leafHash }
  const node = { ...nodeBody, id: fixtureAuraHash(nodeBody) }
  await fixture.write(`home/auma/memory/dag/nodes/${node.id}.json`, node)
  await fixture.write('home/auma/memory/dag/HEAD.json', { heads: [node.id], count: 2 })
  await fixture.receipts([prior, fixture.memoryReceipt, { kind: 'memory.dag.append', data: { nodeId: node.id, content: node.content } }])
  const result = await fixture.read()
  assert.equal(result.evidence.status, 'complete'); assert.equal(result.reachableDagNodes, 2)
  await fixture.receipts([fixture.memoryReceipt, { kind: 'memory.dag.append', data: { nodeId: node.id, content: node.content } }, prior])
  assertIncompleteAura(await fixture.read(), 'AURA_DAG_UNANCHORED')
  await fixture.write('home/auma/memory/dag/HEAD.json', { heads: ['0'.repeat(64)], count: 2 })
  await fixture.receipts([prior, fixture.memoryReceipt, { kind: 'memory.dag.append', data: { nodeId: node.id, content: node.content } }])
  assertIncompleteAura(await fixture.read(), 'AURA_DAG_LINKS_INVALID')
})

test('local aura derives prediction surprise from ordered bound receipts and verifies every discovery record', async t => {
  const fixture = await localAuraFixture(t), target = { predictionId: 'fixture-prediction', targetBallId: fixture.head.ballId, targetEpoch: 12, metric: 'fixture-score' }
  const values = [fixture.memoryReceipt,
    { kind: 'seed.bootstrap', data: { ballId: fixture.head.parentBallId, epoch: 11 } },
    { kind: 'prediction.register', data: { ...target, expected: 10 } },
    { kind: 'ball.promote', data: { ballId: fixture.head.ballId, epoch: 12, parentBallId: fixture.head.parentBallId } },
    { kind: 'prediction.observe', data: { ...target, observed: 30 } }]
  const rows = await fixture.receipts(values)
  const record = { trajectoryId: `${rows[2].leafHash}:${rows[3].leafHash}:${rows[4].leafHash}`, pearlId: fixture.head.ballId,
    epochBefore: 11, epochAfter: 12, predicted: 10, observed: 30, surpriseScore: 2,
    registerReceiptHash: rows[2].leafHash, promotionReceiptHash: rows[3].leafHash, observeReceiptHash: rows[4].leafHash, exceptionRuleCandidate: true }
  await fixture.write('home/auma/seed/discovery-corpus.v1.jsonl', JSON.stringify(record) + '\n')
  const result = await fixture.read()
  assert.equal(result.evidence.status, 'complete')
  assert.deepEqual(result.observedSurpriseScores, [2]); assert.equal(result.unanchoredPredictions, 0)
  await fixture.write('home/auma/seed/discovery-corpus.v1.jsonl', JSON.stringify({ ...record, surpriseScore: 0 }) + '\n')
  assertIncompleteAura(await fixture.read(), 'AURA_DISCOVERY_UNVERIFIED')
  await fixture.write('home/auma/seed/discovery-corpus.v1.jsonl', '')
  assertIncompleteAura(await fixture.read(), 'AURA_DISCOVERY_INCOMPLETE')
  await fixture.receipts([...values.slice(0, -1), { kind: 'prediction.observe', data: { ...target, observed: 30, surpriseScore: 0 } }])
  assertIncompleteAura(await fixture.read(), 'AURA_PREDICTION_INVALID')
  await fixture.receipts([...values.slice(0, -1), { kind: 'prediction.observe', data: { ...target, metric: 'wrong', observed: 30 } }])
  assertIncompleteAura(await fixture.read(), 'AURA_PREDICTION_BINDING_INVALID')
  await fixture.receipts([fixture.memoryReceipt, values[1], values[3], values[2], values[4]])
  assertIncompleteAura(await fixture.read(), 'AURA_PREDICTION_ORDER_INVALID')
})

test('local aura refuses symlinks, hardlinks, traversal and more than 256 node files', async t => {
  await t.test('symlink and hardlink file', async child => {
    const fixture = await localAuraFixture(child), handoff = path.join(fixture.root, 'home/auma/HANDOFF.md'), target = path.join(fixture.root, 'synthetic-target')
    await fs.rename(handoff, target); await fs.symlink(target, handoff)
    assertIncompleteAura(await fixture.read(), 'AURA_PATH_REFUSED')
    await fs.unlink(handoff); await fs.link(target, handoff)
    assertIncompleteAura(await fixture.read(), 'AURA_PATH_REFUSED')
  })
  await t.test('ancestor and traversal', async child => {
    const fixture = await localAuraFixture(child), original = path.join(fixture.root, 'home/auma'), moved = path.join(fixture.root, 'synthetic-auma')
    await fs.rename(original, moved); await fs.symlink(moved, original)
    assertIncompleteAura(await fixture.read(), 'AURA_PATH_REFUSED')
    assertIncompleteAura(await fixture.read({ mirrorDirectory: fixture.root + '/../' + path.basename(fixture.root) }), 'AURA_DIRECTORY_INVALID')
  })
  await t.test('node file budget', async child => {
    const fixture = await localAuraFixture(child)
    for (let index = 0; index < 256; index++) await fixture.write(`home/auma/memory/dag/nodes/${index.toString(16).padStart(64, '0')}.json`, {})
    assertIncompleteAura(await fixture.read(), 'AURA_DAG_FILE_LIMIT')
  })
  await t.test('total byte budget', async child => {
    const fixture = await localAuraFixture(child)
    for (let index = 0; index < 67; index++) {
      const id = index.toString(16).padStart(64, '0')
      await fixture.write(`home/auma/memory/dag/nodes/${id}.json`, { id, content: 'x'.repeat(64000) })
    }
    assertIncompleteAura(await fixture.read(), 'AURA_BYTE_LIMIT')
  })
})

test('local aura detects a concurrently replaced HEAD and checks aborts with arbitrary reasons', async t => {
  const fixture = await localAuraFixture(t), controller = new AbortController()
  controller.abort(null)
  assertIncompleteAura(await fixture.read({ signal: controller.signal }), 'AURA_ABORTED')
  const lstat = fs.lstat
  let replaced = false
  t.mock.method(fs, 'lstat', async function (file, ...args) {
    const result = await lstat.call(fs, file, ...args)
    if (!replaced && file === path.join(fixture.root, 'home/auma/seed/discovery-corpus.v1.jsonl')) {
      replaced = true
      await fixture.write('balls/HEAD.json', { ...fixture.head, epoch: 13 })
    }
    return result
  })
  assertIncompleteAura(await fixture.read(), 'AURA_HEAD_CHANGED')
  assert.equal(replaced, true)
})

test('local aura rejects receipt replacement during collection and settles a mid-read abort', async t => {
  for (const abort of [false, true]) await t.test(abort ? 'abort after read admission' : 'receipt replacement', async child => {
    const fixture = await localAuraFixture(child), controller = new AbortController(), lstat = fs.lstat
    let changed = false
    child.mock.method(fs, 'lstat', async function (file, ...args) {
      const result = await lstat.call(fs, file, ...args)
      if (!changed && file === path.join(fixture.root, 'home/auma/seed/discovery-corpus.v1.jsonl')) {
        changed = true
        if (abort) controller.abort('synthetic cancellation reason')
        else await fixture.receipts([fixture.memoryReceipt, { kind: 'fixture.append', data: {} }])
      }
      return result
    })
    assertIncompleteAura(await fixture.read({ signal: controller.signal }), abort ? 'AURA_ABORTED' : 'AURA_SNAPSHOT_CHANGED')
    assert.equal(changed, true)
  })
})

test('local wake receives frozen metadata without queue reentry and status aliases preserve fresh incomplete aura', async t => {
  const mirror = await localAuraFixture(t)
  let observed
  const fixture = await localFixture(t, { readHead: async () => mirror.head, readAuraInputs: input => {
    observed = input.wake
    assert.equal(Object.isFrozen(input.wake), true)
    return mirror.read(input)
  } })
  const wake = fixture.create(), result = await wake.trigger()
  assert.equal(observed.wakeCount, 0); assert.equal(observed.probePending, true)
  assert.equal(result.aura.vector.coherence, 1)
  assert.equal(result.receipt.status, 'probe_skipped_rest')
  await mirror.write('home/auma/memory/dag/HEAD.json', { count: 2, heads: [mirror.node.id] })
  const storage = createLocalMessagesStorage({ directory: path.join(fixture.root, 'status-messages') })
  const handler = createLocalMessagesRequestHandler({ storage, sessionCapability: 'synthetic-capability', allowedOrigins: [LOCAL_ORIGIN], verifyHostAndOrigin: () => ({ ok: true }),
    readStatus: async () => ({ ok: true, head: mirror.head, aura: (await mirror.read({ wake: await wake.status() })).aura }), readWake: () => wake.status() })
  for (const route of ['/__x6/status', '/api/x61/status']) {
    const status = await responseBody(await handler(localRequest(undefined), new URL(route, LOCAL_ORIGIN)))
    assert.equal(status.aura.status, 'incomplete'); assert.equal(status.aura.vector, null)
    assert.equal(status.wake.aura.vector.coherence, 1, 'Historical scorer output remains distinct from current evidence')
  }
  const incomplete = await wake.trigger()
  assert.equal(incomplete.aura, null)
  assert.notEqual(incomplete.receipt.status, 'probe_skipped_rest')
})
