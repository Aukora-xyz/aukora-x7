// Each negative package has its own authorized digest, correct current header, and
// matching model section. A refusal keeps the entire head and installed digest.
import assert from 'node:assert/strict';
import {createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {cat, deliver, domain, dual, host, install, owner, sha, u32, u64} from './host.mjs';

const dir = 'v0.1/.work/package/';
const candidate = readFileSync('v0.1/fixtures/fixed-genesis.wasm');
const historical = readFileSync('core/FixedGenesis9.wasm');
const model = readFileSync(dir + 'honest.model');
const proof = readFileSync(dir + 'honest.proof.expr');
const oldProof = readFileSync(dir + 'legacy.proof.expr');
const oldModel = readFileSync('logs/r9/honest.model');
const edModel = readFileSync(dir + 'ed-only.model');
const target = sha(candidate);
const custom = 'aukora.model.sha256';
const zero = Buffer.alloc(32);
const sectionDigest = buf => WebAssembly.Module.customSections(new WebAssembly.Module(buf), custom)
  .map(x => Buffer.from(x));
const upgrade = (header, digest, carried, term, grant) => cat(Buffer.of(27), header, digest,
  u32(carried.length), carried, u32(term.length), term, grant);
assert.deepEqual(sectionDigest(candidate), [sha(model)]);
assert.deepEqual(sectionDigest(historical), [sha(oldModel)]);

const active = owner();
const initial = cat(active.edRaw, active.mlRaw);
if (process.argv.includes('--record-public')) {
  const fixture = 'v0.1/fixtures/install';
  mkdirSync(fixture, {recursive:true});
  const intent = install(target,0,1);
  const {edSig,mlSig} = dual(active,cat(domain('grant',active),intent));
  const grant = cat(Buffer.of(19),mlSig,zero,u64(1),Buffer.of(3),intent,edSig);
  const frame = upgrade(cat(sha(grant),u64(2)),target,model,proof,intent);
  for (const [file,data] of [['keys',initial],['grant',grant],['upgrade',frame]]) {
    writeFileSync(fixture+'/'+file+'.bin',data,{flag:'wx'});
  }
  console.log('Recorded public grant and install frames for', target.toString('hex'));
  process.exit(0);
}

const h = host();
assert.equal(h.consume(initial,'init'),1);

function fixtureEd(n) {
  const lines = readFileSync('spike/r5/rfc8032.txt','utf8').split('\n');
  const seed = Buffer.from(lines.find(l => l.startsWith(n+' ')).split(' ')[1],'hex');
  const privateKey = createPrivateKey({format:'der', type:'pkcs8',
    key:cat(Buffer.from('302e020100300506032b657004220420','hex'),seed)});
  const publicKey = createPublicKey(privateKey);
  return {...active, ed:{privateKey,publicKey}, edRaw:publicKey.export({format:'der',type:'spki'}).subarray(-32)};
}
const oldFixed = fixtureEd(2);
const delivery = deliver(Buffer.from('fixture'),0,3);

// Exercise the historical binary exactly as it was linked and patched in round nine.
const old = host(historical);
assert.equal(old.consume(active.edRaw,'init'),1);
const historicalIntent = install(sha(historical),0,1);
const edSingle = cat(zero,u64(1),Buffer.of(3),historicalIntent,
  sign(null,cat(Buffer.from('AUKORA/R5/grant'),historicalIntent),oldFixed.ed.privateKey));
old.submit('historical file accepts a grant signed only by RFC Ed25519 key 2', edSingle, true);

let nonce = 1;
function stageGrant(file, label) {
  const digest = sha(file);
  const intent = install(digest,0,nonce++);
  h.stage(file);
  h.submit('current owner hybrid grant: ' + label,h.grant(active,intent),true);
  return {digest,intent};
}

const oldAuth = stageGrant(historical,'unmodified historical successor');
const exactOldProof = readFileSync('logs/r9/honest.proof.expr');
h.submit('historical Ed25519-only successor, original model and proof',
  upgrade(h.header(),oldAuth.digest,oldModel,exactOldProof,oldAuth.intent),false);

// Keep the identical old executable code, change its custom-section digest to the
// release-interface model. The final carried name matches the good submission.
const adapted = cat(historical.subarray(0,-32),sha(edModel));
assert.deepEqual(sectionDigest(adapted),[sha(edModel)]);
const edAuth = stageGrant(adapted,'historical executable with release-interface model');
h.submit('Ed25519-only successor, new model and proof of lawful fixed genesis',
  upgrade(h.header(),edAuth.digest,edModel,proof,edAuth.intent),false);
h.submit('Ed25519-only successor, new model and round-seven Lawful theorem',
  upgrade(h.header(),edAuth.digest,edModel,oldProof,edAuth.intent),false);

const {intent} = stageGrant(candidate,'newest fixed-genesis successor');
h.submit('newest candidate, exact archived round-seven proof bytes',
  upgrade(h.header(),target,model,readFileSync('logs/r7/model.proof.expr'),intent),false);
h.submit('newest candidate, same valid install grant, old Lawful theorem',
  upgrade(h.header(),target,model,oldProof,intent),false);
h.submit('newest candidate, new pinned law and matching proof',
  upgrade(h.header(),target,model,proof,intent),true,target);
const selected = Buffer.from(Array.from({length:32},(_,i)=>h.api.core(i)));
assert.deepEqual(selected, target);

const upgraded = host(candidate);
assert.equal(upgraded.consume(active.edRaw,'init'),0);
const invalidEd = cat(Buffer.of(1),Buffer.alloc(31),active.mlRaw);
assert.equal(upgraded.consume(invalidEd,'init'),0);
assert.equal(upgraded.consume(initial,'init'),1);
upgraded.submit('newly instantiated successor refuses the old Ed-only frame',edSingle,false);
upgraded.submit('supplied owner signs with both supplied keys',upgraded.grant(active,delivery),false);
const published = readFileSync('v0.1/fixtures/fixed-owner/grant.bin');
assert.equal(published[0],19);
const noML = Buffer.from(published);
noML.fill(0,1,3310);
const noEd = Buffer.from(published);
noEd.fill(0,noEd.length-64);
upgraded.submit('published fixed-owner grant with only its original Ed25519 signature',noML,false);
upgraded.submit('published fixed-owner grant with only its original ML-DSA signature',noEd,false);
upgraded.submit('unaltered archival grant signed by both compiled-in owners',published,true);
console.log('PASS ledger-selected file loaded; new fixed genesis and both verifiers observed; SHA-256',selected.toString('hex'));
