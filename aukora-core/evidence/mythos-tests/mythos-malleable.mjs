// Mythos: which single-bit changes to the accepted install frame are still accepted, and in which field?
import { readFileSync } from 'node:fs'; import { gunzipSync } from 'node:zlib';
const V = 'v0.1/'; const mod = await WebAssembly.compile(readFileSync(V + 'aukora-core.wasm'));
const rows = readFileSync(V + 'vectors/gate.tsv', 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));
const bin = gunzipSync(readFileSync(V + 'vectors/gate.bin.gz')); let p = 0;
const frames = rows.map(r => { const f = bin.subarray(p, p + +r[1]); p += +r[1]; return { f, v: +r[2] }; });
const k = frames.findIndex(x => x.v === 1 && x.f[0] === 0x1b), inst = frames[k].f;
const m = inst.readUInt32LE(73), pOff = 77 + m, pl = inst.readUInt32LE(pOff), intentOff = pOff + 4 + pl;
console.log('fields: header 0..41, target 41..73, model', 77, '..', 77 + m, '(', m, 'bytes ) proof', pOff + 4, '..', intentOff, '(', pl, 'bytes ) intent', intentOff, '..', inst.length);
const region = i => i < 41 ? 'header' : i < 73 ? 'target' : i < 77 ? 'model-length' : i < 77 + m ? 'model' : i < pOff + 4 ? 'proof-length' : i < intentOff ? 'proof' : 'intent';
const keys = readFileSync(V + 'fixtures/install/keys.bin'), cand = readFileSync(V + 'fixtures/fixed-genesis.wasm');
async function tryFrame(frame) {
  const api = (await WebAssembly.instantiate(mod, {})).exports; const c = (n, b) => { for (const v of b) api.input(v); return api[n](); };
  c('init', keys); for (let i = 0; i < cand.length; i += 8192) c('feed', cand.subarray(i, i + 8192));
  for (const x of frames.slice(0, k)) c('step', x.f); return c('step', frame);
}
const arg = process.argv[2] || 'sample'; const pos = [];
if (arg === 'sample') { for (let i = 0; i < 56; i++) pos.push(Math.floor((i + 0.5) * inst.length / 56)); }
else { const [a, b, step] = arg.split(',').map(Number); for (let i = a; i < b; i += step) pos.push(i); }
const acc = {}; const tot = {};
for (const i of pos) for (const bit of (arg === 'sample' ? [1] : [1, 128])) {
  const f = Buffer.from(inst); f[i] ^= bit; const r = region(i); tot[r] = (tot[r] || 0) + 1;
  if (await tryFrame(f) === 1) { acc[r] = (acc[r] || 0) + 1; if ((acc[r] || 0) <= 6) console.log('ACCEPTED: byte', i, 'bit', bit, 'field', r, 'offset in field', r === 'proof' ? i - pOff - 4 : r === 'model' ? i - 77 : i, 'was 0x' + inst[i].toString(16)); }
}
console.log('tried', JSON.stringify(tot), 'accepted', JSON.stringify(acc));
