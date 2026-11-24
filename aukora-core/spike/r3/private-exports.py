"""Keep the private linear memory under wasm-ld 19 (no --no-export-memory)."""
from pathlib import Path
import sys

def read_u32(data, offset):
    value = 0
    for shift in range(0, 35, 7):
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise ValueError("invalid ULEB128")

def u32(value):
    prefix = bytearray()
    while value >= 128:
        prefix.append((value & 127) | 128)
        value >>= 7
    prefix.append(value)
    return prefix

data = Path(sys.argv[1]).read_bytes()
assert data[:8] == b"\0asm\x01\0\0\0"
out = bytearray(data[:8])
pos = 8
removed = []
while pos < len(data):
    start = pos
    section = data[pos]
    size, body = read_u32(data, pos + 1)
    pos = body + size
    if section != 7:
        out += data[start:pos]
        continue
    count, cursor = read_u32(data, body)
    keep = []
    for i in range(count):
        entry = cursor
        length, cursor = read_u32(data, cursor)
        name = data[cursor:cursor + length].decode()
        cursor += length
        kind = data[cursor]
        _, cursor = read_u32(data, cursor + 1)
        if kind == 2 and name == "memory":
            removed.append(name)
        else:
            keep.append(data[entry:cursor])
    assert cursor == pos
    exports = u32(len(keep)) + b"".join(keep)
    out += bytes([section]) + u32(len(exports)) + exports
assert removed == ["memory"], removed
Path(sys.argv[2]).write_bytes(out)
