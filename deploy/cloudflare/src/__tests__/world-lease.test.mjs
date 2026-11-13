/** One writer for her whole world (world-lease.mjs) and recyclable browser slots (mirror-client-slots.mjs). */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORLD_LEASE, WORLD_LEASE_LIMITS, leaseAction, checkLease, leaseMode, homeFreezeMode,
  leaseSummary, clientSeenAt, edgeMayWrite,
} from '../world-lease.mjs'
import { planClientSlotRetire, retiredClientAnswer } from '../mirror-client-slots.mjs'
import { readMirrorReplayState } from '../mirror-replay.mjs'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LEASE = 'world:v1:lease'
const LOG = 'world:v1:lease-log'
const SEEN = 'world:v1:seen'
const PENDING = 'world:v1:home-pending'
const T0 = 1_800_000_000_000

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

// Every answer the suite sees, so suite-wide laws can be asserted at the end.
const writeAnswers = []
const allBodies = []
const clock = { now: T0 }
const tick = ms => { clock.now += ms }

async function act(storage, action, clientId, extra = {}, options = {}) {
  const { leaseId, tabId = clientId === A ? 'tab-a' : clientId === B ? 'tab-b' : 'tab-c', label = clientId === A ? 'A laptop' : clientId === B ? 'B phone' : 'C tablet' } = extra
  const input = { action, clientId, tabId, label, ...(leaseId ? { leaseId } : {}) }
  const result = await leaseAction(storage, input, { now: clock.now, ...options })
  allBodies.push(result.body)
  return result
}

async function write(storage, ref, options = {}) {
  return storage.transaction(async tx => {
    const result = await checkLease(tx, ref, clock.now, { mode: 'observe', ...options })
    writeAnswers.push(result)
    allBodies.push(result)
    return result
  })
}

const refOf = grant => ({ leaseId: grant.body.lease.leaseId, generation: grant.body.lease.generation })
const fresh = () => { clock.now = T0; return createRollbackStorage() }

test('A acquires; B is refused with A label and never sees a leaseId; A writes with its ref and renews', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  assert.equal(a.status, 200)
  assert.match(a.body.lease.leaseId, /^[0-9a-f]{32}$/)
  assert.equal(a.body.lease.generation, 1)
  assert.equal(a.body.lease.expiresAt, T0 + WORLD_LEASE.ttlMs)
  const again = await act(storage, 'acquire', A)
  assert.equal(again.body.lease.leaseId, a.body.lease.leaseId, 'the same tab gets the same lease again')
  const bAnswers = [await act(storage, 'acquire', B), await act(storage, 'status', B), await act(storage, 'ask', B)]
  assert.equal(bAnswers[0].status, 423)
  assert.equal(bAnswers[0].body.code, 'WRITER_ELSEWHERE')
  assert.equal(bAnswers[0].body.holder.label, 'A laptop')
  assert.equal(bAnswers[0].body.holder.since, T0)
  for (const answer of bAnswers) assert.ok(!JSON.stringify(answer).includes(a.body.lease.leaseId), 'leaseId never shown to B')
  assert.ok(!JSON.stringify(bAnswers).includes('leaseId'))
  tick(10_000)
  const w = await write(storage, refOf(a), { clientId: A })
  // The verdict names the expiry the lease had before this write (the extension is only staged).
  assert.deepEqual(w, { ok: true, clientId: A, leased: true, heldUntil: again.body.lease.expiresAt })
  assert.equal((await storage.get(LEASE)).expiresAt, clock.now + WORLD_LEASE.ttlMs, 'a write renews')
  assert.equal((await storage.get(LEASE)).seenAt, clock.now)
})

test('observe, no ref: judged by clientId; a no-ref write never renews', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  tick(5_000)
  const b = await write(storage, null, { clientId: B })
  assert.equal(b.ok, false)
  assert.equal(b.status, 423)
  assert.equal(b.code, 'WRITER_ELSEWHERE')
  assert.equal(b.holder.label, 'A laptop')
  const before = await storage.get(LEASE)
  const seenBefore = await storage.get(SEEN)
  const own = await write(storage, null, { clientId: A })
  assert.deepEqual(own, { ok: true, clientId: A, leased: false }, 'her own home save with no ref passes')
  assert.equal((await storage.get(LEASE)).expiresAt, before.expiresAt, 'no ref never renews')
  assert.deepEqual(await storage.get(SEEN), seenBefore, 'no ref never touches seen')
  const anon = await write(storage, null, { clientId: null })
  assert.equal(anon.status, 423)
  assert.equal(anon.code, 'WRITER_ELSEWHERE')
  await act(storage, 'release', A, { leaseId: a.body.lease.leaseId })
  assert.deepEqual(await write(storage, null, { clientId: null }), { ok: true, clientId: null, leased: false }, 'free lease: a no-ref write passes')
  assert.deepEqual(await write(storage, null, { clientId: B }), { ok: true, clientId: B, leased: false })
  assert.equal(await clientSeenAt(storage, B), null, 'a no-ref write never notes its client')
})

test('enforce, no ref: WRITER_REQUIRED for everyone, the holder included; a ref still passes', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  for (const clientId of [A, B, null]) {
    const answer = await write(storage, null, { mode: 'enforce', clientId })
    assert.deepEqual(answer, { ok: false, code: 'WRITER_REQUIRED', status: 423 })
  }
  await act(storage, 'release', A, { leaseId: a.body.lease.leaseId })
  assert.equal((await write(storage, null, { mode: 'enforce', clientId: A })).code, 'WRITER_REQUIRED', 'even with no lease at all')
  const again = await act(storage, 'acquire', A)
  assert.equal((await write(storage, refOf(again), { mode: 'enforce', clientId: A })).ok, true)
})

test('after ttlMs with no renew B acquires; A write is 423 naming B, A renew is 410', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  tick(WORLD_LEASE.ttlMs + 1)
  const b = await act(storage, 'acquire', B)
  assert.equal(b.status, 200)
  assert.equal(b.body.lease.generation, 2)
  assert.notEqual(b.body.lease.leaseId, a.body.lease.leaseId)
  assert.deepEqual(await write(storage, refOf(a), { clientId: A }), { ok: false, code: 'WRITER_ELSEWHERE', status: 423, holder: { label: 'B phone', since: clock.now, seenAt: clock.now } })
  const renew = await act(storage, 'renew', A, { leaseId: a.body.lease.leaseId })
  assert.equal(renew.status, 410)
  assert.equal(renew.body.code, 'WRITER_GONE')
  assert.equal((await storage.get(LEASE)).holder.clientId, B)
})

test('a ref whose generation moved is 410 even when its leaseId matches, and the reverse', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  const ref = refOf(a)
  assert.deepEqual(await write(storage, { ...ref, generation: ref.generation + 1 }, { clientId: A }), { ok: false, code: 'WRITER_GONE', status: 410 })
  assert.deepEqual(await write(storage, { ...ref, leaseId: 'f'.repeat(32) }, { clientId: A }), { ok: false, code: 'WRITER_GONE', status: 410 })
  assert.equal((await write(storage, ref, { clientId: A })).ok, true)
})

// A lease that ran out is never revived, by a write or a renew (the earlier "sleeping timer" is reversed).
test('a lease that ran out, even one nobody took, is never revived: its write and its renew are 410 WRITER_GONE, nothing is written, and the browser acquires a fresh lease', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  tick(WORLD_LEASE.ttlMs * 3)
  assert.equal(await edgeMayWrite(storage, clock.now), true)
  const before = storage.snapshot()
  assert.deepEqual(await write(storage, refOf(a), { clientId: A }), { ok: false, code: 'WRITER_GONE', status: 410 })
  assert.deepEqual(await write(storage, refOf(a)), { ok: false, code: 'WRITER_GONE', status: 410 }, 'a thread write (no client id) too')
  const renew = await act(storage, 'renew', A, { leaseId: a.body.lease.leaseId })
  assert.equal(renew.status, 410)
  assert.equal(renew.body.code, 'WRITER_GONE')
  assert.deepEqual(storage.snapshot(), before, 'nothing written: not the lease row, not seen')
  // At the expiry exactly the lease is no longer live either.
  const b = fresh()
  const held = await act(b, 'acquire', A)
  tick(WORLD_LEASE.ttlMs)
  assert.equal((await write(b, refOf(held), { clientId: A })).status, 410)
  const again = await act(storage, 'acquire', A)
  assert.equal(again.status, 200)
  assert.equal(again.body.lease.generation, 2, 'a fresh lease, never the old one revived')
})

test('a write extends a LIVE lease, never past acquiredAt + writeHoldMs; past that only an explicit renew while live keeps it', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  assert.equal(WORLD_LEASE.writeHoldMs, 30 * 60_000)
  // A write every 60 s: each extends to now + ttl until the stated total.
  for (let at = 60_000; at <= WORLD_LEASE.writeHoldMs + 60_000; at += 60_000) {
    clock.now = T0 + at
    const w = await write(storage, refOf(a), { clientId: A })
    const row = await storage.get(LEASE)
    if (at < WORLD_LEASE.writeHoldMs) {
      assert.equal(w.ok, true, `at ${at}`)
      assert.equal(row.expiresAt, Math.min(clock.now + WORLD_LEASE.ttlMs, T0 + WORLD_LEASE.writeHoldMs), `at ${at}`)
    } else {
      assert.deepEqual(w, { ok: false, code: 'WRITER_GONE', status: 410 }, `writes alone never hold it past the total (at ${at})`)
      assert.equal(row.expiresAt, T0 + WORLD_LEASE.writeHoldMs)
    }
  }
  // The holder that renews while live keeps it past the total.
  const c = fresh()
  const held = await act(c, 'acquire', A)
  for (let at = 20_000; at <= WORLD_LEASE.writeHoldMs + 60_000; at += 20_000) {
    clock.now = T0 + at
    assert.equal((await act(c, 'renew', A, { leaseId: held.body.lease.leaseId })).status, 200, `renew at ${at}`)
  }
  assert.equal((await write(c, refOf(held), { clientId: A })).ok, true, 'a renewed lease past the total still writes')
  assert.equal((await c.get(LEASE)).expiresAt, clock.now + WORLD_LEASE.ttlMs, 'and the write does not shorten it')
})

test('the lease is judged on the clock read AFTER its row is read: a read held past the expiry refuses (410), writes nothing, renews nothing', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  const expiresAt = a.body.lease.expiresAt
  clock.now = expiresAt - 1000
  const before = storage.snapshot()
  const answer = await storage.transaction(async tx => {
    const held = { ...tx, get: async key => { const value = await tx.get(key); if (key === LEASE) clock.now = expiresAt + 1; return value } }
    return checkLease(held, refOf(a), () => clock.now, { mode: 'observe' })
  })
  assert.deepEqual(answer, { ok: false, code: 'WRITER_GONE', status: 410 })
  assert.deepEqual(storage.snapshot(), before, 'the lease was not renewed')
  assert.equal((await act(storage, 'acquire', B)).status, 200, 'another browser acquires at the original expiry')
  // The same for a renew whose row read is held past the expiry.
  const r = fresh()
  const mine = await act(r, 'acquire', A)
  clock.now = mine.body.lease.expiresAt - 1000
  const slow = { ...r, transaction: fn => r.transaction(tx => fn({ ...tx, get: async key => { const value = await tx.get(key); if (key === LEASE) clock.now = mine.body.lease.expiresAt + 1; return value } })) }
  const late = await leaseAction(slow, { action: 'renew', clientId: A, tabId: 'tab-a', label: 'A laptop', leaseId: mine.body.lease.leaseId }, { now: () => clock.now })
  assert.equal(late.status, 410)
  assert.equal((await r.get(LEASE)).expiresAt, mine.body.lease.expiresAt, 'not renewed')
})

test('ask records the asker; A sees it on renew; the lease is not ended; a free lease answers free', async () => {
  const storage = fresh()
  assert.deepEqual((await act(storage, 'ask', B)).body, { ok: true, free: true })
  const a = await act(storage, 'acquire', A)
  tick(1_000)
  const ask = await act(storage, 'ask', B)
  assert.equal(ask.status, 202)
  assert.deepEqual(ask.body, { ok: true, asked: true, holder: { label: 'A laptop', since: T0 + 0, seenAt: T0 } })
  tick(1_000)
  const renew = await act(storage, 'renew', A, { leaseId: a.body.lease.leaseId })
  assert.deepEqual(renew.body.asked, { label: 'B phone', at: T0 + 1_000 })
  assert.equal(renew.body.lease.leaseId, a.body.lease.leaseId)
  assert.equal((await act(storage, 'acquire', B)).status, 423, 'asking never ends a lease')
  assert.equal((await act(storage, 'status', A)).body.lease.asked.label, 'B phone')
})

test('take needs the owner approval; with it the generation moves, the log has one row, A write is 423, A renew 410', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  const before = storage.snapshot()
  const refused = await act(storage, 'take', B)
  assert.equal(refused.status, 403)
  assert.equal(refused.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal((await act(storage, 'take', B, {}, { ownerApproved: 'yes' })).status, 403, 'only === true approves')
  assert.deepEqual(storage.snapshot(), before, 'a refused take changes nothing')
  tick(2_000)
  const taken = await act(storage, 'take', B, {}, { ownerApproved: true })
  assert.equal(taken.status, 200)
  assert.equal(taken.body.lease.generation, 2)
  const log = await storage.get(LOG)
  assert.equal(log.length, 1)
  assert.deepEqual(log[0], { at: clock.now, from: { clientId: A, tabId: 'tab-a', label: 'A laptop' }, to: { clientId: B, tabId: 'tab-b', label: 'B phone' }, generation: 2 })
  const lost = await write(storage, refOf(a), { clientId: A })
  assert.equal(lost.status, 423)
  assert.equal(lost.code, 'WRITER_ELSEWHERE')
  assert.equal(lost.holder.label, 'B phone')
  assert.equal((await act(storage, 'renew', A, { leaseId: a.body.lease.leaseId })).status, 410)
  assert.equal((await write(storage, refOf(taken), { clientId: B })).ok, true)
})

test('the take log keeps the last 16 rows', async () => {
  const storage = fresh()
  for (let i = 0; i < 20; i++) {
    tick(1)
    const taken = await act(storage, 'take', i % 2 ? A : B, {}, { ownerApproved: true })
    assert.equal(taken.body.lease.generation, i + 1)
  }
  const log = await storage.get(LOG)
  assert.equal(log.length, WORLD_LEASE_LIMITS.log)
  assert.deepEqual(log.map(row => row.generation), Array.from({ length: 16 }, (_, i) => i + 5))
})

test('release twice is fine; the generation is kept; a stranger release changes nothing', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  const stranger = await act(storage, 'release', B, { leaseId: 'e'.repeat(32) })
  assert.deepEqual(stranger.body, { ok: true, released: false })
  assert.equal((await storage.get(LEASE)).holder.clientId, A)
  assert.deepEqual((await act(storage, 'release', A, { leaseId: a.body.lease.leaseId })).body, { ok: true, released: true })
  assert.deepEqual((await act(storage, 'release', A, { leaseId: a.body.lease.leaseId })).body, { ok: true, released: false })
  assert.deepEqual((await act(storage, 'status', B)).body, { ok: true, lease: null })
  assert.equal((await storage.get(LEASE)).generation, 1)
  assert.equal((await write(storage, refOf(a), { clientId: A })).status, 410, 'a released lease is gone')
  assert.equal((await act(storage, 'acquire', B)).body.lease.generation, 2)
})

test('the generation only ever grows across 1,000 random actions', async () => {
  const storage = fresh()
  let seed = 0x5eed
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = list => list[Math.floor(random() * list.length)]
  const held = new Map()
  let last = 0
  for (let i = 0; i < 1000; i++) {
    tick(Math.floor(random() * 60_000))
    const clientId = pick([A, B, C])
    const action = pick(['status', 'acquire', 'renew', 'ask', 'release', 'take', 'write'])
    if (action === 'write') {
      const ref = held.get(clientId) ?? null
      const answer = await write(storage, ref, { mode: pick(['observe', 'enforce']), clientId })
      if (!answer.ok) assert.ok([423, 410].includes(answer.status))
    } else {
      const leaseId = held.get(clientId)?.leaseId ?? (action === 'renew' || action === 'release' ? 'd'.repeat(32) : undefined)
      const answer = await act(storage, action, clientId, leaseId ? { leaseId } : {}, { ownerApproved: random() < 0.5 })
      if (answer.body.lease?.leaseId) held.set(clientId, refOf(answer))
    }
    const generation = (await storage.get(LEASE))?.generation ?? 0
    assert.ok(generation >= last, `generation fell from ${last} to ${generation} at step ${i}`)
    last = generation
  }
  assert.ok(last > 10, 'the walk really moved the lease')
})

test('a malformed ref in checkLease is 423, never 400', async () => {
  const storage = fresh()
  await act(storage, 'acquire', A)
  const malformed = ['x', 42, [], { leaseId: 'ABC' }, { leaseId: 'a'.repeat(32) }, { leaseId: 'a'.repeat(32), generation: 0 }, { leaseId: 'A'.repeat(32), generation: 1 }, { generation: 1 }]
  for (const ref of malformed) {
    for (const mode of ['observe', 'enforce']) {
      const answer = await write(storage, ref, { mode, clientId: B })
      assert.equal(answer.ok, false)
      assert.equal(answer.status, 423, `${JSON.stringify(ref)} in ${mode}`)
    }
  }
})

test('edgeMayWrite is false while a live lease exists', async () => {
  const storage = fresh()
  assert.equal(await edgeMayWrite(storage, clock.now), true)
  const a = await act(storage, 'acquire', A)
  assert.equal(await edgeMayWrite(storage, clock.now), false)
  tick(WORLD_LEASE.ttlMs)
  assert.equal(await edgeMayWrite(storage, clock.now), true, 'ran out')
  // A lease that ran out is not renewed (410); the browser acquires a fresh one.
  assert.equal((await act(storage, 'renew', A, { leaseId: a.body.lease.leaseId })).status, 410)
  assert.equal(await edgeMayWrite(storage, clock.now), true, 'still free')
  const again = await act(storage, 'acquire', A)
  assert.equal(await edgeMayWrite(storage, clock.now), false)
  await act(storage, 'release', A, { leaseId: again.body.lease.leaseId })
  assert.equal(await edgeMayWrite(storage, clock.now), true, 'released')
})

test('home guard: while the freeze is enforced only the rescuing browser may become the writer', async () => {
  const pending = { rescue: 'r-1', clientId: A, since: T0 - 5 }
  const storage = fresh()
  await storage.put(PENDING, pending)
  const before = storage.snapshot()
  for (const [action, options] of [['acquire', {}], ['take', { ownerApproved: true }]]) {
    const answer = await act(storage, action, B, {}, { homeFreeze: 'enforce', ...options })
    assert.equal(answer.status, 423)
    // The body also names the pending browser's last lease label and last write; A never held one.
    assert.deepEqual(answer.body, { ok: false, code: 'HOME_PENDING', rescue: 'r-1', since: T0 - 5, label: null, lastWroteAt: null })
  }
  assert.deepEqual(storage.snapshot(), before, 'nothing changed')
  assert.equal((await act(storage, 'acquire', A, {}, { homeFreeze: 'enforce' })).status, 200)

  const recorded = fresh()
  await recorded.put(PENDING, pending)
  assert.equal((await act(recorded, 'acquire', B, {}, { homeFreeze: 'record' })).status, 200)
  const unset = fresh()
  await unset.put(PENDING, pending)
  assert.equal((await act(unset, 'acquire', B, {})).status, 200, 'undefined is record')

  for (const homeFreeze of ['enforce', 'record']) {
    const empty = fresh()
    assert.equal((await act(empty, 'acquire', B, {}, { homeFreeze })).status, 200)
    assert.equal((await act(empty, 'take', A, {}, { homeFreeze, ownerApproved: true })).status, 200)
  }
})

test('the HOME_PENDING body names the pending browser by its last lease label and its last write, never its id', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  await storage.put('world:v1:wrote', { [A]: T0 - 60_000 })
  await storage.put(PENDING, { rescue: 'r-1', clientId: A, since: T0 - 5, verifiedAt: T0 - 10 })
  const live = await act(storage, 'acquire', B, {}, { homeFreeze: 'enforce' })
  assert.deepEqual(live.body, { ok: false, code: 'HOME_PENDING', rescue: 'r-1', since: T0 - 5, label: 'A laptop', lastWroteAt: T0 - 60_000 })
  await act(storage, 'release', A, { leaseId: a.body.lease.leaseId })
  tick(1_000)
  const gone = await act(storage, 'take', C, {}, { homeFreeze: 'enforce', ownerApproved: true })
  assert.equal(gone.body.label, 'A laptop', 'remembered after A no longer holds the lease')
  assert.ok(!JSON.stringify(gone.body).includes(A))
  const never = fresh()
  await never.put(PENDING, { rescue: 'r-2', clientId: C, since: T0, verifiedAt: T0 })
  assert.deepEqual((await act(never, 'acquire', B, {}, { homeFreeze: 'enforce' })).body, { ok: false, code: 'HOME_PENDING', rescue: 'r-2', since: T0, label: null, lastWroteAt: null })
})

test('a new page of the holder own browser is granted at once, generation + 1; the old page reference answers 410', async () => {
  const storage = fresh()
  const first = await act(storage, 'acquire', A, { tabId: 'tab-a' })
  tick(3_000)
  const again = await act(storage, 'acquire', A, { tabId: 'tab-a2', label: 'A laptop' })
  assert.equal(again.status, 200, 'a refresh never names his own browser as another browser')
  assert.equal(again.body.lease.generation, first.body.lease.generation + 1)
  assert.notEqual(again.body.lease.leaseId, first.body.lease.leaseId)
  assert.equal((await storage.get(LEASE)).holder.tabId, 'tab-a2')
  // The old page: its home save with its old reference, a thread write (no clientId), and its renew are all 410.
  assert.deepEqual(await write(storage, refOf(first), { clientId: A }), { ok: false, code: 'WRITER_GONE', status: 410 })
  assert.deepEqual(await write(storage, refOf(first), { clientId: null }), { ok: false, code: 'WRITER_GONE', status: 410 })
  assert.equal((await act(storage, 'renew', A, { tabId: 'tab-a', leaseId: first.body.lease.leaseId })).status, 410)
  // A third page: the first two references are both 410, the newest writes.
  const third = await act(storage, 'acquire', A, { tabId: 'tab-a3' })
  assert.equal(third.body.lease.generation, first.body.lease.generation + 2)
  for (const old of [first, again]) assert.deepEqual(await write(storage, refOf(old), { clientId: null }), { ok: false, code: 'WRITER_GONE', status: 410 })
  assert.deepEqual(await write(storage, refOf(third), { clientId: A }), { ok: true, clientId: A, leased: true, heldUntil: third.body.lease.expiresAt })
  // ask from another page of the same browser: not asked; another browser is still refused exactly as before.
  assert.deepEqual((await act(storage, 'ask', A, { tabId: 'tab-a9' })).body, { ok: true, asked: false })
  assert.equal((await storage.get(LEASE)).asked, null)
  const b = await act(storage, 'acquire', B)
  assert.equal(b.status, 423)
  assert.equal(b.body.code, 'WRITER_ELSEWHERE')
  assert.equal(b.body.holder.label, 'A laptop')
  // B presenting A's old page reference is still "another browser": 423 naming A, never 410.
  assert.equal((await write(storage, refOf(first), { clientId: B })).status, 423)
  // The same tab acquiring again keeps its lease (unchanged rule).
  assert.equal((await act(storage, 'acquire', A, { tabId: 'tab-a3' })).body.lease.leaseId, third.body.lease.leaseId)
})

test('once another browser holds the lease, the earlier pages of A are forgotten (423 naming the holder)', async () => {
  const storage = fresh()
  const first = await act(storage, 'acquire', A, { tabId: 'tab-a' })
  await act(storage, 'acquire', A, { tabId: 'tab-a2' })
  tick(WORLD_LEASE.ttlMs + 1)
  const b = await act(storage, 'acquire', B)
  assert.equal(b.status, 200)
  assert.equal((await storage.get(LEASE)).prior, undefined, 'a new holder starts with no earlier pages')
  assert.equal((await write(storage, refOf(first), { clientId: null })).status, 423)
  // An expired lease of A taken again by A from a new tab is a plain grant (not "own client": the lease was not live).
  const c = fresh()
  const a1 = await act(c, 'acquire', A, { tabId: 'tab-a' })
  tick(WORLD_LEASE.ttlMs + 1)
  const a2 = await act(c, 'acquire', A, { tabId: 'tab-a2' })
  assert.equal(a2.body.lease.generation, a1.body.lease.generation + 1)
  assert.deepEqual(await write(c, refOf(a1), { clientId: A }), { ok: false, code: 'WRITER_GONE', status: 410 })
})

test('earlier pages are bounded at 8; a malformed earlier-pages field makes the row unreadable (503, never guessed)', async () => {
  const storage = fresh()
  const pages = []
  for (let i = 0; i < 12; i++) pages.push(await act(storage, 'acquire', A, { tabId: `tab-${i}` }))
  const row = await storage.get(LEASE)
  assert.equal(row.prior.length, WORLD_LEASE_LIMITS.prior)
  assert.equal(row.generation, 12)
  assert.equal((await write(storage, refOf(pages[10]), { clientId: null })).status, 410)
  await storage.put(LEASE, { ...row, prior: 'junk' })
  assert.equal((await act(storage, 'status', A)).status, 503)
})

test('world:v1:seen: a write with a ref notes the holder at most once a minute; 256 ids at most', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  assert.equal(await clientSeenAt(storage, A), T0)
  tick(30_000)
  await write(storage, refOf(a), { clientId: A })
  assert.equal(await clientSeenAt(storage, A), T0, 'not within a minute')
  tick(31_000)
  await write(storage, refOf(a), { clientId: A })
  assert.equal(await clientSeenAt(storage, A), T0 + 61_000)
  assert.equal(await clientSeenAt(storage, B), null)
  assert.equal(await clientSeenAt(storage, 'not-a-uuid'), null)

  const many = fresh()
  const ids = Array.from({ length: 300 }, (_, i) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`)
  for (const id of ids) {
    tick(1)
    await act(many, 'take', id, { tabId: 't', label: 'x' }, { ownerApproved: true })
  }
  const seen = await many.get(SEEN)
  assert.equal(Object.keys(seen).length, WORLD_LEASE_LIMITS.seen)
  assert.equal(await clientSeenAt(many, ids[0]), null, 'the oldest is dropped')
  assert.equal(await clientSeenAt(many, ids.at(-1)), clock.now)
})

test('a storage error after checkLease inside the caller transaction leaves the lease row unchanged', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  const before = storage.snapshot()
  tick(40_000)
  await assert.rejects(storage.transaction(async tx => {
    const answer = await checkLease(tx, refOf(a), clock.now, { mode: 'observe', clientId: A })
    assert.equal(answer.ok, true)
    assert.equal((await tx.get(LEASE)).expiresAt, clock.now + WORLD_LEASE.ttlMs, 'renewed inside the transaction')
    throw new Error('STORAGE_WRITE_FAILED')
  }), /STORAGE_WRITE_FAILED/)
  assert.deepEqual(storage.snapshot(), before, 'the roll-back is real')
})

test('invalid lease requests are 400 LEASE_REQUEST_INVALID and open no transaction', async () => {
  const storage = fresh()
  storage.transaction = async () => { throw new Error('no transaction for an invalid request') }
  const good = { action: 'acquire', clientId: A, tabId: 'tab-a', label: 'A laptop' }
  const bad = [
    null, 'acquire', { ...good, action: 'steal' }, { ...good, clientId: A.toUpperCase() }, { ...good, clientId: 'x' },
    { ...good, tabId: 'has space' }, { ...good, tabId: 'x'.repeat(65) }, { ...good, tabId: '' }, { ...good, label: 'x'.repeat(81) },
    { ...good, label: 'line\nbreak' }, { ...good, label: 'zero​width' }, { ...good, label: 7 }, { ...good, leaseId: 'A'.repeat(32) },
    { ...good, leaseId: 'a'.repeat(31) }, { ...good, extra: 1 }, { ...good, action: 'renew' }, { ...good, action: 'release' },
    { action: 'status', clientId: A },
  ]
  for (const input of bad) {
    const answer = await leaseAction(storage, input, { now: clock.now })
    allBodies.push(answer.body)
    assert.deepEqual(answer, { status: 400, body: { ok: false, code: 'LEASE_REQUEST_INVALID' } }, JSON.stringify(input))
  }
  const ok = await leaseAction(createRollbackStorage(), { ...good, label: 'Safari · Mac 🍎'.padEnd(80, '.') }, { now: clock.now })
  assert.equal(ok.status, 200, 'eighty printable characters are fine')
})

test('modes, the summary, and checkLease never opens a transaction', async () => {
  assert.equal(leaseMode({ WRITER_LEASE: 'enforce' }), 'enforce')
  for (const env of [{}, undefined, { WRITER_LEASE: 'ENFORCE' }, { WRITER_LEASE: 'observe' }, { WRITER_LEASE: true }]) assert.equal(leaseMode(env), 'observe')
  assert.equal(homeFreezeMode({ HOME_FREEZE: 'enforce' }), 'enforce')
  for (const env of [{}, undefined, { HOME_FREEZE: 'Enforce' }, { HOME_FREEZE: 'record' }]) assert.equal(homeFreezeMode(env), 'record')
  const storage = fresh()
  assert.equal(await leaseSummary(storage, clock.now), null)
  const a = await act(storage, 'acquire', A)
  const summary = await leaseSummary(storage, clock.now)
  assert.deepEqual(summary, { label: 'A laptop', since: T0, seenAt: T0, live: true, asked: null })
  assert.ok(!JSON.stringify(summary).includes(a.body.lease.leaseId))
  assert.ok(!checkLease.toString().includes('transaction('), 'checkLease uses the caller transaction')
})

/** Real replay rows: `plan` lists, in revision order, `[clientIndex, acknowledgedAt]`. */
const clientId = index => `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
const LINEAGE = '12345678-1234-4234-8234-123456789abc'
async function seedReplay(storage, plan) {
  const seqs = new Map()
  let revision = 0
  for (const [index, acknowledgedAt] of plan) {
    revision += 1
    const id = clientId(index)
    const seq = (seqs.get(id) ?? 0) + 1
    seqs.set(id, seq)
    const digest = revision.toString(16).padStart(64, '0')
    await storage.put(`mirror:v2:receipt:${id}:${seq}`, { ok: true, protocol: 'x61-cloud-mirror/v1', lineageId: LINEAGE, revision, id: `${id}:${seq}`, clientId: id, seq, digest, applied: 1, acknowledgedAt })
    await storage.put(`mirror:v2:head:${id}`, { seq, digest })
  }
  const fence = { lineageId: LINEAGE, revision }
  await storage.put('mirror:v2:global-fence', fence)
  return fence
}
const DAY = 86400000
const NOW = T0 + 400 * DAY
const recent = NOW - DAY
const fullTable = (overrides = {}) => Array.from({ length: 256 }, (_, i) => [i, overrides[i] ?? recent])
const replay = (storage, fence) => storage.transaction(tx => readMirrorReplayState(tx, fence))
const NEW = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

test('slots: a new browser and a full table with nobody idle keeps today 507 (null)', async () => {
  const storage = createRollbackStorage()
  const fence = await seedReplay(storage, fullTable())
  const state = await replay(storage, fence)
  assert.equal(state.clients.size, 256)
  assert.equal(planClientSlotRetire(state, { incomingClientId: NEW, now: NOW }), null)
  assert.equal(planClientSlotRetire(state, { incomingClientId: clientId(3), now: NOW }), null, 'a known client is not new')
  const partial = createRollbackStorage()
  const partialFence = await seedReplay(partial, fullTable({ 0: NOW - 90 * DAY }).slice(0, 255))
  assert.equal(planClientSlotRetire(await replay(partial, partialFence), { incomingClientId: NEW, now: NOW }), null, 'the table is not full')
})

test('slots: the longest-idle of three is retired with every row, and the real replay state stays valid', async () => {
  const storage = createRollbackStorage()
  // Client 7 is idlest by its NEWEST receipt; client 9 has an older first receipt but saved again recently.
  const plan = [...fullTable({ 5: NOW - 40 * DAY, 7: NOW - 300 * DAY, 9: NOW - 350 * DAY, 11: NOW - 31 * DAY }), [7, NOW - 200 * DAY], [9, recent], [7, NOW - 100 * DAY], [20, recent]]
  const fence = await seedReplay(storage, plan)
  const state = await replay(storage, fence)
  const result = planClientSlotRetire(state, { incomingClientId: NEW, now: NOW })
  assert.equal(result.retired, clientId(7))
  for (const key of result.deleteKeys) assert.ok(key.startsWith('mirror:v2:head:') || key.startsWith('mirror:v2:receipt:'))
  await storage.transaction(async tx => { for (const key of result.deleteKeys) await tx.delete(key) })
  // The real reader must accept the world after the deletes (it throws CORRUPT if any receipt row is left behind).
  const after = await replay(storage, fence)
  assert.equal(result.tombstoneKey, `world:v1:retired:${clientId(7)}`)
  assert.deepEqual([...result.deleteKeys].sort(), [`mirror:v2:head:${clientId(7)}`, `mirror:v2:receipt:${clientId(7)}:1`, `mirror:v2:receipt:${clientId(7)}:2`, `mirror:v2:receipt:${clientId(7)}:3`].sort())
  assert.equal(after.clients.size, 255)
  assert.equal(after.clients.has(clientId(7)), false)
  assert.equal(planClientSlotRetire(after, { incomingClientId: NEW, now: NOW }), null, 'the table has room again')
  // Rows deleted with NO tombstone (the c7c13d91 behaviour): the edge no longer knows this browser; 410 is all it can say.
  // That 410 is said only under WRITER_LEASE=enforce and for a base of this lineage; the default mode leaves the
  // batch to publishMirror's own fence and sequence checks (main's retained 409), never a 410 today's browser would loop on.
  const queued = { clientId: clientId(7), seq: 4, cloudBase: { lineageId: fence.lineageId, revision: fence.revision } }
  const unknown = await storage.transaction(tx => retiredClientAnswer(tx, after, queued, { mode: 'enforce', fence }))
  allBodies.push(unknown)
  assert.deepEqual(unknown, { ok: false, code: 'MIRROR_CLIENT_UNKNOWN', status: 410 })
  assert.equal(await storage.transaction(tx => retiredClientAnswer(tx, after, queued, { fence })), null, 'default mode: publishMirror judges it')
  const second = planClientSlotRetire(state, { incomingClientId: NEW, now: NOW, idleMs: 45 * DAY })
  assert.equal(second.retired, clientId(7), 'idleMs is honoured; client 5 at 40 days stays')
  assert.equal(planClientSlotRetire(state, { incomingClientId: NEW, now: NOW, idleMs: 301 * DAY }), null)
})

test('slots: a kept conflict, the lease holder and the newest receipt are never chosen', async () => {
  const storage = createRollbackStorage()
  const plan = [...fullTable({ 1: NOW - 90 * DAY, 2: NOW - 80 * DAY, 3: NOW - 70 * DAY })]
  plan.push([4, NOW - 500 * DAY]) // client 4 holds the newest receipt of all, with an old clock
  const fence = await seedReplay(storage, plan)
  const state = await replay(storage, fence)
  assert.equal(planClientSlotRetire(state, { incomingClientId: NEW, now: NOW }).retired, clientId(1), 'client 4 holds the newest receipt')
  assert.equal(planClientSlotRetire(state, { incomingClientId: NEW, now: NOW, conflictClientIds: [clientId(1)] }).retired, clientId(2))
  assert.equal(planClientSlotRetire(state, { incomingClientId: NEW, now: NOW, conflictClientIds: new Set([clientId(1)]), leaseClientId: clientId(2) }).retired, clientId(3))
  assert.equal(planClientSlotRetire(state, { incomingClientId: NEW, now: NOW, conflictClientIds: [clientId(1), clientId(3)], leaseClientId: clientId(2) }), null)
})

test('slots: deleting only the head row would leave a CORRUPT replay state', async () => {
  const storage = createRollbackStorage()
  const fence = await seedReplay(storage, fullTable({ 1: NOW - 90 * DAY }))
  await storage.delete(`mirror:v2:head:${clientId(1)}`)
  await assert.rejects(replay(storage, fence), /MIRROR_REPLAY_METADATA_CORRUPT/)
})

test('retiredClientAnswer, no tombstone: seq 1 is a new browser; seq 7 with no head row is 410 MIRROR_CLIENT_UNKNOWN (under enforce, same lineage)', async () => {
  const storage = createRollbackStorage()
  const fence = await seedReplay(storage, [[0, recent]])
  const state = await replay(storage, fence)
  const base = { lineageId: fence.lineageId, revision: fence.revision }
  const ask = (batch, options = { mode: 'enforce', fence }) => storage.transaction(tx => retiredClientAnswer(tx, state, batch && { cloudBase: base, ...batch }, options))
  assert.equal(await ask({ clientId: NEW, seq: 1 }), null)
  const answer = await ask({ clientId: NEW, seq: 7 })
  allBodies.push(answer)
  assert.deepEqual(answer, { ok: false, code: 'MIRROR_CLIENT_UNKNOWN', status: 410 })
  assert.equal(await ask({ clientId: NEW, seq: 7 }, { fence }), null, 'default mode: publishMirror judges it, as main did')
  assert.equal(await ask({ clientId: NEW, seq: 7, cloudBase: { ...base, lineageId: '99999999-9999-4999-8999-999999999999' } }), null, 'another lineage: the fence check answers and keeps the conflict')
  assert.equal(await ask({ clientId: clientId(0), seq: 7 }), null, 'a known client is judged by publishMirror')
  assert.equal(await ask(null), null)
})

// MUST 3 (probe B2, the healed partition): the write is judged from the EDGE's lease row in the write's own
// transaction, whatever lease id or time the returning browser sends. Every refusal writes nothing.
async function refusedNamingB(storage, refs, clientId = A) {
  const before = storage.snapshot()
  for (const ref of refs) {
    const answer = await write(storage, ref, { clientId })
    assert.equal(answer.ok, false, JSON.stringify(ref))
    assert.equal(answer.status, 423, JSON.stringify(ref))
    assert.equal(answer.code, 'WRITER_ELSEWHERE')
    assert.equal(answer.holder.label, 'B phone')
  }
  assert.deepEqual(storage.snapshot(), before, 'a refused write changes no row')
}

test('B2 (a): A partitioned, its lease ran out and B took it; A comes back with queued batches: 423 naming B', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  tick(WORLD_LEASE.ttlMs + 1)
  assert.equal((await act(storage, 'acquire', B)).status, 200)
  tick(10_000)
  const old = refOf(a)
  await refusedNamingB(storage, [old, { ...old, expiresAt: clock.now + 365 * 86400000 }, { ...old, generation: 2 }, null])
})

test('B2 (b): B took the lease with the owner approval while A was live; A old lease is 423 naming B', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  tick(1_000)
  assert.equal((await act(storage, 'take', B, {}, { ownerApproved: true })).status, 200)
  const old = refOf(a)
  await refusedNamingB(storage, [old, { ...old, expiresAt: Number.MAX_SAFE_INTEGER, seenAt: clock.now }])
})

test('B2 (c): A presents its OLD lease id, a forged newer expiry, and B lease id with its own client id: all 423 naming B', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  tick(WORLD_LEASE.ttlMs + 1)
  const b = await act(storage, 'acquire', B)
  const old = refOf(a)
  await refusedNamingB(storage, [old, { ...old, expiresAt: clock.now + WORLD_LEASE.ttlMs * 1000 }, refOf(b), { ...refOf(b), expiresAt: clock.now + 1 }])
  // B lease id stays B's even after it runs out with nobody taking it: A still cannot write under it.
  tick(WORLD_LEASE.ttlMs * 5)
  await refusedNamingB(storage, [refOf(b)])
  // B itself, with its own id after its lease ran out, is 410 (never revived); A with its own old ref, B gone quiet, is 410 (take a new lease).
  assert.deepEqual(await write(storage, refOf(b), { clientId: B }), { ok: false, code: 'WRITER_GONE', status: 410 })
  tick(WORLD_LEASE.ttlMs + 1)
  assert.deepEqual(await write(storage, old, { clientId: A }), { ok: false, code: 'WRITER_GONE', status: 410 })
})

test('B2: a retired browser write is the named 409 CLIENT_SLOT_RETIRED before any row is written, lease or no lease', async () => {
  const storage = fresh()
  const a = await act(storage, 'acquire', A)
  await storage.put(`world:v1:retired:${C}`, { v: 1, clientId: C, state: 'retired', reason: 'idle', retiredAt: T0 - 1, lastSeenAt: T0 - 40 * 86400000, seq: 3, digest: 'd'.repeat(64), base: { lineageId: '12345678-1234-4234-8234-123456789abc', revision: 7 }, resurrectedAt: null })
  const before = storage.snapshot()
  for (const ref of [null, refOf(a)]) {
    for (const mode of ['observe', 'enforce']) {
      const answer = await write(storage, ref, { mode, clientId: C })
      assert.equal(answer.status, 409)
      assert.equal(answer.code, 'CLIENT_SLOT_RETIRED')
      assert.equal(answer.retiredAt, T0 - 1)
    }
  }
  assert.deepEqual(storage.snapshot(), before)
})

test('suite-wide: every write refusal is 423 or 410 or the named 409 CLIENT_SLOT_RETIRED, and no body has a conflictCode field', () => {
  assert.ok(writeAnswers.length > 50)
  const named = answer => answer.status === 409 && answer.code === 'CLIENT_SLOT_RETIRED'
  for (const answer of writeAnswers) if (!answer.ok) assert.ok([423, 410].includes(answer.status) || named(answer), JSON.stringify(answer))
  assert.ok(writeAnswers.some(named), 'the retired case was exercised')
  const hasConflictCode = value => value !== null && typeof value === 'object' && (Object.hasOwn(value, 'conflictCode') || Object.values(value).some(hasConflictCode))
  assert.ok(allBodies.length > 100)
  for (const body of allBodies) assert.equal(hasConflictCode(body), false, JSON.stringify(body))
})
