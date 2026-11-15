// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * WHAT WAITS FOR THE OWNER'S FINGERPRINT, AS ROWS IN NOTICES (Wave 4 AC1 drew it as a pill over every surface).
 * Nothing is drawn
 * here any more: whenever HEAD holds something only the owner's passkey can approve (a staged Pearl, or a repo merge), it
 * is one row in Notices (`portal/notices.ts`), and the gold Notices launcher counts it. Each row's one action opens
 * Sovereignty, where the card is. It approves nothing and never asks for a fingerprint.
 *
 * WHAT IT READS, unchanged from the pill: `GET /_head/promotion-status` (`staged`, `stagedRepoProposal`): once when the page
 * opens, again on every push that can change it (`head:staged`, `repo:staged`, `repo:merged`, a ball commit), when the tab
 * comes back into view, and once a minute in case a push was missed. A host with no such route (the Mac host) is not asked
 * again; a read that fails gives no row: a row says something only when HEAD said it.
 * REVIEW OF Notices (item 3): the chat card was also the only signal outside Sovereignty for what waits in her HOME: her
 * staged outward request, a Pearl staged only there, an organ set. With the page's reader of her files, the same feed reads
 * them by the card's own readers (FingerprintWaiting.tsx, which stays mounted nowhere) and gives each a row; no new route.
 * @module portal/ApprovalWaiting
 */
import { useEffect, useId, useRef, useState } from 'react'
import { heldOrdinaryNothingNeeded, parseHeadStaged, STAGED_PROMOTION_CHANGE } from '../aumlok/head-promotion.ts'
import { onReasonChange, REASON_CHANGED_KEY, STAGED_OUTWARD_CHANGE } from '../aumlok/outward-class3.ts'
import { onSentChange, SENT_KEY } from '../aumlok/outward-sent.ts'
import { readPromotionAnswer } from '../aumlok/repo-proposal.ts'
import { COMMIT_FOLLOW_UPS, useDebounced, useLiveEvents } from '../work/autonomy.ts'
import {
  readWaitingApprovals, readWaitingOutward, type PublishedHeadCache, type WaitingHome, type WaitingRead,
} from './FingerprintWaiting.tsx'
import {
  approvalNoticeEntries, NO_HOME_APPROVALS, onApprovalsChanged, publishNotices, type ApprovalFacts, type HomeApprovalFacts,
  type StagedPearlFacts,
} from './notices.ts'

/** How often the reader reads again when no push arrives. */
export const APPROVAL_POLL_MS = 60_000

export interface ApprovalWaitingInjected {
  /** Open the Sovereignty surface. */
  readonly openSovereignty: () => void
  readonly fetchImpl?: typeof fetch
  /** Her home: the page's reader of her files and the Session Sovereignty reads (absent: HEAD's answer alone). */
  readonly home?: WaitingHome
}

/** What is waiting for the owner, as HEAD said it. */
export interface Waiting { readonly pearl: boolean; readonly repo: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const HEX_64 = /^[0-9a-f]{64}$/u
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null)

/** The Pearl HEAD's answer holds, each fact only when it is in HEAD's form. */
function pearlFactsOf(body: unknown): StagedPearlFacts | null {
  const staged = isRecord(body) && isRecord(body.staged) ? body.staged : null
  if (staged === null) return null
  const stagedAt = count(staged.stagedAt)
  return { ballId: typeof staged.ballId === 'string' && HEX_64.test(staged.ballId) ? staged.ballId : null, epoch: count(staged.epoch),
    stagedAt: stagedAt === null || stagedAt === 0 ? null : stagedAt }
}

/**
 * Read what HEAD holds for the owner, with what each row says.
 * @param signal - aborts the read.
 * @param fetchImpl - the page's fetch.
 * @returns what is waiting, `no-route` on a host without the route, or null when HEAD did not say (a failed read).
 */
export async function readApprovalFacts(signal: AbortSignal, fetchImpl?: typeof fetch): Promise<ApprovalFacts | 'no-route' | null> {
  const { repo, pearlStaged, body } = await readPromotionAnswer(signal, fetchImpl)
  if (repo.kind === 'absent' && pearlStaged === null) return 'no-route'
  if (pearlStaged === null) return null
  // A held ordinary change that needs nothing from him (the one predicate the card's words use) is not a
  // Pearl waiting for his fingerprint, so it gives no row.
  const held = pearlStaged ? await parseHeadStaged(body) : null
  const waits = pearlStaged && !(held?.kind === 'staged' && heldOrdinaryNothingNeeded(held.record))
  // A proposal HEAD serves in a form the page cannot check still waits for the owner: Sovereignty says why it cannot merge.
  return {
    merge: repo.kind === 'staged' ? repo.proposal : repo.kind === 'malformed' ? 'malformed' : null,
    pearl: waits ? pearlFactsOf(body) ?? { ballId: null, epoch: null, stagedAt: null } : null,
  }
}

/**
 * Read what HEAD holds for the owner.
 * @param signal - aborts the read.
 * @param fetchImpl - the page's fetch.
 * @returns what is waiting, or null when HEAD did not say (no route, a failed read).
 */
export async function readWaiting(signal: AbortSignal, fetchImpl?: typeof fetch): Promise<Waiting | 'no-route' | null> {
  const facts = await readApprovalFacts(signal, fetchImpl)
  if (facts === null || facts === 'no-route') return facts
  return { pearl: facts.pearl !== null, repo: facts.merge !== null }
}

/** What was waiting, in a few words (the old pill's; kept for anything that names it). */
export function waitingWords(waiting: Waiting): string {
  if (waiting.pearl && waiting.repo) return 'Approvals waiting: a Pearl and a merge'
  return waiting.repo ? 'Approval waiting: a merge' : 'Approval waiting: a Pearl'
}

/** Whether a live mirror change may touch a file (the host did not say what changed, or named it). */
const touches = (paths: readonly string[] | null, change: RegExp): boolean => paths === null || paths.length === 0
  || paths.some(path => change.test(path))

/**
 * What waits in her home, from the chat card's readers' answers (nothing that waits may go
 * silent). HEAD's merge and HEAD's Pearl are not repeated here: their rows come from HEAD's own answer.
 * @param read - `readWaitingApprovals` with her home (null: not read, or HEAD did not say).
 * @param outward - `readWaitingOutward` (null: not read, or the read failed).
 * @param facts - what HEAD said, from this feed's own read (null: HEAD did not say).
 * @returns what the home rows say.
 */
export function homeApprovalFactsOf(read: WaitingRead | null, outward: WaitingRead | null, facts: ApprovalFacts | null): HomeApprovalFacts {
  let homePearl: HomeApprovalFacts['homePearl'] = null
  let organSet: HomeApprovalFacts['organSet'] = null
  for (const item of read?.ready ?? []) {
    if (item.kind === 'home-pearl') homePearl = { ballId: item.card.binding.ballId, epoch: item.card.binding.epoch }
    else if (item.kind === 'organ-set') organSet = { ballId: item.body.ballId, organs: item.body.organs.map(organ => organ.organId) }
  }
  // WAITING, BUT NOT APPROVABLE AS IT STANDS: the card counted these without saying which. One about HEAD's merge or HEAD's
  // Pearl already has HEAD's row (one Pearl is one item, whichever sources hold it); while HEAD holds no Pearl, what is
  // left is a Pearl in her home.
  if (homePearl === null && read !== null && facts !== null && facts.pearl === null && read.blocked > 0) {
    const mergeBlocked = facts.merge !== null && !read.ready.some(item => item.kind === 'merge') ? 1 : 0
    if (read.blocked > mergeBlocked) homePearl = 'blocked'
  }
  const request = outward?.ready.find(item => item.kind === 'outward')
  const out: HomeApprovalFacts['outward'] = request?.kind === 'outward' ? { door: request.staged.tool }
    : (outward?.blocked ?? 0) > 0 ? 'unreadable' : null
  return homePearl === null && organSet === null && out === null ? NO_HOME_APPROVALS : { homePearl, organSet, outward: out }
}

/**
 * Read what waits for the owner's fingerprint, on the pill's own schedule, and publish it as rows in Notices. Draws
 * nothing. The frame calls it once, so every screen's Notices launcher counts what waits.
 * HEAD's merge and Pearl: one `GET /_head/promotion-status`, as the pill read it. With her home (the page's reader of her
 * files, which installWorkSurface fills, and the Session Sovereignty reads), also what the chat card read there, by the
 * card's own readers and on its own triggers: a Pearl staged only in her home or an organ set HEAD holds
 * (`readWaitingApprovals`: HEAD's promotion route, its lease, its published Pearl once per head), and her staged outward
 * request (`readWaitingOutward`, which never waits on HEAD's route: the Mac host serves outward requests but not that one).
 * @param openSovereignty - what a row's one action does.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @param home - her home (absent: HEAD's answer alone).
 */
export function useApprovalNoticeFeed(openSovereignty: () => void, fetchImpl?: typeof fetch, home?: WaitingHome): void {
  const feeder = useId()
  const [facts, setFacts] = useState<ApprovalFacts | null>(null)
  // A host with no such route (the Mac host) is not asked again: nothing there can wait for the passkey this way.
  const [noRoute, setNoRoute] = useState(false)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const [tick, setTick] = useState(0)
  const [outwardTick, setOutwardTick] = useState(0)
  const reader = home?.reader
  const sessionId = home?.sessionId
  const withHome = reader !== undefined && sessionId !== undefined
  const [homeRead, setHomeRead] = useState<WaitingRead | null>(null)
  const [outward, setOutward] = useState<WaitingRead | null>(null)
  // The published head, kept across reads: `/_head/ball` is read once per head, as the chat card did.
  const publishedHead = useRef<PublishedHeadCache['current']>(null)
  // The row's action opens Sovereignty through whatever the caller gives now, without republishing the rows.
  const open = useRef(openSovereignty)
  useEffect(() => { open.current = openSovereignty }, [openSovereignty])
  useEffect(() => {
    if (noRoute) return
    const controller = new AbortController()
    void readApprovalFacts(controller.signal, fetchImpl).then((next) => {
      if (controller.signal.aborted) return
      if (next === 'no-route') { setNoRoute(true); setFacts(null) } else setFacts(next)
    })
    return () => { controller.abort() }
  }, [tick, fetchImpl, noRoute])
  // A PEARL IN HER HOME, OR AN ORGAN SET: only where HEAD answered its promotion route. A read that fails gives no row.
  useEffect(() => {
    if (noRoute || reader === undefined || sessionId === undefined) { setHomeRead(null); return }
    const controller = new AbortController()
    void readWaitingApprovals(controller.signal, fetchImpl, Date.now, { reader, sessionId }, 0, publishedHead).then(
      (next) => { if (!controller.signal.aborted) setHomeRead(next) },
      () => { if (!controller.signal.aborted) setHomeRead(null) })
    return () => { controller.abort() }
  }, [tick, fetchImpl, noRoute, reader, sessionId])
  // HER OUTWARD REQUEST, read on its own: a change to it reads nothing else. A read that fails gives no row.
  useEffect(() => {
    if (reader === undefined || sessionId === undefined) { setOutward(null); return }
    const controller = new AbortController()
    void readWaitingOutward({ reader, sessionId }, controller.signal).then(
      (next) => { if (!controller.signal.aborted) setOutward(next) },
      () => { if (!controller.signal.aborted) setOutward(null) })
    return () => { controller.abort() }
  }, [tick, outwardTick, reader, sessionId])
  useEffect(() => {
    if (noRoute && !withHome) return
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') setTick(n => n + 1) }, APPROVAL_POLL_MS)
    const onVisible = (): void => {
      setVisible(document.visibilityState !== 'hidden')
      if (document.visibilityState === 'visible') setTick(n => n + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [noRoute, withHome])
  // A REQUEST SENT ELSEWHERE IS NO LONGER WAITING: another tab says so through `localStorage`, a card on this page says so
  // itself (a `storage` event never fires in the page that wrote it); so is an ask the edge refused because its reason changed.
  useEffect(() => {
    if (!withHome) return
    const again = (): void => { setOutwardTick(n => n + 1) }
    const onStorage = (event: StorageEvent): void => { if (event.key === SENT_KEY || event.key === REASON_CHANGED_KEY) again() }
    globalThis.addEventListener('storage', onStorage)
    const off = onSentChange(again)
    const offReason = onReasonChange(again)
    return () => { globalThis.removeEventListener('storage', onStorage); off(); offReason() }
  }, [withHome])
  const reread = useDebounced(() => { setTick(n => n + 1) })
  const rereadOutward = useDebounced(() => { setOutwardTick(n => n + 1) })
  // A card on this page merged what HEAD held: read again now (a host without the route is still not asked).
  useEffect(() => onApprovalsChanged(() => { setTick(n => n + 1) }), [])
  // Listening holds the page's live socket open, so only while the tab is in view (a hidden tab reads again on return).
  useLiveEvents(visible && (!noRoute || withHome), (event) => {
    if (event.kind === 'head-staged' || event.kind === 'repo-staged' || event.kind === 'repo-merged' || event.kind === 'ball-commit') {
      reread.poke()
      // Her worker adopts a commit from elsewhere a moment later (her staged file with it): while a Pearl from her home is
      // a row, her home is read again then, so a Pearl that landed elsewhere goes.
      if (event.kind === 'ball-commit' && homeRead?.ready.some(item => item.kind === 'home-pearl') === true) reread.followUp(COMMIT_FOLLOW_UPS)
      return
    }
    if (event.kind !== 'mirror-updated' || !withHome) return
    if (touches(event.changedPaths, STAGED_PROMOTION_CHANGE)) reread.poke()
    if (touches(event.changedPaths, STAGED_OUTWARD_CHANGE)) rereadOutward.poke()
  })
  useEffect(() => {
    const home = homeApprovalFactsOf(homeRead, outward, facts)
    publishNotices(feeder, approvalNoticeEntries(facts, () => { open.current() }, Date.now(), home))
  }, [feeder, facts, homeRead, outward])
  useEffect(() => () => { publishNotices(feeder, []) }, [feeder])
}

/**
 * The old pill's component, kept for anything that mounts it: it now only feeds the rows in Notices and draws nothing.
 * @param props - what a row opens, and the page's fetch.
 */
export function ApprovalWaiting({ openSovereignty, fetchImpl, home }: ApprovalWaitingInjected): null {
  useApprovalNoticeFeed(openSovereignty, fetchImpl, home)
  return null
}
