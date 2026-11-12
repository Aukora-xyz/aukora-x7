// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * AUMA IS THE META-WORKSPACE (North Star §24.2). There is one root workspace, her home `/dsh/home/auma`. Sub-workspaces
 * live inside it at `/dsh/home/auma/workspaces/<name>`. Threads from before this law run in `/dsh/home/auma-one`; that
 * directory, its workspace registration and its sessions are never renamed or moved (a session's folder is keyed on its
 * cwd, so moving one would lose the thread), they are only named for what they are.
 *
 * This module is pure: where a thread lives, in words for its card, and where a new thread starts.
 * @module meta-workspace
 */

/** Her root workspace in the browser worker's file system. */
export const AUMA_ROOT_PATH = '/dsh/home/auma'
/** Where her sub-workspaces live. */
export const AUMA_SUB_WORKSPACES = `${AUMA_ROOT_PATH}/workspaces`
/** The workspace her threads ran in before the meta-workspace law. */
export const AUMA_LEGACY_PATH = '/dsh/home/auma-one'

/** Where one thread lives, for its card: nothing for the root itself. */
export type ThreadPlace =
  | { readonly kind: 'sub'; readonly name: string }
  | { readonly kind: 'legacy'; readonly name: string }
  | null

const under = (path: string, root: string): string | null => (path === root ? '' : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null)

/**
 * Name where a thread lives from its working directory.
 * @param cwd - the session's cwd, as the host reports it (undefined when it reports none).
 * @returns the sub-workspace, the legacy workspace, or null (her root, or a place this law does not name).
 */
export function threadPlaceOf(cwd: string | undefined): ThreadPlace {
  if (cwd === undefined) return null
  const path = cwd.length > 1 ? cwd.replace(/\/+$/u, '') : cwd
  const sub = under(path, AUMA_SUB_WORKSPACES)
  if (sub !== null && sub !== '') return { kind: 'sub', name: sub.split('/')[0] ?? sub }
  if (under(path, AUMA_LEGACY_PATH) !== null) return { kind: 'legacy', name: 'auma-one' }
  return null
}

/** Where a new thread starts. */
export type NewThreadTarget =
  /** Her root workspace is registered: start there. */
  | { readonly kind: 'root'; readonly workspaceId: string }
  /** No workspace at all: the host's first-use default (her root, in the worker). */
  | { readonly kind: 'first-use' }
  /** Other workspaces exist but not her root: register it beside them, then start there. */
  | { readonly kind: 'register-root' }

/**
 * Decide where a new thread starts from the registered workspaces.
 * @param workspaces - the workspaces this browser has, as its service lists them.
 * @returns the target.
 */
export function newThreadTarget(workspaces: readonly { readonly workspaceId: string; readonly path?: string }[]): NewThreadTarget {
  const root = workspaces.find(workspace => workspace.path === AUMA_ROOT_PATH)
  if (root !== undefined) return { kind: 'root', workspaceId: root.workspaceId }
  return workspaces.length === 0 ? { kind: 'first-use' } : { kind: 'register-root' }
}
