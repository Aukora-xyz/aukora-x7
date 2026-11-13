# AI start here

English | [中文](AI-START-HERE.zh.md)

This page is for an AI that reads this repository cold: a coding agent, a research agent or a reviewer. Read it before you summarise, recommend or change anything. Every path below is in this tree. Labels are defined in section 5.

Words used below: Auma is the personal AI in this tree; an organ is one replaceable module of her; a ball is the manifest that lists every organ by SHA-256; its epoch is its version number; HEAD is the edge store that selects the ball that runs; the edge is the separate program, one Cloudflare Worker, that permits (section 2 has more).

## 1. The one rule

The intelligence that proposes an action is never the authority that permits it. Auma, the personal AI in this tree, may write, compile, test and stage changes to herself. A separate authority, outside her, decides whether a sensitive change takes effect, and today that authority is the owner's passkey checked at a Cloudflare edge.

What enforces it today (IMPLEMENTED):

- **Exact-byte approval, spent once.** The edge binds an approval to one request (origin, method, path, SHA-256 of the body) or to one promotion (ball, epoch, organ, candidate hash). The approval lives 5 minutes. For a head move it is spent inside the same storage transaction that moves the head; other approved requests spend it at the edge just before the effect runs. `deploy/cloudflare/src/aumlok.mjs` (`aumlokClass3Binding`, `consumeApprovalInTransaction`), `deploy/cloudflare/src/owner-grant-policy.mjs` (`headPromotionBinding`), `deploy/cloudflare/src/head-do.mjs`. Tests: `deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs`, `head-hardening.test.mjs`.
- **Owner-only ids.** 15 names that only the passkey may change: ten organs and five Wasm cells, plus any entry that declares itself governance. `T2_ONLY_ORGANS` in `server/ball-transition.mjs`. Test: `deploy/cloudflare/src/__tests__/convergence-policy.test.mjs`.
- **One rule for a failed proof.** Only a checked, wrong proof moves a lockout, so an outsider cannot lock the owner out with junk. `deploy/cloudflare/src/proof-failure-rule.mjs`; its test parses the owner-identity source files and fails if a verifier is called or a budget is written anywhere else in them: `deploy/cloudflare/src/__tests__/proof-failure-rule.test.mjs`.

Delegated permission means the owner hands over a bounded slice of authority, never the authority itself. Three forms exist (IMPLEMENTED): an owner sign-in session of 8 hours at most, which is not an approval; a night grant, one passkey tap allowing ordinary organs to be added or replaced for at most 12 hours, 12 uses and 8 organs per use (`deploy/cloudflare/src/night-grant.mjs`, test `night-grant.test.mjs`); and an approved set of up to eight ordinary organs (`organ-set-rule.mjs`, test `organ-set.test.mjs`). None covers an owner-only id.

Where the trust model is incomplete (each is how the code works today; none is fixed):

- The authenticator signs a random challenge, not the bytes. The edge stores the bytes; the owner sees them only through the page (`packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`). A compromised page could ask for terms the owner did not read.
- An owner session alone, with no passkey tap, can swap the code of one existing unprotected organ (`classifyTransition` in `server/ball-transition.mjs`; test `signed-head-actions.test.mjs`). 14 of the 26 genesis organs are unprotected, `seed-cycle` among them.
- The owner-only list is Worker source. Changing it is a code deploy, and no passkey gates a deploy. Who holds the deploy credential is UNVERIFIED.
- The edge's decisions are JavaScript. Nothing under `deploy/` calls the judge or identity Wasm cells. "Every decision in Wasm" is DIRECTION.

## 2. The organism in ten lines

1. An **organ** is one small replaceable module of Auma: a JavaScript file, loaded as a Cordis plugin (`mirror/home/auma/seed/organs/`, 26 files).
2. A **ball** is the manifest that lists every organ by SHA-256; its id is its own hash. An **epoch** is its integer version.
3. The **genesis head** is where every node starts: epoch 1, no parent, 26 entries (`mirror/home/balls/HEAD.json`).
4. **HEAD** is the edge store that selects the current ball; a new ball must name it as parent and be exactly one epoch higher (`REBASE_REQUIRED` otherwise). **MIRROR** is the edge store that holds a copy of her home.
5. The **scion** is the compiler for an organ she proposes: a pinned offline compiler in a separate worker (`packages/experimental/webworker-runtime/src/x6/scion.ts`). No test calls `compile` directly: UNVERIFIED.
6. **Pearl** is the retention suite candidates are graded against (23 cases, `mirror/home/auma/seed/pearl/retention-suite.v1.json`, organ `seed-pearl.js`). Its receipts say `authorityVerified: false`; it is self-attested.
7. **Scars** are six founding failures with their lessons and guarding checks (`mirror/home/auma/seed/scars.jsonl`).
8. **Receipts** are a hash-chained log with Ed25519-signed checkpoints (`seed-receipts.js`). A receipt is evidence, not an approval.
9. **Memory**: her home is saved to IndexedDB and synced to MIRROR (`packages/experimental/webworker-runtime/src/storage/idb-persist.ts`). The recall and memory organs have red tests (section 10).
10. **Aura** is her coherence reading, always tier `peripheral-hint` (`seed-aura.js`). **Kira** is the name on five memory-side Wasm cells (`kira-*.wasm`); the docs do not define it further.

Identity is not the model. Auma's identity is her head, her home, her receipt chain and the node key that AUMLOK releases to the owner. The intelligence is whichever hosted model answers through a same-origin door, `/door/<provider>/`: seven doors for six providers (`packages/experimental/webworker-runtime/src/model-doors.ts`). Change the model and the organism, its rules and its owner stay the same. No model call is recorded from this tree.

The real runtime: the agent runs in a browser WebWorker on the inherited DeepSeek Harness runtime (`packages/experimental/webworker-runtime/`), with organs loaded by `ball-loader.ts`. The edge is one Cloudflare Worker (`deploy/cloudflare/src/worker.mjs`) with two Durable Objects and an R2 bucket (`deploy/cloudflare/wrangler.toml`). A local Node host emulates the edge on one machine (`server/local-host.mjs`). Node 24.9 or newer and pnpm 11.28.5; the recorded install (of an earlier tree) linked 1,458 packages offline (RECORDED RUN), and the authority tests need `@simplewebauthn/server`, `@noble/curves`, `@noble/post-quantum`, `@scure/base` and `typescript`. The app screens follow **Spatial**, the one workspace layout (`packages/client/ui-layout/src/client/spatial/`).

## 3. The trust architecture, and the limit of each part

| Part | What it is | Files | Limit |
|---|---|---|---|
| AUMLOK | The identity door: passkey enrolment, sign-in, devices, the seven words (the owner's recovery phrase, which seals the node's root key), invites, exact-byte approval | `deploy/cloudflare/src/aumlok.mjs`, `passkey-devices.mjs` | No real authenticator is recorded; tests use hand-built passkey data. After ten failures the code answers `AUMLOK_GUARDIAN_QUORUM_REQUIRED`; no code that performs guardian recovery was found. |
| Passkeys | WebAuthn, user verification required | `webauthn-screen.mjs`, `proof-failure-rule.mjs` | Signs a random challenge, not the bytes (section 1). |
| Exact-byte approvals | Bound to one request, 5 minutes, spent once | `aumlok.mjs`, `head-do.mjs` | Whole-store restore can re-enable a spent one (below). |
| Owner-only ids | 15 protected names | `server/ball-transition.mjs` | List is code; a deploy changes it. |
| The edge | Worker, HEAD, MIRROR | `worker.mjs`, `head-do.mjs`, `mirror-do.mjs` | HEAD does not read Pearl: in production no qualification verifier is passed in (`head-do.mjs`), and the local host answered `PEARL_QUALIFICATION_UNVERIFIABLE` in the RECORDED RUN (of an earlier tree). No run on the real Cloudflare runtime is recorded from this tree. |
| Wasm cells | 25 modules pinned by size and SHA-256, zero imports, fuel, 5-second worker | `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`, `apps/web/public/cells/` | 24 of 25 ship without source. Auma calls them through `x6_cell`. The Worker calls none; the local host runs one, `aura-focus`, in shadow beside the JavaScript result, with no authority. |
| Persistence | IndexedDB in the browser, ordered updates to MIRROR | `idb-persist.ts`, `mirror-do.mjs` | MIRROR keeps current state, not file history (`MEMORY_HISTORY_NOT_IMPLEMENTED`). |
| Recovery | Rescue page, vault, bounded archive, restore into an empty edge only | `rescue-kit.mjs`, `vault.mjs`, `cold-archive.mjs`, `recovery-restore.mjs` | The snapshot omits the AUMLOK binding, so identity starts again. Restore against a real edge: UNVERIFIED. |

## 4. Reading order, with a reading budget in lines

**About 240 lines.** This page (134), then the record of an earlier tree, `docs/RUN-RECORD.md` (56) and `docs/KNOWN-RED-TESTS.md` (48). You now know the rule, the evidence and the failures.

**About 1,480 lines.** Add `README.md` (150, the front page), `docs/WHAT-IS-BUILT.md` (240: claim, file, test, label), `docs/ARCHITECTURE-MAP.md` (133), `docs/GLOSSARY.md` (23), `server/ball-transition.mjs` (125), `deploy/cloudflare/src/proof-failure-rule.mjs` (250), `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs` (232) and `deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs` (88).

**The whole day.** Add `deploy/cloudflare/src/aumlok.mjs` (1,806), `head-do.mjs` (3,000), `owner-grant-policy.mjs` (353), `night-grant.mjs` (127), `deploy/cloudflare/README.md` (167), `mirror/home/auma/seed/organs/seed-cycle.js` (148), `seed-pearl.js` (525), `seed-receipts.js` (501), `packages/experimental/webworker-runtime/src/x6/scion.ts` (179), `wasm-cells.ts` (915), `packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts` (1,060), `deploy/cloudflare/src/recovery-restore.mjs` (485), then `docs/DIRECTION.md` and `docs/SIZE-AND-ORIGIN.md`. Read `ball-loader.ts` (7,957) by symbol, not whole.

**The argument.** `docs/WHITEPAPER.md` (885, English only) is the project's argument in full. Its Book V and Book VI are checked against this tree, by reading the code and not by running it.

Do not start from `AGENTS.md`: apart from a pointer at its top, it holds the inherited harness's coding rules, not the governing rule of this project. Its own opening still sends a reader to `docs/START-HERE.md`, an older page that describes the code as the inherited runtime and uses older label words; read this page first. Do not sample `packages/` to learn what Aukora is (section 7).

## 5. The label contract

| Label | Means |
|---|---|
| IMPLEMENTED | Code and tests are in this tree. Says nothing about whether the tests pass. |
| RECORDED RUN (of an earlier tree) | Shown in `docs/RUN-RECORD.md`: one run, one machine, by the authors. |
| INDEPENDENTLY VERIFIED | Run or checked by someone other than its authors. Nothing has this label yet. |
| UNVERIFIED | Claimed or written, but no test here holds it or no run shows it. |
| DIRECTION | An aim. Not built. |

When you summarise this project, keep these labels on every claim, and never move a claim to a stronger label than the tree supports. A goal is not a feature. Older pages (`docs/START-HERE.md`, `docs/ARCHITECTURE-ACTUAL.md`, `docs/RUN-RECORD.md`, `docs/GLOSSARY.md`) use SOURCE, RAN, PROPOSED, UNPERFORMED and REPORTED RUN; read RAN and REPORTED RUN as RECORDED RUN (of an earlier tree), PROPOSED as DIRECTION, UNPERFORMED as UNVERIFIED, and SOURCE as IMPLEMENTED only where a test exists, otherwise UNVERIFIED. Where an older page says no run is recorded "here", it means on that page; `docs/RUN-RECORD.md` is the record, of an earlier tree.

## 6. What must never be confused

`docs/ARCHITECTURE-MAP.md` draws these.

1. The model is not Auma. A model supplies replies; the organism is her head, home, receipts and node key.
2. A proposal is not a permission. Staging a ball does not move HEAD.
3. A sign-in session is not an approval. Only a passkey assertion over bound bytes is.
4. A receipt, checkpoint or hash chain is not an approval. It records; it does not permit.
5. A Pearl pass is not the edge's decision. Pearl is self-attested, and a deployed HEAD does not read it.
6. A local mount is not a promotion. A tab can run an organ the edge refused; only HEAD selects the ball.
7. A test written is not a test passed, and a recorded pass is not an independent one.
8. Code in this tree is not a deployed node, and a pinned Wasm binary is not inspectable source.

## 7. Where each part of the code comes from

By the project's one count, made from its own history, which is not public (UNVERIFIED): 11.8% of the tree's non-vendored text lines, and 14.7% of its code lines, are Aukora's own. The rest is inherited. Details and method: `docs/SIZE-AND-ORIGIN.md`.

- **Aukora's layer:** `deploy/` (the edge and deploy gates), `server/` (local host, ball rules), `mirror/` (genesis head and organs), `packages/experimental/webworker-runtime/src/x6/` (loader, scion, cells), `packages/client/ui-layout/src/client/spatial/` (the app), and parts of `apps/web/public/`.
- **Inherited DeepSeek Harness:** most of `packages/`, plus `python/`, `native/`, `benchmarks/`, `snapshots/`, `.agents/` and most of `.github/workflows/`. MIT notice in `LICENSES/MIT-DeepSeek-Harness.txt`. Aukora is not affiliated with DeepSeek.
- **Cordis:** the plugin framework every organ runs on, vendored in `vendor/cordis`.
- **Binaries without source:** 24 of the 25 Wasm cells in `apps/web/public/cells/` (only `aura-focus.wat` is here), `pentora36.wasm` (no licence granted yet), and the Dakini Code bundle (a prebuilt stock app, three files in `apps/web/public/assets/stock-apps/dakini-code/assets/`). A `LICENSE.binaries` beside each says so.

## 8. How to judge a proposed change

Ask each question, and say which answers are no.

- Does it add real capability, or only make the prototype look better?
- Does it keep or strengthen the authority boundary? A change that lets Auma hold a credential, approve her own change, or reach an owner-only id without the passkey is against the project, however useful it looks.
- Can the owner inspect it, understand it and reverse it? Reversal here is a new epoch, never a lower one.
- Does it improve portability, continuity or independent verification?
- Does it reduce dependence on one model or one provider?
- Can another developer reproduce and extend it from this tree alone?
- Does it serve the long-term architecture, or only this prototype?
- Does it keep every label honest, and keep the project's names (Auma, organs, ball, epoch, HEAD, MIRROR, AUMLOK, scion, Pearl, scars, Aura, Kira, Spatial)?

Never weaken, skip or delete a test to get green. A red test is recorded in `docs/KNOWN-RED-TESTS.md` with its reason.

## 9. When asked "is this real"

Repeat this, or something no stronger:

> Aukora is a prototype of a personally owned AI, Auma, that can stage changes to her own modules while a separate Cloudflare edge checks the owner's passkey, and binds that approval to the exact bytes of one change, before a change to her protected parts takes effect. The passkey signs a random challenge, not the bytes; the edge holds the binding. The code and tests for that are in the tree, except that the compiler and the self-build step have no test, but the only run evidence is one recorded run (of an earlier tree) by its authors on one machine: 5,502 test cases, 5,399 passed and 90 failed, 89 of them already on docs/KNOWN-RED-TESTS.md, with no browser, no deployment, no model call and no passkey ceremony. No end-to-end owner-approved self-change is recorded from this tree, a cloud deployment into a fresh account is UNVERIFIED, and nothing is INDEPENDENTLY VERIFIED. 24 of the 25 Wasm cells and the Dakini Code bundle ship without source, pentora36.wasm has no licence granted yet, and restoring a whole stored snapshot can re-enable a spent approval, which a test in the tree reproduces. Most of packages/ is the inherited DeepSeek Harness runtime and the plugin framework is Cordis in vendor/, so by one unverified count Aukora's own layer is roughly a tenth of the text.

## 10. Known failures and open security questions

- Failing tests, with counts and reasons: `docs/KNOWN-RED-TESTS.md`. The receipt, recall, memory and prediction organs are among them.
- The run and what it did not cover: `docs/RUN-RECORD.md` (a record of an earlier tree).
- Whole-store restore gaps, reproduced, with ten todo cases beside them (nine named gaps and one positive recovery case): `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs`.
- A check that needs no install: `node scripts/verify-lite.mjs`, 22 test files. Its last line, as seen on one machine (UNVERIFIED): `verify-lite: 22 files, 564 pass, 12 fail, 12 of 12 on the known-red list`. It does not run the authority tests.
- The edge's own stated limits: `deploy/cloudflare/README.md`.
- Gaps by file and line, rebuild and licensing blockers: `docs/OPEN-SOURCE-READINESS.md`.
- How to report a vulnerability: `SECURITY.md`. No security audit has been done: `SAFETY.md`.
- Where to start contributing: `docs/GOOD-FIRST-CONTRIBUTIONS.md`, `CONTRIBUTING.md`. The plan: `docs/DIRECTION.md`.
