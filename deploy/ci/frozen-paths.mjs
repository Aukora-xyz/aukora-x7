// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * FROZEN PATHS: the one list of repository paths her proposals may never change.
 *
 * From tonight her product-code proposals merge on GitHub's checks and the owner's passkey, with nobody reading the lines.
 * A proposal that could edit its own judge could pass. So the judge, the ledger, the checks and the pins are changed only
 * by a person with repo write. Three layers read this one list and must agree:
 *   1. the edge (deploy/cloudflare/src/cloud-brokers.mjs): a write to her branch, a stage and a merge are refused
 *      (REPO_FROZEN_PATH_REFUSED), the merge before his passkey is asked for or spent;
 *   2. CI (.github/workflows/proposal-checks.yml): MAIN's copy of this file, never the proposal's, judges
 *      `git diff origin/main...HEAD`, old and new side of every change;
 *   3. the card (packages/client/ui-layout/src/client/spatial/aumlok/frozen-paths.ts, a copy: packages/ may not import
 *      deploy/; packages/client/ui-layout/tests/repo-proposal-frozen.client.spec.ts fails when the two differ).
 * Tests main already has are frozen against CHANGE and DELETE only, never against additions (rule 1b): a proposal may add
 * a new test file. That is judged where both trees are in hand: at stage, at merge and in CI.
 *
 * The rule is turned round (MUST 1-3): a list of forbidden files cannot hold while a
 * proposal may add any new file (a package.json beside the tests, a config import, a test that rewrites the next runner).
 * So a proposal may change ONLY a path that is plain (printable ASCII, no case twin), OPEN (OPEN_PATHS below, kept small
 * on purpose; a person widens it) and not frozen. The frozen list stays as the second wall.
 *
 * SELF-CONTAINED ON PURPOSE: no import. CI loads main's copy from a temporary file outside the checkout, where a relative
 * import would not resolve. The 15 organ ids are therefore written here and pinned equal to server/ball-transition.mjs
 * T2_ONLY_ORGANS by deploy/ci/frozen-paths.test.mjs. Pure, no I/O. It lives under deploy/ (T2): the Worker executes it.
 */

/** Whole directories: the workflows, and the deploy gate's own scripts and tests. */
export const FROZEN_DIRECTORIES = Object.freeze(['.github', 'deploy/ci'])

/** Decision 6 entries: each is its own line, so one line removes it. */
export const DECISION_6_FILES = Object.freeze([
  'deploy/cloudflare/src/head-do.mjs',
  'deploy/cloudflare/src/worker.mjs',
  'packages/experimental/webworker-runtime/src/x6/ball-loader.ts',
])

/** Single files: the edge's judges and doors, the transition rule, the deploy and build, the pins, her ledger. */
export const FROZEN_FILES = Object.freeze([
  'deploy/cloudflare/src/cloud-brokers.mjs',
  'deploy/cloudflare/src/owner-grant-policy.mjs',
  'deploy/cloudflare/src/night-grant.mjs',
  'deploy/cloudflare/src/organ-set-rule.mjs',
  'deploy/cloudflare/src/aumlok.mjs',
  'deploy/cloudflare/src/access.mjs',
  'deploy/cloudflare/src/gate-lockout.mjs',
  'deploy/cloudflare/src/signed-action.mjs',
  'deploy/cloudflare/src/enrollment-approval.mjs',
  'deploy/cloudflare/src/passkey-devices.mjs',
  ...DECISION_6_FILES,
  'server/ball-transition.mjs',
  'server/deploy-cloudflare.mjs',
  'server/build-preview.mjs',
  'packages/experimental/webworker-runtime/src/x6/wasm-cells.ts',
  'mirror/home/auma/HEAD.json',
  'mirror/home/auma/seed/receipts.v3.jsonl',
  // The vitest setup files every UI spec and large-store-boot.spec.ts run inside (vitest.config.ts setupFiles): a mock
  // added here would apply to every spec, so a free setup file would let a proposal weaken the frozen boot test.
  'scripts/test-proxy-environment.ts',
  'scripts/test-dom-environment.ts',
  'scripts/test-official-listing-guard.ts',
  // What the outside review named, each closed by the open list too: the package manifests
  // whose self-reference or "imports" could redirect an edge test's imports (the four absent ones may not be ADDED), the
  // test configuration and everything it executes, the import resolution, the lockfile and the workspace.
  'package.json',
  'deploy/package.json',
  'deploy/cloudflare/package.json',
  'deploy/cloudflare/src/package.json',
  'deploy/cloudflare/src/__tests__/package.json',
  'vitest.config.ts',
  'vitest.shared.ts',
  'scripts/coverage-exempt.ts',
  'scripts/coverage-partitions.ts',
  'scripts/parallelism.ts',
  'scripts/pnpm-invocation.ts',
  'packages/shell/pwsh-local/src/resolve.ts',
  'packages/util/http-proxy/src/policy.ts',
  'tsconfig.base.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  // The card's own copy of this list (packages/ may not import deploy/): the card asks no passkey by it.
  'packages/client/ui-layout/src/client/spatial/aumlok/frozen-paths.ts',
  // Review: what the frozen judges import is a judge too. The passkey failure rule and the passkey
  // screen (sign-in and every approval run them), the owner login's checks in flight, the model and storage budgets, the
  // secret-path rule and its copy, the cloud wake's evidence list; and the card's code, which decides what he is shown
  // before his passkey. Now every other path under deploy/ is closed by default too (OPEN_PATHS below); the
  // deploy/ entries here stay as the second wall and for their sharper refusal.
  'deploy/cloudflare/src/proof-failure-rule.mjs',
  'deploy/cloudflare/src/webauthn-screen.mjs',
  'deploy/cloudflare/src/owner-login-slots.mjs',
  'deploy/cloudflare/src/provider-budget.mjs',
  'deploy/cloudflare/src/world-budget.mjs',
  'deploy/cloudflare/src/mirror-do.mjs',
  'deploy/cloudflare/src/mirror-secret-paths.mjs',
  'deploy/cloudflare/src/wake-evidence.mjs',
  'packages/client/ui-layout/src/client/spatial/aumlok/repo-proposal.ts',
  'packages/client/ui-layout/src/client/spatial/aumlok/class3-approval.ts',
  'packages/client/ui-layout/src/client/spatial/portal/RepoProposalCell.tsx',
])

/** Files in FROZEN_FILES that are not in the tree today: frozen so a proposal may not ADD them. */
export const FROZEN_ABSENT_FILES = Object.freeze([
  'deploy/package.json',
  'deploy/cloudflare/package.json',
  'deploy/cloudflare/src/package.json',
  'deploy/cloudflare/src/__tests__/package.json',
])

/** The 15 governance organs (server/ball-transition.mjs T2_ONLY_ORGANS; equality pinned by frozen-paths.test.mjs). */
export const FROZEN_ORGAN_IDS = Object.freeze([
  'seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura',
  'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map',
  'seed-judge', 'gate-judge', 'grant-ledger', 'aumlok-identity', 'aumlok-keys',
  'auma-scion', 'seed-boot',
])

/** Their sources in the repo copy of her home. */
export const FROZEN_ORGAN_FILES = Object.freeze(FROZEN_ORGAN_IDS.map(id => `mirror/home/auma/seed/organs/${id}.js`))

/** Tests main already has: frozen against change and delete, never against additions (rule 1b). */
export const FROZEN_TEST_DIRECTORIES = Object.freeze(['deploy/cloudflare/src/__tests__'])
export const FROZEN_TEST_FILES = Object.freeze(['packages/experimental/webworker-runtime/tests/x6/large-store-boot.spec.ts'])

/** What to do instead, in her tool's words. */
export const FROZEN_PATH_NEXT = 'this file is changed only by a person with repo write: her proposals never change the judge, the ledger, the checks or the pins (deploy/ci/frozen-paths.mjs)'
export const FROZEN_TOOLS_NEXT = 'this file is changed only by a person with repo write: it holds all her tools (registerBuiltin), so she cannot add a tool to herself through a proposal'
export const FROZEN_TEST_NEXT = 'this test is already on main, so it is changed or deleted only by a person with repo write; a proposal may add a NEW test file instead'
export const FROZEN_NEXTS = Object.freeze([FROZEN_PATH_NEXT, FROZEN_TOOLS_NEXT, FROZEN_TEST_NEXT])

/**
 * THE OPEN LIST (MUST 2 and 3): the only paths a proposal may change, add or delete. Patterns: `*` is one path
 * segment or part of one, `**` is any number of whole segments (none included). OPEN_PATHS and OPEN_NEW_PATHS match the
 * exact path, case-sensitively; CLOSED_* match it lower-cased, so a case variant of a closed name is closed too. Everything else is closed by default: every package.json, scripts/**, vitest.config.ts, vitest.shared.ts,
 * tsconfig.base.json, packages/util/**, packages/shell/**, the lockfile, server/**, mirror/** outside the open organs.
 *
 * MUST 1: at the edge, closed is the default. Modules under deploy/ decide approvals and budgets themselves
 * (messages-store, cold-archive, nostr-anchor, thread-log, vault, thread-mount, world-lease, world-holder ...), so under
 * deploy/** NOTHING is open except: her relay tool crew-relay-tool.mjs (no other module under deploy/ imports it: pinned by
 * frozen-paths.test.mjs); NEW files of her own folder deploy/cloudflare/src/auma/** (OPEN_NEW_PATHS; no file outside it
 * imports from it: pinned, so nothing there runs until a person adds one import in a file she cannot change); and NEW test files
 * deploy/cloudflare/src/__tests__/auma-*.test.mjs (run only in CI's new-node-tests job). SHOULD 3: the README Markdown at
 * the top of each page package and of apps/web, which no build or test executes (pinned by the same test over the
 * configuration globs and the imports); opened by name, not by extension, so an instruction file a
 * coding agent reads there (AGENTS.override.md, GEMINI.md, CLAUDE.local.md) is not opened with it; tests/ and public/
 * Markdown stays closed (tests compare against it; the site serves it).
 */
export const OPEN_PATHS = Object.freeze([
  'docs/auma/**',
  'apps/web/src/**',
  'packages/client/*/src/**',
  'packages/experimental/webworker-runtime/src/**',
  'deploy/cloudflare/src/crew-relay-tool.mjs',
  'mirror/home/auma/seed/organs/*.js',
  'packages/client/*/README*.md',
  'apps/web/README*.md',
])

/** Open for ADDITION only, never for a change or a delete: new test files (they run alone, in CI's new-node-tests and
 * new-vitest-tests jobs), and NEW files of her own edge folder (MUST 1b; add-only):
 * once a person has imported one of them into a file she cannot change, it runs in the Worker, so it is changed only by
 * a person from then on, like every other module under deploy/. */
export const OPEN_NEW_PATHS = Object.freeze([
  'packages/client/*/tests/**/*.spec.ts',
  'packages/client/*/tests/**/*.spec.tsx',
  'packages/experimental/webworker-runtime/tests/**/*.spec.ts',
  'deploy/cloudflare/src/__tests__/auma-*.test.mjs',
  'deploy/cloudflare/src/auma/**',
])

/** Closed although an open pattern covers them: her tools, the cell pins and her storage. */
export const CLOSED_INSIDE_OPEN = Object.freeze([
  'packages/experimental/webworker-runtime/src/x6/ball-loader.ts',
  'packages/experimental/webworker-runtime/src/x6/wasm-cells.ts',
  'packages/experimental/webworker-runtime/src/storage/**',
])

/** Closed anywhere, by file name: manifests and configuration, and the instruction files coding agents read (
 * every AGENTS*.md, CLAUDE*.md and GEMINI*.md, e.g. AGENTS.override.md, CLAUDE.local.md).
 * And by segment: an installed-package folder or a dot name (node_modules would shadow an import; .npmrc, .env and the
 * like configure the tools). */
export const CLOSED_NAMES = Object.freeze(['package.json', 'tsconfig*.json', 'vite.config.*', 'vitest.*', '*.config.*', 'agents*.md', 'claude*.md', 'gemini*.md'])
export const CLOSED_SEGMENTS = Object.freeze(['node_modules', '.*'])

export const PATH_NOT_OPEN_NEXT = 'this path is changed only by a person with repo write; ask on the relay'
export const PATH_NOT_PLAIN_NEXT = 'use a plain path: printable ASCII letters only, and never one that equals another path in the repository when both are lower-cased (a case-insensitive disk would make them one file)'
export const PROPOSAL_PATH_NEXTS = Object.freeze([...FROZEN_NEXTS, PATH_NOT_OPEN_NEXT, PATH_NOT_PLAIN_NEXT])

const exactFiles = new Set([...FROZEN_FILES, ...FROZEN_ORGAN_FILES].map(path => path.toLowerCase()))
const testFiles = new Set(FROZEN_TEST_FILES.map(path => path.toLowerCase()))
const within = (path, directories) => directories.some(directory => path === directory.toLowerCase() || path.startsWith(directory.toLowerCase() + '/'))

/** A glob of OPEN_PATHS' form as a whole-path regular expression. */
function globRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (pattern.startsWith('**/', index)) { source += '(?:[^/]+/)*'; index += 2 }
    else if (pattern.startsWith('/**', index) && index + 3 === pattern.length) { source += '/.+'; index += 2 }
    else if (char === '*') source += '[^/]*'
    else source += /[a-z0-9_/-]/i.test(char) ? char : '\\' + char
  }
  return new RegExp('^' + source + '$')
}
const matcher = patterns => { const expressions = patterns.map(globRegExp); return path => expressions.some(expression => expression.test(path)) }
const openPath = matcher(OPEN_PATHS), openNewPath = matcher(OPEN_NEW_PATHS), closedInsideOpen = matcher(CLOSED_INSIDE_OPEN)
/** The added files CI runs as tests: OPEN_NEW_PATHS but her edge folder, whose new modules are not tests. */
const newTestPath = matcher(OPEN_NEW_PATHS.filter(pattern => pattern !== 'deploy/cloudflare/src/auma/**'))
const closedName = matcher(CLOSED_NAMES), closedSegment = matcher(CLOSED_SEGMENTS)

/**
 * Whether a path holds only printable ASCII (no space, no control, nothing above U+007E). A composed or decomposed
 * accent, a long s (U+017F, which a case-insensitive disk folds to `s`) and any other look-alike is not plain.
 * @param {unknown} path Repository-relative path.
 * @returns {boolean}
 */
export function isPlainRepoPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 1024 && /^[\u0021-\u007e]+$/.test(path)
}

/**
 * The changed paths that equal another path when both are lower-cased, counting every leading folder: on a
 * case-insensitive disk `Deploy/x` lands inside `deploy/`. `trees` are the base and head trees' paths (folders may be
 * listed or not; every prefix is counted either way).
 * @param {Iterable<string>} changed The paths a proposal changes.
 * @param {...Iterable<string>} trees Every path of the base tree and of the head tree.
 * @returns {string[]} The changed paths that have a case twin, in the order given.
 */
export function caseTwinPaths(changed, ...trees) {
  const spellings = new Map()
  const add = path => {
    if (typeof path !== 'string') return
    let end = path.indexOf('/')
    for (;;) {
      const prefix = end === -1 ? path : path.slice(0, end), key = prefix.toLowerCase()
      const known = spellings.get(key)
      if (known === undefined) spellings.set(key, prefix)
      else if (known !== prefix && known !== null) spellings.set(key, null)
      if (end === -1) break
      end = path.indexOf('/', end + 1)
    }
  }
  const list = [...changed]
  for (const tree of trees) for (const path of tree) add(path)
  for (const path of list) add(path)
  return list.filter(path => {
    const parts = String(path).split('/')
    return parts.some((_, index) => spellings.get(parts.slice(0, index + 1).join('/').toLowerCase()) === null)
  })
}

/**
 * Whether a proposal may touch this path at all (MUST 2): open, plain, not a configuration name, not an installed
 * package or dot segment, not closed inside an open folder. A test pattern of OPEN_NEW_PATHS is open for 'added' only.
 * Frozen paths are judged separately (isFrozenRepoPath) and win.
 * @param {unknown} path Repository-relative path, exact case.
 * @param {'added'|'modified'|'removed'} [status] What the proposal does to it; a rename is a 'removed' and an 'added'.
 * @returns {boolean}
 */
export function isOpenRepoPath(path, status = 'modified') {
  if (!isPlainRepoPath(path) || frozenJudgedForm(path) === null) return false
  const parts = path.split('/')
  // Closed names, segments and folders are matched in lower case: a case-insensitive disk reads Package.json as package.json.
  if (parts.some(part => closedSegment(part.toLowerCase())) || closedName(parts.at(-1).toLowerCase()) || closedInsideOpen(path.toLowerCase())) return false
  return openPath(path) || (status === 'added' && openNewPath(path))
}

/**
 * The form a path is judged in: lower case (GitHub and a case-insensitive disk read `.GitHub` as `.github`), or null when
 * the path is not canonical (empty, absolute, a backslash, an encoded or control or space character, any character
 * outside printable ASCII, an empty segment, `.` or `..`, a segment ending in a dot). Such a path never passes as free.
 * @param {unknown} path Repository-relative path.
 * @returns {string|null}
 */
export function frozenJudgedForm(path) {
  if (!isPlainRepoPath(path) || /[\\%?#]/.test(path)) return null
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.'))) return null
  return path.toLowerCase()
}

/**
 * Whether a proposal may never change, add, delete or rename this path (either side of a rename counts).
 * @param {unknown} path Repository-relative path.
 * @returns {boolean} true for a frozen path and for any path that is not canonical.
 */
export function isFrozenRepoPath(path) {
  const judged = frozenJudgedForm(path)
  return judged === null || within(judged, FROZEN_DIRECTORIES) || exactFiles.has(judged)
}

/**
 * Whether a CHANGE or DELETE of this path (a test main already has) is refused. Additions are judged by isFrozenRepoPath only.
 * @param {unknown} path Repository-relative path.
 * @returns {boolean} true for a frozen test path and for any path that is not canonical.
 */
export function isFrozenTestPath(path) {
  const judged = frozenJudgedForm(path)
  return judged === null || within(judged, FROZEN_TEST_DIRECTORIES) || testFiles.has(judged)
}

/**
 * The `next` sentence for a refused path.
 * @param {string} path The refused path.
 * @param {boolean} [test] Whether it was refused as an existing test.
 * @returns {string} One of FROZEN_NEXTS.
 */
export function frozenPathNext(path, test = false) {
  if (test && !isFrozenRepoPath(path)) return FROZEN_TEST_NEXT
  return frozenJudgedForm(path) === 'packages/experimental/webworker-runtime/src/x6/ball-loader.ts' ? FROZEN_TOOLS_NEXT : FROZEN_PATH_NEXT
}

/**
 * The one judgement of a proposal path, in order: plain (and no case twin), frozen, a test main already has, open.
 * @param {unknown} path Repository-relative path, exact case.
 * @param {'added'|'modified'|'removed'} status What the proposal does to it.
 * @param {{ twin?: boolean }} [options] `twin`: the path has a case twin in the base or head tree (caseTwinPaths).
 * @returns {null | { code: 'REPO_PATH_NOT_PLAIN'|'REPO_FROZEN_PATH_REFUSED'|'REPO_PATH_NOT_OPEN', next: string, test?: true }}
 */
export function proposalPathRefusal(path, status, { twin = false } = {}) {
  if (!isPlainRepoPath(path) || twin) return { code: 'REPO_PATH_NOT_PLAIN', next: PATH_NOT_PLAIN_NEXT }
  if (isFrozenRepoPath(path)) return { code: 'REPO_FROZEN_PATH_REFUSED', next: frozenPathNext(path) }
  if (status !== 'added' && isFrozenTestPath(path)) return { code: 'REPO_FROZEN_PATH_REFUSED', next: FROZEN_TEST_NEXT, test: true }
  if (!isOpenRepoPath(path, status)) return { code: 'REPO_PATH_NOT_OPEN', next: PATH_NOT_OPEN_NEXT }
  return null
}

const NUL_LIST = text => { const fields = text.split('\u0000'); if (fields.at(-1) === '') fields.pop(); return fields }

/**
 * CI's judgement of `git diff --no-renames --name-status -z <main>...HEAD` (status, NUL, path, NUL, ...): with renames
 * off, a rename is a delete of the old path and an add of the new one, so both sides are judged. `trees` are
 * `git ls-tree -r -t -z --name-only` of origin/main and of HEAD; given, case twins are refused too (an older workflow that
 * passes only the diff still gets every other judgement).
 * @param {string} text The NUL-separated diff.
 * @param {{ base?: string, head?: string }} [trees] The two NUL-separated tree listings.
 * @returns {string[]} One line per refusal; empty when the diff is free.
 */
export function frozenDiffRefusals(text, { base, head } = {}) {
  if (typeof text !== 'string' || (base !== undefined && typeof base !== 'string') || (head !== undefined && typeof head !== 'string')) return ['FROZEN_DIFF_UNREADABLE']
  const fields = NUL_LIST(text)
  if (fields.length % 2 !== 0) return ['FROZEN_DIFF_UNREADABLE']
  const entries = []
  for (let index = 0; index < fields.length; index += 2) entries.push({ status: fields[index], path: fields[index + 1] })
  const twins = new Set(base === undefined && head === undefined ? [] : caseTwinPaths(entries.map(entry => entry.path), NUL_LIST(base ?? ''), NUL_LIST(head ?? '')))
  const refusals = []
  for (const { status, path } of entries) {
    if (!['A', 'M', 'D', 'T'].includes(status)) { refusals.push(`FROZEN_DIFF_STATUS_UNKNOWN ${status} ${path}`); continue }
    const refusal = proposalPathRefusal(path, status === 'A' ? 'added' : status === 'D' ? 'removed' : 'modified', { twin: twins.has(path) })
    if (refusal) refusals.push(`${refusal.test ? 'REPO_FROZEN_TEST_REFUSED' : refusal.code} ${status} ${JSON.stringify(path).slice(1, -1)}`)
  }
  return refusals
}

/**
 * The test files a proposal ADDS, from the same diff: CI's `new-tests` job runs them, alone; the protected jobs remove them.
 * @param {string} text The NUL-separated `--name-status` diff.
 * @returns {{ node: string[], vitest: string[] }} node --test files and vitest spec files.
 */
export function addedTestFiles(text) {
  const fields = typeof text === 'string' ? NUL_LIST(text) : [], node = [], vitest = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index], path = fields[index + 1]
    if (status !== 'A' || !isPlainRepoPath(path) || isOpenRepoPath(path, 'modified') || !isOpenRepoPath(path, 'added') || !newTestPath(path)) continue
    ;(path.endsWith('.test.mjs') ? node : vitest).push(path)
  }
  return { node, vitest }
}

/** Her own edge folder (OPEN_NEW_PATHS): nothing there runs until a person adds one import in a file she cannot change. */
export const AUMA_EDGE_FOLDER = 'deploy/cloudflare/src/auma'

/**
 * MUST 1: what every protected job (edge, ui, boot) removes from its checkout before anything is installed or run,
 * in the same step that puts main's tests back: every test file the proposal ADDED (addedTestFiles), and every path the
 * proposal ADDED under deploy/cloudflare/src/auma/ (any spelling of the folder's case, open or not). So an added module of
 * her folder does not exist in a protected job: an open file that reaches into the folder by any spelling (a dynamic
 * import with a space, a comment inside an import, a computed name) fails to load there and the job is red, which is the
 * truthful answer: that code runs nowhere until a person adds the import. Files of the folder main already has stay.
 * @param {string} text The NUL-separated `--name-status` diff (renames off).
 * @returns {{ tests: string[], auma: string[] }} Repository paths, in diff order.
 */
export function protectedJobRemovals(text) {
  const fields = typeof text === 'string' ? NUL_LIST(text) : [], auma = []
  const { node, vitest } = addedTestFiles(text)
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index], path = fields[index + 1]
    if (status === 'A' && typeof path === 'string' && path.toLowerCase().startsWith(AUMA_EDGE_FOLDER + '/')) auma.push(path)
  }
  return { tests: [...node, ...vitest], auma }
}
