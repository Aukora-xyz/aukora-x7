/**
 * Read projection for Spatial World and Self.
 *
 * Existing worker invocation, implemented in `ball-loader.ts` `handleControlRequest`:
 * `POST /__x6__/call-tool` with JSON `{ name, args }` through the page tunnel
 * `__DSH_TRANSPORT__.fetch`. The same route is accepted as `/api/__x6__/`.
 * A missing tool responds `404` with `{ ok: false, error: 'Tool "<name>" is not registered' }`.
 * A missing control route responds `404` with `{ error: 'Unknown X6 control route: ...' }`.
 * Success is `200` with `{ ok: true, tool, output, raw }`.
 *
 * Existing receipt read: tool `seed_receipts`, args `{ action: 'verify' }` only.
 * The verified hash is `currentMerkleRoot` when `ok` is true and `action` is `verify`.
 * `latestCheckpointHash` is shown only on that same success. A failed verification
 * contributes no hash, even if the body still carries hash fields.
 *
 * `seed-superagent` registers `auma_superagent` and its `status` action returns
 * `auma.superagent.status.v1`. `execute` wraps that object as `{ output: string }`.
 * This readout sends `{ action: 'status' }` only. It does not call `eval_accept`,
 * `confirm`, or any other action, and it does not add a route or a session.
 *
 * File bytes for the receipt log, checkpoints, ball HEAD, and DAG HEAD come from
 * an injected whole-file reader or, when a Session id is already known, the
 * existing `POST /api/workspaceFiles/read` RPC. This module does not create that Session.
 */
import type { AuraProjection } from './aura.ts'

/** Aura slot on a snapshot. `not-evaluated` is not a vector and not a grant. */
export type AuraRead = { readonly status: 'not-evaluated' } | AuraProjection

/** Read-only Pearl claims. Null counts mean unknown, never zero passed. */
export interface PearlProjection {
  readonly retentionTotal: number | null
  readonly retentionPassed: number | null
  readonly scarsCount: number | null
  readonly lastChallengeAt: string | null
  readonly lastWinnerLabel: string | null
  readonly candidateCount: number | null
  readonly durationMs: number | null
  /**
   * Coarse-to-fine tournament counts from the latest bound `pearl.challenge` (Round 17). Null: not recorded, or not
   * consistent (tested must equal the candidate list; fine passes cannot exceed coarse passes, nor coarse tested).
   */
  readonly candidatesTested?: number | null
  readonly coarsePassCount?: number | null
  readonly finePassCount?: number | null
  /** Her claim that a reward-hack or corrupted-assumption control was refused. Null: not recorded. */
  readonly negativeControlRejected?: boolean | null
  /** Receipt checkpoints, from the reader's own signature and Merkle check. Absent when not read. */
  readonly checkpoint?: CheckpointCoverage | null
  readonly authorityTier: 'self-attested'
  readonly status: 'complete' | 'incomplete'
  /** Receipt integrity does not establish execution in an isolated worker. */
  readonly isolationProved: false
  readonly gaps: readonly string[]
}

/**
 * What the receipt checkpoints cover. `count` checkpoints chain in order with matching hashes; the last claims to cover
 * `lastReceiptCount` of `receiptTotal` receipts. `lastSigned`: its Merkle root matched those receipts and its Ed25519
 * signature verified under a pinned receipt signer. A checkpoint is not owner authority.
 */
export interface CheckpointCoverage {
  readonly count: number
  readonly lastReceiptCount: number | null
  readonly receiptTotal: number
  readonly lastSigned: boolean
}

/** Display window for `observedAt`. Older snapshots stay visible and are marked stale. */
export const STATUS_FRESH_MS = 120_000

/** Observations further ahead than this are not shown as current work. */
export const STATUS_FUTURE_SKEW_MS = 300_000

/** Page-side wait for one status read and one receipt read. */
export const READ_TIMEOUT_MS = 12_000

/** Largest tool body this readout will parse. */
export const MAX_TOOL_BODY_CHARS = 262_144

/** Largest untrusted tool error string retained for display. */
export const MAX_DETAIL_CHARS = 500

/** Largest collection this readout will render. Larger replies are refused whole. */
export const MAX_ROWS = 100

export const STATUS_SCHEMA = 'auma.superagent.status.v1'
export const CALL_TOOL_PATH = '/__x6__/call-tool'
export const SUPERAGENT_TOOL_NAMES = ['auma_superagent', 'auma.superagent'] as const
export const RECEIPT_TOOL_NAME = 'seed_receipts'
export const STATUS_READ_ARGS = { action: 'status' } as const
export const RECEIPT_VERIFY_ARGS = { action: 'verify' } as const

const HEX_64 = /^[0-9a-f]{64}$/
/** A named organ code, as her organs write them. */
const ORGAN_CODE = /^[A-Z][A-Z0-9_]{0,79}$/
const OBSERVED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
const CONTROL_MISS = /^Unknown X6 control route: /
const TOOL_MISS = /^Tool ".*" is not registered$/

export const EXECUTOR_TOKENS = ['browser-worker', 'browser', 'cloudflare-do', 'mac-limb'] as const
export type ExecutorToken = typeof EXECUTOR_TOKENS[number]

export type Strength = 'explicit' | 'inferred'
export type TicketState = 'open' | 'ended'
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'
export type AssignmentState = 'pending' | 'running' | 'ended'
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
export type AttentionKind = 'question' | 'blocked' | 'diff-review' | 'promotion-review' | 'stale-heartbeat' | 'heartbeat-missing' | 'heartbeat-invalid' | 'heartbeat-future' | 'inferred-mandate-confirmation' | 'explicit-mandate-confirmation' | 'assignment-blocked' | 'assignment-waiting'

/** Source-defined grant the mandate claims. Matching these fields is required before owner confirmation. */
export interface MandateGrant {
  seq: number
  hash: string
  kind: string
  scope: string | null
  ticketId: string | null
  identity: string | null
  ballId: string | null
  epoch: number | null
}

/**
 * Peripheral hints sit strictly below `self-attested`.
 * They are not a mandate level and cannot be assigned to {@link MandateAuthority.level}.
 */
export const PERIPHERAL_HINT = 'peripheral-hint' as const

/**
 * Rank a mandate level or a peripheral hint.
 * @param level - Mandate level, or {@link PERIPHERAL_HINT}.
 * @returns `0` for a peripheral hint, then `1..5` from `unavailable` through `owner-confirmed`.
 */
export function authorityRank(level: MandateAuthority['level'] | typeof PERIPHERAL_HINT): number {
  if (level === PERIPHERAL_HINT) return 0
  if (level === 'unavailable') return 1
  if (level === 'unknown') return 2
  if (level === 'self-attested') return 3
  if (level === 'chain-linked') return 4
  return 5
}

/**
 * How far the receipt claim was proved. Filled again by `applyEvidence`.
 * `userVerification` stays `not-attested`: a key signature is not a passkey ceremony.
 * `chain-linked` is receipt history. `owner-attestation` is a separate owner signature.
 * `identityClaim` is a string from the grant, not a person inferred from a signer.
 * `peripheral-hint` is below `self-attested` and is not a value of `level`.
 */
export interface MandateAuthority {
  level: 'unavailable' | 'unknown' | 'self-attested' | 'chain-linked' | 'owner-confirmed'
  reasons: readonly string[]
  identityClaim: string | null
  identitySource: 'grant-receipt' | 'confirmed-by-only' | 'absent' | 'contradictory'
  userVerification: 'not-attested'
  provenance: 'none' | 'claim' | 'chain' | 'pinned-checkpoint' | 'owner-attestation'
  /**
   * Relation of the selected ball to the grant ball.
   * `promoted` is a recomputed receipt edge chain. It does not extend owner confirmation.
   * `head-claim-only` is a parent pointer on HEAD with no such chain.
   */
  lineage: 'unknown' | 'same-ball' | 'unrelated' | 'head-claim-only' | 'promoted'
  /** Same value as `lineage`. The human-facing name is Pearl. */
  pearlLineage: 'unknown' | 'same-ball' | 'unrelated' | 'head-claim-only' | 'promoted'
  /** Always false. Owner-grant v1 does not sign a WebAuthn result. */
  passkeyVerified: false
  /** Always null until a separate signed presence attestation exists. */
  credentialId: null
  /** Always `unknown`. A bare AUMLOK flag is not a binding. */
  aumlokBinding: 'unknown'
}

/** One recorded mandate. `expiry: null` means the field was absent or null, not that it never expires. */
export interface MandateView {
  id: string
  strength: Strength
  policyVersion: string
  scope: string
  expiry: string | null
  /** Leaf the mandate names. `receiptHash` from the organ is accepted as this field. */
  receiptLeafHash: string | null
  /** True when a receipt field was present but not a 64-character hex leaf. */
  receiptClaimInvalid: boolean
  ballId: string | null
  /** Same value as `ballId`. */
  pearlId: string | null
  confirmed: boolean | null
  confirmedBy: string | null
  grant: MandateGrant | null
  /**
   * `ownerGrant` on the status mandate and on `grant`. These are signature
   * candidates only. They are not added to the owner trust list.
   */
  ownerGrants: readonly unknown[]
  authority: MandateAuthority
}

/** One recorded ticket. */
export interface TicketView {
  id: string
  title: string
  state: TicketState
  outcome: TicketOutcome | null
  mandateId: string | null
}

/** Raw pulse fields. `invalid` does not fall through to an older timestamp. */
export interface AssignmentPulse {
  heartbeat: number | 'invalid' | 'absent'
  report: number | 'invalid' | 'absent'
  started: number | 'invalid' | 'absent'
}

/** Heartbeat judgement. `stale` does not change `state`. */
export interface HeartbeatView {
  availability: 'not-evaluated' | 'not-running' | 'fresh' | 'stale' | 'missing' | 'invalid' | 'future'
  ageMs: number | null
}

/** One recorded assignment. `executor: null` means the status omitted it. */
export interface AssignmentView {
  id: string
  ticketId: string
  state: AssignmentState
  executor: { token: ExecutorToken } | { token: string; unrecognized: true } | null
  survivedRestart: boolean | null
  report: { state: ReportState; summary: string } | null
  pulse: AssignmentPulse
  heartbeat: HeartbeatView
}

/** One structured attention item from the status projection or a local heartbeat judgement. */
export interface AttentionView {
  id: string
  kind: AttentionKind | string
  text: string
  source: 'status' | 'assignment-report' | 'heartbeat'
}

/** Parsed `auma.superagent.status.v1` body. */
export interface StatusSnapshot {
  schema: typeof STATUS_SCHEMA
  toolName: string
  observedAt: string
  survivedRestart: boolean | null
  mandates: readonly MandateView[]
  tickets: readonly TicketView[]
  assignments: readonly AssignmentView[]
  attention: readonly AttentionView[]
  /** Selected ball. Unavailable until a HEAD read is supplied. */
  head: { kind: 'unavailable' } | { kind: 'missing' } | { kind: 'malformed' } | { kind: 'summary'; ballId: string; epoch: number; parentBallId: string | null }
  /** DAG metadata. `summary` does not mean node ancestry was checked. */
  dag: { kind: 'unavailable' } | { kind: 'missing' } | { kind: 'malformed' } | { kind: 'summary'; headId: string | null; totalNodes: number | null; updatedAt: string | null; ancestryVerified: false }
  /** True when stale-heartbeat rows were not added because the attention list is already at its cap. */
  heartbeatBounded: boolean
  /** Prediction receipts. `absent` means the log has none; it is not a score. */
  predictions: PredictionReadout
  /**
   * Peripheral vector. `not-evaluated` until a reader supplies facts.
   * This field never changes mandate level.
   */
  aura: AuraRead
  /** Absent until files are read; incomplete summaries retain unknown fields as null. */
  pearl?: PearlProjection
  /** Receipt checkpoint coverage from `applyEvidence`. Absent until the receipt chain is read. */
  checkpoints?: CheckpointCoverage
}

/** Public readout name used by the spatial UI; authority remains on each mandate. */
export type SuperAgentState = StatusSnapshot

/** Fail-closed prediction summary. A model-supplied score is not this value. */
export interface PredictionReadout {
  status: 'absent' | 'verified' | 'rejected'
  surpriseScore: number | null
  reason: string
}

/** Receipt verification outcome. Hash fields exist only on `verified`. */
export type ReceiptRead =
  | { kind: 'idle' }
  | { kind: 'missing' }
  | { kind: 'control-unavailable' }
  | { kind: 'verified'; merkleRoot: string; checkpointHash: string | null; receiptsVerified: number | null; checkpointsVerified: number | null }
  /** `error` is the organ's named code beside the stage (for example CHECKPOINT_SIGNER_POLICY_MISMATCH), when it gave one. */
  | { kind: 'rejected'; stage: string | null; error?: string | null }
  | { kind: 'unreadable' }
  | { kind: 'timeout' }
  | { kind: 'transport'; detail: string | null; truncated: boolean }
  | { kind: 'refused'; detail: string | null; truncated: boolean }

/** Why a status read did not become a snapshot. */
export type StatusFailure =
  | { kind: 'host-unavailable' }
  | { kind: 'control-unavailable' }
  | { kind: 'backend-missing' }
  | { kind: 'schema' }
  | { kind: 'bound' }
  | { kind: 'time' }
  | { kind: 'timeout' }
  | { kind: 'transport'; detail: string | null; truncated: boolean }
  | { kind: 'refused'; detail: string | null; truncated: boolean }
  | { kind: 'unreadable' }

/**
 * What World and Self may paint.
 * `snapshot` is current work. `stale-snapshot` is retained work that must not be
 * presented as the latest successful read. `failure` has no work rows.
 */
export type SuperagentPhase =
  | { kind: 'loading'; refreshing: boolean }
  | { kind: 'stopped' }
  | { kind: 'failure'; failure: StatusFailure; receipts: ReceiptRead; refreshing: boolean }
  | { kind: 'snapshot'; snapshot: StatusSnapshot; receipts: ReceiptRead; empty: boolean; refreshing: boolean }
  | { kind: 'stale-snapshot'; snapshot: StatusSnapshot; receipts: ReceiptRead; failure: StatusFailure | null; aged: boolean; refreshing: boolean }

/** Worker tunnel fetch only. Host wake metadata uses a separate transport; neither creates a session. */
export interface TunnelFetch {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<ToolResponse>
}

/** Subset of `Response` this readout consumes. */
export interface ToolResponse {
  status: number
  /** Streamed responses are cancelled at the byte cap. Text-only adapters own upstream allocation bounds. */
  body?: ReadableStream<Uint8Array> | null
  text(): Promise<string>
}

/** Result of parsing a call-tool HTTP body before domain checks. */
export type ToolBody =
  | { kind: 'ok'; value: unknown }
  | { kind: 'missing' }
  | { kind: 'control-unavailable' }
  | { kind: 'timeout' }
  | { kind: 'transport'; detail: string | null; truncated: boolean }
  | { kind: 'refused'; detail: string | null; truncated: boolean }
  | { kind: 'unreadable' }
  | { kind: 'bounded' }

interface DetailText {
  detail: string | null
  truncated: boolean
}

/**
 * Read the fetch installed by `connectWorkerHost`.
 * @returns The page tunnel fetch, or null when this document has no worker transport.
 */
export function pageTunnelFetch(): TunnelFetch | null {
  const transport = (globalThis as { __DSH_TRANSPORT__?: { fetch?: TunnelFetch } }).__DSH_TRANSPORT__
  return typeof transport?.fetch === 'function' ? transport.fetch.bind(transport) : null
}

/**
 * Classify one `/__x6__/call-tool` response.
 * @param status - HTTP status from the worker control route.
 * @param text - Response body, already bounded by the caller.
 * @returns A tool-body discriminant. Domain schema checks are separate.
 */
export function classifyToolBody(status: number, text: string): ToolBody {
  if (text.length > MAX_TOOL_BODY_CHARS) return { kind: 'bounded' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return { kind: 'unreadable' }
  }
  if (status === 404 && isRecord(parsed) && typeof parsed.error === 'string' && CONTROL_MISS.test(parsed.error)) {
    return { kind: 'control-unavailable' }
  }
  if (status === 404 && isRecord(parsed) && parsed.ok === false && typeof parsed.error === 'string' && TOOL_MISS.test(parsed.error)) {
    return { kind: 'missing' }
  }
  if (status < 200 || status >= 300) {
    return { kind: 'refused', ...detailFrom(parsed) }
  }
  if (!isRecord(parsed) || parsed.ok !== true) {
    return { kind: 'refused', ...detailFrom(parsed) }
  }
  return { kind: 'ok', value: payloadOf(parsed) }
}

/**
 * Parse a successful status payload.
 * @param value - `raw`, or `output` when `raw` is absent.
 * @param toolName - Tool name that returned the body.
 * @param now - Clock used to reject impossible observation times.
 * @returns The snapshot, or a failure that must not be painted as work.
 */
export function parseStatus(
  value: unknown,
  toolName: string,
  now: number,
): { ok: true; snapshot: StatusSnapshot } | { ok: false; failure: StatusFailure } {
  // Her organ's own refusal (`{ok:false, error}` inside a 200 tool body) is said with its code, never as a schema miss.
  if (isRecord(value) && value.ok === false && typeof value.error === 'string') return { ok: false, failure: { kind: 'refused', ...detailFrom(value) } }
  if (!isRecord(value) || value.schema !== STATUS_SCHEMA) return { ok: false, failure: { kind: 'schema' } }
  if (typeof value.observedAt !== 'string' || !OBSERVED_AT.test(value.observedAt)) return { ok: false, failure: { kind: 'schema' } }
  const observed = Date.parse(value.observedAt)
  if (!Number.isFinite(observed)) return { ok: false, failure: { kind: 'schema' } }
  if (observed - now > STATUS_FUTURE_SKEW_MS) return { ok: false, failure: { kind: 'time' } }
  if (value.survivedRestart !== undefined && value.survivedRestart !== null && typeof value.survivedRestart !== 'boolean') {
    return { ok: false, failure: { kind: 'schema' } }
  }
  const mandates = parseRows(value.mandates, parseMandate)
  const tickets = parseRows(value.tickets, parseTicket)
  const assignments = parseRows(value.assignments, parseAssignment)
  const attention = parseRows(value.attention, parseAttention)
  if (!mandates || !tickets || !assignments || !attention) return { ok: false, failure: { kind: 'schema' } }
  if (mandates === 'bound' || tickets === 'bound' || assignments === 'bound' || attention === 'bound') {
    return { ok: false, failure: { kind: 'bound' } }
  }
  const derived = assignmentAttention(assignments)
  if (attention.length + derived.length > MAX_ROWS) return { ok: false, failure: { kind: 'bound' } }
  return {
    ok: true,
    snapshot: {
      schema: STATUS_SCHEMA,
      toolName,
      observedAt: value.observedAt,
      survivedRestart: typeof value.survivedRestart === 'boolean' ? value.survivedRestart : null,
      mandates,
      tickets,
      assignments,
      attention: [...attention, ...derived],
      head: { kind: 'unavailable' },
      dag: { kind: 'unavailable' },
      heartbeatBounded: false,
      predictions: { status: 'absent', surpriseScore: null, reason: 'prediction-not-evaluated' },
      aura: { status: 'not-evaluated' },
    },
  }
}

/**
 * Parse a `seed_receipts` verify body. Failed and non-verify bodies never yield a hash.
 * @param value - Tool payload.
 * @returns The receipt discriminant.
 */
export function parseReceipt(value: unknown): ReceiptRead {
  if (!isRecord(value)) return { kind: 'unreadable' }
  if (value.ok !== true) {
    const stage = displayText(value.stage, 120, false)
    const error = typeof value.error === 'string' && ORGAN_CODE.test(value.error) ? value.error : null
    return { kind: 'rejected', stage, error }
  }
  if (value.action !== 'verify') return { kind: 'unreadable' }
  if (typeof value.currentMerkleRoot !== 'string' || !HEX_64.test(value.currentMerkleRoot)) return { kind: 'unreadable' }
  let checkpointHash: string | null = null
  if (value.latestCheckpointHash !== undefined && value.latestCheckpointHash !== null) {
    if (typeof value.latestCheckpointHash !== 'string' || !HEX_64.test(value.latestCheckpointHash)) return { kind: 'unreadable' }
    checkpointHash = value.latestCheckpointHash
  }
  const receiptsVerified = optionalCount(value.receiptsVerified)
  const checkpointsVerified = optionalCount(value.checkpointsVerified)
  if (receiptsVerified === 'bad' || checkpointsVerified === 'bad') return { kind: 'unreadable' }
  return {
    kind: 'verified',
    merkleRoot: value.currentMerkleRoot,
    checkpointHash,
    receiptsVerified,
    checkpointsVerified,
  }
}

/**
 * Whether a snapshot is inside the display window.
 * @param observedAt - ISO timestamp from a parsed snapshot.
 * @param now - Current clock.
 * @returns True when the observation is older than {@link STATUS_FRESH_MS}.
 */
export function observationIsAged(observedAt: string, now: number): boolean {
  return now - Date.parse(observedAt) > STATUS_FRESH_MS
}

/**
 * Whether the snapshot contains no work rows.
 * @param snapshot - Parsed status.
 * @returns True when every collection is empty.
 */
export function snapshotIsEmpty(snapshot: StatusSnapshot): boolean {
  return snapshot.mandates.length === 0
    && snapshot.tickets.length === 0
    && snapshot.assignments.length === 0
    && snapshot.attention.length === 0
}

function payloadOf(body: Record<string, unknown>): unknown {
  const selected = body.raw !== undefined ? body.raw : body.output
  const parsed = typeof selected === 'string' ? parseJson(selected) : selected
  if (isRecord(parsed) && parsed.schema === STATUS_SCHEMA) return parsed
  if (isRecord(parsed) && typeof parsed.output === 'string') {
    const inner = parseJson(parsed.output)
    if (isRecord(inner)) return inner
  }
  return parsed
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return text }
}

function detailFrom(value: unknown): DetailText {
  if (!isRecord(value) || typeof value.error !== 'string') return { detail: null, truncated: false }
  const cleaned = value.error.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  if (cleaned.length === 0) return { detail: null, truncated: false }
  if (cleaned.length > MAX_DETAIL_CHARS) return { detail: cleaned.slice(0, MAX_DETAIL_CHARS), truncated: true }
  return { detail: cleaned, truncated: false }
}

function parseRows<T>(value: unknown, parse: (row: unknown) => T | null): readonly T[] | null | 'bound' {
  if (!Array.isArray(value)) return null
  if (value.length > MAX_ROWS) return 'bound'
  const rows: T[] = []
  for (const row of value) {
    const parsed = parse(row)
    if (parsed === null) return null
    rows.push(parsed)
  }
  return rows
}

function parseMandate(value: unknown): MandateView | null {
  if (!isRecord(value)) return null
  const id = plainId(value.id, 200)
  if (id === null || (value.strength !== 'explicit' && value.strength !== 'inferred')) return null
  const policyVersion = displayText(value.policyVersion, 200, false)
  const scope = scopeText(value.scope)
  if (policyVersion === null || scope === null) return null
  const expiry = expiryOf(value)
  if (expiry === undefined) return null
  const leaf = leafClaim(value.receiptLeafHash ?? value.receiptHash)
  if (leaf === undefined) return null
  const grant = grantOf(value.grant)
  if (grant === undefined) return null
  const ballId = value.ballId === undefined || value.ballId === null ? null : (typeof value.ballId === 'string' && /^[0-9a-f]{64}$/.test(value.ballId) ? value.ballId : undefined)
  if (ballId === undefined) return null
  return {
    id,
    strength: value.strength,
    policyVersion,
    scope,
    expiry,
    receiptLeafHash: leaf.hash,
    receiptClaimInvalid: leaf.invalid,
    ballId,
    pearlId: ballId,
    confirmed: typeof value.confirmed === 'boolean' ? value.confirmed : null,
    confirmedBy: typeof value.confirmedBy === 'string' && plainId(value.confirmedBy, 200) ? value.confirmedBy : null,
    grant,
    ownerGrants: ownerGrantFields(value),
    authority: {
      level: 'unknown',
      reasons: ['not-evaluated'],
      identityClaim: null,
      identitySource: 'absent',
      userVerification: 'not-attested',
      provenance: 'none',
      lineage: 'unknown',
      pearlLineage: 'unknown',
      passkeyVerified: false,
      credentialId: null,
      aumlokBinding: 'unknown',
    },
  }
}

function expiryOf(value: Record<string, unknown>): string | null | undefined {
  if (typeof value.expiry === 'string') return OBSERVED_AT.test(value.expiry) ? value.expiry : undefined
  if (value.expiry != null) return undefined
  if (typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)) return new Date(value.expiresAt).toISOString()
  return null
}

function leafClaim(value: unknown): { hash: string | null; invalid: boolean } | undefined {
  if (value === undefined || value === null) return { hash: null, invalid: false }
  if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) return { hash: value, invalid: false }
  if (typeof value === 'string') return { hash: null, invalid: true }
  return undefined
}

function ownerGrantFields(value: Record<string, unknown>): readonly unknown[] {
  const found: unknown[] = []
  if (value.ownerGrant !== undefined && value.ownerGrant !== null) found.push(value.ownerGrant)
  if (isRecord(value.grant) && value.grant.ownerGrant !== undefined && value.grant.ownerGrant !== null) {
    found.push(value.grant.ownerGrant)
  }
  return found
}

function grantOf(value: unknown): MandateGrant | null | undefined {
  if (value === undefined || value === null) return null
  if (!isRecord(value) || typeof value.kind !== 'string' || !plainId(value.kind, 80)) return undefined
  if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 1) return undefined
  if (typeof value.hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.hash)) return undefined
  const scope = value.scope === undefined || value.scope === null ? null : scopeText(value.scope)
  if (value.scope != null && scope === null) return undefined
  return {
    seq: value.seq,
    hash: value.hash,
    kind: value.kind,
    scope: scope === null ? null : canonicalJson(value.scope),
    ticketId: typeof value.ticketId === 'string' ? value.ticketId : null,
    identity: typeof value.identity === 'string' ? value.identity : null,
    ballId: typeof value.ballId === 'string' && /^[0-9a-f]{64}$/.test(value.ballId) ? value.ballId : null,
    epoch: typeof value.epoch === 'number' && Number.isSafeInteger(value.epoch) ? value.epoch : null,
  }
}

/**
 * Canonical JSON matching `seed-receipts.js`.
 * @param value - JSON value.
 * @returns Canonical text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function parseTicket(value: unknown): TicketView | null {
  if (!isRecord(value)) return null
  const id = plainId(value.id, 200)
  const title = displayText(value.title, 300, false)
  if (id === null || title === null || (value.state !== 'open' && value.state !== 'ended')) return null
  if (value.state === 'open' && value.outcome !== undefined && value.outcome !== null) return null
  const outcome = value.outcome === undefined || value.outcome === null ? null : outcomeOf(value.outcome)
  if (outcome === undefined) return null
  const mandateId = value.mandateId === undefined || value.mandateId === null ? null : plainId(value.mandateId, 200)
  if (mandateId === null && value.mandateId !== undefined && value.mandateId !== null) return null
  return { id, title, state: value.state, outcome, mandateId }
}

function parseAssignment(value: unknown): AssignmentView | null {
  if (!isRecord(value)) return null
  const id = plainId(value.id, 200)
  const ticketId = plainId(value.ticketId, 200)
  if (id === null || ticketId === null) return null
  if (value.state !== 'pending' && value.state !== 'running' && value.state !== 'ended') return null
  const executor = executorOf(value.executor)
  if (executor === undefined) return null
  if (value.survivedRestart !== undefined && value.survivedRestart !== null && typeof value.survivedRestart !== 'boolean') return null
  const report = reportOf(value.report) ?? reportFromOrgan(value)
  if (report === undefined) return null
  return {
    id,
    ticketId,
    state: value.state,
    executor,
    survivedRestart: typeof value.survivedRestart === 'boolean' ? value.survivedRestart : null,
    report,
    pulse: {
      heartbeat: timeField(value.heartbeatAt),
      report: timeField(lastReportAt(value)),
      started: timeField(value.startedAt),
    },
    heartbeat: { availability: value.state === 'running' ? 'not-evaluated' : 'not-running', ageMs: null },
  }
}

function reportFromOrgan(value: Record<string, unknown>): AssignmentView['report'] | undefined {
  if (typeof value.lastReport !== 'string' || !reportState(value.lastReport)) return null
  const reports = Array.isArray(value.reports) ? value.reports : []
  const last = reports.length > 0 ? reports[reports.length - 1] : null
  const note = isRecord(last) && typeof last.note === 'string' ? last.note : ''
  const summary = displayText(note, 2000, true)
  if (summary === null) return undefined
  return { state: value.lastReport, summary }
}

function lastReportAt(value: Record<string, unknown>): unknown {
  if (!Array.isArray(value.reports) || value.reports.length === 0) return undefined
  const last = value.reports[value.reports.length - 1]
  return isRecord(last) ? last.at : undefined
}

function timeField(value: unknown): number | 'invalid' | 'absent' {
  if (value === undefined || value === null) return 'absent'
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 'invalid'
  }
  return 'invalid'
}

function parseAttention(value: unknown): AttentionView | null {
  if (!isRecord(value)) return null
  const id = plainId(value.id, 200)
  const kind = typeof value.kind === 'string' && plainId(value.kind, 80) ? value.kind : null
  if (id === null || kind === null) return null
  const text = displayText(value.text, 2000, false) ?? detailText(value.detail, kind)
  if (text === null) return null
  return { id, kind, text, source: 'status' }
}

function detailText(value: unknown, kind: string): string | null {
  if (!isRecord(value)) return kind
  const parts = ['title', 'note', 'mandateId', 'assignmentId', 'ticketId']
    .map(key => typeof value[key] === 'string' ? value[key] : null)
    .filter((item): item is string => item !== null && item.length > 0 && item.length <= 300)
  const text = parts.join(' · ')
  return text.length > 0 ? text : kind
}

function assignmentAttention(assignments: readonly AssignmentView[]): AttentionView[] {
  const derived: AttentionView[] = []
  for (const assignment of assignments) {
    if (assignment.report?.state !== 'blocked' && assignment.report?.state !== 'failed') continue
    derived.push({
      id: `assignment-report:${assignment.id}`,
      kind: 'blocked',
      text: assignment.report.summary,
      source: 'assignment-report',
    })
  }
  return derived
}

function executorOf(value: unknown): AssignmentView['executor'] | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !plainId(value, 80)) return undefined
  if (EXECUTOR_TOKENS.includes(value as ExecutorToken)) return { token: value as ExecutorToken }
  return { token: value, unrecognized: true }
}

function reportOf(value: unknown): AssignmentView['report'] | undefined {
  if (value === undefined || value === null) return null
  if (!isRecord(value) || !reportState(value.state)) return undefined
  const summary = displayText(value.summary, 2000, true)
  if (summary === null) return undefined
  return { state: value.state, summary }
}

function outcomeOf(value: unknown): TicketOutcome | null | undefined {
  if (value === 'completed' || value === 'merged' || value === 'closed' || value === 'dropped' || value === 'stopped') return value
  return undefined
}

function reportState(value: unknown): value is ReportState {
  return value === 'progress' || value === 'waiting' || value === 'ready' || value === 'blocked' || value === 'failed' || value === 'dropped'
}

function scopeText(value: unknown): string | null {
  if (typeof value === 'string') return displayText(value, 4000, true)
  if (!jsonSafe(value) || !scopeLimitSound(value)) return null
  const encoded = JSON.stringify(value)
  return encoded.length <= 4000 ? encoded : null
}

/**
 * `maxSteps` and `maxMutations` must be non-negative safe integers.
 * `-0` and non-finite numbers are refused before `JSON.stringify` can turn them into `0` or `null`.
 * @param value - A scope value.
 * @returns False when a limit would be laundered or is not a count.
 */
export function scopeLimitSound(value: unknown): boolean {
  const walk = (item: unknown): boolean => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item) && !Object.is(item, -0)
    if (Array.isArray(item)) return item.every(walk)
    if (!isRecord(item)) return false
    for (const [key, child] of Object.entries(item)) {
      if ((key === 'maxSteps' || key === 'maxMutations') && !countLimit(child)) return false
      if (!walk(child)) return false
    }
    return true
  }
  return walk(value)
}

function countLimit(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function jsonSafe(value: unknown): boolean {
  if (value === null) return true
  if (typeof value === 'string') return displayText(value, 4000, true) !== null
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.length <= MAX_ROWS && value.every(jsonSafe)
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length <= MAX_ROWS && keys.every(key => plainId(key, 120) !== null && jsonSafe(value[key]))
}

function optionalCount(value: unknown): number | null | 'bad' {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'bad'
  return value
}

function displayText(value: unknown, max: number, allowEmpty: boolean): string | null {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length < 1)) return null
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? null : value
}

function plainId(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return null
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
