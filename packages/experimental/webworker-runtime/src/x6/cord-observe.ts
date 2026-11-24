/**
 * The blind twin (docs/auma/cord-echo.md "What a watcher can know"). A pure function, no I/O and no tool
 * action: given a fifo24 checkpoint at tick c, the declared inputs for ticks c+1..c+k, the outputs observed for those
 * ticks, and a claim about the state at tick c, it answers whether the claim is determined by what was observed.
 *
 *  - KNOWN, with its value: the claim's row is in the span (mod P) of the observed rows; the value comes from the observed
 *    outputs alone, never from the checkpoint's state (exact Gaussian elimination over the field).
 *  - UNOBSERVABLE, with a constructive twin: a state that gives every observed output and a claimed value larger by
 *    exactly 1. The function only constructs the twin; the PINNED cell verifies it (tests/x6/cord-observe.spec.ts runs
 *    `cord.run` on both checkpoints and compares).
 *
 * For fifo24 with k = 23: the oldest word s[23] = u[c-23] enters no future output, so `y[c]` (which uses it) is
 * UNOBSERVABLE with the twin s[23] + 1, and `u[c-10]` is KNOWN. Nothing here grants anything.
 * @module x6/cord-observe
 */
import { CORD_FIELD, CORD_WORDS, cordFifoOracle } from './cord-run.ts'

/** A claim about the state at tick c: an input j ticks back (u[c-j] = s[j]), or the current output y[c]. */
export type CordObserveClaim = { readonly kind: 'input'; readonly ago: number } | { readonly kind: 'current-output' }

export type CordObservation =
  | { readonly status: 'KNOWN'; readonly value: number; readonly rank: number }
  | { readonly status: 'UNOBSERVABLE'; readonly rank: number; readonly twin: readonly number[]; readonly values: { readonly state: number; readonly twin: number } }
  | { readonly status: 'INCONSISTENT'; readonly reason: string }

const P = CORD_FIELD
const mod = (value: number): number => ((value % P) + P) % P
const mul = (a: number, b: number): number => Number((BigInt(a) * BigInt(b)) % BigInt(P))
function inverse(a: number): number {
  let result = 1, base = mod(a), exponent = P - 2
  while (exponent > 0) { if (exponent & 1) result = mul(result, base); base = mul(base, base); exponent >>= 1 }
  return result
}

/** The claim as a row over the 24 state words. */
function claimRow(claim: CordObserveClaim): number[] | null {
  const row = new Array<number>(CORD_WORDS).fill(0)
  if (claim.kind === 'input') {
    if (!Number.isSafeInteger(claim.ago) || claim.ago < 0 || claim.ago >= CORD_WORDS) return null
    row[claim.ago] = 1
    return row
  }
  row[7] = 3; row[15] = P - 2; row[23] = 1
  return row
}

/** An entry of a row, 0 past its end. */
const at = (row: readonly number[], index: number): number => row[index] ?? 0
const dot = (row: readonly number[], state: readonly number[]): number =>
  row.reduce((sum, value, index) => mod(sum + mul(value, at(state, index))), 0)

/** What the blind twin is asked: the state at tick c, the inputs and observed outputs after it, and the claim. */
export interface CordObserveInput {
  readonly state: readonly number[]
  readonly inputs: readonly number[]
  readonly outputs: readonly number[]
  readonly claim: CordObserveClaim
}

/**
 * Decide one claim from observed outputs.
 * @param input - `state`: the 24 words at tick c (used only to build the twin and to check the observations agree);
 *   `inputs`: u[c+1..c+k], each 0..P-1; `outputs`: y[c+1..c+k] as observed; `claim`: what is claimed about tick c.
 * @returns KNOWN with the value, UNOBSERVABLE with a twin, or INCONSISTENT with the reason.
 */
export function cordObserve(input: CordObserveInput): CordObservation {
  const { state, inputs, outputs } = input
  const word = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value < P
  if (state.length !== CORD_WORDS || !state.every(word) || !inputs.every(word) || !outputs.every(word)) return { status: 'INCONSISTENT', reason: 'range' }
  if (inputs.length !== outputs.length || inputs.length === 0) return { status: 'INCONSISTENT', reason: 'lengths' }
  const target = claimRow(input.claim)
  if (target === null) return { status: 'INCONSISTENT', reason: 'claim' }
  // The observations must be what this state and these inputs give (a twin is built from a state that fits them).
  if (cordFifoOracle(state, inputs).outputs.some((value, index) => value !== outputs[index])) return { status: 'INCONSISTENT', reason: 'outputs' }

  // Row j (tick c+j): y = 3u[c+j-7] - 2u[c+j-15] + u[c+j-23]; a tap at or before tick c reads s[lag - j], a later one a declared input.
  const rows: number[][] = []
  for (let j = 1; j <= inputs.length; j += 1) {
    const row = new Array<number>(CORD_WORDS + 1).fill(0)
    let known = 0
    for (const [lag, coefficient] of [[7, 3], [15, P - 2], [23, 1]] as const) {
      if (j - lag <= 0) row[lag - j] = mod((row[lag - j] ?? 0) + coefficient)
      else known = mod(known + mul(coefficient, inputs[j - lag - 1] ?? 0))
    }
    row[CORD_WORDS] = mod((outputs[j - 1] ?? 0) - known)
    rows.push(row)
  }
  // Reduced row echelon form over the field.
  const pivots: Array<{ row: number[]; column: number }> = []
  let rest = rows
  for (let column = 0; column < CORD_WORDS; column += 1) {
    const found = rest.find(row => at(row, column) !== 0)
    if (found === undefined) continue
    const scale = inverse(at(found, column))
    const pivot = found.map(value => mul(value, scale))
    const eliminate = (row: number[]): number[] => {
      const factor = at(row, column)
      return factor === 0 ? row : row.map((value, index) => mod(value - mul(factor, at(pivot, index))))
    }
    rest = rest.filter(row => row !== found).map(eliminate)
    for (const earlier of pivots) earlier.row = eliminate(earlier.row)
    pivots.push({ row: pivot, column })
  }
  if (rest.some(row => at(row, CORD_WORDS) !== 0)) return { status: 'INCONSISTENT', reason: 'observations' }
  // Reduce the claim by the pivots, carrying the observed right-hand sides.
  const residual = [...target]
  let value = 0
  for (const { row, column } of pivots) {
    const factor = at(residual, column)
    if (factor === 0) continue
    for (let index = 0; index < CORD_WORDS; index += 1) residual[index] = mod(at(residual, index) - mul(factor, at(row, index)))
    value = mod(value + mul(factor, at(row, CORD_WORDS)))
  }
  const free = residual.findIndex(entry => entry !== 0)
  if (free < 0) return { status: 'KNOWN', value, rank: pivots.length }
  // A null-space direction v of the observed rows with claim(v) = residual[free] != 0, scaled so the claim moves by 1.
  const direction = new Array<number>(CORD_WORDS).fill(0)
  direction[free] = 1
  for (const { row, column } of pivots) direction[column] = mod(-at(row, free))
  const scale = inverse(at(residual, free))
  const twin = state.map((entry, index) => mod(entry + mul(scale, at(direction, index))))
  return { status: 'UNOBSERVABLE', rank: pivots.length, twin, values: { state: dot(target, state), twin: dot(target, twin) } }
}
