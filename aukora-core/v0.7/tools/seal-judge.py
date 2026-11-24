"""Personalize one canonical executable-prefix pin after stripping exports."""
from hashlib import sha256
from pathlib import Path
from struct import pack
import sys

base, target = map(Path, sys.argv[1:])
image = bytearray(base.read_bytes())
prefix = b"AUKORA/R12/executable".ljust(24, b"\0")
slot = prefix + bytes(40) + b"JUDGE12\0"
if image.count(slot) != 1:
    raise ValueError("expected a single uninitialized judge descriptor")
offset = image.index(slot) + len(prefix)
digest = sha256(image).digest()
image[offset:offset+40] = pack("<II", len(image), offset) + digest
target.write_bytes(image)
print(f"{target} {len(image)} bytes; normalized executable {digest.hex()}; file {sha256(image).hexdigest()}")
