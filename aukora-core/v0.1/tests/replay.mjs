// Compare the entire public head after each ledger submission, including refusal.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const release = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [chosen = path.join(release, 'vectors'), artifact = path.join(release, 'aukora-core.wasm')] = process.argv.slice(2);
const lite = process.argv[4] === '--lite';
const groups = ['matrix', 'length', 'history', 'signed', 'gate'];
const wasm = new WebAssembly.Module(readFileSync(artifact));
assert.deepEqual(WebAssembly.Module.imports(wasm), []);
const exports = ['input', 'init', 'step', 'reset', 'feed', 'head', 'core', 'recordByte', 'threshold',
  'stamp', 'stampCount', 'stampByte', 'verify', 'hashHead', 'outcome'];
assert.deepEqual(WebAssembly.Module.exports(wasm).sort((a, b) => a.name.localeCompare(b.name)),
  exports.map(name => ({ name, kind: 'function' })).sort((a, b) => a.name.localeCompare(b.name)));

function input(api, bytes) {
  let consumed = true;
  for (const byte of bytes) {
    if (api.input(byte) !== 1) consumed = false;
  }
  return consumed;
}

function view(api, accessor) {
  const bytes = Array.from({ length: 32 }, (_, i) => api[accessor](i));
  assert.equal(api[accessor](32), 256);
  return Buffer.from(bytes).toString('hex');
}

let total = 0;
let accepts = 0;
for (const group of groups) {
  const api = new WebAssembly.Instance(wasm).exports;
  const initFolder = group === 'gate' ? 'install' : 'signed';
  const keys = readFileSync(path.join(release, 'fixtures', initFolder, 'keys.bin'));
  assert.ok(input(api, keys));
  assert.equal(api.init(), 1);
  if (group === 'gate') {
    const staged = readFileSync(path.join(release, 'fixtures', 'fixed-genesis.wasm'));
    for (let i = 0; i < staged.length; i += 8192) {
      assert.ok(input(api, staged.subarray(i, i + 8192)));
      assert.equal(api.feed(), 1);
    }
  }
  const prefix = path.join(chosen, group);
  const wire = existsSync(prefix + '.bin') ? readFileSync(prefix + '.bin') : gunzipSync(readFileSync(prefix + '.bin.gz'));
  const rows = readFileSync(prefix + '.tsv', 'utf8').trimEnd().split('\n');
  let offset = 0;
  let positive = 0;
  let priorHead = view(api, 'head');
  const initialCore = view(api, 'core');
  for (const [index, row] of rows.entries()) {
    const [label, width, verdict, head] = row.split('\t');
    const size = Number(width);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    assert.match(head, /^[0-9a-f]{64}$/);
    assert.match(verdict, /^[01]$/);
    const bytes = wire.subarray(offset, offset + size);
    assert.equal(bytes.length, size);
    const complete = input(api, bytes);
    const actual = api.step();
    const actualHead = view(api, 'head');
    const refusedInstall = lite && group === 'gate' && bytes[0] === 27;
    const expected = refusedInstall ? 0 : Number(verdict);
    const resultingHead = refusedInstall ? priorHead : head;
    assert.equal(actual, expected, `${group} row ${index} ${label} offset ${offset} size ${size} input-complete ${complete} verdict`);
    assert.equal(actualHead, resultingHead, `${group} row ${index} ${label} offset ${offset} size ${size} head`);
    if (label === 'gate-install') {
      assert.equal(Number(verdict), 1);
      assert.equal(actual, lite ? 0 : 1);
      const expectedCore = lite ? initialCore : bytes.subarray(41, 73).toString('hex');
      assert.equal(view(api, 'core'), expectedCore);
    }
    priorHead = actualHead;
    positive += actual;
    offset += size;
  }
  assert.equal(offset, wire.length);
  assert.ok(positive > 0 && positive < rows.length);
  total += rows.length;
  accepts += positive;
  console.log(`${group} ${rows.length}/${rows.length} agree, ${positive} accepted, ${rows.length - positive} refused`);
}
assert.ok(total >= 1000);
console.log(`${lite ? 'LITE (tag 27 always refused)' : 'DIFFERENTIAL'} ${total}/${total} agree on verdict and 32-byte head, ${accepts} accepted, ${total - accepts} refused`);
