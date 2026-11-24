// Mythos: does the 38-form table of v0.9 and later (Forms.lean, `formOf`) name real frames the way the machine treats them?
// (mythos-forms.mjs is the same test for the 31-form table of v0.8.)
// `formOf` exists only in the Lean text, so it is ported here by hand (30 lines, same offsets) and run on frames the core ADMITS.
// For every admitted frame: its form must be the one its builder meant. Then, for every admitted frame, each selector byte is
// changed to every other value: if the core still admits the changed frame, its form is printed (a frame the machine takes that
// the table files under another name, or under none, is a way round a future restriction).
// Usage: node mythos-forms-38.mjs <core.wasm>
import { Core, newOwner } from '../../standalone-next/aukora.mjs';
const at = (w, i) => (i < w.length ? w[i] : 256);
function formOf(w) { const b = at(w, 0);
  if (b === 0x00) { const a = at(w, 41); return { 0: 'say', 1: 'remember', 2: 'correct', 6: 'advise', 5: 'report', 0x0d: 'spend', 0x10: 'read' }[a] ?? null; }
  if (b === 0x13) { const a = at(w, 3350); return { 3: 'approval', 9: 'retract', 0x0a: 'mandate', 0x0c: 'budget', 0x0e: 'pass', 0x0f: 'revoke' }[a] ?? null; }
  const tags = { 0x14: 'legacyKeyChange', 0x15: 'assessment', 0x16: 'threshold', 0x17: 'act', 0x18: 'timedApproval', 0x19: 'cancel', 0x1a: 'correction', 0x1b: 'install' };
  if (b in tags) return tags[b];
  if (b === 0xff) { const v = at(w, 1), t = at(w, 2);
    if (v === 2) { if (t === 0x29) return ['evidenceRead', 'evidenceSource', 'evidenceOutcome'][at(w, 43)] ?? null;
      return { 0x28: 'evidenceAssessment', 0x2a: 'premise', 0x2b: 'ceiling', 0x32: 'halt', 0x33: 'clear', 0x34: 'refusedAct', 0x35: 'keyChange' }[t] ?? null; }
    if (v === 3) return { 1: 'cellReceipt', 2: 'cellAssessment' }[t] ?? null; }
  return null; }
const file = process.argv[2]; let pass = 0, fail = 0; const check = (name, got, want) => { if (got === want) pass++; else { fail++; console.log('FAIL', name, '| table says', got, '| meant', want); } };
const owner = newOwner(), next = newOwner(), c = await Core.load(file, { allowUnpinned: true }); c.init(owner);
const made = []; const did = (want, ok) => { if (!ok) { fail++; console.log('FAIL the core did not admit a', want); return; } made.push([want, c.frames.at(-1)]); };
const i1 = { payload: 'one', audience: 'a', generation: 0, nonce: 1 }, i2 = { payload: 'two', audience: 'a', generation: 0, nonce: 2 }, i3 = { payload: 'three', audience: 'a', generation: 0, nonce: 3 };
did('say', c.say('a line')); did('advise', c.advise('cell', 3));
did('approval', c.grant(owner, i1)); did('act', c.act(i1)); did('report', c.outcome(i1, 'confirmed')); did('correction', c.correctOutcome(i1, 'failed'));
did('timedApproval', c.grantUntil(owner, i2, c.seq + 9)); did('cancel', c.revoke(owner, i2)); did('threshold', c.setThreshold(owner, 5));
did('halt', c.halt(owner)); did('clear', c.clear(owner)); did('keyChange', c.changeKeys(owner, next));
did('timedApproval', c.grantUntil(next, { ...i3, generation: 1 }, c.seq + 9, 1));
{ const d = await Core.load(file, { allowUnpinned: true }); d.init(owner); const ok = d.rebind(owner, next); if (ok) made.push(['legacyKeyChange', d.frames.at(-1)]); else { fail++; console.log('FAIL the core did not admit the old key change'); } }
for (const [want, w] of made) check(`admitted ${want} frame (${w.length} bytes, first byte ${w[0].toString(16)})`, formOf(w), want);
// selector bytes: one core walks the record; before each real frame, every changed copy of it is offered first. A refusal leaves
// the state as it was, so the walk goes on; if a changed copy is admitted, it is noted and the core is rebuilt by replay.
let still = 0, tried = 0; const odd = [];
const fresh = async upto => { const d = await Core.load(file, { allowUnpinned: true }); d.init(owner); for (let k = 0; k < upto; k++) if (!d.submit(c.frames[k])) throw new Error('replay broke'); return d; };
let d = await fresh(0);
for (let n = 0; n < c.frames.length; n++) { const w = c.frames[n], was = formOf(w);
  for (const pos of [0, 1, 2, 41, 43, 3350].filter(p => p < w.length)) for (let v = 0; v < 256; v++) { if (v === w[pos]) continue; tried++;
    const m = Buffer.from(w); m[pos] = v;
    if (d.submit(m)) { still++; const now = formOf(m); if (now !== was) odd.push(`line ${n + 1} (${was}): byte ${pos} ${w[pos].toString(16)} -> ${v.toString(16)} still admitted; the table now says ${now}`); d = await fresh(n); } }
  if (!d.submit(w)) throw new Error('the walk lost the record at line ' + (n + 1)); }
console.log(`${pass} of ${pass + fail} admitted frames are filed under the form their builder meant`);
console.log(`${tried} selector-byte changes tried; ${still} still admitted; ${odd.length} of those change what the table calls the frame`);
for (const o of odd.slice(0, 20)) console.log('  ' + o);
process.exit(fail ? 1 : 0);
