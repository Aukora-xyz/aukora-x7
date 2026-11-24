// Round 12c D: records started by bound genesis. Usage:
//   node tests/record-binding.mjs <core.wasm>            fresh keys, then the stored vectors
//   node tests/record-binding.mjs <core.wasm> --write    fresh keys, then rewrite the stored vectors
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {gunzipSync, gzipSync} from 'node:zlib';
import {blob, cat, deliver, dual, host, keyFields, owner, sha, text, timedGrant, u16, u64} from './host.mjs';
import {safeControl} from './safe-fields.mjs';
import {bytes32, genesisFor, rawKeys, signedSeal} from './segments.mjs';

const file = readFileSync(process.argv[2]);
const write = process.argv.includes('--write');
const vectorFile = new URL('../vectors/record-binding.json.gz', import.meta.url);
const tag = Buffer.from('AUKORA/R12C/record');

// Every call on every instance is logged so the run can be replayed as a vector.
const log = [];
function instance(name) {
  const h = host(file);
  const call = (op, bytes) => {
    const verdict = h.consume(bytes, op);
    log.push({name, op, hex: bytes.toString('hex'), verdict, head: bytes32(h.api.head).toString('hex')});
    return verdict;
  };
  const submit = (label, wire, expected) => {
    h.submit(label, wire, expected);
    log.push({name, op: 'step', hex: wire.toString('hex'), verdict: Number(expected), head: bytes32(h.api.head).toString('hex')});
  };
  return {h, call, submit};
}

function bound(name, keys, value) {
  const x = instance(name);
  assert.equal(x.call('initBound', cat(rawKeys(keys), value)), 1, name + ' bound genesis');
  const descriptor = cat(tag, bytes32(x.h.api.lawByte), rawKeys(keys), value);
  x.h.acceptGenesis(descriptor);
  assert.deepEqual(bytes32(x.h.api.recordIdByte), sha(descriptor), name + ' identifier');
  x.descriptor = descriptor;
  return x;
}

const keys = owner(), keys2 = owner(), keys3 = owner();
const hostA = randomBytes(32), hostB = Buffer.from(hostA);
hostB[31] ^= 1; // one changed bit
const A = bound('A', keys, hostA), B = bound('B', keys, hostB);
const C = instance('C');
assert.equal(C.call('init', rawKeys(keys)), 1);
assert.equal(C.h.api.recordIdByte(0), 256, 'an old-mode record has no identifier');
assert.deepEqual(bytes32(C.h.api.head), Buffer.alloc(32), 'old genesis keeps head zero');
const idA = bytes32(A.h.api.recordIdByte);
assert.notDeepEqual(idA, bytes32(B.h.api.recordIdByte));
console.log('PASS two bound records, same owner keys, host values one bit apart, different identifiers');

// For one head-signed kind: A's bytes are refused by B and by the old record C (heads
// unchanged), admitted by A, and B's own bytes of the same kind are admitted by B.
const archive = []; // A's accepted operations, for replay
function kind(label, make) {
  const wa = make(A.h), wb = make(B.h);
  const headB = bytes32(B.h.api.head), headC = bytes32(C.h.api.head);
  assert.equal(B.call('step', wa), 0, label + ' signed for A, at B');
  assert.deepEqual(bytes32(B.h.api.head), headB);
  assert.equal(C.call('step', wa), 0, label + ' signed for A, at old-mode C');
  assert.deepEqual(bytes32(C.h.api.head), headC);
  A.submit(label + ' (A)', wa, true);
  archive.push(['step', wa]);
  B.submit(label + ' (B, its own bytes)', wb, true);
  console.log('REFUSED BY THE OTHER RECORD', label);
}

const intent = deliver(Buffer.from('pay the supplier'), 0, 7);
kind('timed approval', h => timedGrant(keys, h.header(), intent, 0, 400));
kind('cancel', h => {
  const msg = cat(text('AUKORA/R9/revoke'), keyFields(keys), u64(0), h.header(), sha(intent));
  const s = dual(keys, msg);
  return cat(Buffer.of(25), h.header(), sha(intent), s.edSig, s.mlSig);
});
kind('threshold', h => {
  const msg = cat(text('AUKORA/R8/threshold'), keyFields(keys), u64(0), h.header(), Buffer.of(64));
  const s = dual(keys, msg);
  return cat(Buffer.of(22), h.header(), Buffer.of(64), s.edSig, s.mlSig);
});
kind('signed control (mandate)', h => h.control(keys,
  cat(Buffer.of(10), text('service'), blob(Buffer.from('report')), u16(0), u16(2), u16(65535)), 0));
kind('halt', h => safeControl(h, 50, keys, 0));
kind('clear', h => safeControl(h, 51, keys, 0));
kind('key change (ff 02)', h => safeControl(h, 53, keys, 0, {newKeys: keys2}));
assert.deepEqual(bytes32(A.h.api.recordIdByte), idA, 'identifier unchanged after key change');

// Seal: A's trailer is refused by B's seal port; then both seal and continue.
const trailerA = signedSeal(A.h, keys2);
assert.equal(B.call('seal', trailerA), 0, 'seal trailer of A at B');
assert.equal(B.h.api.sealByte(0), 256);
assert.equal(A.call('seal', trailerA), 1);
archive.push(['seal', trailerA]);
const nextA = genesisFor(A.h, keys2, trailerA);
assert.equal(A.call('continueRecord', nextA), 1);
archive.push(['continueRecord', nextA]);
A.h.acceptGenesis(nextA);
const trailerB = signedSeal(B.h, keys2);
assert.equal(B.call('seal', trailerB), 1);
const nextB = genesisFor(B.h, keys2, trailerB);
assert.equal(B.call('continueRecord', nextB), 1);
B.h.acceptGenesis(nextB);
assert.deepEqual(bytes32(A.h.api.recordIdByte), idA, 'identifier unchanged after seal and continuation');
console.log('REFUSED BY THE OTHER RECORD seal');
console.log('PASS identifier read after genesis, after key change, after seal and continuation: unchanged');

// The limit the v0.9 root forced (forms that sign no head could be re-wrapped) is CLOSED in this core
// (root v2 step 3a): a bound record refuses both old forms, its own and re-wrapped ones.
const rewrap = (wire, at, h) => cat(wire.subarray(0, at), h.header(), wire.subarray(at + 40));
const second = deliver(Buffer.from('second payment'), 1, 9);
const approvalA = A.h.grant(keys2, second);
A.submit('plain approval (A), refused in a bound record', approvalA, false);
B.submit('plain approval of A, re-wrapped under B', rewrap(approvalA, 1 + 3309, B.h), false);
console.log('CLOSED IN THIS CORE plain approval (tag 13 hex) refused by both bound records');
const legacyA = A.h.rebind(keys2, keys3, 1);
A.submit('legacy key change (A), refused in a bound record', legacyA, false);
B.submit('legacy key change of A, re-wrapped under B', rewrap(legacyA, 1 + 1952 + 3309, B.h), false);
console.log('CLOSED IN THIS CORE legacy key change (tag 14 hex) refused by both bound records');
assert.deepEqual(bytes32(A.h.api.recordIdByte), idA);

// Replay: the archive under A's descriptor reproduces A; under B's descriptor
// (one host bit apart) the very first line is refused.
const replay = (value, expectFirst) => {
  const x = host(file);
  assert.equal(x.consume(cat(rawKeys(keys), value), 'initBound'), 1);
  const results = archive.map(([op, bytes]) => x.consume(bytes, op));
  if (expectFirst) {
    assert.ok(results.every(v => v === 1), 'every archived operation replays');
    assert.deepEqual(bytes32(x.api.head), bytes32(A.h.api.head), 'same head in a fresh instance');
    assert.deepEqual(bytes32(x.api.recordIdByte), idA);
  } else {
    assert.equal(results[0], 0, 'first archived line refused under another descriptor');
  }
};
replay(hostA, true);
replay(hostB, false);
console.log('PASS bound record replays to the same head; a one-bit descriptor change refuses it from line one');

// Stored vectors: every logged call, replayed on this file.
if (write) {
  const vec = {hostA: hostA.toString('hex'), hostB: hostB.toString('hex'), keys: rawKeys(keys).toString('hex'), log};
  writeFileSync(vectorFile, gzipSync(JSON.stringify(vec)));
  console.log('WROTE', log.length, 'vector entries');
} else if (existsSync(vectorFile)) {
  const vec = JSON.parse(gunzipSync(readFileSync(vectorFile)));
  const insts = {};
  let n = 0;
  for (const e of vec.log) {
    insts[e.name] ??= host(file);
    const got = insts[e.name].consume(Buffer.from(e.hex, 'hex'), e.op);
    assert.equal(got, e.verdict, `vector ${n} ${e.name} ${e.op}`);
    assert.equal(bytes32(insts[e.name].api.head).toString('hex'), e.head, `vector ${n} head`);
    n++;
  }
  console.log('PASS', n, 'stored record-binding vectors: same verdicts and heads');
}
console.log('PASS record-binding');
