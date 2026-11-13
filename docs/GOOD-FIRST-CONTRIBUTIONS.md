# Good first contributions

English | [中文](GOOD-FIRST-CONTRIBUTIONS.zh.md)

Ten real starting tasks. Each is tied to a file in this tree and to a red test or a stated gap. None is done.

**These are not opened as issues.** They live only on this page. Before you start one, open an issue or a draft pull request that names its number here, so two people do not do the same work. When one is done, the pull request that closes it also removes it from this page.

Rules that apply to every task ([CONTRIBUTING.md](../CONTRIBUTING.md)): no test, cap or gate is weakened; a red row on [KNOWN-RED-TESTS.md](KNOWN-RED-TESTS.md) changes only with a cause written down; every claim carries one of the labels IMPLEMENTED, RECORDED RUN (of an earlier tree), INDEPENDENTLY VERIFIED (nothing has it yet), UNVERIFIED or DIRECTION.

Three words used below: an organ is one replaceable module of Auma, the AI in this repository; a ball is the manifest that names every organ by hash; the genesis head is the first ball, at epoch (version number) 1, that every node starts from.

## 1. Run the suites on a second machine

- **Gap:** the only run is by the authors, on one machine, macOS ([RUN-RECORD.md](RUN-RECORD.md)) (a record of an earlier tree). Nothing is INDEPENDENTLY VERIFIED. Two runtime specs only run on Linux (`vitest.config.ts`, lines 69 to 76).
- **Done:** a pull request with a record in the same format as RUN-RECORD.md (a record of an earlier tree): tool versions, the counts of each suite, every failing case name compared with KNOWN-RED-TESTS.md, and the dry-run ball id. Linux is the most useful. RUN-RECORD.md, a record of an earlier tree, gives no durations, so note how long the install and each suite took.
- **Check:** a maintainer repeats one suite and gets the same counts. This would be the first INDEPENDENTLY VERIFIED item.

## 2. Make `server/read-limits.test.mjs` load

- **Red:** the file fails to load (KNOWN-RED-TESTS.md, "Red for reasons not yet investigated").
- **Done:** the load error is named in that row, and either the file's cases run under `node --test`, or the row says why they cannot.
- **Check:** `node --test server/read-limits.test.mjs` after `pnpm install --frozen-lockfile`.

## 3. Find out why `node-stubs.spec.ts` fails

- **Red:** `packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts`, "execa refuses 1 called symbol(s)" (the case built at line 96), found by the recorded run (of an earlier tree).
- **Done:** the called symbol and the cause are named; the stub or the test is fixed with the cause in the commit, or the row says why not.
- **Check:** `pnpm exec vitest run packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts`.

## 4. Diagnose the receipt and prediction tests

- **Red:** 15 cases: `server/receipts.test.mjs` 6, `server/receipts-policy.test.mjs` 3, `server/predict.test.mjs` 6. They test the receipt log (`mirror/home/auma/seed/organs/seed-receipts.js`) and the prediction organ (`seed-predict.js`), which the front pages describe.
- **Done:** the first failing assertion of each case and its cause are written into the KNOWN-RED-TESTS.md rows. Fixes may follow in separate pull requests; `seed-receipts.js` and `seed-predict.js` are owner-only organs, so their changes get the second reviewer.
- **Check:** `node scripts/verify-lite.mjs` runs `receipts-policy` and `predict` with no install; `receipts` needs the install.

## 5. One cause or many: `server/recall.test.mjs`

- **Red:** 50 cases in one file. `server/absence.test.mjs` (9) and `server/memory.test.mjs` (3) are of the same kind.
- **Done:** a note in the KNOWN-RED-TESTS.md row on whether one cause explains all 50, then either a fix or causes per group. Then the same for the other two files.
- **Check:** `node --test server/recall.test.mjs` after an install. `memory` runs in `node scripts/verify-lite.mjs`; `absence` is left out of it on purpose (see the comment in that script), so run `node --test server/absence.test.mjs`.

## 6. Assert the shipped head, not a long-running one

- **Red:** `packages/experimental/webworker-runtime/tests/x6/organ-entry-states.spec.ts`, the case at lines 226 and 227, reads `mirror/home/auma/HEAD.json` and expects the epoch of a long-running node (171 or more). This repository ships the genesis head there: epoch 1, 26 entries.
- **Done:** a new case asserts the genesis head; the original assertion runs against a synthetic long-running fixture; nothing is loosened.
- **Check:** `pnpm exec vitest run packages/experimental/webworker-runtime/tests/x6/organ-entry-states.spec.ts` passes, and the original expectations are still in the file.

## 7. Give the superagent tests a synthetic home

- **Red:** `apps/web/src/spatial/superagent/superagent.test.ts` (3 of 12) and `read.spec.ts` (8 of 50) read a node's world under `mirror/home/auma/` that is not shipped. A ninth case in `read.spec.ts` ("exactly 256 referenced nodes fit the file and concurrency budgets", line 1551) depends on machine load. Neither file was in the recorded run (of an earlier tree).
- **Done:** both files run against a synthetic home created by the test; the timing case no longer depends on load.
- **Check:** run both files and report the command you used; it is not in RUN-RECORD.md yet (a record of an earlier tree).

## 8. Make the workflow-trigger tests fit a repository with triggers off

- **Red:** `scripts/ci-workflow.spec.ts` (6), `deploy/cloudflare/src/__tests__/deploy-workflow.test.mjs` (4), `.github/issue-management/policy.test.mjs` (1). They assert automatic triggers that are commented out here, with a disabled marker (for example line 44 of `.github/workflows/deploy-*.yml`).
- **Done:** the tests accept the marker, assert that only manual dispatch is live, and still hold their original assertions on the commented trigger text.
- **Check:** the three files pass, and a diff shows no original assertion removed.

## 9. One source for deployment values

- **Gap:** the placeholders `your-node`, `node.example.invalid` and `your_org_x/your-node` are written into code as well as `deploy/cloudflare/wrangler.toml`: `server/deploy-cloudflare.mjs` (lines 21, 24), `deploy/cloudflare/src/cloud-brokers.mjs` (lines 8, 1700), `server/seed-cloudflare.mjs` (line 14), `server/cloudflare-bootstrap-cli.mjs` (line 6), and more (the grep below lists them). A fresh-account deployment is UNVERIFIED.
- **Done:** every non-test code file that the grep below lists reads the values from one configuration source.
- **Check:** `grep -rlE 'your-node|example\.invalid|your_org_x' server deploy` lists only that configuration, tests and documentation, and `node --test deploy/ci/*.test.mjs` has no failure (KNOWN-RED-TESTS.md lists none there).

## 10. Stop the build from touching a running host by default

- **Gap:** `server/build-preview.mjs` (lines 43 to 55) posts to `http://127.0.0.1` at `PORT`, default 4610, before and after a build. A program listening there is changed.
- **Done:** with `PORT` unset it makes no request; a test with a listening stub shows zero calls; the warning in the docs gets shorter.
- **Check:** the new test passes, and the build still completes with `PORT` set as in RUN-RECORD.md (a record of an earlier tree).

## More candidates, not counted above

- The restore rehearsal's open item "clock rollback across restart" (`deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs`, line 148). This touches the authority files and needs a second reviewer ([CONTRIBUTING.md](../CONTRIBUTING.md), rule 6).
- A test that calls the compiler (`packages/experimental/webworker-runtime/src/x6/scion.ts`) and one that calls the self-build step (`mirror/home/auma/seed/organs/seed-cycle.js`). No test calls either today, so both are UNVERIFIED on every page. `scion.ts` is on the authority list, so rule 6 applies.
- Read the Chinese twins of the new front pages (`*.zh.md`) against their English pages and report where they differ; where they do, the English page applies.
- Run test files that are outside the recorded commands, starting with `deploy/cloudflare/src/__tests__/owner-login-lockout.spec.ts` (command in `deploy/cloudflare/README.md`, line 167) and `apps/web/src/spatial/superagent/manifest.spec.ts`, and report the results.
- Bring the older label words in [START-HERE.md](START-HERE.md) and [ARCHITECTURE-ACTUAL.md](ARCHITECTURE-ACTUAL.md) to the five labels above.
- Replace the inherited Chinese issue and pull request templates in `.github/` with templates for this project.
