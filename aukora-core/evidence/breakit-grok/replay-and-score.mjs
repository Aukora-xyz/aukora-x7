// Mythos: two questions raised by the outside second implementation (documentation findings 7, 8, 9).
// Q1: a tag-13 approval signs domain("grant") + intent, with no head and no generation. After it is used, can
//     ANYONE re-submit the same signature under the new head and get a second use?
// Q2: an assessment (tag 15) is unsigned. Can anyone post score 0 and get an act admitted with NO approval?
import { Core, newOwner, intentBytes } from '../../standalone/aukora.mjs';
import { createHash } from 'node:crypto';
const sha = b => createHash('sha256').update(b).digest();
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
for (const file of process.argv.slice(2)) {
  console.log('==', file);
  { const c = await Core.load(file, { allowUnpinned: true }); const owner = newOwner(); c.init(owner);
    const pay = { payload: 'pay the supplier 100', audience: 'bank', generation: 0, nonce: 7 };
    console.log('Q1 approve', c.grant(owner, pay), '| act', c.act(pay), '| act again', c.act(pay));
    const old = c.frames.find(f => f[0] === 0x13);                     // the owner's approval frame, public in the record
    const mlSig = old.subarray(1, 3310), rest = old.subarray(3350);     // tag | MLSig | H | A (03 intent EdSig)
    const replayed = Buffer.concat([Buffer.from([0x13]), mlSig, c.head(), u64(c.seq + 1), rest]);
    const again = c.submit(replayed);
    console.log('Q1 SAME signature re-wrapped under the new head, submitted by anyone:', again ? 'ADMITTED' : 'refused', '| then act a second time:', c.act(pay) ? 'ADMITTED (the one-time approval was used twice)' : 'refused');
    const pay2 = { ...pay, nonce: 8 }; c.grant(owner, pay2); const g2 = c.frames[c.frames.length - 1];
    c.revoke(owner, pay2); const re2 = Buffer.concat([Buffer.from([0x13]), g2.subarray(1, 3310), c.head(), u64(c.seq + 1), g2.subarray(3350)]);
    console.log('Q1b approval CANCELLED by the owner, then the old signature re-wrapped:', c.submit(re2) ? 'ADMITTED' : 'refused', '| act:', c.act(pay2) ? 'ADMITTED (a cancelled approval came back)' : 'refused'); }
  { const c = await Core.load(file, { allowUnpinned: true }); const owner = newOwner(); c.init(owner);
    const pay = { payload: 'delete the archive', audience: 'files', generation: 0, nonce: 1 }; const bundle = sha(Buffer.from('whatever'));
    console.log('Q2 threshold', c.threshold(), '| unsigned assessment score 0:', c.assess(pay, 0, bundle), '| act with NO approval:', c.act(pay, bundle) ? 'ADMITTED' : 'refused');
    const pay3 = { ...pay, nonce: 2 }; console.log('Q2b owner sets threshold 50:', c.setThreshold(owner, 50), '| unsigned assessment score 10:', c.assess(pay3, 10, bundle), '| act with NO approval:', c.act(pay3, bundle) ? 'ADMITTED' : 'refused');
    const pay4 = { ...pay, nonce: 3 }; console.log('Q2c unsigned assessment score 51:', c.assess(pay4, 51, bundle), '| act with NO approval:', c.act(pay4, bundle) ? 'ADMITTED' : 'refused'); }
}
