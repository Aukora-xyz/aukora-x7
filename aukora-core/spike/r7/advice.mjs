import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';

const wasm = new WebAssembly.Module(readFileSync('core/Core6.wasm'));
const {publicKey, privateKey} = generateKeyPairSync('ed25519');
const key = publicKey.export({type:'spki', format:'der'}).subarray(-32);
const cat = (...parts) => Buffer.concat(parts);
const u16 = n => Buffer.from([n & 255, n >>> 8]);
const u64 = n => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(n)); return bytes; };
const blob = b => cat(u16(b.length), b);
const text = s => blob(Buffer.from(s));

function host() {
  const api = new WebAssembly.Instance(wasm).exports;
  for (const b of key) assert.equal(api.input(b), 1);
  assert.equal(api.init(), 1);
  let seq = 1;
  const head = () => Buffer.from(Array.from({length:32}, (_, i) => api.head(i)));
  const frame = action => cat(head(), u64(seq), action);
  const submit = (action, expected) => {
    const prior = head(), wire = frame(action);
    for (const b of wire) assert.equal(api.input(b), 1);
    assert.equal(api.step(), expected);
    if (expected) seq++;
    assert.deepEqual(head(), expected ? createHash('sha256').update(wire).digest() : prior);
  };
  return {head, frame, submit};
}
const a = host(), b = host(), payload = Buffer.of(24);
a.submit(cat(Buffer.of(6), text('lab'), u16(4)), 1);
b.submit(cat(Buffer.of(6), text('lab'), u16(5)), 1);
assert.notDeepEqual(a.head(), b.head());
const mandate = cat(Buffer.of(10), text('service'), blob(payload), u16(0), u16(1), u16(100));
const spend = cat(Buffer.of(11), u16(1), Buffer.of(4, 0), blob(payload), text('service'), u16(0), u16(3));
const signFor = c => sign(null, cat(Buffer.from('AUKORA/R5/control'), u64(0), c.frame(mandate)), privateKey);
const sigA = signFor(a);
a.submit(cat(mandate, sigA), 1);
b.submit(cat(mandate, sigA), 0);
a.submit(spend, 1);
b.submit(spend, 0);
b.submit(cat(mandate, signFor(b)), 1);
b.submit(spend, 1);
console.log('L6 witness on Core6.wasm: different scores gave distinct heads; copied signature gave different mandate and act verdicts; locally re-signed mandate and matching act succeeded.');
