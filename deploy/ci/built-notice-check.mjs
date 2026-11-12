// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * BUILT-NOTICE CHECK. The "a new build is live" notice was dead in production while its
 * unit specs passed: the UI library ships inside the app image, unbundled by apps/web, so the bundler define its page
 * side read (`__X6_BUILD_IDENTITY__`) was a bare word at run time and the page's revision was null. This check runs on a
 * BUILT dist (after build-preview) and shows the page side resolves this build's commit.
 *
 * THIS CHECK ONLY READS FILES. It never executes built code: no realm, no eval, no worker, no import of anything it
 * reads. Each fact is read out of the built bytes as text:
 *
 *   1. the bootstrap that preview.html loads carries the small page stamp (`__X6_PAGE_STAMP__`, a JSON string literal
 *      of `sourceRevision` and `sourceDirty`, apps/web/vite.config.ts) exactly once, and the name it publishes it under
 *      (`__X6_PAGE_BUILD__`, apps/web/src/preview.ts); it must not carry the whole build identity's retention suite
 *      (marker `retentionBaselineSuite`), and its byte size is reported;
 *   2. the UI library is read out of the app image (`preview/vfs-image.tar.gz`): its `pageSourceRevision` (with the
 *      `pageBuildStamp` it defaults to) must read the published global, and read no bundler define except behind a
 *      `typeof … !== "undefined"` guard (a guarded one is dead in the image; reported as `guardedDefines`);
 *   3. the page stamp's revision must be a clean 40-hex commit equal to the build's: `--commit <sha>` when given, and in
 *      every case the clean stamp the build wrote into its host worker bundle (`preview/worker-*.js`).
 *
 * Usage: node deploy/ci/built-notice-check.mjs <dist> [--commit <40-hex>]   (exit 0 pass, 1 fail, 2 usage)
 * It lives under deploy/ because the pipeline that deploys runs it beside the other built-output gates.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const LIBRARY_MEMBER = 'node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js';
export const IMAGE_PATH = 'preview/vfs-image.tar.gz';
/** The global the bootstrap publishes and the library reads (preview.ts, build-notice.ts `PAGE_BUILD_GLOBAL`). */
export const PAGE_BUILD_GLOBAL = '__X6_PAGE_BUILD__';
/** A key of the whole build identity that holds the retention suite: present in the worker, never in the page. */
export const RETENTION_MARKER = 'retentionBaselineSuite';
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;
const REVISION = /^[0-9a-f]{40}$/;
/** The page stamp as Vite writes it: a JSON string literal, its quotes escaped or not by the minifier's choice. */
const PAGE_STAMP = /\{\\?"sourceRevision\\?":(?:\\?"([^"\\]{0,128})\\?"|null),\\?"sourceDirty\\?":(true|false|null)\}/g;
const QUOTED_GLOBAL = new RegExp(`(["'\`])${PAGE_BUILD_GLOBAL}\\1`);
/** `typeof X !== "undefined" ? X` or `if (typeof X !== "undefined") return X`: a read that is dead where X is bare. */
const GUARDED_DEFINE = /typeof\s+(__X6_[A-Z0-9_]+__)\s*!==?\s*(["'`])undefined\2\s*(?:\)\s*return\s+|\?\s*)\1\b/g;
const DEFINE = /\b__X6_[A-Z0-9_]+__\b/g;

function fail(code, detail) {
  return { ok: false, code, detail };
}

/** One member's bytes from an uncompressed tar, or null. Reads ustar prefix, GNU long names and pax paths. */
export function readTarMember(tar, wanted) {
  let offset = 0;
  let longName = null;
  let paxPath = null;
  const text = bytes => { const end = bytes.indexOf(0); return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8'); };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) return null;
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_INFLATED_BYTES) throw new Error('BUILT_NOTICE_TAR_SIZE');
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = text(body); continue; }
    if (type === 'x') {
      for (const line of body.toString('utf8').split('\n')) {
        const match = /^\d+ path=(.*)$/.exec(line);
        if (match) paxPath = match[1];
      }
      continue;
    }
    if (type === 'g') continue;
    const prefix = text(header.subarray(345, 500));
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100)));
    longName = null;
    paxPath = null;
    if ((type === '0' || type === '\0') && name.replace(/^\.\//, '') === wanted) return Buffer.from(body);
  }
  return null;
}

/** The bootstrap preview.html loads (the served page: the edge rewrites `/` and `/index.html` to it). */
export function bootstrapPath(previewHtml) {
  const match = /<script\b[^>]*\bsrc="\.?\/?(preview\/bootstrap-[A-Za-z0-9_-]+\.js)"/.exec(previewHtml);
  return match ? match[1] : null;
}

/** The clean commit stamped into the host worker bundle(s), or null when none or more than one is found. */
export function workerStampRevision(workerTexts) {
  const found = new Set();
  for (const text of workerTexts) {
    for (const match of text.matchAll(/sourceRevision:"([0-9a-f]{40})",sourceDirty:(?:!1|false)\b/g)) found.add(match[1]);
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * What the bootstrap text says about the page's build, read without running it.
 * @returns `{ ok, revision, stamps, retention }` (revision null for a dirty or unstamped page) or a failure.
 */
export function readBootstrap(text) {
  const retention = text.includes(RETENTION_MARKER);
  if (retention) return { ...fail('BOOTSTRAP_CARRIES_RETENTION_SUITE', `the bootstrap inlines the whole build identity (${RETENTION_MARKER}); it must carry only the page stamp`), retention };
  if (!QUOTED_GLOBAL.test(text)) return fail('PAGE_PUBLICATION_MISSING', `the bootstrap never names ${PAGE_BUILD_GLOBAL}: nothing publishes the page stamp`);
  const stamps = new Map();
  for (const match of text.matchAll(PAGE_STAMP)) stamps.set(`${match[1] ?? 'null'}|${match[2]}`, { sourceRevision: match[1] ?? null, sourceDirty: match[2] === 'true' ? true : match[2] === 'false' ? false : null });
  if (stamps.size === 0) return fail('PAGE_STAMP_MISSING', 'the bootstrap carries no page stamp literal (__X6_PAGE_STAMP__ was not replaced or not read)');
  if (stamps.size > 1) return { ...fail('PAGE_STAMP_AMBIGUOUS', 'the bootstrap carries more than one distinct page stamp'), stamps: stamps.size };
  const [stamp] = stamps.values();
  const revision = stamp.sourceDirty === false && typeof stamp.sourceRevision === 'string' && REVISION.test(stamp.sourceRevision) ? stamp.sourceRevision : null;
  return { ok: true, revision, stamp, retention };
}

/** The source of `function name(…) {…}` in `text`, by bracket counting, or null. */
export function functionSource(text, name) {
  const head = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(text);
  if (!head) return null;
  let at = head.index + head[0].length;
  for (let depth = 1; depth > 0; at += 1) {
    if (at >= text.length) return null;
    if (text[at] === '(') depth += 1;
    else if (text[at] === ')') depth -= 1;
  }
  const open = text.indexOf('{', at);
  if (open < 0) return null;
  for (let depth = 0, index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') { depth -= 1; if (depth === 0) return text.slice(head.index, index + 1); }
  }
  return null;
}

/**
 * What the UI library's page-revision reader reads, without running it.
 * @returns `{ ok, guardedDefines }` or a failure naming why the reader cannot see the published stamp.
 */
export function readLibrary(text) {
  const reader = functionSource(text, 'pageSourceRevision');
  if (reader === null) return fail('LIBRARY_READER_MISSING', 'the UI library has no pageSourceRevision');
  const stampReader = /\bpageBuildStamp\s*\(/.test(reader) ? functionSource(text, 'pageBuildStamp') : null;
  const path = stampReader === null ? reader : `${reader}\n${stampReader}`;
  const guardedDefines = [...path.matchAll(GUARDED_DEFINE)].length;
  const bare = [...new Set((path.replace(GUARDED_DEFINE, '').replace(new RegExp(QUOTED_GLOBAL, 'g'), '').match(DEFINE) ?? []))]
    .filter(name => name !== PAGE_BUILD_GLOBAL);
  if (bare.length > 0) return { ...fail('LIBRARY_BARE_DEFINE', `the reader reads ${bare.join(', ')} unguarded: a bundler define is a bare word in the image`), guardedDefines };
  // `(globalThis as Record<…>)[…]` compiles to `globalThis[…]`, or keeps its parentheses when only stripped.
  const viaName = /\bglobalThis\s*\)?\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/.exec(path)?.[1];
  const declared = viaName !== undefined
    && new RegExp(`\\b(?:const|let|var)\\s+${viaName.replace(/\$/g, '\\$')}\\s*=\\s*(["'\`])${PAGE_BUILD_GLOBAL}\\1`).test(text);
  const direct = new RegExp(`\\bglobalThis\\s*\\)?\\s*(?:\\[\\s*(["'\`])${PAGE_BUILD_GLOBAL}\\1\\s*\\]|\\.${PAGE_BUILD_GLOBAL}\\b)`).test(path);
  if (!declared && !direct) return { ...fail('LIBRARY_READS_NO_PUBLISHED_STAMP', `the reader never reads globalThis.${PAGE_BUILD_GLOBAL}`), guardedDefines };
  return { ok: true, guardedDefines };
}

/** The dist on disk, read by relative path. */
export function diskFiles(dist) {
  return {
    read(path) { try { return readFileSync(join(dist, path)); } catch { return null; } },
    list(directory) { try { return readdirSync(join(dist, directory)); } catch { return []; } },
  };
}

/**
 * The whole check on one built dist directory.
 * @param dist - the built `apps/web/dist`.
 * @param options.commit - the commit the build was made from, when the caller knows it.
 * @param options.files - how the dist is read (tests pass an in-memory one); defaults to the disk.
 */
export function checkBuiltNotice(dist, { commit, files = diskFiles(dist) } = {}) {
  if (commit !== undefined && !REVISION.test(commit)) return fail('COMMIT_INVALID', 'the --commit value is not 40 lowercase hex');
  const previewHtml = files.read('preview.html');
  if (previewHtml === null) return fail('PREVIEW_PAGE_MISSING', 'no preview.html in the dist');
  const bootstrap = bootstrapPath(previewHtml.toString('utf8'));
  if (bootstrap === null) return fail('BOOTSTRAP_MISSING', 'preview.html loads no preview/bootstrap-*.js');
  const bootstrapBytes = files.read(bootstrap);
  if (bootstrapBytes === null) return fail('BOOTSTRAP_MISSING', `${bootstrap} is not in the dist`);
  const at = { bootstrap, bootstrapBytes: bootstrapBytes.length };
  const workers = files.list('preview').filter(name => /^worker-[A-Za-z0-9_-]+\.js$/.test(name));
  const expected = workerStampRevision(workers.map(name => files.read(`preview/${name}`)?.toString('utf8') ?? ''));
  if (expected === null) return { ...fail('BUILD_COMMIT_UNKNOWN', 'the host worker bundle carries no single clean source stamp (a dirty or watch build names nothing)'), ...at };
  if (commit !== undefined && commit !== expected) return { ...fail('BUILD_COMMIT_MISMATCH', `the worker is stamped ${expected}, not ${commit}`), ...at, expected };
  const page = readBootstrap(bootstrapBytes.toString('utf8'));
  if (!page.ok) return { ...page, ...at, expected };
  const image = files.read(IMAGE_PATH);
  if (image === null) return { ...fail('IMAGE_UNREADABLE', `no ${IMAGE_PATH} in the dist`), ...at, expected };
  let library;
  try { library = readTarMember(gunzipSync(image, { maxOutputLength: MAX_INFLATED_BYTES }), LIBRARY_MEMBER); } catch (error) {
    return { ...fail('IMAGE_UNREADABLE', String(error?.message ?? error).slice(0, 200)), ...at, expected };
  }
  if (library === null) return { ...fail('LIBRARY_MISSING', `no ${LIBRARY_MEMBER} in ${IMAGE_PATH}`), ...at, expected };
  const reader = readLibrary(library.toString('utf8'));
  if (!reader.ok) return { ...reader, ...at, expected };
  const result = { ...at, expected, resolved: page.revision, guardedDefines: reader.guardedDefines };
  if (page.revision === null) {
    return { ok: false, code: 'PAGE_REVISION_UNRESOLVED', detail: 'the page stamp names no clean revision: the "new build is live" notice would never show', ...result };
  }
  if (page.revision !== expected) return { ok: false, code: 'PAGE_REVISION_MISMATCH', detail: `the page stamp names ${page.revision}`, ...result };
  return { ok: true, code: 'PAGE_REVISION_RESOLVED', ...result };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--commit');
  const commit = at === -1 ? undefined : args[at + 1];
  const dist = args.find((arg, index) => !arg.startsWith('--') && (at === -1 || index !== at + 1));
  if (dist === undefined || (at !== -1 && commit === undefined)) {
    console.error('usage: node deploy/ci/built-notice-check.mjs <dist> [--commit <40-hex>]');
    process.exit(2);
  }
  const result = checkBuiltNotice(dist, { commit });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
