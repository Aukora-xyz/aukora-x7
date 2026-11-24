// Tests revertible.mjs against the three kernel-checked statements it is written to (Cordis.lean), on random sequences,
// then the sink with a real core: a write and an undo each need their own exact approval.
// Usage: BAILIFF_CORE=v0.10/aukora-core-lite.wasm node bailiff-rehearsal/revertible-test.mjs [--control]
// CONTROL: --control uses a broken store that forgets "the key was absent" in its undo; the laws must catch it.
import { Revertible, RevertibleSink, writeIntent, undoIntent } from './revertible.mjs';
let pass = 0, fail = 0; const check = (name, ok, d = '') => { if (ok) pass++; else { fail++; console.log('FAIL', name, d); } };
let seed = 20261124; const rnd = n => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed % n; };
const same = (a, b) => JSON.stringify([...a]) === JSON.stringify([...b]);
class Broken extends Revertible { undo() { const u = this.journal.pop(); if (!u) return false; if (u.prev !== null) this.store.set(u.k, u.prev); return true; } }
const Make = process.argv.includes('--control') ? Broken : Revertible;
const keys = ['a', 'b', 'c', 'd', 'e'], val = () => rnd(5) === 0 ? null : 'v' + rnd(40);
let unloadOk = 0, witnessOk = 0, commuteOk = 0; const N = 2000;
for (let t = 0; t < N; t++) {
  const start = new Map(keys.filter(() => rnd(2)).map(k => [k, 'start-' + k]));
  // plugin_unloads: any writes, then recover, gives the start
  const r = new Make(start), before = r.snapshot();
  for (let i = rnd(30); i > 0; i--) r.set(keys[rnd(5)], val());
  if (same(r.recover(), before)) unloadOk++;
  // setE_witnessed: one write then its undo restores the store it was taken from
  const w = new Make(start); w.set(keys[rnd(5)], val()); const mid = w.snapshot(); w.set(keys[rnd(5)], val()); w.undo(); if (same(w.snapshot(), mid)) witnessOk++;
  // distinct_keys_commute: two writes at different keys, both orders, the same store
  const k1 = keys[rnd(5)]; let k2 = keys[rnd(5)]; if (k2 === k1) k2 = keys[(keys.indexOf(k1) + 1) % 5];
  const v1 = val(), v2 = val(), x = new Make(start), y = new Make(start); x.set(k1, v1); x.set(k2, v2); y.set(k2, v2); y.set(k1, v1); if (same(x.snapshot(), y.snapshot())) commuteOk++;
}
check(`unload: ${N} random write sequences, undone newest first, give back their start`, unloadOk === N, `${unloadOk}/${N}`);
check(`witnessed: ${N} writes, each undone, restore the store they were taken from`, witnessOk === N, `${witnessOk}/${N}`);
check(`commute: ${N} pairs of writes at different keys agree in both orders`, commuteOk === N, `${commuteOk}/${N}`);
check('undo with nothing written does nothing', new Make().undo() === false);

// with a core: each write and each undo needs its own exact approval
if (process.env.BAILIFF_CORE) {
  const { Core, newOwner } = await import('../standalone-next/aukora.mjs');
  const owner = newOwner(), c = await Core.load(process.env.BAILIFF_CORE, { allowUnpinned: true }); c.initBound(owner);
  const s = new RevertibleSink(c), start = s.tree.digest();
  check('a write without approval is refused', !s.write('config', 'on', 1).applied);
  c.grantUntil(owner, writeIntent('config', 'on', s.tree.digest(), 1), c.seq + 5);
  const w = s.write('config', 'on', 1); check('the approved write is applied', w.applied);
  check('the same approval does not apply a second write', !s.write('config', 'on', 1).applied);
  check('an undo without its own approval is refused', !s.undo(2).applied);
  c.grantUntil(owner, writeIntent('config', 'off', s.tree.digest(), 3), c.seq + 5);
  check('an approval for a write does not approve an undo', !s.undo(3).applied);
  const u = s.tree.journal.at(-1); c.grantUntil(owner, undoIntent(u, s.tree.digest(), 4), c.seq + 5);
  const back = s.undo(4); check('the approved undo is applied', back.applied);
  check('after the undo the store is the starting store', s.tree.digest() === start);
  check('the record replays (every write and undo is in it)', await (await Core.load(process.env.BAILIFF_CORE, { allowUnpinned: true })).replay(c.exportRecord()) === c.headHex());
}
console.log(`${pass} passed, ${fail} failed (revertible effects${process.env.BAILIFF_CORE ? ', with core' : ''})`); process.exit(fail ? 1 : 0);
