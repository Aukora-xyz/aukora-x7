/** The vault (hash-named pieces and checked rescue indexes) and the world budget it charges. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { handleVaultRequest, PIECE } from '../vault.mjs'
import {
  WORLD_BUDGET_KEY,
  checkWorldBudgetIn,
  chargeWorldBudgetIn,
  countWorldBudgetIn,
  worldBudgetCall,
  worldBudgetLimits,
} from '../world-budget.mjs'
import { allVaultBuckets, buildRescue, createRollbackStorage, createVaultBucket, createVaultBudget, sha256Hex } from './vault-fakes.mjs'

const ORIGIN = 'https://x61.example.invalid'
const WORLD = 'node-main-v1'
const SMALL = 16
const enc = new TextEncoder()

/** Every reply and every throw the handler produced in this file. */
const replies = []
const thrown = []

/**
 * @param {object} [options]
 */
function harness(options = {}) {
  const { bucket = createVaultBucket(), budget = createVaultBudget(), env, limits = { piece: SMALL }, deadlines, now = () => Date.UTC(2026, 10, 12, 13, 0, 0) } = options
  const world = 'world' in options ? options.world : WORLD
  const ready = 'ready' in options ? options.ready : true
  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: BodyInit | null, headers?: Record<string, string>, site?: string | null }} [init]
   */
  const call = async (method, path, { body = null, headers = {}, site = 'same-origin' } = {}) => {
    const url = new URL(path, ORIGIN)
    const h = new Headers(headers)
    if (site !== null) h.set('sec-fetch-site', site)
    const stream = body && typeof body === 'object' && 'getReader' in body
    const request = new Request(url, { method, headers: h, body, ...(stream ? { duplex: 'half' } : {}) })
    let response
    try {
      response = await handleVaultRequest({ request, url, env: env ?? { ARCHIVE_BUCKET: bucket }, world, ready, budget, now, deadlines, limits, log: () => {} })
    } catch (error) {
      thrown.push(error)
      throw error
    }
    assert.ok(response instanceof Response, 'every answer is a Response')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const bytes = new Uint8Array(await response.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    let json = null
    if ((response.headers.get('content-type') ?? '').startsWith('application/json')) {
      try { json = JSON.parse(text) } catch { json = null }
    }
    replies.push({ path, status: response.status, text })
    return { status: response.status, headers: response.headers, bytes, text, json }
  }
  return { bucket, budget, call }
}

const piece = async (text) => { const bytes = enc.encode(text); return { bytes, hash: await sha256Hex(bytes) } }
const putOps = (bucket, pred = () => true) => bucket.calls.filter(c => c.op === 'put' && pred(c.key))
const blobKey = hash => `w/${WORLD}/blob/${hash}`

/** A stream that hands out `chunk` until cancelled, counting what it gave. */
function endless(chunk) {
  const state = { pulled: 0, cancelled: false }
  const stream = new ReadableStream({
    pull(controller) { state.pulled += 1; controller.enqueue(new Uint8Array(chunk)) },
    cancel() { state.cancelled = true },
  }, { highWaterMark: 0 })
  return { stream, state }
}

async function storeRescue(h, rescue) {
  for (const [hash, bytes] of rescue.pieces) {
    const res = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
    assert.ok(res.status === 201 || res.status === 200, `piece stored: ${res.status} ${res.text}`)
  }
  const put = await h.call('PUT', `/_vault/rescue/${rescue.id}`, { body: rescue.indexBytes, headers: { 'content-type': 'application/json' } })
  return put
}

async function verifyAll(h, id) {
  let cursor = 0
  const answers = []
  for (let i = 0; i < 1000; i += 1) {
    const res = await h.call('POST', `/_vault/rescue/${id}/verify?cursor=${cursor}`)
    answers.push(res)
    if (res.status !== 200 || res.json.done) return answers
    cursor = res.json.cursor
  }
  throw new Error('verify never finished')
}

// ---------------------------------------------------------------- blobs

test('a piece whose bytes do not hash to its name is 422 and nothing is stored', async () => {
  const h = harness()
  const { bytes } = await piece('right bytes')
  const wrong = (await piece('other bytes')).hash
  const res = await h.call('PUT', `/_vault/blob/${wrong}`, { body: bytes })
  assert.equal(res.status, 422)
  assert.equal(res.json.code, 'BLOB_HASH_MISMATCH')
  assert.equal(putOps(h.bucket).length, 0)
  assert.equal(h.bucket.objects.size, 0)
  assert.equal(h.budget.calls.length, 0)
})

test('the same piece twice gives 201 then 200, exactly one put, one charge, and the bytes counted once', async () => {
  const h = harness()
  const { bytes, hash } = await piece('one piece')
  const first = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  const second = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.equal(first.status, 201)
  assert.deepEqual(first.json, { ok: true, stored: true })
  assert.equal(second.status, 200)
  assert.deepEqual(second.json, { ok: true, stored: false })
  assert.equal(putOps(h.bucket).length, 1)
  // Charged once before the put; each count after it only settles that reservation (it never adds a second time).
  assert.equal(h.budget.calls.filter(c => c.op === 'charge').length, 1)
  assert.ok(h.budget.calls.every(c => c.ref === hash))
  assert.equal(h.budget.storage.snapshot()[WORLD_BUDGET_KEY].totalBytes, bytes.byteLength)
  const head = await h.call('HEAD', `/_vault/blob/${hash}`)
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(bytes.byteLength))
  const got = await h.call('GET', `/_vault/blob/${hash}`)
  assert.equal(got.status, 200)
  assert.equal(got.headers.get('content-type'), 'application/octet-stream')
  assert.deepEqual(got.bytes, bytes)
  const missing = await h.call('HEAD', `/_vault/blob/${'0'.repeat(64)}`)
  assert.equal(missing.status, 404)
  const missingGet = await h.call('GET', `/_vault/blob/${'0'.repeat(64)}`)
  assert.equal(missingGet.json.code, 'BLOB_UNKNOWN')
})

test('a piece over PIECE is 413 with a content-length, before reading, and nothing is stored', async () => {
  const h = harness()
  const { stream, state } = endless(new Uint8Array(4))
  const res = await h.call('PUT', `/_vault/blob/${'a'.repeat(64)}`, { body: stream, headers: { 'content-length': String(SMALL + 1) } })
  assert.equal(res.status, 413)
  assert.equal(res.json.code, 'PART_TOO_LARGE')
  assert.equal(state.pulled, 0)
  assert.equal(h.bucket.calls.length, 0)
  assert.equal(h.budget.calls.length, 0)
})

test('a piece over PIECE is 413 WITHOUT a content-length, and nothing past the limit is kept', async () => {
  const h = harness()
  const { stream, state } = endless(new Uint8Array(5))
  const res = await h.call('PUT', `/_vault/blob/${'b'.repeat(64)}`, { body: stream })
  assert.equal(res.status, 413)
  assert.equal(res.json.code, 'PART_TOO_LARGE')
  assert.ok(state.pulled <= Math.ceil(SMALL / 5) + 1, `pulled ${state.pulled} chunks`)
  assert.equal(state.cancelled, true)
  assert.equal(h.bucket.calls.length, 0)
  assert.equal(h.budget.calls.length, 0)
  assert.equal(PIECE, 2097152)
})

test('a stalled body answers 408 within the injected idle deadline, and a trickle hits the total deadline', async () => {
  const h = harness({ deadlines: { idleMs: 30, totalMs: 5000 } })
  const stalled = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])) } })
  const started = Date.now()
  const res = await h.call('PUT', `/_vault/blob/${'c'.repeat(64)}`, { body: stalled })
  assert.equal(res.status, 408)
  assert.equal(res.json.code, 'REQUEST_BODY_TIMEOUT')
  assert.ok(Date.now() - started < 1000)
  const t = harness({ deadlines: { idleMs: 1000, totalMs: 40 } })
  const trickle = new ReadableStream({ async pull(controller) { await new Promise(r => setTimeout(r, 10)); controller.enqueue(new Uint8Array([0])) } }, { highWaterMark: 0 })
  const late = await t.call('PUT', `/_vault/rescue/${'d'.repeat(32)}`, { body: trickle })
  assert.equal(late.status, 408)
  assert.equal(h.bucket.calls.length + t.bucket.calls.length, 0)
})

test('budget refusals 507 WORLD_FULL and 429 DAY_ALLOWANCE are returned and nothing is stored', async () => {
  const full = harness({ budget: createVaultBudget({ limits: { totalBytes: 4 } }) })
  const { bytes, hash } = await piece('more than four')
  const a = await full.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.equal(a.status, 507)
  assert.equal(a.json.code, 'WORLD_FULL')
  const now = Date.UTC(2026, 10, 12, 23, 0, 0)
  const day = harness({ budget: createVaultBudget({ limits: { blobDayBytes: 4 }, now: () => now }) })
  const b = await day.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.equal(b.status, 429)
  assert.equal(b.json.code, 'DAY_ALLOWANCE')
  assert.equal(b.json.retryAfterMs, 60 * 60 * 1000)
  assert.equal(b.headers.get('retry-after'), '3600')
  for (const h of [full, day]) {
    assert.equal(putOps(h.bucket).length, 0)
    assert.equal(h.budget.calls.filter(c => c.op === 'count').length, 0)
    assert.equal(h.budget.storage.snapshot()[WORLD_BUDGET_KEY], undefined)
  }
})

test('a put that throws after the charge is 503, count is never called, and the reservation is released (totals unchanged)', async () => {
  const bucket = createVaultBucket({ intercept: { put: () => { throw new Error('r2 down') } } })
  const h = harness({ bucket })
  const { bytes, hash } = await piece('put fails')
  const res = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.equal(res.status, 503)
  assert.equal(res.json.code, 'ARCHIVE_UNAVAILABLE')
  assert.deepEqual(h.budget.calls.map(c => c.op), ['charge', 'release'])
  assert.deepEqual(h.budget.storage.snapshot(), { [WORLD_BUDGET_KEY]: { day: '2026-11-12', dayBytes: { blob: 0, lines: 0 }, totalBytes: 0 } })
})

test('a put that returns null (the key appeared meanwhile) is 200 stored:false and the bytes are counted once, not twice', async () => {
  const bucket = createVaultBucket({ intercept: { put: () => ({ override: null }) } })
  const h = harness({ bucket })
  const { bytes, hash } = await piece('raced')
  const res = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { ok: true, stored: false })
  assert.deepEqual(h.budget.calls.map(c => c.op), ['charge', 'count'])
  assert.equal(h.budget.storage.snapshot()[WORLD_BUDGET_KEY].totalBytes, bytes.byteLength)
})

test('budget.charge that throws is 503 BUDGET_UNAVAILABLE and nothing is put; its own ref is released (the charge may have landed)', async () => {
  const counted = [], released = []
  const budget = { charge: async () => { throw new Error('mirror down') }, count: async input => { counted.push(input) }, release: async input => { released.push(input) } }
  const h = harness({ budget })
  const { bytes, hash } = await piece('no budget')
  const res = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.equal(res.status, 503)
  assert.equal(res.json.code, 'BUDGET_UNAVAILABLE')
  assert.equal(putOps(h.bucket).length, 0)
  assert.equal(counted.length, 0)
  // exactly one release, by this piece's ref (a no-op at MIRROR if the charge never landed).
  assert.deepEqual(released, [{ kind: 'blob', bytes: bytes.length, ref: hash }])
})

test('a count that fails after a stored put still answers 201', async () => {
  const budget = { charge: async () => ({ ok: true }), count: async () => { throw new Error('lost') }, release: async () => { throw new Error('never called') } }
  const h = harness({ budget })
  const { bytes, hash } = await piece('count lost')
  const res = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.equal(res.status, 201)
  assert.equal(h.bucket.objects.has(blobKey(hash)), true)
})

test('a slow head hits the injected R2 deadline: 503', async () => {
  const bucket = createVaultBucket({ intercept: { head: () => new Promise(resolve => setTimeout(() => resolve(null), 45)) } })
  const h = harness({ bucket, deadlines: { r2Ms: 10 } })
  const { bytes, hash } = await piece('slow head')
  const started = Date.now()
  const res = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  assert.equal(res.status, 503)
  assert.equal(res.json.code, 'ARCHIVE_UNAVAILABLE')
  assert.ok(Date.now() - started < 1000)
  assert.equal(h.budget.calls.length, 0)
  assert.equal(putOps(h.bucket).length, 0)
})

test('ready:false is 503 BOOTSTRAP_REQUIRED with zero bucket and zero budget calls', async () => {
  for (const ready of [false, undefined, 'true', 1]) {
    const h = harness({ ready })
    const { bytes, hash } = await piece('not ready')
    for (const [method, path, body] of [['PUT', `/_vault/blob/${hash}`, bytes], ['GET', '/_vault/rescue', null], ['POST', `/_vault/rescue/${'e'.repeat(32)}/verify?cursor=0`, null]]) {
      const res = await h.call(method, path, { body })
      assert.equal(res.status, 503)
      assert.equal(res.json.code, 'BOOTSTRAP_REQUIRED')
    }
    assert.equal(h.bucket.calls.length, 0)
    assert.equal(h.budget.calls.length, 0)
  }
})

// ---------------------------------------------------------------- rescue indexes

test('an index whose id is not the hash of its bytes is 400', async () => {
  const h = harness()
  const rescue = await buildRescue({ piece: SMALL, rows: [{ key: '/dsh/home/a', type: 'file', bytes: enc.encode('hello') }] })
  const wrongId = rescue.id === 'f'.repeat(32) ? 'e'.repeat(32) : 'f'.repeat(32)
  const res = await h.call('PUT', `/_vault/rescue/${wrongId}`, { body: rescue.indexBytes })
  assert.equal(res.status, 400)
  assert.equal(res.json.code, 'VAULT_REQUEST_INVALID')
  assert.equal(putOps(h.bucket).length, 0)
})

test('the same index twice stores one object', async () => {
  const h = harness()
  const rescue = await buildRescue({ piece: SMALL, rows: [{ key: '/dsh/home/a', type: 'file', bytes: enc.encode('hello') }] })
  const a = await h.call('PUT', `/_vault/rescue/${rescue.id}`, { body: rescue.indexBytes })
  const b = await h.call('PUT', `/_vault/rescue/${rescue.id}`, { body: rescue.indexBytes })
  assert.equal(a.status, 201)
  assert.equal(b.status, 200)
  assert.deepEqual(b.json, { ok: true, pending: true })
  assert.equal(putOps(h.bucket, k => k.includes('/rescue/')).length, 1)
})

test('an index naming a missing piece: verify answers 424 and writes no manifest', async () => {
  const h = harness()
  const rescue = await buildRescue({ piece: SMALL, rows: [{ key: '/dsh/home/a', type: 'file', bytes: enc.encode('x'.repeat(40)) }] })
  const [first] = rescue.pieces.keys()
  for (const [hash, bytes] of rescue.pieces) if (hash !== first) await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes })
  await h.call('PUT', `/_vault/rescue/${rescue.id}`, { body: rescue.indexBytes })
  const res = await h.call('POST', `/_vault/rescue/${rescue.id}/verify?cursor=0`)
  assert.equal(res.status, 424)
  assert.equal(res.json.code, 'RESCUE_BLOB_MISSING')
  assert.equal(res.json.sha256, first)
  assert.equal(putOps(h.bucket, k => k.endsWith('manifest.json')).length, 0)
})

test('a piece of the wrong size is 424', async () => {
  const h = harness()
  const real = enc.encode('y'.repeat(20))
  const rescue = await buildRescue({ piece: SMALL, rows: [{ key: '/dsh/home/a', type: 'file', bytes: real }] })
  // The second piece should be 4 bytes; store a 5-byte piece and name it in the index instead.
  const five = enc.encode('zzzzz')
  const fiveHash = await sha256Hex(five)
  const index = structuredClone(rescue.index)
  index.rows[0].pieces[1] = fiveHash
  const indexBytes = enc.encode(JSON.stringify(index))
  const id = (await sha256Hex(indexBytes)).slice(0, 32)
  const [firstHash, firstBytes] = [...rescue.pieces][0]
  await h.call('PUT', `/_vault/blob/${firstHash}`, { body: firstBytes })
  await h.call('PUT', `/_vault/blob/${fiveHash}`, { body: five })
  assert.equal((await h.call('PUT', `/_vault/rescue/${id}`, { body: indexBytes })).status, 201)
  const res = await h.call('POST', `/_vault/rescue/${id}/verify?cursor=0`)
  assert.equal(res.status, 424)
  assert.equal(res.json.sha256, fiveHash)
  assert.equal(putOps(h.bucket, k => k.endsWith('manifest.json')).length, 0)
})

test('a 100-piece index verifies in three calls and the manifest is written once', async () => {
  let clock = Date.UTC(2026, 10, 12, 14, 2, 0)
  const h = harness({ now: () => clock })
  const bytes = new Uint8Array(100 * SMALL)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + Math.floor(i / SMALL)) & 0xff
  const rescue = await buildRescue({ piece: SMALL, rows: [{ key: '/dsh/home/big', type: 'file', bytes }], clientId: 'client-1' })
  assert.equal(rescue.index.rows[0].pieces.length, 100)
  assert.equal((await storeRescue(h, rescue)).status, 201)
  const answers = await verifyAll(h, rescue.id)
  assert.deepEqual(answers.map(a => [a.status, a.json.cursor, a.json.done]), [[200, 40, false], [200, 80, false], [200, 100, true]])
  assert.equal(answers[2].json.verifiedAt, new Date(clock).toISOString())
  const manifestKey = `w/${WORLD}/rescue/${rescue.id}/manifest.json`
  assert.equal(putOps(h.bucket, k => k === manifestKey).length, 1)
  const manifest = JSON.parse(new TextDecoder().decode(h.bucket.objects.get(manifestKey).bytes))
  // `unlisted: null`: this index was built without the kit's record of failed listings (an older kit's index).
  assert.deepEqual(manifest, { verified: true, verifiedAt: new Date(clock).toISOString(), rows: 1, files: 1, bytes: 100 * SMALL, clientId: 'client-1', unlisted: null, indexSha: await sha256Hex(rescue.indexBytes) })
  clock += 60000
  const writesBefore = putOps(h.bucket).length
  const again = await h.call('POST', `/_vault/rescue/${rescue.id}/verify?cursor=0`)
  assert.equal(again.status, 200)
  assert.equal(again.json.done, true)
  assert.equal(again.json.verifiedAt, manifest.verifiedAt)
  assert.equal(putOps(h.bucket).length, writesBefore)
  const listed = await h.call('GET', '/_vault/rescue')
  assert.deepEqual(listed.json, { ok: true, rescues: [{ id: rescue.id, verifiedAt: manifest.verifiedAt, files: 1, bytes: 100 * SMALL, clientId: 'client-1' }] })
})

test('verify with no cursor, an empty one, cursor=abc, or a cursor never given out is 400', async () => {
  const h = harness()
  const bytes = new Uint8Array(50 * SMALL).fill(3)
  bytes[0] = 9
  const rescue = await buildRescue({ piece: SMALL, rows: [{ key: '/dsh/home/f', type: 'file', bytes }] })
  await storeRescue(h, rescue)
  for (const query of ['', '?cursor=', '?cursor=abc', '?cursor=-1', '?cursor=01', '?cursor=0&cursor=0', '?cursor=40', '?cursor=50', '?cursor=51']) {
    const res = await h.call('POST', `/_vault/rescue/${rescue.id}/verify${query}`)
    assert.equal(res.status, 400, `query ${query}`)
    assert.equal(res.json.code, 'VAULT_REQUEST_INVALID')
  }
  const unknown = await h.call('POST', `/_vault/rescue/${'0'.repeat(32)}/verify?cursor=0`)
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.code, 'RESCUE_UNKNOWN')
  assert.equal(putOps(h.bucket, k => k.endsWith('manifest.json')).length, 0)
})

test('after a 424 the SAME cursor goes on once the piece is stored', async () => {
  const h = harness()
  const bytes = new Uint8Array(60 * SMALL)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(i / SMALL)
  const rescue = await buildRescue({ piece: SMALL, rows: [{ key: '/dsh/home/g', type: 'file', bytes }] })
  const names = rescue.index.rows[0].pieces
  const late = names[45]
  for (const [hash, part] of rescue.pieces) if (hash !== late) await h.call('PUT', `/_vault/blob/${hash}`, { body: part })
  await h.call('PUT', `/_vault/rescue/${rescue.id}`, { body: rescue.indexBytes })
  const first = await h.call('POST', `/_vault/rescue/${rescue.id}/verify?cursor=0`)
  assert.deepEqual([first.status, first.json.cursor], [200, 40])
  const missing = await h.call('POST', `/_vault/rescue/${rescue.id}/verify?cursor=40`)
  assert.equal(missing.status, 424)
  assert.equal(missing.json.sha256, late)
  const again = await h.call('POST', `/_vault/rescue/${rescue.id}/verify?cursor=40`)
  assert.equal(again.status, 424)
  await h.call('PUT', `/_vault/blob/${late}`, { body: rescue.pieces.get(late) })
  const done = await h.call('POST', `/_vault/rescue/${rescue.id}/verify?cursor=40`)
  assert.deepEqual([done.status, done.json.cursor, done.json.done], [200, 60, true])
})

test('dir and gone rows by the row rule beside file, meta and local rows are accepted and verify', async () => {
  const h = harness()
  const rescue = await buildRescue({ piece: SMALL, source: 'indexeddb', rows: [
    { key: '/dsh/home', type: 'dir' },
    { key: '/dsh/home/old', type: 'gone' },
    { key: '/dsh/home/a.txt', type: 'file', bytes: enc.encode('a file that spans pieces') },
    { key: '@x6-mirror-meta', type: 'meta', bytes: enc.encode('{"clientId":"c"}') },
    { key: 'localStorage:theme', type: 'local', bytes: enc.encode('dark') },
  ] })
  // Extra row fields (mode, mtimeMs) are neither required nor checked.
  const index = structuredClone(rescue.index)
  index.rows = index.rows.map(row => (row.type === 'file' ? { ...row, mode: 33188, mtimeMs: 1 } : row.type === 'dir' ? { ...row, mode: 16877 } : row))
  const indexBytes = enc.encode(JSON.stringify(index))
  const id = (await sha256Hex(indexBytes)).slice(0, 32)
  for (const [hash, part] of rescue.pieces) await h.call('PUT', `/_vault/blob/${hash}`, { body: part })
  assert.equal((await h.call('PUT', `/_vault/rescue/${id}`, { body: indexBytes })).status, 201)
  const answers = await verifyAll(h, id)
  assert.equal(answers.at(-1).json.done, true)
  assert.equal(answers.at(-1).json.rows, 5)
  assert.equal(answers.at(-1).json.files, 1)
})

test('rows that break the row rule are each 400', async () => {
  const h = harness()
  const base = await buildRescue({ piece: SMALL, rows: [{ key: '/dsh/home/a', type: 'file', bytes: enc.encode('abc') }] })
  const filePiece = base.index.rows[0].pieces[0]
  const bad = [
    { key: '/d', type: 'dir', bytes: 0, sha256: null, pieces: [filePiece] },
    { key: '/g', type: 'gone', bytes: 5, sha256: null, pieces: [] },
    { key: '/f', type: 'file', bytes: 3, sha256: null, pieces: [filePiece] },
    { key: '/f', type: 'file', bytes: 3, sha256: base.index.rows[0].sha256 },
    { key: '/f', type: 'file', bytes: 3, sha256: base.index.rows[0].sha256, pieces: [] },
    { key: '/f', type: 'other', bytes: 0, sha256: null, pieces: [] },
    { key: 7, type: 'dir', bytes: 0, sha256: null, pieces: [] },
  ]
  for (const row of bad) {
    const index = { ...structuredClone(base.index), rows: [row] }
    const bytes = enc.encode(JSON.stringify(index))
    const id = (await sha256Hex(bytes)).slice(0, 32)
    const res = await h.call('PUT', `/_vault/rescue/${id}`, { body: bytes })
    assert.equal(res.status, 400, JSON.stringify(row))
    assert.equal(res.json.code, 'VAULT_REQUEST_INVALID')
  }
  for (const change of [{ v: 2 }, { piece: PIECE }, { source: 'disk' }, { client: { clientId: null } }, { rows: 'x' }, { skipped: null }, { totals: [] }]) {
    const bytes = enc.encode(JSON.stringify({ ...structuredClone(base.index), ...change }))
    const id = (await sha256Hex(bytes)).slice(0, 32)
    assert.equal((await h.call('PUT', `/_vault/rescue/${id}`, { body: bytes })).status, 400, JSON.stringify(change))
  }
  const notJson = enc.encode('{not json')
  assert.equal((await h.call('PUT', `/_vault/rescue/${(await sha256Hex(notJson)).slice(0, 32)}`, { body: notJson })).status, 400)
  assert.equal(putOps(h.bucket, k => k.includes('/rescue/')).length, 0)
})

test('a zero-byte file row (pieces: [], the hash of no bytes) is accepted and verifies', async () => {
  const h = harness()
  const rescue = await buildRescue({ piece: SMALL, rows: [{ key: '/dsh/home/empty', type: 'file', bytes: new Uint8Array(0) }] })
  assert.deepEqual(rescue.index.rows[0].pieces, [])
  assert.equal(rescue.index.rows[0].sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal((await h.call('PUT', `/_vault/rescue/${rescue.id}`, { body: rescue.indexBytes })).status, 201)
  const done = await h.call('POST', `/_vault/rescue/${rescue.id}/verify?cursor=0`)
  assert.deepEqual([done.status, done.json.cursor, done.json.done], [200, 0, true])
})

test('GET of an index returns the exact bytes sent', async () => {
  const h = harness()
  const rescue = await buildRescue({ piece: SMALL, rows: [{ key: '/dsh/home/ü', type: 'file', bytes: enc.encode('bytes, exactly') }] })
  // Spacing a re-serializer would change: the vault never rewrites the bytes.
  const spaced = enc.encode(JSON.stringify(rescue.index, null, 1))
  const id = (await sha256Hex(spaced)).slice(0, 32)
  await h.call('PUT', `/_vault/rescue/${id}`, { body: spaced })
  const got = await h.call('GET', `/_vault/rescue/${id}`)
  assert.equal(got.status, 200)
  assert.deepEqual(got.bytes, spaced)
  const unknown = await h.call('GET', `/_vault/rescue/${'1'.repeat(32)}`)
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.code, 'RESCUE_UNKNOWN')
})

test('32 verified rescues then one more is 507 RESCUE_LIMIT naming VAULT_MAX_RESCUES; 32 unverified do not block', async () => {
  const h = harness()
  const make = n => buildRescue({ piece: SMALL, rows: [{ key: `/dsh/home/n${n}`, type: 'file', bytes: enc.encode(`file number ${n}`) }] })
  for (let n = 0; n < 32; n += 1) {
    const rescue = await make(n)
    assert.equal((await storeRescue(h, rescue)).status, 201)
    assert.equal((await verifyAll(h, rescue.id)).at(-1).json.done, true)
  }
  const extra = await make(99)
  for (const [hash, part] of extra.pieces) await h.call('PUT', `/_vault/blob/${hash}`, { body: part })
  const over = await h.call('PUT', `/_vault/rescue/${extra.id}`, { body: extra.indexBytes })
  assert.equal(over.status, 507)
  assert.deepEqual(over.json, { ok: false, code: 'RESCUE_LIMIT', var: 'VAULT_MAX_RESCUES', limit: 32 })

  const p = harness()
  for (let n = 0; n < 32; n += 1) assert.equal((await storeRescue(p, await make(n))).status, 201)
  const fine = await make(99)
  assert.equal((await storeRescue(p, fine)).status, 201)
  const listed = await p.call('GET', '/_vault/rescue')
  assert.equal(listed.json.rescues.length, 33)
  assert.ok(listed.json.rescues.every(r => r.verifiedAt === null && r.files === 1))

  const q = harness({ limits: { piece: SMALL, maxPending: 2 } })
  for (let n = 0; n < 2; n += 1) await storeRescue(q, await make(n))
  const pend = await storeRescue(q, await make(5))
  assert.deepEqual(pend.json, { ok: false, code: 'RESCUE_LIMIT', var: 'VAULT_MAX_PENDING', limit: 2 })
})

// ---------------------------------------------------------------- refusals

test('no bucket, or one without put, get, head and list, is 503', async () => {
  for (const env of [{}, { ARCHIVE_BUCKET: null }, { ARCHIVE_BUCKET: { put() {}, get() {}, head() {} } }]) {
    const h = harness({ env })
    const res = await h.call('GET', '/_vault/rescue')
    assert.equal(res.status, 503)
    assert.equal(res.json.code, 'ARCHIVE_UNAVAILABLE')
  }
})

test('a bad world name is 503 and touches nothing', async () => {
  for (const world of ['', 'X61', '-a', 'a/b', 'a'.repeat(64), undefined]) {
    const h = harness({ world })
    const res = await h.call('GET', '/_vault/rescue')
    assert.equal(res.status, 503)
    assert.equal(res.json.code, 'ARCHIVE_UNAVAILABLE')
    assert.equal(h.bucket.calls.length, 0)
  }
})

test('a cross-site or unmarked write is 403 and stores nothing', async () => {
  const h = harness()
  const { bytes, hash } = await piece('cross site')
  for (const site of ['cross-site', 'same-site', 'none', null]) {
    const res = await h.call('PUT', `/_vault/blob/${hash}`, { body: bytes, site })
    assert.equal(res.status, 403)
    assert.equal(res.json.code, 'SAME_ORIGIN_BROWSER_REQUIRED')
  }
  const post = await h.call('POST', `/_vault/rescue/${'2'.repeat(32)}/verify?cursor=0`, { site: 'cross-site' })
  assert.equal(post.status, 403)
  assert.equal(h.bucket.calls.length, 0)
  const read = await h.call('GET', '/_vault/rescue', { site: 'cross-site' })
  assert.equal(read.status, 200)
})

test('unknown paths are 404, unlisted methods 405, unlisted queries 404', async () => {
  const h = harness()
  for (const path of ['/_vault', '/_vault/', '/_vault/blob', `/_vault/blob/${'A'.repeat(64)}`, '/_vault/blob/abc', `/_vault/rescue/${'a'.repeat(31)}`,
    `/_vault/rescue/${'a'.repeat(32)}/manifest`, '/_vault/other', `/_vault/blob/${'a'.repeat(64)}/x`]) {
    const res = await h.call('GET', path)
    assert.equal(res.status, 404, path)
    assert.equal(res.json.code, 'NOT_FOUND')
  }
  for (const [method, path] of [['DELETE', `/_vault/blob/${'a'.repeat(64)}`], ['POST', `/_vault/blob/${'a'.repeat(64)}`], ['DELETE', `/_vault/rescue/${'a'.repeat(32)}`],
    ['PUT', '/_vault/rescue'], ['GET', `/_vault/rescue/${'a'.repeat(32)}/verify?cursor=0`]]) {
    const res = await h.call(method, path)
    assert.equal(res.status, 405, `${method} ${path}`)
    assert.equal(res.json.code, 'METHOD_UNAVAILABLE')
  }
  for (const [method, path] of [['GET', `/_vault/blob/${'a'.repeat(64)}?x=1`], ['HEAD', `/_vault/blob/${'a'.repeat(64)}?`], ['GET', '/_vault/rescue?all=1'],
    ['GET', `/_vault/rescue/${'a'.repeat(32)}?cursor=0`], ['POST', `/_vault/rescue/${'a'.repeat(32)}/verify?cursor=0&x=1`]]) {
    const res = await h.call(method, path)
    if (path.endsWith('?')) assert.equal(res.status, 404, `${method} ${path}`) // an empty search is no query: the blob is unknown
    else assert.deepEqual([res.status, res.json.code], [404, 'NOT_FOUND'], `${method} ${path}`)
  }
  assert.equal(h.bucket.calls.filter(c => c.op === 'delete').length, 0)
})

test('the handler answers garbage input with a Response, never a throw', async () => {
  const notReady = await handleVaultRequest(/** @type {any} */ ({}))
  assert.equal(notReady.status, 503)
  const broken = await handleVaultRequest(/** @type {any} */ ({ ready: true, world: WORLD, env: { ARCHIVE_BUCKET: createVaultBucket() }, request: null, url: null, log: () => {} }))
  assert.equal(broken.status, 503)
  assert.equal(broken.headers.get('cache-control'), 'no-store')
  const noArgs = await handleVaultRequest(/** @type {any} */ (undefined))
  assert.equal(noArgs.status, 503)
})

// ---------------------------------------------------------------- world budget

const KEY = WORLD_BUDGET_KEY

test('world budget: the day rolls over by itself and the total stays', async () => {
  const storage = createRollbackStorage()
  const day1 = Date.UTC(2026, 10, 12, 23, 59, 0)
  const day2 = Date.UTC(2026, 10, 13, 0, 1, 0)
  const limits = { blobDayBytes: 100, totalBytes: 1000 }
  assert.deepEqual(await worldBudgetCall(storage, { op: 'charge', kind: 'blob', bytes: 100, now: day1, limits }), { ok: true })
  assert.equal((await worldBudgetCall(storage, { op: 'check', kind: 'blob', bytes: 1, now: day1, limits })).code, 'DAY_ALLOWANCE')
  assert.deepEqual(await worldBudgetCall(storage, { op: 'charge', kind: 'blob', bytes: 100, now: day2, limits }), { ok: true })
  assert.deepEqual(storage.snapshot()[KEY], { day: '2026-11-13', dayBytes: { blob: 100, lines: 0 }, totalBytes: 200 })
})

test('world budget: one total covers both kinds, and each kind has its own day cap', async () => {
  const storage = createRollbackStorage()
  const now = Date.UTC(2026, 10, 12, 12, 0, 0)
  const limits = { totalBytes: 300, blobDayBytes: 200, linesDayBytes: 150 }
  assert.equal((await worldBudgetCall(storage, { op: 'charge', kind: 'blob', bytes: 200, now, limits })).ok, true)
  const blobOver = await worldBudgetCall(storage, { op: 'charge', kind: 'blob', bytes: 1, now, limits })
  assert.equal(blobOver.code, 'DAY_ALLOWANCE')
  assert.equal(blobOver.status, 429)
  assert.equal((await worldBudgetCall(storage, { op: 'charge', kind: 'lines', bytes: 100, now, limits })).ok, true)
  const full = await worldBudgetCall(storage, { op: 'charge', kind: 'lines', bytes: 1, now, limits })
  assert.deepEqual(full, { ok: false, code: 'WORLD_FULL', status: 507 })
  const linesStorage = createRollbackStorage()
  assert.equal((await worldBudgetCall(linesStorage, { op: 'charge', kind: 'lines', bytes: 150, now, limits: { linesDayBytes: 150 } })).ok, true)
  assert.equal((await worldBudgetCall(linesStorage, { op: 'charge', kind: 'lines', bytes: 1, now, limits: { linesDayBytes: 150 } })).code, 'DAY_ALLOWANCE')
  assert.equal((await worldBudgetCall(linesStorage, { op: 'charge', kind: 'blob', bytes: 1, now, limits: { linesDayBytes: 150 } })).ok, true)
  // count never refuses, even past the total.
  assert.deepEqual(await worldBudgetCall(storage, { op: 'count', kind: 'blob', bytes: 500, now, limits }), { ok: true })
  assert.equal(storage.snapshot()[KEY].totalBytes, 800)
  await assert.rejects(worldBudgetCall(storage, { op: 'drop', kind: 'blob', bytes: 1, now, limits }))
  await assert.rejects(worldBudgetCall(storage, { op: 'check', kind: 'other', bytes: 1, now, limits }))
  await assert.rejects(worldBudgetCall(storage, { op: 'check', kind: 'blob', bytes: -1, now, limits }))
})

test('world budget: retryAfterMs runs to the next UTC midnight', async () => {
  const storage = createRollbackStorage()
  const now = Date.UTC(2026, 10, 12, 21, 30, 15)
  const refusal = await worldBudgetCall(storage, { op: 'check', kind: 'lines', bytes: 11, now, limits: { linesDayBytes: 10 } })
  assert.deepEqual(refusal, { ok: false, code: 'DAY_ALLOWANCE', status: 429, retryAfterMs: Date.UTC(2026, 10, 13) - now })
})

test('world budget: limits from env ignore anything not a positive safe integer', () => {
  assert.deepEqual(worldBudgetLimits({ VAULT_MAX_BYTES: '1000', VAULT_DAY_BYTES: '500', THREAD_DAY_BYTES: '20' }), { totalBytes: 1000, blobDayBytes: 500, linesDayBytes: 20 })
  const defaults = { totalBytes: 2 * 1024 ** 3, blobDayBytes: 1024 ** 3, linesDayBytes: 128 * 1024 ** 2 }
  for (const bad of ['0', '-5', '1.5', '1e9', ' 10', '', 'abc', '99999999999999999', 12, null]) {
    assert.deepEqual(worldBudgetLimits({ VAULT_MAX_BYTES: bad, VAULT_DAY_BYTES: bad, THREAD_DAY_BYTES: bad }), defaults, String(bad))
  }
  assert.deepEqual(worldBudgetLimits(undefined), defaults)
})

test('world budget: a charge whose transaction then throws leaves the row unchanged', async () => {
  const storage = createRollbackStorage()
  const now = Date.UTC(2026, 10, 12, 10, 0, 0)
  await worldBudgetCall(storage, { op: 'count', kind: 'lines', bytes: 7, now })
  const before = storage.snapshot()
  await assert.rejects(storage.transaction(async tx => {
    assert.deepEqual(await chargeWorldBudgetIn(tx, { kind: 'lines', bytes: 50, now }), { ok: true })
    throw new Error('append failed after the charge')
  }), /append failed/)
  assert.deepEqual(storage.snapshot(), before)
  const refusedTx = createRollbackStorage()
  await refusedTx.transaction(async tx => {
    assert.equal((await chargeWorldBudgetIn(tx, { kind: 'blob', bytes: 5, now, limits: { blobDayBytes: 4 } })).code, 'DAY_ALLOWANCE')
    assert.deepEqual(await checkWorldBudgetIn(tx, { kind: 'blob', bytes: 4, now, limits: { blobDayBytes: 4 } }), { ok: true })
  })
  assert.deepEqual(refusedTx.snapshot(), {})
})

test('world budget: the In forms never open a transaction; worldBudgetCall opens exactly one', async () => {
  for (const fn of [checkWorldBudgetIn, chargeWorldBudgetIn, countWorldBudgetIn]) {
    assert.equal(fn.toString().includes('transaction('), false, fn.name)
    assert.equal(fn.length, 2)
  }
  const storage = createRollbackStorage()
  for (const op of ['check', 'charge', 'count']) {
    const before = storage.transactions()
    await worldBudgetCall(storage, { op, kind: 'blob', bytes: 1, now: Date.UTC(2026, 10, 12) })
    assert.equal(storage.transactions() - before, 1, op)
  }
  const tx = { get: async () => ({ day: 'x', dayBytes: { blob: -1, lines: 0 }, totalBytes: 0 }), put: async () => {} }
  await assert.rejects(checkWorldBudgetIn(tx, { kind: 'blob', bytes: 1, now: 0 }), /WORLD_BUDGET_ROW_INVALID/)
})

// ---------------------------------------------------------------- whole suite (keep last)

test('across the whole suite: no delete, no second write to any key, no conflictCode, never a throw', () => {
  assert.ok(allVaultBuckets.length > 10)
  for (const bucket of allVaultBuckets) {
    assert.equal(bucket.calls.filter(c => c.op === 'delete').length, 0)
    assert.equal(bucket.stats.overwrites, 0)
    assert.equal(bucket.stats.refusedByCondition, 0)
    for (const [key, count] of bucket.writes) assert.equal(count, 1, key)
    for (const call of bucket.calls.filter(c => c.op === 'put')) {
      assert.ok(call.options.onlyIf instanceof Headers && call.options.onlyIf.get('if-none-match') === '*', call.key)
    }
  }
  assert.ok(replies.length > 100)
  for (const reply of replies) assert.equal(reply.text.includes('conflictCode'), false, reply.path)
  assert.deepEqual(thrown, [])
})
