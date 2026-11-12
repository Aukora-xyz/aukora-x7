// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE LEFT LANE'S THREAD LIST, in the predecessor's look (an earlier repository X5Threads and the `x5-threads*` rules of
 * `x5.css`; glyphs from an earlier repository and `icons.tsx`, copied in below).
 *
 * LIVE, NOT GENESIS. The predecessor's list read `session/list` through her Genesis bridge. Here every card is one row of the live
 * DSH session store (`useSessions`), the same store the stock sidebar reads, and opening a card calls the same
 * `openThread` the stock row calls (`ctx.uiWorkspace.openSession`), then opens the conversation pane explicitly,
 * because choosing the thread that is already current changes no selection (see `conversation-opener.ts`).
 *
 * WHERE EACH FACT COMES FROM:
 *   title, last activity, running   the session store row (`displayTitle`, `updatedAt`, `running`)
 *   waiting / unread                `useSessionStatus` (`pendingInteraction`, `completionUnread`) when passed, plus a
 *                                   per-viewer "mark unread" kept in this browser only
 *   pinned / archived               the DSH host's registry-global pin and archive sets (`useWorkspaces` plus
 *                                   `setPinned` / `setArchived`, i.e. `ctx.uiWorkspace.pinSession` and friends) when the
 *                                   frame wires them; otherwise kept in this browser only, and the footnote says so
 *   filters                         per viewer, in this browser only
 *
 *   name                            the host's durable session title (`renameThread`, the classic sidebar's own rename),
 *                                   so a card and the open thread's one-line header always show the same name (Round 23)
 *
 * Nothing renders over the site: the running-thread archive question and the rename field open inline under their card,
 * and "How it works" opens in place at the top of the list.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Lead, PortalButton, StatusPill } from '../primitives/index.ts'
import { ErrorLine } from '../x5/common.tsx'
import css from './ThreadsLane.module.css'
import { threadPlaceOf, type ThreadPlace } from '../meta-workspace.ts'

// ── Structural views of the live stores (assignable from the real DSH types, no new dependency) ─────────────────────

/** The framework's selector-hook shape (`SnapshotSelectorHook` in `@deepseek-ai/dsh-client-store`). */
export type ThreadSelectorHook<T> = <S>(sel: (snapshot: T) => S, eq?: (a: S, b: S) => boolean) => S

/** The fields this lane reads from one session-store row (`SessionSummary`). */
export interface ThreadSummary {
  readonly id: SessionId
  readonly displayTitle: string
  /** The stored title, when the host has one (`displayTitle` falls back to the folder or the id). */
  readonly title?: string | undefined
  readonly cwd?: string | undefined
  readonly parentId?: SessionId | undefined
  readonly origin?: 'subagent' | undefined
  readonly running: boolean
  readonly blank: boolean
  readonly updatedAt: number
  readonly retainedBy: { readonly mainView?: number | undefined }
}

/** The fields this lane reads from the session list (`SessionListState`). */
export interface ThreadListState {
  readonly ids: readonly SessionId[]
  readonly byId: Readonly<Record<SessionId, ThreadSummary>>
  readonly phase: 'pending' | 'ready'
}

/** The fields this lane reads from one session's UI status (`SessionStatus`). */
export interface ThreadStatus {
  readonly running: boolean | undefined
  readonly pendingInteraction: unknown
  readonly completionUnread: boolean
}

/** `SessionStatusSnapshot`. */
export type ThreadStatusSnapshot = ReadonlyMap<SessionId, ThreadStatus>

/** The fields this lane reads from the Workspace snapshot (`WorkspaceSnapshot`): the host's pin and archive sets. */
export interface ThreadPinState {
  readonly pinnedSessionIds: readonly SessionId[]
  readonly archivedSessionIds: readonly SessionId[]
}

export interface ThreadsLaneProps {
  /** The live session store hook (AppFrame's `useSessions`). */
  readonly useSessions: ThreadSelectorHook<ThreadListState>
  /** The live session status hook (AppFrame's `useSessionStatus`); without it there is no host unread or waiting fact. */
  readonly useSessionStatus?: ThreadSelectorHook<ThreadStatusSnapshot> | undefined
  /** The global `useWorkspaces` hook; with `setPinned` and `setArchived` it makes pins and archive host-backed. */
  readonly useWorkspaces?: ThreadSelectorHook<ThreadPinState> | undefined
  /** The main view's session; computed from `useSessions` when omitted. */
  readonly currentSession?: SessionId | undefined
  /** Opens a thread exactly as the stock sidebar row does. */
  readonly openThread: (sessionId: SessionId) => void
  /** Shows the conversation pane in the left lane. */
  readonly openConversation: () => void
  /** The stock New Session action (`ctx.uiWorkspace.startSession()`); without it New chat says NOT CONNECTED YET. */
  readonly newThread?: (() => void) | undefined
  /** `ctx.uiWorkspace.pinSession` / `unpinSession`. */
  readonly setPinned?: ((sessionId: SessionId, pinned: boolean) => Promise<void>) | undefined
  /** `ctx.uiWorkspace.archiveSession(id, { stopActivity })` / `unarchiveSession`. */
  readonly setArchived?: ((sessionId: SessionId, archived: boolean, stopActivity: boolean) => Promise<void>) | undefined
  /** The host rename (the session's durable title); without it a card offers no rename. Resolves to the stored title. */
  readonly renameThread?: ((sessionId: SessionId, title: string) => Promise<string>) | undefined
}

// ── Per-viewer state: filters, "mark unread", and pins/archive when the host's are not wired ────────────────────────

interface ThreadFilters { readonly pinned: boolean; readonly unread: boolean; readonly archived: boolean }
type FilterName = keyof ThreadFilters

interface ViewerState {
  readonly filters: ThreadFilters
  readonly unread: readonly SessionId[]
  readonly pinned: readonly SessionId[]
  readonly archived: readonly SessionId[]
}

const VIEWER_KEY = 'x61.spatial.threads.v1'
export const AUMA_LIVE_VOICE_SESSION_KEY = 'x61.auma-live.voice-session.v1'
export const AUMA_LIVE_VOICE_TITLE = '[voice] Auma Live'
const NO_FILTERS: ThreadFilters = { pinned: false, unread: false, archived: false }
const EMPTY_VIEWER: ViewerState = { filters: NO_FILTERS, unread: [], pinned: [], archived: [] }

function readVoiceSessionId(): string {
  try {
    return globalThis.localStorage?.getItem(AUMA_LIVE_VOICE_SESSION_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

function idsOf(value: unknown): SessionId[] {
  if (!Array.isArray(value)) return []
  return (value as unknown[]).filter((id): id is SessionId => typeof id === 'string' && id !== '')
}

function readViewer(): ViewerState {
  try {
    const raw = globalThis.localStorage?.getItem(VIEWER_KEY)
    if (raw === null || raw === undefined) return EMPTY_VIEWER
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return EMPTY_VIEWER
    const record = parsed as Record<string, unknown>
    const filters = record.filters !== null && typeof record.filters === 'object'
      ? record.filters as Record<string, unknown>
      : {}
    return {
      filters: { pinned: filters.pinned === true, unread: filters.unread === true, archived: filters.archived === true },
      unread: idsOf(record.unread),
      pinned: idsOf(record.pinned),
      archived: idsOf(record.archived),
    }
  } catch {
    return EMPTY_VIEWER
  }
}

let viewer: ViewerState = readViewer()
const viewerListeners = new Set<() => void>()

function writeViewer(next: ViewerState): void {
  viewer = next
  try {
    globalThis.localStorage?.setItem(VIEWER_KEY, JSON.stringify(next))
  } catch {
    // Storage blocked (private window, cleared site data): the choice still holds for this page.
  }
  for (const listener of viewerListeners) listener()
}

function subscribeViewer(listener: () => void): () => void {
  viewerListeners.add(listener)
  return () => { viewerListeners.delete(listener) }
}

const getViewer = (): ViewerState => viewer

function toggled(ids: readonly SessionId[], id: SessionId, on: boolean): readonly SessionId[] {
  const without = ids.filter(other => other !== id)
  return on ? [id, ...without] : without
}

function setViewerMark(list: 'unread' | 'pinned' | 'archived', id: SessionId, on: boolean): void {
  writeViewer({ ...viewer, [list]: toggled(viewer[list], id, on) })
}

function toggleFilter(name: FilterName): void {
  writeViewer({ ...viewer, filters: { ...viewer.filters, [name]: !viewer.filters[name] } })
}

// Stand-ins for hooks the frame did not pass. They call no React hook, and the body is keyed on which hooks exist,
// so a hook that arrives later remounts the body instead of changing its hook order.
const NO_STATUS: ThreadStatusSnapshot = new Map()
const NO_PINS: ThreadPinState = { pinnedSessionIds: [], archivedSessionIds: [] }
function useNoStatus<S>(sel: (snapshot: ThreadStatusSnapshot) => S): S { return sel(NO_STATUS) }
function useNoPins<S>(sel: (snapshot: ThreadPinState) => S): S { return sel(NO_PINS) }

// ── Glyphs (exact copies of the predecessor's 16px thread icons) ──────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z" fill="currentColor" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.5 1.5 14.5 6.5 11 8l-1.5 4.5L4 7 8.5 5.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 11l-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function UnreadIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="4.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10.6 2.9l2.5 2.5-7.4 7.4-3.1.6.6-3.1 7.4-7.4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9.3 4.2l2.5 2.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/** "How it works" (Round 23): what the lane's words and controls mean, said in place, the Aura Coherence way. */
const HOW_IT_WORKS: readonly (readonly [string, string])[] = [
  ['Threads', 'Each thread is one conversation with Auma, kept by the host serving this page. Pinned threads come first, '
    + 'then the most recent.'],
  ['Open and return', 'Click a card to open its thread. The glowing top-left corner of this lane brings you back here.'],
  ['Names', 'A thread names itself until you rename it with the pencil, on its card or beside its name when it is open. '
    + 'The host keeps the name, so the list and the open thread always show the same one, also after a reload.'],
  ['Workspaces', 'Auma is the one workspace. A small name on a card says the thread lives in one of her sub-workspaces, or '
    + 'in auma-one, where threads ran before; nothing was moved.'],
  ['Presets', 'The mode beside an open thread\'s name (Auma, for example) is its agent preset: the instructions '
    + 'and tools that thread runs with.'],
  ['Subagents', 'The count beside it (7 subagents, say) is how many helper agents that thread has started. Each runs as a '
    + 'session of its own, so they are not cards here.'],
  ['Pin, unread, archive', 'Pin keeps a thread on top. Mark unread is a reminder kept in this browser only. Archive takes a '
    + 'thread out of this list (the archive filter shows it again); a running thread asks first, right under its card.'],
]
function HowItWorks() {
  return <>{HOW_IT_WORKS.map(([title, text]) => <Lead key={title}><b>{title}.</b> {text}</Lead>)}</>
}

function ArchiveIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="3.4" rx="0.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.4 6.4V13h9.2V6.4M6.4 9h3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface ThreadRow {
  readonly id: SessionId
  readonly title: string
  /** The host's stored title, the rename field's starting text (null when the host has none yet). */
  readonly storedTitle: string | null
  readonly running: boolean
  readonly waiting: boolean
  readonly unread: boolean
  readonly pinned: boolean
  readonly archived: boolean
  readonly blank: boolean
  readonly updatedAt: number
  readonly order: number
  readonly pinOrder: number
  /** Where the thread lives inside her meta-workspace (a sub-workspace, or the legacy one); null for her root. */
  readonly place: ThreadPlace
}

function mainViewOf(sessions: ThreadListState): SessionId | undefined {
  return Object.values(sessions.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/** "Last activity" in the card's one summary line; `updatedAt` is the host's durable message time in ms. */
function activityText(row: ThreadRow, now: number): string {
  if (row.waiting) return 'Waiting for you'
  if (row.running) return 'Running now'
  if (row.blank) return 'New conversation'
  if (row.updatedAt <= 0) return 'No activity yet'
  const minutes = Math.floor(Math.max(0, now - row.updatedAt) / 60_000)
  if (minutes < 1) return 'Active just now'
  if (minutes < 60) return `Active ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Active ${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `Active ${days} d ago`
  if (days < 365) return `Active ${Math.floor(days / 30)} mo ago`
  return `Active ${Math.floor(days / 365)} y ago`
}

function badgeOf(row: ThreadRow): ReactNode {
  if (row.waiting) return <StatusPill tone="gold">WAITING</StatusPill>
  if (row.running) return <StatusPill tone="blue">RUNNING</StatusPill>
  if (row.pinned) return <StatusPill tone="mint">PINNED</StatusPill>
  if (row.unread) return <StatusPill tone="gold">UNREAD</StatusPill>
  if (row.archived) return <StatusPill tone="muted">ARCHIVED</StatusPill>
  return undefined
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// ── The lane ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The predecessor's threads list for the left lane, on the live DSH session store. */
export function ThreadsLane(props: ThreadsLaneProps) {
  const hostPins = props.useWorkspaces !== undefined && props.setPinned !== undefined && props.setArchived !== undefined
  const key = `${props.useSessionStatus === undefined ? 'no-status' : 'status'}:${hostPins ? 'host' : 'viewer'}`
  return <ThreadsLaneBody key={key} {...props} hostPins={hostPins} />
}

function ThreadsLaneBody({
  useSessions, useSessionStatus, useWorkspaces, currentSession, openThread, openConversation, newThread, setPinned,
  setArchived, renameThread, hostPins,
}: ThreadsLaneProps & { readonly hostPins: boolean }) {
  const useStatus = useSessionStatus ?? useNoStatus
  const usePins = hostPins ? (useWorkspaces ?? useNoPins) : useNoPins
  const ids = useSessions(sessions => sessions.ids)
  const byId = useSessions(sessions => sessions.byId)
  const phase = useSessions(sessions => sessions.phase)
  const mainView = useSessions(mainViewOf)
  const statuses = useStatus(snapshot => snapshot)
  const hostPinned = usePins(snapshot => snapshot.pinnedSessionIds)
  const hostArchived = usePins(snapshot => snapshot.archivedSessionIds)
  const local = useSyncExternalStore(subscribeViewer, getViewer, getViewer)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<SessionId | null>(null)
  const [confirmStop, setConfirmStop] = useState<SessionId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [howOpen, setHowOpen] = useState(false)
  // One rename field at a time, under its card; its error stays beside it.
  const [renaming, setRenaming] = useState<{ readonly id: SessionId; readonly draft: string; readonly error: string | null } | null>(null)
  // A rename in flight has its own flag (pin and archive keep theirs), and its band stays open until the host answers.
  const [renameBusy, setRenameBusy] = useState<SessionId | null>(null)
  // The name is selected once, when its field opens (not again when the window gets the focus back).
  const renameSelected = useRef<SessionId | null>(null)

  // Card times read "5 min ago"; a minute tick keeps them honest without a re-render per second.
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { clearInterval(timer) }
  }, [])

  const current = currentSession ?? mainView
  const voiceSessionId = readVoiceSessionId()
  const pinnedIds = Array.from(new Set([...(hostPins ? hostPinned : []), ...local.pinned]))
  const archivedIds = Array.from(new Set([...(hostPins ? hostArchived : []), ...local.archived]))
  const filters = local.filters

  const rows: ThreadRow[] = []
  ids.forEach((id, order) => {
    const summary = byId[id]
    if (summary === undefined) return
    // The stock browser nests subagent children under their parent and shows only the selected blank session.
    if (summary.origin === 'subagent' || summary.parentId !== undefined) return
    // Auma Live's dedicated voice channel lives on the center aurora surface, never as a chat thread card here.
    if (id !== current && (
      (voiceSessionId !== '' && id === voiceSessionId)
      || summary.title === AUMA_LIVE_VOICE_TITLE
      || summary.displayTitle === AUMA_LIVE_VOICE_TITLE
    )) return
    if (summary.blank && id !== current) return
    const status = statuses.get(id)
    const pinOrder = pinnedIds.indexOf(id)
    rows.push({
      id,
      title: summary.displayTitle,
      storedTitle: summary.title ?? null,
      running: status?.running ?? summary.running,
      waiting: status?.pendingInteraction !== undefined && status.pendingInteraction !== null,
      unread: status?.completionUnread === true || local.unread.includes(id),
      pinned: pinOrder >= 0,
      archived: archivedIds.includes(id),
      blank: summary.blank,
      updatedAt: summary.updatedAt,
      order,
      pinOrder,
      place: threadPlaceOf(summary.cwd),
    })
  })
  const visible = rows.filter((row) => {
    if (filters.archived ? !row.archived : row.archived) return false
    if (filters.pinned && !row.pinned) return false
    if (filters.unread && !row.unread) return false
    return true
  }).sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    if (left.pinned) return left.pinOrder - right.pinOrder
    return (right.updatedAt - left.updatedAt) || (left.order - right.order)
  })

  const open = (row: ThreadRow): void => {
    if (local.unread.includes(row.id)) setViewerMark('unread', row.id, false)
    setConfirmStop(null)
    try {
      openThread(row.id)
    } finally {
      openConversation()
    }
  }

  const startNew = (): void => {
    if (newThread === undefined) return
    try {
      newThread()
    } finally {
      openConversation()
    }
  }

  const runHost = (id: SessionId, work: () => Promise<void>): void => {
    setBusy(id)
    setError(null)
    void work().then(
      () => { setBusy(null) },
      (cause: unknown) => { setBusy(null); setError(messageOf(cause)) },
    )
  }

  const pin = (row: ThreadRow): void => {
    const nextPinned = !row.pinned
    setViewerMark('pinned', row.id, nextPinned)
    if (!hostPins || setPinned === undefined) return
    runHost(row.id, () => setPinned(row.id, nextPinned))
  }

  const archive = (row: ThreadRow, stopActivity = false): void => {
    const nextArchived = !row.archived
    if (!hostPins || setArchived === undefined) {
      setViewerMark('archived', row.id, nextArchived)
      return
    }
    // The host refuses to archive a running thread unless asked to stop it; ask here, inline, the way the stock
    // archive confirmation does, never in a popup.
    if (nextArchived && row.running && !stopActivity) {
      setConfirmStop(row.id)
      return
    }
    setConfirmStop(null)
    setViewerMark('archived', row.id, nextArchived)
    runHost(row.id, () => setArchived(row.id, nextArchived, stopActivity))
  }

  const startRename = (row: ThreadRow): void => {
    renameSelected.current = null
    setConfirmStop(null)
    setRenaming({ id: row.id, draft: row.storedTitle ?? row.title, error: null })
  }

  // Save renames with any non-empty name, an unchanged one too: like the classic shell, that pins the automatic title.
  const saveRename = (row: ThreadRow): void => {
    if (renaming?.id !== row.id || renameThread === undefined || renameBusy !== null) return
    const title = renaming.draft.trim()
    if (title === '') {
      setRenaming(null)
      return
    }
    setRenameBusy(row.id)
    void renameThread(row.id, title).then(
      () => { setRenameBusy(null); setRenaming(current => (current?.id === row.id ? null : current)) },
      (cause: unknown) => {
        setRenameBusy(null)
        setRenaming(current => (current?.id === row.id ? { ...current, error: messageOf(cause) } : current))
      },
    )
  }

  const markUnread = (row: ThreadRow): void => {
    setViewerMark('unread', row.id, !local.unread.includes(row.id))
  }

  const filterButton = (name: FilterName, icon: ReactNode, on: string, off: string): ReactNode => (
    <button
      type="button"
      className={css.tool}
      data-thread-action={name === 'pinned' ? 'pin' : name === 'unread' ? 'unread' : 'archive'}
      aria-pressed={filters[name]}
      aria-label={filters[name] ? on : off}
      title={filters[name] ? on : off}
      onClick={() => { toggleFilter(name) }}
    >
      {icon}
    </button>
  )

  return (
    <div className={css.lane} data-thread-view="list" data-threads-source={hostPins ? 'host' : 'viewer'}>
      <header className={css.head}>
        <div className={css.titles}>
          <h2 className={css.heading}>Threads · {visible.length}</h2>
          <p className={css.subtitle}>Live conversations</p>
        </div>
        <div className={css.tools} role="toolbar" aria-label="Thread actions">
          <button
            type="button"
            className={css.tool}
            data-thread-tool="new"
            disabled={newThread === undefined}
            aria-label={newThread === undefined ? 'New chat: not connected yet' : 'New chat'}
            title={newThread === undefined ? 'New chat: NOT CONNECTED YET (no session-start action wired)' : 'New chat'}
            onClick={startNew}
          >
            <PlusIcon />
          </button>
          {filterButton('pinned', <PinIcon />, 'Stop filtering pinned threads', 'Show pinned threads')}
          {filterButton('unread', <UnreadIcon />, 'Stop filtering unread threads', 'Show unread threads')}
          {filterButton('archived', <ArchiveIcon />, 'Show active threads', 'Show archived threads')}
        </div>
      </header>

      <div className={css.scroll}>
        <div className={css.how} data-threads-how>
          <PortalButton
            tone="mint"
            icon="thread"
            title="How it works"
            summary="what threads, presets, and subagents mean"
            expanded={howOpen}
            onToggle={setHowOpen}
          >
            <HowItWorks />
          </PortalButton>
        </div>
        {phase === 'pending' && ids.length === 0 ? <Lead>Loading threads…</Lead> : null}
        {phase === 'ready' && visible.length === 0
          ? <Lead>{filters.archived ? 'No archived threads.' : 'No threads in this view.'}</Lead>
          : null}
        <ul className={css.rows}>
          {visible.map(row => (
            <li
              key={row.id}
              className={css.card}
              data-thread-id={row.id}
              data-current={row.id === current ? 'true' : undefined}
              aria-current={row.id === current ? 'true' : undefined}
            >
              <PortalButton
                tone="mint"
                icon="thread"
                title={row.title}
                summary={row.place === null ? activityText(row, now) : (
                  <>
                    <span
                      className={css.place}
                      data-thread-place={row.place.kind}
                      title={row.place.kind === 'sub' ? `In her sub-workspace ${row.place.name}` : 'From before Auma became the one workspace; kept as it is'}
                    >
                      {row.place.name}
                    </span>
                    {activityText(row, now)}
                  </>
                )}
                badge={badgeOf(row)}
                expanded={false}
                showIndicator={false}
                onClick={() => { open(row) }}
              />
              <span className={css.actions} data-busy={busy === row.id || undefined}>
                {renameThread === undefined || row.blank ? null : (
                  <button
                    type="button"
                    className={css.act}
                    data-thread-action="rename"
                    aria-expanded={renaming?.id === row.id}
                    aria-label="Rename thread"
                    title="Rename thread"
                    disabled={renameBusy !== null}
                    onClick={() => { if (renaming?.id === row.id) setRenaming(null); else startRename(row) }}
                  >
                    <PencilIcon />
                  </button>
                )}
                <button
                  type="button"
                  className={css.act}
                  data-thread-action="pin"
                  aria-pressed={row.pinned}
                  aria-label={row.pinned ? 'Unpin thread' : 'Pin thread'}
                  title={row.pinned ? 'Unpin thread' : 'Pin thread'}
                  disabled={busy === row.id}
                  onClick={() => { pin(row) }}
                >
                  <PinIcon />
                </button>
                <button
                  type="button"
                  className={css.act}
                  data-thread-action="unread"
                  aria-pressed={row.unread}
                  aria-label={local.unread.includes(row.id) ? 'Mark read' : 'Mark unread'}
                  title={local.unread.includes(row.id) ? 'Mark read' : 'Mark unread'}
                  onClick={() => { markUnread(row) }}
                >
                  <UnreadIcon />
                </button>
                <button
                  type="button"
                  className={css.act}
                  data-thread-action="archive"
                  aria-pressed={row.archived}
                  aria-label={row.archived ? 'Unarchive thread' : 'Archive thread'}
                  title={row.archived ? 'Unarchive thread' : 'Archive thread'}
                  disabled={busy === row.id}
                  onClick={() => { archive(row) }}
                >
                  <ArchiveIcon />
                </button>
              </span>
              {renaming?.id === row.id ? (
                <div className={css.rename} role="group" aria-label="Rename this thread" data-thread-rename={row.id}>
                  <input
                    className={css.renameInput}
                    aria-label="Thread name"
                    value={renaming.draft}
                    maxLength={200}
                    disabled={renameBusy === row.id}
                    // The field appears because the person asked for it with the pencil, so it takes the focus.
                    autoFocus
                    // The whole name is selected, so typing replaces it and an arrow key keeps it.
                    onFocus={(event) => {
                      if (renameSelected.current === row.id) return
                      renameSelected.current = row.id
                      event.currentTarget.select()
                    }}
                    onChange={(event) => {
                      const draft = event.target.value
                      setRenaming(current => (current === null ? null : { ...current, draft }))
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); saveRename(row) }
                      if (event.key === 'Escape' && renameBusy !== row.id) { event.preventDefault(); event.stopPropagation(); setRenaming(null) }
                    }}
                  />
                  <button type="button" className={css.confirmButton} data-tone="mint" disabled={renameBusy === row.id} onClick={() => { saveRename(row) }}>
                    Save
                  </button>
                  <button type="button" className={css.confirmButton} disabled={renameBusy === row.id} onClick={() => { setRenaming(null) }}>Cancel</button>
                  {renaming.error === null ? null : <span className={css.renameError} role="status">{renaming.error}</span>}
                </div>
              ) : null}
              {confirmStop === row.id ? (
                <div className={css.confirm} role="group" aria-label="Archive a running thread">
                  <span>This thread is running. Stop it and archive?</span>
                  <button type="button" className={css.confirmButton} data-tone="gold" onClick={() => { archive(row, true) }}>
                    Stop and archive
                  </button>
                  <button type="button" className={css.confirmButton} onClick={() => { setConfirmStop(null) }}>Keep it</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        <ErrorLine error={error} />
        <p className={css.source} data-threads-source-note>
          {hostPins
            ? 'Pins and archive: saved on the DSH host · filters and unread marks: this browser'
            : 'Pins, archive, filters and unread marks: this browser only (host pin/archive not wired)'}
        </p>
      </div>
    </div>
  )
}
