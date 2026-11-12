// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
// The built-notice check on in-memory dists shaped like build-preview's output: the bootstrap preview.html
// loads, the host worker with its stamp, and the app image carrying the UI library in its module-loader form. The check
// only reads text; nothing here is ever executed by it.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  LIBRARY_MEMBER, RETENTION_MARKER, checkBuiltNotice, functionSource, readBootstrap, readLibrary, readTarMember, workerStampRevision,
} from './built-notice-check.mjs';

const BUILD = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const repo = new URL('../../', import.meta.url);


/** A tar holding `members` ({ name: text }); a name over 100 bytes goes in a GNU long-name record. */
function tar(members) {
  const blocks = [];
  const header = (name, size, type) => {
    const block = Buffer.alloc(512);
    block.write(name.slice(0, 100), 0, 'utf8');
    block.write('0000644\0', 100);
    block.write('0000000\0', 108);
    block.write('0000000\0', 116);
    block.write(size.toString(8).padStart(11, '0') + '\0', 124);
    block.write('00000000000\0', 136);
    block.write(' '.repeat(8), 148);
    block.write(type, 156);
    block.write('ustar\0', 257);
    block.write('00', 263);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return block;
  };
  const pad = bytes => Buffer.concat([bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
  for (const [name, text] of Object.entries(members)) {
    const body = Buffer.from(text, 'utf8');
    if (Buffer.byteLength(name) > 100) {
      const long = Buffer.from(name + '\0', 'utf8');
      blocks.push(header('././@LongLink', long.length, 'L'), pad(long));
    }
    blocks.push(header(name, body.length, '0'), pad(body));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// The library reader as build-notice.ts ships it since an earlier change (tsdown output: comments kept, nothing minified).
const NEW_READER = `const PAGE_BUILD_GLOBAL = "__X6_PAGE_BUILD__";
		function pageBuildStamp() {
			if (typeof __X6_BUILD_IDENTITY__ !== "undefined") return __X6_BUILD_IDENTITY__;
			try {
				const published = globalThis[PAGE_BUILD_GLOBAL];
				return published !== null && typeof published === "object" ? published : void 0;
			} catch {
				return;
			}
		}
		function pageSourceRevision(stamp = pageBuildStamp()) {
			if (stamp == null || stamp.sourceDirty !== false) return null;
			return typeof stamp.sourceRevision === "string" && PAGE_REVISION.test(stamp.sourceRevision) ? stamp.sourceRevision : null;
		}`;
// The library as it shipped at an earlier commit: the bare define only.
const OLD_READER = `function pageSourceRevision(stamp = typeof __X6_BUILD_IDENTITY__ !== "undefined" ? __X6_BUILD_IDENTITY__ : void 0) {
			if (stamp == null || stamp.sourceDirty !== false) return null;
			return typeof stamp.sourceRevision === "string" && PAGE_REVISION.test(stamp.sourceRevision) ? stamp.sourceRevision : null;
		}`;

/** The UI library in its module-loader form. */
const library = reader => `window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-layout",
	factory: (require) => {
		var module = { exports: {} };
		let react = require("react");
		const PAGE_REVISION = /^[0-9a-f]{40}$/;
		${reader}
		document.documentElement.classList.add("x");
		return module.exports;
	}
});
//# sourceURL=packages/client/ui-layout/lib/client.js`;

/** A minified-style bootstrap; `publish` is what it does first. */
const bootstrap = publish => `function Xt(e){return new Worker(""+new URL("worker-AbC12.js",import.meta.url).href,{name:e?.name})}
function At(){globalThis.__DSH_BOOT_READY__=Promise.withResolvers()}
${publish}At();const Q=new URL(globalThis.location.href).searchParams.get("runtime_candidate");
if(typeof indexedDB<"u")await indexedDB.databases();const w=Xt({name:"dsh-host"});await w.ready;`;
/** What preview.ts emits since job 7: Vite has replaced `__X6_PAGE_STAMP__` with its JSON string literal. */
const stampLiteral = (sourceRevision, sourceDirty, quote = 'escaped') => {
  const json = JSON.stringify({ sourceRevision, sourceDirty });
  return quote === 'escaped' ? JSON.stringify(json) : `'${json}'`;
};
const publishing = (sourceRevision = BUILD, sourceDirty = false, quote) => `function Zp(){try{const e=JSON.parse(${stampLiteral(sourceRevision, sourceDirty, quote)});if(e!==null&&typeof e=="object"){const{sourceRevision:t,sourceDirty:n}=e;return{sourceRevision:typeof t=="string"?t:null,sourceDirty:typeof n=="boolean"?n:null}}}catch{}return{sourceRevision:null,sourceDirty:null}}try{Object.defineProperty(globalThis,"__X6_PAGE_BUILD__",{value:Object.freeze(Zp()),writable:!1,enumerable:!1,configurable:!1})}catch{}`;
/** What preview.ts emitted at job 6 (5520418a): the whole build identity, retention suite and all, inlined twice. */
const identity = `{sourceRevision:"${BUILD}",sourceDirty:!1,builtAt:"2026-11-12T00:00:00.000Z",runtimeArtifactSha256:null,retentionBaselineSuite:{schema:"aukora.pearl.retention-suite.v1",harness:"pearl-retention/v1",cases:[]},retentionBaselineDigest:"${'e'.repeat(64)}"}`;
const jobSixPublishing = `const Zp=typeof ${identity}<"u"?${identity}:void 0;try{Object.defineProperty(globalThis,"__X6_PAGE_BUILD__",{value:Object.freeze({sourceRevision:Zp?.sourceRevision??null,sourceDirty:Zp?.sourceDirty??null}),writable:!1,enumerable:!1,configurable:!1})}catch{}`;

const worker = (revision = BUILD, dirty = '!1') => `const s={sourceRevision:"${revision}",sourceDirty:${dirty},builtAt:"2026-11-12T00:00:00.000Z",runtimeArtifactSha256:null,retentionBaselineSuite:{schema:"aukora.pearl.retention-suite.v1"}};self.onmessage=()=>{};`;

/** An in-memory dist; a null value removes that file. */
function dist({ boot = bootstrap(publishing()), lib = library(NEW_READER), work = worker(), image, html } = {}) {
  const files = new Map([
    ['preview.html', html ?? '<!doctype html><script type="module" crossorigin src="./preview/bootstrap-D1Xi2LoD.js"></script><script type="module" crossorigin src="./assets/index-Ya7lWDhu.js"></script>'],
    ['preview/bootstrap-D1Xi2LoD.js', boot],
    ['preview/worker-AbC12.js', work],
    ['preview/vfs-image.tar.gz', image ?? gzipSync(tar({ 'home/auma/x.txt': 'x', [LIBRARY_MEMBER]: lib }))],
  ]);
  return {
    read: path => (files.has(path) && files.get(path) !== null ? Buffer.from(files.get(path)) : null),
    list: directory => [...files.keys()].filter(path => path.startsWith(`${directory}/`)).map(path => path.slice(directory.length + 1)),
  };
}
const check = (options = {}, commit) => checkBuiltNotice('/dist', { commit, files: dist(options) });
const code = (options, commit) => check(options, commit).code;

test('a bootstrap carrying the page stamp and a library reading the published global resolve the build commit', () => {
  const result = check();
  assert.equal(result.code, 'PAGE_REVISION_RESOLVED', JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.equal(result.resolved, BUILD);
  assert.equal(result.expected, BUILD);
  assert.equal(result.guardedDefines, 1, 'the job-6 reader keeps one typeof-guarded define, dead in the image');
  assert.equal(result.bootstrapBytes, Buffer.byteLength(bootstrap(publishing())));
  assert.equal(check({}, BUILD).ok, true);
  // The minifier may write the literal with single quotes instead of escaped double quotes.
  assert.equal(check({ boot: bootstrap(publishing(BUILD, false, 'single')) }).resolved, BUILD);
});

test('the bootstrap must not carry the whole build identity (the job-6 bootstrap did: the retention suite, twice)', () => {
  const result = check({ boot: bootstrap(jobSixPublishing) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BOOTSTRAP_CARRIES_RETENTION_SUITE');
  assert.equal(result.retention, true);
  assert.equal(result.bootstrapBytes, Buffer.byteLength(bootstrap(jobSixPublishing)), 'the size is reported on failure too');
  assert.equal(readBootstrap(`${publishing()}const x={${RETENTION_MARKER}:null}`).code, 'BOOTSTRAP_CARRIES_RETENTION_SUITE');
});

test('a bootstrap that publishes nothing (as at d7c687bf) or carries no stamp fails by name', () => {
  assert.equal(code({ boot: bootstrap('') }), 'PAGE_PUBLICATION_MISSING');
  const unreplaced = bootstrap(publishing()).replace(/JSON\.parse\([^)]*\)/, 'JSON.parse(__X6_PAGE_STAMP__)');
  assert.equal(code({ boot: unreplaced }), 'PAGE_STAMP_MISSING');
  const two = bootstrap(`${publishing()}const y=${stampLiteral(OTHER, false)};`);
  assert.equal(code({ boot: two }), 'PAGE_STAMP_AMBIGUOUS');
  // The same stamp twice (the define replaced at two reads) is one stamp.
  assert.equal(check({ boot: bootstrap(`${publishing()}const y=${stampLiteral(BUILD, false)};`) }).ok, true);
});

test('a dirty or unstamped page names nothing, and fails', () => {
  assert.equal(code({ boot: bootstrap(publishing(BUILD, true)) }), 'PAGE_REVISION_UNRESOLVED');
  assert.equal(code({ boot: bootstrap(publishing(BUILD, null)) }), 'PAGE_REVISION_UNRESOLVED');
  assert.equal(code({ boot: bootstrap(publishing(null, null)) }), 'PAGE_REVISION_UNRESOLVED');
  assert.equal(code({ boot: bootstrap(publishing('C'.repeat(40), false)) }), 'PAGE_REVISION_UNRESOLVED');
});

test('the page must resolve this build, not another', () => {
  const result = check({ boot: bootstrap(publishing(OTHER)) });
  assert.equal(result.code, 'PAGE_REVISION_MISMATCH');
  assert.equal(result.resolved, OTHER);
});

test('the build commit is the worker stamp, and a given --commit must equal it', () => {
  assert.equal(code({ work: worker(BUILD, '!0') }), 'BUILD_COMMIT_UNKNOWN');
  assert.equal(code({ work: 'self.onmessage=()=>{}' }), 'BUILD_COMMIT_UNKNOWN');
  assert.equal(code({}, OTHER), 'BUILD_COMMIT_MISMATCH');
  assert.equal(code({}, 'C'.repeat(40)), 'COMMIT_INVALID');
  assert.equal(workerStampRevision([worker(BUILD), worker(OTHER)]), null);
});

test('the library must read the published global, and no bundler define except behind a typeof guard', () => {
  // The library as it shipped at an earlier commit: the production bug.
  assert.equal(code({ lib: library(OLD_READER) }), 'LIBRARY_READS_NO_PUBLISHED_STAMP');
  const unguarded = NEW_READER.replace('if (typeof __X6_BUILD_IDENTITY__ !== "undefined") return __X6_BUILD_IDENTITY__;', 'if (__X6_BUILD_IDENTITY__) return __X6_BUILD_IDENTITY__;');
  assert.equal(code({ lib: library(unguarded) }), 'LIBRARY_BARE_DEFINE');
  const pageOnly = NEW_READER.replace('const published = globalThis[PAGE_BUILD_GLOBAL];', 'const published = JSON.parse(__X6_PAGE_STAMP__) ?? globalThis[PAGE_BUILD_GLOBAL];');
  assert.equal(readLibrary(library(pageOnly)).code, 'LIBRARY_BARE_DEFINE');
  const elsewhere = NEW_READER.replace('const PAGE_BUILD_GLOBAL = "__X6_PAGE_BUILD__";', 'const PAGE_BUILD_GLOBAL = "__X6_OTHER__";');
  assert.equal(code({ lib: library(elsewhere) }), 'LIBRARY_READS_NO_PUBLISHED_STAMP');
  // A reader with no define at all, reading the global by its literal name, is the cleanest shape.
  const plain = 'function pageSourceRevision(stamp = globalThis["__X6_PAGE_BUILD__"]) { return stamp?.sourceRevision ?? null; }';
  assert.deepEqual(readLibrary(library(plain)), { ok: true, guardedDefines: 0 });
  assert.equal(functionSource('function a(b = c()) { if (b) { return 1 } return 2 } function d() {}', 'a'), 'function a(b = c()) { if (b) { return 1 } return 2 }');
});

test('a dist without its page, bootstrap, image or library fails by name', () => {
  assert.equal(code({ html: '<!doctype html><script type="module" src="./assets/index.js"></script>' }), 'BOOTSTRAP_MISSING');
  assert.equal(code({ boot: null }), 'BOOTSTRAP_MISSING');
  assert.equal(code({ image: gzipSync(tar({ 'home/auma/x.txt': 'x' })) }), 'LIBRARY_MISSING');
  assert.equal(code({ image: Buffer.from('not gzip') }), 'IMAGE_UNREADABLE');
  assert.equal(code({ lib: library('function other() {}') }), 'LIBRARY_READER_MISSING');
});

test('the check never executes built code: page code that would reach the host does nothing', () => {
  const dir = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), '.built-notice-'));
  const marker = join(dir, 'ran');
  try {
    // The in-lane reviewer's escape from the job-6 realm, followed by a write the host would see.
    const escape = `Object.getPrototypeOf(document).constructor("return process")().getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(marker)},"ran");`;
    const result = check({ boot: bootstrap(`${escape}${publishing()}`), lib: library(`${NEW_READER}\n${escape}`) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(existsSync(marker), false, 'no built code ran');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const source = readFileSync(new URL('./built-notice-check.mjs', import.meta.url), 'utf8');
  for (const power of [/node:vm/, /node:worker_threads/, /node:child_process/, /\beval\s*\(/, /new Function\b/, /\bimport\s*\(/, /runIn\w*Context/]) {
    assert.doesNotMatch(source, power);
  }
});

test('the tar reader follows GNU long names and ustar prefixes', () => {
  const longName = `node_modules/${'a'.repeat(120)}/lib/client.js`;
  assert.equal(readTarMember(tar({ [longName]: 'long' }), longName)?.toString(), 'long');
  const prefixed = tar({ 'client.js': 'short' });
  prefixed.write('node_modules/x/lib', 345, 'utf8');
  assert.equal(readTarMember(prefixed, 'node_modules/x/lib/client.js')?.toString(), 'short');
  assert.equal(readTarMember(tar({ 'a.js': 'a' }), 'b.js'), null);
});

test('the source: the page reads only the small page stamp, published first; the build defines it from two fields', () => {
  const preview = readFileSync(new URL('apps/web/src/preview.ts', repo), 'utf8');
  const vite = readFileSync(new URL('apps/web/vite.config.ts', repo), 'utf8');
  const notice = readFileSync(new URL('packages/client/ui-layout/src/client/spatial/portal/build-notice.ts', repo), 'utf8');
  const name = /export const PAGE_BUILD_GLOBAL = '([A-Z0-9_]+)'/.exec(notice)?.[1];
  assert.equal(name, '__X6_PAGE_BUILD__');
  assert.doesNotMatch(preview, /__X6_BUILD_IDENTITY__/, 'the page never reads the whole build identity');
  assert.match(preview, /typeof __X6_PAGE_STAMP__ === 'string' \? JSON\.parse\(__X6_PAGE_STAMP__\) : null/);
  const publication = preview.indexOf(`Object.defineProperty(globalThis, '${name}'`);
  assert.ok(publication > 0, 'preview.ts publishes the page build');
  assert.ok(publication < preview.indexOf('holdWorkerHostBoot()\n'), 'it is published before the boot starts');
  assert.match(preview, /writable: false, enumerable: false, configurable: false/);
  assert.match(vite, /const pageStamp = JSON\.stringify\(\{ sourceRevision: stamp\.sourceRevision, sourceDirty: stamp\.sourceDirty \}\)/);
  assert.match(vite, /__X6_PAGE_STAMP__: JSON\.stringify\(pageStamp\)/);
  // The library's real reader, its types stripped (tsdown also drops the cast's parentheses), passes the reader check.
  const reader = readLibrary(stripTypeScriptTypes(notice));
  assert.equal(reader.ok, true, JSON.stringify(reader));
});
