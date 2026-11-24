#!/bin/sh
# Run at the lab root. Try the release runtime first, then the same emitted scalar function.
set -eu
run=./toolchain/run.sh
lean=toolchain/lean-4.19.0-darwin_aarch64
sdk=toolchain/wasi-sdk-25.0-arm64-macos
src=toolchain/lean4-4.19.0/src
out=toolchain/tmp/runtime
build='python3 toolchain/priority.py'
"$run" "$build $lean/bin/lean -j1 -c spike/Add.c spike/Add.lean"

# Create the same configurable headers as the official templates, with optional allocators off.
"$run" "mkdir -p $out/include/lean && sed -e 's/@LEAN_MIMALLOC@//' -e 's/@LEAN_SMALL_ALLOCATOR@//' -e 's/@LEAN_LAZY_RC@//' -e 's/@LEAN_IS_STAGE0@/#define LEAN_IS_STAGE0 0/' $src/config.h.in > $out/include/lean/config.h"
"$run" "revision=\$($lean/bin/lean --githash) && sed \"s/@GIT_SHA1@/\$revision/\" $src/githash.h.in > $out/include/githash.h"
includes="-I$out/include -I$lean/include -I$src"
"$run" "$build $sdk/bin/clang -DNDEBUG -Os -ffunction-sections -fdata-sections $includes -c spike/Add.c -o spike/Add.o"

# The upstream CMake target lists its required translation units in RUNTIME_OBJS.
# Stop at the first target compiler error and preserve it in the transcript.
runtime_build() {
  sources=$(awk '/^set\(RUNTIME_OBJS /,/\)$/ {sub(/^set\(RUNTIME_OBJS /,""); sub(/\)$/,""); print}' "$src/runtime/CMakeLists.txt") || return 1
  objects=''
  for source in $sources; do
    obj="$out/$(basename "$source" .cpp).o"
    "$run" "$build $sdk/bin/clang++ -std=c++17 -DNDEBUG -Os -ffunction-sections -fdata-sections $includes -c $src/runtime/$source -o $obj" || return 1
    objects="$objects $obj"
  done
  "$run" "$build $sdk/bin/llvm-ar rcs $out/libleanrt.a $objects" || return 1
  "$run" "$build $sdk/bin/clang++ -nostartfiles -Wl,--threads=1,--no-entry,--gc-sections,--strip-all,--export=accept_length spike/Add.o $out/libleanrt.a -o spike/Add.wasm"
}
if ! runtime_build; then
  # Link the untouched emitted translation unit. Unreachable module init and boxed wrappers drop out.
  "$run" "$build $sdk/bin/wasm-ld --threads=1 --no-entry --gc-sections --strip-all --export=accept_length spike/Add.o -o spike/Add.wasm"
fi
"$run" 'wc -c spike/Add.wasm && node spike/call.mjs'
