# Aukora Core

The Aukora Core is published alongside this repository, in its own repository: <https://github.com/Aukora-xyz/aukora-core>.

## What it is

That repository describes the Core as an admission function proved in Lean and compiled to WebAssembly from the same text. This repository includes the pinned v0.8 small Core Wasm and its public lab sample under `apps/web/public/core-cell/`. This revision does not run them in the app. The whole Core, with its Lean sources, proofs, every version and the full Wasm, is in [`aukora-core/`](../aukora-core/) (also published as its own repository). Replay is evidence about the supplied record, not a lock on app actions. Read the Core's own repository for what it proves and how to check it.

## What this tree contains of it

The shipped files `apps/web/public/core-cell/aukora-core-lite.wasm` and `apps/web/public/core-cell/sample-record.txt` (byte-identical to the Core repository's v0.8 small core and sample), and the edge modules named `core-*` under `deploy/cloudflare/src/`, written into this page by the export from the tree itself:

- `deploy/cloudflare/src/core-ack-head.mjs`
- `deploy/cloudflare/src/core-kernel-record.mjs`
- `deploy/cloudflare/src/core-read-door.mjs`

No other shipped file imports a `core-*` module, so the shipped Worker does not reach them.

Label: BUILT-ON-MAIN for these files as code. This page cites no live use.

## Limits the authors report for the Core

This tree cannot show these:

- Lab keys only.
- Run on one Apple-silicon Mac; Linux is untried.
- Not yet independently rebuilt from an empty folder.
