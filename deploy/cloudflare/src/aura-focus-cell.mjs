/**
 * Admit the pinned Aura focus cell in a Node host, synchronously and fail-closed, in admitCell's order
 * (packages/experimental/webworker-runtime/src/x6/wasm-cells.ts): size bound, exact SHA-256 pin on a private copy
 * before compiling, compile, zero imports, exactly the metered ABI v1 exports. The binary memory check
 * (inspectWasmMemory) and admitCell itself are run on these same pinned bytes by
 * packages/experimental/webworker-runtime/tests/x6/aura-focus-cell.spec.ts; the pin binds this loader to them.
 * Node only (it reads the file with node:fs); a Worker cannot compile Wasm bytes at runtime. Under deploy/, so a
 * repository write here needs the owner's Class 3 approval like the pin itself.
 * Failure is returned as { error }, which the shadow reports as a host refusal; it never throws into a status read.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { AURA_FOCUS_CELL_EXPORTS, AURA_FOCUS_CELL_PIN } from './aura-focus-cell-shadow.mjs'

export const AURA_FOCUS_CELL_PATH = new URL('../../../apps/web/public/cells/aura-focus.wasm', import.meta.url)

/**
 * @param {Uint8Array} bytes The fetched or read module bytes.
 * @returns {Readonly<{ module: WebAssembly.Module, sha256: string }> | Readonly<{ error: string }>}
 */
export function admitAuraFocusCellBytes(bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > AURA_FOCUS_CELL_PIN.bytes) return Object.freeze({ error: 'MODULE_BOUND' })
    const copy = Uint8Array.from(bytes)
    const sha256 = createHash('sha256').update(copy).digest('hex')
    if (sha256 !== AURA_FOCUS_CELL_PIN.sha256) return Object.freeze({ error: 'MODULE_HASH' })
    const module = new WebAssembly.Module(copy)
    if (WebAssembly.Module.imports(module).length !== 0) return Object.freeze({ error: 'MODULE_IMPORTS' })
    const names = WebAssembly.Module.exports(module).map(entry => entry.name).sort()
    if (names.length !== AURA_FOCUS_CELL_EXPORTS.length || names.some((name, index) => name !== AURA_FOCUS_CELL_EXPORTS[index])) {
      return Object.freeze({ error: 'MODULE_EXPORTS' })
    }
    return Object.freeze({ module, sha256 })
  } catch {
    return Object.freeze({ error: 'MODULE_BINARY' })
  }
}

/** Read and admit the shipped cell file; a missing or unreadable file is { error: 'MODULE_UNAVAILABLE' }. */
export function loadAuraFocusCell(path = AURA_FOCUS_CELL_PATH) {
  let bytes
  try { bytes = new Uint8Array(readFileSync(path)) } catch { return Object.freeze({ error: 'MODULE_UNAVAILABLE' }) }
  return admitAuraFocusCellBytes(bytes)
}
