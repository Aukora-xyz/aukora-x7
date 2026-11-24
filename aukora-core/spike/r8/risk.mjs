import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {blob, cat, deliver, dual, evidence, host, install, keyFields, owner, sha, text, u16, u32, u64} from './test-host.mjs';

const h = host(), keys = owner(), next = owner();
assert.equal(h.api.threshold(), 256);
assert.equal(h.consume(cat(keys.edRaw, keys.mlRaw), 'init'), 1);
assert.equal(h.api.threshold(), 0);

const threshold = (value, goodEd = true, goodMl = true, active = keys, generation = 0, signer = active) => {
  const header = h.header();
  const msg = cat(text('AUKORA/R8/threshold'), keyFields(active), u64(generation), header, Buffer.of(value));
  const {edSig, mlSig} = dual(signer, msg, goodEd, goodMl);
  return cat(Buffer.of(22), header, Buffer.of(value), edSig, mlSig);
};
const assessment = (intent, score, bundle) => cat(Buffer.of(21), h.header(), sha(intent), Buffer.of(score), bundle);
const request = (route, bundle) => cat(Buffer.of(23), bundle, h.header(), route);
const fromGrant = intent => cat(Buffer.of(4), intent);
const fromMandate = (id, intent) => cat(Buffer.of(11), u16(id), Buffer.of(4), intent);
const missingBundle = intent => sha(cat(
  text('AUKORA/R8/missing:request-intent-only;evidence=missing;reasoning=missing;witness=missing;versions=missing'), sha(intent)));

function audit(id, expected) {
  const bytes = Buffer.from(Array.from({length: expected.length}, (_, index) => {
    const byte = h.api.recordByte(id, index);
    assert.ok(byte >= 0 && byte <= 255, 'missing record byte');
    return byte;
  }));
  assert.deepEqual(bytes, expected);
  assert.equal(h.api.recordByte(id, expected.length), 256);
}

h.submit('threshold with only the Ed25519 signature valid', threshold(255,true,false), false);
h.submit('threshold with only the ML-DSA signature valid', threshold(255,false,true), false);
assert.equal(h.api.threshold(), 0);
const firstId = h.historyLength(), firstThreshold = threshold(255);
h.submit('threshold to maximum with both signatures', firstThreshold, true);
assert.equal(h.api.threshold(), 255);
audit(firstId, firstThreshold);
const payload = Buffer.from('deliver sample');
const mandate = cat(Buffer.of(10), text('service'), blob(payload), u16(0), u16(20), u16(1000));
const mandateId = h.historyLength();
h.submit('standing mandate', h.control(keys, mandate, 0), true);

const unknown = deliver(payload, 0, 31);
const noEvidence = missingBundle(unknown);
const impostor = evidence(unknown, 'one witness', 'assessed', 'low', 'risk@v2');
h.submit('unassessed mandate at maximum threshold', request(fromMandate(mandateId, unknown), noEvidence), false);
h.submit('unassessed intent without fresh grant', request(fromGrant(unknown), noEvidence), false);
h.submit('sign exact grant for unassessed intent', h.grant(keys, unknown), true);
h.submit('unassessed grant with invented bundle', request(fromGrant(unknown), impostor), false);
const unassessed = request(fromGrant(unknown), noEvidence);
const missingId = h.historyLength();
h.submit('missing assessment at maximum score, exact grant and canonical missing-evidence digest', unassessed, true);
audit(missingId, unassessed);
h.submit('reuse consumed grant on unassessed intent', request(fromGrant(unknown), noEvidence), false);

const permissive = threshold(64);
h.submit('owner moves threshold to 64', permissive, true);
assert.equal(h.api.threshold(), 64);
h.submit('threshold signature over obsolete header', firstThreshold, false);
assert.equal(h.api.threshold(), 64);

const intent = deliver(payload, 0, 32), different = deliver(payload, 0, 33);
const bundle = evidence(intent, 'local receipt 1', 'recipient verified', 'low', 'risk@1,witness@2');
const newer = evidence(intent, 'local receipt 2', 'recipient changed', 'hold', 'risk@1,witness@2');
const high = evidence(intent, 'local receipt 3', 'recipient untrusted', 'owner needed', 'risk@2,witness@2');
const assessmentId = h.historyLength(), lowAssessment = assessment(intent, 63, bundle);
h.submit('record 63, below threshold 64', lowAssessment, true);
audit(assessmentId, lowAssessment);
h.submit('another intent cannot use this assessment', request(fromMandate(mandateId,different), bundle), false);
h.submit('low score with nonexistent mandate', request(fromMandate(65535,intent), bundle), false);
h.submit('low score without a grant or mandate', request(fromGrant(intent), bundle), false);
h.submit('low score with incorrect bundle', request(fromMandate(mandateId,intent), newer), false);
h.submit('legacy mandate act without bundle', h.unsigned(fromMandate(mandateId, intent)), false);
const lowId = h.historyLength(), lowAct = request(fromMandate(mandateId, intent), bundle);
h.submit('63 admits via standing mandate and exact evidence bundle', lowAct, true);
audit(lowId, lowAct);
console.log('Host SHA-256 input: u32LE length and bytes for each of five fields in order.',
  'Request', intent.toString('hex'), 'evidence "local receipt 1", reasoning summary "recipient verified",',
  'witness verdict "low", model versions "risk@1,witness@2".');
console.log('Admitted low-risk act at history ID', lowId, 'names evidence bundle', bundle.toString('hex'));

const atAssessment = assessment(intent,64,newer), atId = h.historyLength();
h.submit('reassess same intent at the threshold', atAssessment, true);
h.submit('equality excludes standing mandate', request(fromMandate(mandateId,intent), newer), false);
h.submit('equality, old bundle cannot reverse re-assessment', request(fromMandate(mandateId,intent), bundle), false);
h.submit('equality with no grant', request(fromGrant(intent), newer), false);
h.submit('fresh grant for different intent', h.grant(keys, different), true);
h.submit('different grant cannot admit equal-score intent', request(fromGrant(intent), newer), false);
h.submit('raise same intent above threshold', assessment(intent,65,high), true);
h.submit('above threshold, mandate', request(fromMandate(mandateId,intent), high), false);
h.submit('fresh grant for the exact high-score intent', h.grant(keys,intent), true);
h.submit('grant cannot be spent through the mandate route', request(fromMandate(mandateId,intent), high), false);
h.submit('legacy bare act with a valid grant', h.unsigned(fromGrant(intent)), false);
h.submit('fresh grant with stale assessment bundle', request(fromGrant(intent), newer), false);
const highId = h.historyLength(), highAct = request(fromGrant(intent), high);
h.submit('above threshold, consume exact grant and name latest bundle', highAct, true);
h.submit('spent grant cannot admit the intent again', request(fromGrant(intent), high), false);
audit(lowId, lowAct);
audit(atId, atAssessment);
audit(highId, highAct);
assert.equal(h.api.recordByte(h.historyLength(), 0), 256);

h.submit('set threshold to maximum for floor cases', threshold(255), true);
const bytes = readFileSync('core/Core6.wasm'), target = sha(bytes);
const proof = readFileSync('logs/r7/model.proof.expr');
const permit = install(target, 0, 34);
const upgradeEvidence = evidence(permit, 'local artifact', 'matches prior digest', 'low', 'risk@1');
h.submit('record minimum score for installation intent', assessment(permit, 0, upgradeEvidence), true);
h.stage(bytes);
h.submit('upgrade with valid certificate, minimum score and no signed grant',
  h.unsigned(cat(Buffer.of(18), target, u32(proof.length), proof, permit)), false);
h.submit('rebind with only Ed25519 at maximum threshold', h.rebind(keys, next, 0, true, false), false);
h.submit('rebind with only ML-DSA at maximum threshold', h.rebind(keys, next, 0, false, true), false);
h.submit('both signatures still authorize rebind', h.rebind(keys, next, 0), true);
h.submit('old owner signs threshold in current owner domain after rebind', threshold(0,true,true,next,1,keys), false);
assert.equal(h.api.threshold(), 255);
h.submit('new owner signs threshold for the current generation', threshold(17,true,true,next,1), true);
assert.equal(h.api.threshold(), 17);
audit(assessmentId, lowAssessment);
audit(lowId, lowAct);
audit(highId, highAct);
console.log('PASS risk policy in Core8: threshold, missing, below, equal, above, exact grants, owner floor and historical bundle bytes.');
