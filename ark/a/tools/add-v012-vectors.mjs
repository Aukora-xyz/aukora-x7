// Adds the two v0.1.2 vectors (the contract editor's decisions L1, L2) to vectors/ WITHOUT regenerating the others.
// Both are derived from the existing done.bundle.json; only unsigned bundle bytes change, no signature is made.
// Idempotent: re-running replaces the two entries.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEnvelope } from '../lib/core.mjs';
import { selfcheck, checkPins } from '../lib/selfcheck.mjs';

const VEC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vectors');
const rd = (f) => JSON.parse(fs.readFileSync(path.join(VEC, f), 'utf8'));
const done = rd('done.bundle.json');
const pins = rd('pins.json');
const opDone = done.items.map(openEnvelope).find((o) => o.type === 'outcome').obj.op_id;
// C22 escape, written out by hand
const esc = (s) => [...s].map((ch) => {
  const c = ch.codePointAt(0);
  if (c === 10) return '\\n'; if (c === 13) return '\\r'; if (c === 9) return '\\t';
  if (c < 0x20 || c === 0x7f) return '\\u' + c.toString(16).padStart(4, '0');
  return ch;
}).join('');
const header = (cov) => [`coverage: ${esc(cov)}`, `pins supplied by: ${esc(pins.supplied_by)}`, 'integrity only; freshness and completeness not shown'];

const add = [];
{ // L1: a boolean as a bundle item
  const b = { v: '0.1', coverage: done.coverage, items: [done.items[0], true, ...done.items.slice(1)] };
  fs.writeFileSync(path.join(VEC, 'invalid-boolean-item.json'), JSON.stringify(b) + '\n');
  add.push({ bundle: 'invalid-boolean-item.json', pins: 'pins.json', note: 'C21: a boolean in the items array is BAD_ENVELOPE at its index',
    bundle_verdict: { verdict: 'INVALID', reason: 'BAD_ENVELOPE', item: 1 }, ops: {}, exit: 4,
    stdout: [...header(b.coverage), 'BUNDLE INVALID BAD_ENVELOPE item=1'] });
}
{ // L2: coverage carries an LF and a fake verdict line
  const cov = `${done.coverage}\nOP 00000000000000000000000000000000 DONE`;
  const b = { v: '0.1', coverage: cov, items: done.items };
  fs.writeFileSync(path.join(VEC, 'done-coverage-control-chars.json'), JSON.stringify(b) + '\n');
  add.push({ bundle: 'done-coverage-control-chars.json', pins: 'pins.json', note: 'C22: coverage holds LF + a fake OP line; printed escaped on one line, then the real verdict',
    bundle_verdict: { verdict: 'OK' }, ops: { [opDone]: { verdict: 'DONE' } }, exit: 0,
    stdout: [...header(cov), 'BUNDLE OK', `OP ${opDone} DONE`] });
}

{ // v0.1.3, C7: "approval": true in a signed outcome payload, old signature kept; fails at E4
  const items = [...done.items];
  const io = items.findIndex((e) => openEnvelope(e).type === 'outcome');
  const raw = Buffer.from(items[io].payload, 'base64url').toString('utf8');
  const m = raw.match(/"approval":"[0-9a-f]{64}"/);
  if (!m) throw new Error('outcome approval not found');
  items[io] = { ...items[io], payload: Buffer.from(raw.replace(m[0], '"approval":true'), 'utf8').toString('base64url') };
  const b = { v: '0.1', coverage: done.coverage, items };
  fs.writeFileSync(path.join(VEC, 'invalid-approval-true.json'), JSON.stringify(b) + '\n');
  add.push({ bundle: 'invalid-approval-true.json', pins: 'pins.json', note: 'C7 (v0.1.3): outcome payload has "approval": true; BAD_JSON at E4, before any signature check',
    bundle_verdict: { verdict: 'INVALID', reason: 'BAD_JSON', item: io }, ops: {}, exit: 4,
    stdout: [...header(b.coverage), `BUNDLE INVALID BAD_JSON item=${io}`] });
}

const ev = rd('expected-verdicts.json');
const names = new Set(add.map((a) => a.bundle));
ev.vectors = [...ev.vectors.filter((v) => !names.has(v.bundle)), ...add];
let bad = 0;
for (const v of add) {
  const r = selfcheck(fs.readFileSync(path.join(VEC, v.bundle)), checkPins(fs.readFileSync(path.join(VEC, v.pins))));
  if (JSON.stringify({ b: r.bundle, o: r.ops, e: r.exit }) !== JSON.stringify({ b: v.bundle_verdict, o: v.ops, e: v.exit })) { bad++; console.error('MISMATCH', v.bundle, r); }
  if (v.stdout.length !== r.lines.length || v.stdout.slice(3).join('\n') !== r.lines.slice(3).join('\n')) { bad++; console.error('LINES', v.bundle, r.lines); }
  if (v.stdout.some((l) => /[\u0000-\u001f\u007f]/.test(l))) { bad++; console.error('control char left in', v.bundle); }
}
fs.writeFileSync(path.join(VEC, 'expected-verdicts.json'), JSON.stringify(ev, null, 2) + '\n');
console.log(`added ${add.length}, total ${ev.vectors.length}, mismatches ${bad}`);
process.exit(bad ? 1 : 0);
