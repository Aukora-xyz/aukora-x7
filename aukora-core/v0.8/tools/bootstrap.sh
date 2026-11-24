#!/bin/sh
# Compile the vendored checker closure and WASI runtime in a disposable lab-local tree.
set -eu
cd "$(dirname "$0")/../.."
lab=$PWD
work="$lab/v0.8/.work"
stage="$work/logs/r6"
mkdir -p "$stage/tmp" "$work/tmp"
export TMPDIR="$work/tmp" CLANG_MODULE_CACHE_PATH="$work/tmp/ModuleCache" PYTHONDONTWRITEBYTECODE=1
mkdir -p "$work/spike/r3"
ln -sf "$lab/v0.8/tools/watch.py" "$work/spike/r3/watch.py"
for dir in r6 r4 runtime-r2; do
  [ -L "$work/spike/$dir" ] || ln -s "$lab/spike/$dir" "$work/spike/$dir"
done
[ -L "$work/toolchain" ] || ln -s "$lab/toolchain" "$work/toolchain"
[ -L "$stage/downloads" ] || ln -s "$lab/logs/r6/downloads" "$stage/downloads"
shasum -a 256 -c <<'PINS'
124c934950061e8312e494b62455407012afa90fdaf8c49396492bbec4c10319  logs/r6/downloads/lean4lean.tar.gz
cc864d6e653231cbe8874cbff5459845e293b2d17741b7ee473b970808242732  logs/r6/downloads/batteries.tar.gz
26afde96ddf0632c68732943f2b6a0d84c1cd0790292fd464c25054b3d877853  toolchain/downloads/lean4-v4.19.0-source.tar.gz
PINS
python3 "$lab/v0.8/tools/watch.py" /usr/bin/clang -dynamiclib -undefined dynamic_lookup \
  -I"$lab/toolchain/lean-4.19.0-darwin_aarch64/include" \
  "$lab/v0.8/tools/MemoryOption.c" -o "$work/MemoryOption.dylib"
cd "$work"
python3 spike/r3/watch.py python3 spike/r6/route1-sources.py
python3 -u spike/r6/bootstrap-route1.py
cd "$lab"
python3 v0.8/tools/checker-stage.py
cd "$work"
# The inherited archiver changes directory before invoking llvm-ar. Keep its
# objects and flags, but supervise the archiver just like the compiler.
export R12B_WATCH="$work/spike/r3/watch.py"
sed 's/"\$sdk\/bin\/llvm-ar"/python3 "$R12B_WATCH" "\$sdk\/bin\/llvm-ar"/' spike/r6/runtime.sh > "$work/runtime.sh"
sh "$work/runtime.sh"
