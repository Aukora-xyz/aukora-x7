"""Publish the fixtures and index the single environment embedded in the full core."""
from hashlib import sha256
import json
from pathlib import Path
from shutil import copyfile

release = Path(__file__).resolve().parents[1]
generated = release / ".work/package"
dest = release / "fixtures/packages"
dest.mkdir(parents=True, exist_ok=True)
for pattern in ("*.model", "*.proof.expr", "*.law", "lineage-*.decl"):
    for src in sorted(generated.glob(pattern)):
        copyfile(src, dest / src.name)
core = (release / "aukora-core.wasm").read_bytes()
env = (generated / "laws.env").read_bytes()
at = core.find(env)
if at < 0 or core.find(env, at+1) >= 0:
    raise ValueError("expected exactly one embedded declaration snapshot")
index = dict(offset=at, size=len(env), sha256=sha256(env).hexdigest())
(dest / "environment.json").write_text(json.dumps(index, indent=2) + "\n")
print("Actual embedded declaration snapshot:", index)
