/** The witness record and its chain (witness.mjs). A fixed fixture of three records: each digest and
 * link recomputed here with a test-local canonical form and node:crypto (never the module's own helpers); a missing fact
 * is null with its closed reason; every malformed record refuses. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  WITNESS_CHAIN_TAG, WITNESS_JOURNAL_PATHS, WITNESS_KIND, WITNESS_MISSING, WITNESS_ZERO, buildWitnessRecord, validWitnessRecord,
  verifyWitnessChain, witnessDigest, witnessEventTemplate,
} from '../witness.mjs'

const sha256hex = text => createHash('sha256').update(text).digest('hex')
/** Test-local canonical JSON: keys sorted at every depth, no whitespace. */
const sorted = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item)
const [VOICE, TIMELINE] = WITNESS_JOURNAL_PATHS

const FACTS = [
  { head: { ballId: 'a'.repeat(64), epoch: 80 }, receipts: { leafHash: 'b'.repeat(64), rows: 412 },
    journals: [{ path: VOICE, bytes: 1834, last: 'c'.repeat(64) }, { path: TIMELINE, bytes: 0, last: '' }] },
  { head: { ballId: 'a'.repeat(64), epoch: 80 }, receipts: { leafHash: 'd'.repeat(64), rows: 413 },
    journals: [{ path: VOICE, bytes: 2210, last: 'e'.repeat(64) }, { path: TIMELINE, bytes: 96, last: 'f'.repeat(64) }] },
  { head: { ballId: '1'.repeat(64), epoch: 81 }, receipts: { leafHash: '2'.repeat(64), rows: 420 },
    journals: [{ path: VOICE, bytes: 2210, last: 'e'.repeat(64) }, { path: TIMELINE, bytes: 211, last: '3'.repeat(64) }] },
]
const AT = [1_794_830_400_000, 1_794_844_800_000, 1_794_859_200_000]

async function fixture() {
  const records = []
  let prev = WITNESS_ZERO
  for (let index = 0; index < 3; index++) {
    const record = buildWitnessRecord({ seq: index + 1, prev, at: AT[index], facts: FACTS[index] })
    records.push(record)
    prev = await witnessDigest(record)
  }
  return records
}

test('three records: exact canonical bytes, digest = sha256(canonical record), each prev names the digest before', async () => {
  const records = await fixture()
  assert.equal(WITNESS_ZERO, '0'.repeat(64))
  assert.equal(sorted(records[0]), '{"at":1794830400000,"facts":{"head":{"ballId":"' + 'a'.repeat(64) + '","epoch":80},"journals":[{"bytes":1834,"last":"'
    + 'c'.repeat(64) + '","path":"/dsh/home/auma/voice/chain.v1.jsonl"},{"bytes":0,"last":"","path":"/dsh/home/auma/timeline/chain.v1.jsonl"}],'
    + '"receipts":{"leafHash":"' + 'b'.repeat(64) + '","rows":412}},"missing":[],"prev":"' + '0'.repeat(64) + '","seq":1,"v":1}')
  let prev = '0'.repeat(64)
  for (const [index, record] of records.entries()) {
    assert.deepEqual(Object.keys(record).sort(), ['at', 'facts', 'missing', 'prev', 'seq', 'v'])
    assert.equal(record.v, 1)
    assert.equal(record.seq, index + 1)
    assert.equal(record.prev, prev)
    assert.deepEqual(record.missing, [])
    assert.equal(await witnessDigest(record), sha256hex(sorted(record)))
    prev = sha256hex(sorted(record))
  }
  assert.deepEqual(await verifyWitnessChain(records), { ok: true, seq: 3, digest: prev })
})

test('the chain check names a broken link, a gap, a changed record and a bad first record', async () => {
  const records = await fixture()
  const changed = structuredClone(records)
  changed[1].facts.receipts.rows = 999
  assert.deepEqual(await verifyWitnessChain(changed), { ok: false, code: 'WITNESS_CHAIN_BROKEN', seq: 3 })
  assert.deepEqual(await verifyWitnessChain([records[0], records[2]]), { ok: false, code: 'WITNESS_CHAIN_GAP', seq: 3 })
  assert.deepEqual(await verifyWitnessChain([records[1], records[2]]), { ok: false, code: 'WITNESS_CHAIN_GAP', seq: 2 })
  assert.deepEqual(await verifyWitnessChain([]), { ok: true, seq: 0, digest: '0'.repeat(64) })
  const bad = structuredClone(records)
  bad[0].missing = ['head-unavailable']
  assert.deepEqual(await verifyWitnessChain(bad), { ok: false, code: 'WITNESS_RECORD_INVALID', seq: 1 })
})

test('a fact that could not be read is null with its closed reason; the record is still made; missing is sorted', async () => {
  const record = buildWitnessRecord({ seq: 4, prev: 'a'.repeat(64), at: AT[2] + 14_400_000,
    facts: { head: FACTS[0].head, receipts: null, journals: null }, reasons: { receipts: 'receipts-unavailable', journals: 'journals-over-bound' } })
  assert.equal(record.facts.receipts, null)
  assert.equal(record.facts.journals, null)
  assert.deepEqual(record.missing, ['journals-over-bound', 'receipts-unavailable'])
  assert.equal(validWitnessRecord(record), true)
  // No reason given: the fact's plain "unavailable" code, never a guess at its value.
  const bare = buildWitnessRecord({ seq: 1, prev: WITNESS_ZERO, at: 0, facts: { head: null, receipts: null, journals: null } })
  assert.deepEqual(bare.missing, ['head-unavailable', 'journals-unavailable', 'receipts-unavailable'])
  assert.deepEqual(WITNESS_MISSING, { head: ['head-none', 'head-unavailable'], receipts: ['receipts-unavailable'], journals: ['journals-over-bound', 'journals-unavailable'] })
  // A reason for a fact that is present, or a reason outside the closed list, is refused.
  assert.throws(() => buildWitnessRecord({ seq: 1, prev: WITNESS_ZERO, at: 0, facts: FACTS[0], reasons: { head: 'head-none' } }), { code: 'WITNESS_RECORD_INVALID' })
  assert.throws(() => buildWitnessRecord({ seq: 1, prev: WITNESS_ZERO, at: 0, facts: { ...FACTS[0], head: null }, reasons: { head: 'because' } }), { code: 'WITNESS_RECORD_INVALID' })
})

test('every malformed record is refused, never repaired', () => {
  const good = { seq: 2, prev: 'a'.repeat(64), at: AT[1], facts: FACTS[1] }
  const cases = {
    'seq 0': { ...good, seq: 0 },
    'seq 1 with a prev': { ...good, seq: 1 },
    'seq 2 with zeros': { ...good, prev: WITNESS_ZERO },
    'upper-case prev': { ...good, prev: 'A'.repeat(64) },
    'a float time': { ...good, at: 1.5 },
    'an epoch below zero': { ...good, facts: { ...good.facts, head: { ballId: 'a'.repeat(64), epoch: -1 } } },
    'an extra head key': { ...good, facts: { ...good.facts, head: { ...FACTS[1].head, title: 'x' } } },
    'zero receipt rows': { ...good, facts: { ...good.facts, receipts: { leafHash: 'b'.repeat(64), rows: 0 } } },
    'journals out of order': { ...good, facts: { ...good.facts, journals: [...FACTS[1].journals].reverse() } },
    'a third journal': { ...good, facts: { ...good.facts, journals: [...FACTS[1].journals, FACTS[1].journals[0]] } },
    'an empty journal with a last line': { ...good, facts: { ...good.facts, journals: [{ path: VOICE, bytes: 0, last: 'c'.repeat(64) }, FACTS[1].journals[1]] } },
    'a journal with bytes and no last line digest': { ...good, facts: { ...good.facts, journals: [{ path: VOICE, bytes: 5, last: 'xyz' }, FACTS[1].journals[1]] } },
    'an extra fact': { ...good, facts: { ...good.facts, words: 'hello' } },
  }
  for (const [name, input] of Object.entries(cases)) assert.throws(() => buildWitnessRecord(input), { code: 'WITNESS_RECORD_INVALID' }, name)
  assert.equal(validWitnessRecord({ ...buildWitnessRecord(good), note: 'x' }), false)
  assert.equal(validWitnessRecord(null), false)
})

test('the event HEAD signs for record n: kind 4871, empty content, exactly e (absent for the first), seq, digest, chain', () => {
  const pubkey = '9'.repeat(64)
  assert.equal(WITNESS_KIND, 4871)
  assert.equal(WITNESS_CHAIN_TAG, 'witness.v1')
  assert.deepEqual(witnessEventTemplate({ pubkey, createdAt: 1_794_830_400, seq: 1, digest: 'd'.repeat(64), prevEventId: null }),
    { pubkey, created_at: 1_794_830_400, kind: 4871, tags: [['seq', '1'], ['digest', 'd'.repeat(64)], ['chain', 'witness.v1']], content: '' })
  assert.deepEqual(witnessEventTemplate({ pubkey, createdAt: 1_794_844_800, seq: 2, digest: 'e'.repeat(64), prevEventId: 'f'.repeat(64) }).tags,
    [['e', 'f'.repeat(64)], ['seq', '2'], ['digest', 'e'.repeat(64)], ['chain', 'witness.v1']])
  assert.throws(() => witnessEventTemplate({ pubkey, createdAt: 1, seq: 2, digest: 'e'.repeat(64), prevEventId: null }), { code: 'WITNESS_SIGN_INVALID' })
  assert.throws(() => witnessEventTemplate({ pubkey, createdAt: 1, seq: 1, digest: 'e'.repeat(64), prevEventId: 'f'.repeat(64) }), { code: 'WITNESS_SIGN_INVALID' })
})
