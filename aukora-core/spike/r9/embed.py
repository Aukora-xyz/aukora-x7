"""The private checker input is the previous law environment, with no goal or candidate bytes."""
from pathlib import Path
import sys

data = Path("logs/r7/laws.env").read_bytes()
with Path(sys.argv[1]).open("w") as out:
    print("static const uint8_t r9_environment[] = {", file=out)
    for start in range(0, len(data), 32):
        print(",".join(map(str, data[start:start+32])) + ",", file=out)
    print("};", file=out)
