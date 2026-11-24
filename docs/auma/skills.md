# My skills: what a skill is, how I keep one, and what it proves

Tags: RAN (run in this repository's tests), SOURCE (read in a file), UNVERIFIED.

## What a skill is

**A skill is something I learned to do, written down so that a cell does it, not a model.** It is one small record,
`aukora.skill.v1`, in the cell ABI's canonical JSON (SOURCE `packages/experimental/webworker-runtime/src/x6/skill-record.ts`).
It names exactly:

- the **cell** that runs it: a pinned cell (`kind: "pinned"`, by the sha256 of its bytes), or a cell I forged
  (`kind: "forged"`, by the sha256 of its admitted bytes and the sha256 of my kept WAT);
- the **op** it calls, and the **program** the cell gets with every input (by the sha256 of its bytes);
- the **weights** that define the machine, by digest, or null;
- the **evidence**: cases in the cell's own op format, each an input and the answer, and the oracle that gave them.

Its **id** is the sha256 of `"aukora.skill.v1\n"` followed by the record's bytes. Change one byte and it is another skill.

**Why it survives a model change.** The cell computes the answer. The model only chose to call it. Replace the model
that wrote the skill and the cell still gives the same answers, and I can check that: `check` runs every case again.

## What it is NOT

- **Not authority.** Nothing in my gate, my promotion road, my edge or my outward doors reads a skill (a test lists the
  only files that may name one: `tests/x6/kyber-cpu.spec.ts`, "her authority path never reads a skill").
- **Not a receipt.** A record says what a cell answered when it was kept. It is not signed and not in my receipt chain.
- **Not part of my head or my capsule record.** A kept skill lives in my home only.

## The tool (`x6_skill`)

| Action | What it does |
|---|---|
| `list` | The shipped skills (read from my own origin through `/cells/kyber/skills/index.json`) and the ones I keep, newest first (by when each record file was written; equal times by id): `{ id, name, cell, cases, source: "shipped" or "kept", verified }`. Each is checked against its record before it is listed. |
| `check { skill }` | Checks the record against the REAL artifacts (a pinned cell's bytes exactly as my cell host admitted them against the pin; a forged cell's kept bytes and WAT; the program; the weights), then runs every case again through the cell and compares each answer byte for byte. Answer: `{ ok, id, verified, cases: { total, agree, differ: [indexes] }, fuelUsed }`. Nothing is repaired. |
| `run { skill, input }` | Runs the skill's program on a new input through its cell, after the same check of the record. The input may not name a program key. The answer carries `skill: { id, name }`. |
| `keep { name, cell, program, cases, op?, weights?, state? }` | Keeps a new skill. `cases` are inputs only: the cell computes every answer, and those answers are the evidence (`oracle: "cell"`). |
| `forget { skill }` | Removes one I keep (a program or weights file goes with the last skill that names it). |

A skill on a **forged** cell always runs through `run_forged`'s whole path: my kept WAT is built again through the pinned
compiler and only those fresh bytes run (docs/auma/cells.md, "Cells you forge"). Every call is a line in my cell journal,
labelled `x6_cell`.

**Where they live.** `/dsh/home/skills/<id>.json` (the record), `/dsh/home/skills/programs/<sha256>.json` and
`/dsh/home/skills/weights/<sha256>.json`, each named by its own digest (write set: `kept-skill-store`).

**Caps**, each a closed code: name `a-z0-9-` up to 32 characters, starting with a letter (`SKILL_NAME_INVALID`); 1 to 64
cases (`SKILL_CASES_LIMIT`); a record at most 256 KiB (`SKILL_RECORD_LIMIT`); weights at most 1 MiB (`SKILL_WEIGHTS_INVALID`); at most 256 kept (`SKILL_FULL`); the whole store, records, programs and weights, at most 32 MiB (`SKILL_STORE_FULL`); never a
shipped skill's name (`SKILL_NAME_SHIPPED`); a name I already keep (`SKILL_NAME_TAKEN`); the same skill again answers
`kept: "already"`. Others: `SKILL_PROGRAM_INVALID`, `SKILL_CELL_UNKNOWN`, `SKILL_OP_INVALID`, `SKILL_CASE_INVALID`,
`SKILL_CASE_REFUSED` (the cell refused a case: nothing is kept), `SKILL_WEIGHTS_INVALID`, `SKILL_STATE_INVALID`,
`SKILL_UNKNOWN`, `SKILL_AMBIGUOUS` (name it by its id), `SKILL_INPUT_INVALID`, `SKILL_CELL_UNAVAILABLE` (my cell host did
not admit the pinned cell), `SKILL_CELL_MISSING` (I no longer keep the forged cell), `SKILL_PROGRAM_MISSING`, and
`verifySkill`'s own: `SKILL_ID_MISMATCH`, `SKILL_NOT_CANONICAL`, `SKILL_SHAPE`, `SKILL_CELL_MISMATCH`,
`SKILL_PROGRAM_MISMATCH`, `SKILL_WEIGHTS_MISMATCH`, `SKILL_EVIDENCE_MISMATCH`. A check whose cases differ answers
`ok: false`, `code: "SKILL_CASES_DIFFER"`.

From my look-only voice the whole tool is refused. `x6_self_state` shows `skills: { count, kept: [{ name, id }] }`.

## Worked example

A second shipped skill, `cord-echo`, runs the pinned `cord-echo` cell (`cord.run`, program `{ "profile": "fifo24" }`); its three cases start from genesis, and `check` re-runs them ([cord-echo.md](cord-echo.md)).

Check the shipped countdown (RAN, `tests/x6/kyber-skills.spec.ts`):

```json
{ "action": "check", "skill": "countdown" }
```

answers

```json
{ "ok": true, "id": "1205ded1b88bba84abc4fd171529b7ae2fc35e1cd8890f68651e745d8e1fcada", "name": "countdown",
  "verified": true, "cases": { "total": 16, "agree": 16, "differ": [] }, "fuelUsed": 15181553 }
```

Keep a second small program on the Kyber CPU, `a = a + b`, then halt (ROM word 1 is `ADD`, word 6 is `HALT`):

```json
{ "action": "keep", "name": "add-ab", "cell": "kyber-cpu", "program": { "rom": [1, 6, 6, 6, 6, 6, 6, 6] },
  "cases": [ { "state": { "a": 2, "b": 3, "halted": 0, "pc": 0 }, "steps": 8 },
             { "state": { "a": 9, "b": 9, "halted": 0, "pc": 0 }, "steps": 8 },
             { "state": { "a": 15, "b": 0, "halted": 0, "pc": 0 }, "steps": 8 } ] }
```

The cell answers each case (`a` is 5, 2 and 15: four-bit registers wrap), and the skill is kept as
`5dd36896bf1426eec9d16ff1fbe6e66757be3cafe887522bc1dd473c21055811`. Then `{ "action": "check", "skill": "add-ab" }` agrees
on 3 of 3, and `{ "action": "run", "skill": "add-ab", "input": { "state": { "a": 4, "b": 5, "halted": 0, "pc": 0 }, "steps": 8 } }`
answers `a: 9`. After a reload it is still listed and still checks.

A skill on a cell I forged: forge `docs/auma/cells/adder.wat` as `adder` (`x6_cell forge`), then
`{ "action": "keep", "name": "add-two", "cell": "adder", "op": "add", "program": { "a": 2 }, "cases": [ { "b": 3 }, { "b": 40 } ] }`
keeps the answers `{ "sum": 5 }` and `{ "sum": 42 }`.

## What none of this proves

- These checks do not establish continuity across hosts or after a model swap.
- `verified` and `check` say what THIS session saw, in this browser. A kept skill is not in my capsule record.
