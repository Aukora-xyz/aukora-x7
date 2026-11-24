"""Run one Lean process with both an inherited wall timer and a parent watchdog."""
import os
import shlex
import signal
import subprocess
import sys
import time

def arm():
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.alarm(285)

argv = sys.argv[1:]
print("$", shlex.join(argv), flush=True)
start = time.monotonic()
p = subprocess.Popen(argv, start_new_session=True, preexec_fn=arm)
try:
    rc = p.wait(timeout=290)
except subprocess.TimeoutExpired:
    os.killpg(p.pid, signal.SIGKILL)
    p.wait()
    rc = 124
print(f"exit {rc}, {time.monotonic() - start:.3f} s", flush=True)
sys.exit(rc if rc >= 0 else 128 - rc)
