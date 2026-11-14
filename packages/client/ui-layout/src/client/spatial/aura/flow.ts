// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE FLOW ON THE AURA COHERENCE PAGE: the conversation's breath, written on the Pentora's cell cores. A DISPLAY OF
 * FLOW, never health, never proof of anything. Two halves, both pure (no DOM, no clock, no randomness):
 *
 * 1. THE RULE, the same rule Auma Live runs (`apps/web/scripts/stock-apps/pentora-live/flow.mjs`), written again here
 *    because a package never imports across into an app; `tests/pentora-flow-parity.client.spec.ts` feeds both the same
 *    scripted levels and requires identical values at every step.
 *
 *      -1  IN    (mint)    the owner's turn arriving: the outer shell first, then inward
 *       0  HOLD  (blue)    her working, and rest
 *      +1  OUT   (violet)  her answer arriving: from the heart outward
 *
 *    For a cell on shell d (corner 0, edge midpoint 1, face centre 2; the heart would be 3) of cube k, at time t:
 *      in(d, k, t)   = mic(t - d*T - k*P)       * REACH^d
 *      out(d, k, t)  = say(t - (3-d)*T - k*P)   * REACH^(2-d)
 *      hold(d, k, t) = HOLD_FLOOR + think(t)
 *    A corner takes the earlier (lower) of its two cubes. The candidate is the largest (ties keep HOLD, then OUT); a cell
 *    changes only when the candidate leads its current value by more than MARGIN on CONFIRM_FRAMES consecutive steps.
 *
 * 2. THIS PAGE'S THREE SIGNALS (`absorbShown`, `levelsAt`). There is no microphone here, so nothing is a voice level:
 *      mic    the owner's message landing in the shown Session: 1, falling to 0 over IN_DECAY_MS
 *      say    her output arriving in the shown Session: its rate squashed to 0..1, decaying when it stops
 *      think  the shown Session's turn is open, less what mic and say carry (so the three never mask each other)
 *    With no Session shown every level is 0.
 */

/** The rule's constants: the same numbers as Auma Live's flow.mjs. */
export interface FlowConstants {
  /** ms a shell lags the one before it */
  readonly T_MS: number
  /** how much of each signal's past is kept */
  readonly HISTORY_MS: number
  /** HOLD's amplitude with no thinking at all */
  readonly HOLD_FLOOR: number
  /** how far a challenger must lead */
  readonly MARGIN: number
  /** for how many consecutive steps */
  readonly CONFIRM_FRAMES: number
  /** how much of a signal survives each shell it crosses */
  readonly REACH: number
  /** ms each cube lags the one before it */
  readonly PHASE_MS: number
}

export const FLOW: FlowConstants = Object.freeze({
  T_MS: 110,
  HISTORY_MS: 1500,
  HOLD_FLOOR: 0.1,
  MARGIN: 0.06,
  CONFIRM_FRAMES: 2,
  REACH: 0.8,
  PHASE_MS: 35,
})

export const VALUE = Object.freeze({ IN: -1, HOLD: 0, OUT: 1 } as const)
export type FlowValue = -1 | 0 | 1

/** The three levels at one instant, each 0..1 (a missing or non-finite level reads as 0). */
export interface FlowLevels {
  readonly mic?: number | undefined
  readonly think?: number | undefined
  readonly say?: number | undefined
}

export interface Amplitudes {
  in: number
  hold: number
  out: number
}

/** One signal's recent past, sampled by linear interpolation; silence before the first sample. */
export interface History {
  push(t: number, v: unknown): void
  at(t: number): number
  readonly size: number
}

export interface Histories {
  readonly mic: History
  readonly think: History
  readonly say: History
}

const clamp01 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/**
 * A signal's recent past.
 * @param keepMs - how much of the past to keep.
 * @returns the history.
 */
export function createHistory(keepMs: number = FLOW.HISTORY_MS): History {
  const times: number[] = []
  const values: number[] = []
  return {
    push(t, v) {
      if (times.length > 0 && t < (times[times.length - 1] ?? t)) { times.length = 0; values.length = 0 }
      times.push(t); values.push(clamp01(v))
      // Keep one sample older than the window, so a read at the window's edge still interpolates.
      while (times.length > 2 && (times[1] ?? 0) < t - keepMs) { times.shift(); values.shift() }
    },
    at(t) {
      const n = times.length
      if (n === 0 || t < (times[0] ?? 0)) return 0
      if (t >= (times[n - 1] ?? 0)) return values[n - 1] ?? 0
      let lo = 0, hi = n - 1
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((times[mid] ?? 0) <= t) lo = mid; else hi = mid }
      const tLo = times[lo] ?? 0, tHi = times[hi] ?? 0, vLo = values[lo] ?? 0, vHi = values[hi] ?? 0
      const span = tHi - tLo
      return span <= 0 ? vHi : vLo + (vHi - vLo) * ((t - tLo) / span)
    },
    get size() { return times.length },
  }
}

/**
 * The three amplitudes of a cell on `shell` whose phase is cube `cube`'s, at time `t`.
 * @returns in, hold and out.
 */
export function amplitudes(shell: number, t: number, history: Histories, flow: FlowConstants = FLOW, cube = 0): Amplitudes {
  const lag = cube * flow.PHASE_MS
  return {
    in: history.mic.at(t - shell * flow.T_MS - lag) * flow.REACH ** shell,
    hold: flow.HOLD_FLOOR + history.think.at(t),
    out: history.say.at(t - (3 - shell) * flow.T_MS - lag) * flow.REACH ** (2 - shell),
  }
}

/** The cube whose phase a cell takes: the earlier (lower) of its cubes. */
export function phaseCubeOf(cubes: readonly number[]): number {
  return cubes.length === 0 ? 0 : Math.min(...cubes)
}

/** The largest of the three; ties keep HOLD, then OUT. */
export function candidateOf(amp: Amplitudes): FlowValue {
  let value: FlowValue = VALUE.HOLD, best = amp.hold
  if (amp.out > best) { value = VALUE.OUT; best = amp.out }
  if (amp.in > best) { value = VALUE.IN; best = amp.in }
  return value
}

const ampOf = (amp: Amplitudes, value: number): number => (value === VALUE.IN ? amp.in : value === VALUE.OUT ? amp.out : amp.hold)

export interface FlowStep {
  readonly values: Int8Array
  readonly changed: readonly number[]
}

export interface Flow {
  readonly values: Int8Array
  readonly history: Histories
  step(t: number, levels: FlowLevels | undefined): FlowStep
}

/**
 * The flow over a set of cells. `shells[i]` is cell i's shell and `phases[i]` the cube whose phase it takes (all 0 when
 * omitted). `step(t, levels)` records the levels at time t (ms, increasing) and returns the values and the cells that
 * changed.
 */
export function createFlow(shells: readonly number[], flow: FlowConstants = FLOW, phases?: readonly number[]): Flow {
  const count = shells.length
  const phaseOf = Int16Array.from({ length: count }, (_, i) => phases?.[i] ?? 0)
  const cubeCount = count === 0 ? 1 : Math.max(...phaseOf) + 1
  if (phaseOf.some(k => k < 0)) throw new Error('pentora flow: a phase cube is negative')
  const values = new Int8Array(count)
  const challenger = new Int8Array(count).fill(2)
  const confirmations = new Uint8Array(count)
  const history: Histories = {
    mic: createHistory(flow.HISTORY_MS), think: createHistory(flow.HISTORY_MS), say: createHistory(flow.HISTORY_MS),
  }
  const changed: number[] = []
  // The amplitudes depend only on the shell and the phase cube: each step reads 3 x (cubes) of them, not one per cell.
  const perGroup: Amplitudes[] = Array.from({ length: 3 * cubeCount }, () => ({ in: 0, hold: 0, out: 0 }))
  return {
    values,
    history,
    step(t, levels) {
      history.mic.push(t, levels?.mic)
      history.think.push(t, levels?.think)
      history.say.push(t, levels?.say)
      for (let shell = 0; shell < 3; shell += 1) {
        for (let cube = 0; cube < cubeCount; cube += 1) {
          const group = perGroup[shell * cubeCount + cube]
          if (group !== undefined) Object.assign(group, amplitudes(shell, t, history, flow, cube))
        }
      }
      changed.length = 0
      for (let i = 0; i < count; i += 1) {
        const amp = perGroup[(shells[i] ?? 0) * cubeCount + (phaseOf[i] ?? 0)]
        if (amp === undefined) continue
        const now = values[i] ?? 0
        const next = candidateOf(amp)
        if (next !== now && ampOf(amp, next) > ampOf(amp, now) + flow.MARGIN) {
          if (challenger[i] === next) confirmations[i] = (confirmations[i] ?? 0) + 1
          else { challenger[i] = next; confirmations[i] = 1 }
          if ((confirmations[i] ?? 0) >= flow.CONFIRM_FRAMES) {
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

// ── This page's three signals ───────────────────────────────────────────────────────────────────────────────────────

/** IN falls from 1 to 0 over this long after the owner's message lands. */
export const IN_DECAY_MS = 1200
/** OUT decays by e in this long once her output stops arriving. */
export const OUT_DECAY_MS = 1500
/** Output arriving at this many units a second reads as 1 - 1/e (about 0.63). */
export const OUT_RATE = 20
/** The OUT level of an arrival whose size the store does not report (a model step closed, no output count). */
export const OUT_UNSIZED = 0.6

/** What the store holds about the shown Session, read by the surface (AuraPentoraSurface `shownFactsOf`). */
export interface ShownFacts {
  readonly id: string
  /** The shown Session's turn is open. */
  readonly running: boolean
  /** Turns in the held turn outline whose opening human prompt has landed; null when the store holds no outline. */
  readonly prompts: number | null
  /** Her summed output units (`sessionStats.decodeTokens`); null when absent. */
  readonly output: number | null
  /** Her summed model time (`sessionStats.llmMs`), which grows when a model step assembles a message; null when absent. */
  readonly modelMs: number | null
}

/** The page's flow feed: the shown Session's facts as last seen and the moments that move the three levels. */
export interface FlowFeed {
  readonly shown: ShownFacts | null
  /** When the owner's latest message was seen (client ms), or null. */
  readonly inAt: number | null
  /** When her latest output was seen (client ms), or null. */
  readonly outAt: number | null
  /** The size of that arrival, 0..1. */
  readonly outLevel: number
  /** When the shown turn last opened (client ms), or null. */
  readonly turnAt: number | null
}

export const EMPTY_FEED: FlowFeed = Object.freeze({ shown: null, inAt: null, outAt: null, outLevel: 0, turnAt: null })

const grew = (before: number | null, after: number | null): number =>
  (before === null || after === null || after <= before ? 0 : after - before)

/**
 * Fold the shown Session's facts into the feed. A change counts only when it is NEW since this view first saw that
 * Session, so opening the page (or switching Session) never replays history.
 * @param feed - the previous feed (returned unchanged when nothing moved).
 * @param facts - the shown Session's facts, or null when no Session is shown.
 * @param now - client clock (ms).
 * @returns the next feed.
 */
export function absorbShown(feed: FlowFeed, facts: ShownFacts | null, now: number): FlowFeed {
  if (facts === null) return feed.shown === null ? feed : EMPTY_FEED
  const before = feed.shown
  if (before === null || before.id !== facts.id) return { ...EMPTY_FEED, shown: facts, turnAt: facts.running ? now : null }
  let { inAt, outAt, outLevel, turnAt } = feed
  const opened = !before.running && facts.running
  if (opened) turnAt = now
  // IN: the outline tells the owner's opening prompt from her answer; without an outline, a turn opening stands in.
  if (facts.prompts !== null && before.prompts !== null ? facts.prompts > before.prompts : facts.prompts === null && opened) inAt = now
  // OUT: her output units grew; the rate is over the time since her previous output (or the turn's opening).
  const units = grew(before.output, facts.output)
  if (units > 0) {
    const since = Math.max(outAt ?? -Infinity, turnAt ?? -Infinity)
    const seconds = Number.isFinite(since) ? Math.max(1, (now - since) / 1000) : 1
    outLevel = 1 - Math.exp(-(units / seconds) / OUT_RATE)
    outAt = now
  } else if (grew(before.modelMs, facts.modelMs) > 0) {
    outLevel = OUT_UNSIZED
    outAt = now
  }
  const same = before.running === facts.running && before.prompts === facts.prompts && before.output === facts.output
    && before.modelMs === facts.modelMs
  if (same && inAt === feed.inAt && outAt === feed.outAt && turnAt === feed.turnAt) return feed
  return { shown: facts, inAt, outAt, outLevel, turnAt }
}

/**
 * The three levels at `now`.
 * @param feed - the page's feed.
 * @param now - client clock (ms).
 * @returns mic, think and say, each 0..1.
 */
export function levelsAt(feed: FlowFeed, now: number): { mic: number; think: number; say: number } {
  if (feed.shown === null) return { mic: 0, think: 0, say: 0 }
  const inAge = feed.inAt === null ? Infinity : Math.max(0, now - feed.inAt)
  const mic = inAge >= IN_DECAY_MS ? 0 : 1 - inAge / IN_DECAY_MS
  const outAge = feed.outAt === null ? Infinity : Math.max(0, now - feed.outAt)
  const decayed = feed.outLevel * Math.exp(-outAge / OUT_DECAY_MS)
  const say = decayed < 0.02 ? 0 : decayed
  const think = feed.shown.running ? clamp01(1 - 1.5 * mic - 3 * say) : 0
  return { mic, think, say }
}
