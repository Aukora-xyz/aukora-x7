/**
 * The Aura Coherence page's flow rule (aura/flow.ts) is Auma Live's rule (pentora-live/flow.mjs), written again in the
 * package: fed the same scripted levels over the figure's own 110 cells (shell and phase cube from the tables), the two
 * must give identical values and identical changed cells at every step. And the page's three signals, read from the
 * shown Session, behave as the brief says: nothing shown is all zero; a prompt is IN; an open turn is HOLD; output is OUT.
 */
import { describe, expect, it } from 'vitest'
import * as rule from '../src/client/spatial/aura/flow.ts'
import { CORNER_CELLS, CUBES } from '../src/client/spatial/aura/tables.ts'
// Auma Live's rule, imported here only to compare the two implementations (the spec may cross; the package never does).
import * as live from '../../../../apps/web/scripts/stock-apps/pentora-live/flow.mjs'

const liveCreate = live.createFlow
const liveFLOW = live.FLOW

/** The figure's cells in its own order: corners (shell 0, the lower of their two cubes), then per cube faces and midpoints. */
function figureCells(): { shells: number[]; phases: number[] } {
  const shells: number[] = []
  const phases: number[] = []
  CUBES.forEach((cube, c) => {
    for (const _ of cube.faceCentres) { shells.push(2); phases.push(c) }
    for (const _ of cube.edgeMidpoints) { shells.push(1); phases.push(c) }
  })
  for (const g of CORNER_CELLS) {
    shells.push(0)
    phases.push(rule.phaseCubeOf(CUBES.flatMap((cube, c) => (cube.corners.includes(g) ? [c] : []))))
  }
  return { shells, phases }
}

type Script = (t: number) => { mic: number; think: number; say: number }
const SCRIPTS: Readonly<Record<string, Script>> = {
  silence: () => ({ mic: 0, think: 0, say: 0 }),
  'in burst': t => ({ mic: t >= 200 && t < 900 ? 1 - (t - 200) / 900 : 0, think: 0, say: 0 }),
  'out burst': t => ({ mic: 0, think: t < 300 ? 1 : 0, say: t >= 300 && t < 1500 ? 0.4 + 0.5 * Math.sin(t / 90) ** 2 : 0 }),
  'in over out': t => ({ mic: t >= 700 && t < 1400 ? 0.95 : 0, think: 0.2, say: t >= 100 && t < 1800 ? 0.85 : 0 }),
}

describe('flow.ts is flow.mjs, value for value', () => {
  it('the constants are the same numbers', () => {
    expect({ ...rule.FLOW }).toEqual({ ...liveFLOW })
    expect({ ...rule.VALUE }).toEqual({ ...live.VALUE })
  })

  for (const [name, script] of Object.entries(SCRIPTS)) {
    it(`${name}: identical values and changed cells at every 16 ms step, over 110 cells in five phase cubes`, () => {
      const { shells, phases } = figureCells()
      expect(shells).toHaveLength(110)
      const ours = rule.createFlow(shells, rule.FLOW, phases)
      const theirs = liveCreate(shells, liveFLOW, phases)
      let moved = 0
      for (let t = 0; t <= 2400; t += 16) {
        const levels = script(t)
        const a = ours.step(t, levels)
        const b = theirs.step(t, levels)
        expect([...a.changed], `t=${String(t)}`).toEqual([...b.changed])
        expect([...a.values], `t=${String(t)}`).toEqual([...b.values])
        moved += a.changed.length
      }
      // The scripts are not vacuous: every one but silence moves cells.
      if (name === 'silence') expect(moved).toBe(0)
      else expect(moved).toBeGreaterThan(20)
    })
  }

  it('single-cube defaults and odd inputs agree too (no phases, non-finite and missing levels, time going back)', () => {
    const shells = [0, 1, 2, 0, 1, 2]
    const ours = rule.createFlow(shells)
    const theirs = liveCreate(shells)
    const steps: [number, live.Levels][] = [
      [0, { mic: 1 }], [16, { mic: Number.NaN, say: 2 }], [32, {}], [10, { say: 1 }], [400, { think: -1, say: 1 }],
    ]
    for (const [t, levels] of steps) {
      expect([...ours.step(t, levels).values]).toEqual([...theirs.step(t, levels).values])
    }
  })
})

describe('the page\'s three signals', () => {
  const facts = (over: Partial<rule.ShownFacts> = {}): rule.ShownFacts =>
    ({ id: 's1', running: false, prompts: 0, output: 0, modelMs: 0, ...over })

  it('no Session shown: every level is 0', () => {
    expect(rule.levelsAt(rule.EMPTY_FEED, 5000)).toEqual({ mic: 0, think: 0, say: 0 })
    expect(rule.absorbShown(rule.EMPTY_FEED, null, 1)).toBe(rule.EMPTY_FEED)
  })

  it('the first look is a baseline: an outline already full of prompts and output never replays', () => {
    const feed = rule.absorbShown(rule.EMPTY_FEED, facts({ prompts: 7, output: 9000, modelMs: 40_000 }), 1000)
    expect(rule.levelsAt(feed, 1000)).toEqual({ mic: 0, think: 0, say: 0 })
  })

  it('IN: a new opening prompt is a level of 1 that falls to 0 over 1.2 s; HOLD gives way while it is there', () => {
    let feed = rule.absorbShown(rule.EMPTY_FEED, facts(), 0)
    feed = rule.absorbShown(feed, facts({ running: true, prompts: 1 }), 1000)
    expect(rule.levelsAt(feed, 1000)).toMatchObject({ mic: 1, think: 0 })
    expect(rule.levelsAt(feed, 1600).mic).toBeCloseTo(0.5, 5)
    expect(rule.levelsAt(feed, 2200)).toEqual({ mic: 0, think: 1, say: 0 })
    // A turn that opens with no human prompt in the outline is not the owner's message.
    let auto = rule.absorbShown(rule.EMPTY_FEED, facts(), 0)
    auto = rule.absorbShown(auto, facts({ running: true }), 1000)
    expect(rule.levelsAt(auto, 1000)).toEqual({ mic: 0, think: 1, say: 0 })
    // With no outline held, the turn opening stands in for the owner's message.
    let bare = rule.absorbShown(rule.EMPTY_FEED, facts({ prompts: null }), 0)
    bare = rule.absorbShown(bare, facts({ prompts: null, running: true }), 1000)
    expect(rule.levelsAt(bare, 1000).mic).toBe(1)
  })

  it('OUT: output growth is squashed by its rate, holds HOLD down while it is strong, and decays to 0 when it stops', () => {
    let feed = rule.absorbShown(rule.EMPTY_FEED, facts(), 0)
    feed = rule.absorbShown(feed, facts({ running: true }), 1000)
    feed = rule.absorbShown(feed, facts({ running: true, output: 200, modelMs: 2000 }), 3000)
    // 200 units over 2 s = 100 a second: almost full.
    const at = rule.levelsAt(feed, 3000)
    expect(at.say).toBeCloseTo(1 - Math.exp(-100 / rule.OUT_RATE), 6)
    expect(at.think).toBe(0)
    expect(rule.levelsAt(feed, 3000 + rule.OUT_DECAY_MS).say).toBeCloseTo(at.say / Math.E, 6)
    expect(rule.levelsAt(feed, 3000 + 8 * rule.OUT_DECAY_MS).say).toBe(0)
    // A step with no output count still says her output arrived, at a fixed, stated size.
    const unsized = rule.absorbShown(feed, facts({ running: true, output: 200, modelMs: 2600 }), 4000)
    expect(rule.levelsAt(unsized, 4000).say).toBeCloseTo(rule.OUT_UNSIZED, 6)
    // Nothing moved: the same feed object.
    expect(rule.absorbShown(unsized, facts({ running: true, output: 200, modelMs: 2600 }), 4100)).toBe(unsized)
  })

  it('switching Session is a new baseline', () => {
    let feed = rule.absorbShown(rule.EMPTY_FEED, facts(), 0)
    feed = rule.absorbShown(feed, facts({ prompts: 1 }), 100)
    const other = rule.absorbShown(feed, facts({ id: 's2', prompts: 5, output: 70 }), 200)
    expect(other.inAt).toBeNull()
    expect(rule.levelsAt(other, 200)).toEqual({ mic: 0, think: 0, say: 0 })
  })
})
