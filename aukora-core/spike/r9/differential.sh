#!/bin/sh
# Run after Core9 modules, Wasm and public gate fixtures are available.
set -eu
cd "$(dirname "$0")/../.."
out="$PWD/logs/r9/build/differential"
export LEAN_PATH="$PWD/logs/r9/build/logs/r6/bootstrap/lib" TMPDIR="$PWD/logs/r9/build/tmp"
mkdir -p "$out"
for group in matrix length signed gate; do
  python3 spike/r3/watch.py \
    toolchain/lean-4.19.0-darwin_aarch64/bin/lean -j1 --run spike/r9/Differential.lean "$group" "$out"
done
python3 spike/r3/watch.py node spike/r9/replay-vectors.mjs "$out"
for group in matrix length signed gate; do
  cmp "$out/$group.tsv" "logs/r9/vectors/$group.tsv"
  gzip -dc "logs/r9/vectors/$group.bin.gz" | cmp - "$out/$group.bin"
done
