'use strict'
/**
 * seed-nostr-anchor (v1) — public Nostr epoch anchoring and human-vouching slots.
 *
 * Zero imports. No clock read, no randomness, no network, no filesystem: every function is a pure
 * function of its arguments, so the same input yields byte-identical output on every host. A caller
 * that needs "now" must pass it in; this organ never guesses the time.
 *
 * Two jobs:
 *
 *   1. checkpointTags  — the NIP-01 event a node publishes to anchor its head (kind 30078, addressable,
 *      `d` = `aukora-head:<nodePubkeyHex>`). The signed content is the canonical JSON binding of
 *      (headBallId, epoch, receiptsLeafHash, nodePubkeyHex): an event whose content names a different
 *      head than its tags is refused, because a tag set is not evidence and the content is what a
 *      reader must re-derive.
 *
 *   2. vouchVerify — the structural and slot validator for `aukora.invite.v1`: one sponsor may have at
 *      most THREE vouched humans per calendar month (monthlySequence 1..3), each invite lives at most
 *      seven days, and the invitee is bound by a 32-byte commitment rather than a pubkey it does not
 *      have yet. A fourth slot is refused; it is not clamped, renumbered, or queued.
 *
 * Everything here is structural: it proves an object is well formed, never that a human is real, never
 * that a key signed anything, and never that the network saw it. `anchorAuthority` and
 * `inviteAuthority` are `'none'` on every return, including successes, because this organ holds no
 * authority to grant.
 */

const KIND_ANCHOR_EVENT = 30078
const ANCHOR_SCHEMA = 'aukora.nostr.head.v1'
const INVITE_SCHEMA = 'aukora.invite.v1'
const MONTHLY_VOUCH_SLOTS = 3
const INVITE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const HEX32 = /^[0-9a-f]{64}$/
const MONTH = /^[0-9]{4}-(?:0[1-9]|1[0-2])$/
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/

/** RFC 8785-style canonical JSON: sorted keys, no undefined, arrays preserved. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item === undefined ? null : item)).join(',') + ']'
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}

const refuseAnchor = (code, detail) => ({ ok: false, code, detail: detail || null, anchorAuthority: 'none', authorityVerified: false })
const refuseInvite = (code, detail) => ({ ok: false, code, detail: detail || null, inviteAuthority: 'none', authorityVerified: false })

/** The exact bytes a node signs: these four fields, in canonical order, and nothing else. */
function checkpointContent(headBallId, epoch, receiptsLeafHash, nodePubkeyHex) {
  return canonicalJson({ schema: ANCHOR_SCHEMA, headBallId, epoch, receiptsLeafHash, nodePubkeyHex })
}

/**
 * Build the anchor event payload. `d` is the addressable key: one live head per node pubkey, so a
 * later epoch REPLACES the addressable event rather than accumulating unverifiable history.
 */
function checkpointTags(args) {
  const input = args || {}
  const { headBallId, epoch, receiptsLeafHash, nodePubkeyHex } = input
  if (typeof headBallId !== 'string' || !HEX32.test(headBallId)) return refuseAnchor('HEAD_BALL_ID_INVALID', 'headBallId must be 32 lowercase hex bytes')
  if (!Number.isSafeInteger(epoch) || epoch < 0) return refuseAnchor('EPOCH_INVALID', 'epoch must be a non-negative safe integer')
  if (typeof receiptsLeafHash !== 'string' || !HEX32.test(receiptsLeafHash)) return refuseAnchor('RECEIPTS_LEAF_HASH_INVALID', 'receiptsLeafHash must be 32 lowercase hex bytes')
  if (typeof nodePubkeyHex !== 'string' || !HEX32.test(nodePubkeyHex)) return refuseAnchor('NODE_PUBKEY_INVALID', 'nodePubkeyHex must be a 32-byte x-only secp256k1 pubkey in lowercase hex')

  const content = checkpointContent(headBallId, epoch, receiptsLeafHash, nodePubkeyHex)
  const tags = [
    ['d', 'aukora-head:' + nodePubkeyHex],
    ['epoch', String(epoch)],
    ['head', headBallId],
    ['receipts', receiptsLeafHash],
    ['schema', ANCHOR_SCHEMA],
  ]
  return {
    ok: true,
    kind: KIND_ANCHOR_EVENT,
    created_at: Number.isSafeInteger(input.createdAt) ? input.createdAt : null,
    tags,
    content,
    contentBytes: content.length,
    addressableKey: 'aukora-head:' + nodePubkeyHex,
    anchorAuthority: 'none',
    authorityVerified: false,
    selfAttested: true,
  }
}

/**
 * Verify a received anchor event. Refuses a tag set that disagrees with its own content: the content is
 * what the author signed, so a mismatch means one of the two was edited after signing.
 */
function checkpointVerify(event) {
  const candidate = event || {}
  if (candidate.kind !== KIND_ANCHOR_EVENT) return refuseAnchor('KIND_MISMATCH', 'kind must be ' + KIND_ANCHOR_EVENT)
  if (!Array.isArray(candidate.tags)) return refuseAnchor('TAGS_MISSING', 'tags must be an array')
  if (typeof candidate.content !== 'string' || !candidate.content) return refuseAnchor('CONTENT_MISSING', 'content must be a non-empty string')
  const tagOf = (name) => {
    const found = candidate.tags.find((tag) => Array.isArray(tag) && tag[0] === name)
    return found && typeof found[1] === 'string' ? found[1] : null
  }
  const d = tagOf('d')
  const head = tagOf('head')
  const epochText = tagOf('epoch')
  const receipts = tagOf('receipts')
  if (!d || !d.startsWith('aukora-head:')) return refuseAnchor('D_TAG_MISSING', 'd tag must be aukora-head:<nodePubkeyHex>')
  const nodePubkeyHex = d.slice('aukora-head:'.length)
  if (!HEX32.test(nodePubkeyHex)) return refuseAnchor('D_TAG_INVALID', 'd tag node pubkey is not 32-byte hex')
  if (!head || !HEX32.test(head)) return refuseAnchor('HEAD_TAG_INVALID', 'head tag is not 32-byte hex')
  if (epochText === null || !/^[0-9]+$/.test(epochText)) return refuseAnchor('EPOCH_TAG_INVALID', 'epoch tag is not a non-negative integer')
  if (!receipts || !HEX32.test(receipts)) return refuseAnchor('RECEIPTS_TAG_INVALID', 'receipts tag is not 32-byte hex')
  const epoch = Number(epochText)
  if (!Number.isSafeInteger(epoch)) return refuseAnchor('EPOCH_TAG_INVALID', 'epoch tag overflows a safe integer')
  const expected = checkpointContent(head, epoch, receipts, nodePubkeyHex)
  if (expected !== candidate.content) return refuseAnchor('CONTENT_TAG_MISMATCH', 'content does not bind the tag values')
  return {
    ok: true,
    kind: KIND_ANCHOR_EVENT,
    headBallId: head,
    epoch,
    receiptsLeafHash: receipts,
    nodePubkeyHex,
    addressableKey: d,
    anchorAuthority: 'none',
    authorityVerified: false,
    selfAttested: true,
  }
}

/**
 * Validate one vouched-human invite. A sponsor has three slots per calendar month; `monthlySequence`
 * is the slot, and 4 is a refusal rather than a wrap. The seven-day window is measured on caller-supplied
 * instants so this stays deterministic.
 */
function vouchVerify(invite) {
  const candidate = invite || {}
  if (candidate.schema !== INVITE_SCHEMA) return refuseInvite('INVITE_SCHEMA_INVALID', 'schema must be ' + INVITE_SCHEMA)
  if (typeof candidate.quotaMonth !== 'string' || !MONTH.test(candidate.quotaMonth)) return refuseInvite('QUOTA_MONTH_INVALID', 'quotaMonth must be YYYY-MM')
  if (!Number.isInteger(candidate.monthlySequence)) return refuseInvite('MONTHLY_SEQUENCE_INVALID', 'monthlySequence must be an integer')
  if (candidate.monthlySequence < 1 || candidate.monthlySequence > MONTHLY_VOUCH_SLOTS) {
    return refuseInvite('VOUCH_SLOT_EXHAUSTED', 'monthlySequence must be 1..' + MONTHLY_VOUCH_SLOTS + ', got ' + candidate.monthlySequence)
  }
  if (typeof candidate.sponsorPubkeyHex !== 'string' || !HEX32.test(candidate.sponsorPubkeyHex)) return refuseInvite('SPONSOR_PUBKEY_INVALID', 'sponsorPubkeyHex must be 32-byte hex')
  if (typeof candidate.inviteeCommitmentSha256 !== 'string' || !HEX32.test(candidate.inviteeCommitmentSha256)) return refuseInvite('INVITEE_COMMITMENT_INVALID', 'inviteeCommitmentSha256 must be 32-byte hex')
  if (typeof candidate.issuedAt !== 'string' || !ISO.test(candidate.issuedAt)) return refuseInvite('ISSUED_AT_INVALID', 'issuedAt must be an ISO-8601 UTC instant')
  if (typeof candidate.expiresAt !== 'string' || !ISO.test(candidate.expiresAt)) return refuseInvite('EXPIRES_AT_INVALID', 'expiresAt must be an ISO-8601 UTC instant')
  if (candidate.quotaMonth !== candidate.issuedAt.slice(0, 7)) return refuseInvite('QUOTA_MONTH_MISMATCH', 'quotaMonth must equal the issuedAt month')
  const issued = Date.parse(candidate.issuedAt)
  const expires = Date.parse(candidate.expiresAt)
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return refuseInvite('ISSUED_AT_INVALID', 'timestamps do not parse')
  if (expires <= issued) return refuseInvite('INVITE_WINDOW_INVALID', 'expiresAt must be after issuedAt')
  if (expires - issued > INVITE_WINDOW_MS) return refuseInvite('INVITE_WINDOW_TOO_LONG', 'window exceeds 7 days')
  if (Number.isSafeInteger(candidate.now) && candidate.now >= expires) return refuseInvite('INVITE_EXPIRED', 'now is at or past expiresAt')
  return {
    ok: true,
    schema: INVITE_SCHEMA,
    quotaMonth: candidate.quotaMonth,
    monthlySequence: candidate.monthlySequence,
    slotsRemainingThisMonth: MONTHLY_VOUCH_SLOTS - candidate.monthlySequence,
    sponsorPubkeyHex: candidate.sponsorPubkeyHex,
    inviteeCommitmentSha256: candidate.inviteeCommitmentSha256,
    expiresAt: candidate.expiresAt,
    windowMs: expires - issued,
    inviteAuthority: 'none',
    authorityVerified: false,
    // A structural pass is not a vouch. Redemption is a separate, owner-facing act.
    redeemable: false,
  }
}

/** Deterministic slot arithmetic for a sponsor's month; the caller supplies the already-used slots. */
function vouchSlots(quotaMonth, usedSequences) {
  if (typeof quotaMonth !== 'string' || !MONTH.test(quotaMonth)) return refuseInvite('QUOTA_MONTH_INVALID', 'quotaMonth must be YYYY-MM')
  const used = Array.isArray(usedSequences) ? usedSequences.filter((n) => Number.isInteger(n)) : []
  const invalid = used.filter((n) => n < 1 || n > MONTHLY_VOUCH_SLOTS)
  if (invalid.length) return refuseInvite('USED_SEQUENCE_OUT_OF_RANGE', JSON.stringify(invalid))
  const available = []
  for (let slot = 1; slot <= MONTHLY_VOUCH_SLOTS; slot++) if (!used.includes(slot)) available.push(slot)
  return {
    ok: true,
    quotaMonth,
    usedSequences: used.slice().sort(),
    availableSequences: available,
    exhausted: available.length === 0,
    cap: MONTHLY_VOUCH_SLOTS,
    inviteAuthority: 'none',
    authorityVerified: false,
  }
}

module.exports = {
  name: 'seed-nostr-anchor',
  description: 'Public Nostr epoch anchoring (kind 30078) and aukora.invite.v1 three-slot human vouching. Zero imports, deterministic, authority none.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['checkpoint', 'verify_checkpoint', 'vouch', 'vouch_slots'] },
      headBallId: { type: 'string', description: 'Anchor: head ballId, 64 lowercase hex.' },
      epoch: { type: 'number', description: 'Anchor: epoch being anchored.' },
      receiptsLeafHash: { type: 'string', description: 'Anchor: receipt-chain leaf hash, 64 lowercase hex.' },
      nodePubkeyHex: { type: 'string', description: 'Anchor: node x-only pubkey, 64 lowercase hex.' },
      createdAt: { type: 'number', description: 'Anchor: NIP-01 created_at, supplied by the caller.' },
      event: { type: 'object', description: 'verify_checkpoint: the received event.' },
      invite: { type: 'object', description: 'vouch: an aukora.invite.v1 object.' },
      quotaMonth: { type: 'string', description: 'vouch_slots: YYYY-MM.' },
      usedSequences: { type: 'array', items: { type: 'number' }, description: 'vouch_slots: slots already used this month.' },
    },
    required: ['action'],
  },
  async run(args) {
    const action = args && args.action
    try {
      if (action === 'checkpoint') return checkpointTags(args)
      if (action === 'verify_checkpoint') return checkpointVerify(args.event)
      if (action === 'vouch') return vouchVerify(args.invite)
      if (action === 'vouch_slots') return vouchSlots(args.quotaMonth, args.usedSequences)
      return { ok: false, error: 'UNKNOWN_ACTION', action: action || null, anchorAuthority: 'none', inviteAuthority: 'none', authorityVerified: false }
    } catch (error) {
      return { ok: false, error: 'INTERNAL', detail: String((error && error.message) || error), anchorAuthority: 'none', inviteAuthority: 'none', authorityVerified: false }
    }
  },
  checkpointContent,
  checkpointTags,
  checkpointVerify,
  vouchVerify,
  vouchSlots,
  canonicalJson,
  KIND_ANCHOR_EVENT,
  ANCHOR_SCHEMA,
  INVITE_SCHEMA,
  MONTHLY_VOUCH_SLOTS,
  INVITE_WINDOW_MS,
}
