/**
 * The Kyber weight CPU cell (`kyber-cpu`, docs/auma/kyber-cpu.md) on the EDGE, the second host of one run.
 * Her browser runs the same pinned bytes (packages/experimental/webworker-runtime/src/x6/wasm-cells.ts); a run she starts
 * there can be finished here from a checkpoint (`x6_cell handoff`), and the two ends are compared byte for byte.
 *
 * Nothing here is authority. It is a pure computation: the route reads no storage, writes no storage, calls no Durable
 * Object, touches no lease, receipt or HEAD, and takes nothing from a checkpoint but the machine state in it (a
 * checkpoint's `check` is a checksum anyone can compute, never a signature or a permission).
 *
 * How the bytes reach the Worker. A Worker cannot compile Wasm from bytes at runtime (workerd refuses code generation),
 * so the module is part of the deployed bundle: the dynamic import below names the very file her browser fetches
 * (apps/web/public/cells/kyber-cpu.wasm, a T2 path); wrangler's default module rule for `*.wasm` (CompiledWasm) uploads
 * it beside the Worker and hands back a compiled WebAssembly.Module as the default export. The SHA-256 pin is bound at
 * build time, on the file itself: deploy/cloudflare/src/__tests__/kyber-cell.test.mjs hashes the file this import names
 * and holds it equal to KYBER_CELL.sha256 and to CELL_PINS['kyber-cpu']. At runtime (bytes are not readable from a
 * compiled module) admission checks what a module can show: zero imports, exactly the metered ABI v1 exports, a memory of
 * exactly the pinned size that cannot grow, ABI version 1. The import is dynamic so that nothing else that imports
 * worker.mjs loads a Wasm file; Node (the tests) is given the same CompiledWasm shape by a module hook.
 *
 * Each call runs on a FRESH instance with the pinned fuel grant and the same envelope her browser host sends
 * (canonical `{"abi":1,"input":..,"op":..,"seq":1}`), and the cell's own refusal is passed through as a refusal, never
 * turned into a value.
 */
import { cellRequestBytes } from './aura-focus-cell-shadow.mjs'
// ---- CORDECHO block begin ----
import { CORD_ECHO_CELL, importCordEchoCell } from './cord-echo-cell.mjs'
// ---- CORDECHO block end ----
// ---- MENGERHIVE block begin ----
import { MENGER_HIVE_CELL, importMengerHiveCell } from './menger-hive-cell.mjs'
// ---- MENGERHIVE block end ----

/** CELL_PINS['kyber-cpu'] in packages/experimental/webworker-runtime/src/x6/wasm-cells.ts (a test holds them equal). */
export const KYBER_CELL = Object.freeze({
  name: 'kyber-cpu',
  sha256: 'dcbd53f9cfb2d55753c07ee182dd7f247b32ae0e3f08b568b1266339ce92ee14',
  bytes: 9750,
  fuel: 250_000_000,
  /** The cell declares `(memory 12 12)`: twelve 64 KiB pages, never grown. */
  memoryBytes: 12 * 65_536,
  ops: Object.freeze(['cpu.step', 'cpu.run', 'cpu.resume']),
})
export const KYBER_CELL_EXPORTS = Object.freeze(['__mv_fuel_remaining', '__mv_fuel_set', 'memory', 'mv_abi_version', 'mv_alloc', 'mv_run'])
/** The file the bundle carries; the pin test resolves this exact specifier (keep it a literal in loadKyberCell too). */
export const KYBER_CELL_SPECIFIER = '../../../apps/web/public/cells/kyber-cpu.wasm'
// ---- CORDECHO block begin ----
/**
 * The cells this route runs, as an exact frozen allow-list. `kyber-cpu` is the entry above, unchanged;
 * `cord-echo` (one ongoing Cord skill, docs/auma/cord-echo.md) is the second. Each keeps its own literal import (kyber's
 * in loadKyberCell below, cord-echo's in cord-echo-cell.mjs) and its own pin test on the very file. Any other cell name
 * is CELL_RUN_CELL_REFUSED and any other op CELL_RUN_OP_REFUSED, before anything loads.
 */
export const EDGE_CELLS = Object.freeze({ 'kyber-cpu': KYBER_CELL, 'cord-echo': CORD_ECHO_CELL, 'menger-hive': MENGER_HIVE_CELL })
/** The edge's own memory: none. Its `expect` comes from her request; see docs/auma/cord-echo.md ("Where the head lives"). */
const edgeCellLoaders = Object.freeze({ 'kyber-cpu': () => loadKyberCell(), 'cord-echo': () => loadCordEchoCell(), 'menger-hive': () => loadMengerHiveCell() })
/**
 * The pin a cord-echo request claims for the cell it continues: a checkpoint's `cell` for cord.run, `cell` for
 * cord.genesis; cord.info claims none (null). A cell cannot know its own pin, so the HOST checks it.
 */
function cordPinClaim(op, input) {
  if (op === 'cord.info') return null
  return op === 'cord.run' ? (isRecord(input.checkpoint) ? input.checkpoint.cell : undefined) : input.cell
}
// ---- CORDECHO block end ----
/** The one owner-only route: POST, JSON, at most 8 KiB, `{ cell, op, input }` and nothing else. */
export const CELL_RUN_ROUTE = Object.freeze({ path: '/_host/cell-run', maxBytes: 8192, readMs: 10_000 })

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
const refuse = (code, status) => json({ ok: false, code }, status)

function isRecord(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Admit a module handed over as the bundle's CompiledWasm default export. Pure and synchronous; a failure is
 * `{ error }` with one closed code, never a throw.
 * @param {unknown} candidate
 * @returns {Readonly<{ module: WebAssembly.Module }> | Readonly<{ error: string }>}
 */
export function admitKyberCellModule(candidate, entry = KYBER_CELL) {
  try {
    if (!(candidate instanceof WebAssembly.Module)) return Object.freeze({ error: 'MODULE_UNAVAILABLE' })
    if (WebAssembly.Module.imports(candidate).length !== 0) return Object.freeze({ error: 'MODULE_IMPORTS' })
    const names = WebAssembly.Module.exports(candidate).map(entry => entry.name).sort()
    if (names.length !== KYBER_CELL_EXPORTS.length || names.some((name, index) => name !== KYBER_CELL_EXPORTS[index])) return Object.freeze({ error: 'MODULE_EXPORTS' })
    // A probe instance: the memory is exactly the pinned size and its declared maximum stops any growth.
    const probe = new WebAssembly.Instance(candidate, {}).exports
    if (!(probe.memory instanceof WebAssembly.Memory) || probe.memory.buffer.byteLength !== entry.memoryBytes) return Object.freeze({ error: 'MODULE_MEMORY_LIMIT' })
    let grew = true
    try { probe.memory.grow(1) } catch { grew = false }
    if (grew) return Object.freeze({ error: 'MODULE_MEMORY_UNBOUNDED' })
    // Metered: every export call spends fuel, so the probe is given the pinned grant first (as the runner does).
    if (typeof probe.__mv_fuel_set !== 'function' || typeof probe.mv_abi_version !== 'function') return Object.freeze({ error: 'MODULE_EXPORTS' })
    probe.__mv_fuel_set(BigInt(entry.fuel))
    if (probe.mv_abi_version() !== 1) return Object.freeze({ error: 'ABI_VERSION' })
    return Object.freeze({ module: candidate })
  } catch {
    return Object.freeze({ error: 'MODULE_BINARY' })
  }
}

let admitted = null
/**
 * The cell for this isolate, admitted once. A failed load is not kept: the next call tries again.
 * @returns {Promise<Readonly<{ module: WebAssembly.Module }> | Readonly<{ error: string }>>}
 */
export function loadKyberCell() {
  if (admitted !== null) return admitted
  const next = import('../../../apps/web/public/cells/kyber-cpu.wasm')
    .then(namespace => admitKyberCellModule(namespace?.default), () => Object.freeze({ error: 'MODULE_UNAVAILABLE' }))
  admitted = next
  void next.then(result => { if (result.error && admitted === next) admitted = null })
  return next
}

// ---- CORDECHO block begin ----
let cordAdmitted = null
/** cord-echo for this isolate, admitted once by the same admission as kyber-cpu (its entry); a failed load is not kept. */
export function loadCordEchoCell() {
  if (cordAdmitted !== null) return cordAdmitted
  const next = importCordEchoCell()
    .then(namespace => admitKyberCellModule(namespace?.default, CORD_ECHO_CELL), () => Object.freeze({ error: 'MODULE_UNAVAILABLE' }))
  cordAdmitted = next
  void next.then(result => { if (result.error && cordAdmitted === next) cordAdmitted = null })
  return next
}
// ---- CORDECHO block end ----
// ---- MENGERHIVE block begin ----
let mengerHiveAdmitted = null
/** menger-hive for this isolate, admitted once by the same admission as kyber-cpu (its entry); a failed load is not kept. */
export function loadMengerHiveCell() {
  if (mengerHiveAdmitted !== null) return mengerHiveAdmitted
  const next = importMengerHiveCell()
    .then(namespace => admitKyberCellModule(namespace?.default, MENGER_HIVE_CELL), () => Object.freeze({ error: 'MODULE_UNAVAILABLE' }))
  mengerHiveAdmitted = next
  void next.then(result => { if (result.error && mengerHiveAdmitted === next) mengerHiveAdmitted = null })
  return next
}
// ---- MENGERHIVE block end ----

/**
 * One call on a fresh instance of an admitted module, exactly as her browser's execution worker calls a cell: pinned
 * fuel grant, mv_alloc, mv_run, response descriptor, envelope. Synchronous; never throws.
 * `entry` is the allow-listed cell (default kyber-cpu) and `grant` its fuel; the route always passes the entry's
 * pinned fuel, and a test may pass a smaller grant to see FUEL come back as a refusal.
 * @returns {{ ok: true, result: unknown, fuelUsed: number } | { ok: false, source: 'cell' | 'host', code: string, fuelUsed: number | null }}
 */
export function runKyberCell(module, op, input, entry = KYBER_CELL, grant = entry.fuel) {
  const fuel = BigInt(grant)
  const seq = 1
  const host = (code, fuelUsed = null) => ({ ok: false, source: 'host', code, fuelUsed })
  let request
  try { request = cellRequestBytes(op, input, seq) } catch { return host('UNREPRESENTABLE') }
  let exports
  try {
    exports = new WebAssembly.Instance(module, {}).exports
    if (!(exports.memory instanceof WebAssembly.Memory) || exports.memory.buffer.byteLength > entry.memoryBytes) return host('MEMORY_CEILING')
    exports.__mv_fuel_set(fuel)
    if (exports.mv_abi_version() !== 1) return host('ABI_VERSION')
    exports.__mv_fuel_set(fuel)
    const pointer = exports.mv_alloc(request.byteLength)
    if (pointer < 64 || pointer + request.byteLength > exports.memory.buffer.byteLength) return host('ALLOC')
    new Uint8Array(exports.memory.buffer, pointer, request.byteLength).set(request)
    exports.__mv_fuel_set(fuel)
    const packed = exports.mv_run(pointer, request.byteLength)
    if (exports.memory.buffer.byteLength > entry.memoryBytes) return host('MEMORY_CEILING')
    const remaining = exports.__mv_fuel_remaining()
    if (remaining < 0n || remaining > fuel) return host('FUEL_INVALID')
    const fuelUsed = Number(fuel - remaining)
    const length = Number(packed >> 32n), offset = Number(packed & 0xffff_ffffn)
    if (length <= 0 || offset < 64 || offset + length > exports.memory.buffer.byteLength) return host('RESPONSE_DESCRIPTOR', fuelUsed)
    let answer
    try { answer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(exports.memory.buffer, offset, length))) }
    catch { return host('MALFORMED_RESPONSE', fuelUsed) }
    if (!isRecord(answer) || answer.abi !== 1) return host('MALFORMED_RESPONSE', fuelUsed)
    if (answer.status === 'refused') return { ok: false, source: 'cell', code: typeof answer.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(answer.code) ? answer.code : 'REFUSED', fuelUsed }
    if (answer.status !== 'ok' || answer.seq !== seq || !Object.hasOwn(answer, 'result')) return host('MALFORMED_RESPONSE', fuelUsed)
    return { ok: true, result: answer.result, fuelUsed }
  } catch (error) {
    let remaining
    try { remaining = exports?.__mv_fuel_remaining() } catch { /* the instance is discarded */ }
    const fuelUsed = typeof remaining === 'bigint' && remaining >= 0n && remaining <= fuel ? Number(fuel - remaining) : null
    return host(error instanceof WebAssembly.RuntimeError && typeof remaining === 'bigint' && remaining < 16n ? 'FUEL' : 'TRAP', fuelUsed)
  }
}

/** Read at most `max` bytes of a request body before `readMs`; { bytes } or { code, status }. */
async function readBounded(request, max, readMs) {
  const declared = request.headers.get('content-length')
  if (declared !== null && !/^(0|[1-9][0-9]{0,15})$/.test(declared)) return { code: 'CELL_RUN_REQUEST_INVALID', status: 400 }
  if (declared !== null && Number(declared) > max) return { code: 'CELL_RUN_TOO_LARGE', status: 413 }
  const encoding = request.headers.get('content-encoding')
  if (encoding !== null && encoding !== 'identity') return { code: 'CELL_RUN_MEDIA_TYPE', status: 415 }
  const reader = request.body?.getReader()
  if (!reader) return { code: 'CELL_RUN_REQUEST_INVALID', status: 400 }
  const chunks = []
  let size = 0, timer
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve('late'), readMs) })
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline])
      if (next === 'late') { void reader.cancel().catch(() => {}); return { code: 'CELL_RUN_REQUEST_TIMEOUT', status: 408 } }
      if (next.done) break
      size += next.value.byteLength
      if (size > max) { void reader.cancel().catch(() => {}); return { code: 'CELL_RUN_TOO_LARGE', status: 413 } }
      chunks.push(next.value)
    }
  } catch { return { code: 'CELL_RUN_REQUEST_INVALID', status: 400 } }
  finally { clearTimeout(timer) }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
  return { bytes }
}

/**
 * POST /_host/cell-run (worker.mjs, the one KYBERHAND hook, after the session is known and before any bootstrap read).
 * Each check by name, in this order: no query or fragment (404 NOT_FOUND); POST (405 METHOD_UNAVAILABLE); her own page,
 * Origin and `sec-fetch-site: same-origin` exactly as /_host/voice judges a POST (403 SAME_ORIGIN_BROWSER_REQUIRED); the
 * owner (403 OWNER_ACCESS_REQUIRED; no session at all was already 401 above it); `application/json` (415
 * CELL_RUN_MEDIA_TYPE); at most 8 KiB (413 CELL_RUN_TOO_LARGE); UTF-8 JSON of exactly `{ cell, op, input }` (400
 * CELL_RUN_REQUEST_INVALID); only a cell of EDGE_CELLS (400 CELL_RUN_CELL_REFUSED); only its three ops (400
 * CELL_RUN_OP_REFUSED); for cord-echo, the pin its request claims is this edge's own (422 CORD_PIN_MISMATCH).
 * Then one call on a fresh instance. The answer: `{ ok: true, cell, op, result, host: 'edge', pin, fuelUsed }`, or the
 * cell's own refusal `{ ok: false, code, source: 'cell', host, pin, fuelUsed }` (422), or a host refusal (422; 503
 * CELL_RUN_UNAVAILABLE when the module could not be admitted).
 * @param {Request} request
 * @param {URL} url
 * @param {string | null} origin
 * @param {{ type?: string } | null} access
 */
export async function cellRunDoor(request, url, origin, access) {
  if (url.search || url.hash) return refuse('NOT_FOUND', 404)
  if (request.method !== 'POST') return refuse('METHOD_UNAVAILABLE', 405)
  if (origin !== url.origin || request.headers.get('sec-fetch-site') !== 'same-origin') return refuse('SAME_ORIGIN_BROWSER_REQUIRED', 403)
  if (access?.type !== 'owner') return refuse('OWNER_ACCESS_REQUIRED', 403)
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return refuse('CELL_RUN_MEDIA_TYPE', 415)
  const read = await readBounded(request, CELL_RUN_ROUTE.maxBytes, CELL_RUN_ROUTE.readMs)
  if (read.code) return refuse(read.code, read.status)
  let body
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)) } catch { return refuse('CELL_RUN_REQUEST_INVALID', 400) }
  if (!isRecord(body)) return refuse('CELL_RUN_REQUEST_INVALID', 400)
  const keys = Object.keys(body).sort()
  if (keys.length !== 3 || keys[0] !== 'cell' || keys[1] !== 'input' || keys[2] !== 'op') return refuse('CELL_RUN_REQUEST_INVALID', 400)
  if (typeof body.cell !== 'string' || !Object.hasOwn(EDGE_CELLS, body.cell)) return refuse('CELL_RUN_CELL_REFUSED', 400)
  const entry = EDGE_CELLS[body.cell]
  if (typeof body.op !== 'string' || !entry.ops.includes(body.op)) return refuse('CELL_RUN_OP_REFUSED', 400)
  if (!isRecord(body.input)) return refuse('CELL_RUN_REQUEST_INVALID', 400)
  // ---- CORDECHO block begin ----
  const claim = entry === CORD_ECHO_CELL ? cordPinClaim(body.op, body.input) : null
  if (claim !== null && claim !== entry.sha256) return json({ ok: false, code: 'CORD_PIN_MISMATCH', host: 'edge', pin: entry.sha256 }, 422)
  // ---- CORDECHO block end ----
  const cell = await edgeCellLoaders[entry.name]()
  if (cell.error) return json({ ok: false, code: 'CELL_RUN_UNAVAILABLE', module: cell.error }, 503)
  const run = runKyberCell(cell.module, body.op, body.input, entry, entry.fuel)
  const where = { host: 'edge', pin: entry.sha256, fuelUsed: run.fuelUsed }
  if (!run.ok) return json({ ok: false, code: run.code, source: run.source, ...where }, run.code === 'UNREPRESENTABLE' ? 400 : 422)
  return json({ ok: true, cell: entry.name, op: body.op, result: run.result, ...where })
}
