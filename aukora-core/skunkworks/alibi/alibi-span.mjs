// SIDE LAB: an alibi for a SPAN of a record, tied to checkpoints that a second reader kept.
// "Between the checkpoint I kept on Monday and the one I kept on Friday, this mind did not read X."
// Three roles: the HOST runs the record; the AUDITOR holds the record and two kept checkpoints; a THIRD PARTY holds neither
// and receives one statement and one short proof. Run: node alibi-span.mjs   (Node and Python only, no Lean)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'; import { createHash } from 'node:crypto'; import { spawnSync } from 'node:child_process'; import { join } from 'node:path';
const LAB = new URL('../../', import.meta.url).pathname; const { Core, newOwner } = await import(LAB + 'standalone/aukora.mjs'); const { checkpoint } = await import(LAB + 'standalone/checkpoint.mjs');
const { keyOf, readsOf, rootOfSet, prove, verifyPresent, verifyAbsent } = await import('./alibi.mjs');
const VERIFIER = LAB + 'context-membrane/verify.py'; if (createHash('sha256').update(readFileSync(VERIFIER)).digest('hex') !== '039aa8999f9a1e1a8b8e01eb51598bfc546e4e574b2c9333f13e8bb303958089') throw new Error('the verifier is not the pinned file');
let pass = 0, fail = 0; const check = (name, got, want = true) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`); };
const tmp = mkdtempSync(join(new URL('./', import.meta.url).pathname, '.alibi-span-'));
const appendOnly = (kept, now) => { const a = join(tmp, 'a.json'), b = join(tmp, 'b.json'); writeFileSync(a, JSON.stringify(kept)); writeFileSync(b, JSON.stringify(now)); return (/^VERDICT: ([A-Z_]+)$/m.exec(spawnSync('python3', ['-I', VERIFIER, a, b], { encoding: 'utf8' }).stdout || '') || [])[1] || 'NO VERDICT LINE'; };
const lines = rec => rec.trimEnd().split('\n'); const prefix = (rec, n) => lines(rec).slice(0, 1 + n).join('\n') + '\n';
// the reads on leaves [m, n): the genesis line is kept in front only because the reader skips leaf 0
const spanReads = (rec, m, n) => { const L = lines(rec); return readsOf([L[0], L[1], ...L.slice(1 + Math.max(m, 1), 1 + n)].join('\n') + '\n'); };
/** The AUDITOR's statement. It is issued only if the record matches BOTH kept checkpoints. */
function audit(rec, keptStart, keptEnd) {
  if (lines(rec).length - 1 < keptEnd.treeSize) return { refused: 'the record is shorter than the kept end checkpoint' };
  const end = checkpoint(prefix(rec, keptEnd.treeSize), keptStart);
  if (end.root !== keptEnd.root) return { refused: 'the record does not match the checkpoint kept at the end of the span' };
  if (appendOnly(keptStart, end) !== 'APPEND_ONLY') return { refused: 'the record does not extend the checkpoint kept at the start of the span' };
  return { span: [keptStart.treeSize, keptEnd.treeSize], start: keptStart.root, end: keptEnd.root, readsRoot: rootOfSet(spanReads(rec, keptStart.treeSize, keptEnd.treeSize).map(keyOf)) };
}
try {
  // Monday: four lines exist. The auditor keeps a checkpoint.
  const c = await Core.load(); c.init(newOwner()); c.say('note: start'); c.say('READ contracts/2025.pdf'); c.say('note: earlier work');
  const monday = checkpoint(c.exportRecord());
  // During the week the mind reads three things and notes others.
  for (const s of ['READ inbox/supplier.eml', 'note: drafting', 'READ ledger/q3.csv', 'READ inbox/supplier.eml', 'note: done']) c.say(s);
  const friday = checkpoint(c.exportRecord()); const rec = c.exportRecord();
  c.say('READ hr/salaries.xlsx');                                  // after Friday: outside the span
  const full = c.exportRecord();
  const st = audit(full, monday, friday);
  check('the auditor issues a statement for Monday..Friday (the record matches both kept checkpoints)', !st.refused && st.span.join('..'), `${monday.treeSize}..${friday.treeSize}`);
  // THIRD PARTY: holds only the statement and a proof.
  const reads = spanReads(full, monday.treeSize, friday.treeSize).map(keyOf), X = keyOf('hr/salaries.xlsx'), Y = keyOf('ledger/q3.csv'), Z = keyOf('contracts/2025.pdf');
  check('third party: "did not read hr/salaries.xlsx in the span" verifies', verifyAbsent(st.readsRoot, X, prove(reads, X)));
  check('third party: "did read ledger/q3.csv in the span" verifies', verifyPresent(st.readsRoot, Y, prove(reads, Y)));
  check('third party: a claim of NOT having read ledger/q3.csv cannot be made', verifyAbsent(st.readsRoot, Y, prove(reads, Y)), false);
  check('the read before Monday is not in the span (absent), the read after Friday is not in the span (absent)', verifyAbsent(st.readsRoot, Z, prove(reads, Z)) && verifyAbsent(st.readsRoot, X, prove(reads, X)));
  // HOST LIES 1: hands the auditor a record with the ledger read replaced by a harmless note (same length).
  { const d = await Core.load(); await d.replay(prefix(rec, monday.treeSize)); for (const s of ['READ inbox/supplier.eml', 'note: drafting', 'note: nothing here', 'READ inbox/supplier.eml', 'note: done']) d.say(s);
    check('lie 1: a record with one read replaced still replays in the core (the core alone cannot see it)', (await (await Core.load()).replay(d.exportRecord())).length, 64);
    check('   but the auditor refuses to issue a statement for it', audit(d.exportRecord(), monday, friday).refused, 'the record does not match the checkpoint kept at the end of the span'); }
  // HOST LIES 2: hands over a record cut before the ledger read.
  check('lie 2: a record cut inside the span is refused', audit(prefix(rec, monday.treeSize + 2), monday, friday).refused, 'the record is shorter than the kept end checkpoint');
  // THE LIMIT, shown on purpose: nobody kept a checkpoint on Friday. The host forks after Monday and the "end" is whatever it says.
  { const d = await Core.load(); await d.replay(prefix(rec, monday.treeSize)); for (const s of ['READ inbox/supplier.eml', 'note: drafting', 'note: nothing here', 'READ inbox/supplier.eml', 'note: done']) d.say(s);
    const fake = d.exportRecord(), fakeFriday = checkpoint(fake); const s2 = audit(fake, monday, fakeFriday); const r2 = spanReads(fake, monday.treeSize, fakeFriday.treeSize).map(keyOf);
    check('LIMIT: with no checkpoint kept at the END of the span, the forged week passes and yields a false alibi for ledger/q3.csv', !s2.refused && verifyAbsent(s2.readsRoot, Y, prove(r2, Y))); }
  // THE OTHER LIMIT: an alibi is about NAMES. The same file under another name is a different key.
  check('LIMIT: "Ledger/Q3.csv" (other case) is absent although ledger/q3.csv was read', verifyAbsent(st.readsRoot, keyOf('Ledger/Q3.csv'), prove(reads, keyOf('Ledger/Q3.csv'))));
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
