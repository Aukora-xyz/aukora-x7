// HER OWN CORE RECORD, the pure part (rehearsal, WITNESS-ONLY). Three functions over one bound core record that holds one
// unsigned line per real head promotion. Runs in a browser, a Worker or Node: no file access, no key, no signing, no network.
// The record's owner keys are PUBLIC keys whose private halves were thrown away when the packet was made, so no approval,
// control or seal can ever be signed in it: it can only witness. It ends at 512 lines; then a new record is started.
//   startRecord(core, { publicKeysHex, hostValueHex })                       -> { verdict: 'STARTED', recordText, ack }
//   appendPromotion(core, { recordText, ack, ballId, parentBallId, epoch })  -> { verdict: 'APPENDED', recordText, ack, line }
//   readRecord(core, { recordText, ack })                                    -> { verdict: 'REPLAYED', id, lines, head, promotions, continuous }
// or { verdict } with RECORD_NOT_BOUND, RECORD_NOT_THIS_ONE, RECORD_SHORTER, RECORD_REWRITTEN, RECORD_DOES_NOT_REPLAY, RECORD_FULL,
// UNAVAILABLE. `core` is a WebAssembly.Module (Workers: the statically imported file) or the file's bytes. THE CALLER pins the file.
// A line is the text  aukora.promotion/1 ball=<64 hex> parent=<64 hex> epoch=<n>  in an unsigned speech frame.
export const LINE_PREFIX = 'aukora.promotion/1 ';
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true }), HEX = /^[0-9a-f]{64}$/, HEXLINE = /^(?:[0-9a-f]{2})+$/;
const cat = (...p) => { const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of p) { out.set(x, o); o += x.length; } return out; };
const u16 = n => Uint8Array.of(n & 255, (n >>> 8) & 255), u64 = n => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const unhex = h => Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16)), hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const lineOf = ({ ballId, parentBallId, epoch }) => `${LINE_PREFIX}ball=${ballId} parent=${parentBallId} epoch=${epoch}`;
const parse = text => { const m = /^aukora\.promotion\/1 ball=([0-9a-f]{64}) parent=([0-9a-f]{64}) epoch=(\d{1,16})$/.exec(text); return m ? { ballId: m[1], parentBallId: m[2], epoch: Number(m[3]) } : null; };
const speechText = frame => { if (frame.length < 44 || frame[0] !== 0 || frame[41] !== 0) return null; const n = frame[42] | (frame[43] << 8); if (44 + n !== frame.length) return null; try { return dec.decode(frame.subarray(44)); } catch { return null; } };

async function open(core, recordText, ack) {
  const lines = String(recordText ?? '').trim().split('\n');
  if (lines[0] !== 'aukora-record v0.2 bound') return { verdict: 'RECORD_NOT_BOUND' };
  if (lines.length < 3 || lines.length > 3 + 512 || lines.slice(1).some(l => !HEXLINE.test(l)) || lines[1].length !== 3968 || lines[2].length !== 64) return { verdict: 'RECORD_DOES_NOT_REPLAY' };
  if (ack != null && (!HEX.test(ack.id ?? '') || !HEX.test(ack.head ?? '') || !Number.isSafeInteger(ack.lines) || ack.lines < 0)) return { verdict: 'UNAVAILABLE' };
  const frames = lines.slice(3); if (ack != null && frames.length < ack.lines) return { verdict: 'RECORD_SHORTER' };
  const api = (core instanceof WebAssembly.Module ? await WebAssembly.instantiate(core, {}) : (await WebAssembly.instantiate(core, {})).instance).exports;
  const feed = bytes => { for (const b of bytes) api.input(b); }, read = f => hex(Uint8Array.from({ length: 32 }, (_, i) => f(i)));
  feed(unhex(lines[1] + lines[2])); if (api.initBound() !== 1) return { verdict: 'RECORD_DOES_NOT_REPLAY' };
  const id = read(api.recordIdByte); if (read(api.head) !== id) return { verdict: 'UNAVAILABLE' };
  if (ack != null && id !== ack.id) return { verdict: 'RECORD_NOT_THIS_ONE' };
  if (ack != null && ack.lines === 0 && id !== ack.head) return { verdict: 'RECORD_REWRITTEN' };
  const promotions = [];
  for (let n = 0; n < frames.length; n++) { const frame = unhex(frames[n]);
    feed(frame); if (api.step() !== 1) return { verdict: 'RECORD_DOES_NOT_REPLAY' };
    if (ack != null && n + 1 === ack.lines && read(api.head) !== ack.head) return { verdict: 'RECORD_REWRITTEN' };
    const p = parse(speechText(frame) ?? ''); if (p) promotions.push(p); }
  return { verdict: 'OPEN', api, feed, read, lines, frames, id, promotions };
}
export async function startRecord(core, { publicKeysHex, hostValueHex }) {
  try { if (!HEXLINE.test(publicKeysHex ?? '') || publicKeysHex.length !== 3968 || !HEX.test(hostValueHex ?? '')) return { verdict: 'UNAVAILABLE' };
    const recordText = ['aukora-record v0.2 bound', publicKeysHex, hostValueHex].join('\n') + '\n'; const o = await open(core, recordText, null);
    return o.verdict === 'OPEN' ? { verdict: 'STARTED', recordText, ack: { id: o.id, lines: 0, head: o.id } } : { verdict: o.verdict };
  } catch { return { verdict: 'UNAVAILABLE' }; }
}
export async function appendPromotion(core, { recordText, ack, ballId, parentBallId, epoch }) {
  try { if (!HEX.test(ballId ?? '') || !HEX.test(parentBallId ?? '') || !Number.isSafeInteger(epoch) || epoch < 0) return { verdict: 'UNAVAILABLE' };
    const o = await open(core, recordText, ack); if (o.verdict !== 'OPEN') return { verdict: o.verdict };
    if (o.frames.length >= 512) return { verdict: 'RECORD_FULL' };
    const words = enc.encode(lineOf({ ballId, parentBallId, epoch }));
    const frame = cat(Uint8Array.of(0), unhex(o.read(o.api.head)), u64(o.frames.length + 1), Uint8Array.of(0), u16(words.length), words);
    o.feed(frame); if (o.api.step() !== 1) return { verdict: o.frames.length >= 511 ? 'RECORD_FULL' : 'UNAVAILABLE' };
    return { verdict: 'APPENDED', recordText: [...o.lines, hex(frame)].join('\n') + '\n', ack: { id: o.id, lines: o.frames.length + 1, head: o.read(o.api.head) }, line: o.frames.length + 1 };
  } catch { return { verdict: 'UNAVAILABLE' }; }
}
export async function readRecord(core, { recordText, ack = null }) {
  try { const o = await open(core, recordText, ack); if (o.verdict !== 'OPEN') return { verdict: o.verdict };
    // "continuous": every recorded promotion names as its parent the manifest the line before it recorded
    const continuous = o.promotions.every((p, i) => i === 0 || p.parentBallId === o.promotions[i - 1].ballId);
    return { verdict: 'REPLAYED', id: o.id, lines: o.frames.length, head: o.read(o.api.head), promotions: o.promotions, continuous };
  } catch { return { verdict: 'UNAVAILABLE' }; }
}
