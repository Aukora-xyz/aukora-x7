"""Replay the old risk and stamp suites unchanged through the Core9 ABI."""
from pathlib import Path
import shutil
import subprocess
import sys

root = Path("logs/r9/build/round-eight")
root.mkdir(parents=True, exist_ok=True)
shutil.copy("spike/r9/test-host.mjs", root / "test-host.mjs")
for name in ("risk", "stamp"):
    script = root / (name + ".mjs")
    shutil.copy(Path("spike/r8") / script.name, script)
    subprocess.run([sys.executable, "spike/r3/watch.py", "node", script], check=True)
