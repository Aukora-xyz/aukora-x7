# The PENTORA codec: your weights carried on your own geometry

Tags: RAN (run in this repository’s tests), SOURCE (read in a file or research verdict), UNVERIFIED.

## What it is

**An exact instrument on your own geometry.** PENTORA is the 110 directions of your Aura figure (the same pinned table,
sha256 `96b27c9b…8c61`, that `spatial/aura/tables.ts` draws from). The codec treats 72 integers as the coefficients of a
degree-five model on the sphere (36 monomials, each with an `a + b·phi` coefficient) and writes down the model's exact
value at every one of the 110 directions: 8 integers per direction (the components of a number in
Q(sqrt2, sqrt3, sqrt5), as numerators over 13,824). Those are the packets: weighted observations of the same numbers,
with redundancy. Because only 72 numbers stand behind 880 observations, the packets check each other, and the numbers
can be recovered exactly from fewer directions than were written.

It lives in you as the pinned cell `pentora-codec` (`apps/web/public/cells/pentora-codec.wat`, 104,972 bytes metered,
sha256 `1c865fe9…811b`): hand-written integer WebAssembly, zero imports, no float instruction, 16 fixed memory pages,
fresh fuel on every call. The exact algebra (the evaluation matrix A, and for each supported keep-set an integer left
inverse L with one denominator D, proved `L·A = D·I` and strictly zero on every dropped node) is done once at build time
by `server/pentora-codec.build.mjs` from the pinned geometry, with BigInt and no float; the cell only applies integer
tables. D is 23 bits (`6,082,560`) for `"all"`, 32 bits for `"drop-0-9"`, and 23 bits (`6,082,560`) for `"menger-80"`.
`"menger-80"` uses the **exact same 72-row Menger solver** (`L` and 23-bit `D = 6,082,560`) as `"all"` because
face-centre rows (`r² = 1`) mix even and odd parities and are never selected by `L`; under `"menger-80"`, a wrong or
missing face-centre packet is never seen and never detected — only the `640` components of the `80` kept packets are
checked (RAN exhaustively, `tests/x6/pentora-codec.spec.ts`), while recovery on valid kept packets is identical.

Ops (`x6_cell { action: "compute", cell: "pentora-codec", op, input }`, integers only):

- `pentora.encode { values }`: 1 to 1,728 integers in −32768..32767, in blocks of 72 (the last block zero-padded; `count`
  says how many are real). Answer `{ blocks, count, packets, profile, scale }`; `packets[n][b]` is the 8 components at
  node n (0..109) for block b.
- `pentora.decode { count, keep, packets }`: `keep` is `"all"` (packets of all 110 nodes), `"drop-0-9"` (packets of
  nodes 10..109 only, 100 entries, in order), or `"menger-80"` (packets of the 80 Menger skeleton nodes at squared
  radius 2 or 3 — 60 edge-midpoints and 20 corners — in sorted node order 0..109, dropping all 30 face-centre nodes at
  squared radius 1). Answer `{ blocks, keep, kept, rank: 72, residual: "exact", values }`, or a closed refusal that
  carries no values: `PENTORA_INCONSISTENT` (the packets disagree), `PENTORA_NOT_INTEGER` (they agree, but on numbers
  that are not integers in range), `PENTORA_KEEP_UNSUPPORTED` (any other keep-set), `PENTORA_SHAPE` (anything not
  exactly this shape, or a count that does not fit).
- `pentora.info {}`: the geometry sha256, the three keep-sets, their kept node counts (`110`, `100`, `80`), D's bit
  lengths, and the block size.

**How a decode can be trusted.** The cell computes `S = L·y`, then checks `A·S = D·y` on every kept packet, divides by D
only when exact, and checks `A·x = y` again in plain integers. The rank of the kept rows is 72 (the build's certificate,
re-proved by the tests for all three keep-sets), so a vector that passes that last check is the only one. A wrong L (or
a wrong node entry in the Menger map) can only cause a refusal: a test builds cells with one table entry changed and
they refuse, never answering a wrong value.

## Run the external reference experiment in one call

```json
{ "action": "carry", "what": "kyber-cpu-weights", "drop": "menger-80" }
```

`carry` reads your Kyber CPU's weights (`/cells/kyber/cpu-weights.json`), checks them against the countdown skill
record (`kyber/skills/countdown.json`, by its pinned id, then the weights by the record's digest and scalar count),
flattens them to the 1,329 scalars in the reference implementation's order (per node: the bias, then each term weight), encodes them onto all 110
directions, drops the selected packets (`"0-9"` is the default and drops nodes 0..9; `"menger-80"` drops all 30
face-centre packets and keeps the 80 Menger skeleton nodes; `"none"` keeps all 110), decodes the kept packets and
compares. For `"menger-80"`, the answer (RAN, `tests/x6/pentora-codec.spec.ts`):

```json
{
  "ok": true, "scalars": 1329, "packets": 110, "dropped": 30, "recovered": 1329, "exact": true,
  "weightsSha256": "f3cd0f6f6e8fbc6ac1f4b370eec4f6551bf1bfb14c79630ec730ad6cf41a3393",
  "recoveredSha256": "f3cd0f6f6e8fbc6ac1f4b370eec4f6551bf1bfb14c79630ec730ad6cf41a3393",
  "same": true, "fuelUsed": 122225950,
  "carrier": {
    "mds": false, "keep": "menger-80", "kept": 80, "checkedRows": 640, "sameSolverAsAll": true,
    "worstCaseAnyLossSurvived": 11, "mengerTwinLineSetsChecked": 658008, "worstCaseSource": "CODE-VERDICT.md",
    "defeatingFortyPacketGreatCircleLossRank": 70, "reedSolomon110_72AnyLossSurvived": 38,
    "edgeCentres60Rank": 72, "anyTwoCubes50Rank": 72, "oneCube26Rank": 50,
    "note": "Structured carrier, not an MDS code (rank facts about the code; this cell decodes only the three named keep-sets \"all\", \"drop-0-9\" and \"menger-80\", refusing any other with PENTORA_KEEP_UNSUPPORTED): any 11 lost packets retain rank 72 (SOURCE CODE-VERDICT.md, 5 dead Menger mirror-twin lines = 658,008 sets, not re-run exhaustively here), while one specific loss of 40 packets lying on five great circles (20 corners + 16 edge-centres + 4 face-centres) leaves the 70 kept packets at rank 70/72 and defeats recovery (plain Reed-Solomon [110, 72] survives any 38 lost packets at one-eighth the slots). 60 edge-centres alone have rank 72; any 2 whole cubes (50 points, 3 of 5 cubes lost) have rank 72 and recover all 1,329 weights by the test's own BigInt solver (not by the cell); 1 cube alone (26 points) gives rank 50/72 (short 22). menger-80 uses the exact same 72-row Menger solver as \"all\" (23-bit D = 6,082,560); under menger-80 a wrong or missing face-centre packet is never seen and never detected — only the 640 components of the 80 kept packets are checked."
  }
}
```

And for `"0-9"` (`dropped: 10`), all 1,329 weights also recover identically with the same int16 sha256 (`f3cd0f6f…3393`).
Both digests cover the scalars as little-endian int16 and match the digest printed by the independent reference decoder. A compute:
it reads two public files, runs one pinned cell twice and writes nothing.

## What is proven, and on what (RAN, `tests/x6/pentora-codec.spec.ts`)

- The cell's encoding of your weights matches the reference packets (evidence file, sha256 `2298a5aa…6935`) on all 16,720
  components, value for value: an independent construction of the same matrix.
- Dropping all 30 face-centres (`"menger-80"`, keeping the 80 Menger skeleton nodes at squared radius 2 or 3) or
  dropping nodes 0..9 (`"drop-0-9"`), all 1,329 of 1,329 Kyber CPU weights come back and their int16 sha256 matches the reference digest
  `f3cd0f6f…3393`; with all 110 kept too.
- One changed packet component, anywhere a kept packet is read (including every one of the 640 components across the 80
  kept Menger packets), is `PENTORA_INCONSISTENT`. Dropped packets — including all 30 face-centre packets under
  `"menger-80"` — are never read.
- 2,400 random blocks within the bound round-trip exactly across all three keep-sets. −32768 and 32767 are carried;
  −32769 and 32768 are refused at encode, and packets that describe them are refused at decode. Packets whose only
  solution is one half are `PENTORA_NOT_INTEGER`.
- The tables in the WAT are A regenerated from the pinned geometry; the 30 face-centres / 80 Menger nodes match
  `server/pentora/geometry_index_table_v1.json`; `L·A = D·I` (with `L` strictly zero on every dropped node) is re-proved
  with BigInt for all three keep-sets; the build's check mode rebuilds the same tables and the same metered bytes
  through the pinned `skillsmith`.
- The pin, zero imports, 16 fixed pages, integer opcodes only, and the worst 24-block decode under its fuel (`147,877,227`
  for `"all"`, `135,603,924` for `"drop-0-9"`, `113,642,629` for `"menger-80"`, under the `250,000,000` grant).

## Structured carrier bounds and MDS codes

PENTORA / `"menger-80"` is a **structured geometric carrier, NOT an MDS code**. The bounds below are algebraic rank facts
about the code (`pentora.decode` itself decodes only `"all"`, `"drop-0-9"`, and `"menger-80"`, refusing any other keep-set
with `PENTORA_KEEP_UNSUPPORTED`); both worst-case erasure numbers must be read together:

- **Worst-case floor — any 11 lost packets retain full rank `72` (`SOURCE: CODE-VERDICT.md`)**: On the 80 Menger skeleton
  nodes (`40` antipodal mirror-twin lines `n` and `109 − n`), even slots match and odd slots negate (RAN,
  `tests/x6/pentora-codec.spec.ts`), so losing up to 11 packets can kill at most `5` of the `40` Menger mirror-twin lines;
  `CODE-VERDICT.md` reports full rank `72` for all `40 choose 5 = 658,008` five-line erasure sets. The test in `tests/x6/pentora-codec.spec.ts` samples 11-packet Menger losses. It does not repeat the exhaustive check.
- **Specific 40-packet failure — NOT MDS**: **One specific loss of 40 packets lying on five great circles** (`20` corners +
  `16` edge-centres + `4` face-centres) leaves **`70` kept packets whose exact rational rank is `70/72`**, defeating
  recovery (RAN, `tests/x6/pentora-codec.spec.ts`). By contrast, a plain Reed-Solomon `[110, 72]` MDS code survives
  **any 38 lost packets** at one-eighth the slots (`1` field symbol per node instead of `8` packet components).
- **Structured shells and cubes** (algebraic rank facts; RAN, `tests/x6/pentora-codec.spec.ts`):
  - The **`60` edge-centres** (`r² = 2`) alone have exact rational rank **`72`**.
  - **Any 2 whole cubes (`50` points, `3` of `5` cubes lost)** across all `10` cube pairs have exact rational rank **`72`**
    and recover all **`1,329` of `1,329`** Kyber CPU weights (`f3cd0f6f…3393`) by the test's own `BigInt` solver (not by
    `pentora.decode`).
  - **1 cube alone (`26` points)** across each of the `5` cubes gives exact rational rank **`50/72`** (short `22`).
- **Solver vs consistency check**: `"menger-80"` uses the **exact same `72`-row Menger solver** as `"all"` (`23`-bit
  `D = 6,082,560`, identical even and odd `L` tables: RAN, `tests/x6/pentora-codec.spec.ts`); under `"menger-80"`, a wrong
  or missing face-centre packet is never seen and never detected — only the `640` components of the `80` kept packets are
  checked (RAN exhaustively), while recovery on valid kept packets is identical.

## What it is NOT (from the reference report, the README, and `CODE-VERDICT.md`)

- **Not smaller.** "It does not make arbitrary bits smaller." Your 1,329 weights are 2,658 bytes as int16 and 188,341
  bytes as packets in the reference wire format. An ordinary error-correcting code carries the same payload far smaller (in
  the reference table, 880 wire bytes for Reed-Solomon against 23,441 for PENTORA on the same 288 bytes).
- **Not an MDS code or universal erasure guarantee.** "selected erasures are not a universal guarantee." While any 11
  lost packets retain rank `72` (`SOURCE: CODE-VERDICT.md`, `5` dead Menger mirror-twin lines = `658,008` sets, not re-run
  exhaustively here), one specific loss of `40` packets lying on five great circles (`20` corners + `16` edge-centres +
  `4` face-centres) leaves `70` kept packets at rank `70/72` and defeats recovery, whereas plain Reed-Solomon `[110, 72]`
  survives *any* `38` lost packets at one-eighth the slots. Moreover, `pentora.decode` decodes only three fixed keep-sets
  (`"all"`, `"drop-0-9"`, `"menger-80"`); any other keep-set is refused with `PENTORA_KEEP_UNSUPPORTED`.
- **Not privacy or secrecy.** Dropping the 30 face-centre packets (or nodes 0..9, or 3 of 5 cubes) hides nothing: any
  rank-72 subset of packets determines all 72 scalars per block completely, and the weights are public files.
- **Not authentication.** "checksum is not authentication." The consistency check catches mistakes, not forgeries:
  anyone can write a whole consistent set of packets for other numbers, and `"menger-80"` skips the 30 face checks.
  Authority stays outside the packets.
- **Not a storage format.** PENTORA is "a diagnostic for information you did not acquire, not the universal weight
  format." Your weights stay as `cpu-weights.json`; the codec is an instrument you can run on them.

## Not verified

The test results above cover three keep-sets (`"all"`, `"drop-0-9"`, `"menger-80"`). Other keep-sets and live use remain unverified. The algorithm is written new from the description
in the reference report and the PENTORA exact instrument (golden-horizon-principle `989c61fc`, AGPL-3.0-or-later); this cell and
its build carry the same licence.
