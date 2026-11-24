// Display helpers for examples/read-record.mjs.
export const escapeText = value => JSON.stringify(value).replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const displayLimit = 120;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const omitted = bytes => `… (${bytes.length} bytes in all)`;

function text(bytes) {
  let preview = '';
  for (const char of utf8.decode(bytes)) {
    const escaped = escapeText(char).slice(1, -1);
    if (preview.length + escaped.length > displayLimit) return `"${preview}"${omitted(bytes)}`;
    preview += escaped;
  }
  return `"${preview}"`;
}

function payload(bytes) {
  try { return text(bytes); }
  catch {
    const preview = bytes.subarray(0, displayLimit / 2);
    return `hex ${preview.toString('hex')}${preview.length < bytes.length ? omitted(bytes) : ''}`;
  }
}

// v0.8/EXPORTS.md exposes raw recordByte, not decoded frames. The layout is defined
// in v0.2/WIRE.md (inherited by v0.8/WIRE.md), also encoded by standalone/aukora.mjs.
// Describe only admitted frames; this display decoder makes no admission decisions.
export function describe(b) {
  let p = 0;
  const take = n => { if (p + n > b.length) throw Error('short field'); const v = b.subarray(p, p + n); p += n; return v; };
  const u16 = () => take(2).readUInt16LE();
  const blob = () => take(u16());
  const intent = () => {
    const kind = take(1)[0];
    const body = kind === 0 ? `deliver ${payload(blob())}` : kind === 1 ? `install sha256 ${take(32).toString('hex')}` : null;
    if (body === null) throw Error('unknown intent');
    return `${body}, audience ${text(blob())}, generation ${u16()}, nonce ${u16()}`;
  };
  try {
    if (b[0] === 0x18) {
      p = 41; const expiry = take(8).readBigUInt64LE();
      return `owner approval (both signatures, one use): ${intent()}, through frame ${expiry} inclusive`;
    }
    if (b[0] === 0x13 && b[3350] === 0x03) {
      p = 3351; return `owner approval (both signatures, one use in this replay, not tied to this record): ${intent()}`;
    }
    if (b[0] === 0x00 && b[41] === 0x00) { p = 42; return `statement: ${text(blob())}`; }
    if (b[0] === 0x17 && b[73] === 0x04) { p = 74; return `direct act: ${intent()}`; }
    if ((b[0] === 0x00 || b[0] === 0x1a) && b[41] === 0x05) {
      p = 42; const subject = intent(), result = ['confirmed', 'failed', 'unknown'][take(1)[0]];
      if (result === undefined) throw Error('unknown result');
      return `${b[0] === 0x1a ? 'corrected' : 'reported'} outcome: ${result}; ${subject}`;
    }
  } catch { /* An unsupported display must never be guessed. */ }
  return '(kind not decoded by this reader)';
}
