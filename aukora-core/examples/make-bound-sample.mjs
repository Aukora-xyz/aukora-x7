// Makes examples/bound-sample.json once, with throw-away keys (only PUBLIC keys, signatures and frames end up in it).
// Usage (from the tree root): node examples/make-bound-sample.mjs v0.10/aukora-core-lite.wasm > examples/bound-sample.json
import { sign, createPrivateKey, createPublicKey } from 'node:crypto';
import { Core, newOwner, intentBytes } from '../standalone-next/aukora.mjs';
const load = () => Core.load(process.argv[2], { allowUnpinned: true });
const owner = newOwner(), next = newOwner(), c = await load(); c.initBound(owner);
const pay = { payload: 'send the weekly report to the team', audience: 'mail', generation: 0, nonce: 1 };
c.say('a bound sample record: every line below was admitted by the core');
c.grantUntil(owner, pay, c.seq + 5); c.act(pay); c.outcome(pay, 'confirmed'); c.say('the end');
const record = c.exportRecord(), head = c.headHex();
// probes: frames offered AFTER the record. Built by hand, because the adapter refuses to sign the two old forms here.
const pub = k => createPublicKey(createPrivateKey(k)).export({ type: 'spki', format: 'der' });
const ed = createPrivateKey(owner.ed), ml = createPrivateKey(owner.ml), edPub = pub(owner.ed).subarray(-32), mlPub = pub(owner.ml).subarray(-1952);
const nEd = pub(next.ed).subarray(-32), nMl = pub(next.ml).subarray(-1952);
const blob = b => Buffer.concat([Buffer.from([b.length & 255, b.length >> 8]), b]), u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const both = m => ({ ed: sign(null, m, ed), ml: sign(null, m, ml) }), keys = Buffer.concat([blob(edPub), blob(mlPub)]);
const H = Buffer.concat([c.head(), u64(c.seq + 1)]);
const loose = { payload: 'an approval that names no record', audience: 'bank', generation: 0, nonce: 9 }, i = intentBytes(loose);
const g = both(Buffer.concat([blob(Buffer.from('AUKORA/R7/hybrid/grant')), keys, i]));
const approval = h => Buffer.concat([Buffer.from([0x13]), g.ml, h, Buffer.from([0x03]), i, g.ed]);
const r = both(Buffer.concat([blob(Buffer.from('AUKORA/R7/hybrid/rebind')), keys, u64(0), blob(nEd), blob(nMl)]));
const keyChange = Buffer.concat([Buffer.from([0x14]), nMl, r.ml, H, Buffer.from([0x08]), nEd, r.ed]);
// the same approval signature as it would sit in a TWIN record (another head), then moved here: the bytes that travel
const twin = await load(); twin.initBound(owner); const fromTwin = approval(Buffer.concat([twin.head(), u64(1)]));
const moved = Buffer.concat([fromTwin.subarray(0, 1 + g.ml.length), H, fromTwin.subarray(1 + g.ml.length + 40)]);
const timed = { payload: 'a timed approval, which signs the head', audience: 'mail', generation: 0, nonce: 2 }, ti = intentBytes(timed);
const t = both(Buffer.concat([blob(Buffer.from('AUKORA/R9/grant')), keys, u64(0), H, u64(c.seq + 5), ti]));
const timedFrame = Buffer.concat([Buffer.from([0x18]), H, u64(c.seq + 5), ti, t.ed, t.ml]);
const probes = [['old approval (first byte 13 hex), signed by the owner', approval(H)], ['old key change (first byte 14 hex), signed by the owner', keyChange],
  ['old approval carried over from a twin record', moved], ['old approval as it sits in the twin (wrong head)', fromTwin], ['timed approval (first byte 18 hex), signed by the owner', timedFrame]];
const out = { note: 'SAMPLE, THROW-AWAY KEYS. Public keys, signatures and frames only; the private halves were never stored.', format: 'aukora-record v0.2 bound',
  recordId: c.recordId(), record, expectedHead: head, probes: [] };
for (const [name, f] of probes) { const before = c.headHex(), ok = c.submit(f); out.probes.push({ name, frame: f.toString('hex'), expect: ok ? 'admitted' : 'refused', headAfter: c.headHex(), headMoved: c.headHex() !== before }); }
out.finalHead = c.headHex(); process.stdout.write(JSON.stringify(out, null, 1) + '\n'); console.error('head', head, 'final', out.finalHead, out.probes.map(p => p.expect).join(' '));
