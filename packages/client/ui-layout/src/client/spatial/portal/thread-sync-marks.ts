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

export interface ThreadTailWindow {
  readonly label: string
  readonly records: readonly string[]
}

export type ThreadTailError = 401 | 404 | 'CHECKPOINT_MOVED' | 'UNAVAILABLE'

const TAIL_WINDOW_MAX = 262_144

// Keep this strictly display-only: never hydrate the session store from a bounded window.
function parseTailWindow(value: unknown): ThreadTailWindow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { label, records } = value as Record<string, unknown>
  if (typeof label !== 'string' || label.trim() === '' || label.length > 1024 || CONTROL.test(label)) return null
  // A window whose last 256 KiB holds no readable message is still a window: the lane says so in words rather than
  // calling the cloud unavailable (remove only the zero-length rejection).
  if (!Array.isArray(records) || records.length > TAIL_WINDOW_MAX) return null
  const lines: string[] = []
  let units = 0
  for (const line of records) {
    if (typeof line !== 'string' || line === '' || /[\r\n]/u.test(line)) return null
    units += line.length + 1
    if (units > TAIL_WINDOW_MAX) return null
    try {
      const record: unknown = JSON.parse(line)
      if (typeof record !== 'object' || record === null || Array.isArray(record)) return null
    } catch {
      return null
    }
    lines.push(line)
  }
  return { label, records: lines }
}

interface PrivateThreadTail {
  readonly tail: ThreadTailWindow | null
  readonly tailError?: ThreadTailError
}
const unavailableTail: PrivateThreadTail = { tail: null, tailError: 'UNAVAILABLE' }

function readPrivateThreadTail(): PrivateThreadTail | null {
  const raw: unknown = (globalThis as { __DSH_PRIVATE_THREAD_TAIL__?: unknown }).__DSH_PRIVATE_THREAD_TAIL__
  if (raw === undefined) return null
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return unavailableTail
  const { tail, tailError } = raw as Record<string, unknown>
  if (tailError === 401 || tailError === 404 || tailError === 'CHECKPOINT_MOVED') return { tail: null, tailError }
  if (tailError !== undefined) return unavailableTail
  if (tail === null) return null
  const window = parseTailWindow(tail)
  return window === null ? unavailableTail : { tail: window }
}

export function usePrivateThreadTail(): PrivateThreadTail | null {
  const [view, setView] = useState(readPrivateThreadTail)
  useEffect(() => {
    const update = (): void => { setView(readPrivateThreadTail()) }
    const clear = (): void => {
      delete (globalThis as { __DSH_PRIVATE_THREAD_TAIL__?: unknown }).__DSH_PRIVATE_THREAD_TAIL__
      setView(null)
    }
    window.addEventListener('dsh-private-thread-tail', update)
    window.addEventListener('pagehide', clear)
    update()
    return () => {
      window.removeEventListener('dsh-private-thread-tail', update)
      window.removeEventListener('pagehide', clear)
    }
  }, [])
  return view
}
// C0 controls, DEL and C1 controls: a footer carrying any of them is not a finished sentence.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

function readPrivateThreadPreviews(): ReadonlyMap<string, string> {
  const raw = (globalThis as { __DSH_PRIVATE_THREAD_PREVIEWS__?: unknown }).__DSH_PRIVATE_THREAD_PREVIEWS__
  const rows = new Map<string, string>()
  if (!Array.isArray(raw) || raw.length > 2048) return rows
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) continue
    const [path, preview]: [unknown, unknown] = [item[0], item[1]]
    if (typeof path !== 'string' || path.length === 0 || path.length > 1024 || CONTROL.test(path)
      || typeof preview !== 'string' || preview.length > 120 || CONTROL.test(preview) || /\p{Cf}/u.test(preview)) continue
    const label = [...preview.replace(/\s+/gu, ' ').trim()].slice(0, 60).join('').trimEnd()
    if (label !== '') rows.set(path, label)
  }
  return rows
}

export function usePrivateThreadPreviews(): ReadonlyMap<string, string> {
  const [rows, setRows] = useState(readPrivateThreadPreviews)
  useEffect(() => {
    const update = (): void => { setRows(readPrivateThreadPreviews()) }
    const clear = (): void => { setRows(new Map()) }
    window.addEventListener('dsh-private-thread-previews', update)
    window.addEventListener('pagehide', clear)
    update()
    return () => {
      window.removeEventListener('dsh-private-thread-previews', update)
      window.removeEventListener('pagehide', clear)
    }
  }, [])
  return rows
}

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

/** CARD 3a: one conversation as her cloud's index lists it (thread-sync.ts `ThreadCloudRow`), as the page reads it. */
export interface ThreadCloudRow {
  readonly id: string
  readonly path: string
  readonly bytes: number
  /** Her cloud's own time for it (when it last appended), or null when the row has none. */
  readonly activeAt: number | null
  /** The index's title (her writer sends one with `x-thread-meta`); null before it has. */
  readonly title: string | null
  /** Bytes of the journal this browser holds for it; null when it holds none (a thread over the cap is not pulled). */
  readonly local: number | null
  /** Over the size a reader pulls: listed here, not read (card 3b opens it tail-first). */
  readonly long: boolean
}

/** The list her worker posts beside its state: `{v, kind: 'rows', at, mode, rows, worker?}`. */
export interface ThreadCloudList {
  readonly at: number
  readonly mode: ThreadSyncMode
  readonly rows: readonly ThreadCloudRow[]
  readonly warning?: string
}

/** How many valid rows the lane retains from one message. */
export const THREAD_CLOUD_ROWS_MAX = 400

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' && !CONTROL.test(value) ? value : null)

/**
 * Refuse an invalid envelope. A valid envelope can carry a partial list; flag that before any absence claim.
 * @param data - the message's `data`, whatever was posted.
 * @param page - this page's id (default: the one its client set); a page that has one shows only its own worker's rows.
 * @returns the list, or null when the message is not a valid rows message, or is another tab's.
 */
export function parseThreadCloudRows(data: unknown, page: string | null = ownPageId()): ThreadCloudList | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const message = data as Record<string, unknown>
  // CARD 3a: the list rides inside her worker's state message, so a page hears one post and one answer.
  if (message.v !== 1 || message.kind !== 'state') return null
  if (page !== null && message.worker !== page) return null
  if (!isCount(message.at)) return null
  if (typeof message.mode !== 'string' || !MODES.includes(message.mode as string)) return null
  const raw = message.rows
  if (!Array.isArray(raw)) return null
  const rows: ThreadCloudRow[] = []
  const failedFields = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) { failedFields.add('row shape'); continue }
    const row = item as Record<string, unknown>
    const { id, path, bytes, title } = row
    if (typeof id !== 'string') { failedFields.add('id'); continue }
    if (typeof path !== 'string') { failedFields.add('path'); continue }
    if (!isCount(bytes)) { failedFields.add('bytes'); continue }
    const activeAt = row.activeAt === null ? null : isCount(row.activeAt) ? row.activeAt : undefined
    const local = row.local === null ? null : isCount(row.local) ? row.local : undefined
    if (activeAt === undefined) { failedFields.add('activeAt/updatedAt'); continue }
    if (local === undefined) { failedFields.add('local'); continue }
    if (typeof row.long !== 'boolean') { failedFields.add('long'); continue }
    rows.push({ id, path, bytes, activeAt, title: textOrNull(title), local, long: row.long })
  }
  const bad = raw.length - rows.length
  const capped = Math.max(0, rows.length - THREAD_CLOUD_ROWS_MAX)
  if (capped > 0) {
    // Stable ties retain the worker’s lexicographic thread-id traversal order, not the displayed session id.
    rows.sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0))
    rows.length = THREAD_CLOUD_ROWS_MAX
  }
  const warning = [bad === 0 ? '' : `${bad} rows skipped: ${[...failedFields].sort().join(', ')}`,
    capped === 0 ? '' : `${capped} oldest dropped: ${THREAD_CLOUD_ROWS_MAX}-row cap`].filter(Boolean).join('; ')
  return { at: message.at, mode: message.mode as ThreadSyncMode, rows, ...(warning === '' ? {} : { warning }) }
}

/** One local session, as the lane knows it. */
export interface ThreadCloudLocal {
  readonly id: string
  /** Blank, subagent or her voice channel: never counted as "only in this browser". */
  readonly hidden: boolean
}

/** Her index joined to this browser's sessions, by SESSION id. */
export interface ThreadCloudJoin {
  readonly bySession: ReadonlyMap<string, ThreadCloudRow>
  /** Rows her index holds that this browser has no session for. */
  readonly cloudOnly: readonly ThreadCloudRow[]
  /** Rows where this browser's own copy is smaller than her cloud's count; nothing is deleted. */
  readonly olderCopies: readonly ThreadCloudRow[]
  /** Sessions here that her index does not list at all: the only thing that may say "only in this browser". */
  readonly localOnly: readonly string[]
}

/**
 * CARD 3a: join her index rows to this browser's sessions. The key is `row.id`, which is the
 * SESSION id taken from the journal path (`/dsh/home/sessions/<project>/<id>/session.vN.jsonl`) — never the thread id
 * (sha256 of the path, which is what her index calls a thread's `id`). Joining on the thread id is what made every
 * reader say "only in this browser" for every conversation while listing all index rows as cloud-only.
 * @param rows - The rows her worker published (already carrying the session id).
 * @param local - The sessions this browser holds, with the ones the lane never shows marked hidden.
 */
export function joinCloudRows(rows: readonly ThreadCloudRow[], local: readonly ThreadCloudLocal[]): ThreadCloudJoin {
  const bySession = new Map<string, ThreadCloudRow>()
  for (const row of rows) bySession.set(row.id, row)
  const here = new Set(local.map(entry => entry.id))
  return {
    bySession,
    cloudOnly: rows.filter(row => !here.has(row.id)),
    olderCopies: rows.filter(row => row.local !== null && row.local < row.bytes),
    localOnly: local.filter(entry => !entry.hidden && !bySession.has(entry.id)).map(entry => entry.id),
  }
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

/**
 * CARD 3a: read her cloud's list of every conversation her index holds, beside the sync state, while the lane is
 * mounted. Same channel and same ask as {@link useThreadSyncMarks}; only `kind: 'rows'` messages are taken, so the
 * state hook's contract is untouched.
 * @returns the newest list this page has received, or null (no list: the lane draws exactly as it did before).
 */
export function useThreadCloudRows(): ThreadCloudList | null {
  const [list, setList] = useState<ThreadCloudList | null>(null)
  useEffect(() => {
    const page = ownPageId()
    if (page === null) return undefined
    const channel = openChannel()
    if (channel === null) return undefined
    let closed = false
    const onMessage = (event: { readonly data: unknown }): void => {
      if (closed) return
      const next = parseThreadCloudRows(event.data, page)
      if (next === null) return
      setList(previous => (previous !== null && next.at < previous.at ? previous : next))
    }
    try {
      channel.addEventListener('message', onMessage)
      channel.postMessage({ v: 1, kind: 'ask', worker: page })
    } catch {
      // A channel that cannot listen or post gives no list; the lane renders as before.
    }
    return () => {
      closed = true
      try { channel.removeEventListener('message', onMessage) } catch { /* closing anyway */ }
      try { channel.close() } catch { /* already closed */ }
    }
  }, [])
  return list
}
