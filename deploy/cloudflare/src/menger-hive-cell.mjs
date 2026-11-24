/**
 * The menger-hive cell's place in the edge bundle (docs/auma/menger-hive.md). Mirrors cord-echo-cell.mjs:
 * one LITERAL dynamic import of the very file her browser fetches (apps/web/public/cells/menger-hive.wasm, served at
 * /cells/menger-hive.wasm), so wrangler carries it as CompiledWasm, and the pin those bytes must hash to.
 * deploy/cloudflare/src/__tests__/menger-hive-cell.test.mjs resolves this specifier, hashes the file and holds it equal
 * to MENGER_HIVE_CELL and to CELL_PINS['menger-hive'].
 *
 * It lives in its own module so that kyber-cell.mjs keeps its single literal dynamic import and so that nothing loads
 * this Wasm file until a menger-hive request asks for it. Nothing here is authority: admission and execution are
 * kyber-cell.mjs's, unchanged; this file names bytes and nothing else.
 */

/** CELL_PINS['menger-hive'] in packages/experimental/webworker-runtime/src/x6/wasm-cells.ts (a test holds them equal). */
export const MENGER_HIVE_CELL = Object.freeze({
  name: 'menger-hive',
  sha256: '80fba1f9ea6de88c9618429044dfb1d04693696c4125e55b53fe8e69ca6e99c6',
  bytes: 25300,
  fuel: 2_000_000,
  /** The cell declares `(memory 4 4)`: four 64 KiB pages, never grown. */
  memoryBytes: 4 * 65_536,
  ops: Object.freeze(['hive.info', 'hive.step_monolith', 'hive.boundary', 'hive.step_organ', 'hive.step_body']),
})
/** The file the bundle carries; the pin test resolves this exact specifier (keep it a literal in importMengerHiveCell too). */
export const MENGER_HIVE_CELL_SPECIFIER = '../../../apps/web/public/cells/menger-hive.wasm'

/** The bundle's CompiledWasm namespace for menger-hive.wasm (a literal, for the bundler). */
export function importMengerHiveCell() {
  return import('../../../apps/web/public/cells/menger-hive.wasm')
}
