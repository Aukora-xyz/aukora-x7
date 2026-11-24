// Makes examples/sample-record.txt once, with throw-away keys (only PUBLIC keys and signatures end up in the record).
// Usage (from the tree root): node examples/make-sample.mjs core/aukora-core-lite.wasm > examples/sample-record.txt
import { Core, newOwner } from '../standalone/aukora.mjs';
const c = await Core.load(process.argv[2]); const owner = newOwner(); c.init(owner);
const pay = { payload: 'send the weekly report to the team', audience: 'mail', generation: 0, nonce: 1 };
c.say('a sample record: every line below was admitted by the core');
c.act(pay);                                   // refused: no approval yet (a refusal leaves no line)
c.grantUntil(owner, pay, c.seq + 5);          // the owner approves exactly this, until line 7
c.act(pay);                                   // admitted once
c.act(pay);                                   // refused: an approval is used once
c.outcome(pay, 'confirmed');
c.say('the end');
process.stdout.write(c.exportRecord()); console.error('head', c.headHex(), 'lines', c.frames.length);
