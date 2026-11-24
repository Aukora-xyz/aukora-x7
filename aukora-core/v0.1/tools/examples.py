"""Render a complete literal-hex example for each event from the public fixture sessions."""
from pathlib import Path
import sys

release = Path(__file__).resolve().parents[1]
signed = release / "fixtures/signed"
wires = (signed / "frames.bin").read_bytes()
rows = ["event\thex"]
offset = 0
for row in (signed / "index.tsv").read_text().splitlines():
    name, length = row.split("\t")
    end = offset + int(length)
    assert offset < end <= len(wires)
    rows.append(name + "\t" + wires[offset:end].hex())
    offset = end
assert offset == len(wires)
rows.append("install\t" + (release / "fixtures/install/upgrade.bin").read_bytes().hex())
rows.append("stamp-at-genesis\t" + (bytes(32) + b"\x01\x00a" + bytes(32)).hex())
result = "\n".join(rows) + "\n"
target = release / "vectors/events.hex.tsv"
if sys.argv[1:] == ["--record"]:
    target.write_text(result)
elif target.read_text() != result:
    raise ValueError("distributed hexadecimal examples differ from the public fixtures")
print(f"{len(rows)-1} complete hexadecimal examples matched their fixture inputs")
