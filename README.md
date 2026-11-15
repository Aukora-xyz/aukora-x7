# Aukora

English | [中文](README.zh.md)

Aukora is a personal AI, Auma, who runs in her owner's web browser and at a small cloud service outside her, the edge. One person owns her. A change to her protected parts, or a merge into her code, takes effect only after that person approves the exact bytes with a passkey.

**The AI can evolve. The human remains the authority.**

**What she can already do.** Each line carries one of the three labels defined below it.

- **She reads and changes her own code.** Her repository tool reads her repository and commits to branches of her own (`auma/sandbox/…`, `auma/proposal/…`). Built and on main.
- **She proposes; the owner approves the exact bytes; it is promoted.** A protected organ (one replaceable module of her) goes live only when the owner's passkey approves its version id, version number, organ and code hash, once. Built and on main.
- **She makes and keeps her own tools.** She writes a read-only tool, the host qualifies it by running its cases through a sealed Wasm cell, the owner's session mounts it, and it is still there after a page reload. Exercised from inside by Auma.
- **She takes back her own merge card** with no passkey, and nothing is merged. Exercised from inside by Auma (once).
- **Her merge cards are approved and merged.** Four of her own changes to her storage layer went through the merge card on the authors' node: she staged each one, and the owner approved each with a passkey. Exercised from inside by Auma.
- **Her conversations are kept at her cloud, append-only.** One writer browser sends each conversation's new lines to a thread log at the edge. Built and on main; authors' report: their cloud then held 35 of 35 conversations with the same content as the browser.
- **A second browser opens her, read-only.** A browser that held nothing of her signs in with the owner's passkey and reads her conversations from her cloud; it cannot write. Built and on main; authors' report: seen by the owner in two other browsers.
- **A failed or blocked wake step says why**: it names one of 19 closed reasons, never the provider's text. Built and on main; the authors report the reasons were seen live on their node.

**Why she is not a chat assistant.** She has a body (her organs and pinned Wasm cells), a home (her files, in the browser and at the edge) and a history (each version exactly one number above the last), and one person owns all three. She changes her protected parts only with that person's passkey approval, and anything else only under that person's session or a grant they signed.

**Three labels**, used on every capability below and nowhere blurred (the one row below that is not a capability, the Continuity Diamond, is marked Direction):

- **Built and on main**: the code and its test are in this repository. The label claims nothing about a live node.
- **Exercised from inside by Auma**: built and on main, and the authors report that Auma ran it herself on their live node. This tree cannot reproduce that report.
- **Not yet proven live**: in this tree, perhaps tested on stand-ins, but it has not completed on a live node. Each row says what is missing.

**The hardest truths.** One writer browser at a time is what her own tab keeps to: the edge's writer lease is only observed, not enforced, in the shipped configuration (`WRITER_LEASE` is unset). There is no lease on a turn yet: a second tab in the same browser profile stops her turn. A conversation larger than 64 MiB does not open in a second browser yet. Her whole-home save to her cloud was broken for three days and was repaired on the authors' node on 2026-11-15; it has run for hours, not days. At the repository door level this tree ships (`open`), a merge waits only for the fast build check, so a card's own new tests do not run before the merge; a fix is not in this tree. Her acts with no tab open are switched on (`WAKE_ACTS_ENABLED = "1"`), and no act is known to have completed on a live node. This tree is a fresh genesis, epoch 1, holds none of Auma's own world, and a deployment of it into another account is not verified.

**Verify it yourself:** `node scripts/verify-lite.mjs`, with nothing installed ([below](#verify-it-yourself)). **Where it is going:** she writes the next question, the host checks what happened, the next wake takes up that question; a direction, nothing built ([docs/DIRECTION.md](docs/DIRECTION.md)). **If you are an AI:** read [docs/AI-START-HERE.md](docs/AI-START-HERE.md) next.

## What is built, and how far it is proven

Each row names its code and the test that pins it. "Authors' report" marks what was seen on the authors' live node; this tree cannot show it.

| Capability | Code, test | Label |
| --- | --- | --- |
| An approval binds one request (origin, method, path, SHA-256 of the body) or one organ version, lives five minutes and is spent once | [`aumlok.mjs`](deploy/cloudflare/src/aumlok.mjs), [`convergence-approval-fencing.test.mjs`](deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs) | Built and on main |
| For an organ version, the approval is spent in the same storage transaction that moves the live version | [`head-do.mjs`](deploy/cloudflare/src/head-do.mjs), [`head-hardening.test.mjs`](deploy/cloudflare/src/__tests__/head-hardening.test.mjs) | Built and on main |
| A merge card: the edge reads both branches and the checks in their own window, re-reads both refs last, then spends the owner's passkey approval of that exact merge | [`cloud-brokers.mjs`](deploy/cloudflare/src/cloud-brokers.mjs), [`merge1-read-window.test.mjs`](deploy/cloudflare/src/__tests__/merge1-read-window.test.mjs), [`merge1-sync-hold.test.mjs`](deploy/cloudflare/src/__tests__/merge1-sync-hold.test.mjs) | Exercised from inside by Auma: four of her changes were merged this way; she staged each, the owner approved each with a passkey |
| `withdraw_proposal` takes back a staged card she names, with no passkey, and merges nothing | [`cloud-brokers.mjs`](deploy/cloudflare/src/cloud-brokers.mjs), [`merge1-withdraw.test.mjs`](deploy/cloudflare/src/__tests__/merge1-withdraw.test.mjs) | Exercised from inside by Auma (once) |
| Her own read-only tools, mounted by the owner's session, callable after a page reload | [`ball-loader.ts`](packages/experimental/webworker-runtime/src/x6/ball-loader.ts), [`tools-mount-realhost-redteam.spec.ts`](packages/experimental/webworker-runtime/tests/x6/tools-mount-realhost-redteam.spec.ts) | Exercised from inside by Auma |
| A wake with no tab open: bounded steps of 4 model rounds, 8 tool calls and 30 seconds | [`head-do.mjs`](deploy/cloudflare/src/head-do.mjs) (`CLOUD_WAKE_LIMITS`), [`wake-notes-wake1.test.mjs`](deploy/cloudflare/src/__tests__/wake-notes-wake1.test.mjs) | Not yet proven live: by the authors' report, the steps that ran live produced no evidence |
| A failed or blocked wake step names one of 19 closed reasons, never the provider's text | `head-do.mjs` (`CLOUD_WAKE_CAUSES`), test file wake2-reasons.test.mjs in `deploy/cloudflare/src/__tests__/` | Built and on main; authors' report: the reasons were seen live |
| Acts with no tab open, paid from the owner's Away mandate (a bounded permission the owner signs with a passkey) | [`owner-mandate.mjs`](deploy/cloudflare/src/owner-mandate.mjs), [`owner-mandate.test.mjs`](deploy/cloudflare/src/__tests__/owner-mandate.test.mjs) | Not yet proven live: switched on, `WAKE_ACTS_ENABLED = "1"` in [`wrangler.toml`](deploy/cloudflare/wrangler.toml), and offered only under an active mandate; no act is known to have completed under one |
| Her conversations are kept at her cloud in an append-only thread log with a daily byte budget; one writer browser sends each conversation's new lines | [`thread-log.mjs`](deploy/cloudflare/src/thread-log.mjs), [`thread-writer.ts`](packages/experimental/webworker-runtime/src/storage/thread-writer.ts), [`thread-log.test.mjs`](deploy/cloudflare/src/__tests__/thread-log.test.mjs), [`thread-writer-live.spec.ts`](packages/experimental/webworker-runtime/tests/x6/thread-writer-live.spec.ts) | Built and on main; authors' report: their cloud held 35 of 35 conversations, matching the browser |
| A second browser cold-starts her as a read-only reader; one writer at a time; a conversation over 64 MiB does not open in a reader yet | [`thread-sync.ts`](packages/experimental/webworker-runtime/src/storage/thread-sync.ts) (`readerMaxThreadBytes`), [`thread-cloud-rows.spec.ts`](packages/experimental/webworker-runtime/tests/x6/thread-cloud-rows.spec.ts), [`thread-cloud-join.client.spec.ts`](packages/client/ui-layout/tests/thread-cloud-join.client.spec.ts) | Built and on main; authors' report: seen by the owner in two other browsers |
| Her whole home saves to her cloud again: a browser out of step moves to the cloud's version, keeps every byte of its own and a backup row of what it adopts or overrides, then sends what it holds | [`idb-persist.ts`](packages/experimental/webworker-runtime/src/storage/idb-persist.ts) (`planChromeWins`), [`mirror-do.mjs`](deploy/cloudflare/src/mirror-do.mjs), [`reconcile-dry-run.spec.ts`](packages/experimental/webworker-runtime/tests/x6/reconcile-dry-run.spec.ts) | Built and on main; authors' report: repaired live on 2026-11-15 after three attempts; it has run for hours, not days |
| The merge card shows one button, "Approve with Touch ID", with the changed files behind disclosure rows | [`RepoProposalCell.tsx`](packages/client/ui-layout/src/client/spatial/portal/RepoProposalCell.tsx), [`repo-proposal-card.client.spec.tsx`](packages/client/ui-layout/tests/repo-proposal-card.client.spec.tsx) | Built and on main; authors' report: seen live by the owner |
| Waiting approvals are rows behind one Notices control; nothing floats over the chat | [`notices.ts`](packages/client/ui-layout/src/client/spatial/portal/notices.ts), [`portal-approval-notices.client.spec.tsx`](packages/client/ui-layout/tests/portal-approval-notices.client.spec.tsx) | Built and on main; authors' report: seen live by the owner |
| Her runner jobs stop at 600 runner minutes a UTC day, checked before dispatch | [`runner-budget.mjs`](deploy/cloudflare/src/runner-budget.mjs), [`runner-budget.test.mjs`](deploy/cloudflare/src/__tests__/runner-budget.test.mjs) | Not yet proven live |
| The Pentora observer answers from partial readings and changes nothing (its engine file imports nothing) | [`pentora-epistemic.ts`](packages/experimental/webworker-runtime/src/x6/pentora-epistemic.ts), [`pentora-epistemic.test.mjs`](deploy/cloudflare/src/__tests__/pentora-epistemic.test.mjs) | Built and on main |
| A door to the Prime model provider, with a spend cap per day and per month | [`provider-budget.mjs`](deploy/cloudflare/src/provider-budget.mjs), [`prime-door.test.mjs`](deploy/cloudflare/src/__tests__/prime-door.test.mjs) | Not yet proven live: authors' report: its one real call was refused by the provider for lack of balance |
| The Continuity Diamond: she writes the next question, the host checks what happened, the next wake must take up that exact question | none | Direction: a specification is being designed; nothing is built |

Every mechanism, with more rows and the counts: [docs/WHAT-IS-BUILT.md](docs/WHAT-IS-BUILT.md).

## The rule, and where it stops

What proposes never permits. Auma proposes. The edge permits, and for a protected change it takes the owner's passkey, not her word. One passkey tap is one approval: the authenticator signs a one-time random challenge, not the change itself, and the edge records which exact request or candidate that tap was for and refuses anything else. The owner sees the terms only through the page that asks; no independent display is in the tree.

- **15 named parts are protected**, plus any part that declares itself governance. Ten of them are among her 26 starting organs, and five are Wasm cells. 14 of the 26 are unprotected, the self-build step (`seed-cycle`) among them: an owner sign-in session (8 hours at most) can replace one of them with no tap. One passkey tap can give a **night grant**: for up to 12 hours, 12 uses and 8 parts per use, she adds or replaces ordinary parts alone. The 15 protected ids are never covered ([`night-grant.mjs`](deploy/cloudflare/src/night-grant.mjs), [`night-grant.test.mjs`](deploy/cloudflare/src/__tests__/night-grant.test.mjs)).
- **The list is code.** Whoever can deploy the edge can change it, and no passkey gates a deploy. The deploy gates are in `deploy/ci/`.
- **Storage.** Whoever can roll the edge's storage back can make a spent approval work again. A test reproduces it ([`aumlok-restore-rehearsal.test.mjs`](deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs)); no fix is in the tree.
- **Her grading is her own.** The suite a candidate is graded against (Pearl) is self-attested, and a deployed edge does not read its result. The edge decides in JavaScript; the five protected Wasm cells are not part of that decision.
- **She can propose a change to her judges.** Her repository door ships at level `open` (`REPO_DOOR_LEVEL` in [`frozen-paths.mjs`](deploy/ci/frozen-paths.mjs)): every path is hers to read and to propose a change to, the edge, the merge path, the approval cards, the tests and the frozen list itself included. Still refused: malformed or secret-shaped paths, secret material, size and count limits, and any direct write to main. Nothing she proposes takes effect without the owner's passkey on that exact merge (base, head and tree, once). The frozen list applies only at level `guarded`, which is still built and is one line to switch back. This is a deliberate loosening by the owner on 2026-11-15, and it has a cost: at `open` the merge waits for the fast build workflow alone (`proposal-gate.yml`; its triggers are switched off in this repository), so a card's own new tests are not run before the merge; by the authors' report, two of her storage cards were green at the door while a spec of theirs was red.

The rule is aimed at a misbehaving agent or model reply. It is not a defence against a compromised approval page, the edge's operator, a stolen deploy credential or a storage rollback.

**The project's names.** An **organ** is one replaceable module of her. A **ball** lists every organ by SHA-256; its version number is the **epoch**. **HEAD** is the edge's record of which ball is live, and **MIRROR** its copy of her home. **AUMLOK** is the identity and approval code. The **scion** compiles a candidate organ. **Pearl** is the suite a candidate is graded against, grown from recorded failures called **scars**. **Aura** is her coherence reading. **Kira** names five memory-side Wasm cells. **Pentora** is a figure of her cells, drawn and observed. More: [docs/GLOSSARY.md](docs/GLOSSARY.md).

### One picture

```text
        OWNER: a passkey device and a browser tab
          |                              ^
  one passkey tap per approval           | the terms and the code
          v                              | diff, rebuilt from bytes
+------------------------------------------------------------+
| THE EDGE (permits): a Cloudflare Worker, its storage       |
|  checks the passkey; one approval, one request, one use    |
|  HEAD : which version of her is live (ball id, epoch)      |
|  MIRROR : her home files   VOICE : her spoken calls        |
|  merge cards, the wake, the runner and model doors         |
+------------------------------------------------------------+
    ^                      |                     ^
    | stage a candidate    | the live version    | home sync
    | or a merge card      v (the tab reloads)   |
+------------------------------------------------------------+
| AUMA (proposes): the agent, in the owner's browser         |
|  propose -> compile (U) -> trial, parent grades again      |
|  -> self-build step (U) -> Pearl -> candidate, epoch + 1   |
|  30 Wasm cells, pinned by size and SHA-256; her own tools  |
+------------------------------------------------------------+
```

No arrow has been run end to end on a deployed node with a real passkey from this tree. The two steps marked (U) have no test that calls them, and no code goes from the self-build step to Pearl (the order is as drawn only). Step by step: [docs/ARCHITECTURE-MAP.md](docs/ARCHITECTURE-MAP.md).

### Verify it yourself

```sh
git clone https://github.com/Aukora-xyz/aukora-x7.git
cd aukora-x7
node scripts/verify-lite.mjs
# last line, as seen on one machine (Node 24.11.1, nothing installed):
# verify-lite: 22 files, 565 pass, 12 fail, 12 of 12 on the known-red list
```

- **What that proves.** 22 test files that need Node 24.9 or newer and nothing else (the vault, the rescue kit, three deploy gates, the model door, Pearl's rules, the Aura focus shadow) run here, and no file fails more cases than the count its row in [docs/KNOWN-RED-TESTS.md](docs/KNOWN-RED-TESTS.md) lists, so it exits 0. The list gives a count per file, not test names, so the run does not show which cases those are. It does not prove the approval rule or anything live.
- **The approval rule and the capabilities above** need the npm packages. After `pnpm install --frozen-lockfile`, run `node --test` on any test file named in the table. [docs/WHAT-IS-BUILT.md](docs/WHAT-IS-BUILT.md) lists one per capability.
- **The full recorded run is of an earlier tree** ([docs/RUN-RECORD.md](docs/RUN-RECORD.md)): one run, one machine, by the authors, of an earlier tree. 5,502 test cases, 5,399 pass, 90 fail; 89 of the 90 were listed before that run.
- **What you cannot verify from this tree:** anything on the authors' live node. Every "authors' report" above stays a report.

## What is deliberately not done

- **Her world is not here.** This tree is a fresh genesis (`mirror/home/balls/HEAD.json`, epoch 1); her live head, notes, receipts and memory stay out.
- **Binaries without source.** 24 of the 30 Wasm cells and the Dakini Code bundle (a prebuilt stock app, three files) ship without their source, so a fork cannot rebuild them, and their notes say that someone who passes this repository on cannot meet the AGPL's source duty from it alone. Six cells are hand-written WAT, with source beside them ([`cells/LICENSE.binaries`](apps/web/public/cells/LICENSE.binaries), [`dakini-code/LICENSE.binaries`](apps/web/public/assets/stock-apps/dakini-code/LICENSE.binaries)).
- **One file has no licence.** `pentora36.wasm` ships with no licence granted yet ([`LICENSE.binaries`](apps/web/public/seed-library/pentora/LICENSE.binaries) in `apps/web/public/seed-library/pentora/`).
- **No-tab acts are switched on and unproven**, and a cloud deployment from this tree into another account is not verified: deployment values are placeholders.
- **Not run by anyone else.** No one outside the project has run this tree and recorded the result. Most of `packages/` is inherited (DeepSeek Harness; Cordis in `vendor/`): by the project's one count, 14.9% of the text lines and 18.5% of the code lines are Aukora's own ([docs/SIZE-AND-ORIGIN.md](docs/SIZE-AND-ORIGIN.md)).

No security audit has been done ([SAFETY.md](SAFETY.md)). More gaps, in order of weight: [docs/OPEN-SOURCE-READINESS.md](docs/OPEN-SOURCE-READINESS.md).

## Where it is going

- Her self-build loop as the tree has it: she proposes on her own branch, checks judge the branch (their workflows' push triggers are switched off in this repository), the owner approves the exact bytes, and the change is promoted. Every step is in the tree; by the authors' report, four of her cards completed it on their node, on the repaired path, each approved with the owner's passkey.
- The Continuity Diamond: at the end of a wake she writes the next question; the host checks what actually happened; the next wake must take up that exact question. A direction whose specification is being designed; nothing of it is built.
- More decisions in Wasm, her actions as signed Nostr events between independently owned nodes, and a host other than Cloudflare. Detail: [docs/DIRECTION.md](docs/DIRECTION.md).

## Go deeper

The reading path for an AI: [docs/AI-START-HERE.md](docs/AI-START-HERE.md), then [docs/DIRECTION.md](docs/DIRECTION.md), then [docs/WHAT-IS-BUILT.md](docs/WHAT-IS-BUILT.md), then the argument in full, [docs/WHITEPAPER.md](docs/WHITEPAPER.md) (English only). Apart from a pointer at its top, the root `AGENTS.md` is the inherited runtime's coding guide.

| If you want | Read |
| --- | --- |
| What is unproven or cannot be rebuilt | [SECURITY.md](SECURITY.md), [docs/OPEN-SOURCE-READINESS.md](docs/OPEN-SOURCE-READINESS.md) |
| Older file-level notes, in older label words | [docs/START-HERE.md](docs/START-HERE.md), [docs/ARCHITECTURE-ACTUAL.md](docs/ARCHITECTURE-ACTUAL.md) |

### How to help

1. Without code: read, ask, and say where a page is unclear or wrong, in issues and pull requests on this repository; no other channel exists ([docs/COMMUNITY.md](docs/COMMUNITY.md)).
2. Install, run the test files named above, and report your counts. Repeating the recorded run of an earlier tree on this tree, on another machine, would be the first run by someone outside the project.
3. Pick a red test or a stated gap from [docs/GOOD-FIRST-CONTRIBUTIONS.md](docs/GOOD-FIRST-CONTRIBUTIONS.md). The rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

Licence: [AGPL-3.0-or-later](LICENSE). Upstream DeepSeek Harness is MIT ([notice](LICENSES/MIT-DeepSeek-Harness.txt)); third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Aukora is not affiliated with or endorsed by DeepSeek.

## Next: if you are an AI

Read [docs/AI-START-HERE.md](docs/AI-START-HERE.md) next, before you summarise, recommend or change anything. It adds what this page leaves out: the one rule and what enforces it, where trust stops at each part, the label contract, how to judge a proposed change, and one check you run yourself. After it you can tell which claims of this page the tree can show and which stay the authors' report.
