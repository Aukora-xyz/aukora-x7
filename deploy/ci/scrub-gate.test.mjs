import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import test from 'node:test';
import { HOME_PREFIX, MACHINE_USER } from './forbidden.mjs';
import { inspectBytes, loadHistory, scanBundle, scanSource, scanShipped, scrubReasons } from './scrub-gate.mjs';

const script = fileURLToPath(new URL('./scrub-gate.mjs', import.meta.url));
const machinePath = `${HOME_PREFIX}${MACHINE_USER}/private-workspace`;
const spatialTemplate = `${HOME_PREFIX}name/my-plugin`;
const spatialSource = 'packages/client/ui-plugin-manager/src/client/locales.ts';
const spatialTest = 'apps/web/tests/plugin-manager.e2e.ts';
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
// Fixture repositories live under the CI runner's temp directory, or under an
// explicit scratch directory locally (SCRUB_TEST_TMPDIR), else the OS default.
const fixtureBase = process.env.SCRUB_TEST_TMPDIR || process.env.RUNNER_TEMP || tmpdir();
const git = (root, ...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root }).toString('utf8').trim();
const spatialModule = 'node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js';

function fixture(t) {
  mkdirSync(fixtureBase, { recursive: true });
  const root = mkdtempSync(join(fixtureBase, 'x61-scrub-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  function put(path, bytes) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  put('deploy/cloudflare/wrangler.toml', 'name = "fixture"\n\n[assets]\ndirectory = "../../dist"\nbinding = "ASSETS"\n\n[vars]\nPUBLIC_HOST = "fixture.invalid"\n');
  put('dist/preview/vfs-image.tar.gz', gzipSync(Buffer.alloc(1024)));
  return { root, put };
}

function tarMember(path, content) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100);
  header.write('0000644\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  header.write('00000000000\0', 136, 12);
  header.fill(32, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257, 6);
  header.write('00', 263);
  const sum = header.reduce((n, byte) => n + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]);
}

function run(root, mode) {
  return spawnSync(process.execPath, [script, '--root', root, mode], { encoding: 'utf8' });
}

test('source deploy gate refuses personal paths beyond the former two-megabyte cutoff without echoing them', t => {
  const { root, put } = fixture(t);
  put('src/large.js', `${' '.repeat(2_100_000)}\nexport const leaked = ${JSON.stringify(machinePath)};`);
  const result = run(root, '--source');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/large\.js: machine-home-root/);
  assert.match(result.stderr, /src\/large\.js: machine-account/);
  assert.ok(!result.stderr.includes(machinePath));
});

test('shipped deploy gate inflates the VFS and refuses an unsafe member beyond the former size cutoff', t => {
  const { root, put } = fixture(t);
  put('dist/preview/vfs-image.tar.gz', gzipSync(tarMember('home/auma/AGENTS.md', `${' '.repeat(2_100_000)}\n${machinePath}`)));
  const result = run(root, '--dist');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /vfs-image\.tar\.gz!gunzip: machine-home-root/);
});

test('compressed members nested inside the actual VFS tar are inflated and checked', t => {
  const { root, put } = fixture(t);
  for (const [name, content] of [
    ['nested.json.gz', gzipSync(Buffer.from(machinePath))],
    ['nested.json.br', brotliCompressSync(Buffer.from(machinePath))],
    ['nested.tar.gz', gzipSync(tarMember('inner/AGENTS.md', machinePath))],
  ]) {
    put('dist/preview/vfs-image.tar.gz', gzipSync(tarMember(name, content)));
    const result = run(root, '--dist');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /!member\/nested\./);
    assert.match(result.stderr, /machine-home-root/);
  }
});

test('recognized tar archives fail closed on invalid checksums, truncation, or missing end blocks', t => {
  const { root, put } = fixture(t);
  const valid = tarMember('clean.txt', 'clean');
  const wrongChecksum = Buffer.from(valid);
  wrongChecksum[0] ^= 1;
  for (const invalid of [wrongChecksum, valid.subarray(0, 600), valid.subarray(0, valid.length - 1024), Buffer.from('not a tar archive')]) {
    put('dist/preview/vfs-image.tar.gz', gzipSync(invalid));
    const result = run(root, '--dist');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SCRUB_TAR_/);
  }
});

test('personal account names in source and served filenames are refused without printing the account', t => {
  const { root, put } = fixture(t);
  put(`src/${MACHINE_USER}.js`, 'export const value = 1;');
  put(`dist/${MACHINE_USER}.js`, 'export const value = 1;');
  for (const mode of ['--source', '--dist']) {
    const result = run(root, mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /path-machine-account/);
    assert.ok(!result.stderr.toLowerCase().includes(MACHINE_USER));
  }
});

test('a dangling source symlink cannot hide an absolute machine target', t => {
  const { root } = fixture(t);
  symlinkSync(machinePath, join(root, 'machine-link'));
  assert.ok(scanSource(root).hits.some(hit => hit.path === 'machine-link' && hit.reason === 'machine-home-root'));
});

test('shipped deploy gate scans raw bundles, Wasm data bytes, and gzip siblings', t => {
  const { root, put } = fixture(t);
  put('dist/worker.js', JSON.stringify(machinePath));
  put('dist/cell.wasm', Buffer.concat([Buffer.from([0, 97, 115, 109]), Buffer.from(`\0${machinePath}`)]));
  put('dist/extra.json.gz', gzipSync(Buffer.from(JSON.stringify({ path: machinePath }))));
  const { hits } = scanShipped(root);
  for (const name of ['dist/worker.js', 'dist/cell.wasm', 'dist/extra.json.gz!gunzip']) {
    assert.ok(hits.some(hit => hit.path === name && hit.reason === 'machine-home-root'));
  }
});

test('source history exceptions are exact-byte, commit-anchored, reasoned and cannot exempt deployed VFS bytes', t => {
  const { root, put } = fixture(t);
  const history = Buffer.from(`Historical observation: ${machinePath}`);
  put('history/old.md', history);
  git(root, 'add', 'history/old.md');
  git(root, 'commit', '-q', '-m', 'record history');
  const commit = git(root, 'rev-parse', 'HEAD');
  const sha256 = createHash('sha256').update(history).digest('hex');
  const reason = 'Immutable imported incident evidence, kept only in source history and never admitted to deployed artifacts.';
  put('deploy/ci/scrub-history.json', JSON.stringify({ version: 2, history: [{ reason, files: { 'history/old.md': { sha256, commit } } }] }));
  assert.deepEqual(scanSource(root).hits, []);
  put('dist/preview/vfs-image.tar.gz', gzipSync(tarMember('history/old.md', history)));
  assert.ok(scanShipped(root).hits.length > 0);
  // The same bytes claimed at a commit that never recorded them are refused.
  git(root, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
  const parent = git(root, 'rev-parse', 'HEAD~1');
  put('other/old.md', history);
  put('deploy/ci/scrub-history.json', JSON.stringify({ version: 2, history: [{ reason, files: { 'history/old.md': { sha256, commit: parent }, 'other/old.md': { sha256, commit: parent } } }] }));
  assert.ok(scanSource(root).hits.some(hit => hit.path === 'other/old.md' && hit.reason === 'history-commit-mismatch'));
  assert.ok(!scanSource(root).hits.some(hit => hit.path === 'history/old.md'));
  put('history/old.md', `${history}\nchanged`);
  assert.ok(scanSource(root).hits.some(hit => hit.path === 'history/old.md' && hit.reason === 'history-bytes-changed'));
});

test('history allowlist refuses wildcards, legacy unanchored entries and short reasons', t => {
  const { root, put } = fixture(t);
  const sha256 = 'a'.repeat(64);
  const commit = 'b'.repeat(40);
  const reason = 'A sufficiently long and specific historical justification.';
  for (const [body, code] of [
    [{ version: 1, history: [{ reason, files: { 'docs/x.md': sha256 } }] }, /SCRUB_HISTORY_SCHEMA/],
    [{ version: 2, history: [{ reason, files: { 'docs/*.md': { sha256, commit } } }] }, /SCRUB_HISTORY_ENTRY/],
    [{ version: 2, history: [{ reason, files: { 'docs/x.md': sha256 } }] }, /SCRUB_HISTORY_ENTRY/],
    [{ version: 2, history: [{ reason, files: { 'docs/x.md': { sha256, commit: 'HEAD' } } }] }, /SCRUB_HISTORY_ENTRY/],
    [{ version: 2, history: [{ reason, files: { '../x.md': { sha256, commit } } }] }, /SCRUB_HISTORY_ENTRY/],
    [{ version: 2, history: [{ reason: 'too short', files: {} }] }, /SCRUB_HISTORY_REASON/],
  ]) {
    put('deploy/ci/scrub-history.json', JSON.stringify(body));
    assert.throws(() => loadHistory(root), code);
  }
});

test('the history allowlist is empty in aukora-x7, and any entry added later must name one path, its bytes and a full commit', () => {
  const history = loadHistory(repoRoot);
  assert.equal(history.size, 0, 'aukora-x7 starts with no history and therefore no scrub exemptions');
  for (const [path, entry] of history) {
    assert.ok(!/[*?]/.test(path), path);
    assert.match(entry.commit, /^[a-f0-9]{40}$/);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  }
});

test('the shipped directory is read from the wrangler.toml assets table', t => {
  const { root, put } = fixture(t);
  put('dist/clean.txt', 'clean');
  assert.equal(scanShipped(root).stats.files, 2);
  put('deploy/cloudflare/wrangler.toml', '[vars]\ndirectory = "../../dist"\n');
  assert.throws(() => scanShipped(root), /SCRUB_ASSETS_DIRECTORY_MISSING/);
  put('deploy/cloudflare/wrangler.toml', '[assets]\ndirectory = "../../../outside"\n');
  assert.throws(() => scanShipped(root), /SCRUB_ASSETS_OUTSIDE_REPOSITORY/);
});

test('the Wrangler bundle scan refuses machine paths in the uploaded Worker script and a missing bundle', t => {
  const { root, put } = fixture(t);
  assert.throws(() => scanBundle(root, 'worker-bundle'), /SCRUB_BUNDLE_MISSING/);
  put('worker-bundle/worker.js', 'export default { fetch() {} }');
  assert.deepEqual(scanBundle(root, 'worker-bundle').hits, []);
  put('worker-bundle/worker.js.map', JSON.stringify({ sources: [`file://${machinePath}`] }));
  const result = spawnSync(process.execPath, [script, '--root', root, '--bundle', 'worker-bundle'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /worker-bundle\/worker\.js\.map: machine-home-root/);
  assert.ok(!result.stderr.includes(machinePath));
});

test('only Spatial source and its matching test preserve the exact quoted install template', t => {
  const { root, put } = fixture(t);
  put(spatialSource, `export const INSTALL_PATH_EXAMPLE = '${spatialTemplate}'`);
  put(spatialTest, `['${spatialTemplate}', 'template hint']`);
  assert.deepEqual(scanSource(root).hits, []);
  put('src/unrelated.js', JSON.stringify(spatialTemplate));
  assert.ok(scanSource(root).hits.some(hit => hit.path === 'src/unrelated.js' && hit.reason === 'machine-home-root'));
});

test('the preserved Spatial template cannot exempt real paths or altered examples in its source', t => {
  const { root, put } = fixture(t);
  for (const path of [
    machinePath,
    `${HOME_PREFIX}other/my-plugin`,
    `${spatialTemplate}-private`,
    `${spatialTemplate}/private`,
    `file://${spatialTemplate}`,
    encodeURIComponent(spatialTemplate),
    spatialTemplate.toLowerCase(),
    spatialTemplate.toUpperCase(),
  ]) {
    put(spatialSource, `const template = '${spatialTemplate}'; const real = '${path}';`);
    assert.ok(scanSource(root).hits.some(hit => hit.reason === 'machine-home-root'));
  }
  put(spatialSource, spatialTemplate);
  assert.ok(scanSource(root).hits.some(hit => hit.reason === 'machine-home-root'));
});

test('shipped VFS exception is confined to the owning Spatial module and exact literal', t => {
  const { root, put } = fixture(t);
  const module = `install.spec === ${JSON.stringify(spatialTemplate)} ? t('installPathTemplateHint') : null`;
  put('dist/preview/vfs-image.tar.gz', gzipSync(tarMember(spatialModule, module)));
  assert.deepEqual(scanShipped(root).hits, []);
  put('dist/preview/vfs-image.tar.gz', gzipSync(tarMember('home/auma/AGENTS.md', module)));
  assert.ok(scanShipped(root).hits.some(hit => hit.path.includes('!member/home/auma/AGENTS.md') && hit.reason === 'machine-home-root'));
  put('dist/preview/vfs-image.tar.gz', gzipSync(tarMember(spatialModule, `${module}; const real = ${JSON.stringify(machinePath)}`)));
  assert.ok(scanShipped(root).hits.some(hit => hit.reason === 'machine-home-root'));
  put('dist/preview/vfs-image.tar.gz', gzipSync(tarMember(spatialTemplate, 'clean')));
  assert.ok(scanShipped(root).hits.some(hit => hit.reason === 'path-machine-home-root'));
});

test('missing image and corrupt compressed bytes fail the deployed check', t => {
  const { root, put } = fixture(t);
  rmSync(join(root, 'dist/preview/vfs-image.tar.gz'));
  assert.equal(run(root, '--dist').status, 1);
  put('dist/preview/vfs-image.tar.gz', Buffer.from([0x1f, 0x8b, 0]));
  assert.equal(run(root, '--dist').status, 1);
  put('dist/preview/vfs-image.tar.gz', '');
  assert.equal(run(root, '--dist').status, 1);
});

test('escaped serialized paths are checked while HTTP endpoints and nested Windows segments remain distinct', () => {
  const escaped = machinePath.replaceAll('/', '\\/').replace('U', '\\u0055');
  assert.ok(scrubReasons(Buffer.from(escaped)).includes('machine-home-root'));
  assert.ok(scrubReasons(Buffer.from(`file://${machinePath}`)).includes('machine-home-root'));
  assert.ok(scrubReasons(Buffer.from(`file://localhost${machinePath}`)).includes('machine-home-root'));
  assert.ok(scrubReasons(Buffer.from(`path:${HOME_PREFIX}sample/workspace`)).includes('machine-home-root'));
  assert.ok(scrubReasons(Buffer.from(`${HOME_PREFIX}sample/workspace`.replaceAll('/', '\\x2f'))).includes('machine-home-root'));
  const windows = ['C:', 'Users', 'sample', 'file'].join('/');
  assert.deepEqual(scrubReasons(Buffer.from(`https://example.org/users/current https://example.org${HOME_PREFIX}sample ${windows}`)), []);
});

test('inline source maps are decoded before inspecting shipped bundles', t => {
  const { root, put } = fixture(t);
  const map = JSON.stringify({ version: 3, sources: [`file://${machinePath}`], mappings: '' });
  put('dist/inline.js', `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(map).toString('base64')}`);
  put('dist/encoded.js', `//# sourceMappingURL=data:application/json,${encodeURIComponent(map)}`);
  const { hits } = scanShipped(root);
  for (const name of ['dist/inline.js!source-map-0', 'dist/encoded.js!source-map-0']) {
    assert.ok(hits.some(hit => hit.path === name && hit.reason === 'machine-home-root'));
  }
});

test('source and shipped gates refuse home-path case variants, APFS aliases and URI encoding', t => {
  const { root, put } = fixture(t);
  const home = `${HOME_PREFIX}fixture/private-workspace`;
  for (const value of [
    home.toLowerCase(),
    home.toUpperCase(),
    `/System/Volumes/Data${home}`,
    `/System/Volumes/Data${home}`.toLowerCase(),
    `file://${encodeURIComponent(home)}`,
    `file://localhost${home.replace('U', '%55')}`,
    encodeURIComponent(`/System/Volumes/Data${home}`),
  ]) {
    put('src/alias.js', JSON.stringify(value));
    put('dist/preview/vfs-image.tar.gz', gzipSync(tarMember('home/auma/alias.json', JSON.stringify(value))));
    for (const mode of ['--source', '--dist']) {
      const result = run(root, mode);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /machine-home-root/);
      assert.ok(!result.stderr.includes(value));
    }
  }
  const endpoint = `https://example.org/System/Volumes/Data${home}`;
  assert.deepEqual(scrubReasons(Buffer.from(endpoint)), []);
  assert.deepEqual(scrubReasons(Buffer.from(encodeURI(endpoint))), []);
  const collection = HOME_PREFIX.toLowerCase();
  assert.deepEqual(scrubReasons(Buffer.from(`route ${collection}:userID? and "${collection}"`)), []);
  assert.ok(scrubReasons(Buffer.from(`route ${collection}fixture/private`)).includes('machine-home-root'));
  assert.ok(scrubReasons(Buffer.from(`file://${collection}`)).includes('machine-home-root'));
});

test('Unicode prefixes preserve path offsets in source and shipped deploy gates', t => {
  const { root, put } = fixture(t);
  const expanding = String.fromCodePoint(0x130);
  assert.equal(expanding.toLowerCase().length, 2);
  const home = `${HOME_PREFIX}fixture/private`;
  for (const value of [
    `${expanding} ${home}`,
    `${expanding.repeat(12)} ${home.toLowerCase()}`,
    `${expanding} /System/Volumes/Data${home.toUpperCase()}`,
    `\\u0130 ${encodeURIComponent(home)}`,
  ]) {
    put('src/unicode.js', JSON.stringify(value));
    put('dist/preview/vfs-image.tar.gz', gzipSync(tarMember('home/auma/unicode.json', JSON.stringify(value))));
    for (const mode of ['--source', '--dist']) {
      const result = run(root, mode);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /machine-home-root/);
      assert.ok(!result.stderr.includes(home));
    }
  }
  assert.deepEqual(scrubReasons(Buffer.from(`${expanding} https://example.org${home} C:${home}`)), []);
});

test('clean source and shipped VFS produce a successful command exit', t => {
  const { root, put } = fixture(t);
  put('src/runtime.js', 'export const root = "/dsh/home/auma";');
  put('dist/preview/vfs-image.tar.gz', gzipSync(tarMember('home/auma/AGENTS.md', 'Cloudflare owns the persistent head.')));
  const result = run(root, '--source');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /SCRUB source ok/);
  const shipped = run(root, '--dist');
  assert.equal(shipped.status, 0);
  assert.match(shipped.stdout, /SCRUB dist ok/);
});

test('a pinned third-party example keeps only its exact bytes, only at its own member path, and never the machine account', () => {
  const pinned = 'node_modules/readdirp/README.md';
  const example = Buffer.from(`- \`fullPath: '${HOME_PREFIX}dev/projects/app/assets/javascripts/react.js'\`: full path\n`);
  const run = (label, bytes) => { const hits = []; inspectBytes(bytes, label, hits, { bytes: 0, files: 0, archives: 0 }); return hits.map(hit => hit.reason); };
  // These bytes are not the pinned README, so even at the pinned path the home root is reported.
  assert.deepEqual(run(`vfs.tar.gz!gunzip!member/${pinned}`, example), ['machine-home-root']);
  assert.deepEqual(run(`vfs.tar.gz!gunzip!member/other/${pinned}`, example), ['machine-home-root']);
  assert.ok(run(`vfs.tar.gz!gunzip!member/${pinned}`, Buffer.from(`${MACHINE_USER}\n`)).includes('machine-account'));
});

const readdirpReadme = join(repoRoot, 'node_modules/.pnpm/readdirp@5.0.0/node_modules/readdirp/README.md');

test('inside a tar, only the pinned README bytes at their own path are masked; the archive pass hides nothing else', { skip: !existsSync(readdirpReadme) && 'readdirp@5.0.0 is not installed' }, () => {
  const run = (bytes, label = 'vfs-image.tar') => { const hits = []; inspectBytes(bytes, label, hits, { bytes: 0, files: 0, archives: 0 }); return hits; };
  const readme = readFileSync(readdirpReadme);
  // The exact pinned README at its own member path: no finding from the member or from the whole archive.
  assert.deepEqual(run(tarMember('node_modules/readdirp/README.md', readme)), []);
  // The same bytes under another path are reported by the member scan and by the archive scan.
  const moved = run(tarMember('node_modules/other/README.md', readme)).map(hit => `${hit.path}:${hit.reason}`);
  assert.ok(moved.includes('vfs-image.tar!member/node_modules/other/README.md:machine-home-root'), moved.join('\n'));
  assert.ok(moved.includes('vfs-image.tar:machine-home-root'), moved.join('\n'));
});

test('inside a tar, an unpinned README at the pinned path is reported by member and archive scans', () => {
  const hits = []; inspectBytes(tarMember('node_modules/readdirp/README.md', `x ${HOME_PREFIX}dev/app.js\n`), 'vfs-image.tar', hits, { bytes: 0, files: 0, archives: 0 });
  const found = hits.map(hit => `${hit.path}:${hit.reason}`);
  assert.ok(found.includes('vfs-image.tar!member/node_modules/readdirp/README.md:machine-home-root'), found.join('\n'));
  assert.ok(found.includes('vfs-image.tar:machine-home-root'), found.join('\n'));
});

test('--bundle accepts a web dist whose JavaScript sits in subfolders and still refuses a folder with none', t => {
  const { root, put } = fixture(t);
  put('web-dist/index.html', '<!doctype html>');
  assert.throws(() => scanBundle(root, 'web-dist'), /SCRUB_BUNDLE_MISSING/);
  put('web-dist/preview/app.js', 'export const ok = true;\n');
  assert.deepEqual(scanBundle(root, 'web-dist').hits, []);
  put('web-dist/preview/leak.js', `const p = '${machinePath}';\n`);
  assert.ok(scanBundle(root, 'web-dist').hits.some(hit => hit.reason === 'machine-account'));
});

