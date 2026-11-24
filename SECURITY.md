# Security

The authors report that Aukora has had no security audit. Deployment assurance remains unverified. See [SAFETY.md](SAFETY.md).

## How to report

Use private vulnerability reporting in the repository’s Security tab if available. Otherwise open a public issue requesting private contact and withhold the details until a maintainer responds. Include the tested revision, file and line, prerequisites, command and observed result. Test against your own node and omit private data.

A response time and a reward are unspecified.

## Source index

| Area | Start here |
| --- | --- |
| Approval binding and single use | `deploy/cloudflare/src/aumlok.mjs` (`aumlokClass3Binding`), `deploy/cloudflare/src/owner-grant-policy.mjs` (`headPromotionBinding`), `deploy/cloudflare/src/head-do.mjs` (`publish`, `stage`) |
| What counts as a failed proof, lockout | `deploy/cloudflare/src/proof-failure-rule.mjs`, `deploy/cloudflare/src/webauthn-screen.mjs`, `deploy/cloudflare/src/gate-lockout.mjs` |
| Which changes need the passkey | `server/ball-transition.mjs` (`T2_ONLY_ORGANS`, `classifyTransition`), `deploy/cloudflare/src/owner-grant-policy.mjs` (`classifyHeadTransition`), `deploy/cloudflare/src/night-grant.mjs`, `deploy/cloudflare/src/organ-set-rule.mjs` |
| Devices, the seven words, the sealed root | `deploy/cloudflare/src/passkey-devices.mjs`, `packages/client/ui-layout/src/client/spatial/aumlok/aumlok-ceremony.ts`, `packages/client/ui-layout/src/client/spatial/aumlok/aumlok-root.ts` |
| Recovery, replay and rollback | `deploy/cloudflare/src/recovery-restore.mjs`, `deploy/cloudflare/src/rescue-kit.mjs`, `deploy/cloudflare/src/vault.mjs`, `deploy/cloudflare/src/cold-archive.mjs` |
| Candidate code and sealed cells | `packages/experimental/webworker-runtime/src/x6/scion.ts`, `packages/experimental/webworker-runtime/src/x6/scion-growth.ts`, `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`, `mirror/home/auma/seed/organs/seed-pearl.js` |
| Edge requests and outward actions | `deploy/cloudflare/src/worker.mjs`, `deploy/cloudflare/src/cloud-brokers.mjs`, `deploy/cloudflare/src/provider-dispatch.mjs`, `deploy/cloudflare/src/public-https-transport.mjs` |
| Deploy gates and credentials | `deploy/ci/`, `.github/workflows/` |

## Recovery and checkpoint evidence

- The browser checks the captured parts against the lengths and SHA-256 values in the Continuity snapshot (`aukora.recovery-snapshot.v1`) and checks its manifest digest. Trust in the snapshot’s origin is separate. After owner confirmation, the restore page can seed an empty edge or resume a matching partial seed. On an initialized edge, the [Estate card](packages/client/ui-layout/src/client/spatial/portal/recovery-restore.ts#L269) compares the snapshot with the current head, receipt and checkpoint state, and mirror digest. See the [snapshot checks](deploy/cloudflare/src/recovery-restore.mjs#L147), [target comparison](deploy/cloudflare/src/recovery-restore.mjs#L341) and [confirmation handler](deploy/cloudflare/src/recovery-restore.mjs#L469).
- Browser rescue download (`x61-rescue-pack/v1`), local verifier at [server/rescue-verify.mjs:71](server/rescue-verify.mjs#L71).
- Recovery on deployed infrastructure is unverified.

MIRROR supplies its optional checkpoint signer pin or policy to the verifier. See [deploy/cloudflare/src/mirror-do.mjs:1838](deploy/cloudflare/src/mirror-do.mjs#L1838) and [server/verified-facts.mjs:382](server/verified-facts.mjs#L382).

The requesting page displays the repository proposal terms ([RepoProposalCell.tsx:325](packages/client/ui-layout/src/client/spatial/portal/RepoProposalCell.tsx#L325)). An independent approval display is unbuilt in this export. The [aumlok-restore-rehearsal.test.mjs:197](deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs#L197) fixtures expect a previously spent or expired approval to become usable again under the tested rollback conditions. Rollback resistance on a deployed node is unverified.

## Evidence index

- Edge deployment, access, verification and screening notes in `deploy/cloudflare/README.md` at lines 43, 67, 79, 97, 133, 135, 141, 145 and 161.
- Architecture evidence in `docs/ARCHITECTURE-ACTUAL.md` at lines 21 and 43.
- See the [local store’s epoch rule](docs/START-HERE.md#L41) and the [local host’s publication check](server/local-host.mjs#L129). The [record of an earlier tree](docs/RUN-RECORD.md#L46) contains the authors’ HTTP observations.
- Historical failure counts in [the failure list](docs/KNOWN-RED-TESTS.md).

This repository ships no Chinese translations of its documents. The application retains its Chinese interface strings.
