"""Run from the lab folder. Append all attempts, including expected Lean failures."""

import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import time


LAB = Path(__file__).resolve().parents[1]
BUILD = LAB / "pcw" / "build"
LEAN = LAB.parent / "lean-core-lab-2026-11-22/toolchain/lean-4.19.0-darwin_aarch64/bin/lean"
LOG = LAB / "logs/P1-CHECKS.txt"


def record(line):
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")


def check(command, *, expect_failure=False):
    record("$ " + shlex.join([str(arg) for arg in command]))
    start = time.monotonic()
    proc = subprocess.Popen(
        command, cwd=LAB, env={**os.environ, "LEAN_PATH": str(BUILD), "TMPDIR": str(BUILD / "tmp")},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True,
    )
    try:
        output, _ = proc.communicate(timeout=178)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        output, _ = proc.communicate()
        record(output + "\nTIMEOUT — stopped at 178 seconds")
        raise SystemExit(1)
    if output:
        record(output.rstrip())
    record(f"exit {proc.returncode}, wall {time.monotonic() - start:.3f} s")
    if (proc.returncode == 0) == expect_failure:
        raise SystemExit("Unexpected exit status, see logs/P1-CHECKS.txt")
    return output


def main():
    (BUILD / "tmp").mkdir(parents=True, exist_ok=True)
    record("\nP1 serial run " + time.strftime("%Y-%m-%d %H:%M:%S %z"))
    check([LEAN, "-j1", "--version"])
    lean = [LEAN, "-j1", "--root=pcw"]
    for name in ["Lattice", "Xor", "And", "Mutations"]:
        flags = ["-c", "pcw/build/Lattice.c"] if name == "Lattice" else []
        check(lean + flags + ["-o", f"pcw/build/{name}.olean", f"pcw/{name}.lean"])
    errors = check(lean + ["pcw/Refusals.lean"], expect_failure=True)
    expected = ["Meets xorNet andSpec\nis false", "type mismatch\n  xor_certificate",
                "Certificate [1, 254, 0, 255, 1, 0, 1, 1, 0] xorSpec"]
    if errors.count("error:") != 2 or not all(message in errors for message in expected):
        record("Missing expected false-spec or wrong-payload diagnostic.")
        raise SystemExit(1)
    record("Both intentional refusals observed.")
    vectors = check(lean + ["--run", "pcw/Vectors.lean"])
    json.loads(vectors)
    (BUILD / "vectors.json").write_text(vectors, encoding="utf-8")
    check([sys.executable, "pcw/build_wasm.py"])
    check(["node", "--version"])
    check(["node", "pcw/compare.mjs"])
    for name in ["Lattice.c", "Lattice.wasm", "vectors.json"]:
        data = (BUILD / name).read_bytes()
        record(f"sha256 {hashlib.sha256(data).hexdigest()}  pcw/build/{name}  {len(data)} bytes")
    record("P1 suite passed.")


if __name__ == "__main__":
    main()
