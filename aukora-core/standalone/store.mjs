// A record on disk: <dir>/record.log (public), <dir>/intents.json (public), <dir>/owner.key (SECRET, owner only).
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Core, newOwner } from './aukora.mjs';
// Set AUKORA_OWNER_KEY to keep the secret somewhere the agent cannot read (another disk, another machine's mount).
export const paths = dir => ({ record: join(dir, 'record.log'), intents: join(dir, 'intents.json'), key: process.env.AUKORA_OWNER_KEY || join(dir, 'owner.key') });
export async function create(dir) {
  const p = paths(dir); if (existsSync(p.record)) throw new Error('a record already exists in ' + dir);
  mkdirSync(dir, { recursive: true }); const owner = newOwner(); const c = await Core.load(); c.init(owner);
  writeFileSync(p.key, JSON.stringify(owner)); chmodSync(p.key, 0o600);
  writeFileSync(p.record, c.exportRecord()); writeFileSync(p.intents, '{}'); return c;
}
/** Open = replay the whole record in a fresh core. If any line was changed, this throws. */
export async function open(dir) { const c = await Core.load(); await c.replay(readFileSync(paths(dir).record, 'utf8')); return c; }
export const save = (dir, c) => writeFileSync(paths(dir).record, c.exportRecord());
export const intents = dir => JSON.parse(readFileSync(paths(dir).intents, 'utf8'));
export const saveIntents = (dir, m) => writeFileSync(paths(dir).intents, JSON.stringify(m, null, 1));
export const ownerOf = dir => JSON.parse(readFileSync(paths(dir).key, 'utf8'));
/** An agent proposes an act. Nothing is approved. Returns the id the owner will approve. */
export function propose(dir, c, payload, audience) {
  const m = intents(dir); const nonce = Object.keys(m).length + 1; const id = 'a' + nonce;
  m[id] = { payload, audience, generation: 0, nonce, state: 'proposed' }; saveIntents(dir, m);
  c.say(`proposed ${id} for ${audience}: ${payload}`); save(dir, c); return id;
}
