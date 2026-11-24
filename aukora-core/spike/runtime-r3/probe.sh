#!/bin/sh
set -eux
sdk=toolchain/wasi-sdk-25.0-arm64-macos
inc=toolchain/lean-4.19.0-darwin_aarch64/include
out=spike/runtime-r3
export TMPDIR="$PWD/$out/tmp"
for src in "$out/marker.c" spike/runtime-r2/Bytes.c; do
  obj=$(basename "$src" .c)
  "$sdk/bin/clang" -Os -DNDEBUG -Ispike/runtime-r2/include -I"$inc" -ffunction-sections -fdata-sections -c "$src" -o "$out/tmp/$obj.o"
done
"$sdk/bin/clang++" -nostartfiles -Wl,--no-entry,--threads=1,--gc-sections,--strip-all,--export=round3_marker_probe,--wrap=lean_internal_panic,--wrap=abort_message,--export=__wasm_call_ctors -Wl,-Map,"$out/tmp/marker.map" "$out/tmp/marker.o" "$out/tmp/Bytes.o" "$out/tmp/shim.o" "$out/tmp/route2.a" -o "$out/tmp/marker.wasm"
node -e "const fs=require('fs');const m=new WebAssembly.Module(fs.readFileSync('spike/runtime-r3/tmp/marker.wasm')); console.log('imports',WebAssembly.Module.imports(m));console.log('append_marker byte',new WebAssembly.Instance(m,{}).exports.round3_marker_probe())"
