// Replay fixed signed records through both public adapters. --write records new
// vectors for the specified foundation only after the full image has been built.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {gzipSync, gunzipSync} from 'node:zlib';
import {blob,cat,host,owner,sha,text} from './host.mjs';
import {bytes32,genesisFor,rawKeys,signedSeal} from './segments.mjs';
const file = new URL('../vectors/segments.json.gz', import.meta.url);
const full = readFileSync(new URL('../aukora-core.wasm',import.meta.url));
const lite = readFileSync(new URL('../aukora-core-lite.wasm',import.meta.url));
const ascii = x => Buffer.from('AUKORA/R12B/' + x);
function open(image,publicKeys) {
  const h=host(image);
  assert.equal(h.consume(publicKeys,'init'),1);
  return h;
}
function advance(prev,kind,wire) { return sha(cat(ascii('entry'),prev,Buffer.of(kind),wire)); }
function capture() {
  const keys=owner(), pub=rawKeys(keys);
  const branches=[], trailers=[];
  for (let side=0;side<2;side++) {
    const h=open(full,pub), ops=[];
    const push=(op,b,ok=true)=>{
      ops.push([op,b.toString('base64'),Number(ok)]);
      if (op==='step') h.submit('capture '+side,b,ok);
      else {
        assert.equal(h.consume(b,op),Number(ok));
        if (ok && op==='continueRecord') h.acceptGenesis(b);
      }
    };
    push('step',h.unsigned(cat(Buffer.of(0),text('common ledger frame'))));
    push('stamp',cat(bytes32(h.api.head),blob(Buffer.of(side)),Buffer.alloc(32,7)));
    if (side) push('seal',trailers[0],false);
    for (let ordinal=0;ordinal<2;ordinal++) {
      const wire=signedSeal(h,keys);
      if (side===0) trailers.push(wire);
      push('seal',wire);
      const genesis=genesisFor(h,keys,wire);
      push('continueRecord',genesis);
      push('step',h.unsigned(cat(Buffer.of(0),text('next '+ordinal))));
    }
    branches.push(ops);
  }
  return {format:1,law:bytes32(open(full,pub).api.lawByte).toString('hex'),
    keys:pub.toString('base64'),branches};
}
if (process.argv.includes('--write')) {
  writeFileSync(file,gzipSync(JSON.stringify(capture())));
}
const corpus=JSON.parse(gunzipSync(readFileSync(file)));
assert.equal(corpus.format,1);
const pub=Buffer.from(corpus.keys,'base64'), law=Buffer.from(corpus.law,'hex');
let reference;
for (const [profile,img] of [['full',full],['lite',lite]]) {
  const heads=[];
  for (const ops of corpus.branches) {
    const h=open(img,pub), genesis=[];
    assert.deepEqual(bytes32(h.api.lawByte),law);
    let journal=sha(cat(ascii('first'),law,pub)), head=Buffer.alloc(32), pin;
    for (const [op,base64,ok] of ops) {
      const bytes=Buffer.from(base64,'base64');
      assert.equal(h.consume(bytes,op),ok);
      if (ok) {
        if (op==='step' || op==='stamp') {
          journal=advance(journal,Number(op==='stamp'),bytes);
          if (op==='step') head=sha(bytes);
        } else if (op==='seal') {
          assert.deepEqual(bytes.subarray(0,-3373),cat(ascii('seal'),journal,law,head,pub));
          pin=sha(bytes);
          assert.deepEqual(bytes32(h.api.sealByte),pin);
        } else {
          assert.deepEqual(bytes,cat(ascii('genesis'),pin,law,pub));
          head=journal=sha(bytes);
          genesis.push(head.toString('hex'));
          pin=undefined;
        }
      }
      assert.deepEqual(bytes32(h.api.head),head);
      assert.deepEqual(bytes32(h.api.journalByte),journal);
      assert.deepEqual(bytes32(h.api.lawByte),law);
      if (!pin) assert.equal(h.api.sealByte(0),256);
    }
    heads.push(genesis);
  }
  assert.equal(heads[0].length,2);
  for (let i=0;i<2;i++) assert.notEqual(heads[0][i],heads[1][i]);
  if (reference) assert.deepEqual(heads,reference);
  reference=heads;
  console.log('PASS',profile,corpus.branches.flat().length,'operations; changed earlier stamp, original seal refused, both later genesis digests differ',JSON.stringify(heads));
}
