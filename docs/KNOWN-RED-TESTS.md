# Known red tests

English | [中文](KNOWN-RED-TESTS.zh.md)

Some tests in this repository fail, and they are expected to fail. None of them was deleted, skipped or weakened to look green. This page lists each one so a new reader is not surprised, with the count and the reason. Counts come from running each file on its own when this list was written. One run of this tree by its authors is recorded in [RUN-RECORD.md](RUN-RECORD.md); the last column says what that run found for each row. Its logs do not ship, so run the tests to check.

## They cannot pass in this repository

This repository starts from a genesis seed, and its workflows start with their automatic triggers switched off. These tests assert the state of a long-running node, which this repository does not have.

| File | Failing | Reason | In the recorded run |
| --- | --- | --- | --- |
| `scripts/ci-workflow.spec.ts` | 6 of 68 | They assert the automatic workflow triggers. Those are commented out until this repository has its own runners and secrets. | Not run |
| `deploy/cloudflare/src/__tests__/deploy-workflow.test.mjs` | 4 | Same reason: they read the deploy workflow's automatic triggers. | 4 failed |
| `.github/issue-management/policy.test.mjs` | 1 of 51 | Same reason: it reads the issue workflow's triggers. | Not run |
| `packages/experimental/webworker-runtime/tests/x6/organ-entry-states.spec.ts` | 1 ("her real head") | It asserts the head of a long-running node (its epoch and entries). This repository ships the genesis head, epoch 1. | 1 failed |
| `apps/web/src/spatial/superagent/superagent.test.ts` | 3 of 12 | Some cases read a node's own world under `mirror/home/auma/` (receipts, corpus, memory DAG). Only the genesis seed is committed here. | Not run |
| `apps/web/src/spatial/superagent/read.spec.ts` | 8 of 50 (a 9th, "exactly 256 referenced nodes fit the file and concurrency budgets", is timing-sensitive and can fail on a busy machine) | Same reason. | Not run |

To make them pass: rewrite them against the genesis seed or a synthetic home, and switch the triggers on when the repository has its own runners.

## Red for reasons not yet investigated

These fail the same way, test by test, at the commit this repository starts from. Their causes have not been investigated yet.

| File | Failing | In the recorded run |
| --- | --- | --- |
| `server/absence.test.mjs` | 9 | 9 failed |
| `server/memory.test.mjs` | 3 | 3 failed |
| `server/predict.test.mjs` | 6 | 6 failed |
| `server/recall.test.mjs` | 50 | 50 failed |
| `server/receipts.test.mjs` | 6 | 6 failed |
| `server/read-limits.test.mjs` | 1 | 1 failed (the file fails to load) |
| `server/receipts-policy.test.mjs` | 3 | 3 failed |
| `packages/experimental/webworker-runtime/tests/x6/scion-growth.spec.ts` | 1 | 1 failed |
| `deploy/cloudflare/src/__tests__/worker.spec.ts` | 5 of 98 (run with `node --experimental-strip-types --test`; vitest does not collect this file) | 5 of 98 failed |

## Found red by the recorded run

The recorded run failed one case that was not on this list and is still red. It is added here and is not fixed yet.

| File | Failing | Reason |
| --- | --- | --- |
| `packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts` | 1 of 34 ("execa refuses 1 called symbol(s)") | Not investigated. The export did not change this spec or the stub it tests; whether it fails at the starting commit was not checked. |
