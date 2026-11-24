#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
work="$PWD/logs/r9/build"
export TMPDIR="$work/tmp" LEAN_PATH="$work/logs/r6/bootstrap/lib" PYTHONDONTWRITEBYTECODE=1
mkdir -p "$LEAN_PATH/core" "$TMPDIR"
for name do
  case "$name" in
    KernelCell) dir=spike/r6; rel=$name; source="$dir/$name.lean" ;;
    *) dir=.; rel=core/$name; source="$rel.lean" ;;
  esac
  python3 spike/r3/watch.py toolchain/lean-4.19.0-darwin_aarch64/bin/lean -j1 --root="$dir" \
    -o "$LEAN_PATH/$rel.olean" -c "$LEAN_PATH/$rel.c" "$source"
done
