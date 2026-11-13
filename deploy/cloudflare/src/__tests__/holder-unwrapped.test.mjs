/**
 * job 4 review (SHOULD, world-lease.mjs recordOf): R2 outside leaseAction (thread appends, the final lease check,
 * the index, slot retirement) rests on wrapping the object storage's `transaction`. If that wrap cannot be made (the
 * assignment throws, or is silently ignored), the decisions must fail SAFE: a transaction with no start-up record reads her
 * holder row itself (one bounded read), never "not held". Its own file: the module remembers a failed wrap for the life of
 * the isolate, as MIRROR's isolate would.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkLease, holderStartUp, leaseHolderClientId, leaseStillNamed, leaseSummary } from '../world-lease.mjs'
import { HOLDER_MARK, WORLD_HOLDER } from '../world-holder.mjs'

const LEASE = 'world:v1:lease'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const T0 = 1_800_000_000_000
const REF = { leaseId: 'b'.repeat(32), generation: 2 }
// Her holder row (A is her body) and a lease B was granted, unmarked, by a build that knew no holder (after a rollback).
const WORLD = () => ({
  [WORLD_HOLDER]: { v: 1, generation: 1, body: { clientId: A, label: 'Chrome on the Mac', key: 'k', thumb: 't', checkpoint: null, sealed: false, since: T0 - 5 }, reservation: null, done: [], top: null },
  [LEASE]: { ...REF, holder: { clientId: B, tabId: 'tab-b', label: 'Firefox' }, acquiredAt: T0, seenAt: T0, expiresAt: T0 + 90000, asked: null },
})

/** A storage whose `transaction` cannot be replaced: `frozen` (the assignment throws) or `ignored` (it silently does nothing). */
function unwrappable(how, initial = WORLD()) {
  const data = new Map(Object.entries(structuredClone(initial)))
  const reads = []
  let failHolder = 0
  const view = {
    get: async key => {
      reads.push(key)
      if (key === WORLD_HOLDER && failHolder > 0) { failHolder--; throw new Error('read failed') }
      return structuredClone(data.get(key))
    },
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
  }
  const transaction = async fn => fn({ ...view })
  const storage = { ...view }
  if (how === 'frozen') Object.defineProperty(storage, 'transaction', { value: transaction, writable: false, enumerable: true })
  else Object.defineProperty(storage, 'transaction', { get: () => transaction, set: () => {}, enumerable: true })
  return { storage, data, reads, failNextHolderRead: () => { failHolder = 1 } }
}

/** MIRROR starts and its one start-up read fails, so nothing is marked at start and the state stays unknown. */
async function startedBadly(how) {
  const rig = unwrappable(how)
  rig.failNextHolderRead()
  await holderStartUp(rig.storage)
  assert.equal(rig.data.get(LEASE)[HOLDER_MARK], undefined, 'nothing was marked at start')
  return rig
}

for (const how of ['frozen', 'ignored']) {
  test(`a ${how} transaction: B's unmarked lease never writes, never shows, and is never the final check's lease; retirement sees her world held`, async () => {
    {
      const rig = await startedBadly(how)
      const verdict = await rig.storage.transaction(tx => checkLease(tx, REF, T0 + 1000, { clientId: B }))
      assert.deepEqual(verdict, { ok: false, code: 'WRITER_GONE', status: 410 }, 'B\'s append is refused')
      assert.equal(rig.data.get(LEASE)[HOLDER_MARK], true, 'the lease row is ended and marked')
      assert.equal(rig.data.get(LEASE).holder, null)
    }
    {
      const rig = await startedBadly(how)
      assert.equal(await rig.storage.transaction(tx => leaseStillNamed(tx, REF)), false, 'the final check names no lease')
    }
    {
      const rig = await startedBadly(how)
      assert.equal(await rig.storage.transaction(tx => leaseSummary(tx, T0 + 1000)), null, 'the index shows no lease of B')
    }
    {
      const rig = await startedBadly(how)
      assert.deepEqual(await rig.storage.transaction(tx => leaseHolderClientId(tx)), { clientId: B, marked: true }, 'retirement knows her world is held')
    }
    {
      // The holder row unreadable in the deciding transaction too: 503, retry; nothing served on a guess.
      const rig = await startedBadly(how)
      rig.failNextHolderRead()
      assert.deepEqual(await rig.storage.transaction(tx => checkLease(tx, REF, T0 + 1000, { clientId: B })), { ok: false, code: 'HOLDER_STATE_UNAVAILABLE', status: 503 })
      assert.equal(rig.data.get(LEASE).holder.clientId, B, 'nothing written')
    }
  })
}

test('a world never claimed, with an unwrappable transaction: the decisions still serve, at the cost of one holder read each', async () => {
  const world = WORLD()
  delete world[WORLD_HOLDER]
  const rig = unwrappable('frozen', world)
  await holderStartUp(rig.storage)
  rig.reads.length = 0
  const verdict = await rig.storage.transaction(tx => checkLease(tx, REF, T0 + 1000, { clientId: B }))
  assert.equal(verdict.ok, true, JSON.stringify(verdict))
  assert.equal(rig.reads.filter(key => key === WORLD_HOLDER).length, 1)
})
