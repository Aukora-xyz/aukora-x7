"""Check the release source line counts and the declaration index against the actual build."""
from pathlib import Path
import sys

release = Path(__file__).resolve().parents[1]
lab = release.parent
work = release / ".work"
target = release / "trust"
target.mkdir(exist_ok=True)
files = {p for p in release.rglob("*") if p.is_file() and not p.is_relative_to(work)
         and p.suffix in {".lean", ".c", ".cpp", ".h", ".py", ".mjs", ".sh"}}
files.update(lab / name for name in (release / "tools/build-inputs.txt").read_text().splitlines())
inventory = ["file\tlines"]
for file in sorted(files):
    inventory.append(str(file.relative_to(lab)) + "\t" + str(len(file.read_bytes().splitlines())))
items = {"source-lines.tsv": ("\n".join(inventory) + "\n").encode(),
         "checker-declarations.tsv": (work / "package/laws.env.tsv").read_bytes()}
for name, data in items.items():
    path = target / name
    if sys.argv[1:] == ["--record"]:
        path.write_bytes(data)
    elif path.read_bytes() != data:
        raise ValueError(f"{name} differs from checked sources or exported environment")
print(f"Inventory matched {len(files)} local and shared source files and the full checker declaration index")
