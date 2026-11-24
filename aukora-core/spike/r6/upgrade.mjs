import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';

const local = path => readFileSync(new URL(path, import.meta.url));
const module = new WebAssembly.Module(local('../../core/Core6.wasm'));
const candidate = local('../../core/Core5.wasm');
const proof = local('../../logs/r6/wrong_digest.proof.expr');
const target = Buffer.from('d74a5e0170299d62e8349496b9c0e31b2a4091b51273ef8bf82204b39222350a', 'hex');
const sha = bytes => createHash('sha256').update(bytes).digest();
assert.deepEqual(sha(candidate), target, 'fixture matches the independent Round 5 pin');
assert.deepEqual(WebAssembly.Module.imports(module), []);
assert.deepEqual(WebAssembly.Module.exports(module).map(e => [e.name, e.kind]).sort(),
  ['init', 'input', 'step', 'head', 'core', 'feed', 'reset', 'verify'].map(n => [n, 'function']).sort());

const concat = (...parts) => Buffer.concat(parts);
function u16(n) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(n);
  return bytes;
}
function u64(n) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(n));
  return bytes;
}
const blob = bytes => concat(u16(bytes.length), bytes);
const text = s => blob(Buffer.from(s, 'utf8'));
const install = (digest, nonce) => concat(Buffer.of(1), digest, text('core'), u16(0), u16(nonce));
const upgrade = (digest, cert, intent) => concat(Buffer.of(17), digest, blob(cert), intent);
const zero = Buffer.alloc(32);
const {publicKey, privateKey} = generateKeyPairSync('ed25519');
const rawKey = publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
function grant(intent) {
  const signature = sign(null, concat(Buffer.from('AUKORA/R5/grant'), intent), privateKey);
  return concat(Buffer.of(3), intent, signature);
}

const api = new WebAssembly.Instance(module).exports;
function consume(operation, bytes) {
  for (const b of bytes) assert.equal(api.input(b), 1, 'input buffer capacity');
  return api[operation]();
}
function upload(bytes) {
  assert.equal(api.reset(), 1);
  for (let start = 0; start < bytes.length; start += 8192) {
    assert.equal(consume('feed', bytes.subarray(start, start + 8192)), 1);
  }
}
function digestAt(read) {
  return Buffer.from(Array.from({length: 32}, (_, i) => {
    const b = read(i);
    assert.ok(b >= 0 && b <= 255, 'initialized digest byte');
    return b;
  }));
}

assert.equal(consume('init', rawKey), 1);
assert.deepEqual(digestAt(api.head), zero);
assert.deepEqual(digestAt(api.core), zero);
let parent = zero, seq = 1, installed = zero;
function submit(name, action, expected, nextCore = installed) {
  const wire = concat(parent, u64(seq), action);
  const ok = consume('step', wire);
  assert.equal(ok, expected, name);
  if (ok === 1) {
    parent = sha(wire);
    seq++;
    installed = nextCore;
  }
  assert.deepEqual(digestAt(api.head), parent, name + ' ledger head');
  assert.deepEqual(digestAt(api.core), installed, name + ' installed digest');
  console.log(name, ok ? 'accepted' : 'refused');
}

const permit = install(target, 1);
const valid = upgrade(target, proof, permit);
submit('ordinary say event', concat(Buffer.of(0), text('round six')), 1);
upload(candidate);
submit('proof and pinned bytes without a signed grant', valid, 0);
submit('fresh owner signed the pinned install intent', grant(permit), 1);

// Another valid Wasm module, differing only by an empty custom section.
const otherCandidate = concat(candidate, Buffer.of(0, 1, 0));
assert.equal(WebAssembly.validate(otherCandidate), true);
const otherDigest = sha(otherCandidate);
assert.notDeepEqual(otherDigest, target);
const otherPermit = install(otherDigest, 2);
submit('fresh owner signed the alternate install intent', grant(otherPermit), 1);
upload(otherCandidate);
submit('pinned certificate presented against different staged bytes', valid, 0);
submit('proof relabelled with matching alternate digest, bytes and signed grant',
  upgrade(otherDigest, proof, otherPermit), 0);

upload(candidate);
submit('legacy tag 7 with proofChecked=true', concat(Buffer.of(7), target, Buffer.of(1), permit), 0);
submit('certificate missing (length zero)', upgrade(target, Buffer.alloc(0), permit), 0);
submit('certificate truncated inside a complete frame', upgrade(target, proof.subarray(0, -1), permit), 0);
submit('frame ends inside declared proof', concat(Buffer.of(17), target, u16(proof.length), proof.subarray(0, -1)), 0);
submit('well-formed expression of the wrong type (Sort 0)', upgrade(target, Buffer.of(1, 0), permit), 0);
submit('valid retry with same staged candidate and original unspent grant', valid, 1, target);

// Restage to make the consumed grant the sole missing condition.
upload(candidate);
submit('already spent grant, correct parent and sequence', valid, 0);
submit('replayed original signed grant', grant(permit), 0);
console.log('PASS Full certificate-bearing frame hash matched Node SHA-256; installed digest', installed.toString('hex'));
