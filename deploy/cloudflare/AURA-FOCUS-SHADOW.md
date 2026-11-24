# Aura focus shadow

## Scope

The status API returns `auraShadow`, a read-only rational check of the existing `rules-v1` focus recommendation. It is calculated from the same admitted, fenced evidence snapshot as `aura`. It does not replace the Aura vector, issue a wake, grant permission, select a head, write a receipt, or assess whether the observations are physically true. Browser presentation is separate from this API field.

The shared implementation is [src/aura-focus-shadow.mjs](src/aura-focus-shadow.mjs). Its location under `deploy/` keeps the Worker import protected by the existing repository policy. The local adapter imports the same implementation. No unprotected runtime shim is required.

## Status interface

Local and Cloudflare status responses include the sibling `auraShadow`; the exact-field `aukora.aura.v1` record remains unchanged. The public status aliases are `/__x6/status` and `/api/x61/status`, with their existing authentication. Missing or changing Head, Mirror, wake, receipt or memory evidence follows the existing reader refusal paths.

| Field | Meaning |
|---|---|
| `schema` | `aukora.aura-focus-shadow.v1` |
| `profile` | Complete arithmetic definition, threshold enclosures, admission limits and abstention policy |
| `role` | `diagnostic-only` |
| `authorityTier` | `peripheral-hint` |
| `status` | `complete`, `uncertain` or `incomplete` |
| `ballId`, `epoch`, `computedAt` | Captured input identity and time; null where usable metadata is unavailable |
| `focus` | A definite mathematical recommendation, or null |
| `reason`, `checks` | Deciding comparison and bounded intermediate comparison results |
| `inputEvidence` | Counts, flags, relevant binary64 encodings and exact fractions; null for incomplete evidence |
| `baselineComparison` | Comparison with a supplied valid `rules-v1` record of the same identity and time |

A complete result means the declared arithmetic profile decided a focus. It is not a statement of overall system health. An uncertain result has usable evidence but lies within a relevant numerical boundary band. An incomplete result lacks admitted evidence and has no recommendation. The existing Aura fallback, if present, is not copied into the shadow as a certified answer.

The comparison states are `not-supplied`, `invalid-baseline`, `stale-or-different-baseline`, `undecided`, `agrees` and `profile-divergence`. The supplied baseline never affects mathematical classification. Matching identity and time do not prove the baseline was computed from these inputs; the production adapters supply the freshly computed record themselves.

## Arithmetic

Counts remain nonnegative safe integers with positive denominators and numerators no greater than their totals. Relevant finite nonnegative binary64 inputs are decoded to their exact dyadic fractions; negative zero is rejected. All surprise entries are validated under the existing limit, and only the last five enter the exact mean. An empty surprise list has mean zero.

For reachable/declared DAG counts `Rd/Dd`, verified/total receipts `Rr/Dr`, active/declared organs `Ro/Do`, unanchored predictions `u`, handoff mismatch `h`, pending wakes `w`, rollback age `a`, and mean surprise `m`, the profile uses:

```text
coherence = 5 * Rd * Rr * Ro / (Dd * Dr * Do * (5 + u))
driftTenths = min(10, 4*h + 4*[u > 0] + 2*[w >= 2] + [a < 3])
observeMean = 25 * atanh(3/10)
escalateMean = 25 * atanh(7/10)
```

BigInt arithmetic prevents overflow in products of individually safe counts. The two transcendental thresholds are enclosed rather than approximated without an error estimate. For either positive rational argument `x`, the implementation sums 64 terms of `25 * x^(2k+1)/(2k+1)`, rounding each term outwards on a denominator of `2^96`. The positive omitted tail is at most `25 * x^129 / (129 * (1 - x*x))`. The returned profile includes both endpoints and this tail bound. The helper calls no floating transcendental function.

Decision priority follows the mathematical reading of `rules-v1`: escalation from drift, heartbeat or surprise; verification from drift; observation from surprise; consolidation from deficient coherence; otherwise rest. A definite higher-priority condition can decide the result despite uncertainty in a lower-priority comparison.

An explicit boundary band of `2^-40` applies to heartbeat and coherence; the corresponding surprise-mean band is `25 * 2^-40`. A comparison in that band abstains when it could change the focus. This is a declared diagnostic policy, not a theorem bounding every JavaScript implementation's rounding error. A reported profile divergence requires investigation; it does not establish a defect in the original scorer.

The profile is distinct from the baseline's floating multiplications, incremental mean and `Math.tanh`. It also receives an already rounded heartbeat aggregate, potentially combined with overdue-wake pressure. Exact decoding of that aggregate cannot recover its original measurement counts.

## Evidence and limits

The response retains count inputs, the handoff flag, the number of validated surprise entries, the latest five surprise values as binary64 hex, the heartbeat encoding and exact mean/coherence/heartbeat fractions. These are enough to replay the focus calculation. Omitted older surprise values cannot be independently revalidated from this response. This record is not a signature, owner approval, module-execution attestation, independent clock reading or proof that its sensors are truthful.

`computeAuraFocusShadow(inputs, baseline)` is synchronous and has no I/O. Its returned objects are immutable. Extra candidate focus, vector, authority and hint fields do not enter the calculation. Snapshot freshness and consistency remain the responsibility of the existing readers; the helper does not manufacture those guarantees from a timestamp.

The wake reader extracts its existing metric fields and recomputes `rules-v1`. It does not consume `auraShadow`. A different view of the shadow, a forged shadow field, or a rendering failure therefore cannot change wake routing through this addition.

## Reproduction

Run the focused behavior and integration checks from the repository root:

```sh
node --test server/aura-focus-shadow.test.mjs server/messages-store.test.mjs server/cloudflare-bootstrap.test.mjs deploy/cloudflare/src/__tests__/head-wake.test.mjs
python server/aura-focus-shadow.verify.py
node deploy/ci/authority-preflight.mjs
```

The Python checker uses only the standard library and Node. Its separate exact-fraction implementation checks the threshold enclosures, wide-count arithmetic, branch priority, boundary abstention and reported fractions. Node tests cover missing and malformed evidence, ignored claims, baseline identity, local and synthetic HeadDO/Mirror status, unchanged wake routing and read-only evidence collection. These are local tests; they do not establish what is deployed or rendered in an authenticated browser.

## Extending the reflex

A Wasm implementation needs the existing `mv_abi_version`, `mv_alloc`, `mv_run` and memory interface, then the current compiler, metering, hash and execution checks. A binary exposing only `predict` is not an admitted X6.1 skill. Integer or tensor implementations must declare their input quantization, arithmetic range and behavior near thresholds, and compare against the ordinary exact implementation. There is no trained model or Wasm module in this diagnostic.

PENTORA's relevant principle is to distinguish a conclusion supported by a declared model from unresolved behavior outside it. Here that means definite calculation, numerical uncertainty and missing evidence remain separate. Spherical projection, signatures and visual consistency confer no additional identity or physical-truth guarantee. Neural execution and richer visualization are separate proposals, and must justify their cost against this conventional baseline.
