"""Bound a single command and retain its parent's serial lock through the actual child."""
import os
import shlex
import signal
import subprocess
import sys
import time

def arm():
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.alarm(355)

args = sys.argv[1:]
locked = os.environ.get("R11_COMPILE_LOCK_FD")
inherited = () if locked is None else (int(locked),)
print("$", shlex.join(args), flush=True)
start = time.monotonic()
p = subprocess.Popen(args, start_new_session=True, preexec_fn=arm, pass_fds=inherited)
try:
    rc = p.wait(timeout=358)
except (subprocess.TimeoutExpired, KeyboardInterrupt) as stop:
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    p.wait()
    rc = 124 if isinstance(stop, subprocess.TimeoutExpired) else 130
print(f"exit {rc}, {time.monotonic()-start:.3f} s", flush=True)
sys.exit(rc if rc >= 0 else 128-rc)
