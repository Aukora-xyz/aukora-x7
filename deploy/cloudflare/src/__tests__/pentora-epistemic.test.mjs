/** PENTOBS: synthetic readings derived independently from the pinned codec matrix; no live I/O. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { BASIS, COMPONENTS, SLOTS, evaluationMatrix } from '../../../../server/pentora-codec.build.mjs'
import { pentoraEpistemicTool } from '../../../../packages/experimental/webworker-runtime/src/x6/pentora-epistemic-tool.ts'
import { createPentoraEpistemicEngine } from '../../../../packages/experimental/webworker-runtime/src/x6/pentora-epistemic.ts'
import { PENTORA_ACTIVE_ROWS, PENTORA_MEAN_A, PENTORA_MEAN_B } from '../../../../packages/experimental/webworker-runtime/src/x6/pentora-epistemic-table.ts'

const p = 2147483647n, asField = n => Number((n % p + p) % p)
const { A, radii } = evaluationMatrix()
const info = pentoraEpistemicTool({ mode: 'info' })
const envelope = { profile: info.profile, matrixSha256: info.matrixSha256, snapshot: 'a'.repeat(64) }
const values = Array(SLOTS).fill(0)
values[0] = 2
values[36] = 3
const x2 = BASIS.findIndex(([x, y, z]) => x === 2 && y === 0 && z === 0)
assert.ok(x2 >= 0)
values[x2] = 3
const rowOf = ({ node, component }) => A[node * COMPONENTS + component]
const dot = (row, state) => asField(row.reduce((s, q, i) => s + BigInt(q) * BigInt(state[i]), 0n))
const addressRows = PENTORA_ACTIVE_ROWS.map(([node, component]) => ({ node, component }))
const readings = addressRows.map(address => ({ ...address, value: dot(rowOf(address), values) }))
const corners = readings.filter(r => radii[r.node] === 3)
const verifyComb = (multipliers, used, col) => asField(multipliers.reduce((s, weight, i) => s + BigInt(weight) * rowOf(used[i])[col], 0n))
const analyze = (subset, claim, suggestNext = false) => pentoraEpistemicTool({ ...envelope, readings: subset, claim, suggestNext })

test('the generated table is the exact nonzero carrier rows, with the codec packet index unchanged', () => {
  assert.deepEqual([info.ok, info.slots, info.nodes, info.activeRows, info.maxReadings], [true, 72, 110, 380, 96])
  assert.equal(corners.length, 80)
  const active = new Set(addressRows.map(({ node, component }) => node * COMPONENTS + component))
  for (let i = 0; i < A.length; i++) assert.equal(active.has(i), A[i].some(v => v !== 0n))
  for (const [node, component, packed] of PENTORA_ACTIVE_ROWS) {
    const a = Array(SLOTS).fill(0n), bytes = Buffer.from(packed, 'base64')
    for (let i = 0; i < bytes.length; i += 3) a[bytes[i]] = BigInt(bytes.readInt16LE(i + 1))
    assert.deepEqual(a, rowOf({ node, component }))
  }
})

test('80 corner scalars certify the spherical mean 3+3phi, not the full state', () => {
  const result = analyze(corners, { kind: 'spherical-mean' })
  assert.equal(result.status, 'KNOWN')
  assert.deepEqual([result.rank, result.nullity], [40, 32])
  assert.deepEqual(result.claims.map(c => c.value), [3, 3])
  for (const [i, expected] of [PENTORA_MEAN_A, PENTORA_MEAN_B].entries()) {
    const proof = result.claims[i].certificate
    assert.equal(dot(proof, corners.map(r => r.value)), 3)
    assert.deepEqual(expected.map((_, col) => verifyComb(proof, corners, col)), expected)
  }
  assert.equal(result.authenticity, 'NOT_ESTABLISHED')
})

test('a constructive finite-field twin fits all readings while the requested coefficient differs', () => {
  const used = corners.slice(0, 8), slot = 71
  const result = analyze(used, { kind: 'coefficient', slot })
  assert.equal(result.status, 'UNDETERMINED')
  const twin = result.claims[0].twin
  for (const reading of used) {
    assert.equal(dot(rowOf(reading), twin.first), reading.value)
    assert.equal(dot(rowOf(reading), twin.second), reading.value)
  }
  assert.notEqual(twin.first[slot], twin.second[slot])
  assert.equal(result.integerReachability, 'NOT_ESTABLISHED')
})

test('inconsistent synthetic readings return a verifiable syndrome, not an attribution', () => {
  const first = corners.find((r, i) => corners.slice(i + 1).some(v => rowOf(v).every((x, k) => x === rowOf(r)[k])))
  const second = corners.find(r => r !== first && rowOf(r).every((x, k) => x === rowOf(first)[k]))
  const used = [first, { ...second, value: (second.value + 1) % Number(p) }]
  const result = analyze(used, { kind: 'spherical-mean' })
  assert.equal(result.status, 'DISAGREE')
  assert.equal(result.attribution, 'NONE')
  const proof = result.syndrome.multipliers
  for (let col = 0; col < SLOTS; col++) assert.equal(verifyComb(proof, used, col), 0)
  assert.equal(dot(proof, used.map(r => r.value)), result.syndrome.residual)
  assert.notEqual(result.syndrome.residual, 0)
})

test('next-window advice is deterministic and pays exactly the suggested number of new scalars', () => {
  const used = corners.slice(0, 12), claim = { kind: 'coefficient', slot: 71 }
  const result = analyze(used, claim, true)
  assert.deepEqual(result.next, analyze(used, claim, true).next)
  assert.equal(result.next.status, 'SUGGESTED')
  const extra = readings.filter(r => r.node === result.next.node && !used.some(v => v.node === r.node && v.component === r.component))
  assert.equal(extra.length, result.next.newReadings)
  assert.equal(analyze([...used, ...extra], claim).rank - result.rank, result.next.rankGain)
})

test('equal-cost control: relabeling the same rows leaves the same field conclusion', () => {
  const nodes = Array.from({ length: 110 }, (_, i) => ({
    node: 109 - i,
    rows: addressRows.filter(r => r.node === i).map(r => ({ component: r.component, coefficients: rowOf(r).map(Number) })),
  }))
  const plain = createPentoraEpistemicEngine({ profileId: 'relabelled-control', matrixSha256: '0'.repeat(64), nodes,
    meanClaims: { a: PENTORA_MEAN_A, b: PENTORA_MEAN_B } })
  const unlabelled = corners.map(r => ({ ...r, node: 109 - r.node }))
  const control = plain.analyze({ readings: unlabelled, claim: { kind: 'spherical-mean' } })
  const geometry = analyze(corners, { kind: 'spherical-mean' })
  assert.equal(unlabelled.length, corners.length)
  assert.deepEqual([control.status, control.rank, control.claims], [geometry.status, geometry.rank, geometry.claims])
})

test('a profile mismatch, duplicate, omitted row, out-of-field value and over-budget request refuse', () => {
  assert.equal(pentoraEpistemicTool({ ...envelope, matrixSha256: '0'.repeat(64), readings: [], claim: { kind: 'spherical-mean' } }).code, 'PENTORA_OBSERVER_PROFILE')
  const claim = { kind: 'coefficient', slot: 0 }
  assert.equal(analyze([corners[0], corners[0]], claim).code, 'UNKNOWN_OR_DUPLICATE_READING')
  const omitted = Array.from({ length: 8 }, (_, i) => i).find(i => rowOf({ node: 0, component: i }).every(v => v === 0n))
  assert.equal(analyze([{ node: 0, component: omitted, value: 0 }], claim).code, 'UNKNOWN_OR_DUPLICATE_READING')
  assert.equal(analyze([{ ...corners[0], value: Number(p) }], claim).code, 'INVALID_READING')
  assert.equal(analyze(readings.slice(0, 97), claim).code, 'INVALID_REQUEST')
})
