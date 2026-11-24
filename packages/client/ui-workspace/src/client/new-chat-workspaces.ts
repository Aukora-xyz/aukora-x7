/**
 * THE NEW-CHAT WORKSPACE PICKER OFFERS ONE WORKSPACE: AUMA.
 *
 * Auma is the meta-workspace (North Star §24.2; `ui-layout/src/client/spatial/meta-workspace.ts`): her root
 * `/dsh/home/auma`. The new-chat picker lists only that one. The legacy `/dsh/home/auma-one` workspace (and any other)
 * is hidden from the PICKER only: it stays registered, its threads stay listed in the sidebar, readable and working.
 * When her root is not registered yet, the picker hides only `auma-one`, so it never offers an empty list; New chat on
 * the threads lane registers her root beside the others (`newThreadTarget`).
 * @module new-chat-workspaces
 */

/** Her root workspace (same path as `AUMA_ROOT_PATH` in ui-layout's meta-workspace.ts). */
export const AUMA_WORKSPACE_PATH = '/dsh/home/auma'
/** The workspace her threads ran in before the meta-workspace law. */
export const AUMA_ONE_WORKSPACE_PATH = '/dsh/home/auma-one'

const bare = (path: string | undefined): string | undefined =>
  path === undefined ? undefined : path.length > 1 ? path.replace(/\/+$/u, '') : path

/**
 * The workspaces a new chat's picker lists.
 * @param workspaces - every registered workspace.
 * @returns her root alone when registered; otherwise every workspace except `auma-one`.
 */
export function newChatWorkspaces<T extends { readonly path?: string }>(workspaces: readonly T[]): readonly T[] {
  const root = workspaces.filter(workspace => bare(workspace.path) === AUMA_WORKSPACE_PATH)
  if (root.length > 0) return root
  return workspaces.filter(workspace => bare(workspace.path) !== AUMA_ONE_WORKSPACE_PATH)
}
