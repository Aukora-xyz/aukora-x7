#!/bin/sh
# The Lean model under the interpreter against the WebAssembly small core, on fresh generated streams, until a deadline.
# Takes the lab's one-Lean-job lock for each stream only, and waits politely if another job holds it.
# Usage: sh drt/model/long-run-model.sh <until HHMM> <work folder> <built v0.10 .work folder> [inputs per stream] [start total] [start stream]
# While a file LEAN-JOB-WANTED.txt exists in the lab, no new stream is started (another seat is waiting for the lock).
set -u
cd "$(dirname "$0")/../.."
until="${1:?HHMM}"; work="${2:?work folder}"; built="${3:?.work folder}"; steps="${4:-3000}"; start_total="${5:-0}"; start_n="${6:-0}"
mkdir -p "$work"; log="$work/model-run.log"; L=v0.10/aukora-core-lite.wasm; total=$start_total; n=$start_n
lean="$PWD/toolchain/lean-4.19.0-darwin_aarch64/bin/lean"
echo "$(date '+%F %T') start: until $until, $steps inputs per stream" >> "$log"
while [ "$(date +%H%M)" -lt "$until" ] || [ "$(date +%H)" -gt 12 ]; do
  n=$((n + 1)); seed=$((5000 + n))
  node drt/drt.mjs --steps "$steps" --seed "$seed" --emit "$work/s" --save "$work/corpus" "$L" "$L" > "$work/s.drt" 2>&1 || { echo "$(date '+%F %T') stream $n: generator run failed: $(tail -2 "$work/s.drt" | tr '\n' ' ')" >> "$log"; exit 1; }
  k=$(wc -l < "$work/s.expected" | tr -d ' ')
  while [ -f LEAN-JOB-WANTED.txt ]; do sleep 30; done
  until ( set -o noclobber; echo "HOLDER=drt-model START=$(date '+%F %T') JOB=model run stream $n (about 5 min)" > LEAN-JOB-HOLDER.txt ) 2>/dev/null; do sleep 30; done
  LEAN_PATH="$built/logs/r6/bootstrap/lib" TMPDIR="$built/tmp" "$lean" --run drt/model/Driver.lean "$built/package/root.id" < "$work/s.in" > "$work/s.model" 2> "$work/s.err"; st=$?
  rm -f LEAN-JOB-HOLDER.txt
  if [ $st -eq 0 ] && cmp -s "$work/s.expected" "$work/s.model"; then total=$((total + k)); rm -f "$work/s.in" "$work/s.model" "$work/s.expected" "$work/s.err"
    echo "$(date '+%F %T') stream $n seed $seed ok: the interpreted Lean model = the WebAssembly small core on $total inputs" >> "$log"
  else echo "$(date '+%F %T') stream $n seed $seed MODEL DIFFERS (exit $st): $(cmp "$work/s.expected" "$work/s.model" 2>&1 | head -1); files kept" >> "$log"; exit 1; fi
  sleep 20   # leave a gap in which another seat can take the lock
done
echo "$(date '+%F %T') DONE: $n streams; the interpreted Lean model = the WebAssembly small core on $total inputs" >> "$log"
