import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {boundInstall, cat, host, owner, packageWire, sha, timedGrant} from './host.mjs';

const read = name => readFileSync(new URL('../'+name,import.meta.url));
const base = read('aukora-core.wasm');
const pkg = file => read('fixtures/packages/'+file);
const inherited = ['replay','record','stale','once','passive','advice','restore','upgrade','memory','outcome',
  'grants','binding','control','monotone','floor','threshold','missing','bundle','stamping','revoke',
  'expiry','correction','retention'];
const extra = ['e1','e1b','e2','e3','e4','e5','e6','h1','h2','h3','h4','h5','succession','w1'];
const names = [...inherited,...extra];
const manifest = Buffer.from(['R12B/1',...names,''].join('\n'));
const env = JSON.parse(pkg('environment.json'));
const basis = sha(base.subarray(env.offset,env.offset+env.size));
assert.equal(basis.toString('hex'),env.sha256);
const identity = law => sha(cat(manifest,basis,pkg(law+'.law')));
const keys = owner();
const opened = (image=base) => {
  const h = host(image);
  assert.equal(h.consume(cat(keys.edRaw,keys.mlRaw),'init'),1);
  return h;
};
const law = h => Buffer.from(Array.from({length:32},(_,i)=>h.api.lawByte(i)));
const cases = new Map([['archived',11],['same',0],['strong',0],['wrong-own',7],
  ...names.map(field=>['drop-'+field,8])]);
function submit(h,label,reason,active,nonce,part=label) {
  const archived = part==='archived';
  const model = archived ? read('../logs/r9/honest.model') : pkg(part+'.model');
  const proof = archived ? read('../logs/r9/honest.proof.expr') : pkg(part+'.proof.expr');
  const name = Buffer.from('aukora.model.sha256');
  const section = cat(Buffer.of(name.length),name,sha(model));
  const candidate = archived ? read('../core/FixedGenesis9.wasm') : cat(base,Buffer.of(0,section.length),section);
  assert.ok(WebAssembly.validate(candidate));
  h.stage(candidate);
  const target = sha(candidate);
  const intent = boundInstall(target,model,proof,0,nonce);
  const grant = timedGrant(keys,h.header(),intent,0,1000);
  h.submit(label+' bound hybrid grant',grant,true);
  const wire = packageWire(h.header(),target,model,proof,intent);
  const mask = h.consume(wire,'witnessMask');
  const expectedMask = reason===0 ? 3 : reason===7 ? 2 : reason===8 ? 1 : 256;
  assert.equal(mask,expectedMask,label+' witness mask');
  assert.equal(h.consume(wire,'installReason'),reason,label+' diagnostic');
  if (!reason) h.submit(label+' install',wire,true,target);
  else h.submit(label+' install',wire,false);
  assert.deepEqual(law(h),identity(active));
  console.log(label,'witness mask',mask,'diagnostic',reason,'active law',law(h).toString('hex'));
  return {candidate,target,grant,wire};
}
for (const label of process.argv.length>2 ? process.argv.slice(2) : cases.keys()) {
  assert.ok(cases.has(label));
  const h = opened();
  assert.deepEqual(law(h),identity('root'));
  const active = label==='strong' ? 'strong' : 'root';
  const attempt = submit(h,label,cases.get(label),active,1);
  if (label==='strong') {
    // Reopen the actual admitted file. Reconstruct its law only from genesis,
    // exported frame bytes, and the staged file to which the install commits.
    const fresh = opened(attempt.candidate);
    assert.deepEqual(law(fresh),identity('root'));
    const entry = (index,original) => {
      const raw = Buffer.alloc(original.length);
      for (let i=0;i<raw.length;i++) {
        const value = h.api.recordByte(index,i);
        assert.ok(value<=255);
        raw[i]=value;
      }
      assert.equal(h.api.recordByte(index,original.length),256);
      assert.deepEqual(raw,original);
      return raw;
    };
    fresh.stage(attempt.candidate);
    fresh.submit('replayed exact recorded grant',entry(0,attempt.grant),true);
    fresh.submit('replayed exact recorded stronger install',entry(1,attempt.wire),true,attempt.target);
    assert.deepEqual(law(fresh),identity('strong'));
    assert.deepEqual(fresh.header(),h.header());
    const {closeAndContinue} = await import('./segments.mjs');
    await closeAndContinue(fresh,keys);
    assert.deepEqual(law(fresh),identity('strong'));
    submit(fresh,'stale root certificate after stronger install',4,'strong',2,'same');
    submit(fresh,'child of the active stronger set',0,'strong',3,'strong-next');
  }
}
