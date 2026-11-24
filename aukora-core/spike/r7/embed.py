"""Emit immutable private checker inputs; no candidate-provided goal or environment."""
import sys
from pathlib import Path

lab = Path("logs/r7")
with Path(sys.argv[1]).open("w") as out:
    for array, file in [("r7_environment", "laws.env"), ("r7_primary", "model.type.expr"),
                        ("r7_alternate", "other.type.expr")]:
        data = (lab / file).read_bytes()
        print(f"static const uint8_t {array}[] = {{", file=out)
        for start in range(0, len(data), 32):
            print(",".join(map(str, data[start:start + 32])) + ",", file=out)
        print("};", file=out)
