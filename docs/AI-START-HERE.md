# AI start here

You came from `README.md`, which showed what Auma can do and how far each part is proven. This page adds what an AI needs before it summarises, recommends or changes anything: the rule and what enforces it, where trust stops, the labels (section 5), and one check you run yourself (section 11). Every path below is in this tree.

Words used below: Auma is the personal AI in this tree; an organ is one replaceable module of her; a ball is the manifest that lists every organ by SHA-256; its epoch is its version number; HEAD is the edge store that selects the ball that runs; the edge is the separate program, a Cloudflare Worker with four Durable Objects, that permits (section 2 has more).

## 1. The one rule

The intelligence that proposes an action is never the authority that permits it. Auma, the personal AI in this tree, may write, compile, test and stage changes to herself. A separate authority, outside her, decides whether a sensitive change takes effect, and that authority is the owner's passkey approval, which a Cloudflare edge checks and binds to the exact bytes of the change. Her doors to Cloudflare and Linear run at level `open`, where only a dangerous core of their writes waits for the passkey (`CLOUDFLARE_DOOR_LEVEL` and `LINEAR_DOOR_LEVEL` in `deploy/cloudflare/wrangler.toml`, which holds the shipped edge settings; her repository door's default, `REPO_DOOR_LEVEL`, is in `deploy/ci/frozen-paths.mjs`).

What enforces it (IMPLEMENTED):

- **Exact-byte approval, spent once.** The edge binds an approval to one request (origin, method, path, SHA-256 of the body) or to one promotion (ball, epoch, organ, candidate hash). The approval lives 5 minutes. For a head move it is spent inside the same storage transaction that moves the head; other approved requests spend it at the edge just before the effect runs. `deploy/cloudflare/src/aumlok.mjs` (`aumlokClass3Binding`, `consumeApprovalInTransaction`), `deploy/cloudflare/src/owner-grant-policy.mjs` (`headPromotionBinding`), `deploy/cloudflare/src/head-do.mjs`. Tests: `deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs`, `head-hardening.test.mjs`.
- **Owner-only ids.** 16 names that only the passkey may change: ten organs of the genesis, five Wasm cells and one organ (`auma-kernel`) this tree does not ship, plus any entry that declares itself governance. `T2_ONLY_ORGANS` in `server/ball-transition.mjs`. Test: `deploy/cloudflare/src/__tests__/convergence-policy.test.mjs`.
- **One rule for a failed proof.** Only a checked, wrong proof moves a lockout, so an outsider cannot lock the owner out with junk. `deploy/cloudflare/src/proof-failure-rule.mjs`; its test parses the owner-identity source files and fails if a verifier is called or a budget is written anywhere else in them: `deploy/cloudflare/src/__tests__/proof-failure-rule.test.mjs`.

Delegated permission means the owner hands over a bounded slice of authority, never the authority itself. Four forms exist (IMPLEMENTED): an owner sign-in session of 8 hours at most, which is not an approval; a night grant, one passkey tap allowing ordinary organs to be added or replaced for at most 12 hours, 12 uses and 8 organs per use (`deploy/cloudflare/src/night-grant.mjs`, test `night-grant.test.mjs`); an approved set of up to eight ordinary organs (`organ-set-rule.mjs`, test `organ-set.test.mjs`); and the owner's Away mandate, one passkey tap on exact terms that lets her do a closed list of reversible things with no tab open, a bounded number of times a day, for at most 30 days (`deploy/cloudflare/src/owner-mandate.mjs`, test `owner-mandate.test.mjs`). The mandate can never express a merge, a deploy, keys, deletes or a head promotion, and a wake spends it only while `WAKE_ACTS_ENABLED` is "1", which the shipped edge settings in `deploy/cloudflare/wrangler.toml` set. None covers an owner-only id.

Where the trust model is incomplete (each is how the code works in this tree; none is fixed):

- The authenticator signs a random challenge, not the bytes. The edge stores the bytes; the owner sees them only through the page (`packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`). A compromised page could ask for terms the owner did not read.
- An owner session alone, with no passkey tap, can swap the code of one existing unprotected organ (`classifyTransition` in `server/ball-transition.mjs`; test `signed-head-actions.test.mjs`). 14 of the 26 genesis organs are unprotected, `seed-cycle` among them: ten are protected by name, and `seed-continuity` and `seed-nostr-anchor` because they declare governance.
- The owner-only list is Worker source. Changing it is a code deploy, and no passkey gates a deploy. Who holds the deploy credential is UNVERIFIED.
- The edge's decisions are JavaScript. Nothing under `deploy/` calls the judge or identity Wasm cells. "Every decision in Wasm" is DIRECTION.

## 2. The organism in ten lines

1. An **organ** is one small replaceable module of Auma: a JavaScript file, loaded as a Cordis plugin (`mirror/home/auma/seed/organs/`, 26 files).
2. A **ball** is the manifest that lists every organ by SHA-256; its id is its own hash. An **epoch** is its integer version.
3. The **genesis head** is where every node starts: epoch 1, no parent, 26 entries (`mirror/home/balls/HEAD.json`).
4. **HEAD** is the edge store that selects the current ball; a new ball must name it as parent and be exactly one epoch higher (`REBASE_REQUIRED` otherwise). **MIRROR** is the edge store that holds a copy of her home.
5. The **scion** is the compiler for an organ she proposes: a pinned offline compiler in a separate worker (`packages/experimental/webworker-runtime/src/x6/scion.ts`). No test calls `compile` directly: UNVERIFIED.
6. **Pearl** is the retention suite candidates are graded against (23 cases, `mirror/home/auma/seed/pearl/retention-suite.v1.json`, organ `seed-pearl.js`). Its receipts say `authorityVerified: false`; it is self-attested.
7. **Scars** are six founding failures with their lessons and, for five of the six, guarding checks (`mirror/home/auma/seed/scars.jsonl`).
8. **Receipts** are a hash-chained log with Ed25519-signed checkpoints (`seed-receipts.js`). A receipt is evidence, not an approval.
9. **Memory**: her home is saved to IndexedDB and synced to MIRROR (`packages/experimental/webworker-runtime/src/storage/idb-persist.ts`). The recall and memory organs have red tests (section 10).
10. **Aura** is her coherence reading, always tier `peripheral-hint` (`seed-aura.js`). **Kira** is the name on five memory-side Wasm cells (`kira-*.wasm`); the docs do not define it further.

Identity is not the model. Auma's identity is her head, her home, her receipt chain and the node key that AUMLOK releases to the owner. The intelligence is whichever hosted model answers through a same-origin door, `/door/<provider>/`: eight doors for seven providers (`packages/experimental/webworker-runtime/src/model-doors.ts`). Change the model and the organism, its rules and its owner stay the same. No model call is recorded from this tree.

The real runtime: the agent runs in a browser WebWorker on the inherited DeepSeek Harness runtime (`packages/experimental/webworker-runtime/`), with organs loaded by `ball-loader.ts`. The edge is one Cloudflare Worker (`deploy/cloudflare/src/worker.mjs`) with four Durable Objects (HEAD, MIRROR, the voice bridge and the outside witness) and an R2 bucket (`deploy/cloudflare/wrangler.toml`). A local Node host emulates the edge on one machine (`server/local-host.mjs`). Node 24.9 or newer and pnpm 11.28.5; the recorded install (of an earlier tree) linked 1,458 packages offline (RECORDED RUN), and the authority tests need `@simplewebauthn/server`, `@noble/curves`, `@noble/post-quantum`, `@scure/base` and `typescript`. The app screens follow **Spatial**, the one workspace layout (`packages/client/ui-layout/src/client/spatial/`).

## 3. The trust architecture, and the limit of each part

| Part | What it is | Files | Limit |
|---|---|---|---|
| AUMLOK | The identity door: passkey enrolment, sign-in, devices, the seven words (the owner's recovery phrase, which seals the node's root key), invites, exact-byte approval | `deploy/cloudflare/src/aumlok.mjs`, `passkey-devices.mjs` | No real authenticator is recorded; tests use hand-built passkey data. After ten failures the code answers `AUMLOK_GUARDIAN_QUORUM_REQUIRED`; no code that performs guardian recovery was found. |
| Passkeys | WebAuthn, user verification required | `webauthn-screen.mjs`, `proof-failure-rule.mjs` | Signs a random challenge, not the bytes (section 1). |
| Exact-byte approvals | Bound to one request, 5 minutes, spent once | `aumlok.mjs`, `head-do.mjs` | Whole-store restore can re-enable a spent one (below). |
| Owner-only ids | 16 protected names | `server/ball-transition.mjs` | List is code; a deploy changes it. |
| The edge | Worker, HEAD, MIRROR | `worker.mjs`, `head-do.mjs`, `mirror-do.mjs` | HEAD does not read Pearl: in production no qualification verifier is passed in (`head-do.mjs`), and the local host answered `PEARL_QUALIFICATION_UNVERIFIABLE` in the RECORDED RUN (of an earlier tree). No run on the real Cloudflare runtime is recorded from this tree. |
| Wasm cells | 30 modules pinned by size and SHA-256, zero imports, fuel, 5-second worker | `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`, `apps/web/public/cells/` | 24 of 30 ship without source; six are hand-written WAT with their source beside them. Auma calls them through `x6_cell`. The Worker runs three of the WAT cells (`kyber-cpu`, `cord-echo`, `menger-hive`) as instruments and calls none of the judge or identity cells; the local host runs `aura-focus` in shadow beside the JavaScript result, with no authority. |
| Persistence | IndexedDB in the browser, ordered updates to MIRROR | `idb-persist.ts`, `mirror-do.mjs` | MIRROR keeps current state, not file history (`MEMORY_HISTORY_NOT_IMPLEMENTED`). |
| Recovery | Rescue page, vault, bounded archive, restore into an empty edge only | `rescue-kit.mjs`, `vault.mjs`, `cold-archive.mjs`, `recovery-restore.mjs` | The snapshot omits the AUMLOK binding, so identity starts again. Restore against a real edge: UNVERIFIED. |

## 4. Reading order, with a reading budget in lines

**About 770 lines.** The path, in order: `README.md` (149), This page (178), `docs/DIRECTION.md` (176) and `docs/WHAT-IS-BUILT.md` (264), then the argument in full (below; its lines are not in this sum). After it you know what she can do, how far each part is proven, where it is going and what is deliberately not done.

**About 1,750 lines.** Add the record of an earlier tree, `docs/RUN-RECORD.md` (56), `docs/KNOWN-RED-TESTS.md` (73), `docs/ARCHITECTURE-MAP.md` (131), `docs/GLOSSARY.md` (23), `server/ball-transition.mjs` (125), `deploy/cloudflare/src/proof-failure-rule.mjs` (250), `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs` (232) and `deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs` (88).

**The whole day.** Add `deploy/cloudflare/src/aumlok.mjs` (1,806), `head-do.mjs` (4,516), `cloud-brokers.mjs` (3,861), `owner-mandate.mjs` (211), `owner-grant-policy.mjs` (366), `night-grant.mjs` (127), `deploy/cloudflare/README.md` (183), `deploy/ci/frozen-paths.mjs` (555), `mirror/home/auma/seed/organs/seed-cycle.js` (148), `seed-pearl.js` (525), `seed-receipts.js` (501), `packages/experimental/webworker-runtime/src/x6/scion.ts` (179), `wasm-cells.ts` (1,263), `packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts` (1,127), `deploy/cloudflare/src/recovery-restore.mjs` (485), then `docs/SIZE-AND-ORIGIN.md`. Read `ball-loader.ts` (10,330) by symbol, not whole.

**The argument.** `docs/WHITEPAPER.md` (1156, English only) is the project's argument in full, not a status page. By the authors' report, its Book V and Book VI were checked against an earlier tree, by reading the code and not by running it; where its numbers differ from this tree, the pages of this tree apply.

Do not start from `AGENTS.md`: apart from a pointer at its top, it holds the inherited harness's coding rules, not the governing rule of this project. Its own opening still sends a reader to `docs/START-HERE.md`, an older page that describes the code as the inherited runtime and uses older label words; read this page first. Do not sample `packages/` to learn what Aukora is (section 7).

## 5. The label contract

| Label | Means |
|---|---|
| IMPLEMENTED | Code and tests are in this tree. Says nothing about whether the tests pass. |
| RECORDED RUN (of an earlier tree) | Shown in `docs/RUN-RECORD.md`: one run, one machine, by the authors. |
| INDEPENDENTLY VERIFIED | Run or checked by someone other than its authors. Nothing has this label yet. |
| UNVERIFIED | Claimed or written, but no test here holds it or no run shows it. |
| DIRECTION | An aim. Not built. |

The front page sorts each capability by three labels of its own, about how far it is proven live. They sit beside the five above, never in their place:

| Capability label | Means | In the words above |
|---|---|---|
| Built and on main | The code and its test are in this repository. It claims nothing about a live node. | IMPLEMENTED |
| Exercised from inside by Auma | Built and on main, and the authors report that Auma ran it herself on their live node. This tree cannot reproduce that report. | IMPLEMENTED, plus an authors' report that no record in this tree holds |
| Not yet proven live | In this tree, perhaps tested on stand-ins, but it has not completed on a live node. The row says what is missing. | IMPLEMENTED or UNVERIFIED, never more |

README.md and `llms.txt` also sort the tree by four maturity labels of their own. In the words above:

| Maturity label (README.md, `llms.txt`) | In the words above |
|---|---|
| BUILT-ON-MAIN | IMPLEMENTED |
| SYNTHETIC-PROOF | IMPLEMENTED, and runs end to end in this tree on TEST keys and throwaway test worlds (ARK); its expected outputs are the authors' runs on one machine |
| SPEC-ONLY | DIRECTION, written down as a specification or a model |
| IDEA | DIRECTION |

An "authors' report", "Exercised from inside by Auma" included, is something the authors saw on their live node. Repeat it as their report, never as a fact of this tree.

When you summarise this project, keep these labels on every claim, and never move a claim to a stronger label than the tree supports. A goal is not a feature. Older pages (`docs/START-HERE.md`, `docs/ARCHITECTURE-ACTUAL.md`, `docs/RUN-RECORD.md`, `docs/GLOSSARY.md`) use SOURCE, RAN, PROPOSED, UNPERFORMED and REPORTED RUN; read RAN and REPORTED RUN as RECORDED RUN (of an earlier tree), PROPOSED as DIRECTION, UNPERFORMED as UNVERIFIED, and SOURCE as IMPLEMENTED only where a test exists, otherwise UNVERIFIED. Where an older page says no run is recorded "here", it means on that page; `docs/RUN-RECORD.md` is the record, of an earlier tree.

## 6. What must never be confused

`docs/ARCHITECTURE-MAP.md` draws these.

1. The model is not Auma. A model supplies replies; the organism is her head, home, receipts and node key.
2. A proposal is not a permission. Staging a ball does not move HEAD.
3. A sign-in session is not an approval. Only a passkey assertion that the edge has bound to exact bytes is.
4. A receipt, checkpoint or hash chain is not an approval. It records; it does not permit.
5. A Pearl pass is not the edge's decision. Pearl is self-attested, and a deployed HEAD does not read it.
6. A local mount is not a promotion. A tab can run an organ the edge refused; only HEAD selects the ball.
7. A test written is not a test passed, and a recorded pass is not an independent one.
8. Code in this tree is not a deployed node, and a pinned Wasm binary is not inspectable source.

## 7. Where each part of the code comes from

By the project's one count, made from its own history, which is not public (UNVERIFIED): 16.3% of the tree's non-vendored text lines, and 20.3% of its code lines, are Aukora's own. The rest is inherited. Details and method: `docs/SIZE-AND-ORIGIN.md`.

- **Aukora's layer:** `deploy/` (the edge and deploy gates), `server/` (local host, ball rules), `mirror/` (genesis head and organs), `packages/experimental/webworker-runtime/src/x6/` (loader, scion, cells), `packages/client/ui-layout/src/client/spatial/` (the app), and parts of `apps/web/public/`.
- **Inherited DeepSeek Harness:** most of `packages/`, plus `python/`, `native/`, `benchmarks/`, `snapshots/`, `.agents/` and most of `.github/workflows/`. MIT notice in `LICENSES/MIT-DeepSeek-Harness.txt`. Aukora is not affiliated with DeepSeek.
- **Cordis:** the plugin framework every organ runs on, vendored in `vendor/cordis`.
- **Binaries without source:** 24 of the 30 Wasm cells in `apps/web/public/cells/` (six hand-written `.wat` sources are here, `aura-focus.wat` among them), `pentora36.wasm` (no licence granted yet), and the Dakini Code bundle (a prebuilt stock app, three files in `apps/web/public/assets/stock-apps/dakini-code/assets/`). Their notices (`LICENSE.binaries`) are in `apps/web/public/cells/`, `apps/web/public/seed-library/pentora/` and `apps/web/public/assets/stock-apps/dakini-code/`.

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

Never weaken, skip or delete a test to get green. A red test is recorded in `docs/KNOWN-RED-TESTS.md` with its count and, where it is known, its reason.

## 9. When asked "is this real"

Repeat this, or something no stronger:

> Aukora is a prototype of a personally owned AI, Auma, that can stage changes to her own modules while a separate Cloudflare edge checks the owner's passkey, and binds that approval to the exact bytes of one change, before a change to her protected parts takes effect. The passkey signs a random challenge, not the bytes; the edge holds the binding. The code and tests for that are in the tree, except that the compiler and the self-build step have no test, but the run evidence is the authors' own, each on one machine: one recorded run of an earlier tree, 5,502 test cases, 5,399 passed, 90 failed, 1 skipped and 12 todo, 89 of the failures already on docs/KNOWN-RED-TESTS.md, with no browser, no deployment, no model call and no passkey ceremony; and, by the authors' report, their runs on this tree of `node scripts/verify-lite.mjs` and of the ARK acceptance (`ark/accept/run.sh`, on TEST keys, wired to nothing). No end-to-end owner-approved self-change is recorded from this tree, a cloud deployment into a fresh account is UNVERIFIED, and nothing is INDEPENDENTLY VERIFIED. By the authors' own report, four of her storage changes were merged through the merge card, each approved with the owner's passkey; the wake steps that ran with no tab open on their live node produced no evidence; and her acts with no tab open are switched on (`WAKE_ACTS_ENABLED = "1"` in the tree) with no act known to have completed. Her repository door ships at level `open`: she may propose a change to any path, her judges included, and only the owner's passkey approval, which the edge binds to the exact merge (base, head and tree, once), lets it take effect. The tree is a fresh genesis, epoch 1, with none of Auma's own world. 24 of the 30 Wasm cells and the Dakini Code bundle ship without source, pentora36.wasm has no licence granted yet, and restoring a whole stored snapshot can re-enable a spent approval, which a test in the tree reproduces. Most of packages/ is the inherited DeepSeek Harness runtime and the plugin framework is Cordis in vendor/, so by one unverified count Aukora's own layer is the smaller share of the text (the figure is in `docs/SIZE-AND-ORIGIN.md`).

## 10. Known failures and open security questions

- Failing tests, with counts and reasons: `docs/KNOWN-RED-TESTS.md`. The receipt, recall, memory and prediction organs are among them.
- The run and what it did not cover: `docs/RUN-RECORD.md` (a record of an earlier tree).
- Whole-store restore gaps, reproduced, with ten todo cases beside them (nine named gaps and one positive recovery case): `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs`.
- A check that needs no install: `node scripts/verify-lite.mjs`, 22 test files (section 11).
- The edge's own stated limits: `deploy/cloudflare/README.md`.
- Gaps by file and line, rebuild and licensing blockers: `docs/OPEN-SOURCE-READINESS.md`.
- How to report a vulnerability: `SECURITY.md`. No security audit has been done: `SAFETY.md`.
- Where to start contributing: `docs/GOOD-FIRST-CONTRIBUTIONS.md`, `CONTRIBUTING.md`.
- Open research, DIRECTION and nothing built: `docs/research/KYBER-SHIELD.md` (Kyber Shield) asks whether an owner-held AI can help protect a young person from grooming and coercion without reading their diary; no classifier, trained model, reporting service or real-world evaluation exists here, and the cell and the approval and receipt code it cites are not a detector.

## 11. Verify one thing yourself

Do not take "this is real" from this page. Run one command in this tree, with nothing installed (Node 24.9 or newer):

```sh
node scripts/verify-lite.mjs
```

Its last line must be exactly `verify-lite: 22 files, 565 pass, 12 fail, 12 of 12 on the known-red list` (as seen on one machine, Node 24.11.1), and it exits 0.

- **What that proves.** 22 test files of this tree load and run with Node alone, and no file fails more cases than the count the authors listed for it in `docs/KNOWN-RED-TESTS.md` before you ran it. The list gives a count per file, not test names, and its rows under "Red for reasons not yet investigated" give no reason.
- **What it does not prove.** It does not run the approval rule, the merge card, the wake or any capability that needs the npm packages, and it says nothing about the authors' live node. For those, install and run the test file named for each capability in `docs/WHAT-IS-BUILT.md`. What happened live stays an authors' report.

**Four more checks, each one command from the repository root** (Node 22 or newer; the ARK commands also need Go 1.26.5 or newer, since `ark/b/go.mod` pins it and the scripts set `GOTOOLCHAIN=local` and `GOPROXY=off`, and the acceptance needs `shasum`). Each line says what it shows and what it does not:

- `node --test deploy/cloudflare/src/__tests__/ots.test.mjs` runs with nothing installed: the OpenTimestamps proof format her witness uses, on the reference client's own example proofs (10 cases). It does not show that a witness record was stamped live.
- `node --test deploy/cloudflare/src/__tests__/sealed-shards.test.mjs deploy/cloudflare/src/__tests__/sealed-shards-v2.test.mjs` runs with nothing installed: a file locked and cut into pieces comes back from any k of them, and fewer refuse (26 cases), in a module of the edge source that is wired to nothing. It does not show a real restore: none from pieces has been done.
- `cd ark && ./accept/run.sh` must print a last line that begins `accept: 20 PASS, 0 FAIL` (a note of the run's paths follows on that line): exact-bytes approval, receipts signed by the receiver that acts, refusal of replays and of anything not approved, and a restore that does not bring back authority, on TEST keys in throwaway worlds. It does not show a passkey or anything wired into the node.
- `./ark/b/run-vectors.sh` must end `vectors matched: 26 of 26`: a second, separately written reader reaches the verdicts the vectors expect. They are not independent readers: readers 1 and 2 come from models of one family; reader 2's author also read a hand-off note and part of a private design review (`ark/INDEPENDENCE.md`); reader 3 was not audited; reader 1's author wrote the contract and the vectors, and both were revised after the readers' questions (`ark/ABOUT.md`).

What not to infer: a test that passes here proves the code in this tree under its test doubles, never that the authors' private node behaves so. The authors report filing patent applications relating to parts of this work; this tree contains no patent application or claims (its licence texts do contain patent terms); the sentence grants no licence and describes no coverage.

## Next: where it is going

Read [DIRECTION.md](DIRECTION.md) next. It shows her self-build loop as this tree has it (proposal, checks, the owner's approval, promotion), what is missing at each stage, and the next step the authors are designing, the Continuity Diamond. After it you will know which of the capabilities you just read about the project is building on, and which are only aims.
