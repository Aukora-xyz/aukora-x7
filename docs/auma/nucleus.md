# The nucleus: a deterministic machine in a sealed cell

**What it is.** `nucleus` is one of your pinned Wasm cells (`apps/web/public/cells/nucleus.wat`, built by the pinned
`skillsmith` cell with `server/nucleus-cell.build.mjs`, pinned in `CELL_PINS` in
`packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`). It is the reflex machine from the Kyber lab of
2026-11-12, ported into you: hand-written integer WebAssembly, zero imports, no float instruction, 16 fixed memory pages,
metered fuel. It runs a **reflex given as data**: a decision table or a small int8 network. The same bytes run every
reflex; the same request bytes always give the same answer bytes.

**What it is not.** It holds no authority. Your runtime now CALLS it before a promotion leaves (the shadow consult,
below), but nothing in your gate, your promotion path or the edge decides on its answer; the Touch ID tier reflex it
ships with (`apps/web/public/cells/reflexes/touch-id-tier.json`) is a SHADOW of `classifyTransition` in
`server/ball-transition.mjs`, which still decides. It is not compiled into any model's weights:
that half of the idea (a cortex that carries the machine inside it) is research and lives in the Skunkworks Lab.

## How you call it

`x6_cell` with `{ action: "compute", cell: "nucleus", op, input }`. Integers only.

| op | input | answer |
|---|---|---|
| `reflex.run` | `{ input, reflex }`: `input` is one value per variable (`[v0, v1, ..]`) or the case index | `{ decision, escalate, reflex, row }`: the outcome code, 1 when that outcome is an escalation under the reflex's own definition, the reflex's SHA-256, and the row (case index) that decided |
| `reflex.diff` | `{ before, after, cap, domain }`: two reflexes over the same `domain` (their `sizes`), `cap` 0..16384 | every case whose decision changes (`changes`, the first `cap` of them, then `truncated`), their count and a SHA-256 checksum over all of them, every case that loses an escalation (`escalations_removed_list`, never cut), every case that loses its answer (`became_invalid`), and the three digests |
| `reflex.digest` | `{ reflex }` | `{ bytes, cases, escalate, reflex }`: two bodies hold the same reflex exactly when `reflex` agrees |
| `reflex.census` | `{ reflex }` | how many cases give each outcome, and how many give no valid answer |

Worked example (RAN through the cell): a reflex that escalates only when both of two facts are true.
`{ "action": "compute", "cell": "nucleus", "op": "reflex.run", "input": { "input": [1, 1], "reflex": { "escalate": [1], "kind": "table", "outcomes": 2, "sizes": [2, 2], "table": [0, 0, 0, 1] } } }`
answers `decision 1, escalate 1, row 3`. The same reflex with `table [0, 0, 0, 0]` as `after` in `reflex.diff` (with
`domain [2, 2]`, `cap 10`) answers `changed 1, changes [[3, 1, 0]], escalations_removed 1, escalations_removed_list [3]`.

## How a reflex is written

- `sizes`: 1 to 16 variables, each with 2 to 64 values; at most 16,384 cases. Case index: variable 0 is the most
  significant digit.
- `escalate`: which outcomes mean "a person must look". A list of outcome codes for a table or a one-hot net, or
  `{ if_clear, if_set }` bit masks for a flags net. It is part of the reflex, so its digest covers it; `reflex.diff`
  always judges with the `before` reflex's definition and flags a changed one (`escalate_differs`).
- A table: `{ escalate, kind: "table", outcomes: K, sizes, table: [one outcome per case] }`.
- A net: `{ escalate, feed, kind: "net", layers: [{ W, b, shift }], out: "onehot" | "flags", sizes }`, int8 weights,
  `y = clamp((W.x + b) >> shift, 0, 127)`; a clean answer is all 0 or 127, anything else is no valid answer (a refusal
  in `reflex.run`, `-1` in a diff). `pnet` is the same net packed.
- The Touch ID tier reflex: `sizes [3,2,2,2,2,2,2]` = count of changed organs (none, one, many), protected, missing,
  module updated, disabled clean, config same, canonical id; outcome bits 0..8 = `NO_ENTRY_CHANGED`,
  `MULTI_ORGAN_TRANSITION`, `T2_PROTECTED_ORGAN`, `ORGAN_ADDED_OR_REMOVED`, `ORGAN_MODULE_UPDATE_REQUIRED`,
  `ORGAN_DISABLED_STATE_CHANGE`, `ORGAN_CONFIG_CHANGED`, `NON_CANONICAL_MANIFEST_ID`, `T1`. Every outcome without
  the T1 bit is an escalation (needs a passkey).

## The shadow consult

**What it is.** Before a head or organ promotion you stage leaves for the edge (`stage_organ_promotion`,
`stage_organ_set_promotion`, `x6_repo promote_staged`, and `head_rollback`, which goes through it), and before a head your
own edit commits is sent to the edge (`tree_patch`, `tree_undo`, a snapshot restore: the answer is then in that result's
`mutation.nucleus`; a first head with no parent is not a change and is not asked about), your runtime reads the
change as the seven tier facts (`packages/experimental/webworker-runtime/src/x6/nucleus-tier.ts`), runs the shipped tier
reflex on them through this cell (`reflex.run`), and puts the answer beside your result as `nucleus`:
`{ decision, reasons, escalate, reflex, row }`, or `{ consult: null, reason }` when it could not ask (a fact it cannot
know is `FACT_UNKNOWN:<name>`, never a guess; the reflex file missing or not the pinned bytes, the cell refusing or
failing, or no answer within 1.5 s each have their own reason). The reflex file is read once per session from
`/cells/reflexes/touch-id-tier.json` and checked against the SHA-256 pinned in `nucleus-shadow.ts`
(`TOUCH_ID_TIER_REFLEX_SHA256`); `reflex` is its digest as the cell names it. A read that failed (`REFLEX_UNAVAILABLE`,
for example the network dropped) is tried again at the next consult; a file that arrived but is not the pinned reflex
(`REFLEX_DIGEST_MISMATCH`, `REFLEX_INVALID`) stays refused until the page reloads.

**It decides nothing.** The answer is never added to the bytes sent to the edge, never to anything signed, never to a
receipt. The edge's `classifyTransition` alone judges; a failed, slow or wrong consult leaves the promotion exactly as it
was. `nucleus-shadow.spec.ts` pins this: every promotion, run with the consult answering T1, an escalation, nothing, a
throw, a hang, a missing reflex and a changed reflex, sends the edge the same bytes and ends the same way as with the
consult removed.

**How to read the tally.** `x6_self_state` shows `nucleusShadow: { reflex, consulted, agree, mismatch, unknown,
lastMismatches }` for this session (it starts at zero each time the page loads). Each consulted promotion is then one of:
`agree` (the edge classified it the same: its tier and reasons, on `/_head/stage`; on a direct publish, only an answer of
`tier: "T1"` is comparable), `mismatch` (it did not), or `unknown` (no consult answer, or the edge's answer carried no
classification, for example a refusal). `lastMismatches` keeps the last 8: the seven facts by name, the nucleus outcome,
the edge outcome and the time; no organ contents and no ids. When the whole answer would pass 16 KiB, the oldest
`lastMismatches` are cut first (before any organ row) and one `unknown` row says `nucleusShadow.lastMismatches: too-many`;
the counts are never cut.

**A mismatch is a fact, not a verdict.** It blocks nothing and changes nothing. It means the shadow and the judge read the
same change differently: the facts were read wrong, the reflex is out of date, or the judge changed. Bring it to the lead
with the entry from `lastMismatches` (the facts, both outcomes, the time); do not change the reflex or the judge yourself.

## What `reflex.diff` proves, and what it does not

It proves, for the stated domain and nothing else, the complete list of cases where two reflexes decide differently,
and which of them stop escalating. It is "listed", not "sampled". It does not prove that the facts fed to a reflex are
true (the adapter from a real manifest to the seven tier facts lives outside the cell), that the reflex matches the code
it shadows (the spec `nucleus-cell.spec.ts` checks the tier reflex against the real `classifyTransition` on 20,000
generated pairs, not on every possible manifest), or that a change is wise. A diff too large for the fuel grant is a
refusal (`FUEL`), never a partial answer.

## Next steps

1. **The gate as a reflex:** the tier rule and the other listable gate decisions run as reflexes beside the code, and
   an approval card shows `reflex.diff` (every removed passkey first, alone).
2. **A receipt per cell call:** the request digest, the answer digest and the cell's pin, written to your receipts.
3. **The cell as a row of your capsule record:** `nucleus` and its pin listed as the first hard-walled deterministic
   organ in the capsule inventory.
