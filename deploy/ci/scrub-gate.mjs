import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { HOME_PREFIX, MACHINE_USER } from './forbidden.mjs';

// Ported from an earlier scripts/scrub-gate.mjs and adapted to the x6.1
// layout: the repository root is the x6.1 tree itself (no x61/ prefix) and the
// shipped asset directory comes from deploy/cloudflare/wrangler.toml. This file
// lives under deploy/ (T2-protected) because CI runs it beside deploy secrets.
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HISTORY_PATH = 'deploy/ci/scrub-history.json';
const WRANGLER_CONFIG = 'deploy/cloudflare/wrangler.toml';
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;
const SPATIAL_PATH_TEMPLATE = `${HOME_PREFIX}name/my-plugin`;
const SPATIAL_TEMPLATE_SOURCES = new Set([
  'packages/client/ui-plugin-manager/src/client/locales.ts',
  'apps/web/tests/plugin-manager.e2e.ts',
]);
const SPATIAL_TEMPLATE_MODULE = 'node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js';

// Preserve the exact original Spatial install example and its matching test.
// Only the quoted template is exempt, in its owning source or shipped module;
// other users, suffixes, filenames and real machine paths remain forbidden.
function withoutSpatialTemplate(text) {
  return text.replace(new RegExp(String.raw`(\\*["'])${SPATIAL_PATH_TEMPLATE}\1`, 'g'), '[spatial-install-template]');
}

function ownsSpatialTemplate(label) {
  return SPATIAL_TEMPLATE_SOURCES.has(label) || label.endsWith(`!member/${SPATIAL_TEMPLATE_MODULE}`);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const homeFileUrl = new RegExp(`file://(?:[^/\\s"'<>]+)?${HOME_PREFIX}`, 'i');

// Distinguish a drive path or URL from ordinary labels such as "path:<root>".
function hasHomeRoot(text) {
  if (homeFileUrl.test(text)) return true;
  // The default filesystem treats home-path case variants as the same path.
  // Fold only the ASCII path spelling. Unicode lowercasing can expand a
  // character (for example U+0130), invalidating offsets into the original.
  const folded = text.replace(/[A-Z]/g, char => char.toLowerCase());
  // APFS exposes the same home through its Data volume. Test that complete
  // root as well, since the nested home segment is not a token boundary.
  for (const root of [HOME_PREFIX, `/System/Volumes/Data${HOME_PREFIX}`]) {
    const foldedRoot = root.toLowerCase();
    for (let index = folded.indexOf(foldedRoot); index >= 0; index = folded.indexOf(foldedRoot, index + root.length)) {
      const prefix = text.slice(Math.max(0, index - 4096), index);
      if (/https?:\/\/[^\s"'<>]*$/i.test(prefix)) continue;
      if (root === HOME_PREFIX && /(?:^|[^A-Za-z0-9])[A-Za-z]:$/.test(prefix)) continue;
      // A lower-case REST collection prefix or named route parameter has no
      // account component. File URLs were already refused above; concrete
      // names such as the negative fixtures still fail in every letter case.
      if (root === HOME_PREFIX && text.slice(index, index + root.length) === root.toLowerCase()) {
        const tail = text.slice(index + root.length);
        if (tail === '' || /^(?::[A-Za-z_]|["'`\s])/.test(tail)) continue;
      }
      if (index === 0 || !/[A-Za-z0-9_./-]/.test(text[index - 1])) return true;
    }
  }
  return false;
}

export function scrubReasons(bytes, allowSpatialTemplate = false) {
  const text = bytes.toString('utf8');
  const decoded = text.replace(/\\u([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replaceAll('\\/', '/');
  // URI-encoded path bytes also occur in source maps and serialized VFS files.
  // Apply the exact Spatial literal exception first; it does not authorize an
  // encoded alternative to the unchanged UI example.
  const decodeUriBytes = value => value.replace(/%([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const pathText = decodeUriBytes(allowSpatialTemplate ? withoutSpatialTemplate(decoded) : decoded);
  const reasons = [];
  if (hasHomeRoot(pathText)) reasons.push('machine-home-root');
  if (decodeUriBytes(decoded).toLowerCase().includes(MACHINE_USER)) reasons.push('machine-account');
  if (/mirrored?[^\n.!?]{0,100}\bto (?:The owner['’]s )?Mac\b/i.test(decoded)) reasons.push('machine-mirror-claim');
  return reasons;
}

function safeLabel(label) {
  return label.replaceAll(HOME_PREFIX, '[home-root]/').replace(new RegExp(MACHINE_USER, 'gi'), '[machine-account]');
}

function inspectPath(path, label, hits) {
  for (const reason of scrubReasons(Buffer.from(path))) hits.push({ path: safeLabel(label), reason: `path-${reason}` });
}

function tarNumber(bytes, label) {
  let number;
  if (bytes[0] & 0x80) {
    if (bytes[0] & 0x40) throw new Error(`SCRUB_TAR_NEGATIVE_SIZE: ${safeLabel(label)}`);
    let value = BigInt(bytes[0] & 0x7f);
    for (const byte of bytes.subarray(1)) value = value * 256n + BigInt(byte);
    number = Number(value);
  } else {
    const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(text)) throw new Error(`SCRUB_TAR_NUMBER: ${safeLabel(label)}`);
    number = parseInt(text, 8);
  }
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_INFLATED_BYTES) throw new Error(`SCRUB_TAR_SIZE: ${safeLabel(label)}`);
  return number;
}

const tarText = bytes => bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString('utf8');

function paxFields(bytes, label) {
  const fields = Object.create(null);
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    const lengthText = space < 0 ? '' : bytes.subarray(offset, space).toString('ascii');
    const length = Number(lengthText);
    if (!/^[1-9][0-9]*$/.test(lengthText) || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) {
      throw new Error(`SCRUB_TAR_PAX: ${safeLabel(label)}`);
    }
    const record = bytes.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error(`SCRUB_TAR_PAX: ${safeLabel(label)}`);
    fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return fields;
}

// Parse member boundaries: scanning only the inflated tar's raw bytes misses
// compressed members. No member is extracted to disk or followed as a link.
function inspectTar(bytes, label, hits, stats, depth) {
  const pinnedRanges = [];
  let offset = 0;
  let nextName;
  let nextLink;
  let globalPax = Object.create(null);
  let nextPax = Object.create(null);
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (offset + 1024 > bytes.length || bytes.subarray(offset).some(byte => byte !== 0) || nextName || nextLink || Object.keys(nextPax).length) {
        throw new Error(`SCRUB_TAR_END: ${safeLabel(label)}`);
      }
      return pinnedRanges;
    }
    const expected = tarNumber(header.subarray(148, 156), label);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (expected !== actual) throw new Error(`SCRUB_TAR_CHECKSUM: ${safeLabel(label)}`);
    const type = String.fromCharCode(header[156]);
    if (!['\0', '0', '1', '2', '3', '4', '5', '6', '7', 'x', 'g', 'L', 'K'].includes(type)) throw new Error(`SCRUB_TAR_TYPE: ${safeLabel(label)}`);
    const metadata = ['x', 'g', 'L', 'K'].includes(type);
    const pax = { ...globalPax, ...nextPax };
    let size = tarNumber(header.subarray(124, 136), label);
    if (!metadata && pax.size !== undefined) {
      if (!/^[0-9]+$/.test(pax.size) || !Number.isSafeInteger(Number(pax.size)) || Number(pax.size) > MAX_INFLATED_BYTES) throw new Error(`SCRUB_TAR_PAX_SIZE: ${safeLabel(label)}`);
      size = Number(pax.size);
    }
    const prefix = tarText(header.subarray(345, 500));
    const name = tarText(header.subarray(0, 100));
    const path = metadata ? name : pax.path ?? nextName ?? (prefix ? `${prefix}/${name}` : name);
    const memberLabel = `${label}!member/${safeLabel(path)}`;
    offset += 512;
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > bytes.length) throw new Error(`SCRUB_TAR_TRUNCATED: ${safeLabel(label)}`);
    const content = bytes.subarray(offset, offset + size);
    inspectPath(path, memberLabel, hits);
    if (type === '1' || type === '2') inspectPath(pax.linkpath ?? nextLink ?? tarText(header.subarray(157, 257)), `${memberLabel}!link`, hits);
    const fileMember = ['\0', '0', '7'].includes(type);
    if (fileMember && pinnedThirdPartyExample(memberLabel, content)) pinnedRanges.push([offset, offset + size]);
    inspectBytes(content, fileMember ? memberLabel : `${memberLabel}!metadata`, hits, stats, depth + 1);
    if (type === 'g') globalPax = { ...globalPax, ...paxFields(content, memberLabel) };
    else if (type === 'x') nextPax = { ...nextPax, ...paxFields(content, memberLabel) };
    else if (type === 'L') nextName = tarText(content);
    else if (type === 'K') nextLink = tarText(content);
    else { nextName = undefined; nextLink = undefined; nextPax = Object.create(null); }
    offset += padded;
  }
  throw new Error(`SCRUB_TAR_END: ${safeLabel(label)}`);
}

// Third-party files that ship inside the VFS image and carry a generic example
// home path (never this machine's account). Each is pinned by exact bytes, so an
// upgrade or edit of the file loses the exemption and the gate fails closed.
const PINNED_THIRD_PARTY_EXAMPLES = new Map([
  // readdirp@5.0.0 README documents `fullPath` with the example `<home-root>/dev/projects/...`.
  ['node_modules/readdirp/README.md', '7ddfe4388aee089ba4bdea5fc67d2e07fad03fc9cbfe0cdcc57ca976fb7e798b'],
]);

function pinnedThirdPartyExample(label, bytes) {
  const marker = label.lastIndexOf('!member/');
  if (marker < 0) return false;
  const expected = PINNED_THIRD_PARTY_EXAMPLES.get(label.slice(marker + '!member/'.length));
  return expected !== undefined && digest(bytes) === expected;
}

// Scan all bytes, including large bundles and Wasm data sections. Archive scans
// inspect the inflated tar too: member names and member contents are both covered.
export function inspectBytes(bytes, label, hits, stats, depth = 0) {
  stats.bytes += bytes.length;
  const tarArchive = /\.tar(?:\.gz!gunzip)?$|\.tgz!gunzip$/.test(label) || bytes.subarray(257, 262).toString('ascii') === 'ustar';
  // A tar's aggregate bytes also contain the permitted module. Member scans
  // below enforce its exact owner; unrelated members receive no exception.
  const gzip = (bytes[0] === 0x1f && bytes[1] === 0x8b) || /\.(gz|tgz)$/.test(label);
  const plainTar = tarArchive && !gzip && !label.endsWith('.br');
  if (depth > 8) throw new Error(`SCRUB_ARCHIVE_DEPTH: ${safeLabel(label)}`);
  // A plain tar's members are scanned first; the aggregate pass then masks only the exact bytes of
  // pinned third-party members, so their example path is not reported twice and nothing else is hidden.
  const pinnedRanges = plainTar ? inspectTar(bytes, label, hits, stats, depth) : [];
  let aggregate = bytes;
  if (pinnedRanges.length) {
    aggregate = Buffer.from(bytes);
    for (const [start, end] of pinnedRanges) aggregate.fill(0, start, end);
  }
  const pinned = pinnedThirdPartyExample(label, bytes);
  for (const reason of scrubReasons(aggregate, ownsSpatialTemplate(label) || tarArchive)) {
    // A pinned third-party example may keep its generic home root; the machine account is never exempt.
    if (pinned && reason === 'machine-home-root') continue;
    hits.push({ path: safeLabel(label), reason });
  }
  const text = bytes.toString('utf8');
  const inlineMaps = /sourceMappingURL\s*=\s*data:application\/json(?:;charset=[\w-]+)?(;base64)?,([^\s"'<>]+)/g;
  for (const [index, match] of [...text.matchAll(inlineMaps)].entries()) {
    const decoded = match[1] ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]));
    inspectBytes(decoded, `${label}!source-map-${index}`, hits, stats, depth + 1);
  }
  if (gzip) {
    const inflated = gunzipSync(bytes, { maxOutputLength: MAX_INFLATED_BYTES });
    stats.archives++;
    inspectBytes(inflated, `${label}!gunzip`, hits, stats, depth + 1);
  } else if (label.endsWith('.br')) {
    stats.archives++;
    inspectBytes(brotliDecompressSync(bytes, { maxOutputLength: MAX_INFLATED_BYTES }), `${label}!brotli`, hits, stats, depth + 1);
  }
}

// x6.1 history entries name the exact bytes (sha256) AND the x6.1 commit that
// recorded them, so every exception is a specific historical finding at a
// specific path in this repository's own history, never a wildcard.
export function loadHistory(root) {
  const path = join(root, HISTORY_PATH);
  if (!existsSync(path)) return new Map();
  const groups = JSON.parse(readFileSync(path, 'utf8'));
  if (groups.version !== 2 || !Array.isArray(groups.history)) throw new Error('SCRUB_HISTORY_SCHEMA');
  const allowed = new Map();
  for (const group of groups.history) {
    if (typeof group.reason !== 'string' || group.reason.length < 30 || !group.files || typeof group.files !== 'object') {
      throw new Error('SCRUB_HISTORY_REASON');
    }
    for (const [path, entry] of Object.entries(group.files)) {
      if (path.includes('..') || path.startsWith('/') || /[*?[\]{}\0-\x1f]/.test(path) || allowed.has(path)
        || !entry || typeof entry !== 'object' || Object.keys(entry).sort().join() !== 'commit,sha256'
        || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[a-f0-9]{40}$/.test(entry.commit)) {
        throw new Error('SCRUB_HISTORY_ENTRY');
      }
      allowed.set(path, { sha256: entry.sha256, commit: entry.commit, reason: group.reason });
    }
  }
  return allowed;
}

function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// Resolve each <commit>:<path> once. A missing commit object (for example a
// shallow clone) fails closed: CI must fetch full history to use exceptions.
function historyBlobs(root, entries) {
  if (!entries.length) return new Map();
  const input = entries.map(([path, { commit }]) => `${commit}:${path}`).join('\n') + '\n';
  const output = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { cwd: root, input, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').trimEnd().split('\n');
  if (output.length !== entries.length) throw new Error('SCRUB_HISTORY_GIT');
  return new Map(entries.map(([path], index) => {
    // "<object> blob" when present; "<commit>:<path> missing" otherwise.
    const parts = output[index].split(' ');
    return [path, parts.length === 2 && parts[1] === 'blob' && /^[a-f0-9]{40}$/.test(parts[0]) ? parts[0] : null];
  }));
}

function shipDirectory(root) {
  // Read only the [assets] table's directory key; it is relative to the
  // wrangler.toml that declares it, exactly as Wrangler resolves it.
  const configPath = join(root, WRANGLER_CONFIG);
  const config = readFileSync(configPath, 'utf8');
  const table = /^\[assets\][ \t]*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(config)?.[1] ?? '';
  const path = /^[ \t]*directory[ \t]*=[ \t]*"([^"\n]+)"/m.exec(table)?.[1];
  if (!path) throw new Error('SCRUB_ASSETS_DIRECTORY_MISSING');
  const directory = resolve(dirname(configPath), path);
  if (!directory.startsWith(`${root}/`)) throw new Error('SCRUB_ASSETS_OUTSIDE_REPOSITORY');
  return directory;
}

export function scanSource(root) {
  const history = loadHistory(root);
  const recorded = historyBlobs(root, [...history.entries()]);
  const shipped = `${relative(root, shipDirectory(root))}/`;
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean);
  const files = [...new Set(listed)].filter(path => !path.startsWith(shipped));
  const hits = [];
  const stats = { files: 0, bytes: 0, archives: 0, history: 0 };
  for (const path of files) {
    const absolute = join(root, path);
    let stat;
    try { stat = lstatSync(absolute); }
    catch (error) {
      // A tracked deletion is absent from the candidate tree. Dangling links,
      // however, have source bytes of their own and must still be inspected.
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    const exception = history.get(path);
    const found = [];
    inspectPath(path, path, found);
    inspectBytes(bytes, path, found, stats);
    stats.files++;
    if (exception) {
      if (digest(bytes) !== exception.sha256) hits.push({ path, reason: 'history-bytes-changed' });
      else if (recorded.get(path) !== gitBlobId(bytes)) hits.push({ path, reason: 'history-commit-mismatch' });
      else stats.history++;
    } else hits.push(...found);
  }
  return { hits, stats };
}

function scanTree(root, directory, hits, stats) {
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      inspectPath(relative(root, path), relative(root, path), hits);
      if (entry.isSymbolicLink()) throw new Error(`SCRUB_SHIPPED_SYMLINK: ${safeLabel(relative(root, path))}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        stats.files++;
        inspectBytes(readFileSync(path), relative(root, path), hits, stats);
      }
    }
  };
  walk(directory);
}

export function scanShipped(root) {
  const directory = shipDirectory(root);
  const image = join(directory, 'preview/vfs-image.tar.gz');
  if (!existsSync(image)) throw new Error('SCRUB_SHIPPED_VFS_MISSING');
  const hits = [];
  const stats = { files: 0, bytes: 0, archives: 0, history: 0 };
  scanTree(root, directory, hits, stats);
  return { hits, stats };
}

// The Worker script itself ships too: scan the exact bundle Wrangler produced
// (wrangler deploy --dry-run --outdir <dir>) that the deploy job uploads.
function containsJavaScript(directory) {
  return readdirSync(directory, { withFileTypes: true }).some(entry => (entry.isFile() && /\.(?:m?js)$/.test(entry.name))
    || (entry.isDirectory() && containsJavaScript(join(directory, entry.name))));
}

export function scanBundle(root, bundle) {
  const directory = resolve(root, bundle);
  // A Worker bundle has worker.js at its top; a web dist (apps/web/dist) keeps its JS in subfolders.
  // Either way, a directory with no JavaScript at all is refused rather than reported clean.
  if (!existsSync(directory) || !statSync(directory).isDirectory() || !containsJavaScript(directory)) throw new Error('SCRUB_BUNDLE_MISSING');
  const hits = [];
  const stats = { files: 0, bytes: 0, archives: 0, history: 0 };
  scanTree(root, directory, hits, stats);
  return { hits, stats };
}

export function main(args = process.argv.slice(2)) {
  let root = DEFAULT_ROOT;
  let mode = 'all';
  let bundle;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i]);
    else if (args[i] === '--source') mode = 'source';
    else if (args[i] === '--dist') mode = 'dist';
    else if (args[i] === '--bundle' && args[i + 1]) { mode = 'bundle'; bundle = args[++i]; }
    else throw new Error('SCRUB_ARGUMENT');
  }
  let failed = false;
  for (const kind of mode === 'all' ? ['source', 'dist'] : [mode]) {
    const { hits, stats } = kind === 'source' ? scanSource(root) : kind === 'dist' ? scanShipped(root) : scanBundle(root, bundle);
    if (hits.length) {
      failed = true;
      console.error(`FAIL scrub ${kind}: ${hits.length} findings`);
      // Report locations and classifications, never source contents or account values.
      for (const hit of hits) console.error(`${hit.path}: ${hit.reason}`);
    } else console.log(`SCRUB ${kind} ok ${JSON.stringify(stats)}`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`FAIL scrub: ${error.message}`); process.exitCode = 1; }
}
