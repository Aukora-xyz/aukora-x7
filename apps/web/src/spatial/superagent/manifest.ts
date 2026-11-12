/**
 * Local manifest id and proposed signature checks.
 *
 * `loaderManifestPreimage` is the string hashed by `computeBallId` in
 * `packages/experimental/webworker-runtime/src/x6/ball-loader.ts` and by
 * `manifestId` in `server/ball-head.mjs`. `canonManifestPreimage` is the
 * sorted-key string hashed by `manifestIdCanon`. The host accepts either
 * digest as `ballId`. Neither host function verifies an Ed25519 signature.
 *
 * `aukora.x6.manifest-signature.v1` is a proposed envelope. Server publication
 * does not read it. A passing helper does not publish a manifest.
 * `unsigned` is never `verified`. A key inside the manifest is not trusted.
 */
import { canonicalJson } from './contract.ts'
import { PINNED_RECEIPT_SIGNERS } from './authority.ts'

/** Domain already used by `seed-receipts.js` checkpoint signatures. */
export const MANIFEST_DOMAIN = 'aukora.x5.edge-head.v1\0'

/** Proposed envelope name. Not a field of `x6.1-ball/v1`. */
export const MANIFEST_SIGNATURE_SCHEMA = 'aukora.x6.manifest-signature.v1'

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/

/** Which host digest the signature covers. */
export type ManifestIdForm = 'loader' | 'canon'

/** Result of {@link verifyManifestSignature}. `verified` is true only for `verified`. */
export type ManifestVerifyResult =
  | { readonly verified: true; readonly status: 'verified'; readonly idForm: ManifestIdForm }
  | { readonly verified: false; readonly status: 'unsigned' | 'missing' | 'malformed' | 'id-mismatch' | 'untrusted-key' | 'bad-signature' }

/**
 * Parent link used by `createBallHeadStore.publish`.
 * The server returns `REBASE_REQUIRED` for every failure here. These reasons are local names for that rule.
 */
export type ParentLinkResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'malformed' | 'unrelated-parent' | 'non-monotone-epoch' | 'stale-parent' }

interface ManifestRecord {
  readonly version: string
  readonly ballId: string
  readonly parentBallId: string | null
  readonly epoch: number
  readonly entries: Readonly<Record<string, unknown>>
  readonly modules: Readonly<Record<string, unknown>>
  readonly rest: Readonly<Record<string, unknown>>
}

/**
 * Bytes hashed by the loader and by `manifestId`. Nested key order is preserved.
 * @param ball - A manifest record. `ballId` is not part of the preimage.
 * @returns The preimage, or null when the record is not a finite `x6.1-ball/v1` object.
 */
export function loaderManifestPreimage(ball: unknown): string | null {
  const parsed = parseManifest(ball)
  if (parsed === null) return null
  return JSON.stringify({
    version: 'x6.1-ball/v1',
    parentBallId: parsed.parentBallId,
    epoch: parsed.epoch,
    entries: Object.keys(parsed.entries).sort().map(key => parsed.entries[key]),
    modules: Object.keys(parsed.modules).sort().map(key => parsed.modules[key]),
  })
}

/**
 * Bytes hashed by `manifestIdCanon`: sorted-key JSON of every field except `ballId`.
 * @param ball - A manifest record.
 * @returns The preimage, or null when the record is not finite.
 */
export function canonManifestPreimage(ball: unknown): string | null {
  const parsed = parseManifest(ball)
  if (parsed === null) return null
  return canonicalJson(parsed.rest)
}

/**
 * SHA-256 hex of a host preimage.
 * @param ball - A manifest record.
 * @param form - `loader` or `canon`.
 * @returns The digest, or null when the preimage is refused.
 */
export async function manifestDigest(ball: unknown, form: ManifestIdForm): Promise<string | null> {
  const preimage = form === 'loader' ? loaderManifestPreimage(ball) : canonManifestPreimage(ball)
  if (preimage === null) return null
  return sha256Hex(preimage)
}

/**
 * Check a proposed manifest signature against a trusted key list.
 * The default list is {@link PINNED_RECEIPT_SIGNERS}. A key written on the manifest is not added.
 * @param ball - Manifest record whose `ballId` must equal the selected preimage digest.
 * @param signature - Envelope, or null when no envelope was supplied.
 * @param mode - `strict` refuses a missing envelope. `unsigned-optional` records `unsigned` and still returns `verified: false`.
 * @param trustedKeys - Hex public keys accepted for this call.
 * @returns Verification status. `verified` is true only after a trusted Ed25519 check.
 */
export async function verifyManifestSignature(
  ball: unknown,
  signature: unknown,
  mode: 'strict' | 'unsigned-optional',
  trustedKeys: readonly string[] = PINNED_RECEIPT_SIGNERS,
): Promise<ManifestVerifyResult> {
  if (signature === null || signature === undefined) {
    return { verified: false, status: mode === 'strict' ? 'missing' : 'unsigned' }
  }
  const parsed = parseManifest(ball)
  const envelope = parseEnvelope(signature)
  if (parsed === null || envelope === null) return { verified: false, status: 'malformed' }
  if (envelope.ballId !== parsed.ballId) return { verified: false, status: 'id-mismatch' }
  const preimage = envelope.idForm === 'loader' ? loaderManifestPreimage(ball) : canonManifestPreimage(ball)
  if (preimage === null) return { verified: false, status: 'malformed' }
  const digest = await sha256Hex(preimage)
  if (digest !== parsed.ballId) return { verified: false, status: 'id-mismatch' }
  if (!trustedKeys.includes(envelope.publicKeyHex)) return { verified: false, status: 'untrusted-key' }
  const ok = await verifyEd25519(envelope.publicKeyHex, envelope.signatureHex, MANIFEST_DOMAIN + preimage)
  if (!ok) return { verified: false, status: 'bad-signature' }
  return { verified: true, status: 'verified', idForm: envelope.idForm }
}

/**
 * Require `child.parentBallId` to be the selected ball and `child.epoch` to be `selected.epoch + 1`.
 * This matches the compare-and-swap in `server/ball-head.mjs`. It does not sign or publish.
 * @param selected - Current head. An empty head uses `ballId: null` and `epoch: -1`.
 * @param child - Candidate manifest link fields.
 * @returns Ok, or a local reason. The server itself reports `REBASE_REQUIRED`.
 */
export function monotoneParent(
  selected: { readonly ballId: string | null; readonly epoch: number },
  child: { readonly ballId: string; readonly parentBallId: string | null; readonly epoch: number },
): ParentLinkResult {
  if (!Number.isSafeInteger(selected.epoch) || !Number.isSafeInteger(child.epoch)) return { ok: false, reason: 'malformed' }
  if (!HEX_64.test(child.ballId)) return { ok: false, reason: 'malformed' }
  if (child.parentBallId !== null && !HEX_64.test(child.parentBallId)) return { ok: false, reason: 'malformed' }
  if (selected.ballId !== null && !HEX_64.test(selected.ballId)) return { ok: false, reason: 'malformed' }
  if (child.parentBallId !== selected.ballId) return { ok: false, reason: 'unrelated-parent' }
  if (child.epoch <= selected.epoch) return { ok: false, reason: 'non-monotone-epoch' }
  if (child.epoch !== selected.epoch + 1) return { ok: false, reason: 'stale-parent' }
  return { ok: true }
}

function parseManifest(value: unknown): ManifestRecord | null {
  if (!isRecord(value) || !finiteValue(value)) return null
  if (value.version !== 'x6.1-ball/v1' || typeof value.ballId !== 'string' || !HEX_64.test(value.ballId)) return null
  if (value.parentBallId !== null && (typeof value.parentBallId !== 'string' || !HEX_64.test(value.parentBallId))) return null
  if (typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch) || value.epoch < 0) return null
  if (!isRecord(value.entries) || !isRecord(value.modules)) return null
  const rest: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    if (key === 'ballId') continue
    rest[key] = value[key]
  }
  return {
    version: value.version,
    ballId: value.ballId,
    parentBallId: value.parentBallId,
    epoch: value.epoch,
    entries: value.entries,
    modules: value.modules,
    rest,
  }
}

function parseEnvelope(value: unknown): {
  ballId: string
  idForm: ManifestIdForm
  publicKeyHex: string
  signatureHex: string
} | null {
  if (!isRecord(value)) return null
  if (value.schema !== MANIFEST_SIGNATURE_SCHEMA) return null
  if (typeof value.ballId !== 'string' || !HEX_64.test(value.ballId)) return null
  if (value.idForm !== 'loader' && value.idForm !== 'canon') return null
  if (typeof value.publicKeyHex !== 'string' || !HEX_64.test(value.publicKeyHex)) return null
  if (typeof value.signatureHex !== 'string' || !HEX_128.test(value.signatureHex)) return null
  return {
    ballId: value.ballId,
    idForm: value.idForm,
    publicKeyHex: value.publicKeyHex,
    signatureHex: value.signatureHex,
  }
}

function finiteValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => finiteValue(item))
  if (isRecord(value)) return Object.values(value).every(item => item === undefined || finiteValue(item))
  return false
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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
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
