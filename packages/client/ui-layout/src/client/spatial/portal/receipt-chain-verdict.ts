// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * A READ-ONLY VERDICT FOR HER RECEIPT CHAIN: does the ledger this window holds extend her last checkpoint?
 *
 * Port of the membrane minimal verifier (from an earlier repository; RFC 6962 consistency), with its three
 * verdicts and no fourth:
 *   APPEND_ONLY           the proof folds to the presented root and reaches the retained root;
 *   OBSERVATION_CONFLICT  the proof folds to the presented root and reaches a DIFFERENT retained root;
 *   UNDETERMINED          anything else: damaged, absent or structurally underivable. It is unknown, never "fine".
 * Retained = her last checkpoint (`receiptCount`, `merkleRoot`); presented = every `leafHash` in the ledger now. Her tree
 * (seed-receipts.js `merkleRootHex`: 0x01 node prefix, odd node promoted) is the RFC 6962 tree, checked by the spec.
 * It gates nothing. APPEND_ONLY is not trust: the checkpoint is read from the same store as the ledger, and its
 * signature is verified elsewhere (her own verify), not here.
 * @module portal/receipt-chain-verdict
 */

import { canonicalJson } from '../aumlok/class3-approval.ts'

/** Her checkpoint file, beside the ledger (seed-receipts.js CHECKPOINTS_FILE). */
export const CHECKPOINTS_PATH = '/dsh/home/auma/seed/checkpoints.v1.jsonl'

export type ChainVerdictKind = 'APPEND_ONLY' | 'OBSERVATION_CONFLICT' | 'UNDETERMINED'

export interface ChainVerdict {
  readonly verdict: ChainVerdictKind
  readonly reason: string
  /** SHA-256 of the exact checkpoint and ledger text the verdict was computed from (null when not read). */
  readonly inputHashes: { readonly retained: string | null; readonly presented: string | null }
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER
const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)
const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE
const isPowerOfTwo = (value: number): boolean => value > 0 && (value & (value - 1)) === 0
const fromHex = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from(hex.match(/../g) ?? [], byte => parseInt(byte, 16))
const toHex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}

/** Interior node: SHA-256(0x01 || left || right). */
export async function nodeHash(left: string, right: string): Promise<string> {
  const bytes = new Uint8Array(65)
  bytes[0] = 0x01
  bytes.set(fromHex(left), 1)
  bytes.set(fromHex(right), 33)
  return sha256Hex(bytes)
}

/**
 * RFC 6962 consistency check, a line-for-line port of verify.py `verify_consistency`.
 * @returns the verdict and its reason code (verify.py's own strings).
 */
export async function verifyConsistency(m: unknown, n: unknown, root1: unknown, root2: unknown,
  proof: unknown): Promise<[ChainVerdictKind, string]> {
  if (!isSize(m) || !isSize(n) || m > n) return ['UNDETERMINED', 'invalid_tree_sizes']
  if (!isDigest(root1) || !isDigest(root2)) return ['UNDETERMINED', 'root_is_not_a_digest']
  if (!Array.isArray(proof) || !proof.every(isDigest)) return ['UNDETERMINED', 'proof_element_is_not_a_digest']
  const path: readonly string[] = proof
  if (m === 0) return ['UNDETERMINED', 'missing_prior_observation']
  if (m === n) {
    if (path.length !== 0) return ['UNDETERMINED', 'non_empty_proof_for_same_size']
    return root1.toLowerCase() === root2.toLowerCase() ? ['APPEND_ONLY', 'identical_trees_match'] : ['OBSERVATION_CONFLICT', 'same_size_root_mismatch']
  }
  if (path.length === 0) return ['UNDETERMINED', 'empty_proof_for_different_sizes']
  let index = 0
  let fr: string, sr: string
  if (isPowerOfTwo(m)) { fr = root1; sr = root1 } else { fr = path[0] as string; sr = path[0] as string; index = 1 }
  // Bit arithmetic as verify.py; sizes stay below 2^53, so plain division keeps them exact.
  let fn = m - 1, sn = n - 1
  const odd = (value: number): boolean => value % 2 === 1
  const half = (value: number): number => Math.floor(value / 2)
  while (odd(fn)) { fn = half(fn); sn = half(sn) }
  while (sn > 0) {
    if (index >= path.length) return ['UNDETERMINED', 'proof_path_truncated']
    const next = path[index] as string
    index += 1
    if (odd(fn) || fn === sn) {
      fr = await nodeHash(next, fr)
      sr = await nodeHash(next, sr)
      while (fn > 0 && !odd(fn)) { fn = half(fn); sn = half(sn) }
    } else {
      sr = await nodeHash(sr, next)
    }
    fn = half(fn)
    sn = half(sn)
  }
  if (sr.toLowerCase() !== root2.toLowerCase()) {
    return ['UNDETERMINED', isPowerOfTwo(m) ? 'POWER_OF_TWO_PREFIX_NOT_INDEPENDENTLY_DERIVABLE' : 'proof_did_not_connect_to_presented_head']
  }
  if (index !== path.length) return ['UNDETERMINED', 'unconsumed_proof_elements']
  if (fr.toLowerCase() === root1.toLowerCase()) return ['APPEND_ONLY', 'valid_append_only_extension']
  if (isPowerOfTwo(m)) return ['UNDETERMINED', 'POWER_OF_TWO_PREFIX_NOT_INDEPENDENTLY_DERIVABLE']
  return ['OBSERVATION_CONFLICT', 'consistency:prefix-mismatch']
}

/** Her Merkle root (seed-receipts.js `merkleRootHex`): pairs bottom-up, an odd last node is promoted; empty = SHA-256(''). */
export async function merkleRoot(leaves: readonly string[]): Promise<string> {
  if (leaves.length === 0) return sha256Hex(new Uint8Array(0))
  let level = [...leaves]
  while (level.length > 1) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? await nodeHash(level[i] as string, level[i + 1] as string) : level[i] as string)
    }
    level = next
  }
  return level[0] as string
}

/** RFC 6962 PROOF(m, D[n]) (section 2.1.2), built from the presented leaves. */
export async function consistencyProof(m: number, leaves: readonly string[]): Promise<string[]> {
  const sub = async (size: number, nodes: readonly string[], complete: boolean): Promise<string[]> => {
    if (size === nodes.length) return complete ? [] : [await merkleRoot(nodes)]
    let k = 1
    while (k * 2 < nodes.length) k *= 2
    return size <= k
      ? [...await sub(size, nodes.slice(0, k), complete), await merkleRoot(nodes.slice(k))]
      : [...await sub(size - k, nodes.slice(k), false), await merkleRoot(nodes.slice(0, k))]
  }
  return m <= 0 || m > leaves.length ? [] : sub(m, leaves, true)
}

const textHash = (text: string): Promise<string> => sha256Hex(new TextEncoder().encode(text))

/**
 * The verdict for one window's copy of her ledger and checkpoints.
 * @param input - the exact text of `checkpoints.v1.jsonl` and `receipts.v3.jsonl`, or null when a file was not read.
 * @returns a verdict; anything unreadable is UNDETERMINED with the reason.
 */
export async function chainVerdictOf(input: {
  readonly checkpointsText: string | null
  readonly receiptsText: string | null
}): Promise<ChainVerdict> {
  const inputHashes = {
    retained: input.checkpointsText === null ? null : await textHash(input.checkpointsText),
    presented: input.receiptsText === null ? null : await textHash(input.receiptsText),
  }
  const undetermined = (reason: string): ChainVerdict => ({ verdict: 'UNDETERMINED', reason, inputHashes })
  if (input.checkpointsText === null) return undetermined('missing_prior_observation')
  if (input.receiptsText === null) return undetermined('presented_ledger_not_read')
  const lines = (text: string): unknown[] | null => {
    const rows: unknown[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try { rows.push(JSON.parse(line)) } catch { return null }
    }
    return rows
  }
  const checkpoints = lines(input.checkpointsText)
  const receipts = lines(input.receiptsText)
  if (checkpoints === null) return undetermined('retained_checkpoint_unreadable')
  if (receipts === null) return undetermined('presented_ledger_unreadable')
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  // EVERY LEAF IS RECOMPUTED FROM ITS ROW: seed-receipts.js `verify`'s own rule. The schema, the sequence,
  // the link to the leaf before, and leafHash = SHA-256(0x00 || canonical JSON of the row without leafHash). A row whose
  // contents changed while its hash was kept makes the verdict UNDETERMINED, never append-only.
  const leaves: string[] = []
  let previous = '0'.repeat(64)
  for (const [index, row] of receipts.entries()) {
    if (!record(row) || !isDigest(row.leafHash)) return undetermined('presented_leaf_is_not_a_digest')
    const { leafHash, ...payload } = row
    if (payload.schema !== 'aukora.receipt.v3' || payload.seq !== index + 1) return undetermined(`receipt_${String(index + 1)}_sequence_broken`)
    if (payload.prevHash !== previous) return undetermined(`receipt_${String(index + 1)}_link_broken`)
    const canonical = new TextEncoder().encode(canonicalJson(payload))
    const preimage = new Uint8Array(canonical.byteLength + 1)
    preimage.set(canonical, 1)
    if (await sha256Hex(preimage) !== leafHash.toLowerCase()) return undetermined(`receipt_${String(index + 1)}_contents_do_not_match_its_hash`)
    leaves.push(leafHash.toLowerCase())
    previous = leafHash
  }
  const last = checkpoints.at(-1)
  const body = record(last) && record(last.body) ? last.body : null
  if (body === null) return undetermined('missing_prior_observation')
  const m = body.receiptCount
  const root1 = body.merkleRoot
  const presentedRoot = await merkleRoot(leaves)
  const proof = isSize(m) && m > 0 && m < leaves.length ? await consistencyProof(m, leaves) : []
  const [verdict, reason] = await verifyConsistency(m, leaves.length, root1, presentedRoot, proof)
  return { verdict, reason, inputHashes }
}

/** One line for the Receipt chain card. UNDETERMINED reads as unknown, never as fine. */
export function chainVerdictWords(verdict: ChainVerdict): string {
  if (verdict.verdict === 'APPEND_ONLY') {
    return 'Append-only: every receipt in this window hashes to its own leaf and links to the one before, and the ledger extends her '
      + 'last checkpoint (arithmetic only, not trust).'
  }
  if (verdict.verdict === 'OBSERVATION_CONFLICT') return `Conflict: the ledger in this window does NOT extend her last checkpoint (${verdict.reason}).`
  return `Unknown: whether the ledger extends her last checkpoint could not be determined (${verdict.reason}).`
}
