/**
 * The one-writer lease and the thread log MOUNTED in MIRROR: every test posts to the REAL MirrorDO
 * class (internal mark, this world's seed) over an in-memory storage whose transaction commits only when its closure
 * returns (writes are staged, reads see them, a throw drops them).
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { MirrorDO, mirrorDigest } from '../mirror-do.mjs'
import { CLOUD_WAKE_CHECKPOINT_PATH, X61HeadDurableObject } from '../head-do.mjs'
import { MIRROR_WAKE_CLIENT_ID } from '../mirror-client-slots.mjs'
import { SLOT_TOMBSTONE } from '../mirror-slot-tombstone.mjs'
import { WORLD_LEASE } from '../world-lease.mjs'
import { MIRROR_SECRET_RULE_VERSION } from '../mirror-secret-paths.mjs'
import { THREAD_EMPTY_SHA, THREAD_ZERO_CHAIN, bytesToBase64, sha256Hex, threadIdForPath } from '../thread-log.mjs'

const SEED = 'a'.repeat(64)
const BALL = 'b'.repeat(64)
const BATCH0 = 'c'.repeat(64)
const LINEAGE = '11111111-1111-4111-8111-111111111111'
const FENCE = 'mirror:v2:global-fence'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const WROTE = 'world:v1:wrote'
const SEEN = 'world:v1:seen'
const PENDING = 'world:v1:home-pending'
const LEASE = 'world:v1:lease'
const DAY = 86400000
const PATH = '/dsh/home/auma/session/messages.jsonl'
const encoder = new TextEncoder()
const client = index => `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
const hasField = (value, name) => value !== null && typeof value === 'object' && (Object.hasOwn(value, name) || Object.values(value).some(inner => hasField(inner, name)))

/** Durable-Object-like storage: staged writes per transaction, committed on return, dropped on throw; one at a time. */
function createStorage(initial = []) {
  const data = new Map(initial)
  const hooks = { failPut: null }
  let tail = Promise.resolve()
  const listOf = (read, { prefix = '', start, startAfter, limit = Infinity } = {}) => {
    const keys = read.keys().filter(key => key.startsWith(prefix) && (start === undefined || key >= start) && (startAfter === undefined || key > startAfter)).sort()
    const out = new Map()
    for (const key of keys) { if (out.size >= limit) break; out.set(key, read.get(key)) }
    return out
  }
  const direct = {
    keys: () => [...data.keys()],
    get: key => structuredClone(data.get(key)),
  }
  const storage = {
    hooks,
    data,
    get: async key => direct.get(key),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
    list: async options => listOf(direct, options),
    transaction(fn) {
      const run = tail.then(async () => {
        const writes = new Map()
        const deletes = new Set()
        const read = {
          keys: () => [...new Set([...data.keys(), ...writes.keys()])].filter(key => !deletes.has(key) || writes.has(key)),
          get: key => (writes.has(key) ? structuredClone(writes.get(key)) : deletes.has(key) ? undefined : structuredClone(data.get(key))),
        }
        const view = {
          get: async key => read.get(key),
          put: async (key, value) => {
            if (hooks.failPut?.(key)) throw new Error('STORAGE_FAILED')
            deletes.delete(key)
            writes.set(key, structuredClone(value))
          },
          delete: async key => { const had = read.get(key) !== undefined; writes.delete(key); deletes.add(key); return had },
          list: async options => listOf(read, options),
        }
        const result = await fn(view)
        for (const key of deletes) if (!writes.has(key)) data.delete(key)
        for (const [key, value] of writes) data.set(key, value)
        return result
      })
      tail = run.catch(() => {})
      return run
    },
    snapshot: () => structuredClone(Object.fromEntries([...data].sort(([a], [b]) => (a < b ? -1 : 1)))),
  }
  return storage
}

/** A seeded, ready world: the bootstrap record and the fence at revision 1, as a finished seed leaves them. */
function seededWorld() {
  return createStorage([
    ['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, lineageId: LINEAGE, revision: 1, ballId: BALL, epoch: 2, batchDigests: [BATCH0], nextBatch: 1, entryCount: 1, expectedEntries: 1 }],
    [FENCE, { lineageId: LINEAGE, revision: 1 }],
  ])
}

function harness({ env = {}, storage = seededWorld() } = {}) {
  const mirror = new MirrorDO({ storage }, env)
  const post = async (path, body, { method = 'POST', headers = {}, raw } = {}) => {
    const response = await mirror.fetch(new Request(`https://x61.internal${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED, ...headers },
      ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(body) }),
    }))
    const text = await response.text()
    return { status: response.status, text, body: JSON.parse(text) }
  }
  const get = path => post(path, undefined, { method: 'GET' })
  const lease = (input, ownerApproved = false) => post('/_mirror/lease', { input, ownerApproved })
  const tabs = { [A]: 'tab-a', [B]: 'tab-b', [C]: 'tab-c' }
  const labels = { [A]: 'his Chrome', [B]: 'his phone', [C]: 'a tablet' }
  const acquire = (clientId, extra = {}) => lease({ action: 'acquire', clientId, tabId: tabs[clientId] ?? 't1', label: labels[clientId] ?? 'other', ...extra })
  const seqs = new Map()
  const save = async (clientId, entries, { lease: ref, seq } = {}) => {
    const fence = storage.data.get(FENCE)
    const next = seq ?? (seqs.get(clientId) ?? 0) + 1
    const batch = { id: `${clientId}:${next}`, clientId, seq: next, entries, cloudBase: { lineageId: fence.lineageId, revision: fence.revision } }
    const envelope = { v: 2, batch, digest: await mirrorDigest(batch), ...(ref ? { lease: ref } : {}) }
    const answer = await post('/_mirror/delta', envelope)
    if (answer.status === 200 && answer.body.ok) seqs.set(clientId, next)
    return { ...answer, envelope }
  }
  return { mirror, storage, post, get, lease, acquire, save, seqs }
}

const note = (name, text) => [`/dsh/home/auma/${name}`, { kind: 'file', mode: 0o644, mtimeMs: 1, b64: Buffer.from(text).toString('base64') }]
const refOf = answer => ({ leaseId: answer.body.lease.leaseId, generation: answer.body.lease.generation })

/** Freeze Date.now for the MirrorDO (it stamps every call with the edge clock). */
function clockOf(t, start = 1_800_000_000_000) {
  const clock = { now: start }
  t.mock.method(Date, 'now', () => clock.now)
  return clock
}

const appendInput = async ({ path = PATH, at = 0, bytes, have = `${THREAD_ZERO_CHAIN}.${THREAD_EMPTY_SHA}`, lease }) => ({
  id: await threadIdForPath(path), path, at, body: bytesToBase64(bytes), bodySha: await sha256Hex(bytes), have, ...(lease ? { lease } : {}),
})
const haveOf = body => `${body.chain}.${body.tailSha}`

// ---------------------------------------------------------------------------------------------------------------
// MUST 1: the lease in the save path

test('under WRITER_LEASE=enforce: a save from B while A holds a live lease is 423 WRITER_ELSEWHERE with A label and writes NOTHING', async t => {
  clockOf(t)
  const h = harness({ env: { WRITER_LEASE: 'enforce' } })
  const a = await h.acquire(A)
  assert.equal(a.status, 200)
  const before = h.storage.snapshot()
  // Under enforce a save needs a reference: B sends one that is not its own (A's), so the edge names the holder.
  const refused = await h.save(B, [note('b.md', 'from B\n')], { lease: refOf(a) })
  assert.equal(refused.status, 423)
  assert.equal(refused.body.code, 'WRITER_ELSEWHERE')
  assert.equal(refused.body.holder.label, 'his Chrome')
  assert.equal(hasField(refused.body, 'conflictCode'), false)
  assert.ok(!refused.text.includes(a.body.lease.leaseId), 'never another browser lease id')
  assert.deepEqual(h.storage.snapshot(), before, 'not a row: no conflict kept, no fence, no receipt, no wrote')
})

test('the holder own browser saves with no lease reference (her saves carry none yet); with its reference it renews only under WRITER_LEASE=enforce (by default a save never reads the lease)', async t => {
  const clock = clockOf(t)
  const h = harness()
  const a = await h.acquire(A)
  const own = await h.save(A, [note('a.md', 'from A\n')])
  assert.equal(own.status, 200)
  assert.equal(own.body.ok, true)
  assert.equal(own.body.revision, 2)
  const granted = clock.now + WORLD_LEASE.ttlMs
  assert.equal(h.storage.data.get(LEASE).expiresAt, granted, 'a no-reference save never renews')
  clock.now += 10_000
  const leased = await h.save(A, [note('a.md', 'from A again\n')], { lease: refOf(a) })
  assert.equal(leased.status, 200)
  assert.equal(h.storage.data.get(LEASE).expiresAt, granted, 'by default a save with its reference does not touch the lease (main ignores the field)')
  // The lease released: B saves again (observe).
  await h.lease({ action: 'release', clientId: A, tabId: 'tab-a', label: 'his Chrome', leaseId: a.body.lease.leaseId })
  assert.equal((await h.save(B, [note('b.md', 'from B\n')])).status, 200)
  // Under WRITER_LEASE=enforce the holder's save with its reference renews.
  const e = harness({ env: { WRITER_LEASE: 'enforce' } })
  const held = await e.acquire(A)
  clock.now += 10_000
  assert.equal((await e.save(A, [note('a.md', 'enforced\n')], { lease: refOf(held) })).status, 200)
  assert.equal(e.storage.data.get(LEASE).expiresAt, clock.now + WORLD_LEASE.ttlMs, 'under enforce a save with its reference renews')
})

test('under WRITER_LEASE=enforce: a replayed batch still gets its stored receipt while another browser holds a live lease', async t => {
  clockOf(t)
  const h = harness({ env: { WRITER_LEASE: 'enforce' } })
  const b = await h.acquire(B)
  const first = await h.save(B, [note('b.md', 'B wrote before the lease\n')], { lease: refOf(b) })
  assert.equal(first.status, 200)
  await h.lease({ action: 'release', clientId: B, tabId: 'tab-b', label: 'his phone', leaseId: b.body.lease.leaseId })
  await h.acquire(A)
  const replay = await h.post('/_mirror/delta', first.envelope)
  assert.equal(replay.status, 200)
  assert.equal(replay.body.replayed, true)
  assert.equal(replay.body.id, first.body.id)
  assert.equal(replay.body.revision, first.body.revision)
  // Its NEXT save is refused while A holds the lease.
  assert.equal((await h.save(B, [note('b.md', 'B again\n')])).status, 423)
})

test('under WRITER_LEASE=enforce: an old page of a browser that lost the lease, with its old reference: 423 naming the holder; with a moved generation of its own lease: 410', async t => {
  const clock = clockOf(t)
  const h = harness({ env: { WRITER_LEASE: 'enforce' } })
  const a = await h.acquire(A)
  clock.now += WORLD_LEASE.ttlMs + 1
  const b = await h.acquire(B)
  assert.equal(b.status, 200)
  const back = await h.save(A, [note('a.md', 'queued while away\n')], { lease: refOf(a) })
  assert.equal(back.status, 423)
  assert.equal(back.body.holder.label, 'his phone')
  const forged = await h.save(B, [note('b.md', 'x\n')], { lease: { ...refOf(b), generation: b.body.lease.generation + 1 } })
  assert.equal(forged.status, 410)
  assert.equal(forged.body.code, 'WRITER_GONE')
})

test('WRITER_LEASE=enforce: a save with no reference is 423 WRITER_REQUIRED for every browser; the holder with its reference saves', async t => {
  clockOf(t)
  const h = harness({ env: { WRITER_LEASE: 'enforce' } })
  assert.equal((await h.save(A, [note('a.md', 'x\n')])).body.code, 'WRITER_REQUIRED')
  const a = await h.acquire(A)
  assert.equal((await h.save(A, [note('a.md', 'x\n')])).status, 423)
  assert.equal((await h.save(A, [note('a.md', 'x\n')], { lease: refOf(a) })).status, 200)
})

test('under MIRROR_SLOT_RETIRE=retire: a full table retires the longest-idle slot as a tombstone and the new browser saves; that browser back is the named 409', async t => {
  const clock = clockOf(t)
  const h = harness({ env: { MIRROR_SLOT_RETIRE: 'retire' } })
  for (let i = 0; i < 256; i++) {
    clock.now += 1
    assert.equal((await h.save(client(i), [note(`c${i % 7}.md`, `${i}\n`)])).status, 200)
  }
  assert.equal((await h.get('/_mirror/status')).body.clients, 256)
  // Nobody idle yet: today's 507 stays.
  const full = await h.save(client(999), [note('new.md', 'new\n')])
  assert.equal(full.status, 507)
  assert.equal(full.body.code, 'MIRROR_CLIENT_LIMIT')
  clock.now += 31 * DAY
  const fresh = await h.save(client(999), [note('new.md', 'new\n')])
  assert.equal(fresh.status, 200, 'the new browser is not refused for good')
  const tomb = h.storage.data.get(SLOT_TOMBSTONE + client(0))
  assert.equal(tomb?.state, 'retired', 'the oldest idle slot is a tombstone, not a deletion')
  assert.equal(tomb.seq, 1)
  assert.equal(h.storage.data.get(`mirror:v2:head:${client(0)}`), undefined)
  assert.equal((await h.get('/_mirror/status')).body.clients, 256)
  const before = h.storage.snapshot()
  const back = await h.save(client(0), [note('back.md', 'unsent\n')])
  assert.equal(back.status, 409)
  assert.equal(back.body.code, 'CLIENT_SLOT_RETIRED')
  assert.equal(hasField(back.body, 'conflictCode'), false)
  assert.deepEqual(back.body.wayBack, { route: '/_mirror/lease', action: 'resurrect', then: '/rescue' })
  assert.deepEqual(h.storage.snapshot(), before, 'nothing written for a retired browser')
  // The count of retired slots is on the thread index, never in the status her app polls.
  assert.equal(Object.hasOwn((await h.get('/_mirror/status')).body, 'world'), false)
  assert.equal((await h.post('/_mirror/thread', { op: 'index', input: {} })).body.world.retired, 1)
})

test('the yield under WRITER_LEASE=enforce: the cloud wake checkpoint uses the one wake id, yields while a lease is live (named code, nothing written), and refuses on a tombstone', async t => {
  const clock = clockOf(t)
  const source = await readFile(new URL('../mirror-do.mjs', import.meta.url), 'utf8')
  assert.match(source, /const clientId = MIRROR_WAKE_CLIENT_ID\b/)
  assert.ok(!source.includes(`'${MIRROR_WAKE_CLIENT_ID}'`), 'no second copy of the literal')
  const h = harness({ env: { WRITER_LEASE: 'enforce' } })
  const checkpoint = id => ({ id, at: 1000, head: { ballId: BALL, epoch: 2 }, evidence: [{ tool: 'inspectHeadWish', digest: 'd'.repeat(64) }] })
  const a = await h.acquire(A)
  const before = h.storage.snapshot()
  const yielded = await h.post('/_mirror/wake-checkpoint', checkpoint('e'.repeat(64)))
  assert.equal(yielded.status, 200)
  assert.deepEqual(yielded.body, { ok: false, code: 'MIRROR_WAKE_WRITER_LIVE', yielded: true })
  assert.deepEqual(h.storage.snapshot(), before, 'the wake wrote nothing while her browser holds the lease')
  await h.lease({ action: 'release', clientId: A, tabId: 'tab-a', label: 'his Chrome', leaseId: a.body.lease.leaseId })
  const written = await h.post('/_mirror/wake-checkpoint', checkpoint('e'.repeat(64)))
  assert.deepEqual(written.body, { ok: true, id: 'e'.repeat(64), revision: 2, replayed: false })
  assert.notEqual(h.storage.data.get(`mirror:v2:head:${MIRROR_WAKE_CLIENT_ID}`), undefined)
  assert.equal(h.storage.data.get(WROTE), undefined, 'the wake is not a browser: wrote is not noted')
  // A lease that ran out does not hold the wake back.
  await h.acquire(B)
  clock.now += WORLD_LEASE.ttlMs + 1
  assert.equal((await h.post('/_mirror/wake-checkpoint', checkpoint('f'.repeat(64)))).body.ok, true)
  // A tombstone under the wake id (only a damaged or hand-made row could put one there): refused, never revived.
  h.storage.data.set(SLOT_TOMBSTONE + MIRROR_WAKE_CLIENT_ID, { v: 1, clientId: MIRROR_WAKE_CLIENT_ID, state: 'retired', reason: 'idle', retiredAt: 1, lastSeenAt: 1, seq: 1, digest: '0'.repeat(64), base: { lineageId: LINEAGE, revision: 2 }, resurrectedAt: null })
  const refused = await h.post('/_mirror/wake-checkpoint', checkpoint('9'.repeat(64)))
  assert.equal(refused.status, 409)
  assert.equal(refused.body.code, 'CLIENT_SLOT_RETIRED')
  h.storage.data.set(SLOT_TOMBSTONE + MIRROR_WAKE_CLIENT_ID, { junk: true })
  assert.equal((await h.post('/_mirror/wake-checkpoint', checkpoint('9'.repeat(64)))).status, 503)
  assert.equal(CLOUD_WAKE_CHECKPOINT_PATH.endsWith('.jsonl'), true)
})

test('under WRITER_LEASE=enforce: what HEAD does with a yielded wake checkpoint: the model is told CLOUD_WAKE_CHECKPOINT_UNAVAILABLE and the wake step still succeeds, writing nothing in MIRROR', async t => {
  const h = harness({ env: { WRITER_LEASE: 'enforce' } })
  await h.acquire(A)
  const before = h.storage.snapshot()
  const head = createStorage([
    ['bootstrap:v1', { phase: 'complete', seedId: SEED }],
    ['head:current', { ballId: BALL, epoch: 2, entries: { organ: {} } }],
    ['head:wish:active', { wish_id: 'fixture-wish', intent: 'Inspect continuity', acceptance: 'Record observed facts', status: 'running', stepsCompleted: 0, maxSteps: 6 }],
  ])
  const env = { WAKE_EXECUTOR_ENABLED: '1', DEEPSEEK_API_KEY: 'synthetic-provider-credential', PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '20',
    PROVIDER_BUDGET_TOKENS: '1000000', PROVIDER_MAX_OUTPUT_TOKENS: '400', MIRROR: { idFromName: name => name, get: () => ({ fetch: request => h.mirror.fetch(request) }) } }
  const wake = new X61HeadDurableObject({ storage: head, getWebSockets: () => [] }, env)
  wake.broadcast = async () => {}
  const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } })
  const answers = [{ content: null, tool_calls: [call('inspect', 'inspectHeadWish'), call('checkpoint', 'appendWakeCheckpoint')] }, { content: 'Observed the wish; the checkpoint waits for her browser.' }]
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: answers.shift() }] }))
  const result = await wake.executeCloudWakeStep({ now: 1_000_000 })
  assert.equal(result.status, 'success', 'the wake step goes on')
  const toolRows = [...head.data].filter(([key]) => key.startsWith('head:transcript:row:')).map(([, row]) => row).filter(row => row.role === 'tool').map(row => JSON.parse(row.content))
  const checkpoint = toolRows.find(row => row.tool_call_id === 'checkpoint')
  assert.deepEqual(JSON.parse(checkpoint.content), { ok: false, code: 'CLOUD_WAKE_CHECKPOINT_UNAVAILABLE' })
  assert.deepEqual(h.storage.snapshot(), before, 'MIRROR unchanged: no checkpoint file, no wake receipt, no fence move')
})

// ---------------------------------------------------------------------------------------------------------------
// MUST 2: the lease route

test('/_mirror/lease takes exactly {input, ownerApproved} and answers leaseAction status and body', async t => {
  clockOf(t)
  const h = harness()
  const input = { action: 'acquire', clientId: A, tabId: 'tab-a', label: 'his Chrome' }
  const a = await h.lease(input)
  assert.equal(a.status, 200)
  assert.match(a.body.lease.leaseId, /^[0-9a-f]{32}$/)
  const b = await h.acquire(B)
  assert.equal(b.status, 423)
  assert.equal(b.body.code, 'WRITER_ELSEWHERE')
  const take = { action: 'take', clientId: B, tabId: 'tab-b', label: 'his phone' }
  assert.equal((await h.lease(take, false)).status, 403)
  const taken = await h.lease(take, true)
  assert.equal(taken.status, 200)
  assert.equal(taken.body.lease.generation, 2)
  const before = h.storage.snapshot()
  for (const body of [{ input }, { input, ownerApproved: 'true' }, { input, ownerApproved: true, extra: 1 }, { ownerApproved: false }, [input], null, 'x']) {
    const answer = await h.post('/_mirror/lease', body)
    assert.equal(answer.status, 400, JSON.stringify(body))
    assert.equal(answer.body.code, 'LEASE_REQUEST_INVALID')
  }
  assert.equal((await h.post('/_mirror/lease', null, { raw: '{"input":' })).body.code, 'LEASE_REQUEST_INVALID')
  assert.equal((await h.lease({ ...input, action: 'steal' })).body.code, 'LEASE_REQUEST_INVALID')
  assert.equal((await h.post('/_mirror/lease?x=1', { input, ownerApproved: false })).status, 400)
  assert.equal((await h.get('/_mirror/lease')).status, 400)
  assert.equal((await h.post('/_mirror/lease', { input: { ...input, label: 'x'.repeat(2000) }, ownerApproved: false })).status, 413, '1 KiB at most')
  assert.deepEqual(h.storage.snapshot(), before, 'no refused body changed a row')
})

test('an unseeded world, a wrong seed, or no internal mark: no lease row is ever written', async t => {
  clockOf(t)
  const empty = createStorage()
  const h = harness({ storage: empty })
  const answer = await h.acquire(A)
  assert.equal(answer.status, 503)
  assert.equal(answer.body.code, 'BOOTSTRAP_REQUIRED')
  assert.equal(empty.data.size, 0)
  const seeded = harness()
  const before = seeded.storage.snapshot()
  assert.equal((await seeded.post('/_mirror/lease', { input: { action: 'acquire', clientId: A, tabId: 't', label: 'x' }, ownerApproved: false }, { headers: { 'x-x6-bootstrap-seed': 'f'.repeat(64) } })).status, 503)
  assert.equal((await seeded.post('/_mirror/lease', { input: { action: 'acquire', clientId: A, tabId: 't', label: 'x' }, ownerApproved: true }, { headers: { 'x-x6-internal-authorized': '0' } })).status, 401)
  assert.deepEqual(seeded.storage.snapshot(), before)
})

test('through the route (save refusal under WRITER_LEASE=enforce): his refreshed page is granted at once (generation + 1); the old page reference is 410 on a save and a thread append', async t => {
  clockOf(t)
  const h = harness({ env: { WRITER_LEASE: 'enforce' } })
  const first = await h.acquire(A)
  const again = await h.acquire(A, { tabId: 'tab-a-reloaded' })
  assert.equal(again.status, 200)
  assert.equal(again.body.lease.generation, first.body.lease.generation + 1)
  const old = await h.save(A, [note('a.md', 'old page\n')], { lease: refOf(first) })
  assert.equal(old.status, 410)
  const append = await h.post('/_mirror/thread', { op: 'append', input: await appendInput({ bytes: encoder.encode('{"line":1}\n'), lease: refOf(first) }) })
  assert.equal(append.status, 410)
  assert.equal(append.body.code, 'WRITER_GONE')
  assert.deepEqual((await h.lease({ action: 'ask', clientId: A, tabId: 'tab-a-third', label: 'his Chrome' })).body, { ok: true, asked: false })
  assert.equal((await h.acquire(B)).status, 423, 'another browser is refused exactly as before')
})

// ---------------------------------------------------------------------------------------------------------------
// MUST 4: when a browser last WROTE

test('a home save notes wrote only under WRITER_LEASE or HOME_FREEZE=enforce: ten minutes of renews every 20 s move seen and leave wrote unchanged; one applied save moves it; a replay does not', async t => {
  const clock = clockOf(t)
  // By default an applied home save writes no wave 3 row at all: `wrote` stays absent (lastWroteAt is then null).
  const plain = harness()
  assert.equal((await plain.save(A, [note('a.md', 'one\n')])).status, 200)
  assert.equal(plain.storage.data.has(WROTE), false, 'no write time by default')
  const h = harness({ env: { HOME_FREEZE: 'enforce' } })
  const a = await h.acquire(A)
  const first = await h.save(A, [note('a.md', 'one\n')])
  assert.equal(first.status, 200)
  const wroteAt = clock.now
  assert.deepEqual(h.storage.data.get(WROTE), { [A]: wroteAt })
  const seen0 = h.storage.data.get(SEEN)[A]
  for (let i = 0; i < 30; i++) {
    clock.now += 20_000
    const renew = await h.lease({ action: 'renew', clientId: A, tabId: 'tab-a', label: 'his Chrome', leaseId: a.body.lease.leaseId })
    assert.equal(renew.status, 200)
    await h.lease({ action: 'status', clientId: A, tabId: 'tab-a', label: 'his Chrome' })
    await h.lease({ action: 'ask', clientId: B, tabId: 'tab-b', label: 'his phone' })
  }
  assert.ok(h.storage.data.get(SEEN)[A] >= seen0 + 9 * 60_000, 'seen moved with the renews')
  assert.deepEqual(h.storage.data.get(WROTE), { [A]: wroteAt }, 'wrote did not move: no acquire, renew, ask or status is a write')
  const replay = await h.post('/_mirror/delta', first.envelope)
  assert.equal(replay.body.replayed, true)
  assert.deepEqual(h.storage.data.get(WROTE), { [A]: wroteAt }, 'a replayed receipt is not a write')
  clock.now += 1
  await h.save(A, [note('a.md', 'two\n')])
  assert.deepEqual(h.storage.data.get(WROTE), { [A]: clock.now }, 'one applied save moved it')
  // A take is not a write either.
  clock.now += 5
  await h.lease({ action: 'take', clientId: C, tabId: 'tab-c', label: 'a tablet' }, true)
  assert.equal(h.storage.data.get(WROTE)[C], undefined)
})

// ---------------------------------------------------------------------------------------------------------------
// MUST 5: the thread route

test('/_mirror/thread append under the lease commits in one transaction and notes wrote for the holder; ALREADY notes nothing', async t => {
  const clock = clockOf(t)
  const h = harness()
  const a = await h.acquire(A)
  const bytes = encoder.encode('{"role":"user","text":"ping 1"}\n')
  const appended = await h.post('/_mirror/thread', { op: 'append', input: await appendInput({ bytes, lease: refOf(a) }) })
  assert.equal(appended.status, 200)
  assert.equal(appended.body.code, 'APPLIED')
  assert.equal(appended.body.bytes, bytes.length)
  assert.deepEqual(h.storage.data.get(WROTE), { [A]: clock.now })
  assert.equal(h.storage.data.get('world:v1:budget').dayBytes.lines, bytes.length, 'the lines were charged in the same transaction')
  clock.now += 1000
  const again = await h.post('/_mirror/thread', { op: 'append', input: await appendInput({ bytes, lease: refOf(a) }) })
  assert.equal(again.body.code, 'ALREADY')
  assert.deepEqual(h.storage.data.get(WROTE), { [A]: clock.now - 1000 }, 'a retry that wrote nothing is not a write')
  const next = encoder.encode('{"role":"assistant","text":"pong"}\n')
  const second = await h.post('/_mirror/thread', { op: 'append', input: await appendInput({ at: bytes.length, bytes: next, have: haveOf(appended.body), lease: refOf(a) }) })
  assert.equal(second.body.code, 'APPLIED')
  assert.equal(h.storage.data.get(WROTE)[A], clock.now)
})

test('a thread write with no lease is 423 WRITER_REQUIRED; from another browser while A holds it 423 WRITER_ELSEWHERE; nothing is written', async t => {
  clockOf(t)
  const h = harness()
  const before = h.storage.snapshot()
  const none = await h.post('/_mirror/thread', { op: 'append', input: await appendInput({ bytes: encoder.encode('x\n') }) })
  assert.equal(none.status, 423)
  assert.equal(none.body.code, 'WRITER_REQUIRED')
  assert.deepEqual(h.storage.snapshot(), before)
  await h.acquire(A)
  const forged = await h.post('/_mirror/thread', { op: 'append', input: await appendInput({ bytes: encoder.encode('x\n'), lease: { leaseId: 'f'.repeat(32), generation: 1 } }) })
  assert.equal(forged.status, 423)
  assert.equal(forged.body.code, 'WRITER_ELSEWHERE')
  assert.equal(forged.body.holder.label, 'his Chrome')
  assert.equal(h.storage.data.get(WROTE), undefined)
})

test('index answers the threads plus home {pending, rescue, freeze} and the lease summary (no leaseId, no browser id)', async t => {
  clockOf(t)
  const h = harness()
  const empty = await h.post('/_mirror/thread', { op: 'index', input: {} })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body, { ok: true, threads: [], next: null, home: { pending: false, rescue: null, freeze: 'record' }, lease: null, world: { threads: 0, tailBytes: 0, retired: 0 } })
  const a = await h.acquire(A)
  await h.post('/_mirror/thread', { op: 'append', input: await appendInput({ bytes: encoder.encode('{"a":1}\n'), lease: refOf(a) }) })
  h.storage.data.set(PENDING, { rescue: '1'.repeat(32), clientId: A, since: 5, verifiedAt: 4 })
  const index = await h.post('/_mirror/thread', { op: 'index', input: {} })
  assert.equal(index.body.threads.length, 1)
  assert.deepEqual(index.body.home, { pending: true, rescue: '1'.repeat(32), freeze: 'record' })
  assert.equal(index.body.lease.label, 'his Chrome')
  assert.equal(index.body.lease.live, true)
  assert.ok(!index.text.includes(a.body.lease.leaseId))
  assert.ok(!index.text.includes(A))
  const enforced = harness({ env: { HOME_FREEZE: 'enforce' }, storage: h.storage })
  assert.equal((await enforced.post('/_mirror/thread', { op: 'index', input: {} })).body.home.freeze, 'enforce')
  assert.equal((await h.post('/_mirror/thread', { op: 'index', input: { limit: 0 } })).status, 400, 'a refused index is answered as threadCommit refused it')
})

test('a committed import with home records the pending home in the SAME transaction and notes wrote; a refused import records nothing', async t => {
  const clock = clockOf(t)
  const h = harness()
  const a = await h.acquire(A)
  const tail = encoder.encode('{"rescued":true}\n')
  const id = await threadIdForPath(PATH)
  const importInput = { id, path: PATH, piece: 2097152, from: 0, prefixChain: THREAD_ZERO_CHAIN, parts: [], tail: bytesToBase64(tail), lineEnd: tail.length, sealedLineEnd: 0, run: { client: A, from: 0 }, expect: null, lease: refOf(a) }
  const home = { rescue: '1'.repeat(32), clientId: A, base: { lineageId: LINEAGE, revision: 0 }, reconciliation: null, verifiedAt: '2026-11-12T13:58:00.000Z' }
  // Refused (no lease): nothing recorded.
  const refused = await h.post('/_mirror/thread', { op: 'import', input: { ...importInput, lease: undefined }, home })
  assert.equal(refused.status, 423)
  assert.equal(h.storage.data.get(PENDING), undefined)
  const imported = await h.post('/_mirror/thread', { op: 'import', input: importInput, home })
  assert.equal(imported.status, 200)
  assert.equal(imported.body.code, 'IMPORTED')
  assert.deepEqual(h.storage.data.get(PENDING), { rescue: '1'.repeat(32), clientId: A, since: clock.now, verifiedAt: Date.parse('2026-11-12T13:58:00.000Z') })
  assert.equal(h.storage.data.get(WROTE)[A], clock.now)
  // A second import of another thread from a rescue that names no client: imported, and the pending row is untouched.
  const path2 = '/dsh/home/sessions/abc/def/session.v1.jsonl'
  const other = { ...importInput, id: await threadIdForPath(path2), path: path2, run: { client: null, from: 0 } }
  const anonymous = await h.post('/_mirror/thread', { op: 'import', input: other, home: { ...home, rescue: '2'.repeat(32), clientId: null, verifiedAt: '2026-11-12T20:00:00.000Z' } })
  assert.equal(anonymous.body.code, 'IMPORTED')
  assert.equal(h.storage.data.get(PENDING).rescue, '1'.repeat(32), 'a rescue that names no client records nothing')
  // home is accepted only beside an import, and only in its exact shape.
  for (const body of [{ op: 'append', input: importInput, home }, { op: 'import', input: importInput, home: { ...home, extra: 1 } }, { op: 'import', input: importInput, home: { ...home, verifiedAt: 'later' } }, { op: 'index' }, { op: 1, input: {} }, { op: 'index', input: {}, more: 1 }]) {
    const answer = await h.post('/_mirror/thread', body)
    assert.equal(answer.status, 400, JSON.stringify(body).slice(0, 80))
    assert.equal(answer.body.code, 'THREAD_REQUEST_INVALID')
  }
})

test('with a pending home recorded (HOME_FREEZE=record), another browser still acquires and saves', async t => {
  clockOf(t)
  const h = harness()
  h.storage.data.set(PENDING, { rescue: '1'.repeat(32), clientId: A, since: 5, verifiedAt: 4 })
  const b = await h.acquire(B)
  assert.equal(b.status, 200)
  assert.equal((await h.save(B, [note('b.md', 'still saves\n')], { lease: refOf(b) })).status, 200)
  assert.equal((await h.save(B, [note('b.md', 'and with no reference\n')])).status, 200)
  const enforced = harness({ env: { HOME_FREEZE: 'enforce' } })
  enforced.storage.data.set(PENDING, { rescue: '1'.repeat(32), clientId: A, since: 5, verifiedAt: 4 })
  const held = await enforced.acquire(B)
  assert.equal(held.status, 423, 'enforce (wave 4) is the only mode that refuses')
  assert.deepEqual(held.body, { ok: false, code: 'HOME_PENDING', rescue: '1'.repeat(32), since: 5, label: null, lastWroteAt: null })
})

test('a storage error inside the thread transaction answers 503 and rolls everything back (lease renew, budget, rows, wrote)', async t => {
  clockOf(t)
  const h = harness()
  const a = await h.acquire(A)
  const before = h.storage.snapshot()
  h.storage.hooks.failPut = key => key.startsWith('thread:v1:index:')
  const answer = await h.post('/_mirror/thread', { op: 'append', input: await appendInput({ bytes: encoder.encode('{"a":1}\n'), lease: refOf(a) }) })
  assert.equal(answer.status, 503)
  assert.equal(answer.body.code, 'THREAD_STORAGE_UNAVAILABLE')
  assert.deepEqual(h.storage.snapshot(), before, 'nothing committed: not the lease renew, not the budget, not a tail row')
  h.storage.hooks.failPut = null
  assert.equal((await h.post('/_mirror/thread', { op: 'append', input: await appendInput({ bytes: encoder.encode('{"a":1}\n'), lease: refOf(a) }) })).body.code, 'APPLIED')
})

test('the thread route is internal: GET, a query, a body over 3 MiB, no seed: refused before any row', async t => {
  clockOf(t)
  const h = harness()
  const before = h.storage.snapshot()
  assert.equal((await h.get('/_mirror/thread')).status, 400)
  assert.equal((await h.post('/_mirror/thread?op=index', { op: 'index', input: {} })).status, 400)
  assert.equal((await h.post('/_mirror/thread', { op: 'index', input: { pad: 'x'.repeat(3 * 1024 * 1024) } })).status, 413)
  assert.equal((await h.post('/_mirror/thread', { op: 'index', input: {} }, { headers: { 'x-x6-bootstrap-seed': '0'.repeat(64) } })).status, 503)
  assert.equal((await h.post('/_mirror/thread', { op: 'index', input: {} }, { headers: { 'x-x6-internal-authorized': '' } })).status, 401)
  assert.deepEqual(h.storage.snapshot(), before)
})

// ---------------------------------------------------------------------------------------------------------------
// MUST 8: status

test('full and compact status are main\'s byte for byte, whatever the lease and thread rows hold; the lease, the pending home and the counts are on the thread index', async t => {
  clockOf(t)
  const h = harness()
  const compactBefore = (await h.get('/_mirror/status?compact=1')).text
  const expected = JSON.stringify({ ok: true, protocol: 'x61-cloud-mirror/v1', lineageId: LINEAGE, revision: 1, runtime: 'cloudflare', snapshotFormat: 'x61-mirror-snapshot/v2', snapshotETag: `"x61-mirror-snapshot-v2:${LINEAGE}:1:r${MIRROR_SECRET_RULE_VERSION}"` })
  assert.equal(compactBefore, expected, 'compact is exactly its seven fields')
  const fullBefore = (await h.get('/_mirror/status')).text
  assert.equal(Object.hasOwn(JSON.parse(fullBefore), 'world'), false, 'no world field')
  const a = await h.acquire(A)
  const bytes = encoder.encode('{"a":1}\n')
  await h.post('/_mirror/thread', { op: 'append', input: await appendInput({ bytes, lease: refOf(a) }) })
  h.storage.data.set(PENDING, { rescue: '1'.repeat(32), clientId: A, since: 5, verifiedAt: 4 })
  h.storage.data.set(SLOT_TOMBSTONE + C, { any: 1 })
  // Full and compact: the same bytes with a lease, a thread, a pending home and a tombstone in the store (the revision did not move).
  assert.equal((await h.get('/_mirror/status')).text, fullBefore)
  assert.equal((await h.get('/_mirror/status?compact=1')).text, compactBefore)
  const index = await h.post('/_mirror/thread', { op: 'index', input: {} })
  assert.equal(index.body.lease.label, 'his Chrome')
  assert.equal(index.body.lease.live, true)
  assert.deepEqual(index.body.home, { pending: true, rescue: '1'.repeat(32), freeze: 'record' })
  assert.deepEqual(index.body.world, { threads: 1, tailBytes: bytes.length, retired: 1 })
  assert.ok(!index.text.includes(a.body.lease.leaseId), 'no leaseId in the index')
  assert.ok(!index.text.includes(A), 'no browser id in the index')
})

// ---------------------------------------------------------------------------------------------------------------
// With no lease setting in the deployment, a lease is recorded and reported, never enforced against
// today's app (it knows no lease and re-posts a 423 or 410 batch every 60 s). Thread commits still need the lease.

test('default mode: while A (the /rescue page) holds a live lease, B saves with no reference, an old reference, or a corrupt lease row; the wake writes; a thread append still needs the lease', async t => {
  const clock = clockOf(t)
  const h = harness()
  const a = await h.acquire(A)
  assert.equal(a.status, 200)
  const leaseBefore = h.storage.data.get(LEASE)
  const plain = await h.save(B, [note('b.md', 'from B\n')])
  assert.equal(plain.status, 200, 'no lease reason in the default mode')
  assert.equal(plain.body.revision, 2)
  assert.deepEqual(h.storage.data.get(LEASE), leaseBefore, 'the lease is not moved by a save that carries no reference')
  const foreign = await h.save(B, [note('b.md', 'B with A reference\n')], { lease: refOf(a) })
  assert.equal(foreign.status, 200, 'a reference that is not its own is recorded, not enforced')
  const again = await h.acquire(A, { tabId: 'tab-a-reloaded' })
  const old = await h.save(A, [note('a.md', 'old page\n')], { lease: refOf(a) })
  assert.equal(old.status, 200, 'an old page reference is not refused in the default mode')
  const checkpoint = id => ({ id, at: 1000, head: { ballId: BALL, epoch: 2 }, evidence: [{ tool: 'inspectHeadWish', digest: 'd'.repeat(64) }] })
  const wake = await h.post('/_mirror/wake-checkpoint', checkpoint('e'.repeat(64)))
  assert.equal(wake.body.ok, true, 'the wake does not yield in the default mode (main answered the same)')
  const append = await h.post('/_mirror/thread', { op: 'append', input: await appendInput({ bytes: encoder.encode('{"line":1}\n') }) })
  assert.equal(append.status, 423)
  assert.equal(append.body.code, 'WRITER_REQUIRED', 'thread commits are not relaxed')
  const held = await h.post('/_mirror/thread', { op: 'append', input: await appendInput({ bytes: encoder.encode('{"line":1}\n'), lease: refOf(again) }) })
  assert.equal(held.status, 200)
  h.storage.data.set(LEASE, { junk: true })
  clock.now += 1
  assert.equal((await h.save(B, [note('b.md', 'corrupt lease row\n')])).status, 200, 'a corrupt lease row never blocks the app')
})

test('default mode: a pending home is recorded only; every browser still acquires and saves', async t => {
  clockOf(t)
  const h = harness()
  h.storage.data.set(PENDING, { rescue: '1'.repeat(32), clientId: A, since: 5, verifiedAt: 4 })
  assert.equal((await h.save(B, [note('b.md', 'B\n')])).status, 200)
  assert.equal((await h.acquire(B)).status, 200)
  assert.equal((await h.save(C, [note('c.md', 'C\n')])).status, 200)
})

test('an unknown client past seq 1 is 410 only under enforce and only for this lineage; otherwise main fence check answers and KEEPS the conflict', async t => {
  clockOf(t)
  for (const [env, lineage, code, status] of [
    [{}, LINEAGE, 'MIRROR_SEQUENCE_GAP', 409],
    [{}, '22222222-2222-4222-8222-222222222222', 'MIRROR_GLOBAL_FENCE_CONFLICT', 409],
    [{ WRITER_LEASE: 'enforce' }, '22222222-2222-4222-8222-222222222222', 'MIRROR_GLOBAL_FENCE_CONFLICT', 409],
    [{ WRITER_LEASE: 'enforce' }, LINEAGE, 'MIRROR_CLIENT_UNKNOWN', 410],
  ]) {
    const h = harness({ env })
    const fence = h.storage.data.get(FENCE)
    // Under enforce a save carries its lease (else 423 WRITER_REQUIRED before any fence check): C holds it.
    const ref = env.WRITER_LEASE === 'enforce' ? refOf(await h.acquire(C)) : null
    const batch = { id: `${C}:5`, clientId: C, seq: 5, entries: [note('c.md', 'queued\n')], cloudBase: { lineageId: lineage, revision: fence.revision } }
    const answer = await h.post('/_mirror/delta', { v: 2, batch, digest: await mirrorDigest(batch), ...(ref ? { lease: ref } : {}) })
    assert.equal(answer.status, status, JSON.stringify([env, lineage, answer.body]))
    assert.equal(answer.body.code ?? answer.body.conflictCode, code)
    const kept = [...h.storage.data.keys()].filter(key => key.startsWith('mirror:v2:conflict:')).length
    assert.equal(kept, status === 409 ? 1 : 0, 'a 409 conflict is kept at the edge as main kept it')
  }
})
