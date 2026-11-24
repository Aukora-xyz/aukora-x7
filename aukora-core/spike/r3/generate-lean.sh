#!/bin/sh
# Regenerate the Lean modules from the lab root, serially and under the time limit.
set -eu
build=spike/r3/build
mkdir -p "$build/core" "$build/tmp"
export LEAN_PATH="$PWD/$build" TMPDIR="$PWD/$build/tmp"
for name in Core Sha256 Stateful; do
    python3 spike/r3/watch.py toolchain/lean-4.19.0-darwin_aarch64/bin/lean -j1 \
        -o "$build/core/$name.olean" -c "$build/core/$name.c" "core/$name.lean"
done
