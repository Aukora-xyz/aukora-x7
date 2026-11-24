// Boundary check for two refused lists, the way a reviewer asks "does this proposed policy stay inside the one I allow?"
// A policy here is the list of forms a record refuses (by name or by number). Policy A is WITHIN boundary B when A
// refuses at least every form B refuses, so A admits nothing B would not. The answer is one of:
//   within       A admits only what B admits
//   exceeds      A admits forms B refuses (listed)
//   unsupported  a form this table does not know, or an essential form put on a list (the core never refuses those)
// Fails closed: anything but `within` exits non-zero. It checks the FORM level only: two policies that admit the same
// forms can still differ in who may sign and in what limits apply; those are not modelled here and the output says so.
// Usage: node tools/within.mjs '<policy A json>' '<boundary B json>'      e.g. '{"refused":["approval",14]}'
//        node tools/within.mjs --describe '<policy json>'
import { CODE, NAME, ESSENTIAL, PLAIN, FORMS } from './forms.mjs';

export function normalize(policy) {
  const bad = [], set = new Set();
  for (const x of (policy?.refused ?? [])) {
    const name = typeof x === 'number' ? NAME[x] : (x in CODE ? x : undefined);
    if (!name) { bad.push(`unknown form ${JSON.stringify(x)}`); continue; }
    if (ESSENTIAL.has(name)) { bad.push(`${name} is essential: the core never refuses it, so a list naming it describes no real record`); continue; }
    set.add(name);
  }
  return { set, bad };
}
export function within(a, b) {
  const A = normalize(a), B = normalize(b), bad = [...A.bad.map(x => 'policy: ' + x), ...B.bad.map(x => 'boundary: ' + x)];
  if (bad.length) return { answer: 'unsupported', reasons: bad };
  const extra = [...B.set].filter(f => !A.set.has(f)).sort((x, y) => CODE[x] - CODE[y]);
  return extra.length ? { answer: 'exceeds', admitsBeyondBoundary: extra.map(f => `${f} (${CODE[f]}): ${PLAIN[f]}`) } : { answer: 'within' };
}
export function describe(p) {
  const P = normalize(p);
  return { refused: [...P.set].map(f => `${CODE[f]} ${f}: ${PLAIN[f]}`), admitted: FORMS.filter(([f]) => !P.set.has(f)).length, unsupported: P.bad,
    neverRefused: [...ESSENTIAL].map(f => `${CODE[f]} ${f}: ${PLAIN[f]}`) };
}
const COVERED = 'covered: which of the 38 forms are refused. NOT covered: signers, limits, budgets, expiry, the record\'s content.';
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  try {
    if (a[0] === '--describe') { console.log(JSON.stringify(describe(JSON.parse(a[1])), null, 1)); process.exit(0); }
    const r = within(JSON.parse(a[0]), JSON.parse(a[1]));
    console.log(JSON.stringify({ ...r, covered: COVERED }, null, 1)); process.exit(r.answer === 'within' ? 0 : 1);
  } catch (e) { console.log(JSON.stringify({ answer: 'unsupported', reasons: ['not a policy: ' + e.message], covered: COVERED }, null, 1)); process.exit(1); }
}
