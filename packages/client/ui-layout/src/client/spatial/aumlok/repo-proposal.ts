// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * AUMA'S STAGED REPO PROPOSAL, CHECKED HERE AND MERGED ON ONE TOUCH ID (Wave 4, Wall 2).
 *
 * Auma works on her own branch (`auma/proposal/…`), runs CI there, and stages the branch for the owner (`stage_proposal`).
 * HEAD keeps the record and serves it on `GET /_head/promotion-status` as `stagedRepoProposal`
 * (`aukora.staged-repo-proposal.v1`): the branch, the exact commits (base, head, tree), the changed files, CI, the exact
 * merge request (`mergeBody`) and the passkey terms for it (`binding`, `aukora.class3.action.v1`).
 *
 * THE PAGE NEVER ASKS THE PASSKEY FOR TERMS IT ONLY RECEIVED. It computes the terms itself from the merge request
 * (`class3Action`: this origin, POST, /_host/repo, the SHA-256 of the canonical JSON of the request) and asks only when
 * they equal the terms HEAD recorded, byte for byte; the request must name exactly the commits the record names; no
 * changed file may be under `.github/`. The host checks everything again when the approved request arrives (main still at
 * the base, the branch still at the head and tree) and refuses a branch that moved.
 *
 * SOURCE: the shapes are the Wave 4 shared wire contract (§1.3). The edge side is written in parallel by another lane; a
 * host that does not serve `stagedRepoProposal` shows no card.
 * @module aumlok/repo-proposal
 */
import {
  approveClass3, canonicalJson, class3Action, CLASS3_ACTION_SCHEMA, sendApprovedClass3, type Class3Action, type Class3Dependencies,
} from './class3-approval.ts'
import { caseTwinPaths, proposalPathRefusal, type ProposalPathCode } from './frozen-paths.ts'

export const REPO_PROPOSAL_SCHEMA = 'aukora.staged-repo-proposal.v1'
/** Her branch namespace (the edge's AUMA_BRANCH_RE). Only a proposal branch is ever merged. */
export const AUMA_PROPOSAL_BRANCH = /^auma\/proposal\/[a-z0-9][a-z0-9._-]{1,60}$/u
export const REPO_ROUTE = '/_host/repo'
const HEX_40 = /^[0-9a-f]{40}$/u
const HEX_64 = /^[0-9a-f]{64}$/u
const CI_STATES = new Set(['passed', 'pending', 'failed', 'none'])
/** The most changed files listed on the card; the count beyond is said. */
export const CHANGED_FILES_SHOWN = 200

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The exact request the owner approves: fast-forward main from `baseSha` to `headSha` (tree `treeSha`). */
export interface MergeBody {
  readonly action: 'merge_proposal'
  readonly baseSha: string
  readonly branch: string
  readonly headSha: string
  readonly treeSha: string
}
export interface ChangedFile {
  readonly path: string
  /** Where a renamed or copied file came from, when the record says. */
  readonly previousPath: string | null
  readonly status: string
  readonly additions: number | null
  readonly deletions: number | null
  readonly t2Protected: boolean
}
export interface RepoProposal {
  readonly branch: string
  readonly title: string
  readonly summary: string | null
  readonly baseSha: string
  readonly headSha: string
  readonly treeSha: string
  readonly changedFiles: readonly ChangedFile[]
  readonly ciStatus: 'passed' | 'pending' | 'failed' | 'none'
  readonly stagedAt: number | null
  readonly mergeBody: MergeBody
  readonly binding: Class3Action
}

const MERGE_KEYS = ['action', 'baseSha', 'branch', 'headSha', 'treeSha']
const BINDING_KEYS = ['audience', 'bodySha256', 'method', 'pathname', 'schema']
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null)

/**
 * Read a `stagedRepoProposal` value. Anything not exactly the contract's shape is not a proposal.
 * @param value - the value HEAD serves.
 * @returns the proposal, or null.
 */
export function parseRepoProposal(value: unknown): RepoProposal | null {
  if (!isRecord(value) || value.schema !== REPO_PROPOSAL_SCHEMA) return null
  const { branch, title, summary, baseSha, headSha, treeSha, changedFiles, ciStatus, stagedAt, mergeBody, binding } = value
  if (typeof branch !== 'string' || typeof title !== 'string' || title.trim() === '' || typeof baseSha !== 'string'
    || typeof headSha !== 'string' || typeof treeSha !== 'string' || !HEX_40.test(baseSha) || !HEX_40.test(headSha) || !HEX_40.test(treeSha)
    || !Array.isArray(changedFiles) || typeof ciStatus !== 'string' || !CI_STATES.has(ciStatus)) return null
  if (!isRecord(mergeBody) || !exactKeys(mergeBody, MERGE_KEYS) || mergeBody.action !== 'merge_proposal'
    || typeof mergeBody.baseSha !== 'string' || typeof mergeBody.branch !== 'string' || typeof mergeBody.headSha !== 'string'
    || typeof mergeBody.treeSha !== 'string') return null
  if (!isRecord(binding) || !exactKeys(binding, BINDING_KEYS) || binding.schema !== CLASS3_ACTION_SCHEMA || typeof binding.audience !== 'string'
    || binding.method !== 'POST' || typeof binding.pathname !== 'string' || typeof binding.bodySha256 !== 'string') return null
  const files: ChangedFile[] = []
  for (const file of changedFiles) {
    if (!isRecord(file) || typeof file.path !== 'string' || file.path === '' || typeof file.status !== 'string') return null
    const previous = typeof file.previousPath === 'string' ? file.previousPath : typeof file.previous_filename === 'string' ? file.previous_filename : null
    files.push({ path: file.path, previousPath: previous === '' ? null : previous, status: file.status, additions: count(file.additions),
      deletions: count(file.deletions),
      t2Protected: file.t2Protected === true })
  }
  return {
    branch, title: title.trim().slice(0, 200), summary: typeof summary === 'string' && summary.trim() !== '' ? summary.trim().slice(0, 2000) : null,
    baseSha, headSha, treeSha, changedFiles: files, ciStatus: ciStatus as RepoProposal['ciStatus'],
    stagedAt: typeof stagedAt === 'number' && Number.isSafeInteger(stagedAt) && stagedAt > 0 ? stagedAt : null,
    mergeBody: { action: 'merge_proposal', baseSha: mergeBody.baseSha, branch: mergeBody.branch, headSha: mergeBody.headSha,
      treeSha: mergeBody.treeSha },
    binding: { schema: CLASS3_ACTION_SCHEMA, audience: binding.audience, method: 'POST', pathname: binding.pathname, bodySha256: binding.bodySha256 },
  }
}

/** A path under `.github/`, however it is spelled (the workflows and actions that run with the repo's secrets). */
export function touchesWorkflows(path: string): boolean {
  const parts: string[] = []
  for (const part of path.replace(/\\/gu, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { parts.pop(); continue }
    parts.push(part)
  }
  return parts[0]?.toLowerCase() === '.github' || /(?:^|\/)\.github(?:\/|$)/iu.test(path)
}

/**
 * Every reason this page can see not to ask the passkey for this proposal; empty when nothing stands in the way. The
 * passkey is asked only for terms this page computed itself, equal to the ones HEAD recorded.
 * @param proposal - the proposal as HEAD serves it.
 * @param audience - this page's origin.
 * @returns the reasons, and the terms this page computed.
 */
export async function repoProposalProblems(proposal: RepoProposal, audience: string)
  : Promise<{ readonly problems: readonly string[]; readonly terms: Class3Action }> {
  const problems: string[] = []
  const body = proposal.mergeBody
  if (!AUMA_PROPOSAL_BRANCH.test(proposal.branch)) problems.push(`the branch ${proposal.branch} is not one of her proposal branches (auma/proposal/…)`)
  if (body.branch !== proposal.branch || body.baseSha !== proposal.baseSha || body.headSha !== proposal.headSha
    || body.treeSha !== proposal.treeSha) {
    problems.push('the merge request names other commits than the proposal it is shown with')
  }
  // A rename OUT of .github/ deletes a workflow there: the old path counts as much as the new one.
  const workflows = proposal.changedFiles
    .filter(file => touchesWorkflows(file.path) || (file.previousPath !== null && touchesWorkflows(file.previousPath)))
  if (workflows.length > 0) {
    problems.push(`it changes ${workflows.map(file => (file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`)).join(', ')}, `
      + 'under .github/, which a proposal may never change')
  }
  // The fence (deploy/ci/frozen-paths.mjs, copied in ./frozen-paths.ts), judged as the edge and CI judge it: a proposal
  // changes only plain, open, unfrozen paths; the judge, the ledger, the checks and the pins change only by a person with
  // repo write; a test main already has may not be changed or deleted, only added to. A rename is a delete of the old path
  // and an add of the new one. Each file is named once, under its most specific refusal; the card asks no passkey for any.
  const sides = (file: ChangedFile): readonly (readonly [string, 'added' | 'modified' | 'removed'])[] => (file.previousPath === null
    ? [[file.path, file.status === 'added' ? 'added' : file.status === 'removed' ? 'removed' : 'modified']]
    : [[file.previousPath, 'removed'], [file.path, 'added']])
  const twins = new Set(caseTwinPaths(proposal.changedFiles.flatMap(file => sides(file).map(([path]) => path))))
  const rank: Record<ProposalPathCode, number> = { REPO_PATH_NOT_PLAIN: 0, REPO_FROZEN_PATH_REFUSED: 1, REPO_PATH_NOT_OPEN: 2 }
  const refused: Record<ProposalPathCode, ChangedFile[]> = { REPO_PATH_NOT_PLAIN: [], REPO_FROZEN_PATH_REFUSED: [], REPO_PATH_NOT_OPEN: [] }
  for (const file of proposal.changedFiles) {
    let worst: ProposalPathCode | null = null
    for (const [path, status] of sides(file)) {
      if (touchesWorkflows(path)) continue
      const code = proposalPathRefusal(path, status, twins.has(path))
      if (code !== null && (worst === null || rank[code] < rank[worst])) worst = code
    }
    if (worst !== null) refused[worst].push(file)
  }
  const named = (files: readonly ChangedFile[]): string => files.map(file => (file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`)).join(', ')
  if (refused.REPO_PATH_NOT_PLAIN.length > 0) {
    problems.push(`it changes ${named(refused.REPO_PATH_NOT_PLAIN)}, whose name is not plain (printable ASCII only, and never another path's twin when both are lower-cased)`)
  }
  if (refused.REPO_FROZEN_PATH_REFUSED.length > 0) {
    problems.push(`it changes ${named(refused.REPO_FROZEN_PATH_REFUSED)}, `
      + 'which only a person with repo write may change (the judge, her ledger, the checks, the pins, or a test main already has)')
  }
  if (refused.REPO_PATH_NOT_OPEN.length > 0) {
    problems.push(`it changes ${named(refused.REPO_PATH_NOT_OPEN)}, outside the paths a proposal may change, which only a person with repo write may change (ask on the relay)`)
  }
  const terms = await class3Action({ audience, method: 'POST', pathname: REPO_ROUTE, body })
  if (proposal.binding.audience !== audience) problems.push(`its passkey terms are for ${proposal.binding.audience}, not this page (${audience})`)
  if (proposal.binding.pathname !== REPO_ROUTE) problems.push(`its passkey terms are for ${proposal.binding.pathname}, not ${REPO_ROUTE}`)
  if (!HEX_64.test(proposal.binding.bodySha256) || proposal.binding.bodySha256 !== terms.bodySha256) {
    problems.push('the passkey terms HEAD recorded are not the hash of the merge request it serves, so nothing is asked')
  } else if (canonicalJson(proposal.binding) !== canonicalJson(terms)) {
    problems.push('the passkey terms HEAD recorded differ from the terms this page computes, so nothing is asked')
  }
  return { problems, terms }
}

/** What `GET /_head/promotion-status` says about a staged repo proposal. */
export type RepoProposalRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'staged'; readonly proposal: RepoProposal; readonly canonical: string }
  /** HEAD serves something under the name that is not a proposal this page reads: shown as such, never offered. */
  | { readonly kind: 'malformed' }
  /** This host has no such route (404/501), or its answer has no `stagedRepoProposal` field: nothing is said. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'unread'; readonly why: string }

/** The most of a promotion-status answer this page parses (it carries a staged Pearl's bytes too). */
const STATUS_MAX_CHARS = 4 * 1024 * 1024 + 64 * 1024

/**
 * Read a promotion-status body for its repo proposal.
 * @param body - the parsed answer.
 * @returns what it says.
 */
export function repoProposalOf(body: unknown): RepoProposalRead {
  if (!isRecord(body) || body.ok !== true) return { kind: 'unread', why: 'its answer was not the expected shape' }
  if (!Object.hasOwn(body, 'stagedRepoProposal')) return { kind: 'absent' }
  const value = body.stagedRepoProposal
  if (value === null) return { kind: 'none' }
  const proposal = parseRepoProposal(value)
  return proposal === null ? { kind: 'malformed' } : { kind: 'staged', proposal, canonical: canonicalJson(proposal) }
}

/**
 * Ask HEAD for the promotion status and read both things it may hold for the owner: a staged Pearl, a repo proposal.
 * @param signal - aborts the read.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @returns the repo proposal read, and whether HEAD holds a staged Pearl (null when not read).
 */
export async function readPromotionStatus(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch)
  : Promise<{ readonly repo: RepoProposalRead; readonly pearlStaged: boolean | null }> {
  const { repo, pearlStaged } = await readPromotionAnswer(signal, fetchImpl)
  return { repo, pearlStaged }
}

/**
 * `readPromotionStatus`, with the parsed answer too when it read, so a caller that needs HEAD's staged Pearl as well
 * (`parseHeadStaged`) reads it from this one answer instead of asking twice.
 * @param signal - aborts the read.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @returns the repo proposal read, whether HEAD holds a staged Pearl (null when not read), and the parsed answer.
 */
export async function readPromotionAnswer(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch)
  : Promise<{ readonly repo: RepoProposalRead; readonly pearlStaged: boolean | null; readonly body?: unknown }> {
  try {
    const response = await fetchImpl('/_head/promotion-status', { credentials: 'same-origin', cache: 'no-store', signal })
    if (response.status === 404 || response.status === 501) return { repo: { kind: 'absent' }, pearlStaged: null }
    if (!response.ok) return { repo: { kind: 'unread', why: `it answered ${String(response.status)}` }, pearlStaged: null }
    const text = await response.text()
    if (text.length > STATUS_MAX_CHARS) return { repo: { kind: 'unread', why: 'its answer was larger than it can be' }, pearlStaged: null }
    let body: unknown
    try { body = JSON.parse(text) } catch { return { repo: { kind: 'unread', why: 'its answer was not JSON' }, pearlStaged: null } }
    const pearlStaged = isRecord(body) && body.ok === true ? isRecord(body.staged) : null
    return { repo: repoProposalOf(body), pearlStaged, body }
  } catch {
    return { repo: { kind: 'unread', why: 'it did not answer' }, pearlStaged: null }
  }
}

/** A merge attempt HEAD holds past its margin as marked or dispatched (sent, or it may have been): only GitHub showing it
 * in main, or the owner's release over its own terms, ends it (MUST 4). `state` is HEAD's own word. */
export interface HeldAttempt { readonly attemptId: string; readonly baseSha: string; readonly headSha: string; readonly state: 'marked' | 'dispatched' }
const ATTEMPT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
/**
 * The card's one sentence for a held attempt (beside its Release control), by HEAD's state (it
 * says only what was established). `dispatched`: the owning call recorded that it sent the ref update. `marked`: the mark
 * was written and its call ended before saying what it sent, so it MAY have been sent. Either way GitHub has not
 * confirmed it in main: the host's reads found main neither at it nor containing it, or could not ask.
 */
export const HELD_ATTEMPT_WORDS: Readonly<Record<HeldAttempt['state'], string>> = {
  dispatched: 'A merge approved earlier was sent, and GitHub has not confirmed it in main; it may still land. '
    + 'Only when you are sure it did not, release it with Touch ID so a new merge can begin; if it lands later, the next read records it as merged.',
  marked: 'A merge approved earlier may have been sent, and GitHub has not confirmed it in main; it may still land. '
    + 'Only when you are sure it did not, release it with Touch ID so a new merge can begin; if it lands later, the next read records it as merged.',
}
/** Where the card asks the host to reconcile a held or released merge: the owner's estate route (reads GitHub, sends nothing). */
export const RECONCILE_ROUTE = '/_host/estate'

/**
 * The attempt a promotion-status answer holds when it is marked or dispatched and older than its margin; else null.
 * @param body - the parsed promotion-status answer.
 * @returns the attempt's id and commits, or null.
 */
export function heldAttemptOf(body: unknown): HeldAttempt | null {
  const held = isRecord(body) && body.ok === true && isRecord(body.repoMergeAttempt) ? body.repoMergeAttempt : null
  if (held === null || typeof held.attemptId !== 'string' || !ATTEMPT_ID.test(held.attemptId) || (held.state !== 'marked' && held.state !== 'dispatched')
    || typeof held.baseSha !== 'string' || !HEX_40.test(held.baseSha) || typeof held.headSha !== 'string' || !HEX_40.test(held.headSha)
    || typeof held.ageMs !== 'number' || typeof held.reconcileAfterMs !== 'number' || held.ageMs <= held.reconcileAfterMs) return null
  return { attemptId: held.attemptId, baseSha: held.baseSha, headSha: held.headSha, state: held.state }
}

/** The releases a promotion-status answer keeps (`repoMergeReleases`, by attempt id), each read; the newest alone
 * (`repoMergeReleased`) from a host that keeps one. Anything malformed is skipped, never trusted. */
interface KeptRelease {
  readonly attemptId: string
  readonly branch: string
  readonly baseSha: string
  readonly headSha: string
  readonly state: string
}
function keptReleases(body: Record<string, unknown>): KeptRelease[] {
  const list = Array.isArray(body.repoMergeReleases) ? body.repoMergeReleases
    : isRecord(body.repoMergeReleased) ? [body.repoMergeReleased] : []
  return list.filter((item): item is KeptRelease => isRecord(item) && typeof item.attemptId === 'string' && ATTEMPT_ID.test(item.attemptId)
    && typeof item.branch === 'string' && typeof item.baseSha === 'string' && HEX_40.test(item.baseSha) && typeof item.headSha === 'string'
    && HEX_40.test(item.headSha) && typeof item.state === 'string')
}

/**
 * The merge attempts a card read is about: the one HEAD holds past its margin, and every
 * release HEAD keeps unresolved for the very proposal staged (same branch, base and head).
 * @param body - the parsed promotion-status answer.
 * @returns their attempt ids.
 */
export function shownAttemptIds(body: unknown): string[] {
  if (!isRecord(body) || body.ok !== true) return []
  const held = heldAttemptOf(body)
  const staged = isRecord(body.stagedRepoProposal) && isRecord(body.stagedRepoProposal.mergeBody) ? body.stagedRepoProposal.mergeBody : null
  const released = staged === null ? [] : keptReleases(body).filter(item => item.state === 'void-by-owner' && item.branch === staged.branch
    && item.baseSha === staged.baseSha && item.headSha === staged.headSha)
  return [...(held === null ? [] : [held.attemptId]), ...released.map(item => item.attemptId)]
}

/**
 * Review, MUST 3: whether HEAD's DURABLE status records one of the attempts the card shows as merged, and the
 * words, from that status alone (never from the answer to the card's own reconcile, which another tab may have made, or
 * which may have been lost). Merged after release: HEAD keeps that attempt's release as `merged-after-release`, written
 * only when GitHub showed its head in main (main at it, or containing it). Merged: HEAD's last outcome is that attempt's
 * and `succeeded`, written only when GitHub took the ref update or showed the head in main.
 * @param body - the parsed promotion-status answer.
 * @param attemptIds - the attempts the card shows (its own release's, the held one's, the staged proposal's releases).
 * @returns the attempt and the words, or null.
 */
export function durableLanding(body: unknown, attemptIds: readonly string[]): { readonly attemptId: string; readonly text: string } | null {
  if (!isRecord(body) || body.ok !== true || attemptIds.length === 0) return null
  for (const release of keptReleases(body)) {
    if (release.state === 'merged-after-release' && attemptIds.includes(release.attemptId)) {
      return { attemptId: release.attemptId, text: `Merged after all: GitHub now shows ${release.headSha.slice(0, 12)} in main, the merge you released.` }
    }
  }
  const last = body.lastRepoMergeOutcome
  if (isRecord(last) && typeof last.attemptId === 'string' && attemptIds.includes(last.attemptId) && last.status === 'succeeded'
    && typeof last.commitSha === 'string' && HEX_40.test(last.commitSha)) {
    return { attemptId: last.attemptId, text: `Merged: GitHub shows ${last.commitSha.slice(0, 12)} in main, the merge approved earlier.` }
  }
  return null
}

/**
 * Whether a card read asks the host to reconcile first: an attempt past its margin, or one the owner
 * released that GitHub has not yet been seen to show in main. Otherwise a read asks GitHub nothing.
 * @param body - the parsed promotion-status answer.
 * @returns true when the host should read GitHub again.
 */
export function needsReconcile(body: unknown): boolean {
  if (!isRecord(body) || body.ok !== true) return false
  const attempt = body.repoMergeAttempt
  return (isRecord(attempt) && typeof attempt.ageMs === 'number' && typeof attempt.reconcileAfterMs === 'number' && attempt.ageMs > attempt.reconcileAfterMs)
    || (isRecord(body.repoMergeReleased) && body.repoMergeReleased.state === 'void-by-owner')
    || keptReleases(body).some(item => item.state === 'void-by-owner')
}

/**
 * Ask the host to reconcile from what GitHub says (owner session; nothing is sent to GitHub but reads). What it found is
 * read from the status read that follows (`durableLanding`), never from this answer.
 * @param signal - aborts the request.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @returns whether the host answered 2xx.
 */
export async function reconcileHeld(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(RECONCILE_ROUTE, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reconcile_proposal' }) })
    return response.ok
  } catch {
    return false
  }
}

/** A release HEAD keeps, as it names it when every kept one is unresolved: the oldest. */
export interface ForgettableRelease { readonly attemptId: string; readonly branch: string; readonly headSha: string }
/** What the owner's release of a held attempt came to. `forget`: at the bound, the oldest kept release a release may
 * forget, over terms that name it (shown with its head). */
export interface ReleaseOutcome { readonly kind: 'released' | 'merged' | 'refused' | 'unclear'; readonly text: string; readonly forget?: ForgettableRelease }
const forgettableOf = (value: unknown): ForgettableRelease | null => isRecord(value) && typeof value.attemptId === 'string' && ATTEMPT_ID.test(value.attemptId)
  && typeof value.branch === 'string' && /^auma\/proposal\/[a-z0-9][a-z0-9._-]{1,60}$/u.test(value.branch) && typeof value.headSha === 'string' && HEX_40.test(value.headSha)
  ? { attemptId: value.attemptId, branch: value.branch, headSha: value.headSha } : null

/**
 * Release a held attempt with the owner's passkey over the release's own exact terms (`release_attempt`, its id, base and
 * head), so the release is as deliberate as the merge was. Review, MUST: with `forget`, the terms also name
 * the oldest kept release (`forgets`), which HEAD drops in the same transaction; his passkey signs that too.
 * @param held - the attempt the card shows as held.
 * @param deps - the passkey and host call (the page's own by default) and the abort signal.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @param forget - the oldest kept release to forget, as the host named it at the bound.
 * @returns the outcome, in words.
 */
export async function approveAndRelease(held: HeldAttempt, deps: Class3Dependencies, fetchImpl: typeof fetch = globalThis.fetch,
  forget?: ForgettableRelease): Promise<ReleaseOutcome> {
  const body = { action: 'release_attempt', attemptId: held.attemptId, baseSha: held.baseSha, headSha: held.headSha,
    ...(forget === undefined ? {} : { forgets: forget.attemptId }) }
  const approval = await approveClass3(await class3Action({ audience: globalThis.location.origin, method: 'POST', pathname: REPO_ROUTE, body }), deps)
  if (!approval.ok) return { kind: 'refused', text: `Not released: ${approval.reason}` }
  let sent
  try { sent = await sendApprovedClass3(approval, body, deps.signal, fetchImpl) } catch {
    return { kind: 'unclear', text: 'Whether it was released is unclear: the host did not answer. Refresh reads it again.' }
  }
  const state = sent.status === 200 && sent.body?.ok === true && isRecord(sent.body.outcome) ? sent.body.outcome.state : null
  if (state === 'void-by-owner') {
    return { kind: 'released', text: 'Released: the earlier merge is void by your hand, and a new merge can begin. If GitHub later shows it in main, the next read records it as merged.' }
  }
  if (state === 'merged') return { kind: 'merged', text: `Not released: GitHub already shows ${held.headSha.slice(0, 12)} in main, so it is merged, and no approval was spent.` }
  const code = typeof sent.body?.code === 'string' ? sent.body.code : null
  // Review, MUST 2: HEAD keeps every release until GitHub shows it in main, at most `limit`; with all of them
  // still unresolved it refuses a new one before the approval is spent, so none is forgotten.
  if (code === 'REPO_RELEASE_LIMIT') {
    const limit = typeof sent.body?.limit === 'number' ? String(sent.body.limit) : 'the most'
    // Review, MUST: the host names the oldest one; he may release this merge and forget it, with Touch ID.
    const oldest = forgettableOf(sent.body?.oldest)
    if (oldest !== null) {
      return { kind: 'refused', forget: oldest, text: `Not released: ${limit} merges you released earlier are all still unresolved (GitHub has not shown them in main), `
        + 'and the host keeps every one until it does. This merge stays held; your approval was not used. To release it anyway, release it and forget the oldest one, '
        + `${oldest.headSha.slice(0, 12)} on ${oldest.branch}: the host then stops checking whether that one lands.` }
    }
    return { kind: 'refused', text: `Not released: ${limit} merges you released earlier are all still unresolved (GitHub has not shown them in main), `
      + 'and the host keeps every one until it does, so none is forgotten. This merge stays held until one of them shows up in main; your approval was not used.' }
  }
  if (code === 'REPO_RELEASE_FORGET_STALE') {
    return { kind: 'refused', text: 'Not released: the releases the host keeps changed since this card read them, so nothing was forgotten and your approval was not used. Release again to read them anew.' }
  }
  return { kind: sent.status >= 400 && sent.status < 500 && code !== null ? 'refused' : 'unclear', text: `Not released: the host answered ${String(sent.status)}${code === null ? '' : ` ${code}`}.` }
}

/** What happened to an approved merge. */
export type MergeOutcome =
  /** The host said GitHub took the approved head into main (or already shows it there). */
  | { readonly kind: 'merged'; readonly commitSha: string }
  /** The host's own refusal, by its code: nothing of this merge was sent. */
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'not-approved'; readonly reason: string }
  /** No clear answer: main may or may not have moved. */
  | { readonly kind: 'unclear'; readonly detail: string }

/**
 * Approve the merge with the owner's passkey (terms computed here), and send the exact request with the approval.
 * @param proposal - the proposal, already checked (`repoProposalProblems` empty).
 * @param terms - the terms this page computed.
 * @param deps - the passkey and host call (the page's own by default) and the abort signal.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @returns the outcome.
 */
export async function approveAndMerge(proposal: RepoProposal, terms: Class3Action, deps: Class3Dependencies,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<MergeOutcome> {
  const approval = await approveClass3(terms, deps)
  if (!approval.ok) return { kind: 'not-approved', reason: approval.reason }
  let sent
  try { sent = await sendApprovedClass3(approval, proposal.mergeBody, deps.signal, fetchImpl) } catch (error) {
    return { kind: 'unclear', detail: `the host did not answer (${error instanceof Error ? error.message : String(error)})` }
  }
  return mergeOutcomeOf(sent, proposal)
}

/**
 * What the host's answer to an approved merge means.
 * @param sent - its status and JSON body.
 * @param proposal - the proposal that was approved.
 * @returns the outcome.
 */
export function mergeOutcomeOf(sent: { readonly status: number; readonly body: Record<string, unknown> | null }, proposal: RepoProposal)
  : MergeOutcome {
  const code = typeof sent.body?.code === 'string' ? sent.body.code : null
  if (sent.status === 200 && sent.body?.ok === true) {
    // MERGED ONLY AS THE APPROVED HEAD: a fast-forward lands exactly there. An ok that names no commit, or another one, is
    // not taken as this merge.
    const commit = sent.body.commitSha ?? sent.body.headSha
    if (typeof commit === 'string' && commit === proposal.headSha) return { kind: 'merged', commitSha: commit }
    return { kind: 'unclear', detail: 'the host said ok but did not confirm the approved head in main' }
  }
  // A merge approved earlier HEAD holds, and GitHub has not confirmed it in main: it stays held, whatever its
  // age, until the owner releases it with a fresh passkey (MUST 4). Nothing of this approval was spent.
  const main = sent.body?.mainSha
  // Review, MUST 4: the broker says HEAD holds it and what main is (`mainSha`); not whether it was sent (a
  // marked attempt may not have been) nor that main lacks it (a failed comparison also leaves it unknown).
  if (code === 'REPO_REF_OUTCOME_UNKNOWN' && sent.body?.held === true && typeof main === 'string' && HEX_40.test(main)) {
    return { kind: 'unclear', detail: `A merge approved earlier may have been sent, and GitHub shows main at ${main.slice(0, 12)} without confirming that merge in it; `
      + 'it stays held until you release it with Touch ID, and if it lands later the next read records it as merged' }
  }
  // An answer that says its own effect is unknown (a deadline after the change was sent) is not a refusal.
  if (sent.status === 408 || sent.body?.outcome === 'unknown' || sent.body?.requiresFreshClass3Approval === true) {
    return { kind: 'unclear', detail: `the host answered ${String(sent.status)}${code === null ? '' : ` ${code}`} without saying whether main moved` }
  }
  if (sent.status >= 400 && sent.status < 500 && code !== null) return { kind: 'refused', code }
  return { kind: 'unclear', detail: `the host answered ${String(sent.status)}${code === null ? '' : ` ${code}`}` }
}

/**
 * The outcome in words. Review, MUST 4: each sentence says only what the broker's answer established.
 * merged: `commitSha` equals the approved head and the host answered ok: GitHub took the ref update, or already showed the
 *   head in main (main may be past it), so "GitHub shows it in main", never "main is now it".
 * refused: a 4xx with the host's code and no unknown outcome: nothing of this merge was sent, so it did not move main.
 * REPO_APPROVAL_SPENT_VOID: the host settled the attempt void, which it does only when nothing was sent.
 */
export function mergeOutcomeWords(outcome: MergeOutcome, proposal: RepoProposal): string {
  switch (outcome.kind) {
    case 'merged': return `Merged: GitHub shows ${outcome.commitSha.slice(0, 12)} in main (${proposal.branch}).`
    // His approval was spent and nothing changed (the host settled the attempt void): say plainly that he approves again.
    case 'refused': return outcome.code === 'REPO_APPROVAL_SPENT_VOID'
      ? 'Nothing was sent, so this merge did not move main, and this approval is used up: approve again to merge (REPO_APPROVAL_SPENT_VOID).'
      : `The host refused the merge (${outcome.code}) before sending it; this merge did not move main.`
    case 'not-approved': return `Not approved: ${outcome.reason}`
    case 'unclear': return `${outcome.detail}: whether main moved is unclear. Refresh reads it again; check GitHub before approving again.`
  }
}
