import {readFileSync} from 'node:fs';
import {cat,sha} from './host.mjs';
const pkg = 'v0.2/fixtures/packages/';
export const part = (name,extension) => readFileSync(pkg+name+'.'+extension);
export function candidate(name) {
  if (name === 'archived') return readFileSync('core/FixedGenesis9.wasm');
  if (!['same','strong','bottom','weak','weak-claims-root'].includes(name)) throw Error('unknown candidate '+name);
  const file = name.startsWith('weak') ? 'v0.1/aukora-core.wasm' : 'v0.2/fixtures/ratchet-core.wasm';
  const sectionName = Buffer.from('aukora.model.sha256');
  const section = cat(Buffer.of(sectionName.length),sectionName,sha(part(name,'model')));
  return cat(readFileSync(file),Buffer.of(0,section.length),section);
}
