#!/bin/sh
# From the lab root. Use only the bundled toolchains, one compiler at a time.
set -eux
out=spike/r3/build
sdk=toolchain/wasi-sdk-25.0-arm64-macos
lean=toolchain/lean-4.19.0-darwin_aarch64
rt=spike/runtime-r3/tmp
mkdir -p "$out/core" "$out/tmp"
export TMPDIR="$PWD/$out/tmp" LEAN_PATH="$PWD/$out"
if [ "${1:-}" != link-only ]; then
  for module in Core Sha256 Stateful; do
    python3 spike/r3/watch.py "$lean/bin/lean" -j1 -o "$out/core/$module.olean" -c "$out/core/$module.c" "core/$module.lean"
  done
  sh spike/runtime-r3/route2.sh
fi
python3 spike/r3/reachable.py "$out/reachable.c" "$out/core/Core.c" "$out/core/Sha256.c" "$out/core/Stateful.c"
for file in "$out/reachable.c" spike/r3/interface.c; do
  obj=$(basename "$file" .c)
  "$sdk/bin/clang" -Os -DNDEBUG -ffunction-sections -fdata-sections -Ispike/runtime-r2/include -I"$lean/include" -c "$file" -o "$out/$obj.o"
done
"$sdk/bin/clang++" -nostartfiles -Wl,--no-entry,--threads=1,--gc-sections,--strip-all,--wrap=lean_internal_panic,--wrap=abort_message,--wrap=lean_task_get \
  -Wl,--export=init,--export=input,--export=step,--export=head,-z,stack-size=1048576 "-Wl,-Map,$out/linked.map" \
  "$out/interface.o" "$out/reachable.o" "$rt/shim.o" "$rt/route2.a" -o "$out/linked.wasm"
python3 spike/r3/private-exports.py "$out/linked.wasm" "$out/Core3.wasm"
node spike/r3/call.mjs "$out/Core3.wasm"
mv "$out/Core3.wasm" core/Core3.wasm
wc -c core/Core3.wasm
shasum -a 256 core/Core3.wasm
