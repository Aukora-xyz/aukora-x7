import { createHash } from 'node:crypto';

function digest(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new TypeError('expected a 32-byte digest');
}
function record(lines) {
  if (!Array.isArray(lines)) throw new TypeError('expected an array of byte strings');
  for (const line of lines) {
    if (!Buffer.isBuffer(line)) throw new TypeError('expected a Buffer line');
  }
}

export function head(g, lines) {
  digest(g);
  record(lines);
  let h = Buffer.from(g);
  for (const line of lines) h = createHash('sha256').update(h).update(line).digest();
  return h;
}

export function checkpoint(g, seen) {
  const top = head(g, seen);
  return { count: seen.length, top };
}

export function verdict(g, kept, now) {
  digest(g);
  if (kept === null || typeof kept !== 'object' ||
      !Number.isSafeInteger(kept.count) || kept.count < 0) throw new TypeError('invalid checkpoint');
  digest(kept.top);
  record(now);
  if (now.length < kept.count) return 1;
  return head(g, now.slice(0, kept.count)).equals(kept.top) ? 0 : 2;
}
