import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {boundInstall, cat, host, owner, packageWire, sha, timedGrant} from './host.mjs';

const dir = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, dir));
const base = read('aukora-core.wasm');
const pkg = name => read('fixtures/packages/' + name);
const index = JSON.parse(pkg('environment.json'));
const env = base.subarray(index.offset,index.offset+index.size);
assert.equal(sha(env).toString('hex'),index.sha256);
const original = pkg('lineage-original.decl'), relaxed = pkg('lineage-weaker.decl');
const path = ['Release','ExportFinal','LineageControl','Lawful'];
const encodedName = cat(Buffer.alloc(path.length,1),Buffer.of(0),
  ...path.flatMap(s=>[Buffer.of(s.length),Buffer.from(s)]));
const predicate = cat(Buffer.of(2),encodedName,Buffer.of(0));
assert.deepEqual(pkg('strong.law').subarray(-predicate.length),predicate);
assert.ok(original.includes(encodedName) && relaxed.includes(encodedName));
const where = env.indexOf(original), envStart = base.indexOf(env);
assert.ok(where >= 0 && env.indexOf(original, where+1) === -1);
assert.ok(envStart >= 0 && base.indexOf(env, envStart+1) === -1);
assert.equal(original.length, relaxed.length);
assert.ok(!original.equals(relaxed));
const alternate = Buffer.from(base);
relaxed.copy(alternate, envStart + where);
const model = pkg('strong.model'), proof = pkg('strong.proof.expr');
const secName = Buffer.from('aukora.model.sha256');
const section = cat(Buffer.of(secName.length),secName,sha(model));
const commitment = cat(Buffer.of(0,section.length),section);
const keys = owner(), h = host(base);
assert.equal(h.consume(cat(keys.edRaw,keys.mlRaw),'init'), 1);
let nonce = 0;
for (const [label, image, reason] of [
  ['weaker actual added genesis law in initializer data',alternate,11],
  ['identical executable and initializer data',base,0],
]) {
  const file = cat(image,commitment);
  assert.ok(WebAssembly.validate(file));
  h.stage(file);
  const digest = sha(file);
  const intent = boundInstall(digest,model,proof,0,++nonce);
  h.submit('grant '+label,timedGrant(keys,h.header(),intent,0,1000),true);
  const frame = packageWire(h.header(),digest,model,proof,intent);
  assert.equal(h.consume(frame,'installReason'),reason);
  assert.equal(h.consume(frame,'witnessMask'), reason === 11 ? 256 : 3);
  if (reason) h.submit(label,frame,false);
  else h.submit(label,frame,true,digest);
  console.log(label, 'judge', reason === 11 ? 'refused' : 'passed',
    'first diagnostic',reason,'staged sha256',digest.toString('hex'));
}
console.log('Same model and proof in both packages. The stronger package installed only with the unchanged executable and initializer data.');
