// Mythos: edges of the bound genesis. No input may trap; a refused start must leave the instance usable and unstarted.
import { randomBytes } from 'node:crypto'; import { readFileSync } from 'node:fs';
const T = '~/aukora-memory/scratch/lean-core-lab-2026-11-22/v0.6/tests/';
const { cat, host, owner } = await import(T + 'host.mjs'); const { bytes32, rawKeys } = await import(T + 'segments.mjs');
const file = readFileSync(process.argv[2]); let pass = 0, fail = 0, traps = 0; const keys = owner(), K = rawKeys(keys), v = randomBytes(32);
const check = (name, got, want) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${got}, wanted ${want}`}`); };
const tryCall = (h, bytes, op) => { try { return h.consume(bytes, op); } catch (e) { traps++; return 'TRAP ' + String(e.message).slice(0, 30); } };
for (const [name, bytes] of [['empty input', Buffer.alloc(0)], ['keys only, no host value', K], ['host value one byte short', cat(K, v.subarray(0, 31))], ['host value one byte long', cat(K, v, Buffer.of(0))], ['keys one byte short', cat(K.subarray(1), v)], ['64 KiB of zeros', Buffer.alloc(65536)], ['all 0xff, right length', Buffer.alloc(K.length + 32, 255)]]) {
  const h = host(file); const r = tryCall(h, bytes, 'initBound'); check(`bound start with ${name} -> refused`, r, 0);
  check(`   then a proper bound start still works`, tryCall(h, cat(K, v), 'initBound'), 1); }
{ const h = host(file); check('bound start', tryCall(h, cat(K, v), 'initBound'), 1); const id = bytes32(h.api.recordIdByte), hd = bytes32(h.api.head);
  check('first head equals the identifier', hd.equals(id), true);
  check('a second bound start on a started record -> refused', tryCall(h, cat(K, randomBytes(32)), 'initBound'), 0); check('an old start on a bound record -> refused', tryCall(h, K, 'init'), 0);
  check('identifier and head unchanged after both refusals', bytes32(h.api.recordIdByte).equals(id) && bytes32(h.api.head).equals(hd), true); }
{ const h = host(file); check('old start', tryCall(h, K, 'init'), 1); check('a bound start on an old-mode record -> refused', tryCall(h, cat(K, v), 'initBound'), 0); check('still no identifier', h.api.recordIdByte(0), 256); }
{ const a = host(file), b = host(file), c = host(file), k2 = rawKeys(owner()); tryCall(a, cat(K, v), 'initBound'); tryCall(b, cat(K, v), 'initBound'); tryCall(c, cat(k2, v), 'initBound');
  check('same keys and host value -> same identifier (deterministic)', bytes32(a.api.recordIdByte).equals(bytes32(b.api.recordIdByte)), true);
  check('different keys, same host value -> different identifier', bytes32(a.api.recordIdByte).equals(bytes32(c.api.recordIdByte)), false);
  for (const i of [-1, 32, 33, 255, 256, 2 ** 31 - 1]) { let r; try { r = a.api.recordIdByte(i); } catch { traps++; r = 'TRAP'; } if (r !== 256) { fail++; console.log('FAIL identifier byte index', i, 'gave', r); } else pass++; } }
console.log(`${pass} passed, ${fail} failed, ${traps} traps on ${process.argv[2].split('/').pop()}`); process.exit(fail || traps ? 1 : 0);
