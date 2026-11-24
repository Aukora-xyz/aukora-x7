// An independent check: moves the bubble tests do not try. Lab only.
import { Core, newOwner } from '../../standalone/aukora.mjs';
import { build, prune, rootOf, rootCommit } from '../onion/onion.mjs';
import { exportBubble, encodeBubble, decodeBubble, openBubble, returnBubble } from './bubble.mjs';
let pass = 0, fail = 0; const check = (name, got, want = true) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`); };
const commit = t => rootCommit(rootOf(t)); const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rec = async (tag, n) => { const c = await Core.load(); c.init(newOwner()); for (let i = 0; i < n; i++) c.say(`${tag} ${i}`); return c; };
const A = await rec('alpha', 31), recA = A.exportRecord(), tA = build(recA), kA = commit(tA);     // 32 lines with the genesis line
const B = await rec('beta', 31), recB = B.exportRecord(), tB = build(recB), kB = commit(tB);
// 1. graft: record B's lines carried on record A's path, and the reverse
{ const a = exportBubble(tA, recA, 8, 8), b = exportBubble(tB, recB, 8, 8);
  check('graft: B\'s lines on A\'s path do not open against A', openBubble(kA, { ...a, lines: b.lines }), null);
  check('graft: A\'s lines on B\'s path do not open against A', openBubble(kA, { ...b, lines: a.lines }), null);
  check('a bubble of A does not open against B', openBubble(kB, a), null); }
// 2. two regions leave; they come back in either order; the tree is the original
{ const x = exportBubble(tA, recA, 0, 8), y = exportBubble(tA, recA, 16, 16); const gone = prune(prune(tA, 0, 8), 16, 16);
  check('two regions gone: commitment unchanged', commit(gone), kA);
  check('return x then y restores the tree', same(returnBubble(returnBubble(gone, x), y), tA));
  check('return y then x restores the tree', same(returnBubble(returnBubble(gone, y), x), tA));
  let twice = 'no error'; try { returnBubble(returnBubble(gone, x), x); } catch (e) { twice = 'refused'; } check('returning the same bubble twice is refused', twice, 'refused'); }
// 3. nested: a small region cannot return while the larger region around it is still gone
{ const inner = exportBubble(tA, recA, 4, 4), gone = prune(tA, 0, 8); let r = 'no error'; try { returnBubble(gone, inner); } catch (e) { r = 'refused'; }
  check('a region inside a larger missing region cannot return by itself', r, 'refused');
  check('   but it still OPENS for a reader who kept the commitment', openBubble(kA, inner) !== null); }
// 4. re-export after return gives the identical text
{ const x = exportBubble(tA, recA, 8, 8), back = returnBubble(prune(tA, 8, 8), x); check('export, leave, return, export again: identical text', encodeBubble(exportBubble(back, recA, 8, 8)), encodeBubble(x)); }
// 5. THE LIMIT: the record grows by one line. The old bubble opens against the OLD commitment only.
{ const x = exportBubble(tA, recA, 8, 8); A.say('one more line'); const grown = build(A.exportRecord()), kNew = commit(grown);
  check('LIMIT: after the record grows, a bubble exported earlier does not open against the new commitment', openBubble(kNew, x), null);
  check('   it still opens against the commitment kept when it was exported', openBubble(kA, x) !== null);
  check('   a fresh export of the same region from the grown record opens against the new commitment', openBubble(kNew, exportBubble(grown, A.exportRecord(), 8, 8)) !== null); }
// 6. what a bubble gives away about the rest: the totals of every sibling region on its path
{ const x = exportBubble(tA, recA, 8, 8); const seen = x.path.map(s => s.totals[0]); check('LIMIT: the holder learns the line counts of the sibling regions on the path', seen.join('+'), '8+16'); }
// 7. hostile shapes straight into openBubble
for (const [name, bad] of [['null', null], ['an array', []], ['a string', 'x'], ['lines as one string', { v: 1, size: 32, start: 8, count: 8, lines: 'aa', path: [] }], ['count 0', { v: 1, size: 32, start: 8, count: 0, lines: [], path: [] }], ['v 2', { ...exportBubble(tA, recA, 8, 8), v: 2 }], ['a getter field', Object.defineProperty({ ...exportBubble(tA, recA, 8, 8) }, 'v', { get() { return 1; }, enumerable: true })]])
  check(`hostile input (${name}) -> null, no throw`, (() => { try { return openBubble(kA, bad); } catch { return 'THREW'; } })(), null);
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
