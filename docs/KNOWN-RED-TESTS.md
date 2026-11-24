# Known red tests

Please report an unlisted failure with the revision, command, environment and diagnostic so its cause can be investigated.

Node’s permission model applies to 21 of the 22 default test files. `server/asset-cache.test.mjs` runs without it because the test calls fsync, which Node 24.22 and newer disable under the permission model. That file still gets the network guard, a rebuilt environment and the run’s fresh temporary folder as HOME. The counts below are reported per file. The [run record of an earlier tree](RUN-RECORD.md) gives the four suite totals, including the corrected app rerun.

## Failures reported under the conditions shown

Counts below are the reported failures per named file under the stated conditions. Results on this revision are unverified. Five [witness documentation cases](../deploy/cloudflare/src/__tests__/witness-switch.test.mjs#L150) require wording absent from this edition. Two fixtures reference a removed Chinese README, including the [nightly-copy fixture](../deploy/cloudflare/src/__tests__/witness-nightly.test.mjs#L446).

| File | Failing | Reason | In the recorded run (of an earlier tree) |
| --- | --- | --- | --- |
| `scripts/ci-workflow.spec.ts` | 6 of 68 | Current cause unverified. | Not run |
| `deploy/cloudflare/src/__tests__/deploy-workflow.test.mjs` | 4 | Current cause unverified. | 4 failed |
| `.github/issue-management/policy.test.mjs` | 1 of 51 | Current cause unverified. | Not run |
| `apps/web/src/spatial/superagent/superagent.test.ts` | 3 of 12 | Current cause unverified. | Not run |
| `apps/web/src/spatial/superagent/read.spec.ts` | 8 of 50 | The earlier list described the separate 256-node case as timing-sensitive on a busy machine. The eight reported failures exclude it. See [apps/web/src/spatial/superagent/read.spec.ts:1551](../apps/web/src/spatial/superagent/read.spec.ts#L1551). Its current result is unverified. | Not run |
| `deploy/cloudflare/src/__tests__/world-holder.test.mjs` | 6 of 59 | Current cause unverified. | No per-file result in the published record of an earlier tree |
| `deploy/ci/frozen-paths.test.mjs` | 8 of 26, run without a `.git` folder (a plain download) | The fixture compares file presence against explicit exceptions in [deploy/ci/frozen-paths.test.mjs:68](../deploy/ci/frozen-paths.test.mjs#L68). The eight failures were reported for the earlier plain download. The result in a Git checkout is unverified. | No per-file result in the published record of an earlier tree |
| `deploy/cloudflare/src/__tests__/rescue-thread-join.test.mjs` | 1 of 64 | Current cause unverified. | No per-file result in the published record of an earlier tree |
| `deploy/cloudflare/src/__tests__/fresh-link.test.mjs` | 1 of 14, run without a `.git` folder | Current cause unverified. | No per-file result in the published record of an earlier tree |
| `deploy/cloudflare/src/__tests__/wake4-mirror-reads.test.mjs` | 1 (the file fails to load) | The handoff file read at module load is absent. See [deploy/cloudflare/src/__tests__/wake4-mirror-reads.test.mjs:25](../deploy/cloudflare/src/__tests__/wake4-mirror-reads.test.mjs#L25). Current result unverified. | No per-file result in the published record of an earlier tree |
| `deploy/cloudflare/src/__tests__/capsule-act-shapes.test.mjs` | 1 of 18 | The contract file referenced by the test is absent. See [deploy/cloudflare/src/__tests__/capsule-act-shapes.test.mjs:363](../deploy/cloudflare/src/__tests__/capsule-act-shapes.test.mjs#L363). Current result unverified. | No per-file result in the published record of an earlier tree |
| `deploy/cloudflare/src/__tests__/capsule-envelope.test.mjs` | 1 of 17 | The contract file referenced by the test is absent. See [deploy/cloudflare/src/__tests__/capsule-envelope.test.mjs:330](../deploy/cloudflare/src/__tests__/capsule-envelope.test.mjs#L330). Current result unverified. | No per-file result in the published record of an earlier tree |
| `packages/experimental/webworker-runtime/tests/x6/self-check.spec.ts` | 1 of 56 | The self-check page referenced by the test is absent. See [packages/experimental/webworker-runtime/tests/x6/self-check.spec.ts:268](../packages/experimental/webworker-runtime/tests/x6/self-check.spec.ts#L268). Current result unverified. | No per-file result in the published record of an earlier tree |
| `packages/experimental/webworker-runtime/tests/x6/retention-real-head.spec.ts` | 2 of 14 | The current spec names the frozen-head fixture. See [packages/experimental/webworker-runtime/tests/x6/retention-real-head.spec.ts:18](../packages/experimental/webworker-runtime/tests/x6/retention-real-head.spec.ts#L18). Current result unverified. | No per-file result in the published record of an earlier tree |
| `packages/experimental/webworker-runtime/tests/x6/retention-infrastructure.spec.ts` | 1 of 21 | The current spec names the frozen-head fixture. See [packages/experimental/webworker-runtime/tests/x6/retention-infrastructure.spec.ts:6](../packages/experimental/webworker-runtime/tests/x6/retention-infrastructure.spec.ts#L6). Current result unverified. | No per-file result in the published record of an earlier tree |
| `packages/experimental/webworker-runtime/tests/x6/voice-organ-readonly.spec.ts` | 8 of 14 | Current cause unverified. | No per-file result in the published record of an earlier tree |
| `apps/web/tests/auma-live-voice-fast-tools.spec.ts` | 1 of 31 | The local-time sentence from `tabClockLine` begins with a capital ("The owner’s tab: …") and the test's pattern at line 815 expects a lowercase "the". Observed with packages installed, on this tree and on the previous public tree. | Not run |
| `packages/experimental/webworker-runtime/tests/x6/voice-fast-tools.spec.ts` | 1 (the file fails to load) | The spec requires a fixture that the public export does not include (ENOENT at line 325). Observed with packages installed, on this tree and on the previous public tree. | Not run |

Report unexpected results with the revision, command, environment and diagnostic.

## Failures also reported in a private checkout

The authors report observing the same failures in their private comparison checkout.

| File | Failing | Reason |
| --- | --- | --- |
| `deploy/cloudflare/src/__tests__/voice-bridge-fast-claude.test.mjs` | 1 of 24 | The test expects `VOICE_FAST_PROVIDER = "anthropic"` in `deploy/cloudflare/wrangler.toml`; this export's template has `"deepseek"`. Observed with packages installed, on this tree and on the previous public tree. |
| `deploy/cloudflare/src/__tests__/voice-provider-limits.test.mjs` | 1 (the file fails to load) | Historical load-time TypeError. The file imports Vitest at [deploy/cloudflare/src/__tests__/voice-provider-limits.test.mjs:1](../deploy/cloudflare/src/__tests__/voice-provider-limits.test.mjs#L1). Its current result is unverified. |
| `apps/web/tests/auma-live-managed-voice-bundle.spec.ts` | 1 of 7 | Current cause unverified. |
| `apps/web/tests/pentora-live-bundle.spec.ts` | 1 (the build step fails, so its 4 cases are skipped) | Current cause unverified. |

## Reported failures with undetermined causes

The authors report matching failures in their private comparison checkout. Their causes were undetermined.

| File | Failing | In the recorded run (of an earlier tree) |
| --- | --- | --- |
| `server/absence.test.mjs` | 9 | 9 failed |
| `server/memory.test.mjs` | 3 | 3 failed |
| `server/predict.test.mjs` | 6 | 6 failed |
| `server/recall.test.mjs` | 50 | 50 failed |
| `server/receipts.test.mjs` | 6 | 6 failed |
| `server/read-limits.test.mjs` | 1 | 1 failed (the file fails to load) |
| `server/receipts-policy.test.mjs` | 3 | 3 failed |
| `deploy/cloudflare/src/__tests__/worker.spec.ts` | 5 (historical allowance, 99 matching declarations in the current file) | 5 of 98 failed |

## Found red by the recorded run

The recorded run of an earlier tree reported one additional node-stubs failure.

| File | Failing | Reason |
| --- | --- | --- |
| `packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts` | 1 of 34 ("execa refuses 1 called symbol(s)") | Current cause unverified. |

## Results from two earlier runs

The recorded run of an earlier tree reported one failure in each file below. A separate installed-package run reported nine of nine and 118 of 118 passing. The results for this edition are unverified.

| File | Failures in the later reported run | In the recorded run (of an earlier tree) |
| --- | --- | --- |
| `packages/experimental/webworker-runtime/tests/x6/organ-entry-states.spec.ts` | 0 of 9 | 1 failed |
| `packages/experimental/webworker-runtime/tests/x6/scion-growth.spec.ts` | 0 of 118 | 1 failed |

This repository ships no Chinese translations of its documents. The application retains its Chinese interface strings.
