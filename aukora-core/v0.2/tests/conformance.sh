#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
export PYTHONDONTWRITEBYTECODE=1 TMPDIR="$PWD/v0.2/.work/tmp"
python3 v0.2/tools/read-vectors.py
for file in v0.2/vectors/*.bin.gz; do
  group=$(basename "$file" .bin.gz)
  python3 v0.2/tools/test-lean.py v0.2/tests/Replay11.lean "$group"
  python3 v0.2/tools/watch.py node v0.2/tests/replay11.mjs "$group"
done
