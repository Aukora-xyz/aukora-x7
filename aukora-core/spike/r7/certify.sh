#!/bin/sh
# Called after prepare.sh. All modules and temporary files stay in the lab.
set -eu
cd "$(dirname "$0")/../.."
root=$PWD
work="$root/logs/r7/build"
lean="$root/toolchain/lean-4.19.0-darwin_aarch64/bin/lean"
export LEAN_PATH="$work/logs/r6/bootstrap/lib" TMPDIR="$work/tmp" PYTHONDONTWRITEBYTECODE=1
watch() { python3 "$root/spike/r3/watch.py" "$@"; }
python3 spike/r7/fixed-owner.py
watch node spike/r7/advice.mjs
sh spike/r7/check-lean.sh Advice7 Laws7 Other7 Upgrade7
(cd "$work" && watch "$lean" -j1 --root="$root/spike/r6" -o "$LEAN_PATH/ExportTerm.olean" "$root/spike/r6/ExportTerm.lean")
cmp "$work/logs/r6/wrong_digest.proof.expr" logs/r6/wrong_digest.proof.expr
watch "$lean" -j1 spike/r7/ExportLaws.lean
watch "$lean" -j1 --run spike/r7/CheckPackage.lean
python3 spike/r7/build-cell.py kernel
watch node spike/r7/check.mjs
python3 spike/r7/build-cell.py core
watch node spike/r7/upgrade.mjs
