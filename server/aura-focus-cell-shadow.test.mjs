import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { computeAuraFocusShadow } from '../deploy/cloudflare/src/aura-focus-shadow.mjs'
import { AURA_FOCUS_CELL_PIN, auraFocusCellInput, auraFocusCellShadow, runAuraFocusCell } from '../deploy/cloudflare/src/aura-focus-cell-shadow.mjs'
import { buildAuraFocusCell } from './aura-focus-cell.build.mjs'
import { AURA_FOCUS_CELL_PATH, admitAuraFocusCellBytes, loadAuraFocusCell } from '../deploy/cloudflare/src/aura-focus-cell.mjs'
import { BASE, randomCases, referenceCases, targetedCases } from './aura-focus-cell.vectors.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const s = overrides => ({ ...BASE, ...overrides })
const cell = loadAuraFocusCell()
/** aura_focus.wat at the lab's LOCK 2 (the lab record is not part of this repository). */
const LAB_WAT_SHA256 = '276e55a521bb4d27d3551d7cf5485fe6522e9253f398b510754e607c6b5547c2'
const RANDOM_SEED = 20261111, RANDOM_COUNT = 20_000

test('the shipped cell is byte-identical to what its source builds with the pinned skillsmith cell', () => {
  const { wat, metered } = buildAuraFocusCell()
  const shipped = readFileSync(AURA_FOCUS_CELL_PATH)
  assert.equal(sha256(wat), LAB_WAT_SHA256)
  assert.equal(Buffer.compare(shipped, metered), 0)
  assert.deepEqual([shipped.byteLength, sha256(shipped)], [AURA_FOCUS_CELL_PIN.bytes, AURA_FOCUS_CELL_PIN.sha256])
})

test('the shadow pin is CELL_PINS[aura-focus] in wasm-cells.ts', () => {
  const source = readFileSync(new URL('../packages/experimental/webworker-runtime/src/x6/wasm-cells.ts', import.meta.url), 'utf8')
  const entry = source.match(/'aura-focus': \{\n\s+sha256: '([0-9a-f]{64})', bytes: (\d+), fuel: (\d+),\n\s+ops: Object\.freeze\(\[([^\]]*)\]\)/)
  assert.ok(entry, 'aura-focus pin present')
  assert.deepEqual([entry[1], Number(entry[2]), Number(entry[3])], [AURA_FOCUS_CELL_PIN.sha256, AURA_FOCUS_CELL_PIN.bytes, AURA_FOCUS_CELL_PIN.fuel])
  assert.ok(entry[4].includes(`'${AURA_FOCUS_CELL_PIN.op}'`))
})

test('the loader admits only the pinned bytes: one changed byte is refused by the pin and the shadow reports it', () => {
  assert.equal(cell.error, undefined)
  assert.equal(cell.sha256, AURA_FOCUS_CELL_PIN.sha256)
  assert.equal(Object.isFrozen(cell), true)
  const bytes = new Uint8Array(readFileSync(AURA_FOCUS_CELL_PATH))
  for (const at of [0, 8, 4096, bytes.byteLength >> 1, bytes.byteLength - 1]) {
    const changed = Uint8Array.from(bytes)
    changed[at] ^= 0x01
    assert.deepEqual({ ...admitAuraFocusCellBytes(changed) }, { error: 'MODULE_HASH' }, `byte ${at}`)
  }
  assert.deepEqual({ ...admitAuraFocusCellBytes(bytes.subarray(0, bytes.byteLength - 1)) }, { error: 'MODULE_HASH' })
  assert.deepEqual({ ...admitAuraFocusCellBytes(Uint8Array.from([...bytes, 0])) }, { error: 'MODULE_BOUND' })
  assert.deepEqual({ ...admitAuraFocusCellBytes(new Uint8Array(0)) }, { error: 'MODULE_BOUND' })
  assert.deepEqual({ ...loadAuraFocusCell(new URL('./no-such-cell.wasm', import.meta.url)) }, { error: 'MODULE_UNAVAILABLE' })
  const changed = Uint8Array.from(bytes)
  changed[bytes.byteLength >> 1] ^= 0x80
  const reference = computeAuraFocusShadow(s({}))
  const record = auraFocusCellShadow(s({}), reference, admitAuraFocusCellBytes(changed))
  assert.equal(record.outcome, 'refused')
  assert.deepEqual(record.refusal, { source: 'host', code: 'MODULE_HASH' })
  assert.equal(record.refusalExpected, false)
  assert.equal(record.answer, null)
  // Without an admission handle, or with a forged one, the runner does not run anything.
  assert.deepEqual(runAuraFocusCell(undefined, {}).refusal, { source: 'host', code: 'CELL_NOT_ADMITTED' })
  assert.deepEqual(runAuraFocusCell({ module: cell.module, sha256: '0'.repeat(64) }, {}).refusal, { source: 'host', code: 'CELL_NOT_ADMITTED' })
})

test('zero disagreements with computeAuraFocusShadow on the lab vectors; refusals exactly where it is incomplete', () => {
  const tally = { cases: 0, agree: 0, disagree: 0, refusedExpected: 0, refusedUnexpected: 0, maxFuel: 0 }
  const groups = { reference: 0, targeted: 0, random: 0 }
  const shown = []
  const check = (family, { group, input }) => {
    const before = family === 'reference' ? structuredClone(input) : undefined
    const reference = computeAuraFocusShadow(input)
    const record = auraFocusCellShadow(input, reference, cell)
    tally.cases += 1
    groups[family] += 1
    if (typeof record.fuelUsed === 'number') tally.maxFuel = Math.max(tally.maxFuel, record.fuelUsed)
    if (record.outcome === 'agree') tally.agree += 1
    else if (record.outcome === 'refused' && record.refusalExpected) tally.refusedExpected += 1
    else {
      tally[record.outcome === 'disagree' ? 'disagree' : 'refusedUnexpected'] += 1
      if (shown.length < 5) shown.push(`${group}: ${JSON.stringify({ record: { outcome: record.outcome, refusal: record.refusal, differences: record.differences } })}`)
    }
    assert.equal(record.outcome === 'agree', reference.status !== 'incomplete' && record.outcome !== 'refused')
    if (before !== undefined) assert.deepEqual(input, before)
  }
  for (const c of referenceCases()) check('reference', c)
  for (const c of targetedCases()) check('targeted', c)
  for (const c of randomCases(RANDOM_SEED, RANDOM_COUNT)) check('random', c)
  console.log(`aura-focus cell vs computeAuraFocusShadow: ${JSON.stringify(groups)} ${JSON.stringify(tally)}`)
  assert.deepEqual(shown, [])
  assert.equal(tally.disagree, 0)
  assert.equal(tally.refusedUnexpected, 0)
  assert.equal(groups.reference, 287)
  assert.equal(groups.random, RANDOM_COUNT)
  assert.equal(tally.cases, tally.agree + tally.refusedExpected)
  assert.ok(tally.maxFuel > 0 && tally.maxFuel < AURA_FOCUS_CELL_PIN.fuel)
})

test('every out-of-profile class is refused by the adapter or the cell, and never becomes a value', () => {
  const accessor = s({})
  Object.defineProperty(accessor, 'activeOrgans', { get: () => 10, enumerable: true })
  const throwing = new Proxy(s({}), { getPrototypeOf() { throw new Error('unreadable') } })
  const holes = s({ observedSurpriseScores: [1, , 2] }) // eslint-disable-line no-sparse-arrays
  const classes = [
    ['not a plain object', null, 'adapter', 'ADAPTER_INPUTS_INCOMPLETE'],
    ['an array', [], 'adapter', 'ADAPTER_INPUTS_INCOMPLETE'],
    ['unreadable object', throwing, 'adapter', 'ADAPTER_INPUTS_UNREADABLE'],
    ['metadata: bad ball id', s({ ballId: 'x' }), 'adapter', 'ADAPTER_METADATA_INVALID'],
    ['metadata: negative epoch', s({ epoch: -1 }), 'adapter', 'ADAPTER_METADATA_INVALID'],
    ['count not an integer', s({ pendingWakes: 1.5 }), 'adapter', 'ADAPTER_INPUTS_INCOMPLETE'],
    ['count negative', s({ pendingWakes: -1 }), 'adapter', 'ADAPTER_INPUTS_INCOMPLETE'],
    ['count -0', s({ pendingWakes: -0 }), 'adapter', 'ADAPTER_INPUTS_INCOMPLETE'],
    ['count above 2^53-1', s({ declaredDagNodes: 2 ** 53 }), 'adapter', 'ADAPTER_INPUTS_INCOMPLETE'],
    ['count behind an accessor', accessor, 'adapter', 'ADAPTER_INPUTS_INCOMPLETE'],
    ['mismatch not a boolean', s({ handOffEpochMismatch: 1 }), 'adapter', 'ADAPTER_INPUTS_INCOMPLETE'],
    ['heartbeat not a number', s({ staleHeartbeatRatio: '0.5' }), 'adapter', 'ADAPTER_INPUTS_INCOMPLETE'],
    ['scores not an array', s({ observedSurpriseScores: 'none' }), 'adapter', 'ADAPTER_INPUTS_INCOMPLETE'],
    ['a hole in the scores', holes, 'adapter', 'ADAPTER_INPUTS_INCOMPLETE'],
    ['a score not a number', s({ observedSurpriseScores: [1, '2'] }), 'adapter', 'ADAPTER_INPUTS_INCOMPLETE'],
    ['more than 10,000 scores', s({ observedSurpriseScores: Array(10_001).fill(0) }), 'adapter', 'ADAPTER_SCORES_OVER_CAP'],
    ...[NaN, Infinity, -1, -0, -Number.MIN_VALUE].map(bad => [`older score ${String(bad)}`, s({ observedSurpriseScores: [bad, 0, 0, 0, 0, 0] }), 'adapter', 'ADAPTER_OLDER_SCORE_INVALID']),
    ['zero declared DAG nodes', s({ declaredDagNodes: 0, reachableDagNodes: 0 }), 'cell', 'INPUTS_INCOMPLETE'],
    ['zero total receipts', s({ totalReceipts: 0, verifiedReceipts: 0 }), 'cell', 'INPUTS_INCOMPLETE'],
    ['zero declared organs', s({ declaredOrgans: 0, activeOrgans: 0 }), 'cell', 'INPUTS_INCOMPLETE'],
    ['reachable above declared', s({ reachableDagNodes: 11 }), 'cell', 'INPUTS_INCOMPLETE'],
    ['verified above total', s({ verifiedReceipts: 11 }), 'cell', 'INPUTS_INCOMPLETE'],
    ['active above declared', s({ activeOrgans: 11 }), 'cell', 'INPUTS_INCOMPLETE'],
    ...[NaN, Infinity, -Infinity, -0, -0.5].map(bad => [`heartbeat ${String(bad)}`, s({ staleHeartbeatRatio: bad }), 'cell', 'INPUTS_INCOMPLETE']),
    ...[NaN, Infinity, -0, -Number.MAX_VALUE].map(bad => [`recent score ${String(bad)}`, s({ observedSurpriseScores: [1, 2, bad] }), 'cell', 'INPUTS_INCOMPLETE']),
  ]
  for (const [name, input, source, code] of classes) {
    const reference = computeAuraFocusShadow(input)
    assert.equal(reference.status, 'incomplete', name)
    const record = auraFocusCellShadow(input, reference, cell)
    assert.equal(record.outcome, 'refused', name)
    assert.deepEqual(record.refusal, { source, code }, name)
    assert.equal(record.refusalExpected, true, name)
    assert.equal(record.answer, null, name)
    assert.equal(Object.hasOwn(record, 'focus'), false, name)
  }
  // Out of profile for the cell itself, sent straight to it past the adapter: its own refusal comes back by code.
  const good = auraFocusCellInput(s({ observedSurpriseScores: [1, 2, 3, 4, 5] })).input
  const raw = input => runAuraFocusCell(cell, input).refusal
  assert.deepEqual(raw({ ...good, scores: [...good.scores, [0, 0]] }), { source: 'cell', code: 'SCORES_OVER_FIVE' })
  assert.deepEqual(raw({ ...good, scores: [[2 ** 32, 0]] }), { source: 'cell', code: 'MALFORMED' })
  assert.deepEqual(raw({ ...good, mismatch: 2 }), { source: 'cell', code: 'MALFORMED' })
  assert.deepEqual(raw({ ...good, counts: [...good.counts.slice(0, 8)] }), { source: 'cell', code: 'MALFORMED' })
  assert.deepEqual(raw({ bits: [0, 0, 0, 0], checks: [0, 0, 0, 0] }), { source: 'cell', code: 'OP_UNKNOWN' })
  assert.deepEqual(raw({ ...good, counts: [...good.counts.slice(0, 8), 2 ** 53] }), { source: 'host', code: 'UNREPRESENTABLE' })
})

test('a disagreement is reported with its fields and never replaces or changes the JavaScript result', () => {
  const input = s({ activeOrgans: 9 })
  const reference = computeAuraFocusShadow(input)
  const before = structuredClone(reference)
  assert.equal(reference.focus, 'consolidate')
  const agree = auraFocusCellShadow(input, reference, cell)
  assert.equal(agree.outcome, 'agree')
  assert.deepEqual(agree.answer, { status: 'complete', focus: 'consolidate', reason: 'coherence-deficit',
    checks: { driftTenths: 0, heartbeat: 'below', surpriseEscalation: 'below', surpriseObservation: 'below', coherence: 'below' } })
  const forged = { ...reference, focus: 'rest', reason: 'below-focus-thresholds', checks: { ...reference.checks, coherence: 'above' } }
  const disagree = auraFocusCellShadow(input, forged, cell)
  assert.equal(disagree.outcome, 'disagree')
  assert.deepEqual(disagree.differences, ['focus', 'reason', 'checks.coherence'])
  assert.equal(disagree.reference.focus, 'rest')
  assert.equal(disagree.answer.focus, 'consolidate')
  const answeredWhereIncomplete = auraFocusCellShadow(input, { ...reference, status: 'incomplete' }, cell)
  assert.equal(answeredWhereIncomplete.outcome, 'disagree')
  assert.deepEqual(answeredWhereIncomplete.differences, ['status'])
  assert.deepEqual(auraFocusCellShadow(input, null, cell).refusal, { source: 'host', code: 'REFERENCE_UNREADABLE' })
  assert.deepEqual(reference, before)
  for (const record of [agree, disagree, answeredWhereIncomplete]) {
    assert.equal(record.role, 'diagnostic-only')
    assert.equal(record.authorityTier, 'none')
    assert.equal(Object.isFrozen(record) && Object.isFrozen(record.answer) && Object.isFrozen(record.differences), true)
    assert.equal(Object.hasOwn(record, 'focus'), false)
    assert.deepEqual(JSON.parse(JSON.stringify(record)), record)
  }
})
