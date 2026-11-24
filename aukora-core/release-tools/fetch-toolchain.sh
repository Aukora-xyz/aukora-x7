#!/bin/sh
# Download the two pinned toolchains for Apple-silicon macOS into DIR, then PRUNE them to exactly the pinned files.
# About 540 MB to download and about 1.8 GB unpacked; about 650 MB is left after pruning.
# Nothing here is trusted: build-tree.py checks every file against release-tools/TOOLCHAIN-darwin-arm64.sha256 and refuses
# a toolchain with a changed, missing OR EXTRA file. The upstream Lean archive holds several thousand files the build never
# reads; the pins name every kept file. Pruning removes the rest, so the toolchain that builds is exactly the pinned one.
# Usage: sh release-tools/fetch-toolchain.sh toolchain
set -eu
dir="${1:?usage: fetch-toolchain.sh DIR}"; pins="$(cd "$(dirname "$0")" && pwd)/TOOLCHAIN-darwin-arm64.sha256"
[ -f "$pins" ] || { echo "fetch-toolchain: pin file not found beside this script"; exit 1; }
archive_pins="$(dirname "$pins")/toolchain-archives.sha256"
archive_digest() {
    python3 - "$archive_pins" "$1" <<'PY'
import re, sys
from pathlib import Path
pins, archive = sys.argv[1:]
lines = Path(pins).read_text().splitlines() if Path(pins).is_file() else []
matches = [line[:64] for line in lines
           if re.fullmatch(r"[0-9a-f]{64}  " + re.escape(archive), line)]
if len(matches) != 1:
    raise SystemExit(f"fetch-toolchain: missing or ambiguous SHA-256 pin for {archive}; refusing to unpack")
print(matches[0])
PY
}
check_archive() {
    actual=$(shasum -a 256 "$1")
    actual=${actual%% *}
    [ "$actual" = "$2" ] || {
        echo "fetch-toolchain: SHA-256 mismatch for $1; refusing to unpack" >&2
        exit 1
    }
}
download() {
    curl -fsL --retry 3 -o "$1" "$2" || {
        echo "fetch-toolchain: download failed: $2" >&2
        exit 1
    }
}
lean_dir=lean-4.19.0-darwin_aarch64
wasi_dir=wasi-sdk-25.0-arm64-macos
layout=$(python3 - "$dir" "$lean_dir" "$wasi_dir" <<'PY'
import sys
from pathlib import Path

dest = Path.cwd() / sys.argv[1]
try:
    for part in (*reversed(dest.parents), dest):
        if part.is_symlink():
            raise SystemExit("fetch-toolchain: destination path contains a symlink")
    dest.mkdir(parents=True, exist_ok=True)
    # The repository ships toolchain/downloads/ (the pinned Lean source archive), so a real "downloads" folder is allowed.
    entries = [p for p in dest.iterdir() if p.name != "downloads"]
    downloads = dest / "downloads"
    if downloads.exists() and (downloads.is_symlink() or not downloads.is_dir()):
        raise SystemExit("fetch-toolchain: destination downloads entry must be a real directory")
    if not entries:
        print("empty")
    elif {p.name for p in entries} == set(sys.argv[2:]) and all(
        not p.is_symlink() and p.is_dir() for p in entries
    ):
        print("unpacked")
    else:
        raise SystemExit("fetch-toolchain: destination must be empty or contain only the two unpacked tool directories (and downloads/)")
except OSError:
    raise SystemExit("fetch-toolchain: destination must be a writable real directory")
PY
)
case $dir in /*) ;; *) dir=./$dir ;; esac
CDPATH= cd -P "$dir"
lean=https://github.com/leanprover/lean4/releases/download/v4.19.0/lean-4.19.0-darwin_aarch64.zip
wasi=https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-arm64-macos.tar.gz
lean_archive=${lean##*/}; wasi_archive=${wasi##*/}
trap 'rm -f "$lean_archive" "$wasi_archive"' EXIT
trap 'exit 1' HUP INT TERM
if [ "$layout" = empty ]; then
    # Require all needed pins before downloading, and verify both archives before unpacking either.
    lean_digest=$(archive_digest "$lean_archive")
    wasi_digest=$(archive_digest "$wasi_archive")
    download "$lean_archive" "$lean"
    check_archive "$lean_archive" "$lean_digest"
    download "$wasi_archive" "$wasi"
    check_archive "$wasi_archive" "$wasi_digest"
    python3 - "$lean_archive" "$wasi_archive" <<'PY'
import os, posixpath, subprocess, sys

def listing(*args):
    try:
        return subprocess.check_output(args, env={**os.environ, "LC_ALL": "C"}).splitlines()
    except subprocess.CalledProcessError:
        raise SystemExit(f"fetch-toolchain: could not list {args[-1]}")

def check_name(name):
    if name.startswith(b"/") or b".." in name.split(b"/"):
        raise SystemExit(f"fetch-toolchain: invalid archive member {os.fsdecode(name)!r}")

for name in listing("unzip", "-Z1", sys.argv[1]):
    check_name(name)

names = listing("tar", "-tzf", sys.argv[2])
details = listing("tar", "-tvzf", sys.argv[2])
if len(names) != len(details):
    raise SystemExit("fetch-toolchain: inconsistent tar listings")
links = {}
for name, detail in zip(names, details):
    kind = detail[:1]
    if kind not in (b"l", b"h"):
        continue
    marker = b" -> " if kind == b"l" else b" link to "
    _, found, target = detail.partition(b" " + name + marker)
    if not found or not target:
        raise SystemExit(f"fetch-toolchain: cannot read link target for {os.fsdecode(name)!r}")
    # Symlinks are relative to their parent; tar hardlinks are relative to the archive root.
    base = posixpath.dirname(name) if kind == b"l" else b""
    key = posixpath.normpath(name)
    if key in links:
        raise SystemExit(f"fetch-toolchain: repeated archive link {os.fsdecode(name)!r}")
    links[key] = (name, target, base)

# Follow listed links before interpreting a later ".." in the same target.
resolved = {}
def resolve_link(key, ancestors):
    if key in resolved:
        return resolved[key]
    name, target, base = links[key]
    if target.startswith(b"/") or key in ancestors:
        raise SystemExit(f"fetch-toolchain: invalid link {os.fsdecode(name)!r} to {os.fsdecode(target)!r}")
    path = b""
    for part in posixpath.join(base, target).split(b"/"):
        if part == b"..":
            if not path:
                raise SystemExit(f"fetch-toolchain: invalid link {os.fsdecode(name)!r} to {os.fsdecode(target)!r}")
            path = posixpath.dirname(path)
        elif part not in (b"", b"."):
            path = posixpath.join(path, part)
            if path in links:
                path = resolve_link(path, ancestors | {key})
    resolved[key] = path
    return path

for name in names:
    check_name(name)
    key = posixpath.normpath(name)
    if key in links:
        resolve_link(key, set())
PY
    unzip -q "$lean_archive"; rm "$lean_archive"
    tar -xzf "$wasi_archive"; rm "$wasi_archive"
fi
python3 - "$pins" "$wasi_dir" <<'PY'
import os, sys
from pathlib import Path
# Keep pinned files and links, and preserve all directories.
# The WASI SDK compiler finds libc++ by the empty include/c++/v1 directory.
# A pin line is 64 hex characters, then two spaces (a file) or " L " (a link), then the path.
keep = set()
for line in Path(sys.argv[1]).read_text().splitlines():
    if not line.strip(): continue
    keep.add(line[67:] if line[64:67] == " L " else line[66:])
tops = sorted({p.split("/", 1)[0] for p in keep})
for entry in Path(".").iterdir():
    if entry.is_symlink(): raise SystemExit(f"fetch-toolchain: top-level symlink: {entry}")
for top in tops:
    if not Path(top).is_dir(): raise SystemExit(f"fetch-toolchain: {top} is missing after unpacking")
removed = 0
for top in tops:
    for root, dirs, files in os.walk(top, topdown=False, followlinks=False):
        for name in files + [d for d in dirs if os.path.islink(os.path.join(root, d))]:
            p = os.path.join(root, name)
            if p not in keep: os.remove(p); removed += 1
missing = [p for p in sorted(keep) if not os.path.lexists(p)]
libcxx = Path(sys.argv[2]) / "share/wasi-sysroot/include/c++/v1"
if not libcxx.is_dir(): raise SystemExit(f"fetch-toolchain: missing directory {libcxx}")
print(f"pruned {removed} unpinned files; {len(keep)} pinned paths expected; {len(missing)} missing")
if missing: raise SystemExit("fetch-toolchain: pinned paths missing after unpacking, first: " + missing[0])
PY
ls -d "$lean_dir" "$wasi_dir"
