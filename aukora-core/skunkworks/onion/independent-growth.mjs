// An independent check: does the onion's growth proof AGREE with a completely separate mechanism?
// Mechanism 1: the onion (a tree of totals), growth proof by peaks (piece 7).
// Mechanism 2: the record's own RFC 6962 tree, consistency proof, judged by the existing minimal verifier, unchanged and pinned.
// For every pair of sizes and every fork point the two must give the same answer: "extends" or "does not".
import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto'; import { spawnSync } from 'node:child_process';
import { leafHashes, treeHead, consistencyProof } from '../../standalone/checkpoint.mjs';
import { build, rootOf, rootCommit, proveGrowth, verifyGrowth, peaksOf, proveNode, verifyNode } from './onion.mjs';
const VERIFIER = new URL('../../context-membrane/verify.py', import.meta.url).pathname;
if (createHash('sha256').update(readFileSync(VERIFIER)).digest('hex') !== '039aa8999f9a1e1a8b8e01eb51598bfc546e4e574b2c9333f13e8bb303958089') throw new Error('the verifier is not the pinned file');
let pass = 0, fail = 0; const check = (name, got, want = true) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`); };
const rec = lines => 'aukora-record v0.1\n' + lines.join('\n') + '\n'; const hex = b => b.toString('hex'); const commit = t => rootCommit(rootOf(t));
const line = (tag, i) => Buffer.of([0, 0x13, 0x17, 0x18, 0xff][i % 5], i, tag, ...Array(i % 4).fill(tag)).toString('hex');
const N = 26, A = Array.from({ length: N }, (_, i) => line(1, i));
// histories that share exactly j lines with A, for several j
const cases = [], onion = [];
for (const j of [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 25, 26]) { const B = A.map((l, i) => i < j ? l : line(2, i));
  for (let n = 1; n <= N; n++) { const tB = build(rec(B.slice(0, n))), kB = commit(tB), hB = leafHashes(rec(B.slice(0, n)));
    for (let m = 1; m <= n; m++) { const kA = commit(build(rec(A.slice(0, m)))), hA = leafHashes(rec(A.slice(0, m)));
      onion.push(verifyGrowth(kA, m, kB, n, proveGrowth(tB, m)));
      cases.push({ j, m, n, r1: hex(treeHead(hA)), r2: hex(treeHead(hB)), proof: consistencyProof(m, hB).map(hex) }); } } }
const driver = 'import sys,json,importlib.util\nspec=importlib.util.spec_from_file_location("v",sys.argv[1]);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)\nprint(json.dumps([v.verify_consistency(c["m"],c["n"],c["r1"],c["r2"],c["proof"])[0] for c in json.load(sys.stdin)]))';
const other = JSON.parse(spawnSync('python3', ['-I', '-c', driver, VERIFIER], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 27 }).stdout);
let agree = 0, truth = 0, extends_ = 0; cases.forEach((c, i) => { const really = c.m <= c.j; if (really) extends_++; if (onion[i] === really) truth++; if ((other[i] === 'APPEND_ONLY') === onion[i]) agree++; });
check(`the onion's verdict equals the plain truth (first m lines identical) on ${cases.length} cases`, truth, cases.length);
check(`the onion and the unchanged minimal verifier agree on all ${cases.length} cases (${extends_} extend, ${cases.length - extends_} do not)`, agree, cases.length);
check('the minimal verifier never says APPEND_ONLY for a history that does not extend', cases.filter((c, i) => c.m > c.j && other[i] === 'APPEND_ONLY').length, 0);
// moves the piece's tests do not try
{ const tB = build(rec(A.slice(0, 19))), kB = commit(tB), tA = build(rec(A.slice(0, 13))), kA = commit(tA), good = proveGrowth(tB, 13);
  const C = A.map((l, i) => i < 5 ? l : line(3, i)), tC = build(rec(C.slice(0, 19))), kC = commit(tC), fromC = proveGrowth(tC, 13);
  check('a proof whose PEAKS come from the true record and whose PATHS come from a forked one is refused', verifyGrowth(kA, 13, kC, 19, good.map((p, i) => ({ ...p, path: fromC[i].path }))), false);
  check('a proof made for 13 -> 19, presented for 12 -> 19 or 13 -> 20, is refused', verifyGrowth(commit(build(rec(A.slice(0, 12)))), 12, kB, 19, good) || verifyGrowth(kA, 13, commit(build(rec(A.slice(0, 20)))), 20, good), false);
  check('old and new commitments swapped: refused', verifyGrowth(kB, 13, kA, 19, good), false);
  const tD = build(rec(A.slice(0, 26))), kD = commit(tD);
  check('growth composes: 13 -> 19 and 19 -> 26 hold, and so does 13 -> 26', verifyGrowth(kA, 13, kB, 19, good) && verifyGrowth(kB, 19, kD, 26, proveGrowth(tD, 19)) && verifyGrowth(kA, 13, kD, 26, proveGrowth(tD, 13)), true);
  const node = proveNode(tB, 8, 4); check('a node proof for one place, offered for another place of the same width: refused', verifyNode(kB, node, 12, 4, 19, node.path), false);
  check('hostile inputs give false, never a throw', (() => { try { return [null, [], 'x', [{}], good.map(() => null)].some(p => verifyGrowth(kA, 13, kB, 19, p)) || verifyGrowth(null, 13, kB, 19, good) || verifyGrowth(kA, '13', kB, 19, good); } catch { return 'THREW'; } })(), false);
  let sizes = 0; for (let m = 1; m <= 4096; m++) sizes = Math.max(sizes, peaksOf(m).length); check('peaks stay few: at most 12 for any size up to 4,096', sizes <= 12); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
