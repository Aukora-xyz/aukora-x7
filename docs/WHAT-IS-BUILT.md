# What is built

## Evidence

The [record of an earlier tree](RUN-RECORD.md) gives the authors’ suite-level results. The authors reported 5,502 cases across four suites on one machine, using the app rerun after an export correction and earlier results for the other three suites. That total includes 5,399 passes, 90 failures, one skip and 12 todo. The authors reported that 89 failures fell within the counts already listed for those files.

## Selected capabilities

| Capability | Code | Test file | Label |
| --- | --- | --- | --- |
| Repository branches | `deploy/cloudflare/src/cloud-brokers.mjs` | `deploy/cloudflare/src/__tests__/repo-brokers.test.mjs` | BUILT-ON-MAIN |
| Protected module replacement | `deploy/cloudflare/src/head-do.mjs`, `deploy/cloudflare/src/owner-grant-policy.mjs` | `deploy/cloudflare/src/__tests__/head-hardening.test.mjs` | BUILT-ON-MAIN |
| Head-sync deferral | `deploy/cloudflare/src/cloud-brokers.mjs` | `deploy/cloudflare/src/__tests__/merge1-read-window.test.mjs`, `deploy/cloudflare/src/__tests__/merge1-sync-hold.test.mjs` | BUILT-ON-MAIN |
| Proposal withdrawal | `deploy/cloudflare/src/cloud-brokers.mjs` | `deploy/cloudflare/src/__tests__/merge1-withdraw.test.mjs` | BUILT-ON-MAIN |
| Read-only tool mounting | `packages/experimental/webworker-runtime/src/x6/ball-loader.ts` | `packages/experimental/webworker-runtime/tests/x6/tools-mount-realhost-redteam.spec.ts` | BUILT-ON-MAIN |
| Wake step limits | `deploy/cloudflare/src/head-do.mjs` | `deploy/cloudflare/src/__tests__/wake-notes-wake1.test.mjs`, [wake2-reasons.test.mjs:93](../deploy/cloudflare/src/__tests__/wake2-reasons.test.mjs#L93) | BUILT-ON-MAIN |
| Wake stop reasons | `deploy/cloudflare/src/head-do.mjs` | [deploy/cloudflare/src/__tests__/wake2-reasons.test.mjs:101](../deploy/cloudflare/src/__tests__/wake2-reasons.test.mjs#L101), `deploy/cloudflare/src/__tests__/cloud-wake-off-switch.test.mjs` | BUILT-ON-MAIN |
| Wake acts | `deploy/cloudflare/src/owner-mandate.mjs`, `deploy/cloudflare/src/head-do.mjs` | `deploy/cloudflare/src/__tests__/owner-mandate.test.mjs`, `deploy/cloudflare/src/__tests__/wake3-review.test.mjs` | BUILT-ON-MAIN |
| Approval notices | `packages/client/ui-layout/src/client/spatial/portal/notices.ts`, `packages/client/ui-layout/src/client/spatial/portal/NoticesSurface.tsx` | `packages/client/ui-layout/tests/portal-approval-notices.client.spec.tsx` | BUILT-ON-MAIN |
| Runner reservations | `deploy/cloudflare/src/runner-budget.mjs`, `deploy/cloudflare/src/cloud-brokers.mjs` | `deploy/cloudflare/src/__tests__/runner-budget.test.mjs`, `deploy/cloudflare/src/__tests__/auma-exec-door.test.mjs` | BUILT-ON-MAIN |
| Pentora observer | `packages/experimental/webworker-runtime/src/x6/pentora-epistemic.ts` | `deploy/cloudflare/src/__tests__/pentora-epistemic.test.mjs` | BUILT-ON-MAIN |
| Prime reservations | `deploy/cloudflare/src/provider-budget.mjs`, `deploy/cloudflare/src/worker.mjs` | `deploy/cloudflare/src/__tests__/prime-door.test.mjs` | BUILT-ON-MAIN |
| Threads page: newest cloud window | `packages/experimental/webworker-runtime/src/storage/thread-sync.ts`, `packages/client/ui-layout/src/client/spatial/portal/ThreadsLane.tsx`, `packages/client/ui-layout/src/client/spatial/portal/thread-sync-marks.ts` | No test file was added for it | BUILT-ON-MAIN |
| Cloud thread list read in part | `packages/experimental/webworker-runtime/src/storage/thread-sync.ts`, `packages/client/ui-layout/src/client/spatial/portal/thread-sync-marks.ts` | No test file was added for it | BUILT-ON-MAIN |
| Sign out of this browser | `packages/client/ui-layout/src/client/spatial/apps/identity/DevicesPortal.tsx`, `packages/client/ui-layout/src/client/spatial/apps/identity/devices.ts` | No test file was added for it | BUILT-ON-MAIN |
| Thread archive route (no screen calls it) | `deploy/cloudflare/src/thread-log.mjs`, `deploy/cloudflare/src/mirror-do.mjs`, `deploy/cloudflare/src/world-lease.mjs` | No test file was added for it | BUILT-ON-MAIN |
| Agent-rule files are not docs-only | `deploy/ci/deploy-paths.mjs`, `deploy/ci/frozen-paths.mjs` | `deploy/ci/deploy-guard.test.mjs` | BUILT-ON-MAIN |
| Continuity Diamond | Unbuilt | Unverified | IDEA |

## Counts and counting rules

Counts beside test filenames are matching declaration lines. The pattern is `^\s*(it|test)(\.each)?\(`. A loop or table can register several cases from one declaration.

- **Organs: 26.** Count the `*.js` filename stems under `mirror/home/auma/seed/organs/`. Their set matches the 26 entry IDs in `mirror/home/balls/HEAD.json`.

- **Wasm cells: 30, with 187 operation entries (184 distinct names).** Count `*.wasm` in `apps/web/public/cells/` and the operation lists in `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`. Six binary basenames have matching WAT source files.

- **Inline tool-name declarations in ball-loader.ts: 33.** This counts literal names at the indentation shown. `grep -cE "^      name: '[a-z_0-9]+'," ball-loader.ts` in `packages/experimental/webworker-runtime/src/x6/`. The loader is 10,330 lines by `wc -l`. The separate thread-tool registration is at [packages/experimental/webworker-runtime/src/x6/ball-loader.ts:9824](../packages/experimental/webworker-runtime/src/x6/ball-loader.ts#L9824).

- **Edge: 91 modules, 186 test files.** `ls deploy/cloudflare/src/*.mjs | wc -l`, more than 46,000 lines in all. The test files end `.test.mjs` or `.spec.ts` in `deploy/cloudflare/src/__tests__/`, more than 76,000 lines in all.
- **App and runtime: 84 and 174 spec files.** The `*.spec.*` files in `packages/client/ui-layout/tests/` and the `*.spec.ts` files under `packages/experimental/webworker-runtime/tests/`.
- **Matching test declarations in five groups: 6,580.** 2,683 at the edge, 1,320 for the app, 1,850 for the runtime, 527 in the 31 test files of `server/` and 200 in the 13 test files of `deploy/ci/`.


The seed scar file lists six rows. Five name guarding checks and `scar-aura-silent-calm` names none. See `mirror/home/auma/seed/scars.jsonl`.

## Test declaration counts

- `deploy/cloudflare/src/__tests__/night-grant.test.mjs` (22 matching declarations)
- `packages/experimental/webworker-runtime/tests/x6/stage-organ-promotion.spec.ts` (10 matching declarations)
- `packages/experimental/webworker-runtime/tests/x6/scion-growth.spec.ts` (74 matching declarations)
- `server/pearl.test.mjs` (38 matching declarations)
- `packages/experimental/webworker-runtime/tests/x6/retention-infrastructure.spec.ts` (8 matching declarations)
- `packages/experimental/webworker-runtime/tests/x6/retention-runtime-parity.spec.ts` (11 matching declarations)
- `packages/experimental/webworker-runtime/tests/x6/retention-export-admission.spec.ts` (9 matching declarations)
- `packages/experimental/webworker-runtime/tests/x6/retention-real-head.spec.ts` (4 matching declarations)
- `packages/experimental/webworker-runtime/tests/x6/capability-index.spec.ts` (8 matching declarations)
- `deploy/cloudflare/src/__tests__/cloud-wake-bounds.test.mjs` (23 matching declarations)
- `deploy/cloudflare/src/__tests__/cloud-wake-off-switch.test.mjs` (5 matching declarations)
- `packages/experimental/webworker-runtime/tests/x6/wake-loop.spec.ts` (11 matching declarations)
- `deploy/cloudflare/src/__tests__/rescue-pack.test.mjs` (22 matching declarations)
- `deploy/cloudflare/src/__tests__/rescue-page.test.mjs` (31 matching declarations)
- `deploy/cloudflare/src/__tests__/repo-brokers.test.mjs` (51 matching declarations)
- `packages/client/ui-layout/tests/app-frame.client.spec.tsx` (43 matching declarations)
- `packages/client/ui-layout/tests/spatial-compact.client.spec.tsx` (60 matching declarations)
- `scripts/spatial-catalogue.spec.ts` (7 matching declarations)
- `packages/client/ui-layout/tests/sovereignty-durability.client.spec.tsx` (29 matching declarations)
- `packages/client/ui-layout/tests/identity-devices.client.spec.tsx` (20 matching declarations)
- `packages/client/ui-layout/tests/work-autonomy.client.spec.tsx` (82 matching declarations)
- `packages/client/ui-layout/tests/host-facts.client.spec.tsx` (110 matching declarations)
- `packages/client/ui-layout/tests/media-drive.client.spec.tsx` (28 matching declarations)
- `packages/client/ui-layout/tests/media-drive-rule.client.spec.ts` (12 matching declarations)
- `packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts` (20 matching declarations)

## Settings and limits

- One Worker, four Durable Object class bindings. Count the class bindings in [deploy/cloudflare/wrangler.toml:114](../deploy/cloudflare/wrangler.toml#L114).
- The repository door level, which this tree sets to `open`, is defined at [deploy/ci/frozen-paths.mjs:40](../deploy/ci/frozen-paths.mjs#L40).
- The voice level, which this tree sets to `open`, is defined at [packages/experimental/webworker-runtime/src/x6/voice-marks.ts:57](../packages/experimental/webworker-runtime/src/x6/voice-marks.ts#L57).
- Wake settings in the supplied template are `WAKE_EXECUTOR_ENABLED = "1"` and `WAKE_ACTS_ENABLED = "1"` at [deploy/cloudflare/wrangler.toml:85](../deploy/cloudflare/wrangler.toml#L85) and [deploy/cloudflare/wrangler.toml:92](../deploy/cloudflare/wrangler.toml#L92).
- A browser writer may create a conversation the cloud lacks of up to 1 GiB (`createMaxBytes` in `packages/experimental/webworker-runtime/src/worker-host.ts`). The supplied template allows 4 GiB of thread lines a UTC day, an 8 GiB world total and 4 GiB of vault blobs a UTC day (`THREAD_DAY_BYTES`, `VAULT_MAX_BYTES` and `VAULT_DAY_BYTES` in `deploy/cloudflare/wrangler.toml`).
- Per UTC day, HEAD can admit the first model request of at most 48 wake steps. A committed admission counts even if the request is never sent ([head-do.mjs:273](../deploy/cloudflare/src/head-do.mjs#L273), [head-do.mjs:2897](../deploy/cloudflare/src/head-do.mjs#L2897)). The evidence checkpoint is paused and not offered ([head-do.mjs:389](../deploy/cloudflare/src/head-do.mjs#L389)).
- The browser URL-prefix table has eight doors for seven providers, counting regional entries under their provider. See [packages/experimental/webworker-runtime/src/model-doors.ts:14](../packages/experimental/webworker-runtime/src/model-doors.ts#L14).

## Voice source files

- `packages/experimental/webworker-runtime/src/x6/voice-read-only.ts`
- `packages/experimental/webworker-runtime/src/x6/voice-organ-pins.ts`

## Recovery evidence

- The browser checks the captured parts against the lengths and SHA-256 values in the Continuity snapshot (`aukora.recovery-snapshot.v1`) and checks its manifest digest. Trust in the snapshot’s origin is separate. After owner confirmation, the restore page can seed an empty edge or resume a matching partial seed. On an initialized edge, the [Estate card](../packages/client/ui-layout/src/client/spatial/portal/recovery-restore.ts#L269) compares the snapshot with the current head, receipt and checkpoint state, and mirror digest. See the [snapshot checks](../deploy/cloudflare/src/recovery-restore.mjs#L147), [target comparison](../deploy/cloudflare/src/recovery-restore.mjs#L341) and [confirmation handler](../deploy/cloudflare/src/recovery-restore.mjs#L469).
- Browser rescue download (`x61-rescue-pack/v1`), local verifier at [server/rescue-verify.mjs:71](../server/rescue-verify.mjs#L71).
- Recovery on deployed infrastructure is unverified.

## Source and test inventory

| Claim | Source | Test | Evidence | Evidence label |
|---|---|---|---|---|
| Request binding | `deploy/cloudflare/src/aumlok.mjs` | `deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Protected module binding | `deploy/cloudflare/src/owner-grant-policy.mjs` | `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Action approval store | `deploy/cloudflare/src/aumlok.mjs` | `deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Protected head selection | `deploy/cloudflare/src/head-do.mjs` | `deploy/cloudflare/src/__tests__/head-hardening.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Issue and comment reservations | `deploy/cloudflare/src/head-do.mjs` | [deploy/cloudflare/src/__tests__/outward-dedupe.test.mjs:42](../deploy/cloudflare/src/__tests__/outward-dedupe.test.mjs#L42) and [deploy/cloudflare/src/__tests__/outward-dedupe.test.mjs:103](../deploy/cloudflare/src/__tests__/outward-dedupe.test.mjs#L103) and [Worker fixture](../deploy/cloudflare/src/__tests__/worker.spec.ts#L724) | The reservation fixture checks issue creation. The Worker fixture covers one-use approval for issues and comments, including an uncertain comment response. Current results are unverified. | IMPLEMENTED |
| Identity proof counters | `deploy/cloudflare/src/proof-failure-rule.mjs` | `deploy/cloudflare/src/__tests__/proof-failure-rule.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Protected-entry classifier | `server/ball-transition.mjs` | `deploy/cloudflare/src/__tests__/convergence-policy.test.mjs`, `deploy/ci/authority-preflight.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Deployment custody | `.github/workflows/deploy-x61.yml`, `.github/workflows/rollback-x61.yml` | [deploy/ci/workflow-credentials.test.mjs:55](../deploy/ci/workflow-credentials.test.mjs#L55) | The test checks which workflows reference deployment credentials. Actual custody is unverified. | UNVERIFIED |
| Ordinary genesis entries | `server/ball-transition.mjs`, `mirror/home/balls/HEAD.json` | Manifest and classifier count | 14 of 26 entries, counted from the supplied genesis manifest with the shipped classifier. | Source inventory |
| Edge head publication and local store publication | `server/ball-head.mjs`, `deploy/cloudflare/src/head-do.mjs` | `server/ball-manifest.test.mjs`, `deploy/cloudflare/src/__tests__/head-hardening.test.mjs` | The local fixture calls the store directly. Current result unverified. | IMPLEMENTED |
| Module admission | `deploy/cloudflare/src/head-do.mjs` | `deploy/cloudflare/src/__tests__/worker.spec.ts` | Test present. Current result unverified. | IMPLEMENTED |
| Worker request forwarding | `deploy/cloudflare/src/worker.mjs` | `deploy/cloudflare/src/__tests__/guest-access-boundary.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Night grant | `deploy/cloudflare/src/night-grant.mjs` | `deploy/cloudflare/src/__tests__/night-grant.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Single-organ owner-session route | `server/ball-transition.mjs`, `deploy/cloudflare/src/head-do.mjs` | `deploy/cloudflare/src/__tests__/signed-head-actions.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Scion compilation | `packages/experimental/webworker-runtime/src/x6/scion.ts` | Unverified | Unverified. | UNVERIFIED |
| Candidate trials | `packages/experimental/webworker-runtime/src/x6/scion-growth.ts` | `packages/experimental/webworker-runtime/tests/x6/scion-growth.spec.ts` | Test present. Current result unverified. | IMPLEMENTED |
| Local organ installation | `mirror/home/auma/seed/organs/seed-cycle.js` | Unverified | Unverified. | UNVERIFIED |
| Pearl qualification | `mirror/home/auma/seed/organs/seed-pearl.js` | `server/pearl.test.mjs` | By default, behavior checks use the pinned Pearl fixture ([pearl.test.mjs:9](../server/pearl.test.mjs#L9)). A separate check loads the supplied organ and inspects its exports ([live-shape.mjs:62](../server/fixtures/organs/live-shape.mjs#L62)). Current results are unverified. | IMPLEMENTED |
| Protected promotion staging | `packages/experimental/webworker-runtime/src/x6/ball-loader.ts` | `packages/experimental/webworker-runtime/tests/x6/stage-organ-promotion.spec.ts`, `packages/experimental/webworker-runtime/tests/x6/head-promotion.spec.ts` | Test present. Current result unverified. | IMPLEMENTED |
| Promotion review display | `packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`, `packages/client/ui-layout/src/client/spatial/portal/organ-code-diff.ts` | `packages/client/ui-layout/tests/organ-code-diff.client.spec.ts`, [packages/client/ui-layout/tests/r29-edge-e2e.client.spec.tsx:1146](../packages/client/ui-layout/tests/r29-edge-e2e.client.spec.tsx#L1146) | Comparison and card-display specs present. Current results unverified. | IMPLEMENTED |
| Independent approval display | [Security limits](../SECURITY.md) | Unverified | Unbuilt. | DIRECTION |
| Browser cell worker | `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts` | `packages/experimental/webworker-runtime/tests/x6/wasm-cells.spec.ts` | Test present. Current result unverified. | IMPLEMENTED |
| Edge authority in Wasm | Unverified | Unverified | Unbuilt. | DIRECTION |
| Receipts and checkpoints | `mirror/home/auma/seed/organs/seed-receipts.js` | `server/receipts.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Browser rescue pack, vault and bounded archive | `deploy/cloudflare/src/rescue-kit.mjs`, `deploy/cloudflare/src/vault.mjs`, `deploy/cloudflare/src/cold-archive.mjs` | `deploy/cloudflare/src/__tests__/rescue-pack.test.mjs`, `deploy/cloudflare/src/__tests__/rescue-page.test.mjs`, `deploy/cloudflare/src/__tests__/cold-archive-bounded.test.mjs`, [deploy/cloudflare/src/__tests__/vault.test.mjs:112](../deploy/cloudflare/src/__tests__/vault.test.mjs#L112) | Test present. Current result unverified. | IMPLEMENTED |
| Continuity snapshot restore | `deploy/cloudflare/src/recovery-restore.mjs` | `deploy/cloudflare/src/__tests__/recovery-restore.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Rollback rehearsals for spent or expired approvals | `deploy/cloudflare/src/aumlok.mjs`, `deploy/cloudflare/src/head-do.mjs` | `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs` | The fixtures expect reuse under specified rollback conditions ([deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs:197](../deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs#L197)). Current results and rollback resistance on a deployed node are unverified. | IMPLEMENTED |
| Inference journal | `deploy/cloudflare/src/turn-journal.mjs`, `deploy/cloudflare/src/provider-dispatch.mjs`, `deploy/cloudflare/src/worker.mjs` | `deploy/cloudflare/src/__tests__/provider-dispatch.test.mjs`, `deploy/cloudflare/src/__tests__/turn-journal-and-body.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Cloud wake | `deploy/cloudflare/src/head-do.mjs`, `deploy/cloudflare/src/cloud-wake-tools.mjs`, `deploy/cloudflare/wrangler.toml` | `deploy/cloudflare/src/__tests__/cloud-wake-bounds.test.mjs`, `deploy/cloudflare/src/__tests__/cloud-wake-off-switch.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| HTTPS head announcement | `deploy/cloudflare/src/nostr-anchor.mjs` | `deploy/cloudflare/src/__tests__/nostr-anchor-door.test.mjs` | Test present. Current result unverified. | IMPLEMENTED |
| Independent-node action exchange | Unverified | Unverified | Unbuilt. | DIRECTION |
| Local HTTP status in the earlier run | `server/local-host.mjs`, `mirror/home/balls/HEAD.json` | HTTP observation in the [record of an earlier tree](RUN-RECORD.md#L46) | With the local session, /_head/status returned the selected ball ID and epoch 1. The authors recorded no browser run. | RECORDED RUN (of an earlier tree) |
| Fresh-account cloud deployment | `server/cloudflare-bootstrap-cli.mjs`, `server/deploy-cloudflare.mjs` | `server/cloudflare-bootstrap.test.mjs` | Unverified. | UNVERIFIED |
| Deployed owner-approved module change | Unverified | Unverified | Unverified. | UNVERIFIED |
| Outside reports | `claims.json` | See each report’s command | Four unsigned reports identify commit `80e392d1`, the parent of public commit `7976cdfc`. One Linux report used a modified copy. The ledger marks the measured Linux variant `fixed in this commit` and the other three runs `reported`. The label at right applies only to a repeat on this candidate. | UNVERIFIED |

Continuity Diamond is an IDEA: a specification is being designed; nothing is built. See [Direction](DIRECTION.md).

## Running selected checks

Use a Git checkout or set `DSH_CLIENT_COMMIT_HASH` to the source commit for an archive build ([scripts/client-build-environment.ts:53](../scripts/client-build-environment.ts#L53)). Set `AUKORA_PREVIEW_PORT` to the same unused local port in both terminals.

Node 24.9.0 or newer and pnpm 11.28.5. See `package.json`. Commands in the [record of an earlier tree](RUN-RECORD.md) identify the historical suites and build prerequisites.

```text
pnpm install --frozen-lockfile
PORT="${AUKORA_PREVIEW_PORT:?set AUKORA_PREVIEW_PORT to an unused local port}" node server/build-preview.mjs
# Run the local host in a separate terminal (see below).
node --test server/*.test.mjs deploy/ci/*.test.mjs deploy/cloudflare/src/__tests__/*.test.mjs
node --test deploy/cloudflare/src/__tests__/worker.spec.ts
pnpm exec vitest run packages/client/ui-layout/tests scripts/spatial-catalogue.spec.ts
pnpm exec vitest run packages/experimental/webworker-runtime/tests
node server/cloudflare-bootstrap-cli.mjs --dry-run
```

The Node glob includes the Vitest-importing voice-provider-limits file ([deploy/cloudflare/src/__tests__/voice-provider-limits.test.mjs:1](../deploy/cloudflare/src/__tests__/voice-provider-limits.test.mjs#L1)). The root Vitest project list selects other paths ([vitest.config.ts:138](../vitest.config.ts#L138), [vitest.config.ts:245](../vitest.config.ts#L245)).

- Preview host: `server/build-preview.mjs` contacts 127.0.0.1 on the configured port, default 4610 ([server/build-preview.mjs:43](../server/build-preview.mjs#L43), [server/build-preview.mjs:45](../server/build-preview.mjs#L45)). Start the local host in a separate terminal with `PORT="${AUKORA_PREVIEW_PORT:?set AUKORA_PREVIEW_PORT}" pnpm run x6:start`.
- Deployment files: `server/seed-cloudflare.mjs`, `server/cloudflare-bootstrap-cli.mjs`, `deploy/cloudflare/src/cloud-brokers.mjs` and `deploy/ci/`. Some code comments cite a planning document that is not in this tree.
- The launcher first validates the target, including the fixed Worker name `your-node`. With valid settings it prints a plan by default. With `--deploy` it uses `gh` to look for two credential names in the production environment of your_org_x/your-node. It requires `--emergency` when the lookup returns `configured` or `unknown`. A successful listing missing the production environment or a required name yields `not-configured` ([deploy-cloudflare.mjs:24](../server/deploy-cloudflare.mjs#L24), [deploy-cloudflare.mjs:49](../server/deploy-cloudflare.mjs#L49), [deploy-cloudflare.mjs:100](../server/deploy-cloudflare.mjs#L100)).

The component notice states, “The authors own pentora36.wasm and ship it without source and without a separate licence.” See the separate notice at `apps/web/public/seed-library/pentora/LICENSE.binaries`.

This repository ships no Chinese translations of its documents. The application retains its Chinese interface strings.
