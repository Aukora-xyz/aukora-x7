// Round 12c D2: stored frames of the second seat's re-addressing test (tests/record-rebinding.mjs),
// which is shipped unchanged. Usage:
//   node tests/record-rebinding-vectors.mjs <core.wasm> --write   run that test once and record every
//                                                                 consuming call of every instance
//   node tests/record-rebinding-vectors.mjs <core.wasm>           replay the stored calls on fresh instances:
//                                                                 same verdicts and the same head after each
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {gunzipSync, gzipSync} from 'node:zlib';

const vectorFile = new URL('../vectors/record-rebinding.json.gz', import.meta.url);
const consuming = ['init', 'initBound', 'step', 'seal', 'continueRecord', 'feed', 'reset', 'stamp'];
const headOf = api => Buffer.from(Array.from({length: 32}, (_, i) => api.head(i))).toString('hex');

if (process.argv.includes('--write')) {
  const instances = [];
  const Original = WebAssembly.Instance;
  WebAssembly.Instance = function (mod, imports) {
    const inst = new Original(mod, imports);
    const api = inst.exports, calls = [], pending = [];
    instances.push(calls);
    const wrapped = {...api};
    wrapped.input = b => { pending.push(b); return api.input(b); };
    for (const op of consuming) wrapped[op] = () => {
      const hex = Buffer.from(pending.splice(0)).toString('hex');
      const verdict = api[op]();
      calls.push({op, hex, verdict, head: api.head(0) === 256 ? null : headOf(api)});
      return verdict;
    };
    return {exports: wrapped};
  };
  process.on('exit', () => {
    writeFileSync(vectorFile, gzipSync(JSON.stringify({format: 1, instances})));
    console.log('WROTE', instances.length, 'instances,', instances.flat().length, 'calls');
  });
  process.argv = [process.argv[0], new URL('./record-rebinding.mjs', import.meta.url).pathname, process.argv[2]];
  await import('./record-rebinding.mjs');
} else {
  const bytes = readFileSync(process.argv[2]);
  const mod = new WebAssembly.Module(bytes);
  const corpus = JSON.parse(gunzipSync(readFileSync(vectorFile)));
  assert.equal(corpus.format, 1);
  let n = 0;
  for (const calls of corpus.instances) {
    const api = new WebAssembly.Instance(mod).exports;
    for (const c of calls) {
      for (const b of Buffer.from(c.hex, 'hex')) assert.equal(api.input(b), 1);
      assert.equal(api[c.op](), c.verdict, `call ${n} ${c.op}`);
      assert.equal(api.head(0) === 256 ? null : headOf(api), c.head, `call ${n} head`);
      n++;
    }
  }
  console.log('PASS', n, 'stored re-addressing calls in', corpus.instances.length, 'instances: same verdicts and heads');
}
