import { describe, expect, it } from 'vitest'
import { sha256HexSync } from '../../src/module-system/module-loader.ts'
import {
  CHECKPOINT_VERDICT_ORDER,
  verifyCheckpoint,
  sha256Hex,
  type CheckpointInput,
  type ThreadCandidate,
  type ThreadExpected,
} from '../../src/x6/checkpoint-verify.ts'

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const NOW = 1_800_000_000_000
const IDENTITY = { kind: 'edge-session' as const, sessionId: 's1' }

/** Contiguous pieces of `step` bytes, each with its own computed sha. */
function pieces(body: Uint8Array, step: number): { bytes: number; sha: string }[] {
  const out: { bytes: number; sha: string }[] = []
  for (let i = 0; i < body.length; i += step) {
    const slice = body.subarray(i, Math.min(i + step, body.length))
    out.push({ bytes: slice.length, sha: sha256Hex(slice) })
  }
  return out
}

function lineEndOf(body: Uint8Array): number {
  return body.lastIndexOf(0x0a) + 1
}

function expectOf(body: Uint8Array, over: Partial<ThreadExpected> = {}): ThreadExpected {
  const lineEnd = lineEndOf(body)
  return {
    id: 't1',
    bytes: body.length,
    lineEnd,
    chain: 'c1',
    tailSha: sha256Hex(body.subarray(0, lineEnd)),
    parts: pieces(body, 8),
    sealed: lineEnd > 0,
    observedAtMs: NOW - 1_000,
    leaseGenerationBefore: 7,
    leaseGenerationAfter: 7,
    ...over,
  }
}

function candOf(body: Uint8Array, over: Partial<ThreadCandidate['claimed']> = {}): ThreadCandidate {
  const lineEnd = lineEndOf(body)
  return {
    id: 't1',
    body,
    claimed: { bytes: body.length, lineEnd, chain: 'c1', tailSha: sha256Hex(body.subarray(0, lineEnd)), ...over },
  }
}

function run(candidate: ThreadCandidate | null, expected: ThreadExpected | null, kind: 'thread' | 'capsule' = 'thread') {
  const input: CheckpointInput = { kind, candidate, identity: IDENTITY, expected, nowMs: NOW }
  return verifyCheckpoint(input)
}

// A fixed body with two 8-byte pieces, so 8 is a piece boundary and 12 is not.
const BODY = enc('aaaaaaa\nbbbbbbb\n')

describe('sha256Hex — the standard vectors, then parity with the runtime hash', () => {
  it('matches the published digests', () => {
    expect(sha256Hex(enc(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('agrees with sha256HexSync at every block edge', () => {
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const bytes = new Uint8Array(length)
      for (let i = 0; i < length; i++) bytes[i] = (i * 7 + 3) % 251
      expect(sha256Hex(bytes)).toBe(sha256HexSync(bytes))
      // The runtime hash takes a string too; both input forms must agree with each other.
      // ASCII only: a byte of 128 or more is not valid UTF-8, so decoding arbitrary bytes yields
      // different bytes and the parity being tested would be between two different inputs.
      const ascii = Array.from(bytes, (value) => String.fromCharCode(value & 0x7f)).join('')
      expect(sha256Hex(new TextEncoder().encode(ascii))).toBe(sha256HexSync(ascii))
    }
  })

  it('agrees with sha256HexSync on 300 deterministic mixed-length inputs', () => {
    let seed = 0x2f6e2b1
    for (let k = 0; k < 300; k++) {
      seed = (seed * 1103515245 + 12345) % 0x80000000
      const length = seed % 257
      const bytes = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        seed = (seed * 1103515245 + 12345) % 0x80000000
        bytes[i] = seed % 256
      }
      expect(sha256Hex(bytes)).toBe(sha256HexSync(bytes))
    }
  })
})

describe('verifyCheckpoint — order and the controls that must never reach current', () => {
  it('pins the verdict order the judges read', () => {
    expect(CHECKPOINT_VERDICT_ORDER).toEqual([
      'digest_mismatch',
      'conflicting',
      'stale',
      'missing_bytes',
      'freshness_unconfirmed',
      'current_per_edge',
    ])
  })

  it('P1: matching bytes at the committed boundary are current_per_edge', () => {
    const answer = run(candOf(BODY), expectOf(BODY))
    expect(answer.verdict).toBe('current_per_edge')
    expect(answer.claims).toEqual({ bytes: 'checked', position: 'edge_scoped' })
    expect(answer.anchor).toBe('SAME_EDGE_ANCHOR')
  })

  it('a declared byte count that the bytes contradict is digest_mismatch', () => {
    expect(run(candOf(BODY, { bytes: BODY.length + 1 }), expectOf(BODY)).reason).toBe('BYTES_DECLARED_MISMATCH')
  })

  it('a declared tail digest the bytes contradict is digest_mismatch', () => {
    expect(run(candOf(BODY, { tailSha: '0'.repeat(64) }), expectOf(BODY)).reason).toBe('TAIL_SHA_DECLARED_MISMATCH')
  })

  it('SELF-PIN: expected derived from the candidate is unconfirmed even when every digest matches', () => {
    const candidate = candOf(BODY)
    const expected = expectOf(BODY, { derivedFromCandidate: true })
    const answer = run(candidate, expected)
    expect(answer.verdict).toBe('freshness_unconfirmed')
    expect(answer.reason).toBe('EXPECTED_FROM_CANDIDATE')
    expect(answer.claims.position).toBeNull()
  })

  it('A MISSING PIECE CAN NEVER REACH stale: a shorter copy off a piece boundary is PREFIX_UNPROVEN', () => {
    const shorter = BODY.subarray(0, 12) // inside the second piece: no boundary at 12
    const answer = run(candOf(shorter), expectOf(BODY))
    expect(answer.verdict).toBe('freshness_unconfirmed')
    expect(answer.reason).toBe('PREFIX_UNPROVEN')
  })

  it('an authentic older copy ON a piece boundary is stale, only because the prefix is proven', () => {
    const older = BODY.subarray(0, 8)
    const answer = run(candOf(older), expectOf(BODY))
    expect(answer.verdict).toBe('stale')
    expect(answer.reason).toBe('PREFIX_PROVEN_OLDER')
  })

  it('a piece the edge listed but withheld is missing_bytes', () => {
    const expected = expectOf(BODY)
    const firstPart = expected.parts[0]
    if (firstPart === undefined) throw new Error('the scaffold always carries one part')
    const parts = [{ bytes: firstPart.bytes, sha: '' }, ...expected.parts.slice(1)]
    expect(run(candOf(BODY), { ...expected, parts }).reason).toBe('PIECE_WITHHELD')
  })

  it('a gather whose lease generation moved is EXPECTED_TORN, never absent', () => {
    const answer = run(candOf(BODY), expectOf(BODY, { leaseGenerationBefore: 7, leaseGenerationAfter: 8 }))
    expect(answer.reason).toBe('EXPECTED_TORN')
  })

  it('a 403 forbids: EXPECTED_FORBIDDEN, and it is not an absence', () => {
    const answer = run(candOf(BODY), expectOf(BODY, { forbiddenRoutes: ['/_head/promotion-status'] }))
    expect(answer.reason).toBe('EXPECTED_FORBIDDEN')
    expect(answer.reason).not.toBe('EXPECTED_ABSENT')
  })

  it('the capsule kind is not in this card', () => {
    expect(run(candOf(BODY), expectOf(BODY), 'capsule').reason).toBe('KIND_NOT_IN_CARD_1')
  })
})

// A second block: the two forgeries the crew found, plus the five controls it priced.
const A16 = new Uint8Array(16).fill(0x61)
A16[15] = 0x0a

describe('the controls the crew found — a fix without a failing case is a claim', () => {
  it('FORGERY 1: a same-length body whose cut is not the edge cut is never current', () => {
    // 7 bytes, but only the first 3 are inside the claimed boundary: "EVIL" was hashed by nobody.
    const body = enc('ok\nEVIL')
    const candidate: ThreadCandidate = {
      id: 't1',
      body,
      claimed: { bytes: 7, lineEnd: 3, chain: 'c1', tailSha: sha256Hex(enc('ok\n')) },
    }
    const expected: ThreadExpected = {
      id: 't1',
      bytes: 7,
      lineEnd: 7,
      chain: 'c1',
      tailSha: sha256Hex(enc('ok\n')),
      parts: [],
      sealed: true,
      observedAtMs: NOW - 1_000,
      leaseGenerationBefore: 7,
      leaseGenerationAfter: 7,
    }
    const answer = run(candidate, expected)
    expect(answer.verdict).toBe('freshness_unconfirmed')
    expect(answer.reason).toBe('TAIL_UNSEALED')
    expect(answer.claims.bytes).toBe('unproven')
  })

  it('FORGERY 2: a half-dropped lease is torn, not clean', () => {
    const answer = run(candOf(BODY), expectOf(BODY, { leaseGenerationAfter: null }))
    expect(answer.reason).toBe('EXPECTED_TORN')
  })

  it('SIBLING_AT_SAME_HEIGHT: same length, same chain, different tail', () => {
    const answer = run(candOf(A16), expectOf(A16, { tailSha: '0'.repeat(64) }))
    expect(answer.verdict).toBe('conflicting')
    expect(answer.reason).toBe('SIBLING_AT_SAME_HEIGHT')
  })

  it('PREFIX_CONTRADICTS: a listed piece digest that the bytes contradict', () => {
    const expected = expectOf(A16)
    const firstPart = expected.parts[0]
    if (firstPart === undefined) throw new Error('the scaffold always carries one part')
    const parts = [{ bytes: firstPart.bytes, sha: 'ab'.repeat(32) }, ...expected.parts.slice(1)]
    const answer = run(candOf(A16), { ...expected, parts })
    expect(answer.verdict).toBe('conflicting')
    expect(answer.reason).toBe('PREFIX_CONTRADICTS')
  })

  it('PIECE_ABSENT_FROM_EXPECTED: the edge lists 16 bytes but only 8 are provable', () => {
    const short = A16.subarray(0, 8) // 7 x 0x61 then 0x0a: a real 8-byte prefix
    const expected = expectOf(A16, { parts: [{ bytes: 8, sha: sha256Hex(short) }] })
    const answer = run(candOf(short), expected)
    expect(answer.verdict).toBe('missing_bytes')
    expect(answer.reason).toBe('PIECE_ABSENT_FROM_EXPECTED')
  })

  it('EXPECTED_STALE_OBSERVATION: one millisecond past the observation window', () => {
    const answer = run(candOf(A16), expectOf(A16, { observedAtMs: NOW - 120_001 }))
    expect(answer.reason).toBe('EXPECTED_STALE_OBSERVATION')
  })

  it('AHEAD_OF_EXPECTED: more bytes than the edge listed', () => {
    const expected = expectOf(A16, { bytes: 8, lineEnd: 8, parts: [{ bytes: 8, sha: sha256Hex(A16.subarray(0, 8)) }] })
    const answer = run(candOf(A16), expected)
    expect(answer.verdict).toBe('freshness_unconfirmed')
    expect(answer.reason).toBe('AHEAD_OF_EXPECTED')
  })
})
