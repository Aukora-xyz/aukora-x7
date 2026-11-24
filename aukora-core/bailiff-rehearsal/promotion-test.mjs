// The pure bailiff against real records made with LAB keys. Also writes promotion-fixture.json: one record, one acknowledgment
// and the expected word for each case, for a gate test that has no keys at all.
// Run: BAILIFF_CORE=$PWD/v0.8/aukora-core-lite.wasm node bailiff-rehearsal/promotion-test.mjs [--write]
import { readFileSync, writeFileSync } from 'node:fs'; import { randomBytes } from 'node:crypto';
import { Core, newOwner, intentBytes } from '../standalone-next/aukora.mjs'; import { judgePromotion, promotionIntent, AUDIENCE } from './core-bailiff.mjs';
const file = process.env.BAILIFF_CORE, bytes = readFileSync(file), mod = new WebAssembly.Module(bytes);
let pass = 0, fail = 0; const check = (name, got, want) => { if (got === want) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name, '| got', got, '| wanted', want); } };
const id = () => randomBytes(32).toString('hex'), ZERO = '0'.repeat(64);
const owner = newOwner(), stranger = newOwner(), ballA = id(), ballB = id(), ballC = id(), parent0 = ZERO;
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const asIntent = p => ({ payload: Buffer.concat([Buffer.from(p.ballId, 'hex'), Buffer.from(p.parentBallId, 'hex'), u64(p.epoch)]), audience: AUDIENCE, generation: 0, nonce: p.epoch & 0xffff });
const P = { a: { ballId: ballA, parentBallId: parent0, epoch: 7 }, b: { ballId: ballB, parentBallId: ballA, epoch: 8 }, c: { ballId: ballC, parentBallId: ballB, epoch: 9 } };
check('the module and the owner tool build the same intent bytes', Buffer.from(promotionIntent(P.a)).equals(intentBytes(asIntent(P.a))), true);
const tool = await Core.load(file, { allowUnpinned: true }); tool.initBound(owner); tool.say('promotion rehearsal, lab keys');
const start = tool.exportRecord(); let ack = null, record = start;
const j = async (p, r = record, a = ack, c = mod) => (await judgePromotion(c, { recordText: r, ack: a, ...p }));
check('no approval at all', (await j(P.a)).verdict, 'NO_CURRENT_EXACT_PERMIT');
check('a stranger cannot approve', tool.grantUntil(stranger, asIntent(P.a), tool.seq + 30), false);
check('the owner approves promotion A (and B, then cancels B)', tool.grantUntil(owner, asIntent(P.a), tool.seq + 30) && tool.grantUntil(owner, asIntent(P.b), tool.seq + 30) && tool.revoke(owner, asIntent(P.b)), true);
record = tool.exportRecord(); const fixtureRecord = record;
check('another manifest', (await j({ ...P.a, ballId: ballC })).verdict, 'NO_CURRENT_EXACT_PERMIT');
check('the same manifest on another parent', (await j({ ...P.a, parentBallId: ballB })).verdict, 'NO_CURRENT_EXACT_PERMIT');
check('the same manifest at another epoch', (await j({ ...P.a, epoch: 8 })).verdict, 'NO_CURRENT_EXACT_PERMIT');
check('the cancelled approval', (await j(P.b)).verdict, 'NO_CURRENT_EXACT_PERMIT');
check('the same manifest at an epoch 65,536 later (same low 16 bits)', (await j({ ...P.a, epoch: 7 + 65536 })).verdict, 'NO_CURRENT_EXACT_PERMIT');
const first = await j(P.a); check('the approved promotion: ADMIT', first.verdict, 'ADMIT');
check('the same answer from the file bytes as from the compiled module', (await j(P.a, record, ack, bytes)).verdict, 'ADMIT');
const stale = record; record = first.recordText; ack = first.ack;
check('the grown record replays in the owner tool to the acknowledged head', await (await Core.load(file, { allowUnpinned: true })).replay(record, { expectId: ack.id }), ack.head);
check('the same approval again', (await j(P.a)).verdict, 'NO_CURRENT_EXACT_PERMIT');
check('the record from before the act, with the newer acknowledgment', (await j(P.a, stale)).verdict, 'RECORD_SHORTER');
{ const l = record.trim().split('\n'); l[3] = l[3].slice(0, -2) + (l[3].endsWith('73') ? '74' : '73'); check('an early line changed', (await j(P.c, l.join('\n'))).verdict, 'RECORD_DOES_NOT_REPLAY'); }
{ const l = record.trim().split('\n'); const cut = l.slice(0, 4).join('\n'), a = { ...ack, lines: 1 }; l[3] = l[3].slice(0, -2) + (l[3].endsWith('73') ? '74' : '73'); check('the only acknowledged line changed', (await j(P.c, l.slice(0, 4).join('\n'), a)).verdict, 'RECORD_REWRITTEN'); void cut; }
{ const twin = await Core.load(file, { allowUnpinned: true }); twin.initBound(owner); twin.say('a twin record'); twin.grantUntil(owner, asIntent(P.c), twin.seq + 30); twin.say('pad'); twin.say('pad'); twin.say('pad');
  check('a twin record of the same owner, holding a valid approval', (await j(P.c, twin.exportRecord())).verdict, 'RECORD_NOT_THIS_ONE'); }
{ const old = await Core.load(file, { allowUnpinned: true }); old.init(owner); check('an old-start record', (await j(P.c, old.exportRecord(), null)).verdict, 'RECORD_NOT_BOUND'); }
check('an id that is not 64 hex characters', (await j({ ...P.a, ballId: 'xyz' })).verdict, 'UNAVAILABLE');
check('a core file with one changed byte', (await j(P.c, record, ack, (() => { const b = Buffer.from(bytes); b[b.length - 9] ^= 1; return b; })())).verdict === 'ADMIT', false);
const fixture = { note: 'LAB KEYS. Public keys and signatures only. A rehearsal, not anyone\'s consent.', corePin: '2f10eb8fd9adb3f25d854b642bba29ceaadcbcb2cc40a2fb05fca51f770b59e9', audience: AUDIENCE,
  recordText: fixtureRecord, ack: null, cases: [
    { name: 'approved promotion', ...P.a, expect: 'ADMIT' }, { name: 'another manifest', ...P.a, ballId: ballC, expect: 'NO_CURRENT_EXACT_PERMIT' },
    { name: 'another parent', ...P.a, parentBallId: ballB, expect: 'NO_CURRENT_EXACT_PERMIT' }, { name: 'another epoch', ...P.a, epoch: 8, expect: 'NO_CURRENT_EXACT_PERMIT' }, { name: 'epoch 65,536 later', ...P.a, epoch: 7 + 65536, expect: 'NO_CURRENT_EXACT_PERMIT' },
    { name: 'cancelled approval', ...P.b, expect: 'NO_CURRENT_EXACT_PERMIT' }],
  afterAdmit: { ack: first.ack, replayOfSameApproval: 'NO_CURRENT_EXACT_PERMIT', olderRecordWithThisAck: 'RECORD_SHORTER' } };
if (process.argv.includes('--write')) { writeFileSync(new URL('./promotion-fixture.json', import.meta.url), JSON.stringify(fixture, null, 1) + '\n'); console.log('wrote promotion-fixture.json'); }
console.log(`${pass} passed, ${fail} failed (pure bailiff, LAB KEYS, core ${tool.coreDigest.slice(0, 16)}…)`); process.exit(fail ? 1 : 0);
