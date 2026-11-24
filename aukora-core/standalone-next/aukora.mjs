// AUKORA Core adapter for the NEXT line (cores with the bound start: 42 laws and later). Lab only; not part of any release tree.
// The released adapter is ../standalone/aukora.mjs and is not changed by this file. Plain Node 24+, no dependencies.
// The Wasm file decides everything. This file builds frames, signs with the owner's two keys, stores the accepted frames and
// replays them. It holds ONE rule of its own, and says so where it applies it: in a bound record it will not SIGN the two old
// forms that name no record (the one-time approval 0x13 and the old key change 0x14). The core would still admit such a frame
// (readiness blocker 12); this adapter never makes one.
import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, randomBytes, sign as nodeSign, createPrivateKey, createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PINS = {
  'aukora-core-lite.wasm': '3311f461aa3ff63ae0d47e97e3840b3fe918d70b4c1d1ad59b88614acba9c841',
  'aukora-core.wasm': '50f291fb7a38e0ea7f310cd8647eb48f6a74665774ae6b12be33a81bd2f9b6d4',
  // the 37-law machine (lab v0.4; the same bytes ship in the forked release folder)
  'aukora-core-lite.wasm@37': '8e7cca361db0ef321450e5f5fc70c807957c9e1095314fd533bdd4806abaa311',
  'aukora-core.wasm@37': '138170cca2e079d3b8cc72fa89fc42f396c7b3cad00371c3928a7809ba52817d',
};
const sha = b => createHash('sha256').update(b).digest();
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const blob = b => Buffer.concat([u16(b.length), b]);
const text = s => blob(Buffer.from(s, 'utf8'));
const cat = (...p) => Buffer.concat(p.map(x => (typeof x === 'number' ? Buffer.from([x]) : x)));
const decimal = n => cat(Buffer.from(String(n)), 0);
const RECORD_TAG = Buffer.from('AUKORA/R12C/record');
const UNBOUND = 'this form names no record, so a twin record with the same keys would admit the same bytes; in a bound record this adapter does not sign it';
const MISSING = 'AUKORA/R8/missing:request-intent-only;evidence=missing;reasoning=missing;witness=missing;versions=missing';

/** Owner keys: an Ed25519 pair and an ML-DSA-65 pair. Both must sign every approval. */
export function newOwner() {
  const ed = generateKeyPairSync('ed25519'), ml = generateKeyPairSync('ml-dsa-65');
  return { ed: ed.privateKey.export({ type: 'pkcs8', format: 'pem' }), ml: ml.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
function ownerKeys(owner) {
  const ed = createPrivateKey(owner.ed), ml = createPrivateKey(owner.ml);
  const edPub = createPublicKey(ed).export({ type: 'spki', format: 'der' }).subarray(-32);
  const mlPub = createPublicKey(ml).export({ type: 'spki', format: 'der' }).subarray(-1952);
  return { ed, ml, edPub, mlPub, packed: cat(edPub, mlPub), keys: cat(blob(edPub), blob(mlPub)) };
}
/** What a delivery intent is: a payload, who it is for, the owner generation, and a number used once. */
export function intentBytes({ payload, audience = '', generation = 0, nonce }) {
  return cat(0x00, blob(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')), text(audience), u16(generation), u16(nonce));
}

export class Core {
  /** @param file path of a pinned core file; refuses to load anything else unless `allowUnpinned` is set. */
  static async load(file = fileURLToPath(new URL('../standalone/aukora-core-lite.wasm', import.meta.url)), { allowUnpinned = false } = {}) {
    const bytes = readFileSync(file), digest = sha(bytes).toString('hex');
    if (!allowUnpinned && !Object.values(PINS).includes(digest)) throw new Error(`core file is not a pinned release: sha256 ${digest}`);
    const c = new Core(); c.module = await WebAssembly.compile(bytes); c.coreDigest = digest; await c.#fresh(); return c;
  }
  async #fresh() { this.api = (await WebAssembly.instantiate(this.module, {})).exports; this.frames = []; this.genesis = null; this.bound = null; this.seq = 0; }
  #consume(name, bytes) { for (let i = 0; i < bytes.length; i++) this.api.input(bytes[i]); return this.api[name](); }
  head() { return Buffer.from(Array.from({ length: 32 }, (_, i) => this.api.head(i))); }
  headHex() { return this.head().toString('hex'); }
  #H() { return cat(this.head(), u64(this.seq + 1)); }
  /** Submit one frame. Returns true if the core admitted it. A refusal changes nothing. */
  submit(frame) { const ok = this.#consume('step', frame) === 1; if (ok) { this.frames.push(Buffer.from(frame)); this.seq++; } return ok; }

  /** Start a new record owned by these two public keys. */
  init(owner) {
    const k = ownerKeys(owner); if (this.#consume('init', k.packed) !== 1) throw new Error('genesis refused');
    this.genesis = k.packed; return this.headHex();
  }
  /** Start a record BOUND to its own identifier. The identifier is the digest of: a fixed label, the core's law identity, the
      owner's public keys and a 32-byte value chosen here. The first head IS the identifier, so every command that signs the head
      is signed for this record and no other. Keep the value with the record: it is needed to replay. */
  initBound(owner, hostValue = randomBytes(32)) {
    if (typeof this.api.initBound !== 'function') throw new Error('this core file has no bound start');
    if (!Buffer.isBuffer(hostValue) || hostValue.length !== 32) throw new Error('the host value must be 32 bytes');
    const k = ownerKeys(owner); if (this.#consume('initBound', cat(k.packed, hostValue)) !== 1) throw new Error('bound genesis refused');
    this.#bind(k.packed, hostValue); return this.headHex();
  }
  #bind(packed, hostValue) {
    const law = Buffer.from(Array.from({ length: 32 }, (_, i) => this.api.lawByte(i))), id = sha(cat(RECORD_TAG, law, packed, hostValue));
    const told = Buffer.from(Array.from({ length: 32 }, (_, i) => this.api.recordIdByte(i)));
    if (!id.equals(this.head()) || !id.equals(told)) throw new Error('the core did not start at the identifier this descriptor gives');
    this.genesis = packed; this.bound = { hostValue: Buffer.from(hostValue), law, id };
  }
  /** The record identifier (hex), or null for a record started the old way. */
  recordId() { return this.bound ? this.bound.id.toString('hex') : null; }
  halted() { return typeof this.api.halted === 'function' ? this.api.halted() === 1 : null; }
  // ---- unsigned events: anyone may record these; none of them carries authority ----
  say(words) { return this.submit(cat(0x00, this.#H(), 0x00, text(words))); }
  advise(cell, value) { return this.submit(cat(0x00, this.#H(), 0x06, text(cell), u16(value))); }
  outcome(intent, result /* 'confirmed' | 'failed' | 'unknown' */) { return this.submit(cat(0x00, this.#H(), 0x05, intentBytes(intent), ['confirmed', 'failed', 'unknown'].indexOf(result))); }
  correctOutcome(intent, result) { return this.submit(cat(0x1a, this.#H(), 0x05, intentBytes(intent), ['confirmed', 'failed', 'unknown'].indexOf(result))); }
  assess(intent, score, bundleDigest) { return this.submit(cat(0x15, this.#H(), sha(intentBytes(intent)), score, bundleDigest)); }
  /** Ask the core to admit an act. With no assessment recorded, the core treats it as danger 255 and needs a grant. */
  act(intent, bundleDigest) {
    const i = intentBytes(intent), bundle = bundleDigest ?? sha(cat(text(MISSING), sha(i)));
    return this.submit(cat(0x17, bundle, this.#H(), 0x04, i));
  }
  // ---- owner-signed events: both signatures, made here with the owner's keys ----
  #both(k, message) { return { ed: nodeSign(null, message, k.ed), ml: nodeSign(null, message, k.ml) }; }
  /** One-time approval of exactly this intent. */
  grant(owner, intent) {
    if (this.bound) throw new Error('grant: ' + UNBOUND + '. Use grantUntil.');
    const k = ownerKeys(owner), i = intentBytes(intent);
    const s = this.#both(k, cat(text('AUKORA/R7/hybrid/grant'), k.keys, i));
    return this.submit(cat(0x13, s.ml, this.#H(), 0x03, i, s.ed));
  }
  /** Approval that stops working after record line `expiry` (inclusive). */
  grantUntil(owner, intent, expiry, generation = 0) {
    const k = ownerKeys(owner), i = intentBytes(intent), H = this.#H();
    const s = this.#both(k, cat(text('AUKORA/R9/grant'), k.keys, u64(generation), H, u64(expiry), i));
    return this.submit(cat(0x18, H, u64(expiry), i, s.ed, s.ml));
  }
  /** Cancel one approval that has not been used. */
  revoke(owner, intent, generation = 0) {
    const k = ownerKeys(owner), d = sha(intentBytes(intent)), H = this.#H();
    const s = this.#both(k, cat(text('AUKORA/R9/revoke'), k.keys, u64(generation), H, d));
    return this.submit(cat(0x19, H, d, s.ed, s.ml));
  }
  /** Acts scored at or below the threshold may run without a per-act approval. It starts at 0. */
  setThreshold(owner, threshold, generation = 0) {
    const k = ownerKeys(owner), H = this.#H();
    const s = this.#both(k, cat(text('AUKORA/R8/threshold'), k.keys, u64(generation), H, threshold));
    return this.submit(cat(0x16, H, threshold, s.ed, s.ml));
  }
  /** Hand the record to a new pair of keys. Signed by both CURRENT keys. Clears every unused approval. */
  rebind(owner, nextOwner, generation = 0) {
    if (this.bound) throw new Error('rebind: ' + UNBOUND + '. Use changeKeys.');
    const k = ownerKeys(owner), n = ownerKeys(nextOwner);
    const s = this.#both(k, cat(text('AUKORA/R7/hybrid/rebind'), k.keys, u64(generation), n.keys));
    return this.submit(cat(0x14, n.mlPub, s.ml, this.#H(), 0x08, n.edPub, s.ed));
  }
  // ---- the newer owner commands: each signs the head and the line number, so in a bound record each is signed for this record ----
  #safe(owner, op, generation, extra = Buffer.alloc(0)) {
    const k = ownerKeys(owner), wire = cat(0xff, 0x02, op, this.head(), decimal(this.seq + 1), extra);
    const s = this.#both(k, cat(text('AUKORA/R11/safe'), k.keys, decimal(generation), wire));
    return this.submit(cat(wire, s.ed, s.ml));
  }
  /** Stop: after this, acts and approvals are refused until the owner clears it. */
  halt(owner, generation = 0) { return this.#safe(owner, 50, generation); }
  /** Clear a stop. */
  clear(owner, generation = 0) { return this.#safe(owner, 51, generation); }
  /** Hand the record to a new pair of keys (the newer form: it signs the head). Signed by both CURRENT keys. */
  changeKeys(owner, nextOwner, generation = 0) { const n = ownerKeys(nextOwner); return this.#safe(owner, 53, generation, n.packed); }
  threshold() { return this.api.threshold(); }
  /** What the record says happened to this intent: confirmed, failed, unknown, and whether it was corrected. */
  outcomeOf(intent) { const r = this.#consume('outcome', sha(intentBytes(intent))); return r === 256 ? null : { result: ['confirmed', 'failed', 'unknown'][r % 4], corrected: r >= 4 }; }

  /** The record as text. Old start: the owner's public keys, then every accepted frame, one hex line each.
      Bound start: the keys, then the 32-byte host value, then the frames. */
  exportRecord() {
    const top = this.bound ? ['aukora-record v0.2 bound', this.genesis.toString('hex'), this.bound.hostValue.toString('hex')] : ['aukora-record v0.1', this.genesis.toString('hex')];
    return [...top, ...this.frames.map(f => f.toString('hex'))].join('\n') + '\n';
  }
  /** Replay a record in a fresh instance of this same core. Returns the head, or throws at the first refused line.
      Pass `expectId` (hex) to require that a bound record is the record you think it is. */
  async replay(recordText, { expectId } = {}) {
    const lines = recordText.trim().split('\n'), bound = lines[0] === 'aukora-record v0.2 bound';
    if (!bound && lines[0] !== 'aukora-record v0.1') throw new Error('not an aukora record');
    await this.#fresh(); const keys = Buffer.from(lines[1], 'hex');
    if (bound) {
      const value = Buffer.from(lines[2], 'hex'); if (value.length !== 32) throw new Error('the host value line is not 32 bytes');
      if (typeof this.api.initBound !== 'function') throw new Error('this core file has no bound start');
      if (this.#consume('initBound', cat(keys, value)) !== 1) throw new Error('bound genesis refused'); this.#bind(keys, value);
      if (expectId && expectId !== this.recordId()) throw new Error('this is a different record: its identifier is ' + this.recordId());
    } else { if (expectId) throw new Error('this record was started the old way and has no identifier'); if (this.#consume('init', keys) !== 1) throw new Error('genesis refused'); this.genesis = keys; }
    lines.slice(bound ? 3 : 2).forEach((l, n) => { if (!this.submit(Buffer.from(l, 'hex'))) throw new Error(`line ${n + 1} of the record is refused by the core: the record was changed, reordered or cut in the middle`); });
    return this.headHex();
  }
}
