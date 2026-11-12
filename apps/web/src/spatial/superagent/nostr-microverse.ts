/**
 * Pure Nostr projection. Nothing here opens a socket or a relay.
 *
 * NIP-01 ids are SHA-256 of `[0, pubkey, created_at, kind, tags, content]`.
 * BIP-340 verifies a 64-byte signature over that 32-byte id with an x-only key.
 * `signatureStatus` is `verified` only when both checks pass. A NIP-01 `OK`
 * array is a protocol-shaped acknowledgement, not authenticated relay evidence.
 * North Star §8.19: Marmot metadata is not MLS encryption or forward secrecy.
 */
import { sha256Bytes } from './lineage.ts'
import type { MicroverseProjection, MicroverseTier, NostrEventFields } from './types.ts'

/** Projection with a real Schnorr result. Delivery stays unverified. */
export interface VerifiedMicroverseProjection extends Omit<MicroverseProjection, 'signatureValid' | 'signatureStatus'> {
  readonly signatureValid: boolean
  readonly signatureStatus:
    | 'verified'
    | 'invalid'
    | 'unsigned'
    | 'malformed-sig'
    | 'not-checked'
    | 'bip340-verifier-unavailable'
}

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/

/** Input to {@link projectNostrMicroverse}. Optional objects are claims, not proofs. */
export interface MicroverseInput {
  readonly event: unknown
  readonly tier: MicroverseTier
  readonly relayEvidence?: unknown
  readonly marmot?: unknown
  readonly mlsEncrypted?: unknown
  readonly forwardSecrecy?: unknown
}

/**
 * Project one event. Schnorr is checked locally. Nothing is sent to a relay.
 * @param input - Event, tier, and any caller claims.
 * @returns Grammar, id check, Schnorr result, and unperformed NIP-44 / MLS claims.
 */
export async function projectNostrMicroverse(input: MicroverseInput): Promise<VerifiedMicroverseProjection> {
  const reasons: string[] = []
  const event = parseEvent(input.event)
  if (event === null) {
    reasons.push('nip01-malformed')
    return projection(input.tier, 'malformed', false, false, 'not-checked', 'absent', null, reasons)
  }
  const idValid = await eventIdMatches(event)
  if (!idValid) reasons.push('nip01-id-mismatch')
  const signature = signatureOf(event, idValid)
  reasons.push(...signature.reasons)
  const links = linksOf(event)
  const marmot = marmotOf(input.marmot)
  if (input.tier === 'macroverse-marmot-mls') {
    if (marmot === 'malformed') reasons.push('marmot-metadata-malformed')
    if (marmot === 'absent') reasons.push('marmot-metadata-absent')
    if (marmot === 'present') reasons.push('marmot-metadata-not-mls')
  }
  if (input.mlsEncrypted === true || input.forwardSecrecy === true) reasons.push('forged-mls-flag-ignored')
  if (input.tier === 'microverse-local') reasons.push('local-storage-not-delivery')
  if (input.tier !== 'microverse-local') {
    reasons.push(...relayReasons(input.relayEvidence, event.id))
    if (input.tier === 'macroverse-nip44-dm') reasons.push('nip44-verifier-unavailable')
  }
  const marmotMetadata = input.tier === 'macroverse-marmot-mls' ? marmot : 'absent'
  return projection(input.tier, 'valid', idValid, signature.signatureValid, signature.signatureStatus, marmotMetadata, links, reasons)
}

/**
 * Lowercase hex SHA-256 of the NIP-01 serialization `[0, pubkey, created_at, kind, tags, content]`.
 * @param event - A parsed event.
 * @returns The id a verifier should compare to `event.id`.
 */
export async function nip01EventId(
  event: Pick<NostrEventFields, 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content'>,
): Promise<string> {
  const body = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function eventIdMatches(event: ParsedEvent): Promise<boolean> {
  return await nip01EventId(event) === event.id
}

interface ParsedEvent {
  readonly id: string
  readonly pubkey: string
  readonly created_at: number
  readonly kind: number
  readonly tags: readonly (readonly string[])[]
  readonly content: string
  readonly sig: string | null
}

function parseEvent(value: unknown): ParsedEvent | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !HEX_64.test(value.id)) return null
  if (typeof value.pubkey !== 'string' || !HEX_64.test(value.pubkey)) return null
  if (typeof value.created_at !== 'number' || !Number.isSafeInteger(value.created_at) || value.created_at < 0 || Object.is(value.created_at, -0)) return null
  if (typeof value.kind !== 'number' || !Number.isSafeInteger(value.kind) || value.kind < 0 || Object.is(value.kind, -0)) return null
  if (typeof value.content !== 'string') return null
  if (value.sig === undefined) return null
  if (value.sig !== null && typeof value.sig !== 'string') return null
  const tags = tagsOf(value.tags)
  if (tags === null) return null
  return {
    id: value.id, pubkey: value.pubkey, created_at: value.created_at, kind: value.kind,
    tags, content: value.content, sig: value.sig === null ? null : value.sig,
  }
}

function signatureOf(event: ParsedEvent, idValid: boolean): {
  signatureValid: boolean
  signatureStatus: VerifiedMicroverseProjection['signatureStatus']
  reasons: string[]
} {
  if (event.sig === null) return { signatureValid: false, signatureStatus: 'unsigned', reasons: ['nip01-unsigned'] }
  if (!HEX_128.test(event.sig)) return { signatureValid: false, signatureStatus: 'malformed-sig', reasons: ['nip01-sig-malformed'] }
  const message = hexToBytes(event.id)
  if (message === null || !bip340Verify(event.pubkey, message, event.sig) || !idValid) {
    return { signatureValid: false, signatureStatus: 'invalid', reasons: ['bip340-invalid'] }
  }
  return { signatureValid: true, signatureStatus: 'verified', reasons: ['bip340-verified'] }
}

function relayReasons(value: unknown, eventId: string): string[] {
  if (Array.isArray(value) && value[0] === 'OK') {
    const matched = value[1] === eventId && typeof value[2] === 'boolean' && (value[3] === undefined || typeof value[3] === 'string')
    return matched
      ? ['relay-ack-protocol-shaped', 'relay-ack-not-authenticated']
      : ['relay-ack-malformed', 'relay-ack-not-authenticated']
  }
  if (value === undefined || value === null) return ['relay-evidence-absent']
  return ['relay-evidence-not-validated', 'relay-ack-not-authenticated']
}

function tagsOf(value: unknown): (readonly string[])[] | null {
  if (!Array.isArray(value)) return null
  const tags: (readonly string[])[] = []
  for (const tag of value) {
    if (!Array.isArray(tag) || tag.length === 0 || tag.some(item => typeof item !== 'string')) return null
    tags.push(tag as string[])
  }
  return tags
}

function linksOf(event: ParsedEvent): {
  pearlId: string | null
  receiptHash: string | null
  mandateId: string | null
  trajectoryId: string | null
} | null {
  if (event.kind !== 30078) return null
  return {
    pearlId: tagValue(event.tags, 'pearl'),
    receiptHash: tagValue(event.tags, 'receipt'),
    mandateId: tagValue(event.tags, 'mandate'),
    trajectoryId: tagValue(event.tags, 'trajectory'),
  }
}

function tagValue(tags: readonly (readonly string[])[], name: string): string | null {
  const tag = tags.find(item => item[0] === name)
  const value = tag?.[1]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function marmotOf(value: unknown): 'absent' | 'present' | 'malformed' {
  if (value === undefined || value === null) return 'absent'
  if (!isRecord(value)) return 'malformed'
  if (typeof value.groupId !== 'string' || value.groupId.length === 0 || value.groupId.length > 200) return 'malformed'
  if (typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || Object.is(value.epoch, -0)) return 'malformed'
  if (typeof value.cipherSuite !== 'string' || value.cipherSuite.length === 0 || value.cipherSuite.length > 80) return 'malformed'
  if (!Array.isArray(value.memberPubkeys) || value.memberPubkeys.length === 0) return 'malformed'
  if (value.memberPubkeys.some(item => typeof item !== 'string' || !HEX_64.test(item))) return 'malformed'
  return 'present'
}

function projection(
  tier: MicroverseTier,
  grammar: 'valid' | 'malformed',
  idValid: boolean,
  signatureValid: boolean,
  signatureStatus: VerifiedMicroverseProjection['signatureStatus'],
  marmotMetadata: MicroverseProjection['marmotMetadata'],
  links: ReturnType<typeof linksOf>,
  reasons: readonly string[],
): VerifiedMicroverseProjection {
  return {
    tier: grammar === 'malformed' ? 'malformed' : tier,
    grammar,
    idValid,
    signatureValid,
    signatureStatus,
    deliveryVerified: false,
    deliveryStatus: tier === 'microverse-local' ? 'local-not-delivery' : 'unperformed',
    nip44Verified: false,
    mlsEncryptionVerified: false,
    mlsForwardSecrecyVerified: false,
    marmotMetadata,
    pearlId: links?.pearlId ?? null,
    receiptHash: links?.receiptHash ?? null,
    mandateId: links?.mandateId ?? null,
    trajectoryId: links?.trajectoryId ?? null,
    reasons,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const FIELD = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn
const ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n
const GENERATOR = {
  x: 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
  y: 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n,
}

interface Affine { readonly x: bigint; readonly y: bigint }

/**
 * BIP-340 verify. The message is the raw byte string, 32 bytes for a NIP-01 id.
 * @param pubkeyHex - 32-byte x-only public key, lowercase hex.
 * @param message - Signed message.
 * @param signatureHex - 64-byte signature, lowercase hex.
 * @returns True only when the signature equation holds.
 */
export function bip340Verify(pubkeyHex: string, message: Uint8Array, signatureHex: string): boolean {
  const pubkey = hexToBytes(pubkeyHex)
  const signature = hexToBytes(signatureHex)
  if (pubkey === null || pubkey.length !== 32 || signature === null || signature.length !== 64) return false
  const point = liftX(readInt(pubkey))
  if (point === null) return false
  const r = readInt(signature.subarray(0, 32))
  const s = readInt(signature.subarray(32))
  if (r >= FIELD || s >= ORDER) return false
  const challenge = taggedHash('BIP0340/challenge', [bytes32(r), pubkey, message])
  if (challenge === null) return false
  const e = readInt(challenge) % ORDER
  const right = e === 0n ? null : pointMul(ORDER - e, point)
  const candidate = pointAdd(pointMul(s, GENERATOR), right)
  return candidate !== null && (candidate.y & 1n) === 0n && candidate.x === r
}

/**
 * BIP-340 sign, for fixtures. This does not touch an owner key.
 * @param secretHex - 32-byte scalar, lowercase hex.
 * @param message - Message bytes.
 * @param auxHex - 32-byte auxiliary randomness, lowercase hex.
 * @returns 64-byte hex signature, or null when the key or nonce is rejected.
 */
export function bip340Sign(secretHex: string, message: Uint8Array, auxHex: string): string | null {
  const secret = hexToBytes(secretHex)
  const aux = hexToBytes(auxHex)
  if (secret === null || secret.length !== 32 || aux === null || aux.length !== 32) return null
  let scalar = readInt(secret)
  if (scalar <= 0n || scalar >= ORDER) return null
  const point = pointMul(scalar, GENERATOR)
  if (point === null) return null
  if ((point.y & 1n) === 1n) scalar = ORDER - scalar
  const auxHash = taggedHash('BIP0340/aux', [aux])
  if (auxHash === null) return null
  const nonceHash = taggedHash('BIP0340/nonce', [xorBytes(bytes32(scalar), auxHash), bytes32(point.x), message])
  if (nonceHash === null) return null
  let nonce = readInt(nonceHash) % ORDER
  if (nonce === 0n) return null
  const noncePoint = pointMul(nonce, GENERATOR)
  if (noncePoint === null) return null
  if ((noncePoint.y & 1n) === 1n) nonce = ORDER - nonce
  const challenge = taggedHash('BIP0340/challenge', [bytes32(noncePoint.x), bytes32(point.x), message])
  if (challenge === null) return null
  const s = mod(nonce + (readInt(challenge) % ORDER) * scalar, ORDER)
  return `${toHex(bytes32(noncePoint.x))}${toHex(bytes32(s))}`
}

function taggedHash(tag: string, parts: readonly Uint8Array[]): Uint8Array | null {
  const tagHash = sha256Bytes(new TextEncoder().encode(tag))
  if (tagHash === null) return null
  let length = tagHash.length * 2
  for (const part of parts) length += part.length
  const body = new Uint8Array(length)
  body.set(tagHash, 0)
  body.set(tagHash, tagHash.length)
  let offset = tagHash.length * 2
  for (const part of parts) {
    body.set(part, offset)
    offset += part.length
  }
  return sha256Bytes(body)
}

function liftX(x: bigint): Affine | null {
  if (x < 0n || x >= FIELD) return null
  const y2 = mod(x * x * x + 7n, FIELD)
  const y = modPow(y2, (FIELD + 1n) / 4n, FIELD)
  if (mod(y * y, FIELD) !== y2) return null
  return { x, y: (y & 1n) === 0n ? y : FIELD - y }
}

function pointAdd(left: Affine | null, right: Affine | null): Affine | null {
  if (left === null) return right
  if (right === null) return left
  if (left.x === right.x) {
    if (left.y !== right.y || left.y === 0n) return null
    const slope = mod(3n * left.x * left.x * inv(2n * left.y, FIELD), FIELD)
    const x = mod(slope * slope - 2n * left.x, FIELD)
    return { x, y: mod(slope * (left.x - x) - left.y, FIELD) }
  }
  const slope = mod((right.y - left.y) * inv(right.x - left.x, FIELD), FIELD)
  const x = mod(slope * slope - left.x - right.x, FIELD)
  return { x, y: mod(slope * (left.x - x) - left.y, FIELD) }
}

function pointMul(scalar: bigint, point: Affine): Affine | null {
  let result: Affine | null = null
  let addend: Affine | null = point
  let rest = scalar
  while (rest > 0n) {
    if ((rest & 1n) === 1n) result = pointAdd(result, addend)
    addend = pointAdd(addend, addend)
    rest >>= 1n
  }
  return result
}

function mod(value: bigint, modulus: bigint): bigint {
  const rest = value % modulus
  return rest >= 0n ? rest : rest + modulus
}

function inv(value: bigint, modulus: bigint): bigint {
  let target = mod(value, modulus)
  let inverse = 1n
  let basis = 0n
  let modulusRest = modulus
  while (target !== 0n) {
    const quote = modulusRest / target
    const next = target
    target = modulusRest - quote * target
    modulusRest = next
    const nextInverse = inverse
    inverse = basis - quote * inverse
    basis = nextInverse
  }
  return mod(basis, modulus)
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let factor = mod(base, modulus)
  let rest = exponent
  while (rest > 0n) {
    if ((rest & 1n) === 1n) result = mod(result * factor, modulus)
    factor = mod(factor * factor, modulus)
    rest >>= 1n
  }
  return result
}

function bytes32(value: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let rest = value
  for (let index = 31; index >= 0; index -= 1) {
    out[index] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

function readInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) + BigInt(byte)
  return value
}

function xorBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length)
  for (let index = 0; index < left.length; index += 1) out[index] = (left[index] ?? 0) ^ (right[index] ?? 0)
  return out
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return out
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
