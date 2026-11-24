// REVERTIBLE EFFECTS for the sink (rehearsal, lab only). Every write to the keyed store carries its own undo, taken
// BEFORE the write: the previous value of that key, or the fact that the key was absent. Undo runs newest first only.
// This is the keyed-store case of revertible effects, whose laws are kernel-checked in
// `skunkworks/proved/cordis-lean/Cordis.lean`: `setE_witnessed` (a write's undo restores the store it was taken from),
// `plugin_unloads` (after ANY sequence of writes, undoing all of them, newest first, gives back the starting store) and
// `distinct_keys_commute` (writes at different keys commute). This file is plain JavaScript written to the same
// definitions; `revertible-test.mjs` checks it against those three statements on random sequences. It is not proved.
//
// With the core: `RevertibleSink` applies a write only when the core admits an act for the exact bytes, exactly as the
// promotion sink does, and an UNDO IS AN EFFECT TOO: it needs its own approval, for the exact undo it will perform.
import { createHash } from 'node:crypto';
const sha = b => createHash('sha256').update(b).digest();
const ABSENT = null;

export class Revertible {
  constructor(initial = new Map()) { this.store = new Map(initial); this.journal = []; }
  get(k) { return this.store.has(k) ? this.store.get(k) : ABSENT; }
  /** set k to v (v = null removes k). Returns the undo entry that was journaled. */
  set(k, v) {
    const undo = { k, prev: this.get(k) };
    if (v === ABSENT) this.store.delete(k); else this.store.set(k, v);
    this.journal.push(undo); return undo;
  }
  /** Undo the newest write only. */
  undo() {
    const u = this.journal.pop(); if (!u) return false;
    if (u.prev === ABSENT) this.store.delete(u.k); else this.store.set(u.k, u.prev);
    return true;
  }
  /** Undo everything, newest first (the paper's `recover`). */
  recover() { while (this.undo()); return this.snapshot(); }
  snapshot() { return new Map([...this.store.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))); }
  /** A digest of the store, for a receipt: SHA-256 over the sorted (key, value) pairs. */
  digest() { const parts = []; for (const [k, v] of this.snapshot()) parts.push(Buffer.from(k), Buffer.of(0), Buffer.from(v), Buffer.of(0)); return sha(Buffer.concat(parts)).toString('hex'); }
}

export const writeIntent = (k, v, base, nonce) => ({ payload: Buffer.concat([Buffer.from('write\0' + k + '\0'), sha(Buffer.from(v ?? '')), Buffer.from(base, 'hex')]), audience: 'revertible/write/v1', generation: 0, nonce });
export const undoIntent = (u, base, nonce) => ({ payload: Buffer.concat([Buffer.from('undo\0' + u.k + '\0'), sha(Buffer.from(u.prev ?? '')), Buffer.from(base, 'hex')]), audience: 'revertible/undo/v1', generation: 0, nonce });

/** The store behind a core: nothing is written and nothing is undone unless the core admits an act for exactly that. */
export class RevertibleSink {
  constructor(core) { this.core = core; this.tree = new Revertible(); }
  write(k, v, nonce) {
    if (!this.core.act(writeIntent(k, v, this.tree.digest(), nonce))) return { applied: false, reason: 'NO_CURRENT_EXACT_PERMIT' };
    this.tree.set(k, v); return { applied: true, digest: this.tree.digest() };
  }
  undo(nonce) {
    const u = this.tree.journal.at(-1); if (!u) return { applied: false, reason: 'NOTHING_TO_UNDO' };
    if (!this.core.act(undoIntent(u, this.tree.digest(), nonce))) return { applied: false, reason: 'NO_CURRENT_EXACT_PERMIT' };
    this.tree.undo(); return { applied: true, digest: this.tree.digest() };
  }
}
