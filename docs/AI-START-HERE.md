# AI start here

You came from `README.md`, which showed what Auma can do and how far each part is proven. This page adds what an AI needs before it summarises, recommends or changes anything: source and test paths, evidence labels, and commands for the published claims. Commands use paths relative to the working directory shown and can create build outputs.

Words used below: Auma is the personal AI in this tree; an organ is one replaceable module of her; a ball is a manifest of organ module specifiers; its epoch is its version number; HEAD is the edge store that records the selected ball; the edge is a Cloudflare Worker with four Durable Object class bindings. HEAD checks the applicable approval when selecting a protected module replacement.

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

## 1. Authority and recovery evidence

An Away mandate is valid for at most 30 days from its stated issue time. At issuance HEAD allows up to ten minutes of clock difference. See [deploy/cloudflare/src/owner-mandate.mjs:18](../deploy/cloudflare/src/owner-mandate.mjs#L18).

- The browser checks the captured parts against the lengths and SHA-256 values in the Continuity snapshot (`aukora.recovery-snapshot.v1`) and checks its manifest digest. Trust in the snapshot’s origin is separate. After owner confirmation, the restore page can seed an empty edge or resume a matching partial seed. On an initialized edge, the [Estate card](../packages/client/ui-layout/src/client/spatial/portal/recovery-restore.ts#L269) compares the snapshot with the current head, receipt and checkpoint state, and mirror digest. See the [snapshot checks](../deploy/cloudflare/src/recovery-restore.mjs#L147), [target comparison](../deploy/cloudflare/src/recovery-restore.mjs#L341) and [confirmation handler](../deploy/cloudflare/src/recovery-restore.mjs#L469).
- Browser rescue download (`x61-rescue-pack/v1`), local verifier at [server/rescue-verify.mjs:71](../server/rescue-verify.mjs#L71).
- Recovery on deployed infrastructure is unverified.

Passkey sign-in session lifetime is eight hours at [deploy/cloudflare/src/aumlok.mjs:27](../deploy/cloudflare/src/aumlok.mjs#L27). The signed owner-login cookie uses the assertion’s remaining validity at [deploy/cloudflare/src/worker.mjs:1829](../deploy/cloudflare/src/worker.mjs#L1829), with a 24-hour assertion limit in [deploy/cloudflare/src/access.mjs:6](../deploy/cloudflare/src/access.mjs#L6).

## 2. Deployment and model settings

The browser URL-prefix table has eight doors for seven providers, counting regional entries under their provider. See [packages/experimental/webworker-runtime/src/model-doors.ts:14](../packages/experimental/webworker-runtime/src/model-doors.ts#L14).

## 3. Limits

Live recovery from distributed pieces remains unverified. An independent approval display is unbuilt in this export. See [security limits](../SECURITY.md).

## 4. Reading order, with a reading budget in lines

**About 440 lines.** The path, in order: `README.md` (150), This page (101), `docs/DIRECTION.md` (25) and `docs/WHAT-IS-BUILT.md` (163), then the argument in full (below; its lines are not in this sum).

**About 1,420 lines.** Add the record of an earlier tree, `docs/RUN-RECORD.md` (56), `docs/KNOWN-RED-TESTS.md` (75), `docs/ARCHITECTURE-MAP.md` (138), `docs/GLOSSARY.md` (21), `server/ball-transition.mjs` (125), `deploy/cloudflare/src/proof-failure-rule.mjs` (250), `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs` (232) and `deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs` (88).

**The whole day.** Add `deploy/cloudflare/src/aumlok.mjs` (1,806), `head-do.mjs` (4,516), `cloud-brokers.mjs` (3,865), `owner-mandate.mjs` (293), `owner-grant-policy.mjs` (366), `night-grant.mjs` (127), `deploy/cloudflare/README.md` (181), `deploy/ci/frozen-paths.mjs` (626), `mirror/home/auma/seed/organs/seed-cycle.js` (148), `seed-pearl.js` (525), `seed-receipts.js` (501), `packages/experimental/webworker-runtime/src/x6/scion.ts` (179), `wasm-cells.ts` (1,263), `packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts` (1,127), `deploy/cloudflare/src/recovery-restore.mjs` (485), then `docs/SIZE-AND-ORIGIN.md`. Read `packages/experimental/webworker-runtime/src/x6/ball-loader.ts` (10,330) by symbol.

**The argument.** `docs/WHITEPAPER.md` (1156, English only). The paper defines its own [evidence labels](WHITEPAPER.md#L20).

## 5. Evidence labels for the front pages and inventories

| Label | Means |
|---|---|
| IMPLEMENTED | Code and tests are present in this edition. Test outcomes require separate evidence. |
| RECORDED RUN (of an earlier tree) | A check or observation in the authors’ record of an earlier tree on one machine (`docs/RUN-RECORD.md`). |
| INDEPENDENTLY VERIFIED | An identified person outside the authors’ team repeated the stated check on the stated revision and platform. Three unsigned observations in `claims.json` have status `reported`. The measured Linux variant has status `fixed in this commit`. |
| UNVERIFIED | Claimed or written, but no test here holds it or no run shows it. |
| DIRECTION | An aim. Not built. |
| Source inventory | A count or property read directly from the named files. |

| Maturity label (README.md, `llms.txt`) | In the words above |
|---|---|
| BUILT-ON-MAIN | IMPLEMENTED product code and tests exported from the authors’ main branch. |
| SYNTHETIC-PROOF | A bounded exercise on test identities, worlds or distributed reference files. ARK acceptance uses throwaway identities and a demo file. |
| SPEC-ONLY | A written criterion, specification or model. Implementations and results have their own evidence. |
| IDEA | DIRECTION |


By the project's one count, made from its own history, which is not public (UNVERIFIED): 18.3% of the tree's non-vendored text lines, and 20.4% of its code lines, are Aukora's own. Details and method: `docs/SIZE-AND-ORIGIN.md`.

The component notice states, “The authors own pentora36.wasm and ship it without source and without a separate licence.” See the separate notice at `apps/web/public/seed-library/pentora/LICENSE.binaries`.

## Recorded checks

The unsigned macOS report for commit `80e392d1` in `claims.json` reads `verify-lite: 22 files, 565 pass, 12 fail, 12 of 12 on the known-red list`. A run of this edition is unverified here. Node’s permission model applies to 21 of the 22 default test files. `server/asset-cache.test.mjs` runs without it because the test calls fsync, which Node 24.22 and newer disable under the permission model. That file still gets the network guard, a rebuilt environment and the run’s fresh temporary folder as HOME.

## Commands in claims.json

The nine entries in `claims.json` supply the commands and expected exit codes below. Run ARK acceptance from a checkout whose absolute path contains no whitespace. The Swift verifier builds with macOS Swift and CryptoKit. Its vector script requires Python 3.9 or newer.

- `node scripts/verify-lite.mjs` — exit 0
- `(cd ark && ./accept/run.sh)` — exit 0
- `(cd ark/a && node --test --test-concurrency=1 test/*.test.mjs)` — exit 0
- `(cd ark && ./b/run-vectors.sh)` — exit 0
- `(cd ark/c && mkdir -p .build/tmp .build/module-cache && TMPDIR="$PWD/.build/tmp" CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" swiftc -Osize -whole-module-optimization -module-cache-path "$PWD/.build/module-cache" StrictJSON.swift Schema.swift Verifier.swift Operations.swift main.swift -o ./verifier && ./run-vectors.sh)` — exit 0
- `(cd ark && shasum -a 256 -c MANIFEST.sha256)` — exit 0
- `hits=$(find . \( -name '*.zh.md' -o -name '*.i18n.yaml' \) -print) && test -z "$hits"` — exit 0
- `grep -rIE --exclude-dir=.git '[A]UM-[0-9]+' .` — exit 1
- `node scripts/probe.mjs` — exit 0

This repository ships no Chinese translations of its documents. The application retains its Chinese interface strings.
