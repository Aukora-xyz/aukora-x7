// Mythos, defensive break-it pass on OUR OWN v0.1 release files. No network, no other system.
// Oracles: (1) no input may trap the instance; (2) a refused submission changes nothing visible;
// (3) the lite and full cores agree on every non-install submission (the LiteTrace theorem, at the byte level);
// (4) after any refused garbage, the true next frame still gives the corpus verdict and head.
import { readFileSync } from 'node:fs'; import { gunzipSync } from 'node:zlib';
const V = 'v0.1/', hex = b => Buffer.from(b).toString('hex');
let seed = Number(process.argv[2] || 20261122); const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const mods = { lite: await WebAssembly.compile(readFileSync(V + 'aukora-core-lite.wasm')), full: await WebAssembly.compile(readFileSync(V + 'aukora-core.wasm')) };
const findings = []; const note = (kind, o) => { findings.push({ kind, ...o }); if (findings.filter(f => f.kind === kind).length <= 8) console.log('FINDING', kind, JSON.stringify(o).slice(0, 300)); };
async function inst(which) {
  const api = (await WebAssembly.instantiate(mods[which], {})).exports; let dead = false;
  const call = (name, ...a) => { if (dead) return -2; try { return api[name](...a); } catch (e) { dead = true; note('TRAP', { which, name, msg: String(e).slice(0, 80) }); return -1; } };
  const consume = (name, bytes) => { for (let i = 0; i < bytes.length; i++) call('input', bytes[i]); return call(name); };
  const view = () => { let s = ''; for (let i = 0; i < 32; i++) s += call('head', i).toString(16).padStart(2, '0'); for (let i = 0; i < 32; i++) s += call('core', i).toString(16).padStart(2, '0'); return s + ':' + call('threshold') + ':' + call('stampCount'); };
  return { call, consume, view, get dead() { return dead; } };
}
function group(name) {
  const rows = readFileSync(`${V}vectors/${name}.tsv`, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));
  const bin = gunzipSync(readFileSync(`${V}vectors/${name}.bin.gz`)); let p = 0;
  return rows.map(([label, len, verdict, head]) => { const frame = bin.subarray(p, p + +len); p += +len; return { label, frame, verdict: +verdict, head }; });
}
const keys = readFileSync(V + 'fixtures/signed/keys.bin');
const TAGS = [0x00, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0xff, 0x07, 0x11, 0x12];
function mutate(f, pool) {
  const b = Buffer.from(f); const k = rnd(11);
  if (b.length === 0) return Buffer.from([rnd(256)]);
  switch (k) {
    case 0: b[rnd(b.length)] ^= 1 << rnd(8); return b;
    case 1: b[rnd(b.length)] = rnd(256); return b;
    case 2: return b.subarray(0, rnd(b.length));
    case 3: return Buffer.concat([b, Buffer.from(Array.from({ length: 1 + rnd(40) }, () => rnd(256)))]);
    case 4: b[0] = TAGS[rnd(TAGS.length)]; return b;
    case 5: { const o = pool[rnd(pool.length)].frame; const cut = rnd(b.length); return Buffer.concat([b.subarray(0, cut), o.subarray(Math.min(cut, o.length))]); }
    case 6: { const i = rnd(b.length); return Buffer.concat([b.subarray(0, i), b.subarray(i + 1)]); }
    case 7: { const i = rnd(b.length); return Buffer.concat([b.subarray(0, i), Buffer.from([rnd(256)]), b.subarray(i)]); }
    case 8: { for (let j = 0; j < 4; j++) b[rnd(b.length)] ^= 1 << rnd(8); return b; }
    case 9: { if (b.length > 41) b[41 + rnd(Math.min(8, b.length - 41))] = [0, 1, 0x7f, 0x80, 0xff][rnd(5)]; return b; }   // length and tag fields just after the header
    default: { const i = Math.max(0, b.length - 1 - rnd(Math.min(3400, b.length))); b[i] ^= 1 << rnd(8); return b; }     // tail: signatures live here
  }
}
const stats = { mutants: 0, refused: 0, accepted: 0, trueOk: 0, trueBad: 0, diff: 0, changedOnRefusal: 0 };
const per = Number(process.argv[3] || 4);
for (const g of ['matrix', 'history', 'signed', 'length']) {
  const rows = group(g);
  const boot = async upto => { const a = { lite: await inst('lite'), full: await inst('full') }; for (const w of ['lite', 'full']) { if (a[w].consume('init', keys) !== 1) throw new Error('genesis'); for (const r of rows.slice(0, upto)) a[w].consume('step', r.frame); } return a; };
  let a = await boot(0);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.frame.length <= 65536) for (let m = 0; m < (g === 'signed' ? per * 6 : per); m++) {
      const mut = mutate(r.frame, rows); if (mut[0] === 0x1b || mut.equals(r.frame)) continue; stats.mutants++;
      const before = { lite: a.lite.view(), full: a.full.view() };
      const v = { lite: a.lite.consume('step', mut), full: a.full.consume('step', mut) };
      const after = { lite: a.lite.view(), full: a.full.view() };
      if (v.lite !== v.full || after.lite !== after.full) { stats.diff++; note('LITE_FULL_DISAGREE', { g, row: r.label, v, mut: hex(mut).slice(0, 120) }); }
      if (v.full === 0) { stats.refused++; if (after.full !== before.full || after.lite !== before.lite) { stats.changedOnRefusal++; note('REFUSAL_CHANGED_STATE', { g, row: r.label, mut: hex(mut).slice(0, 120) }); } }
      else if (v.full === 1) { stats.accepted++; note('ACCEPTED_MUTANT', { g, row: r.label, trueVerdict: r.verdict, lenTrue: r.frame.length, lenMut: mut.length, firstDiff: (() => { let d = 0; while (d < Math.min(mut.length, r.frame.length) && mut[d] === r.frame[d]) d++; return d; })(), tag: mut[0].toString(16) }); a = await boot(i); }
      if (a.lite.dead || a.full.dead) a = await boot(i);
    }
    const t = { lite: a.lite.consume('step', r.frame), full: a.full.consume('step', r.frame) };
    if (t.full === r.verdict && t.lite === r.verdict && a.full.view().startsWith(r.head) && a.lite.view().startsWith(r.head)) stats.trueOk++; else { stats.trueBad++; note('TRUE_FRAME_WRONG_AFTER_GARBAGE', { g, row: r.label, t }); a = await boot(i + 1); }
  }
  console.log('group', g, JSON.stringify(stats));
}
// API misuse: random call sequences before and after genesis, on the lite core. Oracle: no trap.
let seqs = 0, calls = 0;
for (let s = 0; s < Number(process.argv[4] || 1500); s++) {
  const m = await inst('lite'); if (rnd(2)) m.consume('init', keys); seqs++;
  for (let c = 0; c < 40 && !m.dead; c++) {
    calls++; const big = [0, 1, 31, 32, 255, 256, 65535, 0x7fffffff, -1, 0x80000000 | 0][rnd(10)];
    switch (rnd(14)) {
      case 0: m.call('input', [0, 1, 255, 256, -1, 1e9][rnd(6)]); break;
      case 1: for (let i = rnd(200); i > 0; i--) m.call('input', rnd(256)); break;
      case 2: m.call('step'); break; case 3: m.call('init'); break; case 4: m.call('reset'); break; case 5: m.call('feed'); break;
      case 6: m.call('verify'); break; case 7: m.call('hashHead'); break; case 8: m.call('outcome'); break; case 9: m.call('stamp'); break;
      case 10: m.call('head', big); m.call('core', big); break; case 11: m.call('recordByte', big, [0, 1, big][rnd(3)]); break;
      case 12: m.call('stampByte', big, big); break; default: m.call('threshold'); m.call('stampCount');
    }
  }
}
console.log('misuse sequences', seqs, 'calls', calls);
const byKind = {}; for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
console.log('TOTAL', JSON.stringify(stats), 'findings', JSON.stringify(byKind), 'seed', process.argv[2] || 20261122);
