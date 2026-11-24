"""Serialize lab checks and cross-compiles sharing this build directory."""
import fcntl
import os
from pathlib import Path
import sys

path = Path(__file__).resolve().parent / "build" / "compile.lock"
path.parent.mkdir(parents=True, exist_ok=True)
with path.open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    os.set_inheritable(lock.fileno(), True)
    os.execvp(sys.argv[1], sys.argv[1:])
