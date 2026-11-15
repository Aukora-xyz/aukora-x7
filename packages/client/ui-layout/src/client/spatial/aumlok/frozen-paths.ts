// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PAGE'S COPY OF THE FROZEN LIST (deploy/ci/frozen-paths.mjs). packages/ may not import deploy/, so the card keeps
 * this copy; packages/client/ui-layout/tests/repo-proposal-frozen.client.spec.ts fails when the two differ in any entry
 * or in any judgement. Change both together, or neither.
 *
 * A proposal that changes a frozen path, or changes or deletes a test main already has, is refused by the edge at write,
 * stage and merge and by CI with main's list; the card refuses it too and asks for no passkey (repoProposalProblems).
 * Now the rule is turned round: a proposal may change ONLY a plain (printable ASCII, no case twin), OPEN and
 * unfrozen path; the open list and its judgement are copied here too.
 * @module aumlok/frozen-paths
 */

/**
 * The door level, the page's copy of deploy/ci/frozen-paths.mjs REPO_DOOR_LEVEL (pinned equal by the spec).
 * 'open': every path is hers to propose but a path that is not plain or canonical, a secret-shaped one and an
 * installed-package folder; his passkey on the card is the gate. 'guarded': the lists below, as before the open level.
 * The owner changes this line (in deploy/ci/frozen-paths.mjs and here).
 */
export type RepoDoorLevel = 'open' | 'guarded'
export const REPO_DOOR_LEVEL: RepoDoorLevel = 'open'
export const REPO_DOOR_LEVELS: readonly RepoDoorLevel[] = Object.freeze(['open', 'guarded'])
/** A level as judged: anything but 'open' is the stricter 'guarded'. */
export const doorLevel = (level: unknown): RepoDoorLevel => (level === 'open' ? 'open' : 'guarded')

export const FROZEN_DIRECTORIES: readonly string[] = Object.freeze(['.github', 'deploy/ci'])

export const DECISION_6_FILES: readonly string[] = Object.freeze([
  'deploy/cloudflare/src/head-do.mjs',
  'deploy/cloudflare/src/worker.mjs',
  'packages/experimental/webworker-runtime/src/x6/ball-loader.ts',
])

export const FROZEN_FILES: readonly string[] = Object.freeze([
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
  'packages/client/ui-layout/src/client/spatial/aumlok/frozen-paths.ts',
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
  'deploy/cloudflare/src/capsule-canon.mjs',
  'deploy/cloudflare/src/capsule-envelope.mjs',
  'deploy/cloudflare/src/capsule-canon.vectors.json',
  'deploy/cloudflare/src/capsule-act-shapes.mjs',
])

export const FROZEN_ABSENT_FILES: readonly string[] = Object.freeze([
  'deploy/package.json',
  'deploy/cloudflare/package.json',
  'deploy/cloudflare/src/package.json',
  'deploy/cloudflare/src/__tests__/package.json',
])

export const FROZEN_ORGAN_IDS: readonly string[] = Object.freeze([
  'seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura',
  'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map',
  'seed-judge', 'gate-judge', 'grant-ledger', 'aumlok-identity', 'aumlok-keys',
  'auma-scion', 'seed-boot',
])

export const FROZEN_ORGAN_FILES: readonly string[] = Object.freeze(FROZEN_ORGAN_IDS.map(id => `mirror/home/auma/seed/organs/${id}.js`))

export const FROZEN_TEST_DIRECTORIES: readonly string[] = Object.freeze(['deploy/cloudflare/src/__tests__'])
export const FROZEN_TEST_FILES: readonly string[] = Object.freeze(['packages/experimental/webworker-runtime/tests/x6/large-store-boot.spec.ts'])

export const OPEN_PATHS: readonly string[] = Object.freeze([
  'docs/auma/**',
  'apps/web/src/**',
  'packages/client/*/src/**',
  'packages/experimental/webworker-runtime/src/**',
  'deploy/cloudflare/src/crew-relay-tool.mjs',
  'mirror/home/auma/seed/organs/*.js',
  'packages/client/*/README*.md',
  'apps/web/README*.md',
])

export const OPEN_NEW_PATHS: readonly string[] = Object.freeze([
  'packages/client/*/tests/**/*.spec.ts',
  'packages/client/*/tests/**/*.spec.tsx',
  'packages/experimental/webworker-runtime/tests/**/*.spec.ts',
  'deploy/cloudflare/src/__tests__/auma-*.test.mjs',
  'deploy/cloudflare/src/auma/**',
])

export const CLOSED_INSIDE_OPEN: readonly string[] = Object.freeze([
  'packages/experimental/webworker-runtime/src/x6/ball-loader.ts',
  'packages/experimental/webworker-runtime/src/x6/wasm-cells.ts',
  'packages/experimental/webworker-runtime/src/x6/cell-journal.ts', // the cell-call journal runs inside the cell host
  // the two-hosts handoff calls the edge and writes the journal
  'packages/experimental/webworker-runtime/src/x6/cell-handoff.ts',
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
  // ---- MANDATE block begin ----
  // the owner mandate's card: it decides the terms he is shown before his passkey
  'packages/client/ui-layout/src/client/spatial/aumlok/mandate.ts',
  'packages/client/ui-layout/src/client/spatial/portal/MandateCell.tsx',
  // ---- MANDATE block end ----
  // What the frozen judges import is a judge too; closed by exact path, never by folder.
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
  // Her storage: the whole folder, any name, subfolder or case spelling; her four thread sync files are opened again by
  // exact path in OPEN_INSIDE_CLOSED.
  'packages/experimental/webworker-runtime/src/storage/**',
])

/** Open although a CLOSED_INSIDE_OPEN pattern covers them: exact, case-sensitive paths. */
export const OPEN_INSIDE_CLOSED: readonly string[] = Object.freeze([
  'packages/experimental/webworker-runtime/src/storage/thread-writer.ts',
  'packages/experimental/webworker-runtime/src/storage/thread-sync.ts',
  'packages/experimental/webworker-runtime/src/storage/thread-sync-plan.ts',
  'packages/experimental/webworker-runtime/src/storage/thread-store-types.ts',
])

export const CLOSED_NAMES: readonly string[] = Object.freeze(['package.json', 'tsconfig*.json', 'vite.config.*', 'vitest.*', '*.config.*', 'agents*.md', 'claude*.md', 'gemini*.md'])
export const CLOSED_SEGMENTS: readonly string[] = Object.freeze(['node_modules', '.*'])

const exactFiles = new Set([...FROZEN_FILES, ...FROZEN_ORGAN_FILES].map(path => path.toLowerCase()))
const testFiles = new Set(FROZEN_TEST_FILES.map(path => path.toLowerCase()))
const within = (path: string, directories: readonly string[]): boolean =>
  directories.some(directory => path === directory.toLowerCase() || path.startsWith(`${directory.toLowerCase()}/`))

function globRegExp(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern.charAt(index)
    if (pattern.startsWith('**/', index)) { source += '(?:[^/]+/)*'; index += 2 }
    else if (pattern.startsWith('/**', index) && index + 3 === pattern.length) { source += '/.+'; index += 2 }
    else if (char === '*') source += '[^/]*'
    else source += /[a-z0-9_/-]/iu.test(char) ? char : `\\${char}`
  }
  return new RegExp(`^${source}$`, 'u')
}
const matcher = (patterns: readonly string[]): ((path: string) => boolean) => {
  const expressions = patterns.map(globRegExp)
  return path => expressions.some(expression => expression.test(path))
}
// CLOSED_INSIDE_OPEN is matched against the lower-cased path, so its patterns are lower-cased too.
const openPath = matcher(OPEN_PATHS), openNewPath = matcher(OPEN_NEW_PATHS)
const closedInsideOpen = matcher(CLOSED_INSIDE_OPEN.map(entry => entry.toLowerCase()))
const openInsideClosed = new Set(OPEN_INSIDE_CLOSED)
const closedName = matcher(CLOSED_NAMES), closedSegment = matcher(CLOSED_SEGMENTS)

const secretSegment = (part: string): boolean => (part.startsWith('.') && part !== '.github')
  || /(?:private|secret|credential|password|keypair|vault|token)/iu.test(part)
  || /(?:^|[._-])keys?(?:[._-]|$)/iu.test(part) || /^(?:id_rsa|id_ed25519)$/iu.test(part)

/**
 * Whether any segment of the path has a credential file's shape (refused at every level).
 * @param path - repository-relative path.
 * @returns true for a secret-shaped path.
 */
export function isSecretShapedRepoPath(path: unknown): boolean {
  return typeof path !== 'string' || path.split('/').some(secretSegment)
}

/**
 * Whether a path holds only printable ASCII (no space, no control, nothing above U+007E).
 * @param path - repository-relative path.
 * @returns true for a plain path.
 */
export function isPlainRepoPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 1024 && /^[\u0021-\u007e]+$/u.test(path)
}

/**
 * The changed paths that equal another path when both are lower-cased, counting every leading folder.
 * @param changed - the paths a proposal changes.
 * @param trees - every path of the base and head trees (the card passes only the changed paths).
 * @returns the changed paths that have a case twin, in the order given.
 */
export function caseTwinPaths(changed: Iterable<string>, ...trees: Iterable<string>[]): string[] {
  const spellings = new Map<string, string | null>()
  const add = (path: string): void => {
    let end = path.indexOf('/')
    for (;;) {
      const prefix = end === -1 ? path : path.slice(0, end), key = prefix.toLowerCase(), known = spellings.get(key)
      if (known === undefined) spellings.set(key, prefix)
      else if (known !== prefix && known !== null) spellings.set(key, null)
      if (end === -1) break
      end = path.indexOf('/', end + 1)
    }
  }
  const list = [...changed]
  for (const tree of trees) for (const path of tree) if (typeof path === 'string') add(path)
  for (const path of list) add(path)
  return list.filter((path) => {
    const parts = path.split('/')
    return parts.some((_, index) => spellings.get(parts.slice(0, index + 1).join('/').toLowerCase()) === null)
  })
}

/**
 * The form a path is judged in (lower case), or null when it is not canonical; such a path never passes as free.
 * @param path - repository-relative path.
 * @returns the judged form, or null.
 */
export function frozenJudgedForm(path: unknown): string | null {
  if (!isPlainRepoPath(path) || /[\\%?#]/u.test(path)) return null
  if (path.split('/').some(part => part === '' || part === '.' || part === '..' || part.endsWith('.'))) return null
  return path.toLowerCase()
}

/**
 * Whether a proposal may never change, add, delete or rename this path.
 * @param path - repository-relative path.
 * @param level - the door level; at 'open' nothing is frozen but a path that is not canonical.
 * @returns true for a frozen path and for any path that is not canonical.
 */
export function isFrozenRepoPath(path: unknown, level: RepoDoorLevel = REPO_DOOR_LEVEL): boolean {
  const judged = frozenJudgedForm(path)
  if (doorLevel(level) === 'open') return judged === null
  return judged === null || within(judged, FROZEN_DIRECTORIES) || exactFiles.has(judged)
}

/**
 * Whether a change or delete of this path (a test main already has) is refused; additions are free.
 * @param path - repository-relative path.
 * @param level - the door level; at 'open' nothing is frozen but a path that is not canonical.
 * @returns true for a frozen test path and for any path that is not canonical.
 */
export function isFrozenTestPath(path: unknown, level: RepoDoorLevel = REPO_DOOR_LEVEL): boolean {
  const judged = frozenJudgedForm(path)
  if (doorLevel(level) === 'open') return judged === null
  return judged === null || within(judged, FROZEN_TEST_DIRECTORIES) || testFiles.has(judged)
}

/**
 * Whether a proposal may touch this path at all: open, plain, not a configuration name, not an installed package or dot
 * segment, not closed inside an open folder. A pattern of OPEN_NEW_PATHS is open for 'added' only.
 * @param path - repository-relative path, exact case.
 * @param status - what the proposal does to it.
 * @param level - the door level (REPO_DOOR_LEVEL).
 * @returns true when open.
 */
export function isOpenRepoPath(path: unknown, status: 'added' | 'modified' | 'removed' = 'modified', level: RepoDoorLevel = REPO_DOOR_LEVEL): boolean {
  if (!isPlainRepoPath(path) || frozenJudgedForm(path) === null) return false
  const parts = path.split('/')
  if (doorLevel(level) === 'open') return !isSecretShapedRepoPath(path) && !parts.some(part => part.toLowerCase() === 'node_modules')
  if (parts.some(part => closedSegment(part.toLowerCase())) || closedName((parts.at(-1) ?? '').toLowerCase())) return false
  // OPEN_INSIDE_CLOSED lifts CLOSED_INSIDE_OPEN only, and only for the exact, case-sensitive path.
  if (closedInsideOpen(path.toLowerCase()) && !openInsideClosed.has(path)) return false
  return openPath(path) || (status === 'added' && openNewPath(path))
}

export type ProposalPathCode = 'REPO_PATH_NOT_PLAIN' | 'REPO_FROZEN_PATH_REFUSED' | 'REPO_PATH_NOT_OPEN'

/**
 * The one judgement of a proposal path, in the edge's order: plain (and no case twin), frozen, a test main has, open.
 * @param path - repository-relative path, exact case.
 * @param status - what the proposal does to it.
 * @param twin - whether the path has a case twin.
 * @param level - the door level (REPO_DOOR_LEVEL).
 * @returns the refusal's code, or null when the path may change.
 */
export function proposalPathRefusal(path: unknown, status: 'added' | 'modified' | 'removed', twin = false, level: RepoDoorLevel = REPO_DOOR_LEVEL)
  : ProposalPathCode | null {
  if (!isPlainRepoPath(path) || twin) return 'REPO_PATH_NOT_PLAIN'
  if (doorLevel(level) === 'open') {
    if (frozenJudgedForm(path) === null) return 'REPO_PATH_NOT_PLAIN'
    return isOpenRepoPath(path, status, 'open') ? null : 'REPO_PATH_NOT_OPEN'
  }
  if (isFrozenRepoPath(path, 'guarded')) return 'REPO_FROZEN_PATH_REFUSED'
  if (status !== 'added' && isFrozenTestPath(path, 'guarded')) return 'REPO_FROZEN_PATH_REFUSED'
  if (!isOpenRepoPath(path, status, 'guarded')) return 'REPO_PATH_NOT_OPEN'
  return null
}
