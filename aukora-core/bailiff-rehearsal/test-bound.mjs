// The bound bailiff rehearsal, LAB KEYS. Run: BAILIFF_CORE=$PWD/v0.8/aukora-core-lite.wasm node bailiff-rehearsal/test-bound.mjs [open|closed]
// The last argument says whether this core is expected to still admit an old-form approval in a bound record (blocker 12).
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'; import { randomBytes, sign, createPrivateKey, createPublicKey } from 'node:crypto'; import { join } from 'node:path';
import { newOwner, intentBytes } from '../standalone-next/aukora.mjs'; import { BoundBailiff, intentFor, load } from './bailiff-bound.mjs';
const here = new URL('.', import.meta.url).pathname, dir = mkdtempSync(join(here, 'run-')), dir2 = mkdtempSync(join(here, 'run-'));
let pass = 0, fail = 0; const check = (name, got, want = true) => { if (got === want) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name, '| got', JSON.stringify(got), '| wanted', JSON.stringify(want)); } };
const reason = r => (r.applied ? 'APPLIED' : r.accepted ? 'ACCEPTED' : r.reason);
const owner = newOwner(), base = randomBytes(32), patch = Buffer.from('a change she proposed\n'), other = Buffer.from('a chbnge she proposed\n');
const A = await load(); A.initBound(owner); A.say('record A'); const B = await load(); B.initBound(owner); B.say('record B, same owner');
const sink = new BoundBailiff(dir);
{ const old = await load(); old.init(owner); check('an old-start record is not taken at all', reason(await sink.accept(old.exportRecord())), 'RECORD_NOT_BOUND'); }
check('the sink is set up for record A', reason(await sink.accept(A.exportRecord())), 'ACCEPTED');
check('no approval: REFUSED', reason(await sink.promote(patch, base, { nonce: 1 })), 'NO_CURRENT_EXACT_PERMIT');
check('the twin record B of the same owner: REFUSED', reason(await sink.accept(B.exportRecord())), 'RECORD_NOT_THIS_ONE');
// an approval signed for the twin B does not help at A's sink, even carried as B's whole record
check('the owner approves the patch in record B', B.grantUntil(owner, intentFor(patch, base, { nonce: 1 }), B.seq + 20));
check('B\'s record with that approval, offered to A\'s sink: REFUSED', reason(await sink.accept(B.exportRecord())), 'RECORD_NOT_THIS_ONE');
check('B\'s approval frame alone, submitted into A: the core refuses it', A.submit(B.frames.at(-1)), false);
check('the owner approves the patch in record A', A.grantUntil(owner, intentFor(patch, base, { nonce: 1 }), A.seq + 20));
check('the sink takes A\'s longer record', reason(await sink.accept(A.exportRecord())), 'ACCEPTED');
check('one changed byte: REFUSED', reason(await sink.promote(other, base, { nonce: 1 })), 'NO_CURRENT_EXACT_PERMIT');
check('the exact patch: APPLIED', reason(await sink.promote(patch, base, { nonce: 1 })), 'APPLIED');
check('again: REFUSED', reason(await sink.promote(patch, base, { nonce: 1 })), 'NO_CURRENT_EXACT_PERMIT');
const spent = readFileSync(dir + '/record.txt', 'utf8'), lines = spent.trim().split('\n');
writeFileSync(dir + '/record.txt', lines.slice(0, -1).join('\n') + '\n'); check('rolled back to before the act: REFUSED', reason(await sink.promote(patch, base, { nonce: 1 })), 'RECORD_SHORTER');
{ const l = [...lines]; l[2] = (l[2][0] === '0' ? '1' : '0') + l[2].slice(1); writeFileSync(dir + '/record.txt', l.join('\n') + '\n'); check('the host value line changed: REFUSED as another record', reason(await sink.promote(patch, base, { nonce: 1 })), 'RECORD_NOT_THIS_ONE'); }
writeFileSync(dir + '/record.txt', spent); check('one file in the tree', readdirSync(dir + '/tree').length, 1);
// WATCH (readiness blocker 12) at the level that matters: can an OLD-FORM approval, which names no record, move this sink?
{ const s2 = new BoundBailiff(dir2), X = await load(); X.initBound(owner); X.say('record X'); const p = Buffer.from('a patch approved by an old-form signature\n'), it = intentFor(p, base, { nonce: 9 });
  const ed = createPrivateKey(owner.ed), ml = createPrivateKey(owner.ml), edPub = createPublicKey(ed).export({ type: 'spki', format: 'der' }).subarray(-32), mlPub = createPublicKey(ml).export({ type: 'spki', format: 'der' }).subarray(-1952);
  const blob = b => Buffer.concat([Buffer.from([b.length & 255, b.length >> 8]), b]), u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }, i = intentBytes(it);
  const msg = Buffer.concat([blob(Buffer.from('AUKORA/R7/hybrid/grant')), blob(edPub), blob(mlPub), i]), sEd = sign(null, msg, ed), sMl = sign(null, msg, ml);
  // ONE pair of signatures. First used in a twin record Y of the same owner; then the SAME signatures, re-addressed, in X.
  const Y = await load(); Y.initBound(owner); Y.say('record Y, the twin'); const frame = h => Buffer.concat([Buffer.from([0x13]), sMl, h.head(), u64(h.seq + 1), Buffer.from([0x03]), i, sEd]);
  const usedInY = Y.submit(frame(Y)), admitted = X.submit(frame(X));
  let moved = false; await s2.accept(X.exportRecord()); if (usedInY && admitted) moved = (await s2.promote(p, base, { nonce: 9 })).applied === true;
  console.log(`WATCH blocker 12 at the sink: one old-form approval signature, already used in a twin record, also moves this bound sink: ${moved ? 'YES (still open in this core)' : 'NO (closed in this core)'}`);
  check(`as expected for this core (${process.argv[2] ?? 'open'})`, moved, (process.argv[2] ?? 'open') === 'open'); }
console.log(`${pass} passed, ${fail} failed (bound bailiff rehearsal, LAB KEYS, core ${A.coreDigest.slice(0, 16)}…)`);
rmSync(dir, { recursive: true, force: true }); rmSync(dir2, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
