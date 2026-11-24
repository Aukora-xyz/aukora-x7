import { createHash } from 'node:crypto';
import { leafHashes } from '../../standalone/checkpoint.mjs';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const HEADER = 'aukora-record v0.1';
const hexLine = /^(?:[0-9a-f]{2})+$/;
const hash = (tag, ...chunks) => {
  const h = createHash('sha256').update(Buffer.of(tag));
  for (const chunk of chunks) h.update(chunk);
  return h.digest();
};

function requireThat(ok, why) {
  if (!ok) throw new Error('onion: ' + why);
}

// The wire-facing API uses safe Numbers for totals and lower-case hex digests.
function totalsOf(totals, width) {
  requireThat(Array.isArray(totals) && totals.length === 6, 'expected six totals');
  const v = Array.from(totals);
  requireThat(v.every(x => Number.isSafeInteger(x) && x >= 0), 'invalid total');
  const [lines, bytes, ...kinds] = v;
  requireThat(lines === width && bytes >= lines &&
    kinds.reduce((a, b) => a + BigInt(b), 0n) === BigInt(lines), 'inconsistent totals');
  return v;
}

function encode(totals) {
  const bytes = Buffer.alloc(48);
  for (let j = 0; j < 6; j++) bytes.writeBigUInt64BE(BigInt(totals[j]), 8 * j);
  return bytes;
}

function digestBytes(digest) {
  requireThat(typeof digest === 'string' && digest.length === 64 &&
    /^[0-9a-f]+$/.test(digest), 'invalid digest');
  return Buffer.from(digest, 'hex');
}

function commitment(node, width) {
  requireThat(node !== null && typeof node === 'object', 'missing node');
  const totals = totalsOf(node.totals, width);
  digestBytes(node.digest);
  return { totals, digest: node.digest };
}

function same(a, b) {
  return a.digest === b.digest && a.totals.every((x, j) => x === b.totals[j]);
}

function split(n) {
  let k = 1;
  while (2 * k < n) k *= 2;
  return k;
}

function kind(first, i) {
  if (i === 0) return 5;
  if (first === 0x00) return 2;
  if (first === 0x13 || first === 0x18) return 3;
  return first === 0x17 ? 4 : 5;
}

// AMENDED in review: an optional classifier (line bytes, index) -> counter 2..5, so the four counters can mean
// something other than the default kinds. The same classifier must be used to build, to verify and to reattach.
const byFirstByte = (bytes, i) => kind(bytes[0], i);
function leaf(bytes, i, rfcHash, classify = byFirstByte) {
  const totals = [1, bytes.byteLength, 0, 0, 0, 0];
  const slot = classify(bytes, i);
  requireThat(Number.isInteger(slot) && slot >= 2 && slot <= 5, 'classifier must return 2..5');
  totals[slot] = 1;
  return { totals, digest: hash(2, encode(totals), rfcHash).toString('hex') };
}

function join(left, right) {
  const totals = left.totals.map((x, j) => {
    const sum = BigInt(x) + BigInt(right.totals[j]);
    requireThat(sum <= MAX, 'total overflow');
    return Number(sum);
  });
  // AMENDED in review: the parent commits to EACH child's totals, not only to their sum. With the sum
  // alone (the brief's own formula), totals could be moved between two removed neighbours without changing the root.
  return { totals, digest: hash(3, encode(left.totals), encode(right.totals),
    digestBytes(left.digest), digestBytes(right.digest)).toString('hex'), left, right };
}

// ONE value for a reader to keep: it commits to the root's totals as well as its digest (the root has no parent to do so).
export function rootCommit(root) {
  requireThat(root !== null && typeof root === 'object' && Array.isArray(root.totals) && root.totals.length === 6 &&
    root.totals.every(x => Number.isSafeInteger(x) && x >= 0), 'invalid root');
  return hash(4, encode(root.totals), digestBytes(root.digest)).toString('hex');
}

function bytesOf(line) {
  if (typeof line === 'string') {
    requireThat(line.length % 2 === 0 && hexLine.test(line), 'invalid hex line');
    return Buffer.from(line, 'hex');
  }
  requireThat(line instanceof Uint8Array && line.byteLength > 0, 'expected nonempty line bytes');
  return line;
}

function buildRegion(lines, hashes, offset, classify) {
  function sub(lo, width) {
    if (width === 1) return leaf(lines[lo], offset + lo, hashes[lo], classify);
    const k = split(width);
    return join(sub(lo, k), sub(lo + k, width - k));
  }
  return sub(0, lines.length);
}

function validateSize(size) {
  requireThat(Number.isSafeInteger(size) && size > 0, 'invalid size');
}

function validateIndex(i, size) {
  validateSize(size);
  requireThat(Number.isSafeInteger(i) && i >= 0 && i < size, 'index outside tree');
}

export function build(recordText, classify) {
  requireThat(typeof recordText === 'string', 'expected record text');
  const lines = recordText.split('\n');
  if (lines.at(-1) === '') lines.pop();
  requireThat(lines.shift() === HEADER && lines.length > 0, 'invalid or empty record');
  const decoded = lines.map(bytesOf);
  return { root: buildRegion(decoded, leafHashes(recordText), 0, classify), size: decoded.length };
}

// Recompute all exposed parents. A pruned subtree is an opaque commitment;
// a fully pruned root can be checked only by comparing both kept fields.
function project(node, width) {
  requireThat(node !== null && typeof node === 'object', 'missing node');
  if (node.pruned === true || width === 1) {
    requireThat(!('left' in node) && !('right' in node), 'terminal node has children');
    return commitment(node, width);
  }
  const k = split(width);
  const { totals, digest } = join(project(node.left, k), project(node.right, width - k));
  return { totals, digest };
}

export function rootOf(tree) {
  validateSize(tree.size);
  return project(tree.root, tree.size);
}

export function prove(tree, i) {
  validateIndex(i, tree.size);
  const descent = [];
  let node = tree.root, width = tree.size, at = i;
  while (width > 1) {
    requireThat(node && node.pruned !== true, 'leaf is pruned');
    const k = split(width);
    if (at < k) {
      descent.push({ side: 'R', ...project(node.right, width - k) });
      node = node.left;
      width = k;
    } else {
      descent.push({ side: 'L', ...project(node.left, k) });
      node = node.right;
      at -= k;
      width -= k;
    }
  }
  requireThat(node && node.pruned !== true, 'leaf is pruned');
  commitment(node, 1);
  return descent.reverse();
}

export function verifyLeaf(root, lineBytes, i, size, path, classify) {
  try {
    validateIndex(i, size);
    const expected = commitment(root, size);
    const descent = [];
    let at = i, width = size;
    while (width > 1) {
      const k = split(width);
      if (at < k) {
        descent.push(['R', width - k]);
        width = k;
      } else {
        descent.push(['L', k]);
        at -= k;
        width -= k;
      }
    }
    requireThat(Array.isArray(path) && path.length === descent.length, 'wrong path length');
    requireThat(lineBytes instanceof Uint8Array, 'expected line bytes');
    const bytes = bytesOf(lineBytes);
    let node = leaf(bytes, i, hash(0, bytes), classify);
    for (let j = 0; j < path.length; j++) {
      const [side, siblingWidth] = descent[descent.length - 1 - j];
      const step = path[j];
      requireThat(step?.side === side, 'wrong sibling side');
      const sibling = commitment(step, siblingWidth);
      node = side === 'L' ? join(sibling, node) : join(node, sibling);
    }
    return same(node, expected);
  } catch {
    return false;
  }
}

function replace(tree, start, count, change) {
  validateIndex(start, tree.size);
  requireThat(Number.isSafeInteger(count) && count > 0 && count <= tree.size - start,
    'range outside tree');
  function walk(node, lo, width) {
    requireThat(node && typeof node === 'object', 'missing node');
    if (lo === start && width === count) return change(node, width);
    requireThat(width > 1 && !node.pruned, 'range is not an exposed subtree');
    const k = split(width);
    const pivot = lo + k;
    if (start + count <= pivot) {
      return join(walk(node.left, lo, k), node.right);
    }
    if (start >= pivot) {
      return join(node.left, walk(node.right, pivot, width - k));
    }
    throw new Error('onion: range is not exactly one subtree');
  }
  const before = rootOf(tree);
  const next = { root: walk(tree.root, 0, tree.size), size: tree.size };
  requireThat(same(rootOf(next), before), 'root commitment changed');
  return next;
}

export function prune(tree, start, count) {
  return replace(tree, start, count, (node, width) => ({ ...project(node, width), pruned: true }));
}

export function reattach(tree, start, lines, classify) {
  requireThat(Array.isArray(lines) && lines.length > 0, 'expected nonempty lines');
  return replace(tree, start, lines.length, (node, width) => {
    requireThat(node.pruned === true, 'range is not pruned');
    const want = commitment(node, width);
    const bytes = Array.from(lines, bytesOf);
    const hashes = leafHashes(HEADER + '\n' + bytes.map(b => Buffer.from(b).toString('hex')).join('\n'));
    const next = buildRegion(bytes, hashes, start, classify);
    requireThat(same(next, want), 'reattached subtree does not match');
    return next;
  });
}
