#!/bin/sh
# Compile the existing lab model into the R6 build tree.
set -eu
out="$PWD/logs/r6/bootstrap/lib"
export LEAN_PATH="$out" TMPDIR="$PWD/logs/r6/tmp"
mkdir -p "$out/core"
for module in Core Core2 Sha256 Events4 Wire4 Bound4 Sha512 Ed25519 Wire5 Bound5 Stateful5; do
  python3 spike/r3/watch.py toolchain/lean-4.19.0-darwin_aarch64/bin/lean -j1 -o "$out/core/$module.olean" -c "$out/core/$module.c" "core/$module.lean"
done
