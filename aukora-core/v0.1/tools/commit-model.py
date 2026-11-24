"""Append the model commitment after normal linking and export stripping."""
import sys
from hashlib import sha256
from pathlib import Path

source, model, target = map(Path, sys.argv[1:])
wasm = source.read_bytes()
if wasm[:8] != b"\0asm\1\0\0\0":
    raise ValueError("not a version-one Wasm module")
name = b"aukora.model.sha256"
# Both lengths are below 128, so each is its one-byte unsigned LEB128 encoding.
section = bytes([len(name)]) + name + sha256(model.read_bytes()).digest()
target.parent.mkdir(exist_ok=True, parents=True)
target.write_bytes(wasm + bytes([0, len(section)]) + section)
print(target, target.stat().st_size, sha256(target.read_bytes()).hexdigest())
