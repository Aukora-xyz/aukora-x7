#!/bin/sh
# Test the upstream C++ primitives required by the checker. Serial, lab-local.
set -eu
out="$PWD/logs/r6"
src="$out/upstream/src"
objects="$out/kernel-objects"
sdk="$PWD/toolchain/wasi-sdk-25.0-arm64-macos"
inc="$PWD/toolchain/lean-4.19.0-darwin_aarch64/include"
export TMPDIR="$out/tmp"
mkdir -p "$objects"
watch() { python3 spike/r3/watch.py "$@"; }
printf '#define LEAN_GITHASH "6caaee842e9495688c1567e78c0e68dbb96942aa"\n' > "$objects/githash.h"
for unit in "$@"; do
  obj="$objects/$(basename "$unit").o"
  watch "$sdk/bin/clang++" -std=c++17 -Os -DNDEBUG -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN \
    -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -ffunction-sections -fdata-sections \
    -Ispike/runtime-r2/include -I"$inc" -I"$objects" -I"$src" -c "$src/$unit.cpp" -o "$obj"
done
watch "$sdk/bin/llvm-ar" rcs "$out/kernel-extra.a" "$objects"/*.o
