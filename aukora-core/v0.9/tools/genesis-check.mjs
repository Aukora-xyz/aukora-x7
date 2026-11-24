// Round 12c A, build step: a release fails unless the law identity embedded in the compiled core equals
// the identity of the statement `full_lawful` proves. The two sides are derived independently:
//   embedded: the core's own `lawByte` 0..31 after genesis (compiled manifest, embedded environment, root bytes);
//   proved:   `.work/package/proved.id`, written by tools/ExportFinal.lean from the TYPE of RootFinal.full_lawful
//             (its head's structure fields, the environment snapshot hash and the serialized head).
// Usage:
//   node tools/genesis-check.mjs <core.wasm> <proved.id>
//   node tools/genesis-check.mjs --description <fixture.json>   (both identities given as hex; never a core)
// Exit 0 only when the identities are equal. Every other outcome exits 1.
import {generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';

export function compare(embedded, proved) {
  return Buffer.isBuffer(embedded) && Buffer.isBuffer(proved) && embedded.length === 32 && proved.length === 32 &&
    embedded.equals(proved);
}

export function embeddedIdentity(wasm) {
  const api = new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports;
  const raw = (kp, width) => kp.publicKey.export({format: 'der', type: 'spki'}).subarray(-width);
  const keys = Buffer.concat([raw(generateKeyPairSync('ed25519'), 32), raw(generateKeyPairSync('ml-dsa-65'), 1952)]);
  for (const b of keys) if (api.input(b) !== 1) throw new Error('input refused');
  if (api.init() !== 1) throw new Error('genesis refused');
  const out = Buffer.from(Array.from({length: 32}, (_, i) => api.lawByte(i)));
  if (api.lawByte(32) !== 256 || out.some(b => b > 255)) throw new Error('law identity unreadable');
  return out;
}

export function check(args) {
  let embedded, proved, source;
  if (args[0] === '--description') {
    const d = JSON.parse(readFileSync(args[1], 'utf8'));
    embedded = Buffer.from(d.embedded, 'hex');
    proved = Buffer.from(d.proved, 'hex');
    source = args[1];
  } else {
    embedded = embeddedIdentity(readFileSync(args[0]));
    proved = readFileSync(args[1]);
    source = args[0];
  }
  const ok = compare(embedded, proved);
  console.log(`${ok ? 'PASS' : 'FAIL'} genesis law identity ${source}: embedded ${embedded.toString('hex')} proved ${proved.toString('hex')}`);
  return ok;
}

if (import.meta.url === new URL(process.argv[1], 'file://').href || process.argv[1]?.endsWith('genesis-check.mjs')) {
  let ok = false;
  try { ok = check(process.argv.slice(2)); } catch (e) { console.log('FAIL genesis law identity:', e.message); }
  process.exit(ok ? 0 : 1);
}
