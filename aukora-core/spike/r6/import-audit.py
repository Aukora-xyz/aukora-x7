"""Read the source headers for lean4lean's checker; count elaboration dependencies."""
from collections import Counter
from pathlib import Path
import re
import tarfile


def imports(source):
    # Read only initial header commands. Skip nested block comments, including doc comments.
    used = []
    pos = 0
    prelude = False
    while pos < len(source):
        if source[pos].isspace():
            pos += 1
        elif source.startswith('--', pos):
            end = source.find('\n', pos)
            pos = len(source) if end < 0 else end + 1
        elif source.startswith('/-', pos):
            depth = 1
            for marker in re.finditer(r'/-|-/', source[pos + 2:]):
                depth += 1 if marker[0] == '/-' else -1
                if depth == 0:
                    pos += 2 + marker.end()
                    break
            else:
                raise ValueError('unclosed header comment')
        elif source.startswith('prelude', pos):
            prelude = True
            pos += len('prelude')
        elif source.startswith('import ', pos):
            end = source.find('\n', pos)
            line = source[pos + 7:end if end >= 0 else None].split('--')[0].strip()
            assert re.fullmatch(r'[\w.!]+', line), repr(line)
            used.append(line)
            pos = len(source) if end < 0 else end + 1
        else:
            break
    return used if prelude else ['Init', *used]


sources = {}
archives = [
    ('toolchain/downloads/lean4-v4.19.0-source.tar.gz', 'src/'),
    ('logs/r6/downloads/batteries.tar.gz', ''),
    ('logs/r6/downloads/lean4lean.tar.gz', ''),
]
for archive, prefix in archives:
    with tarfile.open(archive, 'r|gz') as entries:
        for entry in entries:
            path = entry.name.partition('/')[2]
            if not entry.isfile() or not path.startswith(prefix) or not path.endswith('.lean'):
                continue
            name = path[len(prefix):-5].replace('/', '.')
            if name.split('.')[0] in {'Lean', 'Std', 'Init', 'Batteries', 'Lean4Lean'}:
                sources[name] = entries.extractfile(entry).read().decode('utf8')

root = 'Lean4Lean.TypeChecker'
pending = [root]
visited = set()
while pending:
    module = pending.pop()
    if module not in visited:
        visited.add(module)
        pending.extend(imports(sources[module]))

sysroot = Path('toolchain/lean-4.19.0-darwin_aarch64/lib/lean')
missing = [m for m in visited if not (sysroot / (m.replace('.', '/') + '.olean')).is_file()]
for label, names in [('source closure', visited), ('oleans absent from bundled Lean sysroot', missing)]:
    counts = Counter(n.split('.')[0] for n in names)
    print(f'{label} including root: {len(names)}', dict(sorted(counts.items())))
print('Batteries modules:', ', '.join(sorted(n for n in visited if n.startswith('Batteries.'))))
print('Build-time source imports, including elaborators; these counts do not measure linked Wasm size.')
