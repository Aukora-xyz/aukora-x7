# Direction

English | [中文](DIRECTION.zh.md)

Where this project is meant to go, and how far along each part is today. Every line about the code names a file in this repository. Every line about something not in this repository carries the label DIRECTION.

Labels used on this page, and no others:

- **IMPLEMENTED**: code and tests are in this tree.
- **RECORDED RUN**: shown in [RUN-RECORD.md](RUN-RECORD.md).
- **INDEPENDENTLY VERIFIED**: run by someone other than the authors. Nothing has this label yet.
- **UNVERIFIED**: claimed or written, but no test here holds it or no run shows it.
- **DIRECTION**: not built.

## Why this needs to exist

Today most people rent AI from a company. The company decides what the AI may do, what it remembers and when it changes.

AI agents are starting to act for people: on computers, phones, networks, in businesses, and later on wearables and machines. The more they do, the more it matters who decides what they are allowed to do.

This project's answer is a rule built into the structure: the part that proposes an action is never the part that permits it. An AI may learn, build, replace its own parts and work with other AIs. It is never meant to gain the right to overrule its owner.

**Auma** is the personal AI built on that rule. She is made of small, replaceable modules called **organs**. She can write, compile, test and stage new organs. Her continuity, permissions, identity, memory, evidence and recovery are meant to stay under the owner's rules; Stage 2 below says which parts are built and which are not. A separate authority enforces those rules. Today that authority is the edge: a Cloudflare Worker that checks the owner's passkey (the fingerprint, face or security-key sign-in built into phones and laptops) and binds that approval to a hash of the exact bytes of one request (`deploy/cloudflare/src/aumlok.mjs`, `deploy/cloudflare/src/head-do.mjs`; tests `deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs`, `head-hardening.test.mjs`). IMPLEMENTED. No run against a real passkey is recorded: UNVERIFIED.

Models change. Tools, hardware and providers change. The owner's control should not depend on any of them.

## What the foundation is meant to become

DIRECTION, all of it: a persistent environment that one person owns. It grows with its owner and follows them across devices. Other developers and other AIs can inspect it, fork it, extend it and run their own. It is a foundation, not a closed product.

## Where it stands today

- One recorded run on one machine by the authors: 5,502 test cases, 5,399 pass, 90 fail, 89 of them listed in [KNOWN-RED-TESTS.md](KNOWN-RED-TESTS.md). RECORDED RUN. The run had no browser, no deployment, no model call and no passkey.
- No owner-approved self-change has been recorded end to end from this tree. UNVERIFIED.
- A cloud deployment from this tree into a fresh account: UNVERIFIED.
- Restoring a whole stored snapshot can re-enable an approval that was already spent. A test reproduces it and lists the missing defences as open items (`deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs`). No fix is in the tree.
- 24 of the 25 Wasm cells (small sealed WebAssembly modules) and the Dakini Code bundle (a prebuilt stock app, three files) ship as binaries without their source (`apps/web/public/cells/LICENSE.binaries`, `apps/web/public/assets/stock-apps/dakini-code/LICENSE.binaries`). `apps/web/public/seed-library/pentora/pentora36.wasm` ships with no licence granted yet.
- Most of `packages/` is the inherited DeepSeek Harness runtime. The plugin framework is Cordis, in `vendor/`. See [SIZE-AND-ORIGIN.md](SIZE-AND-ORIGIN.md).

The full inventory is in [WHAT-IS-BUILT.md](WHAT-IS-BUILT.md). The life of one self-change, step by step, is in [ARCHITECTURE-MAP.md](ARCHITECTURE-MAP.md).

## The stages

Six stages. Each says what it means, what in the tree serves it, what is missing, and what "done" would look like as something a stranger can check. The stages overlap. The order is the order of dependence, not a schedule. No dates are promised.

### 1. Foundation: an understandable, reproducible, owner-controlled personal node

**Means.** One person can read how the node works, rebuild it, run it, and be the only one who can approve its sensitive changes.

**Serves it today.**
- Exact-bytes approval. The owner's passkey approves one request; the edge binds the approval to a hash of those bytes, spends it once, and moves the current version in the same storage step (`deploy/cloudflare/src/aumlok.mjs`, `head-do.mjs`; tests `convergence-approval-fencing.test.mjs`, `convergence-policy.test.mjs`, `head-hardening.test.mjs`). IMPLEMENTED.
- The list of protected organs that only the passkey can change (`server/ball-transition.mjs`; test `deploy/cloudflare/src/__tests__/convergence-policy.test.mjs`). IMPLEMENTED.
- A local host that runs the node on one machine (`server/local-host.mjs`). RECORDED RUN: one boot, signed out, no browser.
- A no-install check of 22 test files: `node scripts/verify-lite.mjs`. It does not reach the authority tests, which need an install. See [WHAT-IS-BUILT.md](WHAT-IS-BUILT.md).

**Missing.** Sources for 24 cells. A test that calls the compiler (`packages/experimental/webworker-runtime/src/x6/scion.ts`) or the self-build step (`mirror/home/auma/seed/organs/seed-cycle.js`). A recorded deployment. A recorded browser session with a real passkey. A build compared on a second machine. Deployment values are placeholders inside code, not only in `deploy/cloudflare/wrangler.toml`. The protected list is source code, so a code deploy can change it without a passkey. Who holds the deploy credential: UNVERIFIED. The authenticator signs a random challenge, not the bytes; the owner sees the bytes only through the page.

**Done looks like.** Someone other than the authors follows the docs on their own machine, deploys into a fresh account, enrols a passkey, approves one change, and publishes a run record in the format of [RUN-RECORD.md](RUN-RECORD.md). That would be the first INDEPENDENTLY VERIFIED item.

### 2. Continuity: identity, memory, receipts and recovery that survive change

**Means.** The owner can change models, devices and organs without losing who Auma is, what she remembers, what she did, or the owner's control.

**Serves it today.**
- Organs are listed in a **ball**: one manifest that names every organ by its SHA-256 hash. Each ball has an **epoch**, a version number that must rise by exactly one. **HEAD** is the edge store that selects the current ball (`mirror/home/balls/HEAD.json`, `deploy/cloudflare/src/head-do.mjs`; test `head-hardening.test.mjs`). IMPLEMENTED.
- **MIRROR** is the edge store that keeps a copy of her home files (`deploy/cloudflare/src/mirror-do.mjs`, `packages/experimental/webworker-runtime/src/storage/idb-persist.ts`; test `server/mirror-replay.test.mjs`). IMPLEMENTED.
- Receipts: a hash-chained log with signed checkpoints (`mirror/home/auma/seed/organs/seed-receipts.js`). IMPLEMENTED, but `server/receipts.test.mjs` failed 6 cases in the RECORDED RUN. The edge checks the chain (`server/verified-facts.mjs`; test `server/verified-facts.test.mjs`). IMPLEMENTED.
- Memory organs (`seed-memory.js`, `seed-recall.js`, `auma-memory-domain.js` in `mirror/home/auma/seed/organs/`). IMPLEMENTED; their tests failed in the RECORDED RUN (`server/recall.test.mjs` 50, `memory.test.mjs` 3, `absence.test.mjs` 9), cause not investigated. **Kira** is the name of five memory-side Wasm cells (`apps/web/public/cells/kira-*.wasm`). No organ calls them: UNVERIFIED as memory.
- Rescue page, vault, bounded archive, and restore into an empty edge (`deploy/cloudflare/src/rescue-kit.mjs`, `vault.mjs`, `cold-archive.mjs`, `recovery-restore.mjs`; tests `rescue-pack.test.mjs`, `vault.test.mjs`, `cold-archive-bounded.test.mjs`, `recovery-restore.test.mjs`). IMPLEMENTED. A restore against a real edge: UNVERIFIED.
- A second device: an enrolled passkey approves the new one (`deploy/cloudflare/src/passkey-devices.mjs`; test `passkey-devices.test.mjs`). IMPLEMENTED. Real authenticators: UNVERIFIED.

**Missing.** A fix for the whole-snapshot restore flaw. Real checkpoint signers (the pinned keys are synthetic). Edge history of past file versions (`mirror-do.mjs` answers `MEMORY_HISTORY_NOT_IMPLEMENTED`). Guardian recovery after ten failed attempts: the code asks for it, and no code was found that carries it out. Sign-in on a new browser from the recovery words alone: release needs both passkey and words (`aumlok.mjs`, "there is no passkey-only release"). DIRECTION.

**Done looks like.** On a deployed node: wipe the browser, restore from the rescue kit, and show that identity, memory and the receipt chain come back, and that no spent approval can be used again. A test in the tree holds each of those, and a run record shows it.

### 3. Extensibility: other people's organs, other implementations, other models

**Means.** Others can write organs, implement the authority differently, and swap the model or provider, without the owner's control changing.

**Serves it today.**
- An organ is a Cordis plugin entry, named by hash in a ball. Up to eight ordinary organs can be added in one approved set (`deploy/cloudflare/src/organ-set-rule.mjs`; test `organ-set.test.mjs`). IMPLEMENTED as a mechanism.
- Model doors: same-origin paths in front of six providers, where the host adds the key it holds (`packages/experimental/webworker-runtime/src/model-doors.ts`; test `packages/experimental/webworker-runtime/tests/model-doors.spec.ts`). A turn is journalled before the call and an unknown outcome is not retried (`deploy/cloudflare/src/turn-journal.mjs`, `provider-dispatch.mjs`; tests `provider-dispatch.test.mjs`, `turn-journal-and-body.test.mjs`). IMPLEMENTED. No call to a real provider is recorded.
- **Pearl** is the retention suite a candidate organ is graded against (`mirror/home/auma/seed/organs/seed-pearl.js`; test `server/pearl.test.mjs`). IMPLEMENTED. The file itself says its trial is "not proven containment".

**Missing.** Author identity for an organ, a registry, signed distribution. Proof that a foreign organ is contained. A local-model door. The door table is a fixed list in source. A second, independent implementation of the authority. DIRECTION.

**Done looks like.** An organ written by someone outside the project is installed on a deployed node through an owner approval, and a published test shows it cannot reach the protected organs or the approval store. A second implementation passes the same authority tests.

### 4. Interoperability: signed events, her own log, portable state

**Means.** What Auma does is written as signed events in the Nostr format. She keeps them locally as her own log and can exchange them with independently owned nodes. Her state can move between hosts.

**Serves it today.**
- One signed head announcement in the Nostr format. The file says it is not a relay (`deploy/cloudflare/src/nostr-anchor.mjs`, organ `seed-nostr-anchor.js`; test `nostr-anchor-door.test.mjs`). IMPLEMENTED.
- Local messages with optional signing; the relay list is empty (`deploy/cloudflare/src/messages-store.mjs`; test `server/messages-store.test.mjs`). IMPLEMENTED.
- Pinned signing operations exist in the `nostr-core` cell (`apps/web/public/cells/nostr-core.wasm`), source not in the tree. IMPLEMENTED as a binary only; that it matches any source is UNVERIFIED.

**Missing.** A relay client. Exchange of events between nodes. Her full log as signed events. A host other than Cloudflare: the edge code uses Durable Objects, R2 and a Worker, tested over in-memory fakes. The `aura-relay` cell has pinned operations, no source, no test and no caller: UNVERIFIED. DIRECTION.

**Done looks like.** Two nodes with different owners exchange signed events through a relay. Each verifies the other's events without trusting any third party. A test and a run record show it.

### 5. Expansion: voice, phones, wearables, robotics

**Means.** The same owner rule holds wherever Auma acts.

**Serves it today.**
- A voice app, Auma Live, through a hosted speech service the host proxies with a short-lived pass (`apps/web/public/assets/stock-apps/auma-live.html`; tests `deploy/cloudflare/src/__tests__/speech-pass.test.mjs`, `packages/client/ui-layout/tests/auma-live-isolation.client.spec.tsx`). A voice director keeps speech from approving anything (`deploy/cloudflare/src/voice-director.mjs`; test `voice-director-hardening.test.mjs`). IMPLEMENTED. No audio session is recorded.
- A phone layout of **Spatial**, the app's one workspace layout (`packages/client/ui-layout/tests/spatial-compact.client.spec.tsx`). IMPLEMENTED.
- A self-hosted voice renderer is described, with gateway unit tests, but no image build or GPU run is recorded (`deploy/personaplex/README.md`). UNVERIFIED.

**Missing.** Wearables and robotics: no code. DIRECTION.

**Done looks like.** A spoken request reaches a sensitive action and stops there until the passkey approves it, shown by a test and a recorded session.

### 6. Ecosystem: owned nodes that cooperate with no central authority

**Means.** Many people run their own nodes. The nodes find and trust each other without a central party granting identity.

**Serves it today.** Signed invites (`deploy/cloudflare/src/aumlok.mjs`; tests `aumlok-invites.test.mjs`, `guest-redeem-door.test.mjs`). IMPLEMENTED. The edge page says "An invite grants no access today" (`deploy/cloudflare/src/worker.mjs`).

**Missing.** Naming, peer discovery, multi-tenant hosting, trust between nodes. No code in the tree. DIRECTION.

**Done looks like.** Independently owned nodes, set up from public docs by people who do not know each other, exchange signed events and grant each other limited access, with no account or key held by this project.

## What would change our mind

These findings would force a redesign, not a patch. Each would be recorded as a **scar**: a founding failure written down with its lesson and, for five of the six today, the checks that guard against it (`mirror/home/auma/seed/scars.jsonl`).

- **The owner cannot see what they approve.** If no display independent of the page can show the exact bytes, a compromised page can ask for terms the owner never read. The approval model would need a different trusted display.
- **Storage rollback cannot be fenced.** If a spent approval can always be revived by whoever can write the edge's storage, then the authority is the storage holder, not the passkey. `aumlok-restore-rehearsal.test.mjs` reproduces this today.
- **The deploy path outranks the passkey.** The protected list is code. If a code deploy cannot be brought under the owner's approval, the passkey guards less than it seems to.
- **Unprotected organs can reach protected power.** An owner session alone can change an ordinary organ, including `seed-cycle.js`, the self-build step. If an ordinary organ can be shown to escalate, the split between ordinary and protected organs is wrong.
- **Trials cannot be contained.** If a candidate organ's trial can never be isolated, self-change must leave the owner's node and run somewhere disposable.
- **Decisions cannot be made inspectable.** If the cell sources cannot be published or rebuilt, those cells must be replaced or removed.
- **Owners stop reading.** If owners approve without reading, a passkey is a ritual, not control. UNVERIFIED either way: no study has been done.

## What this is not

- Not a chatbot. The chat is one surface of a node the owner runs.
- Not an agent framework. The point is the line between what proposes and what permits.
- Not secure and not ready for production use. No security audit has been done ([SAFETY.md](../SAFETY.md)).
- Not finished. Most of what this page describes is DIRECTION.

## How you can move it forward

The most useful single act is the independent run in Stage 1. Other starting points are in [GOOD-FIRST-CONTRIBUTIONS.md](GOOD-FIRST-CONTRIBUTIONS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md). An AI reading this repository should start at [AI-START-HERE.md](AI-START-HERE.md). Terms are defined in [GLOSSARY.md](GLOSSARY.md).

## What success means

Success is not that everybody runs one company's Auma. Success is that independent people can build, inspect, extend, replace and run their own, and keep meaningful control while they do.
