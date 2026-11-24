import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const bytes = await readFile(new URL('../core/Gate.wasm', import.meta.url));
const {module, instance} = await WebAssembly.instantiate(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), []);
console.log('imports: []', 'exports:', WebAssembly.Module.exports(module));
const gate = instance.exports.aukora_gate;
const head = [10n, 20n, 30n, 40n];
const candidate = [99n, 98n, 97n, 96n];
const initial = {
  parent: head, head, current: 12n, incoming: 13n, gen: 2n, a: 0n, b: 0n,
  tag: 0, hitA: 0, hitB: 0, owner: 0, proof: 0, body: 0, target: candidate, candidate,
};
function check(name, changes, expected) {
  const w = {...initial, ...changes};
  const result = gate(...w.parent, ...w.head, w.current, w.incoming, w.gen, w.a, w.b,
    w.tag, w.hitA, w.hitB, w.owner, w.proof, w.body, ...w.target, ...w.candidate);
  console.log(name, result);
  assert.equal(result, expected, name);
}
const act = {tag: 4, a: 2n, body: 0, hitA: 1};
const upgrade = {tag: 7, a: 2n, body: 1, hitA: 1, proof: 1};
check('accepted say', {}, 1);
check('stale parent', {parent: [10n, 20n, 30n, 41n]}, 0);
check('wrong sequence', {incoming: 14n}, 0);
check('act without grant', {...act, hitA: 0}, 0);
check('upgrade with proofChecked=false', {...upgrade, proof: 0}, 0);
check('granted act', act, 1);
check('granted checked upgrade', upgrade, 1);
check('upgrade wrong target', {...upgrade, candidate: [99n, 98n, 95n, 96n]}, 0);
check('old generation', {...act, a: 1n}, 0);
check('new claim', {tag: 1, a: 12n}, 1);
check('duplicate claim', {tag: 1, a: 12n, hitA: 1}, 0);
check('unknown source', {tag: 1, a: 13n}, 0);
check('distinct known correction', {tag: 2, a: 3n, b: 4n, hitA: 1, hitB: 1}, 1);
check('self correction', {tag: 2, a: 3n, b: 3n, hitA: 1, hitB: 1}, 0);
check('verified grant', {tag: 3, a: 2n, owner: 1}, 1);
check('grant already in pool', {tag: 3, a: 2n, owner: 1, hitA: 1}, 0);
check('outcome', {tag: 5}, 1);
check('advice', {tag: 6}, 1);
check('verified rebind', {tag: 8, owner: 1}, 1);
check('unverified rebind', {tag: 8}, 0);
check('unknown tag', {tag: 9}, 0);
const max = (1n << 64n) - 1n;
check('last representable successor', {current: max - 1n, incoming: max}, 1);
check('sequence wrap to zero', {current: max, incoming: 0n}, 0);
