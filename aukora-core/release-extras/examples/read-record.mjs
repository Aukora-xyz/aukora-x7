// A bare reader: replay a record in the small core and print its head. No adapter, no keys, no dependencies.
// Usage (from the tree root): node examples/read-record.mjs examples/sample-record.txt [core.wasm]
import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
const PIN = '2f10eb8fd9adb3f25d854b642bba29ceaadcbcb2cc40a2fb05fca51f770b59e9';
const bytes = readFileSync(process.argv[3] ?? new URL('../v0.8/aukora-core-lite.wasm', import.meta.url));
if (createHash('sha256').update(bytes).digest('hex') !== PIN) { console.log('not the pinned core file: refusing to run it'); process.exit(1); }
const api = (await WebAssembly.instantiate(bytes, {})).instance.exports;      // the file imports nothing
const lines = readFileSync(process.argv[2], 'utf8').trim().split('\n');
if (lines[0] !== 'aukora-record v0.1') { console.log('not a record'); process.exit(1); }
const feed = hex => { for (const b of Buffer.from(hex, 'hex')) api.input(b); };
const hex32 = f => Array.from({ length: 32 }, (_, i) => f(i).toString(16).padStart(2, '0')).join('');
feed(lines[1]); if (api.init() !== 1) { console.log('the start is refused'); process.exit(1); }
lines.slice(2).forEach((line, n) => { feed(line); if (api.step() !== 1) { console.log(`line ${n + 1} is refused by the core`); process.exit(1); } });
console.log(`replays: ${lines.length - 2} lines\nhead ${hex32(api.head)}\nlaw identity ${hex32(api.lawByte)}`);
