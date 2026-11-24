# Aukora X7

X7 is the public source export of a personal AI node. It contains browser proposal code and separate owner checks on the protected paths described below; this checkout has not demonstrated a fresh, owner-approved deployment. New here? Read [Start here](docs/START-HERE.md).

**The quickest thing to try is [Aukora Core](https://github.com/Aukora-xyz/aukora-core):** a five-frame sample record you can check offline with one command, no login and no keys.

## What you can run today

Use Node.js 24.9 or newer. From the repository root, with nothing installed:

```sh
node scripts/probe.mjs
node scripts/verify-lite.mjs
```

Last run by the maintainers on the tree this commit was made from (macOS, Node.js 24.11.1): `probe.mjs` exit 0; `verify-lite.mjs` exit 0, final line:

```text
verify-lite: 22 files, 565 pass, 12 fail, 12 of 12 on the known-red list
```

The probe checks that the claim paths exist and that fixture bytes match their manifest; it does not prove the claims. A zero exit from `verify-lite` means the failures stayed within the published allowances, not that every test passed, and its default run leaves out the authority tests that need installed packages. Use a Git checkout with a commit, Node.js 24, and the package-manager version pinned in `package.json` (pnpm 11.28.5). For an archive, set `DSH_CLIENT_COMMIT_HASH` to the known source commit, 7 to 40 hexadecimal characters. Use an unused local port; the example uses 4999.

```sh
pnpm install --frozen-lockfile --ignore-scripts
PORT=4999 node server/build-preview.mjs
```

When the maintainers built this exact tree before publication, both commands exited 0 and the build printed `Sealed 104 named immutable assets (completed-build).` The build reads the current Git commit and fails with `git rev-parse HEAD` in a downloaded archive or an empty `git init` unless `DSH_CLIENT_COMMIT_HASH` is set. These checks did not boot the app in a browser, sign anyone in or exercise an owner-approved merge.

## The bundled Core snapshot

[`aukora-core/`](aukora-core/) is a snapshot of the public Core repository. The X7 app does not invoke the sample reader. Its sample reader replays a disclosed record, checks the result against an expected head (a fingerprint of the record) and shows what was approved. It does not show that any outside action happened.

```sh
node aukora-core/examples/read-record.mjs aukora-core/examples/sample-record.txt --expect-head "$(cat aukora-core/examples/sample-record.head)"
```

Last run on this tree: exit 0, printing `head matches the expected head`. The same sample with its last frame removed: exit 3, printing `HEAD MISMATCH: expected e258bcc3f72d59da3307ed09a354493266f1…`. The expected head here ships in the same repository, so this only shows the mechanism; for a record you are handed, get the expected head from a source its sender does not control.

See [Shipped binaries](docs/SHIPPED-BINARIES.md) for the byte sizes, SHA-256 digests and source availability of the listed prebuilt browser assets. The bundled Core counts on that page describe the snapshot alone.

To understand the design: [Architecture](docs/NODE-ARCHITECTURE.md) (node, owner and approval boundaries), [Thread sync and restore](docs/THREAD-SYNC-AND-RESTORE.md) and the [Threat model](docs/THREAT-MODEL.md), each with the source files and tests it rests on.

## What we built on

The project's file inventory calls about 90% of entries inherited unchanged from the DeepSeek Harness baseline before publication rewrites; this is not 90% of code or an independent estimate. See [size and origin](docs/SIZE-AND-ORIGIN.md). Start with these six parts of the Aukora layer:

- `deploy/cloudflare/src/` — edge, approvals, state and storage.
- `server/` — local host and admission rules.
- `mirror/home/auma/seed/` — the starting modules, not private history.
- `packages/experimental/webworker-runtime/src/x6/` — browser loading, cells and compilation.
- `packages/client/ui-layout/src/client/spatial/` — the Spatial app.
- `apps/web/public/cells/` — 30 cells, six with matching WAT; 24 ship without source in this tree.

The export is intended to omit private runtime state and credentials. It includes fixtures and fresh genesis data; release contents are subject to the exact-tree privacy check. A fresh deployment and full recovery of the same agent with owner authority are not demonstrated. The seven words are not a standalone backup or login. [Architecture](docs/ARCHITECTURE-MAP.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

## Details

In the source, Auma proposes changes. To select a protected module replacement, HEAD checks the owner’s approval for the candidate ball and changed entry. For a content-addressed module, the approval includes its byte digest.

Reviewed protected paths require the applicable owner authorization; hosting, the approval page and current storage are trusted.

This is a source export, not the running private node. Report any result against this exact revision.

## Tech at a glance

| Technology | What it does here | Files in this repository | Maturity |
| --- | --- | --- | --- |
| Nostr | After signing an empty-content kind 4871 witness event, the node attempts delivery to five named relays. The owner-approved kind 30078 announcement records the head at publication over HTTPS. Separate local Messages turns can be unsigned. | `deploy/cloudflare/src/witness.mjs`, `deploy/cloudflare/src/witness-do.mjs`, `deploy/cloudflare/src/nostr-anchor.mjs`, `deploy/cloudflare/src/messages-store.mjs` | BUILT-ON-MAIN |
| Bitcoin / OpenTimestamps | A usable calendar upgrade adds a Bitcoin attestation to the proof. The edge records `confirmed` and the claimed height. A later hourly tick can select the record for a separate check against the header’s Merkle root. Two explorers must agree on the block hash, which must meet the header’s stated target and have at least 72 leading zero bits. The lowest answering tip must give at least six confirmations. | `deploy/cloudflare/src/ots.mjs`, `deploy/cloudflare/src/bitcoin-header.mjs`, `deploy/cloudflare/src/witness-do.mjs` | BUILT-ON-MAIN |
| RFC 3161 | The witness accepts status 0 (granted) or 1 (granted with modifications) and checks for the signedData identifier and the digest and nonce byte strings in the reply’s ContentInfo. Authenticating the signed fields, signature and certificate chain requires a separate check. | `deploy/cloudflare/src/tsa.mjs`, `deploy/cloudflare/src/witness-do.mjs` | BUILT-ON-MAIN |
| WebAuthn | The edge verifies a user-verified assertion and binds its challenge to request or promotion terms. The supplied review cards present action-specific details. The edge relies on the requesting page to show the terms accurately. One-use enforcement depends on current storage history. | `deploy/cloudflare/src/aumlok.mjs`, `deploy/cloudflare/src/owner-grant-policy.mjs` | BUILT-ON-MAIN |
| Cloudflare Workers and Durable Objects | A Worker routes requests using four Durable Object class bindings for HEAD, MIRROR, voice and witness state. The witness object stores and serves timestamp proofs. R2 holds archives, vault blobs and nightly copies. | `deploy/cloudflare/wrangler.toml`, `deploy/cloudflare/src/worker.mjs` | BUILT-ON-MAIN |
| WebAssembly | Before compiling a cell, the browser rejects empty input, enforces the pinned size ceiling and compares the SHA-256 of the bytes with the pinned digest. The edge Kyber host receives a precompiled module. A separate Kyber test compares the artifact with its byte pin. Both hosts check the interface and memory and supply fuel. | `deploy/cloudflare/src/kyber-cell.mjs`, `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts` | BUILT-ON-MAIN |
| AES-256-GCM, HPKE and Reed–Solomon | The standalone module encrypts a file and wraps its data key with a supplied secret (v1) or for an X25519 recipient with HPKE (v2). With a trusted manifest, k distinct valid pieces recover ciphertext. Opening it requires the matching secret. | `deploy/cloudflare/src/sealed-shards.mjs` | BUILT-ON-MAIN |
| X-Wing hybrid key exchange | The experimental handshake combines X25519 and ML-KEM-768, checks Ed25519 and ML-DSA-65 signatures and requires an explicit peer-acceptance rule. With default randomness each peer generates a throwaway Ed25519 key pair per connection. The authenticated peer ID derives from the peer’s long-term public keys. Callers can supply their own randomness. Frames use AES-256-GCM. No node route calls it. | `deploy/cloudflare/src/fresh-link.mjs` | BUILT-ON-MAIN |
| ARK receipts | Three separately written readers check signed demo outcomes against the draft Ed25519 contract. The demo supplies test identities and a separate pins file. An outside verifier needs independently trusted owner and receiver pins. | `ark/CONTRACT.md`, `ark/ABOUT.md` | SYNTHETIC-PROOF |

## Why Nostr and Bitcoin here

A v2 witness record names the previous record digest (zeros at genesis), selected head and epoch, receipt log head and row count, two journal tips and the set name and SHA-256 from LATEST after the manifest’s digest, set name and complete flag check out. Null top-level facts carry reasons. An absent or empty journal has zero bytes and an empty tip. Version 1 omitted the nightly field.
When signing succeeds, the empty-content kind 4871 event names the record digest and sequence. After the first event, a tag links to the previous event ID. The relay can see the signer, timing and tags. An acknowledgement and a later read-back are separate observations.
For one signed commitment, obtain its record, event and an independently trusted node public key. To check continuity, obtain the preceding pairs back to genesis or an independently trusted checkpoint. The full-record public route ships off. Hash the canonical record with the example in `docs/auma/outside-witness.md`.
With dependencies installed, `verifyNostrEvent` in `deploy/cloudflare/src/messages-store.mjs` checks the event ID and signature. Check the trusted signer, kind 4871, empty content and consecutive sequence numbers. Require the exact ordered tag list: e (previous event ID) from sequence two onward, then seq, digest and chain (witness.v1), each once. Match the sequence and canonical digest to the validated full record. Its prev field is 64 zeros at genesis and the previous record digest thereafter.
The witness appends a random nonce to the record digest, hashes the result with SHA-256 and attempts to send that value to four calendars. At least two replies must pass individual checks. The witness combines the usable replies and records a pending stamp only after the combined proof passes its checks and is saved. Parse the saved record, hash its canonical UTF-8 JSON as shown in the guide, and compare that SHA-256 with the detached proof’s starting digest. Once the proof contains a Bitcoin attestation, verify that path against trusted Bitcoin chain data.
The edge’s separate header check can use a single answering tip for depth. It does not follow previous headers or determine the required difficulty at that height. A proof independently verified on the accepted chain establishes existence by that block. It supplies no evidence that the recorded actions happened.
An independently kept event or anchored proof lets its holder detect a later change to the record. After signing, the witness attempts to send the event to five relays. Its content field is empty. Its public tags identify the commitment. The witness also submits digests for timestamping. These requests require no Bitcoin wallet or on-chain payment by the node.
The authors’ node is private. A live restore from distributed pieces remains unverified. ARK uses test signers. Exchanging actions between independently owned nodes remains an idea.

**A proof you can run.** Run ARK acceptance from a checkout whose absolute path contains no whitespace. ARK acceptance requires Node 22 or newer, Go 1.26.5 or newer and `shasum`, no network: `cd ark && ./accept/run.sh`. Its last line, as seen on one machine by the authors (macOS arm64, Node 24.11.1, Go 1.26.5), begins `accept: 20 PASS, 0 FAIL`. Three separately written readers check the same 26 vectors (Node 15 of 15 self-tests; Go and Swift 26 of 26 each, on the same machine; the Swift verifier builds with macOS Swift and CryptoKit, and its vector script requires Python 3.9 or newer). Readers 1 and 2 come from models of one family; reader 2's author also read a hand-off note and part of a private design review; reader 3’s author reports consulting no reference implementation, and the project reports no audit of what that author read; reader 1's author wrote the contract and the vectors, and both were revised after the readers' questions ([`ark/ABOUT.md`](ark/ABOUT.md), [`ark/INDEPENDENCE.md`](ark/INDEPENDENCE.md)).

**Four maturity labels**, for what this repository itself can show:

| Label | Meaning | What carries it today |
| --- | --- | --- |
| BUILT-ON-MAIN | Code and tests are in this tree, exported from the authors' main branch. Says nothing about a live node. | Protected-promotion approvals, merge cards, the thread log, browser persistence and selective cloud sync, the wake, the outside witness, the nightly copy, sealed shards, fresh link, the voice memory chain |
| SYNTHETIC-PROOF | A bounded demonstration on test identities, worlds or fixed reference files | Three readers check the 26 reference vectors. The 20-check acceptance script drives the Node and Go tools in test worlds. The Swift reader has its own vector run. |
| SPEC-ONLY | A written criterion, design or model | The ARK contract text (DRAFT v0.1.3, not frozen; the code that runs it is the SYNTHETIC-PROOF row above); the capsule contract (draft 7, not published here; its schema, vectors and model pages are) |
| IDEA | A direction, nothing built | The Continuity Diamond; binding ARK's owner approval to a real passkey; signed action exchange between independently owned Aukora nodes; production on another cloud host (a local Node host already exists) |

A fixture exercises authoring, qualification and mounting of a read-only tool; a new deployment's end-to-end flow is unverified.

**What remains unverified.** No live restore from distributed pieces is documented. ARK uses a stand-in signer. Consults have turn-scoped leases. A reader browser can pull eligible threads of up to 64 MiB each. One pull can add up to 128 MiB of thread data to its in-memory file store. For a new proposal-card merge at the open level, the broker requires the latest push run of the fast gate for the exact proposal branch and head to succeed. In the latest attempt each required job name must occur exactly once, and that job must have completed successfully. A guarded frozen-path match adds the same requirement for proposal-checks. The two exported workflows allow only manual dispatch, so a fresh proposal cannot supply that evidence here. Direct publication and head sync have separate rules. This checkout sets `WAKE_ACTS_ENABLED = "1"`. The export supplies a fresh genesis, epoch 1. A fresh-account deployment remains unverified.

**Verify it yourself:** `node scripts/verify-lite.mjs`, with nothing installed ([below](#verify-it-yourself)). **Where it is going:** she writes the next question, the host checks what happened, the next wake takes up that question; a direction, nothing built ([docs/DIRECTION.md](docs/DIRECTION.md)). **If you are an AI:** read [llms.txt](llms.txt), then [docs/AI-START-HERE.md](docs/AI-START-HERE.md).

## What is built, and how far it is proven

The last column gives maturity. An attributed result applies to the activity, revision and environment its source describes.

| Capability | Code, test | Label |
| --- | --- | --- |
| For an AUMLOK request approval, the edge binds the origin, method, path and SHA-256 of the parsed body encoded as canonical JSON to the challenge. The five-minute approval can be spent once while the store retains its history. | [`aumlok.mjs`](deploy/cloudflare/src/aumlok.mjs), [`convergence-approval-fencing.test.mjs`](deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs) | BUILT-ON-MAIN |
| For a protected replacement using a content-addressed module, HEAD consumes approval for the ball ID, epoch, organ ID and module digest in the transaction selecting the new ball. | [`head-do.mjs`](deploy/cloudflare/src/head-do.mjs), [`head-hardening.test.mjs`](deploy/cloudflare/src/__tests__/head-hardening.test.mjs) | BUILT-ON-MAIN |
| Before starting a new card merge, the broker re-reads both Git refs against the approved proposal at the end of its read window. | [`cloud-brokers.mjs`](deploy/cloudflare/src/cloud-brokers.mjs), [`merge1-read-window.test.mjs`](deploy/cloudflare/src/__tests__/merge1-read-window.test.mjs), [`merge1-sync-hold.test.mjs`](deploy/cloudflare/src/__tests__/merge1-sync-hold.test.mjs) | BUILT-ON-MAIN |
| With an owner session, `withdraw_proposal` can withdraw a staged card matching the branch and head without asking for a new passkey. Pending or held merge attempts have a separate recovery path. | [`cloud-brokers.mjs`](deploy/cloudflare/src/cloud-brokers.mjs), [`merge1-withdraw.test.mjs`](deploy/cloudflare/src/__tests__/merge1-withdraw.test.mjs) | BUILT-ON-MAIN |
| An owner session can mount a qualified read-only tool. The fixture calls it on a second host using the same in-memory files. | [`ball-loader.ts`](packages/experimental/webworker-runtime/src/x6/ball-loader.ts), [`tools-mount-realhost-redteam.spec.ts`](packages/experimental/webworker-runtime/tests/x6/tools-mount-realhost-redteam.spec.ts) | BUILT-ON-MAIN |
| A wake step allows up to 4 model rounds and 8 executed tool calls. Its cancellation timer is set for 30 seconds. Failure recording and cleanup can finish later. | [`head-do.mjs`](deploy/cloudflare/src/head-do.mjs) (`CLOUD_WAKE_LIMITS`), [`wake-notes-wake1.test.mjs`](deploy/cloudflare/src/__tests__/wake-notes-wake1.test.mjs), [wake2-reasons.test.mjs:93](deploy/cloudflare/src/__tests__/wake2-reasons.test.mjs#L93) | BUILT-ON-MAIN |
| The wake defines 19 names for failed or blocked steps. A direct step response can also name a tool requested by the model. | `head-do.mjs` (`CLOUD_WAKE_CAUSES`), test file wake2-reasons.test.mjs in `deploy/cloudflare/src/__tests__/` | BUILT-ON-MAIN |
| With no tab open, the wake can offer action tools when the wish names an active, passkey-authorized Away mandate. Its scopes and daily allowances limit their use. | [`owner-mandate.mjs`](deploy/cloudflare/src/owner-mandate.mjs), [`owner-mandate.test.mjs`](deploy/cloudflare/src/__tests__/owner-mandate.test.mjs) | BUILT-ON-MAIN. This checkout sets `WAKE_ACTS_ENABLED = "1"` in [wrangler.toml](deploy/cloudflare/wrangler.toml). |
| A browser normally selects one writer tab per profile. New thread appends are charged against a daily byte budget. | [`thread-log.mjs`](deploy/cloudflare/src/thread-log.mjs), [`thread-writer.ts`](packages/experimental/webworker-runtime/src/storage/thread-writer.ts), [`thread-log.test.mjs`](deploy/cloudflare/src/__tests__/thread-log.test.mjs), [`thread-writer-live.spec.ts`](packages/experimental/webworker-runtime/tests/x6/thread-writer-live.spec.ts) | BUILT-ON-MAIN |
| Cloud thread appends require a writer lease reference. A reader browser can pull eligible threads of up to 64 MiB each. One pull can add up to 128 MiB of thread data to its in-memory file store. On the Threads page one closed row, “Newest in her cloud”, opens a read-only plain-text window over the newest conversation the cloud has acknowledged: its last 256 KiB, complete You and Auma messages only. A browser that has saved its own copy before lists only that copy; a browser that never saved can read the cloud’s list as a note. The window needs a complete cloud index and a usable checkpoint, is not a full restore, and may be unavailable. The seven words are not a standalone backup, login or grant of authority, and recovery after losing every enrolled device is not shown. | [thread-log.mjs:377](deploy/cloudflare/src/thread-log.mjs#L377) (append lease), [thread-sync.ts:494](packages/experimental/webworker-runtime/src/storage/thread-sync.ts#L494) (reader byte accounting), [thread-sync.spec.ts:411](packages/experimental/webworker-runtime/tests/x6/thread-sync.spec.ts#L411) (reader limits), [`ThreadsLane.tsx`](packages/client/ui-layout/src/client/spatial/portal/ThreadsLane.tsx) (the closed row) | BUILT-ON-MAIN |
| On rebase the browser backs up the local file bytes it replaces and records what it adopts or overrides. | [`idb-persist.ts`](packages/experimental/webworker-runtime/src/storage/idb-persist.ts) (`planChromeWins`), [`mirror-do.mjs`](deploy/cloudflare/src/mirror-do.mjs), [`reconcile-dry-run.spec.ts`](packages/experimental/webworker-runtime/tests/x6/reconcile-dry-run.spec.ts) | BUILT-ON-MAIN |
| A merge-ready card offers “Approve with Touch ID” and expandable file details. A held attempt has recovery controls. | [`RepoProposalCell.tsx`](packages/client/ui-layout/src/client/spatial/portal/RepoProposalCell.tsx), [`repo-proposal-card.client.spec.tsx`](packages/client/ui-layout/tests/repo-proposal-card.client.spec.tsx) | BUILT-ON-MAIN |
| The Notices design calls for pending approvals to appear as rows that open the review screen. | [`notices.ts`](packages/client/ui-layout/src/client/spatial/portal/notices.ts), [`portal-approval-notices.client.spec.tsx`](packages/client/ui-layout/tests/portal-approval-notices.client.spec.tsx) | BUILT-ON-MAIN |
| The broker caps reservations for each owner and world at 600 runner minutes a UTC day. | [`runner-budget.mjs`](deploy/cloudflare/src/runner-budget.mjs), [`runner-budget.test.mjs`](deploy/cloudflare/src/__tests__/runner-budget.test.mjs) | BUILT-ON-MAIN. Live completion unverified |
| The Pentora observer answers from partial readings and changes nothing (its engine file imports nothing) | [`pentora-epistemic.ts`](packages/experimental/webworker-runtime/src/x6/pentora-epistemic.ts), [`pentora-epistemic.test.mjs`](deploy/cloudflare/src/__tests__/pentora-epistemic.test.mjs) | BUILT-ON-MAIN |
| The Prime door uses configured daily and monthly caps and accounts for reservations and provider usage where available. | [`provider-budget.mjs`](deploy/cloudflare/src/provider-budget.mjs), [`prime-door.test.mjs`](deploy/cloudflare/src/__tests__/prime-door.test.mjs) | BUILT-ON-MAIN. Live completion unverified |
| On an hourly tick the witness attempts a scheduled record if none exists or the newest is at least 3 h 59 min old. A promotion record restarts the interval. Promotions request a record of the latest head. Requests can coalesce, with at most 24 promotion-triggered records per rolling day. Relay acceptance, read-back, calendar upgrade and header validation have separate results. | [`witness.mjs`](deploy/cloudflare/src/witness.mjs), [`witness-do.mjs`](deploy/cloudflare/src/witness-do.mjs), [`ots.mjs`](deploy/cloudflare/src/ots.mjs), [`witness-do.test.mjs`](deploy/cloudflare/src/__tests__/witness-do.test.mjs), [`ots.test.mjs`](deploy/cloudflare/src/__tests__/ots.test.mjs) | BUILT-ON-MAIN. External services may learn the node domain. [Witness protocol and verification](docs/auma/outside-witness.md). |
| The nightly copier pages eligible rows from four Durable Objects. It omits three HEAD identity rows, redacts the Messages signing field, withholds hidden, unresolved or conflicting MIRROR rows, and records the vault count, total bytes and a digest of sorted blob names and sizes. Pages can span concurrent changes. The witness checks the manifest named by LATEST. | [`nightly-copy.mjs`](deploy/cloudflare/src/nightly-copy.mjs), [`nightly-copy.test.mjs`](deploy/cloudflare/src/__tests__/nightly-copy.test.mjs) | BUILT-ON-MAIN. This checkout enables nightly copying. The tests use in-memory storage ([nightly-copy.md](docs/auma/nightly-copy.md)) |
| A standalone module encrypts the file with AES-256-GCM and wraps the data key using a supplied secret or HPKE to a supplied X25519 recipient. With a trusted manifest, any k distinct valid pieces reconstruct the ciphertext. Opening the file also needs the v1 unwrapping secret or the v2 recipient private key. A live node restore from distributed pieces remains unverified. | [`sealed-shards.mjs`](deploy/cloudflare/src/sealed-shards.mjs), [`sealed-shards.test.mjs`](deploy/cloudflare/src/__tests__/sealed-shards.test.mjs), [`sealed-shards-v2.test.mjs`](deploy/cloudflare/src/__tests__/sealed-shards-v2.test.mjs) | BUILT-ON-MAIN. A recovery rehearsal uses an empty test edge ([sealed-shards.md](docs/auma/sealed-shards.md)). |
| Fresh Link uses X-Wing for key exchange, Ed25519 and ML-DSA-65 for long-term peer authentication and AES-256-GCM for traffic. With default randomness each peer generates a throwaway Ed25519 key pair per connection. The authenticated peer ID derives from the peer’s long-term public keys. | [`fresh-link.mjs`](deploy/cloudflare/src/fresh-link.mjs), [`fresh-link-vectors.test.mjs`](deploy/cloudflare/src/__tests__/fresh-link-vectors.test.mjs) | BUILT-ON-MAIN: experimental, no independent cryptographic review cited, no node route ([fresh-link.md](docs/auma/fresh-link.md)) |
| The bridge can answer through its fast model at the edge or hand a turn to the tab. The chain records turn metadata and commitments to excerpts of up to 4,000 UTF-16 code units heard and 6,000 spoken. A removable companion holds the excerpts and their shared salt. The edge keeps up to 40 record-and-words pairs. | [`voice-memory.mjs`](deploy/cloudflare/src/voice-memory.mjs), [`voice-memory.test.mjs`](deploy/cloudflare/src/__tests__/voice-memory.test.mjs) | BUILT-ON-MAIN |
| In the ARK demonstration the owner signs an approval naming the proposal digest. The receiver appends a line once and signs its outcome. A valid retry with the same operation ID and proposal digest returns the prior outcome if the receiver still holds it. Offline readers need the bundle and independently trusted owner and receiver pins. Restore imports qualifying signed history from the archive. The demo effect file is outside it. After restore, new appends stay locked until the receiver accepts owner-signed authority for this receiver with an epoch above the restored floor. | [`ark/CONTRACT.md`](ark/CONTRACT.md), [`ark/accept/run.sh`](ark/accept/run.sh) | SYNTHETIC-PROOF: 20 of 20 acceptance checks; Go and Swift readers 26 of 26 vectors each, Node self-tests 15 of 15; authors' runs on one machine; three separately written readers, not independent ones ([`ark/ABOUT.md`](ark/ABOUT.md)); not wired into the node |
| The Continuity Diamond: she writes the next question, the host checks what happened, the next wake must take up that exact question | none | IDEA. a specification is being designed; nothing is built |

More rows and the counts: [docs/WHAT-IS-BUILT.md](docs/WHAT-IS-BUILT.md).

## The rule, and where it stops

The authenticator signs its data and the hash of client data containing the challenge.

- **16 named parts are protected**, plus any part that declares itself governance. HEAD applies the fixed list to ball entries. Ten names occur in genesis, five others match shipped cell names, and the remaining name, `auma-kernel`, is absent from genesis. Two more genesis entries, `seed-continuity` and `seed-nostr-anchor`, declare governance. The other 14, including `seed-cycle`, are ordinary entries. Their promotion still needs an applicable authorization. An owner-authorized **night grant** can cover one or more eligible ordinary changes for up to 12 hours, 12 uses and 8 parts per use. The 16 protected ids are never covered ([`night-grant.mjs`](deploy/cloudflare/src/night-grant.mjs), [`night-grant.test.mjs`](deploy/cloudflare/src/__tests__/night-grant.test.mjs)).
- **Deployment authority.** Git merge, edge head selection and deployment are separate decisions. Hosting and cloud permissions govern release and rollback. This checkout disables the public push triggers. The [Cloudflare API door](deploy/cloudflare/src/cloudflare-door.mjs#L114) requires owner approval for direct writes classified as live Worker changes. The [owner-session workflow dispatch](deploy/cloudflare/src/cloud-brokers.mjs#L2599) has a separate [pre-publish target check](.github/workflows/deploy-x61.yml#L493). See `deploy/ci/`.
- **Storage.** A fixture reproduces reuse of a spent approval after a stored snapshot is restored ([`aumlok-restore-rehearsal.test.mjs`](deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs)).
- **Pearl.** The supplied HEAD configuration has no Pearl verifier. A transition that requires one is refused.
- **Repository authority.** Her repository door ships at level `open` ([frozen-paths.mjs](deploy/ci/frozen-paths.mjs)). Proposal paths, contents and sizes are checked. The repository merge card binds the branch, expected Git base, proposal head and tree. An owner session can commit eligible Markdown at the repository root or under docs/ directly to main. A separate route checks explicit approval for other permitted direct publications. Head sync can commit the selected manifest, checked modules, handoff text and eligible receipt-ledger additions to main. Head sync refuses a repository named aukora-x7. The broker source fixes the repository slug. Hosting permissions govern other writers. The initial gate job restores main’s gate scripts and two server files. The [manual gate](.github/workflows/proposal-gate.yml#L11) passes the [run’s commit](.github/workflows/proposal-gate.yml#L69) to the later [checkout steps](.github/workflows/proposal-gate.yml#L81). At open, a green checks job can cover the path fence alone.

The rule is aimed at a misbehaving agent or model reply. It is not a defence against a compromised approval page, the edge's operator, a stolen deploy credential or a storage rollback.

**The project's names.** An **organ** is one replaceable module of her. A **ball** lists organ module specifiers. Its version number is the **epoch**. **HEAD** records the ball selected by the edge, and **MIRROR** stores acknowledged cloud updates for eligible files. The sync excludes snapshot dumps and local conflict backups. **AUMLOK** is the identity and approval code. The **scion** compiles a candidate organ. A **Pearl** challenge grades candidate builds against a retention suite. A **scar** records a failure and can name existing cases that guard against it. **Aura** is her coherence reading. **Kira** names five memory-side Wasm cells. **Pentora** is a figure of her cells, drawn and observed. More: [docs/GLOSSARY.md](docs/GLOSSARY.md).

The [architecture map](docs/ARCHITECTURE-MAP.md) follows a module change from proposal to selection. This edition cites no end-to-end exercise of that flow with a real passkey.

### Verify it yourself

Run `node scripts/probe.mjs` for one JSON result covering the Node version, claim paths and ARK manifest. Verify-lite requires Node 24.9 or newer and refuses older versions.

```sh
git clone https://github.com/Aukora-xyz/aukora-x7.git
cd aukora-x7
node scripts/verify-lite.mjs
# last line reported for commit 80e392d1 on macOS arm64 with Node 24.11.1:
# verify-lite: 22 files, 565 pass, 12 fail, 12 of 12 on the known-red list
```

- **Reading the result.** Exit 0 means each file’s counted failures fit its published allowance. Totals and failing case identities can differ. Read the per-file diagnostics, including timeouts and missing summaries. Node’s permission model applies to 21 of the 22 default test files. `server/asset-cache.test.mjs` runs without it because the test calls fsync, which Node 24.22 and newer disable under the permission model. That file still gets the network guard, a rebuilt environment and the run’s fresh temporary folder as HOME. The optional 16-file authority tier needs additional packages. See [the per-file allowances](docs/KNOWN-RED-TESTS.md).
- **Other tests.** Use `node --test` for files importing `node:test`. Use `pnpm exec vitest run` for specs selected by the root Vitest projects after installing dependencies. Their configuration omits the edge voice-provider-limits file, which imports Vitest and matches the historical Node command. The standalone timestamp fixture suite runs with Node alone. [The inventory](docs/WHAT-IS-BUILT.md) expands selected capabilities.
- **Historical suites.** The [run record of an earlier tree](docs/RUN-RECORD.md) gives the per-suite commands and outcomes. The authors reported 5,502 cases across four suites on one machine, using the app rerun after an export correction and earlier results for the other three suites. That total includes 5,399 passes, 90 failures, one skip and 12 todo. The authors reported that 89 failures fell within the counts already listed for those files.

## What is deliberately not done

- **Starting state.** This export supplies an epoch-1 genesis (`mirror/home/balls/HEAD.json`).
- **Binaries without source.** 24 of the 30 Wasm cells and the Dakini Code bundle (a prebuilt stock app, three files) ship without their source, so a fork cannot rebuild them, and their notes say that someone who passes this repository on cannot meet the AGPL's source duty from it alone. Six cells are hand-written WAT, with source beside them ([`cells/LICENSE.binaries`](apps/web/public/cells/LICENSE.binaries), [`dakini-code/LICENSE.binaries`](apps/web/public/assets/stock-apps/dakini-code/LICENSE.binaries)).
- **Binary ownership.** The component notice states, “The authors own pentora36.wasm and ship it without source and without a separate licence.” See the note ([`LICENSE.binaries`](apps/web/public/seed-library/pentora/LICENSE.binaries) in `apps/web/public/seed-library/pentora/`).
- **Recovery and approval.** Shard tests encrypt and decrypt test inputs. With a trusted manifest, any k distinct valid pieces reconstruct the ciphertext. Opening the file also needs the v1 unwrapping secret or the v2 recipient private key. A live node restore from distributed pieces remains unverified. ARK uses a stand-in owner signer.
- **Private state.** Release contents are subject to the exact-tree privacy check.
- **No-tab acts.** This checkout enables no-tab acts. Deployment into another account remains unverified. The template includes node-specific placeholders.
- **Outside runs.** The unsigned Linux report for commit `80e392d1` counted 554 passes and 23 failures. On Node 24.22.3, a copy using the single-file exception now shipped here reported 565 passes and 12 failures. The ledger gives totals. Across the counted non-vendored tree, the project’s private-history attribution estimates that 18.3% of the text lines and 20.4% of the code lines are Aukora's own ([docs/SIZE-AND-ORIGIN.md](docs/SIZE-AND-ORIGIN.md)).

The authors report that Aukora has had no security audit ([SAFETY.md](SAFETY.md)). More gaps, in order of weight: [docs/OPEN-SOURCE-READINESS.md](docs/OPEN-SOURCE-READINESS.md).

## Kyber Shield: open research on child safety (DIRECTION)

Can a personally owned AI help protect a young person from grooming and coercion without reading their diary? The proposal combines explicit contact permissions before contact, local help with separate permissions to view, retain, transmit and train, reports chosen by the recipient instead of automatic accusation, and a requirement that the transition to independence must not leave anyone with hidden access. DIRECTION labels a research proposal, outside the four maturity labels. What exists today is a small sealed computation cell and the approval and receipt code the page cites (BUILT-ON-MAIN; none of it is a detector, and the earlier run reported receipt-suite failures). This export supplies no classifier, trained model, reporting service or real-world evaluation. If you work on child safety, privacy engineering or cryptography, this is where review helps most: [docs/research/KYBER-SHIELD.md](docs/research/KYBER-SHIELD.md).

## Where it is going

- For a new proposal-card merge at the open level, the broker requires the latest push run of the fast gate for the exact proposal branch and head to succeed. In the latest attempt each required job name must occur exactly once, and that job must have completed successfully. A guarded frozen-path match adds the same requirement for proposal-checks. The two exported workflows allow only manual dispatch, so a fresh proposal cannot supply that evidence here. Direct publication and head sync have separate rules. A Git merge records a repository change. A separate workflow selects and publishes a deployment. A complete receipt history for every promotion is unverified.
- The Continuity Diamond: at the end of a wake she writes the next question; the host checks what actually happened; the next wake must take up that exact question. A direction whose specification is being designed; nothing of it is built.
- More decisions in Wasm, her actions as signed Nostr events between independently owned nodes, and a production deployment on another cloud host. Their current status is listed in [docs/DIRECTION.md](docs/DIRECTION.md).

## Go deeper

The reading path for an AI: [docs/AI-START-HERE.md](docs/AI-START-HERE.md), then [docs/DIRECTION.md](docs/DIRECTION.md), then [docs/WHAT-IS-BUILT.md](docs/WHAT-IS-BUILT.md), then the argument in full, [docs/WHITEPAPER.md](docs/WHITEPAPER.md) (English only). The root `AGENTS.md` opens with Aukora-specific reading and source pointers, then gives the inherited harness’s coding rules. What is unproven or cannot be rebuilt: [SECURITY.md](SECURITY.md), [docs/OPEN-SOURCE-READINESS.md](docs/OPEN-SOURCE-READINESS.md). Older file-level notes, in older label words: [docs/START-HERE.md](docs/START-HERE.md), [docs/ARCHITECTURE-ACTUAL.md](docs/ARCHITECTURE-ACTUAL.md).

Without code: read, ask, and say where a page is unclear or wrong, in public issues and pull requests. Follow [SECURITY.md](SECURITY.md) for private vulnerability reports ([docs/COMMUNITY.md](docs/COMMUNITY.md)). Install, run the test files named above, and report your counts. A full repeat on another machine would test whether the recorded run of an earlier tree still describes this revision. Pick a red test or a stated gap from [docs/GOOD-FIRST-CONTRIBUTIONS.md](docs/GOOD-FIRST-CONTRIBUTIONS.md). The rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

Licence: [AGPL-3.0-or-later](LICENSE). Upstream DeepSeek Harness is MIT ([notice](LICENSES/MIT-DeepSeek-Harness.txt)); third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Aukora is not affiliated with or endorsed by DeepSeek. The licence terms are in [LICENSE](LICENSE) (see its section 11) and [LICENSES/](LICENSES/).

## Aukora Core, and next if you are an AI

This tree carries a snapshot of public Core and ships the pinned v0.8 small reader and sample. The X7 app does not invoke the sample reader. Public Core documents a same-platform clean rebuild of the v0.8 artifacts. Its Linux checks exercise the shipped files; they are not a Linux rebuild. See [public Core](https://github.com/Aukora-xyz/aukora-core), the [bundled snapshot](aukora-core/) and the [X7 edge module inventory](docs/CORE.md).

Read [docs/AI-START-HERE.md](docs/AI-START-HERE.md) for authority and recovery references, reading budgets, evidence labels and commands for the nine published claims.

This repository ships no Chinese translations of its documents. The application retains its Chinese interface strings.
