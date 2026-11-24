// The bailiff rehearsal, end to end, with LAB keys. Run: node bailiff-rehearsal/test.mjs
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'; import { randomBytes } from 'node:crypto'; import { join } from 'node:path';
import { Core, newOwner } from '../standalone/aukora.mjs'; import { Bailiff, intentFor, CORE } from './bailiff.mjs';
const here = new URL('.', import.meta.url).pathname, dir = mkdtempSync(join(here, 'run-'));
let pass = 0, fail = 0; const check = (name, got, want = true) => { if (got === want) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name, '| got', JSON.stringify(got), '| wanted', JSON.stringify(want)); } };
const owner = newOwner(), stranger = newOwner(), base = randomBytes(32);
const patch = Buffer.from('--- a/organ.js\n+++ b/organ.js\n@@ the change she proposed @@\n'), other = Buffer.from(patch); other[other.length - 2] ^= 1;
// the owner's side: a core record held by the owner's tool, which signs approvals. The sink never signs.
const tool = await Core.load(CORE); tool.init(owner); tool.say('rehearsal record, lab keys');
const sink = new Bailiff(dir); const reason = r => (r.applied ? 'APPLIED' : r.reason);
check('no record yet: refused', reason(await sink.promote(patch, base, { nonce: 1 })), 'NO_RECORD');
check('the sink takes the record', (await sink.accept(tool.exportRecord())).accepted);
check('no approval: REFUSED (red)', reason(await sink.promote(patch, base, { nonce: 1 })), 'NO_CURRENT_EXACT_PERMIT');
check('nothing was written', readdirSync(dir + '/tree').length, 0);
// an approval by someone who is not the owner
check('a stranger\'s approval is not admitted by the core', tool.grantUntil(stranger, intentFor(patch, base, { nonce: 1 }), tool.seq + 20), false);
// the owner approves exactly these bytes on exactly this base
check('the owner approves these exact bytes', tool.grantUntil(owner, intentFor(patch, base, { nonce: 1 }), tool.seq + 20));
check('the sink takes the longer record', (await sink.accept(tool.exportRecord())).accepted);
check('one changed byte in the patch: REFUSED', reason(await sink.promote(other, base, { nonce: 1 })), 'NO_CURRENT_EXACT_PERMIT');
check('the same patch on another base: REFUSED', reason(await sink.promote(patch, randomBytes(32), { nonce: 1 })), 'NO_CURRENT_EXACT_PERMIT');
check('the same patch under another number: REFUSED', reason(await sink.promote(patch, base, { nonce: 2 })), 'NO_CURRENT_EXACT_PERMIT');
check('still nothing written', readdirSync(dir + '/tree').length, 0);
const done = await sink.promote(patch, base, { nonce: 1 }); check('the exact patch on the exact base: APPLIED', reason(done), 'APPLIED');
check('the effect is the exact bytes', existsSync(`${dir}/tree/${done.file}`) && readFileSync(`${dir}/tree/${done.file}`).equals(patch));
check('the same permit a second time: REFUSED (one act per approval)', reason(await sink.promote(patch, base, { nonce: 1 })), 'NO_CURRENT_EXACT_PERMIT');
const spent = readFileSync(dir + '/record.txt', 'utf8');
// roll the sink's record back to before the act: the approval would be unspent again
const lines = spent.trim().split('\n'); writeFileSync(dir + '/record.txt', lines.slice(0, -1).join('\n') + '\n');
check('record rolled back to before the act: REFUSED', reason(await sink.promote(patch, base, { nonce: 1 })), 'RECORD_SHORTER');
{ const l = [...lines]; l[2] = l[2].slice(0, -2) + (l[2].endsWith('64') ? '65' : '64'); writeFileSync(dir + '/record.txt', l.join('\n') + '\n'); }
check('an early line of the record changed: REFUSED', /^RECORD_/.test(reason(await sink.promote(patch, base, { nonce: 1 }))));
writeFileSync(dir + '/record.txt', spent);
// the owner's tool is behind the sink now; it must take the sink's record before signing more
const tool2 = await Core.load(CORE); await tool2.replay(spent); const p2 = Buffer.from('second patch'), p3 = Buffer.from('third patch'), p4 = Buffer.from('fourth patch');
check('an approval that expires', tool2.grantUntil(owner, intentFor(p2, base, { nonce: 5 }), tool2.seq + 2)); tool2.say('one'); tool2.say('two'); tool2.say('three');
check('an approval that is cancelled', tool2.grantUntil(owner, intentFor(p3, base, { nonce: 6 }), tool2.seq + 30) && tool2.revoke(owner, intentFor(p3, base, { nonce: 6 })));
check('a live approval', tool2.grantUntil(owner, intentFor(p4, base, { nonce: 7 }), tool2.seq + 30));
check('the sink takes the longer record', (await sink.accept(tool2.exportRecord())).accepted);
check('expired approval: REFUSED', reason(await sink.promote(p2, base, { nonce: 5 })), 'NO_CURRENT_EXACT_PERMIT');
check('cancelled approval: REFUSED', reason(await sink.promote(p3, base, { nonce: 6 })), 'NO_CURRENT_EXACT_PERMIT');
check('a record from the owner\'s tool that forgets the spent act: REFUSED', (await sink.accept(tool.exportRecord())).reason, 'RECORD_SHORTER');
check('live approval: APPLIED', reason(await sink.promote(p4, base, { nonce: 7 })), 'APPLIED');
check('two files in the tree, no more', readdirSync(dir + '/tree').length, 2);
console.log(`${pass} passed, ${fail} failed (bailiff rehearsal, LAB KEYS, core ${tool.coreDigest.slice(0, 16)}…)`);
rmSync(dir, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
