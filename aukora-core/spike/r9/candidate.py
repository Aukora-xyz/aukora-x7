"""Make the round-nine lab fixture by wrapping init in the pinned, import-free Core6.wasm.

At first init, discard the input and initialize using RFC 8032 test key 2.
After genesis, dispatch init to Core6 unchanged. All other exports stay identical.
The published fixture contains a public test key and is for lab use only.
"""
from hashlib import sha256
from pathlib import Path

source = Path("core/Core6.wasm").read_bytes()
assert sha256(source).hexdigest() == "92baf60040e4800c4dfd0040bbc32eff869ea865d6285b8f054776e940aed1f5"
public_key = bytes.fromhex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")


def leb(n):
    if n < 128:
        return bytes([n])
    return bytes([128 + n % 128]) + leb(n // 128)


def read(data, pos):
    value = 0
    for shift in range(0, 35, 7):
        b = data[pos]
        pos += 1
        value |= (b % 128) << shift
        if b < 128:
            return value, pos
    raise ValueError("oversized integer")


def i32(n):
    # These nonnegative signed constants need a zero sign bit.
    data = leb(n)
    return b"\x41" + (data[:-1] + bytes([data[-1] | 128, 0]) if data[-1] & 64 else data)


def pack(data):
    return leb(len(data)) + data


sections = {}
pos = 8
while pos < len(source):
    tag = source[pos]
    size, pos = read(source, pos + 1)
    assert tag not in sections
    sections[tag] = source[pos:pos + size]
    pos += size
assert 2 not in sections  # function indices begin at zero

funcs = sections[3]
count, pos = read(funcs, 0)
types = []
for _ in range(count):
    t, pos = read(funcs, pos)
    types.append(t)
assert pos == len(funcs)

exports = {}
data = sections[7]
n, pos = read(data, 0)
for _ in range(n):
    size, pos = read(data, pos)
    name = data[pos:pos + size].decode()
    pos += size
    assert data[pos] == 0
    exports[name], pos = read(data, pos + 1)
assert pos == len(data)


def call(name):
    return b"\x10" + leb(exports[name])


# head(0) is 256 before init. reset() clears any input before genesis.
body = b"\x00" + i32(0) + call("head") + i32(256) + b"\x46\x04\x40"
body += call("reset") + b"\x1a"
for byte in public_key:
    body += i32(byte) + call("input") + b"\x1a"
body += b"\x0b" + call("init") + b"\x0b"

n, pos = read(sections[10], 0)
assert n == count
sections[10] = leb(count + 1) + sections[10][pos:] + pack(body)
sections[3] = leb(count + 1) + b"".join(leb(i) for i in types + [types[exports["init"]]])
exports["init"] = count
sections[7] = leb(len(exports)) + b"".join(pack(k.encode()) + b"\0" + leb(i) for k, i in exports.items())
result = source[:8] + b"".join(bytes([tag]) + pack(data) for tag, data in sections.items())
model = Path("logs/r9/honest.model").read_bytes()
section = pack(b"aukora.model.sha256") + sha256(model).digest()
result += b"\0" + pack(section)
path = Path("core/FixedGenesis9.wasm")
path.write_bytes(result)
print(path, len(result), sha256(result).hexdigest(), "model", sha256(model).hexdigest())
