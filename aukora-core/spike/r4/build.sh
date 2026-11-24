#!/bin/sh
# Run from the lab root. All temporaries and generated objects stay in the lab.
set -eux
mode=${1:-build}
out=spike/r4/build
if [ "$mode" = repro ]; then out=spike/r4/build-repro; fi
sdk=toolchain/wasi-sdk-25.0-arm64-macos
lean=toolchain/lean-4.19.0-darwin_aarch64
rt="$out/runtime"
src=toolchain/lean4-4.19.0/src
mkdir -p "$out/core" "$out/tmp" "$rt"
export TMPDIR="$PWD/$out/tmp" LEAN_PATH="$PWD/$out"
set --
for module in Core Core2 Sha256 Events4 Wire4 Bound4 Stateful4; do
  python3 spike/r3/watch.py "$lean/bin/lean" -j1 -o "$out/core/$module.olean" -c "$out/core/$module.c" "core/$module.lean"
  set -- "$@" "$out/core/$module.c"
done
# These audit modules have no executable entry point. Check them against the
# freshly generated oleans without adding proof-only declarations to the link.
for module in Events4Audit Wire4Proofs Upgrade4Witness; do
  python3 spike/r3/watch.py "$lean/bin/lean" -j1 "core/$module.lean"
done
python3 spike/r4/reachable.py "$out/reachable.c" "$@"
# Rebuild the round-3 runtime subset into this round's own directory.
flags="-Os -DNDEBUG -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -ffunction-sections -fdata-sections"
incs="-Ispike/runtime-r3/include -Ispike/runtime-r2/include -I$lean/include -I$src"
set --
for unit in object utf8 alloc apply mpz mpn exception interrupt; do
  "$sdk/bin/clang++" -std=c++17 $flags $incs -c "$src/runtime/$unit.cpp" -o "$rt/$unit.o"
  set -- "$@" "$rt/$unit.o"
done
"$sdk/bin/llvm-ar" rcs "$rt/route2.a" "$@"
"$sdk/bin/clang" $flags $incs -c spike/r4/shim.c -o "$rt/shim.o"
for file in "$out/reachable.c" spike/r4/interface.c; do
  obj=$(basename "$file" .c)
  "$sdk/bin/clang" -Os -DNDEBUG -ffunction-sections -fdata-sections -I"$out" -Ispike/runtime-r2/include -I"$lean/include" -c "$file" -o "$out/$obj.o"
done
"$sdk/bin/clang++" -nostartfiles -Wl,--no-entry,--threads=1,--gc-sections,--strip-all,--wrap=lean_internal_panic,--wrap=abort_message,--wrap=lean_task_get,--wrap=_ZNSt3__222__libcpp_verbose_abortEPKcz \
  -Wl,--export=init,--export=input,--export=step,--export=head,--export=core,--export=feed,--export=reset,-z,stack-size=1048576 "-Wl,-Map,$out/linked.map" \
  "$out/interface.o" "$out/reachable.o" "$rt/shim.o" "$rt/route2.a" -o "$out/linked.wasm"
python3 spike/r3/private-exports.py "$out/linked.wasm" "$out/Core4.wasm"
node spike/r4/call.mjs "$out/Core4.wasm"
if [ "$mode" = repro ]; then
  cmp "$out/Core4.wasm" core/Core4.wasm
else
  mv "$out/Core4.wasm" core/Core4.wasm
fi
wc -c core/Core4.wasm
shasum -a 256 core/Core4.wasm
