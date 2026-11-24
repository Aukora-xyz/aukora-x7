#!/bin/sh
# Kernel-check the totals-tree laws. Waits up to eleven minutes for a gap in the lab's one-job lock; seconds of work.
set -eu
G="$(cd "$(dirname "$0")" && pwd)"; LAB="${LAB:?set LAB to a folder holding toolchain/lean-4.19.0-darwin_aarch64}"; LEAN="$LAB/toolchain/lean-4.19.0-darwin_aarch64/bin/lean"
n=0; until ( set -o noclobber; echo "HOLDER=${HOLDER:-build} START=$(date '+%F %T') JOB=totals tree laws (seconds)" > "$LAB/LEAN-JOB-HOLDER.txt" ) 2>/dev/null; do n=$((n+1)); [ $n -ge 110 ] && { echo "SLOT HELD:"; cat "$LAB/LEAN-JOB-HOLDER.txt"; exit 3; }; /bin/sleep 6; done
trap 'rm -f "$LAB/LEAN-JOB-HOLDER.txt"' EXIT
( python3 "$LAB/memwatch.py" 4096 60 >/dev/null 2>&1 & )
mkdir -p "$G/work"; cd "$G"
"$LEAN" -j1 --root="$G" -o "$G/work/Onion.olean" Onion.lean > check.txt 2>&1 && LEAN_PATH="$G/work" "$LEAN" -j1 Axioms.lean >> check.txt 2>&1; echo "exit $?" >> check.txt; cat check.txt
