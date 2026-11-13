# Open-source readiness

English | [中文](OPEN-SOURCE-READINESS.zh.md)

This repository is published under AGPL-3.0-or-later, but it is **not yet a stack anyone can fully rebuild.** Some of the parts that make decisions ship only as compiled files, one compiled file has no licence at all, and some build inputs live outside the tree. This page lists every known gap in priority order, says who can close it, and says what a reader can and cannot reproduce today.

None of this is solved. A gap leaves this page only when the fix is in the tree.

Labels: IMPLEMENTED (code and tests in this tree), RECORDED RUN (shown in [RUN-RECORD.md](RUN-RECORD.md)), INDEPENDENTLY VERIFIED (nothing has this label yet), UNVERIFIED (claimed or written, but no test here holds it or no run shows it), DIRECTION (not built).

Two words used below: an organ is one replaceable module of Auma, the AI in this repository, and a ball is the manifest that names every organ by hash.

## The gaps, in priority order

### 1. 24 of the 25 Wasm cells cannot be rebuilt

The cells are small sealed WebAssembly modules (see [GLOSSARY.md](GLOSSARY.md)). They hold identity, keys, judges, the grant ledger, memory policy and Nostr signing. Five of the 15 ids that only the owner's passkey may change are cells (`T2_ONLY_ORGANS` in `server/ball-transition.mjs`).

- In the tree: 24 compiled files in `apps/web/public/cells/` (6,488,165 bytes), each pinned by size and SHA-256 in `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`. Only `aura-focus.wasm` has its source beside it (`aura-focus.wat`), and `server/aura-focus-cell.build.mjs` checks that the shipped bytes match it. That rebuild uses the pinned `skillsmith` cell as its compiler, and `skillsmith` is one of the 24 without source.
- Not in the tree: any Rust source. There is no `.rs` file and no `Cargo.toml` (checked with `find`). The shared crate `mv_abi` that most cells use is not on crates.io and its source is not in this tree (`apps/web/public/cells/THIRD-PARTY.md`, lines 10 and 11). In that table, 13 third-party crate rows and the Rust standard library row read "not visible" for their version. The compiler version and target are not stated in the tree.
- Licence consequence: under sections 5 and 6 of the AGPL, whoever passes on object code must also give its source. Someone who received this repository cannot meet that duty from the repository alone (`apps/web/public/cells/LICENSE.binaries`).
- Needed: the cell workspace with `mv_abi`, its lock file, the compiler and target versions, the build command, and the expected SHA-256 of each pin in `wasm-cells.ts`. Or other terms for the compiled files, stated in that note.
- By: the copyright holders.
- Until then: that any cell matches any source is UNVERIFIED.

### 2. `pentora36.wasm` has no licence

- In the tree: `apps/web/public/seed-library/pentora/pentora36.wasm`, 64,892 bytes, compiled, no source.
- Its note says no licence is granted by this repository yet; neither the root licence nor the cells note covers it (`apps/web/public/seed-library/pentora/LICENSE.binaries`). The page code that runs it says its checks are defined by `core.mjs` and `fixtures/cases.json`, and neither file is in the tree (`packages/client/ui-layout/src/client/spatial/aura/pentora-wasm.ts`, line 5).
- Needed: a licence statement, its source and the two check files, or removal of the file.
- By: its copyright holder.
- Until then: ask its copyright holder before you copy, change or pass on this file.

### 3. Dakini Code ships as a built bundle without source

- In the tree: Dakini Code is one of the stock apps. It ships as three built files in `apps/web/public/assets/stock-apps/dakini-code/assets/` (1,055,208 bytes).
- Same AGPL duty as item 1 (`apps/web/public/assets/stock-apps/dakini-code/LICENSE.binaries`).
- Needed: the source and its build, or other terms. By: the copyright holders.

### 4. No named copyright holder and no contribution terms

- 106 JavaScript and TypeScript files carry the header "The Aukora authors" (counted with `grep -rl`); the rest of the tree relies on the root [LICENSE](../LICENSE). No file-level map says which lines are original and which are inherited; [SIZE-AND-ORIGIN.md](SIZE-AND-ORIGIN.md) gives the counts by folder.
- 17 folders besides the root carry their own `LICENSE` file (counted with `find . -name LICENSE`, outside `LICENSES/`), among them BSD-3-Clause in `native/system/` and an adaptation of another project in `packages/fs/fs-patch/`.
- There is no contributor agreement and no sign-off rule. [CONTRIBUTING.md](../CONTRIBUTING.md) asks each pull request to state its licence until there is.
- Needed: a named holder or entity, a contribution rule, a generated origin map. By: the copyright holders.

### 5. Terms the tree cannot show

- One agent SDK package and eight platform packages it declares are listed "SEE LICENSE IN" their own files ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), line 35 and lines 188 to 195), and are covered by an authorization statement (line 182). Whether that meets their publisher's terms is UNVERIFIED, and those terms are not in `LICENSES/`.
- The QR encoder in `packages/client/ui-layout/src/client/spatial/apps/identity/qr.ts` (lines 3 to 7) paraphrases a third-party MIT notice, and that project is not in the notices table.
- By: the publisher of those terms; the maintainers for the notices.

### 6. No reproducible build is recorded

- One build ran on one machine (RECORDED RUN). No second machine has compared the hashes of `apps/web/dist` or the dry-run ball id `a26b7a027014e6af067a0a8433c49c56639ac09642726110c91f8300e9e81624`.
- The build needs `.git` or `DSH_CLIENT_COMMIT_HASH`, and by default it posts to a host on port 4610 (`server/build-preview.mjs`, lines 43 to 55).
- By: any second builder; the maintainers for the build script.

### 7. Checkpoint signers are synthetic

- The two pinned checkpoint signer keys are synthetic; nobody holds a private half (`mirror/home/auma/seed/organs/seed-receipts.js`, line 37). No documented procedure to replace them was found in the tree. How a fresh node gets real signers is UNVERIFIED.
- The change touches an organ on the list that only the owner's passkey may change, so the owner approves the exact bytes.

### 8. Deployment values are placeholders written into code

- `your-node`, `node.example.invalid` and a zero account id sit in `deploy/cloudflare/wrangler.toml`. The same values, and the repository placeholder `your_org_x/your-node`, are also written into code, among them `server/deploy-cloudflare.mjs` (lines 21, 24), `deploy/cloudflare/src/cloud-brokers.mjs` (lines 8, 1700), `server/seed-cloudflare.mjs` (line 14), `server/cloudflare-bootstrap-cli.mjs` (line 6), `deploy/ci/deploy-guard.mjs` (line 44) and `server/owner-grant.mjs` (line 116). `grep -rlE 'your-node|example\.invalid|your_org_x' server deploy` lists them all, with tests and documents.
- A cloud deployment from this tree into a fresh account is UNVERIFIED.
- By: the maintainers.

### 9. Sources that live elsewhere

- Vendored code in `vendor/` is pinned to outside commits (`vendor/README.md`).
- The source for the MPL-2.0 conversion kit is in an outside repository ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), lines 200 to 202).
- Needed: mirror them in the tree or pin them by hash. By: the maintainers.

## What must be published, rebuilt or licensed

| What | Action | By | Status |
| --- | --- | --- | --- |
| 24 Wasm cells | Publish source, `mv_abi`, lock file, toolchain, build command, expected hashes | Copyright holders | Open |
| `pentora36.wasm` | State a licence, publish source and check files, or remove | Its copyright holder | Open |
| Dakini Code bundle | Publish source and build, or state other terms | Copyright holders | Open |
| Copyright and contributions | Name the holder, set contribution terms | Copyright holders | Open |
| Agent SDK and platform packages | Put the governing terms in `LICENSES/` or confirm them | Their publisher, then maintainers | Open |
| QR encoder notice | Add to the notices table | Maintainers | Open |
| Build | A second builder compares hashes | Anyone | Open |
| Checkpoint signers | Real signers and a replacement procedure | Owner of each node | Open |
| Deployment values | One source for them, read by the code | Maintainers | Open |
| Outside sources | Mirror or pin by hash | Maintainers | Open |

## What a reader can reproduce today

| Can do | How | Label |
| --- | --- | --- |
| Run 22 test files with no install; expected last line `verify-lite: 22 files, 564 pass, 12 fail, 12 of 12 on the known-red list` | `node scripts/verify-lite.mjs` (Node 24.9 or newer) | UNVERIFIED: seen on one machine, not in the recorded run |
| Check every cell file against its pin, without running it | The SHA-256 loop over `apps/web/public/cells/*.wasm` and `wasm-cells.ts` (see [WHAT-IS-BUILT.md](WHAT-IS-BUILT.md)) | IMPLEMENTED |
| Rebuild `aura-focus.wasm` from `aura-focus.wat`, using the source-less `skillsmith` cell as the compiler | `server/aura-focus-cell.build.mjs`; test `server/aura-focus-cell-shadow.test.mjs` | IMPLEMENTED |
| Install, build, boot the local host, run the four suites, run the dry run | [CONTRIBUTING.md](../CONTRIBUTING.md), section 3 | RECORDED RUN on one machine |

## What a reader cannot reproduce today

- Rebuild 24 cells, `pentora36.wasm` or the Dakini Code bundle, or check that any of them matches any source.
- Run the pentora checks as their own definition files describe them: those files are absent.
- Run the authority tests without an install.
- Reproduce a build hash for hash: no comparison exists.
- Run the fixture provenance check: it needs the project's earlier Git history, which is not public; the public history of this repository starts at its first public commit (`server/fixtures/organs/pinned.mjs`).
- Reproduce the exact split between inherited and added lines: it needs the private history. A close public method is described in [SIZE-AND-ORIGIN.md](SIZE-AND-ORIGIN.md).
- Run `mirror/home/auma/seed/organs/auma-body-map.js` past its document check: it throws when a planning document it looks for is absent (lines 189 to 191), and the tree ships neither path it tries.
- Deploy to a fresh account without editing code: see item 8.
- See any deployed node, browser session, model call or passkey ceremony: none is recorded.
