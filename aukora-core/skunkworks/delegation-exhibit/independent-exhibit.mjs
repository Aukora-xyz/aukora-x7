// An independent check: the exhibit against an independent re-statement of its rules, on random chains, and every way of lying in a receipt.
// Run from the lab root: node skunkworks/delegation-exhibit/independent-exhibit.mjs
import { Core, newOwner } from '../../standalone/aukora.mjs';
import { PROFILES, audit, compare, evaluateChain, profileId, receipt, record } from './exhibit.mjs';
const held = new Map(PROFILES.map(t => [profileId(t), t])); const [prefix, atMost, strict, none] = PROFILES.map(profileId), unknown = profileId('not held');
let seed = 9; const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
let pass = 0, fail = 0; const check = (name, ok, extra = '') => { if (ok) pass++; else { fail++; if (fail < 12) console.log('FAIL', name, extra); } };
// my own statement of the rules, written from the brief, not from the patch
const P = { [prefix]: ['prefix', true, 'definition-derived'], [atMost]: ['at-most', true, 'definition-derived'], [strict]: ['prefix', false, 'asserted'], [none]: ['none', false, 'asserted'] };
function hopResult(h) { const p = P[h.profile]; if (!p) return ['UNDECIDED', 'PROFILE_NOT_HELD']; if (p[0] === 'none') return ['UNDECIDED', 'NO_COMPARISON_RELATION'];
  if (p[0] === 'prefix') { if (typeof h.received !== 'string' || typeof h.emitted !== 'string') return ['UNDECIDED', 'VALUE_NOT_COMPARABLE']; return [(p[1] && h.emitted === h.received) || h.emitted.startsWith(h.received + '/') ? 'NO_BROADER' : 'BROADER', null]; }
  const ok = v => Number.isInteger(v) && v >= 0; if (!ok(h.received) || !ok(h.emitted)) return ['UNDECIDED', 'VALUE_NOT_COMPARABLE']; return [h.emitted <= h.received ? 'NO_BROADER' : 'BROADER', null]; }
function mine(hops) { if (!hops.length) return { established: true, cause: 'EMPTY_CHAIN_AUTHORIZES_NOTHING', at: null }; const r = hops.map(hopResult);
  let i = r.findIndex(x => x[0] === 'UNDECIDED'); if (i >= 0) return { established: false, cause: 'HOP_UNDECIDED:' + r[i][1], at: i };
  i = r.findIndex(x => x[0] === 'BROADER'); if (i >= 0) return { established: false, cause: 'HOP_BROADER', at: i };
  if (hops.length > 1) { i = hops.findIndex(h => h.profile !== hops[0].profile); if (i >= 0) return { established: false, cause: 'PROFILE_DIFFERS', at: i };
    for (let k = 0; k + 1 < hops.length; k++) if (hops[k].emitted !== hops[k + 1].received) return { established: false, cause: 'VALUE_NOT_SHARED', at: k };
    if (!['definition-derived', 'mechanically-checkable'].includes(P[hops[0].profile][2])) return { established: false, cause: 'BASIS_ASSERTED', at: null }; }
  return { established: true, cause: null, at: null }; }
const words = ['pay', 'pay/supplier', 'pay/supplier/eu', 'pay/supplier/eu/fr', 'payroll', 'read', 'pay/'], profs = [prefix, prefix, prefix, atMost, atMost, strict, none, unknown];
const value = p => (p === atMost ? [0, 1, 2, 3, 5, '2', 1.5, -1][rnd(8)] : [...words, 3, null][rnd(words.length + 2)]);
const chain = () => { const n = rnd(6), p0 = profs[rnd(profs.length)], hops = []; let carry = value(p0);
  for (let i = 0; i < n; i++) { const p = rnd(9) ? p0 : profs[rnd(profs.length)], received = rnd(6) ? carry : value(p), emitted = rnd(3) ? (typeof received === 'string' && rnd(2) ? received + '/x' : typeof received === 'number' && received > 0 && rnd(2) ? received - 1 : received) : value(p); hops.push({ domain: 'D' + i, profile: p, received, emitted }); carry = emitted; } return hops; };
const causes = {}; const all = [];
for (let i = 0; i < 4000; i++) { const hops = chain(), a = evaluateChain(hops, held), b = mine(hops); causes[a.established ? 'ESTABLISHED' + (a.cause ? ' (empty)' : '') : a.cause] = (causes[a.established ? 'ESTABLISHED' + (a.cause ? ' (empty)' : '') : a.cause] || 0) + 1;
  check('random chain agrees with my statement of the rules', JSON.stringify(a) === JSON.stringify(b), JSON.stringify({ hops, a, b })); if (i < 300) all.push(hops); }
console.log('causes seen:', JSON.stringify(causes));
check('"payroll" is not under "pay"', compare(prefix, held, 'pay', 'payroll').result === 'BROADER'); check('"1" is not 1 across hops', evaluateChain([{ domain: 'A', profile: atMost, received: 2, emitted: 1 }, { domain: 'B', profile: atMost, received: '1', emitted: 0 }], held).cause === 'HOP_UNDECIDED:VALUE_NOT_COMPARABLE');
// 300 honest receipts in one record, audited cold
const core = await Core.load(); core.init(newOwner()); for (const hops of all) record(core, hops, held); const text = core.exportRecord(); const a = await audit(text, held);
check('300 honest receipts all agree on a cold audit', a.receipts === 300 && a.agree === 300 && a.disagree.length === 0, JSON.stringify(a));
// every way of lying in ONE receipt, each in its own otherwise honest record
let lies = 0, caught = 0; const sample = all.filter(h => h.length > 1).slice(0, 25);
for (const hops of sample) { const honest = receipt(hops, held);
  const forged = [{ ...honest, established: !honest.established }, { ...honest, cause: honest.cause === 'HOP_BROADER' ? null : 'HOP_BROADER' }, { ...honest, at: (honest.at ?? 0) + 1 }, { ...honest, chain: honest.chain.replace(/^./, c => (c === '0' ? '1' : '0')) },
    { ...honest, hops: hops.map((h, i) => (i === 0 ? { ...h, emitted: h.emitted === 'read' ? 'pay' : 'read' } : h)) }];
  for (const f of forged) { const c = await Core.load(); c.init(newOwner()); c.say(JSON.stringify(f)); const r = await audit(c.exportRecord(), held); lies++; if (r.disagree.length === 1 && r.agree === 0) caught++; } }
check(`every forged receipt is listed as disagreeing (${caught} of ${lies})`, caught === lies);
// a reader who holds no profiles cannot be told "established"
const blind = await audit(text, new Map()); check('a reader holding no profile texts does not confirm the record as a whole', blind.disagree.length > 0 && blind.agree < 300, JSON.stringify(blind).slice(0, 120));
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
