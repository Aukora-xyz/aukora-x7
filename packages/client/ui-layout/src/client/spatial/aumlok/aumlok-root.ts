// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE NODE'S ROOT, SEALED BY THE SEVEN WORDS.
 *
 * ONE ROOT. At the first binding this page makes 32 random bytes. Everything the node signs with comes from them:
 *   Ed25519 node key    seed = SHA-256('aukora:aumlok-root-key:v1\0' || root)   (the crate's ROOT_KEY_DOMAIN,
 *                       in an earlier repository, so the same root gives the same key there)
 *   ML-DSA-65 seed      xi   = SHA-256('aukora:aumlok-root-ml-dsa-65:v1\0' || root)   (the 32-byte FIPS 204 key-generation
 *                       seed; no ML-DSA key is made in this page yet, because no ML-DSA library is in its packages)
 * A rotation of the words re-seals the same root, so the node keeps its public key and every invite it signed.
 *
 * THE SEAL. AES-256-GCM over the root. Key: PBKDF2-SHA256, 600 000 iterations, over 'aukora.aumlok.seal.v1\0' + the
 * normalised words, with a fresh 256-bit random salt. IV: 96 random bits. Additional data:
 * 'aukora.aumlok.sealed-root.v1\0' + the node's public key, so a sealed root opens only as the node it names. Only the
 * four public fields {sealedRootKeyB64, kdfSaltB64, kdfIterations, ivB64} leave this module. They travel in the bind and
 * rotate requests, and the host keeps them in its peppered escrow (`deploy/cloudflare/src/aumlok.mjs`). This
 * page never stores them, the root, or the words.
 *
 * SECURITY STATEMENT (AUMLOK v2). The phrase alone is inert by protocol; offline verification is impossible without
 * infrastructure compromise; online guessing is rate-limited and audited; and the residual risk is written down.
 *
 * HOW THIS CODE MEETS EACH CLAUSE, AND WHERE IT DOES NOT:
 *   inert        the words open nothing by themselves: the sealed root is released only after the bound passkey asserts
 *                (user verification required), and the host's own rules still decide what the node may do.
 *   offline      nothing PUBLIC can check a guess: the host no longer serves the commitment, keeps the sealed root under
 *                its pepper at rest, and this page stores neither. Without the passkey, checking a guess offline needs the
 *                escrow AND its pepper, which is an infrastructure compromise. With the passkey it does not: see residual 1.
 *   online       the host never sees a word. What it rate-limits and records are passkey and proof attempts: every
 *                release of the sealed root needs a user-verified passkey assertion, and failures count, back off and
 *                lock. A word guess is checked only in the page, after a release, and is not counted.
 *   residual     1. One user-verified passkey assertion on `unseal` releases the four sealed fields to the page, and
 *                   every rotation does exactly that. Whoever then holds them (a compromised page included) can search the
 *                   phrase space offline: 11 253 636 424 086 phrases (2^43.36), each costing 600 000 PBKDF2-SHA256
 *                   iterations, about 6.8 * 10^18 iterations for the whole space (INFERRED arithmetic; no hardware rate is
 *                   claimed here).
 *                2. A compromised page or browser sees the words while they are typed and the root while it is open.
 *                   The node's Ed25519 seed also passes once through a JavaScript string at each derivation (WebCrypto
 *                   gives the public half of an imported seed only through a JWK export), and a string cannot be wiped.
 *                3. The words cannot be recovered by anyone if they are lost; the root then cannot be opened.
 *                4. The ML-DSA-65 seed is derived but unused until an ML-DSA signer exists in the page.
 *                5. If the answer to a rotation's last step is lost, this page cannot tell which words are in force (the
 *                   host's status does not say); it asks once again with the same body and then says to keep both.
 * @module aumlok/aumlok-root
 */
import { base64url, fromBase64url } from '../apps/identity/webauthn.ts'

export const AUMLOK_ROOT_BYTES = 32
export const AUMLOK_ROOT_KEY_DOMAIN = 'aukora:aumlok-root-key:v1\0'
export const AUMLOK_ROOT_ML_DSA_DOMAIN = 'aukora:aumlok-root-ml-dsa-65:v1\0'
export const AUMLOK_SEAL_DOMAIN = 'aukora.aumlok.seal.v1\0'
export const AUMLOK_SEALED_ROOT_AAD = 'aukora.aumlok.sealed-root.v1\0'
/** The production work factor, and the bounds a sealed root is accepted within (the host's own bounds). */
export const AUMLOK_SEAL_ITERATIONS = 600_000
export const AUMLOK_SEAL_MAX_ITERATIONS = 2_000_000

/** The four public fields of a sealed root, exactly as the host's escrow takes them (base64url, no padding). */
export interface AumlokSealedRoot {
  readonly sealedRootKeyB64: string
  readonly kdfSaltB64: string
  readonly kdfIterations: number
  readonly ivB64: string
}
/** The node as its root makes it: the public key, and a signing key whose private half cannot be exported. */
export interface AumlokNode {
  readonly nodePubkeyHex: string
  readonly signingKey: CryptoKey
}
/** Fill bytes from the platform's cryptographic generator (tests pass their own). */
export type ByteFill = (array: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>
const platformBytes: ByteFill = array => globalThis.crypto.getRandomValues(array)

const encoder = new TextEncoder()
const subtle = (): SubtleCrypto => globalThis.crypto.subtle
const hexOf = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
const joined = (prefix: string, bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const head = encoder.encode(prefix)
  const out = new Uint8Array(head.length + bytes.length)
  out.set(head)
  out.set(bytes, head.length)
  return out
}
/** A domain-separated SHA-256 of the root; the scratch input is zeroed before it returns. */
const digestOf = async (domain: string, root: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
  const input = joined(domain, root)
  try { return new Uint8Array(await subtle().digest('SHA-256', input)) } finally { input.fill(0) }
}
const PKCS8_ED25519_PREFIX = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20)

/**
 * A fresh root.
 * @param random - the generator (the platform's, outside tests).
 * @returns 32 random bytes. The caller zeroes them when done.
 */
export function newAumlokRoot(random: ByteFill = platformBytes): Uint8Array<ArrayBuffer> {
  return random(new Uint8Array(AUMLOK_ROOT_BYTES))
}

/**
 * The node a root makes: its Ed25519 key from SHA-256(ROOT_KEY_DOMAIN || root), imported as PKCS#8 (the only way
 * WebCrypto takes a private seed). The public half is read once from an exportable copy; the key handed back cannot be
 * exported. The seed and the PKCS#8 buffer are zeroed before this returns.
 * @param root - the 32-byte root.
 * @returns the node.
 */
export async function aumlokNodeOf(root: Uint8Array): Promise<AumlokNode> {
  if (root.length !== AUMLOK_ROOT_BYTES) throw new RangeError('aumlok: a root is 32 bytes')
  const seed = await digestOf(AUMLOK_ROOT_KEY_DOMAIN, root)
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length)
  pkcs8.set(PKCS8_ED25519_PREFIX)
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length)
  try {
    // Only `x` is read; the JWK's `d` (the seed) is dropped at once, but its string cannot be wiped (residual 2).
    const readable = await subtle().importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
    const publicKey = fromBase64url((await subtle().exportKey('jwk', readable)).x ?? '')
    if (publicKey?.length !== 32) throw new Error('aumlok: no Ed25519 public key')
    const signingKey = await subtle().importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
    return { nodePubkeyHex: hexOf(publicKey), signingKey }
  } finally {
    seed.fill(0)
    pkcs8.fill(0)
  }
}

/**
 * The ML-DSA-65 key-generation seed a root makes (FIPS 204's 32-byte xi), domain-separated from the Ed25519 seed.
 * @param root - the 32-byte root.
 * @returns the seed. The caller zeroes it when done.
 */
export async function aumlokMlDsaSeedOf(root: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (root.length !== AUMLOK_ROOT_BYTES) throw new RangeError('aumlok: a root is 32 bytes')
  return digestOf(AUMLOK_ROOT_ML_DSA_DOMAIN, root)
}

/** The AES-256-GCM key the words make with this salt and work factor (not extractable). */
async function sealKey(canonical: string, salt: Uint8Array<ArrayBuffer>, iterations: number, usage: KeyUsage): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', encoder.encode(AUMLOK_SEAL_DOMAIN + canonical), 'PBKDF2', false, ['deriveKey'])
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, [usage])
}

export interface SealOptions {
  /** The work factor (tests lower it; production keeps 600 000, the host's floor). */
  readonly iterations?: number
  readonly random?: ByteFill
}

/**
 * Seal a root under the words, for the node it makes.
 * @param root - the 32-byte root.
 * @param canonical - the canonical phrase (`parseAumlokPhrase(...).canonical`).
 * @param nodePubkeyHex - the root's node (bound into the additional data).
 * @param options - test seams.
 * @returns the four public fields.
 */
export async function sealAumlokRoot(root: Uint8Array<ArrayBuffer>, canonical: string, nodePubkeyHex: string,
  options: SealOptions = {}): Promise<AumlokSealedRoot> {
  if (root.length !== AUMLOK_ROOT_BYTES) throw new RangeError('aumlok: a root is 32 bytes')
  const iterations = options.iterations ?? AUMLOK_SEAL_ITERATIONS
  const random = options.random ?? platformBytes
  const salt = random(new Uint8Array(32))
  const iv = random(new Uint8Array(12))
  const key = await sealKey(canonical, salt, iterations, 'encrypt')
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(AUMLOK_SEALED_ROOT_AAD + nodePubkeyHex) },
    key, root))
  return { sealedRootKeyB64: base64url(sealed), kdfSaltB64: base64url(salt), kdfIterations: iterations, ivB64: base64url(iv) }
}

/**
 * Read a sealed root from a host answer: exactly the four fields, the host's sizes (48-byte sealed root, 32-byte salt,
 * 12-byte IV) and a work factor no lower than the floor.
 * @param value - the untrusted answer (or its `sealedRoot` member).
 * @param minIterations - the floor (tests lower it; production keeps 600 000).
 * @returns the sealed root, or null when it is not that shape.
 */
export function parseSealedRoot(value: unknown, minIterations: number = AUMLOK_SEAL_ITERATIONS): AumlokSealedRoot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join(',') !== 'ivB64,kdfIterations,kdfSaltB64,sealedRootKeyB64') return null
  const { sealedRootKeyB64, kdfSaltB64, kdfIterations, ivB64 } = record
  if (typeof sealedRootKeyB64 !== 'string' || typeof kdfSaltB64 !== 'string' || typeof ivB64 !== 'string') return null
  if (typeof kdfIterations !== 'number' || !Number.isSafeInteger(kdfIterations) || kdfIterations < minIterations
    || kdfIterations > AUMLOK_SEAL_MAX_ITERATIONS) return null
  if (fromBase64url(sealedRootKeyB64)?.length !== 48 || fromBase64url(kdfSaltB64)?.length !== 32) return null
  if (fromBase64url(ivB64)?.length !== 12) return null
  return { sealedRootKeyB64, kdfSaltB64, kdfIterations, ivB64 }
}

/** Why a sealed root did not open into the bound node. */
export type AumlokOpenRefusal = 'aumlok:sealed-root-invalid' | 'aumlok:words-do-not-open' | 'aumlok:root-is-another-node' | 'aumlok:no-node-key-here'
export type AumlokOpened =
  | { readonly ok: true; readonly root: Uint8Array<ArrayBuffer>; readonly node: AumlokNode }
  | { readonly ok: false; readonly code: AumlokOpenRefusal }

/**
 * Open a sealed root with the words, and check it makes the node it was sealed for.
 * @param sealed - the four fields (as read by `parseSealedRoot`).
 * @param canonical - the canonical phrase.
 * @param nodePubkeyHex - the node the host has bound.
 * @returns the root and its node, or why not. The caller zeroes the root when done.
 */
export async function openAumlokRoot(sealed: AumlokSealedRoot, canonical: string, nodePubkeyHex: string): Promise<AumlokOpened> {
  const ciphertext = fromBase64url(sealed.sealedRootKeyB64)
  const salt = fromBase64url(sealed.kdfSaltB64)
  const iv = fromBase64url(sealed.ivB64)
  if (ciphertext?.length !== 48 || salt?.length !== 32 || iv?.length !== 12) return { ok: false, code: 'aumlok:sealed-root-invalid' }
  let root: Uint8Array<ArrayBuffer>
  try {
    const key = await sealKey(canonical, salt, sealed.kdfIterations, 'decrypt')
    root = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(AUMLOK_SEALED_ROOT_AAD + nodePubkeyHex) },
      key, ciphertext))
  } catch {
    return { ok: false, code: 'aumlok:words-do-not-open' }
  }
  let node: AumlokNode | null
  try {
    node = root.length === AUMLOK_ROOT_BYTES ? await aumlokNodeOf(root) : null
  } catch {
    // This browser opened the root but cannot make its Ed25519 key: the root is wiped, and the passkey is not blamed.
    root.fill(0)
    return { ok: false, code: 'aumlok:no-node-key-here' }
  }
  if (node?.nodePubkeyHex !== nodePubkeyHex) {
    root.fill(0)
    return { ok: false, code: 'aumlok:root-is-another-node' }
  }
  return { ok: true, root, node }
}
