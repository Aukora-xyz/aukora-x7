// @vitest-environment jsdom
/**
 * The living Pentora's renderer, over a recording 2D context and a hand-driven frame clock. Every
 * cell is drawn every frame, the colours are only the page's three tokens, it pauses and cleans up, it is still under
 * reduced motion, and Auma Live's seam (`createAuraTrace`) keeps its exact shape. Job 2: the shells' core sizes are in
 * order, the canvas is only the figure and its glow and the figure sits exactly where it sat, peaks keep their hue
 * (the light bound), and the cells are painted after every line and packet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuraTrace } from '../scripts/stock-apps/auma-live-trace.mjs'
import { LATTICE, SHELL } from '../scripts/stock-apps/pentora-live/lattice.mjs'
import { PACKETS } from '../scripts/stock-apps/pentora-live/packets.mjs'
import {
  CANVAS, CORE, createPentoraLive, figureSize, LIGHT, LIT_ALPHA, LIT_CORE, profileAt, project, PROJECTION, SPRITE_STOPS, TOKENS,
  type PentoraLiveOptions, type Stops,
} from '../scripts/stock-apps/pentora-live/renderer.mjs'

type Call = {
  readonly name: string
  readonly args: readonly unknown[]
  readonly alpha: number
  readonly composite: string
  readonly lineWidth: number
}
/** One stroked path: its straight segments, whether it has arcs, and the state it was stroked with. */
type Path = {
  readonly segments: (readonly [number, number, number, number])[]
  arcs: number
  alpha: number
  composite: string
  lineWidth: number
  at: number
}

/** A 2D context that records what is drawn; gradients record their colour stops. */
class RecordingContext {
  calls: Call[] = []
  colours: string[] = []
  composites: string[] = []
  globalAlpha = 1
  lineWidth = 1
  lineCap = 'butt'
  private fill: unknown = ''
  private stroke_: unknown = ''
  private composite = 'source-over'
  get fillStyle(): unknown { return this.fill }
  set fillStyle(v: unknown) { this.fill = v; if (typeof v === 'string') this.colours.push(v) }
  get strokeStyle(): unknown { return this.stroke_ }
  set strokeStyle(v: unknown) { this.stroke_ = v; if (typeof v === 'string') this.colours.push(v) }
  get globalCompositeOperation(): string { return this.composite }
  set globalCompositeOperation(v: string) { this.composite = v; this.composites.push(v) }
  private record(name: string, args: readonly unknown[]) {
    this.calls.push({ name, args, alpha: this.globalAlpha, composite: this.composite, lineWidth: this.lineWidth })
  }
  private gradient() { return { addColorStop: (_at: number, colour: string) => { this.colours.push(colour) } } }
  createRadialGradient(...args: number[]) { this.record('createRadialGradient', args); return this.gradient() }
  createLinearGradient(...args: number[]) { this.record('createLinearGradient', args); return this.gradient() }
  setTransform(...args: number[]) { this.record('setTransform', args) }
  clearRect(...args: number[]) { this.record('clearRect', args) }
  // Recorded as plain calls; paths() below rebuilds the stroked paths from them.
  fillRect(...args: number[]) { this.record('fillRect', args) }
  beginPath() { this.record('beginPath', []) }
  moveTo(...args: number[]) { this.record('moveTo', args) }
  lineTo(...args: number[]) { this.record('lineTo', args) }
  arc(...args: number[]) { this.record('arc', args) }
  stroke() { this.record('stroke', [this.composite]) }
  drawImage(...args: unknown[]) { this.record('drawImage', [...args, this.composite]) }
}

/** A frame clock driven by hand. */
function frames() {
  const queue = new Map<number, (now: number) => void>()
  let next = 1
  let now = 0
  const cancelled: number[] = []
  return {
    requestAnimationFrame: (cb: (now: number) => void) => { const id = next++; queue.set(id, cb); return id },
    cancelAnimationFrame: (id: number) => { cancelled.push(id); queue.delete(id) },
    now: () => now,
    cancelled,
    get pending() { return queue.size },
    run(count: number, stepMs = 16) {
      for (let k = 0; k < count; k += 1) {
        now += stepMs
        const due = [...queue.entries()]
        queue.clear()
        for (const [, cb] of due) cb(now)
      }
    },
    advance(ms: number) { now += ms },
  }
}

function motionQuery(matches: boolean) {
  const listeners = new Set<() => void>()
  return {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn((_type: string, fn: () => void) => { listeners.add(fn) }),
    removeEventListener: vi.fn((_type: string, fn: () => void) => { listeners.delete(fn) }),
    change(value: boolean) { this.matches = value; for (const fn of listeners) fn() },
    get listening() { return listeners.size },
  }
}

const contexts = new Map<HTMLCanvasElement, RecordingContext>()
/** The layer the figure is centred in (Auma Live's `.alv-aura-trace`, the whole field), at a page rectangle. */
function boxAt(width: number, height: number, left = 0, top = 0) {
  const box = document.createElement('div')
  document.body.append(box)
  vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(new DOMRect(left, top, width, height))
  return box
}
type SetupOptions = {
  reduced?: boolean
  tokens?: Record<string, string>
  dpr?: number
  box?: readonly [number, number]
}
function setup({ reduced = false, tokens = {}, dpr = 1, box = [800, 600] as readonly [number, number] }: SetupOptions = {}) {
  const clock = frames()
  const query = motionQuery(reduced)
  const win = {
    devicePixelRatio: dpr,
    matchMedia: () => query,
    getComputedStyle: () => ({ getPropertyValue: (name: string) => tokens[name] ?? '' }),
  }
  const layer = boxAt(box[0], box[1])
  const options: PentoraLiveOptions = {
    document, window: win, now: clock.now, box: layer,
    requestAnimationFrame: clock.requestAnimationFrame, cancelAnimationFrame: clock.cancelAnimationFrame,
    getContext: (canvas: HTMLCanvasElement) => { const ctx = new RecordingContext(); contexts.set(canvas, ctx); return ctx },
  }
  const live = createPentoraLive(options)
  layer.append(live.element)
  const ctx = contexts.get(live.canvas)!
  return { live, ctx, clock, query, options }
}

let hidden = false
beforeEach(() => {
  hidden = false
  contexts.clear()
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const lastFrame = (ctx: RecordingContext) => ctx.calls.slice(ctx.calls.map(call => call.name).lastIndexOf('clearRect'))
const imagesDrawn = (calls: readonly Call[], images: readonly unknown[]) => calls.filter(call => call.name === 'drawImage' && images.includes(call.args[0])).length

/** The stroked paths of a frame, rebuilt from its calls. */
function paths(calls: readonly Call[]): Path[] {
  const out: Path[] = []
  let current: Path | null = null
  let pen: [number, number] = [0, 0]
  calls.forEach((call, at) => {
    const n = call.args as number[]
    if (call.name === 'beginPath') current = { segments: [], arcs: 0, alpha: 0, composite: '', lineWidth: 0, at: -1 }
    else if (call.name === 'moveTo') pen = [n[0]!, n[1]!]
    else if (call.name === 'lineTo') { current?.segments.push([pen[0], pen[1], n[0]!, n[1]!]); pen = [n[0]!, n[1]!] }
    else if (call.name === 'arc' && current) current.arcs += 1
    else if (call.name === 'stroke' && current) {
      Object.assign(current, { alpha: call.alpha, composite: call.composite, lineWidth: call.lineWidth, at })
      out.push(current)
      current = null
    }
  })
  return out
}
const lineStrokes = (calls: readonly Call[]) => paths(calls).filter(path => path.arcs === 0)
/** drawImage calls of the given sprites: centre, radius and alpha. */
function images(calls: readonly Call[], sprites: readonly unknown[]) {
  return calls.flatMap((call, at) => {
    if (call.name !== 'drawImage' || !sprites.includes(call.args[0])) return []
    const [, x, y, w] = call.args as [unknown, number, number, number]
    return [{ x: x + w / 2, y: y + w / 2, r: w / 2, alpha: call.alpha, composite: call.composite, at, image: call.args[0] }]
  })
}
const distanceToSegment = (px: number, py: number, [ax, ay, bx, by]: readonly [number, number, number, number]) => {
  const dx = bx - ax, dy = by - ay
  const k = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + dx * k), py - (ay + dy * k))
}
/**
 * The additive light a frame lays down at (x, y): every 'lighter' path that passes within half its width (plus half a
 * pixel of antialiasing) counts its alpha once; every 'lighter' sprite covering the point counts its alpha times its
 * own radial profile there. Painted (source-over) cells and rings are not added light and are not counted.
 */
function lightAt(x: number, y: number, calls: readonly Call[], live: ReturnType<typeof createPentoraLive>) {
  let sum = 0
  for (const path of paths(calls)) {
    if (path.composite !== 'lighter') continue
    if (path.segments.some(segment => distanceToSegment(x, y, segment) <= path.lineWidth / 2 + 0.5)) sum += path.alpha
  }
  const kinds: [readonly unknown[], Stops][] = [
    [live.sprites.glow, SPRITE_STOPS.glow], [live.sprites.packet, SPRITE_STOPS.packet], [live.sprites.heart, SPRITE_STOPS.heart],
  ]
  for (const [sprites, stops] of kinds) {
    for (const image of images(calls, sprites)) {
      if (image.composite !== 'lighter') continue
      sum += image.alpha * profileAt(stops, Math.hypot(x - image.x, y - image.y) / image.r)
    }
  }
  return sum
}
const wave = (t: number, rate: number, base: number, depth: number) =>
  base + depth * Math.abs(Math.sin(t * rate)) * (0.6 + 0.4 * Math.sin(t * 1.3))
/** The harness's scripted "you interrupt her" (seconds): she speaks, you speak over her from 1.1 s, she stops at 2.4 s. */
const interrupt = (t: number) => ({ say: t < 2.4 ? wave(t, 7, 0.45, 0.45) : 0, mic: t > 1.1 ? wave(t, 9, 0.5, 0.45) : 0, think: 0 })

describe('the renderer draws the whole Pentora every frame', () => {
  it('draws exactly 110 cell cores and the heart per frame: the light additively, the cores painted over it', () => {
    const { live, ctx, clock } = setup()
    clock.run(3)
    expect(live.stats.frames).toBe(3)
    const frame = lastFrame(ctx)
    expect(imagesDrawn(frame, live.sprites.core)).toBe(110)
    expect(imagesDrawn(frame, live.sprites.glow)).toBe(110)
    expect(imagesDrawn(frame, live.sprites.heart)).toBe(2)
    expect(live.stats.cores).toBe(110)
    // Glows and the heart are additive light; the cores are painted over it, so they keep their own colour.
    expect(images(frame, [...live.sprites.glow, ...live.sprites.heart]).every(image => image.composite === 'lighter')).toBe(true)
    expect(images(frame, live.sprites.core).every(image => image.composite === 'source-over')).toBe(true)
    // The lattice is drawn as lines: at silence every line is blue, batched into a few hairline strokes.
    const moves = frame.filter(call => call.name === 'moveTo').length
    expect(moves).toBe(270 + 20)
    live.destroy()
  })

  it('sizes the canvas to the figure and its glow, not the field, with the pixel ratio capped at 2', () => {
    // Job 1 sized it to the whole 800 x 600 field: a 1600 x 1200 backing store here, about 59 MB on a large Retina screen.
    const { live, clock } = setup({ dpr: 3 })
    clock.run(1)
    expect(figureSize(800)).toBe(440)
    expect(figureSize(400)).toBeCloseTo(288, 9)
    const side = 440 * CANVAS.MARGIN
    expect(CANVAS.MARGIN).toBe(1.25)
    expect(live.inspect().layout.side).toBeCloseTo(side, 9)
    expect([live.canvas.width, live.canvas.height]).toEqual([1100, 1100])
    expect([live.canvas.style.width, live.canvas.style.height]).toEqual([`${String(side)}px`, `${String(side)}px`])
    live.destroy()
    // Even a field far larger than any screen: the side never passes 1,024 CSS px, the store 1,024 x the capped ratio.
    for (const [w, h] of [[2560, 1440], [5120, 2880], [20000, 12000]] as const) {
      const big = setup({ dpr: 3, box: [w, h] })
      big.clock.run(1)
      expect(big.live.inspect().layout.side).toBeLessThanOrEqual(CANVAS.SIDE_MAX_PX)
      expect(big.live.canvas.width).toBeLessThanOrEqual(CANVAS.SIDE_MAX_PX * PROJECTION.DPR_MAX)
      expect(big.live.canvas.width * big.live.canvas.height * 4).toBeLessThan(5 * 1024 * 1024)
      big.live.destroy()
    }
  })

  it('sits the heart and every cell exactly where the old full-field canvas put them, at three sizes including a phone', () => {
    for (const [w, h, left, top] of [[1440, 900, 0, 0], [800, 600, 37, 12], [375, 667, 5, 90]] as const) {
      const clock = frames()
      const layer = boxAt(w, h, left, top)
      const live = createPentoraLive({
        document, window: { devicePixelRatio: 2 }, now: clock.now, box: layer,
        requestAnimationFrame: clock.requestAnimationFrame, cancelAnimationFrame: clock.cancelAnimationFrame,
        getContext: () => new RecordingContext(),
      })
      layer.append(live.element)
      clock.run(1)
      const { layout, angle } = live.inspect()
      const canvasLeft = left + Number.parseFloat(live.canvas.style.left), canvasTop = top + Number.parseFloat(live.canvas.style.top)
      // The canvas is centred in the layer.
      expect(canvasLeft + layout.side / 2).toBeCloseTo(left + w / 2, 6)
      expect(canvasTop + layout.side / 2).toBeCloseTo(top + h / 2, 6)
      // The old renderer: the canvas WAS the layer, and a point sat at the layer's centre plus its projection.
      const unit = figureSize(w) / PROJECTION.VIEW
      const old = (point: readonly [number, number, number]) => {
        const [px, py] = project(point, angle, PROJECTION.TILT, 0, 1)
        return [left + w / 2 + px * unit, top + h / 2 + py * unit]
      }
      const page = (g: number) => { const [x, y] = live.inspect().at(g); return [canvasLeft + x, canvasTop + y] }
      expect(page(55)[0]).toBeCloseTo(left + w / 2, 3)
      expect(page(55)[1]).toBeCloseTo(top + h / 2, 3)
      for (const cell of LATTICE.cells) {
        const [ox, oy] = old(cell.point), [nx, ny] = page(cell.g)
        expect(nx).toBeCloseTo(ox!, 3)
        expect(ny).toBeCloseTo(oy!, 3)
      }
      live.destroy()
    }
  })

  it('never draws outside its canvas: every glow, core, ring, line and packet stays inside, through flares, lean and roll', () => {
    const { live, ctx, clock } = setup({ box: [375, 667] })
    const side = () => live.inspect().layout.side
    let checked = 0
    for (let k = 0; k < 900; k += 1) {
      const t = (k % 300) / 60
      const thinking = { think: 1, say: t < 2 ? 0.9 : 0, mic: 0 }, speaking = { mic: t < 2 ? 1 : 0, say: 0, think: 0.5 }
      const levels = k < 300 ? interrupt(t) : k < 600 ? thinking : speaking
      live.draw(k * 16, levels)
      clock.run(1)
      if (k % 15 !== 0) continue
      const frame = lastFrame(ctx)
      for (const image of images(frame, [...live.sprites.glow, ...live.sprites.core, ...live.sprites.packet, ...live.sprites.heart])) {
        expect(image.x - image.r).toBeGreaterThanOrEqual(0)
        expect(image.y - image.r).toBeGreaterThanOrEqual(0)
        expect(image.x + image.r).toBeLessThanOrEqual(side())
        expect(image.y + image.r).toBeLessThanOrEqual(side())
        checked += 1
      }
      for (const call of frame.filter(c => c.name === 'moveTo' || c.name === 'lineTo')) {
        const [x, y] = call.args as number[]
        expect(Math.min(x!, y!)).toBeGreaterThanOrEqual(0)
        expect(Math.max(x!, y!)).toBeLessThanOrEqual(side())
      }
    }
    expect(checked).toBeGreaterThan(60 * 220)
    live.destroy()
  })

  it('orders the shells by size: at equal depth a corner core is larger than a midpoint core, larger than a face core', () => {
    expect(CORE[SHELL.CORNER]).toBeGreaterThan(CORE[SHELL.EDGE])
    expect(CORE[SHELL.EDGE]).toBeGreaterThan(CORE[SHELL.FACE])
    expect(CORE[SHELL.FACE]).toBeGreaterThan(0)
    // As drawn: each core's radius over its perspective scale is its shell's size, at silence (no line carries light).
    const { live, ctx, clock } = setup()
    clock.run(1)
    const unit = figureSize(800) / PROJECTION.VIEW
    const cores = images(lastFrame(ctx), live.sprites.core)
    expect(cores).toHaveLength(110)
    const byShell: number[][] = [[], [], []]
    cores.forEach((core, k) => {
      const cell = LATTICE.cells[k]!
      const near = project(cell.point, live.inspect().angle, PROJECTION.TILT, 0, 1)[3]
      byShell[cell.shell]!.push(core.r / unit / near)
    })
    byShell.forEach((sizes, shell) => { for (const size of sizes) expect(size).toBeCloseTo(CORE[shell]!, 4) })
    // Strictly decreasing at equal depth: the smallest corner is larger than the largest midpoint, and so on.
    expect(Math.min(...byShell[0]!)).toBeGreaterThan(Math.max(...byShell[1]!))
    expect(Math.min(...byShell[1]!)).toBeGreaterThan(Math.max(...byShell[2]!))
    live.destroy()
  })

  it('reproduces the old figure\'s projection: a corner at radius 1 spans 76 view units, nearer is larger', () => {
    expect(PROJECTION).toMatchObject({ VIEW: 184, SPAN: 76, TILT: 0.5, PERSPECTIVE: 4.5, START_ANGLE: 0.7 })
    // The radius is the tables' largest corner radius (1 to within their 1e-6 rounding), as in the old figure.
    const [x, y, depth, near] = project([1, 0, 0], 0, 0, 0, 1)
    expect(x).toBeCloseTo(76, 3)
    expect([y, depth, near].map(v => Math.abs(v))).toEqual([0, 0, 1])
    const [, , nearDepth, nearScale] = project([0, 0, 1], 0, 0, 0, 1)
    expect(nearDepth).toBe(1)
    expect(nearScale).toBeCloseTo(1 / (1 - 1 / 4.5), 5)
    // Turned a quarter, a point on the turning axis's side moves toward the viewer and grows.
    expect(project([1, 0, 0], -Math.PI / 2, 0, 0, 1)[3]).toBeGreaterThan(1)
  })

  it('uses only the page\'s three tokens for colour, with the page\'s own values when a token is missing', () => {
    const { live, ctx, clock } = setup({ tokens: { '--hue-l': '10, 20, 30', '--hue-r': ' 40,50,60 ' } })
    // A burst of both voices makes every colour appear: green, blue, purple and the mixed lines between them.
    for (let k = 0; k < 40; k += 1) { live.draw(k * 16, { mic: k > 10 ? 0.9 : 0, say: 0.9, think: 0.2, color: [255, 0, 0] }); clock.run(1) }
    const allowed = /^rgba?\((10, 20, 30|150, 180, 255|40, 50, 60)(, [0-9.e-]+)?\)$/
    expect(ctx.colours.length).toBeGreaterThan(0)
    for (const colour of ctx.colours) expect(colour).toMatch(allowed)
    for (const sprite of [...live.sprites.glow, ...live.sprites.core, ...live.sprites.heart]) {
      for (const colour of contexts.get(sprite)!.colours) expect(colour).toMatch(allowed)
    }
    expect(ctx.colours.some(colour => colour.startsWith('rgb(10, 20, 30'))).toBe(true)
    expect(ctx.colours.some(colour => colour.startsWith('rgb(150, 180, 255'))).toBe(true)
    expect(ctx.colours.some(colour => colour.startsWith('rgb(40, 50, 60'))).toBe(true)
    expect(TOKENS.map(([name, fallback]) => `${name} ${fallback.join(',')}`))
      .toEqual(['--hue-l 129,212,180', '--hue-c 150,180,255', '--hue-r 196,170,255'])
    live.destroy()
  })

  it('shows the flow: your voice turns the outer cells green and sends light along the lines, never more than the cap', () => {
    const { live, clock } = setup()
    for (let k = 0; k < 30; k += 1) { live.draw(k * 16, { mic: 0.9, say: 0, think: 0 }); clock.run(1) }
    const { values, packets } = live.inspect()
    expect([...values].every(v => v === -1)).toBe(true)
    expect(packets.length).toBeGreaterThan(0)
    expect(packets.length).toBeLessThanOrEqual(220)
    expect(packets.every(p => p.value === -1)).toBe(true)
    // Thinking turns the figure faster.
    const calm = setup()
    for (let k = 0; k < 120; k += 1) { calm.live.draw(0, { think: 0 }); live.draw(0, { think: 1 }); calm.clock.run(1); clock.run(1) }
    const turned = live.inspect().angle, calmTurned = calm.live.inspect().angle
    expect(turned - PROJECTION.START_ANGLE).toBeGreaterThan(calmTurned - PROJECTION.START_ANGLE)
    live.destroy(); calm.live.destroy()
  })
})

describe('the five cubes talk in turn', () => {
  it('a soft pulse of her voice reaches cube 0 first and each later cube one phase after the one before', () => {
    const { live, clock } = setup()
    const first = new Map<number, number>()
    for (let k = 0; k < 120; k += 1) {
      live.draw(k * 16, { say: k >= 3 && k < 18 ? 0.55 : 0, mic: 0, think: 0 })
      clock.run(1)
      live.inspect().values.forEach((v, i) => { if (v === 1 && !first.has(i)) first.set(i, k * 16) })
    }
    // The face centres turn first; their first purple frame, per cube, runs in cube order.
    const faceTimes = [0, 1, 2, 3, 4].map(c => Math.min(...LATTICE.cells
      .filter(cell => cell.shell === SHELL.FACE && cell.cubes[0] === c).map(cell => first.get(cell.index) ?? Infinity)))
    expect(faceTimes.every(Number.isFinite)).toBe(true)
    for (let c = 1; c < 5; c += 1) expect(faceTimes[c]).toBeGreaterThan(faceTimes[c - 1]!)
    expect(faceTimes[4]! - faceTimes[0]!).toBeGreaterThanOrEqual(4 * 35 - 16)
    expect(faceTimes[4]! - faceTimes[0]!).toBeLessThanOrEqual(4 * 35 + 16)
    live.destroy()
  })
})

describe('peaks keep their hue, and the cells stay readable inside the light', () => {
  /** Play the scripted interruption at 60 frames a second; call `look` on each frame from `from` to `to` seconds. */
  type Look = (frame: readonly Call[], live: ReturnType<typeof createPentoraLive>, t: number) => void
  function playInterruption(look: Look, from = 0, to = 3.4, every = 1) {
    const { live, ctx, clock } = setup({ box: [1440, 900], dpr: 2 })
    for (let k = 0; k * 1000 / 60 <= to * 1000; k += 1) {
      const t = k / 60
      live.draw(k * 1000 / 60, interrupt(t))
      clock.run(1, 1000 / 60)
      if (t >= from && k % every === 0) look(lastFrame(ctx), live, t)
    }
    live.destroy()
  }

  it('no line carries more than two packets, every line is stroked exactly once a frame, and a lit line is capped', () => {
    expect(PACKETS.PER_LINE).toBe(2)
    let busiest = 0, litSeen = 0
    playInterruption((frame, live) => {
      const perLine = new Map<number, number>()
      for (const p of live.inspect().packets) perLine.set(p.line, (perLine.get(p.line) ?? 0) + 1)
      busiest = Math.max(busiest, ...perLine.values(), 0)
      for (const count of perLine.values()) expect(count).toBeLessThanOrEqual(PACKETS.PER_LINE)
      // Each of the 270 lines is one segment in exactly one line path (lit or not): light never stacks on a line.
      const strokes = lineStrokes(frame)
      expect(strokes.reduce((n, path) => n + path.segments.length, 0)).toBe(270)
      const keys = strokes.flatMap(path => path.segments.map(([ax, ay, bx, by]) => `${ax.toFixed(3)},${ay.toFixed(3)},${bx.toFixed(3)},${by.toFixed(3)}`))
      expect(new Set(keys).size).toBe(270)
      // A line that carries light is drawn once, in that light's colour, at no more than LIT_ALPHA.
      for (const path of strokes) expect(path.alpha).toBeLessThanOrEqual(Math.max(LIT_ALPHA, 0.17 * 2))
      litSeen = Math.max(litSeen, live.stats.lit)
      expect(live.stats.lit).toBe(perLine.size)
    }, 1.1, 2.6)
    expect(busiest).toBe(2)
    expect(litSeen).toBeGreaterThan(30)
  })

  it(`holds the additive light at every packet drawn under ${String(LIGHT.BOUND)} through the peak of the interruption`, () => {
    // At or under 1, no channel of mint (129, 212, 180), blue (150, 180, 255) or violet (196, 170, 255) can saturate,
    // whatever mixes: the hue survives. Job 1 reached far above it (0.9-alpha packets stacking on crossing lines).
    expect(LIGHT.BOUND).toBe(1)
    expect(LIGHT.BUDGET).toBeLessThanOrEqual(LIGHT.BOUND)
    let worst = 0, packetsLooked = 0, mostDrawn = 0
    playInterruption((frame, live) => {
      const heads = images(frame, live.sprites.packet)
      mostDrawn = Math.max(mostDrawn, heads.length)
      for (const head of heads) {
        const light = lightAt(head.x, head.y, frame, live)
        worst = Math.max(worst, light)
        expect(light).toBeLessThanOrEqual(LIGHT.BOUND)
        packetsLooked += 1
      }
    }, 1.1, 2.6, 3)
    expect(mostDrawn).toBeGreaterThan(40)
    expect(packetsLooked).toBeGreaterThan(1000)
    expect(worst).toBeGreaterThan(0.3)
  }, 60_000)

  it('paints every cell core after the last line and the last packet of the frame, in its value\'s colour', () => {
    let framesLooked = 0, withPackets = 0
    playInterruption((frame, live) => {
      const lastLine = Math.max(...lineStrokes(frame).map(path => path.at))
      const packetsAt = images(frame, live.sprites.packet).map(image => image.at)
      const lastPacket = Math.max(-1, ...packetsAt)
      const cores = images(frame, live.sprites.core)
      expect(cores).toHaveLength(110)
      expect(Math.min(...cores.map(core => core.at))).toBeGreaterThan(Math.max(lastLine, lastPacket))
      const { values } = live.inspect()
      cores.forEach((core, k) => { expect(core.image).toBe(live.sprites.core[values[k]! + 1]) })
      framesLooked += 1
      if (packetsAt.length > 0) withPackets += 1
    }, 0, 3.4, 4)
    expect(framesLooked).toBeGreaterThan(40)
    expect(withPackets).toBeGreaterThan(20)
  })

  it('grows a core slightly while a line that touches it carries light, and only then', () => {
    let grown = 0, plain = 0
    playInterruption((frame, live) => {
      const unit = figureSize(1440) / PROJECTION.VIEW
      const litEnds = new Set(live.inspect().packets.flatMap(p => [LATTICE.lines[p.line]!.a, LATTICE.lines[p.line]!.b]))
      images(frame, live.sprites.core).forEach((core, k) => {
        const cell = LATTICE.cells[k]!
        const [x, y, near] = live.inspect().at(cell.g)
        expect(core.x).toBeCloseTo(x, 4)
        expect(core.y).toBeCloseTo(y, 4)
        const lit = litEnds.has(cell.g)
        expect(core.r).toBeCloseTo(CORE[cell.shell] * unit * near * (lit ? LIT_CORE : 1), 4)
        if (lit) grown += 1; else plain += 1
      })
    }, 1.2, 1.8, 6)
    expect(LIT_CORE).toBeGreaterThan(1)
    expect(LIT_CORE).toBeLessThanOrEqual(1.25)
    expect(grown).toBeGreaterThan(20)
    expect(plain).toBeGreaterThan(20)
  })
})

describe('the renderer pauses, resumes and cleans up', () => {
  it('pauses while the page is hidden and resumes when it is shown', () => {
    const { live, clock } = setup()
    clock.run(2)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(clock.pending).toBe(0)
    expect(live.inspect().running).toBe(false)
    const drawn = live.stats.frames
    clock.run(5)
    expect(live.stats.frames).toBe(drawn)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    clock.run(2)
    expect(live.stats.frames).toBe(drawn + 2)
    live.destroy()
  })

  it('stops with setActive(false) and starts again with setActive(true)', () => {
    const { live, clock } = setup()
    clock.run(1)
    live.setActive(false)
    expect(clock.pending).toBe(0)
    clock.run(4)
    expect(live.stats.frames).toBe(1)
    live.setActive(true)
    clock.run(1)
    expect(live.stats.frames).toBe(2)
    live.destroy()
  })

  it('destroy cancels the pending frame, removes every listener and the canvas', () => {
    const removed = vi.spyOn(document, 'removeEventListener')
    const added = vi.spyOn(document, 'addEventListener')
    const { live, clock, query } = setup()
    clock.run(1)
    expect(clock.pending).toBe(1)
    const visibility = added.mock.calls.find(([type]) => type === 'visibilitychange')?.[1]
    expect(visibility).toBeDefined()
    live.destroy()
    expect(clock.pending).toBe(0)
    expect(clock.cancelled).toHaveLength(1)
    expect(removed).toHaveBeenCalledWith('visibilitychange', visibility)
    expect(query.listening).toBe(0)
    expect(live.canvas.isConnected).toBe(false)
    clock.run(3)
    live.draw(0, { mic: 1 })
    expect(live.stats.frames).toBe(1)
  })
})

describe('under reduced motion: one still frame per value change', () => {
  it('runs no frame loop, no packets and no turn; it redraws exactly once for each step that changes a value', () => {
    const { live, clock } = setup({ reduced: true })
    expect(clock.pending).toBe(0)
    live.resize()
    expect(live.stats.frames).toBe(1)
    for (let k = 0; k < 10; k += 1) { clock.advance(16); live.draw(k * 16, { mic: 0, say: 0, think: 0 }) }
    expect(live.stats.frames).toBe(1)
    // Your voice: the corners, then the midpoints, then the faces, each cube one phase after the one before. Every step
    // that changes a value draws one still frame; a step that changes nothing draws none.
    let changes = 0
    for (let k = 0; k < 60; k += 1) {
      const before = [...live.inspect().values]
      clock.advance(16)
      live.draw(k * 16, { mic: 0.9, say: 0, think: 0 })
      if (live.inspect().values.some((v, i) => v !== before[i])) changes += 1
    }
    expect(changes).toBeGreaterThan(2)
    // No cube phase under reduced motion: one onset is three steps (corners, midpoints, faces), never a five-cube run.
    expect(changes).toBeLessThanOrEqual(3)
    expect(live.stats.frames).toBe(1 + changes)
    expect([...live.inspect().values].every(v => v === -1)).toBe(true)
    expect(live.inspect().packets).toHaveLength(0)
    expect(live.inspect().angle).toBe(PROJECTION.START_ANGLE)
    expect(clock.pending).toBe(0)
    live.destroy()
  })

  it('its still frame shows all 110 cells in their current colours, with no packet and no turn', () => {
    const { live, ctx, clock } = setup({ reduced: true })
    live.resize()
    for (let k = 0; k < 40; k += 1) { clock.advance(16); live.draw(k * 16, { mic: k >= 10 ? 0.9 : 0, say: 0.9, think: 0 }) }
    const frame = lastFrame(ctx)
    const { values } = live.inspect()
    // A front between your voice and hers: both colours are on screen at once in this still.
    expect(values.some(v => v === -1) && values.some(v => v === 1)).toBe(true)
    const cores = images(frame, live.sprites.core)
    expect(cores).toHaveLength(110)
    cores.forEach((core, k) => { expect(core.image).toBe(live.sprites.core[values[k]! + 1]) })
    expect(images(frame, live.sprites.packet)).toHaveLength(0)
    // No turn: every cell sits at the start angle's projection, unleaned.
    const unit = figureSize(800) / PROJECTION.VIEW
    for (const cell of LATTICE.cells) {
      const [px, py] = project(cell.point, PROJECTION.START_ANGLE, PROJECTION.TILT, 0, 1)
      const [x, y] = live.inspect().at(cell.g)
      expect(x).toBeCloseTo(live.inspect().layout.side / 2 + px * unit, 3)
      expect(y).toBeCloseTo(live.inspect().layout.side / 2 + py * unit, 3)
    }
    live.destroy()
  })

  it('follows a change of the reduced-motion setting while the page is open', () => {
    const { live, clock, query } = setup()
    clock.run(1)
    query.change(true)
    expect(clock.pending).toBe(0)
    expect(live.inspect().still).toBe(true)
    query.change(false)
    expect(clock.pending).toBe(1)
    live.destroy()
  })

  it('keeps the values across a change of the setting: the still frame continues from what the moving figure showed', () => {
    const { live, clock, query } = setup()
    live.resize()
    // Your voice, long enough for every shell of every cube to turn while the figure moves.
    for (let k = 0; k < 90; k += 1) { live.draw(k * 16, { mic: 0.9, say: 0, think: 0 }); clock.run(1) }
    expect([...live.inspect().values].every(v => v === -1)).toBe(true)
    query.change(true)
    expect(live.inspect().still).toBe(true)
    expect([...live.inspect().values].every(v => v === -1)).toBe(true)
    query.change(false)
    expect([...live.inspect().values].every(v => v === -1)).toBe(true)
    live.destroy()
  })
})

describe('Auma Live\'s seam is unchanged', () => {
  it('createAuraTrace returns { element, resize, setActive, draw, destroy }; the element is the same quiet layer', () => {
    const { options } = setup()
    const trace = createAuraTrace(options)
    expect(Object.keys(trace).sort()).toEqual(['destroy', 'draw', 'element', 'resize', 'setActive'])
    expect(trace.element.tagName).toBe('DIV')
    expect(trace.element.classList.contains('alv-aura-trace')).toBe(true)
    expect(trace.element.getAttribute('aria-hidden')).toBe('true')
    expect(trace.element.querySelector('canvas')).not.toBeNull()
    expect(trace.element.textContent).toBe('')
    trace.resize()
    trace.draw(16, { color: [1, 2, 3], mic: 0.5, say: 0.5, think: 0.5 })
    trace.setActive(false)
    trace.setActive(true)
    trace.destroy()
    expect(trace.element.querySelector('canvas')).toBeNull()
  })

  it('built with no arguments, as Auma Live calls it, it still makes the layer (with no 2D context it draws nothing)', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const trace = createAuraTrace()
    expect(trace.element.className).toBe('alv-aura-trace alv-pentora-live')
    trace.draw(0, { color: [0, 0, 0], mic: 0, say: 0, think: 0 })
    trace.destroy()
  })
})
