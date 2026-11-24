/**
 * Strict hybrid signed-action envelope verification (aukora.x61.signed-action.v1).
 * Uses dual Ed25519 + ML-DSA-65 verification from owner-grant-policy.mjs with
 * mandatory owner/node key separation, epoch fencing, and safe-integer expiry.
 * Never substitutes for Class 3 WebAuthn passkey approval on T2 mutations.
 */
import {
  canonicalJson,
  ownerGrantFailure,
  requireOwnerNodeKeySeparation,
  verifyHybridEnvelopeV2,
} from './owner-grant-policy.mjs'

export const SIGNED_ACTION_SCHEMA = 'aukora.x61.signed-action.v1'
const HEX_64 = /^[0-9a-f]{64}$/
const ACTION_ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/
const ACTION_NAME_RE = /^[a-z][a-z0-9_.-]{1,63}$/
const FIELDS = Object.freeze([
  'schema',
  'actionId',
  'action',
  'audience',
  'ballId',
  'epoch',
  'expiresAt',
  'targetDigest',
])

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function unsignedSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

export function normalizeSignedActionPayload(input, { expectedAudience = null, now = Date.now() } = {}) {
  if (!plainRecord(input) || !unsignedSafeInt(now)) {
    ownerGrantFailure('SIGNED_ACTION_MALFORMED', 400)
  }
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (
    Reflect.ownKeys(descriptors).length !== FIELDS.length ||
    FIELDS.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))
  ) {
    ownerGrantFailure('SIGNED_ACTION_MALFORMED', 400)
  }
  const payload = Object.fromEntries(FIELDS.map(key => [key, descriptors[key].value]))
  if (payload.schema !== SIGNED_ACTION_SCHEMA) ownerGrantFailure('SIGNED_ACTION_SCHEMA_INVALID', 400)
  if (typeof payload.actionId !== 'string' || !ACTION_ID_RE.test(payload.actionId)) {
    ownerGrantFailure('SIGNED_ACTION_ID_INVALID', 400)
  }
  if (typeof payload.action !== 'string' || !ACTION_NAME_RE.test(payload.action)) {
    ownerGrantFailure('SIGNED_ACTION_TYPE_INVALID', 400)
  }
  if (typeof payload.audience !== 'string' || payload.audience.length < 8 || payload.audience.length > 256) {
    ownerGrantFailure('SIGNED_ACTION_AUDIENCE_INVALID', 403)
  }
  if (expectedAudience !== null && payload.audience !== expectedAudience) {
    ownerGrantFailure('SIGNED_ACTION_AUDIENCE_MISMATCH', 403)
  }
  if (typeof payload.ballId !== 'string' || !HEX_64.test(payload.ballId)) {
    ownerGrantFailure('SIGNED_ACTION_BALL_INVALID', 400)
  }
  if (!unsignedSafeInt(payload.epoch)) {
    ownerGrantFailure('SIGNED_ACTION_EPOCH_INVALID', 400)
  }
  if (!unsignedSafeInt(payload.expiresAt) || payload.expiresAt <= now) {
    ownerGrantFailure('SIGNED_ACTION_EXPIRED', 403)
  }
  if (typeof payload.targetDigest !== 'string' || !HEX_64.test(payload.targetDigest)) {
    ownerGrantFailure('SIGNED_ACTION_DIGEST_INVALID', 400)
  }
  return Object.freeze(payload)
}

export function signedActionCanonical(payload) {
  return canonicalJson({
    schema: SIGNED_ACTION_SCHEMA,
    actionId: payload.actionId,
    action: payload.action,
    audience: payload.audience,
    ballId: payload.ballId,
    epoch: payload.epoch,
    expiresAt: payload.expiresAt,
    targetDigest: payload.targetDigest,
  })
}

export function signedActionReplayKey(actionId) {
  if (typeof actionId !== 'string' || !ACTION_ID_RE.test(actionId)) {
    ownerGrantFailure('SIGNED_ACTION_ID_INVALID', 400)
  }
  return `head:signed-action:${actionId}`
}

export async function verifySignedActionEnvelope(
  input,
  { trustedKeys, nodePublicKeyHex = null, expectedAudience = null, expectedBallId = null, expectedEpoch = null, now = Date.now() } = {},
) {
  requireOwnerNodeKeySeparation(trustedKeys?.ed25519PublicKeyHex, nodePublicKeyHex)
  const envelope = await verifyHybridEnvelopeV2(input, { artifact: 'signed-action', trustedKeys })
  const payload = normalizeSignedActionPayload(envelope.payload, { expectedAudience, now })
  if (canonicalJson(payload) !== canonicalJson(envelope.payload)) {
    ownerGrantFailure('SIGNED_ACTION_MALFORMED', 400)
  }
  if (expectedBallId !== null && payload.ballId !== expectedBallId) {
    ownerGrantFailure('SIGNED_ACTION_STALE_HEAD', 409)
  }
  if (expectedEpoch !== null && payload.epoch !== expectedEpoch) {
    ownerGrantFailure('SIGNED_ACTION_STALE_EPOCH', 409)
  }
  return Object.freeze({
    envelope,
    payload,
    replayKey: signedActionReplayKey(payload.actionId),
  })
}
