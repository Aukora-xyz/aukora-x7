// Governed organ optimisation, fixture version. Two arms, at most ten proposals. The first five are the SAME
// precommitted candidates in both arms; after that each arm's proposer steps from its OWN incumbent, so once the
// arms have diverged these are two lineages with a shared start, not an A/B test of identical candidates.
// Record: the v0.4 lite core. Attempt lines are HOST OBSERVATIONS (speech). Promotions in the governed arm are CORE ADMISSIONS
// (an owner approval of the exact digests, then the act, admitted once). Lab keys only.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { here, lab, sha, judgeDigest, lawDigest, buildJudgeModel, governed, line } from './lib.mjs';
import { Core, newOwner } from '../standalone/aukora.mjs';
const CORE = lab + 'v0.4/aukora-core-lite.wasm'; if (sha(readFileSync(CORE)) !== '8e7cca361db0ef321450e5f5fc70c807957c9e1095314fd533bdd4806abaa311') throw new Error('core file is not the pinned v0.4 lite core');
buildJudgeModel(); const ev = await import(here + 'judge/evaluate.mjs');
const H = JSON.parse(readFileSync(here + 'judge/heldout.json')), D = JSON.parse(readFileSync(here + 'judge/dev.json'));
const pinned = { judge: judgeDigest(here + 'judge/'), laws: lawDigest() }; const cand = n => readFileSync(here + `candidates/${n}.bin`);
mkdirSync(here + 'out/artifacts', { recursive: true }); mkdirSync(here + 'out/retained', { recursive: true });
const keep = b => { writeFileSync(here + 'out/artifacts/' + sha(b) + '.bin', b); return sha(b); };
const core = await Core.load(CORE, { allowUnpinned: true }); const owner = newOwner(); core.init(owner);
core.say(`GENESIS governed-organ-v0 judge=${pinned.judge} laws=${pinned.laws} baseline=${keep(cand('baseline'))} budget=10 core=v0.4-lite`);
const base = cand('baseline'); const arms = { governed: { incumbent: sha(base), bytes: base, score: ev.scoreOn(base, H), admitted: 0, refused: {} }, score_only: { incumbent: sha(base), bytes: base, score: ev.scoreOn(base, H), admitted: 0, refused: {} } };
let n = 0, nonce = 0;
async function attempt(name, mk) {                                           // mk(arm state) -> package for that arm
  n++; if (n > 10) throw new Error('budget exceeded');
  for (const arm of ['score_only', 'governed']) { const st = arms[arm], pkg = mk(st); keep(pkg.bytes); let d;
    if (arm === 'score_only') { const evl = pkg.evaluator ? await import(pkg.evaluator) : ev; const s = evl.scoreOn(pkg.bytes, H); d = s > st.score ? { result: 'ADMIT', reason: 'BETTER_SCORE', score: s } : { result: 'REFUSE', reason: 'NOT_BETTER', score: s }; }
    else d = await governed(pkg, st, pinned);
    core.say(line({ n, name, arm, kind: 'HOST-OBSERVED', parent: pkg.parent, cand: sha(pkg.bytes), claimed: pkg.cand, judge: pkg.judge, laws: pkg.laws, proof: d.proof ?? 'none', score: d.score ?? 'none', result: d.result, reason: d.reason }));
    if (d.result === 'ADMIT') { st.admitted++;
      if (arm === 'governed') { const intent = { payload: `promote organ cand=${pkg.cand} parent=${pkg.parent} judge=${pkg.judge} laws=${pkg.laws} proof=${d.proof}`, audience: 'organ', generation: 0, nonce: ++nonce };
        if (!core.grant(owner, intent) || !core.act(intent)) throw new Error('the core did not admit the promotion'); if (core.act(intent)) throw new Error('the core admitted a promotion twice'); }
      st.incumbent = sha(pkg.bytes); st.bytes = pkg.bytes; st.score = d.score; } else st.refused[d.reason] = (st.refused[d.reason] || 0) + 1;
    console.log(String(n).padStart(2), name.padEnd(22), arm.padEnd(10), d.result, d.reason, 'score', d.score ?? '-'); }
  if (n === 3) writeFileSync(here + 'out/retained/checkpoint.json', JSON.stringify({ seq: core.seq, head: core.headHex(), note: 'written by this same run after attempt 3; it stands in for a checkpoint a second reader would keep, and a dishonest host could write it too' }));
}
const P = (bytes, st, over = {}) => ({ bytes, cand: sha(bytes), parent: st.incumbent, judge: pinned.judge, laws: pinned.laws, ...over });
await attempt('A lawful-improvement', st => P(cand('A'), st));
await attempt('V better-but-unlawful', st => P(cand('V'), st));
await attempt('V law-dropped', st => P(cand('V'), st, { laws: sha(Buffer.from('def Law (w : List UInt8) : Prop := True')) }));
await attempt('C altered-evaluator', st => P(cand('C'), st, { judge: sha(readFileSync(here + 'judge-altered-evaluate.mjs')), evaluator: here + 'judge-altered-evaluate.mjs' }));
await attempt('no-op', st => P(st.bytes, st));
// Bounded proposer: single-weight steps of one unit from the arm's own incumbent, chosen on DEV scores only.
const propose = st => { let best = null, bs = ev.scoreOn(st.bytes, D); for (let i = 0; i < 31; i++) for (const dlt of [1, -1]) { const v = ev.s8(st.bytes[i]) + dlt; if (v < -128 || v > 127) continue; const w = Buffer.from(st.bytes); w[i] = v & 255; const s = ev.scoreOn(w, D); if (s > bs) { bs = s; best = w; } } return best; };
for (let k = 0; k < 5 && n < 10; k++) { const g = propose(arms.governed), s = propose(arms.score_only); if (!g && !s) { console.log('proposer: no single-weight step improves the dev score in either arm; stopping at', n, 'proposals'); break; }
  await attempt('proposer-step-' + (k + 1), st => P((st === arms.governed ? g : s) ?? st.bytes, st)); }
writeFileSync(here + 'out/record.log', core.exportRecord()); copyFileSync(here + 'judge/MANIFEST.sha256', here + 'out/judge-manifest-at-run.sha256');
const final = Object.fromEntries(Object.entries(arms).map(([a, st]) => [a, { incumbent: st.incumbent, heldout: st.score, admitted: st.admitted, refused: st.refused }]));
writeFileSync(here + 'out/final.json', JSON.stringify({ proposals: n, head: core.headHex(), lines: core.frames.length, pinned, final }, null, 1));
console.log(JSON.stringify(final)); console.log('record', core.frames.length, 'lines, head', core.headHex().slice(0, 16));
