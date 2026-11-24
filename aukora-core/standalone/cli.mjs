#!/usr/bin/env node
// aukora: a record an agent cannot rewrite, and acts that need the owner's approval. v0.1 core.
import * as S from './store.mjs';
const [cmd, dir, ...rest] = process.argv.slice(2); const arg = rest.join(' ');
const out = o => console.log(typeof o === 'string' ? o : JSON.stringify(o));
const need = (c, ok, what) => { S.save(dir, c); out(ok ? `admitted: ${what}; head ${c.headHex().slice(0, 16)}…` : `REFUSED by the core: ${what}`); process.exit(ok ? 0 : 2); };
try {
  if (cmd === 'init') { const c = await S.create(dir); out(`new record in ${dir}; owner.key is the only secret; head ${c.headHex().slice(0, 16)}…`); }
  else if (cmd === 'say') { const c = await S.open(dir); need(c, c.say(arg), 'say'); }
  else if (cmd === 'propose') { const c = await S.open(dir); const [audience, ...p] = rest; out(`proposed ${S.propose(dir, c, p.join(' '), audience)}; the owner approves with: aukora approve ${dir} <id>`); }
  else if (cmd === 'approve') { const c = await S.open(dir); const m = S.intents(dir); const i = m[arg]; if (!i) throw new Error('no such proposal'); out(`you are approving EXACTLY: for "${i.audience}": "${i.payload}" (number ${i.nonce}, once)`); const ok = c.grant(S.ownerOf(dir), i); if (ok) { i.state = 'approved'; S.saveIntents(dir, m); } need(c, ok, `approval of ${arg} (both signatures)`); }
  else if (cmd === 'act') { const c = await S.open(dir); const m = S.intents(dir); const i = m[arg]; if (!i) throw new Error('no such proposal'); const ok = c.act(i); if (ok) { i.state = 'acted'; S.saveIntents(dir, m); } need(c, ok, `act ${arg}`); }
  else if (cmd === 'outcome') { const c = await S.open(dir); const [id, result] = rest; const i = S.intents(dir)[id]; need(c, c.outcome(i, result) || c.correctOutcome(i, result), `outcome ${id} ${result}`); }
  else if (cmd === 'revoke') { const c = await S.open(dir); const i = S.intents(dir)[arg]; need(c, c.revoke(S.ownerOf(dir), i), `cancel approval ${arg}`); }
  else if (cmd === 'head') { const c = await S.open(dir); out({ head: c.headHex(), lines: c.frames.length, core: c.coreDigest }); }
  else if (cmd === 'verify') { const c = await S.open(dir); out(`record verifies: ${c.frames.length} lines replay in a fresh core to head ${c.headHex()}`); if (arg && arg !== c.headHex()) { out(`BUT the head you remembered is different: ${arg}. Lines were added or dropped at the end.`); process.exit(3); } }
  else if (cmd === 'checkpoint') { const { checkpoint } = await import('./checkpoint.mjs'); const { readFileSync } = await import('node:fs'); await S.open(dir); out(JSON.stringify(checkpoint(readFileSync(S.paths(dir).record, 'utf8'), arg ? JSON.parse(readFileSync(arg, 'utf8')) : undefined), null, 2)); }
  else { out('usage: aukora init|say|propose|approve|act|outcome|revoke|head|verify|checkpoint <dir> [...]'); process.exit(64); }
} catch (e) { out('ERROR: ' + e.message); process.exit(1); }
