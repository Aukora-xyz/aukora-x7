#!/bin/sh
# Clean, serial reconstruction from bundled sources. Run ./rebuild.sh.
set -eu
cd "$(dirname "$0")"
mkdir -p logs
out=$(mktemp -d "$PWD/logs/r5-build.XXXXXX")
actual=unavailable
finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "FAIL SHA-256 $actual (work files: $out)" >&2
  fi
}
trap finish EXIT
sdk="$PWD/toolchain/wasi-sdk-25.0-arm64-macos"
lean="$PWD/toolchain/lean-4.19.0-darwin_aarch64"
vendor=spike/r5/vendor/lean-4.19.0-wasm-sources.tar.gz
vendor_sha=0bb1f9c424a464b266868468b5c09301877812d75c94c6cd87c70fe7550969b1
expected=d74a5e0170299d62e8349496b9c0e31b2a4091b51273ef8bf82204b39222350a
hash() { shasum -a 256 "$1" | cut -d' ' -f1; }
[ "$(hash "$vendor")" = "$vendor_sha" ]
mkdir -p "$out/core" "$out/upstream" "$out/runtime" "$out/tmp"
export TMPDIR="$out/tmp" LEAN_PATH="$out"
tar -xzf "$vendor" -C "$out/upstream"
src="$out/upstream/src"
watch() { python3 spike/r3/watch.py "$@"; }
set --
for module in Core Core2 Sha256 Events4 Wire4 Bound4 Sha512 Ed25519 Wire5 Bound5 Stateful5; do
  watch "$lean/bin/lean" -j1 -o "$out/core/$module.olean" -c "$out/core/$module.c" "core/$module.lean"
  set -- "$@" "$out/core/$module.c"
done
watch "$lean/bin/lean" -j1 core/Kira5.lean
watch "$lean/bin/lean" -j1 --run core/Crypto5Tests.lean
python3 spike/r5/reachable.py "$out/reachable.c" "$out/upstream/stage0/stdlib" "$@"
flags="-Os -DNDEBUG -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -ffunction-sections -fdata-sections"
set --
for unit in object utf8 alloc apply mpz mpn exception interrupt; do
  echo "C++ runtime $unit"
  "$sdk/bin/clang++" -std=c++17 $flags -Ispike/runtime-r2/include -I"$lean/include" -I"$src" -c "$src/runtime/$unit.cpp" -o "$out/runtime/$unit.o"
  set -- "$@" "$out/runtime/$unit.o"
done
"$sdk/bin/llvm-ar" rcs "$out/runtime/route2.a" "$@"
"$sdk/bin/clang" $flags -Ispike/runtime-r2/include -I"$lean/include" -c spike/r4/shim.c -o "$out/runtime/shim.o"
for file in "$out/reachable.c" spike/r5/interface.c; do
  obj=$(basename "$file" .c)
  "$sdk/bin/clang" -Os -DNDEBUG -Werror=int-conversion -ffunction-sections -fdata-sections -I"$out" -Ispike/runtime-r2/include -I"$lean/include" -c "$file" -o "$out/$obj.o"
done
"$sdk/bin/clang++" -nostartfiles -Wl,--no-entry,--threads=1,--gc-sections,--strip-all,--wrap=lean_internal_panic,--wrap=abort_message,--wrap=lean_task_get,--wrap=_ZNSt3__222__libcpp_verbose_abortEPKcz \
  -Wl,--export=init,--export=input,--export=step,--export=head,--export=core,--export=feed,--export=reset,--export=verify,-z,stack-size=1048576 \
  "$out/interface.o" "$out/reachable.o" "$out/runtime/shim.o" "$out/runtime/route2.a" -o "$out/linked.wasm"
python3 spike/r3/private-exports.py "$out/linked.wasm" "$out/Core5.wasm"
actual=$(hash "$out/Core5.wasm")
[ "$actual" = "$expected" ] || { echo "Expected $expected, built $actual" >&2; exit 1; }
watch node spike/r5/call.mjs "$out/Core5.wasm"
mv -f "$out/Core5.wasm" core/Core5.wasm
rm -rf "$out"
echo "PASS SHA-256 $actual ($(wc -c < core/Core5.wasm | tr -d ' ') bytes)"
