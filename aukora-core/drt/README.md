# Differential testing of the compiled cores

The laws are proved about the Lean text. What runs is a compiled file. Nothing proves the two behave the same, so
this folder tests it: several compiled cores are given the SAME inputs and compared after EVERY input, on the verdict
and on every value the files export (head, installed core, halt flag, threshold, evidence ceiling, record
identifier, law identity, journal, seal, stamp count). A disagreement anywhere is a fault in one of them.

The inputs are generated with structure, not just at random: real owner-signed frames of the kinds the test
library can build (approvals of both kinds, key changes of both kinds, controls, budgets, passes, thresholds,
claims, acts, halts, clears, seals and continuations), each built on the live head, then often mutated: a bit
flipped, cut short, extended, re-addressed to an older head, signed by a stranger, or replayed. Records are started
both the old way and bound. Every frame is also classified by the core's own form table (`tools/forms.mjs`), and
the run reports how many of the 38 forms were offered and how many were admitted at least once.

    node drt/drt.mjs --minutes 1 v0.10/aukora-core-lite.wasm v0.10/aukora-core.wasm
    node drt/drt.mjs --minutes 1 --old --ignore lawByte,journalByte,sealByte v0.10/aukora-core-lite.wasm v0.9/aukora-core-lite.wasm
    node drt/drt.mjs --steps 700 --control v0.10/aukora-core-lite.wasm v0.10/aukora-core-lite.wasm     # must FAIL

What each comparison shows:
- **small against full, same version**: the two compiled profiles of one law set agree on everything both do.
- **v0.10 against v0.9 on records started the old way** (law-carrying values ignored): the refusal wrapper of v0.10
  changes nothing when the refused list is empty, which is the law `empty_same`, observed on the bytes.
- **a refusal never changes an exported value**: checked on every refused input of every run.
- **law checks on the bytes**, on every input of every run: a frame naming an earlier head or position (re-addressed
  or replayed) is refused; no act or approval is admitted while the record is halted; and on v0.10 files, a bound
  record admits neither old command form. `--law-control` applies the last check to any core: on v0.9, which still
  has that defect, it must fail, and it does.
- **the control**: one executor's verdict is flipped on purpose; the run must report it and save the stream.

Every run prints its seed. A disagreement or a trap saves the exact input stream to `drt/corpus/`, and
`--replay FILE` runs it again. `--emit PREFIX` writes the inputs and the expected outputs as text, for executors
that are not WebAssembly (`drt/native/`).

What this is NOT: a proof. The compiled files share the Lean compiler's front end, so a fault there that made both
files wrong in the same way would not show here. The native twin in `drt/native/` removes part of that sharing (a
different C target, word size and runtime); see its README for what it covers.
