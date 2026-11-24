// Mythos, second seat, round 9: read the Wasm files' sections with my own parser (none of Astra's scripts).
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = b => createHash('sha256').update(b).digest('hex');
function sections(buf) {
  if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error('not wasm');
  let p = 8; const out = [];
  const leb = () => { let v = 0, s = 0, b; do { b = buf[p++]; v |= (b & 127) << s; s += 7; } while (b & 128); return v >>> 0; };
  while (p < buf.length) {
    const id = buf[p++]; const size = leb(); const start = p; let name = null, body = null;
    if (id === 0) { const n = leb(); name = buf.subarray(p, p + n).toString(); body = buf.subarray(p + n, start + size); }
    out.push({ id, size, name, body }); p = start + size;
  }
  return out;
}
const count = (s, id) => s.filter(x => x.id === id).length;
for (const f of ['core/Core9.wasm', 'core/FixedGenesis9.wasm', 'core/Core6.wasm']) {
  const buf = readFileSync(f); const s = sections(buf);
  const custom = s.filter(x => x.id === 0);
  const imports = count(s, 2);
  console.log(f, buf.length, sha(buf).slice(0, 16), 'import sections:', imports, 'custom:', custom.map(c => c.name + '(' + c.body.length + ')').join(',') || 'none');
  if (f.includes('FixedGenesis9')) {
    const m = custom.filter(c => c.name === 'aukora.model.sha256');
    console.log('  model sections:', m.length, m[0] ? m[0].body.toString('hex') : '');
    if (existsSync('logs/r9/honest.model')) {
      const model = readFileSync('logs/r9/honest.model');
      console.log('  sha256(logs/r9/honest.model):', sha(model), 'bytes', model.length, 'MATCH:', sha(model) === m[0].body.toString('hex'));
    } else console.log('  logs/r9/honest.model not kept');
    // how much of the candidate is the old round-6 core?
    const old = sections(readFileSync('core/Core6.wasm'));
    const same = id => { const a = s.find(x => x.id === id), b = old.find(x => x.id === id); return a && b && sha(buf.subarray(0,0)) && a.size === b.size; };
    for (const id of [1, 5, 6, 9, 11]) console.log('  section', id, 'same size as Core6:', same(id));
    const a = s.find(x => x.id === 10), b = old.find(x => x.id === 10);
    console.log('  code section bytes: candidate', a.size, 'Core6', b.size, 'difference', a.size - b.size);
  }
}
