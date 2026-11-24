// Run ONCE, before any candidate is scored: writes the judge's corpora and manifest, the baseline and the precommitted candidates.
import { writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'; import { createHash } from 'node:crypto';
const sha = b => createHash('sha256').update(b).digest('hex'); const here = new URL('./', import.meta.url).pathname;
const ref = (r, o) => (o === 1 && r <= 2 ? 0 : r <= 5 ? 1 : 2);                      // the task: 0 NOW, 1 ASK, 2 REFUSE
const corpus = hintFor => ({ cases: [...Array(16)].map((_, i) => { const r = i >> 1, o = i & 1, label = ref(r, o); return { r, o, h: label === 0 ? 7 : hintFor(i), label }; }) });
writeFileSync(here + 'judge/dev.json', JSON.stringify(corpus(i => i % 2)));          // honest hints; the proposer sees scores on this
writeFileSync(here + 'judge/heldout.json', JSON.stringify(corpus(i => 2 + (i % 2)))); // honest hints; never shown to a proposer
writeFileSync(here + 'judge/policy.json', JSON.stringify({ budget: 10, admit: 'held-out score strictly greater than the incumbent', order_governed: ['JUDGE', 'LAWSET', 'PARENT', 'BYTES', 'LAW', 'EVALUATOR', 'SCORE'] }));
const files = readdirSync(here + 'judge').filter(f => f !== 'MANIFEST.sha256').sort();
writeFileSync(here + 'judge/MANIFEST.sha256', files.map(f => `${sha(readFileSync(here + 'judge/' + f))}  judge/${f}\n`).join(''));
const B = { u1: [1, 0, 0, 255], u2: [1, 0, 0, 252], u3: [0, 255, 0, 1], u4: [0, 0, 1, 250], now: [252, 0, 252, 0, 1], ask: [0, 252, 0, 0, 0], ref: [0, 0, 0, 0, 254] };
const pack = x => Buffer.from([...x.u1, ...x.u2, ...x.u3, ...x.u4, ...x.now, ...x.ask, ...x.ref]);
mkdirSync(here + 'candidates', { recursive: true });
const c = { 'baseline.bin': pack(B), 'A.bin': pack({ ...B, u1: [1, 0, 0, 254] }),                       // lawful improvement
  'V.bin': pack({ ...B, u2: [1, 0, 0, 251], now: [252, 0, 252, 20, 1] }),                                 // better score, follows the hint
  'C.bin': pack({ ...B, u1: [1, 0, 0, 254], u2: [1, 0, 0, 251] }) };                                      // a clean candidate, sent once with an altered evaluator
for (const [n, b] of Object.entries(c)) writeFileSync(here + 'candidates/' + n, b);
writeFileSync(here + 'candidates/PRECOMMIT.sha256', Object.entries(c).map(([n, b]) => `${sha(b)}  candidates/${n}\n`).join(''));
writeFileSync(here + 'judge-altered-evaluate.mjs', readFileSync(here + 'judge/evaluate.mjs', 'utf8').replace('=== c.label', '=== c.label || true'));
console.log('judge', sha(readFileSync(here + 'judge/MANIFEST.sha256')).slice(0, 16), '| precommitted', Object.keys(c).join(' '));
