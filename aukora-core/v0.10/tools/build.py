"""Rebuild the two lab images offline and verify the frozen public fixtures."""
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

release = Path(__file__).resolve().parents[1]
lab = release.parent
work = release / ".work"
os.chdir(lab)
driver = sys.executable
env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", TMPDIR=str(work / "tmp"),
           CLANG_MODULE_CACHE_PATH=str(work / "tmp/ModuleCache"),
           LEAN_PATH=str(work / "logs/r6/bootstrap/lib"))
started = time.monotonic()

def run(*argv):
    subprocess.run(list(map(str, argv)), check=True, env=env)

def test(name, *args):
    run(driver, release / "tools/watch.py", "node", release / "tests" / name, *args)

def clean():
    # A cancelled supervisor cannot release this lock on behalf of a live child.
    with (release / "tools/watch.py").open("rb") as workers:
        fcntl.flock(workers, fcntl.LOCK_EX)
        if work.exists():
            shutil.rmtree(work)

with (release / "build.sh").open("rb") as build:
    fcntl.flock(build, fcntl.LOCK_EX)
    clean()
    (work / "tmp").mkdir(parents=True)
    try:
        run("sh", release / "tools/bootstrap.sh")
        run(driver, release / "tools/check.py")
        run(driver, release / "tools/test-lean.py", release / "tests/CheckerBudget12.lean")
        package = work / "package"
        drops = sorted(p.stem for p in package.glob("drop-*.model"))
        if len(drops) != 46:
            raise RuntimeError("missing single-clause omission packages")
        positives = ["same", "strong", "strong-next", "wrong-own", "supplement"]
        batches = [drops[start:start+5] for start in range(0, len(drops), 5)]
        for cases in [positives, *batches]:
            run(driver, release / "tools/test-lean.py", release / "tests/GateFinalChecks.lean", *cases)
        for profile in ("full", "lite"):
            run(driver, release / "tools/link.py", profile)
        run(driver, release / "tools/package.py")
        # Round 12c A: genesis cannot pin a set other than the one full_lawful is proved for.
        run(driver, release / "tools/watch.py", "node", release / "tools/genesis-check.mjs",
            release / "aukora-core.wasm", work / "package/proved.id")
        run(driver, release / "tools/env-split.py")
        run(driver, release / "tools/watch.py", "shasum","-a","256","-c",release/"PINS.sha256")
        for cases in [["same", "archived", "strong", "wrong-own", "unsatisfied"], *batches]:
            test("gate-final.mjs", *cases)
        test("judge12.mjs")
        for artifact in ("aukora-core.wasm", "aukora-core-lite.wasm"):
            for case in ("reserve", "policy"):
                test("capacity-final.mjs", release / artifact, case)
        test("package-binding.mjs",release/"aukora-core.wasm","--stage-own-file",
             release/"fixtures/packages/same.model",release/"fixtures/packages/same.proof.expr")
        test("record-compatibility.mjs")
        for artifact in ("aukora-core.wasm", "aukora-core-lite.wasm"):
            for suite in ("memory","stage","count","volume"):
                test("bounds12.mjs", release / artifact, suite)
        test("checker-controls.mjs")
        test("cell12.mjs")
        test("chain-vectors.mjs")
        for artifact in ("aukora-core.wasm", "aukora-core-lite.wasm"):
            test("record-binding.mjs", release / artifact)
            test("record-rebinding.mjs", release / artifact)
            test("record-rebinding-vectors.mjs", release / artifact)
        test("genesis-check.mjs")
        print(f"PASS v0.10 ({time.monotonic()-started:.1f} seconds across separately bounded stages)", flush=True)
    finally:
        clean()
