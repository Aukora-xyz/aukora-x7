// End-to-end test of the next-line adapter in BOUND mode. Run: node standalone-next/bound-test.mjs <core.wasm> [expected sha256]
// Lab only. The core file is not a released pin, so it is loaded unpinned and its digest is checked here instead.
import { createHash, randomBytes, sign, createPrivateKey, createPublicKey } from 'node:crypto'; import { readFileSync } from 'node:fs';
import { Core, newOwner, intentBytes } from './aukora.mjs';
const file = process.argv[2], want = process.argv[3]; const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
let pass = 0, fail = 0; const check = (name, got, expected = true) => { if (got === expected) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name, '| got', got, '| wanted', expected); } };
const thrown = f => { try { f(); return 'no error'; } catch (e) { return String(e.message); } };
const load = () => Core.load(file, { allowUnpinned: true });
if (want) check('the core file is the one named on the command line', digest, want);
const owner = newOwner(), stranger = newOwner(), next = newOwner();
const c = await load(); const first = c.initBound(owner);
check('bound start: the first head is the record identifier', first, c.recordId());
check('speech is free', c.say('first line of a bound record'));
const pay = { payload: 'send the weekly report to the team', audience: 'mail', generation: 0, nonce: 1 };
check('act without approval is refused', c.act(pay), false);
check('the adapter will not sign the old one-time approval in a bound record', /names no record/.test(thrown(() => c.grant(owner, pay))));
check('the adapter will not sign the old key change in a bound record', /names no record/.test(thrown(() => c.rebind(owner, next))));
check('a timed approval by a stranger is refused', c.grantUntil(stranger, pay, c.seq + 5), false);
check('a timed approval by the owner is admitted', c.grantUntil(owner, pay, c.seq + 5));
check('the approved act is admitted', c.act(pay));
check('the same approval cannot be used twice', c.act(pay), false);
check('the owner moves the danger threshold', c.setThreshold(owner, 10)); check('threshold reads back', c.threshold(), 10);
// stop and clear
check('a stranger cannot stop the record', c.halt(stranger), false);
check('the owner stops the record', c.halt(owner)); check('the core says it is stopped', c.halted(), true);
const held = { payload: 'while stopped', audience: 'mail', generation: 0, nonce: 2 };
check('while stopped, a new approval is refused', c.grantUntil(owner, held, c.seq + 5), false);
check('a stranger cannot clear the stop', c.clear(stranger), false);
check('the owner clears the stop', c.clear(owner)); check('the core says it is running', c.halted(), false);
check('after the clear, the approval is admitted', c.grantUntil(owner, held, c.seq + 5)); check('and its act', c.act(held));
// key change, newer form
check('a stranger cannot change the keys', c.changeKeys(stranger, next), false);
check('the owner changes the keys (newer form, signs the head)', c.changeKeys(owner, next));
const again = { payload: 'after the key change', audience: 'mail', generation: 1, nonce: 3 };
check('the old keys no longer approve', c.grantUntil(owner, again, c.seq + 5, 1), false);
check('the new keys approve', c.grantUntil(next, again, c.seq + 5, 1)); check('and that approval works', c.act(again));
check('the identifier did not change with the keys', c.recordId(), first);
// replay
const head = c.headHex(), record = c.exportRecord(), lines = record.trim().split('\n');
const d = await load(); check('replay gives the same head', await d.replay(record), head); check('replay gives the same identifier', d.recordId(), first);
const e = await load(); check('replay that names the right record passes', await e.replay(record, { expectId: first }), head);
const attempt = async (text, opts) => { const x = await load(); try { return await x.replay(text, opts); } catch (err) { return 'refused: ' + String(err.message).slice(0, 60); } };
check('replay that names another record is refused', /^refused: this is a different record/.test(await attempt(record, { expectId: 'ab'.repeat(32) })));
{ const l = [...lines]; l[2] = (l[2].startsWith('0') ? '1' : '0') + l[2].slice(1); check('one changed character in the host value: the record no longer replays', /^refused/.test(await attempt(l.join('\n')))); }
{ const l = [...lines]; l.splice(5, 1); check('a dropped middle line is caught', /^refused/.test(await attempt(l.join('\n')))); }
{ const l = [...lines]; l[0] = 'aukora-record v0.1'; l.splice(2, 1); check('the same lines presented as an old-start record do not replay', /^refused/.test(await attempt(l.join('\n')))); }
// twins: same owner, different host values
const A = await load(), B = await load(); A.initBound(owner); B.initBound(owner);
check('two bound records of one owner have different identifiers', A.recordId() !== B.recordId());
const order = { payload: 'pay the supplier', audience: 'bank', generation: 0, nonce: 7 };
check('A admits its own timed approval', A.grantUntil(owner, order, 9)); const frameA = A.frames.at(-1), before = B.headHex();
check('the same bytes are refused by the twin', B.submit(frameA), false);
{ const moved = Buffer.from(frameA); const from = Buffer.from(A.recordId(), 'hex'), to = Buffer.from(B.recordId(), 'hex'); let i = moved.indexOf(from), n = 0; while (i >= 0) { to.copy(moved, i); n++; i = moved.indexOf(from, i + 32); }
  check('the frame carries A\'s identifier as its parent (first line of the record)', n > 0); check('re-addressed to the twin with A\'s signatures: refused', B.submit(moved), false); }
check('the twin did not move', B.headHex(), before);
check('the twin cannot act on A\'s approval', B.act(order), false);
// same descriptor twice is the same record twice (a stated limit; the adapter draws 32 random bytes so it does not happen by accident)
{ const v = randomBytes(32), P = await load(), Q = await load(); P.initBound(owner, v); Q.initBound(owner, v); check('LIMIT, stated: the same keys and the same host value give the same identifier', P.recordId(), Q.recordId()); }
// WATCH (readiness blocker 12): does this core still admit one old-form signature in two bound records? The adapter never makes
// such a frame; this builds one by hand to observe the core. Today the expected answer is yes. Root v2 must turn it into no.
{ const X = await load(), Y = await load(); X.initBound(owner); Y.initBound(owner);
  const ed = createPrivateKey(owner.ed), ml = createPrivateKey(owner.ml), edPub = createPublicKey(ed).export({ type: 'spki', format: 'der' }).subarray(-32), mlPub = createPublicKey(ml).export({ type: 'spki', format: 'der' }).subarray(-1952);
  const blob = b => Buffer.concat([Buffer.from([b.length & 255, b.length >> 8]), b]), u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const loose = { payload: 'an approval that names no record', audience: 'bank', generation: 0, nonce: 9 }, i = intentBytes(loose), msg = Buffer.concat([blob(Buffer.from('AUKORA/R7/hybrid/grant')), blob(edPub), blob(mlPub), i]);
  const sEd = sign(null, msg, ed), sMl = sign(null, msg, ml); const frame = h => Buffer.concat([Buffer.from([0x13]), sMl, h.head(), u64(h.seq + 1), Buffer.from([0x03]), i, sEd]);
  const inX = X.submit(frame(X)), inY = Y.submit(frame(Y)); const travels = inX && inY && X.act(loose) && Y.act(loose);
  console.log(`WATCH blocker 12: one old-form signature admitted and acted on in two bound records: ${travels ? 'YES (still open in this core)' : 'NO (closed in this core)'}`);
  const expected = (process.argv[4] ?? 'open') === 'open'; check(`blocker 12 is ${expected ? 'still open' : 'closed'} in this core, as expected for it`, travels, expected); }
// the old start still works here, with the old forms
{ const o = await load(); o.init(owner); check('old start: no identifier', o.recordId(), null); check('old start: the one-time approval is still signed', o.grant(owner, pay)); check('and its act', o.act(pay));
  const r = o.exportRecord(); const o2 = await load(); check('old start: replay', await o2.replay(r), o.headHex()); }
console.log(`${pass} passed, ${fail} failed; bound record ${c.frames.length} lines; identifier ${first.slice(0, 16)}…; core ${digest.slice(0, 16)}…`);
process.exit(fail ? 1 : 0);
