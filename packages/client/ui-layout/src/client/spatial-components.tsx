// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PERIPHERY, ON SCREEN (Round 14, North Star §14): the `aura.v1` strip on the Aura Coherence and Work surfaces.
 *
 *   Four bars        coherence, surprise pressure, drift risk, wake urgency (each in [0, 1]), with a rising / falling /
 *                    steady arrow each.
 *   Salience         the top three attention items (machine codes only), as pills.
 *   Focus            her `recommendedFocus`, as a badge.
 *   No authority     PERIPHERAL HINT · NO AUTHORITY, always (Standing Law #4): the periphery routes attention and never
 *                    confers authority. A vector that claims any other `authorityTier` is said to claim it, and is
 *                    still shown as a hint only.
 *
 * WHERE THE NUMBERS COME FROM, said on the strip:
 *   RECOMPUTED · VERIFIED     the reader (`superagent/aura.ts` `projectAura`, carried on the readout as
 *                             `snapshot.aura`) recomputed the vector from her verified files and it matched her file.
 *   SELF-ASSERTED · MISMATCH  the reader recomputed it and her file differs by more than 0.01 on some axis: the bars
 *                             show the RECOMPUTED values, and her file's numbers are shown beside them.
 *   SELF-ASSERTED             only her own `/dsh/home/auma/seed/aura.v1.json` was read (no reader projection yet): her
 *                             word, labelled as such, and it never moves the Pentora (see `spatial-pentora.tsx`).
 * UNDETERMINED (Round 15, Standing Law #4): until an independent reader has recomputed a vector, the strip says
 * UNDETERMINED · EVIDENCE INCOMPLETE. Then no bar is filled, no focus, salience or state word is shown, and the Pentora
 * stays neutral; her own numbers, if her file has any, are listed as her file's words only.
 *
 * PEARL (Round 15, North Star §15): beside the strip, a read-only card for her Imagination Arena (`seed-pearl`): the
 * lineage retention suite, the scars engraved into the acceptance gate, and the latest isolated worker trial. From the
 * readout's `pearl` summary when it carries one (self-attested: derived from her files and `pearl.challenge`
 * receipts, not re-run here), else counted from her own files, else NOT SEEDED YET. It grants nothing.
 *
 * The reader's projection is taken only from a FRESH readout whose receipts verified; a stale, failed or rejected read
 * shows her file again (self-asserted), and the projection never outlives its session. Under a recomputed pill the
 * trend arrows come only from the reader; her own `aura/history.v1.jsonl` gives arrows only beside her own numbers.
 * The recomputed vector is read only from the projection's `recomputed` field, never from `vector` (her own field).
 *
 * @module spatial-components
 */
import { useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  FieldTable, Lead, PortalButton, PortalCell, PortalGrid, RecordList, RecordRow, StatusPill, type IconName, type Tone,
} from './spatial/primitives/index.ts'
import { touchesHer, useDebounced, useLiveEvents } from './spatial/work/autonomy.ts'
import { workBridge, type BridgePhase } from './spatial/work/bridge.ts'
import type { FileRead, WorkReader } from './spatial/work/WorkSurface.tsx'
import type { AuraAxes } from './spatial-pentora.tsx'
import './spatial-shell.css'

/** Her periphery's latest vector and its history. */
export const AURA_PATH = '/dsh/home/auma/seed/aura.v1.json'
export const AURA_HISTORY_PATH = '/dsh/home/auma/seed/aura/history.v1.jsonl'
export const AURA_SCHEMA = 'aukora.aura.v1'
export const PERIPHERAL_HINT = 'peripheral-hint'

export const AXES = ['coherence', 'surprisePressure', 'driftRisk', 'wakeUrgency'] as const
export type AuraAxis = typeof AXES[number]
export const AXIS_NAMES: Readonly<Record<AuraAxis, string>> = {
  coherence: 'Coherence',
  surprisePressure: 'Surprise Pressure',
  driftRisk: 'Drift Risk',
  wakeUrgency: 'Wake Urgency',
}
export type Trend = 'rising' | 'falling' | 'steady'
export const FOCI = ['verify', 'observe', 'consolidate', 'rest', 'escalate-to-owner'] as const
export type AuraFocus = typeof FOCI[number]

export interface AuraSalience { readonly kind: string; readonly targetId: string; readonly score: number; readonly code: string }

/** One parsed `aura.v1` vector. */
export interface AuraVector {
  readonly axes: AuraAxes
  readonly salience: readonly AuraSalience[]
  readonly focus: AuraFocus | null
  /** What the vector itself claims as its tier; anything but `peripheral-hint` is flagged, never honoured. */
  readonly claimedTier: string | null
  readonly epoch: number | null
  readonly ballId: string | null
  readonly computedAt: number | null
}

export type AuraSource = 'recomputed-verified' | 'self-asserted-mismatch' | 'self-asserted'

/** What the strip shows. */
export interface AuraView {
  readonly source: AuraSource
  /** The bars: the recomputed vector when there is one, else her file's. */
  readonly shown: AuraVector
  /** Her file's vector, when it differs from what is shown (a mismatch). */
  readonly stored: AuraVector | null
  readonly trends: Readonly<Record<AuraAxis, Trend | null>> | null
  readonly trendSource: 'readout' | 'her-history' | null
  /** The tier her own file claims, when the bars show the recomputed vector (her file is not what is shown). */
  readonly herClaimedTier: string | null
  /** The readout's state word for a recomputed vector (`calm` … `alert`); never for her own file. */
  readonly state: AuraState | null
}

export const AURA_STATES = ['calm', 'attentive', 'strained', 'alert'] as const
export type AuraState = typeof AURA_STATES[number]

/** The independent reader ran but could not recompute: what it lacked, or that her inputs were corrupt. */
export interface ReaderNote { readonly status: 'incomplete' | 'corrupt'; readonly gaps: readonly string[] }

export type AuraRead = (
  | { readonly kind: 'reading' }
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly detail: string }
  | { readonly kind: 'unreadable'; readonly detail: string }
  | { readonly kind: 'ok'; readonly view: AuraView }
) & { readonly readerNote?: ReaderNote | undefined; readonly pearl?: PearlRead | undefined }

type Json = Record<string, unknown>
const isJson = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)
const unit = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null)
/** Salience is machine words only: a kind, a code and a target id within these shapes, or the item is dropped. */
const KIND = /^[a-z][a-z0-9-]{0,31}$/
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,47}$/
const TARGET = /^[A-Za-z0-9._:-]{1,80}$/

/** The four axes, when every one is a finite number in [0, 1]; else null. */
export function axesOf(value: unknown): AuraAxes | null {
  if (!isJson(value)) return null
  const source = isJson(value.vector) ? value.vector : value
  const coherence = unit(source.coherence)
  const surprisePressure = unit(source.surprisePressure)
  const driftRisk = unit(source.driftRisk)
  const wakeUrgency = unit(source.wakeUrgency)
  if (coherence === null || surprisePressure === null || driftRisk === null || wakeUrgency === null) return null
  return { coherence, surprisePressure, driftRisk, wakeUrgency }
}

/**
 * Parse an `aura.v1` vector. Strict about the numbers (all four axes finite in [0, 1]) and the schema; salience is
 * kept to its first three well-formed items, highest score first.
 */
export function parseAuraVector(value: unknown): AuraVector | null {
  if (!isJson(value) || value.schema !== AURA_SCHEMA) return null
  const axes = axesOf(value)
  if (axes === null) return null
  const salience = (Array.isArray(value.salience) ? value.salience : [])
    .filter(isJson)
    .map((s): AuraSalience | null => {
      const score = unit(s.score)
      const code = s.code === undefined ? '' : typeof s.code === 'string' && CODE.test(s.code) ? s.code : null
      return typeof s.kind === 'string' && KIND.test(s.kind) && code !== null && score !== null
        ? { kind: s.kind, targetId: typeof s.targetId === 'string' && TARGET.test(s.targetId) ? s.targetId : '', score, code }
        : null
    })
    .filter((s): s is AuraSalience => s !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  const focus = FOCI.find(f => f === value.recommendedFocus) ?? null
  return {
    axes,
    salience,
    focus,
    claimedTier: typeof value.authorityTier === 'string' ? value.authorityTier : null,
    epoch: typeof value.epoch === 'number' && Number.isSafeInteger(value.epoch) && value.epoch >= 0 ? value.epoch : null,
    ballId: typeof value.ballId === 'string' && /^[0-9a-f]{64}$/.test(value.ballId) ? value.ballId : null,
    computedAt: typeof value.computedAt === 'number' && Number.isFinite(value.computedAt) ? value.computedAt : null,
  }
}

/** A trend from a series, oldest first: the last value against the one four steps back (or the first), ±0.02. */
export function trendOf(series: readonly number[]): Trend | null {
  if (series.length < 2) return null
  const last = series[series.length - 1] ?? 0
  const before = series[Math.max(0, series.length - 5)] ?? last
  const delta = last - before
  return delta > 0.02 ? 'rising' : delta < -0.02 ? 'falling' : 'steady'
}

/** Per-axis trends over her history file (the last 16 valid vectors); null with fewer than two. */
export function trendsFromHistory(text: string): Readonly<Record<AuraAxis, Trend>> | null {
  const vectors = text.split('\n')
    .filter(line => line.trim() !== '')
    .map((line) => { try { return axesOf(JSON.parse(line) as unknown) } catch { return null } })
    .filter((a): a is AuraAxes => a !== null)
    .slice(-16)
  if (vectors.length < 2) return null
  const out = {} as Record<AuraAxis, Trend>
  for (const axis of AXES) out[axis] = trendOf(vectors.map(v => v[axis])) ?? 'steady'
  return out
}

const TRENDS: readonly Trend[] = ['rising', 'falling', 'steady']
/** Per-axis trends from the reader; an axis it marks `unknown` (or anything else) gets no arrow. */
function trendsOf(value: unknown): Readonly<Record<AuraAxis, Trend | null>> | null {
  if (!isJson(value)) return null
  const out = {} as Record<AuraAxis, Trend | null>
  for (const axis of AXES) {
    const each = value[axis]
    out[axis] = TRENDS.find(t => t === each || (isJson(each) && t === each.trend)) ?? null
  }
  return AXES.some(axis => out[axis] !== null) ? out : null
}

const bareVector = (axes: AuraAxes, claimedTier: string | null): AuraVector =>
  ({ axes, salience: [], focus: null, claimedTier, epoch: null, ballId: null, computedAt: null })

/** A whole aura.v1 vector, or bare axes (with no tier of their own). */
const vectorOrAxes = (value: unknown, bareTier: string | null): AuraVector | null => {
  const whole = parseAuraVector(value)
  if (whole !== null) return whole
  const axes = axesOf(value)
  return axes === null ? null : bareVector(axes, bareTier)
}

/** What the reader's projection says, once parsed. */
export type ParsedProjection =
  | {
    readonly kind: 'projected'
    readonly source: Exclude<AuraSource, 'self-asserted'>
    readonly shown: AuraVector
    readonly stored: AuraVector | null
    readonly trends: AuraView['trends']
    readonly trendSource: AuraView['trendSource']
    readonly state: AuraState | null
  }
  | { readonly kind: 'unrecomputable'; readonly note: ReaderNote }

/**
 * The recomputed vector: an explicit `recomputed` object, or the flat `AuraProjection` (`superagent/aura.ts`: the
 * axes at the top level beside its `gaps` list, and no nested `vector`). Her own aura.v1 keeps its axes under
 * `vector`, so pasting a status onto her file can never make it read as recomputed.
 */
function recomputedOf(value: Json): AuraVector | null {
  if (value.recomputed !== undefined) return vectorOrAxes(value.recomputed, PERIPHERAL_HINT)
  if (value.vector !== undefined || !Array.isArray(value.gaps)) return null
  const axes = axesOf(value)
  if (axes === null) return null
  const parsed = parseAuraVector({ ...value, schema: AURA_SCHEMA, vector: axes })
  return parsed === null ? bareVector(axes, PERIPHERAL_HINT) : { ...parsed, claimedTier: PERIPHERAL_HINT }
}

/**
 * The projection, as the readout carries it (`snapshot.aura`, `superagent/aura.ts` `projectAura`):
 *   recomputed-verified / self-asserted-mismatch   a recomputed vector (see `recomputedOf`); her file's numbers, for a
 *                                                  mismatch, under `stored`, `selfAsserted` or `selfAssertedVector`
 *   incomplete / corrupt                           the reader could not recompute; its `gaps` say why
 *   not-evaluated, or anything else                nothing
 * Its `historyTrend` is computed over HER history file, so those arrows are labelled as her history's.
 */
export function parseAuraProjection(value: unknown): ParsedProjection | null {
  if (!isJson(value)) return null
  // Either field may refuse: `corrupt` anywhere, or `incomplete` anywhere — except that a display status of
  // `incomplete` beside an explicit mismatch stays a mismatch (a mismatch is only reported after a complete recompute,
  // and the strip shows it as such, never as calm).
  const flags = [value.auraStatus, value.status]
  const mismatch = value.auraStatus === 'self-asserted-mismatch'
  const veto = flags.find(f => f === 'corrupt')
    ?? (value.auraStatus === 'incomplete' || (!mismatch && value.status === 'incomplete') ? 'incomplete' : undefined)
  const status = veto ?? value.auraStatus ?? value.status
  if (status === 'incomplete' || status === 'corrupt') {
    const gaps = Array.isArray(value.gaps) ? value.gaps.filter((g): g is string => typeof g === 'string' && KIND.test(g)) : []
    return { kind: 'unrecomputable', note: { status, gaps } }
  }
  if (status !== 'recomputed-verified' && status !== 'self-asserted-mismatch') return null
  const recomputed = recomputedOf(value)
  if (recomputed === null) return null
  const stored = vectorOrAxes(value.stored ?? value.selfAsserted ?? value.selfAssertedVector, null)
  const readerTrends = trendsOf(value.trend ?? value.trends)
  const historyTrends = readerTrends === null ? trendsOf(value.historyTrend) : null
  return {
    kind: 'projected',
    source: status,
    shown: recomputed,
    stored: status === 'self-asserted-mismatch' ? stored : null,
    trends: readerTrends ?? historyTrends,
    trendSource: readerTrends !== null ? 'readout' : historyTrends !== null ? 'her-history' : null,
    state: AURA_STATES.find(w => w === value.state || w === value.status) ?? null,
  }
}

/** The strip's view from her files alone: her word, labelled self-asserted. */
export function viewFromFiles(vectorText: string, historyText: string | null): AuraRead {
  let raw: unknown
  try { raw = JSON.parse(vectorText) } catch { return { kind: 'invalid', detail: 'aura.v1.json is not JSON' } }
  const vector = parseAuraVector(raw)
  if (vector === null) return { kind: 'invalid', detail: 'aura.v1.json is not a complete aukora.aura.v1 vector (all four axes in [0, 1])' }
  const trends = historyText === null ? null : trendsFromHistory(historyText)
  return {
    kind: 'ok',
    view: {
      source: 'self-asserted', shown: vector, stored: null, trends, trendSource: trends === null ? null : 'her-history',
      herClaimedTier: null, state: null,
    },
  }
}

/**
 * Combine the reader's projection (when there is one) with her files. Under a projection, the arrows come only from
 * the reader; a mismatch shows her file's numbers (from the projection, else from her file as read here); and the tier
 * her file claims is still named.
 */
export function combineAura(projection: unknown, files: AuraRead): AuraRead {
  const projected = parseAuraProjection(projection instanceof ReadoutSlice ? projection.aura : projection)
  if (projected === null) return files
  // The reader ran but could not recompute: her file stays her word, with the reader's reason beside it.
  if (projected.kind === 'unrecomputable') return { ...files, readerNote: projected.note }
  const mine = files.kind === 'ok' ? files.view.shown : null
  const stored = projected.source === 'self-asserted-mismatch' ? (projected.stored ?? mine) : null
  return {
    kind: 'ok',
    view: {
      source: projected.source,
      shown: projected.shown,
      stored,
      trends: projected.trends,
      trendSource: projected.trendSource,
      herClaimedTier: mine?.claimedTier ?? projected.stored?.claimedTier ?? null,
      state: projected.state,
    },
  }
}

/** What a fresh, receipt-verified readout gives the periphery views: its aura projection and its Pearl summary. */
export class ReadoutSlice {
  readonly aura: unknown
  readonly pearl: unknown
  constructor(aura: unknown, pearl: unknown) {
    this.aura = aura
    this.pearl = pearl
  }
}

/**
 * What a readout phase may give: only a fresh snapshot whose receipts verified. A stale, failed or rejected read
 * gives none (the strip falls back to her file, labelled self-asserted and UNDETERMINED, and the Pentora rests).
 */
export function freshAuraOf(phase: BridgePhase | null): ReadoutSlice | null {
  if (phase === null || phase.kind !== 'snapshot' || phase.receipts.kind !== 'verified') return null
  const snapshot = phase.snapshot as { aura?: unknown; pearl?: unknown }
  return new ReadoutSlice(snapshot.aura ?? null, snapshot.pearl ?? null)
}

/** True only when an independent reader recomputed the vector shown (verified, or a mismatch showing its numbers). */
export function isDetermined(read: AuraRead): boolean {
  return read.kind === 'ok' && read.view.source !== 'self-asserted'
}

/** The axes the Pentora may follow: only a vector an independent reader recomputed. Her own word moves nothing. */
export function pentoraAxes(read: AuraRead): AuraAxes | null {
  return read.kind === 'ok' && isDetermined(read) ? read.view.shown.axes : null
}

// ── PEARL: the Imagination Arena's read-only summary ───────────────────────────────────────────────────────────

/** Her lineage retention suite and engraved scars (`seed-pearl`). */
export const RETENTION_SUITE_PATH = '/dsh/home/auma/seed/pearl/retention-suite.v1.json'
export const SCARS_PATH = '/dsh/home/auma/seed/scars.jsonl'

/** The readout's Pearl summary (`SuperAgentState.pearl` / `PearlProjection`), checked. Null counts: not reported. */
export interface PearlView {
  readonly retentionTotal: number | null
  readonly retentionPassed: number | null
  readonly scarsCount: number | null
  readonly lastChallengeAt: number | string | null
  readonly lastWinnerLabel: string | null
  /** A winner label was given but is not a plain id-like label, so it is withheld. */
  readonly winnerWithheld: boolean
  readonly candidateCount: number | null
  readonly durationMs: number | null
  readonly claimedTier: string | null
  /** Coarse-to-fine tournament counts as recorded on her latest challenge (Round 17). Null: not recorded. */
  readonly candidatesTested: number | null
  readonly coarsePassCount: number | null
  readonly finePassCount: number | null
  readonly negativeControlRejected: boolean | null
  /** Receipt checkpoints as the reader checked them. Null: not read. */
  readonly checkpoint: {
    readonly count: number
    readonly lastReceiptCount: number | null
    readonly receiptTotal: number
    readonly lastSigned: boolean
  } | null
  /** `incomplete` when the readout could not read everything; `gaps` say what. */
  readonly complete: boolean
  readonly gaps: readonly string[]
}

export type PearlRead =
  | { readonly kind: 'reading' }
  | { readonly kind: 'no-session' }
  | { readonly kind: 'not-seeded' }
  | { readonly kind: 'readout'; readonly view: PearlView; readonly verifiedChallenges: number | null }
  | { readonly kind: 'files'; readonly retentionCases: number | null; readonly scars: number | null; readonly problems: readonly string[] }

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)
/** A winner label is shown only as a plain id (`candidate-b`, `v2.1`): no spaces or prose. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/
const present = (v: unknown): boolean => v !== undefined && v !== null

/** A timestamp: finite ms, or a short string that parses as a date. Anything else is dropped, never echoed. */
function timeOf(at: unknown): number | string | null {
  if (typeof at === 'number') return Number.isFinite(at) && at >= 0 ? at : null
  if (typeof at === 'string') return at.length <= 40 && Number.isFinite(Date.parse(at)) ? at : null
  return null
}

/**
 * The readout's Pearl summary. Each count is a non-negative integer or not reported (null); a summary that gives a
 * count of the wrong type, or more passed than total, is refused whole. A winner label is kept only as a plain id.
 */
export function parsePearl(value: unknown): PearlView | null {
  if (!isJson(value)) return null
  const counts = [value.retentionTotal, value.retentionPassed, value.scarsCount, value.candidateCount ?? null]
  if (counts.some(c => present(c) && count(c) === null)) return null
  const retentionTotal = count(value.retentionTotal)
  const retentionPassed = count(value.retentionPassed)
  if (retentionTotal !== null && retentionPassed !== null && retentionPassed > retentionTotal) return null
  if (retentionTotal === null && retentionPassed !== null) return null
  const label = value.lastWinnerLabel
  const duration = value.durationMs ?? value.lastDurationMs ?? value.trialMs
  const gaps = Array.isArray(value.gaps) ? value.gaps.filter((g): g is string => typeof g === 'string' && KIND.test(g)) : []
  return {
    retentionTotal,
    retentionPassed,
    scarsCount: count(value.scarsCount),
    lastChallengeAt: timeOf(value.lastChallengeAt),
    lastWinnerLabel: typeof label === 'string' && LABEL.test(label) ? label : null,
    winnerWithheld: typeof label === 'string' && label !== '' && !LABEL.test(label),
    candidateCount: count(value.candidateCount ?? value.lastCandidateCount),
    durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null,
    claimedTier: typeof value.authorityTier === 'string' ? value.authorityTier : null,
    ...tournamentOf(value),
    checkpoint: checkpointOf(value.checkpoint),
    complete: value.status === undefined ? gaps.length === 0 : value.status === 'complete' && gaps.length === 0,
    gaps,
  }
}

/** Coarse-to-fine counts; fine passes above coarse, or coarse above tested, drop all three (never shown inconsistent). */
function tournamentOf(value: Record<string, unknown>): Pick<PearlView, 'candidatesTested' | 'coarsePassCount' | 'finePassCount' | 'negativeControlRejected'> {
  const tested = count(value.candidatesTested), coarse = count(value.coarsePassCount), fine = count(value.finePassCount)
  const consistent = tested !== null && (coarse === null || coarse <= tested) && (fine === null || (coarse !== null && fine <= coarse))
  const control = value.negativeControlRejected
  return {
    candidatesTested: consistent ? tested : null,
    coarsePassCount: consistent ? coarse : null,
    finePassCount: consistent ? fine : null,
    negativeControlRejected: typeof control === 'boolean' ? control : null,
  }
}

function checkpointOf(value: unknown): PearlView['checkpoint'] {
  if (!isJson(value)) return null
  const total = count(value.count), receipts = count(value.receiptTotal)
  const last = value.lastReceiptCount === null ? null : count(value.lastReceiptCount)
  if (total === null || receipts === null || typeof value.lastSigned !== 'boolean') return null
  if (value.lastReceiptCount !== null && last === null) return null
  return { count: total, lastReceiptCount: last, receiptTotal: receipts, lastSigned: value.lastSigned }
}

/** How many cases her retention suite file holds: an array of cases, or an object with a `cases` array. */
export function countRetentionCases(text: string): number | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  const cases = Array.isArray(raw) ? raw : isJson(raw) && Array.isArray(raw.cases) ? raw.cases : null
  return cases === null ? null : cases.filter(isJson).length
}

/** How many scars her scars.jsonl holds (one JSON object per line). */
export function countScars(text: string): number {
  return text.split('\n').filter((line) => {
    if (line.trim() === '') return false
    try { return isJson(JSON.parse(line)) } catch { return false }
  }).length
}

/**
 * The Pearl read: the readout's summary when it carries a valid one (with the reader's own count of verified
 * pearl.challenge receipts, when it gives one), else her files counted, else not seeded.
 */
export function pearlOf(
  readout: unknown, suite: FileRead | null, scars: FileRead | null, verifiedChallenges: number | null = null,
): PearlRead {
  const view = parsePearl(readout)
  if (view !== null) return { kind: 'readout', view, verifiedChallenges }
  if (suite === null || scars === null) return { kind: 'reading' }
  const problems: string[] = []
  const cases = suite.ok ? countRetentionCases(suite.text) : null
  if (suite.ok && cases === null) problems.push('retention-suite.v1.json is not a list of cases')
  if (!suite.ok && !isMissing(suite.reason)) problems.push(`retention suite unreadable: ${suite.reason}`)
  if (!scars.ok && !isMissing(scars.reason)) problems.push(`scars unreadable: ${scars.reason}`)
  const scarCount = scars.ok ? countScars(scars.text) : null
  if (cases === null && scarCount === null && problems.length === 0) return { kind: 'not-seeded' }
  return { kind: 'files', retentionCases: cases, scars: scarCount, problems }
}

const isMissing = (reason: string): boolean => reason.includes('not-found') || reason === 'ENOENT'
const POLL_MS = 15_000
const READOUT_POLL_MS = 30_000

/**
 * Read her aura files while `active` (15 s poll, and at once on a ball commit or a mirror change to her home), and
 * combine them with the readout's projection when the caller has one.
 */
export function useAura(active: boolean, reader: WorkReader, sessionId: SessionId | undefined, projection: unknown): AuraRead {
  const [files, setFiles] = useState<{
    session: SessionId | undefined
    read: AuraRead
    history: string | null
    suite: FileRead | null
    scars: FileRead | null
  }>({ session: undefined, read: { kind: 'reading' }, history: null, suite: null, scars: null })
  const [tick, setTick] = useState(0)
  const reread = useDebounced(() => { setTick(n => n + 1) })
  useLiveEvents(active, (event) => {
    if (event.kind === 'ball-commit' || (event.kind === 'mirror-updated' && touchesHer(event.changedPaths))) reread.poke()
  })
  useEffect(() => {
    if (!active || sessionId === undefined) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async (): Promise<void> => {
      const [vector, history, suite, scars] = await Promise.all([
        reader.whole(sessionId, AURA_PATH, controller.signal),
        reader.whole(sessionId, AURA_HISTORY_PATH, controller.signal),
        reader.whole(sessionId, RETENTION_SUITE_PATH, controller.signal),
        reader.whole(sessionId, SCARS_PATH, controller.signal),
      ])
      if (controller.signal.aborted) return
      const historyText = history.ok ? history.text : null
      setFiles({ session: sessionId, read: settle(vector, historyText), history: historyText, suite, scars })
      timer = setTimeout(() => { void read() }, POLL_MS)
    }
    void read()
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [active, reader, sessionId, tick])
  const readout = projection instanceof ReadoutSlice ? projection.pearl : undefined
  const challenge = projection instanceof ReadoutSlice && isJson(projection.aura) && isJson(projection.aura.pearlChallenge)
    ? count(projection.aura.pearlChallenge.recomputedCount)
    : null
  if (sessionId === undefined) {
    const view = parsePearl(readout)
    return {
      ...combineAura(projection, { kind: 'none' }),
      pearl: view === null ? { kind: 'no-session' } : { kind: 'readout', view, verifiedChallenges: challenge },
    }
  }
  // A read for another session never shows for this one.
  const mine = files.session === sessionId
  return {
    ...combineAura(projection, mine ? files.read : { kind: 'reading' }),
    pearl: pearlOf(readout, mine ? files.suite : null, mine ? files.scars : null, challenge),
  }
}

function settle(vector: FileRead, historyText: string | null): AuraRead {
  if (!vector.ok) return isMissing(vector.reason) ? { kind: 'none' } : { kind: 'unreadable', detail: vector.reason }
  return viewFromFiles(vector.text, historyText)
}

/**
 * The readout's aura projection for a surface that has no readout of its own (the Aura Coherence view): the same
 * page reader the Work view uses, only while `active`. It probes once; it keeps polling (every 30 s after each read
 * settles) only while the readout actually carries `aura` or `pearl`, and probes again on a ball commit. Only a fresh,
 * receipt-verified snapshot gives a projection (`freshAuraOf`); anything else clears it, and it never outlives its
 * session or activation.
 */
export function useReadoutAura(active: boolean, reader: WorkReader, sessionId: SessionId | undefined): ReadoutSlice | null {
  const [held, setHeld] = useState<{ session: SessionId; slice: ReadoutSlice } | null>(null)
  const [tick, setTick] = useState(0)
  const reprobe = useDebounced(() => { setTick(n => n + 1) })
  useLiveEvents(active, (event) => { if (event.kind === 'ball-commit') reprobe.poke() })
  const bridge = workBridge()
  useEffect(() => {
    setHeld(null)
    if (!active || bridge === null || sessionId === undefined) return
    const read = bridge.createRead({
      sessionId: String(sessionId),
      readText: async (path, signal) => {
        const res = await reader.whole(sessionId, path, signal)
        if (res.ok) return { kind: 'ok', text: res.text }
        return isMissing(res.reason) ? { kind: 'missing' } : { kind: 'unavailable' }
      },
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const off = read.subscribe((phase: BridgePhase) => {
      if (stopped) return
      const settled = phase.kind !== 'loading' && phase.kind !== 'stopped' && !phase.refreshing
      if (!settled) return
      const slice = freshAuraOf(phase)
      setHeld(slice === null ? null : { session: sessionId, slice })
      const carried = phase.kind === 'snapshot' || phase.kind === 'stale-snapshot'
        ? phase.snapshot as { aura?: unknown; pearl?: unknown }
        : null
      const carries = carried !== null && (carried.aura !== undefined || carried.pearl !== undefined)
      if (!carries) { stopped = true; read.stop(); return }
      if (timer === undefined) timer = setTimeout(() => { timer = undefined; read.refresh() }, READOUT_POLL_MS)
    })
    return () => { if (timer !== undefined) clearTimeout(timer); off(); read.stop() }
  }, [active, bridge, reader, sessionId, tick])
  return held !== null && held.session === sessionId ? held.slice : null
}

/** Keep a ref on the Pentora's axes (the figure reads it every frame without re-rendering). */
export function usePentoraAxesRef(read: AuraRead): { readonly current: AuraAxes | null } {
  const ref = useRef<AuraAxes | null>(null)
  ref.current = pentoraAxes(read)
  return ref
}

const ARROW: Readonly<Record<Trend, string>> = { rising: '↑', falling: '↓', steady: '→' }
const SOURCE_PILL: Readonly<Record<AuraSource, { text: string; tone: Tone; title: string }>> = {
  'recomputed-verified': {
    text: 'RECOMPUTED · VERIFIED',
    tone: 'mint',
    title: 'An independent reader recomputed this vector from her files; it found no disagreement with her stored '
      + 'aura.v1 (or was given none to compare).',
  },
  'self-asserted-mismatch': {
    text: 'SELF-ASSERTED · MISMATCH',
    tone: 'red',
    title: 'An independent reader recomputed this vector and her own file differs by more than 0.01: the bars show the '
      + 'recomputed values.',
  },
  'self-asserted': {
    text: 'SELF-ASSERTED · NOT RECOMPUTED',
    tone: 'gold',
    title: 'Only her own aura.v1.json was read; no independent reader recomputed it here. It does not move the Pentora.',
  },
}
const FOCUS_TONE: Readonly<Record<AuraFocus, Tone>> = {
  'verify': 'gold', 'observe': 'violet', 'consolidate': 'blue', 'rest': 'mint', 'escalate-to-owner': 'red',
}

const STATE_TONE: Readonly<Record<AuraState, Tone>> = { calm: 'mint', attentive: 'blue', strained: 'gold', alert: 'red' }

/** The badge for every state short of an independent recompute. */
export const UNDETERMINED_BADGE = 'UNDETERMINED · EVIDENCE INCOMPLETE'

function readerNoteOf(read: AuraRead) {
  if (read.readerNote === undefined) return null
  const note = read.readerNote
  return (
    <p className="ak-aura__warn" data-aura-reader-status={note.status}>
      {note.status === 'corrupt'
        ? 'The independent reader found her aura inputs corrupt and could not recompute a vector.'
        : `The independent reader could not recompute a vector yet${note.gaps.length === 0 ? '' : ` (missing: ${note.gaps.join(', ')})`}.`}
    </p>
  )
}

function tierWarning(tier: string | null, whose: string) {
  if (tier === null || tier === PERIPHERAL_HINT) return null
  return (
    <p className="ak-aura__warn" data-aura-claimed-tier={tier}>
      {`${whose} claims authorityTier "${tier}". A peripheral signal has no authority; it is shown as a hint only.`}
    </p>
  )
}

/**
 * Her vitals as Portal cards, then the Pearl card. The only buttons are the cards' own open/close heads: the periphery
 * and the arena have nothing to approve. Short of an independent recompute it is UNDETERMINED: no filled bar, no focus
 * pill, no alert score and no state word; her own numbers are said as her file's words, marked self-asserted.
 */
export function AuraStrip({ read }: { readonly read: AuraRead }) {
  return (
    <>
      <PeripheryStrip read={read} />
      <PearlArenaCard pearl={read.pearl ?? { kind: 'reading' }} />
    </>
  )
}

/** What each vital measures and where it tips her focus (seed-aura.js computeAura and focusOf, SOURCE). */
const VITALS: Readonly<Record<AuraAxis, {
  readonly icon: IconName
  readonly what: string
  readonly tips: string
  /** True when the value is past the organ's own threshold for this vital. */
  readonly past: (value: number) => boolean
  readonly pastTone: Tone
}>> = {
  coherence: {
    icon: 'aura',
    what: 'How whole her records are: memory she can reach, receipts that verify and organs that run, lowered by predictions with no anchor.',
    tips: 'Below 0.95 she leans to consolidate.',
    past: value => value < 0.95,
    pastTone: 'gold',
  },
  surprisePressure: {
    icon: 'model',
    what: 'How far her recent predictions missed: the mean of her last five surprise scores.',
    tips: 'At 0.30 or more she leans to observe.',
    past: value => value >= 0.3,
    pastTone: 'gold',
  },
  driftRisk: {
    icon: 'risk',
    what: 'How far she may be off course: a hand-off that disagrees, predictions with no anchor, wakes piling up, a recent rollback.',
    tips: 'At 0.40 or more she leans to verify.',
    past: value => value >= 0.4,
    pastTone: 'gold',
  },
  wakeUrgency: {
    icon: 'agent',
    what: 'How much she needs to wake: the strongest of surprise, drift and a stale heartbeat.',
    tips: 'At 0.70 or more she asks for you (escalate to owner).',
    past: value => value >= 0.7,
    pastTone: 'red',
  },
}

const FOCUS_WORDS: Readonly<Record<AuraFocus, string>> = {
  'rest': 'nothing pulls at her',
  'consolidate': 'tidy and join up her records',
  'observe': 'watch what surprised her',
  'verify': 'check her chain and her hand-off',
  'escalate-to-owner': 'she is asking for you',
}

const NOT_RECOMPUTED = (
  <StatusPill tone="gold" title="Her own file's words: no independent reader recomputed them here. They do not move the Pentora.">
    NOT RECOMPUTED
  </StatusPill>
)

const salienceWords = (salience: readonly AuraSalience[]): string => salience.map(s => `${s.kind} · ${s.score.toFixed(2)}`).join(', ')

function PeripheryStrip({ read }: { readonly read: AuraRead }) {
  const hint = (
    <StatusPill tone="muted" title="Standing Law #4: the periphery routes attention; it never confers authority.">
      PERIPHERAL HINT · NO AUTHORITY
    </StatusPill>
  )
  const readerNote = readerNoteOf(read)
  const determined = isDetermined(read)
  const view = read.kind === 'ok' ? read.view : null
  const shown = view?.shown ?? null
  const words = read.kind === 'reading'
    ? 'reading her aura.v1…'
    : read.kind === 'none'
      ? 'no aura.v1 yet: her periphery has not computed a vector'
      : read.kind === 'invalid' || read.kind === 'unreadable'
        ? `aura.v1 ${read.kind === 'invalid' ? 'refused' : 'unreadable'}: ${read.detail}`
        : determined ? null : 'no independent reader has recomputed her aura yet; the cards say her own file\'s words'
  const pill = view === null ? null : SOURCE_PILL[view.source]
  return (
    <section className="ak-aura" data-aura-strip="" data-aura-source={view === null ? read.kind : view.source}
      data-aura-determined={determined ? 'yes' : 'no'} aria-label="Her vitals (aura.v1)">
      <header className="ak-aura__head">
        <span className="ak-aura__title">HER VITALS · aura.v1</span>
        {hint}
        {determined ? null : (
          <StatusPill tone="gold" title="No independent reader has recomputed this vector from complete evidence. Nothing here is a measurement.">
            {UNDETERMINED_BADGE}
          </StatusPill>
        )}
        {pill === null ? null : <StatusPill tone={pill.tone} title={pill.title}>{pill.text}</StatusPill>}
        {!determined || view?.state === null || view === null ? null : (
          <StatusPill tone={STATE_TONE[view.state]} title="The readout's state for the recomputed vector: a hint, not a measurement of health.">
            {`STATE · ${view.state.toUpperCase()}`}
          </StatusPill>
        )}
      </header>
      {words === null ? null : <p className="ak-aura__note">{words}</p>}
      {readerNote}
      {view !== null && view.source === 'self-asserted-mismatch' ? (
        <p className="ak-aura__warn" data-aura-mismatch="">
          {'Her aura.v1.json differs from what an independent reader recomputed from her verified files. The cards show '
            + `the recomputed values${view.stored === null ? '; her file\'s numbers could not be read here.' : '; her file\'s are beside them.'}`}
        </p>
      ) : null}
      {shown === null || view === null ? null : (
        <PortalGrid open={false}>
          {AXES.map(axis => <VitalCell key={axis} axis={axis} view={view} determined={determined} />)}
          <FocusCell shown={shown} determined={determined} />
          <AlertsCell shown={shown} determined={determined} />
        </PortalGrid>
      )}
      {tierWarning(shown?.claimedTier ?? null, determined ? 'This vector' : 'Her file')}
      {determined ? tierWarning(view?.herClaimedTier ?? null, 'Her file') : null}
    </section>
  )
}

/** One vital: its value and bar when an independent reader recomputed it, else her file's number in words. */
function VitalCell({ axis, view, determined }: { readonly axis: AuraAxis; readonly view: AuraView; readonly determined: boolean }) {
  const vital = VITALS[axis]
  const value = view.shown.axes[axis]
  const trend = determined ? view.trends?.[axis] ?? null : null
  const theirs = view.stored?.axes[axis]
  const tone: Tone = !determined ? 'gold' : vital.past(value) ? vital.pastTone : 'mint'
  // The bar sits in the card's second line, beside its words, so the vital's name keeps the head's width (Round 27).
  const bar = (
    <span className="ak-meter ak-aura__bar" role="img" aria-label={`${AXIS_NAMES[axis]} ${value.toFixed(2)}`}>
      <i style={{ width: `${String(Math.round(value * 100))}%` }} />
    </span>
  )
  const words = theirs === undefined || theirs === null
    ? vital.past(value) ? vital.tips : 'within her calm range'
    : <span className="ak-aura__theirs" data-aura-stored="">{`her file: ${theirs.toFixed(2)}`}</span>
  const summary = !determined
    ? <span data-aura-self-asserted="">{`her file: ${value.toFixed(2)}`}</span>
    : <>{bar}{words}</>
  const badge = !determined ? NOT_RECOMPUTED : (
    <span className="ak-aura__badge">
      <StatusPill tone={tone}><span className="ak-aura__value">{value.toFixed(2)}</span></StatusPill>
      <span className="ak-aura__trend" title={trend === null ? 'no trend yet'
        : `${trend}${view.trendSource === 'her-history' ? ' (from her own history file)' : ' (from the reader)'}`}>
        {trend === null ? '·' : ARROW[trend]}
      </span>
    </span>
  )
  return (
    <PortalCell data-aura-axis={axis} data-aura-trend={trend ?? 'unknown'} data-aura-determined={determined ? 'yes' : 'no'}>
      <PortalButton tone={tone === 'mint' ? 'blue' : tone === 'red' ? 'red' : 'gold'} icon={vital.icon} title={AXIS_NAMES[axis]}
        summary={summary} badge={badge}>
        <Lead>{vital.what}</Lead>
        <Lead>{vital.tips}</Lead>
      </PortalButton>
    </PortalCell>
  )
}

/** Her recommended focus: a hint, never an instruction. */
function FocusCell({ shown, determined }: { readonly shown: AuraVector; readonly determined: boolean }) {
  const focus = shown.focus
  const summary = focus === null ? 'this vector names no focus'
    : determined ? FOCUS_WORDS[focus] : <span data-aura-self-asserted="">{`her file: ${focus}`}</span>
  const badge = !determined ? NOT_RECOMPUTED : focus === null ? <StatusPill tone="muted">NONE</StatusPill> : (
    <StatusPill tone={FOCUS_TONE[focus]} title="The recommended focus: a hint, not an instruction.">{`FOCUS · ${focus.toUpperCase()}`}</StatusPill>
  )
  return (
    <PortalCell data-aura-focus={determined ? focus ?? 'none' : 'undetermined'}>
      <PortalButton tone={determined && focus !== null && FOCUS_TONE[focus] === 'red' ? 'red' : 'violet'} icon="presets"
        title="Recommended focus" summary={summary} badge={badge}>
        <FieldTable rows={FOCI.map((name): [string, string] => [name, FOCUS_WORDS[name]])} />
        <Lead>
          Her periphery picks the first that holds: wake urgency 0.70 or more, drift risk 0.40 or more, surprise 0.30 or
          more, coherence below 0.95, else rest. It routes her attention and grants nothing.
        </Lead>
      </PortalButton>
    </PortalCell>
  )
}

/** What pulls at her attention, strongest first: machine words only. */
function AlertsCell({ shown, determined }: { readonly shown: AuraVector; readonly determined: boolean }) {
  const alerts = shown.salience.filter(s => s.kind !== 'clean-state')
  const summary = shown.salience.length === 0 ? 'none listed'
    : determined ? salienceWords(shown.salience) : <span data-aura-self-asserted="">{`her file: ${salienceWords(shown.salience)}`}</span>
  const badge = !determined ? NOT_RECOMPUTED
    : <StatusPill tone={alerts.length === 0 ? 'mint' : 'gold'}>{alerts.length === 0 ? 'CLEAR' : `${String(alerts.length)} ACTIVE`}</StatusPill>
  return (
    <PortalCell data-aura-salience="">
      <PortalButton tone={determined && alerts.length > 0 ? 'gold' : 'violet'} icon="risk" title="Salience alerts" summary={summary} badge={badge}>
        {shown.salience.length === 0 ? <Lead>Her vector lists nothing.</Lead> : (
          <RecordList>
            {shown.salience.map((s, i) => (
              <RecordRow key={`${String(i)}-${s.kind}-${s.code}`} tone={s.kind === 'clean-state' ? 'mint' : 'gold'} title={s.kind}
                summary={`${s.code === '' ? 'no code' : s.code}${s.targetId === '' ? '' : ` · ${s.targetId.slice(0, 12)}`}`}
                status={<StatusPill tone="muted">{determined ? s.score.toFixed(2) : 'her file'}</StatusPill>} />
            ))}
          </RecordList>
        )}
        <Lead>Salience routes her attention; it grants nothing.</Lead>
      </PortalButton>
    </PortalCell>
  )
}

const ago = (at: number | string | null): string => {
  if (at === null) return ''
  const ms = typeof at === 'number' ? (at < 1e12 ? at * 1000 : at) : Date.parse(at)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : ''
}

function trialWords(v: PearlView, verified: number | null): string {
  const claims = v.lastChallengeAt !== null || v.lastWinnerLabel !== null || v.winnerWithheld || v.candidateCount !== null
    || v.durationMs !== null
  if (!claims) return v.complete ? 'no challenge recorded yet' : 'not reported'
  const parts = [
    v.candidateCount === null ? null : `${String(v.candidateCount)} candidates`,
    v.lastWinnerLabel !== null ? `winner ${v.lastWinnerLabel}` : v.winnerWithheld ? 'winner label withheld (not a plain label)' : null,
    v.durationMs === null ? null : `${String(Math.round(v.durationMs))} ms`,
    v.lastChallengeAt === null ? null : ago(v.lastChallengeAt) || null,
  ].filter((p): p is string => p !== null)
  const unverified = verified === 0 ? ' · claimed; the reader found no verified pearl.challenge receipt' : ''
  return `${parts.join(' · ')}${unverified}`
}

function tournamentWords(v: PearlView): string | null {
  if (v.candidatesTested === null && v.negativeControlRejected === null) return null
  const parts = [
    v.candidatesTested === null ? null : `${String(v.candidatesTested)} candidates tested`,
    v.coarsePassCount === null ? null : `coarse ${String(v.coarsePassCount)} passed`,
    v.finePassCount === null ? null : `fine ${String(v.finePassCount)} passed`,
    v.negativeControlRejected === null ? null
      : v.negativeControlRejected ? 'reward-hack control refused' : 'reward-hack control NOT refused',
  ].filter((p): p is string => p !== null)
  return parts.join(' · ')
}

function checkpointWords(c: NonNullable<PearlView['checkpoint']>): string {
  if (c.count === 0) return `no checkpoint yet · ${String(c.receiptTotal)} receipts`
  const covers = c.lastReceiptCount === null ? 'coverage unread' : `covers ${String(c.lastReceiptCount)} of ${String(c.receiptTotal)} receipts`
  return `checkpoint ${String(c.count)} ${covers} · ${c.lastSigned ? 'signature verified' : 'signature NOT verified'}`
}

function retentionWords(v: PearlView): string {
  if (v.retentionTotal === null) return 'not reported'
  if (v.retentionTotal === 0) return 'NOT SEEDED YET'
  if (v.retentionPassed === null) return `${String(v.retentionTotal)} cases · pass count not reported`
  return `${String(v.retentionPassed)}/${String(v.retentionTotal)} passed`
}

const PEARL_WORDS: Partial<Record<PearlRead['kind'], string>> = {
  'reading': 'reading her arena…',
  'not-seeded': 'NOT SEEDED YET',
  'no-session': 'no live Session is shown, so her arena is not read',
}

/** Her Imagination Arena (`seed-pearl`), read only: retention suite, engraved scars, latest isolated trial. */
export function PearlArenaCard({ pearl }: { readonly pearl: PearlRead }) {
  const rows: (readonly [string, string, string])[] = []
  let source = ''
  if (pearl.kind === 'readout') {
    const v = pearl.view
    rows.push(['retention', 'Lineage retention suite', retentionWords(v)])
    rows.push(['scars', 'Engraved scars', v.scarsCount === null ? 'not reported' : v.scarsCount === 0 ? 'none yet' : `${String(v.scarsCount)} recorded`])
    rows.push(['trial', 'Latest isolated trial', trialWords(v, pearl.verifiedChallenges)])
    const tournament = tournamentWords(v)
    if (tournament !== null) rows.push(['tournament', 'Coarse to fine', tournament])
    if (v.checkpoint !== null) rows.push(['checkpoint', 'Receipt checkpoints', checkpointWords(v.checkpoint)])
    source = 'From the readout: her suite, scars and pearl.challenge receipts, as she recorded them (self-attested; not re-run here).'
  } else if (pearl.kind === 'files') {
    rows.push(['retention', 'Lineage retention suite', pearl.retentionCases === null || pearl.retentionCases === 0
      ? 'NOT SEEDED YET'
      : `${String(pearl.retentionCases)} cases · pass count not read here`])
    rows.push(['scars', 'Engraved scars', pearl.scars === null || pearl.scars === 0
      ? 'none yet'
      : `${String(pearl.scars)} lines in scars.jsonl (not checked against the gate)`])
    rows.push(['trial', 'Latest isolated trial', 'not read here (needs the readout\'s pearl summary)'])
    source = 'Counted from her own files (self-asserted).'
  }
  const words = PEARL_WORDS[pearl.kind] ?? null
  return (
    <section className="ak-aura ak-pearl" data-pearl-arena="" data-pearl-source={pearl.kind} aria-label="Pearl Imagination Arena">
      <header className="ak-aura__head">
        <span className="ak-aura__title">PEARL · IMAGINATION ARENA</span>
        <StatusPill tone="muted" title={'By design, pearl.challenge runs candidates in a disposable worker realm (trialScionCandidate) '
          + 'with copied inputs. This view does not prove the isolation of the trials shown here, and nothing on this card grants '
          + 'live authority.'}>
          ISOLATED WORKER REALM · NO LIVE AUTHORITY
        </StatusPill>
      </header>
      {words === null ? null : <p className="ak-aura__note" data-pearl-state={pearl.kind}>{words}</p>}
      {rows.length === 0 ? null : (
        <dl className="ak-pearl__facts">
          {rows.map(([key, name, value]) => (
            <div key={key} className="ak-pearl__row" data-pearl-row={key}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {source === '' ? null : <p className="ak-aura__note">{source}</p>}
      {pearl.kind === 'readout' && !pearl.view.complete ? (
        <p className="ak-aura__warn" data-pearl-incomplete="">
          {`The arena summary is incomplete${pearl.view.gaps.length === 0 ? '' : ` (missing: ${pearl.view.gaps.join(', ')})`}.`}
        </p>
      ) : null}
      {pearl.kind === 'files' && pearl.problems.length > 0 ? <p className="ak-aura__warn">{pearl.problems.join(' · ')}</p> : null}
      {pearl.kind === 'readout' && pearl.view.claimedTier !== null && pearl.view.claimedTier !== 'self-attested' ? (
        <p className="ak-aura__warn" data-pearl-claimed-tier={pearl.view.claimedTier}>
          {`The arena summary claims authorityTier "${pearl.view.claimedTier}". A trial grants nothing; it is shown as self-attested.`}
        </p>
      ) : null}
    </section>
  )
}

// ── WHERE THIS PAGE RUNS (Round 16): the Mac host or the Cloudflare edge ──────────────────────────────────────────────

/** Edge facts from the Worker's own `/api/health` (only asked on the edge; the Mac host has no such route). */
export interface EdgeHealth {
  readonly ready: boolean
  readonly buildSha: string | null
  readonly doorsBound: number
  readonly doorsTotal: number
  readonly unsupported: readonly string[]
}

/** What `/__x6/status` says about the host serving this page. Both hosts answer `runtime: 'local' | 'cloudflare'`. */
export type HostMode =
  | { readonly kind: 'reading' }
  | { readonly kind: 'local'; readonly host: string }
  | { readonly kind: 'cloudflare'; readonly host: string; readonly edge: EdgeHealth | null; readonly edgeTrouble: string | null }
  | { readonly kind: 'unknown'; readonly host: string; readonly reason: string }
  /** The edge answered 401 OWNER_ACCESS_REQUIRED: this tab has no valid owner sign-in (never, or its pass ran out). */
  | { readonly kind: 'signed-out'; readonly host: string }

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Read the Worker's `/api/health` body.
 * @returns the edge facts, or null when the body is not that shape.
 */
export function parseEdgeHealth(value: unknown): EdgeHealth | null {
  if (!isObject(value) || value.ok !== true || typeof value.ready !== 'boolean') return null
  const capabilities = isObject(value.capabilities) ? value.capabilities : null
  const doors = capabilities !== null && isObject(capabilities.providerDoors) ? Object.values(capabilities.providerDoors) : []
  const unsupported = Array.isArray(value.unsupported) ? value.unsupported.filter((item): item is string => typeof item === 'string') : []
  return {
    ready: value.ready,
    buildSha: typeof value.buildSha === 'string' && value.buildSha !== '' ? value.buildSha : null,
    doorsBound: doors.filter(bound => bound === true).length,
    doorsTotal: doors.length,
    unsupported,
  }
}

type HostFetch = (input: string, init?: RequestInit) => Promise<Response>

type JsonAnswer = { ok: true; body: unknown } | { ok: false; reason: string; signedOut?: true }

async function getJsonBody(fetchImpl: HostFetch, path: string, signal: AbortSignal | undefined): Promise<JsonAnswer> {
  try {
    const response = await fetchImpl(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', ...(signal === undefined ? {} : { signal }) })
    if (response.status === 401) {
      const body: unknown = await response.json().catch(() => null)
      if (isObject(body) && body.code === 'OWNER_ACCESS_REQUIRED') return { ok: false, reason: `${path} wants the owner pass`, signedOut: true }
    }
    if (!response.ok) return { ok: false, reason: `${path} answered ${String(response.status)}` }
    return { ok: true, body: await response.json() as unknown }
  } catch (error) {
    if (signal?.aborted === true) throw error
    return { ok: false, reason: `${path} did not answer` }
  }
}

/**
 * Ask the host serving this page what it is: `/__x6/status` `runtime`, then, on the edge only, `/api/health`.
 * Reads only. From the Mac host the edge is never probed (another origin, behind its own login), so it is not claimed.
 */
export async function readHostMode(fetchImpl: HostFetch = (input, init) => fetch(input, init), signal?: AbortSignal,
  host: string = globalThis.location?.host ?? ''): Promise<HostMode> {
  const status = await getJsonBody(fetchImpl, '/__x6/status', signal)
  if (!status.ok) return status.signedOut === true ? { kind: 'signed-out', host } : { kind: 'unknown', host, reason: status.reason }
  const runtime = isObject(status.body) ? status.body.runtime : undefined
  if (runtime === 'local') return { kind: 'local', host }
  if (runtime !== 'cloudflare') return { kind: 'unknown', host, reason: '/__x6/status names no runtime' }
  const health = await getJsonBody(fetchImpl, '/api/health', signal)
  if (!health.ok) return { kind: 'cloudflare', host, edge: null, edgeTrouble: health.reason }
  const edge = parseEdgeHealth(health.body)
  return { kind: 'cloudflare', host, edge, edgeTrouble: edge === null ? '/api/health is not the expected shape' : null }
}

/** Read the host mode once each time `active` turns on, and again whenever `round` changes (a Refresh). */
export function useHostMode(active: boolean, round = 0, fetchImpl?: HostFetch): HostMode {
  const [mode, setMode] = useState<HostMode>({ kind: 'reading' })
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void readHostMode(fetchImpl, controller.signal).then(
      (next) => { if (!controller.signal.aborted) setMode(next) },
      () => { /* aborted on close */ },
    )
    return () => { controller.abort() }
  }, [active, round, fetchImpl])
  return mode
}

/** Plain words for the host mode: a short pill, the tone, and the longer sentence (hover title and portal lead). */
export function hostModeWords(mode: HostMode): { readonly pill: string; readonly tone: Tone; readonly detail: string } {
  if (mode.kind === 'reading') return { pill: 'HOST · READING', tone: 'muted', detail: 'Asking this page’s host what it is.' }
  if (mode.kind === 'unknown') return { pill: 'HOST · UNKNOWN', tone: 'muted', detail: `Could not tell which host serves this page: ${mode.reason}.` }
  if (mode.kind === 'signed-out') {
    return { pill: 'CLOUDFLARE EDGE · SIGN IN', tone: 'gold', detail: `Served by Cloudflare (${mode.host}), which wants your owner pass before it shares anything.` }
  }
  if (mode.kind === 'local') {
    return { pill: `LOCAL MAC · ${mode.host}`, tone: 'gold',
      detail: `This page is served by the Mac host (${mode.host}). It is not the node.example.invalid edge, and this page does not check the edge.` }
  }
  const edge = mode.edge
  if (edge === null) return { pill: `CLOUDFLARE EDGE · ${mode.host}`, tone: 'gold', detail: `Served by Cloudflare (${mode.host}); ${mode.edgeTrouble ?? 'edge health unread'}.` }
  const doors = `${String(edge.doorsBound)} of ${String(edge.doorsTotal)} model doors bound`
  return edge.ready && edge.doorsBound > 0
    ? { pill: `CLOUDFLARE EDGE · ${mode.host}`, tone: 'mint',
      detail: `Served by Cloudflare (${mode.host}); the Mac is not in the path. Seeded, ${doors}, build ${edge.buildSha ?? 'unlabelled'}.` }
    : { pill: 'CLOUDFLARE EDGE · NOT READY', tone: 'gold',
      detail: `Served by Cloudflare (${mode.host}) but ${edge.ready ? '' : 'not seeded yet, '}${doors}.` }
}

// ── EDGE OWNER SIGN-IN (Round 17): paste the signed owner pass; the edge turns it into a sign-in cookie ─────────────────

/** The Worker's own rule (deploy/cloudflare/src/access.mjs, Round 34): a pass lives at most 24 hours. */
const OWNER_PASS_MAX_SECONDS = 24 * 60 * 60

function decodeBase64UrlJson(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return null
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4)
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(padded), char => char.charCodeAt(0))))
  } catch { return null }
}

/**
 * Plain-words check of a pasted owner pass BEFORE it is sent: its shape, issuer, host and time window, as the Worker
 * reads them. It cannot check the signature or the email (the Worker holds those); the Worker decides.
 */
export function checkOwnerPass(
  pass: string, host: string, nowSeconds: number,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const parts = pass.trim().split('.')
  if (parts.length !== 3 || parts.some(part => part === '')) return { ok: false, reason: 'That is not a signed pass (it should be three parts joined by dots).' }
  const header = decodeBase64UrlJson(parts[0] ?? ''), claims = decodeBase64UrlJson(parts[1] ?? '')
  if (!isObject(header) || header.alg !== 'EdDSA' || header.typ !== 'JWT') return { ok: false, reason: 'That pass is not an Ed25519 owner pass.' }
  if (!isObject(claims) || claims.iss !== 'aukora.x61.owner') return { ok: false, reason: 'That pass was not issued for the AUKORA owner.' }
  if (claims.aud !== host) return { ok: false, reason: `That pass is for ${typeof claims.aud === 'string' ? claims.aud : 'another host'}, not ${host}.` }
  const nbf = claims.nbf, exp = claims.exp
  if (typeof nbf !== 'number' || typeof exp !== 'number' || !Number.isFinite(nbf) || !Number.isFinite(exp)) return { ok: false, reason: 'That pass has no valid time window.' }
  if (exp <= nowSeconds) return { ok: false, reason: 'That pass has run out. Make a fresh one.' }
  if (nbf > nowSeconds) return { ok: false, reason: 'That pass is not valid yet (check this computer’s clock).' }
  if (exp - nbf > OWNER_PASS_MAX_SECONDS) return { ok: false, reason: 'That pass lasts longer than 24 hours; the edge refuses those.' }
  return { ok: true }
}

/** What the edge said to a sign-in. The pass itself is never returned, kept or logged. */
export type OwnerSignInAnswer = { readonly ok: true; readonly expires: number } | { readonly ok: false; readonly reason: string }

/**
 * POST the pass to this page's own host at `/_auth/owner` (`content-type: application/jwt`). The browser adds the
 * same-origin `Origin` and `Sec-Fetch-Site` headers itself; the edge answers with an HttpOnly sign-in cookie.
 */
export async function sendOwnerPass(fetchImpl: HostFetch, pass: string): Promise<OwnerSignInAnswer> {
  try {
    const response = await fetchImpl('/_auth/owner', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/jwt' }, body: pass.trim(),
    })
    const body: unknown = await response.json().catch(() => null)
    if (response.ok && isObject(body) && body.ok === true && typeof body.expires === 'number') return { ok: true, expires: body.expires }
    const code = isObject(body) && typeof body.code === 'string' ? body.code : `HTTP ${String(response.status)}`
    if (code === 'OWNER_ACCESS_REQUIRED') return { ok: false, reason: 'The edge did not accept that pass (wrong signer, owner, host, or it has run out).' }
    return { ok: false, reason: `The edge refused the sign-in: ${code}.` }
  } catch {
    return { ok: false, reason: 'The edge did not answer. Check the connection and try again.' }
  }
}

/**
 * The inline sign-in sheet shown where the host pill would say SIGN IN. Never a popup or modal. The pass is held only
 * in this field until it is sent, then cleared; on success the page reloads so boot reads her home with the cookie.
 */
export function EdgeOwnerSignIn({ host, fetchImpl = (input, init) => fetch(input, init), now = () => Date.now() / 1000,
  onSignedIn = () => { globalThis.location.reload() } }: {
  readonly host: string
  readonly fetchImpl?: HostFetch
  readonly now?: () => number
  readonly onSignedIn?: () => void
}) {
  const [pass, setPass] = useState('')
  const [phase, setPhase] = useState<{ readonly kind: 'idle' | 'sending' | 'signed-in' } | { readonly kind: 'refused'; readonly reason: string }>({ kind: 'idle' })
  const submit = (): void => {
    const check = checkOwnerPass(pass, host, now())
    if (!check.ok) { setPhase({ kind: 'refused', reason: check.reason }); return }
    setPhase({ kind: 'sending' })
    const sent = pass
    setPass('')
    void sendOwnerPass(fetchImpl, sent).then((answer) => {
      if (!answer.ok) { setPhase({ kind: 'refused', reason: answer.reason }); return }
      setPhase({ kind: 'signed-in' })
      onSignedIn()
    })
  }
  return (
    <section className="ak-signin" data-edge-signin={phase.kind} aria-label="Sign in to this edge">
      <p className="ak-signin__lead">{`${host} wants your owner pass before it opens her home.`}</p>
      <p className="ak-aura__note">Paste the signed pass (it starts with eyJ). This page never stores it; the edge turns it into a sign-in that ends when the pass does.</p>
      <form className="ak-signin__row" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <input className="ak-signin__field" type="password" name="owner-pass" aria-label="Owner pass" autoComplete="off" spellCheck={false}
          value={pass} onChange={(event) => { setPass(event.target.value) }} disabled={phase.kind === 'sending' || phase.kind === 'signed-in'} />
        <button className="ak-signin__go" type="submit" disabled={pass.trim() === '' || phase.kind === 'sending' || phase.kind === 'signed-in'}>
          {phase.kind === 'sending' ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {phase.kind === 'refused' ? <p className="ak-aura__warn" role="status">{phase.reason}</p> : null}
      {phase.kind === 'signed-in' ? <p className="ak-aura__note" role="status">Signed in. Opening her home…</p> : null}
    </section>
  )
}
