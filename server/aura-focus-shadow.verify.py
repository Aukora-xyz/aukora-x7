"""Independent exact-fraction checks of Aura focus diagnostics and threshold enclosures."""
from fractions import Fraction as F
import json
import random
import subprocess
import sys
from pathlib import Path

root = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parents[1])
base = dict(computedAt=1700000000000, ballId='a' * 64, epoch=7,
            reachableDagNodes=10, declaredDagNodes=10, verifiedReceipts=10, totalReceipts=10,
            activeOrgans=10, declaredOrgans=10, unanchoredPredictions=0, pendingWakes=0,
            lastRollbackAgeEpochs=100, observedSurpriseScores=[], handOffEpochMismatch=False,
            staleHeartbeatRatio=0)
rng = random.Random(650111)
cases = []
for mask in range(16):
    for surprise in (0, 10, 25):
        for heartbeat in (0, .7, .8):
            cases.append(dict(base, handOffEpochMismatch=bool(mask & 8),
                              unanchoredPredictions=bool(mask & 4) * 1,
                              pendingWakes=2 if mask & 2 else 0,
                              lastRollbackAgeEpochs=0 if mask & 1 else 100,
                              observedSurpriseScores=[surprise], staleHeartbeatRatio=heartbeat))
for _ in range(64):
    c = dict(base)
    for n, d in [('reachableDagNodes', 'declaredDagNodes'), ('verifiedReceipts', 'totalReceipts'),
                 ('activeOrgans', 'declaredOrgans')]:
        c[d] = rng.randrange(1, 2**53)
        c[n] = rng.randrange(c[d] + 1)
    c['observedSurpriseScores'] = [rng.random() * 30 for _ in range(rng.randrange(10))]
    c['staleHeartbeatRatio'] = rng.random()
    cases.append(c)
cases += [dict(base, reachableDagNodes=8556839292003941, declaredDagNodes=9007199254740991),
          dict(base, observedSurpriseScores=[5e-324]),
          dict(base, observedSurpriseScores=[float.fromhex('0x1.fffffffffffffp+1023')] * 5)]
script = """
import fs from 'node:fs';
import {computeAuraFocusShadow as f,AURA_FOCUS_SHADOW_PROFILE as profile} from './deploy/cloudflare/src/aura-focus-shadow.mjs';
const c=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify({profile,results:c.map(x=>f(x))}));
"""
out = json.loads(subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps(cases),
                                text=True, capture_output=True, cwd=root, check=True).stdout)

def wire(x):
    return F(int(x['numerator']), int(x['denominator']))

thresholds = {}
for name, num in [('observeMean', 3), ('escalateMean', 7)]:
    x, terms = F(num, 10), 64
    exact_sum = 25 * sum((x ** (2 * k + 1) / F(2 * k + 1) for k in range(terms)), F())
    tail = 25 * x ** (2 * terms + 1) / F(2 * terms + 1) / (1 - x * x)
    supplied = out['profile']['thresholds'][name]
    assert wire(supplied['lower']) <= exact_sum
    assert wire(supplied['upper']) >= exact_sum + tail
    assert wire(supplied['omittedTailUpper']) == tail
    thresholds[name] = exact_sum, exact_sum + tail
guard = F(1, 2**40)

def side(x, lo, hi, g):
    return 'below' if x < lo - g else 'above' if x > hi + g else 'boundary'

def reference(c):
    recent = c['observedSurpriseScores'][-5:]
    mean = sum(map(F, recent), F()) / max(len(recent), 1)
    coherence = (F(c['reachableDagNodes'], c['declaredDagNodes'])
                 * F(c['verifiedReceipts'], c['totalReceipts'])
                 * F(c['activeOrgans'], c['declaredOrgans'])
                 * F(5, 5 + c['unanchoredPredictions']))
    drift = min(10, 4 * c['handOffEpochMismatch'] + 4 * (c['unanchoredPredictions'] > 0)
                + 2 * (c['pendingWakes'] >= 2) + (c['lastRollbackAgeEpochs'] < 3))
    h = side(F(c['staleHeartbeatRatio']), F(7, 10), F(7, 10), guard)
    e = side(mean, *thresholds['escalateMean'], 25 * guard)
    o = side(mean, *thresholds['observeMean'], 25 * guard)
    co = side(coherence, F(19, 20), F(19, 20), guard)
    if drift >= 7 or h == 'above' or e == 'above':
        result = 'escalate-to-owner'
    elif h == 'boundary' or e == 'boundary':
        result = None
    elif drift >= 4:
        result = 'verify'
    elif o == 'above':
        result = 'observe'
    elif o == 'boundary' or co == 'boundary':
        result = None
    elif co == 'below':
        result = 'consolidate'
    else:
        result = 'rest'
    return result, mean, coherence

for i, (c, result) in enumerate(zip(cases, out['results'])):
    expected, mean, coherence = reference(c)
    assert result['focus'] == expected, (i, c, result['focus'], expected)
    assert wire(result['inputEvidence']['exact']['surpriseMean']) == mean, (i, 'mean')
    assert wire(result['inputEvidence']['exact']['coherence']) == coherence, (i, 'coherence')
    assert wire(result['inputEvidence']['exact']['staleHeartbeat']) == F(c['staleHeartbeatRatio']), (i, 'heartbeat')
assert len(out['results']) == len(cases)
print(json.dumps(dict(independent_python_fraction_cases=len(cases), classification_mismatches=0,
                     rational_value_mismatches=0, threshold_certificates_exactly_enclose_series_and_tail=2,
                     status_counts={s: sum(r['status'] == s for r in out['results'])
                                    for s in ['complete', 'uncertain', 'incomplete']})))
