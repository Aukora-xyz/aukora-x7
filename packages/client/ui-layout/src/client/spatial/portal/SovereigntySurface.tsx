// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * SOVEREIGNTY: what governs this node, read from the node's own routes, live only.
 *
 *   header          which host serves this page (GET /__x6/status, and /api/health on the edge), and the edge sign-in
 *   Durability      one strip under the header: live HEAD, passkey, receipts and checkpoints, R2 cold backup and the edge's
 *                   stamped source revision, projected from the reads below (durability.ts); no read or polling of its own
 *   Keys and trust  the bound passkey, who signs her checkpoints and how far that key is anchored, the pepper
 *                   (sovereignty-cards.ts)
 *   Receipt chain   her own seed_receipts verify beside the host's re-verification (GET /__x6/facts)
 *   Published Pearl GET /_head/ball (and the release the Mac serves, GET /_head/runtime, where it answers), the
 *                   whole live mirror as one download (GET /api/snapshot), and the portable recovery snapshot: the
 *                   Pearl, the host's facts, its estate and the mirror in one JSON file (recovery-snapshot.ts)
 *   Wake            the host's wake timer and the host's scheduled tasks, with one click that pauses every wake
 *   Repo proposal   shown only while Auma has staged a branch to merge into main: merged on one Touch ID
 *   Staged Pearl    shown only while a governance Pearl is staged: approved by passkey and sent to HEAD. Two sources:
 *                   her staged file in this window's copy of her home, and the record HEAD holds itself
 *                   (GET /_head/promotion-status), which every signed-in owner window reads; a `head:staged` push on the
 *                   head socket reads it again. HEAD's record is promoted by HEAD (POST /_head/promote). Its closed "View
 *                   code diff" row compares the organ's code now with the staged code, both hash-checked (CodeDiffRow.tsx)
 *
 * A card shows what a source said; a source that says nothing shows nothing, and a state that is live and bad shows
 * first. It reads, and changes two things: it lands a staged governance Pearl on the bound passkey's approval of its
 * exact terms (HEAD checks the rest), and it pauses every wake, or resumes one after a second click.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { readAumlokStatus, type AumlokHostRead } from '../aumlok/aumlok-ceremony.ts'
import { approveClass3, canonicalJson } from '../aumlok/class3-approval.ts'
import {
  canonicalManifestIdMatches, classifyHeadTransition, describeGovernanceChange, headPromotionBinding, headRecordProblems,
  landApprovedPromotion, manifestProblem,
  moduleBytes, parseStagedPromotion, promoteStagedOnHead, promotionReadiness, readHeadLease, readHeadStaged, sameStagedBody,
  STAGED_PROMOTION_CHANGE, STAGED_PROMOTION_PATH, stagedPromotionTooLarge, stageOnHead, writerLeaseWords,
  type HeadEntry, type HeadLease, type HeadPromotionBinding, type HeadStagedRead, type HeadStagedRecord, type LandStep, type NotSentWhy,
  type PromotionOutcome, type PromotionRequirements, type StagedPromotion,
} from '../aumlok/head-promotion.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  AppHeader, AppSurface, FieldTable, Lead, PortalButton, PortalCell, PortalGrid, RecordList, RecordRow, SectionLabel, StatTiles, StatusPill,
} from '../primitives/index.ts'
import { workBridge, type BridgePhase, type BridgeReceipts } from '../work/bridge.ts'
import { sessionOf, tabFactsOf, type WorkReader } from '../work/WorkSurface.tsx'
import type { HeadView } from '../work/work-model.ts'
import { EdgeOwnerSignIn, hostModeWords, useHostMode } from '../../spatial-components.tsx'
import { parseCheckpointPolicy, type KeyTableRead, type ScheduleDoor } from './sovereignty-panels.ts'
import { chainCardOf, keysCardOf, ownerAuthorityOf, type CardView } from './sovereignty-cards.ts'
import { durabilityNotesOf, durabilityTilesOf, englishDurability, type EdgeBodyRead } from './durability.ts'
import { EstateCell } from './EstateCell.tsx'
import { promotionReceiptsOf, promotionRowsOf, promotionWords, RECEIPTS_PATH, type PromotionRow } from './promotion-receipts.ts'
import { captureRecoverySnapshot, recoveryStateOf, recoveryWords, type RecoveryState } from './recovery-snapshot.ts'
import { WakeCell } from './WakeCell.tsx'
import { NightGrantCell } from './NightGrantCell.tsx'
import { OrganSetCell } from './OrganSetCell.tsx'
import { CHECKPOINTS_PATH, chainVerdictOf, chainVerdictWords, type ChainVerdict } from './receipt-chain-verdict.ts'
import { OutwardApprovalCell } from './OutwardApprovalCell.tsx'
import { RepoProposalCell } from './RepoProposalCell.tsx'
import { CodeDiffRow } from './CodeDiffRow.tsx'
import { beginApproval, endApproval, freshFor, passkeyDidNotComplete, pearlApprovalKey, TAP_AGAIN } from './touch-id-timing.ts'
import {
  mergePromotionSources, promotionContextOf, publishedPearlOf, readHomePromotion, type HomePromotionRead,
} from './promotion-sources.ts'
import { compareTabToHost, useHostFacts } from '../work/host-facts.ts'
import { COMMIT_FOLLOW_UPS, useDebounced, useLiveEvents } from '../work/autonomy.ts'

// Kept where earlier callers import them from: the passkey card's words now live in sovereignty-cards.ts.
export { approvalsWords, ownerAuthorityOf, type OwnerAuthority } from './sovereignty-cards.ts'

export const SOVEREIGNTY_SURFACE = 'sovereignty'
/** The Continuity screen: the same reads, drawn as what keeps her alive and where (Wave 5 split). */
export const CONTINUITY_SURFACE = 'continuity'

/**
 * The tab's own selected head from the same one-shot read as its receipt verify (`snapshot.head`, read from her
 * /dsh/home/balls/HEAD.json). Not `/_head/ball`: that is the host's head, and comparing it with the host is no check.
 */
export function readHeadOf(phase: BridgePhase | null): HeadView | null {
  if (phase === null || (phase.kind !== 'snapshot' && phase.kind !== 'stale-snapshot')) return null
  const head = (phase.snapshot as { head?: unknown }).head
  if (head === null || typeof head !== 'object' || Array.isArray(head)) return null
  const h = head as Record<string, unknown>
  if (h.kind !== 'summary' || typeof h.ballId !== 'string' || !/^[0-9a-f]{64}$/.test(h.ballId)
    || typeof h.epoch !== 'number' || !Number.isSafeInteger(h.epoch) || h.epoch < 0) return null
  return { ballId: h.ballId, epoch: h.epoch, parentBallId: typeof h.parentBallId === 'string' ? h.parentBallId : null }
}

export interface SovereigntySurfaceInjected {
  /**
   * Which screen this is. `sovereignty` (the default) holds what waits for Touch ID, the keys and the receipt chain;
   * `continuity` holds the durability strip, the published Pearl, the wake schedule and the host's estate.
   */
  readonly view?: 'sovereignty' | 'continuity'
  readonly reader: WorkReader
  /** The host's schedule service, once the Remote provides it (Round 24 wake card). */
  readonly schedules?: ScheduleDoor
}

type Answer<T> = { kind: 'idle' } | { kind: 'ok'; value: T } | { kind: 'failed'; reason: string }

const obj = (v: unknown): Record<string, unknown> | null =>
  (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const word = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '—')

/** The facts `/_head/ball` answers, and the module sources it also carries (kept for the staged card's code diff). */
export interface PublishedHead {
  readonly buildSha: string
  readonly epoch: string
  readonly ballId: string
  readonly parentBallId: string
  readonly modules: number
  readonly peers: number
  /** The published manifest's entries (null when the answer has none), for HEAD's own Class 3 rule. */
  readonly entries: Readonly<Record<string, HeadEntry>> | null
  /**
   * The module code the answer carries, by sha (`codeBySha`, else `modules`; strings under 64-hex keys only), for the staged
   * card's code diff (Lane B3). NOT CHECKED HERE: the Mac host serves its mirror's files unchecked, so a module is
   * hash-checked where it is shown. Null when the answer carries none.
   */
  readonly codeBySha: Readonly<Record<string, string>> | null
}

/** The code by sha an answer carries: only string values under 64-hex keys (so no key is ever a prototype's). */
const codeByShaOf = (store: Record<string, unknown> | null): Readonly<Record<string, string>> | null => (store === null ? null
  : Object.fromEntries(Object.entries(store).filter((pair): pair is [string, string] => /^[0-9a-f]{64}$/u.test(pair[0])
    && typeof pair[1] === 'string')))

/** @returns the published head's facts, or null when the body is not the host's head answer. */
export function parsePublishedHead(body: unknown): PublishedHead | null {
  const root = obj(body)
  const head = obj(root?.head)
  if (root === null || head === null) return null
  return {
    buildSha: word(root.buildSha),
    epoch: word(head.epoch),
    ballId: word(head.ballId),
    parentBallId: word(head.parentBallId),
    modules: Object.keys(obj(root.modules) ?? {}).length,
    peers: Array.isArray(root.peers) ? root.peers.length : 0,
    entries: obj(head.entries) as Readonly<Record<string, HeadEntry>> | null,
    codeBySha: codeByShaOf(obj(root.codeBySha) ?? obj(root.modules)),
  }
}

/** The facts `/_head/runtime` answers. */
export interface RuntimeRelease {
  readonly epoch: string
  readonly releaseId: string
  readonly latestCaptured: string
  readonly candidates: number
  readonly selectionError: string
}

/** @returns the runtime selection's facts, or null when the body is not the host's runtime answer. */
export function parseRuntimeRelease(body: unknown): RuntimeRelease | null {
  const root = obj(body)
  if (root === null) return null
  const selected = obj(root.selected)
  const latest = root.latestCapturedRelease
  return {
    epoch: word(selected?.epoch),
    releaseId: word(selected?.releaseId),
    latestCaptured: typeof latest === 'string' ? latest : word(obj(latest)?.releaseId),
    candidates: Array.isArray(root.candidates) ? root.candidates.length : 0,
    selectionError: root.selectionError === null || root.selectionError === undefined ? 'none' : word(root.selectionError),
  }
}

async function getJson<T>(path: string, parse: (body: unknown) => T | null, signal: AbortSignal): Promise<Answer<T>> {
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal })
    if (!response.ok) return { kind: 'failed', reason: `answered ${String(response.status)}` }
    const value = parse(await response.json())
    return value === null ? { kind: 'failed', reason: 'not the expected answer' } : { kind: 'ok', value }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

const short = (s: string): string => (s.length > 16 ? s.slice(0, 12) : s)

/**
 * The whole live mirror, as the page itself hydrates from it. BOTH HOSTS SERVE THIS ROUTE, so this button asks it. The edge
 * also forwards `GET /_mirror/export` to this same v2 snapshot (deploy/cloudflare/src/worker.mjs); the Mac host
 * (server/local-host.mjs) has no `/_mirror/export`.
 */
export const SNAPSHOT_ROUTE = '/api/snapshot?snapshotFormat=x61-mirror-snapshot%2Fv2'
export type SnapshotState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'handed'; readonly name: string; readonly bytes: number }
  | { readonly kind: 'failed'; readonly reason: string }
/**
 * The download's file name: `aukora-mirror-epoch-<N>.json`, N the published Pearl's epoch when it was read.
 * @param epoch - the epoch as the Pearl record gives it, or null.
 * @returns the name (digits only in N, else "unknown").
 */
export function snapshotFileName(epoch: string | number | null): string {
  const text = epoch === null ? '' : String(epoch)
  return `aukora-mirror-epoch-${/^\d{1,12}$/.test(text) ? text : 'unknown'}.json`
}
/**
 * What the snapshot card says.
 * @param state - the download's state.
 * @returns one line.
 */
export function snapshotWords(state: SnapshotState): string {
  switch (state.kind) {
    case 'idle': return 'Download her whole live mirror as one JSON file'
    case 'reading': return 'Reading the mirror from this host…'
    case 'handed': return `Handed ${state.name} (${(state.bytes / 1_048_576).toFixed(1)} MB) to this browser’s download; `
      + 'this page cannot see whether it was saved'
    case 'failed': return `Not saved: ${state.reason}`
  }
}
/**
 * Read the snapshot as this host serves it. Only a JSON answer counts: a host that answers HTML (an app shell) or a
 * refusal saves nothing.
 * @param signal - aborts the read.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @returns the body as a blob, or why not.
 */
export async function fetchMirrorSnapshot(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch)
  : Promise<{ readonly kind: 'ok'; readonly blob: Blob } | { readonly kind: 'failed'; readonly reason: string }> {
  try {
    const response = await fetchImpl(SNAPSHOT_ROUTE, { credentials: 'same-origin', cache: 'no-store', signal })
    if (!response.ok) return { kind: 'failed', reason: `the host answered ${String(response.status)}` }
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) return { kind: 'failed', reason: 'the host did not answer JSON' }
    return { kind: 'ok', blob: await response.blob() }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
/**
 * Hand a blob to the browser's own download (an anchor with `download`). The page opens no window of its own; a browser
 * set to ask where to save shows its own save sheet. The URL lives a minute, so a save sheet left open can still read it.
 */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => { URL.revokeObjectURL(url) }, 60_000)
}

/** The staged governance Pearl card's state. */
export type PromotionState =
  | { readonly kind: 'reading' }
  /** No staged file: the reader said it is not there. */
  | { readonly kind: 'absent' }
  /**
   * Her home could not be read (nothing is said about what is staged), or a staged Pearl was read but the published head
   * could not be (`staged`: a Pearl is waiting, not checked).
   */
  | { readonly kind: 'unreadable'; readonly why: string; readonly staged?: true; readonly source?: 'head' }
  /**
   * HEAD's own promotion route did not answer in a form this page reads, and this window has no staged file to show:
   * whether HEAD holds a Pearl for the owner is NOT KNOWN (never drawn as "nothing staged").
   */
  | { readonly kind: 'head-unread'; readonly why: string; readonly homeWhy?: string }
  | { readonly kind: 'malformed'; readonly why?: string }
  /** The staged Pearl is the published one: it has landed. */
  | { readonly kind: 'on-head'; readonly ballId: string }
  | { readonly kind: 'not-class-3' }
  | { readonly kind: 'several'; readonly entryIds: readonly string[] }
  | {
    readonly kind: 'staged'
    readonly staged: StagedPromotion
    readonly binding: HeadPromotionBinding
    /** The governance change in words. */
    readonly change: readonly string[]
    /** Other (non-governance) entries the staged manifest also changes. */
    readonly others: readonly string[]
    readonly bytes: 'verified' | 'mismatch' | 'absent' | 'not-code'
    /** Whether the organ's code itself changes (a disable or a config change keeps it). */
    readonly codeChanged: boolean
    /** The changed governance entry's id, as both manifests key it (Lane B3: the code diff reads the organ by it). */
    readonly entryId: string
    /** Whether the Pearl adds the organ, removes it, or changes it. */
    readonly organChange: 'added' | 'removed' | 'changed'
    /** The module the published head runs for it (the sha of its `ball:<sha>`); null when it is new or not a module. */
    readonly incumbentSha: string | null
    /**
     * The module the staged Pearl runs for it: the approval's own sha, so a diff shows exactly the bytes Touch ID approves;
     * null when it is removed or not a module.
     */
    readonly candidateSha: string | null
    /**
     * Every reason this page can see that HEAD would refuse it, or that it cannot check (HEAD's lease answer not read);
     * empty when nothing it can check stands in the way.
     */
    readonly reasons: readonly string[]
    /** HEAD's writer lease as read with this check (not a reason: the page takes a fresh one after Touch ID). */
    readonly lease: HeadLease | null
    readonly checkedAt: number
    /** Why that lease answer was not read (null when it was). */
    readonly leaseUnread: string | null
    /**
     * 'head' when the card was built from the record HEAD holds itself (Wave 3): the approved Pearl is then promoted by
     * HEAD from its own stored bytes (`POST /_head/promote`). Absent: built from her staged file, sent by this page.
     */
    readonly source?: 'head'
    /** HEAD's own record of this same Pearl, when HEAD holds one. */
    readonly onHead?: HeadStagedRecord
    /**
     * HEAD answered that it holds NO candidate, while her staged file is in this window: only this window shows the card,
     * until the Pearl is handed to HEAD to hold (the card's own button, `POST /_head/stage`).
     */
    readonly edgeEmpty?: true
    /** Her home in this window holds a DIFFERENT staged Pearl than the one HEAD holds (shown, never offered). */
    readonly otherInHome?: { readonly ballId: string; readonly epoch: number }
  }
  /**
   * HEAD holds a staged Pearl that a passkey cannot approve as staged (it changes no governance organ, or several, or its
   * bytes were not served): shown with HEAD's own reasons, never offered.
   */
  | {
    readonly kind: 'head-blocked'
    readonly record: HeadStagedRecord
    readonly why: string
    readonly otherInHome?: { readonly ballId: string; readonly epoch: number }
  }

/** The staged Pearl HEAD's own answer named as published, with the card state it was merged into. */
interface PublishedFor { readonly state: PromotionState; readonly ballId: string; readonly epoch: number }
/** Her staged file's card, and the Pearl it held. */
interface HomeCard { readonly state: PromotionState; readonly staged: StagedPromotion | null }

/** What the promotion card reads besides the staged file. */
export interface PromotionContext {
  readonly published: {
    readonly entries: Readonly<Record<string, HeadEntry>> | null
    readonly ballId: string | null
    readonly epoch: number | null
  }
  readonly lease: HeadLease | null
  /** Whether HEAD says it can qualify a governance Pearl. */
  readonly canQualify: boolean
  /** HEAD's own word on why not (`governancePromotionBlocker`), when it gives one. */
  readonly qualifyBlocker?: string | null
  readonly runtime: 'local' | 'cloudflare' | 'other'
  readonly audience: string
  readonly now: number
  /**
   * HEAD's selected Pearl as its lease answer named it just now (fresher than `published`, which carries the entries the
   * change is classified against). Never mixed into `published`: a difference is a reason of its own.
   */
  readonly freshHead?: { readonly ballId: string; readonly epoch: number } | null
  /** Why HEAD's lease answer was not read just now (null when it was). */
  readonly leaseUnread?: string | null
  /** What HEAD's lease answer says a governance Pearl must be to land (Round 29), when it says. */
  readonly requirements?: PromotionRequirements | null
}

/**
 * What the staged file asks HEAD for, by HEAD's own rule against the published manifest, and what stands in its way.
 * @param staged - the staged promotion (null when none is staged).
 * @param context - the published head, the live lease, the runtime and this origin.
 * @returns the card's state.
 */
export async function promotionStateOf(staged: StagedPromotion | null, context: PromotionContext): Promise<PromotionState> {
  const state = await classifiedStateOf(staged, context)
  // "needs no passkey" hides a Pearl, so it is not said when HEAD's lease answer just now failed or
  // named another head than the one the change was classified against: the Pearl is then shown and counted, NOT CHECKED.
  const unsure = headNotConfirmed(context)
  return state.kind === 'not-class-3' && unsure !== null ? { kind: 'unreadable', staged: true, why: unsure } : state
}

/** Why a staged Pearl was not classified: the published Pearl was not read. */
const PUBLISHED_UNREAD_WHY = 'the published Pearl could not be read, so the change cannot be classified'

/**
 * Why the head the page classifies against is not confirmed just now (null when nothing says otherwise): HEAD's lease
 * answer failed, or it named a different head from the one the page read.
 * @param context - the classification's context.
 * @returns the reason, in words, or null.
 */
function headNotConfirmed(context: PromotionContext): string | null {
  if (context.leaseUnread != null) {
    return `HEAD's lease answer was not read just now (${context.leaseUnread}), so this page cannot tell which head the change follows`
  }
  const fresh = context.freshHead ?? null
  return fresh === null || (fresh.ballId === context.published.ballId && fresh.epoch === context.published.epoch) ? null
    : `HEAD has moved on since this page read it (now epoch ${String(fresh.epoch)} · ${fresh.ballId.slice(0, 12)}), so the change `
      + 'was not classified against the head it follows'
}

/**
 * HEAD's own rule for one staged Pearl, against the published head the card read (`promotionStateOf` without its last
 * guard; HEAD's own record maps a "needs no passkey" answer itself, in `headPromotionStateOf`).
 * @param staged - the staged promotion (null when none is staged).
 * @param context - the published head, the live lease, the runtime and this origin.
 * @returns the card's state.
 */
async function classifiedStateOf(staged: StagedPromotion | null, context: PromotionContext): Promise<PromotionState> {
  if (staged === null) return { kind: 'absent' }
  const published = context.published.entries
  if (published === null) return { kind: 'unreadable', staged: true, why: PUBLISHED_UNREAD_WHY }
  // ON HEAD: the head this page read earlier is no proof when HEAD's lease answer just now failed or
  // named another head (HEAD may have been restored below it, and this Pearl may be its valid next one).
  if (staged.ball.ballId === context.freshHead?.ballId) return { kind: 'on-head', ballId: staged.ball.ballId }
  if (staged.ball.ballId === context.published.ballId) {
    const unsure = headNotConfirmed(context)
    return unsure === null ? { kind: 'on-head', ballId: staged.ball.ballId } : { kind: 'unreadable', staged: true, why: unsure }
  }
  const transition = classifyHeadTransition(published, staged.ball.entries)
  if (transition.class !== 3) return { kind: 'not-class-3' }
  const [entryId] = transition.entryIds
  if (transition.entryIds.length !== 1 || entryId === undefined) return { kind: 'several', entryIds: transition.entryIds }
  const previous = Object.hasOwn(published, entryId) ? published[entryId] : undefined
  const candidate = Object.hasOwn(staged.ball.entries, entryId) ? staged.ball.entries[entryId] : undefined
  const binding = await headPromotionBinding({ audience: context.audience, ball: staged.ball, entryId, previous: published })
  const specifier = typeof candidate?.specifier === 'string' ? candidate.specifier : ''
  const codeChanged = canonicalJson(previous?.specifier ?? null) !== canonicalJson(candidate?.specifier ?? null)
  const bytes = /^ball:[0-9a-f]{64}$/u.test(specifier) ? await moduleBytes(staged.body, binding.candidateSha256) : 'not-code'
  const ids = [...new Set([...Object.keys(published), ...Object.keys(staged.ball.entries)])]
  // EVERY OTHER ENTRY, WHOLE (Round 31): HEAD's passkey-only rule compares each entry but the one organ in full
  // (head-do.mjs), governance siblings included and every field, not only the fields a transition is classified by. The
  // card's "other changes" row names the same entries.
  const others = ids.filter(id => id !== entryId && canonicalJson(Object.hasOwn(published, id) ? published[id] : null)
    !== canonicalJson(Object.hasOwn(staged.ball.entries, id) ? staged.ball.entries[id] : null))
  const reasons = promotionReadiness({ staged, published: { ballId: context.published.ballId, epoch: context.published.epoch },
    runtime: context.runtime, manifestProblem: await manifestProblem(staged.body.ball),
    canQualify: context.canQualify, qualifyBlocker: context.qualifyBlocker ?? null, leaseUnread: context.leaseUnread ?? null, bytes,
    requirements: context.requirements ?? null, canonicalId: await canonicalManifestIdMatches(staged.body.ball), others })
  // HEAD MOVED SINCE THE CARD READ IT: the change above was classified against the entries the card read, which are no
  // longer HEAD's, so it stands in the way until Refresh reads HEAD again.
  const fresh = context.freshHead ?? null
  const moved = fresh !== null && (fresh.ballId !== context.published.ballId || fresh.epoch !== context.published.epoch)
  const allReasons = moved ? [...reasons, `HEAD has moved on since this card read it (now epoch ${String(fresh.epoch)} · ${fresh.ballId.slice(0, 12)}); `
    + 'Refresh reads it again (HEAD: REBASE_REQUIRED)'] : reasons
  // THE CODE ON EACH SIDE (Lane B3), for the card's code diff: the module the published entries the card read run for this
  // organ, and the one the approval binds.
  const incumbent = typeof previous?.specifier === 'string' && /^ball:[0-9a-f]{64}$/u.test(previous.specifier)
    ? previous.specifier.slice(5) : null
  return { kind: 'staged', staged, binding, change: describeGovernanceChange(previous, candidate), others, bytes, codeChanged,
    entryId, organChange: previous === undefined ? 'added' : candidate === undefined ? 'removed' : 'changed',
    incumbentSha: incumbent, candidateSha: bytes === 'not-code' ? null : binding.candidateSha256,
    reasons: allReasons, lease: context.lease, checkedAt: context.now, leaseUnread: context.leaseUnread ?? null }
}

/**
 * THE CARD FOR THE PEARL HEAD HOLDS ITSELF (Wave 3). The staged bytes HEAD serves are classified and checked exactly like
 * her staged file (`promotionStateOf`); on top of that, HEAD's record must agree with what this page computed from those
 * bytes (`headRecordProblems`). A record a passkey cannot approve is shown with the reason, never offered.
 * @param record - HEAD's record (`GET /_head/promotion-status` `staged`).
 * @param context - the published head, the live lease, the runtime and this origin.
 * @returns the card's state.
 */
export async function headPromotionStateOf(record: HeadStagedRecord, context: PromotionContext): Promise<PromotionState> {
  const held = record.t2Reasons.length === 0 ? '' : ` HEAD holds it for: ${record.t2Reasons.join(', ')}.`
  if (record.promotion === null) {
    return { kind: 'head-blocked', record, why: 'HEAD holds a staged Pearl, but served no staged bytes this page can read, so its change '
      + 'cannot be checked here and nothing is offered.' }
  }
  const state = await classifiedStateOf(record.promotion, context)
  switch (state.kind) {
    case 'staged': return { ...state, reasons: [...state.reasons, ...headRecordProblems(record, state.binding)], source: 'head', onHead: record }
    // HEAD's own record may say otherwise (its governance class): then the two readings disagree, and that is what is said.
    // A Pearl that only adds ordinary organs is offered on its own card (OrganSetCell), with every organ listed.
    case 'not-class-3': return record.organSet != null && record.governanceClass === 1 ? state : { kind: 'head-blocked', record, why: record.governanceClass === 3
      ? 'HEAD\'s record calls this a governance change (class 3), but this page\'s own reading of the staged bytes finds none, so the two '
        + `disagree and no passkey is asked for.${held} Refresh reads both again.`
      : 'A passkey approves only a governance change (Class 3), and this page\'s reading of the staged bytes finds none: no organ it '
        + 'changes is one of the named governance organs, and none declares `governance` (on the entry or in its config).'
        + `${held} Nothing is offered here; Auma must stage it again.` }
    case 'several': return { kind: 'head-blocked', record, why: `HEAD takes one governance change at a time; this one changes ${
      state.entryIds.join(', ')}.${held} Nothing is offered here; Auma must stage them one at a time.` }
    // The Pearl was read from HEAD's record, not her file: said so where it is named.
    case 'unreadable': return { ...state, source: 'head' }
    default: return state
  }
}

/** HEAD's own record in rows: what it says changes, why it holds it, and its digest. */
export function headRecordRows(record: HeadStagedRecord): { readonly rows: [string, string][]; readonly details: [string, string][] } {
  return {
    rows: [
      ['held on HEAD', `epoch ${String(record.epoch)} · changes ${record.changedEntries.join(', ') || 'no entry it names'}`],
      ['why HEAD holds it', record.t2Reasons.join(', ') || 'no reason named'],
      ['candidate digest', record.candidateDigest === null ? 'not named by HEAD'
        : `${record.candidateDigest} (${record.digestMatches ? 'the hash of the fields above, checked here' : 'NOT the hash of the fields above'})`],
    ],
    details: [
      ...(record.stagedAt === null ? [] : [['staged on HEAD (HEAD\'s clock)', new Date(record.stagedAt).toISOString()] as [string, string]]),
    ],
  }
}

/** The card's line for what HEAD answered. */
export function promotionOutcomeWords(outcome: PromotionOutcome, binding: HeadPromotionBinding): string {
  switch (outcome.kind) {
    case 'landed': return `HEAD took it: epoch ${String(binding.epoch)} · Pearl ${binding.ballId.slice(0, 12)}. Refresh reads the new head.`
    case 'refused': return `HEAD refused it (${outcome.code}) without using the approval, which expires unused within 5 minutes.`
    case 'unclear': return `${outcome.detail}, and ${outcome.headRead === 'not-on-head' ? 'the new Pearl is not on HEAD as read just now'
      : 'HEAD could not be read again to look for it'}: whether it landed is unclear. Refresh reads the head again.`
    case 'not-sent': return notSentWords(outcome.why, outcome.heldBy ?? null, outcome.detail ?? null)
  }
}

/** Why nothing was sent, in words; in every case the approval was not used. */
function notSentWords(why: NotSentWhy, heldBy: string | null, detail: string | null): string {
  switch (why) {
    case 'approval-expiring': return 'The approval was about to expire before it could be sent, so it was not sent; approve again'
    case 'lease-busy': return `HEAD's writer lease was still held${heldBy === null ? '' : ` by ${heldBy}`} at the last ask, and too little of `
      + 'the approval was left to wait for it, so nothing was sent and the approval was not used; approve again when it is free'
    case 'lease-unclear': return `HEAD gave no clear answer to the last writer lease request (${detail ?? 'no answer'})${heldBy === null ? ''
      : `; earlier it said the lease was held by ${heldBy}`}, and too little of the approval was left to ask again, so nothing was sent `
      + 'and the approval was not used; approve again'
    case 'head-moved': return 'HEAD has moved on from the Pearl this was staged on, so nothing was sent and the approval was not used; '
      + 'Auma must stage it again'
    case 'no-author': return 'The staged Pearl names no author a writer lease can go to, so nothing was sent and the approval was not used.'
    case 'stopped': return 'Stopped before anything was sent; the approval was not used.'
  }
}

/** The promotion card's status line: an outcome, or a step while it is on its way. */
interface PromotionLine {
  readonly ok: boolean
  readonly text: string
  readonly working?: true
  /** Stays until Refresh (its own words say so): an outcome that is unclear is never wiped by a quiet re-read. */
  readonly keep?: true
}

/** The card's line while an approved promotion is on its way. */
export function landStepWords(step: LandStep): string {
  switch (step.kind) {
    case 'taking-lease': return `Approved. Taking a fresh writer lease from HEAD for ${step.ownerPeerId}…`
    case 'waiting': return step.unclear !== undefined
      ? `Approved. HEAD gave no clear answer to the lease request (${step.unclear}); asking again in ${String(step.seconds)} s…`
      : `Approved. HEAD's writer lease is held${step.heldBy === null ? '' : ` by ${step.heldBy}`}; asking again in ${String(step.seconds)} s…`
    case 'sending': return `Sending her staged Pearl to HEAD under writer lease generation ${String(step.generation)}…`
    case 'promoting': return 'Approved. Asking HEAD to promote the Pearl it holds…'
  }
}

/**
 * The line for a passkey that was not given. After a re-check the tap may have aged past what Safari allows for a passkey
 * sheet, so that case asks for one more tap (the card's check is current by then).
 * @param reason - the approval's reason (`class3:passkey …` when the passkey itself did not complete).
 * @param fresh - whether the tap went straight to the passkey (no re-check first).
 * @returns the words.
 */
export function notApprovedWords(reason: string, fresh: boolean): string {
  const text = `Not approved: ${reason}`
  return !fresh && passkeyDidNotComplete(text) ? TAP_AGAIN : text
}

/** The card's line when the check at the click finds the Pearl no longer ready: no passkey was asked for. */
function recheckLine(again: PromotionState): PromotionLine {
  if (again.kind === 'staged' && again.leaseUnread !== null && again.reasons.length === 1) {
    return { ok: false, text: 'Checked again just now: HEAD\'s lease answer could not be read, so no passkey was asked for.' }
  }
  if (again.kind === 'on-head') return { ok: true, text: 'Checked again just now: it is already the published Pearl, so there is nothing to approve.' }
  if (again.kind === 'not-class-3') return { ok: true, text: 'Checked again just now: it changes no governance organ, so it needs no passkey.' }
  if (again.kind === 'unreadable') return { ok: false, text: `Checked again just now: ${again.why}, so no passkey was asked for.` }
  return { ok: false, text: 'Checked again just now: HEAD would refuse it, so no passkey was asked for.' }
}

/** The staged card's summary line for every state but a staged Pearl that was checked. */
function promotionSummaryOther(promotion: PromotionState, stagedUnchecked: boolean): string {
  switch (promotion.kind) {
    case 'head-blocked': return `epoch ${String(promotion.record.epoch)} · held on HEAD: no passkey can approve it as staged`
    case 'head-unread': return 'not checked: what HEAD holds for you was not read'
    case 'malformed': return 'a staged file this page cannot read as a promotion'
    case 'several': return 'it changes several governance organs at once'
    case 'unreadable': return !stagedUnchecked ? 'her home was not read in this window' : promotion.why === PUBLISHED_UNREAD_WHY
      ? 'a Pearl is staged; not checked: the published Pearl was not read'
      : 'a Pearl is staged; not checked: the head it follows was not confirmed just now'
    case 'on-head': return 'on HEAD: it is the published Pearl'
    case 'not-class-3': return 'it changes no governance organ: no passkey needed'
    case 'absent': return 'no longer staged'
    default: return 'Reading…'
  }
}

/** One card's rows, then its diagnostic rows in one closed fold. */
function CardBody({ card }: { readonly card: Pick<CardView, 'rows' | 'details'> }) {
  return (
    <>
      {card.rows.length === 0 ? null : <FieldTable rows={card.rows} />}
      {card.details.length === 0 ? null : (
        <RecordList>
          <RecordRow tone="muted" title="Details" summary={card.details.map(([name]) => name).join(' · ')}>
            <FieldTable rows={card.details} />
          </RecordRow>
        </RecordList>
      )}
    </>
  )
}

/** The two host bodies the strip reads beyond the host mode itself. */
interface EdgeBodies { readonly status: EdgeBodyRead; readonly health: EdgeBodyRead }
const EDGE_BODIES_READING: EdgeBodies = { status: { kind: 'reading' }, health: { kind: 'reading' } }

/**
 * Render the Sovereignty surface.
 * @param props - centre-lane owner share and the shared file reader.
 * @returns the surface.
 */
export function SovereigntySurface({ activeSurface, useSessions, reader, schedules, t, view = 'sovereignty' }: PropsRuntime<'shell.surface'>
  & SovereigntySurfaceInjected & Partial<PropsLocale<'layout'>>) {
  const continuity = view === 'continuity'
  const active = activeSurface === (continuity ? CONTINUITY_SURFACE : SOVEREIGNTY_SURFACE)
  const sessionId: SessionId | undefined = useSessions(sessionOf)
  const [head, setHead] = useState<Answer<PublishedHead>>({ kind: 'idle' })
  const [runtime, setRuntime] = useState<Answer<RuntimeRelease>>({ kind: 'idle' })
  const [receipts, setReceipts] = useState<BridgeReceipts | null>(null)
  const [readPhase, setReadPhase] = useState<BridgePhase | null>(null)
  const [round, setRound] = useState(0)
  const refresh = useCallback(() => { setRound(r => r + 1) }, [])
  // The host-mode read already GETs /__x6/status and (on the edge) /api/health. The strip needs more of those same bodies
  // (the edge Aura, the provider window), so the read's fetch keeps a copy of each body: no extra request, no polling.
  const [edgeBodies, setEdgeBodies] = useState<EdgeBodies>(EDGE_BODIES_READING)
  useLayoutEffect(() => { if (active) setEdgeBodies(EDGE_BODIES_READING) }, [active, round])
  const keepEdgeBodies = useCallback(async (input: string, init?: RequestInit): Promise<Response> => {
    const which = input === '/__x6/status' ? 'status' : input === '/api/health' ? 'health' : null
    const keep = (next: EdgeBodyRead): void => {
      if (which !== null && init?.signal?.aborted !== true) setEdgeBodies(bodies => ({ ...bodies, [which]: next }))
    }
    let response: Response
    try { response = await fetch(input, init) } catch (error) { keep({ kind: 'failed', reason: `${input} did not answer` }); throw error }
    if (which !== null) {
      if (!response.ok) keep({ kind: 'failed', reason: `${input} answered ${String(response.status)}` })
      else {
        // When it was read: the host's own clock (its `Date` header) when it sent one, else this page's clock now. The
        // provider window is judged at that moment, so the tile never changes between reads.
        const stamped = Date.parse(response.headers.get('date') ?? '')
        const readAt = Number.isFinite(stamped) ? stamped : Date.now()
        void response.clone().json().then((body: unknown) => { keep({ kind: 'ok', body, readAt }) },
          () => { keep({ kind: 'failed', reason: `${input} is not JSON` }) })
      }
    }
    return response
  }, [])
  const hostMode = useHostMode(active, round, keepEdgeBodies)
  // Read once per opening and Refresh, like this view's own receipt read below, so both sides are as old.
  const hostFacts = useHostFacts(active, round, undefined, false)
  // The node's passkey binding, read from this host once per opening and Refresh (Round 22).
  const [aumlok, setAumlok] = useState<AumlokHostRead>({ kind: 'reading' })
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setAumlok({ kind: 'reading' })
    void readAumlokStatus(controller.signal).then((read) => { if (!controller.signal.aborted) setAumlok(read) }, () => {
      if (!controller.signal.aborted) setAumlok({ kind: 'unreadable' })
    })
    return () => { controller.abort() }
  }, [active, round])
  const owner = ownerAuthorityOf(aumlok)
  // THE CHECKPOINT KEY TABLE (Round 24), read once per opening and Refresh, for the signer card.
  const [keyTable, setKeyTable] = useState<KeyTableRead>({ kind: 'reading' })
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setKeyTable({ kind: 'reading' })
    void getJson('/_host/checkpoint-policy', parseCheckpointPolicy, controller.signal).then((answer) => {
      if (controller.signal.aborted) return
      setKeyTable(answer.kind === 'ok' ? { kind: 'ok', ranges: answer.value } : { kind: 'failed', reason: answer.kind === 'failed' ? answer.reason : 'not read' })
    })
    return () => { controller.abort() }
  }, [active, round])
  // THE STAGED GOVERNANCE PEARL (Round 23): her staged publish, read once per opening and Refresh, classified by HEAD's
  // own rule against the published manifest, and checked for everything that would make HEAD refuse it. Touch ID is
  // asked for only when nothing this page can check stands in the way.
  const [promotion, setPromotion] = useState<PromotionState>({ kind: 'reading' })
  /** Why the last background read failed while a staged Pearl stayed on screen (null when it read). */
  const [promotionStale, setPromotionStale] = useState<string | null>(null)
  const shownPromotion = useRef(promotion)
  shownPromotion.current = promotion
  // THE ONE EXCEPTION: the staged Pearl HEAD's own promotion-status answer named as published, kept
  // with the exact card state it was merged into. It hides only that state, and only while no later read failed.
  const [publishedFor, setPublishedFor] = useState<PublishedFor | null>(null)
  const [promotionOutcome, setPromotionOutcome] = useState<PromotionLine | null>(null)
  // The staged Pearl the outcome line is about: it never shows under a different one.
  const [outcomeFor, setOutcomeFor] = useState<string | null>(null)
  const [promoting, setPromoting] = useState(false)
  // DURING AN APPROVAL NOTHING REPLACES THE CARD (Round 35): a read of the card that settles while the passkey ceremony
  // runs is held back, and the card is read again once the approval settles (the click already re-read the file).
  const promotingRef = useRef(false)
  promotingRef.current = promoting
  const pendingRead = useRef(false)
  // A live re-read of the card alone (Round 31 review): it reads the staged file and HEAD's lease again and keeps what
  // the card shows until the new answer is in, so a card the owner has open stays open. Refresh still reads everything.
  const [cardTick, setCardTick] = useState(0)
  const [headTick, setHeadTick] = useState(0)
  const quietRead = useRef(false)
  // FRESH MEANS UNCHANGED SINCE THE CHECK: every live change to what the card shows is counted, and a card is used as it is
  // at the tap only when no change arrived after its read began (her file can be restaged inside FRESH_CHECK_MS).
  const changesSeen = useRef(0)
  const changesChecked = useRef(0)
  const publishedEntries = head.kind === 'ok' ? head.value.entries : null
  const publishedBallId = head.kind === 'ok' && /^[0-9a-f]{64}$/u.test(head.value.ballId) ? head.value.ballId : null
  const publishedEpoch = head.kind === 'ok' && /^\d+$/u.test(head.value.epoch) ? Number(head.value.epoch) : null
  const runtimeKind = hostMode.kind === 'local' ? 'local' : hostMode.kind === 'cloudflare' ? 'cloudflare' : 'other'
  const headRecordAsked = hostMode.kind !== 'reading' && hostMode.kind !== 'local'
  useEffect(() => {
    // The approval cards are Sovereignty's: the Continuity view draws none of them, so it reads none of this.
    if (!active || continuity) return
    const controller = new AbortController()
    const quiet = quietRead.current
    if (!quietRead.current && !promotingRef.current) setPromotion({ kind: 'reading' })
    quietRead.current = false
    const changesAtRead = changesSeen.current
    void (async () => {
      const settle = (next: PromotionState, published: { readonly ballId: string; readonly epoch: number } | null = null): void => {
        if (controller.signal.aborted) return
        if (promotingRef.current) { pendingRead.current = true; return }
        // A BACKGROUND read that failed keeps the Pearl on screen, and says so on the card (Refresh still shows the failure).
        const failed = next.kind === 'unreadable' || next.kind === 'head-unread'
        if (quiet && failed && shownPromotion.current.kind === 'staged') {
          setPromotionStale(next.why)
          return
        }
        setPromotionStale(null)
        changesChecked.current = changesAtRead
        setPublishedFor(published === null ? null : { state: next, ...published })
        setPromotion(next)
      }
      // One lease read serves both sources.
      let shared: Promise<PromotionContext> | null = null
      const context = (): Promise<PromotionContext> => (shared ??= promotionContext(controller.signal))
      // The lease read this round, only when one was asked for: it is never started just to hide a card.
      const contextIfRead = (): Promise<PromotionContext> | null => shared
      // HER STAGED FILE, in this window's copy of her home (Round 23), read as the chat card reads it (promotion-sources.ts).
      const fromHome = async (file: HomePromotionRead): Promise<HomeCard> => {
        if (file.kind !== 'staged') return { state: file, staged: null }
        const staged = file.staged
        // The published head is read once per opening; until it answers, nothing is classified.
        if (head.kind === 'idle') return { state: { kind: 'reading' }, staged }
        return { state: await promotionStateOf(staged, await context()), staged }
      }
      // THE RECORD HEAD HOLDS ITSELF (Wave 3). Not asked of the Mac host (it has no such route), nor before the host is
      // known; a host that could not be told apart is still asked, so a failing status route never hides a waiting Pearl.
      // Nor before the published head is in: nothing is classified until then, and the answer carries the staged body.
      const fromHead = async (): Promise<HeadStagedRead> => (headRecordAsked && head.kind !== 'idle' ? readHeadStaged(controller.signal)
        : { kind: 'absent' })
      // HER FILE FIRST, THEN HEAD'S ANSWER: HEAD's answer is asked for only once her file has been
      // read, so the published list in it is never older than the Pearl it is compared with.
      const file = await readHomePromotion(reader, sessionId, controller.signal)
      const [home, held] = await Promise.all([fromHome(file), fromHead()])
      if (held.kind === 'staged' && head.kind === 'idle') { settle({ kind: 'reading' }); return }
      // THE ONE PEARL THIS CARD SHOWS, merged by the rule the chat card merges by (promotion-sources.ts).
      const merged = await mergePromotionSources(home, held, async record => headPromotionStateOf(record, await context()))
      // the head the classification's lease read named, this round (null when it was not read).
      const read = contextIfRead()
      const leaseHead = read === null ? null : (await read).freshHead ?? null
      settle(merged, await publishedPearlOf(merged, home.staged, held, true, leaseHead))
    })().catch(() => {
      if (controller.signal.aborted) return
      if (promotingRef.current) { pendingRead.current = true; return }
      setPromotion({ kind: 'unreadable', why: 'the staged file could not be read' })
    })
    return () => { controller.abort() }
  }, [active, round, cardTick, reader, sessionId, head.kind, publishedEntries, publishedBallId, publishedEpoch, runtimeKind,
    headRecordAsked, continuity])
  useEffect(() => { if (!active) setPromotionOutcome(null) }, [active])
  // What the readiness check reads besides the file, read fresh each time (the lease lives seconds). The same answer names
  // HEAD's selected Pearl, so the check at the click sees a HEAD that moved on before any Touch ID is asked for.
  const promotionContext = async (signal: AbortSignal): Promise<PromotionContext> => {
    const lease = await readHeadLease(signal)
    return promotionContextOf({ published: head.kind === 'ok' ? head.value : null, lease, runtime: runtimeKind,
      audience: globalThis.location.origin, now: Date.now() })
  }
  // A STALE CARD READS AGAIN ON ITS OWN (Round 31): a commit on HEAD, or a change to her staged file or her head file (or a
  // change whose paths the host did not list), reads the card again, quietly and debounced. HEAD moving on then shows as a
  // reason on the card itself (REBASE_REQUIRED) until Refresh reads the new head. During an approval the read waits, and
  // runs once the approval settles. A refusal line from an earlier check goes with the stale card; a landing stays.
  // A commit on HEAD also reads the published head again (Round 34), so a card in another tab classifies Auma's next
  // Pearl against the new head and offers it, instead of waiting for Refresh.
  const headStale = useRef(false)
  const reread = useDebounced(() => {
    if (promotingRef.current) { pendingRead.current = true; return }
    quietRead.current = true
    setPromotionOutcome(line => (line !== null && !line.ok && line.working !== true && line.keep !== true ? null : line))
    setCardTick(n => n + 1)
    if (headStale.current) { headStale.current = false; setHeadTick(n => n + 1) }
  })
  useLiveEvents(active, (event) => {
    // HEAD took a candidate to hold (Wave 3): the card reads HEAD's record again, in whichever window this is.
    const changed = event.kind === 'ball-commit' || event.kind === 'head-staged' || (event.kind === 'mirror-updated'
      && (event.changedPaths === null || event.changedPaths.length === 0
        || event.changedPaths.some(path => STAGED_PROMOTION_CHANGE.test(path))))
    if (!changed) return
    changesSeen.current += 1
    if (event.kind === 'ball-commit') headStale.current = true
    // During an approval no timer is armed (a follow-up would wipe its outcome line later): the read waits for it to settle.
    if (promotingRef.current) { pendingRead.current = true; return }
    reread.poke()
    if (event.kind === 'ball-commit') reread.followUp(COMMIT_FOLLOW_UPS)
  })
  useEffect(() => { if (!active) reread.cancel() }, [active, reread])
  const promote = async (): Promise<void> => {
    if (promotion.kind !== 'staged' || promotion.reasons.length > 0 || promoting) return
    // SAFARI: the passkey sheet opens only inside the tap. A card checked this recently, with no change since and no failed
    // read since, goes straight to the passkey challenge (HEAD checks the candidate, its parent and the lease again when the
    // approved request arrives); any other card is checked again first, as before.
    const approvalKey = pearlApprovalKey(promotion.binding.ballId)
    const fresh = freshFor(approvalKey, promotion.checkedAt) && changesChecked.current === changesSeen.current && promotionStale === null
    const changesAtClick = changesSeen.current
    if (!beginApproval(approvalKey)) {
      setOutcomeFor(promotion.staged.ball.ballId)
      setPromotionOutcome({ ok: false, text: 'Another card on this page is approving this Pearl right now; nothing more was asked.' })
      return
    }
    setPromoting(true)
    // At once, not at the next render: a read already in flight must see the approval as started.
    promotingRef.current = true
    // The click reads everything again itself: a re-read queued for an earlier commit would only wipe this approval's line.
    reread.cancel()
    setStageLine(null)
    setOutcomeFor(promotion.staged.ball.ballId)
    setPromotionOutcome({ ok: true, text: fresh ? 'Waiting for Touch ID…' : 'Checking again before asking for your passkey…', working: true })
    const signal = new AbortController().signal
    try {
      if (promotion.source === 'head') { await promoteHeld(promotion, signal, fresh, changesAtClick); return }
      if (!fresh) {
        // THE STAGED FILE, READ AGAIN AT THE CLICK (Round 31): Auma may have staged again since the card read it. The passkey
        // is asked only for the bytes on her launchpad now, never for an older copy the card still shows.
        const current = sessionId === undefined ? null : await reader.whole(sessionId, STAGED_PROMOTION_PATH, signal).catch(() => null)
        const onDisk = current !== null && current.ok && !stagedPromotionTooLarge(current.text) ? parseStagedPromotion(current.text) : null
        // The writer lease she staged with is not compared: the page replaces it with a fresh one, and the approval never binds it.
        if (onDisk === null || !sameStagedBody(onDisk, promotion.staged)) {
          setPromotionOutcome({ ok: false, text: onDisk === null
            ? 'Checked again just now: her staged Pearl could not be read again, so no passkey was asked for. Refresh reads it again.'
            : 'Checked again just now: her staged Pearl has changed since this card read it, so no passkey was asked for. '
              + 'Refresh shows what is staged now.' })
          // The card is read again once this settles (the click cancelled any re-read that was queued).
          pendingRead.current = true
          return
        }
        // CHECKED AGAIN AT THE CLICK: the card may have been open a while (HEAD may have moved on).
        const again = await promotionStateOf(promotion.staged, await promotionContext(signal))
        // What the card knew of HEAD's own record stays on it (this check read her file and the lease, not that record).
        const kept: PromotionState = again.kind !== 'staged' ? again : { ...again,
          ...(promotion.onHead === undefined ? {} : { onHead: promotion.onHead }),
          ...(promotion.edgeEmpty === true ? { edgeEmpty: true } : {}) }
        if (again.kind !== 'staged' || again.reasons.length > 0) {
          setPromotion(current => (current === promotion ? kept : current))
          setPromotionOutcome(recheckLine(again))
          // HEAD's record is read again once this settles, so the card does not carry an old one.
          pendingRead.current = true
          return
        }
        // Ready: the card shows this check (its lease line included), not the one from when it opened, unless a Refresh has
        // put a newer read there meanwhile. It counts as the card's check, so a second tap goes straight to Touch ID.
        setPromotion(current => (current === promotion ? kept : current))
        changesChecked.current = changesAtClick
      }
      const approval = await approveClass3(promotion.binding, { signal })
      if (!approval.ok) { setPromotionOutcome({ ok: false, text: notApprovedWords(approval.reason, fresh) }); return }
      // A FRESH WRITER LEASE, TAKEN NOW (Round 24): a lease lives at most 60 s, so none the body was staged with can be used.
      const outcome = await landApprovedPromotion({
        staged: promotion.staged,
        token: approval.token,
        approvalLeftMs: () => approval.hostRemainingMs - (performance.now() - approval.receivedAt),
        signal,
        onStep: (step) => { setPromotionOutcome({ ok: true, text: landStepWords(step), working: true }) },
      })
      setPromotionOutcome({ ok: outcome.kind === 'landed', text: promotionOutcomeWords(outcome, promotion.binding),
        ...(outcome.kind === 'unclear' ? { keep: true } : {}) })
      // Landed: read the head and the staged file again, so the card shows the Pearl on HEAD and offers nothing more.
      if (outcome.kind === 'landed') setRound(r => r + 1)
    } catch (cause) {
      setPromotionOutcome({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      endApproval(approvalKey)
      setPromoting(false)
      promotingRef.current = false
      // A change that arrived during the approval is read now.
      if (pendingRead.current) { pendingRead.current = false; quietRead.current = true; setCardTick(n => n + 1) }
      // A commit that arrived during the approval reads the published head now (Round 34's second-tab rule).
      if (headStale.current) { headStale.current = false; quietRead.current = true; setHeadTick(n => n + 1) }
    }
  }
  // THE PEARL HEAD HOLDS, APPROVED AND PROMOTED BY HEAD (Wave 3). Read again at the click: the passkey is asked only for
  // the record HEAD holds NOW, and only while it is still the one this card shows and checks out again.
  type StagedCard = Extract<PromotionState, { kind: 'staged' }>
  const promoteHeld = async (card: StagedCard, signal: AbortSignal, fresh: boolean, changesAtClick: number): Promise<void> => {
    const shown = card.onHead
    if (!fresh) {
      const now = await readHeadStaged(signal)
      if (shown === undefined || now.kind !== 'staged' || now.record.ballId !== shown.ballId || now.record.candidateDigest !== shown.candidateDigest
        || canonicalJson(now.record.binding) !== canonicalJson(shown.binding)) {
        setPromotionOutcome({ ok: false, text: now.kind === 'unread'
          ? `Checked again just now: HEAD's staged record could not be read again (${now.why}), so no passkey was asked for. Refresh reads it again.`
          : 'Checked again just now: what HEAD holds has changed since this card read it, so no passkey was asked for. '
            + 'Refresh shows what is staged now.' })
        pendingRead.current = true
        return
      }
      const again = await headPromotionStateOf(now.record, await promotionContext(signal))
      if (again.kind !== 'staged' || again.reasons.length > 0 || canonicalJson(again.binding) !== canonicalJson(card.binding)) {
        setPromotion(current => (current === card ? again : current))
        setPromotionOutcome(recheckLine(again))
        return
      }
      const kept = card.otherInHome === undefined ? again : { ...again, otherInHome: card.otherInHome }
      setPromotion(current => (current === card ? kept : current))
      changesChecked.current = changesAtClick
    }
    // The terms asked for are the ones this page computed from the bytes HEAD serves; HEAD's record names the same ones.
    const approval = await approveClass3(card.binding, { signal })
    if (!approval.ok) { setPromotionOutcome({ ok: false, text: notApprovedWords(approval.reason, fresh) }); return }
    const outcome = await promoteStagedOnHead({
      ballId: card.binding.ballId,
      token: approval.token,
      approvalLeftMs: () => approval.hostRemainingMs - (performance.now() - approval.receivedAt),
      signal,
      onStep: (step) => { setPromotionOutcome({ ok: true, text: landStepWords(step), working: true }) },
    })
    setPromotionOutcome({ ok: outcome.kind === 'landed', text: promotionOutcomeWords(outcome, card.binding),
      ...(outcome.kind === 'unclear' ? { keep: true } : {}) })
    if (outcome.kind === 'landed') setRound(r => r + 1)
  }
  // HER STAGED FILE, HANDED TO HEAD TO HOLD (Wave 3 fallback): for a Pearl staged in this window's home that HEAD does not
  // hold, so only this window shows it. It asks for no passkey and publishes nothing; HEAD's answer is said as it is.
  const [stageLine, setStageLine] = useState<PromotionLine | null>(null)
  // The Pearl the staging line is about: it never shows under a different one.
  const [stageFor, setStageFor] = useState<string | null>(null)
  const [staging, setStaging] = useState(false)
  useEffect(() => { if (!active) setStageLine(null) }, [active])
  const stageOnEdge = async (): Promise<void> => {
    if (promotion.kind !== 'staged' || promotion.edgeEmpty !== true || staging || promoting) return
    setStaging(true)
    setStageFor(promotion.staged.ball.ballId)
    setStageLine({ ok: true, text: 'Checking again, then handing her staged Pearl to HEAD to hold…', working: true })
    const signal = new AbortController().signal
    try {
      // CHECKED AGAIN AT THE CLICK, like an approval: her file must still be the Pearl on this card, and HEAD must still hold
      // none (HEAD keeps one record; it refuses another on the same head, CANDIDATE_ALREADY_STAGED, and this page never
      // asks it to replace one).
      const current = sessionId === undefined ? null : await reader.whole(sessionId, STAGED_PROMOTION_PATH, signal).catch(() => null)
      const onDisk = current !== null && current.ok && !stagedPromotionTooLarge(current.text) ? parseStagedPromotion(current.text) : null
      const held = await readHeadStaged(signal)
      if (onDisk === null || !sameStagedBody(onDisk, promotion.staged)) {
        setStageLine({ ok: false, text: 'Checked again just now: her staged Pearl is no longer the one on this card, so nothing was sent.' })
      } else if (held.kind !== 'none') {
        setStageLine({ ok: false, text: held.kind === 'staged'
          ? 'Checked again just now: HEAD holds a staged Pearl by now, so nothing was sent.'
          : 'Checked again just now: what HEAD holds could not be read, so nothing was sent.' })
      } else {
        const outcome = await stageOnHead(onDisk, signal)
        setStageLine(outcome.kind === 'held'
          ? { ok: true, text: 'HEAD holds it now: every signed-in owner window shows this card. Nothing was approved or published.' }
          : outcome.kind === 'refused' ? { ok: false, text: `HEAD did not take it to hold (${outcome.code}); nothing changed.` }
            : { ok: false, text: `${outcome.detail}: whether HEAD holds it is unclear. Refresh reads HEAD again.` })
      }
      // Read the card again, quietly: it then carries what HEAD holds, and this button goes.
      quietRead.current = true
      setCardTick(n => n + 1)
    } catch (cause) {
      setStageLine({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setStaging(false)
    }
  }
  // Whether the repo and outward cards show (they decide themselves), so the waiting section shows only when something does.
  const [repoShown, setRepoShown] = useState(false)
  const [outwardShown, setOutwardShown] = useState(false)
  const [organSetShown, setOrganSetShown] = useState(false)
  const [snapshot, setSnapshot] = useState<SnapshotState>({ kind: 'idle' })
  // HER PROMOTION RECEIPTS, for the Receipt chain card (Wave 7): read from this window's copy of her ledger, once per opening
  // and Refresh, by the Sovereignty view only. A provisional leaf that an authoritative (Touch ID) leaf supersedes is folded
  // into that promotion's row, never drawn as a second promotion.
  const [promotionRows, setPromotionRows] = useState<readonly PromotionRow[] | 'too-large' | null>(null)
  // THE CHAIN VERDICT (read-only, gates nothing): does this window's ledger extend her last checkpoint? Unread is unknown.
  // EVERY READ HAS ITS OWN IDENTITY: a number never reused, assigned in a layout effect whenever the
  // session, reader, Refresh round or open state changes, so the change is invalidated before the browser paints. A
  // verdict is shown only for the read that produced it: returning to a session, or closing and reopening, shows Unknown
  // until that new read resolves, never an older verdict for the same session.
  const chainReadCounter = useRef(0)
  const [chainRead, setChainRead] = useState(0)
  useLayoutEffect(() => {
    chainReadCounter.current += 1
    setChainRead(chainReadCounter.current)
  }, [active, continuity, sessionId, reader, round])
  const [chainResult, setChainResult] = useState<{ readonly read: number; readonly verdict: ChainVerdict | null } | null>(null)
  useEffect(() => {
    const read = chainRead
    // A render scheduled before the layout effect named the new read: that read's own run does the work.
    if (read !== chainReadCounter.current) return undefined
    if (!active || continuity || sessionId === undefined) return undefined
    const controller = new AbortController()
    const ledger = reader.whole(sessionId, RECEIPTS_PATH, controller.signal)
    ledger.then((file) => {
      if (controller.signal.aborted) return
      if (!file.ok) { setPromotionRows(null); return }
      const leaves = promotionReceiptsOf(file.text)
      setPromotionRows(leaves === null ? 'too-large' : promotionRowsOf(leaves))
    }).catch(() => { if (!controller.signal.aborted) setPromotionRows(null) })
    const textOf = (pending: ReturnType<WorkReader['whole']>): Promise<string | null> => pending.then(file => (file.ok ? file.text : null), () => null)
    Promise.all([textOf(reader.whole(sessionId, CHECKPOINTS_PATH, controller.signal)), textOf(ledger)])
      .then(([checkpointsText, receiptsText]) => chainVerdictOf({ checkpointsText, receiptsText }))
      .then((verdict) => { if (!controller.signal.aborted) setChainResult({ read, verdict }) })
      .catch(() => { if (!controller.signal.aborted) setChainResult({ read, verdict: null }) })
    return () => { controller.abort() }
  }, [active, continuity, sessionId, reader, round, chainRead])
  const chainVerdict = chainResult !== null && chainResult.read === chainRead ? chainResult.verdict : null
  // A new opening starts from the idle card; a download asked for and still in flight finishes on its own.
  useEffect(() => { if (!active) setSnapshot(previous => (previous.kind === 'reading' ? previous : { kind: 'idle' })) }, [active])
  const download = async (): Promise<void> => {
    if (snapshot.kind === 'reading') return
    setSnapshot({ kind: 'reading' })
    const name = snapshotFileName(head.kind === 'ok' ? head.value.epoch : null)
    const result = await fetchMirrorSnapshot(new AbortController().signal)
    if (result.kind === 'failed') { setSnapshot(result); return }
    saveBlob(result.blob, name)
    setSnapshot({ kind: 'handed', name, bytes: result.blob.size })
  }
  // THE PORTABLE RECOVERY SNAPSHOT (recovery-snapshot.ts): one press reads the four routes once each and hands over one
  // file. Like the mirror download, a new opening starts from the idle button and a read in flight finishes on its own.
  const [recovery, setRecovery] = useState<RecoveryState>({ kind: 'idle' })
  useEffect(() => { if (!active) setRecovery(previous => (previous.kind === 'reading' ? previous : { kind: 'idle' })) }, [active])
  const downloadRecovery = async (): Promise<void> => {
    if (recovery.kind === 'reading') return
    setRecovery({ kind: 'reading', route: null })
    try {
      const capture = await captureRecoverySnapshot(new AbortController().signal,
        { onRoute: (route) => { setRecovery({ kind: 'reading', route }) } })
      const blob = new Blob([capture.json], { type: 'application/json' })
      const next = recoveryStateOf(capture, blob.size)
      // NOTHING CAPTURED, NOTHING HANDED OVER: an empty file would only look like a backup.
      if (next.kind !== 'failed') saveBlob(blob, capture.name)
      setRecovery(next)
    } catch (error) {
      setRecovery({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) })
    }
  }

  // The host's two head routes, once per opening (and on Refresh): `/_head/ball` carries module sources, so it is not polled.
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void getJson('/_head/ball', parsePublishedHead, controller.signal).then((a) => {
      // A head that did not move keeps its entries' identity, so the staged card is not read again for nothing.
      if (!controller.signal.aborted) {
        setHead(prev => (prev.kind === 'ok' && a.kind === 'ok' && prev.value.ballId === a.value.ballId && prev.value.epoch === a.value.epoch
          ? { kind: 'ok', value: { ...a.value, entries: prev.value.entries, codeBySha: prev.value.codeBySha ?? a.value.codeBySha } } : a))
      }
    })
    void getJson('/_head/runtime', parseRuntimeRelease, controller.signal).then((a) => { if (!controller.signal.aborted) setRuntime(a) })
    return () => { controller.abort() }
  }, [active, round])
  // THE PUBLISHED HEAD, READ AGAIN AFTER A LIVE COMMIT (Round 34): quietly (the staged card keeps what it shows until the
  // new head classifies it again), and only a head that read cleanly replaces the one shown.
  useEffect(() => {
    if (!active || headTick === 0) return
    const controller = new AbortController()
    void getJson('/_head/ball', parsePublishedHead, controller.signal).then((a) => {
      if (controller.signal.aborted || a.kind !== 'ok') return
      quietRead.current = true
      setHead(a)
    })
    return () => { controller.abort() }
  }, [active, headTick])

  // Her own receipt verification, through the one page reader (the Work view's).
  useEffect(() => {
    if (!active) return
    // A new opening or Refresh starts a new comparison: the previous tab read is never set beside a new host read.
    setReadPhase(null)
    setReceipts(null)
    const bridge = workBridge()
    if (bridge === null) {
      setReceipts({ kind: 'bridge-unavailable' })
      return
    }
    const read = bridge.createRead(sessionId === undefined ? {} : {
      sessionId: String(sessionId),
      readText: async (path, signal) => {
        const res = await reader.whole(sessionId, path, signal)
        return res.ok ? { kind: 'ok', text: res.text } : { kind: 'unavailable' }
      },
    })
    const take = () => {
      const phase = read.current()
      if (phase.kind === 'snapshot' || phase.kind === 'stale-snapshot' || phase.kind === 'failure') { setReceipts(phase.receipts); setReadPhase(phase) }
    }
    // The reader starts its one read on creation; Refresh makes a new reader rather than interrupting this one.
    take()
    const off = read.subscribe(take)
    return () => { off(); read.stop() }
  }, [active, reader, sessionId, round])

  const hostWords = hostModeWords(hostMode)
  // FULL HEAD AGREEMENT (Round 19): this view's one read gives the tab's receipts, checkpoint coverage and head together.
  const agreement = compareTabToHost(tabFactsOf(readPhase, readHeadOf(readPhase), true), hostFacts)
  const keys = keysCardOf(aumlok, hostFacts, keyTable, receipts)
  const chain = chainCardOf(hostFacts, agreement, receipts)
  // THE DURABILITY STRIP: the same reads, projected; a read that failed shows "unavailable", never an older number.
  const tr = t ?? englishDurability
  const durability = durabilityTilesOf({ head, aumlok, receipts, receiptsStale: readPhase?.kind === 'stale-snapshot', facts: hostFacts,
    host: hostMode, status: edgeBodies.status, health: edgeBodies.health }, tr)
  const durabilityNotes = durabilityNotesOf(durability, tr)
  // The only obstacle is a lease answer this page could not read: said as not checked, never as HEAD refusing.
  const notChecked = promotion.kind === 'staged' && promotion.leaseUnread !== null && promotion.reasons.length === 1
  // The outcome of the owner's own approval, shown only beside the Pearl it is about (a landing re-reads to 'on-head').
  const outcome = promotionOutcome !== null && (promotion.kind === 'staged' ? promotion.staged.ball.ballId === outcomeFor
    : promotion.kind === 'on-head' ? promotion.ballId === outcomeFor
      : promotion.kind === 'head-blocked' ? promotion.record.ballId === outcomeFor
        // After a landing through HEAD's record, a window that cannot read her home re-reads to 'unreadable': the line stays.
        : promotion.kind === 'reading' || promotion.kind === 'absent' || promotion.kind === 'not-class-3' || promotion.kind === 'head-unread'
          || (promotion.kind === 'unreadable' && promotion.staged !== true)) ? promotionOutcome : null
  // THE STAGED PEARL CARD SHOWS ONLY WHILE SOMETHING IS STAGED for the owner to act on, or is wrong, or a staged Pearl could not
  // be checked, and stays with the outcome of his approval (landed, refused) until Refresh. Nothing staged, a home not read,
  // or a publish that needs no passkey show no card at all.
  const stagedUnchecked = promotion.kind === 'unreadable' && promotion.staged === true
  // THE ONE EXCEPTION: HEAD's own answer, the one this card was read from, names its Pearl as
  // published, no later read has failed, and no approval outcome is on it: the Pearl is not waiting. One plain line says so.
  const alreadyPublished = publishedFor !== null && publishedFor.state === promotion && promotionStale === null && outcome === null
    ? publishedFor : null
  const showPromotion = (promotion.kind === 'staged' || promotion.kind === 'malformed' || promotion.kind === 'several' || stagedUnchecked
    || promotion.kind === 'head-blocked' || promotion.kind === 'head-unread' || outcome !== null) && alreadyPublished === null
  // HEAD's own record of the Pearl on the card, when HEAD holds one (Wave 3).
  const heldRecord = promotion.kind === 'staged' ? promotion.onHead ?? null : promotion.kind === 'head-blocked' ? promotion.record : null
  const heldRows = heldRecord === null ? null : headRecordRows(heldRecord)
  const fromHeadRecord = promotion.kind === 'head-blocked' || promotion.kind === 'head-unread'
    || ((promotion.kind === 'staged' || promotion.kind === 'unreadable') && promotion.source === 'head')
  // The staging line, only beside the Pearl it is about.
  const stageNote = stageLine !== null && promotion.kind === 'staged' && promotion.staged.ball.ballId === stageFor ? stageLine : null
  const otherInHome = promotion.kind === 'staged' || promotion.kind === 'head-blocked' ? promotion.otherInHome ?? null : null
  const otherInHomeRow: [string, string][] = otherInHome === null ? [] : [['her home also holds',
    `a different staged Pearl (epoch ${String(otherInHome.epoch)} · ${otherInHome.ballId.slice(0, 12)}); the one HEAD holds is the one shown here`]]
  const noPasskey = promotion.kind === 'staged' && promotion.reasons.length === 0 && !owner.bound
  const promotionSummary = promotion.kind === 'staged'
    ? `${promotion.binding.organId} · epoch ${String(promotion.binding.epoch)} · ${promotion.reasons.length > 0
      ? (notChecked ? 'not checked: HEAD\'s lease answer was not read' : 'HEAD would refuse it as staged')
      : noPasskey ? 'HEAD could take it: no usable passkey on this host' : 'HEAD could take it: waits for your passkey'}`
    : promotionSummaryOther(promotion, stagedUnchecked)
  const promotionBadge: { text: string; tone: 'gold' | 'mint' | 'muted' } = promotion.kind === 'staged'
    ? (promotion.reasons.length > 0 ? { text: notChecked ? 'NOT CHECKED' : 'CANNOT LAND', tone: 'muted' }
      : noPasskey ? { text: 'NO PASSKEY', tone: 'muted' } : { text: 'CLASS 3', tone: 'gold' })
    : promotion.kind === 'malformed' || promotion.kind === 'several' || promotion.kind === 'head-blocked' ? { text: 'CANNOT LAND', tone: 'muted' }
      : stagedUnchecked || promotion.kind === 'head-unread' ? { text: 'NOT CHECKED', tone: 'gold' }
        : promotion.kind === 'on-head' ? { text: 'ON HEAD', tone: 'mint' }
          : { text: promotion.kind === 'reading' ? 'READING' : 'NOTHING TO APPROVE', tone: 'muted' }
  // An unchecked Pearl is named by where it was read: her staged file, unless only HEAD's record was.
  const fromStagedFile = !fromHeadRecord
  const promotionLead = promotion.kind === 'malformed'
    ? `There is a file at ${STAGED_PROMOTION_PATH}, but it is not a staged promotion this page can read${promotion.why === undefined ? ''
      : ` (${promotion.why})`}, so nothing is offered.`
    : promotion.kind === 'several' ? `HEAD takes one governance change at a time; this one changes ${promotion.entryIds.join(', ')}.`
      : stagedUnchecked ? `${fromStagedFile ? `A governance Pearl is staged at ${STAGED_PROMOTION_PATH}` : 'HEAD holds a staged Pearl'}, but ${
        promotion.why}, so nothing is offered. Refresh reads HEAD again.`
        : promotion.kind === 'head-unread' ? `HEAD's own record of a staged Pearl could not be read (${promotion.why}), and ${
          promotion.homeWhy === undefined ? 'this window has no staged Pearl of its own to show' : `this window did not read her home either (${
            promotion.homeWhy})`}, so whether a Pearl waits for your passkey is not known. Refresh asks again.`
          : promotion.kind === 'head-blocked' ? promotion.why : null
  // THE MAC'S RELEASE SELECTION: the Mac answers /_head/runtime, so its refusal or a failed selection is said; the edge does not
  // route it (501), so nothing is said there.
  const runtimeTrouble = hostMode.kind !== 'local' ? null : runtime.kind === 'failed' ? `not read (/_head/runtime ${runtime.reason})`
    : runtime.kind === 'ok' && runtime.value.selectionError !== 'none' ? `selection FAILED (${runtime.value.selectionError})` : null
  // A host that could not be told apart, or an edge whose health did not read: the pill alone would read as healthy.
  const hostTrouble = hostMode.kind === 'unknown' || (hostMode.kind === 'cloudflare' && hostWords.tone !== 'mint') ? hostWords.detail : null
  const headValue = head.kind === 'ok' ? head.value : null
  const pearlRows: [string, string][] = headValue === null ? [] : [
    ['epoch', headValue.epoch],
    ['Pearl ID', headValue.ballId],
    ...(headValue.buildSha === '—' ? [] : [['build', headValue.buildSha] as [string, string]]),
    // The release the host serves on `/`: only the Mac answers /_head/runtime (the edge does not route it).
    ...(runtimeTrouble !== null ? [['served release', runtimeTrouble] as [string, string]]
      : runtime.kind === 'ok' && runtime.value.releaseId !== '—'
        ? [['served release', `${runtime.value.releaseId}${runtime.value.epoch === '—' ? '' : ` (epoch ${runtime.value.epoch})`}`] as [string, string]] : []),
  ]
  const pearlDetails: [string, string][] = headValue === null ? [] : [
    ['parent Pearl', headValue.parentBallId],
    ['modules', String(headValue.modules)],
    ['live peers', String(headValue.peers)],
    ...(runtime.kind === 'ok' && runtime.value.releaseId !== '—'
      ? [['latest captured release', runtime.value.latestCaptured], ['release candidates', String(runtime.value.candidates)]] as [string, string][] : []),
  ]
  const waitingCount = (showPromotion ? 1 : 0) + (repoShown ? 1 : 0) + (outwardShown ? 1 : 0) + (organSetShown ? 1 : 0)
  const approvalStatusBadge = continuity ? null
    : waitingCount > 0
      ? { text: `${String(waitingCount)} WAITING FOR TOUCH ID`, tone: 'gold' as const,
        title: 'Approvals waiting below for your passkey' }
      : promotion.kind === 'reading'
        ? { text: 'CHECKING APPROVALS…', tone: 'muted' as const, title: 'Reading what waits for your passkey' }
        : { text: `0 WAITING${headValue === null ? '' : ` · EPOCH ${headValue.epoch}`}`, tone: 'mint' as const,
          title: 'No Pearl, repo merge, or outward action is waiting for Touch ID right now' }
  return (
    <AppSurface active={active} data-sovereignty-surface={continuity ? undefined : ''} data-continuity-surface={continuity ? '' : undefined}
      data-published-epoch={headValue === null ? undefined : headValue.epoch}>
      <AppHeader
        eyebrow={continuity ? 'What keeps her alive, and where' : 'Everything the system governs'}
        title={continuity ? 'Continuity' : 'Sovereignty'}
        tone="blue"
        badges={[
          { text: hostWords.pill, tone: hostWords.tone, title: hostWords.detail },
          ...(approvalStatusBadge === null ? [] : [approvalStatusBadge]),
        ]}
      />
      {hostMode.kind === 'signed-out' ? <EdgeOwnerSignIn host={hostMode.host} /> : null}
      {hostTrouble === null ? null : <Lead><span role="status" data-sovereignty-host-trouble="">{hostTrouble}</span></Lead>}
      {/* WAITING FOR YOUR TOUCH ID (Lane B2): every card that waits for the passkey, first and open, the button at its top. */}
      {continuity ? null : (
        <section data-sovereignty-waiting="" hidden={!(showPromotion || repoShown || outwardShown || organSetShown)}>
          <SectionLabel>Waiting for your Touch ID</SectionLabel>
          <PortalGrid open>
            {showPromotion ? (
              <PortalCell data-sovereignty-portal="promotion" data-sovereignty-promotion-source={fromHeadRecord ? 'head' : 'home'}>
                <PortalButton
                  defaultExpanded
                  tone="gold"
                  icon="approvals"
                  title="Staged governance Pearl"
                  summary={promotionSummary}
                  badge={<StatusPill tone={promotionBadge.tone}>{promotionBadge.text}</StatusPill>}
                >
                  {promotion.kind === 'staged' ? (
                    <>
                      {promotion.reasons.length === 0 ? (
                        <>
                          <button type="button" className="x5-field" data-sovereignty-promote="" disabled={promoting || !owner.bound}
                            onClick={() => { void promote() }}>
                            {`Approve Staged Governance Pearl (${promotion.binding.organId} ${promotion.binding.candidateSha256.slice(0, 8)}…) with Touch ID`}
                          </button>
                          <Lead>
                            {!owner.bound ? 'No usable passkey is bound on this host, so nothing can approve it here.'
                              : promotion.source === 'head'
                                ? 'Touch ID approves exactly these terms, once. HEAD then promotes the Pearl it holds, from its own stored bytes '
                                + 'and under a writer lease it takes itself; it spends the approval only if it commits.'
                                : 'Touch ID approves exactly these terms, once. The page then takes a fresh writer lease from HEAD and sends her '
                                + 'staged Pearl under it; HEAD spends the approval only if it commits.'}
                          </Lead>
                        </>
                      ) : (
                        <Lead>
                          {notChecked
                            ? 'No passkey is asked for: HEAD\'s lease answer could not be read just now. Refresh asks again.'
                            : 'No passkey is asked for: HEAD would refuse it as staged, for the reasons above.'}
                        </Lead>
                      )}
                      {/* VIEW CODE DIFF (Lane B3): closed until opened; it reads its own sides and never changes the card. */}
                      {promotion.codeChanged && (promotion.incumbentSha !== null || promotion.candidateSha !== null) ? (
                        <CodeDiffRow promotion={promotion} published={head.kind === 'ok' ? head.value.codeBySha : null} reader={reader}
                          sessionId={sessionId} />
                      ) : null}
                      <CardBody card={{
                        rows: [
                          ['organ', promotion.binding.organId],
                          ['change', promotion.change.join('; ')],
                          ['new Pearl', `epoch ${String(promotion.binding.epoch)} · ${promotion.binding.ballId}`],
                          ...(heldRows === null ? [] : heldRows.rows),
                          ['can HEAD take it?', promotion.reasons.length === 0
                            ? 'nothing this page can check stands in the way; HEAD still checks its own qualification of the change'
                            : promotion.reasons.join(' · ')],
                        ],
                        details: [
                          ['approval binds', promotion.bytes === 'not-code' ? `execution hash ${promotion.binding.candidateSha256}`
                            : promotion.codeChanged ? `new code ball:${promotion.binding.candidateSha256}`
                              : `ball:${promotion.binding.candidateSha256} (the same code it runs now; the change is in the fields above)`],
                          ['code bytes', !promotion.codeChanged ? 'unchanged'
                            : promotion.bytes === 'verified' ? 'in the staged body, and they hash to that id (checked here)'
                              : promotion.bytes === 'absent' ? 'not in the staged body (HEAD must already hold them)'
                                : promotion.bytes === 'mismatch' ? 'in the staged body, but they do NOT hash to that id' : 'not a code change'],
                          ...(promotion.others.length === 0 ? [] : [['other changes', promotion.others.join(', ')] as [string, string]]),
                          ...(promotion.staged.stagedAt === null || promotion.source === 'head' ? []
                            : [['staged (as the file says)', new Date(promotion.staged.stagedAt).toISOString()] as [string, string]]),
                          ['writer lease', promotion.leaseUnread !== null ? `not read just now (${promotion.leaseUnread})`
                            : promotion.source === 'head' ? `${promotion.lease === null ? 'free' : `held by ${promotion.lease.ownerPeerId}`} when read; `
                            + 'HEAD takes it itself after Touch ID (this page asks again while it is held)'
                              : writerLeaseWords(promotion.lease, promotion.staged.ball.authorPeerId, promotion.checkedAt)],
                          ...(heldRows === null ? [] : heldRows.details),
                          ...otherInHomeRow,
                        ],
                      }}
                      />
                    </>
                  ) : (
                    <>
                      {promotion.kind !== 'head-blocked' || heldRows === null ? null
                        : <CardBody card={{ rows: heldRows.rows, details: [...heldRows.details, ...otherInHomeRow] }} />}
                      {promotionLead === null ? null : <Lead>{promotionLead}</Lead>}
                    </>
                  )}
                  {promotion.kind === 'staged' && promotion.edgeEmpty === true ? (
                    <>
                      <button type="button" className="x5-field" data-sovereignty-stage-edge="" disabled={staging || promoting}
                        onClick={() => { void stageOnEdge() }}>
                        Stage This Pearl on the Edge for Every Owner Window
                      </button>
                      <Lead>
                        HEAD holds no staged Pearl, so only this window shows this card. Staging hands these exact bytes to HEAD to hold;
                        it approves nothing and publishes nothing.
                      </Lead>
                    </>
                  ) : null}
                  {promotionStale === null || promotion.kind !== 'staged' ? null : (
                    <Lead><span role="status" data-sovereignty-promotion-stale="">
                      {`Not read again just now (${promotionStale}): this is the Pearl as last read.`}
                    </span></Lead>
                  )}
                  {stageNote === null ? null : (
                    <Lead><span data-sovereignty-stage-outcome={stageNote.working === true ? 'working' : stageNote.ok ? 'ok' : 'refused'}
                      role="status">{stageNote.text}</span></Lead>
                  )}
                  {outcome === null ? null : (
                    <Lead><span data-sovereignty-promotion-outcome={outcome.working === true ? 'working'
                      : outcome.ok ? 'ok' : 'refused'} role="status">{outcome.text}</span></Lead>
                  )}
                </PortalButton>
              </PortalCell>
            ) : null}
            <RepoProposalCell active={active} round={round} ownerBound={owner.bound} onShown={setRepoShown} />
            <OrganSetCell active={active} round={round} ownerBound={owner.bound} onShown={setOrganSetShown} />
            <OutwardApprovalCell active={active} round={round} reader={reader} sessionId={sessionId} ownerBound={owner.bound}
              onShown={setOutwardShown} />
          </PortalGrid>
        </section>
      )}
      {continuity || alreadyPublished === null ? null : (
        <Lead><span role="status" data-sovereignty-published-pearl={alreadyPublished.ballId}>
          {`The staged Pearl ${alreadyPublished.ballId.slice(0, 12)} is already published as epoch ${String(alreadyPublished.epoch)}: `
            + 'nothing waits for your passkey.'}
        </span></Lead>
      )}
      {!continuity ? null : (
        <section data-sovereignty-durability="">
          <SectionLabel>{tr('sovereignty.durability.title')}</SectionLabel>
          {/* Values are short (the tile clips one line); the full text and any qualifier ride on the title and the notes below. */}
          <StatTiles tiles={durability.map(tile => ({ name: tile.name, tone: tile.tone,
            value: <span title={tile.title} data-durability-tile={tile.id}>{tile.value}</span> }))} />
          {/* What was NOT read is always said; the long caveats (the provider window's among them) wait under a closed row. */}
          {durabilityNotes.notRead === null ? null
            : <Lead><span role="status" data-sovereignty-durability-note="">{durabilityNotes.notRead}</span></Lead>}
          {durabilityNotes.caveats === null ? null : (
            <RecordList>
              <RecordRow tone="muted" title="Details" summary={<span data-sovereignty-durability-details="">what each tile does and does not count</span>}>
                <Lead><span data-sovereignty-durability-caveats="">{durabilityNotes.caveats}</span></Lead>
              </RecordRow>
            </RecordList>
          )}
        </section>
      )}
      <PortalGrid open={false}>
        {continuity ? null : (
          <>
            <PortalCell data-sovereignty-portal="keys">
              <PortalButton
                tone={keys.tone === 'gold' ? 'gold' : 'blue'}
                icon="lock"
                title="Keys and trust"
                summary={keys.summary}
                badge={<StatusPill tone={keys.tone}>{keys.badge}</StatusPill>}
              >
                <CardBody card={keys} />
                <NightGrantCell active={active} round={round} />
              </PortalButton>
            </PortalCell>
            <PortalCell data-sovereignty-portal="chain">
              <PortalButton
                tone={chain.tone === 'red' || chain.tone === 'gold' ? 'gold' : 'blue'}
                icon="approvals"
                title="Receipt chain"
                summary={chain.summary}
                badge={<StatusPill tone={chain.tone}>{chain.badge}</StatusPill>}
              >
                <CardBody card={chain} />
                <Lead>
                  <span data-sovereignty-chain-verdict={chainVerdict?.verdict ?? 'UNDETERMINED'} role="status"
                    title={chainVerdict === null ? undefined : `retained ${chainVerdict.inputHashes.retained ?? 'not read'} · presented ${chainVerdict.inputHashes.presented ?? 'not read'}`}>
                    {chainVerdict === null ? 'Unknown: the chain verdict has not been computed in this window.' : chainVerdictWords(chainVerdict)}
                  </span>
                </Lead>
                {chain.notes.map(note => <Lead key={note}><span data-sovereignty-host-lag="" role="status">{note}</span></Lead>)}
                {promotionRows === 'too-large'
                  ? (
                    <Lead>
                      <span data-sovereignty-promotion-receipts="too-large">
                        Her receipt ledger is larger than this page reads, so its promotions are not listed here.
                      </span>
                    </Lead>
                  )
                  : promotionRows === null || promotionRows.length === 0 ? null : (
                    <div data-sovereignty-promotion-receipts="listed">
                      <SectionLabel>Promotions in her ledger (as recorded; the rows above say what was verified)</SectionLabel>
                      <RecordList>
                        {promotionRows.map(row => (
                          <RecordRow
                            key={`${String(row.receipt.seq)}:${String(row.receipt.epoch)}`}
                            tone={row.receipt.hasApprovalToken ? 'gold' : 'muted'}
                            title={`Epoch ${row.receipt.epoch === null ? '?' : String(row.receipt.epoch)}${row.receipt.entryId === null ? '' : ` · ${row.receipt.entryId}`}`}
                            summary={(
                              <span data-sovereignty-promotion-receipt={row.receipt.epoch === null ? '?' : String(row.receipt.epoch)}
                                data-authoritative={String(row.receipt.hasApprovalToken)} data-supersedes={String(row.replaces)}>
                                {promotionWords(row)}
                              </span>
                            )}
                          />
                        ))}
                      </RecordList>
                    </div>
                  )}
              </PortalButton>
            </PortalCell>
          </>
        )}
        {!continuity ? null : (
          <>
            <PortalCell data-sovereignty-portal="head">
              <PortalButton
                tone="blue"
                icon="releases"
                title="Published Pearl"
                summary={headValue === null ? (head.kind === 'failed' ? 'not read' : 'Reading…')
                  : `Pearl ${headValue.epoch} · ${short(headValue.ballId)}${runtimeTrouble === null ? '' : ' · served release NOT read'}`}
                badge={<StatusPill tone={head.kind === 'ok' ? 'mint' : 'muted'}>{head.kind === 'ok' ? 'LIVE' : head.kind === 'failed' ? 'NOT READ' : 'READING'}</StatusPill>}
              >
                {head.kind === 'failed' ? <Lead>The Pearl record did not answer here: {head.reason}</Lead> : null}
                <CardBody card={{ rows: pearlRows, details: pearlDetails }} />
                <button type="button" className="x5-field" data-sovereignty-snapshot="" disabled={snapshot.kind === 'reading'}
                  onClick={() => { void download() }}>
                  Download Live Mirror Snapshot
                </button>
                {snapshot.kind === 'idle' ? null : <Lead><span role="status" data-sovereignty-snapshot-state={snapshot.kind}>{snapshotWords(snapshot)}</span></Lead>}
                <button type="button" className="x5-field" data-continuity-recovery="" data-continuity-recovery-state={recovery.kind}
                  title={recoveryWords({ kind: 'idle' })} disabled={recovery.kind === 'reading'} onClick={() => { void downloadRecovery() }}>
                  Download Portable Recovery Snapshot
                </button>
                {recovery.kind === 'idle' ? null
                  : <Lead><span role="status" data-continuity-recovery-words={recovery.kind}>{recoveryWords(recovery)}</span></Lead>}
              </PortalButton>
            </PortalCell>
            <PortalCell data-sovereignty-portal="wake">
              <WakeCell active={active} round={round} door={schedules} />
            </PortalCell>
            <PortalCell data-sovereignty-portal="estate">
              <EstateCell active={active} round={round} />
            </PortalCell>
          </>
        )}
      </PortalGrid>
      <button type="button" className="x5-field" data-sovereignty-refresh=""
        onClick={() => { if (!promoting) setPromotionOutcome(null); setStageLine(null); refresh() }}>Refresh</button>
    </AppSurface>
  )
}

/**
 * The Continuity screen (Wave 5): the same component and reads as Sovereignty, drawn as the durability strip, the
 * published Pearl, the wake schedule and the host's estate. Sovereignty keeps the approvals, the keys and the receipts.
 * @param props - as for `SovereigntySurface`.
 * @returns the surface.
 */
export function ContinuitySurface(props: Parameters<typeof SovereigntySurface>[0]) {
  return <SovereigntySurface {...props} view="continuity" />
}
