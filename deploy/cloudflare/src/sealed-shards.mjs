/**
 * SEALED SHARDS (aukora.sealed-shards.v1): lock a file, split it into n pieces, bring it back from any k of them.
 *
 * EXPERIMENTAL and WIRED TO NOTHING: no route, no storage, no tool and no import anywhere (a test holds that). It takes
 * bytes and gives bytes. Nothing here reads her home, a store, a relay or a key of hers.
 *
 * What it does, in order (every part is a standard construction, nothing is invented here):
 *   1. LOCK. A fresh random 256-bit data key encrypts the file with AES-256-GCM. The data key is itself encrypted
 *      (AES-256-GCM) under a key derived with HKDF-SHA-256 from the RECOVERY SECRET, which must be exactly 32 random
 *      bytes. There is no password stretching on purpose: a phrase is refused by its length, never weakly accepted.
 *   2. SPLIT. The ciphertext is cut into k equal data pieces and n - k parity pieces are computed with a systematic
 *      Cauchy Reed-Solomon code over GF(2^8) (polynomial 0x11d). Any k of the n pieces rebuild the ciphertext.
 *   3. NAME. A manifest lists the SHA-256 of every piece and of the ciphertext, the wrapped data key and the numbers.
 *      Its own SHA-256 is the one value an owner signature or an outside witness record would cover.
 *
 * What a piece is: ciphertext (or a mix of ciphertext). Secrecy comes from the lock, survival from the split. A piece
 * that does not match its hash in the manifest is set aside and another is used; fewer than k good pieces is a refusal.
 *
 * What it does NOT do: choose stores, send or fetch anything, sign the manifest, say which manifest is the newest
 * (a rolled-back set of pieces with its own older manifest opens correctly: freshness needs the witness), keep or
 * recover the secret (lose it and the pieces are noise), or hide the file's length.
 *
 * A SECOND WAY TO LOCK (aukora.sealed-shards.v2): the data key is sealed to an owner's X25519 PUBLIC key with HPKE
 * (RFC 9180, base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM), so a machine can lock a copy without
 * holding any secret, and only the holder of the private key can open it. Only the wrap of the data key differs; the
 * body lock, the cut, the piece hashes and the manifest's shape are the v1 ones. The v1 calls never open a v2 manifest
 * and the v2 calls never open a v1 manifest.
 *
 * Only WebCrypto and TextEncoder are used, so the same bytes run in a Worker, a browser and Node.
 * Format and refusals: docs/auma/sealed-shards.md.
 * @module sealed-shards
 */

export const SEALED_SHARDS_SCHEMA = 'aukora.sealed-shards.v1'
export const SEALED_SHARDS_SCHEMA_V2 = 'aukora.sealed-shards.v2'
export const SEALED_SHARDS_LIMITS = Object.freeze({ secretBytes: 32, publicKeyBytes: 32, privateKeyBytes: 32, maxShards: 255, maxPlainBytes: 320 * 1024 * 1024 })
/** Every refusal this module makes. A refusal never carries bytes of the file. */
export const SEALED_SHARDS_CODES = Object.freeze(['SHARDS_INPUT', 'SHARDS_MANIFEST', 'SHARDS_TOO_FEW', 'SHARDS_SECRET', 'SHARDS_CIPHERTEXT'])

const CIPHER = 'AES-256-GCM', KDF = 'HKDF-SHA-256', KDF_V2 = 'HPKE-X25519-HKDF-SHA256', CODE = 'cauchy-rs-gf256-11d'
const TAG_BYTES = 16, IV_BYTES = 12, KEY_BYTES = 32, SALT_BYTES = 32
const encoder = new TextEncoder()
const utf8 = text => encoder.encode(text)
const refuse = (code, more = {}) => ({ ok: false, code, ...more })
const isBytes = value => value instanceof Uint8Array
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// ---------------------------------------------------------------------------------------------------------------------
// GF(2^8), polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d), generator 2.

const EXP = new Uint8Array(510), LOG = new Uint8Array(256)
for (let power = 0, value = 1; power < 255; power++) {
  EXP[power] = value; EXP[power + 255] = value; LOG[value] = power
  value <<= 1
  if (value & 0x100) value ^= 0x11d
}

/** Product of two field elements. */
export function gfMul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]] }
/** Inverse of a non-zero field element. */
export function gfInv(a) {
  if (!Number.isInteger(a) || a < 1 || a > 255) throw new RangeError('GF(256) inverse needs 1..255')
  return EXP[255 - LOG[a]]
}

/**
 * Row `index` of the n-by-k coding matrix: the identity for the k data pieces, then a Cauchy matrix with x = index
 * (k..n-1) and y = column (0..k-1): entry 1 / (index XOR column). Every k rows of it are independent.
 */
export function codeRow(index, k) {
  const row = new Uint8Array(k)
  if (index < k) row[index] = 1
  else for (let column = 0; column < k; column++) row[column] = gfInv(index ^ column)
  return row
}

function timesTable(coefficient) {
  const table = new Uint8Array(256), log = LOG[coefficient]
  for (let value = 1; value < 256; value++) table[value] = EXP[log + LOG[value]]
  return table
}

/** The sum over j of coefficients[j] * inputs[j], byte by byte. */
function combine(coefficients, inputs, length) {
  const out = new Uint8Array(length)
  for (let j = 0; j < coefficients.length; j++) {
    const coefficient = coefficients[j], input = inputs[j]
    if (coefficient === 0) continue
    if (coefficient === 1) { for (let at = 0; at < length; at++) out[at] ^= input[at]; continue }
    const table = timesTable(coefficient)
    for (let at = 0; at < length; at++) out[at] ^= table[input[at]]
  }
  return out
}

/** Inverse of a k-by-k matrix over the field (Gauss-Jordan), or null when it has none. */
function invert(rows, k) {
  const left = rows.map(row => Uint8Array.from(row))
  const right = Array.from({ length: k }, (_, at) => { const row = new Uint8Array(k); row[at] = 1; return row })
  for (let column = 0; column < k; column++) {
    let pivot = column
    while (pivot < k && left[pivot][column] === 0) pivot++
    if (pivot === k) return null
    if (pivot !== column) { [left[pivot], left[column]] = [left[column], left[pivot]]; [right[pivot], right[column]] = [right[column], right[pivot]] }
    const scale = gfInv(left[column][column])
    if (scale !== 1) for (let at = 0; at < k; at++) { left[column][at] = gfMul(left[column][at], scale); right[column][at] = gfMul(right[column][at], scale) }
    for (let row = 0; row < k; row++) {
      const factor = left[row][column]
      if (row === column || factor === 0) continue
      for (let at = 0; at < k; at++) { left[row][at] ^= gfMul(factor, left[column][at]); right[row][at] ^= gfMul(factor, right[column][at]) }
    }
  }
  return right
}

/** All n pieces for k equal-length data pieces: the data pieces themselves, then n - k parity pieces. */
export function encodePieces(data, n) {
  const k = data.length, length = data[0].length
  const pieces = data.slice()
  for (let index = k; index < n; index++) pieces.push(combine(codeRow(index, k), data, length))
  return pieces
}

/** The k data pieces from any k pieces (`indexes[i]` is the place of `pieces[i]` among the n), or null. */
export function rebuildData(indexes, pieces, k) {
  if (indexes.every((index, at) => index === at)) return pieces.slice()
  const inverse = invert(indexes.map(index => codeRow(index, k)), k)
  if (inverse === null) return null
  const length = pieces[0].length
  return inverse.map(row => combine(row, pieces, length))
}

// ---------------------------------------------------------------------------------------------------------------------
// Bytes, hashes, keys.

const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'))
const toHex = bytes => { let out = ''; for (const value of bytes) out += HEX[value]; return out }
const isHex = (value, bytes) => typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]*$/.test(value)
function fromHex(text) {
  const out = new Uint8Array(text.length / 2)
  for (let at = 0; at < out.length; at++) out[at] = Number.parseInt(text.slice(at * 2, at * 2 + 2), 16)
  return out
}
const sha256Hex = async bytes => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))

/** What both locks are bound to: the format, which lock it is, and the numbers that shape the pieces. */
const bound = (schema, part, k, n, plainBytes) => utf8(JSON.stringify([schema, part, k, n, plainBytes]))

async function wrapKey(secret, salt) {
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(`${SEALED_SHARDS_SCHEMA} key-wrap`) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const gcm = (iv, additionalData) => ({ name: 'AES-GCM', iv, additionalData, tagLength: TAG_BYTES * 8 })
const pieceBytes = (plainBytes, k) => Math.max(1, Math.ceil((plainBytes + TAG_BYTES) / k))
const validShape = (k, n) => Number.isSafeInteger(k) && Number.isSafeInteger(n) && k >= 1 && k <= n && n <= SEALED_SHARDS_LIMITS.maxShards
const validLength = bytes => Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= SEALED_SHARDS_LIMITS.maxPlainBytes

/**
 * The two formats differ only in the kdf name and the wrap: v1 wraps under a secret (salt, nonce, wrapped key), v2
 * seals to a public key (`to` = SHA-256 of the recipient's raw public key, `enc` = the encapsulated key, `key` = the
 * sealed data key). Every key's hex length, in bytes.
 */
const FORMATS = Object.freeze({
  [SEALED_SHARDS_SCHEMA]: { kdf: KDF, wrap: [['salt', SALT_BYTES], ['iv', IV_BYTES], ['key', KEY_BYTES + TAG_BYTES]] },
  [SEALED_SHARDS_SCHEMA_V2]: { kdf: KDF_V2, wrap: [['to', 32], ['enc', 32], ['key', KEY_BYTES + TAG_BYTES]] },
})

/** The manifest's one byte string: the keys in this order, nothing else. Its SHA-256 names the whole set. */
function canonical(manifest) {
  return JSON.stringify({
    schema: manifest.schema, cipher: manifest.cipher, kdf: manifest.kdf, code: manifest.code,
    k: manifest.k, n: manifest.n, plainBytes: manifest.plainBytes, shardBytes: manifest.shardBytes,
    wrap: Object.fromEntries(FORMATS[manifest.schema].wrap.map(([key]) => [key, manifest.wrap[key]])),
    body: { iv: manifest.body.iv, sha256: manifest.body.sha256 },
    shards: manifest.shards.slice(),
  })
}

const sameKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

/**
 * A manifest as an object or as its JSON text: the canonical text, or null when it is not exactly one of the formats
 * named in `schemas`. The v1 calls pass only v1 and the v2 calls only v2, so neither ever reads the other's manifest.
 */
function readManifest(input, schemas) {
  let manifest = input
  if (typeof input === 'string') { try { manifest = JSON.parse(input) } catch { return null } }
  if (!sameKeys(manifest, ['schema', 'cipher', 'kdf', 'code', 'k', 'n', 'plainBytes', 'shardBytes', 'wrap', 'body', 'shards'])) return null
  if (!schemas.includes(manifest.schema)) return null
  const format = FORMATS[manifest.schema]
  if (manifest.cipher !== CIPHER || manifest.kdf !== format.kdf || manifest.code !== CODE) return null
  if (!validShape(manifest.k, manifest.n) || !validLength(manifest.plainBytes)) return null
  if (manifest.shardBytes !== pieceBytes(manifest.plainBytes, manifest.k)) return null
  if (!sameKeys(manifest.wrap, format.wrap.map(([key]) => key)) || !sameKeys(manifest.body, ['iv', 'sha256'])) return null
  if (!format.wrap.every(([key, bytes]) => isHex(manifest.wrap[key], bytes))) return null
  if (!isHex(manifest.body.iv, IV_BYTES) || !isHex(manifest.body.sha256, 32)) return null
  if (!Array.isArray(manifest.shards) || manifest.shards.length !== manifest.n || !manifest.shards.every(hash => isHex(hash, 32))) return null
  const json = canonical(manifest)
  if (typeof input === 'string' && input !== json) return null
  return { manifest: JSON.parse(json), json }
}

// ---------------------------------------------------------------------------------------------------------------------
// HPKE, RFC 9180, base mode only, single-shot. KEM DHKEM(X25519, HKDF-SHA256) 0x0020, KDF HKDF-SHA256 0x0001. The AEAD
// is a parameter so the RFC's own Appendix A.1 vectors (AES-128-GCM, 0x0001) run through this same code; the v2 format
// uses AES-256-GCM (0x0002) only. Section numbers below are the RFC's.

const HPKE_KEM_ID = 0x0020, HPKE_KDF_ID = 0x0001, HPKE_NH = 32, HPKE_NN = 12, HPKE_NSECRET = 32, HPKE_NPK = 32, HPKE_NSK = 32
const HPKE_AEADS = Object.freeze({ 0x0001: 16, 0x0002: 32 }) // aead_id: Nk
const HPKE_V2_AEAD = 0x0002
const HPKE_V2_INFO = utf8(`${SEALED_SHARDS_SCHEMA_V2} key-wrap`)
const X25519_BASE = Uint8Array.from({ length: 32 }, (_, at) => (at === 0 ? 9 : 0))
// PKCS #8 for an X25519 private key: SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.110 }, OCTET STRING { OCTET STRING (32) } }.
// WebCrypto takes no raw X25519 private key, so the 32 bytes are wrapped in this fixed prefix (RFC 8410 section 7).
const X25519_PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20])

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}
/** I2OSP: `value` as `width` big-endian bytes. */
function i2osp(value, width) {
  const out = new Uint8Array(width)
  for (let at = width - 1, rest = value; at >= 0; at--, rest = Math.floor(rest / 256)) out[at] = rest % 256
  return out
}
const allZero = bytes => bytes.every(value => value === 0)

async function hmacSha256(key, data) {
  const handle = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', handle, data))
}
/**
 * HKDF-Extract (RFC 5869). An empty salt means HashLen zero bytes (RFC 5869 section 2.2); HMAC pads a short key with
 * zeros, so the two are the same key, and WebCrypto may refuse an empty HMAC key.
 */
const extract = (salt, ikm) => hmacSha256(salt.length === 0 ? new Uint8Array(HPKE_NH) : salt, ikm)
/** HKDF-Expand (RFC 5869): T(i) = HMAC(prk, T(i-1) || info || i), the first L bytes. */
async function expand(prk, info, length) {
  if (!Number.isSafeInteger(length) || length < 0 || length > 255 * HPKE_NH) throw new RangeError('HKDF-Expand length')
  const out = new Uint8Array(length)
  let previous = new Uint8Array(0)
  for (let block = 1, at = 0; at < length; block++) {
    previous = await hmacSha256(prk, concat(previous, info, Uint8Array.of(block)))
    out.set(previous.subarray(0, Math.min(HPKE_NH, length - at)), at)
    at += HPKE_NH
  }
  return out
}
const HPKE_V1_LABEL = utf8('HPKE-v1')
/** Section 4: LabeledExtract(salt, label, ikm) = Extract(salt, "HPKE-v1" || suite_id || label || ikm). */
const labeledExtract = (suiteId, salt, label, ikm) => extract(salt, concat(HPKE_V1_LABEL, suiteId, utf8(label), ikm))
/** Section 4: LabeledExpand(prk, label, info, L) = Expand(prk, I2OSP(L, 2) || "HPKE-v1" || suite_id || label || info, L). */
const labeledExpand = (suiteId, prk, label, info, length) => expand(prk, concat(i2osp(length, 2), HPKE_V1_LABEL, suiteId, utf8(label), info), length)
/** Section 4.1: the KEM's suite_id = "KEM" || I2OSP(kem_id, 2). */
const KEM_SUITE_ID = concat(utf8('KEM'), i2osp(HPKE_KEM_ID, 2))
/** Section 5.1: the HPKE suite_id = "HPKE" || I2OSP(kem_id, 2) || I2OSP(kdf_id, 2) || I2OSP(aead_id, 2). */
const hpkeSuiteId = aeadId => concat(utf8('HPKE'), i2osp(HPKE_KEM_ID, 2), i2osp(HPKE_KDF_ID, 2), i2osp(aeadId, 2))
const EMPTY = new Uint8Array(0)

/** X25519(scalar, u) through WebCrypto, or null when WebCrypto refuses or the answer is all zero (section 7.1.4). */
async function x25519(privateKey, publicKey) {
  try {
    const own = await crypto.subtle.importKey('pkcs8', concat(X25519_PKCS8_PREFIX, privateKey), { name: 'X25519' }, false, ['deriveBits'])
    const other = await crypto.subtle.importKey('raw', publicKey, { name: 'X25519' }, false, [])
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: other }, own, 256))
    return allZero(shared) ? null : shared
  } catch { return null }
}
/** The raw public key of a raw 32-byte private key: X25519(sk, 9). */
async function publicKeyOf(privateKey) {
  const publicKey = await x25519(privateKey, X25519_BASE)
  if (publicKey === null) throw new Error('X25519 public key')
  return publicKey
}
/** Section 7.1.3: DeriveKeyPair(ikm) for X25519: sk = LabeledExpand(LabeledExtract("", "dkp_prk", ikm), "sk", "", 32). */
async function deriveKeyPair(ikm) {
  const dkpPrk = await labeledExtract(KEM_SUITE_ID, EMPTY, 'dkp_prk', ikm)
  const privateKey = await labeledExpand(KEM_SUITE_ID, dkpPrk, 'sk', EMPTY, HPKE_NSK)
  return { privateKey, publicKey: await publicKeyOf(privateKey) }
}
/** Section 4.1: ExtractAndExpand(dh, kem_context). */
async function extractAndExpand(dh, kemContext) {
  const eaePrk = await labeledExtract(KEM_SUITE_ID, EMPTY, 'eae_prk', dh)
  return labeledExpand(KEM_SUITE_ID, eaePrk, 'shared_secret', kemContext, HPKE_NSECRET)
}
/**
 * Section 4.1 Encap(pkR), with the ephemeral pair from DeriveKeyPair(ikmE) (as the RFC's vectors do). Answers
 * `{ enc, sharedSecret }`, or null when the Diffie-Hellman value is all zero (a low-order public key).
 */
async function encap(publicKey, ikmE) {
  const ephemeral = await deriveKeyPair(ikmE)
  const dh = await x25519(ephemeral.privateKey, publicKey)
  ephemeral.privateKey.fill(0)
  if (dh === null) return null
  const enc = ephemeral.publicKey
  return { enc, sharedSecret: await extractAndExpand(dh, concat(enc, publicKey)) }
}
/** Section 4.1 Decap(enc, skR): the shared secret, or null when the Diffie-Hellman value is all zero. */
async function decap(enc, privateKey) {
  const dh = await x25519(privateKey, enc)
  if (dh === null) return null
  return extractAndExpand(dh, concat(enc, await publicKeyOf(privateKey)))
}
/** Section 5.1 KeySchedule, base mode (mode 0x00, psk and psk_id empty): `{ key, baseNonce }`. */
async function keySchedule(aeadId, sharedSecret, info) {
  const nk = HPKE_AEADS[aeadId]
  if (nk === undefined) throw new RangeError('HPKE aead_id')
  const suiteId = hpkeSuiteId(aeadId)
  const pskIdHash = await labeledExtract(suiteId, EMPTY, 'psk_id_hash', EMPTY)
  const infoHash = await labeledExtract(suiteId, EMPTY, 'info_hash', info)
  const context = concat(Uint8Array.of(0x00), pskIdHash, infoHash)
  const secret = await labeledExtract(suiteId, sharedSecret, 'secret', EMPTY)
  return { key: await labeledExpand(suiteId, secret, 'key', context, nk), baseNonce: await labeledExpand(suiteId, secret, 'base_nonce', context, HPKE_NN) }
}
/** Section 5.2: the nonce for sequence number `sequence` is base_nonce XOR I2OSP(sequence, Nn). Single-shot uses 0. */
const nonceFor = (baseNonce, sequence) => { const seq = i2osp(sequence, HPKE_NN); return baseNonce.map((value, at) => value ^ seq[at]) }
async function aeadSeal(key, nonce, aad, plain) {
  const handle = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  return new Uint8Array(await crypto.subtle.encrypt(gcm(nonce, aad), handle, plain))
}
/** Section 6.1 single-shot Seal(pkR, info, aad, pt) in base mode: `{ enc, ct }`, or null for a low-order public key. */
async function hpkeSeal(aeadId, publicKey, info, aad, plain, ikmE) {
  const encapsulated = await encap(publicKey, ikmE)
  if (encapsulated === null) return null
  const { key, baseNonce } = await keySchedule(aeadId, encapsulated.sharedSecret, info)
  return { enc: encapsulated.enc, ct: await aeadSeal(key, nonceFor(baseNonce, 0), aad, plain) }
}
/** Section 6.1 single-shot Open(enc, skR, info, aad, ct) in base mode: the plaintext, or null when it does not open. */
async function hpkeOpen(aeadId, privateKey, enc, info, aad, ct) {
  const sharedSecret = await decap(enc, privateKey)
  if (sharedSecret === null) return null
  const { key, baseNonce } = await keySchedule(aeadId, sharedSecret, info)
  try {
    const handle = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
    return new Uint8Array(await crypto.subtle.decrypt(gcm(nonceFor(baseNonce, 0), aad), handle, ct))
  } catch { return null }
}

/**
 * The HPKE pieces, for the RFC 9180 vector tests and a second implementation's cross-checks only: nothing else is
 * meant to call these. `aeadId` is 0x0001 (AES-128-GCM, the RFC's A.1 suite) or 0x0002 (AES-256-GCM, the v2 format).
 */
export const HPKE_BASE = Object.freeze({
  KEM_ID: HPKE_KEM_ID, KDF_ID: HPKE_KDF_ID, AES_128_GCM: 0x0001, AES_256_GCM: 0x0002, V2_INFO: HPKE_V2_INFO,
  deriveKeyPair, publicKeyOf, encap, decap, keySchedule, nonceFor, seal: hpkeSeal, open: hpkeOpen,
})

// ---------------------------------------------------------------------------------------------------------------------
// The calls. v1: sealToShards / openFromShards (a 32-byte secret). v2: sealToShardsFor / openFromShardsWith (an X25519
// key pair). checkShard reads either format.

/** Draw `lengths` from `random` in order, each copied; null when the source misbehaves. */
function drawAll(random, lengths) {
  const draws = []
  for (const length of lengths) {
    const drawn = random(length)
    if (!isBytes(drawn) || drawn.length !== length) return null
    draws.push(Uint8Array.from(drawn))
  }
  return draws
}

/** The body lock and the cut, the same for both formats except the schema name the body is bound to. */
async function lockAndCut(schema, plain, k, n, dataKey, bodyIv) {
  const bodyKey = await crypto.subtle.importKey('raw', dataKey, 'AES-GCM', false, ['encrypt'])
  dataKey.fill(0)
  const cipher = new Uint8Array(await crypto.subtle.encrypt(gcm(bodyIv, bound(schema, 'body', k, n, plain.length)), bodyKey, plain))
  const shardBytes = pieceBytes(plain.length, k)
  const padded = new Uint8Array(k * shardBytes)
  padded.set(cipher)
  const shards = encodePieces(Array.from({ length: k }, (_, at) => padded.slice(at * shardBytes, (at + 1) * shardBytes)), n)
  return { cipherSha256: await sha256Hex(cipher), shardBytes, shards }
}

async function finish(schema, kdf, k, n, plain, shardBytes, wrap, bodyIv, cipherSha256, shards) {
  const manifest = {
    schema, cipher: CIPHER, kdf, code: CODE, k, n, plainBytes: plain.length, shardBytes,
    wrap, body: { iv: toHex(bodyIv), sha256: cipherSha256 }, shards: await Promise.all(shards.map(sha256Hex)),
  }
  const manifestJson = canonical(manifest)
  return { ok: true, manifest, manifestJson, manifestSha256: await sha256Hex(utf8(manifestJson)), shards }
}

/**
 * Lock `plain` under `secret` and split it into `n` pieces, any `k` of which bring it back.
 * `random(length)` must return `length` fresh random bytes; it is asked, in this order, for the wrap salt (32), the
 * wrap nonce (12), the data key (32) and the body nonce (12). Only tests pass their own.
 * Answer: `{ ok: true, manifest, manifestJson, manifestSha256, shards }` (shards[i] is piece i), or a refusal.
 */
export async function sealToShards(plain, options = {}) {
  const { secret, k, n, random = length => crypto.getRandomValues(new Uint8Array(length)) } = isObject(options) ? options : {}
  if (!isBytes(plain) || !validLength(plain.length)) return refuse('SHARDS_INPUT', { why: 'plain' })
  if (!isBytes(secret) || secret.length !== SEALED_SHARDS_LIMITS.secretBytes) return refuse('SHARDS_INPUT', { why: 'secret' })
  if (!validShape(k, n)) return refuse('SHARDS_INPUT', { why: 'shape' })
  if (typeof random !== 'function') return refuse('SHARDS_INPUT', { why: 'random' })
  const draws = drawAll(random, [SALT_BYTES, IV_BYTES, KEY_BYTES, IV_BYTES])
  if (draws === null) return refuse('SHARDS_INPUT', { why: 'random' })
  const [salt, wrapIv, dataKey, bodyIv] = draws
  const wrapped = new Uint8Array(await crypto.subtle.encrypt(gcm(wrapIv, bound(SEALED_SHARDS_SCHEMA, 'wrap', k, n, plain.length)), await wrapKey(secret, salt), dataKey))
  const { cipherSha256, shardBytes, shards } = await lockAndCut(SEALED_SHARDS_SCHEMA, plain, k, n, dataKey, bodyIv)
  return finish(SEALED_SHARDS_SCHEMA, KDF, k, n, plain, shardBytes, { salt: toHex(salt), iv: toHex(wrapIv), key: toHex(wrapped) }, bodyIv, cipherSha256, shards)
}

/**
 * True when the 32 raw bytes are the canonical X25519 encoding of u: the top bit is clear and u < p = 2^255 - 19.
 * X25519 masks the top bit and reduces u mod p, so other encodings name the same point; but HPKE binds pkR as the
 * bytes given, while the owner recomputes it canonically, so a set sealed to them could never be opened.
 */
function canonicalX25519(bytes) {
  if ((bytes[31] & 0x80) !== 0) return false
  if (bytes[31] !== 0x7f || bytes[0] < 0xed) return true
  for (let i = 1; i < 31; i++) if (bytes[i] !== 0xff) return true
  return false
}

/**
 * Lock `plain` to the owner's own X25519 `publicKey` (raw, 32 bytes) and split it into `n` pieces, any `k` of which bring
 * it back with the matching private key. No secret is needed to lock, and none is kept.
 * `random(length)` is asked, in this order, for the ephemeral key seed (32, HPKE's ikmE), the data key (32) and the
 * body nonce (12). Only tests pass their own.
 * The data key is sealed with HPKE (RFC 9180, base mode, single-shot), suite 0x0020 / 0x0001 / 0x0002, info
 * "aukora.sealed-shards.v2 key-wrap", associated data ["aukora.sealed-shards.v2","wrap",k,n,plainBytes].
 * A public key that is not 32 bytes, not the canonical encoding (top bit set, or u >= 2^255 - 19), or a low-order one
 * (the Diffie-Hellman value comes out all zero), is SHARDS_INPUT.
 */
export async function sealToShardsFor(plain, options = {}) {
  const { publicKey, k, n, random = length => crypto.getRandomValues(new Uint8Array(length)) } = isObject(options) ? options : {}
  if (!isBytes(plain) || !validLength(plain.length)) return refuse('SHARDS_INPUT', { why: 'plain' })
  if (!isBytes(publicKey) || publicKey.length !== SEALED_SHARDS_LIMITS.publicKeyBytes || !canonicalX25519(publicKey)) return refuse('SHARDS_INPUT', { why: 'publicKey' })
  if (!validShape(k, n)) return refuse('SHARDS_INPUT', { why: 'shape' })
  if (typeof random !== 'function') return refuse('SHARDS_INPUT', { why: 'random' })
  const draws = drawAll(random, [HPKE_NSK, KEY_BYTES, IV_BYTES])
  if (draws === null) return refuse('SHARDS_INPUT', { why: 'random' })
  const [ikmE, dataKey, bodyIv] = draws
  const recipient = Uint8Array.from(publicKey)
  const sealed = await hpkeSeal(HPKE_V2_AEAD, recipient, HPKE_V2_INFO, bound(SEALED_SHARDS_SCHEMA_V2, 'wrap', k, n, plain.length), dataKey, ikmE)
  ikmE.fill(0)
  if (sealed === null) { dataKey.fill(0); return refuse('SHARDS_INPUT', { why: 'publicKey' }) }
  const { cipherSha256, shardBytes, shards } = await lockAndCut(SEALED_SHARDS_SCHEMA_V2, plain, k, n, dataKey, bodyIv)
  const wrap = { to: await sha256Hex(recipient), enc: toHex(sealed.enc), key: toHex(sealed.ct) }
  return finish(SEALED_SHARDS_SCHEMA_V2, KDF_V2, k, n, plain, shardBytes, wrap, bodyIv, cipherSha256, shards)
}

/** Why one offered piece cannot be used, or null when it is the piece the manifest names at that place. */
async function pieceFault(manifest, piece, seen) {
  if (!isObject(piece) || !Number.isSafeInteger(piece.index) || piece.index < 0 || piece.index >= manifest.n) return 'index'
  if (seen.has(piece.index)) return 'duplicate'
  if (!isBytes(piece.bytes) || piece.bytes.length !== manifest.shardBytes) return 'length'
  return await sha256Hex(piece.bytes) === manifest.shards[piece.index] ? null : 'hash'
}

/**
 * Is `bytes` the piece the manifest (v1 or v2) names at `index`? For a store's own check, or a scheduled re-check.
 * No secret or key needed.
 */
export async function checkShard(manifest, index, bytes) {
  const read = readManifest(manifest, [SEALED_SHARDS_SCHEMA, SEALED_SHARDS_SCHEMA_V2])
  if (read === null) return refuse('SHARDS_MANIFEST')
  const fault = await pieceFault(read.manifest, { index, bytes }, new Set())
  return fault === null ? { ok: true } : { ok: false, code: 'SHARDS_INPUT', why: fault }
}

/** The good pieces, the rebuild and the ciphertext's hash, the same for both formats: `{ cipher, used, rejected }` or a refusal. */
async function gather(manifest, manifestSha256, shards) {
  const { k, plainBytes, shardBytes } = manifest
  const good = new Map(), rejected = []
  for (const piece of shards) {
    const fault = await pieceFault(manifest, piece, good)
    if (fault === null) good.set(piece.index, piece.bytes)
    else rejected.push({ index: isObject(piece) && Number.isSafeInteger(piece.index) ? piece.index : null, why: fault })
  }
  if (good.size < k) return refuse('SHARDS_TOO_FEW', { manifestSha256, need: k, good: good.size, rejected })
  const used = [...good.keys()].sort((a, b) => a - b).slice(0, k)
  const data = rebuildData(used, used.map(index => good.get(index)), k)
  if (data === null) return refuse('SHARDS_CIPHERTEXT', { manifestSha256, why: 'rebuild' })
  const padded = new Uint8Array(k * shardBytes)
  data.forEach((piece, at) => padded.set(piece, at * shardBytes))
  const cipher = padded.subarray(0, plainBytes + TAG_BYTES)
  if (await sha256Hex(cipher) !== manifest.body.sha256) return refuse('SHARDS_CIPHERTEXT', { manifestSha256, why: 'hash' })
  return { ok: true, cipher, used, rejected }
}

/** The body lock opened with the data key, which is wiped after. */
async function openBody(schema, manifest, manifestSha256, dataKey, gathered) {
  const { k, n, plainBytes } = manifest
  try {
    const bodyKey = await crypto.subtle.importKey('raw', dataKey, 'AES-GCM', false, ['decrypt'])
    const plain = new Uint8Array(await crypto.subtle.decrypt(gcm(fromHex(manifest.body.iv), bound(schema, 'body', k, n, plainBytes)), bodyKey, gathered.cipher))
    return { ok: true, plain, manifestSha256, used: gathered.used, rejected: gathered.rejected }
  } catch { return refuse('SHARDS_CIPHERTEXT', { manifestSha256, why: 'lock' }) } finally { dataKey.fill(0) }
}

/**
 * Bring the file back. `manifest` is the object or its exact JSON text; `shards` is a list of `{ index, bytes }` in
 * any order, with as many as were found. Pieces that are not the ones the manifest names are set aside and listed.
 * Answer: `{ ok: true, plain, manifestSha256, used, rejected }`, or a refusal:
 *   SHARDS_MANIFEST    not this format, or not the canonical text
 *   SHARDS_TOO_FEW     fewer than k good pieces (`need`, `good`, `rejected` say how many and why)
 *   SHARDS_SECRET      the secret does not open this manifest's data key (wrong secret, or the wrap was changed)
 *   SHARDS_CIPHERTEXT  the pieces are the named ones but the locked file does not check out (a changed manifest)
 * The caller compares `manifestSha256` with the value it trusts (a signed or witnessed one) to know WHICH set this is.
 */
export async function openFromShards(input = {}) {
  const { manifest: given, shards, secret } = isObject(input) ? input : {}
  if (!isBytes(secret) || secret.length !== SEALED_SHARDS_LIMITS.secretBytes) return refuse('SHARDS_INPUT', { why: 'secret' })
  if (!Array.isArray(shards)) return refuse('SHARDS_INPUT', { why: 'shards' })
  const read = readManifest(given, [SEALED_SHARDS_SCHEMA])
  if (read === null) return refuse('SHARDS_MANIFEST')
  const { manifest, json } = read, { k, n, plainBytes } = manifest
  const manifestSha256 = await sha256Hex(utf8(json))
  const gathered = await gather(manifest, manifestSha256, shards)
  if (!gathered.ok) return gathered
  let dataKey
  try {
    dataKey = new Uint8Array(await crypto.subtle.decrypt(gcm(fromHex(manifest.wrap.iv), bound(SEALED_SHARDS_SCHEMA, 'wrap', k, n, plainBytes)),
      await wrapKey(secret, fromHex(manifest.wrap.salt)), fromHex(manifest.wrap.key)))
  } catch { return refuse('SHARDS_SECRET', { manifestSha256 }) }
  return openBody(SEALED_SHARDS_SCHEMA, manifest, manifestSha256, dataKey, gathered)
}

/**
 * Bring back a file locked with `sealToShardsFor`, with the owner's own X25519 `privateKey` (raw, 32 bytes). The same
 * pieces, order of checks and answers as `openFromShards`; SHARDS_SECRET here means the private key does not open the
 * wrap: its public key is not the one `wrap.to` names, or the HPKE open fails (a wrong key, a changed `enc`, `key`,
 * k, n or plainBytes, or an `enc` whose Diffie-Hellman value is all zero).
 */
export async function openFromShardsWith(input = {}) {
  const { manifest: given, shards, privateKey } = isObject(input) ? input : {}
  if (!isBytes(privateKey) || privateKey.length !== SEALED_SHARDS_LIMITS.privateKeyBytes) return refuse('SHARDS_INPUT', { why: 'privateKey' })
  if (!Array.isArray(shards)) return refuse('SHARDS_INPUT', { why: 'shards' })
  const read = readManifest(given, [SEALED_SHARDS_SCHEMA_V2])
  if (read === null) return refuse('SHARDS_MANIFEST')
  const { manifest, json } = read, { k, n, plainBytes } = manifest
  const manifestSha256 = await sha256Hex(utf8(json))
  const gathered = await gather(manifest, manifestSha256, shards)
  if (!gathered.ok) return gathered
  const own = Uint8Array.from(privateKey)
  let dataKey = null
  try {
    if (await sha256Hex(await publicKeyOf(own)) === manifest.wrap.to) {
      dataKey = await hpkeOpen(HPKE_V2_AEAD, own, fromHex(manifest.wrap.enc), HPKE_V2_INFO,
        bound(SEALED_SHARDS_SCHEMA_V2, 'wrap', k, n, plainBytes), fromHex(manifest.wrap.key))
    }
  } catch { dataKey = null } finally { own.fill(0) }
  if (dataKey === null || dataKey.length !== KEY_BYTES) return refuse('SHARDS_SECRET', { manifestSha256 })
  return openBody(SEALED_SHARDS_SCHEMA_V2, manifest, manifestSha256, dataKey, gathered)
}
