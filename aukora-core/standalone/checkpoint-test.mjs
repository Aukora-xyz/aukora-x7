// Does the EXISTING minimal verifier (unchanged, pinned by digest) accept this adapter's checkpoints, and does it
// catch what the core alone cannot see? Usage: node checkpoint-test.mjs [path to verify.py]
// Only an explicit "VERDICT: APPEND_ONLY" line counts as a pass; every other verdict, or none, is a failure to pass.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Core, newOwner } from './aukora.mjs';
import { checkpoint, extendsCheckpoint, leafHashes, treeHead, consistencyProof } from './checkpoint.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const VERIFIER = process.argv[2] || join(here, '..', 'context-membrane', 'verify.py');
const VERIFIER_PIN = '039aa8999f9a1e1a8b8e01eb51598bfc546e4e574b2c9333f13e8bb303958089';
let pass = 0, fail = 0; const check = (name, got, want = true) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`); };
if (!existsSync(VERIFIER)) { console.log('FAIL the verifier file is not here: ' + VERIFIER); process.exit(1); }
check('the verifier is the pinned, unchanged file', createHash('sha256').update(readFileSync(VERIFIER)).digest('hex'), VERIFIER_PIN);
const py = (...a) => spawnSync('python3', ['-I', VERIFIER, ...a], { encoding: 'utf8' });
const verdict = r => (/^VERDICT: ([A-Z_]+)$/m.exec(r.stdout || '') || [])[1] || 'NO VERDICT LINE';
const reason = r => (/^REASON : (.+)$/m.exec(r.stdout || '') || [])[1] || '';
check('its own self-test passes', /SELFTEST: 4\/4 checks passed/.test(py('--selftest').stdout || ''));
const vec = f => join(dirname(VERIFIER), 'vectors', f);
check('its own vector: append-only', verdict(py(vec('retained.json'), vec('append-only.json'))), 'APPEND_ONLY');
check('its own vector: power of two', verdict(py(vec('power-of-two-retained.json'), vec('power-of-two-presented.json'))), 'APPEND_ONLY');
check('its own vector: rewritten', verdict(py(vec('retained.json'), vec('rewritten.json'))), 'OBSERVATION_CONFLICT');

const tmp = mkdtempSync(join(here, '.checkpoint-test-')); const put = (n, o) => { const p = join(tmp, n); writeFileSync(p, JSON.stringify(o, null, 2)); return p; };
try {
  // A real record in a real core: the genesis line and 4 lines, checkpoint kept; then it grows to 14.
  const owner = newOwner(); const c = await Core.load(); c.init(owner); for (let i = 1; i <= 4; i++) c.say('line ' + i);
  const early = c.exportRecord(); const kept = checkpoint(early); check('checkpoint after 5 lines', kept.treeSize, 5);
  for (let i = 5; i <= 13; i++) c.say('line ' + i); const grown = c.exportRecord();
  const honest = py(put('kept.json', kept), put('grown.json', checkpoint(grown, kept)));
  check('honest growth 5 -> 14: the unchanged verifier says', verdict(honest), 'APPEND_ONLY');
  check('a reader holding the record agrees', extendsCheckpoint(grown, kept));

  // A FORKED record: same owner and genesis, same first 2 lines, then a different history. Every line is valid.
  const f = await Core.load(); await f.replay(early.trim().split('\n').slice(0, 4).join('\n') + '\n'); for (let i = 3; i <= 13; i++) f.say('another story ' + i);
  const forked = f.exportRecord(); const g = await Core.load(); let coreSays; try { await g.replay(forked); coreSays = 'replays'; } catch { coreSays = 'refused'; }
  check('the forked record replays in a fresh core (the core alone cannot see a fork)', coreSays, 'replays');
  const fork = py(join(tmp, 'kept.json'), put('forked.json', checkpoint(forked, kept)));
  check('fork after line 2, against the checkpoint kept at 5: the verifier says', verdict(fork), 'OBSERVATION_CONFLICT');
  check('a reader holding the forked record also sees it', extendsCheckpoint(forked, kept), false);

  // A record CUT at the end (the last 2 of 5 kept lines dropped). It still replays; the checkpoint shows it.
  const cut = early.trim().split('\n').slice(0, 4).join('\n') + '\n'; const h = await Core.load(); let cutReplays; try { await h.replay(cut); cutReplays = 'replays'; } catch { cutReplays = 'refused'; }
  check('the cut record replays in a fresh core (the core alone cannot see a cut at the end)', cutReplays, 'replays');
  let refusal = ''; try { checkpoint(cut, kept); } catch (e) { refusal = e.message; } check('the adapter refuses to link a shorter record to the kept checkpoint', /lines are missing/.test(refusal));
  const shorter = py(join(tmp, 'kept.json'), put('cut.json', { ...checkpoint(cut), proofFromPrevious: [] }));
  check('a shorter record presented anyway: NOT append-only', verdict(shorter) !== 'APPEND_ONLY' && verdict(shorter) !== 'NO VERDICT LINE'); check('  verdict and reason', `${verdict(shorter)} ${reason(shorter)}`, 'UNDETERMINED invalid_tree_sizes');

  // The verifier's stated limit: a checkpoint kept at a power-of-two size cannot EARN the accusation; it still does not pass.
  const kept4 = checkpoint(early.trim().split('\n').slice(0, 5).join('\n') + '\n'); check('checkpoint after 4 lines', kept4.treeSize, 4);
  check('honest growth 4 -> 14', verdict(py(put('kept4.json', kept4), put('grown4.json', checkpoint(grown, kept4)))), 'APPEND_ONLY');
  const fork4 = py(join(tmp, 'kept4.json'), put('forked4.json', checkpoint(forked, kept4)));
  check('fork against a checkpoint kept at size 4: not a pass, and the stated limit is named', `${verdict(fork4)} ${reason(fork4)}`, 'UNDETERMINED POWER_OF_TWO_PREFIX_NOT_INDEPENDENTLY_DERIVABLE');

  // Sweep, in one run of the unchanged verifier's own function: every pair of sizes up to 40 lines, honest, forked,
  // and honest with each proof element changed in turn.
  for (let i = 14; i <= 39; i++) c.say('line ' + i); for (let i = 14; i <= 39; i++) f.say('another story ' + i);
  const A = leafHashes(c.exportRecord()), B = leafHashes(f.exportRecord()), hex = x => x.toString('hex'); const cases = [];
  for (let n = 1; n <= 40; n++) for (let m = 1; m <= n; m++) {
    const r1 = hex(treeHead(A.slice(0, m))), proof = consistencyProof(m, A.slice(0, n)).map(hex);
    cases.push({ kind: 'honest', m, n, r1, r2: hex(treeHead(A.slice(0, n))), proof });
    proof.forEach((_, i) => cases.push({ kind: 'damaged', m, n, r1, r2: hex(treeHead(A.slice(0, n))), proof: proof.map((p, j) => j === i ? hex(createHash('sha256').update(p).digest()) : p) }));
    if (m > 3 && n > m) cases.push({ kind: 'forked', m, n, r1, r2: hex(treeHead(B.slice(0, n))), proof: consistencyProof(m, B.slice(0, n)).map(hex) });   // the fork starts at leaf 3, inside the kept prefix
  }
  const driver = 'import sys,json,importlib.util\nspec=importlib.util.spec_from_file_location("v",sys.argv[1]);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)\nprint(json.dumps([v.verify_consistency(c["m"],c["n"],c["r1"],c["r2"],c["proof"])[0] for c in json.load(sys.stdin)]))';
  const run = spawnSync('python3', ['-I', '-c', driver, VERIFIER], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 26 }); const got = JSON.parse(run.stdout);
  const count = (kind, pred) => cases.filter((k, i) => k.kind === kind && pred(got[i], k)).length, total = kind => cases.filter(k => k.kind === kind).length, pow2 = m => (m & (m - 1)) === 0;
  check(`sweep: ${total('honest')} honest pairs, all APPEND_ONLY`, count('honest', v => v === 'APPEND_ONLY'), total('honest'));
  check(`sweep: ${total('damaged')} damaged proofs, none APPEND_ONLY`, count('damaged', v => v === 'APPEND_ONLY'), 0);
  check(`sweep: ${total('forked')} forked histories, none APPEND_ONLY`, count('forked', v => v === 'APPEND_ONLY'), 0);
  check('sweep: every fork against a checkpoint NOT kept at a power of two is an earned OBSERVATION_CONFLICT', count('forked', (v, k) => !pow2(k.m) && v !== 'OBSERVATION_CONFLICT'), 0);
  check('sweep: every fork against a power-of-two checkpoint is UNDETERMINED (the stated limit)', count('forked', (v, k) => pow2(k.m) && v !== 'UNDETERMINED'), 0);
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
