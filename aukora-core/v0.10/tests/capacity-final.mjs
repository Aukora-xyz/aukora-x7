import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {blob, cat, deliver, dual, host, keyFields, owner, sha, text, timedGrant, u64} from './host.mjs';
import {safeControl} from './safe-fields.mjs';
import {bytes32, closeAndContinue, genesisFor, rawKeys, signedSeal} from './segments.mjs';

const file = readFileSync(process.argv[2]);
const active = owner();
const nextKeys = owner();
const h = host(file);
assert.equal(h.consume(rawKeys(active), 'init'), 1);
const say = msg => h.unsigned(cat(Buffer.of(0), text(msg)));
const stamp = () => cat(bytes32(h.api.head), blob(Buffer.from('lab')), Buffer.alloc(32, 4));
const visible = () => [bytes32(h.api.head), bytes32(h.api.journalByte), bytes32(h.api.lawByte),
  h.api.halted(), h.api.threshold(), h.api.stampCount()];

function reserve() {
  h.submit('halt before reaching ordinary limit', safeControl(h,50,active,0), true);
  const sidecar = stamp();
  for (let i=1; i<512; ++i) assert.equal(h.consume(sidecar, 'stamp'), 1);
  const start = visible();
  assert.equal(h.consume(say('ordinary'), 'step'), 0);
  assert.equal(h.consume(sidecar, 'stamp'), 0);
  const invalid = safeControl(h,51,active,0,{goodMl:false});
  assert.equal(h.consume(invalid, 'step'), 0);
  assert.deepEqual(visible(), start);
  h.submit('signed clear while halted at ordinary cap', safeControl(h,51,active,0), true);
  assert.equal(h.api.halted(),0);
  h.submit('signed legacy key change in reserve', h.rebind(active,nextKeys,0), true);
  h.submit('signed version-02 key change in reserve', safeControl(h,53,nextKeys,1,{newKeys:active}), true);
  for (let i=3; i<16; ++i) h.submit('signed clear in reserved slot '+(i+1),safeControl(h,51,active,2),true);
  const spent = visible();
  assert.equal(h.consume(safeControl(h,51,active,2), 'step'), 0);
  const accepted = signedSeal(h,active);
  assert.equal(h.consume(signedSeal(h,active,nextKeys),'seal'),0);
  assert.deepEqual(visible(),spent);
  assert.equal(h.consume(accepted,'seal'),1);
  const pin = bytes32(h.api.sealByte);
  assert.deepEqual(pin,sha(accepted));
  for (const [op,wire] of [['step',safeControl(h,51,active,2)],['stamp',sidecar],['seal',accepted],
      ['feed',Buffer.of(0)],['reset',Buffer.alloc(0)]]) assert.equal(h.consume(wire,op),0);
  const descriptor = genesisFor(h,active,accepted);
  for (const i of [Buffer.byteLength('AUKORA/R12B/genesis'),descriptor.length-1,descriptor.length-1985]) {
    const wrong = Buffer.from(descriptor);
    wrong[i] ^= 1;
    assert.equal(h.consume(wrong,'continueRecord'),0);
    assert.deepEqual(bytes32(h.api.sealByte),pin);
  }
  assert.equal(h.consume(descriptor,'continueRecord'),1);
  h.acceptGenesis(descriptor);
  assert.equal(h.consume(descriptor,'continueRecord'),0);
  h.submit('signed clear in continuation',safeControl(h,51,active,2),true);
  h.submit('ordinary speech in continuation',say('ordinary again'),true);
  assert.equal(h.api.stampByte(0,0),sidecar[0]);
  console.log('PASS ordinary limit 512, 16 owner slots, exhausted clear refused, independent seal remains usable');
}

function policy() {
  const a = deliver(Buffer.from('expired'),0,11);
  const b = deliver(Buffer.from('revoked'),0,12);
  const c = deliver(Buffer.from('eligible'),0,13);
  const act = i => cat(Buffer.of(23),sha(cat(text('AUKORA/R8/missing:request-intent-only;evidence=missing;reasoning=missing;witness=missing;versions=missing'),sha(i))),h.header(),Buffer.of(4),i);
  h.submit('grant with inclusive cutoff 2',timedGrant(active,h.header(),a,0,2),true);
  h.submit('separate timed grant',timedGrant(active,h.header(),b,0,20),true);
  h.submit('eligible control grant',h.grant(active,c),true);
  const msg=cat(text('AUKORA/R9/revoke'),keyFields(active),u64(0),h.header(),sha(b));
  const sig=dual(active,msg);
  h.submit('owner revokes second grant',cat(Buffer.of(25),h.header(),sha(b),sig.edSig,sig.mlSig),true);
  h.submit('halt carries into the next segment',safeControl(h,50,active,0),true);
  closeAndContinue(h,active);
  assert.equal(h.api.halted(),1);
  h.submit('eligible spend during continued halt',act(c),false);
  h.submit('clear continued halt',safeControl(h,51,active,0),true);
  h.submit('expired authority after continuation',act(a),false);
  h.submit('revoked authority after continuation',act(b),false);
  h.submit('still eligible grant after continuation',act(c),true);
  console.log('PASS carried halt, expiration, revocation and eligible authority');
}

if (process.argv[3] === 'reserve') reserve();
else if (process.argv[3] === 'policy') policy();
else throw new Error('choose reserve or policy');
