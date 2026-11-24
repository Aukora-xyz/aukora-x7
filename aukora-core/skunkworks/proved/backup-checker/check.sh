#!/bin/sh
# Kernel-check the sketch. Takes the lab's one-job lock for a few seconds; exits 3 if the slot is held.
set -eu
G="$(cd "$(dirname "$0")" && pwd)"; LAB="${LAB:?set LAB to a folder holding toolchain/lean-4.19.0-darwin_aarch64}"
( set -o noclobber; echo "HOLDER=${HOLDER:-build} START=$(date '+%F %T') JOB=backup checker law (seconds)" > "$LAB/LEAN-JOB-HOLDER.txt" ) 2>/dev/null || { echo "SLOT HELD:"; cat "$LAB/LEAN-JOB-HOLDER.txt"; exit 3; }
trap 'rm -f "$LAB/LEAN-JOB-HOLDER.txt"' EXIT
( python3 "$LAB/memwatch.py" 4096 60 >/dev/null 2>&1 & )
"$LAB/toolchain/lean-4.19.0-darwin_aarch64/bin/lean" -j1 "$G/Chain.lean" > "$G/check.txt" 2>&1; echo "exit $?" >> "$G/check.txt"; cat "$G/check.txt"
