# Third-party code inside the Wasm cells

The `.wasm` files in this folder (and `../seed-library/pentora/pentora36.wasm`) are prebuilt. Their own sources are
not in this repository, except `aura-focus.wat`. They contain object code of the third-party Rust crates below.
This list is generated from two things the compiler left inside each compiled file: crate paths (which carry a
version) and the function names of the Wasm `name` section (which do not). The license column is the SPDX
expression each crate declares on crates.io. The shared license texts are in
[`LICENSES/MIT.txt`](../../../../LICENSES/MIT.txt) and [`LICENSES/Apache-2.0.txt`](../../../../LICENSES/Apache-2.0.txt);
a crate under one license only has its own notice file, linked in its row. The copyright holders of the other
crates are the authors each names in its own package. `mv_abi`, found in most cells, is the cells' own shared
crate (it is not on crates.io) and is covered like the cells themselves: see `LICENSE.binaries` in this folder.

| Crate | Version | License | Cells |
| --- | --- | --- | --- |
| `base64` | 0.22.1 | MIT OR Apache-2.0 | nostr-core, skillsmith |
| `bech32` | 0.12.0 | MIT. Notice: [`LICENSES/MIT-bech32.txt`](../../../../LICENSES/MIT-bech32.txt) | nostr-core |
| `block-buffer` | 0.10.4 | MIT OR Apache-2.0 | skillsmith |
| `block-buffer` | 0.12.1 | MIT OR Apache-2.0 | nostr-core |
| `chacha20` | 0.10.2 | MIT OR Apache-2.0 | nostr-core |
| `cmov` | not visible | Apache-2.0 OR MIT | kira-nostr, nostr-core |
| `const-oid` | 0.10.2 | Apache-2.0 OR MIT | nostr-core |
| `crypto-bigint` | 0.7.5 | Apache-2.0 OR MIT | kira-nostr, nostr-core |
| `crypto-common` | not visible | MIT OR Apache-2.0 | nostr-core |
| `ctutils` | not visible | Apache-2.0 OR MIT | nostr-core |
| `der` | not visible | Apache-2.0 OR MIT | nostr-core |
| `digest` | 0.10.7 | MIT OR Apache-2.0 | skillsmith |
| `digest` | 0.11.3 | MIT OR Apache-2.0 | nostr-core |
| `digest` | not visible | MIT OR Apache-2.0 | kira-nostr |
| `dlmalloc` | 0.2.11 | MIT OR Apache-2.0 | aukora-kernel, aumlok-identity, aumlok-keys, aura-relay, gate-judge, goal-receipts, grant-ledger, kira-core, kira-membrane, kira-nostr, kira-resume, kira-store-policy, lane-contract, lane-judge, lane-profile, laya, nostr-core, organism-tools, pair-judge, prompt-assembly, risk-signature, seed-judge, skillsmith, spatial-layout |
| `elliptic-curve` | not visible | Apache-2.0 OR MIT | kira-nostr, nostr-core |
| `generic-array` | 0.14.7 | MIT. Notice: [`LICENSES/MIT-generic-array.txt`](../../../../LICENSES/MIT-generic-array.txt) | skillsmith |
| `group` | not visible | MIT OR Apache-2.0 | kira-nostr, nostr-core |
| `hkdf` | 0.13.0 | MIT OR Apache-2.0 | nostr-core |
| `hmac` | 0.13.0 | MIT OR Apache-2.0 | nostr-core |
| `hybrid-array` | not visible | MIT OR Apache-2.0 | kira-nostr, nostr-core |
| `inout` | 0.2.2 | MIT OR Apache-2.0 | nostr-core |
| `k256` | 0.14.0 | Apache-2.0 OR MIT | kira-nostr, nostr-core |
| `primefield` | not visible | Apache-2.0 OR MIT | kira-nostr, nostr-core |
| `primeorder` | 0.14.0 | Apache-2.0 OR MIT | kira-nostr, nostr-core |
| `sec1` | 0.8.1 | Apache-2.0 OR MIT | nostr-core |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 | skillsmith |
| `sha2` | not visible | MIT OR Apache-2.0 | kira-nostr, nostr-core |
| `subtle` | not visible | BSD-3-Clause. Notice: [`LICENSES/BSD-3-Clause-subtle.txt`](../../../../LICENSES/BSD-3-Clause-subtle.txt) | kira-nostr, nostr-core |
| `typenum` | not visible | MIT OR Apache-2.0 | kira-nostr, nostr-core |
| `wasmparser` | 0.262.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | skillsmith |
| `wnaf` | 0.14.1 | Apache-2.0 OR MIT | kira-nostr, nostr-core |
| `zeroize` | not visible | Apache-2.0 OR MIT | nostr-core |
| Rust standard library (`alloc`, `core`, `std`) | not visible | MIT OR Apache-2.0 | 24 cells: aukora-kernel, aumlok-identity, aumlok-keys, aura-relay, gate-judge, goal-receipts, grant-ledger, kira-core, kira-membrane, kira-nostr, kira-resume, kira-store-policy, lane-contract, lane-judge, lane-profile, laya, nostr-core, organism-tools, pair-judge, prompt-assembly, risk-signature, seed-judge, skillsmith, spatial-layout |

No crate path is visible in: `aura-focus.wasm` (built from the `.wat` source beside it), `pentora36.wasm`. For a file without visible paths and without source here, the toolchain and any embedded third-party code are unknown.
