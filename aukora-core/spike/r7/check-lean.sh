#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
build="$PWD/logs/r7/build"
export LEAN_PATH="$build/logs/r6/bootstrap/lib" TMPDIR="$build/tmp" PYTHONDONTWRITEBYTECODE=1
lean=toolchain/lean-4.19.0-darwin_aarch64/bin/lean
for name do
  python3 spike/r3/watch.py "$lean" -j1 -o "$LEAN_PATH/core/$name.olean" -c "$build/$name.c" "core/$name.lean"
done
