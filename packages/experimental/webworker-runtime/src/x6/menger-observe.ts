/**
 * the Menger hive observability & reachable 4-tick blind twin (docs/auma/menger-hive.md). Pure synchronous integer module:
 * zero I/O, zero network, zero storage, zero authority, and ZERO privacy claims (`privacyClaim: false`).
 *
 * Under the detuned wave law mod P = 65,521 on both 80-site wirings ("menger" and "plain"), the 20 shared corner
 * readings over T = 8 ticks (160 readings) have full rank 160 over the 160-word state space: every private organ word
 * is KNOWN from the corner readings and declared inputs alone (`blindDimsAt8: 0`). At T = 4 ticks (80 readings),
 * `blindDimsAt4: 80`, and any reachable start state has a constructive reachable twin that differs on organ 0's private
 * site while producing all 80 identical corner readings across the 4 ticks (`menger-run.ts` verifies those 80 readings
 * through the pinned `menger-hive` Wasm cell).
 *
 * Caller-supplied sequence check: when `seqs` are passed alongside readings, any non-consecutive entry (`seq !== prevSeq + 1`)
 * is rejected `INCONSISTENT` (`reason: 'rewind'`); `menger-hive` cell answers carry no `seq`, so this checks caller-passed
 * `seqs` only, not standalone state rewinds.
 * @module x6/menger-observe
 */

export type MengerWiringName = 'menger' | 'plain'

export const MENGER_FIELD = 65_521
export const MENGER_SITES = 80
export const MENGER_STATE_WORDS = 160
export const MENGER_CORNERS = 20
export const MENGER_ORGANS = 5
export const MENGER_ORGAN_PRIVATE_SITES = 12
export const MENGER_ORGAN_WORDS = 24
export const MENGER_BODY_WORDS = 136
export const MENGER_BOUNDARY_WORDS = 7
export const MENGER_HORIZON_TICKS = 8
export const MENGER_CYCLE_RANK = 41
export const MENGER_LINKS = 120
export const MENGER_WIRINGS_SCHEMA = 'aukora.menger.wirings.v1'
export const MENGER_TABLE_SHA256 = '96b27c9b4de41cd961612be5b1e88d40e973a2fded16bd320415b3e15e3b8c61'
export const MENGER_WIRINGS_SHA256 = '25b846a37f34eee87698f1b9f119dc3101ebfe1ab73ab17de0758f0546a930a3'

export interface MengerWiringSpec {
  readonly deg: readonly number[]
  readonly det: readonly number[]
  readonly detunedWaveReach: number
  readonly edges: readonly (readonly [number, number])[]
  readonly globalSites?: readonly number[]
  readonly undetunedOneCornerWaveReach: number
}

export interface MengerWiringsDoc {
  readonly boundaryWords: 7
  readonly corners: 20
  readonly cycleRank: 41
  readonly field: 65521
  readonly horizonTicks: 8
  readonly inletCornerIndex: 0
  readonly links: 120
  readonly organPrivateSites: 12
  readonly organWords: 24
  readonly organs: 5
  readonly schema: typeof MENGER_WIRINGS_SCHEMA
  readonly sites: 80
  readonly stateWords: 160
  readonly tableSha256: string
  readonly wirings: Readonly<Record<MengerWiringName, MengerWiringSpec>>
}

const atNum = (arr: ArrayLike<number>, idx: number): number => arr[idx] ?? 0
const atRow = <T>(arr: readonly T[], idx: number): T => {
  const item = arr[idx]
  if (item === undefined) throw new RangeError(`index ${idx} out of bounds`)
  return item
}

const MENGER_DEG: readonly number[] = Object.freeze([
  ...new Array<number>(20).fill(6),
  ...new Array<number>(60).fill(2),
])

const MENGER_DET: readonly number[] = Object.freeze([
  3, 9, 8, 9, 0, 1, 0, 6, 7, 2, 9, 4, 5, 0, 10, 0, 2, 3, 2, 8,
  3, 4, 5, 6, 0, 1, 10, 0, 5, 6, 7, 8, 4, 2, 3, 2, 8, 9, 2, 3,
  9, 8, 9, 7, 10, 7, 7, 8, 3, 4, 7, 8, 3, 4, 4, 1, 5, 1, 5, 3,
  5, 10, 1, 6, 8, 6, 10, 6, 0, 6, 9, 9, 0, 5, 6, 0, 2, 2, 5, 0,
])

const MENGER_GLOBAL_SITES: readonly number[] = Object.freeze([
  0, 1, 10, 12, 16, 18, 27, 28, 52, 53, 57, 58, 82, 83, 92, 94, 98, 100, 109, 110,
  11, 13, 15, 17, 49, 51, 59, 61, 93, 95, 97, 99,
  2, 9, 22, 31, 43, 45, 65, 67, 79, 88, 101, 108,
  3, 8, 19, 32, 44, 46, 64, 66, 78, 91, 102, 107,
  4, 7, 26, 33, 37, 47, 63, 73, 77, 84, 103, 106,
  5, 6, 23, 34, 38, 48, 62, 72, 76, 87, 104, 105,
])

const MENGER_EDGES: readonly (readonly [number, number])[] = Object.freeze(([
  [0, 44], [0, 45], [0, 46], [0, 68], [0, 69], [0, 70], [1, 32], [1, 33], [1, 34], [1, 56], [1, 57], [1, 58],
  [2, 20], [2, 21], [2, 24], [2, 32], [2, 35], [2, 37], [3, 20], [3, 22], [3, 25], [3, 44], [3, 47], [3, 49],
  [4, 21], [4, 23], [4, 26], [4, 56], [4, 59], [4, 61], [5, 22], [5, 23], [5, 27], [5, 68], [5, 71], [5, 73],
  [6, 57], [6, 60], [6, 62], [6, 69], [6, 72], [6, 74], [7, 33], [7, 36], [7, 38], [7, 45], [7, 48], [7, 50],
  [8, 46], [8, 51], [8, 52], [8, 59], [8, 60], [8, 65], [9, 34], [9, 39], [9, 40], [9, 71], [9, 72], [9, 77],
  [10, 35], [10, 36], [10, 41], [10, 70], [10, 75], [10, 76], [11, 47], [11, 48], [11, 53], [11, 58], [11, 63], [11, 64],
  [12, 37], [12, 39], [12, 42], [12, 49], [12, 51], [12, 54], [13, 61], [13, 63], [13, 66], [13, 73], [13, 75], [13, 78],
  [14, 24], [14, 28], [14, 29], [14, 74], [14, 76], [14, 79], [15, 25], [15, 28], [15, 30], [15, 62], [15, 64], [15, 67],
  [16, 26], [16, 29], [16, 31], [16, 50], [16, 52], [16, 55], [17, 27], [17, 30], [17, 31], [17, 38], [17, 40], [17, 43],
  [18, 41], [18, 42], [18, 43], [18, 65], [18, 66], [18, 67], [19, 53], [19, 54], [19, 55], [19, 77], [19, 78], [19, 79],
] as const).map(pair => Object.freeze([pair[0], pair[1]] as const)))

function buildPlainEdges(): readonly (readonly [number, number])[] {
  const bankShared: number[][] = Array.from({ length: 5 }, () => [])
  let nextShared = 0
  for (let a = 0; a < 5; a += 1) {
    for (let b = a + 1; b < 5; b += 1) {
      atRow(bankShared, a).push(nextShared, nextShared + 1)
      atRow(bankShared, b).push(nextShared, nextShared + 1)
      nextShared += 2
    }
  }
  const edges: Array<readonly [number, number]> = []
  for (let k = 0; k < 5; k += 1) {
    const sh = atRow(bankShared, k)
    const rot = Array.from({ length: 8 }, (_, idx) => atNum(sh, (idx + k) % 8))
    const left = rot.slice(0, 4), right = rot.slice(4, 8)
    let j = 0
    for (let l = 0; l < 4; l += 1) {
      for (let r = 0; r < 4; r += 1) {
        if (r === (l + 1) % 4) continue
        const priv = 20 + 12 * k + j
        edges.push(Object.freeze([atNum(left, l), priv] as const), Object.freeze([atNum(right, r), priv] as const))
        j += 1
      }
    }
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  return Object.freeze(edges)
}

const PLAIN_DET: readonly number[] = Object.freeze(Array.from({ length: 80 }, (_, idx) => (idx * 17 + 3) % 11))
const PLAIN_EDGES: readonly (readonly [number, number])[] = buildPlainEdges()

/** Exact in-memory copy of `apps/web/public/cells/menger/wirings.v1.json` (verified against `hive.info.wiringsSha256`). */
export const MENGER_WIRINGS_DOC: MengerWiringsDoc = Object.freeze({
  boundaryWords: 7,
  corners: 20,
  cycleRank: 41,
  field: 65521,
  horizonTicks: 8,
  inletCornerIndex: 0,
  links: 120,
  organPrivateSites: 12,
  organWords: 24,
  organs: 5,
  schema: MENGER_WIRINGS_SCHEMA,
  sites: 80,
  stateWords: 160,
  tableSha256: MENGER_TABLE_SHA256,
  wirings: Object.freeze({
    menger: Object.freeze({
      deg: MENGER_DEG,
      det: MENGER_DET,
      detunedWaveReach: 160,
      edges: MENGER_EDGES,
      globalSites: MENGER_GLOBAL_SITES,
      undetunedOneCornerWaveReach: 20,
    }),
    plain: Object.freeze({
      deg: MENGER_DEG,
      det: PLAIN_DET,
      detunedWaveReach: 160,
      edges: PLAIN_EDGES,
      undetunedOneCornerWaveReach: 80,
    }),
  }),
})

const P = MENGER_FIELD
const mod = (x: number): number => ((x % P) + P) % P
const mul = (a: number, b: number): number => (a * b) % P

function inverse(a: number): number {
  let result = 1, base = mod(a), exp = P - 2
  while (exp > 0) {
    if (exp & 1) result = mul(result, base)
    base = mul(base, base)
    exp >>= 1
  }
  return result
}

const isWord = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < P

/** One tick of the detuned wave oracle mod 65,521 on `menger` or `plain`. */
export function stepMengerWaveOracle(
  wiring: MengerWiringName,
  state: readonly number[],
  input: number,
  detuned = true,
): { readonly corners: number[]; readonly nextState: number[] } {
  const spec = MENGER_WIRINGS_DOC.wirings[wiring]
  const lq = new Int32Array(80)
  for (let i = 0; i < 80; i += 1) {
    const dd = atNum(spec.deg, i) + (detuned ? atNum(spec.det, i) : 0)
    lq[i] = -(dd * atNum(state, i))
  }
  for (const [u, v] of spec.edges) {
    lq[u] = atNum(lq, u) + atNum(state, v)
    lq[v] = atNum(lq, v) + atNum(state, u)
  }
  const nextState = new Array<number>(160)
  for (let i = 0; i < 80; i += 1) {
    const np = mod(atNum(state, 80 + i) + atNum(lq, i) + (i === 0 ? input : 0))
    const nq = mod(atNum(state, i) + np)
    nextState[i] = nq
    nextState[80 + i] = np
  }
  return { corners: nextState.slice(0, 20), nextState }
}

/** Split 160-word `[q(80), p(80)]` into organ `k`'s 24 words and the remaining 136-word `bodyState`. */
export function splitMengerState(
  full: readonly number[],
  organ: number,
): { readonly organState: number[]; readonly bodyState: number[] } {
  const s0 = 20 + 12 * organ
  const organState = [...full.slice(s0, s0 + 12), ...full.slice(80 + s0, 80 + s0 + 12)]
  const bodyQ: number[] = []
  const bodyP: number[] = []
  for (let s = 0; s < 80; s += 1) {
    if (s >= s0 && s < s0 + 12) continue
    bodyQ.push(atNum(full, s))
    bodyP.push(atNum(full, 80 + s))
  }
  return { organState, bodyState: [...bodyQ, ...bodyP] }
}

/** Reassemble organ `k`'s 24 words and the 136-word `bodyState` into the 160-word `[q(80), p(80)]` state. */
export function joinMengerState(
  organState: readonly number[],
  bodyState: readonly number[],
  organ: number,
): number[] {
  const s0 = 20 + 12 * organ
  const full = new Array<number>(160).fill(0)
  for (let j = 0; j < 12; j += 1) {
    full[s0 + j] = atNum(organState, j)
    full[80 + s0 + j] = atNum(organState, 12 + j)
  }
  let idx = 0
  for (let s = 0; s < 80; s += 1) {
    if (s >= s0 && s < s0 + 12) continue
    full[s] = atNum(bodyState, idx)
    full[80 + s] = atNum(bodyState, 68 + idx)
    idx += 1
  }
  return full
}

interface RrefResult {
  readonly R: Int32Array
  readonly cols: number
  readonly pivots: readonly number[]
}

function rrefFlat(rows: number, cols: number, src: Int32Array): RrefResult {
  const A = new Int32Array(src)
  const pivots: number[] = []
  let r = 0
  for (let c = 0; c < cols && r < rows; c += 1) {
    let p = -1
    for (let i = r; i < rows; i += 1) {
      if (atNum(A, i * cols + c) !== 0) { p = i; break }
    }
    if (p < 0) continue
    if (p !== r) {
      for (let j = c; j < cols; j += 1) {
        const tmp = atNum(A, r * cols + j)
        A[r * cols + j] = atNum(A, p * cols + j)
        A[p * cols + j] = tmp
      }
    }
    const inv = inverse(atNum(A, r * cols + c))
    const rOff = r * cols
    for (let j = c; j < cols; j += 1) A[rOff + j] = mul(atNum(A, rOff + j), inv)
    for (let i = 0; i < rows; i += 1) {
      if (i === r) continue
      const iOff = i * cols
      const f = atNum(A, iOff + c)
      if (f === 0) continue
      for (let j = c; j < cols; j += 1) {
        A[iOff + j] = mod(atNum(A, iOff + j) - mul(f, atNum(A, rOff + j)))
      }
    }
    pivots.push(c)
    r += 1
  }
  return { R: A.subarray(0, r * cols), cols, pivots }
}

function nullspaceCols(rows: number, cols: number, src: Int32Array): { readonly basisCols: number[][]; readonly rank: number } {
  const { R, pivots } = rrefFlat(rows, cols, src)
  const pivSet = new Set(pivots)
  const basisCols: number[][] = []
  for (let free = 0; free < cols; free += 1) {
    if (pivSet.has(free)) continue
    const col = new Array<number>(cols).fill(0)
    col[free] = 1
    for (let i = 0; i < pivots.length; i += 1) {
      col[atNum(pivots, i)] = mod(-atNum(R, i * cols + free))
    }
    basisCols.push(col)
  }
  return { basisCols, rank: pivots.length }
}

function solveLinearSystem(rows: number, cols: number, A: Int32Array, y: readonly number[]): number[] | null {
  const augCols = cols + 1
  const aug = new Int32Array(rows * augCols)
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) aug[i * augCols + j] = atNum(A, i * cols + j)
    aug[i * augCols + cols] = mod(atNum(y, i))
  }
  const { R, pivots } = rrefFlat(rows, augCols, aug)
  if (pivots.includes(cols)) return null
  const x = new Array<number>(cols).fill(0)
  for (let i = 0; i < pivots.length; i += 1) {
    x[atNum(pivots, i)] = atNum(R, i * augCols + cols)
  }
  return x
}

function krylovVectors(wiring: MengerWiringName, detuned: boolean): number[][] {
  const rows = new Map<number, Int32Array>()
  const vecs: number[][] = []
  let v = new Array<number>(160).fill(0)
  v[0] = 1
  v[80] = 1
  while (true) {
    const x = Int32Array.from(v)
    for (const j of [...rows.keys()].sort((a, b) => a - b)) {
      const f = atNum(x, j)
      if (f !== 0) {
        const r = rows.get(j)
        if (r) {
          for (let c = j; c < 160; c += 1) x[c] = mod(atNum(x, c) - mul(f, atNum(r, c)))
        }
      }
    }
    let piv = -1
    for (let c = 0; c < 160; c += 1) if (atNum(x, c) !== 0) { piv = c; break }
    if (piv < 0) break
    const inv = inverse(atNum(x, piv))
    for (let c = piv; c < 160; c += 1) x[c] = mul(atNum(x, c), inv)
    rows.set(piv, x)
    vecs.push(v)
    v = stepMengerWaveOracle(wiring, v, 0, detuned).nextState
  }
  return vecs
}

export interface MengerWiringAnalysis {
  readonly wiring: MengerWiringName
  readonly horizonTicks: number
  readonly blindDimsAt4: number
  readonly blindDimsAt8: number
  readonly observedRankAt4: number
  readonly observedRankAt8: number
  readonly detunedWaveReach: number
  readonly undetunedOneCornerWaveReach: number
  readonly privacyClaim: false
}

interface CachedWiringModel {
  readonly summary: MengerWiringAnalysis
  readonly krylovCols: readonly (readonly number[])[]
  readonly krylovMatrix: Int32Array
  readonly obs8Standard: Int32Array
  readonly reachableTwinBasisAt4: readonly (readonly number[])[]
}

const modelCache = new Map<MengerWiringName, CachedWiringModel>()

function getWiringModel(wiring: MengerWiringName): CachedWiringModel {
  const existing = modelCache.get(wiring)
  if (existing) return existing

  const krylovCols = krylovVectors(wiring, true)
  const undetunedCols = krylovVectors(wiring, false)
  if (krylovCols.length !== 160) throw new Error(`${wiring}: expected detuned reach 160, got ${krylovCols.length}`)

  const krylovMatrix = new Int32Array(160 * 160)
  for (let col = 0; col < 160; col += 1) {
    const v = atRow(krylovCols, col)
    for (let row = 0; row < 160; row += 1) krylovMatrix[row * 160 + col] = atNum(v, row)
  }

  const obs4Krylov = new Int32Array(80 * 160)
  const obs8Krylov = new Int32Array(160 * 160)
  for (let col = 0; col < 160; col += 1) {
    let cur = atRow(krylovCols, col)
    for (let t = 0; t < 8; t += 1) {
      for (let c = 0; c < 20; c += 1) {
        if (t < 4) obs4Krylov[(t * 20 + c) * 160 + col] = atNum(cur, c)
        obs8Krylov[(t * 20 + c) * 160 + col] = atNum(cur, c)
      }
      cur = stepMengerWaveOracle(wiring, cur, 0, true).nextState
    }
  }

  const { basisCols: null4Krylov, rank: rank4 } = nullspaceCols(80, 160, obs4Krylov)
  const { basisCols: null8Krylov, rank: rank8 } = nullspaceCols(160, 160, obs8Krylov)

  // K_4 = Rb * null4Krylov (matching blanket.py line 315: K = Rb @ N % P)
  const reachableTwinBasisAt4 = null4Krylov.map((ncol) => {
    const out = new Array<number>(160).fill(0)
    for (let col = 0; col < 160; col += 1) {
      const weight = atNum(ncol, col)
      if (weight === 0) continue
      const kv = atRow(krylovCols, col)
      for (let row = 0; row < 160; row += 1) out[row] = mod(atNum(out, row) + mul(atNum(kv, row), weight))
    }
    return Object.freeze(out)
  })

  // Standard-basis O_8 so `mengerObserve` solves directly for x0 without touching `state`:
  const obs8Standard = new Int32Array(160 * 160)
  for (let col = 0; col < 160; col += 1) {
    let cur = new Array<number>(160).fill(0)
    cur[col] = 1
    for (let t = 0; t < 8; t += 1) {
      for (let c = 0; c < 20; c += 1) obs8Standard[(t * 20 + c) * 160 + col] = atNum(cur, c)
      cur = stepMengerWaveOracle(wiring, cur, 0, true).nextState
    }
  }

  const summary: MengerWiringAnalysis = Object.freeze({
    wiring,
    horizonTicks: 8,
    blindDimsAt4: null4Krylov.length,
    blindDimsAt8: null8Krylov.length,
    observedRankAt4: rank4,
    observedRankAt8: rank8,
    detunedWaveReach: krylovCols.length,
    undetunedOneCornerWaveReach: undetunedCols.length,
    privacyClaim: false,
  })

  const model: CachedWiringModel = Object.freeze({
    summary,
    krylovCols,
    krylovMatrix,
    obs8Standard,
    reachableTwinBasisAt4: Object.freeze(reachableTwinBasisAt4),
  })
  modelCache.set(wiring, model)
  return model
}

/** Exact structural & observability summary for `"menger"` or `"plain"` over F_65521 (`privacyClaim: false`). */
export function analyzeMengerWiring(wiring: MengerWiringName): MengerWiringAnalysis {
  return getWiringModel(wiring).summary
}

export interface MengerObserveInput {
  readonly wiring: MengerWiringName
  /**
   * Optional start state `x_0` (`160` words): when supplied, verified against `cornerReadings` and used to report
   * `values.state` on `UNOBSERVABLE` horizons (`T < 8`). When omitted (`undefined`), `KNOWN` (at `T >= 8`) and
   * `UNOBSERVABLE` twins are solved purely from `cornerReadings` and `inputs` alone.
   */
  readonly state?: readonly number[]
  /** Inputs `[u_0, ..., u_{T-1}]` (`T` scalars in `0..65520`). */
  readonly inputs: readonly number[]
  /** Observed 20-corner readings `[x_0[0..19], x_1[0..19], ..., x_{T-1}[0..19]]` (`T` arrays of `20` words). */
  readonly cornerReadings: readonly (readonly number[])[]
  /** Optional monotonic sequence numbers `[seq_0, ..., seq_{T-1}]` (`KNOWLEDGE-CALCULUS.md` rewind check on caller-supplied seqs). */
  readonly seqs?: readonly number[]
  /** Coordinate `0..159` queried on `x_0` (default `20` = organ 0's first private site `q`, global site `11` on Menger). */
  readonly targetCoord?: number
}

export type MengerObservation =
  | {
    readonly status: 'KNOWN'
    readonly seq: number
    readonly value: number
    readonly rank: number
    readonly blindDims: number
    readonly privacyClaim: false
  }
  | {
    readonly status: 'UNOBSERVABLE'
    readonly seq: number
    readonly rank: number
    readonly blindDims: number
    readonly twin: readonly number[]
    readonly values: { readonly state: number; readonly twin: number }
    readonly replayInputsFromZero: readonly number[]
    readonly privacyClaim: false
  }
  | {
    readonly status: 'INCONSISTENT'
    readonly reason: string
    readonly seq: number | null
    readonly privacyClaim: false
  }

/** Solve for the 160 scalar inputs `u[0..159]` from the zero state that drive the body to `targetState`. */
export function solveReplayInputsFromZero(wiring: MengerWiringName, targetState: readonly number[]): number[] {
  const model = getWiringModel(wiring)
  const coef = solveLinearSystem(160, 160, model.krylovMatrix, targetState)
  if (!coef) throw new Error('state unreachable')
  return Array.from({ length: 160 }, (_, t) => atNum(coef, 159 - t))
}

/**
 * Decide whether coordinate `targetCoord` (default `20`, organ 0's first private site `q`) of `x_0` is determined
 * by `T` ticks of the 20 shared corner readings and declared inputs:
 * - At `T >= 8`: `KNOWN` (solved purely from `cornerReadings` and `inputs`, with `state` optional).
 * - At `T = 4`: `UNOBSERVABLE`, returning `blanket.py`'s exact reachable twin (`twin`) and its 160 replay inputs from zero.
 * - Any non-monotonic `seqs` entry (`seq <= prevSeq` or `seq !== prevSeq + 1`) is rejected (`reason: 'rewind'`).
 */
export function mengerObserve(input: MengerObserveInput): MengerObservation {
  const { wiring, state, inputs, cornerReadings, seqs } = input
  const targetCoord = input.targetCoord ?? 20
  const rawWiring: string = wiring
  if (rawWiring !== 'menger' && rawWiring !== 'plain') {
    return { status: 'INCONSISTENT', reason: 'wiring', seq: null, privacyClaim: false }
  }
  if (!Number.isSafeInteger(targetCoord) || targetCoord < 0 || targetCoord >= 160) {
    return { status: 'INCONSISTENT', reason: 'targetCoord', seq: null, privacyClaim: false }
  }
  if ((state !== undefined && (state.length !== 160 || !state.every(isWord))) || !inputs.every(isWord)) {
    return { status: 'INCONSISTENT', reason: 'range', seq: null, privacyClaim: false }
  }
  const T = inputs.length
  if (T === 0 || cornerReadings.length !== T || cornerReadings.some(r => r.length !== 20 || !r.every(isWord))) {
    return { status: 'INCONSISTENT', reason: 'lengths', seq: null, privacyClaim: false }
  }

  let lastSeq = T - 1
  if (seqs !== undefined) {
    if (seqs.length !== T) return { status: 'INCONSISTENT', reason: 'lengths', seq: null, privacyClaim: false }
    for (let t = 0; t < T; t += 1) {
      const s = seqs[t]
      if (typeof s !== 'number' || !Number.isSafeInteger(s) || s < 0) {
        return { status: 'INCONSISTENT', reason: 'rewind', seq: typeof s === 'number' ? s : null, privacyClaim: false }
      }
      if (t > 0 && s !== atNum(seqs, t - 1) + 1) {
        return { status: 'INCONSISTENT', reason: 'rewind', seq: s, privacyClaim: false }
      }
      lastSeq = s
    }
  }

  // Compute zero-start forced readings (and when `state` is provided, verify `cornerReadings` against `state`):
  let sim = state !== undefined ? [...state] : null
  let zeroSim = new Array<number>(160).fill(0)
  const y0: number[] = []
  for (let t = 0; t < T; t += 1) {
    const obsRow = atRow(cornerReadings, t)
    for (let c = 0; c < 20; c += 1) {
      if (sim !== null && atNum(sim, c) !== atNum(obsRow, c)) {
        return { status: 'INCONSISTENT', reason: 'readings', seq: seqs ? atNum(seqs, t) : t, privacyClaim: false }
      }
      y0.push(mod(atNum(obsRow, c) - atNum(zeroSim, c)))
    }
    if (sim !== null) sim = stepMengerWaveOracle(wiring, sim, atNum(inputs, t), true).nextState
    zeroSim = stepMengerWaveOracle(wiring, zeroSim, atNum(inputs, t), true).nextState
  }

  const model = getWiringModel(wiring)
  const rows = 20 * T
  const obsT = T === 8 ? model.obs8Standard : (() => {
    const mat = new Int32Array(rows * 160)
    for (let col = 0; col < 160; col += 1) {
      let cur = new Array<number>(160).fill(0)
      cur[col] = 1
      for (let t = 0; t < T; t += 1) {
        for (let c = 0; c < 20; c += 1) mat[(t * 20 + c) * 160 + col] = atNum(cur, c)
        cur = stepMengerWaveOracle(wiring, cur, 0, true).nextState
      }
    }
    return mat
  })()

  const matchesObservations = (candidate: readonly number[]): boolean => {
    for (let r = 0; r < rows; r += 1) {
      let acc = 0
      for (let c = 0; c < 160; c += 1) acc = mod(acc + mul(atNum(obsT, r * 160 + c), atNum(candidate, c)))
      if (acc !== atNum(y0, r)) return false
    }
    return true
  }

  if (T === 4) {
    const kv = model.reachableTwinBasisAt4.find(col => atNum(col, targetCoord) !== 0)
    if (kv) {
      const baseState = state ?? solveLinearSystem(rows, 160, obsT, y0)
      if (!baseState || !matchesObservations(baseState)) {
        return { status: 'INCONSISTENT', reason: 'observations', seq: lastSeq, privacyClaim: false }
      }
      const twin = baseState.map((val, idx) => mod(val + atNum(kv, idx)))
      const replayInputsFromZero = solveReplayInputsFromZero(wiring, twin)
      return {
        status: 'UNOBSERVABLE',
        seq: lastSeq,
        rank: model.summary.observedRankAt4,
        blindDims: model.summary.blindDimsAt4,
        twin,
        values: { state: atNum(baseState, targetCoord), twin: atNum(twin, targetCoord) },
        replayInputsFromZero,
        privacyClaim: false,
      }
    }
  }

  const { basisCols, rank } = nullspaceCols(rows, 160, obsT)
  const blindCol = basisCols.find(col => atNum(col, targetCoord) !== 0)
  if (!blindCol) {
    const xhat = solveLinearSystem(rows, 160, obsT, y0)
    if (!xhat || !matchesObservations(xhat)) {
      return { status: 'INCONSISTENT', reason: 'observations', seq: lastSeq, privacyClaim: false }
    }
    return {
      status: 'KNOWN',
      seq: lastSeq,
      value: atNum(xhat, targetCoord),
      rank,
      blindDims: basisCols.length,
      privacyClaim: false,
    }
  }

  const baseState = state ?? solveLinearSystem(rows, 160, obsT, y0)
  if (!baseState || !matchesObservations(baseState)) {
    return { status: 'INCONSISTENT', reason: 'observations', seq: lastSeq, privacyClaim: false }
  }
  const twin = baseState.map((val, idx) => mod(val + atNum(blindCol, idx)))
  const replayInputsFromZero = solveReplayInputsFromZero(wiring, twin)
  return {
    status: 'UNOBSERVABLE',
    seq: lastSeq,
    rank,
    blindDims: basisCols.length,
    twin,
    values: { state: atNum(baseState, targetCoord), twin: atNum(twin, targetCoord) },
    replayInputsFromZero,
    privacyClaim: false,
  }
}
