#!/bin/sh
# Recompile the R5 runtime subset and the additional expression/level primitives.
set -eu
out="$PWD/logs/r6/runtime"
src="$PWD/logs/r6/upstream/src"
sdk="$PWD/toolchain/wasi-sdk-25.0-arm64-macos"
inc="$PWD/toolchain/lean-4.19.0-darwin_aarch64/include"
export TMPDIR="$PWD/logs/r6/tmp"
mkdir -p "$out"
watch() { python3 spike/r3/watch.py "$@"; }
flags='-Os -DNDEBUG -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -ffunction-sections -fdata-sections'
printf '#define LEAN_GITHASH "6caaee842e9495688c1567e78c0e68dbb96942aa"\n' > "$out/githash.h"
archive() {
    dest="$1"
    shift
    objects=''
    for unit do
        object=$(basename "$unit").o
        watch "$sdk/bin/clang++" -std=c++17 $flags -Ispike/runtime-r2/include -I"$inc" -I"$out" -I"$src" -c "$src/$unit.cpp" -o "$out/$object"
        objects="$objects $object"
    done
    (cd "$out" && "$sdk/bin/llvm-ar" rcs "$dest" $objects)
}
archive route2.a runtime/object runtime/utf8 runtime/alloc runtime/apply runtime/mpz runtime/mpn runtime/exception runtime/interrupt
archive kernel-extra.a runtime/hash runtime/platform kernel/abstract kernel/expr kernel/expr_eq_fn kernel/for_each_fn kernel/instantiate kernel/level kernel/replace_fn util/kvmap util/name
watch "$sdk/bin/clang" $flags -Ispike/runtime-r2/include -I"$inc" -c spike/r4/shim.c -o "$out/shim.o"
