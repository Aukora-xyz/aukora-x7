// Mythos, second seat, round 11. Own harness (from EXPORTS.md and the corpus README), plus a hostile pass.
import { readFileSync, existsSync } from 'node:fs'; import { gunzipSync } from 'node:zlib';
const V = 'v0.2/', hex = b => Buffer.from(b).toString('hex');
let seed = 1122; const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const mod = await WebAssembly.compile(readFileSync(process.env.WASM || (V + 'aukora-core.wasm')));
const findings = {}; const note = (k, o) => { findings[k] = (findings[k] || 0) + 1; if (findings[k] <= 6) console.log('FINDING', k, JSON.stringify(o).slice(0, 260)); };
async function inst() {
  const api = (await WebAssembly.instantiate(mod, {})).exports; let dead = false;
  const call = (n, ...a) => { if (dead) return -2; try { return api[n](...a); } catch (e) { dead = true; note('TRAP', { n, e: String(e).slice(0, 60) }); return -1; } };
  const consume = (n, b) => { for (let i = 0; i < b.length; i++) call('input', b[i]); return call(n); };
  const view = () => { let s = ''; for (let i = 0; i < 32; i++) s += call('head', i).toString(16).padStart(2, '0'); for (let i = 0; i < 32; i++) s += call('core', i).toString(16).padStart(2, '0'); return s + ':' + call('threshold') + ':' + call('stampCount') + ':' + call('halted') + ':' + call('guessCeiling'); };
  const halted = () => call('halted');
  return { call, consume, view, halted, get dead() { return dead; } };
}
function group(name) {
  const rows = readFileSync(`${V}vectors/${name}.tsv`, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));
  const bin = gunzipSync(readFileSync(`${V}vectors/${name}.bin.gz`)); let p = 0;
  return rows.map(([label, len, verdict, head]) => { const frame = bin.subarray(p, p + +len); p += +len; return { label, frame, verdict: +verdict, head }; });
}
const keysFor = g => { const f = `${V}fixtures/${g}/keys.bin`; return readFileSync(existsSync(f) ? f : `${V}fixtures/signed/keys.bin`); };
const st = { rows: 0, agree: 0, mutants: 0, refused: 0, accepted: 0, staleReplayAccepted: 0, trueOk: 0 };
const per = Number(process.argv[2] || 3);
for (const g of (process.env.GROUPS ? process.env.GROUPS.split(',') : ['matrix', 'length', 'history', 'signed', 'r11-evidence', 'r11-fields', 'r11-safe'])) {
  const rows = group(g); const keys = keysFor(g);
  // 1. plain replay
  { const m = await inst(); if (m.consume('init', keys) !== 1) { console.log('genesis failed', g); continue; }
    let a = 0; for (const r of rows) { const v = m.consume('step', r.frame); st.rows++; if (v === r.verdict && m.view().startsWith(r.head)) { a++; st.agree++; } else if (a === st.rows) note('CORPUS_DISAGREE', { g, row: r.label }); }
    console.log('replay', g, a, 'of', rows.length, 'accepted', rows.filter(r => r.verdict === 1).length); }
  // 2. hostile pass with the same oracles as the v0.1 pass, plus verbatim replays of other rows' frames
  const boot = async upto => { const m = await inst(); m.consume('init', keys); for (const r of rows.slice(0, upto)) m.consume('step', r.frame); return m; };
  let m = await boot(0);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.frame.length <= 65536) for (let k = 0; k < per; k++) {
      let mut, replay = false; const kind = rnd(8);
      if (kind === 0) { const j = rnd(rows.length); if (j === i) continue; mut = rows[j].frame; replay = true; if (mut.equals(r.frame)) continue; }
      else { mut = Buffer.from(r.frame); if (mut.length === 0) continue;
        if (kind === 1) mut[rnd(mut.length)] ^= 1 << rnd(8); else if (kind === 2) mut = mut.subarray(0, rnd(mut.length)); else if (kind === 3) mut = Buffer.concat([mut, Buffer.from([rnd(256), rnd(256)])]);
        else if (kind === 4) mut[0] = [0x00, 0x13, 0x14, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x34, 0xff][rnd(15)]; else if (kind === 5) mut[rnd(mut.length)] = rnd(256);
        else if (kind === 6) { const x = Math.max(0, mut.length - 1 - rnd(Math.min(3400, mut.length))); mut[x] ^= 1 << rnd(8); } else { const x = rnd(mut.length); mut = Buffer.concat([mut.subarray(0, x), mut.subarray(x + 1)]); }
        if (mut.equals(r.frame)) continue; }
      if (mut[0] === 0x1b) continue; st.mutants++;
      const hb = m.halted(); const before = m.view(); const v = m.consume('step', mut); const after = m.view();
      if (hb === 1) { st.whileHalted = (st.whileHalted || 0) + 1; if (m.halted() === 0) note('HALT_CLEARED_BY_HOSTILE_FRAME', { g, row: r.label, replay, tag: mut[0] }); }
      if (v === 0) { st.refused++; if (after !== before) note('REFUSAL_CHANGED_STATE', { g, row: r.label }); }
      else if (v === 1) { st.accepted++; if (replay) { st.staleReplayAccepted++; note('OTHER_ROW_FRAME_ACCEPTED', { g, at: r.label }); } m = await boot(i); }
      if (m.dead) m = await boot(i);
    }
    const t = m.consume('step', r.frame); if (t === r.verdict && m.view().startsWith(r.head)) st.trueOk++; else { note('TRUE_FRAME_WRONG_AFTER_GARBAGE', { g, row: r.label, t, want: r.verdict }); m = await boot(i + 1); }
  }
  console.log('hostile', g, JSON.stringify(st));
}
console.log('TOTAL', JSON.stringify(st), 'findings', JSON.stringify(findings));
