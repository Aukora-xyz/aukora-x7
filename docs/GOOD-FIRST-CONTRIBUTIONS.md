# Good first contributions

Ten real starting tasks. Each is tied to a file in this tree and to a red test or a stated gap. None is done.

**These are not opened as issues.** They live only on this page. Before you start one, open an issue or a draft pull request that names its number here, so two people do not do the same work. When one is done, the pull request that closes it also removes it from this page.

Rules that apply to every task ([CONTRIBUTING.md](../CONTRIBUTING.md)): no test, cap or gate is weakened; a red row on [KNOWN-RED-TESTS.md](KNOWN-RED-TESTS.md) changes only with a cause written down; every claim carries one of the labels IMPLEMENTED, RECORDED RUN (of an earlier tree), INDEPENDENTLY VERIFIED (identify the check, revision and platform), UNVERIFIED or DIRECTION.

An organ is one replaceable module of Auma. A ball lists each organ’s module specifier. The supplied genesis is an epoch-1 ball with SHA-256 module references. Recovery can import a previously selected head.

## 1. Run the suites on a second machine

- **Gap.** The authors recorded four suites on one Mac. Later unsigned reports cover narrower checks at commit `80e392d1`, including Linux. A full repeat on this candidate remains unverified. See [the record of an earlier tree](RUN-RECORD.md) and [the outside reports](../claims.json).
- **Done.** Record the tested revision, platform, tool versions, duration and counts for each suite, and the dry-run ball ID. Record the failing case names and compare the per-file counts with [the published list](KNOWN-RED-TESTS.md).
- **Check.** Identify the exact revision, platform and suite a maintainer independently repeated.

## 2. Make `server/read-limits.test.mjs` load

- The earlier run reported a load failure. See [Reported failures with undetermined causes](KNOWN-RED-TESTS.md#reported-failures-with-undetermined-causes).
- **Done:** the load error is named in that row, and either the file's cases run under `node --test`, or the row says why they cannot.
- **Check:** `node --test server/read-limits.test.mjs` after `pnpm install --frozen-lockfile`.

## 3. Find out why `node-stubs.spec.ts` fails

- **Red:** `packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts`, "execa refuses 1 called symbol(s)" (the case built at line 97), found by the recorded run (of an earlier tree).
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

## 6. Assert the shipped genesis head too

- **Gap:** `packages/experimental/webworker-runtime/tests/x6/organ-entry-states.spec.ts`, the case "her real head" (line 231), asserts the head of a long-running node against a frozen stand-in head in `packages/experimental/webworker-runtime/tests/x6/fixtures/frozen-head/` (epoch 173). No case in that file asserts the head this repository ships at `mirror/home/auma/HEAD.json`: epoch 1, 26 entries.
- **Done:** a new case asserts the genesis head; the existing case is unchanged; nothing is loosened.
- **Check:** `pnpm exec vitest run packages/experimental/webworker-runtime/tests/x6/organ-entry-states.spec.ts` passes, and the original expectations are still in the file.

## 7. Give the superagent tests a synthetic home

- **Earlier reports.** Three failures in `apps/web/src/spatial/superagent/superagent.test.ts` and eight in `read.spec.ts`. The earlier list separately described the 256-node case at line 1551 as timing-sensitive. Neither file was in the recorded four-suite run. Check current results and fixture inputs.
- **Done:** both files run against a synthetic home created by the test; the timing case no longer depends on load.
- **Check:** run both files and report the command you used; it is not in RUN-RECORD.md yet (a record of an earlier tree).

## 8. Align workflow tests with exported triggers

Update the [deployment](../deploy/cloudflare/src/__tests__/deploy-workflow.test.mjs#L313), [proposal-gate](../deploy/cloudflare/src/__tests__/deploy-workflow.test.mjs#L415) and [CI trigger assertions](../scripts/ci-workflow.spec.ts#L822) to match manual dispatch and the three workflows that declare `workflow_call`. Preserve the permission, job and deployment checks. Report the changed expectations and results for the [three listed test files](KNOWN-RED-TESTS.md#L13).

## 9. One source for deployment values

The [Wrangler template](../deploy/cloudflare/wrangler.toml#L5) sets the Worker name and [host](../deploy/cloudflare/wrangler.toml#L20). Compare the [broker’s Worker name](../deploy/cloudflare/src/cloud-brokers.mjs#L3273) and the repository slug in the [launcher](../server/deploy-cloudflare.mjs#L24) and [broker](../deploy/cloudflare/src/cloud-brokers.mjs#L19) before consolidating those settings.

## 10. Stop the build from touching a running host by default

- **Gap.** In an ordinary build, `server/build-preview.mjs` requests retention on the configured loopback port (default 4610) before rebuilding if `dist/preview.html` exists, and again after sealing the build. A compatible host can retain assets and may select the new release. See [the pre-build check](../server/build-preview.mjs#L251) and [the post-build call](../server/build-preview.mjs#L269).
- **Done:** with `PORT` unset it makes no request; a test with a listening stub shows zero calls; the warning in the docs gets shorter.
- **Check:** the new test passes, and the build still completes with `PORT` set as in RUN-RECORD.md (a record of an earlier tree).

## More candidates, not counted above

- The restore rehearsal's open item "clock rollback across restart" (`deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs`, line 148). This touches the authority files and needs a second reviewer ([CONTRIBUTING.md](../CONTRIBUTING.md), rule 6).
- A test that calls the compiler (`packages/experimental/webworker-runtime/src/x6/scion.ts`) and one that calls the self-build step (`mirror/home/auma/seed/organs/seed-cycle.js`). No test calls either today, so both are UNVERIFIED on every page. `scion.ts` is on the authority list, so rule 6 applies.
- This repository ships no Chinese translations of its documents. The application retains its Chinese interface strings.
- Run test files that are outside the recorded commands, starting with `deploy/cloudflare/src/__tests__/owner-login-lockout.spec.ts` (command in `deploy/cloudflare/README.md`, line 171) and `apps/web/src/spatial/superagent/manifest.spec.ts`, and report the results.
- Bring the older label words in [START-HERE.md](START-HERE.md) and [ARCHITECTURE-ACTUAL.md](ARCHITECTURE-ACTUAL.md) to the five labels above.
- Replace the inherited Chinese issue and pull request templates in `.github/` with templates for this project.
