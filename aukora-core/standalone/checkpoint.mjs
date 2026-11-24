// Checkpoints over a record, in the shape an existing minimal append-only verifier reads (RFC 6962 trees).
// A checkpoint is two values: how many lines the record had, and one fingerprint (Merkle root) of all of them.
// Someone who KEEPS a checkpoint outside the host can later check, from two small documents and without seeing a
// single line, that the record only grew. This file computes; it decides nothing and gates nothing.
// Leaf n is line n of the record (the genesis line first): sha256(0x00 || line bytes). Node: sha256(0x01 || l || r).
import { createHash } from 'node:crypto';
const H = (...b) => createHash('sha256').update(Buffer.concat(b)).digest();
const node = (l, r) => H(Buffer.of(1), l, r);
const split = n => { let k = 1; while (k * 2 < n) k *= 2; return k; };   // largest power of two below n
/** The leaf hashes of a record's text. */
export function leafHashes(recordText) {
  const lines = recordText.trim().split('\n'); if (lines[0] !== 'aukora-record v0.1') throw new Error('not an aukora record');
  return lines.slice(1).map(l => { if (!/^([0-9a-f]{2})+$/.test(l)) throw new Error('a record line is not hex'); return H(Buffer.of(0), Buffer.from(l, 'hex')); });
}
/** Merkle tree head of a non-empty list of leaf hashes (RFC 6962, section 2.1). */
export function treeHead(h) { if (h.length === 0) throw new Error('an empty record has no checkpoint'); if (h.length === 1) return h[0]; const k = split(h.length); return node(treeHead(h.slice(0, k)), treeHead(h.slice(k))); }
/** Consistency proof from the first m leaves to all of them (RFC 6962, section 2.1.2). */
export function consistencyProof(m, h) {
  if (!Number.isInteger(m) || m < 1 || m > h.length) throw new Error('the earlier size must be between 1 and the current size');
  const sub = (m, h, whole) => { if (m === h.length) return whole ? [] : [treeHead(h)]; const k = split(h.length);
    return m <= k ? [...sub(m, h.slice(0, k), whole), treeHead(h.slice(k))] : [...sub(m - k, h.slice(k), false), treeHead(h.slice(0, k))]; };
  return sub(m, h, true);
}
/** The checkpoint of a record. With `previous` (a checkpoint kept earlier) it also carries the proof that links the two. */
export function checkpoint(recordText, previous) {
  const h = leafHashes(recordText);
  const doc = { treeSize: h.length, root: treeHead(h).toString('hex'), hashAlgorithm: 'SHA-256', leafConvention: 'sha256(0x00 || payload)' };
  if (previous !== undefined) {
    if (!Number.isInteger(previous.treeSize) || previous.treeSize < 1) throw new Error('the earlier checkpoint has no usable size');
    if (previous.treeSize > h.length) throw new Error(`this record has ${h.length} lines but the earlier checkpoint saw ${previous.treeSize}: lines are missing`);
    doc.proofFromPrevious = consistencyProof(previous.treeSize, h).map(x => x.toString('hex'));
  }
  return doc;
}
/** For a reader who HOLDS the record: does it begin with exactly the lines an earlier checkpoint saw? */
export function extendsCheckpoint(recordText, previous) {
  const h = leafHashes(recordText); return previous.treeSize >= 1 && previous.treeSize <= h.length && treeHead(h.slice(0, previous.treeSize)).toString('hex') === String(previous.root).toLowerCase();
}
