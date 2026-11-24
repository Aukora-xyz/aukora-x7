import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {exerciseEvents} from './events.mjs';

const wasm = await readFile(process.argv[2] ?? new URL('../../core/Core4.wasm', import.meta.url));
const candidate = await readFile(new URL('../../core/Core3.wasm', import.meta.url));
const module = await WebAssembly.compile(wasm);
assert.deepEqual(WebAssembly.Module.imports(module), []);
assert.deepEqual(WebAssembly.Module.exports(module).map(x => [x.name, x.kind]).sort(),
  ['core', 'feed', 'head', 'init', 'input', 'reset', 'step'].map(name => [name, 'function']));
console.log('Wasm imports: none; exports: core, feed, head, init, input, reset, step; memory private');

const zero = Buffer.alloc(32);
const sha = bytes => createHash('sha256').update(bytes).digest();
const approved = sha(candidate);
assert.equal(candidate.length, 209455);
assert.equal(approved.toString('hex'), 'b36b84988012b4169ebff84d04dbafa4d8001990be8e625d36d78831051cce8a');

const join = (...fields) => Buffer.concat(fields);
const u8 = n => Buffer.from([n]);
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const blob = bytes => join(u16(bytes.length), bytes);
const text = str => blob(Buffer.from(str, 'utf8'));
const install = (hash, generation, nonce) => join(u8(1), hash, text('core'), u16(generation), u16(nonce));
const sent = (payload, audience, generation, nonce) => join(u8(0), blob(payload), text(audience), u16(generation), u16(nonce));
const packet = (parent, seq, tag, ...fields) => join(parent, u64(seq), u8(tag), ...fields);
const digest = byteAt => Buffer.from(Array.from({length: 32}, (_, i) => byteAt(i)));
const intent = install(approved, 0, 1);
const grant = packet(zero, 1, 3, intent, u8(1));
const sharedHead = sha(grant);
const upgrade = packet(sharedHead, 2, 7, approved, u8(1), intent);

async function fresh() {
  const {exports: api} = await WebAssembly.instantiate(module);
  for (const read of [api.head, api.core]) assert.equal(read(0), 256);
  for (const fn of [api.feed, api.reset, api.step]) assert.equal(fn(), 0);
  assert.equal(api.input(1), 0);
  assert.equal(api.init(), 1);
  for (const read of [api.head, api.core]) {
    assert.deepEqual(digest(read), zero);
    assert.equal(read(32), 256);
    assert.equal(read(-1), 256);
  }
  return api;
}

function input(api, bytes) {
  for (const byte of bytes) assert.equal(api.input(byte), 1);
}

function submit(api, bytes) {
  input(api, bytes);
  return api.step();
}

function stage(api, bytes, chunkSize) {
  assert.equal(api.reset(), 1);
  let count = 0;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    input(api, bytes.subarray(offset, offset + chunkSize));
    assert.equal(api.feed(), 1);
    count++;
  }
  return count;
}

function chain(api) {
  let parent = zero, seq = 1;
  return (label, tag, fields, expected = 1) => {
    const bytes = packet(parent, seq, tag, ...fields);
    assert.equal(submit(api, bytes), expected, label);
    const id = seq - 1;
    if (expected) {
      seq++;
      parent = sha(bytes);
    }
    assert.deepEqual(digest(api.head), parent, label);
    return expected ? id : undefined;
  };
}

async function granted(label) {
  const api = await fresh();
  console.log(label, 'genesis core', digest(api.core).toString('hex'));
  assert.equal(submit(api, grant), 1);
  assert.deepEqual(digest(api.head), sharedHead);
  console.log(label, 'same grant accepted, head', sharedHead.toString('hex'));
  return api;
}

const good = await granted('instance A');
const goodChunks = stage(good, candidate, 4093);
assert.equal(submit(good, packet(sharedHead, 2, 7, approved, u8(0), intent)), 0);
assert.deepEqual(digest(good.head), sharedHead);
assert.deepEqual(digest(good.core), zero);
assert.equal(submit(good, upgrade), 1);
assert.deepEqual(digest(good.head), sha(upgrade));
assert.deepEqual(digest(good.core), approved);
console.log('instance A, Core3.wasm:', candidate.length, 'bytes in', goodChunks, 'chunks, upgrade accepted, core', digest(good.core).toString('hex'));

stage(good, candidate, 65535);
const spent = packet(sha(upgrade), 3, 7, approved, u8(1), intent);
assert.equal(good.init(), 1);
assert.equal(submit(good, spent), 0);
assert.deepEqual(digest(good.head), sha(upgrade));
assert.deepEqual(digest(good.core), approved);
console.log('instance A, identical candidate and spent grant refused at next parent and sequence');

const bad = await granted('instance B');
const flipped = Buffer.from(candidate);
const changedAt = Math.floor(flipped.length / 2);
flipped[changedAt] ^= 1;
assert.notDeepEqual(sha(flipped), approved);
const badChunks = stage(bad, flipped, 4093);
assert.equal(submit(bad, upgrade), 0);
assert.deepEqual(digest(bad.core), zero);
assert.deepEqual(digest(bad.head), sharedHead);
console.log('instance B, byte at offset', changedAt, 'flipped,', badChunks, 'chunks, candidate SHA-256', sha(flipped).toString('hex'));
console.log('instance B, identical upgrade refused, core', digest(bad.core).toString('hex'), 'head', digest(bad.head).toString('hex'));

stage(bad, candidate, 65535);
assert.equal(submit(bad, upgrade), 1);
assert.deepEqual(digest(bad.core), approved);
assert.deepEqual(digest(bad.head), sha(upgrade));
console.log('instance B, original candidate accepted after restaging; refused attempt preserved grant');

const controls = await fresh();
input(controls, [0]);
assert.equal(controls.input(256), 0);
assert.equal(controls.feed(), 0);
assert.equal(controls.feed(), 0);
assert.equal(controls.input(0), 0);
assert.equal(controls.step(), 0);
assert.equal(controls.reset(), 1);
assert.deepEqual(digest(controls.head), zero);
assert.equal(submit(controls, packet(zero, 65537n, 3, intent, u8(1))), 0);
assert.equal(submit(controls, packet(zero, (1n << 63n) + 1n, 3, intent, u8(1))), 0);
assert.equal(submit(controls, grant), 1);
assert.equal(submit(controls, upgrade), 0);
assert.deepEqual(digest(controls.head), sharedHead);
assert.deepEqual(digest(controls.core), zero);
console.log('invalid chunk requires reset, missing candidate refused, high sequence bytes enforced');

const tools = {u8, u16, blob, text, install, sent, packet, sha, digest, submit, chain};
await exerciseEvents(await fresh(), tools);

const framing = await fresh();
const checkFrame = chain(framing);
checkFrame('maximum 65535-byte frame', 0, [text('A'.repeat(65535 - 43))]);
checkFrame('single- to four-byte UTF-8 boundary scalars', 0,
  [text(String.fromCodePoint(0, 127, 128, 2047, 2048, 55295, 57344, 65535, 65536, 1114111))]);
for (const invalid of [[0xc1, 0xbf], [0xe0, 0x9f, 0xbf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
  checkFrame('invalid UTF-8', 0, [blob(Buffer.from(invalid))], 0);
}
console.log('maximum size valid frame and strict UTF-8 boundaries passed');
