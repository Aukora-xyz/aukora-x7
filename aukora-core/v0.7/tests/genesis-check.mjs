// Round 12c A: the build's genesis check, run exactly as the build runs it (same program, same
// comparison), on three inputs. It must PASS on the real core and its proved identity, FAIL on the
// real core when one byte of the proved identity is changed (control), and FAIL on the round-12
// configuration (fixtures/genesis-check/round12.json, a description that is never a core).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';

const release = new URL('../', import.meta.url);
const tool = new URL('tools/genesis-check.mjs', release).pathname;
const core = new URL('aukora-core.wasm', release).pathname;
const proved = new URL('.work/package/proved.id', release).pathname;
const run = (...args) => {
  const r = spawnSync(process.execPath, [tool, ...args], {encoding: 'utf8'});
  process.stdout.write(r.stdout);
  return r.status;
};

assert.equal(run(core, proved), 0, 'real core and its proved identity');

const changed = Buffer.from(readFileSync(proved));
changed[0] ^= 1;
mkdirSync(new URL('.work/tmp/', release), {recursive: true});
const flipped = new URL('.work/tmp/proved-one-byte-changed.id', release).pathname;
writeFileSync(flipped, changed);
assert.equal(run(core, flipped), 1, 'control: one byte of the proved identity changed');

const fixture = new URL('fixtures/genesis-check/round12.json', release).pathname;
assert.ok(!WebAssembly.validate(readFileSync(fixture)), 'the fixture is not a loadable module');
assert.equal(run('--description', fixture), 1, 'round-12 configuration');

console.log('PASS genesis check: real core accepted; one changed byte refused; round-12 configuration refused');
