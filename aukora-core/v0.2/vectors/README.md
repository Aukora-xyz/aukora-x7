# Round 11 conformance streams

Each group starts at a new genesis. A TSV row gives its label, wire length in bytes, expected verdict, and full resulting SHA-256 head. Concatenate the gzip-decompressed wire bytes in row order. A refusal leaves the prior head in place. The reference runner reads each exact published frame into Lean. The Wasm runner submits the identical bytes via the byte ABI. Both check the expected verdict and all 32 head bytes at every row.

The five original groups retain their round-ten wire bytes. The archived successful install now lacks the two required witnesses. Its expected verdict and the head after that attempt and its replay reflect this change. Stage `v0.1/fixtures/fixed-genesis.wasm` for that historical group. The other four old manifests retain their original expected heads.

| New group | Coverage |
| --- | --- |
| r11-evidence | All four classes, missing, self and forward references, wrong kind, exact search digest and interval, two-signature ceiling controls, direct and transitive bounds, error in an ancestor, inclusive boundaries and a valid act after reassessment |
| r11-fields | Every truncation inside representative v2 assessment, read, premise, named statement and outcome wires, trailing bytes and a complete accepted read |
| r11-safe | Live and halted comparisons across valid grants, mandate, spend, revocation and expiry, owner halt and recovery, host-recorded refusal, speech and outcome recording |
| r11-install | Head-bound grants on exact archives, both checker obligations, weakening after strengthening, full same-set and stronger-set upgrades |

Public genesis keys are in `fixtures/<group>/keys.bin` for new groups. The install group includes the candidate staging schedule and expected reason codes. The source-built successor's executable is shared across same-set and stronger-set examples. Each has a distinct final custom section committing its carried model. Historical and weak-gate controls use the actual archived files. The group runner constructs the staged bytes from those artifacts and the published model. [Candidate assembly](../tests/install-cases.mjs) · [Diagnostic names](../EXPORTS.md)

Run from the lab root with `node v0.2/tests/replay11.mjs`. To replay the install history in the admitted candidate itself use `node v0.2/tests/replay11.mjs --successor r11-install`. The clean build also replays each group on the public Lean definition. `sh v0.2/build.sh` rebuilds both Wasm files offline, checks all pins, compares published certificates and removes its build directory. [Lean replay](../tests/Replay11.lean) · [Wasm replay](../tests/replay11.mjs)
