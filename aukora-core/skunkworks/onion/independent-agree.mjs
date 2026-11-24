// An independent check: do the first author's piece 4b and an independent amendment give the SAME fingerprints? Two hands, one formula.
// Also: is the first author's new test able to fail? Run its sibling sweep against the ORIGINAL piece 4 and count what it would have caught.
const D = await import('./onion.mjs'), M = await import('./onion-amended.mjs'), O = await import('./onion-as-posted.mjs');
const asRecord = bytes => 'aukora-record v0.1\n' + bytes.map(b => b.toString('hex')).join('\n') + '\n';
const synth = n => Array.from({ length: n }, (_, i) => Buffer.of([0, 0x13, 0x18, 0x17, 0xff][i % 5], i, 0x5a, ...Array(i % 4).fill(9)));
const cls = (b, i) => 2 + ((b[0] + i) % 4); let same = 0, n = 0, pruneSame = 0, pn = 0;
for (let size = 1; size <= 80; size++) for (const c of [undefined, cls]) { const rec = asRecord(synth(size)); const a = D.rootOf(D.build(rec, c)), b = M.rootOf(M.build(rec, c)); n++;
  if (D.rootCommit(a) === M.rootCommit(b) && a.digest === b.digest && JSON.stringify(a.totals) === JSON.stringify(b.totals)) same++;
  if (size >= 4) { let k = 1; while (k * 2 < size) k *= 2; pn++; if (D.rootCommit(D.rootOf(D.prune(D.build(rec, c), 0, k))) === M.rootCommit(M.rootOf(M.prune(M.build(rec, c), 0, k)))) pruneSame++; } }
console.log(`two implementations, sizes 1 to 80, default and custom counters: ${same} of ${n} roots identical; ${pruneSame} of ${pn} identical after forgetting a region`);
// The original piece 4 (parent commits to the sum only): how many of the balanced moves in the first author's new sweep would it have let through?
let tried = 0, through = 0; const plain = n => Array.from({ length: n }, (_, i) => Buffer.of([0, 0x13, 0x18, 0x17, 0xff][i % 5], i, 0x5a));
function* parents(start, size) { if (size === 1) return; let k = 1; while (k * 2 < size) k *= 2; yield [start, k, size - k]; yield* parents(start, k); yield* parents(start + k, size - k); }
for (let size = 2; size <= 33; size++) { const t = O.build(asRecord(plain(size))), keep = O.rootOf(t);
  for (const [start, k, rest] of parents(0, size)) { const two = O.prune(O.prune(t, start, k), start + k, rest);
    for (const d of [1, -1]) { const x = structuredClone(two); let node = x.root, pos = 0, w = size; while (pos !== start || w !== k + rest) { let j = 1; while (j * 2 < w) j *= 2; if (start < pos + j) { node = node.left; w = j; } else { node = node.right; pos += j; w -= j; } }
      node.left.totals[1] += d; node.right.totals[1] -= d; tried++; let r; try { r = O.rootOf(x); } catch { continue; } if (r.digest === keep.digest && JSON.stringify(r.totals) === JSON.stringify(keep.totals)) through++; } } }
console.log(`negative control: the same byte moves against the ORIGINAL piece 4: ${through} of ${tried} would have gone unnoticed (so the new test can fail, and would have)`);
process.exit(same === n && pruneSame === pn && through > 0 ? 0 : 1);
