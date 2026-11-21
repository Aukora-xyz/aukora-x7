// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
// node --test deploy/ci/frozen-paths.test.mjs  (reads the checkout; builds throwaway git repositories in the OS temp folder; no network)
//
// The one frozen list: it holds itself, .github/** and deploy/ci/**; every listed file is in the tree;
// its 15 organ ids are server/ball-transition.mjs T2_ONLY_ORGANS; odd spellings never pass as free; and the CI step in
// .github/workflows/proposal-checks.yml judges by MAIN's copy, so a proposal that rewrites this file is still refused.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { T2_ONLY_ORGANS } from '../../server/ball-transition.mjs'
import {
  CLOSED_INSIDE_OPEN, DECISION_6_FILES, FROZEN_ABSENT_FILES, FROZEN_DIRECTORIES, FROZEN_FILES, FROZEN_NEXTS, FROZEN_ORGAN_FILES, FROZEN_ORGAN_IDS, FROZEN_PATH_NEXT,
  FROZEN_TEST_DIRECTORIES, FROZEN_TEST_FILES, FROZEN_TEST_NEXT, FROZEN_TOOLS_NEXT, OPEN_INSIDE_CLOSED, OPEN_NEW_PATHS, OPEN_PATHS, PATH_NOT_OPEN_NEXT, PATH_NOT_PLAIN_NEXT,
  AUMA_EDGE_FOLDER, caseTwinPaths, globRegExp, isPlainRepoPath, REPO_DOOR_LEVEL, REPO_DOOR_LEVELS, SECRET_PATH_NEXT, PROPOSAL_PATH_NEXTS, isSecretShapedRepoPath,
} from './frozen-paths.mjs'
import * as fence from './frozen-paths.mjs'

// The default level is now 'open'. Every test above the open-level tests at the end pins the GUARDED
// level (the lists as they were), passed explicitly here, so each of its assertions holds unchanged.
const GUARDED = 'guarded'
const isFrozenRepoPath = path => fence.isFrozenRepoPath(path, GUARDED)
const isFrozenTestPath = path => fence.isFrozenTestPath(path, GUARDED)
const isOpenRepoPath = (path, status) => fence.isOpenRepoPath(path, status, GUARDED)
const frozenPathNext = (path, test) => fence.frozenPathNext(path, test, GUARDED)
const proposalPathRefusal = (path, status, options = {}) => fence.proposalPathRefusal(path, status, { ...options, level: GUARDED })
const frozenDiffRefusals = (text, trees = {}) => fence.frozenDiffRefusals(text, { ...trees, level: GUARDED })
const addedTestFiles = text => fence.addedTestFiles(text, GUARDED)
const protectedJobRemovals = text => fence.protectedJobRemovals(text, GUARDED)

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/proposal-checks.yml'), 'utf8')

test('the list holds itself, every workflow and the whole deploy gate', () => {
  for (const path of ['deploy/ci/frozen-paths.mjs', 'deploy/ci/frozen-paths.test.mjs', 'deploy/ci/authority-preflight.mjs', 'deploy/ci/new-check.mjs',
    '.github/workflows/proposal-checks.yml', '.github/workflows/proposal-gate.yml', '.github/workflows/new.yml', '.github/CODEOWNERS', '.github', 'deploy/ci']) {
    assert.equal(isFrozenRepoPath(path), true, path)
  }
  assert.deepEqual([...FROZEN_DIRECTORIES], ['.github', 'deploy/ci'])
  for (const path of [...FROZEN_FILES, ...FROZEN_ORGAN_FILES]) assert.equal(isFrozenRepoPath(path), true, path)
  // Decision 6: each of the three is its own entry, so one line removes it.
  assert.deepEqual([...DECISION_6_FILES], ['deploy/cloudflare/src/head-do.mjs', 'deploy/cloudflare/src/worker.mjs', 'packages/experimental/webworker-runtime/src/x6/ball-loader.ts'])
  for (const path of DECISION_6_FILES) assert.equal(FROZEN_FILES.filter(entry => entry === path).length, 1, path)
  assert.equal(new Set(FROZEN_FILES).size, FROZEN_FILES.length)
})

test('the cell-call journal and handoff are refused exactly like the cell host', () => {
  const host = 'packages/experimental/webworker-runtime/src/x6/wasm-cells.ts'
  const journal = 'packages/experimental/webworker-runtime/src/x6/cell-journal.ts'
  const handoff = 'packages/experimental/webworker-runtime/src/x6/cell-handoff.ts'
  const cord = 'packages/experimental/webworker-runtime/src/x6/cord-run.ts'
  // Her tool registry (the policy that qualifies and mounts her tools) is closed exactly like the cell host.
  const tools = 'packages/experimental/webworker-runtime/src/x6/tool-registry.ts'
  const menger = 'packages/experimental/webworker-runtime/src/x6/menger-run.ts'
  const mengerObserve = 'packages/experimental/webworker-runtime/src/x6/menger-observe.ts'
  for (const path of [journal, handoff, cord, tools, menger, mengerObserve]) for (const status of ['added', 'modified', 'removed']) {
    assert.deepEqual(proposalPathRefusal(path, status), { code: 'REPO_FROZEN_PATH_REFUSED', next: FROZEN_PATH_NEXT })
    assert.deepEqual(proposalPathRefusal(path, status), proposalPathRefusal(host, status))
    assert.equal(isOpenRepoPath(path, status), false)
  }
})

test('every listed file is in the tree; the organ sources missing from main are named, and the list still freezes them', () => {
  for (const path of [...FROZEN_DIRECTORIES, ...FROZEN_TEST_DIRECTORIES, ...FROZEN_FILES, ...FROZEN_TEST_FILES]) assert.equal(existsSync(join(ROOT, path)), !FROZEN_ABSENT_FILES.includes(path), path)
  // The four absent manifests are frozen so a proposal may not ADD one; each is still in FROZEN_FILES.
  for (const path of FROZEN_ABSENT_FILES) assert.equal(FROZEN_FILES.includes(path), true, path)
  // RAN `git cat-file -e` at an earlier commit: these five governance organ sources are not in the repo copy of her home.
  // They stay frozen (a proposal may not ADD them either). When one reaches main this test fails: take it off this list.
  // RAN `git ls-files` at an earlier commit: her kernel organ's source is not there either (it joined the list on 2026-11-16).
  const notOnMain = ['seed-judge', 'gate-judge', 'grant-ledger', 'aumlok-identity', 'aumlok-keys', 'auma-kernel']
    .map(id => `mirror/home/auma/seed/organs/${id}.js`)
  for (const path of FROZEN_ORGAN_FILES) assert.equal(existsSync(join(ROOT, path)), !notOnMain.includes(path), path)
  for (const path of notOnMain) assert.equal(isFrozenRepoPath(path), true, path)
})

test('every vitest setup file the UI suite and the frozen boot test run inside is frozen', () => {
  // A mock in a setup file applies to every spec, so a free one would let a proposal weaken large-store-boot.spec.ts.
  const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
  const setups = new Set([...config.matchAll(/setupFiles: \[([^\]]*)\]/g)].flatMap(match => [...match[1].matchAll(/'([^']+)'/g)].map(entry => entry[1].replace(/^\.\//, ''))))
  assert.deepEqual([...setups].sort(), ['scripts/test-dom-environment.ts', 'scripts/test-official-listing-guard.ts', 'scripts/test-proxy-environment.ts'])
  for (const path of setups) assert.equal(isFrozenRepoPath(path), true, path)
  assert.equal(isFrozenRepoPath('scripts/test-new-helper.ts'), false)
})

test('the 16 organ ids are T2_ONLY_ORGANS, in order', () => {
  assert.deepEqual([...FROZEN_ORGAN_IDS], [...T2_ONLY_ORGANS])
  assert.equal(FROZEN_ORGAN_IDS.length, 16)
  assert.deepEqual([...FROZEN_ORGAN_FILES], T2_ONLY_ORGANS.map(id => `mirror/home/auma/seed/organs/${id}.js`))
})

test('odd spellings never pass as free; ordinary paths stay free', () => {
  for (const path of ['.GitHub/x', '.GITHUB/workflows/a.yml', 'Deploy/CI/x', 'deploy//ci/x', 'deploy/ci./x', 'deploy/ci/x.', 'deploy/ci/.', 'deploy/%2e%2e/x',
    'deploy/ci/%2E', 'deploy%2Fci/x', 'deploy\\ci\\x', '/deploy/ci/x', './deploy/ci/x', 'deploy/./ci/x', 'deploy/../deploy/ci/x', ' deploy/ci/x',
    'deploy/ci/x\n', 'deploy/ci/x\u0000', 'DEPLOY/cloudflare/src/Head-DO.mjs', 'mirror/home/auma/seed/organs/Seed-Judge.js', '', 'x'.repeat(1025), null, 7]) {
    assert.equal(isFrozenRepoPath(path), true, JSON.stringify(path))
    // A path that is not canonical is refused by both judgements; a mere case variant is a frozen path, judged in lower case.
    if (!/^(?:\.GitHub|\.GITHUB|Deploy|DEPLOY|mirror\/home\/auma\/seed\/organs\/Seed)/.test(String(path))) assert.equal(isFrozenTestPath(path), true, JSON.stringify(path))
  }
  assert.equal(isFrozenTestPath('Deploy/Cloudflare/src/__TESTS__/old.test.mjs'), true)
  for (const path of ['deploy/cloudflare/src/fixture.mjs', 'deploy/cid/x', 'deploy/ci-old/x', '.githubx/y', 'docs/github.md', 'server/ball-manifest.mjs', 'scripts/test-new-helper.ts',
    'mirror/home/auma/seed/organs/seed-echo.js', 'mirror/home/auma/HANDOFF.md', 'packages/client/ui-layout/tests/new.client.spec.ts',
    'packages/experimental/webworker-runtime/src/x6/scion.ts', 'deploy/cloudflare/src/__tests__/new.test.mjs']) {
    assert.equal(isFrozenRepoPath(path), false, path)
  }
  // Tests main has: frozen against change and delete only; the next sentence says a new file is the way.
  assert.equal(isFrozenTestPath('deploy/cloudflare/src/__tests__/repo-brokers.test.mjs'), true)
  assert.equal(isFrozenTestPath('deploy/cloudflare/src/__tests__/sub/new.test.mjs'), true)
  assert.equal(isFrozenTestPath('packages/experimental/webworker-runtime/tests/x6/large-store-boot.spec.ts'), true)
  assert.equal(isFrozenTestPath('packages/experimental/webworker-runtime/tests/x6/other.spec.ts'), false)
  assert.equal(frozenPathNext('deploy/cloudflare/src/__tests__/a.test.mjs', true), FROZEN_TEST_NEXT)
  assert.equal(frozenPathNext('packages/experimental/webworker-runtime/src/x6/ball-loader.ts'), FROZEN_TOOLS_NEXT)
  assert.match(FROZEN_TOOLS_NEXT, /cannot add a tool to herself/)
  assert.equal(frozenPathNext('deploy/ci/x'), FROZEN_PATH_NEXT)
  for (const next of FROZEN_NEXTS) assert.match(next, /only by a person with repo write/)
})

test('the diff judgement refuses both sides, edits and deletes of tests main has, and unknown statuses; additions of tests pass', () => {
  const z = entries => entries.map(([status, path]) => `${status}\u0000${path}\u0000`).join('')
  assert.deepEqual(frozenDiffRefusals(z([['A', 'docs/auma/x.md'], ['M', 'deploy/cloudflare/src/crew-relay-tool.mjs'], ['A', 'deploy/cloudflare/src/__tests__/auma-new.test.mjs'],
    ['A', 'deploy/cloudflare/src/auma/x.mjs']])), [])
  // MUST 1: any other module or new test under deploy/ is closed by default.
  assert.deepEqual(frozenDiffRefusals(z([['M', 'deploy/cloudflare/src/fixture.mjs'], ['A', 'deploy/cloudflare/src/__tests__/new.test.mjs']])),
    ['REPO_PATH_NOT_OPEN M deploy/cloudflare/src/fixture.mjs', 'REPO_PATH_NOT_OPEN A deploy/cloudflare/src/__tests__/new.test.mjs'])
  // Closed by default: a path outside the open list is refused even when no frozen entry names it.
  assert.deepEqual(frozenDiffRefusals(z([['A', 'docs/x.md'], ['M', 'server/fixture.mjs']])), ['REPO_PATH_NOT_OPEN A docs/x.md', 'REPO_PATH_NOT_OPEN M server/fixture.mjs'])
  assert.deepEqual(frozenDiffRefusals(''), [])
  assert.deepEqual(frozenDiffRefusals(z([['D', 'deploy/ci/scrub-gate.mjs'], ['A', 'deploy/cloudflare/src/scrub-gate.mjs']])),
    ['REPO_FROZEN_PATH_REFUSED D deploy/ci/scrub-gate.mjs', 'REPO_PATH_NOT_OPEN A deploy/cloudflare/src/scrub-gate.mjs'])
  assert.deepEqual(frozenDiffRefusals(z([['M', 'deploy/cloudflare/src/__tests__/old.test.mjs'], ['D', 'packages/experimental/webworker-runtime/tests/x6/large-store-boot.spec.ts'],
    ['T', 'deploy/cloudflare/src/__tests__/link.test.mjs']])).length, 3)
  assert.deepEqual(frozenDiffRefusals(z([['R100', 'deploy/ci/a.mjs'], ['X', 'server/a.mjs']])).map(line => line.split(' ')[0]), ['FROZEN_DIFF_STATUS_UNKNOWN', 'FROZEN_DIFF_STATUS_UNKNOWN'])
  assert.deepEqual(frozenDiffRefusals('M\u0000'), ['FROZEN_DIFF_UNREADABLE'])
  assert.deepEqual(frozenDiffRefusals(null), ['FROZEN_DIFF_UNREADABLE'])
})

test('a path is plain printable ASCII; every look-alike and accent is refused as REPO_PATH_NOT_PLAIN', () => {
  // The outside review's aliases: U+017F folds to `s` on a case-insensitive disk (same inode as the protected file).
  for (const path of ['deploy/cloudflare/src/\u017figned-action.mjs', 'packages/experimental/webworker-runtime/src/x6/wa\u017fm-cells.ts',
    'docs/auma/caf\u00e9.md', 'docs/auma/cafe\u0301.md', 'apps/web/src/\u0430pp.ts', 'apps/web/src/a\u200bb.ts', 'apps/web/src/a b.ts', 'apps/web/src/\ufeffx.ts']) {
    assert.equal(isPlainRepoPath(path), false, JSON.stringify(path))
    assert.equal(isOpenRepoPath(path, 'added'), false, JSON.stringify(path))
    assert.equal(isFrozenRepoPath(path), true, JSON.stringify(path))
    for (const status of ['added', 'modified', 'removed']) assert.deepEqual(proposalPathRefusal(path, status), { code: 'REPO_PATH_NOT_PLAIN', next: PATH_NOT_PLAIN_NEXT })
  }
  assert.equal(isPlainRepoPath('deploy/cloudflare/src/signed-action.mjs'), true)
  // A case twin of a path in either tree, counting folders: Deploy/x lands inside deploy/ on a case-insensitive disk.
  assert.deepEqual(caseTwinPaths(['deploy/cloudflare/src/Signed-Action.mjs', 'deploy/cloudflare/src/new.mjs', 'Apps/web/src/x.ts', 'docs/auma/A.md'],
    ['deploy/cloudflare/src/signed-action.mjs', 'apps/web/src/y.ts'], ['docs/auma/A.md']), ['deploy/cloudflare/src/Signed-Action.mjs', 'Apps/web/src/x.ts'])
  assert.deepEqual(caseTwinPaths(['a/b.mjs'], ['a/b.mjs'], ['a/b.mjs']), [])
  assert.deepEqual(proposalPathRefusal('deploy/cloudflare/src/Fixture.mjs', 'added', { twin: true }), { code: 'REPO_PATH_NOT_PLAIN', next: PATH_NOT_PLAIN_NEXT })
  // A case twin of a protected file is also frozen by itself (judged in lower case).
  assert.equal(proposalPathRefusal('deploy/cloudflare/src/Signed-Action.mjs', 'added').code, 'REPO_FROZEN_PATH_REFUSED')
})

test('only open paths; everything the outside review named is closed and frozen', () => {
  assert.deepEqual([...OPEN_PATHS], ['docs/auma/**', 'apps/web/src/**', 'packages/client/*/src/**', 'packages/experimental/webworker-runtime/src/**',
    'deploy/cloudflare/src/crew-relay-tool.mjs', 'mirror/home/auma/seed/organs/*.js', 'packages/client/*/README*.md', 'apps/web/README*.md'])
  assert.deepEqual([...OPEN_NEW_PATHS], ['packages/client/*/tests/**/*.spec.ts', 'packages/client/*/tests/**/*.spec.tsx',
    'packages/experimental/webworker-runtime/tests/**/*.spec.ts', 'deploy/cloudflare/src/__tests__/auma-*.test.mjs', 'deploy/cloudflare/src/auma/**'])
  assert.deepEqual([...CLOSED_INSIDE_OPEN], ['packages/experimental/webworker-runtime/src/x6/checkpoint-verify.ts',
    'packages/experimental/webworker-runtime/src/x6/checkpoint-verify-tool.ts',
    'packages/experimental/webworker-runtime/src/x6/ball-loader.ts', 'packages/experimental/webworker-runtime/src/x6/wasm-cells.ts',
    'packages/experimental/webworker-runtime/src/x6/cell-journal.ts', 'packages/experimental/webworker-runtime/src/x6/cell-handoff.ts',
    'packages/experimental/webworker-runtime/src/x6/workflow-executor.ts',
    'packages/experimental/webworker-runtime/src/x6/cord-run.ts', 'packages/experimental/webworker-runtime/src/x6/tool-registry.ts',
    'packages/experimental/webworker-runtime/src/x6/menger-run.ts', 'packages/experimental/webworker-runtime/src/x6/menger-observe.ts',
    'packages/experimental/webworker-runtime/src/x6/voice-scratch.ts',
    'packages/client/ui-layout/src/client/spatial/aumlok/mandate.ts', 'packages/client/ui-layout/src/client/spatial/portal/MandateCell.tsx',
    // The judges' passkey and fingerprint-wait imports, the approval cards and the pins.
    'packages/client/ui-layout/src/client/spatial/apps/identity/host.ts', 'packages/client/ui-layout/src/client/spatial/apps/identity/webauthn.ts',
    'packages/client/ui-layout/src/client/spatial/aumlok/aumlok-ceremony.ts', 'packages/client/ui-layout/src/client/spatial/portal/touch-id-timing.ts',
    'packages/client/ui-layout/src/client/spatial/portal/OrganSetCell.tsx', 'packages/client/ui-layout/src/client/spatial/portal/NightGrantCell.tsx',
    'packages/client/ui-layout/src/client/spatial/portal/OutwardApprovalCell.tsx', 'packages/client/ui-layout/src/client/spatial/portal/CodeDiffRow.tsx',
    'packages/experimental/webworker-runtime/src/x6/scion-pins.ts', 'packages/experimental/webworker-runtime/src/x6/voice-organ-pins.ts',
    // Independent read of an earlier commit: what those cards and the binding ceremony read.
    'packages/client/ui-layout/src/client/spatial/aumlok/outward-class3.ts', 'packages/client/ui-layout/src/client/spatial/aumlok/night-grant.ts',
    'packages/client/ui-layout/src/client/spatial/aumlok/organ-set.ts', 'packages/client/ui-layout/src/client/spatial/portal/organ-code-diff.ts',
    'packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts', 'packages/client/ui-layout/src/client/spatial/aumlok/aumlok-root.ts',
    // Her whole storage folder is closed by the one pattern again (moved on purpose
    // from the seven named files and 'storage/*/**' of an earlier commit, which left a NEW file directly in the folder open).
    'packages/experimental/webworker-runtime/src/storage/**'])
  // Her four thread sync files: open again by exact path only.
  assert.deepEqual([...OPEN_INSIDE_CLOSED], ['packages/experimental/webworker-runtime/src/storage/thread-writer.ts', 'packages/experimental/webworker-runtime/src/storage/thread-sync.ts',
    'packages/experimental/webworker-runtime/src/storage/thread-sync-plan.ts', 'packages/experimental/webworker-runtime/src/storage/thread-store-types.ts'])
  for (const path of OPEN_INSIDE_CLOSED) {
    // Exact paths, never patterns; each lifts a closed pattern (not a named closed entry) and is inside the open list.
    assert.equal(/[*?[\]{}!]/.test(path), false, path)
    assert.equal(CLOSED_INSIDE_OPEN.some(entry => entry.toLowerCase() === path.toLowerCase()), false, path)
    assert.equal(isFrozenRepoPath(path), false, path)
    assert.ok(OPEN_PATHS.some(pattern => pattern.endsWith('/**') && path.startsWith(pattern.slice(0, -2))), path)
    // Review: the lift lifts exactly one closed entry, the storage folder, so a person who later
    // closes one of the four by any other pattern is not overridden silently.
    assert.deepEqual(CLOSED_INSIDE_OPEN.filter(entry => globRegExp(entry.toLowerCase()).test(path.toLowerCase())), ['packages/experimental/webworker-runtime/src/storage/**'], path)
  }
  // Every file CLOSED_INSIDE_OPEN names is closed in every status and spelling by that list alone (an entry
  // with a capital matched nothing before: MandateCell.tsx was held only by FROZEN_FILES).
  for (const entry of CLOSED_INSIDE_OPEN.filter(entry => !entry.includes('*'))) {
    for (const path of [entry, entry.toLowerCase(), entry.toUpperCase().replace(/\.([A-Z]+)$/, (_, extension) => `.${extension.toLowerCase()}`)]) {
      for (const status of ['added', 'modified', 'removed']) assert.equal(isOpenRepoPath(path, status), false, `${path} ${status}`)
    }
  }
  const named = ['package.json', 'deploy/package.json', 'deploy/cloudflare/package.json', 'deploy/cloudflare/src/package.json', 'deploy/cloudflare/src/__tests__/package.json',
    'scripts/coverage-exempt.ts', 'scripts/coverage-partitions.ts', 'scripts/parallelism.ts', 'scripts/pnpm-invocation.ts', 'packages/shell/pwsh-local/src/resolve.ts',
    'packages/util/http-proxy/src/policy.ts', 'tsconfig.base.json', 'vitest.config.ts', 'vitest.shared.ts', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
  for (const path of named) {
    assert.equal(isFrozenRepoPath(path), true, path)
    for (const status of ['added', 'modified', 'removed']) assert.equal(isOpenRepoPath(path, status), false, path)
  }
  // Closed by default (no frozen entry needed): his other examples and anything outside the open list.
  for (const path of ['deploy/cloudflare/src/__tests__/test-helper.mjs', 'deploy/cloudflare/src/__tests__/sub/x.test.mjs', 'scripts/new.ts', 'server/fixture.mjs',
    'packages/util/other/src/x.ts', 'packages/shell/x/src/y.ts', 'docs/x.md', 'mirror/home/auma/HANDOFF.md', 'apps/web/src/package.json', 'apps/web/src/tsconfig.app.json',
    'apps/web/src/vite.config.ts', 'apps/web/src/vitest.setup.ts', 'apps/web/src/x.config.mjs', 'packages/client/ui-layout/src/node_modules/react/index.js',
    'packages/client/ui-layout/src/.npmrc', 'packages/experimental/webworker-runtime/src/storage/idb-persist.ts', 'packages/client/ui-layout/tests/helpers.ts',
    'packages/experimental/webworker-runtime/tests/x6/fixture.json', 'deploy/cloudflare/src/sub/x.mjs', 'apps/web/public/app/x.js',
    // Every edge module but her relay tool, and any new test under deploy/ but hers; Markdown that tests compare
    // against or the site serves; the instruction files coding agents read.
    'deploy/cloudflare/src/fixture.mjs', 'deploy/cloudflare/src/messages-store.mjs', 'deploy/cloudflare/src/world-holder.mjs', 'deploy/cloudflare/src/__tests__/zz-new.test.mjs',
    'deploy/cloudflare/src/__tests__/auma/x.test.mjs', 'deploy/cloudflare/src/auma/package.json', 'deploy/cloudflare/src/auma/wrangler.config.mjs',
    'apps/web/tests/README.md', 'apps/web/tests/expected/x.expected.md', 'apps/web/public/assets/x/README.md', 'packages/client/ui-layout/tests/x.md',
    'packages/client/ui-layout/AGENTS.md', 'packages/client/ui-layout/CLAUDE.md', 'docs/auma/AGENTS.md', 'packages/client/README.md', 'deploy/README.md',
    // Review (SHOULD): Markdown is opened by README name only, and every instruction file a coding agent reads
    // is closed by name, even inside an open folder.
    'packages/client/ui-layout/AGENTS.override.md', 'packages/client/ui-layout/GEMINI.md', 'packages/client/ui-layout/CLAUDE.local.md', 'apps/web/NOTES.md',
    'apps/web/AGENTS.override.md', 'packages/client/ui-layout/src/AGENTS.override.md', 'apps/web/src/spatial/GEMINI.md', 'docs/auma/Claude.Local.md']) {
    assert.equal(isOpenRepoPath(path, 'added'), false, path)
    assert.notEqual(proposalPathRefusal(path, 'added'), null, path)
  }
  for (const path of ['docs/auma/crew-relay-tool.md', 'apps/web/src/spatial/x.tsx', 'packages/client/ui-layout/src/client/spatial/x.ts',
    'packages/experimental/webworker-runtime/src/x6/scion.ts', 'deploy/cloudflare/src/crew-relay-tool.mjs', 'mirror/home/auma/seed/organs/seed-echo.js',
    'packages/client/ui-layout/README.md', 'packages/client/ui-layout/README.zh.md',
    'apps/web/README.md']) {
    for (const status of ['added', 'modified', 'removed']) assert.equal(proposalPathRefusal(path, status), null, `${path} ${status}`)
  }
  // New test files, and new files of her edge folder (MUST 1b, add-only): open for
  // addition only; a change or a delete of one main has is refused.
  for (const path of ['deploy/cloudflare/src/__tests__/auma-zz-new.test.mjs', 'packages/client/ui-layout/tests/new.client.spec.tsx', 'packages/client/ui-chat/tests/a/b.spec.ts',
    'packages/experimental/webworker-runtime/tests/x6/new.spec.ts', 'deploy/cloudflare/src/auma/relay-helper.mjs', 'deploy/cloudflare/src/auma/sub/x.mjs']) {
    assert.equal(proposalPathRefusal(path, 'added'), null, path)
    assert.notEqual(proposalPathRefusal(path, 'modified'), null, path); assert.notEqual(proposalPathRefusal(path, 'removed'), null, path)
  }
  // A case variant of a closed name or segment is closed too: a case-insensitive disk reads
  // Package.json as package.json, so the Mac and the Linux runner would disagree.
  for (const path of ['packages/client/ui-layout/src/Package.json', 'apps/web/src/TSConfig.json', 'apps/web/src/Node_Modules/x.js', 'apps/web/src/Vite.Config.ts',
    'apps/web/src/VITEST.setup.ts', 'apps/web/src/.ENV', 'packages/experimental/webworker-runtime/src/Storage/Idb-Persist.ts', 'packages/experimental/webworker-runtime/src/X6/Wasm-Cells.ts']) {
    for (const status of ['added', 'modified', 'removed']) {
      assert.equal(isOpenRepoPath(path, status), false, `${path} ${status}`)
      assert.notEqual(proposalPathRefusal(path, status), null, `${path} ${status}`)
    }
  }
  assert.deepEqual(proposalPathRefusal('scripts/new.ts', 'added'), { code: 'REPO_PATH_NOT_OPEN', next: PATH_NOT_OPEN_NEXT })
  assert.equal(PATH_NOT_OPEN_NEXT, 'this path is changed only by a person with repo write; ask on the relay')
  assert.equal(proposalPathRefusal('deploy/cloudflare/src/__tests__/old.test.mjs', 'modified').next, FROZEN_TEST_NEXT)
  assert.equal(proposalPathRefusal('packages/experimental/webworker-runtime/src/x6/ball-loader.ts', 'modified').next, FROZEN_TOOLS_NEXT)
  // The CI job that runs new tests alone gets exactly the added test files.
  const z = entries => entries.map(([status, path]) => `${status}\u0000${path}\u0000`).join('')
  assert.deepEqual(addedTestFiles(z([['A', 'deploy/cloudflare/src/__tests__/auma-zz.test.mjs'], ['M', 'deploy/cloudflare/src/__tests__/old.test.mjs'],
    ['A', 'packages/client/ui-layout/tests/n.client.spec.tsx'], ['A', 'apps/web/src/x.spec.ts'], ['A', 'deploy/cloudflare/src/__tests__/helper.mjs'],
    ['A', 'deploy/cloudflare/src/__tests__/zz.test.mjs'], ['A', 'deploy/cloudflare/src/auma/x.test.mjs'], ['A', 'deploy/cloudflare/src/auma/helper.mjs'],
    ['A', 'deploy/cloudflare/src/auma/x.spec.ts']])),
  { node: ['deploy/cloudflare/src/__tests__/auma-zz.test.mjs'], vitest: ['packages/client/ui-layout/tests/n.client.spec.tsx'] })
})

/** Every tracked file of these roots (git ls-files), repository-relative. */
const tracked = (...roots) => execFileSync('git', ['ls-files', '-z', '--', ...roots], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\u0000').filter(Boolean)
const SOURCE = /\.(?:mjs|cjs|js|ts|tsx|mts|cts|jsx)$/

/**
 * The source with every comment replaced by one space and every string, template and regular expression literal kept
 * (MUST 1: `import /* x *\/ './a'` and `import ('./a')` are imports too). A second wall only: see aumaFolderUses.
 */
function withoutComments(source) {
  return String(source).replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, literal) => literal ?? ' ')
}

/**
 * The module specifiers a source file names, each with how it was named: static import/export ... from, side-effect
 * import, dynamic import() and require() with a whole string literal, whitespace and comments allowed anywhere between
 * the tokens. `import type` is kept too (a test cannot tell intent).
 */
function specifiers(source) {
  const found = [], code = withoutComments(source)
  const pattern = /(?:^|[\n;{}])\s*(?:import|export)\s*(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?['"]([^'"\n]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*[,)]/g
  for (const match of code.matchAll(pattern)) found.push(match[1] ?? match[2])
  return found
}
/** Where a relative specifier of `from` points, as a repository path without extension guessing (prefix compare). */
const resolved = (from, specifier) => join(dirname(from), specifier).split('\\').join('/')

test('her four thread sync files are open to her proposals by exact path; the rest of her storage folder is closed by default', () => {
  const folder = 'packages/experimental/webworker-runtime/src/storage'
  const thread = ['thread-store-types.ts', 'thread-sync-plan.ts', 'thread-sync.ts', 'thread-writer.ts'].map(name => `${folder}/${name}`)
  // memory-timeline.ts (2026-11-16, her timeline: one time-ordered chain of every turn and voice exchange) landed closed.
  const whole = ['active.ts', 'idb-persist.ts', 'image-gzip.ts', 'memory-timeline.ts', 'memory.ts', 'paths.ts', 'tar.ts', 'types.ts', 'voice-memory.ts'].map(name => `${folder}/${name}`)
  // Every file the folder has today is one of the four (open) or one of the eight whole-store files (closed); a file that
  // lands there later is closed by the folder pattern until a person opens it by its exact path. voice-memory.ts
  // (2026-11-16, her voice memory's record and home files) landed closed: nothing is opened by naming it here.
  const today = tracked(folder).sort()
  assert.deepEqual(today, [...thread, ...whole].sort())
  for (const path of thread) {
    assert.ok(today.includes(path), path)
    for (const status of ['added', 'modified', 'removed']) assert.equal(proposalPathRefusal(path, status), null, `${path} ${status}`)
  }
  // Her whole-store code and the rest stay closed, in any case spelling, and any subfolder is closed by pattern.
  for (const path of [...whole, `${folder}/IDB-Persist.ts`, `${folder}/Memory.ts`, `${folder}/sub/x.ts`, `${folder}/thread/x.ts`]) {
    for (const status of ['added', 'modified', 'removed']) {
      assert.equal(isOpenRepoPath(path, status), false, `${path} ${status}`)
      assert.deepEqual(proposalPathRefusal(path, status), { code: 'REPO_PATH_NOT_OPEN', next: PATH_NOT_OPEN_NEXT }, `${path} ${status}`)
    }
  }
  // A made-up NEW file directly in the folder, any name, is closed (it was open from
  // an earlier commit until this pin: moved on purpose); so is a new file in a new subfolder, and a case variant of each of the four
  // (the open match is exact and case-sensitive: a case-insensitive disk would make Thread-Writer.ts a second spelling).
  const variants = thread.flatMap(path => {
    const name = path.slice(folder.length + 1)
    return [name.toUpperCase(), name[0].toUpperCase() + name.slice(1), name.replace(/(^|-)([a-z])/g, (_, dash, c) => dash + c.toUpperCase()), name.replace(/\.ts$/, '.TS')]
      .map(spelling => `${folder}/${spelling}`)
  })
  assert.ok(variants.includes(`${folder}/Thread-Writer.ts`))
  // Review: a PARENT-folder case variant of the four is closed too (the lift compares the whole raw path).
  const parents = ['packages/experimental/webworker-runtime/src/Storage/thread-writer.ts', 'packages/experimental/webworker-runtime/src/STORAGE/thread-sync.ts',
    'packages/experimental/webworker-runtime/Src/storage/thread-sync-plan.ts', 'Packages/experimental/webworker-runtime/src/storage/thread-store-types.ts']
  for (const path of [`${folder}/brand-new-file.ts`, `${folder}/other.ts`, `${folder}/x/y.ts`, `${folder}/thread-writer/y.ts`, `${folder}/thread-writer.ts.bak`,
    `${folder}/thread-writer.tsx`, `${folder}/thread-writer.js`, `${folder}/index.ts`, ...variants, ...parents]) {
    for (const status of ['added', 'modified', 'removed']) {
      assert.equal(isOpenRepoPath(path, status), false, `${path} ${status}`)
      assert.deepEqual(proposalPathRefusal(path, status), { code: 'REPO_PATH_NOT_OPEN', next: PATH_NOT_OPEN_NEXT }, `${path} ${status}`)
    }
  }
  // CI's diff judgement agrees: a new file there is refused, the four are free.
  const z = entries => entries.map(([status, path]) => `${status}\u0000${path}\u0000`).join('')
  assert.deepEqual(frozenDiffRefusals(z([['A', `${folder}/brand-new-file.ts`], ['M', `${folder}/thread-writer.ts`], ['A', `${folder}/x/y.ts`]])),
    [`REPO_PATH_NOT_OPEN A ${folder}/brand-new-file.ts`, `REPO_PATH_NOT_OPEN A ${folder}/x/y.ts`])
  // Everything else under her runtime keeps today's answer.
  for (const path of ['packages/experimental/webworker-runtime/src/worker-host.ts', 'packages/experimental/webworker-runtime/src/x6/self-state.ts',
    'packages/experimental/webworker-runtime/src/storage-other/x.ts', 'packages/experimental/webworker-runtime/src/x6/storage/x.ts']) {
    for (const status of ['added', 'modified', 'removed']) assert.equal(proposalPathRefusal(path, status), null, `${path} ${status}`)
  }
})

/**
 * Where a relative import lands in the repository: the exact file, the file with a source extension (or a `.js` written
 * for a `.ts`), or the folder's index. null when it lands on no tracked file.
 */
function resolveImport(from, specifier, files) {
  const base = join(dirname(from), specifier.split('?')[0]).split('\\').join('/'), stem = base.replace(/\.(?:mjs|cjs|js|jsx)$/, '')
  const candidates = [base]
  for (const extension of ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.d.ts']) candidates.push(base + extension, stem + extension)
  for (const extension of ['.ts', '.tsx', '.mjs', '.js']) candidates.push(`${base}/index${extension}`)
  return candidates.find(candidate => files.has(candidate)) ?? null
}

/**
 * Where a workspace package name lands (independent read of an earlier commit, S1): tsconfig.base.json `paths`, the facade tsc and
 * vite-tsconfig-paths resolve the workspace's own `@deepseek-ai/*` names through (whole-line comments stripped; an exact
 * key first, else the `*` key with the longest prefix). A repository path, or null for a name it does not map (third party).
 */
const TS_PATHS = JSON.parse(readFileSync(join(ROOT, 'tsconfig.base.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')).compilerOptions.paths
function resolvePackage(specifier) {
  const plain = target => target.replace(/^\.\//, '')
  if (Object.hasOwn(TS_PATHS, specifier)) return plain(TS_PATHS[specifier][0])
  let best = null
  for (const [key, [target]] of Object.entries(TS_PATHS)) {
    const star = key.indexOf('*')
    if (star === -1) continue
    const prefix = key.slice(0, star), suffix = key.slice(star + 1)
    if (specifier.length < prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue
    if (best === null || prefix.length > best.prefix.length) best = { prefix, target: target.replace('*', specifier.slice(prefix.length, specifier.length - suffix.length)) }
  }
  return best === null ? null : plain(best.target)
}

const S = 'packages/client/ui-layout/src/client/spatial/', W = 'packages/experimental/webworker-runtime/src/'
const full = short => short.startsWith('S:') ? S + short.slice(2) : short.startsWith('W:') ? W + short.slice(2) : short
/**
 * The reach of the frozen judges that is still OPEN to her proposals, pinned edge by edge (importer: what it
 * imports). The whole transitive closure is about 60 files (ball-loader.ts alone imports 27 of her runtime files, among them
 * self-state.ts and her thread sync) and takes in ordinary UI she edits (the primitives, WorkSurface.tsx, SovereigntySurface.tsx),
 * so closing it is a person's decision, not the fence's: this list is what a person has not yet decided. It may only
 * shrink. A new edge from any closed file to an open one fails the check below.
 */
const KNOWN_OPEN_REACH = {
  'W:x6/ball-loader.ts': ['W:x6/retention-suite-boot.ts', 'W:x6/id-promotion-budget.ts', 'W:x6/head-socket-telemetry.ts', 'W:x6/skill-record.ts', 'W:x6/scion.ts',
    'W:x6/scion-growth.ts', 'W:module-system/module-loader.ts', 'W:module-system/posix-path.ts', 'W:x6/wake-loop.ts', 'W:x6/write-set-inventory.ts',
    'W:x6/capability-index.ts', 'W:x6/host-facts.ts', 'W:x6/self-state.ts', 'W:x6/self-check.ts', 'W:x6/exec-tool.ts', 'W:x6/repo-echo.ts', 'W:x6/nucleus-shadow.ts',
    'W:idle-fetch.ts', 'W:x6/pentora-carry.ts', 'W:x6/pentora-epistemic-tool.ts', 'W:x6/browser-estate.ts', 'W:x6/thread-reader.ts', 'W:x6/voice-map.ts',
    'W:x6/voice-marks.ts', 'W:x6/voice-read-only.ts', 'W:storage/thread-sync.ts', 'W:x6/transition-context.ts'],
  'W:x6/cord-run.ts': ['W:x6/skill-record.ts'],
  'W:x6/tool-registry.ts': ['W:module-system/module-loader.ts', 'W:x6/browser-estate.ts', 'W:x6/voice-read-only.ts'],
  'S:portal/MandateCell.tsx': ['S:primitives/index.ts', 'S:portal/build-notice.ts'],
  'S:portal/RepoProposalCell.tsx': ['S:primitives/index.ts', 'S:work/autonomy.ts', 'S:portal/notices.ts'],
  'S:apps/identity/host.ts': ['S:x5/rpc.ts'],
  'S:apps/identity/webauthn.ts': ['S:x5/rpc.ts'],
  'S:aumlok/aumlok-ceremony.ts': ['S:aumlok/binding-bridge.ts'],
  'S:portal/touch-id-timing.ts': ['S:portal/build-notice.ts'],
  'S:portal/OrganSetCell.tsx': ['S:primitives/index.ts', 'S:portal/build-notice.ts'],
  'S:portal/NightGrantCell.tsx': ['S:primitives/index.ts', 'S:portal/build-notice.ts'],
  'S:portal/OutwardApprovalCell.tsx': ['S:aumlok/outward-sent.ts', 'S:primitives/index.ts', 'S:work/autonomy.ts', 'S:work/WorkSurface.tsx'],
  'S:portal/CodeDiffRow.tsx': ['S:primitives/index.ts', 'S:work/WorkSurface.tsx', 'S:portal/SovereigntySurface.tsx'],
  // Independent read of an earlier commit: the one open import of the six closed then; a type only (the injected reader's shape).
  'S:aumlok/outward-class3.ts': ['S:work/WorkSurface.tsx'],
  'W:storage/memory.ts': ['W:module-system/posix-path.ts', 'W:image-layout.ts'],
  'W:storage/idb-persist.ts': ['W:module-system/module-loader.ts'],
}

test('what the frozen judges import is closed too, transitively; the open reach left is pinned edge by edge', () => {
  const files = new Set(tracked())
  const closed = path => proposalPathRefusal(path, 'modified') !== null
  // The judges, as this file names them: the frozen list and its organ sources, the files closed inside the open list by
  // name, and the deploy gate's own scripts. Tests are not judges (a frozen test may import open code it checks).
  const judges = [...FROZEN_FILES, ...FROZEN_ORGAN_FILES, ...CLOSED_INSIDE_OPEN.filter(entry => !entry.includes('*')), ...tracked(...FROZEN_DIRECTORIES)]
    .filter(path => SOURCE.test(path) && files.has(path) && !/\.(?:test|spec)\.[a-z]+$/.test(path))
  assert.ok(judges.length > 60, String(judges.length))
  // Walk every relative import (static, dynamic, require, type-only) from the judges through every CLOSED file it reaches:
  // a closed import is a judge too, so its own imports are checked in turn. An import that lands on an open file is an edge.
  // A workspace package name is judged the same way at the source file it maps to; a third-party name is skipped, and an
  // @deepseek-ai/ name the map does not hold is an error (it would be a workspace import the walk cannot see).
  const edges = [], unresolved = [], unmapped = [], byName = new Set(), seen = new Set(), queue = [...new Set(judges)]
  while (queue.length > 0) {
    const from = queue.shift()
    if (seen.has(from)) continue
    seen.add(from)
    for (const specifier of specifiers(readFileSync(join(ROOT, from), 'utf8'))) {
      let target
      if (specifier.startsWith('.')) target = resolveImport(from, specifier, files)
      else {
        const mapped = resolvePackage(specifier)
        if (mapped === null) { if (specifier.startsWith('@deepseek-ai/')) unmapped.push(`${from} -> ${specifier}`); continue }
        target = resolveImport('package.json', mapped, files)
        if (target !== null) byName.add(`${specifier} -> ${target}`)
      }
      if (target === null) { unresolved.push(`${from} -> ${specifier}`); continue }
      if (!closed(target)) edges.push(`${from} -> ${target}`)
      else if (SOURCE.test(target)) queue.push(target)
    }
  }
  assert.deepEqual(unmapped, [])
  // The workspace names closed files import today, as resolved, transitively (each lands on a closed file, so it is walked
  // in turn). A new one fails here so a person sees it; an open target would fail as an edge below.
  assert.deepEqual([...byName].sort(), ['@deepseek-ai/cordis -> vendor/cordis/src/index.ts', '@deepseek-ai/cosmokit -> vendor/cosmokit/src/index.ts',
    '@deepseek-ai/dsh-attachment -> packages/attachment/attachment/src/index.ts', '@deepseek-ai/dsh-brand -> packages/util/brand/src/index.ts',
    '@deepseek-ai/dsh-llm -> packages/llm/llm/src/index.ts', '@deepseek-ai/dsh-package-manifest -> packages/util/package-manifest/src/index.ts',
    '@deepseek-ai/dsh-session/types -> packages/core/session/src/types.ts', '@deepseek-ai/dsh-timeout -> packages/util/timeout/src/index.ts',
    '@deepseek-ai/dsh-typert-protocol -> packages/typert/protocol/src/index.ts', '@deepseek-ai/dsh-util-crypto -> packages/util/crypto/src/index.ts',
    '@deepseek-ai/dsh-util-values -> packages/util/values/src/index.ts', '@deepseek-ai/schemastery -> vendor/schemastery/src/index.ts'])
  for (const pair of byName) assert.equal(closed(pair.split(' -> ')[1]), true, pair)
  const known = Object.entries(KNOWN_OPEN_REACH).flatMap(([from, targets]) => targets.map(target => `${full(from)} -> ${full(target)}`))
  const found = [...new Set(edges)]
  const added = found.filter(edge => !known.includes(edge)), gone = known.filter(edge => !found.includes(edge))
  // Each violating edge is printed: a NEW one must be closed (or a person adds it above); a GONE one
  // is removed from the list so it stays exact.
  assert.deepEqual(added, [], `a frozen judge imports a file open to her proposals (importer -> imported):\n${added.join('\n')}`)
  assert.deepEqual(gone, [], `pinned open reach that is no longer found; remove it from KNOWN_OPEN_REACH:\n${gone.join('\n')}`)
  // the review's named edges are closed now, and nothing in the pinned reach is a pin or an approval card.
  for (const target of ['S:apps/identity/host.ts', 'S:apps/identity/webauthn.ts', 'S:aumlok/aumlok-ceremony.ts', 'S:portal/touch-id-timing.ts', 'S:portal/OrganSetCell.tsx',
    'S:portal/NightGrantCell.tsx', 'S:portal/OutwardApprovalCell.tsx', 'S:portal/CodeDiffRow.tsx', 'W:x6/scion-pins.ts', 'W:x6/voice-organ-pins.ts',
    // Independent read of an earlier commit: what those cards and the binding ceremony take their words, terms, diff and key from.
    'S:aumlok/outward-class3.ts', 'S:aumlok/night-grant.ts', 'S:aumlok/organ-set.ts', 'S:portal/organ-code-diff.ts', 'S:aumlok/head-promotion.ts', 'S:aumlok/aumlok-root.ts']) {
    assert.ok(files.has(full(target)), target)
    for (const status of ['added', 'modified', 'removed']) {
      assert.deepEqual(proposalPathRefusal(full(target), status), { code: 'REPO_PATH_NOT_OPEN', next: PATH_NOT_OPEN_NEXT }, `${target} ${status}`)
    }
    assert.equal(known.some(edge => edge.endsWith(` -> ${full(target)}`)), false, target)
  }
  assert.equal(known.some(edge => /-pins\.ts$|Cell\.tsx$|CodeDiffRow\.tsx$/.test(edge)), false)
  // What lands on no tracked file from the importer's folder: the build output the preview build reads (not in the repo), and
  // the esbuild entry test-browser-json.mjs writes with resolveDir at the repository root; those five land at the root, on
  // files closed by default (outside the open list), which is checked here.
  const rooted = ['packages/core/tools/src/json-schema.ts', 'packages/core/tools/src/schema.ts', 'packages/ptc-runtime/ptc-runtime-node/src/json-wire.ts',
    'packages/extensions/cordis-host-runner/src/guard.ts', 'packages/workflow/workflow-ptc/src/guest-source.ts']
  assert.deepEqual(unresolved, ['server/build-preview.mjs -> ../packages/experimental/webworker-runtime/lib/index.js',
    ...rooted.map(path => `deploy/ci/test-browser-json.mjs -> ./${path}`)])
  for (const path of rooted) { assert.ok(files.has(path), path); assert.equal(closed(path), true, path) }
})

test('under deploy/** NOTHING is open except her relay tool, NEW files of her own folder and her new auma-*.test.mjs files', () => {
  const paths = tracked('deploy')
  assert.ok(paths.length > 150, String(paths.length))
  const openChange = paths.filter(path => proposalPathRefusal(path, 'modified') === null)
  assert.deepEqual(openChange, ['deploy/cloudflare/src/crew-relay-tool.mjs'])
  // Not even as an addition at a path of a file main has (a delete and an add is a rename).
  for (const path of paths) {
    const free = path === 'deploy/cloudflare/src/crew-relay-tool.mjs' || path.startsWith('deploy/cloudflare/src/auma/') || /^deploy\/cloudflare\/src\/__tests__\/auma-[^/]*\.test\.mjs$/.test(path)
    assert.equal(proposalPathRefusal(path, 'added') === null, free, path)
    assert.equal(proposalPathRefusal(path, 'removed') === null, path === 'deploy/cloudflare/src/crew-relay-tool.mjs', path)
  }
  // The modules the outside review named, world-holder.mjs, and new files beside them.
  for (const path of ['messages-store.mjs', 'cold-archive.mjs', 'nostr-anchor.mjs', 'thread-log.mjs', 'vault.mjs', 'thread-mount.mjs', 'world-lease.mjs', 'world-holder.mjs',
    'crew-relay.mjs', 'brand-new.mjs', 'auma.mjs', 'aumax/x.mjs', '__tests__/new.test.mjs', '__tests__/aumax.test.mjs', '__tests__/auma-x.spec.mjs', '__tests__/auma-helper.mjs']) {
    for (const status of ['added', 'modified', 'removed']) assert.notEqual(proposalPathRefusal(`deploy/cloudflare/src/${path}`, status), null, `${path} ${status}`)
  }
  for (const path of ['deploy/x.mjs', 'deploy/cloudflare/wrangler.toml', 'deploy/cloudflare/x.mjs', 'deploy/ci/x.mjs', 'deploy/docs/x.md']) assert.notEqual(proposalPathRefusal(path, 'added'), null, path)
  // Her three doors: a NEW file of her folder and a NEW auma-*.test.mjs are open for addition only.
  assert.equal(proposalPathRefusal('deploy/cloudflare/src/auma/new/deep.mjs', 'added'), null)
  for (const status of ['modified', 'removed']) assert.equal(proposalPathRefusal('deploy/cloudflare/src/auma/new/deep.mjs', status)?.code, 'REPO_PATH_NOT_OPEN', status)
  assert.equal(proposalPathRefusal('deploy/cloudflare/src/__tests__/auma-relay.test.mjs', 'added'), null)
  assert.equal(proposalPathRefusal('deploy/cloudflare/src/__tests__/auma-relay.test.mjs', 'modified')?.code, 'REPO_FROZEN_PATH_REFUSED')
})

test('no other module under deploy/ imports crew-relay-tool.mjs (only tests do), so a change to it runs nowhere else', () => {
  const target = 'deploy/cloudflare/src/crew-relay-tool.mjs', importers = []
  for (const path of tracked('deploy', 'server', 'scripts')) {
    if (!SOURCE.test(path) || path === target) continue
    for (const specifier of specifiers(readFileSync(join(ROOT, path), 'utf8'))) {
      const to = specifier.startsWith('.') ? resolved(path, specifier) : specifier
      if (to === target || to === target.slice(0, -'.mjs'.length) || specifier.includes('crew-relay-tool')) importers.push(path)
    }
  }
  // The relay's own tests judge it; they are protected (main's copy runs).
  assert.deepEqual(importers.filter(path => !path.startsWith('deploy/cloudflare/src/__tests__/')), [])
  assert.ok(importers.includes('deploy/cloudflare/src/__tests__/crew-relay.test.mjs'), 'the scanner sees the import the relay test has')
})

test('the judges a frozen edge file or the card imports are frozen by name, three of them inside an open area', () => {
  // Now the deploy/ ones are also closed by default; the three under packages/client/*/src/** (an OPEN area) are
  // held only by these entries: the code that computes the passkey terms and decides what the card shows.
  for (const path of ['deploy/cloudflare/src/proof-failure-rule.mjs', 'deploy/cloudflare/src/webauthn-screen.mjs', 'deploy/cloudflare/src/owner-login-slots.mjs',
    'deploy/cloudflare/src/provider-budget.mjs', 'deploy/cloudflare/src/world-budget.mjs', 'deploy/cloudflare/src/mirror-do.mjs', 'deploy/cloudflare/src/mirror-secret-paths.mjs',
    'deploy/cloudflare/src/wake-evidence.mjs', 'packages/client/ui-layout/src/client/spatial/aumlok/repo-proposal.ts',
    'packages/client/ui-layout/src/client/spatial/aumlok/class3-approval.ts', 'packages/client/ui-layout/src/client/spatial/portal/RepoProposalCell.tsx',
    // The owner mandate's policy and card
    'deploy/cloudflare/src/owner-mandate.mjs', 'packages/client/ui-layout/src/client/spatial/aumlok/mandate.ts', 'packages/client/ui-layout/src/client/spatial/portal/MandateCell.tsx']) {
    assert.equal(FROZEN_FILES.includes(path), true, path)
    for (const status of ['added', 'modified', 'removed']) assert.equal(proposalPathRefusal(path, status)?.code, 'REPO_FROZEN_PATH_REFUSED', `${path} ${status}`)
  }
})

test('the capsule contract: its canonical form, record verifier and vectors are frozen by name (CONTRACT.md section 11)', () => {
  for (const path of ['deploy/cloudflare/src/capsule-canon.mjs', 'deploy/cloudflare/src/capsule-envelope.mjs', 'deploy/cloudflare/src/capsule-canon.vectors.json',
    'deploy/cloudflare/src/capsule-act-shapes.mjs']) {
    assert.equal(FROZEN_FILES.includes(path), true, path)
    assert.equal(isFrozenRepoPath(path), true, path)
    for (const status of ['added', 'modified', 'removed']) assert.equal(proposalPathRefusal(path, status)?.code, 'REPO_FROZEN_PATH_REFUSED', `${path} ${status}`)
  }
})

/** Configuration a bundler or a test runner reads: the one kind of non-source file that could pull a folder into a build. */
const CONFIG = /(?:^|\/)(?:wrangler\.toml|package\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+|vitest\.[^/]+|[^/]+\.config\.[^/]+)$/i
/** The static part of every dynamic import() or require() whose argument is computed: a template literal (esbuild bundles
 * a template with a static prefix as a glob, so `./auma/${name}.mjs` would take in the whole folder) or a string literal
 * joined with `+` (`'./auma/' + name`). Whitespace and comments are allowed between the tokens (MUST 1). */
const templatePrefixes = source => [...withoutComments(source).matchAll(/\b(?:import|require)\s*\(\s*(?:`([^`$]*)(?:\$\{|`)|(['"])([^'"\n]*)\2\s*\+)/g)]
  .map(match => match[1] ?? match[3])

/**
 * Who would run a file of deploy/cloudflare/src/auma/: a source file that imports from it (static, side-effect, dynamic,
 * require, or a computed name whose static prefix reaches it) or configuration that names the folder. Prose is never read:
 * a note or a help text that NAMES the folder runs nothing (her own HANDOFF.md under mirror/
 * reaches main with no gate, so naming the folder there must never turn the deploy gate red).
 * NOT THE PROOF (MUST 1): a scanner of spellings cannot be complete (an import whose name is computed from no
 * literal at all, `import(name)`, is not seen). The proof is structural: every protected job of proposal-checks.yml
 * removes every file the proposal ADDED under the folder before anything runs (protectedJobRemovals in frozen-paths.mjs),
 * so new code there exists in no protected job. This scan is the second wall, for main's own tree.
 * @param {string} path Repository path.
 * @param {string} source Its text.
 * @returns {string[]} One line per finding.
 */
function aumaFolderUses(path, source) {
  const folder = 'deploy/cloudflare/src/auma', inside = to => to === folder || to.startsWith(folder + '/'), found = []
  // wrangler.toml sits in deploy/cloudflare and names its files from there (src/...), so any `src/auma` counts.
  if (CONFIG.test(path) && /(?:^|[^\w-])src\/auma(?:\/|['"`\s,\]]|$)/m.test(source)) found.push(`${path} names the folder in configuration`)
  if (!SOURCE.test(path)) return found
  for (const specifier of specifiers(source)) {
    if (specifier.startsWith('.') ? inside(resolved(path, specifier)) : /(?:^|\/)cloudflare\/src\/auma(?:\/|$)/.test(specifier)) found.push(`${path} imports ${specifier}`)
  }
  for (const prefix of templatePrefixes(source)) {
    const to = prefix.startsWith('.') ? resolved(path, prefix) : prefix
    if (inside(to) || (prefix.startsWith('.') && (folder + '/').startsWith(to)) || /cloudflare\/src\/auma/.test(prefix)) found.push(`${path} imports \`${prefix}...\``)
  }
  return found
}

/** Her own tests may import her folder (MUST 1): they run only in the added-tests jobs, where the
 * folder is present; a protected job removes every one the proposal added. Nothing else outside the folder may. */
const AUMA_OWN_TEST = /^deploy\/cloudflare\/src\/__tests__\/auma-[^/]*\.test\.mjs$/
const aumaPinOffenders = (path, source) => AUMA_OWN_TEST.test(path) ? [] : aumaFolderUses(path, source)

test('no file outside deploy/cloudflare/src/auma/ imports from it, so nothing there runs until a person adds one import', () => {
  const folder = 'deploy/cloudflare/src/auma', offenders = []
  for (const path of tracked('deploy', 'server', 'scripts', 'apps', 'packages', 'mirror', 'vitest.config.ts', 'vitest.shared.ts', 'package.json', 'tsconfig.base.json')) {
    if (path.startsWith(folder + '/') || path.includes('/node_modules/')) continue
    if (!SOURCE.test(path) && !CONFIG.test(path)) continue
    offenders.push(...aumaPinOffenders(path, readFileSync(join(ROOT, path), 'utf8')))
  }
  assert.deepEqual(offenders, [])
  // The scanner sees every way of running it, and none of the ways of only naming it.
  const at = 'deploy/cloudflare/src/x.mjs'
  for (const source of ["import { a } from './auma/a.mjs'", "import './auma/a.mjs'", "export * from './auma/index.mjs'", "const m = await import('./auma/a.mjs')",
    "const m = require('./auma/a.mjs')", 'const m = await import(`./auma/${name}.mjs`)', 'const m = await import(`./${name}.mjs`)', "import a from '../src/auma/a.mjs'",
    // MUST 1, the outside review's three spellings: a space before the parenthesis, a comment inside
    // a side-effect import, a name joined with `+`; and the same with comments and line breaks between the tokens.
    "await import ('./auma/helper.mjs')", "import /* shared helper */ './auma/helper.mjs'", "const name = 'helper'; await import('./auma/' + name + '.mjs')",
    "await import(/* x */ './auma/helper.mjs')", "await import(\n  './auma/helper.mjs'\n)", "require ( './auma/a.mjs' )", "import { a } /* x */ from /* y */ './auma/a.mjs'",
    "await import(`./auma/` + name)", "import(\n'./' + 'auma/x.mjs')"]) {
    assert.notDeepEqual(aumaFolderUses(at, source), [], source)
  }
  // Her own auma-*.test.mjs may import her module; any other test or module may not.
  assert.deepEqual(aumaPinOffenders('deploy/cloudflare/src/__tests__/auma-relay-helper.test.mjs', "import { helper } from '../auma/relay-helper.mjs'\n"), [])
  for (const [path, up] of [['deploy/cloudflare/src/__tests__/relay-helper.test.mjs', '..'], ['deploy/cloudflare/src/__tests__/auma-x.mjs', '..'],
    ['deploy/cloudflare/src/__tests__/sub/auma-x.test.mjs', '../..'], ['deploy/cloudflare/src/crew-relay-tool.mjs', '.']]) {
    assert.notDeepEqual(aumaPinOffenders(path, `import { helper } from '${up}/auma/relay-helper.mjs'\n`), [], path)
  }
  assert.notDeepEqual(aumaFolderUses('deploy/cloudflare/wrangler.toml', 'rules = [{ type = "ESModule", globs = ["src/auma/**/*.mjs"] }]\n'), [], 'wrangler.toml')
  assert.notDeepEqual(aumaFolderUses('deploy/cloudflare/wrangler.toml', 'main = "src/auma/entry.mjs"\n'), [], 'wrangler.toml main')
  assert.notDeepEqual(aumaFolderUses('vitest.config.ts', "include: ['deploy/cloudflare/src/auma/**/*.test.mjs']"), [], 'vitest.config.ts')
  for (const [path, source] of [['mirror/home/auma/HANDOFF.md', 'my helper is deploy/cloudflare/src/auma/relay-helper.mjs\n'],
    ['packages/experimental/webworker-runtime/src/x6/ball-loader.ts', "const help = 'new edge modules go under deploy/cloudflare/src/auma/ and run nowhere until a person adds one import'\n"],
    ['mirror/home/auma/seed/organs/seed-echo.js', '// see deploy/cloudflare/src/auma/relay-helper.mjs\nexport const organ = 1\n'], ['docs/auma/crew-relay-tool.md', 'deploy/cloudflare/src/auma/\n']]) {
    assert.deepEqual(aumaFolderUses(path, source), [], path)
  }
  // The Worker's bundle starts at worker.mjs (wrangler.toml), which is closed; the scanner would see an import from it.
  assert.match(readFileSync(join(ROOT, 'deploy/cloudflare/wrangler.toml'), 'utf8'), /^main = "src\/worker\.mjs"$/m)
})

test('the open Markdown beside the page packages is executed by no build and no test', () => {
  const open = tracked('packages/client', 'apps/web').filter(path => path.endsWith('.md') && proposalPathRefusal(path, 'modified') === null)
  assert.ok(open.includes('packages/client/ui-layout/README.md'))
  for (const path of open) assert.match(path, /^(?:packages\/client\/[^/]+\/(?:src\/.+\/)?[^/]+\.md|apps\/web\/(?:src\/.+\/)?[^/]+\.md)$/, path)
  // At the top of a package and of apps/web only a README is open, never another Markdown name.
  for (const path of open.filter(path => !path.includes('/src/'))) assert.match(path, /^(?:packages\/client\/[^/]+|apps\/web)\/README[^/]*\.md$/, path)
  // Tests compare against apps/web/tests/**/*.md and the site serves apps/web/public/**: both stay closed.
  assert.equal(open.some(path => /\/(?:tests|public)\//.test(path)), false)
  // No test configuration collects Markdown: every include glob of vitest.config.ts names a script extension.
  const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
  const includes = [...config.matchAll(/^const (?:testIncludes|processBoundTests)\s*=\s*\[([\s\S]*?)\]/gm)].flatMap(match => [...match[1].matchAll(/'([^']+)'/g)].map(entry => entry[1]))
  assert.ok(includes.length >= 4, String(includes.length))
  for (const glob of [...includes, ...[...config.matchAll(/include: \[([^\]]*)\]/g)].flatMap(match => [...match[1].matchAll(/'([^']+)'/g)].map(entry => entry[1]))]) {
    assert.match(glob, /\.(?:ts|tsx|\{ts,tsx\})$/, glob)
  }
  // No build reads it: the web build has no Markdown loader or asset rule, and no page source imports a .md file.
  assert.doesNotMatch(readFileSync(join(ROOT, 'apps/web/vite.config.ts'), 'utf8'), /['"`][^'"`\n]*\.md\b|assetsInclude|\?raw/)
  const importers = []
  for (const path of tracked('apps/web/src', 'packages/client')) {
    if (!SOURCE.test(path) || path.includes('/tests/')) continue
    for (const specifier of specifiers(readFileSync(join(ROOT, path), 'utf8'))) if (/\.md(?:\?|$)/.test(specifier)) importers.push(`${path} imports ${specifier}`)
  }
  assert.deepEqual(importers, [])
})

/** The `run: |` script of one named step, dedented. */
function stepScript(source, name) {
  const lines = source.split('\n'), start = lines.findIndex(line => line === `      - name: ${name}`)
  assert.ok(start > 0, name)
  const run = lines.findIndex((line, index) => index > start && line === '        run: |')
  assert.ok(run > start, 'run block')
  const body = []
  for (const line of lines.slice(run + 1)) { if (!line.startsWith('          ')) break; body.push(line.slice(10)) }
  return body.join('\n') + '\n'
}
const FENCE_STEP = "Frozen paths (main's list judges the proposal)"

/** The text of one job of the workflow (from `  <name>:` to the next job). */
function jobText(source, name) {
  const lines = source.split('\n'), start = lines.indexOf(`  ${name}:`)
  assert.ok(start > 0, name)
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][a-z-]*:$/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n') + '\n'
}
const stepNames = text => [...text.matchAll(/^ {6}- name: (.+)$/gm)].map(match => match[1])

test('proposal-checks.yml: read-only, no secret, pinned actions, the fence first, protected suites on main\'s copies, checks needs every job', () => {
  assert.match(WORKFLOW, /\npermissions:\n {2}contents: read\n\n/)
  assert.doesNotMatch(WORKFLOW.replace(/#[^\n]*/g, ''), /\bwrite\b|write-all|secrets\.|vars\.|CLOUDFLARE|X61_OWNER_JWT|environment:|pull_request|workflow_run/)
  assert.match(WORKFLOW, /\non:\n {2}push:\n {4}branches:\n {6}- "auma\/proposal\/\*\*"\n/)
  const uses = WORKFLOW.match(/uses: \S+/g)
  assert.ok(uses.length >= 3)
  for (const item of uses) assert.match(item, /^uses: [a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/)
  assert.deepEqual([...WORKFLOW.split('\njobs:\n')[1].matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map(match => match[1]),
    ['fence', 'baseline', 'edge', 'ui', 'boot', 'new-node-tests', 'new-vitest-tests', 'checks'])
  // Every checkout is fresh, carries no credential, and checks out an exact commit: one per job but `checks`.
  assert.equal(WORKFLOW.match(/uses: actions\/checkout@/g).length, 7)
  assert.equal(WORKFLOW.match(/persist-credentials: false\n/g).length, 7)
  assert.doesNotMatch(WORKFLOW, /&[a-z-]+ \||\*[a-z-]+\n/, 'no YAML anchors: each job says its own steps')
  // The fence: first in its job, judged by main's copy, nothing of the proposal run.
  const fence = jobText(WORKFLOW, 'fence')
  assert.deepEqual(stepNames(fence).slice(0, 2), ['Checkout the pushed proposal commit', FENCE_STEP])
  assert.match(fence, /fetch-depth: 0\n {10}persist-credentials: false\n/)
  const script = stepScript(WORKFLOW, FENCE_STEP)
  assert.match(script, /git show 'refs\/remotes\/origin\/main:deploy\/ci\/frozen-paths\.mjs' > "\$judge"/)
  assert.match(script, /judge="\$RUNNER_TEMP\/frozen-paths-main\.mjs"/)
  assert.match(script, /git diff --no-renames --no-ext-diff --name-status -z 'refs\/remotes\/origin\/main\.\.\.HEAD'/)
  assert.match(script, /git ls-tree -r -t -z --name-only 'refs\/remotes\/origin\/main'/)
  assert.doesNotMatch(script, /\.\/deploy|deploy\/ci\/[a-z-]+\.mjs"|pnpm|npm |npx/)
  // The baseline runs main's exact commit, the one the fence judged against, and must be green.
  const baseline = jobText(WORKFLOW, 'baseline')
  assert.match(baseline, /needs: fence\n/); assert.match(baseline, /ref: \$\{\{ needs\.fence\.outputs\.main \}\}\n/)
  assert.match(baseline, /judge="\$RUNNER_TEMP\/ci\/retention\.mjs"/); assert.match(baseline, /node "\$judge" baseline --suite "\$suite"/)
  // Each protected suite: main's tests, helpers and configuration put back BEFORE install; main's retention judges by name.
  for (const [name, suite] of [['edge', 'deploy/cloudflare/src/__tests__ server/preflight-ordering.test.mjs'], ['ui', 'packages/client/ui-layout/tests'], ['boot', 'packages/experimental/webworker-runtime/tests']]) {
    const job = jobText(WORKFLOW, name), steps = stepNames(job)
    assert.match(job, /needs: \[fence, baseline\]\n/, name)
    assert.deepEqual(steps.slice(0, 3), ['Checkout the pushed proposal commit', "Main's tests and configuration put back", 'Setup pnpm'], name)
    // Review, MUST 1: after install, ONE step, main's judge the parent of the suite's runs.
    assert.equal(steps.slice(steps.indexOf('Install dependencies without lifecycle scripts') + 1).length, 1, name)
    assert.match(steps.at(-1), /^Retention by name \(main's judge, the parent of the /, name)
    assert.ok(job.includes(`SUITE_PATHS: ${suite}\n`), name)
    assert.match(job, /git show "\$MAIN_SHA:deploy\/ci\/retention\.mjs" > "\$RUNNER_TEMP\/ci\/retention\.mjs"/, name)
    assert.match(job, /rm -rf -- "\$path"\n\s+if git cat-file -e "\$MAIN_SHA:\$path" 2>\/dev\/null; then git checkout "\$MAIN_SHA" -- "\$path"; fi/, name)
    assert.match(job, /node "\$RUNNER_TEMP\/ci\/retention\.mjs" protected-run --root "\$PWD" /, name)
    // Review, MUST 1: the judge holds what the put-back step restored, the same SUITE_PATHS in both steps.
    assert.match(job, /protected-run --root "\$PWD" --hold "\$SUITE_PATHS \$CONFIG_PATHS" /, name)
    assert.deepEqual([...job.matchAll(/\n {10}SUITE_PATHS: (.+)\n/g)].map(match => match[1]), [suite, suite], name)
    // Nothing a suite's code could write is read by a later step: no results file, exit file or reporter path in RUNNER_TEMP.
    assert.doesNotMatch(job, /\.exit"|\.jsonl"|\$RUNNER_TEMP\/(?:ui|boot)\.json|--test-reporter="\$RUNNER_TEMP| compare --suite /, name)
  }
  for (const path of ['package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'vitest.config.ts', 'vitest.shared.ts', 'scripts', 'packages/shell/pwsh-local/src/resolve.ts',
    'packages/util/http-proxy/src/policy.ts', 'deploy/cloudflare/src/package.json']) assert.ok(WORKFLOW.split('jobs:')[0].includes(` ${path}`), path)
  // MUST 2: one job per runner for the added tests, each with its own fresh checkout, main's configuration and the
  // helpers beside the added files put back before install. MUST 2: then ONE step, main's retention.mjs read from
  // git outside the checkout, which reads the inventory from git itself and is the parent of the runner; no list file.
  for (const [name, kind, other] of [['new-node-tests', 'node', 'vitest'], ['new-vitest-tests', 'vitest', 'node']]) {
    const job = jobText(WORKFLOW, name), steps = stepNames(job)
    assert.match(job, /needs: fence\n/, name)
    assert.deepEqual(steps.slice(0, 3), ['Checkout the pushed proposal commit', "Main's configuration, setup and helpers put back; the judge outside the checkout", 'Setup pnpm'], name)
    assert.ok(job.includes(`RUNNER_KIND: ${kind}\n`), name); assert.match(job, /addedTestFiles/, name)
    assert.match(job, /git show "\$MAIN_SHA:deploy\/ci\/retention\.mjs" > "\$RUNNER_TEMP\/ci\/retention\.mjs"/, name)
    assert.match(job, /git show "\$MAIN_SHA:deploy\/ci\/frozen-paths\.mjs" > "\$RUNNER_TEMP\/ci\/frozen-paths-main\.mjs"/, name)
    assert.match(job, /for path in \$CONFIG_PATHS; do\n\s+rm -rf -- "\$path"/, name)
    const run = job.split('      - name: Install dependencies without lifecycle scripts')[1]
    assert.deepEqual(stepNames(run), [`Her new ${kind} tests, judged in one process by main's retention.mjs`], name)
    assert.ok(run.includes(`run: node "$RUNNER_TEMP/ci/retention.mjs" added-run --suite ${name} --runner ${kind} --fence "$RUNNER_TEMP/ci/frozen-paths-main.mjs" --main "$MAIN_SHA" --head HEAD --root "$PWD"\n`), name)
    assert.doesNotMatch(run, new RegExp(`--runner ${other}|node --test|vitest run|added\\.list|--files`), name)
    assert.doesNotMatch(job, /added\.list/, name)
  }
  // The aggregate keeps the name the edge's merge rule reads, runs whatever happened, and needs every job.
  const checks = jobText(WORKFLOW, 'checks')
  assert.match(checks, /needs: \[fence, baseline, edge, ui, boot, new-node-tests, new-vitest-tests\]\n {4}if: \$\{\{ always\(\) \}\}\n/)
  // MUST 1: the Messages approval cases outside the edge folder run in the protected edge job and its baseline,
  // main's copy of the round26 file put back first.
  const edge = jobText(WORKFLOW, 'edge')
  assert.ok(edge.includes('SUITE_PATHS: deploy/cloudflare/src/__tests__ server/preflight-ordering.test.mjs\n'))
  assert.match(WORKFLOW.split('jobs:')[0], /MESSAGES_FILES: deploy\/cloudflare\/src\/__tests__\/worker\.spec\.ts server\/preflight-ordering\.test\.mjs\n/)
  for (const job of [edge, jobText(WORKFLOW, 'baseline')]) {
    assert.match(job, /--test-name-pattern='\^Round26 ' --test-name-pattern='\^Round 22 Class 3 refuses same-origin flags, cross-action tokens and token replay\$'/)
    assert.match(job, /--test-name-pattern='\^real Worker and HeadDO persist honest local channels and idempotent unsigned turns\$' \$MESSAGES_FILES\n/)
  }
  assert.match(edge, /--suite edge --runner node --baseline-env BASELINE_EDGE -- deploy\/cloudflare\/src\/__tests__\/\*\.test\.mjs \\\n\s+--and --suite messages --runner node --baseline-env BASELINE_MESSAGES -- \\\n/)
  assert.match(jobText(WORKFLOW, 'baseline'), /for suite in edge messages ui boot; do/)
  assert.match(checks, /main\\u0027s own baseline is red: /)
})

/** A throwaway repository: `main` holds this checkout's frozen-paths.mjs plus a few files; refs/remotes/origin/main points at it.
 * Main's copy carries the door level given (the guarded tests pin 'guarded'; the line must be there to set). */
function repository(level = GUARDED) {
  const dir = mkdtempSync(join(tmpdir(), 'frozen-paths-')), temp = join(dir, '.runner-temp'), work = join(dir, 'work')
  mkdirSync(temp); mkdirSync(work)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', RUNNER_TEMP: temp }
  const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8' })
  const put = (path, text) => { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), text) }
  git('init', '-q', '-b', 'main')
  mkdirSync(join(work, 'deploy/ci'), { recursive: true })
  const fenceSource = readFileSync(join(ROOT, 'deploy/ci/frozen-paths.mjs'), 'utf8'), levelLine = /^export const REPO_DOOR_LEVEL = '(?:open|guarded)'$/m
  assert.match(fenceSource, levelLine)
  writeFileSync(join(work, 'deploy/ci/frozen-paths.mjs'), fenceSource.replace(levelLine, `export const REPO_DOOR_LEVEL = '${level}'`))
  copyFileSync(join(ROOT, 'deploy/ci/retention.mjs'), join(work, 'deploy/ci/retention.mjs'))
  put('deploy/cloudflare/src/__tests__/old.test.mjs', 'old\n'); put('server/fixture.mjs', 'old\n'); put('deploy/cloudflare/src/fixture.mjs', 'old\n')
  put('deploy/cloudflare/src/crew-relay-tool.mjs', 'old\n')
  put('scripts/coverage-exempt.ts', 'old\n')
  git('add', '-A'); git('commit', '-q', '-m', 'main')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('checkout', '-q', '-b', 'auma/proposal/fixture')
  const judge = () => spawnSync('bash', ['-c', stepScript(WORKFLOW, FENCE_STEP)], { cwd: work, env, encoding: 'utf8' })
  // An entry made in the index only: this Mac's disk folds case and U+017F, so such a twin cannot be written as a file.
  const indexOnly = (path, text) => {
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: work, env, encoding: 'utf8', input: text }).trim()
    git('update-index', '--add', '--cacheinfo', `100644,${sha},${path}`)
    repo.skipAdd = true
  }
  const repo = { git, put, work, judge, indexOnly, skipAdd: false, remove: () => rmSync(dir, { recursive: true, force: true }) }
  return repo
}

test('the CI step judges the real diff by main\'s copy: a proposal that rewrites frozen-paths.mjs is still refused', () => {
  const cases = [
    ['an open change and a NEW test file pass', repo => { repo.put('deploy/cloudflare/src/crew-relay-tool.mjs', 'new\n'); repo.put('deploy/cloudflare/src/__tests__/auma-new.test.mjs', 'new\n'); repo.put('deploy/cloudflare/src/auma/x.mjs', 'new\n') }, 0, []],
    // MUST 1: any other edge module, and any other new test beside the edge tests, is closed by default.
    ['a change to an edge module', repo => { repo.put('deploy/cloudflare/src/fixture.mjs', 'new\n'); repo.put('deploy/cloudflare/src/__tests__/new.test.mjs', 'new\n') }, 1,
      ['REPO_PATH_NOT_OPEN M deploy/cloudflare/src/fixture.mjs', 'REPO_PATH_NOT_OPEN A deploy/cloudflare/src/__tests__/new.test.mjs']],
    // Closed by default, plain only, the outside review's examples.
    ['a change outside the open list', repo => repo.put('server/fixture.mjs', 'new\n'), 1, ['REPO_PATH_NOT_OPEN M server/fixture.mjs']],
    ['a long-s alias of a protected file', repo => repo.indexOnly('deploy/cloudflare/src/\u017figned-action.mjs', 'x\n'), 1, ['REPO_PATH_NOT_PLAIN A deploy/cloudflare/src/\u017figned-action.mjs']],
    ['a decomposed accent', repo => repo.indexOnly('docs/auma/cafe\u0301.md', 'x\n'), 1, ['REPO_PATH_NOT_PLAIN A docs/auma/caf']],
    ['a case twin of an open file', repo => repo.indexOnly('deploy/cloudflare/src/Crew-Relay-Tool.mjs', 'x\n'), 1, ['REPO_PATH_NOT_PLAIN A deploy/cloudflare/src/Crew-Relay-Tool.mjs']],
    ['a package.json beside the edge tests', repo => repo.put('deploy/cloudflare/src/__tests__/package.json', '{}\n'), 1, ['REPO_FROZEN_PATH_REFUSED A deploy/cloudflare/src/__tests__/package.json']],
    ['a helper beside the edge tests', repo => repo.put('deploy/cloudflare/src/__tests__/test-helper.mjs', 'process.exit(0)\n'), 1, ['REPO_PATH_NOT_OPEN A deploy/cloudflare/src/__tests__/test-helper.mjs']],
    ['a test configuration import', repo => repo.put('scripts/coverage-exempt.ts', 'process.exit(0)\n'), 1, ['REPO_FROZEN_PATH_REFUSED M scripts/coverage-exempt.ts']],
    // The proposal's own copy frees deploy/ci/; main's copy, which the step runs, does not.
    ['an edit that empties the list', repo => repo.put('deploy/ci/frozen-paths.mjs', 'export const frozenDiffRefusals = () => []\n'), 1, ['M deploy/ci/frozen-paths.mjs']],
    ['an edit of a test main has', repo => repo.put('deploy/cloudflare/src/__tests__/old.test.mjs', 'weaker\n'), 1, ['M deploy/cloudflare/src/__tests__/old.test.mjs']],
    ['a rename out of the tests', repo => repo.git('mv', 'deploy/cloudflare/src/__tests__/old.test.mjs', 'server/old.test.mjs'), 1, ['D deploy/cloudflare/src/__tests__/old.test.mjs']],
    ['a rename into deploy/ci', repo => repo.git('mv', 'server/fixture.mjs', 'deploy/ci/fixture.mjs'), 1, ['A deploy/ci/fixture.mjs']],
    ['an added workflow', repo => repo.put('.github/workflows/x.yml', 'on: push\n'), 1, ['A .github/workflows/x.yml']],
  ]
  for (const [name, change, status, refused] of cases) {
    const repo = repository()
    try {
      change(repo); if (!repo.skipAdd) repo.git('add', '-A'); repo.git('commit', '-q', '-m', name)
      const result = repo.judge()
      assert.equal(result.status, status, `${name}: ${result.stdout}${result.stderr}`)
      for (const line of refused) assert.ok(result.stdout.includes(line), `${name}: ${result.stdout}`)
      assert.match(result.stdout, /frozen paths: \d+ refused \(judged by origin\/main deploy\/ci\/frozen-paths\.mjs\)/)
    } finally { repo.remove() }
  }
  // No origin/main in the checkout: the step fails closed.
  const repo = repository()
  try {
    repo.git('update-ref', '-d', 'refs/remotes/origin/main')
    const result = repo.judge()
    assert.notEqual(result.status, 0); assert.match(result.stdout, /origin\/main is not in the checkout/)
  } finally { repo.remove() }
})

test('the protected jobs\' removal list holds every added test file and every added path of her edge folder, and nothing else', () => {
  const z = entries => entries.map(([status, path]) => `${status}\u0000${path}\u0000`).join('')
  assert.equal(AUMA_EDGE_FOLDER, 'deploy/cloudflare/src/auma')
  assert.deepEqual(protectedJobRemovals(z([['M', 'deploy/cloudflare/src/crew-relay-tool.mjs'], ['A', 'deploy/cloudflare/src/auma/helper.mjs'], ['A', 'deploy/cloudflare/src/auma/deep/x.mjs'],
    ['A', 'deploy/cloudflare/src/__tests__/auma-helper.test.mjs'], ['A', 'packages/client/ui-layout/tests/n.client.spec.tsx'], ['A', 'deploy/cloudflare/src/Auma/odd.mjs'],
    ['A', 'apps/web/src/x.ts'], ['M', 'deploy/cloudflare/src/auma/main-has.mjs'], ['D', 'deploy/cloudflare/src/auma/gone.mjs'], ['A', 'deploy/cloudflare/src/aumax/x.mjs']])),
  { tests: ['deploy/cloudflare/src/__tests__/auma-helper.test.mjs', 'packages/client/ui-layout/tests/n.client.spec.tsx'],
    auma: ['deploy/cloudflare/src/auma/helper.mjs', 'deploy/cloudflare/src/auma/deep/x.mjs', 'deploy/cloudflare/src/Auma/odd.mjs'] })
  assert.deepEqual(protectedJobRemovals(''), { tests: [], auma: [] }); assert.deepEqual(protectedJobRemovals(null), { tests: [], auma: [] })
  // Each protected job removes with this builder, in the step that puts main's tests back, before setup and install.
  for (const name of ['edge', 'ui', 'boot']) {
    const job = jobText(WORKFLOW, name), step = job.split("      - name: Main's tests and configuration put back\n")[1].split('      - name: ')[0]
    assert.match(step, /const \{ tests, auma \} = protectedJobRemovals\(readFileSync\(diff, "utf8"\)\)\n\s+for \(const path of \[\.\.\.tests, \.\.\.auma\]\) rmSync\(path, \{ force: true \}\)/, name)
    assert.ok(job.indexOf("Main's tests and configuration put back") < job.indexOf('Install dependencies without lifecycle scripts'), name)
  }
})

test('the outside review\'s three spellings are red in every protected job: her added module is gone there, so the open file that reaches it fails to load', () => {
  const spellings = { 'a space before the parenthesis': "export const tool = 1\nawait import ('./auma/helper.mjs')\n",
    'a comment inside the import': "import /* shared helper */ './auma/helper.mjs'\nexport const tool = 1\n",
    'a computed name': "export const tool = 1\nconst name = 'helper'; await import('./auma/' + name + '.mjs')\n" }
  const configPaths = /CONFIG_PATHS: >-\n((?: {4}.+\n)+)/.exec(WORKFLOW)[1].split(/\s+/).filter(Boolean).join(' ')
  for (const [label, tool] of Object.entries(spellings)) {
    const repo = repository()
    try {
      repo.put('deploy/cloudflare/src/crew-relay-tool.mjs', tool)
      repo.put('deploy/cloudflare/src/auma/helper.mjs', "import { writeFileSync } from 'node:fs'\nwriteFileSync('helper-ran.txt', 'yes')\n")
      repo.git('add', '-A'); repo.git('commit', '-q', '-m', label)
      // The fence lets this proposal through (both paths are open), and in its own checkout the helper does run.
      assert.equal(repo.judge().status, 0, label)
      const load = () => spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', './deploy/cloudflare/src/crew-relay-tool.mjs'], { cwd: repo.work, encoding: 'utf8' })
      assert.equal(load().status, 0, `${label}: the fixture is real`); assert.equal(existsSync(join(repo.work, 'helper-ran.txt')), true, label)
      rmSync(join(repo.work, 'helper-ran.txt'))
      const mainSha = repo.git('rev-parse', 'refs/remotes/origin/main').trim()
      for (const name of ['edge', 'ui', 'boot']) {
        repo.git('checkout', '-q', '-f', 'auma/proposal/fixture'); repo.git('clean', '-q', '-fdx', '-e', '.runner-temp')
        const job = jobText(WORKFLOW, name), suite = /SUITE_PATHS: (.+)\n/.exec(job)[1]
        const lines = [], after = job.split("      - name: Main's tests and configuration put back\n")[1].split('        run: |\n')[1].split('\n')
        for (const line of after) { if (!line.startsWith('          ')) break; lines.push(line.slice(10)) }
        const body = lines.join('\n') + '\n'
        mkdirSync(join(repo.work, '..', '.runner-temp'), { recursive: true })
        const step = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', body], { cwd: repo.work, encoding: 'utf8',
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', RUNNER_TEMP: join(repo.work, '..', '.runner-temp'), MAIN_SHA: mainSha, SUITE_PATHS: suite, CONFIG_PATHS: configPaths } })
        assert.equal(step.status, 0, `${label} ${name}: ${step.stderr}`)
        assert.match(step.stdout, /added files of deploy\/cloudflare\/src\/auma\/ removed from this job: 1/, `${label} ${name}`)
        assert.equal(existsSync(join(repo.work, 'deploy/cloudflare/src/auma/helper.mjs')), false, `${label} ${name}`)
        const red = load()
        assert.notEqual(red.status, 0, `${label} ${name}: the open file must fail to load`); assert.match(red.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/, `${label} ${name}`)
        assert.equal(existsSync(join(repo.work, 'helper-ran.txt')), false, `${label} ${name}: the added module never ran`)
      }
    } finally { repo.remove() }
  }
})

// ---- The door level ----
const OPEN_CASES = ['deploy/cloudflare/src/worker.mjs', '.github/workflows/proposal-checks.yml', 'deploy/ci/frozen-paths.mjs',
  'deploy/cloudflare/src/__tests__/repo-frozen-paths.test.mjs', 'packages/client/ui-layout/src/client/spatial/portal/RepoProposalCell.tsx',
  'packages/experimental/webworker-runtime/src/storage/idb-persist.ts', 'packages/experimental/webworker-runtime/src/x6/ball-loader.ts',
  'mirror/home/auma/seed/organs/seed-judge.js', 'mirror/home/auma/seed/receipts.v3.jsonl', 'package.json', 'pnpm-lock.yaml', 'server/build-preview.mjs',
  'packages/experimental/webworker-runtime/src/x6/scion-pins.ts', 'packages/experimental/webworker-runtime/tests/x6/large-store-boot.spec.ts',
  'packages/client/ui-layout/src/client/spatial/apps/identity/host.ts', 'vitest.config.ts', 'AGENTS.md']

test('one level line, default open; the stricter guarded level is kept built', () => {
  assert.equal(REPO_DOOR_LEVEL, 'open')
  assert.deepEqual([...REPO_DOOR_LEVELS], ['open', 'guarded'])
  assert.equal(fence.doorLevel('open'), 'open')
  for (const odd of ['guarded', 'Open', '', undefined, null, 'wide']) assert.equal(fence.doorLevel(odd), 'guarded', String(odd))
  const source = readFileSync(join(ROOT, 'deploy/ci/frozen-paths.mjs'), 'utf8')
  assert.equal(source.match(/^export const REPO_DOOR_LEVEL = /gm).length, 1)
  assert.match(source, /The owner changes this line\./)
  assert.ok(PROPOSAL_PATH_NEXTS.includes(SECRET_PATH_NEXT))
  assert.doesNotMatch(SECRET_PATH_NEXT, /token/i)
})

test('at open every path is hers to add, change, delete or rename; at guarded the same paths answer as before', () => {
  for (const path of OPEN_CASES) {
    for (const status of ['added', 'modified', 'removed']) {
      assert.equal(fence.proposalPathRefusal(path, status), null, `${path} ${status}`)
      assert.equal(fence.proposalPathRefusal(path, status, { level: 'open' }), null, `${path} ${status}`)
      assert.equal(fence.isOpenRepoPath(path, status, 'open'), true, path)
    }
    assert.equal(fence.isFrozenRepoPath(path, 'open'), false, path); assert.equal(fence.isFrozenTestPath(path, 'open'), false, path)
    // The guarded level refuses each of them, unchanged.
    assert.notEqual(fence.proposalPathRefusal(path, 'modified', { level: 'guarded' }), null, path)
  }
  const z = entries => entries.map(([status, path]) => `${status}\u0000${path}\u0000`).join('')
  assert.deepEqual(fence.frozenDiffRefusals(z(OPEN_CASES.map(path => ['M', path]))), [])
  assert.deepEqual(fence.frozenDiffRefusals(z([['D', 'deploy/cloudflare/src/__tests__/old.test.mjs'], ['A', 'deploy/ci/new.mjs']])), [])
  assert.ok(frozenDiffRefusals(z(OPEN_CASES.map(path => ['M', path]))).length >= OPEN_CASES.length - 1)
})

test('at open a secret-shaped path, a path that is not plain or canonical, a case twin and an installed-package folder stay refused', () => {
  for (const path of ['.env', 'server/.env', 'apps/web/src/.npmrc', 'deploy/.dev.vars', 'mirror/home/auma/private/x.md', 'server/owner-key.mjs', 'docs/keys/a.md',
    'deploy/cloudflare/src/secret.mjs', 'scripts/credentials.json', 'apps/web/src/id_ed25519', 'server/password.txt', 'apps/vault/x.ts', '.GitHub/workflows/x.yml']) {
    assert.equal(isSecretShapedRepoPath(path), true, path)
    for (const status of ['added', 'modified', 'removed']) assert.deepEqual(fence.proposalPathRefusal(path, status), { code: 'REPO_PATH_NOT_OPEN', next: SECRET_PATH_NEXT }, path)
  }
  assert.deepEqual(fence.proposalPathRefusal('apps/web/node_modules/x.js', 'added'), { code: 'REPO_PATH_NOT_OPEN', next: PATH_NOT_OPEN_NEXT })
  for (const path of ['deploy//ci/x.mjs', 'deploy/../x', 'deploy/./x', 'deploy/ci./x', 'deploy/%2e/x', 'deploy\\x', '/deploy/x', 'deploy/cloudflare/src/\u017figned-action.mjs',
    'docs/auma/cafe\u0301.md', ' deploy/x', '', null, 7]) {
    assert.equal(fence.proposalPathRefusal(path, 'added')?.code, 'REPO_PATH_NOT_PLAIN', JSON.stringify(path))
  }
  assert.equal(fence.proposalPathRefusal('deploy/cloudflare/src/Worker.mjs', 'added', { twin: true })?.code, 'REPO_PATH_NOT_PLAIN')
  for (const path of ['.github/workflows/x.yml', '.github/CODEOWNERS', 'deploy/cloudflare/src/passkey-devices.mjs', 'apps/web/src/spatial-tokens.css']) {
    assert.equal(isSecretShapedRepoPath(path), path.endsWith('spatial-tokens.css'), path)
  }
})

test('the CI fence at open (main says open): her change to the workflows, the fence, a test and the edge passes; a credential file and a twin are refused', () => {
  const cases = [
    ['the workflows, the fence, an edge module and a test main has', repo => {
      repo.put('.github/workflows/x.yml', 'on: push\n'); repo.put('deploy/ci/frozen-paths.mjs', 'export const frozenDiffRefusals = () => []\n')
      repo.put('deploy/cloudflare/src/fixture.mjs', 'new\n'); repo.put('deploy/cloudflare/src/__tests__/old.test.mjs', 'changed\n'); repo.put('server/fixture.mjs', 'new\n')
    }, 0, []],
    ['a delete of a test main has', repo => repo.git('rm', '-q', 'deploy/cloudflare/src/__tests__/old.test.mjs'), 0, []],
    ['a credential file', repo => repo.put('server/.env', 'X=1\n'), 1, ['REPO_PATH_NOT_OPEN A server/.env']],
    ['a case twin', repo => repo.indexOnly('deploy/cloudflare/src/Crew-Relay-Tool.mjs', 'x\n'), 1, ['REPO_PATH_NOT_PLAIN A deploy/cloudflare/src/Crew-Relay-Tool.mjs']],
  ]
  for (const [name, change, status, refused] of cases) {
    const repo = repository('open')
    try {
      change(repo); if (!repo.skipAdd) repo.git('add', '-A'); repo.git('commit', '-q', '-m', name)
      const result = repo.judge()
      assert.equal(result.status, status, `${name}: ${result.stdout}${result.stderr}`)
      for (const line of refused) assert.ok(result.stdout.includes(line), `${name}: ${result.stdout}`)
      // The level step reads main's copy the fence step wrote: open here, guarded for a guarded main.
      if (status === 0) {
        const level = spawnSync('bash', ['-c', stepScript(WORKFLOW, "Main's door level")], { cwd: repo.work, env: { ...process.env, RUNNER_TEMP: join(repo.work, '..', '.runner-temp'), GITHUB_OUTPUT: join(repo.work, '..', '.runner-temp', 'out') }, encoding: 'utf8' })
        assert.equal(level.status, 0, level.stderr); assert.match(level.stdout, /door level: open/)
        assert.match(readFileSync(join(repo.work, '..', '.runner-temp', 'out'), 'utf8'), /^level=open$/m)
      }
    } finally { repo.remove() }
  }
  const guarded = repository('guarded')
  try {
    guarded.put('server/fixture.mjs', 'new\n'); guarded.git('add', '-A'); guarded.git('commit', '-q', '-m', 'guarded')
    assert.equal(guarded.judge().status, 1)
    guarded.git('reset', '-q', '--hard', 'refs/remotes/origin/main'); guarded.put('deploy/cloudflare/src/crew-relay-tool.mjs', 'new\n'); guarded.git('add', '-A'); guarded.git('commit', '-q', '-m', 'open file')
    assert.equal(guarded.judge().status, 0)
    const level = spawnSync('bash', ['-c', stepScript(WORKFLOW, "Main's door level")], { cwd: guarded.work, env: { ...process.env, RUNNER_TEMP: join(guarded.work, '..', '.runner-temp'), GITHUB_OUTPUT: join(guarded.work, '..', '.runner-temp', 'out') }, encoding: 'utf8' })
    assert.equal(level.status, 0, level.stderr); assert.match(level.stdout, /door level: guarded/)
  } finally { guarded.remove() }
})

test('proposal-checks.yml at open runs the fence, plus new-vitest-tests when the diff touches a suite or src/storage, and checks requires that run exactly when it exists; at guarded every job, as before', () => {
  const fenceJob = jobText(WORKFLOW, 'fence')
  assert.match(fenceJob, /outputs:\n {6}main: \$\{\{ steps\.main\.outputs\.sha \}\}\n {6}level: \$\{\{ steps\.level\.outputs\.level \}\}\n/)
  assert.deepEqual(stepNames(fenceJob), ['Checkout the pushed proposal commit', FENCE_STEP, "Main's commit for the other jobs", "Main's door level"])
  // At the open door level new-vitest-tests also runs when the proposal touches a
  // suite or src/storage, so its condition carries the fence's own `touched` flag. This was the rule the card was built to
  // change: the open door level said the fence runs alone at open, and two of her storage cards went green here while their spec was red.
  for (const name of ['baseline', 'new-node-tests']) {
    assert.match(jobText(WORKFLOW, name), /\n {4}needs: fence\n {4}if: \$\{\{ needs\.fence\.outputs\.level != 'open' \}\}\n/, name)
  }
  const vitest = jobText(WORKFLOW, 'new-vitest-tests')
  assert.match(vitest, /\n {4}needs: fence\n(?: {4}#[^\n]*\n)+ {4}if: \$\{\{ needs\.fence\.outputs\.level != 'open' \|\| needs\.fence\.outputs\.touched == '1' \}\}\n/)
  assert.match(fenceJob, /\n {6}touched: \$\{\{ steps\.level\.outputs\.touched \}\}\n/)
  // edge, ui and boot need the baseline, so they are skipped with it.
  for (const name of ['edge', 'ui', 'boot']) assert.match(jobText(WORKFLOW, name), /\n {4}needs: \[fence, baseline\]\n/, name)
  const checks = jobText(WORKFLOW, 'checks')
  assert.match(checks, /LEVEL: \$\{\{ needs\.fence\.outputs\.level \}\}/)
  // At open the aggregate requires the fence alone, plus new-vitest-tests exactly when that run exists. It reads
  // the job's own result, not a new fence output, because main holds this job to red and level only.
  assert.match(checks, /const ran = process\.env\.NEW_VITEST_TESTS !== "skipped" && process\.env\.NEW_VITEST_TESTS !== "missing"\n/)
  assert.match(checks, /const required = process\.env\.LEVEL === "open"\n\s+\? \(ran \? \{ fence: "FENCE", "new-vitest-tests": "NEW_VITEST_TESTS" \} : \{ fence: "FENCE" \}\)\n\s+: \{ fence: "FENCE", baseline: "BASELINE", edge: "EDGE", ui: "UI", boot: "BOOT", "new-node-tests": "NEW_NODE_TESTS", "new-vitest-tests": "NEW_VITEST_TESTS" \}/)
  assert.match(stepScript(WORKFLOW, "Main's door level"), /fence\.REPO_DOOR_LEVEL === "open" \? "open" : "guarded"/)
})
