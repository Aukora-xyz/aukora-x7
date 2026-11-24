import assert from 'node:assert/strict';
import { Core, newOwner } from '../../standalone/aukora.mjs';
import { exportBubble, openBubble } from '../bubble/bubble.mjs';
import { build, peaksOf, proveGrowth, proveNode, prune, rootCommit, rootOf,
  verifyGrowth, verifyNode } from './onion.mjs';

let passed = 0;
let failed = 0;
async function check(number, name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`PASS ${number}. ${name}${detail ? ': ' + detail : ''}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${number}. ${name}: ${String(error?.message ?? error).replace(/\s+/gu, ' ')}`);
  }
}

const recordOf = lines => 'aukora-record v0.1\n' + lines.join('\n') + '\n';
const commitOf = tree => rootCommit(rootOf(tree));
const bytes = Array.from({ length: 48 }, (_, i) =>
  Buffer.of([0, 0x13, 0x17, 0x18, 0xff][i % 5], i, 0x91).toString('hex'));
const record = n => recordOf(bytes.slice(0, n));
const tree = (n, classify) => build(record(n), classify);
const flip = (digest, i) => digest.slice(0, i) + (digest[i] === '0' ? '1' : '0') + digest.slice(i + 1);

await check(1, 'contiguous maximal power-of-two peaks at sizes 1–200', () => {
  for (let m = 1; m <= 200; m++) {
    let cursor = 0;
    let previous = Infinity;
    for (const [start, count] of peaksOf(m)) {
      assert.equal(start, cursor);
      assert.ok(Number.isInteger(Math.log2(count)));
      assert.equal(start % count, 0);
      assert.ok(count < previous);
      cursor += count;
      previous = count;
    }
    assert.equal(cursor, m);
  }
  assert.throws(() => peaksOf(0));
  assert.throws(() => peaksOf(1.5));
  assert.throws(() => peaksOf(Number.MAX_SAFE_INTEGER + 1));
});

await check(2, 'all real growth pairs through 40 lines', async () => {
  const core = await Core.load();
  core.init(newOwner());
  const commits = [];
  let previousLines = [];
  for (let n = 1; n <= 40; n++) {
    if (n > 1) assert.equal(core.say(`growth line ${n}`), true);
    const raw = core.exportRecord();
    const current = build(raw);
    const lines = raw.trimEnd().split('\n').slice(1);
    assert.equal(current.size, n);
    assert.deepEqual(lines.slice(0, n - 1), previousLines);
    const kept = commitOf(current);
    commits.push(kept);
    for (let m = 1; m <= n; m++) {
      assert.equal(verifyGrowth(commits[m - 1], m, kept, n, proveGrowth(current, m)), true,
        `real ${m}->${n}`);
    }
    previousLines = lines;
  }
});

let maxPeaks = 0;
let maxSteps = 0;
await check(3, 'all synthetic growth pairs through 48 lines', () => {
  const trees = Array.from({ length: 48 }, (_, i) => tree(i + 1));
  const commits = trees.map(commitOf);
  for (let n = 1; n <= 48; n++) {
    for (let m = 1; m <= n; m++) {
      const proof = proveGrowth(trees[n - 1], m);
      assert.equal(verifyGrowth(commits[m - 1], m, commits[n - 1], n, proof), true,
        `synthetic ${m}->${n}`);
      maxPeaks = Math.max(maxPeaks, proof.length);
      maxSteps = Math.max(maxSteps, proof.reduce((sum, peak) => sum + peak.path.length, 0));
    }
  }
});

await check(4, 'only the common prefix of two histories verifies', () => {
  const j = 7;
  const n = 19;
  const fork = bytes.slice(0, n);
  fork[j] = 'ffffab';
  const newer = build(recordOf(fork));
  const kept = commitOf(newer);
  for (let m = 1; m <= n; m++) {
    assert.equal(verifyGrowth(commitOf(tree(m)), m, kept, n, proveGrowth(newer, m)), m <= j,
      `fork at line ${j + 1}; old size ${m}`);
  }
});

const m = 13;
const n = 19;
const old = commitOf(tree(m));
const newer = tree(n);
const kept = commitOf(newer);
const proof = proveGrowth(newer, m);
const verifies = p => verifyGrowth(old, m, kept, n, p);
await check(5, 'peak and path tampering, including balanced totals, is refused', () => {
  assert.equal(verifies(proof), true);
  const edit = fn => {
    const p = structuredClone(proof);
    fn(p);
    assert.equal(verifies(p), false);
  };
  for (let i = 0; i < proof.length; i++) {
    for (let j = -1; j < proof[i].path.length; j++) {
      const node = p => j === -1 ? p[i] : p[i].path[j];
      for (let k = 0; k < 6; k++) edit(p => { node(p).totals[k]++; });
      for (let k = 0; k < 64; k++) edit(p => { node(p).digest = flip(node(p).digest, k); });
      if (j >= 0) edit(p => { node(p).side = node(p).side === 'L' ? 'R' : 'L'; });
    }
    edit(p => { p[i].start++; });
    edit(p => { p[i].count++; });
    edit(p => { p[i].path.shift(); });
    edit(p => { p[i].path.push(structuredClone(p[i].path[0])); });
  }
  edit(p => { [p[0], p[1]] = [p[1], p[0]]; });
  edit(p => { p.splice(1, 1); });
  edit(p => { p.splice(1, 0, structuredClone(p[0])); });
  // Byte totals remain well-formed individually; the grand total does not move.
  edit(p => {
    const sum = p[0].totals[1] + p[1].totals[1];
    p[0].totals[1]++;
    p[1].totals[1]--;
    assert.equal(p[0].totals[1] + p[1].totals[1], sum);
    assert.ok(p[1].totals[1] >= p[1].count);
  });
});

await check(6, 'wrong or invalid sizes do not verify', () => {
  for (const [oldSize, newSize] of [[n + 1, n], [0, n], [m, n - 1], [m + 1, n], [m, n + 1],
    [m + 0.5, n], [m, Infinity]]) {
    assert.equal(verifyGrowth(old, oldSize, kept, newSize, proof), false);
  }
  assert.throws(() => proveGrowth(newer, n + 1));
  const node = proveNode(newer, 0, 8);
  assert.equal(verifyNode(kept, node, 0, 8, n, node.path), true);
  assert.equal(verifyNode(kept, node, 1, 8, n, node.path), false);
  assert.throws(() => proveNode(newer, 1, 8));
});

await check(7, 'equal sizes verify against equal commitments', () => {
  for (const n of [1, 8, 13, 48]) {
    const a = tree(n);
    const old = commitOf(a);
    const newer = commitOf(tree(n));
    assert.equal(old, newer);
    assert.equal(verifyGrowth(old, n, newer, n, proveGrowth(a, n)), true);
  }
});

await check(8, 'custom classification matches only a matching old prefix', () => {
  const a = (_, i) => i === 0 ? 5 : 3;
  const b = (_, i) => i === 0 ? 5 : 4;
  const custom = tree(n, a);
  const p = proveGrowth(custom, m);
  assert.equal(verifyGrowth(commitOf(tree(m, a)), m, commitOf(custom), n, p), true);
  assert.equal(verifyGrowth(commitOf(tree(m, b)), m, commitOf(custom), n, p), false);
});

await check(9, 'opaque peaks and pruned descendants and siblings work; pruned ancestors refuse', () => {
  for (const [start, count] of [[0, 8], [2, 2], [16, 2]]) {
    const pruned = prune(newer, start, count);
    assert.equal(commitOf(pruned), kept);
    const p = proveGrowth(pruned, m);
    assert.equal(verifies(p), true, `pruned ${start}:${count}`);
    const node = proveNode(pruned, 0, 8);
    assert.equal(verifyNode(kept, node, 0, 8, n, node.path), true);
  }
  const hidden = prune(newer, 0, 16);
  assert.throws(() => proveNode(hidden, 0, 8), /ancestor is pruned/);
  assert.throws(() => proveGrowth(hidden, m), /ancestor is pruned/);
  const whole = prune(newer, 0, n);
  assert.throws(() => proveGrowth(whole, n), /ancestor is pruned/);
  const power = tree(16);
  const powerCommit = commitOf(power);
  assert.equal(verifyGrowth(powerCommit, 16, powerCommit, 16,
    proveGrowth(prune(power, 0, 16), 16)), true);
});

await check(10, 'old and fresh bubbles disclose identical lines and totals across proved growth', () => {
  const earlier = tree(m);
  const region = [4, 4];
  const oldBubble = openBubble(old, exportBubble(earlier, record(m), ...region));
  assert.ok(oldBubble);
  assert.equal(verifies(proof), true);
  const freshBubble = openBubble(kept, exportBubble(newer, record(n), ...region));
  assert.ok(freshBubble);
  assert.deepEqual(freshBubble, oldBubble);
});

await check(11, 'proof-size maxima over all pairs through 48 lines', () => {
  assert.ok(maxPeaks > 0 && maxSteps > 0);
  return `largest peak count ${maxPeaks}; largest total path steps ${maxSteps}`;
});
console.log(`${passed} passed, ${failed} failed`);
if (failed !== 0) process.exitCode = 1;
