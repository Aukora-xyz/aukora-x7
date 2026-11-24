#!/bin/sh
# Rebuild the pinned checker dependencies offline in a disposable R7 directory.
set -eu
cd "$(dirname "$0")/../.."
root=$PWD
work="$root/logs/r7/build"
mkdir -p "$work/logs/r6/tmp" "$work/tmp"
for dir in spike toolchain core; do
  [ -L "$work/$dir" ] || ln -s "$root/$dir" "$work/$dir"
done
[ -L "$work/logs/r6/downloads" ] || ln -s "$root/logs/r6/downloads" "$work/logs/r6/downloads"
cd "$work"
export TMPDIR="$work/tmp" PYTHONDONTWRITEBYTECODE=1
shasum -a 256 -c <<'PINS'
124c934950061e8312e494b62455407012afa90fdaf8c49396492bbec4c10319  logs/r6/downloads/lean4lean.tar.gz
cc864d6e653231cbe8874cbff5459845e293b2d17741b7ee473b970808242732  logs/r6/downloads/batteries.tar.gz
26afde96ddf0632c68732943f2b6a0d84c1cd0790292fd464c25054b3d877853  toolchain/downloads/lean4-v4.19.0-source.tar.gz
92baf60040e4800c4dfd0040bbc32eff869ea865d6285b8f054776e940aed1f5  core/Core6.wasm
PINS
lean=toolchain/lean-4.19.0-darwin_aarch64/bin/lean
watch() { python3 spike/r3/watch.py "$@"; }
watch "$lean" --version
watch python3 spike/r6/route1-sources.py
python3 -u spike/r6/bootstrap-route1.py
export LEAN_PATH="$work/logs/r6/bootstrap/lib"
cd "$root"
mkdir -p "$LEAN_PATH/core"
for mod in Core Core2 Sha256 Events4 Wire4 Bound4 Sha512 Ed25519 Wire5 Bound5 Stateful5; do
  watch "$lean" -j1 -o "$LEAN_PATH/core/$mod.olean" -c "$LEAN_PATH/core/$mod.c" "core/$mod.lean"
done
watch "$lean" -j1 --root=spike/r6 -o "$LEAN_PATH/KernelCell.olean" -c "$work/KernelCell.c" spike/r6/KernelCell.lean
for mod in Upgrade6 Kira5; do
  watch "$lean" -j1 -o "$LEAN_PATH/core/$mod.olean" -c "$work/$mod.c" "core/$mod.lean"
done
cd "$work"
sh spike/r6/runtime.sh
