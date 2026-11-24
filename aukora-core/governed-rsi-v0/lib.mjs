// Shared by the run and by the cold replay: digests, the law check (Lean kernel), the governed decision.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'; import { createHash } from 'node:crypto'; import { spawnSync } from 'node:child_process';
export const here = new URL('./', import.meta.url).pathname, lab = new URL('../', import.meta.url).pathname;
export const sha = b => createHash('sha256').update(b).digest('hex');
const LEAN = lab + 'toolchain/lean-4.19.0-darwin_aarch64/bin/lean';
export const judgeDigest = dir => sha(readFileSync(dir + 'MANIFEST.sha256'));                    // the manifest lists every judge file
export function judgeIntact(dir) { return readFileSync(dir + 'MANIFEST.sha256', 'utf8').trim().split('\n').every(l => { const [d, f] = l.split('  '); return sha(readFileSync(here + f)) === d; }); }
export const lawDigest = () => sha(readFileSync(here + 'judge/Organ.lean'));
export function leanSource(bytes, negate) { const lit = '[' + [...bytes].join(', ') + ']';
  return `import Organ\nopen Organ\n-- candidate sha256 ${sha(bytes)}\ndef cand : List UInt8 := ${lit}\ntheorem cand_${negate ? 'unlawful : ¬ Law cand' : 'lawful : Law cand'} := by decide +kernel\n#print axioms cand_${negate ? 'unlawful' : 'lawful'}\n#eval IO.println ("TABLE " ++ table cand)\n`; }
function lean(file) { const r = spawnSync(LEAN, ['-j1', file], { env: { ...process.env, LEAN_PATH: here + 'work' }, encoding: 'utf8', timeout: 120000 }); return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') }; }
export function buildJudgeModel() { mkdirSync(here + 'work', { recursive: true }); const r = spawnSync(LEAN, ['-j1', here + 'judge/Organ.lean', '-o', here + 'work/Organ.olean'], { encoding: 'utf8' }); if (r.status !== 0) throw new Error('judge model does not check: ' + r.stderr); }
/** The law check on EXACT bytes: the Lean kernel evaluates the decidable statement that quotes them. */
export function lawCheck(bytes, tag) {
  const f = here + `work/${tag}.lean`; const src = leanSource(bytes, false); writeFileSync(f, src); const a = lean(f);
  const table = (a.out.match(/TABLE (\d+)/) || [])[1];
  if (a.ok && /depends on axioms: \[propext\]|does not depend on any axioms/.test(a.out) && !/sorryAx/.test(a.out)) return { verdict: 'LAW_HOLDS', proof: sha(src), table };
  const g = here + `work/${tag}-refute.lean`; const src2 = leanSource(bytes, true); writeFileSync(g, src2); const b = lean(g);
  return b.ok && !/sorryAx/.test(b.out) ? { verdict: 'LAW_VIOLATED', proof: sha(src2), table: (b.out.match(/TABLE (\d+)/) || [])[1] } : { verdict: 'LAW_UNDECIDED', proof: 'none', table };
}
/** The governed decision. Order is the policy's: nothing later is trusted if something earlier fails. */
export async function governed(pkg, state, pinned) {
  if (pkg.judge !== pinned.judge || !judgeIntact(here + 'judge/')) return { result: 'REFUSE', reason: 'JUDGE_MISMATCH' };           // before any score
  if (pkg.laws !== pinned.laws) return { result: 'REFUSE', reason: 'LAWSET_CONTINUITY' };
  if (pkg.parent !== state.incumbent) return { result: 'REFUSE', reason: 'STALE_PARENT' };
  if (pkg.bytes.length !== 31 || sha(pkg.bytes) !== pkg.cand) return { result: 'REFUSE', reason: 'BYTES_MISMATCH' };
  const law = lawCheck(pkg.bytes, 'cand-' + pkg.cand.slice(0, 12));
  if (law.verdict !== 'LAW_HOLDS') return { result: 'REFUSE', reason: law.verdict, proof: law.proof };
  const ev = await import(here + 'judge/evaluate.mjs');
  if (ev.table(pkg.bytes) !== law.table) return { result: 'REFUSE', reason: 'EVALUATOR_DISAGREES_WITH_MODEL', proof: law.proof };
  const score = ev.scoreOn(pkg.bytes, JSON.parse(readFileSync(here + 'judge/heldout.json')));
  return score > state.score ? { result: 'ADMIT', reason: 'ELIGIBLE_AND_BETTER', proof: law.proof, score } : { result: 'REFUSE', reason: 'NOT_BETTER', proof: law.proof, score };
}
export const line = o => 'ATTEMPT ' + Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ');
export const parse = t => Object.fromEntries(t.replace(/^ATTEMPT /, '').split(' ').map(kv => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
