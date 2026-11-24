"""Stage an isolated Aukora Core build tree using verified local inputs."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import shlex
import shutil
import stat
import tempfile

PIN_DIR = Path(__file__).resolve().parent
TOOL_DIRS = ("lean-4.19.0-darwin_aarch64", "wasi-sdk-25.0-arm64-macos")
LAB_DIRS = ("spike/r6", "spike/r4", "spike/runtime-r2")
LAB_FILES = (
    "logs/r6/downloads/lean4lean.tar.gz",
    "logs/r6/downloads/batteries.tar.gz",
    "toolchain/downloads/lean4-v4.19.0-source.tar.gz",
    "spike/r3/private-exports.py",
    "spike/r9/core-roots.txt",
    "spike/r9/core-exports.txt",
    "spike/runtime-r3/shim.c",
    "logs/r9/honest.model",
    "logs/r9/honest.proof.expr",
    "core/FixedGenesis9.wasm",
    "v0.1/fixtures/signed/keys.bin",
    "v0.1/fixtures/install/keys.bin",
    "v0.1/fixtures/fixed-genesis.wasm",
    *(f"v0.1/vectors/{name}.{ext}"
      for name in ("matrix", "length", "history", "signed", "gate")
      for ext in ("bin.gz", "tsv")),
)


class Refusal(ValueError):
    pass


def path_key(path):
    return os.fsencode(path.as_posix())


def mode(path):
    bits = path.lstat().st_mode
    if not (stat.S_ISDIR(bits) or stat.S_ISREG(bits)):
        raise Refusal(f"link or special file: {path}")
    return bits


def tree_root(path):
    path = path.absolute()
    for part in (*reversed(path.parents), path):
        if not stat.S_ISDIR(mode(part)):
            raise Refusal(f"expected a directory: {part}")
    return path.resolve(strict=True)


def path_under(root, rel):
    path = root
    for i, part in enumerate(Path(rel).parts):
        path = path / part
        if i < len(Path(rel).parts) - 1 and not stat.S_ISDIR(mode(path)):
            raise Refusal(f"expected a directory: {path}")
    return path


def entries(root, rel=Path(), *, skip_work=False):
    current = root / rel
    for path in sorted(current.iterdir(), key=path_key):
        child = rel / path.name
        bits = mode(path)
        if skip_work and child == Path(".work"):
            continue
        yield child, bits
        if stat.S_ISDIR(bits):
            yield from entries(root, child)


def sum_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def encode_manifest(items, links=()):
    lines = []
    for rel, sha in sorted(items.items(), key=lambda pair: path_key(pair[0])):
        name = path_key(rel)
        if any(byte in name for byte in (b"\n", b"\r", b"\\")):
            raise Refusal(f"unsupported manifest path: {rel!r}")
        marker = b" L " if rel in links else b"  "
        lines.append(sha.encode("ascii") + marker + name + b"\n")
    return b"".join(lines)


def file_hashes(root):
    return {rel: sum_file(root / rel) for rel, bits in entries(root)
            if stat.S_ISREG(bits)}


def pins_path(directory, host=None):
    system, machine = host or (platform.system(), platform.machine())
    return directory / f"TOOLCHAIN-{system.lower()}-{machine.lower()}.sha256"


def link_pin(root, path):
    # Pin raw link target text, but permit only existing, bounded relative targets.
    raw = os.readlink(path)
    target = Path(raw)
    if target.is_absolute():
        raise Refusal(f"absolute tool link: {path}")
    if raw.endswith("/") and not (path.parent / target).is_dir():
        raise Refusal(f"tool link needs a directory target: {path}")
    current = path.parent
    for part in target.parts:
        candidate = current.parent if part == ".." else current / part
        if not candidate.is_relative_to(root):
            raise Refusal(f"tool link leaves its tool folder: {path}")
        try:
            current = candidate.resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise Refusal(f"unresolved tool link: {path}") from exc
        if not current.is_relative_to(root):
            raise Refusal(f"tool link leaves its tool folder: {path}")
    mode(current)
    return hashlib.sha256(b"link\0" + os.fsencode(raw)).hexdigest()


def tool_manifest(toolchain):
    hashes, links = {}, set()
    for name in TOOL_DIRS:
        root = tree_root(toolchain / name)
        regular = 0
        pending = [root]
        while pending:
            for path in pending.pop().iterdir():
                rel = Path(name) / path.relative_to(root)
                bits = path.lstat().st_mode
                if stat.S_ISDIR(bits):
                    pending.append(path)
                elif stat.S_ISREG(bits):
                    hashes[rel] = sum_file(path)
                    regular += 1
                elif stat.S_ISLNK(bits):
                    hashes[rel] = link_pin(root, path)
                    links.add(rel)
                else:
                    raise Refusal(f"special tool input: {path}")
        if not regular:
            raise Refusal(f"empty tool directory: {root}")
    return encode_manifest(hashes, links)


def write_pins(toolchain, pin_file):
    manifest = tool_manifest(tree_root(toolchain))
    if pin_file.is_symlink():
        raise Refusal(f"pins path is a link: {pin_file}")
    with tempfile.NamedTemporaryFile(dir=pin_file.parent, delete=False) as stream:
        temp = Path(stream.name)
        try:
            stream.write(manifest)
            stream.flush()
            stream.close()
            os.replace(temp, pin_file)
        finally:
            temp.unlink(missing_ok=True)
    return manifest


def verify_toolchain(toolchain, pin_file):
    if not pin_file.exists():
        raise Refusal(f"missing platform pins: {pin_file}")
    if not stat.S_ISREG(mode(pin_file)):
        raise Refusal(f"expected a pins file: {pin_file}")
    if tool_manifest(toolchain) != pin_file.read_bytes():
        raise Refusal(f"changed, missing or extra tool file: {pin_file}")


def copy_regular(source, dest):
    if not stat.S_ISREG(mode(source)):
        raise Refusal(f"expected a regular file: {source}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as inp, dest.open("xb") as out:
        shutil.copyfileobj(inp, out)
    dest.chmod(stat.S_IMODE(source.stat().st_mode) & 0o777)


def copy_tree(source, dest, *, skip_work=False):
    if not stat.S_ISDIR(mode(source)):
        raise Refusal(f"expected a directory: {source}")
    dest.mkdir(parents=True, exist_ok=False)
    for rel, bits in entries(source, skip_work=skip_work):
        if stat.S_ISDIR(bits):
            (dest / rel).mkdir()
        else:
            copy_regular(source / rel, dest / rel)


def stage(release, out, toolchain, pin_file):
    release = tree_root(release)
    lab = release.parent
    out = out.absolute()
    out = tree_root(out.parent) / out.name
    if out.exists() or out.is_symlink():
        raise Refusal(f"output already exists: {out}")
    toolchain = tree_root(toolchain)
    if any(out.is_relative_to(p) for p in (release, toolchain, *(lab / s for s in LAB_DIRS))):
        raise Refusal("output overlaps an input tree")
    verify_toolchain(toolchain, pin_file)
    out.mkdir(exist_ok=False)
    try:
        copy_tree(release, out / release.name, skip_work=True)
        hashes = {}
        for name in LAB_DIRS:
            copy_tree(path_under(lab, name), out / name)
            hashes.update((Path(name) / rel, digest)
                          for rel, digest in file_hashes(out / name).items())
        for name in LAB_FILES:
            copy_regular(path_under(lab, name), out / name)
            hashes[Path(name)] = sum_file(out / name)
        manifest = encode_manifest(hashes)
        (out / "INPUTS.sha256").write_bytes(manifest)
        for name in TOOL_DIRS:
            (out / "toolchain" / name).symlink_to(toolchain / name, target_is_directory=True)
        return len(hashes), hashlib.sha256(manifest).hexdigest()
    except BaseException:
        shutil.rmtree(out)
        raise


def selftest():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()
        lab = root / "lab"
        release = lab / "v0.5"
        out = root / "staged"
        tools = lab / "toolchain"
        pin_file = pins_path(root)

        def put(path, data=b"fixture\n"):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

        put(release / "build.sh", b"#!/bin/sh\nexit 0\n")
        put(release / ".work" / "scratch")
        for name in LAB_DIRS:
            put(lab / name / "input")
        for name in LAB_FILES:
            put(lab / name)
        for name in TOOL_DIRS:
            put(tools / name / "bin" / "tool")
        tool = tools / TOOL_DIRS[0] / "bin" / "tool"
        inner = tool.with_name("tool-link")
        inner.symlink_to("tool")
        pin_bytes = write_pins(tools, pin_file)
        assert b" L " + os.fsencode(TOOL_DIRS[0]) + b"/bin/tool-link\n" in pin_bytes
        original = file_hashes(release)

        def fails(expected, pins=pin_file):
            before = out.exists()
            try:
                stage(release, out, tools, pins)
            except (OSError, Refusal) as exc:
                if expected not in str(exc):
                    raise AssertionError(f"unexpected refusal: {exc}") from exc
            else:
                raise AssertionError("unexpected success")
            if out.exists() != before or out.is_symlink():
                raise AssertionError("output was changed after refusal")

        out.mkdir()
        put(out / "do-not-touch")
        fails("output already exists")
        assert (out / "do-not-touch").read_bytes() == b"fixture\n"
        shutil.rmtree(out)
        link = lab / LAB_DIRS[0] / "link"
        link.symlink_to(tool)
        fails("link or special file")
        link.unlink()
        put(tool, b"fixturE\n")
        fails("changed, missing or extra tool file")
        tool.unlink()
        fails("unresolved tool link")
        put(tool)
        extra = tools / TOOL_DIRS[1] / "extra"
        put(extra)
        fails("changed, missing or extra tool file")
        extra.unlink()
        fails("missing platform pins", pins_path(root, ("synthetic", "missing")))
        # Equivalent resolution with different target text still changes the pin.
        inner.unlink()
        inner.symlink_to("./tool")
        fails("changed, missing or extra tool file")
        inner.unlink()
        inner.symlink_to(tool)
        fails("absolute tool link")
        inner.unlink()
        inner.symlink_to("../../" + TOOL_DIRS[1] + "/bin/tool")
        fails("tool link leaves its tool folder")
        inner.unlink()
        inner.symlink_to("tool")
        count, digest = stage(release, out, tools, pin_file)
        copied = encode_manifest({Path(n): sum_file(out / n)
                                 for n in (*LAB_FILES, *(d + "/input" for d in LAB_DIRS))})
        assert count == len(LAB_FILES) + len(LAB_DIRS)
        assert copied == (out / "INPUTS.sha256").read_bytes()
        assert digest == hashlib.sha256(copied).hexdigest()
        assert file_hashes(release) == original
        assert file_hashes(out / "v0.5") == {Path("build.sh"): original[Path("build.sh")]}
        assert all((out / "toolchain" / n).resolve() == tools / n for n in TOOL_DIRS)
    print("SELFTEST PASS")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release", nargs="?", type=Path)
    parser.add_argument("out", nargs="?", type=Path)
    parser.add_argument("--toolchain", type=Path)
    parser.add_argument("--pin-toolchain", type=Path)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    inputs = (args.release, args.out, args.toolchain)
    if args.selftest and args.pin_toolchain is None and not any(inputs):
        selftest()
    elif args.pin_toolchain is not None and not args.selftest and not any(inputs):
        pins = pins_path(PIN_DIR)
        data = write_pins(args.pin_toolchain, pins)
        print(f"{pins}: {data.count(bytes([10]))} files; sha256 {hashlib.sha256(data).hexdigest()}")
    elif not args.selftest and args.pin_toolchain is None and all(inputs):
        count, digest = stage(*inputs, pins_path(PIN_DIR))
        print(f"INPUTS.sha256: {count} files; sha256 {digest}")
        print("Next: sh " + shlex.quote(str(args.out / args.release.name / "build.sh")))
    else:
        parser.error("use RELEASE OUT --toolchain DIR, --pin-toolchain DIR, or --selftest")


if __name__ == "__main__":
    try:
        main()
    except (OSError, Refusal) as exc:
        raise SystemExit(f"build-tree: {exc}") from None
