#!/bin/sh
# Compile with the same R9 lab-local LEAN_PATH as the kernel and core modules.
set -eu
cd "$(dirname "$0")/../.."
root=$PWD
work="$root/logs/r9/build"
export LEAN_PATH="$work/logs/r6/bootstrap/lib" TMPDIR="$work/tmp" PYTHONDONTWRITEBYTECODE=1
lean="$root/toolchain/lean-4.19.0-darwin_aarch64/bin/lean"
watch() { python3 "$root/spike/r3/watch.py" "$@"; }
sh spike/r9/module.sh Checker9 Candidate9
# ExportTerm's import-time R6 fixture write belongs in the disposable build tree.
(cd "$work" && watch "$lean" -j1 --root="$root/spike/r6" -o "$LEAN_PATH/ExportTerm.olean" "$root/spike/r6/ExportTerm.lean")
watch "$lean" -j1 spike/r9/ExportCandidate.lean
watch "$lean" -j1 --run spike/r9/CheckCandidate.lean
