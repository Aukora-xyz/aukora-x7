// A bare reader for a bound sample: no adapter, no dependency. Replays the record, then offers each probe frame.
// Usage: node examples/read-bound.mjs <core.wasm> examples/bound-sample.json
import { readFileSync } from 'node:fs';
const api = (await WebAssembly.instantiate(readFileSync(process.argv[2]), {})).instance.exports, s = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const feed = h => { for (let i = 0; i < h.length; i += 2) api.input(parseInt(h.slice(i, i + 2), 16)); };
const read = f => Array.from({ length: 32 }, (_, i) => f(i).toString(16).padStart(2, '0')).join('');
const lines = s.record.trim().split('\n'); if (lines[0] !== 'aukora-record v0.2 bound') throw new Error('not a bound record');
feed(lines[1] + lines[2]); if (api.initBound() !== 1) { console.log('refused at the start'); process.exit(1); }
console.log('record identifier', read(api.recordIdByte), read(api.recordIdByte) === s.recordId ? '(as stated)' : '(NOT the stated one)');
for (let n = 3; n < lines.length; n++) { feed(lines[n]); if (api.step() !== 1) { console.log('refused at frame', n - 2); process.exit(1); } }
console.log('replayed', lines.length - 3, 'frames; head', read(api.head), read(api.head) === s.expectedHead ? '(as expected)' : '(NOT the expected head)');
let same = read(api.head) === s.expectedHead && read(api.recordIdByte) === s.recordId;
for (const p of s.probes) { feed(p.frame); const got = api.step() === 1 ? 'admitted' : 'refused'; if (got !== p.expect || read(api.head) !== p.headAfter) same = false; console.log(got.padEnd(8), '|', p.name, got === p.expect ? '' : '  <-- the sample expects ' + p.expect); }
console.log('final head', read(api.head)); console.log(same ? 'AS THE SAMPLE EXPECTS' : 'DIFFERS FROM THE SAMPLE'); process.exit(same ? 0 : 1);
