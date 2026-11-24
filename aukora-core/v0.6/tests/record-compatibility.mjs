// Replay *accepted records*, omitting historical refused submissions. Only v0.6 executes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {host,sha} from './host.mjs';

const read = (group, suffix) => readFileSync(new URL('../../v0.1/' + group + suffix, import.meta.url));
const verifier = readFileSync(new URL('../aukora-core.wasm',import.meta.url));
const keys = read('fixtures/signed/keys','.bin');
const oldCandidate = read('fixtures/fixed-genesis','.wasm');

for (const group of ['matrix','length','history','signed','gate']) {
  const bytes = gunzipSync(read('vectors/' + group,'.bin.gz'));
  const rows = read('vectors/' + group,'.tsv').toString().trimEnd().split('\n');
  let offset=0, replayed=0, divergences=0, lastHead=Buffer.alloc(32).toString('hex');
  const h = host(verifier);
  const viewHead = () => Buffer.from(Array.from({length:32},(_,i)=>h.api.head(i))).toString('hex');
  assert.equal(h.consume(group === 'gate' ? read('fixtures/install/keys','.bin') : keys,'init'),1);
  if (group === 'gate') h.stage(oldCandidate);
  for (const row of rows) {
    const [label,size,oldVerdict,head] = row.split('\t');
    const wire = bytes.subarray(offset,offset+Number(size));
    offset += Number(size);
    assert.equal(wire.length,Number(size));
    if (oldVerdict === '0') continue;
    const verdict = h.consume(wire,'step');
    if (group === 'gate' && label === 'gate-install') {
      assert.equal(wire[0],27);
      assert.deepEqual(wire.subarray(41,73),sha(oldCandidate));
      assert.equal(verdict,0,'historical installation must fail in the fresh core');
      assert.equal(viewHead(),lastHead,'refusal preserves last replayed head');
      console.log('v0.1 gate-install refused, diagnostic',h.consume(wire,'installReason'),
        'prior head',lastHead,'old post-install head',head);
      divergences++;
    } else {
      assert.equal(verdict,1,label);
      assert.equal(viewHead(),head,label+' replayed head');
      for (let i=0; i<wire.length; i++) assert.equal(h.api.recordByte(replayed,i),wire[i],label+' recorded bytes');
      assert.equal(h.api.recordByte(replayed,wire.length),256);
      replayed++;
      lastHead=head;
    }
  }
  assert.equal(offset,bytes.length);
  assert.equal(divergences,group === 'gate' ? 1 : 0);
  console.log(group,replayed,'historical accepted frames replayed byte-for-byte,',divergences,'divergences');
}
