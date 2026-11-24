#!/bin/sh
# Test only a primitive actually used by the pinned type checker, against R5's archive.
set -eu
out="$PWD/logs/r6"
sdk="$PWD/toolchain/wasi-sdk-25.0-arm64-macos"
export TMPDIR="$out/tmp"
tar -xzf logs/r5/r5-build.rhea4E.tar.gz -C "$out" r5-build.rhea4E/runtime/route2.a r5-build.rhea4E/runtime/shim.o
cat > "$out/instantiate-probe.c" <<'C'
#include <lean/lean.h>
extern lean_object *lean_expr_instantiate1(lean_object *, lean_object *);
lean_object *probe(lean_object *expr, lean_object *subst) {
    return lean_expr_instantiate1(expr, subst);
}
C
python3 spike/r3/watch.py "$sdk/bin/clang" -Os -Ispike/runtime-r2/include -Itoolchain/lean-4.19.0-darwin_aarch64/include -c "$out/instantiate-probe.c" -o "$out/instantiate-probe.o"
python3 spike/r3/watch.py "$sdk/bin/clang++" -nostartfiles -Wl,--no-entry,--threads=1,--gc-sections,--export=probe "$out/instantiate-probe.o" "$out/r5-build.rhea4E/runtime/shim.o" "$out/r5-build.rhea4E/runtime/route2.a" -o "$out/route1-probe.wasm"
