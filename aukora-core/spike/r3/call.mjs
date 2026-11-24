import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const wasm = await readFile(process.argv[2] ?? new URL('../../core/Core3.wasm', import.meta.url));
const module = await WebAssembly.compile(wasm);
const imports = WebAssembly.Module.imports(module);
const exports = WebAssembly.Module.exports(module);
assert.deepEqual(imports, []);
assert.deepEqual(exports.map(x => [x.name, x.kind]).sort(),
  ['head', 'init', 'input', 'step'].map(x => [x, 'function']));
console.log('imports', imports, 'exports', exports.map(x => x.name).join(', '));

const zero = Buffer.alloc(32);
const u8 = x => Buffer.from([x]);
const u16 = x => Buffer.from([x & 255, x >>> 8]);
const frame = (...fields) => Buffer.concat(fields);
const blob = bytes => frame(u16(bytes.length), bytes);
const text = str => blob(Buffer.from(str, 'utf8'));
const packet = (parent, seq, tag, ...fields) => frame(parent, u16(seq), u8(tag), ...fields);
const send = (nonce, payload = Buffer.from([42]), dest = 'dest', gen = 0) =>
  frame(u8(0), blob(payload), text(dest), u16(gen), u16(nonce));
const install = digest => frame(u8(1), digest, text('core'), u16(0), u16(2));
const sha = bytes => createHash('sha256').update(bytes).digest();

function readHead(api) {
  return Buffer.from(Array.from({length: 32}, (_, i) => api.head(i)));
}
function submit(api, bytes) {
  for (const b of bytes) assert.equal(api.input(b), 1);
  return api.step();
}
async function fresh() {
  const {exports: api} = await WebAssembly.instantiate(module);
  assert.equal(api.head(0), 256);
  assert.equal(api.step(), 0);
  assert.equal(api.input(7), 0);
  assert.equal(api.init(), 1);
  assert.deepEqual(readHead(api), zero);
  assert.equal(api.head(32), 256);
  return api;
}

const intent = send(1);
const grant = packet(zero, 1, 3, intent, u8(1));
const act = packet(sha(grant), 2, 4, intent);
const steps = [
  ['grant', grant, 1],
  ['act', act, 1],
  ['same act bytes', act, 0],
  ['spent act, current parent and sequence', packet(sha(act), 3, 4, intent), 0],
  ['stale parent, eligible say and correct sequence', packet(sha(grant), 3, 0, text('stale')), 0],
];
async function run(label) {
  const api = await fresh();
  let expected = zero;
  const heads = [readHead(api).toString('hex')];
  console.log(label, 'genesis SHA-256 chain head', heads[0]);
  for (const [name, bytes, verdict] of steps) {
    assert.equal(submit(api, bytes), verdict, name);
    if (verdict) expected = sha(bytes);
    assert.deepEqual(readHead(api), expected, name);
    // Calling init twice must never restore the spent grant.
    assert.equal(api.init(), 1);
    assert.deepEqual(readHead(api), expected);
    heads.push(expected.toString('hex'));
    console.log(label, name, verdict ? 'accept' : 'refuse', 'head', heads.at(-1));
  }
  return heads;
}
const first = await run('instance 1');
assert.deepEqual(await run('instance 2'), first);
console.log('identical envelope bytes and all six heads equal in fresh instances');

const api = await fresh();
let parent = zero, seq = 1;
function check(label, fields, verdict) {
  const bytes = packet(parent, seq, ...fields);
  assert.equal(submit(api, bytes), verdict, label);
  if (verdict) {
    parent = sha(bytes);
    seq++;
  }
  assert.deepEqual(readHead(api), parent, label);
}
check('multiblock say with Unicode and NUL', [0, text('語\0abc'.repeat(22))], 1);
check('new claim', [1, u16(50), u16(1), text('claim')], 1);
check('duplicate claim', [1, u16(50), u16(1), text('again')], 0);
check('missing replacement', [2, u16(50), u16(51), text('why')], 0);
check('second claim', [1, u16(51), u16(1), text('record')], 1);
check('correction', [2, u16(50), u16(51), text('why')], 1);
check('outcome', [5, intent, u8(2)], 1);
check('advice', [6, text('cell'), u16(330)], 1);
check('failed owner verification', [3, intent, u8(0)], 0);
check('ungranted intent', [4, intent], 0);
check('grant', [3, intent, u8(1)], 1);
check('different payload', [4, send(1, Buffer.from([43]))], 0);
check('different audience', [4, send(1, Buffer.from([42]), 'other')], 0);
check('different nonce', [4, send(2)], 0);
check('different generation', [4, send(1, Buffer.from([42]), 'dest', 1)], 0);
const target = Buffer.alloc(32, 91);
check('install grant', [3, install(target), u8(1)], 1);
check('unchecked upgrade', [7, target, u8(0), install(target)], 0);
check('wrong candidate', [7, zero, u8(1), install(target)], 0);
check('checked upgrade', [7, target, u8(1), install(target)], 1);
check('verified rebind', [8, text('second'), u8(1)], 1);
check('rebound invalidates grant', [4, intent], 0);
check('old grant generation', [3, intent, u8(1)], 0);
check('new grant generation', [3, send(8, zero, 'dest', 1), u8(1)], 1);
check('UTF-8 error', [0, blob(Buffer.from([0xc0, 0x80]))], 0);
check('invalid flag', [8, text('owner'), u8(2)], 0);
check('trailing bytes', [0, text('ok'), u8(0)], 0);
check('truncated body', [1, u16(55)], 0);
check('unknown tag', [255], 0);
assert.equal(submit(api, Buffer.alloc(0)), 0);
assert.equal(api.input(256), 0);
assert.equal(api.step(), 0);
for (let i = 0; i < 65535; i++) assert.equal(api.input(0), 1);
assert.equal(api.input(0), 0);
assert.equal(api.step(), 0);
assert.deepEqual(readHead(api), parent);
check('good after bad frames', [0, text('ok')], 1);
console.log('all nine events, strict framing, internal authority, SHA-256 and input recovery passed');

for (const length of [55, 56, 63, 64, 119, 120, 65535]) {
  check('accepted frame of ' + length + ' bytes', [0, text('a'.repeat(length - 37))], 1);
}
console.log('SHA-256 padding boundaries and maximum 65535-byte accepted frame passed');

const longPayload = Buffer.alloc(65460, 0xfe);
const longIntent = send(13, longPayload, 'archive', 1);
check('long delivery grant', [3, longIntent, u8(1)], 1);
const nearMatch = Buffer.from(longPayload);
nearMatch[nearMatch.length - 1]--;
check('long payload differs in last byte', [4, send(13, nearMatch, 'archive', 1)], 0);
check('exact long payload spends grant', [4, longIntent], 1);
console.log('full intent comparison passed for a 65460-byte delivery');
