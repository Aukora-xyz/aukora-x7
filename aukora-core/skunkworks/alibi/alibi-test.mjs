import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Core, newOwner } from '../../standalone/aukora.mjs';
import { keyOf, readsOf, rootOfSet, prove, verifyPresent, verifyAbsent } from './alibi.mjs';

const hash = (...chunks) => {
  const h = createHash('sha256');
  for (const chunk of chunks) h.update(chunk);
  return h.digest();
};
const parent = (l, r) => hash(Buffer.of(1), l, r);
const leaf = k => hash(Buffer.of(0), k);
const freshKeys = (n, prefix = 'member') => Array.from({ length: n }, (_, i) => keyOf(prefix + ':' + i));

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log('PASS ' + name + (detail ? ' (' + detail + ')' : ''));
  } catch (error) {
    failed++;
    console.log('FAIL ' + name + ': ' + (error.stack ?? error));
  }
}

const names = ['doc/a', 'δοκιμή', 's3://local/β', 'x / y', 'doc/z '];
let record, keys;
await check('1. real Core record: six retained reads, five distinct keys', async () => {
  const core = await Core.load();
  core.init(newOwner());
  assert.equal(core.say('not a READ ignored'), true);
  for (const name of [...names, names[1]]) assert.equal(core.say('READ ' + name), true);
  assert.equal(core.say('read lowercase ignored'), true);
  record = core.exportRecord();
  const reads = readsOf(record);
  assert.deepEqual(reads, [...names, names[1]]);
  keys = reads.map(keyOf);
  assert.equal(new Set(keys.map(k => k.toString('hex'))).size, 5);
});

await check('2. every read is present and an unread resource is absent, with opposite proofs refused', () => {
  const root = rootOfSet(keys);
  for (const k of keys) {
    const p = prove(keys, k);
    assert.equal(p.present, true);
    assert.equal(verifyPresent(root, k, p), true);
    assert.equal(verifyAbsent(root, k, p), false);
  }
  const k = keyOf('never read');
  const p = prove(keys, k);
  assert.equal(p.present, false);
  assert.equal(verifyAbsent(root, k, p), true);
  assert.equal(verifyPresent(root, k, p), false);
});

await check('3. all six-position permutations and duplicate/order cases at sizes 0 through 40', () => {
  const six = keys.slice(), expected = rootOfSet(six);
  let count = 0;
  function permute(i) {
    if (i === six.length) {
      assert.equal(rootOfSet(six), expected);
      count++;
      return;
    }
    for (let j = i; j < six.length; j++) {
      [six[i], six[j]] = [six[j], six[i]];
      permute(i + 1);
      [six[i], six[j]] = [six[j], six[i]];
    }
  }
  permute(0);
  assert.equal(count, 720);
  for (let n = 0; n <= 40; n++) {
    const ks = freshKeys(n), root = rootOfSet(ks), rev = ks.slice().reverse();
    assert.equal(rootOfSet(rev), root);
    assert.equal(rootOfSet([...rev, ...ks, ...rev]), root);
  }
});

await check('4. canonical empty tree and all-zero absence proof', () => {
  let empty = hash(Buffer.of(6));
  for (let i = 0; i < 256; i++) empty = parent(empty, empty);
  const root = rootOfSet([]);
  assert.equal(root, empty.toString('hex'));
  for (const k of [...freshKeys(40), Buffer.alloc(32), Buffer.alloc(32, 0xff)]) {
    const p = prove([], k);
    assert.deepEqual(p, { present: false, bitmap: Buffer.alloc(32), siblings: [] });
    assert.equal(verifyAbsent(root, k, p), true);
    assert.equal(verifyPresent(root, k, p), false);
  }
});

function noBitFlipValid(root, k, p, verify) {
  for (const field of [p.bitmap, ...p.siblings]) {
    for (let i = 0; i < field.length; i++) {
      for (let mask = 1; mask <= 128; mask <<= 1) {
        field[i] ^= mask;
        const accepted = verify(root, k, p);
        field[i] ^= mask;
        assert.equal(accepted, false);
      }
    }
  }
}

await check('5. absence-proof replay and exhaustive single-bit tampering, sizes 1 through 40', () => {
  for (let n = 1; n <= 40; n++) {
    const ks = freshKeys(n), root = rootOfSet(ks);
    // Query every member and n distinct absent keys per set, not all 2^256 possible keys.
    const queries = [...ks, ...freshKeys(n, 'absent')];
    const proofs = queries.map(k => prove(ks, k));
    for (let i = 0; i < queries.length; i++) {
      const k = queries[i], p = proofs[i], expectedPresent = i < n;
      assert.equal(p.present, expectedPresent);
      const verify = expectedPresent ? verifyPresent : verifyAbsent;
      assert.equal(verify(root, k, p), true);
      noBitFlipValid(root, k, p, verify);
      if (!expectedPresent) continue;
      for (let j = 0; j < queries.length; j++) {
        if (j !== i) assert.equal(verifyAbsent(root, k, proofs[j]), false);
      }
    }
  }
});

await check('6. omitting any distinct read changes the root; dropping one duplicate does not', () => {
  const fromRecord = readsOf(record);
  const root = rootOfSet(fromRecord.map(keyOf));
  for (const name of new Set(fromRecord)) {
    assert.notEqual(rootOfSet(fromRecord.filter(s => s !== name).map(keyOf)), root);
  }
  assert.equal(rootOfSet(fromRecord.slice(0, -1).map(keyOf)), root);
});

await check('7. 255-bit neighbours use the last bitmap bit; third key shares 200 bits', () => {
  const a = Buffer.alloc(32), b = Buffer.alloc(32), c = Buffer.alloc(32);
  b[31] = 1;
  c[25] = 0x80;
  const root = rootOfSet([a, b]);

  // Independent explicit fold: two leaves at level 1, then all left turns to the root.
  let expected = parent(leaf(a), leaf(b)), empty = hash(Buffer.of(6));
  for (let level = 1; level < 256; level++) {
    empty = parent(empty, empty);
    expected = parent(expected, empty);
  }
  assert.equal(root, expected.toString('hex'));
  for (const [k, neighbour] of [[a, b], [b, a]]) {
    const p = prove([a, b], k);
    const bitmap = Buffer.alloc(32);
    bitmap[31] = 1;
    assert.deepEqual(p.bitmap, bitmap);
    assert.deepEqual(p.siblings, [leaf(neighbour)]);
    assert.equal(verifyPresent(root, k, p), true);
  }
  const absence = prove([a, b], c);
  const bitmap = Buffer.alloc(32);
  bitmap[25] = 0x80;
  assert.deepEqual(absence.bitmap, bitmap);
  assert.equal(verifyAbsent(root, c, absence), true);
  assert.equal(verifyPresent(root, c, absence), false);
});

await check('8. all malformed proof forms return false for both verifiers', () => {
  const a = Buffer.alloc(32), b = Buffer.alloc(32);
  b[31] = 1;
  const root = rootOfSet([a, b]), p = prove([a, b], a);
  const malformed = [
    [root, a, { ...p, bitmap: Buffer.alloc(31) }],
    [root, a, { ...p, bitmap: Buffer.alloc(33) }],
    [root, a, { ...p, siblings: [Buffer.alloc(31)] }],
    [root, a, { ...p, siblings: [Buffer.alloc(33)] }],
    [root, a, { ...p, siblings: [] }],
    [root, a, { ...p, siblings: [...p.siblings, Buffer.alloc(32)] }],
    [root, a, { ...p, siblings: [hash(Buffer.of(6))] }],
    [root, Buffer.alloc(31), p],
    [root, Buffer.alloc(33), p],
    [root.slice(1), a, p],
    ['0'.repeat(63) + 'g', a, p],
    ['A'.repeat(64), a, p],
    [root, a, null],
  ];
  for (const args of malformed) {
    assert.equal(verifyPresent(...args), false);
    assert.equal(verifyAbsent(...args), false);
  }
});

await check('9. compressed proofs for a set of 40 keys', () => {
  const ks = freshKeys(40);
  const largest = Math.max(...[...ks, ...freshKeys(40, 'absent')].map(k => prove(ks, k).siblings.length));
  assert.ok(largest <= 64, 'largest=' + largest);
  return 'largest observed: ' + largest + ' siblings';
});

console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
