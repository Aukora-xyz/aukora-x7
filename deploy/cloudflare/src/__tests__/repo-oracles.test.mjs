/** Byte and state oracles use synthetic GitHub responses and in-memory metadata only. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { handleCloudBroker, CLOUD_REPO_READ_LIMITS } from '../cloud-brokers.mjs'
import { X61HeadDurableObject, manifestId, canonicalBootstrap, validateManifest } from '../head-do.mjs'
import { readHeadStateDiff, STATE_DIFF_LIMITS, projectHeadStateDiff } from '../state-diff.mjs'
import { createWorker } from '../worker.mjs'

const ORIGIN = 'https://oracles.example.invalid', COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40), SEED = 'c'.repeat(64)
const LINEAGE = '11111111-1111-4111-8111-111111111111', SECRET = 'synthetic-oracle-private-marker'
const SIGNING_SECRET = 'synthetic-owner-signing-value'
const hash = (algorithm, value) => createHash(algorithm).update(value).digest('hex')
const blobHash = bytes => hash('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
const bootstrap = { ready: true, head: { phase: 'complete', seedId: SEED }, mirror: { phase: 'ready' } }

function broker(input, env, context = {}) {
  return handleCloudBroker(new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(input) }),
    env, { bootstrap, networkFetch: () => assert.fail('Unexpected network'), ...context })
}

function byteFixture(bytes, { mode = '100644', upstreamBytes = bytes, encoded, blobSha = blobHash(bytes) } = {}) {
  const calls = [], env = { GITHUB_TOKEN: 'synthetic-token-fixture', API_KEY: SECRET, OWNER_ED25519_SECRET_KEY: SIGNING_SECRET }
  const networkFetch = async (url, init) => {
    calls.push({ url, init }); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error')
    const target = new URL(url), path = 'server/fixture.mjs'
    assert.equal(target.hostname, 'api.github.com')
    if (target.pathname.endsWith('/commits/main')) return Response.json({ sha: COMMIT, commit: { tree: { sha: TREE } } })
    if (target.pathname.endsWith('/git/trees/' + TREE)) return Response.json({ sha: TREE, truncated: false, tree: [
      { path: 'server', type: 'tree', mode: '040000', sha: TREE }, { path, type: mode === '160000' ? 'commit' : 'blob', mode, sha: blobSha, size: bytes.length },
    ] })
    assert.ok(target.pathname.endsWith('/contents/' + path)); assert.equal(target.search, '?ref=' + COMMIT)
    return Response.json({ type: 'file', path, sha: blobSha, encoding: 'base64', content: encoded ?? upstreamBytes.toString('base64') })
  }
  return { calls, env, request: input => broker({ action: 'bytes', path: 'server/fixture.mjs', ...input }, env, { networkFetch }) }
}

test('byte oracle preserves original BOM and multibyte bytes while binding whole-file hashes to pinned blobs', async () => {
  const bytes = Buffer.from('\ufeffconst label = "é🐈";\r\n')
  const fixture = byteFixture(bytes)
  const response = await fixture.request({ offset: 0, length: 4 }), value = await response.json()
  assert.equal(response.status, 200); assert.equal(value.source, 'github-main'); assert.equal(value.commitSha, COMMIT)
  assert.equal(value.blobSha, blobHash(bytes)); assert.equal(value.sha256, hash('sha256', bytes))
  assert.notEqual(value.sha256, hash('sha256', Buffer.from(bytes.toString('utf8').replace(/^\ufeff/, ''))))
  assert.deepEqual(value.bytes, [...bytes.subarray(0, 4)]); assert.equal(value.hex, bytes.subarray(0, 4).toString('hex'))
  assert.equal(value.totalBytes, bytes.length); assert.equal(value.hashScope, 'whole-file-original-bytes'); assert.equal(value.truncated, true)
  const end = await (await fixture.request({ offset: bytes.length, length: 1 })).json()
  assert.deepEqual(end.bytes, []); assert.equal(end.hex, ''); assert.equal(end.length, 0); assert.equal(end.truncated, false)
  const empty = await (await byteFixture(Buffer.alloc(0)).request({})).json()
  assert.equal(empty.sha256, hash('sha256', Buffer.alloc(0))); assert.equal(empty.totalBytes, 0)
})

test('byte oracle screens the whole decoded file before exposing a safe prefix or digest', async () => {
  for (const bytes of [Buffer.from('safe prefix\n' + SECRET), Buffer.from('safe prefix\n' + SIGNING_SECRET), Buffer.from('safe prefix\n' + 'ghp_' + 'x'.repeat(30)),
    Buffer.from('safe prefix\n{"privateKeyHex":"synthetic"}'), Buffer.from('safe prefix\n-----BEGIN PRIVATE KEY-----'),
    Buffer.from([65, 0, 66]), Buffer.from([65, 1, 66]), Buffer.from([65, 255]), Buffer.from('x'.repeat(CLOUD_REPO_READ_LIMITS.fileBytes + 1))]) {
    const response = await byteFixture(bytes).request({ length: 1 }), result = await response.json()
    assert.ok(response.status >= 400)
    for (const key of ['bytes', 'hex', 'sha256', 'blobSha', 'content']) assert.equal(Object.hasOwn(result, key), false)
    assert.equal(JSON.stringify(result).includes(SECRET), false)
  }
  assert.equal((await byteFixture(Buffer.from('safe'), { encoded: '%%%INVALID' }).request({})).status, 502)
  assert.equal((await byteFixture(Buffer.from('safe'), { upstreamBytes: Buffer.from('fake') }).request({})).status, 502)
  const legacy = byteFixture(Buffer.from('legacy-suffix-value')); legacy.env.MYTOKEN = 'legacy-suffix-value'
  assert.equal((await legacy.request({})).status, 403)
  const bomSecret = '\ufeffsynthetic-opaque-secret', bom = byteFixture(Buffer.from(bomSecret))
  bom.env.API_KEY = bomSecret
  const response = await bom.request({ offset: 0, length: 1 }), refused = await response.json()
  assert.equal(response.status, 403); assert.equal(refused.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  for (const key of ['bytes', 'hex', 'sha256', 'blobSha', 'content']) assert.equal(Object.hasOwn(refused, key), false)
})

test('bytes never expands private source access and refuses invalid ranges or nonregular files', async () => {
  const fixture = byteFixture(Buffer.from('safe'))
  for (const path of ['mirror/home/auma/memory/note.md', 'mirror/workspace/file.md', 'server/.env', 'server/private/file.mjs', 'server/owner-key.mjs', 'server/../README.md']) {
    assert.equal((await fixture.request({ path })).status, 403, path)
  }
  for (const input of [{ offset: -1 }, { offset: null }, { length: null }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER }, { length: 0 }, { length: 4097 }, { length: -1 }, { extra: 'field' }]) assert.equal((await fixture.request(input)).status, 400)
  assert.equal(fixture.calls.length, 0)
  assert.equal((await fixture.request({ offset: 5 })).status, 400)
  for (const mode of ['120000', '160000']) {
    const fixture = byteFixture(Buffer.from('safe'), { mode })
    assert.equal((await fixture.request({})).status, 403)
    assert.equal(fixture.calls.length, 2, 'Nonregular file must refuse before contents')
  }
  const maximum = await (await byteFixture(Buffer.from('x'.repeat(CLOUD_REPO_READ_LIMITS.fileBytes))).request({ length: 4096 })).json()
  assert.equal(maximum.bytes.length, 4096); assert.equal(maximum.hex.length, 8192); assert.equal(maximum.totalBytes, CLOUD_REPO_READ_LIMITS.fileBytes)
  assert.equal((await broker({ action: 'bytes', path: 'README.md' }, {}, { bootstrap: { ready: false } })).status, 503)
})

function storage() {
  const rows = new Map(), reads = []
  const tx = { async get(key) { reads.push(key); return structuredClone(rows.get(key)) }, async list() { return new Map(rows) }, async put() { assert.fail('State inspection is read-only') } }
  return { ...tx, transaction: operation => operation(tx), rows, reads }
}
const entry = (id, config = {}) => ({ id, specifier: 'fixture:' + id, disabled: false, config, previousSpecifiers: [] })
async function ball(entries, epoch = 1, parentBallId = null) {
  const value = { version: 'x6.1-ball/v1', epoch, parentBallId, entries, modules: {} }
  value.ballId = await manifestId(value)
  return value
}
function retain(store, value) {
  const raw = JSON.stringify(value), count = Math.ceil(raw.length / 24000)
  store.rows.set(`manifest:${value.ballId}:count`, count)
  for (let index = 0; index < count; index++) store.rows.set(`manifest:${value.ballId}:${index}`, raw.slice(index * 24000, (index + 1) * 24000))
}
function select(store, value) { retain(store, value); store.rows.set('head', value.ballId) }
const identity = value => ({ ballId: value.ballId, epoch: value.epoch })
const baseFor = value => ({ head: identity(value), mirror: { lineageId: LINEAGE, revision: 1 } })
async function stateFixture(current, previous) {
  const store = storage(); select(store, current); if (previous) retain(store, previous)
  store.rows.set('bootstrap:v1', { phase: 'complete', seedId: SEED, ballId: current.ballId, epoch: current.epoch })
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture', OWNER_EMAIL: 'owner@example.invalid', API_KEY: SECRET }
  const head = new X61HeadDurableObject({ storage: store, getWebSockets: () => [] }, env), mirrorCalls = []
  env.HEAD = { idFromName: value => value, get: () => head }
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: async request => {
    const url = new URL(request.url); mirrorCalls.push(url.pathname + url.search)
    if (url.pathname === '/_mirror/bootstrap-status') return Response.json({ ok: true, phase: 'ready', seedId: SEED, ballId: current.ballId, epoch: current.epoch })
    assert.equal(url.pathname + url.search, '/_mirror/status?compact=1')
    return Response.json({ ok: true, lineageId: LINEAGE, revision: 2, privateNames: SECRET })
  } }) }
  const worker = createWorker({ verifyAccess: async request => request.headers.get('x-test-owner') === 'yes', networkFetch: () => assert.fail('State diff must not use network') })
  const request = (input, headers = {}) => worker.fetch(new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-test-owner': 'yes', 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) }), env)
  return { store, env, head, mirrorCalls, request }
}

test('state diff identifies current snapshots and retained HEAD basis without entry contents or MIRROR private names', async () => {
  const before = await ball({ stable: entry('stable'), changed: entry('changed', { value: 1 }), removed: entry('removed') })
  const after = await ball({ stable: entry('stable'), changed: entry('changed', { value: 2, nestedPrivate: SECRET }), added: entry('added') }, 2, before.ballId)
  const fixture = await stateFixture(after, before)
  const snapshot = await (await fixture.request({ action: 'state_diff' })).json()
  assert.equal(snapshot.ok, true); assert.equal(snapshot.basis, 'snapshot-only'); assert.equal(snapshot.atomicAcrossBindings, false)
  assert.deepEqual(snapshot.head.current, identity(after)); assert.equal(snapshot.head.changed, null)
  assert.equal(snapshot.head.entries.changes, null); assert.equal(snapshot.head.entries.code, 'STATE_DIFF_BASE_REQUIRED')
  const response = await fixture.request({ action: 'state_diff', base: baseFor(before) }), result = await response.json()
  assert.equal(response.status, 200); assert.equal(result.ok, true); assert.equal(result.basis, 'caller-baseline')
  assert.equal(result.head.changed, true); assert.equal(result.head.entries.basis, 'retained-manifests')
  assert.deepEqual(result.head.entries.changes, [{ id: 'added', status: 'added' }, { id: 'changed', status: 'modified' }, { id: 'removed', status: 'removed' }])
  assert.deepEqual(result.mirror, { state: 'available', basis: 'caller-supplied-fence', base: { lineageId: LINEAGE, revision: 1 }, current: { lineageId: LINEAGE, revision: 2 }, changed: true })
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  assert.equal(fixture.store.reads.some(key => key.startsWith('module:')), false)
  assert.equal(fixture.mirrorCalls.some(path => path === '/_mirror/status'), false)
})

test('state baseline validation and internal route auth fail before leaking or fabricating differences', async () => {
  const current = await ball({ stable: entry('stable') }), fixture = await stateFixture(current)
  for (const base of [null, {}, { head: identity(current) }, { ...baseFor(current), extra: true },
    { ...baseFor(current), head: { ballId: 'bad', epoch: 1 } }, { ...baseFor(current), mirror: { lineageId: LINEAGE, revision: -1 } }]) assert.equal((await fixture.request({ action: 'state_diff', base })).status, 400)
  assert.equal((await fixture.request({ action: 'state_diff' }, { 'x-test-owner': 'no' })).status, 401)
  assert.equal((await fixture.request({ action: 'state_diff' }, { origin: 'https://foreign.invalid' })).status, 403)
  assert.equal((await fixture.request({ action: 'state_diff', base: { ...baseFor(current), head: { ...identity(current), epoch: 9 } } })).status, 409)
  assert.equal((await fixture.request({ action: 'state_diff', base: { ...baseFor(current), mirror: { lineageId: LINEAGE, revision: 3 } } })).status, 409)
  const missing = await (await fixture.request({ action: 'state_diff', base: { ...baseFor(current), head: { ballId: 'f'.repeat(64), epoch: 0 } } })).json()
  assert.equal(missing.ok, false); assert.equal(missing.code, 'STATE_DIFF_INCOMPLETE')
  assert.equal(missing.head.changed, null); assert.equal(missing.head.entries.changes, null); assert.equal(missing.head.entries.code, 'STATE_DIFF_BASE_UNAVAILABLE')
  const internal = new Request(ORIGIN + '/_head/state-diff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal((await fixture.head.fetch(internal)).status, 401)
  const wrongSeed = new Request(internal, { headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': 'd'.repeat(64) } })
  assert.equal((await fixture.head.fetch(wrongSeed)).status, 503)
  assert.equal((await broker({ action: 'state_diff' }, {}, { bootstrap: { ready: false } })).status, 503)
})

test('HEAD diff bounds chunk IO before parse and rejects malformed retained identities', async () => {
  const current = await ball({ stable: entry('stable') }), store = storage()
  select(store, current)
  for (const count of [0, -1, '2', Infinity, Math.ceil(STATE_DIFF_LIMITS.manifestBytes / 24000) + 1]) {
    store.rows.set(`manifest:${current.ballId}:count`, count); store.reads.length = 0
    const value = await readHeadStateDiff(store, undefined, validateManifest, canonicalBootstrap)
    assert.equal(value.code, 'STATE_DIFF_HEAD_UNAVAILABLE'); assert.equal(store.reads.length, 2)
  }
  retain(store, current); store.rows.set(`manifest:${current.ballId}:0`, 'x'.repeat(24001))
  assert.equal((await readHeadStateDiff(store, undefined, validateManifest, canonicalBootstrap)).code, 'STATE_DIFF_HEAD_UNAVAILABLE')
  store.rows.set(`manifest:${current.ballId}:count`, 5)
  for (let index = 0; index < 5; index++) store.rows.set(`manifest:${current.ballId}:${index}`, '文'.repeat(20000))
  assert.equal((await readHeadStateDiff(store, undefined, validateManifest, canonicalBootstrap)).code, 'STATE_DIFF_HEAD_UNAVAILABLE')
  retain(store, current)
  const oldId = 'e'.repeat(64); store.rows.set(`manifest:${oldId}:count`, 1); store.rows.set(`manifest:${oldId}:0`, JSON.stringify(current))
  const result = await readHeadStateDiff(store, { ballId: oldId, epoch: 0 }, validateManifest, canonicalBootstrap)
  assert.equal(result.entries.code, 'STATE_DIFF_BASE_UNAVAILABLE'); assert.equal(result.entries.changes, null)
})

test('HEAD diff caps returned changes, preserves actual empty differences and rejects unsafe entry identifiers', async () => {
  const entries = Object.fromEntries(Array.from({ length: 150 }, (_, index) => ['entry-' + index, entry('entry-' + index)]))
  const before = await ball({}), after = await ball(entries, 2, before.ballId), store = storage()
  select(store, after); retain(store, before)
  const diff = await readHeadStateDiff(store, identity(before), validateManifest, canonicalBootstrap)
  assert.equal(diff.entries.changes.length, 100); assert.equal(diff.entries.total, 150); assert.equal(diff.entries.truncated, true)
  const same = await readHeadStateDiff(store, identity(after), validateManifest, canonicalBootstrap)
  assert.deepEqual(same.entries.changes, []); assert.equal(same.changed, false)
  const unsafe = await ball({ ['../../' + SECRET]: entry('../../' + SECRET) }, 3, after.ballId)
  select(store, unsafe)
  const refused = await readHeadStateDiff(store, identity(after), validateManifest, canonicalBootstrap)
  assert.equal(refused.entries.code, 'STATE_DIFF_ENTRIES_UNAVAILABLE'); assert.equal(JSON.stringify(refused).includes(SECRET), false)
  assert.throws(() => projectHeadStateDiff({ ...same, entries: { ...same.entries, changes: [{ id: SECRET, status: 'modified' }], total: 1 } }, identity(after)))
})
