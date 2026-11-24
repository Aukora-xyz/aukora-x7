// Mythos, second seat, round 10. My own harness, written from v0.1/EXPORTS.md and v0.1/vectors/README.md only.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const V = 'v0.1/', hex = b => Buffer.from(b).toString('hex');
const sha = b => createHash('sha256').update(b).digest('hex');
const mods = {};
const load = async f => (mods[f] ??= await WebAssembly.compile(readFileSync(f)));
async function fresh(file) {
  const api = (await WebAssembly.instantiate(await load(file), {})).exports;
  const consume = (name, bytes) => { for (const v of bytes) api.input(v); return api[name](); };
  const head = () => hex(Uint8Array.from({ length: 32 }, (_, i) => api.head(i)));
  const core = () => hex(Uint8Array.from({ length: 32 }, (_, i) => api.core(i)));
  return { api, consume, head, core };
}
function group(name) {
  const rows = readFileSync(`${V}vectors/${name}.tsv`, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));
  const bin = gunzipSync(readFileSync(`${V}vectors/${name}.bin.gz`)); let p = 0;
  return rows.map(([label, len, verdict, head]) => { const frame = bin.subarray(p, p + +len); p += +len; return { label, frame, verdict: +verdict, head }; });
}
async function start(file, name, candidate) {
  const m = await fresh(file);
  const keys = readFileSync(`${V}fixtures/${name === 'gate' ? 'install' : 'signed'}/keys.bin`);
  if (m.consume('init', keys) !== 1) throw new Error('genesis failed ' + name);
  if (name === 'gate') { const c = candidate ?? readFileSync(`${V}fixtures/fixed-genesis.wasm`); for (let i = 0; i < c.length; i += 8192) if (m.consume('feed', c.subarray(i, i + 8192)) !== 1) throw new Error('feed'); }
  return m;
}
const groups = ['matrix', 'length', 'history', 'signed', 'gate'];
let total = 0, agree = 0, acc = 0;
for (const file of ['aukora-core.wasm', 'aukora-core-lite.wasm']) {
  let t = 0, a = 0, installDiff = [];
  for (const g of groups) {
    const rows = group(g); const m = await start(V + file, g); let diverged = false;
    for (const r of rows) {
      const v = m.consume('step', r.frame); const ok = v === r.verdict && m.head() === r.head; t++;
      if (ok) a++; else if (file.includes('lite') && r.frame[0] === 0x1b && r.verdict === 1 && v === 0) { installDiff.push(g + ':' + r.label); diverged = true; }
      else if (!diverged) console.log('DISAGREE', file, g, r.label, 'got', v, 'want', r.verdict);
      if (file === 'aukora-core.wasm' && r.verdict === 1) acc++;
    }
  }
  console.log(file, sha(readFileSync(V + file)).slice(0, 16), `agree ${a} of ${t}`, file.includes('lite') ? `; install rows refused by lite: ${installDiff.join(',') || 'none'}` : `; accepted ${acc}`);
}
// Mutations of the one accepted install frame: every mutant must be refused and must change nothing.
const rows = group('gate'); const k = rows.findIndex(r => r.verdict === 1 && r.frame[0] === 0x1b);
const inst = rows[k]; console.log('install frame: row', k, inst.label, inst.frame.length, 'bytes');
const positions = new Set([0, 1, 2, 8, 40, 41, inst.frame.length - 1, inst.frame.length - 2]);
for (let i = 0; i < 56; i++) positions.add(Math.floor((i + 0.5) * inst.frame.length / 56));
let refused = 0, unchanged = 0, stillOk = 0, n = 0;
for (const pos of positions) {
  const m = await start(V + 'aukora-core.wasm', 'gate'); for (const r of rows.slice(0, k)) m.consume('step', r.frame);
  const before = m.head() + m.core(); const mut = Buffer.from(inst.frame); mut[pos] ^= 1; n++;
  if (m.consume('step', mut) === 0) refused++; if (m.head() + m.core() === before) unchanged++;
  if (n <= 6) { if (m.consume('step', inst.frame) === 1 && m.head() === inst.head) stillOk++; }
}
console.log(`one-bit changes to the install frame: refused ${refused} of ${n}; state unchanged ${unchanged} of ${n}; the true frame still accepted afterwards ${stillOk} of 6`);
// One changed bit in the staged candidate file: the same grant and package must be refused.
const cand = Buffer.from(readFileSync(`${V}fixtures/fixed-genesis.wasm`)); let cr = 0, cn = 0;
for (const pos of [100, cand.length >> 1, cand.length - 40, cand.length - 1]) {
  const c = Buffer.from(cand); c[pos] ^= 1; const m = await start(V + 'aukora-core.wasm', 'gate', c);
  for (const r of rows.slice(0, k)) m.consume('step', r.frame); cn++; if (m.consume('step', inst.frame) === 0) cr++;
}
console.log(`one-bit changes to the staged candidate file: refused ${cr} of ${cn}`);
// The round-9 downgrade file staged under this grant (weaker test than Astra's: here the grant names another digest).
{ const m = await start(V + 'aukora-core.wasm', 'gate', readFileSync('core/FixedGenesis9.wasm')); for (const r of rows.slice(0, k)) m.consume('step', r.frame);
  console.log('round-9 downgrade file staged under the v0.1 grant:', m.consume('step', inst.frame) === 0 ? 'refused' : 'ACCEPTED'); }
