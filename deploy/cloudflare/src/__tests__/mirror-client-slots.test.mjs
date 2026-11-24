/**
 * A recycled browser slot is never a lost browser: tombstones,
 * the named answer on return, resurrection as a reader, and forgetting as the owner's act only.
 *
 * `publishLike` applies the MOUNT hooks in the exact order lease1/HANDOFF-2.md asks mirror-do.mjs
 * publishMirror to use them, over the REAL readMirrorReplayState and planMirrorReplayPrune, with the
 * receipt and head rows publishMirror writes. It is not publishMirror itself (that is not mounted yet).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { MIRROR_SLOT_IDLE_MS, MIRROR_WAKE_CLIENT_ID, planClientSlotRetire, retireClientSlot, retiredClientAnswer, retiredSlots } from '../mirror-client-slots.mjs'
import { SLOT_TOMBSTONE, SLOT_TOMBSTONE_LIMITS, retiredReply, validTombstone } from '../mirror-slot-tombstone.mjs'
import { MIRROR_REPLAY_LIMITS, planMirrorReplayPrune, readMirrorReplayState } from '../mirror-replay.mjs'
import { WORLD_LEASE, checkLease, leaseAction } from '../world-lease.mjs'

const DAY = 86400000
const T0 = 1_800_000_000_000
const LINEAGE = '12345678-1234-4234-8234-123456789abc'
const FENCE = 'mirror:v2:global-fence'
const PROTOCOL = 'x61-cloud-mirror/v1'
const X = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'
const client = index => `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
const digestOf = (clientId, seq) => createHash('sha256').update(`${clientId}:${seq}`).digest('hex')
const hasField = (value, name) => value !== null && typeof value === 'object' && (Object.hasOwn(value, name) || Object.values(value).some(inner => hasField(inner, name)))

/** In-memory storage whose transaction really rolls back when its closure throws. */
function createRollbackStorage() {
  let data = new Map()
  const viewOf = read => ({
    get: async key => (read().has(key) ? structuredClone(read().get(key)) : undefined),
    put: async (key, value) => { read().set(key, structuredClone(value)) },
    delete: async key => read().delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => {
      const out = new Map()
      for (const [key, value] of [...read().entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (!key.startsWith(prefix)) continue
        out.set(key, structuredClone(value))
        if (out.size >= limit) break
      }
      return out
    },
  })
  return {
    ...viewOf(() => data),
    async transaction(fn) {
      const staged = new Map([...data].map(([key, value]) => [key, structuredClone(value)]))
      const result = await fn(viewOf(() => staged))
      data = staged
      return result
    },
    snapshot: () => structuredClone(Object.fromEntries(data)),
  }
}

async function world() {
  const storage = createRollbackStorage()
  await storage.put(FENCE, { lineageId: LINEAGE, revision: 0 })
  return storage
}

/** Every answer, with the client it was given to. */
const answered = []

/** The MOUNT order: retired answer, replayed receipt, lease, sequence and fence, the cap (retire), the write. */
async function publishLike(storage, { clientId, seq, cloudBase, lease = null }, now, { mode = 'observe' } = {}) {
  const answer = await storage.transaction(async tx => {
    const current = await tx.get(FENCE)
    const replayState = await readMirrorReplayState(tx, current)
    // An unknown client is answered 410 only under WRITER_LEASE=enforce and for a base of this lineage.
    const retired = await retiredClientAnswer(tx, replayState, { clientId, seq, cloudBase }, { mode, fence: current })
    if (retired) return retired
    const key = `mirror:v2:receipt:${clientId}:${seq}`
    const existing = replayState.receipts.get(key)
    if (existing) return { ...existing, replayed: true }
    // As publishMirror, a lease refusal is returned only under WRITER_LEASE=enforce (the default records it).
    const writer = await checkLease(tx, lease, now, { mode, clientId })
    if (!writer.ok && mode === 'enforce') return writer
    const head = replayState.clients.get(clientId)
    // publishMirror retains these three as conflicts (retainConflict); this stand-in only answers.
    if (head && seq <= head.seq) return { ok: false, status: 409, code: 'MIRROR_REPLAY_EXPIRED' }
    if (cloudBase?.lineageId !== current.lineageId || cloudBase?.revision !== current.revision) return { ok: false, status: 409, code: 'MIRROR_GLOBAL_FENCE_CONFLICT' }
    if (seq !== (head?.seq ?? 0) + 1) return { ok: false, status: 409, code: 'MIRROR_SEQUENCE_GAP' }
    if (!head && replayState.clients.size >= MIRROR_REPLAY_LIMITS.clients && !(await retireClientSlot(tx, replayState, { incomingClientId: clientId, now }))) {
      return { ok: false, status: 507, code: 'MIRROR_CLIENT_LIMIT' }
    }
    const pruneKeys = planMirrorReplayPrune(replayState, clientId)
    const next = { lineageId: current.lineageId, revision: current.revision + 1 }
    const digest = digestOf(clientId, seq)
    const receipt = { ok: true, protocol: PROTOCOL, lineageId: next.lineageId, revision: next.revision, id: `${clientId}:${seq}`, clientId, seq, digest, applied: 1, acknowledgedAt: now }
    for (const prune of pruneKeys) await tx.delete(prune)
    await tx.put(FENCE, next)
    await tx.put(key, receipt)
    await tx.put(`mirror:v2:head:${clientId}`, { seq, digest })
    return receipt
  })
  answered.push({ to: clientId, answer })
  return answer
}

/** One save from a browser in step with the cloud. */
async function save(storage, clientId, now, lease = null) {
  const fence = await storage.get(FENCE)
  const head = await storage.get(`mirror:v2:head:${clientId}`)
  return publishLike(storage, { clientId, seq: (head?.seq ?? 0) + 1, cloudBase: fence, lease }, now)
}

async function lease(storage, action, clientId, now, extra = {}, options = {}) {
  const result = await leaseAction(storage, { action, clientId, tabId: 't1', label: clientId === X ? 'X laptop' : 'other', ...extra }, { now, ...options })
  answered.push({ to: clientId, answer: result.body })
  return result
}

const replayOf = storage => storage.transaction(async tx => readMirrorReplayState(tx, await tx.get(FENCE)))

/** A full table: `count` browsers, client(i) saving once at `at(i)`. */
async function fill(storage, count, at) {
  for (let i = 0; i < count; i++) assert.equal((await save(storage, client(i), at(i))).ok, true)
}

test('MUST 5, the acceptance case: away 31 days with unsent saves, the table fills, the retire plan runs, the browser returns', async () => {
  const storage = await world()
  // X works under the lease and saves three times, then goes offline with two saves still queued in its own IndexedDB.
  const xLease = await lease(storage, 'acquire', X, T0)
  const xRef = { leaseId: xLease.body.lease.leaseId, generation: xLease.body.lease.generation }
  for (let i = 0; i < 3; i++) assert.equal((await save(storage, X, T0 + i, xRef)).ok, true)
  const xHead = await storage.get(`mirror:v2:head:${X}`)
  const xBase = await storage.get(FENCE)
  const queued = [4, 5].map(seq => ({ clientId: X, seq, cloudBase: xBase, lease: xRef }))
  assert.deepEqual(xHead, { seq: 3, digest: digestOf(X, 3) })

  // Other browsers come and go for a month: one takes the lease after X's ran out, and releases it.
  const yLease = await lease(storage, 'acquire', client(0), T0 + 2 * DAY)
  assert.equal(yLease.status, 200)
  await fill(storage, 255, i => T0 + 2 * DAY + Math.floor(i * (28 * DAY) / 255))
  assert.equal((await lease(storage, 'release', client(0), T0 + 3 * DAY, { leaseId: yLease.body.lease.leaseId })).body.released, true)
  assert.equal((await replayOf(storage)).clients.size, 256, 'the table is full')

  // A 257th browser arrives 31 days after X's last save: the retire plan runs and only X is idle.
  const t31 = T0 + 31 * DAY
  const fresh = client(1000)
  const freshReceipt = await save(storage, fresh, t31)
  assert.equal(freshReceipt.ok, true)
  assert.equal(freshReceipt.clientId, fresh)
  assert.equal(freshReceipt.seq, 1, 'the new browser starts its OWN sequence at 1')

  // (i) Tombstoned, not deleted.
  const tomb = await storage.get(SLOT_TOMBSTONE + X)
  assert.deepEqual(tomb, { v: 1, clientId: X, state: 'retired', reason: 'idle', retiredAt: t31, lastSeenAt: T0 + 2, seq: 3, digest: xHead.digest, base: { lineageId: LINEAGE, revision: xBase.revision }, resurrectedAt: null })
  assert.equal(validTombstone(tomb, X), true)
  assert.equal(await storage.get(`mirror:v2:head:${X}`), undefined, 'its place in the 256 count is free')
  const after = await replayOf(storage)
  assert.equal(after.clients.size, 256)
  assert.equal(after.clients.has(X), false)

  // Another browser the same hour: nobody else is idle, so today's 507 stands and nothing is written.
  const busy = storage.snapshot()
  assert.deepEqual(await save(storage, client(1001), t31 + 3_600_000), { ok: false, status: 507, code: 'MIRROR_CLIENT_LIMIT' })
  assert.deepEqual(storage.snapshot(), busy)
  // Thirty-five days on everyone from that month is idle: the next new browser retires another slot; X's tombstone is untouched.
  const t65 = T0 + 65 * DAY
  assert.equal((await save(storage, client(1002), t65)).ok, true)
  assert.equal((await retiredSlots(storage, t65)).length, 2)
  assert.deepEqual(await storage.get(SLOT_TOMBSTONE + X), tomb)

  // (ii) X returns: its first request, a queued save under its old lease, is answered by name; nothing is written.
  const t70 = T0 + 70 * DAY
  const before = storage.snapshot()
  const first = await publishLike(storage, queued[0], t70)
  assert.equal(first.status, 409)
  assert.equal(first.code, 'CLIENT_SLOT_RETIRED')
  assert.equal(first.retiredAt, t31)
  assert.equal(first.retiredOn, new Date(t31).toISOString().slice(0, 10))
  assert.deepEqual(first.wayBack, { route: '/_mirror/lease', action: 'resurrect', then: '/rescue' })
  assert.match(first.message, new RegExp(`unsent work from before ${first.retiredOn}; it is kept here; open /rescue`))
  assert.equal(hasField(first, 'conflictCode'), false)
  assert.deepEqual(storage.snapshot(), before, 'no row written for a retired browser')
  for (const action of ['status', 'acquire']) {
    const answer = await lease(storage, action, X, t70)
    assert.equal(answer.status, 409, action)
    assert.equal(answer.body.code, 'CLIENT_SLOT_RETIRED')
    assert.equal(answer.body.wayBack.action, 'resurrect')
  }
  assert.equal((await publishLike(storage, { clientId: X, seq: 1, cloudBase: await storage.get(FENCE) }, t70)).code, 'CLIENT_SLOT_RETIRED', 'it cannot start again as a new browser')
  assert.deepEqual(storage.snapshot(), before)

  // (iii) Resurrection: a reader with the sequence and base it had; none of its queued batches applied or acknowledged.
  const back = await lease(storage, 'resurrect', X, t70 + 1)
  assert.equal(back.status, 200)
  assert.equal(back.body.reader, true)
  assert.deepEqual(back.body.slot, { seq: 3, base: { lineageId: LINEAGE, revision: xBase.revision }, lastSeenAt: T0 + 2, resurrectedAt: t70 + 1 })
  assert.deepEqual(back.body.unsent, { applied: false, keptIn: 'this browser', copyAt: '/rescue' })
  assert.deepEqual(await storage.get(SLOT_TOMBSTONE + X), { ...tomb, state: 'reader', resurrectedAt: t70 + 1 })
  const readerBefore = storage.snapshot()
  for (const batch of queued) {
    const answer = await publishLike(storage, batch, t70 + 2)
    assert.equal(answer.code, 'CLIENT_SLOT_RETIRED')
    assert.equal(answer.state, 'reader')
    assert.deepEqual(answer.wayBack, { open: '/rescue' })
  }
  assert.equal((await lease(storage, 'status', X, t70 + 2)).status, 200, 'a reader reads the lease status')
  assert.equal((await lease(storage, 'acquire', X, t70 + 2)).body.code, 'CLIENT_SLOT_RETIRED', 'a reader never becomes the writer')
  assert.deepEqual(storage.snapshot(), readerBefore)
  for (const key of Object.keys(readerBefore)) assert.ok(!key.startsWith(`mirror:v2:receipt:${X}`) && key !== `mirror:v2:head:${X}`, key)

  // No other browser was ever answered with X's sequence state.
  for (const { to, answer } of answered) {
    if (to === X) continue
    const text = JSON.stringify(answer)
    assert.ok(!text.includes(X) && !text.includes(xHead.digest), `${to} saw X: ${text}`)
  }

  // (iv) Only an owner-approved call drops the tombstone, and only after the grace.
  const kept = await storage.get(SLOT_TOMBSTONE + X)
  const forget = (now, retiredAt, ownerApproved) => leaseAction(storage, { action: 'forget', clientId: X, tabId: 'owner', label: 'Owner', retiredAt }, { now, ownerApproved })
  assert.equal((await forget(t31 + SLOT_TOMBSTONE_LIMITS.graceMs, t31, false)).status, 403)
  assert.equal((await forget(t31 + SLOT_TOMBSTONE_LIMITS.graceMs, t31, 'yes')).status, 403)
  assert.equal((await forget(t31 + SLOT_TOMBSTONE_LIMITS.graceMs, t31 + 1, true)).body.code, 'SLOT_TOMBSTONE_CHANGED')
  assert.deepEqual((await forget(t31 + SLOT_TOMBSTONE_LIMITS.graceMs - 1, t31, true)).body, { ok: false, code: 'SLOT_TOMBSTONE_GRACE', forgettableAt: t31 + SLOT_TOMBSTONE_LIMITS.graceMs })
  // The automatic rule keeps running for later browsers and only ever tombstones.
  assert.equal((await save(storage, client(1003), T0 + 200 * DAY)).ok, true)
  assert.deepEqual(await storage.get(SLOT_TOMBSTONE + X), kept)
  const gone = await forget(t31 + SLOT_TOMBSTONE_LIMITS.graceMs, t31, true)
  assert.deepEqual(gone, { status: 200, body: { ok: true, forgotten: true, clientId: X, retiredAt: t31 } })
  assert.equal(await storage.get(SLOT_TOMBSTONE + X), undefined)
  // Forgotten for good: its queued save is still never applied blind. Under WRITER_LEASE=enforce it is named 410; in the
  // default mode main's own fence check answers it (publishMirror keeps that conflict), never a 410.
  assert.deepEqual(await publishLike(storage, queued[0], T0 + 400 * DAY, { mode: 'enforce' }), { ok: false, code: 'MIRROR_CLIENT_UNKNOWN', status: 410 })
  const observed = await publishLike(storage, queued[0], T0 + 400 * DAY)
  assert.equal(observed.status, 409)
  assert.notEqual(observed.code, 'MIRROR_CLIENT_UNKNOWN')
})

test('MUST 1: retirement writes the tombstone and removes the rows in ONE transaction; a failure after it rolls both back', async () => {
  const storage = await world()
  await fill(storage, 256, i => T0 + i)
  await save(storage, client(0), T0 + 40 * DAY) // the newest receipt: client 0 is never chosen
  const before = storage.snapshot()
  await assert.rejects(storage.transaction(async tx => {
    const state = await readMirrorReplayState(tx, await tx.get(FENCE))
    const result = await retireClientSlot(tx, state, { incomingClientId: client(999), now: T0 + 40 * DAY })
    assert.equal(result.retired, client(1))
    assert.equal((await tx.get(SLOT_TOMBSTONE + client(1))).seq, 1)
    throw new Error('STORAGE_WRITE_FAILED')
  }), /STORAGE_WRITE_FAILED/)
  assert.deepEqual(storage.snapshot(), before)
})

test('MUST 1: tombstones are bounded (SLOT_TOMBSTONE_LIMITS.count); at the bound nothing is retired (today 507) and nothing is written', async () => {
  const storage = await world()
  await fill(storage, 256, i => T0 + i)
  await save(storage, client(0), T0 + 40 * DAY)
  const row = i => ({ v: 1, clientId: client(5000 + i), state: 'retired', reason: 'idle', retiredAt: T0, lastSeenAt: T0, seq: 1, digest: digestOf('t', i), base: { lineageId: LINEAGE, revision: 1 }, resurrectedAt: null })
  for (let i = 0; i < SLOT_TOMBSTONE_LIMITS.count - 1; i++) await storage.put(SLOT_TOMBSTONE + client(5000 + i), row(i))
  const now = T0 + 40 * DAY
  const room = storage.snapshot()
  assert.equal((await save(storage, client(999), now)).ok, true, 'one below the bound: one more may be written')
  assert.equal(Object.keys(storage.snapshot()).filter(key => key.startsWith(SLOT_TOMBSTONE)).length, SLOT_TOMBSTONE_LIMITS.count)
  assert.notDeepEqual(storage.snapshot(), room)
  const full = storage.snapshot()
  assert.deepEqual(await save(storage, client(998), now + 1), { ok: false, status: 507, code: 'MIRROR_CLIENT_LIMIT' })
  assert.deepEqual(storage.snapshot(), full, 'nothing dropped, nothing written')
  const state = await replayOf(storage)
  assert.equal(planClientSlotRetire(state, { incomingClientId: client(998), now: now + 1, tombstoneCount: SLOT_TOMBSTONE_LIMITS.count }), null)
  assert.notEqual(planClientSlotRetire(state, { incomingClientId: client(998), now: now + 1, tombstoneCount: SLOT_TOMBSTONE_LIMITS.count - 1 }), null)
})

test('MUST 1: retirement spares a kept conflict, the lease holder (even expired) and a browser whose lease row is unreadable', async () => {
  const storage = await world()
  await fill(storage, 256, i => T0 + i)
  await save(storage, client(0), T0 + 40 * DAY)
  const now = T0 + 40 * DAY
  const pick = () => storage.transaction(async tx => {
    const state = await readMirrorReplayState(tx, await tx.get(FENCE))
    const result = await retireClientSlot(tx, state, { incomingClientId: client(999), now })
    throw Object.assign(new Error('ROLLBACK'), { result })
  }).catch(error => error.result?.retired ?? null)
  assert.equal(await pick(), client(1))
  await storage.put('mirror:v2:conflict:' + 'c'.repeat(64), { id: 'c'.repeat(64), clientId: client(1) })
  assert.equal(await pick(), client(2))
  assert.equal((await lease(storage, 'acquire', client(2), T0)).status, 200)
  assert.equal(await pick(), client(3), 'an expired lease holder is still spared')
  await storage.put('world:v1:lease', { broken: true })
  assert.equal(await pick(), null, 'unknown holder: retire nothing')
})

test('MUST 2: every lease action of a retired browser is the named 409; resurrect is idempotent; a reader may read the status only', async () => {
  const storage = await world()
  const tomb = { v: 1, clientId: X, state: 'retired', reason: 'idle', retiredAt: T0, lastSeenAt: T0 - DAY, seq: 9, digest: digestOf(X, 9), base: { lineageId: LINEAGE, revision: 40 }, resurrectedAt: null }
  await storage.put(SLOT_TOMBSTONE + X, tomb)
  const before = storage.snapshot()
  for (const [action, extra, options] of [['status'], ['acquire'], ['renew', { leaseId: 'a'.repeat(32) }], ['ask'], ['release', { leaseId: 'a'.repeat(32) }], ['take', {}, { ownerApproved: true }]]) {
    const answer = await lease(storage, action, X, T0 + DAY, extra, options)
    assert.equal(answer.status, 409, action)
    const { message, ...rest } = answer.body
    assert.deepEqual(rest, { ok: false, code: 'CLIENT_SLOT_RETIRED', state: 'retired', retiredAt: T0, retiredOn: new Date(T0).toISOString().slice(0, 10), slot: { seq: 9, base: { lineageId: LINEAGE, revision: 40 }, lastSeenAt: T0 - DAY, resurrectedAt: null }, wayBack: { route: '/_mirror/lease', action: 'resurrect', then: '/rescue' } })
    assert.match(message, /set aside on .* Bring it back as a reader/)
  }
  // checkLease names it too (thread writes), with or without a lease reference.
  for (const ref of [null, { leaseId: 'a'.repeat(32), generation: 1 }]) {
    const answer = await storage.transaction(tx => checkLease(tx, ref, T0 + DAY, { mode: 'observe', clientId: X }))
    assert.equal(answer.code, 'CLIENT_SLOT_RETIRED')
    assert.equal(answer.status, 409)
  }
  assert.deepEqual(storage.snapshot(), before)
  const one = await lease(storage, 'resurrect', X, T0 + 2 * DAY)
  const two = await lease(storage, 'resurrect', X, T0 + 3 * DAY)
  assert.deepEqual(two.body, one.body, 'a second resurrect changes nothing')
  assert.equal(one.body.slot.resurrectedAt, T0 + 2 * DAY)
  assert.equal((await lease(storage, 'status', X, T0 + 3 * DAY)).status, 200)
  for (const action of ['acquire', 'ask']) assert.equal((await lease(storage, action, X, T0 + 3 * DAY)).body.state, 'reader')
  // Resurrecting an id that was never retired writes nothing.
  const plain = storage.snapshot()
  assert.deepEqual((await lease(storage, 'resurrect', client(1), T0)).body, { ok: true, resurrected: false, retired: false })
  assert.deepEqual(storage.snapshot(), plain)
  for (const answer of answered.map(item => item.answer)) assert.equal(hasField(answer, 'conflictCode'), false)
})

test('MUST 2: a malformed tombstone is 503 everywhere, never read as "no tombstone"', async () => {
  const storage = await world()
  await storage.put(SLOT_TOMBSTONE + X, { v: 1, clientId: X, state: 'gone' })
  assert.deepEqual((await lease(storage, 'acquire', X, T0)).body, { ok: false, code: 'SLOT_TOMBSTONE_UNAVAILABLE' })
  assert.deepEqual((await lease(storage, 'resurrect', X, T0)).body, { ok: false, code: 'SLOT_TOMBSTONE_UNAVAILABLE' })
  assert.deepEqual(await publishLike(storage, { clientId: X, seq: 1, cloudBase: await storage.get(FENCE) }, T0), { ok: false, status: 503, code: 'SLOT_TOMBSTONE_UNAVAILABLE' })
  assert.equal((await storage.transaction(tx => checkLease(tx, null, T0, { clientId: X }))).status, 503)
  assert.equal((await leaseAction(storage, { action: 'forget', clientId: X, tabId: 'o', label: 'Owner', retiredAt: T0 }, { now: T0 + 400 * DAY, ownerApproved: true })).status, 503)
  assert.equal((await storage.get(SLOT_TOMBSTONE + X)).state, 'gone', 'kept as it was')
})

test('MUST 4: forget is refused without the approval, for an unknown id, a changed retiredAt or inside the grace; it touches only that row', async () => {
  const storage = await world()
  const tomb = id => ({ v: 1, clientId: id, state: 'retired', reason: 'idle', retiredAt: T0, lastSeenAt: T0, seq: 1, digest: digestOf(id, 1), base: { lineageId: LINEAGE, revision: 1 }, resurrectedAt: null })
  await storage.put(SLOT_TOMBSTONE + X, tomb(X))
  await storage.put(SLOT_TOMBSTONE + client(1), tomb(client(1)))
  const late = T0 + SLOT_TOMBSTONE_LIMITS.graceMs
  const forget = (clientId, retiredAt, now, ownerApproved) => leaseAction(storage, { action: 'forget', clientId, tabId: 'owner', label: 'Owner', retiredAt }, { now, ownerApproved })
  const before = storage.snapshot()
  assert.equal((await forget(X, T0, late)).body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal((await forget(client(2), T0, late, true)).body.code, 'SLOT_TOMBSTONE_NOT_FOUND')
  assert.deepEqual((await forget(X, T0 - 1, late, true)).body, { ok: false, code: 'SLOT_TOMBSTONE_CHANGED', retiredAt: T0 })
  assert.equal((await forget(X, T0, late - 1, true)).body.code, 'SLOT_TOMBSTONE_GRACE')
  assert.deepEqual(storage.snapshot(), before, 'every refusal keeps the tombstone')
  for (const bad of [{ action: 'forget', clientId: X, tabId: 'o', label: 'O' }, { action: 'forget', clientId: X, tabId: 'o', label: 'O', retiredAt: -1 }, { action: 'forget', clientId: X, tabId: 'o', label: 'O', retiredAt: '1' }, { action: 'status', clientId: X, tabId: 'o', label: 'O', retiredAt: T0 }, { action: 'resurrect', clientId: X, tabId: 'o', label: 'O', retiredAt: T0 }]) {
    assert.deepEqual(await leaseAction(storage, bad, { now: late, ownerApproved: true }), { status: 400, body: { ok: false, code: 'LEASE_REQUEST_INVALID' } }, JSON.stringify(bad))
  }
  assert.equal((await forget(X, T0, late, true)).body.forgotten, true)
  assert.deepEqual(await storage.get(SLOT_TOMBSTONE + client(1)), tomb(client(1)), 'the other tombstone is untouched')
  assert.deepEqual((await retiredSlots(storage, late)).map(row => [row.clientId, row.forgettable]), [[client(1), true]])
})

test('SHOULD: among idle slots, prefer one the edge has not seen at work after its last save, then the oldest', async () => {
  const storage = await world()
  await fill(storage, 256, i => T0 + i * 1000)
  await save(storage, client(0), T0 + 60 * DAY)
  const state = await replayOf(storage)
  const now = T0 + 60 * DAY
  const plan = seen => planClientSlotRetire(state, { incomingClientId: client(999), now, seen })?.retired
  assert.equal(plan({}), client(1), 'oldest first')
  assert.equal(plan({ [client(1)]: T0 + 5 * DAY }), client(2), 'client 1 was seen at work after its last save: maybe unsent work')
  assert.equal(plan({ [client(1)]: T0 }), client(1), 'seen before its last save: no sign of unsent work')
  const allSeen = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [client(i), T0 + 10 * DAY]))
  assert.equal(plan(allSeen), client(1), 'a preference, not a refusal: the oldest of the seen')
  assert.ok(MIRROR_SLOT_IDLE_MS === 30 * DAY)
})

// The fixed client id appendMirrorWakeCheckpoint (mirror-do.mjs) writes its head and receipts under.
const WAKE = '5e000004-0000-4000-8000-000000000004'

test('review MUST 1: the cloud wake client is never retired, even when it is the oldest idle slot', async () => {
  // One id: the exported constant is the one appendMirrorWakeCheckpoint writes under (literal today, import once mounted).
  assert.equal(MIRROR_WAKE_CLIENT_ID, WAKE)
  const source = await readFile(new URL('../mirror-do.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes(`'${WAKE}'`) || /const clientId = MIRROR_WAKE_CLIENT_ID\b/.test(source), 'mirror-do.mjs wake client id drifted')
  const storage = await world()
  assert.equal((await save(storage, WAKE, T0 - DAY)).ok, true, 'the wake checkpoint wrote first, long ago')
  await fill(storage, 255, i => T0 + i)
  await save(storage, client(0), T0 + 40 * DAY)
  const now = T0 + 40 * DAY
  const state = await replayOf(storage)
  assert.equal(state.clients.size, 256)
  assert.equal(planClientSlotRetire(state, { incomingClientId: client(999), now })?.retired, client(1), 'the next idle slot, never the wake client')
  assert.equal((await save(storage, client(999), now)).ok, true)
  assert.notEqual(await storage.get(`mirror:v2:head:${WAKE}`), undefined, 'the wake client keeps its head')
  assert.equal(await storage.get(SLOT_TOMBSTONE + WAKE), undefined, 'and has no tombstone')
  assert.equal(await storage.get(SLOT_TOMBSTONE + client(1)) !== undefined, true)
  // With only the wake client idle, nothing is retired: today's 507.
  const only = await world()
  assert.equal((await save(only, WAKE, T0 - DAY)).ok, true)
  await fill(only, 255, i => T0 + 39 * DAY + i)
  assert.deepEqual(await save(only, client(999), now), { ok: false, status: 507, code: 'MIRROR_CLIENT_LIMIT' })
  assert.equal(await only.get(SLOT_TOMBSTONE + WAKE), undefined)
})

test('review MUST 1: a tombstoned id that still has a head is skipped and the next idle slot is retired, never a stuck 507', async () => {
  const storage = await world()
  await fill(storage, 256, i => T0 + i)
  await save(storage, client(0), T0 + 40 * DAY)
  // A head re-created for a tombstoned id (the shape the wake path could leave before its MOUNT fix).
  await storage.put(SLOT_TOMBSTONE + client(1), { v: 1, clientId: client(1), state: 'retired', reason: 'idle', retiredAt: T0, lastSeenAt: T0, seq: 1, digest: digestOf(client(1), 1), base: { lineageId: LINEAGE, revision: 1 }, resurrectedAt: null })
  const kept = await storage.get(SLOT_TOMBSTONE + client(1))
  const now = T0 + 40 * DAY
  const fresh = await save(storage, client(999), now)
  assert.equal(fresh.ok, true, 'another idle slot exists, so the new browser saves')
  assert.notEqual(await storage.get(SLOT_TOMBSTONE + client(2)), undefined, 'the next idle slot was retired')
  assert.deepEqual(await storage.get(SLOT_TOMBSTONE + client(1)), kept, 'the existing tombstone is untouched')
})

test('review MUST 2: a slot the edge saw at work within 30 days is never retired; with no other idle slot it is 507', async () => {
  const storage = await world()
  await fill(storage, 256, i => T0 + i * 1000)
  await save(storage, client(0), T0 + 60 * DAY)
  const now = T0 + 60 * DAY
  const state = await replayOf(storage)
  const plan = seen => planClientSlotRetire(state, { incomingClientId: client(999), now, seen })?.retired ?? null
  const seenAll = at => Object.fromEntries(Array.from({ length: 256 }, (_, i) => [client(i), at]))
  assert.equal(plan(seenAll(now - 5 * DAY)), null, 'every idle-by-ack slot was seen at work 5 days ago: none is idle')
  assert.equal(plan({ ...seenAll(now - DAY), [client(7)]: now - MIRROR_SLOT_IDLE_MS }), null, 'exactly 30 days unseen is not yet idle')
  assert.equal(plan({ ...seenAll(now - DAY), [client(7)]: now - MIRROR_SLOT_IDLE_MS - 1 }), client(7), 'unseen for more than 30 days: idle')
  assert.equal(plan({ [client(1)]: now - DAY }), client(2), 'client 1 was seen yesterday: not idle, whatever its last acknowledged save')
  // Through the transaction: browser L keeps its lease alive daily while its saves go unacknowledged for 31 days.
  const live = await world()
  await fill(live, 256, i => T0 + i)
  await save(live, client(0), T0 + 40 * DAY)
  for (let i = 1; i < 256; i++) {
    if (i === 1) continue
    await live.put(`mirror:v2:receipt:${client(i)}:1`, { ...(await live.get(`mirror:v2:receipt:${client(i)}:1`)), acknowledgedAt: T0 + 39 * DAY })
  }
  const l = await lease(live, 'acquire', client(1), T0 + 39 * DAY)
  assert.equal(l.status, 200)
  assert.equal((await lease(live, 'release', client(1), T0 + 39 * DAY, { leaseId: l.body.lease.leaseId })).body.released, true)
  const before = live.snapshot()
  assert.deepEqual(await save(live, client(999), T0 + 40 * DAY), { ok: false, status: 507, code: 'MIRROR_CLIENT_LIMIT' })
  assert.deepEqual(live.snapshot(), before, 'L is not tombstoned')
  assert.equal(await live.get(SLOT_TOMBSTONE + client(1)), undefined)
})

test('review SHOULD: the tombstone bound is 4,096 (about 300 bytes each), above any realistic 180-day churn', () => {
  assert.equal(SLOT_TOMBSTONE_LIMITS.count, 4096)
  assert.equal(SLOT_TOMBSTONE_LIMITS.graceMs, 180 * DAY)
})

test('retiredReply carries no conflictCode, and the lease suite TTL is unchanged by this job', () => {
  const reply = retiredReply({ v: 1, clientId: X, state: 'retired', reason: 'idle', retiredAt: T0, lastSeenAt: T0, seq: 1, digest: digestOf(X, 1), base: { lineageId: LINEAGE, revision: 1 }, resurrectedAt: null })
  assert.equal(hasField(reply, 'conflictCode'), false)
  assert.equal(reply.status, 409)
  assert.ok(!/token/i.test(JSON.stringify(reply)))
  assert.equal(WORLD_LEASE.ttlMs, 90000)
})
