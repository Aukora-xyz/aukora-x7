# Known red tests

English | [中文](KNOWN-RED-TESTS.zh.md)

Some tests in this repository fail, and they are expected to fail. None of them was deleted, skipped or weakened to look green. This page lists each one so a new reader is not surprised, with the count and, where it is known, the reason. Counts come from running each file on its own when this list was written. One run of an earlier tree of this repository by its authors is recorded in [RUN-RECORD.md](RUN-RECORD.md); the last column says what that run found for each row. Its logs do not ship, so run the tests to check.

## They cannot pass in this repository

This repository starts from a genesis seed, and its workflows start with their automatic triggers switched off. These tests assert the state of a long-running node, which this repository does not have.

| File | Failing | Reason | In the recorded run (of an earlier tree) |
| --- | --- | --- | --- |
| `scripts/ci-workflow.spec.ts` | 6 of 68 | They assert the automatic workflow triggers. Those are commented out until this repository has its own runners and secrets. | Not run |
| `deploy/cloudflare/src/__tests__/deploy-workflow.test.mjs` | 4 | Same reason: they read the deploy workflow's automatic triggers. | 4 failed |
| `.github/issue-management/policy.test.mjs` | 1 of 51 | Same reason: it reads the issue workflow's triggers. | Not run |
| `apps/web/src/spatial/superagent/superagent.test.ts` | 3 of 12 | Some cases read a node's own world under `mirror/home/auma/` (receipts, corpus, memory DAG). Only the genesis seed is committed here. | Not run |
| `apps/web/src/spatial/superagent/read.spec.ts` | 8 of 50 (a 9th, "exactly 256 referenced nodes fit the file and concurrency budgets", is timing-sensitive and can fail on a busy machine) | Same reason. | Not run |
| `deploy/cloudflare/src/__tests__/world-holder.test.mjs` | 6 of 59 | Needs the private history; the public tree ships one snapshot. The six cases compare against two earlier commits with `git show`, and those commits are not in this repository. | Added after the recorded run (of an earlier tree) |
| `deploy/ci/frozen-paths.test.mjs` | 8 of 26, run without a `.git` folder (a plain download) | One case asserts that every file on the frozen list is in the tree; the list names her receipts file under `mirror/home/auma/seed/`, which this repository does not ship (only the genesis seed is committed). One case asserts the automatic trigger of `proposal-checks.yml`, which is commented out here like the other workflows. Six cases call `git ls-files`, which needs a git checkout; the count in a git checkout of this tree was not measured for this list. | Added after the recorded run (of an earlier tree) |
| `deploy/cloudflare/src/__tests__/rescue-thread-join.test.mjs` | 1 of 64 | The case runs `git grep`, and a plain download of this tree has no `.git` folder. | Added after the recorded run (of an earlier tree) |
| `deploy/cloudflare/src/__tests__/fresh-link.test.mjs` | 1 of 14, run without a `.git` folder | The case \"wired to nothing\" runs `git ls-files`, and a plain download of this tree has no `.git` folder. | Added after the recorded run (of an earlier tree) |
| `deploy/cloudflare/src/__tests__/wake4-mirror-reads.test.mjs` | 1 (the file fails to load) | It reads her hand-off note, `mirror/home/auma/HANDOFF.md`, when it loads. That note is part of her world, which this repository does not ship. | Added after the recorded run (of an earlier tree) |
| `deploy/cloudflare/src/__tests__/capsule-act-shapes.test.mjs` | 1 of 18 | One case reads the capsule contract, `docs/capsule/CONTRACT.md`, which this repository does not ship (its schema page, `docs/capsule/SCHEMA.md`, is shipped, and the case that reads it passes). | Added after the recorded run (of an earlier tree) |
| `deploy/cloudflare/src/__tests__/capsule-envelope.test.mjs` | 1 of 17 | Same reason: one case reads `docs/capsule/CONTRACT.md`. | Added after the recorded run (of an earlier tree) |
| `packages/experimental/webworker-runtime/tests/x6/self-check.spec.ts` | 1 of 56 | One case reads her page `docs/auma/self-check.md`, which this repository does not ship. | Added after the recorded run (of an earlier tree) |
| `packages/experimental/webworker-runtime/tests/x6/retention-real-head.spec.ts` | 2 of 14 | They test the organ modules of a long-running node's head. This repository replaces that head with a stand-in built from the generic seed set, so those modules are other bytes here. | Added after the recorded run (of an earlier tree) |
| `packages/experimental/webworker-runtime/tests/x6/retention-infrastructure.spec.ts` | 1 of 21 | Same reason as the row above. | Added after the recorded run (of an earlier tree) |
| `packages/experimental/webworker-runtime/tests/x6/voice-organ-readonly.spec.ts` | 8 of 14 | It proves the organ actions voice may call read-only on the organ bytes of a long-running node's head, and checks the pins in `voice-organ-pins.ts` against those bytes. This repository ships the genesis head, whose organs are other bytes, so those pins match nothing here and voice refuses those tools. | Added after the recorded run (of an earlier tree) |

To make them pass: rewrite them against the genesis seed or a synthetic home, and switch the triggers on when the repository has its own runners.

## Red the same way in the source they were exported from

These fail the same way, case for case, in a checkout of the private source this tree is exported from. The export did not cause them.

| File | Failing | Reason |
| --- | --- | --- |
| `deploy/cloudflare/src/__tests__/voice-bridge-fast-claude.test.mjs` | 1 of 24 | One case expects the shipped configuration to name Claude as the fast voice's provider; the source switched that line to DeepSeek (`VOICE_FAST_PROVIDER = "deepseek"` in `deploy/cloudflare/wrangler.toml`) and the case was not changed with it. |
| `deploy/cloudflare/src/__tests__/voice-provider-limits.test.mjs` | 1 (the file fails to load) | It stops with a TypeError when it loads, in the source too. Not investigated further. |
| `apps/web/tests/auma-live-managed-voice-bundle.spec.ts` | 1 of 7 | The case rebuilds the managed voice bundle, which needs the voice provider's package (`@elevenlabs/client`) installed; a plain `pnpm install` of this tree was not checked to provide it. |
| `apps/web/tests/pentora-live-bundle.spec.ts` | 1 (the build step fails, so its 4 cases are skipped) | Same reason: its build step bundles the Auma Live modules, which import that package. |

## Red for reasons not yet investigated

These fail the same way, test by test, at the commit this repository starts from. Their causes have not been investigated yet.

| File | Failing | In the recorded run (of an earlier tree) |
| --- | --- | --- |
| `server/absence.test.mjs` | 9 | 9 failed |
| `server/memory.test.mjs` | 3 | 3 failed |
| `server/predict.test.mjs` | 6 | 6 failed |
| `server/recall.test.mjs` | 50 | 50 failed |
| `server/receipts.test.mjs` | 6 | 6 failed |
| `server/read-limits.test.mjs` | 1 | 1 failed (the file fails to load) |
| `server/receipts-policy.test.mjs` | 3 | 3 failed |
| `deploy/cloudflare/src/__tests__/worker.spec.ts` | 5 of 98 (run with `node --experimental-strip-types --test`; vitest does not collect this file) | 5 of 98 failed |

## Found red by the recorded run

The recorded run (of an earlier tree) failed one case that was not on this list and is still red. It is added here and is not fixed yet.

| File | Failing | Reason |
| --- | --- | --- |
| `packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts` | 1 of 34 ("execa refuses 1 called symbol(s)") | Not investigated. The export did not change this spec or the stub it tests; whether it fails at the starting commit was not checked. |

## Red in the recorded run, not red in this tree

These two files each failed one case in the recorded run of an earlier tree. They stay on this page so that run's list still resolves. In this tree neither failed when its authors ran this tree's changed test files together with the packages installed: 9 of 9 and 118 of 118 cases passed, as the test runner counts them (each row of a table-driven case counts as one). `organ-entry-states.spec.ts` now reads a frozen stand-in head in `packages/experimental/webworker-runtime/tests/x6/fixtures/frozen-head/`; why `scion-growth.spec.ts` changed was not investigated.

| File | Failing in this tree | In the recorded run (of an earlier tree) |
| --- | --- | --- |
| `packages/experimental/webworker-runtime/tests/x6/organ-entry-states.spec.ts` | 0 of 9 | 1 failed |
| `packages/experimental/webworker-runtime/tests/x6/scion-growth.spec.ts` | 0 of 118 | 1 failed |
