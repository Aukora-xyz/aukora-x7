// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * AURA COHERENCE ON THE PENTORA: the shapes the figure draws.
 *
 * The figure's health layer is canon's health snapshot (`HealthSnapshot`; the canon sources are not in this repository): 110 cells, each
 * Verified, Undetermined or Failed with a reason, pinned to the Pentora. Organ i owns cube i of
 * the Pentora geometry index table (v1); the organ's 18 private checks are its cube's 12 edge midpoints
 * and 6 face centres; the 20 shared corners are the compound's 20 vertices, each owned by the two organs whose cubes
 * meet there. `tables.ts` (generated) carries the geometry and the corners.
 *
 * A health cell is NOT a Pentora fingerprint trit (pentora.display.v1): the figure draws health
 * cells on the geometry and never shows, derives or implies a fingerprint.
 *
 * NOTHING FEEDS IT HERE: no host serves a health snapshot and the registration injects none, so the figure draws
 * `absentHealth()`: every cell Undetermined with reason `missing`, which is exactly what canon calls an absent report.
 * A later change took out the map that listed those cells one by one (it could only ever say "not connected"); the figure is
 * unchanged.
 */
import type { Tone } from '../primitives/index.ts'
import { CORNERS, CUBES, type OrganWire } from './tables.ts'

export const AURA_SURFACE = 'aura-coherence'

/** canon `Cell` wire names. */
export type CellState = 'verified' | 'undetermined' | 'failed'
/** canon `HealthReason` wire names. */
export type HealthReason =
  | 'satisfied' | 'unwritten' | 'missing' | 'not-checked' | 'unreachable' | 'stale' | 'disagreement'
  | 'invariant-failed' | 'context-mismatch' | 'invalid-evidence'

/** One cell as the figure draws it: the state, why, and when it was last observed (null when never). */
export interface CellReport {
  readonly cell: CellState
  readonly reason: HealthReason
  readonly observed_at_ms: number | null
}

/** A health snapshot, reduced to what the figure needs (canon `HealthSnapshot` v1). */
export interface AuraHealthView {
  readonly source: 'stub' | 'node'
  readonly epoch: number
  readonly sequence: number
  readonly observed_at_ms: number
  /** 90 private cells, organ order then check index (each cube's `private` order). */
  readonly private: readonly CellReport[]
  /** 20 corner cells, corner index order (canon CORNERS order). */
  readonly corners: readonly CellReport[]
}

export const ORGANS: readonly OrganWire[] = ['aumlok', 'gate-aura', 'kira', 'network', 'body']

/** Each organ's name and its colour on the Pentora. */
export interface OrganFact { readonly title: string; readonly tone: Tone }

export const ORGAN_FACTS: Readonly<Record<OrganWire, OrganFact>> = {
  'aumlok': { title: 'AUMLOK', tone: 'gold' },
  'gate-aura': { title: 'Gate & Aura', tone: 'blue' },
  'kira': { title: 'Kira', tone: 'violet' },
  'network': { title: 'Network', tone: 'mint' },
  'body': { title: 'Body', tone: 'muted' },
}

/** How long after an observation its edge still pulses: recent activity. */
export const PULSE_WINDOW_MS = 20_000

/** One absent report: canon reduces it to Undetermined (reason `missing`). */
export const ABSENT: CellReport = Object.freeze({ cell: 'undetermined', reason: 'missing', observed_at_ms: null })

/** On a node, before any route: every report absent, which canon reduces to Undetermined (reason `missing`). */
export function absentHealth(): AuraHealthView {
  return {
    source: 'node', epoch: 0, sequence: 0, observed_at_ms: 0,
    private: CUBES.flatMap(cube => cube.private.map(() => ABSENT)), corners: CORNERS.map(() => ABSENT),
  }
}

export interface Tally { readonly verified: number; readonly undetermined: number; readonly failed: number }

function tally(cells: readonly CellReport[]): Tally {
  let verified = 0, undetermined = 0, failed = 0
  for (const report of cells) {
    if (report.cell === 'verified') verified++
    else if (report.cell === 'failed') failed++
    else undetermined++
  }
  return { verified, undetermined, failed }
}

/** An organ's 18 private reports, in check order. */
export function privateOf(view: AuraHealthView, organ: OrganWire): CellReport[] {
  const start = ORGANS.indexOf(organ) * 18
  return view.private.slice(start, start + 18)
}

/** The corners an organ shares (8), with their canon index. */
export function cornersOf(organ: OrganWire): number[] {
  return CORNERS.filter(corner => corner.owners.includes(organ)).map(corner => corner.index)
}

/** An organ's 26 cells (18 private, 8 shared corners) by state: the figure's drift reads it. */
export function organTally(view: AuraHealthView, organ: OrganWire): Tally {
  const corners = cornersOf(organ).map(index => view.corners[index - 1] ?? ABSENT)
  return tally([...privateOf(view, organ), ...corners])
}

/** The view's words. English in this preview, like Sovereignty. */
export const AURA_COPY = {
  eyebrow: 'Living system state',
  title: 'Aura Coherence',
  readOnly: 'Read-only',
  readOnlyTitle: 'This view only reads; nothing here grants anything.',
} as const
