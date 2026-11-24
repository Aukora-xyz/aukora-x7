/**
 * Aura focus cell, in SHADOW. The pinned Wasm cell `aura-focus` (apps/web/public/cells/aura-focus.wat, built by the
 * pinned skillsmith cell) computes the same focus as computeAuraFocusShadow, beside it, and this module records
 * whether the two agree. It has NO authority: nothing reads its answer to route, wake, grant or choose. The
 * JavaScript result stays the only one that is used; a disagreement is reported here, never resolved.
 *
 * Three parts, each pure and synchronous, no I/O, no clock:
 *  - the adapter (auraFocusCellInput): the reference's signal object to the cell's integer input, exactly per the
 *    lab's PROFILE.md: the last five scores, every binary64 as two unsigned 32-bit halves (high first), and the
 *    10,000-score cap plus the checks on older scores that the cell cannot see. Out of profile is a refusal.
 *  - the runner (runAuraFocusCell): one call on a fresh instance of an already admitted module, the way her
 *    execution worker calls a cell (fuel grant, mv_alloc, mv_run, response descriptor, envelope).
 *  - the comparison (auraFocusCellShadow): agree, disagree or refused. A refusal is never turned into a value.
 * Admission (size, SHA-256 pin, compile, zero imports, exact exports) happens before this module sees a cell; see
 * deploy/cloudflare/src/aura-focus-cell.mjs. A Worker cannot compile Wasm from bytes at runtime, so this runs where that is allowed.
 */

const SCHEMA = 'aukora.aura-focus-cell-shadow.v1'
/** CELL_PINS['aura-focus'] in packages/experimental/webworker-runtime/src/x6/wasm-cells.ts (a test holds them equal). */
export const AURA_FOCUS_CELL_PIN = Object.freeze({
  name: 'aura-focus',
  sha256: 'e3e617dcb04bb449908b019af607427383ef173356a000341c3fe3db4b9491a8',
  bytes: 12545,
  fuel: 1_000_000,
  /** The cell declares `(memory 1 1)`: one 64 KiB page, never grown. */
  memoryBytes: 65_536,
  op: 'aura.focus',
})
export const AURA_FOCUS_CELL_EXPORTS = Object.freeze(['__mv_fuel_remaining', '__mv_fuel_set', 'memory', 'mv_abi_version', 'mv_alloc', 'mv_run'])
/** The reference validates this many scores and scores the last five (AURA_INPUT_LIMITS in server/aura-rules.mjs). */
export const AURA_FOCUS_CELL_SCORE_CAP = 10_000
const RECENT = 5
const COUNT_FIELDS = ['reachableDagNodes', 'declaredDagNodes', 'verifiedReceipts', 'totalReceipts',
  'activeOrgans', 'declaredOrgans', 'unanchoredPredictions', 'pendingWakes', 'lastRollbackAgeEpochs']
const STATUS = Object.freeze({ 1: 'complete', 2: 'uncertain' })
const FOCUS = Object.freeze([null, 'rest', 'consolidate', 'observe', 'verify', 'escalate-to-owner'])
const REASON = Object.freeze(['drift-escalation', 'heartbeat-escalation', 'surprise-escalation', 'escalation-boundary',
  'unanchored-predictions', 'handoff-mismatch', 'surprise-observation', 'observation-boundary',
  'coherence-boundary', 'coherence-deficit', 'below-focus-thresholds'])
const SIDE = Object.freeze(['below', 'boundary', 'above'])
const CHECKS = ['driftTenths', 'heartbeat', 'surpriseEscalation', 'surpriseObservation', 'coherence']

const encoder = new TextEncoder()

function frozen(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}

function compareUtf8(left, right) {
  const a = encoder.encode(left), b = encoder.encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index]
  return a.length - b.length
}

function encodeString(value) {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0)
    if (code >= 0xd800 && code <= 0xdfff) throw new Error('canonical JSON rejects unpaired surrogates')
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (code <= 0x1f) out += `\\u00${code.toString(16).padStart(2, '0')}`
    else out += char
  }
  return `${out}"`
}

/** Microverse ABI v1 canonical JSON, the same rules as cellCanonicalJson in wasm-cells.ts. */
export function cellCanonicalJson(value) {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical JSON accepts integers only')
    return String(value)
  }
  if (typeof value === 'string') return encodeString(value)
  if (Array.isArray(value)) return `[${value.map(cellCanonicalJson).join(',')}]`
  if (typeof value !== 'object') throw new Error('canonical JSON accepts JSON values only')
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort(compareUtf8)
    .map(key => `${encodeString(key)}:${cellCanonicalJson(value[key])}`).join(',')}}`
}

/** The request bytes her host sends a cell: canonical `{"abi":1,"input":..,"op":..,"seq":..}`. */
export function cellRequestBytes(op, input, seq) {
  return encoder.encode(cellCanonicalJson({ abi: 1, input, op, seq }))
}

function isRecord(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownValue(value, key) {
  const property = Object.getOwnPropertyDescriptor(value, key)
  return property && Object.hasOwn(property, 'value') ? property.value : undefined
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function isNonnegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && !Object.is(value, -0)
}

/** A binary64 as [high 32 bits, low 32 bits], unsigned; the bit pattern, never a rounded value. */
export function binary64Halves(value) {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value, false)
  return [view.getUint32(0, false), view.getUint32(4, false)]
}

const adapterRefusal = code => ({ refusal: { source: 'adapter', code } })

/**
 * The adapter. Owns only what the cell cannot see or cannot be sent: object shape and metadata, integers that canonical
 * JSON cannot carry, the 10,000-score cap and the scores older than the last five. Everything the cell can judge
 * (zero totals, a numerator above its total, a negative, -0, NaN or infinite heartbeat or recent score) goes to the
 * cell unjudged, so the cell's own refusal is what is reported.
 * @param {unknown} inputs The same object computeAuraFocusShadow receives.
 * @returns {{ input: object } | { refusal: { source: 'adapter', code: string } }}
 */
export function auraFocusCellInput(inputs) {
  try {
    if (!isRecord(inputs)) return adapterRefusal('ADAPTER_INPUTS_INCOMPLETE')
    const ballId = ownValue(inputs, 'ballId')
    if (typeof ballId !== 'string' || !/^[a-fA-F0-9]{64}$/.test(ballId)
      || !isCount(ownValue(inputs, 'epoch')) || !isCount(ownValue(inputs, 'computedAt'))) return adapterRefusal('ADAPTER_METADATA_INVALID')
    const counts = COUNT_FIELDS.map(field => ownValue(inputs, field))
    if (!counts.every(isCount)) return adapterRefusal('ADAPTER_INPUTS_INCOMPLETE')
    const mismatch = ownValue(inputs, 'handOffEpochMismatch')
    const heartbeat = ownValue(inputs, 'staleHeartbeatRatio')
    if (typeof mismatch !== 'boolean' || typeof heartbeat !== 'number') return adapterRefusal('ADAPTER_INPUTS_INCOMPLETE')
    const scores = ownValue(inputs, 'observedSurpriseScores')
    if (!Array.isArray(scores)) return adapterRefusal('ADAPTER_INPUTS_INCOMPLETE')
    const length = ownValue(scores, 'length')
    if (!isCount(length)) return adapterRefusal('ADAPTER_INPUTS_INCOMPLETE')
    if (length > AURA_FOCUS_CELL_SCORE_CAP) return adapterRefusal('ADAPTER_SCORES_OVER_CAP')
    const recent = []
    for (let index = 0; index < length; index += 1) {
      const score = ownValue(scores, String(index))
      if (typeof score !== 'number') return adapterRefusal('ADAPTER_INPUTS_INCOMPLETE')
      if (index < length - RECENT) {
        if (!isNonnegativeFinite(score)) return adapterRefusal('ADAPTER_OLDER_SCORE_INVALID')
      } else recent.push(binary64Halves(score))
    }
    return { input: { counts, heartbeat: binary64Halves(heartbeat), mismatch: mismatch ? 1 : 0, scores: recent } }
  } catch {
    // Accessors, proxies and other unreadable objects are refused, never read as a zero.
    return adapterRefusal('ADAPTER_INPUTS_UNREADABLE')
  }
}

const hostRefusal = (code, fuelUsed = null) => ({ refusal: { source: 'host', code }, fuelUsed })

/**
 * Call an admitted cell once on a fresh instance, as cellWorkerMain does: fuel grant, abi check, mv_alloc,
 * mv_run, memory ceiling, fuel accounting, response descriptor, strict envelope (abi 1, same seq).
 * @param {{ module: WebAssembly.Module, sha256: string }} cell An admission handle (deploy/cloudflare/src/aura-focus-cell.mjs).
 * @param {object} input The adapter's input.
 * @param {number} [seq] Request sequence number.
 * @returns {{ result: object, fuelUsed: number } | { refusal: { source: 'cell' | 'host', code: string }, fuelUsed: number | null }}
 */
export function runAuraFocusCell(cell, input, seq = 1) {
  if (!isRecord(cell) || cell.sha256 !== AURA_FOCUS_CELL_PIN.sha256 || !(cell.module instanceof WebAssembly.Module)) {
    return hostRefusal(typeof cell?.error === 'string' ? cell.error : 'CELL_NOT_ADMITTED')
  }
  let request
  try { request = cellRequestBytes(AURA_FOCUS_CELL_PIN.op, input, seq) } catch { return hostRefusal('UNREPRESENTABLE') }
  const fuel = BigInt(AURA_FOCUS_CELL_PIN.fuel)
  let exports
  try {
    exports = new WebAssembly.Instance(cell.module, {}).exports
    if (exports.memory.buffer.byteLength > AURA_FOCUS_CELL_PIN.memoryBytes) return hostRefusal('MEMORY_CEILING')
    exports.__mv_fuel_set(fuel)
    if (exports.mv_abi_version() !== 1) return hostRefusal('ABI_VERSION')
    exports.__mv_fuel_set(fuel)
    const pointer = exports.mv_alloc(request.byteLength)
    if (pointer < 64 || pointer + request.byteLength > exports.memory.buffer.byteLength) return hostRefusal('ALLOC')
    new Uint8Array(exports.memory.buffer, pointer, request.byteLength).set(request)
    exports.__mv_fuel_set(fuel)
    const packed = exports.mv_run(pointer, request.byteLength)
    if (exports.memory.buffer.byteLength > AURA_FOCUS_CELL_PIN.memoryBytes) return hostRefusal('MEMORY_CEILING')
    const remaining = exports.__mv_fuel_remaining()
    if (remaining < 0n || remaining > fuel) return hostRefusal('FUEL_INVALID')
    const fuelUsed = Number(fuel - remaining)
    const length = Number(packed >> 32n), offset = Number(packed & 0xffff_ffffn)
    if (length <= 0 || offset < 64 || offset + length > exports.memory.buffer.byteLength) return hostRefusal('RESPONSE_DESCRIPTOR', fuelUsed)
    let answer
    try {
      answer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(exports.memory.buffer, offset, length)))
    } catch { return hostRefusal('MALFORMED_RESPONSE', fuelUsed) }
    if (!isRecord(answer) || answer.abi !== 1) return hostRefusal('MALFORMED_RESPONSE', fuelUsed)
    if (answer.status === 'refused') {
      return { refusal: { source: 'cell', code: typeof answer.code === 'string' ? answer.code : 'REFUSED' }, fuelUsed }
    }
    if (answer.status !== 'ok' || answer.seq !== seq || !isRecord(answer.result)) return hostRefusal('MALFORMED_RESPONSE', fuelUsed)
    return { result: answer.result, fuelUsed }
  } catch (error) {
    let remaining
    try { remaining = exports?.__mv_fuel_remaining() } catch { /* the instance is discarded */ }
    const fuelUsed = typeof remaining === 'bigint' && remaining >= 0n && remaining <= fuel ? Number(fuel - remaining) : null
    return hostRefusal(error instanceof WebAssembly.RuntimeError && typeof remaining === 'bigint' && remaining < 16n ? 'FUEL' : 'TRAP', fuelUsed)
  }
}

/** The cell's integer answer in the reference's words, or null when it is not one the profile defines. */
export function readAuraFocusCellResult(result) {
  if (!isRecord(result)) return null
  const status = STATUS[result.status], focus = result.focus, reason = result.reason, checks = result.checks
  if (status === undefined || !Number.isInteger(focus) || focus < 0 || focus >= FOCUS.length
    || !Number.isInteger(reason) || reason < 0 || reason >= REASON.length
    || !Array.isArray(checks) || checks.length !== 5 || !Number.isInteger(checks[0]) || checks[0] < 0 || checks[0] > 10
    || !checks.slice(1).every(code => Number.isInteger(code) && code >= 0 && code < SIDE.length)) return null
  return { status, focus: FOCUS[focus], reason: REASON[reason],
    checks: { driftTenths: checks[0], heartbeat: SIDE[checks[1]], surpriseEscalation: SIDE[checks[2]],
      surpriseObservation: SIDE[checks[3]], coherence: SIDE[checks[4]] } }
}

function referenceView(reference) {
  if (!isRecord(reference) || !['complete', 'uncertain', 'incomplete'].includes(reference.status)) return null
  if (reference.status === 'incomplete') return { status: 'incomplete', focus: null, reason: reference.reason ?? null, checks: null }
  const checks = isRecord(reference.checks) ? Object.fromEntries(CHECKS.map(key => [key, reference.checks[key]])) : null
  return { status: reference.status, focus: reference.focus, reason: reference.reason, checks }
}

function differences(reference, cell) {
  const fields = []
  for (const key of ['status', 'focus', 'reason']) if (reference[key] !== cell[key]) fields.push(key)
  for (const key of CHECKS) if (reference.checks?.[key] !== cell.checks?.[key]) fields.push(`checks.${key}`)
  return fields
}

/**
 * Run the cell beside the JavaScript result and say how they compare. Diagnostic only: the returned record carries
 * no focus to act on and nothing reads it to decide anything.
 * @param {unknown} inputs The object given to computeAuraFocusShadow.
 * @param {object} reference The record computeAuraFocusShadow returned for those inputs (the only result used).
 * @param {{ module: WebAssembly.Module, sha256: string } | { error: string }} cell An admission handle or its failure.
 * @returns {object} Frozen record: outcome 'agree' | 'disagree' | 'refused'.
 */
export function auraFocusCellShadow(inputs, reference, cell) {
  const ref = referenceView(reference)
  const base = { schema: SCHEMA, role: 'diagnostic-only', authorityTier: 'none', cell: AURA_FOCUS_CELL_PIN.name,
    sha256: AURA_FOCUS_CELL_PIN.sha256, op: AURA_FOCUS_CELL_PIN.op, reference: ref }
  const refused = (refusal, fuelUsed = null) => frozen({ ...base, outcome: 'refused', refusal,
    // A refusal is expected exactly when the JavaScript result is incomplete; any other refusal is shown as such.
    refusalExpected: ref?.status === 'incomplete', answer: null, differences: null, fuelUsed })
  if (ref === null) return refused({ source: 'host', code: 'REFERENCE_UNREADABLE' })
  const adapted = auraFocusCellInput(inputs)
  if (adapted.refusal) return refused(adapted.refusal)
  const run = runAuraFocusCell(cell, adapted.input)
  if (run.refusal) return refused(run.refusal, run.fuelUsed)
  const answer = readAuraFocusCellResult(run.result)
  if (answer === null) return refused({ source: 'host', code: 'CELL_RESULT_INVALID' }, run.fuelUsed)
  const changed = ref.status === 'incomplete' ? ['status'] : differences(ref, answer)
  return frozen({ ...base, outcome: changed.length === 0 ? 'agree' : 'disagree', refusal: null, refusalExpected: false,
    answer, differences: changed, fuelUsed: run.fuelUsed })
}
