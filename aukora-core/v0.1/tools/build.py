"""Reproduce the release and compare its binaries, proof environment and corpus."""
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

release = Path(__file__).resolve().parents[1]
lab = release.parent
os.chdir(lab)
work = release / ".work"
started = time.monotonic()
# The release directory survives cleanup. Do not race another one-command rebuild.
lock = os.open(release, os.O_RDONLY)
fcntl.flock(lock, fcntl.LOCK_EX)
env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", TMPDIR=str(work / "tmp"),
           CLANG_MODULE_CACHE_PATH=str(work / "tmp/ModuleCache"),
           LEAN_PATH=str(work / "logs/r6/bootstrap/lib"))
watchdog = [sys.executable, "spike/r3/watch.py"]

def run(*cmd, watch=False, cwd=lab):
    subprocess.run((watchdog if watch else []) + list(cmd), env=env, cwd=cwd, check=True)

try:
    if work.exists():
        shutil.rmtree(work)
    (work / "tmp").mkdir(parents=True)
    run("shasum", "-a", "256", "-c", "v0.1/INPUTS.sha256", watch=True)
    run("sh", "v0.1/tools/bootstrap.sh")
    run(sys.executable, "v0.1/tools/check.py")
    run(sys.executable, "v0.1/tools/test-lean.py", "v0.1/tests/Check.lean")
    run(sys.executable, "v0.1/tools/test-lean.py", "v0.1/tests/EdVectors.lean")
    crypto = work / "crypto-vectors"
    crypto.mkdir()
    run("tar", "-xzf", "logs/r8/public-vectors.tar.gz", "-C", crypto, watch=True)
    run(sys.executable, "v0.1/tools/test-lean.py", "v0.1/tests/MldsaVectors.lean", crypto)
    for profile in ("full", "fixed", "lite"):
        run(sys.executable, "v0.1/tools/link.py", profile)
    run("shasum", "-a", "256", "-c", "v0.1/PINS.sha256", watch=True)
    run(sys.executable, "v0.1/tools/inventory.py", watch=True)
    for suite in ("gate", "risk", "policy", "stamp"):
        run("node", "v0.1/tests/" + suite + ".mjs", watch=True)
    run(sys.executable, "v0.1/tools/examples.py", watch=True)
    run("sh", "v0.1/tests/conformance.sh")
    run("node", "v0.1/tests/replay.mjs", "v0.1/vectors", "v0.1/aukora-core-lite.wasm", "--lite", watch=True)
except (OSError, subprocess.CalledProcessError) as e:
    print("FAIL v0.1", e, flush=True)
    sys.exit(1)
else:
    print(f"PASS v0.1 ({time.monotonic()-started:.1f} seconds total)", flush=True)
finally:
    if work.is_dir():
        shutil.rmtree(work)
