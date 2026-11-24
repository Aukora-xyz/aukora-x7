"""Bound each lab command. The compiler holds the same lock as its supervisor."""
import ctypes as C
import fcntl
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import time

release = Path(__file__).resolve().parents[1]
work = release / ".work"
log = release.parent / "logs/memwatch.txt"
proc = C.CDLL("/usr/lib/libproc.dylib", use_errno=True)

def active_lean():
    count = proc.proc_listallpids(None, 0)
    if count < 1:
        raise RuntimeError("cannot enumerate processes for serial preflight")
    pids = (C.c_int * (count + 128))()
    n = proc.proc_listallpids(pids, C.sizeof(pids))
    if n < 1 or n >= len(pids) or os.getpid() not in pids[:n]:
        raise RuntimeError("incomplete process inventory")
    found = []
    for pid in pids[:n]:
        path = C.create_string_buffer(4096)
        if proc.proc_pidpath(pid, path, len(path)) > 0 and path.value.endswith(b"/lean"):
            found.append(pid)
        else:
            name = C.create_string_buffer(128)
            if proc.proc_name(pid, name, len(name)) > 0 and name.value == b"lean":
                found.append(pid)
    return found

def process_family(pid):
    """A clang driver may also have an active compiler or linker child."""
    pending = [pid]
    while pending:
        current = pending.pop()
        yield current
        children = (C.c_int * 128)()
        count = proc.proc_listchildpids(current, children, C.sizeof(children))
        if count > 0:
            pending.extend(children[:min(count, len(children))])

def arm():
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.alarm(355)

args = sys.argv[1:]
compiler = Path(args[0]).name == "lean"
if compiler:
    args.insert(1, "--plugin=" + str(work / "MemoryOption.dylib"))
    if "-j1" not in args:
        args.insert(1, "-j1")
    if "-M" not in args:
        args[1:1] = ["-M", "4096"]
    if args[args.index("-M")+1] != "4096":
        raise ValueError("unexpected compiler memory allowance")
lock = (release / "tools/watch.py").open("rb")
fcntl.flock(lock, fcntl.LOCK_EX)
if compiler:
    pending = active_lean()
    if pending:
        raise RuntimeError(f"another Lean process is alive: {pending}")
print("$", shlex.join(args), "(preflight clear)" if compiler else "", flush=True)
start = time.monotonic()
# Keep the driver's outer compile lock as well as the cross-stage lock
# open in the real compiler even if either Python supervisor is interrupted.
outer = os.environ.get("R11_COMPILE_LOCK_FD")
held = (lock.fileno(),) if outer is None else (lock.fileno(), int(outer))
child = subprocess.Popen(args, start_new_session=True, preexec_fn=arm, pass_fds=held)
peak = 0
try:
    while child.poll() is None:
        # Darwin rusage_info_v0 starts with a 16-byte UUID then uint64 fields;
        # ri_phys_footprint follows ri_wired_size and ri_resident_size.
        exceeded = False
        for pid in process_family(child.pid):
            info = C.create_string_buffer(512)
            if proc.proc_pid_rusage(pid, 0, C.byref(info)) != 0:
                continue
            used = max(int.from_bytes(info.raw[64:72], "little"),
                       int.from_bytes(info.raw[72:80], "little"))
            peak = max(peak, used)
            if used > 4096 * 1024**2:
                with log.open("a") as out:
                    print(time.strftime("%Y-%m-%d %H:%M:%S"), "KILLED", pid, used, shlex.join(args), file=out)
                exceeded = True
                break
        if exceeded:
            os.killpg(child.pid, signal.SIGKILL)
            break
        if time.monotonic()-start >= 357:
            os.killpg(child.pid, signal.SIGKILL)
            break
        try:
            child.wait(timeout=0.2)
        except subprocess.TimeoutExpired:
            pass
finally:
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    rc = child.wait()
print(f"exit {rc}, {time.monotonic()-start:.3f} s, peak sampled {peak/1024**2:.1f} MiB", flush=True)
sys.exit(rc if rc >= 0 else 128-rc)
