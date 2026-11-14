/**
 * Rebuild the cord-echo cell (one ongoing Cord skill, docs/auma/cord-echo.md) from its source with the
 * repository's own pinned compiler cell, no outside tool: apps/web/public/cells/cord-echo.wat -> skillsmith `build` ->
 * skillsmith `meter` -> cord-echo.wasm. A copy of server/nucleus-cell.build.mjs (same two calls and inputs as
 * compileAndRun in packages/experimental/webworker-runtime/src/x6/wasm-cells.ts: name 'cord-echo', version 'v1', object
 * schemas, guest fuel 1,000,000), run in-process under Node, with the same check mode ("identical to rebuild").
 *
 * One step more than nucleus: the profile's sha256 is a constant inside the cell. The build reads
 * apps/web/public/cells/cord/fifo24.profile.json, hashes its exact bytes, and the WAT's one PROFILE-SHA256 data line must
 * hold those 32 bytes (`--write` sets that line first). A profile edited without a rebuild fails the check.
 *
 * Usage: node server/cord-echo-cell.build.mjs           (print hashes; exit 1 if the checked-in WAT or bytes differ)
 *        node server/cord-echo-cell.build.mjs --write   (set the profile line in the WAT, write the metered bytes)
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cellRequestBytes } from '../deploy/cloudflare/src/aura-focus-cell-shadow.mjs'

const CELLS = new URL('../apps/web/public/cells/', import.meta.url)
export const CORD_PROFILE_FILE = 'cord/fifo24.profile.json'
/** CELL_PINS.skillsmith in wasm-cells.ts; the compiler is refused unless it is exactly these bytes. */
const SKILLSMITH_PIN = Object.freeze({ sha256: '35cd471bcf029cc1f437803f6799b5469e525e83f113e5c775f95935e5ed24fa', bytes: 592220 })
/** min(CELL_PINS.skillsmith.fuel, CELL_BROWSER_FUEL_CAP): the grant her browser worker gives the compiler. */
const SKILLSMITH_FUEL = 300_000_000n
const PROFILE_LINE = /\(data \(i32\.const 1632\) "((?:\\[0-9a-f]{2}){32})"\)/u
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function skillsmith() {
  const bytes = readFileSync(new URL('skillsmith.wasm', CELLS))
  if (bytes.byteLength !== SKILLSMITH_PIN.bytes || sha256(bytes) !== SKILLSMITH_PIN.sha256) throw new Error('skillsmith.wasm does not match its pin')
  const module = new WebAssembly.Module(bytes)
  let seq = 0
  return (op, input) => {
    seq += 1
    const exports = new WebAssembly.Instance(module, {}).exports
    const request = cellRequestBytes(op, input, seq)
    exports.__mv_fuel_set(SKILLSMITH_FUEL)
    const pointer = exports.mv_alloc(request.byteLength)
    if (pointer === 0) throw new Error(`skillsmith ${op}: ALLOC`)
    new Uint8Array(exports.memory.buffer, pointer, request.byteLength).set(request)
    exports.__mv_fuel_set(SKILLSMITH_FUEL)
    const packed = exports.mv_run(pointer, request.byteLength)
    const fuelUsed = Number(SKILLSMITH_FUEL - exports.__mv_fuel_remaining())
    const length = Number(packed >> 32n), offset = Number(packed & 0xffff_ffffn)
    const answer = JSON.parse(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, offset, length)))
    if (answer.abi !== 1 || answer.seq !== seq || answer.status !== 'ok') throw new Error(`skillsmith ${op}: ${answer.code ?? 'bad envelope'}`)
    return { result: answer.result, fuelUsed }
  }
}

/** The profile's sha256 (hex) and the WAT text with its PROFILE-SHA256 line holding exactly those bytes. */
export function cordEchoSource() {
  const profile = readFileSync(new URL(CORD_PROFILE_FILE, CELLS))
  const profileSha256 = sha256(profile)
  const shipped = readFileSync(new URL('cord-echo.wat', CELLS), 'utf8')
  if (!PROFILE_LINE.test(shipped)) throw new Error('cord-echo.wat has no PROFILE-SHA256 data line')
  const escaped = profileSha256.replace(/../gu, byte => `\\${byte}`)
  const wat = shipped.replace(PROFILE_LINE, `(data (i32.const 1632) "${escaped}")`)
  return { profileSha256, shipped, wat }
}

/** @returns {{ wat: Buffer, raw: Buffer, metered: Buffer, buildFuel: number, meterFuel: number, profileSha256: string, watCurrent: boolean }} */
export function buildCordEchoCell() {
  const { profileSha256, shipped, wat: text } = cordEchoSource()
  const wat = Buffer.from(text, 'utf8')
  const call = skillsmith()
  const build = call('build', { wat: text, name: 'cord-echo', version: 'v1',
    input_schema: { type: 'object' }, output_schema: { type: 'object' }, fuel: 1_000_000 })
  const raw = Buffer.from(build.result.bytes, 'base64')
  if (sha256(raw) !== build.result.code_sha256) throw new Error('skillsmith build: code_sha256 does not match its bytes')
  const meter = call('meter', { bytes: build.result.bytes })
  const metered = Buffer.from(meter.result.bytes, 'base64')
  if (sha256(metered) !== meter.result.metered_sha256) throw new Error('skillsmith meter: metered_sha256 does not match its bytes')
  return { wat, raw, metered, buildFuel: build.fuelUsed, meterFuel: meter.fuelUsed, profileSha256, watCurrent: shipped === text }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write')
  const { wat, raw, metered, buildFuel, meterFuel, profileSha256, watCurrent } = buildCordEchoCell()
  const target = new URL('cord-echo.wasm', CELLS)
  if (write) { writeFileSync(new URL('cord-echo.wat', CELLS), wat); writeFileSync(target, metered) }
  let shipped = Buffer.alloc(0)
  try { shipped = readFileSync(target) } catch { /* missing is not identical */ }
  const same = Buffer.compare(shipped, metered) === 0 && (write || watCurrent)
  console.log(`fifo24.profile   sha256 ${profileSha256} (in the WAT: ${write || watCurrent})`)
  console.log(`cord-echo.wat    ${wat.byteLength} bytes sha256 ${sha256(wat)}`)
  console.log(`skillsmith build ${raw.byteLength} bytes sha256 ${sha256(raw)} fuel ${buildFuel}`)
  console.log(`skillsmith meter ${metered.byteLength} bytes sha256 ${sha256(metered)} fuel ${meterFuel}`)
  console.log(`cord-echo.wasm   ${shipped.byteLength} bytes sha256 ${sha256(shipped)} identical to rebuild: ${same}`)
  process.exit(same ? 0 : 1)
}
