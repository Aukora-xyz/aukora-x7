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
  'packages/experimental/webworker-runtime/src/storage/**',
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
const openPath = matcher(OPEN_PATHS), openNewPath = matcher(OPEN_NEW_PATHS), closedInsideOpen = matcher(CLOSED_INSIDE_OPEN)
const closedName = matcher(CLOSED_NAMES), closedSegment = matcher(CLOSED_SEGMENTS)

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
 * @returns true for a frozen path and for any path that is not canonical.
 */
export function isFrozenRepoPath(path: unknown): boolean {
  const judged = frozenJudgedForm(path)
  return judged === null || within(judged, FROZEN_DIRECTORIES) || exactFiles.has(judged)
}

/**
 * Whether a change or delete of this path (a test main already has) is refused; additions are free.
 * @param path - repository-relative path.
 * @returns true for a frozen test path and for any path that is not canonical.
 */
export function isFrozenTestPath(path: unknown): boolean {
  const judged = frozenJudgedForm(path)
  return judged === null || within(judged, FROZEN_TEST_DIRECTORIES) || testFiles.has(judged)
}

/**
 * Whether a proposal may touch this path at all: open, plain, not a configuration name, not an installed package or dot
 * segment, not closed inside an open folder. A pattern of OPEN_NEW_PATHS is open for 'added' only.
 * @param path - repository-relative path, exact case.
 * @param status - what the proposal does to it.
 * @returns true when open.
 */
export function isOpenRepoPath(path: unknown, status: 'added' | 'modified' | 'removed' = 'modified'): boolean {
  if (!isPlainRepoPath(path) || frozenJudgedForm(path) === null) return false
  const parts = path.split('/')
  if (parts.some(part => closedSegment(part.toLowerCase())) || closedName((parts.at(-1) ?? '').toLowerCase()) || closedInsideOpen(path.toLowerCase())) return false
  return openPath(path) || (status === 'added' && openNewPath(path))
}

export type ProposalPathCode = 'REPO_PATH_NOT_PLAIN' | 'REPO_FROZEN_PATH_REFUSED' | 'REPO_PATH_NOT_OPEN'

/**
 * The one judgement of a proposal path, in the edge's order: plain (and no case twin), frozen, a test main has, open.
 * @param path - repository-relative path, exact case.
 * @param status - what the proposal does to it.
 * @param twin - whether the path has a case twin.
 * @returns the refusal's code, or null when the path may change.
 */
export function proposalPathRefusal(path: unknown, status: 'added' | 'modified' | 'removed', twin = false): ProposalPathCode | null {
  if (!isPlainRepoPath(path) || twin) return 'REPO_PATH_NOT_PLAIN'
  if (isFrozenRepoPath(path)) return 'REPO_FROZEN_PATH_REFUSED'
  if (status !== 'added' && isFrozenTestPath(path)) return 'REPO_FROZEN_PATH_REFUSED'
  if (!isOpenRepoPath(path, status)) return 'REPO_PATH_NOT_OPEN'
  return null
}
