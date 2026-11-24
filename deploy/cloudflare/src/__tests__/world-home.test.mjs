/** world-home.mjs: when a browser last WROTE (`world:v1:wrote`), and her pending home RECORDED only (`world:v1:home-pending`). */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORLD_WROTE, WORLD_HOME_PENDING, WORLD_HOME_LIMITS, noteWrote, clientWroteAt, wroteTimes,
  homeBaseBehind, verifiedAtMs, validHomeInput, recordHomePending, homeSummary, worldStatus,
} from '../world-home.mjs'
import { SLOT_TOMBSTONE } from '../mirror-slot-tombstone.mjs'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LINEAGE = '12345678-1234-4234-8234-123456789abc'
const OTHER_LINEAGE = '87654321-4321-4321-8321-cba987654321'
const FENCE = { lineageId: LINEAGE, revision: 2190 }
const R1 = '1'.repeat(32)
const R2 = '2'.repeat(32)
const R3 = '3'.repeat(32)
const T0 = 1_800_000_000_000
const client = index => `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`

/** A transaction view over one Map (these functions never open a transaction themselves). */
function tx(initial = []) {
  const data = new Map(initial)
  return {
    data,
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, limit)),
  }
}
const home = (over = {}) => ({ rescue: R1, clientId: A, base: { lineageId: LINEAGE, revision: 2183 }, reconciliation: null, verifiedAt: '2026-11-12T13:58:00.000Z', ...over })

test('wrote: noted per browser on the edge clock, never backwards, read back by clientWroteAt', async () => {
  const t = tx()
  assert.equal(await clientWroteAt(t, A), null)
  assert.equal(await noteWrote(t, A, T0), true)
  assert.equal(await clientWroteAt(t, A), T0)
  assert.equal(await noteWrote(t, A, T0 - 5), false, 'an older time never replaces a newer one')
  assert.equal(await noteWrote(t, A, T0), false, 'the same time writes nothing')
  assert.equal(await noteWrote(t, A, T0 + 1), true)
  assert.deepEqual(await wroteTimes(t), { [A]: T0 + 1 })
})

test('wrote: a clientId that is not a browser id (null, the lease holder unknown, junk) notes nothing', async () => {
  const t = tx()
  for (const id of [null, undefined, '', 'client-a', A.toUpperCase(), 7]) assert.equal(await noteWrote(t, id, T0), false)
  assert.equal(t.data.has(WORLD_WROTE), false)
  assert.equal(await clientWroteAt(t, 'nope'), null)
})

test('wrote: 256 browsers at most, the newest kept; a malformed row is read as empty and rewritten clean', async () => {
  const t = tx([[WORLD_WROTE, 'junk']])
  assert.deepEqual(await wroteTimes(t), {})
  for (let i = 0; i < WORLD_HOME_LIMITS.wrote + 10; i++) await noteWrote(t, client(i), T0 + i)
  const row = await wroteTimes(t)
  assert.equal(Object.keys(row).length, 256)
  assert.equal(row[client(0)], undefined, 'the oldest fell out')
  assert.equal(row[client(265)], T0 + 265)
})

test('behind the fence: anything but exactly the fence, and a missing or malformed base, is behind', () => {
  assert.equal(homeBaseBehind({ lineageId: LINEAGE, revision: 2190 }, FENCE), false, 'exactly the fence: in step')
  assert.equal(homeBaseBehind({ lineageId: LINEAGE, revision: 2183 }, FENCE), true, 'his Chrome: 2183 against 2190')
  assert.equal(homeBaseBehind({ lineageId: OTHER_LINEAGE, revision: 2190 }, FENCE), true, 'another lineage')
  assert.equal(homeBaseBehind({ lineageId: LINEAGE, revision: 2191 }, FENCE), true, 'past the fence: unknown is not fresh')
  for (const base of [null, undefined, {}, { lineageId: LINEAGE }, { lineageId: 'x', revision: 1 }, { lineageId: LINEAGE, revision: -1 }]) assert.equal(homeBaseBehind(base, FENCE), true)
})

test('verifiedAt: the vault ISO string or edge ms; anything else is refused', () => {
  assert.equal(verifiedAtMs('2026-11-12T13:58:00.000Z'), Date.parse('2026-11-12T13:58:00.000Z'))
  assert.equal(verifiedAtMs(T0), T0)
  for (const bad of ['yesterday', '2026-11-12', -1, 1.5, null, {}, '2026-11-12T13:58:00+08:00']) assert.equal(verifiedAtMs(bad), null)
})

test('the home input is exactly {rescue, clientId, base, reconciliation, verifiedAt}', () => {
  assert.equal(validHomeInput(home()), true)
  assert.equal(validHomeInput(home({ clientId: null })), true, 'a rescue that names no client is a valid input that records nothing')
  assert.equal(validHomeInput({ ...home(), extra: 1 }), false)
  const { base: _base, ...missing } = home()
  assert.equal(validHomeInput(missing), false)
  assert.equal(validHomeInput(home({ rescue: 'r' })), false)
  assert.equal(validHomeInput(home({ verifiedAt: 'soon' })), false)
  assert.equal(validHomeInput(home({ clientId: 5 })), false)
})

test('MUST 6: pending is recorded when the base is behind OR a reconciliation mark is carried; in step records nothing', async () => {
  const behind = tx()
  assert.deepEqual(await recordHomePending(behind, home(), FENCE, T0), { recorded: true, reason: 'set' })
  assert.deepEqual(await behind.get(WORLD_HOME_PENDING), { rescue: R1, clientId: A, since: T0, verifiedAt: Date.parse('2026-11-12T13:58:00.000Z') })
  const marked = tx()
  assert.equal((await recordHomePending(marked, home({ base: { lineageId: LINEAGE, revision: 2190 }, reconciliation: { conflict: 'MIRROR_GLOBAL_FENCE_CONFLICT' } }), FENCE, T0)).recorded, true)
  const inStep = tx()
  assert.deepEqual(await recordHomePending(inStep, home({ base: { lineageId: LINEAGE, revision: 2190 } }), FENCE, T0), { recorded: false, reason: 'in-step' })
  assert.equal(inStep.data.size, 0)
})

test('MUST 6: a null or malformed clientId records NOTHING, ever, behind or not', async () => {
  for (const clientId of [null, '', 'his-chrome', A.toUpperCase(), `${A} `]) {
    const t = tx()
    const answer = await recordHomePending(t, home({ clientId, reconciliation: { mark: 1 } }), FENCE, T0)
    assert.equal(answer.recorded, false, String(clientId))
    assert.equal(t.data.size, 0, 'no row at all')
  }
  const malformed = tx()
  assert.equal((await recordHomePending(malformed, { rescue: R1, clientId: A }, FENCE, T0)).recorded, false)
  assert.equal(malformed.data.size, 0)
})

test('MUST 6: the pointer only moves forward, to a later verified rescue of the SAME browser; since is kept', async () => {
  const t = tx()
  await recordHomePending(t, home(), FENCE, T0)
  assert.deepEqual(await recordHomePending(t, home({ rescue: R2, clientId: B, verifiedAt: '2026-11-12T15:00:00.000Z' }), FENCE, T0 + 10), { recorded: false, reason: 'other-client' })
  assert.deepEqual(await recordHomePending(t, home({ rescue: R2, verifiedAt: '2026-11-12T13:00:00.000Z' }), FENCE, T0 + 20), { recorded: false, reason: 'not-newer' })
  assert.deepEqual(await recordHomePending(t, home({ rescue: R2, verifiedAt: '2026-11-12T13:58:00.000Z' }), FENCE, T0 + 20), { recorded: false, reason: 'not-newer' }, 'equal is not later')
  assert.equal((await t.get(WORLD_HOME_PENDING)).rescue, R1)
  assert.deepEqual(await recordHomePending(t, home({ rescue: R3, verifiedAt: '2026-11-12T16:00:00.000Z' }), FENCE, T0 + 30), { recorded: true, reason: 'moved' })
  assert.deepEqual(await t.get(WORLD_HOME_PENDING), { rescue: R3, clientId: A, since: T0, verifiedAt: Date.parse('2026-11-12T16:00:00.000Z') })
  const unreadable = tx([[WORLD_HOME_PENDING, { rescue: 'x' }]])
  assert.equal((await recordHomePending(unreadable, home(), FENCE, T0)).reason, 'unreadable')
  assert.deepEqual(await unreadable.get(WORLD_HOME_PENDING), { rescue: 'x' }, 'a row it cannot read is never replaced blind')
})

test('summary and status never name a browser id; the counts come from the thread world row and the tombstones', async () => {
  const t = tx()
  assert.deepEqual(await homeSummary(t, undefined), { pending: false, rescue: null, freeze: 'record' })
  await recordHomePending(t, home(), FENCE, T0)
  assert.deepEqual(await homeSummary(t, 'enforce'), { pending: true, rescue: R1, freeze: 'enforce' })
  assert.deepEqual(await worldStatus(t, { lease: null, freeze: 'record' }), { lease: null, home: { pending: true, rescue: R1, freeze: 'record' }, threads: 0, tailBytes: 0, retired: 0 })
  await t.put('thread:v1:world', { threads: 3, tailBytes: 4096 })
  await t.put(SLOT_TOMBSTONE + A, { any: 1 })
  const status = await worldStatus(t, { lease: { label: 'his Chrome' }, freeze: 'record' })
  assert.equal(status.threads, 3)
  assert.equal(status.tailBytes, 4096)
  assert.equal(status.retired, 1)
  assert.ok(!JSON.stringify(await homeSummary(t, 'record')).includes(A))
})
