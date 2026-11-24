"""Link the scalar export from Lean's unedited C output, without a Lean runtime."""

import os
from pathlib import Path
import shlex
import signal
import subprocess
import tempfile


LAB = Path(__file__).resolve().parents[1]
BUILD = LAB / "pcw" / "build"
TOOLS = LAB.parent / "lean-core-lab-2026-11-22" / "toolchain"
CLANG = TOOLS / "wasi-sdk-25.0-arm64-macos" / "bin" / "clang"
LEAN_INCLUDE = TOOLS / "lean-4.19.0-darwin_aarch64" / "include"


def main():
    source = BUILD / "Lattice.c"
    if not source.is_file():
        raise SystemExit("First emit pcw/build/Lattice.c with lean -j1 -c.")

    with tempfile.TemporaryDirectory(dir=BUILD) as tmp:
        target = Path(tmp) / "Lattice.wasm"
        command = [
            str(CLANG), "--target=wasm32-wasi", "-std=gnu11", "-Os",
            "-ffunction-sections", "-fdata-sections", "-I", str(LEAN_INCLUDE),
            "-nostdlib", "-Wl,--no-entry", "-Wl,--gc-sections",
            "-Wl,--export=pcw_run", "-Wl,--strip-all",
            str(source), "-o", str(target),
        ]
        print(shlex.join(command), flush=True)
        process = subprocess.Popen(
            command, cwd=LAB, env={**os.environ, "TMPDIR": tmp},
            start_new_session=True,
        )
        try:
            status = process.wait(timeout=170)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise SystemExit("Stopped WASI compile/link after 170 seconds.")
        if status:
            raise SystemExit(status)
        target.replace(BUILD / "Lattice.wasm")
    print("pcw/build/Lattice.wasm", (BUILD / "Lattice.wasm").stat().st_size, "bytes")


if __name__ == "__main__":
    main()
