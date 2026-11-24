import assert from 'node:assert/strict';
import {blob,cat,host,install,owner,sha,u32} from './host.mjs';
import {candidate,part} from './install-cases.mjs';
import {safeControl} from './safe-fields.mjs';

const digest = read => Buffer.from(Array.from({length:32},(_,i)=>read(i)));
function bytesAt(reader,id,wire) {
  for (const [offset,value] of wire.entries()) assert.equal(reader(id,offset),value);
  assert.equal(reader(id,wire.length),256);
}
function start() {
  const h = host(), keys = owner();
  assert.equal(h.consume(cat(keys.edRaw,keys.mlRaw),'init'),1);
  assert.equal(h.api.halted(),0);
  return {h,keys};
}

{
  const {h,keys} = start();
  const staged = candidate('same'), target = sha(staged);
  const intent = install(target,0,208);
  const model = part('same','model'), proof = part('same','proof.expr');
  const payload = cat(target,u32(model.length),model,u32(proof.length),proof,intent);
  const packageAtHead = () => cat(Buffer.of(27),h.header(),payload);
  h.stage(staged);
  h.submit('live exact-file install grant before halt',h.grant(keys,intent),true);
  assert.equal(h.consume(packageAtHead(),'installReason'),0,'both proof goals check before halt');
  const haltAt = h.historyLength(), halt = safeControl(h,50,keys,0);
  h.submit('owner halt with staged lawful candidate and live grant',halt,true);
  assert.equal(h.api.halted(),1);
  const attempt = packageAtHead();
  h.submit('halt blocks the lawfully certified authorized install',attempt,false);
  assert.equal(h.api.recordByte(h.historyLength(),0),256,'refusal added no record');
  const currentHead = digest(h.api.head);
  const stamp = cat(currentHead,blob(Buffer.from('halt receipt')),sha(halt));
  assert.equal(h.consume(stamp,'stamp'),1);
  assert.equal(h.api.stampCount(),1);
  bytesAt(h.api.stampByte,0,stamp);
  assert.deepEqual(digest(h.api.head),currentHead);
  assert.equal(h.api.recordByte(h.historyLength(),0),256);
  assert.equal(h.api.halted(),1);
  h.submit('both owner signatures clear at the stamped head',safeControl(h,51,keys,0),true);
  assert.equal(h.api.halted(),0);
  const retry = packageAtHead();
  assert.deepEqual(retry.subarray(41),attempt.subarray(41),'same target, model, proof and intent');
  h.submit('identical installation payload succeeds after clear',retry,true,target);
  bytesAt(h.api.recordByte,haltAt,halt);
  bytesAt(h.api.stampByte,0,stamp);
  console.log('PASS the refused upgrade left the staged file and grant available. Verified original halt and stamp bytes after install.');

  const selected = digest(h.api.core);
  assert.deepEqual(sha(staged),selected);
  const full = host(), child = host(staged);
  const genesisKeys = cat(keys.edRaw,keys.mlRaw);
  assert.equal(full.consume(genesisKeys,'init'),1);
  assert.equal(child.consume(genesisKeys,'init'),1);
  assert.deepEqual(digest(full.api.head),digest(child.api.head));
  assert.deepEqual(digest(full.api.lawByte),digest(child.api.lawByte));
  const firstHalt = safeControl(full,50,keys,0);
  full.submit('fresh full cell accepts doubly signed genesis halt',firstHalt,true);
  child.submit('fresh selected same-set successor refuses identical genesis halt',firstHalt,false);
  assert.equal(full.api.halted(),1);
  assert.equal(child.api.halted(),0);
  bytesAt(full.api.recordByte,0,firstHalt);
  assert.equal(child.api.recordByte(0,0),256);
  console.log('Selected candidate SHA-256',selected.toString('hex'));
  console.log('PASS equal genesis head, keys, law identity and exact signed frame; the full and selected cells diverge on the first halt.');
}

{
  const {h,keys} = start(), replacement = owner();
  const halt = safeControl(h,50,keys,0);
  h.submit('halt before a failed feed',halt,true);
  const haltedHead = digest(h.api.head);
  assert.equal(h.api.input(256),0,'force invalid input into candidate chunk');
  assert.equal(h.api.feed(),0,'failed feed poisons only staging');
  assert.equal(h.consume(Buffer.of(1),'feed'),0,'staging latch is set');
  assert.deepEqual(digest(h.api.head),haltedHead);
  assert.equal(h.api.halted(),1);

  h.submit('valid clear succeeds with poisoned staging, without reset',safeControl(h,51,keys,0),true);
  assert.equal(h.api.halted(),0);
  assert.equal(h.consume(Buffer.of(1),'feed'),0,'clear leaves staging failure visible');
  h.submit('owner halts while staging remains poisoned',safeControl(h,50,keys,0),true);
  const rebind = safeControl(h,53,keys,0,{newKeys:replacement});
  const rebindAt = h.historyLength();
  h.submit('valid rebind succeeds with poisoned staging, without reset',rebind,true);
  assert.equal(h.api.halted(),1,'rebind preserves halt');
  assert.equal(h.consume(Buffer.of(1),'feed'),0,'rebind leaves staging failure visible');
  h.submit('old owner cannot clear the new binding',safeControl(h,51,replacement,1,{signer:keys}),false);
  h.submit('new owner clears with staging still poisoned',safeControl(h,51,replacement,1),true);
  assert.equal(h.api.halted(),0);
  bytesAt(h.api.recordByte,0,halt);
  bytesAt(h.api.recordByte,rebindAt,rebind);
  const beforeReset = digest(h.api.head);
  assert.equal(h.api.reset(),1);
  assert.equal(h.consume(Buffer.of(1),'feed'),1,'reset restores staging');
  assert.deepEqual(digest(h.api.head),beforeReset);
  console.log('PASS poisoned staging persisted across valid clear and rebind. The new owner cleared and reset restored feed.');
}
