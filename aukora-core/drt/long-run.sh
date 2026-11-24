#!/bin/sh
# A long differential run, in chunks, until a deadline. Each chunk: generated inputs through the small and the full
# WebAssembly cores in lockstep, the same inputs replayed through the native twin and compared line by line; every
# third chunk also compares v0.10 with v0.9 on old-start records. Stops at the first disagreement and keeps its files.
# Usage: sh drt/long-run.sh <until HHMM> <work folder> <native binary> [steps per chunk]
set -u
cd "$(dirname "$0")/.."
until="${1:?HHMM}"; work="${2:?work folder}"; native="${3:?native binary}"; steps="${4:-4000}"
mkdir -p "$work"; log="$work/long-run.log"; L=v0.10/aukora-core-lite.wasm; F=v0.10/aukora-core.wasm
total=0; nat=0; old=0; chunk=0
echo "$(date '+%F %T') start: until $until, $steps inputs per chunk" >> "$log"
while [ "$(date +%H%M)" -lt "$until" ] || [ "$(date +%H)" -gt 12 ]; do
  chunk=$((chunk + 1)); seed=$((1000 + chunk))
  out=$(node drt/drt.mjs --steps "$steps" --seed "$seed" --emit "$work/c" --save "$work/corpus" "$L" "$F" 2>&1); st=$?
  n=$(printf '%s' "$out" | sed -n 's/.*: \([0-9]*\) inputs compared.*/\1/p' | head -1)
  if [ $st -ne 0 ]; then echo "$(date '+%F %T') chunk $chunk seed $seed WASM DISAGREEMENT: $(printf '%s' "$out" | tail -4 | tr '\n' ' ')" >> "$log"; exit 1; fi
  total=$((total + n))
  if "$native" < "$work/c.in" > "$work/c.got" 2> "$work/c.err" && cmp -s "$work/c.expected" "$work/c.got"; then nat=$((nat + n)); rm -f "$work/c.in" "$work/c.got" "$work/c.expected" "$work/c.err"
  else echo "$(date '+%F %T') chunk $chunk seed $seed NATIVE DIFFERS from WebAssembly: first differing line $(cmp "$work/c.expected" "$work/c.got" | head -1); files kept in $work" >> "$log"; exit 1; fi
  if [ $((chunk % 3)) -eq 0 ]; then
    o=$(node drt/drt.mjs --steps "$steps" --seed "$seed" --old --ignore lawByte,journalByte,sealByte --save "$work/corpus" "$L" v0.9/aukora-core-lite.wasm 2>&1); st=$?
    m=$(printf '%s' "$o" | sed -n 's/.*: \([0-9]*\) inputs compared.*/\1/p' | head -1)
    if [ $st -ne 0 ]; then echo "$(date '+%F %T') chunk $chunk seed $seed v0.9/v0.10 DISAGREEMENT: $(printf '%s' "$o" | tail -4 | tr '\n' ' ')" >> "$log"; exit 1; fi
    old=$((old + m))
  fi
  forms=$(printf '%s' "$out" | grep -o 'admitted at least once [0-9]* of 38' | head -1)
  echo "$(date '+%F %T') chunk $chunk seed $seed ok: small=full on $total inputs, native=wasm on $nat, v0.9=v0.10 old-start on $old; $forms" >> "$log"
done
echo "$(date '+%F %T') DONE: $chunk chunks; small=full on $total inputs; native=wasm on $nat; v0.9=v0.10 (old start) on $old; 0 disagreements" >> "$log"
