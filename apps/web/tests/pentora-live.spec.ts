/**
 * The living Pentora in Auma Live. The pure half: the lattice (every cell and line, derived from the
 * pinned tables), the flow rule (three live levels -> one of -1/0/+1 per cell) and the travelling light.
 * The renderer and the seam are in pentora-live-renderer.spec.ts; the bundle pin in pentora-live-bundle.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import { buildLattice, HEART, LATTICE, pointAt, SHELL, type CubeTable } from '../scripts/stock-apps/pentora-live/lattice.mjs'
import { amplitudes, candidateOf, createFlow, createHistory, FLOW, phaseCubeOf, type Levels } from '../scripts/stock-apps/pentora-live/flow.mjs'
import { createPackets, PACKETS } from '../scripts/stock-apps/pentora-live/packets.mjs'

const dist = (p: readonly number[], q: readonly number[]) =>
  Math.hypot((p[0] ?? 0) - (q[0] ?? 0), (p[1] ?? 0) - (q[1] ?? 0), (p[2] ?? 0) - (q[2] ?? 0))
const cellsOfCube = (c: number) => LATTICE.cells.filter(cell => cell.cubes.includes(c))
const shells = LATTICE.cells.map(cell => cell.shell)
const indicesOnShell = (shell: number) => LATTICE.cells.filter(cell => cell.shell === shell).map(cell => cell.index)

/** Rebuild the cube tables from the lattice itself, so the derivation can be round-tripped and then corrupted. */
function tablesFromLattice(): CubeTable[] {
  return [0, 1, 2, 3, 4].map((c) => {
    const halves = LATTICE.lines.filter(line => line.family === 'edge' && line.cube === c)
    const byMid = new Map<number, number[]>()
    for (const line of halves) byMid.set(line.b, [...(byMid.get(line.b) ?? []), line.a])
    const edgeMidpoints = [...byMid.keys()]
    return {
      edges: edgeMidpoints.map(m => [byMid.get(m)?.[0] ?? -1, byMid.get(m)?.[1] ?? -1] as const),
      edgeMidpoints,
      faceCentres: cellsOfCube(c).filter(cell => cell.shell === SHELL.FACE).map(cell => cell.g),
      corners: cellsOfCube(c).filter(cell => cell.shell === SHELL.CORNER).map(cell => cell.g),
    }
  })
}

describe('the lattice: every cell and line of the five cubes, derived from tables.ts', () => {
  it('is five cubes of 26 cells, 110 distinct cells, and the heart is no cell', () => {
    expect(LATTICE.cubeCount).toBe(5)
    for (let c = 0; c < 5; c += 1) {
      const own = cellsOfCube(c)
      expect(own).toHaveLength(26)
      expect(own.filter(cell => cell.shell === SHELL.CORNER)).toHaveLength(8)
      expect(own.filter(cell => cell.shell === SHELL.EDGE)).toHaveLength(12)
      expect(own.filter(cell => cell.shell === SHELL.FACE)).toHaveLength(6)
    }
    expect(LATTICE.cells).toHaveLength(110)
    expect(new Set(LATTICE.cells.map(cell => cell.g)).size).toBe(110)
    expect(LATTICE.cells.some(cell => cell.g === HEART)).toBe(false)
    expect(pointAt(HEART)).toEqual([0, 0, 0])
    expect([0, 1, 2].map(s => indicesOnShell(s).length)).toEqual([20, 60, 30])
  })

  it('puts every corner in exactly two cubes, and every other cell in one', () => {
    for (const cell of LATTICE.cells) expect(cell.cubes).toHaveLength(cell.shell === SHELL.CORNER ? 2 : 1)
    // Every pair of cubes shares exactly two corners.
    for (let a = 0; a < 5; a += 1) for (let b = a + 1; b < 5; b += 1) {
      expect(LATTICE.cells.filter(cell => cell.cubes.includes(a) && cell.cubes.includes(b))).toHaveLength(2)
    }
  })

  it('has the three line families in the stated counts, each stored outer end first', () => {
    const count = (family: string) => LATTICE.lines.filter(line => line.family === family).length
    expect([count('edge'), count('cross'), count('spoke')]).toEqual([120, 120, 30])
    expect(LATTICE.lines).toHaveLength(270)
    for (const line of LATTICE.lines) {
      const shellOf = (g: number) => (g === HEART ? SHELL.HEART : LATTICE.cells[LATTICE.cellOf.get(g) ?? -1]?.shell)
      expect((shellOf(line.b) ?? -1) - (shellOf(line.a) ?? -1)).toBe(1)
      expect(LATTICE.lines[line.index]).toBe(line)
    }
  })

  it('draws each edge as two half-segments through its exact midpoint', () => {
    const halves = LATTICE.lines.filter(line => line.family === 'edge')
    const byMid = new Map<string, number[]>()
    for (const line of halves) byMid.set(`${String(line.cube)}:${String(line.b)}`, [...(byMid.get(`${String(line.cube)}:${String(line.b)}`) ?? []), line.a])
    expect(byMid.size).toBe(60)
    for (const [key, ends] of byMid) {
      expect(ends).toHaveLength(2)
      const m = pointAt(Number(key.split(':')[1]))
      const p = pointAt(ends[0] ?? -1), q = pointAt(ends[1] ?? -1)
      expect(dist(m, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2])).toBeLessThan(1e-5)
      expect(dist(p, q)).toBeCloseTo(2 / Math.sqrt(3), 5)
    }
  })

  it('joins each face centre to exactly the 4 midpoints of its own face, and to the heart', () => {
    for (const face of LATTICE.cells.filter(cell => cell.shell === SHELL.FACE)) {
      const crosses = LATTICE.lines.filter(line => line.family === 'cross' && line.b === face.g)
      expect(crosses).toHaveLength(4)
      for (const line of crosses) {
        expect(line.cube).toBe(face.cubes[0])
        expect(dist(pointAt(line.a), face.point)).toBeCloseTo(1 / Math.sqrt(3), 5)
      }
      expect(LATTICE.lines.filter(line => line.family === 'spoke' && line.a === face.g && line.b === HEART)).toHaveLength(1)
    }
    // And every midpoint lies on exactly two faces.
    for (const mid of LATTICE.cells.filter(cell => cell.shell === SHELL.EDGE)) {
      expect(LATTICE.lines.filter(line => line.family === 'cross' && line.a === mid.g)).toHaveLength(2)
    }
  })

  it('makes every cell an endpoint of at least one line, with the stated degrees', () => {
    for (const cell of LATTICE.cells) {
      const touching = LATTICE.lines.filter(line => line.a === cell.g || line.b === cell.g)
      expect(touching.length).toBeGreaterThan(0)
      expect(touching).toHaveLength(cell.shell === SHELL.CORNER ? 6 : cell.shell === SHELL.EDGE ? 4 : 5)
    }
    expect(LATTICE.lines.filter(line => line.b === HEART)).toHaveLength(30)
  })

  it('maps each shared corner to its three edges in each of its two cubes', () => {
    expect(LATTICE.cornerEdges.size).toBe(20)
    for (const [corner, edges] of LATTICE.cornerEdges) {
      expect(edges).toHaveLength(6)
      const cubes = edges.map(i => LATTICE.lines[i]?.cube)
      const owners = LATTICE.cells[LATTICE.cellOf.get(corner) ?? -1]?.cubes ?? []
      for (const c of owners) expect(cubes.filter(x => x === c)).toHaveLength(3)
      for (const i of edges) expect(LATTICE.lines[i]?.a).toBe(corner)
    }
  })

  it('gives each cube a closed blue orbit through all 8 of its corners along its own edges', () => {
    LATTICE.orbits.forEach((route, c) => {
      expect(route).toHaveLength(16)
      const visited = new Set<number>()
      route.forEach((step, k) => {
        const line = LATTICE.lines[step.line]!
        expect(line.family).toBe('edge')
        expect(line.cube).toBe(c)
        const start = step.dir > 0 ? line.a : line.b
        const end = step.dir > 0 ? line.b : line.a
        const next = route[(k + 1) % route.length]!
        const nextLine = LATTICE.lines[next.line]!
        expect(next.dir > 0 ? nextLine.a : nextLine.b).toBe(end)
        if (step.dir > 0) visited.add(start)
      })
      expect(visited.size).toBe(8)
    })
  })

  it('round-trips through the tables and refuses a table that is not the lattice it assumes', () => {
    const tables = tablesFromLattice()
    const rebuilt = buildLattice(tables, [...LATTICE.cornerEdges.keys()])
    expect(rebuilt.cells.map(cell => [cell.g, cell.shell])).toEqual(LATTICE.cells.map(cell => [cell.g, cell.shell]))
    expect(rebuilt.lines.length).toBe(270)
    const first = tables[0]!
    // A face centre listed as an edge midpoint sits on two shells.
    expect(() => buildLattice([{ ...first, edgeMidpoints: [first.faceCentres[0]!, ...first.edgeMidpoints.slice(1)] }, ...tables.slice(1)]))
      .toThrow(/two shells|midpoint/)
    // A face centre that is not one: no face of four midpoints around it.
    expect(() => buildLattice([{ ...first, faceCentres: [first.corners[0]!, ...first.faceCentres.slice(1)] }, ...tables.slice(1)]))
      .toThrow(/two shells|midpoints, not 4/)
    // The heart is never a cell.
    expect(() => buildLattice([{ ...first, faceCentres: [HEART, ...first.faceCentres.slice(1)] }, ...tables.slice(1)])).toThrow()
  })
})

/** Each cell's phase cube: the earlier of its cubes (a shared corner takes the lower of its two). */
const phases = LATTICE.cells.map(cell => phaseCubeOf(cell.cubes))
/** Run the flow from 0 to `untilMs` in `frameMs` frames; `levels(t)` gives the three levels at t. One cube unless `cubes`. */
function run(levels: (t: number) => Levels, untilMs: number, { cubes = false, frameMs = 16 }: { cubes?: boolean; frameMs?: number } = {}) {
  const flow = createFlow(shells, FLOW, cubes ? phases : undefined)
  const frames: { t: number; values: Int8Array; changed: number[] }[] = []
  for (let t = 0; t <= untilMs; t += frameMs) {
    const { values, changed } = flow.step(t, levels(t))
    frames.push({ t, values: Int8Array.from(values), changed: [...changed] })
  }
  return frames
}
/** The first frame time at which every cell on `shell` holds `value`, at or after `from`. */
function whenShellIs(frames: ReturnType<typeof run>, shell: number, value: number, from = 0) {
  const on = indicesOnShell(shell)
  return frames.find(frame => frame.t >= from && on.every(i => frame.values[i] === value))?.t ?? Infinity
}
const FRAME = 16

describe('the flow rule: the breath of the conversation, never health', () => {
  it('silence is a calm blue lattice: every cell 0, nothing ever changes', () => {
    const frames = run(() => ({ mic: 0, think: 0, say: 0 }), 3000)
    for (const frame of frames) {
      expect(frame.values.every(v => v === 0)).toBe(true)
      expect(frame.changed).toEqual([])
    }
  })

  it('your voice turns the corners green first, then the midpoints, then the faces, at the stated delays, and releases in that order', () => {
    const frames = run(t => ({ mic: t < 600 ? 0.9 : 0, think: 0, say: 0 }), 1600)
    const on = [0, 1, 2].map(shell => whenShellIs(frames, shell, -1))
    const off = [0, 1, 2].map((shell, k) => whenShellIs(frames, shell, 0, on[k]))
    on.forEach((t, shell) => {
      expect(t - shell * FLOW.T_MS).toBeGreaterThanOrEqual(0)
      expect(t - shell * FLOW.T_MS).toBeLessThanOrEqual(3 * FRAME)
    })
    off.forEach((t, shell) => {
      expect(t - 600 - shell * FLOW.T_MS).toBeGreaterThanOrEqual(0)
      expect(t - 600 - shell * FLOW.T_MS).toBeLessThanOrEqual(4 * FRAME)
    })
    expect(on[0]! < on[1]! && on[1]! < on[2]!).toBe(true)
    expect(off[0]! < off[1]! && off[1]! < off[2]!).toBe(true)
    // Nothing else ever happens: no purple from your voice.
    expect(frames.every(frame => frame.values.every(v => v !== 1))).toBe(true)
  })

  it('her voice blooms purple from the heart outward: faces first, then midpoints, then corners, and releases in that order', () => {
    const frames = run(t => ({ mic: 0, think: 0, say: t < 600 ? 0.9 : 0 }), 1600)
    const on = [0, 1, 2].map(shell => whenShellIs(frames, shell, 1))
    const off = [0, 1, 2].map((shell, k) => whenShellIs(frames, shell, 0, on[k]))
    on.forEach((t, shell) => {
      const delay = (3 - shell) * FLOW.T_MS
      expect(t - delay).toBeGreaterThanOrEqual(0)
      expect(t - delay).toBeLessThanOrEqual(3 * FRAME)
    })
    off.forEach((t, shell) => {
      const delay = 600 + (3 - shell) * FLOW.T_MS
      expect(t - delay).toBeGreaterThanOrEqual(0)
      expect(t - delay).toBeLessThanOrEqual(4 * FRAME)
    })
    expect(on[2]! < on[1]! && on[1]! < on[0]!).toBe(true)
    expect(frames.every(frame => frame.values.every(v => v !== -1))).toBe(true)
  })

  it('when you speak over her, the outer shell is green while the inner one is still purple, at the same instant', () => {
    const frames = run(t => ({ mic: t >= 500 ? 0.9 : 0, think: 0, say: 0.9 }), 1200)
    const front = frames.find(frame =>
      indicesOnShell(0).every(i => frame.values[i] === -1) && indicesOnShell(2).every(i => frame.values[i] === 1))
    expect(front).toBeDefined()
  })

  it('a soft voice turns the corners and stops; a full one reaches the faces (depth follows loudness)', () => {
    const soft = run(() => ({ mic: 0.18, think: 0, say: 0 }), 1000).at(-1)!
    expect(indicesOnShell(0).every(i => soft.values[i] === -1)).toBe(true)
    expect(indicesOnShell(1).every(i => soft.values[i] === 0)).toBe(true)
    expect(indicesOnShell(2).every(i => soft.values[i] === 0)).toBe(true)
    const full = run(() => ({ mic: 0.8, think: 0, say: 0 }), 1000).at(-1)!
    expect(full.values.every(v => v === -1)).toBe(true)
  })

  it('her thinking holds the lattice blue even against a voice of the same strength', () => {
    const frames = run(() => ({ mic: 0.6, think: 0.9, say: 0 }), 1000)
    expect(frames.every(frame => frame.values.every(v => v === 0))).toBe(true)
  })

  it('hysteresis holds under noise: a challenger that leads only every other frame never wins', () => {
    const frames = run(t => ({ mic: (t / 16) % 2 === 0 ? 0.18 : 0.12, think: 0, say: 0 }), 3000)
    expect(frames.reduce((n, frame) => n + frame.changed.length, 0)).toBe(0)
    // And a near-tie never flickers: the margin is not crossed.
    const near = run(t => ({ mic: 0.1 + 0.05 * Math.sin(t / 7), think: 0, say: 0 }), 3000)
    expect(near.reduce((n, frame) => n + frame.changed.length, 0)).toBe(0)
  })

  it('gives each cube a fixed phase: cube k hears exactly what cube 0 heard k phases earlier (voices, not her thinking)', () => {
    expect(FLOW.PHASE_MS).toBe(35)
    const history = { mic: createHistory(), think: createHistory(), say: createHistory() }
    for (let t = 0; t <= 1400; t += 10) {
      history.mic.push(t, 0.5 + 0.5 * Math.sin(t / 37))
      history.think.push(t, 0.3 + 0.2 * Math.sin(t / 53))
      history.say.push(t, 0.5 + 0.5 * Math.cos(t / 29))
    }
    for (const shell of [0, 1, 2]) for (let k = 0; k < 5; k += 1) for (const t of [900, 1033, 1250]) {
      const kth = amplitudes(shell, t, history, FLOW, k), first = amplitudes(shell, t - k * FLOW.PHASE_MS, history, FLOW, 0)
      expect(kth.in).toBeCloseTo(first.in, 12)
      expect(kth.out).toBeCloseTo(first.out, 12)
      // HOLD is her thinking now, the same in every cube: it does not travel.
      expect(kth.hold).toBeCloseTo(amplitudes(shell, t, history, FLOW, 0).hold, 12)
    }
    // The default cube is 0: job 1's single-cube function, unchanged.
    expect(amplitudes(1, 900, history)).toEqual(amplitudes(1, 900, history, FLOW, 0))
  })

  it('a shared corner takes the earlier of its two cubes; every other cell its own', () => {
    LATTICE.cells.forEach((cell, i) => {
      expect(phases[i]).toBe(Math.min(...cell.cubes))
      if (cell.shell !== SHELL.CORNER) expect(phases[i]).toBe(cell.cubes[0])
    })
    // Cube 0 keeps all 8 of its corners; cube 4 shares every corner with an earlier cube, so it keeps none.
    expect(LATTICE.cells.filter((cell, i) => cell.shell === SHELL.CORNER && phases[i] === 0)).toHaveLength(8)
    expect(LATTICE.cells.filter((cell, i) => cell.shell === SHELL.CORNER && phases[i] === 4)).toHaveLength(0)
    expect(phaseCubeOf([3, 1])).toBe(1)
  })

  it('so a wave runs through the five cubes in turn: cube 0 keeps the single-cube timings, cube k is exactly k phases later', () => {
    // 1 ms frames, so the frame grid cannot hide a 35 ms phase.
    const say = (t: number) => ({ mic: 0, think: 0, say: t >= 100 && t < 500 ? 0.9 : 0 })
    const mic = (t: number) => ({ mic: t >= 100 && t < 500 ? 0.9 : 0, think: 0, say: 0 })
    for (const [levels, value] of [[mic, -1], [say, 1]] as const) {
      const single = run(levels, 1500, { frameMs: 1 })
      const five = run(levels, 1500, { cubes: true, frameMs: 1 })
      /** The first time every cell of `cells` holds `v` (at or after `from`). */
      const when = (frames: ReturnType<typeof run>, cells: number[], v: number, from = 0) =>
        frames.find(frame => frame.t >= from && cells.every(i => frame.values[i] === v))?.t ?? Infinity
      for (const shell of [0, 1, 2]) {
        const cube0 = indicesOnShell(shell).filter(i => phases[i] === 0)
        // Cube 0 is the single-cube rule, frame for frame.
        for (const frame of five) {
          const same = single[frame.t]!
          for (const i of cube0) expect(frame.values[i]).toBe(same.values[i])
        }
        const on0 = when(five, cube0, value)
        const off0 = when(five, cube0, 0, on0)
        expect(Number.isFinite(on0) && Number.isFinite(off0)).toBe(true)
        for (let k = 1; k < 5; k += 1) {
          const cubeK = indicesOnShell(shell).filter(i => phases[i] === k)
          if (cubeK.length === 0) continue
          const onK = when(five, cubeK, value)
          expect(onK).toBeGreaterThan(on0)
          expect(onK - on0).toBe(k * FLOW.PHASE_MS)
          expect(when(five, cubeK, 0, onK) - off0).toBe(k * FLOW.PHASE_MS)
        }
      }
    }
  })

  it('is deterministic: the same levels give the same values, frame for frame', () => {
    let seed = 7
    const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const script = Array.from({ length: 300 }, () => ({ mic: noise(), think: noise() * 0.6, say: noise() }))
    const a = run(t => script[t / 16] ?? {}, 299 * 16)
    const b = run(t => script[t / 16] ?? {}, 299 * 16)
    expect(a.map(frame => [...frame.values])).toEqual(b.map(frame => [...frame.values]))
    expect(a.some(frame => frame.changed.length > 0)).toBe(true)
  })

  it('is exactly the documented function of the three levels and the shell', () => {
    const history = { mic: createHistory(), think: createHistory(), say: createHistory() }
    for (let t = 0; t <= 1000; t += 10) {
      history.mic.push(t, t / 1000)
      history.think.push(t, 0.25)
      history.say.push(t, 1 - t / 1000)
    }
    for (const shell of [0, 1, 2]) {
      const amp = amplitudes(shell, 800, history)
      expect(amp.in).toBeCloseTo(((800 - shell * FLOW.T_MS) / 1000) * FLOW.REACH ** shell, 9)
      expect(amp.out).toBeCloseTo((1 - (800 - (3 - shell) * FLOW.T_MS) / 1000) * FLOW.REACH ** (2 - shell), 9)
      expect(amp.hold).toBeCloseTo(FLOW.HOLD_FLOOR + 0.25, 9)
    }
    expect(candidateOf({ in: 0.2, hold: 0.2, out: 0.2 })).toBe(0)
    expect(candidateOf({ in: 0.3, hold: 0.2, out: 0.3 })).toBe(1)
    expect(candidateOf({ in: 0.31, hold: 0.2, out: 0.3 })).toBe(-1)
    // Out-of-range or missing levels are clamped to 0..1, never invented.
    const h = createHistory()
    h.push(0, Number.NaN); h.push(10, 7); h.push(20, -3)
    expect([h.at(0), h.at(10), h.at(20), h.at(-5)]).toEqual([0, 1, 0, 0])
  })
})

describe('the travelling light', () => {
  const corner = LATTICE.cells.find(cell => cell.shell === SHELL.CORNER)!
  const step = (packets: ReturnType<typeof createPackets>, ms: number, think = 0) => {
    for (let t = 0; t < ms; t += 16) packets.step(16, think)
  }

  it('sends green inward along each of a cell\'s lines, and the packets end at the next shell', () => {
    const packets = createPackets(LATTICE)
    expect(packets.emitChange(corner.g, -1)).toBe(6)
    expect(packets.list.every(p => p.value === -1 && p.dir === 1 && LATTICE.lines[p.line]?.a === corner.g)).toBe(true)
    step(packets, PACKETS.FLOW_MS + 32)
    expect(packets.size).toBe(0)
  })

  it('a purple packet reaching a shared corner crosses into the other cube\'s edges, once', () => {
    const packets = createPackets(LATTICE)
    // An edge midpoint of the first cube beside `corner`, turning purple, sends light outward to the corner.
    const half = LATTICE.lines.find(line => line.family === 'edge' && line.a === corner.g)!
    expect(packets.emitChange(half.b, 1)).toBe(2)
    step(packets, PACKETS.FLOW_MS + 8)
    // Both ends of the edge are corners: each one's packet crosses, three ways, into its other cube.
    expect(packets.list.filter(p => p.hop === 1)).toHaveLength(6)
    const crossed = packets.list.filter(p => p.hop === 1 && LATTICE.lines[p.line]?.a === corner.g)
    expect(crossed).toHaveLength(3)
    const other = corner.cubes.find(c => c !== half.cube)
    for (const p of crossed) {
      const line = LATTICE.lines[p.line]!
      expect([line.cube, line.a, p.dir, p.value]).toEqual([other, corner.g, 1, 1])
    }
    step(packets, 2 * PACKETS.FLOW_MS)
    expect(packets.size).toBe(0)
  })

  it('runs at most two packets on one line: a third is not sent, and a blue one that would step onto a full line fades', () => {
    expect(PACKETS.PER_LINE).toBe(2)
    const packets = createPackets(LATTICE)
    expect(packets.emitChange(corner.g, -1)).toBe(6)
    expect(packets.emitChange(corner.g, -1)).toBe(6)
    // Every one of the corner's six lines is full: the third change sends nothing.
    expect(packets.emitChange(corner.g, -1)).toBe(0)
    expect(packets.size).toBe(12)
    for (const line of LATTICE.inward.get(corner.g)!) expect(packets.onLine(line)).toBe(2)
    // When they arrive the lines empty and take light again.
    step(packets, PACKETS.FLOW_MS + 32)
    expect(packets.size).toBe(0)
    for (const line of LATTICE.inward.get(corner.g)!) expect(packets.onLine(line)).toBe(0)
    expect(packets.emitChange(corner.g, -1)).toBe(6)
    // Blue orbits never exceed two a line either, however long she thinks, and the count always matches the list.
    const orbit = createPackets(LATTICE)
    for (let t = 0; t < 20_000; t += 16) {
      orbit.step(16, 1)
      if (t % 480 !== 0) continue
      const counts = new Map<number, number>()
      for (const p of orbit.list) counts.set(p.line, (counts.get(p.line) ?? 0) + 1)
      for (const [line, n] of counts) { expect(n).toBeLessThanOrEqual(2); expect(orbit.onLine(line)).toBe(n) }
    }
  })

  it('never holds more than the cap, and recycles the oldest', () => {
    const packets = createPackets(LATTICE)
    packets.emitChange(corner.g, -1)
    const oldest = packets.list[0]
    for (const cell of LATTICE.cells) packets.emitChange(cell.g, -1)
    expect(PACKETS.CAP).toBe(220)
    expect(packets.size).toBe(220)
    // The very first packet was recycled; the newest emitted (the last cell's) are all present.
    expect(packets.list.includes(oldest!)).toBe(false)
    const last = LATTICE.cells.at(-1)!
    expect(packets.list.filter(p => LATTICE.lines[p.line]?.a === last.g)).toHaveLength(LATTICE.inward.get(last.g)!.length)
  })

  it('lets blue circulate slowly round each cube while she thinks, and stop when she stops', () => {
    const packets = createPackets(LATTICE)
    step(packets, 3000, 0.95)
    expect(packets.size).toBeGreaterThan(0)
    expect(packets.list.every(p => p.kind === 'orbit' && p.value === 0 && LATTICE.lines[p.line]?.family === 'edge')).toBe(true)
    expect(new Set(packets.list.map(p => p.cube)).size).toBe(5)
    step(packets, PACKETS.ORBIT_MS + 32, 0)
    expect(packets.size).toBe(0)
    const calm = createPackets(LATTICE)
    step(calm, 3000, PACKETS.ORBIT_START)
    expect(calm.size).toBe(0)
  })

  it('makes no packets at all under reduced motion', () => {
    const packets = createPackets(LATTICE, { still: true })
    expect(packets.emitChange(corner.g, -1)).toBe(0)
    step(packets, 2000, 1)
    expect(packets.size).toBe(0)
    const live = createPackets(LATTICE)
    live.emitChange(corner.g, -1)
    live.setStill(true)
    expect(live.size).toBe(0)
  })
})
