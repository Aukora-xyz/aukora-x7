#!/bin/sh
# Compile the actual checker and attempt the cross-link. Requires bootstrap-route1.py first.
set -eu
out="$PWD/logs/r6"
sdk="$PWD/toolchain/wasi-sdk-25.0-arm64-macos"
inc="$PWD/toolchain/lean-4.19.0-darwin_aarch64/include"
export TMPDIR="$out/tmp"
watch() { python3 spike/r3/watch.py "$@"; }
flags="-Os -DNDEBUG -ffunction-sections -fdata-sections -Ispike/runtime-r2/include"
roots="l_Lean4Lean_TypeChecker_check l_Lean4Lean_TypeChecker_isDefEq"
runtime="$out/r5-build.rhea4E/runtime"
link() {
  watch "$sdk/bin/clang++" -nostartfiles -Wl,--no-entry,--threads=1,--gc-sections,--strip-all,--error-limit=0 \
    -Wl,--wrap=lean_internal_panic,--wrap=abort_message,--wrap=lean_task_get,--wrap=_ZNSt3__222__libcpp_verbose_abortEPKcz \
    -Wl,--export=l_Lean4Lean_TypeChecker_check,--export=l_Lean4Lean_TypeChecker_isDefEq \
    "$@" "$runtime/shim.o" "$runtime/route2.a" -o "$out/route1.wasm"
}
case "$1" in
  direct)
    watch "$sdk/bin/clang" $flags -I"$inc" -c "$out/bootstrap/lib/Lean4Lean/TypeChecker.c" -o "$out/TypeChecker.o"
    link "$out/TypeChecker.o" ;;
  closure)
    mkdir -p "$out/route1-slice"
    # Expand the complete C closure beyond R5's Init-only selector.
    set -- $(find "$out/bootstrap/lib" -name '*.c' | LC_ALL=C sort)
    watch python3 spike/r6/reachable.py "$out/route1-slice/checker.c" "$out/upstream/stage0/stdlib" --roots $roots --modules "$@"
    watch "$sdk/bin/clang" $flags -I"$inc" -Werror=int-conversion -c "$out/route1-slice/checker.c" -o "$out/route1-slice/checker.o"
    link "$out/route1-slice/checker.o" -Wl,--export=r6_constants ;;
  cpp)
    watch "$sdk/bin/clang++" -std=c++17 $flags -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -I"$inc" -I"$out/upstream/src" -c "$out/upstream/src/kernel/instantiate.cpp" -o "$out/instantiate.o"
    watch "$sdk/bin/clang++" -nostartfiles -Wl,--no-entry,--threads=1,--gc-sections,--export=probe,--error-limit=0 \
      "$out/instantiate-probe.o" "$out/instantiate.o" "$runtime/shim.o" "$runtime/route2.a" -o "$out/instantiate.wasm" ;;
esac
