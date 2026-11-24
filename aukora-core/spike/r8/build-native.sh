#!/bin/sh
# Native macOS executable from Lean's emitted C and the bundled matching host runtime.
set -eu
cd "$(dirname "$0")/../.."
work="$PWD/logs/r8/build"
lib="$work/logs/r6/bootstrap/lib"
lean="$PWD/toolchain/lean-4.19.0-darwin_aarch64"
out="$work/native"
mkdir -p "$out"
export TMPDIR="$work/tmp" CLANG_MODULE_CACHE_PATH="$work/tmp/ModuleCache" PYTHONDONTWRITEBYTECODE=1
watch() { python3 spike/r3/watch.py "$@"; }
for file in "$lib/Batteries/Tactic/OpenPrivate.c" "$lib/core/Shake7.c" "$lib/core/Mldsa8.c" "$lib/NativeVectors.c"; do
  watch cc -O2 -DNDEBUG -I"$lean/include" -c "$file" -o "$out/$(basename "$file" .c).o"
done
watch cc "$out/OpenPrivate.o" "$out/Shake7.o" "$out/Mldsa8.o" "$out/NativeVectors.o" -L"$lean/lib/lean" \
  "-Wl,-rpath,$lean/lib/lean" -lleanshared -o "$out/vectors"
