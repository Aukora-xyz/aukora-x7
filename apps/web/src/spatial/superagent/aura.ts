/**
 * Peripheral aura vector. Standing Law #4: this routes attention and does not
 * confer authority. `authorityTier` is always `peripheral-hint`.
 * A stored `aura.v1` object is compared, never trusted as the measurement.
 * Axes follow `server/aura-rules.mjs`; unknown sources stay explicit here.
 */
import { PERIPHERAL_HINT, canonicalJson, type PearlProjection } from './contract.ts'
import { sha256Hex, verifyReceiptChain } from './lineage.ts'

const HEX_64 = /^[0-9a-f]{64}$/
const AXIS_KINDS = ['high-surprise', 'dag-orphan', 'handoff-drift', 'stale-ticket', 'unanchored-claim', 'clean-state'] as const

/** Attention item. Codes only, no prose. */
export type AuraSalienceKind = typeof AXIS_KINDS[number]

/** Mechanical focus. Urgency is checked before drift. */
export type AuraFocus = 'escalate-to-owner' | 'verify' | 'observe' | 'consolidate' | 'rest'

/** How this vector relates to the facts. Not an independent audit. */
export type AuraStatus = 'recomputed-verified' | 'self-asserted-mismatch' | 'incomplete' | 'corrupt'

/** Display state only. Neither integrity nor peripheral attention grants authority. */
export type AuraDisplayStatus = 'calm' | 'attentive' | 'strained' | 'alert' | 'incomplete'

/** Maximum number of DAG nodes admitted by the browser evidence read. */
export const AURA_DAG_LIMIT = 256

export type AuraTrend = 'rising' | 'falling' | 'steady' | 'unknown'

/** One recomputed vector. Axes are null when a required source is missing. */
export interface AuraProjection {
  readonly schema: 'aukora.aura.v1'
  readonly scorer: 'rules-v1'
  readonly computedAt: number | null
  readonly ballId: string | null
  readonly epoch: number | null
  readonly authorityTier: typeof PERIPHERAL_HINT
  readonly selectionIsNotHealthProof: true
  readonly organCounts: 'declared-enabled-not-runtime-health'
  readonly auraStatus: AuraStatus
  readonly status: AuraDisplayStatus
  readonly coherence: number | null
  readonly surprisePressure: number | null
  readonly driftRisk: number | null
  readonly wakeUrgency: number | null
  readonly recommendedFocus: AuraFocus | null
  readonly salience: readonly { readonly kind: AuraSalienceKind; readonly score: number }[]
  readonly historyTrend: {
    readonly coherence: AuraTrend
    readonly surprisePressure: AuraTrend
    readonly driftRisk: AuraTrend
    readonly wakeUrgency: AuraTrend
    readonly provenance: 'history-not-authority'
  }
  readonly pearlChallenge: {
    readonly recomputedCount: number
    readonly payloadMatches: number
    readonly isolationProved: false
  }
  readonly gaps: readonly string[]
}

interface Facts {
  readonly reachable: number | null
  readonly declaredDag: number | null
  readonly verifiedReceipts: number | null
  readonly totalReceipts: number | null
  readonly activeOrgans: number | null
  readonly declaredOrgans: number | null
  readonly observations: readonly number[] | null
  readonly unanchored: number | null
  readonly pendingWakes: number | null
  readonly rollbackAge: number | null
  readonly rollbackKnown: boolean
  readonly handoffMismatch: boolean | null
  readonly staleHeartbeatRatio: number | null
  readonly staleTickets: number | null
  readonly orphans: number | null
  readonly ballId: string | null
  readonly epoch: number | null
  readonly computedAt: number | null
  readonly pearl: AuraProjection['pearlChallenge']
  readonly history: readonly unknown[] | null
  readonly gaps: string[]
  readonly nonfinite: boolean
}

/**
 * Recompute aura from mirror facts, receipt rows, and a HEAD object.
 * @param mirrorSnapshot - DAG nodes, handoff, wakes, tickets, stored aura, and history. Missing fields stay unknown.
 *   An optional `wake` (the `/_host/wake` view) folds an overdue enabled schedule into the pulse ratio, as the host does.
 * @param receipts - Raw `aukora.receipt.v3` rows. A non-array is corrupt.
 * @param head - Ball HEAD object.
 * @returns The recomputed vector. Stored axes never replace it.
 */
export function projectAura(mirrorSnapshot: unknown, receipts: unknown, head: unknown): AuraProjection {
  const facts = collect(mirrorSnapshot, receipts, head)
  if (facts.nonfinite) return vector(facts, 0, 1, 1, 'verify', 'corrupt', [])
  if (!complete(facts)) return vector(facts, null, null, null, null, facts.gaps.includes('corrupt') ? 'corrupt' : 'incomplete', [])
  const coherence = clamp01(
    ratio(facts.reachable, facts.declaredDag)
    * ratio(facts.verifiedReceipts, facts.totalReceipts)
    * ratio(facts.activeOrgans, facts.declaredOrgans),
  )
  const surprisePressure = surpriseOf(facts.observations)
  const driftRisk = driftOf(facts)
  const wakeUrgency = clamp01(Math.max(surprisePressure, driftRisk, facts.staleHeartbeatRatio ?? 0))
  if (!Number.isFinite(coherence) || !Number.isFinite(surprisePressure) || !Number.isFinite(driftRisk) || !Number.isFinite(wakeUrgency)) {
    return vector(facts, 0, 1, 1, 'verify', 'corrupt', [])
  }
  const focus = focusOf(coherence, surprisePressure, driftRisk, wakeUrgency)
  const salience = salienceOf(facts, surprisePressure)
  const status = storedStatus(mirrorSnapshot, facts, coherence, surprisePressure, driftRisk, wakeUrgency)
  return vector(facts, coherence, surprisePressure, driftRisk, focus, status, salience, wakeUrgency)
}

function collect(mirror: unknown, receipts: unknown, head: unknown): Facts {
  const gaps: string[] = []
  let nonfinite = false
  const headRecord = isRecord(head) ? head : null
  const ballId = headRecord !== null && typeof headRecord.ballId === 'string' && HEX_64.test(headRecord.ballId) ? headRecord.ballId : null
  const epoch = headRecord !== null && typeof headRecord.epoch === 'number' && Number.isSafeInteger(headRecord.epoch) && headRecord.epoch >= 0 && !Object.is(headRecord.epoch, -0)
    ? headRecord.epoch
    : null
  if (ballId === null || epoch === null) gaps.push('head')
  const organs = organsOf(headRecord)
  if (organs === null) gaps.push('organs')
  const receiptFacts = receiptsOf(receipts, ballId, epoch)
  if (receiptFacts === null) gaps.push('receipts')
  const mirrorRecord = isRecord(mirror) ? mirror : null
  if (mirror !== null && mirrorRecord === null) gaps.push('corrupt')
  if (Array.isArray(mirrorRecord?.evidenceGaps)) {
    for (const gap of mirrorRecord.evidenceGaps) {
      if (typeof gap === 'string' && /^[a-z-]{1,80}$/.test(gap)) gaps.push(gap)
    }
  }
  const dag = dagOf(mirrorRecord)
  if (dag === null) gaps.push('dag')
  const handoff = handoffOf(mirrorRecord, epoch, ballId)
  if (handoff === null) gaps.push('handoff')
  const observations = observationsOf(mirrorRecord, receiptFacts)
  if (observations === null) gaps.push('predictions')
  const unanchored = mirrorRecord === null ? null : countOrNull(mirrorRecord.unanchoredPredictions)
  if (unanchored === null) gaps.push('unanchored-predictions')
  if (typeof mirrorRecord?.unanchoredPredictions === 'number' && !Number.isFinite(mirrorRecord.unanchoredPredictions)) nonfinite = true
  const pendingWakes = mirrorRecord === null ? null : countOrNull(mirrorRecord.pendingWakes)
  if (pendingWakes === null) gaps.push('wakes')
  if (typeof mirrorRecord?.pendingWakes === 'number' && !Number.isFinite(mirrorRecord.pendingWakes)) nonfinite = true
  const rollback = rollbackOf(receiptFacts, epoch, mirrorRecord)
  if (!rollback.known) gaps.push('rollback')
  const assignmentStale = mirrorRecord === null ? null : finiteUnit(mirrorRecord.staleHeartbeatRatio)
  if (assignmentStale === null) gaps.push('heartbeat')
  if (typeof mirrorRecord?.staleHeartbeatRatio === 'number' && !Number.isFinite(mirrorRecord.staleHeartbeatRatio)) nonfinite = true
  const staleTickets = mirrorRecord === null ? null : countOrNull(mirrorRecord.staleTickets)
  if (staleTickets === null) gaps.push('tickets')
  const computedAt = mirrorRecord === null ? null : countOrNull(mirrorRecord.computedAt)
  if (computedAt === null || computedAt < 0) gaps.push('computedAt')
  // Wake metadata is optional input: when the caller passes it, an overdue enabled schedule is folded into the pulse ratio
  // exactly as the host reader does (server/aura-rules.mjs overdueWakeRatio); passed but unreadable is a gap.
  const overdue = mirrorRecord === null || mirrorRecord.wake === undefined || computedAt === null
    ? 0
    : overdueWakeRatio(mirrorRecord.wake, computedAt)
  if (overdue === null && !gaps.includes('wakes')) gaps.push('wakes')
  const staleHeartbeatRatio = assignmentStale === null ? null : Math.max(assignmentStale, overdue ?? 0)
  if (mirrorRecord !== null && Array.isArray(mirrorRecord.observationScores)) {
    for (const score of mirrorRecord.observationScores) {
      if (typeof score === 'number' && !Number.isFinite(score)) nonfinite = true
    }
  }
  return {
    reachable: dag?.reachable ?? null,
    declaredDag: dag?.declared ?? null,
    verifiedReceipts: receiptFacts?.verified ?? null,
    totalReceipts: receiptFacts?.total ?? null,
    activeOrgans: organs?.active ?? null,
    declaredOrgans: organs?.declared ?? null,
    observations,
    unanchored,
    pendingWakes,
    rollbackAge: rollback.age,
    rollbackKnown: rollback.known,
    handoffMismatch: handoff,
    staleHeartbeatRatio,
    staleTickets,
    orphans: dag?.orphans ?? null,
    ballId,
    epoch,
    computedAt: computedAt !== null && computedAt >= 0 ? computedAt : null,
    pearl: receiptFacts?.pearl ?? { recomputedCount: 0, payloadMatches: 0, isolationProved: false },
    history: historyCarrier(mirrorRecord),
    gaps,
    nonfinite,
  }
}

function complete(facts: Facts): boolean {
  return facts.gaps.length === 0 && facts.ballId !== null && facts.epoch !== null && facts.computedAt !== null
}

function vector(
  facts: Facts,
  coherence: number | null,
  surprisePressure: number | null,
  driftRisk: number | null,
  focus: AuraFocus | null,
  auraStatus: AuraStatus,
  salience: AuraProjection['salience'],
  wakeUrgency: number | null = null,
): AuraProjection {
  const history = historyOf(facts.history)
  return {
    schema: 'aukora.aura.v1',
    scorer: 'rules-v1',
    computedAt: facts.computedAt,
    ballId: facts.ballId,
    epoch: facts.epoch,
    authorityTier: PERIPHERAL_HINT,
    selectionIsNotHealthProof: true,
    organCounts: 'declared-enabled-not-runtime-health',
    auraStatus,
    status: displayStatus(auraStatus, coherence, surprisePressure, driftRisk,
      wakeUrgency ?? urgencyOrNull(coherence, surprisePressure, driftRisk, facts.staleHeartbeatRatio)),
    coherence,
    surprisePressure,
    driftRisk,
    wakeUrgency: wakeUrgency ?? urgencyOrNull(coherence, surprisePressure, driftRisk, facts.staleHeartbeatRatio),
    recommendedFocus: focus,
    salience,
    historyTrend: history,
    pearlChallenge: facts.pearl,
    gaps: facts.gaps,
  }
}

function surpriseOf(observations: readonly number[] | null): number {
  if (observations === null || observations.length === 0) return 0
  const recent = observations.slice(-5)
  const mean = recent.reduce((mean, score, index) => mean + (score - mean) / (index + 1), 0)
  return clamp01(Math.tanh(mean / 25))
}

function driftOf(facts: Facts): number {
  const handoff = facts.handoffMismatch === true ? 0.4 : 0
  const unanchored = (facts.unanchored ?? 0) > 0 ? 0.3 : 0
  const wakes = (facts.pendingWakes ?? 0) >= 2 ? 0.2 : 0
  const rollback = facts.rollbackAge !== null && facts.rollbackAge < 3 ? 0.1 : 0
  return clamp01(handoff + unanchored + wakes + rollback)
}

function focusOf(coherence: number, surprise: number, drift: number, urgency: number): AuraFocus {
  if (urgency >= 0.7) return 'escalate-to-owner'
  if (drift >= 0.4) return 'verify'
  if (surprise >= 0.3) return 'observe'
  if (coherence < 0.95) return 'consolidate'
  return 'rest'
}

/** rules-v1 salience (server/aura-rules.mjs rankSalience): best code per kind, top three, ties in kind order. */
function salienceOf(facts: Facts, surprise: number): AuraProjection['salience'] {
  const candidates: { kind: AuraSalienceKind; score: number }[] = []
  const add = (kind: AuraSalienceKind, score: number): void => { if (score > 0) candidates.push({ kind, score: clamp01(score) }) }
  add('high-surprise', surprise)
  add('dag-orphan', 1 - ratio(facts.reachable, facts.declaredDag))
  add('handoff-drift', facts.handoffMismatch === true ? 0.4 : 0)
  add('stale-ticket', facts.staleHeartbeatRatio ?? 0)
  add('stale-ticket', (facts.pendingWakes ?? 0) >= 2 ? 0.2 : 0)
  add('stale-ticket', facts.rollbackAge !== null && facts.rollbackAge < 3 ? 0.1 : 0)
  add('stale-ticket', 1 - ratio(facts.activeOrgans, facts.declaredOrgans))
  add('unanchored-claim', (facts.unanchored ?? 0) > 0 ? 0.3 : 0)
  add('unanchored-claim', 1 - ratio(facts.verifiedReceipts, facts.totalReceipts))
  if (candidates.length === 0) add('clean-state', 1)
  candidates.sort((left, right) => right.score - left.score || AXIS_KINDS.indexOf(left.kind) - AXIS_KINDS.indexOf(right.kind))
  const selected: { kind: AuraSalienceKind; score: number }[] = []
  for (const candidate of candidates) {
    if (!selected.some(item => item.kind === candidate.kind)) selected.push(candidate)
    if (selected.length === 3) break
  }
  return selected
}

function storedStatus(
  mirror: unknown,
  facts: Facts,
  coherence: number,
  surprise: number,
  drift: number,
  urgency: number,
): AuraStatus {
  const stored = isRecord(mirror) ? mirror.storedAura : undefined
  if (stored === undefined || stored === null) return 'recomputed-verified'
  if (!storedValid(stored, facts.ballId, facts.epoch)) return 'self-asserted-mismatch'
  const storedAxes = isRecord(stored) && isRecord(stored.vector) ? stored.vector : stored
  const axes: readonly [number, unknown][] = [
    [coherence, isRecord(storedAxes) ? storedAxes.coherence : null],
    [surprise, isRecord(storedAxes) ? storedAxes.surprisePressure : null],
    [drift, isRecord(storedAxes) ? storedAxes.driftRisk : null],
    [urgency, isRecord(storedAxes) ? storedAxes.wakeUrgency : null],
  ]
  for (const [ours, theirs] of axes) {
    if (typeof theirs !== 'number' || !Number.isFinite(theirs) || Math.abs(ours - theirs) > 0.01) return 'self-asserted-mismatch'
  }
  return 'recomputed-verified'
}

function storedValid(stored: unknown, ballId: string | null, epoch: number | null): boolean {
  if (!isRecord(stored)) return false
  if (stored.schema !== 'aukora.aura.v1' || stored.scorer !== 'rules-v1') return false
  if (stored.authorityTier !== PERIPHERAL_HINT) return false
  if (typeof stored.ballId !== 'string' || stored.ballId !== ballId) return false
  if (stored.epoch !== epoch) return false
  return true
}

function historyOf(rows: readonly unknown[] | null): AuraProjection['historyTrend'] {
  const unknown: AuraProjection['historyTrend'] = {
    coherence: 'unknown', surprisePressure: 'unknown', driftRisk: 'unknown', wakeUrgency: 'unknown', provenance: 'history-not-authority',
  }
  if (rows === null) return unknown
  const parsed = rows.flatMap((row) => {
    if (!isRecord(row)) return []
    const coherence = row.coherence
    const surprisePressure = row.surprisePressure
    const driftRisk = row.driftRisk
    const wakeUrgency = row.wakeUrgency
    if (typeof coherence !== 'number' || typeof surprisePressure !== 'number' || typeof driftRisk !== 'number' || typeof wakeUrgency !== 'number') return []
    if (![coherence, surprisePressure, driftRisk, wakeUrgency].every(Number.isFinite)) return []
    return [{ coherence, surprisePressure, driftRisk, wakeUrgency }]
  })
  return {
    coherence: trend(parsed.map(row => row.coherence)),
    surprisePressure: trend(parsed.map(row => row.surprisePressure)),
    driftRisk: trend(parsed.map(row => row.driftRisk)),
    wakeUrgency: trend(parsed.map(row => row.wakeUrgency)),
    provenance: 'history-not-authority',
  }
}

function trend(values: readonly number[]): AuraTrend {
  if (values.length < 2) return 'unknown'
  const previous = values[values.length - 2] ?? Number.NaN
  const last = values[values.length - 1] ?? Number.NaN
  if (!Number.isFinite(previous) || !Number.isFinite(last)) return 'unknown'
  if (last > previous + 0.01) return 'rising'
  if (last < previous - 0.01) return 'falling'
  return 'steady'
}

function receiptsOf(receipts: unknown, ballId: string | null, epoch: number | null): {
  verified: number
  total: number
  observations: number[]
  pearl: AuraProjection['pearlChallenge']
  rollbackEpoch: number | null
} | null {
  if (!Array.isArray(receipts)) return null
  const chain = verifyReceiptChain(receipts)
  const verified = chain.status === 'verified'
  if (!verified) return null
  let matches = 0
  let challenges = 0
  let rollbackEpoch: number | null = null
  const observations: number[] = []
  const rows = verified ? chain.receipts : []
  for (const row of rows) {
    if (row.kind === 'pearl.challenge') {
      challenges += 1
      const data = row.data
      const candidates = Array.isArray(data.candidates) ? data.candidates.length : 0
      const headOk = data.ballId === ballId || data.headBallId === ballId
      if (headOk && candidates >= 2 && isRecord(data.results)) matches += 1
    }
    if (row.kind === 'tree.undo' || row.kind === 'snapshot.restore') {
      const rollback = countOrNull(row.data.epoch)
      if (rollback === null || epoch === null || rollback > epoch) return null
      rollbackEpoch = rollback
    }
    if (row.kind === 'prediction.observe' && !('surpriseScore' in row.data)) {
      const expected = row.data.expected
      const observed = row.data.observed
      if (typeof expected === 'number' && typeof observed === 'number' && Number.isFinite(expected) && Number.isFinite(observed)) {
        const delta = Math.abs(observed - expected)
        observations.push(delta === 0 ? 0 : delta / Math.max(Math.abs(expected), 1))
      }
    }
  }
  return {
    verified: verified ? receipts.length : 0,
    total: receipts.length,
    observations,
    pearl: { recomputedCount: challenges, payloadMatches: matches, isolationProved: false },
    rollbackEpoch,
  }
}

function rollbackOf(
  receipts: ReturnType<typeof receiptsOf>,
  epoch: number | null,
  mirror: Record<string, unknown> | null,
): { known: boolean; age: number | null } {
  if (mirror !== null && mirror.lastRollbackAgeEpochs !== undefined) {
    const age = countOrNull(mirror.lastRollbackAgeEpochs)
    if (age !== null) return { known: true, age }
    return { known: false, age: null }
  }
  if (receipts === null || epoch === null) return { known: false, age: null }
  if (receipts.rollbackEpoch === null) return { known: true, age: null }
  return { known: true, age: epoch - receipts.rollbackEpoch }
}

function dagOf(mirror: Record<string, unknown> | null): { reachable: number; declared: number; orphans: number } | null {
  if (mirror === null || !Array.isArray(mirror.dagNodes) || !isRecord(mirror.dagHead)) return null
  const declared = mirror.dagHead.count
  const heads = auraDagHeads(mirror.dagHead)
  if (heads === null || typeof declared !== 'number' || mirror.dagNodes.length !== declared) return null
  const byId = new Map<string, string[]>()
  for (const item of mirror.dagNodes) {
    if (!isRecord(item) || typeof item.id !== 'string' || byId.has(item.id)) return null
    const links = auraDagParents(item, item.id)
    if (links === null) return null
    byId.set(item.id, links)
  }
  const reachable = new Set<string>()
  const walk = (id: string, visiting: Set<string>): boolean => {
    if (visiting.has(id)) return false
    if (reachable.has(id)) return true
    const parents = byId.get(id)
    if (parents === undefined) return false
    visiting.add(id)
    let ok = true
    for (const parent of parents) if (!walk(parent, visiting)) ok = false
    visiting.delete(id)
    if (!ok) return false
    reachable.add(id)
    return true
  }
  for (const head of heads) if (!walk(head, new Set())) return null
  for (const parents of byId.values()) if (parents.some(id => !byId.has(id))) return null
  return { reachable: reachable.size, declared, orphans: [...byId.keys()].filter(id => !reachable.has(id)).length }
}

function organsOf(head: Record<string, unknown> | null): { active: number; declared: number } | null {
  if (head === null || !isRecord(head.entries)) return null
  const entries = Object.values(head.entries)
  if (entries.length > 256 || entries.some(entry => !isRecord(entry) || (entry.disabled !== undefined && typeof entry.disabled !== 'boolean'))) return null
  const active = entries.filter(entry => isRecord(entry) && entry.disabled !== true).length
  return { active, declared: entries.length }
}

/**
 * Whether HANDOFF.md names another Pearl than HEAD (true), the same one (false), or none it can read (null).
 * Round 21, tolerant of how Auma writes the table, never of garbage: the epoch is a bold number in its cell
 * (`| epoch | **57** |`, also `| **epoch** | **57** |`), and the ballId is 8 to 64 hex characters in backticks
 * (`| ballId | \`8c1f5e34f013…\` |`), compared as a prefix of HEAD's id. A note after either cell, such as
 * `(22 entries)`, is ignored. The label must be the whole first cell of its row, so a `parentBallId`, `headEpoch` or
 * `previous ballId` row is never read as these.
 * @param mirror - The mirror read, with `handoffText`.
 * @param epoch - HEAD's epoch.
 * @param ballId - HEAD's 64-hex ballId.
 * @returns The mismatch flag, or null when either side is not read.
 */
export function handoffOf(mirror: Record<string, unknown> | null, epoch: number | null, ballId: string | null): boolean | null {
  if (mirror === null || typeof mirror.handoffText !== 'string') return null
  const epochMatch = /^\s*\|\s*\**epoch\**\s*\|\s*\*\*(\d+)\*\*/im.exec(mirror.handoffText)
  const ballMatch = /^\s*\|\s*\**ballId\**\s*\|\s*`([0-9a-f]{8,64})(?:…|\.{3})?`/im.exec(mirror.handoffText)
  if (epochMatch === null || ballMatch === null || epoch === null || ballId === null) return null
  const textEpoch = Number(epochMatch[1])
  const written = (ballMatch[1] ?? '').toLowerCase()
  const head = ballId.toLowerCase()
  return textEpoch !== epoch || (written.length === 64 ? written !== head : !head.startsWith(written))
}

function observationsOf(mirror: Record<string, unknown> | null, receipts: ReturnType<typeof receiptsOf>): number[] | null {
  if (mirror !== null && Array.isArray(mirror.observationScores)) {
    const scores: number[] = []
    for (const score of mirror.observationScores) {
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || Object.is(score, -0)) return null
      scores.push(score)
    }
    return scores
  }
  if (receipts === null) return null
  return receipts.observations
}

function historyCarrier(mirror: Record<string, unknown> | null): readonly unknown[] | null {
  if (mirror === null || mirror.history === undefined) return null
  return Array.isArray(mirror.history) ? mirror.history : null
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

/**
 * Validate bounded HEAD references before any path is constructed.
 * @param head - Parsed DAG HEAD file.
 * @returns Unique hash references, or null for an incomplete/invalid HEAD.
 */
export function auraDagHeads(head: unknown): string[] | null {
  if (!isRecord(head)) return null
  const count = countOrNull(head.count)
  const heads = idList(head.heads)
  if (count === null || count > AURA_DAG_LIMIT || heads === null || heads === 'bad') return null
  if (heads.length > count || (count > 0 && heads.length === 0) || new Set(heads).size !== heads.length) return null
  return heads
}

/**
 * Recompute a node identity before following its parent references.
 * @param node - Parsed node file.
 * @param expectedId - Validated filename identifier.
 * @returns Validated parents, or null. Hash integrity is not owner authority.
 */
export function auraDagParents(node: unknown, expectedId: string): string[] | null {
  if (!HEX_64.test(expectedId) || !isRecord(node) || node.id !== expectedId || digest(without(node, 'id')) !== expectedId) return null
  const parents = linksOf(node)
  if (parents === null || parents.length > AURA_DAG_LIMIT
    || new Set(parents).size !== parents.length || parents.includes(expectedId)) return null
  return parents
}

function displayStatus(
  status: AuraStatus, coherence: number | null, surprise: number | null, drift: number | null, urgency: number | null,
): AuraDisplayStatus {
  if (status !== 'recomputed-verified' || coherence === null || surprise === null || drift === null || urgency === null) return 'incomplete'
  if (urgency >= 0.7) return 'alert'
  if (drift >= 0.4 || coherence < 0.7) return 'strained'
  if (surprise >= 0.3 || coherence < 0.95 || urgency > 0) return 'attentive'
  return 'calm'
}

/**
 * Project recorded Pearl claims without treating executable case definitions as results.
 * A result must name every case exactly once and bind the canonical suite digest and selected HEAD.
 * @param suite - Complete parsed retention suite with uniquely identified `cases`.
 * @param scars - Complete JSONL scar records.
 * @param receipts - Complete receipt chain, never organ verification flags.
 * @param head - Selected ball identity and epoch.
 * @returns Nullable self-attested counts. Worker isolation is never proved by these files.
 */
export function projectPearl(suite: unknown, scars: unknown, receipts: unknown, head: unknown): PearlProjection {
  const gaps: string[] = []
  const cases = isRecord(suite) && Array.isArray(suite.cases) && suite.cases.length <= 5000 ? suite.cases : null
  const ids = cases === null ? null : cases.map(item => isRecord(item) && typeof item.id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(item.id) ? item.id : null)
  const suiteValid = ids !== null && ids.every(id => id !== null) && new Set(ids).size === ids.length
  const retentionTotal = suiteValid && cases !== null ? cases.length : null
  if (retentionTotal === null) gaps.push('retention-suite')
  const scarsCount = Array.isArray(scars) && scars.length <= 5000 && scars.every(isRecord) ? scars.length : null
  if (scarsCount === null) gaps.push('scars')
  const chain = Array.isArray(receipts) ? verifyReceiptChain(receipts) : null
  const rows = chain?.status === 'verified' ? chain.receipts : null
  if (rows === null) gaps.push('receipts')
  const latest = rows?.filter(row => row.kind === 'pearl.challenge').at(-1)
  const data = latest?.data
  const bound = data !== undefined && isRecord(head) && typeof head.ballId === 'string' && HEX_64.test(head.ballId)
    && countOrNull(head.epoch) !== null && countOrNull(data.epoch ?? data.headEpoch) !== null
    && (data.ballId === undefined || data.headBallId === undefined || data.ballId === data.headBallId)
    && (data.epoch === undefined || data.headEpoch === undefined || data.epoch === data.headEpoch)
    && (data.ballId ?? data.headBallId) === head.ballId && (data.epoch ?? data.headEpoch) === head.epoch
  const label = bound && typeof data.winnerLabel === 'string' && /^[A-Za-z0-9 ._:#()/-]{1,64}$/.test(data.winnerLabel) ? data.winnerLabel : null
  const candidateValues: readonly unknown[] | null = bound && Array.isArray(data.candidates)
    && data.candidates.length >= 2 && data.candidates.length <= 100 ? data.candidates : null
  const candidates = candidateValues !== null && candidateValues.every(pearlCandidate) ? candidateValues : null
  const candidateLabels = candidates?.map(candidate => candidate.label)
  const winner = candidates?.find(candidate => candidate.label === label)
  const uniqueCandidates = candidateLabels !== undefined && new Set(candidateLabels).size === candidateLabels.length
  const winnerValid = label !== null && winner !== undefined && uniqueCandidates
  const results = winnerValid && data !== undefined ? (winner.retentionResults ?? data.retentionResults) : null
  let retentionPassed: number | null = null
  if (retentionTotal !== null && ids !== null && typeof data?.retentionSuiteHash === 'string' && suiteDigests(suite).has(data.retentionSuiteHash)
    && Array.isArray(results) && results.length === retentionTotal) {
    const seen = new Set<string>()
    let passed = 0
    for (const result of results) {
      if (!isRecord(result) || typeof result.id !== 'string' || !ids.includes(result.id) || seen.has(result.id)) break
      const pass = result.pass ?? result.passed
      if (typeof pass !== 'boolean' || (result.pass !== undefined && result.passed !== undefined && result.pass !== result.passed)) break
      seen.add(result.id)
      if (pass) passed += 1
    }
    if (seen.size === retentionTotal) retentionPassed = passed
  }
  if (retentionPassed === null) gaps.push('retention-results')
  if (!bound || !winnerValid) gaps.push('challenge')
  const duration = winnerValid && data !== undefined ? (winner.durationMs ?? data.durationMs) : null
  const candidateCount = uniqueCandidates && candidates !== null ? candidates.length : null
  const tournament = bound && data !== undefined ? coarseToFine(data, candidateCount) : NO_TOURNAMENT
  return {
    retentionTotal, retentionPassed, scarsCount,
    lastChallengeAt: bound && latest !== undefined ? latest.at : null,
    lastWinnerLabel: winnerValid ? label : null,
    candidateCount,
    durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && !Object.is(duration, -0) ? duration : null,
    ...tournament,
    authorityTier: 'self-attested', status: gaps.length === 0 ? 'complete' : 'incomplete', isolationProved: false, gaps,
  }
}

const NO_TOURNAMENT = { candidatesTested: null, coarsePassCount: null, finePassCount: null, negativeControlRejected: null } as const

/**
 * Coarse-to-fine counts as her bound challenge receipt records them (self-attested). Tested must be 1..100 and equal
 * the candidate list when one is recorded; coarse passes cannot exceed tested, nor fine passes coarse. Any
 * inconsistency drops all three counts; the negative-control flag stands alone and is kept only as a boolean.
 */
function coarseToFine(data: Record<string, unknown>, candidateCount: number | null): {
  readonly candidatesTested: number | null
  readonly coarsePassCount: number | null
  readonly finePassCount: number | null
  readonly negativeControlRejected: boolean | null
} {
  const tested = countOrNull(data.candidatesTested), coarse = countOrNull(data.coarsePassCount), fine = countOrNull(data.finePassCount)
  const consistent = tested !== null && tested >= 1 && tested <= 100 && (candidateCount === null || tested === candidateCount)
    && (coarse === null || coarse <= tested) && (fine === null || (coarse !== null && fine <= coarse))
  const control = data.negativeControlRejected
  return {
    candidatesTested: consistent ? tested : null,
    coarsePassCount: consistent ? coarse : null,
    finePassCount: consistent ? fine : null,
    negativeControlRejected: typeof control === 'boolean' ? control : null,
  }
}

function pearlCandidate(value: unknown): value is Record<string, unknown> & { label: string } {
  return isRecord(value) && typeof value.label === 'string'
}

function idList(value: unknown): string[] | null | 'bad' {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.length > AURA_DAG_LIMIT) return 'bad'
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !HEX_64.test(item)) return 'bad'
    ids.push(item)
  }
  return ids
}

/**
 * How late an enabled wake schedule is, as a fraction of its interval. Mirrors `server/aura-rules.mjs` overdueWakeRatio:
 * disabled is 0, `scheduleStatus: 'alarm_missing'` is 1, otherwise (now - nextWakeAt) / intervalMs clamped to [0, 1].
 * @param wake - The `/_host/wake` view.
 * @param now - Reader clock in milliseconds.
 * @returns The ratio, or null when an enabled schedule's interval or next wake time is not a finite number.
 */
export function overdueWakeRatio(wake: unknown, now: number): number | null {
  if (!isRecord(wake) || typeof wake.enabled !== 'boolean' || !Number.isFinite(now) || now < 0) return null
  if (!wake.enabled) return 0
  if (wake.scheduleStatus === 'alarm_missing') return 1
  const { intervalMs, nextWakeAt } = wake
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0
    || typeof nextWakeAt !== 'number' || !Number.isFinite(nextWakeAt) || nextWakeAt < 0) return null
  return Math.max(0, Math.min(1, (now - nextWakeAt) / intervalMs))
}

function ratio(part: number | null, whole: number | null): number {
  return (part ?? 0) / Math.max(whole ?? 0, 1)
}

function urgencyOrNull(
  coherence: number | null,
  surprise: number | null,
  drift: number | null,
  stale: number | null,
): number | null {
  if (coherence === null) return null
  return clamp01(Math.max(surprise ?? 0, drift ?? 0, stale ?? 0))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || Object.is(value, -0)) return 0
  return Math.min(1, Math.max(0, value))
}

function countOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) return null
  return value
}

function finiteUnit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1 || Object.is(value, -0)) return null
  return value
}

/** The suite fields that execute: staging fields (`pendingCases`, `note`) run nothing. */
const EXECUTABLE_SUITE_KEYS = ['schema', 'harness', 'organs', 'fixedNow', 'cases', 'fixtures'] as const

/**
 * The digests a recorded result may name for this suite (Round 21): the whole file, the file without its staged
 * `pendingCases` (what seed-pearl recorded before cases were staged), and the executable fields alone. Staging a
 * pending case runs nothing, so it never invalidates a result; the results must still cover exactly the active cases.
 * @param suite - The parsed retention suite.
 * @returns Every digest that names this suite's executing content.
 */
export function suiteDigests(suite: unknown): ReadonlySet<string> {
  const digests = new Set<string>()
  const add = (value: unknown): void => { const hash = digest(value); if (hash !== null) digests.add(hash) }
  add(suite)
  if (isRecord(suite)) {
    if (Object.hasOwn(suite, 'pendingCases')) add(without(suite, 'pendingCases'))
    // As the runtime builds it (scion-growth.ts): all six keys, a missing one as null.
    const executable: Record<string, unknown> = {}
    for (const key of EXECUTABLE_SUITE_KEYS) executable[key] = suite[key] ?? null
    add(executable)
  }
  return digests
}

function digest(value: unknown): string | null {
  try {
    const text = canonicalJson(value)
    if (typeof text !== 'string') return null
    return sha256Hex(new TextEncoder().encode(text))
  } catch (error) {
    void error
    return null
  }
}

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const name of Object.keys(record)) if (name !== key) copy[name] = record[name]
  return copy
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function auraHistoryTrend(rows: readonly unknown[] | null): AuraProjection['historyTrend'] {
  return historyOf(rows)
}
