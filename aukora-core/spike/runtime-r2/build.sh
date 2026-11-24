#!/bin/sh
# From the lab root. Build precisely the upstream non-mimalloc leanrt object list.
set -eu
sdk=toolchain/wasi-sdk-25.0-arm64-macos
src=toolchain/lean4-4.19.0/src
inc=toolchain/lean-4.19.0-darwin_aarch64/include
out=spike/runtime-r2
files=$(sed -n '/^set(RUNTIME_OBJS /,/)/{s/^set(RUNTIME_OBJS //;s/)$//;p;}' "$src/runtime/CMakeLists.txt")
set -x
toolchain/lean-4.19.0-darwin_aarch64/bin/lean -j1 -c "$out/Bytes.c" spike/Bytes.lean
"$sdk/bin/clang" -flto-jobs=1 -Os -DNDEBUG -ffunction-sections -fdata-sections -I"$out/include" -I"$inc" -c "$out/Bytes.c" -o "$out/Bytes.o"
set --
for unit in $files; do
  obj="$out/${unit%.cpp}.o"
  mkdir -p "$(dirname "$obj")"
  "$sdk/bin/clang++" -flto-jobs=1 -Os -std=c++17 -DNDEBUG -ffunction-sections -fdata-sections -I"$out/include" -I"$inc" -I"$src" -c "$src/runtime/$unit" -o "$obj"
  set -- "$@" "$obj"
done
"$sdk/bin/llvm-ar" rcs "$out/libleanrt.a" "$@"
"$sdk/bin/clang++" -flto-jobs=1 -mexec-model=reactor -Wl,--gc-sections,--strip-all,--export=append_marker "$out/Bytes.o" "$out/libleanrt.a" -o "$out/Bytes.wasm"
