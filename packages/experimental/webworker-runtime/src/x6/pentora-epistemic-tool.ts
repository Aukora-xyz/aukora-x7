/** Read-only browser adapter for the bounded Pentora partial-view instrument. */
import { MAX_READINGS, createPentoraEpistemicEngine, type AnalysisRequest } from './pentora-epistemic.ts'
import {
  PENTORA_ACTIVE_ROWS, PENTORA_GEOMETRY_SHA256, PENTORA_MATRIX_SHA256, PENTORA_MEAN_A, PENTORA_MEAN_B,
  PENTORA_PROFILE_ID, PENTORA_SCALE,
} from './pentora-epistemic-table.ts'

const PRIME = 2_147_483_647
const SLOT_COUNT = 72
const byNode = new Map<number, number[]>()
for (const [node, component] of PENTORA_ACTIVE_ROWS) {
  const previous = byNode.get(node) ?? []
  previous.push(component)
  byNode.set(node, previous)
}

let instrument: ReturnType<typeof createPentoraEpistemicEngine> | undefined

function observer() {
  if (instrument) return instrument
  const rowsByNode = new Map<number, Array<{ component: number; coefficients: number[] }>>()
  for (const [node, component, packed] of PENTORA_ACTIVE_ROWS) {
    const raw = atob(packed)
    const coefficients = new Array<number>(SLOT_COUNT).fill(0)
    for (let i = 0; i < raw.length; i += 3) {
      const value = raw.charCodeAt(i + 1) | (raw.charCodeAt(i + 2) << 8)
      coefficients[raw.charCodeAt(i)] = (value << 16) >> 16
    }
    const rows = rowsByNode.get(node) ?? []
    rows.push({ component, coefficients })
    rowsByNode.set(node, rows)
  }
  instrument = createPentoraEpistemicEngine({
    profileId: PENTORA_PROFILE_ID,
    matrixSha256: PENTORA_MATRIX_SHA256,
    nodes: [...rowsByNode].map(([node, rows]) => ({ node, rows })),
    meanClaims: { a: PENTORA_MEAN_A, b: PENTORA_MEAN_B },
  })
  return instrument
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function pentoraEpistemicTool(input: unknown): unknown {
  if (!isRecord(input)) return { ok: false, code: 'PENTORA_OBSERVER_INPUT' }
  if (input.mode === 'info') {
    if (Object.keys(input).some(key => key !== 'mode' && key !== 'node')
      || (input.node !== undefined && (typeof input.node !== 'number' || !Number.isInteger(input.node) || !byNode.has(input.node)))) {
      return { ok: false, code: 'PENTORA_OBSERVER_INPUT' }
    }
    return { ok: true, profile: PENTORA_PROFILE_ID, matrixSha256: PENTORA_MATRIX_SHA256, geometrySha256: PENTORA_GEOMETRY_SHA256,
      field: PRIME, scale: PENTORA_SCALE, slots: SLOT_COUNT, nodes: 110, activeRows: PENTORA_ACTIVE_ROWS.length, maxReadings: MAX_READINGS,
      ...(typeof input.node === 'number' ? { node: input.node, activeComponents: [...(byNode.get(input.node) ?? [])] } : {}),
      interpretation: 'algebraic evidence only; no authenticity, freshness, privacy, or authority' }
  }
  if (Object.keys(input).some(key => !['profile', 'matrixSha256', 'snapshot', 'readings', 'claim', 'suggestNext'].includes(key))
    || !Array.isArray(input.readings) || !isRecord(input.claim)
    || (input.suggestNext !== undefined && typeof input.suggestNext !== 'boolean')
    || typeof input.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(input.snapshot)) return { ok: false, code: 'PENTORA_OBSERVER_INPUT' }
  if (input.profile !== PENTORA_PROFILE_ID || input.matrixSha256 !== PENTORA_MATRIX_SHA256) return { ok: false, code: 'PENTORA_OBSERVER_PROFILE' }
  const claim: AnalysisRequest['claim'] | undefined = input.claim.kind === 'coefficient' && typeof input.claim.slot === 'number'
    && Object.keys(input.claim).length === 2 ? { kind: 'coefficient', slot: input.claim.slot }
    : input.claim.kind === 'spherical-mean' && Object.keys(input.claim).length === 1 ? { kind: 'spherical-mean' } : undefined
  if (!claim) return { ok: false, code: 'PENTORA_OBSERVER_INPUT' }
  // Snapshot is a caller label, not a proof the readings are authentic or fresh.
  const result = observer().analyze({ readings: input.readings, claim, suggestNext: input.suggestNext === true })
  return { ok: result.status !== 'ERROR', ...result, snapshot: input.snapshot }
}
