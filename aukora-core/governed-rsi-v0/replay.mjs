// COLD REPLAY by a second reader. Inputs: the record, the retained artifacts, the judge folder, and (optionally) a checkpoint
// the reader kept from an earlier look. It trusts none of the run's conclusions: it replays the record in a fresh pinned core,
// recomputes every digest, and re-derives every decision (the law check runs the Lean kernel again on the exact bytes).
import { readFileSync, existsSync } from 'node:fs';
import { here, lab, sha, judgeDigest, lawDigest, buildJudgeModel, governed, parse } from './lib.mjs';
import { Core } from '../standalone/aukora.mjs';
const dir = process.argv[2] || here + 'out/'; const ckFile = process.argv[3]; const fail = m => { console.log('COLD REPLAY: FAIL —', m); process.exit(1); };
const CORE = lab + 'v0.4/aukora-core-lite.wasm'; const text = readFileSync(dir + 'record.log', 'utf8'); const lines = text.trim().split('\n');
const headAt = async k => { const c = await Core.load(CORE, { allowUnpinned: true }); try { return await c.replay(lines.slice(0, 2 + k).join('\n') + '\n'); } catch (e) { fail('the record does not replay: ' + e.message); } };
const N = lines.length - 2; const head = await headAt(N);
if (ckFile && ckFile !== 'none') { const ck = JSON.parse(readFileSync(ckFile)); if (N < ck.seq) fail(`the record has ${N} lines but the reader retained a checkpoint at line ${ck.seq}: lines were dropped`);
  if ((await headAt(ck.seq)) !== ck.head) fail(`the record disagrees with the retained checkpoint at line ${ck.seq}`); console.log(`checkpoint at line ${ck.seq}: the record extends it`); }
else console.log('no retained checkpoint: a record cut at its end cannot be told from a complete one');
const frames = lines.slice(2).map(h => Buffer.from(h, 'hex')); const says = [], acts = [];
for (const f of frames) { if (f[0] === 0x00 && f[41] === 0x00) says.push(f.subarray(44, 44 + f.readUInt16LE(42)).toString('utf8'));
  if (f[0] === 0x17 && f[73] === 0x04) { const n = f.readUInt16LE(75); acts.push(f.subarray(77, 77 + n).toString('utf8')); } }
const g0 = says.find(s => s.startsWith('GENESIS ')); if (!g0) fail('no genesis line'); const G = parse(g0.replace('GENESIS governed-organ-v0 ', 'x=y '));
buildJudgeModel(); const pinned = { judge: G.judge, laws: G.laws };
if (judgeDigest(here + 'judge/') !== pinned.judge || lawDigest() !== pinned.laws) fail('the judge folder is not the judge the record was made under');
const ev = await import(here + 'judge/evaluate.mjs'); const H = JSON.parse(readFileSync(here + 'judge/heldout.json'));
const art = d => { const f = dir + 'artifacts/' + d + '.bin'; if (!existsSync(f)) fail('artifact missing: ' + d.slice(0, 12)); const b = readFileSync(f); if (sha(b) !== d) fail(`artifact ${d.slice(0, 12)} does not match its digest: a past artifact was changed`); return b; };
const base = art(G.baseline); const st = { governed: { incumbent: G.baseline, score: ev.scoreOn(base, H) }, score_only: { incumbent: G.baseline, score: ev.scoreOn(base, H) } };
let ok = { governed: 0, score_only: 0 }, tot = { governed: 0, score_only: 0 }, promos = 0, promoOk = 0;
for (const s of says.filter(x => x.startsWith('ATTEMPT '))) { const a = parse(s), bytes = art(a.cand), cur = st[a.arm]; tot[a.arm]++; let d;
  if (a.arm === 'governed') d = await governed({ bytes, cand: a.claimed, parent: a.parent, judge: a.judge, laws: a.laws }, cur, pinned);
  else { const sc = ev.scoreOn(bytes, H); d = sc > cur.score ? { result: 'ADMIT', reason: 'BETTER_SCORE', score: sc } : { result: 'REFUSE', reason: 'NOT_BETTER', score: sc }; }
  if (d.result === a.result && d.reason === a.reason && String(d.score ?? 'none') === a.score && (d.proof ?? 'none') === a.proof) ok[a.arm]++; else console.log('  DIFFERS at attempt', a.n, a.arm, 'logged', a.result, a.reason, a.score, 'replayed', d.result, d.reason, d.score ?? 'none');
  if (d.result === 'ADMIT') { cur.incumbent = a.cand; cur.score = d.score;
    if (a.arm === 'governed') { promos++; if (acts.some(p => p === `promote organ cand=${a.claimed} parent=${a.parent} judge=${a.judge} laws=${a.laws} proof=${d.proof}`)) promoOk++; } } }
const good = ok.governed === tot.governed && ok.score_only === tot.score_only && promoOk === promos && acts.length === promos;
console.log(`COLD REPLAY: ${good ? 'PASS' : 'FAIL'} — ${N} lines, head ${head.slice(0, 16)}; governed decisions reproduced ${ok.governed} of ${tot.governed}; score-only ${ok.score_only} of ${tot.score_only}; core-admitted promotions matched ${promoOk} of ${promos} (acts in record: ${acts.length}); final governed incumbent ${st.governed.incumbent.slice(0, 12)}, score-only ${st.score_only.incumbent.slice(0, 12)}`);
process.exit(good ? 0 : 1);
