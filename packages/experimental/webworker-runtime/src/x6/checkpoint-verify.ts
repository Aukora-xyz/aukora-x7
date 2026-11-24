/**
 * checkpoint-verify.ts — read-only head and checkpoint verifier, kind `thread`.
 *
 * Two claims, never mixed:
 *   bytes    — provable HERE, from bytes this function hashes itself, never from a declared field.
 *   position — edge-scoped: `current_per_edge` means only "this edge, at the moment of the gather,
 *              listed exactly these bytes as the head of this conversation". It is not freshness.
 * The one rule: `expected` is an INPUT; this function never derives it from the candidate.
 * Order is contradiction before absence; a 403 is EXPECTED_FORBIDDEN, never an absence.
 * Pure and synchronous: no fetch, no fs, no signature, no clock of its own.
 * Kind `capsule` is card 2 and answers KIND_NOT_IN_CARD_1.
 */

export type CheckpointKind = 'thread' | 'capsule'

export type CheckpointVerdict =
  | 'digest_mismatch'
  | 'conflicting'
  | 'stale'
  | 'missing_bytes'
  | 'freshness_unconfirmed'
  | 'current_per_edge'

/** Precedence, first that applies wins; exported so a tool and its spec cannot drift from it. */
export const CHECKPOINT_VERDICT_ORDER: readonly CheckpointVerdict[] = [
  'digest_mismatch',
  'conflicting',
  'stale',
  'missing_bytes',
  'freshness_unconfirmed',
  'current_per_edge',
]

/** Closed reason codes. A new situation needs a new code here, never free text. */
export type CheckpointReason =
  | 'KIND_NOT_IN_CARD_1'
  | 'CANDIDATE_MALFORMED'
  | 'BYTES_DECLARED_MISMATCH'
  | 'TAIL_SHA_DECLARED_MISMATCH'
  | 'PIECE_SHA_MISMATCH'
  | 'THREAD_ID_DIFFERS'
  | 'CHAIN_DIFFERS'
  | 'SIBLING_AT_SAME_HEIGHT'
  | 'PREFIX_CONTRADICTS'
  | 'PREFIX_PROVEN_OLDER'
  | 'PIECE_WITHHELD'
  | 'PIECE_ABSENT_FROM_EXPECTED'
  | 'EXPECTED_ABSENT'
  | 'EXPECTED_FORBIDDEN'
  | 'EXPECTED_FROM_CANDIDATE'
  | 'EXPECTED_TORN'
  | 'EXPECTED_NOT_INDEPENDENT'
  | 'EXPECTED_STALE_OBSERVATION'
  | 'PREFIX_UNPROVEN'
  | 'TAIL_UNSEALED'
  | 'AHEAD_OF_EXPECTED'
  | 'BYTES_AND_POSITION_MATCH'

/** One content-named piece, in order. `sha: ''` means the edge listed the piece and withheld it. */
export interface ThreadPiece {
  readonly bytes: number
  readonly sha: string
}

/** The independent fact: what this edge listed. Gathered by GET only, outside this function. */
export interface ThreadExpected {
  readonly id: string
  readonly bytes: number
  /** Byte offset of the last complete line: the committed turn boundary. */
  readonly lineEnd: number
  readonly chain: string
  readonly tailSha: string
  readonly parts: readonly ThreadPiece[]
  readonly sealed: boolean
  /** The gather's own read time; null means the fact was not independently observed. */
  readonly observedAtMs: number | null
  readonly leaseGenerationBefore: number | null
  readonly leaseGenerationAfter: number | null
  /** GET routes the session was not allowed to read (403). Forbids a verdict; never excuses absence. */
  readonly forbiddenRoutes?: readonly string[]
  readonly absent?: boolean
  /** Self-pin control: set by a caller that built `expected` from the candidate. Always unconfirmed. */
  readonly derivedFromCandidate?: boolean
}

/** The bytes under test plus what the candidate says about them. Declarations are checked, not believed. */
export interface ThreadCandidate {
  readonly id: string
  readonly body: Uint8Array | string
  readonly claimed: {
    readonly bytes: number
    readonly lineEnd: number
    readonly chain: string
    readonly tailSha: string
  }
}

export interface CheckpointIdentity {
  readonly kind: 'edge-session'
  readonly sessionId: string
}

export interface CheckpointInput {
  readonly kind: CheckpointKind
  readonly candidate: ThreadCandidate | null
  readonly identity: CheckpointIdentity
  readonly expected: ThreadExpected | null
  readonly nowMs: number
}

export interface CheckpointAnswer {
  readonly ok: boolean
  readonly verdict: CheckpointVerdict
  readonly reason: CheckpointReason
  readonly claims: {
    readonly bytes: 'checked' | 'unproven'
    readonly position: 'edge_scoped' | null
  }
  /** Every number here was computed by this function from the bytes it was given. */
  readonly observed: {
    readonly bytes: number | null
    readonly lineEnd: number | null
    readonly tailSha: string | null
    readonly sealed: boolean | null
  }
  /** The anchor is independent of the checkpoint, not of the edge. */
  readonly anchor: 'SAME_EDGE_ANCHOR'
}

/** How long a gathered fact counts as an observation before it is only history. */
export const EXPECTED_OBSERVATION_MAX_AGE_MS = 120_000

const NEWLINE = 0x0a

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

/**
 * One word of a fixed-size schedule or state. The index is always inside the array by construction;
 * if it ever were not, this refuses instead of hashing a fabricated zero and calling the result proof.
 */
function word(at: Uint32Array, index: number): number {
  const value = at[index]
  if (value === undefined) throw new RangeError(`sha256 word ${String(index)} is outside its array`)
  return value
}

/** SHA-256 of exact bytes, lowercase hex: no import, no async, nothing to await. */
export function sha256Hex(input: Uint8Array): string {
  const bitLength = input.length * 8
  const padded = new Uint8Array(((input.length + 9 + 63) >> 6) << 6)
  padded.set(input)
  padded[input.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const w15 = word(w, i - 15)
      const w2 = word(w, i - 2)
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = (word(w, i - 16) + s0 + word(w, i - 7) + s1) >>> 0
    }
    let a = word(h, 0)
    let b = word(h, 1)
    let c = word(h, 2)
    let d = word(h, 3)
    let e = word(h, 4)
    let f = word(h, 5)
    let g = word(h, 6)
    let q = word(h, 7)
    for (let i = 0; i < 64; i++) {
      const t1 = (q + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + word(K, i) + word(w, i)) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      q = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (word(h, 0) + a) >>> 0
    h[1] = (word(h, 1) + b) >>> 0
    h[2] = (word(h, 2) + c) >>> 0
    h[3] = (word(h, 3) + d) >>> 0
    h[4] = (word(h, 4) + e) >>> 0
    h[5] = (word(h, 5) + f) >>> 0
    h[6] = (word(h, 6) + g) >>> 0
    h[7] = (word(h, 7) + q) >>> 0
  }
  let hex = ''
  for (let i = 0; i < 8; i++) hex += word(h, i).toString(16).padStart(8, '0')
  return hex
}

function bytesOf(body: Uint8Array | string): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body
}

const NOTHING: CheckpointAnswer['observed'] = { bytes: null, lineEnd: null, tailSha: null, sealed: null }

function say(
  verdict: CheckpointVerdict,
  reason: CheckpointReason,
  observed: CheckpointAnswer['observed'],
  position: 'edge_scoped' | null,
): CheckpointAnswer {
  return {
    ok: verdict === 'current_per_edge',
    verdict,
    reason,
    claims: { bytes: position === null ? 'unproven' : 'checked', position },
    observed,
    anchor: 'SAME_EDGE_ANCHOR',
  }
}

/**
 * Verify one thread checkpoint. First verdict that applies wins, in CHECKPOINT_VERDICT_ORDER.
 * The candidate's declarations are never believed: every digest compared here was computed.
 */
export function verifyCheckpoint(input: CheckpointInput): CheckpointAnswer {
  const { kind, candidate, expected, nowMs } = input

  if (kind !== 'thread') return say('freshness_unconfirmed', 'KIND_NOT_IN_CARD_1', NOTHING, null)
  if (candidate === null || expected === null) {
    return say('freshness_unconfirmed', 'CANDIDATE_MALFORMED', NOTHING, null)
  }

  const body = bytesOf(candidate.body)
  const observedBytes = body.length
  const lineEnd = candidate.claimed.lineEnd
  if (!Number.isInteger(lineEnd) || lineEnd < 0 || lineEnd > observedBytes) {
    return say('digest_mismatch', 'CANDIDATE_MALFORMED', { ...NOTHING, bytes: observedBytes }, null)
  }

  const sealed = lineEnd === 0 ? false : body[lineEnd - 1] === NEWLINE
  const tailSha = sha256Hex(body.subarray(0, lineEnd))
  const observed: CheckpointAnswer['observed'] = { bytes: observedBytes, lineEnd, tailSha, sealed }

  // digest_mismatch: what the candidate says about bytes we hold.
  if (candidate.claimed.bytes !== observedBytes) {
    return say('digest_mismatch', 'BYTES_DECLARED_MISMATCH', observed, null)
  }
  if (candidate.claimed.tailSha !== tailSha) {
    return say('digest_mismatch', 'TAIL_SHA_DECLARED_MISMATCH', observed, null)
  }

  // The independent fact is unusable: forbidden, absent, self-pinned, torn, or not observed.
  if (expected.forbiddenRoutes !== undefined && expected.forbiddenRoutes.length > 0) {
    return say('freshness_unconfirmed', 'EXPECTED_FORBIDDEN', observed, null)
  }
  if (expected.absent) return say('freshness_unconfirmed', 'EXPECTED_ABSENT', observed, null)
  if (expected.derivedFromCandidate === true) {
    return say('freshness_unconfirmed', 'EXPECTED_FROM_CANDIDATE', observed, null)
  }
  const before = expected.leaseGenerationBefore
  const after = expected.leaseGenerationAfter
  // A half-drop is as torn as a move: one generation alone cannot pair two reads.
  const halfDropped = (before === null) !== (after === null)
  if (halfDropped || (before !== null && after !== null && before !== after)) {
    return say('freshness_unconfirmed', 'EXPECTED_TORN', observed, null)
  }
  if (expected.observedAtMs === null) {
    return say('freshness_unconfirmed', 'EXPECTED_NOT_INDEPENDENT', observed, null)
  }
  const age = nowMs - expected.observedAtMs
  if (!Number.isFinite(age) || age < 0 || age > EXPECTED_OBSERVATION_MAX_AGE_MS) {
    return say('freshness_unconfirmed', 'EXPECTED_STALE_OBSERVATION', observed, null)
  }

  // conflicting: two facts disagree about the same thing.
  if (candidate.id !== expected.id) return say('conflicting', 'THREAD_ID_DIFFERS', observed, null)
  if (expected.parts.some((piece) => piece.sha === '')) {
    return say('missing_bytes', 'PIECE_WITHHELD', observed, null)
  }

  // Walk the expected pieces over the bytes we hold. A piece is proven only if it ends inside them.
  const proven: string[] = []
  let cursor = 0
  let onBoundary = observedBytes === 0
  let expectedBytes = 0
  for (const piece of expected.parts) {
    expectedBytes += piece.bytes
    if (cursor + piece.bytes > observedBytes) break
    proven.push(sha256Hex(body.subarray(cursor, cursor + piece.bytes)))
    cursor += piece.bytes
    if (cursor === observedBytes) onBoundary = true
  }
  for (let i = 0; i < proven.length; i++) {
    const part = expected.parts[i]
    if (part === undefined) return say('missing_bytes', 'PIECE_ABSENT_FROM_EXPECTED', observed, null)
    if (proven[i] !== part.sha) {
      return say('conflicting', 'PREFIX_CONTRADICTS', observed, null)
    }
  }
  // The position claim: this edge's own list, compared with bytes we have proven.
  if (observedBytes > expected.bytes) {
    return say('freshness_unconfirmed', 'AHEAD_OF_EXPECTED', observed, null)
  }
  if (observedBytes === expected.bytes) {
    if (candidate.claimed.chain !== expected.chain) {
      return say('conflicting', 'CHAIN_DIFFERS', observed, null)
    }
    if (tailSha !== expected.tailSha) {
      return say('conflicting', 'SIBLING_AT_SAME_HEIGHT', observed, null)
    }
    // `current` needs the committed boundary ITSELF. The digest computed above covers
    // [0, claimed.lineEnd); if the candidate's cut is not the edge's cut, the bytes past it
    // were hashed by nobody, so a same-length body must not be blessed.
    if (lineEnd !== expected.lineEnd || observedBytes !== expected.lineEnd) {
      return say('freshness_unconfirmed', 'TAIL_UNSEALED', observed, null)
    }
    if (expected.sealed && !sealed) return say('freshness_unconfirmed', 'TAIL_UNSEALED', observed, null)
    return say('current_per_edge', 'BYTES_AND_POSITION_MATCH', observed, 'edge_scoped')
  }

  // Shorter than the edge's copy: an older copy, but only when its prefix is PROVEN by bytes.
  if (onBoundary && proven.length > 0 && cursor === observedBytes) {
    if (expectedBytes < expected.bytes) {
      return say('missing_bytes', 'PIECE_ABSENT_FROM_EXPECTED', observed, null)
    }
    return say('stale', 'PREFIX_PROVEN_OLDER', observed, 'edge_scoped')
  }
  return say('freshness_unconfirmed', 'PREFIX_UNPROVEN', observed, null)
}
