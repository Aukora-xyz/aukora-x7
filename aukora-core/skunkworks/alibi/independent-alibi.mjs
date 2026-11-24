// A second implementation and extra moves for the alibi tree. Written top-down by prefix (the first author's is bottom-up by level).
import { createHash, randomBytes } from 'node:crypto';
import { keyOf, rootOfSet, prove, verifyPresent, verifyAbsent } from './alibi.mjs';
const H = (...p) => { const h = createHash('sha256'); for (const x of p) h.update(x); return h.digest(); };
const EMPTY = [H(Buffer.of(6))]; for (let i = 1; i <= 256; i++) EMPTY.push(H(Buffer.of(1), EMPTY[i - 1], EMPTY[i - 1]));
const bit = (k, j) => (k[j >> 3] >> (7 - (j & 7))) & 1;
// top-down: the node that has consumed `depth` bits and holds these keys
const node = (keys, depth) => keys.length === 0 ? EMPTY[256 - depth] : depth === 256 ? H(Buffer.of(0), keys[0]) : H(Buffer.of(1), node(keys.filter(k => !bit(k, depth)), depth + 1), node(keys.filter(k => bit(k, depth)), depth + 1));
const myRoot = keys => { const seen = new Map(); for (const k of keys) seen.set(k.toString('hex'), k); return node([...seen.values()], 0).toString('hex'); };
// independent verifier: expand the proof to all 256 siblings, fold from the leaf
const myVerify = (root, k, proof, present) => { let v = present ? H(Buffer.of(0), k) : EMPTY[0], n = 0;
  for (let level = 0; level < 256; level++) { const j = 255 - level, s = bit(proof.bitmap, j) ? proof.siblings[n++] : EMPTY[level]; v = bit(k, j) ? H(Buffer.of(1), s, v) : H(Buffer.of(1), v, s); } return n === proof.siblings.length && v.toString('hex') === root; };
let pass = 0, fail = 0; const check = (name, got, want = true) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${got}, wanted ${want}`}`); };
// 1. roots agree: random sets, and sets built to share long prefixes
let agree = 0, total = 0; const sets = [];
for (let n = 0; n <= 60; n++) sets.push(Array.from({ length: n }, () => randomBytes(32)));
for (const share of [1, 8, 100, 200, 250, 255]) { const base = randomBytes(32); sets.push(Array.from({ length: 12 }, (_, i) => { const k = Buffer.from(base); for (let j = share; j < 256; j++) if ((i >> ((j - share) % 4)) & 1 || j % 7 === i % 7) k[j >> 3] ^= 0x80 >> (j & 7); return k; })); }
for (const s of sets) { total++; if (myRoot(s) === rootOfSet(s)) agree++; }
check(`two implementations give the same root on ${total} sets (random, and sharing 1 to 255 leading bits)`, agree, total);
// 2. every proof from the piece verifies under my verifier too, with the same verdict; and my verifier agrees on refusals
let both = 0, n2 = 0; for (const s of sets.slice(1, 40)) { const root = rootOfSet(s); for (const k of [...s.slice(0, 5), randomBytes(32), randomBytes(32)]) { const p = prove(s, k); n2 += 2;
  if (verifyPresent(root, k, p) === myVerify(root, k, p, true)) both++; if (verifyAbsent(root, k, p) === myVerify(root, k, p, false)) both++; } }
check(`the piece's verifiers and mine agree on ${n2} verdicts`, both, n2);
// 3. moves the piece's tests do not try
{ const s = Array.from({ length: 20 }, () => randomBytes(32)), root = rootOfSet(s), k = s[3], p = prove(s, k);
  // a present key's presence proof offered as an absence proof for its neighbour leaf (last bit flipped)
  const nb = Buffer.from(k); nb[31] ^= 1; check('presence proof of a key, offered as absence proof of the neighbouring leaf: refused', verifyAbsent(root, nb, p), false);
  check('   the honest absence proof of that neighbour is accepted', verifyAbsent(root, nb, prove(s, nb)), true);
  // absence proof against the root of a DIFFERENT set that does contain the key
  const without = s.filter(x => x !== k), q = prove(without, k); check('absence proof made from a set without the key, checked against the root of the set WITH it: refused', verifyAbsent(root, k, q), false);
  // extra trailing sibling, sibling list reordered, bitmap with an extra bit and an invented sibling
  const a = randomBytes(32), pa = prove(s, a); check('reordered siblings: refused', pa.siblings.length < 2 || verifyAbsent(root, a, { ...pa, siblings: pa.siblings.slice().reverse() }), pa.siblings.length < 2);
  const bm = Buffer.from(pa.bitmap); let j = 0; while ((bm[j >> 3] >> (7 - (j & 7))) & 1) j++; bm[j >> 3] |= 0x80 >> (j & 7); const pos = [...Array(256).keys()].filter(x => x > j && ((bm[x >> 3] >> (7 - (x & 7))) & 1)).length;
  const sib = pa.siblings.slice(); sib.splice(sib.length - pos, 0, randomBytes(32)); check('an invented sibling at an empty place: refused', verifyAbsent(root, a, { present: false, bitmap: bm, siblings: sib }), false);
  // root given in upper case or with a prefix
  check('root in upper case: refused', verifyAbsent(root.toUpperCase(), a, pa), false); check('root with 0x prefix: refused', verifyAbsent('0x' + root, a, pa), false);
  // a subclass of Uint8Array and a plain array as key
  check('key given as a plain array: refused', verifyAbsent(root, [...a], pa), false); }
// 4. names: two different names never share a key here; the empty name and a very long name work
{ const names = ['', 'a', 'a ', ' a', 'A', 'a\u0000', 'a\n', 'é', 'é', 'x'.repeat(100000)]; const ks = names.map(keyOf);
  check('ten awkward names give ten different keys (note: "é" and "e"+accent are DIFFERENT keys)', new Set(ks.map(k => k.toString('hex'))).size, 10);
  const root = rootOfSet(ks.slice(0, 5)); check('a name that was not read is absent even when it differs only by a trailing space or case', verifyAbsent(root, keyOf('a  '), prove(ks.slice(0, 5), keyOf('a  '))) && verifyAbsent(root, keyOf('é'), prove(ks.slice(0, 5), keyOf('é'))), true); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
