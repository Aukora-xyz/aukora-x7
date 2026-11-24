// A bare reader: replay a record, compare its head, and describe its frames. No keys, no dependencies.
// Usage (from the tree root): node examples/read-record.mjs <record> [--expect-head <64 hex characters>] [--core <wasm file>]
// Display decoding and escaping are in examples/read-record-display.mjs.
// Exit codes:
// 0 = replay matched the expected head
// 1 = unreadable or malformed record, or unexpected internal error
// 2 = replay succeeded without an expected head
// 3 = replay ended at a different head
// 4 = the core refused the start or a frame, or trapped during replay or display
// 5 = the core file failed its pin check or could not be loaded
// 64 = invalid command-line usage
import { describe } from './read-record-display.mjs';
import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
const usage = () => { console.error('usage: node examples/read-record.mjs <record> [--expect-head <64 hex characters>] [--core <wasm file>]'); process.exit(64); };
const args = process.argv.slice(2), record = args.shift();
let expected, core;
if (!record || record.startsWith('-')) usage();
while (args.length) {
  const arg = args.shift();
  if (arg === '--expect-head' && expected === undefined) {
    expected = args.shift();
    if (!/^[0-9a-fA-F]{64}$/.test(expected ?? '')) usage();
    expected = expected.toLowerCase();
  } else if (arg === '--core' && core === undefined) {
    core = args.shift();
    if (!core || core.startsWith('-')) usage();
  } else if (arg && !arg.startsWith('-') && core === undefined) core = arg; // Legacy positional core.
  else usage();
}
const PIN = '2f10eb8fd9adb3f25d854b642bba29ceaadcbcb2cc40a2fb05fca51f770b59e9';
function readFile(path, label, exitCode, encoding) {
  try { return readFileSync(path, encoding); }
  catch { console.error(`cannot read ${label} file`); process.exit(exitCode); }
}
function malformed(reason) {
  console.error(`malformed record: ${reason}`);
  process.exit(1);
}
async function loadCore(path) {
  const bytes = readFile(path, 'core', 5);
  if (createHash('sha256').update(bytes).digest('hex') !== PIN) {
    console.log('not the pinned core file: refusing to run it');
    process.exit(5);
  }
  try { return (await WebAssembly.instantiate(bytes, {})).instance.exports; } // the file imports nothing
  catch { console.error('cannot load core file'); process.exit(5); }
}
let frame = 0; // The start precedes frame 1.
try {
  const lines = readFile(record, 'record', 1, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop(); // Allow one terminal newline.
  if (lines[0] !== 'aukora-record v0.1') malformed('bad header');
  if (lines.length === 1) malformed('missing start');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].length % 2 || !/^[0-9a-fA-F]+$/.test(lines[i])) {
      malformed(`line ${i + 1} is not complete hex`);
    }
  }

  const api = await loadCore(core ?? new URL('../v0.8/aukora-core-lite.wasm', import.meta.url));
  const feed = hex => { for (const b of Buffer.from(hex, 'hex')) api.input(b); };
  const hex32 = f => Array.from({ length: 32 }, (_, i) => f(i).toString(16).padStart(2, '0')).join('');
  feed(lines[1]);
  if (api.init() !== 1) { console.log('the start is refused'); process.exit(4); }
  const frames = lines.slice(2);
  for (const line of frames) {
    frame++;
    feed(line);
    if (api.step() !== 1) { console.log(`frame ${frame} is refused by the core`); process.exit(4); }
  }
  const head = hex32(api.head);
  if (expected === undefined) {
    console.log('no expected head was given, so the reader cannot tell a complete record from a shorter valid one');
    console.log(`head ${head}`);
    console.log('For the shipped sample, use --expect-head "$(cat examples/sample-record.head)"; RELEASE.json also lists sample.head.');
    process.exitCode = 2;
  } else if (head !== expected) {
    console.log(`HEAD MISMATCH: expected ${expected} but this replay ends at ${head} after ${frames.length} frames (a shorter or changed record, or a wrong expected head)`);
    process.exitCode = 3;
  } else {
    console.log('head matches the expected head');
    console.log(`replays: ${frames.length} lines\nhead ${head}\nlaw identity ${hex32(api.lawByte)}`);
  }
  for (const [index, line] of frames.entries()) {
    frame = index + 1;
    console.log(`${head === expected ? '' : 'UNVERIFIED '}frame ${frame}: ${describe(Buffer.from(line, 'hex'))}`);
  }
} catch (error) {
  if (error instanceof WebAssembly.RuntimeError) {
    console.error(`the core trapped at frame ${frame} (long records can trap; see "Open defects" in the README)`);
    process.exitCode = 4;
  } else {
    console.error(`internal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
