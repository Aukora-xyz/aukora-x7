/**
 * Receipt leaf check matching `mirror/home/auma/seed/organs/seed-receipts.js`.
 *
 * The organ preimage is every stored field except `leafHash`, prefixed with
 * the byte `0x00`, then SHA-256. `schema` must be `aukora.receipt.v3`.
 * `seed-receipts.js` has no `v` field; a row that carries `v` and omits
 * `schema` is insufficient. `intact: true` is not read.
 */
import { canonicalJson } from './contract.ts'

const HEX_64 = /^[0-9a-f]{64}$/
const SCHEMA = 'aukora.receipt.v3'
const MAX_CANONICAL_BYTES = 262_144

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** One receipt whose leaf matched the organ preimage. */
export interface VerifiedReceipt {
  readonly seq: number
  readonly kind: string
  readonly at: string
  readonly prevHash: string
  readonly leafHash: string
  readonly data: Readonly<Record<string, unknown>>
}

/** Leaf verdict. `insufficient` means the organ source fields are absent. */
export interface ReceiptLeafVerdict {
  readonly status: 'verified' | 'mismatch' | 'malformed' | 'insufficient'
  readonly recomputed: string | null
  readonly claimed: string | null
}

/** Chain verdict. `verified` means every leaf was recomputed and the links hold. */
export interface ReceiptChainVerdict {
  readonly status: 'verified' | 'malformed' | 'insufficient'
  readonly leafRecomputed: boolean
  readonly receipts: readonly VerifiedReceipt[]
}

/**
 * SHA-256 of raw bytes, lowercase hex.
 * @param bytes - Message.
 * @returns Digest, or null when `bytes` is longer than the receipt cap.
 */
export function sha256Hex(bytes: Uint8Array): string | null {
  const digest = sha256Bytes(bytes)
  if (digest === null) return null
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * SHA-256 bytes. Shared with the Schnorr tagged hashes.
 * @param bytes - Message.
 * @returns Digest, or null when `bytes` exceeds the cap.
 */
export function sha256Bytes(bytes: Uint8Array): Uint8Array | null {
  return sha256(bytes)
}

/**
 * Recompute one receipt leaf. The caller flag `intact` is ignored.
 * @param record - A JSON object, usually one `receipts.v3.jsonl` row.
 * @returns `verified` only when the recomputed digest equals `leafHash` or `hash`.
 */
export function verifyReceiptLeaf(record: unknown): ReceiptLeafVerdict {
  const parsed = parseReceipt(record)
  if (parsed.kind !== 'ready') {
    return { status: parsed.kind, recomputed: null, claimed: parsed.claimed }
  }
  const recomputed = leafHex(parsed.payload)
  if (recomputed === null) return { status: 'malformed', recomputed: null, claimed: parsed.claimed }
  if (recomputed !== parsed.claimed) return { status: 'mismatch', recomputed, claimed: parsed.claimed }
  return { status: 'verified', recomputed, claimed: parsed.claimed }
}

/**
 * Recompute every leaf and require seq 1..n with consecutive `prevHash` links.
 * @param records - Receipt rows. Order in the array does not matter; seq does.
 * @returns `insufficient` when any row lacks organ source fields. An empty list is verified.
 */
export function verifyReceiptChain(records: readonly unknown[]): ReceiptChainVerdict {
  if (records.length === 0) return { status: 'verified', leafRecomputed: true, receipts: [] }
  const rows: VerifiedReceipt[] = []
  for (const record of records) {
    const parsed = parseReceipt(record)
    if (parsed.kind === 'insufficient') return { status: 'insufficient', leafRecomputed: false, receipts: [] }
    if (parsed.kind !== 'ready') return { status: 'malformed', leafRecomputed: false, receipts: [] }
    const recomputed = leafHex(parsed.payload)
    if (recomputed === null || recomputed !== parsed.claimed) {
      return { status: 'malformed', leafRecomputed: false, receipts: [] }
    }
    rows.push({
      seq: parsed.seq,
      kind: parsed.kindName,
      at: parsed.at,
      prevHash: parsed.prevHash,
      leafHash: recomputed,
      data: parsed.data,
    })
  }
  rows.sort((left, right) => left.seq - right.seq)
  const seen = new Set<number>()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row === undefined || seen.has(row.seq) || row.seq !== index + 1) {
      return { status: 'malformed', leafRecomputed: false, receipts: [] }
    }
    seen.add(row.seq)
    if (index === 0) {
      if (row.prevHash !== '0'.repeat(64)) return { status: 'malformed', leafRecomputed: false, receipts: [] }
      continue
    }
    const previous = rows[index - 1]
    if (previous === undefined || row.prevHash !== previous.leafHash) {
      return { status: 'malformed', leafRecomputed: false, receipts: [] }
    }
  }
  return { status: 'verified', leafRecomputed: true, receipts: rows }
}

function leafHex(payload: Readonly<Record<string, unknown>>): string | null {
  const text = canonicalOrNull(payload)
  if (text === null) return null
  const body = new TextEncoder().encode(text)
  if (body.length > MAX_CANONICAL_BYTES) return null
  const prefixed = new Uint8Array(body.length + 1)
  prefixed[0] = 0x00
  prefixed.set(body, 1)
  return sha256Hex(prefixed)
}

function canonicalOrNull(value: unknown): string | null {
  try {
    const text = canonicalJson(value)
    return typeof text === 'string' ? text : null
  } catch (error) {
    void error
    return null
  }
}

type Parsed =
  | { kind: 'insufficient' | 'malformed'; claimed: string | null }
  | {
    kind: 'ready'
    payload: Record<string, unknown>
    claimed: string
    seq: number
    at: string
    kindName: string
    prevHash: string
    data: Record<string, unknown>
  }

function parseReceipt(record: unknown): Parsed {
  if (!isRecord(record)) return { kind: 'malformed', claimed: null }
  const claimed = claimedHash(record)
  if (claimed === 'conflict') return { kind: 'malformed', claimed: null }
  const claimedHex = typeof claimed === 'string' ? claimed : null
  if (record.schema === undefined || record.at === undefined || record.data === undefined) {
    return { kind: 'insufficient', claimed: claimedHex }
  }
  const seq = record.seq
  const at = record.at
  const kindName = record.kind
  const prevHash = record.prevHash
  const data = record.data
  const seqOk = typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 1 && !Object.is(seq, -0)
  const atOk = typeof at === 'string' && at.length > 0 && at.length <= 80
  const kindOk = typeof kindName === 'string' && kindName.length > 0 && kindName.length <= 80
  const prevOk = typeof prevHash === 'string' && HEX_64.test(prevHash)
  if (record.schema !== SCHEMA || !seqOk || !atOk || !kindOk || !prevOk || !isRecord(data) || claimedHex === null) {
    return { kind: 'malformed', claimed: claimedHex }
  }
  const payload: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (key === 'leafHash') continue
    if (key === 'hash' && record.leafHash === undefined) continue
    payload[key] = record[key]
  }
  return { kind: 'ready', payload, claimed: claimedHex, seq, at, kindName, prevHash, data }
}

function claimedHash(record: Record<string, unknown>): string | null | 'conflict' {
  const leaf = record.leafHash
  const hash = record.hash
  const leafOk = typeof leaf === 'string' && HEX_64.test(leaf)
  const hashOk = typeof hash === 'string' && HEX_64.test(hash)
  if (typeof leaf === 'string' && !leafOk) return 'conflict'
  if (typeof hash === 'string' && !hashOk) return 'conflict'
  if (leafOk && hashOk && leaf !== hash) return 'conflict'
  if (leafOk) return leaf
  if (hashOk) return hash
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(message: Uint8Array): Uint8Array | null {
  if (message.length > MAX_CANONICAL_BYTES) return null
  const bytes = message.length
  const zeros = (56 - ((bytes + 1) % 64) + 64) % 64
  const padded = new Uint8Array(bytes + 1 + zeros + 8)
  padded.set(message)
  padded[bytes] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 4, bytes * 8)
  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const word = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) word[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 64; index += 1) {
      const w15 = word[index - 15] ?? 0
      const w2 = word[index - 2] ?? 0
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      word[index] = (((word[index - 16] ?? 0) + s0 + (word[index - 7] ?? 0) + s1) >>> 0)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + ch + (SHA_K[index] ?? 0) + (word[index] ?? 0)) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, h0)
  outView.setUint32(4, h1)
  outView.setUint32(8, h2)
  outView.setUint32(12, h3)
  outView.setUint32(16, h4)
  outView.setUint32(20, h5)
  outView.setUint32(24, h6)
  outView.setUint32(28, h7)
  return out
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}
