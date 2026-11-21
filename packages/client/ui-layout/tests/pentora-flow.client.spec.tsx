// @vitest-environment jsdom
/**
 * The Aura Coherence page's Pentora comes alive (its dots must now change
 * properly). Two channels on every cell, never mistaken for each other: the RING (class, data-state, stroke) is health and
 * the CORE (data-flow, fill) is the conversation's flow in three colours, fed from the shown Session; lit lines carry a
 * change along the edges. No Session: every core rests. Reduced motion: colours only, no travel, no cube phase.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { MAX_LIT, PentoraFigure, STILL_STEP_MS, TRAVEL_MS } from '../src/client/spatial/aura/PentoraFigure.tsx'
import { AuraPentoraSurface, shownFactsOf, type SessionsShape } from '../src/client/spatial/aura/AuraPentoraSurface.tsx'
import { AURA_SURFACE, absentHealth, type AuraHealthView, type CellReport } from '../src/client/spatial/aura/model.ts'
import { EMPTY_LIVE } from '../src/client/spatial/aura/activity.ts'
import { EMPTY_FEED, absorbShown, type FlowFeed, type ShownFacts } from '../src/client/spatial/aura/flow.ts'
import { CUBES } from '../src/client/spatial/aura/tables.ts'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const live = { current: EMPTY_LIVE }
const NO_AURA = { current: null }
const clock = { now: 0 }
let frames: FrameRequestCallback[] = []

/** A moving figure: a stubbed frame loop and a stubbed client clock, both driven by the test. */
function stubMotion(reduced = false): void {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
}

/** Run every queued frame, `step` ms apart, until the clock reaches `until`; `each` sees the DOM after every frame. */
function runTo(until: number, each?: () => void, step = 16): void {
  while (clock.now < until) {
    clock.now += step
    const due = frames
    frames = []
    for (const callback of due) callback(clock.now)
    each?.()
  }
}

const glyphs = (root: ParentNode) => [...root.querySelectorAll<SVGCircleElement>('circle[data-g]')]
const flowOf = (root: ParentNode, shell: string, look: string) =>
  root.querySelectorAll(`circle[data-g][data-shell="${shell}"][data-flow="${look}"]`).length
const litSlots = (root: ParentNode) => [...root.querySelectorAll<SVGLineElement>('line[data-flow-slot][data-lit="yes"]')]
const ringsOf = (root: ParentNode) => glyphs(root).map(dot => `${dot.dataset.g ?? ''}|${dot.getAttribute('class') ?? ''}|${dot.dataset.state ?? ''}`)

const facts = (over: Partial<ShownFacts> = {}): ShownFacts => ({ id: 's1', running: false, prompts: 0, output: 0, modelMs: 0, ...over })

/** A view in which the given private slots carry the given states. */
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
const slotOf = (c: number, e: number) => {
  const cube = CUBES[c]
  const mid = cube?.edgeMidpoints[e] ?? -1
  return { slot: c * 18 + (cube?.private.indexOf(mid) ?? -1), mid }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (document as { hidden?: boolean }).hidden
  clock.now = 0
})

/** The script the brief names: the owner's message lands at 1 s, her answer arrives at 3 s, he speaks over it at 3.6 s. */
function scripted(feed: { current: FlowFeed }, root: ParentNode) {
  const seen = {
    firstIn: null as null | { corner: number; edge: number; face: number },
    firstOut: null as null | { corner: number; edge: number; face: number },
    front: null as null | { in: number; out: number; lit: number; colours: string[] },
  }
  const count = (look: string) => ({ corner: flowOf(root, 'corner', look), edge: flowOf(root, 'edge', look), face: flowOf(root, 'face', look) })
  const total = (c: { corner: number; edge: number; face: number }) => c.corner + c.edge + c.face
  feed.current = absorbShown(EMPTY_FEED, facts(), 0)
  runTo(1000)
  feed.current = absorbShown(feed.current, facts({ running: true, prompts: 1 }), 1000)
  runTo(3000, () => { const ins = count('in'); if (seen.firstIn === null && total(ins) > 0) seen.firstIn = ins })
  feed.current = absorbShown(feed.current, facts({ running: true, prompts: 1, output: 200, modelMs: 2000 }), 3000)
  runTo(3600, () => { const outs = count('out'); if (seen.firstOut === null && total(outs) > 0) seen.firstOut = outs })
  feed.current = absorbShown(feed.current, facts({ running: true, prompts: 2, output: 200, modelMs: 2000 }), 3600)
  runTo(4200, () => {
    const ins = total(count('in')), outs = total(count('out')), lit = litSlots(root)
    if (seen.front === null && ins > 0 && outs > 0 && lit.length > 0) {
      seen.front = { in: ins, out: outs, lit: lit.length, colours: [...new Set(lit.map(line => line.dataset.flow ?? ''))] }
    }
  })
  return seen
}

describe('the cores carry the conversation, in its three colours', () => {
  it('a scripted message then a streamed answer: the outer shell turns mint first, the heart side violet first, the front shows at one instant', () => {
    stubMotion()
    const feed = { current: EMPTY_FEED }
    const { container } = render(<PentoraFigure view={absentHealth()} active focus={null} live={live} aura={NO_AURA} flow={feed} />)
    const seen = scripted(feed, container)
    // IN: the 20 shared cells on the outer shell before any inner one.
    expect(seen.firstIn?.corner).toBeGreaterThan(0)
    expect(seen.firstIn?.edge).toBe(0)
    expect(seen.firstIn?.face).toBe(0)
    // OUT: the face centres, nearest the heart, before any outer cell.
    expect(seen.firstOut?.face).toBeGreaterThan(0)
    expect(seen.firstOut?.edge).toBe(0)
    expect(seen.firstOut?.corner).toBe(0)
    // HE SPEAKS OVER HER: mint outside while violet is still inside, in the DOM at the same instant, with lines lit.
    expect(seen.front?.in).toBeGreaterThan(0)
    expect(seen.front?.out).toBeGreaterThan(0)
    expect(seen.front?.lit).toBeGreaterThan(0)
    expect(seen.front?.lit).toBeLessThanOrEqual(MAX_LIT)
    // And the cores are painted by their look: the fill points at that look's gradient (a corner's keeps its hollow).
    for (const dot of glyphs(container)) {
      const look = dot.dataset.flow ?? ''
      expect(dot.getAttribute('fill')).toMatch(new RegExp(`-core-${look}${dot.dataset.shell === 'corner' ? '-c' : ''}\\)$`, 'u'))
    }
    // Once everything has stopped, every lit line goes out and the cores come back to rest.
    feed.current = absorbShown(feed.current, facts({ running: false, prompts: 2, output: 200, modelMs: 2000 }), 4200)
    runTo(16_000)
    expect(litSlots(container)).toHaveLength(0)
    expect(glyphs(container).every(dot => dot.dataset.flow === 'rest')).toBe(true)
  })

  it('an open turn with nothing arriving is HOLD: blue, brighter than rest; closing it rests again', () => {
    stubMotion()
    const feed = { current: absorbShown(EMPTY_FEED, facts(), 0) }
    const { container } = render(<PentoraFigure view={absentHealth()} active focus={null} live={live} aura={NO_AURA} flow={feed} />)
    runTo(500)
    feed.current = absorbShown(feed.current, facts({ running: true }), 500)
    runTo(1500)
    expect(glyphs(container).every(dot => dot.dataset.flow === 'hold')).toBe(true)
    // Holding is not travel: no line lit for it.
    expect(litSlots(container)).toHaveLength(0)
    feed.current = absorbShown(feed.current, facts({ running: false }), 1500)
    runTo(2500)
    expect(glyphs(container).every(dot => dot.dataset.flow === 'rest')).toBe(true)
  })

  it('no Session shown: every core rests, nothing lights, however long it runs (with the feed, and with none)', () => {
    stubMotion()
    const feed = { current: EMPTY_FEED }
    const withFeed = render(<PentoraFigure view={absentHealth()} active focus={null} live={live} aura={NO_AURA} flow={feed} />)
    runTo(3000)
    expect(glyphs(withFeed.container).map(dot => dot.dataset.flow)).toEqual(Array.from({ length: 110 }, () => 'rest'))
    expect(litSlots(withFeed.container)).toHaveLength(0)
    cleanup()
    stubMotion()
    clock.now = 0
    const bare = render(<PentoraFigure view={absentHealth()} active focus={null} live={live} aura={{ current: null }} />)
    runTo(3000)
    expect(glyphs(bare.container).every(dot => dot.dataset.flow === 'rest')).toBe(true)
    expect(litSlots(bare.container)).toHaveLength(0)
  })
})

describe('flow never touches a ring, and health never touches a core', () => {
  it('one verified and one failed cell: their rings are identical before, during and after a burst; the failed edge never lights', () => {
    stubMotion()
    const good = slotOf(0, 0), bad = slotOf(2, 3)
    const view = viewWith(new Map([[good.slot, 'verified'], [bad.slot, 'failed']]))
    const feed = { current: EMPTY_FEED }
    const { container, rerender } = render(<PentoraFigure view={view} active focus={null} live={live} aura={NO_AURA} flow={feed} />)
    const before = ringsOf(container)
    const goodDot = container.querySelector<SVGCircleElement>(`circle[data-g="${String(good.mid)}"]`)
    const badDot = container.querySelector<SVGCircleElement>(`circle[data-g="${String(bad.mid)}"]`)
    expect(goodDot?.dataset.state).toBe('verified')
    expect(badDot?.dataset.state).toBe('failed')
    const coresSeen = new Set<string>()
    const lights = new Set<string>()
    const during: string[][] = []
    const watch = () => {
      during.push(ringsOf(container))
      coresSeen.add(badDot?.dataset.flow ?? '')
      for (const line of litSlots(container)) lights.add(line.dataset.lights ?? '')
    }
    feed.current = absorbShown(EMPTY_FEED, facts(), 0)
    runTo(1000, watch)
    feed.current = absorbShown(feed.current, facts({ running: true, prompts: 1 }), 1000)
    runTo(3000, watch)
    feed.current = absorbShown(feed.current, facts({ running: true, prompts: 1, output: 300, modelMs: 2000 }), 3000)
    runTo(4500, watch)
    for (const frame of during) expect(frame).toEqual(before)
    // The failed cell's core still moved (flow is not health) while its red ring stayed red.
    expect(coresSeen.size).toBeGreaterThan(1)
    expect(badDot?.dataset.state).toBe('failed')
    // Lines did light, but never the failed edge.
    expect(lights.size).toBeGreaterThan(0)
    expect(lights.has('2:3')).toBe(false)
    // Health changing never writes a core: swap the two states and every core keeps its look.
    const cores = glyphs(container).map(dot => `${dot.dataset.flow ?? ''}|${dot.getAttribute('fill') ?? ''}`)
    rerender(<PentoraFigure view={viewWith(new Map([[good.slot, 'failed'], [bad.slot, 'verified']]))} active focus={null} live={live}
      aura={{ current: null }} flow={feed} />)
    expect(glyphs(container).map(dot => `${dot.dataset.flow ?? ''}|${dot.getAttribute('fill') ?? ''}`)).toEqual(cores)
    expect(goodDot?.dataset.state).toBe('failed')
    runTo(16_000)
    expect(ringsOf(container)).not.toEqual(before)
    expect(ringsOf(container).filter(ring => ring.endsWith('|failed'))).toEqual([`${String(good.mid)}|${goodDot?.getAttribute('class') ?? ''}|failed`])
  })

  it('the stylesheet: the ring rules set no fill; the core colours are the three palette tokens; no new colour value', () => {
    const file = 'packages/client/ui-layout/src/client/spatial/aura/AuraPentora.module.css'
    const path = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}${file}`)).find(existsSync) ?? ''
    const sheet = readFileSync(path, 'utf8')
    for (const rule of sheet.match(/\.(face|mid|corner)\[data-state='[a-z]+'\][^{]*\{[^}]*\}/gu) ?? []) expect(rule).not.toMatch(/\bfill:/u)
    expect(sheet).toContain(".core[data-look='in'] { stop-color: var(--ak-mint);")
    expect(sheet).toContain(".core[data-look='hold'] { stop-color: var(--ak-blue);")
    expect(sheet).toContain(".core[data-look='out'] { stop-color: var(--ak-violet);")
    expect(sheet).toContain(".core[data-look='rest'] { stop-color: var(--ak-blue);")
  })
})

describe('reduced motion', () => {
  it('cores still take their colours, one still frame per change, all five cubes together; no lit line; nothing moves', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    stubMotion(true)
    const feed = { current: absorbShown(EMPTY_FEED, facts(), 0) }
    const { container } = render(<PentoraFigure view={absentHealth()} active focus={null} live={live} aura={NO_AURA} flow={feed} />)
    expect(container.querySelector('figure')?.dataset.still).toBe('yes')
    const spy = vi.spyOn(Element.prototype, 'setAttribute')
    const turned = new Map<string, number>()
    const tick = () => {
      clock.now += STILL_STEP_MS
      vi.advanceTimersByTime(STILL_STEP_MS)
      for (const dot of glyphs(container)) {
        if (dot.dataset.flow === 'in' && !turned.has(dot.dataset.g ?? '')) turned.set(dot.dataset.g ?? '', clock.now)
      }
      expect(litSlots(container)).toHaveLength(0)
    }
    for (let k = 0; k < 5; k += 1) tick()
    feed.current = absorbShown(feed.current, facts({ running: true, prompts: 1 }), clock.now)
    for (let k = 0; k < 30; k += 1) tick()
    // No frame loop, and the only writes are cores: never a coordinate.
    expect(frames).toHaveLength(0)
    expect(new Set(spy.mock.calls.map(([name]) => name))).toEqual(new Set(['data-flow', 'fill']))
    // No cube phase: every one of the 20 outer cells turned mint on the same step.
    const corners = glyphs(container).filter(dot => dot.dataset.shell === 'corner').map(dot => turned.get(dot.dataset.g ?? ''))
    expect(corners.every(at => at !== undefined)).toBe(true)
    expect(new Set(corners).size).toBe(1)
  })
})

describe('the figure as the existing tests count it, and its cost', () => {
  it('120 lines with ends, 110 glyphs, 60 overlay slots; at rest a frame is still exactly 700 attribute writes; the peak is bounded', () => {
    stubMotion()
    const feed = { current: absorbShown(EMPTY_FEED, facts(), 0) }
    const { container } = render(<PentoraFigure view={absentHealth()} active focus={null} live={live} aura={NO_AURA} flow={feed} />)
    expect(container.querySelectorAll('figure svg line[data-a]')).toHaveLength(120)
    expect(glyphs(container)).toHaveLength(110)
    expect(container.querySelectorAll('line[data-flow-slot]')).toHaveLength(MAX_LIT)
    runTo(400)
    // AT REST (a Session shown, nothing happening): 4 per line and 2 per dot, as before; no style property written.
    const attributes = vi.spyOn(Element.prototype, 'setAttribute')
    const properties = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty')
    runTo(416)
    expect(attributes).toHaveBeenCalledTimes(700)
    expect(properties).toHaveBeenCalledTimes(0)
    // AT A PEAK (the scripted message, answer and interruption): the most any one frame wrote.
    let peakAttributes = 0, peakProperties = 0, peakLit = 0
    const measure = () => {
      peakAttributes = Math.max(peakAttributes, attributes.mock.calls.length)
      peakProperties = Math.max(peakProperties, properties.mock.calls.length)
      peakLit = Math.max(peakLit, litSlots(container).length)
      attributes.mockClear()
      properties.mockClear()
    }
    attributes.mockClear()
    properties.mockClear()
    feed.current = absorbShown(feed.current, facts({ running: true, prompts: 1 }), clock.now)
    runTo(3000, measure)
    feed.current = absorbShown(feed.current, facts({ running: true, prompts: 1, output: 200, modelMs: 2000 }), clock.now)
    runTo(3600, measure)
    feed.current = absorbShown(feed.current, facts({ running: true, prompts: 2, output: 200, modelMs: 2000 }), clock.now)
    runTo(5000, measure)
    // Measured on this script (2026-11-13): a peak frame of 1026 attributes and 156 style properties, 60 lines lit.
    expect(peakLit).toBeLessThanOrEqual(MAX_LIT)
    // Bound: 700 + every core (2) + every lit overlay (4 coordinates, 2 on lighting) and 3 properties per lit overlay.
    expect(peakAttributes).toBeLessThanOrEqual(700 + 110 * 2 + MAX_LIT * 6)
    expect(peakProperties).toBeLessThanOrEqual(MAX_LIT * 3)
    expect(peakAttributes).toBeGreaterThan(700)
    expect(TRAVEL_MS).toBe(400)
  })
})

describe('the surface hands the figure the shown Session\'s real store fields', () => {
  type StatusSnapshot = Parameters<Parameters<Parameters<typeof AuraPentoraSurface>[0]['useSessionStatus']>[0]>[0]
  const S1 = 's1' as SessionId
  const listOf = (values: Record<string, unknown>): SessionListState => ({
    ids: [S1],
    byId: { [S1]: { id: S1, displayTitle: 'Test', running: false, retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } },
    phase: 'ready',
    projectionsBySession: { [S1]: { values, state: 'ready', error: null } } as unknown as SessionListState['projectionsBySession'],
  })
  const statusOf = (running: boolean): StatusSnapshot =>
    new Map([[S1, { running, pendingInteraction: undefined, completionUnread: false }]])

  it('shownFactsOf reads running, the outline\'s opening prompts and the stats\' output; nothing shown is null', () => {
    const sessions = listOf({
      turnOutline: [{ turn: 1, seq: 1, prompt: 'hello', response: 'hi' }, { turn: 2, seq: 9, prompt: '', response: '' }],
      sessionStats: { decodeTokens: 420, llmMs: 3100, steps: 3, toolMs: 0 },
    }) as unknown as SessionsShape
    expect(shownFactsOf('s1', sessions, { running: true })).toEqual({ id: 's1', running: true, prompts: 1, output: 420, modelMs: 3100 })
    expect(shownFactsOf('s1', listOf({}) as unknown as SessionsShape, undefined)).toEqual({ id: 's1', running: false, prompts: null, output: null, modelMs: null })
    expect(shownFactsOf(undefined, sessions, undefined)).toBeNull()
  })

  it('the owner\'s prompt landing turns the outer cells mint; her output growing turns the inner cells violet', () => {
    stubMotion()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const list = createSnapshotStore<SessionListState>(listOf({ turnOutline: [], sessionStats: { decodeTokens: 0, llmMs: 0 } }))
    const status = createSnapshotStore<StatusSnapshot>(statusOf(false))
    const props = {
      activeSurface: AURA_SURFACE, closeSurface: () => {}, reader: { whole: async () => ({ ok: false, reason: 'not-found' }) },
      useSessions: bindSnapshotSelector(list), useSessionStatus: bindSnapshotSelector(status),
    }
    const { container } = render(<AuraPentoraSurface {...(props as unknown as Parameters<typeof AuraPentoraSurface>[0])} />)
    runTo(500)
    expect(glyphs(container).every(dot => dot.dataset.flow === 'rest')).toBe(true)
    act(() => {
      status.set(statusOf(true))
      list.set(listOf({ turnOutline: [{ turn: 1, seq: 1, prompt: 'build it', response: '' }], sessionStats: { decodeTokens: 0, llmMs: 0 } }))
    })
    let mintFirst: number | null = null
    runTo(1300, () => { if (mintFirst === null && flowOf(container, 'corner', 'in') > 0) mintFirst = flowOf(container, 'face', 'in') })
    expect(mintFirst).toBe(0)
    runTo(2600)
    act(() => {
      list.set(listOf({ turnOutline: [{ turn: 1, seq: 1, prompt: 'build it', response: '' }], sessionStats: { decodeTokens: 260, llmMs: 1800 } }))
    })
    let violetFirst: number | null = null
    runTo(3200, () => { if (violetFirst === null && flowOf(container, 'face', 'out') > 0) violetFirst = flowOf(container, 'corner', 'out') })
    expect(violetFirst).toBe(0)
  })

  it('How it works says rings are evidence, cores and lit lines are flow, and flow is never health', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const list = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
    const status = createSnapshotStore<StatusSnapshot>(new Map())
    const props = {
      activeSurface: AURA_SURFACE, closeSurface: () => {}, reader: { whole: async () => ({ ok: false, reason: 'not-found' }) },
      useSessions: bindSnapshotSelector(list), useSessionStatus: bindSnapshotSelector(status),
    }
    const { container } = render(<AuraPentoraSurface {...(props as unknown as Parameters<typeof AuraPentoraSurface>[0])} />)
    const head = [...container.querySelectorAll<HTMLButtonElement>('button.ak-portal__head')]
      .find(button => button.querySelector('.ak-portal__title')?.textContent === 'How it works')
    if (head === undefined) throw new Error('no How it works')
    fireEvent.click(head)
    const words = container.querySelector('[data-aura-how="rings-and-cores"]')?.textContent?.replace(/\s+/gu, ' ') ?? ''
    expect(words).toContain('The ring is evidence')
    expect(words).toContain('every ring stays undetermined until a host serves a health snapshot')
    expect(words).toContain('The core and the lines that light up are the conversation\'s flow')
    expect(words).toMatch(/mint .* blue .* violet/u)
    expect(words).toContain('Flow is never health')
    // No caption on the figure itself.
    expect(container.querySelector('figure')?.textContent).toBe('')
  })
})

describe('review fixes: where the lit lines sit, and a new pass starts them clean', () => {
  it('every overlay slot rides in its own cube, over all that cube\'s edges and under all its dots; a lit slot lights an edge of its own cube', () => {
    stubMotion()
    const feed = { current: EMPTY_FEED }
    const { container } = render(<PentoraFigure view={absentHealth()} active focus={2} live={live} aura={NO_AURA} flow={feed} />)
    const FOLLOWS = Node.DOCUMENT_POSITION_FOLLOWING
    const slots = [...container.querySelectorAll<SVGLineElement>('line[data-flow-slot]')]
    expect(slots).toHaveLength(MAX_LIT)
    for (const [c, cube] of CUBES.entries()) {
      const group = container.querySelectorAll<SVGGElement>('[data-organ] > g')[c]
      const own = slots.filter(slot => slot.closest('[data-organ] > g') === group)
      expect(own).toHaveLength(cube.edges.length)
      const edgeLines = [...(group?.querySelectorAll('line[data-a]') ?? [])]
      const dots = [...(group?.querySelectorAll('circle[data-g]') ?? [])]
      expect(edgeLines).toHaveLength(24)
      expect(dots).toHaveLength(18)
      for (const slot of own) {
        // Painted after (over) every edge and glow line of its cube, and before (under) every face and midpoint dot.
        for (const line of edgeLines) expect(line.compareDocumentPosition(slot) & FOLLOWS).toBe(FOLLOWS)
        for (const dot of dots) expect(slot.compareDocumentPosition(dot) & FOLLOWS).toBe(FOLLOWS)
        // And it dims with its organ, like the edge it lights.
        expect(slot.closest<SVGGElement>('[data-organ]')?.dataset.dim).toBe(c === 2 ? 'no' : 'yes')
      }
    }
    // The corners (shared by two cubes) stay on top of every overlay.
    const corners = container.querySelector('circle[data-shell="corner"]')?.parentElement
    for (const slot of slots) expect(slot.compareDocumentPosition(corners as Node) & FOLLOWS).toBe(FOLLOWS)
    const seen = scripted(feed, container)
    expect(seen.front?.lit).toBeGreaterThan(0)
    let checked = 0
    runTo(1000 + clock.now, () => {
      for (const slot of litSlots(container)) {
        const [cube] = (slot.dataset.lights ?? '').split(':')
        expect(slot.closest<SVGGElement>('[data-organ]')?.dataset.organ).toBe(container.querySelectorAll<SVGGElement>('[data-organ]')[Number(cube)]?.dataset.organ)
        checked += 1
      }
    })
    expect(checked).toBeGreaterThan(0)
  })

  it('a pass stopped mid-fade leaves no inline opacity or dash on any slot, so a slot lit later travels at full strength', () => {
    stubMotion()
    // This test stops a pass, so cancelling a frame must really drop it (the shared stub keeps every callback).
    const queued = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queued.set(queued.size + 1, callback); frames.push(callback); return queued.size })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { const callback = queued.get(id); frames = frames.filter(each => each !== callback) })
    const feed = { current: absorbShown(EMPTY_FEED, facts(), 0) }
    const props = { view: absentHealth(), focus: null, live, aura: NO_AURA, flow: feed }
    const { container, rerender } = render(<PentoraFigure {...props} active />)
    const styled = () => [...container.querySelectorAll<SVGLineElement>('line[data-flow-slot]')]
      .filter(slot => slot.style.getPropertyValue('stroke-opacity') !== '' || slot.style.getPropertyValue('stroke-dasharray') !== ''
        || slot.style.getPropertyValue('stroke-dashoffset') !== '')
    runTo(500)
    feed.current = absorbShown(feed.current, facts({ running: true, prompts: 1 }), clock.now)
    // Step until some lit line is fading (an inline stroke-opacity below its class's own).
    let fading = 0
    for (let guard = 0; guard < 400 && fading === 0; guard += 1) {
      runTo(clock.now + 16)
      fading = litSlots(container).filter(slot => slot.style.getPropertyValue('stroke-opacity') !== '').length
    }
    expect(fading).toBeGreaterThan(0)
    // The owner leaves the surface, mid-fade, and comes back: the new pass starts every slot clean.
    rerender(<PentoraFigure {...props} active={false} />)
    rerender(<PentoraFigure {...props} active />)
    expect(litSlots(container)).toHaveLength(0)
    expect(styled()).toHaveLength(0)
    // The next message lights slots again: while a slot travels (its dash still growing) it carries no leftover opacity.
    feed.current = absorbShown(feed.current, facts({ running: true, prompts: 2 }), clock.now)
    let travelling = 0
    runTo(clock.now + 2 * TRAVEL_MS, () => {
      for (const slot of litSlots(container).filter(each => each.style.getPropertyValue('stroke-dasharray') !== '')) {
        expect(slot.style.getPropertyValue('stroke-opacity')).toBe('')
        travelling += 1
      }
    })
    expect(travelling).toBeGreaterThan(0)
  })

  it('How it works claims only what the signals carry: mint when a message opens a turn, violet when a step of her answer lands', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    type StatusSnapshot = Parameters<Parameters<Parameters<typeof AuraPentoraSurface>[0]['useSessionStatus']>[0]>[0]
    const list = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
    const status = createSnapshotStore<StatusSnapshot>(new Map())
    const props = {
      activeSurface: AURA_SURFACE, closeSurface: () => {}, reader: { whole: async () => ({ ok: false, reason: 'not-found' }) },
      useSessions: bindSnapshotSelector(list), useSessionStatus: bindSnapshotSelector(status),
    }
    const { container } = render(<AuraPentoraSurface {...(props as unknown as Parameters<typeof AuraPentoraSurface>[0])} />)
    const head = [...container.querySelectorAll<HTMLButtonElement>('button.ak-portal__head')]
      .find(button => button.querySelector('.ak-portal__title')?.textContent === 'How it works')
    if (head === undefined) throw new Error('no How it works')
    fireEvent.click(head)
    const words = container.querySelector('[data-aura-how="rings-and-cores"]')?.textContent?.replace(/\s+/gu, ' ') ?? ''
    expect(words).toContain('mint when your message opens a turn')
    expect(words).toContain('violet each time a step of her answer lands')
    // OUT moves when a model step closes, never per streamed character: no claim that violet follows the text as it comes.
    expect(words).not.toContain('as her answer comes in')
  })
})
