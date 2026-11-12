/** Synthetic bytes and receipt callbacks only. Behaviour tests run the pinned seed-aura fixture (server/fixtures/organs);
 *  the final structural test only loads the live organ's shape and never calls it. No memory file is opened. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as crypto from 'node:crypto'
import test from 'node:test'
import { auraInputsComplete, computeAura, overdueWakeRatio, staleHeartbeatFacts, validateAuraVector } from './aura-rules.mjs'
import { loadOrganUnderTest, pairedModuleDrift, pinnedManifest, verifyPinnedProvenance } from './fixtures/organs/pinned.mjs'
import { assertLiveOrganShape } from './fixtures/organs/live-shape.mjs'

const NOW = 1794182400000
const SEED = '/dsh/home/auma/seed'
const AURA = SEED + '/aura.v1.json'
const RECEIPTS = SEED + '/receipts.v3.jsonl'
const DAG = '/dsh/home/auma/memory/dag'
const source = loadOrganUnderTest('seed-aura')
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
const hash = value => createHash('sha256').update(value).digest('hex')
const inputs = (overrides = {}) => ({ computedAt: NOW, ballId: 'a'.repeat(64), epoch: 157,
  reachableDagNodes: 7, declaredDagNodes: 7, verifiedReceipts: 87, totalReceipts: 87,
  activeOrgans: 20, declaredOrgans: 20, observedSurpriseScores: [], handOffEpochMismatch: false,
  unanchoredPredictions: 0, pendingWakes: 0, lastRollbackAgeEpochs: 10, staleHeartbeatRatio: 0, ...overrides })
const signalFields = Object.keys(inputs()).filter(key => !['computedAt', 'ballId', 'epoch'].includes(key))

function append(files, kind, data) {
  const prefix = files.get(RECEIPTS) ?? ''
  const rows = prefix.split('\n').filter(Boolean).map(JSON.parse)
  const body = { schema: 'aukora.receipt.v3', seq: rows.length + 1, at: new Date(NOW).toISOString(),
    prevHash: rows.at(-1)?.leafHash ?? '0'.repeat(64), kind, data }
  const receipt = { ...body, leafHash: hash('\0' + canonical(body)) }
  files.set(RECEIPTS, prefix + (prefix && !prefix.endsWith('\n') ? '\n' : '') + JSON.stringify(receipt) + '\n')
  return receipt
}

function fixture({ previous = 'previous synthetic aura bytes\n' } = {}) {
  const files = new Map(), writes = [], events = []
  if (previous !== null) files.set(AURA, previous)
  const fs = {
    existsSync: path => files.has(path),
    readFileSync(path) {
      events.push(['read', path])
      if (!files.has(path)) throw Object.assign(new Error('SYNTHETIC_ABSENT'), { code: 'ENOENT' })
      return files.get(path)
    },
    readdirSync: path => [...files.keys()].filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map(key => key.slice(path.length + 1)),
    writeFileSync(path, body, options) {
      if (options?.flag === 'wx' && files.has(path)) throw Object.assign(new Error('SYNTHETIC_EXISTS'), { code: 'EEXIST' })
      events.push(['write', path]); writes.push(path); files.set(path, String(body))
    },
    renameSync(from, to) {
      assert.ok(files.has(from)); events.push(['rename', to]); files.set(to, files.get(from)); files.delete(from)
    },
    unlinkSync(path) {
      if (!files.delete(path)) throw Object.assign(new Error('SYNTHETIC_ABSENT'), { code: 'ENOENT' })
    },
  }
  const module = { exports: {} }
  class Clock extends Date { static now() { return NOW } }
  new Function('module', 'require', 'Buffer', 'Date', source)(module, specifier => {
    if (specifier === 'node:fs') return fs
    if (specifier === 'node:crypto') return crypto
    throw new Error('Unapproved synthetic dependency: ' + specifier)
  }, Buffer, Clock)
  const body = { content: 'Round26 synthetic memory', parentIds: [] }
  const node = { ...body, id: hash(canonical(body)) }
  files.set('/dsh/home/balls/HEAD.json', JSON.stringify({ ballId: inputs().ballId, epoch: 157, entries: { one: {} } }))
  files.set('/dsh/home/auma/HANDOFF.md', '| epoch | **57** |\n| ballId | `' + inputs().ballId + '` |\n')
  files.set(DAG + '/HEAD.json', JSON.stringify({ count: 1, heads: [node.id] }))
  files.set(DAG + '/' + node.id + '.json', JSON.stringify(node))
  files.set(SEED + '/discovery-corpus.v1.jsonl', '')
  files.set('/dsh/home/auma/superagent/state.json', JSON.stringify({ assignments: [] }))
  append(files, 'memory.dag.append', { nodeId: node.id, content: node.content })
  return { organ: module.exports, files, writes, events, fs }
}

const compute = (f, callback) => f.organ.run({ action: 'compute', wake: { pendingWakes: 0 } }, { organs: { call: callback } })

test('both pure scorers refuse every partial explicit input by name without mutation', () => {
  const f = fixture()
  for (const field of signalFields) {
    const value = inputs(); delete value[field]
    const before = structuredClone(value)
    for (const scorer of [computeAura, f.organ.computeAura]) assert.throws(() => scorer(value), { code: 'AURA_INPUTS_INCOMPLETE' }, field)
    assert.equal(auraInputsComplete(value), false)
    assert.equal(f.organ.auraInputsComplete(value), false)
    assert.deepEqual(value, before)
  }
  const metadata = { computedAt: NOW, ballId: inputs().ballId, epoch: 157 }
  for (const scorer of [computeAura, f.organ.computeAura]) assert.throws(() => scorer(metadata), { code: 'AURA_INPUTS_INCOMPLETE' })
  assert.deepEqual(f.writes, [])
})

test('corrupt signals and accessor evidence are named refusals in both scorers', () => {
  const f = fixture()
  const values = [inputs({ unanchoredPredictions: 0.5 }), inputs({ declaredDagNodes: 0 }),
    inputs({ staleHeartbeatRatio: Infinity }), inputs({ observedSurpriseScores: Array(1) }),
    inputs({ observedSurpriseScores: Array(10001).fill(0) })]
  const accessor = inputs()
  Object.defineProperty(accessor, 'pendingWakes', { get() { assert.fail('must not invoke evidence accessors') } })
  values.push(accessor)
  for (const value of values) for (const scorer of [computeAura, f.organ.computeAura]) {
    assert.throws(() => scorer(value), { code: 'AURA_INPUTS_INCOMPLETE' })
  }
})

test('negative-zero signals cannot produce an Aura in either scorer', () => {
  const f = fixture()
  const cases = signalFields.filter(field => typeof inputs()[field] === 'number')
    .map(field => [field, inputs({ [field]: -0 })])
  cases.push(['recent surprise', inputs({ observedSurpriseScores: [-0] })],
    ['older surprise', inputs({ observedSurpriseScores: [-0, 0, 0, 0, 0, 0] })])
  for (const [label, value] of cases) {
    const before = structuredClone(value)
    for (const complete of [auraInputsComplete, f.organ.auraInputsComplete]) assert.equal(complete(value), false, label)
    for (const scorer of [computeAura, f.organ.computeAura]) assert.throws(() => scorer(value), { code: 'AURA_INPUTS_INCOMPLETE' }, label)
    assert.deepEqual(value, before)
  }
  assert.deepEqual(f.writes, [])
})

test('both scorers reject negative-zero metadata and still admit positive zero', () => {
  const f = fixture()
  for (const field of ['computedAt', 'epoch']) for (const scorer of [computeAura, f.organ.computeAura]) {
    assert.throws(() => scorer(inputs({ [field]: -0 })), TypeError, field)
  }
  const value = inputs({ computedAt: 0, epoch: 0, observedSurpriseScores: [0] })
  assert.equal(auraInputsComplete(value), true)
  assert.equal(f.organ.auraInputsComplete(value), true)
  const aura = computeAura(value)
  assert.deepEqual(f.organ.computeAura(value), aura)
  assert.equal(aura.vector.coherence, 1)
  assert.equal(aura.recommendedFocus, 'rest')
  assert.equal(validateAuraVector(aura), true)
})

test('stored Aura metadata, axes, and salience reject negative zero', () => {
  const aura = computeAura(inputs())
  for (const field of ['computedAt', 'epoch']) assert.equal(validateAuraVector({ ...aura, [field]: -0 }), false, field)
  for (const axis of Object.keys(aura.vector)) {
    assert.equal(validateAuraVector({ ...aura, vector: { ...aura.vector, [axis]: -0 } }), false, axis)
  }
  assert.equal(validateAuraVector({ ...aura, salience: [{ ...aura.salience[0], score: -0 }] }), false)
})

test('heartbeat readers reject negative-zero clocks, thresholds, and selected pulse fields', () => {
  const f = fixture()
  const fresh = { state: 'running', ticketId: 'synthetic-ticket', startedAt: NOW }
  for (const read of [staleHeartbeatFacts, f.organ.staleHeartbeatFacts]) {
    assert.equal(read([], -0), null)
    assert.equal(read([], NOW, -0), null)
    for (const change of [{ heartbeatAt: -0 }, { reports: [{ at: -0 }] }, { reportedAt: -0 }, { startedAt: -0 }]) {
      assert.equal(read([{ ...fresh, ...change }], NOW), null)
    }
    assert.deepEqual(read([{ ...fresh, heartbeatAt: 0 }], 0, 0), { staleHeartbeatRatio: 0, staleTickets: 0 })
  }
})

test('overdue-wake input validation rejects negative zero but admits positive zero', () => {
  const wake = { enabled: true, intervalMs: 1000, nextWakeAt: 0 }
  assert.equal(overdueWakeRatio(wake, -0), null)
  for (const field of ['intervalMs', 'nextWakeAt']) assert.equal(overdueWakeRatio({ ...wake, [field]: -0 }, NOW), null)
  assert.equal(overdueWakeRatio(wake, 0), 0)
})

test('a negative-zero host wake count stays incomplete without append or publication', async () => {
  const f = fixture(), before = new Map(f.files)
  let appendCalls = 0
  const result = await f.organ.run(JSON.parse('{"action":"compute","wake":{"pendingWakes":-0}}'),
    { organs: { call() { appendCalls++; return { ok: false } } } })
  assert.equal(result.status, 'incomplete')
  assert.equal(result.vector, null)
  assert.equal(result.written, false)
  assert.ok(result.gaps.includes('wakes'))
  assert.equal(appendCalls, 0)
  assert.deepEqual(f.files, before)
  assert.deepEqual(f.writes, [])
})

test('1,000 deterministic vectors preserve full server/seed parity and debt never becomes coherence one', () => {
  const f = fixture()
  let state = 0x26a11a
  const next = maximum => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state % maximum }
  for (let index = 0; index < 1000; index++) {
    const declaredDagNodes = next(1000) + 1, totalReceipts = next(10000) + 1, declaredOrgans = next(100) + 1
    const value = inputs(index < 3 ? { unanchoredPredictions: [0, 1_000_000, Number.MAX_SAFE_INTEGER][index] } : {
      declaredDagNodes, reachableDagNodes: next(declaredDagNodes + 1), totalReceipts, verifiedReceipts: next(totalReceipts + 1),
      declaredOrgans, activeOrgans: next(declaredOrgans + 1), unanchoredPredictions: next(1_000_001),
      observedSurpriseScores: Array.from({ length: next(12) }, () => next(10000) / 100), handOffEpochMismatch: next(2) === 1,
      pendingWakes: next(5), lastRollbackAgeEpochs: next(8), staleHeartbeatRatio: next(150) / 100 })
    const before = structuredClone(value), expected = computeAura(value)
    assert.deepEqual(f.organ.computeAura(value), expected, 'vector ' + index)
    assert.equal(validateAuraVector(expected), true)
    for (const axis of Object.values(expected.vector)) assert.ok(Number.isFinite(axis) && axis >= 0 && axis <= 1)
    if (value.unanchoredPredictions > 0) assert.ok(expected.vector.coherence < 1)
    assert.deepEqual(value, before)
  }
  assert.equal(computeAura(inputs({ unanchoredPredictions: 1_000_000 })).vector.coherence, 1 / 200001)
  assert.deepEqual(f.writes, [])
})

for (const [label, callback] of [
  ['negative acknowledgment', () => ({ ok: false, error: 'SYNTHETIC_REFUSAL' })],
  ['absent acknowledgment', () => null],
  ['thrown append', () => { throw new Error('SYNTHETIC_THROW') }],
  ['append then throw', (f, args) => { append(f.files, args.kind, args.data); throw new Error('SYNTHETIC_LOST_ACK') }],
  ['malformed acknowledgment', () => ({ ok: true })],
  ['unpersisted acknowledgment', (f, args) => { const copy = new Map(f.files); return { ok: true, receipt: append(copy, args.kind, args.data) } }],
  ['wrong receipt data', (f, args) => ({ ok: true, receipt: append(f.files, args.kind, { ...args.data, auraSha256: 'b'.repeat(64) }) })],
  ['wrong receipt kind', (f, args) => ({ ok: true, receipt: append(f.files, 'synthetic.other', args.data) })],
  ['mutated callback input', (f, args) => {
    args.data.vector.coherence = 0
    return { ok: true, receipt: append(f.files, args.kind, args.data) }
  }],
  ['replaced prior receipt prefix', (f, args) => {
    const rows = f.files.get(RECEIPTS).split('\n').filter(Boolean).map(JSON.parse)
    rows[0].data.extra = 'synthetic rewritten history'
    const { leafHash, ...body } = rows[0]
    rows[0].leafHash = hash('\0' + canonical(body))
    f.files.set(RECEIPTS, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    return { ok: true, receipt: append(f.files, args.kind, args.data) }
  }],
  ['reformatted prior receipt bytes', (f, args) => {
    const receipt = append(f.files, args.kind, args.data)
    f.files.set(RECEIPTS, f.files.get(RECEIPTS).replace('{', '{ '))
    return { ok: true, receipt }
  }],
  ['corrupted persisted chain', (f, args) => {
    const receipt = append(f.files, args.kind, args.data)
    f.files.set(RECEIPTS, f.files.get(RECEIPTS).replace('Round26 synthetic memory', 'tampered synthetic memory'))
    return { ok: true, receipt }
  }],
]) {
  for (const previous of ['previous synthetic aura bytes\n', null]) test(`${label} preserves ${previous === null ? 'absent' : 'existing'} aura`, async () => {
    const f = fixture({ previous }), before = f.files.get(AURA)
    const result = await compute(f, (name, args) => {
      assert.equal(name, 'seed-receipts')
      assert.equal(f.files.get(AURA), before, 'aura must remain unchanged during append')
      return callback(f, args)
    })
    assert.equal(result.ok, false)
    assert.equal(result.written, false)
    assert.ok(result.error)
    assert.equal(f.files.get(AURA), before)
    assert.deepEqual(f.writes, [])
  })
}

test('only a verified persisted matching receipt permits aura publication', async () => {
  const f = fixture(), before = f.files.get(AURA)
  f.files.set(RECEIPTS, f.files.get(RECEIPTS).replace('{', '{ '))
  let recorded
  const result = await compute(f, (name, args) => {
    assert.equal(name, 'seed-receipts')
    assert.equal(f.files.get(AURA), before)
    f.events.push(['append', RECEIPTS])
    recorded = append(f.files, args.kind, args.data)
    return { ok: true, receipt: recorded }
  })
  assert.equal(result.ok, true)
  assert.equal(result.written, true)
  assert.deepEqual(result.receipt, { seq: recorded.seq, leafHash: recorded.leafHash })
  assert.deepEqual(JSON.parse(f.files.get(AURA)), result.aura)
  assert.equal(recorded.data.auraSha256, hash(canonical(result.aura)))
  assert.equal(f.writes.length, 1)
  assert.ok(f.writes[0].startsWith(AURA + '.') && f.writes[0].endsWith('.tmp'))
  assert.equal(f.files.has(f.writes[0]), false)
  const appended = f.events.findIndex(([event]) => event === 'append')
  const verified = f.events.findIndex(([event, path], index) => index > appended && event === 'read' && path === RECEIPTS)
  const staged = f.events.findIndex(([event]) => event === 'write')
  const published = f.events.findIndex(([event]) => event === 'rename')
  assert.ok(verified > appended && staged > verified && published > staged)
})

test('staged write failure preserves aura and reports the already verified receipt honestly', async () => {
  const f = fixture(), before = f.files.get(AURA)
  const write = f.fs.writeFileSync
  f.fs.writeFileSync = (path, body, options) => { write(path, 'partial synthetic temporary bytes', options); throw new Error('SYNTHETIC_WRITE_FAILURE') }
  const result = await compute(f, (_name, args) => ({ ok: true, receipt: append(f.files, args.kind, args.data) }))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'AURA_PUBLISH_FAILED')
  assert.equal(result.written, false)
  assert.equal(result.receiptStatus, 'verified')
  assert.equal(f.files.get(AURA), before)
  assert.equal(f.files.has(f.writes[0]), false)
  assert.equal(f.files.get(RECEIPTS).split('\n').filter(Boolean).length, 2)
})

test('rename failure reports unknown publication, keeps the receipt, and cleans temporary bytes', async () => {
  const f = fixture(), before = f.files.get(AURA)
  f.fs.renameSync = () => { throw new Error('SYNTHETIC_RENAME_FAILURE') }
  const result = await compute(f, (_name, args) => ({ ok: true, receipt: append(f.files, args.kind, args.data) }))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'AURA_PUBLISH_FAILED')
  assert.equal(result.written, null)
  assert.equal(result.receiptStatus, 'verified')
  assert.equal(f.files.get(AURA), before)
  assert.equal(f.files.has(f.writes[0]), false)
})

test('an exclusive temporary-path collision never deletes the existing file', async () => {
  const f = fixture(), before = f.files.get(AURA)
  let temporary
  f.fs.writeFileSync = path => {
    temporary = path
    f.files.set(path, 'synthetic other writer bytes')
    throw Object.assign(new Error('SYNTHETIC_EXISTS'), { code: 'EEXIST' })
  }
  const result = await compute(f, (_name, args) => ({ ok: true, receipt: append(f.files, args.kind, args.data) }))
  assert.equal(result.ok, false)
  assert.equal(result.written, false)
  assert.equal(result.receiptStatus, 'verified')
  assert.equal(f.files.get(AURA), before)
  assert.equal(f.files.get(temporary), 'synthetic other writer bytes')
})

test('collected gaps stay incomplete with no vector, append, or file write', async () => {
  const f = fixture(), before = new Map(f.files)
  const result = await f.organ.run({ action: 'compute' }, { organs: { call() { assert.fail('incomplete evidence must not append') } } })
  assert.equal(result.status, 'incomplete')
  assert.equal(result.vector, null)
  assert.equal(result.written, false)
  assert.ok(result.gaps.includes('wakes'))
  assert.deepEqual(f.files, before)
  assert.deepEqual(f.writes, [])
})

// Structural tripwire over the LIVE mirror organ(s): load contract only, never behaviour (see fixtures/organs/live-shape.mjs).
test('live mirror organs keep their tool-module load contract (structural only)', async () => {
  for (const name of ['seed-aura']) await assertLiveOrganShape(assert, name)
})

test('pinned organ fixtures match git history and report paired-module drift', t => {
  const provenance = verifyPinnedProvenance()
  if (!provenance.checked) return t.skip('shallow clone: fixture provenance not checked')
  assert.deepEqual(provenance.mismatches, [], 'fixtures must be byte-identical to ' + pinnedManifest().sourceCommit)
  for (const drift of pairedModuleDrift()) {
    if (drift.drifted) t.diagnostic(`${drift.path} changed since the organ pin: parity assertions now compare it to seed-aura@${pinnedManifest().sourceCommit.slice(0, 8)}; re-pin if the contract moved`)
  }
})
