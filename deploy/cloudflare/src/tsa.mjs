/**
 * the header check B (2026-11-17, her ask for a second timestamp authority): AN RFC 3161 TIMESTAMP, ASKED FOR AND STORED. Pure: no
 * storage, no network, no clock.
 *
 * The query (RFC 3161 TimeStampReq, DER), 69 bytes for a SHA-256 digest with an 8-byte nonce and certReq TRUE:
 *   30 43 | 02 01 01 (version 1) | 30 31 { 30 0d { 06 09 <OID 2.16.840.1.101.3.4.2.1, SHA-256> 05 00 } 04 20 <digest> }
 *   | 02 08 <nonce> | 01 01 ff (certReq TRUE)
 * The nonce's first byte is kept in 0x01..0x7f, so the INTEGER is positive with no padding byte and its DER form minimal.
 *
 * The reply is only SANITY-READ here, nothing more: an outer SEQUENCE whose length covers it exactly, a PKIStatusInfo
 * SEQUENCE whose status INTEGER is 0 (granted) or 1 (granted with modifications), then (review) the token as the reply's
 * last element: a SEQUENCE whose first element is the OID 1.2.840.113549.1.7.2 (signedData), with the 32 digest bytes and
 * the 8 nonce bytes found inside that token (not merely somewhere in the reply: our own query echoed back holds both).
 * Finding the bytes there is not parsing the token: they are not shown to sit in its TSTInfo fields. The token's signature and its certificate chain are NOT checked at the edge (that needs the
 * authority's certificates and a CMS library); anyone can check a stored token offline with openssl (docs/auma/
 * outside-witness.md). No name here calls a token checked or trusted.
 *
 * Every refusal is an Error whose `code` is one of TSA_CODES.
 */

export const TSA_URL = 'https://freetsa.org/tsr'
export const TSA_AUTHORITY = 'freetsa.org'
export const TSA_QUERY_TYPE = 'application/timestamp-query'
export const TSA_REPLY_TYPE = 'application/timestamp-reply'
export const TSA_REPLY_BYTES = 16 * 1024
export const TSA_CODES = Object.freeze(['TSA_INPUT_INVALID', 'TSA_REPLY_TOO_LARGE', 'TSA_REPLY_MALFORMED', 'TSA_REPLY_STATUS', 'TSA_REPLY_NO_TOKEN', 'TSA_REPLY_NO_DIGEST',
  'TSA_REPLY_NO_NONCE'])

const SHA256_IMPRINT_HEAD = Uint8Array.of(0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20)
/** The DER of OID 1.2.840.113549.1.7.2 (signedData), the ContentInfo type a TimeStampToken has. */
const SIGNED_DATA_OID = Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02)
const refuse = code => { throw Object.assign(new Error(code), { code }) }
const bytes32 = value => value instanceof Uint8Array && value.length === 32
const nonce8 = value => value instanceof Uint8Array && value.length === 8 && value[0] > 0 && value[0] < 0x80

/** Eight random bytes made a valid nonce: the first byte kept in 0x01..0x7f. */
export function tsaNonce(random8) {
  if (!(random8 instanceof Uint8Array) || random8.length !== 8) refuse('TSA_INPUT_INVALID')
  const out = Uint8Array.from(random8)
  out[0] = (out[0] & 0x7f) || 0x01
  return out
}

/** The 69-byte TimeStampReq for a SHA-256 digest, with the nonce and certReq TRUE. */
export function timestampQuery(digest, nonce) {
  if (!bytes32(digest) || !nonce8(nonce)) refuse('TSA_INPUT_INVALID')
  const out = new Uint8Array(69)
  out.set([0x30, 0x43, 0x02, 0x01, 0x01], 0)
  out.set(SHA256_IMPRINT_HEAD, 5)
  out.set(digest, 24)
  out.set([0x02, 0x08], 56)
  out.set(nonce, 58)
  out.set([0x01, 0x01, 0xff], 66)
  return out
}

/** One DER element at `offset`: its tag, where its body starts and ends; refuses anything past `end`. */
function element(bytes, offset, end) {
  if (offset + 2 > end) refuse('TSA_REPLY_MALFORMED')
  const tag = bytes[offset], first = bytes[offset + 1]
  let length, start
  if (first < 0x80) { length = first; start = offset + 2 } else {
    const count = first & 0x7f
    if (count < 1 || count > 3 || offset + 2 + count > end) refuse('TSA_REPLY_MALFORMED')
    length = 0
    for (let index = 0; index < count; index++) length = length * 256 + bytes[offset + 2 + index]
    start = offset + 2 + count
  }
  if (start + length > end) refuse('TSA_REPLY_MALFORMED')
  return { tag, start, end: start + length }
}

const contains = (haystack, needle) => {
  outer: for (let index = 0; index + needle.length <= haystack.length; index++) {
    for (let at = 0; at < needle.length; at++) if (haystack[index + at] !== needle[at]) continue outer
    return true
  }
  return false
}

/**
 * The sanity read of a TimeStampResp (see the top of this file): `{ status }` (0 or 1), or a refusal. A token must follow
 * the status; with `digest` and `nonce` given, that token must also hold both byte runs. Not a check of the token.
 */
export function sanityReadReply(bytes, { digest, nonce } = {}) {
  if (!(bytes instanceof Uint8Array)) refuse('TSA_INPUT_INVALID')
  if (bytes.length > TSA_REPLY_BYTES) refuse('TSA_REPLY_TOO_LARGE')
  const outer = element(bytes, 0, bytes.length)
  if (outer.tag !== 0x30 || outer.end !== bytes.length) refuse('TSA_REPLY_MALFORMED')
  const info = element(bytes, outer.start, outer.end)
  if (info.tag !== 0x30) refuse('TSA_REPLY_MALFORMED')
  const status = element(bytes, info.start, info.end)
  if (status.tag !== 0x02 || status.end - status.start !== 1) refuse('TSA_REPLY_MALFORMED')
  const value = bytes[status.start]
  if (value !== 0 && value !== 1) refuse('TSA_REPLY_STATUS')
  // Review: the token, the reply's last element, a signedData ContentInfo; the digest and nonce looked for inside it only.
  if (info.end === outer.end) refuse('TSA_REPLY_NO_TOKEN')
  const token = element(bytes, info.end, outer.end)
  if (token.end !== outer.end) refuse('TSA_REPLY_MALFORMED')
  const body = bytes.subarray(token.start, token.end)
  if (token.tag !== 0x30 || body.length < SIGNED_DATA_OID.length || SIGNED_DATA_OID.some((byte, index) => body[index] !== byte)) refuse('TSA_REPLY_NO_TOKEN')
  if (digest !== undefined && (!bytes32(digest) || !contains(body, digest))) refuse('TSA_REPLY_NO_DIGEST')
  if (nonce !== undefined && (!(nonce instanceof Uint8Array) || nonce.length !== 8 || !contains(body, nonce))) refuse('TSA_REPLY_NO_NONCE')
  return { status: value }
}
