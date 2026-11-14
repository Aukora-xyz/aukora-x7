/** Read-only linear evidence over F_2147483647, NOT authentication or integer reachability. */
export const FIELD = 2147483647n
export const SLOTS = 72
export const MAX_READINGS = 96
export type Scalar = number | string
export interface PinnedMatrix {
  profileId: string
  matrixSha256: string
  nodes: readonly { node: number; rows: readonly { component: number; coefficients: readonly Scalar[] }[] }[]
  /** Coefficient rows of the normalized spherical mean, already scaled into this field. */
  meanClaims: { a: readonly Scalar[]; b: readonly Scalar[] }
}
export interface Reading { node: number; component: number; value: number }
export interface AnalysisRequest {
  readings: readonly Reading[]
  claim: { kind: 'coefficient'; slot: number } | { kind: 'spherical-mean' }
  suggestNext?: boolean
}
type Vector = bigint[]
type BasisRow = { pivot: number; row: Vector; value: bigint; proof: Vector }
const at = <T>(values: readonly T[], i: number): T => {
  const value = values[i]
  if (value === undefined) throw new RangeError('PENTORA_INTERNAL_INDEX')
  return value
}
const mod = (v: bigint) => { const r = v % FIELD; return r < 0n ? r + FIELD : r }
const numbers = (v: Vector) => v.map(Number)
const scalar = (v: Scalar): bigint => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && !Object.is(v, -0)) return mod(BigInt(v))
  if (typeof v === 'string' && /^-?(?:0|[1-9][0-9]{0,15})$/.test(v) && v !== '-0') {
    const n = BigInt(v)
    if (n >= -9007199254740991n && n <= 9007199254740991n) return mod(n)
  }
  throw new Error('INVALID_SCALAR')
}
const vector = (v: readonly Scalar[]) => {
  if (!Array.isArray(v) || v.length !== SLOTS) throw new Error('INVALID_VECTOR')
  return v.map(scalar)
}
const inverse = (v: bigint) => {
  if (v === 0n) throw new Error('ZERO_PIVOT')
  let a = v, e = FIELD - 2n, out = 1n
  while (e) { if (e & 1n) out = out * a % FIELD; a = a * a % FIELD; e >>= 1n }
  return out
}
class Budget {
  left = 4_000_000
  take(n: number) { this.left -= n; if (this.left < 0) throw new Error('WORK_LIMIT') }
}
function subtract(out: Vector, row: Vector, factor: bigint, budget: Budget) {
  budget.take(out.length)
  for (let i = 0; i < out.length; i++) out[i] = mod(at(out, i) - factor * at(row, i))
}
function reduce(row: Vector, basis: BasisRow[], budget: Budget) {
  for (const b of basis) {
    const f = at(row, b.pivot)
    if (f !== 0n) subtract(row, b.row, f, budget)
  }
  return row
}
function solve(basis: BasisRow[], free: Vector, budget: Budget): Vector {
  const x = free.slice()
  for (let i = basis.length - 1; i >= 0; i--) {
    const b = at(basis, i); let v = b.value
    budget.take(SLOTS)
    for (let j = b.pivot + 1; j < SLOTS; j++) v -= at(b.row, j) * at(x, j)
    x[b.pivot] = mod(v)
  }
  return x
}
function dot(a: Vector, b: Vector, budget: Budget) {
  budget.take(a.length)
  return mod(a.reduce((s, v, i) => s + v * at(b, i), 0n))
}
const index = (v: unknown, max: number) => typeof v === 'number' && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= 0 && v <= max
const keys = (v: object, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k))

export function createPentoraEpistemicEngine(input: PinnedMatrix) {
  if (!input || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.profileId) || !/^[a-f0-9]{64}$/.test(input.matrixSha256)
    || !Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > 110) throw new Error('INVALID_PROFILE')
  // Copy every row: callers cannot mutate the engine's pinned snapshot after creation.
  const nodeIds = new Set<number>(), matrix = new Map<string, Vector>()
  const pinnedNodes: PinnedMatrix['nodes'] = input.nodes
  const nodes = pinnedNodes.map(n => {
    if (!index(n.node, 109) || nodeIds.has(n.node) || !Array.isArray(n.rows) || !n.rows.length || n.rows.length > 8) throw new Error('INVALID_NODE')
    nodeIds.add(n.node)
    const components = new Set<number>()
    const pinnedRows: PinnedMatrix['nodes'][number]['rows'] = n.rows
    const rows = pinnedRows.map(r => {
      if (!index(r.component, 7) || components.has(r.component)) throw new Error('INVALID_COMPONENT')
      components.add(r.component)
      const coefficients = vector(r.coefficients)
      matrix.set(`${n.node}:${r.component}`, coefficients)
      return { component: r.component, coefficients }
    }).sort((a, b) => a.component - b.component)
    return { node: n.node, rows }
  }).sort((a, b) => a.node - b.node)
  const mean = { a: vector(input.meanClaims.a), b: vector(input.meanClaims.b) }
  const profileId = input.profileId, matrixSha256 = input.matrixSha256
  return Object.freeze({
    analyze(request: AnalysisRequest) {
      const meta = { profileId, matrixSha256, field: Number(FIELD), domain: 'abstract-field-coefficient-residues',
        integerReachability: 'NOT_ESTABLISHED', authenticity: 'NOT_ESTABLISHED' } as const
      try {
        if (!request || !keys(request, ['readings', 'claim', 'suggestNext']) || !Array.isArray(request.readings) || request.readings.length > MAX_READINGS
          || (request.suggestNext !== undefined && typeof request.suggestNext !== 'boolean') || !request.claim) throw new Error('INVALID_REQUEST')
        const c = request.claim
        if (!(c.kind === 'coefficient' && keys(c, ['kind', 'slot']) && index(c.slot, 71))
          && !(c.kind === 'spherical-mean' && keys(c, ['kind']))) throw new Error('INVALID_CLAIM')
        const targets = c.kind === 'coefficient'
          ? [{ name: 'coefficient', row: Array.from({ length: SLOTS }, (_, i) => i === c.slot ? 1n : 0n) }]
          : [{ name: 'a', row: mean.a }, { name: 'b', row: mean.b }]
        const budget = new Budget(), seen = new Set<string>(), basis: BasisRow[] = []
        // Validate every reading before solving; duplicates are invalid, never extra evidence.
        const readings = request.readings.map(r => {
          if (!r || !keys(r, ['node', 'component', 'value']) || !index(r.node, 109) || !index(r.component, 7)
            || !index(r.value, Number(FIELD) - 1)) throw new Error('INVALID_READING')
          const key = `${r.node}:${r.component}`, row = matrix.get(key)
          if (!row || seen.has(key)) throw new Error('UNKNOWN_OR_DUPLICATE_READING')
          seen.add(key)
          return { row, value: scalar(r.value) }
        })
        for (let k = 0; k < readings.length; k++) {
          const reading = at(readings, k)
          const row = reading.row.slice(); let value = reading.value
          const proof = Array(readings.length).fill(0n) as Vector; proof[k] = 1n
          for (const b of basis) {
            const f = at(row, b.pivot)
            if (f !== 0n) { subtract(row, b.row, f, budget); subtract(proof, b.proof, f, budget); value = mod(value - f * b.value) }
          }
          const pivot = row.findIndex(v => v !== 0n)
          if (pivot < 0) {
            if (value !== 0n) return { ...meta, status: 'DISAGREE', rankAtContradiction: basis.length, processedReadings: k + 1,
              syndrome: { multipliers: numbers(proof), residual: Number(value) }, attribution: 'NONE' }
            continue
          }
          const inv = inverse(at(row, pivot)); budget.take(row.length + proof.length)
          basis.push({ pivot, row: row.map(v => v * inv % FIELD), value: value * inv % FIELD, proof: proof.map(v => v * inv % FIELD) })
          basis.sort((a, b) => a.pivot - b.pivot)
        }
        const particular = solve(basis, Array(SLOTS).fill(0n), budget)
        const claims = targets.map(target => {
          const residual = target.row.slice(), certificate = Array(readings.length).fill(0n) as Vector
          for (const b of basis) {
            const f = at(residual, b.pivot)
            if (f !== 0n) { subtract(residual, b.row, f, budget); subtract(certificate, b.proof, mod(-f), budget) }
          }
          const free = residual.findIndex(v => v !== 0n)
          if (free < 0) return { name: target.name, status: 'KNOWN' as const, value: Number(dot(target.row, particular, budget)), certificate: numbers(certificate) }
          const seed = Array(SLOTS).fill(0n) as Vector; seed[free] = 1n
          const delta = solve(basis.map(b => ({ ...b, value: 0n })), seed, budget)
          const twin = particular.map((v, i) => mod(v + at(delta, i)))
          return { name: target.name, status: 'UNDETERMINED' as const,
            twin: { first: numbers(particular), second: numbers(twin), delta: numbers(delta),
              firstValue: Number(dot(target.row, particular, budget)), secondValue: Number(dot(target.row, twin, budget)) } }
        })
        const status = claims.every(c => c.status === 'KNOWN') ? 'KNOWN' : 'UNDETERMINED'
        let next: object = { status: 'NOT_REQUESTED' }
        if (request.suggestNext) {
          // Cheap incremental elimination; rank first is not a claim of globally optimal cost.
          let best: { node: number; targetGain: number; rankGain: number; newReadings: number } | null = null
          try {
            const known = claims.filter(c => c.status === 'KNOWN').length
            for (const node of nodes) {
              const extra = node.rows.filter(r => !seen.has(`${node.node}:${r.component}`))
              if (!extra.length || readings.length + extra.length > MAX_READINGS) continue
              const augmented = basis.slice()
              for (const r of extra) {
                const row = reduce(r.coefficients.slice(), augmented, budget), pivot = row.findIndex(v => v !== 0n)
                if (pivot < 0) continue
                const inv = inverse(at(row, pivot)); budget.take(SLOTS)
                augmented.push({ pivot, row: row.map(v => v * inv % FIELD), value: 0n, proof: [] })
                augmented.sort((a, b) => a.pivot - b.pivot)
              }
              const targetGain = targets.filter(t => reduce(t.row.slice(), augmented, budget).every(v => v === 0n)).length - known
              const candidate = { node: node.node, targetGain, rankGain: augmented.length - basis.length, newReadings: extra.length }
              if (candidate.targetGain === 0 && candidate.rankGain === 0) continue
              if (!best || candidate.targetGain > best.targetGain || candidate.targetGain === best.targetGain &&
                (candidate.rankGain > best.rankGain || candidate.rankGain === best.rankGain && candidate.newReadings < best.newReadings)) best = candidate
            }
            next = best ? { status: 'SUGGESTED', ...best, objective: 'targetGain,rankGain,-newReadings,-nodeId' } : { status: 'NO_GAIN' }
          } catch (e) { if (!(e instanceof Error) || e.message !== 'WORK_LIMIT') throw e; next = { status: 'WORK_LIMIT', suggestion: null } }
        }
        return { ...meta, status, rank: basis.length, nullity: SLOTS - basis.length, claims, next }
      } catch (e) {
        return { ...meta, status: 'ERROR', code: e instanceof Error && ['INVALID_REQUEST', 'INVALID_CLAIM', 'INVALID_READING', 'UNKNOWN_OR_DUPLICATE_READING', 'INVALID_SCALAR', 'WORK_LIMIT'].includes(e.message) ? e.message : 'INVALID_INPUT' }
      }
    },
  })
}
