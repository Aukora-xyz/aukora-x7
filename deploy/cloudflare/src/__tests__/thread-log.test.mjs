/** Thread log: the MIRROR half (threadCommit) and the Worker half (handleThreadRequest) over fakes that record every call. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import {
  THREAD_PROTOCOL, THREAD_LIMITS, THREAD_EMPTY_SHA, THREAD_ZERO_CHAIN,
  threadLimits, threadPathAllowed, threadIdForPath, threadCommit, handleThreadRequest, createR2PartStore,
  sha256Hex, bytesToBase64, base64ToBytes,
} from '../thread-log.mjs'

const PIECE = 4096
const ROW = 128
const protocol = Object.freeze({ piece: PIECE, row: ROW })
const encoder = new TextEncoder()
const LEASE_A = 'a'.repeat(32)
const LEASE_B = 'b'.repeat(32)
const PATH = '/dsh/home/auma/session/messages.jsonl'
const EMPTY_HAVE = `${THREAD_ZERO_CHAIN}.${THREAD_EMPTY_SHA}`
const ORIGIN = 'https://x61.example.invalid'

const concat = list => {
  const out = new Uint8Array(list.reduce((sum, item) => sum + item.length, 0))
  let at = 0
  for (const item of list) { out.set(item, at); at += item.length }
  return out
}
const lines = (count, tag, width = 40) => encoder.encode(Array.from({ length: count }, (_, i) => `{"t":"${tag}","i":${i},"p":"${'x'.repeat(width)}"}\n`).join(''))
const fill = (length, byte) => new Uint8Array(length).fill(byte)

function createStore() {
  let data = new Map()
  const store = { log: [], failPut: null }
  const view = map => ({
    async get(key) { store.log.push(['get', key]); return map.has(key) ? structuredClone(map.get(key)) : undefined },
    async put(key, value) {
      store.log.push(['put', key])
      if (store.failPut?.(key)) throw new Error('STORAGE_FAILED')
      map.set(key, structuredClone(value))
    },
    async delete(key) { store.log.push(['delete', key]); return map.delete(key) },
    async list({ prefix = '', start, startAfter, limit = Infinity } = {}) {
      store.log.push(['list', prefix])
      const out = new Map()
      for (const key of [...map.keys()].sort()) {
        if (!key.startsWith(prefix) || (start !== undefined && key < start) || (startAfter !== undefined && key <= startAfter)) continue
        if (out.size >= limit) break
        out.set(key, structuredClone(map.get(key)))
      }
      return out
    },
  })
  // A real rollback: the closure works on a draft that replaces the data only when it returns.
  store.transaction = async fn => {
    const draft = new Map([...data].map(([key, value]) => [key, structuredClone(value)]))
    const value = await fn(view(draft))
    data = draft
    return value
  }
  store.snapshot = () => new Map([...data].map(([key, value]) => [key, structuredClone(value)]))
  store.keys = prefix => [...data.keys()].filter(key => key.startsWith(prefix)).sort()
  store.raw = () => data
  return store
}

function createPartStore() {
  const parts = { blobs: new Map(), log: [], landed: new Map(), slowPut: false, headFailsAfterPut: false }
  parts.put = async (sha, bytes) => {
    parts.log.push(['put', sha])
    if (parts.slowPut) return new Promise(() => {})
    assert.equal(await sha256Hex(bytes), sha)
    parts.landed.set(sha, (parts.landed.get(sha) ?? 0) + 1)
    parts.blobs.set(sha, Uint8Array.from(bytes))
    return { size: bytes.length }
  }
  parts.head = async sha => {
    parts.log.push(['head', sha])
    if (parts.headFailsAfterPut && parts.landed.get(sha)) throw new Error('R2_DOWN')
    const blob = parts.blobs.get(sha)
    return blob ? { size: blob.length } : null
  }
  parts.get = async (sha, { offset, length }) => {
    parts.log.push(['get', sha])
    const blob = parts.blobs.get(sha)
    return blob ? blob.slice(offset, offset + length) : null
  }
  return parts
}

function harness({ limits = THREAD_LIMITS } = {}) {
  const store = createStore()
  const parts = createPartStore()
  const leases = new Map([[LEASE_A, { ok: true, clientId: 'client-a' }], [LEASE_B, { ok: true, clientId: 'client-b' }]])
  const h = {
    store, parts, leases, limits, mirrorCalls: [], commitBodies: [], httpBodies: [], threw: [], rescues: new Map(), leaseChecks: 0,
    budgetRefusal: null, beforeCall: null, approved: false, approvals: [], clock: 1000,
  }
  h.ctx = {
    checkLease: async (_tx, ref) => { h.leaseChecks += 1; return h.leases.get(ref.leaseId) ?? { ok: false, status: 423, code: 'WRITER_ELSEWHERE', holder: 'client-z' } },
    budget: {
      async charge(tx, { kind, bytes }) {
        assert.equal(kind, 'lines')
        if (h.budgetRefusal) return h.budgetRefusal
        const row = (await tx.get('budget:test')) ?? { bytes: 0 }
        await tx.put('budget:test', { bytes: row.bytes + bytes })
        return { ok: true }
      },
    },
    limits, protocol, now: () => h.clock,
  }
  h.commit = async (op, input) => {
    const answer = await store.transaction(tx => threadCommit(tx, op, input, h.ctx))
    h.commitBodies.push(answer.body)
    return answer
  }
  // JSON on both sides: proves every op input and answer is plain JSON, as one internal request would carry it.
  h.mirror = {
    async call(op, input) {
      h.mirrorCalls.push(op)
      if (h.beforeCall) await h.beforeCall(op, input)
      return JSON.parse(JSON.stringify(await h.commit(op, JSON.parse(JSON.stringify(input)))))
    },
  }
  h.send = async (request, extra = {}) => {
    try {
      return await handleThreadRequest({ request, url: new URL(request.url), mirror: h.mirror, parts,
        rescues: { get: async id => h.rescues.has(id) ? { index: h.rescues.get(id), verifiedAt: '2026-11-12T10:00:00.000Z' } : null },
        limits, protocol, now: () => h.clock, approve: async card => { h.approvals.push(card); return h.approved },
        deadlines: { r2Ms: 25, idleMs: 25, totalMs: 200 }, ...extra })
    } catch (error) { h.threw.push(error); throw error }
  }
  h.json = async response => {
    const body = await response.json()
    h.httpBodies.push(body)
    return { status: response.status, body }
  }
  h.get = async path => h.json(await h.send(new Request(ORIGIN + path)))
  h.post = async (path, input, headers = {}) => h.json(await h.send(new Request(ORIGIN + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) })))
  return h
}

const leaseHeader = (lease = LEASE_A) => ({ 'x-thread-lease': `${lease}.1` })

async function append(h, { id, at, body, have, lease = LEASE_A, path = PATH, meta, p = '1' }) {
  const headers = new Headers({ 'x-thread-sha256': await sha256Hex(body), 'x-thread-have': have })
  if (lease) headers.set('x-thread-lease', `${lease}.1`)
  if (path) headers.set('x-thread-path', path)
  if (meta) headers.set('x-thread-meta', Buffer.from(JSON.stringify(meta)).toString('base64url'))
  return h.json(await h.send(new Request(`${ORIGIN}/_thread/append?id=${id}&at=${at}&p=${p}`, { method: 'POST', headers, body })))
}

// A browser-side writer that keeps the pair it was last given.
function writer(h, id, lease = LEASE_A, path = PATH) {
  const w = { id, bytes: 0, have: EMPTY_HAVE, sent: [] }
  w.push = async body => {
    const answer = await append(h, { id, at: w.bytes, body, have: w.have, lease, path })
    if (answer.status === 200 && answer.body.code === 'APPLIED') { w.bytes = answer.body.bytes; w.have = answer.body.have; w.sent.push(body) }
    return answer
  }
  w.sync = async () => {
    const manifest = await h.get(`/_thread/manifest?id=${id}`)
    w.bytes = manifest.body.thread.bytes
    w.have = `${manifest.body.thread.chain}.${manifest.body.thread.tailSha}`
  }
  return w
}

async function readBack(h, id) {
  const manifest = await h.commit('manifest', { id, page: 0 })
  const thread = manifest.body.thread
  const sealed = manifest.body.parts.map(sha => h.parts.blobs.get(sha))
  const range = await h.commit('range', { id, from: thread.sealedBytes })
  assert.equal(range.status, 200, JSON.stringify(range.body))
  return concat([...sealed, base64ToBytes(range.body.tail)])
}

const seedBlob = async (h, bytes) => {
  const sha = await sha256Hex(bytes)
  h.parts.blobs.set(sha, Uint8Array.from(bytes))
  return sha
}

// A verified rescue index in the vault's shape (vault.mjs indexIsValid): the journal is one `file` row among others.
async function rescueOf(h, file, clientId = 'client-r', path = PATH) {
  const pieces = []
  for (let at = 0; at < file.length; at += PIECE) pieces.push(await seedBlob(h, file.subarray(at, at + PIECE)))
  const other = encoder.encode('{"other":true}\n')
  return { v: 1, piece: PIECE, source: 'indexeddb', client: { clientId, base: null, reconciliation: null },
    rows: [
      { key: '/dsh/home', type: 'dir', bytes: 0, sha256: null, pieces: [] },
      { key: '/dsh/home/auma/notes.json', type: 'file', bytes: other.length, sha256: await sha256Hex(other), pieces: [await seedBlob(h, other)] },
      { key: path, type: 'file', bytes: file.length, sha256: await sha256Hex(file), pieces },
    ],
    skipped: [], totals: { rows: 3 } }
}

// The retract card: exactly the bytes [forkAt, bytes) the owner is shown, as `{id, forkAt, to, sha256}`.
async function cardOf(h, id, forkAt) {
  const range = await h.commit('range', { id, from: forkAt })
  assert.equal(range.status, 200, JSON.stringify(range.body))
  return { id, forkAt, to: range.body.bytes, sha256: await sha256Hex(base64ToBytes(range.body.tail)) }
}

// The invariants every test ends with: deletes only of tail rows, the part store never deletes or writes a key twice,
// no body carries `conflictCode`, the handler never threw.
function invariants(h) {
  for (const [kind, key] of h.store.log) if (kind === 'delete') assert.ok(key.startsWith('thread:v1:tail:'), key)
  assert.equal(h.parts.log.filter(([kind]) => kind === 'delete').length, 0)
  for (const [sha, count] of h.parts.landed) assert.equal(count, 1, `second write to ${sha}`)
  for (const body of [...h.commitBodies, ...h.httpBodies]) assert.equal(Object.hasOwn(body, 'conflictCode'), false)
  for (const body of h.httpBodies) assert.notEqual(body.code, 'COMPARE')
  assert.deepEqual(h.threw, [])
}

const ID = await threadIdForPath(PATH)

test('protocol constants are fixed; caps come from env over frozen defaults', () => {
  assert.deepEqual(THREAD_PROTOCOL, { piece: 2097152, row: 65536 })
  assert.ok(Object.isFrozen(THREAD_PROTOCOL) && Object.isFrozen(THREAD_LIMITS))
  assert.deepEqual(THREAD_LIMITS, { threads: 2048, tailBytes: 256 * 1024 * 1024, kept: 1024, preview: 512, title: 200 })
  assert.deepEqual(threadLimits({}), THREAD_LIMITS)
  assert.deepEqual(threadLimits({ THREAD_MAX: '3', THREAD_TAIL_MAX_BYTES: '9000', THREAD_KEPT_MAX: '2', THREAD_PIECE: '1' }),
    { threads: 3, tailBytes: 9000, kept: 2, preview: 512, title: 200 })
  assert.deepEqual(threadLimits({ THREAD_MAX: '-1', THREAD_KEPT_MAX: 'x' }), THREAD_LIMITS)
})

test('the path rule and the id rule', async () => {
  for (const ok of [PATH, '/dsh/home/sessions/2026/abc/session.v3.jsonl']) assert.equal(threadPathAllowed(ok), true, ok)
  for (const bad of ['/dsh/home/auma/session/other.jsonl', '/dsh/home/../session/messages.jsonl', '/dsh/home/a/b/session/messages.jsonl',
    '/dsh/workspace/auma/session/messages.jsonl', `/dsh/home/${'a'.repeat(1100)}/session/messages.jsonl`, 7]) assert.equal(threadPathAllowed(bad), false, String(bad))
  assert.equal(ID, await sha256Hex(encoder.encode(PATH)))
  const h = harness()
  const other = await threadIdForPath('/dsh/home/kira/session/messages.jsonl')
  const body = lines(2, 'a')
  assert.equal((await append(h, { id: other, at: 0, body, have: EMPTY_HAVE, path: PATH })).body.code, 'THREAD_PATH_INVALID')
  assert.equal((await append(h, { id: ID, at: 0, body, have: EMPTY_HAVE, path: '/dsh/home/x/y.jsonl' })).body.code, 'THREAD_PATH_INVALID')
  assert.equal((await append(h, { id: ID, at: 0, body, have: EMPTY_HAVE, path: null })).body.code, 'THREAD_PATH_INVALID')
  assert.equal(h.store.keys('thread:').length, 0)
  invariants(h)
})

test('F1: a body that errors mid-read writes nothing and never reaches MIRROR', async () => {
  const h = harness()
  let sent = false
  const stream = new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(fill(100, 65)) } else controller.error(new Error('reset')) } })
  const response = await h.json(await h.send(new Request(`${ORIGIN}/_thread/append?id=${ID}&at=0&p=1`, { method: 'POST', duplex: 'half', body: stream,
    headers: { ...leaseHeader(), 'x-thread-have': EMPTY_HAVE, 'x-thread-sha256': '0'.repeat(64), 'x-thread-path': PATH } })))
  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'THREAD_BODY_UNREADABLE')
  assert.deepEqual(h.mirrorCalls, [])
  assert.equal(h.store.raw().size, 0)
  invariants(h)
})

test('F1: a storage error inside the step leaves no row changed and the budget row unchanged', async () => {
  const h = harness()
  const w = writer(h, ID)
  assert.equal((await w.push(lines(3, 'a'))).body.code, 'APPLIED')
  const before = h.store.snapshot()
  h.store.failPut = key => key.startsWith('thread:v1:index:')
  const failed = await w.push(lines(2, 'b'))
  assert.equal(failed.status, 503)
  assert.equal(failed.body.code, 'THREAD_STORAGE_UNAVAILABLE')
  assert.deepEqual(h.store.snapshot(), before)
  assert.deepEqual(h.store.raw().get('budget:test'), before.get('budget:test'))
  assert.ok(h.store.log.some(([kind, key]) => kind === 'put' && key === 'budget:test'), 'the budget was charged inside the failed step')
  invariants(h)
})

test('F2: a second client gets the lease refusal; with a fake that lets both write, a stale append is DIVERGED and changes nothing', async () => {
  const h = harness()
  const a = writer(h, ID)
  assert.equal((await a.push(lines(3, 'a'))).body.code, 'APPLIED')
  const stranger = await append(h, { id: ID, at: a.bytes, body: lines(1, 'z'), have: a.have, lease: 'c'.repeat(32) })
  assert.equal(stranger.status, 423)
  assert.deepEqual(stranger.body, { ok: false, code: 'WRITER_ELSEWHERE', holder: 'client-z' })
  const b = writer(h, ID, LEASE_B)
  const snapshot = h.store.snapshot()
  const staleOffset = await b.push(lines(3, 'b'))
  assert.equal(staleOffset.status, 409)
  assert.equal(staleOffset.body.code, 'DIVERGED')
  assert.equal(staleOffset.body.bytes, a.bytes)
  assert.deepEqual(h.store.snapshot(), snapshot)
  // B learned the length but not the content: an append at the true end with a stale `have` is DIVERGED too.
  const staleHave = await append(h, { id: ID, at: a.bytes, body: lines(1, 'b'), have: EMPTY_HAVE, lease: LEASE_B })
  assert.equal(staleHave.status, 409)
  assert.equal(staleHave.body.code, 'DIVERGED')
  assert.deepEqual(h.store.snapshot(), snapshot)
  invariants(h)
})

test('F4: an import repeated after a crash gives the same thread', async () => {
  const h = harness()
  const file = lines(150, 'r')
  h.rescues.set('rescue-1', await rescueOf(h, file))
  let crashed = false
  h.beforeCall = async op => { if (op === 'import' && !crashed) { crashed = true; throw new Error('crash') } }
  const first = await h.post('/_thread/import', { path: PATH, rescue: 'rescue-1' }, leaseHeader())
  assert.equal(first.status, 503)
  const second = await h.post('/_thread/import', { path: PATH, rescue: 'rescue-1' }, leaseHeader())
  assert.equal(second.body.outcome, 'imported')
  const snapshot = h.store.snapshot()
  const third = await h.post('/_thread/import', { path: PATH, rescue: 'rescue-1' }, leaseHeader())
  assert.equal(third.body.outcome, 'same')
  assert.deepEqual(h.store.snapshot(), snapshot)
  assert.deepEqual(await readBack(h, ID), file)
  const thread = (await h.commit('manifest', { id: ID })).body.thread
  assert.equal(thread.lineEnd, file.length)
  assert.equal(thread.partCount, Math.floor(file.length / PIECE))
  invariants(h)
})

test('F5: the same part twice is APPLIED then ALREADY; a retry now partly sealed is ALREADY; past the end is GAP', async () => {
  const h = harness()
  const w = writer(h, ID)
  const data = lines(100, 'a')
  const p1 = data.subarray(0, 3000)
  const p2 = data.subarray(3000, 6000)
  assert.equal((await w.push(p1)).body.code, 'APPLIED')
  const again = await append(h, { id: ID, at: 0, body: p1, have: w.have })
  assert.equal(again.status, 200)
  assert.equal(again.body.code, 'ALREADY')
  assert.equal(again.body.bytes, 3000)
  const applied = await w.push(p2)
  assert.equal(applied.body.code, 'APPLIED')
  assert.equal(applied.body.sealedBytes, PIECE)
  const retried = await append(h, { id: ID, at: 3000, body: p2, have: w.have })
  assert.equal(retried.status, 200)
  assert.equal(retried.body.code, 'ALREADY')
  assert.equal(retried.body.bytes, 6000)
  const wrong = await append(h, { id: ID, at: 3000, body: fill(3000, 66), have: w.have })
  assert.equal(wrong.body.code, 'DIVERGED')
  const gap = await append(h, { id: ID, at: 6010, body: lines(1, 'g'), have: w.have })
  assert.equal(gap.status, 409)
  assert.deepEqual(gap.body, { ok: false, code: 'GAP', bytes: 6000 })
  assert.deepEqual(await readBack(h, ID), data.subarray(0, 6000))
  invariants(h)
})

test('F6: append, retract the caller\'s own newest lines, append others: the kept row holds the first lines byte for byte', async () => {
  const h = harness()
  const w = writer(h, ID)
  const l1 = lines(10, 'one')
  const l2 = lines(8, 'two')
  const l3 = lines(5, 'three')
  await w.push(l1)
  await w.push(l2)
  const retract = await h.post('/_thread/retract', { id: ID, forkAt: l1.length, to: l1.length + l2.length, sha256: await sha256Hex(l2) }, leaseHeader())
  assert.equal(retract.status, 200, JSON.stringify(retract.body))
  assert.deepEqual(h.approvals, [], 'the caller\'s own newest lines need no passkey, and none is asked for')
  assert.equal(retract.body.bytes, l1.length)
  assert.equal(retract.body.lineEnd, l1.length)
  w.bytes = retract.body.bytes
  w.have = `${retract.body.chain}.${retract.body.tailSha}`
  assert.equal((await w.push(l3)).body.code, 'APPLIED')
  const manifest = await h.get(`/_thread/manifest?id=${ID}`)
  assert.equal(manifest.body.kept.length, 1)
  const kept = manifest.body.kept[0]
  assert.equal(kept.why, 'retract')
  assert.equal(kept.by, 'client-a')
  assert.equal(kept.from, l1.length)
  assert.deepEqual(concat(kept.pieces.map(sha => h.parts.blobs.get(sha))), l2)
  assert.equal(kept.sha256, await sha256Hex(l2))
  assert.deepEqual(await readBack(h, ID), concat([l1, l3]))
  invariants(h)
})

test('F7: a part ending mid-line keeps lineEnd; tail never returns a partial last line', async () => {
  const h = harness()
  const w = writer(h, ID)
  await w.push(encoder.encode('{"a":1}\n{"b":'))
  const thread = (await h.get(`/_thread/manifest?id=${ID}`)).body.thread
  assert.equal(thread.lineEnd, 8)
  let tail = await h.send(new Request(`${ORIGIN}/_thread/tail?id=${ID}`))
  assert.equal(new TextDecoder().decode(await tail.arrayBuffer()), '{"a":1}\n')
  assert.equal(tail.headers.get('x-thread-from'), '0')
  assert.equal(tail.headers.get('x-thread-to'), '8')
  assert.equal(tail.headers.get('x-thread-partial'), null)
  await w.push(encoder.encode('2}\n{"c":3}\n{"d"'))
  tail = await h.send(new Request(`${ORIGIN}/_thread/tail?id=${ID}&max=12`))
  assert.equal(new TextDecoder().decode(await tail.arrayBuffer()), '{"c":3}\n')
  tail = await h.send(new Request(`${ORIGIN}/_thread/tail?id=${ID}&before=16`))
  assert.equal(new TextDecoder().decode(await tail.arrayBuffer()), '{"a":1}\n{"b":2}\n')
  tail = await h.send(new Request(`${ORIGIN}/_thread/tail?id=${ID}&max=4`))
  assert.equal(tail.headers.get('x-thread-partial'), '1')
  assert.equal(new TextDecoder().decode(await tail.arrayBuffer()), ':3}\n')
  invariants(h)
})

test('F8: over PIECE is 413 with and without content-length; a stalled body is 408', async () => {
  const h = harness()
  const headers = { ...leaseHeader(), 'x-thread-have': EMPTY_HAVE, 'x-thread-sha256': '0'.repeat(64), 'x-thread-path': PATH }
  const declared = { method: 'POST', url: `${ORIGIN}/_thread/append?id=${ID}&at=0&p=1`, headers: new Headers({ ...headers, 'content-length': String(PIECE + 1) }),
    body: new ReadableStream({ start(c) { c.enqueue(fill(PIECE + 1, 65)); c.close() } }) }
  const one = await h.json(await h.send(declared))
  assert.equal(one.status, 413)
  assert.equal(one.body.code, 'PART_TOO_LARGE')
  let chunks = 0
  const streamed = new Request(`${ORIGIN}/_thread/append?id=${ID}&at=0&p=1`, { method: 'POST', duplex: 'half', headers,
    body: new ReadableStream({ pull(c) { if (chunks++ < 5) c.enqueue(fill(1000, 65)); else c.close() } }) })
  assert.equal(streamed.headers.get('content-length'), null)
  const two = await h.json(await h.send(streamed))
  assert.equal(two.status, 413)
  assert.equal(two.body.code, 'PART_TOO_LARGE')
  const stalled = new Request(`${ORIGIN}/_thread/append?id=${ID}&at=0&p=1`, { method: 'POST', duplex: 'half', headers,
    body: new ReadableStream({ start(c) { c.enqueue(fill(10, 65)) } }) })
  const three = await h.json(await h.send(stalled))
  assert.equal(three.status, 408)
  assert.equal(three.body.code, 'REQUEST_BODY_TIMEOUT')
  assert.deepEqual(h.mirrorCalls, [])
  assert.equal(h.store.raw().size, 0)
  invariants(h)
})

test('F9: p=2 is 426; a blob put with no following step is completed by the next append and reads back whole', async () => {
  const h = harness()
  const w = writer(h, ID)
  const wrongProtocol = await append(h, { id: ID, at: 0, body: lines(1, 'a'), have: EMPTY_HAVE, p: '2' })
  assert.equal(wrongProtocol.status, 426)
  assert.equal(wrongProtocol.body.code, 'PROTOCOL')
  const data = lines(120, 'a')
  let crashes = 0
  h.beforeCall = async op => { if (op === 'seal' && crashes++ === 0) throw new Error('crash between put and seal') }
  assert.equal((await w.push(data.subarray(0, 3000))).body.code, 'APPLIED')
  const first = await w.push(data.subarray(3000, 4100))
  assert.equal(first.status, 200)
  assert.equal(first.body.code, 'APPLIED')
  assert.equal(first.body.sealedBytes, 0)
  assert.equal(h.parts.landed.size, 1, 'the blob was put')
  const second = await w.push(data.subarray(4100, 5000))
  assert.equal(second.body.code, 'APPLIED')
  assert.equal(second.body.sealedBytes, PIECE)
  assert.equal(h.parts.landed.size, 1, 'the next append reused the blob')
  assert.deepEqual(await readBack(h, ID), data.subarray(0, 5000))
  invariants(h)
})

test('F17: a failing head after put deletes no tail row and the append stays APPLIED', async () => {
  const h = harness()
  const w = writer(h, ID)
  h.parts.headFailsAfterPut = true
  await w.push(lines(40, 'a'))
  const answer = await w.push(lines(40, 'b'))
  assert.equal(answer.status, 200)
  assert.equal(answer.body.code, 'APPLIED')
  assert.equal(answer.body.sealedBytes, 0)
  assert.ok(!h.mirrorCalls.includes('seal'))
  assert.equal(h.store.log.filter(([kind]) => kind === 'delete').length, 0)
  assert.deepEqual(await readBack(h, ID), concat([lines(40, 'a'), lines(40, 'b')]))
  invariants(h)
})

test('F19: retract below run.from, by another client, or below sealedBytes is refused and changes nothing', async () => {
  const h = harness()
  const a = writer(h, ID)
  await a.push(lines(40, 'a'))
  await a.push(lines(40, 'a2'))
  const b = writer(h, ID, LEASE_B)
  await b.sync()
  const bStart = b.bytes
  await b.push(lines(10, 'b'))
  const thread = (await h.get(`/_thread/manifest?id=${ID}`)).body.thread
  assert.ok(thread.sealedBytes > 0)
  assert.deepEqual(thread.run, { client: 'client-b', from: bStart })
  const snapshot = h.store.snapshot()
  const byOtherCard = await cardOf(h, ID, bStart)
  const byOther = await h.post('/_thread/retract', byOtherCard, leaseHeader(LEASE_A))
  assert.equal(byOther.status, 403)
  assert.equal(byOther.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  const belowRun = await h.post('/_thread/retract', await cardOf(h, ID, bStart - 10), leaseHeader(LEASE_B))
  assert.equal(belowRun.status, 403)
  assert.equal(belowRun.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  h.approved = true
  const belowSealed = await h.post('/_thread/retract', { id: ID, forkAt: thread.sealedBytes - 1, to: thread.bytes, sha256: '0'.repeat(64) },
    leaseHeader(LEASE_B))
  assert.equal(belowSealed.status, 409)
  assert.equal(belowSealed.body.code, 'RETRACT_TOO_DEEP')
  assert.deepEqual(h.store.snapshot(), snapshot)
  // With the owner's approval the first case is allowed, and the passkey saw exactly the card.
  h.approvals.length = 0
  const approved = await h.post('/_thread/retract', byOtherCard, leaseHeader(LEASE_A))
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  assert.deepEqual(h.approvals, [byOtherCard])
  invariants(h)
})

test('F20: an import that is not a prefix is kept beside and the thread is unchanged; again, still one kept row', async () => {
  const h = harness()
  const w = writer(h, ID)
  await w.push(lines(30, 'mine'))
  h.rescues.set('rescue-x', await rescueOf(h, lines(90, 'theirs')))
  const before = await readBack(h, ID)
  const first = await h.post('/_thread/import', { path: PATH, rescue: 'rescue-x' }, leaseHeader())
  assert.equal(first.body.outcome, 'kept-beside')
  const second = await h.post('/_thread/import', { path: PATH, rescue: 'rescue-x' }, leaseHeader())
  assert.equal(second.body.outcome, 'kept-beside')
  const manifest = await h.get(`/_thread/manifest?id=${ID}`)
  assert.equal(manifest.body.kept.length, 1)
  assert.equal(manifest.body.kept[0].why, 'import-fork')
  assert.equal(manifest.body.kept[0].from, 0)
  assert.deepEqual(await readBack(h, ID), before)
  invariants(h)
})

test('an approved retract removes only the bytes its card showed; lines appended after the card are 409 THREAD_MOVED', async () => {
  const h = harness()
  const a = writer(h, ID)
  await a.push(lines(3, 'a'))
  const b = writer(h, ID, LEASE_B)
  await b.sync()
  const forkAt = b.bytes
  const shown = lines(2, 'b-shown')
  await b.push(shown)
  const card = { id: ID, forkAt, to: forkAt + shown.length, sha256: await sha256Hex(shown) }
  assert.deepEqual(await cardOf(h, ID, forkAt), card)
  await b.push(lines(4, 'b-unseen'))
  h.approved = true
  const snapshot = h.store.snapshot()
  const puts = h.parts.log.filter(([kind]) => kind === 'put').length
  const moved = await h.post('/_thread/retract', card, leaseHeader(LEASE_A))
  assert.deepEqual([moved.status, moved.body.code], [409, 'THREAD_MOVED'], JSON.stringify(moved.body))
  assert.equal(moved.body.bytes, forkAt + shown.length + lines(4, 'b-unseen').length)
  assert.deepEqual(h.store.snapshot(), snapshot)
  assert.equal(h.parts.log.filter(([kind]) => kind === 'put').length, puts, 'no blob is written for a stale card')
  assert.deepEqual(h.approvals, [], 'the passkey is never asked over a card that no longer matches')
  // The same length with other bytes is also refused: the hash binds the bytes, not only the end.
  const sameEnd = await h.post('/_thread/retract', { ...card, to: b.bytes }, leaseHeader(LEASE_A))
  assert.deepEqual([sameEnd.status, sameEnd.body.code], [409, 'THREAD_MOVED'])
  assert.deepEqual(h.store.snapshot(), snapshot)
  // A fresh card over everything B wrote is approved and removes exactly those bytes.
  const fresh = await cardOf(h, ID, forkAt)
  const done = await h.post('/_thread/retract', fresh, leaseHeader(LEASE_A))
  assert.deepEqual([done.status, done.body.code], [200, 'RETRACTED'], JSON.stringify(done.body))
  assert.deepEqual(h.approvals, [fresh])
  const kept = (await h.get(`/_thread/manifest?id=${ID}`)).body.kept[0]
  assert.equal(kept.sha256, fresh.sha256)
  assert.deepEqual(await readBack(h, ID), lines(3, 'a'))
  invariants(h)
})

test('the passkey check is called after the handler parsed the body, with exactly that body, and only when needed', async () => {
  const h = harness()
  const a = writer(h, ID)
  await a.push(lines(3, 'a'))
  const b = writer(h, ID, LEASE_B)
  await b.sync()
  await b.push(lines(2, 'b'))
  const card = await cardOf(h, ID, a.bytes)
  // A refused or throwing passkey check is a 403, never a thrown error; nothing changes.
  const snapshot = h.store.snapshot()
  const refused = await h.post('/_thread/retract', card, leaseHeader(LEASE_A))
  assert.deepEqual([refused.status, refused.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'])
  const threw = await h.json(await h.send(new Request(`${ORIGIN}/_thread/retract`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...leaseHeader(LEASE_A) }, body: JSON.stringify(card) }),
    { approve: async () => { throw new Error('passkey failed') } }))
  assert.deepEqual([threw.status, threw.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'])
  assert.deepEqual(h.store.snapshot(), snapshot)
  // The request body is read once, by the handler; the check gets the parsed card and approves it.
  h.approvals.length = 0
  h.approved = true
  const request = new Request(`${ORIGIN}/_thread/retract`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...leaseHeader(LEASE_A) }, body: JSON.stringify(card) })
  const answer = await h.json(await h.send(request))
  assert.deepEqual([answer.status, answer.body.code], [200, 'RETRACTED'], JSON.stringify(answer.body))
  assert.equal(request.bodyUsed, true)
  assert.deepEqual(h.approvals, [card])
  assert.deepEqual(Object.keys(h.approvals[0]).sort(), ['forkAt', 'id', 'sha256', 'to'])
  invariants(h)
})

test('an import that would be kept beside still needs the lease; a refused lease adds no kept row', async () => {
  const h = harness()
  const w = writer(h, ID)
  await w.push(lines(30, 'mine'))
  h.rescues.set('rescue-x', await rescueOf(h, lines(90, 'theirs')))
  const snapshot = h.store.snapshot()
  const checks = h.leaseChecks
  const refused = await h.post('/_thread/import', { path: PATH, rescue: 'rescue-x' }, leaseHeader('c'.repeat(32)))
  assert.deepEqual([refused.status, refused.body.code], [423, 'WRITER_ELSEWHERE'], JSON.stringify(refused.body))
  assert.equal(h.leaseChecks, checks + 1)
  assert.deepEqual(h.store.snapshot(), snapshot)
  assert.equal((await h.get(`/_thread/manifest?id=${ID}`)).body.thread.keptCount, 0)
  // keep through MIRROR with why import-fork and no lease is refused before checkLease.
  const direct = await h.commit('keep', { id: ID, forkAt: 0, bytes: 1, sha256: 'a'.repeat(64), pieces: ['a'.repeat(64)], by: 'x', why: 'import-fork' })
  assert.deepEqual([direct.status, direct.body.code], [423, 'WRITER_REQUIRED'])
  assert.equal(h.leaseChecks, checks + 1)
  invariants(h)
})

test('a vault rescue index is read by its journal row; a null clientId gives the run to the lease holder', async () => {
  const h = harness()
  const file = lines(150, 'r')
  h.rescues.set('no-client', await rescueOf(h, file, null))
  const imported = await h.post('/_thread/import', { path: PATH, rescue: 'no-client' }, leaseHeader(LEASE_B))
  assert.deepEqual([imported.status, imported.body.outcome], [200, 'imported'], JSON.stringify(imported.body))
  const thread = (await h.get(`/_thread/manifest?id=${ID}`)).body.thread
  assert.deepEqual(thread.run, { client: 'client-b', from: 0 })
  assert.deepEqual(await readBack(h, ID), file)
  // A fork from a rescue with no client is kept beside under the lease holder's name.
  h.rescues.set('fork', await rescueOf(h, lines(150, 'other'), null))
  const fork = await h.post('/_thread/import', { path: PATH, rescue: 'fork' }, leaseHeader(LEASE_A))
  assert.equal(fork.body.outcome, 'kept-beside')
  const kept = (await h.get(`/_thread/manifest?id=${ID}`)).body.kept
  assert.deepEqual(kept.map(row => [row.why, row.by]), [['import-fork', 'client-a']])
  // An index with no row for this journal, or two, is unknown.
  h.rescues.set('elsewhere', await rescueOf(h, file, 'client-r', '/dsh/home/other/session/messages.jsonl'))
  const elsewhere = await h.post('/_thread/import', { path: PATH, rescue: 'elsewhere' }, leaseHeader())
  assert.deepEqual([elsewhere.status, elsewhere.body.code], [404, 'RESCUE_UNKNOWN'])
  const twice = await rescueOf(h, file)
  twice.rows.push({ ...twice.rows.at(-1) })
  h.rescues.set('twice', twice)
  const doubled = await h.post('/_thread/import', { path: PATH, rescue: 'twice' }, leaseHeader())
  assert.deepEqual([doubled.status, doubled.body.code], [404, 'RESCUE_UNKNOWN'])
  invariants(h)
})

test('race: a retract between a seal\'s put and its seal step, then other bytes: the late seal changes nothing', async () => {
  const h = harness()
  const lease = { leaseId: LEASE_A, generation: 1 }
  const first = fill(PIECE, 97)
  const applied = await h.commit('append', { id: ID, at: 0, body: bytesToBase64(first), bodySha: await sha256Hex(first), have: EMPTY_HAVE, lease, path: PATH })
  assert.equal(applied.body.sealDue, true)
  const range = await h.commit('range', { id: ID, from: 0, to: PIECE })
  const bytes = base64ToBytes(range.body.tail)
  const sha = await sha256Hex(bytes)
  await h.parts.put(sha, bytes)
  const pair = { bytes: applied.body.bytes, sealedBytes: 0, chain: applied.body.chain, tailSha: applied.body.tailSha }
  const retracted = await h.commit('retract', { id: ID, forkAt: 0, kept: { bytes: PIECE, sha256: sha, pieces: [sha] }, expect: pair, lease, approved: false })
  assert.equal(retracted.body.code, 'RETRACTED')
  const other = fill(PIECE, 98)
  const again = await h.commit('append', { id: ID, at: 0, body: bytesToBase64(other), bodySha: await sha256Hex(other),
    have: `${retracted.body.chain}.${retracted.body.tailSha}`, lease })
  assert.equal(again.body.code, 'APPLIED')
  const late = await h.commit('seal', { id: ID, sha256: sha })
  assert.deepEqual(late.body, { sealed: false })
  const thread = (await h.commit('manifest', { id: ID })).body.thread
  assert.equal(thread.partCount, 0)
  assert.deepEqual(await readBack(h, ID), other)
  invariants(h)
})

test('race: an append between range and the retract step is 503 THREAD_MOVED and deletes nothing', async () => {
  const h = harness()
  const w = writer(h, ID)
  const l1 = lines(5, 'one')
  await w.push(l1)
  await w.push(lines(5, 'two'))
  const range = await h.commit('range', { id: ID, from: l1.length })
  const removed = base64ToBytes(range.body.tail)
  const sha = await sha256Hex(removed)
  await h.parts.put(sha, removed)
  await w.push(lines(3, 'three'))
  const snapshot = h.store.snapshot()
  const deletes = h.store.log.filter(([kind]) => kind === 'delete').length
  const late = await h.commit('retract', { id: ID, forkAt: l1.length, kept: { bytes: removed.length, sha256: sha, pieces: [sha] },
    expect: { bytes: range.body.bytes, sealedBytes: range.body.sealedBytes, chain: range.body.chain, tailSha: range.body.tailSha },
    lease: { leaseId: LEASE_A, generation: 1 }, approved: false })
  assert.equal(late.status, 503)
  assert.equal(late.body.code, 'THREAD_MOVED')
  assert.deepEqual(h.store.snapshot(), snapshot)
  assert.equal(h.store.log.filter(([kind]) => kind === 'delete').length, deletes)
  invariants(h)
})

test('no lease header is 423 for append, import and retract whatever the lease says; an ok without clientId is 423', async () => {
  const h = harness()
  h.ctx.checkLease = async () => { h.leaseChecks += 1; return { ok: true, clientId: 'anyone' } }
  const w = writer(h, ID)
  await w.push(lines(3, 'a'))
  const checks = h.leaseChecks
  const noLease = await append(h, { id: ID, at: w.bytes, body: lines(1, 'b'), have: w.have, lease: null })
  assert.deepEqual([noLease.status, noLease.body.code], [423, 'WRITER_REQUIRED'])
  const importNoLease = await h.post('/_thread/import', { path: PATH, rescue: 'r' })
  assert.deepEqual([importNoLease.status, importNoLease.body.code], [423, 'WRITER_REQUIRED'])
  const retractNoLease = await h.post('/_thread/retract', { id: ID, forkAt: 0 })
  assert.deepEqual([retractNoLease.status, retractNoLease.body.code], [423, 'WRITER_REQUIRED'])
  for (const op of ['append', 'import', 'retract']) {
    const direct = await h.commit(op, { id: ID, at: 0, forkAt: 0, lease: null })
    assert.deepEqual([direct.status, direct.body.code], [423, 'WRITER_REQUIRED'], op)
  }
  assert.equal(h.leaseChecks, checks, 'checkLease was never called without a lease ref')
  h.ctx.checkLease = async () => ({ ok: true })
  const noClient = await append(h, { id: ID, at: w.bytes, body: lines(1, 'b'), have: w.have })
  assert.deepEqual([noClient.status, noClient.body.code], [423, 'WRITER_REQUIRED'])
  invariants(h)
})

test('keep twice is one row; a missing blob is 424; retract at forkAt == bytes is 200 and adds no row', async () => {
  const h = harness()
  const w = writer(h, ID)
  await w.push(lines(4, 'a'))
  const blob = lines(2, 'kept')
  const sha = await seedBlob(h, blob)
  const input = { id: ID, forkAt: 7, pieces: [sha], bytes: blob.length, sha256: await sha256Hex(blob) }
  assert.equal((await h.post('/_thread/keep', input)).body.code, 'KEPT')
  assert.equal((await h.post('/_thread/keep', input)).body.code, 'ALREADY')
  const missing = await h.post('/_thread/keep', { ...input, pieces: ['f'.repeat(64)] })
  assert.deepEqual([missing.status, missing.body.code], [424, 'KEPT_BLOB_MISSING'])
  let manifest = await h.get(`/_thread/manifest?id=${ID}`)
  assert.equal(manifest.body.kept.length, 1)
  const snapshot = h.store.snapshot()
  const atEnd = await h.post('/_thread/retract', { id: ID, forkAt: w.bytes, to: w.bytes, sha256: THREAD_EMPTY_SHA }, leaseHeader())
  assert.equal(atEnd.status, 200)
  assert.equal(atEnd.body.bytes, w.bytes)
  assert.deepEqual(h.store.snapshot(), snapshot)
  manifest = await h.get(`/_thread/manifest?id=${ID}`)
  assert.equal(manifest.body.thread.keptCount, 1)
  invariants(h)
})

test('an import of an older rescue is same with no row; an extending import sets run to the rescue\'s client', async () => {
  const h = harness()
  const file = lines(160, 'f')
  const w = writer(h, ID)
  for (let at = 0; at < 7000; at += 3500) await w.push(file.subarray(at, at + 3500))
  h.rescues.set('older', await rescueOf(h, file.subarray(0, 5000)))
  const snapshot = h.store.snapshot()
  const older = await h.post('/_thread/import', { path: PATH, rescue: 'older' }, leaseHeader())
  assert.equal(older.body.outcome, 'same')
  assert.deepEqual(h.store.snapshot(), snapshot)
  h.rescues.set('newer', await rescueOf(h, file, 'client-old-tab'))
  const newer = await h.post('/_thread/import', { path: PATH, rescue: 'newer' }, leaseHeader())
  assert.equal(newer.body.outcome, 'extended')
  const thread = (await h.get(`/_thread/manifest?id=${ID}`)).body.thread
  assert.deepEqual(thread.run, { client: 'client-old-tab', from: 7000 })
  assert.equal(thread.keptCount, 0)
  assert.equal(thread.lineEnd, file.length)
  assert.deepEqual(await readBack(h, ID), file)
  invariants(h)
})

test('the answer after a seal carries the new pair and the next append with it is APPLIED', async () => {
  const h = harness()
  const w = writer(h, ID)
  const data = lines(150, 'a')
  await w.push(data.subarray(0, 3000))
  const crossing = await w.push(data.subarray(3000, 4500))
  assert.equal(crossing.body.code, 'APPLIED')
  const thread = (await h.commit('manifest', { id: ID })).body.thread
  assert.equal(crossing.body.sealedBytes, PIECE)
  assert.equal(crossing.body.have, `${thread.chain}.${thread.tailSha}`)
  assert.equal(crossing.body.chain, thread.chain)
  assert.equal((await w.push(data.subarray(4500, 6000))).body.code, 'APPLIED')
  invariants(h)
})

test('a slow parts.put hits the deadline: the append stays APPLIED, and a pending seal answers 503', async () => {
  const h = harness()
  const w = writer(h, ID)
  const data = lines(200, 'a')
  await w.push(data.subarray(0, 3000))
  h.parts.slowPut = true
  const first = await w.push(data.subarray(3000, 4500))
  assert.deepEqual([first.status, first.body.code, first.body.sealedBytes, first.body.bytes], [200, 'APPLIED', 0, 4500])
  const second = await w.push(data.subarray(4500, 8500))
  assert.deepEqual([second.status, second.body.code], [503, 'SEAL_PENDING'])
  assert.deepEqual(await readBack(h, ID), data.subarray(0, 4500))
  invariants(h)
})

test('tail rows keep offset order past k = 10', async () => {
  const h = harness()
  const w = writer(h, ID)
  const data = lines(40, 'a')
  await w.push(data.subarray(0, 2000))
  await w.push(data.subarray(2000, 3900))
  const ks = h.store.keys(`thread:v1:tail:${ID}:`).map(key => Number(key.split(':').at(-1)))
  assert.ok(ks.length > 11)
  assert.deepEqual(ks, [...ks].sort((x, y) => x - y))
  assert.deepEqual(ks, Array.from({ length: ks.length }, (_, i) => i))
  assert.deepEqual(await readBack(h, ID), data.subarray(0, 3900))
  invariants(h)
})

test('a 10-piece thread read back through manifest, parts and tail equals the bytes sent; chain matches by hand', async () => {
  const h = harness()
  const w = writer(h, ID)
  const data = lines(720, 'ten')
  assert.ok(data.length > 10 * PIECE)
  for (let at = 0; at < data.length; at += 3001) assert.equal((await w.push(data.subarray(at, at + 3001))).body.code, 'APPLIED')
  const manifest = await h.get(`/_thread/manifest?id=${ID}`)
  const thread = manifest.body.thread
  assert.ok(thread.partCount >= 10)
  const sealed = concat(manifest.body.parts.map(sha => h.parts.blobs.get(sha)))
  assert.deepEqual(sealed, data.subarray(0, thread.sealedBytes))
  const tail = await h.send(new Request(`${ORIGIN}/_thread/tail?id=${ID}`))
  assert.equal(tail.headers.get('x-thread-from'), '0')
  assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), data)
  let chain = new Uint8Array(32)
  for (const sha of manifest.body.parts.slice(0, 3)) {
    chain = new Uint8Array(await crypto.subtle.digest('SHA-256', concat([chain, Uint8Array.from(Buffer.from(sha, 'hex'))])))
  }
  const h3 = harness()
  const w3 = writer(h3, ID)
  for (let at = 0; at < 3 * PIECE + 100; at += 3001) await w3.push(data.subarray(at, Math.min(at + 3001, 3 * PIECE + 100)))
  const three = (await h3.commit('manifest', { id: ID })).body.thread
  assert.equal(three.partCount, 3)
  assert.equal(three.chain, Buffer.from(chain).toString('hex'))
  invariants(h)
  invariants(h3)
})

test('index paging', async () => {
  const h = harness()
  const paths = [PATH, '/dsh/home/sessions/a/b/session.v1.jsonl', '/dsh/home/sessions/c/d/session.v2.jsonl']
  for (const path of paths) {
    const w = writer(h, await threadIdForPath(path), LEASE_A, path)
    assert.equal((await w.push(lines(1, path))).body.code, 'APPLIED')
  }
  const first = await h.get('/_thread/index?limit=2')
  assert.equal(first.body.threads.length, 2)
  assert.ok(first.body.next)
  const second = await h.get(`/_thread/index?limit=2&after=${first.body.next}`)
  assert.equal(second.body.threads.length, 1)
  assert.equal(second.body.next, null)
  const ids = [...first.body.threads, ...second.body.threads].map(row => row.id)
  assert.deepEqual(ids, (await Promise.all(paths.map(threadIdForPath))).sort())
  invariants(h)
})

test('budget 429 and 507 are returned with nothing written; the thread cap is 507 WORLD_FULL', async () => {
  const h = harness({ limits: { ...THREAD_LIMITS, threads: 1 } })
  const w = writer(h, ID)
  await w.push(lines(2, 'a'))
  const snapshot = h.store.snapshot()
  h.budgetRefusal = { ok: false, status: 429, code: 'BUDGET_RATE', retryAfterMs: 1500 }
  const rate = await w.push(lines(2, 'b'))
  assert.deepEqual([rate.status, rate.body], [429, { ok: false, code: 'BUDGET_RATE', retryAfterMs: 1500 }])
  h.budgetRefusal = { ok: false, status: 507, code: 'BUDGET_STORAGE_FULL' }
  const full = await w.push(lines(2, 'b'))
  assert.deepEqual([full.status, full.body.code], [507, 'BUDGET_STORAGE_FULL'])
  assert.deepEqual(h.store.snapshot(), snapshot)
  h.budgetRefusal = null
  const otherPath = '/dsh/home/kira/session/messages.jsonl'
  const other = writer(h, await threadIdForPath(otherPath), LEASE_A, otherPath)
  const cap = await other.push(lines(1, 'c'))
  assert.deepEqual([cap.status, cap.body], [507, { ok: false, code: 'WORLD_FULL', var: 'THREAD_MAX' }])
  assert.deepEqual(h.store.snapshot(), snapshot)
  invariants(h)
})

test('a wrong piece is 409 PIECE_MISMATCH; idle not null is 503 THREAD_PARKED', async () => {
  const h = harness()
  const w = writer(h, ID)
  await w.push(lines(2, 'a'))
  const lease = { leaseId: LEASE_A, generation: 1 }
  const body = lines(1, 'b')
  const bodySha = await sha256Hex(body)
  const otherPiece = await h.store.transaction(tx => threadCommit(tx, 'append', { id: ID, at: w.bytes, body: bytesToBase64(body),
    bodySha, have: w.have, lease }, { ...h.ctx, protocol: { piece: 8192, row: ROW } }))
  assert.deepEqual([otherPiece.status, otherPiece.body.code], [409, 'PIECE_MISMATCH'])
  h.rescues.set('wrong', { ...(await rescueOf(h, lines(3, 'r'))), piece: 8192 })
  const wrongRescue = await h.post('/_thread/import', { path: PATH, rescue: 'wrong' }, leaseHeader())
  assert.deepEqual([wrongRescue.status, wrongRescue.body.code], [409, 'PIECE_MISMATCH'])
  const key = `thread:v1:index:${ID}`
  h.store.raw().set(key, { ...h.store.raw().get(key), idle: { at: 1 } })
  const parked = await w.push(lines(1, 'c'))
  assert.deepEqual([parked.status, parked.body.code], [503, 'THREAD_PARKED'])
  invariants(h)
})

test('the MIRROR half never names a transaction, the part store or the network', async () => {
  const source = await fs.readFile(new URL('../thread-log.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('// <mirror-half>')
  const end = source.indexOf('// </mirror-half>')
  assert.ok(start >= 0 && end > start)
  const half = source.slice(start, end)
  assert.ok(half.includes('export async function threadCommit('))
  for (const banned of ['transaction(', 'parts.', 'fetch(']) assert.equal(half.includes(banned), false, banned)
})

test('createR2PartStore heads first, writes once with sha256 and if-none-match, and never deletes', async () => {
  const objects = new Map()
  const log = []
  const bucket = {
    async head(key) { log.push(['head', key]); return objects.has(key) ? { size: objects.get(key).length } : null },
    async put(key, bytes, options) { log.push(['put', key, options]); objects.set(key, Uint8Array.from(bytes)); return { size: bytes.length } },
    async get(key, options) {
      log.push(['get', key, options])
      const blob = objects.get(key)
      return blob ? { arrayBuffer: async () => blob.slice(options.range.offset, options.range.offset + options.range.length).buffer } : null
    },
    async delete(key) { log.push(['delete', key]) },
  }
  const store = createR2PartStore(bucket, 'world1')
  const bytes = lines(3, 'r2')
  const sha = await sha256Hex(bytes)
  assert.equal(await store.head(sha), null)
  assert.deepEqual(await store.put(sha, bytes), { size: bytes.length, written: true })
  assert.deepEqual(await store.put(sha, bytes), { size: bytes.length, written: false })
  assert.deepEqual(await store.get(sha, { offset: 2, length: 5 }), bytes.slice(2, 7))
  const puts = log.filter(([kind]) => kind === 'put')
  assert.equal(puts.length, 1)
  assert.equal(puts[0][1], `w/world1/blob/${sha}`)
  assert.equal(puts[0][2].sha256, sha)
  assert.equal(puts[0][2].onlyIf.get('if-none-match'), '*')
  assert.deepEqual(log.slice(0, 3).map(([kind]) => kind), ['head', 'head', 'put'])
  assert.equal(log.filter(([kind]) => kind === 'delete').length, 0)
  assert.throws(() => createR2PartStore(bucket, '../x'))
})
