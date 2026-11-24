import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';

const bytes = readFileSync('core/Shake7.wasm');
const mod = new WebAssembly.Module(bytes);
assert.deepEqual(WebAssembly.Module.imports(mod), []);
assert.deepEqual(WebAssembly.Module.exports(mod).map(x => [x.name, x.kind]).sort(),
  ['clear', 'input', 'shake', 'output'].map(k => [k, 'function']).sort());
const wasm = new WebAssembly.Instance(mod).exports;
const openssl = (input, n) => createHash('shake256', {outputLength: n}).update(input).digest();
function preload(input) {
  wasm.clear();
  for (const b of input) assert.equal(wasm.input(b), 1);
}
function read(n) {
  assert.equal(wasm.shake(n), 1);
  const out = Buffer.from(Array.from({length: n}, (_, i) => {
    const x = wasm.output(i);
    assert.ok(x <= 255);
    return x;
  }));
  assert.equal(wasm.output(n), 256);
  return out;
}

// Fixed first 512 bits, followed by a separate cross-check against Node/OpenSSL.
for (const [label, data, hex] of [
  ['empty', '', '46b9dd2b0ba88d13233b3feb743eeb243fcd52ea62b81b82b50c27646ed5762f' +
    'd75dc4ddd8c0f200cb05019d67b592f6fc821c49479ab48640292eacb3b7c4be'],
  ['abc', 'abc', '483366601360a8771c6863080cc4114d8db44530f8f1e1ee4f94ea37e78b5739' +
    'd5a15bef186a5386c75744c0527e1faa9f8726e462a12a4feb06bd8801e751e4'],
]) {
  const input = Buffer.from(data);
  preload(input);
  assert.equal(read(64).toString('hex'), hex);
  assert.equal(openssl(input, 64).toString('hex'), hex);
  console.log('SHAKE256', label, '64 bytes:', hex);
}
const sample = n => Buffer.from(Array.from({length: n}, (_, i) => (i * 17 + 3) & 255));
let checks = 0;
for (const l of [0, 1, 135, 136, 137, 271, 272, 273, 3309]) {
  const msg = sample(l);
  preload(msg);
  for (const n of [0, 1, 64, 135, 136, 137, 272, 273]) {
    assert.deepEqual(read(n), openssl(msg, n));
    ++checks;
  }
}
console.log(checks, 'Node/OpenSSL comparisons across absorb and squeeze boundaries');

// Times include Wasm adapter allocation, input copy and return, but not JS input/output transfers.
for (const [inputBytes, outBytes] of [[0, 64], [4096, 64], [32, 4096]]) {
  const msg = sample(inputBytes);
  preload(msg);
  for (let i = 0; i < 5; i++) assert.equal(wasm.shake(outBytes), 1);
  const times = [];
  for (let sample = 0; sample < 9; sample++) {
    const batch = inputBytes + outBytes < 100 ? 30 : 3;
    const start = performance.now();
    for (let i = 0; i < batch; i++) assert.equal(wasm.shake(outBytes), 1);
    times.push((performance.now() - start) / batch);
  }
  assert.deepEqual(read(outBytes), openssl(msg, outBytes));
  times.sort((a, b) => a - b);
  console.log('Wasm SHAKE256', inputBytes, 'in', outBytes, 'out, median milliseconds', times[4].toFixed(3),
    'nine batch samples (min..max)', times[0].toFixed(3), times[8].toFixed(3));
}
console.log('Wasm bytes', bytes.length, 'SHA-256', createHash('sha256').update(bytes).digest('hex'));
