import assert from 'node:assert/strict';
import { Core, newOwner } from '../../standalone/aukora.mjs';
import { checkpoint } from '../../standalone/checkpoint.mjs';
import { build, prune, rootOf, rootCommit } from '../onion/onion.mjs';
import { exportBubble, encodeBubble, decodeBubble, openBubble, returnBubble } from './bubble.mjs';

let passed = 0, failed = 0;
async function check(number, name, fn) {
  try { await fn(); passed++; console.log(`PASS ${number}. ${name}`); }
  catch (error) {
    failed++;
    console.log(`FAIL ${number}. ${name}: ${String(error?.message ?? error).replace(/\s+/gu, ' ')}`);
  }
}
async function real(tag) {
  const core = await Core.load();
  const owner = newOwner();
  core.init(owner);
  for (let i = 0; i < 40; i++) assert.equal(core.say(`bubble ${tag} ${i}`), true);
  const intent = { payload: 'record-only fixture', audience: 'local test', nonce: 1 };
  assert.equal(core.grant(owner, intent), true);
  assert.equal(core.act(intent), true);
  return core;
}
function* regions(start, count) {
  yield [start, count];
  if (count === 1) return;
  let left = 1;
  while (2 * left < count) left *= 2;
  yield* regions(start, left);
  yield* regions(start + left, count - left);
}
const recordOf = lines => 'aukora-record v0.1\n' + lines.join('\n') + '\n';
const synthetic = n => recordOf(Array.from({ length: n }, (_, i) =>
  Buffer.of([0, 0x13, 0x17, 0x18, 0xff][i % 5], i, 255 - i).toString('hex')));
const commitOf = tree => rootCommit(rootOf(tree));

function recount(bytes, start) {
  const totals = [bytes.length, 0, 0, 0, 0, 0];
  for (let j = 0; j < bytes.length; j++) {
    const line = bytes[j];
    totals[1] += line.length;
    if (start + j === 0) totals[5]++;
    else switch (line[0]) {
      case 0: totals[2]++; break;
      case 0x13: case 0x18: totals[3]++; break;
      case 0x17: totals[4]++; break;
      default: totals[5]++;
    }
  }
  return totals;
}

const fixture = synthetic(8);
const fixtureTree = build(fixture);
const kept = commitOf(fixtureTree);
const pair = exportBubble(fixtureTree, fixture, 0, 2);
let core, record, checkpointBefore, tree, original, exportsOfRecord;

await check(1, 'every real subtree exports, round-trips and opens with independently counted totals', async () => {
  core = await real('A');
  record = core.exportRecord();
  checkpointBefore = checkpoint(record);
  tree = build(record);
  original = commitOf(tree);
  assert.equal(tree.size, 43);
  exportsOfRecord = [];
  const raw = record.trimEnd().split('\n').slice(1);
  for (const [start, count] of regions(0, tree.size)) {
    const bubble = exportBubble(tree, record, start, count);
    assert.deepEqual(Object.keys(bubble), ['v', 'size', 'start', 'count', 'lines', 'path']);
    const json = encodeBubble(bubble);
    const opened = openBubble(original, decodeBubble(json));
    assert.ok(opened, `subtree ${start}:${count}`);
    const independent = raw.slice(start, start + count).map(x => Buffer.from(x, 'hex'));
    assert.deepEqual(opened.lines, independent);
    assert.deepEqual(opened.totals, recount(independent, start));
    exportsOfRecord.push(json);
  }
});

await check(2, 'the region leaves without moving the commitment and returns the exact tree', () => {
  for (const json of exportsOfRecord) {
    const bubble = decodeBubble(json);
    const departed = prune(tree, bubble.start, bubble.count);
    assert.equal(commitOf(departed), original);
    assert.deepEqual(returnBubble(departed, bubble), tree);
  }
});

await check(3, 'changed, dropped, swapped or extra lines do not open', () => {
  for (const mutate of [
    b => { const x = Buffer.from(b.lines[0], 'hex'); x[1] ^= 1; b.lines[0] = x.toString('hex'); },
    b => { b.lines.pop(); },
    b => { b.lines.reverse(); },
    b => { b.lines.push('ffff'); },
  ]) {
    const b = structuredClone(pair);
    mutate(b);
    assert.equal(openBubble(kept, b), null);
  }
});

await check(4, 'another valid start of the same width and a changed size do not open', () => {
  assert.equal(openBubble(kept, { ...pair, start: 2 }), null);
  assert.equal(openBubble(kept, { ...pair, size: 9 }), null);
});

await check(5, 'a different real record of the same size refuses the bubble', async () => {
  const another = build((await real('B')).exportRecord());
  assert.equal(another.size, tree.size);
  assert.notEqual(commitOf(another), original);
  assert.equal(openBubble(commitOf(another), decodeBubble(exportsOfRecord[0])), null);
});

await check(6, 'sibling-value, balanced-value, invalid-number, side and path-length changes refuse', () => {
  for (const mutate of [
    b => { b.path[0].totals[1]++; },
    b => { b.path[0].totals[1]++; b.path[1].totals[1]--; },
    b => { b.path[0].totals[1] = -1; },
    b => { b.path[0].totals[1] = 2.5; },
    b => { b.path[0].totals[1] = Number.MAX_SAFE_INTEGER + 1; },
    b => { b.path[0].side = 'L'; },
    b => { b.path.pop(); },
    b => { b.path.push(structuredClone(b.path[0])); },
  ]) {
    const b = structuredClone(pair);
    mutate(b);
    assert.equal(openBubble(kept, b), null);
  }
});

await check(7, 'genesis counts as other and cannot move to a different region', () => {
  const genesis = exportBubble(fixtureTree, fixture, 0, 1);
  assert.deepEqual(openBubble(kept, genesis).totals, [1, 3, 0, 0, 0, 1]);
  const moved = exportBubble(fixtureTree, fixture, 4, 1);
  assert.equal(openBubble(kept, { ...moved, lines: genesis.lines }), null);
});

await check(8, 'custom classification works through open and return, unlike disagreeing classifiers', () => {
  const classify = (_line, i) => i % 2 === 0 ? 3 : 4;
  const customTree = build(fixture, classify);
  const bubble = exportBubble(customTree, fixture, 0, 2);
  const customCommit = commitOf(customTree);
  assert.deepEqual(openBubble(customCommit, bubble, classify).totals, [2, 6, 0, 1, 1, 0]);
  assert.equal(openBubble(customCommit, bubble), null);
  assert.equal(openBubble(customCommit, bubble, () => 2), null);
  const departed = prune(customTree, bubble.start, bubble.count);
  assert.throws(() => returnBubble(departed, bubble), /does not open/u);
  assert.deepEqual(returnBubble(departed, bubble, classify), customTree);
});

await check(9, 'canonical JSON refuses malformed encodings and preserves every exported string', () => {
  const json = encodeBubble(pair);
  const upper = structuredClone(pair);
  upper.lines[0] = 'ABCDEF';
  const extraStep = structuredClone(pair);
  extraStep.path[0].extra = 1;
  const wrongStepOrder = structuredClone(pair);
  const { side, totals, digest } = wrongStepOrder.path[0];
  wrongStepOrder.path[0] = { totals, side, digest };
  const malformed = [
    JSON.stringify({ ...pair, extra: 1 }),
    JSON.stringify({ size: pair.size, ...pair }),
    JSON.stringify({ ...pair, count: String(pair.count) }),
    JSON.stringify(upper),
    json.replace('"v":1', '"v":1,"v":1'),
    json + ' trailing',
    json + ' ',
    json.replace('"v":1', '"v":1.0'),
    json.replace('"v":1', '"\\u0076":1'),
    JSON.stringify(extraStep),
    JSON.stringify(wrongStepOrder),
    json.replace('"side":"R"', '"side":"R","side":"R"'),
  ];
  for (const text of malformed) {
    assert.notEqual(text, json);
    assert.throws(() => decodeBubble(text));
  }
  for (const text of exportsOfRecord) assert.equal(encodeBubble(decodeBubble(text)), text);
});

await check(10, 'every exact subtree at sizes 1 to 33 exports, opens, leaves and returns', () => {
  for (let size = 1; size <= 33; size++) {
    const source = synthetic(size), onion = build(source), commitment = commitOf(onion);
    for (const [start, count] of regions(0, size)) {
      const bubble = exportBubble(onion, source, start, count);
      const wire = encodeBubble(bubble);
      assert.equal(encodeBubble(decodeBubble(wire)), wire);
      const opened = openBubble(commitment, decodeBubble(wire));
      assert.ok(opened);
      assert.deepEqual(opened.totals, recount(opened.lines, start));
      const departed = prune(onion, start, count);
      assert.equal(commitOf(departed), commitment);
      assert.throws(() => exportBubble(departed, source, start, count), /pruned/u);
      if (count < size) assert.throws(() => exportBubble(departed, source, 0, size), /pruned/u);
      assert.deepEqual(returnBubble(departed, decodeBubble(wire)), onion);
    }
  }
  assert.throws(() => exportBubble(fixtureTree, fixture, 1, 2), /not exactly one subtree/u);
  // Pruned siblings outside the exported region may still be used as commitments.
  const outside = prune(fixtureTree, 4, 4);
  assert.ok(openBubble(kept, exportBubble(outside, fixture, 0, 2)));
});

await check(11, 'the original RFC 6962 checkpoint is unchanged', () => {
  assert.equal(core.exportRecord(), record);
  assert.deepEqual(checkpoint(core.exportRecord()), checkpointBefore);
});
console.log(`${passed} passed, ${failed} failed`);
if (failed !== 0) process.exitCode = 1;
