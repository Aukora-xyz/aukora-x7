// An independent check: is core B the same machine as core A? Same keys, same ordinary start, the SAME bytes fed to both, compared after every input:
// the verdict, the head, the installed-core digest, the halt flag and the evidence ceiling. Real signed frames of seven kinds, then every
// one of them with single bits flipped, then garbage with every leading byte. A difference anywhere is a change of behaviour.
// Usage: node twin-cores.mjs <coreA.wasm> <coreB.wasm>     (frame builders from this release's own test library)
import { randomBytes } from 'node:crypto'; import { readFileSync } from 'node:fs';
const T = new URL('../', import.meta.url).pathname;
const { blob, cat, deliver, dual, host, keyFields, owner, sha, text, timedGrant, u16, u64 } = await import(T + 'host.mjs');
const { safeControl } = await import(T + 'safe-fields.mjs'); const { bytes32, rawKeys } = await import(T + 'segments.mjs');
const fa = readFileSync(process.argv[2]), fb = readFileSync(process.argv[3]);
const quiet = f => { const l = console.log; console.log = () => {}; try { return f(); } finally { console.log = l; } };
let same = 0, diff = 0, admitted = 0, refused = 0, traps = 0; const notes = [];
const view = h => { const a = h.api; let s = bytes32(a.head).toString('hex') + '|' + bytes32(a.core).toString('hex'); for (const f of ['halted', 'ceiling']) if (typeof a[f] === 'function') { try { s += '|' + a[f](); } catch (e) { s += '|TRAP'; } } return s; };
const feed = (h, w) => { try { return h.consume(w, 'step'); } catch (e) { traps++; return 'TRAP ' + String(e.message).slice(0, 24); } };
const both = (label, A, B, w) => { const ra = feed(A, w), rb = feed(B, w), va = view(A), vb = view(B);
  if (ra === rb && va === vb) same++; else { diff++; if (notes.length < 12) notes.push(`${label}: verdict ${ra} / ${rb}; state ${va === vb ? 'same' : 'DIFFERENT'}`); }
  ra === 1 ? admitted++ : refused++; return ra; };
const keys = owner(), keys2 = owner(), K = rawKeys(keys), intent = deliver(Buffer.from('pay the supplier'), 0, 7);
const A = host(fa), B = host(fb);
if (A.consume(K, 'init') !== 1 || B.consume(K, 'init') !== 1) throw new Error('ordinary start refused');
if (view(A) !== view(B)) { diff++; notes.push('the two cores differ straight after the ordinary start'); } else same++;
const kinds = [
  ['timed approval', h => timedGrant(keys, h.header(), intent, 0, 400)],
  ['cancel', h => { const s = dual(keys, cat(text('AUKORA/R9/revoke'), keyFields(keys), u64(0), h.header(), sha(intent))); return cat(Buffer.of(25), h.header(), sha(intent), s.edSig, s.mlSig); }],
  ['threshold', h => { const s = dual(keys, cat(text('AUKORA/R8/threshold'), keyFields(keys), u64(0), h.header(), Buffer.of(64))); return cat(Buffer.of(22), h.header(), Buffer.of(64), s.edSig, s.mlSig); }],
  ['signed control', h => h.control(keys, cat(Buffer.of(10), text('service'), blob(Buffer.from('report')), u16(0), u16(2), u16(65535)), 0)],
  ['timed approval again', h => timedGrant(keys, h.header(), deliver(Buffer.from('second order'), 0, 9), 0, 900)],
  ['halt', h => safeControl(h, 50, keys, 0)],
  ['clear', h => safeControl(h, 51, keys, 0)],
  ['key change', h => safeControl(h, 53, keys, 0, { newKeys: keys2 })],
];
const flips = Number(process.argv[4] ?? 160);
for (const [name, make] of kinds) {
  const w = make(A);                                    // built from A's head; B is at the same head or the run has already failed
  for (let i = 0; i < flips; i++) { const m = Buffer.from(w); const p = i < 48 ? i : Math.floor(Math.random() * m.length); m[p] ^= 1 << (i % 8); both(`${name}, bit flipped at byte ${p}`, A, B, m); }
  for (const cut of [0, 1, 39, 40, 41, w.length - 1]) both(`${name}, cut to ${cut} bytes`, A, B, w.subarray(0, cut));
  both(`${name}, one byte appended`, A, B, cat(w, Buffer.of(0)));
  // as signed: A through the library's own submit (it asserts admission and keeps the head the next frame is built from), B the same bytes
  { let ra = 1; try { quiet(() => A.submit(name, w, true)); } catch (e) { ra = 'A did not admit: ' + String(e.message).slice(0, 40); }
    // CONTROL (fifth argument 'control'): B is given the third real frame with one signature bit flipped. The comparison must notice.
    const wb = (process.argv[5] === 'control' && name === 'threshold') ? (() => { const m = Buffer.from(w); m[m.length - 5] ^= 1; return m; })() : w;
    const rb = feed(B, wb), va = view(A), vb = view(B);
    if (ra === rb && va === vb) { same++; admitted++; } else { diff++; notes.push(`${name}, as signed: verdict ${ra} / ${rb}; state ${va === vb ? 'same' : 'DIFFERENT'}`); } }
  both(`${name}, replayed`, A, B, w);
}
for (let lead = 0; lead < 256; lead++) for (const n of [1, 41, 200, 3400]) { const g = randomBytes(n); g[0] = lead; both(`garbage with leading byte ${lead}, ${n} bytes`, A, B, g); }
for (const second of [0, 1, 2, 3, 4, 255]) for (let tag = 0; tag < 256; tag++) { const g = randomBytes(120); g[0] = 255; g[1] = second; g[2] = tag; both(`ff ${second} ${tag} garbage`, A, B, g); }
console.log(`${same} comparisons identical, ${diff} different; ${admitted} admitted, ${refused} refused, ${traps} traps`);
for (const n of notes) console.log('DIFFERENT  ' + n);
console.log(`final state identical: ${view(A) === view(B)}`); process.exit(diff || traps ? 1 : 0);
