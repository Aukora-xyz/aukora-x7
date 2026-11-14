// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PENTORA, ALIVE: five cubes turning slowly, in the onboarding finale's visual language (the same projection,
 * lean, roll and breath as portal/pentora-lock.ts), with the node's health drawn on its own geometry.
 *
 *   edge          a private check (the edge's midpoint cell): bright when verified, faint and dashed when
 *                 undetermined, red when failed; its glow pulses while its check was observed in the last 20 s
 *   midpoint dot  the same edge cell drawn as a glyph of its own (12 per cube), at the midpoint of its edge as drawn,
 *                 in the face dot's state colours
 *   face dot      a private check at a face centre (6 per cube): filled in the cube's colour when verified, hollow
 *                 when undetermined, red when failed
 *   corner dot    one of the 20 corners two organs share: white when verified, hollow when undetermined, red failed
 *   centre ring   the 27th position of every cube, the centre all five share: a hairline ring with no state, because
 *                 it is not a cell
 *   sizes         corner 1.9, edge midpoint 1.55, face centre 1.3 (the living Pentora in Auma Live uses the same order)
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
 * TWO CHANNELS ON EVERY CELL, never mistaken for each other:
 *   ring          HEALTH, the dot's stroke: quiet neutral when undetermined (every cell on x6.1, where no host serves a
 *                 health snapshot), the cube's colour when verified, red when failed. Flow never writes it.
 *   core          FLOW, the dot's fill: a filled disc of 55% of the ring's radius, in the conversation's three colours
 *                 (flow.ts: mint IN, the owner's message arriving; blue HOLD, her working; violet OUT, her answer
 *                 arriving), resting blue and faint while nothing happens. Health never writes it.
 *   lit line      when a cell's flow value changes, each edge through it carries the new colour for 400 ms, growing from
 *                 the changed end (an overlay line drawn over its cube's edges and under its dots, from that cube's pool of
 *                 12, 60 in all; the edge itself is untouched), and stays lit while its cells disagree (the front); an
 *                 edge whose health is failed is never lit.
 *
 * CHEAP: one SVG of 120 lines, 110 cell dots (20 corners, 60 edge midpoints, 30 face centres) and the centre ring;
 * React renders the structure and the states once per snapshot, and a requestAnimationFrame loop at the display's own
 * rate (no cap) only moves coordinates: 4 writes per line and 2 per dot, 700 in a frame. Flow adds nothing at rest: a
 * core is written (2 attributes) only when its value changes, and a lit line costs 4 coordinates plus at most 3 style
 * properties a frame (tests/pentora-flow.client.spec.tsx measures both). It stops while the surface is hidden or the
 * page is in the background, and under reduced motion it draws one still frame, never animates, and only recolours cores
 * when their value changes (no lit lines, no cube phase).
 */
import { useEffect, useMemo, useRef } from 'react'
import type { AuraHealthView, CellReport } from './model.ts'
import { ORGANS, ORGAN_FACTS, PULSE_WINDOW_MS, organTally } from './model.ts'
import { CORNER_CELLS, CUBES, POINTS } from './tables.ts'
import { energyOf, type ActivityOrgan, type LiveState } from './activity.ts'
import { EMPTY_FEED, FLOW, VALUE, createFlow, levelsAt, type FlowFeed } from './flow.ts'
import css from './AuraPentora.module.css'
import {
  coupling, fieldColour, lerpModulation, modulationOf, PENTORA_IDLE, PentoraField, type AuraAxes, type PentoraModulation,
} from '../../spatial-pentora.tsx'

let fieldCount = 0

const TILT = 0.5
/** How many times the working wave goes round its cube per radian of the cube's own turn phase. */
const WAVE_TURNS = 4

/** At most this many edges carry flow light at once (the pool of overlay lines). */
export const MAX_LIT = 60
/** A lit edge's colour grows from the changed end to the whole edge in this long. */
export const TRAVEL_MS = 400
/** Once its cells agree again, a lit edge fades out in this long. */
const FADE_MS = 220
/** Under reduced motion the flow is stepped this often (cores only; nothing moves). */
export const STILL_STEP_MS = 100
/** The inline style a lit line carries while it travels and fades; cleared when it is released or a pass starts. */
const LIT_STYLE = ['stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity'] as const

/** A core's look: the flow value, with HOLD shown resting (faint) while no turn is being worked. */
export type CoreLook = 'rest' | 'hold' | 'in' | 'out'
const LOOKS: readonly CoreLook[] = ['rest', 'hold', 'in', 'out']
const SHELL_OF: Readonly<Record<string, number>> = { corner: 0, edge: 1, face: 2 }

function lookOf(value: number, thinking: boolean): CoreLook {
  if (value === VALUE.IN) return 'in'
  if (value === VALUE.OUT) return 'out'
  return thinking ? 'hold' : 'rest'
}
const colourOf = (value: number): CoreLook => (value === VALUE.IN ? 'in' : value === VALUE.OUT ? 'out' : 'hold')

/** One lit edge: the colour it carries, when it was lit, where it grows from (0 the a end, 1 the b end, .5 the middle). */
interface LitEdge {
  value: number
  at: number
  from: number
  readonly slot: SVGLineElement
  travelled: boolean
  settledAt: number | null
}

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
export function PentoraFigure({ view, active, focus, live, aura, flow }: {
  readonly view: AuraHealthView
  readonly active: boolean
  readonly focus: number | null
  /** The live state, read every frame (a ref, so events never re-render the figure). */
  readonly live: { readonly current: LiveState }
  /** The periphery's recomputed axes, read every frame; null (or absent) leaves the figure at its calm idle. */
  readonly aura?: { readonly current: AuraAxes | null } | undefined
  /** The page's flow feed (flow.ts), read every step; absent, every core rests. */
  readonly flow?: { readonly current: FlowFeed } | undefined
}) {
  const fieldId = useMemo(() => `pentora-field-${String(++fieldCount)}`, [])
  /** A core's fill: its look's gradient; a corner's keeps the dark hollow between core and ring it always had. */
  const coreFill = (look: CoreLook, corner: boolean) => `url(#${fieldId}-core-${look}${corner ? '-c' : ''})`
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
    // Corner and face dots are projected; a midpoint dot is written beside its edge line, from that line's own ends.
    const dots = Array.from(svg.querySelectorAll<SVGCircleElement>('circle[data-g]:not([data-edge])'))
    const midpoints = new Map<string, SVGCircleElement>()
    for (const dot of svg.querySelectorAll<SVGCircleElement>('circle[data-edge]')) {
      midpoints.set(`${dot.dataset.cube ?? ''}:${dot.dataset.edge ?? ''}`, dot)
    }
    const midpointOf = edges.map(line => (line.dataset.layer === 'edge'
      ? midpoints.get(`${line.dataset.cube ?? ''}:${line.dataset.edge ?? ''}`) ?? null
      : null))
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

    // FLOW (flow.ts): one flow value per cell, written on the cell's core only; the ring (class, data-state) is health's.
    const cells = Array.from(svg.querySelectorAll<SVGCircleElement>('circle[data-g]'))
    const cellOfG = new Map(cells.map((dot, i) => [Number(dot.dataset.g), i]))
    const isCorner = cells.map(dot => dot.dataset.shell === 'corner')
    // A corner's data-cube is the lower of its two cubes (the phase it takes). Under reduced motion there is no cube phase.
    const cellFlow = createFlow(
      cells.map(dot => SHELL_OF[dot.dataset.shell ?? ''] ?? 0),
      FLOW,
      cells.map(dot => (still ? 0 : Number(dot.dataset.cube) || 0)),
    )
    const shownLook = cells.map(dot => dot.getAttribute('data-flow') ?? '')
    let thinking = false
    let flowClock = 0
    const paint = (i: number, look: CoreLook) => {
      const dot = cells[i]
      if (dot === undefined || shownLook[i] === look) return
      shownLook[i] = look
      dot.setAttribute('data-flow', look)
      dot.setAttribute('fill', coreFill(look, isCorner[i] === true))
    }
    // A new pass starts from rest (every value HOLD): repaint only the cores that are not resting.
    for (let i = 0; i < cells.length; i += 1) paint(i, 'rest')
    // LIT EDGES: the edge-layer lines, each with its two corner cells and its midpoint cell. Each cube has its own pool
    // of overlay slots, one per edge, drawn over its edges and under its dots (60 in all).
    const slots = Array.from(svg.querySelectorAll<SVGLineElement>('line[data-flow-slot]'))
    const free = ORGANS.map(() => [] as SVGLineElement[])
    for (const slot of [...slots].reverse()) {
      // A new pass starts every slot clean: a pass that stopped mid-fade must not leave its opacity or dash behind.
      if (slot.getAttribute('data-lit') !== 'no') slot.setAttribute('data-lit', 'no')
      for (const property of LIT_STYLE) if (slot.style.getPropertyValue(property) !== '') slot.style.setProperty(property, '')
      free[Number(slot.dataset.flowCube)]?.push(slot)
    }
    const flowEdges = edges.map((line) => {
      if (line.dataset.layer !== 'edge') return null
      const mid = CUBES[Number(line.dataset.cube)]?.edgeMidpoints[Number(line.dataset.edge)] ?? -1
      return { line, a: cellOfG.get(Number(line.dataset.a)) ?? -1, b: cellOfG.get(Number(line.dataset.b)) ?? -1, m: cellOfG.get(mid) ?? -1 }
    })
    const edgesOfCell = cells.map(() => [] as number[])
    flowEdges.forEach((edge, index) => {
      if (edge === null) return
      for (const i of [edge.a, edge.m, edge.b]) edgesOfCell[i]?.push(index)
    })
    const litEdges = new Map<number, LitEdge>()
    const light = (i: number, value: number, t: number) => {
      for (const index of edgesOfCell[i] ?? []) {
        const edge = flowEdges[index]
        // Health first: an edge whose check failed stays red and never carries flow.
        if (edge === null || edge === undefined || edge.line.dataset.state === 'failed') continue
        const from = i === edge.a ? 0 : i === edge.b ? 1 : 0.5
        const current = litEdges.get(index)
        // The same colour still travelling along this edge: let it finish rather than restart it.
        if (current !== undefined && current.value === value && t - current.at < TRAVEL_MS) continue
        const slot = current?.slot ?? free[Number(edge.line.dataset.cube)]?.pop()
        if (slot === undefined) continue
        if (current?.value !== value) slot.setAttribute('data-flow', colourOf(value))
        if (current === undefined) {
          slot.setAttribute('data-lights', `${edge.line.dataset.cube ?? ''}:${edge.line.dataset.edge ?? ''}`)
          slot.setAttribute('data-lit', 'yes')
        } else if (current.settledAt !== null) slot.style.setProperty('stroke-opacity', '')
        litEdges.set(index, { value, at: t, from, slot, travelled: false, settledAt: null })
      }
    }
    const release = (index: number, state: LitEdge) => {
      state.slot.setAttribute('data-lit', 'no')
      for (const property of LIT_STYLE) state.slot.style.setProperty(property, '')
      litEdges.delete(index)
      free[Number(state.slot.dataset.flowCube)]?.push(state.slot)
    }
    /** Step the flow at `t` (client ms) from the page's three levels; recolour only the cores whose value changed. */
    const stepFlow = (t: number) => {
      flowClock = t
      const levels = levelsAt(flow?.current ?? EMPTY_FEED, t)
      const { values, changed } = cellFlow.step(t, levels)
      const nowThinking = levels.think > 0.05
      if (nowThinking !== thinking) {
        thinking = nowThinking
        for (let i = 0; i < cells.length; i += 1) if (values[i] === VALUE.HOLD) paint(i, lookOf(VALUE.HOLD, thinking))
      }
      for (const i of changed) {
        const value = values[i] ?? VALUE.HOLD
        paint(i, lookOf(value, thinking))
        if (!still) light(i, value, t)
      }
    }
    /** A lit edge, drawn over its edge from that edge's own ends this frame: grow, hold while the front stands, fade. */
    const drawLit = (index: number, x1: number, y1: number, x2: number, y2: number) => {
      const state = litEdges.get(index)
      const edge = flowEdges[index]
      if (state === undefined || edge === null || edge === undefined) return
      const age = flowClock - state.at
      const values = cellFlow.values
      const agree = values[edge.a] === values[edge.m] && values[edge.m] === values[edge.b]
      if (!state.travelled && age >= TRAVEL_MS) {
        state.travelled = true
        state.slot.style.setProperty('stroke-dasharray', '')
        state.slot.style.setProperty('stroke-dashoffset', '')
      }
      if (state.travelled && agree) {
        state.settledAt ??= flowClock
        const fade = (flowClock - state.settledAt) / FADE_MS
        if (fade >= 1) {
          release(index, state)
          return
        }
        state.slot.style.setProperty('stroke-opacity', (0.85 * (1 - fade)).toFixed(3))
      } else if (state.settledAt !== null) {
        state.settledAt = null
        state.slot.style.setProperty('stroke-opacity', '')
      }
      state.slot.setAttribute('x1', x1.toFixed(2))
      state.slot.setAttribute('y1', y1.toFixed(2))
      state.slot.setAttribute('x2', x2.toFixed(2))
      state.slot.setAttribute('y2', y2.toFixed(2))
      if (!state.travelled) {
        // pathLength 1: the visible piece is [start, start + p], growing from the changed end (or the middle).
        const p = Math.max(0, age) / TRAVEL_MS
        const start = state.from === 0 ? 0 : state.from === 1 ? 1 - p : 0.5 - p / 2
        state.slot.style.setProperty('stroke-dasharray', `${p.toFixed(3)} 2`)
        state.slot.style.setProperty('stroke-dashoffset', (-start).toFixed(3))
      }
    }
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
      const energy = moving ? energyOf(live.current, Date.now()) : new Map<ActivityOrgan, number>()
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
        // EDGE MIDPOINT: its cell's dot sits at the midpoint of the edge as this cube draws it, wobble and all.
        const midpoint = midpointOf[index] ?? null
        if (midpoint !== null) {
          midpoint.setAttribute('cx', ((x1 + x2) / 2).toFixed(2))
          midpoint.setAttribute('cy', ((y1 + y2) / 2).toFixed(2))
        }
        if (litEdges.size > 0 && litEdges.has(index)) drawLit(index, x1, y1, x2, y2)
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
    if (!active) return
    if (still) {
      // Reduced motion: nothing moves; a core takes its new colour when its value changes, all cubes together.
      const timer = setInterval(() => { if (!document.hidden) stepFlow(Date.now()) }, STILL_STEP_MS)
      return () => { clearInterval(timer) }
    }
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
      stepFlow(Date.now())
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
        <defs data-pentora-cores="">
          {LOOKS.flatMap(look => [false, true].map(corner => (
            <radialGradient key={`${look}-${String(corner)}`} id={`${fieldId}-core-${look}${corner ? '-c' : ''}`}>
              <stop offset="0" className={css.core} data-look={look} />
              <stop offset="0.55" className={css.core} data-look={look} />
              <stop offset="0.55" className={corner ? css.hollow : css.clear} />
              <stop offset="1" className={corner ? css.hollow : css.clear} />
            </radialGradient>
          )))}
        </defs>
        {CUBES.map((cube, c) => {
          const organ = ORGANS[c] ?? 'body'
          return (
            <g key={organ} className={css.organ} data-organ={organ} data-dim={focus !== null && focus !== c ? 'yes' : 'no'}>
              <g className={css.cube} data-tone={ORGAN_FACTS[organ].tone} style={{ animationDelay: `${String(0.1 + c * 0.16)}s` }}>
                {(['glow', 'edge'] as const).map(layer => cube.edges.map(([a, b], e) => {
                  const mid = cube.edgeMidpoints[e] ?? -1
                  const slot = c * 18 + (cube.private.indexOf(mid))
                  return <line key={`${layer}-${String(e)}`} className={layer === 'glow' ? css.glow : css.edge} data-layer={layer}
                    data-cube={c} data-edge={e} data-a={a} data-b={b} data-slot={slot} data-state={reportOf(c, mid)?.cell ?? 'undetermined'}
                    vectorEffect="non-scaling-stroke" />
                }))}
                {/* FLOW LIGHT: this cube's overlay slots, over its edges and under its dots, dimmed and formed with it. */}
                {cube.edges.map((_, k) => <line key={`flow-${String(k)}`} className={css.flowLine} data-flow-slot={c * cube.edges.length + k}
                  data-flow-cube={c} data-lit="no" data-flow="hold" pathLength={1} />)}
                {cube.faceCentres.map(g => <circle key={g} className={css.face} data-g={g} data-shell="face" data-cube={c} r="1.3"
                  data-state={reportOf(c, g)?.cell ?? 'undetermined'} data-flow="rest" fill={coreFill('rest', false)} />)}
                {cube.edgeMidpoints.map((g, e) => <circle key={g} className={css.mid} data-g={g} data-shell="edge" data-cube={c}
                  data-edge={e} r="1.55" data-state={reportOf(c, g)?.cell ?? 'undetermined'} data-flow="rest" fill={coreFill('rest', false)} />)}
              </g>
            </g>
          )
        })}
        <circle className={css.centre} data-pentora-centre="" cx="0" cy="0" r="2.4" aria-hidden="true" />
        <g className={css.corners}>
          {CORNER_CELLS.map((g, k) => {
            const owners = CUBES.flatMap((each, c) => (each.corners.includes(g) ? [c] : []))
            return <circle key={g} className={css.corner} data-g={g} data-shell="corner" data-cube={owners[0]} data-cube2={owners[1]} r="1.9"
              data-state={view.corners[k]?.cell ?? 'undetermined'} data-flow="rest" fill={coreFill('rest', true)} />
          })}
        </g>
      </svg>
    </figure>
  )
}
