// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * "FINGERPRINT WAITING" IN THE CHAT LANE (Lanes B2 and B3): whenever something waits that only the owner's passkey can
 * approve, a gold card shows over the open chat with one line saying what it is, an "Approve with Touch ID" button that
 * runs the whole approval right there, "Inspect in Sovereignty", and a × that hides it for this page (it stays in
 * Sovereignty; the outer pill shows only what HEAD itself holds, so a Pearl staged only in her home, or her outward request,
 * is then shown nowhere outside Sovereignty). A Pearl is hidden as a Pearl (`pearl:<ballId>`), whichever source carries it.
 * Her outward request is shown with every row Sovereignty shows (the title, the full text, the request's bytes) above
 * its button: Touch ID approves exactly those bytes.
 *
 * WHAT IT READS, AND HOW OFTEN: HEAD's answer first; on a host without HEAD's promotion route (the Mac) her home is not
 * read at all. Her staged Pearl left over from a landing (her worker never removes it) is known as on HEAD from HEAD's lease
 * answer alone; the published head (`/_head/ball`, every module's code) is read only when a Pearl must be classified, and
 * once per head (its id and epoch), never once per poll.
 *
 * WHAT IT CAN APPROVE HERE, each checked exactly as in Sovereignty (the passkey terms are computed here, from the bytes):
 *   a governance Pearl HEAD holds (`/_head/promotion-status` `staged`): HEAD promotes the bytes it holds;
 *   a governance Pearl staged in her home (`STAGED_PROMOTION_PATH`), held by HEAD too or not (then only this window shows
 *     it): the page takes a fresh writer lease and sends her staged bytes (`POST /_head/ball`), as Sovereignty does. Her
 *     file and HEAD's record are merged by Sovereignty's own rule (promotion-sources.ts), so one Pearl is one item, sent
 *     the way Sovereignty would send it. It is offered only where HEAD answered its promotion route, which only the edge
 *     serves: on the Mac host Sovereignty shows it, with why the Mac cannot land it;
 *   a repo merge proposal HEAD holds (`stagedRepoProposal`);
 *   Auma's staged outward request (`STAGED_OUTWARD_PATH`): the page sends exactly those bytes, and a request that went
 *     out, or may have, is not offered again by this card or by Sovereignty, by this browser while its record holds
 *     (aumlok/outward-sent.ts: a reload with storage refused, a record pushed out by newer sends, or another device does
 *     not know it).
 * Her home is read only when the frame gives the card the page's reader and the Session Sovereignty reads; without them
 * the card shows what HEAD holds, as before.
 *
 * ONE APPROVAL AT A TIME PER ITEM: this card and Sovereignty's cards take the same lock (touch-id-timing.ts), so one Pearl
 * or one request never gets two passkey ceremonies, whichever card is tapped.
 *
 * SAFARI: a passkey sheet opens only inside the tap that asked for it (transient user activation). So the tap goes
 * straight to the approval (`POST /_host/aumlok/challenge`, then Touch ID) when the card's check is fresh (under
 * FRESH_CHECK_MS, and for a Pearl or her request, with no live change to what it was read from since): no other request
 * runs first; every read happens when the card reads, never inside the tap. HEAD still checks
 * everything when the approved request arrives (the candidate and its parent for a Pearl, main and the branch for a merge,
 * the body's hash for an outward request). A card checked longer ago is checked again first; if the browser then refuses
 * the sheet, the card says to tap once more.
 *
 * AN OUTCOME STAYS UNTIL THE OWNER CLOSES IT: the last approval's outcome is shown above whichever item comes next, until ×
 * or the next approval starts. A tap refused because another card on this page is approving the same item is said only
 * until the card next reads.
 *
 * HOW IT IS DRAWN: as a Spatial Portal card in the gold tone (the primitives' frame, pill, field table and action pills),
 * with what a card over the chat needs in FingerprintWaiting.module.css: its place at the top of the thread stack, an
 * opaque surface, ONE filled gold button. Nothing here carries a colour or a spacing of its own.
 * @module portal/FingerprintWaiting
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { approveClass3, canonicalJson, type Class3Dependencies } from '../aumlok/class3-approval.ts'
import {
  canonicalManifestIdMatches, landApprovedPromotion, parseHeadStaged, promoteStagedOnHead, readHeadLease, sameStagedBody,
  STAGED_PROMOTION_CHANGE, type HeadLeaseRead, type LandStep,
} from '../aumlok/head-promotion.ts'
import {
  approveAndSendOutward, outwardWords, readStagedOutward, STAGED_OUTWARD_CHANGE, type StagedOutward,
} from '../aumlok/outward-class3.ts'
import { markSent, onSentChange, SENT_KEY, wasSent } from '../aumlok/outward-sent.ts'
import {
  approveAndMerge, mergeOutcomeWords, readPromotionAnswer, repoProposalProblems,
} from '../aumlok/repo-proposal.ts'
import { COMMIT_FOLLOW_UPS, useDebounced, useLiveEvents } from '../work/autonomy.ts'
import type { WorkReader } from '../work/WorkSurface.tsx'
import { IconTile, Lead, StatusPill, type Tone } from '../primitives/index.ts'
import css from './FingerprintWaiting.module.css'
import { OUTWARD_APPROVES_EXACTLY } from './OutwardApprovalCell.tsx'
import { organSetOutcomeWords } from './OrganSetCell.tsx'
import { approveOrganSet, readOrganSet, sameOrganSet, type OrganSetBody } from '../aumlok/organ-set.ts'
import { mergePromotionSources, promotionContextOf, publishedPearlOf, readHomePromotion } from './promotion-sources.ts'
import {
  headPromotionStateOf, landStepWords, parsePublishedHead, promotionOutcomeWords, promotionStateOf, type PromotionContext,
  type PromotionState, type PublishedHead,
} from './SovereigntySurface.tsx'

import {
  beginApproval, endApproval, FRESH_CHECK_MS, freshFor, mergeApprovalKey, outwardApprovalKey, passkeyDidNotComplete, pearlApprovalKey,
  TAP_AGAIN,
} from './touch-id-timing.ts'

export { FRESH_CHECK_MS }
/** How often the card reads again when no push arrives. */
export const FINGERPRINT_POLL_MS = 60_000

type StagedCard = Extract<PromotionState, { kind: 'staged' }>

/** One thing waiting for the passkey that this card can approve, already checked. */
export type Waiting =
  | {
    /** The Pearl HEAD holds itself: HEAD promotes it. */
    readonly kind: 'pearl'
    readonly key: string
    /** The key every card on this page approves this Pearl under (one approval at a time). */
    readonly approval: string
    readonly line: string
    readonly card: StagedCard
    readonly checkedAt: number
    /**
     * The card's count of live changes to HEAD (a commit, a Pearl HEAD takes to hold) or her file when this read began: the
     * check is fresh only while it holds, as Sovereignty's held card (`changesChecked === changesSeen`).
     */
    readonly changesAtRead: number
  }
  | {
    /**
     * A Pearl staged in her home (HEAD may hold the same one, `card.onHead`, or none, `card.edgeEmpty`): the page sends her
     * staged bytes under a fresh writer lease. Approved under the same key as the same Pearl from HEAD.
     */
    readonly kind: 'home-pearl'
    readonly key: string
    readonly approval: string
    readonly line: string
    readonly card: StagedCard
    readonly checkedAt: number
    /** The card's count of live changes to her file or to HEAD when this read began: the check is fresh only while it holds. */
    readonly changesAtRead: number
  }
  | {
    readonly kind: 'merge'
    readonly key: string
    readonly approval: string
    readonly line: string
    readonly checkedAt: number
    readonly proposal: Parameters<typeof approveAndMerge>[0]
    readonly terms: Parameters<typeof approveAndMerge>[1]
  }
  | {
    /** A Pearl HEAD holds that only adds ordinary organs: one approval bound to exactly this list (aumlok/organ-set.ts). */
    readonly kind: 'organ-set'
    readonly key: string
    readonly approval: string
    readonly line: string
    readonly body: OrganSetBody
    readonly checkedAt: number
    readonly changesAtRead: number
  }
  | {
    /** Auma's staged outward request: the page sends exactly these bytes. */
    readonly kind: 'outward'
    readonly key: string
    readonly approval: string
    readonly line: string
    readonly staged: StagedOutward
    readonly checkedAt: number
    /** The card's count of live changes to her request file when this read began. */
    readonly changesAtRead: number
  }

/** What the card read: the items it can approve here, and how many others wait in Sovereignty only. */
export interface WaitingRead {
  readonly ready: readonly Waiting[]
  /** Things that wait for the passkey that cannot be approved from here as they stand (checks in the way, or unreadable). */
  readonly blocked: number
}

/** Her home, as Sovereignty reads it: the page's reader of her files, and the Session whose files it reads (`sessionOf`). */
export interface WaitingHome {
  readonly reader: WorkReader
  readonly sessionId: SessionId
}

const short = (hex: string): string => hex.slice(0, 8)
const pearlLine = (card: StagedCard): string =>
  `Epoch ${String(card.binding.epoch)} · ${card.binding.organId} (${short(card.binding.ballId)}…)`

/**
 * Whether Sovereignty draws this Pearl state as waiting on the owner: counted as one that cannot be approved from here as it
 * stands. A Pearl on HEAD already, one that needs no passkey, or a home that was not read draws nothing there, nor here.
 */
const waitsInSovereignty = (state: PromotionState): boolean => state.kind === 'staged' || state.kind === 'malformed'
  || state.kind === 'several' || (state.kind === 'unreadable' && state.staged === true) || state.kind === 'head-blocked'

/** Whether a live mirror change may touch a file (the host did not say what changed, or named it). */
const touches = (paths: readonly string[] | null, change: RegExp): boolean => paths === null || paths.length === 0
  || paths.some(path => change.test(path))

/** A published head as the card keeps it: only what the classification reads, never the module code it came with. */
type KeptHead = Pick<PublishedHead, 'entries' | 'ballId' | 'epoch'>

/**
 * The published head the card read last, under its id and epoch. A Pearl's id names its whole manifest (HEAD's
 * `manifestId`), so the same id and epoch are the same entries: `/_head/ball`, which carries every module's code, is read
 * once per head, not once per poll. The card keeps one in a ref across its reads.
 */
export interface PublishedHeadCache { current: { readonly key: string; readonly head: KeptHead } | null }
const headKey = (ballId: string, epoch: number | string): string => `${ballId}@${String(epoch)}`

/**
 * The published head's entries, from the cache when HEAD's lease answer names the head the cache holds, else read.
 * @param signal - aborts the read.
 * @param fetchImpl - the page's fetch.
 * @param named - HEAD's selected Pearl as its lease answer named it (null: not named, so not looked up).
 * @param cache - the card's cache (absent: always read).
 * @returns the head, or null when it was not read.
 */
async function readPublishedHead(signal: AbortSignal, fetchImpl: typeof fetch, named: HeadLeaseRead['head'], cache?: PublishedHeadCache)
  : Promise<KeptHead | null> {
  const kept = cache?.current ?? null
  if (named !== null && kept !== null && kept.key === headKey(named.ballId, named.epoch)) return kept.head
  let read: PublishedHead | null = null
  try {
    const response = await fetchImpl('/_head/ball', { credentials: 'same-origin', cache: 'no-store', signal })
    read = response.ok ? parsePublishedHead(await response.json()) : null
  } catch { read = null }
  if (read === null) return null
  const head: KeptHead = { entries: read.entries, ballId: read.ballId, epoch: read.epoch }
  // Only a head in HEAD's own form, with its entries, is kept: anything else is read again next time.
  if (cache !== undefined && head.entries !== null && /^[0-9a-f]{64}$/u.test(head.ballId) && /^\d+$/u.test(head.epoch)) {
    cache.current = { key: headKey(head.ballId, head.epoch), head }
  }
  return head
}

/** What a Pearl's classification reads besides the Pearl, each read at most once per card read and only when needed. */
interface ContextReads {
  /** HEAD's lease answer: small, and it names HEAD's selected Pearl. */
  readonly lease: () => Promise<HeadLeaseRead>
  /** HEAD's selected Pearl as the lease answer named it, only when this card read already asked (null: not read, or none). */
  readonly headIfRead: () => Promise<{ readonly ballId: string } | null>
  /** The whole context: the lease answer and the published head's entries (HEAD's own rule runs against them). */
  readonly full: () => Promise<PromotionContext>
}

/**
 * The classification's reads for one card read: the lease first, the published head only when a Pearl is classified.
 * @param signal - aborts the reads.
 * @param fetchImpl - the page's fetch.
 * @param now - the clock.
 * @param cache - the card's published head, kept across reads.
 * @returns the reads. HEAD answered its promotion route, which only the edge serves, so the runtime is the edge's.
 */
function contextReads(signal: AbortSignal, fetchImpl: typeof fetch, now: () => number, cache?: PublishedHeadCache): ContextReads {
  let lease: Promise<HeadLeaseRead> | null = null
  let full: Promise<PromotionContext> | null = null
  const readLease = (): Promise<HeadLeaseRead> => (lease ??= readHeadLease(signal, fetchImpl))
  return {
    lease: readLease,
    headIfRead: async () => (lease === null ? null : (await lease).head),
    full: () => (full ??= readLease().then(async answer => promotionContextOf({
      published: await readPublishedHead(signal, fetchImpl, answer.head, cache), lease: answer, runtime: 'cloudflare',
      audience: globalThis.location.origin, now: now(),
    }))),
  }
}

/**
 * Read and check everything HEAD holds for the owner's passkey and, with her home, the Pearl staged there.
 * @param signal - aborts the reads.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @param now - the clock; each item's check is dated from when this read began.
 * @param home - her home (absent: HEAD's answer alone, as before Lane B3).
 * @param changesAtRead - the card's count of live changes to her file or HEAD when this read began.
 * @param cache - the card's published head, kept across its reads (absent: read whenever a Pearl is classified).
 * @returns what is waiting, or null when HEAD did not say (no route, a failed read).
 */
export async function readWaitingApprovals(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch, now: () => number = Date.now,
  home?: WaitingHome, changesAtRead = 0, cache?: PublishedHeadCache): Promise<WaitingRead | null> {
  const startedAt = now()
  // HEAD'S ANSWER FIRST: a host without HEAD's promotion route (the Mac) offers no Pearl here, so her home is not read.
  const status = await readPromotionAnswer(signal, fetchImpl)
  if (status.pearlStaged === null) return null
  const ready: Waiting[] = []
  let blocked = 0
  if (status.repo.kind === 'staged') {
    const { problems, terms } = await repoProposalProblems(status.repo.proposal, globalThis.location.origin)
    const p = status.repo.proposal
    if (problems.length === 0) {
      ready.push({ kind: 'merge', key: status.repo.canonical, approval: mergeApprovalKey(status.repo.canonical), proposal: p, terms,
        checkedAt: startedAt,
        line: `Merge ${p.branch} → main · ${p.ciStatus === 'passed' ? 'CI green' : p.ciStatus === 'failed' ? 'CI FAILED' : `CI ${p.ciStatus}`}` })
    } else blocked += 1
  } else if (status.repo.kind === 'malformed') blocked += 1
  const headPearl = (card: StagedCard): Waiting => ({ kind: 'pearl', key: `${card.binding.ballId}:${String(card.onHead?.candidateDigest)}`,
    approval: pearlApprovalKey(card.binding.ballId), card, checkedAt: startedAt, changesAtRead, line: pearlLine(card) })
  // One set of reads serves both sources: the lease when her file holds a Pearl, the published head only to classify one.
  const context = contextReads(signal, fetchImpl, now, cache)
  // A Pearl that only adds ordinary organs: offered when this page confirms HEAD's exact list, else waiting in Sovereignty.
  const organSet = async (): Promise<void> => {
    const read = await readOrganSet(signal, fetchImpl)
    if (read.kind === 'offer') {
      ready.push({ kind: 'organ-set', key: `organ-set:${read.body.ballId}:${canonicalJson(read.body.organs)}`,
        approval: pearlApprovalKey(read.body.ballId), body: read.body, checkedAt: startedAt, changesAtRead,
        line: `Epoch ${String(read.body.epoch)} · add ${read.body.organs.map(organ => organ.organId).join(', ')} (${short(read.body.ballId)}…)` })
    } else if (read.kind !== 'none') blocked += 1
  }
  if (home === undefined) {
    if (status.pearlStaged) {
      // The same answer carries HEAD's staged record: it is not asked for twice.
      const held = await parseHeadStaged(status.body)
      if (held.kind === 'staged') {
        const state = await headPromotionStateOf(held.record, await context.full())
        // The one exception: the same answer names HEAD's record as published, so nothing waits.
        if (await publishedPearlOf(state, null, held, false, await context.headIfRead()) !== null) return { ready, blocked }
        if (state.kind === 'staged' && state.reasons.length === 0 && state.source === 'head') ready.push(headPearl(state))
        else if (state.kind === 'not-class-3' && held.record.organSet != null) await organSet()
        else blocked += 1
      } else blocked += 1
    }
    return { ready, blocked }
  }
  let held = await parseHeadStaged(status.body)
  // HEAD SAID IT HOLDS ONE, AND IT WAS NOT READ: waiting, not approvable here. A Pearl only her file holds is offered only
  // where HEAD answered its promotion route (held or none): that route is the edge's alone, and on the Mac Sovereignty
  // shows the Pearl with the reason the Mac cannot land it.
  if (held.kind === 'unread' || held.kind === 'absent') return { ready, blocked: blocked + (status.pearlStaged ? 1 : 0) }
  // Her staged file, read as Sovereignty reads it.
  const file = await readHomePromotion(home.reader, home.sessionId, signal)
  // HER FILE LEFT OVER FROM A LANDING (her worker never removes it): HEAD's lease answer names her Pearl as HEAD's own, so it
  // is on HEAD, as Sovereignty says it, and the published head is not read for it.
  const leftOver = file.kind === 'staged' && (await context.lease()).head?.ballId === file.staged.ball.ballId
  // THE ONE EXCEPTION NEEDS AN ANSWER NO OLDER THAN HER FILE: the answer above was asked for before
  // her file was read, so it cannot hide her Pearl. Only when it names her Pearl as published (and she is not simply HEAD
  // itself, above) is HEAD asked once more, now; that answer, if it reads, is the one this card merges from. If it does
  // not, nothing is hidden. A file whose manifest does not hash to the id it claims is never that Pearl, so HEAD
  // is not asked again for it.
  let answerAfterHome = false
  if (file.kind === 'staged' && !leftOver && held.publishedBallIds?.includes(file.staged.ball.ballId) === true
    && await canonicalManifestIdMatches(file.staged.body.ball)) {
    const again = await readPromotionAnswer(signal, fetchImpl)
    const heldAgain = again.pearlStaged === null ? null : await parseHeadStaged(again.body)
    if (heldAgain !== null && (heldAgain.kind === 'none' || heldAgain.kind === 'staged')) { held = heldAgain; answerAfterHome = true }
  }
  const homeState: PromotionState = file.kind !== 'staged' ? file
    : leftOver ? { kind: 'on-head', ballId: file.staged.ball.ballId } : await promotionStateOf(file.staged, await context.full())
  // THE ONE PEARL SOVEREIGNTY WOULD SHOW, by its own rule: one item, never the same Pearl twice.
  const homeStaged = file.kind === 'staged' ? file.staged : null
  const state = await mergePromotionSources({ state: homeState, staged: homeStaged }, held,
    async record => headPromotionStateOf(record, await context.full()))
  // THE ONE EXCEPTION, by Sovereignty's rule: HEAD's answer, asked for after her file was read, names this Pearl as
  // published, so it is neither offered nor counted.
  // and only while the lease read this round names the head that answer's list starts with.
  if (await publishedPearlOf(state, homeStaged, held, answerAfterHome, await context.headIfRead()) !== null) return { ready, blocked }
  if (state.kind === 'staged' && state.reasons.length === 0) {
    ready.push(state.source === 'head' ? headPearl(state) : { kind: 'home-pearl', key: `home:${state.binding.ballId}`,
      approval: pearlApprovalKey(state.binding.ballId), card: state, checkedAt: startedAt, changesAtRead,
      line: `${pearlLine(state)}${state.edgeEmpty === true ? ' · staged in this window only' : ''}` })
  } else if (state.kind === 'not-class-3' && held.kind === 'staged' && held.record.organSet != null) await organSet()
  else if (waitsInSovereignty(state)) blocked += 1
  return { ready, blocked }
}

/**
 * Read Auma's staged outward request from her home. It does not wait on HEAD's promotion route: the Mac host serves
 * outward requests but not that route.
 * @param home - her home.
 * @param signal - aborts the read.
 * @param now - the clock; the item's check is dated from when this read began.
 * @param changesAtRead - the card's count of live changes to her request file when this read began.
 * @returns the request, if one waits; a file that is not a request counts as waiting in Sovereignty only.
 */
export async function readWaitingOutward(home: WaitingHome, signal: AbortSignal, now: () => number = Date.now, changesAtRead = 0)
  : Promise<WaitingRead> {
  const startedAt = now()
  const read = await readStagedOutward(home.reader, home.sessionId, signal)
  if (read.kind === 'malformed') return { ready: [], blocked: 1 }
  // A request this browser sent, or may have, is not offered again while its record holds: a GitHub post has no
  // idempotency key.
  if (read.kind === 'none' || wasSent(read.staged.canonical)) return { ready: [], blocked: 0 }
  const key = outwardApprovalKey(read.staged.canonical)
  return { ready: [{ kind: 'outward', key, approval: key, line: outwardWords(read.staged).summary, staged: read.staged,
    checkedAt: startedAt, changesAtRead }], blocked: 0 }
}

/**
 * Whether a re-read item is the one the card showed: the same key, and where the page sends bytes, the same bytes.
 * @param again - the item as read again.
 * @param shown - the item the card showed.
 * @returns true when the passkey may be asked for what the card showed.
 */
function sameItem(again: Waiting, shown: Waiting): boolean {
  if (again.key !== shown.key || again.kind !== shown.kind) return false
  // Her staged Pearl: the same bytes but for the writer lease (the page replaces it), and the same terms.
  if (again.kind === 'home-pearl' && shown.kind === 'home-pearl') {
    return sameStagedBody(again.card.staged, shown.card.staged) && canonicalJson(again.card.binding) === canonicalJson(shown.card.binding)
  }
  // Her request: the key is its canonical body; the route must be the same too.
  if (again.kind === 'outward' && shown.kind === 'outward') return again.staged.pathname === shown.staged.pathname
  // An organ set: exactly the same body, or no passkey is asked.
  if (again.kind === 'organ-set' && shown.kind === 'organ-set') return sameOrganSet(again.body, shown.body)
  return true
}

export interface FingerprintWaitingProps {
  readonly openSovereignty: () => void
  /** The page's reader of her files and the Session Sovereignty reads: without both, the card reads HEAD alone. */
  readonly reader?: WorkReader | undefined
  readonly sessionId?: SessionId | undefined
  /** Tests pass their own; the page uses its own fetch and passkey. */
  readonly fetchImpl?: typeof fetch
  readonly ceremony?: Omit<Class3Dependencies, 'signal'>
}

type Line = {
  readonly state: 'working' | 'done' | 'refused' | 'unclear'
  readonly text: string
  readonly key: string
  /** Another card on this page held the approval: said until the card next reads, never kept. */
  readonly lock?: true
}

const cx = (...values: (string | false | null | undefined)[]): string => values.filter(Boolean).join(' ')

/**
 * THE TONE OF AN OUTCOME LINE, by its state: blue while it works, mint when the host said it is done, red when it was
 * refused, gold when there was no clear answer (it may have happened: look before approving again).
 */
const OUTCOME_TONE: Record<Line['state'], Tone> = { working: 'blue', done: 'mint', refused: 'red', unclear: 'gold' }
const outcomeClass = (state: Line['state']): string => cx('ak-quote', `ak-tone-${OUTCOME_TONE[state]}`, css.outcome)

/**
 * THE SCROLL BOX OF ONE VALUE, on the element itself (the edge tests read it there): past 180px it scrolls, and its line
 * breaks are kept. The rest of its look is the stylesheet's.
 */
const VALUE_BOX = { maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' } as const

/**
 * EVERY BYTE THE TAP SENDS, before the button (as Sovereignty's outward card shows them): the posts, the title and the full
 * text, or the action and the commit message, and the request's size. They are the primitives' field table (names left,
 * values right in mono); a long text scrolls in its own box: nothing is cut.
 * @param props - the staged request.
 * @returns the rows.
 */
function OutwardRows({ staged }: { readonly staged: StagedOutward }) {
  return (
    <div data-fingerprint-outward-rows="" className={css.rows}>
      <Lead>{OUTWARD_APPROVES_EXACTLY}</Lead>
      <dl className={cx('ak-fields', css.fields)}>
        {outwardWords(staged).rows.map(([name, value]) => (
          <div key={name} data-fingerprint-outward-row={name} className={css.field}>
            <dt>{name}</dt>
            <dd data-fingerprint-outward-value="" className={css.value} style={VALUE_BOX}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** One approval's outcome; `passkeyIncomplete` when the passkey itself did not complete (Safari may have refused the sheet). */
type Approved = { readonly state: Line['state']; readonly text: string; readonly passkeyIncomplete: boolean }

/** Run one approval for an item whose check is current: the passkey first, then HEAD (or the host, for a request). */
async function approveItem(item: Waiting, deps: Class3Dependencies, fetchImpl: typeof fetch | undefined, onStep: (text: string) => void)
  : Promise<Approved> {
  if (item.kind === 'merge') {
    const outcome = await approveAndMerge(item.proposal, item.terms, deps, fetchImpl)
    const text = mergeOutcomeWords(outcome, item.proposal)
    return { state: outcome.kind === 'merged' ? 'done' : outcome.kind === 'unclear' ? 'unclear' : 'refused', text,
      passkeyIncomplete: passkeyDidNotComplete(text) }
  }
  if (item.kind === 'organ-set') {
    const outcome = await approveOrganSet(item.body, globalThis.location.origin, deps, fetchImpl)
    const text = organSetOutcomeWords(outcome, item.body.epoch)
    return { state: outcome.kind === 'landed' ? 'done' : outcome.kind === 'unclear' ? 'unclear' : 'refused', text,
      passkeyIncomplete: passkeyDidNotComplete(text) }
  }
  if (item.kind === 'outward') {
    const result = await approveAndSendOutward(item.staged, globalThis.location.origin, deps, fetchImpl)
    // Anything that may have gone out is not offered again by this browser while its record holds, here or in Sovereignty:
    // a GitHub post has no idempotency key.
    if (result.kind !== 'refused') markSent(item.staged.canonical)
    return { state: result.kind === 'sent' ? 'done' : result.kind === 'refused' ? 'refused' : 'unclear', text: result.words,
      // Its words say a passkey that did not complete differently from a Pearl's (`Not sent: … (class3:passkey …)`).
      passkeyIncomplete: result.kind === 'refused' && result.sent === null && result.words.includes('(class3:passkey') }
  }
  const approval = await approveClass3(item.card.binding, deps)
  if (!approval.ok) {
    const text = `Not approved: ${approval.reason}`
    return { state: 'refused', text, passkeyIncomplete: passkeyDidNotComplete(text) }
  }
  const land = {
    token: approval.token, signal: deps.signal,
    approvalLeftMs: () => approval.hostRemainingMs - (performance.now() - approval.receivedAt),
    onStep: (step: LandStep) => { onStep(landStepWords(step)) },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  }
  // HEAD's record: HEAD promotes the bytes it holds. Her staged file: the page takes a fresh writer lease and sends her
  // staged bytes (`POST /_head/ball`), exactly as Sovereignty sends the same card.
  const outcome = item.kind === 'pearl' ? await promoteStagedOnHead({ ballId: item.card.binding.ballId, ...land })
    : await landApprovedPromotion({ staged: item.card.staged, ...land })
  const text = promotionOutcomeWords(outcome, item.card.binding)
  return { state: outcome.kind === 'landed' ? 'done' : outcome.kind === 'unclear' ? 'unclear' : 'refused', text,
    passkeyIncomplete: passkeyDidNotComplete(text) }
}

const homeOf = (reader: WorkReader | undefined, sessionId: SessionId | undefined): WaitingHome | undefined =>
  (reader === undefined || sessionId === undefined ? undefined : { reader, sessionId })

export function FingerprintWaiting({ openSovereignty, reader, sessionId, fetchImpl, ceremony }: FingerprintWaitingProps) {
  const [read, setRead] = useState<WaitingRead | null>(null)
  const [outward, setOutward] = useState<WaitingRead | null>(null)
  const [tick, setTick] = useState(0)
  const [outwardTick, setOutwardTick] = useState(0)
  // Hidden by approval key: a Pearl is hidden as a Pearl (`pearl:<ballId>`), whichever source carries it next.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  // The approval running now (or a tap another card's approval refused): shown with its item.
  const [line, setLine] = useState<Line | null>(null)
  // THE LAST APPROVAL'S OUTCOME, its own state: shown above whichever item is current, until × or the next approval starts.
  const [settled, setSettled] = useState<Line | null>(null)
  const busy = useRef(false)
  const [working, setWorking] = useState(false)
  // FRESH MEANS UNCHANGED SINCE THE CHECK (Lane B3): every live change to her staged files, or to HEAD, is counted, and a
  // Pearl or her request is used as it is at the tap only when no change arrived after its read began (she can stage again,
  // and HEAD can take another Pearl to hold, inside FRESH_CHECK_MS).
  const pearlChanges = useRef(0)
  const outwardChanges = useRef(0)
  // The published head, kept across reads: `/_head/ball` is read once per head.
  const publishedHead = useRef<PublishedHeadCache['current']>(null)
  const withHome = reader !== undefined && sessionId !== undefined
  useEffect(() => {
    const controller = new AbortController()
    const changesAtRead = pearlChanges.current
    const home = homeOf(reader, sessionId)
    void readWaitingApprovals(controller.signal, fetchImpl, Date.now, home, changesAtRead, publishedHead).then((next) => {
      // During an approval nothing replaces the item being approved. A read that failed keeps what was shown (the next
      // push or poll reads again); Sovereignty says the failure.
      if (controller.signal.aborted || busy.current) return
      if (next !== null) setRead(next)
      // A tap another card's approval refused is said until the card next reads.
      setLine(prev => (prev?.lock === true ? null : prev))
    })
    return () => { controller.abort() }
  }, [tick, fetchImpl, reader, sessionId])
  // HER OUTWARD REQUEST, read on its own: a change to it reads nothing else, and it never waits on HEAD's answer.
  useEffect(() => {
    const home = homeOf(reader, sessionId)
    if (home === undefined) { setOutward(null); return }
    const controller = new AbortController()
    const changesAtRead = outwardChanges.current
    void readWaitingOutward(home, controller.signal, Date.now, changesAtRead).then((next) => {
      if (controller.signal.aborted || busy.current) return
      setOutward(next)
      setLine(prev => (prev?.lock === true ? null : prev))
    }, () => { /* a read that failed keeps what was shown */ })
    return () => { controller.abort() }
  }, [outwardTick, reader, sessionId])
  useEffect(() => {
    const again = (): void => { setTick(n => n + 1); setOutwardTick(n => n + 1) }
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') again() }, FINGERPRINT_POLL_MS)
    const onVisible = (): void => { if (document.visibilityState === 'visible') again() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [])
  // A REQUEST SENT ELSEWHERE IS NEVER OFFERED HERE: another tab says so through `localStorage`, a card on this page
  // (Sovereignty) says so itself (a `storage` event never fires in the page that wrote it).
  useEffect(() => {
    if (!withHome) return
    const again = (): void => { setOutwardTick(n => n + 1) }
    const onStorage = (event: StorageEvent): void => { if (event.key === SENT_KEY) again() }
    globalThis.addEventListener('storage', onStorage)
    // This card's own send reads again when it settles.
    const off = onSentChange(() => { if (!busy.current) again() })
    return () => { globalThis.removeEventListener('storage', onStorage); off() }
  }, [withHome])
  const reread = useDebounced(() => { setTick(n => n + 1) })
  const rereadOutward = useDebounced(() => { setOutwardTick(n => n + 1) })
  useLiveEvents(true, (event) => {
    if (event.kind === 'head-staged' || event.kind === 'repo-staged' || event.kind === 'repo-merged' || event.kind === 'ball-commit') {
      // A Pearl staged at home is checked against HEAD: a commit there, or a Pearl HEAD takes to hold, makes the check stale.
      if (event.kind === 'ball-commit' || event.kind === 'head-staged') pearlChanges.current += 1
      reread.poke()
      // Her worker adopts a commit from elsewhere a moment later (her staged file with it): while the card offers a Pearl
      // from her home, her home is read again then, so a Pearl that landed elsewhere goes. Otherwise once is enough.
      if (event.kind === 'ball-commit' && withHome && read?.ready.some(entry => entry.kind === 'home-pearl') === true) {
        reread.followUp(COMMIT_FOLLOW_UPS)
      }
      return
    }
    if (event.kind !== 'mirror-updated' || !withHome) return
    if (touches(event.changedPaths, STAGED_PROMOTION_CHANGE)) { pearlChanges.current += 1; reread.poke() }
    if (touches(event.changedPaths, STAGED_OUTWARD_CHANGE)) { outwardChanges.current += 1; rereadOutward.poke() }
  })

  // What HEAD holds (and a Pearl staged at home) first, then her outward request.
  const ready = [...(read?.ready ?? []), ...(outward?.ready ?? [])]
  const blocked = (read?.blocked ?? 0) + (outward?.blocked ?? 0)
  const item = ready.find(entry => !hidden.has(entry.approval)) ?? null
  const approve = useCallback((target: Waiting): void => {
    if (busy.current) return
    // SAFARI: a fresh check is used as it is, so nothing runs before the passkey challenge inside this tap. A check older
    // than FRESH_CHECK_MS, older than an approval another card started for the same item, or (for a Pearl or her request)
    // read before a live change to it arrived, is read again first.
    const unchanged = target.kind === 'merge' ? true
      : target.changesAtRead === (target.kind === 'outward' ? outwardChanges.current : pearlChanges.current)
    const fresh = freshFor(target.approval, target.checkedAt) && unchanged
    // A new tap replaces the last outcome: the card says one thing at a time.
    setSettled(null)
    if (!beginApproval(target.approval)) {
      setLine({ state: 'refused', lock: true, key: target.key,
        text: 'Another card on this page is approving this right now; nothing more was asked.' })
      return
    }
    busy.current = true
    setWorking(true)
    const signal = new AbortController().signal
    const deps = { ...ceremony, signal }
    const home = homeOf(reader, sessionId)
    // The approval's outcome: kept above whichever item is current, until × or the next approval starts.
    const settle = (outcome: Line): void => { setLine(null); setSettled(outcome) }
    const run = async (): Promise<void> => {
      // ONE POST PER REQUEST: checked first, whatever the check's age (this record is local: no request runs).
      if (target.kind === 'outward' && wasSent(target.staged.canonical)) {
        settle({ state: 'refused', text: 'Not sent again: this exact request was already sent from this browser.', key: target.key })
        return
      }
      let current = target
      if (!fresh) {
        setLine({ state: 'working', text: 'Checking again before asking for your passkey…', key: target.key })
        let again: WaitingRead | null = null
        if (target.kind !== 'outward') {
          again = await readWaitingApprovals(signal, fetchImpl, Date.now, home, pearlChanges.current, publishedHead)
          if (again !== null) setRead(again)
        } else if (home !== undefined) {
          again = await readWaitingOutward(home, signal, Date.now, outwardChanges.current)
          setOutward(again)
        }
        const same = again?.ready.find(entry => sameItem(entry, target))
        if (same === undefined) {
          // HER FILE CHANGED: the line says why the card shows another item in its place.
          const instead = target.kind === 'home-pearl' || target.kind === 'outward'
            ? again?.ready.find(entry => entry.kind === target.kind) : undefined
          settle(instead === undefined
            ? { state: 'refused', key: target.key,
              text: 'Checked again just now: it changed or is no longer waiting, so no passkey was asked for.' }
            : { state: 'refused', key: instead.key,
              text: 'Checked again just now: it changed since this card read it, so no passkey was asked for. '
                + 'The card shows what waits now.' })
          return
        }
        current = same
      }
      setLine({ state: 'working', text: 'Waiting for Touch ID…', key: target.key })
      const result = await approveItem(current, deps, fetchImpl, (text) => { setLine({ state: 'working', text, key: target.key }) })
      // After a re-check the tap may have aged past what the browser allows for a passkey sheet: the card's check is
      // current now, so one more tap goes straight to Touch ID.
      const tapAgain = !fresh && result.state === 'refused' && result.passkeyIncomplete
      settle({ state: result.state, key: target.key, text: tapAgain ? TAP_AGAIN : result.text })
    }
    void run().catch((error: unknown) => {
      const why = error instanceof Error ? error.message : String(error)
      if (target.kind !== 'outward') {
        settle({ state: 'unclear', key: target.key, text: `No clear answer (${why}). Check Sovereignty.` })
        return
      }
      // Whatever failed, the passkey may already have approved and the post may have gone out: not offered again here.
      markSent(target.staged.canonical)
      settle({ state: 'unclear', key: target.key,
        text: `No clear answer (${why}). It may have gone out: check GitHub before approving it again.` })
    }).finally(() => {
      endApproval(target.approval)
      busy.current = false
      setWorking(false)
      setTick(n => n + 1)
      setOutwardTick(n => n + 1)
    })
  }, [ceremony, fetchImpl, reader, sessionId])

  // The approval running now goes with its item; the last outcome (`settled`) shows whatever item is current.
  const shownLine = line !== null && (item === null || line.key === item.key) ? line : null
  // Waiting, but not approvable from here as it stands (checks in the way): said, with the way to Sovereignty.
  const onlyInSovereignty = item === null && blocked > 0 && !hidden.has('blocked')
  if (item === null && shownLine === null && settled === null && !onlyInSovereignty) return null
  return (
    <aside
      data-fingerprint-waiting={item?.kind ?? 'outcome'}
      aria-label="Fingerprint waiting"
      className={cx('ak-portal', 'ak-tone-gold', css.card)}
    >
      <div className={css.head}>
        <IconTile icon="approvals" />
        <strong className={css.eyebrow}>FINGERPRINT WAITING</strong>
        {/* One Pearl is one item, whichever sources hold it: it is never counted twice. */}
        {ready.length + blocked > 1 ? (
          <span data-fingerprint-count="" className={css.count}>
            <span aria-hidden="true" className={css.sep}>·</span>{' '}
            <StatusPill tone="gold">{`${String(ready.length + blocked)} waiting`}</StatusPill>
          </span>
        ) : null}
        {working ? null : (
          <button type="button" aria-label="Hide for now" data-fingerprint-dismiss="" className={css.dismiss}
            onClick={() => {
              setLine(null)
              setSettled(null)
              // An outcome about another item, or one no longer waiting, just closes: the item under it stays.
              if (settled !== null && settled.key !== item?.key) return
              // The item (or the "only in Sovereignty" note) hides for this page; an outcome line alone just closes.
              if (item !== null || onlyInSovereignty) setHidden(prev => new Set([...prev, item?.approval ?? 'blocked']))
            }}>
            ×
          </button>
        )}
      </div>
      {settled === null ? null : (
        <div role="status" data-fingerprint-outcome={settled.state} data-fingerprint-settled="" className={outcomeClass(settled.state)}>
          {settled.text}
        </div>
      )}
      {item !== null ? <div data-fingerprint-line="" className={css.line}>{item.line}</div>
        : onlyInSovereignty ? (
          <div data-fingerprint-line="" className={css.line}>
            Something waits for your passkey that cannot be approved from here as it stands: Sovereignty shows why.
          </div>
        ) : null}
      {item?.kind === 'outward' ? <OutwardRows staged={item.staged} /> : null}
      {item?.kind === 'organ-set' ? (
        <div data-fingerprint-organ-set-rows="" className={css.rows}>
          <Lead>One Touch ID adds exactly these organs, as ordinary organs, and nothing else:</Lead>
          <dl className={cx('ak-fields', css.fields)}>
            {item.body.organs.map(organ => (
              <div key={organ.organId} data-fingerprint-organ={organ.organId} className={css.field}>
                <dt>{organ.organId}</dt>
                <dd className={css.value} style={VALUE_BOX}>{`module ${organ.sha256} · ${String(organ.bytes)} bytes`}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      <div className={cx('ak-actionrow', css.actions)}>
        {/* THE ONE GOLD BUTTON, first: the approval. Inspect is the quiet one beside it. */}
        {item === null ? null : (
          <button type="button" data-fingerprint-approve="" disabled={working} onClick={() => { approve(item) }}
            className={cx('ak-action', css.primary)}>
            {item.kind === 'outward' ? 'Approve with Touch ID and Send' : 'Approve with Touch ID'}
          </button>
        )}
        <button type="button" data-fingerprint-inspect="" onClick={openSovereignty} className={cx('ak-action', css.secondary)}>
          Inspect in Sovereignty
        </button>
      </div>
      {shownLine === null ? null
        : <div role="status" data-fingerprint-outcome={shownLine.state} className={outcomeClass(shownLine.state)}>{shownLine.text}</div>}
    </aside>
  )
}
