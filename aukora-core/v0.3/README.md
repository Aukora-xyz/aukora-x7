# Round 12 lab release

The full WebAssembly file checks the 36-clause ROOT v1. The Lean kernel refuted satisfaction of that root by the full machine. The positive results include versioned L2, the seven evidence laws, five safe-state laws, succession, three cell laws and finite-session refusal. At the finite record limit, both release files refuse further appends, including valid owner recovery. The lite file replays non-install frames and has no proof checker. [Round report](../REPORT-R12.md) · [Transcripts](../logs/R12-CHECKS.txt)

| File | Function |
|---|---|
| `aukora-core.wasm` | Full transition, ledger, staged executable comparison and proof checks. |
| `aukora-core-lite.wasm` | Bounded local replay and cell receipts. Every install is refused. |
| `fixtures/packages/` | Serialized declarations, model commitments and diagnostic witnesses. The negative fixtures do not authorize any successor. |
| `vectors/cell12/` | Public keys, 200 frozen cases and their exact input bytes. |
| `PINS.sha256` | SHA-256 of both release files and the detached fixtures. |

From the lab root, run `sh v0.3/build.sh` to rebuild from the vendored toolchains, check the proofs, verify the pins and replay the Wasm cases. Each compiler holds the serial lock and receives `-j1 -M 4096`. The build removes its disposable v0.3/.work directory. The Node regressions can also run directly on these files, for example `node v0.3/tests/cell12.mjs`. [Exports](EXPORTS.md) · [Wire](WIRE.md)
