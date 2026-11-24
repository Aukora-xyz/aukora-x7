#!/bin/sh
# Reuse the serially rebuilt R7 runtime and upstream Init C sources.
set -eu
cd "$(dirname "$0")/../.."
work="$PWD/logs/r7/build"
out="$work/shake"
rt="$work/logs/r6/runtime"
mkdir -p "$out"
export TMPDIR="$work/tmp" PYTHONDONTWRITEBYTECODE=1
lean=toolchain/lean-4.19.0-darwin_aarch64
sdk=toolchain/wasi-sdk-25.0-arm64-macos/bin
watch() { python3 spike/r3/watch.py "$@"; }
watch "$lean/bin/lean" -j1 -o "$out/Shake7.olean" -c "$out/Shake7.c" core/Shake7.lean
watch python3 -B spike/r6/reachable.py "$out/reachable.c" "$work/logs/r6/upstream/stage0/stdlib" \
  --roots r7_shake256 --modules "$out/Shake7.c"
for file in "$out/reachable.c" spike/r7/shake-interface.c; do
  watch "$sdk/clang" -Os -DNDEBUG -ffunction-sections -fdata-sections -I"$out" \
    -Ispike/runtime-r2/include -I"$lean/include" -c "$file" -o "$out/$(basename "$file" .c).o"
done
watch "$sdk/clang++" -nostartfiles -Wl,--no-entry,--threads=1,--gc-sections,--strip-all,-z,stack-size=1048576 \
  -Wl,--wrap=lean_internal_panic,--wrap=abort_message,--wrap=lean_task_get,--wrap=_ZNSt3__222__libcpp_verbose_abortEPKcz \
  -Wl,--export=clear,--export=input,--export=shake,--export=output \
  "$out/reachable.o" "$out/shake-interface.o" "$rt/shim.o" "$rt/route2.a" -o "$out/linked.wasm"
watch python3 -B spike/r3/private-exports.py "$out/linked.wasm" core/Shake7.wasm
watch node spike/r7/shake.mjs
