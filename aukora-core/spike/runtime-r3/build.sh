#!/bin/sh
# Invoke at the lab root. All compiler instances run serially.
set -eu
sdk=toolchain/wasi-sdk-25.0-arm64-macos
src=toolchain/lean4-4.19.0/src
inc=toolchain/lean-4.19.0-darwin_aarch64/include
out=spike/runtime-r3
mkdir -p "$out/tmp"
TMPDIR="$PWD/$out/tmp"
export TMPDIR
flags="-Os -DNDEBUG -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -ffunction-sections -fdata-sections"
set -x
if [ "${1:-}" = signals ]; then
  "$sdk/bin/clang++" -std=c++17 $flags -Ispike/runtime-r2/include -I"$inc" -I"$src" -c "$src/runtime/thread.cpp" -o "$out/tmp/thread.o"
  exit
fi
if [ "${1:-}" = emscripten ]; then
  "$sdk/bin/clang++" -std=c++17 $flags -DLEAN_EMSCRIPTEN -I"$out/include" -Ispike/runtime-r2/include -I"$inc" -I"$src" -c "$src/runtime/debug.cpp" -o "$out/tmp/debug-emscripten.o"
  exit
fi
units=$(sed -n '/^set(RUNTIME_OBJS /,/)/{s/^set(RUNTIME_OBJS //;s/)$//;p;}' "$src/runtime/CMakeLists.txt")
set --
for unit in $units; do
  source="$src/runtime/$unit"
  if [ "$unit" = stack_overflow.cpp ]; then source="$out/stack_overflow.cpp"; fi
  obj="$out/tmp/${unit%.cpp}.o"
  mkdir -p "$(dirname "$obj")"
  "$sdk/bin/clang++" -std=c++17 $flags -I"$out/include" -Ispike/runtime-r2/include -I"$inc" -I"$src" -c "$source" -o "$obj"
  set -- "$@" "$obj"
done
"$sdk/bin/llvm-ar" rcs "$out/tmp/libleanrt.a" "$@"
"$sdk/bin/clang" $flags -Ispike/runtime-r2/include -I"$inc" -c spike/runtime-r2/Bytes.c -o "$out/tmp/Bytes.o"
"$sdk/bin/clang++" -nostartfiles -Wl,--no-entry,--threads=1,--gc-sections,--strip-all,--export=append_marker "$out/tmp/Bytes.o" "$out/tmp/libleanrt.a" -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-process-clocks -lwasi-emulated-getpid -o "$out/tmp/Bytes.wasm"
