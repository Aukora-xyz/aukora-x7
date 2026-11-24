/**
 * Verify one Bitcoin block header.
 * Pure: no storage, no network, no clock. Plain SHA-256 (WebCrypto) and integer comparison; no other cryptography.
 *
 *  - A header is 80 bytes: version (4) | previous block hash (32) | merkle root (32) | time (4) | bits (4) | nonce (4),
 *    every integer little-endian.
 *  - Its hash is SHA-256 twice over the 80 bytes. Explorers (and Bitcoin Core) SHOW a hash, and the previous hash and the
 *    merkle root in their JSON, with the 32 bytes reversed ("display order"); inside the header they are in header order.
 *    An OpenTimestamps Bitcoin attestation commits to the merkle root in HEADER order (python-opentimestamps notary.py
 *    compares its 32-byte message with hashMerkleRoot byte for byte, no reversal).
 *  - bits is the compact target: exponent byte, 3-byte mantissa (Bitcoin Core's SetCompact). A negative or overflowing
 *    mantissa, or a zero target, is refused (Core treats those as invalid proof of work).
 *
 * What a header that passes these checks does and does not show is said where it is used (witness-do.mjs).
 * Every refusal is an Error whose `code` is one of BITCOIN_HEADER_CODES.
 */

export const BITCOIN_HEADER_BYTES = 80
export const BITCOIN_HEADER_CODES = Object.freeze(['BITCOIN_HEADER_INVALID', 'BITCOIN_BITS_INVALID'])

const HEX_64 = /^[0-9a-f]{64}$/
const refuse = code => { throw Object.assign(new Error(code), { code }) }
const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const reversedHex = bytes => toHex(Uint8Array.from(bytes).reverse())
const u32 = (bytes, offset) => (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0
const headerInput = bytes => {
  if (!(bytes instanceof Uint8Array) || bytes.length !== BITCOIN_HEADER_BYTES) refuse('BITCOIN_HEADER_INVALID')
  return bytes
}

/** The six fields of an 80-byte header; hashes in display order, `merkleRootHeaderOrder` as the header holds it. */
export function parseHeader(bytes) {
  headerInput(bytes)
  return {
    version: u32(bytes, 0),
    prevHash: reversedHex(bytes.subarray(4, 36)),
    merkleRoot: reversedHex(bytes.subarray(36, 68)),
    merkleRootHeaderOrder: toHex(bytes.subarray(36, 68)),
    time: u32(bytes, 68),
    bits: u32(bytes, 72),
    nonce: u32(bytes, 76),
  }
}

/** SHA-256 twice over the 80 bytes, shown reversed as explorers show a block hash. */
export async function headerHash(bytes) {
  headerInput(bytes)
  const once = await crypto.subtle.digest('SHA-256', bytes)
  return reversedHex(new Uint8Array(await crypto.subtle.digest('SHA-256', once)))
}

/** The 256-bit target the compact `bits` stands for, as a BigInt. Refuses a negative, overflowing or zero target. */
export function targetFromBits(bits) {
  if (!Number.isSafeInteger(bits) || bits < 0 || bits > 0xffffffff) refuse('BITCOIN_BITS_INVALID')
  const exponent = bits >>> 24, mantissa = bits & 0x007fffff
  if (bits & 0x00800000) refuse('BITCOIN_BITS_INVALID') // the sign bit: a negative target
  if (mantissa === 0) refuse('BITCOIN_BITS_INVALID') // a zero target: no hash can meet it
  if (exponent > 34 || (mantissa > 0xff && exponent > 33) || (mantissa > 0xffff && exponent > 32)) refuse('BITCOIN_BITS_INVALID') // past 256 bits
  const target = exponent <= 3 ? BigInt(mantissa >>> (8 * (3 - exponent))) : BigInt(mantissa) << BigInt(8 * (exponent - 3))
  if (target === 0n) refuse('BITCOIN_BITS_INVALID')
  return target
}

/**
 * Whether the header's hash, as a 256-bit number, is at most the target its own bits name. Its OWN target only: this does
 * not say the bits are the ones the chain required at that height (that needs the chain of headers before it).
 */
export async function meetsOwnTarget(bytes) {
  const { bits } = parseHeader(bytes)
  let target
  try { target = targetFromBits(bits) } catch (_error) { return false }
  return BigInt('0x' + await headerHash(bytes)) <= target
}

/** How many leading zero bits a hash has, read in display order (the order its value as a number is read in). */
export function leadingZeroBits(hash) {
  if (typeof hash !== 'string' || !HEX_64.test(hash)) refuse('BITCOIN_HEADER_INVALID')
  let bits = 0
  for (const char of hash) {
    const nibble = Number.parseInt(char, 16)
    if (nibble === 0) { bits += 4; continue }
    return bits + Math.clz32(nibble) - 28
  }
  return bits
}

const uint32 = (value, { signed = false } = {}) => {
  if (!Number.isSafeInteger(value) || value > 0xffffffff || value < (signed ? -0x80000000 : 0)) refuse('BITCOIN_HEADER_INVALID')
  return value >>> 0
}
const putU32 = (out, offset, value) => { out[offset] = value & 0xff; out[offset + 1] = value >>> 8 & 0xff; out[offset + 2] = value >>> 16 & 0xff; out[offset + 3] = value >>> 24 & 0xff }
const putDisplayHash = (out, offset, hash) => {
  if (typeof hash !== 'string' || !HEX_64.test(hash)) refuse('BITCOIN_HEADER_INVALID')
  for (let index = 0; index < 32; index++) out[offset + 31 - index] = Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16)
}

/**
 * The 80 header bytes from an explorer's JSON fields: hashes in display order (reversed here into header order),
 * integers as numbers (`version` may be shown signed). Refuses anything else.
 */
export function rebuildHeader({ version, prevHash, merkleRoot, time, bits, nonce } = {}) {
  const out = new Uint8Array(BITCOIN_HEADER_BYTES)
  putU32(out, 0, uint32(version, { signed: true }))
  putDisplayHash(out, 4, prevHash)
  putDisplayHash(out, 36, merkleRoot)
  putU32(out, 68, uint32(time))
  putU32(out, 72, uint32(bits))
  putU32(out, 76, uint32(nonce))
  return out
}
