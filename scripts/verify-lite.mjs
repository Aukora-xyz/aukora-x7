#!/usr/bin/env node
// verify-lite: one command, no install.
//
//   node scripts/verify-lite.mjs
//
// Runs a fixed set of test files with Node's own test runner, one file at a time. Every file in the
// default set imports only Node's standard library and files inside this repository, and none of them
// starts a program other than Node, so a fresh copy of the repository and Node 24.9 or newer are enough.
//
// Each file runs under a 60 second limit. A file that outlives it is killed (with every process it
// started) and counted as one more failure.
//
// What a test may touch is enforced, not only promised:
//   - Node's permission model (--permission) lets each test read only this repository and one fresh
//     folder under the system temp folder, and write only that temp folder. Node passes these limits
//     on to any Node process a test starts. No worker threads, no native addons, no WASI.
//   - A small preload refuses every outgoing or listening socket, UDP socket and DNS lookup in the
//     test process. (Node 24's permission model has no network switch, so this is a guard in
//     JavaScript, not an operating-system sandbox.)
//   - The environment of each test is rebuilt from scratch: PATH, the temp folder, HOME pointed at the
//     temp folder, TZ=UTC, LANG=C. NODE_OPTIONS and every other variable from your shell are dropped.
// The script itself reads only inside this repository (docs/KNOWN-RED-TESTS.md; it also checks that the
// listed test files and, for --with-packages, the packages under node_modules/ exist). It writes only
// its temp folder, which it removes at the end, also when it is stopped with Ctrl-C.
//
// Output: one line per file (status, path, pass, fail) on stdout, then one summary line:
//
//   verify-lite: N files, P pass, F fail, K of F on the known-red list
//
// The failures of each file are compared with that file's row in docs/KNOWN-RED-TESTS.md. The list
// gives counts, not test names, so the comparison is by count per file. The exit code is 0 only when
// every failure is on the list; 1 otherwise; 2 when the check could not start.
//
// Options:
//   --times          also print the seconds per file and in total, on stderr (stdout stays identical)
//   --with-packages  UNVERIFIED. Also run the authority tests. They import npm packages that this
//                    repository does not ship, so they run only when those packages are installed in
//                    this repository's own node_modules folder. This tier has not been run from a clean
//                    install by the authors of this script.
//
// This is a smoke check of 22 files. It is not the full suite and by default it does not test the
// authority rule.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const LIMIT_MS = 60_000;
const MIN_NODE = [24, 9]; // package.json "engines": ">=24.9.0". Tried on 24.11.1 only.

// Default set: Node standard library and in-repository imports only; no program other than Node is
// started; nothing is written inside the repository.
const DEFAULT_SET = [
  'deploy/ci/mirror-copy.test.mjs',
  'deploy/ci/observe-verdict.test.mjs',
  'deploy/ci/workflow-credentials.test.mjs',
  'deploy/cloudflare/src/__tests__/cloud-model-door.test.mjs',
  'deploy/cloudflare/src/__tests__/provider-dispatch.test.mjs',
  'deploy/cloudflare/src/__tests__/rescue-complete.test.mjs',
  'deploy/cloudflare/src/__tests__/rescue-guard.test.mjs',
  'deploy/cloudflare/src/__tests__/rescue-pack.test.mjs',
  'deploy/cloudflare/src/__tests__/rescue-page.test.mjs',
  'deploy/cloudflare/src/__tests__/shared-call.test.mjs',
  'deploy/cloudflare/src/__tests__/speech-pass-clauses.test.mjs',
  'deploy/cloudflare/src/__tests__/vault-hold.test.mjs',
  'deploy/cloudflare/src/__tests__/vault.test.mjs',
  'deploy/cloudflare/src/__tests__/voice-director-hardening.test.mjs',
  'server/asset-cache.test.mjs',
  'server/aura-focus-cell-shadow.test.mjs',
  'server/aura-focus-shadow.test.mjs',
  'server/aura.test.mjs',
  'server/memory.test.mjs',
  'server/pearl.test.mjs',
  'server/predict.test.mjs',
  'server/receipts-policy.test.mjs',
];
// Left out on purpose, although they need no package:
//   deploy/ci/scrub-gate, server/gate-audit: they start the git program, so they need more than Node.
//   deploy/ci/built-notice-check: it writes a folder inside the repository while it runs.
//   deploy/ci/signed-out-verdict: it reads a Node child's output as JSON, and under the permission
//     model that child prints a security warning first, so one case fails here and nowhere else.
//   server/absence: three cases look at folders above the repository (to refuse a symbolic link in
//     the path), which the read limit forbids, so they fail here and nowhere else.
//   deploy/ci/deploy-guard, deploy/cloudflare/src/__tests__/rescue-keep: they pass, but take about
//     20 seconds each, and the whole check is meant to finish within a minute.

// UNVERIFIED tier: chosen by reading imports only. Needs the packages below, pinned in package.json.
const PACKAGE_SET = [
  'deploy/cloudflare/src/__tests__/night-grant.test.mjs',
  'deploy/cloudflare/src/__tests__/organ-set-rule.test.mjs',
  'deploy/cloudflare/src/__tests__/organ-set.test.mjs',
  'deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs',
  'deploy/cloudflare/src/__tests__/convergence-policy.test.mjs',
  'deploy/cloudflare/src/__tests__/proof-failure-rule.test.mjs',
  'deploy/cloudflare/src/__tests__/signed-action-and-lockout.test.mjs',
  'deploy/cloudflare/src/__tests__/signed-head-actions.test.mjs',
  'deploy/cloudflare/src/__tests__/head-hardening.test.mjs',
  'deploy/cloudflare/src/__tests__/head-reconcile.test.mjs',
  'deploy/cloudflare/src/__tests__/head-sync-mirror-copy.test.mjs',
  'deploy/cloudflare/src/__tests__/receipts-sync.test.mjs',
  'deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs',
  'server/ball-manifest.test.mjs',
  'server/receipts.test.mjs',
  'server/recall.test.mjs',
];
const PACKAGES = ['@noble/curves', '@noble/post-quantum', '@scure/base', '@simplewebauthn/server', 'typescript'];

// Loaded into every test process before the test file. Refuses network use.
const NETWORK_GUARD = `
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
const refuse = () => { const e = new Error('verify-lite: network use is refused in this check'); e.code = 'VERIFY_LITE_NO_NETWORK'; throw e; };
net.Socket.prototype.connect = refuse;
net.Server.prototype.listen = refuse;
dgram.Socket.prototype.bind = refuse;
dgram.Socket.prototype.send = refuse;
dgram.Socket.prototype.connect = refuse;
for (const name of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) { dns[name] = refuse; dns.promises[name] = refuse; }
`;

const args = process.argv.slice(2);
const known = new Set(['--times', '--with-packages']);
const unknown = args.filter(arg => !known.has(arg));
if (unknown.length) {
  console.error(`verify-lite: unknown option ${unknown.join(' ')}. Options: --times, --with-packages.`);
  process.exit(2);
}
const showTimes = args.includes('--times');
const withPackages = args.includes('--with-packages');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
  console.error(`verify-lite: needs Node ${MIN_NODE.join('.')}.0 or newer (package.json "engines"); this is ${process.version}.`);
  process.exit(2);
}

// Failing counts per file from docs/KNOWN-RED-TESTS.md: a table row whose first cell is a file path in
// backticks and whose second cell starts with a number ("9", "6 of 68", "1 (...)").
function readKnownRed() {
  const listed = new Map();
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, 'docs', 'KNOWN-RED-TESTS.md'), 'utf8');
  } catch {
    console.log('verify-lite: docs/KNOWN-RED-TESTS.md is missing, so no failure can be on the list.');
    return listed;
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    const file = /^`([^`]+)`$/.exec(cells[0] ?? '')?.[1];
    const count = /^(\d+)\b/.exec(cells[1] ?? '')?.[1];
    if (file && count !== undefined) listed.set(file, Number(count));
  }
  return listed;
}

// A package counts as installed only when it sits in this repository's own node_modules folder.
function firstMissingPackage() {
  return PACKAGES.find(name => !fs.existsSync(path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json'))) ?? null;
}

let current = null; // the running child, so a stop signal can take its whole process group down
function killGroup(child) {
  if (!child?.pid) return;
  // The child leads its own process group, so -pid reaches every process it started in that group.
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* group already gone */ }
}

function runOne(file, tmp) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [
      '--permission',
      `--allow-fs-read=${ROOT}`,
      `--allow-fs-read=${tmp}`,
      `--allow-fs-write=${tmp}`,
      '--allow-child-process',
      '--no-warnings',
      `--import=data:text/javascript,${encodeURIComponent(NETWORK_GUARD)}`,
      '--test', '--test-reporter=tap', '--test-concurrency=1', '--test-isolation=none',
      file,
    ], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: tmp, TMPDIR: tmp, TMP: tmp, TEMP: tmp, TZ: 'UTC', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    current = child;
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    let timedOut = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      current = null;
      const seconds = (Date.now() - started) / 1000;
      // Read the runner's closing summary: the last "# pass N" and "# fail N" lines of the output.
      const read = name => { const all = [...out.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))]; return all.length ? Number(all.at(-1)[1]) : null; };
      const pass = read('pass');
      const failed = read('fail');
      const cancelled = read('cancelled') ?? 0;
      if (timedOut) return resolve({ file, pass: pass ?? 0, fail: (failed ?? 0) + cancelled + 1, seconds, note: `killed after ${LIMIT_MS / 1000} s` });
      if (pass === null || failed === null) return resolve({ file, pass: 0, fail: 1, seconds, note: 'no test summary was printed' });
      resolve({ file, pass, fail: failed + cancelled, seconds, note: '' });
    };
    let grace = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
      grace = setTimeout(finish, 2_000); // do not wait on pipes a stray process might still hold
    }, LIMIT_MS);
    child.on('error', () => { out += '\nverify-lite: the test process could not start'; finish(); });
    child.on('exit', () => {
      killGroup(child); // anything the test left running in its group goes with it
      if (!grace) grace = setTimeout(finish, 2_000);
    });
    child.on('close', finish);
  });
}

const knownRed = readKnownRed();
let files = [...DEFAULT_SET];
let packageNote = 'verify-lite: not run here, because they need npm packages: the authority tests (approval spent once, proof-failure rule, owner-only ids, night grant, the ball-transition classifier, the rollback gap reproduction). See docs/WHAT-IS-BUILT.md.';
if (withPackages) {
  const missing = firstMissingPackage();
  if (missing) {
    packageNote = `verify-lite: --with-packages not run: ${missing} is not in this repository's node_modules folder. The authority tests were not run.`;
  } else {
    files = [...files, ...PACKAGE_SET];
    packageNote = 'verify-lite: the UNVERIFIED authority tier was included. It has not been run from a clean install by the authors of this script.';
  }
}

const absent = files.filter(file => !fs.existsSync(path.join(ROOT, file)));
if (absent.length) {
  console.error(`verify-lite: ${absent.length} listed test file(s) are missing from this copy:\n  ${absent.join('\n  ')}`);
  process.exit(2);
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-lite-')));
const cleanUp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { killGroup(current); cleanUp(); process.exit(130); });
}

const started = Date.now();
let pass = 0;
let fail = 0;
let onList = 0;
for (const file of files) {
  const result = await runOne(file, tmp);
  pass += result.pass;
  fail += result.fail;
  const listed = knownRed.get(file) ?? 0;
  const covered = Math.min(result.fail, listed);
  onList += covered;
  let status = 'ok  ';
  let detail = '';
  if (result.fail > 0) {
    status = covered === result.fail ? 'red ' : 'FAIL';
    detail = listed
      ? `  (${covered} of ${result.fail} on the known-red list, list says ${listed})`
      : '  (not on the known-red list)';
  }
  if (result.note) detail += `  [${result.note}]`;
  console.log(`${status} ${file}  pass=${result.pass} fail=${result.fail}${detail}`);
  if (showTimes) console.error(`verify-lite: ${file} took ${result.seconds.toFixed(1)} s`);
}
cleanUp();

if (showTimes) console.error(`verify-lite: ${((Date.now() - started) / 1000).toFixed(1)} s in total`);
console.log(packageNote);
console.log(`verify-lite: ${files.length} files, ${pass} pass, ${fail} fail, ${onList} of ${fail} on the known-red list`);
process.exit(onList === fail ? 0 : 1);
