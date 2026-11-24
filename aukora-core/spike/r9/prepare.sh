#!/bin/sh
# Compile the checker dependencies and both prior and new core modules in a lab-local tree.
set -eu
cd "$(dirname "$0")/../.."
lab=$PWD
work="$lab/logs/r9/build"
stage="$work/logs/r6"
export TMPDIR="$work/tmp" PYTHONDONTWRITEBYTECODE=1
mkdir -p "$stage/tmp" "$TMPDIR"
for dir in spike toolchain; do
  [ -L "$work/$dir" ] || ln -s "$lab/$dir" "$work/$dir"
done
[ -L "$stage/downloads" ] || ln -s "$lab/logs/r6/downloads" "$stage/downloads"
shasum -a 256 -c <<'PINS'
124c934950061e8312e494b62455407012afa90fdaf8c49396492bbec4c10319  logs/r6/downloads/lean4lean.tar.gz
cc864d6e653231cbe8874cbff5459845e293b2d17741b7ee473b970808242732  logs/r6/downloads/batteries.tar.gz
26afde96ddf0632c68732943f2b6a0d84c1cd0790292fd464c25054b3d877853  toolchain/downloads/lean4-v4.19.0-source.tar.gz
PINS
(
 cd "$work"
 python3 spike/r3/watch.py python3 spike/r6/route1-sources.py
 python3 -u spike/r6/bootstrap-route1.py
 sh spike/r6/runtime.sh
)
sh spike/r9/module.sh Core Core2 Sha256 Events4 Wire4 Bound4 Sha512 Ed25519 Wire5 Bound5 Stateful5 KernelCell Upgrade6 Upgrade7 Hybrid7 Shake7 Mldsa8 Risk8 Core8 Kira5 Advice7 Laws7
