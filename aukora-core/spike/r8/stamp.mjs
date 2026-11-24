import assert from 'node:assert/strict';
import {blob, cat, deliver, dual, evidence, host, keyFields, owner, sha, text, u16, u64} from './test-host.mjs';

const h = host(), keys = owner();
const stamp = (parent, beacon, receipt) => cat(parent, blob(beacon), receipt);
const digest = reader => Buffer.from(Array.from({length: 32}, (_, i) => reader(i)));
const {stampCount, stampByte, recordByte, core, head, threshold} = h.api;
function readExact(reader, index, expected) {
  for (const [offset, byte] of expected.entries()) {
    assert.equal(reader(index, offset), byte, 'record ' + index + ', offset ' + offset);
  }
  assert.equal(reader(index, expected.length), 256);
}
const blank = Buffer.alloc(32), noBeacon = Buffer.alloc(0);
const genesisStamp = stamp(blank, noBeacon, blank);
assert.equal(stampCount(), 0);
assert.equal(h.consume(genesisStamp, 'stamp'), 0, 'no current head before initialization');
assert.equal(h.consume(cat(keys.edRaw, keys.mlRaw), 'init'), 1);
assert.equal(h.consume(genesisStamp, 'stamp'), 1, 'opaque empty beacon and zero receipt at genesis');
assert.equal(stampCount(), 1);
readExact(stampByte, 0, genesisStamp);

const header = h.header(), level = Buffer.of(64);
const signed = dual(keys, cat(text('AUKORA/R8/threshold'), keyFields(keys), u64(0), header, level));
const setting = cat(Buffer.of(22), header, level, signed.edSig, signed.mlSig);
h.submit('stamp test threshold', setting, true);
const payload = Buffer.from('last admissible position'), intent = deliver(payload, 0, 52);
const bundle = evidence(intent, 'sample', 'authorized recipient', 'pass', 'model-a,model-b');
const assess = cat(Buffer.of(21), h.header(), sha(intent), Buffer.of(63), bundle);
h.submit('assess below threshold', assess, true);
const mandateId = h.historyLength();
const mandate = h.control(keys, cat(Buffer.of(10), text('service'), blob(payload), u16(0), u16(1), u16(4)), 0);
h.submit('issue one use, inclusive expiry at sequence four', mandate, true);
const act = cat(Buffer.of(23), bundle, h.header(), Buffer.of(11), u16(mandateId), Buffer.of(4), intent);
const before = digest(head), installed = digest(core);
assert.equal(h.header().readBigUInt64LE(32), 4n);
assert.equal(threshold(), 64);
const receipts = [sha(Buffer.from('opaque receipt A')), sha(Buffer.from('opaque receipt B'))];
const beaconA = Buffer.from('arbitrary beacon bytes; unverified');
const beaconB = Buffer.from(Array.from({length: 257}, (_, i) => (i * 19) & 255));
const first = stamp(before, beaconA, receipts[0]), second = stamp(before, beaconB, receipts[1]);

function submit(label, wire, expected) {
  const count = stampCount();
  assert.equal(h.consume(wire, 'stamp'), Number(expected), label);
  assert.equal(stampCount(), count + Number(expected), label + ' stamp count');
  assert.deepEqual(digest(head), before, label + ' head');
  assert.deepEqual(digest(core), installed, label + ' core');
  assert.equal(threshold(), 64);
  console.log(expected ? 'ACCEPT' : 'REFUSE', label);
}
submit('stale genesis head', genesisStamp, false);
submit('truncated receipt', first.subarray(0, -1), false);
submit('extra receipt byte', cat(first, Buffer.of(0)), false);
submit('missing header byte', first.subarray(0,31), false);
submit('beacon length consumes part of receipt', cat(before, u16(beaconA.length+1), beaconA, receipts[0]), false);
submit('first bracket for current head', first, true);
submit('second independent bracket for same head', second, true);
readExact(stampByte, 0, genesisStamp);
readExact(stampByte, 1, first);
readExact(stampByte, 2, second);
assert.equal(stampByte(3, 0), 256);
readExact(recordByte, 0, setting);
readExact(recordByte, 1, assess);
readExact(recordByte, 2, mandate);
assert.equal(recordByte(3, 0), 256, 'stamp consumes no action record position');

h.submit('prebuilt act uses mandate at inclusive expiry after both stamps', act, true);
assert.notDeepEqual(digest(head), before);
assert.equal(h.consume(first, 'stamp'), 0, 'old signed-over head is now stale');
const final = stamp(digest(head), Buffer.from([0xfe,0x00,0xff]), blank);
assert.equal(h.consume(final, 'stamp'), 1);
assert.equal(stampCount(), 4);
for (const [i, wire] of [genesisStamp, first, second, final].entries()) readExact(stampByte, i, wire);
for (const [i, wire] of [setting, assess, mandate, act].entries()) readExact(recordByte, i, wire);
assert.equal(recordByte(4,0), 256);
console.log('PASS four opaque stamp records across three heads. Exact prior bytes survived. The prebuilt action still used its single mandate at sequence four. Beacon and receipt verification is external.');
