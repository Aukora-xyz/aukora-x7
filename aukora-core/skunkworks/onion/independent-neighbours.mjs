// An independent check: one question the piece-4 tests do not ask. Two regions that are direct neighbours under one parent are BOTH removed.
// Can someone move totals from one to the other (same sum) and still match the root that a reader kept?
// Usage: node independent-neighbours.mjs [path to onion.mjs]     prints HOLE if the lie goes unnoticed, BOUND if it is caught.
const { build, prune, rootOf } = await import(process.argv[2] ? new URL(process.argv[2], 'file://' + process.cwd() + '/').href : new URL('./onion.mjs', import.meta.url).href);
const rootCommit = (await import(process.argv[2] ? new URL(process.argv[2], 'file://' + process.cwd() + '/').href : new URL('./onion.mjs', import.meta.url).href)).rootCommit;
const asRecord = bytes => 'aukora-record v0.1\n' + bytes.map(b => b.toString('hex')).join('\n') + '\n';
// 8 lines: the left half holds 3 acts (0x17), the right half holds none.
const lines = [[0xff, 0, 1], [0x17, 1, 1], [0x17, 2, 1], [0x17, 3, 1], [0, 4, 1], [0, 5, 1], [0, 6, 1], [0, 7, 1]].map(b => Buffer.from(b));
const t = build(asRecord(lines)), kept = rootOf(t), keptOne = rootCommit ? rootCommit(kept) : null;
const both = prune(prune(t, 0, 4), 4, 4);                       // left half and right half removed separately: two opaque neighbours
console.log('honest view  left', JSON.stringify(both.root.left.totals), ' right', JSON.stringify(both.root.right.totals), ' root', JSON.stringify(kept.totals));
const lie = structuredClone(both);                              // move the 3 acts (index 4) from the left region to the right region; speech (index 2) the other way
lie.root.left.totals[4] -= 3; lie.root.left.totals[2] += 3; lie.root.right.totals[4] += 3; lie.root.right.totals[2] -= 3;
let seen; try { const r = rootOf(lie); seen = r.digest === kept.digest && JSON.stringify(r.totals) === JSON.stringify(kept.totals) && (!rootCommit || rootCommit(r) === keptOne); } catch (e) { seen = false; }
console.log('lying view   left', JSON.stringify(lie.root.left.totals), ' right', JSON.stringify(lie.root.right.totals));
console.log(seen ? 'HOLE: the lying view matches the kept root. The split of totals between two removed neighbours is not bound.' : 'BOUND: the lying view does not match the kept root.');
// Sweep: every size up to 33, every parent whose two children are both removed, every one-unit move between them in bytes and in each counter.
let tried = 0, unnoticed = 0; const synth = n => Array.from({ length: n }, (_, i) => Buffer.of([0, 0x13, 0x18, 0x17, 0xff][i % 5], i, 0x5a, ...Array(i % 3).fill(7)));
function* parents(start, size) { if (size === 1) return; let k = 1; while (k * 2 < size) k *= 2; yield [start, k, size - k]; yield* parents(start, k); yield* parents(start + k, size - k); }
for (let n = 2; n <= 33; n++) { const tr = build(asRecord(synth(n))), keep = rootOf(tr), keepOne = rootCommit ? rootCommit(keep) : keep.digest;
  for (const [start, k, rest] of parents(0, n)) { const two = prune(prune(tr, start, k), start + k, rest);
    const find = (node, lo, width) => { if (lo === start && width === k + rest) return node; let j = 1; while (j * 2 < width) j *= 2; return start < lo + j ? find(node.left, lo, j) : find(node.right, lo + j, width - j); };
    for (const [a, b] of [[1, 1], [2, 3], [3, 4], [4, 5], [5, 2], [2, 4]]) for (const d of [1, -1]) { const x = structuredClone(two), p = find(x.root, 0, n);
      p.left.totals[a] += d; p.right.totals[a] -= d; if (a !== b || a === 1) { if (a !== 1) { p.left.totals[b] -= d; p.right.totals[b] += d; } }
      tried++; let r; try { r = rootOf(x); } catch { continue; }
      if ((rootCommit ? rootCommit(r) : r.digest) === keepOne && JSON.stringify(r.totals) === JSON.stringify(keep.totals)) unnoticed++; } } }
console.log(`sweep: ${tried} balanced moves between two removed neighbours, sizes 2 to 33: ${unnoticed} went unnoticed`);
process.exit(seen || unnoticed ? 1 : 0);
