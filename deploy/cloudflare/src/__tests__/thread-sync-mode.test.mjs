/**
 * THREAD_SYNC is told to the client as `sync` on every page of the thread index, and nowhere else.
 *  - The table: only exactly `pull` and `on` mean pull and on; every other value means off.
 *  - Through the REAL MirrorDO (internal `/_mirror/thread` index) and through the REAL thread mount's public
 *    `GET /_thread/index` in front of it: the answer is wave 3's answer plus `sync`, on every page, `?limit=1` included.
 *  - The cost: an index read makes the same storage calls, in the same order, with the var unset, `pull` and `on`.
 *  - Nothing else moves: the lease, manifest, tail-free status and thread writes answer byte for byte the same in every mode.
 * Storage is rescue-fakes.mjs `createMirrorStorage` (the join fake: one MIRROR storage for lease and thread rows),
 * wrapped here only to count calls. No network, no Workers runtime, no real Durable Object.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { MirrorDO } from '../mirror-do.mjs'
import { createThreadMount } from '../thread-mount.mjs'
import { THREAD_EMPTY_SHA, THREAD_ZERO_CHAIN, bytesToBase64, sha256Hex, threadIdForPath } from '../thread-log.mjs'
import { THREAD_SYNC_MODES, threadSyncMode } from '../thread-sync-mode.mjs'
import { createMirrorStorage } from './rescue-fakes.mjs'
import { createVaultBucket } from './vault-fakes.mjs'

const SEED = 'a'.repeat(64)
const LINEAGE = '11111111-1111-4111-8111-111111111111'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const T0 = 1_800_000_000_000
const PATHS = ['/dsh/home/auma/session/messages.jsonl', '/dsh/home/sessions/agent/one/session.v1.jsonl']
const LINES = ['{"a":1}\n', '{"b":2}\n{"c":3}\n']
const encoder = new TextEncoder()
// The thread row's fields in the index at an earlier commit (thread-log.mjs `summary`), in that order.
const ROW_KEYS = ['id', 'path', 'bytes', 'lineEnd', 'partCount', 'keptCount', 'chain', 'tailSha', 'title', 'preview', 'activeAt', 'updatedAt', 'idle']
// The index answer's top-level keys at an earlier commit (thread-log.mjs opIndex plus the JOIN hook in mirror-do.mjs).
const WAVE3_KEYS = ['ok', 'threads', 'next', 'home', 'lease', 'world']

const withoutSync = body => Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'sync'))

/** The join MIRROR storage fake, every call counted and logged in order (inside and outside transactions). */
function countedStorage() {
  const inner = createMirrorStorage()
  const log = []
  const wrap = (view, where) => ({
    get: key => { log.push(`${where}get ${key}`); return view.get(key) },
    put: (key, value) => { log.push(`${where}put ${key}`); return view.put(key, value) },
    delete: key => { log.push(`${where}delete ${key}`); return view.delete(key) },
    list: (options = {}) => { log.push(`${where}list ${JSON.stringify(options)}`); return view.list(options) },
  })
  return {
    log,
    snapshot: () => inner.snapshot(),
    ...wrap(inner, ''),
    transaction: fn => { log.push('transaction'); return inner.transaction(tx => fn(wrap(tx, 'tx.'))) },
  }
}

/** A seeded, ready world (bootstrap record and fence at revision 1), MIRROR as the real class, a frozen edge clock. */
async function world(t, env = {}) {
  t.mock.method(Date, 'now', () => T0)
  const storage = countedStorage()
  await storage.put('mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, lineageId: LINEAGE, revision: 1, ballId: 'b'.repeat(64), epoch: 2, batchDigests: ['c'.repeat(64)], nextBatch: 1, entryCount: 1, expectedEntries: 1 })
  await storage.put('mirror:v2:global-fence', { lineageId: LINEAGE, revision: 1 })
  const mirror = new MirrorDO({ storage }, env)
  const post = async (path, body) => {
    const response = await mirror.fetch(new Request(`https://x61.internal${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }, body: JSON.stringify(body) }))
    const text = await response.text()
    return { status: response.status, text, body: JSON.parse(text) }
  }
  // The Worker's own thread mount in front of this MIRROR (the Worker env carries the same vars as the object's).
  const mount = createThreadMount()
  const workerEnv = { ...env, ARCHIVE_BUCKET: createVaultBucket(), MIRROR: { idFromName: name => name, get: () => ({ fetch: request => mirror.fetch(request) }) } }
  const browse = async (pathAndQuery, init = {}) => {
    const url = new URL(`https://node.example.invalid${pathAndQuery}`)
    const response = await mount.handle({ request: new Request(url, init), url, env: workerEnv, ready: true, seedId: SEED, access: { type: 'owner' } })
    const text = await response.text()
    const json = (response.headers.get('content-type') || '').startsWith('application/json')
    return { status: response.status, text, body: json ? JSON.parse(text) : null }
  }
  return { storage, post, browse }
}

/** Two threads written under one lease, so the index has two pages at `limit=1`. */
async function twoThreads(h) {
  const taken = await h.post('/_mirror/lease', { input: { action: 'acquire', clientId: A, tabId: 'tab-a', label: 'his Chrome' }, ownerApproved: false })
  assert.equal(taken.status, 200, taken.text)
  const lease = { leaseId: taken.body.lease.leaseId, generation: taken.body.lease.generation }
  const appended = []
  for (const [i, path] of PATHS.entries()) {
    const bytes = encoder.encode(LINES[i])
    const input = { id: await threadIdForPath(path), path, at: 0, body: bytesToBase64(bytes), bodySha: await sha256Hex(bytes), have: `${THREAD_ZERO_CHAIN}.${THREAD_EMPTY_SHA}`, lease }
    const answer = await h.post('/_mirror/thread', { op: 'append', input })
    assert.equal(answer.status, 200, answer.text)
    appended.push(answer)
  }
  return { taken, appended }
}

/** Wave 3's index answer for `twoThreads`, written out: rows from the stored index rows, the rest literal. */
async function wave3Answer(h, { limit = 50, after = '' } = {}) {
  const stored = [...h.storage.snapshot()].filter(([key]) => key.startsWith('thread:v1:index:')).sort(([x], [y]) => (x < y ? -1 : 1)).map(([, row]) => row)
  const from = after ? stored.findIndex(row => row.id === after) + 1 : 0
  const page = stored.slice(from, from + limit)
  return {
    ok: true,
    threads: page.map(row => Object.fromEntries(ROW_KEYS.map(key => [key, row[key]]))),
    next: from + limit < stored.length ? page.at(-1).id : null,
    home: { pending: false, rescue: null, freeze: 'record' },
    lease: { label: 'his Chrome', since: T0, seenAt: T0, live: true, asked: null },
    world: { threads: 2, tailBytes: LINES.reduce((sum, line) => sum + encoder.encode(line).length, 0), retired: 0 },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rule 1: the table. A typo can only mean off.

const TABLE = [
  ['no env at all', undefined, 'off'],
  ['env null', null, 'off'],
  ['env a string', 'on', 'off'],
  ['env a number', 1, 'off'],
  ['unset', {}, 'off'],
  ['set to undefined', { THREAD_SYNC: undefined }, 'off'],
  ['null', { THREAD_SYNC: null }, 'off'],
  ['empty', { THREAD_SYNC: '' }, 'off'],
  ['"off"', { THREAD_SYNC: 'off' }, 'off'],
  ['"pull"', { THREAD_SYNC: 'pull' }, 'pull'],
  ['"on"', { THREAD_SYNC: 'on' }, 'on'],
  ['"ON"', { THREAD_SYNC: 'ON' }, 'off'],
  ['"On"', { THREAD_SYNC: 'On' }, 'off'],
  ['"PULL"', { THREAD_SYNC: 'PULL' }, 'off'],
  ['" on"', { THREAD_SYNC: ' on' }, 'off'],
  ['"on "', { THREAD_SYNC: 'on ' }, 'off'],
  ['" pull "', { THREAD_SYNC: ' pull ' }, 'off'],
  ['"on\\n"', { THREAD_SYNC: 'on\n' }, 'off'],
  ['"true"', { THREAD_SYNC: 'true' }, 'off'],
  ['"1"', { THREAD_SYNC: '1' }, 'off'],
  ['"enforce"', { THREAD_SYNC: 'enforce' }, 'off'],
  ['"pul"', { THREAD_SYNC: 'pul' }, 'off'],
  ['"onn"', { THREAD_SYNC: 'onn' }, 'off'],
  ['the number 1', { THREAD_SYNC: 1 }, 'off'],
  ['true', { THREAD_SYNC: true }, 'off'],
  ['an object', { THREAD_SYNC: { mode: 'on' } }, 'off'],
  ['an array', { THREAD_SYNC: ['on'] }, 'off'],
  ['a String object', { THREAD_SYNC: Object('on') }, 'off'],
  ['lowercase key', { thread_sync: 'on' }, 'off'],
]

for (const [name, env, mode] of TABLE) {
  test(`rule 1: THREAD_SYNC ${name} -> ${mode}`, () => {
    assert.equal(threadSyncMode(env), mode)
  })
}

test('rule 6: the answer is always one of three words', () => {
  assert.deepEqual([...THREAD_SYNC_MODES], ['off', 'pull', 'on'])
  for (const [, env] of TABLE) assert.ok(THREAD_SYNC_MODES.includes(threadSyncMode(env)))
})

// ---------------------------------------------------------------------------------------------------------------
// Rule 2: the index answer is wave 3's answer plus `sync`, on every page.

test('rule 2: var unset: MIRROR\'s index answer deep-equals the wave 3 answer plus sync "off", empty world and two threads', async t => {
  const h = await world(t)
  const empty = await h.post('/_mirror/thread', { op: 'index', input: {} })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body, { ok: true, threads: [], next: null, home: { pending: false, rescue: null, freeze: 'record' }, lease: null, world: { threads: 0, tailBytes: 0, retired: 0 }, sync: 'off' })
  await twoThreads(h)
  const full = await h.post('/_mirror/thread', { op: 'index', input: {} })
  assert.equal(full.status, 200)
  assert.deepEqual(full.body, { ...(await wave3Answer(h)), sync: 'off' })
  assert.deepEqual(Object.keys(full.body), [...WAVE3_KEYS, 'sync'], 'one field added, last; nothing else on the answer')
})

for (const mode of ['pull', 'on']) {
  test(`rule 2: THREAD_SYNC=${mode}: only the sync field differs from the var-unset answer, internal and public, on every page`, async t => {
    const base = await world(t)
    const set = await world(t, { THREAD_SYNC: mode })
    for (const h of [base, set]) await twoThreads(h)
    const [plain, told] = [await base.post('/_mirror/thread', { op: 'index', input: {} }), await set.post('/_mirror/thread', { op: 'index', input: {} })]
    assert.equal(told.status, 200)
    assert.equal(plain.body.sync, 'off')
    assert.equal(told.body.sync, mode)
    assert.deepEqual(withoutSync(told.body), withoutSync(plain.body), 'nothing but sync differs')
    assert.deepEqual(withoutSync(told.body), await wave3Answer(set))
    // The public route (the Worker's thread mount in front of MIRROR): page 1 at limit=1 (the writer's 45 s check), page 2.
    const first = await set.browse('/_thread/index?limit=1')
    assert.equal(first.status, 200, first.text)
    assert.deepEqual(first.body, { ...(await wave3Answer(set, { limit: 1 })), sync: mode })
    assert.equal(typeof first.body.next, 'string')
    const second = await set.browse(`/_thread/index?after=${first.body.next}&limit=1`)
    assert.equal(second.status, 200, second.text)
    assert.deepEqual(second.body, { ...(await wave3Answer(set, { limit: 1, after: first.body.next })), sync: mode })
    assert.equal(second.body.next, null)
    const defaultPage = await set.browse('/_thread/index')
    assert.deepEqual(defaultPage.body, { ...(await wave3Answer(set)), sync: mode })
    // Rule 6: three words, never an id or a path.
    assert.ok(THREAD_SYNC_MODES.includes(told.body.sync))
  })
}

test('rule 2: var unset: the public index pages carry sync "off" too', async t => {
  const h = await world(t)
  await twoThreads(h)
  const first = await h.browse('/_thread/index?limit=1')
  assert.deepEqual(first.body, { ...(await wave3Answer(h, { limit: 1 })), sync: 'off' })
  const second = await h.browse(`/_thread/index?after=${first.body.next}&limit=1`)
  assert.deepEqual(second.body, { ...(await wave3Answer(h, { limit: 1, after: first.body.next })), sync: 'off' })
})

// Review (an earlier commit): mirror-world-mount.test.mjs MUST 5 stops at its exact-keys assertion (:457) until a later change adds
// `sync: 'off'` there, so its later checks do not run. The same checks, with `sync` present, in every mode, here:
// a pending home and a live lease show, the lease id and the browser id never do, HOME_FREEZE=enforce still shows.
for (const mode of [undefined, 'pull', 'on']) {
  test(`review: THREAD_SYNC=${mode ?? 'unset'}: the index with sync still shows home and lease, never the lease id or browser id; freeze enforce shows`, async t => {
    for (const freeze of ['record', 'enforce']) {
      const env = { ...(mode ? { THREAD_SYNC: mode } : {}), ...(freeze === 'enforce' ? { HOME_FREEZE: 'enforce' } : {}) }
      const h = await world(t, env)
      const { taken } = await twoThreads(h)
      await h.storage.put('world:v1:home-pending', { rescue: '1'.repeat(32), clientId: A, since: 5, verifiedAt: 4 })
      for (const read of [await h.post('/_mirror/thread', { op: 'index', input: {} }), await h.browse('/_thread/index?limit=1')]) {
        assert.equal(read.status, 200, read.text)
        assert.equal(read.body.sync, mode ?? 'off')
        assert.deepEqual(read.body.home, { pending: true, rescue: '1'.repeat(32), freeze })
        assert.equal(read.body.lease.label, 'his Chrome')
        assert.equal(read.body.lease.live, true)
        assert.ok(!read.text.includes(taken.body.lease.leaseId), 'no lease id in the index')
        assert.ok(!read.text.includes(A), 'no browser id in the index')
      }
    }
  })
}

test('rule 4: no query parameter is added: ?sync= on the index is still 404', async t => {
  const h = await world(t, { THREAD_SYNC: 'on' })
  for (const query of ['?sync=on', '?limit=1&sync=off', '?mode=on']) {
    const refused = await h.browse(`/_thread/index${query}`)
    assert.deepEqual([refused.status, refused.body.code], [404, 'NOT_FOUND'], query)
  }
})

test('a refused index (limit 0) is answered as wave 3 answered it: no sync field on a refusal', async t => {
  const plain = await world(t)
  const set = await world(t, { THREAD_SYNC: 'on' })
  const [a, b] = [await plain.post('/_mirror/thread', { op: 'index', input: { limit: 0 } }), await set.post('/_mirror/thread', { op: 'index', input: { limit: 0 } })]
  assert.equal(a.status, 400)
  assert.equal(b.status, 400)
  assert.equal(b.text, a.text)
  assert.equal(Object.hasOwn(b.body, 'sync'), false)
})

// ---------------------------------------------------------------------------------------------------------------
// The cost: the same storage calls, in the same order, and the same rows, whatever the mode.

test('cost: an index read makes the same storage calls in the same order with the var unset, pull and on, and writes nothing', async t => {
  const runs = []
  for (const env of [{}, { THREAD_SYNC: 'pull' }, { THREAD_SYNC: 'on' }]) {
    const h = await world(t, env)
    await twoThreads(h)
    const before = h.storage.snapshot()
    h.storage.log.length = 0
    await h.post('/_mirror/thread', { op: 'index', input: {} })
    const internal = [...h.storage.log]
    h.storage.log.length = 0
    await h.browse('/_thread/index?limit=1')
    const publicRead = [...h.storage.log]
    assert.deepEqual(h.storage.snapshot(), before, 'an index read writes no row in any mode')
    assert.ok(internal.length > 0)
    assert.equal(internal.filter(line => line.includes('put ') || line.includes('delete ')).length, 0)
    runs.push({ internal, publicRead })
  }
  assert.deepEqual(runs[1], runs[0], 'pull: same calls, same order, as unset')
  assert.deepEqual(runs[2], runs[0], 'on: same calls, same order, as unset')
})

// ---------------------------------------------------------------------------------------------------------------
// Rule 3: no other route changes.

test('rule 3: lease status, acquire, append (internal and public), manifest, tail and the public lease route answer byte for byte the same in every mode', async t => {
  const texts = []
  for (const env of [{}, { THREAD_SYNC: 'pull' }, { THREAD_SYNC: 'on' }]) {
    const h = await world(t, env)
    const status = await h.post('/_mirror/lease', { input: { action: 'status', clientId: A, tabId: 'tab-a', label: 'his Chrome' }, ownerApproved: false })
    const { taken, appended } = await twoThreads(h)
    const id = await threadIdForPath(PATHS[1])
    const manifest = await h.post('/_mirror/thread', { op: 'manifest', input: { id, page: 0 } })
    const tail = await h.browse(`/_thread/tail?id=${id}`)
    const publicManifest = await h.browse(`/_thread/manifest?id=${id}`)
    const renewed = await h.browse('/_mirror/lease', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'renew', clientId: A, tabId: 'tab-a', label: 'his Chrome', leaseId: taken.body.lease.leaseId }) })
    // A thread write through the public route: the next line of the first thread, at its end, under the lease.
    const more = encoder.encode('{"d":4}\n')
    const first = appended[0].body
    const publicAppend = await h.browse(`/_thread/append?id=${await threadIdForPath(PATHS[0])}&at=${first.bytes}&p=1`, { method: 'POST', body: more,
      headers: { 'x-thread-lease': `${taken.body.lease.leaseId}.${taken.body.lease.generation}`, 'x-thread-have': `${first.chain}.${first.tailSha}`, 'x-thread-sha256': await sha256Hex(more) } })
    assert.equal(publicAppend.status, 200, publicAppend.text)
    // The lease id is random per world: it is the one byte run that may differ, so it is named, not compared.
    const same = text => text.replaceAll(taken.body.lease.leaseId, '<leaseId>')
    const answers = [status.text, taken.text, ...appended.map(a => a.text), manifest.text, publicManifest.text, tail.text, renewed.text, publicAppend.text]
    for (const text of answers) assert.ok(!text.includes('"sync"'), 'sync is on the index only')
    texts.push([tail.status, renewed.status, ...answers.map(same)])
  }
  assert.deepEqual(texts[1], texts[0])
  assert.deepEqual(texts[2], texts[0])
})
