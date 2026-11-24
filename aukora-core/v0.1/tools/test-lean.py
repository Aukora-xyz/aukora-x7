"""Run one native Lean test under the release's compiler lock and watchdog."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys

release = Path(__file__).resolve().parents[1]
lab = release.parent
work = release / ".work"
env = dict(os.environ, LEAN_PATH=str(work / "logs/r6/bootstrap/lib"), TMPDIR=str(work / "tmp"),
           PYTHONDONTWRITEBYTECODE="1")
with (work / "compile.lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    subprocess.run([sys.executable, "spike/r3/watch.py", "toolchain/lean-4.19.0-darwin_aarch64/bin/lean",
                    "-j1", "--root=v0.1", "--run", *sys.argv[1:]], check=True, cwd=lab, env=env)
