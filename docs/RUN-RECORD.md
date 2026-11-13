# Run record

English | [中文](RUN-RECORD.zh.md)

This record is of an earlier tree of this repository (genesis `a26b7a027014e6af067a0a8433c49c56639ac09642726110c91f8300e9e81624`). The tree it now ships with has genesis `e70d86bd8972997f283291ab5c69d589ec20283ef12045b4eedea8832d772cfd`; its authors have not repeated this full run on it. What was run on this tree is the one command on the front page, `node scripts/verify-lite.mjs`.

This is one run of an earlier tree of this repository, as shipped then, on one machine, by its authors. It is a record, not a guarantee. Everything here is RAN unless tagged SOURCE. The install did not fall back to linked modules, but offline it needed a copy of the pnpm registry metadata cache (see Install). The run is named by the genesis head it booted, ball `a26b7a027014e6af067a0a8433c49c56639ac09642726110c91f8300e9e81624`, epoch 1. To repeat these steps on the tree this repository ships now, run the same commands in a fresh copy of it, with `HOME` set to an empty folder, and compare; the results may differ, since this record is of an earlier tree. The logs of the run do not ship.

## Tools and steps

Node v24.11.1, pnpm 11.28.5 (the version `package.json` pins), vitest 4.1.11. Every process ran with `HOME`, the XDG folders, the npm cache and `TMPDIR` pointed at a scratch folder. One heavy step ran at a time.

| Step | Command | Result |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile --offline --store-dir <a local pnpm store>` | Exit 0 on the fourth try: 1,458 packages, 0 downloaded, lifecycle scripts run. Tries 1 to 3 failed: with no registry metadata in the cache, pnpm could not resolve its own pinned version, then could not check the lockfile offline. The supply-chain policy check stayed on and passed (1,779 entries). |
| Build | `DSH_CLIENT_COMMIT_HASH=0000000 PORT=<a free port> node server/build-preview.mjs` | Exit 0: 104 immutable assets sealed, 260 files in `apps/web/dist`. Without `DSH_CLIENT_COMMIT_HASH` it exited 1: the copy had no `.git`, and the desktop bundle step runs `git rev-parse HEAD`. `0000000` is made up. `NODE_OPTIONS=--max-old-space-size=5632` was set. |
| Boot | `PORT=<a free port> X6_OWNER_EMAIL=<made up> X6_OWNER_PUBLIC_KEY_HEX=<64 random hex> pnpm run x6:start` | Listening on 127.0.0.1, its vault folder inside the scratch `HOME`. Stopped with SIGTERM. |
| Dry run | `node server/cloudflare-bootstrap-cli.mjs --dry-run` | Exit 0: the ball id above, epoch 1, one batch of 552,542 bytes. |

## Tests

Each command ran once, except the app line, which ran twice on the same copy. Its first run also ran once more with `CI=1` set by mistake, with the same result as that first run.

| Suite | Command | Cases | Pass | Fail |
| --- | --- | --- | --- | --- |
| Node, 107 files | `node --test server/*.test.mjs deploy/ci/*.test.mjs deploy/cloudflare/src/__tests__/*.test.mjs` | 2,581 | 2,486 | 82 (and 1 skipped, 12 todo) |
| Edge Worker | `node --test deploy/cloudflare/src/__tests__/worker.spec.ts` | 98 | 93 | 5 |
| App, 63 files, second run | `pnpm exec vitest run packages/client/ui-layout/tests scripts/spatial-catalogue.spec.ts --maxWorkers=3` | 1,112 | 1,112 | 0 |
| Runtime, 88 files | `pnpm exec vitest run packages/experimental/webworker-runtime/tests --maxWorkers=3` | 1,711 | 1,708 | 3 |
| All | | 5,502 | 5,399 | 90 |

The All row is the sum of the four rows above it, each suite at its last run: the app line at its second run, the other three at their only run. The first run of the app line gave 1,112 cases, 1,111 pass and 1 fail. That one failure was made by this repository's export (see Failing cases). The export was corrected, the files it changed were copied into the same copy, and the app line was run again; the other three lines were not run again.

The skipped case checks fixture provenance against Git history, which the copy did not have. The runtime line collected 88 spec files while its folder holds 90. SOURCE: `vitest.config.ts` leaves two out on any platform but Linux (`const nonLinuxWebWorkerTests = process.platform === 'linux'`, listing `packages/experimental/webworker-runtime/tests/node/fs-watch-stream.spec.ts` and `packages/experimental/webworker-runtime/tests/node/sandbox-stack.spec.ts`, with `exclude: platformUnsupportedTests`), and this run was on macOS.

## Failing cases

At the last run of each suite 90 cases failed. 89 of them are listed in [KNOWN-RED-TESTS.md](KNOWN-RED-TESTS.md), each file with the count listed there. In `server/`: `absence.test.mjs` 9, `memory.test.mjs` 3, `predict.test.mjs` 6, `recall.test.mjs` 50, `receipts.test.mjs` 6, `receipts-policy.test.mjs` 3, and `read-limits.test.mjs` 1 (the file fails to load). At the edge: `deploy-workflow.test.mjs` 4 and `worker.spec.ts` 5. In the runtime: `organ-entry-states.spec.ts` > "her real head > every stored ball of mirror/home/auma/HEAD.json: her two misnamed organs say so, one support module, the rest running" and `scion-growth.spec.ts` > "attaches bounded gateway model headers without consuming an open SSE response". Each command prints the name of every case it fails.

The 90th was not on that list and is listed there now: `packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts` > "not-implemented stubs > execa refuses 1 called symbol(s)". Not investigated; the export did not change this spec or the stub it tests (SOURCE).

The first run of the app line failed one more case, made by the export itself: `packages/client/ui-layout/tests/media-drive-registration.client.spec.tsx` > "Media and Documents, registered by the portal > G2 the portal injects the files door into Media and the files scope sets and clears it". The export renamed the portal's slot ids, and this test still looked the Media slot up by its old id. The export now renames that lookup too and refuses any old slot id left in the tree. In the second run of the app line no case failed.

No listed row passed. Four listed rows are outside the commands above and were not run: `scripts/ci-workflow.spec.ts`, `.github/issue-management/policy.test.mjs`, and the two superagent files in `apps/web/src/spatial/superagent/`.

## What the local host answered

Signed out: `GET /` gave 200 and the app's `index.html` (960 bytes); `GET /recovery/` gave 200, "Auma recovery". `/_head/status`, `/_host/lifecycle`, `/_mirror/status`, `GET /_host/owner-key`, `POST /_host/owner-grant`, `POST /door/anthropic/v1/messages` and `GET /door/deepseek/v1/models` gave 403, "Missing or invalid session capability". The host has no public health or build-stamp route (SOURCE). With the copy's own session capability (not recorded): `/_head/status` gave the ball id above at epoch 1, `/_host/lifecycle` the phase `running`, `/_host/runtime-assets` 104 files with `buildPhase` `complete`, and `/_head/runtime` the selection error `PEARL_QUALIFICATION_UNVERIFIABLE`.

## What this run did not cover

- No browser session. The app's HTML was fetched, never opened or looked at.
- No deployment to Cloudflare, no wrangler, no network: the install was offline.
- No model call. The door requests were refused before any provider was called.
- No passkey ceremony, no AUMLOK enrolment, no owner sign-in. The owner values were made up.
- One machine. No speed or load was measured, and `pnpm run x6:build` was not run.
