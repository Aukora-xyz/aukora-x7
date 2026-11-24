// @vitest-environment jsdom
/**
 * The Aura Coherence page's Pentora draws every cell:
 * 20 corner, 60 edge-midpoint and 30 face-centre dots, one per cell, plus a hairline ring at the centre that is not a
 * cell. A dot's look is its cell's health state and nothing else.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PentoraFigure } from '../src/client/spatial/aura/PentoraFigure.tsx'
import { absentHealth, ORGANS, type AuraHealthView, type CellReport } from '../src/client/spatial/aura/model.ts'
import { EMPTY_LIVE } from '../src/client/spatial/aura/activity.ts'
import { CORNER_CELLS, CUBES, POINTS } from '../src/client/spatial/aura/tables.ts'

const live = { current: EMPTY_LIVE }

/** Under reduced motion the figure draws one still frame and runs no loop. */
function stubReducedMotion(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }))
}

function still(view: AuraHealthView = absentHealth(), focus: number | null = null) {
  stubReducedMotion()
  return render(<PentoraFigure view={view} active={false} focus={focus} live={live} aura={{ current: null }} />)
}

const glyphs = (root: ParentNode, shell?: string) =>
  [...root.querySelectorAll<SVGCircleElement>(shell === undefined ? 'circle[data-g]' : `circle[data-g][data-shell="${shell}"]`)]

/** A view in which exactly the two given private slots carry the given states. */
function viewWith(changes: ReadonlyMap<number, CellReport['cell']>): AuraHealthView {
  const base = absentHealth()
  return {
    ...base,
    private: base.private.map((report, slot) => {
      const cell = changes.get(slot)
      return cell === undefined ? report : { cell, reason: cell === 'verified' ? 'satisfied' : 'invariant-failed', observed_at_ms: null }
    }),
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the Pentora draws all 110 cells and marks the centre', () => {
  it('20 corner, 60 midpoint and 30 face-centre dots, each naming its own cell; one centre ring; 120 lines', () => {
    const { container } = still()
    expect(glyphs(container, 'corner')).toHaveLength(20)
    expect(glyphs(container, 'edge')).toHaveLength(60)
    expect(glyphs(container, 'face')).toHaveLength(30)
    expect(glyphs(container)).toHaveLength(110)
    // Every cell once: the 110 named cells are exactly every point of the geometry except the shared centre.
    const named = glyphs(container).map(dot => Number(dot.dataset.g))
    expect(new Set(named).size).toBe(110)
    const points = Object.entries(POINTS).map(([g, point]) => [Number(g), point] as const)
    expect(points).toHaveLength(111)
    const centres = points.filter(([, point]) => point.every(v => v === 0)).map(([g]) => g)
    expect(centres).toHaveLength(1)
    const centreIndex = centres[0]
    expect(named).not.toContain(centreIndex)
    expect(new Set([...named, centreIndex])).toEqual(new Set(points.map(([g]) => g)))
    expect(new Set(glyphs(container, 'corner').map(dot => Number(dot.dataset.g)))).toEqual(new Set(CORNER_CELLS))
    expect(new Set(glyphs(container, 'edge').map(dot => Number(dot.dataset.g)))).toEqual(new Set(CUBES.flatMap(cube => cube.edgeMidpoints)))
    expect(new Set(glyphs(container, 'face').map(dot => Number(dot.dataset.g)))).toEqual(new Set(CUBES.flatMap(cube => cube.faceCentres)))
    // The centre: one hollow ring, not a cell (no cell name, no state), hidden from assistive tech.
    const rings = container.querySelectorAll('circle[data-pentora-centre]')
    expect(rings).toHaveLength(1)
    const ring = rings[0]
    expect(ring?.getAttribute('r')).toBe('2.4')
    expect(ring?.getAttribute('cx')).toBe('0')
    expect(ring?.getAttribute('cy')).toBe('0')
    expect(ring?.getAttribute('aria-hidden')).toBe('true')
    expect(ring?.hasAttribute('data-g')).toBe(false)
    expect(ring?.hasAttribute('data-state')).toBe(false)
    expect(container.querySelectorAll('figure svg line[data-a]')).toHaveLength(120)
  })

  it('draw order: lines, then face centres, then midpoints, then the ring, then corners; the new dots ride in their cube', () => {
    const { container } = still(absentHealth(), 2)
    for (const [c, organ] of ORGANS.entries()) {
      const cube = container.querySelector(`[data-organ="${organ}"] > g`)
      const kinds = [...(cube?.children ?? [])].map(node => (node.tagName === 'line' ? 'line' : (node as SVGElement).dataset.shell))
      const firstFace = kinds.indexOf('face'), firstEdge = kinds.indexOf('edge')
      expect(kinds.lastIndexOf('line')).toBeLessThan(firstFace)
      expect(kinds.lastIndexOf('face')).toBeLessThan(firstEdge)
      expect(kinds.filter(kind => kind === 'edge')).toHaveLength(12)
      // Organ dimming follows the cube: only the focused organ stays lit, its midpoints with it.
      for (const dot of glyphs(container, 'edge').filter(each => Number(each.dataset.cube) === c)) {
        const group = dot.closest<SVGGElement>('[data-organ]')
        expect(group?.dataset.organ).toBe(organ)
        expect(group?.dataset.dim).toBe(c === 2 ? 'no' : 'yes')
      }
    }
    const svg = container.querySelector('figure svg')
    const order = [...(svg?.children ?? [])]
    const ring = container.querySelector('circle[data-pentora-centre]')
    const corners = glyphs(container, 'corner')[0]?.parentElement
    expect(order.indexOf(ring as Element)).toBeGreaterThan(Math.max(...[...container.querySelectorAll('[data-organ]')].map(group => order.indexOf(group))))
    expect(order.indexOf(corners as Element)).toBe(order.length - 1)
  })

  it('in the still frame every midpoint dot sits at the midpoint of its own edge line as drawn', () => {
    const { container } = still()
    const dots = glyphs(container, 'edge')
    expect(dots).toHaveLength(60)
    for (const dot of dots) {
      const line = container.querySelector(`line[data-layer="edge"][data-cube="${dot.dataset.cube ?? ''}"][data-edge="${dot.dataset.edge ?? ''}"]`)
      expect(line).not.toBeNull()
      // The dot's cell is that edge's midpoint cell, from the tables.
      expect(Number(dot.dataset.g)).toBe(CUBES[Number(dot.dataset.cube)]?.edgeMidpoints[Number(dot.dataset.edge)])
      const n = (name: string) => Number(line?.getAttribute(name))
      expect(Number.isFinite(n('x1')) && Number.isFinite(n('x2'))).toBe(true)
      expect(Math.abs(Number(dot.getAttribute('cx')) - (n('x1') + n('x2')) / 2)).toBeLessThanOrEqual(0.01 + 1e-9)
      expect(Math.abs(Number(dot.getAttribute('cy')) - (n('y1') + n('y2')) / 2)).toBeLessThanOrEqual(0.01 + 1e-9)
    }
    // Drawn, not left at the origin.
    expect(dots.some(dot => Number(dot.getAttribute('cx')) !== 0)).toBe(true)
  })

  it('the three shells read by size: corner > edge midpoint > face centre, the same within a shell', () => {
    const { container } = still()
    const radii = (shell: string) => new Set(glyphs(container, shell).map(dot => Number(dot.getAttribute('r'))))
    expect(radii('corner')).toEqual(new Set([1.9]))
    expect(radii('edge')).toEqual(new Set([1.55]))
    expect(radii('face')).toEqual(new Set([1.3]))
    expect(1.9).toBeGreaterThan(1.55)
    expect(1.55).toBeGreaterThan(1.3)
  })
})

describe('a dot shows its cell\'s state and nothing else', () => {
  it('with absent health no dot is verified or failed: 110 quiet dots', () => {
    const { container } = still()
    const states = glyphs(container).map(dot => dot.dataset.state)
    expect(states.filter(state => state === 'undetermined')).toHaveLength(110)
    expect(container.querySelectorAll('[data-state="verified"], [data-state="failed"]')).toHaveLength(0)
  })

  it('one verified and one failed midpoint cell: exactly those two dots change, and their edge lines keep today\'s styling', () => {
    // Cube 0 edge 0 and cube 2 edge 3: their midpoint cells' private slots, from the tables.
    const slotOf = (c: number, e: number) => {
      const cube = CUBES[c]
      const mid = cube?.edgeMidpoints[e] ?? -1
      return { slot: c * 18 + (cube?.private.indexOf(mid) ?? -1), mid }
    }
    const good = slotOf(0, 0), bad = slotOf(2, 3)
    expect(good.slot).toBeGreaterThanOrEqual(0)
    expect(bad.slot).toBeGreaterThanOrEqual(36)
    const before = still()
    const classOf = (root: ParentNode, selector: string) => root.querySelector(selector)?.getAttribute('class') ?? null
    const baseline = new Map(glyphs(before.container).map(dot => [dot.dataset.g, `${dot.getAttribute('class') ?? ''}|${dot.dataset.state ?? ''}`]))
    const edgeClass = classOf(before.container, 'line[data-layer="edge"]'), glowClass = classOf(before.container, 'line[data-layer="glow"]')
    cleanup()
    const { container } = still(viewWith(new Map([[good.slot, 'verified'], [bad.slot, 'failed']])))
    const verified = container.querySelectorAll<SVGCircleElement>('circle[data-g][data-state="verified"]')
    const failed = container.querySelectorAll<SVGCircleElement>('circle[data-g][data-state="failed"]')
    expect([...verified].map(dot => Number(dot.dataset.g))).toEqual([good.mid])
    expect([...failed].map(dot => Number(dot.dataset.g))).toEqual([bad.mid])
    expect(verified[0]?.dataset.shell).toBe('edge')
    // The same state look as a face dot: the dot's class is the midpoint class, unchanged by state.
    expect(verified[0]?.getAttribute('class')).toBe(failed[0]?.getAttribute('class'))
    expect(verified[0]?.getAttribute('class')).toBeTruthy()
    expect(verified[0]?.getAttribute('class')).not.toBe(glyphs(container, 'face')[0]?.getAttribute('class'))
    expect(edgeClass).toBeTruthy()
    expect(glowClass).toBeTruthy()
    for (const dot of glyphs(container)) {
      if (dot === verified[0] || dot === failed[0]) continue
      expect(`${dot.getAttribute('class') ?? ''}|${dot.dataset.state ?? ''}`).toBe(baseline.get(dot.dataset.g))
    }
    // The edge lines: both layers carry the cell's state exactly as before this change, with the same classes.
    for (const [c, e, state] of [[0, 0, 'verified'], [2, 3, 'failed']] as const) {
      for (const [layer, expected] of [['edge', edgeClass], ['glow', glowClass]] as const) {
        const line = container.querySelector(`line[data-layer="${layer}"][data-cube="${String(c)}"][data-edge="${String(e)}"]`)
        expect(line?.getAttribute('data-state')).toBe(state)
        expect(line?.getAttribute('class')).toBe(expected)
      }
    }
    expect(container.querySelectorAll('line[data-state="verified"]')).toHaveLength(2)
    expect(container.querySelectorAll('line[data-state="failed"]')).toHaveLength(2)
  })

  it('the stylesheet gives the midpoint dot exactly the face dot\'s state rules, adds no colour, and the ring no state', () => {
    const file = 'packages/client/ui-layout/src/client/spatial/aura/AuraPentora.module.css'
    const path = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}${file}`)).find(existsSync)
    expect(path).toBeDefined()
    const sheet = readFileSync(path ?? '', 'utf8')
    for (const state of ['verified', 'undetermined', 'failed']) {
      expect(sheet).toContain(`.face[data-state='${state}'], .mid[data-state='${state}'] {`)
    }
    // The one literal colour in the file is still the corner's dark fill; everything else is a token.
    expect(sheet.match(/rgba?\(/gu)).toHaveLength(1)
    expect(sheet).toMatch(/\.centre \{ fill: none; stroke: var\(--ak-muted\);[^}]*\}/u)
    expect(sheet).not.toMatch(/\.centre\[data-state/u)
  })
})

describe('the animation pass: two writes per dot, no new loop', () => {
  it('one frame writes 4 attributes per line and 2 per dot: 700', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    try {
      render(<PentoraFigure view={absentHealth()} active focus={null} live={live} aura={{ current: null }} />)
      expect(frames).toHaveLength(1)
      const spy = vi.spyOn(Element.prototype, 'setAttribute')
      frames.shift()?.(1000)
      const onLines = spy.mock.contexts.filter(target => (target as Element).tagName === 'line').length
      const onDots = spy.mock.contexts.filter(target => (target as Element).hasAttribute('data-g')).length
      const onRing = spy.mock.contexts.filter(target => (target as Element).hasAttribute('data-pentora-centre')).length
      expect(onLines).toBe(480)
      expect(onDots).toBe(220)
      expect(onRing).toBe(0)
      expect(spy).toHaveBeenCalledTimes(700)
      // One loop: the frame asked for exactly one next frame.
      expect(frames).toHaveLength(1)
    } finally {
      // Back to jsdom's own (prototype) answer.
      delete (document as { hidden?: boolean }).hidden
    }
  })
})
