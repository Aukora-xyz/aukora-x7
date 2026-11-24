"""Read-only backup checkpoint comparison."""

from hashlib import sha256
import json
import re
import sys


def _digest(value):
    if type(value) is not bytes or len(value) != 32:
        raise ValueError("expected a 32-byte digest")


def _record(lines):
    if type(lines) is not list or any(type(line) is not bytes for line in lines):
        raise ValueError("expected a list of byte strings")


def head(g, lines):
    _digest(g)
    _record(lines)
    h = g
    for line in lines:
        h = sha256(h + line).digest()
    return h


def checkpoint(g, seen):
    top = head(g, seen)
    return {"count": len(seen), "top": top}


def verdict(g, kept, now):
    _digest(g)
    count = kept["count"]
    if type(count) is not int or not 0 <= count <= 9007199254740991:
        raise ValueError("invalid checkpoint count")
    _digest(kept["top"])
    _record(now)
    if len(now) < count:
        return 1
    return 0 if head(g, now[:count]) == kept["top"] else 2


def _decode(value):
    if type(value) is not str or re.fullmatch(r"(?:[0-9a-f]{2})*", value) is None:
        raise ValueError("invalid hex")
    return bytes.fromhex(value)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 backup.py vectors.json")
    with open(sys.argv[1], encoding="utf-8") as stream:
        vectors = json.load(stream)
    for row in vectors:
        g = _decode(row["g"])
        seen = [_decode(line) for line in row["seen"]]
        now = [_decode(line) for line in row["now"]]
        print(verdict(g, checkpoint(g, seen), now))


if __name__ == "__main__":
    main()
