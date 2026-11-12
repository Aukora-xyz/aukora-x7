const fs = require('node:fs')
const crypto = require('node:crypto')

const DIR = '/dsh/home/auma/seed/predict'
const LOG = DIR + '/predictions.jsonl'
const HEAD = '/dsh/home/balls/HEAD.json'

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => canonical(x === undefined ? null : x)).join(',') + ']'
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function readHead() {
  let raw
  try {
    raw = fs.readFileSync(HEAD, 'utf8')
  } catch (error) {
    // Unavailable HEAD evidence cannot supply a selected ball or observed metrics.
    return { ok: false, error: 'HEAD_UNREADABLE' }
  }
  let head
  try {
    head = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: 'HEAD_INVALID' }
  }
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!isRecord(head) || typeof head.ballId !== 'string' || !/^[0-9a-f]{64}$/.test(head.ballId) ||
      !Number.isSafeInteger(head.epoch) || head.epoch < 0 || Object.is(head.epoch, -0) || !isRecord(head.entries) ||
      Object.values(head.entries).some(entry => !isRecord(entry) ||
        (Object.hasOwn(entry, 'disabled') && typeof entry.disabled !== 'boolean') ||
        (Object.hasOwn(entry, 'previousSpecifiers') && (!Array.isArray(entry.previousSpecifiers) ||
          entry.previousSpecifiers.some(specifier => typeof specifier !== 'string'))))) {
    return { ok: false, error: 'HEAD_INVALID' }
  }
  return { ok: true, head }
}

function organCount(head) {
  return head && head.entries ? Object.keys(head.entries).length : 0
}

function readAll() {
  try {
    return fs
      .readFileSync(LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (_) {
    return []
  }
}

function append(record) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.appendFileSync(LOG, canonical(record) + '\n', 'utf8')
}

// Receipt anchoring. A prediction that names its target ball (targetBallId + targetEpoch), one
// numeric metric and an expected value is also sealed as a `prediction.register` receipt leaf, and its
// observation as a `prediction.observe` leaf, both appended through seed-receipts (the only writer). The
// leaf data is exactly what the readers bind (server/messages-store.mjs, prediction.ts):
// { predictionId, targetBallId, targetEpoch, metric, expected | observed }. No score is stored: readers
// recompute surprise as |observed - expected| / max(|expected|, 1). An observation is only recorded once the
// target ball is the selected head and its promotion receipt follows the registration, so the trajectory is
// register -> promotion -> observe in the receipt chain itself.
const RECEIPTS = '/dsh/home/auma/seed/receipts.v3.jsonl'
const PROMOTIONS = new Set(['ball.promote', 'tree.patch', 'tree.undo', 'snapshot.restore', 'seed.bootstrap'])
const METRICS = {
  declaredOrgans: (head) => organCount(head),
  activeOrgans: (head) => (head && head.entries ? Object.values(head.entries).filter((e) => e && e.disabled !== true).length : 0),
  epoch: (head) => (Number.isInteger(head.epoch) ? head.epoch : null),
}

function readReceipts(allowAbsent = false) {
  try {
    const rows = fs.readFileSync(RECEIPTS, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    let previous = '0'.repeat(64)
    for (const [index, row] of rows.entries()) {
      if (!row || row.schema !== 'aukora.receipt.v3' || row.seq !== index + 1 || row.prevHash !== previous ||
          !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) return null
      const body = { ...row }; delete body.leafHash
      const leaf = crypto.createHash('sha256').update(Buffer.from([0])).update(canonical(body)).digest('hex')
      if (row.leafHash !== leaf) return null
      previous = leaf
    }
    return rows
  } catch (error) {
    return allowAbsent && error && error.code === 'ENOENT' ? [] : null
  }
}

function registrationSealed(registration) {
  const keys = ['prediction', 'expectedEpoch', 'expectedOrganCount', 'expectedBallId', 'expectedEntry', 'expectedPreviousCount', 'confidence']
  if (hasAnchoredFields(registration)) keys.push(...TARGET_FIELDS)
  const prediction = Object.fromEntries(keys.map(key => [key, registration[key]]))
  return registration.predictionHash === sha256(canonical(prediction))
}

function receiptMatches(data, registration) {
  return data.predictionId === registration.predictionHash &&
    ['targetBallId', 'targetEpoch', 'metric'].every(key => data[key] === registration[key]) && !Object.hasOwn(data, 'surpriseScore')
}

function anchoredRegistration(registration, receipts) {
  if (!receipts || !registrationSealed(registration) || !anchoredTarget(registration).anchored) return null
  const matches = receipts.filter(row => row.kind === 'prediction.register' && row.data.predictionId === registration.predictionHash)
  const register = matches.length === 1 ? matches[0] : null
  return register && receiptMatches(register.data, registration) && register.data.expected === registration.expected ? register : null
}

// Recompute only from one verified register -> promotion -> observe path. Mutable log scores are not evidence.
function anchoredTrajectory(registration, receipts) {
  const register = anchoredRegistration(registration, receipts)
  if (!register) return null
  const matches = receipts.filter(row => row.kind === 'prediction.observe' && row.data.predictionId === registration.predictionHash)
  const observe = matches.length === 1 ? matches[0] : null
  if (!observe || !receiptMatches(observe.data, registration)) return null
  const promotion = receipts.find(row => PROMOTIONS.has(row.kind) && row.seq > register.seq && row.seq < observe.seq &&
    row.data.ballId === register.data.targetBallId && row.data.epoch === register.data.targetEpoch)
  const error = predictionError(register.data.expected, observe.data.observed)
  return promotion && error !== null ? { register, promotion, observe, error } : null
}

const TARGET_FIELDS = ['metric', 'expected', 'targetBallId', 'targetEpoch']

function hasAnchoredFields(args) {
  return TARGET_FIELDS.some(key => Object.hasOwn(args, key))
}

function anchoredTarget(args) {
  if (!hasAnchoredFields(args)) return { anchored: false }
  const missing = TARGET_FIELDS.filter(key => !Object.hasOwn(args, key) || args[key] === undefined)
  if (missing.length) return { error: 'PREDICTION_TARGET_INCOMPLETE', missing }
  if (typeof args.metric !== 'string' || !Object.hasOwn(METRICS, args.metric)) return { error: 'PREDICTION_METRIC_UNKNOWN', metrics: Object.keys(METRICS) }
  if (typeof args.expected !== 'number' || !Number.isFinite(args.expected) || Object.is(args.expected, -0)) return { error: 'PREDICTION_EXPECTED_INVALID' }
  if (typeof args.targetBallId !== 'string' || !/^[0-9a-f]{64}$/.test(args.targetBallId)) return { error: 'PREDICTION_TARGET_INVALID' }
  if (!Number.isSafeInteger(args.targetEpoch) || args.targetEpoch < 0 || Object.is(args.targetEpoch, -0)) return { error: 'PREDICTION_TARGET_INVALID' }
  return { anchored: true, metric: args.metric, expected: args.expected, targetBallId: args.targetBallId, targetEpoch: args.targetEpoch }
}

async function appendReceipt(ctx, kind, data) {
  const organs = ctx && ctx.organs
  if (!organs || typeof organs.call !== 'function') return { ok: false, error: 'RECEIPTS_ORGAN_UNAVAILABLE' }
  try {
    const result = await organs.call('seed-receipts', { action: 'append', kind, data })
    return result && result.ok === true ? { ok: true, receipt: result.receipt } : { ok: false, error: (result && result.error) || 'RECEIPT_NOT_ACKNOWLEDGED' }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** Canonical receipt calibration error, separate from task accomplishment and legacy penalties. */
function predictionError(expected, observed) {
  if (!Number.isFinite(expected) || !Number.isFinite(observed) || Object.is(expected, -0) || Object.is(observed, -0)) return null
  const error = Math.abs(observed - expected) / Math.max(Math.abs(expected), 1)
  return Number.isFinite(error) ? error : null
}

// Legacy field-mismatch penalty only. This 0..100 scale is never forecast calibration.
function legacyPenalty(prediction, head) {
  let score = 0
  const misses = []
  if (Number.isInteger(prediction.expectedEpoch) && prediction.expectedEpoch !== head.epoch) {
    score += 50
    misses.push('epoch')
  }
  if (Number.isInteger(prediction.expectedOrganCount) && prediction.expectedOrganCount !== organCount(head)) {
    score += 30
    misses.push('organCount')
  }
  if (typeof prediction.expectedBallId === 'string' && prediction.expectedBallId !== head.ballId) {
    score += 20
    misses.push('ballId')
  }
  // Internal-state prediction: the rollback depth of a named entry. Not derivable from
  // the previous head by guessing epoch+1, so getting it right is actual evidence.
  if (Number.isInteger(prediction.expectedPreviousCount) && typeof prediction.expectedEntry === 'string') {
    const entry = head && head.entries ? head.entries[prediction.expectedEntry] : null
    const actual = entry && Array.isArray(entry.previousSpecifiers) ? entry.previousSpecifiers.length : 0
    if (actual !== prediction.expectedPreviousCount) {
      score += 25
      misses.push('previousCount')
    }
  }
  return { legacyPenaltyV0: score === 0 ? 0 : Math.max(1, Math.min(100, score)), misses }
}

module.exports = {
  predictionError,
  name: 'seed-predict',
  description:
    'Pre-registered prediction loop: pass metric, expected, targetBallId and targetEpoch to seal register and observe as receipt leaves. register() seals a prediction about the NEXT promotion and returns its sha256 BEFORE anything changes. register(), observe() and status() refuse unavailable or invalid HEAD evidence; no registration or observation is written. Any anchored target field requires the complete validated target. observe() reports canonical receipt_error = abs(observed - expected) / max(abs(expected), 1), also named surpriseScore, or null for a legacy-only prediction. The old 0..100 field-mismatch penalty is separately named legacyPenaltyV0. Neither measures task accomplishment. trajectory_export() pairs register -> observe and separates the two scales, including older records.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['register', 'observe', 'trajectory_export', 'status'] },
      prediction: { type: 'string', description: 'Plain-language claim being made about the next promotion.' },
      expectedEpoch: { type: 'number' },
      expectedOrganCount: { type: 'number' },
      expectedBallId: { type: 'string' },
      expectedEntry: { type: 'string', description: 'Entry id whose rollback depth is being predicted.' },
      expectedPreviousCount: { type: 'number', description: 'Predicted length of that entry previousSpecifiers after the next promotion.' },
      confidence: { type: 'number' },
      predictionHash: { type: 'string', description: 'Hash returned by register, for observe.' },
      metric: { type: 'string', enum: ['declaredOrgans', 'activeOrgans', 'epoch'], description: 'Receipt-anchored form: the one numeric metric predicted for the target ball.' },
      expected: { type: 'number', description: 'Receipt-anchored form: the predicted value of metric.' },
      targetBallId: { type: 'string', description: 'Receipt-anchored form: the candidate ball being promoted (64 hex).' },
      targetEpoch: { type: 'number', description: 'Receipt-anchored form: the epoch that ball will have.' },
    },
    required: ['action'],
    additionalProperties: false,
  },

  async run(args, ctx) {
    const action = args && args.action
    const selected = ['register', 'observe', 'status'].includes(action) ? readHead() : null
    if (selected && !selected.ok) return { ok: false, action, error: selected.error, written: false }
    const head = selected && selected.head

    if (action === 'register') {
      const target = anchoredTarget(args || {})
      if (target.error) return { ok: false, action, ...target }
      const prediction = {
        prediction: typeof args.prediction === 'string' ? args.prediction : null,
        expectedEpoch: Number.isInteger(args.expectedEpoch) ? args.expectedEpoch : null,
        expectedOrganCount: Number.isInteger(args.expectedOrganCount) ? args.expectedOrganCount : null,
        expectedBallId: typeof args.expectedBallId === 'string' ? args.expectedBallId : null,
        expectedEntry: typeof args.expectedEntry === 'string' ? args.expectedEntry : null,
        expectedPreviousCount: Number.isInteger(args.expectedPreviousCount) ? args.expectedPreviousCount : null,
        confidence: typeof args.confidence === 'number' ? args.confidence : null,
        ...(target.anchored ? { metric: target.metric, expected: target.expected, targetBallId: target.targetBallId, targetEpoch: target.targetEpoch } : {}),
      }
      const predictionHash = sha256(canonical(prediction))
      const previousLogs = readAll().filter(row => row.kind === 'prediction.register' && row.predictionHash === predictionHash)
      if (previousLogs.some(row => !registrationSealed(row))) return { ok: false, action, error: 'PREDICTION_REGISTRATION_HASH_MISMATCH', predictionHash }
      let record = previousLogs[0] || {
        kind: 'prediction.register',
        predictionHash,
        at: new Date().toISOString(),
        headBallId: head.ballId || null,
        headEpoch: Number.isInteger(head.epoch) ? head.epoch : null,
        headOrganCount: organCount(head),
        ...prediction,
      }
      let receipt = null
      if (target.anchored) {
        const receipts = readReceipts(true)
        if (!receipts) return { ok: false, action, error: 'RECEIPTS_UNREADABLE', predictionHash }
        const matches = receipts.filter(row => row.kind === 'prediction.register' && row.data.predictionId === predictionHash)
        if (matches.length) {
          const registered = anchoredRegistration(record, receipts)
          if (!registered) return { ok: false, action, error: 'PREDICTION_REGISTRATION_CONFLICT', predictionHash }
          receipt = { ok: true, receipt: registered }
          // Recovery without a local log cannot invent the head observed when the receipt was sealed.
          if (!previousLogs.length) record = { ...record, at: registered.at, headBallId: null, headEpoch: null, headOrganCount: null }
        } else if (target.targetBallId === head.ballId) return { ok: false, action, error: 'PREDICTION_TARGET_ALREADY_SELECTED' }
      }
      // Preserve the sealed preimage across a lost receipt acknowledgment without duplicating local rows.
      if (!previousLogs.length) append(record)
      if (target.anchored && !receipt) {
        receipt = await appendReceipt(ctx, 'prediction.register', {
          predictionId: predictionHash, targetBallId: target.targetBallId, targetEpoch: target.targetEpoch, metric: target.metric, expected: target.expected,
        })
        if (receipt.ok) {
          const registered = anchoredRegistration(record, readReceipts())
          receipt = registered ? { ok: true, receipt: registered } : { ok: false, error: 'PREDICTION_REGISTER_UNANCHORED' }
        }
      }
      return { ok: !receipt || receipt.ok, action, predictionHash, sealedAt: record.at, headEpoch: record.headEpoch, headOrganCount: record.headOrganCount, prediction,
        ...(receipt ? { receipt: receipt.ok ? { seq: receipt.receipt.seq, leafHash: receipt.receipt.leafHash } : null, receiptError: receipt.ok ? undefined : receipt.error } : {}) }
    }

    if (action === 'observe') {
      const hash = args && args.predictionHash
      const all = readAll()
      const registration = all.filter((r) => r.kind === 'prediction.register' && r.predictionHash === hash).pop()
      if (!registration) return { ok: false, error: 'PREDICTION_NOT_FOUND', predictionHash: hash || null }
      if (!registrationSealed(registration)) return { ok: false, error: 'PREDICTION_REGISTRATION_HASH_MISMATCH', predictionHash: hash }
      const target = anchoredTarget(registration)
      if (target.error) return { ok: false, action, ...target, predictionHash: hash, written: false }
      const already = all.some((r) => r.kind === 'prediction.observe' && r.predictionHash === hash)
      if (already) return { ok: false, error: 'PREDICTION_ALREADY_OBSERVED', predictionHash: hash }
      let anchoredObserve = null
      let sealedExpected = null
      let receipt = null
      if (target.anchored) {
        // The receipt-anchored form is only observed on its own target, after its promotion is recorded.
        if (head.ballId !== registration.targetBallId || head.epoch !== registration.targetEpoch) {
          return { ok: false, error: 'PREDICTION_TARGET_NOT_SELECTED', predictionHash: hash, targetBallId: registration.targetBallId, targetEpoch: registration.targetEpoch, headBallId: head.ballId || null }
        }
        const receipts = readReceipts()
        if (!receipts) return { ok: false, error: 'RECEIPTS_UNREADABLE', predictionHash: hash }
        const register = anchoredRegistration(registration, receipts)
        if (!register) return { ok: false, error: 'PREDICTION_REGISTER_UNANCHORED', predictionHash: hash }
        sealedExpected = register.data.expected
        const promotion = receipts.find((r) => PROMOTIONS.has(r.kind) && r.seq > register.seq && r.data && r.data.ballId === registration.targetBallId && r.data.epoch === registration.targetEpoch)
        if (!promotion) return { ok: false, error: 'PREDICTION_PROMOTION_UNRECORDED', predictionHash: hash }
        const value = METRICS[register.data.metric](head)
        if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: 'PREDICTION_METRIC_UNAVAILABLE', predictionHash: hash }
        anchoredObserve = { predictionId: hash, targetBallId: registration.targetBallId, targetEpoch: registration.targetEpoch, metric: registration.metric, observed: value }
        // A previous append may have committed before its acknowledgment or the log write failed.
        if (receipts.some(row => row.kind === 'prediction.observe' && row.data.predictionId === hash)) {
          const prior = anchoredTrajectory(registration, receipts)
          if (!prior) return { ok: false, error: 'PREDICTION_OBSERVATION_CONFLICT', predictionHash: hash }
          anchoredObserve = prior.observe.data
          receipt = { ok: true, receipt: prior.observe }
        }
      }
      const measured = legacyPenalty(registration, head)
      const receiptError = anchoredObserve ? predictionError(sealedExpected, anchoredObserve.observed) : null
      if (anchoredObserve && receiptError === null) return { ok: false, error: 'PREDICTION_CALIBRATION_INVALID', predictionHash: hash }
      if (anchoredObserve && !receipt) {
        receipt = await appendReceipt(ctx, 'prediction.observe', anchoredObserve)
        const verified = receipt.ok ? anchoredTrajectory(registration, readReceipts()) : null
        if (!verified || verified.observe.data.observed !== anchoredObserve.observed) {
          return { ok: false, action, predictionHash: hash, calibrationStatus: 'unanchored', calibrationVersion: null,
            receipt_error: null, surpriseScore: null, legacyPenaltyV0: measured.legacyPenaltyV0,
            error: receipt.ok ? 'PREDICTION_OBSERVATION_UNANCHORED' : receipt.error, receipt: null, written: false }
        }
        receipt = { ok: true, receipt: verified.observe }
      }
      const observed = {
        kind: 'prediction.observe',
        predictionHash: hash,
        at: new Date().toISOString(),
        headBallId: head.ballId || null,
        headEpoch: Number.isInteger(head.epoch) ? head.epoch : null,
        headOrganCount: organCount(head),
        calibrationVersion: anchoredObserve ? 'receipt-error-v1' : null,
        calibrationStatus: anchoredObserve ? 'receipt-anchored' : 'legacy-only',
        metric: anchoredObserve ? anchoredObserve.metric : null,
        observedMetric: anchoredObserve ? anchoredObserve.observed : null,
        receipt_error: receiptError,
        surpriseScore: receiptError,
        legacyPenaltyV0: measured.legacyPenaltyV0,
        misses: measured.misses,
        exceptionRuleCandidate: receiptError !== null ? receiptError > 0 : measured.legacyPenaltyV0 > 0,
      }
      append(observed)
      return { ok: !receipt || receipt.ok, action, ...observed, predicted: registration,
        ...(receipt ? { anchored: anchoredObserve, receipt: receipt.ok ? { seq: receipt.receipt.seq, leafHash: receipt.receipt.leafHash } : null, receiptError: receipt.ok ? undefined : receipt.error } : {}) }
    }

    if (action === 'trajectory_export') {
      const all = readAll()
      const registrations = all.filter((r) => r.kind === 'prediction.register')
      const observations = all.filter((r) => r.kind === 'prediction.observe')
      const receipts = readReceipts()
      const trajectories = []
      const calibratedPredictions = new Set()
      for (const registration of registrations) {
        const observation = observations.filter((o) => o.predictionHash === registration.predictionHash).pop()
        if (!observation) continue
        const trajectory = anchoredTrajectory(registration, receipts)
        // Repeated log rows are not additional receipt-backed observations.
        if (trajectory && calibratedPredictions.has(registration.predictionHash)) continue
        if (trajectory) calibratedPredictions.add(registration.predictionHash)
        const receiptError = trajectory ? trajectory.error : null
        // Historical surpriseScore records used the heuristic scale; never relabel them as receipt error.
        const oldPenalty = observation.legacyPenaltyV0 ?? (observation.calibrationVersion == null ? observation.surpriseScore : null)
        const legacyPenaltyV0 = typeof oldPenalty === 'number' && Number.isFinite(oldPenalty) && oldPenalty >= 0 && oldPenalty <= 100 ? oldPenalty : null
        trajectories.push({
          predictionHash: registration.predictionHash,
          sealedAt: registration.at,
          observedAt: observation.at,
          epochBefore: registration.headEpoch,
          epochAfter: observation.headEpoch,
          predicted: {
            epoch: registration.expectedEpoch,
            organCount: registration.expectedOrganCount,
            ballId: registration.expectedBallId,
            confidence: registration.confidence,
          },
          observed: {
            epoch: observation.headEpoch,
            organCount: observation.headOrganCount,
            ballId: observation.headBallId,
          },
          calibrationVersion: receiptError !== null ? 'receipt-error-v1' : null,
          calibrationStatus: trajectory ? 'receipt-anchored' : hasAnchoredFields(registration) ? 'unanchored' : 'legacy-only',
          receipt_error: receiptError,
          surpriseScore: receiptError,
          legacyPenaltyV0,
          misses: observation.misses,
          exceptionRuleCandidate: receiptError !== null ? receiptError > 0 : legacyPenaltyV0 !== null && legacyPenaltyV0 > 0,
        })
      }
      const scores = trajectories.map((t) => t.receipt_error).filter((score) => score !== null)
      const penalties = trajectories.map((t) => t.legacyPenaltyV0).filter((score) => score !== null)
      const mean = (values) => values.length ? values.reduce((average, value, index) => average + (value - average) / (index + 1), 0) : null
      return {
        ok: true,
        action,
        count: trajectories.length,
        summary: {
          totalTrajectories: trajectories.length,
          calibrationCount: scores.length,
          zeroSurpriseCount: scores.filter((s) => s === 0).length,
          surpriseCount: scores.filter((s) => s > 0).length,
          meanSurpriseScore: mean(scores),
          legacyPenaltyCount: penalties.length,
          meanLegacyPenaltyV0: mean(penalties),
        },
        trajectories,
      }
    }

    if (action === 'status') {
      const all = readAll()
      const registrations = all.filter((r) => r.kind === 'prediction.register')
      const observations = all.filter((r) => r.kind === 'prediction.observe')
      const latest = registrations[registrations.length - 1] || null
      return {
        ok: true,
        action,
        liveHead: { ballId: head.ballId || null, epoch: Number.isInteger(head.epoch) ? head.epoch : null, organCount: organCount(head) },
        registers: registrations.length,
        observes: observations.length,
        pendingObservation: registrations.filter((r) => !observations.some((o) => o.predictionHash === r.predictionHash)).length,
        latest,
      }
    }

    return { ok: false, error: 'UNKNOWN_ACTION', action: action || null }
  },
}
