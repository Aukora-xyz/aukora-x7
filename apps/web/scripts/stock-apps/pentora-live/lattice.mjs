// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PENTORA AS A LATTICE: every cell, every line, derived once from the pinned tables (tables.ts). Nothing here is
 * copied by hand: the cells, their shells, the three line families and the shared-corner map all come from `CUBES`,
 * `POINTS` and `CORNER_CELLS`, and the build refuses a table that does not have the shape the picture assumes.
 *
 *   shell 0   corner         8 per cube, 20 in all, each shared by exactly two cubes
 *   shell 1   edge midpoint  12 per cube, 60 in all
 *   shell 2   face centre    6 per cube, 30 in all
 *   shell 3   the heart      point 55, the centre of all five cubes; no cell, no value
 *
 *   edge   corner -> edge midpoint   (each of a cube's 12 edges as two half-segments through its midpoint cell)
 *   cross  edge midpoint -> face centre (each face centre to the 4 midpoints of its own face, found by distance)
 *   spoke  face centre -> the heart
 *
 * Every line is stored outer end first (`a` on the lower shell, `b` on the higher), so "inward" is a -> b.
 * Plain JS on purpose: it reaches into another project's source, which only esbuild (and vitest) should follow.
 */
import { CORNER_CELLS, CUBES, POINTS } from '../../../../../packages/client/ui-layout/src/client/spatial/aura/tables.ts'

export const HEART = 55
export const SHELL = Object.freeze({ CORNER: 0, EDGE: 1, FACE: 2, HEART: 3 })

const distance = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])

function pointOf(g) {
  const point = POINTS[g]
  if (point === undefined) throw new Error(`pentora lattice: point ${String(g)} is missing from POINTS`)
  return point
}

/** A Hamiltonian cycle through a cube's 8 corners along its own edges, as an ordered corner list (depth-first). */
function cornerCycle(cube) {
  const next = new Map(cube.corners.map(g => [g, []]))
  for (const [p, q] of cube.edges) { next.get(p).push(q); next.get(q).push(p) }
  const start = cube.corners[0]
  const path = [start]
  const seen = new Set(path)
  const walk = () => {
    const here = path[path.length - 1]
    if (path.length === cube.corners.length) return next.get(here).includes(start)
    for (const g of [...next.get(here)].sort((x, y) => x - y)) {
      if (seen.has(g)) continue
      path.push(g); seen.add(g)
      if (walk()) return true
      path.pop(); seen.delete(g)
    }
    return false
  }
  if (!walk()) throw new Error('pentora lattice: a cube has no Hamiltonian cycle (not a cube)')
  return path
}

/** Build the lattice from the tables. Exported for the tests; the module also builds it once as `LATTICE`. */
export function buildLattice(cubes = CUBES, cornerCells = CORNER_CELLS) {
  const heart = pointOf(HEART)
  if (heart.some(v => Math.abs(v) > 1e-9)) throw new Error('pentora lattice: point 55 is not the centre')

  /** global index -> { shell, cubes[] } */
  const byGlobal = new Map()
  const claim = (g, shell, cube) => {
    const found = byGlobal.get(g)
    if (found === undefined) { byGlobal.set(g, { g, shell, cubes: [cube] }); return }
    if (found.shell !== shell) throw new Error(`pentora lattice: cell ${String(g)} sits on two shells`)
    if (!found.cubes.includes(cube)) found.cubes.push(cube)
  }
  cubes.forEach((cube, c) => {
    for (const g of cube.corners) claim(g, SHELL.CORNER, c)
    for (const g of cube.edgeMidpoints) claim(g, SHELL.EDGE, c)
    for (const g of cube.faceCentres) claim(g, SHELL.FACE, c)
  })
  if (byGlobal.has(HEART)) throw new Error('pentora lattice: the heart must not be a cell')

  const cells = [...byGlobal.values()].sort((x, y) => x.g - y.g).map((cell, index) => Object.freeze({
    index, g: cell.g, shell: cell.shell, cubes: Object.freeze([...cell.cubes].sort((x, y) => x - y)), point: pointOf(cell.g),
  }))
  const cellOf = new Map(cells.map(cell => [cell.g, cell.index]))

  const lines = []
  const add = (family, cube, a, b) => { lines.push(Object.freeze({ index: lines.length, family, cube, a, b })) }
  cubes.forEach((cube, c) => {
    cube.edges.forEach(([p, q], e) => {
      const m = cube.edgeMidpoints[e]
      if (m === undefined) throw new Error('pentora lattice: an edge has no midpoint')
      add('edge', c, p, m)
      add('edge', c, q, m)
    })
  })
  cubes.forEach((cube, c) => {
    for (const f of cube.faceCentres) {
      const at = pointOf(f)
      const near = cube.edgeMidpoints.map(m => ({ m, d: distance(at, pointOf(m)) })).sort((x, y) => x.d - y.d)
      const nearest = near[0]?.d ?? 0
      const own = near.filter(each => each.d <= nearest * 1.02)
      if (own.length !== 4) throw new Error(`pentora lattice: face centre ${String(f)} is beside ${String(own.length)} midpoints, not 4`)
      for (const { m } of own.sort((x, y) => x.m - y.m)) add('cross', c, m, f)
    }
  })
  cubes.forEach((cube, c) => { for (const f of cube.faceCentres) add('spoke', c, f, HEART) })

  const inward = new Map([...cellOf.keys()].map(g => [g, []]))
  const outward = new Map([...cellOf.keys(), HEART].map(g => [g, []]))
  for (const line of lines) {
    inward.get(line.a)?.push(line.index)
    outward.get(line.b)?.push(line.index)
  }

  /** corner -> the edge half-segments that leave it, per cube: how a packet crosses from one cube into the other. */
  const cornerEdges = new Map(cornerCells.map(g => [g, lines.filter(line => line.family === 'edge' && line.a === g).map(line => line.index)]))

  /** Per cube, the slow blue orbit: half-segment steps round a Hamiltonian cycle of its corners (16 steps a lap). */
  const orbits = cubes.map((cube, c) => {
    const ring = cornerCycle(cube)
    const route = []
    ring.forEach((p, k) => {
      const q = ring[(k + 1) % ring.length]
      const e = cube.edges.findIndex(([x, y]) => (x === p && y === q) || (x === q && y === p))
      const m = cube.edgeMidpoints[e]
      const out = lines.find(line => line.family === 'edge' && line.cube === c && line.a === p && line.b === m)
      const back = lines.find(line => line.family === 'edge' && line.cube === c && line.a === q && line.b === m)
      route.push(Object.freeze({ line: out.index, dir: 1 }), Object.freeze({ line: back.index, dir: -1 }))
    })
    return Object.freeze(route)
  })

  const freezeMap = map => new Map([...map].map(([k, v]) => [k, Object.freeze(v)]))
  return Object.freeze({
    heart: HEART,
    cells: Object.freeze(cells),
    cellOf,
    lines: Object.freeze(lines),
    inward: freezeMap(inward),
    outward: freezeMap(outward),
    cornerEdges: freezeMap(cornerEdges),
    orbits: Object.freeze(orbits),
    cubeCount: cubes.length,
  })
}

export const LATTICE = buildLattice()

/** The point of any lattice position (a cell or the heart), for the renderer. */
export function pointAt(g) { return pointOf(g) }
