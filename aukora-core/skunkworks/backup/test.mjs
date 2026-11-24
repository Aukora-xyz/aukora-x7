import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { head, checkpoint, verdict } from './backup.mjs';

const here = name => fileURLToPath(new URL(name, import.meta.url));
const vectorPath = here('./vectors.json');
const fixture = readFileSync(vectorPath);
const cases = JSON.parse(fixture);
const lines = xs => xs.map(x => Buffer.from(x, 'hex'));
let passed = 0, failed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('ok ' + label);
  } catch (error) {
    failed++;
    console.log('FAIL ' + label + ': ' + String(error?.message ?? error).replace(/[\r\n]+/g, ' '));
  }
}
function truth(seen, now) {
  if (now.length < seen.length) return 1;
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] !== now[i]) return 2;
  }
  return 0;
}
function nodeResult(g, seen, now) {
  const seed = Buffer.from(g, 'hex');
  return verdict(seed, checkpoint(seed, lines(seen)), lines(now));
}

check('fixture generation is byte-identical', () => {
  const temp = mkdtempSync(join(tmpdir(), 'backup-vectors-'));
  try {
    for (const name of ['a.json', 'b.json']) {
      const path = join(temp, name);
      const child = spawnSync(process.execPath, [here('./make-vectors.mjs'), path]);
      assert.ifError(child.error);
      assert.equal(child.status, 0, String(child.stderr));
      assert.deepEqual(readFileSync(path), fixture);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
check('Node verdicts match every recorded vector', () => {
  assert.ok(cases.length >= 400);
  for (const [i, { g, seen, now, verdict: expected }] of cases.entries()) {
    assert.equal(nodeResult(g, seen, now), expected, 'vector ' + i);
  }
});
check('Python stdout is one exact verdict per vector', () => {
  const child = spawnSync('python3', [here('./backup.py'), vectorPath], { encoding: 'utf8' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, cases.map(x => x.verdict + '\n').join(''));
});
check('hash-free prefix truth matches every vector', () => {
  for (const [i, { seen, now, verdict: expected }] of cases.entries()) {
    assert.equal(truth(seen, now), expected, 'vector ' + i);
  }
});
check('all 225 pairs with lengths 0 through 3 over a/b', () => {
  const records = [[]];
  for (let width = 1; width <= 3; width++) {
    for (let bits = 0; bits < 2 ** width; bits++) {
      records.push(Array.from({ length: width }, (_, i) => bits & (1 << i) ? '61' : '62'));
    }
  }
  const g = '5c'.repeat(32);
  for (const seen of records) {
    for (const now of records) assert.equal(nodeResult(g, seen, now), truth(seen, now));
  }
});
check('distinct verifier genesis refuses a retained prefix', () => {
  const g = Buffer.alloc(32, 1), other = Buffer.alloc(32, 2);
  const seen = [Buffer.of(0x61)];
  const kept = checkpoint(g, seen);
  assert.equal(verdict(g, kept, seen), 0);
  assert.equal(verdict(other, kept, seen), 2);
  assert.equal(verdict(other, kept, []), 1);
});
check('a retained 70,000-byte line is hashed and byte changes refuse', () => {
  const g = Buffer.alloc(32), line = Buffer.alloc(70000, 0xa5);
  const kept = checkpoint(g, [line]);
  assert.deepEqual(kept.top, head(g, [line]));
  assert.equal(verdict(g, kept, [line]), 0);
  const changed = Buffer.from(line);
  changed[69999] ^= 1;
  assert.equal(verdict(g, kept, [changed]), 2);
});

console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
