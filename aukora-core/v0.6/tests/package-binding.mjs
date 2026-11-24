// Regression for the v0.6 fixed gate. Pass a candidate carrying the specified model
// plus a certificate. An explicit later refusal isolates package binding when a complete
// positive installation control is unavailable. Print that limitation in the result.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cat, sha, host, owner, boundInstall, timedGrant, packageWire} from './host.mjs';

const release = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const laterRefusal = args.indexOf('--expected-reason');
let expectedReason = 0;
if (laterRefusal >= 0) {
  expectedReason = Number(args.splice(laterRefusal,2)[1]);
  assert.ok([2,3,4,5,6,7,8].includes(expectedReason),'use a distinct certificate failure after binding');
}
assert.equal(args.length, 4, 'usage: node v0.6/tests/package-binding.mjs VERIFIER CANDIDATE_OR_--stage-own-file MODEL PROOF [--expected-reason 2..8]');
const stageOwnFile = args[1] === '--stage-own-file';
for (const [i,path] of args.entries()) {
  if (i === 1 && stageOwnFile) continue;
  const item = relative(release, resolve(path));
  assert.ok(item && !item.startsWith('..'), 'use v0.6 release artifacts');
}
const verifier=readFileSync(args[0]), model=readFileSync(args[2]), proof=readFileSync(args[3]);
const name=Buffer.from('aukora.model.sha256');
const section=cat(Buffer.of(name.length),name,sha(model));
const candidate=stageOwnFile ? cat(verifier,Buffer.of(0,section.length),section) : readFileSync(args[1]);
const h = host(verifier), keys = owner(), target = sha(candidate);
assert.equal(h.consume(cat(keys.edRaw,keys.mlRaw),'init'), 1);
h.stage(candidate);
const intent = boundInstall(target,model,proof,0,1);
const grant = timedGrant(keys,h.header(),intent,0,1000);
h.submit('hybrid grant for one exact package',grant,true);
const wire = packageWire(h.header(),target,model,proof,intent);
assert.ok(proof.length >= 220);
const proofStart = 81 + model.length;
function view() {
  const digest = f => Buffer.from(Array.from({length:32}, (_,i) => f(i))).toString('hex');
  return [digest(h.api.head),digest(h.api.core),digest(h.api.lawByte),h.api.threshold(),
    h.api.stampCount(),h.api.halted(),h.api.guessCeiling(),h.api.recordByte(1,0)];
}
const before = view();

// Confirm the new early refusal exists, to attribute the sweep to package binding.
const alternateAudience = Buffer.from(wire);
alternateAudience[wire.length - 5] ^= 1;
assert.equal(h.consume(alternateAudience,'installReason'),10);
assert.equal(h.consume(wire,'installReason'),expectedReason,'authentic package commitment passes binding');
console.log('Positive binding control: canonical signed package continued to diagnostic',expectedReason);

let tried = 0;
for (let i = 0; i < 220; i++) {
  const offset = proofStart + Math.floor(i * proof.length / 220);
  for (const bit of [1,128]) {
    wire[offset] ^= bit;
    assert.equal(h.consume(wire,'installReason'),10,'early commitment refusal');
    assert.equal(h.consume(wire,'step'),0,'changed proof under original grant');
    wire[offset] ^= bit;
    tried++;
    assert.deepEqual(view(),before,'refusal preserves release views and record length');
  }
}
if (expectedReason === 0) {
  h.submit('original exact bytes still install under the same grant',wire,true,target);
  for (let i=0; i<wire.length; i++) assert.equal(h.api.recordByte(1,i),wire[i]);
  assert.equal(h.api.recordByte(1,wire.length),256);
  console.log('PASS',tried,'single-bit proof changes, 0 admitted. Original installed and its exact frame was recorded.');
} else {
  assert.equal(h.consume(wire,'installReason'),expectedReason);
  h.submit('authentic package refused by the later certificate check',wire,false);
  h.submit('ordinary speech after sweep',h.unsigned(cat(Buffer.of(0,0,0))),true);
  console.log('PASS',tried,'single-bit proof changes, all diagnostic 10 and step 0, views unchanged.');
  console.log('No positive install control. The authentic package passed binding and failed certificate check',expectedReason);
}
