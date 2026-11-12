/** Read-only rational focus diagnostics; no runtime action consumes this result. */
import { AURA_INPUT_LIMITS, auraInputsComplete, validateAuraVector } from '../../../server/aura-rules.mjs';

const SCHEMA = 'aukora.aura-focus-shadow.v1';
const PROFILE_ID = 'rules-v1-focus/exact-binary64-inputs-v1';
const COUNT_FIELDS = ['reachableDagNodes', 'declaredDagNodes', 'verifiedReceipts', 'totalReceipts',
  'activeOrgans', 'declaredOrgans', 'unanchoredPredictions', 'pendingWakes', 'lastRollbackAgeEpochs'];
const SERIES_TERMS = 64;
const SERIES_SCALE = 1n << 96n;
const GUARD_DENOMINATOR = 1n << 40n;

function frozen(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function gcd(left, right) {
  while (right !== 0n) [left, right] = [right, left % right];
  return left < 0n ? -left : left;
}

function ratio(numerator, denominator = 1n) {
  const divisor = gcd(numerator, denominator);
  return { n: numerator / divisor, d: denominator / divisor };
}

function add(left, right) {
  return ratio(left.n * right.d + right.n * left.d, left.d * right.d);
}

function compare(left, right) {
  const delta = left.n * right.d - right.n * left.d;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

function wire(value) {
  return { numerator: value.n.toString(), denominator: value.d.toString() };
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

// atanh(x) = sum x^(2k+1)/(2k+1), with the omitted positive tail bounded by
// x^(2N+1)/((2N+1)(1-x*x)). Every retained term is rounded outwards on a fixed grid.
function surpriseThreshold(numerator) {
  let powerNumerator = numerator, powerDenominator = 10n;
  let lower = 0n, upper = 0n;
  for (let index = 0; index < SERIES_TERMS; index += 1) {
    const termNumerator = 25n * powerNumerator * SERIES_SCALE;
    const termDenominator = BigInt(2 * index + 1) * powerDenominator;
    lower += termNumerator / termDenominator;
    upper += ceilDiv(termNumerator, termDenominator);
    powerNumerator *= numerator * numerator;
    powerDenominator *= 100n;
  }
  const tail = ratio(25n * powerNumerator * 100n,
    powerDenominator * BigInt(2 * SERIES_TERMS + 1) * (100n - numerator * numerator));
  upper += ceilDiv(tail.n * SERIES_SCALE, tail.d);
  return { lower: ratio(lower, SERIES_SCALE), upper: ratio(upper, SERIES_SCALE), tail,
    argument: ratio(numerator, 10n) };
}

const OBSERVE = surpriseThreshold(3n);
const ESCALATE = surpriseThreshold(7n);
const UNIT_GUARD = ratio(1n, GUARD_DENOMINATOR);
const MEAN_GUARD = ratio(25n, GUARD_DENOMINATOR);
const HEARTBEAT_THRESHOLD = ratio(7n, 10n);
const COHERENCE_THRESHOLD = ratio(19n, 20n);

function thresholdCertificate(threshold) {
  return { lower: wire(threshold.lower), upper: wire(threshold.upper), argument: wire(threshold.argument),
    scale: 25, terms: SERIES_TERMS, seriesRoundingDenominator: SERIES_SCALE.toString(),
    omittedTailUpper: wire(threshold.tail) };
}

/** The immutable arithmetic and abstention policy, including replayable threshold enclosures. */
export const AURA_FOCUS_SHADOW_PROFILE = frozen({
  id: PROFILE_ID,
  arithmetic: 'exact rational values of admitted binary64 inputs',
  mean: 'exact arithmetic mean of the last five validated scores, or zero for an empty list',
  comparisonScope: 'declared mathematical profile versus caller-supplied rules-v1 output',
  freshness: 'snapshot time and identity supplied by the caller; no independent clock check',
  boundaryGuard: { normalized: wire(UNIT_GUARD), surpriseMean: wire(MEAN_GUARD),
    scope: 'declared abstention policy, not a universal rounding-error bound for JavaScript or Math.tanh' },
  thresholds: { heartbeat: wire(HEARTBEAT_THRESHOLD), coherence: wire(COHERENCE_THRESHOLD),
    observeMean: thresholdCertificate(OBSERVE), escalateMean: thresholdCertificate(ESCALATE) },
  limits: { validatedSurpriseScores: AURA_INPUT_LIMITS.surpriseScores, scoredSurpriseScores: 5,
    binary64ExponentBits: 11, thresholdSeriesTerms: SERIES_TERMS },
});

function ownValue(value, key) {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && Object.hasOwn(property, 'value') ? property.value : undefined;
}

function isRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function capture(inputs) {
  if (!isRecord(inputs)) return { error: 'AURA_INPUTS_INCOMPLETE' };
  const metadata = { ballId: ownValue(inputs, 'ballId'), epoch: ownValue(inputs, 'epoch'),
    computedAt: ownValue(inputs, 'computedAt') };
  if (typeof metadata.ballId !== 'string' || !/^[a-fA-F0-9]{64}$/.test(metadata.ballId)
    || !isCount(metadata.epoch) || !isCount(metadata.computedAt)) return { error: 'AURA_METADATA_INVALID' };
  const signals = {};
  for (const field of [...COUNT_FIELDS, 'handOffEpochMismatch', 'staleHeartbeatRatio']) signals[field] = ownValue(inputs, field);
  const scores = ownValue(inputs, 'observedSurpriseScores');
  if (!Array.isArray(scores)) return { metadata, error: 'AURA_INPUTS_INCOMPLETE' };
  const length = ownValue(scores, 'length');
  if (!isCount(length) || length > AURA_INPUT_LIMITS.surpriseScores) return { metadata, error: 'AURA_INPUTS_INCOMPLETE' };
  signals.observedSurpriseScores = Array.from({ length }, (_, index) => ownValue(scores, String(index)));
  if (!auraInputsComplete(signals)) return { metadata, error: 'AURA_INPUTS_INCOMPLETE' };
  return { metadata, signals };
}

function binary64(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const exponentBits = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  const significand = exponentBits === 0 ? fraction : fraction + (1n << 52n);
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1075;
  const exact = exponent < 0 ? ratio(significand, 1n << BigInt(-exponent))
    : ratio(significand << BigInt(exponent));
  return { exact, hex: bits.toString(16).padStart(16, '0') };
}

function against(value, lower, upper, guard) {
  const guardedLower = add(lower, { n: -guard.n, d: guard.d });
  const guardedUpper = add(upper, guard);
  return compare(value, guardedLower) < 0 ? 'below'
    : compare(value, guardedUpper) > 0 ? 'above' : 'boundary';
}

function arithmetic(signals) {
  const recent = signals.observedSurpriseScores.slice(-5).map(binary64);
  const sum = recent.reduce((value, score) => add(value, score.exact), ratio(0n));
  const mean = ratio(sum.n, sum.d * BigInt(recent.length || 1));
  const heartbeat = binary64(signals.staleHeartbeatRatio);
  const coherence = ratio(5n * BigInt(signals.reachableDagNodes) * BigInt(signals.verifiedReceipts) * BigInt(signals.activeOrgans),
    BigInt(signals.declaredDagNodes) * BigInt(signals.totalReceipts) * BigInt(signals.declaredOrgans)
    * (5n + BigInt(signals.unanchoredPredictions)));
  const drift = (signals.handOffEpochMismatch ? 4 : 0) + (signals.unanchoredPredictions > 0 ? 4 : 0)
    + (signals.pendingWakes >= 2 ? 2 : 0) + (signals.lastRollbackAgeEpochs < 3 ? 1 : 0);
  const checks = { driftTenths: drift > 10 ? 10 : drift,
    heartbeat: against(heartbeat.exact, HEARTBEAT_THRESHOLD, HEARTBEAT_THRESHOLD, UNIT_GUARD),
    surpriseEscalation: against(mean, ESCALATE.lower, ESCALATE.upper, MEAN_GUARD),
    surpriseObservation: against(mean, OBSERVE.lower, OBSERVE.upper, MEAN_GUARD),
    coherence: against(coherence, COHERENCE_THRESHOLD, COHERENCE_THRESHOLD, UNIT_GUARD) };
  return { checks, inputEvidence: {
    counts: Object.fromEntries(COUNT_FIELDS.map(field => [field, signals[field]])),
    handOffEpochMismatch: signals.handOffEpochMismatch,
    surpriseScoresValidated: signals.observedSurpriseScores.length,
    recentSurpriseBinary64: recent.map(score => score.hex),
    staleHeartbeatBinary64: heartbeat.hex,
    exact: { surpriseMean: wire(mean), coherence: wire(coherence), staleHeartbeat: wire(heartbeat.exact) },
  } };
}

function decision(checks, signals) {
  if (checks.driftTenths >= 7) return { focus: 'escalate-to-owner', reason: 'drift-escalation' };
  if (checks.heartbeat === 'above') return { focus: 'escalate-to-owner', reason: 'heartbeat-escalation' };
  if (checks.surpriseEscalation === 'above') return { focus: 'escalate-to-owner', reason: 'surprise-escalation' };
  if (checks.heartbeat === 'boundary' || checks.surpriseEscalation === 'boundary') {
    return { focus: null, reason: 'escalation-boundary' };
  }
  if (checks.driftTenths >= 4) return { focus: 'verify', reason: signals.unanchoredPredictions > 0 ? 'unanchored-predictions' : 'handoff-mismatch' };
  if (checks.surpriseObservation === 'above') return { focus: 'observe', reason: 'surprise-observation' };
  if (checks.surpriseObservation === 'boundary') return { focus: null, reason: 'observation-boundary' };
  if (checks.coherence === 'boundary') return { focus: null, reason: 'coherence-boundary' };
  if (checks.coherence === 'below') return { focus: 'consolidate', reason: 'coherence-deficit' };
  return { focus: 'rest', reason: 'below-focus-thresholds' };
}

function comparison(baseline, metadata, focus) {
  if (baseline === undefined) return { status: 'not-supplied', focus: null };
  try {
    if (!validateAuraVector(baseline)) return { status: 'invalid-baseline', focus: null };
    if (baseline.ballId !== metadata.ballId || baseline.epoch !== metadata.epoch || baseline.computedAt !== metadata.computedAt) {
      return { status: 'stale-or-different-baseline', focus: null };
    }
    const baselineFocus = baseline.recommendedFocus;
    if (!['rest', 'consolidate', 'observe', 'verify', 'escalate-to-owner'].includes(baselineFocus)) {
      return { status: 'invalid-baseline', focus: null };
    }
    return { status: focus === null ? 'undecided' : focus === baselineFocus ? 'agrees' : 'profile-divergence',
      focus: baselineFocus };
  } catch (error) {
    // An unreadable comparison cannot invalidate the independently computed decision.
    return { status: 'invalid-baseline', focus: null };
  }
}

function incomplete(metadata, reason) {
  return frozen({ schema: SCHEMA, profile: AURA_FOCUS_SHADOW_PROFILE, authorityTier: 'peripheral-hint',
    role: 'diagnostic-only', status: 'incomplete', ballId: metadata?.ballId ?? null,
    epoch: metadata?.epoch ?? null, computedAt: metadata?.computedAt ?? null,
    focus: null, reason, checks: null, inputEvidence: null,
    baselineComparison: { status: 'not-compared', focus: null } });
}

/**
 * Evaluate a bounded mathematical focus profile independently of the supplied float baseline.
 * Exact rational arithmetic interprets each admitted binary64 input as its represented value.
 * Certified positive-series bounds enclose the two surprise thresholds. A fixed abstention band
 * marks numerical boundary cases; that band does not prove all JavaScript engines' rounding error.
 * Baseline agreement describes a supplied result, not correct evidence, live health or permission.
 * This function does not read a clock, prove freshness, mutate state, or replace rules-v1 routing.
 * @param {unknown} inputs Caller-verified snapshot metadata and the complete rules-v1 signal set.
 * @param {unknown} [baseline] Freshly computed rules-v1 record for comparison only.
 * @returns {object} Immutable JSON-serializable focus diagnostic, exact input certificate, or explicit unknown result.
 */
export function computeAuraFocusShadow(inputs, baseline) {
  let snapshot;
  try {
    snapshot = capture(inputs);
  } catch (error) {
    // Unreadable objects do not supply a usable snapshot.
    return incomplete(null, 'AURA_INPUTS_UNREADABLE');
  }
  if (snapshot.error) return incomplete(snapshot.metadata, snapshot.error);
  const { metadata, signals } = snapshot;
  const { checks, inputEvidence } = arithmetic(signals);
  const result = decision(checks, signals);
  return frozen({ schema: SCHEMA, profile: AURA_FOCUS_SHADOW_PROFILE, authorityTier: 'peripheral-hint',
    role: 'diagnostic-only', status: result.focus === null ? 'uncertain' : 'complete', ...metadata,
    ...result, checks, inputEvidence, baselineComparison: comparison(baseline, metadata, result.focus) });
}
