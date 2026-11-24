// Control for Q1: is my re-wrapping a VALID frame? Take a fresh approval from record A (same owner keys),
// and present its signature, re-wrapped, to record B that has never seen it. If B admits it, the wrapper is right,
// and the refusals in Q1 are the core remembering the approval, not a malformed frame.
import { Core, newOwner } from '../../standalone/aukora.mjs';
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const file = process.argv[2]; const owner = newOwner(); const pay = { payload: 'pay the supplier 100', audience: 'bank', generation: 0, nonce: 7 };
const a = await Core.load(file, { allowUnpinned: true }); a.init(owner); a.grant(owner, pay); const g = a.frames[0];
const b = await Core.load(file, { allowUnpinned: true }); b.init(owner); b.say('a different history');
const wrapped = Buffer.concat([Buffer.from([0x13]), g.subarray(1, 3310), b.head(), u64(b.seq + 1), g.subarray(3350)]);
const ok = b.submit(wrapped);
console.log('control: approval signature from record A, re-wrapped, presented to record B (same owner keys):', ok ? 'ADMITTED' : 'refused', '| act in B:', b.act(pay));
console.log(ok ? 'So: an approval is NOT bound to one record or one position. The same owner keys on two records means one signature approves the act on both.' : 'wrapper is wrong; Q1 inconclusive');
