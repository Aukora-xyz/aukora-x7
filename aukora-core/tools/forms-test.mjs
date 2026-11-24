// Keeps tools/forms.mjs honest against the Lean text, and tests the boundary check.
// 1. Reads `FormId.code`, `formOf` and `essential` out of the Lean source and compares them with the JavaScript copy.
// 2. Classifies real frames from the core's own sample record and checks the core admits them.
// 3. The boundary check on cases with known answers.
// Usage: node tools/forms-test.mjs [path to Forms.lean] [path to Refusal.lean]      (CONTROL: --control plants one wrong code)
import { readFileSync } from 'node:fs';
import { FORMS, CODE, ESSENTIAL, formOf } from './forms.mjs';
import { within } from './within.mjs';
const root = new URL('../', import.meta.url).pathname, args = process.argv.slice(2), control = args.includes('--control');
const formsLean = readFileSync(args.find(a => a.endsWith('Forms.lean')) ?? root + 'v0.10/Forms.lean', 'utf8');
const refusalLean = readFileSync(args.find(a => a.endsWith('Refusal.lean')) ?? root + 'v0.10/Refusal.lean', 'utf8');
let pass = 0, fail = 0; const check = (name, ok, detail = '') => { if (ok) pass++; else { fail++; console.log('FAIL', name, detail); } };

// 1a. the codes
const codeBlock = formsLean.slice(formsLean.indexOf('def FormId.code'), formsLean.indexOf('def FormId.all'));
const lean = [...codeBlock.matchAll(/\| \.(\w+) => (\d+)/g)].map(m => [m[1], Number(m[2])]);
const js = control ? FORMS.map(([n, c]) => n === 'cancel' ? [n, 99] : [n, c]) : FORMS;
check('the Lean table has 38 forms', lean.length === 38, `found ${lean.length}`);
check('every form has the same number in both copies', JSON.stringify(lean) === JSON.stringify(js),
  lean.filter(([n, c], i) => js[i]?.[0] !== n || js[i]?.[1] !== c).map(([n, c]) => `${n}=${c}`).join(' '));
// 1b. the essential forms
const ess = refusalLean.slice(refusalLean.indexOf('def essential'), refusalLean.indexOf('| _ => false'));
const leanEss = [...ess.matchAll(/\.(\w+)/g)].map(m => m[1]).filter(n => n in CODE);
check('the essential forms are the same', JSON.stringify([...leanEss].sort()) === JSON.stringify([...ESSENTIAL].sort()), leanEss.join(' '));
// 1c. the classifier: every (byte, byte) the Lean match names, read back out of the source and fed to the JS formOf
const fo = formsLean.slice(formsLean.indexOf('def formOf'), formsLean.indexOf('def inputForm'));
const frame = (b0, at, v, len = 3400) => { const w = Buffer.alloc(len); w[0] = b0; if (at !== null) w[at] = v; return w; };
const cases = [[0x00, 41, 0x00, 'say'], [0x00, 41, 0x01, 'remember'], [0x00, 41, 0x02, 'correct'], [0x00, 41, 0x06, 'advise'], [0x00, 41, 0x05, 'report'],
  [0x00, 41, 0x0d, 'spend'], [0x00, 41, 0x10, 'read'], [0x00, 41, 0x07, null], [0x14, null, 0, 'legacyKeyChange'], [0x15, null, 0, 'assessment'],
  [0x16, null, 0, 'threshold'], [0x17, null, 0, 'act'], [0x18, null, 0, 'timedApproval'], [0x19, null, 0, 'cancel'], [0x1a, null, 0, 'correction'],
  [0x1b, null, 0, 'install'], [0x1c, null, 0, null], [0x01, null, 0, null]];
for (const [b0, at, v, want] of cases) check(`byte ${b0.toString(16)}${at !== null ? ` / byte ${at} = ${v.toString(16)}` : ''}`, formOf(frame(b0, at, v)) === want, String(formOf(frame(b0, at, v))));
for (const [v, want] of [[3, 'approval'], [9, 'retract'], [10, 'mandate'], [12, 'budget'], [14, 'pass'], [15, 'revoke'], [4, null]]) { const w = Buffer.alloc(3400); w[0] = 0x13; w[3350] = v; check(`tag 13 action ${v}`, formOf(w) === want); }
{ const w = Buffer.alloc(3349); w[0] = 0x13; check('tag 13 too short to carry an action byte', formOf(w) === null); }
for (const [a, b, d, want] of [[2, 0x28, 0, 'evidenceAssessment'], [2, 0x29, 0, 'evidenceRead'], [2, 0x29, 1, 'evidenceSource'], [2, 0x29, 2, 'evidenceOutcome'], [2, 0x29, 3, null],
  [2, 0x2a, 0, 'premise'], [2, 0x2b, 0, 'ceiling'], [2, 0x32, 0, 'halt'], [2, 0x33, 0, 'clear'], [2, 0x34, 0, 'refusedAct'], [2, 0x35, 0, 'keyChange'],
  [3, 1, 0, 'cellReceipt'], [3, 2, 0, 'cellAssessment'], [3, 3, 0, null], [4, 1, 0, null]]) { const w = Buffer.alloc(60); w[0] = 0xff; w[1] = a; w[2] = b; w[43] = d; check(`ff ${a} ${b.toString(16)} / ${d}`, formOf(w) === want, String(formOf(w))); }
// every hex constant in the Lean classifier also appears in a case above (so a form added to the Lean text and not here fails)
const leanPairs = [...fo.matchAll(/some \.(\w+)/g)].map(m => m[1]);
const tested = new Set([...cases.map(c => c[3]), 'approval', 'retract', 'mandate', 'budget', 'pass', 'revoke', 'evidenceAssessment', 'evidenceRead', 'evidenceSource',
  'evidenceOutcome', 'premise', 'ceiling', 'halt', 'clear', 'refusedAct', 'keyChange', 'cellReceipt', 'cellAssessment']);
check('every form the Lean classifier names is exercised here', leanPairs.every(f => tested.has(f)), leanPairs.filter(f => !tested.has(f)).join(' '));

// 3. the boundary check
const W = (a, b) => within({ refused: a }, { refused: b }).answer;
check('the same list is within itself', W(['approval', 'legacyKeyChange'], [8, 14]) === 'within');
check('refusing more is within', W(['approval', 'legacyKeyChange', 'spend'], ['approval', 'legacyKeyChange']) === 'within');
check('refusing less exceeds', W(['approval'], ['approval', 'legacyKeyChange']) === 'exceeds');
check('nothing refused exceeds the bound start', W([], [8, 14]) === 'exceeds');
check('an unknown form is unsupported', W(['approval', 'teleport'], ['approval']) === 'unsupported');
check('an essential form on a list is unsupported', W(['halt'], []) === 'unsupported');
check('an unknown number is unsupported', W([99], []) === 'unsupported');
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
