/** R2 archive metadata is bounded and projected with synthetic objects only. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker } from '../worker.mjs'
import { COLD_ARCHIVE_SCHEMA } from '../cold-archive.mjs'

const ORIGIN = 'https://archive.example.invalid', seedId = 'a'.repeat(64), ballId = 'b'.repeat(64), SECRET = 'SYNTHETIC_PRIVATE_METADATA'
const key = `snapshots/epoch-4-${ballId}.json`
const pointer = () => ({ schema: COLD_ARCHIVE_SCHEMA, archiveId: 'c'.repeat(64), r2Key: key, exportedAt: 1000, epoch: 4, ballId,
  moduleCount: 2, receiptCount: 4, checkpointCount: 1, merkleRoot: 'd'.repeat(64), compositeHeadHash: 'e'.repeat(64), credentialId: SECRET, signerCounter: 42, privateKey: SECRET })
const object = () => ({ key, size: 98765, uploaded: new Date(1000), customMetadata: { secret: SECRET }, httpMetadata: { secret: SECRET }, etag: SECRET })
function fixture({ manifest = pointer(), listed, prefixPages = {}, stored = object(), overrides = {}, access } = {}) {
  const calls = [], owner = { type: 'owner', email: 'owner@example.invalid', expires: 2000 }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: owner.email, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture' }
  for (const name of ['HEAD', 'MIRROR']) env[name] = { idFromName: name => name, get: () => ({ fetch: async request => {
    assert.ok(new URL(request.url).pathname.endsWith('/bootstrap-status'))
    return Response.json({ ok: true, phase: name === 'HEAD' ? 'complete' : 'ready', seedId, ballId, epoch: 4 })
  } }) }
  env.ARCHIVE_BUCKET = {
    list: async options => { calls.push('list:' + options.prefix); assert.equal(options.limit, 64); assert.ok(['snapshots/', 'modules/', 'files/'].includes(options.prefix));
      if (options.prefix !== 'snapshots/') return prefixPages[options.prefix] ?? { objects: [], truncated: false }
      return listed ?? { objects: [object(), { key: 'snapshots/LATEST.json' }, { key: 'snapshots/' + SECRET }], truncated: false } },
    get: async target => { calls.push('get'); assert.equal(target, 'snapshots/LATEST.json', 'Full snapshot payload must never be read'); if (manifest === null) return null
      const text = JSON.stringify(manifest); return { size: Buffer.byteLength(text), body: new Response(text).body } },
    head: async target => { calls.push('head'); assert.equal(target, key); return stored },
    put: () => assert.fail('No writes'), delete: () => assert.fail('No deletes'), ...overrides,
  }
  const worker = createWorker({ verifyAccess: async () => access === undefined ? owner : access, now: () => 1000000,
    networkFetch: () => assert.fail('No network provider calls') })
  const request = (input = { action: 'archive_status' }, extra = {}) => worker.fetch(new Request(ORIGIN + '/_host/estate', { method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...extra.headers }, body: JSON.stringify(input), signal: extra.signal }), env)
  return { request, env, calls }
}

test('archive status exposes bounded structural metadata, never credential fields or snapshot bodies', async () => {
  const fx = fixture(), response = await fx.request(), result = await response.json()
  assert.equal(response.status, 200); assert.equal(result.integrityVerified, false); assert.equal(result.coverage, 'metadata-only')
  assert.equal(result.status, 'observed'); assert.equal(result.omittedObjectCount, 1); assert.equal(result.truncated, false)
  assert.deepEqual(result.objects, [{ epoch: 4, ballId, bytes: 98765, uploadedAt: 1000 }])
  assert.equal(result.latest.archiveId, 'c'.repeat(64)); assert.equal(result.latest.object.bytes, 98765)
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  for (const field of ['credentialId', 'signerCounter', 'privateKey', 'customMetadata', 'httpMetadata', 'etag', 'r2Key']) assert.equal(JSON.stringify(result).includes(field), false)
  assert.deepEqual(fx.calls, ['list:snapshots/', 'list:modules/', 'list:files/', 'get', 'head']); assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('missing bucket and empty listings are explicit, while truncated listings are never called complete', async () => {
  const absent = fixture(); delete absent.env.ARCHIVE_BUCKET
  assert.equal((await (await absent.request()).json()).status, 'unconfigured'); assert.equal(absent.calls.length, 0)
  const empty = fixture({ manifest: null, listed: { objects: [], truncated: false } })
  const value = await (await empty.request()).json(); assert.equal(value.latest, null); assert.deepEqual(value.objects, []); assert.equal(value.status, 'observed'); assert.equal(value.prefixSummaryComplete, true)
  const partial = fixture({ listed: { objects: [object()], truncated: true }, manifest: null })
  assert.equal((await (await partial.request()).json()).truncated, true)
})

test('nonowners, cross-origin, extra fields and arbitrary object keys never reach R2', async () => {
  for (const access of [null, { type: 'guest', email: 'owner@example.invalid', expires: 2000 }, { type: 'owner', email: 'owner@example.invalid', expires: 999 }]) {
    const fx = fixture({ access }); assert.ok((await fx.request()).status >= 400); assert.equal(fx.calls.length, 0)
  }
  for (const [input, extra] of [[{ action: 'archive_status', key: SECRET }, {}], [{ action: 'archive_status' }, { headers: { origin: 'https://other.example.invalid' } }]]) {
    const fx = fixture(); assert.ok((await fx.request(input, extra)).status >= 400); assert.equal(fx.calls.length, 0)
  }
})

test('malformed and oversized metadata fails closed without echoing values', async () => {
  for (const config of [
    { manifest: { ...pointer(), epoch: -1 } }, { manifest: { ...pointer(), r2Key: 'files/' + SECRET } },
    { manifest: { ...pointer(), archiveId: SECRET } }, { manifest: { ...pointer(), privateKey: SECRET.repeat(1000) } },
    { listed: { objects: Array.from({ length: 65 }, object), truncated: false } },
    { listed: { objects: [object(), object()], truncated: false } },
    { listed: { objects: [{ ...object(), size: -1 }], truncated: false } },
    { listed: { objects: [{ ...object(), uploaded: new Date(NaN) }], truncated: false } },
    { stored: null }, { stored: { ...object(), key: 'files/' + SECRET } },
  ]) {
    const fx = fixture(config), response = await fx.request(), text = await response.text()
    assert.ok(response.status >= 400); assert.equal(text.includes(SECRET), false); assert.equal(text.includes('credentialId'), false)
  }
})

test('abort after a slow listing prevents subsequent pointer reads or any writes', async () => {
  const pending = Promise.withResolvers(), controller = new AbortController()
  const fx = fixture({ overrides: { list: () => pending.promise } })
  const result = fx.request({ action: 'archive_status' }, { signal: controller.signal })
  controller.abort(); pending.resolve({ objects: [], truncated: false })
  assert.ok((await result).status >= 400); assert.equal(fx.calls.includes('get'), false)
})


test('fixed-prefix summaries report only bounded counts and bytes, never names or full-bucket coverage', async () => {
  const module = { key: 'modules/' + 'a'.repeat(64) + '.js', size: 40, uploaded: new Date(1000) }
  const file = { key: 'files/' + 'b'.repeat(64) + '.b64', size: 80, uploaded: new Date(1000) }
  const fx = fixture({ prefixPages: {
    'modules/': { objects: [module, { key: 'modules/' + SECRET }], truncated: true },
    'files/': { objects: [file], truncated: false },
  } })
  const result = await (await fx.request()).json()
  assert.equal(result.backupStatus, 'snapshot-present')
  assert.equal(result.prefixSummaryComplete, false)
  assert.equal(result.integrityVerified, false)
  assert.deepEqual(result.prefixes.slice(1), [
    { prefix: 'modules/', examinedObjectCount: 2, recognizedObjectCount: 1, bytes: 40, truncated: true, omittedObjectCount: 1, complete: false },
    { prefix: 'files/', examinedObjectCount: 1, recognizedObjectCount: 1, bytes: 80, truncated: false, omittedObjectCount: 0, complete: true },
  ])
  for (const privateValue of [module.key, file.key, SECRET]) assert.equal(JSON.stringify(result).includes(privateValue), false)
})

test('backup presence distinguishes empty, orphaned and truncated metadata without claiming integrity', async () => {
  for (const [config, expected] of [
    [{ manifest: null, listed: { objects: [], truncated: false } }, 'empty'],
    [{ manifest: null, listed: { objects: [], truncated: true } }, 'no-latest-pointer'],
    [{ manifest: null, listed: { objects: [object()], truncated: false } }, 'no-latest-pointer'],
    [{ manifest: null, listed: { objects: [], truncated: false }, prefixPages: { 'files/': { objects: [{ key: SECRET }], truncated: false } } }, 'no-latest-pointer'],
  ]) {
    const result = await (await fixture(config).request()).json()
    assert.equal(result.backupStatus, expected)
    assert.equal(result.integrityVerified, false)
  }
})

test('content-prefix invalid sizes, duplicate keys, overflow, oversized pages and list failures fail closed', async () => {
  const item = { key: 'modules/' + 'a'.repeat(64) + '.js', size: 1, uploaded: new Date(1000) }
  for (const page of [
    { objects: [{ ...item, size: -1 }], truncated: false },
    { objects: [item, item], truncated: false },
    { objects: [{ ...item, size: Number.MAX_SAFE_INTEGER }, { ...item, key: 'modules/' + 'b'.repeat(64) + '.js' }], truncated: false },
    { objects: Array.from({ length: 65 }, () => item), truncated: false },
    { objects: [item] },
  ]) {
    const fx = fixture({ prefixPages: { 'modules/': page } }), response = await fx.request()
    assert.equal(response.status, 503)
    assert.equal(fx.calls.includes('get'), false)
  }
  const failed = fixture({ overrides: { list: async () => { throw new Error(SECRET) } } })
  const response = await failed.request()
  assert.ok(response.status >= 400)
  assert.equal((await response.text()).includes(SECRET), false)
})

test('abort while listing content prefixes prevents pointer reads', async () => {
  const pending = Promise.withResolvers(), started = Promise.withResolvers(), controller = new AbortController()
  const fx = fixture({ overrides: { list: async ({ prefix }) => {
    if (prefix === 'snapshots/') return { objects: [], truncated: false }
    started.resolve(); return pending.promise
  } } })
  const response = fx.request({ action: 'archive_status' }, { signal: controller.signal })
  await started.promise
  controller.abort(); pending.resolve({ objects: [], truncated: false })
  assert.ok((await response).status >= 400)
  assert.equal(fx.calls.includes('get'), false)
})
