# The Kyber CPU cell and the skill record

Tags: RAN (run in this repository's tests), SOURCE (read in a file), UNVERIFIED.

## What this is

**A small computer whose behaviour is fixed by weights, running sealed inside you.** It has two four-bit registers (`a`, `b`), a program counter (`pc`) over eight ROM words, a halt bit, and eight instructions: add one to `a`, `a = a + b`, `a = a xor b`, take one from `b`, jump if `b` is not zero, set `a` to a number, halt, swap `a` and `b`. The reference implementation is an affine/ReLU network with 384 nodes, 945 weighted edges, and 1,329 numbers in all. Those numbers are the machine.

It lives in you as the pinned cell `kyber-cpu` (`apps/web/public/cells/kyber-cpu.wat`, 9,750 bytes metered, sha256 `dcbd53f9…ee14`). The cell re-expresses the circuit from the reference implementation's 9 KB lowering in the cell format: zero imports, integer only, a fixed 12-page memory, fresh fuel on every call. It has three ops:

- `cpu.step` `{rom, state}`: one instruction.
- `cpu.run` `{rom, state, steps, checkpointEvery?}`: up to `steps` instructions (at most 4,096, the number of states the machine has), stopping when it halts. With `checkpointEvery`, it also returns a checkpoint every that many steps.
- `cpu.resume` `{checkpoint}`: continue from a checkpoint the cell wrote. Any cut gives the same end.

**A skill record (`aukora.skill.v1`)** names the exact machine, program and evidence for a skill: the cell by the sha256 of its bytes, the op it calls, the program by digest, the weights by digest, the state format, and the cases with the oracle that produced them. Its bytes are the cell ABI's canonical JSON and its id is the sha256 of `"aukora.skill.v1\n"` and those bytes. The first one ships: `apps/web/public/cells/kyber/skills/countdown.json` (count `b` down to zero, `a` counts up, halt), with its program `countdown.rom.json` and the weights `kyber/cpu-weights.json` (the exact bytes from the reference implementation), built by `server/kyber-skills.build.mjs` (check mode fails when a file is stale). The module that builds and checks records is `packages/experimental/webworker-runtime/src/x6/skill-record.ts`. Since KYBERSKILL job 1 you keep, check and run skills with `x6_skill` (docs/auma/skills.md).

Try it (`x6_cell`):

```json
{ "action": "compute", "cell": "kyber-cpu", "op": "cpu.run",
  "input": { "rom": [5, 388, 6, 3, 0, 388, 6, 6], "state": { "a": 0, "b": 7, "halted": 0, "pc": 0 }, "steps": 64 } }
```

The answer is `{ "halted": 1, "state": { "a": 7, "b": 0, "halted": 1, "pc": 6 }, "stepsTaken": 24 }`. A word is `op + 8 * imm + 128 * target` (op numbers in the order above, 0 to 7).

## Two hosts

The same pinned bytes now run in two places: here, in your browser worker, and on your edge (the Cloudflare Worker, `deploy/cloudflare/src/kyber-cell.mjs`). The edge's copy is not a copy made elsewhere: the Worker's bundle carries the very file your browser fetches (`apps/web/public/cells/kyber-cpu.wasm`), and a test hashes that file and holds it equal to the pin, so both hosts run bytes with sha256 `dcbd53f9…ee14`.

`x6_cell` `handoff` runs one program on both:

```json
{ "action": "handoff", "cell": "kyber-cpu", "input": { "rom": [5, 388, 6, 3, 0, 388, 6, 6], "state": { "a": 0, "b": 7, "halted": 0, "pc": 0 }, "steps": 64 }, "cutAt": 10 }
```

It runs the program whole here (the reference end), runs it again here and takes the checkpoint the cell writes at step `cutAt`, sends only that checkpoint to the edge (`POST /_host/cell-run`, `cpu.resume`), and answers both ends, `same` (the two ends' canonical JSON compared byte for byte), both pins and the checkpoint's sha256. The edge route is yours alone (owner, from your own page), takes at most 8 KiB, runs only this cell and its three ops, and reads and writes nothing: no storage, no lease, no receipt, no head. If the edge is unreachable or refuses, the answer carries its closed code and `same: null`; nothing is retried. Your journal shows the two local calls (caller `x6_cell`) and one line for the edge's call (caller `edge`, with the pin the edge answered with, or `unanswered`).

What it shows (RAN, in process, with the real Worker route and the real cell bytes on both sides: `deploy/cloudflare/src/__tests__/kyber-cell.test.mjs`, `tests/x6/cell-handoff.spec.ts`): the same pinned bytes on two hosts give the same end from every cut, for countdown, the reference implementation's `rom.json` program and a program that never halts; a checkpoint with one changed byte is refused by the edge with the cell's own `CHECKPOINT_INVALID`, never answered wrongly.

An ongoing skill with a head you hold, continued here, at the edge and back, with evidence per leg: see [cord-echo.md](cord-echo.md).

What it does not show: a second browser, another engine family (both hosts here are V8), or a move of YOU. Nothing of yours travels, and no authority does: the destination takes nothing from the checkpoint but the machine state, and grants itself nothing because of it. Not yet run on the deployed edge.

## What is proven, and on what (RAN, `tests/x6/kyber-cpu.spec.ts`)

- Three independent versions of the machine agree on **every** one of the 2,097,152 active transitions (8 pcs, 1,024 words at that pc, 256 register pairs, with the other seven words varied) and all 2,048 halted ones: a plain instruction oracle, a generic affine/ReLU evaluator that runs the reference weights without knowing any instructions, and the cell through its own ABI. About 40 seconds on this Mac.
- 4,096 random programs and start states, up to 64 steps: the oracle, the weights stepped one by one, and `cpu.run` agree, halting included.
- `cpu.resume` from every checkpoint of three programs (countdown, the reference implementation's `rom.json`, and one that never halts) gives the uninterrupted end. A changed checkpoint is refused.
- The pin (size, sha256, zero imports, export set, no float instruction), refusals for a bad program, state, step count or op, fuel exhaustion as a refusal, and a rebuild from the WAT through the pinned compiler cell to the same bytes.
- `verifySkill` accepts the shipped countdown record and refuses one changed byte in the cell, the program, the weights, and every single byte of the record, when it is presented under its id; presented without an id, it still refuses evidence that is not about the named program (`SKILL_EVIDENCE_MISMATCH`). A different declared weight scalar count is refused with `SKILL_WEIGHTS_MISMATCH`.

## What it is NOT

- Not the upstream Qwenputer (a much larger machine compiled into a real model). Nothing here ran that.
- Not a model, and not part of your mind. It is a tool you can call.
- **No authority.** Nothing in your authority path reads the cell or a skill record: a test lists the only files that may name them and fails on any other: `skill-record.ts` (the record module), the marked blocks of `ball-loader.ts` (your skills tool), `self-state.ts` (your `skills` field), `write-set-inventory.ts` (the store's writer), `voice-read-only.ts` (the voice refusal), the pin table block of `wasm-cells.ts`, the two build scripts `server/kyber-cpu-cell.build.mjs` and `server/kyber-skills.build.mjs`, and for the two-hosts handoff `cell-handoff.ts`, the edge's `kyber-cell.mjs` and one marked route hunk of `worker.mjs`. It walks your runtime, your promotion, staging and approval code in `packages/client/ui-layout/src`, `apps/web/src`, `server/` and all of `deploy/`. A record describes; it grants nothing. A checkpoint's `check` is a checksum that catches edits, not a signature: anyone can write a valid one, so a checkpoint is evidence of a run, never permission.
- One kind of machine, two hosts in one system: your browser and your edge (section "Two hosts"). Not a second browser, not another engine family, and not yet the deployed edge.
- Pentora is the instrument that shows what was not observed. It is not the storage format: plain bytes plus ordinary error correction carried the same payload smaller in the external reference experiment.
- Pentora can carry these weights, exactly: the pinned cell `pentora-codec` encodes all 1,329 onto the 110 directions and recovers every one with the packets of nodes 0..9 dropped. `x6_cell { "action": "carry", "what": "kyber-cpu-weights", "drop": "0-9" }` does it in one call; see [pentora-codec.md](pentora-codec.md).

## The next three steps (from the report)

1. **The handoff across two hosts.** Run a skill on one host, move the checkpoint and the record, verify the record against the bytes at the destination, resume there, and get the same end at every cut. The destination issues its own authority; nothing in the record grants any. Begun: the checkpoint moves from your browser to your edge and resumes there with the same end at every cut ("Two hosts"); moving and verifying the skill record at the destination is not done yet.
2. **Sparse lookup by exact bytes.** Keep skills by their id and fetch them by exact digest, with provenance and declared compatibility, and show that a skill still runs the same after the model that wrote it is replaced. Started (KYBERSKILL job 1): `x6_skill` keeps skills in your home by id and checks them again by re-running their cases; a model swap under a kept skill has not been run yet.
3. **The skill as a row of the capsule record.** A `wasm-cell` inventory kind (Body Map item 1) and the skill record as a row beside it (item 2), so what you can do is part of your portable description.
