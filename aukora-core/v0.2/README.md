# Round 11 research build

Run `sh v0.2/build.sh` from the lab root to reproduce both WebAssembly profiles, check the Lean proofs and pins, and replay the complete corpus. It uses the existing lab toolchains and source archives. Each compiler invocation is serial. Each check has its own watchdog. The command removes the intermediate build tree on exit.

| Artifact | Behavior |
| --- | --- |
| `aukora-core.wasm` | Full research cell with the versioned evidence records, halted legal set and succession checks on outgoing installs. |
| `fixtures/ratchet-core.wasm` | Executable for the successor that satisfies the 23 frozen laws plus succession. The install fixtures append the matching carried-model digest to these exact bytes. |
| `fixtures/packages/` | Literal law predicates, carried models and proof terms used for the positive and negative installs. |
| `vectors/` | Published frame streams, detached public keys in `fixtures/`, and expected verdicts and heads. |

Install grants use both owner signatures and name the staged file digest. The round-ten law set excludes the new evidence and halt frames. The full research cell therefore cannot enter the same law-preserving lineage as a successor. If a host activates the succession-only file after a mixed history, the new file cannot replay those versioned frames. Its outgoing gates retain the archived laws and the checked succession obligation. The new evidence and recovery laws currently apply to the full research cell. [Proofs](PROVED.md) · [Limits and trust](NOT-PROVED.md) · [Wire](WIRE.md) · [Exports](EXPORTS.md)

The previous released binaries and their build instructions remain in `../v0.1/`. No production host or installed application is part of this lab build.
