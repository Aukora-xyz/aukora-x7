/**
 * The Spatial shell's thread chrome, read by the conversation header (Round 23).
 *
 * The Spatial shell (`ui-layout/src/client/spatial/thread-chrome.ts`) publishes one page global while it is mounted. Its
 * presence makes the open thread's header ONE compact line: the title once, renamed in place through the host's own
 * rename, the mode and subagent count beside it, and no view tabs, utilities or corner. Anything else (the classic
 * `?layout=stock` shell, tests, a global of another shape or version) reads as absent, and the header stays full.
 */

/** The page global the Spatial shell publishes. */
export const SPATIAL_CHROME_GLOBAL = '__AUKORA_SPATIAL_CHROME__'

/** The chrome, version 1. */
export interface SpatialChrome {
  readonly version: 1
  /** Rename a thread on its host; resolves to the title the host stored, or rejects with its reason. */
  readonly renameThread: (sessionId: string, title: string) => Promise<string>
}

/**
 * The Spatial chrome, when the Spatial shell has published it.
 * @returns the chrome, or null for the full header.
 */
export function spatialChrome(): SpatialChrome | null {
  const value: unknown = (globalThis as Record<string, unknown>)[SPATIAL_CHROME_GLOBAL]
  if (value === null || typeof value !== 'object') return null
  const chrome = value as Partial<SpatialChrome>
  return chrome.version === 1 && typeof chrome.renameThread === 'function' ? chrome as SpatialChrome : null
}
