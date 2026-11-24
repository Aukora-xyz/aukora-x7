"""From the lab root, check one ARK source with the bundled single-threaded Lean."""
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

source = {"model": "Ark3", "one": "Ark3One", "all": "Ark3All"}[sys.argv[1]]
args = ["toolchain/lean-4.19.0-darwin_aarch64/bin/lean", "-j1"]
if source == "Ark3":
    args += ["-o", "core/Ark3.olean"]
args += [f"core/{source}.lean"]
logs = Path("logs/R3-ARK.txt")
with logs.open("a", buffering=1) as log:
    print("$ LEAN_PATH=core " + " ".join(args), file=log)
    begin = time.monotonic()
    proc = subprocess.Popen(args, env={**os.environ, "LEAN_PATH": "core"},
                            start_new_session=True, stdout=log, stderr=log)
    try:
        code = proc.wait(timeout=280)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
        code = 124
        print("NOT FINISHED. Watchdog killed the Lean process group.", file=log)
    except BaseException:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
        raise
    print(f"exit {code}, {time.monotonic()-begin:.3f}s", file=log)
sys.exit(code)
