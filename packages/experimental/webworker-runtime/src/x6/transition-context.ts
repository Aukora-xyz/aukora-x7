/**
 * Lane E4 / X65 WO-3 foundation (NORTH-STAR §24.3–§24.4): every runtime authority or receipt mutation carries an explicit
 * transition context, `operationId` plus `transitionKind`, so a later write-set inventory can attribute each leaf to one
 * admitted operation. This module is pure: it mints and validates the context and decides whether a promotion receipt may
 * be written now, never what the edge decided.
 * @module x6/transition-context
 */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

/** The runtime's mutating operations. A receipt leaf names exactly one. */
export const TRANSITION_KINDS = Object.freeze([
  'tree.patch', 'tree.undo', 'snapshot.restore', 'seed.bootstrap',
  'head.promote', 'ball.promote', 'head.adopt', 'head.stage',
  'wake.acknowledge', 'wake.step',
  // Lane E5 (write-set inventory): staging one outward Class 3 request for the owner's Touch ID, and the two receipt-bearing
  // operations outside the head path (aura attestation, Scion compile).
  'outward.stage', 'aura.attest', 'scion.compile',
] as const)
export type TransitionKind = typeof TRANSITION_KINDS[number]

export interface TransitionContext {
  readonly operationId: string
  readonly transitionKind: TransitionKind
}

const OPERATION_ID = /^op-[A-Za-z0-9._:-]{8,120}$/

/** Whether a value is a transition kind this runtime knows. */
export function isTransitionKind(value: unknown): value is TransitionKind {
  return typeof value === 'string' && (TRANSITION_KINDS as readonly string[]).includes(value)
}

/**
 * Mint (or adopt) one operation's context.
 * @param transitionKind - the operation being performed.
 * @param operationId - an existing id to thread through (for example from the hop that staged it); minted when absent.
 * @returns a frozen context.
 * @throws TRANSITION_CONTEXT_INVALID for an unknown kind or a malformed id.
 */
export function createTransitionContext(transitionKind: unknown, operationId?: unknown): TransitionContext {
  if (!isTransitionKind(transitionKind)) throw new Error('TRANSITION_CONTEXT_INVALID: unknown transitionKind')
  const id = operationId === undefined ? `op-${randomUUID()}` : operationId
  if (typeof id !== 'string' || !OPERATION_ID.test(id)) throw new Error('TRANSITION_CONTEXT_INVALID: operationId')
  return Object.freeze({ operationId: id, transitionKind })
}

/** Receipt fields that carry the context (merged into a receipt's `data`). */
export function transitionFields(context: TransitionContext): { operationId: string; transitionKind: TransitionKind } {
  return { operationId: context.operationId, transitionKind: context.transitionKind }
}

/** What the edge said about the publication that produced this head, if anything. */
export interface AuthoritativePublishOutcome {
  readonly ok?: boolean
  readonly resultingBallId?: string | null
  readonly resultingEpoch?: number | null
  readonly hasApprovalToken?: boolean
}

export type PromotionReceiptPlan =
  | { readonly write: true; readonly data: Record<string, unknown> }
  | { readonly write: false; readonly reason: 'GOVERNANCE_AWAITS_AUTHORITATIVE_OUTCOME' }

/**
 * Decide the one promotion leaf a local caller may write for `(epoch, ballId)`.
 * Promotion leaves deduplicate on `(epoch, ballId)`, so the first writer wins forever. A governance (Class 3 / T2)
 * transition must therefore never get a local `tier: 'T1', hasApprovalToken: false` leaf: unless the edge's own
 * `lastPublishOutcome` for exactly this head says a Touch ID token was consumed, the local writer defers and
 * `ensureRetroPromotionReceipts` records the authoritative outcome later.
 * @param input - the head produced, the changed entry, whether it is governance, the context and the edge outcome.
 * @returns the receipt data to write, or a deferral.
 */
export function planPromotionReceipt(input: {
  readonly entryId: string
  readonly manifest: { readonly ballId: string; readonly parentBallId: string | null; readonly epoch: number }
  readonly governance: boolean
  readonly context: TransitionContext
  readonly authoritative?: AuthoritativePublishOutcome | null
  readonly extra?: Record<string, unknown>
}): PromotionReceiptPlan {
  const outcome = input.authoritative
  const matches = outcome?.ok === true && outcome.resultingBallId === input.manifest.ballId
    && outcome.resultingEpoch === input.manifest.epoch
  const hasApprovalToken = matches && outcome.hasApprovalToken === true
  if (input.governance && !hasApprovalToken) return { write: false, reason: 'GOVERNANCE_AWAITS_AUTHORITATIVE_OUTCOME' }
  return {
    write: true,
    data: {
      ...(input.extra ?? {}),
      entryId: input.entryId,
      ballId: input.manifest.ballId,
      parentBallId: input.manifest.parentBallId,
      epoch: input.manifest.epoch,
      tier: hasApprovalToken ? 'T2' : 'T1',
      hasApprovalToken,
      ...transitionFields(input.context),
    },
  }
}
