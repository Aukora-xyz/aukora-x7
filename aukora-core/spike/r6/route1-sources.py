"""Materialize bootstrap C for the observed import closure and C++ kernel source locally."""
from pathlib import Path
import runpy
import tarfile

audit = runpy.run_path("spike/r6/import-audit.py")
out = Path("logs/r6/upstream")
closure = {n.replace(".", "/") + ".c" for n in audit["visited"]}
count = size = 0
with tarfile.open("toolchain/downloads/lean4-v4.19.0-source.tar.gz", "r|gz") as entries:
    for entry in entries:
        name = entry.name.partition("/")[2]
        if not entry.isfile():
            continue
        if name.startswith("stage0/stdlib/") and name[len("stage0/stdlib/"):] in closure:
            pass
        elif not (name.startswith(("src/kernel/", "src/util/", "src/runtime/", "src/library/")) and name.endswith((".h", ".hpp", ".cpp"))):
            continue
        path = out / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(entries.extractfile(entry).read())
        count += 1
        size += entry.size
print(f"From existing lab archive: {count} files, {size} bytes.")
