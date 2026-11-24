#!/usr/bin/env node
/**
 * Lane E2 in real engines: src/x6/wasm-cells.ts, transpiled as-is, runs in Chromium, Firefox and
 * WebKit with its own browser worker transport (a Blob URL dedicated Worker, browserCellWorker), on a routed https origin.
 *
 *   node packages/experimental/webworker-runtime/tests/x6/wasm-cells-browser.mjs
 *
 * Per engine it proves:
 *   16. an infinite loop in mv_run is killed at CELL_EXECUTION_TIMEOUT_MS (TIMEOUT) while the page's own event loop keeps
 *       ticking, and the next call (a real pinned cell, nostr-core) answers from a fresh worker;
 *   15. a one-byte flip of a pinned cell (seed-judge) is refused MODULE_HASH;
 *   14. a module whose binary declares no memory maximum, or a maximum over the ceiling, is refused before compiling.
 * Exit 0 only when every engine passes; a missing engine is a failure, never a skip. No network: every request is routed.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const ORIGIN = 'https://wasm-cells.invalid'
const require = createRequire(resolve(ROOT, 'package.json'))
const ts = require('typescript')
const playwright = createRequire(resolve(ROOT, 'apps/web/package.json'))('playwright')

const source = readFileSync(resolve(ROOT, 'packages/experimental/webworker-runtime/src/x6/wasm-cells.ts'), 'utf8')
const moduleJs = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const cellsDir = resolve(ROOT, 'apps/web/public/cells')
const cellFile = (name) => new Uint8Array(readFileSync(resolve(cellsDir, `${name}.wasm`)))

// The same small metered-ABI module the vitest suite builds; `loop` spins forever in mv_run.
const unsigned = (value) => { const out = []; do { const b = value & 127; value = Math.floor(value / 128); out.push(b | (value ? 128 : 0)) } while (value); return out }
const signed = (value) => { const out = []; for (;;) { const b = Number(value & 127n); value >>= 7n; const done = (value === 0n && (b & 64) === 0) || (value === -1n && (b & 64) !== 0); out.push(b | (done ? 0 : 128)); if (done) return out } }
const section = (id, data) => [id, ...unsigned(data.length), ...data]
const vector = (rows) => [...unsigned(rows.length), ...rows.flat()]
const text = (value) => { const b = [...new TextEncoder().encode(value)]; return [...unsigned(b.length), ...b] }
function cell({ memory = [1, 1, 1, 2], loop = false } = {}) {
  const body = (ins) => { const code = [0, ...ins, 0x0b]; return [...unsigned(code.length), ...code] }
  const output = [...new TextEncoder().encode('{"abi":1,"seq":1,"status":"ok","result":true}')]
  const packed = (BigInt(output.length) << 32n) | 1024n
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, vector([[0x60, 0, 1, 0x7f], [0x60, 1, 0x7f, 1, 0x7f], [0x60, 2, 0x7f, 0x7f, 1, 0x7e], [0x60, 1, 0x7e, 0], [0x60, 0, 1, 0x7e]])),
    ...section(3, vector([[0], [1], [2], [3], [4]])),
    ...section(5, memory),
    ...section(7, vector([[...text('memory'), 2, 0], [...text('mv_abi_version'), 0, 0], [...text('mv_alloc'), 0, 1],
      [...text('mv_run'), 0, 2], [...text('__mv_fuel_set'), 0, 3], [...text('__mv_fuel_remaining'), 0, 4]])),
    ...section(10, vector([body([0x41, 1]), body([0x41, ...signed(4096n)]), body([...(loop ? [0x03, 0x40, 0x0c, 0x00, 0x0b] : []), 0x42, ...signed(packed)]), body([]), body([0x42, 0])])),
    ...section(11, [1, 0, 0x41, ...signed(1024n), 0x0b, ...unsigned(output.length), ...output])])
}
const pin = (bytes) => ({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), fuel: 100_000 })

const flipped = cellFile('seed-judge'); flipped[flipped.length - 1] ^= 0x01
const served = {
  runaway: cell({ loop: true }),
  unbounded: cell({ memory: [1, 0, 1] }),
  oversized: cell({ memory: [1, 1, 1, ...unsigned(4097)] }),
  'seed-judge': flipped,
  'nostr-core': cellFile('nostr-core'),
}
const pins = { runaway: pin(served.runaway), unbounded: pin(served.unbounded), oversized: pin(served.oversized) }
const page = `<!doctype html><meta charset="utf-8"><title>wasm cells</title><script type="module">
import * as cells from '/wasm-cells.js'
globalThis.__cells = cells
globalThis.__ready = true
</script>`

let failed = 0
for (const engine of ['chromium', 'firefox', 'webkit']) {
  let browser
  try {
    browser = await playwright[engine].launch({ headless: true })
    const context = await browser.newContext()
    await context.route('**/*', async (route) => {
      // WebKit routes the Blob URL of the cell worker through here too; it is the page's own in-memory script.
      if (route.request().url().startsWith('blob:')) return route.continue()
      const url = new URL(route.request().url())
      if (url.origin !== ORIGIN) return route.abort()
      if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: page })
      if (url.pathname === '/wasm-cells.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: moduleJs })
      const name = /^\/cells\/([a-z-]+)\.wasm$/.exec(url.pathname)?.[1]
      if (name && served[name]) return route.fulfill({ status: 200, contentType: 'application/wasm', body: Buffer.from(served[name]) })
      return route.fulfill({ status: 404, body: 'no' })
    })
    const tab = await context.newPage()
    await tab.goto(`${ORIGIN}/`)
    await tab.waitForFunction(() => globalThis.__ready === true, null, { timeout: 30_000 })
    const result = await tab.evaluate(async ({ pins }) => {
      const { createCellHost, CELL_PINS, CELL_EXECUTION_TIMEOUT_MS } = globalThis.__cells
      const host = createCellHost({ origin: location.origin, pins: { ...pins, 'seed-judge': CELL_PINS['seed-judge'], 'nostr-core': CELL_PINS['nostr-core'] } })
      let ticks = 0
      const ticker = setInterval(() => { ticks += 1 }, 20)
      const started = performance.now()
      const runaway = await host.invoke('runaway', 'run')
      const elapsed = Math.round(performance.now() - started)
      clearInterval(ticker)
      const after = await host.invoke('nostr-core', 'nostr.ping')
      const flip = await host.invoke('seed-judge', 'seed.platform', { platform: 'browser' })
      const unbounded = await host.invoke('unbounded', 'run')
      const oversized = await host.invoke('oversized', 'run')
      await host.dispose()
      return { timeoutMs: CELL_EXECUTION_TIMEOUT_MS, runaway: runaway.code ?? 'ok', elapsed, ticks, after: after.ok ? after.result : after.code,
        flip: flip.code ?? 'ok', unbounded: unbounded.code ?? 'ok', oversized: oversized.code ?? 'ok' }
    }, { pins })
    assert.equal(result.runaway, 'TIMEOUT')
    assert.ok(result.elapsed >= result.timeoutMs - 10 && result.elapsed < result.timeoutMs + 5000, `deadline ${result.elapsed} ms`)
    assert.ok(result.ticks > 100, `page event loop ticked ${result.ticks} times during the runaway call`)
    assert.deepEqual(result.after, { pong: true, version: 1 })
    assert.match(result.flip, /^MODULE_HASH/)
    assert.match(result.unbounded, /^MODULE_MEMORY_UNBOUNDED/)
    assert.match(result.oversized, /^MODULE_MEMORY_LIMIT/)
    console.log(`WASM_CELLS_BROWSER PASS ${engine} ${browser.version()} ${JSON.stringify(result)}`)
  } catch (error) {
    failed += 1
    console.log(`WASM_CELLS_BROWSER FAIL ${engine} ${String(error?.message ?? error).split('\n')[0]}`)
  } finally { await browser?.close().catch(() => {}) }
}
process.exit(failed === 0 ? 0 : 1)
