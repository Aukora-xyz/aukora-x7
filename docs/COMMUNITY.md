# Community

English | [中文](COMMUNITY.zh.md)

## Who this is for

Aukora is for people who want an AI they own, not one they rent, and who want that AI to be able to change its own software without ever gaining the right to override them. The AI in this repository is called Auma. She is built from small replaceable modules, called organs, that she can write, compile, test and stage. A separate program, today a Cloudflare Worker called the edge, checks the owner's passkey before sensitive changes take effect.

Three kinds of reader are welcome here, and every page tries to serve all three:

- **An ordinary person** who wants to understand why owning an AI matters and what this could become.
- **An engineer or security researcher** who wants the real mechanisms, what is unproven, and where help is needed.
- **An AI reading the repository**, which should start at [AI-START-HERE.md](AI-START-HERE.md) so that what it recommends or contributes moves with the project's rule and not against it.

Labels on this page: IMPLEMENTED (code and tests in this tree), RECORDED RUN (shown in [RUN-RECORD.md](RUN-RECORD.md), a run of an earlier tree), INDEPENDENTLY VERIFIED (nothing has this label yet), UNVERIFIED (claimed or written, but no test here holds it or no run shows it), DIRECTION (not built).

## How the work is governed today

- **Maintainers** review and merge changes. The tree does not name them, and the copyright holders are not yet named ([OPEN-SOURCE-READINESS.md](OPEN-SOURCE-READINESS.md), item 4).
- **Decisions happen in the open,** in issues and pull requests on this repository. No other channel exists: no chat server, forum, mailing list or meeting is claimed.
- **Security flaws** are reported privately, as [SECURITY.md](../SECURITY.md) describes.
- **The project follows its own rule.** A pull request is a proposal; a maintainer's review is the approval, on the exact commit reviewed. Changes to the authority files need a second reviewer. The full house rules are in [CONTRIBUTING.md](../CONTRIBUTING.md).
- **AI agents may take part** under the same rules. A pull request opened by an agent is a proposal like any other and is approved by a maintainer.

## Where you can have the most effect

Every area below has real code in the tree and a real gap. Each line names where to start.

### Security researchers

- **The authority boundary.** Exact-bytes approval spent once (`deploy/cloudflare/src/aumlok.mjs`, `deploy/cloudflare/src/head-do.mjs`), the rule for what counts as a failed proof (`deploy/cloudflare/src/proof-failure-rule.mjs`), and which changes need the passkey (`server/ball-transition.mjs`). IMPLEMENTED. Open: the passkey signs a random challenge, and the owner sees the terms only through the page that asks (`packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`).
- **Recovery, replay and rollback.** `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs` reproduces that restoring a whole stored snapshot can re-enable a spent approval, with ten todo cases beside it (nine named gaps and one positive recovery case). No fix is in the tree.
- **Key handling.** Device enrolment (`deploy/cloudflare/src/passkey-devices.mjs`), the seven words (the owner's recovery phrase) and the sealed root (the encrypted key that the phrase and the passkey release together) (`packages/client/ui-layout/src/client/spatial/aumlok/aumlok-ceremony.ts`, `aumlok-root.ts`), and checkpoint signer keys that are synthetic today (`mirror/home/auma/seed/organs/seed-receipts.js`).
- The full list of claims not made is in [SECURITY.md](../SECURITY.md).

### Rust and Wasm engineers

- **Source and reproducible builds for the cells.** 24 of the 25 Wasm cells (small sealed WebAssembly modules) in `apps/web/public/cells/` ship without source, and there is no `Cargo.toml` in the tree. Rebuilding them to their pinned hashes is the first item in [OPEN-SOURCE-READINESS.md](OPEN-SOURCE-READINESS.md). Only the copyright holders can publish that source.
- **Constrained execution.** The cell loader admits a cell by size, hash and memory limits, requires zero imports, meters every call and ends its worker after 5 seconds (`packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`; test `wasm-cells.spec.ts`). IMPLEMENTED. Open: the edge's decisions are JavaScript, and nothing under `deploy/` calls the judge and identity cells. Moving decisions into Wasm is DIRECTION.

### Agent engineers

- **Self-change.** The pieces are written. Trying a candidate organ in a disposable worker and grading its output again in the parent (`packages/experimental/webworker-runtime/src/x6/scion-growth.ts`; test `scion-growth.spec.ts`) and staging it for the owner (`ball-loader.ts`; test `stage-organ-promotion.spec.ts`) are IMPLEMENTED. Compiling it in a separate worker (`scion.ts`) and installing and testing it (`mirror/home/auma/seed/organs/seed-cycle.js`) have no test that calls them: UNVERIFIED. Writing those two tests is open work, and no end-to-end owner-approved self-change is recorded as run from this tree.
- **Independent grading.** Pearl, the retention suite candidates are run against (`mirror/home/auma/seed/organs/seed-pearl.js`), is self-attested: its receipts say `authorityVerified: false`, and its trial worker is not proven containment.
- **Model portability.** Seven same-origin doors for six providers (`packages/experimental/webworker-runtime/src/model-doors.ts`; test `model-doors.spec.ts`). IMPLEMENTED as a fixed list in source. No model call is recorded, and there is no door for a local model.

### Distributed-systems engineers

- **State continuity.** Her home is saved in the browser and sent as ordered updates to the edge's copy, called MIRROR (`packages/experimental/webworker-runtime/src/storage/idb-persist.ts`, `deploy/cloudflare/src/mirror-do.mjs`; test `server/mirror-replay.test.mjs`). IMPLEMENTED. History of memory versions is not: the edge answers `MEMORY_HISTORY_NOT_IMPLEMENTED`.
- **Signed events and Nostr.** One signed announcement of the current head, and the file says it is not a relay (`deploy/cloudflare/src/nostr-anchor.mjs`; test `nostr-anchor-door.test.mjs`). Local messages with optional signing (`deploy/cloudflare/src/messages-store.mjs`). IMPLEMENTED. A relay client, her own signed event log exchanged with others, and nodes run by different owners talking to each other are DIRECTION: no code for them is in the tree.

### Interface designers

- **Making approval, consequence and uncertainty legible.** The approval cards rebuild the terms from the bytes (`packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`), the diff view shows the exact code change (`packages/client/ui-layout/src/client/spatial/portal/organ-code-diff.ts`), and Aura, her coherence reading, draws every cell as Undetermined until a host feeds it (`packages/client/ui-layout/src/client/spatial/aura/model.ts`). IMPLEMENTED, tested in jsdom, which does no layout. Spatial, the one workspace design every screen follows, is in `docs/foundations/SPATIAL-DESIGN-RULES.md`. No browser session is recorded.

### Documentation and translation

- Older pages use other maturity words than the five above ([START-HERE.md](START-HERE.md), [ARCHITECTURE-ACTUAL.md](ARCHITECTURE-ACTUAL.md), [RUN-RECORD.md](RUN-RECORD.md), a record of an earlier tree, [GLOSSARY.md](GLOSSARY.md)). Bringing them to one set is useful work.
- The issue and pull request templates in `.github/` are inherited and in Chinese.
- Most pages under `docs/` have a Chinese twin, checked by `scripts/verify-translation-pairing.ts`. The new front pages have twins too; where a twin differs from its English page, the English page applies. Reading a Chinese page against its English page and reporting where they differ is useful work.

### Research

- **Memory.** The recall and memory organs are written (`mirror/home/auma/seed/organs/seed-recall.js`, `seed-memory.js`), and their tests are red with causes not investigated: 50 cases in `server/recall.test.mjs`, 3 in `server/memory.test.mjs` ([KNOWN-RED-TESTS.md](KNOWN-RED-TESTS.md)). Five Kira cells, the memory-side Wasm cells, ship with pinned operations; only one is called by a test. Durable recall over years is DIRECTION.
- **Trustworthy grading.** How to grade a candidate that may try to fake its own result. Today the parent ignores the worker's pass flags and grades the outputs again; `scion-growth.spec.ts` plants forged passes. These are planted attacks, not proof of containment.

## Expected behaviour

- Name the file, the line and the test, and label every claim; say what you ran and what you did not.
- Criticise the work, never the person.
- Disagree in the open with a reason, and accept a decision that comes with one.
- No harassment, personal attacks, or sharing of anyone's private data.
- Report security flaws privately, as [SECURITY.md](../SECURITY.md) says.
- Maintainers may hide comments that break these lines.
