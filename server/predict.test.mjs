/** Round26 prediction regressions use source code and in-memory files only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as crypto from 'node:crypto'

const source = readFileSync(new URL('../mirror/home/auma/seed/organs/seed-predict.js', import.meta.url), 'utf8')
const HEAD = '/dsh/home/balls/HEAD.json'
const LOG = '/dsh/home/auma/seed/predict/predictions.jsonl'
const RECEIPTS = '/dsh/home/auma/seed/receipts.v3.jsonl'
const validHead = { ballId: 'a'.repeat(64), epoch: 162, entries: {} }
const target = { metric: 'epoch', expected: 163, targetBallId: 'b'.repeat(64), targetEpoch: 163 }
const legacy = { prediction: null, expectedEpoch: 163, expectedOrganCount: null, expectedBallId: null,
  expectedEntry: null, expectedPreviousCount: null, confidence: null }
const hash = text => crypto.createHash('sha256').update(text).digest('hex')
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
}

function fixture(head = validHead) {
  const files = new Map(), writes = [], receiptCalls = [], module = { exports: {} }
  const fs = {
    readFileSync(path) {
      if (!files.has(path)) throw Object.assign(new Error('Synthetic file absent'), { code: 'ENOENT' })
      return files.get(path)
    },
    mkdirSync(path) { writes.push({ operation: 'mkdir', path }) },
    appendFileSync(path, data) {
      writes.push({ operation: 'append', path })
      files.set(path, (files.get(path) ?? '') + data)
    },
  }
  new Function('require', 'module', 'exports', source)(name => {
    if (name === 'node:fs') return fs
    if (name === 'node:crypto') return crypto
    throw new Error('Unexpected organ dependency: ' + name)
  }, module, module.exports)
  if (head !== undefined) files.set(HEAD, JSON.stringify(head))
  const rows = path => (files.get(path) ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const receipt = (kind, data) => {
    const previous = rows(RECEIPTS)
    const body = { schema: 'aukora.receipt.v3', seq: previous.length + 1, at: '2026-11-09T00:00:00.000Z',
      kind, data, prevHash: previous.at(-1)?.leafHash ?? '0'.repeat(64) }
    const row = { ...body, leafHash: crypto.createHash('sha256').update(Buffer.from([0])).update(canonical(body)).digest('hex') }
    files.set(RECEIPTS, [...previous, row].map(value => JSON.stringify(value)).join('\n') + '\n')
    return row
  }
  const ctx = { organs: { async call(name, args) {
    assert.equal(name, 'seed-receipts')
    receiptCalls.push(args)
    return { ok: true, receipt: receipt(args.kind, args.data) }
  } } }
  return { organ: module.exports, files, writes, receiptCalls, rows, receipt, ctx }
}

async function unchanged(f, args, expectedError) {
  const before = new Map(f.files), writes = f.writes.length, calls = f.receiptCalls.length
  const result = await f.organ.run(args, f.ctx)
  assert.equal(result.ok, false)
  assert.equal(result.error, expectedError)
  assert.deepEqual(f.files, before, 'Refusal must leave all synthetic files byte-identical')
  assert.equal(f.writes.length, writes, 'Refusal must not attempt a local write')
  assert.equal(f.receiptCalls.length, calls, 'Refusal must not append a receipt')
  return result
}

function putRegistration(f, prediction) {
  const predictionHash = hash(canonical(prediction))
  f.files.set(LOG, JSON.stringify({ kind: 'prediction.register', predictionHash, ...prediction }) + '\n')
  return predictionHash
}

test('missing and corrupt HEAD refuse register, observe and status before writes or scoring', async () => {
  for (const [raw, error] of [[undefined, 'HEAD_UNREADABLE'], ['{', 'HEAD_INVALID'], ['', 'HEAD_INVALID']]) {
    for (const anchored of [false, true]) {
      const f = fixture()
      const registered = await f.organ.run({ action: 'register', ...legacy, ...(anchored ? target : {}) }, f.ctx)
      assert.equal(registered.ok, true)
      if (raw === undefined) f.files.delete(HEAD)
      else f.files.set(HEAD, raw)
      for (const args of [{ action: 'register', ...legacy }, { action: 'register', ...target },
        { action: 'observe', predictionHash: registered.predictionHash }, { action: 'status' }]) {
        const result = await unchanged(f, args, error)
        assert.equal(result.written, false)
        assert.equal(result.surpriseScore, undefined)
        assert.equal(result.legacyPenaltyV0, undefined)
      }
    }
  }
})

test('HEAD requires a known ball, epoch and measurable entry fields', async () => {
  const invalid = [null, false, 162, 'head', [], {}, { ...validHead, ballId: null }, { ...validHead, ballId: '' },
    { ...validHead, ballId: 'A'.repeat(64) }, { ...validHead, ballId: 'f'.repeat(63) },
    { ...validHead, epoch: null }, { ...validHead, epoch: '162' }, { ...validHead, epoch: -1 },
    { ...validHead, epoch: 62.5 }, { ...validHead, epoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...validHead, entries: null }, { ...validHead, entries: [] }, { ...validHead, entries: 'unknown' },
    { ...validHead, entries: { missing: null } }, { ...validHead, entries: { malformed: [] } },
    { ...validHead, entries: { malformed: { disabled: 'false' } } },
    { ...validHead, entries: { malformed: { previousSpecifiers: null } } },
    { ...validHead, entries: { malformed: { previousSpecifiers: [null] } } }]
  for (const head of invalid) {
    const f = fixture(head), predictionHash = putRegistration(f, legacy)
    for (const args of [{ action: 'register', ...target }, { action: 'observe', predictionHash }, { action: 'status' }]) {
      await unchanged(f, args, 'HEAD_INVALID')
    }
  }
  const f = fixture()
  f.files.set(HEAD, '{"ballId":"' + validHead.ballId + '","epoch":-0,"entries":{}}')
  await unchanged(f, { action: 'register', ...legacy }, 'HEAD_INVALID')
})

test('every present anchored field requires a complete validated registration target', async () => {
  for (const field of Object.keys(target)) {
    for (const value of [target[field], null, undefined]) {
      await unchanged(fixture(), { action: 'register', [field]: value }, 'PREDICTION_TARGET_INCOMPLETE')
    }
    const incomplete = { ...target }; delete incomplete[field]
    await unchanged(fixture(), { action: 'register', ...incomplete }, 'PREDICTION_TARGET_INCOMPLETE')
  }
  const invalid = [
    ['targetBallId', null, 'PREDICTION_TARGET_INVALID'], ['targetBallId', '', 'PREDICTION_TARGET_INVALID'],
    ['targetBallId', 'B'.repeat(64), 'PREDICTION_TARGET_INVALID'],
    ['targetEpoch', null, 'PREDICTION_TARGET_INVALID'], ['targetEpoch', '163', 'PREDICTION_TARGET_INVALID'],
    ['targetEpoch', -1, 'PREDICTION_TARGET_INVALID'], ['targetEpoch', -0, 'PREDICTION_TARGET_INVALID'],
    ['targetEpoch', Number.MAX_SAFE_INTEGER + 1, 'PREDICTION_TARGET_INVALID'],
    ['expected', null, 'PREDICTION_EXPECTED_INVALID'], ['expected', Infinity, 'PREDICTION_EXPECTED_INVALID'],
    ['expected', -0, 'PREDICTION_EXPECTED_INVALID'], ['expected', '163', 'PREDICTION_EXPECTED_INVALID'],
    ['metric', ['epoch'], 'PREDICTION_METRIC_UNKNOWN'], ['metric', null, 'PREDICTION_METRIC_UNKNOWN'],
    ['metric', 'constructor', 'PREDICTION_METRIC_UNKNOWN'],
  ]
  for (const [field, value, error] of invalid) await unchanged(fixture(), { action: 'register', ...target, [field]: value }, error)
})

test('sealed malformed anchored rows never fall through to legacy observations', async () => {
  const invalid = [
    [{ ...legacy, ...target, targetBallId: null }, 'PREDICTION_TARGET_INVALID'],
    [{ ...legacy, ...target, targetEpoch: null }, 'PREDICTION_TARGET_INVALID'],
    [{ ...legacy, ...target, expected: null }, 'PREDICTION_EXPECTED_INVALID'],
    [{ ...legacy, ...target, metric: ['epoch'] }, 'PREDICTION_METRIC_UNKNOWN'],
    [{ ...legacy, metric: 'epoch' }, 'PREDICTION_TARGET_INCOMPLETE'],
    [{ ...legacy, expected: 163 }, 'PREDICTION_TARGET_INCOMPLETE'],
    [{ ...legacy, targetEpoch: 163 }, 'PREDICTION_TARGET_INCOMPLETE'],
  ]
  for (const [prediction, error] of invalid) {
    const f = fixture(), predictionHash = putRegistration(f, prediction)
    await unchanged(f, { action: 'observe', predictionHash }, error)
  }
  const f = fixture(), predictionHash = putRegistration(f, legacy)
  const row = f.rows(LOG)[0]; row.metric = 'epoch'
  f.files.set(LOG, JSON.stringify(row) + '\n')
  await unchanged(f, { action: 'observe', predictionHash }, 'PREDICTION_REGISTRATION_HASH_MISMATCH')
})

test('null targets at earlier, equal and later epochs are invalid, never superseded evidence', async () => {
  for (const targetEpoch of [61, 162, 163]) {
    const f = fixture(), predictionHash = putRegistration(f, { ...legacy, ...target, targetBallId: null, targetEpoch })
    await unchanged(f, { action: 'observe', predictionHash }, 'PREDICTION_TARGET_INVALID')
  }
})

test('awaiting, passed and replaced targets retain target-not-selected refusal without observations', async () => {
  for (const head of [validHead, { ...validHead, epoch: 163 }, { ...validHead, epoch: 164 },
    { ...validHead, ballId: target.targetBallId, epoch: 164 }]) {
    const f = fixture(), registered = await f.organ.run({ action: 'register', ...target }, f.ctx)
    assert.equal(registered.ok, true)
    f.files.set(HEAD, JSON.stringify(head))
    await unchanged(f, { action: 'observe', predictionHash: registered.predictionHash }, 'PREDICTION_TARGET_NOT_SELECTED')
  }
})

test('selected targets still require a later promotion receipt and yield canonical calibration', async () => {
  const f = fixture(), registered = await f.organ.run({ action: 'register', ...target }, f.ctx)
  assert.equal(registered.ok, true)
  f.files.set(HEAD, JSON.stringify({ ...validHead, ballId: target.targetBallId, epoch: target.targetEpoch }))
  await unchanged(f, { action: 'observe', predictionHash: registered.predictionHash }, 'PREDICTION_PROMOTION_UNRECORDED')
  f.receipt('ball.promote', { ballId: target.targetBallId, epoch: target.targetEpoch })
  const observed = await f.organ.run({ action: 'observe', predictionHash: registered.predictionHash }, f.ctx)
  assert.equal(observed.ok, true)
  assert.equal(observed.calibrationStatus, 'receipt-anchored')
  assert.equal(observed.receipt_error, 0)
  assert.equal(observed.surpriseScore, 0)
  assert.equal(f.rows(RECEIPTS).filter(row => row.kind === 'prediction.observe').length, 1)
  await unchanged(f, { action: 'observe', predictionHash: registered.predictionHash }, 'PREDICTION_ALREADY_OBSERVED')
})

test('valid legacy observations retain their penalty with explicitly unavailable calibration', async () => {
  const f = fixture(), registered = await f.organ.run({ action: 'register', ...legacy }, f.ctx)
  const observed = await f.organ.run({ action: 'observe', predictionHash: registered.predictionHash }, f.ctx)
  assert.equal(observed.ok, true)
  assert.equal(observed.calibrationStatus, 'legacy-only')
  assert.equal(observed.receipt_error, null)
  assert.equal(observed.surpriseScore, null)
  assert.equal(observed.legacyPenaltyV0, 50)
  assert.equal(f.receiptCalls.length, 0)
})

test('export labels malformed targets unanchored and keeps historical penalties outside calibration', async () => {
  for (const prediction of [{ ...legacy, ...target, targetBallId: null }, { ...legacy, metric: 'epoch' }, legacy]) {
    const f = fixture(), predictionHash = putRegistration(f, prediction)
    f.files.set(LOG, f.files.get(LOG) + JSON.stringify({ kind: 'prediction.observe', predictionHash, surpriseScore: 50 }) + '\n')
    f.files.delete(HEAD)
    const exported = await f.organ.run({ action: 'trajectory_export' })
    assert.equal(exported.ok, true)
    assert.equal(exported.summary.calibrationCount, 0)
    assert.equal(exported.summary.meanSurpriseScore, null)
    assert.equal(exported.trajectories[0].calibrationStatus, Object.hasOwn(prediction, 'metric') ? 'unanchored' : 'legacy-only')
    assert.equal(exported.trajectories[0].surpriseScore, null)
    assert.equal(exported.trajectories[0].legacyPenaltyV0, 50)
    assert.equal(f.writes.length, 0)
    assert.equal(f.receiptCalls.length, 0)
  }
})

test('valid empty HEAD entries remain measurable and status does not write', async () => {
  const f = fixture({ ...validHead, epoch: 0 })
  const result = await f.organ.run({ action: 'status' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.liveHead, { ballId: validHead.ballId, epoch: 0, organCount: 0 })
  assert.equal(f.writes.length, 0)
})
