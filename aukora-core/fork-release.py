#!/usr/bin/env python3
"""Fork a pinned release, without modifying the source release."""
import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile

RELEASE = re.compile(r"v[0-9]+\.[0-9]+\Z")
ANCHOR = b'        run(driver, release / "tools/package.py")'
HOOK = b'        run(driver, release / "tools/env-split.py")'
PIN = re.compile(rb"([a-f0-9]{64} [ *])([^\r\n]+)(\r?\n)?\Z")


def files_at(directory):
    """Walk non-work files without following links or special files."""
    for root, dirs, files in os.walk(directory, followlinks=False):
        dirs[:] = [name for name in dirs if name != ".work"]
        for name in dirs:
            path = Path(root) / name
            if not stat.S_ISDIR(path.lstat().st_mode):
                raise ValueError(f"unsafe directory: {path.name}")
        for name in files:
            if name == ".work":
                continue
            path = Path(root) / name
            if not stat.S_ISREG(path.lstat().st_mode):
                raise ValueError(f"unsafe file: {path.name}")
            yield path


def digest(path):
    with path.open("rb") as source:
        result = hashlib.sha256()
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest().encode("ascii")


def repin(data, old, new):
    output, count = [], 0
    for line in data.splitlines(keepends=True):
        m = PIN.fullmatch(line)
        if m is None:
            raise ValueError("malformed PINS.sha256")
        prefix, path, end = m.groups()
        if path.startswith(old + b"/"):
            path = new + path[len(old):]
            count += 1
        output.append(prefix + path + (end or b""))
    return b"".join(output), count


def fork(root, source_name, target_name, report=print):
    if not RELEASE.fullmatch(source_name) or not RELEASE.fullmatch(target_name):
        raise ValueError("expected release names such as v0.4 and v0.5")
    source, target = root / source_name, root / target_name
    if source.is_symlink() or not source.is_dir():
        raise ValueError(f"source release missing or unsafe: {source_name}")
    if target.exists() or target.is_symlink():
        raise ValueError(f"target already exists: {target_name}")
    template = root / "release-tools" / "env-split.py"
    if template.is_symlink() or not template.is_file():
        raise ValueError("release-tools/env-split.py missing or unsafe")
    template_data = template.read_bytes()
    source_files = sorted(files_at(source), key=lambda p: os.fsencode(p.relative_to(source)))
    old, new = source_name.encode("ascii"), target_name.encode("ascii")
    target.mkdir()  # Exclusive: cleanup below never removes a pre-existing target.
    changes = []
    try:
        for path in source_files:
            rel = path.relative_to(source)
            out = target / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, out)
            if rel == Path("PINS.sha256"):
                data, count = repin(out.read_bytes(), old, new)
            elif (rel == Path("build.sh") or rel.parts[0] == "tools"
                  or (rel.parts[0] == "tests" and rel.suffix in {".lean", ".mjs"})):
                prior = out.read_bytes()
                data, count = prior.replace(old, new), prior.count(old)
            else:
                continue
            if count:
                out.write_bytes(data)
                changes.append((rel, count))

        driver = target / "tools" / "build.py"
        if not driver.is_file():
            raise ValueError("tools/build.py missing; package hook anchor required exactly once")
        driver_data = driver.read_bytes()
        driver_lines = driver_data.split(b"\n")
        anchors = [i for i, line in enumerate(driver_lines) if line.rstrip(b"\r") == ANCHOR]
        if len(anchors) != 1 or any(line.rstrip(b"\r") == HOOK for line in driver_lines):
            raise ValueError("package hook anchor must occur exactly once, with no existing hook")
        at = anchors[0]
        driver_lines.insert(at + 1, HOOK + (b"\r" if driver_lines[at].endswith(b"\r") else b""))
        driver.write_bytes(b"\n".join(driver_lines))
        with (target / "tools" / "env-split.py").open("xb") as tool:
            tool.write(template_data)

        manifest = []
        for path in sorted(files_at(target), key=lambda p: os.fsencode(p.relative_to(root))):
            rel = path.relative_to(target)
            if (rel == Path("SOURCE.sha256") or path.suffix == ".wasm"
                    or rel.parts[:2] == ("fixtures", "packages")):
                continue
            name = os.fsencode(path.relative_to(root).as_posix())
            if any(marker in name for marker in (b"\n", b"\r", b"\\")):
                raise ValueError("path cannot be written in the source manifest")
            manifest.append(digest(path) + b"  " + name + b"\n")
        (target / "SOURCE.sha256").write_bytes(b"".join(manifest))
    except BaseException:
        shutil.rmtree(target)
        raise
    for rel, count in changes:
        report(f"{target_name}/{rel.as_posix()}: {count}")
    report(f"TOTAL replacements: {sum(count for _, count in changes)}")


def selftest():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        source, target = root / "v0.4", root / "v0.5"
        token = b"v0.4"

        def put(path, data):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

        put(root / "release-tools/env-split.py", b"# report\n")
        samples = {
            "build.sh": token, "tools/nested/a.py": token * 2, "tests/a.lean": token,
            "tests/b.mjs": token, "tests/c.txt": token, "Record.lean": token,
            "core.wasm": b"\0" + token, "fixtures/packages/a.model": token,
            ".work/ignored": token, "PINS.sha256": b"0" * 64 + b"  v0.4/core.wasm\n",
            "SOURCE.sha256": b"original\n", "tools/build.py": ANCHOR + b"\n",
        }
        for name, data in samples.items():
            put(source / name, data)
        messages = []
        fork(root, "v0.4", "v0.5", messages.append)
        for name in ("build.sh", "tools/nested/a.py", "tests/a.lean", "tests/b.mjs", "PINS.sha256"):
            if (target / name).read_bytes() != samples[name].replace(token, b"v0.5"):
                raise ValueError(f"selftest replacement in {name}")
        for name in ("core.wasm", "fixtures/packages/a.model", "tests/c.txt", "Record.lean"):
            if (target / name).read_bytes() != samples[name]:
                raise ValueError(f"selftest unexpected byte change in {name}")
        if (target / ".work").exists() or messages[-1] != "TOTAL replacements: 6":
            raise ValueError("selftest exclusions or count")
        if (target / "tools/build.py").read_bytes() != ANCHOR + b"\n" + HOOK + b"\n":
            raise ValueError("selftest build hook")
        if (target / "tools/env-split.py").read_bytes() != b"# report\n":
            raise ValueError("selftest report tool copy")
        manifest = (target / "SOURCE.sha256").read_bytes().splitlines()
        listed = []
        for line in manifest:
            sha, path = line.split(b"  ", 1)
            if sha != digest(root / os.fsdecode(path)):
                raise ValueError("selftest wrong manifest hash")
            listed.append(path)
        required = {b"v0.5/tools/build.py", b"v0.5/tools/env-split.py"}
        excluded = {b"v0.5/.work/ignored", b"v0.5/core.wasm", b"v0.5/fixtures/packages/a.model",
                    b"v0.5/SOURCE.sha256"}
        if not required.issubset(listed) or excluded.intersection(listed) or listed != sorted(listed):
            raise ValueError("selftest manifest paths")
        for name, data in samples.items():
            if (source / name).read_bytes() != data:
                raise ValueError(f"selftest source changed: {name}")
        for src, dst in (("v0.4", "v0.5"), ("../bad", "v0.6"), ("v0.3", "v0.6")):
            try:
                fork(root, src, dst)
            except ValueError:
                pass
            else:
                raise ValueError(f"selftest accepted {src} to {dst}")
        for anchors in (b"# missing\n", (ANCHOR + b"\n") * 2):
            put(source / "tools/build.py", anchors)
            try:
                fork(root, "v0.4", "v0.6")
            except ValueError as error:
                if "anchor must occur exactly once" not in str(error) or (root / "v0.6").exists():
                    raise ValueError("selftest anchor failure did not clean target")
            else:
                raise ValueError("selftest accepted wrong anchor count")


def main(args):
    try:
        if args == ["--selftest"]:
            selftest()
            print("SELFTEST PASS")
        elif len(args) == 2:
            fork(Path(__file__).resolve().parent, args[0], args[1])
        else:
            raise ValueError("usage: fork-release.py v0.4 v0.5 | --selftest")
        return 0
    except (OSError, ValueError) as error:
        print("ERROR: " + " ".join(str(error).splitlines()), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
