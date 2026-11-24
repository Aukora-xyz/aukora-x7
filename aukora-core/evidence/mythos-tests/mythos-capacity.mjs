// Mythos, second seat, round 12: what happens at the record limit? Own adapter, frames built from WIRE.md (v0.1 grammar).
import { Core, newOwner } from '../../standalone/aukora.mjs';
for (const file of [process.argv[2] || 'v0.3/aukora-core-lite.wasm']) {
  const c = await Core.load(file, { allowUnpinned: true }); const owner = newOwner(), next = newOwner(); c.init(owner);
  const pay = { payload: 'p', audience: 'a', generation: 0, nonce: 1 };
  console.log('with room: owner approval', c.grant(owner, pay), '| cancel', c.revoke(owner, pay), '| threshold control', c.setThreshold(owner, 1));
  let n = c.frames.length; while (c.say('filler line ' + n)) n++;
  console.log(file, 'record stopped accepting speech at', c.frames.length, 'accepted lines');
  const head = c.headHex();
  const r = { speech: c.say('x'), approval: c.grant(owner, { ...pay, nonce: 2 }), threshold: c.setThreshold(owner, 2), keyChange: c.rebind(owner, next) };
  console.log('AT THE LIMIT, valid owner frames:', JSON.stringify(r), '| head unchanged:', c.headHex() === head);
  const d = await Core.load(file, { allowUnpinned: true }); console.log('full record replays to the same head:', (await d.replay(c.exportRecord())) === c.headHex());
  // staging limit
  const e = await Core.load(file, { allowUnpinned: true }); e.init(owner); let fed = 0, last = 1; const chunk = Buffer.alloc(1 << 20, 7);
  while (last === 1 && fed < 40) { for (let i = 0; i < chunk.length; i++) e.api.input(chunk[i]); last = e.api.feed(); if (last === 1) fed++; }
  console.log('staging accepted', fed, 'MiB then returned', last, '| speech still works after:', (e.api.reset(), e.say('still here')));
}
