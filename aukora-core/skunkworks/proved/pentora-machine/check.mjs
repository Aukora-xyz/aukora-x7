// The checker loads only the Wasm and computes expected machine outputs in separate JavaScript.
// Its cube search closely follows the Python generator. Lean checks the supplied tables.
// Usage: node check.mjs [control]        (control plants one wrong expectation; the run must then FAIL)
import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
const bytes = readFileSync(new URL('./pentora.wasm', import.meta.url)), mod = new WebAssembly.Module(bytes);
if (WebAssembly.Module.imports(mod).length) throw new Error('the file imports something');
const api = new WebAssembly.Instance(mod).exports, control = process.argv[2] === 'control';
// Find the cubes by exact distances, following gen.py.
const add = (x, y) => [x[0] + y[0], x[1] + y[1]], sub = (x, y) => [x[0] - y[0], x[1] - y[1]];
const mul = (x, y) => [x[0] * y[0] + x[1] * y[1], x[0] * y[1] + x[1] * y[0] + x[1] * y[1]], neg = x => [-x[0], -x[1]];
const ONE = [1, 0], ZERO = [0, 0], PHI = [0, 1], INV = [-1, 1], V = [];
for (const a of [1, -1]) for (const b of [1, -1]) for (const c of [1, -1]) V.push([a, b, c].map(s => (s > 0 ? ONE : neg(ONE))));
for (const s1 of [1, -1]) for (const s2 of [1, -1]) { const a = s1 > 0 ? INV : neg(INV), b = s2 > 0 ? PHI : neg(PHI); V.push([ZERO, a, b], [b, ZERO, a], [a, b, ZERO]); }
const d2 = (p, q) => p.map((x, i) => mul(sub(x, q[i]), sub(x, q[i]))).reduce(add).join(','), E = '4,0', F = '8,0', B = '12,0';
const found = new Map();
for (let i = 0; i < 20; i++) { const nb = [...Array(20).keys()].filter(j => d2(V[i], V[j]) === E);
  for (let a = 0; a < nb.length; a++) for (let b = a + 1; b < nb.length; b++) for (let c = b + 1; c < nb.length; c++) {
    const trio = [nb[a], nb[b], nb[c]]; if (![[0, 1], [0, 2], [1, 2]].every(([x, y]) => d2(V[trio[x]], V[trio[y]]) === F)) continue;
    const S = new Set([i, ...trio]); let grow = true;
    while (grow) { grow = false; for (let j = 0; j < 20; j++) if (!S.has(j) && [...S].filter(k => d2(V[j], V[k]) === E).length >= 2 && [...S].every(k => [E, F, B].includes(d2(V[j], V[k])))) { S.add(j); grow = true; } }
    if (S.size === 8) { const key = [...S].sort((x, y) => x - y); found.set(key.join(','), key); } } }
const cubes = [...found.values()].sort((x, y) => { for (let i = 0; i < 8; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
const owners = v => cubes.map((c, ci) => (c.includes(v) ? ci : -1)).filter(x => x >= 0);
let ok = 0, bad = 0; const notes = [];
const want = (label, got, expected) => { if (got === expected) ok++; else { bad++; if (notes.length < 8) notes.push(`${label}: got ${got}, wanted ${expected}`); } };
want('five cubes', cubes.length, 5);
for (let v = 0; v < 20; v++) want(`corner ${v} is in two cubes`, owners(v).length, 2);
for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) want(`cubes ${a},${b} share two corners`, cubes[a].filter(v => cubes[b].includes(v)).length, 2);
for (let c = 0; c < 5; c++) for (let j = 0; j < 8; j++) want(`vertex(${c},${j})`, api.vertex(c, j), cubes[c][j]);
for (let v = 0; v < 20; v++) { want(`owner(${v},0)`, api.owner(v, 0), owners(v)[0]); want(`owner(${v},1)`, api.owner(v, 1), owners(v)[1]); }
// Compute expected machine outputs from the JavaScript reports and cube indices.
let seed = 20261124; const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
const body = bias => ({ priv: Array.from({ length: 5 }, () => Array.from({ length: 18 }, () => (rnd(100) < bias ? 2 : rnd(3)))), corn: Array.from({ length: 20 }, () => (rnd(100) < bias ? 2 : rnd(3))) });
const views = g => cubes.map((c, ci) => [...g.priv[ci], ...c.map(v => g.corn[v])]);
const send = R => { api.reset(); for (const r of R) for (const x of r) if (api.input(x) !== 1) throw new Error('input refused'); };
const seamsOf = R => { let m = 0; for (let v = 0; v < 20; v++) { const [a, b] = owners(v); if (R[a][18 + cubes[a].indexOf(v)] !== R[b][18 + cubes[b].indexOf(v)]) m |= 1 << v; } return m >>> 0; };
const healthOf = r => (r.includes(0) ? 2 : r.includes(1) ? 1 : 0);
const suspectsOf = R => { const m = seamsOf(R); if (!m) return 0; let s = 0; for (let c = 0; c < 5; c++) { let all = true; for (let v = 0; v < 20; v++) if ((m >> v) & 1 && !owners(v).includes(c)) all = false; if (all) s |= 1 << c; } return s; };
const addressOf = g => { let n = 0n; const cells = [...g.priv.flat(), ...g.corn]; for (let i = cells.length - 1; i >= 0; i--) n = n * 3n + BigInt(cells[i]); return n; };
const unpack = n => { const cells = []; for (let i = 0; i < 110; i++) { cells.push(Number(n % 3n)); n /= 3n; } return cells; };
let agree = 0, liars = 0, convicted = 0, privateLies = 0, privateChanged = 0, heals = 0, hidden = 0, addresses = new Set(), distinct = new Set();
for (let round = 0; round < 400; round++) {
  const g = body([0, 60, 90, 100][round % 4]), R = views(g); send(R); agree++;
  const expected = R.reduce((acc, r, c) => acc + healthOf(r) * 3 ** c, 0);
  want('agreeing reports: verdict', api.judge() >>> 0, control && round === 7 ? expected + 1 : expected);
  want('agreeing reports: no seams', api.seams() >>> 0, 0); want('agreeing reports: no suspects', api.suspects() >>> 0, 0);
  let n = 0n; for (let i = 21; i >= 0; i--) n = n * 256n + BigInt(api.addressByte(i) >>> 0); want('address', n, addressOf(g));
  want('address unpacks to the body', unpack(n).join(''), [...g.priv.flat(), ...g.corn].join('')); addresses.add(n); distinct.add([...g.priv.flat(), ...g.corn].join(''));
  for (let c = 0; c < 5; c++) { const t = [0, 1, 2].map(k => api.tally(c, k)); want('triangle: counts add to 26', t[0] + t[1] + t[2], 26); want('tally', t.join(','), [0, 1, 2].map(k => R[c].filter(x => x === k).length).join(',')); }
  // one organ misreports some of its corners
  const x = rnd(5), L = R.map(r => [...r]), k = 1 + rnd(4);
  for (let i = 0; i < k; i++) { const j = rnd(8); L[x][18 + j] = (L[x][18 + j] + 1 + rnd(2)) % 3; }
  const lied = [...Array(8).keys()].filter(j => L[x][18 + j] !== R[x][18 + j]);
  if (lied.length) { send(L); liars++; const m = seamsOf(L);
    want('one liar: seams', api.seams() >>> 0, m); want('one liar: suspects', api.suspects() >>> 0, suspectsOf(L));
    want('one liar: every lied corner is a seam', lied.every(j => (m >>> cubes[x][j]) & 1), true);
    want('one liar: the liar is a suspect', (api.suspects() >> x) & 1, 1);
    want('one liar: verdict names the lowest disagreeing corner', api.judge() >>> 0, 256 + (31 - Math.clz32(m & -m)));
    want('one liar: no address is given', api.addressByte(0) >>> 0, 0xFFFFFFFF);
    const partners = new Set(lied.map(j => owners(cubes[x][j]).find(c => c !== x)));
    if (partners.size >= 2) { convicted++; want('two different neighbours convict the liar alone', api.suspects() >>> 0, 1 << x); }
    else want('one neighbour only: two suspects, the liar and that neighbour', api.suspects() >>> 0, (1 << x) | (1 << [...partners][0])); }
  want('seal', api.seal === undefined ? -1 : (send(R), api.seal() >>> 0), g.corn.reduce((a, x) => a + x, 0) % 3);
  want('centre', api.centre() >>> 0, Math.max(...R.map(healthOf)));
  if (lied.length) { send(L); let healed = 0; for (let v = 0; v < 20; v++) if ((api.heal(x, v) >>> 0) === g.corn[v]) healed++; heals++; want('four organs give back all 20 true corners', healed, 20); want('no seal while reports disagree', api.seal() >>> 0, 0xFFFFFFFF); }
  { const a = rnd(5), b = (a + 1 + rnd(4)) % 5, v = [...Array(20).keys()].find(u => owners(u).includes(a) && owners(u).includes(b)), g2 = { priv: g.priv, corn: g.corn.map((t, u) => (u === v ? (t + 1) % 3 : t)) }, R2 = views(g2);
    const three = [0, 1, 2, 3, 4].filter(c => c !== a && c !== b); hidden++;
    want('three organs see no difference', three.every(c => R2[c].join('') === R[c].join('')), true);
    send(R2); want('yet the seal differs', api.seal() >>> 0, (g.corn.reduce((s, t) => s + t, 0) + 1) % 3); }
  // Assign one private trit; count the assignments that change its value.
  const P = R.map(r => [...r]); const slot = rnd(18), trit = rnd(3); if (P[x][slot] !== trit) privateChanged++; P[x][slot] = trit; send(P); privateLies++; want('a private change makes no seam', api.seams() >>> 0, 0);
}
want('different bodies, different addresses', addresses.size, distinct.size);
let malformed = 0; for (const size of [0, 1, 129]) { api.reset(); for (let i = 0; i < size; i++) api.input(2); if ((api.judge() >>> 0) === 0xFFFFFFFF && (api.seams() >>> 0) === 0xFFFFFFFF && (api.addressByte(0) >>> 0) === 0xFFFFFFFF) malformed++; else bad++; }
api.reset(); for (let i = 0; i < 131; i++) api.input(2); if ((api.judge() >>> 0) === 0xFFFFFFFF) malformed++; else bad++;
api.reset(); for (let i = 0; i < 130; i++) api.input(i === 77 ? 3 : 2); if ((api.judge() >>> 0) === 0xFFFFFFFF) malformed++; else bad++;
api.reset(); for (let i = 0; i < 130; i++) api.input(2); want('all 110 cells passed: verdict 0', api.judge() >>> 0, 0); want('out-of-range address byte', api.addressByte(22) >>> 0, 0xFFFFFFFF);
console.log(`pentora.wasm ${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')}, imports 0, exports ${WebAssembly.Module.exports(mod).map(e => e.name).sort().join(',')}`);
console.log(`${agree} bodies agreed and addressed. In ${liars} corner-fault cases the faulty organ was a suspect, in ${convicted} the sole suspect. Of ${privateLies} private assignments, ${privateChanged} changed a trit and all preserved the zero seam mask. ${heals} corner-fault cases recovered the expected corners with the faulty index supplied. Each of ${hidden} selected triples saw identical reports for two different sums. Malformed inputs refused: ${malformed} of 5.`);
if (notes.length) console.log(notes.join('\n'));
console.log(`${ok} passed, ${bad} failed (Pentora Wasm check, malformed cases counted separately on success)`); process.exit(bad ? 1 : 0);
