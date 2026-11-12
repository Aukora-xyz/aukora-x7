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

/** What happened to an approved merge. */
export type MergeOutcome =
  /** The host said main is now exactly the approved head. */
  | { readonly kind: 'merged'; readonly commitSha: string }
  /** The host's own refusal, by its code: main did not move. */
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
    return { kind: 'unclear', detail: 'the host said ok but did not confirm main is at the approved head' }
  }
  // An answer that says its own effect is unknown (a deadline after the change was sent) is not a refusal.
  if (sent.status === 408 || sent.body?.outcome === 'unknown' || sent.body?.requiresFreshClass3Approval === true) {
    return { kind: 'unclear', detail: `the host answered ${String(sent.status)}${code === null ? '' : ` ${code}`} without saying whether main moved` }
  }
  if (sent.status >= 400 && sent.status < 500 && code !== null) return { kind: 'refused', code }
  return { kind: 'unclear', detail: `the host answered ${String(sent.status)}${code === null ? '' : ` ${code}`}` }
}

/** The outcome in words. */
export function mergeOutcomeWords(outcome: MergeOutcome, proposal: RepoProposal): string {
  switch (outcome.kind) {
    case 'merged': return `Merged: main is now ${outcome.commitSha.slice(0, 12)} (${proposal.branch}).`
    case 'refused': return `The host refused the merge (${outcome.code}); main did not move.`
    case 'not-approved': return `Not approved: ${outcome.reason}`
    case 'unclear': return `${outcome.detail}: whether main moved is unclear. Refresh reads it again; check GitHub before approving again.`
  }
}
