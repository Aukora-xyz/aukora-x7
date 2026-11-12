// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * A STAGED GOVERNANCE PEARL HAS TWO SOURCES, AND EVERY CARD MERGES THEM BY ONE RULE (Wave 3, Lane B3): her staged file in
 * this window's copy of her home, and the record HEAD holds itself (`GET /_head/promotion-status`). Sovereignty's card and
 * the chat's "Fingerprint waiting" card both read and merge through this module, so the two never show different Pearls,
 * never offer one twice, and never send it by different routes.
 *
 *   promotionContextOf     what the classification reads besides the Pearl: the published head, HEAD's lease answer
 *   readHomePromotion      her staged file, read strictly (size ceiling first, then parse)
 *   mergePromotionSources  the one Pearl a card shows: her file's card when it is the same Pearl and ready (the page
 *                          sends those bytes, `POST /_head/ball`), else HEAD's (HEAD promotes what it holds,
 *                          `POST /_head/promote`); a Pearl only her file holds, while HEAD answered it holds none, is
 *                          marked `edgeEmpty`
 *   publishedPearlOf       the one exception: the Pearl that same HEAD answer names as published is not waiting (only
 *                          while the lease read in the same round names the head that list starts with)
 *
 * It has no React in it: the types it names are only types (`SovereigntySurface.tsx` owns the card's states).
 * @module portal/promotion-sources
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  canonicalManifestIdMatches, parseStagedPromotion, STAGED_PROMOTION_MAX_BYTES, STAGED_PROMOTION_PATH, stagedPromotionTooLarge,
  type HeadLeaseRead, type HeadStagedRead, type HeadStagedRecord, type StagedPromotion,
} from '../aumlok/head-promotion.ts'
import type { WorkReader } from '../work/WorkSurface.tsx'
import type { PromotionContext, PromotionState, PublishedHead } from './SovereigntySurface.tsx'

/**
 * The classification's context, from the published head as read and HEAD's lease answer. A published id or epoch that is
 * not in HEAD's form is null, never guessed.
 * @param input - the published head (null when it was not read), HEAD's lease answer, the runtime, this origin, the clock.
 * @returns the context.
 */
export function promotionContextOf(input: {
  readonly published: Pick<PublishedHead, 'entries' | 'ballId' | 'epoch'> | null
  readonly lease: HeadLeaseRead
  readonly runtime: PromotionContext['runtime']
  readonly audience: string
  readonly now: number
}): PromotionContext {
  const { published, lease } = input
  return {
    published: {
      entries: published === null ? null : published.entries,
      ballId: published !== null && /^[0-9a-f]{64}$/u.test(published.ballId) ? published.ballId : null,
      epoch: published !== null && /^\d+$/u.test(published.epoch) ? Number(published.epoch) : null,
    },
    freshHead: lease.head, leaseUnread: lease.unread, requirements: lease.requirements,
    lease: lease.lease,
    canQualify: lease.canQualify, qualifyBlocker: lease.qualifyBlocker, runtime: input.runtime, audience: input.audience,
    now: input.now,
  }
}

/** Her staged file, as one window read it: a card state when there is no Pearl to classify, else the Pearl. */
export type HomePromotionRead =
  | Extract<PromotionState, { kind: 'unreadable' | 'absent' | 'malformed' }>
  | { readonly kind: 'staged'; readonly staged: StagedPromotion }

/**
 * Read her staged governance Pearl from this window's copy of her home. A file that is not there is `absent`; any other
 * failure to read is `unreadable` (nothing is said about what is staged); a file over the ceiling, or not a staged
 * promotion, is `malformed`.
 * @param reader - the page's reader of her files.
 * @param sessionId - the Session whose home is read (undefined: none is open).
 * @param signal - aborts the read.
 * @returns what the file holds.
 */
export async function readHomePromotion(reader: WorkReader, sessionId: SessionId | undefined, signal: AbortSignal)
  : Promise<HomePromotionRead> {
  if (sessionId === undefined) return { kind: 'unreadable', why: 'no session is open to read her home' }
  const file = await reader.whole(sessionId, STAGED_PROMOTION_PATH, signal).catch(() => null)
  if (file === null || (!file.ok && file.reason !== 'not-found')) {
    return { kind: 'unreadable', why: `her home could not be read (${file === null ? 'no answer' : file.reason})` }
  }
  if (!file.ok) return { kind: 'absent' }
  if (stagedPromotionTooLarge(file.text)) {
    return { kind: 'malformed', why: `larger than ${String(STAGED_PROMOTION_MAX_BYTES / 1024 / 1024)} MiB, the most her worker stages` }
  }
  const staged = parseStagedPromotion(file.text)
  return staged === null ? { kind: 'malformed' } : { kind: 'staged', staged }
}

/**
 * THE ONE PEARL A CARD SHOWS, from her file's card and what HEAD answered it holds.
 *
 *   HEAD holds none          her file's card, marked `edgeEmpty` when it is a Pearl (only this window shows it)
 *   HEAD not read            her file's card; with nothing of its own to show, `head-unread` (never "nothing staged")
 *   HEAD holds one           the same Pearl in her file, ready: her file's card (the page sends it), HEAD's record beside
 *                            it; the same Pearl with something in her file's way: HEAD's card when HEAD's copy is ready,
 *                            else her file's card with HEAD's record beside it; otherwise HEAD's card, and a different
 *                            Pearl in her file is named beside it (`otherInHome`), never offered
 * @param home - her file's card state, and the Pearl her file holds (null when none was read).
 * @param held - what HEAD answered it holds (`absent` when it was not asked).
 * @param classifyHeld - classifies HEAD's record (`headPromotionStateOf` against the same context).
 * @returns the card's state.
 */
export async function mergePromotionSources(
  home: { readonly state: PromotionState; readonly staged: StagedPromotion | null },
  held: HeadStagedRead,
  classifyHeld: (record: HeadStagedRecord) => Promise<PromotionState>,
): Promise<PromotionState> {
  if (held.kind !== 'staged') {
    if (home.state.kind === 'staged' && held.kind === 'none') return { ...home.state, edgeEmpty: true }
    // HEAD's record was asked for and not read, and this window has nothing of its own to show: said, never hidden.
    // (Her file left over from a landing, or one that needs no passkey, draws no card either.)
    const nothingHere = home.state.kind === 'absent' || home.state.kind === 'on-head' || home.state.kind === 'not-class-3'
      || (home.state.kind === 'unreadable' && home.state.staged !== true)
    return held.kind === 'unread' && nothingHere ? { kind: 'head-unread', why: held.why,
      ...(home.state.kind === 'unreadable' ? { homeWhy: home.state.why } : {}) } : home.state
  }
  const record = held.record
  const sameAtHome = home.state.kind === 'staged' && home.state.staged.ball.ballId === record.ballId ? home.state : null
  // The same Pearl in both places and her file's copy is ready: her file's card (the page sends it, as since Round 24),
  // with HEAD's record beside it.
  if (sameAtHome !== null && sameAtHome.reasons.length === 0) return { ...sameAtHome, onHead: record }
  const other = home.staged !== null && home.staged.ball.ballId !== record.ballId
    ? { otherInHome: { ballId: home.staged.ball.ballId, epoch: home.staged.ball.epoch } } : {}
  const state = await classifyHeld(record)
  // Her file's copy has something in its way that HEAD's copy has not (a fault of the file alone): HEAD's is offered.
  if (sameAtHome !== null && !(state.kind === 'staged' && state.reasons.length === 0)) return { ...sameAtHome, onHead: record }
  // the Pearl HEAD's answer still held is already on HEAD (that answer is older than HEAD's landing):
  // it draws nothing, so it never stands in for a DIFFERENT Pearl in her file. Her file's card is shown, as read.
  if (state.kind === 'on-head' && home.staged !== null && home.staged.ball.ballId !== record.ballId) return home.state
  return state.kind === 'staged' || state.kind === 'head-blocked' ? { ...state, ...other } : state
}

/**
 * THE ONE EXCEPTION TO SHOWING A STAGED PEARL: the Pearl a merged card is about, when HEAD's own
 * promotion-status answer, the SAME answer the card was merged from, names it as published (HEAD or one of its 8
 * ancestors). A Pearl from her file counts only when that answer was asked for after her file was read: an answer older
 * than the card's source hides nothing. No answer, a failed one, or one without the list hides nothing either.
 * A Pearl from her file is only the published one when its manifest really is that Pearl: the id
 * recomputed from its manifest (`canonicalManifestIdMatches`) must be the id it claims. A file that keeps a published
 * id over other entries or code hides nothing: main's card, counted, with its canonical-id reason. HEAD's own record
 * is held to the same rule: the staged bytes HEAD serves beside it must hash to its id; no bytes, no hiding.
 * THE LIST MUST STILL BE HEAD'S: the list is HEAD's chain at the moment of that answer, and HEAD may have moved
 * (a rollback) before the classification's own lease read. A Pearl is hidden only when that lease read, in the same
 * round, names the same head the list starts with; when the two disagree, or the lease was not read, nothing is hidden.
 * @param state - the merged card (`mergePromotionSources`).
 * @param homeStaged - the Pearl her file held (null when none was read).
 * @param held - HEAD's answer the card was merged from.
 * @param answerAfterHome - whether that answer was asked for after her file was read.
 * @param leaseHead - HEAD's selected Pearl as the classification's lease read named it this round (null: not read, or none).
 * @returns the published Pearl the card is about, or null (nothing is hidden).
 */
export async function publishedPearlOf(state: PromotionState, homeStaged: StagedPromotion | null, held: HeadStagedRead,
  answerAfterHome: boolean, leaseHead: { readonly ballId: string } | null)
  : Promise<{ readonly ballId: string; readonly epoch: number } | null> {
  if ((held.kind !== 'none' && held.kind !== 'staged') || held.publishedBallIds === undefined) return null
  // The lease read and the answer's list must name the same head: a list HEAD has since rolled back below hides nothing.
  if (leaseHead?.ballId === undefined || held.publishedBallIds[0] !== leaseHead.ballId) return null
  const record = held.kind === 'staged' ? { ballId: held.record.ballId, epoch: held.record.epoch } : null
  const fromHome = homeStaged === null ? null : { ballId: homeStaged.ball.ballId, epoch: homeStaged.ball.epoch }
  const named = (ballId: string) => (record?.ballId === ballId ? record : fromHome?.ballId === ballId ? fromHome : null)
  const pearl = state.kind === 'staged' ? named(state.staged.ball.ballId)
    : state.kind === 'head-blocked' ? named(state.record.ballId)
      : state.kind === 'on-head' ? named(state.ballId)
        : state.kind === 'unreadable' && state.staged === true ? (state.source === 'head' ? record : fromHome)
          // HEAD's own several-organ record is drawn as head-blocked: a 'several' card is her file's.
          : state.kind === 'several' ? fromHome : null
  if (pearl === null || !held.publishedBallIds.includes(pearl.ballId)) return null
  // Her file's Pearl needs an answer no older than her file (HEAD's own record is in that answer itself).
  if (pearl !== record && !answerAfterHome) return null
  // Whenever her file claims this id, her manifest must hash to it: a file that kept a published id over other entries
  // or code is not that Pearl, and hides nothing (even beside HEAD's own record of the real one).
  if (homeStaged !== null && homeStaged.ball.ballId === pearl.ballId && !await canonicalManifestIdMatches(homeStaged.body.ball)) return null
  // HEAD's own record of this id is that Pearl only when the staged bytes HEAD serves beside it hash to it.
  if (held.kind === 'staged' && held.record.ballId === pearl.ballId) {
    const served = held.record.promotion
    if (served?.ball.ballId !== pearl.ballId || !await canonicalManifestIdMatches(served.body.ball)) return null
  }
  return pearl
}
