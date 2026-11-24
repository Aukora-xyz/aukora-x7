// An absence proof shows that a key is not in the set this root was built from. It does not show that the set contains every read: that holds only if the root was built from the whole record by someone who had it, or by the core itself. It speaks only for reads that leave a line in this record.
import { createHash } from 'node:crypto';

const DEPTH = 256;
const WIDTH = DEPTH / 8;
const HEADER = 'aukora-record v0.1';
const READ = 'READ ';
const HEX = /^(?:[0-9a-f]{2})+$/;
const ROOT_HEX = /^[0-9a-f]{64}$/;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function hash(...parts) {
  const h = createHash('sha256');
  for (const part of parts) h.update(part);
  return h.digest();
}
const INNER = Buffer.of(0x01);
const PRESENT = Buffer.of(0x00);
const EMPTY = [hash(Buffer.of(0x06))];
const inner = (left, right) => hash(INNER, left, right);
for (let level = 1; level <= DEPTH; level++) {
  EMPTY.push(inner(EMPTY[level - 1], EMPTY[level - 1]));
}

function keyBuffer(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== WIDTH) {
    throw new TypeError('alibi: expected 32 bytes');
  }
  return Buffer.from(value);
}

const keyNumber = k => BigInt('0x' + k.toString('hex'));
const bitSet = (b, j) => (b[j >>> 3] & (0x80 >>> (j & 7))) !== 0;
const setBit = (b, j) => { b[j >>> 3] |= 0x80 >>> (j & 7); };

export function keyOf(name) {
  if (typeof name !== 'string' || !name.isWellFormed()) {
    throw new TypeError('alibi: expected a well-formed resource name');
  }
  return hash(Buffer.from(name, 'utf8'));
}

export function readsOf(recordText) {
  if (typeof recordText !== 'string') throw new TypeError('alibi: expected record text');
  const lines = recordText.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== HEADER || !lines.length) throw new Error('alibi: invalid record');
  const reads = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!HEX.test(line)) throw new Error('alibi: invalid hex at leaf ' + i);
    if (i === 0) continue;
    const bytes = Buffer.from(line, 'hex');
    if (bytes[0] !== 0x00) continue;
    if (bytes.length < 42) throw new Error('alibi: truncated speech tag at leaf ' + i);
    if (bytes[41] !== 0x00) continue;
    if (bytes.length < 44) throw new Error('alibi: truncated speech length at leaf ' + i);
    const length = bytes.readUInt16LE(42);
    if (bytes.length !== 44 + length) throw new Error('alibi: invalid speech length at leaf ' + i);
    const text = decoder.decode(bytes.subarray(44));
    if (text.startsWith(READ)) reads.push(text.slice(READ.length));
  }
  return reads;
}

// At level h a map index is the key with its last h bits removed.
// Unset map entries stand for the canonical empty subtree at that level.
function levelsOf(keys) {
  const leaves = new Map();
  for (const raw of keys) {
    const k = keyBuffer(raw);
    const pos = keyNumber(k);
    if (!leaves.has(pos)) leaves.set(pos, hash(PRESENT, k));
  }
  const levels = [leaves];
  for (let level = 0; level < DEPTH; level++) {
    const children = levels[level];
    const parents = new Map();
    for (const pos of children.keys()) {
      const parent = pos >> 1n;
      if (parents.has(parent)) continue;
      const left = parent << 1n;
      parents.set(parent, inner(children.get(left) ?? EMPTY[level],
        children.get(left | 1n) ?? EMPTY[level]));
    }
    levels.push(parents);
  }
  return levels;
}

export function rootOfSet(keys) {
  return (levelsOf(keys)[DEPTH].get(0n) ?? EMPTY[DEPTH]).toString('hex');
}

export function prove(keys, k) {
  let pos = keyNumber(keyBuffer(k));
  const levels = levelsOf(keys);
  const present = levels[0].has(pos);
  const bitmap = Buffer.alloc(WIDTH);
  const siblings = [];
  for (let level = 0; level < DEPTH; level++, pos >>= 1n) {
    const sibling = levels[level].get(pos ^ 1n);
    if (sibling !== undefined && !sibling.equals(EMPTY[level])) {
      setBit(bitmap, DEPTH - 1 - level);
      siblings.push(Buffer.from(sibling));
    }
  }
  return { present, bitmap, siblings };
}

function verify(rootHex, rawKey, proof, wantPresent) {
  try {
    if (typeof rootHex !== 'string' || rootHex.length !== 64 || !ROOT_HEX.test(rootHex)) {
      return false;
    }
    const k = keyBuffer(rawKey);
    const bitmap = keyBuffer(proof.bitmap);
    const list = proof.siblings;
    if (!Array.isArray(list) || list.length > DEPTH) return false;

    // Refuse noncanonical encodings before any path hashing.
    const checked = [];
    for (let level = 0; level < DEPTH; level++) {
      if (!bitSet(bitmap, DEPTH - 1 - level)) continue;
      if (checked.length >= list.length) return false;
      const sibling = keyBuffer(list[checked.length]);
      if (sibling.equals(EMPTY[level])) return false;
      checked.push(sibling);
    }
    if (checked.length !== list.length) return false;

    let value = wantPresent ? hash(PRESENT, k) : EMPTY[0];
    let index = 0;
    for (let level = 0; level < DEPTH; level++) {
      const j = DEPTH - 1 - level;
      const sibling = bitSet(bitmap, j) ? checked[index++] : EMPTY[level];
      if (value.equals(EMPTY[level]) && sibling.equals(EMPTY[level])) {
        value = EMPTY[level + 1];
      } else {
        value = bitSet(k, j) ? inner(sibling, value) : inner(value, sibling);
      }
    }
    return value.toString('hex') === rootHex;
  } catch {
    return false;
  }
}

export function verifyPresent(rootHex, k, proof) {
  return verify(rootHex, k, proof, true);
}

export function verifyAbsent(rootHex, k, proof) {
  return verify(rootHex, k, proof, false);
}
