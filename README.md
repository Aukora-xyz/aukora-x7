# Aukora

English | [中文](README.zh.md)

Aukora is building a personally owned AI that can change its own software, while a separate authority keeps the person who owns it in control of sensitive actions. It is a prototype, published with its gaps listed. Nobody outside the project has recorded a run of it yet.

**The AI can evolve. The human remains the authority.**

## The first 60 seconds

- **The AI is called Auma.** She runs in her owner's web browser. She is made of small replaceable parts, and she can write, test and put forward new versions of them.
- **She cannot switch a sensitive change on by herself.** A separate program does that. The project calls it **the edge**: a small cloud service (one Cloudflare Worker) that runs outside her and keeps the record of which version of her is live. Today "sensitive" includes any change to a fixed list of her core parts and any post or merge she makes on GitHub. A change to an ordinary part needs less: see [where it stops](#the-rule-and-where-it-stops).
- **The owner approves with a passkey**, the fingerprint, face or security-key sign-in built into phones and laptops. The edge ties each approval to one exact request or change. An approval lasts five minutes and works once. One exception, a night grant, is under [where it stops](#the-rule-and-where-it-stops): one tap that covers changes to ordinary parts for up to 12 hours.
- **Why it matters.** Most AI today is rented: whoever hosts it decides what it may do. AI agents are starting to act for people, and one that can change its own software can change its own limits too. When the program that proposes an action also decides whether it is allowed, its limits are only settings inside the thing they limit. Aukora's rule keeps the two apart: what proposes never permits.
- **What is real today.** The code and tests for that rule are in this repository. One test run by the authors, on one machine, is recorded: 5,502 test cases, 5,399 pass, 90 fail, and 89 of the 90 were already on the project's list of known failures.
- **What is missing.** Nobody but the authors has run it. No complete self-change, approved by an owner from start to finish, is recorded as run from this repository. A cloud deployment from it into a fresh account is UNVERIFIED: nobody has recorded one (of an earlier tree). Some parts ship only as compiled files without their source, and most of the code underneath is inherited from another project. The full list is under [What is not](#what-is-not).
- **How to take part.** No code needed: read [What is not](#what-is-not) and [docs/DIRECTION.md](docs/DIRECTION.md), then open an issue with a question or with something that is unclear or wrong, or report a weakness through [SECURITY.md](SECURITY.md). With code: run the one command under [Verify it yourself](#verify-it-yourself), then see [How to help](#how-to-help). An AI reading this repository starts at [docs/AI-START-HERE.md](docs/AI-START-HERE.md).
- **Five labels** on these front pages say how far a claim is proven: IMPLEMENTED (code and tests in this tree), RECORDED RUN (shown in [docs/RUN-RECORD.md](docs/RUN-RECORD.md), a run of an earlier tree), INDEPENDENTLY VERIFIED (nothing has this label yet), UNVERIFIED (claimed or written, but no test here holds it or no run shows it), DIRECTION (not built). Older pages use other words; [docs/AI-START-HERE.md](docs/AI-START-HERE.md), section 5, maps them.

## The first five minutes

### The rule, and where it stops

What proposes never permits. Auma proposes. The edge permits, and for a protected change it takes the owner's passkey, not her word.

**What the owner actually approves.** One passkey tap is one approval. The passkey signs a one-time random challenge, not the change itself. The edge records which exact request, or which exact candidate code, that tap was for, and refuses anything else. The owner sees what is being approved only through the page that asks, so a compromised page could ask for terms the owner did not read. No independent display is in the tree.

**Where it stops today.** The rule is aimed at a misbehaving agent or model reply. It is not a defence against a compromised approval page, the edge's operator, a stolen deploy credential or a storage rollback.

- **Not every change needs the passkey.** 15 named parts are protected, plus any part that declares itself governance. Ten of the 15 are among her 26 starting parts (the other five are Wasm cells: small sealed WebAssembly modules), and two more of the 26 declare governance. That leaves 14 of the 26 unprotected, and the one that runs her self-build step (`seed-cycle`) is among them. One unprotected part at a time can be replaced with an owner sign-in session (8 hours at most) and no passkey tap. One passkey tap can also give a **night grant**: for up to 12 hours, 12 uses and 8 parts per use, she adds or replaces ordinary parts alone, with no tap for each change. The 15 protected ids are never covered. IMPLEMENTED ([`night-grant.mjs`](deploy/cloudflare/src/night-grant.mjs), [`night-grant.test.mjs`](deploy/cloudflare/src/__tests__/night-grant.test.mjs)); no grant used on a deployed node is recorded.
- **The list is code.** The protected list is source code of the edge, so whoever can deploy the edge can change it, and no passkey gates a deploy. Who holds that credential on a real node is UNVERIFIED.
- **Storage.** Whoever can roll the edge's storage back can make a spent approval work again. A test in the tree reproduces it. No fix is in the tree.
- **Her grading is her own.** The suite a candidate is graded against is self-attested, and a deployed edge does not read its result ([`head-do.mjs`](deploy/cloudflare/src/head-do.mjs) is given no verifier for it in production).
- **The edge decides in JavaScript.** The five protected names that are Wasm cells are not part of the decision: the edge calls none of them.

**What holds it, by file.** IMPLEMENTED means the code and its test are in this tree, not that the test passes. The recorded run (of an earlier tree) lists no failing case in the test files below, except where a row says so. This is a sample; the fuller list is [docs/WHAT-IS-BUILT.md](docs/WHAT-IS-BUILT.md).

| Claim | Where | Held by | Label |
| --- | --- | --- | --- |
| An approval is tied to one request (origin, method, path, SHA-256 of the body) or to one candidate (version id, version number, part, code hash). It cannot be replayed, used on other bytes or used after five minutes | [`aumlok.mjs`](deploy/cloudflare/src/aumlok.mjs), [`owner-grant-policy.mjs`](deploy/cloudflare/src/owner-grant-policy.mjs) | [`convergence-approval-fencing.test.mjs`](deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs); passkey data is hand-built | IMPLEMENTED |
| For a version change, the approval is spent in the same storage transaction that moves the live version; an expired one rolls both back. Other approved requests spend it at the edge just before the effect runs | [`head-do.mjs`](deploy/cloudflare/src/head-do.mjs) | [`head-hardening.test.mjs`](deploy/cloudflare/src/__tests__/head-hardening.test.mjs) | IMPLEMENTED |
| The 15 protected ids are one fixed list that no label on a candidate lowers | [`ball-transition.mjs`](server/ball-transition.mjs) | [`convergence-policy.test.mjs`](deploy/cloudflare/src/__tests__/convergence-policy.test.mjs) | IMPLEMENTED |
| A new version must name the live one as its parent and be exactly one higher, or it is refused with `REBASE_REQUIRED` | [`ball-head.mjs`](server/ball-head.mjs), [`head-do.mjs`](deploy/cloudflare/src/head-do.mjs) | [`ball-manifest.test.mjs`](server/ball-manifest.test.mjs), [`aumlok-restore-rehearsal.test.mjs`](deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs) | IMPLEMENTED |
| A candidate's own "pass" is ignored: the parent grades its outputs again | [`scion-growth.ts`](packages/experimental/webworker-runtime/src/x6/scion-growth.ts) | [`scion-growth.spec.ts`](packages/experimental/webworker-runtime/tests/x6/scion-growth.spec.ts) (1 other case known red) | IMPLEMENTED |
| In the owner-identity files, only a proof that was checked and was wrong moves a lockout counter, so junk cannot lock the owner out | [`proof-failure-rule.mjs`](deploy/cloudflare/src/proof-failure-rule.mjs) | [`proof-failure-rule.test.mjs`](deploy/cloudflare/src/__tests__/proof-failure-rule.test.mjs) | IMPLEMENTED |
| The approval page rebuilds its terms from the candidate bytes and shows the code diff | [`head-promotion.ts`](packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts), [`organ-code-diff.ts`](packages/client/ui-layout/src/client/spatial/portal/organ-code-diff.ts) | [`organ-code-diff.client.spec.ts`](packages/client/ui-layout/tests/organ-code-diff.client.spec.ts), in a simulated page; no browser session recorded | IMPLEMENTED |
| **Not fixed.** Gaps that a test reproduces: after a whole-store rollback a spent approval works again and the publication repeats; restoring only the identity state also revives a spent approval | [`aumlok.mjs`](deploy/cloudflare/src/aumlok.mjs), [`head-do.mjs`](deploy/cloudflare/src/head-do.mjs) | [`aumlok-restore-rehearsal.test.mjs`](deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs); it holds the reproduction only, and no fix is in the tree | IMPLEMENTED |
| She compiles a candidate part in a separate worker; her self-build step installs it, runs its cases, and keeps or undoes it | [`scion.ts`](packages/experimental/webworker-runtime/src/x6/scion.ts), [`seed-cycle.js`](mirror/home/auma/seed/organs/seed-cycle.js) | no test calls either | UNVERIFIED |
| The local host boots and answers with the first version; its `/_head/runtime` answer is the error `PEARL_QUALIFICATION_UNVERIFIABLE` | [`local-host.mjs`](server/local-host.mjs) | [docs/RUN-RECORD.md](docs/RUN-RECORD.md) | RECORDED RUN (of an earlier tree) |

**The project's names, plain words first.** Each replaceable part of her is an **organ**. One version of her is a list of every organ with the SHA-256 hash of its code, called a **ball**, and its version number is the **epoch**. The edge's record of which ball is live is **HEAD**, and its copy of her home files is **MIRROR**. The identity and approval code is **AUMLOK**. The compiler that builds a candidate organ is the **scion**. The suite of cases a candidate is graded against is **Pearl**, and the recorded failures it grew from are **scars**. [docs/GLOSSARY.md](docs/GLOSSARY.md) says more about ball, organ and epoch; the other names are in [docs/WHAT-IS-BUILT.md](docs/WHAT-IS-BUILT.md).

### One picture

```text
        OWNER: a passkey device and a browser tab
          |                              ^
  one passkey tap per approval           | the terms and the code
          v                              | diff, rebuilt from bytes
+------------------------------------------------------------+
| THE EDGE (permits): one Cloudflare Worker and its storage  |
|  checks the passkey; one approval, one request, one use    |
|  HEAD   : which version of her is live (ball id, epoch)    |
|  MIRROR : a copy of her home files, receipts included      |
+------------------------------------------------------------+
    ^                      |                     ^
    | stage a candidate    | the live version    | home sync
    | (HEAD does not move) v (the tab reloads)   |
+------------------------------------------------------------+
| AUMA (proposes): the agent, in the owner's browser         |
|  propose -> compile (U) -> trial, parent grades again      |
|  -> self-build step (U) -> Pearl -> candidate, epoch + 1   |
|  25 Wasm cells, pinned by size and SHA-256, her tools      |
|  model replies reach her only through a door on the edge   |
+------------------------------------------------------------+
```

No arrow has been run end to end on a deployed node with a real passkey: UNVERIFIED. Each arrow between the boxes is IMPLEMENTED. Inside the Auma box, the two steps marked (U) have no test that calls them, and no code goes from the self-build step to Pearl (the order is as drawn only): UNVERIFIED. The models are hosted services outside this tree. Moving the edge's decisions into Wasm cells is DIRECTION. Step by step, with a label on each: [docs/ARCHITECTURE-MAP.md](docs/ARCHITECTURE-MAP.md).

### One example

1. Auma proposes a new version of her recall organ, one of the 15 protected ids: source files and test cases.
2. She compiles it in a separate worker. UNVERIFIED: no test in this tree calls the compiler.
3. She tries it in a disposable worker, where the parent grades the outputs again, runs it against Pearl, builds a candidate ball one epoch higher and stages it at the edge. A protected organ is staged, never mounted. IMPLEMENTED. Pearl's result is self-attested, and the edge does not read it.
4. The owner sees the terms rebuilt from the bytes and the exact code diff (IMPLEMENTED in a simulated page; no browser session is recorded). HEAD does not change until the owner's passkey approves that candidate's ball id, epoch, organ id and code hash. The approval is spent in the transaction that moves HEAD. IMPLEMENTED; the tests use hand-built passkey data, and no real authenticator is recorded.
5. If the candidate fails its cases, the self-build step undoes or retires it and logs the refusal: UNVERIFIED, no test calls it. If the approval is missing, expired, already used or for other bytes, the edge refuses and HEAD stays where it was: IMPLEMENTED.
6. None of these steps has a RECORDED RUN (of an earlier tree) as part of a real self-change. The recorded run (of an earlier tree) made no model call, opened no browser and used no passkey.

### Verify it yourself

```sh
git clone https://github.com/Aukora-xyz/aukora-x7.git
cd aukora-x7
node scripts/verify-lite.mjs
# last line, as seen on one machine (Node 24.11.1, nothing installed):
# verify-lite: 22 files, 564 pass, 12 fail, 12 of 12 on the known-red list
```

- **What that is.** A smoke check: 22 test files that need Node 24.9 or newer and nothing else, for the vault, the rescue kit, three of the deploy gates, the model door, Pearl's rules and the Aura focus shadow. Three of them (memory, predict, receipts policy) carry the 12 failures. All 12 are on the known-red list, so the command exits 0. UNVERIFIED: it is not part of the recorded run (of an earlier tree). It is a different and much smaller run, so do not read 564 and 12 as the state of the project.
- **It does not test the approval rule.** The authority tests import npm packages. After `pnpm install --frozen-lockfile` (UNVERIFIED online: the recorded install (of an earlier tree) ran offline from a local store), run `node scripts/verify-lite.mjs --with-packages` (UNVERIFIED tier, 16 more files), or `node --test` on `aumlok-restore-rehearsal.test.mjs`, `convergence-approval-fencing.test.mjs`, `convergence-policy.test.mjs` and `proof-failure-rule.test.mjs` in `deploy/cloudflare/src/__tests__/`. The recorded run (of an earlier tree) lists no failing case in those four files.
- **The full recorded run (of an earlier tree).** [docs/RUN-RECORD.md](docs/RUN-RECORD.md): one run, one machine, by the authors. 5,502 test cases, 5,399 pass, 90 fail; the other 13 are 1 skipped and 12 marked todo. Its logs do not ship. [docs/KNOWN-RED-TESTS.md](docs/KNOWN-RED-TESTS.md): 89 of the 90 failures were listed before the run, each file with its count. The 90th was found by the run, is listed now and is still red.

### What is not

- **Binaries without source.** 24 of the 25 Wasm cells and the Dakini Code bundle (a prebuilt stock app, three files) ship as binaries without their source. The cells include the ones named for the judges, identity and keys. They cannot be read or rebuilt from this tree, and their notes say that someone who passes this repository on cannot meet the AGPL's source duty from it alone. [`cells/LICENSE.binaries`](apps/web/public/cells/LICENSE.binaries), [`dakini-code/LICENSE.binaries`](apps/web/public/assets/stock-apps/dakini-code/LICENSE.binaries)
- **One file has no licence.** `pentora36.wasm` ships with no licence granted yet. [`LICENSE.binaries`](apps/web/public/seed-library/pentora/LICENSE.binaries)
- **The rollback gap.** Restoring a whole stored snapshot can re-enable a spent approval. The tree has a test that reproduces it, with ten todo cases beside it that name what a fix must show. No fix is in the tree.
- **Not run.** No end-to-end, owner-approved self-change is recorded as run from this tree. A cloud deployment from this tree into a fresh account is UNVERIFIED: deployment values are placeholders, some of them written into code.
- **Most of this tree is inherited.** Most of `packages/` is the inherited DeepSeek Harness runtime, and the plugin framework that organs are built on is Cordis, in `vendor/`. By the project's one count, made from its own history, which is not public, 11.6% of the text lines and 14.3% of the code lines are Aukora's own. UNVERIFIED. [docs/SIZE-AND-ORIGIN.md](docs/SIZE-AND-ORIGIN.md)

There has been no security audit ([SAFETY.md](SAFETY.md)). Nothing here is INDEPENDENTLY VERIFIED. More gaps, in order of weight: [docs/OPEN-SOURCE-READINESS.md](docs/OPEN-SOURCE-READINESS.md). Security claims the project does not make: [SECURITY.md](SECURITY.md).

### Where it is going

- DIRECTION: one owner-approved self-change, recorded from proposal to new HEAD on a deployed node. Most of its steps are IMPLEMENTED, two have no test, and the loop itself has never been recorded.
- DIRECTION: any browser and several devices for one node, with durable memory and verified recovery. Adding a second device by passkey is IMPLEMENTED ([`passkey-devices.mjs`](deploy/cloudflare/src/passkey-devices.mjs)), and so are rescue, archive and restore; the recall and memory tests are on the red list.
- DIRECTION: replaceable models and organs written by others. Today the model doors are a fixed table in source, and an outside organ has no author identity or registry.
- DIRECTION: her actions kept as signed records in the Nostr format (an open format for signed messages passed between relay servers), as her own log and exchanged between independently owned nodes, with no central authority granting identity. Today: one signed announcement of her HEAD and no relay ([`nostr-anchor.mjs`](deploy/cloudflare/src/nostr-anchor.mjs)).
- DIRECTION: more decisions in Wasm, a host other than Cloudflare, and later voice, wearables and robotics. Detail and order: [docs/DIRECTION.md](docs/DIRECTION.md).

**Why open.** An owner's control should not rest on one company, one model provider or one maintainer staying around or staying kind. So the line between what proposes and what permits has to be something anyone can read, fork and replace. Today only part of it is: the approval and version rules are readable JavaScript with tests, while 24 of the 25 Wasm cells are sealed binaries that a fork cannot rebuild, and the edge runs on one vendor's platform. Making the whole line inspectable, forkable and replaceable is DIRECTION. This tree is published to get there in the open, and not as a finished product.

## Go deeper

```text
OWN LAYER  deploy/cloudflare/src/  the edge: passkey, approvals, HEAD, MIRROR
           deploy/ci/, server/     deploy gates; a local host like the edge
           mirror/                 first version: 26 organs, Pearl, 6 scars
           packages/experimental/webworker-runtime/src/x6/   loader, scion
           packages/client/ui-layout/src/client/spatial/     screens (Spatial)
BINARY     apps/web/public/cells/  25 Wasm cells; 24 have no source here
INHERITED  vendor/ (Cordis); DeepSeek Harness: most of packages/ and docs/
```

| If you want | Read |
| --- | --- |
| The idea and the road ahead | [docs/DIRECTION.md](docs/DIRECTION.md) |
| The project's argument in full | [docs/WHITEPAPER.md](docs/WHITEPAPER.md), the white paper, in English only. Its Book V and Book VI are checked against this tree, by reading the code and not by running it |
| Every mechanism with its file, test and label | [docs/WHAT-IS-BUILT.md](docs/WHAT-IS-BUILT.md), [docs/ARCHITECTURE-MAP.md](docs/ARCHITECTURE-MAP.md). Older file-level notes, in older label words: [docs/START-HERE.md](docs/START-HERE.md), [docs/ARCHITECTURE-ACTUAL.md](docs/ARCHITECTURE-ACTUAL.md) |
| What is unproven or cannot be rebuilt | [SECURITY.md](SECURITY.md), [docs/OPEN-SOURCE-READINESS.md](docs/OPEN-SOURCE-READINESS.md), [docs/SIZE-AND-ORIGIN.md](docs/SIZE-AND-ORIGIN.md) |
| To start as an AI reading this repository | [docs/AI-START-HERE.md](docs/AI-START-HERE.md), before you summarise or change anything. Apart from a pointer at its top, the root `AGENTS.md` is the inherited runtime's coding guide: use it for work inside `packages/`, not for this project's rule |

### How to help

1. Without code: read, ask, and say where a page is unclear or wrong. Questions and decisions happen in issues and pull requests on this repository; no other channel exists ([docs/COMMUNITY.md](docs/COMMUNITY.md)).
2. Install, run the authority tests named under [Verify it yourself](#verify-it-yourself), and report your counts.
3. Repeat the recorded run (of an earlier tree) on another machine and send the result. It would be the first INDEPENDENTLY VERIFIED item. The milestone after that is one owner-approved self-change on a deployed node, with a real passkey, recorded by someone other than the authors.
4. Pick a red test or a stated gap from [docs/GOOD-FIRST-CONTRIBUTIONS.md](docs/GOOD-FIRST-CONTRIBUTIONS.md). The rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

Licence: [AGPL-3.0-or-later](LICENSE). Upstream DeepSeek Harness is MIT ([notice](LICENSES/MIT-DeepSeek-Harness.txt)); third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Aukora is not affiliated with or endorsed by DeepSeek.
