// Mythos, defensive: for every ACCEPTED owner-signed frame in the corpus, flip one bit at sampled byte positions.
// Oracle: every changed frame must be refused (a signed frame has exactly one accepted encoding).
import { readFileSync } from 'node:fs'; import { gunzipSync } from 'node:zlib';
const V = 'v0.1/'; const mod = await WebAssembly.compile(readFileSync(V + 'aukora-core-lite.wasm'));
const keys = readFileSync(V + 'fixtures/signed/keys.bin'); const stride = Number(process.argv[2] || 3);
const rows = readFileSync(V + 'vectors/signed.tsv', 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));
const bin = gunzipSync(readFileSync(V + 'vectors/signed.bin.gz')); let p = 0;
const fr = rows.map(r => { const f = bin.subarray(p, p + +r[1]); p += +r[1]; return { label: r[0], f, v: +r[2] }; });
async function boot(upto) { const api = (await WebAssembly.instantiate(mod, {})).exports; const c = (n, b) => { for (let i = 0; i < b.length; i++) api.input(b[i]); return api[n](); }; c('init', keys); for (const x of fr.slice(0, upto)) c('step', x.f); return c; }
const SIGNED = new Set([0x13, 0x14, 0x16, 0x18, 0x19]); let tried = 0, accepted = 0, frames = 0; const where = {};
for (let i = 0; i < fr.length; i++) {
  const x = fr[i]; if (x.v !== 1 || !SIGNED.has(x.f[0])) continue; frames++;
  let c = await boot(i); let acc = [];
  for (let pos = i % stride; pos < x.f.length; pos += stride) {
    const m = Buffer.from(x.f); m[pos] ^= 1 << ((pos * 7 + i) % 8); tried++;
    if (c('step', m) === 1) { accepted++; acc.push(pos); c = await boot(i); }
  }
  console.log(x.label, 'tag', x.f[0].toString(16), 'bytes', x.f.length, 'accepted changes at', acc.length ? acc.slice(0, 20).join(',') : 'none');
  if (acc.length) where[x.label] = acc;
}
console.log(`SIGNED FRAMES: ${frames}; single-bit changes tried ${tried}; accepted ${accepted}`, JSON.stringify(where).slice(0, 600));
