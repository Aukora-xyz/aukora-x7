import { verifyReceiptChain, type VerifiedReceipt } from './lineage.ts'
import type { DiscoveryTrajectoryCorpus, DiscoveryTrajectoryRecord } from './types.ts'

/** Corpus result. `leafRecomputed` is true only after every leaf digest matched. */
export interface DiscoveryCorpusResult extends Omit<DiscoveryTrajectoryCorpus, 'leafRecomputed'> {
  readonly leafRecomputed: boolean
  /** `insufficient` means a row had no organ source fields. That is not a verified chain. */
  readonly chainStatus: 'verified' | 'malformed' | 'insufficient'
}

/**
 * Fail-closed prediction readout.
 *
 * When this was written, no organ writes `prediction.register` or
 * `prediction.observe`. This module defines the shape those receipts must
 * have before a surprise score is shown. A score field on the receipt is
 * not used. Absence is not a verified prediction.
 */

const REGISTER = 'prediction.register'
const OBSERVE = 'prediction.observe'
const PROMOTIONS = new Set(['ball.promote', 'tree.patch', 'tree.undo', 'snapshot.restore', 'seed.bootstrap'])
const HEX_64 = /^[0-9a-f]{64}$/

/** One intact receipt the prediction walk can see. */
export interface PredictionReceipt {
  readonly seq: number
  readonly kind: string
  readonly intact: boolean
  readonly data: Readonly<Record<string, unknown>>
}

/**
 * Computed prediction, or why none is shown.
 * `leafRecomputed` is false for a legacy row that has no `leafHash`. That result
 * is not a SHA-256 check. It is true only after `verifyReceiptChain` matched every leaf.
 */
export interface PredictionReadout {
  readonly status: 'absent' | 'verified' | 'rejected'
  readonly surpriseScore: number | null
  readonly reason: string
  readonly leafRecomputed: boolean
}

/**
 * Judge prediction receipts.
 * A row with `leafHash` is modern: the whole list must recompute. `intact` is ignored.
 * A list with no `leafHash` stays the legacy binding walk and is marked `leafRecomputed: false`.
 * @param receipts - Legacy `{seq, kind, intact, data}` or full `aukora.receipt.v3` rows.
 * @returns `absent` when those kinds are missing. `verified` only after register, then promotion, then observation.
 */
export function assessPredictions(receipts: readonly unknown[]): PredictionReadout {
  if (receipts.some(hasLeafHash)) {
    if (receipts.some(row => !hasLeafHash(row))) {
      return readout('rejected', null, 'prediction-leaf-unverified', false)
    }
    const chain = verifyReceiptChain(receipts)
    if (chain.status !== 'verified') return readout('rejected', null, 'prediction-leaf-unverified', false)
    return judgeVerified(chain.receipts)
  }
  const legacy = receipts.filter(isLegacyReceipt)
  const rows = legacy.filter(item => item.intact && (item.kind === REGISTER || item.kind === OBSERVE))
  if (rows.length === 0) return readout('absent', null, 'prediction-schema-absent', false)
  const registers = rows.filter(item => item.kind === REGISTER)
  const observes = rows.filter(item => item.kind === OBSERVE)
  if (registers.length === 0 || observes.length === 0) {
    return readout('rejected', null, 'prediction-incomplete', false)
  }
  for (const registration of registers) {
    const registered = fields(registration.data, 'expected')
    if (registered === null) return readout('rejected', null, 'prediction-malformed', false)
    const observation = observes.find(item => item.data.predictionId === registered.predictionId)
    if (observation === undefined) return readout('rejected', null, 'prediction-observe-missing', false)
    const observed = fields(observation.data, 'observed')
    if (observed === null || observed.predictionId !== registered.predictionId) {
      return readout('rejected', null, 'prediction-malformed', false)
    }
    const sameTarget = observed.targetBallId === registered.targetBallId
      && observed.targetEpoch === registered.targetEpoch
      && observed.metric === registered.metric
    if (!sameTarget) return readout('rejected', null, 'prediction-binding-mismatch', false)
    const promotion = legacy.find(item =>
      item.intact
      && PROMOTIONS.has(item.kind)
      && item.seq > registration.seq
      && item.seq < observation.seq
      && item.data.ballId === registered.targetBallId
      && item.data.epoch === registered.targetEpoch)
    if (promotion === undefined) return readout('rejected', null, 'prediction-order', false)
    if ('surpriseScore' in observation.data || 'surpriseScore' in registration.data) {
      return readout('rejected', null, 'prediction-score-untrusted', false)
    }
    const score = surpriseScore(registered.amount, observed.amount)
    if (score === null) return readout('rejected', null, 'prediction-malformed', false)
    return readout('verified', score, 'prediction-verified', false)
  }
  return readout('rejected', null, 'prediction-incomplete', false)
}

function judgeVerified(receipts: readonly VerifiedReceipt[]): PredictionReadout {
  const rows = receipts.filter(item => item.kind === REGISTER || item.kind === OBSERVE)
  if (rows.length === 0) return readout('absent', null, 'prediction-schema-absent', true)
  const registers = rows.filter(item => item.kind === REGISTER)
  const observes = rows.filter(item => item.kind === OBSERVE)
  if (registers.length === 0 || observes.length === 0) return readout('rejected', null, 'prediction-incomplete', true)
  for (const registration of registers) {
    const registered = fields(registration.data, 'expected')
    if (registered === null) return readout('rejected', null, 'prediction-malformed', true)
    const observation = observes.find(item => item.data.predictionId === registered.predictionId)
    if (observation === undefined) return readout('rejected', null, 'prediction-observe-missing', true)
    const observed = fields(observation.data, 'observed')
    if (observed === null || observed.predictionId !== registered.predictionId) {
      return readout('rejected', null, 'prediction-malformed', true)
    }
    const sameTarget = observed.targetBallId === registered.targetBallId
      && observed.targetEpoch === registered.targetEpoch
      && observed.metric === registered.metric
    if (!sameTarget) return readout('rejected', null, 'prediction-binding-mismatch', true)
    const promotion = receipts.find(item =>
      PROMOTIONS.has(item.kind)
      && item.seq > registration.seq
      && item.seq < observation.seq
      && item.data.ballId === registered.targetBallId
      && item.data.epoch === registered.targetEpoch)
    if (promotion === undefined) return readout('rejected', null, 'prediction-order', true)
    if ('surpriseScore' in observation.data || 'surpriseScore' in registration.data) {
      return readout('rejected', null, 'prediction-score-untrusted', true)
    }
    const score = surpriseScore(registered.amount, observed.amount)
    if (score === null) return readout('rejected', null, 'prediction-malformed', true)
    return readout('verified', score, 'prediction-verified', true)
  }
  return readout('rejected', null, 'prediction-incomplete', true)
}

function readout(
  status: PredictionReadout['status'],
  surpriseScore: number | null,
  reason: string,
  leafRecomputed: boolean,
): PredictionReadout {
  return { status, surpriseScore, reason, leafRecomputed }
}

function hasLeafHash(row: unknown): boolean {
  return isRecord(row) && typeof row.leafHash === 'string'
}

function isLegacyReceipt(row: unknown): row is PredictionReceipt {
  return isRecord(row)
    && typeof row.seq === 'number'
    && typeof row.kind === 'string'
    && typeof row.intact === 'boolean'
    && isRecord(row.data)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fields(data: Readonly<Record<string, unknown>>, amountKey: 'expected' | 'observed'): {
  predictionId: string
  targetBallId: string
  targetEpoch: number
  metric: string
  amount: number
} | null {
  const amount = data[amountKey]
  if (typeof data.predictionId !== 'string' || data.predictionId.length === 0 || data.predictionId.length > 200) return null
  if (typeof data.targetBallId !== 'string' || !HEX_64.test(data.targetBallId)) return null
  if (typeof data.targetEpoch !== 'number' || !Number.isSafeInteger(data.targetEpoch) || data.targetEpoch < 0 || Object.is(data.targetEpoch, -0)) return null
  if (typeof data.metric !== 'string' || data.metric.length === 0 || data.metric.length > 80) return null
  if (typeof amount !== 'number' || !Number.isFinite(amount) || Object.is(amount, -0)) return null
  return { predictionId: data.predictionId, targetBallId: data.targetBallId, targetEpoch: data.targetEpoch, metric: data.metric, amount }
}

/**
 * Equality is exactly 0. Any other finite pair is `|observed - predicted| / max(|predicted|, 1)`.
 * That ratio is not clamped to [1, 100]. A second scale would disagree with the readout.
 * @param predicted - Register `expected`.
 * @param observed - Observe `observed`.
 * @returns The score, or null when an input is non-finite or `-0`.
 */
export function surpriseScore(predicted: number, observed: number): number | null {
  if (!Number.isFinite(predicted) || !Number.isFinite(observed)) return null
  if (Object.is(predicted, -0) || Object.is(observed, -0)) return null
  const delta = Math.abs(observed - predicted)
  if (delta === 0) return 0
  const score = delta / Math.max(Math.abs(predicted), 1)
  if (!Number.isFinite(score) || Object.is(score, -0)) return null
  return score
}

const CHAIN_CHECKS = [
  'leaf-sha256-0x00',
  'seq-strictly-increasing',
  'consecutive-prev-hash',
  'register-before-promotion-before-observe',
  'binding-id-target-metric',
  'surprise-recomputed',
] as const

/**
 * Export every register, promotion, and observation triple whose receipt leaves recompute.
 * Chain order is not evidence that the numbers were learned.
 * @param entries - Receipt rows. `intact` is ignored. Missing `schema`/`at`/`data` is insufficient.
 * @returns Deterministic records. `leafRecomputed` is true only when every leaf matched.
 */
export function projectDiscoveryCorpus(entries: readonly unknown[]): DiscoveryCorpusResult {
  const chain = verifyReceiptChain(entries)
  if (chain.status !== 'verified') return emptyCorpus(false, chain.status, false)
  const verified = chain.receipts
  const records: DiscoveryTrajectoryRecord[] = []
  const seen = new Set<string>()
  const registers = verified.filter(item => item.kind === 'prediction.register')
  for (const registration of registers) {
    const registered = fields(registration.data, 'expected')
    if (registered === null) continue
    const observation = verified.find(item =>
      item.kind === 'prediction.observe' && item.seq > registration.seq && item.data.predictionId === registered.predictionId)
    if (observation === undefined) continue
    const observed = fields(observation.data, 'observed')
    if (observed === null) continue
    const sameTarget = observed.targetBallId === registered.targetBallId
      && observed.targetEpoch === registered.targetEpoch
      && observed.metric === registered.metric
    if (!sameTarget) continue
    const promotion = verified.find(item =>
      PROMOTIONS.has(item.kind)
      && item.seq > registration.seq
      && item.seq < observation.seq
      && item.data.ballId === registered.targetBallId
      && item.data.epoch === registered.targetEpoch)
    if (promotion === undefined) continue
    const epochAfter = registered.targetEpoch
    const epochBefore = epochBeforePromotion(verified, promotion, epochAfter)
    if (epochBefore === null) continue
    const score = surpriseScore(registered.amount, observed.amount)
    if (score === null) continue
    if ('surpriseScore' in observation.data || 'surpriseScore' in registration.data) continue
    const record: DiscoveryTrajectoryRecord = {
      trajectoryId: `${registration.leafHash}:${promotion.leafHash}:${observation.leafHash}`,
      pearlId: registered.targetBallId,
      epochBefore,
      epochAfter,
      predicted: registered.amount,
      observed: observed.amount,
      surpriseScore: score,
      registerReceiptHash: registration.leafHash,
      promotionReceiptHash: promotion.leafHash,
      observeReceiptHash: observation.leafHash,
      exceptionRuleCandidate: score > 0,
    }
    if (seen.has(record.trajectoryId)) continue
    seen.add(record.trajectoryId)
    records.push(record)
  }
  records.sort((left, right) => left.trajectoryId < right.trajectoryId ? -1 : left.trajectoryId > right.trajectoryId ? 1 : 0)
  return {
    records,
    summary: summarize(records),
    chainIntact: true,
    leafRecomputed: true,
    chainStatus: 'verified',
    checks: CHAIN_CHECKS,
  }
}

/**
 * One JSON object per trajectory, keys in corpus order, newline terminated.
 * @param corpus - Result of {@link projectDiscoveryCorpus}.
 * @returns JSONL text. An empty record list is an empty string.
 */
export function discoveryJsonl(corpus: DiscoveryCorpusResult): string {
  return corpus.records.map(record => JSON.stringify({
    trajectoryId: record.trajectoryId,
    pearlId: record.pearlId,
    epochBefore: record.epochBefore,
    epochAfter: record.epochAfter,
    predicted: record.predicted,
    observed: record.observed,
    surpriseScore: record.surpriseScore,
    registerReceiptHash: record.registerReceiptHash,
    promotionReceiptHash: record.promotionReceiptHash,
    observeReceiptHash: record.observeReceiptHash,
    exceptionRuleCandidate: record.exceptionRuleCandidate,
  })).join('\n') + (corpus.records.length === 0 ? '' : '\n')
}

function emptyCorpus(
  chainIntact: boolean,
  chainStatus: DiscoveryCorpusResult['chainStatus'],
  leafRecomputed: boolean,
): DiscoveryCorpusResult {
  return {
    records: [],
    summary: { totalTrajectories: 0, zeroSurpriseCount: 0, surpriseCount: 0, meanSurpriseScore: null },
    chainIntact,
    leafRecomputed,
    chainStatus,
    checks: CHAIN_CHECKS,
  }
}

function summarize(records: readonly DiscoveryTrajectoryRecord[]): DiscoveryTrajectoryCorpus['summary'] {
  const totalTrajectories = records.length
  const zeroSurpriseCount = records.filter(record => record.surpriseScore === 0).length
  const surpriseCount = records.filter(record => record.surpriseScore > 0).length
  if (totalTrajectories === 0) return { totalTrajectories, zeroSurpriseCount, surpriseCount, meanSurpriseScore: null }
  const sum = records.reduce((total, record) => total + record.surpriseScore, 0)
  const mean = sum / totalTrajectories
  return {
    totalTrajectories,
    zeroSurpriseCount,
    surpriseCount,
    meanSurpriseScore: Number.isFinite(mean) && !Object.is(mean, -0) ? mean : null,
  }
}

function epochBeforePromotion(entries: readonly VerifiedReceipt[], promotion: VerifiedReceipt, epochAfter: number): number | null {
  const parent = promotion.data.parentBallId
  if (typeof parent !== 'string') return null
  let epoch: number | null = null
  for (const item of entries) {
    if (item.seq >= promotion.seq || item.data.ballId !== parent) continue
    if (typeof item.data.epoch !== 'number' || !Number.isSafeInteger(item.data.epoch) || Object.is(item.data.epoch, -0)) continue
    epoch = item.data.epoch
  }
  if (epoch === null || epoch >= epochAfter) return null
  return epoch
}
