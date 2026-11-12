// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * DEPLOY-INERT PATHS: the one list of repository paths that never reach the deployed edge.
 *
 * Markdown under docs/ and Markdown at the repository root are not read by the web build (server/build-preview.mjs
 * bakes only selected mirror/ files into the VFS image), by the Worker bundle (deploy/cloudflare/src) or by the deploy
 * job. Three things depend on this list and must agree with it:
 *   1. .github/workflows/deploy-x61.yml `paths-ignore`: a push that touches only these paths starts no deploy, an
 *      optimisation only, since any run that does start deploys main's head, docs included
 *      (deploy/cloudflare/src/__tests__/deploy-workflow.test.mjs asserts the YAML list equals DEPLOY_INERT_GLOBS).
 *   2. deploy/ci/deploy-guard.mjs `watch`: docs-only commits after the live build do not count as an undeployed release.
 *   3. deploy/cloudflare/src/cloud-brokers.mjs: an owner session with no passkey (T1) may commit to main ONLY these
 *      paths. Everything else reaches a deployed artifact, so it goes through the proposal card (one passkey over the
 *      exact diff) or a passkey-approved publication. Auma proposes; the owner permits on the exact bytes.
 * Pure: no I/O. It lives under deploy/ (T2) because the Worker and the deploy job execute it.
 */

/** GitHub Actions path-filter globs, in the order the workflow lists them. `docs/*.md` is listed beside
 * `docs/**\/*.md` so a top-level docs file is ignored whether or not `**` matches zero directories. */
export const DEPLOY_INERT_GLOBS = Object.freeze(['*.md', 'docs/*.md', 'docs/**/*.md'])

/**
 * Whether a changed file, as GitHub reports it in a compare, matches DEPLOY_INERT_GLOBS (glob semantics: `*` never
 * crosses a slash). Used by the watcher to tell a docs-only commit from a release.
 * @param {unknown} path Repository-relative path.
 * @returns {boolean}
 */
export function matchesDeployInertGlob(path) {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.includes('\\')) return false
  return /^[^/]+\.md$/.test(path) || /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(path)
}

/**
 * The strict form the repo broker uses: a canonical path (no traversal, no encoding, no control or space characters)
 * that matches DEPLOY_INERT_GLOBS. Anything else is a deployed path.
 * @param {unknown} path Repository-relative path.
 * @returns {boolean}
 */
export function isDeployInertRepoPath(path) {
  if (typeof path !== 'string' || !path || /[\\%?#\u0000- \u007f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) return false
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/.test(path) || /^docs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/.test(path)
}
