import assert from 'node:assert/strict';
import {createHash, createPrivateKey, createPublicKey, sign, verify as hostVerify} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {exerciseEvents} from '../r4/events.mjs';

const cat = (...parts) => Buffer.concat(parts);
const hex = s => Buffer.from(s, 'hex');
const bitFlip = (bytes, ix = 0) => { const changed = Buffer.from(bytes); changed[ix] ^= 1; return changed; };
const sha = bytes => createHash('sha256').update(bytes).digest();
const zero = Buffer.alloc(32);
const u8 = n => Buffer.from([n]);
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const blob = b => cat(u16(b.length), b);
const text = s => blob(Buffer.from(s));
const sent = (payload, audience, gen, nonce) => cat(u8(0), blob(payload), text(audience), u16(gen), u16(nonce));
const install = (target, gen, nonce) => cat(u8(1), target, text('core'), u16(gen), u16(nonce));
const digest = read => Buffer.from(Array.from({length: 32}, (_, i) => read(i)));
const label = type => Buffer.from('AUKORA/R5/' + type);
const grantMsg = intent => cat(label('grant'), intent);
const bindMsg = (generation, key) => cat(label('rebind'), u64(generation), key);
const frame = (parent, seq, tag, ...fields) => cat(parent, u64(seq), u8(tag), ...fields);

const fixtures = await readFile(new URL('rfc8032.txt', import.meta.url), 'utf8');
const vectors = fixtures.trim().split('\n').filter(l => !l.startsWith('#')).map(l => {
  const [id, seed, pk, message, sig] = l.split(' ');
  const privateKey = createPrivateKey({key: cat(hex('302e020100300506032b657004220420'), hex(seed)), format: 'der', type: 'pkcs8'});
  const publicKey = createPublicKey(privateKey);
  const raw = publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const msg = message === '-' ? Buffer.alloc(0) : hex(message);
  const signature = hex(sig);
  assert.deepEqual(raw, hex(pk), 'recalled public key ' + id);
  assert.deepEqual(sign(null, msg, privateKey), signature, 'recalled complete signature ' + id);
  assert.equal(hostVerify(null, msg, publicKey, signature), true);
  return {id, raw, privateKey, msg, signature};
});
assert.deepEqual(vectors.map(v => v.id), ['1','2','3']);
console.log('RFC 8032 §7.1 TEST 1/2/3: Node re-derived all public keys and reproduced all 64 signature bytes from the recalled seeds.');
const [owner, second, outsider] = vectors;
const signed = (v, m) => sign(null, m, v.privateKey);
const wasm = await readFile(process.argv[2] ?? new URL('../../core/Core5.wasm', import.meta.url));
const module = await WebAssembly.compile(wasm);
assert.deepEqual(WebAssembly.Module.imports(module), []);
assert.deepEqual(WebAssembly.Module.exports(module).map(x => [x.name, x.kind]).sort(),
  ['init','input','verify','reset','feed','step','core','head'].map(n => [n,'function']).sort());
const fresh = async () => (await WebAssembly.instantiate(module)).exports;
function stageFrame(api, bytes) { for (const b of bytes) assert.equal(api.input(b), 1); }
function consume(api, operation, bytes) { stageFrame(api, bytes); return api[operation](); }
const checkRaw = (api, k, sig, m) => consume(api, 'verify', cat(k, sig, m));

const direct = await fresh();
for (const {id, raw, msg, signature} of vectors) {
  assert.equal(checkRaw(direct, raw, signature, msg), 1);
  assert.equal(checkRaw(direct, raw, bitFlip(signature), msg), 0);
  if (msg.length) assert.equal(checkRaw(direct, raw, signature, bitFlip(msg)), 0);
  console.log('Wasm RFC TEST', id, 'accepted; one-bit mutations refused');
}
const invalidS = Buffer.from(owner.signature);
invalidS.fill(255, 32);
assert.equal(checkRaw(direct, owner.raw, invalidS, owner.msg), 0);
const identity = cat(u8(1), Buffer.alloc(31));
assert.equal(consume(direct, 'init', identity), 0);
assert.equal(consume(direct, 'init', zero), 0);
assert.equal(consume(direct, 'init', owner.raw.subarray(0,31)), 0);
assert.equal(direct.head(0), 256);
const times = [];
for (let n = 0; n < 3; n++) {
  stageFrame(direct, cat(second.raw, second.signature, second.msg));
  const start = performance.now();
  const ok = direct.verify();
  times.push(performance.now() - start);
  assert.equal(ok, 1);
}
console.log('Wasm verify() milliseconds (preloaded RFC TEST 2, three warm runs):', times.map(t => t.toFixed(3)).join(', '));

async function initialized() {
  const api = await fresh();
  assert.equal(consume(api, 'init', owner.raw), 1);
  assert.deepEqual(digest(api.head), zero);
  assert.deepEqual(digest(api.core), zero);
  assert.equal(consume(api, 'init', outsider.raw), 0);
  return api;
}

// Assert each verdict and the full head from an independent hash of the wire.
function chain(api) {
  let parent = zero, seq = 1;
  return {
    get parent() { return parent; }, get seq() { return seq; },
    step(name, tag, fields, expected = 1) {
      const packet = frame(parent, seq, tag, ...fields);
      const id = seq - 1;
      const prevCore = digest(api.core);
      assert.equal(consume(api, 'step', packet), expected, name);
      if (expected) { parent = sha(packet); seq++; }
      else assert.deepEqual(digest(api.core), prevCore, name + ' retained core');
      assert.deepEqual(digest(api.head), parent, name + ' head');
      return id;
    }
  };
}
const delivery = sent(Buffer.from([0, 42]), 'service', 0, 7);
const authentic = signed(owner, grantMsg(delivery));
const api = await initialized();
const session = chain(api);
session.step('one signature bit', 3, [delivery, bitFlip(authentic)], 0);
session.step('other private key', 3, [delivery, signed(outsider, grantMsg(delivery))], 0);
session.step('changed intent', 3, [bitFlip(delivery, 4), authentic], 0);
session.step('legacy owner flag', 3, [delivery, u8(1)], 0);
session.step('grant from genesis owner', 3, [delivery, authentic]);
const bind = signed(owner, bindMsg(0, second.raw));
session.step('wrong rebind signer', 8, [second.raw, signed(second, bindMsg(0, second.raw))], 0);
session.step('wrong generation signature', 8, [second.raw, signed(owner, bindMsg(1, second.raw))], 0);
session.step('substituted successor key', 8, [outsider.raw, bind], 0);
session.step('unsuitable new owner', 8, [identity, signed(owner, bindMsg(0, identity))], 0);
session.step('rebind by current key', 8, [second.raw, bind]);
session.step('previous grant cleared', 4, [delivery], 0);
const later = sent(Buffer.from([0, 42]), 'service', 1, 7);
session.step('old key signing current generation', 3, [later, signed(owner, grantMsg(later))], 0);
session.step('new key signing current generation', 3, [later, signed(second, grantMsg(later))]);
session.step('spend', 4, [later]);
session.step('resubmit signed intent after spend', 3, [later, signed(second, grantMsg(later))], 0);
console.log('Wasm grant accepted; signature bit, other signer and changed intent refused. Signed rebind accepted; old grant and fresh old-key signature refused. New key spent once.');

const candidate = wasm;
const target = sha(candidate);
const permit = install(target, 0, 1);
const grantSig = signed(owner, grantMsg(permit));
function upload(api, bytes) {
  assert.equal(api.reset(), 1);
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    assert.equal(consume(api, 'feed', bytes.subarray(offset, offset + 8192)), 1);
  }
}
const upgraded = await initialized();
const head = chain(upgraded);
head.step('signed install grant', 3, [permit, grantSig]);
upload(upgraded, bitFlip(candidate, Math.floor(candidate.length/2)));
head.step('changed candidate', 7, [target, u8(1), permit], 0);
upload(upgraded, candidate);
head.step('proof flag false', 7, [target, u8(0), permit], 0);
head.step('exact successor', 7, [target, u8(1), permit]);
assert.deepEqual(digest(upgraded.core), target);
upload(upgraded, candidate);
head.step('upgrade grant spent', 7, [target, u8(1), permit], 0);
head.step('signed install grant replay', 3, [permit, grantSig], 0);
console.log('Wasm self-upgrade: exact candidate accepted, changed bytes / false proof / spent grant / signed replay refused. Core', target.toString('hex'));

// Reuse all R4 policy cases with R5 signatures produced outside the module.
function signedEvents(api) {
  const h = chain(api);
  let generation = 0, signer = owner;
  const next = (name, tag, fields, expected = 1) => {
    const adapted = fields.slice();
    if ([3, 8, 9, 10, 12, 14, 15].includes(tag)) {
      const shouldSign = adapted.pop().equals(u8(1));
      if (tag === 8) adapted.splice(0, adapted.length, second.raw);
      const msg = tag === 3 ? grantMsg(adapted[0]) : tag === 8 ? bindMsg(generation, second.raw) :
        cat(label('control'), u64(generation), frame(h.parent, h.seq, tag, ...adapted));
      const signature = signed(signer, msg);
      adapted.push(shouldSign ? signature : bitFlip(signature));
    }
    const id = h.step(name, tag, adapted, expected);
    if (expected && tag === 8) { signer = second; generation++; }
    return id;
  };
  exerciseEvents(api, {u8, u16, blob, text, sent, digest, chain: () => next});
}
signedEvents(await initialized());

// Authentication binds each control to one history position.
const replay = await initialized();
const control = chain(replay);
const budget = [u16(0), u16(4)];
const controlSig = signed(owner, cat(label('control'), u64(0), frame(control.parent, control.seq, 12, ...budget)));
control.step('legacy budget flag', 12, [...budget, u8(1)], 0);
control.step('signed budget', 12, [...budget, controlSig]);
control.step('replayed budget signature on a new head', 12, [...budget, controlSig], 0);
console.log('Wasm imports none; memory private. Control replay refused on new head.');

// The bounded ABI must also accept a maximum-size, properly signed grant.
const large = sent(Buffer.alloc(65535 - 114, 0xa5), '', 0, 2);
const largeSig = signed(owner, grantMsg(large));
assert.equal(frame(zero, 1, 3, large, largeSig).length, 65535);
const max = chain(await initialized());
max.step('maximum-size signed frame', 3, [large, largeSig]);
console.log('Maximum 65,535-byte signed grant accepted and its full wire head matched Node SHA-256.');
