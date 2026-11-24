"""Build private Wasm data segments from the selected proof's fixed environment and type."""
import sys
from pathlib import Path
root = Path('logs/r6')
with Path(sys.argv[1]).open('w') as out:
    for name, path in [('r6_environment', 'wrong_digest.env'), ('r6_goal', 'wrong_digest.type.expr')]:
        data = (root / path).read_bytes()
        print(f'static const uint8_t {name}[{len(data)}] = {{', file=out)
        for i in range(0, len(data), 32):
            print(','.join(map(str, data[i:i + 32])) + ',', file=out)
        print('};', file=out)
