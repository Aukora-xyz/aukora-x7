// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * NOTHING FLOATS: NOTICES LIVE BEHIND ONE BUTTON. The owner learns that something waits
 * for him from one place: the Notices launcher, first in the system menu, gold with a count while anything waits
 * (`NoticesSurface.tsx`). No notice is drawn over content, opens by itself, takes focus or makes a sound.
 *
 * THE MODEL is one list of `{ id, kind, what, firstSeen, action }`. Today it is fed only by build-notice.ts's two kinds:
 *   build  a new build of the app is live on the edge (`useEdgeBuild`), in `EDGE_BUILD_WORDS.what`;
 *   auma   a newer (or other) Auma is published than this tab runs (`useHeadLag`), in `headLagWords(lag).what`.
 * Both rows' Reload is the very function the frame's old pill called (`reloadNoticeOf(edge, lag, ...).reload`): one press
 * settles both, marks the edge build it reloads for, and waits while an approval is in flight. The next kind (an
 * approval waiting, a held merge) is one more entry here, not a new widget.
 *
 * NOTHING NEW IS READ OR KEPT. Every reader (the frame; Work and Aura Coherence while open) calls the same two hooks
 * `useReloadNotice` calls, with the same options, so the reads, their spacing and their refusal handling are
 * build-notice.ts's own, and each publishes what it found into the one list (`useReloadNoticeFeed`). When each
 * notice was first seen is kept in this page's memory only, and forgotten with the notice.
 * @module portal/notices
 */
import { useEffect, useId, useMemo, useSyncExternalStore } from 'react'
import {
  EDGE_BUILD_WORDS, headLagWords, pageSourceRevision, reloadNoticeOf, useEdgeBuild, useHeadLag,
  type BuildMemory, type EdgeBuildOptions, type HeadLagNotice, type HeadLagOptions, type ReloadNotice,
} from './build-notice.ts'

/** The centre surface the Notices launcher opens. */
export const NOTICES_SURFACE = 'notices'

/** What a notice is about. Only build-notice.ts's two kinds exist today. */
export type NoticeKind = 'build' | 'auma'

/** A notice's one action, drawn as a normal button in its row. */
export interface NoticeAction {
  readonly label: string
  readonly run: () => void
}

/** One notice: what it is in plain words, when this page first saw it, and its one action. */
export interface Notice {
  readonly id: string
  readonly kind: NoticeKind
  readonly what: string
  /** Epoch milliseconds, this page's own clock. */
  readonly firstSeen: number
  readonly action: NoticeAction
}

/** A notice before this page has stamped when it first saw it. */
export type NoticeEntry = Omit<Notice, 'firstSeen'>

/** The action's words: the same verb the old pill ended with. */
export const RELOAD_LABEL = 'Reload'

/**
 * The notices for the two build-notice.ts causes, in a fixed order (build, then auma).
 * @param edge - the edge build this page does not run, from `useEdgeBuild`.
 * @param lag - her published head this tab does not run, from `useHeadLag`.
 * @param page - this page's own revision.
 * @param memory - session memory for the reload rule (build-notice.ts); omitted, `sessionStorage`.
 * @returns one entry per cause; both share the one reload.
 */
export function noticeEntriesOf(edge: string | null, lag: HeadLagNotice | null, page: string | null,
  memory?: BuildMemory | null): readonly NoticeEntry[] {
  const notice = reloadNoticeOf(edge, lag, page, memory)
  if (notice === null) return []
  const action: NoticeAction = { label: RELOAD_LABEL, run: notice.reload }
  const entries: NoticeEntry[] = []
  if (edge !== null) entries.push({ id: `build:${edge}`, kind: 'build', what: EDGE_BUILD_WORDS.what, action })
  if (lag !== null) entries.push({ id: `auma:${lag.published.ballId}`, kind: 'auma', what: headLagWords(lag).what, action })
  return entries
}

// ── The page's one list ────────────────────────────────────────────────────────────────────────────────────────────
// WHOEVER READS, PUBLISHES. The frame reads while no app that reads for itself is open;
// Work and Aura Coherence (the boot app) read while they are open. Each reader publishes what it found under its own
// key, and the list is all of them merged, so the launcher is gold on every screen, the boot screen included, and no
// read is added: every reader is one that already ran before Notices existed.

const NONE: readonly Notice[] = Object.freeze([])
const NOTICE_ORDER: readonly NoticeKind[] = ['build', 'auma']
let shown: readonly Notice[] = NONE
const feeds = new Map<string, readonly NoticeEntry[]>()
const firstSeen = new Map<string, number>()
const listeners = new Set<() => void>()

/**
 * Replace what one reader found. A notice keeps the moment it was first seen while any reader holds it; one that no
 * reader holds any more is forgotten. Merged by id; and since one reload settles a kind, two readers that found
 * different builds (or heads) of one kind give one row: the one first seen last.
 * @param feeder - the reader's own key (one per mounted reader).
 * @param entries - every notice that reader holds now.
 * @param now - this page's clock.
 */
export function publishNotices(feeder: string, entries: readonly NoticeEntry[], now: number = Date.now()): void {
  if (entries.length === 0) feeds.delete(feeder)
  else feeds.set(feeder, entries)
  const byId = new Map<string, NoticeEntry>()
  for (const held of feeds.values()) for (const entry of held) if (!byId.has(entry.id)) byId.set(entry.id, entry)
  for (const id of [...firstSeen.keys()]) if (!byId.has(id)) firstSeen.delete(id)
  const byKind = new Map<NoticeKind, Notice>()
  for (const entry of byId.values()) {
    const seen = firstSeen.get(entry.id) ?? now
    firstSeen.set(entry.id, seen)
    const before = byKind.get(entry.kind)
    if (before === undefined || seen > before.firstSeen) byKind.set(entry.kind, Object.freeze({ ...entry, firstSeen: seen }))
  }
  // Newest first; notices first seen together keep their fixed order (build, then auma).
  const next = [...byKind.values()].sort((a, b) => b.firstSeen - a.firstSeen
    || NOTICE_ORDER.indexOf(a.kind) - NOTICE_ORDER.indexOf(b.kind))
  shown = next.length === 0 ? NONE : Object.freeze(next)
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The notices that hold now, newest first. */
export function currentNotices(): readonly Notice[] {
  return shown
}

/** The notices that hold now, newest first, for the launcher and the surface. */
export function useNotices(): readonly Notice[] {
  return useSyncExternalStore(subscribe, currentNotices, () => NONE)
}

/** Tests only: forget every notice. */
export function resetNoticesForTests(): void {
  feeds.clear()
  firstSeen.clear()
  shown = NONE
  for (const listener of [...listeners]) listener()
}

/**
 * Read build-notice.ts's two causes while `active` (the same two hooks, the same options, the same reload as
 * `useReloadNotice`), publish what is found into the page's notices, and return the same `ReloadNotice` for a surface's
 * own header button. Work and Aura call this in place of `useReloadNotice`, so their one read feeds both their button
 * and the Notices launcher. A notice already found stays while the reader is inactive, as the old pill's did; a reader
 * that unmounts takes what it found with it.
 * @param active - whether to read.
 * @param options - build-notice.ts's own options, passed through unchanged.
 */
export function useReloadNoticeFeed(
  active: boolean, options: { readonly edge?: EdgeBuildOptions; readonly lag?: HeadLagOptions } = {},
): ReloadNotice | null {
  const feeder = useId()
  const edge = useEdgeBuild(active, options.edge)
  const lag = useHeadLag(active, options.lag)
  const page = options.edge?.pageRevision === undefined ? pageSourceRevision() : options.edge.pageRevision
  const memory = options.edge?.memory
  useEffect(() => { publishNotices(feeder, noticeEntriesOf(edge, lag, page, memory)) }, [feeder, edge, lag, page, memory])
  useEffect(() => () => { publishNotices(feeder, []) }, [feeder])
  return useMemo(() => reloadNoticeOf(edge, lag, page, memory), [edge, lag, page, memory])
}

/**
 * The frame's reader: {@link useReloadNoticeFeed} without a button of its own (the frame draws no notice).
 * @param active - whether to read (the frame reads unless an app that reads for itself, or Notices, is open).
 * @param options - build-notice.ts's own options, passed through unchanged.
 */
export function useNoticeFeed(
  active: boolean, options: { readonly edge?: EdgeBuildOptions; readonly lag?: HeadLagOptions } = {},
): void {
  useReloadNoticeFeed(active, options)
}

// ── Words ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const two = (value: number): string => String(value).padStart(2, '0')

/**
 * When a notice was first seen, in this page's local time: the time today, else the date and the time.
 * @param at - when it was first seen.
 * @param now - this page's clock.
 */
export function firstSeenText(at: number, now: number = Date.now()): string {
  const seen = new Date(at)
  const today = new Date(now)
  const time = `${two(seen.getHours())}:${two(seen.getMinutes())}`
  if (seen.getFullYear() === today.getFullYear() && seen.getMonth() === today.getMonth() && seen.getDate() === today.getDate()) {
    return `First seen at ${time}`
  }
  const year = seen.getFullYear() === today.getFullYear() ? '' : ` ${String(seen.getFullYear())}`
  return `First seen ${String(seen.getDate())} ${MONTHS[seen.getMonth()] ?? ''}${year} at ${time}`
}

/**
 * The launcher's accessible name, which says the count.
 * @param count - how many notices wait.
 */
export function noticesLabel(count: number): string {
  return count === 0 ? 'Notices, nothing waiting' : `Notices, ${String(count)} waiting`
}

/** What the surface says when nothing waits. */
export const NOTHING_WAITING = 'Nothing is waiting.'
