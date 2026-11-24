import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { computeAura, validateAuraVector } from './aura-rules.mjs';
import { AURA_FOCUS_SHADOW_PROFILE, computeAuraFocusShadow } from '../deploy/cloudflare/src/aura-focus-shadow.mjs';

const HEAD = 'a'.repeat(64);
const signals = overrides => ({ ballId: HEAD, epoch: 7, computedAt: 1_794_398_400_000,
  reachableDagNodes: 10, declaredDagNodes: 10, verifiedReceipts: 10, totalReceipts: 10,
  activeOrgans: 10, declaredOrgans: 10, unanchoredPredictions: 0, pendingWakes: 0,
  lastRollbackAgeEpochs: 20, observedSurpriseScores: [], handOffEpochMismatch: false,
  staleHeartbeatRatio: 0, ...overrides });
const evaluate = overrides => {
  const input = signals(overrides);
  return computeAuraFocusShadow(input, computeAura(input));
};

function rationalCompare(left, right) {
  const difference = BigInt(left.numerator) * BigInt(right.denominator) - BigInt(right.numerator) * BigInt(left.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function decimal(text) {
  const [integer, fraction = ''] = text.split('.');
  return { numerator: integer + fraction, denominator: (10n ** BigInt(fraction.length)).toString() };
}

test('focus shadow reports every supported recommendation without changing its inputs or baseline', () => {
  for (const [input, expected] of [
    [{}, 'rest'], [{ activeOrgans: 9 }, 'consolidate'], [{ observedSurpriseScores: [10] }, 'observe'],
    [{ handOffEpochMismatch: true }, 'verify'], [{ unanchoredPredictions: 1 }, 'verify'],
    [{ observedSurpriseScores: [25] }, 'escalate-to-owner'], [{ staleHeartbeatRatio: 0.8 }, 'escalate-to-owner'],
  ]) {
    const raw = signals(input), baseline = computeAura(raw), before = structuredClone({ raw, baseline });
    const result = computeAuraFocusShadow(raw, baseline);
    assert.equal(result.status, 'complete');
    assert.equal(result.focus, expected);
    assert.equal(result.baselineComparison.status, 'agrees');
    assert.equal(result.authorityTier, 'peripheral-hint');
    assert.equal(result.role, 'diagnostic-only');
    assert.deepEqual({ raw, baseline }, before);
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.equal(Object.isFrozen(result.inputEvidence.exact), true);
  }
});

test('all sixteen drift cases preserve priority, including exact seven tenths', () => {
  // Independently enumerated outputs: order is handoff, unanchored, pending-wakes, recent-rollback.
  const expected = ['rest', 'rest', 'rest', 'rest', 'verify', 'verify', 'verify', 'escalate-to-owner',
    'verify', 'verify', 'verify', 'escalate-to-owner', 'escalate-to-owner', 'escalate-to-owner', 'escalate-to-owner', 'escalate-to-owner'];
  for (let mask = 0; mask < 16; mask += 1) {
    const result = evaluate({ handOffEpochMismatch: Boolean(mask & 8), unanchoredPredictions: mask & 4 ? 1 : 0,
      pendingWakes: mask & 2 ? 2 : 0, lastRollbackAgeEpochs: mask & 1 ? 0 : 10 });
    assert.equal(result.focus, expected[mask], 'drift mask ' + mask);
    assert.equal(result.baselineComparison.status, 'agrees');
  }
  assert.equal(evaluate({ handOffEpochMismatch: true, pendingWakes: 2, lastRollbackAgeEpochs: 0 }).checks.driftTenths, 7);
});

test('certified thresholds contain independent high-precision decimal evaluations', () => {
  // Python Decimal with precision85, evaluated as 25/2*ln(13/7) and 25/2*ln(17/3).
  const references = {
    observeMean: '7.73799010507779288685168372652673593960229018972932409949',
    escalateMean: '21.68251319235132986067861726188251038675890568453744169453',
  };
  for (const [key, reference] of Object.entries(references)) {
    const bounds = AURA_FOCUS_SHADOW_PROFILE.thresholds[key];
    assert.equal(rationalCompare(bounds.lower, decimal(reference)), -1);
    assert.equal(rationalCompare(bounds.upper, decimal(reference)), 1);
    assert.equal(rationalCompare(bounds.omittedTailUpper, AURA_FOCUS_SHADOW_PROFILE.boundaryGuard.surpriseMean), -1);
    assert.equal(bounds.terms, 64);
  }
});

test('surprise boundaries abstain while separated means choose their respective sides', () => {
  for (const [threshold, below, above] of [
    [7.737990105077793, 'rest', 'observe'], [21.68251319235133, 'observe', 'escalate-to-owner'],
  ]) {
    const near = evaluate({ observedSurpriseScores: [threshold] });
    assert.equal(near.status, 'uncertain');
    assert.equal(near.focus, null);
    assert.equal(near.baselineComparison.status, 'undecided');
    assert.equal(evaluate({ observedSurpriseScores: [threshold - 1e-8] }).focus, below);
    assert.equal(evaluate({ observedSurpriseScores: [threshold + 1e-8] }).focus, above);
  }
});

test('binary64 heartbeat and coherence edge cases remain uncertainty rather than a baseline defect', () => {
  const heartbeat = evaluate({ staleHeartbeatRatio: 0.7 });
  assert.equal(heartbeat.status, 'uncertain');
  assert.equal(heartbeat.baselineComparison.focus, 'escalate-to-owner');
  assert.equal(heartbeat.inputEvidence.exact.staleHeartbeat.numerator, '3152519739159347');
  assert.equal(heartbeat.inputEvidence.exact.staleHeartbeat.denominator, '4503599627370496');
  const coherence = evaluate({ reachableDagNodes: 8556839292003941, declaredDagNodes: 9007199254740991 });
  assert.equal(coherence.status, 'uncertain');
  assert.equal(coherence.reason, 'coherence-boundary');
  assert.equal(coherence.baselineComparison.focus, 'rest');
  assert.equal(20n * 8556839292003941n - 19n * 9007199254740991n, -9n);
  assert.equal(evaluate({ staleHeartbeatRatio: 0.7 - 1e-8 }).focus, 'rest');
  assert.equal(evaluate({ staleHeartbeatRatio: 0.7 + 1e-8 }).focus, 'escalate-to-owner');
  assert.equal(evaluate({ reachableDagNodes: 19, declaredDagNodes: 20 }).status, 'uncertain');
});

test('a decisive higher-priority reason dominates uncertainty in an unused comparison', () => {
  assert.equal(evaluate({ handOffEpochMismatch: true, unanchoredPredictions: 1, staleHeartbeatRatio: 0.7 }).focus, 'escalate-to-owner');
  assert.equal(evaluate({ staleHeartbeatRatio: 0.8, observedSurpriseScores: [21.68251319235133] }).focus, 'escalate-to-owner');
  assert.equal(evaluate({ observedSurpriseScores: [25], staleHeartbeatRatio: 0.7 }).focus, 'escalate-to-owner');
  assert.equal(evaluate({ handOffEpochMismatch: true, observedSurpriseScores: [7.737990105077793] }).focus, 'verify');
});

test('the entire finite positive binary64 range and safe count range remain bounded and serializable', () => {
  for (const observedSurpriseScores of [[Number.MAX_VALUE], Array(5).fill(Number.MAX_VALUE),
    [Number.MIN_VALUE, Number.MAX_VALUE, 0, Number.MIN_VALUE, 0]]) {
    const result = evaluate({ observedSurpriseScores });
    assert.equal(result.focus, 'escalate-to-owner');
    assert.ok(JSON.stringify(result).length < 10_000);
  }
  const tiny = evaluate({ observedSurpriseScores: [Number.MIN_VALUE], staleHeartbeatRatio: Number.MIN_VALUE });
  assert.equal(tiny.focus, 'rest');
  assert.equal(tiny.inputEvidence.exact.staleHeartbeat.numerator, '1');
  assert.equal(tiny.inputEvidence.exact.staleHeartbeat.denominator, (1n << 1074n).toString());
  assert.equal(evaluate({ staleHeartbeatRatio: Number.MAX_VALUE }).focus, 'escalate-to-owner');
  assert.equal(evaluate({ reachableDagNodes: Number.MAX_SAFE_INTEGER, declaredDagNodes: Number.MAX_SAFE_INTEGER,
    verifiedReceipts: Number.MAX_SAFE_INTEGER, totalReceipts: Number.MAX_SAFE_INTEGER,
    activeOrgans: Number.MAX_SAFE_INTEGER, declaredOrgans: Number.MAX_SAFE_INTEGER }).focus, 'rest');
  assert.equal(evaluate({ unanchoredPredictions: Number.MAX_SAFE_INTEGER }).focus, 'verify');
});

test('only the last five validated scores influence the exact mean', () => {
  const result = evaluate({ observedSurpriseScores: [Number.MAX_VALUE, 0, 0, 0, 0, 0] });
  assert.equal(result.focus, 'rest');
  assert.equal(result.inputEvidence.surpriseScoresValidated, 6);
  assert.equal(result.inputEvidence.recentSurpriseBinary64.length, 5);
  assert.deepEqual(result.inputEvidence.exact.surpriseMean, { numerator: '0', denominator: '1' });
  assert.deepEqual(evaluate({ observedSurpriseScores: [1, 2, 3, 4, 5] }).inputEvidence.exact.surpriseMean,
    { numerator: '3', denominator: '1' });
  assert.equal(evaluate({ observedSurpriseScores: Array(10_000).fill(0) }).focus, 'rest');
});

test('missing, corrupt, inaccessible and oversized evidence cannot acquire a recommendation', () => {
  const cases = [null, [], {}, signals({ ballId: 'wrong' }), signals({ epoch: -0 }), signals({ computedAt: -1 }),
    signals({ declaredOrgans: 0 }), signals({ reachableDagNodes: 11 }), signals({ staleHeartbeatRatio: -0 }),
    signals({ observedSurpriseScores: [Infinity] }), signals({ observedSurpriseScores: [-0] }),
    signals({ observedSurpriseScores: Array(2) }), signals({ observedSurpriseScores: Array(10_001).fill(0) }),
    signals({ observedSurpriseScores: [NaN, 0, 0, 0, 0, 0] })];
  for (const field of Object.keys(signals())) {
    const value = signals();
    delete value[field];
    cases.push(value);
  }
  const accessor = signals();
  Object.defineProperty(accessor, 'activeOrgans', { get() { assert.fail('evidence getter must not run'); } });
  cases.push(accessor);
  const blocked = new Proxy({}, { getPrototypeOf() { throw new Error('unreadable'); } });
  cases.push(blocked);
  for (const value of cases) {
    const result = computeAuraFocusShadow(value, computeAura(signals()));
    assert.equal(result.status, 'incomplete');
    assert.equal(result.focus, null);
    assert.equal(result.inputEvidence, null);
    assert.equal(result.baselineComparison.status, 'not-compared');
  }
});

test('candidate claims and unrelated hints cannot influence mathematical classification', () => {
  const ordinary = signals({ activeOrgans: 9 });
  const injected = { ...ordinary, recommendedFocus: 'rest', vector: { coherence: 1, wakeUrgency: 0 },
    scorer: 'super-verified', authorityTier: 'owner', granted: true, hints: { reward: 100 }, auraShadow: { focus: 'rest' } };
  assert.deepEqual(computeAuraFocusShadow(injected), computeAuraFocusShadow(ordinary));
  assert.equal(computeAuraFocusShadow(injected).focus, 'consolidate');
});

test('baseline identity and schema affect only comparison; a supplied disagreement is not a theorem defect', () => {
  const raw = signals(), baseline = computeAura(raw);
  assert.equal(computeAuraFocusShadow(raw).baselineComparison.status, 'not-supplied');
  for (const changed of [{ epoch: raw.epoch + 1 }, { computedAt: raw.computedAt + 1 }, { ballId: 'b'.repeat(64) }]) {
    const result = computeAuraFocusShadow(raw, computeAura({ ...raw, ...changed }));
    assert.equal(result.focus, 'rest');
    assert.equal(result.baselineComparison.status, 'stale-or-different-baseline');
  }
  const invalid = computeAuraFocusShadow(raw, { ...baseline, recommendedFocus: 'escalate-to-owner' });
  assert.equal(invalid.focus, 'rest');
  assert.equal(invalid.baselineComparison.status, 'invalid-baseline');
  const different = computeAura(signals({ observedSurpriseScores: [10] }));
  assert.equal(validateAuraVector(different), true);
  const result = computeAuraFocusShadow(raw, different);
  assert.equal(result.focus, 'rest');
  assert.equal(result.baselineComparison.status, 'profile-divergence');
  assert.match(result.profile.comparisonScope, /caller-supplied/);
  assert.match(result.profile.boundaryGuard.scope, /not a universal/);
  assert.equal(validateAuraVector(result), false, 'a diagnostic is never an accepted Aura routing record');
});

test('the circuit does not call floating transcendental functions or expose mutable certificates', () => {
  const source = readFileSync(new URL('../deploy/cloudflare/src/aura-focus-shadow.mjs', import.meta.url), 'utf8');
  assert.equal(/Math\.(?:tanh|log|atanh)\s*\(/.test(source), false);
  const result = evaluate({});
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.profile.thresholds.observeMean.lower), true);
  assert.throws(() => { result.inputEvidence.counts.activeOrgans = 0; }, TypeError);
  assert.equal(result.focus, 'rest');
});

test('an optional baseline becoming unreadable or changing type cannot discard the computed focus', () => {
  const input = signals(), baseline = computeAura(input);
  let identityReads = 0;
  const unreadable = new Proxy(baseline, { get(target, key, receiver) {
    if (key === 'ballId' && ++identityReads === 4) throw new Error('comparison became unreadable');
    return Reflect.get(target, key, receiver);
  } });
  let focusReads = 0;
  const cycle = {};
  cycle.self = cycle;
  const changing = new Proxy(baseline, { get(target, key, receiver) {
    if (key === 'recommendedFocus' && ++focusReads > 1) return cycle;
    return Reflect.get(target, key, receiver);
  } });
  for (const value of [unreadable, changing]) {
    const result = computeAuraFocusShadow(input, value);
    assert.equal(result.focus, 'rest');
    assert.equal(result.status, 'complete');
    assert.equal(result.baselineComparison.status, 'invalid-baseline');
    assert.doesNotThrow(() => JSON.stringify(result));
  }
});
