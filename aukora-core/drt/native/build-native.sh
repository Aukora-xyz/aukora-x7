#!/bin/sh
# Build the NATIVE twin of the small core from a kept build folder (a v0.10 build whose `.work` was not removed).
# It compiles the same `reachable.c` the WebAssembly link used and the same shim (`Interface.c`, RELEASE_LITE) for the
# host CPU, against Lean's own native runtime from the pinned Lean 4.19.0 toolchain.
# Usage: sh drt/native/build-native.sh <kept v0.10 folder> <toolchain folder> <output binary>
set -eu
rel="${1:?kept v0.10 folder}"; tc="${2:?toolchain folder}"; out="${3:?output binary}"
here="$(cd "$(dirname "$0")" && pwd)"; link="$rel/.work/link-lite"; lean="$tc/lean-4.19.0-darwin_aarch64"
[ -f "$link/reachable.c" ] && [ -f "$link/root-law.h" ] || { echo "no reachable.c / root-law.h in $link (was the work folder kept?)"; exit 2; }
cc="${CC:-clang}"
"$cc" -O1 -w -DRELEASE_LITE -I"$lean/include" -I"$link" -c "$link/reachable.c" -o "$out.reachable.o"
"$cc" -O1 -w -DRELEASE_LITE -I"$lean/include" -I"$link" -c "$rel/Interface.c" -o "$out.interface.o"
"$cc" -O1 -w -I"$lean/include" -c "$here/native_main.c" -o "$out.main.o"
"$cc" "$out.main.o" "$out.interface.o" "$out.reachable.o" -L"$lean/lib/lean" -lleanshared -Wl,-rpath,"$lean/lib/lean" -lc++ -o "$out"
rm -f "$out.reachable.o" "$out.interface.o" "$out.main.o"
echo "built $out"
