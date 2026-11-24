/**
 * The page-side SuperAgent reader, as the Spatial shell sees it.
 *
 * `apps/web/src/spatial/work-bridge.ts` publishes the canonical readout (`apps/web/src/spatial/superagent/`) on
 * `globalThis.__AUKORA_SUPERAGENT__`. A Cordis client package cannot import from `apps/web`, so these are STRUCTURAL
 * mirrors of the readout's exported types — the logic (calls, classification, schema checks, receipt verification
 * parsing) stays in one place, there. Absent bridge means the page did not install it; the surface says so.
 */

export const WORK_BRIDGE_GLOBAL = '__AUKORA_SUPERAGENT__'

export interface BridgeMandate {
  id: string
  strength: 'explicit' | 'inferred'
  policyVersion: string
  scope: string
  expiry: string | null
  authority?: {
    level: 'unavailable' | 'unknown' | 'self-attested' | 'chain-linked' | 'owner-confirmed'
    checkpointVerified?: boolean | undefined
    reason?: string | undefined
    reasons?: readonly string[] | undefined
    identityClaim?: string | null | undefined
    identitySource?: 'grant-receipt' | 'confirmed-by-only' | 'absent' | 'contradictory' | undefined
    userVerification?: 'not-attested' | undefined
    provenance?: 'none' | 'claim' | 'chain' | 'pinned-checkpoint' | undefined
    lineage?: 'unknown' | 'same-ball' | 'unrelated' | 'head-claim-only' | 'promoted' | undefined
  } | undefined
  /** The grant receipt the mandate names, as the readout parsed it. `identity` is the grant's own claim. */
  grant?: { seq: number; kind: string; identity: string | null; ballId?: string | null; epoch?: number | null } | null | undefined
}
export interface BridgeTicket { id: string; title: string; state: 'open' | 'ended'; outcome: string | null; mandateId: string | null }
export interface BridgeAssignment {
  id: string
  ticketId: string
  state: 'pending' | 'running' | 'ended'
  executor: { token: string; unrecognized?: true } | null
  survivedRestart: boolean | null
  report: { state: string; summary: string } | null
  heartbeat?: { state?: string | undefined; availability?: string | undefined; ageMs: number | null } | undefined
}
export interface BridgeAttention { id: string; kind: string; text: string; source: string }
/** The fail-closed prediction readout (`superagent/prediction.ts`): a score exists only for a verified triple. */
export interface BridgePredictions {
  status: 'absent' | 'verified' | 'rejected'
  surpriseScore: number | null
  reason: string
}

/** The discovery-trajectory corpus summary (Round 11 `projectDiscoveryCorpus`), when the readout carries it. */
export interface BridgeDiscovery {
  totalTrajectories: number
  zeroSurpriseCount?: number | undefined
  surpriseCount?: number | undefined
  meanSurpriseScore?: number | null | undefined
}

/**
 * The recall projector (Round 12 `projectRecallContext`), when the readout carries it. Nothing on main fills it, and
 * the Work view no longer shows it (Round 25); the field stays in the bridge contract the page global publishes.
 */
export interface BridgeRecall {
  verifiedNodeCount?: unknown
  highSurpriseLessons?: unknown
  /** The full count when the lesson list is capped, if the projector reports it. */
  highSurpriseCount?: unknown
  relevantMemories?: unknown
}

export interface BridgeSnapshot {
  observedAt: string
  survivedRestart: boolean | null
  mandates: readonly BridgeMandate[]
  tickets: readonly BridgeTicket[]
  assignments: readonly BridgeAssignment[]
  attention: readonly BridgeAttention[]
  predictions?: BridgePredictions | undefined
  discovery?: BridgeDiscovery | undefined
  recall?: BridgeRecall | undefined
}

export type BridgeReceipts =
  | { kind: 'verified'; merkleRoot: string; checkpointHash: string | null; receiptsVerified: number | null; checkpointsVerified: number | null }
  | { kind: 'rejected'; stage: string | null; error?: string | null }
  | { kind: string; detail?: string | null }

export type BridgeFailure = { kind: string; detail?: string | null }

export type BridgePhase =
  | { kind: 'loading'; refreshing: boolean }
  | { kind: 'stopped' }
  | { kind: 'failure'; failure: BridgeFailure; receipts: BridgeReceipts; refreshing: boolean }
  | { kind: 'snapshot'; snapshot: BridgeSnapshot; receipts: BridgeReceipts; empty: boolean; refreshing: boolean }
  | { kind: 'stale-snapshot'; snapshot: BridgeSnapshot; receipts: BridgeReceipts; failure: BridgeFailure | null; aged: boolean; refreshing: boolean }

export interface BridgeRead {
  current(): BridgePhase
  refresh(): void
  stop(): void
  subscribe(listener: (phase: BridgePhase) => void): () => void
}

export type BridgeToolBody = { kind: 'ok'; value: unknown } | { kind: string; detail?: string | null }

export type BridgeEvidenceFile =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'bounded' }
  | { readonly kind: 'unavailable' }

export interface BridgeReadOptions {
  readonly readText?: ((path: string, signal: AbortSignal) => Promise<BridgeEvidenceFile>) | undefined
  readonly sessionId?: string | undefined
}

export interface WorkBridge {
  readonly version: 1
  readonly createRead: (options?: BridgeReadOptions) => BridgeRead
  readonly callTool: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<BridgeToolBody>
}

/** The installed bridge, or null when this page did not install one (or installed an unknown version). */
export function workBridge(): WorkBridge | null {
  const value = (globalThis as Record<string, unknown>)[WORK_BRIDGE_GLOBAL] as Partial<WorkBridge> | undefined
  if (value === undefined || value === null || value.version !== 1) return null
  if (typeof value.createRead !== 'function' || typeof value.callTool !== 'function') return null
  return value as WorkBridge
}
