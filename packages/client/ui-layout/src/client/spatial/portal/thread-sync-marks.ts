/**
 * THREAD SYNC MARKS: the Threads lane's one honest line about where her conversation is.
 *
 * Her worker posts its sync state on `BroadcastChannel('aukora-x6-thread-sync')` as
 * `{v: 1, kind: 'state', at, mode: 'off' | 'pull' | 'on', role: 'reader' | 'writer' | 'none', footer}`; the page may post
 * `{v: 1, kind: 'ask'}` and gets the latest state back. `footer` is a finished sentence written by the worker: the
 * lane shows it as text and never builds, shortens or rewords it. A browser that only reads her is a reader in every
 * mode, so the line is decided by the footer, never by the mode.
 *
 * Only on a page that has an id (thread sync switched on) does this hook do anything; with none it opens
 * nothing and answers "no state". This hook opens the channel on mount, posts one `ask`, keeps only the newest valid
 * message by `at`, and closes the channel on unmount. A message that is not exactly the contract's shape is dropped
 * without a log line. With no `BroadcastChannel`, or one whose constructor throws, it answers "no state" and the lane
 * renders as before. It reads and writes no storage, calls no network, and touches no session.
 *
 * @module portal/thread-sync-marks
 */
import { useEffect, useState } from 'react'

/** The channel her worker posts its sync state on. */
export const THREAD_SYNC_CHANNEL = 'aukora-x6-thread-sync'

/** The longest footer the lane shows, in UTF-16 code units (JavaScript string length). */
export const THREAD_SYNC_FOOTER_MAX = 200

/** The sync modes the edge can set. */
export type ThreadSyncMode = 'off' | 'pull' | 'on'

/** What this browser is to her conversation. */
export type ThreadSyncRole = 'reader' | 'writer' | 'none'

/** One valid state message from her worker. */
export interface ThreadSyncState {
  readonly at: number
  readonly mode: ThreadSyncMode
  readonly role: ThreadSyncRole
  readonly footer: string
}

const MODES: readonly string[] = ['off', 'pull', 'on']
const ROLES: readonly string[] = ['reader', 'writer', 'none']
// C0 controls, DEL and C1 controls: a footer carrying any of them is not a finished sentence.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

/** The id this page gave its worker (webworker-runtime client/reader-window.ts), if any. */
export const THREAD_SYNC_PAGE_GLOBAL = '__DSH_THREAD_SYNC_PAGE__'
const ownPageId = (): string | null => {
  const id = (globalThis as Record<string, unknown>)[THREAD_SYNC_PAGE_GLOBAL]
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * Read one channel message against the contract.
 * @param data - the message's `data`, whatever was posted.
 * @param page - this page's id (default: the one its client set); a page that has one shows only its own worker's line.
 * @returns the state, or null when the message is not a valid state message, or is another tab's.
 */
export function parseThreadSyncState(data: unknown, page: string | null = ownPageId()): ThreadSyncState | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const message = data as Record<string, unknown>
  const { v, kind, at, mode, role, footer } = message
  if (v !== 1 || kind !== 'state') return null
  // Two tabs share the channel: a page that knows its id takes only messages its own worker signed with it.
  if (page !== null && message.worker !== page) return null
  if (typeof at !== 'number' || !Number.isSafeInteger(at)) return null
  if (typeof mode !== 'string' || !MODES.includes(mode)) return null
  if (typeof role !== 'string' || !ROLES.includes(role)) return null
  if (typeof footer !== 'string' || footer.length > THREAD_SYNC_FOOTER_MAX || CONTROL.test(footer)) return null
  return { at, mode: mode as ThreadSyncMode, role: role as ThreadSyncRole, footer }
}

/** The part of a BroadcastChannel this hook uses. */
interface SyncChannel {
  postMessage(message: unknown): void
  close(): void
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
}

type SyncChannelConstructor = new (name: string) => SyncChannel

function openChannel(): SyncChannel | null {
  try {
    const Channel = (globalThis as { BroadcastChannel?: SyncChannelConstructor }).BroadcastChannel
    if (typeof Channel !== 'function') return null
    return new Channel(THREAD_SYNC_CHANNEL)
  } catch {
    return null
  }
}

/**
 * Listen for her worker's sync state while the lane is mounted.
 * @returns the newest valid state this page has received, or null ("no state").
 */
export function useThreadSyncMarks(): ThreadSyncState | null {
  const [state, setState] = useState<ThreadSyncState | null>(null)
  useEffect(() => {
    // A page has an id only while thread sync is switched on (webworker-runtime
    // client/reader-window.ts, set before any bundle loads). With none (the switch off, or an old document) the lane opens
    // no channel and posts nothing, so another tab's line can never show here and the lane renders exactly as main.
    const page = ownPageId()
    if (page === null) return undefined
    const channel = openChannel()
    if (channel === null) return undefined
    let closed = false
    const onMessage = (event: { readonly data: unknown }): void => {
      if (closed) return
      const next = parseThreadSyncState(event.data, page)
      if (next === null) return
      // Only the newest by `at`; a later arrival with the same `at` replaces it (the worker's own re-post wins).
      setState(previous => (previous !== null && next.at < previous.at ? previous : next))
    }
    try {
      channel.addEventListener('message', onMessage)
      // The ask names this page, so only its own worker answers it.
      channel.postMessage({ v: 1, kind: 'ask', worker: page })
    } catch {
      // A channel that cannot listen or post gives no state; the lane renders as before.
    }
    return () => {
      closed = true
      try { channel.removeEventListener('message', onMessage) } catch { /* closing anyway */ }
      try { channel.close() } catch { /* already closed */ }
    }
  }, [])
  return state
}
