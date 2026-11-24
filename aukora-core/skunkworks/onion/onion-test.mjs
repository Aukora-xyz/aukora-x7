import assert from 'node:assert/strict';
import { Core, newOwner } from '../../standalone/aukora.mjs';
import { checkpoint } from '../../standalone/checkpoint.mjs';
import { build, prove, verifyLeaf, prune, reattach, rootOf, rootCommit } from './onion.mjs';

let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e.stack ?? e)); }
}

const asRecord = bytes => 'aukora-record v0.1\n' + bytes.map(b => b.toString('hex')).join('\n') + '\n';
const synth = n => Array.from({ length: n }, (_, i) => Buffer.of([0, 0x13, 0x18, 0x17, 0xff][i % 5], i, 0x5a));
function* regions(start, size) {
  yield [start, size];
  if (size === 1) return;
  let k = 1;
  while (k * 2 < size) k *= 2;
  yield* regions(start, k);
  yield* regions(start + k, size - k);
}

let core, record, before, lines, tree, root;
await check('real standalone export: independent six-counter recount', async () => {
  core = await Core.load();
  const owner = newOwner();
  core.init(owner);
  for (let i = 0; i < 40; i++) assert.equal(core.say('onion fixture ' + i), true);
  const intent = { payload: 'record-only fixture', audience: 'local test', nonce: 1 };
  assert.equal(core.grant(owner, intent), true);
  assert.equal(core.act(intent), true); // records admission; no external effect
  record = core.exportRecord();
  before = checkpoint(record);
  lines = record.trimEnd().split('\n').slice(1).map(l => Buffer.from(l, 'hex'));
  tree = build(record);
  root = rootOf(tree);
  const counts = { lines: 0, bytes: 0, speech: 0, approval: 0, act: 0, other: 0 };
  for (const [i, bytes] of lines.entries()) {
    counts.lines++;
    counts.bytes += bytes.length;
    if (!i) counts.other++;
    else switch (bytes.readUInt8()) {
      case 0: counts.speech++; break;
      case 0x13: case 0x18: counts.approval++; break;
      case 0x17: counts.act++; break;
      default: counts.other++;
    }
  }
  assert.deepEqual(root.totals, Object.values(counts));
  assert.equal(root.totals[0], 43);
  assert.deepEqual(root.totals.slice(2), [40, 1, 1, 1]);
});
await check('every real leaf verifies; a changed byte, index or root total does not', () => {
  for (const [i, bytes] of lines.entries()) {
    const path = prove(tree, i);
    assert.equal(verifyLeaf(root, bytes, i, tree.size, path), true, 'line ' + i);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    assert.equal(verifyLeaf(root, changed, i, tree.size, path), false, 'line ' + i);
  }
  assert.equal(verifyLeaf(root, lines[0], 1, tree.size, prove(tree, 0)), false);
  const wrongRoot = structuredClone(root);
  wrongRoot.totals[1]++;
  assert.equal(verifyLeaf(wrongRoot, lines[0], 0, tree.size, prove(tree, 0)), false);
});
await check('balanced but changed sibling totals refuse', () => {
  const bytes = synth(8), t = build(asRecord(bytes)), kept = rootOf(t), path = prove(t, 0);
  assert.equal(verifyLeaf(kept, bytes[0], 0, 8, path), true);
  const altered = structuredClone(path);
  altered[0].totals[1]++;
  altered[1].totals[1]--;
  assert.equal(altered.reduce((sum, s) => sum + s.totals[1], bytes[0].length), kept.totals[1]);
  assert.equal(verifyLeaf(kept, bytes[0], 0, 8, altered), false);
});
await check('negative, fractional and too-large sibling totals refuse even when balanced', () => {
  const bytes = synth(8), t = build(asRecord(bytes)), kept = rootOf(t), path = prove(t, 0);
  const combined = path[0].totals[1] + path[1].totals[1];
  for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const altered = structuredClone(path);
    altered[0].totals[1] = bad;
    altered[1].totals[1] = combined - bad;
    assert.equal(altered[0].totals[1] + altered[1].totals[1], combined);
    assert.equal(verifyLeaf(kept, bytes[0], 0, 8, altered), false, String(bad));
  }
});
await check('all exact subtrees of sizes 1 through 65 prune and restore, reject changed and reversed lines', () => {
  for (let n = 1; n <= 65; n++) {
    const bytes = synth(n), t = build(asRecord(bytes)), kept = rootOf(t);
    for (const [start, count] of regions(0, n)) {
      const label = 'size=' + n + ' start=' + start + ' count=' + count;
      const reduced = prune(t, start, count);
      assert.deepEqual(rootOf(reduced), kept, label);
      assert.equal(reduced.size, n, label);
      assert.throws(() => prove(reduced, start), /pruned/, label);
      const outside = start > 0 ? 0 : start + count;
      if (outside < n) {
        assert.equal(verifyLeaf(kept, bytes[outside], outside, n, prove(reduced, outside)), true, label);
      }
      const exact = bytes.slice(start, start + count);
      assert.deepEqual(reattach(reduced, start, exact), t, label);
      const changed = exact.slice();
      changed[0] = Buffer.from(changed[0]);
      changed[0][2] ^= 1;
      assert.throws(() => reattach(reduced, start, changed), /does not match/, label);
      if (count > 1) {
        assert.throws(() => reattach(reduced, start, exact.slice().reverse()), /does not match/, label);
      }
    }
  }
});
await check('tampered non-root pruned totals change the digest; whole-root totals must be compared too', () => {
  const bytes = synth(8), t = build(asRecord(bytes)), kept = rootOf(t);
  const region = structuredClone(prune(t, 0, 4));
  region.root.left.totals[1]++;
  assert.notEqual(rootOf(region).digest, kept.digest);
  assert.equal(verifyLeaf(kept, bytes[4], 4, 8, prove(region, 4)), false);
  const whole = structuredClone(prune(t, 0, 8));
  whole.root.totals[1]++;
  assert.equal(rootOf(whole).digest, kept.digest);
  assert.notDeepEqual(rootOf(whole), kept);
});
await check('non-subtree, unpruned, hidden, and malformed ranges refuse', () => {
  const bytes = synth(8), t = build(asRecord(bytes));
  assert.throws(() => prune(t, 1, 2), /not exactly one subtree/);
  assert.throws(() => prune(t, 2, 4), /not exactly one subtree/);
  assert.throws(() => prune(t, 6, 3), /outside tree/);
  assert.throws(() => prune(t, 0, 0), /outside tree/);
  assert.throws(() => reattach(t, 0, bytes.slice(0, 4)), /not pruned/);
  assert.throws(() => reattach(prune(t, 0, 4), 0, bytes.slice(0, 2)), /not an exposed subtree/);
});
await check('malformed records and incorrectly shaped proofs refuse', () => {
  assert.throws(() => build('wrong header\n0011\n'), /record/);
  assert.throws(() => build('aukora-record v0.1\n'), /record/);
  assert.throws(() => build('aukora-record v0.1\n01ab0\n'), /hex/);
  const bytes = synth(5), t = build(asRecord(bytes)), kept = rootOf(t), path = prove(t, 0);
  assert.equal(verifyLeaf(kept, bytes[0], 0, 5, path.slice(1)), false);
  assert.equal(verifyLeaf(kept, bytes[0], 0, 5, [{ ...path[0], side: 'L' }, ...path.slice(1)]), false);
});
await check('original RFC 6962 checkpoint unchanged after real prune and exact reattachment', () => {
  const reduced = prune(tree, 0, 32);
  assert.deepEqual(reattach(reduced, 0, lines.slice(0, 32)), tree);
  assert.equal(core.exportRecord(), record);
  assert.deepEqual(checkpoint(core.exportRecord()), before);
});
await check('every parent in sizes 2 through 33 binds both removed siblings’ totals', () => {
  let byteMoves = 0;
  let counterMoves = 0;
  for (let n = 2; n <= 33; n++) {
    const record = asRecord(synth(n));
    const byteTree = build(record);
    const byteCommit = rootCommit(rootOf(byteTree));
    for (const [start, width] of regions(0, n)) {
      if (width === 1) continue;
      let k = 1;
      while (k * 2 < width) k *= 2;
      const boundary = start + k;
      function reducedWith(t, kept) {
        const reduced = prune(prune(t, start, k), boundary, width - k);
        assert.equal(rootCommit(rootOf(reduced)), kept);
        return reduced;
      }
      function checkMove(reduced, kept, move, label) {
        const altered = structuredClone(reduced);
        let node = altered.root, pos = 0, size = n;
        while (pos !== start || size !== width) {
          let split = 1;
          while (split * 2 < size) split *= 2;
          if (start < pos + split) { node = node.left; size = split; }
          else { node = node.right; pos += split; size -= split; }
        }
        assert.equal(node.left.pruned, true);
        assert.equal(node.right.pruned, true);
        move(node.left.totals, node.right.totals);
        const changed = rootOf(altered);
        assert.deepEqual(changed.totals, rootOf(reduced).totals);
        assert.notEqual(rootCommit(changed), kept,
          'n=' + n + ' start=' + start + ' width=' + width + ' ' + label);
      }
      const reduced = reducedWith(byteTree, byteCommit);
      for (const sign of [-1, 1]) {
        // Each synthetic line is three bytes, so either side can give up one.
        checkMove(reduced, byteCommit, (left, right) => {
          left[1] += sign; right[1] -= sign;
        }, 'bytes ' + sign);
        byteMoves++;
        for (let a = 2; a < 5; a++) {
          for (let b = a + 1; b <= 5; b++) {
            const [fromLeft, fromRight] = sign === 1 ? [a, b] : [b, a];
            // Both donors have a unit even when the children are singletons.
            const t = build(record, (_line, i) => i < boundary ? fromLeft : fromRight);
            const kept = rootCommit(rootOf(t));
            checkMove(reducedWith(t, kept), kept, (left, right) => {
              left[fromLeft]--; left[fromRight]++;
              right[fromRight]--; right[fromLeft]++;
            }, 'counter pair ' + a + ':' + b + ' ' + sign);
            counterMoves++;
          }
        }
      }
    }
  }
  assert.equal(byteMoves, 1056);
  assert.equal(counterMoves, 6336);
});
await check('root commitment binds each total and the digest, including an opaque root', () => {
  const t = build(asRecord(synth(8)));
  const root = rootOf(t), kept = rootCommit(root);
  for (let i = 0; i < root.totals.length; i++) {
    const changed = structuredClone(root);
    changed.totals[i]++;
    assert.notEqual(rootCommit(changed), kept, 'total ' + i);
  }
  const flipped = root.digest[0] === '0' ? '1' : '0';
  assert.notEqual(rootCommit({ ...root, digest: flipped + root.digest.slice(1) }), kept);
  assert.equal(rootCommit(rootOf(prune(t, 0, t.size))), kept);
  for (const value of [-1, 2.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const changed = structuredClone(root);
    changed.totals[1] = value;
    assert.throws(() => rootCommit(changed), /invalid total/);
  }
  assert.throws(() => rootCommit({ ...root, totals: root.totals.slice(1) }), /expected six totals/);
});
await check('custom classifier is consistent across build, leaf proofs and reattachment', () => {
  const bytes = synth(8);
  const classify = (line, i) => {
    const baseline = i === 0 ? 5 : [2, 3, 3, 4, 5][i % 5];
    return 2 + ((baseline - 2 + 1 + line[0] % 2) % 4);
  };
  const different = (line, i) => 2 + ((classify(line, i) - 2 + 1) % 4);
  const text = asRecord(bytes), t = build(text, classify), root = rootOf(t);
  const defaultTree = build(text), defaultRoot = rootOf(defaultTree);
  assert.notEqual(rootCommit(root), rootCommit(defaultRoot));
  for (const [i, line] of bytes.entries()) {
    const path = prove(t, i);
    assert.equal(verifyLeaf(root, line, i, t.size, path, classify), true);
    assert.equal(verifyLeaf(root, line, i, t.size, path, different), false);
    assert.equal(verifyLeaf(root, line, i, t.size, path), false);
  }
  const reduced = prune(t, 4, 4), lines = bytes.slice(4);
  assert.deepEqual(reattach(reduced, 4, lines, classify), t);
  assert.throws(() => reattach(reduced, 4, lines, different), /does not match/);
  assert.throws(() => reattach(reduced, 4, lines), /does not match/);
});
await check('classifier refuses wrong return types, fractions and out-of-range indices', () => {
  const bytes = synth(3), t = build(asRecord(bytes));
  for (const bad of [1, 6, 2.5, '2']) {
    const classify = () => bad;
    assert.throws(() => build(asRecord(bytes), classify), /classifier must return/);
    assert.equal(verifyLeaf(rootOf(t), bytes[0], 0, 3, prove(t, 0), classify), false);
    assert.throws(() => reattach(prune(t, 0, 2), 0, bytes.slice(0, 2), classify),
      /classifier must return/);
  }
});
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
