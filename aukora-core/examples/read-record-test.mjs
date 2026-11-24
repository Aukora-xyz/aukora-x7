// Dependency-free reader checks; disposable records stay in one temporary folder.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, escapeText } from './read-record-display.mjs';
import { intentBytes } from '../standalone/aukora.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const sample = readFileSync(new URL('./sample-record.txt', import.meta.url), 'utf8');
const head = readFileSync(new URL('./sample-record.head', import.meta.url), 'utf8').trim();
const delivery = 'deliver "send the weekly report to the team", audience "mail", generation 0, nonce 1';
const sampleFrames = [
  'frame 1: statement: "a sample record: every line below was admitted by the core"',
  `frame 2: owner approval (both signatures, one use): ${delivery}, through frame 6 inclusive`,
  `frame 3: direct act: ${delivery}`,
  `frame 4: reported outcome: confirmed; ${delivery}`,
  'frame 5: statement: "the end"',
];
function framesMatch(stdout, frames, prefix = '') {
  const actual = stdout.split('\n').filter(line => /^(?:UNVERIFIED )?frame /.test(line));
  return actual.join('\n') === frames.map(line => prefix + line).join('\n');
}
function statement(words) {
  const bytes = Buffer.from(words);
  const header = Buffer.alloc(44); // statement envelope, tag, then the UTF-8 byte count
  header.writeUInt16LE(bytes.length, 42);
  return Buffer.concat([header, bytes]);
}
const dir = mkdtempSync(join(tmpdir(), 'aukora-reader-'));
const run = (...args) => spawnSync(process.execPath, ['examples/read-record.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
const report = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) process.exitCode = 1;
};
const check = (label, result, predicate) => {
  const ok = !result.error && result.signal === null && predicate(result);
  report(label, ok);
  if (!ok) console.log(result.error ?? `${result.status}: ${result.stdout}${result.stderr}`);
};
try {
  const source = readFileSync(new URL('./read-record.mjs', import.meta.url), 'utf8');
  const header = source.match(/^(?:\/\/[^\n]*\n)+/)?.[0] ?? '';
  const codes = Array.from(header.matchAll(/^\/\/ (\d+) = .+$/gm), match => match[1]);
  report('reader header lists every exit code', codes.join(' ') === '0 1 2 3 4 5 64');
  const args = ['--expect-head', head];
  const matched = run('examples/sample-record.txt', ...args);
  check('sample matches its expected head', matched, r =>
    r.status === 0 && r.stdout.includes('head matches the expected head') &&
    framesMatch(r.stdout, sampleFrames));
  check('sample frame 2 approval says one use', matched, r => /^frame 2: .*one use.*$/m.test(r.stdout));
  const changed = sample.trim().split('\n');
  const frame = Buffer.from(changed[2], 'hex'); frame[frame.length - 1] ^= 1;
  changed[2] = frame.toString('hex');
  const changedFile = join(dir, 'changed.txt'); writeFileSync(changedFile, changed.join('\n') + '\n');
  check('changed frame cannot match', run(changedFile, ...args), r =>
    r.status === 4 && r.stdout === 'frame 2 is refused by the core\n' && !r.stderr);
  const shorterFile = join(dir, 'shorter.txt'); writeFileSync(shorterFile, sample.trim().split('\n').slice(0, -1).join('\n') + '\n');
  const shorter = run(shorterFile, ...args);
  check('shorter valid record has a head mismatch', shorter, r =>
    r.status === 3 && r.stdout.startsWith(`HEAD MISMATCH: expected ${head} but this replay ends at `) &&
    r.stdout.includes('after 4 frames (a shorter or changed record, or a wrong expected head)') && !r.stdout.includes('head matches'));
  check('shorter record labels every frame UNVERIFIED', shorter, r =>
    framesMatch(r.stdout, sampleFrames.slice(0, -1), 'UNVERIFIED '));
  const wrongHead = '0'.repeat(64);
  check('unchanged sample with a wrong expected head exits 3', run('examples/sample-record.txt', '--expect-head', wrongHead), r =>
    r.status === 3 && r.stdout.startsWith(`HEAD MISMATCH: expected ${wrongHead} but this replay ends at ${head} after 5 frames (a shorter or changed record, or a wrong expected head)\n`) &&
    framesMatch(r.stdout, sampleFrames, 'UNVERIFIED '));
  const missing = run('examples/sample-record.txt');
  check('missing expected head exits 2', missing, r =>
    r.status === 2 && r.stdout.includes('no expected head was given') && r.stdout.includes(`head ${head}`) &&
    r.stdout.includes('examples/sample-record.head') && r.stdout.includes('RELEASE.json') && !r.stdout.includes('head matches'));
  check('missing expected head labels every frame UNVERIFIED', missing, r =>
    framesMatch(r.stdout, sampleFrames, 'UNVERIFIED '));
  const sampleLines = sample.trimEnd().split('\n');
  const last = sampleLines.length;
  const recordFile = join(dir, 'record.txt');
  for (const [label, record, reason] of [
    ['dangling nibble', sampleLines.join('\n') + 'a', `line ${last} is not complete hex`],
    ['leading blank line', '\n' + sample, 'bad header'],
    ['header with extra space', ' ' + sample, 'bad header'],
    ['non-hex suffix', sampleLines.join('\n') + 'zz\n', `line ${last} is not complete hex`],
    ['extra trailing newline', sample + '\n', `line ${last + 1} is not complete hex`],
    ['empty frame line', sampleLines.toSpliced(3, 0, '').join('\n'), 'line 4 is not complete hex'],
    ['header alone', sampleLines[0] + '\n', 'missing start'],
    ['malformed hex checked before replay', sampleLines[0] + '\n00\nx', 'line 3 is not complete hex'],
  ]) {
    writeFileSync(recordFile, record);
    check(label, run(recordFile, ...args), r => r.status === 1 && !r.stdout && r.stderr === `malformed record: ${reason}\n`);
  }
  writeFileSync(recordFile, sampleLines[0] + '\n00\n');
  check('refused start exits 4', run(recordFile, ...args), r =>
    r.status === 4 && r.stdout === 'the start is refused\n' && !r.stderr);
  writeFileSync(recordFile, [sampleLines[0], ...sampleLines.slice(1).map(line => line.toUpperCase())].join('\n'));
  check('uppercase hex and no trailing newline replay', run(recordFile, ...args), r => r.status === 0 && r.stdout === matched.stdout);
  for (const file of [join(dir, 'missing'), dir]) {
    check(file === dir ? 'unreadable record' : 'missing record', run(file, ...args), r =>
      r.status === 1 && !r.stdout && r.stderr === 'cannot read record file\n');
  }
  for (const [label, options] of [
    ['bad expected head', ['--expect-head', 'g'.repeat(64)]],
    ['unknown option', ['--unknown']],
    ['repeated expected head', [...args, ...args]],
    ['repeated core', ['--core', 'v0.8/aukora-core-lite.wasm', '--core', 'v0.8/aukora-core-lite.wasm']],
  ]) {
    check(`${label} exits 64`, run('examples/sample-record.txt', ...options), r => r.status === 64 && !r.stdout && r.stderr.startsWith('usage:'));
  }
  const escaped = escapeText('\u202e\u200b');
  report('display escapes direction overrides and invisible characters',
    escaped === '"\\u202e\\u200b"' && !/[\u202e\u200b]/.test(escaped));
  report('display escapes non-ASCII UTF-16 code units',
    escapeText(' ~\u007f\u00e9\ud83d\ude00') === '" ~\\u007f\\u00e9\\ud83d\\ude00"');
  const described = describe(statement('\u202e\u200b'));
  report('statement renders both escapes without raw invisible characters',
    described === 'statement: "\\u202e\\u200b"' && !/[\u202e\u200b]/.test(described));
  const limit = 'a'.repeat(120);
  report('statement caps displayed text and counts original UTF-8 bytes',
    describe(statement(limit)) === `statement: "${limit}"` &&
    describe(statement(limit + 'é')) === `statement: "${limit}"… (122 bytes in all)`);
  const timedHeader = Buffer.from(sampleLines[3], 'hex').subarray(0, 49);
  const binary = intentBytes({ payload: Buffer.alloc(61, 255), audience: 'mail', nonce: 1 });
  report('binary preview leaves the audience, nonce and expiry visible',
    describe(Buffer.concat([timedHeader, binary])) ===
    `owner approval (both signatures, one use): deliver hex ${'ff'.repeat(60)}… (61 bytes in all), audience "mail", generation 0, nonce 1, through frame 6 inclusive`);
  check('explicit pinned v0.8 core matches', run('examples/sample-record.txt', ...args, '--core', 'v0.8/aukora-core-lite.wasm'), r =>
    r.status === 0 && r.stdout === matched.stdout);
  check('unreadable core exits 5', run('examples/sample-record.txt', ...args, '--core', join(dir, 'missing')), r =>
    r.status === 5 && !r.stdout && r.stderr === 'cannot read core file\n');
  check('different Wasm is refused by the pin', run('examples/sample-record.txt', ...args, '--core', 'v0.8/aukora-core.wasm'), r =>
    r.status === 5 && r.stdout.trim() === 'not the pinned core file: refusing to run it');
} finally { rmSync(dir, { recursive: true, force: true }); }
