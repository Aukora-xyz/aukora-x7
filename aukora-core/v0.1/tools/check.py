"""Compile the local Lean import DAG serially. An isolated check may reuse fresh imports."""
import argparse
import fcntl
import os
from pathlib import Path
import re
import subprocess
import sys

release = Path(__file__).resolve().parents[1]
lab = release.parent
work = release / ".work"
lib = work / "logs/r6/bootstrap/lib"
compiler = lab / "toolchain/lean-4.19.0-darwin_aarch64/bin/lean"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("modules", nargs="*")
args = parser.parse_args()
os.chdir(lab)
env = dict(os.environ, LEAN_PATH=str(lib), TMPDIR=str(work / "tmp"), PYTHONDONTWRITEBYTECODE="1")
sources = {p.relative_to(release).as_posix()[:-5].replace("/", "."): p for p in release.rglob("*.lean")
           if ".work" not in p.parts}
visited = set()

def check(module):
    if module in visited:
        return
    source = sources[module]
    obj = lib / (module.replace(".", "/") + ".olean")
    code = obj.with_suffix(".c")
    inputs = [source]
    for name in re.findall(r"^import\s+([A-Za-z0-9_.]+)", source.read_text(), re.M):
        if name in sources:
            check(name)
            inputs.append(lib / (name.replace(".", "/") + ".olean"))
    if not (obj.exists() and code.exists()) or obj.stat().st_mtime_ns < max(p.stat().st_mtime_ns for p in inputs):
        obj.parent.mkdir(parents=True, exist_ok=True)
        cmd = [sys.executable, lab / "spike/r3/watch.py", compiler, "-j1", "--root=" + str(release),
               "-o", obj, "-c", code, source]
        subprocess.run(cmd, check=True, env=env)
    visited.add(module)

with (work / "compile.lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    for module in args.modules or sorted(sources):
        check(module)
