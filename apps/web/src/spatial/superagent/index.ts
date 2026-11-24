/**
 * Spatial SuperAgent work graph and Attention readout.
 *
 * The page root owns the Spatial root, room mount, and `SpatialControls`. This entry
 * does not import or modify them. Call {@link mountSuperagentRooms} with empty
 * elements inside the existing World and Self rooms after `connectWorkerHost`.
 * Mount and live integration are unverified until that call is on the one page root.
 *
 * The readout uses the existing `POST /__x6__/call-tool` worker route. It does
 * not create a session, an iframe, or a second assistant, and it has no control
 * that mints a mandate.
 */
export {
  CALL_TOOL_PATH, RECEIPT_TOOL_NAME, RECEIPT_VERIFY_ARGS, STATUS_FRESH_MS, STATUS_READ_ARGS,
  STATUS_SCHEMA, SUPERAGENT_TOOL_NAMES, classifyToolBody, pageTunnelFetch, parseReceipt, parseStatus,
} from './contract.ts'
export type {
  AssignmentView, AttentionView, MandateView, ReceiptRead, StatusFailure, StatusSnapshot, SuperagentPhase,
  TicketView, TunnelFetch,
} from './contract.ts'
export {
  BALL_HEAD_PATH, CHECKPOINTS_PATH, DAG_HEAD_PATH, PINNED_RECEIPT_SIGNERS, RECEIPTS_LOG_PATH,
  STALE_HEARTBEAT_MS, applyEvidence, extractPromoteEdge, parseBallHead, parseDagHead,
} from './authority.ts'
export {
  OWNER_GRANT_DOMAIN, OWNER_GRANT_SCHEMA, REJECTED_OWNER_IDENTITIES, ownerGrantCanonical, ownerIdentityRejected,
  verifyOwnerAttestation,
} from './owner-grant.ts'
export type { OwnerAttestationStatus, OwnerGrantBinding } from './owner-grant.ts'
export type { OwnerAuthorityInput } from './authority.ts'
export {
  MANIFEST_DOMAIN, MANIFEST_SIGNATURE_SCHEMA, canonManifestPreimage, loaderManifestPreimage,
  manifestDigest, monotoneParent, verifyManifestSignature,
} from './manifest.ts'
export type { ManifestIdForm, ManifestVerifyResult, ParentLinkResult } from './manifest.ts'
export { scopeLimitSound } from './contract.ts'
export type { PredictionReadout } from './contract.ts'
export { assessPredictions, discoveryJsonl, projectDiscoveryCorpus, surpriseScore } from './prediction.ts'
export { nip01EventId, projectNostrMicroverse } from './nostr-microverse.ts'
export type { MicroverseInput } from './nostr-microverse.ts'
export type {
  DiscoveryTrajectoryCorpus, DiscoveryTrajectoryRecord, DiscoveryTrajectorySummary, MarmotGroupMetadata,
  MicroverseProjection, MicroverseTier, NostrEventFields, ReceiptHistoryEntry, RelayEvidenceClaim,
} from './types.ts'
export { createSuperagentRead } from './read.ts'
export type { SuperagentRead, SuperagentReadOptions } from './read.ts'
export { paintLines } from './present.ts'
export type { PaintedLine, SuperagentRoom } from './present.ts'
export { mountSuperagentRooms } from './view.ts'
export type { MountedSuperagentRooms, MountSuperagentRoomsOptions, ReadoutDocument, ReadoutNode } from './view.ts'
