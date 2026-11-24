#!/bin/sh
# Build the route 2 trusted substrate at the lab root, serially.
set -eu
sdk=toolchain/wasi-sdk-25.0-arm64-macos
src=toolchain/lean4-4.19.0/src
inc=toolchain/lean-4.19.0-darwin_aarch64/include
out=spike/runtime-r3
mkdir -p "$out/tmp"
export TMPDIR="$PWD/$out/tmp"
flags="-Os -DNDEBUG -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -ffunction-sections -fdata-sections"
incs="-I$out/include -Ispike/runtime-r2/include -I$inc -I$src"
set -x
set --
for unit in object utf8 alloc apply mpz mpn exception interrupt; do
  "$sdk/bin/clang++" -std=c++17 $flags $incs -c "$src/runtime/$unit.cpp" -o "$out/tmp/$unit.o"
  set -- "$@" "$out/tmp/$unit.o"
done
"$sdk/bin/llvm-ar" rcs "$out/tmp/route2.a" "$@"
"$sdk/bin/clang" $flags $incs -c "$out/shim.c" -o "$out/tmp/shim.o"
