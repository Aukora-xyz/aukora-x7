#!/usr/bin/env python3
"""Memory watchdog for the lab (Mythos, 22 Nov 2026, after two runaway Lean jobs on the owner's 16 GB Mac).

Every 2 seconds: any process running a binary from a lab toolchain (lean, clang, wasm-ld, leanc) whose memory
footprint (macOS `top` MEM, which counts compressed and swapped pages; falls back to RSS) is above the cap is
killed with SIGKILL and logged. More than one lab `lean` at a time is logged, not killed.
Usage: memwatch.py [cap_mb=4096] [idle_exit_seconds=180]   Log: logs/memwatch.txt
"""
import os, re, signal, subprocess, sys, time
CAP = int(sys.argv[1]) if len(sys.argv) > 1 else 4096
IDLE = int(sys.argv[2]) if len(sys.argv) > 2 else 180
MARK = ("/scratch/lean-core-lab-2026-11-22/", "/scratch/lean-core-pcw-2026-11-22/")
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "memwatch.txt")
def log(msg):
    with open(LOG, "a") as f: f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
def mb(text):
    m = re.match(r"([0-9.]+)([KMGB]?)", text.strip().rstrip("+-"))
    if not m: return 0.0
    return float(m.group(1)) * {"K": 1 / 1024, "M": 1, "G": 1024, "B": 1 / 1048576, "": 1 / 1048576}[m.group(2)]
def procs():
    out = subprocess.run(["ps", "-axo", "pid=,rss=,command="], capture_output=True, text=True).stdout
    found = []
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3: continue
        exe = parts[2].split(" ")[0]
        if "/toolchain/" in exe and any(k in exe for k in MARK) or (exe.endswith("/lean") and any(k in parts[2] for k in MARK)):
            found.append((int(parts[0]), int(parts[1]) / 1024, exe, parts[2][:160]))
    return found
def footprint(pid, rss):
    try:
        out = subprocess.run(["top", "-l", "1", "-pid", str(pid), "-stats", "pid,mem"], capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            p = line.split()
            if len(p) == 2 and p[0] == str(pid): return max(rss, mb(p[1]))
    except Exception: pass
    return rss
log(f"start cap {CAP} MB idle-exit {IDLE} s pid {os.getpid()}")
last_seen = time.time(); peak = 0.0; overlap_logged = 0.0
while True:
    ps = procs()
    busy = bool(ps) or subprocess.run(["pgrep", "-f", "codex exec"], capture_output=True).returncode == 0 or subprocess.run(["pgrep", "-f", "lean-core-lab-2026-11-22/(v0|spike)"], capture_output=True).returncode == 0
    if busy: last_seen = time.time()
    elif time.time() - last_seen > IDLE: log(f"idle, exit; peak seen {peak:.0f} MB"); break
    leans = [p for p in ps if p[2].endswith("/lean")]
    if len(leans) > 1 and time.time() - overlap_logged > 30:
        overlap_logged = time.time(); log("OVERLAP " + " | ".join(f"{p[0]}:{p[1]:.0f}MB" for p in leans))
    for pid, rss, exe, cmd in ps:
        use = footprint(pid, rss) if rss > 600 else rss
        if use > peak: peak = use
        if use > CAP:
            try: os.kill(pid, signal.SIGKILL); log(f"KILLED pid {pid} at {use:.0f} MB (cap {CAP}): {cmd}")
            except ProcessLookupError: pass
    time.sleep(2)
