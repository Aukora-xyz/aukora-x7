// Mythos: does a REFUSED recovery frame use up the recovery reserve? (NOT-PROVED item 13, asked by the outside reviewer)
// Own adapter and frames; the Wasm file must match its pin before it is loaded (another seat may be rebuilding).
import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
import { Core, newOwner } from '../../standalone/aukora.mjs';
const file = process.argv[2], want = process.argv[3];
const got = createHash('sha256').update(readFileSync(file)).digest('hex');
if (got !== want) { console.log('file does not match its pin right now (', got.slice(0, 12), '): not tested'); process.exit(3); }
const c = await Core.load(file, { allowUnpinned: true }); let owner = newOwner(); const stranger = newOwner(); c.init(owner);
let n = 0; while (c.say('filler ' + n)) n++;
console.log('ordinary limit reached at', c.frames.length, 'lines');
let badAdmitted = 0; for (let i = 0; i < 40; i++) if (c.rebind(stranger, newOwner(), 0)) badAdmitted++;
console.log('40 key changes signed by a STRANGER at the limit: admitted', badAdmitted);
let good = 0, gen = 0; for (let i = 0; i < 20; i++) { const next = newOwner(); if (c.rebind(owner, next, gen)) { good++; gen++; owner = next; } else break; }
console.log('valid key changes admitted AFTER those 40 refusals:', good, '(the reserve is 16; refused frames used none of it if this is 16)');
const next = newOwner(); console.log('one more valid key change after the reserve is spent:', c.rebind(owner, next, gen) ? 'ADMITTED' : 'refused', '| speech:', c.say('x') ? 'ADMITTED' : 'refused');
const d = await Core.load(file, { allowUnpinned: true }); console.log('the whole record (', c.frames.length, 'lines ) replays to the same head:', (await d.replay(c.exportRecord())) === c.headHex());
