/** Synthetic owner identity and isolated storage only; no live network or credentials. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker } from '../worker.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { X61HeadDurableObject, createDurableWakeStore, BOOTSTRAP_VERSION, canonicalBootstrap, digest, manifestIdCanon } from '../head-do.mjs'

const ORIGIN = 'https://estate.example.invalid', SEED = 'a'.repeat(64), BALL = 'b'.repeat(64)
const LINEAGE = '11111111-1111-4111-8111-111111111111', SECRET = 'SYNTHETIC_PRIVATE_CONTENT'
const owner = { type: 'owner', email: 'owner@example.invalid', expires: 2000 }
const headView = () => ({ ok: true, schema: 'aukora.head-estate.v1', coverage: 'partial', head: { ballId: BALL, epoch: 2 },
  lease: { active: false, expiresAt: null }, wake: { enabled: false, intervalMs: 60000, wakeCount: 0, nextWakeAt: null, lastWakeAt: null,
    lastWakeOutcome: null, consecutiveUnacknowledgedWakes: 0, autoPaused: false, scheduleStatus: 'disabled', scheduledAlarmAt: null },
  repo: { staged: false, pending: false, lastOutcome: null }, transcript: { lastSequence: 0, contents: SECRET }, privateKey: SECRET })

function fixture(identity = owner, headProjection = headView(), acknowledgement) {
  const calls = []
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture', OWNER_EMAIL: owner.email,
    SOURCE_REVISION: 'c'.repeat(40), GITHUB_TOKEN: SECRET, UNLISTED_SECRET: SECRET }
  for (const name of ['HEAD', 'MIRROR']) env[name] = { idFromName: value => value, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    calls.push({ name, path, headers: request.headers, input: request.method === 'POST' ? await request.json() : null })
    if (path.endsWith('/bootstrap-status')) return Response.json({ ok: true, phase: name === 'HEAD' ? 'complete' : 'ready', seedId: SEED, ballId: BALL, epoch: 2 })
    if (path === '/_head/estate') return Response.json(headProjection)
    if (path === '/_mirror/estate') return Response.json({ ok: true, schema: 'aukora.mirror-estate.v1', entryCount: 1, fileCount: 1, directoryCount: 0, highWater: 3, snapshotETag: `"x61-mirror-snapshot-v2:${LINEAGE}:3"`, paths: [SECRET] })
    if (path === '/_host/wake') return acknowledgement ? acknowledgement(calls.at(-1).input) : Response.json({ ok: true, ...headView().wake,
      acknowledgedWakeId: calls.at(-1).input.wakeId, idempotent: false, receipts: [{ requestId: SECRET }], aura: { secret: SECRET }, extra: SECRET })
    if (path === '/_head/repo-proposal') return Response.json({ ok: false, code: 'REPO_PROPOSAL_NOT_FOUND' }, { status: 409 })
    assert.fail('Unexpected internal route ' + path)
  } }) }
  const worker = createWorker({ verifyAccess: async () => identity, now: () => 1000000, networkFetch: () => assert.fail('No network permitted') })
  const request = (path = '/_host/estate', { input, method = input === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
    const values = new Headers({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })
    for (const [key, value] of Object.entries(headers)) value === null ? values.delete(key) : values.set(key, value)
    return worker.fetch(new Request(ORIGIN + path, { method, headers: values, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }), env)
  }
  return { request, calls, env }
}

test('estate owner projection forwards verified identity and drops all unlisted fields', async () => {
  const f = fixture(), response = await f.request()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const result = await response.json()
  assert.equal(result.coverage, 'partial')
  assert.equal(result.worker.secretPresence.GITHUB_TOKEN, true)
  assert.equal(result.worker.secretPresence.OPENAI_API_KEY, false)
  assert.equal(result.archive.status, 'unconfigured')
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  assert.equal(JSON.stringify(result).includes(SEED), false)
  assert.equal(JSON.stringify(result).includes('UNLISTED_SECRET'), false)
  for (const call of f.calls.filter(call => call.path.endsWith('/estate'))) {
    assert.deepEqual(JSON.parse(call.headers.get('x-x6-verified-access')), owner)
    assert.equal(call.headers.get('x-x6-bootstrap-seed'), SEED)
  }
})

test('estate rejects nonowner identities before any internal fanout', async () => {
  for (const identity of [null, true, { ...owner, type: 'access' }, { ...owner, type: 'guest' }, { ...owner, expires: 1000 }, { ...owner, email: 'other@example.invalid' }]) {
    const f = fixture(identity)
    assert.ok([401, 403].includes((await f.request()).status))
    assert.equal(f.calls.length, 0)
  }
})

test('estate validates origin, method, query, and body before any internal fanout', async () => {
  for (const [path, options] of [
    ['/_host/estate?', {}], ['/_host/estate?secret=x', {}], ['/_host/estate', { method: 'DELETE' }],
    ['/_host/estate', { headers: { 'sec-fetch-site': 'cross-site' } }],
    ['/_host/estate', { headers: { origin: 'https://other.example.invalid' } }],
    ['/_host/estate', { headers: { 'transfer-encoding': 'chunked' } }],
    ['/_host/estate', { input: { action: 'configure', enabled: true } }],
    ['/_host/estate', { input: { action: 'reconcile_proposal', branch: 'main' } }],
    ['/_host/estate', { input: { action: 'acknowledge_wake', wakeId: 'bad' } }],
    ['/_host/estate', { input: { action: 'archive_status', extra: true } }],
  ]) {
    const f = fixture()
    assert.ok((await f.request(path, options)).status >= 400)
    assert.equal(f.calls.length, 0)
  }
})

test('archive status fails closed when a bounded metadata binding is unavailable', async () => {
  const f = fixture()
  f.env.ARCHIVE_BUCKET = { get: () => assert.fail('No raw archive read'), list: () => assert.fail('No bucket enumeration') }
  const response = await f.request('/_host/estate', { input: { action: 'archive_status' } })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'ARCHIVE_METADATA_UNAVAILABLE')
})

test('wake acknowledgement maps only the exact action and never forwards approval headers', async () => {
  const f = fixture(), wakeId = `wake-${SEED}-1`
  const response = await f.request('/_host/estate', { input: { action: 'acknowledge_wake', wakeId }, headers: { 'x-x6-class3-approval': SECRET, 'x-x6-verified-access': SECRET } })
  assert.equal(response.status, 200)
  const value = await response.json()
  assert.deepEqual(Object.keys(value).sort(), ['ok', 'acknowledgedWakeId', 'idempotent', 'enabled', 'intervalMs', 'wakeCount', 'nextWakeAt', 'lastWakeAt', 'consecutiveUnacknowledgedWakes', 'autoPaused'].sort())
  assert.equal(JSON.stringify(value).includes(SECRET), false)
  assert.equal(value.acknowledgedWakeId, wakeId)
  const call = f.calls.at(-1)
  assert.equal(call.path, '/_host/wake')
  assert.deepEqual(call.input, { action: 'acknowledge', wakeId })
  assert.equal(call.headers.get('x-x6-class3-approval'), null)
  assert.deepEqual(JSON.parse(call.headers.get('x-x6-verified-access')), owner)
})

test('wake acknowledgement bounds responses, validates correlation and filters failure fields', async () => {
  const wakeId = `wake-${SEED}-1`
  for (const [upstream, status, expected] of [
    [{ ok: false, code: 'WAKE_ACKNOWLEDGEMENT_STALE', receipts: [SECRET], extra: SECRET }, 409, { ok: false, code: 'WAKE_ACKNOWLEDGEMENT_STALE' }],
    [{ ok: false, code: SECRET, receipts: [SECRET] }, 503, { ok: false, code: 'ESTATE_SOURCE_UNAVAILABLE' }],
    [{ ok: true, ...headView().wake, idempotent: false, acknowledgedWakeId: `wake-${SEED}-2` }, 200, { ok: false, code: 'ESTATE_PROJECTION_INVALID' }],
    [{ ok: true, extra: SECRET.repeat(10000) }, 200, { ok: false, code: 'REQUEST_BODY_TOO_LARGE' }],
  ]) {
    const f = fixture(owner, headView(), () => Response.json(upstream, { status }))
    const response = await f.request('/_host/estate', { input: { action: 'acknowledge_wake', wakeId } })
    assert.deepEqual(await response.json(), expected)
    assert.equal(response.status, expected.code === 'REQUEST_BODY_TOO_LARGE' ? 413 : expected.code === 'WAKE_ACKNOWLEDGEMENT_STALE' ? 409 : 503)
  }
})

test('invalid upstream metadata fails closed without reflecting values', async () => {
  const projection = headView(); projection.wake.lastWakeOutcome = SECRET
  const response = await fixture(owner, projection).request()
  assert.equal(response.status, 503)
  assert.equal((await response.text()).includes(SECRET), false)
})

test('reconciliation uses the existing owner broker without a publication retry', async () => {
  const f = fixture()
  const response = await f.request('/_host/estate', { input: { action: 'reconcile_proposal' } })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 'REPO_PROPOSAL_NOT_FOUND')
  assert.equal(f.calls.at(-1).path, '/_head/repo-proposal')
  assert.deepEqual(f.calls.at(-1).input, { action: 'inspect_merge' })
})

test('estate rejects oversized bodies and upstream projections without reflecting contents', async () => {
  const f = fixture()
  assert.equal((await f.request('/_host/estate', { input: { action: 'archive_status', extra: SECRET.repeat(1000) } })).status, 413)
  assert.equal(f.calls.length, 0)
  const projection = headView(); projection.extra = SECRET.repeat(1000)
  const response = await fixture(owner, projection).request()
  assert.equal(response.status, 413)
  assert.equal((await response.text()).includes(SECRET), false)
})

test('mirror estate reads bounded metadata and emits no paths, contents, or writes', async () => {
  const rows = new Map([
    ['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, ballId: BALL, epoch: 2, lineageId: LINEAGE, batchDigests: [], entryCount: 1 }],
    ['mirror:v2:global-fence', { lineageId: LINEAGE, revision: 3 }],
    ['mirror:v2:entry:private', { kind: 'file', path: '/dsh/home/' + SECRET, chunks: 1 }],
  ])
  const tx = { get: async key => rows.get(key), list: async ({ prefix, limit }) => {
    assert.equal(prefix, 'mirror:v2:entry:'); assert.equal(limit, 20001)
    return new Map([...rows].filter(([key]) => key.startsWith(prefix)))
  }, put: () => assert.fail('No storage writes') }
  const object = new MirrorDO({ storage: { ...tx, transaction: fn => fn(tx) } }, {})
  const request = (path, seed = SEED) => object.fetch(new Request('https://x61.internal' + path, { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seed } }))
  const response = await request('/_mirror/estate')
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.entryCount, 1); assert.equal(result.highWater, 3)
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  assert.equal((await request('/_mirror/estate?')).status, 400)
  assert.equal((await request('/_mirror/estate', 'c'.repeat(64))).status, 503)
  rows.get('mirror:v2:entry:private').b64 = SECRET
  assert.equal((await request('/_mirror/estate')).status, 503)
})

function estateStorage() {
  let data = new Map(), alarm = null, tail = Promise.resolve()
  const reads = []
  const view = (rows, timer) => ({
    get: async key => { reads.push(key); return structuredClone(rows.get(key)) },
    put: async (key, value) => { rows.set(key, structuredClone(value)) },
    delete: async key => rows.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => {
      reads.push('list:' + prefix)
      return structuredClone(new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)))
    },
    getAlarm: async () => timer.value, setAlarm: async value => { timer.value = value }, deleteAlarm: async () => { timer.value = null },
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list'].map(method => [method, (...args) => view(data, { value: alarm })[method](...args)]))
  storage.getAlarm = async () => alarm
  storage.transaction = operation => {
    const result = tail.then(async () => {
      const rows = structuredClone(data), timer = { value: alarm }
      const value = await operation(view(rows, timer))
      data = rows; alarm = timer.value
      return value
    })
    tail = result.catch(() => {})
    return result
  }
  return { storage, reads, snapshot: () => structuredClone(data) }
}

test('real Worker, HEAD and Mirror project seeded metadata and acknowledge only the latest wake', async t => {
  let now = Date.now()
  const hs = estateStorage(), ms = estateStorage(), calls = []
  const access = { type: 'owner', email: owner.email, expires: Math.floor(now / 1000) + 3600 }
  let identity = access
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture', OWNER_EMAIL: access.email }
  const head = new X61HeadDurableObject({ storage: hs.storage, getWebSockets: () => [] }, env)
  const mirror = new MirrorDO({ storage: ms.storage }, env)
  // Keep real durable wake behavior, replacing only its clock and unavailable peripheral adapters.
  await head.wakeStore.dispose()
  head.wakeStore = createDurableWakeStore(hs.storage, { now: () => now })
  t.after(() => head.wakeStore.dispose())
  for (const [name, object] of [['HEAD', head], ['MIRROR', mirror]]) env[name] = { idFromName: name => name, get: () => ({ fetch: request => {
    calls.push(new URL(request.url).pathname)
    return object.fetch(request)
  } }) }
  const worker = createWorker({ verifyAccess: async () => identity, now: () => now, networkFetch: () => assert.fail('No live network') })
  const call = (path, input) => worker.fetch(new Request(ORIGIN + path, { method: input === undefined ? 'GET' : 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) }), env)
  const code = `export const organ = '${SECRET}';\n`, sha = await digest(code)
  const draft = { version: 'x6.1-ball/v1', epoch: 2, parentBallId: null, createdAt: '2026-11-11T00:00:00.000Z', authorPeerId: 'fixture-peer',
    entries: { 'seed-echo': { id: 'seed-echo', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(code) } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }
  const entries = [['/dsh/home/private-fixture.txt', { kind: 'file', mode: 0o600, b64: Buffer.from(SECRET).toString('base64'), mtimeMs: now }]]
  const payload = { version: BOOTSTRAP_VERSION, ball, codeBySha: { [sha]: code }, mirror: { entryCount: 1, batchDigests: [await digest(canonicalBootstrap(entries))] } }
  const prepared = await call('/_bootstrap', { action: 'prepare', package: payload })
  assert.equal(prepared.status, 200)
  const { seedId } = await prepared.json()
  assert.equal((await call('/_bootstrap', { action: 'batch', seedId, index: 0, entries })).status, 200)
  assert.equal((await call('/_bootstrap', { action: 'commit', seedId })).status, 200)
  await hs.storage.put('private:owner-key', SECRET)
  await hs.storage.put('head:transcript:seq', 7)
  await hs.storage.put('head:transcript:7', SECRET)
  await ms.storage.put('private:session-path', SECRET)
  hs.reads.length = 0; ms.reads.length = 0
  const before = [hs.snapshot(), ms.snapshot()]
  const estate = await call('/_host/estate'), result = await estate.json()
  assert.equal(estate.status, 200, JSON.stringify(result))
  assert.deepEqual(result.head.head, { ballId: ball.ballId, epoch: 2 })
  assert.equal(result.head.transcript.lastSequence, 7)
  assert.equal(result.head.wake.scheduleStatus, 'disabled')
  assert.equal(result.mirror.entryCount, 1)
  assert.equal(result.mirror.fileCount, 1)
  for (const value of [SECRET, seedId, sha, 'private-fixture.txt', 'private:owner-key', 'head:transcript:7']) assert.equal(JSON.stringify(result).includes(value), false)
  assert.equal(hs.reads.includes('private:owner-key'), false)
  assert.equal(hs.reads.includes('head:transcript:7'), false)
  assert.equal(ms.reads.some(key => key.startsWith('mirror:v2:chunk:')), false)
  assert.deepEqual([hs.snapshot(), ms.snapshot()], before)
  for (const deniedIdentity of [{ ...access, type: 'access' }, { ...access, email: 'other@example.invalid' }]) {
    identity = deniedIdentity; calls.length = 0
    assert.equal((await call('/_host/estate')).status, 403)
    assert.equal(calls.length, 0)
  }
  identity = access
  for (const [object, path] of [[head, '/_head/estate'], [mirror, '/_mirror/estate']]) {
    const denied = await object.fetch(new Request(ORIGIN + path, { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': 'f'.repeat(64), 'x-x6-verified-access': JSON.stringify(access) } }))
    assert.equal(denied.status, 503)
    assert.equal((await denied.text()).includes(SECRET), false)
  }
  await head.wakeStore.trigger({ requestId: SECRET })
  await head.wakeStore.configure({ enabled: true })
  const receipts = []
  for (let index = 0; index < 3; index++) { now += 60000; receipts.push((await head.alarm()).receipt) }
  const paused = await (await call('/_host/estate')).json()
  assert.equal(paused.head.wake.autoPaused, true)
  assert.equal(paused.head.wake.consecutiveUnacknowledgedWakes, 3)
  assert.equal((await head.wakeStore.status()).receipts.some(receipt => receipt.requestId === SECRET), true)
  const stale = await call('/_host/estate', { action: 'acknowledge_wake', wakeId: receipts[0].wakeId })
  assert.equal(stale.status, 409)
  const acknowledged = await call('/_host/estate', { action: 'acknowledge_wake', wakeId: receipts.at(-1).wakeId })
  assert.equal(acknowledged.status, 200)
  const acknowledgement = await acknowledged.json()
  assert.equal(acknowledgement.acknowledgedWakeId, receipts.at(-1).wakeId)
  assert.equal(JSON.stringify(acknowledgement).includes(SECRET), false)
  for (const key of ['receipts', 'aura', 'executor', 'receipt', 'requestId']) assert.equal(Object.hasOwn(acknowledgement, key), false)
  const after = await (await call('/_host/estate')).json()
  assert.equal(after.head.wake.autoPaused, false)
  assert.equal(after.head.wake.consecutiveUnacknowledgedWakes, 0)
  assert.equal(after.head.wake.enabled, false)
  assert.equal(after.head.wake.scheduledAlarmAt, null)
  assert.equal((await (await call('/_host/estate', { action: 'acknowledge_wake', wakeId: receipts.at(-1).wakeId })).json()).idempotent, true)
})


test('estate compares observed archive metadata with selected HEAD without asserting restore integrity', async () => {
  for (const [epoch, ballId, expected] of [[2, BALL, true], [1, BALL, false], [2, 'd'.repeat(64), false]]) {
    const f = fixture(), key = `snapshots/epoch-${epoch}-${ballId}.json`
    const manifest = { schema: 'aukora.cold-archive.v1', archiveId: 'c'.repeat(64), r2Key: key, exportedAt: 1000,
      epoch, ballId, moduleCount: 1, receiptCount: 0, checkpointCount: 0, merkleRoot: 'd'.repeat(64), compositeHeadHash: 'e'.repeat(64) }
    f.env.ARCHIVE_BUCKET = {
      list: async () => ({ objects: [], truncated: false }),
      get: async target => { assert.equal(target, 'snapshots/LATEST.json'); const value = JSON.stringify(manifest); return { size: Buffer.byteLength(value), body: new Response(value).body } },
      head: async target => { assert.equal(target, key); return { key, size: 1000, uploaded: new Date(1000) } },
    }
    const response = await f.request(), result = await response.json()
    assert.equal(response.status, 200)
    assert.equal(result.archive.latestMatchesSelectedHead, expected)
    assert.equal(result.archive.backupStatus, 'snapshot-present')
    assert.equal(result.archive.integrityVerified, false)
  }
  assert.equal((await (await fixture().request()).json()).archive.latestMatchesSelectedHead, null)
})
