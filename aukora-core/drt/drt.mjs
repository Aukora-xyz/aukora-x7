// Differential testing of compiled cores. Several core files are driven in LOCKSTEP with the same generated inputs and
// compared after EVERY input: the verdict and every value the files export (head, installed core, halt flag, threshold,
// evidence ceiling, record identifier, law identity, journal, seal, stamp count). Inputs are generated with structure:
// real owner-signed frames of every kind the test library can build, built on the live head, then mutated (bits flipped,
// cut, extended, re-addressed to an older head, signed by a stranger, replayed), plus garbage, feeds, resets, stamps,
// seals and continuations, on records started the old way and bound.
//
// Usage: node drt/drt.mjs [--minutes M | --steps N] [--seed S] [--bound | --old | --mixed] [--save DIR] CORE.wasm CORE.wasm ...
//        node drt/drt.mjs --replay FILE CORE.wasm CORE.wasm ...
//        node drt/drt.mjs --check PREFIX CORE.wasm ...   replay PREFIX.in(.gz) in each core and compare every line with
//                                                        PREFIX.expected(.gz) (a stream whose outputs were checked elsewhere)
// --emit PREFIX also writes PREFIX.in (the inputs) and PREFIX.expected (executor 0's verdict and view per input), for
// executors that are not WebAssembly (drt/native/).
// --ignore lawByte,journalByte,sealByte compares cores of DIFFERENT law sets (those three values carry the law identity).
// Every run prints its seed. A disagreement or a trap saves the exact input stream (hex) so it can be replayed.
// CONTROL: --control flips the verdict of one executor on its 500th step; the run must report a disagreement.
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync } from 'node:fs';
const LIB = new URL('../v0.10/tests/', import.meta.url);
const { cat, sha, u16, u64, blob, text, owner, keyFields, deliver, dual, timedGrant } = await import(new URL('host.mjs', LIB));
const { safeControl } = await import(new URL('safe-fields.mjs', LIB));
const { formOf, channelForm, FORMS } = await import(new URL('../tools/forms.mjs', import.meta.url));

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = k => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
const minutes = Number(opt('--minutes', 0)), maxSteps = Number(opt('--steps', minutes ? Infinity : 2000));
let seed = Number(opt('--seed', Date.now() % 2147483647)) >>> 0 || 1; const SEED = seed;
const checkPrefix = opt('--check', null), replayFile = opt('--replay', null), saveDir = opt('--save', new URL('corpus/', import.meta.url).pathname);
const emit = opt('--emit', null), emitIn = emit && openSync(emit + '.in', 'w'), emitOut = emit && openSync(emit + '.expected', 'w');
const ignore = new Set(String(opt('--ignore', '')).split(',').filter(Boolean));
const lawControl = flag('--law-control');   // CONTROL: apply the v0.10 bound-record check to every core (an older core must then fail it)
const mode = flag('--bound') ? 'bound' : flag('--old') ? 'old' : 'mixed', control = flag('--control');
const files = args; if (files.length < (checkPrefix ? 1 : 2)) { console.error('give at least two core files'); process.exit(2); }

// ---- a seeded choice stream (the signatures themselves are not seeded; the saved stream is the exact record) ----
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)], chance = p => rnd() < p, int = n => Math.floor(rnd() * n);

// ---- executors ----
const exe = files.map(f => { const bytes = readFileSync(f); return { name: f.split('/').slice(-2).join('/'), digest: createHash('sha256').update(bytes).digest('hex').slice(0, 12), mod: new WebAssembly.Module(bytes) }; });
for (const e of exe) if (WebAssembly.Module.imports(e.mod).length) throw new Error(e.name + ' declares imports');
const fresh = () => exe.forEach(e => { e.api = new WebAssembly.Instance(e.mod).exports; e.dead = false; });
const b32 = (api, f) => { const o = Buffer.alloc(32); for (let i = 0; i < 32; i++) { const v = api[f](i); if (v > 255) return 'none'; o[i] = v; } return o.toString('hex'); };
const VIEW = ['head', 'core', 'recordIdByte', 'lawByte', 'journalByte', 'sealByte'].filter(f => !ignore.has(f)), SCALAR = ['halted', 'threshold', 'guessCeiling', 'stampCount'].filter(f => !ignore.has(f));
function view(e) {
  if (e.dead) return 'TRAPPED';
  try { return VIEW.map(f => b32(e.api, f)).join('|') + '|' + SCALAR.map(f => e.api[f]()).join(','); } catch (x) { e.dead = true; return 'TRAP in view: ' + String(x.message).slice(0, 40); }
}
function call(e, op, bytes) {
  if (e.dead) return 'TRAPPED';
  try { for (let i = 0; i < bytes.length; i++) e.api.input(bytes[i]); return e.api[op](); } catch (x) { e.dead = true; return 'TRAP ' + String(x.message).slice(0, 40); }
}

const V10 = new Set(['c924c72aec02', '1d642eac3fd3']);   // the bound-start refusal is a law of v0.10 and later only
// ---- the generator's picture of the record, read from executor 0 (frames are built on ITS head) ----
const st = { seq: 0, keys: null, gen: 0, admitted: [], heads: [], bound: false, claims: [], nextClaim: 1, budgets: [], passes: [], mandates: [], r2: 0 };
const A = () => exe[0].api, headBuf = () => Buffer.from(b32(A(), 'head'), 'hex');
const H = () => cat(headBuf(), u64(st.seq + 1));
const strangers = [owner(), owner()], spares = [owner(), owner(), owner()];
const intents = [0, 1, 2, 3, 4, 5].map(n => deliver(Buffer.from('order ' + n), 0, n));
const MISSING = 'AUKORA/R8/missing:request-intent-only;evidence=missing;reasoning=missing;witness=missing;versions=missing';
const signer = () => chance(0.12) ? pick(strangers) : st.keys;
const head32 = () => headBuf();
const kinds = {
  say: () => cat(Buffer.of(0), H(), Buffer.of(0), text('line ' + int(1e6))),
  remember: () => { const id = chance(0.7) ? st.nextClaim : pick([...st.claims, int(60)]); return cat(Buffer.of(0), H(), Buffer.of(1), u16(id), u16(chance(0.9) ? 1 + int(Math.max(1, st.seq)) : int(65536)), text('claim ' + id)); },
  correct: () => { const a = pick(st.claims.length ? st.claims : [0]), b = pick(st.claims.length ? st.claims : [1]); return cat(Buffer.of(0), H(), Buffer.of(2), u16(a), u16(b), text('correction')); },
  advise: () => cat(Buffer.of(0), H(), Buffer.of(6), text(pick(['cell-a', 'cell-b'])), u16(int(65536))),
  report: () => cat(Buffer.of(0), H(), Buffer.of(5), pick(intents), Buffer.of(int(4))),
  spend: () => cat(Buffer.of(0), H(), Buffer.of(13), u16(chance(0.85) && st.budgets.length ? pick(st.budgets) : int(60)), u16(chance(0.9) ? 1 + int(3) : int(5))),
  read: () => { const p = chance(0.8) && st.lastPass ? st.lastPass : [pick(['agent', 'other']), pick(['notes', 'mail'])]; return cat(Buffer.of(0), H(), Buffer.of(16), u16(chance(0.85) && st.passes.length ? st.passes.at(-1) : int(60)), text(p[0]), text(p[1]), Buffer.of(chance(0.9) ? 1 : int(3))); },
  approval: () => { const k = signer(), i = pick(intents), s = dual(k, cat(text('AUKORA/R7/hybrid/grant'), keyFields(k), i)); return cat(Buffer.of(19), s.mlSig, H(), Buffer.of(3), i, s.edSig); },
  legacyKeyChange: () => { const k = signer(), n = pick(spares), s = dual(k, cat(text('AUKORA/R7/hybrid/rebind'), keyFields(k), u64(st.gen), keyFields(n))); return cat(Buffer.of(20), n.mlRaw, s.mlSig, H(), Buffer.of(8), n.edRaw, s.edSig); },
  mandate: () => { const k = signer(), a = cat(Buffer.of(10), text('service'), blob(Buffer.from('report')), u16(st.gen), u16(int(4)), u16(65535)), s = dual(k, cat(text('AUKORA/R7/hybrid/control'), keyFields(k), Buffer.from('AUKORA/R5/control'), u64(st.gen), H(), a)); return cat(Buffer.of(19), s.mlSig, H(), a, s.edSig); },
  otherControl: () => { const k = signer(), a = cat(Buffer.of(pick([9, 12, 14, 15])), randomBytes(int(40))), s = dual(k, cat(text('AUKORA/R7/hybrid/control'), keyFields(k), Buffer.from('AUKORA/R5/control'), u64(st.gen), H(), a)); return cat(Buffer.of(19), s.mlSig, H(), a, s.edSig); },
  retract: () => ctl(cat(Buffer.of(9), u16(chance(0.8) ? 1 + int(Math.max(1, st.mandates.length)) : int(60)))),
  budget: () => ctl(cat(Buffer.of(12), u16(st.gen), u16(1 + int(10)))),
  pass: () => { st.passArgs = [pick(['agent', 'other']), pick(['notes', 'mail'])]; return ctl(cat(Buffer.of(14), text(st.passArgs[0]), text(st.passArgs[1]), u16(st.gen), u16(st.seq + 3 + int(30)))); },
  revoke: () => ctl(cat(Buffer.of(15), u16(chance(0.85) && st.passes.length ? pick(st.passes) : int(60)))),
  assessment: () => cat(Buffer.of(21), H(), sha(pick(intents)), Buffer.of(int(256)), randomBytes(32)),
  threshold: () => { const k = signer(), v = int(256), s = dual(k, cat(text('AUKORA/R8/threshold'), keyFields(k), u64(st.gen), H(), Buffer.of(v))); return cat(Buffer.of(22), H(), Buffer.of(v), s.edSig, s.mlSig); },
  act: () => { const i = pick(intents); return cat(Buffer.of(23), sha(cat(text(MISSING), sha(i))), H(), Buffer.of(4), i); },
  timedApproval: () => timedGrant(signer(), H(), pick(intents), st.gen, st.seq + 1 + int(8)),
  cancel: () => { const k = signer(), i = pick(intents), s = dual(k, cat(text('AUKORA/R9/revoke'), keyFields(k), u64(st.gen), H(), sha(i))); return cat(Buffer.of(25), H(), sha(i), s.edSig, s.mlSig); },
  correction: () => cat(Buffer.of(26), H(), Buffer.of(5), pick(intents), Buffer.of(int(4))),
  install: () => cat(Buffer.of(27), H(), randomBytes(int(200))),
  halt: () => safeCtl(50), clear: () => safeCtl(51), keyChange: () => safeCtl(53, pick(spares)),
  refusedAct: () => { const i = deliver(Buffer.from('never approved ' + int(1e6)), st.gen, int(65536)), act = cat(Buffer.of(23), sha(cat(text(MISSING), sha(i))), H(), Buffer.of(4), i);
    return cat(Buffer.of(255, 2, 52), head32(), Buffer.from(String(st.seq + 1)), Buffer.of(0), chance(0.85) ? act : randomBytes(int(120))); },
  ceiling: () => { const k = signer(), z = int(256), s = dual(k, cat(text('AUKORA/R9/R11/ceiling'), keyFields(k), u64(st.gen), H(), Buffer.of(z))); return cat(Buffer.of(255, 2, 43), H(), Buffer.of(z), s.edSig, s.mlSig); },
  evidence: () => { const t = pick([40, 41, 41, 41, 42]); let body;
    const claim = (v3 = false) => cat(Buffer.of(int(v3 ? 5 : 4)), Buffer.of(int(256)), Buffer.of(0), Buffer.of(chance(0.5) ? 0 : 1), ...(chance(0.5) ? [] : [randomBytes(32)]));
    if (t === 40) body = cat(sha(pick(intents)), Buffer.of(int(256)), Buffer.of(1), claim());
    else if (t === 42) body = claim();
    else { const k = int(3);
      if (k === 0) body = cat(Buffer.of(0), randomBytes(32), u64(int(Math.max(1, st.seq))), u64(int(Math.max(1, st.seq))), Buffer.of(int(2)), randomBytes(32), Buffer.of(int(256)));
      else if (k === 1) body = cat(Buffer.of(1), text(pick(['web', 'mail', 'file'])), randomBytes(32), Buffer.of(int(256)));
      else body = cat(Buffer.of(2), pick(intents), Buffer.of(int(3)), Buffer.of(int(2)), Buffer.of(int(256))); }
    return cat(Buffer.of(255, 2, t), H(), body); },
  cell: () => { const tok = () => text(pick(['search', 'lookup', 'calc', 'v1.2'])), opt = () => chance(0.5) ? Buffer.of(0) : cat(Buffer.of(1), randomBytes(32));
    if (chance(0.5)) return cat(Buffer.of(255, 3, 1), H(), tok(), randomBytes(32), tok(), opt(), opt(), text(pick(['ok', 'error'])));
    const claim = () => cat(Buffer.of(int(5)), Buffer.of(int(256)), Buffer.of(0), Buffer.of(0));
    return cat(Buffer.of(255, 3, 2), H(), sha(pick(intents)), Buffer.of(int(256)), Buffer.of(1), claim()); },
  garbage: () => { const g = randomBytes(pick([1, 2, 3, 41, 64, 200, 3400])); if (chance(0.5)) g[0] = pick([0, 19, 20, 21, 22, 23, 24, 25, 26, 27, 255]); if (g.length > 2 && g[0] === 255) g[1] = pick([2, 3, int(256)]); return g; },
};
function ctl(a) { const k = signer(), s = dual(k, cat(text('AUKORA/R7/hybrid/control'), keyFields(k), Buffer.from('AUKORA/R5/control'), u64(st.gen), H(), a)); return cat(Buffer.of(19), s.mlSig, H(), a, s.edSig); }
function safeCtl(op, newKeys) {
  const fake = { historyLength: () => st.seq, header: () => H() };
  return safeControl(fake, op, st.keys, st.gen, { newKeys, signer: signer() });
}
const weights = Object.entries({ say: 8, remember: 3, correct: 2, advise: 3, report: 3, spend: 3, read: 3, retract: 1, budget: 2, pass: 2, revoke: 1, approval: 5, legacyKeyChange: 3, mandate: 3,
  otherControl: 2, assessment: 3, threshold: 3, act: 6, timedApproval: 7, cancel: 3, correction: 2, install: 1, halt: 3, clear: 3, keyChange: 2,
  refusedAct: 2, ceiling: 2, evidence: 2, cell: 1, garbage: 4 });
const total = weights.reduce((a, [, w]) => a + w, 0);
const chooseKind = () => { let r = rnd() * total; for (const [k, w] of weights) if ((r -= w) < 0) return k; return 'say'; };
function mutate(w) {
  const m = Buffer.from(w), r = int(6);
  if (r === 0 && m.length) { const p = chance(0.5) ? int(Math.min(48, m.length)) : int(m.length); m[p] ^= 1 << int(8); return ['bit', m]; }
  if (r === 1) return ['cut', m.subarray(0, int(m.length))];
  if (r === 2) return ['extended', cat(m, randomBytes(1 + int(3)))];
  if (r === 3 && st.heads.length > 1 && m.length > 41) { const old = pick(st.heads.slice(0, -1)); const i = m.indexOf(headBuf()); if (i >= 0) { old.copy(m, i); return ['re-addressed', m]; } }
  if (r === 4 && st.admitted.length) return ['replayed', Buffer.from(pick(st.admitted))];
  return ['as built', m];
}

// ---- one run ----
let steps = 0, compared = 0, diffs = 0, traps = 0, lawChecks = 0, lawViolations = 0; const counts = {}, notes = [], stream = [], byForm = {};
const tally = (k, v) => { counts[k] ??= [0, 0]; counts[k][v === 1 ? 0 : 1]++; };
function apply(op, bytes, label) {
  stream.push([op, bytes.toString('hex'), label]);
  const before = exe.map(view);
  let verdicts = exe.map(e => call(e, op, bytes));
  if (control && steps === 500) verdicts[verdicts.length - 1] = verdicts[verdicts.length - 1] === 1 ? 0 : 1;
  const after = exe.map(view); compared++;
  if (emit) { writeSync(emitIn, `${op} ${bytes.length ? bytes.toString('hex') : '-'}\n`); writeSync(emitOut, `${verdicts[0]} ${after[0]}\n`); }
  { const f = op === 'step' ? (formOf(bytes) ?? 'no form') : (channelForm(op) ?? op); byForm[f] ??= [0, 0]; byForm[f][verdicts[0] === 1 ? 0 : 1]++; }
  const same = verdicts.every(v => v === verdicts[0]) && after.every(v => v === after[0]);
  if (verdicts.some(v => typeof v === 'string' && v.startsWith('TRAP'))) traps++;
  if (!same) { diffs++; if (notes.length < 20) notes.push(`step ${steps} ${op} ${label}: verdicts ${verdicts.join(' / ')}; views ${after.every(v => v === after[0]) ? 'same' : 'DIFFERENT'}`); }
  // LAW CHECKS on the bytes, on every input, for every core: what the laws promise must hold of the compiled file too.
  if (op === 'step') exe.forEach((e, n) => {
    const v = verdicts[n], f = formOf(bytes), [, , , , , , scal] = before[n].split('|'), wasHalted = scal?.split(',')[0] === '1';
    const breach = why => { lawViolations++; diffs++; if (notes.length < 20) notes.push(`step ${steps} ${label}: ${e.name} LAW CHECK FAILED: ${why}`); };
    if (/\((re-addressed|replayed)\)/.test(label)) { lawChecks++; if (v === 1) breach('a frame naming an earlier head or an earlier position was admitted (stale law)'); }
    if (wasHalted && ['act', 'timedApproval', 'approval'].includes(f)) { lawChecks++; if (v === 1) breach('an act or approval was admitted while the record was halted'); }
    if (st.bound && (lawControl || V10.has(e.digest)) && ['approval', 'legacyKeyChange'].includes(f)) { lawChecks++; if (v === 1) breach('a bound record admitted an old command form (bound_refuses_legacy)'); }
  });
  // a refusal must leave every exported value as it was (the no-op law, observed on the bytes)
  exe.forEach((e, n) => { if (verdicts[n] === 0 && op === 'step' && after[n] !== before[n]) { diffs++; if (notes.length < 20) notes.push(`step ${steps} ${label}: ${e.name} REFUSED but its exported state changed`); } });
  return verdicts[0];
}
function start() {
  if (emit) writeSync(emitIn, 'NEW\n');
  fresh(); st.seq = 0; st.gen = 0; st.admitted = []; st.claims = []; st.nextClaim = 1; st.budgets = []; st.passes = []; st.mandates = []; st.r2 = 0; st.keys = owner(); st.bound = mode === 'bound' || (mode === 'mixed' && chance(0.5));
  const k = cat(st.keys.edRaw, st.keys.mlRaw);
  const v = st.bound ? apply('initBound', cat(k, randomBytes(32)), 'bound start') : apply('init', k, 'old start');
  st.heads = [headBuf()]; return v === 1;
}
function one() {
  steps++;
  const r = rnd();
  if (r < 0.03) { apply('feed', randomBytes(int(5000)), 'feed'); return; }
  if (r < 0.04) { apply('reset', Buffer.alloc(0), 'reset'); return; }
  if (r < 0.06) { const n = int(200), good = cat(headBuf(), u16(n), randomBytes(n), randomBytes(32)); let w = good, how = 'as built'; if (chance(0.3)) [how, w] = mutate(good); const v = apply('stamp', w, `stamp (${how})`); tally('stamp', v); return; }   // head, 2-byte length, beacon, 32-byte digest
  if (r < 0.075 && !ignore.has('lawByte')) { sealAndContinue(); return; }   // a seal signs the law identity, so cores of different law sets MUST differ on it
  const kind = chooseKind(); let w = kinds[kind](), how = 'as built';
  if (chance(0.3)) [how, w] = mutate(w);
  const v = apply('step', w, `${kind} (${how})`); tally(kind + (how === 'as built' ? '' : ' mutated'), v);
  if (v === 1) {
    st.seq++; st.admitted.push(w); st.heads.push(headBuf());
    const idx = st.seq - 1;   // the frame's position in the record's history: the id that budgets, passes and mandates are named by
    if (how === 'as built') { if (kind === 'remember') { st.claims.push(w.readUInt16LE(42)); st.nextClaim = Math.max(st.nextClaim, w.readUInt16LE(42) + 1); }
      if (kind === 'budget') st.budgets.push(idx); if (kind === 'pass') { st.passes.push(idx); st.lastPass = st.passArgs; } if (kind === 'mandate') st.mandates.push(idx); }
    if ((kind === 'legacyKeyChange' || kind === 'keyChange') && how === 'as built') { const n = kind === 'keyChange' ? null : null; st.gen++; refreshKeys(w, kind); }
  }
}
function refreshKeys(w, kind) {
  // the new keys are in the frame: legacy 0x14 = [20][mlRaw 1952]...[edRaw 32 before edSig]; newer = wire ends with ed 32 + ml 1952 before the sigs
  const all = [...spares, ...strangers, st.keys];
  for (const k of all) { if (w.includes(k.mlRaw) && w.includes(k.edRaw) && k !== st.keys) { st.keys = k; return; } }
}
function sealAndContinue() {
  const law = Buffer.from(b32(A(), 'lawByte'), 'hex'), journal = b32(A(), 'journalByte');
  if (journal === 'none' || b32(A(), 'lawByte') === 'none') { apply('seal', randomBytes(64), 'seal without journal'); return; }
  const body = cat(Buffer.from('AUKORA/R12B/seal'), Buffer.from(journal, 'hex'), law, headBuf(), cat(st.keys.edRaw, st.keys.mlRaw));
  const s = dual(signer(), body); let wire = cat(body, s.edSig, s.mlSig), how = 'as built';
  if (chance(0.25)) [how, wire] = mutate(wire);
  const v = apply('seal', wire, `seal (${how})`); tally('seal', v);
  if (v !== 1) return;
  const genesis = cat(Buffer.from('AUKORA/R12B/genesis'), sha(wire), law, cat(st.keys.edRaw, st.keys.mlRaw));
  const c = apply('continueRecord', chance(0.15) ? mutate(genesis)[1] : genesis, 'continue'); tally('continue', c);
  if (c === 1) st.heads.push(headBuf());
}
function save(tag) { mkdirSync(saveDir, { recursive: true }); const f = `${saveDir}/${tag}-seed${SEED}-${Date.now()}.json`; writeFileSync(f, JSON.stringify({ seed: SEED, mode, files: exe.map(e => e.name + ' ' + e.digest), notes, stream })); return f; }

if (checkPrefix) {
  const read = p => { try { return gunzipSync(readFileSync(p + '.gz')).toString(); } catch { return readFileSync(p, 'utf8'); } };
  const ins = read(checkPrefix + '.in').split('\n').filter(Boolean), want = read(checkPrefix + '.expected').split('\n').filter(Boolean);
  let bad = 0;
  for (const e of exe) {
    let line = 0, n = 0;
    for (const l of ins) {
      if (l === 'NEW') { e.api = new WebAssembly.Instance(e.mod).exports; e.dead = false; continue; }
      const [op, h] = l.split(' '); const v = call(e, op, h === '-' ? Buffer.alloc(0) : Buffer.from(h, 'hex')); const got = `${v} ${view(e)}`;
      if (got !== want[line]) { bad++; console.log(`DIFFERS ${e.name}: input ${line + 1} (${op}): expected ${want[line]?.slice(0, 80)}…, got ${got.slice(0, 80)}…`); break; }
      line++; n++;
    }
    if (line === want.length) console.log(`${e.name} (${e.digest}…): all ${n} outputs as expected`);
    else if (!bad) { bad++; console.log(`DIFFERS ${e.name}: ${line} outputs for ${want.length} expected`); }
  }
  process.exit(bad ? 1 : 0);
}
if (replayFile) {
  const s = JSON.parse(readFileSync(replayFile, 'utf8')); fresh();
  for (const [op, hex, label] of s.stream) { steps++; apply(op, Buffer.from(hex, 'hex'), label); }
  console.log(`REPLAY ${replayFile}: ${compared} inputs, ${diffs} disagreements, ${traps} traps`); notes.forEach(n => console.log('  ' + n)); process.exit(diffs || traps ? 1 : 0);
}
const t0 = Date.now(), deadline = minutes ? t0 + minutes * 60000 : Infinity; let records = 0, segmentLen = 0;
while (steps < maxSteps && Date.now() < deadline) {
  if (records === 0 || segmentLen > 60 + int(140) || exe[0].dead) { if (stream.length && diffs) break; stream.length = 0; records++; segmentLen = 0; start(); }
  one(); segmentLen++;
  if (diffs) break;
}
const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`DRT seed ${SEED} mode ${mode}${ignore.size ? ' ignoring ' + [...ignore].join(',') : ''}: ${compared} inputs compared across ${exe.length} cores in ${records} records, ${secs} s; ${diffs} disagreements, ${traps} traps`);
console.log('cores: ' + exe.map(e => `${e.name} (${e.digest}…)`).join(', '));
console.log(`law checks on the bytes: ${lawChecks} made, ${lawViolations} failed (stale or replayed frames refused; no act or approval while halted; in v0.10 bound records no old command form)`);
const cover = Object.entries(counts).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, [a, r]]) => `${k} ${a}/${a + r}`).join('; ');
console.log('admitted/offered by kind: ' + cover);
const offered = FORMS.filter(([f]) => byForm[f]), admittedForms = FORMS.filter(([f]) => byForm[f]?.[0]);
console.log(`forms (the core's own table): offered ${offered.length} of 38, admitted at least once ${admittedForms.length} of 38; never admitted here: ${FORMS.filter(([f]) => !byForm[f]?.[0]).map(([f]) => f).join(' ')}`);
if (diffs || traps) { notes.forEach(n => console.log('  ' + n)); console.log('saved: ' + save(diffs ? 'disagreement' : 'trap')); process.exit(1); }
console.log('ALL AGREE');
