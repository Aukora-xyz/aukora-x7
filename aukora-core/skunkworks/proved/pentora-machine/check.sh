#!/bin/sh
# Kernel-check the Pentora machine's laws with Lean 4.19.0.
# From the repository root: LEAN=/path/to/lean-4.19.0/bin/lean sh skunkworks/proved/pentora-machine/check.sh
set -eu
G="$(cd "$(dirname "$0")" && pwd)"; LEAN="${LEAN:?set LEAN to a Lean 4.19.0 binary}"
mkdir -p "$G/work"; cd "$G"
check_lean() {
    "$LEAN" -j1 --root="$G" -o work/Pentora.olean Pentora.lean || return $?
    LEAN_PATH="$G/work" "$LEAN" -j1 --root="$G" -o work/Entry.olean Entry.lean || return $?
    LEAN_PATH="$G/work" "$LEAN" -j1 --root="$G" -o work/Twin.olean Twin.lean || return $?
    LEAN_PATH="$G/work" "$LEAN" -j1 --root="$G" -o work/Sharper.olean Sharper.lean || return $?
    LEAN_PATH="$G/work" "$LEAN" -j1 --root="$G" -o work/Stamp.olean Stamp.lean || return $?
        LEAN_PATH="$G/work" "$LEAN" -j1 --root="$G" -o work/StampBytes.olean StampBytes.lean || return $?
    LEAN_PATH="$G/work" "$LEAN" -j1 --root="$G" -o work/Degraded.olean Degraded.lean || return $?

    LEAN_PATH="$G/work" "$LEAN" -j1 Axioms.lean || return $?
    LEAN_PATH="$G/work" "$LEAN" -j1 AxiomsStamp.lean || return $?
        LEAN_PATH="$G/work" "$LEAN" -j1 AxiomsStampBytes.lean || return $?
    LEAN_PATH="$G/work" "$LEAN" -j1 AxiomsDegraded.lean || return $?

}
status=0
check_lean > check.txt 2>&1 || status=$?
echo "exit $status" >> check.txt
cat check.txt
exit "$status"
