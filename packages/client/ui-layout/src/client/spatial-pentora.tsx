// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PENTORA'S NERVOUS SYSTEM (Round 14, North Star §14): how the periphery's `aura.v1` axes move the figure.
 *
 *   coherence         phase lock: the five cubes' drift oscillations draw toward one shared phase (harmonic symmetry).
 *                     It changes WHEN a cube sways, never HOW FAR: the sway's size still comes from her health checks,
 *                     so a high coherence can never make a failing cube look locked in true.
 *   surprisePressure  a soft field behind the figure shifts from violet (calm) to amber (surprised). It never touches
 *                     an edge or dot colour, which belong to the health checks.
 *   wakeUrgency       the breathing rate, from the calm idle rate up to at most 1.8× it, and a slightly deeper breath.
 *                     The breath is an integrated phase, so a change of rate never makes it jump.
 *
 * The modulation itself is smoothed (time constant 1.2 s) toward its target, and with no vector (`null`: none yet,
 * unreadable, invalid, or only self-asserted) the target is idle, so a vector arriving or leaving eases in and out.
 * At idle the figure moves as it did before the periphery: the same terms, the breath at its old rate.
 *
 * Only a vector an independent reader recomputed may move the figure: the caller passes null for a vector that is only
 * her own word, so a crafted `aura.v1.json` cannot calm or alarm the figure.
 *
 * @module spatial-pentora
 */

/** The four `aura.v1` axes, each in [0, 1]. */
export interface AuraAxes {
  readonly coherence: number
  readonly surprisePressure: number
  readonly driftRisk: number
  readonly wakeUrgency: number
}

/** What the figure does with the axes this frame. */
export interface PentoraModulation {
  /** 0..0.7: how strongly the cubes' drift phases are coupled toward one shared phase (see `coupling`). */
  readonly phaseLock: number
  /** Field opacity, 0 when idle. */
  readonly fieldOpacity: number
  /** Field hue position, 0 = violet, 1 = amber. */
  readonly fieldWarmth: number
  /** Breathing rate multiplier, 1 when idle, at most 1.8. */
  readonly breathRate: number
  /** Breathing depth multiplier, 1 when idle, at most 1.4. */
  readonly breathDepth: number
}

/** The figure exactly as it was before the periphery: no lock, no field, the calm breath. */
export const PENTORA_IDLE: PentoraModulation = { phaseLock: 0, fieldOpacity: 0, fieldWarmth: 0, breathRate: 1, breathDepth: 1 }

/** Smoothing time constant for the axes, in milliseconds. */
export const AURA_LERP_MS = 1_200

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)

/** The modulation for a (smoothed) set of axes; idle for null. */
export function modulationOf(axes: AuraAxes | null): PentoraModulation {
  if (axes === null) return PENTORA_IDLE
  const surprise = clamp01(axes.surprisePressure)
  const urgency = clamp01(axes.wakeUrgency)
  return {
    phaseLock: 0.7 * clamp01(axes.coherence),
    fieldOpacity: 0.05 + 0.15 * surprise,
    fieldWarmth: surprise,
    breathRate: 1 + 0.8 * urgency,
    breathDepth: 1 + 0.4 * urgency,
  }
}

/**
 * One smoothing step of the modulation toward its target. The target is idle (`PENTORA_IDLE`) when there is no
 * vector, so a vector arriving or going away eases in and out like any other change.
 */
export function lerpModulation(
  current: PentoraModulation, target: PentoraModulation, dt: number, tau: number = AURA_LERP_MS,
): PentoraModulation {
  if (!(dt > 0)) return current
  const k = 1 - Math.exp(-dt / tau)
  const step = (a: number, b: number): number => a + (b - a) * k
  return {
    phaseLock: step(current.phaseLock, target.phaseLock),
    fieldOpacity: step(current.fieldOpacity, target.fieldOpacity),
    fieldWarmth: step(current.fieldWarmth, target.fieldWarmth),
    breathRate: step(current.breathRate, target.breathRate),
    breathDepth: step(current.breathDepth, target.breathDepth),
  }
}

/** Coupling strength at full lock, in radians per millisecond (above the cubes' largest natural rate difference). */
export const COUPLING_PER_MS = 0.0015

/**
 * PHASE LOCK as coupling (Kuramoto): each cube's phase is pulled toward the others' by
 * `K · lock · (ȳ·cos θ − x̄·sin θ)`, where (x̄, ȳ) is the mean of the cubes' unit vectors. It is added to each cube's
 * RATE and integrated with it, so the phases stay continuous whatever happens (no angle is ever blended or wrapped).
 * Zero at no lock, and zero when the cubes are already in step.
 * @returns per-cube extra rate, radians per millisecond.
 */
export function coupling(phases: readonly number[], lock: number): number[] {
  const n = phases.length
  if (!(lock > 0) || n === 0) return phases.map(() => 0)
  const x = phases.reduce((sum, p) => sum + Math.cos(p), 0) / n
  const y = phases.reduce((sum, p) => sum + Math.sin(p), 0) / n
  const k = COUPLING_PER_MS * Math.min(1, lock)
  return phases.map(p => k * (y * Math.cos(p) - x * Math.sin(p)))
}

const VIOLET = [139, 124, 255] as const
const AMBER = [245, 165, 36] as const

/** The field's colour at a warmth (0 violet .. 1 amber). */
export function fieldColour(warmth: number): string {
  const w = clamp01(warmth)
  const mix = (k: 0 | 1 | 2): number => Math.round(VIOLET[k] + (AMBER[k] - VIOLET[k]) * w)
  return `rgb(${String(mix(0))}, ${String(mix(1))}, ${String(mix(2))})`
}

/**
 * The soft field behind the figure: a radial gradient whose colour and opacity the animation loop sets each frame
 * (through `data-pentora-field` and its stop). Invisible at idle.
 */
export function PentoraField({ id }: { readonly id: string }) {
  return (
    <>
      <defs>
        <radialGradient id={id} cx="0" cy="0" r="88" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={fieldColour(0)} stopOpacity="1" data-pentora-field-stop="" />
          <stop offset="100%" stopColor={fieldColour(0)} stopOpacity="0" data-pentora-field-stop="" />
        </radialGradient>
      </defs>
      <circle cx="0" cy="0" r="88" fill={`url(#${id})`} opacity="0" data-pentora-field="" />
    </>
  )
}
