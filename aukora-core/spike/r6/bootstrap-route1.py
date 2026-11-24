"""Try building the exact checker import closure serially from the pinned sources."""
import os
from pathlib import Path
import runpy
import subprocess
import sys

audit = runpy.run_path("spike/r6/import-audit.py")
build = Path("logs/r6/bootstrap").resolve()
src, out = build / "src", build / "lib"
lean = "toolchain/lean-4.19.0-darwin_aarch64/bin/lean"
env = dict(os.environ, TMPDIR=str(Path("logs/r6/tmp").resolve()), LEAN_PATH=str(out))
pending = set(audit["missing"])
done = set()

def compile_module(name):
    if name not in pending or name in done:
        return
    source = audit["sources"][name]
    for dep in audit["imports"](source):
        compile_module(dep)
    rel = Path(*name.split("."))
    path = (src / rel).with_suffix(".lean")
    obj = (out / rel).with_suffix(".olean")
    path.parent.mkdir(parents=True, exist_ok=True)
    obj.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)
    args = [lean, "-j1", "--root=" + str(src), "-o", str(obj)]
    if name.startswith(("Batteries.", "Lean4Lean.")):
        args.extend(["-c", str(obj.with_suffix(".c"))])
    args.append(str(path))
    print(f'[{len(done)+1}/{len(pending)}] {name}', flush=True)
    subprocess.run([sys.executable, "spike/r3/watch.py", *args], env=env, check=True)
    done.add(name)

compile_module(audit["root"])
print("Serial host C emission succeeded:", (out / "Lean4Lean/TypeChecker.c").stat().st_size)
