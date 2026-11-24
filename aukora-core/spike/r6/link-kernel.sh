#!/bin/sh
set -eu
out="$PWD/logs/r6"
sdk="$PWD/toolchain/wasi-sdk-25.0-arm64-macos"
runtime="$out/r5-build.rhea4E/runtime"
export TMPDIR="$out/tmp"
python3 spike/r3/watch.py "$sdk/bin/clang++" -nostartfiles -Wl,--no-entry,--threads=1,--gc-sections,--strip-all,--error-limit=0 \
 -Wl,--wrap=lean_internal_panic,--wrap=abort_message,--wrap=lean_task_get,--wrap=_ZNSt3__222__libcpp_verbose_abortEPKcz \
 "$out/route1-slice/checker.o" "$@" "$out/kernel-extra.a" "$runtime/shim.o" "$runtime/route2.a" -o "$out/route1-link.wasm"
