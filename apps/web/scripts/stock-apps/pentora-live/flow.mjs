// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE FLOW RULE: the breath of the conversation, written on the Pentora's cells. A DISPLAY OF FLOW, never health,
 * never a fingerprint, never proof of anything: every value below comes from three live levels Auma Live already has
 * (`mic` your voice, `think` her working state, `say` her voice, each 0..1) and from where a cell sits in its cube.
 *
 *   -1  IN    (green)   your voice arriving: the corners first, then inward
 *    0  HOLD  (blue)    her thinking, and rest
 *   +1  OUT   (purple)  her voice leaving: from the heart outward
 *
 * For a cell on shell d (corner 0, edge midpoint 1, face centre 2; the heart would be 3) of cube k, at time t:
 *   in(d, k, t)   = mic(t - d*T - k*P)       * REACH^d          your voice reaches the corners first, travels inward
 *   out(d, k, t)  = say(t - (3-d)*T - k*P)   * REACH^(2-d)      her voice leaves the heart and travels outward
 *   hold(d, k, t) = HOLD_FLOOR + think(t)
 * P is the cube phase: each of the five cubes hears the same breath PHASE_MS later than the one before it, so a wave
 * runs through the five cubes in sequence instead of striking them all at once. A corner belongs to two cubes and
 * takes the EARLIER of the two (the lower index). Cube 0 keeps the single-cube timings exactly; cube k is k*P later.
 * The candidate is the largest of the three (ties keep HOLD, then OUT). A cell changes only when the candidate leads
 * the cell's current value by more than MARGIN on CONFIRM_FRAMES consecutive steps, so it never flickers.
 * REACH < 1 is why depth follows loudness: a soft voice turns the corners and stops; a full one reaches the faces.
 * Pure: no DOM, no clock, no randomness. The same pushes give the same values.
 */
export const FLOW = Object.freeze({
  /** ms a shell lags the one before it */
  T_MS: 110,
  /** how much of each signal's past is kept */
  HISTORY_MS: 1500,
  /** HOLD's amplitude with no thinking at all: silence is a calm blue lattice */
  HOLD_FLOOR: 0.1,
  /** how far a challenger must lead */
  MARGIN: 0.06,
  /** for how many consecutive steps */
  CONFIRM_FRAMES: 2,
  /** how much of a voice survives each shell it crosses */
  REACH: 0.8,
  /** ms each cube lags the one before it (cube k hears everything k*PHASE_MS later): the five cubes talk in turn */
  PHASE_MS: 35,
})

export const VALUE = Object.freeze({ IN: -1, HOLD: 0, OUT: 1 })

const clamp01 = v => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** One signal's recent past, sampled by linear interpolation; silence before the first sample. */
export function createHistory(keepMs = FLOW.HISTORY_MS) {
  const times = []
  const values = []
  return {
    push(t, v) {
      if (times.length > 0 && t < times[times.length - 1]) { times.length = 0; values.length = 0 }
      times.push(t); values.push(clamp01(v))
      // Keep one sample older than the window, so a read at the window's edge still interpolates.
      while (times.length > 2 && times[1] < t - keepMs) { times.shift(); values.shift() }
    },
    at(t) {
      const n = times.length
      if (n === 0 || t < times[0]) return 0
      if (t >= times[n - 1]) return values[n - 1]
      let lo = 0, hi = n - 1
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid }
      const span = times[hi] - times[lo]
      return span <= 0 ? values[hi] : values[lo] + (values[hi] - values[lo]) * ((t - times[lo]) / span)
    },
    get size() { return times.length },
  }
}

/** The three amplitudes of a cell on `shell` whose phase is cube `cube`'s, at time `t`, read from the histories. */
export function amplitudes(shell, t, history, flow = FLOW, cube = 0) {
  const lag = cube * flow.PHASE_MS
  return {
    in: history.mic.at(t - shell * flow.T_MS - lag) * flow.REACH ** shell,
    hold: flow.HOLD_FLOOR + history.think.at(t),
    out: history.say.at(t - (3 - shell) * flow.T_MS - lag) * flow.REACH ** (2 - shell),
  }
}

/** The cube whose phase a cell takes: the earlier (lower) of its cubes. A shared corner takes the earlier of its two. */
export function phaseCubeOf(cubes) {
  return cubes.length === 0 ? 0 : Math.min(...cubes)
}

/** The largest of the three; ties keep HOLD, then OUT. */
export function candidateOf(amp) {
  let value = VALUE.HOLD, best = amp.hold
  if (amp.out > best) { value = VALUE.OUT; best = amp.out }
  if (amp.in > best) { value = VALUE.IN; best = amp.in }
  return value
}

const ampOf = (amp, value) => (value === VALUE.IN ? amp.in : value === VALUE.OUT ? amp.out : amp.hold)

/**
 * The flow over a set of cells. `shells[i]` is cell i's shell and `phases[i]` the cube whose phase it takes (all 0 when
 * omitted: a single cube). `step(t, { mic, think, say })` records the levels at time t (ms, increasing) and returns the
 * values (one per cell, -1/0/+1) and the indices of the cells that changed.
 */
export function createFlow(shells, flow = FLOW, phases = undefined) {
  const count = shells.length
  const phaseOf = Int16Array.from({ length: count }, (_, i) => phases?.[i] ?? 0)
  const cubeCount = count === 0 ? 1 : Math.max(...phaseOf) + 1
  if (phaseOf.some(k => k < 0)) throw new Error('pentora flow: a phase cube is negative')
  const values = new Int8Array(count)
  const challenger = new Int8Array(count).fill(2)
  const confirmations = new Uint8Array(count)
  const history = { mic: createHistory(flow.HISTORY_MS), think: createHistory(flow.HISTORY_MS), say: createHistory(flow.HISTORY_MS) }
  const changed = []
  // The amplitudes depend only on the shell and the phase cube: each step reads 3 x (cubes) of them, not one per cell.
  const perGroup = Array.from({ length: 3 * cubeCount }, () => ({ in: 0, hold: 0, out: 0 }))
  return {
    values,
    history,
    step(t, levels) {
      history.mic.push(t, levels?.mic)
      history.think.push(t, levels?.think)
      history.say.push(t, levels?.say)
      for (let shell = 0; shell < 3; shell += 1) {
        for (let cube = 0; cube < cubeCount; cube += 1) Object.assign(perGroup[shell * cubeCount + cube], amplitudes(shell, t, history, flow, cube))
      }
      changed.length = 0
      for (let i = 0; i < count; i += 1) {
        const amp = perGroup[shells[i] * cubeCount + phaseOf[i]]
        const now = values[i]
        const next = candidateOf(amp)
        if (next !== now && ampOf(amp, next) > ampOf(amp, now) + flow.MARGIN) {
          if (challenger[i] === next) confirmations[i] += 1
          else { challenger[i] = next; confirmations[i] = 1 }
          if (confirmations[i] >= flow.CONFIRM_FRAMES) {
            values[i] = next; challenger[i] = 2; confirmations[i] = 0
            changed.push(i)
          }
        } else {
          challenger[i] = 2; confirmations[i] = 0
        }
      }
      return { values, changed }
    },
  }
}
