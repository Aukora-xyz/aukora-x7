/**
 * Bounded recall over verified memory nodes and a recomputed discovery corpus.
 *
 * `seed-memory.js` rows are `{id, kind, line, text}` or ledger `{at, kind, text}`.
 * They have no content hash and no parents, so they are not counted.
 * A node counts when it matches `auma-memory-domain.js`: either
 * `memoryId = SHA-256(canonical({fact, source, createdAt, parents}))` with
 * `recordHash` over the remaining record, or a DAG node whose `id` is
 * SHA-256 of the canonical node without `id` (`parentIds` and `content`).
 * Caller `verified: true` is ignored. Discovery scores are ignored unless the
 * input carries the receipt rows and those leaves recompute.
 */
import { canonicalJson } from './contract.ts'
import { sha256Hex, verifyReceiptChain, type VerifiedReceipt } from './lineage.ts'
import { projectDiscoveryCorpus } from './prediction.ts'

const HEX_64 = /^[0-9a-f]{64}$/
const MAX_NODES = 256
const MAX_RECEIPTS = 1024
const MAX_QUERY = 2_000
const MAX_LIMIT = 20
const MAX_TEXT = 4_096

/** One nonzero-surprise trajectory taken from recomputed receipts. */
export interface RecallLesson {
  readonly trajectoryId: string
  readonly pearlId: string
  readonly epochBefore: number
  readonly epochAfter: number
  readonly surpriseScore: number
}

/** One verified memory hit. `termScore` is the seed-memory n-gram weight. */
export interface RecallMemory {
  readonly memoryId: string
  readonly text: string
  readonly createdAt: number | null
  readonly termScore: number
}

/**
 * Bounded brief. `verifiedNodeCount` is hash-valid, reachable, and receipt-anchored.
 * Content-addressing is not owner authority. Pre-epoch-54 corpus scores are not lessons.
 */
export interface RecallBrief {
  readonly verifiedNodeCount: number
  readonly orphanNodeCount: number
  readonly reachabilityVerified: boolean
  readonly highSurpriseLessons: readonly RecallLesson[]
  readonly relevantMemories: readonly RecallMemory[]
}

/**
 * Accepted input. `discoveryCorpus.receipts` is the only prediction evidence.
 * A corpus object that carries scores and no receipts yields no lessons.
 */
export interface RecallInput {
  readonly memoryNodes: readonly unknown[]
  readonly discoveryCorpus: unknown
  readonly query: string
  readonly limit: number
  /** Optional DAG head. When present, only these ids are traversal roots. */
  readonly dagHead?: { readonly heads: readonly string[] }
}

interface VerifiedNode {
  readonly id: string
  readonly text: string
  readonly recency: number | null
  readonly parents: readonly string[]
  readonly receiptHash: string | null
}

/**
 * Rank verified memories and recomputed surprise lessons.
 * @param input - Nodes, receipt evidence, query, and limit.
 * @returns A brief. Oversized batches and invalid limits contribute nothing.
 */
export function projectRecallContext(input: RecallInput): RecallBrief {
  const chain = receiptChain(input.discoveryCorpus)
  const walked = verifyNodes(input.memoryNodes, input.dagHead, chain)
  const lessons = lessonsFrom(input.discoveryCorpus)
  const limit = boundedLimit(input.limit)
  const query = typeof input.query === 'string' && input.query.length <= MAX_QUERY ? input.query : ''
  const terms = grams(query)
  const memories = walked.verified
    .map(node => ({ node, termScore: termScore(terms, node.text) }))
    .filter(item => item.termScore > 0)
    .sort((left, right) =>
      right.termScore - left.termScore
      || compareRecency(left.node.recency, right.node.recency)
      || (left.node.id < right.node.id ? -1 : left.node.id > right.node.id ? 1 : 0))
    .slice(0, limit)
    .map(item => ({
      memoryId: item.node.id,
      text: item.node.text,
      createdAt: item.node.recency,
      termScore: item.termScore,
    }))
  const ranked = lessons
    .map(lesson => ({ lesson, termScore: termScore(terms, `${lesson.pearlId} ${lesson.trajectoryId}`) }))
    .sort((left, right) =>
      right.lesson.surpriseScore - left.lesson.surpriseScore
      || right.termScore - left.termScore
      || right.lesson.epochAfter - left.lesson.epochAfter
      || (left.lesson.trajectoryId < right.lesson.trajectoryId ? -1 : left.lesson.trajectoryId > right.lesson.trajectoryId ? 1 : 0))
    .slice(0, limit)
    .map(item => item.lesson)
  return {
    verifiedNodeCount: walked.verified.length,
    orphanNodeCount: walked.orphanNodeCount,
    reachabilityVerified: walked.reachabilityVerified,
    highSurpriseLessons: ranked,
    relevantMemories: memories,
  }
}

function lessonsFrom(corpus: unknown): RecallLesson[] {
  if (!isRecord(corpus) || !Array.isArray(corpus.receipts) || corpus.receipts.length > MAX_RECEIPTS) return []
  const projected = projectDiscoveryCorpus(corpus.receipts)
  if (!projected.leafRecomputed || projected.chainStatus !== 'verified') return []
  return projected.records
    .filter(record => record.surpriseScore > 0 && Number.isFinite(record.surpriseScore) && !Object.is(record.surpriseScore, -0))
    .map(record => ({
      trajectoryId: record.trajectoryId,
      pearlId: record.pearlId,
      epochBefore: record.epochBefore,
      epochAfter: record.epochAfter,
      surpriseScore: record.surpriseScore,
    }))
}

function verifyNodes(
  value: unknown,
  dagHead: RecallInput['dagHead'],
  chain: readonly VerifiedReceipt[] | null,
): { verified: VerifiedNode[]; orphanNodeCount: number; reachabilityVerified: boolean } {
  const empty = { verified: [], orphanNodeCount: 0, reachabilityVerified: false }
  if (!Array.isArray(value) || value.length > MAX_NODES) return empty
  const byId = new Map<string, VerifiedNode>()
  const banned = new Set<string>()
  for (const item of value) {
    const node = readNode(item)
    if (node === null) continue
    if (byId.has(node.id) || banned.has(node.id)) {
      banned.add(node.id)
      byId.delete(node.id)
      continue
    }
    byId.set(node.id, node)
  }
  const reachable = new Set<string>()
  let cycle = false
  if (dagHead === undefined) {
    let grew = true
    while (grew) {
      grew = false
      for (const node of byId.values()) {
        if (reachable.has(node.id)) continue
        if (node.parents.every(parent => reachable.has(parent))) {
          reachable.add(node.id)
          grew = true
        }
      }
    }
  } else {
    const visiting = new Set<string>()
    const walk = (id: string): boolean => {
      if (banned.has(id)) return false
      if (visiting.has(id)) {
        cycle = true
        return false
      }
      if (reachable.has(id)) return true
      const node = byId.get(id)
      if (node === undefined) return false
      visiting.add(id)
      let parentsOk = true
      for (const parent of node.parents) if (!walk(parent)) parentsOk = false
      visiting.delete(id)
      if (!parentsOk || cycle) return false
      reachable.add(id)
      return true
    }
    for (const head of dagHead.heads) if (typeof head === 'string') walk(head)
  }
  const orphans = [...byId.values()].filter(node => !reachable.has(node.id))
  const verified = [...byId.values()].filter(node => reachable.has(node.id) && anchored(node, chain))
  const heads = dagHead?.heads ?? []
  const reachabilityVerified = dagHead !== undefined
    && !cycle
    && orphans.length === 0
    && heads.length > 0
    && heads.every(id => typeof id === 'string' && reachable.has(id))
  return { verified, orphanNodeCount: orphans.length, reachabilityVerified }
}

function anchored(node: VerifiedNode, chain: readonly VerifiedReceipt[] | null): boolean {
  if (node.receiptHash === null) return true
  if (chain === null) return false
  const receipt = chain.find(item => item.leafHash === node.receiptHash)
  if (receipt === undefined || receipt.kind !== 'memory.dag.append') return false
  const data = receipt.data
  if (data.nodeId !== node.id && data.id !== node.id) return false
  const body = typeof data.content === 'string' ? data.content : typeof data.summary === 'string' ? data.summary : null
  return body === node.text
}

function receiptChain(corpus: unknown): readonly VerifiedReceipt[] | null {
  if (!isRecord(corpus) || !Array.isArray(corpus.receipts) || corpus.receipts.length > MAX_RECEIPTS) return null
  const chain = verifyReceiptChain(corpus.receipts)
  return chain.status === 'verified' ? chain.receipts : null
}

function compareRecency(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return right - left
}

function readNode(value: unknown): VerifiedNode | null {
  if (!isRecord(value)) return null
  const fact = readFact(value)
  if (fact !== null) return fact
  return readDag(value)
}

function readFact(node: Record<string, unknown>): VerifiedNode | null {
  if (typeof node.fact !== 'string' || node.fact.length === 0 || node.fact.length > MAX_TEXT) return null
  if (typeof node.source !== 'string' || node.source.length === 0 || node.source.length > 2_048) return null
  if (node.text !== node.fact) return null
  const createdAt = node.createdAt
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0 || Object.is(createdAt, -0)) return null
  if (!Array.isArray(node.parents) || node.parents.length > 16) return null
  const parents: string[] = []
  for (const parent of node.parents) {
    if (typeof parent !== 'string' || !HEX_64.test(parent)) return null
    parents.push(parent)
  }
  const sorted = [...parents].sort()
  if (parents.some((parent, index) => parent !== sorted[index]) || new Set(parents).size !== parents.length) return null
  const memoryId = digest({ fact: node.fact, source: node.source, createdAt, parents })
  if (memoryId === null || node.memoryId !== memoryId || node.id !== memoryId) return null
  const recordHash = digest(without(node, 'recordHash'))
  if (recordHash === null || node.recordHash !== recordHash) return null
  return { id: memoryId, text: node.fact, recency: createdAt, parents, receiptHash: null }
}

function readDag(node: Record<string, unknown>): VerifiedNode | null {
  if (typeof node.id !== 'string' || !HEX_64.test(node.id)) return null
  const text = typeof node.content === 'string' ? node.content : typeof node.summary === 'string' ? node.summary : ''
  if (text.length > MAX_TEXT) return null
  const recency = recencyOf(node.createdAt)
  if (recency === 'bad') return null
  const parents = linksOf(node)
  if (parents === null) return null
  const receiptHash = node.receiptHash === undefined ? null : node.receiptHash
  if (receiptHash !== null && (typeof receiptHash !== 'string' || !HEX_64.test(receiptHash))) return null
  const id = digest(without(node, 'id'))
  if (id === null || id !== node.id) return null
  return { id, text, recency, parents, receiptHash }
}

function linksOf(node: Record<string, unknown>): string[] | null {
  const parentIds = idList(node.parentIds)
  const parents = idList(node.parents)
  if (parentIds === 'bad' || parents === 'bad') return null
  if (parentIds !== null && parents !== null) {
    if (parentIds.length !== parents.length || parentIds.some((id, index) => id !== parents[index])) return null
    return parentIds
  }
  return parentIds ?? parents
}

function idList(value: unknown): string[] | null | 'bad' {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.length > 16) return 'bad'
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !HEX_64.test(item) || ids.includes(item)) return 'bad'
    ids.push(item)
  }
  return ids
}

function recencyOf(value: unknown): number | null | 'bad' {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) return 'bad'
    return value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 'bad'
  }
  return 'bad'
}

function boundedLimit(limit: number): number {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT || Object.is(limit, -0)) return 0
  return limit
}

function grams(text: string): Map<string, number> {
  const words = text.toLowerCase().split(/[^a-z0-9]+/u).filter(word => word.length >= 2)
  const weights = new Map<string, number>()
  for (let size = 1; size <= 3; size += 1) {
    for (let index = 0; index + size <= words.length; index += 1) {
      const gram = words.slice(index, index + size).join(' ')
      weights.set(gram, gram.includes(' ') ? 2 : 1)
    }
  }
  return weights
}

function termScore(terms: ReadonlyMap<string, number>, text: string): number {
  const haystack = grams(text)
  let score = 0
  for (const [gram, weight] of terms) if (haystack.has(gram)) score += weight
  return score
}

function digest(value: unknown): string | null {
  let text: string
  try {
    text = canonicalJson(value)
  } catch (error) {
    void error
    return null
  }
  if (typeof text !== 'string') return null
  return sha256Hex(new TextEncoder().encode(text))
}

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const name of Object.keys(record)) {
    if (name !== key) copy[name] = record[name]
  }
  return copy
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
