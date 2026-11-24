/**
 * Fail-closed mandate authority, executor heartbeat, and DAG head summary.
 *
 * Receipt leaves are recomputed as `seed-receipts.js` does: SHA-256 of `0x00`
 * plus canonical JSON of the receipt without `leafHash`. Checkpoints are
 * recomputed the same way, and an Ed25519 signature is checked only against
 * the pinned signer set copied from that organ's `KNOWN_SIGNER_KEYS`. A key
 * that arrives inside the checkpoint file is not added to that set.
 *
 * A leaf that recomputes and links through `prevHash` is chain-linked. That
 * is history, not permission. A pinned checkpoint signer proves that history
 * only. `owner-confirmed` also needs a signature by a key in the caller-supplied
 * owner trust list, over the grant binding, for this ball and epoch. The list
 * is empty unless the caller passes one. A name in the receipt, including
 * `owner`, is not that signature. `userVerification` stays `not-attested`.
 */
import {
  PERIPHERAL_HINT, authorityRank, canonicalJson, scopeLimitSound, STATUS_FUTURE_SKEW_MS,
  type AssignmentView, type AttentionView, type CheckpointCoverage, type MandateView, type StatusSnapshot,
} from './contract.ts'
import {
  ownerIdentityRejected, verifyOwnerAttestation, type OwnerAttestationStatus, type OwnerGrantBinding,
} from './owner-grant.ts'
import { assessPredictions } from './prediction.ts'

/** Running assignment pulse older than this is a stale heartbeat. Age equal to this stays fresh. */
export const STALE_HEARTBEAT_MS = 120_000

/** Receipt log read through `workspaceFiles` or an injected whole-file reader. */
export const RECEIPTS_LOG_PATH = '/dsh/home/auma/seed/receipts.v3.jsonl'
/** Checkpoint log. Signatures are checked here; they are not taken from tool output. */
export const CHECKPOINTS_PATH = '/dsh/home/auma/seed/checkpoints.v1.jsonl'
/** Selected ball head. */
export const BALL_HEAD_PATH = '/dsh/home/balls/HEAD.json'
/** Memory DAG head summary. Node bodies are not read. */
export const DAG_HEAD_PATH = '/dsh/home/auma/memory/dag/HEAD.json'

/**
 * Signers pinned in `seed-receipts.js`. This list is not extended from file content.
 * The readout has no owner private key. These signers are not owner trust roots.
 */
export const PINNED_RECEIPT_SIGNERS = [
  'baf94a77cb28f9575846eec092cfbd9094d4ac2c3af305a7fd8350d41c720c68',
  'a2ddc7222e4194dd856f7fc05ebddc9c18482b1eaa712d0dc9bd63da9af22e99',
] as const

const DOMAIN_PREFIX = 'aukora.x5.edge-head.v1\0'
const GENESIS = '0'.repeat(64)
const HEX_64 = /^[0-9a-f]{64}$/

/** Selected ball head, or why it could not be used. */
export type BallHeadRead =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'summary'; readonly ballId: string; readonly pearlId: string; readonly epoch: number; readonly parentBallId: string | null }

/**
 * DAG head metadata. `ancestryVerified` stays false: this object is not a walk of the nodes.
 */
export type DagHeadRead =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'summary'; readonly headId: string | null; readonly totalNodes: number | null; readonly updatedAt: string | null; readonly ancestryVerified: false }

/** One whole-file read. `bounded` means the bytes were refused rather than shortened. */
export type EvidenceFile =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'bounded' }

/**
 * Owner trust supplied beside the receipt log.
 * Keys copied from a receipt or from {@link PINNED_RECEIPT_SIGNERS} are not added.
 */
export interface OwnerAuthorityInput {
  readonly trustedKeys?: readonly string[]
  readonly attestations?: readonly unknown[]
}

/** Files the readout may use. Absence is unavailable, not an empty chain. */
export interface EvidenceBundle {
  readonly receipts: EvidenceFile
  readonly checkpoints: EvidenceFile
  readonly head: EvidenceFile
  readonly dag: EvidenceFile
}

interface ChainReceipt {
  readonly seq: number
  readonly kind: string
  readonly leafHash: string
  readonly recordedLeaf: string
  readonly data: Record<string, unknown>
  readonly intact: boolean
  /** Original receipt object, including schema, at, prevHash, and leafHash. */
  readonly source: Record<string, unknown>
}

export interface CoveringCheckpoint {
  readonly receiptCount: number
  readonly pinned: boolean
  readonly signatureValid: boolean
}

/**
 * Assess mandates, heartbeats, HEAD, and the DAG summary.
 * @param snapshot - Parsed status. Assignment `state` is copied through.
 * @param evidence - File reads. A missing log does not become an empty chain.
 * @param now - Clock for heartbeat age and future skew.
 * @param staleAfterMs - Heartbeat age strictly greater than this is stale.
 * @param owner - Separately supplied owner keys and attestations. Omitted means none.
 * @returns A snapshot with authority, heartbeat attention, HEAD, and DAG filled in.
 */
export async function applyEvidence(
  snapshot: StatusSnapshot,
  evidence: EvidenceBundle,
  now: number,
  staleAfterMs = STALE_HEARTBEAT_MS,
  owner: OwnerAuthorityInput = {},
): Promise<StatusSnapshot> {
  const chain = evidence.receipts.kind === 'ok' ? await parseReceiptChain(evidence.receipts.text) : null
  const covers = evidence.checkpoints.kind === 'ok' && chain?.kind === 'ok'
    ? await coveringCheckpoints(evidence.checkpoints.text, chain.receipts)
    : []
  const head = evidence.head.kind === 'ok' ? parseBallHead(evidence.head.text) : fileKind(evidence.head)
  const dag = evidence.dag.kind === 'ok' ? parseDagHead(evidence.dag.text) : fileKind(evidence.dag)
  const mandates = await Promise.all(snapshot.mandates.map(mandate => assessMandate(mandate, evidence, chain, covers, head, now, owner)))
  const assignments = snapshot.assignments.map(assignment => withHeartbeat(assignment, now, staleAfterMs))
  const heartbeatItems = assignments.flatMap(heartbeatAttention)
  const attention = heartbeatItems.length + snapshot.attention.length > 100
    ? snapshot.attention
    : [...snapshot.attention, ...heartbeatItems]
  return {
    ...snapshot,
    mandates,
    assignments,
    attention,
    head,
    dag,
    heartbeatBounded: heartbeatItems.length + snapshot.attention.length > 100,
    predictions: chain?.kind === 'ok'
      ? assessPredictions(chain.receipts.map(item => item.source))
      : { status: 'absent', surpriseScore: null, reason: 'prediction-log-unavailable' },
    ...(chain?.kind === 'ok' ? { checkpoints: checkpointCoverage(covers, chain.receipts.length) } : {}),
  }
}

/**
 * Coverage of the chained checkpoints `coveringCheckpoints` accepted, in file order.
 * @param covers - Accepted checkpoints.
 * @param receiptTotal - Receipts in the parsed chain.
 * @returns Count, the last one's receipt count and whether its signature verified under a pinned key.
 */
export function checkpointCoverage(covers: readonly CoveringCheckpoint[], receiptTotal: number): CheckpointCoverage {
  const last = covers.at(-1)
  return { count: covers.length, lastReceiptCount: last?.receiptCount ?? null, receiptTotal, lastSigned: last?.signatureValid === true }
}

/**
 * Parse a ball HEAD object.
 * @param text - `HEAD.json` text.
 * @returns The head, or malformed when ball id or epoch is not usable.
 */
export function parseBallHead(text: string): BallHeadRead {
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { return { kind: 'malformed' } }
  if (!isRecord(value) || typeof value.ballId !== 'string' || !HEX_64.test(value.ballId)) return { kind: 'malformed' }
  if (typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch) || value.epoch < 0) return { kind: 'malformed' }
  const parent = typeof value.parentBallId === 'string' && HEX_64.test(value.parentBallId) ? value.parentBallId : null
  return { kind: 'summary', ballId: value.ballId, pearlId: value.ballId, epoch: value.epoch, parentBallId: parent }
}

/**
 * Parse DAG `HEAD.json` metadata only.
 * @param text - File text.
 * @returns Summary fields. Node contents are ignored. Ancestry is not verified.
 */
export function parseDagHead(text: string): DagHeadRead {
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { return { kind: 'malformed' } }
  if (!isRecord(value)) return { kind: 'malformed' }
  const direct = typeof value.headId === 'string' ? value.headId : null
  const listed = Array.isArray(value.heads) && typeof value.heads[0] === 'string' ? value.heads[0] : null
  if (direct !== null && listed !== null && direct !== listed) return { kind: 'malformed' }
  const headId = direct ?? listed
  if (headId !== null && !HEX_64.test(headId)) return { kind: 'malformed' }
  const totalNamed = typeof value.totalNodes === 'number' ? value.totalNodes : null
  const counted = typeof value.count === 'number' ? value.count : null
  if (totalNamed !== null && counted !== null && totalNamed !== counted) return { kind: 'malformed' }
  const total = totalNamed ?? counted
  if (total !== null && (!Number.isSafeInteger(total) || total < 0)) return { kind: 'malformed' }
  let updatedAt: string | null = null
  if (typeof value.updatedAt === 'string' && value.updatedAt.length > 0 && value.updatedAt.length <= 80) updatedAt = value.updatedAt
  else if (typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)) updatedAt = String(value.updatedAt)
  else if (value.updatedAt !== undefined) return { kind: 'malformed' }
  if (headId === null && total === null && updatedAt === null) return { kind: 'malformed' }
  return { kind: 'summary', headId, totalNodes: total, updatedAt, ancestryVerified: false }
}

async function assessMandate(
  mandate: MandateView,
  evidence: EvidenceBundle,
  chain: ChainParse | null,
  covers: readonly CoveringCheckpoint[],
  head: BallHeadRead,
  now: number,
  owner: OwnerAuthorityInput,
): Promise<MandateView> {
  const reasons: string[] = []
  if (mandate.confirmed === false && mandate.grant === null) {
    const refused = refusedHash(mandate, evidence, chain)
    if (refused !== 'grant-receipt') return refused
  }
  const claim = mandate.receiptLeafHash !== null || mandate.confirmed === true || mandate.confirmedBy !== null || mandate.grant !== null
  if (evidence.receipts.kind !== 'ok') {
    reasons.push(evidence.receipts.kind === 'missing' ? 'receipt-log-missing' : 'receipt-log-unavailable')
    return finish(mandate, claim ? 'self-attested' : 'unavailable', reasons, null, 'unknown')
  }
  if (chain === null || chain.kind !== 'ok') {
    return finish(mandate, claim ? 'self-attested' : 'unavailable', ['receipt-log-malformed'], null, 'unknown')
  }
  if (!claim) return finish(mandate, 'unknown', ['no-receipt-claim'], null, 'unknown')
  if (mandate.receiptLeafHash === null) {
    return finish(mandate, 'self-attested', ['confirmation-claim'], null, 'unknown')
  }
  const linked = chain.receipts.find(receipt =>
    receipt.recordedLeaf === mandate.receiptLeafHash || receipt.leafHash === mandate.receiptLeafHash)
  if (linked === undefined) return finish(mandate, 'self-attested', ['hash-not-in-chain'], null, 'unknown')
  if (linked.recordedLeaf === mandate.receiptLeafHash && linked.leafHash !== mandate.receiptLeafHash) {
    return finish(mandate, 'self-attested', ['leaf-recompute-mismatch'], linked, 'unknown')
  }
  if (!linked.intact) return finish(mandate, 'self-attested', ['chain-broken'], linked, 'unknown')
  if (peripheralReceipt(linked) || mandate.grant?.kind === 'aura.signal') {
    return finish(mandate, 'self-attested', ['aura-signal-not-authority'], linked, 'unknown')
  }
  const contradictions = contradictionsOf(mandate, linked)
  if (contradictions.length > 0) return finish(mandate, 'self-attested', contradictions, linked, 'unknown')
  const bound = grantBinds(mandate, linked)
  if (!bound) reasons.push('hash-linked-without-grant')
  const covered = covers.some(item => item.pinned && item.signatureValid && item.receiptCount >= linked.seq)
  if (!covered) reasons.push(evidence.checkpoints.kind === 'ok' ? 'checkpoint-not-owner-authority' : 'checkpoint-unavailable')
  const lineage = classifyHead(mandate, linked, chain.receipts, head, reasons)
  const headOk = lineage === 'same-ball'
  const identity = identityOf(mandate, linked)
  if (identity.identitySource === 'contradictory' || identity.identitySource === 'confirmed-by-only') {
    reasons.push(identity.identitySource === 'contradictory' ? 'identity-contradictory' : 'identity-not-in-receipt')
  }
  if (revoked(chain.receipts, linked, mandate.id)) reasons.push('grant-revoked')
  if (grantExpired(linked, now)) reasons.push('grant-expired')
  const identityOk = identity.identitySource === 'grant-receipt' || identity.identitySource === 'absent'
  const candidates = bound ? attestationCandidates(mandate, linked, owner) : []
  const ownerStatus = bound ? await ownerStatusOf(mandate, linked, owner, candidates) : 'missing'
  if (bound && candidates.some(presenceFlag)) reasons.push('presence-flag-ignored')
  if (bound && ownerStatus !== 'verified') reasons.push(ownerReason(ownerStatus))
  if (bound && ownerStatus === 'verified' && ownerIdentityRejected(identity.identityClaim)) reasons.push('owner-identity-rejected')
  if (bound && ownerStatus === 'verified' && !headOk) reasons.push('owner-attestation-not-extended')
  if (bound && covered && !reasons.includes('pinned-checkpoint-covers-grant')) reasons.push('pinned-checkpoint-covers-grant')
  const ownerOk = ownerStatus === 'verified'
    && !reasons.includes('owner-identity-rejected')
    && !reasons.includes('owner-attestation-not-extended')
  if (bound && headOk && identityOk && ownerOk && !reasons.includes('grant-revoked') && !reasons.includes('grant-expired')) {
    const confirmed = ['owner-attestation-verified', 'user-verification-not-attested']
    if (reasons.includes('presence-flag-ignored')) confirmed.push('presence-flag-ignored')
    return finish(mandate, 'owner-confirmed', confirmed, linked, lineage)
  }
  return finish(mandate, 'chain-linked', reasons, linked, lineage)
}

function finish(
  mandate: MandateView,
  level: MandateView['authority']['level'],
  reasons: readonly string[],
  receipt: ChainReceipt | null,
  lineage: MandateView['authority']['lineage'],
): MandateView {
  const identity = identityOf(mandate, receipt)
  const provenance = level === 'owner-confirmed' ? 'owner-attestation'
    : level === 'chain-linked' ? 'chain'
      : level === 'self-attested' ? 'claim'
        : 'none'
  const statusReasons = level !== 'owner-confirmed' && mandate.confirmed === true
    ? [...reasons, 'status-boolean-not-owner-authority']
    : reasons
  return {
    ...mandate,
    authority: {
      level,
      reasons: statusReasons,
      identityClaim: identity.identityClaim,
      identitySource: identity.identitySource,
      userVerification: 'not-attested',
      provenance,
      lineage,
      pearlLineage: lineage,
      passkeyVerified: false,
      credentialId: null,
      aumlokBinding: 'unknown',
    },
  }
}

/**
 * A refused confirm stores no grant. A hash of some other receipt is not linkage.
 * `receiptLeafHash` is the field `parseMandate` kept; `receiptHash` is only a fallback
 * when `receiptLeafHash` was null. A real `mandate.grant` leaf for this id still falls through.
 */
function refusedHash(
  mandate: MandateView,
  evidence: EvidenceBundle,
  chain: ChainParse | null,
): MandateView | 'grant-receipt' {
  if (mandate.receiptLeafHash === null) return finish(mandate, 'unknown', ['no-receipt-claim'], null, 'unknown')
  if (evidence.receipts.kind !== 'ok') {
    const reason = evidence.receipts.kind === 'missing' ? 'receipt-log-missing' : 'receipt-log-unavailable'
    return finish(mandate, 'unknown', [reason, 'non-grant-receipt-ignored'], null, 'unknown')
  }
  if (chain === null || chain.kind !== 'ok') {
    return finish(mandate, 'unknown', ['receipt-log-malformed', 'non-grant-receipt-ignored'], null, 'unknown')
  }
  const linked = chain.receipts.find(receipt =>
    receipt.recordedLeaf === mandate.receiptLeafHash || receipt.leafHash === mandate.receiptLeafHash)
  const grantLeaf = linked !== undefined
    && linked.intact
    && linked.leafHash === mandate.receiptLeafHash
    && linked.kind === 'mandate.grant'
    && linked.data.mandateId === mandate.id
  if (grantLeaf) return 'grant-receipt'
  return finish(mandate, 'unknown', ['non-grant-receipt-ignored'], null, 'unknown')
}

function identityOf(mandate: MandateView, receipt: ChainReceipt | null): {
  identityClaim: string | null
  identitySource: MandateView['authority']['identitySource']
} {
  const grantId = mandate.grant?.identity ?? null
  const dataId = receipt !== null && typeof receipt.data.identity === 'string' && receipt.data.identity.length > 0
    ? receipt.data.identity
    : null
  if (grantId !== null && dataId !== null && grantId !== dataId) return { identityClaim: null, identitySource: 'contradictory' }
  if (mandate.confirmedBy !== null && dataId !== null && mandate.confirmedBy !== dataId) {
    return { identityClaim: null, identitySource: 'contradictory' }
  }
  if (dataId !== null) return { identityClaim: dataId, identitySource: 'grant-receipt' }
  if (grantId !== null) return { identityClaim: null, identitySource: 'absent' }
  if (mandate.confirmedBy !== null) return { identityClaim: mandate.confirmedBy, identitySource: 'confirmed-by-only' }
  return { identityClaim: null, identitySource: 'absent' }
}

async function ownerStatusOf(
  mandate: MandateView,
  receipt: ChainReceipt,
  owner: OwnerAuthorityInput,
  list: readonly unknown[],
): Promise<OwnerAttestationStatus> {
  if (!scopeLimitSound(receipt.data.scope)) return 'malformed'
  const binding = ownerBinding(mandate, receipt)
  if (list.length === 0) return 'missing'
  let fallback: OwnerAttestationStatus = 'missing'
  for (const item of list) {
    const status = await verifyOwnerAttestation(binding, item, owner.trustedKeys ?? [])
    if (status === 'verified') return 'verified'
    if (fallback === 'missing') fallback = status
  }
  return fallback
}

function attestationCandidates(
  mandate: MandateView,
  receipt: ChainReceipt,
  owner: OwnerAuthorityInput,
): readonly unknown[] {
  const found: unknown[] = [...(owner.attestations ?? []), ...mandate.ownerGrants]
  if (receipt.intact && receipt.kind === 'mandate.grant' && receipt.data.mandateId === mandate.id) {
    const embedded = receipt.data.ownerGrant
    if (embedded !== undefined && embedded !== null) found.push(embedded)
  }
  return found
}

function ownerBinding(mandate: MandateView, receipt: ChainReceipt): OwnerGrantBinding {
  const scope = isRecord(receipt.data.scope) ? receipt.data.scope : null
  const expiresAt = scope !== null && typeof scope.expiresAt === 'number' && Number.isFinite(scope.expiresAt) ? scope.expiresAt : null
  return {
    mandateId: mandate.id,
    ticketId: typeof receipt.data.ticketId === 'string' ? receipt.data.ticketId : null,
    scope,
    ballId: typeof receipt.data.ballId === 'string' ? receipt.data.ballId : null,
    epoch: typeof receipt.data.epoch === 'number' ? receipt.data.epoch : null,
    expiresAt,
    identity: typeof receipt.data.identity === 'string' ? receipt.data.identity : '',
  }
}

function presenceFlag(value: unknown): boolean {
  if (!isRecord(value)) return false
  return 'passkeyVerified' in value || 'credentialId' in value || 'aumlokBinding' in value || 'userVerification' in value
}

function ownerReason(status: OwnerAttestationStatus): string {
  switch (status) {
    case 'verified': return 'owner-attestation-verified'
    case 'missing': return 'owner-attestation-missing'
    case 'malformed': return 'owner-attestation-malformed'
    case 'untrusted-key': return 'owner-key-untrusted'
    case 'bad-signature': return 'owner-signature-invalid'
    case 'binding-mismatch': return 'owner-binding-mismatch'
  }
}

function revoked(receipts: readonly ChainReceipt[], grant: ChainReceipt, mandateId: string): boolean {
  return receipts.some(receipt =>
    receipt.intact && receipt.seq > grant.seq && receipt.kind === 'mandate.revoke' && receipt.data.mandateId === mandateId)
}

function grantExpired(receipt: ChainReceipt, now: number): boolean {
  const scope = receipt.data.scope
  if (!isRecord(scope) || typeof scope.expiresAt !== 'number' || !Number.isFinite(scope.expiresAt)) return false
  return now > scope.expiresAt
}

function contradictionsOf(mandate: MandateView, receipt: ChainReceipt): string[] {
  const reasons: string[] = []
  const data = receipt.data
  if (typeof data.mandateId === 'string' && data.mandateId !== mandate.id) reasons.push('identity-mismatch')
  if (mandate.grant !== null) {
    if (mandate.grant.seq !== receipt.seq) reasons.push('grant-seq-mismatch')
    if (mandate.grant.hash !== receipt.leafHash) reasons.push('grant-hash-mismatch')
    if (mandate.grant.kind !== receipt.kind) reasons.push('grant-kind-mismatch')
    if (mandate.grant.scope !== null && comparable(data.scope) !== null && comparable(data.scope) !== mandate.grant.scope) reasons.push('scope-mismatch')
    if (mandate.grant.ticketId !== null && typeof data.ticketId === 'string' && data.ticketId !== mandate.grant.ticketId) reasons.push('ticket-mismatch')
    if (mandate.grant.identity !== null && typeof data.identity === 'string' && data.identity !== mandate.grant.identity) reasons.push('identity-mismatch')
    if (mandate.grant.ballId !== null && typeof data.ballId === 'string' && data.ballId !== mandate.grant.ballId) reasons.push('ball-mismatch')
    if (mandate.grant.epoch !== null && data.epoch !== undefined && data.epoch !== mandate.grant.epoch) reasons.push('epoch-mismatch')
  }
  if (mandate.ballId !== null && typeof data.ballId === 'string' && data.ballId !== mandate.ballId) reasons.push('ball-mismatch')
  return [...new Set(reasons)]
}

function peripheralReceipt(receipt: ChainReceipt): boolean {
  if (receipt.kind === 'aura.signal') return true
  const tier = receipt.data.authorityTier
  return tier === PERIPHERAL_HINT || (tier === 'owner-confirmed' && receipt.kind !== 'mandate.grant')
}

function grantBinds(mandate: MandateView, receipt: ChainReceipt): boolean {
  if (authorityRank(PERIPHERAL_HINT) >= authorityRank('self-attested')) return false
  if (peripheralReceipt(receipt)) return false
  if (mandate.grant === null) return false
  if (mandate.grant.seq !== receipt.seq || mandate.grant.hash !== receipt.leafHash || mandate.grant.kind !== receipt.kind) return false
  if (receipt.data.mandateId !== mandate.id) return false
  if (mandate.grant.scope !== null && comparable(receipt.data.scope) !== mandate.grant.scope) return false
  return true
}

function classifyHead(
  mandate: MandateView,
  receipt: ChainReceipt,
  receipts: readonly ChainReceipt[],
  head: BallHeadRead,
  reasons: string[],
): MandateView['authority']['lineage'] {
  if (head.kind !== 'summary') {
    reasons.push(head.kind === 'malformed' ? 'head-malformed' : 'head-unavailable')
    return 'unknown'
  }
  const ball = grantBall(mandate, receipt)
  const epoch = grantEpoch(mandate, receipt)
  if (ball === null) {
    reasons.push('ball-mismatch')
    return 'unrelated'
  }
  if (head.ballId === ball) {
    if (epoch !== null && epoch !== head.epoch) {
      reasons.push('epoch-mismatch')
      return 'unrelated'
    }
    return 'same-ball'
  }
  const promoted = promoteChain(receipts, receipt.seq, ball, epoch, head)
  if (promoted === 'linked') {
    reasons.push('ball-advanced-since-grant')
    return 'promoted'
  }
  if (promoted === 'epoch-mismatch') {
    reasons.push('promote-epoch-mismatch')
    return 'unrelated'
  }
  if (promoted === 'fork') {
    reasons.push('promote-fork')
    return 'unrelated'
  }
  if (head.parentBallId === ball) {
    reasons.push('ball-head-claim-only')
    return 'head-claim-only'
  }
  reasons.push('ball-mismatch')
  return 'unrelated'
}

function grantBall(mandate: MandateView, receipt: ChainReceipt): string | null {
  const named = mandate.grant?.ballId
  if (named !== null && named !== undefined && HEX_64.test(named)) return named
  if (typeof receipt.data.ballId === 'string' && HEX_64.test(receipt.data.ballId)) return receipt.data.ballId
  if (mandate.ballId !== null && HEX_64.test(mandate.ballId)) return mandate.ballId
  return null
}

function grantEpoch(mandate: MandateView, receipt: ChainReceipt): number | null {
  if (mandate.grant?.epoch !== null && mandate.grant?.epoch !== undefined) return mandate.grant.epoch
  return typeof receipt.data.epoch === 'number' && Number.isSafeInteger(receipt.data.epoch) ? receipt.data.epoch : null
}

/** Kinds whose data can carry a ball edge. `ball.promote` is historical. The loader uses the others. */
const PROMOTE_KINDS = new Set(['ball.promote', 'tree.patch', 'tree.undo', 'snapshot.restore', 'seed.bootstrap'])

/** One intact successor edge. Extra data fields are ignored. */
export interface PromoteEdge {
  readonly seq: number
  readonly ballId: string
  readonly parentBallId: string
  readonly epoch: number
}

/**
 * Read a successor edge from one receipt.
 * A loader mutation stores `{ entryId, ballId, parentBallId, epoch }` under `tree.patch`,
 * `tree.undo`, `snapshot.restore`, or `seed.bootstrap`. Historical logs also use `ball.promote`
 * and `ball.epochN`. The kind is not owner consent, and a missing epoch is not a link.
 * @param receipt - One parsed receipt. `intact` is required.
 * @returns The edge, `bad-epoch` when the ids are present but the epoch is not a safe integer, or null.
 */
export function extractPromoteEdge(receipt: {
  readonly kind: string
  readonly intact: boolean
  readonly seq: number
  readonly data: Readonly<Record<string, unknown>>
}): PromoteEdge | 'bad-epoch' | null {
  if (!receipt.intact) return null
  if (receipt.kind === 'aura.signal' || receipt.data.authorityTier === PERIPHERAL_HINT || receipt.data.authorityTier === 'owner-confirmed') {
    return null
  }
  const epochKind = /^ball\.epoch[1-9][0-9]*$/.test(receipt.kind)
  if (!PROMOTE_KINDS.has(receipt.kind) && !epochKind) return null
  const ballId = receipt.data.ballId
  const parentBallId = receipt.data.parentBallId
  if (typeof ballId !== 'string' || !HEX_64.test(ballId)) return null
  if (typeof parentBallId !== 'string' || !HEX_64.test(parentBallId) || parentBallId === ballId) return null
  const epoch = receipt.data.epoch
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return 'bad-epoch'
  return { seq: receipt.seq, ballId, parentBallId, epoch }
}

function promoteChain(
  receipts: readonly ChainReceipt[],
  grantSeq: number,
  fromBall: string,
  grantEpoch: number | null,
  head: Extract<BallHeadRead, { kind: 'summary' }>,
): 'linked' | 'epoch-mismatch' | 'fork' | 'none' {
  let cursor = fromBall
  let epochFloor: number | null = null
  const used = new Set<number>()
  while (cursor !== head.ballId) {
    const edges: PromoteEdge[] = []
    let badEpoch = false
    for (const item of receipts) {
      if (item.seq <= grantSeq || used.has(item.seq)) continue
      const read = extractPromoteEdge(item)
      if (read === null) continue
      if (read === 'bad-epoch') {
        if (item.data.parentBallId === cursor) badEpoch = true
        continue
      }
      if (read.parentBallId === cursor) edges.push(read)
    }
    if (badEpoch) return 'epoch-mismatch'
    if (edges.length === 0) return 'none'
    const ballIds = new Set(edges.map(edge => edge.ballId))
    if (ballIds.size !== 1) return 'fork'
    const epochs = new Set(edges.map(edge => edge.epoch))
    if (epochs.size !== 1) return 'epoch-mismatch'
    const edge = edges[0]
    if (edge === undefined) return 'none'
    const predecessor = epochFloor === null ? grantEpoch : epochFloor
    const expected: number = predecessor === null ? edge.epoch : predecessor + 1
    if (edge.epoch !== expected) return 'epoch-mismatch'
    epochFloor = edge.epoch
    for (const step of edges) used.add(step.seq)
    cursor = edge.ballId
    if (used.size > receipts.length) return 'none'
  }
  if (cursor === fromBall || epochFloor === null || head.epoch !== epochFloor) return 'epoch-mismatch'
  return 'linked'
}

type ChainParse = { kind: 'ok'; receipts: readonly ChainReceipt[] } | { kind: 'malformed' }

async function parseReceiptChain(text: string): Promise<ChainParse> {
  if (text.length > 262_144) return { kind: 'malformed' }
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const receipts: ChainReceipt[] = []
  let previous = GENESIS
  let intact = true
  for (let index = 0; index < lines.length; index += 1) {
    let row: unknown
    try { row = JSON.parse(lines[index] ?? '') as unknown } catch { return { kind: 'malformed' } }
    if (!isRecord(row) || row.schema !== 'aukora.receipt.v3' || row.seq !== index + 1) return { kind: 'malformed' }
    if (typeof row.prevHash !== 'string' || typeof row.leafHash !== 'string' || typeof row.kind !== 'string') return { kind: 'malformed' }
    const { leafHash, ...payload } = row
    const recomputed = await sha256Hex(prefixed(0x00, canonicalJson(payload)))
    const link = row.prevHash === previous && recomputed === leafHash && intact
    if (!link) intact = false
    receipts.push({
      seq: index + 1,
      kind: row.kind,
      leafHash: recomputed,
      recordedLeaf: leafHash,
      data: isRecord(row.data) ? row.data : {},
      intact: link,
      source: row,
    })
    previous = recomputed === leafHash ? leafHash : `broken-${String(index)}`
  }
  return { kind: 'ok', receipts }
}

async function coveringCheckpoints(text: string, receipts: readonly ChainReceipt[]): Promise<CoveringCheckpoint[]> {
  if (text.length > 262_144) return []
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const found: CoveringCheckpoint[] = []
  let previous: string | null = null
  for (const line of lines) {
    let row: unknown
    try { row = JSON.parse(line) as unknown } catch { return found }
    if (!isRecord(row) || !isRecord(row.body) || typeof row.publicKeyHex !== 'string' || typeof row.signatureHex !== 'string') return found
    const body = row.body
    if (body.prevCheckpointHash !== previous) return found
    const checkpointHash = await sha256Hex(canonicalJson({ body, publicKeyHex: row.publicKeyHex, signatureHex: row.signatureHex }))
    if (row.checkpointHash !== checkpointHash) return found
    const pinned = (PINNED_RECEIPT_SIGNERS as readonly string[]).includes(row.publicKeyHex)
    const count = typeof body.receiptCount === 'number' ? body.receiptCount : -1
    const leaves = receipts.slice(0, count).filter(item => item.intact).map(item => item.leafHash)
    const root = leaves.length === count ? await merkleRoot(leaves) : null
    const rootOk = root !== null && body.merkleRoot === root
    const signatureValid = pinned && rootOk && await verifyEd25519(row.publicKeyHex, row.signatureHex, DOMAIN_PREFIX + canonicalJson(body))
    if (typeof body.receiptCount === 'number') found.push({ receiptCount: body.receiptCount, pinned, signatureValid })
    previous = checkpointHash
  }
  return found
}

function withHeartbeat(assignment: AssignmentView, now: number, staleAfterMs: number): AssignmentView {
  if (assignment.state !== 'running') return { ...assignment, heartbeat: { availability: 'not-running', ageMs: null } }
  const chosen = pulseOf(assignment)
  if (chosen.kind === 'missing') return { ...assignment, heartbeat: { availability: 'missing', ageMs: null } }
  if (chosen.kind === 'invalid') return { ...assignment, heartbeat: { availability: 'invalid', ageMs: null } }
  const age = now - chosen.at
  if (age < -STATUS_FUTURE_SKEW_MS) return { ...assignment, heartbeat: { availability: 'future', ageMs: age } }
  if (age > staleAfterMs) return { ...assignment, heartbeat: { availability: 'stale', ageMs: age } }
  return { ...assignment, heartbeat: { availability: 'fresh', ageMs: age } }
}

function pulseOf(assignment: AssignmentView): { kind: 'time'; at: number } | { kind: 'missing' } | { kind: 'invalid' } {
  if (assignment.pulse.heartbeat === 'invalid') return { kind: 'invalid' }
  if (typeof assignment.pulse.heartbeat === 'number') return { kind: 'time', at: assignment.pulse.heartbeat }
  if (assignment.pulse.report === 'invalid') return { kind: 'invalid' }
  if (typeof assignment.pulse.report === 'number') return { kind: 'time', at: assignment.pulse.report }
  if (assignment.pulse.started === 'invalid') return { kind: 'invalid' }
  if (typeof assignment.pulse.started === 'number') return { kind: 'time', at: assignment.pulse.started }
  return { kind: 'missing' }
}

function heartbeatAttention(assignment: AssignmentView): AttentionView[] {
  const availability = assignment.heartbeat.availability
  if (availability !== 'stale' && availability !== 'missing' && availability !== 'invalid' && availability !== 'future') return []
  const kind = availability === 'stale' ? 'stale-heartbeat'
    : availability === 'missing' ? 'heartbeat-missing'
      : availability === 'invalid' ? 'heartbeat-invalid'
        : 'heartbeat-future'
  return [{ id: `heartbeat:${assignment.id}`, kind, text: assignment.id, source: 'heartbeat' }]
}

function fileKind(file: EvidenceFile): { kind: 'unavailable' | 'missing' | 'malformed' } {
  if (file.kind === 'missing') return { kind: 'missing' }
  if (file.kind === 'malformed' || file.kind === 'bounded') return { kind: 'malformed' }
  return { kind: 'unavailable' }
}

function comparable(value: unknown): string | null {
  if (typeof value === 'string') return canonicalJson(value)
  if (value === undefined) return null
  try { return canonicalJson(value) } catch { return null }
}

async function merkleRoot(leaves: readonly string[]): Promise<string> {
  if (leaves.length === 0) return sha256Hex('')
  let level = leaves.map(hexToBytes)
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]
      const right = level[index + 1]
      if (left === undefined) break
      if (right === undefined) next.push(left)
      else next.push(hexToBytes(await sha256Hex(concat(Uint8Array.of(0x01), left, right))))
    }
    level = next
  }
  return bytesToHex(level[0] ?? new Uint8Array())
}

async function verifyEd25519(publicKeyHex: string, signatureHex: string, message: string): Promise<boolean> {
  if (!HEX_64.test(publicKeyHex) || !/^[0-9a-f]{128}$/.test(signatureHex)) return false
  try {
    const key = await crypto.subtle.importKey('raw', bytesOf(hexToBytes(publicKeyHex)), { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, bytesOf(hexToBytes(signatureHex)), new TextEncoder().encode(message))
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotSupportedError') return false
    return false
  }
}

async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  const digest = await crypto.subtle.digest('SHA-256', bytesOf(data))
  return bytesToHex(new Uint8Array(digest))
}

function prefixed(byte: number, text: string): Uint8Array {
  const body = new TextEncoder().encode(text)
  const out = new Uint8Array(body.length + 1)
  out[0] = byte
  out.set(body, 1)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function bytesOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
