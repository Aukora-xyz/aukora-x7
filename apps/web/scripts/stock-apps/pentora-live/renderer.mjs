// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE LIVING PENTORA, behind Auma Live's voice field: all 110 cells of the five cubes, each in one of three colours
 * at every instant, and light travelling the lattice between them. A DISPLAY OF FLOW (flow.mjs), never health.
 *
 *   cells     soft glowing motes with a crisp core: corners largest (drawn once, with a thin second ring because two
 *             cubes share them), edge midpoints medium, face centres small; green IN, blue HOLD, purple OUT. The
 *             cores and rings are painted LAST and OVER the light, so every value stays readable while light travels
 *   the heart the centre of all five cubes: one larger soft orb with no value; blue with `think`, purple with `say`
 *   lines     the 12 edges (as half-segments through their midpoints), the face crosses and the spokes: hairlines at
 *             rest, depth-cued; a line between a green and a purple cell shimmers in both colours (tension)
 *   packets   light that travels (packets.mjs); a line carrying light takes its colour once, at a capped alpha, and
 *             the packet heads are held under the light bound (LIGHT), so peaks keep their hue instead of burning white
 *   motion    the compound's slow rigid turn, with the old figure's projection, lean, roll and breath
 *             (PentoraFigure.tsx `project`: span 76 view units, view box 184, tilt 0.5, perspective 4.5 radii, start
 *             angle 0.7, lean 0.32 + 0.18 x work over 4.7 s, roll 0.24 over 7.3 s, breath 3.5 % over 1.9 s, all eased
 *             in over 3.5 s); it turns faster while she thinks
 *
 * One <canvas> the size of the figure and its glow (CANVAS), centred where the figure sits; a 2D context, additive
 * light ('lighter') and pre-rendered glow sprites. No React, no WebGL, no dependency. Device pixel ratio capped at 2. Its own frame loop pauses while the page is hidden or the surface is not
 * active. Under reduced motion it draws ONE still frame each time a value changes: no packets, no turn.
 * Colours are the page's own tokens (--hue-l, --hue-c, --hue-r), read once, with auma-live.html's values as fallbacks.
 */
import { HEART, LATTICE, SHELL, pointAt } from './lattice.mjs'
import { createFlow, phaseCubeOf } from './flow.mjs'
import { createPackets, PACKETS } from './packets.mjs'

/** The three tokens, in value order (-1, 0, +1), with auma-live.html's own values as fallbacks. */
export const TOKENS = Object.freeze([
  Object.freeze(['--hue-l', Object.freeze([129, 212, 180])]),
  Object.freeze(['--hue-c', Object.freeze([150, 180, 255])]),
  Object.freeze(['--hue-r', Object.freeze([196, 170, 255])]),
])

export const PROJECTION = Object.freeze({
  VIEW: 184, SPAN: 76, TILT: 0.5, PERSPECTIVE: 4.5, START_ANGLE: 0.7, FIGURE_SHARE: 0.72, FIGURE_MAX_PX: 440, DPR_MAX: 2,
})

/** Core radius in view units by shell, at equal depth: corner > edge midpoint > face centre (strictly decreasing). */
export const CORE = Object.freeze([1.9, 1.55, 1.3])
/** A cell's core grows by this while a line that touches it carries light, so it stays readable inside the light. */
export const LIT_CORE = 1.2
const GLOW = 4.2
const LINE_ALPHA = { edge: 0.17, cross: 0.11, spoke: 0.085 }
const LEVELS = [0.4, 0.6, 0.8, 1]
const FLARE_MS = 420
const TENSION = 2

/**
 * The canvas holds the figure and its glow, not the whole field: a square of MARGIN times the figure's side, centred
 * where the figure sits, never more than SIDE_MAX_PX CSS px a side (so the backing store is at most that times the
 * capped pixel ratio). The figure's furthest reach (a near corner's flare at full lean and breath) measured 0.515 of the
 * figure's side from the centre over a 3,000-frame scripted run; the square's half side is 0.625, and a test holds every
 * draw inside the canvas.
 */
export const CANVAS = Object.freeze({ MARGIN: 1.25, SIDE_MAX_PX: 1024 })

/**
 * THE LIGHT BOUND. Additive light that piles up turns white and loses its hue; with these three colours no channel can
 * saturate while the summed alpha at a point stays at or below 1 (the brightest channel of each is at most 255). So at
 * the head of every packet drawn, the additive light of the whole frame there (every line path through it, every cell
 * glow, the heart and every packet covering it, each at its sprite's own profile) is held to BUDGET <= BOUND: the
 * renderer keeps a coarse tally of it in BIN-px squares and dims, or skips, a packet that would cross it. The cell
 * cores and rings are painted over the light (not added to it), so they are crisp in their own colour and outside it.
 */
export const LIGHT = Object.freeze({ BOUND: 1, BUDGET: 0.92, BIN: 6 })
/** A lit line (one carrying a packet) takes its packet's colour at this alpha, once, whatever runs on it. */
export const LIT_ALPHA = 0.28
/** A packet head's alpha before the light budget: a flow packet, a blue orbit packet. */
export const PACKET_ALPHA = Object.freeze({ flow: 0.6, orbit: 0.4 })
const PACKET_R = 3.2
const PACKETS_MAX = PACKETS.CAP

/** The alpha stops of each sprite (radial, centre 0 to edge 1); the colour is one of the three tokens. */
export const SPRITE_STOPS = Object.freeze({
  glow: Object.freeze([[0, 0.55], [0.25, 0.22], [0.6, 0.06], [1, 0]]),
  packet: Object.freeze([[0, 0.55], [0.25, 0.22], [0.6, 0.06], [1, 0]]),
  core: Object.freeze([[0, 1], [0.42, 0.95], [0.68, 0.22], [1, 0]]),
  heart: Object.freeze([[0, 0.9], [0.18, 0.45], [0.5, 0.12], [1, 0]]),
})

/** A sprite's alpha at `u` = distance / radius (piecewise linear between its stops; 0 at and past the edge). */
export function profileAt(stops, u) {
  if (!(u < 1)) return 0
  for (let k = 1; k < stops.length; k += 1) {
    const [b, vb] = stops[k], [a, va] = stops[k - 1]
    if (u <= b) return va + (vb - va) * ((u - a) / (b - a))
  }
  return 0
}

const RADIUS = Math.max(...LATTICE.cells.filter(cell => cell.shell === SHELL.CORNER).map(cell => Math.hypot(...cell.point)))

/**
 * The old figure's projection (PentoraFigure.tsx `project`, at cube size 1), in view units.
 * @returns [x, y, depth, near]: depth > 0 is nearer the viewer, `near` the perspective scale.
 */
export function project(point, angle, tilt, roll, breath) {
  const [x, y, z] = point
  const c = Math.cos(angle), s = Math.sin(angle)
  const turned = -x * s + z * c
  const tilted = y * Math.cos(tilt) - turned * Math.sin(tilt)
  const depth = y * Math.sin(tilt) + turned * Math.cos(tilt)
  const near = 1 / (1 - depth / (RADIUS * PROJECTION.PERSPECTIVE))
  const scale = PROJECTION.SPAN / RADIUS
  const px = (x * c + z * s) * scale * near, py = -tilted * scale * near
  return [(px * Math.cos(roll) - py * Math.sin(roll)) * breath, (px * Math.sin(roll) + py * Math.cos(roll)) * breath, depth, near]
}

/** The figure's square side in CSS px: where the old figure sat (`min(72%, 440px)` of the field). */
export function figureSize(width) {
  return Math.min(width * PROJECTION.FIGURE_SHARE, PROJECTION.FIGURE_MAX_PX)
}

/** Read the three tokens once; a missing or malformed token falls back to the page's own value. */
export function readTokens(win, doc) {
  let style = null
  try { style = win?.getComputedStyle?.(doc?.documentElement) ?? null } catch { style = null }
  return TOKENS.map(([name, fallback]) => {
    let raw = ''
    try { raw = String(style?.getPropertyValue?.(name) ?? '') } catch { raw = '' }
    const parts = raw.trim().split(',').map(parseFloat)
    return parts.length === 3 && !parts.some(Number.isNaN) ? parts : [...fallback]
  })
}

const rgba = (rgb, a) => `rgba(${String(rgb[0])}, ${String(rgb[1])}, ${String(rgb[2])}, ${String(a)})`
const level01 = v => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/**
 * Create the renderer. Every browser global can be handed in (the tests do); by default the page's own.
 * `options.box` is the element whose box the figure is centred in (by default the canvas's parent: Auma Live's layer).
 * @returns {{ element, canvas, resize, setActive, draw, destroy, stats, sprites, inspect }}
 */
export function createPentoraLive(options = {}) {
  const doc = options.document ?? globalThis.document
  const win = options.window ?? globalThis.window ?? globalThis
  // A page without animation frames gets no loop (0 is "no frame pending"), never a timer of its own.
  const requestFrame = options.requestAnimationFrame
    ?? (cb => (typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame(cb) : 0))
  const cancelFrame = options.cancelAnimationFrame
    ?? (id => { if (typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(id) })
  const clock = options.now ?? (() => globalThis.performance.now())
  const contextOf = options.getContext ?? ((canvas) => { try { return canvas.getContext('2d') } catch { return null } })

  const canvas = doc.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  const ctx = contextOf(canvas)

  const colours = readTokens(win, doc)
  const solid = colours.map(rgb => `rgb(${String(rgb[0])}, ${String(rgb[1])}, ${String(rgb[2])})`)
  const sprite = (size, c, stops) => {
    const image = doc.createElement('canvas')
    image.width = size; image.height = size
    const paint = contextOf(image)
    if (paint) {
      const g = paint.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
      for (const [at, alpha] of stops) g.addColorStop(at, rgba(c, alpha))
      paint.fillStyle = g
      paint.fillRect(0, 0, size, size)
    }
    return image
  }
  const sprites = Object.freeze({
    glow: Object.freeze(colours.map(c => sprite(64, c, SPRITE_STOPS.glow))),
    packet: Object.freeze(colours.map(c => sprite(32, c, SPRITE_STOPS.packet))),
    core: Object.freeze(colours.map(c => sprite(32, c, SPRITE_STOPS.core))),
    heart: Object.freeze([colours[1], colours[2]].map(c => sprite(96, c, SPRITE_STOPS.heart))),
  })

  const cells = LATTICE.cells
  const lines = LATTICE.lines
  const changedAt = new Float64Array(cells.length).fill(-Infinity)
  let reduced = null
  try { reduced = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null } catch { reduced = null }
  let still = reduced?.matches === true
  // Each cell hears the breath with its cube's phase; a shared corner takes the earlier of its two cubes (flow.mjs).
  // Under reduced motion the cube phase is NOT applied: the five-cube wave would otherwise play as a run of still
  // frames, which is motion for someone who asked for none. Both flows hear every level, so their histories stay
  // whole and a change of the setting while the page is open continues from the right values.
  const shellOf = cells.map(cell => cell.shell)
  const flowMoving = createFlow(shellOf, undefined, cells.map(cell => phaseCubeOf(cell.cubes)))
  const flowStill = createFlow(shellOf)
  const flow = {
    get values() { return (still ? flowStill : flowMoving).values },
    step(now, levels) {
      const moving = flowMoving.step(now, levels)
      const quiet = flowStill.step(now, levels)
      return still ? quiet : moving
    },
  }
  const packets = createPackets(LATTICE, { still })

  // Projected positions, indexed by global point (cells and the heart), in canvas CSS px.
  const positions = [...cells.map(cell => cell.g), HEART]
  const size = Math.max(...positions) + 1
  const X = new Float32Array(size), Y = new Float32Array(size), D = new Float32Array(size), N = new Float32Array(size)
  const POINTS_OF = positions.map(g => [g, pointAt(g)])
  const cellIndex = g => (g === HEART ? -1 : LATTICE.cellOf.get(g) ?? -1)
  const lineCells = lines.map(line => [cellIndex(line.a), cellIndex(line.b)])
  // Line buckets: colour x family x depth level, reused every frame.
  const FAMILIES = ['edge', 'cross', 'spoke']
  const buckets = [0, 1, 2].map(() => FAMILIES.map(() => LEVELS.map(() => [])))
  const mixed = []
  const litLines = [[], [], []]
  const litColour = new Int8Array(lines.length)
  const litCell = new Uint8Array(cells.length)

  const signals = { mic: 0, think: 0, say: 0 }
  const stats = { frames: 0, cores: 0, heart: 0, strokes: 0, packets: 0, packetsDrawn: 0, lit: 0, lastMs: 0, meanMs: 0 }
  let W = 0, H = 0, dpr = 1, side = 0, left = 0, top = 0
  let active = true
  let hidden = doc.hidden === true
  let destroyed = false
  let frame = 0
  let last = 0
  let angle = PROJECTION.START_ANGLE
  let work = 0
  let born = -1
  let drawnStill = false

  // THE LIGHT TALLY (LIGHT): additive light laid down this frame, per BIN x BIN CSS px square, counted conservatively
  // (a sprite counts its brightest point inside the square; a line path counts once in every square it comes within
  // half its width plus 1 px of). Only kept while packets run, and only in the squares a packet head covers (`wanted`):
  // no other square is ever read.
  let cols = 0, rows = 0
  let tally = new Float32Array(0), stamp = new Int32Array(0), wanted = new Uint8Array(0), summed = new Int32Array(0)
  let pathId = 0
  const heads = { x: new Float32Array(PACKETS_MAX), y: new Float32Array(PACKETS_MAX), r: new Float32Array(PACKETS_MAX) }
  function grid() {
    cols = Math.max(1, Math.ceil(side / LIGHT.BIN) + 1); rows = cols
    if (tally.length !== cols * rows) {
      tally = new Float32Array(cols * rows); stamp = new Int32Array(cols * rows); wanted = new Uint8Array(cols * rows)
      summed = new Int32Array((cols + 1) * (rows + 1))
    }
  }
  /** After the packets mark their squares: a summed table, so "is any wanted square in this rectangle?" is O(1). */
  function sumWanted() {
    const w = cols + 1
    for (let r = 0; r < rows; r += 1) {
      let run = 0
      for (let c = 0; c < cols; c += 1) { run += wanted[r * cols + c]; summed[(r + 1) * w + c + 1] = summed[r * w + c + 1] + run }
    }
  }
  /** Whether any wanted square lies in bins [x0..x1] x [y0..y1]. */
  const anyWanted = (x0, x1, y0, y1) => {
    if (x1 < x0 || y1 < y0) return false
    const w = cols + 1
    return summed[(y1 + 1) * w + x1 + 1] - summed[y0 * w + x1 + 1] - summed[(y1 + 1) * w + x0] + summed[y0 * w + x0] > 0
  }
  const binLo = lo => Math.max(0, Math.floor(lo / LIGHT.BIN))
  const binHi = (hi, n) => Math.min(n - 1, Math.floor(hi / LIGHT.BIN))
  /** The nearest point of bin (bx, by) to (x, y): its distance. */
  const binDistance = (x, y, bx, by) => {
    const dx = Math.max(bx * LIGHT.BIN - x, 0, x - (bx + 1) * LIGHT.BIN)
    const dy = Math.max(by * LIGHT.BIN - y, 0, y - (by + 1) * LIGHT.BIN)
    return Math.hypot(dx, dy)
  }
  function depositSprite(x, y, r, alpha, stops) {
    if (!(alpha > 0) || !(r > 0)) return
    const x0 = binLo(x - r), x1 = binHi(x + r, cols), y0 = binLo(y - r), y1 = binHi(y + r, rows)
    if (!anyWanted(x0, x1, y0, y1)) return
    for (let by = y0; by <= y1; by += 1) for (let bx = x0; bx <= x1; bx += 1) {
      const i = by * cols + bx
      if (wanted[i] === 0) continue
      const p = profileAt(stops, binDistance(x, y, bx, by) / r)
      if (p > 0) tally[i] += alpha * p
    }
  }
  function want(x, y, r) {
    const x0 = binLo(x - r), x1 = binHi(x + r, cols), y0 = binLo(y - r), y1 = binHi(y + r, rows)
    for (let by = y0; by <= y1; by += 1) for (let bx = x0; bx <= x1; bx += 1) wanted[by * cols + bx] = 1
  }
  /** The most alpha a sprite at (x, y) of radius r may have without any square crossing the budget. */
  function headroom(x, y, r, stops) {
    let most = Infinity
    const x0 = binLo(x - r), x1 = binHi(x + r, cols), y0 = binLo(y - r), y1 = binHi(y + r, rows)
    for (let by = y0; by <= y1; by += 1) for (let bx = x0; bx <= x1; bx += 1) {
      const p = profileAt(stops, binDistance(x, y, bx, by) / r)
      if (p > 0) most = Math.min(most, (LIGHT.BUDGET - tally[by * cols + bx]) / p)
    }
    return most
  }
  /** A line path of `list`'s lines: it counts once in every square it passes near. */
  function depositPath(list, alpha, width) {
    if (!(alpha > 0)) return
    pathId += 1
    if (pathId > 1e9) { pathId = 1; stamp.fill(0) }
    const h = width / 2 + 1
    const step = LIGHT.BIN / 2
    for (const line of list) {
      const ax = X[line.a], ay = Y[line.a], bx = X[line.b], by = Y[line.b]
      if (!anyWanted(binLo(Math.min(ax, bx) - h), binHi(Math.max(ax, bx) + h, cols), binLo(Math.min(ay, by) - h), binHi(Math.max(ay, by) + h, rows))) continue
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step))
      for (let k = 0; k <= n; k += 1) {
        const x = ax + (bx - ax) * (k / n), y = ay + (by - ay) * (k / n)
        const c0 = binLo(x - h), c1 = binHi(x + h, cols), r0 = binLo(y - h), r1 = binHi(y + h, rows)
        for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) {
          const i = r * cols + c
          if (wanted[i] !== 0 && stamp[i] !== pathId) { stamp[i] = pathId; tally[i] += alpha }
        }
      }
    }
  }

  const valueAt = g => (g === HEART ? -2 : flow.values[LATTICE.cellOf.get(g)])
  const colourAt = (g, other) => { const v = valueAt(g); return v === -2 ? valueAt(other) + 1 : v + 1 }
  const boxOf = () => options.box ?? canvas.parentElement ?? null
  let watched = null

  function measure() {
    const box = boxOf()
    let rect = null
    try { rect = box?.getBoundingClientRect?.() ?? null } catch { rect = null }
    W = Math.max(0, rect?.width ?? 0); H = Math.max(0, rect?.height ?? 0)
    dpr = Math.min(Number(win.devicePixelRatio) || 1, PROJECTION.DPR_MAX)
    side = W > 0 && H > 0 ? Math.min(figureSize(W) * CANVAS.MARGIN, CANVAS.SIDE_MAX_PX) : 0
    left = (W - side) / 2; top = (H - side) / 2
    const backing = Math.max(1, Math.round(side * dpr))
    if (canvas.width !== backing || canvas.height !== backing) { canvas.width = backing; canvas.height = backing }
    const style = canvas.style
    if (style) {
      style.width = `${String(side)}px`; style.height = `${String(side)}px`
      style.left = `${String(left)}px`; style.top = `${String(top)}px`
    }
    grid()
    if (box !== null && box !== watched && observer !== null) {
      try { if (watched !== null) observer.unobserve?.(watched); observer.observe?.(box); watched = box } catch { /* not observable */ }
    }
  }

  function render(now, moving) {
    if (ctx === null || side <= 0) return
    const started = clock()
    if (born < 0) born = now
    const t = now - born
    const ramp = moving ? Math.min(1, t / 3500) : 0
    const tilt = PROJECTION.TILT + (0.32 + 0.18 * work) * Math.sin(t / 4700) * ramp
    const roll = 0.24 * Math.sin(t / 7300 + 1) * ramp
    const breath = 1 + 0.035 * Math.sin(t / 1900) * ramp
    const turn = moving ? angle : PROJECTION.START_ANGLE
    const unit = figureSize(W) / PROJECTION.VIEW
    const cx = side / 2, cy = side / 2
    for (const [g, point] of POINTS_OF) {
      const [px, py, depth, near] = project(point, turn, tilt, roll, breath)
      X[g] = cx + px * unit; Y[g] = cy + py * unit; D[g] = (depth / RADIUS + 1) / 2; N[g] = near
    }
    const light = moving && packets.size > 0
    if (light) {
      tally.fill(0); wanted.fill(0)
      packets.list.forEach((p, k) => {
        const line = lines[p.line]
        const head = p.dir > 0 ? p.t : 1 - p.t
        heads.x[k] = X[line.a] + (X[line.b] - X[line.a]) * head
        heads.y[k] = Y[line.a] + (Y[line.b] - Y[line.a]) * head
        heads.r[k] = PACKET_R * unit * (N[line.a] + N[line.b]) / 2
        want(heads.x[k], heads.y[k], heads.r[k])
      })
      sumWanted()
    }

    // Which lines carry light now (the newest packet's colour), and which cells touch one.
    litColour.fill(-1); litCell.fill(0)
    for (const list of litLines) list.length = 0
    for (const p of packets.list) litColour[p.line] = p.value + 1
    for (let i = 0; i < lines.length; i += 1) {
      if (litColour[i] < 0) continue
      litLines[litColour[i]].push(lines[i])
      for (const c of lineCells[i]) if (c >= 0) litCell[c] = 1
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    let strokes = 0

    // THE LIGHT (additive). Cell glows: a changed cell flares.
    for (const cell of cells) {
      const colour = flow.values[cell.index] + 1
      const g = cell.g
      const flare = moving ? Math.max(0, 1 - (now - changedAt[cell.index]) / FLARE_MS) : 0
      const rg = CORE[cell.shell] * unit * N[g] * (GLOW + 3 * flare)
      const alpha = (0.45 + 0.55 * D[g]) * (0.6 + 0.4 * flare)
      ctx.globalAlpha = alpha
      ctx.drawImage(sprites.glow[colour], X[g] - rg, Y[g] - rg, rg * 2, rg * 2)
      if (light) depositSprite(X[g], Y[g], rg, alpha, SPRITE_STOPS.glow)
    }

    // The heart: no value; blue with her thinking, purple with her voice.
    const rh = 9 * unit * (1 + 0.35 * signals.say + 0.2 * signals.think)
    const heartAlpha = [0.18 + 0.6 * signals.think, 0.75 * signals.say]
    heartAlpha.forEach((alpha, k) => {
      ctx.globalAlpha = alpha
      ctx.drawImage(sprites.heart[k], X[HEART] - rh, Y[HEART] - rh, rh * 2, rh * 2)
      if (light) depositSprite(X[HEART], Y[HEART], rh, alpha, SPRITE_STOPS.heart)
    })

    // LINES: every line stroked exactly once a frame. Hairlines batched by colour, family and depth; a line between two
    // values carries both colours; a line carrying light takes that light's colour at LIT_ALPHA instead.
    for (const byFamily of buckets) for (const byLevel of byFamily) for (const list of byLevel) list.length = 0
    mixed.length = 0
    for (const line of lines) {
      if (litColour[line.index] >= 0) continue
      const ca = colourAt(line.a, line.b), cb = colourAt(line.b, line.a)
      if (ca !== cb) { mixed.push(line); continue }
      const level = Math.min(LEVELS.length - 1, Math.floor(((D[line.a] + D[line.b]) / 2) * LEVELS.length))
      buckets[ca][FAMILIES.indexOf(line.family)][level].push(line)
    }
    const strokeBatch = (list, alpha, width) => {
      ctx.beginPath()
      for (const line of list) { ctx.moveTo(X[line.a], Y[line.a]); ctx.lineTo(X[line.b], Y[line.b]) }
      ctx.stroke()
      strokes += 1
      if (light) depositPath(list, alpha, width)
    }
    ctx.lineWidth = 0.75
    buckets.forEach((byFamily, colour) => byFamily.forEach((byLevel, family) => byLevel.forEach((list, level) => {
      if (list.length === 0) return
      const alpha = LINE_ALPHA[FAMILIES[family]] * LEVELS[level]
      ctx.globalAlpha = alpha
      ctx.strokeStyle = solid[colour]
      strokeBatch(list, alpha, 0.75)
    })))
    for (const line of mixed) {
      const ca = colourAt(line.a, line.b), cb = colourAt(line.b, line.a)
      const tension = ca + cb === 2 && ca !== 1
      const depth = 0.5 + 0.5 * ((D[line.a] + D[line.b]) / 2)
      const shimmer = tension && moving ? 0.65 + 0.35 * Math.sin(now / 110 + line.index * 1.7) : 1
      const gradient = ctx.createLinearGradient(X[line.a], Y[line.a], X[line.b], Y[line.b])
      gradient.addColorStop(0, solid[ca])
      gradient.addColorStop(1, solid[cb])
      const alpha = LINE_ALPHA[line.family] * depth * (tension ? TENSION * shimmer : 1.2)
      const width = tension ? 1.15 : 0.85
      ctx.globalAlpha = alpha
      ctx.lineWidth = width
      ctx.strokeStyle = gradient
      strokeBatch([line], alpha, width)
    }
    ctx.lineWidth = 1.1
    litLines.forEach((list, colour) => {
      if (list.length === 0) return
      ctx.globalAlpha = LIT_ALPHA
      ctx.strokeStyle = solid[colour]
      strokeBatch(list, LIT_ALPHA, 1.1)
    })

    // PACKETS: a small glowing head on its lit line, held under the light bound.
    let drawn = 0
    for (let k = 0; k < packets.size; k += 1) {
      const p = packets.list[k]
      const x = heads.x[k], y = heads.y[k], r = heads.r[k]
      const alpha = Math.min(PACKET_ALPHA[p.kind], headroom(x, y, r, SPRITE_STOPS.packet))
      if (!(alpha > 0.02)) continue
      ctx.globalAlpha = alpha
      ctx.drawImage(sprites.packet[p.value + 1], x - r, y - r, r * 2, r * 2)
      depositSprite(x, y, r, alpha, SPRITE_STOPS.packet)
      drawn += 1
    }

    // THE CELLS, painted over the light: every one of the 110 in its value's colour, crisp at every moment.
    ctx.globalCompositeOperation = 'source-over'
    ctx.lineWidth = 0.6
    const rings = [[], [], []]
    for (const cell of cells) if (cell.shell === SHELL.CORNER) rings[flow.values[cell.index] + 1].push(cell)
    rings.forEach((list, colour) => {
      if (list.length === 0) return
      ctx.globalAlpha = 0.42
      ctx.strokeStyle = solid[colour]
      ctx.beginPath()
      for (const cell of list) {
        const r = CORE[SHELL.CORNER] * unit * N[cell.g] * 2.3
        ctx.moveTo(X[cell.g] + r, Y[cell.g])
        ctx.arc(X[cell.g], Y[cell.g], r, 0, Math.PI * 2)
      }
      ctx.stroke()
      strokes += 1
    })
    let cores = 0
    for (const cell of cells) {
      const g = cell.g
      const rc = CORE[cell.shell] * unit * N[g] * (litCell[cell.index] === 1 ? LIT_CORE : 1)
      ctx.globalAlpha = 0.7 + 0.3 * D[g]
      ctx.drawImage(sprites.core[flow.values[cell.index] + 1], X[g] - rc, Y[g] - rc, rc * 2, rc * 2)
      cores += 1
    }
    ctx.globalAlpha = 1

    const spent = clock() - started
    stats.frames += 1
    stats.cores = cores
    stats.heart = 2
    stats.strokes = strokes
    stats.packets = packets.size
    stats.packetsDrawn = drawn
    stats.lit = litLines.reduce((n, list) => n + list.length, 0)
    stats.lastMs = spent
    stats.meanMs = stats.frames === 1 ? spent : stats.meanMs + (spent - stats.meanMs) * 0.05
  }

  const running = () => active && !hidden && !still && !destroyed

  function advance(now, dt) {
    const { changed } = flow.step(now, signals)
    for (const i of changed) {
      changedAt[i] = now
      packets.emitChange(cells[i].g, flow.values[i])
    }
    packets.step(dt, signals.think)
    // The turn speeds up with her thinking, easing in and out (the old figure's 450 ms ease, 0.55 + 0.95 x work).
    work += (signals.think - work) * (1 - Math.exp(-dt / 450))
    angle += dt * (0.55 + 0.95 * work) / 6400
  }

  function tick(now) {
    frame = 0
    if (!running()) return
    if (side <= 0) measure()
    const dt = last === 0 ? 16.67 : Math.min(50, Math.max(0, now - last))
    last = now
    advance(now, dt)
    render(now, true)
    schedule()
  }

  function schedule() { if (frame === 0 && running()) frame = requestFrame(tick) }
  function halt() { if (frame !== 0) { cancelFrame(frame); frame = 0 } last = 0 }

  function drawStill() {
    if (!active || destroyed || hidden) return
    if (side <= 0) measure()
    render(clock(), false)
    drawnStill = side > 0 && ctx !== null
  }

  const onVisibility = () => {
    hidden = doc.hidden === true
    if (hidden) halt()
    else if (still) drawStill()
    else schedule()
  }
  const onMotion = () => {
    still = reduced?.matches === true
    packets.setStill(still)
    if (still) { halt(); changedAt.fill(-Infinity); drawStill() } else schedule()
  }
  doc.addEventListener?.('visibilitychange', onVisibility)
  reduced?.addEventListener?.('change', onMotion)
  let observer = null
  try { observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => { api.resize() }) : null } catch { observer = null }

  const api = {
    element: canvas,
    canvas,
    stats,
    sprites,
    resize() {
      if (destroyed) return
      measure()
      if (still) drawStill()
    },
    setActive(value) {
      active = Boolean(value)
      if (!active) { halt(); return }
      if (still) drawStill()
      else schedule()
    },
    /** Auma Live's frame: the three levels (and a colour this renderer does not need). */
    draw(_elapsedMs, state) {
      signals.mic = level01(state?.mic)
      signals.think = level01(state?.think)
      signals.say = level01(state?.say)
      if (!still || !active || destroyed) return
      const { changed } = flow.step(clock(), signals)
      if (changed.length > 0 || !drawnStill) drawStill()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      halt()
      doc.removeEventListener?.('visibilitychange', onVisibility)
      reduced?.removeEventListener?.('change', onMotion)
      try { observer?.disconnect() } catch { /* already gone */ }
      packets.clear()
      canvas.remove?.()
    },
    /** For the tests and the harness: what the renderer holds right now. */
    inspect() {
      return {
        values: flow.values, packets: packets.list, still, running: running(), frame, angle, work, size: [W, H, dpr],
        layout: { side, left, top, backing: canvas.width },
        /** a cell's or the heart's canvas CSS px and perspective scale in the last frame drawn */
        at: g => [X[g], Y[g], N[g]],
      }
    },
  }
  if (options.box) measure()
  schedule()
  return api
}
