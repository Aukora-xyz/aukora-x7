/**
 * Aukora: Cordis-native `ball:<sha256>` Loader, Transactional Hot-Swap, Multi-Tab Presence,
 * and Local Repo Bridge (`x6_repo`).
 *
 * Replaces an earlier 2,010-line `organ-host.ts` and `floor-guard` with native Cordis
 * plugin lifecycle over `hostCtx` and `WorkerModuleLoader`.
 */
import { createHeadSocketTracker } from './head-socket-telemetry.ts'
import type { MemoryVfs } from '../storage/memory.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { workerCellHost } from './wasm-cells.ts'
import { persistence } from '../storage/idb-persist.ts'
import { createScionCompiler, type ScionInput } from './scion.ts'
import {
  growScionOrgan,
  trialScionCandidate,
  trialScionRetention,
  retentionSuiteDigest,
  retentionSuiteExtendsBaseline,
  type CandidateTrialInput,
  type CandidateTrialResult,
  type ScionGrowthInput,
} from './scion-growth.ts'
import { sha256HexSync, type WorkerModuleLoader } from '../module-system/module-loader.ts'
import { join } from '../module-system/posix-path.ts'
import { createWakeLoop } from './wake-loop.ts'
import { liveWriteSet } from './write-set-inventory.ts'
import { createCapabilityIndex, type CapabilityIndex } from './capability-index.ts'
import { hostFactsToolSpec } from './host-facts.ts'
import { idleFetch } from '../idle-fetch.ts'
import { inspectBrowserEstate, type EstateCordisView } from './browser-estate.ts'
import {
  createTransitionContext,
  isTransitionKind,
  planPromotionReceipt,
  transitionFields,
  type TransitionContext,
} from './transition-context.ts'

export const T2_ONLY_ORGANS = Object.freeze([
  'seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura',
  'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map',
  'seed-judge', 'gate-judge', 'grant-ledger', 'aumlok-identity', 'aumlok-keys',
  'auma-scion', 'seed-boot',
])
const protectedOrgans = new Set<string>(T2_ONLY_ORGANS)
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const actionText = (value: unknown): string => typeof value === 'string' ? value : ''
const AUMA_REPO_BRANCH_RE = /^auma\/(?:sandbox|proposal)\/[a-z0-9][a-z0-9._-]{1,60}$/
const repoSandboxBranch = (value: unknown): value is string => typeof value === 'string' && AUMA_REPO_BRANCH_RE.test(value)
/** Lane E4: the only branch form `stage_proposal` may stage (matches the Sovereignty card's AUMA_PROPOSAL_BRANCH). */
export const AUMA_PROPOSAL_BRANCH_RE = /^auma\/proposal\/[a-z0-9][a-z0-9._-]{1,60}$/
/** Whether a branch may carry a staged repo proposal: `auma/proposal/<slug>` only, never `auma/sandbox/*` or main. */
export const isAumaProposalBranch = (value: unknown): value is string => typeof value === 'string' && AUMA_PROPOSAL_BRANCH_RE.test(value)
/** What `x6_repo` says when the branch name is the only reason it refuses (AUMA_REPO_BRANCH_RE). */
export const AUMA_REPO_BRANCH_FORMS = 'auma/sandbox/<slug> or auma/proposal/<slug> (slug: lowercase a-z 0-9 . _ -, 2..61 characters)'
/**
 * The refusal of an `x6_repo` call whose branch name is the only reason it is not admitted, or null. It names the
 * allowed forms instead of PEARL_QUALIFICATION_MISSING_OR_STALE (which sent her hunting a Pearl fault that did not
 * exist). Admission is unchanged: it is consulted only where that refusal is thrown, so the same calls are refused.
 * `branch_create`/`branch_delete` are admitted only on an auma branch; `write`/`edit`/`commit` pin `expectedHeadSha`
 * only on one. A call carrying `idempotencyKey` is refused whatever its branch, so it keeps the qualification refusal.
 */
export function repoBranchFormRefusal(args: unknown): string | null {
  if (!record(args) || args.idempotencyKey !== undefined || repoSandboxBranch(args.branch)) return null
  const action = actionText(args.action), pinned = args.expectedHeadSha !== undefined
  const named = typeof args.branch === 'string' ? JSON.stringify(args.branch.slice(0, 80)) : 'no branch (main)'
  if (['branch_create', 'branch_delete'].includes(action) && !pinned) {
    return `REPO_BRANCH_FORM_REFUSED: ${action} is accepted only on ${AUMA_REPO_BRANCH_FORMS}; got ${named}`
  }
  if (['write', 'edit', 'commit'].includes(action) && pinned) {
    return `REPO_BRANCH_FORM_REFUSED: ${action} with expectedHeadSha is accepted only on ${AUMA_REPO_BRANCH_FORMS}; got ${named}`
  }
  return null
}
/** Tool executions in flight in this worker; a running turn is never interrupted by an autonomous wake step. */
let toolsInFlight = 0
const REPO_SOURCE_FILE_BYTES = 512 * 1024
const REPO_PRIVATE_COMMIT_BYTES = 1024 * 1024
const REPO_REQUEST_BYTES = 6 * REPO_PRIVATE_COMMIT_BYTES + 32 * 1024
const REPO_RESPONSE_BYTES = 8 * 1024 * 1024

/** Model arguments cannot carry the owner's authentication or approval material. */
function refuseBrokerAuthorityInputs(args: Record<string, unknown>): void {
  if (Object.keys(args).some(key => /(?:approval|authorization|credential|password|secret|privatekey|ownerjwt|ownertoken|accesstoken|bearer|headers)/i.test(key.replace(/[^a-z]/gi, ''))
    || ['token', 'ownerSession', '__proto__', 'constructor', 'prototype'].includes(key))) {
    throw new Error('BROKER_AUTHORITY_INPUT_REFUSED')
  }
}

/** Read the complete bounded broker envelope, including escaped source text and diff metadata. */
async function repoResponseJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('REPO_RESPONSE_INVALID')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > REPO_RESPONSE_BYTES) throw new Error('REPO_RESPONSE_LIMIT_EXCEEDED')
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    try { await reader.cancel() } catch (_cancelError) { /* Retain the original read failure if cancellation also fails. */ }
    reader.releaseLock()
  }
  const value: unknown = JSON.parse(text)
  if (!record(value)) throw new Error('REPO_RESPONSE_INVALID')
  return value
}

function canonicalJsonText(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJsonText(item === undefined ? null : item)).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter(key => obj[key] !== undefined).sort()
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJsonText(obj[key])).join(',') + '}'
}

function entryDeclaresGovernance(entry: unknown): boolean {
  if (!record(entry)) return false
  if (Object.hasOwn(entry, 'governance') && entry.governance !== false) return true
  return record(entry.config) && Object.hasOwn(entry.config, 'governance') && entry.config.governance !== false
}

export interface ParsedPromotionReceipt {
  readonly kind: 'head.promote' | 'ball.promote'
  readonly epoch: number | undefined
  readonly ballId: string | undefined
  readonly entryId: string | undefined
  /** `true`/`false` only when the leaf states it; historical leaves without the field stay `undefined`. */
  readonly hasApprovalToken?: boolean | undefined
}

export interface RetroReceiptCandidate {
  readonly label: string
  readonly epoch: number
  readonly ballId: string
  readonly data: Record<string, unknown>
}

export interface PlanRetroReceiptsInput {
  readonly currentBall: {
    readonly epoch: number
    readonly ballId: string
    readonly parentBallId: string | null
    readonly entries: Readonly<Record<string, { readonly specifier: string }>>
  }
  readonly existingReceiptsText: string
  readonly persistenceReady: boolean
  readonly chainVerified: boolean
  readonly cloudTotalReceipts?: number | null
  readonly lastPublishOutcome?: {
    readonly ok?: boolean
    readonly resultingBallId?: string | null
    readonly resultingEpoch?: number | null
    readonly expectedParentBallId?: string | null
    readonly hasApprovalToken?: boolean
  } | null
  readonly changedEntriesHint?: readonly string[]
  /** WO-3: stamps operationId/transitionKind onto every planned leaf when present. */
  readonly context?: TransitionContext
}

export function parseReceiptsJsonlForPromotion(rawText: string): {
  readonly valid: boolean
  readonly totalReceipts: number
  readonly promoteReceipts: readonly ParsedPromotionReceipt[]
} {
  let totalReceipts = 0
  const promoteReceipts: ParsedPromotionReceipt[] = []
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return { valid: false, totalReceipts, promoteReceipts: [] }
    }
    if (!record(parsed)) return { valid: false, totalReceipts, promoteReceipts: [] }
    totalReceipts += 1
    const kind = parsed.kind
    if ((kind === 'head.promote' || kind === 'ball.promote') && record(parsed.data)) {
      const d = parsed.data
      promoteReceipts.push({
        kind,
        epoch: typeof d.epoch === 'number' && Number.isSafeInteger(d.epoch) ? d.epoch : undefined,
        ballId: typeof d.ballId === 'string' && d.ballId.length > 0 ? d.ballId : undefined,
        entryId: typeof d.entryId === 'string' && d.entryId.length > 0 ? d.entryId : undefined,
        hasApprovalToken: typeof d.hasApprovalToken === 'boolean' ? d.hasApprovalToken : undefined,
      })
    }
  }
  return { valid: true, totalReceipts, promoteReceipts }
}

export function hasPromotionReceiptInJsonl(
  rawText: string,
  epoch: number,
  ballId?: string | null,
  legacyEntryId?: string,
): boolean {
  const parsed = parseReceiptsJsonlForPromotion(rawText)
  if (!parsed.valid) return true
  return parsed.promoteReceipts.some(
    r => r.epoch === epoch
      || (typeof ballId === 'string' && ballId.length > 0 && r.ballId === ballId)
      || (legacyEntryId !== undefined && r.entryId === legacyEntryId && r.epoch === undefined),
  )
}

/**
 * Lane E5 keep-authoritative dedupe. What is already recorded for `(epoch, ballId)`:
 * `authoritative` when any matching leaf says a Touch ID token was consumed (`hasApprovalToken: true`), `provisional` when
 * every matching leaf explicitly says it was not (`hasApprovalToken: false`), `recorded` for historical leaves that say
 * neither, `none` when nothing matches.
 */
export function promotionReceiptStatus(
  rows: readonly ParsedPromotionReceipt[], epoch: number, ballId?: string | null, legacyEntryId?: string,
): 'none' | 'provisional' | 'authoritative' | 'recorded' {
  const matching = rows.filter(r => r.epoch === epoch
    || (typeof ballId === 'string' && ballId.length > 0 && r.ballId === ballId)
    || (legacyEntryId !== undefined && r.entryId === legacyEntryId && r.epoch === undefined))
  if (matching.length === 0) return 'none'
  if (matching.some(r => r.hasApprovalToken === true)) return 'authoritative'
  return matching.every(r => r.hasApprovalToken === false) ? 'provisional' : 'recorded'
}

/** An incoming leaf that records a consumed owner approval: the only kind allowed to follow a provisional leaf. */
export function isAuthoritativePromotionData(data: Record<string, unknown>): boolean {
  return data.hasApprovalToken === true && data.tier === 'T2' && data.retroactive !== true
}

/**
 * Whether an existing leaf blocks appending `data` for `(epoch, ballId)`. A provisional `hasApprovalToken: false` leaf
 * never blocks the authoritative `true` leaf (it is superseded, append-only); anything else dedupes as before, and an
 * unreadable log blocks.
 */
export function promotionReceiptBlocks(rawText: string, epoch: number, ballId: string, data?: Record<string, unknown>): boolean {
  const parsed = parseReceiptsJsonlForPromotion(rawText)
  if (!parsed.valid) return true
  const status = promotionReceiptStatus(parsed.promoteReceipts, epoch, ballId)
  if (status === 'none') return false
  return !(status === 'provisional' && data !== undefined && isAuthoritativePromotionData(data))
}

/**
 * The leaf that speaks for `(epoch, ballId)`: the first authoritative (`hasApprovalToken: true`) leaf when one exists,
 * otherwise the first matching leaf. A provisional leaf never outranks an authoritative one, whatever the order.
 * @returns the winning leaf's line index and data, how many leaves matched, and whether a provisional one was superseded.
 */
export function selectAuthoritativePromotion(rawText: string, epoch: number, ballId: string): {
  readonly index: number
  readonly data: Record<string, unknown>
  readonly matching: number
  readonly provisionalSuperseded: boolean
} | null {
  const rows: Array<{ index: number; data: Record<string, unknown> }> = []
  rawText.split('\n').forEach((line, index) => {
    if (!line.trim()) return
    try {
      const parsed: unknown = JSON.parse(line)
      if (!record(parsed) || (parsed.kind !== 'head.promote' && parsed.kind !== 'ball.promote') || !record(parsed.data)) return
      if (parsed.data.epoch === epoch || parsed.data.ballId === ballId) rows.push({ index, data: parsed.data })
    } catch { /* an unreadable line never wins */ }
  })
  const authoritative = rows.find(row => row.data.hasApprovalToken === true)
  const winner = authoritative ?? rows[0]
  if (winner === undefined) return null
  return { index: winner.index, data: winner.data, matching: rows.length,
    provisionalSuperseded: authoritative !== undefined && rows.some(row => row.data.hasApprovalToken === false) }
}

export function planIdempotentRetroReceipts(input: PlanRetroReceiptsInput): RetroReceiptCandidate[] {
  if (!input.persistenceReady || !input.chainVerified || input.currentBall.epoch < 63) return []
  const parsed = parseReceiptsJsonlForPromotion(input.existingReceiptsText)
  if (!parsed.valid) return []
  if (typeof input.cloudTotalReceipts === 'number' && Number.isSafeInteger(input.cloudTotalReceipts) && input.cloudTotalReceipts > parsed.totalReceipts) {
    return []
  }
  const seen = [...parsed.promoteReceipts]
  const candidates: RetroReceiptCandidate[] = []
  // Only a promotion this node adopted itself is recorded (below); no receipt is planned for an epoch it never promoted.

  const outcome = input.lastPublishOutcome
  // Keep-authoritative: a provisional (hasApprovalToken:false) leaf never blocks recording the consumed owner approval.
  const liveStatus = promotionReceiptStatus(seen, input.currentBall.epoch, input.currentBall.ballId)
  const supersedesProvisional = liveStatus === 'provisional' && outcome?.hasApprovalToken === true
  if (
    input.currentBall.epoch > 65
    && (liveStatus === 'none' || supersedesProvisional)
    && outcome?.ok === true
    && outcome.resultingBallId === input.currentBall.ballId
    && outcome.resultingEpoch === input.currentBall.epoch
  ) {
    const entryId = input.changedEntriesHint?.[0] ?? 'head-adopted'
    const entrySha = input.currentBall.entries[entryId]?.specifier?.replace(/^ball:/, '') ?? null
    const hasApprovalToken = outcome.hasApprovalToken === true
    seen.push({ kind: 'head.promote', epoch: input.currentBall.epoch, ballId: input.currentBall.ballId, entryId })
    candidates.push({
      label: `epoch-${String(input.currentBall.epoch)}:${entryId}`,
      epoch: input.currentBall.epoch,
      ballId: input.currentBall.ballId,
      data: {
        entryId,
        ballId: input.currentBall.ballId,
        parentBallId: input.currentBall.parentBallId,
        epoch: input.currentBall.epoch,
        ...(entrySha ? { sha256: entrySha } : {}),
        tier: hasApprovalToken ? 'T2' : 'T1',
        hasApprovalToken,
        adopted: true,
        ...(supersedesProvisional ? { supersedesProvisional: true } : {}),
      },
    })
  }

  const context = input.context
  return context ? candidates.map(candidate => ({ ...candidate, data: { ...candidate.data, ...transitionFields(context) } })) : candidates
}

/**
 * Serialize all `head.promote` / `ball.promote` receipt emissions on `(epoch, ballId)` so concurrent
 * WebSocket `ball:commit` sync, `tree_patch`, `promote_staged`, and `ensureRetroPromotionReceipts`
 * callers can never emit two promotion receipts for the same epoch/ballId.
 * New leaves require full 64-hex ball and parent ids and a T1/T2 tier; historical epochs deduplicate unchanged.
 */
export function createSerializedPromotionReceiptAppender(deps: {
  readReceiptsJsonl: () => string
  appendReceipt: (kind: 'head.promote' | 'ball.promote', data: Record<string, unknown>) => Promise<{ ok?: boolean }>
}): (input: {
  kind: 'head.promote' | 'ball.promote'
  epoch: number
  ballId: string
  data: Record<string, unknown>
}) => Promise<{ ok: boolean; deduplicated: boolean }> {
  let queue: Promise<unknown> = Promise.resolve()
  // Lane E5: what this session committed per key; a provisional commit still admits the authoritative leaf once.
  const committedKeys = new Map<string, 'provisional' | 'final'>()
  return (input) => {
    const run = async (): Promise<{ ok: boolean; deduplicated: boolean }> => {
      const key = `${String(input.epoch)}:${input.ballId.trim().toLowerCase()}`
      const authoritative = isAuthoritativePromotionData(input.data)
      const committed = committedKeys.get(key)
      const text = deps.readReceiptsJsonl()
      const parsed = parseReceiptsJsonlForPromotion(text)
      const status = parsed.valid ? promotionReceiptStatus(parsed.promoteReceipts, input.epoch, input.ballId) : 'recorded'
      if ((committed !== undefined && !(committed === 'provisional' && authoritative))
        || promotionReceiptBlocks(text, input.epoch, input.ballId, input.data)) {
        if (committed === undefined) committedKeys.set(key, status === 'provisional' ? 'provisional' : 'final')
        return { ok: true, deduplicated: true }
      }
      // Historical epochs deduplicate before validation; malformed old leaves remain immutable.
      if (!/^[a-f0-9]{64}$/i.test(input.ballId)
        || input.data.ballId !== input.ballId
        || typeof input.data.parentBallId !== 'string' || !/^[a-f0-9]{64}$/i.test(input.data.parentBallId)
        || (input.data.tier !== 'T1' && input.data.tier !== 'T2')) {
        return { ok: false, deduplicated: false }
      }
      const supersedes = authoritative && (committed === 'provisional' || status === 'provisional')
      const res = await deps.appendReceipt(input.kind, supersedes ? { ...input.data, supersedesProvisional: true } : input.data)
      if (res?.ok === true) {
        committedKeys.set(key, input.data.hasApprovalToken === false ? 'provisional' : 'final')
        return { ok: true, deduplicated: false }
      }
      return { ok: false, deduplicated: false }
    }
    const task = queue.then(run, run)
    queue = task.then(() => undefined, () => undefined)
    return task
  }
}

export function classifyHeadManifestTransition(
  previous: BallManifest | null | undefined,
  candidate: BallManifest,
  options: { canonicalManifestMatches?: boolean } = {},
): {
  tier: 'T1' | 'T2'
  requiresPasskey: boolean
  eligibleForT1: boolean
  changedEntryIds: string[]
  singleOrganId: string | null
  t2Reasons: string[]
} {
  const prevEntries = previous?.entries ?? {}
  const candEntries = candidate.entries ?? {}
  const allIds = [...new Set([...Object.keys(prevEntries), ...Object.keys(candEntries)])]
  const changedEntryIds = allIds.filter(
    id => canonicalJsonText(prevEntries[id] ?? null) !== canonicalJsonText(candEntries[id] ?? null),
  )
  const singleOrganId = changedEntryIds.length === 1 ? (changedEntryIds[0] ?? null) : null
  const prevSingle = singleOrganId !== null && Object.hasOwn(prevEntries, singleOrganId)
    ? prevEntries[singleOrganId]
    : undefined
  const candSingle = singleOrganId !== null && Object.hasOwn(candEntries, singleOrganId)
    ? candEntries[singleOrganId]
    : undefined
  const t2Reasons: string[] = []
  if (changedEntryIds.length === 0) {
    t2Reasons.push('NO_ENTRY_CHANGED')
  } else if (changedEntryIds.length > 1) {
    t2Reasons.push('MULTI_ORGAN_TRANSITION')
  } else if (singleOrganId !== null) {
    const baseId = singleOrganId.replace(/:[0-9a-f]{64}$/u, '')
    if (T2_ONLY_ORGANS.includes(baseId) || entryDeclaresGovernance(prevSingle) || entryDeclaresGovernance(candSingle)) {
      t2Reasons.push('T2_PROTECTED_ORGAN')
    }
    if (!prevSingle || !candSingle) {
      t2Reasons.push('ORGAN_ADDED_OR_REMOVED')
    } else {
      if (prevSingle.disabled !== false || candSingle.disabled !== false) {
        t2Reasons.push('ORGAN_DISABLED_STATE_CHANGE')
      }
      if (canonicalJsonText(prevSingle.config ?? {}) !== canonicalJsonText(candSingle.config ?? {})) {
        t2Reasons.push('ORGAN_CONFIG_CHANGED')
      }
    }
  }
  if (options.canonicalManifestMatches === false) {
    t2Reasons.push('NON_CANONICAL_MANIFEST_ID')
  }
  const eligibleForT1 = t2Reasons.length === 0
  return {
    tier: eligibleForT1 ? 'T1' : 'T2',
    requiresPasskey: !eligibleForT1,
    eligibleForT1,
    changedEntryIds,
    singleOrganId,
    t2Reasons,
  }
}

/** Classify one mounted entry; malformed declarations cannot downgrade owner governance.
 * @param id - Exact entry id, including an optional content-hash suffix.
 * @param entry - Selected or candidate entry, never an approval or qualification.
 * @returns Class 3 for fixed or declared governance, otherwise Class 1.
 */
export function classifyEntryGovernance(id: string, entry?: { readonly governance?: unknown; readonly config?: unknown }): 1 | 3 {
  const declaration = (value: { readonly governance?: unknown } | undefined): boolean => value !== undefined
    && Object.hasOwn(value, 'governance') && value.governance !== false
  return protectedOrgans.has(id.replace(/:[0-9a-f]{64}$/, '')) || declaration(entry)
    || (record(entry?.config) && declaration(entry.config)) ? 3 : 1
}

async function boundedHostJson(request: typeof fetch, url: URL, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await request(url, { ...init, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error('HOST_APPROVAL_UNAVAILABLE')
  const reader = response.body?.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  if (!reader) throw new Error('HOST_APPROVAL_UNAVAILABLE')
  let text = '', bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 32768) { await reader.cancel(); throw new Error('HOST_APPROVAL_RESPONSE_LIMIT') }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } finally { reader.releaseLock() }
  const result: unknown = JSON.parse(text)
  if (!record(result) || result.ok !== true) throw new Error('HOST_APPROVAL_UNAVAILABLE')
  return result
}

/**
 * Classify a named runtime operation; unknown operations require mutation admission, never read access.
 * This does not inspect arbitrary JavaScript effects or replace executor authorization.
 * @param action - Operation name or a tool/action request with its exact target id.
 * @param entries - Selected entries used to resolve declarations independently of action arguments.
 * @returns 0 for reads/drafts, 1 for reversible mutations, 2 for append-only history,
 * 3 for owner-only effects, or 4 for inaccessible secrets.
 */
export function classifyActionIrreversibility(action: string | Record<string, unknown>,
  entries: Readonly<Record<string, BallEntryRecord>> = {}): 0 | 1 | 2 | 3 | 4 {
  const input = typeof action === 'string' ? { action } : action
  const name = actionText(input.tool ?? input.name).replace(/_/g, '-')
  const operation = actionText(input.action ?? input.kind ?? input.type).replace(/_/g, '-')
  const targetId = actionText(input.id ?? input.entryId ?? input.organId ?? input.target)
  const target = targetId.replace(/_/g, '-')
  const label = [name, operation, target, actionText(input.path)].join(':').toLowerCase()
  if (/private[-_ ]?key|(?:seven|7)[-_ ]?word[-_ ]?phrase|raw[-_ ]?(?:seven|7)[-_ ]?word/.test(label)
    || /seed[-_ ]?phrase|recovery[-_ ]?phrase|biometric|secret[-_ ]?export/.test(label)) return 4
  if (name === 'x6-repo' && operation === 'merge-proposal') return 3
  if (name === 'x6-repo' && operation === 'compare-files') return 0
  if (name === 'x6-repo' && operation === 'draft-discard') return 1
  if (['x6-facts', 'ball-status', 'self-facts', 'ball-put', 'pearl-put', 'compile-organ', 'trial-candidate', 'trial-retention-candidate', 'stage-head-promotion',
    'stage-organ-promotion', 'x6-browser-estate'].includes(operation || name)
    && input.promote !== true) return 0
  if (['status', 'read', 'list', 'inspect', 'diff', 'log', 'verify', 'challenge', 'trial', 'draft', 'compute', 'attest', 'run', 'compile-and-run', 'fetch', 'search', 'prompt-list', 'config-list',
    'selftest', 'tree', 'diagnostics', 'bytes', 'state-diff', 'versions', 'promotion-status', 'dag-verify', 'dag-lineage', 'recall', 'stats', 'observe'].includes(operation)) return 0
  if ((name === 'seed-receipts' && ['append', 'checkpoint'].includes(operation))
    || (name === 'auma-snapshot' && operation === 'create')) return 2
  const t1QualifiedOrganUpdate = typeof input.qualificationId === 'string' && input.qualificationId.length > 0
    && input.unchangedOtherEntries === true && input.config === undefined && input.disabled === undefined
  const targetGov = classifyEntryGovernance(target, entries[targetId] ?? entries[target]) === 3
    || classifyEntryGovernance(target, input) === 3
  if (!t1QualifiedOrganUpdate && targetGov) return 3
  const actionIds = [actionText(input.tool ?? input.name), actionText(input.action ?? input.kind ?? input.type), name, operation]
  if (!t1QualifiedOrganUpdate && actionIds.some(id => classifyEntryGovernance(id.replace(/_/g, '-'), entries[id]) === 3)) return 3
  // GitHub through the host broker (Round 35): reads are reads; of writes, only an issue or an issue comment on this one
  // repository is reversible-class (the broker checks its text for secrets). Anything else, and the raw gh CLI, stays owner-only.
  if (name === 'x6-github' && operation === 'api') return githubApiClass(input)
  // Private source revisions are reversible even when a filename describes receipt/history code.
  if (name === 'x6-repo' && repoSandboxBranch(input.branch)
    && ['branch-create', 'branch-delete', 'write', 'edit', 'commit', 'stage-proposal'].includes(operation)) return 1
  if (/(?:^|:|[-_])(?:send|publish|spend|pay|purchase|confirm|grant|mint|outbox-flush|push)(?:$|:|[-_])/.test(label)
    || name === 'x6-github' || name === 'x6-cloudflare' || (name === 'x6-repo' && operation === 'exec')) return 3
  const repoPath = actionText(input.path)
  const markdownRepoEdit = name === 'x6-repo' && ['write', 'edit', 'commit'].includes(operation)
    && !repoPath.split('/').some(segment => segment === '..' || segment === '.')
    && !/[\\%]/.test(repoPath)
    && (/^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(repoPath) || /^NORTH-STAR[^/]*\.md$/.test(repoPath))
  const historyLabel = markdownRepoEdit ? [name, operation, target].join(':').toLowerCase() : label
  if (/(?:receipt|checkpoint|history|dag)/.test(historyLabel)) return 2
  return 1
}

/** This repository: the only one whose GitHub data the brokers serve, and whose issues Auma may open or comment on. */
const GITHUB_REPO_PREFIX = 'repos/your_org_x/your-node'
const GITHUB_ISSUE_WRITE = /^repos\/your_org_x\/your-node\/issues(?:\/[1-9][0-9]{0,8}\/comments)?$/
/** Text a comment or an issue may carry at class 1: no leading slash command (a PR's `/delegate` moves approvals) and no
 * @mention (it notifies someone, which cannot be taken back). Anything else needs the owner. */
const githubTextSafe = (value: unknown, max: number): boolean => typeof value === 'string' && value.trim() !== '' && value.length <= max
  && !value.trimStart().startsWith('/') && !/(?:^|[^A-Za-z0-9_`])@[A-Za-z0-9][A-Za-z0-9-]{0,38}/.test(value)
/**
 * Class of one `x6_github` API call. A plain GET of this repository (no body, no CLI args, not GraphQL) is 0. A POST that
 * opens an issue (`{ title, body }`) or comments on one (`{ body }`) in this repository is 1, when its text carries no
 * slash command and no @mention. Every other call is 3 (owner-only).
 * @param input - The tool arguments (`method`, `endpoint`, `body`, `args`).
 * @returns The class.
 */
function githubApiClass(input: Record<string, unknown>): 0 | 1 | 3 {
  const method = input.method === undefined || input.method === null ? null : actionText(input.method).trim().toUpperCase()
  const endpoint = actionText(input.endpoint).trim().replace(/^\/+/, '')
  if (endpoint === '' || input.args !== undefined || /[#\s\\]|\.\./.test(endpoint)) return 3
  if (endpoint.includes('%')) {
    // Only the branch query of the Actions run reader may contain escaped slashes.
    const [path, query, extra] = endpoint.split('?')
    if (extra !== undefined || path !== GITHUB_REPO_PREFIX + '/actions/runs' || !query
      || !query.split('&').every(part => /^branch=auma%2f(?:sandbox|proposal)%2f[a-z0-9][a-z0-9._-]{1,60}$/i.test(part)
        || /^(?:per_page|page)=[1-9][0-9]{0,2}$/.test(part) || /^head_sha=[a-f0-9]{40}$/.test(part))) return 3
    const params = new URLSearchParams(query)
    if (params.getAll('branch').length !== 1 || !repoSandboxBranch(params.get('branch'))
      || params.getAll('per_page').length > 1 || params.getAll('page').length > 1 || params.getAll('head_sha').length > 1) return 3
  }
  const ours = endpoint === GITHUB_REPO_PREFIX || endpoint.startsWith(GITHUB_REPO_PREFIX + '/') || endpoint.startsWith(GITHUB_REPO_PREFIX + '?')
  if ((method === null || method === 'GET') && input.body === undefined) return ours ? 0 : 3
  if (method !== 'POST' || endpoint.includes('?') || !GITHUB_ISSUE_WRITE.test(endpoint) || !record(input.body)) return 3
  const body = input.body
  const keys = Object.keys(body)
  const comment = endpoint.endsWith('/comments')
  if (comment) return keys.length === 1 && githubTextSafe(body.body, 65_536) ? 1 : 3
  return keys.every(key => key === 'title' || key === 'body') && githubTextSafe(body.title, 256)
    && (body.body === undefined || githubTextSafe(body.body, 65_536)) ? 1 : 3
}

function enforceIrreversibleAction(action: string | Record<string, unknown>,
  entries: Readonly<Record<string, BallEntryRecord>> = {}): void {
  const level = classifyActionIrreversibility(action, entries)
  if (level === 4) throw new Error('CLASS4_UNREACHABLE_BY_CONSTRUCTION')
  // No independently trusted owner verifier is installed in this worker. A model flag, receipt,
  // mutable organ verifier or same-origin session cannot open this path.
  if (level === 3) throw new Error('CLASS3_OWNER_SIGNATURE_REQUIRED: independent verification unavailable')
  if (level === 2) {
    const rawOperation = typeof action === 'string' ? action : actionText(action.action ?? action.kind ?? action.type)
    const operation = rawOperation.toLowerCase().replace(/_/g, '-')
    if (!['append', 'create', 'checkpoint', 'dag-write', 'remember', 'correct', 'tombstone', 'forget', 'index-sessions', 'distill'].includes(operation)) throw new Error('X6_HISTORY_APPEND_ONLY')
  }
}

function refuseUnqualifiedMutation(action: Record<string, unknown>): void {
  enforceIrreversibleAction(action)
  throw new Error('PEARL_QUALIFICATION_MISSING_OR_STALE: no executable admission issuer for this operation')
}

function enforceToolInvocation(tool: string, args: unknown, entries: Readonly<Record<string, BallEntryRecord>> = {}): void {
  const action = { ...(record(args) ? args : {}), tool }
  // Lane E4: a repo proposal is staged only from auma/proposal/<slug>, never a sandbox draft branch, main or anything else.
  if (tool.replace(/-/g, '_') === 'x6_repo' && record(args) && args.action === 'stage_proposal' && !isAumaProposalBranch(args.branch)) {
    throw new Error('REPO_PROPOSAL_BRANCH_REFUSED: stage_proposal requires an auma/proposal/<slug> branch')
  }
  enforceIrreversibleAction(action, entries)
  const privateRepoEdit = tool.replace(/-/g, '_') === 'x6_repo' && record(args) && repoSandboxBranch(args.branch)
    && ['write', 'edit', 'commit'].includes(actionText(args.action))
  const isOwnerSessionRepoMutator = (tool.replace(/-/g, '_') === 'x6_repo' || tool.replace(/-/g, '_') === 'x6_head') && record(args)
    && (args.action === 'write' || args.action === 'edit' || args.action === 'commit'
      || args.action === 'dispatch_workflow' || args.action === 'promote_staged'
      || args.action === 'head_rollback' || args.action === 'modules'
      || args.action === 'clear_staged_outward' || args.action === 'transcript'
      || args.action === 'sync_head_to_github'
      || (repoSandboxBranch(args.branch) && ['branch_create', 'branch_delete', 'stage_proposal'].includes(actionText(args.action))))
    && (args.expectedHeadSha === undefined || privateRepoEdit) && args.idempotencyKey === undefined
  // These executors validate their exact candidate or refuse unsupported mutation admissions.
  const unsupportedMutators = ['x6_repo', 'seed_cycle', 'auma_superagent']
  const localRepoDraftDiscard = tool.replace(/-/g, '_') === 'x6_repo' && record(args) && args.action === 'draft_discard'
  if (classifyActionIrreversibility(action) === 1 && !isOwnerSessionRepoMutator && !localRepoDraftDiscard
    && unsupportedMutators.includes(tool.replace(/-/g, '_'))) {
    // The same calls are refused; when the branch name is the only reason, the refusal says so and names the forms.
    const branchRefusal = tool.replace(/-/g, '_') === 'x6_repo' ? repoBranchFormRefusal(args) : null
    if (branchRefusal !== null) throw Object.assign(new Error(branchRefusal), { code: 'REPO_BRANCH_FORM_REFUSED', allowed: AUMA_REPO_BRANCH_FORMS })
    refuseUnqualifiedMutation(action)
  }
}

function publicFacts(value: unknown): Record<string, unknown> {
  if (!record(value)) return {}
  const out: Record<string, unknown> = {}
  const counts = ['epoch', 'organCount', 'activeOrganCount', 'receiptTotal', 'receiptsVerified', 'checkpointsTotal', 'lastCheckpointSeq',
    'lastCheckpointReceiptCount', 'dagReachable', 'dagDeclared', 'pendingBatches', 'pendingPaths', 'generation', 'revision', 'moduleCount']
  for (const key of counts) if (value[key] === null || (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)) out[key] = value[key]
  for (const key of ['ballId', 'parentBallId', 'sourceRevision', 'organSourceCommit', 'runtimeArtifactSha256', 'runtimeReleaseId']) {
    if (typeof value[key] === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value[key])) out[key] = value[key]
  }
  for (const key of ['ok', 'sourceDirty', 'durable', 'readOnly', 'localSaved', 'remoteSaved']) if (typeof value[key] === 'boolean') out[key] = value[key]
  for (const key of ['evidenceStatus', 'auraStatus', 'checkpointSignerTrust', 'receiptVerification', 'checkpointVerification']) {
    if (typeof value[key] === 'string' && /^[a-z0-9-]{1,64}$/.test(value[key])) out[key] = value[key]
  }
  if (typeof value.builtAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value.builtAt)) out.builtAt = value.builtAt
  if (value.protocol === 'x61-cloud-mirror/v1' && typeof value.lineageId === 'string'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.lineageId)) {
    out.protocol = value.protocol
    out.lineageId = value.lineageId
  }
  return out
}

/** The provider doors `x6_consult` speaks to (the host's `/door/<provider>/*`), and the wire each one takes. */
export const CONSULT_PROVIDERS: Readonly<Record<string, 'anthropic' | 'openai'>> = Object.freeze({
  anthropic: 'anthropic', openrouter: 'openai', deepseek: 'openai', openai: 'openai', xai: 'openai', moonshot: 'openai', 'moonshot-cn': 'openai',
})
export const CONSULT_LIMITS = Object.freeze({ targets: 6, promptChars: 64 * 1024, systemChars: 16 * 1024, maxTokens: 16_384,
  defaultMaxTokens: 2048, timeoutMs: 120_000, defaultTimeoutMs: 60_000, answerChars: 32 * 1024 })
export interface ConsultTarget { readonly provider: string; readonly model: string; readonly role: string | null }
export interface ConsultAnswer {
  readonly provider: string
  readonly model: string
  readonly role: string | null
  readonly ok: boolean
  readonly status: number | null
  readonly latencyMs: number
  readonly text: string | null
  readonly truncated: boolean
  readonly code: string | null
  /** The provider's own short reason for a refusal (its error type and message, bounded, key-like strings masked). */
  readonly detail?: string | null
}
/** A provider error, said in its own words but bounded, with anything shaped like a key masked. */
const providerDetail = (parsed: unknown): string | null => {
  const error = record(parsed) && record(parsed.error) ? parsed.error : record(parsed) ? parsed : null
  if (error === null) return null
  const kind = [error.type, error.code].find(value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)) as string | undefined
  const message = typeof error.message === 'string' ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:sk|key|xai|or|pk|rk)[-_][\w-]{6,}/gi, '[masked]').slice(0, 300) : null
  const said = [kind, message].filter((part): part is string => typeof part === 'string' && part !== '').join(': ')
  return said === '' ? null : said
}
/**
 * The composer pill's names (Round 36), so `x6_consult` can be told "Opus 5.5" or "Grok 4.7" as well as a raw id.
 * Each resolves to the provider door and the exact model id the pill runs (`mirror/home/profiles/web/cordis.patch.yml`).
 */
export const CONSULT_ALIASES: Readonly<Record<string, { readonly provider: string; readonly model: string }>> = Object.freeze({
  'deepseek 4.1 flash': { provider: 'deepseek', model: 'deepseek-flash' },
  'deepseek flash': { provider: 'deepseek', model: 'deepseek-flash' },
  'opus 5.5': { provider: 'anthropic', model: 'claude-opus-5-5' },
  'fable 5.2': { provider: 'anthropic', model: 'claude-fable-5-2' },
  'sonnet 5.5': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  'kimi k3.1': { provider: 'openrouter', model: 'moonshotai/kimi-k3.1-pro' },
  'kimi k3.1 pro': { provider: 'openrouter', model: 'moonshotai/kimi-k3.1-pro' },
  'gpt-6.1 sol': { provider: 'openrouter', model: 'openai/gpt-6.1-sol' },
  'gpt astra': { provider: 'openrouter', model: 'openai/gpt-6-astra' },
  'gpt-6 astra': { provider: 'openrouter', model: 'openai/gpt-6-astra' },
  'meta muse': { provider: 'openrouter', model: 'meta/muse-spark-1.3' },
  'meta muse spark 1.3': { provider: 'openrouter', model: 'meta/muse-spark-1.3' },
  'glm 5.3': { provider: 'openrouter', model: 'z-ai/glm-5.3' },
  'gemini argon': { provider: 'openrouter', model: 'google/gemini-4-argon' },
  'gemini 4 argon': { provider: 'openrouter', model: 'google/gemini-4-argon' },
  'grok 4.7': { provider: 'openrouter', model: 'x-ai/grok-4.7' },
})
/** A pill name ("Opus 5.5", "opus-5.5", "GPT-6.1 SOL") to its door and id; anything else is left as given. */
const consultAlias = (name: unknown): { readonly provider: string; readonly model: string } | null => typeof name === 'string'
  ? CONSULT_ALIASES[name.trim().toLowerCase().replace(/[\s_]+/g, ' ').replace(/^(opus|fable|sonnet|kimi|glm|grok)-/, '$1 ')] ?? null
  : null
const CONSULT_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/
const CONSULT_ROLE = /^[A-Za-z0-9][^\u0000-\u001f\u007f]{0,199}$/

/**
 * Ask one model, or a council of up to six in parallel, through the host's own provider doors (`/door/<provider>/*`),
 * which hold the keys and the budget. Each target has a time limit; one failing never stops the others. Nothing here
 * grants anything: the answers are text for Auma to weigh.
 * @param input - `{ provider, model, prompt, system?, maxTokens?, timeoutMs? }`, or a council:
 *   `{ targets: [{ provider, model, role? }], prompt, ... }`.
 * @param deps - Trusted origin, fetch and clock. With a parent, every attempt carries its lifecycle ID and a unique request ID;
 *   without one, this helper makes independent requests. Mounted tools require an acknowledged parent and caller cancellation.
 * @returns `{ ok, answers }` (ok when at least one target answered), or `{ ok: false, code }` for a malformed request.
 */
export async function consultProviders(input: unknown, deps: {
  readonly origin: string | undefined
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly parentTurnId?: string
  readonly signal?: AbortSignal
}): Promise<{ readonly ok: boolean; readonly code?: string; readonly answers?: readonly ConsultAnswer[] }> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const now = deps.now ?? (() => Date.now())
  if (!deps.origin || deps.origin === 'null') return { ok: false, code: 'CONSULT_ORIGIN_UNAVAILABLE' }
  if (!record(input)) return { ok: false, code: 'CONSULT_INPUT_INVALID' }
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  if (prompt.trim() === '' || prompt.length > CONSULT_LIMITS.promptChars) return { ok: false, code: 'CONSULT_PROMPT_INVALID' }
  const system = input.system === undefined || input.system === null ? null : typeof input.system === 'string' ? input.system : undefined
  if (system === undefined || (system !== null && system.length > CONSULT_LIMITS.systemChars)) return { ok: false, code: 'CONSULT_SYSTEM_INVALID' }
  const maxTokens = input.maxTokens === undefined ? CONSULT_LIMITS.defaultMaxTokens : input.maxTokens
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1 || (maxTokens as number) > CONSULT_LIMITS.maxTokens) return { ok: false, code: 'CONSULT_MAX_TOKENS_INVALID' }
  const timeoutMs = input.timeoutMs === undefined ? CONSULT_LIMITS.defaultTimeoutMs : input.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1000 || (timeoutMs as number) > CONSULT_LIMITS.timeoutMs) return { ok: false, code: 'CONSULT_TIMEOUT_INVALID' }
  const single = [{ provider: input.provider, model: input.model, role: input.role }]
  const raw = Array.isArray(input.targets) ? input.targets : input.targets === undefined ? single : null
  if (raw === null || raw.length === 0 || raw.length > CONSULT_LIMITS.targets) return { ok: false, code: 'CONSULT_TARGETS_INVALID' }
  const targets: ConsultTarget[] = []
  for (const given of raw) {
    // A pill name picks both the door and the id when no provider is named (or the one named is its own); a named
    // provider is never silently swapped for another door. A raw id still needs its provider.
    const alias = record(given) ? consultAlias(given.model) : null
    const item = alias === null || !record(given) || (given.provider !== undefined && given.provider !== alias.provider)
      ? given : { ...given, ...alias }
    if (!record(item) || typeof item.provider !== 'string' || !Object.hasOwn(CONSULT_PROVIDERS, item.provider)) return { ok: false, code: 'CONSULT_PROVIDER_UNKNOWN' }
    if (typeof item.model !== 'string' || !CONSULT_MODEL.test(item.model)) return { ok: false, code: 'CONSULT_MODEL_INVALID' }
    const role = item.role === undefined || item.role === null ? null : typeof item.role === 'string' && CONSULT_ROLE.test(item.role) ? item.role : undefined
    if (role === undefined) return { ok: false, code: 'CONSULT_ROLE_INVALID' }
    targets.push({ provider: item.provider, model: item.model, role })
  }
  const ask = async (target: ConsultTarget): Promise<ConsultAnswer> => {
    const started = now()
    const timeoutSignal = AbortSignal.timeout(timeoutMs as number)
    const signal = deps.signal ? AbortSignal.any([deps.signal, timeoutSignal]) : timeoutSignal
    // The parent identifies the lifetime; every council member and fallback has its own journal identity.
    const headers = () => ({ 'content-type': 'application/json',
      ...(deps.parentTurnId ? { 'x-x6-turn-id': deps.parentTurnId, 'x-x6-request-id': randomUUID() }
        : { 'x-x6-turn-id': randomUUID() }) })
    const wire = CONSULT_PROVIDERS[target.provider]
    const persona = target.role === null ? system : `${system ?? ''}${system === null ? '' : '\n\n'}Your role in this council: ${target.role}.`
    const user = { role: 'user', content: prompt }
    // OpenAI's own API takes `max_completion_tokens` (its reasoning models refuse `max_tokens`); the other OpenAI-style doors
    // (OpenRouter, DeepSeek, xAI, Moonshot) take `max_tokens`.
    const cap = target.provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }
    const body = wire === 'anthropic'
      ? { model: target.model, max_tokens: maxTokens, ...(persona === null ? {} : { system: persona }), messages: [user] }
      : { model: target.model, ...cap, stream: false,
        messages: [...(persona === null ? [] : [{ role: 'system', content: persona }]), user] }
    const path = wire === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'
    const answer = (fields: Partial<ConsultAnswer>): ConsultAnswer => ({ provider: target.provider, model: target.model, role: target.role,
      ok: false, status: null, latencyMs: Math.max(0, now() - started), text: null, truncated: false, code: null, ...fields })
    try {
      signal.throwIfAborted()
      const response = await fetchImpl(new URL(`/door/${target.provider}${path}`, deps.origin).href, {
        method: 'POST', headers: headers(), body: JSON.stringify(body), credentials: 'same-origin',
        signal,
      })
      let parsed: unknown = null
      try { parsed = await response.json() } catch { parsed = null }
      signal.throwIfAborted()
      const code = record(parsed) && typeof parsed.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(parsed.code) ? parsed.code : null
      if (!response.ok) {
        if (target.provider === 'anthropic' && (response.status === 401 || response.status === 403 || response.status === 503)) {
          const orModel = target.model.includes('opus')
            ? 'anthropic/claude-opus-4.1'
            : 'anthropic/claude-sonnet-4'
          const fallbackCandidates: ReadonlyArray< readonly [string, string] > = [
            ['openrouter', orModel],
            ['deepseek', 'deepseek-chat'],
          ]
          for (const [fbProvider, fbModel] of fallbackCandidates) {
            try {
              const fbBody = {
                model: fbModel,
                max_tokens: maxTokens,
                stream: false,
                messages: [...(persona === null ? [] : [{ role: 'system', content: persona }]), user],
              }
              signal.throwIfAborted()
              const fbRes = await fetchImpl(new URL(`/door/${fbProvider}/v1/chat/completions`, deps.origin).href, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(fbBody),
                credentials: 'same-origin',
                signal,
              })
              if (fbRes.ok) {
                const fbJson: unknown = await fbRes.json().catch(() => null)
                signal.throwIfAborted()
                const fbText = record(fbJson) && Array.isArray(fbJson.choices) && record(fbJson.choices[0])
                  && record(fbJson.choices[0].message) && typeof fbJson.choices[0].message.content === 'string'
                  ? fbJson.choices[0].message.content
                  : null
                if (fbText !== null && fbText.trim() !== '') {
                  const kept = fbText.length > CONSULT_LIMITS.answerChars ? fbText.slice(0, CONSULT_LIMITS.answerChars) : fbText
                  return answer({ ok: true, status: fbRes.status, text: kept, truncated: fbText.length > CONSULT_LIMITS.answerChars })
                }
              }
            } catch (error) {
              if (signal.aborted) throw error
              // An unavailable fallback may try the next configured provider.
            }
          }
        }
        return answer({ status: response.status, code: code ?? `HTTP_${String(response.status)}`, detail: providerDetail(parsed) })
      }
      const text = !record(parsed) ? null : wire === 'anthropic'
        ? Array.isArray(parsed.content) ? parsed.content.filter(part => record(part) && part.type === 'text' && typeof part.text === 'string')
          .map(part => (part as { text: string }).text).join('') : null
        : Array.isArray(parsed.choices) && record(parsed.choices[0]) && record(parsed.choices[0].message)
          && typeof parsed.choices[0].message.content === 'string' ? parsed.choices[0].message.content : null
      const firstChoice = record(parsed) && Array.isArray(parsed.choices) && record(parsed.choices[0]) ? parsed.choices[0] : null
      const firstMsg = firstChoice && record(firstChoice.message) ? firstChoice.message : null
      const hasReasoning = Boolean(firstMsg && ((typeof firstMsg.reasoning === 'string' && firstMsg.reasoning.trim() !== '')
        || (typeof firstMsg.reasoning_content === 'string' && firstMsg.reasoning_content.trim() !== '')))
      const hitLength = Boolean((record(parsed) && parsed.stop_reason === 'max_tokens') || (firstChoice && firstChoice.finish_reason === 'length'))
      if (text === null) return answer({ status: response.status, code: (hasReasoning || hitLength) ? 'CONSULT_REASONING_EXHAUSTED_MAX_TOKENS' : 'CONSULT_ANSWER_UNREADABLE' })
      if (text.trim() === '') return answer({ status: response.status, code: (hasReasoning || hitLength) ? 'CONSULT_REASONING_EXHAUSTED_MAX_TOKENS' : 'CONSULT_ANSWER_EMPTY' })
      // The provider's own stop at the length cap is a cut-off answer too, not only this page's size cap.
      const stopped = hitLength
      const truncated = stopped || text.length > CONSULT_LIMITS.answerChars
      const kept = text.length > CONSULT_LIMITS.answerChars ? text.slice(0, CONSULT_LIMITS.answerChars) : text
      return answer({ ok: true, status: response.status, text: kept, truncated })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      return answer({ code: deps.signal?.aborted ? 'CONSULT_CANCELLED'
        : signal.aborted || name === 'TimeoutError' || name === 'AbortError' ? 'CONSULT_TIMEOUT' : 'CONSULT_DOOR_UNREACHABLE' })
    }
  }
  const settled = await Promise.allSettled(targets.map(ask))
  const answers = settled.map((result, index): ConsultAnswer => {
    const answer = result.status === 'fulfilled' ? result.value
      : { ...targets[index] as ConsultTarget, ok: false, status: null, latencyMs: 0, text: null, truncated: false, code: 'CONSULT_FAILED' }
    // A cancelled council must not release an earlier member's answer while later members settle.
    return deps.signal?.aborted ? { ...answer, ok: false, text: null, truncated: false, code: 'CONSULT_CANCELLED' } : answer
  })
  return { ok: answers.some(item => item.ok), answers }
}

/**
 * Read bounded same-origin facts using existing session authentication and payload-free projection.
 * @param origin - Current worker origin, never supplied by a model tool argument.
 * @param localBuild - Locally read build metadata used only as an explicitly unverified fallback.
 * @returns Per-source success or fixed failure codes; local fallback never asserts network success or owner approval.
 */
export async function readX6Facts(origin: string | undefined, localBuild: unknown): Promise<Record<string, unknown>> {
  const read = async (path: string): Promise<Record<string, unknown>> => {
    if (!origin || origin === 'null') return { ok: false, error: 'X6_FACTS_ORIGIN_UNAVAILABLE' }
    const controller = new AbortController()
    const timeout = setTimeout(() => { controller.abort() }, 2500)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await fetch(new URL(path, origin), { method: 'GET', mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal })
      if (!response.ok) return { ok: false, error: 'X6_FACTS_HTTP', status: response.status }
      if (Number(response.headers.get('content-length')) > 64 * 1024) return { ok: false, error: 'X6_FACTS_BYTE_LIMIT' }
      if (!response.body) return { ok: false, error: 'X6_FACTS_EMPTY' }
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let bytes = 0; let text = ''
      while (true) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > 64 * 1024) return { ok: false, error: 'X6_FACTS_BYTE_LIMIT' }
        text += decoder.decode(next.value, { stream: true })
      }
      const parsed: unknown = JSON.parse(text + decoder.decode())
      if (!record(parsed) || parsed.ok !== true) return { ok: false, error: 'X6_FACTS_INVALID' }
      const selectedHead = parsed.ball ?? parsed.head ?? parsed
      const validHead = record(selectedHead) && typeof selectedHead.ballId === 'string' && /^[a-f0-9]{64}$/.test(selectedHead.ballId)
        && Number.isSafeInteger(selectedHead.epoch) && Number(selectedHead.epoch) >= 0
      const cloudMirror = parsed.protocol === 'x61-cloud-mirror/v1' && typeof parsed.lineageId === 'string'
        && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(parsed.lineageId)
        && Number.isSafeInteger(parsed.revision) && Number(parsed.revision) >= 0
      const localMirror = Number.isSafeInteger(parsed.moduleCount) && Number(parsed.moduleCount) >= 0
        && Object.hasOwn(parsed, 'head') && (parsed.head === null || validHead)
      const valid = path === '/__x6/facts' ? validHead && parsed.evidenceStatus === 'complete'
        : path === '/_head/ball?meta=1' ? validHead : cloudMirror || localMirror
      if (!valid) return { ok: false, error: 'X6_FACTS_INVALID' }
      return { ...publicFacts(parsed),
        ...(record(parsed.ball ?? parsed.head) ? { head: publicFacts(parsed.ball ?? parsed.head) } : {}), ok: true }
    } catch (_error) {
      return { ok: false, error: controller.signal.aborted ? 'X6_FACTS_TIMEOUT' : 'X6_FACTS_UNAVAILABLE' }
    } finally {
      controller.abort()
      if (reader) void reader.cancel().catch(() => undefined)
      clearTimeout(timeout)
    }
  }
  const facts = await read('/__x6/facts')
  const head = typeof facts.ballId === 'string' && typeof facts.epoch === 'number'
    ? { ok: true, source: '/__x6/facts', ballId: facts.ballId, epoch: facts.epoch }
    : await read('/_head/ball?meta=1')
  const mirror = await read('/_mirror/status?compact=1')
  return { ok: facts.ok === true, facts, head, mirror, localBuild: publicFacts(localBuild),
    evidence: facts.ok === true ? 'host-reported' : 'local-build-fallback-unverified', ownerApproval: false }
}

declare const __X6_BUILD_IDENTITY__: {
  sourceRevision: string | null
  sourceDirty: boolean | null
  builtAt: string | null
  runtimeArtifactSha256: string | null
  /** Legacy exact-suite pin; growth requires the verified baseline below. */
  retentionSuiteDigest?: string | null
  /** Six-field baseline and its digest are injected together by the trusted build, never the VFS. */
  retentionBaselineSuite?: Record<string, unknown> | null
  retentionBaselineDigest?: string | null
} | undefined

/** Complete entry state retained for config-faithful undo. */
export interface BallEntryVersion {
  readonly specifier: string
  readonly config: Record<string, unknown>
  readonly disabled: boolean
}

/** Independent acknowledgments for one selected manifest, never an implied cloud backup. */
export interface BallMutationState {
  readonly ballId: string
  readonly prepared: boolean
  readonly activated: boolean
  readonly localSaved: boolean
  readonly remoteSaved: boolean
  readonly remoteTarget: string | null
  readonly receiptSaved: boolean
  readonly at: number
  readonly errors: Readonly<Record<string, string>>
}

export interface BallEntryRecord {
  readonly id: string
  readonly specifier: string
  readonly config: Record<string, unknown>
  readonly disabled: boolean
  /** Declarative governance is checked independently of the fixed protected ids. */
  readonly governance?: boolean
  readonly previousSpecifiers: readonly string[]
  /** Absent on legacy manifests, whose prior config must not be guessed. */
  readonly previousVersions?: readonly BallEntryVersion[]
  readonly updatedAt: number
}

export interface BallModuleMeta {
  readonly sha256: string
  readonly specifier: string
  readonly name: string
  readonly description: string
  readonly size: number
  readonly createdAt: number
}

export interface BallManifest {
  readonly version: 'x6.1-ball/v1'
  readonly ballId: string
  readonly parentBallId: string | null
  readonly epoch: number
  readonly createdAt: number
  readonly authorPeerId: string
  readonly entries: Readonly<Record<string, BallEntryRecord>>
  readonly modules: Readonly<Record<string, BallModuleMeta>>
}

export interface PresencePeer {
  readonly peerId: string
  readonly kind: 'browser-tab' | 'local-head' | 'cloudflare-do'
  readonly ballId: string
  readonly epoch?: number
  readonly connectedAt: number
  readonly lastSeenAt: number
  readonly url?: string
}

interface CordisFiberLike {
  readonly uid?: number | null
  /** Cordis FiberState (vendor/cordis/src/fiber.ts FiberState): see CORDIS_FIBER_*. */
  readonly state?: number
  /** Service name -> intercept config; every name is required before apply() runs (fiber.ts _refresh). */
  readonly inject?: Readonly<Record<string, unknown>>
  /** Settles once the lifecycle is stable; rethrows the fiber's own startup error when it FAILED. */
  await?(): Promise<unknown>
  dispose(): Promise<void> | void
}
/** The most `ball_status { includeManifest }` answers with (bytes of its JSON). */
const X6_STATUS_BYTE_LIMIT = 64 * 1024
/** Cordis `FiberState` (a const enum, so inlined in vendor/cordis/lib/index.js): PENDING waits for required services. */
const CORDIS_FIBER_PENDING = 0
const CORDIS_FIBER_LOADING = 1
const CORDIS_FIBER_ACTIVE = 2
const CORDIS_FIBER_FAILED = 3
const CORDIS_FIBER_DISPOSED = 4
const CORDIS_FIBER_UNLOADING = 5

interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output?: unknown
  execute(args: unknown, exec: unknown): Promise<unknown>
}

interface WebServiceLike {
  fetch?(req: { url: string; maxLength?: number }): Promise<unknown>
  search?(req: { query: string; limit?: number }): Promise<unknown>
  registerFetchProvider(provider: { id: string; fetch(req: unknown): Promise<unknown> }): () => void
  registerSearchProvider(provider: { id: string; search(req: unknown): Promise<unknown> }): () => void
  config?: {
    fetchProvider?: { get(): string | undefined; set(id: string | undefined): void }
    searchProvider?: { get(): string | undefined; set(id: string | undefined): void }
  }
  __x6Wrapped?: boolean
}

interface SystemPromptServiceLike {
  section(entry: {
    name: string
    order: number
    text: string | ((ctx: unknown) => string | undefined | Promise<string | undefined>)
    interpolate?: boolean
  }): () => void
  context(entry: {
    name: string
    order: number
    text: string | ((ctx: unknown) => string | undefined | Promise<string | undefined>)
    interpolate?: boolean
    required?: boolean
  }): () => void
}

interface ConfigEditorServiceLike {
  list(): Array<Record<string, unknown>>
  read(entryId: string): Record<string, unknown>
  edit(entryId: string, mutation: { disabled?: boolean; config?: unknown }): Record<string, unknown>
  apply(): Promise<void>
}

interface AgentPresetsServiceLike {
  list?(): Array<{ id: string; name?: string; description?: string; order?: number }>
  get?(id: string): unknown
}

interface PromptSectionRecord {
  readonly name: string
  readonly order: number
  readonly text: string
  readonly updatedAt: number
}

export interface AumaSnapshotRecord {
  readonly snapshotId: string
  readonly label: string
  readonly createdAt: number
  readonly ball: BallManifest
  readonly codeBySha: Readonly<Record<string, string>>
  readonly promptSections: Readonly<Record<string, PromptSectionRecord>>
  readonly cordisPatchYml: string
  readonly handoffMd: string
  readonly wishMd: string
}

interface CordisContextLike {
  get(name: string): unknown
  provide(name: string, value?: unknown): void
  plugin(plugin: unknown, config?: unknown): Promise<CordisFiberLike> | CordisFiberLike
  effect?(callback: () => () => void): void
  on?(name: string, listener: (...args: unknown[]) => unknown): () => unknown
  tools?: {
    register(def: unknown, options?: unknown): () => void
    definitions?(scope?: unknown, toolSet?: unknown): readonly ToolDefinitionLike[]
    get?(name: string, scope?: unknown, toolSet?: unknown): ToolDefinitionLike | undefined
  }
  organs?: OrganServiceLike
  web?: WebServiceLike
  systemPrompt?: SystemPromptServiceLike
  configEditor?: ConfigEditorServiceLike
  agentPresets?: AgentPresetsServiceLike
}

interface SeedOrganSpec {
  readonly name: string
  readonly description?: string
  readonly parameters?: Record<string, unknown>
  readonly sha256?: string
  setup?(ctx: unknown): (() => void) | void
  run(args: unknown, ctx: unknown): Promise<unknown> | unknown
}

interface MountedOrganRecord {
  readonly name: string
  readonly sha256: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly updatedAt: number
  readonly run: (args: unknown, ctx: unknown) => Promise<unknown> | unknown
}

interface OrganServiceLike {
  list(): Array<{ name: string; sha256: string; description: string; updatedAt: number }>
  install(
    codeOrInput: string | { name: string; code: string; description?: string; expect?: string },
    opts?: { name?: string; description?: string; expect?: string },
  ): Promise<{
    ok: boolean
    name?: string
    sha256?: string
    specifier?: string
    error?: string
    outcome?: string
    mutation?: BallMutationState
    activationUncertain?: boolean
  }>
  call(name: string, args?: unknown): Promise<unknown>
  undo(name?: string, opts?: { expect?: string }): Promise<{
    ok: boolean
    action?: string
    restoredSha?: string | null
    error?: string
    outcome?: string
    mutation?: BallMutationState
    activationUncertain?: boolean
  }>
  retire(name: string, opts?: { expect?: string }): Promise<{
    ok: boolean
    action?: string
    error?: string
    outcome?: string
    mutation?: BallMutationState
    activationUncertain?: boolean
  }>
}

const BALLS_DIR = '/dsh/home/balls'
const HISTORY_DIR = '/dsh/home/balls/history'

/**
 * Verify every module body a host response carries before any byte reaches the VFS or the loader.
 * Each key must be lowercase SHA-256 hex and each body must be a string whose SHA-256 equals its key. One bad pair
 * refuses the whole set (`BALL_CODE_HASH_MISMATCH`), so a poisoned or partial response can neither store nor later
 * execute code under a name it does not hash to. `undefined`/`null` means the response carried no code.
 * @returns Verified `[sha, code]` pairs in key order.
 */
export function verifyCodeBySha(codeBySha: unknown): Array<[string, string]> {
  if (codeBySha === undefined || codeBySha === null) return []
  if (typeof codeBySha !== 'object' || Array.isArray(codeBySha)) throw new Error('BALL_CODE_HASH_MISMATCH: codeBySha is not a record')
  const verified: Array<[string, string]> = []
  for (const sha of Object.keys(codeBySha)) {
    const code: unknown = (codeBySha as Record<string, unknown>)[sha]
    if (!/^[a-f0-9]{64}$/.test(sha) || typeof code !== 'string' || sha256HexSync(code) !== sha) {
      throw new Error(`BALL_CODE_HASH_MISMATCH: ${JSON.stringify(sha.slice(0, 80))}`)
    }
    verified.push([sha, code])
  }
  return verified
}
/** Fixed VFS review destination; contains neither owner authorization nor a reusable qualification. */
export const STAGED_HEAD_PROMOTION_PATH = '/dsh/home/auma/staged/head-promotion.json'
/**
 * Where one outward Class 3 request waits for the owner's Touch ID (Round 36): a GitHub issue or comment the edge would not
 * post without his approval. It holds the exact path and body; the Sovereignty page shows
 * those bytes, asks the passkey for exactly them, and sends exactly them. Auma proposes here; nothing is sent from it.
 */
export const STAGED_OUTWARD_PATH = '/dsh/home/auma/staged/outward-class3.json'
export const STAGED_OUTWARD_SCHEMA = 'aukora.staged-outward-class3.v1'
export const STAGED_OUTWARD_MAX_BYTES = 256 * 1024
// Review files intentionally have a smaller cap than the host's 16 MiB publish request.
const STAGED_HEAD_PROMOTION_MAX_BYTES = 4 * 1024 * 1024
/** The cold-boot head read fails after this long with no bytes (an idle deadline, not a total cap). */
export const HEAD_READ_IDLE_MS = 20_000
const HEAD_PATH = '/dsh/home/balls/HEAD.json'
const SNAPSHOTS_DIR = '/dsh/home/auma/snapshots'
const LATEST_SNAPSHOT_PATH = '/dsh/home/auma/snapshots/LATEST.json'
const PROMPT_SECTIONS_PATH = '/dsh/home/auma/prompt-sections.json'
const HANDOFF_PATH = '/dsh/home/auma/HANDOFF.md'
/** Legacy home (pre meta-workspace): still mirrored on write for old readers, and read only when the auma copy is absent. */
const AUMA_ONE_HANDOFF_PATH = '/dsh/home/auma-one/HANDOFF.md'
const WORKSPACE_HANDOFF_PATH = '/dsh/workspace/HANDOFF.md'
const WISH_PATH = '/dsh/home/auma/WISH.md'
const CORDIS_PATCH_PATH = '/dsh/home/profiles/web/cordis.patch.yml'
const RETENTION_SUITE_PATH = '/dsh/home/auma/seed/pearl/retention-suite.v1.json'

/**
 * Fill missing named sources from verified active modules. Update an existing file only if it still
 * matches the previously selected module; edited files and unknown ancestry are preserved.
 * @param vfs - Tab-owned filesystem.
 * @param head - Successfully selected manifest.
 * @param previous - Previous selection; absent means existing files are preserved.
 * @returns Named files written, preserved, or missing verified module bytes.
 */
export function hydrateNamedOrganSources(vfs: MemoryVfs, head: BallManifest, previous?: BallManifest): {
  written: string[]
  preserved: string[]
  unavailable: string[]
} {
  const result = { written: [] as string[], preserved: [] as string[], unavailable: [] as string[] }
  const directory = '/dsh/home/auma/seed/organs'
  try { vfs.mkdirSync(directory, { recursive: true }) }
  catch { return { ...result, unavailable: Object.keys(head.entries) } }
  for (const [id, entry] of Object.entries(head.entries)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !/^ball:[a-f0-9]{64}$/.test(entry.specifier)) continue
    try {
      const sha = entry.specifier.slice(5)
      const source = join(BALLS_DIR, `${sha}.js`)
      if (!vfs.existsSync(source)) { result.unavailable.push(id); continue }
      const code = vfs.readFileSync(source, 'utf8') as string
      if (sha256HexSync(code) !== sha) { result.unavailable.push(id); continue }
      const named = `${directory}/${id}.js`
      if (vfs.existsSync(named)) {
        const existing = sha256HexSync(vfs.readFileSync(named, 'utf8') as string)
        if (existing === sha) continue
        if (!previous || previous.entries[id]?.specifier !== `ball:${existing}`) { result.preserved.push(id); continue }
      }
      vfs.writeFileSync(named, code)
      result.written.push(id)
    } catch { result.unavailable.push(id) }
  }
  return result
}

/**
 * Mirror any candidate organ `.js` files from staging/candidates/seed-organs into `/dsh/home/balls/<sha>.js`
 * so `seed-pearl` (`challenge` / `qualify_and_stage`) and `x6_pearl` always find candidate bytes by `ball:<sha256>`.
 */
export function syncCandidateBallsStore(vfs: MemoryVfs): number {
  let synced = 0
  const dirs = ['/dsh/home/auma/seed/staging', '/dsh/home/auma/seed/candidates', '/dsh/home/auma/seed/organs']
  try { vfs.mkdirSync(BALLS_DIR, { recursive: true }) } catch {}
  try { vfs.mkdirSync('/dsh/home/organs', { recursive: true }) } catch {}
  for (const dir of dirs) {
    try {
      if (!vfs.existsSync(dir)) continue
      const entries = vfs.readdirSync(dir)
      for (const name of entries) {
        if (typeof name !== 'string' || !name.endsWith('.js')) continue
        const fullPath = `${dir}/${name}`
        const code = vfs.readFileSync(fullPath, 'utf8') as string
        if (typeof code !== 'string' || code.length === 0) continue
        const sha = sha256HexSync(code)
        const ballFile = join(BALLS_DIR, `${sha}.js`)
        if (!vfs.existsSync(ballFile)) {
          vfs.writeFileSync(ballFile, code)
          synced += 1
        }
        const organFile = `/dsh/home/organs/${sha}.js`
        if (!vfs.existsSync(organFile)) {
          vfs.writeFileSync(organFile, code)
        }
      }
    } catch {}
  }
  return synced
}


function computeBallId(
  parentBallId: string | null,
  epoch: number,
  entries: Readonly<Record<string, BallEntryRecord>>,
  modules: Readonly<Record<string, BallModuleMeta>>,
): string {
  const canonical = JSON.stringify({
    version: 'x6.1-ball/v1',
    parentBallId,
    epoch,
    entries: Object.keys(entries).sort().map(k => entries[k]),
    modules: Object.keys(modules).sort().map(k => modules[k]),
  })
  return sha256HexSync(canonical)
}

// Match the head service's canonicalBootstrap: every own manifest field except ballId is bound.
function computeCanonicalBallId(ball: Omit<BallManifest, 'ballId'> & { readonly ballId?: string }): string {
  let nodes = 0
  const canonical = (value: unknown, depth = 0): string => {
    if (++nodes > 200000 || depth > 64) throw new Error('MANIFEST_STRUCTURE_LIMIT')
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
    if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']'
    if (record(value)) return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}'
    throw new Error('MANIFEST_INVALID_VALUE')
  }
  const { ballId: _ballId, ...withoutId } = ball
  return sha256HexSync(canonical(withoutId))
}

function manifestIdMatches(ball: BallManifest): boolean {
  return ball.ballId === computeBallId(ball.parentBallId, ball.epoch, ball.entries, ball.modules)
    || ball.ballId === computeCanonicalBallId(ball)
}

/** Metadata reads never execute modules, but must validate the same manifest identity before reporting success. */
function publishedHeadManifestValid(ball: Partial<BallManifest> | undefined): ball is BallManifest {
  if (!record(ball) || ball.version !== 'x6.1-ball/v1' || typeof ball.ballId !== 'string' || !/^[a-f0-9]{64}$/.test(ball.ballId)
    || typeof ball.epoch !== 'number' || !Number.isSafeInteger(ball.epoch) || ball.epoch < 0
    || !record(ball.entries) || !record(ball.modules)) return false
  try { return manifestIdMatches(ball as BallManifest) }
  catch (_error) { return false } // Over-deep or otherwise malformed metadata is a failed read, never a successful one.
}

/** Serialize one inert governance candidate for owner review, never execute it or claim admission.
 * @param previous - Current selected head captured by the runtime, not supplied by the staging caller.
 * @param input - Candidate publish envelope; only manifest, module bytes and parent CAS fields are retained.
 * @param stagedAt - Current staging time in milliseconds.
 * @returns Bounded JSON without leases, approvals, credentials or claimed qualification. Invalid inputs throw before writing.
 */
export function serializeStagedHeadPromotion(previous: BallManifest, input: unknown, stagedAt = Date.now()): string {
  const reject = (code: string): never => { throw new Error(code) }
  if (!record(input) || !record(input.ball) || !record(input.codeBySha)) return reject('STAGED_PROMOTION_INVALID')
  const { ball, codeBySha } = input
  const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (ball.version !== 'x6.1-ball/v1' || !isSha(ball.ballId) || !record(ball.entries) || !record(ball.modules)
    || ball.parentBallId !== previous.ballId || ball.epoch !== previous.epoch + 1
    || input.expectedParentBallId !== previous.ballId || input.expectedEpoch !== previous.epoch
    || typeof ball.authorPeerId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(ball.authorPeerId)
    || !Number.isSafeInteger(stagedAt) || stagedAt < 0) return reject('STAGED_PROMOTION_REBASE_OR_MANIFEST_INVALID')
  const body = { ball, codeBySha, expectedParentBallId: previous.ballId, expectedEpoch: previous.epoch }
  let text: string
  try { text = JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt, body }) + '\n' }
  catch (_error) { return reject('STAGED_PROMOTION_INVALID') }
  if (new TextEncoder().encode(text).byteLength > STAGED_HEAD_PROMOTION_MAX_BYTES) return reject('STAGED_PROMOTION_BYTE_LIMIT')
  const fields = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
    Object.keys(value).every(key => allowed.includes(key))
  if (!fields(ball, ['version', 'ballId', 'parentBallId', 'epoch', 'createdAt', 'authorPeerId', 'entries', 'modules'])) return reject('STAGED_PROMOTION_METADATA_REFUSED')
  let nodes = 0
  const canonical = (value: unknown, depth = 0): string => {
    if (++nodes > 200000 || depth > 32) return reject('STAGED_PROMOTION_STRUCTURE_LIMIT')
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
    if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']'
    if (!record(value)) return reject('STAGED_PROMOTION_INVALID')
    return '{' + Object.keys(value).sort().map((key) => {
      const label = key.replace(/[-_]/g, '').toLowerCase()
      if (['__proto__', 'prototype', 'constructor'].includes(key) || /(?:approval|qualification|privatekey|ownerkey|recoveryphrase|seedphrase|passphrase|password|secret|bearer|credential)/.test(label)
        || /^(?:token|accesstoken|refreshtoken|sessiontoken|apikey|authorization|headers|writerlease)$/.test(label)) return reject('STAGED_PROMOTION_PRIVATE_METADATA_REFUSED')
      return JSON.stringify(key) + ':' + canonical(value[key], depth + 1)
    }).join(',') + '}'
  }
  // Canonical validation rejects nested secret-bearing metadata without editing hash-bound fields.
  const { ballId: _ballId, ...withoutId } = ball
  const canonicalId = sha256HexSync(canonical(withoutId))
  const entries = ball.entries, modules = ball.modules
  const entryValid = (entry: unknown): entry is Record<string, unknown> & { specifier: string } => record(entry)
    && typeof entry.specifier === 'string' && Boolean(entry.specifier) && typeof entry.disabled === 'boolean' && record(entry.config)
    && (!Object.hasOwn(entry, 'governance') || typeof entry.governance === 'boolean')
  for (const [id, entry] of Object.entries(entries)) {
    if (!entryValid(entry) || entry.id !== id || !fields(entry, ['id', 'specifier', 'config', 'disabled', 'governance', 'previousSpecifiers', 'previousVersions', 'updatedAt'])
      || !Array.isArray(entry.previousSpecifiers) || entry.previousSpecifiers.some(value => typeof value !== 'string' || !value)
      || (entry.previousVersions !== undefined && (!Array.isArray(entry.previousVersions)
        || entry.previousVersions.some(value => !entryValid(value)
        || !fields(value, ['specifier', 'config', 'disabled', 'governance']))))) return reject('STAGED_PROMOTION_ENTRY_INVALID')
    const previousVersions: readonly unknown[] = Array.isArray(entry.previousVersions) ? entry.previousVersions : []
    const previousSpecifiers: readonly unknown[] = entry.previousSpecifiers
    for (const version of [entry, ...previousVersions, ...previousSpecifiers.map(specifier => ({ specifier }))]) {
      if (!record(version) || typeof version.specifier !== 'string') return reject('STAGED_PROMOTION_ENTRY_INVALID')
      const specifier = version.specifier
      if (specifier.startsWith('ball:') && (!isSha(specifier.slice(5)) || !Object.hasOwn(modules, specifier.slice(5)))) return reject('STAGED_PROMOTION_MODULE_MISSING')
    }
  }
  if (Object.keys(codeBySha).length !== Object.keys(modules).length) return reject('STAGED_PROMOTION_MODULE_SET_MISMATCH')
  for (const [sha, meta] of Object.entries(modules)) {
    if (!isSha(sha) || !record(meta) || meta.sha256 !== sha || meta.specifier !== `ball:${sha}`
      || !fields(meta, ['sha256', 'specifier', 'name', 'description', 'size', 'createdAt'])
      || !Object.hasOwn(codeBySha, sha) || typeof codeBySha[sha] !== 'string' || sha256HexSync(codeBySha[sha]) !== sha) return reject('STAGED_PROMOTION_MODULE_HASH_MISMATCH')
  }
  const plainId = sha256HexSync(JSON.stringify({ version: 'x6.1-ball/v1', parentBallId: ball.parentBallId, epoch: ball.epoch,
    entries: Object.keys(entries).sort().map(id => entries[id]), modules: Object.keys(modules).sort().map(sha => modules[sha]) }))
  if (ball.ballId !== plainId && ball.ballId !== canonicalId) return reject('STAGED_PROMOTION_MANIFEST_HASH_MISMATCH')
  const execution = (entry: unknown): unknown => record(entry)
    ? { specifier: entry.specifier, disabled: entry.disabled, config: entry.config,
      ...(Object.hasOwn(entry, 'governance') ? { governance: entry.governance } : {}) } : null
  const changed = [...new Set([...Object.keys(previous.entries), ...Object.keys(entries)])].filter(id =>
    (classifyEntryGovernance(id, previous.entries[id]) === 3
      || classifyEntryGovernance(id, record(entries[id]) ? entries[id] : undefined) === 3)
    && canonical(execution(previous.entries[id])) !== canonical(execution(entries[id])))
  // KIRA (AURA HANDOFF-5): a candidate that changes no governance entry may still be staged when it is a pure add of
  // 1..8 ordinary organs (HEAD's own rule, organAdditionSetOf); everything else keeps today's refusal.
  if (changed.length === 0 && organAdditionSetOf(previous, ball, sha => typeof codeBySha[sha] === 'string' ? codeBySha[sha] : null) !== null) return text
  if (changed.length !== 1) return reject('STAGED_PROMOTION_SINGLE_GOVERNANCE_REQUIRED')
  return text
}

/**
 * HEAD's structural manifest check (`validateManifestStructure`, server/ball-manifest.mjs, which head-do.mjs and the
 * Sovereignty card's `manifestProblem` share), ported verbatim so a candidate is refused here with the same code HEAD
 * would answer. Hashing is separate.
 * @param ball - candidate manifest.
 * @returns the first refusal (`INVALID_MANIFEST`, `INVALID_ENTRY`, `MODULE_MISSING`, `INVALID_MODULE`) with the entry or
 * module it names, or null.
 */
export function manifestStructureProblem(ball: unknown): { code: 'INVALID_MANIFEST' | 'INVALID_ENTRY' | 'MODULE_MISSING' | 'INVALID_MODULE'; at: string | null } | null {
  const isSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  const versionValid = (entry: unknown): entry is Record<string, unknown> & { specifier: string } => record(entry)
    && typeof entry.specifier === 'string' && entry.specifier.length > 0 && typeof entry.disabled === 'boolean' && record(entry.config)
  if (!record(ball) || ball.version !== 'x6.1-ball/v1' || !isSha(ball.ballId) || (ball.parentBallId !== null && !isSha(ball.parentBallId))
    || !Number.isSafeInteger(ball.epoch) || Number(ball.epoch) < 0 || !record(ball.entries) || !record(ball.modules)) return { code: 'INVALID_MANIFEST', at: null }
  const modules = ball.modules
  for (const [id, entry] of Object.entries(ball.entries)) {
    if (!versionValid(entry) || entry.id !== id || !Array.isArray(entry.previousSpecifiers)
      || entry.previousSpecifiers.some(specifier => typeof specifier !== 'string' || !specifier)
      || (entry.previousVersions !== undefined
        && (!Array.isArray(entry.previousVersions) || entry.previousVersions.some(version => !versionValid(version))))) {
      return { code: 'INVALID_ENTRY', at: id }
    }
    const previousVersions = (entry.previousVersions ?? []) as Array<{ specifier: string }>
    for (const version of [entry, ...previousVersions, ...(entry.previousSpecifiers as string[]).map(specifier => ({ specifier }))]) {
      if (version.specifier.startsWith('ball:') && (!isSha(version.specifier.slice(5)) || !Object.hasOwn(modules, version.specifier.slice(5)))) return { code: 'MODULE_MISSING', at: id }
    }
  }
  for (const [sha, meta] of Object.entries(modules)) {
    if (!isSha(sha) || !record(meta) || meta.sha256 !== sha || meta.specifier !== `ball:${sha}`) return { code: 'INVALID_MODULE', at: sha }
  }
  return null
}

/** One staged single-organ promotion, built from the live HEAD and ready to write and POST. */
export interface OrganPromotionPlan {
  readonly envelope: {
    readonly schema: 'aukora.staged-head-promotion.v1'
    readonly stagedAt: number
    readonly body: {
      readonly ball: BallManifest
      readonly codeBySha: Record<string, string>
      readonly expectedParentBallId: string
      readonly expectedEpoch: number
    }
  }
  readonly text: string
  readonly ball: BallManifest
  readonly entry: BallEntryRecord
  readonly governanceClass: 1 | 3
  readonly tier: 'T1' | 'T2'
  readonly t2Reasons: readonly string[]
  readonly changedEntryIds: readonly string[]
  readonly moduleAdded: boolean
  readonly normalized: readonly string[]
}

const ORGAN_ID_RE = /^[a-z][a-z0-9-]{0,63}$/
// HEAD's passkey binding (headPromotionBinding) names governance organs by this shorter form.
const GOVERNANCE_ORGAN_ID_RE = /^[a-z][a-z0-9-]{0,40}$/
const PRIVATE_CONFIG_KEY = new RegExp('(?:approval|qualification|privatekey|ownerkey|recoveryphrase|seedphrase|passphrase'
  + '|password|secret|bearer|credential)')

/**
 * Lane E4 `stage_organ_promotion`: build the one-organ candidate HEAD will accept, from the live `/_head/ball` answer.
 * Entries and modules are cloned verbatim; only `entries[id]` changes (zero riders). The target entry is normalized the way
 * HEAD validates it: `id === key`, boolean `disabled` (input, else the previous value, else false), object `config` (input,
 * else the previous value, else {}), and `previousSpecifiers` a string array whose every `ball:<sha>` is in `modules`.
 * `modules[sha]` gets sha256/specifier/name/description/size/createdAt and the code must hash to `sha`. parentBallId is the
 * live ballId, epoch is live+1, and ballId is `manifestIdCanon` (canonical JSON of every field but ballId, keys sorted).
 * @param live - the parsed `GET /_head/ball` answer (`ball`, optional `codeBySha`); its module bodies are verified all-or-nothing.
 * @param input - `{ id, specifier, config?, disabled?, description? }` from the tool.
 * @param deps - author peer id, clock and a SHA-keyed code reader (returned code is re-verified).
 * @returns the plan; refusals throw `ORGAN_PROMOTION_*`, `LIVE_HEAD_*`, `BALL_CODE_HASH_MISMATCH` or `STAGED_PROMOTION_BYTE_LIMIT`.
 */
export function buildOrganPromotion(
  live: { readonly ball: unknown; readonly codeBySha?: unknown },
  input: {
    readonly id?: unknown
    readonly specifier?: unknown
    readonly config?: unknown
    readonly disabled?: unknown
    readonly description?: unknown
  },
  deps: { readonly authorPeerId: string; readonly now: number; readCode(sha: string): string | null },
): OrganPromotionPlan {
  const fail = (code: string, detail?: string): never => { throw new Error(detail ? `${code}: ${detail}` : code) }
  const normalized: string[] = []
  // 1. The live head, as HEAD holds it.
  if (!record(live.ball) || live.ball.version !== 'x6.1-ball/v1' || typeof live.ball.ballId !== 'string' || !/^[a-f0-9]{64}$/.test(live.ball.ballId)
    || !Number.isSafeInteger(live.ball.epoch) || !record(live.ball.entries) || !record(live.ball.modules)) return fail('LIVE_HEAD_INVALID')
  const liveBall = live.ball as unknown as BallManifest
  if (!manifestIdMatches(liveBall)) return fail('LIVE_HEAD_MANIFEST_HASH_MISMATCH')
  const liveCode = new Map(verifyCodeBySha(live.codeBySha))
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(deps.authorPeerId)) return fail('ORGAN_PROMOTION_AUTHOR_INVALID')
  if (!Number.isSafeInteger(deps.now) || deps.now < 0) return fail('ORGAN_PROMOTION_CLOCK_INVALID')
  // 2. The request.
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!ORGAN_ID_RE.test(id)) return fail('ORGAN_PROMOTION_ID_INVALID', 'lower kebab-case, 1..64 characters')
  const rawSpecifier = typeof input.specifier === 'string' ? input.specifier.trim() : ''
  const specifier = /^[a-f0-9]{64}$/.test(rawSpecifier) ? `ball:${rawSpecifier}` : rawSpecifier
  if (specifier !== rawSpecifier) normalized.push('specifier:ball-prefix')
  if (!/^ball:[a-f0-9]{64}$/.test(specifier)) return fail('ORGAN_PROMOTION_SPECIFIER_INVALID', 'expected ball:<64 lowercase hex>')
  const sha = specifier.slice(5)
  const prev = Object.hasOwn(liveBall.entries, id) ? liveBall.entries[id] as unknown as Record<string, unknown> : undefined
  let config: Record<string, unknown>
  if (input.config !== undefined) {
    if (!record(input.config)) return fail('ORGAN_PROMOTION_CONFIG_INVALID', 'config must be a JSON object')
    let text: string
    try { text = canonicalJsonText(input.config) } catch { return fail('ORGAN_PROMOTION_CONFIG_INVALID') }
    if (/"(?:__proto__|prototype|constructor)":/.test(text)) return fail('ORGAN_PROMOTION_CONFIG_INVALID')
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return fail('ORGAN_PROMOTION_CONFIG_INVALID', 'config must be plain JSON') }
    if (!record(parsed) || canonicalJsonText(parsed) !== text || canonicalJsonText(input.config) !== canonicalJsonText(JSON.parse(JSON.stringify(input.config)))) return fail('ORGAN_PROMOTION_CONFIG_INVALID', 'config must be plain JSON')
    const keys: string[] = []
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return }
      if (record(value)) for (const [key, child] of Object.entries(value)) { keys.push(key); visit(child) }
    }
    visit(parsed)
    if (keys.some(key => PRIVATE_CONFIG_KEY.test(key.replace(/[-_]/g, '').toLowerCase()))) return fail('ORGAN_PROMOTION_PRIVATE_METADATA_REFUSED')
    config = parsed
  } else if (prev && record(prev.config)) {
    config = JSON.parse(JSON.stringify(prev.config)) as Record<string, unknown>
  } else {
    config = {}
    normalized.push('config:default-empty-object')
  }
  if (input.disabled !== undefined && typeof input.disabled !== 'boolean') return fail('ORGAN_PROMOTION_DISABLED_INVALID', 'disabled must be boolean')
  const disabled = typeof input.disabled === 'boolean' ? input.disabled : typeof prev?.disabled === 'boolean' ? prev.disabled : false
  if (input.disabled === undefined && typeof prev?.disabled !== 'boolean') normalized.push('disabled:default-false')
  // 3. Module bytes, verified.
  const code = liveCode.get(sha) ?? deps.readCode(sha)
  if (typeof code !== 'string') return fail('ORGAN_PROMOTION_CODE_MISSING', `no bytes for ${sha}; ball_put the organ first`)
  if (sha256HexSync(code) !== sha) return fail('BALL_CODE_HASH_MISMATCH', JSON.stringify(sha))
  const modules: Record<string, BallModuleMeta> = JSON.parse(JSON.stringify(liveBall.modules)) as Record<string, BallModuleMeta>
  const existingMeta = modules[sha]
  const moduleAdded = !(record(existingMeta) && existingMeta.sha256 === sha && existingMeta.specifier === specifier)
  if (moduleAdded) {
    const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim().slice(0, 280) : `Seed organ ${id}`
    modules[sha] = { sha256: sha, specifier, name: id, description, size: new TextEncoder().encode(code).byteLength, createdAt: deps.now }
  }
  // 4. The normalized entry.
  const previousSpecifiers: string[] = []
  const dropped: string[] = []
  const keep = (value: unknown): void => {
    if (typeof value !== 'string' || !value || previousSpecifiers.includes(value)) return
    if (value.startsWith('ball:') && (!/^ball:[a-f0-9]{64}$/.test(value) || !Object.hasOwn(modules, value.slice(5)))) { dropped.push(value); return }
    previousSpecifiers.push(value)
  }
  if (prev) {
    if (!Array.isArray(prev.previousSpecifiers)) normalized.push('previousSpecifiers:rebuilt-array')
    for (const value of Array.isArray(prev.previousSpecifiers) ? prev.previousSpecifiers : []) keep(value)
    if (typeof prev.specifier === 'string' && prev.specifier !== specifier) keep(prev.specifier)
  }
  if (dropped.length) normalized.push(`previousSpecifiers:dropped-unresolvable:${String(dropped.length)}`)
  const previousVersions: BallEntryVersion[] = []
  if (prev) {
    const versionOf = (value: unknown): BallEntryVersion | null => record(value) && typeof value.specifier === 'string' && value.specifier
      && (!value.specifier.startsWith('ball:') || Object.hasOwn(modules, value.specifier.slice(5)))
      ? { specifier: value.specifier,
        config: record(value.config) ? JSON.parse(JSON.stringify(value.config)) as Record<string, unknown> : {},
        disabled: typeof value.disabled === 'boolean' ? value.disabled : false } : null
    for (const value of Array.isArray(prev.previousVersions) ? prev.previousVersions : []) {
      const version = versionOf(value)
      if (version) previousVersions.push(version)
    }
    const prior = versionOf(prev)
    const unchanged = prior && prior.specifier === specifier && canonicalJsonText(prior.config) === canonicalJsonText(config)
      && prior.disabled === disabled
    if (unchanged && manifestStructureProblem({ ...liveBall }) === null) return fail('ORGAN_PROMOTION_NO_CHANGE', `${id} already runs ${specifier}`)
    if (prior && !unchanged) previousVersions.push(prior)
  }
  const entry: BallEntryRecord = {
    id, specifier, config, disabled,
    ...(typeof prev?.governance === 'boolean' ? { governance: prev.governance } : {}),
    previousSpecifiers, ...(prev ? { previousVersions } : {}), updatedAt: deps.now,
  }
  if (prev && prev.id !== id) normalized.push('id:set-to-key')
  // 5. The candidate: verbatim clone plus exactly this entry.
  const entries: Record<string, BallEntryRecord> = JSON.parse(JSON.stringify(liveBall.entries)) as Record<string, BallEntryRecord>
  entries[id] = entry
  const body: Omit<BallManifest, 'ballId'> = { version: 'x6.1-ball/v1', parentBallId: liveBall.ballId, epoch: liveBall.epoch + 1,
    createdAt: deps.now, authorPeerId: deps.authorPeerId, entries, modules }
  const ball: BallManifest = { ...body, ballId: computeCanonicalBallId(body) }
  const problem = manifestStructureProblem(ball)
  if (problem) return fail(`ORGAN_PROMOTION_${problem.code}`, problem.at ?? undefined)
  if (computeCanonicalBallId(ball) !== ball.ballId) return fail('ORGAN_PROMOTION_MANIFEST_HASH_MISMATCH')
  const changedEntryIds = [...new Set([...Object.keys(liveBall.entries), ...Object.keys(entries)])]
    .filter(key => canonicalJsonText(liveBall.entries[key] ?? null) !== canonicalJsonText(entries[key] ?? null))
  if (changedEntryIds.length !== 1 || changedEntryIds[0] !== id) return fail('ORGAN_PROMOTION_RIDERS_REFUSED', changedEntryIds.join(','))
  const governanceClass: 1 | 3 = classifyEntryGovernance(id, prev as BallEntryRecord | undefined) === 3
    || classifyEntryGovernance(id, entry) === 3 ? 3 : 1
  if (governanceClass === 3 && !GOVERNANCE_ORGAN_ID_RE.test(id)) return fail('ORGAN_PROMOTION_ID_INVALID', 'governance organ ids are at most 41 characters')
  const transition = classifyHeadManifestTransition(liveBall, ball, { canonicalManifestMatches: true })
  const envelope = { schema: 'aukora.staged-head-promotion.v1' as const, stagedAt: deps.now,
    body: { ball, codeBySha: { [sha]: code }, expectedParentBallId: liveBall.ballId, expectedEpoch: liveBall.epoch } }
  const text = JSON.stringify(envelope) + '\n'
  if (new TextEncoder().encode(text).byteLength > STAGED_HEAD_PROMOTION_MAX_BYTES) return fail('STAGED_PROMOTION_BYTE_LIMIT')
  return { envelope, text, ball, entry, governanceClass, tier: transition.tier, t2Reasons: transition.t2Reasons,
    changedEntryIds, moduleAdded, normalized }
}

/** The most organs one pure-add card may carry (HEAD's `organAdditionSet`, owner-grant-policy.mjs). */
export const ORGAN_SET_MAX = 8

/** Root fields a pure add may change; every other root field must be byte-identical to HEAD. */
export const ORGAN_SET_ROOT_FIELDS = Object.freeze(['ballId', 'parentBallId', 'epoch', 'createdAt', 'authorPeerId', 'entries', 'modules'])
/** The only keys an added entry may carry (AURA's shared rule: `previousVersions: []` and a whole `updatedAt` allowed). */
const ORGAN_SET_ENTRY_KEYS = Object.freeze(['id', 'specifier', 'disabled', 'config', 'previousSpecifiers', 'previousVersions', 'updatedAt'])

export type OrganSetItem = { organId: string; sha256: string; bytes: number }
/**
 * The worker's copy of THE shared organ-set rule (deploy/cloudflare/src/organ-set-rule.mjs `organSetOf`),
 * which must pass the same vectors (server/organ-set-rule.vectors.json). `ball` ADDS 1..8 entries and changes nothing else:
 *  - every root field outside ORGAN_SET_ROOT_FIELDS has the same presence and value (an added field, even null, refused);
 *  - every published entry and module is byte-identical;
 *  - each added id is lower kebab (<= 41 chars), not a fixed governance organ, and its entry is `{ id, specifier, disabled:
 *    false, config: {}, previousSpecifiers: [] }` plus optionally `previousVersions: []` and a non-negative whole
 *    `updatedAt` (no other history, timestamp or governance key);
 *  - every new module is run by exactly one added entry and its metadata names itself; no other new module;
 *  - SIZES ARE NEVER TRUSTED: each organ's size is the UTF-8 length of code that hashes to its sha (`codeOf`); a new
 *    module's declared `size`, when present, must equal it; a new module with unknown verified bytes is refused.
 * @param codeOf - verified bytes for a module sha (live, staged, published or her store), or null.
 * @returns the set sorted by organ id, or null.
 */
export function organAdditionSetOf(
  previous: BallManifest, ball: unknown, codeOf: (sha: string) => string | null,
): OrganSetItem[] | null {
  if (!record(ball) || !record(ball.entries) || !record(ball.modules)) return null
  const prevRoot = previous as unknown as Record<string, unknown>
  for (const key of new Set([...Object.keys(prevRoot), ...Object.keys(ball)])) {
    if (ORGAN_SET_ROOT_FIELDS.includes(key)) continue
    // Presence counts: a root field added or removed, even one valued null, is a change.
    if (Object.hasOwn(prevRoot, key) !== Object.hasOwn(ball, key)) return null
    if (Object.hasOwn(prevRoot, key) && canonicalJsonText(prevRoot[key]) !== canonicalJsonText(ball[key])) return null
  }
  const entries = ball.entries, modules = ball.modules
  for (const [id, entry] of Object.entries(previous.entries)) {
    if (!Object.hasOwn(entries, id) || canonicalJsonText(entry) !== canonicalJsonText(entries[id])) return null
  }
  for (const [sha, meta] of Object.entries(previous.modules)) {
    if (!Object.hasOwn(modules, sha) || canonicalJsonText(meta) !== canonicalJsonText(modules[sha])) return null
  }
  const added = Object.keys(entries).filter(id => !Object.hasOwn(previous.entries, id)).sort()
  if (added.length < 1 || added.length > ORGAN_SET_MAX) return null
  const verifiedBytes = (sha: string): number | null => {
    const code = codeOf(sha)
    return typeof code === 'string' && sha256HexSync(code) === sha ? new TextEncoder().encode(code).byteLength : null
  }
  const owners = new Map<string, number>()
  const set: OrganSetItem[] = []
  for (const id of added) {
    const entry = entries[id]
    if (!GOVERNANCE_ORGAN_ID_RE.test(id) || protectedOrgans.has(id.replace(/:[0-9a-f]{64}$/, '')) || !record(entry)
      || Object.keys(entry).some(key => !ORGAN_SET_ENTRY_KEYS.includes(key)) || entry.id !== id || entry.disabled !== false
      || !record(entry.config) || Object.keys(entry.config).length !== 0
      || !Array.isArray(entry.previousSpecifiers) || entry.previousSpecifiers.length !== 0
      || (entry.previousVersions !== undefined && (!Array.isArray(entry.previousVersions) || entry.previousVersions.length !== 0))
      || (entry.updatedAt !== undefined && (!Number.isSafeInteger(entry.updatedAt) || Number(entry.updatedAt) < 0))
      || typeof entry.specifier !== 'string' || !/^ball:[a-f0-9]{64}$/.test(entry.specifier)) return null
    const sha = entry.specifier.slice(5)
    if (!Object.hasOwn(modules, sha)) return null
    if (!Object.hasOwn(previous.modules, sha)) owners.set(sha, (owners.get(sha) ?? 0) + 1)
    const bytes = verifiedBytes(sha)
    if (bytes === null) return null
    set.push({ organId: id, sha256: sha, bytes })
  }
  for (const [sha, meta] of Object.entries(modules)) {
    if (Object.hasOwn(previous.modules, sha)) continue
    if (owners.get(sha) !== 1 || !record(meta) || meta.sha256 !== sha || meta.specifier !== `ball:${sha}`) return null
    const bytes = verifiedBytes(sha)
    if (bytes === null || (Object.hasOwn(meta, 'size') && meta.size !== bytes)) return null
  }
  return set
}

/** One staged pure-add organ set, built from the live HEAD and ready to write and POST. */
export interface OrganSetPromotionPlan {
  readonly text: string
  readonly ball: BallManifest
  readonly organs: ReadonlyArray<{ organId: string; sha256: string; bytes: number }>
  readonly newModules: readonly string[]
}

/**
 * KIRA (AURA HANDOFF-5 contract) `stage_organ_set_promotion`: one candidate that ADDS 1..8 ordinary organs, built from
 * balls already in her store BY SHA (never inline bytes). The live manifest is cloned verbatim; each organ gets the fixed
 * entry `{ id, specifier, disabled: false, config: {}, previousSpecifiers: [] }` (no config, disabled or governance
 * input exists) and, if new, its module meta; parent = live ballId, epoch = live + 1, ballId = manifestIdCanon;
 * `codeBySha` carries the NEW modules only.
 * @returns the plan; refusals throw `ORGAN_SET_*`, `LIVE_HEAD_*`, `BALL_CODE_MISSING`, `BALL_CODE_HASH_MISMATCH` or
 * `STAGED_PROMOTION_BYTE_LIMIT`.
 */
export function buildOrganSetPromotion(
  live: { readonly ball: unknown; readonly codeBySha?: unknown },
  input: unknown,
  deps: { readonly authorPeerId: string; readonly now: number; readCode(sha: string): string | null },
): OrganSetPromotionPlan {
  const fail = (code: string, detail?: string): never => { throw new Error(detail ? `${code}: ${detail}` : code) }
  if (!record(live.ball) || live.ball.version !== 'x6.1-ball/v1' || typeof live.ball.ballId !== 'string' || !/^[a-f0-9]{64}$/.test(live.ball.ballId)
    || !Number.isSafeInteger(live.ball.epoch) || !record(live.ball.entries) || !record(live.ball.modules)) return fail('LIVE_HEAD_INVALID')
  const liveBall = live.ball as unknown as BallManifest
  if (!manifestIdMatches(liveBall)) return fail('LIVE_HEAD_MANIFEST_HASH_MISMATCH')
  const liveCode = new Map(verifyCodeBySha(live.codeBySha))
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(deps.authorPeerId)) return fail('ORGAN_SET_AUTHOR_INVALID')
  if (!Number.isSafeInteger(deps.now) || deps.now < 0) return fail('ORGAN_SET_CLOCK_INVALID')
  if (!record(input) || Object.keys(input).some(key => !['organs', 'replaceStaged', 'expectedStagedSha256'].includes(key))) return fail('ORGAN_SET_INPUT_INVALID', 'only organs, replaceStaged, expectedStagedSha256')
  const organs = input.organs
  if (!Array.isArray(organs) || organs.length < 1 || organs.length > ORGAN_SET_MAX) return fail('ORGAN_SET_INPUT_INVALID', `1..${String(ORGAN_SET_MAX)} organs`)
  const seen = new Set<string>()
  const wanted: Array<{ id: string; sha: string; description: string }> = []
  for (const organ of organs) {
    if (!record(organ) || Object.keys(organ).some(key => !['id', 'specifier', 'description'].includes(key))) return fail('ORGAN_SET_INPUT_INVALID', 'each organ is { id, specifier, description? }')
    const id = organ.id, specifier = organ.specifier
    if (typeof id !== 'string' || !GOVERNANCE_ORGAN_ID_RE.test(id)) return fail('ORGAN_SET_INPUT_INVALID', 'id: lower kebab-case, 1..41 characters')
    if (typeof specifier !== 'string' || !/^ball:[a-f0-9]{64}$/.test(specifier)) return fail('ORGAN_SET_INPUT_INVALID', `${id}: specifier must be ball:<64 lowercase hex>`)
    if (organ.description !== undefined && typeof organ.description !== 'string') return fail('ORGAN_SET_INPUT_INVALID', `${id}: description must be a string`)
    if (seen.has(id)) return fail('ORGAN_SET_INPUT_INVALID', `duplicate id ${id}`)
    seen.add(id)
    if (Object.hasOwn(liveBall.entries, id)) return fail('ORGAN_SET_NOT_AN_ADD', `${id} already exists`)
    if (protectedOrgans.has(id.replace(/:[0-9a-f]{64}$/, ''))) return fail('ORGAN_SET_GOVERNANCE_REFUSED', id)
    const description = typeof organ.description === 'string' && organ.description.trim() ? organ.description.trim().slice(0, 280) : `Seed organ ${id}`
    wanted.push({ id, sha: specifier.slice(5), description })
  }
  const entries: Record<string, BallEntryRecord> = JSON.parse(JSON.stringify(liveBall.entries)) as Record<string, BallEntryRecord>
  const modules: Record<string, BallModuleMeta> = JSON.parse(JSON.stringify(liveBall.modules)) as Record<string, BallModuleMeta>
  const codeBySha: Record<string, string> = {}
  for (const { id, sha, description } of wanted) {
    const code = liveCode.get(sha) ?? deps.readCode(sha)
    if (typeof code !== 'string') return fail('BALL_CODE_MISSING', `no bytes for ${sha}; ball_put the organ first`)
    if (sha256HexSync(code) !== sha) return fail('BALL_CODE_HASH_MISMATCH', JSON.stringify(sha))
    // Exactly the contract's entry (AURA HANDOFF-5): no updatedAt, config or governance is invented for an ordinary add.
    entries[id] = { id, specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } as unknown as BallEntryRecord
    if (!Object.hasOwn(modules, sha)) {
      modules[sha] = { sha256: sha, specifier: `ball:${sha}`, name: id, description, size: new TextEncoder().encode(code).byteLength, createdAt: deps.now }
    }
    if (!Object.hasOwn(liveBall.modules, sha)) codeBySha[sha] = code
  }
  // The COMPLETE live manifest is cloned and only the permitted fields replaced, so an unchanged extra root field
  // (a label, say) is kept byte for byte instead of dropped (that dropped field made a valid
  // live manifest fail ORGAN_SET_NOT_A_PURE_ADD).
  const { ballId: _liveBallId, ...liveRest } = JSON.parse(JSON.stringify(liveBall)) as BallManifest
  const body: Omit<BallManifest, 'ballId'> = { ...liveRest, parentBallId: liveBall.ballId, epoch: liveBall.epoch + 1,
    createdAt: deps.now, authorPeerId: deps.authorPeerId, entries, modules }
  const ball: BallManifest = { ...body, ballId: computeCanonicalBallId(body) }
  const problem = manifestStructureProblem(ball)
  if (problem) return fail(`ORGAN_SET_${problem.code}`, problem.at ?? undefined)
  const set = organAdditionSetOf(liveBall, ball, sha => codeBySha[sha] ?? liveCode.get(sha) ?? deps.readCode(sha))
  if (set === null) return fail('ORGAN_SET_NOT_A_PURE_ADD')
  const envelope = { schema: 'aukora.staged-head-promotion.v1' as const, stagedAt: deps.now,
    body: { ball, codeBySha, expectedParentBallId: liveBall.ballId, expectedEpoch: liveBall.epoch } }
  const text = JSON.stringify(envelope) + '\n'
  if (new TextEncoder().encode(text).byteLength > STAGED_HEAD_PROMOTION_MAX_BYTES) return fail('STAGED_PROMOTION_BYTE_LIMIT')
  return { text, ball, organs: set, newModules: Object.keys(codeBySha).sort() }
}

/** The leading typed code of a thrown refusal (`CODE: detail` → `CODE`). */
export function refusalCode(error: unknown, fallback = 'UNEXPECTED_ERROR'): string {
  const message = error instanceof Error ? error.message : String(error)
  return /^[A-Z][A-Z0-9_]{2,80}/.exec(message)?.[0] ?? fallback
}

function emptyManifest(peerId: string): BallManifest {
  const entries: Record<string, BallEntryRecord> = {}
  const modules: Record<string, BallModuleMeta> = {}
  const ballId = computeBallId(null, 0, entries, modules)
  return {
    version: 'x6.1-ball/v1',
    ballId,
    parentBallId: null,
    epoch: 0,
    createdAt: Date.now(),
    authorPeerId: peerId,
    entries,
    modules,
  }
}

function getX6Services(): Record<string, unknown> {
  return ((globalThis as { __X6_SERVICES__?: Record<string, unknown> }).__X6_SERVICES__) ?? {}
}

function wrapSeedOrganAsCordisPlugin(spec: SeedOrganSpec, mount: (spec: SeedOrganSpec) => () => void): Record<string, unknown> {
  const organName = String(spec.name || 'seed-organ').trim()
  const underscoreName = organName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/-/g, '_')
  const description = String(spec.description ?? `Seed organ ${organName}`)
  const parameters = (spec.parameters && typeof spec.parameters === 'object')
    ? spec.parameters
    : { type: 'object', properties: {}, additionalProperties: true }

  return {
    name: `seed-organ:${organName}`,
    inject: ['tools', 'presence', 'organs'],
    __seedOrgan: spec,
    apply(ctx: CordisContextLike) {
      const unmountOrgan = mount(spec)
      const organCtx = {
        get organs() { return getX6Services().organs ?? ctx.organs },
        get presence() { return getX6Services().presence ?? ctx.get('presence') },
        get tools() { return ctx.tools ?? getX6Services().tools },
        get web() { return (getX6Services().web ?? ctx.get('web')) as WebServiceLike | undefined },
        get systemPrompt() { return (getX6Services().systemPrompt ?? ctx.get('systemPrompt')) as SystemPromptServiceLike | undefined },
        get configEditor() { return (getX6Services().configEditor ?? ctx.get('configEditor')) as ConfigEditorServiceLike | undefined },
        get agentPresets() { return (getX6Services().agentPresets ?? ctx.get('agentPresets')) as AgentPresetsServiceLike | undefined },
        get fs() { return getX6Services().fs ?? ctx.get('fs') },
        get snapshots() { return getX6Services().snapshots ?? ctx.get('snapshots') },
        get scion() { return getX6Services().scion },
        get checkpointPolicy() { return ctx.get('checkpointPolicy') },
        // Round 37: pinned, metered Wasm cells (x6/wasm-cells.ts): pure computation, no imports, fresh fuel per call.
        get wasm() { return workerCellHost() },
      }
      const toolSpec = {
        description,
        inputSchema: parameters,
        async execute(args: unknown) {
          enforceToolInvocation(organName, args)
          try {
            if (organCtx.fs) syncCandidateBallsStore(organCtx.fs as MemoryVfs)
          } catch {}
          const organsSvc = organCtx.organs as OrganServiceLike | undefined
          if ((organName === 'seed-aura' || organName === 'seed_aura') && typeof organsSvc?.call === 'function') {
            return toLosslessJson(await organsSvc.call('seed-aura', args))
          }
          const out = await spec.run((args && typeof args === 'object') ? args : {}, organCtx)
          return toLosslessJson(out)
        },
      }
      const disposers: Array<() => void> = [unmountOrgan]
      const beforeSetupTools = new Set((ctx.tools?.definitions?.() ?? []).map(d => d.name))
      if (typeof spec.setup === 'function') {
        try {
          const setupDispose = spec.setup(organCtx)
          if (typeof setupDispose === 'function') disposers.push(setupDispose)
        } catch (setupErr) {
          for (const dispose of disposers.reverse()) dispose()
          throw setupErr
        }
      }
      const afterSetupTools = new Set((ctx.tools?.definitions?.() ?? []).map(d => d.name))
      const setupRegisteredOwnTool = [...afterSetupTools].some(n => !beforeSetupTools.has(n))
      // Register canonical underscore tool name only so LLM tool definitions are never duplicated with hyphen/underscore pairs.
      // A registration the registry refuses (a name another plugin holds, a reserved transport name such as
      // `run_code`) fails this mount and says why; before, it was swallowed and the organ "ran" with no tool.
      if (!setupRegisteredOwnTool) {
        try {
          const d2 = ctx.tools?.register(underscoreName, toolSpec)
          if (typeof d2 === 'function') disposers.push(d2)
        } catch (registerErr) {
          for (const dispose of disposers.splice(0).reverse()) {
            try { dispose() } catch {}
          }
          const why = registerErr instanceof Error ? registerErr.message : String(registerErr)
          throw loaderFault('TOOL_REGISTRATION_REFUSED', organName,
            `the tool registry refused the tool ${underscoreName} of entry ${organName}: ${why.slice(0, 160)}`, { toolName: underscoreName })
        }
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          for (const d of disposers.splice(0)) {
            try { d() } catch {}
          }
        })
      }
    },
  }
}

function unwrapPluginExport(raw: unknown, mount: (spec: SeedOrganSpec) => () => void): unknown {
  let plugin: unknown = raw
  if (typeof raw === 'object' && raw !== null) {
    const rec = raw as Record<string, unknown>
    if (typeof rec.apply === 'function') {
      plugin = { ...rec }
    } else if (typeof rec.run === 'function' && typeof rec.name === 'string') {
      plugin = wrapSeedOrganAsCordisPlugin(rec as unknown as SeedOrganSpec, mount)
    } else if (rec.default !== undefined) {
      if (typeof rec.default === 'function') {
        plugin = rec.default
      } else if (typeof rec.default === 'object' && rec.default !== null) {
        const defRec = rec.default as Record<string, unknown>
        if (typeof defRec.apply === 'function') {
          plugin = { ...defRec }
        } else if (typeof defRec.run === 'function' && typeof defRec.name === 'string') {
          plugin = wrapSeedOrganAsCordisPlugin(defRec as unknown as SeedOrganSpec, mount)
        }
      }
    }
  }
  if ((typeof plugin === 'function' || (typeof plugin === 'object' && plugin !== null)) && (plugin as { inject?: unknown }).inject === undefined) {
    try {
      ;(plugin as { inject?: unknown }).inject = ['tools', 'presence', 'organs']
    } catch {}
  }
  return plugin
}

/**
 * A module whose exports carry functions but neither `apply()` (a Cordis plugin), a default plugin, nor `{ name, run }`
 * (a Seed organ): a support module, by its own exports, with nothing to mount (for example `seed-voice-slot`, a library
 * of named functions). No manifest field marks it; its exports decide.
 * An export that LOOKS like an organ (a string `name`, or `execute`, or `setup`: for example the defineTool shape
 * `{ name, description, execute() }`) is never a support module: it is a broken organ, not-running with
 * BALL_MODULE_NOT_A_PLUGIN.
 */
function isSupportModuleExport(raw: unknown): boolean {
  if (!record(raw) || raw.default !== undefined || typeof raw.apply === 'function' || typeof raw.run === 'function') return false
  if (typeof raw.name === 'string' || raw.execute !== undefined || raw.setup !== undefined) return false
  return Object.values(raw).some(value => typeof value === 'function')
}

/**
 * Why a HEAD entry does not run, when the loader itself decided it (the name check, the exports, the tool
 * registry's refusal). The fault is recorded in this module-private map, keyed by the very error the loader threw and
 * bound to its entry, so nothing a plugin throws can pass for one: a thrown object's own properties never classify it
 * (`Object.assign(Error(..), { supportModule: true })` thrown by apply() was reported as a support module).
 */
interface LoaderFault {
  readonly code: string
  readonly entryId: string
  readonly fields: Readonly<Record<string, string>>
}
const loaderFaults = new WeakMap<object, LoaderFault>()
function loaderFault(code: string, entryId: string, message: string, fields: Record<string, string> = {}): Error {
  const error = new Error(`${code}: ${message}`)
  loaderFaults.set(error, { code, entryId, fields })
  return error
}
/** The loader's own fault for this entry, or null (a plugin's own error, whatever it carries). */
function loaderFaultFor(error: unknown, entryId: string): LoaderFault | null {
  const fault = typeof error === 'object' && error !== null ? loaderFaults.get(error) : undefined
  return fault !== undefined && fault.entryId === entryId ? fault : null
}

function isValidPlugin(plugin: unknown): boolean {
  if (typeof plugin === 'function') return true
  if (typeof plugin === 'object' && plugin !== null && typeof (plugin as { apply?: unknown }).apply === 'function') {
    return true
  }
  return false
}

function toLosslessJson(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value !== 'object' || value === null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

/**
 * Normalize shorthand `ctx.tools.register(name, spec)` or `ctx.tools.register({ name, execute })`
 * into a full DSH `ToolDefinition` if `output.render` was omitted by an agent-authored plugin.
 */
function normalizeShorthandToolDefinition(arg1: unknown, arg2?: unknown): { definition: unknown; options: unknown } {
  if (typeof arg1 === 'string' && typeof arg2 === 'object' && arg2 !== null) {
    const spec = arg2 as Record<string, unknown>
    const rawSchema = (spec.inputSchema ?? spec.parameters ?? {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }) as Record<string, unknown>
    const parameters = {
      type: 'object',
      properties: (rawSchema.properties as Record<string, unknown> | undefined) ?? {},
      additionalProperties: rawSchema.additionalProperties === true,
      ...(Array.isArray(rawSchema.required) ? { required: rawSchema.required } : {}),
    }
    const userExec = spec.execute as (args: unknown, exec: unknown) => Promise<unknown>
    return {
      definition: {
        name: arg1,
        description: String(spec.description ?? `Cordis tool ${arg1}`),
        parameters,
        output: {
          schema: {},
          render(_args: unknown, value: unknown) {
            const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
            return [{ type: 'text', text }]
          },
        },
        async execute(args: unknown, exec: unknown) {
          const res = await userExec(args, exec)
          if (res && typeof res === 'object' && 'output' in (res as Record<string, unknown>) && Object.keys(res as object).length === 1) {
            return toLosslessJson((res as { output: unknown }).output)
          }
          return toLosslessJson(res ?? null)
        },
      },
      options: {},
    }
  }
  if (typeof arg1 === 'object' && arg1 !== null) {
    const def = arg1 as Record<string, unknown>
    if (def.output === undefined && typeof def.name === 'string' && typeof def.execute === 'function') {
      return normalizeShorthandToolDefinition(def.name, def)
    }
  }
  return { definition: arg1, options: arg2 ?? {} }
}

export interface X6BallRuntime {
  readonly peerId: string
  status(): {
    ok: true
    self: PresencePeer
    peerId: string
    ballId: string
    parentBallId: string | null
    epoch: number
    entries: Readonly<Record<string, BallEntryRecord>>
    entryGovernanceClasses: Readonly<Record<string, 1 | 3>>
    modules: Readonly<Record<string, BallModuleMeta>>
    activeFibers: string[]
    peers: PresencePeer[]
    registeredTools: string[]
  }
  ballPut(input: { code: string; name?: string | undefined; description?: string | undefined }): Promise<BallModuleMeta>
  treePatch(input: {
    id: string
    specifier?: string | undefined
    sha?: string | undefined
    config?: Record<string, unknown> | undefined
    disabled?: boolean | undefined
    expectedEpoch?: number | undefined
    expectedBallId?: string | undefined
    /** Required runtime-issued candidate/head/suite-bound behavioral admission, never owner approval. */
    qualificationId?: string | undefined
  }): Promise<{ ok: true; ball: BallManifest; entry: BallEntryRecord; elapsedMs: number; mutation: BallMutationState }>
  treeUndo(input?: { id?: string | undefined; expectedBallId?: string | undefined }): Promise<{
    ok: true
    action: 'reverted' | 'removed'
    restoredSha: string | null
    ball: BallManifest
    revertedId: string
    previousSpecifier: string | null
    mutation: BallMutationState
  }>
  handleControlRequest(method: string, path: string, bodyText: string): Promise<{ status: number; body: unknown } | null>
  /** Lane E6: resident read-only capability index (auma-cortex Tier A); recomputed on promotion, zero I/O. */
  capabilityIndex(): CapabilityIndex
}

export async function mountX6BallRuntime(
  hostCtx: CordisContextLike,
  vfs: MemoryVfs,
  loader: WorkerModuleLoader,
): Promise<X6BallRuntime> {
  // Lane E6 (G1 live): every write this runtime makes through its VFS is recorded and classified against RUNTIME_WRITE_SET.
  vfs = liveWriteSet.wrap(vfs, 'ball-loader')
  const peerId = `x6-tab-${Math.random().toString(36).slice(2, 10)}`
  let mutationQueue: Promise<unknown> = Promise.resolve()
  const serializeMutation = <T>(run: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(run)
    mutationQueue = result.catch(() => undefined)
    return result
  }
  let lastMutation: BallMutationState | null = null
  const preparedModules = new Map<string, BallModuleMeta>()
  // Process-local admissions cannot be minted by editing a receipt or supplying passing flags.
  const retentionAdmissions = new Map<string, {
    organId: string
    specifier: string
    headBallId: string
    suiteDigest: string
    issuedAt: number
  }>()
  const currentSuiteDigest = (): string => {
    const text = vfs.readFileSync(RETENTION_SUITE_PATH, 'utf8') as string
    if (new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new Error('PEARL_SUITE_LIMIT')
    const suite: unknown = JSON.parse(text)
    if (!record(suite)) throw new Error('PEARL_SUITE_INVALID')
    return retentionSuiteDigest(suite)
  }
  const requireRetentionAdmission = (id: string, specifier: string, qualificationId?: string): void => {
    enforceIrreversibleAction({ action: 'tree_patch', id }, currentBall.entries)
    const admission = qualificationId ? retentionAdmissions.get(qualificationId) : undefined
    const now = Date.now()
    if (!admission || admission.organId !== id || admission.specifier !== specifier || admission.headBallId !== currentBall.ballId
      || now < admission.issuedAt || now - admission.issuedAt > 5 * 60 * 1000 || currentSuiteDigest() !== admission.suiteDigest) {
      throw new Error('PEARL_QUALIFICATION_MISSING_OR_STALE')
    }
  }
  const appendHistoricalFile = (path: string, text: string): void => {
    if (vfs.existsSync(path)) {
      if (vfs.readFileSync(path, 'utf8') !== text) throw new Error('X6_HISTORY_APPEND_ONLY')
      return
    }
    vfs.writeFileSync(path, text)
  }
  const requireManifestAdmission = (target: BallManifest): void => {
    const changed = [...new Set([...Object.keys(currentBall.entries), ...Object.keys(target.entries)])]
      .filter(id => JSON.stringify(currentBall.entries[id]) !== JSON.stringify(target.entries[id]))
    for (const id of changed) {
      enforceIrreversibleAction({ action: 'tree_patch', id }, currentBall.entries)
      enforceIrreversibleAction({ action: 'tree_patch', id }, target.entries)
    }
    // Multi-entry adoption and restore have no executable admission issuer. They cannot borrow
    // an admission for one organ or treat an authenticated host response as owner approval.
    if (target.ballId !== currentBall.ballId) throw new Error('PEARL_QUALIFICATION_MISSING_OR_STALE')
  }
  const seedCandidates: Record<string, string> = {}
  let retainedLocalFork: string | null = null
  let hasRemoteHead = false
  vfs.mkdirSync(BALLS_DIR, { recursive: true })
  vfs.mkdirSync(HISTORY_DIR, { recursive: true })

  const motorMemory = new Map<string, {
    calls: number
    errors: number
    totalMs: number
    avgMs: number
    lastCalledAt: number
    lastError?: string
  }>()
  const effectLedger = new Map<string, {
    id: string
    specifier: string
    mountedAt: number
    toolsBefore: number
    toolsAfter: number
    toolsAdded: string[]
  }>()

  // Enhance ToolsService.prototype.register so agent-authored plugins can use either
  // `defineTool(...)` OR shorthand `ctx.tools.register('my_tool', { description, inputSchema, execute })`
  // AND record Motor Memory telemetry (calls, errors, latency) on every tool invocation!
  const toolsInstance = hostCtx.tools
  if (toolsInstance && typeof toolsInstance.register === 'function') {
    const proto = Object.getPrototypeOf(toolsInstance) as {
      register?: (def: unknown, opts?: unknown) => () => void
      get?: (name: string, scope?: unknown, toolSet?: unknown) => ToolDefinitionLike | undefined
      __x6Wrapped?: boolean
    } | null
    if (proto && typeof proto.register === 'function' && !proto.__x6Wrapped) {
      const origRegister = proto.register
      const origGet = typeof proto.get === 'function' ? proto.get : null
      if (origGet) {
        proto.get = function (this: unknown, name: string, scope?: unknown, toolSet?: unknown): ToolDefinitionLike | undefined {
          const direct = origGet.call(this, name, scope, toolSet)
          if (direct !== undefined || typeof name !== 'string' || !name.includes('-')) return direct
          return origGet.call(this, name.replace(/-/g, '_'), scope, toolSet)
        }
      }
      proto.register = function (this: unknown, arg1: unknown, arg2?: unknown): () => void {
        const { definition, options } = normalizeShorthandToolDefinition(arg1, arg2)
        if (definition && typeof definition === 'object' && 'execute' in (definition as object)) {
          const defRec = definition as { name?: string; execute?: (args: unknown, exec: unknown) => Promise<unknown> }
          const toolName = String(defRec.name || 'unknown')
          const origExec = defRec.execute
          if (typeof origExec === 'function') {
            defRec.execute = async function (args: unknown, exec: unknown) {
              enforceToolInvocation(toolName, args, currentBall.entries)
              const t0 = performance.now()
              const prev = motorMemory.get(toolName) ?? { calls: 0, errors: 0, totalMs: 0, avgMs: 0, lastCalledAt: 0 }
              toolsInFlight += 1
              try {
                const res = await origExec.call(this, args, exec)
                const dt = Math.round((performance.now() - t0) * 100) / 100
                const calls = prev.calls + 1
                const totalMs = Math.round((prev.totalMs + dt) * 100) / 100
                motorMemory.set(toolName, {
                  calls,
                  errors: prev.errors,
                  totalMs,
                  avgMs: Math.round((totalMs / calls) * 100) / 100,
                  lastCalledAt: Date.now(),
                  ...(prev.lastError ? { lastError: prev.lastError } : {}),
                })
                return res
              } catch (err) {
                const dt = Math.round((performance.now() - t0) * 100) / 100
                const calls = prev.calls + 1
                const totalMs = Math.round((prev.totalMs + dt) * 100) / 100
                motorMemory.set(toolName, {
                  calls,
                  errors: prev.errors + 1,
                  totalMs,
                  avgMs: Math.round((totalMs / calls) * 100) / 100,
                  lastCalledAt: Date.now(),
                  lastError: err instanceof Error ? err.message : String(err),
                })
                throw err
              } finally {
                toolsInFlight -= 1
              }
            }
          }
        }
        return origRegister.call(this, definition, options)
      }
      proto.__x6Wrapped = true
    }
  }

  const activeFibers = new Map<string, { specifier: string; configJson: string; fiber: CordisFiberLike }>()
  const peers = new Map<string, PresencePeer>()
  const now = Date.now()
  peers.set(peerId, {
    peerId,
    kind: 'browser-tab',
    ballId: 'genesis',
    connectedAt: now,
    lastSeenAt: now,
  })

  // Load local HEAD.json if present
  let currentBall: BallManifest = emptyManifest(peerId)
  if (vfs.existsSync(HEAD_PATH)) {
    try {
      const parsed = JSON.parse(vfs.readFileSync(HEAD_PATH, 'utf8') as string) as BallManifest
      if (parsed && parsed.version === 'x6.1-ball/v1' && typeof parsed.ballId === 'string') {
        currentBall = parsed
      }
    } catch (err) {
      console.warn('x6-ball: could not parse local HEAD.json', err)
    }
  }

  // Reconcile with AumaHead (/_head/ball) on boot if reachable
  const stamp = typeof __X6_BUILD_IDENTITY__ !== 'undefined' ? __X6_BUILD_IDENTITY__ : null
  const sourceRevision = stamp?.sourceRevision && /^[a-f0-9]{40}$/.test(stamp.sourceRevision) ? stamp.sourceRevision : null
  const admittedSuiteDigest = typeof stamp?.retentionSuiteDigest === 'string' && /^[a-f0-9]{64}$/.test(stamp.retentionSuiteDigest)
    ? stamp.retentionSuiteDigest : null
  const baselineConfigured = stamp?.retentionBaselineSuite != null || stamp?.retentionBaselineDigest != null
  // Detach the build snapshot before exposing any organ capabilities. Later stamp mutation cannot repin it.
  const baselineSnapshot: unknown = record(stamp?.retentionBaselineSuite) ? JSON.parse(JSON.stringify(stamp.retentionBaselineSuite)) : null
  const admittedBaseline = record(baselineSnapshot) && typeof stamp?.retentionBaselineDigest === 'string'
    && /^[a-f0-9]{64}$/.test(stamp.retentionBaselineDigest) && retentionSuiteDigest(baselineSnapshot) === stamp.retentionBaselineDigest
    && retentionSuiteExtendsBaseline(baselineSnapshot, baselineSnapshot) ? baselineSnapshot : null
  const suitePinAvailable = baselineConfigured ? admittedBaseline !== null : admittedSuiteDigest !== null
  const buildSha = sourceRevision ? sourceRevision.slice(0, 8) + (stamp?.sourceDirty ? '-dirty' : '') : 'UNVERIFIED'
  const buildIdentity = Object.freeze({
    sourceRevision, sourceDirty: stamp?.sourceDirty ?? null, builtAt: stamp?.builtAt ?? null,
    runtimeArtifactSha256: stamp?.runtimeArtifactSha256 ?? null,
    runtimeReleaseId: /^\/_runtime\/([a-f0-9]{64})\//.exec((globalThis as { location?: { pathname?: string } }).location?.pathname ?? '')?.[1] ?? null,
    workerScript: (globalThis as { location?: { pathname?: string } }).location?.pathname?.split('/').pop() ?? null,
  })
  let hostSourceSha: string | null = null
  let hostHeadInfo: { ballId: string; epoch: number; checkedAt: number } | null = null
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  const hostRequest = fetch
  hostCtx.provide('checkpointPolicy', Object.freeze({ read: async () => {
    if (!origin || origin === 'null') throw new Error('CHECKPOINT_POLICY_UNAVAILABLE')
    const result = await boundedHostJson(hostRequest, new URL('/_host/checkpoint-policy', origin))
    if (result.schema !== 'aukora.checkpoint-policy.v1' || !Array.isArray(result.ranges) || result.ranges.length === 0 || result.ranges.length > 32) throw new Error('CHECKPOINT_POLICY_UNAVAILABLE')
    const ranges = result.ranges.map((range: unknown) => {
      if (!record(range) || Object.keys(range).length !== 4 || !Number.isSafeInteger(range.firstSeq) || Number(range.firstSeq) < 1
        || !Number.isSafeInteger(range.lastSeq) || Number(range.lastSeq) < Number(range.firstSeq)
        || !['v1', 'v2'].includes(String(range.envelope)) || typeof range.publicKeyHex !== 'string' || !/^[a-f0-9]{64}$/.test(range.publicKeyHex)) throw new Error('CHECKPOINT_POLICY_UNAVAILABLE')
      return Object.freeze({ ...range })
    })
    return Object.freeze({ ok: true, schema: result.schema, ranges: Object.freeze(ranges) })
  } }))
  let activeWriterLease: { ownerPeerId: string; generation: number; expiresAt: number } | null = null
  let authorityError: string | null = null
  interface LeaseReply {
    ok: boolean
    code?: string
    ballId?: string | null
    lease?: { ownerPeerId: string; generation: number; expiresAt: number }
  }
  const leaseRequest = async (body: Record<string, unknown>): Promise<LeaseReply> => {
    if (!origin || origin === 'null') throw new Error('Local head authority is unavailable')
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 5000)
    try {
      const response = await fetch(new URL('/_head/lease', origin), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
      const result = await response.json() as LeaseReply
      if (!response.ok || !result.ok) throw new Error(result.code ?? `Writer lease HTTP ${String(response.status)}`)
      return result
    } finally { clearTimeout(timer) }
  }
  const withWriterLease = async <T>(run: () => Promise<T>, initialBootstrap = false, beforeChange: () => void = () => {}): Promise<T> => {
    let grant: Awaited<ReturnType<typeof leaseRequest>>
    try { grant = await leaseRequest({ action: 'acquire', ownerPeerId: peerId }) }
    catch (error) { authorityError = error instanceof Error ? error.message : String(error); throw error }
    if (!grant.lease || grant.lease.ownerPeerId !== peerId || !Number.isSafeInteger(grant.lease.generation)) throw new Error('Invalid writer lease acknowledgement')
    activeWriterLease = grant.lease
    const held = grant.lease
    const renew = setInterval(() => {
      void leaseRequest({ action: 'renew', ownerPeerId: peerId, generation: held.generation }).then((result) => { if (result.lease && activeWriterLease?.generation === held.generation) activeWriterLease = result.lease }).catch((error) => { clearInterval(renew); console.warn('Writer lease renewal stopped', error) })
    }, 10000)
    let lagging = false
    try {
      const emptyGenesis = currentBall.parentBallId === null && currentBall.epoch === 0 &&
        Object.keys(currentBall.entries).length === 0 && Object.keys(currentBall.modules).length === 0 &&
        currentBall.ballId === computeBallId(null, 0, {}, {})
      if (grant.ballId === null && !(initialBootstrap && emptyGenesis)) {
        retainedLocalFork = currentBall.ballId
        appendHistoricalFile(join(HISTORY_DIR, `fork-${currentBall.ballId}.json`), JSON.stringify(currentBall, null, 2) + '\n')
        authorityError = 'HEAD_AUTHORITY_MISSING: local fork retained; explicit recovery is required before selected-head edits'
        await persistence.flush()
        throw new Error(authorityError)
      }
      authorityError = null
      const behind = (hasRemoteHead || grant.ballId !== null) && grant.ballId !== currentBall.ballId
      // An open tab never hot-swaps to a head published elsewhere: a selected-head write from a tab that
      // is behind changes nothing mounted. The lease is released (finally), then the published head is read and recorded
      // and the write answers HEAD_RELOAD_REQUIRED. Only the first bootstrap, before any seed organ runs, still rebases.
      if (behind && !initialBootstrap) lagging = true
      else if (behind) {
        const response = await fetch(new URL('/_head/ball', origin).href, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) })
        if (!response.ok) throw new Error('REBASE_REQUIRED: selected head lookup failed')
        const selected = await response.json() as { ball?: BallManifest; codeBySha?: Record<string, string> }
        if (!selected.ball || selected.ball.ballId !== grant.ballId) throw new Error('REBASE_REQUIRED: selected head changed during acquisition')
        requireManifestAdmission(selected.ball)
        for (const [sha, code] of verifyCodeBySha(selected.codeBySha)) vfs.writeFileSync(join(BALLS_DIR, `${sha}.js`), code)
        retainedLocalFork = currentBall.ballId
        appendHistoricalFile(join(HISTORY_DIR, `fork-${currentBall.ballId}.json`), JSON.stringify(currentBall, null, 2) + '\n')
        await reconcileToManifest(selected.ball, beforeChange)
        await persistence.flush()
        throw new Error('REBASE_REQUIRED: selected head adopted; local fork retained; retry against the current ballId')
      }
      if (!lagging) return await run()
    } finally {
      clearInterval(renew)
      activeWriterLease = null
      await leaseRequest({ action: 'release', ownerPeerId: peerId, generation: held.generation }).catch(() => {})
    }
    const checked = await lateOps.checkPublishedHead?.()
    const say = checked?.headLag?.say
      ?? `The published Auma (${String(grant.ballId).slice(0, 12)}) is not the one this tab runs (epoch ${String(currentBall.epoch)}). One reload takes the published one.`
    throw Object.assign(new Error(`HEAD_RELOAD_REQUIRED: ${say}`), { code: 'HEAD_RELOAD_REQUIRED' })
  }
  const mutateSelected = <T>(run: (markApplied: () => void) => Promise<T>): Promise<T> => serializeMutation(async () => {
    let applied = false
    const markApplied = (): void => { applied = true }
    try { return await withWriterLease(() => run(markApplied), false, markApplied) }
    catch (error) {
      type Failure = Error & { notApplied: boolean; code?: string }
      const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error }) as Failure
      failure.notApplied = !applied
      // Callers branch on the typed code (HEAD_RELOAD_REQUIRED, ...): keep it on the wrapper.
      if (record(error) && typeof error.code === 'string') failure.code = error.code
      throw failure
    }
  })

  // Why the cold-boot head read did not yield a selected head. null means it answered 200 with a JSON object, whose
  // module bodies all hash to their keys and whose ball is either a valid x6.1 manifest or explicitly absent.
  // Anything else (network failure, 401/403/501/503, HTML login page, unparsable JSON, poisoned codeBySha) is
  // NOT evidence that no head exists, so it is surfaced here and the first-bootstrap writer lease is never requested.
  let headFetchError: string | null = null
  if (origin && origin !== 'null') {
    let res: Response | null = null
    // An idle deadline over the headers and the body (the boot stall): a head read that receives nothing
    // fails as HEAD_READ_STALLED (non-fatal: the boot goes on without a selected head, as for any failed head read),
    // while a slow head that keeps arriving is never cut off.
    const headIdleMs = (globalThis as { __X6_HEAD_READ_IDLE_MS__?: number }).__X6_HEAD_READ_IDLE_MS__ ?? HEAD_READ_IDLE_MS
    try {
      res = await idleFetch(new URL('/_head/ball', origin).href, { credentials: 'same-origin', cache: 'no-store' },
        { idleMs: headIdleMs, code: 'HEAD_READ_STALLED', what: 'her head (/_head/ball)' })
    } catch (error) {
      headFetchError = `HEAD_FETCH_UNREACHABLE: ${error instanceof Error ? error.message : String(error)}`
    }
    if (res) {
      try {
        if (!res.ok) {
          // The error body is not read: cancelled now, so the transfer and its idle deadline end here.
          await res.body?.cancel().catch(() => {})
          throw new Error(`HEAD_FETCH_FAILED: HTTP ${String(res.status)}`)
        }
        let parsed: unknown
        let headText: string
        try { headText = await res.text() } catch (error) {
          throw error instanceof Error && (error as { code?: unknown }).code === 'HEAD_READ_STALLED' ? error : new Error(`HEAD_FETCH_FAILED: body unreadable (${String(error)})`)
        }
        try { parsed = JSON.parse(headText) } catch { throw new Error(`HEAD_FETCH_FAILED: non-JSON body (${(res.headers.get('content-type') ?? 'no content-type').slice(0, 80)})`) }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('HEAD_FETCH_FAILED: body is not a JSON object')
        // A 200 that still says ok:false (a refusal body behind a permissive status) is not a head answer either.
        if ((parsed as { ok?: unknown }).ok === false) throw new Error(`HEAD_FETCH_FAILED: ${String((parsed as { code?: unknown }).code ?? 'ok:false').slice(0, 80)}`)
        const remote = parsed as {
          ball?: BallManifest | null
          head?: BallManifest | null
          codeBySha?: Record<string, string>
          modules?: Record<string, string>
          peers?: PresencePeer[]
          buildSha?: string
        }
        // Verify the whole code set before anything is stored, adopted or executed.
        const remoteCode = verifyCodeBySha(remote.codeBySha ?? remote.modules)
        const remoteBall = remote.ball ?? remote.head
        if (remoteBall != null && (typeof remoteBall !== 'object' || remoteBall.version !== 'x6.1-ball/v1')) {
          throw new Error('HEAD_FETCH_FAILED: unrecognised ball manifest')
        }
        if (typeof remote.buildSha === 'string' && remote.buildSha) {
          hostSourceSha = remote.buildSha
        }
        for (const [sha, code] of remoteCode) {
          const p = join(BALLS_DIR, `${sha}.js`)
          if (!vfs.existsSync(p)) vfs.writeFileSync(p, code)
        }
        if (remoteBall) {
          hasRemoteHead = true
          hostHeadInfo = { ballId: remoteBall.ballId, epoch: remoteBall.epoch, checkedAt: Date.now() }
          if (currentBall.ballId !== remoteBall.ballId && Object.keys(currentBall.entries).length > 0) {
            retainedLocalFork = currentBall.ballId
            appendHistoricalFile(join(HISTORY_DIR, `fork-${currentBall.ballId}.json`), JSON.stringify(currentBall, null, 2) + '\n')
          }
          currentBall = remoteBall
          vfs.writeFileSync(HEAD_PATH, JSON.stringify(currentBall, null, 2) + '\n')
        }
        if (Array.isArray(remote.peers)) {
          for (const p of remote.peers) {
            if (p && p.peerId) peers.set(p.peerId, p)
          }
        }
      } catch (error) {
        headFetchError = error instanceof Error ? error.message : String(error)
      }
    }
    if (headFetchError) {
      authorityError = headFetchError
      console.error('x6-ball: head fetch did not yield a selected head; first bootstrap is disabled for this boot', headFetchError)
    }
  }

  const updateSelfPeer = (): void => {
    const existing = peers.get(peerId)
    peers.set(peerId, {
      peerId,
      kind: 'browser-tab',
      ballId: currentBall.ballId,
      epoch: currentBall.epoch,
      connectedAt: existing?.connectedAt ?? Date.now(),
      lastSeenAt: Date.now(),
    })
  }
  updateSelfPeer()

  const evaluateCandidate = (specifier: string, entryId: string): unknown => {
    const req = loader.requireFrom('/dsh')
    const raw = req(specifier)
    const shaHint = specifier.startsWith('ball:') ? specifier.slice('ball:'.length) : undefined
    const plugin = unwrapPluginExport(raw, spec => mountSeedOrgan(spec, shaHint ?? '', entryId))
    if (!isValidPlugin(plugin)) {
      throw loaderFault(isSupportModuleExport(raw) ? 'SUPPORT_MODULE' : 'BALL_MODULE_NOT_A_PLUGIN', entryId,
        `Module "${specifier}" did not export a valid Cordis plugin (expected a function, an object with apply(ctx, config), or a Seed organ with { name, run })`)
    }
    return plugin
  }

  /**
   * Why each HEAD entry has no fiber, from its last mount attempt (two organs were in HEAD and silently
   * never ran). Set when a mount of that exact specifier fails, cleared when the entry mounts or is disabled.
   * The code is the loader's own (loaderFaultFor) or the phase that failed: MODULE_LOAD_FAILED (evaluating
   * the module threw) or APPLY_FAILED (its apply() threw). The thrown message is kept as `detail`, never as the code.
   */
  type MountFailureDetail = { code: string; detail: string; fields: Readonly<Record<string, string>>; at: number }
  type MountFailure = MountFailureDetail & { specifier: string; configJson: string }
  const mountFailures = new Map<string, MountFailure>()
  const classifyFailure = (error: unknown, entryId: string, phaseCode: string): MountFailureDetail => {
    const fault = loaderFaultFor(error, entryId)
    const message = error instanceof Error ? error.message : String(error)
    return { code: fault?.code ?? phaseCode, detail: message.slice(0, 200), fields: fault?.fields ?? {}, at: Date.now() }
  }
  const noteMountFailure = (entry: BallEntryRecord, error: unknown, phaseCode: string): void => {
    mountFailures.set(entry.id, { specifier: entry.specifier, configJson: JSON.stringify(entry.config),
      ...classifyFailure(error, entry.id, phaseCode) })
  }

  /**
   * What each fiber's lifecycle says, from Cordis itself ("running" was read from
   * the stored specifier and config, so a fiber waiting on a service, or one whose apply() threw on a later restart,
   * still said running). Cordis emits `internal/status` on every state change (vendor/cordis/src/fiber.ts _updateState);
   * a fiber that reaches FAILED rethrows its own error from `await()` (fiber.ts await), which is recorded here for the
   * entry that runs it. A fiber seen ACTIVE before it failed failed on a restart.
   */
  const fibersSeenActive = new WeakSet<object>()
  const fiberFailures = new WeakMap<object, MountFailureDetail>()
  const entryIdOfFiber = (fiber: object): string | null => {
    for (const [id, active] of activeFibers) if (active.fiber === fiber) return id
    return null
  }
  const observeFiberStatus = (fiber: unknown): void => {
    if (typeof fiber !== 'object' || fiber === null) return
    const observed = fiber as CordisFiberLike
    if (observed.state === CORDIS_FIBER_ACTIVE) { fibersSeenActive.add(observed); return }
    if (observed.state !== CORDIS_FIBER_FAILED || typeof observed.await !== 'function') return
    const phaseCode = fibersSeenActive.has(observed) ? 'RESTART_FAILED' : 'APPLY_FAILED'
    Promise.resolve().then(() => observed.await?.()).then(() => {}, (error: unknown) => {
      fiberFailures.set(observed, classifyFailure(error, entryIdOfFiber(observed) ?? '', phaseCode))
    })
  }
  try {
    hostCtx.on?.('internal/status', observeFiberStatus)
  } catch (error) {
    console.warn('x6-ball: fiber lifecycle cannot be observed; entry failures after a restart will not carry their reason', error)
  }

  /**
   * Start a plugin fiber and wait for it to load. A fiber whose load fails (its `apply()` threw) is disposed here, so a
   * failed activation never stays registered (each failed boot mount left a FAILED Cordis
   * fiber behind). The handle is kept before it is awaited, because awaiting it is what rejects.
   */
  const activatePlugin = async (plugin: unknown, config: unknown): Promise<CordisFiberLike> => {
    const handle = hostCtx.plugin(plugin, config)
    try {
      return await Promise.resolve(handle)
    } catch (activationErr) {
      const failed = handle as Partial<CordisFiberLike>
      if (typeof failed.dispose === 'function') {
        try { await Promise.resolve(failed.dispose()) } catch (disposeErr) { console.error('x6-ball: disposing a fiber that failed to load also failed', disposeErr) }
      }
      throw activationErr
    }
  }

  /**
   * Transactionally mount or hot-swap a single entry without stopping the old fiber
   * unless the candidate module compiles and mounts cleanly.
   */
  const mountOrSwapEntry = async (entry: BallEntryRecord, beforeChange: () => void = () => {}): Promise<void> => {
    const phase = { code: 'MODULE_LOAD_FAILED' }
    try {
      await mountOrSwapEntryUnrecorded(entry, beforeChange, phase)
    } catch (error) {
      noteMountFailure(entry, error, phase.code)
      throw error
    }
    mountFailures.delete(entry.id)
  }
  const mountOrSwapEntryUnrecorded = async (entry: BallEntryRecord, beforeChange: () => void, phase: { code: string }): Promise<void> => {
    const current = activeFibers.get(entry.id)
    const previousEffects = effectLedger.get(entry.id)
    const configJson = JSON.stringify(entry.config ?? {})

    if (entry.disabled) {
      if (current !== undefined) {
        beforeChange()
        activeFibers.delete(entry.id)
        effectLedger.delete(entry.id)
        await Promise.resolve(current.fiber.dispose())
      }
      return
    }

    if (current !== undefined && current.specifier === entry.specifier && current.configJson === configJson) {
      return
    }

    // require() may execute candidate top-level effects even if it later throws.
    // From this point execution is uncertain; do not tag a failure as not-applied.
    beforeChange()
    const candidatePlugin = evaluateCandidate(entry.specifier, entry.id)

    // 2. If an older fiber is running on the same id, dispose it first so tool/service names don't collide,
    //    and if the new fiber fails to activate in `hostCtx.plugin`, immediately restore the previous specifier!
    if (current !== undefined) {
      activeFibers.delete(entry.id)
      effectLedger.delete(entry.id)
      await Promise.resolve(current.fiber.dispose())
    }

    const beforeToolNames = new Set((hostCtx.tools?.definitions?.() ?? []).map(d => d.name))
    phase.code = 'APPLY_FAILED'
    try {
      const fiber = await activatePlugin(candidatePlugin, entry.config ?? {})
      if (fiber.state === CORDIS_FIBER_ACTIVE) fibersSeenActive.add(fiber)
      activeFibers.set(entry.id, { specifier: entry.specifier, configJson, fiber })
      const afterToolNames = (hostCtx.tools?.definitions?.() ?? []).map(d => d.name)
      const toolsAdded = afterToolNames.filter(n => !beforeToolNames.has(n))
      effectLedger.set(entry.id, {
        id: entry.id,
        specifier: entry.specifier,
        mountedAt: Date.now(),
        toolsBefore: beforeToolNames.size,
        toolsAfter: afterToolNames.length,
        toolsAdded,
      })
    } catch (activationErr) {
      // Transactional rollback: restore old fiber if activation threw!
      if (current !== undefined) {
        try {
          const rollbackPlugin = evaluateCandidate(current.specifier, entry.id)
          const rollbackFiber = await activatePlugin(rollbackPlugin, JSON.parse(current.configJson))
          activeFibers.set(entry.id, { ...current, fiber: rollbackFiber })
          if (previousEffects) effectLedger.set(entry.id, previousEffects)
        } catch (rollbackErr) {
          console.error(`x6-ball: rollback of ${entry.id} failed`, rollbackErr)
        }
      }
      throw activationErr
    }
  }

  /** Reconcile all live fibers to match a target BallManifest without disturbing already-matching sibling fibers. */
  const reconcileToManifest = async (target: BallManifest, beforeChange: () => void = () => {}): Promise<void> => {
    const previous = currentBall
    // Candidate attempts can replace diagnostics; recovery needs the exact nonmounted state before this reconcile.
    const knownNonmounted = new Map([...mountFailures].filter(([id, failure]) => {
      const entry = previous.entries[id]
      return entry && !entry.disabled && !activeFibers.has(id) && failure.specifier === entry.specifier
        && failure.configJson === JSON.stringify(entry.config)
    }))
    const removeFiber = async (id: string): Promise<void> => {
      const running = activeFibers.get(id)
      if (running === undefined) return
      beforeChange()
      await Promise.resolve(running.fiber.dispose())
      activeFibers.delete(id)
      effectLedger.delete(id)
    }
    const applyEntries = async (manifest: BallManifest): Promise<void> => {
      const toRemove = [...activeFibers.keys()].filter(id => !(id in manifest.entries)).reverse()
      for (const id of toRemove) await removeFiber(id)
      for (const entry of Object.values(manifest.entries)) {
        const known = knownNonmounted.get(entry.id)
        if (!entry.disabled && known?.specifier === entry.specifier && known.configJson === JSON.stringify(entry.config)) {
          await removeFiber(entry.id)
          mountFailures.set(entry.id, known)
          continue
        }
        try {
          await mountOrSwapEntry(entry, beforeChange)
        } catch (error) {
          if (loaderFaultFor(error, entry.id)?.code !== 'SUPPORT_MODULE') throw error
          // A library is valid content without a fiber; replacing a plugin must still dispose its old effects.
          await removeFiber(entry.id)
        }
      }
    }
    try {
      await applyEntries(target)
    } catch (error) {
      try {
        await applyEntries(previous)
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], 'MANIFEST_RECOVERY_FAILED: selected head retained; runtime requires recovery')
      }
      throw error
    }
    beforeChange()
    currentBall = target
    vfs.writeFileSync(HEAD_PATH, JSON.stringify(currentBall, null, 2) + '\n')
    appendHistoricalFile(join(HISTORY_DIR, `${currentBall.ballId}.json`), JSON.stringify(currentBall, null, 2) + '\n')
    hydrateNamedOrganSources(vfs, currentBall, previous)
    updateSelfPeer()
  }

  // Multi-tab BroadcastChannel + WebSocket Presence Hub (`/_head/ws`)
  let bc: BroadcastChannel | undefined
  let ws: WebSocket | undefined
  // Lane E3: her own /_head/ws facts for GET /__x6__/status (see head-socket-telemetry.ts for the honesty rule).
  const headSocket = createHeadSocketTracker()
  const PEER_LIVENESS_TTL_MS = 90_000

  // Register `ctx.presence` service on Cordis root context before mounting any ball entries
  const presenceService = {
    self: (): PresencePeer => peers.get(peerId) ?? {
      peerId,
      kind: 'browser-tab',
      ballId: currentBall.ballId,
      connectedAt: now,
      lastSeenAt: Date.now(),
    },
    list: (opts?: { includeGhosts?: boolean }): PresencePeer[] => {
      updateSelfPeer()
      const cutoff = Date.now() - PEER_LIVENESS_TTL_MS
      const all = [...peers.values()]
      if (opts?.includeGhosts) return all
      return all.filter(p => p.peerId === peerId || (p.lastSeenAt ?? 0) >= cutoff)
    },
    gc: (): number => {
      const cutoff = Date.now() - PEER_LIVENESS_TTL_MS
      let removed = 0
      for (const [id, p] of peers.entries()) {
        if (id !== peerId && (p.lastSeenAt ?? 0) < cutoff) {
          peers.delete(id)
          removed += 1
        }
      }
      return removed
    },
    broadcast: (payload: unknown): void => {
      enforceIrreversibleAction({ action: 'send', tool: 'presence' })
      const frame = { type: 'presence:custom', fromPeerId: peerId, payload, peer: peers.get(peerId) }
      try { bc?.postMessage(frame) } catch {}
      try { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)) } catch {}
    },
  }
  try {
    hostCtx.provide('presence', presenceService)
  } catch {}

  // Register `ctx.organs` service on Cordis root context bridging Auma's Seed v3/v4 organ contract
  // directly onto the native Cordis `ball:<sha256>` loader (`ballPut`, `treePatch`, `treeUndo`).
  const mountedOrgans = new Map<string, MountedOrganRecord>()
  const mountSeedOrgan = (spec: SeedOrganSpec, sha256: string, entryId: string): (() => void) => {
    if (spec.name !== entryId) {
      // A Seed organ's exported name must equal its HEAD entry id. The refusal names both, so she knows
      // what to rename (she stages the corrected organ; the owner permits it).
      const exportName = typeof spec.name === 'string' ? spec.name.slice(0, 80) : typeof spec.name
      throw loaderFault('SCION_ORGAN_NAME_MISMATCH', entryId,
        `entry ${entryId} exports the name ${JSON.stringify(exportName)}; a Seed organ's exported name must equal its entry id`,
        { exportName, entryId })
    }
    const rec: MountedOrganRecord = {
      name: entryId, sha256,
      description: spec.description ?? `Seed organ ${entryId}`,
      parameters: record(spec.parameters) ? spec.parameters : {},
      updatedAt: Date.now(),
      run: (args: unknown, ctx: unknown) => spec.run(args, ctx),
    }
    mountedOrgans.set(entryId, rec)
    return () => { if (mountedOrgans.get(entryId) === rec) mountedOrgans.delete(entryId) }
  }
  vfs.mkdirSync('/dsh/home/organs', { recursive: true })

  /** Transcript turns this tab started (`turn_start` acknowledged running, not yet completed or abandoned): turn id → start. */
  const activeTurns = new Map<string, number>()
  const ACTIVE_TURN_STALE_MS = 10 * 60_000
  const lateOps: {
    ballPut?: typeof ballPut
    treePatch?: typeof treePatch
    treeUndo?: typeof treeUndo
    ensureRetroPromotionReceipts?: (changedEntriesHint?: readonly string[]) => Promise<string[]>
    /** Bound once checkPublishedHead exists; the writer lease reads the published head through it when this tab is behind. */
    checkPublishedHead?: () => Promise<{ ok: boolean; headLag: { say: string } | null }>
    /** Bound with checkPublishedHead: the one ordering every read of the published head records through. */
    headReadOrder?: { begin: () => number; record: (read: number, head: { ballId: string; epoch: number }) => void }
  } = {}

  const organMutationAck = (mutation: BallMutationState) => {
    const ok = mutation.localSaved && mutation.remoteSaved && mutation.receiptSaved
    return {
      ok, outcome: ok ? 'committed' : 'persistence-unconfirmed', mutation,
      ...(!ok ? { error: 'Live activation completed but persistence is unconfirmed; inspect mutation acknowledgements before retrying or rolling back' } : {}),
    }
  }

  const organMutationFailure = (error: unknown, mutationAttempted: boolean) => ({
    ok: false, error: error instanceof Error ? error.message : String(error),
    outcome: mutationAttempted && !(error && typeof error === 'object' && 'notApplied' in error && error.notApplied === true) ? 'mutation-uncertain' : 'not-activated',
    activationUncertain: mutationAttempted && !(error && typeof error === 'object' && 'notApplied' in error && error.notApplied === true),
  })

  const organsService: OrganServiceLike = {
    list() {
      const byName = new Map<string, { name: string; sha256: string; description: string; updatedAt: number }>()
      for (const { name, sha256, description, updatedAt } of mountedOrgans.values()) {
        byName.set(name, { name, sha256, description, updatedAt })
      }
      for (const [id, active] of activeFibers.entries()) {
        if (!byName.has(id)) {
          const sha256 = active.specifier.startsWith('ball:') ? active.specifier.slice(5) : active.specifier
          const meta = currentBall.modules[sha256]
          byName.set(id, {
            name: id,
            sha256,
            description: meta?.description ?? `Cordis ball plugin ${id}`,
            updatedAt: currentBall.entries[id]?.updatedAt ?? meta?.createdAt ?? Date.now(),
          })
        }
      }
      return [...byName.values()]
    },
    async install(codeOrInput, opts) {
      let mutationAttempted = false
      try {
        if (!lateOps.ballPut || !lateOps.treePatch) throw new Error('ball runtime not ready')
        const isObj = typeof codeOrInput === 'object' && codeOrInput !== null
        const code = isObj ? String(codeOrInput.code ?? '') : String(codeOrInput ?? '')
        const name = String((isObj ? codeOrInput.name : opts?.name) ?? '').trim()
        const expect = (isObj ? codeOrInput.expect : opts?.expect)
        const description = (isObj ? codeOrInput.description : opts?.description)
        if (!name) return { ok: false, error: 'organ name required' }
        if (!code.trim()) return { ok: false, error: 'organ code required' }
        if (expect !== undefined && expect !== 'any') {
          const existing = mountedOrgans.get(name)
          const currentSha = existing ? existing.sha256 : 'none'
          if (expect !== currentSha) {
            return { ok: false, error: `expect mismatch for ${name}: expected ${expect}, got ${currentSha}` }
          }
        }
        const expectedBallId = currentBall.ballId
        const meta = await lateOps.ballPut({ code, name, description })
        vfs.writeFileSync(`/dsh/home/organs/${meta.sha256}.js`, code)
        mutationAttempted = true
        const res = await lateOps.treePatch({ id: name, specifier: meta.specifier, disabled: false, expectedBallId })
        return { ...organMutationAck(res.mutation), name, sha256: meta.sha256, specifier: meta.specifier }
      } catch (err) {
        return organMutationFailure(err, mutationAttempted)
      }
    },
    async call(name: string, args?: unknown) {
      enforceToolInvocation(name, args, currentBall.entries)
      try { syncCandidateBallsStore(vfs) } catch {}
      const target = mountedOrgans.get(name) ?? mountedOrgans.get(name.replace(/_/g, '-'))
      if (!target) {
        throw new Error(`Organ "${name}" is not mounted`)
      }
      const organCtx = {
        organs: organsService,
        presence: presenceService,
        tools: hostCtx.tools,
        web: hostCtx.get('web'),
        systemPrompt: hostCtx.get('systemPrompt'),
        configEditor: hostCtx.get('configEditor'),
        agentPresets: hostCtx.get('agentPresets'),
        fs: vfs,
        snapshots: getX6Services().snapshots ?? hostCtx.get('snapshots'),
        scion: getX6Services().scion,
        checkpointPolicy: hostCtx.get('checkpointPolicy'),
        wasm: workerCellHost(),
      }
      const rawArgs = (args && typeof args === 'object') ? args as Record<string, unknown> : {}
      if (target.name === 'seed-aura') {
        const reqAction = typeof rawArgs.action === 'string' ? rawArgs.action : 'status'
        const runArgs = reqAction === 'attest' ? { ...rawArgs, action: 'compute' } : rawArgs
        const out = await target.run(runArgs, organCtx)
        const auraPath = '/dsh/home/auma/seed/aura.v1.json'
        const attestPath = '/dsh/home/auma/seed/aura-attest.v1.json'
        let auraDoc: Record<string, unknown> | null = null
        try {
          if (vfs.existsSync(auraPath)) {
            const parsed = JSON.parse(vfs.readFileSync(auraPath, 'utf8') as string)
            if (record(parsed)) {
              if (parsed.authorityTier === 'self-attested') {
                parsed.authorityTier = 'peripheral-hint'
                vfs.writeFileSync(auraPath, JSON.stringify(parsed, null, 2) + '\n')
              }
              auraDoc = parsed
            }
          }
        } catch {}
        if (reqAction === 'compute' || reqAction === 'attest' || !vfs.existsSync(attestPath)) {
          let edgeStatus: Record<string, unknown> | null = null
          if (origin && origin !== 'null') {
            try {
              const res = await fetch(new URL('/__x6/status', origin).href, {
                credentials: 'same-origin',
                cache: 'no-store',
                signal: AbortSignal.timeout(4000),
              })
              if (res.ok) {
                const json = await res.json()
                if (record(json)) edgeStatus = json
              }
            } catch {}
          }
          const edgeHead = record(edgeStatus?.head) ? edgeStatus.head : edgeStatus
          const edgeAuraObj = record(edgeStatus?.aura) ? edgeStatus.aura : null
          const verifiedByEdge = edgeAuraObj !== null
          const attestation = {
            schema: 'aukora.aura-attest.v1',
            attestedAt: Date.now(),
            verifier: verifiedByEdge ? 'cloudflare-head-do+worker-runtime' : 'worker-runtime-local',
            authorityTier: verifiedByEdge ? 'recomputed-verified' : 'peripheral-hint',
            epoch: currentBall.epoch,
            ballId: currentBall.ballId,
            edgeEpoch: typeof edgeHead?.epoch === 'number' ? edgeHead.epoch : (hostHeadInfo?.epoch ?? currentBall.epoch),
            edgeBallId: typeof edgeHead?.ballId === 'string' ? edgeHead.ballId : (hostHeadInfo?.ballId ?? currentBall.ballId),
            axes: auraDoc?.axes ?? (record(out) ? out.axes : null),
            overall: auraDoc?.overall ?? (record(out) ? out.overall : null),
            band: auraDoc?.band ?? (record(out) ? out.band : null),
            edgeAura: edgeAuraObj,
          }
          try {
            vfs.mkdirSync('/dsh/home/auma/seed', { recursive: true })
            vfs.writeFileSync(attestPath, JSON.stringify(attestation, null, 2) + '\n')
          } catch {}
          if (reqAction === 'attest') {
            try {
              await organsService.call('seed-receipts', {
                action: 'append',
                kind: 'aura.attest',
                data: {
                  epoch: currentBall.epoch,
                  ballId: currentBall.ballId,
                  overall: attestation.overall,
                  band: attestation.band,
                  verifier: attestation.verifier,
                  authorityTier: attestation.authorityTier,
                },
              })
            } catch {}
          }
          try { await persistence.flush() } catch {}
        }
        let attestationDoc: Record<string, unknown> | null = null
        try {
          if (vfs.existsSync(attestPath)) {
            const parsed = JSON.parse(vfs.readFileSync(attestPath, 'utf8') as string)
            if (record(parsed)) attestationDoc = parsed
          }
        } catch {}
        if (record(out)) {
          return {
            ...out,
            ...(reqAction === 'attest' ? { action: 'attest' } : {}),
            authorityTier: attestationDoc ? 'recomputed-verified' : (out.authorityTier ?? 'peripheral-hint'),
            attested: Boolean(attestationDoc),
            attestationPath: attestPath,
            ...(attestationDoc ? { attestation: attestationDoc } : {}),
          }
        }
        return out
      }
      return await target.run(rawArgs, organCtx)
    },
    async undo(name?: string, opts?: { expect?: string }) {
      let mutationAttempted = false
      try {
        if (!lateOps.treeUndo) throw new Error('ball runtime not ready')
        if (name && opts?.expect && opts.expect !== 'any') {
          const existing = mountedOrgans.get(name)
          const currentSha = existing ? existing.sha256 : 'none'
          if (opts.expect !== currentSha) {
            return { ok: false, error: `expect mismatch on undo for ${name}: expected ${opts.expect}, got ${currentSha}` }
          }
        }
        mutationAttempted = true
        const res = await lateOps.treeUndo({ ...(name ? { id: name } : {}), expectedBallId: currentBall.ballId })
        return { ...organMutationAck(res.mutation), action: res.action, restoredSha: res.restoredSha }
      } catch (err) {
        return organMutationFailure(err, mutationAttempted)
      }
    },
    async retire(name: string, opts?: { expect?: string }) {
      let mutationAttempted = false
      try {
        if (!lateOps.treePatch) throw new Error('ball runtime not ready')
        const entry = currentBall.entries[name]
        if (!entry) {
          if (mountedOrgans.has(name)) throw new Error('ENTRY_NOT_SELECTED: cannot retire an unselected registry entry')
          return { ok: true, action: 'absent', outcome: 'unchanged' }
        }
        if (opts?.expect && opts.expect !== 'any') {
          const existing = mountedOrgans.get(name)
          const currentSha = existing ? existing.sha256 : 'none'
          if (opts.expect !== currentSha) {
            return { ok: false, error: `expect mismatch on retire for ${name}: expected ${opts.expect}, got ${currentSha}` }
          }
        }
        mutationAttempted = true
        const expectedBallId = currentBall.ballId
        if (entry.disabled) return await mutateSelected(async () => {
          if (currentBall.ballId !== expectedBallId) throw new Error('CAS_HEAD_MISMATCH: selected head changed')
          if (lastMutation?.ballId === currentBall.ballId) {
            const ack = organMutationAck(lastMutation)
            return { ...ack, outcome: ack.ok ? 'unchanged' : ack.outcome, action: 'retired' }
          }
          return { ok: true, action: 'retired', outcome: 'unchanged' }
        })
        const res = await lateOps.treePatch({ id: name, specifier: entry.specifier, disabled: true, expectedBallId })
        return { ...organMutationAck(res.mutation), action: 'retired' }
      } catch (err) {
        return organMutationFailure(err, mutationAttempted)
      }
    },
  }
  try {
    hostCtx.provide('organs', organsService)
    hostCtx.organs = organsService
  } catch {}
  try {
    hostCtx.provide('fs', vfs)
  } catch {}

  // Wrap `ctx.web.registerFetchProvider` and `registerSearchProvider` so any `ball:<sha256>` plugin
  // registering a custom provider (such as `auma-web-eyes`) automatically pins `web.config.fetchProvider`
  // / `searchProvider` while mounted, preventing `WEB_PROVIDER_AMBIGUOUS` when `local` is also registered,
  // and cleanly restores the previous provider when disposed!
  const webSvc = hostCtx.get('web') as WebServiceLike | undefined
  if (webSvc && !webSvc.__x6Wrapped) {
    let pinnedFetchId: string | undefined
    let pinnedSearchId: string | undefined
    const origFetchVolatile = webSvc.config?.fetchProvider
    const origSearchVolatile = webSvc.config?.searchProvider
    if (webSvc.config) {
      ;(webSvc.config as Record<string, unknown>).fetchProvider = {
        get: () => pinnedFetchId ?? origFetchVolatile?.get(),
        set: (id: string | undefined) => { pinnedFetchId = id },
      }
      ;(webSvc.config as Record<string, unknown>).searchProvider = {
        get: () => pinnedSearchId ?? origSearchVolatile?.get(),
        set: (id: string | undefined) => { pinnedSearchId = id },
      }
    }
    if (typeof webSvc.registerFetchProvider === 'function') {
      const origRegFetch = webSvc.registerFetchProvider.bind(webSvc)
      webSvc.registerFetchProvider = (
        provider: { id: string; available?: () => boolean; fetch(req: unknown): Promise<unknown> },
      ): (() => void) => {
        const normalized = typeof provider.available === 'function'
          ? provider
          : { ...provider, available: () => true }
        const prevPinned = pinnedFetchId
        const dispose = origRegFetch(normalized)
        if (provider.id && provider.id !== 'local' && provider.id !== 'http') {
          pinnedFetchId = provider.id
        }
        return () => {
          try { dispose() } catch {}
          if (pinnedFetchId === provider.id) {
            pinnedFetchId = prevPinned
          }
        }
      }
    }
    if (typeof webSvc.registerSearchProvider === 'function') {
      const origRegSearch = webSvc.registerSearchProvider.bind(webSvc)
      webSvc.registerSearchProvider = (
        provider: { id: string; available?: () => boolean; search(req: unknown): Promise<unknown> },
      ): (() => void) => {
        const normalized = typeof provider.available === 'function'
          ? provider
          : { ...provider, available: () => true }
        const prevPinned = pinnedSearchId
        const dispose = origRegSearch(normalized)
        if (provider.id) {
          pinnedSearchId = provider.id
        }
        return () => {
          try { dispose() } catch {}
          if (pinnedSearchId === provider.id) {
            pinnedSearchId = prevPinned
          }
        }
      }
    }
    webSvc.__x6Wrapped = true
  }

  // Alien Data-Plane Prompt Sections (`/dsh/home/auma/prompt-sections.json`) & Snapshot-First Engine
  vfs.mkdirSync(SNAPSHOTS_DIR, { recursive: true })
  const activePromptDisposers = new Map<string, () => void>()
  let promptSections: Record<string, PromptSectionRecord> = {}

  const sysPromptSvc = hostCtx.get('systemPrompt') as SystemPromptServiceLike | undefined

  const mountPromptSection = (rec: PromptSectionRecord): void => {
    const existingDispose = activePromptDisposers.get(rec.name)
    if (existingDispose) {
      try { existingDispose() } catch {}
      activePromptDisposers.delete(rec.name)
    }
    if (sysPromptSvc && typeof sysPromptSvc.section === 'function') {
      try {
        const d = sysPromptSvc.section({
          name: `auma:custom:${rec.name}`,
          order: rec.order,
          text: rec.text,
          interpolate: false,
        })
        if (typeof d === 'function') activePromptDisposers.set(rec.name, d)
      } catch (err) {
        console.warn(`x6-ball: could not mount prompt section ${rec.name}`, err)
      }
    }
  }

  if (vfs.existsSync(PROMPT_SECTIONS_PATH)) {
    try {
      const parsed = JSON.parse(vfs.readFileSync(PROMPT_SECTIONS_PATH, 'utf8') as string) as Record<string, PromptSectionRecord>
      if (parsed && typeof parsed === 'object') {
        promptSections = parsed
        for (const rec of Object.values(promptSections)) {
          if (rec && rec.name && typeof rec.text === 'string') {
            mountPromptSection(rec)
          }
        }
      }
    } catch {}
  }

  const collectCodeBySha = (manifest: BallManifest): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const sha of Object.keys(manifest.modules)) {
      const p = join(BALLS_DIR, `${sha}.js`)
      if (vfs.existsSync(p)) {
        out[sha] = vfs.readFileSync(p, 'utf8') as string
      }
    }
    for (const entry of Object.values(manifest.entries)) {
      if (entry.specifier.startsWith('ball:')) {
        const sha = entry.specifier.slice('ball:'.length)
        const p = join(BALLS_DIR, `${sha}.js`)
        if (vfs.existsSync(p)) {
          out[sha] = vfs.readFileSync(p, 'utf8') as string
        }
      }
    }
    return out
  }

  const writeStagedHeadPromotion = (previous: BallManifest, input: unknown, selectedBallId: string) => {
    if (currentBall.ballId !== selectedBallId) throw new Error('STAGED_PROMOTION_HEAD_CHANGED')
    const text = serializeStagedHeadPromotion(previous, input)
    const expectedStagedSha256 = record(input) ? input.expectedStagedSha256 : undefined
    if (expectedStagedSha256 !== undefined && expectedStagedSha256 !== null
      && (typeof expectedStagedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedStagedSha256))) throw new Error('STAGED_PROMOTION_REVIEW_CONFLICT')
    const acknowledgement = (savedText: string, idempotent: boolean) => ({ ok: true as const, staged: true as const,
      path: STAGED_HEAD_PROMOTION_PATH, stagedSha256: sha256HexSync(savedText), idempotent,
      ownerApproval: false as const, qualified: false as const, localSaved: false as const, remoteSaved: false as const })
    let existingText: string | null = null
    if (vfs.existsSync(STAGED_HEAD_PROMOTION_PATH)) {
      const stat = vfs.statSync(STAGED_HEAD_PROMOTION_PATH, { bigint: true })
      if (!stat.isFile() || !('nlink' in stat) || stat.nlink !== 1n) throw new Error('STAGED_PROMOTION_TARGET_NOT_PRIVATE')
      if (Number(stat.size) > STAGED_HEAD_PROMOTION_MAX_BYTES) throw new Error('STAGED_PROMOTION_EXISTING_BYTE_LIMIT')
      existingText = vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
    }
    const existingSha256 = existingText === null ? null : sha256HexSync(existingText)
    if (expectedStagedSha256 !== undefined && expectedStagedSha256 !== existingSha256) throw new Error('STAGED_PROMOTION_REVIEW_CONFLICT')
    if (existingText !== null) {
      let existing: unknown
      try { existing = JSON.parse(existingText) }
      catch (_error) { existing = null }
      const next: unknown = JSON.parse(text)
      if (record(existing) && existing.schema === 'aukora.staged-head-promotion.v1'
        && Object.keys(existing).every(key => ['schema', 'stagedAt', 'body'].includes(key))
        && Number.isSafeInteger(existing.stagedAt) && Number(existing.stagedAt) >= 0 && record(next)
        && JSON.stringify(existing.body) === JSON.stringify(next.body)) return acknowledgement(existingText, true)
      // No request may silently replace a candidate that the owner may already be reviewing.
      if (expectedStagedSha256 !== existingSha256) throw new Error('STAGED_PROMOTION_REVIEW_CONFLICT')
    }
    // MemoryVfs has no symlinks, and the caller cannot select a path.
    vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
    vfs.writeFileSync(STAGED_HEAD_PROMOTION_PATH, text)
    // This operation acknowledges VFS bytes only. Persistence retains its own failure reporting.
    return acknowledgement(text, false)
  }
  const stageHeadPromotion = (input: unknown) => writeStagedHeadPromotion(currentBall, input, currentBall.ballId)
  /** Save one refused outward request for the owner's passkey, as the exact JSON the host was (or would be) sent. */
  const stageOutward = (tool: 'x6_github' | 'x6_repo', pathname: '/_host/github' | '/_host/repo', args: unknown,
    answer: Record<string, unknown>): Record<string, unknown> => {
    const body: unknown = JSON.parse(JSON.stringify(args))
    const text = JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: Date.now(), tool, method: 'POST', pathname, body }, null, 2) + '\n'
    if (new TextEncoder().encode(text).byteLength > STAGED_OUTWARD_MAX_BYTES) return { ...answer, stagedForOwner: false, stageError: 'STAGED_OUTWARD_TOO_LARGE' }
    vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
    vfs.writeFileSync(STAGED_OUTWARD_PATH, text)
    return { ...answer, stagedForOwner: true, stagedPath: STAGED_OUTWARD_PATH, sent: false,
      next: 'Nothing was sent. The owner sees these exact bytes in Sovereignty and approves them with Touch ID; the page sends them. '
        + 'Staging another request replaces this one.' }
  }

  const readTextSafe = (p: string): string => {
    try {
      if (vfs.existsSync(p)) return vfs.readFileSync(p, 'utf8') as string
    } catch {}
    return ''
  }
  /** Lane E5: HANDOFF lives in `/dsh/home/auma`; the legacy `/dsh/home/auma-one` copy is read only when that one is absent. */
  const readHandoffSafe = (): string => vfs.existsSync(HANDOFF_PATH) ? readTextSafe(HANDOFF_PATH) : readTextSafe(AUMA_ONE_HANDOFF_PATH)

  const createSnapshot = (label = 'manual'): AumaSnapshotRecord => {
    const codeBySha = collectCodeBySha(currentBall)
    if (!manifestIdMatches(currentBall)
      || Object.entries(codeBySha).some(([sha, code]) => sha256HexSync(code) !== sha)
      || Object.entries(currentBall.modules).some(([sha, meta]) => meta.sha256 !== sha || meta.specifier !== `ball:${sha}` || !Object.hasOwn(codeBySha, sha))
      || Object.values(currentBall.entries).some(entry => [
        entry.specifier, ...entry.previousSpecifiers, ...(entry.previousVersions ?? []).map(version => version.specifier),
      ]
        .some(specifier => specifier.startsWith('ball:') && (!Object.hasOwn(codeBySha, specifier.slice(5)) || !Object.hasOwn(currentBall.modules, specifier.slice(5)))))) {
      throw new Error('SNAPSHOT_CONTENT_HASH_MISMATCH')
    }
    const cordisPatchYml = readTextSafe(CORDIS_PATCH_PATH)
    const handoffMd = readHandoffSafe()
    const wishMd = readTextSafe(WISH_PATH)
    const canonical = JSON.stringify({
      ballId: currentBall.ballId,
      epoch: currentBall.epoch,
      entries: currentBall.entries,
      promptSections,
      cordisPatchYml,
      handoffMd,
      wishMd,
    })
    const snapshotId = sha256HexSync(canonical)
    const snap: AumaSnapshotRecord = {
      snapshotId,
      label,
      createdAt: Date.now(),
      ball: currentBall,
      codeBySha,
      promptSections: { ...promptSections },
      cordisPatchYml,
      handoffMd,
      wishMd,
    }
    vfs.mkdirSync(SNAPSHOTS_DIR, { recursive: true })
    const serialized = JSON.stringify(snap, null, 2) + '\n'
    const snapshotPath = join(SNAPSHOTS_DIR, `${snapshotId}.json`)
    if (vfs.existsSync(snapshotPath)) {
      const existing = JSON.parse(vfs.readFileSync(snapshotPath, 'utf8') as string) as AumaSnapshotRecord
      if (existing.snapshotId !== snapshotId || JSON.stringify(existing.ball) !== JSON.stringify(currentBall)
        || JSON.stringify(existing.codeBySha) !== JSON.stringify(codeBySha)
        || JSON.stringify(existing.promptSections) !== JSON.stringify(promptSections)
        || existing.cordisPatchYml !== cordisPatchYml || existing.handoffMd !== handoffMd || existing.wishMd !== wishMd
        || Object.entries(existing.codeBySha).some(([sha, code]) => sha256HexSync(code) !== sha)) throw new Error('X6_HISTORY_APPEND_ONLY')
      vfs.writeFileSync(LATEST_SNAPSHOT_PATH, JSON.stringify(existing, null, 2) + '\n')
      return existing
    }
    appendHistoricalFile(snapshotPath, serialized)
    vfs.writeFileSync(LATEST_SNAPSHOT_PATH, serialized)
    return snap
  }

  const listSnapshots = (): Array<{
    snapshotId: string
    label: string
    createdAt: number
    ballId: string
    epoch: number
    entriesCount: number
  }> => {
    if (!vfs.existsSync(SNAPSHOTS_DIR)) return []
    const files = vfs.readdirSync(SNAPSHOTS_DIR)
      .map(String)
      .filter(f => f.endsWith('.json') && f !== 'LATEST.json')
    const list: Array<{
      snapshotId: string
      label: string
      createdAt: number
      ballId: string
      epoch: number
      entriesCount: number
    }> = []
    for (const file of files) {
      try {
        const snap = JSON.parse(vfs.readFileSync(join(SNAPSHOTS_DIR, file), 'utf8') as string) as AumaSnapshotRecord
        if (snap && snap.snapshotId && snap.ball) {
          list.push({
            snapshotId: snap.snapshotId,
            label: snap.label,
            createdAt: snap.createdAt,
            ballId: snap.ball.ballId,
            epoch: snap.ball.epoch,
            entriesCount: Object.keys(snap.ball.entries ?? {}).length,
          })
        }
      } catch {}
    }
    return list.sort((a, b) => b.createdAt - a.createdAt)
  }

  const restoreSnapshot = async (targetSnapshotId?: string): Promise<{
    ok: true
    restoredSnapshotId: string
    mutation: BallMutationState
    label: string
    ballId: string
    epoch: number
  }> => mutateSelected(async (markApplied) => {
    if (targetSnapshotId && !/^[a-f0-9]{64}(?:\.json)?$/.test(targetSnapshotId)) throw new Error('INVALID_SNAPSHOT_ID')
    const snapPath = targetSnapshotId
      ? join(SNAPSHOTS_DIR, `${targetSnapshotId.replace(/\.json$/, '')}.json`)
      : LATEST_SNAPSHOT_PATH
    if (!vfs.existsSync(snapPath)) {
      throw new Error(`Snapshot not found: ${targetSnapshotId ?? 'LATEST'}`)
    }
    const snap = JSON.parse(vfs.readFileSync(snapPath, 'utf8') as string) as AumaSnapshotRecord
    if (targetSnapshotId && targetSnapshotId.replace(/\.json$/, '') !== snap.snapshotId) throw new Error('SNAPSHOT_TARGET_MISMATCH')
    if (snap.ball?.version !== 'x6.1-ball/v1' || !manifestIdMatches(snap.ball)) throw new Error('SNAPSHOT_MANIFEST_HASH_MISMATCH')
    const expectedSnapshotId = sha256HexSync(JSON.stringify({
      ballId: snap.ball.ballId, epoch: snap.ball.epoch, entries: snap.ball.entries,
      promptSections: snap.promptSections, cordisPatchYml: snap.cordisPatchYml,
      handoffMd: snap.handoffMd, wishMd: snap.wishMd,
    }))
    if (snap.snapshotId !== expectedSnapshotId) throw new Error('SNAPSHOT_CONTENT_HASH_MISMATCH')
    requireManifestAdmission(snap.ball)
    // Even a same-head snapshot can change prompt/configuration data; no qualification covers it.
    refuseUnqualifiedMutation({ action: 'snapshot_restore' })
    const codes = Object.entries(snap.codeBySha ?? {})
    for (const [sha, code] of codes) {
      if (!/^[a-f0-9]{64}$/.test(sha) || typeof code !== 'string' || sha256HexSync(code) !== sha) throw new Error('SNAPSHOT_MODULE_HASH_MISMATCH')
    }
    for (const [sha, metadata] of Object.entries(snap.ball.modules)) {
      if (!/^[a-f0-9]{64}$/.test(sha) || metadata.sha256 !== sha || metadata.specifier !== `ball:${sha}`) throw new Error('SNAPSHOT_MODULE_METADATA_MISMATCH')
      const code = snap.codeBySha?.[sha] ?? (vfs.existsSync(join(BALLS_DIR, `${sha}.js`)) ? vfs.readFileSync(join(BALLS_DIR, `${sha}.js`), 'utf8') as string : null)
      if (typeof code !== 'string' || sha256HexSync(code) !== sha) throw new Error('SNAPSHOT_MODULE_MISSING')
    }
    for (const entry of Object.values(snap.ball.entries)) {
      const versions = [entry, ...(entry.previousVersions ?? []), ...(entry.previousSpecifiers ?? []).map(specifier => ({ specifier }))]
      for (const version of versions) {
        if (typeof version.specifier !== 'string') throw new Error('SNAPSHOT_ENTRY_INVALID')
        if (version.specifier.startsWith('ball:')) {
          const sha = version.specifier.slice(5)
          if (!/^[a-f0-9]{64}$/.test(sha) || !Object.hasOwn(snap.ball.modules, sha)) throw new Error('SNAPSHOT_MODULE_UNDECLARED')
        }
      }
    }
    // Validate every hash before writing any immutable module or changing fibers.
    for (const [sha, code] of codes) vfs.writeFileSync(join(BALLS_DIR, `${sha}.js`), code)
    const before = currentBall
    const restoredBall = {
      ...snap.ball,
      parentBallId: before.ballId,
      epoch: before.epoch + 1,
      createdAt: Date.now(),
      authorPeerId: peerId,
      ballId: computeBallId(before.ballId, before.epoch + 1, snap.ball.entries, snap.ball.modules),
    }
    await reconcileToManifest(restoredBall, markApplied)
    for (const d of activePromptDisposers.values()) {
      try { d() } catch {}
    }
    activePromptDisposers.clear()
    promptSections = { ...(snap.promptSections ?? {}) }
    vfs.writeFileSync(PROMPT_SECTIONS_PATH, JSON.stringify(promptSections, null, 2) + '\n')
    for (const rec of Object.values(promptSections)) {
      mountPromptSection(rec)
    }
    if (typeof snap.cordisPatchYml === 'string' && snap.cordisPatchYml.length > 0) {
      vfs.mkdirSync('/dsh/home/profiles/web', { recursive: true })
      vfs.writeFileSync(CORDIS_PATCH_PATH, snap.cordisPatchYml)
    }
    if (typeof snap.handoffMd === 'string' && snap.handoffMd.length > 0) {
      vfs.writeFileSync(HANDOFF_PATH, snap.handoffMd)
      vfs.writeFileSync(WORKSPACE_HANDOFF_PATH, snap.handoffMd)
    }
    if (typeof snap.wishMd === 'string' && snap.wishMd.length > 0) {
      vfs.writeFileSync(WISH_PATH, snap.wishMd)
    }
    const mutation = await completeMutation('snapshot.restore', snap.snapshotId)
    return {
      ok: true,
      restoredSnapshotId: snap.snapshotId,
      mutation,
      label: snap.label,
      ballId: currentBall.ballId,
      epoch: currentBall.epoch,
    }
  })

  /**
   * Every HEAD entry's state, from its fiber's ACTUAL lifecycle. `running` only
   * while a fiber of this exact specifier and config is ACTIVE in Cordis, which it reaches only after its apply()
   * completed; `support-module` (its exports carry functions but no apply() and no { name, run }: nothing to mount, by
   * design, decided by the loader alone); `disabled`; or `not-running` with a reason code and detail: the loader's own
   * fault (SCION_ORGAN_NAME_MISMATCH with exportName and entryId, BALL_MODULE_NOT_A_PLUGIN, TOOL_REGISTRATION_REFUSED),
   * MODULE_LOAD_FAILED, APPLY_FAILED, RESTART_FAILED (apply() threw on a later restart), WAITING_FOR_SERVICE (which
   * services), FIBER_LOADING / FIBER_UNLOADING / FIBER_DISPOSED, FIBER_RUNS_OTHER_VERSION or NOT_MOUNTED.
   * A fiber that does not report a Cordis state is never called running (FIBER_STATE_UNREADABLE).
   */
  type EntryState = { state: 'running' | 'disabled' } | { state: 'support-module'; decidedBy: 'exports' }
    | ({ state: 'not-running'; reason: string; detail?: string; services?: string[] } & Readonly<Record<string, unknown>>)
  const notRunning = (failure: MountFailureDetail): EntryState =>
    ({ ...failure.fields, state: 'not-running', reason: failure.code, detail: failure.detail })
  const fiberEntryState = (fiber: CordisFiberLike): EntryState => {
    switch (fiber.state) {
      case CORDIS_FIBER_ACTIVE: return { state: 'running' }
      case CORDIS_FIBER_PENDING: {
        const services = Object.keys(fiber.inject ?? {}).filter((name) => {
          try { return hostCtx.get(name) == null } catch { return true }
        })
        return { state: 'not-running', reason: 'WAITING_FOR_SERVICE', services,
          detail: services.length > 0 ? `apply() has not run: waiting for ${services.join(', ')}` : 'apply() has not run: a required service is not ready' }
      }
      case CORDIS_FIBER_FAILED: return notRunning(fiberFailures.get(fiber)
        ?? { code: 'APPLY_FAILED', detail: 'the fiber failed; its error was not observed', fields: {}, at: Date.now() })
      case CORDIS_FIBER_LOADING: return { state: 'not-running', reason: 'FIBER_LOADING', detail: 'apply() is running' }
      case CORDIS_FIBER_UNLOADING: return { state: 'not-running', reason: 'FIBER_UNLOADING' }
      case CORDIS_FIBER_DISPOSED: return { state: 'not-running', reason: 'FIBER_DISPOSED' }
      default: return { state: 'not-running', reason: 'FIBER_STATE_UNREADABLE', detail: 'the host did not report a Cordis fiber state' }
    }
  }
  const entryState = (entry: BallEntryRecord): EntryState => {
    if (entry.disabled) return { state: 'disabled' }
    const active = activeFibers.get(entry.id), failure = mountFailures.get(entry.id)
    if (active !== undefined && active.specifier === entry.specifier && active.configJson === JSON.stringify(entry.config ?? {})) {
      return fiberEntryState(active.fiber)
    }
    if (failure !== undefined && failure.specifier === entry.specifier && failure.configJson === JSON.stringify(entry.config)) {
      return failure.code === 'SUPPORT_MODULE' ? { state: 'support-module', decidedBy: 'exports' } : notRunning(failure)
    }
    return { state: 'not-running', reason: active ? 'FIBER_RUNS_OTHER_VERSION' : 'NOT_MOUNTED' }
  }
  /** A map with no prototype, so an entry called `__proto__` is an entry like any other. */
  const computeEntryStates = (): Record<string, EntryState> => {
    const states = Object.create(null) as Record<string, EntryState>
    for (const entry of Object.values(currentBall.entries)) states[entry.id] = entryState(entry)
    return states
  }
  const computeFiberHealth = () => {
    const entries = computeEntryStates()
    const enabledEntries = Object.values(currentBall.entries).filter(e => !e.disabled)
    return {
      activeCount: activeFibers.size,
      enabledEntriesCount: enabledEntries.length,
      missingExpected: enabledEntries.filter(entry => entries[entry.id]?.state !== 'running').map(entry => entry.id),
      entries,
    }
  }

  const compiler = createScionCompiler()
  const scionService = {
    /** Compare an explicit candidate with the current incumbent; diagnostic baseline reads never admit promotion. */
    async trialRetentionCandidate(input: {
      organId?: string
      candidateSource?: string
      candidateSpecifier?: string
      baselineSpecifier?: string
      baseline?: boolean
    }) {
      try { syncCandidateBallsStore(vfs) } catch {}
      const head = currentBall
      const suiteText = vfs.readFileSync(RETENTION_SUITE_PATH, 'utf8') as string
      if (new TextEncoder().encode(suiteText).byteLength > 1024 * 1024) throw new Error('PEARL_SUITE_LIMIT')
      const suite = JSON.parse(suiteText) as Record<string, unknown>
      if (suite.schema !== 'aukora.pearl.retention-suite.v1' || !Array.isArray(suite.cases) || !suite.cases.length || !suite.fixtures || typeof suite.fixtures !== 'object' || Array.isArray(suite.fixtures)
        || typeof suite.fixedNow !== 'number' || !Number.isFinite(suite.fixedNow)) throw new Error('PEARL_SUITE_INVALID')
      const suiteDigest = retentionSuiteDigest(suite)
      const suiteBytesDigest = sha256HexSync(vfs.readFileSync(RETENTION_SUITE_PATH))
      const suiteAdmitted = baselineConfigured ? admittedBaseline !== null && retentionSuiteExtendsBaseline(suite, admittedBaseline)
        : admittedSuiteDigest !== null && admittedSuiteDigest === suiteDigest
      const cases: Record<string, unknown>[] = suite.cases.map((row: unknown) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('PEARL_SUITE_INVALID')
        const test = row as Record<string, unknown>
        return { id: test.id, args: test.args, ...(Object.hasOwn(test, 'expectError') ? { expectError: test.expectError } : { expect: test.expect }), ...(test.routePolicy === undefined ? {} : { routePolicy: test.routePolicy }) }
      })
      const names = new Set<string>()
      for (const name of Array.isArray(suite.organs) ? suite.organs : []) {
        if (typeof name !== 'string') throw new Error('PEARL_SUITE_INVALID')
        names.add(name)
      }
      for (const test of cases) {
        const args = test.args as { organ?: unknown } | null
        if (!args || typeof args.organ !== 'string') throw new Error('PEARL_SUITE_INVALID')
        names.add(args.organ)
      }
      const organId = input.organId
      if (organId !== undefined && (!/^[a-z][a-z0-9-]{0,63}$/.test(organId) || !head.entries[organId])) throw new Error('PEARL_ORGAN_ID_INVALID')
      if (!organId && (input.candidateSource !== undefined || input.candidateSpecifier !== undefined || input.baselineSpecifier !== undefined)) throw new Error('PEARL_ORGAN_ID_REQUIRED')
      if (input.candidateSource !== undefined && input.candidateSpecifier !== undefined) throw new Error('PEARL_CANDIDATE_AMBIGUOUS')
      if (input.baselineSpecifier !== undefined) throw new Error('PEARL_BASELINE_OVERRIDE_REFUSED')
      if (organId) names.add(organId)
      const build: Record<string, string> = Object.create(null)
      const shas: Record<string, string> = Object.create(null)
      const incumbentBuild: Record<string, string> = {}
      const incumbentShas: Record<string, string> = {}
      Object.setPrototypeOf(incumbentBuild, null)
      Object.setPrototypeOf(incumbentShas, null)
      for (const name of [...names].sort()) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('PEARL_ORGAN_ID_INVALID')
        const entry = head.entries[name]
        const selected = name === organId
        const readSource = (specifier: string | undefined): string => {
          if (typeof specifier !== 'string' || !/^ball:[a-f0-9]{64}$/.test(specifier)) throw new Error('PEARL_BUILD_UNAVAILABLE: ' + name)
          const code = vfs.readFileSync(join(BALLS_DIR, specifier.slice(5) + '.js'), 'utf8') as string
          if (sha256HexSync(code) !== specifier.slice(5)) throw new Error('PEARL_MODULE_HASH_MISMATCH: ' + name)
          return code
        }
        // Capture the selected incumbent and every peer before either arm executes.
        incumbentBuild[name] = readSource(entry?.specifier)
        incumbentShas[name] = sha256HexSync(incumbentBuild[name])
        let code: string
        if (selected && !input.baseline && input.candidateSource !== undefined) code = input.candidateSource
        else if (selected && !input.baseline && input.candidateSpecifier !== undefined) code = readSource(input.candidateSpecifier)
        else code = incumbentBuild[name]
        if (typeof code !== 'string' || !code.trim()) throw new Error('PEARL_SOURCE_INVALID')
        build[name] = code
        shas[name] = sha256HexSync(code)
      }
      const retained = { fixtures: suite.fixtures as Record<string, unknown>, fixedNow: suite.fixedNow, cases }
      const currentInputsMatch = (): boolean => currentBall.ballId === head.ballId && currentSuiteDigest() === suiteDigest
        && sha256HexSync(vfs.readFileSync(RETENTION_SUITE_PATH)) === suiteBytesDigest
      const completeTrial = (trial: CandidateTrialResult): boolean => trial.results.length === cases.length
        && trial.results.every((row, index) => row.id === cases[index]?.id && typeof row.pass === 'boolean' && Object.hasOwn(row, 'got'))
        && trial.graderControls?.allPassed === true && trial.graderControls.knownGoodAccepted && trial.graderControls.knownBadRejected
        && trial.graderControls.acceptAllRejected && trial.graderControls.rejectAllRejected
        && (trial.routeEvidence?.status === 'checked' || trial.routeEvidence?.status === 'unsupported')
        && trial.routeEvidence.checkedProperties.includes('exact-case-result-framing')
        && trial.routeEvidence.checkedProperties.includes('parent-output-comparison')
      const result = await trialScionRetention(build, retained)
      const candidateInputsUnchanged = currentInputsMatch()
      // Diagnostic incumbent reads never mint an admission. Promotion comparisons own both actual runs.
      const incumbentResult = input.baseline ? null : await trialScionRetention(incumbentBuild, retained)
      const zeroArm = result.results.length === 0 ? { arm: 'candidate', cause: result.error }
        : incumbentResult !== null && incumbentResult.results.length === 0 ? { arm: 'baseline', cause: incumbentResult.error } : null
      const passedCases = result.results.filter(row => row.pass === true).length
      const baselinePassedCases = incumbentResult?.results.filter(row => row.pass === true).length ?? 0
      const targetCovered = Boolean(organId && cases.some(test => (test.args as { organ: string }).organ === organId))
      const unchanged = candidateInputsUnchanged && currentInputsMatch()
      const comparisonComplete = Boolean(incumbentResult && completeTrial(result) && completeTrial(incumbentResult)
        && result.graderControls?.caseSetDigest === incumbentResult.graderControls?.caseSetDigest
        && result.graderControls?.runnerDigest === incumbentResult.graderControls?.runnerDigest && unchanged)
      const targetImproved = comparisonComplete && cases.some((test, index) => (test.args as { organ: string }).organ === organId
        && incumbentResult?.results[index]?.pass === false && result.results[index]?.pass === true)
      const winnerId = !comparisonComplete || passedCases === baselinePassedCases ? null : passedCases > baselinePassedCases ? 'candidate' : 'baseline'
      const qualifiedForPromotion = Boolean(result.ok && passedCases === cases.length && targetCovered && targetImproved
        && winnerId === 'candidate' && organId && shas[organId] !== incumbentShas[organId] && suiteAdmitted)
      let qualificationId: string | null = null
      // R39 T1: Pearl retention qualification is minted for any passing organ so T1 single-organ canonical updates can auto-commit.
      if (qualifiedForPromotion && organId && !input.baseline) {
        qualificationId = randomUUID()
        if (retentionAdmissions.size >= 32) {
          const oldest = retentionAdmissions.keys().next()
          if (!oldest.done) retentionAdmissions.delete(oldest.value)
        }
        retentionAdmissions.set(qualificationId, { organId, specifier: `ball:${shas[organId]}`, headBallId: head.ballId, suiteDigest, issuedAt: Date.now() })
      }
      return { ...result, trialOk: result.ok, passedCases, totalCases: cases.length, targetCovered, qualifiedForPromotion,
        qualificationId, organs: shas, headBallId: head.ballId, headEpoch: head.epoch, suiteDigest, suiteBytesDigest,
        comparisonComplete, targetImproved, winnerId, decidedBy: winnerId === null ? 'inconclusive' : 'retention-passes',
        baselineResult: incumbentResult ? { ...incumbentResult, trialOk: incumbentResult.ok, passedCases: baselinePassedCases,
          totalCases: cases.length, organs: incumbentShas, headBallId: head.ballId, headEpoch: head.epoch, suiteDigest, suiteBytesDigest,
          suiteAdmission: suiteAdmitted ? 'build-pinned' : 'unverified', targetCovered, qualifiedForPromotion: false, qualificationId: null } : null,
        suiteAdmission: suiteAdmitted ? 'build-pinned' : 'unverified',
        ...(!suitePinAvailable ? { admissionError: 'PEARL_SUITE_PIN_UNAVAILABLE' }
          : !suiteAdmitted ? { admissionError: 'PEARL_SUITE_PIN_MISMATCH' } : {}),
        admissionScope: 'behavioral-retention-only', protectedSurface: Boolean(organId && protectedOrgans.has(organId)),
        // Round 37: an arm that observed no case is not a score of zero; it is named, beside each arm's own error (which
        // Pearl reports per arm), never written over it.
        ...(zeroArm === null ? {} : { arenaRefusal: `ARENA_ZERO_OBSERVATIONS: the ${zeroArm.arm} arm ran no case`
          + `${typeof zeroArm.cause === 'string' ? ` (${zeroArm.cause.slice(0, 300)})` : ''}`, arenaObservations: 0 }) }
    },
    async growOrgan(input: ScionGrowthInput): Promise<Record<string, unknown>> {
      return await growScionOrgan(input, {
        head: () => currentBall.ballId,
        writable: () => persistence.durable && !persistence.readOnly && !persistence.conflict,
        active: (name, sha256) => (
          mountedOrgans.get(name)?.sha256 === sha256
          && currentBall.entries[name]?.specifier === `ball:${sha256}`
          && currentBall.entries[name]?.disabled === false
          && activeFibers.get(name)?.specifier === `ball:${sha256}`
        ),
        prepare: request => scionService.compileOrgan(request),
        trial: request => trialScionCandidate(request),
        cycle: request => organsService.call('seed-cycle', request),
      })
    },
    async trialCandidate(input: CandidateTrialInput) {
      return await trialScionCandidate(input)
    },
    async compileOrgan(input: ScionInput & { name?: string; includeCode?: boolean }) {
      if (!lateOps.ballPut) throw new Error('Ball preparation is unavailable')
      const output = await compiler.compile(input)
      const meta = await lateOps.ballPut({ code: output.code, name: input.name ?? input.entry, description: `Scion ${output.compiler.version} compiled organ` })
      if (meta.sha256 !== output.outputSha256) throw new Error('Compiled artifact hash changed during preparation')
      let receiptAppended = false
      try {
        const receipt = await organsService.call('seed-receipts', {
          action: 'append', kind: 'scion.compile',
          data: { inputRoot: output.inputRoot, outputSha256: meta.sha256, compiler: output.compiler, modules: output.modules },
        }) as { ok?: boolean }
        receiptAppended = receipt.ok === true
      } catch (error) { console.warn('Scion compilation receipt unavailable', error) }
      let localSaved = false
      let saveError: string | null = null
      try { await persistence.flush(); localSaved = persistence.durable }
      catch (error) { saveError = error instanceof Error ? error.message : String(error) }
      return {
        ok: true, action: 'compile_organ', compiled: true, prepared: true, activated: false,
        localSaved, remoteSaved: false, receiptAppended, receiptSaved: receiptAppended && localSaved,
        ...(saveError ? { saveError } : {}),
        specifier: meta.specifier, sha256: meta.sha256, path: join(BALLS_DIR, `${meta.sha256}.js`),
        inputRoot: output.inputRoot, compiler: output.compiler, bytes: output.bytes, modules: output.modules,
        warnings: output.warnings, ...(input.includeCode ? { code: output.code } : {}),
      }
    },
  }

  const snapshotsService = {
    mirrorState: () => ({ ...persistence.mirror, localConflict: persistence.conflict, localSave: { ...persistence.localSave } }),
    persistence: () => ({
      durable: persistence.durable,
      readOnly: persistence.readOnly,
      conflict: persistence.conflict,
      localSave: { ...persistence.localSave },
      mirror: { ...persistence.mirror },
    }),
    async syncMirror() {
      refuseUnqualifiedMutation({ action: 'sync', tool: 'mirror' })
      if (!persistence.durable || persistence.readOnly || !persistence.mirror.target) throw new Error('Local mirror persistence is unavailable or read-only')
      await persistence.upload()
      if (persistence.mirror.pendingBatches !== 0 || persistence.mirror.error || persistence.localSave.pendingPaths || persistence.localSave.error) throw new Error('Local save or mirror delivery acknowledgement is incomplete; preserve unsaved work in this open tab')
      return { ...persistence.mirror, localSave: { ...persistence.localSave } }
    },
    persistenceState: () => ({ writable: persistence.durable && !persistence.readOnly, conflict: persistence.conflict }),
    async flush() {
      if (!persistence.durable || persistence.readOnly) throw new Error('Local persistence is unavailable or read-only')
      await persistence.flush()
      if (!persistence.durable || persistence.readOnly) throw new Error('Local persistence acknowledgement is unavailable')
      return { localSaved: true, remoteSaved: false }
    },
    create: createSnapshot,
    list: listSnapshots,
    restore: restoreSnapshot,
    effectLedger: () => Object.fromEntries(effectLedger),
    motorMemory: () => Object.fromEntries(motorMemory),
    buildSha: () => buildSha,
    buildIdentity: () => ({ ...buildIdentity }),
    hostSourceSha: () => hostSourceSha,
    hostHead: () => hostHeadInfo ? { ...hostHeadInfo } : null,
    async checkHostHead() {
      if (!origin || origin === 'null') return hostHeadInfo ? { ...hostHeadInfo } : null
      const order = lateOps.headReadOrder, read = order?.begin()
      try {
        const res = await fetch(new URL('/_head/ball', origin).href, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(2500),
        })
        if (res.ok) {
          const remote = await res.json() as { ok?: boolean; ball?: BallManifest; head?: BallManifest; buildSha?: string }
          const remoteBall = remote.ball ?? remote.head
          if (remote.ok !== false && publishedHeadManifestValid(remoteBall)) {
            if (typeof remote.buildSha === 'string' && remote.buildSha) hostSourceSha = remote.buildSha
            // Recorded in the same order as every other read: a late answer never overwrites
            // a later read's record.
            if (order && read !== undefined) order.record(read, { ballId: remoteBall.ballId, epoch: remoteBall.epoch })
            else hostHeadInfo = { ballId: remoteBall.ballId, epoch: remoteBall.epoch, checkedAt: Date.now() }
          }
        }
      } catch {}
      return hostHeadInfo ? { ...hostHeadInfo } : null
    },
    // Reads and records the published head; an open tab never hot-swaps to it (see checkPublishedHead).
    adoptHostHead: (opts?: { force?: boolean }) => describePublishedHead(opts),
    fiberHealth: computeFiberHealth,
    mutationState: () => lastMutation,
  }
  ;(globalThis as { __X6_SERVICES__?: Record<string, unknown> }).__X6_SERVICES__ = {
    organs: organsService,
    presence: presenceService,
    tools: hostCtx.tools,
    web: webSvc,
    systemPrompt: sysPromptSvc,
    get configEditor() { return hostCtx.get('configEditor') },
    get agentPresets() { return hostCtx.get('agentPresets') },
    fs: vfs,
    snapshots: snapshotsService,
    scion: scionService,
  }
  try {
    hostCtx.provide('snapshots', snapshotsService)
  } catch {}

  const broadcastCommit = async (manifest: BallManifest): Promise<{ saved: boolean; target: string | null; error?: string }> => {
    const codeBySha = collectCodeBySha(manifest)
    const msg = {
      type: 'ball:commit',
      fromPeerId: peerId,
      ball: manifest,
      codeBySha,
      peer: peers.get(peerId),
      expectedParentBallId: manifest.parentBallId,
      expectedEpoch: manifest.epoch - 1,
      writerLease: activeWriterLease,
    }
    // Presence delivery is not a durable save acknowledgment. Only HTTP names the saved head.
    if (!origin || origin === 'null') return { saved: false, target: null, error: 'No head endpoint' }
    const target = new URL('/_head/ball', origin).href
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 10_000)
    try {
      const response = await hostRequest(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(msg),
        credentials: 'same-origin',
        signal: controller.signal,
      })
      const ack = await response.json() as { ok?: boolean; ballId?: string; code?: string }
      if (!response.ok || ack.ok !== true || ack.ballId !== manifest.ballId) {
        if (ack.code === 'CLASS3_WEBAUTHN_REQUIRED') {
          const parentPath = join(HISTORY_DIR, `${manifest.parentBallId}.json`)
          if (!vfs.existsSync(parentPath)) throw new Error('STAGED_PROMOTION_PARENT_UNAVAILABLE')
          const previous = JSON.parse(vfs.readFileSync(parentPath, 'utf8') as string) as BallManifest
          if (previous.ballId !== manifest.parentBallId || previous.epoch !== manifest.epoch - 1
            || !manifestIdMatches(previous)) throw new Error('STAGED_PROMOTION_PARENT_INVALID')
          writeStagedHeadPromotion(previous, msg, manifest.ballId)
        }
        return { saved: false, target, error: `${ack.code ?? 'HEAD_ACK_MISSING'}: head did not acknowledge ${manifest.ballId}: HTTP ${String(response.status)}` }
      }
      try { bc?.postMessage(msg) } catch {}
      return { saved: true, target }
    } catch (error) {
      return { saved: false, target, error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  const RECEIPTS_JSONL_PATH = '/dsh/home/auma/seed/receipts.v3.jsonl'
  const appendPromotionReceiptOnce = createSerializedPromotionReceiptAppender({
    readReceiptsJsonl: () => readTextSafe(RECEIPTS_JSONL_PATH),
    appendReceipt: (kind, data) =>
      organsService.call('seed-receipts', { action: 'append', kind, data }) as Promise<{ ok?: boolean }>,
  })

  const completeMutation = async (kind: string, id: string,
    context: TransitionContext = createTransitionContext(isTransitionKind(kind) ? kind : 'tree.patch')): Promise<BallMutationState> => {
    const manifest = currentBall
    const errors: Record<string, string> = {}
    let receiptSaved = false
    let receiptDeferred: string | null = null
    try {
      if (kind === 'head.promote' || kind === 'ball.promote') {
        // A governance epoch never gets a local T1 / hasApprovalToken:false leaf: the (epoch, ballId) dedupe would make
        // that lie permanent. It waits for the edge's authoritative lastPublishOutcome (ensureRetroPromotionReceipts).
        const plan = planPromotionReceipt({ entryId: id, manifest, context,
          governance: classifyEntryGovernance(id, manifest.entries[id]) === 3 })
        if (plan.write) {
          const out = await appendPromotionReceiptOnce({ kind, epoch: manifest.epoch, ballId: manifest.ballId, data: plan.data })
          receiptSaved = out.ok
        } else {
          receiptSaved = hasPromotionReceiptInJsonl(readTextSafe(RECEIPTS_JSONL_PATH), manifest.epoch, manifest.ballId)
          // Not awaited: the retro writer waits for seed-receipts and the edge; it records T2 or T1 from lastPublishOutcome.
          if (!receiptSaved) {
            receiptDeferred = plan.reason
            void lateOps.ensureRetroPromotionReceipts?.([id]).catch(() => [])
          }
        }
      } else {
        const receipt = await organsService.call('seed-receipts', {
          action: 'append', kind,
          data: { entryId: id, ballId: manifest.ballId, parentBallId: manifest.parentBallId, epoch: manifest.epoch,
            ...transitionFields(context) },
        }) as { ok?: boolean }
        receiptSaved = receipt.ok === true
      }
      if (receiptDeferred) errors.receipt = `${receiptDeferred}: governance receipt awaits the edge's lastPublishOutcome`
      else if (!receiptSaved) errors.receipt = 'Receipt append was not acknowledged'
    } catch (error) {
      errors.receipt = error instanceof Error ? error.message : String(error)
    }
    let localSaved = false
    try {
      await persistence.flush()
      localSaved = persistence.durable
      if (!localSaved) errors.local = 'IndexedDB is unavailable'
    } catch (error) {
      errors.local = error instanceof Error ? error.message : String(error)
    }
    const remote = await broadcastCommit(manifest)
    if (remote.error) errors.remote = remote.error
    lastMutation = {
      ballId: manifest.ballId, prepared: true, activated: true,
      localSaved, remoteSaved: remote.saved, remoteTarget: remote.target,
      receiptSaved: receiptSaved && localSaved, at: Date.now(), errors,
    }
    return lastMutation
  }

  const WAKE_STEPS_PATH = '/dsh/home/auma/wake/steps.jsonl'
  /** One bounded, deterministic check/wish step: observe, catch receipts up, journal one line. No model call. */
  const runWakeStep = async (input: {
    wakeId: string
    receipt: Record<string, unknown>
    signal: AbortSignal
    context: TransitionContext
  }): Promise<Record<string, unknown>> => {
    const edgeBallId = typeof input.receipt.headBallId === 'string' ? input.receipt.headBallId : null
    const head = { localBallId: currentBall.ballId, localEpoch: currentBall.epoch, edgeBallId,
      edgeEpoch: typeof input.receipt.headEpoch === 'number' ? input.receipt.headEpoch : null,
      aligned: edgeBallId === null ? null : edgeBallId === currentBall.ballId }
    const wishText = readTextSafe(WISH_PATH)
    const nextOpen = wishText.split('\n').find(line => /^\s*[-*]\s*\[ \]/.test(line))
    const wish = { present: wishText.length > 0, nextOpen: nextOpen ? nextOpen.trim().slice(0, 200) : null }
    let staged: Record<string, unknown> = { present: false }
    try {
      if (vfs.existsSync(STAGED_HEAD_PROMOTION_PATH) && vfs.statSync(STAGED_HEAD_PROMOTION_PATH).size <= STAGED_HEAD_PROMOTION_MAX_BYTES) {
        const raw = vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
        const envelope: unknown = JSON.parse(raw)
        const ball = record(envelope) && record(envelope.body) ? envelope.body.ball : null
        staged = { present: true, stagedSha256: sha256HexSync(raw), ballId: record(ball) ? ball.ballId ?? null : null,
          epoch: record(ball) ? ball.epoch ?? null : null, manifestProblem: manifestStructureProblem(ball)?.code ?? null,
          stale: !record(ball) || ball.parentBallId !== currentBall.ballId }
      }
    } catch (error) { staged = { present: true, error: refusalCode(error, 'STAGED_PROMOTION_UNREADABLE') } }
    const persistenceView = { durable: persistence.durable, conflict: persistence.conflict,
      pendingBatches: persistence.mirror.pendingBatches }
    let recoveredReceipts: string[] = []
    if (!input.signal.aborted && mountedOrgans.has('seed-receipts')) {
      try { recoveredReceipts = await lateOps.ensureRetroPromotionReceipts?.() ?? [] } catch (_error) { recoveredReceipts = [] }
    }
    if (input.signal.aborted) return { ok: false, code: 'WAKE_STEP_TIMEOUT' }
    const line = JSON.stringify({ schema: 'aukora.wake-step.v1', at: Date.now(), wakeId: input.wakeId, ...transitionFields(input.context),
      head, wish, recoveredReceipts,
      staged: { present: staged.present, manifestProblem: staged.manifestProblem ?? null, stale: staged.stale ?? null } })
    let journaled = false
    try {
      vfs.mkdirSync('/dsh/home/auma/wake', { recursive: true })
      const prior = readTextSafe(WAKE_STEPS_PATH).split('\n').filter(item => item.trim()).slice(-199)
      vfs.writeFileSync(WAKE_STEPS_PATH, [...prior, line].join('\n') + '\n')
      journaled = true
    } catch (_error) { journaled = false }
    return { ok: true, wakeId: input.wakeId, wishStep: 'observed', head, wish, staged, persistence: persistenceView, recoveredReceipts,
      journal: journaled ? WAKE_STEPS_PATH : null, ...transitionFields(input.context) }
  }
  const wakeLoop = createWakeLoop({
    isTurnRunning: () => {
      const now = Date.now()
      for (const [turnId, startedAt] of activeTurns) if (now - startedAt > ACTIVE_TURN_STALE_MS) activeTurns.delete(turnId)
      return toolsInFlight > 0 || activeTurns.size > 0
    },
    acknowledge: async (wakeId, context) => {
      if (!origin || origin === 'null') throw new Error('ORIGIN_UNAVAILABLE')
      const response = await fetch(new URL('/_host/wake', origin).href, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-x6-operation-id': context.operationId },
        body: JSON.stringify({ action: 'acknowledge', wakeId }), signal: AbortSignal.timeout(10_000) })
      const json: unknown = await response.json().catch(() => null)
      return { status: response.status, json }
    },
    step: runWakeStep,
  })

  // AN OPEN TAB NEVER HOT-SWAPS TO A HEAD PUBLISHED ELSEWHERE.
  // A live swap is safe only with admission control and draining across every organ call and turn, and
  // a reload costs about six seconds. So a publication announced on the HEAD socket or a peer channel, `head_adopt`, the
  // snapshots service's `adoptHostHead`, the catch-up after boot and the check before `promote_staged`/`head_rollback`
  // only READ the published head (bounded by the cold boot's idle deadline), check that it is well formed, and record it
  // in ONE place, `hostHeadInfo`. Nothing mounted changes. `currentHeadLag()` derives the lag from that record and the
  // head this tab runs, and says it in one sentence: a newer Auma is published, and one reload brings her (a cold boot
  // selects the published head). The path by which this tab adopts the head IT has just promoted (`headAdopt`, called
  // only by executePromoteStaged after its own publish) is unchanged.
  type HeadRef = { ballId: string; epoch: number }
  type HeadLag = { published: HeadRef; running: HeadRef; newer: boolean; reloadBrings: true; checkedAt: number; say: string }
  const currentHeadLag = (): HeadLag | null => {
    const published = hostHeadInfo
    if (published === null || published.ballId === currentBall.ballId) return null
    const newer = published.epoch > currentBall.epoch
    const next = String(published.epoch), mine = String(currentBall.epoch)
    const say = newer
      ? `A newer Auma is published (epoch ${next}); this tab runs epoch ${mine}. One reload brings her.`
      : `The published Auma (epoch ${next}) is not the one this tab runs (epoch ${mine}). One reload takes the published one.`
    return { published: { ballId: published.ballId, epoch: published.epoch },
      running: { ballId: currentBall.ballId, epoch: currentBall.epoch }, newer, reloadBrings: true, checkedAt: published.checkedAt, say }
  }
  /** Reads started, and the latest of them whose answer was recorded: an answer never overwrites a later read's record. */
  let publishedReads = 0
  let recordedRead = 0
  /** The last read that failed with no later read recorded since (GET /__x6__/status `headCheckFailure`). */
  let headCheckFailure: { code: string; error: string; at: number } | null = null
  /** The pending retry of a failed read (scheduleHeadRetry) and how many reads its chain has made. */
  let headRetry: ReturnType<typeof setTimeout> | null = null
  let headRetries = 0
  /**
   * Record a successful read of the published head, in read order: an answer never overwrites a later read's record.
   * A recorded success clears the failure and ends any pending retry chain (an announcement
   * failed, a manual read succeeded, and the retry already scheduled fired during a later outage and resumed retrying).
   */
  const recordHeadRead = (read: number, head: { ballId: string; epoch: number }): void => {
    if (read <= recordedRead) return
    recordedRead = read
    hostHeadInfo = { ballId: head.ballId, epoch: head.epoch, checkedAt: Date.now() }
    headCheckFailure = null
    if (headRetry !== null) clearTimeout(headRetry)
    headRetry = null
    headRetries = 0
  }
  type PublishedHeadCheck = { ok: true; headLag: HeadLag | null } | { ok: false; code: string; error: string; headLag: HeadLag | null }
  /**
   * Read the published head and record it; never stores, mounts or disposes anything. The read is the cold boot's:
   * `idleFetch` with HEAD_READ_IDLE_MS, so a stalled edge fails as HEAD_READ_STALLED instead of hanging. It is not
   * queued behind mutations, so it can never hold the mutation queue either.
   */
  const checkPublishedHead = async (): Promise<PublishedHeadCheck> => {
    const read = ++publishedReads
    const failed = (code: string, error: string): PublishedHeadCheck => {
      if (read > recordedRead) headCheckFailure = { code, error: error.slice(0, 300), at: Date.now() }
      return { ok: false, code, error: error.slice(0, 300), headLag: currentHeadLag() }
    }
    if (!origin || origin === 'null') return failed('HEAD_ORIGIN_UNAVAILABLE', 'this tab has no host origin to read the published head from')
    const idleMs = (globalThis as { __X6_HEAD_READ_IDLE_MS__?: number }).__X6_HEAD_READ_IDLE_MS__ ?? HEAD_READ_IDLE_MS
    let text: string
    try {
      const res = await idleFetch(new URL('/_head/ball', origin).href, { credentials: 'same-origin', cache: 'no-store' },
        { idleMs, code: 'HEAD_READ_STALLED', what: 'her head (/_head/ball)' })
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        return failed('HEAD_FETCH_FAILED', `HTTP ${String(res.status)}`)
      }
      text = await res.text()
    } catch (error) {
      const code = record(error) && error.code === 'HEAD_READ_STALLED' ? 'HEAD_READ_STALLED' : 'HEAD_FETCH_UNREACHABLE'
      return failed(code, error instanceof Error ? error.message : String(error))
    }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return failed('HEAD_FETCH_FAILED', 'the head answer is not JSON') }
    if (!record(parsed) || parsed.ok === false) return failed('HEAD_FETCH_FAILED', 'the head answer is not a head')
    const ball = (parsed as { ball?: BallManifest; head?: BallManifest }).ball ?? (parsed as { head?: BallManifest }).head
    // Well formed: an x6.1 manifest whose ballId is the hash of its own content. Its modules are not read: nothing runs.
    if (!publishedHeadManifestValid(ball)) {
      return failed('HEAD_MANIFEST_MALFORMED', 'the published head is not a well-formed x6.1 manifest')
    }
    if (typeof parsed.buildSha === 'string' && parsed.buildSha) hostSourceSha = parsed.buildSha
    recordHeadRead(read, { ballId: ball.ballId, epoch: ball.epoch })
    return { ok: true, headLag: currentHeadLag() }
  }
  lateOps.checkPublishedHead = checkPublishedHead
  lateOps.headReadOrder = {
    begin: () => ++publishedReads,
    record: recordHeadRead,
  }
  /**
   * After a failed read that an announcement or the boot catch-up asked for, more reads while the failure remains, with
   * bounded backoff: 30 s, then doubling, at most HEAD_RETRY_LIMIT reads (about 31 minutes in all), at most one pending.
   * A recorded success ends the chain (recordHeadRead cancels the pending retry; a retry that fires with no failure
   * recorded reads nothing); a new trigger that fails with none pending starts a fresh one. So a read lost to a network
   * switch (or an edge that recovers while the socket stays up) does not wait for the next announcement.
   */
  const HEAD_RETRY_LIMIT = 6
  const scheduleHeadRetry = (): void => {
    if (headRetry !== null || headRetries >= HEAD_RETRY_LIMIT) return
    const baseMs = (globalThis as { __X6_HEAD_RETRY_MS__?: number }).__X6_HEAD_RETRY_MS__ ?? 30_000
    const delayMs = baseMs * 2 ** headRetries
    headRetries += 1
    headRetry = setTimeout(() => {
      headRetry = null
      if (headCheckFailure === null) { headRetries = 0; return }
      void checkPublishedHead().then((checked) => { if (!checked.ok && headCheckFailure !== null) scheduleHeadRetry() }, () => {})
    }, delayMs)
  }
  const checkPublishedHeadOrRetry = async (): Promise<void> => {
    const checked = await checkPublishedHead()
    if (checked.ok || headRetry !== null) return
    headRetries = 0
    scheduleHeadRetry()
  }
  /**
   * THE APP'S OWN BUILD: after a reload the owner pressed for an edge build, the page reports here when
   * the edge still names that build while serving a bundle stamped otherwise (a hand-stamped deploy). The page stops
   * showing the notice for that revision this session; GET /__x6__/status shows this record so the mismatch stays visible.
   */
  let buildMismatch: { page: string; edge: string; at: number; say: string } | null = null
  const noteBuildMismatch = (payload: unknown): { ok: boolean; code?: string; buildMismatch?: typeof buildMismatch } => {
    const revision = /^[a-f0-9]{40,64}$/
    if (!record(payload) || typeof payload.page !== 'string' || typeof payload.edge !== 'string'
      || !revision.test(payload.page) || !revision.test(payload.edge) || payload.page === payload.edge) return { ok: false, code: 'BUILD_MISMATCH_INVALID' }
    buildMismatch = { page: payload.page, edge: payload.edge, at: Date.now(),
      say: `After a reload the edge still names build ${payload.edge.slice(0, 12)} while this page's bundle is stamped ${payload.page.slice(0, 12)}; its notice is not shown again this session.` }
    return { ok: true, buildMismatch }
  }
  /** What `head_adopt` and `adoptHostHead` answer: the published head, the one this tab runs, and what one reload does. */
  const describePublishedHead = async (opts?: { force?: unknown }): Promise<Record<string, unknown>> => {
    const checked = await checkPublishedHead()
    const running = { ballId: currentBall.ballId, epoch: currentBall.epoch }
    const published = hostHeadInfo === null ? null : { ballId: hostHeadInfo.ballId, epoch: hostHeadInfo.epoch }
    const lag = checked.headLag
    const say = !checked.ok ? `The published head could not be read (${checked.code}); this tab keeps epoch ${String(running.epoch)}.`
      : lag === null ? `This tab runs the published Auma (epoch ${String(running.epoch)}).` : lag.say
    const answer = { ...checked, adopted: false, alreadyCurrent: checked.ok && lag === null, running, published, say }
    if (opts?.force === undefined || opts.force === false) return answer
    return { ...answer, ok: false, code: 'HEAD_ADOPT_FORCE_REFUSED',
      say: `force is not accepted: an open tab never hot-swaps to a published head. ${say}` }
  }

  const handleIncomingSync = async (data: {
    type?: string
    fromPeerId?: string
    ball?: BallManifest
    codeBySha?: Record<string, string>
    peer?: PresencePeer
    peers?: PresencePeer[]
  }): Promise<void> => {
    if (!data || typeof data !== 'object') return
    if (data.peer && data.peer.peerId) {
      peers.set(data.peer.peerId, { ...data.peer, lastSeenAt: Date.now() })
    }
    if (Array.isArray(data.peers)) {
      for (const p of data.peers) {
        if (p && p.peerId) peers.set(p.peerId, p)
      }
    }
    if (data.type === 'presence:hello' && data.fromPeerId !== peerId) {
      const reply = { type: 'presence:ack', fromPeerId: peerId, peer: peers.get(peerId) }
      try { bc?.postMessage(reply) } catch {}
      try { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply)) } catch {}
      return
    }
    if (data.type === 'ball:commit' && data.ball && data.ball.ballId !== currentBall.ballId) {
      // An announcement is only a reason to read the edge (its payload is never trusted): the published head is
      // recorded, nothing mounted changes, and the owner is told one reload brings it.
      await checkPublishedHeadOrRetry()
    }
  }

  const connectPresence = (): void => {
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel('aukora-x6-balls')
      bc.onmessage = (ev: MessageEvent) => {
        void handleIncomingSync(ev.data).catch((err: unknown) => {
          console.warn('x6-ball: BroadcastChannel sync error', err)
        })
      }
      bc.postMessage({ type: 'presence:hello', fromPeerId: peerId, peer: peers.get(peerId) })
    }

    if (origin && origin !== 'null' && typeof WebSocket !== 'undefined') {
      headSocket.markAvailable()
      const connectWs = (): void => {
        try {
          const wsUrl = new URL('/_head/ws', origin)
          wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
          wsUrl.searchParams.set('peerId', peerId)
          wsUrl.searchParams.set('ballId', currentBall.ballId)
          const socket = new WebSocket(wsUrl.href)
          ws = socket
          headSocket.attach(socket)
          socket.onopen = () => {
            updateSelfPeer()
            socket.send(JSON.stringify({ type: 'presence:hello', fromPeerId: peerId, peer: peers.get(peerId) }))
          }
          socket.onmessage = (ev: MessageEvent) => {
            try {
              const parsed: unknown = JSON.parse(String(ev.data))
              // Wake frames are honoured only from HEAD's socket, never from a BroadcastChannel peer.
              if (record(parsed) && (parsed.type === 'wake:updated' || parsed.type === 'wake.changed')) {
                void wakeLoop.onFrame(parsed)
                return
              }
              // A sync failure must never become an unhandled rejection.
              void handleIncomingSync(parsed as Parameters<typeof handleIncomingSync>[0]).catch((err: unknown) => {
                console.warn('x6-ball: HEAD socket sync error', err)
              })
            } catch {}
          }
          socket.onclose = () => {
            setTimeout(connectWs, 3000)
          }
        } catch {
          headSocket.noteError()
        }
      }
      connectWs()
    }
  }

  /**
   * THIS tab adopts the head it has itself just promoted (executePromoteStaged, after its own publish): unchanged from
   * before that rule. Nothing else calls it; every other path only reads and records (`checkPublishedHead`).
   */
  const headAdopt = (opts?: { force?: boolean; expectBallId?: string }): Promise<{
    ok: true
    adopted: boolean
    alreadyCurrent: boolean
    from: { epoch: number; ballId: string }
    to: { epoch: number; ballId: string }
    changedEntries: string[]
    code?: 'HEAD_ADOPT_PUBLISHED_MOVED'
    say?: string
  }> => serializeMutation(async () => {
    if (!origin || origin === 'null') throw new Error('head_adopt requires a connected host origin')
    const read = ++publishedReads
    const response = await fetch(new URL('/_head/ball', origin).href, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error(`Host head lookup failed: HTTP ${String(response.status)}`)
    const selected = await response.json() as {
      ok?: boolean
      ball?: BallManifest
      head?: BallManifest
      codeBySha?: Record<string, string>
      modules?: Record<string, string>
      buildSha?: string
    }
    const remoteBall = selected.ball ?? selected.head
    if (selected.ok === false || !publishedHeadManifestValid(remoteBall)) throw new Error('HEAD_MANIFEST_MALFORMED: Host returned invalid ball manifest')
    if (typeof selected.buildSha === 'string' && selected.buildSha) hostSourceSha = selected.buildSha
    // The same ordering as every other read of the published head: an answer never overwrites a later read's record.
    recordHeadRead(read, { ballId: remoteBall.ballId, epoch: remoteBall.epoch })
    const from = { epoch: currentBall.epoch, ballId: currentBall.ballId }
    const to = { epoch: remoteBall.epoch, ballId: remoteBall.ballId }
    if (remoteBall.ballId === currentBall.ballId || (!opts?.force && remoteBall.epoch <= currentBall.epoch)) {
      return { ok: true, adopted: false, alreadyCurrent: remoteBall.ballId === currentBall.ballId, from, to, changedEntries: [] }
    }
    // This tab adopts only the head IT published: if another writer published after it (its
    // lease can expire before this read), nothing is stored or mounted; the head is recorded and one reload brings it.
    if (opts?.expectBallId !== undefined && remoteBall.ballId !== opts.expectBallId) {
      const lag = currentHeadLag()
      return { ok: true, adopted: false, alreadyCurrent: false, from, to, changedEntries: [], code: 'HEAD_ADOPT_PUBLISHED_MOVED',
        say: `The head this tab published (${opts.expectBallId.slice(0, 12)}) is no longer the published one; this tab keeps epoch ${String(from.epoch)}. ${lag?.say ?? 'One reload takes the published one.'}` }
    }
    for (const [sha, code] of verifyCodeBySha(selected.codeBySha ?? selected.modules)) {
      vfs.writeFileSync(join(BALLS_DIR, `${sha}.js`), code)
      const meta = remoteBall.modules?.[sha]
      if (meta) vfs.writeFileSync(join(BALLS_DIR, `${sha}.meta.json`), JSON.stringify(meta, null, 2) + '\n')
      vfs.writeFileSync(`/dsh/home/organs/${sha}.js`, code)
    }
    const changedEntries = Object.keys(remoteBall.entries).filter(
      k => currentBall.entries[k]?.specifier !== remoteBall.entries[k]?.specifier,
    )
    await reconcileToManifest(remoteBall)
    await lateOps.ensureRetroPromotionReceipts?.(changedEntries)
    try { await persistence.flush() } catch {}
    return { ok: true, adopted: true, alreadyCurrent: false, from, to, changedEntries }
  })

  const ballPut = (input: {
    code?: string | undefined
    path?: string | undefined
    name?: string | undefined
    description?: string | undefined
  }): Promise<BallModuleMeta> => serializeMutation(async () => {
    let code = typeof input.code === 'string' && input.code.trim().length > 0 ? input.code : ''
    if (!code && typeof input.path === 'string' && input.path.trim().length > 0) {
      const sourcePath = input.path.trim()
      if (!vfs.existsSync(sourcePath)) throw new Error(`ball_put source path does not exist: ${sourcePath}`)
      code = vfs.readFileSync(sourcePath, 'utf8') as string
    }
    if (code.trim().length === 0) throw new Error('ball_put requires non-empty JavaScript `code` or existing VFS `path`')
    const sha256 = sha256HexSync(code)
    const specifier = `ball:${sha256}`
    const filePath = join(BALLS_DIR, `${sha256}.js`)
    vfs.writeFileSync(filePath, code)

    // Staging is inert. Code executes only during explicit tree activation.

    const meta: BallModuleMeta = {
      sha256,
      specifier,
      name: input.name?.trim() || `ball-${sha256.slice(0, 8)}`,
      description: input.description?.trim() || 'Cordis ball plugin',
      size: new TextEncoder().encode(code).byteLength,
      createdAt: Date.now(),
    }
    vfs.writeFileSync(join(BALLS_DIR, `${sha256}.meta.json`), JSON.stringify(meta, null, 2) + '\n')

    // Preparation never changes the selected head or epoch.
    preparedModules.set(sha256, meta)
    return meta
  })

  const treePatch = async (input: {
    id: string
    specifier?: string | undefined
    sha?: string | undefined
    config?: Record<string, unknown> | undefined
    disabled?: boolean | undefined
    expectedEpoch?: number | undefined
    expectedBallId?: string | undefined
    /** Required runtime-issued candidate/head/suite-bound behavioral admission, never owner approval. */
    qualificationId?: string | undefined
  }): Promise<{
    ok: true
    ball: BallManifest
    entry: BallEntryRecord
    elapsedMs: number
    mutation: BallMutationState
  }> => mutateSelected(async (markApplied) => {
    const t0 = performance.now()
    const id = String(input.id ?? '').trim()
    const rawSpec = String(input.specifier ?? (input.sha ? `ball:${input.sha}` : '')).trim()
    const specifier = rawSpec.startsWith('ball:') || rawSpec.startsWith('/') || rawSpec.startsWith('@')
      ? rawSpec
      : `ball:${rawSpec}`
    if (!id) throw new Error('tree_patch requires a non-empty entry `id`')
    if (!rawSpec) throw new Error('tree_patch requires a non-empty `specifier` or `sha` (e.g. "ball:<sha256>")')
    if (typeof input.expectedEpoch === 'number' && input.expectedEpoch !== currentBall.epoch) {
      throw new Error(`CAS_EPOCH_MISMATCH: expected epoch ${String(input.expectedEpoch)}, current epoch is ${String(currentBall.epoch)}`)
    }

    if (input.expectedBallId !== undefined && input.expectedBallId !== currentBall.ballId) {
      throw new Error(`CAS_HEAD_MISMATCH: expected ${input.expectedBallId}, current ${currentBall.ballId}`)
    }
    const prevEntry = currentBall.entries[id]
    const governance = classifyEntryGovernance(id, prevEntry) === 3 || classifyEntryGovernance(id, { config: input.config }) === 3
    const t1QualifiedGovernance = governance
      && typeof input.qualificationId === 'string'
      && retentionAdmissions.get(input.qualificationId)?.organId === id
      && input.config === undefined
      && input.disabled === undefined
    if (!governance || t1QualifiedGovernance) {
      requireRetentionAdmission(id, specifier, input.qualificationId)
      if (input.config !== undefined || input.disabled !== undefined) throw new Error('PEARL_QUALIFICATION_SCOPE_REFUSED')
    }
    const previousSpecifiers = prevEntry ? [...prevEntry.previousSpecifiers, prevEntry.specifier] : []
    const previousVersions = prevEntry ? [...(prevEntry.previousVersions ?? []), {
      specifier: prevEntry.specifier,
      config: JSON.parse(JSON.stringify(prevEntry.config)) as Record<string, unknown>,
      disabled: prevEntry.disabled,
    }] : []

    const nextEntry: BallEntryRecord = {
      id,
      specifier,
      config: JSON.parse(JSON.stringify(input.config ?? prevEntry?.config ?? {})) as Record<string, unknown>,
      disabled: input.disabled ?? prevEntry?.disabled ?? false,
      ...(prevEntry?.governance === undefined ? {} : { governance: prevEntry.governance }),
      previousSpecifiers,
      previousVersions,
      updatedAt: Date.now(),
    }

    const nextEntries = { ...currentBall.entries, [id]: nextEntry }
    const sha = specifier.startsWith('ball:') ? specifier.slice(5) : null
    let staged = sha ? preparedModules.get(sha) : undefined
    if (sha && !staged && !currentBall.modules[sha]) {
      const metaPath = join(BALLS_DIR, `${sha}.meta.json`)
      const codePath = join(BALLS_DIR, `${sha}.js`)
      if (vfs.existsSync(metaPath)) {
        const saved = JSON.parse(vfs.readFileSync(metaPath, 'utf8') as string) as BallModuleMeta
        if (saved.sha256 !== sha || saved.specifier !== specifier || typeof saved.name !== 'string' || typeof saved.description !== 'string' || !Number.isSafeInteger(saved.size) || saved.size < 0 || !Number.isSafeInteger(saved.createdAt) || saved.createdAt < 0) throw new Error('Prepared module metadata does not match the requested artifact')
        staged = saved
      } else if (vfs.existsSync(codePath)) {
        const codeText = vfs.readFileSync(codePath, 'utf8') as string
        if (sha256HexSync(codeText) !== sha) throw new Error(`Ball module hash mismatch at ${codePath}`)
        staged = {
          sha256: sha,
          specifier,
          name: id,
          description: `Cordis ball plugin ${id}`,
          size: new TextEncoder().encode(codeText).byteLength,
          createdAt: Date.now(),
        }
        vfs.writeFileSync(metaPath, JSON.stringify(staged, null, 2) + '\n')
        preparedModules.set(sha, staged)
      }
    }
    const nextModules = staged ? { ...currentBall.modules, [staged.sha256]: staged } : currentBall.modules
    const nextEpoch = currentBall.epoch + 1
    const nextBallBody: Omit<BallManifest, 'ballId'> = {
      version: 'x6.1-ball/v1',
      parentBallId: currentBall.ballId,
      epoch: nextEpoch,
      createdAt: Date.now(),
      authorPeerId: peerId,
      entries: nextEntries,
      modules: nextModules,
    }
    const nextBall: BallManifest = { ...nextBallBody, ballId: governance
      ? computeCanonicalBallId(nextBallBody)
      : computeBallId(currentBall.ballId, nextEpoch, nextEntries, nextModules) }
    if (governance && !t1QualifiedGovernance) {
      stageHeadPromotion({ ball: nextBall, codeBySha: collectCodeBySha(nextBall),
        expectedParentBallId: currentBall.ballId, expectedEpoch: currentBall.epoch })
      throw new Error('CLASS3_WEBAUTHN_REQUIRED: candidate staged for review; owner approval and host admission remain required')
    }
    // Validate and construct the complete candidate before touching the running tree.
    // Failure to checkpoint must stop the mutation, rather than remove recovery.
    createSnapshot(`pre-tree_patch:${id}`)
    retentionAdmissions.delete(input.qualificationId ?? '')
    await mountOrSwapEntry(nextEntry, markApplied)
    markApplied()
    const previousBall = currentBall
    currentBall = nextBall
    hydrateNamedOrganSources(vfs, currentBall, previousBall)
    vfs.writeFileSync(HEAD_PATH, JSON.stringify(currentBall, null, 2) + '\n')
    appendHistoricalFile(join(HISTORY_DIR, `${currentBall.ballId}.json`), JSON.stringify(currentBall, null, 2) + '\n')
    updateSelfPeer()
    const mutation = await completeMutation('tree.patch', id)

    const elapsedMs = Math.round((performance.now() - t0) * 100) / 100
    return { ok: true, ball: currentBall, entry: nextEntry, elapsedMs, mutation }
  })

  const treeUndo = async (input?: { id?: string | undefined; expectedBallId?: string | undefined }): Promise<{
    ok: true
    action: 'reverted' | 'removed'
    restoredSha: string | null
    ball: BallManifest
    revertedId: string
    previousSpecifier: string | null
    mutation: BallMutationState
  }> => mutateSelected(async (markApplied) => {
    if (input?.expectedBallId !== undefined && input.expectedBallId !== currentBall.ballId) {
      throw new Error(`CAS_HEAD_MISMATCH: expected ${input.expectedBallId}, current ${currentBall.ballId}`)
    }
    const targetId = input?.id?.trim() || Object.values(currentBall.entries)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id
    const existing = targetId ? currentBall.entries[targetId] : undefined
    if (!targetId || !existing) {
      throw new Error(`tree_undo: no active ball entry found${input?.id ? ` for id "${input.id}"` : ''}`)
    }
    refuseUnqualifiedMutation({ action: 'tree_undo', id: targetId })
    const history = [...existing.previousSpecifiers]
    const versions = [...(existing.previousVersions ?? [])]
    const previousVersion = versions.pop()
    if (!previousVersion && history.length > 0) {
      throw new Error('LEGACY_UNDO_CONFIG_UNAVAILABLE: restore a full snapshot instead of guessing prior config')
    }
    createSnapshot(`pre-tree_undo:${targetId}`)
    history.pop()
    const previousSpecifier = previousVersion?.specifier ?? null

    let nextEntries: Record<string, BallEntryRecord>
    if (previousSpecifier === null || !previousVersion) {
      const running = activeFibers.get(targetId)
      if (running !== undefined) {
        markApplied()
        activeFibers.delete(targetId)
        effectLedger.delete(targetId)
        await Promise.resolve(running.fiber.dispose())
      }
      nextEntries = Object.fromEntries(
        Object.entries(currentBall.entries).filter(([k]) => k !== targetId),
      )
    } else {
      const revertedEntry: BallEntryRecord = {
        id: targetId,
        specifier: previousSpecifier,
        config: previousVersion.config,
        disabled: previousVersion.disabled,
        previousSpecifiers: history,
        previousVersions: versions,
        updatedAt: Date.now(),
      }
      await mountOrSwapEntry(revertedEntry, markApplied)
      nextEntries = { ...currentBall.entries, [targetId]: revertedEntry }
    }

    const nextEpoch = currentBall.epoch + 1
    const nextBallId = computeBallId(currentBall.ballId, nextEpoch, nextEntries, currentBall.modules)
    const nextBall: BallManifest = {
      version: 'x6.1-ball/v1',
      ballId: nextBallId,
      parentBallId: currentBall.ballId,
      epoch: nextEpoch,
      createdAt: Date.now(),
      authorPeerId: peerId,
      entries: nextEntries,
      modules: currentBall.modules,
    }
    markApplied()
    currentBall = nextBall
    vfs.writeFileSync(HEAD_PATH, JSON.stringify(currentBall, null, 2) + '\n')
    appendHistoricalFile(join(HISTORY_DIR, `${currentBall.ballId}.json`), JSON.stringify(currentBall, null, 2) + '\n')
    updateSelfPeer()
    const mutation = await completeMutation('tree.undo', targetId)

    return {
      ok: true,
      action: previousSpecifier === null ? 'removed' : 'reverted',
      restoredSha: previousSpecifier ? previousSpecifier.replace(/^ball:/, '') : null,
      ball: currentBall,
      revertedId: targetId,
      previousSpecifier,
      mutation,
    }
  })

  lateOps.ballPut = ballPut
  lateOps.treePatch = treePatch
  lateOps.treeUndo = treeUndo

  // Register live cross-session systemPrompt context (`auma:live-state-map`) so switching presets
  // (`auma-alien`, `cordis` Creator, `standard`) or starting a new session carries her full live map!
  const buildLiveStateMapText = (): string => {
    const entryNames = Object.keys(currentBall.entries)
    const customPrompts = Object.keys(promptSections)
    const handoffText = readHandoffSafe().trim()
    const lines = [
      '# Auma X6.1 Live Runtime State Map',
      `- Active Ball ID: \`${currentBall.ballId.slice(0, 16)}\` (epoch ${String(currentBall.epoch)})`,
      ...(currentHeadLag() === null ? [] : [`- Published head differs from this tab: ${currentHeadLag()?.say ?? ''} Say so to the owner before calling an approved change running here; this tab never hot-swaps.`]),
      `- Mounted Ball / Seed Organs (${String(entryNames.length)}): ${entryNames.join(', ') || 'none'}`,
      `- Custom Data-Plane Prompt Sections (${String(customPrompts.length)}): ${customPrompts.join(', ') || 'none'}`,
      `- Web Fetch Provider Pinned: \`${String(webSvc?.config?.fetchProvider?.get() ?? 'local')}\``,
      '- Handoff Map File: `/dsh/home/auma/HANDOFF.md` (use `auma_handoff` to update across sessions/presets)',
    ]
    if (handoffText) {
      lines.push('', handoffText)
    }
    return lines.join('\n')
  }

  if (sysPromptSvc && typeof sysPromptSvc.context === 'function') {
    try {
      sysPromptSvc.context({
        name: 'auma:live-state-map',
        order: 140,
        interpolate: false,
        required: true,
        text: () => buildLiveStateMapText(),
      })
    } catch (ctxErr) {
      console.warn('x6-ball: could not register auma:live-state-map context', ctxErr)
    }
  }

  // Lane E6: resident capability index for auma-cortex, derived from in-memory state only.
  const capabilityIndex = createCapabilityIndex(() => {
    let tools: ReadonlyArray<{ name: string; description?: unknown; parameters?: unknown }> = []
    try { tools = (hostCtx.tools?.definitions?.() ?? []) as unknown as typeof tools } catch { tools = [] }
    return { epoch: currentBall.epoch, ballId: currentBall.ballId, tools, entries: currentBall.entries, modules: currentBall.modules }
  })
  const readStatus = () => {
    let registeredTools: string[] = []
    try {
      const defs = hostCtx.tools?.definitions?.()
      if (defs) registeredTools = defs.map(d => d.name)
    } catch {}
    return {
      ok: true as const,
      buildSha,
      buildIdentity,
      hostSourceSha,
      self: presenceService.self(),
      peerId,
      ballId: currentBall.ballId,
      parentBallId: currentBall.parentBallId,
      epoch: currentBall.epoch,
      entries: currentBall.entries,
      entryGovernanceClasses: Object.fromEntries(
        Object.entries(currentBall.entries).map(([id, entry]) => [id, classifyEntryGovernance(id, entry)])),
      modules: currentBall.modules,
      activeFibers: [...activeFibers.keys()],
      fiberHealth: computeFiberHealth(),
      persistence: {
        durable: persistence.durable,
        readOnly: persistence.readOnly,
        conflict: persistence.conflict,
        localSave: { ...persistence.localSave },
        mirror: { ...persistence.mirror },
      },
      mountedOrgans: organsService.list(),
      effectLedger: Object.fromEntries(effectLedger),
      motorMemory: Object.fromEntries(motorMemory),
      promptSections: Object.values(promptSections),
      snapshotsCount: listSnapshots().length,
      mutation: lastMutation,
      preparedModules: Object.fromEntries(preparedModules),
      seedCandidates,
      retainedLocalFork,
      authorityError,
      headFetchError,
      headLag: currentHeadLag(),
      headCheckFailure,
      buildMismatch,
      fetchProviderPinned: webSvc?.config?.fetchProvider?.get() ?? 'local',
      peers: presenceService.list(),
      registeredTools,
      headSocket: headSocket.snapshot(),
      wakeLoop: wakeLoop.snapshot(),
      writeSet: liveWriteSet.snapshot(),
    }
  }

  /**
   * `ball_status { includeManifest }` within X6_STATUS_BYTE_LIMIT (the added entry
   * states pushed a large head over the limit and the whole answer became `X6_STATUS_BYTE_LIMIT`). When the answer would
   * exceed it, the manifest fields are left out, largest first, and named in `manifestOmitted`; the head, persistence,
   * health and every entry state stay. If those alone exceed it, strip state details first, retain bounded warnings,
   * and admit compact states of every kind until the complete JSON byte budget is full; count any omitted entries.
   */
  const boundedStatus = (status: ReturnType<typeof readStatus>): Record<string, unknown> => {
    const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (bytes(status) <= X6_STATUS_BYTE_LIMIT) return status
    // Largest first, so as much as fits stays.
    const fields = status as unknown as Record<string, unknown>
    const omittable = ['modules', 'entries', 'entryGovernanceClasses', 'effectLedger', 'motorMemory', 'promptSections', 'preparedModules',
      'seedCandidates', 'mountedOrgans', 'registeredTools', 'peers', 'writeSet', 'wakeLoop', 'headSocket', 'activeFibers']
      .map(key => ({ key, size: bytes(fields[key] ?? null) })).sort((a, b) => b.size - a.size).map(field => field.key)
    for (let count = 1; count <= omittable.length; count += 1) {
      const manifestOmitted = omittable.slice(0, count)
      const compact = { ...Object.fromEntries(Object.entries(status).filter(([key]) => !manifestOmitted.includes(key))),
        code: 'X6_STATUS_BYTE_LIMIT', manifestOmitted,
        say: 'The full status is above 64 KiB, so the fields named in manifestOmitted are left out; the head, health and every entry state are here.' }
      if (bytes(compact) <= X6_STATUS_BYTE_LIMIT) return compact
    }
    const health = status.fiberHealth
    const short = (text: string | null): string | null => text === null ? null : text.slice(0, 300)
    const states = Object.create(null) as Record<string, EntryState>
    const rows = Object.entries(health.entries)
    const compact = {
      ok: true, code: 'X6_STATUS_BYTE_LIMIT', ballId: status.ballId, epoch: status.epoch, peerId: status.peerId,
      say: 'Status details are shortened. Compact states and bounded head/persistence warnings remain; '
        + 'entriesOmittedCount names any inventory that could not fit.',
      manifestOmitted: [] as string[],
      headLag: status.headLag,
      headCheckFailure: status.headCheckFailure === null ? null
        : { ...status.headCheckFailure, error: short(status.headCheckFailure.error) },
      authorityError: short(status.authorityError), headFetchError: short(status.headFetchError),
      persistence: {
        durable: status.persistence.durable, readOnly: status.persistence.readOnly, conflict: short(status.persistence.conflict),
        localSave: { ...status.persistence.localSave, error: short(status.persistence.localSave.error) },
        mirror: {
          conflict: short(status.persistence.mirror.conflict), error: short(status.persistence.mirror.error),
          transient: short(status.persistence.mirror.transient), reconciliationRequired: status.persistence.mirror.reconciliationRequired,
          resyncPending: status.persistence.mirror.resyncPending, pendingBatches: status.persistence.mirror.pendingBatches,
          pendingBytes: status.persistence.mirror.pendingBytes, sending: status.persistence.mirror.sending,
          quarantinedPathsCount: status.persistence.mirror.quarantinedPaths.length,
          shadowedJournalsCount: status.persistence.mirror.shadowedJournals.length,
        },
      },
      fiberHealth: { activeCount: health.activeCount, enabledEntriesCount: health.enabledEntriesCount,
        missingExpectedCount: health.missingExpected.length, entries: states, entriesOmittedCount: rows.length },
    }
    compact.manifestOmitted = Object.keys(status).filter(key => !Object.hasOwn(compact, key))
    let used = bytes(compact), included = 0
    for (const [id, state] of rows) {
      const summary: EntryState = state.state === 'not-running' ? { state: state.state, reason: state.reason } : state
      const addition = bytes({ [id]: summary }) - 2 + (included > 0 ? 1 : 0)
      if (used + addition > X6_STATUS_BYTE_LIMIT) continue
      states[id] = summary
      included += 1
      used += addition
    }
    compact.fiberHealth.entriesOmittedCount = rows.length - included
    return compact
  }

  // Register X6.1 Self-Building Agent Tools on `hostCtx.tools` (inherited by every Agent session)
  let scheduleBootCatchup = (): void => {}
  try {
    const req = loader.requireFrom('/dsh')
    const { defineTool } = req('@deepseek-ai/dsh-tools') as {
      defineTool: (spec: Record<string, unknown>) => unknown
    }
    const jsonOut = {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    }

    const registerBuiltin = (spec: Record<string, unknown> & { name: string }): void => {
      try {
        const register = () => hostCtx.tools?.register(defineTool(spec)) ?? (() => {})
        if (hostCtx.effect) hostCtx.effect(register)
        else register()
      } catch (error) {
        console.error(`x6-ball: built-in tool ${spec.name} registration failed`, error)
      }
    }

    registerBuiltin({
      name: 'scion_grow',
      description: 'Compile supplied TypeScript/ESM files with pinned Scion, durably prepare the output, then invoke the existing Seed live growth cycle. Explicit acceptance cases run on the actual organ; failure requests undo/refusal. Activation and cases are live, not isolated, and can have effects. Inspect compilation, cycle phase and separate persistence acknowledgements before retrying. This does not compile or promote a full runtime.',
      parameters: {
        name: { type: 'string', required: true, description: 'Lower kebab-case name that the exported Seed organ must declare.' },
        entry: { type: 'string', required: true, description: 'Relative entry filename in files.' },
        files: { type: 'json', required: true, description: 'Complete source map: relative filename to text; at most 127 supplied files, 2 MiB including the generated name guard.' },
        cases: { type: 'json', required: true, description: '1 to 32 cases, at most 64 KiB total: unique id, args object and exactly one of expect (exact JSON result) or expectError (error substring). Calls are live.' },
        expectedBallId: { type: 'string', description: 'Optional exact selected head; any change while compiling refuses growth.' },
        timeoutMs: { type: 'number', description: 'Compiler deadline 100 to 30000 ms; default 20000 ms.' },
      },
      output: jsonOut,
      async execute(args: ScionGrowthInput) { return await scionService.growOrgan(args) },
    })

    const compactPatchResult = (patch: Awaited<ReturnType<typeof treePatch>>, includeManifest?: boolean) => ({
      ok: true as const,
      epoch: patch.ball.epoch,
      ballId: patch.ball.ballId,
      parentBallId: patch.ball.parentBallId,
      entry: {
        id: patch.entry.id,
        specifier: patch.entry.specifier,
        disabled: patch.entry.disabled,
        updatedAt: patch.entry.updatedAt,
        previousCount: patch.entry.previousSpecifiers.length,
      },
      elapsedMs: patch.elapsedMs,
      mutation: patch.mutation,
      ...(includeManifest === true ? { ball: patch.ball } : {}),
    })

    /** Flush IndexedDB and say what happened; never swallowed. */
    const flushPersistenceReport = async (): Promise<{ flushed: boolean; durable: boolean; error: string | null }> => {
      try {
        await persistence.flush()
        return { flushed: true, durable: persistence.durable, error: persistence.durable ? null : 'IDB_NOT_DURABLE' }
      } catch (error) {
        return { flushed: false, durable: persistence.durable, error: refusalCode(error, 'IDB_FLUSH_FAILED') }
      }
    }
    /** POST one staged envelope to `/_head/stage` (same-origin session only) and type the answer. */
    const postHeadStage = async (envelopeText: string, context: TransitionContext, replaceStaged: boolean): Promise<{
      edgeStaged: boolean
      stageStatus: number | null
      stageError: string | null
      stageDetail?: string
      binding: unknown
      staged: Record<string, unknown> | null
    }> => {
      if (!origin || origin === 'null') return { edgeStaged: false, stageStatus: null, stageError: 'ORIGIN_UNAVAILABLE', binding: null, staged: null }
      let envelope: unknown
      try { envelope = JSON.parse(envelopeText) } catch {
        return { edgeStaged: false, stageStatus: null, stageError: 'STAGED_PROMOTION_JSON_INVALID', binding: null, staged: null }
      }
      const body = replaceStaged && record(envelope) ? { ...envelope, replaceStaged: true } : envelope
      try {
        const response = await fetch(new URL('/_head/stage', origin).href, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': 'application/json', 'x-x6-operation-id': context.operationId },
          body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
        })
        const json: unknown = await response.json().catch(() => null)
        const staged = record(json) && record(json.staged) ? json.staged : null
        const view = staged ? {
          ballId: staged.ballId ?? null, epoch: staged.epoch ?? null, state: staged.state ?? null, tier: staged.tier ?? null,
          governanceClass: staged.governanceClass ?? null, changedEntries: staged.changedEntries ?? null,
          organSet: staged.organSet ?? null } : null
        if (response.ok && record(json) && json.ok === true && staged?.state === 'awaiting_owner') {
          return { edgeStaged: true, stageStatus: response.status, stageError: null, binding: staged.binding ?? null, staged: view }
        }
        const code = record(json) && typeof json.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(json.code)
          ? json.code : response.ok ? 'HEAD_STAGE_NOT_ACKNOWLEDGED' : `HEAD_STAGE_HTTP_${String(response.status)}`
        return { edgeStaged: false, stageStatus: response.status, stageError: code, binding: null, staged: view }
      } catch (error) {
        const name = error instanceof Error ? error.name : ''
        return { edgeStaged: false, stageStatus: null, stageError: name === 'TimeoutError' ? 'HEAD_STAGE_TIMEOUT' : 'HEAD_STAGE_UNREACHABLE',
          stageDetail: (error instanceof Error ? error.message : String(error)).slice(0, 160), binding: null, staged: null }
      }
    }

    /**
     * Lane E4: one call stages one organ for owner approval. Fetches the live `/_head/ball`, builds the normalized
     * one-entry candidate (`buildOrganPromotion`), writes the review file, flushes IndexedDB, POSTs `/_head/stage` and
     * records a `head.stage` receipt. Every hop is typed; nothing falls back silently.
     */
    const stageOrganPromotion = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const context = createTransitionContext('head.stage')
      const hops: Array<{ hop: string; ok: boolean; detail?: string }> = []
      const hop = (name: string, ok: boolean, detail?: string) => { hops.push({ hop: name, ok, ...(detail ? { detail } : {}) }) }
      const refuse = (code: string, failedHop: string, extra: Record<string, unknown> = {}) => {
        hop(failedHop, false, code)
        return { ok: false, code, failedHop, edgeStaged: false, ...extra, ...transitionFields(context), hops }
      }
      if (!origin || origin === 'null') return refuse('ORIGIN_UNAVAILABLE', 'live-head')
      if (args.expectedStagedSha256 !== undefined && args.expectedStagedSha256 !== null
        && (typeof args.expectedStagedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedStagedSha256))) {
        return refuse('EXPECTED_STAGED_SHA256_INVALID', 'request')
      }
      if (args.replaceStaged !== undefined && typeof args.replaceStaged !== 'boolean') return refuse('REPLACE_STAGED_INVALID', 'request')
      let live: { ball?: unknown; codeBySha?: unknown }
      try {
        const response = await fetch(new URL('/_head/ball', origin).href, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
        if (!response.ok) return refuse(`HEAD_FETCH_HTTP_${String(response.status)}`, 'live-head')
        const json: unknown = await response.json().catch(() => null)
        if (!record(json) || !record(json.ball)) return refuse('HEAD_FETCH_INVALID', 'live-head')
        live = json
      } catch (_error) {
        return refuse('HEAD_FETCH_UNREACHABLE', 'live-head')
      }
      hop('live-head', true, `${String((live.ball as Record<string, unknown>).ballId).slice(0, 12)}@epoch${String((live.ball as Record<string, unknown>).epoch)}`)
      let plan: OrganPromotionPlan
      try {
        plan = buildOrganPromotion(live as { ball: unknown; codeBySha?: unknown }, args, {
          authorPeerId: peerId, now: Date.now(),
          readCode: (sha) => {
            const file = join(BALLS_DIR, `${sha}.js`)
            try { return vfs.existsSync(file) ? vfs.readFileSync(file, 'utf8') as string : null } catch { return null }
          },
        })
      } catch (error) {
        return refuse(refusalCode(error, 'ORGAN_PROMOTION_INVALID'), 'built', { detail: (error instanceof Error ? error.message : String(error)).slice(0, 240) })
      }
      hop('built', true, `${plan.ball.ballId.slice(0, 12)}@epoch${String(plan.ball.epoch)}:class${String(plan.governanceClass)}:${plan.tier}`)
      // Review-file guard: never silently clobber a different owner-review candidate.
      try {
        vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
        if (vfs.existsSync(STAGED_HEAD_PROMOTION_PATH)) {
          const existing = vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
          const existingSha = sha256HexSync(existing)
          let replaceable = false
          let sameBall = false
          try {
            const parsedExisting: unknown = JSON.parse(existing)
            const ball = record(parsedExisting) && record(parsedExisting.body) ? parsedExisting.body.ball : null
            sameBall = record(ball) && ball.ballId === plan.ball.ballId
            replaceable = !record(ball) || manifestStructureProblem(ball) !== null || ball.parentBallId !== plan.ball.parentBallId
              || computeCanonicalBallId(ball as unknown as BallManifest) !== ball.ballId
          } catch { replaceable = true }
          if (!sameBall && !replaceable && args.expectedStagedSha256 !== existingSha) {
            return refuse('STAGED_PROMOTION_REVIEW_CONFLICT', 'local-staged', { existingStagedSha256: existingSha,
              hint: 'Inspect the existing review file; pass expectedStagedSha256 with its exact SHA-256 to replace it.' })
          }
        }
        vfs.writeFileSync(STAGED_HEAD_PROMOTION_PATH, plan.text)
      } catch (error) {
        return refuse('LOCAL_STAGE_WRITE_FAILED', 'local-staged', { detail: (error instanceof Error ? error.message : String(error)).slice(0, 160) })
      }
      const stagedSha256 = sha256HexSync(plan.text)
      hop('local-staged', true, STAGED_HEAD_PROMOTION_PATH)
      const flush = await flushPersistenceReport()
      hop('idb-flushed', flush.flushed && flush.durable, flush.error ?? 'durable')
      const edge = await postHeadStage(plan.text, context, args.replaceStaged === true)
      hop('edge-staged', edge.edgeStaged, edge.stageError ?? 'awaiting_owner')
      let receiptSaved = false
      if (edge.edgeStaged && mountedOrgans.has('seed-receipts')) {
        try {
          const receipt = await organsService.call('seed-receipts', { action: 'append', kind: 'head.stage', data: {
            entryId: plan.entry.id, ballId: plan.ball.ballId, parentBallId: plan.ball.parentBallId, epoch: plan.ball.epoch,
            tier: plan.tier, governanceClass: plan.governanceClass, stagedSha256, ...transitionFields(context) } }) as { ok?: boolean }
          receiptSaved = receipt.ok === true
        } catch { receiptSaved = false }
      }
      return {
        ok: edge.edgeStaged,
        ...(edge.edgeStaged ? {} : { code: edge.stageError ?? 'HEAD_STAGE_NOT_ACKNOWLEDGED', failedHop: 'edge-staged' }),
        entryId: plan.entry.id, specifier: plan.entry.specifier, disabled: plan.entry.disabled, config: plan.entry.config,
        previousSpecifiers: plan.entry.previousSpecifiers, normalized: plan.normalized, moduleAdded: plan.moduleAdded,
        ballId: plan.ball.ballId, parentBallId: plan.ball.parentBallId, epoch: plan.ball.epoch,
        tier: plan.tier, governanceClass: plan.governanceClass, t2Reasons: plan.t2Reasons, changedEntries: plan.changedEntryIds,
        stagedPath: STAGED_HEAD_PROMOTION_PATH, stagedSha256, persistence: flush,
        edgeStaged: edge.edgeStaged, stageStatus: edge.stageStatus, stageError: edge.stageError, binding: edge.binding, staged: edge.staged,
        receiptSaved, ...transitionFields(context), hops,
        hint: edge.edgeStaged
          ? (plan.governanceClass === 3 ? 'Awaiting one Touch ID approval in the Sovereignty card.' : 'Awaiting owner approval of the staged candidate.')
          : 'The candidate is retained locally; the edge did not acknowledge staging. Inspect stageError before retrying.',
      }
    }

    registerBuiltin({
      name: 'stage_organ_promotion',
      description: 'Stage exactly one organ change for owner approval in one call: reads the live HEAD, clones it verbatim, sets entries[id] to the given ball:<sha> (normalizing id, boolean disabled, object config and resolvable previousSpecifiers), adds the hash-verified module, extends the head by one epoch with a canonical ballId, refuses any rider, writes /dsh/home/auma/staged/head-promotion.json, flushes IndexedDB and POSTs /_head/stage. Does not publish or approve; governance organs await Touch ID. Never supply approval tokens, owner secrets or a writer lease.',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id (lower kebab-case).' },
        specifier: { type: 'string', required: true, description: 'ball:<sha256> of module bytes already in the ball store (ball_put first) or live head.' },
        config: { type: 'json', description: 'Entry config object; default keeps the current config, or {}.' },
        disabled: { type: 'boolean', description: 'Default keeps the current value, or false.' },
        description: { type: 'string', description: 'Module description when the module is new.' },
        expectedStagedSha256: { type: 'string', description: 'Exact SHA-256 of a different, still-valid review file this replaces.' },
        replaceStaged: { type: 'boolean', description: 'Ask the edge to replace a different candidate already staged for the same epoch.' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>) {
        refuseBrokerAuthorityInputs(args)
        return serializeMutation(() => stageOrganPromotion(args))
      },
    })

    /**
     * KIRA (AURA HANDOFF-5): one call stages a PURE ADD of 1..8 ordinary organs for one Touch ID on the Add organs card.
     * Built from balls already in her store by sha (`buildOrganSetPromotion`), written to the review file, flushed, and
     * POSTed to `/_head/stage`. HEAD must record the set (`staged.organSet`); if it does not, this is not an ordinary add.
     */
    const stageOrganSetPromotion = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const context = createTransitionContext('head.stage')
      const hops: Array<{ hop: string; ok: boolean; detail?: string }> = []
      const hop = (name: string, ok: boolean, detail?: string) => { hops.push({ hop: name, ok, ...(detail ? { detail } : {}) }) }
      const refuse = (code: string, failedHop: string, extra: Record<string, unknown> = {}) => {
        hop(failedHop, false, code)
        return { ok: false, code, failedHop, edgeStaged: false, ...extra, ...transitionFields(context), hops }
      }
      if (!origin || origin === 'null') return refuse('ORIGIN_UNAVAILABLE', 'live-head')
      if (args.expectedStagedSha256 !== undefined && args.expectedStagedSha256 !== null
        && (typeof args.expectedStagedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedStagedSha256))) {
        return refuse('EXPECTED_STAGED_SHA256_INVALID', 'request')
      }
      if (args.replaceStaged !== undefined && typeof args.replaceStaged !== 'boolean') return refuse('REPLACE_STAGED_INVALID', 'request')
      let live: { ball?: unknown; codeBySha?: unknown }
      try {
        const response = await fetch(new URL('/_head/ball', origin).href, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
        if (!response.ok) return refuse(`HEAD_FETCH_HTTP_${String(response.status)}`, 'live-head')
        const json: unknown = await response.json().catch(() => null)
        if (!record(json) || !record(json.ball)) return refuse('HEAD_FETCH_INVALID', 'live-head')
        live = json
      } catch (_error) {
        return refuse('HEAD_FETCH_UNREACHABLE', 'live-head')
      }
      hop('live-head', true, `${String((live.ball as Record<string, unknown>).ballId).slice(0, 12)}@epoch${String((live.ball as Record<string, unknown>).epoch)}`)
      let plan: OrganSetPromotionPlan
      try {
        plan = buildOrganSetPromotion(live as { ball: unknown; codeBySha?: unknown }, args, {
          authorPeerId: peerId, now: Date.now(),
          readCode: (sha) => {
            const file = join(BALLS_DIR, `${sha}.js`)
            try { return vfs.existsSync(file) ? vfs.readFileSync(file, 'utf8') as string : null } catch { return null }
          },
        })
      } catch (error) {
        return refuse(refusalCode(error, 'ORGAN_SET_INVALID'), 'built', { detail: (error instanceof Error ? error.message : String(error)).slice(0, 240) })
      }
      hop('built', true, `${plan.ball.ballId.slice(0, 12)}@epoch${String(plan.ball.epoch)}:${String(plan.organs.length)}-organ add`)
      // Review-file guard, as stage_organ_promotion: never silently clobber a different owner-review candidate.
      try {
        vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
        if (vfs.existsSync(STAGED_HEAD_PROMOTION_PATH)) {
          const existing = vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
          const existingSha = sha256HexSync(existing)
          let replaceable = false
          let sameBall = false
          try {
            const parsedExisting: unknown = JSON.parse(existing)
            const ball = record(parsedExisting) && record(parsedExisting.body) ? parsedExisting.body.ball : null
            sameBall = record(ball) && ball.ballId === plan.ball.ballId
            replaceable = !record(ball) || manifestStructureProblem(ball) !== null || ball.parentBallId !== plan.ball.parentBallId
              || computeCanonicalBallId(ball as unknown as BallManifest) !== ball.ballId
          } catch { replaceable = true }
          if (!sameBall && !replaceable && args.expectedStagedSha256 !== existingSha) {
            return refuse('STAGED_PROMOTION_REVIEW_CONFLICT', 'local-staged', { existingStagedSha256: existingSha,
              hint: 'Inspect the existing review file; pass expectedStagedSha256 with its exact SHA-256 to replace it.' })
          }
        }
        vfs.writeFileSync(STAGED_HEAD_PROMOTION_PATH, plan.text)
      } catch (error) {
        return refuse('LOCAL_STAGE_WRITE_FAILED', 'local-staged', { detail: (error instanceof Error ? error.message : String(error)).slice(0, 160) })
      }
      const stagedSha256 = sha256HexSync(plan.text)
      hop('local-staged', true, STAGED_HEAD_PROMOTION_PATH)
      const flush = await flushPersistenceReport()
      hop('idb-flushed', flush.flushed && flush.durable, flush.error ?? 'durable')
      const edge = await postHeadStage(plan.text, context, args.replaceStaged === true)
      const organSet = edge.staged?.organSet ?? null
      // HEAD acknowledged a candidate it does not treat as an ordinary add: say so, never present it as the Add card.
      const notRecorded = edge.edgeStaged && organSet === null
      hop('edge-staged', edge.edgeStaged && !notRecorded, notRecorded ? 'ORGAN_SET_NOT_RECORDED' : edge.stageError ?? 'awaiting_owner')
      const ok = edge.edgeStaged && !notRecorded
      return {
        ok, staged: ok,
        ...(ok ? {} : { code: notRecorded ? 'ORGAN_SET_NOT_RECORDED' : edge.stageError ?? 'HEAD_STAGE_NOT_ACKNOWLEDGED', failedHop: 'edge-staged' }),
        ballId: plan.ball.ballId, parentBallId: plan.ball.parentBallId, epoch: plan.ball.epoch,
        organs: plan.organs, newModules: plan.newModules, organSet,
        stagedPath: STAGED_HEAD_PROMOTION_PATH, stagedSha256, persistence: flush,
        edgeStaged: edge.edgeStaged, stageStatus: edge.stageStatus, stageError: edge.stageError, ...transitionFields(context), hops,
        hint: ok ? 'Awaiting one Touch ID on the Add organs card.'
          : notRecorded ? 'HEAD staged it but does not record it as an ordinary add; nothing will be offered on the Add organs card.'
            : 'The candidate is retained locally; the edge did not acknowledge staging. Inspect stageError before retrying.',
      }
    }

    registerBuiltin({
      name: 'stage_organ_set_promotion',
      description: 'Stage a PURE ADD of 1..8 ordinary organs for one Touch ID on the Add organs card: reads the live HEAD, clones it '
        + 'verbatim, adds each organ as { id, ball:<sha>, disabled:false, config:{} } from module bytes already in your ball store '
        + '(ball_put each first; no inline bytes), extends the head by one epoch, writes the review file and POSTs /_head/stage. '
        + 'No config, disabled or governance input exists; an id already in the head or a fixed governance organ is refused. '
        + 'Does not publish or approve. Never supply approval tokens, owner secrets or a writer lease.',
      parameters: {
        organs: { type: 'json', required: true, description: '[{ id, specifier: "ball:<64 hex>", description? }], 1..8, unique ids.' },
        expectedStagedSha256: { type: 'string', description: 'Exact SHA-256 of a different, still-valid review file this replaces.' },
        replaceStaged: { type: 'boolean', description: 'Ask the edge to replace a different candidate already staged for the same epoch.' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>) {
        refuseBrokerAuthorityInputs(args)
        return serializeMutation(() => stageOrganSetPromotion(args))
      },
    })

    registerBuiltin({
      name: 'stage_head_promotion',
      description: 'Write one governance candidate, at most 4 MiB including its review envelope, to /dsh/home/auma/staged/head-promotion.json for owner review. Does not activate, publish, qualify or authorize it, or acknowledge durable persistence. Never supply approval tokens, owner secrets or a writer lease.',
      parameters: { body: { type: 'json', required: true, description: 'Publish candidate containing ball, all codeBySha bytes, expectedParentBallId and expectedEpoch. Must extend the selected head by one epoch and change exactly one governance entry. To replace a different review file, include expectedStagedSha256 matching its exact current bytes. Omit for first staging or identical retries; null requires an absent file.' } },
      output: jsonOut,
      async execute(args: { body: unknown }) { return serializeMutation(() => Promise.resolve(stageHeadPromotion(args.body))) },
    })

    const executeBallPut = async (args: {
      code?: string
      path?: string
      name?: string
      description?: string
      id?: string
      promote?: boolean
      expectedEpoch?: number
      expectedBallId?: string
      includeManifest?: boolean
      qualificationId?: string
    }) => {
      const meta = await ballPut(args)
      if (args.promote === true) {
        const inferredId = args.id?.trim()
          || args.name?.trim()
          || (typeof args.path === 'string' ? args.path.trim().split('/').pop()?.replace(/\.js$/, '') : '')
          || ''
        if (!inferredId) {
          throw new Error('ball_put with promote=true requires `id`, `name`, or a VFS `path` ending in `<entryId>.js`')
        }
        const patch = await treePatch({
          id: inferredId,
          specifier: meta.specifier,
          expectedEpoch: args.expectedEpoch,
          expectedBallId: args.expectedBallId,
          qualificationId: args.qualificationId,
        })
        return {
          ...meta,
          promoted: true as const,
          id: inferredId,
          epoch: patch.ball.epoch,
          ballId: patch.ball.ballId,
          parentBallId: patch.ball.parentBallId,
          patch: compactPatchResult(patch, args.includeManifest),
        }
      }
      return meta
    }

    registerBuiltin({
      name: 'ball_put',
      description:
        'Store a content-addressed Cordis plugin module under /dsh/home/balls/<sha256>.js and return its '
        + '`ball:<sha256>` specifier. Supply either `code` (inline JS) or `path` (existing VFS file path such as `/dsh/home/auma/seed/organs/<name>.js`). '
        + 'Set `promote: true` (with optional `id`) to immediately activate and advance the live ball epoch via `tree_patch`.',
      parameters: {
        code: { type: 'string', description: 'JavaScript source code of the Cordis plugin.' },
        path: { type: 'string', description: 'Optional VFS file path to read JavaScript source from instead of inline `code`.' },
        name: { type: 'string', description: 'Short human-readable plugin name.' },
        description: { type: 'string', description: 'What this plugin provides or modifies.' },
        id: { type: 'string', description: 'Optional Cordis entry ID when `promote: true` (inferred from `path` basename if omitted).' },
        promote: { type: 'boolean', description: 'When true, immediately promotes the stored module into the live ball tree and advances the epoch.' },
        expectedEpoch: { type: 'number', description: 'Optional CAS expected epoch when `promote: true`.' },
        expectedBallId: { type: 'string', description: 'Optional CAS expected ballId when `promote: true`.' },
        qualificationId: { type: 'string', description: 'Required for promotion: runtime-issued single-use Pearl admission, valid for five minutes and this exact source, head, executable suite and entry. This is not owner authorization.' },
        includeManifest: { type: 'boolean', description: 'When true, includes the full ball manifest in the promotion result (omitted by default to save context tokens).' },
      },
      output: jsonOut,
      execute: executeBallPut,
    })

    registerBuiltin({
      name: 'pearl_put',
      description:
        'Store a content-addressed Cordis Pearl module under /dsh/home/balls/<sha256>.js and return its '
        + '`ball:<sha256>` specifier (alias of `ball_put`). Supports `code` or `path`, plus `promote: true` to advance the live epoch.',
      parameters: {
        code: { type: 'string', description: 'JavaScript source code of the Cordis Pearl plugin.' },
        path: { type: 'string', description: 'Optional VFS file path to read JavaScript source from instead of inline `code`.' },
        name: { type: 'string', description: 'Short human-readable Pearl name.' },
        description: { type: 'string', description: 'What this Pearl provides or modifies.' },
        id: { type: 'string', description: 'Optional Cordis entry ID when `promote: true` (inferred from `path` basename if omitted).' },
        promote: { type: 'boolean', description: 'When true, immediately promotes the stored Pearl into the live tree and advances the epoch.' },
        expectedEpoch: { type: 'number', description: 'Optional CAS expected epoch when `promote: true`.' },
        expectedBallId: { type: 'string', description: 'Optional CAS expected ballId when `promote: true`.' },
        qualificationId: { type: 'string', description: 'Required for promotion: runtime-issued single-use Pearl admission, valid for five minutes and this exact source, head, executable suite and entry. This is not owner authorization.' },
        includeManifest: { type: 'boolean', description: 'When true, includes the full ball manifest in the promotion result (omitted by default to save context tokens).' },
      },
      output: jsonOut,
      execute: executeBallPut,
    })

    registerBuiltin({
      name: 'tree_patch',
      description:
        'Mount or hot-swap a Cordis plugin entry in the live runtime without page reload. Candidate code executes '
        + 'in the main runtime; this is not an isolated trial. Failed activation attempts rollback. Inspect the '
        + 'reported outcome, fiberHealth and separate persistence acknowledgements before retrying.',
      parameters: {
        id: { type: 'string', required: true, description: 'Stable entry ID in the Cordis ball tree (e.g. "self/my-organ").' },
        specifier: { type: 'string', required: true, description: 'Module specifier returned by ball_put (e.g. "ball:<sha256>").' },
        config: { type: 'json', description: 'Optional configuration object passed to apply(ctx, config).' },
        disabled: { type: 'boolean', description: 'Set true to stop and disable the entry.' },
        expectedBallId: { type: 'string', description: 'Optional exact selected head ID, checked inside the serialized mutation.' },
        expectedEpoch: { type: 'number', description: 'Optional Compare-And-Swap expected epoch of HEAD.json; fails with CAS_EPOCH_MISMATCH if concurrent edit occurred.' },
        qualificationId: { type: 'string', required: true, description: 'Required single-use Pearl admission for this exact source, head, executable suite and entry; expires after five minutes. This is not owner authorization.' },
        includeManifest: { type: 'boolean', description: 'When true, includes the full ball manifest in the result (omitted by default to save ~40k context tokens).' },
      },
      output: jsonOut,
      async execute(args: {
        id: string
        specifier: string
        config?: Record<string, unknown>
        disabled?: boolean
        expectedEpoch?: number
        expectedBallId?: string
        includeManifest?: boolean
        qualificationId?: string
      }) {
        const patch = await treePatch(args)
        return compactPatchResult(patch, args.includeManifest)
      },
    })

    registerBuiltin({
      name: 'tree_undo',
      description:
        'Revert a Cordis ball entry (or the most recently modified entry when `id` is omitted) to its previous '
        + '`ball:<sha256>` version, disposing all side-effects (tools, services, listeners, timers) in LIFO order '
        + 'with zero page reload across all connected tabs.',
      parameters: {
        id: { type: 'string', description: 'Optional entry ID to revert; defaults to the last modified entry.' },
        expectedBallId: { type: 'string', description: 'Optional exact head ID checked inside the serialized mutation.' },
      },
      output: jsonOut,
      async execute(args: { id?: string; expectedBallId?: string }) {
        return await treeUndo(args)
      },
    })

    // What her host says about her (HEAD promotion status, AUMLOK binding, verified facts), read-only.
    {
      const spec = { ...hostFactsToolSpec(() => ({ origin })), output: jsonOut }
      registerBuiltin(spec)
    }

    for (const name of ['x6_facts', 'ball_status', 'self_facts']) {
      registerBuiltin({
        name,
        description: 'Read bounded payload-free host facts, head metadata and compact mirror status using the existing session. Network/authentication failures remain explicit; local build metadata is an unverified fallback, never owner approval.',
        parameters: name === 'ball_status' ? { includeManifest: { type: 'boolean', description: 'Return the local status manifest instead of host facts. Above 64 KiB the manifest fields are left out (named in manifestOmitted) and the head, health and every entry state stay.' } } : {},
        output: jsonOut,
        async execute(args?: { includeManifest?: boolean }) {
          if (name === 'ball_status' && args?.includeManifest === true) return boundedStatus(readStatus())
          let localBuild: unknown = buildIdentity
          const path = '/dsh/home/auma/seed/BUILD_INFO.json'
          try {
            if (vfs.existsSync(path) && vfs.statSync(path).size <= 16 * 1024) localBuild = JSON.parse(vfs.readFileSync(path, 'utf8') as string)
          } catch (_error) { /* Missing or malformed build metadata leaves the compiled identity fallback. */ }
          // Her published head can be ahead of the one this tab runs: say so beside the host's facts, never instead of them.
          const lag = currentHeadLag()
          const facts = await readX6Facts(origin, localBuild)
          return lag === null ? facts : { ...facts, headLag: lag }
        },
      })
    }

    registerBuiltin({
      name: 'head_adopt',
      description:
        'Read the published head (`/_head/ball`) and say whether this tab runs it. An open tab never hot-swaps to a head published elsewhere: '
        + 'nothing mounted changes, and the answer is always `adopted: false`. When a newer Auma is published the answer says so in `say` '
        + '(and in `headLag`): tell the owner in your own words that a newer Auma is published and that one reload of the page brings her; '
        + 'the app shows him the same with a Reload button. `force` is not accepted (answer `HEAD_ADOPT_FORCE_REFUSED`). '
        + 'Returns `{ ok, adopted: false, alreadyCurrent, running, published, say, headLag }`.',
      parameters: {},
      output: jsonOut,
      async execute(args: { force?: unknown }) {
        return await describePublishedHead(args)
      },
    })

    const inspectStagedPromotions = async (): Promise<Record<string, unknown>> => {
      const stagedDir = '/dsh/home/auma/staged'
      const stagedFiles: Array<Record<string, unknown>> = []
      if (vfs.existsSync(stagedDir)) {
        const names = vfs.readdirSync(stagedDir).map(String).filter(n => n.endsWith('.json')).sort()
        for (const name of names) {
          const fullPath = join(stagedDir, name)
          try {
            const raw = vfs.readFileSync(fullPath, 'utf8') as string
            const parsed = JSON.parse(raw) as Record<string, unknown>
            const body = record(parsed.body) ? parsed.body : parsed
            const ball = record(body.ball) ? body.ball : null
            if (ball && typeof ball.ballId === 'string' && typeof ball.epoch === 'number') {
              const entries = record(ball.entries) ? ball.entries : {}
              const changedEntries = Object.keys(entries).filter(
                id => JSON.stringify(entries[id]) !== JSON.stringify(currentBall.entries[id]),
              )
              const canonical = computeCanonicalBallId(ball as unknown as BallManifest) === ball.ballId
              stagedFiles.push({
                path: fullPath,
                stagedSha256: sha256HexSync(raw),
                stagedAt: parsed.stagedAt ?? null,
                ballId: ball.ballId,
                parentBallId: ball.parentBallId ?? null,
                epoch: ball.epoch,
                authorPeerId: ball.authorPeerId ?? null,
                expectedParentBallId: body.expectedParentBallId ?? null,
                expectedEpoch: body.expectedEpoch ?? null,
                changedEntries,
                unchangedOtherEntries: changedEntries.length <= 1,
                canonicalManifestId: canonical,
                moduleCount: record(ball.modules) ? Object.keys(ball.modules).length : 0,
                codeByShaCount: record(body.codeBySha) ? Object.keys(body.codeBySha).length : 0,
              })
            }
          } catch (err) {
            stagedFiles.push({ path: fullPath, error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
      let edgeHead: Record<string, unknown> | null = null
      if (origin && origin !== 'null') {
        try {
          const res = await fetch(new URL('/_head/promotion-status', origin).href, { credentials: 'same-origin', cache: 'no-store' })
          if (res.ok) edgeHead = await res.json() as Record<string, unknown>
          else {
            const fallback = await fetch(new URL('/_head/lease', origin).href, { credentials: 'same-origin', cache: 'no-store' })
            if (fallback.ok) edgeHead = await fallback.json() as Record<string, unknown>
          }
        } catch (err) {
          edgeHead = { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      const primary = stagedFiles.find(f => f.path === STAGED_HEAD_PROMOTION_PATH) ?? stagedFiles[0] ?? null
      const lastOutcome = record(edgeHead?.lastPublishOutcome) ? edgeHead.lastPublishOutcome : null
      return {
        ok: true,
        stagedPromotionPresent: Boolean(primary && typeof primary.ballId === 'string'),
        epoch: primary && typeof primary.epoch === 'number' ? primary.epoch : null,
        ballId: primary && typeof primary.ballId === 'string' ? primary.ballId : null,
        parentBallId: primary && typeof primary.parentBallId === 'string' ? primary.parentBallId : null,
        authorPeerId: primary && typeof primary.authorPeerId === 'string' ? primary.authorPeerId : null,
        unchangedOtherEntries: primary ? Boolean(primary.unchangedOtherEntries) : false,
        canonicalManifestId: primary ? Boolean(primary.canonicalManifestId) : false,
        lastAuthorizationOutcome: lastOutcome === null ? 'none' : (lastOutcome.ok === true ? (lastOutcome.hasApprovalToken === true ? 'consumed' : 't1-session') : 'refused'),
        lastErrorCode: lastOutcome && lastOutcome.ok !== true && typeof lastOutcome.code === 'string' ? lastOutcome.code : null,
        stagedRepoProposal: record(edgeHead?.stagedRepoProposal) ? edgeHead.stagedRepoProposal : null,
        lastRepoMergeOutcome: record(edgeHead?.lastRepoMergeOutcome) ? edgeHead.lastRepoMergeOutcome : null,
        localHead: { ballId: currentBall.ballId, epoch: currentBall.epoch, peerId },
        stagedFiles,
        edgeHead,
      }
    }

    const executePromoteStaged = async (
      targetPathArg?: unknown,
      opts?: { dryRun?: boolean; allowRebase?: boolean },
    ): Promise<Record<string, unknown>> => {
      const dryRun = opts?.dryRun === true
      const allowRebase = opts?.allowRebase === true
      const promoteContext = createTransitionContext('head.promote')
      const hops: Array<{ hop: string; at: number; ok: boolean; detail?: string }> = []
      const logHop = (hop: string, ok: boolean, detail?: string) => {
        hops.push({ hop, at: Date.now(), ok, ...(detail ? { detail } : {}) })
      }
      if (!origin || origin === 'null') {
        logHop('origin-check', false, 'ORIGIN_UNAVAILABLE')
        return { ok: false, code: 'ORIGIN_UNAVAILABLE', failedHop: 'origin-check', hops }
      }
      // An open tab never hot-swaps to a head published elsewhere: when a newer one is published, a promotion built here
      // would sit on a head the edge no longer has, so say so first. One reload brings the published head.
      const published = await checkPublishedHead()
      if (!dryRun && published.headLag?.newer === true) {
        logHop('origin-check', false, 'HEAD_RELOAD_REQUIRED')
        return { ok: false, code: 'HEAD_RELOAD_REQUIRED', failedHop: 'origin-check', say: published.headLag.say, headLag: published.headLag, hops }
      }
      const rawArg = typeof targetPathArg === 'string' && targetPathArg.trim() ? targetPathArg.trim() : STAGED_HEAD_PROMOTION_PATH
      const fullPath = rawArg.startsWith('/') ? rawArg
        : rawArg === 'epoch64' || rawArg === '64' ? '/dsh/home/auma/staged/head-promotion.epoch64.json'
          : join('/dsh/home/auma/staged', rawArg)
      if (!vfs.existsSync(fullPath)) {
        logHop('staged', false, `STAGED_PROMOTION_NOT_FOUND:${fullPath}`)
        return { ok: false, code: 'STAGED_PROMOTION_NOT_FOUND', failedHop: 'staged', path: fullPath, hops }
      }
      const raw = vfs.readFileSync(fullPath, 'utf8') as string
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>
      } catch {
        logHop('staged', false, 'STAGED_PROMOTION_JSON_INVALID')
        return { ok: false, code: 'STAGED_PROMOTION_JSON_INVALID', failedHop: 'staged', path: fullPath, hops }
      }
      const body = (record(parsed.body) ? parsed.body : parsed) as Record<string, unknown>
      const rawBall = (record(body.ball) ? body.ball : null) as BallManifest | null
      if (!rawBall || typeof rawBall.ballId !== 'string' || typeof rawBall.epoch !== 'number') {
        logHop('staged', false, 'STAGED_PROMOTION_INVALID')
        return { ok: false, code: 'STAGED_PROMOTION_INVALID', failedHop: 'staged', path: fullPath, hops }
      }
      const originalBallId = rawBall.ballId
      const originalParentBallId = rawBall.parentBallId ?? null
      const originalEpoch = rawBall.epoch
      const ball = JSON.parse(JSON.stringify(rawBall)) as {
        version: 'x6.1-ball/v1'
        ballId: string
        parentBallId: string | null
        epoch: number
        createdAt: number
        authorPeerId: string
        entries: Record<string, BallEntryRecord>
        modules: Record<string, BallModuleMeta>
      }
      logHop('staged', true, `${ball.ballId.slice(0, 12)}@epoch${String(ball.epoch)}`)
      const rawCodeBySha: Record<string, unknown> = record(body.codeBySha)
        ? (body.codeBySha as Record<string, unknown>)
        : {}
      const codeBySha: Record<string, string> = {}
      const inlineSource = typeof body.candidateSource === 'string'
        ? body.candidateSource
        : (typeof parsed.candidateSource === 'string' ? parsed.candidateSource : null)
      if (typeof inlineSource === 'string' && inlineSource.length > 0) {
        const inlineSha = sha256HexSync(inlineSource)
        rawCodeBySha[inlineSha] = inlineSource
      }
      for (const [sha, code] of Object.entries(rawCodeBySha)) {
        if (typeof code === 'string' && sha256HexSync(code) === sha) {
          codeBySha[sha] = code
          const p = join(BALLS_DIR, `${sha}.js`)
          if (!dryRun && !vfs.existsSync(p)) vfs.writeFileSync(p, code)
        }
      }
      // Strictly key module bytes by SHA-256 (balls store + content-verified staging/candidates directories).
      const findCodeForSha = (sha: string): string | null => {
        if (!/^[a-f0-9]{64}$/.test(sha)) return null
        if (typeof codeBySha[sha] === 'string' && sha256HexSync(codeBySha[sha]) === sha) return codeBySha[sha]
        const shaKeyedPaths = [
          join(BALLS_DIR, `${sha}.js`),
          `/dsh/home/organs/${sha}.js`,
          `/dsh/home/auma/balls/${sha}.js`,
        ]
        for (const p of shaKeyedPaths) {
          if (vfs.existsSync(p)) {
            try {
              const c = vfs.readFileSync(p, 'utf8') as string
              if (sha256HexSync(c) === sha) return c
            } catch {}
          }
        }
        const candidateDirs = [
          '/dsh/home/auma/seed/staging',
          '/dsh/home/auma/seed/candidates',
          '/dsh/home/auma/seed/organs',
        ]
        for (const dir of candidateDirs) {
          if (!vfs.existsSync(dir)) continue
          try {
            for (const f of vfs.readdirSync(dir).map(String).filter(n => n.endsWith('.js'))) {
              const c = vfs.readFileSync(join(dir, f), 'utf8') as string
              if (sha256HexSync(c) === sha) {
                const ballPath = join(BALLS_DIR, `${sha}.js`)
                if (!dryRun && !vfs.existsSync(ballPath)) vfs.writeFileSync(ballPath, c)
                return c
              }
            }
          } catch {}
        }
        if (vfs.existsSync(SNAPSHOTS_DIR)) {
          try {
            for (const f of vfs.readdirSync(SNAPSHOTS_DIR).map(String).filter(n => n.endsWith('.json'))) {
              const rawSnap = vfs.readFileSync(join(SNAPSHOTS_DIR, f), 'utf8') as string
              const s = JSON.parse(rawSnap) as { codeBySha?: Record<string, string> }
              const c = s?.codeBySha?.[sha]
              if (typeof c === 'string' && sha256HexSync(c) === sha) return c
            }
          } catch {}
        }
        return null
      }
      const needsRebase = ball.parentBallId !== currentBall.ballId || ball.epoch !== currentBall.epoch + 1
      if (needsRebase && !allowRebase && !dryRun) {
        logHop('validated-t1', false, 'REBASE_CONFIRMATION_REQUIRED')
        return {
          ok: false,
          code: 'REBASE_CONFIRMATION_REQUIRED',
          failedHop: 'validated-t1',
          path: fullPath,
          originalBallId,
          originalParentBallId,
          currentHeadBallId: currentBall.ballId,
          originalEpoch,
          currentHeadEpoch: currentBall.epoch,
          hint: 'Pass allowRebase: true to rebase onto current HEAD (or dryRun: true to inspect the plan).',
          hops,
        }
      }
      let repaired = false
      if (!record(ball.modules)) {
        ball.modules = {}
        repaired = true
      }
      for (const [sha, meta] of Object.entries(currentBall.modules ?? {})) {
        if (!Object.hasOwn(ball.modules, sha)) {
          ball.modules[sha] = JSON.parse(JSON.stringify(meta)) as BallModuleMeta
          repaired = true
        }
      }
      if (needsRebase && (allowRebase || dryRun)) {
        for (const [id, entry] of Object.entries(ball.entries ?? {})) {
          const cur = currentBall.entries[id]
          const sameExecution = cur && entry && entry.specifier === cur.specifier
            && entry.disabled === cur.disabled && JSON.stringify(entry.config ?? {}) === JSON.stringify(cur.config ?? {})
          if (sameExecution && JSON.stringify(entry) !== JSON.stringify(cur)) {
            ball.entries[id] = JSON.parse(JSON.stringify(cur)) as BallEntryRecord
            repaired = true
          }
        }
        ball.parentBallId = currentBall.ballId
        ball.epoch = currentBall.epoch + 1
        repaired = true
      }
      for (const [id, entry] of Object.entries(ball.entries ?? {})) {
        const versions = [
          entry,
          ...(Array.isArray(entry.previousVersions) ? entry.previousVersions : []),
          ...(Array.isArray(entry.previousSpecifiers) ? entry.previousSpecifiers.map(specifier => ({ specifier })) : []),
        ]
        for (const version of versions) {
          const spec = typeof version?.specifier === 'string' ? version.specifier : ''
          if (spec.startsWith('ball:')) {
            const sha = spec.slice(5)
            const code = findCodeForSha(sha)
            if (typeof code === 'string') {
              codeBySha[sha] = code
              const p = join(BALLS_DIR, `${sha}.js`)
              if (!dryRun && !vfs.existsSync(p)) vfs.writeFileSync(p, code)
            }
            const existingMeta = ball.modules[sha]
            if (!existingMeta || existingMeta.sha256 !== sha || existingMeta.specifier !== `ball:${sha}`) {
              const metaPath = join(BALLS_DIR, `${sha}.meta.json`)
              let loadedMeta: BallModuleMeta | null = null
              if (vfs.existsSync(metaPath)) {
                try {
                  const m = JSON.parse(vfs.readFileSync(metaPath, 'utf8') as string) as BallModuleMeta
                  if (m && m.sha256 === sha && m.specifier === `ball:${sha}`) loadedMeta = m
                } catch {}
              }
              ball.modules[sha] = loadedMeta ?? {
                sha256: sha,
                specifier: `ball:${sha}`,
                name: id,
                description: `Seed organ ${id}`,
                size: typeof code === 'string' ? new TextEncoder().encode(code).byteLength : 0,
                createdAt: typeof entry.updatedAt === 'number'
                  ? entry.updatedAt
                  : (typeof ball.createdAt === 'number' ? ball.createdAt : Date.now()),
              }
              repaired = true
            }
          }
        }
      }
      // Lane E4: a changed entry HEAD would refuse as INVALID_ENTRY / MODULE_MISSING is normalized here, once, visibly.
      const normalizedEntries: string[] = []
      for (const [id, entry] of Object.entries(ball.entries ?? {})) {
        if (!record(entry) || JSON.stringify(entry) === JSON.stringify(currentBall.entries[id])) continue
        const mutable = entry as unknown as Record<string, unknown>
        const prior = currentBall.entries[id] as BallEntryRecord | undefined
        let fixed = false
        if (mutable.id !== id) { mutable.id = id; fixed = true }
        if (typeof mutable.disabled !== 'boolean') { mutable.disabled = typeof prior?.disabled === 'boolean' ? prior.disabled : false; fixed = true }
        if (!record(mutable.config)) {
          mutable.config = record(prior?.config) ? JSON.parse(JSON.stringify(prior.config)) as Record<string, unknown> : {}
          fixed = true
        }
        const listed: unknown[] = Array.isArray(mutable.previousSpecifiers) ? mutable.previousSpecifiers : []
        const kept = [...new Set(listed.filter((value): value is string => typeof value === 'string' && value.length > 0
          && (!value.startsWith('ball:') || (/^ball:[a-f0-9]{64}$/.test(value) && Object.hasOwn(ball.modules, value.slice(5))))))]
        if (!Array.isArray(mutable.previousSpecifiers) || kept.length !== listed.length) { mutable.previousSpecifiers = kept; fixed = true }
        if (fixed) { normalizedEntries.push(id); repaired = true }
      }
      const missingModuleByteShas: string[] = []
      for (const sha of Object.keys(ball.modules ?? {})) {
        if (!codeBySha[sha]) {
          const code = findCodeForSha(sha)
          if (typeof code === 'string') codeBySha[sha] = code
        }
        if (typeof codeBySha[sha] !== 'string' || sha256HexSync(codeBySha[sha]) !== sha) {
          missingModuleByteShas.push(sha)
        }
      }
      const leaseOwner = typeof ball.authorPeerId === 'string' && ball.authorPeerId ? ball.authorPeerId : peerId
      if (ball.authorPeerId !== leaseOwner) {
        ball.authorPeerId = leaseOwner
        repaired = true
      }
      const changedEntries = Object.keys(ball.entries ?? {}).filter(
        id => JSON.stringify(ball.entries[id]) !== JSON.stringify(currentBall.entries[id]),
      )
      const compactCodeBySha: Record<string, string> = {}
      for (const [sha, code] of Object.entries(codeBySha)) {
        const isChangedEntrySha = changedEntries.some(id => ball.entries[id]?.specifier === `ball:${sha}`)
        if (!Object.hasOwn(currentBall.modules ?? {}, sha) || isChangedEntrySha) {
          compactCodeBySha[sha] = code
        }
      }
      const rewriteStagedEnvelope = repaired || computeCanonicalBallId(ball) !== ball.ballId
      if (rewriteStagedEnvelope) {
        ball.ballId = computeCanonicalBallId(ball)
        if (!dryRun) {
          try {
            const updatedEnvelope = {
              schema: 'aukora.staged-head-promotion.v1',
              stagedAt: typeof parsed.stagedAt === 'number' ? parsed.stagedAt : Date.now(),
              body: {
                ball,
                codeBySha: compactCodeBySha,
                expectedParentBallId: ball.parentBallId,
                expectedEpoch: ball.epoch - 1,
              },
            }
            vfs.writeFileSync(fullPath, JSON.stringify(updatedEnvelope, null, 2) + '\n')
          } catch {}
        }
      }
      const canonical = computeCanonicalBallId(ball) === ball.ballId
      const structureProblem = manifestStructureProblem(ball)
      const transition = classifyHeadManifestTransition(currentBall, ball, { canonicalManifestMatches: canonical })
      // A multi-organ pure add (strict rule, verified sizes) is promoted by the owner's Add organs card; said as an
      // extra field only, so this path's own errors and dry-run diagnostics are exactly what they were.
      const organSet = organAdditionSetOf(currentBall, ball, sha => typeof codeBySha[sha] === 'string' ? codeBySha[sha] : null)
      const organSetNote = organSet !== null && organSet.length > 1
        ? { organSet, organSetHint: 'This candidate adds several organs; the owner promotes it with one Touch ID on the Add organs card.' } : {}
      const unchangedOtherEntries = changedEntries.length === 1
      const totalCodeBytes = Object.values(codeBySha).reduce(
        (acc, c) => acc + new TextEncoder().encode(c).byteLength,
        0,
      )
      const compactCodeBytes = Object.values(compactCodeBySha).reduce(
        (acc, c) => acc + new TextEncoder().encode(c).byteLength,
        0,
      )
      const rebaseReceipt = needsRebase ? {
        rebased: true,
        originalBallId,
        newBallId: ball.ballId,
        originalParentBallId,
        newParentBallId: ball.parentBallId,
        originalEpoch,
        newEpoch: ball.epoch,
      } : null
      if (dryRun) {
        const planValid = canonical && structureProblem === null && unchangedOtherEntries && missingModuleByteShas.length === 0
        const hopName = transition.tier === 'T1' ? 'validated-t1' : 'classified-t2'
        const hopDetail = `tier=${transition.tier}:changed=${changedEntries.join(',') || 'none'}`
          + (transition.t2Reasons.length ? `:reasons=${transition.t2Reasons.join(',')}` : '')
        logHop(hopName, planValid, hopDetail)
        logHop('dry-run-complete', planValid, 'no-mutation-committed')
        return {
          ok: planValid,
          dryRun: true,
          committed: false,
          tier: transition.tier,
          requiresPasskey: transition.requiresPasskey,
          eligibleForT1: transition.eligibleForT1,
          wouldSucceedUnderT1: planValid && transition.eligibleForT1,
          authCode: transition.eligibleForT1 ? 'T1_OWNER_SESSION_ELIGIBLE' : 'CLASS3_WEBAUTHN_REQUIRED',
          t2Reasons: transition.t2Reasons,
          path: fullPath,
          byteSourcePolicy: 'strict-sha256-balls-store-only',
          originalBallId,
          resultingBallId: ball.ballId,
          originalParentBallId,
          resultingParentBallId: ball.parentBallId,
          originalEpoch,
          resultingEpoch: ball.epoch,
          rebaseRequired: needsRebase,
          rebase: rebaseReceipt,
          repairedManifestModules: repaired,
          normalizedEntries,
          manifestProblem: structureProblem,
          changedEntries,
          unchangedOtherEntries,
          canonicalManifestId: canonical,
          ...transitionFields(promoteContext),
          moduleCount: Object.keys(ball.modules).length,
          codeByShaCount: Object.keys(codeBySha).length,
          compactCodeByShaCount: Object.keys(compactCodeBySha).length,
          totalCodeBytes,
          compactCodeBytes,
          modulesToWrite: Object.keys(compactCodeBySha),
          missingModuleByteShas,
          ...organSetNote,
          hops,
        }
      }
      if (!canonical) {
        logHop('validated-t1', false, 'CLASS3_CANONICAL_MANIFEST_REQUIRED')
        return { ok: false, code: 'CLASS3_CANONICAL_MANIFEST_REQUIRED', failedHop: 'validated-t1', path: fullPath, hops }
      }
      if (structureProblem) {
        const code = `STAGED_PROMOTION_${structureProblem.code}`
        logHop('validated-manifest', false, `${code}${structureProblem.at ? `:${structureProblem.at}` : ''}`)
        return { ok: false, code, failedHop: 'validated-manifest', at: structureProblem.at, normalizedEntries, path: fullPath, hops }
      }
      if (changedEntries.length !== 1) {
        const errCode = changedEntries.length === 0 ? 'NO_CHANGED_ENTRIES' : 'UNCHANGED_OTHER_ENTRIES_REQUIRED'
        logHop('validated-t1', false, errCode)
        return { ok: false, code: errCode, failedHop: 'validated-t1', changedEntries, path: fullPath, ...organSetNote, hops }
      }
      if (missingModuleByteShas.length > 0) {
        logHop('validated-t1', false, 'MODULE_BYTES_REQUIRED')
        return { ok: false, code: 'MODULE_BYTES_REQUIRED', failedHop: 'validated-t1', missingModuleByteShas, path: fullPath, hops }
      }
      if (transition.tier === 'T2') {
        // Upload the same envelope retained locally, including its original staging timestamp.
        const t2Envelope = rewriteStagedEnvelope
          ? { schema: 'aukora.staged-head-promotion.v1',
            stagedAt: typeof parsed.stagedAt === 'number' ? parsed.stagedAt : Date.now(),
            body: { ball, codeBySha: compactCodeBySha, expectedParentBallId: ball.parentBallId, expectedEpoch: ball.epoch - 1 } }
          : { schema: 'aukora.staged-head-promotion.v1',
            stagedAt: typeof parsed.stagedAt === 'number' ? parsed.stagedAt : Date.now(), body }
        try {
          vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
          vfs.writeFileSync(STAGED_HEAD_PROMOTION_PATH, JSON.stringify(t2Envelope, null, 2) + '\n')
        } catch (error) {
          logHop('staged-for-t2-passkey', false, 'LOCAL_STAGE_WRITE_FAILED')
          return { ok: false, code: 'LOCAL_STAGE_WRITE_FAILED', stagedForOwner: false, edgeStaged: false,
            error: error instanceof Error ? error.message : String(error), hops }
        }
        const persistenceReport = await flushPersistenceReport()
        logHop('idb-flushed', persistenceReport.flushed && persistenceReport.durable, persistenceReport.error ?? 'durable')
        const stageContext = createTransitionContext('head.stage', promoteContext.operationId)
        const edge = await postHeadStage(JSON.stringify(t2Envelope), stageContext, false)
        const edgeStaged = edge.edgeStaged
        const edgeBinding = edge.binding
        const stageError = edge.stageError
        const stageStatus = edge.stageStatus
        const stageDetail = edge.stageDetail ?? null
        const passkeyCardEligible = edgeStaged
        logHop(
          'staged-for-t2-passkey',
          passkeyCardEligible,
          `${STAGED_HEAD_PROMOTION_PATH}:${transition.t2Reasons.join(',')}:edgeStaged=${String(edgeStaged)}`,
        )
        return {
          ok: false,
          code: 'CLASS3_WEBAUTHN_REQUIRED',
          tier: 'T2',
          requiresPasskey: true,
          t2Reasons: transition.t2Reasons,
          stagedForOwner: passkeyCardEligible,
          edgeStaged,
          stageError,
          stageStatus,
          stageDetail,
          persistence: persistenceReport,
          normalizedEntries,
          ...transitionFields(stageContext),
          binding: edgeBinding,
          stagedPath: STAGED_HEAD_PROMOTION_PATH,
          path: fullPath,
          resultingBallId: ball.ballId,
          resultingEpoch: ball.epoch,
          changedEntries,
          rebase: rebaseReceipt,
          hint: passkeyCardEligible
            ? 'Staged at /dsh/home/auma/staged/head-promotion.json and /_head/stage for one-tap Touch ID approval in the Sovereignty UI card.'
            : 'The candidate is retained locally, but the host did not acknowledge owner staging. Inspect stageError and promotion_status before retrying.',
          hops,
        }
      }
      logHop('validated-t1', true, `changed=${changedEntries.join(',') || 'none'}${repaired ? ':repaired-modules' : ''}`)
      const leaseRes = await fetch(new URL('/_head/lease', origin).href, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'acquire', ownerPeerId: leaseOwner }),
      })
      const leaseJson = await leaseRes.json() as {
        ok?: boolean
        code?: string
        ballId?: string
        epoch?: number
        lease?: { ownerPeerId: string; generation: number; expiresAt: number }
      }
      if (!leaseRes.ok || !leaseJson.ok || !leaseJson.lease) {
        const errCode = leaseJson.code ?? 'LEASE_ACQUIRE_FAILED'
        logHop('lease-acquired', false, errCode)
        return { ok: false, code: errCode, failedHop: 'lease-acquired', status: leaseRes.status, leaseResponse: leaseJson, hops }
      }
      const heldLease = leaseJson.lease
      logHop('lease-acquired', true, `owner=${heldLease.ownerPeerId}:gen=${String(heldLease.generation)}`)
      try {
        const publishPayload = {
          ...body,
          ball,
          codeBySha,
          expectedParentBallId: ball.parentBallId,
          expectedEpoch: ball.epoch - 1,
          writerLease: { ownerPeerId: heldLease.ownerPeerId, generation: heldLease.generation },
        }
        logHop('authorized', true, 't1-owner-session')
        const pubRes = await fetch(new URL('/_head/ball', origin).href, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(publishPayload),
        })
        const pubJson = await pubRes.json() as Record<string, unknown>
        if (!pubRes.ok || pubJson.ok !== true) {
          const errCode = typeof pubJson.code === 'string' ? pubJson.code : `HEAD_HTTP_${String(pubRes.status)}`
          logHop('head-committed', false, errCode)
          return {
            ok: false, code: errCode, failedHop: 'head-committed', status: pubRes.status,
            path: fullPath, candidateBallId: ball.ballId, candidateEpoch: ball.epoch, ...pubJson, hops,
          }
        }
        logHop('head-committed', true, `${String(pubJson.ballId ?? ball.ballId).slice(0, 12)}@epoch${String(pubJson.epoch ?? ball.epoch)}`)
        let adopted: Record<string, unknown> = { ok: false, adopted: false }
        try {
          adopted = await headAdopt({ force: true, expectBallId: typeof pubJson.ballId === 'string' ? pubJson.ballId : ball.ballId })
          logHop('adopted', true, `adopted=${String(adopted.adopted)}`)
        } catch (adoptErr) {
          const msg = adoptErr instanceof Error ? adoptErr.message : String(adoptErr)
          adopted = { ok: false, adopted: false, error: msg }
          logHop('adopted', false, msg.slice(0, 120))
        }
        let receiptSaved = false
        let receiptDeferred: string | null = null
        try {
          const receiptEntryId = changedEntries[0] ?? 'head'
          const plan = planPromotionReceipt({
            entryId: receiptEntryId, manifest: ball, context: promoteContext,
            governance: classifyEntryGovernance(receiptEntryId, ball.entries[receiptEntryId]) === 3
              || classifyEntryGovernance(receiptEntryId, currentBall.entries[receiptEntryId]) === 3,
            authoritative: { ok: true, resultingBallId: typeof pubJson.ballId === 'string' ? pubJson.ballId : ball.ballId,
              resultingEpoch: typeof pubJson.epoch === 'number' ? pubJson.epoch : ball.epoch, hasApprovalToken: pubJson.hasApprovalToken === true },
            ...(rebaseReceipt ? { extra: { rebase: rebaseReceipt } } : {}),
          })
          if (plan.write) {
            const out = await appendPromotionReceiptOnce({ kind: 'head.promote', epoch: ball.epoch, ballId: ball.ballId, data: plan.data })
            receiptSaved = out.ok
            if (out.ok && !out.deduplicated) {
              const flushed = await flushPersistenceReport()
              if (flushed.error) logHop('idb-flushed', false, flushed.error)
            }
          } else {
            receiptDeferred = plan.reason
            await ensureRetroPromotionReceipts(changedEntries)
            receiptSaved = hasPromotionReceiptInJsonl(readTextSafe(RECEIPTS_JSONL_PATH), ball.epoch, ball.ballId)
          }
        } catch {}
        logHop('receipt-written', receiptSaved, `receiptSaved=${String(receiptSaved)}${receiptDeferred ? `:${receiptDeferred}` : ''}`)
        let githubSync: Record<string, unknown> | null = null
        try {
          githubSync = await syncHeadToGithub()
          logHop('github-synced', githubSync.ok === true, String(githubSync.commitSha ?? (githubSync.upToDate ? 'up-to-date' : 'deferred')))
        } catch {}
        return {
          ok: true,
          promoted: true,
          repairedManifestModules: repaired,
          rebase: rebaseReceipt,
          tier: 'T1',
          path: fullPath,
          ballId: pubJson.ballId ?? ball.ballId,
          epoch: pubJson.epoch ?? ball.epoch,
          changedEntries,
          unchangedOtherEntries: true,
          receiptSaved,
          receiptDeferred,
          normalizedEntries,
          ...transitionFields(promoteContext),
          adopted,
          githubSync,
          hops,
        }
      } finally {
        await fetch(new URL('/_head/lease', origin).href, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'release', ownerPeerId: heldLease.ownerPeerId, generation: heldLease.generation }),
        }).catch(() => {})
      }
    }

    let retroReceiptsInFlight: Promise<string[]> | null = null
    const ensureRetroPromotionReceipts = (changedEntriesHint?: readonly string[]): Promise<string[]> => {
      if (retroReceiptsInFlight) return retroReceiptsInFlight
      retroReceiptsInFlight = (async (): Promise<string[]> => {
        const recovered: string[] = []
        if (currentBall.epoch < 63) return recovered
        try {
          for (let wait = 0; wait < 24 && !mountedOrgans.has('seed-receipts'); wait += 1) {
            await new Promise(resolve => setTimeout(resolve, 500))
          }
          if (!mountedOrgans.has('seed-receipts')) return recovered
          const persistenceReady = persistence.durable
            && !persistence.readOnly
            && persistence.conflict === null
            && persistence.mirror.conflict === null
            && !persistence.mirror.reconciliationRequired
            && (persistence.mirror.target === null || persistence.mirror.transient === null)
          if (!persistenceReady) return recovered

          const chainVerify = await organsService.call('seed-receipts', { action: 'verify' }).catch(() => null) as { ok?: boolean } | null
          if (chainVerify?.ok !== true) return recovered

          let cloudTotalReceipts: number | null = null
          let lastPublishOutcome: {
            ok?: boolean
            resultingBallId?: string | null
            resultingEpoch?: number | null
            expectedParentBallId?: string | null
            hasApprovalToken?: boolean
          } | null = null
          if (origin && origin !== 'null' && !origin.endsWith('.invalid')) {
            const [factsRes, promoRes] = await Promise.all([
              fetch(new URL('/__x6/facts', origin).href, { credentials: 'same-origin', cache: 'no-store' }).catch(() => null),
              fetch(new URL('/_head/promotion-status', origin).href, { credentials: 'same-origin', cache: 'no-store' }).catch(() => null),
            ])
            if (factsRes && factsRes.ok) {
              const factsJson = await factsRes.json().catch(() => null) as { receiptTotal?: unknown } | null
              if (typeof factsJson?.receiptTotal === 'number' && Number.isSafeInteger(factsJson.receiptTotal)) {
                cloudTotalReceipts = factsJson.receiptTotal
              }
            }
            if (promoRes && promoRes.ok) {
              const promoJson = await promoRes.json().catch(() => null) as { lastPublishOutcome?: unknown } | null
              if (record(promoJson?.lastPublishOutcome)) {
                lastPublishOutcome = promoJson.lastPublishOutcome as {
                  ok?: boolean
                  resultingBallId?: string | null
                  resultingEpoch?: number | null
                  expectedParentBallId?: string | null
                  hasApprovalToken?: boolean
                }
              }
            }
          }

          const receiptsPath = '/dsh/home/auma/seed/receipts.v3.jsonl'
          const rawText = readTextSafe(receiptsPath)
          const planned = planIdempotentRetroReceipts({
            currentBall,
            existingReceiptsText: rawText,
            persistenceReady,
            chainVerified: true,
            cloudTotalReceipts,
            lastPublishOutcome,
            context: createTransitionContext('head.adopt'),
            ...(changedEntriesHint ? { changedEntriesHint } : {}),
          })
          for (const candidate of planned) {
            const appended = await appendPromotionReceiptOnce({
              kind: 'head.promote',
              epoch: candidate.epoch,
              ballId: candidate.ballId,
              data: candidate.data,
            })
            if (appended.ok && !appended.deduplicated) {
              recovered.push(candidate.label)
            }
          }
          if (recovered.length > 0) await persistence.flush().catch(() => {})
        } catch {}
        return recovered
      })().finally(() => {
        retroReceiptsInFlight = null
      })
      return retroReceiptsInFlight
    }
    lateOps.ensureRetroPromotionReceipts = ensureRetroPromotionReceipts

    const syncHeadToGithub = async (): Promise<Record<string, unknown>> => {
      if (!origin || origin === 'null') return { ok: false, code: 'ORIGIN_UNAVAILABLE' }
      const recoveredReceipts = await ensureRetroPromotionReceipts()
      const handoffMarkdown = readHandoffSafe()
      const res = await fetch(new URL('/_host/repo', origin).href, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'sync_head_to_github',
          ownerSession: true,
          ...(handoffMarkdown ? { handoffMarkdown } : {}),
        }),
      })
      const json = await res.json() as Record<string, unknown>
      return { ...json, recoveredReceipts }
    }

    const executeReadModules = (hashesArg?: unknown, includeCodeArg?: unknown): Record<string, unknown> => {
      const requested = Array.isArray(hashesArg) ? hashesArg.map(String) : Object.keys(currentBall.modules ?? {})
      const includeCode = includeCodeArg !== false
      const modulesOut: Record<string, { sha256: string; bytes: number; verified: boolean; code?: string }> = {}
      const missing: string[] = []
      let totalBytes = 0
      for (const sha of requested) {
        if (!/^[a-f0-9]{64}$/.test(sha)) {
          missing.push(sha)
          continue
        }
        const p1 = join(BALLS_DIR, `${sha}.js`)
        const p2 = `/dsh/home/organs/${sha}.js`
        const p = vfs.existsSync(p1) ? p1 : (vfs.existsSync(p2) ? p2 : null)
        if (!p) {
          missing.push(sha)
          continue
        }
        const code = vfs.readFileSync(p, 'utf8') as string
        const verified = sha256HexSync(code) === sha
        if (!verified) {
          missing.push(sha)
          continue
        }
        const byteLength = new TextEncoder().encode(code).byteLength
        totalBytes += byteLength
        modulesOut[sha] = {
          sha256: sha,
          bytes: byteLength,
          verified: true,
          ...(includeCode ? { code } : {}),
        }
      }
      return {
        ok: missing.length === 0,
        requestedCount: requested.length,
        foundCount: Object.keys(modulesOut).length,
        missing,
        totalBytes,
        modules: modulesOut,
      }
    }

    const executeHeadRollback = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (!origin || origin === 'null') return { ok: false, code: 'ORIGIN_UNAVAILABLE' }
      // As for promote_staged: a rollback built on a head the edge no longer has is said, never hot-swapped around.
      const published = await checkPublishedHead()
      if (args.dryRun !== true && published.headLag?.newer === true) {
        return { ok: false, code: 'HEAD_RELOAD_REQUIRED', say: published.headLag.say, headLag: published.headLag }
      }
      const targetRef = typeof args.to === 'string' && args.to.trim()
        ? args.to.trim()
        : (typeof args.base === 'string' && args.base.trim() ? args.base.trim() : '')
      if (!targetRef) return { ok: false, code: 'ROLLBACK_TARGET_REQUIRED', hint: 'Pass `to: "<ballId-or-prefix>"`.' }
      let targetManifest: BallManifest | null = null
      if (vfs.existsSync(HISTORY_DIR)) {
        for (const name of vfs.readdirSync(HISTORY_DIR).map(String).filter(n => n.endsWith('.json'))) {
          const id = name.replace(/\.json$/, '')
          if (id === targetRef || id.startsWith(targetRef)) {
            try {
              targetManifest = JSON.parse(vfs.readFileSync(join(HISTORY_DIR, name), 'utf8') as string) as BallManifest
              break
            } catch {}
          }
        }
      }
      if (!targetManifest && vfs.existsSync(SNAPSHOTS_DIR)) {
        for (const name of vfs.readdirSync(SNAPSHOTS_DIR).map(String).filter(n => n.endsWith('.json'))) {
          try {
            const snap = JSON.parse(vfs.readFileSync(join(SNAPSHOTS_DIR, name), 'utf8') as string) as { ball?: BallManifest }
            if (snap?.ball && (snap.ball.ballId === targetRef || snap.ball.ballId.startsWith(targetRef))) {
              targetManifest = snap.ball
              break
            }
          } catch {}
        }
      }
      if (!targetManifest) {
        return { ok: false, code: 'ROLLBACK_TARGET_NOT_FOUND', to: targetRef }
      }
      const diffIds = Object.keys(currentBall.entries).filter(
        id => currentBall.entries[id]?.specifier !== targetManifest?.entries?.[id]?.specifier,
      )
      const targetEntryId = typeof args.entryId === 'string' && args.entryId.trim()
        ? args.entryId.trim()
        : (diffIds[0] ?? null)
      if (!targetEntryId || !targetManifest.entries[targetEntryId]) {
        return {
          ok: false,
          code: diffIds.length === 0 ? 'ALREADY_AT_TARGET_STATE' : 'ROLLBACK_ENTRY_NOT_FOUND',
          to: targetManifest.ballId,
          diffIds,
        }
      }
      const nextEntries = JSON.parse(JSON.stringify(currentBall.entries)) as Record<string, BallEntryRecord>
      const restoredEntry = JSON.parse(JSON.stringify(targetManifest.entries[targetEntryId])) as BallEntryRecord
      nextEntries[targetEntryId] = {
        ...restoredEntry,
        updatedAt: Date.now(),
      }
      const nextModules = {
        ...(JSON.parse(JSON.stringify(currentBall.modules)) as Record<string, BallModuleMeta>),
        ...(JSON.parse(JSON.stringify(targetManifest.modules ?? {})) as Record<string, BallModuleMeta>),
      }
      const rollbackBall = {
        version: 'x6.1-ball/v1' as const,
        ballId: '',
        parentBallId: currentBall.ballId,
        epoch: currentBall.epoch + 1,
        createdAt: Date.now(),
        authorPeerId: peerId,
        entries: nextEntries,
        modules: nextModules,
      }
      rollbackBall.ballId = computeCanonicalBallId(rollbackBall)
      if (args.dryRun === true) {
        return {
          ok: true,
          dryRun: true,
          committed: false,
          action: 'head_rollback',
          targetBallId: targetManifest.ballId,
          targetEpoch: targetManifest.epoch,
          restoredEntryId: targetEntryId,
          restoredSpecifier: nextEntries[targetEntryId].specifier,
          resultingBallId: rollbackBall.ballId,
          resultingEpoch: rollbackBall.epoch,
          remainingDiffIds: diffIds.filter(id => id !== targetEntryId),
        }
      }
      const rollbackStagePath = '/dsh/home/auma/staged/head-promotion.rollback.json'
      const codeBySha = collectCodeBySha(rollbackBall)
      vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
      vfs.writeFileSync(rollbackStagePath, JSON.stringify({
        schema: 'aukora.staged-head-promotion.v1',
        stagedAt: Date.now(),
        body: {
          ball: rollbackBall,
          codeBySha,
          expectedParentBallId: currentBall.ballId,
          expectedEpoch: currentBall.epoch,
        },
      }, null, 2) + '\n')
      return await executePromoteStaged(rollbackStagePath, { allowRebase: true })
    }

    // Only a committed transcript acknowledgement binds a parent to the calling agent.
    type ConsultTurn = { turnId: string; generation: number; lifetime: AbortController }
    let consultTurns = new WeakMap<object, ConsultTurn>()
    // Lane E5: one in-flight parent acquisition per agent, so parallel consult/swarm calls in a turn share one turn_start.
    let consultStarts = new WeakMap<object, Promise<ConsultTurn | null>>()
    // Lane E6: leases this runtime acquired itself (never a caller-supplied x6_transcript turn). `refs` counts consults
    // and swarms running under the lease; the last one to finish normally settles it with one turn_complete.
    type ConsultLease = { agent: object; exec: unknown; refs: number; settled: boolean; release: () => void; signal: AbortSignal }
    let consultLeases = new WeakMap<ConsultTurn, ConsultLease>()
    const consultLifetime = new AbortController()
    hostCtx.effect?.(() => () => {
      consultLifetime.abort(); consultTurns = new WeakMap(); consultStarts = new WeakMap(); consultLeases = new WeakMap()
    })
    const liveConsultTurn = (agent: object): ConsultTurn | null => {
      const turn = consultTurns.get(agent)
      return turn && !turn.lifetime.signal.aborted ? turn : null
    }
    /**
     * Lane E5: the parent turn a consult or swarm runs under. A live acknowledged turn for this agent is reused; otherwise
     * one `turn_start` is committed on `/_head/transcript` (coalesced per agent) and bound only if HEAD acknowledges it
     * through the same checks as a manual `x6_transcript` start. Ending the caller's turn (`exec.signal`) aborts the
     * acquired turn and abandons it on HEAD (best effort). Missing agent or signal, an aborted signal, or a refused start
     * fails closed with `null` (`CONSULT_PARENT_TURN_REQUIRED`).
     */
    type ConsultContext = { parentTurnId: string; signal: AbortSignal; settle: () => void }
    const ensureConsultContext = async (exec: unknown): Promise<ConsultContext | null> => {
      if (!record(exec) || !record(exec.agent) || !(exec.signal instanceof AbortSignal)) return null
      if (exec.signal.aborted || consultLifetime.signal.aborted) return null
      const agent = exec.agent, signal = exec.signal
      let turn = liveConsultTurn(agent)
      if (!turn) {
        let pending = consultStarts.get(agent)
        if (!pending) {
          const starts = consultStarts
          pending = (async (): Promise<ConsultTurn | null> => {
            const turnId = `chat-${randomUUID()}`
            try {
              const result = await executeTranscriptOp({ subAction: 'turn_start', turn_id: turnId }, exec)
              const bound = liveConsultTurn(agent)
              if (result.ok !== true || !bound || bound.turnId !== turnId) return null
              // The acquired turn is a consult parent, not a foreground stream: tool executions already count as running.
              activeTurns.delete(turnId)
              const release = (): void => {
                bound.lifetime.abort()
                if (consultTurns.get(agent) !== bound || consultLifetime.signal.aborted) return
                void executeTranscriptOp({ subAction: 'turn_abandon', turn_id: turnId }, exec).catch(() => undefined)
              }
              if (signal.aborted) { release(); return null }
              signal.addEventListener('abort', release, { once: true })
              consultLeases.set(bound, { agent, exec, refs: 0, settled: false, release, signal })
              return bound
            } catch (_error) {
              return null
            } finally {
              if (starts.get(agent) === pending) starts.delete(agent)
            }
          })()
          consultStarts.set(agent, pending)
        }
        turn = await pending
      }
      if (!turn || turn.lifetime.signal.aborted || signal.aborted || consultLifetime.signal.aborted) return null
      const lease = consultLeases.get(turn)
      if (lease) {
        if (lease.settled) return null
        lease.refs += 1
      }
      const bound = turn
      let done = false
      return { parentTurnId: turn.turnId, signal: AbortSignal.any([signal, turn.lifetime.signal, consultLifetime.signal]),
        settle: () => { if (done) return; done = true; if (lease) settleConsultLease(bound, lease) } }
    }
    /**
     * Lane E6: normal-path settlement. When the last consult/swarm under an auto-acquired lease finishes and nothing
     * aborted it, the lease is evicted from `consultTurns` and HEAD gets one best-effort `turn_complete`. An aborted lease
     * is left to the `turn_abandon` path; a settlement failure never changes the consult result; settles at most once.
     */
    const settleConsultLease = (turn: ConsultTurn, lease: ConsultLease): void => {
      lease.refs = Math.max(0, lease.refs - 1)
      if (lease.refs > 0 || lease.settled) return
      if (turn.lifetime.signal.aborted || lease.signal.aborted || consultLifetime.signal.aborted) return
      lease.settled = true
      lease.signal.removeEventListener('abort', lease.release)
      turn.lifetime.abort()
      if (consultTurns.get(lease.agent) === turn) consultTurns.delete(lease.agent)
      activeTurns.delete(turn.turnId)
      // No exec: a completion acknowledgement must not rebind a lease to the agent.
      try {
        void executeTranscriptOp({ subAction: 'turn_complete', turn_id: turn.turnId }).catch(() => undefined)
      } catch { /* best effort */ }
    }
    const executeTranscriptOp = async (args: Record<string, unknown>, exec?: unknown): Promise<Record<string, unknown>> => {
      if (!origin || origin === 'null') return { ok: false, code: 'ORIGIN_UNAVAILABLE' }
      const subAction = typeof args.subAction === 'string' ? args.subAction : (typeof args.role === 'string' && args.content !== undefined ? 'append' : 'read')
      const bodyPayload = {
        ...args,
        action: subAction,
        tab_id: typeof args.tab_id === 'string' ? args.tab_id : peerId,
      }
      const res = await fetch(new URL('/_head/transcript', origin).href, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      })
      const result = await res.json() as Record<string, unknown>
      if (res.ok && result.ok === true && record(result.turn) && typeof result.turn.turn_id === 'string') {
        if (subAction === 'turn_start' && result.turn.status === 'running') activeTurns.set(result.turn.turn_id, Date.now())
        else if (subAction === 'turn_complete' || subAction === 'turn_abandon') activeTurns.delete(result.turn.turn_id)
      }
      if (res.ok && result.ok === true && result.replayed !== true && record(exec) && record(exec.agent)
        && exec.signal instanceof AbortSignal && record(result.turn) && result.turn.tab_id === bodyPayload.tab_id
        && typeof result.turn.turn_id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(result.turn.turn_id)
        && (args.turn_id === undefined || args.turn_id === result.turn.turn_id)
        && typeof result.turn.generation === 'number' && Number.isSafeInteger(result.turn.generation) && result.turn.generation > 0) {
        const previous = consultTurns.get(exec.agent)
        if ((subAction === 'turn_start' || subAction === 'turn_complete' || subAction === 'turn_abandon')
          && (!previous || result.turn.generation > previous.generation
            || (subAction !== 'turn_start' && result.turn.turn_id === previous.turnId && result.turn.generation === previous.generation))) {
          previous?.lifetime.abort()
          const lifetime = new AbortController()
          if (subAction !== 'turn_start' || result.turn.status !== 'running' || exec.signal.aborted) lifetime.abort()
          consultTurns.set(exec.agent, { turnId: result.turn.turn_id, generation: result.turn.generation, lifetime })
        }
      }
      return result
    }

    const stagedRepoWrites = new Map<string, { baseSha: string | undefined; files: Map<string, string> }>()
    const retainRepoDraft = (branch: string, path: string, content: string, baseSha?: string): void => {
      const previous = stagedRepoWrites.get(branch)
      if (previous?.baseSha !== undefined && previous.baseSha !== baseSha) throw new Error('REPO_DRAFT_BASE_CHANGED: preserve needed content, use draft_discard, then reread the branch before restaging')
      const files = new Map(previous?.files)
      files.set(path, content)
      const encoder = new TextEncoder(), privateBranch = repoSandboxBranch(branch)
      const lengths = [...files].map(([name, text]) => ({
        path: encoder.encode(name).byteLength, content: encoder.encode(text).byteLength,
      }))
      const bytes = lengths.reduce((total, file) => total + file.content, 0)
      if (files.size > 16 || lengths.some(file => file.path > 1024 || file.content > (privateBranch ? REPO_SOURCE_FILE_BYTES : 64 * 1024))
        || bytes > (privateBranch ? REPO_PRIVATE_COMMIT_BYTES : 128 * 1024)
        || (!previous && stagedRepoWrites.size >= 8)) throw new Error('REPO_DRAFT_LIMIT_EXCEEDED')
      stagedRepoWrites.set(branch, { baseSha, files })
    }
    registerBuiltin({
      name: 'x6_capability_index',
      description: 'Read-only resident index of your own capabilities (auma-cortex Tier A): registered tools with readOnly/mutating '
        + 'flags and parameter summaries, mounted organs with SHA-256 and byte sizes, the live epoch and ballId, and a SHA-256 digest. '
        + 'Recomputed on every promotion, zero I/O, voiceAuthority none. `lookup` with an exact `name` answers NO_SUCH_SURFACE for '
        + 'anything not mounted. It can only read; it stages, promotes or approves nothing.',
      parameters: {
        action: { type: 'string', enum: ['snapshot', 'lookup'], description: '`snapshot` (default) or `lookup` one exact tool or organ name.' },
        name: { type: 'string', description: 'Exact tool or organ name for `lookup`.' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>) {
        return args.action === 'lookup' ? capabilityIndex.lookup(args.name) : capabilityIndex.read()
      },
    })
    registerBuiltin({
      name: 'x6_browser_estate',
      description: 'Read-only inventory of this browser\'s own estate, no GitHub or Mac needed: MemoryVfs tree with sizes and SHA-256 under /dsh/home/auma (and workspaces), session index and bounded transcript search over /dsh/home/sessions (legacy dirs included), IndexedDB persistence queue/tombstones/conflicts, Cordis fibers/organs/services/tools, Wasm pins and memory limits, receipt chain and checkpoint summary. /dsh/home/auma/private/** is reported by existence and size only. Output is bounded; page with cursor/limit.',
      parameters: {
        sections: { type: 'json', description: 'Subset of ["vfs","sessions","search","persistence","cordis","wasm","receipts"]; default all except search.' },
        cursor: { type: 'number', description: 'VFS page offset (default 0).' },
        limit: { type: 'number', description: 'VFS page size, 1..1000 (default 200).' },
        root: { type: 'string', description: 'VFS root under /dsh/home/auma (default /dsh/home/auma).' },
        query: { type: 'string', description: 'Literal, case-insensitive transcript search (enables the search section), at most 128 characters.' },
        maxHits: { type: 'number', description: 'Search hits, 1..100 (default 20).' },
        perFileHashBytes: { type: 'number', description: 'Largest file hashed, up to 8 MiB (default 1 MiB).' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>) {
        return await inspectBrowserEstate(vfs, args, {
          persistence: () => ({ durable: persistence.durable, readOnly: persistence.readOnly, conflict: persistence.conflict,
            localSave: persistence.localSave, mirror: persistence.mirror }),
          persistenceInspect: limit => persistence.inspect(limit),
          cordis: (): EstateCordisView => {
            let registeredTools: string[] = []
            try {
              registeredTools = (hostCtx.tools?.definitions?.() ?? []).map(definition => definition.name).slice(0, 400)
            } catch { registeredTools = [] }
            let services: string[] = []
            try { services = Object.keys(getX6Services()).sort() } catch { services = [] }
            return {
              activeFibers: [...activeFibers].map(([id, active]) => ({ id, specifier: active.specifier,
                uid: typeof active.fiber.uid === 'number' ? active.fiber.uid : null })),
              fiberHealth: computeFiberHealth(),
              mountedOrgans: organsService.list().map(organ => ({ name: organ.name, sha256: organ.sha256, updatedAt: organ.updatedAt })),
              registeredTools, services,
              head: { ballId: currentBall.ballId, epoch: currentBall.epoch, entries: Object.keys(currentBall.entries).length,
                modules: Object.keys(currentBall.modules).length },
            }
          },
        })
      },
    })

    registerBuiltin({
      name: 'x6_repo',
      description:
        'Your own repository and edge HEAD control plane. On the Cloudflare edge it is GitHub-backed: '
        + '`selftest` returns your live state in one answer (build, HEAD, mirror, AUMLOK, which provider doors and brokers are configured), '
        + '`diagnostics` returns the bounded 100-event ring buffer across Worker, HEAD, and MIRROR, '
        + '`promotion_status` inspects staged head promotions, `stagedRepoProposal`, live edge HEAD lease and publish/merge outcomes, '
        + '`promote_staged` promotes a staged head promotion (`/dsh/home/auma/staged/head-promotion.json` or `path`) directly to edge HEAD under an active owner session and adopts it locally, '
        + '`transcript` reads or appends to the DO-resident cross-browser continuity transcript, turn lease, and idempotent tool-call table (`/_head/transcript`), '
        + '`tree` lists repository files (optionally under a directory `prefix`), `read` reads one file (`path`, with optional `offset` and `length` for ranged reads), '
        + '`search` finds at most 200 bounded source lines and reports truncated/filesScanned; regex supports only literals, character classes, dot and anchors, without repetition, alternation or groups. '
        + '`compare_files` compares two files of at most 256 KiB each from auto, mirror or GitHub sources. '
        + '`bytes` inspects a bounded byte slice, hex, and whole-file SHA-256 of `path`, '
        + '`state_diff` compares HEAD and MIRROR state against an optional `base` snapshot or ballId, '
        + '`diff` and `log` read history; `write` stages or writes a source file, `edit` replaces an exact unique `oldString` with `newString` in `path`, and `commit` commits explicit or staged changes. '
        + '`branch_create`/`branch_delete` and branch-scoped `read`/`write`/`edit`/`commit`/`diff` use auma/sandbox/<slug> or auma/proposal/<slug> under the owner session without a passkey. '
        + 'Private branches permit T2 source fixes but never .github files or secrets. Drafts are isolated by branch and base SHA; main T2 writes still require owner approval. '
        + 'A write, edit or commit of yours on main that touches a deployed path is refused with `REPO_PROPOSAL_REQUIRED` and a `next` field: that answer reaches you unchanged and stages no Touch ID card; '
        + 'do what `next` says (put the change on an auma/proposal/<slug> branch, then `stage_proposal`). '
        + 'Private files are limited to 512 KiB UTF-8 each; a commit or retained branch draft holds at most 16 files and 1 MiB of content, across at most eight retained branch drafts. JSON requests allow 6 MiB plus 32 KiB for escaping and metadata. '
        + '`draft_discard` requires an explicit private auma branch and removes only its local pending content (optionally one path), never remote files or branches; main drafts cannot be discarded here. Use it after preserving needed content when a draft base becomes stale, then reread before restaging. '
        + '`stage_proposal` prepares the exact merge for the owner’s Sovereignty card; `merge_proposal` cannot execute here and requires that card’s Touch ID. Never supply approval tokens or credentials. '
        + '`dispatch_workflow` triggers `.github/workflows/deploy-x61.yml`.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: [
            'selftest', 'diagnostics', 'promotion_status', 'promote_staged',
            'sync_head_to_github', 'head_rollback', 'modules', 'clear_staged_outward',
            'transcript', 'tree', 'status', 'diff', 'state_diff', 'log', 'read', 'bytes', 'search', 'compare_files',
            'branch_create', 'branch_delete', 'stage_proposal', 'merge_proposal', 'draft_discard',
            'write', 'edit', 'commit', 'push', 'dispatch_workflow', 'exec',
          ],
          description: 'Repository or edge HEAD operation.',
        },
        path: {
          type: 'string',
          description: 'Repository-relative file path or VFS staged file path.',
        },
        dryRun: {
          type: 'boolean',
          description: 'When true, returns plan or T2 refusal without committing or staging outward-class3.json.',
        },
        allowRebase: {
          type: 'boolean',
          description: 'When true on promote_staged, permits rebasing onto current HEAD and records old->new parent/ballId.',
        },
        to: { type: 'string', description: 'Target ballId (or prefix) for action="head_rollback".' },
        entryId: { type: 'string', description: 'Optional organ entry ID for action="head_rollback".' },
        hashes: { type: 'json', description: 'Array of 64-hex SHA-256 module hashes for action="modules".' },
        includeCode: { type: 'boolean', description: 'Whether to include module source text in action="modules" (default true).' },
        subAction: { type: 'string', description: 'Sub-action when action="transcript" (`read`, `append`, `turn_start`, `turn_heartbeat`, `turn_complete`, `turn_abandon`, `call_dispatch`, `call_complete`).' },
        role: { type: 'string', description: 'Transcript role when action="transcript" and subAction="append" (`user`, `assistant`, `tool`, `system`).' },
        turn_id: { type: 'string', description: 'Turn ID for action="transcript".' },
        call_id: { type: 'string', description: 'Tool call ID for action="transcript" (`call_dispatch` / `call_complete`).' },
        takeover: { type: 'boolean', description: 'When true on `turn_start`, records a receipted takeover of an active turn.' },
        prefix: { type: 'string', description: 'Optional repository-relative directory for tree or search (e.g. "deploy/cloudflare/src").' },
        branch: { type: 'string', description: 'main or auma/(sandbox|proposal)/<slug>. draft_discard requires an explicit private branch, never main. Private slugs use 2..61 lowercase letters, digits, dots, underscores or hyphens and start with a letter or digit.' },
        fromSha: { type: 'string', description: 'Optional 40-hex starting commit for branch_create; defaults to main HEAD.' },
        query: { type: 'string', description: 'Source text or a bounded regex using literals, character classes, dot and anchors for search.' },
        regex: { type: 'boolean', description: 'Use the bounded regex subset (default false); repetition, alternation and groups are refused.' },
        caseSensitive: { type: 'boolean', description: 'Whether search is case-sensitive (default false).' },
        maxMatches: { type: 'number', description: 'Maximum search matches, 1..200.' },
        leftPath: { type: 'string', description: 'Left file for compare_files.' },
        rightPath: { type: 'string', description: 'Right file for compare_files.' },
        leftSource: { type: 'string', enum: ['auto', 'mirror', 'github'], description: 'Left source for compare_files (default auto).' },
        rightSource: { type: 'string', enum: ['auto', 'mirror', 'github'], description: 'Right source for compare_files (default auto).' },
        ref: { type: 'string', description: 'Optional GitHub ref for compare_files.' },
        contextLines: { type: 'number', description: 'Number of surrounding lines in compare_files unified hunks.' },
        title: { type: 'string', description: 'Short plain-English title for stage_proposal.' },
        summary: { type: 'string', description: 'Optional summary for stage_proposal.' },
        baseSha: { type: 'string', description: 'Exact 40-hex main commit from the staged merge body; does not authorize merge_proposal.' },
        headSha: { type: 'string', description: 'Exact 40-hex branch commit from the staged merge body.' },
        treeSha: { type: 'string', description: 'Exact 40-hex branch tree from the staged merge body.' },
        expectedHeadSha: { type: 'string', description: 'Optional exact 40-hex private-branch base for write/edit/commit; retained drafts pin this automatically.' },
        offset: { type: 'number', description: 'Zero-based offset (for action="bytes" or ranged action="read", default 0).' },
        length: { type: 'number', description: 'Slice length (for action="bytes" 1..4096, or ranged action="read" 1..524288).' },
        base: { type: 'json', description: 'Base commit SHA (for action="diff") or optional ballId / { head?, mirror? } baseline (for action="state_diff").' },
        ids: { type: 'json', description: 'Optional array of entry IDs to filter `state_diff` results (e.g. ["seed-receipts", "seed-aura"]).' },
        limit: { type: 'number', description: 'Commit count (for action="log", 1..10, default 10) or row limit (for action="transcript").' },
        content: { type: 'string', description: 'File content to write (private-branch files at most 512 KiB UTF-8) or transcript text (for action="transcript").' },
        oldString: { type: 'string', description: 'Exact existing string to replace (must occur uniquely in the target file, for action="edit").' },
        newString: { type: 'string', description: 'Replacement string (for action="edit").' },
        message: { type: 'string', description: 'Commit message (for action="commit" or single-step action="write"/"edit").' },
        changes: { type: 'json', description: 'Optional array of `{ path, content }` changes for `commit` (uses files staged by `write`/`edit` if omitted). Private commits permit at most 16 files, 512 KiB per file and 1 MiB total UTF-8 content.' },
        workflow: { type: 'string', description: 'Workflow filename for `dispatch_workflow` (default "deploy-x61.yml").' },
        paths: { type: 'json', description: 'Optional path array for commit.' },
        command: { type: 'string', description: 'Shell command to run in the repository root (for action="exec").' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>, exec?: unknown) {
        if (!origin || origin === 'null') throw new Error('x6_repo requires a connected local host origin')
        refuseBrokerAuthorityInputs(args)
        // Lane E4: a proposal is staged only from auma/proposal/<slug>; sandbox branches and main never reach the card.
        if (args.action === 'stage_proposal' && !isAumaProposalBranch(args.branch)) {
          return { ok: false, code: 'REPO_PROPOSAL_BRANCH_REFUSED', sent: false,
            expected: 'auma/proposal/<slug> (lowercase; 2..61 characters of a-z 0-9 . _ -)',
            ...(typeof args.branch === 'string' && args.branch.startsWith('auma/sandbox/') ? { hint: 'Sandbox branches are private drafts; push the change to an auma/proposal/<slug> branch first.' } : {}) }
        }
        if (args.action === 'merge_proposal') {
          const fields = ['action', 'baseSha', 'branch', 'headSha', 'treeSha']
          if (Object.keys(args).length !== fields.length || Object.keys(args).some(key => !fields.includes(key))
            || !repoSandboxBranch(args.branch) || !['baseSha', 'headSha', 'treeSha'].every(key => /^[a-f0-9]{40}$/.test(actionText(args[key])))) {
            return { ok: false, code: 'REPO_PROPOSAL_INVALID', sent: false }
          }
          return { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', ownerCardRequired: true, sent: false,
            next: 'Use stage_proposal to prepare the proposal, then the owner approves its exact merge in Sovereignty with Touch ID. This tool cannot merge it.' }
        }
        enforceToolInvocation('x6_repo', args)
        if (args.action === 'draft_discard') {
          const branch = args.branch
          if (!repoSandboxBranch(branch)
            || Object.keys(args).some(key => !['action', 'branch', 'path'].includes(key))
            || (args.path !== undefined && (typeof args.path !== 'string' || args.path.length > 1024))) throw new Error('REPO_DRAFT_DISCARD_INVALID')
          const draft = stagedRepoWrites.get(branch)
          const discardedFiles = typeof args.path === 'string' ? Number(draft?.files.delete(args.path) ?? false) : draft?.files.size ?? 0
          if (args.path === undefined || draft?.files.size === 0) stagedRepoWrites.delete(branch)
          return { ok: true, action: 'draft_discard', branch, scope: 'caller', discardedFiles, remoteChanged: false }
        }
        if (args.action === 'promotion_status') return await inspectStagedPromotions()
        if (args.action === 'sync_head_to_github') return await syncHeadToGithub()
        if (args.action === 'promote_staged') {
          return await executePromoteStaged(args.path, {
            dryRun: args.dryRun === true,
            allowRebase: args.allowRebase === true,
          })
        }
        if (args.action === 'modules') return executeReadModules(args.hashes, args.includeCode)
        if (args.action === 'head_rollback') return await executeHeadRollback(args)
        if (args.action === 'clear_staged_outward') {
          try {
            if (vfs.existsSync(STAGED_OUTWARD_PATH)) vfs.unlinkSync(STAGED_OUTWARD_PATH)
          } catch {}
          return { ok: true, cleared: true, path: STAGED_OUTWARD_PATH }
        }
        if (args.action === 'transcript') return await executeTranscriptOp(args, exec)
        const filterIds = Array.isArray(args.ids) ? args.ids.map(String) : null
        const localOnlyKeys = new Set(['ids', 'allowRebase', 'to', 'entryId', 'hashes', 'includeCode'])
        const payload: Record<string, unknown> = Object.fromEntries(
          Object.entries(args).filter(
            ([key, value]) => value !== undefined && value !== null && !localOnlyKeys.has(key) && !(key === 'prefix' && value === ''),
          ),
        )
        if (args.action === 'state_diff' && payload.base === undefined) {
          const defaultBase = typeof currentBall.parentBallId === 'string' && /^[0-9a-f]{64}$/.test(currentBall.parentBallId)
            ? currentBall.parentBallId
            : (typeof currentBall.ballId === 'string' && /^[0-9a-f]{64}$/.test(currentBall.ballId) ? currentBall.ballId : undefined)
          if (defaultBase) payload.base = defaultBase
        }
        const isOwnerSessionMutator = (
          args.action === 'write'
          || args.action === 'edit'
          || args.action === 'commit'
          || args.action === 'dispatch_workflow'
          || args.action === 'branch_create'
          || args.action === 'branch_delete'
          || args.action === 'stage_proposal'
        ) && (args.expectedHeadSha === undefined || (repoSandboxBranch(args.branch) && ['write', 'edit', 'commit'].includes(actionText(args.action))))
          && args.idempotencyKey === undefined
        const branch = typeof args.branch === 'string' ? args.branch : 'main'
        const draft = stagedRepoWrites.get(branch)
        const localContent = typeof args.path === 'string' ? draft?.files.get(args.path) : undefined
        if (repoSandboxBranch(branch) && args.action === 'read' && localContent !== undefined) {
          const offset = args.offset === undefined ? 0 : args.offset
          const length = args.length
          if (!Number.isSafeInteger(offset) || Number(offset) < 0
            || (length !== undefined && (!Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > REPO_SOURCE_FILE_BYTES))) throw new Error('REPO_BYTE_RANGE_INVALID')
          const content = localContent.slice(Number(offset), length === undefined ? undefined : Number(offset) + Number(length))
          return { ok: true, path: args.path, branch, content, staged: true, scope: 'caller', source: 'caller-draft', baseSha: draft?.baseSha,
            ...(args.offset !== undefined || length !== undefined ? { offset, length: content.length,
              totalBytes: new TextEncoder().encode(localContent).byteLength, totalLength: localContent.length,
              nextOffset: Number(offset) + content.length < localContent.length ? Number(offset) + content.length : null,
              truncated: Number(offset) + content.length < localContent.length } : {}) }
        }
        if (isOwnerSessionMutator) {
          payload.ownerSession = true
          if (repoSandboxBranch(branch) && draft?.baseSha && ['write', 'edit', 'commit'].includes(actionText(args.action))) {
            if (payload.expectedHeadSha !== undefined && payload.expectedHeadSha !== draft.baseSha) throw new Error('REPO_DRAFT_BASE_CHANGED: preserve needed content, use draft_discard, then reread the branch before restaging')
            payload.expectedHeadSha = draft.baseSha
          }
          if (repoSandboxBranch(branch) && args.action === 'edit' && localContent !== undefined) {
            if (typeof args.oldString !== 'string' || !args.oldString) throw new Error('REPO_EDIT_TARGET_EMPTY')
            if (typeof args.newString !== 'string') throw new Error('REPO_EDIT_REPLACEMENT_INVALID')
            const at = localContent.indexOf(args.oldString)
            if (at < 0) throw new Error('REPO_EDIT_TARGET_NOT_FOUND')
            if (localContent.indexOf(args.oldString, at + args.oldString.length) >= 0) throw new Error('REPO_EDIT_TARGET_AMBIGUOUS')
            payload.action = 'write'
            payload.content = localContent.slice(0, at) + args.newString + localContent.slice(at + args.oldString.length)
            delete payload.oldString
            delete payload.newString
          }
          if (args.action === 'commit' && !Array.isArray(payload.changes) && draft) {
            payload.changes = [...draft.files].map(([path, content]) => ({ path, content }))
          }
        }
        const encoder = new TextEncoder()
        if (repoSandboxBranch(branch) && ['write', 'edit', 'commit'].includes(actionText(payload.action))) {
          for (const key of ['content', 'oldString', 'newString']) {
            const content = payload[key]
            if (typeof content === 'string' && encoder.encode(content).byteLength > REPO_SOURCE_FILE_BYTES) throw new Error('REPO_SOURCE_FILE_LIMIT_EXCEEDED')
          }
          if (Array.isArray(payload.changes)) {
            let bytes = 0
            if (payload.changes.length > 16) throw new Error('REPO_COMMIT_LIMIT_EXCEEDED')
            for (const change of payload.changes) {
              if (!record(change) || typeof change.content !== 'string') throw new Error('REPO_CHANGE_INVALID')
              const length = encoder.encode(change.content).byteLength
              if (length > REPO_SOURCE_FILE_BYTES) throw new Error('REPO_SOURCE_FILE_LIMIT_EXCEEDED')
              bytes += length
            }
            if (bytes > REPO_PRIVATE_COMMIT_BYTES) throw new Error('REPO_COMMIT_LIMIT_EXCEEDED')
          }
        }
        const requestBody = JSON.stringify(payload)
        if (encoder.encode(requestBody).byteLength > REPO_REQUEST_BYTES) throw new Error('REPO_REQUEST_LIMIT_EXCEEDED')
        const res = await fetch(new URL('/_host/repo', origin).href, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: requestBody,
          credentials: 'same-origin',
        })
        const json = await repoResponseJson(res)
        // A write of hers to main that touches a deployed path is refused by the edge with REPO_PROPOSAL_REQUIRED and a
        // `next`: it comes back to her exactly as sent and never becomes a Touch ID card (only a real Class 3 answer does).
        if (json.code === 'REPO_PROPOSAL_REQUIRED') return json
        if (res.status === 403 && record(json) && json.code === 'CLASS3_WEBAUTHN_REQUIRED') {
          if (repoSandboxBranch(branch) || args.action === 'stage_proposal') return { ...json, stagedForOwner: false }
          if (args.dryRun === true) {
            return {
              ...json,
              dryRun: true,
              stagedForOwner: false,
              note: 'Dry-run T2 refusal verified; outward-class3.json was not written.',
            }
          }
          return stageOutward('x6_repo', '/_host/repo', payload, json)
        }
        if (args.action === 'state_diff' && filterIds) {
          if (record(json.head) && record(json.head.entries) && Array.isArray(json.head.entries.changes)) {
            const rawChanges = json.head.entries.changes as Array<{ id?: string; status?: string }>
            const filteredChanges = rawChanges.filter(c => c && typeof c.id === 'string' && filterIds.includes(c.id))
            json.head = {
              ...json.head,
              entries: {
                ...json.head.entries,
                changes: filteredChanges,
                total: filteredChanges.length,
                filteredIds: filterIds,
              },
            }
          }
          if (Array.isArray(json.changed)) {
            json.changed = (json.changed as Array<{ id?: string }>).filter(c => c && typeof c.id === 'string' && filterIds.includes(c.id))
          }
          json.filteredIds = filterIds
        }
        if (isOwnerSessionMutator && res.ok && json?.ok === true && args.dryRun !== true) {
          if (['write', 'edit'].includes(actionText(args.action)) && args.message === undefined && typeof args.path === 'string') {
            const content = typeof json.content === 'string' ? json.content : args.action === 'write' ? args.content : undefined
            const baseSha = typeof json.baseSha === 'string' && /^[a-f0-9]{40}$/.test(json.baseSha) ? json.baseSha : undefined
            if (repoSandboxBranch(branch) && (!baseSha || json.staged !== true || json.scope !== 'caller')) throw new Error('REPO_DRAFT_ACK_INVALID')
            if (typeof content === 'string') retainRepoDraft(branch, args.path, content, repoSandboxBranch(branch) ? baseSha : undefined)
          }
          if (args.action === 'commit' || args.action === 'branch_delete'
            || ((args.action === 'write' || args.action === 'edit') && typeof args.message === 'string')) {
            if (!repoSandboxBranch(branch) || args.action === 'branch_delete') stagedRepoWrites.delete(branch)
            else {
              const current = stagedRepoWrites.get(branch)
              const committed = Array.isArray(payload.changes) ? payload.changes : [{ path: payload.path, content: payload.content }]
              for (const change of committed) {
                if (current && record(change) && typeof change.path === 'string'
                  && (current.files.get(change.path) === change.content
                    || current.files.get(change.path) === draft?.files.get(change.path))) current.files.delete(change.path)
              }
              if (current?.files.size === 0) stagedRepoWrites.delete(branch)
            }
          }
        }
        return json
      },
    })

    registerBuiltin({
      name: 'self_apply',
      description:
        'Cordis-native self-edit: accepts either `{ id, code, config }` (stores `code` via ball_put and hot-swaps '
        + '`id` in one transactional step) or `{ id, specifier, config }`. Rolls back automatically if activation throws.',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry ID in the Cordis ball tree.' },
        code: { type: 'string', description: 'Optional JS source code to compile into a ball:<sha256> and mount.' },
        specifier: { type: 'string', description: 'Optional existing ball:<sha256> specifier.' },
        config: { type: 'json', description: 'Optional plugin configuration object.' },
        qualificationId: { type: 'string', required: true, description: 'Required single-use Pearl admission for this exact source, head, executable suite and entry; expires after five minutes. This is not owner authorization.' },
        includeManifest: { type: 'boolean', description: 'When true, includes the full ball manifest in the result.' },
      },
      output: jsonOut,
      async execute(args: {
        id: string
        code?: string
        specifier?: string
        config?: Record<string, unknown>
        includeManifest?: boolean
        qualificationId?: string
      }) {
        let specifier = args.specifier
        if (typeof args.code === 'string' && args.code.trim().length > 0) {
          const meta = await ballPut({ code: args.code, name: args.id })
          specifier = meta.specifier
        }
        if (!specifier) throw new Error('self_apply requires either `code` or `specifier`')
        const patch = await treePatch({ id: args.id, specifier, config: args.config, qualificationId: args.qualificationId })
        return compactPatchResult(patch, args.includeManifest)
      },
    })

    registerBuiltin({
      name: 'self_undo',
      description:
        'LIFO revert of the last `self_apply` / `tree_patch` (or a specific entry `id`) across all open tabs.',
      parameters: {
        id: { type: 'string', description: 'Optional entry ID to revert.' },
      },
      output: jsonOut,
      async execute(args: { id?: string; expectedBallId?: string }) {
        return await treeUndo(args)
      },
    })

    registerBuiltin({
      name: 'auma_snapshot',
      description:
        'Snapshot First, Mutate Second: pure-VFS content-addressed checkpoint engine (`/dsh/home/auma/snapshots/<sha256>.json`). '
        + 'Captures and restores the full `HEAD.json` ball tree, `balls/*.js` modules, custom prompt sections, `cordis.patch.yml`, '
        + 'and `HANDOFF.md` with zero page reload. Actions: `create`, `list`, `restore`, `diff`, `sync` (await exact local mirror outbox acknowledgements).',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['create', 'list', 'restore', 'diff', 'sync'],
          description: 'Snapshot operation to perform.',
        },
        label: { type: 'string', description: 'Optional label when action="create".' },
        snapshotId: { type: 'string', description: 'Target snapshot SHA when action="restore" or "diff" (defaults to LATEST).' },
      },
      output: jsonOut,
      async execute(args: { action: string; label?: string; snapshotId?: string }) {
        const action = args.action || 'list'
        if (action === 'sync') return { ok: true, action, mirror: await snapshotsService.syncMirror() }
        if (action === 'create') {
          const snap = createSnapshot(args.label || 'manual')
          return {
            ok: true,
            action: 'create',
            snapshotId: snap.snapshotId,
            label: snap.label,
            createdAt: snap.createdAt,
            ballId: snap.ball.ballId,
            epoch: snap.ball.epoch,
            entriesCount: Object.keys(snap.ball.entries).length,
          }
        }
        if (action === 'list') {
          return { ok: true, action: 'list', snapshots: listSnapshots() }
        }
        if (action === 'restore') {
          return await restoreSnapshot(args.snapshotId)
        }
        if (action === 'diff') {
          const snapPath = args.snapshotId
            ? join(SNAPSHOTS_DIR, `${args.snapshotId.replace(/\.json$/, '')}.json`)
            : LATEST_SNAPSHOT_PATH
          if (!vfs.existsSync(snapPath)) {
            return { ok: false, error: `Snapshot not found: ${args.snapshotId ?? 'LATEST'}` }
          }
          const snap = JSON.parse(vfs.readFileSync(snapPath, 'utf8') as string) as AumaSnapshotRecord
          const curEntries = currentBall.entries
          const snapEntries = snap.ball.entries
          const addedEntries = Object.keys(curEntries).filter(k => !(k in snapEntries))
          const removedEntries = Object.keys(snapEntries).filter(k => !(k in curEntries))
          const changedEntries = Object.keys(curEntries).filter(
            k => k in snapEntries && curEntries[k]?.specifier !== snapEntries[k]?.specifier,
          )
          return {
            ok: true,
            action: 'diff',
            snapshotId: snap.snapshotId,
            label: snap.label,
            currentBallId: currentBall.ballId,
            snapshotBallId: snap.ball.ballId,
            addedEntries,
            removedEntries,
            changedEntries,
            promptSectionsChanged: JSON.stringify(promptSections) !== JSON.stringify(snap.promptSections),
            cordisPatchChanged: readTextSafe(CORDIS_PATCH_PATH) !== snap.cordisPatchYml,
          }
        }
        return { ok: false, error: `Unknown auma_snapshot action: ${String(action)}` }
      },
    })

    registerBuiltin({
      name: 'auma_alien_compose',
      description:
        'Alien Data-Plane Self-Composition: mutate your own live `ctx.systemPrompt.section` entries, '
        + '`ctx.configEditor` composition rows, and `/dsh/home/profiles/web/cordis.patch.yml` directly as data. '
        + 'Automatically runs `auma_snapshot` before any mutation. '
        + 'Actions: `status`, `prompt_list`, `prompt_set`, `prompt_remove`, `config_list`, `config_patch`, `preset_select`.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'prompt_list', 'prompt_set', 'prompt_remove', 'config_list', 'config_patch', 'preset_select'],
          description: 'Data-plane composition operation.',
        },
        name: { type: 'string', description: 'Prompt section name for `prompt_set` / `prompt_remove`.' },
        text: { type: 'string', description: 'Markdown text for `prompt_set`.' },
        order: { type: 'number', description: 'Section ordering priority for `prompt_set` (default 145).' },
        entryId: { type: 'string', description: 'Cordis entry ID for `config_patch`.' },
        config: { type: 'json', description: 'Config object for `config_patch`.' },
        disabled: { type: 'boolean', description: 'Optional disabled state for `config_patch`.' },
        applyNow: { type: 'boolean', description: 'Whether to call configEditor.apply() immediately on `config_patch`.' },
        presetId: { type: 'string', description: 'Preset ID for `preset_select` (e.g. "auma-alien", "cordis", "standard").' },
      },
      output: jsonOut,
      async execute(args: {
        action: string
        name?: string
        text?: string
        order?: number
        entryId?: string
        config?: unknown
        disabled?: boolean
        applyNow?: boolean
        presetId?: string
      }) {
        const cfgEditor = hostCtx.get('configEditor') as ConfigEditorServiceLike | undefined
        const presetsSvc = hostCtx.get('agentPresets') as AgentPresetsServiceLike | undefined
        const action = args.action || 'status'
        enforceToolInvocation('auma_alien_compose', { ...args, action })
        const sanitizeLossless = (val: unknown): unknown => {
          if (val === undefined) return null
          try {
            return JSON.parse(JSON.stringify(val))
          } catch {
            return String(val)
          }
        }

        if (action === 'status' || action === 'prompt_list') {
          return {
            ok: true,
            action,
            promptSections: sanitizeLossless(Object.values(promptSections)),
            presets: sanitizeLossless(presetsSvc?.list?.() ?? []),
            configEntriesCount: cfgEditor?.list?.().length ?? 0,
            cordisPatchYml: readTextSafe(CORDIS_PATCH_PATH),
          }
        }
        if (action === 'prompt_set') {
          const secName = String(args.name ?? '').trim()
          const secText = String(args.text ?? '')
          if (!secName) return { ok: false, error: 'prompt_set requires `name`' }
          createSnapshot(`pre-prompt_set:${secName}`)
          const rec: PromptSectionRecord = {
            name: secName,
            order: typeof args.order === 'number' ? args.order : 145,
            text: secText,
            updatedAt: Date.now(),
          }
          promptSections = { ...promptSections, [secName]: rec }
          vfs.writeFileSync(PROMPT_SECTIONS_PATH, JSON.stringify(promptSections, null, 2) + '\n')
          mountPromptSection(rec)
          return { ok: true, action: 'prompt_set', section: rec, totalSections: Object.keys(promptSections).length }
        }
        if (action === 'prompt_remove') {
          const secName = String(args.name ?? '').trim()
          if (!secName) return { ok: false, error: 'prompt_remove requires `name`' }
          createSnapshot(`pre-prompt_remove:${secName}`)
          const disp = activePromptDisposers.get(secName)
          if (disp) {
            try { disp() } catch {}
            activePromptDisposers.delete(secName)
          }
          promptSections = Object.fromEntries(Object.entries(promptSections).filter(([k]) => k !== secName))
          vfs.writeFileSync(PROMPT_SECTIONS_PATH, JSON.stringify(promptSections, null, 2) + '\n')
          return { ok: true, action: 'prompt_remove', removed: secName, totalSections: Object.keys(promptSections).length }
        }
        if (action === 'config_list') {
          return {
            ok: true,
            action: 'config_list',
            entries: sanitizeLossless(cfgEditor?.list?.() ?? []),
            cordisPatchYml: readTextSafe(CORDIS_PATCH_PATH),
          }
        }
        if (action === 'config_patch') {
          const entryId = String(args.entryId ?? '').trim()
          if (!entryId) return { ok: false, error: 'config_patch requires `entryId`' }
          createSnapshot(`pre-config_patch:${entryId}`)
          if (!cfgEditor || typeof cfgEditor.edit !== 'function') {
            return { ok: false, error: 'configEditor service is not mounted on root context' }
          }
          const updated = cfgEditor.edit(entryId, {
            ...(args.disabled !== undefined ? { disabled: args.disabled } : {}),
            ...(args.config !== undefined ? { config: args.config } : {}),
          })
          if (args.applyNow) {
            await cfgEditor.apply()
          }
          return { ok: true, action: 'config_patch', entryId, updated: sanitizeLossless(updated), applied: Boolean(args.applyNow) }
        }
        if (action === 'preset_select') {
          const presetId = String(args.presetId ?? 'auma-alien').trim()
          createSnapshot(`pre-preset_select:${presetId}`)
          const currentYml = readTextSafe(CORDIS_PATCH_PATH)
          const updatedYml = currentYml
            .replace(/selectedDefault:\s*\S+/g, `selectedDefault: ${presetId}`)
            .replace(/default:\s*\S+/g, `default: ${presetId}`)
          vfs.writeFileSync(CORDIS_PATCH_PATH, updatedYml)
          return { ok: true, action: 'preset_select', presetId }
        }
        return { ok: false, error: `Unknown auma_alien_compose action: ${String(action)}` }
      },
    })

    registerBuiltin({
      name: 'auma_handoff',
      description:
        'Read or update `/dsh/home/auma/HANDOFF.md` (your live cross-session and cross-preset state map, '
        + 'which is automatically injected into every session via `ctx.systemPrompt.context("auma:live-state-map")`). '
        + 'Actions: `read`, `write`, `append`.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['read', 'write', 'append'],
          description: 'Handoff operation.',
        },
        content: { type: 'string', description: 'Markdown content to write or append.' },
      },
      output: jsonOut,
      execute(args: { action: string; content?: string }) {
        const action = args.action || 'read'
        enforceToolInvocation('auma_handoff', { ...args, action })
        if (action === 'read') {
          return Promise.resolve({
            ok: true,
            path: HANDOFF_PATH,
            content: readHandoffSafe(),
          })
        }
        if (action === 'write') {
          const text = String(args.content ?? '')
          vfs.writeFileSync(HANDOFF_PATH, text)
          vfs.writeFileSync(AUMA_ONE_HANDOFF_PATH, text)
          vfs.writeFileSync(WORKSPACE_HANDOFF_PATH, text)
          return Promise.resolve({ ok: true, action: 'write', path: HANDOFF_PATH, bytes: text.length })
        }
        if (action === 'append') {
          const existing = readHandoffSafe()
          const addition = String(args.content ?? '')
          const next = `${existing.trimEnd()}\n\n${addition.trim()}\n`
          vfs.writeFileSync(HANDOFF_PATH, next)
          vfs.writeFileSync(AUMA_ONE_HANDOFF_PATH, next)
          vfs.writeFileSync(WORKSPACE_HANDOFF_PATH, next)
          return Promise.resolve({ ok: true, action: 'append', path: HANDOFF_PATH, bytes: next.length })
        }
        return Promise.resolve({ ok: false, error: `Unknown auma_handoff action: ${String(action)}` })
      },
    })

    registerBuiltin({
      name: 'x6_github',
      description:
        'Host-brokered GitHub access to this repository (your_org_x/your-node) without exposing tokens to the browser worker. '
        + '`status`; `api` with GET (no body) reads this repository (commits, contents, compare, trees, issues, pulls, runs, as the host '
        + 'serves them), including actions/runs?branch=<branch>, actions/runs/<runId>/jobs, and actions/jobs/<jobId>/logs. Logs are secret-scrubbed, ANSI-free and tail-capped to 128 KiB. '
        + '`api` with POST may open an issue (`{ title, body }`) or comment on one (`endpoint: repos/your_org_x/your-node/'
        + 'issues/<n>/comments`, `{ body }`) when the text has no leading slash command and no @mention. On the edge each such post also '
        + 'needs the owner\'s passkey approval for its exact bytes: the answer is CLASS3_WEBAUTHN_REQUIRED with `stagedForOwner`, '
        + 'and the owner approves and sends it from Sovereignty with Touch ID (one staged at a time). Any other write, and '
        + '`cli`, needs the owner.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'cli', 'api'],
          description: 'GitHub operation to perform via the local host.',
        },
        args: {
          type: 'json',
          description: 'Array of CLI arguments for `gh` (e.g. ["repo", "view", "your_org_x/your-node", "--json", "name,defaultBranchRef"]).',
        },
        endpoint: {
          type: 'string',
          description: 'GitHub API endpoint for action="api" (e.g. "repos/your_org_x/your-node/commits/main").',
        },
        method: { type: 'string', description: 'HTTP method for action="api" (GET, POST, PATCH, PUT, DELETE).' },
        body: { type: 'json', description: 'Optional JSON body for action="api".' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>) {
        if (!origin || origin === 'null') throw new Error('x6_github requires a connected local host origin')
        refuseBrokerAuthorityInputs(args)
        enforceToolInvocation('x6_github', args)
        const res = await fetch(new URL('/_host/github', origin).href, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args),
          credentials: 'same-origin',
        })
        const answer: unknown = await res.json()
        // The edge posts an issue or a comment only with the owner's passkey on these exact bytes: stage them for him.
        return res.status === 403 && record(answer) && answer.code === 'CLASS3_WEBAUTHN_REQUIRED'
          ? stageOutward('x6_github', '/_host/github', args, answer) : answer
      },
    })

    registerBuiltin({
      name: 'x6_cloudflare',
      description:
        'Host-brokered Cloudflare power (`wrangler` CLI and Cloudflare edge management) without exposing raw tokens to the browser worker. '
        + 'Actions: `status` (`wrangler --version` + `whoami`), `wrangler` (run `wrangler <args>`).',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'versions', 'wrangler'],
          description: 'Cloudflare operation to perform (`status`, `versions`, or `wrangler`).',
        },
        remote: {
          type: 'boolean',
          description: 'When true on action="versions", query Cloudflare API for recent deployed versions.',
        },
        args: {
          type: 'json',
          description: 'Array of CLI arguments for `wrangler` (e.g. ["whoami"] or ["d1", "list"]).',
        },
        cwd: {
          type: 'string',
          description: 'Optional relative working directory inside the repository root.',
        },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>) {
        if (!origin || origin === 'null') throw new Error('x6_cloudflare requires a connected local host origin')
        enforceToolInvocation('x6_cloudflare', args)
        const res = await fetch(new URL('/_host/cloudflare', origin).href, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args),
          credentials: 'same-origin',
        })
        return await res.json()
      },
    })

    registerBuiltin({
      name: 'x6_consult',
      description:
        'Consult other minds from inside a turn, through the host\'s provider doors (keys and budget stay on the host). '
        + 'One target: `{ provider, model, prompt, system?, maxTokens?, timeoutMs? }`. A council in parallel: `{ targets: [{ provider, '
        + 'model, role? }], prompt, system?, ... }` (up to 6; each has its own time limit and one failing never stops the others). '
        + 'Providers: anthropic (e.g. claude-opus-5-5), openrouter (e.g. x-ai/grok-4.7, google/gemini-4-argon), deepseek, openai, xai, '
        + 'moonshot. `model` may instead be a name from the composer pill (Opus 5.5, Fable 5.2, Sonnet 5.5, Kimi K3.1, GPT-6.1 Sol, '
        + 'GPT Astra, Meta Muse, GLM 5.3, Gemini Argon, Grok 4.7, DeepSeek Flash), which picks the provider too. Returns each answer with its latency, or its refusal code (e.g. PROVIDER_SECRET_NOT_CONFIGURED). '
        + 'Answers are advice to weigh, never authority.',
      parameters: {
        provider: { type: 'string', description: 'One provider door (single target).' },
        model: { type: 'string', description: 'The model id at that provider (single target).' },
        targets: { type: 'json', description: 'Array of { provider, model, role? } for a parallel council (instead of provider/model).' },
        prompt: { type: 'string', required: true, description: 'What to ask (at most 64 KiB).' },
        system: { type: 'string', description: 'Optional system prompt (at most 16 KiB); a council role is appended per target.' },
        maxTokens: { type: 'number', description: 'Answer length cap per target (1..16384, default 2048).' },
        timeoutMs: { type: 'number', description: 'Time limit per target in ms (1000..120000, default 60000).' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>, exec?: unknown) {
        enforceToolInvocation('x6_consult', args)
        const context = await ensureConsultContext(exec)
        if (!context) return { ok: false, code: 'CONSULT_PARENT_TURN_REQUIRED' }
        try { return await consultProviders(args, { origin, parentTurnId: context.parentTurnId, signal: context.signal }) }
        finally { context.settle() }
      },
    })

    registerBuiltin({
      name: 'x6_cell',
      description:
        'Your Wasm cells: 25 pinned cells, 24 compiled from Rust and `aura-focus` built from WAT by the `skillsmith` cell (Microverse ABI v1), '
        + 'run here in your browser worker. Each has zero imports (no network, storage or host), is checked against its SHA-256 pin before it '
        + 'compiles, and runs every call on a fresh fuel grant. `list` names them and their ops; `compute` (or `run`) runs one op: '
        + '`{ action: "compute", cell, op, input }`. `compile_and_run` compiles WAT source text via the pinned `skillsmith` compiler cell '
        + '(`build` + `meter`), admits the metered Wasm under zero imports and <= 16 memory pages, and executes it on a bounded fuel grant '
        + '(`{ action: "compile_and_run", wat, name?, op?, input?, fuel? }`). Organs reach the same cells via `ctx.wasm`.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'compute', 'run', 'compile_and_run'],
          description: '`list` the cells and their ops, `compute`/`run` one op, or `compile_and_run` WAT via `skillsmith`.',
        },
        cell: { type: 'string', description: 'Cell name (for compute/run), e.g. seed-judge, gate-judge, grant-ledger, skillsmith.' },
        op: { type: 'string', description: 'The cell op (for compute/run/compile_and_run), e.g. "seed.merge", "gate.step", "run".' },
        input: { type: 'json', description: 'The op input object (integers only, no floats).' },
        wat: { type: 'string', description: 'WAT source text (for action="compile_and_run"; must declare `(memory (export "memory") min max)` with max <= 16, and export `"memory"`, `"mv_abi_version"`, `"mv_alloc"`, `"mv_run"` — aliases `"aukora_abi_version"`, `"aukora_alloc"`, `"aukora_call"` are automatically normalized).' },
        name: { type: 'string', description: 'Optional skill name for action="compile_and_run" (default "skill").' },
        fuel: { type: 'number', description: 'Optional fuel grant for action="compile_and_run" (1..10000000, default 1000000).' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>) {
        enforceToolInvocation('x6_cell', args)
        const cells = workerCellHost()
        if (args.action === 'list') return { ok: true, cells: cells.list() }
        if (args.action === 'compile_and_run') {
          return await cells.compileAndRun({
            wat: typeof args.wat === 'string' ? args.wat : '',
            ...(typeof args.name === 'string' ? { name: args.name } : {}),
            ...(typeof args.op === 'string' ? { op: args.op } : {}),
            ...(args.input !== undefined ? { input: args.input } : {}),
            ...(typeof args.fuel === 'number' ? { fuel: args.fuel } : {}),
          })
        }
        if (args.action !== 'compute' && args.action !== 'run') return { ok: false, code: 'CELL_ACTION_INVALID' }
        return await cells.invoke(String(args.cell ?? ''), String(args.op ?? ''), args.input === undefined ? {} : args.input)
      },
    })

    registerBuiltin({
      name: 'x6_web_eyes',
      description:
        'Host-brokered public HTTPS fetch and search (`/_host/web-eyes`). '
        + 'Actions: `fetch` (`url`, optional `maxLength`), `search` (`query`, optional `limit` 1..20), or `status`.',
      parameters: {
        action: { type: 'string', enum: ['fetch', 'search', 'status'], description: 'Operation (`fetch`, `search`, or `status`).' },
        url: { type: 'string', description: 'Public HTTPS URL to fetch (cannot be own host node.example.invalid).' },
        query: { type: 'string', description: 'Search query (for action="search").' },
        limit: { type: 'number', description: 'Max search results (1..20, default 8).' },
        maxLength: { type: 'number', description: 'Max characters to return on fetch.' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>) {
        if (!origin || origin === 'null') throw new Error('x6_web_eyes requires a connected host origin')
        const action = typeof args.action === 'string' ? args.action : (typeof args.url === 'string' ? 'fetch' : (typeof args.query === 'string' ? 'search' : 'status'))
        enforceToolInvocation('x6_web_eyes', { ...args, action })
        if (action === 'status') return { ok: true, tool: 'x6_web_eyes', endpoint: '/_host/web-eyes' }
        const payload = Object.fromEntries(Object.entries({ ...args, action }).filter(([, v]) => v !== undefined && v !== null))
        const res = await fetch(new URL('/_host/web-eyes', origin).href, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), credentials: 'same-origin',
        })
        return await res.json()
      },
    })

    registerBuiltin({
      name: 'x6_trusted_docs',
      description:
        'Fetch technical documentation from the four trusted HTTPS origins (`https://developer.mozilla.org`, `https://developers.cloudflare.com`, `https://api.github.com`, `https://registry.npmjs.org`) via `/_host/web-eyes`.',
      parameters: {
        url: { type: 'string', required: true, description: 'Full HTTPS URL on developer.mozilla.org, developers.cloudflare.com, api.github.com, or registry.npmjs.org.' },
        maxLength: { type: 'number', description: 'Optional max character length.' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>) {
        if (!origin || origin === 'null') throw new Error('x6_trusted_docs requires a connected host origin')
        enforceToolInvocation('x6_trusted_docs', { ...args, action: 'fetch' })
        const payload = Object.fromEntries(Object.entries({ action: 'fetch', url: args.url, maxLength: args.maxLength }).filter(([, v]) => v !== undefined && v !== null))
        const res = await fetch(new URL('/_host/web-eyes', origin).href, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), credentials: 'same-origin',
        })
        return await res.json()
      },
    })

    registerBuiltin({
      name: 'x6_swarm',
      description:
        'Parallel subagent swarm dispatcher across configured provider doors (`anthropic`, `openrouter`, `deepseek`, `openai`, `xai`, `moonshot`). '
        + 'Accepts either `tasks` (up to 6 independent subagent tasks `{ id?, role?, provider?, model?, prompt, system? }`) '
        + 'or `targets` + shared `prompt`. Executes all workers in parallel and returns individual worker outputs and latencies.',
      parameters: {
        tasks: { type: 'json', description: 'Array of up to 6 parallel subagent tasks `{ id?, role?, provider?, model?, prompt, system? }`.' },
        targets: { type: 'json', description: 'Optional array of `{ provider?, model, role? }` when sharing a single `prompt`.' },
        prompt: { type: 'string', description: 'Shared prompt if `tasks` do not specify individual prompts.' },
        system: { type: 'string', description: 'Optional shared system prompt.' },
        maxTokens: { type: 'number', description: 'Max tokens per worker (1..8192, default 2048).' },
        timeoutMs: { type: 'number', description: 'Timeout per worker in ms (1000..60000, default 30000).' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>, exec?: unknown) {
        const leased = await ensureConsultContext(exec)
        if (!leased) return { ok: false, code: 'CONSULT_PARENT_TURN_REQUIRED' }
        const context = { parentTurnId: leased.parentTurnId, signal: leased.signal }
        try {
          const rawMaxTokens = typeof args.maxTokens === 'number' ? Math.trunc(args.maxTokens) : 2048
          const maxTokens = Math.min(8192, Math.max(1, rawMaxTokens))
          const rawTimeoutMs = typeof args.timeoutMs === 'number' ? Math.trunc(args.timeoutMs) : 30000
          const timeoutMs = Math.min(60000, Math.max(1000, rawTimeoutMs))
          const guarantees = {
            maxTasks: 6,
            maxTurnsPerTask: 1,
            maxTokensCap: 8192,
            toolsGranted: [] as string[],
            ownerSessionInherited: false,
          }
          const rawTasks = Array.isArray(args.tasks) ? args.tasks : null
          if (rawTasks && rawTasks.length > 0) {
            const capped = rawTasks.slice(0, 6)
            const startedAt = Date.now()
            const results = await Promise.all(capped.map(async (t, idx) => {
              const item = record(t) ? t : {}
              const taskPrompt = typeof item.prompt === 'string' && item.prompt.trim() ? item.prompt : String(args.prompt ?? '')
              const model = typeof item.model === 'string' && item.model.trim() ? item.model : 'DeepSeek Flash'
              const out = await consultProviders({
                ...(typeof item.provider === 'string' ? { provider: item.provider } : {}),
                model,
                prompt: taskPrompt,
                system: typeof item.system === 'string' ? item.system : (typeof args.system === 'string' ? args.system : undefined),
                maxTokens,
                timeoutMs,
              }, { origin, ...context })
              return {
                id: typeof item.id === 'string' ? item.id : `worker-${idx + 1}`,
                role: typeof item.role === 'string' ? item.role : null,
                ...out,
              }
            }))
            const workers = context.signal.aborted ? results.map(result => ({ ...result, ok: false,
              answers: result.answers?.map(answer => ({ ...answer, ok: false, text: null, truncated: false, code: 'CONSULT_CANCELLED' })),
            })) : results
            return {
              ok: workers.every(r => r.ok === true),
              mode: 'swarm-tasks',
              workerCount: workers.length,
              elapsedMs: Date.now() - startedAt,
              guarantees,
              workers,
            }
          }
          const councilOut = await consultProviders({
            targets: Array.isArray(args.targets) ? args.targets.slice(0, 6) : [
              { model: 'DeepSeek Flash', role: 'verifier' },
              { model: 'GPT Astra', role: 'critic' },
            ],
            prompt: String(args.prompt ?? ''),
            system: typeof args.system === 'string' ? args.system : undefined,
            maxTokens,
            timeoutMs,
          }, { origin, ...context })
          return {
            ...councilOut,
            guarantees,
          }
        } finally { leased.settle() }
      },
    })

    registerBuiltin({
      name: 'x6_wish',
      description:
        'Durable Object autonomous Wish Engine (`/dsh/home/auma/WISH.md` + Cloudflare Head DO `head:wish:active`). '
        + 'Actions: `create` (registers an active wish with `intent`, `acceptance`, and `maxSteps`, enables the 60s DO wake alarm), '
        + '`step` (executes one cloud wake step immediately against the active wish and appends the receipt to the DO transcript), '
        + '`status` (reads the active wish, steps completed, and daily step budget `dailyStepsUsed / 48`), '
        + '`stop` (stops the active wish and disables the DO wake alarm).',
      parameters: {
        action: {
          type: 'string', required: true, enum: ['create', 'step', 'status', 'stop'],
          description: 'Wish operation (`create`, `step`, `status`, `stop`).',
        },
        intent: { type: 'string', description: 'Goal/intent for `create`.' },
        acceptance: { type: 'string', description: 'Acceptance criteria for `create`.' },
        maxSteps: { type: 'number', description: 'Max autonomous steps for `create` (1..24, default 6).' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>) {
        if (!origin || origin === 'null') throw new Error('x6_wish requires a connected host origin')
        const action = typeof args.action === 'string' ? args.action : 'status'
        const mapAction: Record<string, string> = {
          create: 'wish_create',
          step: 'wish_step',
          status: 'wish_status',
          stop: 'wish_stop',
        }
        const doAction = mapAction[action] ?? 'wish_status'
        if (action === 'create' && typeof args.intent === 'string') {
          const accText = String(args.acceptance ?? 'Complete the stated intent and record a receipt.')
          const md = `# Active Wish\n\n- **Intent:** ${args.intent}\n- **Acceptance:** ${accText}\n- **Updated:** ${new Date().toISOString()}\n`
          try { vfs.writeFileSync(WISH_PATH, md) } catch {}
        }
        const res = await fetch(new URL('/_head/transcript', origin).href, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: doAction,
            intent: args.intent,
            acceptance: args.acceptance,
            maxSteps: args.maxSteps,
            tab_id: peerId,
          }),
        })
        return await res.json()
      },
    })

    registerBuiltin({
      name: 'x6_nostr',
      description:
        'Sovereign Nostr identity and cryptographic envelope tool backed by the Cloudflare Head DO (`/_head/transcript` + `/_host/messages/*`) '
        + 'and the `nostr-core` Wasm cell. Actions: `status` (read provisioned Nostr identity and relay state), '
        + '`provision` (provision the persistent Nostr identity in the Head DO), '
        + '`cell` (run a `nostr-core` Wasm op such as `nostr.ping`, `nip44_encrypt`, `nip44_decrypt`, `gift_wrap`, `dm_seal`).',
      parameters: {
        action: {
          type: 'string', required: true, enum: ['status', 'provision', 'cell'],
          description: 'Nostr operation (`status`, `provision`, `cell`).',
        },
        op: { type: 'string', description: 'Wasm cell op when action="cell" (default "nostr.ping").' },
        input: { type: 'json', description: 'Input object for `nostr-core` when action="cell".' },
      },
      output: jsonOut,
      async execute(args: Record<string, unknown>) {
        const action = typeof args.action === 'string' ? args.action : 'status'
        if (action === 'cell') {
          const cells = workerCellHost()
          return await cells.invoke('nostr-core', typeof args.op === 'string' ? args.op : 'nostr.ping', args.input ?? {})
        }
        if (!origin || origin === 'null') throw new Error('x6_nostr requires a connected host origin')
        const doAction = action === 'provision' ? 'nostr_provision' : 'nostr_status'
        const res = await fetch(new URL('/_head/transcript', origin).href, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: doAction }),
        })
        return await res.json()
      },
    })
    for (const dir of ['/dsh/home/auma/seed/staging', '/dsh/home/auma/seed/candidates']) {
      if (!vfs.existsSync(dir)) continue
      try {
        for (const f of vfs.readdirSync(dir).map(String).filter(n => n.endsWith('.js'))) {
          const content = vfs.readFileSync(join(dir, f), 'utf8') as string
          const sha = sha256HexSync(content)
          const p = join(BALLS_DIR, `${sha}.js`)
          if (!vfs.existsSync(p)) vfs.writeFileSync(p, content)
        }
      } catch {}
    }
    scheduleBootCatchup = () => {
      if (origin && origin !== 'null' && !origin.endsWith('.invalid')) {
        setTimeout(() => {
          void (async () => {
            // A head published while this tab booted is recorded and said (one reload brings it), never hot-swapped.
            try { await checkPublishedHeadOrRetry() } catch {}
            try { await ensureRetroPromotionReceipts() } catch {}
            if (currentBall.epoch >= 63) {
              try { await syncHeadToGithub() } catch {}
            }
          })()
        }, 1500)
      }
    }
  } catch (err) {
    console.error('x6-ball: failed to register self-building tools', err)
  }

  // Mount initial entries from HEAD.json on boot
  for (const entry of Object.values(currentBall.entries)) {
    try {
      await mountOrSwapEntry(entry)
    } catch (err) {
      console.error(`x6-ball: boot mount of entry ${entry.id} (${entry.specifier}) failed`, err)
    }
  }

  connectPresence()

  // Existing edited files stay candidates; missing names are restored from the selected content store.
  const sourceHydration = hydrateNamedOrganSources(vfs, currentBall)
  if (sourceHydration.unavailable.length) console.warn('x6-ball: selected source hydration incomplete', sourceHydration.unavailable)
  // Auto-bootstrap Auma's Seed v4 organs from `/dsh/home/auma/seed/organs/*.js` if present in VFS
  const seedOrgansDir = '/dsh/home/auma/seed/organs'
  if (vfs.existsSync(seedOrgansDir)) {
    try {
      const bootstrapSeed = async (): Promise<void> => {
        const files = vfs.readdirSync(seedOrgansDir).filter(f => String(f).endsWith('.js')).sort()
        let seedChanged = false
        const nextEntries = { ...currentBall.entries }
        const nextModules = { ...currentBall.modules }
        for (const file of files) {
          const fileName = String(file)
          const id = fileName.slice(0, -3)
          const fullPath = join(seedOrgansDir, fileName)
          const code = vfs.readFileSync(fullPath, 'utf8') as string
          if (!code || !code.trim()) continue
          const sha256 = sha256HexSync(code)
          const specifier = `ball:${sha256}`
          const ballFile = join(BALLS_DIR, `${sha256}.js`)
          if (!vfs.existsSync(ballFile)) vfs.writeFileSync(ballFile, code)
          const organStoreFile = `/dsh/home/organs/${sha256}.js`
          if (!vfs.existsSync(organStoreFile)) vfs.writeFileSync(organStoreFile, code)
          if (hasRemoteHead) {
            if (!nextEntries[id] || nextEntries[id].specifier !== specifier) {
              seedCandidates[id] = specifier
              preparedModules.set(sha256, { sha256, specifier, name: id, description: `Seed organ ${id}`, size: new TextEncoder().encode(code).byteLength, createdAt: Date.now() })
            }
            continue
          }
          if (!nextModules[sha256]) {
            nextModules[sha256] = {
              sha256,
              specifier,
              name: id,
              description: `Seed v4 organ ${id}`,
              size: new TextEncoder().encode(code).byteLength,
              createdAt: Date.now(),
            }
            seedChanged = true
          }
          if (!activeFibers.has(id)) {
            const entry: BallEntryRecord = nextEntries[id] ?? {
              id,
              specifier,
              config: {},
              disabled: false,
              previousSpecifiers: [],
              previousVersions: [],
              updatedAt: Date.now(),
            }
            try {
              await mountOrSwapEntry(entry)
              if (!nextEntries[id]) {
                nextEntries[id] = entry
                seedChanged = true
              }
            } catch (mountErr) {
              console.warn(`x6-ball: seed organ ${id} failed to mount`, mountErr)
            }
          }
        }
        if (seedChanged) {
          const nextBallId = computeBallId(null, 0, nextEntries, nextModules)
          currentBall = {
            ...currentBall,
            ballId: nextBallId,
            parentBallId: null,
            epoch: 0,
            authorPeerId: peerId,
            entries: nextEntries,
            modules: nextModules,
          }
          vfs.writeFileSync(HEAD_PATH, JSON.stringify(currentBall, null, 2) + '\n')
          updateSelfPeer()
          await completeMutation('seed.bootstrap', 'seed')
        }
      }
      // Existing host HEAD: discovery stages candidates only. First bootstrap:
      // acquire before any Seed activation or local selection changes.
      // A failed head read is not an absent head: never request the first-bootstrap lease on it.
      if (hasRemoteHead) await bootstrapSeed()
      else if (headFetchError) console.warn('x6-ball: seed bootstrap skipped; selected head unknown', headFetchError)
      else await withWriterLease(bootstrapSeed, true)
    } catch (seedErr) {
      console.warn('x6-ball: seed organ bootstrap error', seedErr)
    }
  }

  // Create initial verified boot snapshot so `auma_snapshot` always has a baseline
  try {
    createSnapshot('boot-verified')
  } catch {}

  scheduleBootCatchup()

  const handleControlRequest = async (
    method: string,
    path: string,
    bodyText: string,
  ): Promise<{ status: number; body: unknown } | null> => {
    if (!path.startsWith('/__x6__/')) return null
    try {
      const sub = path.slice('/__x6__'.length).split('?')[0]
      if (method === 'GET' && (sub === '/status' || sub === '/ball')) {
        return { status: 200, body: readStatus() }
      }
      // The page's Reload notice (portal/build-notice.ts): this tab's own record, no network read, constant size.
      if (method === 'GET' && sub === '/head-lag') {
        return { status: 200, body: { ok: true, headLag: currentHeadLag(), buildMismatch } }
      }
      if (sub === '/build-mismatch') {
        if (method !== 'POST' || bodyText.length > 1024) return { status: 400, body: { ok: false, code: 'BUILD_MISMATCH_INVALID' } }
        let payload: unknown = null
        try { payload = JSON.parse(bodyText) } catch { /* not JSON: refused below */ }
        const noted = noteBuildMismatch(payload)
        return { status: noted.ok ? 200 : 400, body: noted }
      }
      if (method === 'GET' && sub === '/presence') {
        return { status: 200, body: { ok: true, self: presenceService.self(), peers: presenceService.list() } }
      }
      // The global worker message channel is not private from loaded organs.
      // Do not send ceremony bearers here; rejection cannot conceal bytes already sent.
      if (sub === '/governance-approval') return { status: 403, body: { ok: false, code: 'CLASS3_PRIVATE_TRANSPORT_UNAVAILABLE' } }
      if (sub === '/stage-head-promotion' && new TextEncoder().encode(bodyText).byteLength > STAGED_HEAD_PROMOTION_MAX_BYTES) {
        return { status: 413, body: { ok: false, code: 'STAGED_PROMOTION_BYTE_LIMIT' } }
      }
      const payload = bodyText ? JSON.parse(bodyText) : {}
      if (method === 'POST' && sub === '/stage-head-promotion') {
        return { status: 200, body: await serializeMutation(() => Promise.resolve(stageHeadPromotion(payload))) }
      }
      if (method === 'POST' && sub === '/ball-put') {
        const meta = await ballPut(payload)
        return {
          status: 200,
          body: { ok: true, sha: meta.sha256, specifier: meta.specifier, meta, status: readStatus() },
        }
      }
      if (method === 'POST' && sub === '/tree-patch') {
        try {
          const res = await treePatch(payload)
          return { status: 200, body: { ...res, status: readStatus() } }
        } catch (patchErr) {
          return {
            status: 200,
            body: {
              ok: false,
              outcome: patchErr && typeof patchErr === 'object' && 'notApplied' in patchErr && patchErr.notApplied === true ? 'not-applied' : 'mutation-uncertain',
              activationUncertain: !(patchErr && typeof patchErr === 'object' && 'notApplied' in patchErr && patchErr.notApplied === true),
              error: patchErr instanceof Error ? patchErr.message : String(patchErr),
              status: readStatus(),
            },
          }
        }
      }
      if (method === 'POST' && sub === '/tree-undo') {
        const res = await treeUndo(payload)
        return { status: 200, body: { ...res, status: readStatus() } }
      }
      if (method === 'POST' && sub === '/call-tool') {
        const toolName = String(payload.name ?? '')
        const toolArgs = (payload.args ?? payload.input ?? {}) as Record<string, unknown>
        enforceToolInvocation(toolName, toolArgs, currentBall.entries)
        const def = hostCtx.tools?.get?.(toolName)
        if (!def || typeof def.execute !== 'function') {
          return { status: 404, body: { ok: false, error: `Tool "${toolName}" is not registered` } }
        }
        const out = await def.execute(toolArgs, { signal: new AbortController().signal })
        const serializedOutput = typeof out === 'string' ? out : JSON.stringify(out)
        return { status: 200, body: { ok: true, tool: toolName, output: serializedOutput, raw: out } }
      }
      return { status: 404, body: { error: `Unknown X6 control route: ${method} ${path}` } }
    } catch (err) {
      const classification = err && typeof err === 'object' && 'notApplied' in err
        ? { outcome: err.notApplied === true ? 'not-applied' : 'mutation-uncertain', activationUncertain: err.notApplied !== true }
        : {}
      return { status: 400, body: { ok: false, error: err instanceof Error ? err.message : String(err), ...classification } }
    }
  }

  const runtime: X6BallRuntime = {
    peerId,
    status: readStatus,
    ballPut,
    treePatch,
    treeUndo,
    handleControlRequest,
    capabilityIndex: () => capabilityIndex.read(),
  }
  ;(globalThis as { __X6_BALL__?: X6BallRuntime }).__X6_BALL__ = runtime
  console.info(`x6-ball: runtime active (peer=${peerId}, ball=${currentBall.ballId.slice(0, 12)}, epoch=${String(currentBall.epoch)}, entries=${String(Object.keys(currentBall.entries).length)})`)
  return runtime
}
