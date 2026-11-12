/**
 * Rebuild the Aura focus cell from its source with the repository's own pinned compiler cell, no outside tool:
 * apps/web/public/cells/aura-focus.wat -> skillsmith `build` -> skillsmith `meter` -> aura-focus.wasm.
 * Same two calls and inputs as compileAndRun in packages/experimental/webworker-runtime/src/x6/wasm-cells.ts
 * (name 'aura-focus', version 'v1', object schemas, guest fuel 1,000,000), run in-process under Node.
 *
 * Usage: node server/aura-focus-cell.build.mjs           (print hashes; exit 1 if the checked-in bytes differ)
 *        node server/aura-focus-cell.build.mjs --write   (write the metered bytes to aura-focus.wasm)
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cellRequestBytes } from '../deploy/cloudflare/src/aura-focus-cell-shadow.mjs'

const CELLS = new URL('../apps/web/public/cells/', import.meta.url)
/** CELL_PINS.skillsmith in wasm-cells.ts; the compiler is refused unless it is exactly these bytes. */
const SKILLSMITH_PIN = Object.freeze({ sha256: '35cd471bcf029cc1f437803f6799b5469e525e83f113e5c775f95935e5ed24fa', bytes: 592220 })
/** min(CELL_PINS.skillsmith.fuel, CELL_BROWSER_FUEL_CAP): the grant her browser worker gives the compiler. */
const SKILLSMITH_FUEL = 300_000_000n
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

/** @returns {{ wat: Buffer, raw: Buffer, metered: Buffer, buildFuel: number, meterFuel: number }} */
export function buildAuraFocusCell() {
  const wat = readFileSync(new URL('aura-focus.wat', CELLS))
  const call = skillsmith()
  const build = call('build', { wat: wat.toString('utf8'), name: 'aura-focus', version: 'v1',
    input_schema: { type: 'object' }, output_schema: { type: 'object' }, fuel: 1_000_000 })
  const raw = Buffer.from(build.result.bytes, 'base64')
  if (sha256(raw) !== build.result.code_sha256) throw new Error('skillsmith build: code_sha256 does not match its bytes')
  const meter = call('meter', { bytes: build.result.bytes })
  const metered = Buffer.from(meter.result.bytes, 'base64')
  if (sha256(metered) !== meter.result.metered_sha256) throw new Error('skillsmith meter: metered_sha256 does not match its bytes')
  return { wat, raw, metered, buildFuel: build.fuelUsed, meterFuel: meter.fuelUsed }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { wat, raw, metered, buildFuel, meterFuel } = buildAuraFocusCell()
  const target = new URL('aura-focus.wasm', CELLS)
  if (process.argv.includes('--write')) writeFileSync(target, metered)
  const shipped = readFileSync(target)
  console.log(`aura-focus.wat   ${wat.byteLength} bytes sha256 ${sha256(wat)}`)
  console.log(`skillsmith build ${raw.byteLength} bytes sha256 ${sha256(raw)} fuel ${buildFuel}`)
  console.log(`skillsmith meter ${metered.byteLength} bytes sha256 ${sha256(metered)} fuel ${meterFuel}`)
  console.log(`aura-focus.wasm  ${shipped.byteLength} bytes sha256 ${sha256(shipped)} identical to rebuild: ${Buffer.compare(shipped, metered) === 0}`)
  process.exit(Buffer.compare(shipped, metered) === 0 ? 0 : 1)
}
