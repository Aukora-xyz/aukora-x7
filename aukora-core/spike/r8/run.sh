#!/bin/sh
# Run from the lab, offline. Every compiler and test below is serial and timed separately.
set -eu
cd "$(dirname "$0")/../.."
export PYTHONDONTWRITEBYTECODE=1
work="$PWD/logs/r8/build"
export TMPDIR="$work/tmp" CLANG_MODULE_CACHE_PATH="$work/tmp/ModuleCache"
mkdir -p "$TMPDIR"
trap 'rm -r "$work"' EXIT
watch() { python3 spike/r3/watch.py "$@"; }
watch shasum -a 256 -c spike/r8/inputs.sha256
sh spike/r8/prepare.sh
sh spike/r8/module.sh Mldsa8 NativeVectors Risk8 Core8 RiskWire8 Stamp8 Floor8
sh spike/r8/build-native.sh
watch node spike/r8/vectors.mjs generate
watch "$work/native/vectors" "$work/vectors"
python3 spike/r8/build-wasm.py verify
watch node spike/r8/vectors.mjs wasm
mkdir -p "$work/recorded"
tar -xzf logs/r8/public-vectors.tar.gz -C "$work/recorded"
watch "$work/native/vectors" "$work/recorded"
watch node spike/r8/vectors.mjs wasm "$work/recorded"
python3 spike/r8/build-wasm.py core
watch node spike/r8/hybrid.mjs
watch node spike/r8/risk.mjs
watch node spike/r8/stamp.mjs
watch shasum -a 256 -c spike/r8/pins.sha256
wc -c core/Mldsa8.wasm core/Core8.wasm
echo 'PASS Round 8'
