// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PENTORA, ALIVE: five cubes turning slowly, in the onboarding finale's visual language (the same projection,
 * lean, roll and breath as portal/pentora-lock.ts), with the node's health drawn on its own geometry.
 *
 *   edge          a private check (the edge's midpoint cell): bright when verified, faint and dashed when
 *                 undetermined, red when failed; its glow pulses while its check was observed in the last 20 s
 *   face dot      a private check at a face centre (6 per cube), same colours
 *   corner dot    one of the 20 corners two organs share: white when verified, hollow when undetermined, red failed
 *   cube colour   the organ (AUMLOK gold, Gate & Aura blue, Kira violet, Network mint, Body silver)
 *   cube drift    coherence: a cube whose cells are all verified sits locked in true (the onboarding lock); the
 *                 more of its cells are undetermined or failed, the further it drifts out of true
 *   live flash    Auma's work, from the sessions' live activity: an event lights its organ's cube (edges swell,
 *                 the cube shakes loose a little) and the energy fades in seconds; while a turn is open the whole
 *                 figure turns faster and leans further; when the turn ends it settles back to its state
 *   working wave  while an organ's events light its cube, a soft pulse travels round that cube's edges (while a
 *                 turn is open with no organ named, a gentler one on every cube); glow layer only, full on verified
 *                 edges and faint on the others, so it never makes an undetermined or failed edge read as healthy.
 *                 Its position is the cube's integrated phase (`turnPhase`, advanced by dt each frame),
 *                 never time multiplied by a changing speed, so a change of pace never makes it jump; its strength
 *                 eases in and out with the smoothed work and energy
 *
 * NERVOUS SYSTEM (Round 14, `spatial-pentora.tsx`): an independently recomputed `aura.v1` vector, when the surface
 * passes one, eases the cubes' sway into one shared phase (coherence), warms a soft field behind the figure from violet
 * to amber (surprise pressure) and quickens the breath, bounded at 1.8× (wake urgency). Without one, nothing changes.
 *
 * CHEAP: one SVG of 120 lines and 110 dots; React renders the structure and the states once per snapshot, and a
 * requestAnimationFrame loop at 30 frames a second only moves coordinates. It stops while the surface is hidden or
 * the page is in the background, and under reduced motion it draws one still frame and never animates.
 */
import { useEffect, useMemo, useRef } from 'react'
import type { AuraHealthView, CellReport } from './model.ts'
import { ORGANS, ORGAN_FACTS, PULSE_WINDOW_MS, organTally } from './model.ts'
import { CORNER_CELLS, CUBES, POINTS } from './tables.ts'
import { energyOf, type LiveState } from './activity.ts'
import css from './AuraPentora.module.css'
import {
  coupling, fieldColour, lerpModulation, modulationOf, PENTORA_IDLE, PentoraField, type AuraAxes, type PentoraModulation,
} from '../../spatial-pentora.tsx'

let fieldCount = 0

const TILT = 0.5
/** How many times the working wave goes round its cube per radian of the cube's own turn phase. */
const WAVE_TURNS = 4

type Projected = readonly [number, number]

const radius = Math.max(...CUBES.flatMap(cube => cube.corners).map(g => Math.hypot(...(POINTS[g] ?? [0, 0, 0]))))
const scale = 76 / radius

function project(g: number, angle: number, size: number, tilt: number, roll: number, breath: number): Projected {
  const [x, y, z] = POINTS[g] ?? [0, 0, 0]
  const c = Math.cos(angle), s = Math.sin(angle)
  const turned = -x * s + z * c
  const tilted = y * Math.cos(tilt) - turned * Math.sin(tilt)
  const depth = y * Math.sin(tilt) + turned * Math.cos(tilt)
  const near = size / (1 - depth / (radius * 4.5))
  const px = (x * c + z * s) * scale * near, py = -tilted * scale * near
  return [(px * Math.cos(roll) - py * Math.sin(roll)) * breath, (px * Math.sin(roll) + py * Math.cos(roll)) * breath]
}

function useStill(): boolean {
  return useMemo(() => {
    try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
  }, [])
}

/**
 * Draw the health snapshot on the Pentora.
 * @param props.view - the snapshot (stub in the preview; all-undetermined on a node).
 * @param props.active - false while the surface is hidden: the loop stops.
 * @param props.focus - the organ whose portal is open: its cube stays lit, the others step back.
 */
export function PentoraFigure({ view, active, focus, live, aura }: {
  readonly view: AuraHealthView
  readonly active: boolean
  readonly focus: number | null
  /** The live state, read every frame (a ref, so events never re-render the figure). */
  readonly live: { readonly current: LiveState }
  /** The periphery's recomputed axes, read every frame; null (or absent) leaves the figure at its calm idle. */
  readonly aura?: { readonly current: AuraAxes | null } | undefined
}) {
  const fieldId = useMemo(() => `pentora-field-${String(++fieldCount)}`, [])
  const svgRef = useRef<SVGSVGElement | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const still = useStill()
  // Under reduced motion the one still frame is redrawn whenever the axes change (the loop never runs there).
  const auraNow = aura?.current ?? null
  const stillAuraKey = still && auraNow !== null
    ? [auraNow.coherence, auraNow.surprisePressure, auraNow.driftRisk, auraNow.wakeUrgency].map(v => v.toFixed(3)).join('|')
    : ''

  // Per-cube private reports, for the edge and face states.
  const reportOf = (cube: number, global: number): CellReport | undefined => {
    const slot = CUBES[cube]?.private.indexOf(global) ?? -1
    return slot < 0 ? undefined : view.private[cube * 18 + slot]
  }

  useEffect(() => {
    const svg = svgRef.current
    if (svg === null) return
    const edges = Array.from(svg.querySelectorAll<SVGLineElement>('line[data-a]'))
    const dots = Array.from(svg.querySelectorAll<SVGCircleElement>('circle[data-g]'))
    const field = svg.querySelector<SVGCircleElement>('circle[data-pentora-field]')
    const fieldStops = Array.from(svg.querySelectorAll<SVGStopElement>('stop[data-pentora-field-stop]'))
    let mod: PentoraModulation = PENTORA_IDLE
    let breathPhase = 0
    let shownField = ''
    let frame = 0
    let last = 0
    let angle = 0.7
    let work = 0
    const smoothLit = ORGANS.map(() => 0)
    const turnPhase = ORGANS.map((_, c) => c * 1.7)
    // WORKING WAVE: where each glow edge sits round its cube (0..1, by the angle of its midpoint about the cube's
    // centre), fixed by the geometry, so the pulse travels round the cube rather than flickering edge by edge.
    const around = edges.map((line) => {
      const cube = CUBES[Number(line.dataset.cube)]
      const a = POINTS[Number(line.dataset.a)] ?? [0, 0, 0]
      const b = POINTS[Number(line.dataset.b)] ?? [0, 0, 0]
      if (cube === undefined) return 0
      const centre = [0, 1, 2].map(k => cube.corners.reduce((sum, g) => sum + (POINTS[g]?.[k] ?? 0), 0) / cube.corners.length)
      const mx = (a[0] + b[0]) / 2 - (centre[0] ?? 0)
      const my = (a[1] + b[1]) / 2 - (centre[1] ?? 0)
      const mz = (a[2] + b[2]) / 2 - (centre[2] ?? 0)
      return (Math.atan2(mz + 0.5 * my, mx) / (2 * Math.PI) + 1) % 1
    })
    const sizePhase = ORGANS.map((_, c) => c * 2.3)
    const born = performance.now()
    const draw = (now: number, dt: number, moving: boolean) => {
      const t = now - born
      const ramp = moving ? Math.min(1, t / 3500) : 0
      // NERVOUS SYSTEM: the modulation eases toward the periphery's axes (toward idle when there are none). At idle
      // every term below is as it was, except that the breath now runs on the figure's own clock.
      const target = modulationOf(aura?.current ?? null)
      mod = moving && dt > 0 ? lerpModulation(mod, target, dt) : target
      // The breath is an integrated phase: its rate can change (wake urgency) without the breath ever jumping.
      breathPhase = dt > 0 ? breathPhase + (dt / 1900) * mod.breathRate : t / 1900
      const tilt = TILT + (0.32 + 0.18 * work) * Math.sin(t / 4700) * ramp
      const roll = 0.24 * Math.sin(t / 7300 + 1) * ramp
      const breath = 1 + 0.035 * mod.breathDepth * Math.sin(breathPhase) * ramp
      const fieldNow = `${mod.fieldOpacity.toFixed(3)}|${mod.fieldWarmth.toFixed(3)}`
      if (field !== null && fieldNow !== shownField) {
        shownField = fieldNow
        field.setAttribute('opacity', mod.fieldOpacity.toFixed(3))
        const colour = fieldColour(mod.fieldWarmth)
        for (const stop of fieldStops) stop.setAttribute('stop-color', colour)
      }
      const fresh = viewRef.current
      // LIVE: each organ's energy from Auma's recent events; activity with no organ wakes every cube a little.
      const energy = moving ? energyOf(live.current, Date.now()) : new Map()
      const wake = 0.35 * (energy.get(null) ?? 0)
      const alpha = dt > 0 ? 1 - Math.exp(-dt / 260) : 1
      const lit = ORGANS.map((organ, c) => {
        const target = Math.min(1.4, (energy.get(organ) ?? 0) + wake)
        const next = moving ? (smoothLit[c] ?? 0) + (target - (smoothLit[c] ?? 0)) * alpha : target
        smoothLit[c] = next
        if (moving && dt > 0) {
          turnPhase[c] = (turnPhase[c] ?? c * 1.7) + dt * 0.0007 * (1 + 0.31 * c) * (1 + 0.85 * next)
          sizePhase[c] = (sizePhase[c] ?? c * 2.3) + dt * 0.0009 * (1 + 0.85 * next)
        }
        return next
      })
      // PHASE LOCK (coherence): coupling added to the cubes' rates and integrated, so they fall into step smoothly;
      // how far each sways still comes from its health below.
      if (moving && dt > 0 && mod.phaseLock > 0) {
        const pullTurn = coupling(turnPhase, mod.phaseLock)
        const pullSize = coupling(sizePhase, mod.phaseLock)
        for (let c = 0; c < turnPhase.length; c += 1) {
          turnPhase[c] = (turnPhase[c] ?? 0) + dt * (pullTurn[c] ?? 0)
          sizePhase[c] = (sizePhase[c] ?? 0) + dt * (pullSize[c] ?? 0)
        }
      }
      const offsets = ORGANS.map((organ, c) => {
        // COHERENCE: all verified = locked in true (0); undetermined cells loosen it a little, failed ones a lot.
        const tally = organTally(fresh, organ)
        const drift = Math.min(1, (tally.undetermined * 0.5 + tally.failed * 3) / 26) * Math.max(ramp, still ? 1 : 0) + 0.65 * (lit[c] ?? 0)
        const tp = moving ? (turnPhase[c] ?? c * 1.7) : t * 0.0007 * (1 + 0.31 * c) + c * 1.7
        const sp = moving ? (sizePhase[c] ?? c * 2.3) : t * 0.0009 + c * 2.3
        return [
          drift * 0.075 * Math.sin(tp),
          1 + drift * 0.035 * Math.cos(sp),
        ] as const
      })
      const at = (g: number, cube: number): Projected => {
        const [turn, size] = offsets[cube] ?? [0, 1]
        return project(g, angle + turn, size, tilt, roll, breath)
      }
      for (const [index, line] of edges.entries()) {
        const cube = Number(line.dataset.cube)
        const flash = Math.min(1, lit[cube] ?? 0)
        const [x1, y1] = at(Number(line.dataset.a), cube)
        const [x2, y2] = at(Number(line.dataset.b), cube)
        line.setAttribute('x1', x1.toFixed(2))
        line.setAttribute('y1', y1.toFixed(2))
        line.setAttribute('x2', x2.toFixed(2))
        line.setAttribute('y2', y2.toFixed(2))
        if (line.dataset.layer === 'glow') {
          // RECENT ACTIVITY: the glow swells and fades while the edge's check was observed in the last 20 seconds.
          const seen = fresh.private[Number(line.dataset.slot)]?.observed_at_ms ?? null
          const since = seen === null ? Infinity : Date.now() - seen
          const pulse = moving && since < PULSE_WINDOW_MS ? (1 - since / PULSE_WINDOW_MS) * (0.55 + 0.45 * Math.sin(t / 260)) : 0
          // WORKING WAVE: strength from this cube's energy (or, gently, the open turn); position from its integrated phase.
          const strength = moving ? Math.min(1, Math.max(0.35 * work, lit[cube] ?? 0)) : 0
          const crest = 0.5 + 0.5 * Math.cos(WAVE_TURNS * (turnPhase[cube] ?? 0) - 2 * Math.PI * (around[index] ?? 0))
          const weight = line.dataset.state === 'verified' ? 1 : 0.25
          const wave = weight * strength * crest * crest * crest
          const glow = Math.max(pulse, 0.7 * flash, 0.85 * wave)
          line.style.strokeOpacity = glow > 0.01 ? String(0.09 + 0.42 * glow) : ''
          line.style.strokeWidth = glow > 0.01 ? `${String(6 + 6 * glow)}px` : ''
        } else {
          line.style.strokeWidth = flash > 0.01 ? `${String(1.2 + 0.9 * flash)}px` : ''
        }
      }
      for (const dot of dots) {
        const g = Number(dot.dataset.g)
        const [x1, y1] = at(g, Number(dot.dataset.cube))
        // A corner belongs to two cubes: it sits between where each of them puts it (the same place when both are true).
        const [x2, y2] = dot.dataset.cube2 === undefined ? [x1, y1] : at(g, Number(dot.dataset.cube2))
        dot.setAttribute('cx', ((x1 + x2) / 2).toFixed(2))
        dot.setAttribute('cy', ((y1 + y2) / 2).toFixed(2))
      }
    }
    draw(still ? born + 9000 : born, 0, still)
    if (still || !active) return
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      if (document.hidden) {
        last = now
        return
      }
      const dt = last === 0 ? 16.67 : Math.min(50, Math.max(0, now - last))
      // While a turn is open the figure turns faster; when it ends the speed eases back smoothly.
      work += ((live.current.working ? 1 : 0) - work) * (1 - Math.exp(-dt / 450))
      angle += dt * (0.55 + 0.95 * work) / 6400
      last = now
      draw(now, dt, true)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame) }
  }, [active, still, stillAuraKey])

  return (
    <figure
      className={css.figure}
      data-still={still ? 'yes' : 'no'}
      aria-label="The Pentora: five organs as five interlocking cubes that flash and turn with her live activity"
    >
      <svg ref={svgRef} className={css.svg} viewBox="-92 -92 184 184" aria-hidden="true" focusable="false">
        <PentoraField id={fieldId} />
        {CUBES.map((cube, c) => {
          const organ = ORGANS[c] ?? 'body'
          return (
            <g key={organ} className={css.organ} data-organ={organ} data-dim={focus !== null && focus !== c ? 'yes' : 'no'}>
              <g className={css.cube} data-tone={ORGAN_FACTS[organ].tone} style={{ animationDelay: `${String(0.1 + c * 0.16)}s` }}>
                {(['glow', 'edge'] as const).map(layer => cube.edges.map(([a, b], e) => {
                  const mid = cube.edgeMidpoints[e] ?? -1
                  const slot = c * 18 + (cube.private.indexOf(mid))
                  return <line key={`${layer}-${String(e)}`} className={layer === 'glow' ? css.glow : css.edge} data-layer={layer}
                    data-cube={c} data-a={a} data-b={b} data-slot={slot} data-state={reportOf(c, mid)?.cell ?? 'undetermined'}
                    vectorEffect="non-scaling-stroke" />
                }))}
                {cube.faceCentres.map(g => <circle key={g} className={css.face} data-g={g} data-cube={c} r="1.7"
                  data-state={reportOf(c, g)?.cell ?? 'undetermined'} />)}
              </g>
            </g>
          )
        })}
        <g className={css.corners}>
          {CORNER_CELLS.map((g, k) => {
            const owners = CUBES.flatMap((each, c) => (each.corners.includes(g) ? [c] : []))
            return <circle key={g} className={css.corner} data-g={g} data-cube={owners[0]} data-cube2={owners[1]} r="1.9"
              data-state={view.corners[k]?.cell ?? 'undetermined'} />
          })}
        </g>
      </svg>
    </figure>
  )
}
