/**
 * Owner-grant attestation. This is not the receipt checkpoint.
 *
 * `PINNED_RECEIPT_SIGNERS` authenticate checkpoint history. They are not an owner
 * trust root, and a public key copied from a receipt is not added here.
 * The caller passes trust roots separately. An empty list verifies nothing.
 * A valid signature is not a passkey `userVerification`.
 */
import { canonicalJson, scopeLimitSound } from './contract.ts'

/** Domain for the owner-grant signature. It is not the checkpoint domain. */
export const OWNER_GRANT_DOMAIN = 'aukora.x6.owner-grant.v1\0'

/** Proposed attestation name. The seed organ does not write this object. */
export const OWNER_GRANT_SCHEMA = 'aukora.x6.owner-grant.v1'

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/

/** Labels a model or tab can write without an owner. They never become owner confirmation. */
export const REJECTED_OWNER_IDENTITIES = ['spatial-tab', 'agent', 'agent-self-unverified', 'person'] as const

/** Fields the owner signature covers. */
export interface OwnerGrantBinding {
  readonly mandateId: string
  readonly ticketId: string | null
  readonly scope: unknown
  readonly ballId: string | null
  readonly epoch: number | null
  readonly expiresAt: number | null
  readonly identity: string
}

/** Why an attestation did not confirm the owner. `verified` is the only pass. */
export type OwnerAttestationStatus =
  | 'verified'
  | 'missing'
  | 'malformed'
  | 'untrusted-key'
  | 'bad-signature'
  | 'binding-mismatch'

/**
 * Whether this identity string is a self-serve label.
 * @param identity - Grant identity, or null when absent.
 * @returns True when owner confirmation must refuse the label.
 */
export function ownerIdentityRejected(identity: string | null): boolean {
  if (identity === null || identity.length === 0) return true
  return (REJECTED_OWNER_IDENTITIES as readonly string[]).includes(identity)
}

/**
 * Canonical text signed by an owner key.
 * @param binding - Grant fields. Key order does not change the text.
 * @returns Canonical JSON including the schema name.
 */
export function ownerGrantCanonical(binding: OwnerGrantBinding): string {
  return canonicalJson({
    schema: OWNER_GRANT_SCHEMA,
    mandateId: binding.mandateId,
    ticketId: binding.ticketId,
    scope: binding.scope === undefined ? null : binding.scope,
    ballId: binding.ballId,
    epoch: binding.epoch,
    expiresAt: binding.expiresAt,
    identity: binding.identity,
  })
}

/**
 * Check one attestation against a binding and a caller-supplied key list.
 * @param binding - Fields taken from the grant receipt, not from the attestation.
 * @param attestation - Envelope, or null when none was supplied.
 * @param trustedKeys - Owner public keys. Receipt keys and checkpoint signers are not implied.
 * @returns `verified` only when the envelope matches the binding and a trusted key signed it.
 */
export async function verifyOwnerAttestation(
  binding: OwnerGrantBinding,
  attestation: unknown,
  trustedKeys: readonly string[],
): Promise<OwnerAttestationStatus> {
  if (attestation === null || attestation === undefined) return 'missing'
  const parsed = parseAttestation(attestation)
  if (parsed === null) return 'malformed'
  if (!sameBinding(binding, parsed.binding)) return 'binding-mismatch'
  if (!trustedKeys.includes(parsed.publicKeyHex)) return 'untrusted-key'
  const ok = await verifyEd25519(parsed.publicKeyHex, parsed.signatureHex, OWNER_GRANT_DOMAIN + ownerGrantCanonical(binding))
  return ok ? 'verified' : 'bad-signature'
}

function sameBinding(expected: OwnerGrantBinding, actual: OwnerGrantBinding): boolean {
  return ownerGrantCanonical(expected) === ownerGrantCanonical(actual)
}

function parseAttestation(value: unknown): { binding: OwnerGrantBinding; publicKeyHex: string; signatureHex: string } | null {
  if (!isRecord(value) || value.schema !== OWNER_GRANT_SCHEMA) return null
  if (typeof value.mandateId !== 'string' || value.mandateId.length === 0 || value.mandateId.length > 200) return null
  if (value.ticketId !== null && (typeof value.ticketId !== 'string' || value.ticketId.length === 0 || value.ticketId.length > 200)) return null
  if (value.ballId !== null && (typeof value.ballId !== 'string' || !HEX_64.test(value.ballId))) return null
  if (value.epoch !== null && (typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch) || value.epoch < 0)) return null
  if (value.expiresAt !== null && (typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || Object.is(value.expiresAt, -0))) return null
  if (typeof value.identity !== 'string' || value.identity.length === 0 || value.identity.length > 200) return null
  if (typeof value.publicKeyHex !== 'string' || !HEX_64.test(value.publicKeyHex)) return null
  if (typeof value.signatureHex !== 'string' || !HEX_128.test(value.signatureHex)) return null
  if (!scopeLimitSound(value.scope)) return null
  return {
    binding: {
      mandateId: value.mandateId,
      ticketId: value.ticketId,
      scope: value.scope === undefined ? null : value.scope,
      ballId: value.ballId,
      epoch: value.epoch,
      expiresAt: value.expiresAt,
      identity: value.identity,
    },
    publicKeyHex: value.publicKeyHex,
    signatureHex: value.signatureHex,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function verifyEd25519(publicKeyHex: string, signatureHex: string, message: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', bytesOf(hexToBytes(publicKeyHex)), { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, bytesOf(hexToBytes(signatureHex)), new TextEncoder().encode(message))
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotSupportedError') return false
    return false
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return out
}

function bytesOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
