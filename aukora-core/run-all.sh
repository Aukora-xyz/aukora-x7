#!/bin/sh
# Run the tests in this tree. Needs Node 24; the backup line also needs python3 and uses the system temporary folder
# (removed afterwards), and is skipped with a SKIP line if python3 is missing. No install, no network. Exit 0 only if every line passes.
cd "$(dirname "$0")" || exit 1; fail=0; skips=0; L=v0.10/aukora-core-lite.wasm
run() { label="$1"; shift; if text=$("$@" 2>&1); then echo "PASS  $label: $(printf '%s' "$text" | tail -1)"; else fail=1; echo "FAIL  $label: $(printf '%s' "$text" | tail -2 | tr '\n' ' ')"; fi; }
echo "== the release, v0.8 =="
run "adapter, 34 end-to-end checks" node standalone/test.mjs
run "sample record replays" node examples/read-record.mjs examples/sample-record.txt --expect-head "$(cat examples/sample-record.head)"
run "reader checks the expected head" node examples/read-record-test.mjs
run "re-addressing (old forms still admitted: the open defect)" node v0.8/tests/independent/readdress.mjs v0.8/aukora-core-lite.wasm
run "bound edges" node v0.8/tests/independent/bound-edges.mjs v0.8/aukora-core-lite.wasm
echo "== the next line, v0.10: a bound record refuses the two old forms =="
run "re-addressing, closed (56 checks)" node v0.10/tests/independent/readdress.mjs $L closed
run "the same on the full core" node v0.10/tests/independent/readdress.mjs v0.10/aukora-core.wasm closed
run "bound edges" node v0.10/tests/independent/bound-edges.mjs $L
run "v0.9 and v0.10 agree on an old-start record" node v0.10/tests/independent/twin-cores.mjs v0.9/aukora-core-lite.wasm $L
run "adapter for bound records" node standalone-next/bound-test.mjs $L c924c72aec0214b59f1f9405ac2c7467b86e2d96985540570ad1896db3c25d93 closed
run "bound sample: 4 old-form probes refused, the timed approval admitted (bare reader)" node examples/read-bound.mjs $L examples/bound-sample.json
echo "== the compiled files against each other (differential, generated inputs; see drt/README.md) =="
run "small and full v0.10, 2,000 generated inputs" node drt/drt.mjs --steps 2000 --seed 1 $L v0.10/aukora-core.wasm
run "v0.10 and v0.9 on old-start records, 2,000 inputs" node drt/drt.mjs --steps 2000 --seed 2 --old --ignore lawByte,journalByte,sealByte $L v0.9/aukora-core-lite.wasm
run "the model-checked stream: both v0.10 files give the outputs the interpreted Lean model gave, 1,025 inputs" node drt/drt.mjs --check drt/fixtures/model-checked-1 $L v0.10/aukora-core.wasm
if node drt/drt.mjs --check drt/fixtures/model-checked-1 v0.9/aukora-core-lite.wasm > /dev/null 2>&1; then fail=1; echo "FAIL  control: an older core reproduced the stream"; else echo "PASS  control: an older core does not reproduce the stream"; fi
if node drt/drt.mjs --steps 1500 --seed 8 --bound --law-control --save "${TMPDIR:-/tmp}/drt-law-control" v0.9/aukora-core-lite.wasm v0.9/aukora-core-lite.wasm > /dev/null 2>&1; then fail=1; echo "FAIL  control: the bound-record law check did not catch v0.9"; else echo "PASS  control: the bound-record law check catches v0.9, which still admits the old forms"; fi
if node drt/drt.mjs --steps 700 --seed 3 --control --save "${TMPDIR:-/tmp}/drt-control" $L $L > /dev/null 2>&1; then fail=1; echo "FAIL  control: a planted wrong verdict was NOT caught"; else echo "PASS  control: a planted wrong verdict is caught"; fi
echo "== the form table and the boundary check =="
run "the JavaScript form table matches the Lean text" node tools/forms-test.mjs
if node tools/forms-test.mjs --control > /dev/null 2>&1; then fail=1; echo "FAIL  control: a planted wrong form number was NOT caught"; else echo "PASS  control: a planted wrong form number is caught"; fi
echo "== an effect refused when the core says no (rehearsal, lab keys) =="
run "effect sink, bound record" env BAILIFF_CORE=$L node bailiff-rehearsal/test-bound.mjs closed
run "promotion judge" env BAILIFF_CORE=$L node bailiff-rehearsal/promotion-test.mjs
run "the core's own record of its verdicts" env BAILIFF_CORE=$L node bailiff-rehearsal/own-record-test.mjs
run "revertible effects: every write and every undo needs its own approval" env BAILIFF_CORE=$L node bailiff-rehearsal/revertible-test.mjs
if node bailiff-rehearsal/revertible-test.mjs --control > /dev/null 2>&1; then fail=1; echo "FAIL  control: a broken undo was NOT caught"; else echo "PASS  control: a broken undo is caught"; fi
echo "== lab pieces =="
if command -v python3 >/dev/null 2>&1; then run "backup only ever grew" node skunkworks/backup/test.mjs; else skips=$((skips+1)); echo "SKIP  backup only ever grew: needs python3"; fi
run "totals tree" node skunkworks/onion/onion-test.mjs
run "delegation receipts" node skunkworks/delegation-exhibit/test.mjs
run "Pentora machine: the compiled file against separate plain code" node skunkworks/proved/pentora-machine/check.mjs
if out=$(node skunkworks/proved/pentora-machine/check.mjs control 2>&1); then fail=1; echo "FAIL  control: a planted wrong Pentora verdict was NOT caught"; elif echo "$out" | grep -q "agreeing reports: verdict: got 0, wanted 1"; then echo "PASS  control: a planted wrong Pentora verdict is caught"; else fail=1; echo "FAIL  control: the Pentora control failed, but not on the planted wrong verdict"; fi
run "Pentora decision stamp: the compiled file's judge against values written separately" node skunkworks/proved/pentora-machine/stamp.mjs
if out=$(node skunkworks/proved/pentora-machine/stamp.mjs control 2>&1); then fail=1; echo "FAIL  control: a planted wrong stamp expectation was NOT caught"; elif echo "$out" | grep -q "private limit expected judge 1, got 0"; then echo "PASS  control: a planted wrong stamp expectation is caught"; else fail=1; echo "FAIL  control: the stamp control failed, but not on the planted wrong expectation"; fi
run "Pentora four-report rule: a JavaScript copy on generated reports, and the shipped judge on repaired packets" node skunkworks/proved/pentora-machine/degraded.mjs
if out=$(node skunkworks/proved/pentora-machine/degraded.mjs control 2>&1); then fail=1; echo "FAIL  control: a planted wrong four-report expectation was NOT caught"; elif echo "$out" | grep -q "planted control expected go4=false for all passes; got true"; then echo "PASS  control: a planted wrong four-report expectation is caught"; else fail=1; echo "FAIL  control: the four-report control failed, but not on the planted wrong expectation"; fi

if [ "$fail" != 0 ]; then echo "SOMETHING FAILED"; exit 1; elif [ "$skips" != 0 ]; then echo "PASS WITH SKIPS ($skips skipped)"; else echo "ALL PASS"; fi
