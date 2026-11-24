"""Compile the pinned, metered checker in the lab-local bootstrap tree."""
import os
from pathlib import Path
import subprocess
import sys

release = Path(__file__).resolve().parents[1]
work = release / ".work"
base = work / "logs/r6/bootstrap"
lib = base / "lib"
env = dict(os.environ, LEAN_PATH=str(lib), TMPDIR=str(work / "tmp"), PYTHONDONTWRITEBYTECODE="1")
subprocess.run([sys.executable, str(release / "tools/budget-checker.py")], check=True, cwd=release.parent, env=env)
subprocess.run([sys.executable, str(release / "tools/watch.py"),
                str(release.parent / "toolchain/lean-4.19.0-darwin_aarch64/bin/lean"),
                "-j1", "-M", "4096", "--root=" + str(base / "src"),
                "-o", str(lib / "Lean4Lean/TypeChecker.olean"), "-c", str(lib / "Lean4Lean/TypeChecker.c"),
                str(base / "src/Lean4Lean/TypeChecker.lean")], check=True, cwd=release.parent, env=env)
