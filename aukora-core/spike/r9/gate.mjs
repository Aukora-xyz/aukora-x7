import assert from 'node:assert/strict';
import {createPrivateKey, randomBytes, sign} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {cat, sha, u32, u64, owner, install, host, domain, dual, keyFields, text} from './test-host.mjs';

const keys = owner();
const candidate = readFileSync('core/FixedGenesis9.wasm');
const model = readFileSync('logs/r9/honest.model');
const proof = readFileSync('logs/r9/honest.proof.expr');
const target = sha(candidate);
const tag = x => Buffer.of(x);
const zero = Buffer.alloc(32);
const committedName = 'aukora.model.sha256';
const marker = Buffer.from(committedName);
const module = new WebAssembly.Module(candidate);
assert.deepEqual(WebAssembly.Module.customSections(module, committedName).map(x => Buffer.from(x)), [sha(model)]);
const sectionStart = candidate.length - (2 + 1 + marker.length + 32);
const original = candidate.subarray(0, sectionStart), section = candidate.subarray(sectionStart);
assert.deepEqual(section.subarray(3, -32), marker);
const withCommit = digest => cat(candidate.subarray(0, -32), digest);
const body = (d, m, p, permit) => cat(d, u32(m.length), m, u32(p.length), p, permit);
const upgrade = (h, d, m, p, permit) => cat(tag(27), h.header(), body(d, m, p, permit));
const init = () => {
  const h = host();
  assert.equal(h.consume(cat(keys.edRaw, keys.mlRaw), 'init'), 1);
  return h;
};

if (process.argv.includes('--record-public')) {
  // Keep only public verification inputs. Recording is separate from ordinary reproduction.
  const dir = 'logs/r9/gate-vectors';
  mkdirSync(dir, {recursive: true});
  const permit = install(target, 0, 1);
  const signatures = dual(keys, cat(domain('grant', keys), permit));
  const grant = cat(tag(19), signatures.mlSig, zero, u64(1), tag(3), permit, signatures.edSig);
  const frame = cat(tag(27), sha(grant), u64(2), body(target, model, proof, permit));
  for (const [name, data] of [['keys', cat(keys.edRaw,keys.mlRaw)], ['grant',grant], ['upgrade',frame]])
    writeFileSync(dir + '/' + name + '.bin', data, {flag:'wx'});
  console.log('Recorded public keys and two signed-session frames.');
  process.exit(0);
}

const h = init();
const permit = install(target,0,1);
h.stage(candidate);
h.submit('valid model/proof, no grant', upgrade(h,target,model,proof,permit), false);
h.submit('install grant with Ed25519 only', h.grant(keys,permit,true,false), false);
h.submit('install grant with ML-DSA only', h.grant(keys,permit,false,true), false);
h.submit('hybrid grant for new candidate', h.grant(keys,permit), true);
h.submit('round-six proposition in place of Lawful proof',
  upgrade(h,target,model,readFileSync('logs/r6/wrong_digest.proof.expr'),permit),false);
h.submit('empty proof', upgrade(h,target,model,Buffer.alloc(0),permit),false);
h.submit('trailing byte after intent', cat(upgrade(h,target,model,proof,permit),tag(0)),false);

// Exercise the new restrictions on installation as well as on delivery acts.
const restricted = init(), short = install(target,0,10), retained = install(target,0,11);
const ownerControl = (op, role, payload) => {
  const header = restricted.header();
  const msg = cat(text('AUKORA/R9/' + role),keyFields(keys),u64(0),header,payload);
  const {edSig, mlSig} = dual(keys,msg);
  return cat(tag(op),header,payload,edSig,mlSig);
};
restricted.stage(candidate);
restricted.submit('short-lived install grant',ownerControl(24,'grant',cat(u64(2),short)),true);
restricted.submit('second independent install grant',restricted.grant(keys,retained),true);
restricted.submit('expired install, matching model and proof',upgrade(restricted,target,model,proof,short),false);
restricted.submit('revoke only second install grant',ownerControl(25,'revoke',sha(retained)),true);
restricted.submit('revoked install, matching model and proof',upgrade(restricted,target,model,proof,retained),false);
restricted.submit('fresh signed grant for identical revoked install intent',
  ownerControl(24,'grant',cat(u64(5),retained)),true);
restricted.submit('install at renewed inclusive cutoff',upgrade(restricted,target,model,proof,retained),true,target);

let nonce = 2;
function negative(label, file, declarations = model, cert = proof) {
  const digest = sha(file), intent = install(digest,0,nonce++);
  h.submit('hybrid grant for ' + label,h.grant(keys,intent),true);
  h.stage(file);
  h.submit(label, upgrade(h,digest,declarations,cert,intent), false);
}
for (const [file, label] of [
  ['broken', 'honest proof for a machine with a proved violation'],
  ['pinned', 'carried definition with the pinned Lawful name'],
]) {
  const declarations = readFileSync('logs/r9/' + file + '.model');
  negative(label, withCommit(sha(declarations)), declarations);
}
negative('honest proof and model with a different embedded digest', withCommit(sha(Buffer.from('other model'))));
negative('missing model section', original);
negative('duplicate model section', cat(candidate, section));
negative('matching section followed by a truncated section', cat(candidate,tag(1),tag(0x80)));
negative('matching name inside an unrelated custom section', cat(original,tag(0),tag(section.length+2),tag(1),tag(65),section));
negative('matching section after invalid Wasm header', cat(tag(1),candidate.subarray(1)));
negative('section size with bits above u32',cat(original,tag(0),Buffer.of(0x80,0x80,0x80,0x80,0x10),section));
negative('one-byte-short model digest',cat(original,tag(0),tag(section[1]-1),section.subarray(2,-1)));

const legacy = readFileSync('core/Core6.wasm'), oldDigest = sha(legacy);
const oldGrant = install(oldDigest,0,nonce++), oldProof = readFileSync('logs/r7/model.proof.expr');
h.stage(legacy);
h.submit('hybrid grant for previously listed Core6',h.grant(keys,oldGrant),true);
h.submit('previously accepted R7 certificate and old Core6 file',h.unsigned(cat(tag(18),oldDigest,u32(oldProof.length),oldProof,oldGrant)),false);
h.submit('right package, wrong staged bytes',upgrade(h,target,model,proof,permit),false);
h.stage(candidate);
h.submit('new candidate, constructed goal, hybrid grant, matching section',upgrade(h,target,model,proof,permit),true,target);
h.stage(candidate);
h.submit('reuse consumed grant',upgrade(h,target,model,proof,permit),false);

// The gate records the digest. Explicitly resolve and instantiate the accepted bytes in the lab host.
const chosen = Buffer.from(Array.from({length:32},(_,i) => h.api.core(i)));
assert.deepEqual(chosen, sha(candidate));
const api = new WebAssembly.Instance(new WebAssembly.Module(candidate)).exports;
function consume(op, bytes) {
  for (const b of bytes) assert.equal(api.input(b),1);
  return api[op]();
}
assert.equal(consume('init',keys.edRaw),1);
const lines = readFileSync('spike/r5/rfc8032.txt','utf8').split('\n');
const fixture = n => createPrivateKey({format:'der',type:'pkcs8',key:cat(Buffer.from('302e020100300506032b657004220420','hex'), Buffer.from(lines.find(l=>l.startsWith(n+' ')).split(' ')[1],'hex'))});
const r6Grant = signer => cat(zero,u64(1),tag(3),permit,sign(null,cat(Buffer.from('AUKORA/R5/grant'),permit),signer));
assert.equal(consume('step',r6Grant(keys.ed.privateKey)),0);
assert.equal(consume('step',r6Grant(fixture(1))),0);
const accepted = r6Grant(fixture(2));
assert.equal(consume('step',accepted),1);
assert.deepEqual(Buffer.from(Array.from({length:32},(_,i)=>api.head(i))),sha(accepted));
console.log('Loaded ledger-selected candidate in a fresh lab Wasm instance: supplied genesis key refused, RFC key 1 refused, RFC key 2 accepted. Full head matched.');
// This file digest is generated after the gate is already linked and instantiated.
// The fresh auxiliary declaration has the exact type/body refused under Lawful's pinned name.
const secondModel = readFileSync('logs/r9/fresh-copy.model');
const saltSection = cat(tag(0),tag(34),tag(1),tag(83),randomBytes(32));
const dynamic = cat(withCommit(sha(secondModel)),saltSection);
assert.equal(WebAssembly.validate(dynamic),true);
const dynamicTarget = sha(dynamic), dynamicIntent = install(dynamicTarget,0,nonce++);
h.stage(dynamic);
h.submit('hybrid grant for candidate salted after linking the gate',h.grant(keys,dynamicIntent),true);
h.submit('fresh auxiliary definition and newly generated file digest',
  upgrade(h,dynamicTarget,secondModel,proof,dynamicIntent),true,dynamicTarget);
console.log('Post-link candidate digest',dynamicTarget.toString('hex'));
console.log('PASS gate and candidate');
