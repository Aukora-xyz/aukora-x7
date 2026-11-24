// Fixed v0.5 verifier with independently issued hybrid grants. Each case has its
// own initialized instance. The supervisor can run one named case per invocation.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {boundInstall,cat,host,owner,packageWire,sha,text,timedGrant} from './host.mjs';

const read = path => readFileSync(new URL('../' + path,import.meta.url));
const base = read('aukora-core.wasm');
const part = (name,ext) => read('fixtures/packages/' + name + '.' + ext);
const full = part('supplement','model'), proof = part('supplement','proof.expr');
const cap = 1024 * 1024;
function varNat(n) {
  const out=[];
  do { const low=n%128; n=Math.floor(n/128); out.push(low+(n ? 128 : 0)); } while (n);
  return Buffer.from(out);
}
function name(s) {
  let field=Buffer.of(0);
  for (const piece of s.split('.')) {
    const bytes=Buffer.from(piece);
    field=cat(Buffer.of(1),field,varNat(bytes.length),bytes);
  }
  return field;
}
const constant = s => cat(Buffer.of(2),name(s),Buffer.of(0));
function replaceOnce(buf,old,value) {
  const at=buf.indexOf(old);
  assert.ok(at>=0 && at===buf.lastIndexOf(old),'expected one matching declaration or binder');
  return cat(buf.subarray(0,at),value,buf.subarray(at+old.length));
}
function paddedProof(limit) {
  const binder=name('foundation');
  assert.deepEqual(proof.subarray(2,2+binder.length),binder);
  const unchanged=proof.length-binder.length;
  for (let width=1; width<=4; width++) {
    const len=limit-full.length-unchanged-2-width;
    if (len<0 || varNat(len).length!==width) continue;
    const padded=cat(proof.subarray(0,2),Buffer.of(1,0),varNat(len),Buffer.alloc(len,0x70),
      proof.subarray(2+binder.length));
    assert.equal(full.length+padded.length,limit);
    return padded;
  }
  throw Error('no binder length for selected boundary');
}
function wrongU32(at,value) {
  return wire => { const changed=Buffer.from(wire); changed.writeUInt32LE(value,at); return changed; };
}

const specs=[];
const test=(id,expected,model=full,witness=proof,mutate=wire=>wire) =>
  specs.push({id,expected,model,witness,mutate});
// Mask bit 1 now checks the combined transition (law implication and grammar
// preservation). Bit 0 independently checks satisfaction on the carried model.
test('supplement-proof-control',8); // The supplement witness passes its own goal only.
const ownHeader=cat(Buffer.of(6,1),name('satisfaction'),Buffer.of(3),
  constant('Aukora.Root12.Supplement'),constant('Aukora.Safe11.fullModel'));
const zeroLet=cat(Buffer.of(6,1),name('padding'),constant('Nat'),Buffer.of(7,0));
const nested=cat(ownHeader,...Array.from({length:24},()=>zeroLet));
test('24-ordinary-let-scopes',8,full,replaceOnce(proof,ownHeader,nested));
test('valid-proof-other-goal',7,part('wrong-own','model'),part('wrong-own','proof.expr')); // Same full machine; the requested predicate differs.
test('valid-proof-other-model',8,replaceOnce(full,constant('Aukora.Safe11.fullModel'),constant('Aukora.Release.newest')));
const lastName=name('R9Candidate.successor');
test('pinned-name-collision',6,replaceOnce(full,lastName,name('Aukora.Safe11.fullModel')));
test('duplicate-local-name',6,replaceOnce(full,lastName,name('R9Candidate.claimedLaw')));
test('model-length-zero',9,full,proof,wrongU32(73,0));
test('proof-length-zero',9,full,proof,wrongU32(77+full.length,0));
test('audience-length-short',9,full,proof,wire=>{
  const changed=Buffer.from(wire), at=81+full.length+proof.length+33;
  changed.writeUInt16LE(changed.readUInt16LE(at)-1,at);
  return changed;
});
test('truncated-second-length',9,full,proof,wire=>wire.subarray(0,77+full.length+3));
const fewer=Buffer.from(full);
assert.equal(fewer[4],2);
fewer[4]=1;
test('declaration-count-short',6,fewer);
const firstName=name('R9Candidate.claimedLaw'), truncatedName=firstName.subarray(0,firstName.length-1);
test('model-name-truncated',5,cat(full.subarray(0,5),truncatedName));
test('proof-binder-truncated',2,full,proof.subarray(0,6));
test('one-mib-inert-binder',8,full,paddedProof(cap));
test('one-byte-over',9,full,paddedProof(cap+1));

// The final value in each public fixture is a constant with an empty universe
// argument list. Change its count to one with the required element absent at EOF.
function missingUniverse(bytes, finalConstant) {
  const suffix=constant(finalConstant);
  assert.deepEqual(bytes.subarray(-suffix.length),suffix);
  return cat(bytes.subarray(0,-1),Buffer.of(1));
}
test('model-universe-count-short',6,missingUniverse(full,'Aukora.Safe11.fullModel'));
test('proof-universe-count-short',2,full,missingUniverse(proof,'True.intro'));

// The canonical string length is a varNat byte count, shared by name pieces and
// expression literals. Exercise the literal path separately on each carrier.
const strong=part('strong','model'), label=Buffer.from('standard-genesis');
const literal=cat(Buffer.of(8),varNat(label.length),label);
const labelAt=strong.indexOf(literal);
assert.ok(labelAt>=0 && labelAt===strong.lastIndexOf(literal));
test('model-literal-text-short',5,strong.subarray(0,labelAt+literal.length-1));
test('proof-literal-text-short',2,full,
  cat(proof.subarray(0,-constant('True.intro').length),Buffer.of(8,2,0x61)));
test('declaration-count-varnat-truncated',5,cat(full.subarray(0,4),Buffer.of(0x80)));
test('proof-name-length-varnat-truncated',2,full,cat(proof.subarray(0,4),Buffer.of(0x80)));

const expectedWitnesses=new Map([['supplement-proof-control',1],['24-ordinary-let-scopes',1],
  ['valid-proof-other-goal',2],['valid-proof-other-model',0],['one-mib-inert-binder',1]]);
const keys=owner(), selected=process.argv.slice(2);
if (selected.length) for (const id of selected) assert.ok(specs.some(s=>s.id===id),'unknown checker case '+id);
let attempted=0, traps=0, slow=0, mismatch=0;
for (const spec of specs) {
  if (selected.length && !selected.includes(spec.id)) continue;
  const h=host(base), sectionName=Buffer.from('aukora.model.sha256');
  const section=cat(Buffer.of(sectionName.length),sectionName,sha(spec.model));
  const candidate=cat(base,Buffer.of(0,section.length),section), target=sha(candidate);
  assert.equal(h.consume(cat(keys.edRaw,keys.mlRaw),'init'),1);
  h.stage(candidate);
  const nonce=specs.indexOf(spec)+1;
  const intent=boundInstall(target,spec.model,spec.witness,0,nonce);
  h.submit('owner grant '+spec.id,timedGrant(keys,h.header(),intent,0,1000),true);
  const wire=spec.mutate(packageWire(h.header(),target,spec.model,spec.witness,intent));
  let verdict, reason, witnessMask, stepTime, diagnosticTime, witnessTime, usable=false, trapped=false, err;
  attempted++;
  try {
    h.load(wire);
    let start=performance.now();
    try { verdict=h.api.step(); } finally { stepTime=performance.now()-start; }
    assert.equal(verdict,0,'invalid package unexpectedly accepted');
    h.load(wire);
    start=performance.now();
    try { reason=h.api.installReason(); } finally { diagnosticTime=performance.now()-start; }
    assert.equal(reason,spec.expected,'first refusal');
    if (expectedWitnesses.has(spec.id)) {
      h.load(wire);
      start=performance.now();
      try { witnessMask=h.api.witnessMask(); } finally { witnessTime=performance.now()-start; }
      assert.equal(witnessMask,expectedWitnesses.get(spec.id),'independent satisfaction and transition checks');
    }
  } catch (e) {
    trapped=e instanceof WebAssembly.RuntimeError;
    err=e.message;
  }
  try {
    h.submit('speech after '+spec.id,h.unsigned(cat(Buffer.of(0),text('still active'))),true);
    usable=true;
  } catch (e) {
    trapped ||= e instanceof WebAssembly.RuntimeError;
    err=err || e.message;
  }
  traps+=Number(trapped);
  slow+=Number(stepTime>10000 || diagnosticTime>10000 || witnessTime>10000);
  mismatch+=Number(verdict!==0 || reason!==spec.expected || !!err || !usable || trapped);
  console.log(JSON.stringify({id:spec.id,model:spec.model.length,proof:spec.witness.length,
    verdict,reason,witnessMask,witness_ms:witnessTime?.toFixed(2),step_ms:stepTime?.toFixed(2),diagnostic_ms:diagnosticTime?.toFixed(2),usable,trapped,err}));
}
console.log('CHECKER CONTROLS',attempted,'submissions,',traps,'traps,',slow,'over 10 s,',mismatch,'unexpected outcomes');
if (mismatch) process.exitCode=1;
