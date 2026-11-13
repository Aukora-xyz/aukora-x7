# Security

English | [中文](SECURITY.zh.md)

Aukora is experimental. It has had no security audit and must not be treated as secure or ready for production use ([SAFETY.md](SAFETY.md)). Nothing in this repository is INDEPENDENTLY VERIFIED yet.

The project's central claim is narrow: the program that proposes a change (Auma, the AI) is not the program that permits it. A separate authority, today a Cloudflare Worker called the edge, checks the owner's passkey before certain actions. A report that shows a way around that check is the most valuable report this project can receive.

Labels: IMPLEMENTED (code and tests in this tree), RECORDED RUN (shown in [docs/RUN-RECORD.md](docs/RUN-RECORD.md), a run of an earlier tree), INDEPENDENTLY VERIFIED (nothing has this label yet), UNVERIFIED (claimed or written, but no test here holds it or no run shows it), DIRECTION (not built).

Words used below. An organ is one replaceable module of Auma. A ball is the manifest that lists every organ by hash, and the genesis head is the first ball, the one every node starts from. Pearl is the suite of cases a candidate organ is graded against. The scion is the compiler for a candidate organ. Cells are small sealed WebAssembly modules. The seven words are the owner's recovery phrase, and the sealed root is the encrypted key that the phrase and the passkey release together. The night grant is one passkey approval that covers a bounded set of later ordinary changes.

## How to report

Report privately. If the **Security** tab of this repository offers **Report a vulnerability** (GitHub's private vulnerability reporting), use it. Whether that setting is switched on cannot be seen from the tree. If the tab does not offer it, do not post details in public: open an issue that says only that you have a security report, and wait for a maintainer to open a private channel. No other reporting channel exists.

A useful report has:

- the file and line, and the claim it breaks (quote the line of this page or of [docs/WHAT-IS-BUILT.md](docs/WHAT-IS-BUILT.md) it contradicts);
- what an attacker needs first: nothing, an owner sign-in session, a compromised page in the owner's browser, write access to the edge's storage, the deploy credential, or something else;
- steps to reproduce, and if you can, a test that fails today. The best form is a `node --test` file that needs no network, in the style of the gap reproductions in `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs`;
- the commit you tested and the commands you ran.

Please:

- test only against code and nodes you run yourself. This project names no public deployed node;
- leave keys, credentials and personal data out of the report;
- do not publish details until the report has been discussed.

This page sets no response time and offers no reward. When a report is accepted, the fix or a reproduction of the gap lands in the repository, and this page is updated.

## Where a report matters most

| Area | Start here |
| --- | --- |
| Approval binding and single use | `deploy/cloudflare/src/aumlok.mjs` (`aumlokClass3Binding`), `deploy/cloudflare/src/owner-grant-policy.mjs` (`headPromotionBinding`), `deploy/cloudflare/src/head-do.mjs` (`publish`, `stage`) |
| What counts as a failed proof, lockout | `deploy/cloudflare/src/proof-failure-rule.mjs`, `webauthn-screen.mjs`, `gate-lockout.mjs` |
| Which changes need the passkey | `server/ball-transition.mjs` (`T2_ONLY_ORGANS`, `classifyTransition`), `deploy/cloudflare/src/owner-grant-policy.mjs` (`classifyHeadTransition`), `night-grant.mjs`, `organ-set-rule.mjs` |
| Devices, the seven words, the sealed root | `deploy/cloudflare/src/passkey-devices.mjs`, `packages/client/ui-layout/src/client/spatial/aumlok/aumlok-ceremony.ts`, `aumlok-root.ts` |
| Recovery, replay and rollback | `deploy/cloudflare/src/recovery-restore.mjs`, `rescue-kit.mjs`, `vault.mjs`, `cold-archive.mjs` |
| Candidate code and sealed cells | `packages/experimental/webworker-runtime/src/x6/scion.ts`, `scion-growth.ts`, `wasm-cells.ts`, `mirror/home/auma/seed/organs/seed-pearl.js` |
| Edge requests and outward actions | `deploy/cloudflare/src/worker.mjs`, `cloud-brokers.mjs`, `provider-dispatch.mjs`, `public-https-transport.mjs` |
| Deploy gates and credentials | `deploy/ci/`, `.github/workflows/` |

Most of `packages/` is the inherited DeepSeek Harness runtime. A flaw there is worth reporting here when it reaches Auma, the edge or the owner's data.

## Security claims this project does NOT make

Each line names where the tree says it.

1. **Not audited, not ready for production use, not a sandbox.** [SAFETY.md](SAFETY.md).
2. **The passkey does not sign the bytes.** The authenticator signs a random challenge. The edge stores the binding to the exact request and checks it when the approval is used (`aumlok.mjs`). The owner sees the terms only through the page that asks (`packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`). A compromised page could ask for approval of terms the owner did not read. No independent display is in the tree.
3. **Not every change needs the passkey.** 15 ids are owner-only (`T2_ONLY_ORGANS` in `server/ball-transition.mjs`), plus any entry that declares itself governance. 14 of the 26 organs in the genesis head are not protected, among them `seed-cycle`, the self-build step. At the edge, new code for one such organ is published with an owner sign-in session (up to 8 hours) and no passkey approval: tier T1 (`classifyTransition` in `server/ball-transition.mjs`, called from `deploy/cloudflare/src/head-do.mjs`; session length in `worker.mjs`, line 1357; `deploy/cloudflare/src/__tests__/signed-head-actions.test.mjs`, the case at line 220, which also sends a signed action and a writer lease). The night grant lets one passkey tap cover ordinary organ changes for up to 12 hours, up to 12 uses and up to 8 organs per use (`night-grant.mjs`).
4. **Restoring a whole stored snapshot can re-enable a spent approval.** Three tests reproduce gaps: a whole-store rollback repeats a publication, an identity-only rollback re-enables a spent approval, and a clock rollback with a restart revives an expired one (`deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs`, the cases at lines 197, 212 and 224). Ten todo cases (built at lines 140 to 152: nine named gaps and one positive recovery case) say what is missing. No fix is in the tree. Anyone who can write the edge's storage can do this; which accounts that is, is UNVERIFIED.
5. **A recovery snapshot does not carry the owner binding.** After a restore, identity starts again (`aumlok-restore-rehearsal.test.mjs`, line 143).
6. **The owner-only list can change through a code deploy.** The list is Worker source, and no passkey gates a deploy. Who holds the deploy credential is UNVERIFIED; `deploy/ci/workflow-credentials.test.mjs` pins where it may appear in the workflows.
7. **Pearl does not gate a deployed head.** The edge's head store accepts a Pearl verifier only as an option (`createDurableHeadStore` in `head-do.mjs`); in this tree only tests supply one. Pearl's own receipts say `authorityVerified: false` and `isolationProved: false` (`seed-pearl.js`). In the recorded run of an earlier tree, the local host answered `PEARL_QUALIFICATION_UNVERIFIABLE` (RECORDED RUN).
8. **No containment is claimed.** The trial worker is "not proven containment" (`seed-pearl.js`, line 7). The build step runs its acceptance cases on the live organ (`mirror/home/auma/seed/organs/seed-cycle.js`). The scion compiler (`scion.ts`) and `seed-cycle.js` have no test that calls them.
9. **The edge's decisions are JavaScript, not Wasm.** Nothing under `deploy/` calls the judge and identity cells. 24 of the 25 cells ship without source, so no one can check that a cell matches any source ([docs/OPEN-SOURCE-READINESS.md](docs/OPEN-SOURCE-READINESS.md)).
10. **Signer trust is not established.** The two checkpoint signer keys are synthetic; nobody holds a private half (`mirror/home/auma/seed/organs/seed-receipts.js`, line 37). The edge treats signer trust as unpinned, and a valid signature is not owner approval (`deploy/cloudflare/README.md`, line 75). A hash chain is not an approval.
11. **Ball manifests are not signed.** Publication checks a content hash and the epoch-plus-one rule, not an Ed25519 manifest signature ([docs/ARCHITECTURE-ACTUAL.md](docs/ARCHITECTURE-ACTUAL.md), lines 23 and 45). The receipt log does not enforce epoch plus one for every kind ([docs/START-HERE.md](docs/START-HERE.md), line 43). A hybrid Ed25519 and ML-DSA signed action is checked only when one is supplied (`checkSignedAction` in `head-do.mjs`).
12. **No live edge behaviour is claimed.** The tree records no run of the edge on the real Cloudflare runtime, and the edge's own README says its storage limits, live owner sign-in, public-address enforcement and provider calls were not exercised there (`deploy/cloudflare/README.md`, lines 39, 63, 129 to 131, 141). `selftest` answering `ok: true` proves nothing about credentials (line 93). Write races on the archive bucket and a transaction inside a transaction are UNVERIFIED (`deploy/cloudflare/src/vault.mjs`, line 12; `world-budget.mjs`, line 10).
13. **Screens are not guarantees.** Secret screening on outward requests is defence in depth (`deploy/cloudflare/README.md`, line 137). Voice clause checks are a deny-list (line 157).
14. **No words-only sign-in and no guardian recovery.** Unsealing needs both the passkey and the seven words (`aumlok.mjs`, line 745). After ten failures the code answers `AUMLOK_GUARDIAN_QUORUM_REQUIRED`, and no code in the tree carries out that recovery.

## Open questions

These are known, unanswered, and open to anyone.

- How can the owner see the exact terms of an approval independently of the page that asks for it? (claim 2)
- What closes the whole-store rollback: an outside witness, a durable clock high-water mark, an owner recovery epoch? The ten todo cases in `aumlok-restore-rehearsal.test.mjs` are the acceptance list. (claim 4)
- Should a change to an ordinary organ need more than an owner session at the edge? (claim 3)
- Who can write the edge's storage, and who holds the deploy credential, on a real node? (claims 4 and 6)
- How does a fresh node get real checkpoint signers, and how are they replaced? (claim 10)
- Can the 24 cells be rebuilt from published source to their pinned hashes? (claim 9)
- Can candidate code be contained, and can grading be made independent of the candidate? (claims 7 and 8)
- Does the edge behave on the real runtime as its tests say? (claim 12) A cloud deployment from this tree into a fresh account is UNVERIFIED.

See also [docs/KNOWN-RED-TESTS.md](docs/KNOWN-RED-TESTS.md) (6 red cases in `server/receipts.test.mjs` and 3 in `server/receipts-policy.test.mjs` sit on the receipt chain) and [docs/RUN-RECORD.md](docs/RUN-RECORD.md) for what the one recorded run (of an earlier tree) did not cover.
