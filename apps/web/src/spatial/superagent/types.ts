/**
 * Public readout types for discovery trajectories and Nostr projection.
 * Receipt field names stay `ballId` on the wire. `pearlId` is the reader name.
 */

/** One receipt row presented to the discovery corpus. Leaf bytes are not recomputed here. */
export interface ReceiptHistoryEntry {
  readonly seq: number
  readonly kind: string
  readonly intact: boolean
  readonly leafHash: string
  readonly prevHash: string
  readonly data: Readonly<Record<string, unknown>>
}

/** One register, promotion, and observation triple. Chain order is not proof of learning. */
export interface DiscoveryTrajectoryRecord {
  readonly trajectoryId: string
  readonly pearlId: string
  readonly epochBefore: number
  readonly epochAfter: number
  readonly predicted: number
  readonly observed: number
  readonly surpriseScore: number
  readonly registerReceiptHash: string
  readonly promotionReceiptHash: string
  readonly observeReceiptHash: string
  readonly exceptionRuleCandidate: boolean
}

/** Deterministic corpus. `meanSurpriseScore` is null when there are no trajectories. */
export interface DiscoveryTrajectorySummary {
  readonly totalTrajectories: number
  readonly zeroSurpriseCount: number
  readonly surpriseCount: number
  readonly meanSurpriseScore: number | null
}

/** Exported trajectories plus the chain checks this function actually performed. */
export interface DiscoveryTrajectoryCorpus {
  readonly records: readonly DiscoveryTrajectoryRecord[]
  readonly summary: DiscoveryTrajectorySummary
  /** True when seq order and consecutive prevHash links hold and every row is intact. */
  readonly chainIntact: boolean
  /**
   * Leaf SHA-256 is not recomputed. A later verifier needs the original receipt
   * payload, the `0x00` prefix, and these hashes.
   */
  readonly leafRecomputed: false
  readonly checks: readonly string[]
}

/** NIP-01 event fields. A well-formed `sig` is not a verified Schnorr signature. */
export interface NostrEventFields {
  readonly id: string
  readonly pubkey: string
  readonly created_at: number
  readonly kind: number
  readonly tags: readonly (readonly string[])[]
  readonly content: string
  readonly sig: string
}

/** Where a projection is willing to talk about delivery. Local storage is never delivery. */
export type MicroverseTier = 'microverse-local' | 'macroverse-nip44-dm' | 'macroverse-marmot-mls'

/** Caller-supplied relay note. This module does not contact the relay. */
export interface RelayEvidenceClaim {
  readonly eventId: string
  readonly relayUrl: string
}

/** Marmot group metadata. Presence is not MLS encryption or forward secrecy. */
export interface MarmotGroupMetadata {
  readonly groupId: string
  readonly epoch: number
  readonly cipherSuite: string
  readonly memberPubkeys: readonly string[]
}

/** Result of {@link projectNostrMicroverse}. Crypto claims stay false when the verifier is absent. */
export interface MicroverseProjection {
  readonly tier: MicroverseTier | 'malformed'
  readonly grammar: 'valid' | 'malformed'
  readonly idValid: boolean
  readonly signatureValid: false
  readonly signatureStatus: 'bip340-verifier-unavailable' | 'malformed-sig' | 'not-checked'
  readonly deliveryVerified: false
  readonly deliveryStatus: 'unperformed' | 'local-not-delivery'
  readonly nip44Verified: false
  readonly mlsEncryptionVerified: false
  readonly mlsForwardSecrecyVerified: false
  readonly marmotMetadata: 'absent' | 'present' | 'malformed'
  readonly pearlId: string | null
  readonly receiptHash: string | null
  readonly mandateId: string | null
  readonly trajectoryId: string | null
  readonly reasons: readonly string[]
}
