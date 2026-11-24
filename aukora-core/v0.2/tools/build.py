"""Rebuild the lab profiles from local sources and replay each independently bounded suite."""
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
env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", TMPDIR=str(work / "tmp"),
           CLANG_MODULE_CACHE_PATH=str(work / "tmp/ModuleCache"),
           LEAN_PATH=str(work / "logs/r6/bootstrap/lib"))
driver = sys.executable
def run(*argv):
    subprocess.run(list(map(str,argv)), env=env, check=True)
def checked(*argv):
    run(driver, release / "tools/watch.py", *argv)

release_lock = os.open(release, os.O_RDONLY)
fcntl.flock(release_lock, fcntl.LOCK_EX)
try:
    if work.exists(): shutil.rmtree(work)
    (work/"tmp").mkdir(parents=True)
    checked("shasum", "-a", "256", "-c", release / "INPUTS.sha256")
    run("sh", release / "tools/bootstrap.sh")
    run(driver, release/"tools/check.py", "tools.Export11", "tests.RatchetStrict", "Proofs.Evidence11",
        "Proofs.Round11Safe", "Proofs.FullSuccession", "tests.Replay11")
    run(driver, release/"tools/test-lean.py", "v0.2/tests/RatchetCheck.lean")
    for profile in ("full", "ratchet"):
        run(driver, release/"tools/link.py", profile)
    checked("shasum", "-a", "256", "-c", release / "PINS.sha256")
    for fixture in (release/"fixtures/packages").iterdir():
        if fixture.read_bytes() != (work/"package"/fixture.name).read_bytes():
            raise ValueError("certificate reproduction failed: " + fixture.name)
    checked(driver, release/"tools/inventory.py")
    run("sh", release/"tests/conformance.sh")
    checked("node",release/"tests/recovery11.mjs")
    checked("node",release/"tests/replay11.mjs","--successor","r11-install")
    print(f"PASS v0.2 ({time.monotonic()-started:.1f} seconds for the entire build)",flush=True)
finally:
    if work.exists(): shutil.rmtree(work)
