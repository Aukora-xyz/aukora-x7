#!/bin/sh
# Kernel-check Rule.lean with Lean 4.19.0. OPTIONAL and heavier than check.sh: about 45 seconds and up to 3 GB of
# memory in the Lean kernel (measured on one laptop). It is not part of run-all.sh.
# From the repository root: LEAN=/path/to/lean-4.19.0/bin/lean sh skunkworks/proved/pentora-machine/check-rule.sh
set -eu
G="$(cd "$(dirname "$0")" && pwd)"; LEAN="${LEAN:?set LEAN to a Lean 4.19.0 binary}"
mkdir -p "$G/work"; cd "$G"
check_rule() {
    "$LEAN" -j1 --root="$G" -o work/Pentora.olean Pentora.lean || return $?
    LEAN_PATH="$G/work" "$LEAN" -j1 --root="$G" -o work/Rule.olean Rule.lean || return $?
    LEAN_PATH="$G/work" "$LEAN" -j1 AxiomsRule.lean || return $?
}
status=0
check_rule > check-rule.txt 2>&1 || status=$?
echo "exit $status" >> check-rule.txt
cat check-rule.txt
exit "$status"
