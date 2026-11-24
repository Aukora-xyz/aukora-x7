/**
 * The cord-echo cell's place in the edge bundle (docs/auma/cord-echo.md). Exactly what kyber-cell.mjs
 * does for kyber-cpu, for a second allow-listed cell: one LITERAL dynamic import of the very file her browser fetches
 * (apps/web/public/cells/cord-echo.wasm, served at /cells/cord-echo.wasm), so the bundler carries it as CompiledWasm, and
 * the pin those bytes must hash to. deploy/cloudflare/src/__tests__/cord-echo-cell.test.mjs resolves this specifier,
 * hashes the file and holds it equal to CORD_ECHO_CELL and to CELL_PINS['cord-echo'].
 *
 * It lives in its own module so that kyber-cell.mjs keeps exactly one dynamic import (its own pin test reads that) and
 * so that nothing loads this Wasm file until a cord-echo request asks for it. Nothing here is authority: admission and
 * the one run are kyber-cell.mjs's, unchanged; this file names bytes and nothing else.
 */

/** CELL_PINS['cord-echo'] in packages/experimental/webworker-runtime/src/x6/wasm-cells.ts (a test holds them equal). */
export const CORD_ECHO_CELL = Object.freeze({
  name: 'cord-echo',
  sha256: '9d5935d3c5062bb440c62489144ddce820659839b46cf22b8713316d5b5132fa',
  bytes: 13530,
  fuel: 60_000_000,
  /** The cell declares `(memory 4 4)`: four 64 KiB pages, never grown. */
  memoryBytes: 4 * 65_536,
  ops: Object.freeze(['cord.genesis', 'cord.run', 'cord.info']),
})
/** The file the bundle carries; the pin test resolves this exact specifier (keep it a literal in importCordEchoCell too). */
export const CORD_ECHO_CELL_SPECIFIER = '../../../apps/web/public/cells/cord-echo.wasm'

/** The bundle's CompiledWasm namespace for cord-echo.wasm (a literal, for the bundler). */
export function importCordEchoCell() {
  return import('../../../apps/web/public/cells/cord-echo.wasm')
}
