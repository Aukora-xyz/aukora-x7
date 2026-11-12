/** Deterministic, non-authoritative attention scoring shared by every runtime. */

const SCHEMA = 'aukora.aura.v1';

/** Fixed admission limits shared by aura scoring and runtime input adapters. */
export const AURA_INPUT_LIMITS = Object.freeze({ surpriseScores: 10_000 });

/** A running assignment whose newest pulse is older than this is stale (seed-superagent check_heartbeats, web authority.ts). */
export const STALE_HEARTBEAT_MS = 120_000;
/** A pulse further ahead than this is unknown, not fresh (web contract.ts STATUS_FUTURE_SKEW_MS). */
const HEARTBEAT_FUTURE_SKEW_MS = 300_000;

const BALL_ID = /^[a-fA-F0-9]{64}$/;
const AXES = ['coherence', 'surprisePressure', 'driftRisk', 'wakeUrgency'];
const OUTPUT_FIELDS = ['schema', 'computedAt', 'ballId', 'epoch', 'scorer', 'authorityTier', 'vector', 'salience', 'recommendedFocus'];
const COUNT_FIELDS = ['reachableDagNodes', 'declaredDagNodes', 'verifiedReceipts', 'totalReceipts', 'activeOrgans', 'declaredOrgans', 'unanchoredPredictions', 'pendingWakes', 'lastRollbackAgeEpochs'];
const SIGNAL_FIELDS = [...COUNT_FIELDS, 'observedSurpriseScores', 'handOffEpochMismatch', 'staleHeartbeatRatio'];
const KINDS = ['high-surprise', 'dag-orphan', 'handoff-drift', 'stale-ticket', 'unanchored-claim', 'clean-state'];
const CODES = {
  'high-surprise': ['recent-surprise'],
  'dag-orphan': ['unreachable-dag'],
  'handoff-drift': ['epoch-mismatch', 'invalid-signals'],
  'stale-ticket': ['stale-heartbeat', 'pending-wakes', 'recent-rollback', 'inactive-organs'],
  'unanchored-claim': ['unanchored-predictions', 'unverified-receipts'],
  'clean-state': ['all-signals-clear'],
};

function isRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function hasExactFields(value, fields) {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
  });
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function isNonnegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && !Object.is(value, -0);
}

function isUnit(value) {
  return isNonnegativeFinite(value) && value <= 1;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function recommendedFocus(vector) {
  if (vector.wakeUrgency >= 0.7) return 'escalate-to-owner';
  if (vector.driftRisk >= 0.4) return 'verify';
  if (vector.surprisePressure >= 0.3) return 'observe';
  if (vector.coherence < 0.95) return 'consolidate';
  return 'rest';
}

// Equal scores follow KINDS order, then the code order above, then targetId.
function compareSalience(left, right) {
  return right.score - left.score
    || KINDS.indexOf(left.kind) - KINDS.indexOf(right.kind)
    || CODES[left.kind].indexOf(left.code) - CODES[right.kind].indexOf(right.code)
    || (left.targetId < right.targetId ? -1 : left.targetId > right.targetId ? 1 : 0);
}

function readSignals(inputs) {
  const signals = {};
  for (const key of SIGNAL_FIELDS) signals[key] = ownValue(inputs, key);
  if (!COUNT_FIELDS.every((key) => isCount(signals[key]))
    || signals.declaredDagNodes === 0 || signals.totalReceipts === 0 || signals.declaredOrgans === 0
    || signals.reachableDagNodes > signals.declaredDagNodes
    || signals.verifiedReceipts > signals.totalReceipts
    || signals.activeOrgans > signals.declaredOrgans
    || typeof signals.handOffEpochMismatch !== 'boolean'
    || !isNonnegativeFinite(signals.staleHeartbeatRatio)
    || !Array.isArray(signals.observedSurpriseScores)) return null;

  const scores = signals.observedSurpriseScores;
  const scoreCount = ownValue(scores, 'length');
  if (!isCount(scoreCount) || scoreCount > AURA_INPUT_LIMITS.surpriseScores) return null;
  const recentScores = [];
  for (let index = 0; index < scoreCount; index += 1) {
    const score = ownValue(scores, String(index));
    if (!isNonnegativeFinite(score)) return null;
    if (index >= scoreCount - 5) recentScores.push(score);
  }
  signals.observedSurpriseScores = recentScores;
  return signals;
}

function scoreSignals(signals) {
  // Missing anchors reduce evidence coherence, not measured forecast accuracy.
  const anchorCoherence = 1 / (1 + 0.2 * signals.unanchoredPredictions);
  const coherence = clamp01(
    (signals.reachableDagNodes / signals.declaredDagNodes)
    * (signals.verifiedReceipts / signals.totalReceipts)
    * (signals.activeOrgans / signals.declaredOrgans)
    * anchorCoherence,
  );
  // The incremental mean avoids overflowing a sum of finite surprise scores.
  let mean = 0;
  signals.observedSurpriseScores.forEach((score, index) => {
    mean += (score - mean) / (index + 1);
  });
  const surprisePressure = clamp01(Math.tanh(mean / 25));
  const driftRisk = clamp01(
    (signals.handOffEpochMismatch ? 0.4 : 0)
    + (signals.unanchoredPredictions > 0 ? 0.4 : 0)
    + (signals.pendingWakes >= 2 ? 0.2 : 0)
    + (signals.lastRollbackAgeEpochs < 3 ? 0.1 : 0),
  );
  return {
    coherence,
    surprisePressure,
    driftRisk,
    wakeUrgency: clamp01(Math.max(surprisePressure, driftRisk, signals.staleHeartbeatRatio)),
  };
}

function rankSalience(signals, vector, targetId) {
  const candidates = [];
  function add(kind, score, code) {
    if (score > 0) candidates.push({ kind, targetId, score: clamp01(score), code });
  }
  add('high-surprise', vector.surprisePressure, 'recent-surprise');
  add('dag-orphan', 1 - signals.reachableDagNodes / Math.max(signals.declaredDagNodes, 1), 'unreachable-dag');
  add('handoff-drift', signals.handOffEpochMismatch ? 0.4 : 0, 'epoch-mismatch');
  add('stale-ticket', signals.staleHeartbeatRatio, 'stale-heartbeat');
  add('stale-ticket', signals.pendingWakes >= 2 ? 0.2 : 0, 'pending-wakes');
  add('stale-ticket', signals.lastRollbackAgeEpochs < 3 ? 0.1 : 0, 'recent-rollback');
  add('stale-ticket', 1 - signals.activeOrgans / Math.max(signals.declaredOrgans, 1), 'inactive-organs');
  add('unanchored-claim', signals.unanchoredPredictions > 0 ? 0.4 : 0, 'unanchored-predictions');
  add('unanchored-claim', 1 - signals.verifiedReceipts / Math.max(signals.totalReceipts, 1), 'unverified-receipts');
  if (candidates.length === 0) add('clean-state', 1, 'all-signals-clear');
  candidates.sort(compareSalience);
  const selected = [];
  for (const candidate of candidates) {
    if (!selected.some((item) => item.kind === candidate.kind)) selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected;
}

function pulseTime(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : null;
  if (typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return null;
}

/**
 * The single staleHeartbeatRatio definition: stale running SuperAgent assignments / max(running, 1).
 * A pulse is heartbeatAt, else (last(reports).at ?? reportedAt), else startedAt; a present but invalid field
 * does not fall through to an older one. Wake-schedule lateness is not a heartbeat and is not scored here
 * (pendingWakes counts fired-but-unacknowledged alarms plus a pending probe, not lateness).
 * @param {unknown} assignments The `assignments` array of home/auma/superagent/state.json.
 * @param {number} now Reader clock in milliseconds.
 * @param {number} [staleAfterMs] Pulse age strictly above which an assignment is stale.
 * @returns {{staleHeartbeatRatio: number, staleTickets: number} | null} Null when any running pulse is missing, invalid or in the future.
 */
export function staleHeartbeatFacts(assignments, now, staleAfterMs = STALE_HEARTBEAT_MS) {
  if (!Array.isArray(assignments) || !isNonnegativeFinite(now) || !isNonnegativeFinite(staleAfterMs)) return null;
  let running = 0;
  let stale = 0;
  const tickets = new Set();
  for (const assignment of assignments) {
    if (!isRecord(assignment)) return null;
    if (assignment.state !== 'running') continue;
    running += 1;
    const reports = Array.isArray(assignment.reports) ? assignment.reports : [];
    const last = reports.length > 0 ? reports[reports.length - 1] : undefined;
    let at;
    for (const field of [assignment.heartbeatAt, (isRecord(last) ? last.at : undefined) ?? assignment.reportedAt, assignment.startedAt]) {
      at = pulseTime(field);
      if (at !== undefined) break;
    }
    if (typeof at !== 'number' || now - at < -HEARTBEAT_FUTURE_SKEW_MS) return null;
    if (now - at > staleAfterMs) {
      stale += 1;
      tickets.add(assignment.ticketId);
    }
  }
  return { staleHeartbeatRatio: stale / Math.max(running, 1), staleTickets: tickets.size };
}

/**
 * The single overdue-wake definition: how late an ENABLED wake schedule is, as a fraction of its interval.
 * Disabled (or auto-paused) scores 0. An enabled schedule whose alarm is missing (`scheduleStatus: 'alarm_missing'`,
 * Cloudflare HEAD DO) scores 1. Otherwise (now - nextWakeAt) / intervalMs, clamped to [0, 1]: a full interval late is 1.
 * Readers fold it into staleHeartbeatRatio with Math.max (both are "a pulse she owes and has not given"), so rules-v1
 * scoring and its input contract are unchanged.
 * @param {unknown} wake Wake metadata (`/_host/wake` view): enabled, intervalMs, nextWakeAt, optional scheduleStatus.
 * @param {number} now Reader clock in milliseconds.
 * @returns {number | null} Null when an enabled schedule's interval or next wake time is not a finite number.
 */
export function overdueWakeRatio(wake, now) {
  if (!isRecord(wake) || typeof wake.enabled !== 'boolean' || !isNonnegativeFinite(now)) return null;
  if (!wake.enabled) return 0;
  if (wake.scheduleStatus === 'alarm_missing') return 1;
  if (!isNonnegativeFinite(wake.intervalMs) || wake.intervalMs <= 0 || !isNonnegativeFinite(wake.nextWakeAt)) return null;
  return clamp01((now - wake.nextWakeAt) / wake.intervalMs);
}

/**
 * Check whether all scoring signals are usable, including positive coherence denominators.
 * @param {unknown} inputs Named observed signal metrics, without requiring head metadata.
 * @returns {boolean} False for absent, corrupt, or zero-denominator evidence.
 */
export function auraInputsComplete(inputs) {
  try {
    return isRecord(inputs) && readSignals(inputs) !== null;
  } catch (error) {
    // Unreadable evidence is incomplete, never a healthy zero.
    return false;
  }
}

/**
 * Canonical forecast calibration error, separate from task accomplishment and legacy penalties.
 * @param {number} expected Receipt-registered expectation.
 * @param {number} observed Receipt-observed value.
 * @returns {number | null} abs(observed - expected) / max(abs(expected), 1), or null for invalid values.
 */
export function predictionError(expected, observed) {
  if (!Number.isFinite(expected) || !Number.isFinite(observed)
    || Object.is(expected, -0) || Object.is(observed, -0)) return null;
  const error = Math.abs(observed - expected) / Math.max(Math.abs(expected), 1);
  return Number.isFinite(error) ? error : null;
}

/**
 * Compute an aura from caller-verified metadata and observed signal metrics.
 * Metadata must be supplied; invalid metadata throws rather than inventing a head or time.
 * Counts and rollback age are nonnegative safe integers; surprise scores and heartbeat
 * ratio are finite nonnegative numbers. Every numeric input rejects negative zero.
 * Reachable nodes, verified receipts, and active organs cannot exceed their respective
 * totals. Surprise arrays admit at most 10,000
 * entries, of which only the last five are scored. All signal fields are required, including an
 * empty array when there are no observed predictions. Missing/corrupt signals and zero
 * DAG, receipt, or organ denominators throw with code AURA_INPUTS_INCOMPLETE. Adapters use
 * auraInputsComplete to keep unavailable evidence unscored. Supplied vector, scorer, authority, and salience are ignored.
 * Unanchored predictions multiply evidence coherence by 1 / (1 + 0.2 * count) and add
 * 0.4 drift risk, requiring verification unless higher urgency requires escalation.
 * They do not change observed prediction error or surprise pressure.
 * Salience uses the ballId as targetId because no finer identifiers are input fields.
 * @param {object} inputs Caller metadata and the named observed signal metrics.
 * @returns {object} A fresh aukora.aura.v1 peripheral-hint record with no side effects.
 */
export function computeAura(inputs) {
  if (!isRecord(inputs)) throw new TypeError('Aura inputs must be a plain object');
  const computedAt = ownValue(inputs, 'computedAt');
  const ballId = ownValue(inputs, 'ballId');
  const epoch = ownValue(inputs, 'epoch');
  if (!isCount(computedAt) || typeof ballId !== 'string' || !BALL_ID.test(ballId) || !isCount(epoch)) {
    throw new TypeError('Aura requires an integer timestamp, 64-hex ballId, and nonnegative integer epoch');
  }
  let signals;
  try {
    signals = readSignals(inputs);
  } catch (error) {
    // Unreadable input properties are corrupt signals, not evidence of healthy state.
    signals = null;
  }
  if (!signals) throw Object.assign(new TypeError('Aura inputs are incomplete or invalid'), { code: 'AURA_INPUTS_INCOMPLETE' });
  const vector = scoreSignals(signals);
  return {
    schema: SCHEMA,
    computedAt,
    ballId,
    epoch,
    scorer: 'rules-v1',
    authorityTier: 'peripheral-hint',
    vector,
    salience: rankSalience(signals, vector, ballId),
    recommendedFocus: recommendedFocus(vector),
  };
}

function validateRecord(value) {
  if (!hasExactFields(value, OUTPUT_FIELDS)
    || value.schema !== SCHEMA
    || !isCount(value.computedAt)
    || typeof value.ballId !== 'string' || !BALL_ID.test(value.ballId)
    || !isCount(value.epoch)
    || value.scorer !== 'rules-v1'
    || value.authorityTier !== 'peripheral-hint'
    || !hasExactFields(value.vector, AXES)
    || !AXES.every((axis) => isUnit(value.vector[axis]))
    || value.vector.wakeUrgency < Math.max(value.vector.surprisePressure, value.vector.driftRisk)
    || !Array.isArray(value.salience)
    || value.salience.length > 3
    || Reflect.ownKeys(value.salience).length !== value.salience.length + 1) return false;

  const kinds = new Set();
  for (let index = 0; index < value.salience.length; index += 1) {
    const item = ownValue(value.salience, String(index));
    if (!hasExactFields(item, ['kind', 'targetId', 'score', 'code'])
      || !KINDS.includes(item.kind) || kinds.has(item.kind)
      || item.targetId !== value.ballId
      || !isUnit(item.score)
      || !CODES[item.kind].includes(item.code)
      || (index > 0 && compareSalience(value.salience[index - 1], item) > 0)) return false;
    kinds.add(item.kind);
  }
  const invalid = value.salience.some((item) => item.code === 'invalid-signals');
  if (invalid) {
    return value.salience.length === 1 && value.salience[0].score === 1
      && value.vector.coherence === 0 && value.vector.surprisePressure === 1
      && value.vector.driftRisk === 1 && value.vector.wakeUrgency === 1
      && value.recommendedFocus === 'verify';
  }
  return value.recommendedFocus === recommendedFocus(value.vector);
}

/**
 * Validate the complete aura record, not an isolated four-axis vector. Unknown fields,
 * accessors, negative zero, authority upgrades, prose codes, unsorted items, and invalid routing fail.
 * @param {unknown} value A candidate aukora.aura.v1 record.
 * @returns {boolean} Whether the record satisfies the rules-v1 output schema.
 */
export function validateAuraVector(value) {
  try {
    return validateRecord(value);
  } catch (error) {
    // Malformed objects, including unreadable proxy properties, are rejected.
    return false;
  }
}
