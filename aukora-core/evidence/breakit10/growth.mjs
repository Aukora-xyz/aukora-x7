// Mythos, defensive: does anything bound what a host can make the core hold? (staging via feed; the record via say)
import { readFileSync } from 'node:fs';
const V = 'v0.1/'; const mod = await WebAssembly.compile(readFileSync(V + 'aukora-core-lite.wasm')); const keys = readFileSync(V + 'fixtures/signed/keys.bin');
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
{ const api = (await WebAssembly.instantiate(mod, {})).exports; for (const b of keys) api.input(b); api.init();
  const chunk = 1 << 20; let fed = 0, last = 1, trap = null; const r0 = rss();
  try { for (let n = 0; n < 96 && last === 1; n++) { for (let i = 0; i < chunk; i++) api.input(i & 255); last = api.feed(); if (last === 1) fed += chunk; } } catch (e) { trap = String(e).slice(0, 80); }
  console.log(`feed: accepted ${fed >> 20} MiB of staged candidate bytes in 1 MiB chunks; last return ${last}; trap ${trap}; process memory ${r0} -> ${rss()} MiB`);
  let ok; try { ok = api.reset(); } catch (e) { ok = 'trap ' + e; } console.log('reset after staging returns', ok, '; head still readable:', api.head(0)); }
{ const api = (await WebAssembly.instantiate(mod, {})).exports; let n = 0, r = 1, trap = null;
  try { for (; n < 3_000_000 && r === 1; n++) r = api.input(n & 255); } catch (e) { trap = String(e).slice(0, 80); }
  console.log(`input before genesis: ${n - (r === 1 ? 0 : 1)} bytes accepted, then return ${r}; trap ${trap}`); }
