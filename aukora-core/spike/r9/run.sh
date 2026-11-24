#!/bin/sh
# Offline from the lab. Each compiler and test has its own watchdog.
set -eu
cd "$(dirname "$0")/../.."
if [ "${1-}" != --locked ]; then
    exec python3 spike/r9/serial.py sh spike/r9/run.sh --locked
fi
export PYTHONDONTWRITEBYTECODE=1
work="$PWD/logs/r9/build"
export TMPDIR="$work/tmp" CLANG_MODULE_CACHE_PATH="$work/tmp/ModuleCache"
rm -rf "$work"
mkdir -p "$TMPDIR"
trap 'rm -rf "$work"' EXIT
watch() { python3 spike/r3/watch.py "$@"; }
watch shasum -a 256 -c spike/r9/inputs.sha256
sh spike/r9/prepare.sh
sh spike/r9/module.sh Checker9 ModelSection9 Upgrade9 Policy9 Core9
python3 spike/r9/build-wasm.py
# Core9 is already linked before this run first compiles the new candidate or exports its declarations.
sh spike/r9/certificates.sh
watch python3 spike/r9/candidate.py
sh spike/r9/module.sh Goal9 Wire4Proofs Tag9 Laws9 Policy9Laws Policy9Replay Core9PolicyLaws OnlyGate9 GrantOrigin9
watch node spike/r9/gate.mjs
watch node spike/r9/policy.mjs
python3 spike/r9/regression.py
sh spike/r9/differential.sh
watch shasum -a 256 -c spike/r9/pins.sha256
wc -c core/Core9.wasm core/FixedGenesis9.wasm
echo 'PASS Round 9'
