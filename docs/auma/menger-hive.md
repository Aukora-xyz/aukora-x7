# menger-hive: split-body wave co-simulation, mid-run organ handover, and the 8-tick horizon

For Auma and the owner. A Menger sponge cell. Tags: RAN (run in this repository's tests), SOURCE (read in a file), UNVERIFIED.

## What it is

`menger-hive` is a pinned hand-written integer WAT cell (`apps/web/public/cells/menger-hive.wat`, `79,105` bytes, built and metered through the pinned `skillsmith` cell by `server/menger-hive-cell.build.mjs` into `apps/web/public/cells/menger-hive.wasm`, `25,300` bytes, `sha256: 80fba1f9ea6de88c9618429044dfb1d04693696c4125e55b53fe8e69ca6e99c6`).

From `server/pentora/geometry_index_table_v1.json` (`sha256: 96b27c9b4de41cd961612be5b1e88d40e973a2fded16bd320415b3e15e3b8c61`), the build script derives `apps/web/public/cells/menger/wirings.v1.json` (`sha256: 25b846a37f34eee87698f1b9f119dc3101ebfe1ab73ab17de0758f0546a930a3`) and embeds **both** 80-site wirings inside the **same** cell:

1. **`"menger"`**: the 80-site level-1 Menger skeleton (`0..19` = the 20 sorted corner sites `kind == 3`, each degree 6; `20 + 12*k .. 20 + 12*k + 11` = organ `k`'s 12 sorted private edge-midpoints `kind == 2, cubes_of == {k}`, each degree 2), 120 Menger links, cycle rank 41, detuning `DET110[POS[g]]` (`(pos * 17 + 3) mod 11` in sorted 110 non-centre site order).
2. **`"plain"`**: a deterministic two-sided (`4|4` bipartite) plain control inside the same cell: 20 shared sites (`0..19`, 2 per pair `(a, b)` of the 5 banks so each bank touches 8 shared sites) + 5 banks of 12 private sites (`20..79`), each private site wired to one left and one right shared site of its bank's rotated `4|4` split and each shared site used 3 times per bank = 80 sites, 120 links, degrees `20×6` and `60×2`, cycle rank 41, detuning `DET110[0..79]`.

Both wirings evolve under the same detuned wave law over $\mathbb{F}_{65521}$ (`P = 65,521`) on the 160-word state `[q0..q79, p0..p79]` with scalar inlet `u` at shared corner `0` (`b[0] = 1` on both `q` and `p`):
$$p' = (p + L q + b u) \bmod P, \qquad q' = (q + p') \bmod P, \qquad L = \mathrm{Adj} - \mathrm{Deg} - \mathrm{diag}(\mathrm{det}).$$

For every organ $k \in \{0..4\}$ on **both** `"menger"` and `"plain"`, the 24-word organ state $x_a$ (`12` private $q$ + `12` private $p$) and the 136-word remainder $x_b$ (`20` shared corners + `4` other organs' `48` private sites, $q$ and $p$) couple across each tick with **exact rank 7** in both directions ($F_{a,k} R_{a,k} = M[S_a, S_b]$ and $F_{b,k} R_{b,k} = M[S_b, S_a]$ mod $65,521$, verified at build time by `server/menger-hive-cell.build.mjs`, RAN).

## The call (`x6_cell` action `"hive"`)

```json
{
  "action": "hive",
  "ticks": 24,
  "cut": 12,
  "edgeOrgan": 0,
  "handoverOrgan": 1,
  "seed": 1,
  "wiring": "both"
}
```

- **No tick batching**: every single tick `t = 0 .. ticks-1` performs:
  1. `hive.boundary { bodyState, edgeOrgan, wiring }` in the browser cell host $\to$ `msgToEdge[7]` ($R_{a,k} x_b \bmod P$);
  2. an unbatched `POST /_host/cell-run` (`hive.step_organ { input, msgIn, organ, organState, wiring }`) at the edge Worker $\to$ `nextOrganState[24]`, `msgOut[7]` ($R_{b,k} x_a \bmod P$), `organSha256`;
  3. `hive.step_body { bodyState, edgeOrgan, input, msgFromEdge, wiring }` in the browser cell host $\to$ `bodySha256`, `corners[20]`, `nextBodyState[136]`.
- **Mid-run organ handover at `cut`**: on ticks `0 .. cut-1`, `edgeOrgan` runs on the edge; at tick `cut`, `edgeOrgan`'s 24 words rejoin `bodyState` in the browser while `handoverOrgan`'s 24 words move out to the edge for ticks `cut .. ticks-1` (`handoverOnceWords: 24` when `0 < cut < ticks` and `edgeOrgan !== handoverOrgan`, else `0`).
- **Tick-by-tick monolith & digest check**: at every tick, the reassembled 160-word split-body state and its WebCrypto `stateSha256` (`SHA-256` of 160 `u16le` words = 320 bytes) are checked against `hive.step_monolith` and the TypeScript wave oracle; any lying, tampered, or replayed edge answer is refused immediately on the first differing tick with closed code `HIVE_SPLIT_MISMATCH` (`ok: false`, `runs: {}`), so every `ok: true` answer guarantees `mismatchedTicks: 0` and `allDigestsEqual: true` (RAN in `tests/x6/menger-hive.spec.ts`; the edge cell ops and ABI are tested in `deploy/cloudflare/src/__tests__/menger-hive-cell.test.mjs`).
- **Local step bookkeeping vs rewind detection (`KNOWLEDGE-CALCULUS.md`)**: `steps[t] = { tick, organ, corner0, stateSha256 }` records the local 1-based step counter `tick`. Because `hive.step_organ` answers carry neither `tick` nor `seq`, `tick` is local step bookkeeping (`UNSUPPORTED` as standalone rewind detection); tampered or replayed edge answers are instead caught and refused as `HIVE_SPLIT_MISMATCH` by the per-tick monolith & digest comparison (`RAN`), while `mengerObserve` checks caller-supplied `seqs` when provided (`{ status: "INCONSISTENT", reason: "rewind" }`, RAN).
- **Transparent wire accounting (`wordsCrossed`)**: `/_host/cell-run` is a stateless Worker route with zero server memory, so each HTTP call carries the active organ's 24 state words alongside the 7-in / 7-out algebraic boundary coupling. `menger-run.ts` reports both numbers side by side:
  `{ handoverOnceWords: 24, boundaryInPerTick: 7, boundaryOutPerTick: 7, boundaryTotalPerTick: 14, statelessHttpEchoWordsPerCall: 24 }`.

## Cell ops and refusals

`menger-hive` exports Microverse ABI v1 (`memory` fixed `4..4` pages, zero imports) and five ops (`EDGE_CELLS['menger-hive']` allows all five ops — `hive.info`, `hive.step_monolith`, `hive.boundary`, `hive.step_organ`, `hive.step_body` — at `/_host/cell-run`):

- `hive.info {}` $\to$ `{ boundaryWords: 7, corners: 20, cycleRank: 41, field: 65521, horizonTicks: 8, links: 120, organWords: 24, organs: 5, sites: 80, stateWords: 160, tableSha256, wirings: ["menger", "plain"], wiringsSha256 }`
- `hive.step_monolith { input, state[160], wiring }` $\to$ `{ corners[20], nextState[160], stateSha256 }`
- `hive.boundary { bodyState[136], edgeOrgan, wiring }` $\to$ `{ msgToEdge[7] }`
- `hive.step_organ { input, msgIn[7], organ, organState[24], wiring }` $\to$ `{ msgOut[7], nextOrganState[24], organSha256 }`
- `hive.step_body { bodyState[136], edgeOrgan, input, msgFromEdge[7], wiring }` $\to$ `{ bodySha256, corners[20], nextBodyState[136] }`

Closed cell refusals (in precedence order): `MALFORMED`, `OP_UNKNOWN`, `HIVE_SHAPE`, `HIVE_WIRING_UNKNOWN`, `HIVE_ORGAN_RANGE`, `HIVE_WORD_RANGE`.

## What a corner watcher can know — and why `privacyClaim` is `false`

`packages/experimental/webworker-runtime/src/x6/menger-observe.ts` analyzes observability of the 160-word state from the 20 shared corner readings and declared scalar inputs over $\mathbb{F}_{65521}$ (RAN, `tests/x6/menger-observe.spec.ts` and `tests/x6/menger-hive.spec.ts`):

- **At `T = 8` ticks (`horizonTicks: 8`, 160 corner readings)**: the observability matrix has **full rank 160** (`blindDimsAt8: 0`) on **both** `"menger"` and `"plain"`. Every private organ word is `KNOWN` by linear solve in `mengerObserve` with `state` omitted (`undefined`), from the 160 corner readings and 8 inputs alone (`solvedWithoutState: true`, RAN). **Neither Menger nor the rank-7 boundary hides private organ state past 8 ticks (`privacyClaim: false`).**
- **At `T = 4` ticks (80 corner readings)**: `blindDimsAt4: 80` on both wirings. Any reachable start state has a constructive **reachable** blind twin (`replayInputsFromZero[160]`) that differs on organ `0`'s first private word (e.g. `seed = 5` on `"menger"`: `8859` vs `38200`, RAN) while producing all **80 identical corner readings** across the 4 ticks (verified through `hive.step_monolith` on every run).
- **What actually separates `"menger"` from `"plain"`**: `plainMatchesMengerOnSplitAndHorizon: true` — both wirings have the exact same 7-in / 7-out organ boundary rank, `0` split-body mismatches, and the exact same 8-tick full-rank observability horizon. With detuning off, the reach from corner `0` (`undetunedOneCornerWaveReach`) is `20` (`"menger"`) and `80` (`"plain"`) for these two particular constructions; with detuning on, as the cell runs, both reach `160`, and no claim is made about the cause (RAN).

## Real organism wiring vs the symmetric 20-corner model (`ORGANISM-WIRING.md`)

`menger-hive` models the symmetric 5-cube Menger skeleton and symmetric `4|4` Plain control (`BLANKET.md`), where all $\binom{5}{2} = 10$ organ pairs share `2` corner values (`20` live shared corner words total).

In Auma's **real five-organ architecture law** (`mind`, `loop`, `aperture`, `ledger`, `checks`, reported on every `"hive"` answer under `organismWiring`):

- **`mind–ledger` and `mind–checks` are cut** (`mind` never touches the ledger or the checks directly; she proposes and the sealed gates decide).
- Cutting those two organ pairs leaves **16 live shared values and 4 sealed corners** (not 20 symmetric live corners).
- Among the five real organs, **`loop`** (`edgeCandidateOrgan: "loop"`) is the real organ worth moving to the edge.

## What is NOT claimed

- **Zero privacy (`privacyClaim: false`)**: private edge-midpoint words are hidden for 4 ticks (`blindDimsAt4: 80`), NOT forever (`blindDimsAt8: 0`).
- **Zero authority**: `menger-hive`, `menger-run.ts`, and `menger-observe.ts` compute and return; they write no browser VFS path, touch no Worker binding (`HEAD`, `MIRROR`, `VOICE_BRIDGE`, `ARCHIVE_BUCKET`, `ASSETS`), mint no receipt or lease, and are refused from look-only voice (`VOICE_LOOK_ONLY`). Both the cell files and `menger-run.ts` / `menger-observe.ts` are frozen against self-proposals (`deploy/ci/frozen-paths.mjs`).
- **Measured fuel & payload (RAN)**: worst-case single-call fuel across all 5 ops is `238,777` against a pin of `2,000,000`; each `hive.step_organ` HTTP request body is under `400` bytes against the `8,192`-byte `/_host/cell-run` limit.
