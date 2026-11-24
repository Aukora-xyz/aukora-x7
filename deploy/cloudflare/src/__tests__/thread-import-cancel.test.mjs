/**
 * An import that was CANCELLED must not commit afterwards.
 * The real thread mount (thread-mount.mjs createThreadMount) in front of the REAL MirrorDO over in-memory storage, and
 * an R2 fake whose blob read can be held. A acquires the lease; near its expiry the import waits on that bucket read;
 * the request is aborted with no release; the clock passes the lease's expiry; the bucket read resumes. Nothing may be
 * dispatched to MIRROR after the abort: no import commit, no renewed lease, and a second browser acquires at the
 * stated expiry.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { MirrorDO } from '../mirror-do.mjs'
import { createThreadMount } from '../thread-mount.mjs'
import { THREAD_PROTOCOL, THREAD_ZERO_CHAIN, threadIdForPath } from '../thread-log.mjs'
import { WORLD_LEASE } from '../world-lease.mjs'

const SEED = 'a'.repeat(64)
const LINEAGE = '11111111-1111-4111-8111-111111111111'
const WORLD = 'node-main-v1'
const PATH = '/dsh/home/auma/session/messages.jsonl'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const T0 = 1_800_000_000_000
const encoder = new TextEncoder()
const shaHex = value => createHash('sha256').update(value).digest('hex')

/**
 * Durable-Object-like storage: staged writes per transaction, committed on return, dropped on throw; one at a time.
 * `holdGet(key)`: the next get of `key` INSIDE a transaction waits until `release()` (the reviewer holds the
 * import transaction's lease-row read); `arrived` resolves when that read is reached.
 */
function createStorage(initial) {
  const data = new Map(initial)
  let tail = Promise.resolve()
  let held = null
  // Every read of a transaction (get or list) is numbered, so any ONE of them can be held:
  // `holdRead(tx, index)` holds read `index` of the `tx`-th transaction started after the call; `recordReads()` lists
  // `[transaction, key]` for every read from then on.
  let started = 0, heldAt = null, reads = null
  const listOf = (read, { prefix = '', start, startAfter, limit = Infinity } = {}) => {
    const out = new Map()
    for (const key of read.keys().filter(key => key.startsWith(prefix) && (start === undefined || key >= start) && (startAfter === undefined || key > startAfter)).sort()) {
      if (out.size >= limit) break
      out.set(key, read.get(key))
    }
    return out
  }
  const direct = { keys: () => [...data.keys()], get: key => structuredClone(data.get(key)) }
  return {
    data,
    holdGet(key) {
      let release, reached
      const gate = new Promise(resolve => { release = resolve })
      const arrived = new Promise(resolve => { reached = resolve })
      held = { key, gate, reached }
      return { release, arrived }
    },
    holdRead(tx, index) {
      let release, reached
      const gate = new Promise(resolve => { release = resolve })
      const arrived = new Promise(resolve => { reached = resolve })
      heldAt = { tx: started + tx, index, gate, reached }
      return { release, arrived }
    },
    recordReads() { reads = []; return { base: started, reads } },
    get: async key => direct.get(key),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
    list: async options => listOf(direct, options),
    transaction(fn) {
      const run = tail.then(async () => {
        const writes = new Map(), deletes = new Set()
        const n = started++
        let count = 0
        const read = {
          keys: () => [...new Set([...data.keys(), ...writes.keys()])].filter(key => !deletes.has(key) || writes.has(key)),
          get: key => (writes.has(key) ? structuredClone(writes.get(key)) : deletes.has(key) ? undefined : structuredClone(data.get(key))),
        }
        // The gate to wait on when this read is the one held, else null (an unheld read adds no wait).
        const numbered = key => {
          const at = count++
          if (reads) reads.push([n, key])
          if (!heldAt || heldAt.tx !== n || heldAt.index !== at) return null
          const { gate, reached } = heldAt
          heldAt = null
          reached(key)
          return gate
        }
        const view = {
          get: async key => {
            if (held && held.key === key) { const { gate, reached } = held; held = null; reached(); await gate }
            const gate = numbered(key)
            if (gate) await gate
            return read.get(key)
          },
          put: async (key, value) => { deletes.delete(key); writes.set(key, structuredClone(value)) },
          delete: async key => { const had = read.get(key) !== undefined; writes.delete(key); deletes.add(key); return had },
          list: async options => { const gate = numbered('list:' + (options?.prefix ?? '')); if (gate) await gate; return listOf(read, options) },
        }
        const result = await fn(view)
        for (const key of deletes) if (!writes.has(key)) data.delete(key)
        for (const [key, value] of writes) data.set(key, value)
        return result
      })
      tail = run.catch(() => {})
      return run
    },
  }
}

/** R2 in memory honouring `range`; `hold(key)` makes the next get of that key wait until `release()`. */
function bucket() {
  const objects = new Map(), calls = []
  let held = null
  const stream = bytes => new ReadableStream({ start(controller) { if (bytes.byteLength) controller.enqueue(new Uint8Array(bytes)); controller.close() } })
  return {
    objects, calls,
    hold(key) {
      let release, reached
      const gate = new Promise(resolve => { release = resolve })
      const arrived = new Promise(resolve => { reached = resolve })
      held = { key, gate, reached }
      return { release, arrived }
    },
    async head(key) { calls.push(['head', key]); const v = objects.get(key); return v ? { key, size: v.byteLength } : null },
    async put(key, value) { calls.push(['put', key]); objects.set(key, Uint8Array.from(value)); return { key, size: value.byteLength } },
    async get(key, options = {}) {
      calls.push(['get', key])
      if (held && held.key === key) { const { gate, reached } = held; held = null; reached(); await gate }
      const v = objects.get(key)
      if (!v) return null
      const bytes = options.range ? v.slice(options.range.offset, options.range.offset + options.range.length) : v
      return { key, size: v.byteLength, body: stream(bytes), arrayBuffer: async () => bytes.slice().buffer }
    },
  }
}

/** A VERIFIED rescue in the vault's shape (one short journal, under one piece). */
function storeRescue(r2, file) {
  const piece = THREAD_PROTOCOL.piece, pieces = []
  for (let at = 0; at < file.length; at += piece) {
    const bytes = file.subarray(at, at + piece)
    r2.objects.set(`w/${WORLD}/blob/${shaHex(bytes)}`, Uint8Array.from(bytes))
    pieces.push(shaHex(bytes))
  }
  const rows = [{ key: PATH, type: 'file', bytes: file.length, sha256: shaHex(file), pieces }]
  const index = encoder.encode(JSON.stringify({ v: 1, piece, source: 'indexeddb', client: { clientId: A, base: { lineageId: LINEAGE, revision: 1 }, reconciliation: null }, rows, skipped: [], totals: { rows: 1 } }))
  const indexSha = shaHex(index), id = indexSha.slice(0, 32)
  r2.objects.set(`w/${WORLD}/rescue/${id}/pending.json`, index)
  r2.objects.set(`w/${WORLD}/rescue/${id}/manifest.json`, encoder.encode(JSON.stringify({ verified: true, verifiedAt: '2026-11-12T11:00:00.000Z', indexSha })))
  return { id, blob: `w/${WORLD}/blob/${pieces[0]}` }
}

test('an import cancelled while it waits on a bucket read (between the manifest read and the commit) commits nothing, renews nothing, and a second browser acquires at the stated expiry', async t => {
  const clock = { now: T0 }
  t.mock.method(Date, 'now', () => clock.now)
  const storage = createStorage([
    ['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, lineageId: LINEAGE, revision: 1, ballId: 'b'.repeat(64), epoch: 2, batchDigests: ['c'.repeat(64)], nextBatch: 1, entryCount: 1, expectedEntries: 1 }],
    ['mirror:v2:global-fence', { lineageId: LINEAGE, revision: 1 }],
  ])
  const mirror = new MirrorDO({ storage }, {})
  const posts = []
  const r2 = bucket()
  const env = {
    ARCHIVE_BUCKET: r2,
    MIRROR: { idFromName: name => name, get: () => ({ fetch: async request => { posts.push({ path: new URL(request.url).pathname, body: await request.clone().json() }); return mirror.fetch(request) } }) },
  }
  const mount = createThreadMount()
  const internal = (path, body) => mirror.fetch(new Request(`https://x61.internal${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }, body: JSON.stringify(body) }))
  const acquire = async clientId => {
    const response = await internal('/_mirror/lease', { input: { action: 'acquire', clientId, tabId: 'rescue-page', label: 'Rescue page' }, ownerApproved: false })
    return { status: response.status, body: await response.json() }
  }

  const granted = await acquire(A)
  assert.equal(granted.status, 200)
  const expiresAt = granted.body.lease.expiresAt
  assert.equal(expiresAt, T0 + WORLD_LEASE.ttlMs)
  const file = encoder.encode('{"role":"user","text":"his line"}\n'.repeat(40))
  const rescue = storeRescue(r2, file)
  const { release, arrived } = r2.hold(rescue.blob)

  clock.now = expiresAt - 1000 // near the lease's expiry
  const controller = new AbortController()
  const url = new URL('https://her.example.invalid/_thread/import')
  const request = new Request(url, { method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', 'x-thread-lease': `${granted.body.lease.leaseId}.${granted.body.lease.generation}` },
    body: JSON.stringify({ path: PATH, rescue: rescue.id }) })
  const answer = mount.handle({ request, url, env, ready: true, seedId: SEED, access: { type: 'owner' }, now: () => clock.now })
  await arrived // the import read the manifest from MIRROR and now waits on the bucket for the open end
  assert.deepEqual(posts.map(post => post.body.op), ['manifest'], 'the manifest was read before the wait')
  controller.abort() // the page went away; no release was sent
  clock.now = expiresAt + 1 // the bucket read resumes after the lease ran out
  release()
  const response = await answer
  await response.text()

  assert.deepEqual(posts.map(post => post.body.op), ['manifest'], `nothing was dispatched to MIRROR after the abort (got ${posts.map(post => post.body.op)})`)
  assert.deepEqual([...storage.data.keys()].filter(key => key.startsWith('thread:v1:index:')), [], 'no thread was committed')
  assert.equal(storage.data.get('world:v1:lease').expiresAt, expiresAt, 'the lease was not renewed')
  const second = await acquire(B)
  assert.equal(second.status, 200, `a second browser acquires at the stated expiry: ${JSON.stringify(second.body)}`)
})

test('a request already aborted before its first internal call dispatches nothing at all', async t => {
  const clock = { now: T0 }
  t.mock.method(Date, 'now', () => clock.now)
  const storage = createStorage([
    ['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, lineageId: LINEAGE, revision: 1, ballId: 'b'.repeat(64), epoch: 2, batchDigests: ['c'.repeat(64)], nextBatch: 1, entryCount: 1, expectedEntries: 1 }],
    ['mirror:v2:global-fence', { lineageId: LINEAGE, revision: 1 }],
  ])
  const mirror = new MirrorDO({ storage }, {})
  const posts = []
  const env = { ARCHIVE_BUCKET: bucket(), MIRROR: { idFromName: name => name, get: () => ({ fetch: async request => { posts.push(new URL(request.url).pathname); return mirror.fetch(request) } }) } }
  const mount = createThreadMount()
  const controller = new AbortController()
  controller.abort()
  for (const [path, init] of [
    ['/_mirror/lease', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'acquire', clientId: A, tabId: 'rescue-page', label: 'Rescue page' }) }],
    ['/_thread/index', { method: 'GET' }],
  ]) {
    const url = new URL(`https://her.example.invalid${path}`)
    const response = await mount.handle({ request: new Request(url, { ...init, signal: controller.signal }), url, env, ready: true, seedId: SEED, access: { type: 'owner' }, now: () => clock.now })
    assert.equal(response.status, 503, `${path}: ${await response.clone().text()}`)
  }
  assert.deepEqual(posts, [], 'no internal call was made for an aborted request')
  assert.equal(storage.data.has('world:v1:lease'), false)
})

// ── The commit's OWN transaction, without relying on any abort signal ──────────────────────────
// The deployed Worker's compatibility date (2026-11-01) has no `enable_request_signal`: on her edge NO abort signal arrives
// when a tab closes. So the guarantee is the lease judged on a clock read inside the transaction after its row is read,
// and the signal check inside the transaction is an extra, exercised here in tests only.

/** A seeded MIRROR, the real mount in front of it, a verified rescue, and A's lease. */
async function reviewerWorld(t, size = 640) {
  const clock = { now: T0 }
  t.mock.method(Date, 'now', () => clock.now)
  const storage = createStorage([
    ['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, lineageId: LINEAGE, revision: 1, ballId: 'b'.repeat(64), epoch: 2, batchDigests: ['c'.repeat(64)], nextBatch: 1, entryCount: 1, expectedEntries: 1 }],
    ['mirror:v2:global-fence', { lineageId: LINEAGE, revision: 1 }],
  ])
  const mirror = new MirrorDO({ storage }, {})
  const r2 = bucket()
  const env = { ARCHIVE_BUCKET: r2, MIRROR: { idFromName: name => name, get: () => ({ fetch: request => mirror.fetch(request) }) } }
  const internal = (path, body) => mirror.fetch(new Request(`https://x61.internal${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }, body: JSON.stringify(body) }))
  const acquire = async clientId => {
    const response = await internal('/_mirror/lease', { input: { action: 'acquire', clientId, tabId: 'rescue-page', label: 'Rescue page' }, ownerApproved: false })
    return { status: response.status, body: await response.json() }
  }
  const granted = await acquire(A)
  assert.equal(granted.status, 200)
  // 640 bytes, as the reviewer's (or `size`, to have whole pieces too)
  const file = encoder.encode('{"role":"user","text":"his line"}\n'.repeat(Math.floor((size - 1) / 34)).padEnd(size - 1, ' ') + '\n')
  assert.equal(file.length, size)
  const rescue = storeRescue(r2, file)
  const importRequest = signal => {
    const url = new URL('https://her.example.invalid/_thread/import')
    return { url, request: new Request(url, { method: 'POST', ...(signal ? { signal } : {}),
      headers: { 'content-type': 'application/json', 'x-thread-lease': `${granted.body.lease.leaseId}.${granted.body.lease.generation}` },
      body: JSON.stringify({ path: PATH, rescue: rescue.id }) }) }
  }
  return { clock, storage, env, internal, acquire, granted, importRequest, mount: createThreadMount() }
}

for (const aborted of [true, false]) {
  test(`the import transaction's lease-row read is held past the expiry, then resumes: refused 410, nothing committed, the lease not renewed, B acquires at the original expiry`, async t => {
    const w = await reviewerWorld(t)
    const expiresAt = w.granted.body.lease.expiresAt
    w.clock.now = expiresAt - 1000 // the import starts near the expiry
    const { release, arrived } = w.storage.holdGet('world:v1:lease')
    const controller = new AbortController()
    const { url, request } = w.importRequest(aborted ? controller.signal : null)
    const answer = w.mount.handle({ request, url, env: w.env, ready: true, seedId: SEED, access: { type: 'owner' }, now: () => w.clock.now })
    await arrived // the body was parsed; MIRROR's import transaction now waits on its lease-row read
    if (aborted) controller.abort()
    w.clock.now = expiresAt + 1 // the clock passes the expiry
    release()
    const response = await answer
    const body = await response.json()
    assert.equal(response.status, 410, JSON.stringify(body))
    assert.equal(body.code, 'WRITER_GONE')
    assert.deepEqual([...w.storage.data.keys()].filter(key => key.startsWith('thread:')), [], 'nothing committed: no thread, no piece list, no open end, no count')
    assert.equal(w.storage.data.has('world:v1:wrote'), false, 'no write time')
    assert.equal(w.storage.data.has('world:v1:budget'), false, 'nothing charged')
    assert.equal(w.storage.data.get('world:v1:lease').expiresAt, expiresAt, 'the lease was not renewed')
    const second = await w.acquire(B)
    assert.equal(second.status, 200, `B acquires at the original expiry: ${JSON.stringify(second.body)}`)
  })
}

test('an abort signal that DID arrive: a request aborted while its live-lease import transaction waits is rolled back inside the transaction, right before success', async t => {
  const w = await reviewerWorld(t)
  const expiresAt = w.granted.body.lease.expiresAt
  w.clock.now = expiresAt - 30_000 // the lease stays live throughout
  const { release, arrived } = w.storage.holdGet('world:v1:lease')
  const controller = new AbortController()
  const { url, request } = w.importRequest(controller.signal)
  const answer = w.mount.handle({ request, url, env: w.env, ready: true, seedId: SEED, access: { type: 'owner' }, now: () => w.clock.now })
  await arrived
  controller.abort()
  release()
  const response = await answer
  const body = await response.json()
  assert.equal(response.status, 503, JSON.stringify(body))
  assert.equal(body.code, 'THREAD_REQUEST_CANCELLED')
  assert.deepEqual([...w.storage.data.keys()].filter(key => key.startsWith('thread:')), [], 'every staged thread row rolled back')
  assert.equal(w.storage.data.has('world:v1:wrote'), false)
  assert.equal(w.storage.data.has('world:v1:budget'), false)
  assert.equal(w.storage.data.get('world:v1:lease').expiresAt, expiresAt, 'the extension rolled back with it')
})

test('a commit whose transaction outlives its lease after the lease was judged live rolls back (410), with no abort signal', async t => {
  const w = await reviewerWorld(t)
  const expiresAt = w.granted.body.lease.expiresAt
  w.clock.now = expiresAt - 1000
  // Hold a read the import makes AFTER the lease was judged (its world counts), and pass the lease's whole life meanwhile.
  const { release, arrived } = w.storage.holdGet('thread:v1:world')
  const { url, request } = w.importRequest(null)
  const answer = w.mount.handle({ request, url, env: w.env, ready: true, seedId: SEED, access: { type: 'owner' }, now: () => w.clock.now })
  await arrived
  w.clock.now = expiresAt + WORLD_LEASE.ttlMs + 1
  release()
  const response = await answer
  const body = await response.json()
  assert.equal(response.status, 410, JSON.stringify(body))
  assert.equal(body.code, 'WRITER_GONE')
  assert.deepEqual([...w.storage.data.keys()].filter(key => key.startsWith('thread:')), [], 'rolled back')
  assert.equal(w.storage.data.get('world:v1:lease').expiresAt, expiresAt, 'not renewed')
  assert.equal((await w.acquire(B)).status, 200)
})

// ── Only a write that committed bytes extends the lease ───────────────────────────────────────
// A thread write that passes the lease gate and is then refused (an answer, not a throw), or answered 200 with nothing
// written, rolls back with that answer: the lease row (and the seen row) stay exactly as they were.

test('five refused import steps in a row (503 THREAD_MOVED), a refused append and a refused import step leave the lease row exactly as it was, keep their own status and body, and B acquires at the original expiry', async t => {
  const w = await reviewerWorld(t)
  const lease = { leaseId: w.granted.body.lease.leaseId, generation: w.granted.body.lease.generation }
  const expiresAt = w.granted.body.lease.expiresAt
  const before = structuredClone(w.storage.data.get('world:v1:lease'))
  const seenBefore = structuredClone(w.storage.data.get('world:v1:seen'))
  const id = await threadIdForPath(PATH)
  const tail = Buffer.from('{"role":"user","text":"his line"}\n')
  // A step whose `expect` names a thread her cloud does not hold: refused 503 THREAD_MOVED, after the lease gate passed.
  const moved = { lease, id, path: PATH, piece: THREAD_PROTOCOL.piece, tail: tail.toString('base64'), from: 0, prefixChain: THREAD_ZERO_CHAIN, parts: [],
    run: { client: null, from: 0 }, lineEnd: tail.length, sealedLineEnd: 0, expect: { bytes: 640, sealedBytes: 0, chain: THREAD_ZERO_CHAIN, tailSha: 'f'.repeat(64) } }
  const call = async (op, input) => { const response = await w.internal('/_mirror/thread', { op, input }); return { status: response.status, body: await response.json() } }
  for (let n = 0; n < 5; n++) {
    w.clock.now += 10_000 // the kit waits out THREAD_MOVED between tries
    assert.deepEqual(await call('import', moved), { status: 503, body: { ok: false, code: 'THREAD_MOVED' } }, `refused step ${n + 1}`)
    assert.deepEqual(w.storage.data.get('world:v1:lease'), before, `refused step ${n + 1}: the lease row is exactly as it was`)
  }
  // 409 GAP (an append past the end) and 400 THREAD_IMPORT_INVALID (a step from a piece her cloud does not hold).
  const body = Buffer.from('his line\n')
  assert.deepEqual(await call('append', { lease, id, path: PATH, at: 5, have: 'x', body: body.toString('base64'), bodySha: shaHex(body) }), { status: 409, body: { ok: false, code: 'GAP', bytes: 0 } })
  assert.deepEqual(await call('import', { ...moved, from: 1, expect: null }), { status: 400, body: { ok: false, code: 'THREAD_IMPORT_INVALID' } })
  assert.deepEqual(w.storage.data.get('world:v1:lease'), before, 'the lease row is exactly as it was after every refusal')
  assert.deepEqual(w.storage.data.get('world:v1:seen'), seenBefore, 'the seen row too')
  assert.deepEqual([...w.storage.data.keys()].filter(key => key.startsWith('thread:')), [], 'nothing written')
  assert.equal(w.storage.data.has('world:v1:wrote'), false)
  // Just before the original expiry B is still refused; at it, B acquires.
  w.clock.now = expiresAt - 1
  assert.equal((await w.acquire(B)).status, 423)
  w.clock.now = expiresAt
  const second = await w.acquire(B)
  assert.equal(second.status, 200, `B acquires at the original expiry: ${JSON.stringify(second.body)}`)
})

test('a write answered 200 with nothing written (a retract to the end it already has) does not extend the lease; a committed import step does', async t => {
  const w = await reviewerWorld(t)
  const lease = { leaseId: w.granted.body.lease.leaseId, generation: w.granted.body.lease.generation }
  const expiresAt = w.granted.body.lease.expiresAt
  w.clock.now += 30_000
  const { url, request } = w.importRequest(null)
  const imported = await w.mount.handle({ request, url, env: w.env, ready: true, seedId: SEED, access: { type: 'owner' }, now: () => w.clock.now })
  assert.equal(imported.status, 200, await imported.clone().text())
  const extended = structuredClone(w.storage.data.get('world:v1:lease'))
  assert.equal(extended.expiresAt, w.clock.now + WORLD_LEASE.ttlMs, 'a committed import step extends the lease')
  assert.ok(extended.expiresAt > expiresAt)
  const id = await threadIdForPath(PATH)
  const t1 = w.storage.data.get(`thread:v1:index:${id}`)
  w.clock.now += 30_000
  const response = await w.internal('/_mirror/thread', { op: 'retract', input: { lease, id, forkAt: t1.bytes, expect: { bytes: t1.bytes, sealedBytes: t1.sealedBytes, chain: t1.chain, tailSha: t1.tailSha } } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, bytes: t1.bytes })
  assert.deepEqual(w.storage.data.get('world:v1:lease'), extended, 'nothing written, so the lease row is exactly as it was')
  assert.deepEqual(w.storage.data.get(`thread:v1:index:${id}`), t1)
})

// ── An import never commits after its lease ran out, wherever in its
// transaction it was waiting. The last check judges the lease's expiry from BEFORE this request touched it (never the
// transaction's own staged extension), on a clock read after the transaction's last await; a cancellation is checked there.

/** Every read of the import's own MIRROR transaction, in order, from one undisturbed import (the shape of what may be held). */
async function importReads(t, size) {
  const w = await reviewerWorld(t, size)
  w.clock.now = w.granted.body.lease.expiresAt - 1000
  const log = w.storage.recordReads()
  const { url, request } = w.importRequest(null)
  const done = await w.mount.handle({ request, url, env: w.env, ready: true, seedId: SEED, access: { type: 'owner' }, now: () => w.clock.now })
  assert.equal(done.status, 200, await done.clone().text())
  const last = log.reads.at(-1)[0] // the import transaction is the last one (the manifest reads come before it)
  return { tx: last - log.base, keys: log.reads.filter(([n]) => n === last).map(([, key]) => key) }
}

for (const [what, size] of [['640 bytes, an open end only', 640], ['a whole piece and 640 bytes', THREAD_PROTOCOL.piece + 640]]) {
  test(`${what}: each read of the import transaction held in turn (the lease row, the seen row, the thread row, her world row, the piece rows, the write time, the fence, the last read before commit), resumed at the expiry + 1 ms, with no abort and with an abort: 410, nothing committed, the expiry unchanged, another browser acquires at the original expiry`, async t => {
    const shape = await importReads(t, size)
    assert.equal(shape.keys.filter(key => key === 'world:v1:lease').length, 2, `the lease row is read when judged and again last: ${shape.keys.join(', ')}`)
    assert.equal(shape.keys[0], 'world:v1:lease', 'the first read judges the lease')
    assert.equal(shape.keys.at(-1), 'world:v1:lease', 'the last read before commit is the lease row')
    assert.ok(shape.keys.includes('thread:v1:world'), 'the reviewer\'s read (her world counts) is among them')
    if (size > THREAD_PROTOCOL.piece) assert.ok(shape.keys.some(key => key.startsWith('thread:v1:parts:') || key.startsWith('list:')), `a piece row is read: ${shape.keys.join(', ')}`)
    for (const aborted of [false, true]) {
      for (let index = 0; index < shape.keys.length; index++) {
        await t.test(`read ${index} (${shape.keys[index].replace(/[0-9a-f]{64}/, '<id>')}), ${aborted ? 'with an abort' : 'no abort'}`, async st => {
          const w = await reviewerWorld(st, size)
          const expiresAt = w.granted.body.lease.expiresAt
          const before = structuredClone(w.storage.data.get('world:v1:lease'))
          w.clock.now = expiresAt - 1000 // T + 89 s
          const { release, arrived } = w.storage.holdRead(shape.tx, index)
          const controller = new AbortController()
          const { url, request } = w.importRequest(aborted ? controller.signal : null)
          const answer = w.mount.handle({ request, url, env: w.env, ready: true, seedId: SEED, access: { type: 'owner' }, now: () => w.clock.now })
          assert.equal(await arrived, shape.keys[index], 'the held read is the one named')
          if (aborted) controller.abort()
          w.clock.now = expiresAt + 1 // T + 90 s + 1 ms
          release()
          const response = await answer
          const body = await response.json()
          assert.equal(response.status, 410, JSON.stringify(body))
          assert.equal(body.code, 'WRITER_GONE')
          assert.deepEqual([...w.storage.data.keys()].filter(key => key.startsWith('thread:')), [], 'nothing committed: no thread, no pieces, no open end, no counts')
          assert.equal(w.storage.data.has('world:v1:wrote'), false, 'no write time')
          assert.equal(w.storage.data.has('world:v1:budget'), false, 'nothing charged')
          assert.deepEqual(w.storage.data.get('world:v1:lease'), before, 'the lease row exactly as it was: the expiry not extended')
          w.clock.now = expiresAt
          const second = await w.acquire(B)
          assert.equal(second.status, 200, `B acquires AT the original expiry: ${JSON.stringify(second.body)}`)
        })
      }
    }
  })
}

test('acquire at T, the import starts at T+89 s, its world-row read (after the lease was judged) is held, it resumes at T+90 s+1: 410, 0 bytes, the expiry stays T+90 s, B acquires', async t => {
  const w = await reviewerWorld(t)
  const expiresAt = w.granted.body.lease.expiresAt
  assert.equal(expiresAt, T0 + 90_000)
  w.clock.now = T0 + 89_000
  const { release, arrived } = w.storage.holdGet('thread:v1:world')
  const { url, request } = w.importRequest(null)
  const answer = w.mount.handle({ request, url, env: w.env, ready: true, seedId: SEED, access: { type: 'owner' }, now: () => w.clock.now })
  await arrived
  w.clock.now = T0 + 90_001
  release()
  const response = await answer
  const body = await response.json()
  assert.equal(response.status, 410, JSON.stringify(body))
  assert.equal(body.code, 'WRITER_GONE')
  assert.deepEqual([...w.storage.data.keys()].filter(key => key.startsWith('thread:')), [])
  assert.equal(w.storage.data.get('world:v1:lease').expiresAt, T0 + 90_000, 'not extended to T+179 s')
  assert.equal((await w.acquire(B)).status, 200, 'B is not refused')
})

test('the LAST lease read held while the lease is live, the request aborted, then released: 503 cancelled, nothing committed, the extension rolled back', async t => {
  const shape = await importReads(t)
  const w = await reviewerWorld(t)
  const expiresAt = w.granted.body.lease.expiresAt
  const before = structuredClone(w.storage.data.get('world:v1:lease'))
  w.clock.now = expiresAt - 30_000 // live throughout
  const { release, arrived } = w.storage.holdRead(shape.tx, shape.keys.length - 1)
  const controller = new AbortController()
  const { url, request } = w.importRequest(controller.signal)
  const answer = w.mount.handle({ request, url, env: w.env, ready: true, seedId: SEED, access: { type: 'owner' }, now: () => w.clock.now })
  assert.equal(await arrived, 'world:v1:lease')
  controller.abort()
  release()
  const response = await answer
  const body = await response.json()
  assert.equal(response.status, 503, JSON.stringify(body))
  assert.equal(body.code, 'THREAD_REQUEST_CANCELLED')
  assert.deepEqual([...w.storage.data.keys()].filter(key => key.startsWith('thread:')), [])
  assert.deepEqual(w.storage.data.get('world:v1:lease'), before)
})

test('the same import with its last lease read held but resumed while the PRE-WRITE expiry is still ahead commits, and the extension it staged is kept', async t => {
  const shape = await importReads(t)
  const w = await reviewerWorld(t)
  const expiresAt = w.granted.body.lease.expiresAt
  w.clock.now = expiresAt - 1000
  const { release, arrived } = w.storage.holdRead(shape.tx, shape.keys.length - 1)
  const { url, request } = w.importRequest(null)
  const answer = w.mount.handle({ request, url, env: w.env, ready: true, seedId: SEED, access: { type: 'owner' }, now: () => w.clock.now })
  await arrived
  w.clock.now = expiresAt - 1 // one millisecond of the lease left
  release()
  const response = await answer
  assert.equal(response.status, 200, await response.clone().text())
  assert.ok([...w.storage.data.keys()].some(key => key.startsWith('thread:v1:index:')), 'committed')
  assert.equal(w.storage.data.get('world:v1:lease').expiresAt, expiresAt - 1000 + WORLD_LEASE.ttlMs, 'the extension judged at T+89 s is kept')
})
