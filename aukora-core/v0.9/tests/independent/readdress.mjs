// An independent check. The question the builder's test does not ask: is the SIGNATURE tied to the record?
// Presenting record A's frame to record B unchanged proves little: every frame names its parent head, so the same bytes are
// refused by any record at a different head, a plain approval included. The real move is to RE-ADDRESS the frame: keep the
// signatures, replace A's (head, sequence) by B's. That is how the plain approval travels today.
// Usage: node readdress.mjs <core.wasm>     (frame builders from the release's own test library; independent logic)
import { randomBytes } from 'node:crypto'; import { readFileSync } from 'node:fs';
const T = new URL('../', import.meta.url).pathname;
const { blob, cat, deliver, dual, host, keyFields, owner, sha, text, timedGrant, u16, u64 } = await import(T + 'host.mjs');
const { safeControl } = await import(T + 'safe-fields.mjs'); const { bytes32, rawKeys, signedSeal } = await import(T + 'segments.mjs');
const file = readFileSync(process.argv[2]); const quiet = f => { const l = console.log; console.log = () => {}; try { return f(); } finally { console.log = l; } };
let pass = 0, fail = 0; const check = (name, got, want) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${got}, wanted ${want}`}`); };
const start = (keys, value) => { const h = host(file); if (value) { if (h.consume(cat(rawKeys(keys), value), 'initBound') !== 1) throw new Error('bound genesis refused'); h.acceptGenesis(cat(Buffer.from('AUKORA/R12C/record'), bytes32(h.api.lawByte), rawKeys(keys), value)); } else if (h.consume(rawKeys(keys), 'init') !== 1) throw new Error('genesis refused'); return h; };
const head = h => bytes32(h.api.head);
// Replace every occurrence of A's 40-byte header (head, next sequence) by B's. Returns null if the frame does not contain it.
// The newer owner frames write the sequence as decimal text, so for those only the 32-byte head is replaced (both records are at the same line count here).
const swap = (wire, a, b) => { let out = Buffer.from(wire), n = 0, i = 0; while ((i = out.indexOf(a, i)) >= 0) { b.copy(out, i); i += a.length; n++; } return n ? out : null; };
const readdress = (wire, from, to) => swap(wire, from.header(), to.header()) ?? swap(wire, from.header().subarray(0, 32), to.header().subarray(0, 32));
const intent = deliver(Buffer.from('pay the supplier'), 0, 7);
const kinds = (keys, keys2) => [
  ['timed approval (18)', h => timedGrant(keys, h.header(), intent, 0, 400)],
  ['cancel (19)', h => { const s = dual(keys, cat(text('AUKORA/R9/revoke'), keyFields(keys), u64(0), h.header(), sha(intent))); return cat(Buffer.of(25), h.header(), sha(intent), s.edSig, s.mlSig); }],
  ['threshold (16)', h => { const s = dual(keys, cat(text('AUKORA/R8/threshold'), keyFields(keys), u64(0), h.header(), Buffer.of(64))); return cat(Buffer.of(22), h.header(), Buffer.of(64), s.edSig, s.mlSig); }],
  ['signed control', h => h.control(keys, cat(Buffer.of(10), text('service'), blob(Buffer.from('report')), u16(0), u16(2), u16(65535)), 0)],
  ['halt (ff 02)', h => safeControl(h, 50, keys, 0)],
  ['clear (ff 02)', h => safeControl(h, 51, keys, 0)],
  ['key change (ff 02)', h => safeControl(h, 53, keys, 0, { newKeys: keys2 })],
];
// 1. OLD MODE, before the fix: two records with the same keys both start at head zero. A head-signed frame travels unchanged.
{ const keys = owner(), X = start(keys), Y = start(keys); let travelled = 0;
  { const w = kinds(keys)[0][1](X); if (Y.consume(w, 'step') === 1) travelled++; }
  check('OLD MODE: a timed approval signed for record X is admitted, byte for byte, by a twin record Y with the same keys (the defect)', travelled, 1); }
// 2. BOUND MODE, different host values: unchanged AND re-addressed, both must be refused; the other record is not moved.
{ const keys = owner(), keys2 = owner(), va = randomBytes(32), vb = Buffer.from(va); vb[31] ^= 1; const A = start(keys, va), B = start(keys, vb);
  for (const [name, make] of kinds(keys, keys2)) { const wa = make(A), before = head(B);
    check(`BOUND: ${name} for A, presented to B unchanged -> refused`, B.consume(wa, 'step'), 0);
    const re = readdress(wa, A, B); check(`BOUND: ${name} for A, RE-ADDRESSED to B with A's signatures -> refused`, re ? B.consume(re, 'step') : 'frame holds no header', 0);
    check(`   B's head unchanged`, head(B).equals(before), true);
    quiet(() => A.submit(name, wa, true)); quiet(() => B.submit(name, make(B), true)); }
  // the seal trailer: re-address = rebuild the body for B but keep A's signatures
  const tA = signedSeal(A, keys2), bodyB = signedSeal(B, keys2).subarray(0, -3373), forged = cat(bodyB, tA.subarray(-3373));
  check('BOUND: seal trailer of A at B unchanged -> refused', B.consume(tA, 'seal'), 0); check("BOUND: B's seal body with A's signatures -> refused", B.consume(forged, 'seal'), 0); }
// 3. the stated limit: forms that sign no head DO travel when re-addressed (a fresh pair of bound records)
{ const keys = owner(), keys2 = owner(), va = randomBytes(32), vb = Buffer.from(va); vb[0] ^= 128; const A = start(keys, va), B = start(keys, vb);
  const second = deliver(Buffer.from('second payment'), 0, 9), ap = A.grant(keys, second); quiet(() => A.submit('plain approval', ap, true));
  check('LIMIT: plain approval (13) for A, presented to B unchanged -> refused (only because of the parent it names)', B.consume(ap, 'step'), 0);
  check('LIMIT: plain approval (13) for A, RE-ADDRESSED to B -> ADMITTED (forced by the frozen law)', B.consume(swap(ap, cat(ap.subarray(1 + 3309, 1 + 3309 + 40)), B.header()) ?? Buffer.alloc(0), 'step'), 1);
  const leg = A.rebind(keys, keys2, 0);
  check('LIMIT: old key change (14) for A, RE-ADDRESSED to B -> ADMITTED (forced by the frozen law)', B.consume(swap(leg, leg.subarray(1 + 1952 + 3309, 1 + 1952 + 3309 + 40), cat(head(B), u64(2))) ?? Buffer.alloc(0), 'step'), 1); }   // B now holds one line, so its next sequence is 2
// 4. BOUND MODE, the SAME host value: the host has started the same record twice. The identifier is the same, so everything travels.
{ const keys = owner(), v = randomBytes(32), A = start(keys, v), B = start(keys, v); const w = timedGrant(keys, A.header(), intent, 0, 400);
  check('SAME DESCRIPTOR TWICE: identifiers equal', bytes32(A.api.recordIdByte).equals(bytes32(B.api.recordIdByte)), true);
  check('SAME DESCRIPTOR TWICE: a timed approval travels unchanged (this is a fork of ONE record, which only an outside witness shows)', B.consume(w, 'step'), 1); }
// 5. an old-mode record has no identifier and refuses bound-record frames; the identifier survives a key change
{ const keys = owner(), keys2 = owner(), v = randomBytes(32), A = start(keys, v), C = start(keys); const id = bytes32(A.api.recordIdByte);
  check('old-mode record reports no identifier', C.api.recordIdByte(0), 256);
  quiet(() => A.submit('key change', safeControl(A, 53, keys, 0, { newKeys: keys2 }), true)); check('identifier unchanged after a key change', bytes32(A.api.recordIdByte).equals(id), true);
  check('identifier differs from the current head after frames (it names the record, not a position)', head(A).equals(id), false); }
// 6. An outside reviewer's finding (F3): the re-addressing above keeps the SEQUENCE for the newer kinds, because both records sat at
//    the same line count. Stronger move: put B one line ahead, take B's OWN well-formed frame (B's head, B's sequence, in whatever
//    encoding the kind uses) and replace only its signature fields by A's. Refusal can then come from nothing but the signature.
//    And the differential: the same frame with B's own signatures is admitted.
{ const keys = owner(), keys2 = owner(), va = randomBytes(32), vb = Buffer.from(va); vb[7] ^= 4; const A = start(keys, va), B = start(keys, vb);
  quiet(() => B.submit('one line ahead', B.unsigned(cat(Buffer.of(0), text('B is one line ahead'))), true));
  const tail = 64 + 3309;                                             // Ed25519 then ML-DSA-65 at the end, for the kinds built that way
  for (const [name, make] of kinds(keys, keys2)) { const wa = make(A), wb = make(B), before = head(B); let forged;
    if (name === 'signed control') forged = cat(wb.subarray(0, 1), wa.subarray(1, 1 + 3309), wb.subarray(1 + 3309, wb.length - 64), wa.subarray(wa.length - 64));   // ML-DSA field in front, Ed25519 at the end
    else forged = cat(wb.subarray(0, wb.length - tail), wa.subarray(wa.length - tail));
    check(`AHEAD: ${name}: B's own frame at its own head and sequence, carrying A's signatures -> refused`, B.consume(forged, 'step'), 0);
    check(`   B's head unchanged`, head(B).equals(before), true);
    check(`   differential: the same frame with B's own signatures -> admitted`, (() => { try { quiet(() => B.submit(name, wb, true)); return 1; } catch { return 0; } })(), 1);
    quiet(() => A.submit(name, wa, true)); }
}
console.log(`${pass} passed, ${fail} failed on ${process.argv[2].split('/').pop()}`); process.exit(fail ? 1 : 0);
