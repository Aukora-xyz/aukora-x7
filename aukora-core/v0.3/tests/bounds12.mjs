// Run separately for each release file to keep memory use sequential.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {blob, cat, host, owner, text} from './host.mjs';
import {safeControl} from './safe-fields.mjs';

const maxInput = 1024 * 1024 + 2 * 65535 + 128;
const maxStaged = 16 * 1024 * 1024;
const maxEntries = 512;
const maxRecordBytes = 2 * 1024 * 1024;
const maxPages = 4096;
const artifact = process.argv[2] ?? new URL('../aukora-core.wasm', import.meta.url);
const lite = String(artifact).endsWith('-lite.wasm');
const bytes = readFileSync(artifact);
const keys = owner();
const keyWire = cat(keys.edRaw, keys.mlRaw);
let checks = 0;
function pass(label) {
  checks++;
  console.log('PASS ' + label);
}
function leb(value) {
  const result = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    result.push(value ? byte | 128 : byte);
  } while (value);
  return Buffer.from(result);
}
function readLeb(bytes, cursor) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    assert.ok(cursor.pos < bytes.length);
    const b = bytes[cursor.pos++];
    value += (b & 127) * 2 ** (i * 7);
    if (b < 128) return value;
  }
  throw Error('invalid uint32 section length');
}
function checkMemory() {
  const cursor = {pos: 8};
  while (cursor.pos < bytes.length) {
    const start = cursor.pos;
    const id = bytes[cursor.pos++];
    const size = readLeb(bytes, cursor);
    const end = cursor.pos + size;
    assert.ok(end <= bytes.length);
    if (id !== 5) {
      cursor.pos = end;
      continue;
    }
    assert.equal(readLeb(bytes, cursor), 1);
    assert.equal(readLeb(bytes, cursor), 1, '32-bit, unshared memory with maximum');
    const initial = readLeb(bytes, cursor);
    assert.equal(readLeb(bytes, cursor), maxPages);
    assert.equal(cursor.pos, end);
    // The deployed memory is private. Exercise the engine with the exact memory
    // section copied verbatim to a probe that exports it, without editing the release.
    const probe = cat(bytes.subarray(0, 8), bytes.subarray(start, end), Buffer.of(7, 5, 1, 1, 109, 2, 0));
    const memory = new WebAssembly.Instance(new WebAssembly.Module(probe)).exports.m;
    new Uint8Array(memory.buffer)[0] = 67;
    assert.equal(memory.grow(maxPages - initial - 1), initial);
    assert.equal(memory.grow(1), maxPages - 1);
    assert.throws(() => memory.grow(1), RangeError);
    assert.equal(memory.buffer.byteLength, maxPages * 65536);
    assert.equal(new Uint8Array(memory.buffer)[0], 67);
    pass('release memory section min ' + initial + ', maximum ' + maxPages + ' pages; copied engine probe reaches maximum and refuses +1');
    return;
  }
  assert.fail('no memory section');
}
function fresh() {
  const h = host(bytes);
  assert.equal(h.consume(keyWire, 'init'), 1);
  return h;
}
function stateView(h) {
  const digest = f => Array.from({length: 32}, (_, i) => f(i));
  const a = h.api;
  return [digest(a.head), digest(a.core), digest(a.lawByte), a.threshold(), a.halted(),
    a.guessCeiling(), a.stampCount(), a.recordByte(h.historyLength(), 0), a.stampByte(a.stampCount(), 0)];
}
function say(h, body = '') { return h.unsigned(cat(Buffer.of(0), text(body))); }
function sizedStamp(h, size) {
  assert.ok(66 <= size && size <= 66 + 65535);
  return cat(h.header().subarray(0, 32), blob(Buffer.alloc(size - 66, 91)), Buffer.alloc(32, 121));
}
function stageTo(h, data, limit) {
  for (let offset = 0; offset < limit; offset += maxInput) {
    assert.equal(h.consume(data.subarray(offset, Math.min(limit, offset + maxInput)), 'feed'), 1);
  }
}
function paddedFile(target) {
  const extra = target - bytes.length;
  for (let count = 1; count <= 5; count++) {
    const bodySize = extra - 1 - count;
    if (bodySize < 1 || leb(bodySize).length !== count) continue;
    return cat(bytes, Buffer.of(0), leb(bodySize), Buffer.alloc(bodySize));
  }
  assert.fail('release did not fit under its advertised stage cap with a padding section');
}
function stage() {
  const h = fresh();
  for (const length of [maxInput - 1, maxInput]) {
    assert.equal(h.consume(Buffer.alloc(length), 'feed'), 1);
    assert.equal(h.api.reset(), 1);
  }
  h.load(Buffer.alloc(maxInput));
  assert.equal(h.api.input(0), 0);
  const before = stateView(h);
  assert.equal(h.api.feed(), 0);
  assert.deepEqual(stateView(h), before);
  pass('input assembler accepts max-1 and max; max+1 refuses without changing machine views');
  const padded = paddedFile(maxStaged);
  stageTo(h, padded, maxStaged - 1);
  assert.equal(h.consume(Buffer.alloc(2), 'feed'), 0, 'one byte over');
  assert.equal(h.consume(padded.subarray(-1), 'feed'), 1, 'remaining byte fits after rejection');
  assert.equal(h.consume(Buffer.of(27), 'installReason'), lite ? 12 : 9, 'profile verdict at exact capacity');
  assert.equal(h.consume(Buffer.of(91), 'feed'), 0);
  assert.deepEqual(stateView(h), before);
  assert.equal(h.consume(Buffer.of(27), 'installReason'), lite ? 12 : 9, 'same verdict after refused feed');
  assert.equal(h.consume(Buffer.alloc(0), 'feed'), 1, 'zero-length feed still fits exactly');
  assert.equal(h.api.reset(), 1);
  assert.equal(h.consume(Buffer.of(27), 'installReason'), lite ? 12 : 11, 'profile verdict after reset');
  pass('staging 16 MiB-1, overshoot refusal, last byte, exact capacity, +1 refusal, zero-byte feed and reset');
}
function count() {
  const h = fresh();
  const initial = say(h, 'quota');
  h.submit('one ordinary ledger entry', initial, true);
  const stamp = sizedStamp(h, 66);
  for (let i = 0; i < maxEntries - 2; i++) assert.equal(h.consume(stamp, 'stamp'), 1);
  assert.equal(h.api.stampCount(), maxEntries - 2);
  assert.equal(h.consume(stamp, 'stamp'), 1, '511 stamps and one frame');
  const before = stateView(h);
  assert.equal(h.consume(stamp, 'stamp'), 0);
  assert.equal(h.consume(say(h), 'step'), 0);
  assert.equal(h.api.recordByte(0, initial.length - 1), initial.at(-1));
  assert.equal(h.api.stampByte(maxEntries - 2, 65), stamp[65]);
  assert.deepEqual(stateView(h), before);
  pass('511, 512, 513 total entries, shared across ledger and sidecar; rejected stamp and frame leave views unchanged');
  const reference = fresh();
  reference.submit('same genesis and addressed parent', initial, true);
  const clear = safeControl(h, 51, keys, 0);
  assert.equal(reference.consume(clear, 'step'), 1, 'valid signed clear in available space');
  assert.equal(h.consume(clear, 'step'), 0, 'identical clear refused at terminal quota');
  assert.deepEqual(stateView(h), before);
  pass('same dual-signed recovery accepted with space and refused at the 512-entry cap');
}
function volume() {
  const h = fresh();
  const initial = say(h, 'volume');
  h.submit('ledger bytes also use session capacity', initial, true);
  let used = initial.length;
  const fillTo = maxRecordBytes - 90;
  let stampCount = 0;
  while (used < fillTo) {
    const length = Math.min(fillTo - used, 66 + 65535);
    assert.equal(h.consume(sizedStamp(h, length), 'stamp'), 1);
    used += length;
    stampCount++;
  }
  assert.ok(stampCount < maxEntries - 2);
  const before = stateView(h);
  assert.equal(h.consume(sizedStamp(h, 91), 'stamp'), 0);
  const oneByteTooMany = say(h, 'v'.repeat(47));
  assert.equal(oneByteTooMany.length, 91);
  assert.equal(h.consume(oneByteTooMany, 'step'), 0);
  assert.deepEqual(stateView(h), before);
  const exact = sizedStamp(h, 90);
  assert.equal(h.consume(exact, 'stamp'), 1);
  assert.equal(h.api.stampByte(stampCount, exact.length - 1), exact.at(-1));
  assert.equal(h.consume(sizedStamp(h, 66), 'stamp'), 0);
  assert.equal(h.api.stampCount(), stampCount + 1);
  assert.equal(h.api.stampByte(stampCount + 1, 0), 256);
  pass('2 MiB cumulative frame + stamp bytes, valid +1 refused by both routes, exact capacity admitted after refusals');
}
const suites = {memory: checkMemory, stage, count, volume};
const requested = process.argv[3];
if (requested) {
  assert.ok(Object.hasOwn(suites, requested), 'unknown bound suite ' + requested);
  suites[requested]();
} else {
  for (const suite of Object.values(suites)) suite();
}
console.log('PASS ' + checks + ' bound groups');
