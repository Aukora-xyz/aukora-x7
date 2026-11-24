import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {cat, sha, u16, u32, blob, text, owner, install, deliver, host} from './test-host.mjs';

const old = owner(), fresh = owner();
const h = host(), payload = Buffer.of(42), firstIntent = deliver(payload, 0, 1);
const pairInit = cat(old.edRaw, old.mlRaw);
assert.equal(h.consume(old.edRaw, 'init'), 0, 'old one-key genesis');
assert.equal(h.consume(pairInit, 'init'), 1, 'two-key genesis');
assert.equal(h.consume(cat(fresh.edRaw, fresh.mlRaw), 'init'), 0, 'genesis cannot replace current owner');
const {unsigned, grant, rebind, control} = h;

h.submit('grant only Ed25519 good', grant(old, firstIntent, true, false), false);
h.submit('grant only ML-DSA-65 good', grant(old, firstIntent, false, true), false);
const firstGrant = grant(old, firstIntent);
h.submit('unsigned envelope carrying only the Ed25519 grant', cat(Buffer.of(0), firstGrant.subarray(3310)), false);
const expectedHead = sha(firstGrant), times = [];
for (let i = 0; i < 14; i++) {
  h.load(firstGrant);
  const t = performance.now();
  const firstByte = h.api.hashHead();
  const ms = performance.now()-t;
  assert.equal(firstByte, expectedHead[0], 'isolated production head function');
  if (i >= 3) times.push(ms);
}
times.sort((a,b) => a-b);
const stepMs = h.submit('grant signed by both owners’ algorithms', firstGrant, true);
console.log('Genesis bytes', pairInit.length, '; grant wire bytes', firstGrant.length,
  '; head calculation median ms', times[5].toFixed(3), '(11 warmed calls; includes in-Wasm unpack/copy, excludes host byte transfer)',
  '; full accepted grant step ms', stepMs.toFixed(3));
h.submit('replayed grant nonce at current head', grant(old, firstIntent), false);
h.submit('ordinary line', unsigned(cat(Buffer.of(0), text('hybrid'))), true);

function testControl(label, fields) {
  h.submit(label + ' only Ed good', control(old, fields, 0, true, false), false);
  h.submit(label + ' only ML good', control(old, fields, 0, false, true), false);
  h.submit(label + ' both good', control(old, fields, 0), true);
}
testControl('retract', cat(Buffer.of(9), u16(1)));
testControl('mandate', cat(Buffer.of(10), text('service'), blob(payload), u16(0), u16(1), u16(100)));
testControl('budget', cat(Buffer.of(12), u16(0), u16(5)));
const passID = h.historyLength();
testControl('reader pass', cat(Buffer.of(14), text('guest'), text('lab'), u16(0), u16(100)));
testControl('revoke pass', cat(Buffer.of(15), u16(passID)));

h.submit('rebind only Ed good', rebind(old, fresh, 0, true, false), false);
h.submit('rebind only ML good', rebind(old, fresh, 0, false, true), false);
const binding = rebind(old, fresh, 0);
const substituted = Buffer.from(binding);
substituted[8] ^= 1;
h.submit('substituted new ML key after both signatures', substituted, false);
h.submit('rebind signed by both old keys', binding, true);
console.log('Rebind wire bytes', binding.length);
h.submit('consume pre-rebind grant', unsigned(cat(Buffer.of(4), firstIntent)), false);
const afterIntent = deliver(payload, 1, 1);
h.submit('old pair signing current owner domain after rebind', grant(fresh, afterIntent, true, true, old), false);
h.submit('old Ed and new ML signing current domain', grant(fresh, afterIntent, true, true, {ed:old.ed, ml:fresh.ml}), false);
h.submit('new Ed and old ML signing current domain', grant(fresh, afterIntent, true, true, {ed:fresh.ed, ml:old.ml}), false);
h.submit('new pair after rebind', grant(fresh, afterIntent), true);

const mainBytes = readFileSync('core/Core6.wasm'), altBytes = readFileSync('core/FixedOwner6.wasm');
const main = sha(mainBytes), alt = sha(altBytes);
const proof = readFileSync('logs/r7/model.proof.expr'), altProof = readFileSync('logs/r7/other.proof.expr');
const wrong = readFileSync('logs/r6/wrong_digest.proof.expr');
const a = install(main, 1, 2), b = install(alt, 1, 3);
const upgrade = (target, cert, permit) => unsigned(cat(Buffer.of(18), target, u32(cert.length), cert, permit));
h.stage(mainBytes);
h.submit('matching Lawful certificate without grant', upgrade(main, proof, a), false);
h.submit('both signatures on installation grant', grant(fresh, a), true);
h.submit('round six wrong_digest certificate', upgrade(main, wrong, a), false);
h.submit('other candidate certificate for Core6', upgrade(main, altProof, a), false);
h.submit('legacy proofChecked=true for Core6', unsigned(cat(Buffer.of(7), main, Buffer.of(1), a)), false);
h.submit('Core6 staged with its own Lawful certificate and grant', upgrade(main, proof, a), true, main);
h.submit('replayed Core6 grant', upgrade(main, proof, a), false);
h.submit('both signatures on alternate installation grant', grant(fresh, b), true);
h.stage(mainBytes);
h.submit('alternate grant and certificate with wrong staged bytes', upgrade(alt, altProof, b), false);
h.stage(altBytes);
h.submit('Core6 certificate for alternate candidate', upgrade(alt, proof, b), false);
h.submit('FixedOwner6 staged with its own Lawful certificate and grant', upgrade(alt, altProof, b), true, alt);
console.log('PASS Core8 hybrid stateful tests: each verdict and the complete resulting head and core digest matched the independent expectations.');
