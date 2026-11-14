// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * NOTHING FLOATS: NOTICES LIVE BEHIND ONE BUTTON. The owner learns that something waits
 * for him from one place: the Notices launcher, first in the system menu, gold with a count while anything waits
 * (`NoticesSurface.tsx`). No notice is drawn over content, opens by itself, takes focus or makes a sound.
 *
 * THE MODEL is one list of `{ id, kind, what, detail?, firstSeen, action }`, fed by:
 *   build    a new build of the app is live on the edge (`useEdgeBuild`), in `EDGE_BUILD_WORDS.what`;
 *   auma     a newer (or other) Auma is published than this tab runs (`useHeadLag`), in `headLagWords(lag).what`;
 *   release  the host selects a different runtime release than this page runs (`useNewBuild`, Work and Aura only), in
 *            the words their old header button carried (those buttons are gone, so this row is its Reload);
 *   merge    HEAD holds a merge Auma staged for the owner's fingerprint (`stagedRepoProposal`);
 *   pearl    HEAD holds a Pearl staged for the owner's fingerprint (`staged`); an organ set is this row, in its words;
 *   home-pearl  a Pearl staged only in her home (the chat card was its only signal outside Sovereignty);
 *   outward  her staged outward request, from her home.
 * The two home rows are read by the readers the chat card used (`readWaitingApprovals`, `readWaitingOutward`), through
 * the page's existing reader of her files: no new route.
 * The three reload rows' Reload is the very function the frame's old pill called (`reloadNoticeOf(edge, lag, ...).reload`,
 * or `reloadUnlessHeld` for the host's selection): one press settles them all and waits while an approval is in flight.
 * The two approval rows
 * replace the Fingerprint card over the chat and the "Approval waiting" pill: their one action opens
 * Sovereignty, where the card is. A row NEVER approves and never asks for a fingerprint. They are read by the reader the
 * pill had (`portal/ApprovalWaiting.tsx`: one `GET /_head/promotion-status`, the same refresh rules, no new route).
 *
 * NOTHING NEW IS READ OR KEPT. Every reader (the frame; Work and Aura Coherence while open) calls the same two hooks
 * `useReloadNotice` calls, with the same options, so the reads, their spacing and their refusal handling are
 * build-notice.ts's own, and each publishes what it found into the one list (`useReloadNoticeFeed`). When each
 * notice was first seen is kept in this page's memory only, and forgotten with the notice.
 * @module portal/notices
 */
import { useEffect, useId, useMemo, useSyncExternalStore } from 'react'
import {
  EDGE_BUILD_WORDS, headLagWords, pageSourceRevision, reloadNoticeOf, reloadUnlessHeld, useEdgeBuild, useHeadLag,
  type BuildMemory, type EdgeBuildOptions, type HeadLagNotice, type HeadLagOptions, type ReloadNotice,
} from './build-notice.ts'
import type { RepoProposal } from '../aumlok/repo-proposal.ts'

/** The centre surface the Notices launcher opens. */
export const NOTICES_SURFACE = 'notices'

/** What a notice is about: three reasons to reload, and four approvals waiting for the owner's fingerprint. */
export type NoticeKind = 'build' | 'auma' | 'release' | 'merge' | 'pearl' | 'home-pearl' | 'outward'

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
  /** One more line, said in place of when it was first seen (an approval's status, from what HEAD said). */
  readonly detail?: string
  /** Epoch milliseconds, this page's own clock. */
  readonly firstSeen: number
  readonly action: NoticeAction
}

/** A notice before this page has stamped when it first saw it. */
export type NoticeEntry = Omit<Notice, 'firstSeen'>

/** The action's words: the same verb the old pill ended with. */
export const RELOAD_LABEL = 'Reload'
/** An approval row's one action: it opens Sovereignty, where the card is. It approves nothing. */
export const OPEN_SOVEREIGNTY_LABEL = 'Open Sovereignty'
/** What Work and Aura say in their own flow, where their Reload button was, while a newer build exists. */
export const NEW_BUILD_LINE = 'A new build is live: see Notices.'
/** The host's selection, in the words Work's and Aura's old header button carried. */
export const HOST_RELEASE_WHAT = 'The host now selects a different runtime release than this page runs. A selection is not a health check; '
  + 'reloading loads it.'

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

/** The host selected a different runtime release than this page runs (`useNewBuild`), with the words to say it in. */
export interface HostRelease { readonly release: string; readonly what: string }

/**
 * The notice for the host's selected release: its Reload is the one Work's and Aura's old button pressed.
 * @param host - the release the host selects, and its words.
 */
export function hostReleaseEntry(host: HostRelease): NoticeEntry {
  return { id: `release:${host.release}`, kind: 'release', what: host.what, action: { label: RELOAD_LABEL, run: () => { reloadUnlessHeld() } } }
}

// ── The two approvals, in his words, built only from what HEAD said ─────────────────────────────────────────────────

/** A Pearl HEAD holds, as its promotion-status answer names it (each field only when it is in HEAD's form). */
export interface StagedPearlFacts { readonly ballId: string | null; readonly epoch: number | null; readonly stagedAt: number | null }

/** What HEAD holds for the owner's fingerprint: a merge (or one this page cannot read), and a Pearl. */
export interface ApprovalFacts {
  readonly merge: Pick<RepoProposal, 'branch' | 'headSha' | 'ciStatus' | 'stagedAt'> | 'malformed' | null
  readonly pearl: StagedPearlFacts | null
}

// The checks as the card recorded them, and what approving does now: the host reads the checks of the exact commit again at
// approval and merges only if they passed then (a refusal leaves his approval unspent); a failed card cannot be approved.
const CHECKS_WHEN_MADE: Readonly<Record<RepoProposal['ciStatus'], { readonly made: string; readonly then: string }>> = {
  passed: { made: 'Checks passed when this card was made', then: '' },
  pending: { made: 'Checks were still running when this card was made', then: ' Approving checks them again.' },
  failed: { made: 'Checks failed when this card was made', then: ' This card cannot be approved.' },
  none: { made: 'No checks had run yet when this card was made', then: ' Approving checks them again.' },
}

/**
 * The merge row's one status line, from the card's own fields (the staged snapshot, never the checks now).
 * @param ciStatus - the checks as the card recorded them.
 * @param stagedAt - when HEAD staged it (null: not said).
 * @param now - this page's clock.
 */
export function checksLine(ciStatus: RepoProposal['ciStatus'], stagedAt: number | null, now: number = Date.now()): string {
  const words = CHECKS_WHEN_MADE[ciStatus]
  return `${words.made}${stagedAt === null ? '' : `, ${clockText(stagedAt, now)}`}.${words.then}`
}

// ── What waits in her home (nothing that waits may go silent) ───────────────────────────

/** Where her staged outward request goes, by the door it names (aumlok/outward-class3.ts `StagedOutward['tool']`). */
export type OutwardDoor = 'x6_github' | 'x6_repo' | 'x6_cloudflare' | 'x6_linear'
const OUTWARD_GOES_TO: Readonly<Record<OutwardDoor, string>> = {
  x6_github: 'It goes to GitHub.',
  x6_repo: 'It goes to her repository on GitHub.',
  x6_cloudflare: 'It goes to Cloudflare.',
  x6_linear: 'It goes to Linear.',
}

/**
 * What the chat card's readers found in her home (`readWaitingApprovals` and `readWaitingOutward`, through the page's
 * reader of her files): a Pearl staged there (`blocked`: one Sovereignty shows that cannot be approved as it stands), an
 * organ set HEAD holds that this page confirmed, and her outward request (`unreadable`: a file this page cannot read).
 */
export interface HomeApprovalFacts {
  readonly homePearl: { readonly ballId: string; readonly epoch: number } | 'blocked' | null
  readonly organSet: { readonly ballId: string; readonly organs: readonly string[] } | null
  readonly outward: { readonly door: OutwardDoor } | 'unreadable' | null
}
/** Nothing waiting in her home (or her home was not read). */
export const NO_HOME_APPROVALS: HomeApprovalFacts = Object.freeze({ homePearl: null, organSet: null, outward: null })

/** Her outward request's row, in his words. */
export const OUTWARD_WHAT = 'Auma is asking to send something outward. It waits for your fingerprint.'

/**
 * The approval rows: one per thing waiting, each opening Sovereignty and nothing else. One Pearl is one row, whichever
 * source holds it: a Pearl in her home that HEAD holds too is HEAD's row; an organ set is its Pearl's row, in its words.
 * @param facts - what HEAD said (null: HEAD did not say).
 * @param openSovereignty - opens Sovereignty.
 * @param now - this page's clock.
 * @param home - what waits in her home.
 */
export function approvalNoticeEntries(facts: ApprovalFacts | null, openSovereignty: () => void, now: number = Date.now(),
  home: HomeApprovalFacts = NO_HOME_APPROVALS): readonly NoticeEntry[] {
  const action: NoticeAction = { label: OPEN_SOVEREIGNTY_LABEL, run: openSovereignty }
  const entries: NoticeEntry[] = []
  const merge = facts?.merge ?? null
  const pearl = facts?.pearl ?? null
  if (merge === 'malformed') {
    entries.push({ id: 'merge:unreadable', kind: 'merge', what: 'A merge is waiting for your fingerprint.',
      detail: 'This page cannot read the card HEAD holds for it: Sovereignty says why.', action })
  } else if (merge !== null) {
    entries.push({ id: `merge:${merge.branch}@${merge.headSha}:${merge.ciStatus}`, kind: 'merge',
      what: `A merge is waiting for your fingerprint: ${merge.branch} → main.`, detail: checksLine(merge.ciStatus, merge.stagedAt, now), action })
  }
  if (pearl !== null) {
    const organs = home.organSet !== null && pearl.ballId !== null && home.organSet.ballId === pearl.ballId ? home.organSet.organs : null
    entries.push({ id: `pearl:${pearl.ballId ?? 'unnamed'}${organs === null ? '' : ':organs'}`, kind: 'pearl',
      what: organs === null ? `A Pearl is waiting for your fingerprint${pearl.epoch === null ? '' : `: epoch ${String(pearl.epoch)}`}.`
        : `Auma is asking to add ${organs.length === 1 ? 'an organ' : 'organs'}: ${organs.join(', ')}. It waits for your fingerprint.`,
      ...(pearl.stagedAt === null ? {} : { detail: `Staged on HEAD: ${clockText(pearl.stagedAt, now)}.` }), action })
  }
  const homePearl = home.homePearl
  if (homePearl === 'blocked') {
    entries.push({ id: 'home-pearl:blocked', kind: 'home-pearl',
      what: 'A Pearl Auma staged in her home is waiting, but cannot be approved as it stands.', detail: 'Sovereignty says why.', action })
  } else if (homePearl !== null && homePearl.ballId !== pearl?.ballId) {
    entries.push({ id: `home-pearl:${homePearl.ballId}`, kind: 'home-pearl',
      what: `A Pearl Auma staged in her home is waiting for your fingerprint: epoch ${String(homePearl.epoch)}.`, action })
  }
  const outward = home.outward
  if (outward !== null) {
    entries.push({ id: outward === 'unreadable' ? 'outward:unreadable' : `outward:${outward.door}`, kind: 'outward', what: OUTWARD_WHAT,
      detail: outward === 'unreadable' ? 'This page cannot read her request: Sovereignty says why.' : OUTWARD_GOES_TO[outward.door], action })
  }
  return entries
}

// ── The page's one list ────────────────────────────────────────────────────────────────────────────────────────────
// WHOEVER READS, PUBLISHES. The frame reads while no app that reads for itself is open;
// Work and Aura Coherence (the boot app) read while they are open. Each reader publishes what it found under its own
// key, and the list is all of them merged, so the launcher is gold on every screen, the boot screen included, and no
// read is added: every reader is one that already ran before Notices existed.

const NONE: readonly Notice[] = Object.freeze([])
const NOTICE_ORDER: readonly NoticeKind[] = ['merge', 'pearl', 'home-pearl', 'outward', 'build', 'auma', 'release']
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
  // Newest first; notices first seen together keep their fixed order (merge, pearl, home-pearl, outward, build, auma, release).
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
 * `useReloadNotice`), publish what is found into the page's notices, and return the same `ReloadNotice`, which tells a
 * surface whether to say its quiet line. Work and Aura call this in place of `useReloadNotice`, and hand it the host's
 * selected release they read (`useNewBuild`), so their one read feeds the Notices launcher. A notice already found stays
 * while the reader is inactive, as the old pill's did; a reader that unmounts takes what it found with it.
 * @param active - whether to read.
 * @param options - build-notice.ts's own options, passed through unchanged.
 * @param host - the release the host selects, when it differs from this page's (null: none).
 */
export function useReloadNoticeFeed(
  active: boolean, options: { readonly edge?: EdgeBuildOptions; readonly lag?: HeadLagOptions } = {}, host: HostRelease | null = null,
): ReloadNotice | null {
  const feeder = useId()
  const edge = useEdgeBuild(active, options.edge)
  const lag = useHeadLag(active, options.lag)
  const page = options.edge?.pageRevision === undefined ? pageSourceRevision() : options.edge.pageRevision
  const memory = options.edge?.memory
  const hostRelease = host?.release ?? null
  const hostWhat = host?.what ?? HOST_RELEASE_WHAT
  useEffect(() => {
    publishNotices(feeder, [...noticeEntriesOf(edge, lag, page, memory),
      ...(hostRelease === null ? [] : [hostReleaseEntry({ release: hostRelease, what: hostWhat })])])
  }, [feeder, edge, lag, page, memory, hostRelease, hostWhat])
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

/** A moment in this page's local time: `14:05` today, else `13 Nov at 14:05` (with the year when it is not this one). */
function whenOf(at: number, now: number): { readonly today: boolean; readonly text: string } {
  const seen = new Date(at)
  const today = new Date(now)
  const time = `${two(seen.getHours())}:${two(seen.getMinutes())}`
  if (seen.getFullYear() === today.getFullYear() && seen.getMonth() === today.getMonth() && seen.getDate() === today.getDate()) {
    return { today: true, text: time }
  }
  const year = seen.getFullYear() === today.getFullYear() ? '' : ` ${String(seen.getFullYear())}`
  return { today: false, text: `${String(seen.getDate())} ${MONTHS[seen.getMonth()] ?? ''}${year} at ${time}` }
}

/**
 * When a notice was first seen, in this page's local time: the time today, else the date and the time.
 * @param at - when it was first seen.
 * @param now - this page's clock.
 */
export function firstSeenText(at: number, now: number = Date.now()): string {
  const when = whenOf(at, now)
  return when.today ? `First seen at ${when.text}` : `First seen ${when.text}`
}

/**
 * A moment HEAD named, in this page's local time: `14:05` today, else `13 Nov at 14:05`.
 * @param at - the moment.
 * @param now - this page's clock.
 */
export function clockText(at: number, now: number = Date.now()): string {
  return whenOf(at, now).text
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
