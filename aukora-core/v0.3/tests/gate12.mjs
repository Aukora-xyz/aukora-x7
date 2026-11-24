import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {boundInstall, cat, host, owner, packageWire, sha, timedGrant} from './host.mjs';

const release = new URL('../', import.meta.url);
const file = name => readFileSync(new URL(name, release));
const base = file('aukora-core.wasm');
const keys = owner(), h = host(base);
assert.equal(h.consume(cat(keys.edRaw,keys.mlRaw), 'init'), 1);
const inherited = ['replay','record','stale','once','passive','advice','restore','upgrade','memory','outcome',
  'grants','binding','control','monotone','floor','threshold','missing','bundle','stamping','revoke',
  'expiry','correction','retention'];
const extra = ['e1','e1b','e2','e3','e4','e5','e6','h1','h2','h3','h4','h5','succession'];
const manifest = Buffer.from(['R12/1', ...inherited, ...extra, ''].join('\n'));
const root = file('fixtures/packages/root.law');
const env = JSON.parse(file('fixtures/packages/environment.json'));
const basis = sha(base.subarray(env.offset,env.offset+env.size));
assert.equal(basis.toString('hex'),env.sha256);
const expectedLaw = sha(cat(manifest, basis, root));
function law() { return Buffer.from(Array.from({length:32}, (_,i) => h.api.lawByte(i))); }
assert.deepEqual(law(), expectedLaw);
console.log('initial root identity',expectedLaw.toString('hex'),'with',inherited.length+extra.length,'clauses');
const cases = new Map([['archived',11],['same',7],['strong',7],['supplement',8],
  ...extra.slice(0,-1).map(field => ['drop-'+field,8])]);
let seq = 0;
for (const label of process.argv.length > 2 ? process.argv.slice(2) : cases.keys()) {
  assert.ok(cases.has(label),'unknown test '+label);
  const archived = label === 'archived';
  const model = file(archived ? '../logs/r9/honest.model' : 'fixtures/packages/'+label+'.model');
  const proof = file(archived ? '../logs/r9/honest.proof.expr' : 'fixtures/packages/'+label+'.proof.expr');
  const name = Buffer.from('aukora.model.sha256');
  const section = cat(Buffer.of(name.length), name, sha(model));
  const candidate = archived ? file('../core/FixedGenesis9.wasm') : cat(base, Buffer.of(0,section.length),section);
  assert.ok(WebAssembly.validate(candidate),'invalid candidate Wasm');
  const target = sha(candidate);
  h.stage(candidate);
  const intent = boundInstall(target,model,proof,0,++seq);
  h.submit(label+' bound hybrid grant',timedGrant(keys,h.header(),intent,0,1000),true);
  const wire = packageWire(h.header(),target,model,proof,intent);
  const seen = h.consume(wire,'installReason');
  assert.equal(seen,cases.get(label),label+' first refusal');
  h.submit(label+' install',wire,false);
  assert.deepEqual(law(),expectedLaw);
  console.log(label,'reason',seen,'judge variant',archived ? 'archived' : 'identical');
}
