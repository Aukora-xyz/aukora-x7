"""Materialize the published frame streams inside the disposable build directory."""
from pathlib import Path
import gzip
import shutil
root = Path(__file__).resolve().parents[1]
for manifest in sorted((root / 'vectors').glob('*.tsv')):
    stream = manifest.with_suffix('.bin.gz')
    if stream.exists():
        dest = root / '.work' / 'vectors'
        dest.mkdir(exist_ok=True, parents=True)
        with gzip.open(stream, 'rb') as src, (dest / stream.stem).open('wb') as out:
            shutil.copyfileobj(src, out)

# Only staged bytes are reconstructed. Model and proof terms in the vector stream
# are the exact published bytes sent at the install entry point.
if (root/'fixtures/r11-install/stages.tsv').exists():
    from hashlib import sha256
    staged = root/'.work/vectors/staged'
    staged.mkdir(exist_ok=True)
    for name in ['same','strong','weak','weak-claims-root','bottom','archived']:
        if name == 'archived':
            data = (root.parent/'core/FixedGenesis9.wasm').read_bytes()
        else:
            source = root.parent/'v0.1/aukora-core.wasm' if name.startswith('weak') else root/'fixtures/ratchet-core.wasm'
            model = (root/'fixtures/packages'/(name+'.model')).read_bytes()
            tag = b'aukora.model.sha256'
            section = bytes([len(tag)])+tag+sha256(model).digest()
            data = source.read_bytes()+bytes([0,len(section)])+section
        (staged/(name+'.wasm')).write_bytes(data)
