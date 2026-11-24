"""Serialize lab compilers across concurrent research tasks using a process-owned lock."""
import fcntl
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
work = root / "logs/r9/build"
(work / "tmp").mkdir(parents=True, exist_ok=True)
# The directory survives a clean rebuild. Holding its inode lock also serializes
# simultaneous invocations of the complete reproduction script.
lock = os.open(work.parent, os.O_RDONLY)
fcntl.flock(lock, fcntl.LOCK_EX)
os.set_inheritable(lock, True)
os.environ.update(TMPDIR=str(work / "tmp"), PYTHONDONTWRITEBYTECODE="1",
                  CLANG_MODULE_CACHE_PATH=str(work / "tmp/ModuleCache"),
                  LEAN_PATH=str(work / "logs/r6/bootstrap/lib"))
os.execvp(sys.argv[1], sys.argv[1:])
