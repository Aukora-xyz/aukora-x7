import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';

const module = new WebAssembly.Module(readFileSync('core/Kernel7.wasm'));
assert.deepEqual(WebAssembly.Module.imports(module), []);
assert.deepEqual(WebAssembly.Module.exports(module).map(({name,kind}) => [name,kind]).sort(),
  ['check','input','ready'].map(name => [name,'function']));
const proofs = ['logs/r7/model', 'logs/r7/other', 'logs/r6/wrong_digest']
  .map(path => readFileSync(path + '.proof.expr'));
const goal = readFileSync('logs/r7/model.type.expr');
function encodeName(name) {
  return name.split('.').reduce((parent, part) =>
    Buffer.concat([Buffer.of(1), parent, Buffer.of(part.length), Buffer.from(part)]), Buffer.of(0));
}
function push(api, proof) {
  for (const byte of proof) assert.equal(api.input(byte), 1);
}
function verdict(api, slot, proof) {
  push(api, proof);
  return api.check(slot);
}

const times = [];
for (let i = 0; i < 3; ++i) {
  const api = new WebAssembly.Instance(module).exports;
  const initStart = performance.now();
  assert.equal(api.ready(0), 1);
  const initMs = performance.now() - initStart;
  push(api, proofs[0]);
  const start = performance.now();
  const result = api.check(0);
  const elapsed = performance.now() - start;
  console.log('fresh instance', i + 1, 'ready ms', initMs.toFixed(3),
    'proof ms', elapsed.toFixed(3), 'primary proof bytes', proofs[0].length, 'verdict', result);
  assert.equal(result, 1);
  times.push(elapsed);
  if (i === 0) {
    assert.equal(api.ready(1), 1);
    for (let slot = 0; slot < 2; ++slot) {
      for (let proof = 0; proof < proofs.length; ++proof) {
        const accepted = verdict(api, slot, proofs[proof]);
        console.log('Wasm goal slot', slot, 'proof', ['primary','alternate','old'][proof], 'verdict', accepted);
        assert.equal(accepted, Number(slot === proof));
      }
    }
    for (const name of ['Laws7.r6_lawful','Laws7.other_lawful','Aukora.Bound5.wrong_digest']) {
      const self = Buffer.concat([Buffer.of(2), encodeName(name), Buffer.of(0)]);
      assert.equal(verdict(api, 0, self), 0, name);
    }
    for (const bad of [goal, Buffer.of(1,0), proofs[0].subarray(0,-1), Buffer.alloc(0)]) {
      assert.equal(verdict(api, 0, bad), 0);
    }
    assert.equal(api.ready(2), 0);
    assert.equal(verdict(api, 2, proofs[0]), 0);
    assert.equal(verdict(api, 0, proofs[0]), 1);
    console.log('self references, wrong types, truncated and absent proofs, unknown slot refused; retry accepted');
  }
}
console.log('primary median check ms', times.sort((a,b) => a-b)[1].toFixed(3),
  '(preloaded, excludes initialization and JS input); alternate proof bytes', proofs[1].length);
