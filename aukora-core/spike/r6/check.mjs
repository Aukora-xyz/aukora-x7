import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const moduleBytes = readFileSync('core/Kernel6.wasm');
const proof = readFileSync('logs/r6/wrong_digest.proof.expr');
const goal = readFileSync('logs/r6/wrong_digest.type.expr');
// A second proof with a different syntax tree: (fun h : goal => h) proof.
const betaProof = Buffer.concat([Buffer.from([3, 4, 0, 0]), goal, Buffer.from([0, 0]), proof]);
const targetName = ['Aukora','Bound5','wrong_digest'].reduce(
  (prefix, part) => Buffer.concat([Buffer.of(1), prefix, Buffer.of(part.length), Buffer.from(part)]), Buffer.of(0));
// A constant with no universe parameters; the target theorem must be absent from the environment.
const selfReference = Buffer.concat([Buffer.of(2), targetName, Buffer.of(0)]);
const module = new WebAssembly.Module(moduleBytes);
const imports = WebAssembly.Module.imports(module), exports = WebAssembly.Module.exports(module);
console.log('Wasm imports', imports, 'exports', exports);
assert.deepEqual(imports, []);
assert.deepEqual(exports.map(e => [e.name,e.kind]).sort(), ['input','ready','check'].map(k=>[k,'function']).sort());

function preload(api, bytes) {
  for (const b of bytes) assert.equal(api.input(b), 1);
}
function checkOnce(api, bytes) {
  preload(api, bytes);
  return api.check();
}
const times = [];
for (let n = 0; n < 3; ++n) {
  const api = new WebAssembly.Instance(module).exports;
  const init = performance.now();
  assert.equal(api.ready(), 1, 'pinned environment and expected proposition loaded');
  const initMs = performance.now() - init;
  preload(api, proof);
  const start = performance.now();
  const ok = api.check();
  const elapsed = performance.now() - start;
  console.log('fresh instance', n + 1, 'ready ms', initMs.toFixed(3), 'proof ms', elapsed.toFixed(3), 'verdict', ok);
  assert.equal(ok, 1, 'actual stored proof');
  times.push(elapsed);
  for (const [label, bad] of [
    ['well-formed proof input with the wrong type (Sort 0)', Buffer.from([1,0])],
    ['goal expression submitted as its own proof', goal],
    ['reference to the target theorem itself', selfReference],
    ['truncated proof', proof.subarray(0, -1)],
    ['trailing byte', Buffer.concat([proof, Buffer.of(0)])],
    ['empty proof', Buffer.alloc(0)],
  ]) {
    assert.equal(checkOnce(api, bad), 0, label);
    if (n === 0) console.log('refused:', label);
  }
  assert.equal(checkOnce(api, betaProof), 1, 'independently constructed beta-equivalent proof');
  if (n === 0) console.log('accepted distinct, beta-equivalent proof of', betaProof.length, 'bytes');
  assert.equal(checkOnce(api, proof), 1, 'valid retry after refusals');
}
console.log('proof bytes', proof.length, 'checker bytes', moduleBytes.length, 'SHA-256', createHash('sha256').update(moduleBytes).digest('hex'));
console.log('median check ms', times.sort((a,b)=>a-b)[1].toFixed(3), '(preloaded proof, excludes ready and JS input loop)');
