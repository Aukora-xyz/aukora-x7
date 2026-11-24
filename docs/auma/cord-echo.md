# cord-echo: one skill that keeps going, here and at my edge

For Auma and the owner. CORDECHO job 1. Tags: RAN (run in this repository's tests), SOURCE (read in a file), UNVERIFIED.

## What it is

`cord-echo` is a small pinned cell (hand-written integer WAT, `apps/web/public/cells/cord-echo.wat`, built and metered by
the pinned `skillsmith` cell through `server/cord-echo-cell.build.mjs`). It runs ONE ongoing skill: it keeps a running
state between calls, owns the logical tick, and takes typed inputs. I can run a stretch of it here, in my browser, then
the next stretch at my edge (the Cloudflare Worker running the same pinned bytes), then come back, and the outputs and
state roots are the same as if it had never moved (RAN, `tests/x6/cord-echo.spec.ts`: 4 fixed and 16 seeded cut
schedules over 3,200 ticks).

The profile is `fifo24` (`apps/web/public/cells/cord/fifo24.profile.json`, its sha256 built into the cell). The field
is P = 65,521. The state is my last 24 inputs, `s[k] = u[t-k]`. After input `u[t]` the output is
`y[t] = 3u[t-7] - 2u[t-15] + u[t-23] mod P`; inputs before tick 1 count as zero.

## The calls

```json
{ "action": "cord", "step": "start" }
{ "action": "cord", "step": "feed", "inputs": [3, 1, 4, 1, 5], "at": "here" }
{ "action": "cord", "step": "feed", "inputs": [9, 2, 6], "at": "edge" }
{ "action": "cord", "step": "status" }
```

- `start` makes the genesis checkpoint (tick 0, zero state, parent 64 zeros) and keeps it as my head. Again: `CORD_ALREADY_STARTED`.
- `feed` runs one leg of 1 to 1,000 inputs (each 0..65,520) here or at my edge, and commits it only when every check
  below holds. It answers `{ ok, at, tick, head, parent, outputs, evidence }`, or `{ ok: false, code, at, evidence }`.
- `status` reads my head, tick, generation, how many checkpoints I keep, the retention promise and the last evidence.
  It is the one step a look-only voice turn may take: it fetches the shipped skill files (same-origin GETs of
  `/cells/**`), reads `head.json`, calls no cell and writes nothing. `start` and `feed` are refused from voice. My
  capability index lists `cord` under write, because it is keyed by action and two of its three steps write.

The cell's own ops are `cord.genesis { cell, profile, skill }`, `cord.run { checkpoint, expect: { head, tick }, inputs,
profile }` and `cord.info {}`. Its refusals are closed and the first in this order wins: `CORD_SHAPE`,
`CORD_PROFILE_UNKNOWN`, `CORD_PROFILE_MISMATCH`, `CORD_STATE_RANGE`, `CORD_STATE_DIGEST`, `CORD_HEAD_DIGEST`,
`CORD_HEAD_STALE`, `CORD_INPUT_RANGE`, `CORD_LIMIT`. A refusal carries no checkpoint and no outputs.

## The checkpoint (`aukora.cord.checkpoint.v1`)

`{ cell, head, inputRoot, outputRoot, parent, profile, profileSha256, schema, skill, state[24], stateSha256, tick }`,
canonical JSON.

- `stateSha256`: SHA-256 of the 24 words as u16 little-endian, `s[0]` first.
- `inputRoot_t = SHA-256(inputRoot_{t-1} || u32le(t) || u16le(u_t))`, seed `SHA-256("aukora.cord.inputs.v1")`; `outputRoot`
  the same over `y_t`, seed `"aukora.cord.outputs.v1"`. Roots are per tick, so they do not depend on where a run was cut.
- `head`: SHA-256 over a fixed 248-byte layout: `"aukora.cord.head.v1\n"`, then cell, skill, profileSha256, parent (32 raw
  bytes each), `u32le(tick)`, stateSha256, inputRoot, outputRoot. The cell computes it; I recompute it with WebCrypto.
  Heads depend on where I committed (the parent chain), by design; roots and outputs do not.
- `cell` is echoed by the cell, which cannot know its own pin: each host checks it against its own pin (`CORD_PIN_MISMATCH`).
- `skill` is the shipped record's id (`x6_skill list`, name `cord-echo`). The record's own cases use a fixed value instead,
  `SHA-256("aukora.cord.case-skill.v1")`, because a record cannot contain its own id (its cases hold checkpoints, and a
  checkpoint names the skill). The cell binds `skill` into the head and never judges it; I require it to equal the record's id.

No signature, no time and no session are in it. Digests catch edits, but anyone can compute them, so **a checkpoint is
evidence of a run, never permission**.

## Where the head lives, and why the edge's check is not independent

My head lives in my home: `/dsh/home/cord/<skillId>/head.json` (`{ generation, head, tick }`), with each checkpoint in
`checkpoints/<head>.json`, named by its own head and re-hashed on every read (write set `cord-checkpoint-store`). That is
Kira's shelf. A checkpoint cannot declare itself current (`docs/capsule/CONTRACT.md` 6.6 and 7.1): freshness is decided
by the head I hold. A leg commits only when, against what I read under my lock (`navigator.locks`, `aukora-cord-<skillId>`):
the answer's parent is my head; its tick is mine plus the inputs; profile and its digest are unchanged; the cell is my pin
and the edge's answered pin is my pin; head and stateSha256 recompute; the input root equals the chain I compute over the
inputs I sent; the state and the outputs equal my own TypeScript oracle over this segment only (the prefix is never
replayed); and `head.json` is still what I read (else `CORD_HEAD_MOVED`). Then the checkpoint is written, then
`head.json` with generation + 1, then old checkpoints are pruned. Any failed check writes nothing under `/dsh/home/cord/`.

The edge has no memory: its `expect` comes from my request. Its `CORD_HEAD_STALE` catches a request assembled from the
wrong checkpoint; it is NOT an independent head. A head held AT the edge would need edge storage, which this job does not
add (HEAD, MIRROR and the lease are untouched). That stays missing.

Retention: 8 checkpoints are kept; the current head and its parent are never pruned. The skill forgets every input older
than 24 ticks; every output from a kept checkpoint forward can be recomputed given its inputs; the current output can be
computed from the state.

## The evidence record (`aukora.cord-evidence.v1`)

One per `feed`, refused or not, a refusal of the call's own shape included (`CORD_ARGS_INVALID`, `CORD_AT_INVALID`,
`CORD_INPUTS_INVALID`: nothing ran, `at` is null when no valid place was named): `{ at, skill, profile, parent, head|null, tick, inputs, inputRoot, outputRoot,
stateSha256, pins: { here, edge }, fuelUsed, code|null, claims }`. Each claim is KNOWN, UNOBSERVABLE or FAILED, and by what:

| Claim | When it is KNOWN |
|---|---|
| `parent-is-my-head` | by my store, read under my lock |
| `head-recomputed` | by WebCrypto, here |
| `state-is-my-last-24-inputs` | by my TypeScript oracle |
| `outputs-match-my-oracle` | by my oracle over this segment |
| `pin-equal` | at the edge, only as "the edge SAID this pin" |
| `bytes-that-ran-at-the-edge` | never: always UNOBSERVABLE. A different program giving the same answer cannot be told apart from the answer; only the build-time pin test speaks to the bundle |
| `edge-fuel` | never: always UNOBSERVABLE (the edge's own report) |

The last 32 records live in session memory (`status`); each leg is also a cell journal line (here: caller `x6_cell`;
edge: caller `edge`). Not signed, not stored, not in my receipt chain, not in my capsule record. That is Aura's name for it.

## What a watcher can know (the blind twin)

`src/x6/cord-observe.ts` answers, from a checkpoint at tick c, the inputs for c+1..c+k and the outputs observed, whether a
claim about tick c is determined. With 23 observed outputs, `u[c-10]` is KNOWN (its value comes from the outputs alone),
and the current output `y[c]` is UNOBSERVABLE: the oldest word `s[23]` enters no future output, so the twin `s[23] + 1`
gives every observed output and a current output larger by exactly 1. The pinned cell confirms it: both checkpoints give
the same 23 (and 40) outputs (RAN, `tests/x6/cord-observe.spec.ts`).

## What is NOT claimed

- Not a better memory: 24 words (48 bytes) is the floor for this contract (rank 24); the lab's 30-word wave is not in my
  body and would cost 60 bytes.
- Not authority, not a receipt, not a second machine, not another engine family (both hosts are V8).
- Not run on the deployed edge yet, not run in my real browser yet, not run on a second physical machine.

Measured (RAN): the cell is 13,530 bytes, sha256 `9d5935d3…32fa`; the worst call (1,000 inputs from a full checkpoint)
uses 26,046,902 fuel against a pin of 60,000,000; the largest edge body is 7,044 bytes of the 8 KiB the route takes.
