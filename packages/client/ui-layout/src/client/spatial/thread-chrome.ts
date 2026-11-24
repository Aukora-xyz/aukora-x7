// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE SPATIAL THREAD CHROME, PUBLISHED FOR THE CONVERSATION HEADER (Round 23).
 *
 * The rule: the top of an open thread is ONE line: the title once (rename in place), its mode and its subagents
 * beside it, and nothing else. The header that draws it lives in `ui-conversation` (skeleton/ConversationSession.tsx),
 * which depends on this package, not the reverse, and every slot hop between this frame and that header passes an empty
 * owner. So, as the Work view's superagent bridge does, the Spatial shell publishes one page global while it is mounted:
 *
 *   its presence   makes the open thread's header the compact single line (the classic `?layout=stock` shell never
 *                  installs it, so its header, tabs and menus are unchanged, and so are its tests);
 *   renameThread   the host's own rename (the session's durable title in its event log), the call the classic sidebar
 *                  makes, so the card in the Threads lane and the open thread's header show the same name after a reload.
 *
 * The header reads it with `spatialChrome()` (`ui-conversation/src/client/skeleton/spatial-chrome.ts`), which checks the
 * version and the function and otherwise falls back to the full header. Bump `version` on any shape change.
 * @module spatial/thread-chrome
 */

export const SPATIAL_CHROME_GLOBAL = '__AUKORA_SPATIAL_CHROME__'

export interface SpatialChrome {
  readonly version: 1
  /** Rename a thread on its host; resolves to the title the host stored (it may trim it), or rejects with its reason. */
  readonly renameThread: (sessionId: string, title: string) => Promise<string>
}

/**
 * Publish the chrome for as long as the Spatial shell is mounted.
 * @param renameThread - the host rename.
 * @returns the uninstall, which removes only this installation.
 */
export function installSpatialChrome(renameThread: SpatialChrome['renameThread']): () => void {
  const chrome: SpatialChrome = Object.freeze({ version: 1, renameThread })
  Object.defineProperty(globalThis, SPATIAL_CHROME_GLOBAL, { value: chrome, configurable: true, enumerable: false, writable: false })
  return () => {
    if ((globalThis as Record<string, unknown>)[SPATIAL_CHROME_GLOBAL] === chrome) Reflect.deleteProperty(globalThis, SPATIAL_CHROME_GLOBAL)
  }
}
