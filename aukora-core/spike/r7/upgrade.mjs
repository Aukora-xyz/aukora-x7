import assert from 'node:assert/strict';
import {createHash, createPrivateKey, generateKeyPairSync, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url));
const sha = b => createHash('sha256').update(b).digest();
const join = (...parts) => Buffer.concat(parts);
function uint16(n) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n);
  return buf;
}
function uint32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n);
  return buf;
}
function uint64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}
const blob = value => join(uint16(value.length), value);
const text = s => blob(Buffer.from(s, 'utf8'));
const intent = (digest, nonce) => join(Buffer.of(1), digest, text('core'), uint16(0), uint16(nonce));
const upgrade = (digest, proof, permit) => join(Buffer.of(18), digest, uint32(proof.length), proof, permit);
const shortUpgrade = (digest, proof, permit) => join(Buffer.of(17), digest, blob(proof), permit);
function grant(permit, key) {
  const message = join(Buffer.from('AUKORA/R5/grant'), permit);
  return join(Buffer.of(3), permit, sign(null, message, key));
}

const mainBytes = read('../../core/Core6.wasm');
const otherBytes = read('../../core/FixedOwner6.wasm');
const main = sha(mainBytes);
const other = sha(otherBytes);
assert.equal(main.toString('hex'), '92baf60040e4800c4dfd0040bbc32eff869ea865d6285b8f054776e940aed1f5');
assert.equal(other.toString('hex'), '34501eb20598fd7aa8ab519873ae2ec9c78b78457fea5118b77db9e1bd6ac836');
const zero = Buffer.alloc(32);
const key = generateKeyPairSync('ed25519');
const publicBytes = key.publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
const mainIntent = intent(main, 1);
const otherIntent = intent(other, 2);

function instantiate(bytes) {
  const mod = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(mod), []);
  const functions = ['init', 'input', 'step', 'head', 'core', 'feed', 'reset', 'verify'];
  assert.deepEqual(WebAssembly.Module.exports(mod).map(x => [x.name, x.kind]).sort(),
    functions.map(name => [name, 'function']).sort());
  return new WebAssembly.Instance(mod).exports;
}
function consume(api, op, bytes) {
  for (const b of bytes) assert.equal(api.input(b), 1, 'frame fits ABI input');
  return api[op]();
}

// Distinguish the two model entries at their actual Wasm ABIs.
const testVector = read('../r5/rfc8032.txt').toString().split('\n').find(line => line.startsWith('1 '));
const fixedSecret = Buffer.from(testVector.split(' ')[1], 'hex');
const fixedPrivateKey = createPrivateKey({format: 'der', type: 'pkcs8',
  key: join(Buffer.from('302e020100300506032b657004220420', 'hex'), fixedSecret)});
for (const [label, bytes, freshOK, fixedOK] of [
  ['Core6', mainBytes, 1, 0], ['FixedOwner6', otherBytes, 0, 1],
]) {
  const fixture = instantiate(bytes);
  assert.equal(consume(fixture, 'init', publicBytes), 1);
  const oldHead = zero;
  const freshFrame = join(oldHead, uint64(1), grant(mainIntent, key.privateKey));
  assert.equal(consume(fixture, 'step', freshFrame), freshOK);
  const head = freshOK ? sha(freshFrame) : oldHead;
  const seq = freshOK ? 2 : 1;
  // Distinct nonce: only the signature determines the second decision.
  assert.equal(consume(fixture, 'step', join(head, uint64(seq), grant(otherIntent, fixedPrivateKey))), fixedOK);
  console.log(label, 'grant with supplied key', freshOK, 'grant with RFC fixture key', fixedOK);
}
if (process.argv.includes('--fixtures-only')) process.exit(0);

const api = instantiate(read('../../core/Core7.wasm'));
const primaryProof = read('../../logs/r7/model.proof.expr');
const otherProof = read('../../logs/r7/other.proof.expr');
const r6Proof = read('../../logs/r6/wrong_digest.proof.expr');

function upload(bytes) {
  assert.equal(api.reset(), 1);
  for (let p = 0; p < bytes.length; p += 8192) {
    assert.equal(consume(api, 'feed', bytes.subarray(p, p + 8192)), 1);
  }
}
function digestAt(readByte) {
  return Buffer.from(Array.from({length: 32}, (_, i) => {
    const b = readByte(i);
    assert.ok(0 <= b && b <= 255);
    return b;
  }));
}
assert.equal(consume(api, 'init', publicBytes), 1);
let parent = zero, seq = 1, installed = zero;
function submit(label, body, expected, nextCore = installed) {
  const wire = join(parent, uint64(seq), body);
  const ok = consume(api, 'step', wire);
  assert.equal(ok, expected, label);
  if (ok) {
    parent = sha(wire);
    seq++;
    installed = nextCore;
  }
  assert.deepEqual(digestAt(api.head), parent, label + ' head');
  assert.deepEqual(digestAt(api.core), installed, label + ' installed digest');
  console.log(ok ? 'ACCEPT' : 'REFUSE', label);
}
submit('ordinary say', join(Buffer.of(0), text('round seven')), 1);
upload(mainBytes);
submit('right proof and bytes without a signed grant', upgrade(main, primaryProof, mainIntent), 0);
submit('signed installation grant for Core6', grant(mainIntent, key.privateKey), 1);
submit('R6 wrong_digest proof with matching Core6 bytes and grant', upgrade(main, r6Proof, mainIntent), 0);
submit('tag 17 R6 wrong_digest proof with the right bytes and grant', shortUpgrade(main, r6Proof, mainIntent), 0);
submit('tag 18 ends inside declared proof', join(Buffer.of(18), main, uint32(primaryProof.length), primaryProof.subarray(0, -1)), 0);
submit('tag 18 proof length exceeds 1 MiB in a complete frame',
  upgrade(main, Buffer.alloc(1024 * 1024 + 1), mainIntent), 0);
submit('FixedOwner6 Lawful proof with matching Core6 bytes and grant', upgrade(main, otherProof, mainIntent), 0);
submit('legacy proofChecked=true for Core6', join(Buffer.of(7), main, Buffer.of(1), mainIntent), 0);
submit('Core6 Lawful proof with matching Core6 bytes and grant', upgrade(main, primaryProof, mainIntent), 1, main);
submit('signed installation grant for FixedOwner6', grant(otherIntent, key.privateKey), 1);
upload(mainBytes);
submit('FixedOwner6 proof and grant with Core6 bytes staged', upgrade(other, otherProof, otherIntent), 0);
upload(otherBytes);
submit('Core6 Lawful proof with matching FixedOwner6 bytes and grant', upgrade(other, primaryProof, otherIntent), 0);
submit('FixedOwner6 Lawful proof with matching FixedOwner6 bytes and grant', upgrade(other, otherProof, otherIntent), 1, other);
upload(otherBytes);
submit('reuse consumed FixedOwner6 grant', upgrade(other, otherProof, otherIntent), 0);
console.log('PASS. Compared every accepted frame head and every installed core digest against Node SHA-256.');
