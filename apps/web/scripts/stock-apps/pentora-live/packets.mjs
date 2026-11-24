// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * LIGHT THAT TRAVELS: small packets of colour moving along the Pentora's lines. Pure state, no DOM, no randomness.
 *
 *   green (-1)   when a cell turns IN, one packet runs along each of its lines toward the next shell inward
 *   purple (+1)  when a cell turns OUT, one packet runs along each of its lines toward the next shell outward; a purple
 *                packet that reaches a corner crosses into the OTHER cube that shares that corner and runs on along its
 *                edges (once): that is how the five cubes talk
 *   blue (0)     while `think` is high, packets circulate slowly round each cube's edges (a cycle of its 8 corners)
 *
 * At most CAP packets live at once; a new one past the cap recycles the oldest. At most PER_LINE packets run on one
 * line at a time: a packet that would be a third on its line is not sent (a blue one that would step onto a full line
 * fades instead), so light on crossing lines never piles up into white. Under reduced motion there are none.
 */
export const PACKETS = Object.freeze({
  CAP: 220,
  /** the most packets alive on one line at once */
  PER_LINE: 2,
  /** ms for a flow packet to run one line */
  FLOW_MS: 240,
  /** ms for a blue packet to run one half-edge: slow */
  ORBIT_MS: 420,
  /** `think` above which the blue orbit starts, and below which a blue packet stops at its next corner */
  ORBIT_START: 0.4,
  ORBIT_KEEP: 0.25,
  /** ms between blue packets on one cube at full `think` (slower as `think` falls toward ORBIT_START) */
  ORBIT_EVERY_MS: 520,
  /** half-edges a blue packet runs before it fades: one lap of its cube */
  ORBIT_STEPS: 16,
})

/**
 * @param lattice - the lattice (lattice.mjs `LATTICE`).
 * @param options.cap - the most packets alive at once.
 * @param options.still - reduced motion: no packets at all.
 * @param options.perLine - the most packets alive on one line at once.
 */
export function createPackets(lattice, { cap = PACKETS.CAP, still = false, perLine = PACKETS.PER_LINE } = {}) {
  const list = []
  const pending = []
  /** packets alive on each line */
  const onLine = new Uint8Array(lattice.lines.length)
  const orbitClock = new Float64Array(lattice.cubeCount)
  const orbitNext = new Uint8Array(lattice.cubeCount)
  let isStill = still
  const empty = () => { list.length = 0; onLine.fill(0) }

  /** Add a packet unless its line is full; past the cap the oldest is recycled. Returns whether it was added. */
  const add = (packet) => {
    if (isStill || onLine[packet.line] >= perLine) return false
    if (list.length >= cap) { const oldest = list.shift(); onLine[oldest.line] -= 1 }
    list.push(packet)
    onLine[packet.line] += 1
    return true
  }

  /** A cell changed value: send its colour toward the next shell in the direction of the flow. Returns how many. */
  function emitChange(g, value) {
    if (isStill) return 0
    const lines = value < 0 ? lattice.inward.get(g) : value > 0 ? lattice.outward.get(g) : undefined
    if (lines === undefined) return 0
    let sent = 0
    for (const line of lines) {
      if (add({ kind: 'flow', line, dir: value < 0 ? 1 : -1, t: 0, value, hop: 0, cube: lattice.lines[line].cube, steps: 0 })) sent += 1
    }
    return sent
  }

  /** Where a packet ends: the far end of its line in its direction. */
  const endOf = p => (p.dir > 0 ? lattice.lines[p.line].b : lattice.lines[p.line].a)

  function arrive(p, overflow, think) {
    if (p.kind === 'flow') {
      if (p.value > 0 && p.hop === 0) {
        const corner = endOf(p)
        for (const line of lattice.cornerEdges.get(corner) ?? []) {
          const cube = lattice.lines[line].cube
          if (cube === p.cube) continue
          pending.push({ kind: 'flow', line, dir: 1, t: overflow, value: p.value, hop: 1, cube, steps: 0 })
        }
      }
      return false
    }
    if (think < PACKETS.ORBIT_KEEP || p.steps + 1 >= PACKETS.ORBIT_STEPS) return false
    const route = lattice.orbits[p.cube]
    const next = (p.route + 1) % route.length
    if (onLine[route[next].line] >= perLine) return false
    onLine[p.line] -= 1
    onLine[route[next].line] += 1
    p.steps += 1
    p.route = next
    p.line = route[p.route].line
    p.dir = route[p.route].dir
    p.t = overflow
    return true
  }

  /** Advance every packet by `dtMs`; spawn the blue orbit from `think`. */
  function step(dtMs, think) {
    if (isStill) { empty(); return }
    const level = typeof think === 'number' && Number.isFinite(think) ? think : 0
    if (level > PACKETS.ORBIT_START) {
      const pace = (level - PACKETS.ORBIT_START) / (1 - PACKETS.ORBIT_START)
      for (let c = 0; c < lattice.cubeCount; c += 1) {
        orbitClock[c] += dtMs * pace
        if (orbitClock[c] < PACKETS.ORBIT_EVERY_MS) continue
        orbitClock[c] = 0
        const route = lattice.orbits[c]
        const at = orbitNext[c] % route.length
        orbitNext[c] = (at + 5) % route.length
        pending.push({ kind: 'orbit', line: route[at].line, dir: route[at].dir, t: 0, value: 0, hop: 0, cube: c, steps: 0, route: at })
      }
    }
    let keep = 0
    for (const p of list) {
      p.t += dtMs / (p.kind === 'orbit' ? PACKETS.ORBIT_MS : PACKETS.FLOW_MS)
      let alive = true
      while (alive && p.t >= 1) alive = arrive(p, p.t - 1, level)
      if (alive) list[keep++] = p
      else onLine[p.line] -= 1
    }
    list.length = keep
    for (const p of pending) add(p)
    pending.length = 0
  }

  return {
    list,
    emitChange,
    step,
    clear() { empty(); pending.length = 0 },
    setStill(value) { isStill = Boolean(value); if (isStill) empty() },
    /** packets alive on line `i` right now */
    onLine(i) { return onLine[i] ?? 0 },
    get size() { return list.length },
  }
}
