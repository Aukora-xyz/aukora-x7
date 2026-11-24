// A bubble that opens is a genuine region of the record whose onion commitment was kept, with these exact totals. It says nothing about any other region, about whether the record is complete, or about whether its lines are true. Whoever holds a bubble can read its lines.
import { proveRegion, verifyRegion, reattach, rootOf, rootCommit } from '../onion/onion.mjs';

const HEADER = 'aukora-record v0.1';
const FIELDS = ['v', 'size', 'start', 'count', 'lines', 'path'];
const STEP_FIELDS = ['side', 'totals', 'digest'];
const HEX = /^(?:[0-9a-f]{2})+$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const natural = x => Number.isSafeInteger(x) && x >= 0 && !Object.is(x, -0);
const hexLine = x => typeof x === 'string' && x.length % 2 === 0 && HEX.test(x) && !/[^0-9a-f]/u.test(x);
function insist(ok, what) {
  if (!ok) throw new TypeError('bubble: ' + what);
}

function fields(value, order) {
  insist(value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  'expected plain object');
  const keys = Reflect.ownKeys(value);
  insist(keys.length === order.length && keys.every((key, i) => key === order[i]),
    'wrong object fields or order');
  return order.map(key => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    insist(d?.enumerable && Object.hasOwn(d, 'value'), 'expected enumerable data field');
    return d.value;
  });
}

function dense(value, limit) {
  insist(Array.isArray(value) && value.length <= limit, 'wrong array shape');
  const n = value.length;
  insist(Reflect.ownKeys(value).length === n + 1, 'wrong array fields');
  return Array.from({ length: n }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    insist(d?.enumerable && Object.hasOwn(d, 'value'), 'missing array item');
    return d.value;
  });
}

function canonical(value) {
  const [v, size, start, count, rawLines, rawPath] = fields(value, FIELDS);
  insist(v === 1 && natural(size) && size > 0 && natural(start) && start < size &&
    natural(count) && count > 0 && count <= size - start, 'invalid region');
  const lines = dense(rawLines, count);
  insist(lines.length === count && lines.every(hexLine), 'invalid lines');
  const path = dense(rawPath, 53).map(step => {
    const [side, rawTotals, digest] = fields(step, STEP_FIELDS);
    const totals = dense(rawTotals, 6);
    insist((side === 'L' || side === 'R') && totals.length === 6 && totals.every(natural) &&
      typeof digest === 'string' && digest.length === 64 && DIGEST.test(digest), 'invalid sibling');
    return { side, totals, digest };
  });
  return { v: 1, size, start, count, lines, path };
}

export function exportBubble(tree, recordText, start, count) {
  insist(typeof recordText === 'string', 'expected record text');
  const source = recordText.split('\n');
  if (source.at(-1) === '') source.pop();
  insist(source.shift() === HEADER && source.length === tree.size && source.every(hexLine),
    'invalid record or tree size mismatch');
  const path = proveRegion(tree, start, count);
  return canonical({ v: 1, size: tree.size, start, count,
    lines: source.slice(start, start + count), path });
}

export function encodeBubble(bubble) {
  return JSON.stringify(canonical(bubble));
}

export function decodeBubble(text) {
  insist(typeof text === 'string', 'expected JSON text');
  const bubble = canonical(JSON.parse(text));
  insist(JSON.stringify(bubble) === text, 'noncanonical encoding');
  return bubble;
}

function openCanonical(keptCommit, bubble, classify) {
  const lines = bubble.lines.map(line => Buffer.from(line, 'hex'));
  const totals = verifyRegion(keptCommit, lines, bubble.start, bubble.size, bubble.path, classify);
  return totals === null ? null : { totals, lines };
}

export function openBubble(keptCommit, bubble, classify) {
  try {
    return openCanonical(keptCommit, canonical(bubble), classify);
  } catch {
    return null;
  }
}

export function returnBubble(prunedTree, bubble, classify) {
  const copy = canonical(bubble);
  const opened = openCanonical(rootCommit(rootOf(prunedTree)), copy, classify);
  insist(opened !== null, 'bubble does not open against origin');
  return reattach(prunedTree, copy.start, opened.lines, classify);
}
