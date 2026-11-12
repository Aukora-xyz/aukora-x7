/**
 * The seam between the rescue kit and the vault: the REAL `rescueKit` against the REAL
 * `handleVaultRequest`, no fake of either side. Only the outsides are fakes, each from its own suite: the in-memory
 * IndexedDB and localStorage (rescue-fakes.mjs) and the in-memory bucket and world budget (vault-fakes.mjs).
 * `createVaultFetch` hands each kit call to the real handler as a same-origin browser request.
 *
 * A second part adds the same seam THROUGH THE WORKER (`edge()` below): the real `createWorker` routes each kit call (owner gate,
 * fetch-site rules, ready check, pass-through body) to the real vault, whose world budget is the real MirrorDO's internal
 * `/_mirror/world/budget` route over an in-memory Durable Object storage. HEAD is a stand-in that answers only its
 * bootstrap status. And the outside reviewer's six MUSTs and four SHOULDs on this joined tree.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'
import { rescueKit } from '../rescue-kit.mjs'
import { PIECE as VAULT_PIECE, VERIFY_STEP, VAULT_DEFAULT_DEADLINES } from '../vault.mjs'
import { createWorker } from '../worker.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { FakeIndexedDb, FakeLocalStorage, fileEntry, dirEntry, goneEntry } from './rescue-fakes.mjs'
import { buildRescue, createVaultBucket, createVaultBudget, createVaultFetch } from './vault-fakes.mjs'

const DB = 'aukora-x6-vfs'
const WORLD = 'node-main-v1'
const MAIN = '/dsh/home/sessions/agent/main/session.v3.jsonl'
const SMALL = '/dsh/home/auma/session/messages.jsonl'
const NOTES = '/dsh/home/auma/notes.md'
const T_NEWEST = new Date(2026, 10, 12, 13, 58, 30).getTime()
const T_CHECK = new Date(2026, 10, 12, 14, 2, 10).getTime()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const enc = new TextEncoder()
const LOG = 'aukora-auma-live-log-v2:session-0e3e8d80'
const LOG_VALUE = JSON.stringify([{ role: 'you', text: 'what he said aloud', ts: 1 }, { role: 'auma', text: 'her answer', ts: 2 }])
const LOGS_STAY = 'Auma Live chat logs were copied. Other saved settings stay in this browser.'
const LOGS_ALL = 'Auma Live chat logs were copied. Other saved settings were copied too, except names that look secret.'
const headline = (bytes, mainBytes) => 'Rescue copy complete and checked: 2 threads, 2 home files, ' + Math.round(bytes / 1e6) + ' MB; main thread: '
  + mainBytes + ' bytes, saved 13:58; newest save of any thread: 13:58; checked 14:02'

/** Her store as idb-persist leaves it: file, dir, gone and meta rows, one secret beside them. */
function storeEntries(mainBytes, extra = []) {
  return [
    ['/dsh/home', dirEntry()], ['/dsh/home/auma', dirEntry()], ['/dsh/home/auma/session', dirEntry()],
    ['/dsh/home/sessions', dirEntry()], ['/dsh/home/sessions/agent', dirEntry()], ['/dsh/home/sessions/agent/main', dirEntry()],
    [NOTES, fileEntry('hello '.repeat(40), 1700000000001)],
    ['/dsh/home/auma/empty.txt', fileEntry(new Uint8Array(0), 1700000000002)],
    [SMALL, fileEntry('{"line":1}\n'.repeat(10), T_NEWEST - 60000)],
    [MAIN, fileEntry(mainBytes, T_NEWEST)],
    ['/dsh/home/old.txt', goneEntry()],
    ['/dsh/home/auma/seed/ed25519-keypair.json', fileEntry('{"secret":"never leaves"}')],
    ['@x6-mirror-meta', { clientId: 'client-1', cloudBase: { lineageId: 'L1', revision: 7 } }],
    ['@x6-content-revision', { kind: 'content-revision', seq: 9 }],
    ['@x6-cloud-reconciliation', { kind: 'cloud-reconciliation', firstRevision: 3, lastRevision: 5, scope: 'all-persisted-mirror-content', cause: 'transient' }],
    ...extra,
  ]
}

/** A thread journal of `size` bytes of whole lines, not the same in any two pieces. */
function journal(size) {
  const out = new Uint8Array(size)
  let at = 0, n = 0
  while (at < size) {
    const line = enc.encode(`{"role":"user","n":${n++},"text":"line"}\n`)
    out.set(line.subarray(0, Math.min(line.length, size - at)), at)
    at += line.length
  }
  return out
}

/** localStorage that records which VALUES were read (names may be listed). */
class CountingStorage extends FakeLocalStorage {
  got = []
  getItem(name) { this.got.push(name); return super.getItem(name) }
}

function join({ piece, mainBytes, intercept } = {}) {
  const idb = new FakeIndexedDb()
  idb.seed(DB, storeEntries(mainBytes))
  const ls = new CountingStorage([['aukora.theme', 'dark'], ['auth-cookie-copy', 'x'], [LOG, LOG_VALUE]])
  const bucket = createVaultBucket({ intercept })
  const budget = createVaultBudget({ now: () => T_CHECK })
  const calls = []
  const vaultFetch = createVaultFetch({ bucket, budget, world: WORLD, now: () => T_CHECK, ...(piece ? { limits: { piece } } : {}) })
  const fetch = async (path, init) => {
    calls.push({ method: init?.method ?? 'GET', path: String(path) })
    return vaultFetch(path, init)
  }
  const kit = () => rescueKit({ indexedDB: idb, localStorage: ls, fetch, now: () => T_CHECK, sleep: async () => {}, ...(piece ? { piece } : {}) })
  return { idb, ls, bucket, budget, calls, kit }
}

test('the real kit and the real vault: protocol PIECE, file/dir/gone/meta/local rows, to "Rescue copy complete and checked"', async () => {
  const main = journal(2 * VAULT_PIECE + 12345)
  const j = join({ mainBytes: main })
  const lines = []
  // every saved setting travels only when asked (`settings: true`): that keeps the `local` row coverage here.
  const result = await j.kit().copyToCloud({ report: line => lines.push(line), settings: true })
  assert.equal(result.complete, true, JSON.stringify({ line: result.line, lines: result.lines, mismatched: result.mismatched, changed: result.changed }))
  assert.equal(result.line, headline(result.totals.bytes, main.length))
  assert.equal(lines.at(-1), result.line)
  assert.deepEqual(result.lines, [LOGS_ALL])

  // The index the vault holds is the kit's bytes, under the kit's id; it names every row kind and the protocol PIECE.
  const pending = j.bucket.objects.get(`w/${WORLD}/rescue/${result.id}/pending.json`)
  assert.ok(pending, 'the index is stored under the id the kit computed')
  assert.equal(sha(pending.bytes).slice(0, 32), result.id)
  const index = JSON.parse(new TextDecoder().decode(pending.bytes))
  assert.equal(index.piece, VAULT_PIECE)
  assert.deepEqual([...new Set(index.rows.map(row => row.type))].sort(), ['dir', 'file', 'gone', 'local', 'meta'])
  assert.deepEqual(index.rows.filter(row => row.type === 'local').map(row => row.key), ['localStorage:' + LOG, 'localStorage:aukora.theme'])
  assert.deepEqual(index.client, { clientId: 'client-1', base: { lineageId: 'L1', revision: 7 }, reconciliation: { kind: 'cloud-reconciliation', firstRevision: 3, lastRevision: 5, scope: 'all-persisted-mirror-content', cause: 'transient' } })
  assert.ok(!index.rows.some(row => row.key.includes('ed25519-keypair')), 'the secret stays behind')
  assert.ok(!index.rows.some(row => row.key.includes('auth-cookie-copy')), 'a secret-like saved setting stays behind')

  // The manifest was written once, by the edge's walk; every piece of the main thread is a blob of its exact bytes.
  const manifest = JSON.parse(new TextDecoder().decode(j.bucket.objects.get(`w/${WORLD}/rescue/${result.id}/manifest.json`).bytes))
  assert.equal(manifest.verified, true)
  assert.equal(manifest.indexSha, sha(pending.bytes))
  const mainRow = index.rows.find(row => row.key === MAIN)
  assert.equal(mainRow.pieces.length, 3)
  mainRow.pieces.forEach((hash, n) => {
    const stored = j.bucket.objects.get(`w/${WORLD}/blob/${hash}`)
    assert.ok(stored, 'piece ' + n + ' is stored')
    assert.deepEqual(stored.bytes, main.subarray(n * VAULT_PIECE, Math.min((n + 1) * VAULT_PIECE, main.length)))
  })

  // The walk began at cursor=0 and ended done; every write went through the real budget, counted only once per stored piece.
  const verifies = j.calls.filter(call => call.path.includes('/verify'))
  assert.ok(verifies[0].path.endsWith('/verify?cursor=0'))
  const distinct = new Set(index.rows.flatMap(row => row.pieces))
  const counted = j.budget.calls.filter(call => call.op === 'count')
  assert.equal(counted.length, distinct.size)
  assert.equal(counted.reduce((sum, call) => sum + call.bytes, 0), [...distinct].reduce((sum, hash) => sum + j.bucket.objects.get(`w/${WORLD}/blob/${hash}`).bytes.length, 0))
  assert.equal(j.budget.storage.snapshot()['world:v1:budget'].totalBytes, counted.reduce((sum, call) => sum + call.bytes, 0))

  // Nothing in that browser changed, and the bucket was never asked to overwrite or delete.
  assert.equal(j.idb.writableTransactions().length, 0)
  assert.deepEqual(j.idb.log.created, [])
  assert.deepEqual(j.ls.writes, [])
  assert.equal(j.bucket.stats.overwrites, 0)
  assert.equal(j.bucket.calls.filter(call => call.op === 'delete').length, 0)

  // the DEFAULT (no `settings`) sends exactly the Auma Live chat log among saved settings, and reads no other value.
  j.ls.got.length = 0
  const plain = await j.kit().copyToCloud()
  assert.equal(plain.complete, true, plain.line)
  assert.deepEqual(plain.lines, [LOGS_STAY])
  const sent = JSON.parse(new TextDecoder().decode(j.bucket.objects.get(`w/${WORLD}/rescue/${plain.id}/pending.json`).bytes))
  assert.deepEqual(sent.rows.filter(row => row.type === 'local').map(row => row.key), ['localStorage:' + LOG])
  assert.deepEqual([...new Set(j.ls.got)], [LOG], 'no other saved value was read')
})

test('the real kit and the real vault: a walk of many steps carries the vault\'s cursor, and a press again stores nothing new', async () => {
  const piece = 64
  const j = join({ piece, mainBytes: journal(piece * (2 * VERIFY_STEP + 7) + 5) })
  const first = await j.kit().copyToCloud()
  assert.equal(first.complete, true, first.line + ' ' + JSON.stringify(first.lines))
  const verifies = j.calls.filter(call => call.path.includes('/verify')).map(call => call.path.split('?')[1])
  assert.deepEqual(verifies, ['cursor=0', `cursor=${VERIFY_STEP}`, `cursor=${2 * VERIFY_STEP}`])
  const writes = j.bucket.calls.filter(call => call.op === 'put').length
  const counts = j.budget.calls.filter(call => call.op === 'count').length

  const second = await j.kit().copyToCloud()
  assert.equal(second.complete, true)
  assert.equal(second.id, first.id, 'an unchanged store pressed twice is one rescue')
  assert.equal(j.bucket.calls.filter(call => call.op === 'put').length, writes, 'nothing new stored')
  assert.equal(j.budget.calls.filter(call => call.op === 'count').length, counts, 'nothing counted twice')
  assert.equal(j.bucket.stats.overwrites, 0)
})

test('the real kit and the real vault: a piece the edge lost is sent again on 424 and the walk resumes at the same cursor', async () => {
  const piece = 64
  let dropped = null
  const intercept = {
    // The first blob put after the first five is acknowledged but never stored (a lost write the edge cannot see).
    put: (key, _value, _options) => {
      if (dropped === null && key.includes('/blob/') && intercept.puts++ >= 5) { dropped = key; return { override: { key, size: 0 } } }
      return null
    },
  }
  intercept.puts = 0
  const j = join({ piece, intercept, mainBytes: journal(piece * (VERIFY_STEP + 10)) })
  const result = await j.kit().copyToCloud()
  assert.ok(dropped, 'one put was dropped')
  assert.equal(result.complete, true, result.line + ' ' + JSON.stringify(result.lines))
  assert.ok(j.bucket.objects.has(dropped), 'the lost piece is stored after the 424')
  const verifies = j.calls.filter(call => call.path.includes('/verify')).map(call => call.path.split('?')[1])
  const missingAt = verifies.findIndex((cursor, n) => n > 0 && cursor === verifies[n - 1])
  assert.ok(missingAt > 0, 'the same cursor was sent again after the 424: ' + verifies.join(' '))
})

// ── the same seam THROUGH THE WORKER ─────────────────────────────────────────────────────────────────────────

const ORIGIN = 'https://rescue-join.example.invalid'
const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64), LINEAGE = '11111111-1111-4111-8111-111111111111'
const BUDGET_ROUTE = '/_mirror/world/budget'

/** MIRROR's Durable Object storage, seeded and ready (the rows `mirrorBootstrapStatus` reads), with transactions. */
class MirrorStorage {
  data = new Map([['mirror:v2:global-fence', { lineageId: LINEAGE, revision: 7 }], ['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED,
    ballId: BALL, epoch: 2, lineageId: LINEAGE, batchDigests: [], entryCount: 0 }]])
  async transaction(callback) {
    const working = structuredClone(this.data)
    const tx = {
      get: async key => structuredClone(working.get(key)),
      list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...working].filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
      put: async (key, value) => { working.set(key, structuredClone(value)) },
      delete: async key => working.delete(key),
    }
    const result = await callback(tx)
    this.data = working
    return result
  }
  async get(key) { return structuredClone(this.data.get(key)) }
  async list(options) { return this.transaction(tx => tx.list(options)) }
}

/**
 * The Worker over the vault suite's bucket and the real MirrorDO's budget route. `send` is one browser request (her own
 * page's fetch by default: `sec-fetch-site: same-origin`, an Origin on writes); `fetch` is the kit's fetch through it.
 * `calls` records every internal HEAD and MIRROR call, with the budget route's JSON body.
 */
function edge({ bucket = createVaultBucket(), env: more = {}, mirrorEnv = {} } = {}) {
  const storage = new MirrorStorage()
  const mirror = new MirrorDO({ storage }, mirrorEnv)
  const calls = []
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture', OWNER_EMAIL: 'owner@example.invalid',
    ARCHIVE_BUCKET: bucket, ...more }
  env.HEAD = { idFromName: value => value, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    calls.push(['HEAD', path])
    if (path === '/_head/bootstrap-status') return Response.json({ ok: true, phase: 'complete', seedId: SEED, ballId: BALL, epoch: 2 })
    assert.fail('Unexpected HEAD route ' + path)
  } }) }
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    if (path === '/_mirror/bootstrap-status') { calls.push(['MIRROR', path]); return Response.json({ ok: true, phase: 'ready', seedId: SEED, ballId: BALL, epoch: 2 }) }
    if (path === BUDGET_ROUTE) { calls.push(['MIRROR', path, await request.clone().json()]); return mirror.fetch(request) }
    assert.fail('Unexpected MIRROR route ' + path)
  } }) }
  const worker = createWorker({ verifyAccess: async () => true, networkFetch: () => assert.fail('No network permitted') })
  const send = (path, { method = 'GET', body, headers = {}, signal } = {}) => {
    const all = new Headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })
    if (method !== 'GET' && method !== 'HEAD') all.set('origin', ORIGIN)
    for (const [name, value] of Object.entries(headers)) value === null ? all.delete(name) : all.set(name, value)
    const streamed = body && typeof body === 'object' && typeof body.getReader === 'function'
    return worker.fetch(new Request(new URL(path, ORIGIN), { method, headers: all, ...(signal ? { signal } : {}),
      ...(body === undefined || method === 'GET' || method === 'HEAD' ? {} : { body, ...(streamed ? { duplex: 'half' } : {}) }) }), env)
  }
  const fetch = (path, init = {}) => send(String(path), { method: String(init.method ?? 'GET').toUpperCase(), body: init.body,
    headers: Object.fromEntries(new Headers(init.headers ?? {})), signal: init.signal })
  const budget = () => calls.filter(call => call[1] === BUDGET_ROUTE).map(call => call[2])
  const row = key => storage.data.get(key)
  return { env, worker, bucket, storage, mirror, calls, send, fetch, budget, row }
}
const kitOn = (e, idb, more = {}) => rescueKit({ indexedDB: idb, localStorage: null, fetch: e.fetch, now: () => T_CHECK, sleep: async () => {}, ...more })
const seeded = (entries, more) => { const idb = new FakeIndexedDb(); idb.seed(DB, entries, more); return idb }
const json = async response => JSON.parse(await response.text())

test('step 2 THROUGH the Worker: the kit completes; each new piece is charged once and counted once at MIRROR, a failed PUT is released, a duplicate PUT is not charged twice', async () => {
  const e = edge()
  const main = journal(2 * VAULT_PIECE + 777)
  const result = await kitOn(e, seeded(storeEntries(main))).copyToCloud()
  assert.equal(result.complete, true, result.line + ' ' + JSON.stringify(result.lines))
  assert.equal(result.line, headline(result.totals.bytes, main.length))
  const index = JSON.parse(new TextDecoder().decode(e.bucket.objects.get(`w/${WORLD}/rescue/${result.id}/pending.json`).bytes))
  const distinct = [...new Set(index.rows.flatMap(row => row.pieces))].sort()
  const sent = e.budget()
  // What the Worker sent MIRROR: {op, kind, bytes, ref}, a charge before and a count after each new piece, nothing else.
  assert.ok(sent.every(body => Object.keys(body).sort().join() === 'bytes,kind,op,ref' && body.kind === 'blob'), JSON.stringify(sent.slice(0, 3)))
  assert.deepEqual(sent.filter(body => body.op === 'charge').map(body => body.ref).sort(), distinct)
  assert.deepEqual(sent.filter(body => body.op === 'count').map(body => body.ref).sort(), distinct)
  assert.equal(sent.length, 2 * distinct.length)
  const stored = distinct.reduce((sum, hash) => sum + e.bucket.objects.get(`w/${WORLD}/blob/${hash}`).bytes.length, 0)
  assert.equal(e.row('world:v1:budget').totalBytes, stored)
  for (const hash of distinct) assert.equal(e.row('world:v1:budget:ref:blob:' + hash).state, 'stored')

  // A failed PUT (R2 throws, the piece is not there afterwards): 503, and its reservation is released at MIRROR.
  const piece = enc.encode('a piece whose first put fails'), hash = sha(piece), path = '/_vault/blob/' + hash
  let fail = true
  e.bucket.intercept.put = key => { if (fail && key.endsWith(hash)) { fail = false; throw new Error('r2 down') } return null }
  const before = e.row('world:v1:budget').totalBytes
  const failed = await e.send(path, { method: 'PUT', body: piece })
  assert.deepEqual([failed.status, (await json(failed)).code], [503, 'ARCHIVE_UNAVAILABLE'])
  const ops = () => e.budget().filter(body => body.ref === hash).map(body => body.op)
  assert.deepEqual(ops(), ['charge', 'release'])
  assert.equal(e.row('world:v1:budget').totalBytes, before, 'released: nothing stays charged for a piece that is not there')
  assert.equal(e.row('world:v1:budget:ref:blob:' + hash), undefined)
  // The retry stores it, charged once; a duplicate PUT finds it and is not charged again.
  const again = await e.send(path, { method: 'PUT', body: piece })
  assert.deepEqual([again.status, await json(again)], [201, { ok: true, stored: true }])
  assert.equal(e.row('world:v1:budget').totalBytes, before + piece.length)
  const duplicate = await e.send(path, { method: 'PUT', body: piece })
  assert.deepEqual([duplicate.status, await json(duplicate)], [200, { ok: true, stored: false }])
  assert.deepEqual(ops(), ['charge', 'release', 'charge', 'count', 'count'], 'the duplicate settles only: no second charge')
  assert.equal(e.row('world:v1:budget').totalBytes, before + piece.length, 'counted once')
  assert.equal(e.bucket.writes.get(`w/${WORLD}/blob/${hash}`), 1)
})

test('step 2: MIRROR\'s budget route takes {op, kind, bytes[, ref]} and nothing else; release needs a ref', async () => {
  const e = edge()
  const direct = value => e.mirror.fetch(new Request('https://x61.internal' + BUDGET_ROUTE, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }, body: JSON.stringify(value) }))
  const ref = 'c'.repeat(64)
  for (const bad of [{ op: 'release', kind: 'blob', bytes: 1 }, { op: 'charge', kind: 'blob', bytes: 1, ref: 'C'.repeat(64) },
    { op: 'charge', kind: 'blob', bytes: 1, ref: 'c'.repeat(63) }, { op: 'charge', kind: 'blob', bytes: 1, ref, extra: 1 }, { op: 'delete', kind: 'blob', bytes: 1, ref }]) {
    const response = await direct(bad)
    assert.deepEqual([response.status, (await json(response)).code], [400, 'WORLD_BUDGET_REQUEST_INVALID'], JSON.stringify(bad))
  }
  assert.equal(e.row('world:v1:budget'), undefined)
  assert.deepEqual(await json(await direct({ op: 'charge', kind: 'blob', bytes: 5, ref })), { ok: true, budget: { ok: true } })
  assert.deepEqual(await json(await direct({ op: 'charge', kind: 'blob', bytes: 5, ref })), { ok: true, budget: { ok: true } })
  assert.equal(e.row('world:v1:budget').totalBytes, 5, 'once per ref')
  assert.deepEqual(await json(await direct({ op: 'release', kind: 'blob', bytes: 5, ref })), { ok: true, budget: { ok: true } })
  assert.equal(e.row('world:v1:budget').totalBytes, 0)
  assert.deepEqual(await json(await direct({ op: 'check', kind: 'blob', bytes: 3 })), { ok: true, budget: { ok: true } })
})

test('SHOULD same-site GET: a vault read from a sibling origin (same-site, cross-site) or with no fetch mark is refused before any bucket or row work; her page and the owner\'s navigation are unchanged', async () => {
  const e = edge()
  const hash = sha('x')
  for (const [label, headers] of [['same-site', { 'sec-fetch-site': 'same-site' }], ['cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['no fetch mark', { 'sec-fetch-site': null }], ['none, not a navigation', { 'sec-fetch-site': 'none' }]]) {
    for (const [method, path] of [['GET', '/_vault/rescue'], ['GET', '/_vault/blob/' + hash], ['HEAD', '/_vault/blob/' + hash], ['GET', '/_vault/rescue/' + 'd'.repeat(32)]]) {
      const response = await e.send(path, { method, headers })
      // judged BEFORE the session, so the answer is the one a signed-out caller gets on any
      // /_vault/ path (401 OWNER_ACCESS_REQUIRED): a refused request learns nothing new and costs no session read.
      assert.equal(response.status, 401, `${label}: ${method} ${path}`)
      if (method === 'GET') assert.equal((await json(response)).code, 'OWNER_ACCESS_REQUIRED')
    }
  }
  assert.equal(e.bucket.calls.length, 0, 'no bucket call')
  assert.deepEqual(e.calls, [], 'no HEAD or MIRROR call (not even the ready check)')
  const mine = await e.send('/_vault/rescue')
  assert.deepEqual([mine.status, await json(mine)], [200, { ok: true, rescues: [] }])
  const typed = await e.send('/_vault/rescue', { headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
  assert.equal(typed.status, 200, 'the owner typing the address still reads')
  assert.equal((await e.send('/_vault/blob/' + hash, { method: 'HEAD' })).status, 404)
})

test('MUST double dots and MUST private names, THROUGH the Worker: two-dot secrets never leave; a private file that differs in her cloud is named [redacted]', async () => {
  const privateBytes = enc.encode('a private line of hers')
  const privateHash = sha(privateBytes)
  const flipped = new Uint8Array(privateBytes)
  flipped[3] ^= 1
  const bucket = createVaultBucket({ intercept: { get: key => key.endsWith('/blob/' + privateHash)
    ? { override: { key, size: flipped.length, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(flipped)); c.close() } }) } } : null } })
  const e = edge({ bucket })
  const secrets = [['/dsh/home/auma/..ed25519-keypair.json', 'KEYPAIRMARK'], ['/dsh/home/..env.local', 'ENVMARK'], ['/dsh/home/..aukora-escrow', 'ESCROWMARK'],
    ['/dsh/home/.....session.cap', 'CAPMARK'], ['/dsh/home/..ssh/id_ed25519', 'SSHMARK']]
  const idb = seeded(storeEntries(journal(1000), [['/dsh/home/auma/private', dirEntry()], ['/dsh/home/auma/private/diary-title.txt', fileEntry(privateBytes)],
    ['/dsh/home/..ssh', dirEntry()], ...secrets.map(([key, text]) => [key, fileEntry(text)])]))
  const result = await kitOn(e, idb).copyToCloud()
  assert.equal(result.complete, false)
  assert.ok(result.lines.includes('Not the same in her cloud: /dsh/home/auma/private/[redacted]'), JSON.stringify(result.lines))
  assert.ok(!JSON.stringify(result).includes('diary-title'), 'the private name is never shown')
  const index = new TextDecoder().decode(e.bucket.objects.get(`w/${WORLD}/rescue/${result.id}/pending.json`).bytes)
  for (const [key, mark] of secrets) {
    assert.ok(!index.includes(key.split('/').at(-1)), key + ' is not in the index')
    assert.ok(![...e.bucket.objects.values()].some(entry => Buffer.from(entry.bytes).includes(mark)), mark + ' never reached the bucket')
  }
  assert.ok(index.includes('ed25519-keypair.json with extra leading dots') || JSON.stringify(result.skipped).includes('extra leading dots'), JSON.stringify(result.skipped))
})

/** `gc` without a command-line flag (as vault-hold.test.mjs does). */
const collect = (() => {
  if (typeof globalThis.gc === 'function') return globalThis.gc
  v8.setFlagsFromString('--expose-gc')
  return vm.runInNewContext('gc')
})()

test('MUST tiny chunks THROUGH the Worker: 600,000 one-byte chunks (no content-length) grow heap plus array buffers by less than 16 MiB, and the piece stores', async () => {
  const e = edge()
  const N = 600000
  const all = new Uint8Array(N)
  for (let i = 0; i < N; i += 1) all[i] = (i * 31) & 0xff
  const hash = sha(all)
  const sample = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers }
  let at = 0, peak = 0, sampled = false
  collect()
  collect()
  const before = sample()
  const body = new ReadableStream({
    pull(controller) {
      if (at === N) { collect(); peak = sample() - before; sampled = true; controller.close(); return }
      controller.enqueue(all.slice(at, at + 1))
      at += 1
    },
  }, { highWaterMark: 0 })
  const response = await e.send('/_vault/blob/' + hash, { method: 'PUT', body })
  assert.equal(response.status, 201, await response.clone().text())
  assert.equal(at, N)
  assert.ok(sampled, 'the peak was sampled after the last chunk was handed over')
  assert.ok(peak < 16 * 1024 * 1024, `kept ${(peak / 1048576).toFixed(1)} MiB while the Worker passed 600,000 one-byte chunks to the vault`)
  assert.deepEqual(e.bucket.objects.get(`w/${WORLD}/blob/${hash}`).bytes, all)
})

test('MUST stalled GET body (vault side), real kit + real vault THROUGH the Worker: R2 delivers one byte and stalls; the vault answers 503 with retry-after at its 10 s GET deadline, the kit retries and completes', { timeout: 40000 }, async () => {
  const main = journal(VAULT_PIECE + 500)
  const target = sha(main.subarray(VAULT_PIECE))
  let stalls = 0
  const bucket = createVaultBucket({ intercept: { get: key => {
    if (!key.endsWith('/blob/' + target) || stalls > 0) return null
    stalls += 1
    return { override: { key, size: 500, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([main[VAULT_PIECE]])) }, pull() { return new Promise(() => {}) } }) } }
  } } })
  const e = edge({ bucket })
  const seen = []
  const fetch = async (path, init) => {
    const response = await e.fetch(path, init)
    if (String(init?.method ?? 'GET') === 'GET' && String(path).endsWith(target)) seen.push([response.status, response.headers.get('retry-after')])
    return response
  }
  const started = Date.now()
  const result = await kitOn(e, seeded(storeEntries(main)), { fetch }).copyToCloud()
  assert.equal(result.complete, true, result.line)
  assert.deepEqual(seen, [[503, '2'], [200, null]], 'never a 200 that stalls: the vault read the body itself and gave up at its deadline')
  assert.ok(Date.now() - started < VAULT_DEFAULT_DEADLINES.getIdleMs + 15000)
})

test('MUST stalled GET body (kit side), real kit + real vault THROUGH the Worker: the edge\'s 200 stalls on the way to the browser; the kit cancels it at its body deadline, retries and completes', { timeout: 20000 }, async () => {
  const e = edge()
  let stalled = 0, cancelled = 0
  const fetch = async (path, init) => {
    const response = await e.fetch(path, init)
    if (String(init?.method ?? 'GET') !== 'GET' || !String(path).startsWith('/_vault/blob/') || stalled > 0 || response.status !== 200) return response
    stalled += 1
    const first = new Uint8Array(await response.arrayBuffer()).subarray(0, 1)
    return new Response(new ReadableStream({ start(c) { c.enqueue(first) }, pull() { return new Promise(() => {}) }, cancel() { cancelled += 1 } }), { status: 200, headers: response.headers })
  }
  const result = await kitOn(e, seeded(storeEntries(journal(3000))), { fetch, deadlines: { idle: 300 } }).copyToCloud()
  assert.equal(result.complete, true, result.line)
  assert.deepEqual([stalled, cancelled], [1, 1], 'the stalled body was cancelled')
})

test('MUST verified cap at publication, THROUGH the Worker: VAULT_MAX_RESCUES 1, two pending indexes, the second verify is 507 RESCUE_LIMIT and only one manifest exists', async () => {
  const e = edge({ env: { VAULT_MAX_RESCUES: '1' } })
  const make = n => buildRescue({ piece: VAULT_PIECE, rows: [{ key: `/dsh/home/n${n}`, type: 'file', bytes: enc.encode('file number ' + n) }] })
  const [a, b] = [await make(1), await make(2)]
  for (const rescue of [a, b]) {
    for (const [hash, bytes] of rescue.pieces) assert.equal((await e.send('/_vault/blob/' + hash, { method: 'PUT', body: bytes })).status, 201)
    assert.equal((await e.send('/_vault/rescue/' + rescue.id, { method: 'PUT', body: rescue.indexBytes })).status, 201, 'both indexes are admitted as pending')
  }
  const first = await e.send(`/_vault/rescue/${a.id}/verify?cursor=0`, { method: 'POST' })
  assert.deepEqual([first.status, (await json(first)).done], [200, true])
  const second = await e.send(`/_vault/rescue/${b.id}/verify?cursor=0`, { method: 'POST' })
  assert.deepEqual([second.status, await json(second)], [507, { ok: false, code: 'RESCUE_LIMIT', var: 'VAULT_MAX_RESCUES', limit: 1 }])
  assert.deepEqual([...e.bucket.objects.keys()].filter(key => key.endsWith('/manifest.json')), [`w/${WORLD}/rescue/${a.id}/manifest.json`])
})

// ── SHOULD slow uploads: the kit hears the vault's 408 and goes one request at a time ────────────────────────────────

/**
 * One slow link shared by every piece upload: every `tick` ms it hands `chunk` bytes to the NEXT upload waiting, in
 * turn. Alone an upload gets the whole link; three side by side each get a third of it.
 */
function slowLink({ tick, chunk }) {
  const waiting = []
  let timer = null
  const step = () => {
    timer = null
    const next = waiting.shift()
    if (next) next()
    if (waiting.length > 0) timer = setTimeout(step, tick)
  }
  const want = deliver => { waiting.push(deliver); if (!timer) timer = setTimeout(step, tick) }
  const drop = deliver => { const at = waiting.indexOf(deliver); if (at >= 0) waiting.splice(at, 1) }
  /** A request body that comes over the link; it errors when the kit aborts the request. */
  const body = (bytes, signal) => {
    let at = 0, deliver = null
    return new ReadableStream({
      start(controller) { signal?.addEventListener('abort', () => { drop(deliver); try { controller.error(new Error('aborted')) } catch { /* closed */ } }) },
      pull(controller) {
        if (at >= bytes.length) { controller.close(); return }
        return new Promise(resolve => {
          deliver = () => { const end = Math.min(at + chunk, bytes.length); controller.enqueue(bytes.slice(at, end)); at = end; resolve() }
          want(deliver)
        })
      },
      cancel() { drop(deliver) },
    }, { highWaterMark: 0 })
  }
  return { body }
}

test('SHOULD slow uploads: three uploads that share a slow link each stall, one alone fits; at the kit\'s own deadlines (scaled 1/100) the vault\'s 408 arrives first, the kit goes one at a time and completes', { timeout: 30000 }, async () => {
  const SCALE = 100
  const piece = 64 * 60
  const kitDefaults = rescueKit({ indexedDB: null, localStorage: null }).DEADLINE_DEFAULTS
  // The two sides' own numbers, as shipped: the kit waits longer for a body request than the vault reads one.
  assert.ok(kitDefaults.bodyTotal > VAULT_DEFAULT_DEADLINES.totalMs && kitDefaults.upload > VAULT_DEFAULT_DEADLINES.totalMs, JSON.stringify(kitDefaults))
  const scaled = Object.fromEntries(Object.entries(kitDefaults).map(([name, ms]) => [name, ms / SCALE]))
  const vaultScaled = Object.fromEntries(Object.entries(VAULT_DEFAULT_DEADLINES).map(([name, ms]) => [name, ms / SCALE]))
  // One alone: 60 ticks of 10 ms (about 0.6 s of the vault's 1.2 s); three side by side: 180 ticks each (1.8 s).
  const link = slowLink({ tick: 10, chunk: 64 })
  const bucket = createVaultBucket()
  const vaultFetch = createVaultFetch({ bucket, budget: createVaultBudget(), limits: { piece }, deadlines: vaultScaled })
  const statuses = []
  let aborts = 0
  const fetch = async (path, init = {}) => {
    if (init.method !== 'PUT' || !String(path).startsWith('/_vault/blob/')) return vaultFetch(path, init)
    init.signal?.addEventListener('abort', () => { aborts += 1 })
    const response = await vaultFetch(path, { ...init, body: link.body(new Uint8Array(init.body), init.signal) })
    statuses.push(response.status)
    return response
  }
  const idb = seeded([['/dsh/home', dirEntry()], ['/dsh/home/sessions', dirEntry()], ['/dsh/home/sessions/agent', dirEntry()],
    ['/dsh/home/sessions/agent/main', dirEntry()], [MAIN, fileEntry(journal(3 * piece), T_NEWEST)]])
  const result = await rescueKit({ indexedDB: idb, localStorage: null, fetch, piece, deadlines: scaled, sleep: async () => {} }).copyToCloud()
  assert.equal(result.complete, true, result.line)
  assert.ok(statuses.filter(status => status === 408).length >= 1, 'the vault\'s 408 reached the kit: ' + statuses.join())
  assert.equal(aborts, 0, 'the kit never gave up on an upload before the vault answered')
  assert.equal(statuses.filter(status => status === 201).length, 3)
})

test('SHOULD slow uploads: a request that sends a body and passes a kit deadline makes the rest of the run go one request at a time', { timeout: 20000 }, async () => {
  const piece = 64
  const vaultFetch = createVaultFetch({ limits: { piece } })
  let hung = 0, firstAbort = false, inflight = 0, maxAfter = 0
  const fetch = async (path, init = {}) => {
    const after = firstAbort
    if (after) { inflight += 1; maxAfter = Math.max(maxAfter, inflight) }
    try {
      if (init.method === 'PUT' && String(path).startsWith('/_vault/blob/') && hung < 3) {
        hung += 1
        return await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { firstAbort = true; reject(new Error('aborted')) }))
      }
      return await vaultFetch(path, init)
    } finally { if (after) inflight -= 1 }
  }
  const idb = seeded([['/dsh/home', dirEntry()], ['/dsh/home/sessions', dirEntry()], ['/dsh/home/sessions/agent', dirEntry()],
    ['/dsh/home/sessions/agent/main', dirEntry()], [MAIN, fileEntry(journal(3 * piece), T_NEWEST)]])
  const result = await rescueKit({ indexedDB: idb, localStorage: null, fetch, piece, sleep: async () => {},
    deadlines: { headers: 100, upload: 100, bodyTotal: 100, idle: 100, total: 1000 } }).copyToCloud()
  assert.equal(result.complete, true, result.line)
  assert.equal(hung, 3, 'three uploads were in flight together and passed their deadline')
  assert.equal(maxAfter, 1, 'after that, one request at a time')
})

// ── SHOULD reviewed names: Auma Live chat logs travel by default, nothing else does ─────────────────────────────────

test('chat logs by default, THROUGH the Worker: exactly the allow-listed keys are copied (and only their values read); look-alikes stay; the pack and the vault index agree on the rows; the verifier counts and extracts them', async () => {
  const e = edge()
  const second = 'aukora-auma-live-log-v2:unselected'
  const settings = [[LOG, LOG_VALUE], [second, '[]'], ['aukora-auma-live-log-v2', 'NOCOLON'], ['xaukora-auma-live-log-v2:a', 'XPREFIX'],
    ['AUKORA-AUMA-LIVE-LOG-V2:a', 'UPPER'], ['Aukora-auma-live-log-v2:a', 'TITLE'], ['aukora-auma-canvas-log-v2:a', 'CANVAS'], ['aukora.theme', 'dark'], ['auth-cookie-copy', 'x']]
  const idb = seeded(storeEntries(journal(5000)))
  const ls = new CountingStorage(settings)
  const kit = () => rescueKit({ indexedDB: idb, localStorage: ls, fetch: e.fetch, now: () => T_CHECK, sleep: async () => {} })
  assert.deepEqual(kit().CHAT_LOG_PREFIXES, ['aukora-auma-live-log-v2:'], 'one reviewed entry')
  const cloud = await kit().copyToCloud()
  assert.equal(cloud.complete, true, cloud.line)
  assert.deepEqual(cloud.lines, [LOGS_STAY])
  assert.deepEqual([...new Set(ls.got)].sort(), [LOG, second].sort(), 'no other saved value was read')
  const sent = JSON.parse(new TextDecoder().decode(e.bucket.objects.get(`w/${WORLD}/rescue/${cloud.id}/pending.json`).bytes))
  assert.deepEqual(sent.rows.filter(row => row.type === 'local').map(row => row.key), ['localStorage:' + LOG, 'localStorage:' + second])
  assert.ok(![...e.bucket.objects.values()].some(entry => /NOCOLON|XPREFIX|UPPER|TITLE|CANVAS|"dark"/.test(Buffer.from(entry.bytes).toString())))
  // The local pack takes the same rows: every row of the vault's index is in the pack's index, byte for byte (no offsets).
  ls.got.length = 0
  const pack = await kit().saveLocal()
  assert.equal(pack.complete, true, pack.line)
  assert.ok(pack.lines.includes(LOGS_STAY))
  assert.deepEqual([...new Set(ls.got)].sort(), [LOG, second].sort())
  const buffer = Buffer.from(await pack.blob.arrayBuffer())
  const length = Number(buffer.readBigUInt64BE(buffer.length - 19))
  const local = JSON.parse(buffer.subarray(buffer.length - 19 - length, buffer.length - 19).toString())
  assert.deepEqual(local.rows.map(({ offset, ...row }) => row), sent.rows)
  assert.equal(local.completeness.settings, false)
  // The verifier counts them and --extract writes them to SETTINGS.json.
  const folder = mkdtempSync(joinPath(tmpdir(), 'mount2-join-'))
  const file = joinPath(folder, pack.fileName)
  writeFileSync(file, buffer)
  const verifier = new URL('../../../../server/rescue-verify.mjs', import.meta.url).pathname
  const run = spawnSync(process.execPath, [verifier, file, '--extract', joinPath(folder, 'out')], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /\nAuma Live chat logs: 2\n/)
  assert.match(run.stdout, /saved settings: not copied \(only Auma Live chat logs\)/)
  assert.deepEqual(JSON.parse(readFileSync(joinPath(folder, 'out', 'SETTINGS.json'), 'utf8')).sort(), [[LOG, LOG_VALUE], [second, '[]']].sort())
  assert.match(run.stdout, /\nmismatches: 0\n/)
})

// ── SHOULD vault accounting: what the reservation bounds when uploads run side by side ──────────────────────────────

test('SHOULD accounting, THROUGH the Worker: five uploads side by side against room for three store exactly three; the row never passes the cap', async () => {
  const e = edge({ mirrorEnv: { VAULT_MAX_BYTES: '10' } })
  const pieces = ['aaa', 'bbb', 'ccc', 'ddd', 'eee'].map(text => enc.encode(text))
  const answers = await Promise.all(pieces.map(bytes => e.send('/_vault/blob/' + sha(bytes), { method: 'PUT', body: bytes })))
  assert.deepEqual(answers.map(answer => answer.status).sort(), [201, 201, 201, 507, 507])
  assert.equal(e.row('world:v1:budget').totalBytes, 9)
  assert.equal([...e.bucket.objects.keys()].filter(key => key.includes('/blob/')).length, 3)
})

test('SHOULD accounting: the one overshoot the reservation allows: a piece whose put failed in one upload while a second upload of the SAME piece stored it is counted after its release: the row ends one piece past the cap, once per piece', async () => {
  const NOW = Date.UTC(2026, 10, 12, 13, 0, 0)
  const P = enc.encode('pppp'), Q = enc.encode('qqqqqqqq'), hP = sha(P), hQ = sha(Q)
  const budget = createVaultBudget({ limits: { totalBytes: 8 }, now: () => NOW })
  const gate = () => { let open; const promise = new Promise(resolve => { open = resolve }); return { promise, open } }
  const secondCharged = gate(), qStored = gate()
  let chargesOfP = 0, putsOfP = 0
  const watched = { ...budget, charge: async input => { const answer = await budget.charge(input); if (input.ref === hP && ++chargesOfP === 2) secondCharged.open(); return answer } }
  const bucket = createVaultBucket({ intercept: { put: async key => {
    if (!key.endsWith('/blob/' + hP)) return null
    putsOfP += 1
    if (putsOfP === 1) { await secondCharged.promise; throw new Error('upload A: the put failed') }
    if (putsOfP === 2) await qStored.promise
    return null
  } } })
  const vault = createVaultFetch({ bucket, budget: watched, limits: { piece: 16 }, now: () => NOW })
  const until = async test => { for (let i = 0; i < 10000 && !test(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(test()) }
  const a = vault('/_vault/blob/' + hP, { method: 'PUT', body: P })
  await until(() => putsOfP === 1)
  const b = vault('/_vault/blob/' + hP, { method: 'PUT', body: P })
  assert.equal((await a).status, 503, 'A failed; its head found nothing yet, so it released')
  await until(() => putsOfP === 2)
  const row = () => budget.storage.snapshot()['world:v1:budget'].totalBytes
  assert.equal(row(), 0, 'released, while B is still storing P')
  assert.equal((await vault('/_vault/blob/' + hQ, { method: 'PUT', body: Q })).status, 201, 'Q takes the room P left')
  assert.equal(row(), 8)
  qStored.open()
  assert.equal((await b).status, 201)
  const stored = [...bucket.objects.entries()].filter(([key]) => key.includes('/blob/')).reduce((sum, [, entry]) => sum + entry.bytes.length, 0)
  assert.equal(row(), 12, 'B settles P after the release: counted once, with no check')
  assert.equal(stored, 12, 'the row equals what is stored: 8 (the cap) + 4 (one piece of P)')
  // Once per piece: P is now settled for good; another PUT of it counts nothing, and the world refuses new bytes.
  assert.equal((await vault('/_vault/blob/' + hP, { method: 'PUT', body: P })).status, 200)
  assert.equal(row(), 12)
  assert.equal((await vault('/_vault/blob/' + sha('r'), { method: 'PUT', body: enc.encode('r') })).status, 507)
})
