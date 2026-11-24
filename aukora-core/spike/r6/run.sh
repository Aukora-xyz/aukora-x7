#!/bin/sh
# Offline R6 reproduction from the recorded source archives. Run from any cwd.
set -eu
cd "$(dirname "$0")/../.."
mkdir -p logs/r6/tmp
export TMPDIR="$PWD/logs/r6/tmp" LEAN_PATH="$PWD/logs/r6/bootstrap/lib"
lean=toolchain/lean-4.19.0-darwin_aarch64/bin/lean
watch() { python3 spike/r3/watch.py "$@"; }
shasum -a 256 -c <<'PINS'
124c934950061e8312e494b62455407012afa90fdaf8c49396492bbec4c10319  logs/r6/downloads/lean4lean.tar.gz
cc864d6e653231cbe8874cbff5459845e293b2d17741b7ee473b970808242732  logs/r6/downloads/batteries.tar.gz
26afde96ddf0632c68732943f2b6a0d84c1cd0790292fd464c25054b3d877853  toolchain/downloads/lean4-v4.19.0-source.tar.gz
d74a5e0170299d62e8349496b9c0e31b2a4091b51273ef8bf82204b39222350a  core/Core5.wasm
PINS
watch "$lean" --version
python3 -B spike/r6/route1-sources.py
python3 -Bu spike/r6/bootstrap-route1.py
sh spike/r6/model-modules.sh
watch "$lean" -j1 spike/r6/ExportTerm.lean
watch "$lean" -j1 --root=spike/r6 -o "$LEAN_PATH/KernelCell.olean" -c logs/r6/KernelCell.c spike/r6/KernelCell.lean
watch "$lean" -j1 --run spike/r6/CheckPackage.lean
watch "$lean" -j1 -c logs/r6/Upgrade6.c core/Upgrade6.lean
sh spike/r6/runtime.sh
python3 -B spike/r6/build-cell.py kernel
watch node spike/r6/check.mjs
python3 -B spike/r6/build-cell.py core
watch node spike/r6/upgrade.mjs
wc -c core/Kernel6.wasm core/Core6.wasm
shasum -a 256 core/Kernel6.wasm core/Core6.wasm
