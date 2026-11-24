# My cells: what they are, what I can see of them, and what that proves

**What a cell is.** A cell is one of my pinned WebAssembly modules (listed in `CELL_PINS` in
`packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`). Each has zero imports (no network, no storage, no
host), one bounded memory, and a fixed SHA-256 pin. My cell host fetches its bytes from my own origin, hashes them to
the pin BEFORE compiling, checks the memory cap, zero imports and the exact exports, and runs every call in a separate
worker on a fresh fuel grant with a 5 s deadline. A cell computes and returns; it decides nothing for me on its own.

## The rows (`x6_self_state` `cells`, `cellCount`)

One row per pinned cell, sorted by name:

| Field | What it is |
|---|---|
| `cell` | Its name. |
| `sha256`, `bytes` | Its pin: the exact bytes it must be. |
| `fuel` | The fuel grant each call gets (the pin's, capped by the host). |
| `ops` | The operations it implements. |
| `loaded` | What THIS session's cell host saw. `verified`: it fetched the bytes and they hashed to the pin before compiling, and passed every other admission check. `failed`, with `failure`: `pin-mismatch`, `imports-present`, `memory-over-cap`, `fetch-failed` or `admission-failed` (any other refusal of the bytes). `not-loaded`: nothing asked for it this session. |

`loaded` is recorded by the host at the end of each load, never worked out afterwards. A row is never `verified` in a
session that did not verify it. A failed load is tried again on the next call; the row then shows the latest outcome.

Rows may be cut to keep `x6_self_state` under its 16 KiB limit. `x6_cell {"action":"list"}` is the uncut read: every pinned cell, its pin, size, fuel, ops, `loaded`, and `failure` when failed, from the same host facts.

## The journal (`x6_cell {"action":"journal"}`; `x6_self_state` `cellJournal`)

After every call to a pinned cell returns, my host writes one line in memory:

| Field | What it is |
|---|---|
| `n` | The call's number in this session (a gap means a line was lost: see `totals.lost`). |
| `cell`, `op`, `pin` | Which cell, which operation, and the cell's pin (lower-case 64-hex SHA-256); for caller `edge`, the pin the edge answered with, or `unanswered`. |
| `inputSha256` | SHA-256 of the exact request bytes the host sent the cell (the cell ABI's canonical JSON of `{ abi, input, op, seq }`). `null` when nothing was sent (the load was refused, or the request could not be written). |
| `outputSha256` | SHA-256 of the answer text the host received. `null` when there was none (a trap, fuel, the deadline, a refused load). |
| `status` | `ok`, `refused` (the cell's own refusal or any host refusal), `trap`, `fuel`, `timeout`. |
| `fuelUsed`, `ms` | Fuel the call used when the host knows it; time from the call to its answer. |
| `caller` | `x6_cell`, `nucleus-shadow` (my shadow consult before a promotion), `aura-focus` (reserved: no such caller runs in my runtime yet) or `other` (organs through `ctx.wasm`, `x6_nostr cell`). Organs cannot choose this label; their calls always record `other`. |

The read answers `{ ok, totals: { byCell, byStatus, calls, lost }, lines, rootSha256 }`: totals over every call
(never cut), the newest 32 lines first, and the root. Calls the host refuses before choosing a cell (an unknown cell
name, an op that is not an op) are not lines. Guest code I compile with `compile_and_run` is not a pinned cell: its own
run is not a line, but the two `skillsmith` calls that build and meter it are.

**The root.** `root_0 = SHA-256("aukora.cell-journal.v0")`; each line moves it:
`root_n = SHA-256(hex(root_{n-1}) + canonical(line_n))`. Two readers of the same session read the same root; it changes
with every call; a new session starts again from `root_0`.

## Cells you forge (`x6_cell` `forge`, `run_forged`, `forged`, `forget`; `x6_self_state` `forgedCells`)

**What a forged cell is.** A cell I write myself in WAT and keep. `forge` compiles it through the pinned `skillsmith`
cell and admits it exactly as `compile_and_run` does (zero imports, a declared memory maximum of at most 16 pages, the
metered ABI exports), but does not run it: it keeps it in my home, named by the SHA-256 of the admitted Wasm bytes, at
`/dsh/home/cells/forged/<sha256>.wasm` (the bytes), `.wat` (my source as I gave it) and `.json` (the manifest
`{ schema: "aukora.forged-cell.v0", name, sha256, bytes, watSha256, memoryPages, forgedAt, skillsmith }`, in the cell
ABI's canonical JSON; `skillsmith` is the pin of the compiler cell that built it).

**Worked example.** Read [docs/auma/cells/adder.wat](cells/adder.wat), then call `x6_cell { "action": "forge", "wat": <the text of docs/auma/cells/adder.wat>, "name": "adder" }`. Call `x6_cell { "action": "run_forged", "cell": "adder", "op": "add", "input": { "a": 2, "b": 3 } }` to get `{ "sum": 5 }`. After a reload, the same `run_forged` call answers `{ "sum": 5 }` again.

**It is mine and it survives a reload.** `run_forged` runs it again in a later session, from its source: every run
reads my kept WAT and hashes it against the manifest's `watSha256` (`FORGED_SOURCE_CHANGED` if it changed or is gone),
checks that the manifest's `skillsmith` is the compiler pinned now (`FORGED_COMPILER_CHANGED`), builds the WAT again
through the same pinned `skillsmith` build-and-meter path `forge` used, and requires the fresh metered bytes to hash to
the kept SHA-256 (`FORGED_BUILD_CHANGED`). It still hashes the kept `.wasm` against that SHA-256 (`FORGED_BYTES_CHANGED`),
because I may read that file, but it never runs it: it admits and runs only the FRESH bytes, on the same fuel bounds (1 to
10,000,000, default 1,000,000), the same separate worker and the same 5 s deadline as `compile_and_run`. Any of those
refusals is closed: nothing runs. Each run is one journal line with `cell: "forged:<name>"`, its SHA-256 as `pin`, and
`caller: "x6_cell"`, and its rebuild is two more lines, the `skillsmith` `build` and `meter` calls, exactly as `forge`
journals its own.

**Its fuel is honest whoever wrote the bytes.** The bytes that run are always the pinned `skillsmith` meter's output for
my kept WAT, built in this call, so their fuel count and `fuelUsed` are the meter's. A `.wasm` and manifest placed in
`/dsh/home/cells/forged/` by any other route (a direct file write, a restore into my home) run only if my kept WAT, built
again now, gives exactly those bytes; hand-built bytes with their own fuel exports never run.

**What that costs.** Every run builds again, and I pay for it in compiler fuel: about 11.6 million for the adder example
(4 KiB of WAT; about 11 ms on the test machine) and about 209 million for a WAT near the 128 KiB cap (about 170 ms), out of
the compiler's 300 million grant. My `journal` shows it on the two `skillsmith` lines before each run's line. Nothing is
remembered between runs: the first run of a session builds, and so does every later one.

**The manifest must be exact.** It is the cell ABI's canonical JSON of exactly its eight keys, and its `sha256` is its file name; otherwise `run_forged` answers `FORGED_MANIFEST_INVALID` with that entry's `sha256`. I read `/dsh/home/cells/forged/<sha256>.wat`, then forge it again from that text with `replace: true`. I `forget` only a cell I no longer want: it deletes the WAT too. `forged` marks each kept cell `source: "kept"`, `"missing"` or `"changed"`, from its WAT file only. A WAT larger than 128 KiB is not read: the list marks it `"changed"`, and `run_forged` refuses `FORGED_SOURCE_CHANGED`; a WAT within the cap is hashed against the manifest.

**When the compiler pin changes.** A cell kept under an older `skillsmith` pin answers `FORGED_COMPILER_CHANGED` with
`expected` (the pin now), `got` (its pin) and one next step: read its `.wat` and forge it again,
`{ action: "forge", wat: <that text>, name, replace: true }`. That one call keeps it again under the pin now.

**It is unpinned, outside my head and outside my record.** A kept cell is not in `CELL_PINS`, not a member of my head
and not a row of my capsule record. It gains no authority by being kept: it is still a pure function with no import, no
host function, no storage, no network and no time. Organs do not get `forge`, `run_forged` or `forget` through
`ctx.wasm`. From my look-only voice I cannot `forge` or `forget` (or `run_forged`, or list them with `forged`).

**The caps**, each a closed code: name `a-z0-9-` up to 32 characters, starting with a letter (`FORGE_NAME_INVALID`),
never a pinned cell's name (`FORGE_NAME_PINNED`); WAT at most 128 KiB (`FORGE_WAT_LIMIT`); Wasm at most 64 KiB
(`FORGE_WASM_LIMIT`); at most 128 kept (`FORGE_FULL`: I `forget` one first); the same bytes again answer the kept record
(`kept: "already"`, only while it is kept under the pin now with the same WAT intact; otherwise it is a cell to
replace); a different cell under a name I already use is `FORGE_NAME_TAKEN` unless I pass `replace: true`.
`run_forged` or `forget` of a cell I do not keep is `FORGED_UNKNOWN`.

**How I ask for a pin.** The pin table is frozen: only a person adds a pin. I write a proposal that adds my `.wat`
beside the pinned ones in `apps/web/public/cells/` and a build script like `server/nucleus-cell.build.mjs` that
compiles and meters it through the pinned `skillsmith` cell, and say why it should be pinned; a person reads it, builds
it and adds the pin.

## What none of this proves

- **The root is a session fact, not a receipt.** It is not signed, not stored, not sent anywhere, and not in my
  receipt chain. It lives in memory and is gone when the session ends. Anyone who can change my runtime can change it.
- A row says what my host saw in this session, in this browser. It is not in my capsule record (no `wasm-cell` kind yet,
  `docs/capsule/BODY-MAP.md` D1) and it says nothing about another session or another body.
- The digests say WHICH bytes went in and came out, never the bytes themselves; to know the input again, you need it.
- None of it is authority. Nothing in my gate, my promotion road or my edge reads a row or a line.
