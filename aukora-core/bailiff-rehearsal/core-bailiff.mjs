// CORE BAILIFF, the pure part (rehearsal). One function that judges ONE head promotion against a core record.
// It runs in a browser, a Worker or Node: no file access, no key, no signing, no network. It decides nothing itself:
// it replays the record in the pinned core and asks the core to admit one act frame built from the promotion's own ids.
//   judgePromotion(core, { recordText, ack, ballId, parentBallId, epoch, generation })
//     core          a WebAssembly.Module (Workers: the statically imported file) or the file's bytes (Node, browser)
//     recordText    the BOUND core record this sink serves ('aukora-record v0.2 bound', keys, host value, frames)
//     ack           { id, lines, head } as stored with the last effect, or null the first time
//     ballId        64 hex: the canonical id of the manifest the transaction will select
//     parentBallId  64 hex: the head it expects to replace (64 zeros when there is none)
//     epoch         the candidate's epoch: all 64 bits are inside the approved payload; its low 16 bits are also the approval's number
//   THE CALLER'S DUTIES (this module cannot do them): pin the core file (it runs whatever module it is given); pass as
//   parentBallId the head it READ in its own transaction, never a value named by the requester; and on ADMIT in enforce mode
//   store recordText and ack in the SAME transaction as the effect, only if the stored ack is still the one it passed in.
//   returns { verdict, recordText, ack } on ADMIT (store BOTH in the same transaction as the effect, before the effect),
//   or { verdict } with one of the refusal words below. Anything unexpected is UNAVAILABLE, never ADMIT.
export const AUDIENCE = 'x6.1/head-promotion/v1';
export const VERDICTS = ['ADMIT', 'NO_CURRENT_EXACT_PERMIT', 'RECORD_NOT_BOUND', 'RECORD_NOT_THIS_ONE', 'RECORD_SHORTER', 'RECORD_REWRITTEN', 'RECORD_DOES_NOT_REPLAY', 'UNAVAILABLE'];
const MISSING = 'AUKORA/R8/missing:request-intent-only;evidence=missing;reasoning=missing;witness=missing;versions=missing';
const enc = new TextEncoder(), HEX = /^[0-9a-f]{64}$/, LINE = /^(?:[0-9a-f]{2})+$/;
const cat = (...p) => { const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of p) { out.set(x, o); o += x.length; } return out; };
const u16 = n => Uint8Array.of(n & 255, (n >>> 8) & 255), u64 = n => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const blob = b => cat(u16(b.length), b), text = s => blob(enc.encode(s));
const unhex = h => Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16)), hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const sha = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
/** The intent an owner approves for one promotion, and that this sink asks the core about. */
export const promotionIntent = ({ ballId, parentBallId, epoch, generation = 0 }) =>
  cat(Uint8Array.of(0), blob(cat(unhex(ballId), unhex(parentBallId), u64(epoch))), text(AUDIENCE), u16(generation), u16(epoch & 0xffff));

export async function judgePromotion(core, { recordText, ack = null, ballId, parentBallId, epoch, generation = 0 }) {
  try {
    if (!HEX.test(ballId ?? '') || !HEX.test(parentBallId ?? '') || !Number.isSafeInteger(epoch) || epoch < 0) return { verdict: 'UNAVAILABLE' };
    const lines = String(recordText ?? '').trim().split('\n');
    if (lines[0] !== 'aukora-record v0.2 bound') return { verdict: 'RECORD_NOT_BOUND' };
    if (lines.length < 3 || lines.length > 3 + 512 || lines.slice(1).some(l => !LINE.test(l)) || lines[2].length !== 64) return { verdict: 'RECORD_DOES_NOT_REPLAY' };
    if (ack !== null && (!HEX.test(ack.id ?? '') || !HEX.test(ack.head ?? '') || !Number.isSafeInteger(ack.lines) || ack.lines < 0)) return { verdict: 'UNAVAILABLE' };
    const frames = lines.slice(3); if (ack !== null && frames.length < ack.lines) return { verdict: 'RECORD_SHORTER' };
    const api = (core instanceof WebAssembly.Module ? await WebAssembly.instantiate(core, {}) : (await WebAssembly.instantiate(core, {})).instance).exports;
    const feed = bytes => { for (const b of bytes) api.input(b); }, read = f => hex(Uint8Array.from({ length: 32 }, (_, i) => f(i)));
    feed(unhex(lines[1] + lines[2])); if (api.initBound() !== 1) return { verdict: 'RECORD_DOES_NOT_REPLAY' };
    const id = read(api.recordIdByte); if (read(api.head) !== id) return { verdict: 'UNAVAILABLE' };
    if (ack !== null && id !== ack.id) return { verdict: 'RECORD_NOT_THIS_ONE' };
    if (ack !== null && ack.lines === 0 && id !== ack.head) return { verdict: 'RECORD_REWRITTEN' };
    for (let n = 0; n < frames.length; n++) {
      feed(unhex(frames[n])); if (api.step() !== 1) return { verdict: 'RECORD_DOES_NOT_REPLAY' };
      if (ack !== null && n + 1 === ack.lines && read(api.head) !== ack.head) return { verdict: 'RECORD_REWRITTEN' };
    }
    const intent = promotionIntent({ ballId, parentBallId, epoch, generation });
    const bundle = await sha(cat(text(MISSING), await sha(intent)));
    const act = cat(Uint8Array.of(0x17), bundle, unhex(read(api.head)), u64(frames.length + 1), Uint8Array.of(0x04), intent);
    feed(act); if (api.step() !== 1) return { verdict: 'NO_CURRENT_EXACT_PERMIT' };
    return { verdict: 'ADMIT', recordText: [...lines, hex(act)].join('\n') + '\n', ack: { id, lines: frames.length + 1, head: read(api.head) } };
  } catch { return { verdict: 'UNAVAILABLE' }; }
}
