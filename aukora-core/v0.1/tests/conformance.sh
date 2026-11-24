#!/bin/sh
# Lab-local offline regeneration and exact comparison with distributed corpus.
set -eu
cd "$(dirname "$0")/../.."
out="$PWD/v0.1/.work/conformance"
gold="$PWD/v0.1/vectors"
export LEAN_PATH="$PWD/v0.1/.work/logs/r6/bootstrap/lib" TMPDIR="$PWD/v0.1/.work/tmp" PYTHONDONTWRITEBYTECODE=1
mkdir -p "$out" "$TMPDIR"
for group in matrix length history signed gate; do
  python3 v0.1/tools/test-lean.py v0.1/tests/Conformance.lean "$group" "$out"
done
python3 spike/r3/watch.py node v0.1/tests/replay.mjs "$out"
# Only the initial authoring pass records bytes. The normal release build always compares.
for group in matrix length history signed gate; do
  if [ "${1-}" = "--record" ]; then
    cp "$out/$group.tsv" "$gold/$group.tsv"
    gzip -nc "$out/$group.bin" > "$gold/$group.bin.gz"
  fi
  cmp "$out/$group.tsv" "$gold/$group.tsv"
  gzip -dc "$gold/$group.bin.gz" > "$out/reference.bin"
  cmp "$out/$group.bin" "$out/reference.bin"
done
rm -f "$out/reference.bin"
