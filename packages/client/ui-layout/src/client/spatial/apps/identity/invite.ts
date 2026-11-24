// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * HUMAN VOUCHING (aukora.invite.v1): ISSUING AND REVOKING AN INVITE FROM THIS PAGE, ON THE HOST'S OWN AUMLOK ROUTES
 * (`deploy/cloudflare/src/aumlok.mjs`; the Mac host serves the same store).
 *
 * THE NODE KEY SIGNS, NOT THE PASSKEY AND NOT THE OWNER KEY. The host checks an invite against the node key it has bound,
 * and this page holds that key only after the seven words open the sealed root. So every invite, and every revocation,
 * is two taps, each with its own Touch ID:
 *
 *   tap 1  "Open with Touch ID": POST /_host/aumlok/challenge {purpose:'unseal', requestId}; the bound passkey asserts it;
 *          POST /_host/aumlok/unseal {challengeId, credential, commitmentSha256}, the words' commitment worked out BEFORE
 *          the tap; the words open the sealed root here. The root is zeroed at once. Only the node's signing key, which
 *          cannot be exported, is kept, and the caller drops it within two minutes.
 *   tap 2  "Sign invite with Touch ID": POST /_host/aumlok/challenge {purpose:'invite', requestId,
 *          inviteeCommitmentSha256, assignedDomainPointer}; the host's echo is checked here before anything is asked; the
 *          bound passkey asserts it; the node key signs THIS PAGE'S OWN 'aukora.invite.v1\n' + the canonical JSON of the
 *          invite, never the host's string; POST /_host/aumlok/invite {challengeId, credential, signature}. A revocation
 *          is the same tap with {action:'revoke', inviteId} and 'aukora.invite-revocation.v1\n'.
 *
 * NOTHING HERE PROBES. The host counts EVERY refused AUMLOK call toward a lockout that also stops Class 3 approvals (five
 * in an hour, ten for good), and every wrong phrase toward a lifetime limit that nothing resets. So a fresh status read
 * must show the node bound, its passkey verified, no blockers, no phrase blockers and quota left before any challenge is
 * asked for, and an unseal is never retried by the page.
 *
 * ONLY WHAT THE HOST CONFIRMED IS SHOWN. A receipt is shown, copied or remembered only after the host's own answer carries
 * it with this invite's id and this page's signature (or replays it idempotently), and only once it verifies against the
 * node key. A lost last answer is asked again once with the same body; still unclear, the outcome is UNKNOWN and nothing
 * new is started.
 *
 * THE INVITEE COMMITMENT (PROPOSED aukora.invite.invitee.v1; a client contract that no host reads yet):
 *   invite code              32 random bytes from crypto.getRandomValues, shown once as base64url
 *   inviteeCommitmentSha256  lowercase hex SHA-256('aukora.invite.invitee.v1\0' || those 32 bytes)
 * The code is a bearer secret for the person invited. It is never stored, never logged, and never in the receipt, the
 * QR, a link or any request the SPONSOR's page makes: only its commitment crosses when an invite is issued. The one
 * request that carries it is the guest's own `POST /_host/aumlok/redeem` (`redeemInvite`, at the end of this file), sent
 * once per press and only after this page's own check of the signature, the date and the code has passed.
 *
 * WHAT THIS BROWSER REMEMBERS. The host lists no invites, so the signed receipts this browser issued (public data, never
 * the code) and the revocations it signed are kept under 'aukora.invite.issued' (the last 32 of each), or in memory when
 * storage is closed. That list is this browser's only. Once the host refuses an invite at its lifetime cap (32), the node
 * key it refused for is kept under 'aukora.invite.capacity', and no further invite is asked for that node from here.
 * @module apps/identity/invite
 */
import { capacityWords, hostCall, type HostAnswer } from './host.ts'
import { INVITE_SCHEMA } from './nostr.ts'
import { base64url, fromBase64url, passkeyFailure, passkeyRanOut, readChallenge, type PasskeyChallenge, type PasskeyResponseJson } from './webauthn.ts'
import {
  AUMLOK_ROUTES, browserPlatform, forHost, parseAumlokStatus, unsealAumlokNodeWith,
  type AumlokHostCall, type AumlokHostStatus, type AumlokPlatform,
} from '../../aumlok/aumlok-ceremony.ts'
import type { AumlokNode, ByteFill } from '../../aumlok/aumlok-root.ts'
import { canonicalJson } from '../../aumlok/class3-approval.ts'

export const INVITE_DOMAIN = 'aukora.invite.v1\n'
export const REVOCATION_SCHEMA = 'aukora.invite-revocation.v1'
/** PROPOSED aukora.invite.invitee.v1: the domain of the invitee commitment. */
export const INVITEE_COMMITMENT_DOMAIN = 'aukora.invite.invitee.v1\0'
/** An invite lasts exactly seven days from the host's issue time. */
export const INVITE_LIFETIME_MS = 604_800_000
/** The host's hard cap on an invite's monthly sequence (three a month). */
export const INVITE_MONTHLY_CAP = 3
/** The host's cap on the invites one node records, for all time (aumlok.mjs `inviteRecords`); revoking frees none. */
export const INVITE_LIFETIME_CAP = 32
/** Where this browser keeps the receipts it issued and the revocations it signed (public data only). */
export const INVITE_BOOK_KEY = 'aukora.invite.issued'
/** The book holds the last this many receipts: enough to show that the lifetime cap is reached. */
export const INVITE_BOOK_LIMIT = INVITE_LIFETIME_CAP
/** Where this browser keeps the node key the host refused an invite for at its lifetime cap (public data only). */
export const INVITE_CAPACITY_KEY = 'aukora.invite.capacity'
/** The life of one host challenge (aumlok.mjs `challengeMs`): its request id is never posted again after it. */
export const INVITE_CHALLENGE_LIFE_MS = 120_000
/**
 * One more tap after a Touch ID that did not complete is offered only until this long before its challenge expires: the
 * sheet itself takes time, and an unseal that reaches the host after expiry is a refusal the host counts.
 */
export const INVITE_TAP_AGAIN_MARGIN_MS = 15_000
/** The longest the node's signing key is held after an unseal (the life of one host challenge). */
export const INVITE_KEY_HOLD_MS = INVITE_CHALLENGE_LIFE_MS
/** How far a time the host chose (an invite's issuedAt, a revocation's revokedAt) may be from this page's clock. */
export const INVITE_CLOCK_SKEW_MS = 300_000
/** One approval at a time (`portal/touch-id-timing.ts`): an issue, or the revocation of one invite. */
export const INVITE_ISSUE_APPROVAL = 'invite:issue'
export const inviteRevokeApproval = (inviteId: string): string => `invite:revoke:${inviteId}`

/** The ten fields of an invite as the host's challenge echoes it, before it is signed. */
export interface InvitePayload {
  readonly schema: typeof INVITE_SCHEMA
  readonly inviteId: string
  readonly sponsorPubkeyHex: string
  readonly inviteeCommitmentSha256: string
  readonly assignedDomainPointer: string | null
  readonly quotaMonth: string
  readonly monthlySequence: number
  readonly revoked: false
  readonly issuedAt: number
  readonly expiresAt: number
}
/** The signed receipt the host records and returns: the ten fields and the node's signature. */
export interface InviteReceipt extends InvitePayload { readonly signature: string }
/** The four fields of a revocation as the host's challenge echoes it, before it is signed. */
export interface RevocationPayload {
  readonly schema: typeof REVOCATION_SCHEMA
  readonly inviteId: string
  readonly sponsorPubkeyHex: string
  readonly revokedAt: number
}
export interface SignedRevocation extends RevocationPayload { readonly signature: string }

const HEX64 = /^[0-9a-f]{64}$/u
const INVITE_ID = /^[A-Za-z0-9_-]{16,128}$/u
const MONTH = /^\d{4}-\d{2}$/u
const CODE = /^[A-Z][A-Z0-9_]{1,80}$/u
const encoder = new TextEncoder()
const subtle = (): SubtleCrypto => globalThis.crypto.subtle
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key))
const stamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 && !Object.is(value, -0)
const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7)
const hexOf = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
const bytesOfHex = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from(hex.match(/../gu) ?? [], pair => parseInt(pair, 16))
/** A node signature as the host takes it: 64 bytes, 86 base64url characters, no padding. */
const signatureValid = (value: unknown): value is string => typeof value === 'string' && value.length === 86 && fromBase64url(value)?.length === 64
const PAYLOAD_KEYS = ['schema', 'inviteId', 'sponsorPubkeyHex', 'inviteeCommitmentSha256', 'assignedDomainPointer', 'quotaMonth',
  'monthlySequence', 'revoked', 'issuedAt', 'expiresAt'] as const
const REVOCATION_KEYS = ['schema', 'inviteId', 'sponsorPubkeyHex', 'revokedAt'] as const

// ── The assigned address ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE HOST'S OWN RULE for `assignedDomainPointer` (`domainValid` in aumlok.mjs): null, or an exact https origin of at
 * most 253 characters with no path, no trailing slash and no explicit port, already lower case or punycoded.
 * @param value - the pointer.
 * @returns whether the host would take it.
 */
export function inviteDomainValid(value: string | null): boolean {
  if (value === null) return true
  if (value.length > 253) return false
  try {
    const url = new URL(value)
    return url.origin === value && url.protocol === 'https:' && url.port === ''
  } catch { return false }
}

/** "Their address" as typed: empty is no address yet; anything else must normalise to an origin the host takes. */
export type InviteDomainRead = { readonly ok: true; readonly value: string | null } | { readonly ok: false }

/**
 * Normalise "Their address" with `new URL(input).origin` and check it with the host's rule before anything is asked.
 * @param input - what the person typed.
 * @returns the origin (or null for none), or that it is not one the host takes.
 */
export function normaliseInviteDomain(input: string): InviteDomainRead {
  const typed = input.trim()
  if (typed === '') return { ok: true, value: null }
  let origin: string
  try { origin = new URL(typed).origin } catch { return { ok: false } }
  return inviteDomainValid(origin) ? { ok: true, value: origin } : { ok: false }
}

// ── The invitee commitment (PROPOSED aukora.invite.invitee.v1) ─────────────────────────────────────────────────────────

/** The invite code (shown once) and the commitment that is the only part of it the host sees. */
export interface InviteeCode { readonly code: string; readonly commitmentSha256: string }
const platformBytes: ByteFill = array => globalThis.crypto.getRandomValues(array)

/**
 * The commitment to an invite code's 32 bytes: lowercase hex SHA-256('aukora.invite.invitee.v1\0' || bytes).
 * @param secret - the code's bytes.
 * @returns 64 lowercase hex characters.
 */
export async function inviteeCommitment(secret: Uint8Array): Promise<string> {
  const head = encoder.encode(INVITEE_COMMITMENT_DOMAIN)
  const input = new Uint8Array(head.length + secret.length)
  input.set(head)
  input.set(secret, head.length)
  try { return hexOf(await subtle().digest('SHA-256', input)) } finally { input.fill(0) }
}

/**
 * A fresh invite code and its commitment. The bytes are zeroed before this returns; the code string cannot be wiped.
 * @param fill - the byte generator (the platform's, outside tests).
 * @returns the code (base64url of 32 bytes) and its commitment.
 */
export async function newInviteeCode(fill: ByteFill = platformBytes): Promise<InviteeCode> {
  const secret = fill(new Uint8Array(32))
  try { return { code: base64url(secret), commitmentSha256: await inviteeCommitment(secret) } } finally { secret.fill(0) }
}

// ── Shapes, preimages and signatures ───────────────────────────────────────────────────────────────────────────────────

/** The ten invite fields of a record, checked as the host checks them (`inviteValid`), or null. */
function inviteFields(record: Record<string, unknown>): InvitePayload | null {
  const { schema, inviteId, sponsorPubkeyHex, inviteeCommitmentSha256, assignedDomainPointer, quotaMonth, monthlySequence,
    revoked, issuedAt, expiresAt } = record
  if (schema !== INVITE_SCHEMA || typeof inviteId !== 'string' || !INVITE_ID.test(inviteId)) return null
  if (typeof sponsorPubkeyHex !== 'string' || !HEX64.test(sponsorPubkeyHex)) return null
  if (typeof inviteeCommitmentSha256 !== 'string' || !HEX64.test(inviteeCommitmentSha256)) return null
  const domain = assignedDomainPointer === null ? null
    : typeof assignedDomainPointer === 'string' && inviteDomainValid(assignedDomainPointer) ? assignedDomainPointer : undefined
  if (domain === undefined) return null
  if (typeof monthlySequence !== 'number' || !Number.isInteger(monthlySequence) || monthlySequence < 1 || monthlySequence > INVITE_MONTHLY_CAP) return null
  if (revoked !== false || !stamp(issuedAt) || !stamp(expiresAt) || expiresAt <= issuedAt) return null
  if (expiresAt - issuedAt > INVITE_LIFETIME_MS) return null
  if (typeof quotaMonth !== 'string' || !MONTH.test(quotaMonth) || quotaMonth !== monthOf(issuedAt)) return null
  return { schema, inviteId, sponsorPubkeyHex, inviteeCommitmentSha256, assignedDomainPointer: domain, quotaMonth, monthlySequence,
    revoked, issuedAt, expiresAt }
}

/**
 * A signed receipt: exactly the eleven fields, each as the host checks it.
 * @param value - untrusted JSON.
 * @returns the receipt, or null when it is not that shape.
 */
export function inviteReceiptOf(value: unknown): InviteReceipt | null {
  if (!isRecord(value) || !exactKeys(value, [...PAYLOAD_KEYS, 'signature']) || !signatureValid(value.signature)) return null
  const payload = inviteFields(value)
  return payload === null ? null : { ...payload, signature: value.signature }
}

/** The ten signed fields of a receipt, without its signature. */
export function invitePayloadOf(receipt: InviteReceipt): InvitePayload {
  return { schema: receipt.schema, inviteId: receipt.inviteId, sponsorPubkeyHex: receipt.sponsorPubkeyHex,
    inviteeCommitmentSha256: receipt.inviteeCommitmentSha256, assignedDomainPointer: receipt.assignedDomainPointer,
    quotaMonth: receipt.quotaMonth, monthlySequence: receipt.monthlySequence, revoked: receipt.revoked, issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt }
}

function revocationFields(record: Record<string, unknown>): RevocationPayload | null {
  const { schema, inviteId, sponsorPubkeyHex, revokedAt } = record
  if (schema !== REVOCATION_SCHEMA || typeof inviteId !== 'string' || !INVITE_ID.test(inviteId)) return null
  if (typeof sponsorPubkeyHex !== 'string' || !HEX64.test(sponsorPubkeyHex) || !stamp(revokedAt)) return null
  return { schema, inviteId, sponsorPubkeyHex, revokedAt }
}

/**
 * A signed revocation: exactly the five fields, each as the host checks it (`revocationValid`).
 * @param value - untrusted JSON.
 * @returns the revocation, or null when it is not that shape.
 */
export function signedRevocationOf(value: unknown): SignedRevocation | null {
  if (!isRecord(value) || !exactKeys(value, [...REVOCATION_KEYS, 'signature']) || !signatureValid(value.signature)) return null
  const payload = revocationFields(value)
  return payload === null ? null : { ...payload, signature: value.signature }
}

/** What the node signs for an invite: the domain, then the canonical JSON of the ten fields. */
export const invitePreimage = (invite: InvitePayload): string => INVITE_DOMAIN + canonicalJson(invite)
/** What the node signs for a revocation: its schema and a newline, then the canonical JSON of the four fields. */
export const revocationPreimage = (revocation: RevocationPayload): string => `${REVOCATION_SCHEMA}\n${canonicalJson(revocation)}`

/**
 * Sign with the node key (Ed25519, inside WebCrypto: the key cannot be exported).
 * @param key - the node's signing key.
 * @param preimage - the exact text this page built.
 * @returns the signature, base64url (86 characters).
 */
export async function signWithNode(key: CryptoKey, preimage: string): Promise<string> {
  return base64url(new Uint8Array(await subtle().sign('Ed25519', key, encoder.encode(preimage))))
}

async function verifyNode(nodePubkeyHex: string, signature: string, preimage: string): Promise<boolean> {
  const bytes = fromBase64url(signature)
  if (!HEX64.test(nodePubkeyHex) || bytes?.length !== 64) return false
  try {
    const key = await subtle().importKey('raw', bytesOfHex(nodePubkeyHex), { name: 'Ed25519' }, false, ['verify'])
    return await subtle().verify('Ed25519', key, bytes, encoder.encode(preimage))
  } catch { return false }
}

/**
 * Whether a receipt is the node's: its shape, its sponsor equal to the node key the host reports NOW (never the key the
 * receipt names alone), and its Ed25519 signature over the ten fields.
 * @param value - the receipt (untrusted).
 * @param nodePubkeyHex - the node key from a fresh status read.
 * @returns true only when all three hold.
 */
export async function verifyInviteReceipt(value: unknown, nodePubkeyHex: string): Promise<boolean> {
  const receipt = inviteReceiptOf(value)
  if (receipt?.sponsorPubkeyHex !== nodePubkeyHex) return false
  return verifyNode(nodePubkeyHex, receipt.signature, invitePreimage(invitePayloadOf(receipt)))
}

/**
 * Whether a revocation is the node's, as `verifyInviteReceipt` checks a receipt.
 * @param value - the revocation (untrusted).
 * @param nodePubkeyHex - the node key from a fresh status read.
 * @returns true only when its shape, sponsor and signature hold.
 */
export async function verifyRevocation(value: unknown, nodePubkeyHex: string): Promise<boolean> {
  const revocation = signedRevocationOf(value)
  if (revocation?.sponsorPubkeyHex !== nodePubkeyHex) return false
  const payload: RevocationPayload = { schema: revocation.schema, inviteId: revocation.inviteId,
    sponsorPubkeyHex: revocation.sponsorPubkeyHex, revokedAt: revocation.revokedAt }
  return verifyNode(nodePubkeyHex, revocation.signature, revocationPreimage(payload))
}

/** The receipt as text to copy: the canonical JSON of all eleven fields. */
export const receiptJson = (receipt: InviteReceipt): string => canonicalJson(receipt)

const utc = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/**
 * One line a person reads: which invite of the month, until when, for which address, and which key signed it.
 * @param receipt - a receipt the host confirmed.
 * @param limit - the monthly limit the host reports.
 * @returns the line.
 */
export function receiptLine(receipt: InviteReceipt, limit: number): string {
  return `Invite ${String(receipt.monthlySequence)} of ${String(limit)} for ${receipt.quotaMonth} · expires ${utc(receipt.expiresAt)}`
    + ` · for ${receipt.assignedDomainPointer ?? 'no address yet'} · signed by this node’s key ${receipt.sponsorPubkeyHex.slice(0, 16)}…`
}

/** One line for a revocation this page signed. */
export function revocationLine(revocation: SignedRevocation): string {
  return `Revoked ${revocation.inviteId.slice(0, 12)}… at ${utc(revocation.revokedAt)} · signed by this node’s key `
    + `${revocation.sponsorPubkeyHex.slice(0, 16)}…`
}

// ── The fresh status read and what it allows ───────────────────────────────────────────────────────────────────────────

/** The invite quota as the status reports it (`invite: { quotaMonth, issuedThisMonth, limit, revokedCount }`). */
export interface InviteQuota { readonly month: string; readonly issued: number; readonly limit: number; readonly revoked: number | null }
/** What a fresh status read says that an invite needs. A missing field reads as missing (null), never as clear. */
export interface InviteStatus {
  readonly status: AumlokHostStatus
  /** The host's phrase lock (`phraseBlockers`); null when it does not report one, which is not the same as none. */
  readonly phraseBlockers: readonly string[] | null
  readonly quota: InviteQuota | null
  /** Every invite this node has ever issued (`lifetimeIssuedCount`), when the host reports it; null when it does not. */
  readonly lifetimeIssued: number | null
}
export type InviteStatusRead =
  | { readonly kind: 'live'; readonly value: InviteStatus }
  | { readonly kind: 'absent'; readonly detail: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'unreadable' }

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null)

/**
 * Read an AUMLOK status answer for an invite.
 * @param answer - the host's answer to GET /_host/aumlok/status.
 * @returns the read; `live` carries the parsed status, the phrase lock as reported, and the quota.
 */
export function inviteStatusOf(answer: HostAnswer): InviteStatusRead {
  if (answer.kind === 'absent') return { kind: 'absent', detail: answer.detail }
  if (answer.kind === 'refused') return { kind: 'refused', code: answer.code }
  const status = parseAumlokStatus(answer.body)
  if (status === null) return { kind: 'unreadable' }
  const phrase = answer.body.phraseBlockers
  const phraseBlockers = Array.isArray(phrase) && phrase.every((code): code is string => typeof code === 'string' && CODE.test(code))
    ? phrase : null
  const invite = isRecord(answer.body.invite) ? answer.body.invite : {}
  const quota = status.invites === null ? null : { ...status.invites, revoked: count(invite.revokedCount) }
  const lifetimeIssued = count(invite.lifetimeIssuedCount) ?? count(answer.body.lifetimeIssuedCount)
  return { kind: 'live', value: { status, phraseBlockers, quota, lifetimeIssued } }
}

/**
 * A fresh status read (a GET: the host counts nothing for it).
 * @param signal - aborts the read.
 * @param call - the host call (tests pass their own).
 * @returns the read.
 */
export async function readInviteStatus(signal: AbortSignal, call: AumlokHostCall = hostCall): Promise<InviteStatusRead> {
  return inviteStatusOf(await call(AUMLOK_ROUTES.status, signal))
}

/** An issue, or the revocation of one invite. */
export type InvitePurpose = 'issue' | 'revoke'

/**
 * Why nothing may be asked now, or null when an invite (or a revocation) may start. Every check is on the fresh status
 * and this browser; none of them asks the host for anything.
 * @param read - a fresh status read.
 * @param purpose - issuing, or revoking.
 * @param platform - the browser's passkey and Ed25519 support.
 * @returns the reason in words, or null.
 */
export async function inviteReadiness(read: InviteStatus, purpose: InvitePurpose, platform: AumlokPlatform = browserPlatform)
  : Promise<string | null> {
  const { status, phraseBlockers, quota, lifetimeIssued } = read
  if (status.state !== 'bound' || status.nodePubkeyHex === null) return 'This node is not bound with AUMLOK yet, so it cannot vouch for anyone.'
  if (!status.passkeyVerified) return 'This node has no verified passkey, so nothing can be signed here.'
  if (status.blockers.length > 0) return `${inviteRefusalWords(status.blockers[0] ?? '')} Nothing is asked while this host says ${status.blockers.join(', ')}.`
  if (phraseBlockers === null) return 'This host does not say whether your words are locked, so nothing is asked.'
  if (phraseBlockers.length > 0) return `${inviteRefusalWords(phraseBlockers[0] ?? '')} Nothing is asked while this host says ${phraseBlockers.join(', ')}.`
  if (!status.checksPhraseOnline) return 'This host does not check your words when your root is opened, so an invite cannot be signed here.'
  if (purpose === 'issue') {
    if (quota === null) return 'This host does not report the invite quota, so nothing is asked.'
    if (quota.issued >= quota.limit) {
      return `All ${String(quota.limit)} invites for ${quota.month} are used. Revoking one does not give it back.`
    }
    // THE LIFETIME CAP: the host's own count when it reports one (`lifetimeIssuedCount`); otherwise what this browser
    // already knows of it, so the host is never asked for a challenge it will refuse (and count).
    if (lifetimeIssued !== null && lifetimeIssued >= INVITE_LIFETIME_CAP) {
      return `This node has issued ${String(lifetimeIssued)} invites, its limit of ${String(INVITE_LIFETIME_CAP)} for all time, so nothing is asked.`
    }
    if (capacityReached(status.nodePubkeyHex)) {
      return `This node refused an invite here for its ${String(INVITE_LIFETIME_CAP)}-invite limit for all time, so nothing more is `
        + 'asked from this browser.'
    }
    if (await lifetimeCapHeld(status.nodePubkeyHex)) {
      return `This browser holds ${String(INVITE_LIFETIME_CAP)} invites this node signed, which is its limit for all time, so nothing `
        + 'is asked.'
    }
  }
  const blocker = platform.passkeyBlocker()
  if (blocker !== null) return `Touch ID cannot run here: ${blocker}.`
  if (!await platform.nodeKeys()) return 'This browser cannot use an Ed25519 node key, so it cannot sign an invite.'
  return null
}

// ── Refusals, in words ─────────────────────────────────────────────────────────────────────────────────────────────────

const words = (text: string, codes: readonly string[]): Record<string, string> => Object.fromEntries(codes.map(code => [code, text]))
/** Every refusal an invite can meet, in plain words. None says which word was wrong: that would be an oracle. */
const REFUSALS: Readonly<Record<string, string>> = {
  OWNER_ACCESS_REQUIRED: 'You are signed out of this node. Sign in, then try again.',
  ...words('This page is not on the node’s own address.', ['SAME_ORIGIN_BROWSER_REQUIRED', 'ORIGIN_REFUSED', 'CROSS_SITE_REFUSED', 'HOST_REFUSED',
    'AUMLOK_ORIGIN_REQUIRED']),
  ...words('The node is not ready. Nothing was signed.', ['OWNER_ACCESS_NOT_CONFIGURED', 'BOOTSTRAP_REQUIRED',
    'AUMLOK_CONFIGURATION_UNAVAILABLE', 'CLOUD_REQUEST_FAILED']),
  AUMLOK_CAPABILITY_REQUIRED: 'This page does not hold this Mac host’s session, so it cannot ask. Nothing was signed.',
  ...words('The node refused this page’s request as malformed. Nothing was signed.', ['AUMLOK_CONTENT_TYPE_REQUIRED',
    'AUMLOK_ENCODING_UNSUPPORTED', 'AUMLOK_BODY_TOO_LARGE', 'AUMLOK_BODY_TIMEOUT', 'AUMLOK_BODY_ABORTED', 'AUMLOK_BODY_INVALID',
    'AUMLOK_JSON_INVALID', 'AUMLOK_STRUCTURE_LIMIT', 'CLASS4_RAW_SECRET_FORBIDDEN', 'AUMLOK_REQUEST_INVALID']),
  ...words('The node’s identity store is unavailable. Nothing was signed.', ['AUMLOK_CLOCK_INVALID', 'AUMLOK_STATE_CORRUPT',
    'AUMLOK_STATE_MIGRATION_REQUIRED', 'AUMLOK_PEPPER_SECRET_REQUIRED', 'AUMLOK_PEPPER_SECRET_MISMATCH', 'AUMLOK_AUDIT_CORRUPT',
    'AUMLOK_APPROVAL_CORRUPT', 'AUMLOK_ESCROW_CORRUPT', 'AUMLOK_AUDIT_SEQUENCE_EXHAUSTED', 'AUMLOK_UNAVAILABLE']),
  AUMLOK_NOT_BOUND: 'This node is not bound yet.',
  AUMLOK_OWNER_KEY_UNAVAILABLE: 'This node has no owner key configured, so its AUMLOK refuses every ceremony.',
  NODE_KEY_IS_NOT_OWNER_KEY: 'This node’s key may not also be its owner key, so its AUMLOK refuses every ceremony.',
  AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE: 'This host has no trusted owner approval for a binding.',
  AUMLOK_RATE_LIMITED: 'Too many refused attempts. Wait, then try again.',
  AUMLOK_GUARDIAN_QUORUM_REQUIRED: 'Touch ID approvals are locked on this node. This also stops Class 3 approvals.',
  AUMLOK_PHRASE_RATE_LIMITED: 'Too many wrong phrases this hour. Wait before you try your words again.',
  AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED: 'Your words are locked on this node.',
  ...words('That Touch ID request expired or was already used. Start again.', ['AUMLOK_IDEMPOTENCY_CONFLICT', 'AUMLOK_CHALLENGE_USED',
    'AUMLOK_CHALLENGE_EXPIRED', 'AUMLOK_CHALLENGE_UNKNOWN']),
  AUMLOK_CHALLENGE_BINDING_MISMATCH: 'That Touch ID request no longer matches this node or your sign-in. Start again.',
  AUMLOK_RECOVERY_COMMITMENT_MISMATCH: 'Those words did not match. This counts against your lifetime limit.',
  // A commitment that is not one (malformed) checks no words: the node refuses it and counts nothing (proof-failure-rule.mjs).
  AUMLOK_COMMITMENT_INVALID: 'This page sent the words in a shape the node does not read. Nothing was counted.',
  ...words('Touch ID was not accepted.', ['AUMLOK_PROOF_INVALID', 'AUMLOK_CROSS_ORIGIN_PROOF']),
  AUMLOK_INVITE_MONTHLY_LIMIT: 'All 3 invites for this month are used.',
  AUMLOK_INVITE_CAPACITY: 'This node has reached its 32-invite limit for all time.',
  AUMLOK_INVITE_QUOTA_CHANGED: 'Another invite was issued at the same moment, or the month changed. Nothing was issued.',
  AUMLOK_INVITE_SIGNATURE_INVALID: 'The node refused this page’s signature. Nothing was issued.',
  AUMLOK_INVITE_INVALID: 'The node refused this invite as malformed. Nothing was issued.',
  AUMLOK_INVITE_NOT_FOUND: 'That invite is not on this node.',
  AUMLOK_INVITE_REVOKED: 'That invite is already revoked.',
  'route-absent': 'Invites are not on this host yet.',
  // A LOST ANSWER IS NOT A MISSING ROUTE: the request may have reached the host, and a wrong phrase is counted there.
  'not-answered': 'The answer was lost on the way. If it was the words step, that try may have counted.',
  'tap-expired': 'Touch ID was not tapped again within two minutes, so that request expired. It was not sent again, and your '
    + 'words were dropped. Start again.',
  'not-bound': 'This node is not bound yet.',
  'sealed-root-invalid': 'The node sent a sealed root this page cannot read. Nothing was signed.',
  ...words('Your root did not open into this node here. Nothing was signed.', ['words-do-not-open', 'root-is-another-node']),
  'no-node-key-here': 'This browser opened your root but cannot make its Ed25519 key. Nothing was signed.',
  'echo-mismatch': 'The node answered with something other than what this page asked for, so Touch ID was not asked and nothing was '
    + 'signed.',
  'unexpected-answer': 'The node answered in a shape this page does not read. Nothing was signed.',
  'ran-out': 'That Touch ID request ran out of time before the prompt could open. Nothing was sent or counted. Start again.',
  'root-closed': 'Your root closed after two minutes, so nothing was signed. Type your words again to continue.',
  closed: 'Closed before it finished. Nothing was signed.',
  'not-ready': 'This page has not read the node’s quota and key, so nothing was asked.',
}

/**
 * A refusal in words. Host codes are read as they are; this page's own codes carry an `invite:` or `aumlok:` prefix.
 * The two capacity refusals (too many Touch ID requests open, too many approvals) say the host's own wait when it sent one.
 * @param code - the code.
 * @param retryAfterSeconds - the wait a capacity refusal named, if the host sent one.
 * @returns the sentence (an unknown code is named as the host said it).
 */
export function inviteRefusalWords(code: string, retryAfterSeconds?: number): string {
  const bare = code.replace(/^(?:invite|aumlok):/u, '')
  return capacityWords(bare, retryAfterSeconds) ?? REFUSALS[bare] ?? `The node refused (${code}). Nothing was signed.`
}

// ── The two taps ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface InviteDeps {
  readonly call?: AumlokHostCall
  readonly platform?: AumlokPlatform
  readonly signal: AbortSignal
  /** The lowest work factor a sealed root is accepted at (production: 600 000). */
  readonly minIterations?: number
}

/**
 * How one tap ended.
 *   done     the host confirmed it (and, for an invite or revocation, the page verified the signed record);
 *   passkey  Touch ID did not complete: nothing was sent past the challenge, and the same request may be tapped once more;
 *   refused  a definite refusal, by the host or by a check here: nothing was signed or recorded;
 *   unknown  the last answer was lost, even when asked again: whether the host recorded it is not known here.
 */
export type InviteStep<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'passkey'; readonly message: string }
  | { readonly kind: 'refused'; readonly code: string; readonly retryAfterSeconds?: number }
  | { readonly kind: 'unknown'; readonly code: string }

/** A definite refusal; a capacity refusal keeps the wait the host named (`retryAfterSeconds`), and only then. */
const refused = (code: string, retryAfterSeconds?: number): { readonly kind: 'refused'; readonly code: string; readonly retryAfterSeconds?: number } =>
  (retryAfterSeconds === undefined ? { kind: 'refused', code } : { kind: 'refused', code, retryAfterSeconds })
/** The wait a host refusal named, if any. */
const waitOf = (answer: HostAnswer | null): number | undefined => (answer?.kind === 'refused' ? answer.retryAfterSeconds : undefined)
/** A host refusal keeps its code; a lost answer (`hostCall` could not fetch) is not a route that is not there. */
const codeOf = (answer: HostAnswer): string => (answer.kind === 'refused' ? answer.code
  : answer.kind === 'absent' && answer.detail.startsWith('the host did not answer') ? 'invite:not-answered' : 'invite:route-absent')
class PasskeyDidNotComplete extends Error {
  constructor(readonly reason: unknown) {
    super('invite:passkey')
    this.name = 'PasskeyDidNotComplete'
  }
}

/**
 * TAP 1: open the node with the words and the bound passkey. Inside the tap only the unseal challenge is asked for (the
 * commitment was worked out before). The root is zeroed as soon as it opens; only the node, whose signing key cannot be
 * exported, comes back. An unseal is never retried here: a second tap is the person's own.
 * @param canonical - the canonical words in use (they open the root here; they never cross).
 * @param commitmentSha256 - their commitment for this node, worked out before the tap.
 * @param status - a fresh status (bound, with its node key).
 * @param requestId - the challenge's request id (the same one on a second tap after Touch ID did not complete).
 * @param deps - the host call, the passkey, and the abort signal.
 * @returns the opened node, or how the tap ended.
 */
export async function openNodeForInvite(canonical: string, commitmentSha256: string, status: AumlokHostStatus, requestId: string,
  deps: InviteDeps): Promise<InviteStep<AumlokNode>> {
  const platform = deps.platform ?? browserPlatform
  const watched: AumlokPlatform = { ...platform, passkey: async (step, signal) => {
    try { return await platform.passkey(step, signal) } catch (error) { throw new PasskeyDidNotComplete(error) }
  } }
  // The unseal's host calls are watched only for the wait a capacity refusal names (the words say it).
  const call = deps.call ?? hostCall
  let wait: number | undefined
  const waitWatched: AumlokHostCall = async (route, signal, body) => {
    const answer = await call(route, signal, body)
    wait = waitOf(answer)
    return answer
  }
  try {
    const floor = deps.minIterations === undefined ? {} : { minIterations: deps.minIterations }
    const opened = await unsealAumlokNodeWith(canonical, commitmentSha256, status,
      { call: waitWatched, platform: watched, signal: deps.signal, ...floor }, requestId)
    if (!opened.ok) return refused(opened.reason, wait)
    // THE ROOT IS ZEROED AT ONCE: only the node's signing key, which WebCrypto will not export, is needed to sign.
    opened.root.fill(0)
    return { kind: 'done', value: opened.node }
  } catch (error) {
    if (deps.signal.aborted) return refused('invite:closed')
    if (error instanceof PasskeyDidNotComplete) return { kind: 'passkey', message: passkeyFailure(error.reason) }
    return refused('invite:unexpected-answer')
  }
}

/** One tap-2 request to the host: the challenge body, and what the host's echo must then say. */
interface SecondTap<P, T> {
  readonly challenge: Record<string, unknown>
  /** The echoed record, checked against what was asked, or null (then nothing is asked of Touch ID). */
  readonly echo: (body: Record<string, unknown>) => P | null
  readonly preimage: (payload: P) => string
  /** The record the host's last answer carries, accepted only when it is this tap's own and verifies. */
  readonly confirm: (body: Record<string, unknown>, payload: P, signature: string) => Promise<T | null>
}

/**
 * TAP 2, for an invite or a revocation: the challenge, the echo check (synchronous, before Touch ID), the passkey, this
 * page's own signature, and the last step.
 */
async function secondTap<P, T>(tap: SecondTap<P, T>, signer: () => CryptoKey | null, deps: InviteDeps): Promise<InviteStep<T>> {
  const call = deps.call ?? hostCall
  const platform = deps.platform ?? browserPlatform
  let challenge: HostAnswer
  try { challenge = await call(AUMLOK_ROUTES.challenge, deps.signal, tap.challenge) } catch { return refused('invite:closed') }
  if (challenge.kind !== 'live') return refused(codeOf(challenge), waitOf(challenge))
  // THE PASSKEY IS ASKED ONLY FOR WHAT THIS PAGE ASKED FOR. The echo is checked here, synchronously, and the node later
  // signs THIS PAGE'S OWN preimage of it; the host's `signaturePreimage` must match that text but is never what is signed.
  const payload = tap.echo(challenge.body)
  if (payload === null || challenge.body.signaturePreimage !== tap.preimage(payload)) return refused('invite:echo-mismatch')
  let assert: PasskeyChallenge
  try { assert = readChallenge('verify', challenge.body) } catch (error) { return refused(passkeyRanOut(error) ? 'invite:ran-out' : 'invite:unexpected-answer') }
  let asserted: PasskeyResponseJson
  try { asserted = await platform.passkey(assert, deps.signal) } catch (error) {
    return deps.signal.aborted ? refused('invite:closed') : { kind: 'passkey', message: passkeyFailure(error) }
  }
  // THE KEY IS USED ONLY WHILE THE ROOT IS STILL OPEN HERE (the caller drops it at two minutes, or on close).
  const key = signer()
  if (key === null) return refused('invite:root-closed')
  const signature = await signWithNode(key, tap.preimage(payload))
  return settle(call, { challengeId: assert.ceremonyId, credential: forHost(asserted), signature },
    body => tap.confirm(body, payload, signature))
}

/** Store refusals that are definite whatever their status (507, 503): the store records no invite when it gives them. */
const RECORDS_NOTHING: ReadonlySet<string> = new Set(['AUMLOK_INVITE_CAPACITY', 'AUMLOK_CLOCK_INVALID'])
/**
 * Refusals that, on the replay, say nothing about the first attempt: its record expired, or expired and was pruned, or
 * the store's clock failed before it read the record.
 */
const SILENT_ON_REPLAY: ReadonlySet<string> = new Set(['AUMLOK_CHALLENGE_EXPIRED', 'AUMLOK_CHALLENGE_UNKNOWN', 'AUMLOK_CLOCK_INVALID'])

/**
 * THE LAST STEP, ON A SIGNAL NOTHING ABORTS: once sent the host may record it. Only two answers are definite: the host's
 * confirmation carrying this tap's own record, and the AUMLOK store's own refusal, 4xx or one it gives only when it
 * records nothing (it records nothing on a refusal; a signed-out answer never reached it). Anything else may hide a
 * record, so it is asked once more with the SAME body, which the host answers idempotently; still unclear, the outcome
 * is unknown.
 */
async function settle<T>(call: AumlokHostCall, body: Record<string, unknown>,
  confirm: (body: Record<string, unknown>) => Promise<T | null>): Promise<InviteStep<T>> {
  const lasting = new AbortController().signal
  const ask = async (): Promise<HostAnswer | null> => {
    try { return await call(AUMLOK_ROUTES.invite, lasting, body) } catch { return null }
  }
  /** The store's own refusal (its code, or null): a 4xx, or a code it gives only when it records nothing. */
  const storeRefusal = (answer: HostAnswer | null): string | null =>
    (answer?.kind === 'refused' && /^AUMLOK_/u.test(answer.code)
      && ((answer.status >= 400 && answer.status < 500) || RECORDS_NOTHING.has(answer.code)) ? answer.code : null)
  const first = await ask()
  if (first?.kind === 'live') {
    const value = await confirm(first.body)
    return value === null ? { kind: 'unknown', code: 'invite:unexpected-answer' } : { kind: 'done', value }
  }
  // A signed-out answer comes from the Worker before the store is reached: nothing was recorded either.
  const definite = storeRefusal(first) ?? (first?.kind === 'refused' && first.code === 'OWNER_ACCESS_REQUIRED' ? first.code : null)
  if (definite !== null) return refused(definite, waitOf(first))
  const again = await ask()
  if (again?.kind === 'live') {
    const value = await confirm(again.body)
    return value === null ? { kind: 'unknown', code: 'invite:unexpected-answer' } : { kind: 'done', value }
  }
  // CHALLENGE_USED on the replay: the first attempt reached the store and was refused (a recorded one replays its record).
  // CHALLENGE_EXPIRED or CHALLENGE_UNKNOWN (an expired record the store pruned) on the replay says nothing about it.
  const replayed = storeRefusal(again)
  if (replayed !== null && !SILENT_ON_REPLAY.has(replayed)) return refused(replayed, waitOf(again))
  return { kind: 'unknown', code: 'invite:outcome-unknown' }
}

/** What an issue asks for: its request id (kept for a second tap) and the two fields the person chose. */
export interface IssueRequest {
  readonly requestId: string
  readonly inviteeCommitmentSha256: string
  readonly assignedDomainPointer: string | null
}

/** Whether a time the host chose is within `INVITE_CLOCK_SKEW_MS` of this page's clock. */
const nearNow = (at: number, now: number): boolean => Math.abs(at - now) <= INVITE_CLOCK_SKEW_MS

/**
 * The host's invite echo, checked against what was asked: exactly the ten fields, the schema, the sponsor equal to the
 * bound node key, the commitment and address as sent, not revoked, and exactly seven days to live. THE SLOT AND THE TIME
 * THE HOST CHOSE ARE TIED TO THE FRESH READ AND TO NOW: the month that read reports, the next sequence after the invites
 * it counts (within the monthly limit), and an issue time within minutes of this page's clock. Otherwise the node could
 * be asked to sign a future-dated invite, or a second one for a slot already used.
 * @param body - the challenge answer.
 * @param request - what was asked.
 * @param nodePubkeyHex - the node key from a fresh status read.
 * @param quota - the invite quota from that read (the one just after the unseal).
 * @param now - this page's clock.
 * @returns the invite to sign, or null.
 */
export function inviteEcho(body: Record<string, unknown>, request: IssueRequest, nodePubkeyHex: string, quota: InviteQuota,
  now: number = Date.now()): InvitePayload | null {
  if (body.purpose !== 'invite' || !isRecord(body.invite) || !exactKeys(body.invite, PAYLOAD_KEYS)) return null
  const invite = inviteFields(body.invite)
  if (invite?.sponsorPubkeyHex !== nodePubkeyHex || invite.inviteeCommitmentSha256 !== request.inviteeCommitmentSha256) return null
  if (invite.assignedDomainPointer !== request.assignedDomainPointer || invite.monthlySequence > quota.limit) return null
  if (invite.quotaMonth !== quota.month || invite.monthlySequence !== quota.issued + 1 || !nearNow(invite.issuedAt, now)) return null
  return invite.expiresAt - invite.issuedAt === INVITE_LIFETIME_MS ? invite : null
}

/**
 * The host's revocation echo: exactly the four fields, the schema, the invite asked for, the bound node key, and a
 * revocation time within minutes of this page's clock.
 * @param body - the challenge answer.
 * @param inviteId - the invite asked to revoke.
 * @param nodePubkeyHex - the node key from a fresh status read.
 * @param now - this page's clock.
 * @returns the revocation to sign, or null.
 */
export function revocationEcho(body: Record<string, unknown>, inviteId: string, nodePubkeyHex: string, now: number = Date.now())
  : RevocationPayload | null {
  if (body.purpose !== 'invite' || !isRecord(body.revocation) || !exactKeys(body.revocation, REVOCATION_KEYS)) return null
  const revocation = revocationFields(body.revocation)
  if (revocation?.inviteId !== inviteId || revocation.sponsorPubkeyHex !== nodePubkeyHex) return null
  return nearNow(revocation.revokedAt, now) ? revocation : null
}

/**
 * TAP 2 OF AN ISSUE. A confirmed receipt is remembered in this browser's book (public data only) before it is returned.
 * @param request - the request id and the two chosen fields (the same on a second tap).
 * @param signer - the node's signing key while the root is open here, else null.
 * @param read - the fresh status read the panel started from.
 * @param deps - the host call, the passkey, and the abort signal.
 * @returns the confirmed, verified receipt, or how the tap ended.
 */
export async function issueInvite(request: IssueRequest, signer: () => CryptoKey | null, read: InviteStatus, deps: InviteDeps)
  : Promise<InviteStep<InviteReceipt>> {
  const node = read.status.nodePubkeyHex
  const quota = read.quota
  if (node === null || quota === null) return refused('invite:not-ready')
  const step = await secondTap<InvitePayload, InviteReceipt>({
    challenge: { purpose: 'invite', requestId: request.requestId, inviteeCommitmentSha256: request.inviteeCommitmentSha256,
      assignedDomainPointer: request.assignedDomainPointer },
    echo: body => inviteEcho(body, request, node, quota),
    preimage: invitePreimage,
    confirm: async (body, payload, signature) => {
      const receipt = inviteReceiptOf(body.invite)
      if (receipt?.signature !== signature || canonicalJson(invitePayloadOf(receipt)) !== canonicalJson(payload)) return null
      return await verifyInviteReceipt(receipt, node) ? receipt : null
    },
  }, signer, deps)
  if (step.kind === 'done') rememberIssued(step.value)
  // ONE REFUSAL AT THE LIFETIME CAP IS ENOUGH: this browser asks this node for no further invite.
  if (step.kind === 'refused' && step.code === 'AUMLOK_INVITE_CAPACITY') rememberCapacityReached(node)
  return step
}

/** What a revocation asks for: its request id (kept for a second tap) and the invite. */
export interface RevokeRequest { readonly requestId: string; readonly inviteId: string }

/**
 * TAP 2 OF A REVOCATION. A confirmed revocation is remembered in this browser's book before it is returned. Revoking
 * never gives this month's quota back.
 * @param request - the request id and the invite (the same on a second tap).
 * @param signer - the node's signing key while the root is open here, else null.
 * @param read - the fresh status read the panel started from.
 * @param deps - the host call, the passkey, and the abort signal.
 * @returns the confirmed, verified revocation, or how the tap ended.
 */
export async function revokeInvite(request: RevokeRequest, signer: () => CryptoKey | null, read: InviteStatus, deps: InviteDeps)
  : Promise<InviteStep<SignedRevocation>> {
  const node = read.status.nodePubkeyHex
  if (node === null) return refused('invite:not-ready')
  const step = await secondTap<RevocationPayload, SignedRevocation>({
    challenge: { purpose: 'invite', requestId: request.requestId, action: 'revoke', inviteId: request.inviteId },
    echo: body => revocationEcho(body, request.inviteId, node),
    preimage: revocationPreimage,
    confirm: async (body, payload, signature) => {
      const revocation = signedRevocationOf(body.revocation)
      if (revocation?.signature !== signature || revocation.inviteId !== payload.inviteId) return null
      if (revocation.revokedAt !== payload.revokedAt) return null
      return await verifyRevocation(revocation, node) ? revocation : null
    },
  }, signer, deps)
  if (step.kind === 'done') rememberRevocation(step.value)
  return step
}

// ── This browser's book of what it issued and revoked ──────────────────────────────────────────────────────────────────

/** The receipts this browser issued and the revocations it signed. Public records only: never an invite code. */
export interface InviteBook { readonly receipts: readonly InviteReceipt[]; readonly revocations: readonly SignedRevocation[] }
const BOOK_SCHEMA = 'aukora.invite.issued.v1'
const EMPTY_BOOK: InviteBook = { receipts: [], revocations: [] }
/** The book when storage is closed (a private window, blocked site data): it lasts as long as this page. */
let memoryBook: InviteBook = EMPTY_BOOK

const storage = (): Storage | null => {
  try { return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage } catch { return null }
}
const lastUnique = <T extends { readonly inviteId: string }>(items: readonly T[]): T[] =>
  items.filter((item, index) => items.findIndex(other => other.inviteId === item.inviteId) === index).slice(-INVITE_BOOK_LIMIT)

function bookOf(value: unknown): InviteBook | null {
  if (!isRecord(value) || value.schema !== BOOK_SCHEMA || !Array.isArray(value.receipts) || !Array.isArray(value.revocations)) return null
  return {
    receipts: lastUnique(value.receipts.map(inviteReceiptOf).filter((item): item is InviteReceipt => item !== null)),
    revocations: lastUnique(value.revocations.map(signedRevocationOf).filter((item): item is SignedRevocation => item !== null)),
  }
}

/**
 * This browser's book. Every entry is re-checked for shape on each read; whether a receipt is the node's is checked
 * against a fresh status before anything is offered for it.
 * @returns the book (empty when nothing was kept).
 */
export function readInviteBook(): InviteBook {
  try {
    const raw = storage()?.getItem(INVITE_BOOK_KEY) ?? null
    const parsed = raw === null ? null : bookOf(JSON.parse(raw))
    if (parsed !== null) memoryBook = parsed
  } catch { /* storage closed or unreadable: the in-memory book stands */ }
  return memoryBook
}

function writeBook(book: InviteBook): void {
  memoryBook = { receipts: lastUnique(book.receipts), revocations: lastUnique(book.revocations) }
  try {
    storage()?.setItem(INVITE_BOOK_KEY, JSON.stringify({ schema: BOOK_SCHEMA, ...memoryBook }))
  } catch { /* storage closed: the in-memory book stands */ }
}

/** Keep a receipt the host confirmed (public data only). */
export function rememberIssued(receipt: InviteReceipt): void {
  const book = readInviteBook()
  if (!book.receipts.some(item => item.inviteId === receipt.inviteId)) writeBook({ ...book, receipts: [...book.receipts, receipt] })
}

/** Keep a revocation the host confirmed. */
export function rememberRevocation(revocation: SignedRevocation): void {
  const book = readInviteBook()
  if (book.revocations.some(item => item.inviteId === revocation.inviteId)) return
  writeBook({ ...book, revocations: [...book.revocations, revocation] })
}

/**
 * Whether this browser's book holds the lifetime cap of receipts that verify against the node key read just now: then
 * the host holds at least that many, and refuses every new invite.
 */
async function lifetimeCapHeld(nodePubkeyHex: string): Promise<boolean> {
  const { receipts } = readInviteBook()
  if (receipts.length < INVITE_LIFETIME_CAP) return false
  const verified = await Promise.all(receipts.map(receipt => verifyInviteReceipt(receipt, nodePubkeyHex)))
  return verified.filter(Boolean).length >= INVITE_LIFETIME_CAP
}

/** The node key the host refused an invite for at its lifetime cap, when storage is closed (it lasts as long as this page). */
let memoryCapacity: string | null = null

/**
 * Remember, for good, that this node refused an invite at its lifetime cap (the host never forgets an invite, and
 * revoking frees none). Only the node's public key is kept.
 * @param nodePubkeyHex - the node key the refusal was for.
 */
export function rememberCapacityReached(nodePubkeyHex: string): void {
  memoryCapacity = nodePubkeyHex
  try { storage()?.setItem(INVITE_CAPACITY_KEY, nodePubkeyHex) } catch { /* storage closed: the in-memory flag stands */ }
}

function capacityReached(nodePubkeyHex: string): boolean {
  try {
    const kept = storage()?.getItem(INVITE_CAPACITY_KEY) ?? null
    if (kept !== null && HEX64.test(kept)) memoryCapacity = kept
  } catch { /* storage closed or unreadable: the in-memory flag stands */ }
  return memoryCapacity === nodePubkeyHex
}

/** Tests only: forget the in-memory book and the in-memory lifetime-cap flag. */
export function forgetInviteBookForTests(): void {
  memoryBook = EMPTY_BOOK
  memoryCapacity = null
}

// ── The host's own list, an invite link, and what a guest can check ─────────────────────────────────────────

/** Where a host lists the invites its node signed and their revocations, when it serves that (an edge seam, Wave 5). */
export const INVITES_ROUTE = '/_host/aumlok/invites'
/** What the host's list gave this browser's book. */
export type HostInvitesRead =
  /** The host does not serve the list: the book holds only what this browser issued. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'refused'; readonly code: string }
  /** The list was read: how many receipts and revocations verified against the node key, and how many did not. */
  | { readonly kind: 'live'; readonly receipts: number; readonly revocations: number; readonly dropped: number }

/**
 * Read the host's list and keep every record that VERIFIES against the node key in this browser's book (public records
 * only), so invites issued on any device can be seen and revoked here. A record that does not verify is counted and
 * dropped, never kept. A GET: the host counts nothing for it.
 * @param nodePubkeyHex - the node key from a fresh status read.
 * @param signal - aborts the read.
 * @param call - the host call (tests pass their own).
 * @returns what the list gave.
 */
export async function syncHostInvites(nodePubkeyHex: string, signal: AbortSignal, call: AumlokHostCall = hostCall)
  : Promise<HostInvitesRead> {
  const answer = await call(INVITES_ROUTE, signal)
  if (answer.kind === 'absent') return { kind: 'absent' }
  if (answer.kind === 'refused') return { kind: 'refused', code: answer.code }
  const listed = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value.slice(0, INVITE_LIFETIME_CAP * 2) : [])
  let receipts = 0, revocations = 0, dropped = 0
  for (const item of listed(answer.body.invites)) {
    const receipt = inviteReceiptOf(item)
    if (receipt !== null && await verifyInviteReceipt(receipt, nodePubkeyHex)) { rememberIssued(receipt); receipts += 1 } else dropped += 1
  }
  for (const item of listed(answer.body.revocations)) {
    const revocation = signedRevocationOf(item)
    if (revocation === null || !await verifyRevocation(revocation, nodePubkeyHex)) { dropped += 1; continue }
    rememberRevocation(revocation)
    revocations += 1
  }
  return { kind: 'live', receipts, revocations, dropped }
}

/** The fragment an invite link carries its public receipt in. The invite code is never in a link. */
export const INVITE_LINK_PREFIX = '#invite='
/**
 * A link that opens this app on the invite: the public receipt, base64url, in the fragment (a fragment is not sent to
 * any server). It never carries the invite code.
 * @param receipt - the signed receipt.
 * @param origin - the origin the link opens.
 * @returns the link.
 */
export function inviteLinkOf(receipt: InviteReceipt, origin: string): string {
  return `${origin}/${INVITE_LINK_PREFIX}${base64url(encoder.encode(receiptJson(receipt)))}`
}

/**
 * The link the owner copies to give: it opens at the address the invite was made for (its `assignedDomainPointer`) when
 * it has one, else at this page's own address.
 * @param receipt - the signed receipt.
 * @param here - this page's origin.
 * @returns the invite link.
 */
export function inviteShareLink(receipt: InviteReceipt, here: string = globalThis.location.origin): string {
  return inviteLinkOf(receipt, receipt.assignedDomainPointer ?? here)
}

/**
 * Read a receipt from what a guest has: an invite link, its fragment, or the receipt's JSON itself.
 * @param text - the link, fragment or JSON.
 * @returns the receipt, or null when it is none of those.
 */
export function inviteFromText(text: string): InviteReceipt | null {
  const trimmed = text.trim()
  const at = trimmed.indexOf(INVITE_LINK_PREFIX)
  let json = trimmed
  if (at >= 0) {
    const bytes = fromBase64url(trimmed.slice(at + INVITE_LINK_PREFIX.length))
    if (bytes === null) return null
    try { json = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
  }
  try { return inviteReceiptOf(JSON.parse(json)) } catch { return null }
}

/** What this page can check of an invite a guest holds, without asking any host. */
export interface GuestInviteCheck {
  /** The receipt's Ed25519 signature verifies against the sponsor key the receipt itself names. */
  readonly signed: boolean
  readonly expired: boolean
  /** Whether the typed invite code is the one this invite was made for (null when no code was typed). */
  readonly codeMatches: boolean | null
}

/**
 * Check an invite as a guest: its signature against its own sponsor key, its expiry, and the invite code against the
 * commitment the receipt carries. Whether that sponsor is in the network, and whether the invite was revoked, only a
 * host can say; this page does not claim either.
 * @param receipt - the receipt.
 * @param code - the invite code the guest was given (base64url), or '' for none.
 * @param now - the clock.
 * @returns the checks.
 */
export async function checkGuestInvite(receipt: InviteReceipt, code: string, now: number = Date.now()): Promise<GuestInviteCheck> {
  const signed = await verifyInviteReceipt(receipt, receipt.sponsorPubkeyHex)
  const secret = code.trim() === '' ? null : fromBase64url(code.trim())
  let codeMatches: boolean | null = null
  if (code.trim() !== '') codeMatches = secret !== null && secret.length === 32 && await inviteeCommitment(secret) === receipt.inviteeCommitmentSha256
  secret?.fill(0)
  return { signed, expired: now >= receipt.expiresAt, codeMatches }
}

// ── Redeeming: the host's own check of an invite and its code ─────────────────────────────────────────────────────────

/** Where a host checks an invite and its code (`redeem` in deploy/cloudflare/src/aumlok.mjs). */
export const REDEEM_ROUTE = '/_host/aumlok/redeem'
export const INVITE_VERIFICATION_SCHEMA = 'aukora.invite-verification.v1'
/** The one freshness the store answers today: it read its own stored records, with no outside witness. */
export const REDEEM_FRESHNESS_LOCAL = 'LOCAL_DURABLE_STATE_ONLY'
/** Where a host says what it is (`runtime: 'local' | 'cloudflare'`). A GET: no host counts anything for it. */
const HOST_STATUS_ROUTE = '/__x6/status'

/**
 * The host's answer to a redemption, exactly as it gives it. THE HOST GRANTS NOTHING HERE: the three flags are false in
 * the only answer this page reads, so a verified code is never shown as access, an identity or a used invite.
 */
export interface InviteVerification {
  readonly schema: typeof INVITE_VERIFICATION_SCHEMA
  readonly inviteId: string
  readonly sponsorPubkeyHex: string
  readonly recipientStatus: 'CODE_VERIFIED'
  readonly verifiedAt: number
  readonly expiresAt: number
  readonly accessGranted: false
  readonly identityEnrolled: false
  readonly inviteConsumed: false
  readonly freshness: string
  /**
   * Whether this node can give a guest a way in after the check (`guestAccess`, since the Wave 6 edge): the host says
   * `{ available: false, code }` today. Absent on an edge from before it said so.
   */
  readonly guestAccess?: { readonly available: false; readonly code: string }
}

/**
 * How one redemption ended.
 *   verified  the host checked this invite and this code, and its answer is the one this page reads, field for field;
 *   refused   the host's own refusal, with its code and that code in words;
 *   absent    this host does not take a redemption (it has no such route, or it is the Mac host: nothing is sent there);
 *   unclear   nothing definite: the answer was lost or is not one this page reads, or nothing was sent and `detail` says why.
 */
export type RedeemOutcome =
  | { readonly kind: 'verified'; readonly value: InviteVerification }
  | { readonly kind: 'refused'; readonly code: string; readonly words: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unclear'; readonly detail: string }

/** Every refusal a redemption can meet, in plain words. Each says the node granted nothing, because it did not. */
const REDEEM_REFUSALS: Readonly<Record<string, string>> = {
  AUMLOK_INVITE_REDEEM_INVALID: 'This node refused the request as malformed. Nothing was checked.',
  AUMLOK_INVITE_SPONSOR_UNTRUSTED: 'This node did not sign this invite: it was vouched by another node’s key, or this node is not bound. '
    + 'Nothing was granted.',
  AUMLOK_INVITE_NOT_FOUND: 'This node holds no invite like this one. Nothing was granted.',
  AUMLOK_INVITE_REVOKED: 'This invite was revoked by the node that signed it. Nothing was granted.',
  AUMLOK_INVITE_EXPIRED: 'This node says the invite is not valid at this time (it has expired, or its time has not come). '
    + 'Nothing was granted.',
  AUMLOK_INVITE_CODE_INVALID: 'This node says the code is not the one this invite was made for. Nothing was granted.',
  OWNER_ACCESS_REQUIRED: 'This node answers only a signed-in session today, and this page has none here. Nothing was checked.',
  GUEST_DOOR_LOCKED: 'Too many checks came from this network, so this node is not checking invites from it for now. '
    + 'Nothing was checked or granted.',
  GUEST_DOOR_BUSY: 'This node is turning away guest checks for now. Nothing was checked or granted.',
  AUMLOK_CAPABILITY_REQUIRED: 'This page does not hold this host’s session, so the host did not look at the invite. Nothing was checked.',
  ...words('This page is not on the node’s own address, so the node did not look at the invite. Nothing was checked.',
    ['SAME_ORIGIN_BROWSER_REQUIRED', 'AUMLOK_ORIGIN_REQUIRED']),
  ...words('The node is not ready, so it checked nothing.', ['AUMLOK_CONFIGURATION_UNAVAILABLE', 'BOOTSTRAP_REQUIRED',
    'CLOUD_REQUEST_FAILED']),
}

/**
 * A redemption refusal in words.
 * @param code - the host's code.
 * @returns the sentence (a code this page does not know is named as the host said it, and claims nothing more).
 */
export function redeemRefusalWords(code: string): string {
  return (Object.hasOwn(REDEEM_REFUSALS, code) ? REDEEM_REFUSALS[code] : undefined) ?? `This node refused (${code}). Nothing was granted.`
}

const VERIFICATION_KEYS = ['ok', 'schema', 'inviteId', 'sponsorPubkeyHex', 'recipientStatus', 'verifiedAt', 'expiresAt', 'accessGranted',
  'identityEnrolled', 'inviteConsumed', 'freshness'] as const
/** The one field a newer edge adds: guest access, which it says is not available. */
const GUEST_ACCESS_KEYS = ['available', 'code'] as const

/**
 * THE HOST'S ANSWER, READ STRICTLY: exactly the eleven fields, this invite's id, sponsor and expiry, `CODE_VERIFIED`, and
 * the three flags false. An answer that claims more (access, an identity, a used invite) or names another invite is not
 * one this page reads, so it is never shown as verified.
 * @param body - the live answer's body.
 * @param receipt - the invite that was sent.
 * @returns the verification, or null.
 */
export function inviteVerificationOf(body: Record<string, unknown>, receipt: InviteReceipt): InviteVerification | null {
  // The eleven fields, or those and `guestAccess` (an edge that says whether a guest gets a way in). Nothing else.
  const withGuest = Object.hasOwn(body, 'guestAccess')
  if (!exactKeys(body, withGuest ? [...VERIFICATION_KEYS, 'guestAccess'] : VERIFICATION_KEYS)) return null
  const guest = withGuest ? body.guestAccess : null
  // GUEST ACCESS MAY ONLY BE "NOT AVAILABLE": an answer that says a guest was let in is not one this page reads.
  if (withGuest && (!isRecord(guest) || !exactKeys(guest, GUEST_ACCESS_KEYS) || guest.available !== false
    || typeof guest.code !== 'string' || !CODE.test(guest.code))) return null
  if (body.ok !== true || body.schema !== INVITE_VERIFICATION_SCHEMA) return null
  if (body.inviteId !== receipt.inviteId || body.sponsorPubkeyHex !== receipt.sponsorPubkeyHex) return null
  if (body.recipientStatus !== 'CODE_VERIFIED' || !stamp(body.verifiedAt) || body.expiresAt !== receipt.expiresAt) return null
  if (body.verifiedAt < receipt.issuedAt || body.verifiedAt >= receipt.expiresAt) return null
  if (body.accessGranted !== false || body.identityEnrolled !== false || body.inviteConsumed !== false) return null
  if (typeof body.freshness !== 'string' || !CODE.test(body.freshness)) return null
  return { schema: INVITE_VERIFICATION_SCHEMA, inviteId: receipt.inviteId, sponsorPubkeyHex: receipt.sponsorPubkeyHex,
    recipientStatus: 'CODE_VERIFIED', verifiedAt: body.verifiedAt, expiresAt: receipt.expiresAt, accessGranted: false,
    identityEnrolled: false, inviteConsumed: false, freshness: body.freshness,
    ...(isRecord(guest) && typeof guest.code === 'string' ? { guestAccess: { available: false as const, code: guest.code } } : {}) }
}

/** The schema of the edge's guest door descriptor (`GET /_host/aumlok/redeem` without a session). */
export const GUEST_DOOR_SCHEMA = 'aukora.guest-door.v1'
const GUEST_DOOR_KEYS = ['ok', 'schema', 'runtime', 'route', 'method', 'grants', 'counts'] as const
/** The guest door's descriptor, read strictly: exactly its seven fields, on the edge, granting nothing. */
function isGuestDoor(body: Record<string, unknown>): boolean {
  return exactKeys(body, GUEST_DOOR_KEYS) && body.ok === true && body.schema === GUEST_DOOR_SCHEMA && body.runtime === 'cloudflare'
    && body.route === REDEEM_ROUTE && body.method === 'POST' && body.grants === 'nothing' && body.counts === 'this-door-only'
}

/**
 * ASK THIS NODE TO CHECK AN INVITE AND ITS CODE: one `POST /_host/aumlok/redeem` with exactly `{ invite, code }`, never
 * retried here (a second press is the person's own).
 *
 * NOTHING THIS PAGE ALREADY KNOWS WILL FAIL IS SENT. The signature, the date and the code are checked here first
 * (`checkGuestInvite`); a code that is not this invite's never leaves the page.
 *
 * ONLY THE EDGE IS ASKED. The edge's store answers a redemption without counting anything (`redeem` runs outside its
 * attempt counter). The Mac host (server/local-host.mjs) has no redemption: it hands the same request to the store's
 * passkey step, which refuses it AND COUNTS IT as a failed Touch ID attempt, toward the lock that stops the owner's
 * Class 3 approvals (five in an hour, ten for good). So the host is first asked what it is (`GET /__x6/status`, which
 * counts nothing), and anything but `runtime: 'cloudflare'` is sent nothing.
 * @param receipt - the signed receipt (eleven fields).
 * @param code - the invite code as typed (base64url of 32 bytes).
 * @param signal - aborts the calls.
 * @param call - the host call (tests pass their own).
 * @returns how it ended; never throws except on abort.
 */
export async function redeemInvite(receipt: InviteReceipt, code: string, signal: AbortSignal, call: AumlokHostCall = hostCall)
  : Promise<RedeemOutcome> {
  const check = await checkGuestInvite(receipt, code)
  const secret = fromBase64url(code.trim())
  if (!check.signed || check.expired || check.codeMatches !== true || secret?.length !== 32) {
    secret?.fill(0)
    return { kind: 'unclear', detail: 'Nothing was sent: this page’s own check of the signature, the date and the code does not pass.' }
  }
  // The canonical form the host takes (43 base64url characters), made from the bytes, which are then zeroed.
  const canonicalCode = base64url(secret)
  secret.fill(0)
  const host = await call(HOST_STATUS_ROUTE, signal)
  // A GUEST (no session) IS REFUSED THE STATUS READ. The edge then says what it is at the guest door itself
  // (`GET /_host/aumlok/redeem`, `aukora.guest-door.v1`, `runtime: 'cloudflare'`), which counts nothing. Only that exact
  // answer lets the code go; anything else keeps the signed-out refusal and sends nothing.
  if (host.kind === 'refused' && host.code === 'OWNER_ACCESS_REQUIRED') {
    const door = await call(REDEEM_ROUTE, signal)
    if (!(door.kind === 'live' && isGuestDoor(door.body))) return { kind: 'refused', code: host.code, words: redeemRefusalWords(host.code) }
  } else if (host.kind === 'refused') {
    return { kind: 'unclear', detail: `Nothing was sent: this host would not say what it is (${host.code}), and this page asks only a host `
      + 'it knows takes a redemption.' }
  }
  const runtime = host.kind === 'live' ? host.body.runtime : host.kind === 'refused' && host.code === 'OWNER_ACCESS_REQUIRED' ? 'cloudflare' : undefined
  if (runtime === 'local') return { kind: 'absent' }
  if (runtime !== 'cloudflare') {
    return { kind: 'unclear', detail: 'Nothing was sent: this page could not tell which host serves it, and it asks only a host it '
      + 'knows takes a redemption.' }
  }
  // EXACTLY { invite, code }: the receipt's eleven fields and nothing a caller may have left on the object.
  const invite: InviteReceipt = { ...invitePayloadOf(receipt), signature: receipt.signature }
  const answer = await call(REDEEM_ROUTE, signal, { invite, code: canonicalCode })
  if (answer.kind === 'refused') return { kind: 'refused', code: answer.code, words: redeemRefusalWords(answer.code) }
  if (answer.kind === 'absent') {
    // ONLY A ROUTE THE HOST SAYS IT DOES NOT HAVE (404/405/501) IS "NOT TAKEN YET". Anything else after the code left the
    // page (a lost answer, a proxy's HTML error page, a body that would not read) leaves what the node did unknown.
    return answer.detail.startsWith('the host answers ')
      ? { kind: 'absent' }
      : { kind: 'unclear', detail: 'The answer was lost on the way, so what this node said is not known. It was not sent again.' }
  }
  const value = inviteVerificationOf(answer.body, receipt)
  return value === null
    ? { kind: 'unclear', detail: 'This node answered in a shape this page does not read, so nothing is claimed from it.' }
    : { kind: 'verified', value }
}

/** One line for a host without a redemption. */
export const REDEEM_ABSENT_WORDS = 'This host does not take a redemption yet.'

/**
 * What the Redeem card says after a press: exactly what the host said, INCLUDING WHAT IT DID NOT DO. A verified code is
 * a check and nothing more: the host's own answer says no access was granted, no identity enrolled and the invite not
 * used up, and the line says each.
 * @param outcome - how the redemption ended.
 * @returns the line.
 */
export function redeemWords(outcome: RedeemOutcome): string {
  if (outcome.kind === 'absent') return REDEEM_ABSENT_WORDS
  if (outcome.kind === 'unclear') return outcome.detail
  if (outcome.kind === 'refused') return `${outcome.words} (${outcome.code})`
  const { value } = outcome
  const witness = value.freshness === REDEEM_FRESHNESS_LOCAL ? 'It read only its own stored records, with no outside witness.'
    : `It names its freshness as ${value.freshness}.`
  return `This node verified the code for this invite at ${utc(value.verifiedAt)}: it holds this exact invite under its own key, has `
    + `not revoked it, and the code is the one it was made for. ${witness} That is all it did: nothing was granted, no identity `
    + `was enrolled, and the invite was not used up. The invite still expires ${utc(value.expiresAt)}.`
    + (value.guestAccess === undefined ? '' : ` This node gives guests no way in yet (${value.guestAccess.code}).`)
}
