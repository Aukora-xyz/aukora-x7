/**
 * The outside review's HOLD on the vault (sections 4 and 5): a body read is bounded in MEMORY,
 * a GET's body has a deadline, the verified-rescue cap holds at publication (also against two at once), and the world
 * budget is reserved before a put so concurrent uploads cannot pass one allowance together.
 * Concurrency here makes R2's `if-none-match` refuse on purpose, so this file keeps its own whole-file invariant
 * (no delete, no overwrite, every put conditional) and does not share vault.test.mjs's "never refused" one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import v8 from 'node:v8'
import vm from 'node:vm'
import * as vault from '../vault.mjs'
import * as budgetModule from '../world-budget.mjs'
import { allVaultBuckets, buildRescue, createRollbackStorage, createVaultBucket, createVaultBudget, sha256Hex } from './vault-fakes.mjs'

const ORIGIN = 'https://x61.example.invalid'
const WORLD = 'node-main-v1'
const SMALL = 16
const enc = new TextEncoder()
const NOW = Date.UTC(2026, 10, 12, 13, 0, 0)
// Read through the namespaces so this file also LOADS against the code before the fix (fail-first runs it there).
const { handleVaultRequest } = vault
const { WORLD_BUDGET_KEY, worldBudgetCall } = budgetModule
const EMPTY_READS_MAX = /** @type {any} */ (vault).EMPTY_READS_MAX ?? 4096
/** @param {string} kind @param {string} ref */
const worldBudgetRefKey = (kind, ref) => /** @type {any} */ (budgetModule).worldBudgetRefKey?.(kind, ref) ?? `missing-ref-key:${kind}:${ref}`

/** Every reply and every throw the handler produced in this file. */
const thrown = []

/** @param {object} [options] */
function harness(options = {}) {
  const { bucket = createVaultBucket(), budget = createVaultBudget({ now: () => NOW }), limits = { piece: SMALL }, deadlines, now = () => NOW } = options
  /**
   * Answers with the Response itself; reading its body is the caller's (under a deadline where it matters).
   * @param {string} method @param {string} path @param {{ body?: BodyInit | null, headers?: Record<string, string> }} [init]
   */
  const raw = async (method, path, { body = null, headers = {} } = {}) => {
    const url = new URL(path, ORIGIN)
    const h = new Headers(headers)
    h.set('sec-fetch-site', 'same-origin')
    const stream = body && typeof body === 'object' && 'getReader' in body
    const request = new Request(url, { method, headers: h, body, ...(stream ? { duplex: 'half' } : {}) })
    try {
      return await handleVaultRequest({ request, url, env: { ARCHIVE_BUCKET: bucket }, world: WORLD, ready: true, budget, now, deadlines, limits, log: () => {} })
    } catch (error) {
      thrown.push(error)
      throw error
    }
  }
  /** @param {string} method @param {string} path @param {{ body?: BodyInit | null, headers?: Record<string, string> }} [init] */
  const call = async (method, path, init) => {
    const response = await raw(method, path, init)
    const bytes = await within(response.arrayBuffer().then(b => new Uint8Array(b)), 2000, 'response body')
    const text = new TextDecoder().decode(bytes)
    let json = null
    if ((response.headers.get('content-type') ?? '').startsWith('application/json')) { try { json = JSON.parse(text) } catch { json = null } }
    return { status: response.status, headers: response.headers, bytes, text, json }
  }
  return { bucket, budget, raw, call }
}

/**
 * A promise, or a rejection naming what never finished.
 * @template T @param {Promise<T>} work @param {number} ms @param {string} what @returns {Promise<T>}
 */
async function within(work, ms, what) {
  let timer
  try {
    return await Promise.race([work, new Promise((_r, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms) })])
  } finally { clearTimeout(timer) }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const putOps = (bucket, pred = () => true) => bucket.calls.filter(c => c.op === 'put' && pred(c.key))

async function storeRescue(h, rescue) {
  for (const [hash, bytes] of rescue.pieces) {
    const res = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
    assert.ok(res.status === 201 || res.status === 200, `piece stored: ${res.status} ${res.text}`)
  }
  return h.call('PUT', `/_vault/rescue/${rescue.id}`, { body: rescue.indexBytes })
}

async function verifyAll(h, id) {
  let cursor = 0
  for (let i = 0; i < 1000; i += 1) {
    const res = await h.call('POST', `/_vault/rescue/${id}/verify?cursor=${cursor}`)
    if (res.status !== 200 || res.json.done) return res
    cursor = res.json.cursor
  }
  throw new Error('verify never finished')
}

/**
 * A `list` that takes its snapshot first and answers 20 ms later: two callers both see the slots as they were before
 * either claimed one (the race R2 has no transaction for).
 */
const staleList = bucket => async (/** @type {string} */ prefix) => {
  const objects = [...bucket.objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, entry]) => ({ key, size: entry.bytes.byteLength, customMetadata: { ...entry.customMetadata } }))
  await sleep(20)
  return { override: { objects, truncated: false, delimitedPrefixes: [] } }
}

const make = n => buildRescue({ piece: SMALL, rows: [{ key: `/dsh/home/n${n}`, type: 'file', bytes: enc.encode(`file number ${n}`) }] })
const manifests = bucket => [...bucket.objects.keys()].filter(k => k.endsWith('/manifest.json'))

/** `gc` without a command-line flag. */
const collect = (() => {
  if (typeof globalThis.gc === 'function') return globalThis.gc
  v8.setFlagsFromString('--expose-gc')
  return vm.runInNewContext('gc')
})()

// ---------------------------------------------------------------- MUST 1: a body read is bounded in memory

test('MUST 1: 600,000 one-byte chunks (no content-length) grow heap plus array buffers by less than 16 MiB, and the piece stores', async () => {
  const N = 600000
  const all = new Uint8Array(N)
  for (let i = 0; i < N; i += 1) all[i] = (i * 31) & 0xff
  const hash = await sha256Hex(all)
  const h = harness({ limits: {} })
  const sample = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers }
  let at = 0
  let peak = 0
  collect()
  const before = sample()
  const body = new ReadableStream({
    pull(controller) {
      if (at === N) {
        // Every byte has been handed over; whatever the reader keeps is still alive here.
        collect()
        peak = sample() - before
        controller.close()
        return
      }
      controller.enqueue(all.slice(at, at + 1))
      at += 1
    },
  }, { highWaterMark: 0 })
  const res = await h.call('PUT', `/_vault/blob/${hash}`, { body })
  assert.equal(res.status, 201, res.text)
  assert.equal(at, N)
  assert.ok(peak > 0, 'the peak was sampled')
  assert.ok(peak < 16 * 1024 * 1024, `kept ${(peak / 1048576).toFixed(1)} MiB while reading 600,000 one-byte chunks`)
  assert.deepEqual(h.bucket.objects.get(`w/${WORLD}/blob/${hash}`).bytes, all)
})

test('MUST 1: empty chunks do not reset the idle wait: 408 at the idle deadline, not the total one', async () => {
  const h = harness({ deadlines: { idleMs: 60, totalMs: 10000 } })
  const state = { pulled: 0, cancelled: false }
  const body = new ReadableStream({
    async pull(controller) { await sleep(5); state.pulled += 1; controller.enqueue(new Uint8Array(0)) },
    cancel() { state.cancelled = true },
  }, { highWaterMark: 0 })
  const started = Date.now()
  const res = await h.call('PUT', `/_vault/blob/${'c'.repeat(64)}`, { body })
  assert.equal(res.status, 408)
  assert.equal(res.json.code, 'REQUEST_BODY_TIMEOUT')
  assert.ok(Date.now() - started < 1500, `answered after ${Date.now() - started} ms`)
  assert.ok(state.pulled >= 2, 'empty chunks were delivered')
  assert.equal(h.bucket.calls.length, 0)
  assert.equal(h.budget.calls.length, 0)
})

test(`MUST 1: a flood of empty chunks with no wait ends in 408 after ${EMPTY_READS_MAX} empty reads, long before the deadlines`, async () => {
  const h = harness({ deadlines: { idleMs: 20000, totalMs: 60000 } })
  const state = { pulled: 0 }
  const body = new ReadableStream({ pull(controller) { state.pulled += 1; controller.enqueue(new Uint8Array(0)) } }, { highWaterMark: 0 })
  const started = Date.now()
  const res = await h.call('PUT', `/_vault/rescue/${'d'.repeat(32)}`, { body })
  assert.equal(res.status, 408)
  assert.equal(res.json.code, 'REQUEST_BODY_TIMEOUT')
  assert.ok(Date.now() - started < 5000)
  assert.ok(state.pulled <= EMPTY_READS_MAX + 4, `pulled ${state.pulled}`)
  assert.equal(h.bucket.calls.length, 0)
})

test('MUST 1: a content-length sizes the buffer; more bytes than it says is 400, more than the limit 413, fewer 400', async () => {
  const h = harness()
  const over = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(6)); c.close() } })
  const a = await h.call('PUT', `/_vault/blob/${'e'.repeat(64)}`, { body: over, headers: { 'content-length': '4' } })
  assert.deepEqual([a.status, a.json.code], [400, 'VAULT_REQUEST_INVALID'])
  const big = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(SMALL + 1)); c.close() } })
  const b = await h.call('PUT', `/_vault/blob/${'e'.repeat(64)}`, { body: big, headers: { 'content-length': '4' } })
  assert.deepEqual([b.status, b.json.code], [413, 'PART_TOO_LARGE'])
  const short = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2)); c.close() } })
  const s = await h.call('PUT', `/_vault/blob/${'e'.repeat(64)}`, { body: short, headers: { 'content-length': '4' } })
  assert.deepEqual([s.status, s.json.code], [400, 'VAULT_REQUEST_INVALID'])
  const bytes = enc.encode('four')
  const exact = await h.call('PUT', `/_vault/blob/${await sha256Hex(bytes)}`, { body: bytes, headers: { 'content-length': '4' } })
  assert.equal(exact.status, 201)
  assert.equal(putOps(h.bucket).length, 1)
})

test('review: a request body whose read errors mid-stream is still 408 REQUEST_BODY_TIMEOUT (as before), for a piece and an index; a chunk that is not bytes is 400', async () => {
  const h = harness()
  const erroring = () => {
    let sent = false
    return new ReadableStream({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new Uint8Array([1])); return }
        controller.error(new Error('connection reset'))
      },
    }, { highWaterMark: 0 })
  }
  const piece = await h.call('PUT', `/_vault/blob/${'f'.repeat(64)}`, { body: erroring() })
  assert.deepEqual([piece.status, piece.json.code], [408, 'REQUEST_BODY_TIMEOUT'])
  const index = await h.call('PUT', `/_vault/rescue/${'f'.repeat(32)}`, { body: erroring() })
  assert.deepEqual([index.status, index.json.code], [408, 'REQUEST_BODY_TIMEOUT'])
  const notBytes = new ReadableStream({ start(c) { c.enqueue('not bytes'); c.close() } })
  const odd = await h.call('PUT', `/_vault/blob/${'f'.repeat(64)}`, { body: notBytes })
  assert.deepEqual([odd.status, odd.json.code], [400, 'VAULT_REQUEST_INVALID'])
  assert.equal(h.bucket.calls.length, 0)
  assert.equal(h.budget.calls.length, 0)
})

// ---------------------------------------------------------------- MUST 2: a GET's body has a deadline

/** A bucket whose stored objects answer `get` with the given body instead of their bytes. */
function bucketWithBody(makeBody) {
  const bucket = createVaultBucket()
  bucket.intercept.get = async key => {
    const entry = bucket.objects.get(key)
    if (!entry) return null
    return { override: { key, size: entry.bytes.byteLength, customMetadata: {}, body: makeBody(entry.bytes) } }
  }
  return bucket
}

test('MUST 2: a stored piece whose body delivers one byte and stalls is 503 ARCHIVE_UNAVAILABLE with retry-after, never a 200', async () => {
  const state = { cancelled: false }
  const bucket = bucketWithBody(bytes => new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 1)) }, cancel() { state.cancelled = true } }))
  const h = harness({ bucket, deadlines: { getIdleMs: 50, getTotalMs: 5000 } })
  const bytes = enc.encode('ab')
  const hash = await sha256Hex(bytes)
  assert.equal((await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })).status, 201)
  const started = Date.now()
  const res = await h.call('GET', `/_vault/blob/${hash}`)
  assert.equal(res.status, 503)
  assert.equal(res.json.code, 'ARCHIVE_UNAVAILABLE')
  assert.ok(Number(res.headers.get('retry-after')) >= 1)
  assert.ok(Date.now() - started < 1500)
  assert.equal(state.cancelled, true, 'the stalled body is cancelled')
})

test('MUST 2: a body that ends short of its recorded size, or runs past it, is 503 with retry-after', async () => {
  for (const cut of [bytes => bytes.slice(0, 2), bytes => new Uint8Array([...bytes, 9])]) {
    const bucket = bucketWithBody(bytes => new ReadableStream({ start(c) { c.enqueue(cut(bytes)); c.close() } }))
    const h = harness({ bucket })
    const bytes = enc.encode('abcd')
    const hash = await sha256Hex(bytes)
    await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
    const res = await h.call('GET', `/_vault/blob/${hash}`)
    assert.equal(res.status, 503)
    assert.equal(res.json.code, 'ARCHIVE_UNAVAILABLE')
    assert.ok(res.headers.has('retry-after'))
  }
})

test('MUST 2: a slow body that keeps delivering in time answers 200 with every byte and a correct content-length', async () => {
  const bucket = bucketWithBody(bytes => {
    let at = 0
    return new ReadableStream({ async pull(c) { await sleep(15); if (at >= bytes.byteLength) { c.close(); return } c.enqueue(bytes.slice(at, at + 3)); at += 3 } }, { highWaterMark: 0 })
  })
  const h = harness({ bucket, deadlines: { getIdleMs: 200, getTotalMs: 5000 } })
  const bytes = enc.encode('slow but steady')
  const hash = await sha256Hex(bytes)
  await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  const res = await h.call('GET', `/_vault/blob/${hash}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-length'), String(bytes.byteLength))
  assert.deepEqual(res.bytes, bytes)
})

test('MUST 2: the same holds for a rescue index: a stalled body is 503, a slow one is the exact bytes', async () => {
  const rescue = await make(1)
  const stalled = bucketWithBody(bytes => new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 5)) } }))
  const s = harness({ bucket: stalled, deadlines: { getIdleMs: 50 } })
  assert.equal((await storeRescue(s, rescue)).status, 201)
  const res = await s.call('GET', `/_vault/rescue/${rescue.id}`)
  assert.deepEqual([res.status, res.json.code], [503, 'ARCHIVE_UNAVAILABLE'])
  assert.ok(res.headers.has('retry-after'))
  const slow = bucketWithBody(bytes => {
    let at = 0
    return new ReadableStream({ async pull(c) { await sleep(2); if (at >= bytes.byteLength) { c.close(); return } c.enqueue(bytes.slice(at, at + 64)); at += 64 } }, { highWaterMark: 0 })
  })
  const w = harness({ bucket: slow, deadlines: { getIdleMs: 500, getTotalMs: 5000 } })
  await storeRescue(w, rescue)
  const ok = await w.call('GET', `/_vault/rescue/${rescue.id}`)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-length'), String(rescue.indexBytes.byteLength))
  assert.deepEqual(ok.bytes, rescue.indexBytes)
})

// ---------------------------------------------------------------- MUST 3: the verified cap holds at publication

test('MUST 3: with maxRescues 1, two pending indexes: the first publishes, the second is 507 RESCUE_LIMIT and keeps its index and pieces', async () => {
  const h = harness({ limits: { piece: SMALL, maxRescues: 1 } })
  const one = await make(1)
  const two = await make(2)
  assert.equal((await storeRescue(h, one)).status, 201)
  assert.equal((await storeRescue(h, two)).status, 201)
  assert.equal((await verifyAll(h, one.id)).json.done, true)
  const refused = await verifyAll(h, two.id)
  assert.equal(refused.status, 507)
  assert.deepEqual(refused.json, { ok: false, code: 'RESCUE_LIMIT', var: 'VAULT_MAX_RESCUES', limit: 1 })
  assert.deepEqual(manifests(h.bucket), [`w/${WORLD}/rescue/${one.id}/manifest.json`])
  assert.ok(h.bucket.objects.has(`w/${WORLD}/rescue/${two.id}/pending.json`))
  for (const hash of two.pieces.keys()) assert.ok(h.bucket.objects.has(`w/${WORLD}/blob/${hash}`))
  // Asked again it is refused again; the published one still answers done.
  assert.equal((await verifyAll(h, two.id)).status, 507)
  assert.equal((await verifyAll(h, one.id)).json.done, true)
  const listed = await h.call('GET', '/_vault/rescue')
  assert.deepEqual(listed.json.rescues.map(r => [r.id, r.verifiedAt !== null]).sort(), [[one.id, true], [two.id, false]].sort())
})

test('MUST 3: at defaults 33 pending rescues: 32 publish and the 33rd is 507 naming VAULT_MAX_RESCUES', async () => {
  const h = harness()
  const all = []
  for (let n = 0; n < 33; n += 1) { const r = await make(n); all.push(r); assert.equal((await storeRescue(h, r)).status, 201) }
  for (let n = 0; n < 32; n += 1) assert.equal((await verifyAll(h, all[n].id)).json.done, true, `rescue ${n}`)
  const last = await verifyAll(h, all[32].id)
  assert.deepEqual([last.status, last.json.var, last.json.limit], [507, 'VAULT_MAX_RESCUES', 32])
  assert.equal(manifests(h.bucket).length, 32)
})

test('MUST 3: two publications at the same moment against a cap of 1 give exactly one manifest', async () => {
  const bucket = createVaultBucket()
  const h = harness({ bucket, limits: { piece: SMALL, maxRescues: 1 } })
  const one = await make(1)
  const two = await make(2)
  await storeRescue(h, one)
  await storeRescue(h, two)
  // Both listings of the slots are taken before either claim is written.
  bucket.intercept.list = staleList(bucket)
  const [a, b] = await Promise.all([h.call('POST', `/_vault/rescue/${one.id}/verify?cursor=0`), h.call('POST', `/_vault/rescue/${two.id}/verify?cursor=0`)])
  delete bucket.intercept.list
  assert.deepEqual([a.status, b.status].sort(), [200, 507])
  assert.equal(manifests(bucket).length, 1)
  assert.ok(bucket.stats.refusedByCondition >= 1, 'the losing claim was refused by if-none-match')
  const winner = a.status === 200 ? one : two
  assert.deepEqual(manifests(bucket), [`w/${WORLD}/rescue/${winner.id}/manifest.json`])
})

test('MUST 3: the same rescue published twice at once takes ONE slot; a manifest write that failed is finished by the next call on that slot', async () => {
  const bucket = createVaultBucket()
  const h = harness({ bucket, limits: { piece: SMALL, maxRescues: 2 } })
  const one = await make(1)
  const two = await make(2)
  await storeRescue(h, one)
  await storeRescue(h, two)
  bucket.intercept.list = staleList(bucket)
  const both = await Promise.all([h.call('POST', `/_vault/rescue/${one.id}/verify?cursor=0`), h.call('POST', `/_vault/rescue/${one.id}/verify?cursor=0`)])
  delete bucket.intercept.list
  assert.deepEqual(both.map(r => [r.status, r.json.done]), [[200, true], [200, true]])
  const slots = [...bucket.objects.keys()].filter(k => k.startsWith(`w/${WORLD}/rescue-slot/`))
  assert.equal(slots.length, 1, slots.join())
  // The second rescue's manifest write fails once: it holds a slot and no manifest; the next call publishes on it.
  let failed = false
  bucket.intercept.put = key => { if (key.endsWith(`${two.id}/manifest.json`) && !failed) { failed = true; throw new Error('r2 down') } }
  assert.equal((await h.call('POST', `/_vault/rescue/${two.id}/verify?cursor=0`)).status, 503)
  delete bucket.intercept.put
  assert.equal((await verifyAll(h, two.id)).json.done, true)
  assert.equal([...bucket.objects.keys()].filter(k => k.startsWith(`w/${WORLD}/rescue-slot/`)).length, 2)
  assert.equal(manifests(bucket).length, 2)
})

// ---------------------------------------------------------------- SHOULD: the budget is reserved before a put

test('SHOULD: ten concurrent one-byte uploads against a one-byte allowance store exactly one', async () => {
  for (const limits of [{ totalBytes: 1 }, { blobDayBytes: 1 }]) {
    const budget = createVaultBudget({ limits, now: () => NOW })
    const h = harness({ budget })
    const pieces = await Promise.all(Array.from({ length: 10 }, async (_, i) => { const bytes = new Uint8Array([i]); return { bytes, hash: await sha256Hex(bytes) } }))
    const answers = await Promise.all(pieces.map(p => h.call('PUT', `/_vault/blob/${p.hash}`, { body: p.bytes })))
    assert.equal(answers.filter(a => a.status === 201).length, 1, answers.map(a => a.status).join())
    assert.ok(answers.every(a => a.status === 201 || a.status === 507 || a.status === 429))
    assert.equal(putOps(h.bucket).length, 1)
    assert.equal(budget.storage.snapshot()[WORLD_BUDGET_KEY].totalBytes, 1)
  }
})

test('SHOULD: a put that fails and is not there afterwards releases its reservation; a late (timed-out) put keeps it and a retry charges nothing new', async () => {
  const budget = createVaultBudget({ now: () => NOW })
  const bucket = createVaultBucket({ intercept: { put: () => { throw new Error('r2 down') } } })
  const h = harness({ bucket, budget })
  const bytes = enc.encode('fails, gone')
  const hash = await sha256Hex(bytes)
  const res = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.deepEqual([res.status, res.json.code], [503, 'ARCHIVE_UNAVAILABLE'])
  assert.deepEqual(budget.calls.map(c => c.op), ['charge', 'release'])
  assert.equal(budget.storage.snapshot()[WORLD_BUDGET_KEY].totalBytes, 0)
  assert.equal(budget.storage.snapshot()[worldBudgetRefKey('blob', hash)], undefined)

  const lateBudget = createVaultBudget({ now: () => NOW })
  const slow = createVaultBucket()
  slow.intercept.put = () => sleep(60)
  const l = harness({ bucket: slow, budget: lateBudget, deadlines: { r2Ms: 20 } })
  const late = await l.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.equal(late.status, 503)
  assert.deepEqual(lateBudget.calls.map(c => c.op), ['charge'])
  assert.equal(lateBudget.storage.snapshot()[WORLD_BUDGET_KEY].totalBytes, bytes.byteLength, 'kept: the put may still land')
  await sleep(80)
  delete slow.intercept.put
  // The late put landed meanwhile: the retry finds it and settles the reservation without a second charge.
  const again = await l.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.deepEqual([again.status, again.json.stored], [200, false])
  assert.equal(lateBudget.storage.snapshot()[WORLD_BUDGET_KEY].totalBytes, bytes.byteLength)
  assert.equal(lateBudget.storage.snapshot()[worldBudgetRefKey('blob', hash)].state, 'stored')
})

test('SHOULD: a piece stored with no count (its reservation released meanwhile) is found again and counted once by the next PUT of it', async () => {
  const budget = createVaultBudget({ now: () => NOW })
  const h = harness({ budget })
  const bytes = enc.encode('found again')
  const hash = await sha256Hex(bytes)
  // Stored behind the vault's back, the way a late put after a release would leave it: in the bucket, counted nowhere.
  await h.bucket.put(`w/${WORLD}/blob/${hash}`, bytes, { onlyIf: new Headers({ 'if-none-match': '*' }) })
  const res = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.deepEqual([res.status, res.json], [200, { ok: true, stored: false }])
  assert.equal(budget.storage.snapshot()[WORLD_BUDGET_KEY].totalBytes, bytes.byteLength)
  await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.equal(budget.storage.snapshot()[WORLD_BUDGET_KEY].totalBytes, bytes.byteLength, 'never twice')
})

test('world budget refs: charge is once per ref, count settles, release frees only a reservation still unsettled', async () => {
  const storage = createRollbackStorage()
  const ref = 'a'.repeat(64)
  const now = Date.UTC(2026, 10, 12, 12, 0, 0)
  const limits = { totalBytes: 100, blobDayBytes: 100 }
  const total = () => storage.snapshot()[WORLD_BUDGET_KEY].totalBytes
  assert.deepEqual(await worldBudgetCall(storage, { op: 'charge', kind: 'blob', bytes: 60, ref, now, limits }), { ok: true })
  assert.deepEqual(await worldBudgetCall(storage, { op: 'charge', kind: 'blob', bytes: 60, ref, now, limits }), { ok: true })
  assert.equal(total(), 60)
  assert.equal((await worldBudgetCall(storage, { op: 'charge', kind: 'blob', bytes: 60, ref: 'b'.repeat(64), now, limits })).code, 'WORLD_FULL')
  assert.deepEqual(await worldBudgetCall(storage, { op: 'release', kind: 'blob', bytes: 60, ref, now, limits }), { ok: true })
  assert.equal(total(), 0)
  assert.equal(storage.snapshot()[WORLD_BUDGET_KEY].dayBytes.blob, 0)
  await worldBudgetCall(storage, { op: 'charge', kind: 'blob', bytes: 60, ref, now, limits })
  await worldBudgetCall(storage, { op: 'count', kind: 'blob', bytes: 60, ref, now, limits })
  await worldBudgetCall(storage, { op: 'count', kind: 'blob', bytes: 60, ref, now, limits })
  assert.equal(total(), 60)
  await worldBudgetCall(storage, { op: 'release', kind: 'blob', bytes: 60, ref, now, limits })
  assert.equal(total(), 60, 'a settled piece is never released')
  // A count for a ref never charged counts once (found again), and never refuses.
  await worldBudgetCall(storage, { op: 'count', kind: 'blob', bytes: 70, ref: 'c'.repeat(64), now, limits })
  await worldBudgetCall(storage, { op: 'count', kind: 'blob', bytes: 70, ref: 'c'.repeat(64), now, limits })
  assert.equal(total(), 130)
  // A release on a later day takes the bytes off the total only.
  const ref2 = 'd'.repeat(64)
  const roomy = { totalBytes: 1000, blobDayBytes: 1000 }
  await worldBudgetCall(storage, { op: 'charge', kind: 'blob', bytes: 5, ref: ref2, now, limits: roomy })
  const tomorrow = now + 24 * 60 * 60 * 1000
  await worldBudgetCall(storage, { op: 'release', kind: 'blob', bytes: 5, ref: ref2, now: tomorrow, limits: roomy })
  assert.deepEqual(storage.snapshot()[WORLD_BUDGET_KEY], { day: '2026-11-13', dayBytes: { blob: 0, lines: 0 }, totalBytes: 130 })
  await assert.rejects(worldBudgetCall(storage, { op: 'release', kind: 'blob', bytes: 1, now, limits }), /WORLD_BUDGET_REF_INVALID/)
  await assert.rejects(worldBudgetCall(storage, { op: 'charge', kind: 'blob', bytes: 1, ref: 'XYZ', now, limits }), /WORLD_BUDGET_REF_INVALID/)
})

// ----------------------------------------------------------------

test('SHOULD 3 accounting: a charge whose ANSWER is lost (it reserved at MIRROR, the vault never heard) is released by its ref; no put, nothing left reserved', async () => {
  const real = createVaultBudget({ now: () => NOW })
  const ops = []
  // The charge lands (the reservation is written), then its answer never arrives.
  const lost = { ...real, charge: async input => { ops.push('charge'); await real.charge(input); return new Promise(() => {}) },
    release: async input => { ops.push('release'); return real.release(input) }, count: async input => { ops.push('count'); return real.count(input) } }
  const h = harness({ budget: lost, deadlines: { budgetMs: 20 } })
  const bytes = enc.encode('lost answer'), hash = await sha256Hex(bytes)
  const res = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.deepEqual([res.status, res.json.code], [503, 'BUDGET_UNAVAILABLE'])
  assert.deepEqual(ops, ['charge', 'release'])
  assert.equal(putOps(h.bucket).length, 0, 'no put follows a lost charge')
  const rows = real.storage.snapshot()
  assert.equal(rows[WORLD_BUDGET_KEY].totalBytes, 0, 'released: nothing stays charged for a piece that was never put')
  assert.equal(rows[worldBudgetRefKey('blob', hash)], undefined, 'its ref row is gone')
  // A charge that never landed at all: the release finds no ref and changes nothing (a no-op, not an error).
  const never = createVaultBudget({ now: () => NOW })
  const h2 = harness({ budget: { ...never, charge: async () => { throw new Error('mirror never got it') } } })
  assert.equal((await h2.call('PUT', `/_vault/blob/${hash}`, { body: bytes })).status, 503)
  assert.deepEqual(never.calls.map(call => call.op), ['release'])
  assert.equal(never.storage.snapshot()[WORLD_BUDGET_KEY], undefined, 'nothing was ever written')
})

test('SHOULD 3 accounting: the bound that remains, shown exactly: a charge that lands AFTER its release reserves |P| with no object, and only a later PUT of the same piece settles it (no second charge)', async () => {
  const real = createVaultBudget({ now: () => NOW })
  let late = null
  // The first charge is slow on the wire: it reaches MIRROR only after the vault gave up AND released (a no-op then).
  const slow = { ...real, charge: async input => {
    if (late === null) { late = new Promise(resolve => setTimeout(resolve, 60)).then(() => real.charge(input)); return new Promise(() => {}) }
    return real.charge(input)
  } }
  const h = harness({ budget: slow, deadlines: { budgetMs: 20 } })
  const bytes = enc.encode('a late charge'), hash = await sha256Hex(bytes)
  assert.equal((await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })).status, 503)
  await late
  const row = () => real.storage.snapshot()[WORLD_BUDGET_KEY].totalBytes
  assert.equal(row(), bytes.length, 'drift: the row shows |P| more than is stored')
  assert.equal(real.storage.snapshot()[worldBudgetRefKey('blob', hash)].state, 'reserved')
  assert.equal(putOps(h.bucket).length, 0)
  // The kit's retry of the same piece: its charge finds the ref reserved (counts nothing), the put stores, the count settles.
  const again = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.equal(again.status, 201)
  assert.equal(row(), bytes.length, 'the row equals what is stored again')
  assert.equal(real.storage.snapshot()[worldBudgetRefKey('blob', hash)].state, 'stored')
  assert.deepEqual(real.calls.map(call => call.op), ['release', 'charge', 'charge', 'count'])
})

test('M2 (vault side): an R2 listing that is not a list is a FAILED listing (503), never an empty one that would undercount the rescue caps', async () => {
  for (const override of [null, {}, { objects: null, truncated: false }, { truncated: false }]) {
    const bucket = createVaultBucket({ intercept: { list: () => ({ override }) } })
    const h = harness({ bucket })
    const listed = await h.call('GET', '/_vault/rescue')
    assert.deepEqual([listed.status, listed.json.code], [503, 'ARCHIVE_UNAVAILABLE'], JSON.stringify(override))
    const rescue = await buildRescue({ piece: SMALL, rows: [{ key: '/dsh/home/a', type: 'file', bytes: enc.encode('abc') }] })
    for (const [name, bytes] of rescue.pieces) bucket.objects.set(`w/${WORLD}/blob/${name}`, { bytes, customMetadata: {}, httpMetadata: {}, uploaded: new Date(0) })
    const put = await h.call('PUT', `/_vault/rescue/${rescue.id}`, { body: rescue.indexBytes })
    assert.deepEqual([put.status, put.json.code], [503, 'ARCHIVE_UNAVAILABLE'], 'the pending cap is never judged from a failed listing')
    assert.equal(putOps(bucket, key => key.includes('/rescue/')).length, 0)
  }
})

// ---------------------------------------------------------------- whole file (keep last)

test('across this file: no delete, no overwrite, every put conditional, never a throw', () => {
  assert.ok(allVaultBuckets.length > 10)
  for (const bucket of allVaultBuckets) {
    assert.equal(bucket.calls.filter(c => c.op === 'delete').length, 0)
    assert.equal(bucket.stats.overwrites, 0)
    for (const call of bucket.calls.filter(c => c.op === 'put')) {
      assert.ok(call.options.onlyIf instanceof Headers && call.options.onlyIf.get('if-none-match') === '*', call.key)
    }
  }
  assert.deepEqual(thrown, [])
})
