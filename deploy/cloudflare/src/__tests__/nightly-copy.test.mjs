/** Nightly-copy rebuild drill: real object classes over fakes only; no live restore or network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bech32 } from '@scure/base'
import { encodeValue, decodeValue, dumpPage, LEFT_OUT, OBJECT_NAMES, NIGHTLY_PAGE_ROUTE, nightlyPageResponse,
  runNightlyCopy, nightlyDue, nightlyStatus, latestNightly, withholdMirrorRow } from '../nightly-copy.mjs'
import { createWorker } from '../worker.mjs'
import { X61HeadDurableObject, bootstrapPackage, canonicalBootstrap, digest, manifestId } from '../head-do.mjs'
import { MirrorDO, mirrorDigest } from '../mirror-do.mjs'
import { VoiceBridgeDO } from '../voice-bridge-do.mjs'
import { VOICE_BRIDGE_OBJECT_NAME } from '../voice-bridge.mjs'
import { WitnessDO } from '../witness-do.mjs'
import { MESSAGES_STORAGE_KEY, NIGHTLY_REDACTED_SECRET, handleMessagesRequest, readMessagesStatus, redactMessagesForCopy } from '../messages-store.mjs'
import { handleInternalTurnJournalRoute } from '../turn-journal.mjs'

const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')
const order = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const NOW = Date.parse('2026-11-18T19:17:00Z')
const ORIGIN = 'https://nightly.example.invalid'
const OWNER_EMAIL = 'owner@example.invalid'
const clone = value => structuredClone(value)

function memoryStorage(entries = [], { bookmarks = false } = {}) {
  let rows = new Map(entries), alarm = null, revision = 0, queue = Promise.resolve()
  const reads = [], lists = []
  const adapter = map => ({
    get: async key => { reads.push(key); return clone(map.get(key)) },
    put: async (key, value) => { map.set(key, clone(value)); revision++ },
    delete: async key => { revision++; return map.delete(key) },
    list: async (options = {}) => {
      lists.push(options)
      for (const key of Object.keys(options)) assert.ok(['prefix', 'start', 'startAfter', 'limit'].includes(key), key)
      const { prefix = '', start, startAfter, limit = Infinity } = options
      const keys = [...map.keys()].filter(key => key.startsWith(prefix) && (start === undefined || order(key, start) >= 0)
        && (startAfter === undefined || order(key, startAfter) > 0)).sort(order).slice(0, limit)
      const listed = new Map(keys.map(key => [key, map.get(key)]))
      listed.get = key => { reads.push(key); return Map.prototype.get.call(listed, key) }
      return listed
    },
    getAlarm: async () => alarm,
    setAlarm: async value => { alarm = value; revision++ },
    deleteAlarm: async () => { alarm = null; revision++ },
  })
  const storage = {
    get: key => adapter(rows).get(key), put: (key, value) => adapter(rows).put(key, value),
    delete: key => adapter(rows).delete(key), list: options => adapter(rows).list(options),
    getAlarm: async () => alarm, setAlarm: async value => { alarm = value; revision++ }, deleteAlarm: async () => { alarm = null; revision++ },
    transaction(operation) {
      const pending = queue.then(async () => { const staged = clone(rows); const result = await operation(adapter(staged)); rows = staged; return result })
      queue = pending.catch(() => {})
      return pending
    },
    snapshot: () => clone(rows), idle: () => queue, reads, lists,
    ...(bookmarks ? { getCurrentBookmark: async () => `bookmark-${revision}` } : {}),
  }
  return storage
}

function memoryBucket({ pageSize = 7 } = {}) {
  const values = new Map(), puts = [], gets = [], lists = [], heads = []
  let version = 0
  return {
    values, puts, gets, lists, heads,
    async put(key, text, options = {}) {
      const existing = values.get(key), condition = options.onlyIf
      if (condition?.etagMatches && existing?.etag !== condition.etagMatches) return null
      if (condition?.etagDoesNotMatch === '*' && existing) return null
      assert.equal(typeof text, 'string')
      const stored = { text, size: Buffer.byteLength(text), etag: String(++version) }
      values.set(key, stored); puts.push(key)
      return { key, size: stored.size, etag: stored.etag }
    },
    async get(key) {
      gets.push(key)
      const stored = values.get(key)
      return stored ? { size: stored.size, etag: stored.etag, text: async () => stored.text, json: async () => JSON.parse(stored.text) } : null
    },
    async head(key) { heads.push(key); const stored = values.get(key); return stored ? { key, size: stored.size, etag: stored.etag } : null },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      lists.push({ prefix, cursor, limit })
      const keys = [...values.keys()].filter(key => key.startsWith(prefix)).sort(order)
      const start = cursor ? Number(cursor) : 0, end = Math.min(keys.length, start + Math.min(limit, pageSize))
      return { objects: keys.slice(start, end).map(key => ({ key, size: values.get(key).size })), truncated: end < keys.length,
        ...(end < keys.length ? { cursor: String(end) } : {}) }
    },
  }
}
const reader = (storage, name, bounds = {}) => async options => {
  const url = new URL('https://x61.internal' + NIGHTLY_PAGE_ROUTE)
  for (const [key, value] of Object.entries({ ...options, ...bounds })) if (value !== undefined) url.searchParams.set(key, value)
  return (await nightlyPageResponse(new Request(url, { headers: { 'x-x6-internal-authorized': '1' } }), storage, name)).json()
}
const readers = (storages, bounds) => Object.fromEntries(OBJECT_NAMES.map(name => [name, reader(storages[name], name, bounds)]))
const stores = () => Object.fromEntries(OBJECT_NAMES.map(name => [name, memoryStorage([[name + ':row', { text: 'private row content' }]])]))

/** Test-only rebuild: reject altered manifests, pages, counts and duplicate keys before returning fresh stores. */
async function rebuildFromSet(bucket, set) {
  const item = await bucket.get(`nightly/${set}/manifest.json`)
  assert.ok(item)
  const text = await item.text(), status = await nightlyStatus(bucket)
  assert.equal(hash(text), status.sets.find(entry => entry.set === set).sha256)
  const pointer = await (await bucket.get('nightly/LATEST.json')).json()
  if (pointer.set === set) assert.equal(hash(text), pointer.sha256)
  const manifest = JSON.parse(text)
  assert.equal(manifest.complete, true)
  const rebuilt = {}
  for (const name of OBJECT_NAMES) {
    const source = manifest.objects[name], storage = memoryStorage(), seen = new Set()
    let bytes = 0, rows = 0
    for (const page of source.pages) {
      const object = await bucket.get(page.key)
      assert.ok(object)
      const text = await object.text()
      assert.equal(hash(text), page.sha256)
      assert.equal(Buffer.byteLength(text), page.bytes)
      const data = JSON.parse(text)
      assert.equal(data.rows.length, page.rows)
      for (const [key, value] of data.rows) {
        assert.equal(seen.has(key), false); seen.add(key)
        await storage.put(key, decodeValue(value)); rows++
      }
      bytes += page.bytes
    }
    assert.equal(rows, source.rows); assert.equal(bytes, source.bytes)
    rebuilt[name] = storage
  }
  return rebuilt
}

function world(t) {
  const storages = Object.fromEntries(OBJECT_NAMES.map(name => [name, memoryStorage()]))
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture-audience', OWNER_EMAIL,
    ARCHIVE_BUCKET: memoryBucket(), SOURCE_REVISION: 'a'.repeat(40), WITNESS_SWITCH: 'off', NIGHTLY_COPY: 'on' }
  const instances = {
    HEAD: new X61HeadDurableObject({ storage: storages.HEAD, getWebSockets: () => [] }, env, {}),
    MIRROR: new MirrorDO({ storage: storages.MIRROR }),
    VOICE_BRIDGE: new VoiceBridgeDO({ storage: storages.VOICE_BRIDGE }, env),
    WITNESS: new WitnessDO({ storage: storages.WITNESS }, env, { fetch: async () => { throw new Error('No network') } }),
  }
  const calls = []
  for (const name of OBJECT_NAMES) env[name] = {
    // Review: each object under the name its own callers use; the voice bridge is NOT 'node-main-v1'.
    idFromName(value) { assert.equal(value, name === 'VOICE_BRIDGE' ? VOICE_BRIDGE_OBJECT_NAME : 'node-main-v1', name); return value },
    get() { return { fetch: request => { calls.push([name, new URL(request.url).pathname]); return instances[name].fetch(request) } } },
  }
  env.ASSETS = { fetch: async () => new Response('Fixture asset') }
  const worker = createWorker({ now: () => NOW,
    verifyAccess: async request => request.headers.get('cookie') === 'CF_Authorization=fixture-token'
      ? { type: 'owner', email: OWNER_EMAIL, expires: Math.floor(NOW / 1000) + 3600 } : null,
    networkFetch: async () => { assert.fail('External network is forbidden') },
  })
  const fetchImpl = (url, init = {}) => worker.fetch(new Request(new URL(url, ORIGIN), { ...init,
    headers: { cookie: 'CF_Authorization=fixture-token', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...init.headers } }), env)
  t.after(async () => { for (const storage of Object.values(storages)) await storage.idle(); await instances.MIRROR.queue })
  return { env, worker, fetchImpl, storages, instances, calls, writes: { count: 0 } }
}
const b64 = text => Buffer.from(text).toString('base64')
const RECEIPTS = '/dsh/home/auma/seed/receipts.v3.jsonl'
const receiptLines = count => Array.from({ length: count }, (_, index) =>
  JSON.stringify({ schema: 'aukora.receipt.v3', seq: index + 1, hash: String(index + 1).padStart(64, 'a') })).join('\n') + '\n'

/** Seed a world the way the Mac seeded the live edge: one Pearl at `epoch`, and a home with `receipts` receipts. */
async function seed(edge, { epoch = 169, receipts = 3, note = 'she remembers the fixture', extra = [] } = {}) {
  const code = 'export default { fixture: true }', sha = await digest(code)
  const ball = { version: 'x6.1-ball/v1', parentBallId: 'c'.repeat(64), epoch,
    entries: { 'organ.fixture': { id: 'organ.fixture', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  ball.ballId = await manifestId(ball)
  const entries = [
    ['/dsh/home/auma', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/memory', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/memory/note.md', { kind: 'file', mode: 0o600, mtimeMs: 1700000000000, b64: b64(note) }],
    ['/dsh/home/auma/seed', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/seed/checkpoints.v1.jsonl', { kind: 'file', mode: 0o600, mtimeMs: 1700000000001, b64: b64('{"checkpoint":1}\n') }],
    [RECEIPTS, { kind: 'file', mode: 0o600, mtimeMs: 1700000000002, b64: b64(receiptLines(receipts)) }],
    ['/dsh/workspace/readme.txt', { kind: 'file', mode: 0o644, mtimeMs: 1700000000003, b64: b64('workspace') }],
    ...extra,
  ].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
  const pkg = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code },
    mirror: { entryCount: entries.length, batchDigests: [await digest(canonicalBootstrap(entries))] } })
  for (const input of [{ action: 'prepare', package: pkg }, { action: 'batch', seedId: pkg.seedId, index: 0, entries }, { action: 'commit', seedId: pkg.seedId }]) {
    const response = await edge.fetchImpl('/_bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    assert.equal(response.status, 200, await response.text())
  }
  edge.writes.count = 0
  return { ball }
}

test('tagged values survive JSON text and decode exactly, including tag-like own keys', () => {
  const values = [null, true, false, 42, -0, 'é🌏', undefined, [], {}, new Uint8Array([0, 255, 19]),
    new Uint8Array([0, 1, 2, 3]).subarray(1, 3), new ArrayBuffer(3), new Date(1700000000000),
    { undefined, nested: [undefined, { $bytes: 'literal', $$date: 'literal', $undefined: true, $number: '-0' }] },
    JSON.parse('{"__proto__":{"x":1},"constructor":"own","$":"yes"}')]
  for (const value of values) assert.deepEqual(decodeValue(JSON.parse(JSON.stringify(encodeValue(value)))), value)
  assert.deepEqual(encodeValue({ plain: [1, 'two', null, false] }), { plain: [1, 'two', null, false] })
})
for (const [name, value] of Object.entries({ Map: new Map(), Set: new Set(), BigInt: 1n, function: () => {}, NaN, Infinity,
  negativeInfinity: -Infinity, symbol: Symbol('x'), invalidDate: new Date(NaN), sparseArray: Array(3), regexp: /x/, typedArray: new Uint16Array(1),
  nullPrototype: Object.create(null), accessor: { get x() { throw new Error('must not run') } },
  hiddenKey: Object.defineProperty({}, 'hidden', { value: 1 }), symbolKey: { [Symbol('x')]: 1 },
})) test(`named refusal: ${name}`, () => assert.throws(() => encodeValue(value), { name: 'NightlyValueError' }))
test('cycles and shared identity cannot be silently changed', () => {
  const cyclic = {}; cyclic.self = cyclic
  const shared = {}
  for (const value of [cyclic, [shared, shared]]) assert.throws(() => encodeValue(value), { name: 'NightlyValueError' })
})
for (const count of [0, 1, 2, 7, 30000]) test(`bounded pages retain all ${count} keys in UTF-8 order`, async () => {
  const entries = Array.from({ length: count }, (_, i) => ['row:' + String(i).padStart(6, '0'), { i }])
  const storage = memoryStorage(entries), copied = []
  let after, pages = 0
  do {
    const page = await dumpPage(storage, { after, maxRows: count === 30000 ? 1000 : 7 })
    copied.push(...page.rows.map(([key, value]) => [key, decodeValue(value)])); after = page.next; pages++
    assert.ok(page.rows.length <= (count === 30000 ? 1000 : 7))
    assert.equal(page.bytes, Buffer.byteLength(JSON.stringify(page.rows)))
  } while (after !== null)
  assert.deepEqual(copied, entries)
  assert.equal(pages, Math.max(1, Math.ceil(count / (count === 30000 ? 1000 : 7))))
})
test('byte boundaries, non-ASCII cursors, and a larger-than-page row', async () => {
  const entries = [['é', 'huge'.repeat(100)], ['z', 'x'], ['🌏', 'end'], ['\ue000', 'last'], ['a', 'small']].sort(([a], [b]) => order(a, b))
  const storage = memoryStorage(entries), copied = [], lengths = []
  let after
  do {
    const page = await dumpPage(storage, { after, maxRows: 2, maxBytes: 25 })
    copied.push(...page.rows); lengths.push(page.rows.length)
    if (page.bytes > 25) assert.equal(page.rows.length, 1)
    after = page.next
  } while (after !== null)
  assert.deepEqual(copied, entries); assert.ok(lengths.length > 2)
  const full = [['a', 'x'], ['b', 'y']]
  assert.deepEqual((await dumpPage(memoryStorage(full), { maxBytes: Buffer.byteLength(JSON.stringify(full)) })).rows, full)
  assert.equal((await dumpPage(memoryStorage(full), { maxBytes: Buffer.byteLength(JSON.stringify(full)) - 1 })).rows.length, 1)
})
test('closed exclusions are named and counted without accessing their values; unreadable rows do not stop a page', async () => {
  assert.deepEqual(LEFT_OUT, { HEAD: ['aumlok:signin:v1', 'aumlok:devices:pending:v1', 'aumlok:v1'], MIRROR: [], VOICE_BRIDGE: [], WITNESS: [] })
  const storage = memoryStorage([...LEFT_OUT.HEAD.map(key => [key, () => { throw new Error('secret') }]), ['bad', new Map()], ['z', undefined]])
  const page = await dumpPage(storage, { leaveOut: LEFT_OUT.HEAD })
  assert.deepEqual(page.leftOut, [...LEFT_OUT.HEAD].sort(order)); assert.deepEqual(page.unreadable, ['bad']); assert.deepEqual(page.redacted, [])
  assert.deepEqual(page.rows.map(([key]) => key), ['z'])
  for (const key of LEFT_OUT.HEAD) assert.equal(storage.reads.includes(key), false)
})

test('real four-object world rebuilds key by key with conversation parts, open ends, messages, voice and witness rows', async t => {
  const edge = world(t); await seed(edge)
  const { HEAD, MIRROR, VOICE_BRIDGE, WITNESS } = edge.storages
  // Thread raw rows avoid acquiring a writer lease and populating an R2 part store merely to test KV coverage.
  await MIRROR.put('thread:v1:index:' + 'a'.repeat(64), { bytes: 37, chain: 'b'.repeat(64) })
  await MIRROR.put('thread:v1:parts:' + 'a'.repeat(64) + ':000000', [{ sha: 'c'.repeat(64), bytes: 30 }])
  await MIRROR.put('thread:v1:tail:' + 'a'.repeat(64) + ':0000000000', new Uint8Array([1, 2, 3]))
  const message = await handleMessagesRequest(new Request(ORIGIN + '/aukora-messages/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'auma-pearl', content: 'private row content', requestId: 'nightly-fixture' }),
  }), HEAD, { authorized: true, now: () => NOW })
  assert.equal(message.status, 200, await message.text())
  const storedMessages = clone(await HEAD.get(MESSAGES_STORAGE_KEY))
  assert.ok(storedMessages.turns.length)
  const ownerSecret = 'ab'.repeat(32)
  const ownerPubkey = Buffer.from(schnorr.getPublicKey(Uint8Array.from(Buffer.from(ownerSecret, 'hex')))).toString('hex')
  await HEAD.put(MESSAGES_STORAGE_KEY, { ...storedMessages, identity: { version: 'aukora.messages.identity/v1', secretKey: ownerSecret,
    pubkey: ownerPubkey, npub: bech32.encodeFromBytes('npub', Uint8Array.from(Buffer.from(ownerPubkey, 'hex'))) } })
  const journal = await handleInternalTurnJournalRoute(HEAD, 'POST', { turnId: 'fixture', provider: 'fixture', endpoint: '/fixture',
    requestSha256: 'a'.repeat(64), utteranceSha256: 'b'.repeat(64), utterancePreview: 'private row content' }, () => NOW)
  assert.equal(journal.status, 200, await journal.text())
  assert.ok(await HEAD.get('head:turn-journal:row:1'))
  await HEAD.put('aumlok:v1', { ownerBinding: 'retained' })
  await HEAD.put('gate-lockout:v1', { attempts: 2 })
  for (const key of LEFT_OUT.HEAD) await HEAD.put(key, { secret: 'do not copy' })
  await VOICE_BRIDGE.put('voice-memory:pending', { text: 'her voice memory', at: new Date(NOW) })
  await WITNESS.put('witness:record:1', { proof: new Uint8Array([4, 5]), optional: undefined })
  await WITNESS.setAlarm(NOW + 1000)
  // Exceed the default encoded page budget through the real route with legal-size binary values.
  for (let i = 0; i < 50; i++) await MIRROR.put('fixture:bytes:' + String(i).padStart(3, '0'), new Uint8Array(65536).fill(i))
  // Seeded exactly as the mirror writes a row: the key is mirrorDigest(path) and the path lives in the VALUE. The
  // old fixtures put the path in the key, which is why a key-reading rule passed here and matched nothing live.
  const hiddenId = await mirrorDigest('/dsh/home/auma/.env')
  const ordinaryId = await mirrorDigest('/dsh/home/auma/notes.md')
  // A chunk is stored as a base64 string (the mirror writes bytes that way). This one carries a long marker so the
  // test can search every written object for the hidden file's BYTES, not only for its path and digest.
  const hiddenBytes = 'hidden-chunk-bytes-marker-' + 'z'.repeat(48)
  await MIRROR.put(`mirror:v2:entry:${hiddenId}`, { path: '/dsh/home/auma/.env', kind: 'file', mode: 0o600, mtimeMs: 1, chunks: 1, bytes: Buffer.byteLength(hiddenBytes) })
  await MIRROR.put(`mirror:v2:chunk:${hiddenId}:000000`, b64(hiddenBytes))
  await MIRROR.put(`mirror:v2:reset:${hiddenId}`, '/dsh/home/auma/.env')
  await MIRROR.put(`mirror:v2:entry:${ordinaryId}`, { path: '/dsh/home/auma/notes.md', kind: 'file', mode: 0o644, mtimeMs: 2, chunks: 1, bytes: 8 })
  await MIRROR.put(`mirror:v2:chunk:${ordinaryId}:000000`, new Uint8Array([8]))
  await MIRROR.put('mirror:v2:conflict:' + 'd'.repeat(64), { id: 'd'.repeat(64), attempts: 1 })
  const before = Object.fromEntries(OBJECT_NAMES.map(name => [name, edge.storages[name].snapshot()]))
  for (let i = 0; i < 19; i++) await edge.env.ARCHIVE_BUCKET.put(`w/node-main-v1/blob/${String(i).padStart(64, '0')}`, 'blob')
  await edge.env.ARCHIVE_BUCKET.put('w/other/blob/ignored', 'other')
  const manifest = await runNightlyCopy(edge.env, { now: NOW })
  assert.equal(manifest.complete, true, JSON.stringify(manifest))
  assert.ok(manifest.objects.MIRROR.pages.length > 1)
  assert.ok(manifest.objects.MIRROR.bytes > 4 * 1024 * 1024)
  assert.equal(manifest.buildSha, edge.env.SOURCE_REVISION); assert.equal(manifest.sourceRevision, edge.env.SOURCE_REVISION)
  assert.deepEqual(Object.keys(manifest.objects), OBJECT_NAMES)
  assert.equal(manifest.vault.count, 19); assert.equal(manifest.vault.bytes, 76)
  assert.equal(manifest.vault.sha256, hash(Array.from({ length: 19 }, (_, i) => `w/node-main-v1/blob/${String(i).padStart(64, '0')} 4\n`).join('')))
  assert.ok(edge.env.ARCHIVE_BUCKET.lists.some(item => item.prefix.includes('/blob/') && item.cursor))
  assert.equal(edge.env.ARCHIVE_BUCKET.gets.some(key => key.includes('/blob/')), false)
  assert.equal(manifest.objects.WITNESS.alarm, NOW + 1000)
  for (const name of OBJECT_NAMES) {
    assert.deepEqual(edge.storages[name].snapshot(), before[name], 'page route must never write')
    assert.equal(manifest.objects[name].bookmarkBefore, null)
    assert.equal(manifest.objects[name].bookmarkBeforeReason, 'unavailable')
  }
  const rebuilt = await rebuildFromSet(edge.env.ARCHIVE_BUCKET, manifest.set)
  // Decided by the real rule over the pre-copy snapshot, so the test holds no second copy of the logic to agree with.
  const mirrorWithheld = new Set()
  for (const [key] of before.MIRROR) {
    if (await withholdMirrorRow(key, { get: candidate => before.MIRROR.get(candidate) }, async candidate => before.MIRROR.get(candidate))) mirrorWithheld.add(key)
  }
  for (const name of OBJECT_NAMES) {
    const expected = new Map([...before[name]].filter(([key]) => !LEFT_OUT[name].includes(key)
      && !(name === 'MIRROR' && mirrorWithheld.has(key))))
    if (name === 'HEAD' && expected.has(MESSAGES_STORAGE_KEY)) {
      const stored = expected.get(MESSAGES_STORAGE_KEY)
      expected.set(MESSAGES_STORAGE_KEY, { ...stored, identity: { ...stored.identity, secretKey: NIGHTLY_REDACTED_SECRET } })
    }
    assert.deepEqual(rebuilt[name].snapshot(), expected)
  }
  // The hidden file's entry, its chunk and its reset row are withheld, and the conflict row is counted apart.
  assert.deepEqual([manifest.objects.MIRROR.withheld, manifest.objects.MIRROR.withheldHidden, manifest.objects.MIRROR.withheldConflict],
    [4, 3, 1])
  assert.equal(manifest.objects.MIRROR.withheldReads, 'value')
  assert.match(manifest.objects.MIRROR.withheldRule, /^mirror-hidden-path-rule:v/)
  assert.equal(rebuilt.MIRROR.snapshot().has(`mirror:v2:entry:${hiddenId}`), false)
  assert.equal(rebuilt.MIRROR.snapshot().has(`mirror:v2:chunk:${hiddenId}:000000`), false, 'a chunk follows its entry')
  assert.equal(rebuilt.MIRROR.snapshot().has(`mirror:v2:reset:${hiddenId}`), false, 'a reset row holds the path as a string')
  assert.equal(rebuilt.MIRROR.snapshot().has(`mirror:v2:entry:${ordinaryId}`), true)
  assert.equal(rebuilt.MIRROR.snapshot().has(`mirror:v2:chunk:${ordinaryId}:000000`), true)
  // No page and no manifest byte may carry the hidden path or its digest as a name.
  for (const [key, stored] of edge.env.ARCHIVE_BUCKET.values.entries()) {
    for (const needle of ['/dsh/home/auma/.env', hiddenId, hiddenBytes, b64(hiddenBytes)])
      assert.equal(stored.text.includes(needle), false, `${key} carries ${needle}`)
  }
  assert.equal(await readMessagesStatus(rebuilt.HEAD), null)
  const refused = await handleMessagesRequest(new Request(ORIGIN + '/aukora-messages/thread', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'auma-pearl' }),
  }), rebuilt.HEAD, { authorized: true, now: () => NOW })
  assert.equal(refused.status, 503)
  assert.equal((await refused.json()).code, 'MESSAGES_STATE_CORRUPT')
  const status = await (await edge.fetchImpl('/_host/nightly')).json()
  assert.equal(status.latest.set, manifest.set)
  assert.deepEqual(status.latest.objects.HEAD, { rows: manifest.objects.HEAD.rows, bytes: manifest.objects.HEAD.bytes,
    pages: manifest.objects.HEAD.pages.length, leftOut: 3, redacted: 1, withheld: 0, withheldHidden: 0, withheldConflict: 0, withheldReads: null,
    unreadable: 0, changedDuring: false, bookmarks: { before: false, after: false }, complete: true, code: null })
  assert.deepEqual([status.latest.objects.MIRROR.withheldHidden, status.latest.objects.MIRROR.withheldConflict, status.latest.objects.MIRROR.withheldReads],
    [3, 1, 'value'])
  assert.deepEqual(status.latest.vault, { count: 19, bytes: 76 })
  const statusText = JSON.stringify(status)
  for (const secret of ['private row content', 'do not copy', 'ownerBinding', 'aumlok:', 'her voice memory', 'bookmark-']) assert.equal(statusText.includes(secret), false)
  const health = await (await edge.fetchImpl('/api/health')).json()
  assert.deepEqual(health.lastNightly, { set: manifest.set, complete: true, finishedAt: manifest.finishedAt })
  const puts = edge.env.ARCHIVE_BUCKET.puts.length
  assert.equal((await runNightlyCopy(edge.env, { now: NOW + 3600000 })).code, 'NIGHTLY_NOT_DUE')
  assert.equal(edge.env.ARCHIVE_BUCKET.puts.length, puts)
  const lastPuts = edge.env.ARCHIVE_BUCKET.puts.slice(-3)
  assert.deepEqual(lastPuts, [`nightly/${manifest.set}/manifest.json`, 'nightly/LATEST.json', 'nightly/STATE.json'])
})

// 324b58de item 5: the three faults the suite could not see, because its fixtures put the path in the key while the
// mirror puts mirrorDigest(path) there. With every row below seeded the way the mirror writes it, each of these turns
// THIS test red:
//   1. the rule reads the key (the fault that landed at noon) — nothing is withheld, and the hidden bytes are copied;
//   2. a chunk is copied without asking its entry — the hidden file's bytes go with it;
//   3. a chunk whose entry is gone or unreadable is copied — the orphan case, where nothing in storage names its path;
//   4. a `mirror:v2:conflict-chunk:` row is copied because only the metadata prefix counts as a conflict.
test('a MIRROR row is judged by the path in its VALUE; a hidden file\'s chunk follows its entry and an orphan follows nothing', async () => {
  const hidden = await mirrorDigest('/dsh/home/.session.cap')
  const visible = await mirrorDigest('/dsh/home/auma/memory/note.md')
  const orphan = await mirrorDigest('/dsh/home/auma/memory/gone.md')
  const broken = await mirrorDigest('/dsh/home/auma/memory/broken.md')
  const storage = memoryStorage([
    [`mirror:v2:chunk:${hidden}:000000`, new Uint8Array([1])],
    [`mirror:v2:chunk:${visible}:000000`, new Uint8Array([2])],
    [`mirror:v2:chunk:${orphan}:000000`, new Uint8Array([3])],
    [`mirror:v2:chunk:${broken}:000000`, new Uint8Array([4])],
    [`mirror:v2:conflict:${'d'.repeat(64)}`, { id: 'd'.repeat(64), attempts: 1 }],
    // A conflict row's chunk prefix must count as a conflict too: narrowing the prefix to `mirror:v2:conflict:` copies this.
    [`mirror:v2:conflict-chunk:${'e'.repeat(64)}:000000`, b64('conflict bytes that must never be copied')],
    [`mirror:v2:entry:${broken}`, { kind: 'file', chunks: 1, bytes: 1 }],
    [`mirror:v2:entry:${hidden}`, { path: '/dsh/home/.session.cap', kind: 'file', chunks: 1, bytes: 1 }],
    [`mirror:v2:entry:${visible}`, { path: '/dsh/home/auma/memory/note.md', kind: 'file', chunks: 1, bytes: 1 }],
    [`mirror:v2:reset:${hidden}`, '/dsh/home/.session.cap'],
    ['mirror:v2:global-fence', { revision: 3 }],
    ['thread:v1:index:' + 'a'.repeat(64), { bytes: 37 }],
  ])
  const page = await dumpPage(storage, { withhold: withholdMirrorRow })
  // The four rows that copy are the visible file's entry and chunk, and the two rows that are not file rows at all.
  assert.deepEqual(page.rows.map(([key]) => key), [`mirror:v2:chunk:${visible}:000000`, `mirror:v2:entry:${visible}`,
    'mirror:v2:global-fence', 'thread:v1:index:' + 'a'.repeat(64)])
  // `chunk` sorts before `entry`: the hidden chunk is met before the entry that condemns it and is still withheld. The
  // conflict-chunk row is a conflict too, so narrowing the conflict prefix to the metadata form turns this red.
  assert.deepEqual([page.withheld, page.withheldHidden, page.withheldConflict], [8, 6, 2])
  assert.deepEqual([page.leftOut, page.unreadable], [[], []])
  const text = JSON.stringify(page.rows)
  for (const needle of ['/dsh/home/.session.cap', hidden]) assert.equal(text.includes(needle), false, needle)
  // Nothing withheld is ever encoded, and a chunk's own value is never read: only entries and resets are looked at.
  assert.equal(storage.reads.includes(`mirror:v2:chunk:${hidden}:000000`), false)
  assert.equal(storage.reads.includes(`mirror:v2:entry:${hidden}`), true)
})

// Review (CHANGED): an entry read that threw used to be counted as a withheld hidden row, so a storage hiccup
// could publish a "complete" set that silently dropped a file's bytes. A fault must fail the page and the object;
// 'hidden' stays for a missing entry or an entry with no string path.
test('an entry read that throws fails the page and the object, and is never counted as a hidden row', async () => {
  const faulted = await mirrorDigest('/dsh/home/auma/memory/faulted.md')
  const storage = memoryStorage([
    [`mirror:v2:chunk:${faulted}:000000`, b64('bytes whose entry cannot be read')],
    [`mirror:v2:entry:${faulted}`, { path: '/dsh/home/auma/memory/faulted.md', kind: 'file', chunks: 1, bytes: 35 }],
    ['thread:v1:index:' + 'a'.repeat(64), { bytes: 37 }],
  ])
  const get = storage.get
  storage.get = key => key === `mirror:v2:entry:${faulted}` ? Promise.reject(new Error('storage read failed')) : get(key)
  // The rule rethrows a closed fault; it never answers 'hidden' for a read that failed.
  await assert.rejects(withholdMirrorRow(`mirror:v2:chunk:${faulted}:000000`, new Map(), storage.get), { name: 'NightlyReadFault' })
  await assert.rejects(dumpPage(storage, { withhold: withholdMirrorRow }), { name: 'NightlyReadFault' })
  // End to end: the MIRROR object fails its page, the set is incomplete, and no withheld count absorbs the fault.
  const bucket = memoryBucket()
  const manifest = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects: readers({ ...stores(), MIRROR: storage }), bucket })
  assert.equal(manifest.complete, false)
  assert.equal(manifest.objects.MIRROR.complete, false)
  assert.equal(manifest.objects.MIRROR.code, 'NIGHTLY_PAGE_FAILED')
  assert.deepEqual([manifest.objects.MIRROR.withheld, manifest.objects.MIRROR.withheldHidden, manifest.objects.MIRROR.withheldConflict], [0, 0, 0])
  for (const name of OBJECT_NAMES.filter(candidate => candidate !== 'MIRROR')) assert.equal(manifest.objects[name].complete, true, name)
  assert.equal(await bucket.head('nightly/LATEST.json'), null)
})

test('the copy leaves the owner row out and redacts the Nostr key, naming both without writing either value', async () => {
  const SECRET = 'ab'.repeat(32), OWNER = 'owner-pepper-marker-' + 'cd'.repeat(16)
  const storage = stores()
  storage.HEAD = memoryStorage([
    [MESSAGES_STORAGE_KEY, { version: 'aukora.messages/v1',
      conversations: [{ id: 'auma-pearl', kind: 'channel', name: 'Auma Pearl' }],
      turns: [{ id: 'turn-1', content: 'kept turn' }],
      identity: { version: 'aukora.messages.identity/v1', secretKey: SECRET, pubkey: 'ef'.repeat(32), npub: 'npub1fixture' } }],
    ['aumlok:v1', { pepper: OWNER, binding: { rootEscrow: { sealedRootKeyB64: OWNER } } }],
    ['aumlok:signin:v1', { signin: 'fixture' }],
    ['aumlok:devices:pending:v1', { pending: 'fixture' }],
    ['ordinary:row', { kept: true }],
  ])
  const bucket = memoryBucket()
  const manifest = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects: readers(storage), bucket })
  assert.equal(manifest.complete, true, JSON.stringify(manifest))
  assert.deepEqual(manifest.objects.HEAD.leftOut, [...LEFT_OUT.HEAD].sort(order))
  assert.deepEqual(manifest.objects.HEAD.redacted, [MESSAGES_STORAGE_KEY])
  assert.equal(manifest.objects.HEAD.complete, true)
  // Every byte the run wrote under this set, pages and manifest alike.
  const written = [...bucket.values.entries()].filter(([key]) => key.startsWith(`nightly/${manifest.set}/`))
    .map(([, value]) => value.text).join('\n')
  assert.equal(written.includes(SECRET), false, 'the signing key is not in the copy')
  assert.equal(written.includes(OWNER), false, 'the owner row value is not in the copy')
  assert.equal(written.includes(NIGHTLY_REDACTED_SECRET), true, 'the redaction is visible')
  const pages = [...bucket.values.entries()].filter(([key]) => key.startsWith(`nightly/${manifest.set}/HEAD/`))
    .map(([, value]) => JSON.parse(value.text))
  const row = pages.flatMap(page => page.rows).find(([key]) => key === MESSAGES_STORAGE_KEY)
  assert.ok(row, 'the messages row is still copied')
  const copied = decodeValue(row[1])
  assert.equal(copied.identity.secretKey, NIGHTLY_REDACTED_SECRET)
  assert.equal(copied.identity.pubkey, 'ef'.repeat(32))
  assert.equal(copied.turns[0].content, 'kept turn')
  assert.equal(copied.conversations[0].name, 'Auma Pearl')
  assert.equal(pages.flatMap(page => page.rows).some(([key]) => key === 'aumlok:v1'), false, 'the owner row is not copied')
  // A redaction that throws must fail the page rather than copy the unreplaced value.
  await assert.rejects(dumpPage(memoryStorage([['x', { secret: 's' }]]), { redact: { x: () => { throw new Error('redaction refused') } } }), /redaction refused/)
  assert.deepEqual((await dumpPage(memoryStorage([['x', 1]]))).redacted, [])
})

test('a redaction is named once, on the page that actually carries its row', async () => {
  const SECRET = 'ab'.repeat(32)
  const stored = { version: 'aukora.messages/v1', conversations: [], turns: [],
    identity: { version: 'aukora.messages.identity/v1', secretKey: SECRET, pubkey: 'ef'.repeat(32), npub: 'npub1fixture' } }
  const projected = { ...stored, identity: { ...stored.identity, secretKey: NIGHTLY_REDACTED_SECRET } }
  const rowBytes = (key, value) => Buffer.byteLength(JSON.stringify([key, encodeValue(value)]))
  // One byte short of holding 'a' and the messages row together, so the messages row is held over to page two.
  const maxBytes = 2 + rowBytes('a', 'first') + rowBytes(MESSAGES_STORAGE_KEY, projected)
  const storage = memoryStorage([['a', 'first'], [MESSAGES_STORAGE_KEY, stored], ['z', 'last']])
  const options = { maxBytes, redact: { [MESSAGES_STORAGE_KEY]: redactMessagesForCopy } }
  const first = await dumpPage(storage, options)
  assert.deepEqual(first.rows.map(([key]) => key), ['a'], 'the messages row is held over')
  assert.deepEqual(first.redacted, [], 'the row was scanned but not carried, so nothing is named')
  const second = await dumpPage(storage, { ...options, after: first.next })
  assert.deepEqual(second.redacted, [MESSAGES_STORAGE_KEY], 'named where the row actually lands')
  assert.equal(second.next, null)
  const bucket = memoryBucket()
  const manifest = await runNightlyCopy({ NIGHTLY_COPY: 'on' },
    { now: NOW, objects: readers({ ...stores(), HEAD: storage }, { maxBytes }), bucket })
  assert.equal(manifest.complete, true, JSON.stringify(manifest))
  assert.ok(manifest.objects.HEAD.pages.length > 1, 'the messages row must be held over for this to prove the boundary')
  assert.deepEqual(manifest.objects.HEAD.redacted, [MESSAGES_STORAGE_KEY], 'one name, not one per scan')
  assert.equal((await nightlyStatus(bucket)).latest.objects.HEAD.redacted, 1)
})

test('a manifest written before the redaction field still reads in status', async () => {
  const bucket = memoryBucket()
  const manifest = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects: readers(stores()), bucket })
  const text = JSON.stringify({ ...manifest, objects: Object.fromEntries(Object.entries(manifest.objects).map(([name, object]) => {
    const { redacted, ...rest } = object
    return [name, rest]
  })) })
  await bucket.put(`nightly/${manifest.set}/manifest.json`, text)
  await bucket.put('nightly/LATEST.json', JSON.stringify({ set: manifest.set, sha256: hash(text), finishedAt: manifest.finishedAt }))
  const status = await nightlyStatus(bucket)
  assert.equal(status.latest.objects.HEAD.redacted, null)
})

// Review (CHANGED): two different bookmarks no longer say "changed". Whether a bookmark moves with time alone is
// not verified on the platform, and a false "changed" every night would mislead; equal bookmarks still prove "unchanged".
test('a changed first page is reported; equal bookmarks prove nothing changed; different bookmarks and failed comparisons are unknown', async () => {
  for (const mode of ['first', 'bookmark', 'unknown', 'stable']) {
    const storage = memoryStorage([['a', 1], ['b', 2], ['c', 3]], { bookmarks: mode === 'bookmark' || mode === 'stable' })
    const objectReaders = readers(stores()), base = reader(storage, 'HEAD', { maxRows: 1 })
    let reads = 0
    objectReaders.HEAD = async options => {
      reads++
      if (reads === 2 && mode === 'first') await storage.put('a', 9)
      if (reads === 2 && mode === 'bookmark') await storage.put('c', 9)
      if (reads === 4 && mode === 'unknown') throw new Error('secret failed read')
      return base(options)
    }
    const manifest = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects: objectReaders, bucket: memoryBucket() })
    assert.equal(manifest.objects.HEAD.changedDuring, { first: true, bookmark: null, unknown: null, stable: false }[mode], mode)
    assert.equal(manifest.objects.HEAD.complete, true)
    if (mode === 'bookmark') assert.notEqual(manifest.objects.HEAD.bookmarkBefore, manifest.objects.HEAD.bookmarkAfter)
  }
})
test('an unchanged first page without bookmarks cannot establish stability of later pages', async () => {
  for (const mutate of [false, true]) {
    const storage = memoryStorage([['a', 1], ['b', 2], ['c', 3]])
    const objectReaders = readers(stores()), base = reader(storage, 'HEAD', { maxRows: 1 })
    let calls = 0
    objectReaders.HEAD = async options => {
      if (++calls === 3 && mutate) await storage.put('b', 9)
      return base(options)
    }
    const manifest = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects: objectReaders, bucket: memoryBucket() })
    assert.equal(manifest.objects.HEAD.changedDuring, null)
    assert.equal(manifest.objects.HEAD.complete, true)
  }
})
test('an unreadable row leaves a named incomplete manifest and copies all other objects', async () => {
  const storage = stores(), bucket = memoryBucket()
  storage.HEAD = memoryStorage([['bad-map', new Map()], ['good', 'still copied']])
  const manifest = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects: readers(storage), bucket })
  assert.equal(manifest.complete, false); assert.deepEqual(manifest.objects.HEAD.unreadable, ['bad-map'])
  assert.equal(manifest.objects.HEAD.rows, 1); assert.equal(manifest.objects.HEAD.code, 'NIGHTLY_UNREADABLE')
  for (const name of OBJECT_NAMES.slice(1)) assert.equal(manifest.objects[name].complete, true)
  assert.ok(await bucket.head(`nightly/${manifest.set}/manifest.json`)); assert.equal(await bucket.head('nightly/LATEST.json'), null)
})
test('one failed object is isolated and its error text is never written; a previous LATEST stays intact', async () => {
  const bucket = memoryBucket(), objectReaders = readers(stores())
  const good = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects: objectReaders, bucket })
  objectReaders.HEAD = async () => { throw new Error('secret row and credentials') }
  const bad = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW + 86400000, objects: objectReaders, bucket })
  assert.equal(bad.complete, false); assert.equal(bad.objects.HEAD.code, 'NIGHTLY_PAGE_FAILED')
  for (const name of OBJECT_NAMES.slice(1)) assert.equal(bad.objects[name].complete, true)
  assert.equal(JSON.stringify(bad).includes('secret'), false)
  assert.equal((await latestNightly(bucket)).set, good.set)
  const status = await nightlyStatus(bucket)
  assert.equal(status.latest.set, bad.set)
  assert.equal(status.latest.complete, false)
  assert.equal(status.latest.objects.HEAD.code, 'NIGHTLY_PAGE_FAILED')
  assert.equal(status.latestCompleteSet, good.set)
})
for (const target of ['page', 'manifest', 'latest', 'vault']) test(`${target} failure keeps a closed state and never publishes an incomplete pointer`, async () => {
  const bucket = memoryBucket(), originalPut = bucket.put, originalList = bucket.list
  bucket.put = async (key, ...args) => {
    if (target === 'page' && key.includes('/HEAD/') || target === 'manifest' && key.endsWith('/manifest.json') || target === 'latest' && key === 'nightly/LATEST.json') throw new Error('secret')
    return originalPut(key, ...args)
  }
  bucket.list = async options => {
    if (target === 'vault' && options.prefix.includes('/blob/')) throw new Error('secret')
    return originalList(options)
  }
  const result = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects: readers(stores()), bucket })
  assert.equal(await bucket.head('nightly/LATEST.json'), null)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  if (target === 'page') {
    assert.equal(result.objects.HEAD.code, 'NIGHTLY_PAGE_WRITE_FAILED')
    for (const name of OBJECT_NAMES.slice(1)) assert.equal(result.objects[name].complete, true)
  }
  if (target === 'manifest') assert.equal(await bucket.head(`nightly/2026-11-18T19-17-00Z/manifest.json`), null)
})
test('the rebuild drill detects page and manifest corruption', async () => {
  const bucket = memoryBucket(), result = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects: readers(stores()), bucket })
  const key = result.objects.HEAD.pages[0].key, original = bucket.values.get(key).text
  await bucket.put(key, original.replace('private', 'altered'))
  await assert.rejects(rebuildFromSet(bucket, result.set), assert.AssertionError)
  await bucket.put(key, original)
  await bucket.put(`nightly/${result.set}/manifest.json`, JSON.stringify({ ...result, complete: false }))
  await assert.rejects(rebuildFromSet(bucket, result.set), /HASH_MISMATCH/)
})
test('due boundaries use UTC start time, including initial catch-up before 19:00', () => {
  const latest = { set: '2026-11-17T19-17-00Z', finishedAt: '2026-11-17T19:18:00Z' }
  assert.equal(nightlyDue(null, Date.parse('2026-11-18T18:59:59.999Z')), true)
  assert.equal(nightlyDue(latest, Date.parse('2026-11-18T18:59:59.999Z')), false)
  assert.equal(nightlyDue(latest, Date.parse('2026-11-18T19:00:00Z')), true)
  assert.equal(nightlyDue({ ...latest, set: '2026-11-18T18-59-59Z' }, NOW), true)
  assert.equal(nightlyDue({ ...latest, set: '2026-11-18T19-00-00Z' }, NOW), false)
  assert.equal(nightlyDue({ ...latest, set: '2026-11-18T19-00-00Z' }, Date.parse('2026-11-19T00:00:00Z')), false)
})
test('three failed attempts exhaust a window, and the next UTC window admits another', async () => {
  const bucket = memoryBucket(), objectReaders = readers(stores())
  objectReaders.HEAD = async () => { throw new Error('failed') }
  for (let i = 0; i < 3; i++) assert.equal((await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW + i * 3600000, objects: objectReaders, bucket })).complete, false)
  const puts = bucket.puts.length
  assert.equal((await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW + 3 * 3600000, objects: objectReaders, bucket })).code, 'NIGHTLY_ATTEMPTS_EXHAUSTED')
  assert.equal(bucket.puts.length, puts)
  const state = await (await bucket.get('nightly/STATE.json')).json()
  assert.equal(state.attempts, 3); assert.equal(state.code, 'NIGHTLY_INCOMPLETE')
  assert.equal((await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW + 86400000, objects: objectReaders, bucket })).complete, false)
  assert.equal((await (await bucket.get('nightly/STATE.json')).json()).attempts, 1)
})
test('overlapping cron deliveries reserve only one attempt and second-resolution sets are never overwritten', async () => {
  const bucket = memoryBucket(), objects = readers(stores())
  const results = await Promise.all([runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects, bucket }), runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects, bucket })])
  assert.equal(results.filter(result => result.complete).length, 1)
  assert.equal(results.filter(result => result.code === 'NIGHTLY_BUSY').length, 1)
  assert.equal((await (await bucket.get('nightly/STATE.json')).json()).attempts, 1)
  const failed = memoryBucket()
  const failing = { ...objects, HEAD: async () => { throw new Error('fail') } }
  await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects: failing, bucket: failed })
  const text = failed.values.get('nightly/2026-11-18T19-17-00Z/manifest.json').text
  assert.equal((await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects: failing, bucket: failed })).code, 'NIGHTLY_SET_EXISTS')
  assert.equal(failed.values.get('nightly/2026-11-18T19-17-00Z/manifest.json').text, text)
})
test('switch off reads and writes nothing; schedule isolates witness failure and does not run twice tonight', async t => {
  assert.match(readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8'), /^NIGHTLY_COPY = "on"$/m)
  const bucket = memoryBucket()
  assert.equal((await runNightlyCopy({ NIGHTLY_COPY: 'off', ARCHIVE_BUCKET: bucket })).code, 'NIGHTLY_OFF')
  assert.deepEqual([bucket.puts, bucket.gets, bucket.lists], [[], [], []])
  for (const value of [undefined, 'ON', 'invalid', '']) assert.equal((await runNightlyCopy({ NIGHTLY_COPY: value, ARCHIVE_BUCKET: bucket })).code, 'NIGHTLY_OFF')
  const edge = world(t)
  let ticks = 0
  const witness = edge.env.WITNESS
  edge.env.WITNESS = { ...witness, get: () => ({ fetch: request => {
    if (new URL(request.url).pathname === '/_witness/tick') { ticks++; throw new Error('witness failed') }
    return witness.get().fetch(request)
  } }) }
  edge.env.WITNESS_SWITCH = 'on'; edge.env.NIGHTLY_COPY = 'off'
  await edge.worker.scheduled({}, edge.env, {})
  assert.equal(ticks, 1); assert.equal(edge.env.ARCHIVE_BUCKET.puts.length, 0)
  edge.env.NIGHTLY_COPY = 'on'
  await edge.worker.scheduled({}, edge.env, {})
  assert.equal(ticks, 2); assert.equal((await latestNightly(edge.env.ARCHIVE_BUCKET)).complete, true)
  const puts = edge.env.ARCHIVE_BUCKET.puts.length
  await edge.worker.scheduled({}, edge.env, {})
  assert.equal(ticks, 3); assert.equal(edge.env.ARCHIVE_BUCKET.puts.length, puts)
})

test('the four real internal page routes require the internal header and never write', async t => {
  const edge = world(t)
  for (const name of OBJECT_NAMES) {
    const before = edge.storages[name].snapshot()
    for (const method of ['GET', 'POST']) {
      const response = await edge.instances[name].fetch(new Request('https://x61.internal' + NIGHTLY_PAGE_ROUTE, { method }))
      assert.equal(response.status, 401)
    }
    const response = await edge.instances[name].fetch(new Request('https://x61.internal' + NIGHTLY_PAGE_ROUTE, { headers: { 'x-x6-internal-authorized': '1' } }))
    assert.equal(response.status, 200)
    assert.deepEqual(edge.storages[name].snapshot(), before)
  }
})
test('no public path forwards a nightly page read, even with an owner session and forged internal header', async t => {
  const edge = world(t); await seed(edge)
  const paths = [NIGHTLY_PAGE_ROUTE, '/_nightly', '/_nightly/page?after=a', '/_head/_nightly/page', '/_mirror/_nightly/page',
    '/voice-bridge/_nightly/page', '/_witness/_nightly/page', '/_host/_nightly/page', '/%5Fnightly/page', '/_head/../_nightly/page']
  for (const cookie of ['', 'CF_Authorization=fixture-token']) for (const path of paths) for (const method of ['GET', 'POST']) {
    edge.calls.length = 0
    const response = await edge.fetchImpl(path, { method, headers: { cookie, 'x-x6-internal-authorized': '1' } })
    if (response.status === 200) assert.equal(await response.text(), 'Fixture asset', `${path} must only serve the asset fallback`)
    assert.equal(edge.calls.some(([, route]) => route === NIGHTLY_PAGE_ROUTE), false, `${path} forwarded to a page read`)
    assert.equal(edge.calls.some(([name]) => name === 'VOICE_BRIDGE' || name === 'WITNESS'), false)
  }
})
test('status is owner-only, same-origin GET with no query, and lists newest 30 finished manifests', async t => {
  const edge = world(t), bucket = edge.env.ARCHIVE_BUCKET
  await runNightlyCopy(edge.env, { now: NOW })
  for (let day = 1; day <= 35; day++) await runNightlyCopy(edge.env, { now: NOW + day * 86400000 })
  const status = await (await edge.fetchImpl('/_host/nightly')).json()
  assert.equal(status.sets.length, 30)
  assert.equal(status.sets[0].set, status.latest.set)
  assert.ok(status.sets.every(item => /^[a-f0-9]{64}$/.test(item.sha256)))
  for (const init of [{ headers: { cookie: '' } }, { method: 'POST' }, { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { 'sec-fetch-site': '' } }, { headers: { origin: 'https://other.invalid' } }]) {
    bucket.gets.length = 0
    const response = await edge.fetchImpl('/_host/nightly', init)
    assert.notEqual(response.status, 200)
    assert.equal(bucket.gets.some(key => key.startsWith('nightly/')), false)
  }
  assert.equal((await edge.fetchImpl('/_host/nightly?x=1')).status, 404)
})

test('review: each object is reached under the name its own callers use, so no copy is ever taken of a new, empty object', async () => {
  const { OBJECT_IDS } = await import('../nightly-copy.mjs')
  assert.deepEqual(OBJECT_IDS, { HEAD: 'node-main-v1', MIRROR: 'node-main-v1', VOICE_BRIDGE: VOICE_BRIDGE_OBJECT_NAME, WITNESS: 'node-main-v1' })
  assert.equal(VOICE_BRIDGE_OBJECT_NAME, 'x61-voice-bridge-v1')
  // The callers' own spellings, read from the source: a rename there must turn this red.
  const source = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
  assert.match(source('worker.mjs'), /env\.MIRROR\.idFromName\('node-main-v1'\)/)
  assert.match(source('witness-do.mjs'), /idFromName\('node-main-v1'\)/)
  assert.match(source('voice-bridge.mjs'), /idFromName\(VOICE_BRIDGE_OBJECT_NAME\)/)
  assert.match(source('voice-bridge-do.mjs'), /env\.HEAD\.idFromName\('node-main-v1'\)/)
})

test('the redactor fails closed on any shape but the exact persisted messages value', async () => {
  const valid = { version: 'aukora.messages/v1', conversations: [], turns: [],
    identity: { version: 'aukora.messages.identity/v1', secretKey: 'ab'.repeat(32), pubkey: 'ef'.repeat(32), npub: 'npub1fixture' } }
  assert.equal(redactMessagesForCopy(valid).identity.secretKey, NIGHTLY_REDACTED_SECRET)
  const bad = [null, [], {}, { version: 'aukora.messages/v1', conversations: [], turns: [], extra: 1 },
    { ...valid, identity: [valid.identity] },
    { ...valid, identity: { ...valid.identity, extra: 1 } },
    { ...valid, identity: { version: 'aukora.messages.identity/v1', secretKey: 'ab'.repeat(32), pubkey: 'ef'.repeat(32) } },
    { ...valid, identity: { ...valid.identity, secretKey: { nested: 'ab'.repeat(32) } } }]
  for (const value of bad) assert.throws(() => redactMessagesForCopy(value), /redacted safely/)
  assert.deepEqual(redactMessagesForCopy({ version: 'aukora.messages/v1', conversations: [], turns: [] }),
    { version: 'aukora.messages/v1', conversations: [], turns: [] })
  await assert.rejects(dumpPage(memoryStorage([[MESSAGES_STORAGE_KEY, { version: 'aukora.messages/v1', turns: [] }]]),
    { redact: { [MESSAGES_STORAGE_KEY]: redactMessagesForCopy } }), /redacted safely/)
})

test('a page that cannot say how its withheld rows split, or that names no redaction, fails the object instead of publishing a set', async () => {
  for (const fault of ['drop-redacted', 'drop-withheld', 'drop-hidden', 'drop-conflict', 'sum']) {
    const bucket = memoryBucket(), objects = readers(stores())
    objects.HEAD = async options => {
      const page = await readers(stores()).HEAD(options)
      if (fault === 'drop-redacted') delete page.redacted
      else if (fault === 'drop-withheld') delete page.withheld
      else if (fault === 'drop-hidden') delete page.withheldHidden
      else if (fault === 'drop-conflict') delete page.withheldConflict
      else { page.withheld = 1; page.withheldHidden = 2; page.withheldConflict = 0 }
      return page
    }
    const manifest = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, objects, bucket })
    assert.equal(manifest.objects.HEAD.complete, false, fault)
    assert.equal(manifest.objects.HEAD.code, 'NIGHTLY_PAGE_FAILED', fault)
    assert.equal(manifest.complete, false, fault)
    assert.equal(await bucket.head('nightly/LATEST.json'), null, fault)
    assert.deepEqual(bucket.puts.filter(key => key.startsWith(`nightly/${manifest.set}/HEAD/`)), [], fault)
  }
})
