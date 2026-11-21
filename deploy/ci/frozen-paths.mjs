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

/**
 * THE DOOR LEVEL of her repository door, read in ONE place by the edge (cloud-brokers.mjs), CI (proposal-checks.yml reads
 * main's copy of this line) and the card (the page's copy, frozen-paths.ts, pinned equal).
 * 
 *   'open'    every path of the repository is hers to propose (add, change, delete, rename) and to read: deploy/**, .github/**,
 *             this file, every test, the approval cards, her storage, the pins. Refused only: a path that is not plain or not
 *             canonical (a case twin, `..`, an empty or dot-ended segment, a control or encoded character), a secret-shaped
 *             path (isSecretShapedRepoPath) or an installed-package folder, and the hard limits (sizes, counts). A merge
 *             still needs his passkey on the exact base, head and tree, and waits for the fast gate workflow only.
 *   'guarded' exactly the lists below, as before the open level (the stricter level, kept built).
 * The owner changes this line.
 */
export const REPO_DOOR_LEVEL = 'open'
export const REPO_DOOR_LEVELS = Object.freeze(['open', 'guarded'])
/** A level as judged: anything but 'open' or 'guarded' is the stricter 'guarded'. */
export const doorLevel = level => level === 'open' ? 'open' : 'guarded'

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
  // her checkpoint verifier and the look-only tool that reads the edge for it (card 1)
  'packages/experimental/webworker-runtime/src/x6/checkpoint-verify.ts',
  'packages/experimental/webworker-runtime/src/x6/checkpoint-verify-tool.ts',
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
  'packages/experimental/webworker-runtime/src/x6/cell-journal.ts', // the cell-call journal runs inside the cell host
  // the two-hosts handoff calls the edge and writes the journal
  'packages/experimental/webworker-runtime/src/x6/cell-handoff.ts',
  // her workflow executor runs her own scripts inside the worker; ball-loader hands it the tool gate
  'packages/experimental/webworker-runtime/src/x6/workflow-executor.ts',
  // ---- CORDECHO block begin ----
  // the Cord commit rule calls the edge, writes the journal and commits the head she holds
  'packages/experimental/webworker-runtime/src/x6/cord-run.ts',
  // ---- CORDECHO block end ----
  // ---- TOOLS block begin ----
  // her tool registry: the policy that qualifies and mounts the tools she writes (tier T1, a sealed cell per tool)
  'packages/experimental/webworker-runtime/src/x6/tool-registry.ts',
  // ---- TOOLS block end ----
  // ---- MENGERHIVE block begin ----
  // the Menger split-body runner and its wave/observability oracle call the edge and write the edge cell journal
  'packages/experimental/webworker-runtime/src/x6/menger-run.ts',
  'packages/experimental/webworker-runtime/src/x6/menger-observe.ts',
  // ---- MENGERHIVE block end ----
  // ---- VOICE-TOOLS block begin ----
  // her voice scratch space: the one write her fast voice has, and the confinement that keeps it in its folder
  'packages/experimental/webworker-runtime/src/x6/voice-scratch.ts',
  // ---- VOICE-TOOLS block end ----
  // ---- MANDATE block begin ----
  // the owner mandate: its policy, and the card's code that decides the terms he is shown before his passkey
  'deploy/cloudflare/src/owner-mandate.mjs',
  'packages/client/ui-layout/src/client/spatial/aumlok/mandate.ts',
  'packages/client/ui-layout/src/client/spatial/portal/MandateCell.tsx',
  // ---- MANDATE block end ----
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
  // The capsule contract's canonical form and record verifier (docs/capsule/CONTRACT.md section 11: new protected files are
  // added in the landing that creates them). Under deploy/ they are closed by default already; these are the second wall.
  'deploy/cloudflare/src/capsule-canon.mjs',
  'deploy/cloudflare/src/capsule-envelope.mjs',
  'deploy/cloudflare/src/capsule-canon.vectors.json',
  'deploy/cloudflare/src/capsule-act-shapes.mjs',
])

/** Files in FROZEN_FILES that are not in the tree today: frozen so a proposal may not ADD them. */
export const FROZEN_ABSENT_FILES = Object.freeze([
  'deploy/package.json',
  'deploy/cloudflare/package.json',
  'deploy/cloudflare/src/package.json',
  'deploy/cloudflare/src/__tests__/package.json',
])

/** The 16 governance organs (server/ball-transition.mjs T2_ONLY_ORGANS; equality pinned by frozen-paths.test.mjs). */
export const FROZEN_ORGAN_IDS = Object.freeze([
  'seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura',
  'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map',
  'seed-judge', 'gate-judge', 'grant-ledger', 'aumlok-identity', 'aumlok-keys',
  'auma-scion', 'seed-boot', 'auma-kernel',
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
 * exact path, case-sensitively (OPEN_INSIDE_CLOSED too, by exact path only); CLOSED_* match it lower-cased, so a case variant of a closed name is closed too. Everything else is closed by default: every package.json, scripts/**, vitest.config.ts, vitest.shared.ts,
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
  // the two files card 1 adds are named closed here as well: an open path that holds them would let a later proposal edit the judge
  'packages/experimental/webworker-runtime/src/x6/checkpoint-verify.ts',
  'packages/experimental/webworker-runtime/src/x6/checkpoint-verify-tool.ts',
  'packages/experimental/webworker-runtime/src/x6/ball-loader.ts',
  'packages/experimental/webworker-runtime/src/x6/wasm-cells.ts',
  'packages/experimental/webworker-runtime/src/x6/cell-journal.ts', // the cell-call journal runs inside the cell host
  // the two-hosts handoff calls the edge and writes the journal
  'packages/experimental/webworker-runtime/src/x6/cell-handoff.ts',
  // her workflow executor runs her own scripts inside the worker; ball-loader hands it the tool gate
  'packages/experimental/webworker-runtime/src/x6/workflow-executor.ts',
  // ---- CORDECHO block begin ----
  // the Cord commit rule calls the edge, writes the journal and commits the head she holds
  'packages/experimental/webworker-runtime/src/x6/cord-run.ts',
  // ---- CORDECHO block end ----
  // ---- TOOLS block begin ----
  // her tool registry: the policy that qualifies and mounts the tools she writes (tier T1, a sealed cell per tool)
  'packages/experimental/webworker-runtime/src/x6/tool-registry.ts',
  // ---- TOOLS block end ----
  // ---- MENGERHIVE block begin ----
  // the Menger split-body runner and its wave/observability oracle call the edge and write the edge cell journal
  'packages/experimental/webworker-runtime/src/x6/menger-run.ts',
  'packages/experimental/webworker-runtime/src/x6/menger-observe.ts',
  // ---- MENGERHIVE block end ----
  // ---- VOICE-TOOLS block begin ----
  // her voice scratch space: the one write her fast voice has, and the confinement that keeps it in its folder
  'packages/experimental/webworker-runtime/src/x6/voice-scratch.ts',
  // ---- VOICE-TOOLS block end ----
  // ---- MANDATE block begin ----
  // the owner mandate's card: it decides the terms he is shown before his passkey
  'packages/client/ui-layout/src/client/spatial/aumlok/mandate.ts',
  'packages/client/ui-layout/src/client/spatial/portal/MandateCell.tsx',
  // ---- MANDATE block end ----
  // What the frozen judges import is a judge too (the rule above FROZEN_FILES'
  // passkey entries). The passkey screen's own code that class3-approval.ts imports, and the fingerprint wait that
  // RepoProposalCell.tsx imports. Closed by exact path, never by folder: her doors stay open but for this small core.
  // deploy/ci/frozen-paths.test.mjs walks every judge's relative imports and pins what is still open (a person decides it).
  'packages/client/ui-layout/src/client/spatial/apps/identity/host.ts',
  'packages/client/ui-layout/src/client/spatial/apps/identity/webauthn.ts',
  'packages/client/ui-layout/src/client/spatial/aumlok/aumlok-ceremony.ts',
  'packages/client/ui-layout/src/client/spatial/portal/touch-id-timing.ts',
  // The approval cards: each shows him what he approves with his fingerprint.
  'packages/client/ui-layout/src/client/spatial/portal/OrganSetCell.tsx',
  'packages/client/ui-layout/src/client/spatial/portal/NightGrantCell.tsx',
  'packages/client/ui-layout/src/client/spatial/portal/OutwardApprovalCell.tsx',
  'packages/client/ui-layout/src/client/spatial/portal/CodeDiffRow.tsx',
  // The pins: she never changes the judge, the checks or the pins.
  'packages/experimental/webworker-runtime/src/x6/scion-pins.ts',
  'packages/experimental/webworker-runtime/src/x6/voice-organ-pins.ts',
  // Independent read of an earlier commit: what those cards and the binding ceremony take their words, terms, diff and key from.
  'packages/client/ui-layout/src/client/spatial/aumlok/outward-class3.ts',
  'packages/client/ui-layout/src/client/spatial/aumlok/night-grant.ts',
  'packages/client/ui-layout/src/client/spatial/aumlok/organ-set.ts',
  'packages/client/ui-layout/src/client/spatial/portal/organ-code-diff.ts',
  'packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts',
  'packages/client/ui-layout/src/client/spatial/aumlok/aumlok-root.ts',
  // Her storage: the whole folder, every file and subfolder, existing or new, any name and any case spelling (matched in
  // lower case). Her four thread sync files are opened again by exact path in OPEN_INSIDE_CLOSED below;
  // her whole-store code (idb-persist.ts and the rest) and anything that lands there later stay closed.
  'packages/experimental/webworker-runtime/src/storage/**',
])

/**
 * Open although a CLOSED_INSIDE_OPEN pattern covers them (a file-by-file closed list
 * left a NEW file directly in her storage folder open). Exact paths, no patterns, matched exactly and case-sensitively like
 * OPEN_PATHS, so a case variant (Thread-Writer.ts) stays closed. Each must also be covered by OPEN_PATHS; a closed name or
 * segment, the frozen list and the test rules still win. Her thread sync: she builds her
 * cloud home herself, through her proposal cards, and he permits each with his passkey.
 */
export const OPEN_INSIDE_CLOSED = Object.freeze([
  'packages/experimental/webworker-runtime/src/storage/thread-writer.ts',
  'packages/experimental/webworker-runtime/src/storage/thread-sync.ts',
  'packages/experimental/webworker-runtime/src/storage/thread-sync-plan.ts',
  'packages/experimental/webworker-runtime/src/storage/thread-store-types.ts',
])

/** Closed anywhere, by file name: manifests and configuration, and the instruction files coding agents read (
 * every AGENTS*.md, CLAUDE*.md and GEMINI*.md, e.g. AGENTS.override.md, CLAUDE.local.md).
 * And by segment: an installed-package folder or a dot name (node_modules would shadow an import; .npmrc, .env and the
 * like configure the tools). */
export const CLOSED_NAMES = Object.freeze(['package.json', 'tsconfig*.json', 'vite.config.*', 'vitest.*', '*.config.*', 'agents*.md', 'claude*.md', 'gemini*.md'])
export const CLOSED_SEGMENTS = Object.freeze(['node_modules', '.*'])

export const PATH_NOT_OPEN_NEXT = 'this path is changed only by a person with repo write; ask on the relay'
export const PATH_NOT_PLAIN_NEXT = 'use a plain path: printable ASCII letters only, and never one that equals another path in the repository when both are lower-cased (a case-insensitive disk would make them one file)'
export const SECRET_PATH_NEXT = 'this path has the shape of a credential file (a dot name such as .env, or a secret, private, password, credential, keypair, key or vault name): credentials never go through a proposal, they stay at the edge'
export const PROPOSAL_PATH_NEXTS = Object.freeze([...FROZEN_NEXTS, PATH_NOT_OPEN_NEXT, PATH_NOT_PLAIN_NEXT, SECRET_PATH_NEXT])

/** One segment with a credential's shape: a dot name (.env, .npmrc, .ssh ...) but `.github`, or a secret word in it. The
 * same words the edge's private-name rule refuses (cloud-brokers.mjs privatePart), less its non-secret ones. */
const secretSegment = part => (part.startsWith('.') && part !== '.github') || /(?:private|secret|credential|password|keypair|vault|token)/i.test(part)
  || /(?:^|[._-])keys?(?:[._-]|$)/i.test(part) || /^(?:id_rsa|id_ed25519)$/i.test(part)

/**
 * Whether any segment of the path has a credential file's shape. Refused at every level: a proposal never adds or changes
 * a credential file, and her reads never return one.
 * @param {unknown} path Repository-relative path.
 * @returns {boolean}
 */
export function isSecretShapedRepoPath(path) {
  return typeof path !== 'string' || path.split('/').some(secretSegment)
}

const exactFiles = new Set([...FROZEN_FILES, ...FROZEN_ORGAN_FILES].map(path => path.toLowerCase()))
const testFiles = new Set(FROZEN_TEST_FILES.map(path => path.toLowerCase()))
const within = (path, directories) => directories.some(directory => path === directory.toLowerCase() || path.startsWith(directory.toLowerCase() + '/'))

/** A glob of OPEN_PATHS' form as a whole-path regular expression (exported for the list's own shape test). */
export function globRegExp(pattern) {
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
// CLOSED_INSIDE_OPEN is matched against the lower-cased path, so its patterns are lower-cased too (an entry
// with a capital, MandateCell.tsx, matched nothing; it was closed only because FROZEN_FILES names it as well).
const openPath = matcher(OPEN_PATHS), openNewPath = matcher(OPEN_NEW_PATHS), closedInsideOpen = matcher(CLOSED_INSIDE_OPEN.map(entry => entry.toLowerCase()))
const openInsideClosed = new Set(OPEN_INSIDE_CLOSED)
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
 * @param {'open'|'guarded'} [level] The door level (REPO_DOOR_LEVEL). At 'open' every plain, canonical path is open but a
 * secret-shaped one and an installed-package folder.
 * @returns {boolean}
 */
export function isOpenRepoPath(path, status = 'modified', level = REPO_DOOR_LEVEL) {
  if (!isPlainRepoPath(path) || frozenJudgedForm(path) === null) return false
  const parts = path.split('/')
  if (doorLevel(level) === 'open') return !isSecretShapedRepoPath(path) && !parts.some(part => part.toLowerCase() === 'node_modules')
  // Closed names, segments and folders are matched in lower case: a case-insensitive disk reads Package.json as package.json.
  if (parts.some(part => closedSegment(part.toLowerCase())) || closedName(parts.at(-1).toLowerCase())) return false
  // OPEN_INSIDE_CLOSED lifts CLOSED_INSIDE_OPEN only, and only for the exact, case-sensitive path.
  if (closedInsideOpen(path.toLowerCase()) && !openInsideClosed.has(path)) return false
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
 * @param {'open'|'guarded'} [level] The door level; at 'open' nothing is frozen but a path that is not canonical.
 * @returns {boolean} true for a frozen path and for any path that is not canonical.
 */
export function isFrozenRepoPath(path, level = REPO_DOOR_LEVEL) {
  const judged = frozenJudgedForm(path)
  if (doorLevel(level) === 'open') return judged === null
  return judged === null || within(judged, FROZEN_DIRECTORIES) || exactFiles.has(judged)
}

/**
 * Whether a CHANGE or DELETE of this path (a test main already has) is refused. Additions are judged by isFrozenRepoPath only.
 * @param {unknown} path Repository-relative path.
 * @param {'open'|'guarded'} [level] The door level; at 'open' every test is hers to change but a path that is not canonical.
 * @returns {boolean} true for a frozen test path and for any path that is not canonical.
 */
export function isFrozenTestPath(path, level = REPO_DOOR_LEVEL) {
  const judged = frozenJudgedForm(path)
  if (doorLevel(level) === 'open') return judged === null
  return judged === null || within(judged, FROZEN_TEST_DIRECTORIES) || testFiles.has(judged)
}

/**
 * The `next` sentence for a refused path.
 * @param {string} path The refused path.
 * @param {boolean} [test] Whether it was refused as an existing test.
 * @param {'open'|'guarded'} [level] The door level.
 * @returns {string} One of FROZEN_NEXTS.
 */
export function frozenPathNext(path, test = false, level = REPO_DOOR_LEVEL) {
  if (test && !isFrozenRepoPath(path, level)) return FROZEN_TEST_NEXT
  return frozenJudgedForm(path) === 'packages/experimental/webworker-runtime/src/x6/ball-loader.ts' ? FROZEN_TOOLS_NEXT : FROZEN_PATH_NEXT
}

/**
 * The one judgement of a proposal path, in order: plain (and no case twin), frozen, a test main already has, open.
 * At level 'open': plain (and no case twin), canonical, not secret-shaped, not an installed-package folder; nothing else.
 * @param {unknown} path Repository-relative path, exact case.
 * @param {'added'|'modified'|'removed'} status What the proposal does to it.
 * @param {{ twin?: boolean, level?: 'open'|'guarded' }} [options] `twin`: the path has a case twin in the base or head tree
 * (caseTwinPaths). `level`: the door level (REPO_DOOR_LEVEL).
 * @returns {null | { code: 'REPO_PATH_NOT_PLAIN'|'REPO_FROZEN_PATH_REFUSED'|'REPO_PATH_NOT_OPEN', next: string, test?: true }}
 */
export function proposalPathRefusal(path, status, { twin = false, level = REPO_DOOR_LEVEL } = {}) {
  if (!isPlainRepoPath(path) || twin) return { code: 'REPO_PATH_NOT_PLAIN', next: PATH_NOT_PLAIN_NEXT }
  if (doorLevel(level) === 'open') {
    if (frozenJudgedForm(path) === null) return { code: 'REPO_PATH_NOT_PLAIN', next: PATH_NOT_PLAIN_NEXT }
    if (isSecretShapedRepoPath(path)) return { code: 'REPO_PATH_NOT_OPEN', next: SECRET_PATH_NEXT }
    if (!isOpenRepoPath(path, status, 'open')) return { code: 'REPO_PATH_NOT_OPEN', next: PATH_NOT_OPEN_NEXT }
    return null
  }
  if (isFrozenRepoPath(path, 'guarded')) return { code: 'REPO_FROZEN_PATH_REFUSED', next: frozenPathNext(path, false, 'guarded') }
  if (status !== 'added' && isFrozenTestPath(path, 'guarded')) return { code: 'REPO_FROZEN_PATH_REFUSED', next: FROZEN_TEST_NEXT, test: true }
  if (!isOpenRepoPath(path, status, 'guarded')) return { code: 'REPO_PATH_NOT_OPEN', next: PATH_NOT_OPEN_NEXT }
  return null
}

const NUL_LIST = text => { const fields = text.split('\u0000'); if (fields.at(-1) === '') fields.pop(); return fields }

/**
 * CI's judgement of `git diff --no-renames --name-status -z <main>...HEAD` (status, NUL, path, NUL, ...): with renames
 * off, a rename is a delete of the old path and an add of the new one, so both sides are judged. `trees` are
 * `git ls-tree -r -t -z --name-only` of origin/main and of HEAD; given, case twins are refused too (an older workflow that
 * passes only the diff still gets every other judgement).
 * @param {string} text The NUL-separated diff.
 * @param {{ base?: string, head?: string, level?: 'open'|'guarded' }} [trees] The two NUL-separated tree listings, and the
 * door level (REPO_DOOR_LEVEL: CI calls main's copy, so main's level judges).
 * @returns {string[]} One line per refusal; empty when the diff is free.
 */
export function frozenDiffRefusals(text, { base, head, level = REPO_DOOR_LEVEL } = {}) {
  if (typeof text !== 'string' || (base !== undefined && typeof base !== 'string') || (head !== undefined && typeof head !== 'string')) return ['FROZEN_DIFF_UNREADABLE']
  const fields = NUL_LIST(text)
  if (fields.length % 2 !== 0) return ['FROZEN_DIFF_UNREADABLE']
  const entries = []
  for (let index = 0; index < fields.length; index += 2) entries.push({ status: fields[index], path: fields[index + 1] })
  const twins = new Set(base === undefined && head === undefined ? [] : caseTwinPaths(entries.map(entry => entry.path), NUL_LIST(base ?? ''), NUL_LIST(head ?? '')))
  const refusals = []
  for (const { status, path } of entries) {
    if (!['A', 'M', 'D', 'T'].includes(status)) { refusals.push(`FROZEN_DIFF_STATUS_UNKNOWN ${status} ${path}`); continue }
    const refusal = proposalPathRefusal(path, status === 'A' ? 'added' : status === 'D' ? 'removed' : 'modified', { twin: twins.has(path), level })
    if (refusal) refusals.push(`${refusal.test ? 'REPO_FROZEN_TEST_REFUSED' : refusal.code} ${status} ${JSON.stringify(path).slice(1, -1)}`)
  }
  return refusals
}

/**
 * The test files a proposal ADDS, from the same diff: CI's `new-tests` job runs them, alone; the protected jobs remove them.
 * @param {string} text The NUL-separated `--name-status` diff.
 * @param {'open'|'guarded'} [level] The door level. At 'open' every path is open to change too, so no added file is a
 * guarded new test (CI's heavy jobs, which use this, do not run at 'open').
 * @returns {{ node: string[], vitest: string[] }} node --test files and vitest spec files.
 */
export function addedTestFiles(text, level = REPO_DOOR_LEVEL) {
  const fields = typeof text === 'string' ? NUL_LIST(text) : [], node = [], vitest = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index], path = fields[index + 1]
    if (status !== 'A' || !isPlainRepoPath(path) || isOpenRepoPath(path, 'modified', level) || !isOpenRepoPath(path, 'added', level) || !newTestPath(path)) continue
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
 * @param {'open'|'guarded'} [level] The door level (addedTestFiles).
 * @returns {{ tests: string[], auma: string[] }} Repository paths, in diff order.
 */
export function protectedJobRemovals(text, level = REPO_DOOR_LEVEL) {
  const fields = typeof text === 'string' ? NUL_LIST(text) : [], auma = []
  const { node, vitest } = addedTestFiles(text, level)
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index], path = fields[index + 1]
    if (status === 'A' && typeof path === 'string' && path.toLowerCase().startsWith(AUMA_EDGE_FOLDER + '/')) auma.push(path)
  }
  return { tests: [...node, ...vitest], auma }
}
