// Each row is a complete public submission, checked at step() and all 32 head bytes.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {host,sha,cat} from './host.mjs';
import {candidate} from './install-cases.mjs';
const root = 'v0.2';
const args = process.argv.slice(2);
const childRun = args[0] === '--successor';
const groups = childRun ? args.slice(1) : args;
if (!groups.length) groups.push(...readdirSync(root+'/vectors').filter(x=>x.endsWith('.bin.gz')).map(x=>x.slice(0,-7)));
for (const group of groups) {
  const suite = childRun ? host(candidate('same')) : host();
  const keyfile = group === 'gate' ? 'install' : group.startsWith('r11-') ? group : 'signed';
  assert.equal(suite.consume(readFileSync(root+'/fixtures/'+keyfile+'/keys.bin'), 'init'), 1);
  if (group === 'gate') suite.stage(readFileSync('v0.1/fixtures/fixed-genesis.wasm'));
  const prefix = root+'/vectors/'+group;
  const bytes = gunzipSync(readFileSync(prefix+'.bin.gz'));
  const rows = readFileSync(prefix+'.tsv','utf8').trimEnd().split('\n');
  const mapFile = name => group === 'r11-install' ? new Map(readFileSync(root+'/fixtures/'+group+'/'+name+'.tsv','utf8')
    .trimEnd().split('\n').map(r => r.split('\t'))) : new Map();
  const stages = mapFile('stages'), reasons = mapFile('reasons');
  const view = field => Buffer.from(Array.from({length:32},(_,i)=>suite.api[field](i)));
  const genesisLaw = view('lawByte');
  let lastLaw = genesisLaw, staged, selected;
  let offset = 0, accepted = 0;
  for (const row of rows) {
    const [label,n,expected,head] = row.split('\t');
    const wire = bytes.subarray(offset, offset + Number(n));
    assert.equal(wire.length,Number(n),label);
    if (stages.has(label)) { staged = candidate(stages.get(label)); suite.stage(staged); }
    if (reasons.has(label)) {
      const reason = suite.consume(wire,'installReason');
      assert.equal(reason,Number(reasons.get(label)),label+' ratchet reason');
      console.log('gate',label,'reason',reason);
    }
    for (const b of wire) suite.api.input(b);
    const actual = suite.api.step();
    assert.equal(actual,Number(expected),label);
    const gotHead = Buffer.from(Array.from({length:32},(_,i)=>suite.api.head(i))).toString('hex');
    assert.equal(gotHead,head,label);
    if (group === 'r11-install') {
      if (actual && wire[0] === 27) {
        selected = staged;
        assert.deepEqual(view('core'),sha(staged));
        const currentLaw = view('lawByte');
        if (label.includes('additional law')) assert.notDeepEqual(currentLaw,lastLaw);
        else assert.deepEqual(currentLaw,lastLaw);
        lastLaw = currentLaw;
      } else assert.deepEqual(view('lawByte'),lastLaw);
    }
    offset += Number(n);
    accepted += actual;
  }
  if (selected) {
    const child = host(selected);
    assert.equal(child.consume(readFileSync(root+'/fixtures/r11-install/keys.bin'),'init'),1);
    console.log('fresh selected successor initialized',sha(selected).toString('hex'),'genesis law',
      Buffer.from(Array.from({length:32},(_,i)=>child.api.lawByte(i))).toString('hex'));
  }
  assert.equal(offset,bytes.length);
  console.log(childRun ? 'Successor Wasm' : 'Wasm',group,rows.length+'/'+rows.length,'agree on verdict and all 32 head bytes ('+accepted+' admitted)');
}
