/**
 * Lane E2: sovereign Wasm containment.
 *   14. memory limits are read from the module BINARY (LEB128 section walk), on the exact pinned bytes, before compiling;
 *       a missing or oversized maximum, a shared / 64-bit / imported memory, or an unparsable binary is refused, and the
 *       WAT-text pre-check can no longer be fooled (a comment that looks like a small memory no longer passes).
 *   15. a one-byte flip of a pinned cell fails the SHA-256 pin before compiling (and before the memory walk).
 *   16. a runaway cell is killed at the deadline in its own worker while the host keeps running and keeps serving.
 * No browser, network or secrets: cells come from apps/web/public/cells through a local fetch stub.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CELL_EXECUTION_TIMEOUT_MS, CELL_MAX_MEMORY_PAGES, CELL_PINS, SKILL_MAX_MEMORY_PAGES, admitCell, createCellHost, inspectWasmMemory,
  type CellHost, type CellPin, type CellWorker } from '../../src/x6/wasm-cells.ts'

const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const ORIGIN = 'https://x61-cells.example.invalid'

// ---- a tiny Wasm writer ---------------------------------------------------------------------------------------------
const unsigned = (value: number): number[] => {
  const bytes: number[] = []
  do { const byte = value & 127; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)) } while (value)
  return bytes
}
const signed = (value: bigint): number[] => {
  const bytes: number[] = []
  for (;;) {
    const byte = Number(value & 127n)
    value >>= 7n
    const done = (value === 0n && (byte & 64) === 0) || (value === -1n && (byte & 64) !== 0)
    bytes.push(byte | (done ? 0 : 128))
    if (done) return bytes
  }
}
const section = (id: number, data: number[]): number[] => [id, ...unsigned(data.length), ...data]
const vector = (rows: number[][]): number[] => [...unsigned(rows.length), ...rows.flat()]
const text = (value: string): number[] => {
  const bytes = [...new TextEncoder().encode(value)]
  return [...unsigned(bytes.length), ...bytes]
}
/** Memory section payload: one entry per [flags, initial, maximum?]. */
const memories = (...rows: Array<[number, number, number?]>): number[] =>
  vector(rows.map(([flags, initial, maximum]) => [flags, ...unsigned(initial), ...(maximum === undefined ? [] : unsigned(maximum))]))

/**
 * A complete metered-ABI cell (unmetered fuel exports) whose memory section is `memorySection` (null: none) and which
 * optionally imports, so the only thing that differs between a refused and an admitted module is the part under test.
 * `loop` puts an infinite loop in mv_run.
 */
function cell({ memorySection = memories([1, 1, 2]) as number[] | null, importSection = null as number[] | null, loop = false,
  payload = '{"abi":1,"seq":1,"status":"ok","result":true}', extra = [] as number[] } = {}): Uint8Array<ArrayBuffer> {
  const body = (instructions: number[]): number[] => { const code = [0, ...instructions, 0x0b]; return [...unsigned(code.length), ...code] }
  const output = [...new TextEncoder().encode(payload)]
  const packed = (BigInt(output.length) << 32n) | 1024n
  return new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...extra,
    ...section(1, vector([
      [0x60, 0, 1, 0x7f], [0x60, 1, 0x7f, 1, 0x7f], [0x60, 2, 0x7f, 0x7f, 1, 0x7e], [0x60, 1, 0x7e, 0], [0x60, 0, 1, 0x7e],
    ])),
    ...(importSection === null ? [] : section(2, importSection)),
    ...section(3, vector([[0], [1], [2], [3], [4]])),
    ...(memorySection === null ? [] : section(5, memorySection)),
    ...section(7, vector([[...text('memory'), 2, 0], [...text('mv_abi_version'), 0, 0], [...text('mv_alloc'), 0, 1],
      [...text('mv_run'), 0, 2], [...text('__mv_fuel_set'), 0, 3], [...text('__mv_fuel_remaining'), 0, 4]])),
    ...section(10, vector([body([0x41, 1]), body([0x41, ...signed(4096n)]),
      body([...(loop ? [0x03, 0x40, 0x0c, 0x00, 0x0b] : []), 0x42, ...signed(packed)]), body([]), body([0x42, 0])])),
    ...section(11, [1, 0, 0x41, ...signed(1024n), 0x0b, ...unsigned(output.length), ...output]),
  ])
}
const pinOf = (bytes: Uint8Array, fuel = 100_000): CellPin => ({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), fuel })

// ---- a host with real, terminable Node workers ------------------------------------------------------------------------
const hosts = new Set<CellHost>()
const workers = new Set<Worker>()
const nodeCellWorker = (source: string): CellWorker => {
  const worker = new Worker(`const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = value => parentPort.postMessage(value);
    parentPort.on('message', data => globalThis.onmessage({ data }));
    ${source}`, { eval: true, execArgv: [] })
  workers.add(worker)
  return {
    listen(onMessage, onFailure) { worker.on('message', onMessage); worker.on('error', onFailure); worker.on('messageerror', onFailure) },
    postMessage: message => worker.postMessage(message),
    async terminate() { await worker.terminate(); worker.removeAllListeners(); workers.delete(worker) },
  }
}
const served = (override: Record<string, Uint8Array<ArrayBuffer>> = {}) => (async (input: RequestInfo | URL) => {
  const url = new URL(String(input))
  const name = url.pathname.replace(/^\/cells\//, '').replace(/\.wasm$/, '')
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/cells/')) return new Response('no', { status: 404 })
  const bytes = override[name] ?? new Uint8Array(await readFile(new URL(`${name}.wasm`, CELLS)))
  return new Response(bytes, { headers: { 'content-type': 'application/wasm' } })
}) as typeof fetch
const testHost = (deps: Parameters<typeof createCellHost>[0]): CellHost => {
  const host = createCellHost({ createWorker: nodeCellWorker, ...deps })
  hosts.add(host)
  return host
}
afterEach(async () => {
  vi.restoreAllMocks()
  try { await Promise.all([...hosts].map(host => host.dispose())) }
  finally { hosts.clear(); await Promise.all([...workers].map(worker => worker.terminate())); workers.clear() }
})

/** Admission must refuse with `code` and never reach WebAssembly.compile. */
async function refusedBeforeCompile(bytes: Uint8Array<ArrayBuffer>, code: string | RegExp, ceiling?: number): Promise<void> {
  const compile = vi.spyOn(WebAssembly, 'compile')
  const pending = ceiling === undefined ? admitCell('probe', pinOf(bytes), bytes) : admitCell('probe', pinOf(bytes), bytes, ceiling)
  await expect(pending).rejects.toMatchObject({ name: 'CellError', code })
  expect(compile).not.toHaveBeenCalled()
  compile.mockRestore()
}

describe('Probe 14: binary memory admission, before compiling', () => {
  it('every shipped pinned cell declares one bounded memory at or under the ceiling and is still admitted', async () => {
    const files = (await readdir(CELLS)).filter(name => name.endsWith('.wasm')).map(name => name.slice(0, -5)).sort()
    expect(files).toEqual(Object.keys(CELL_PINS).sort())
    const limits: Record<string, string> = {}
    for (const name of files) {
      const bytes = new Uint8Array(await readFile(new URL(`${name}.wasm`, CELLS)))
      const memory = inspectWasmMemory(name, bytes, CELL_MAX_MEMORY_PAGES)
      limits[name] = `${String(memory.initial)}..${String(memory.maximum)}`
      expect(memory.maximum).toBeLessThanOrEqual(CELL_MAX_MEMORY_PAGES)
      await expect(admitCell(name, CELL_PINS[name]!, bytes)).resolves.toBeInstanceOf(WebAssembly.Module)
    }
    // The ceiling is exactly the largest pinned maximum: tightening it would refuse organism-tools.
    expect(Math.max(...Object.values(limits).map(range => Number(range.split('..')[1])))).toBe(CELL_MAX_MEMORY_PAGES)
    expect(limits['organism-tools']).toBe('16..4096')
    expect(limits['skillsmith']).toBe('17..1024')
  })

  it('the refused fixtures are otherwise valid Wasm: only the memory gate stands between them and compile', async () => {
    for (const bytes of [cell({ memorySection: memories([0, 1]) }), cell({ memorySection: memories([1, 1, CELL_MAX_MEMORY_PAGES + 1]) })]) {
      expect(WebAssembly.validate(bytes)).toBe(true)
    }
    await expect(admitCell('probe', pinOf(cell()), cell())).resolves.toBeInstanceOf(WebAssembly.Module)
  })

  it.each([
    ['no maximum (unbounded growth)', cell({ memorySection: memories([0, 1]) }), 'MODULE_MEMORY_UNBOUNDED'],
    ['maximum one page above the ceiling', cell({ memorySection: memories([1, 1, CELL_MAX_MEMORY_PAGES + 1]) }), 'MODULE_MEMORY_LIMIT'],
    ['maximum at the 4 GiB engine limit', cell({ memorySection: memories([1, 1, 65_536]) }), 'MODULE_MEMORY_LIMIT'],
    ['initial above maximum', cell({ memorySection: memories([1, 3, 2]) }), 'MODULE_MEMORY_LIMIT'],
    ['shared memory', cell({ memorySection: memories([3, 1, 2]) }), 'MODULE_MEMORY_SHARED'],
    ['memory64', cell({ memorySection: memories([5, 1, 2]) }), 'MODULE_MEMORY64'],
    ['custom page size flag', cell({ memorySection: memories([9, 1, 2]) }), 'MODULE_MEMORY_FLAGS'],
    ['two memories', cell({ memorySection: memories([1, 1, 2], [1, 1, 2]) }), 'MODULE_MEMORY_COUNT'],
    ['no memory at all', cell({ memorySection: null }), 'MODULE_MEMORY_COUNT'],
    ['an imported memory alongside the defined one', cell({ importSection: vector([[...text('env'), ...text('m'), 0x02, 0x01, 1, 2]]) }), 'MODULE_MEMORY_IMPORTED'],
    ['an imported memory hidden after an imported function and global', cell({ importSection: vector([
      [...text('env'), ...text('f'), 0x00, 0], [...text('env'), ...text('g'), 0x03, 0x7f, 0], [...text('env'), ...text('m'), 0x02, 0x00, 1]]) }), 'MODULE_MEMORY_IMPORTED'],
  ] as const)('%s', async (_label, bytes, code) => {
    await refusedBeforeCompile(bytes, code)
  })

  it.each([
    ['bad magic', (() => { const b = cell(); b[1] = 0x62; return b })()],
    ['unsupported version', (() => { const b = cell(); b[4] = 2; return b })()],
    ['truncated module', cell().slice(0, 40)],
    ['section length past the end', new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 9, 1, 1, 1, 2])],
    ['over-long LEB128 length', new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 0x84, 0x80, 0x80, 0x80, 0x80, 0x00])],
    ['LEB128 u32 overflow in a limit', new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 8, 1, 1, 1, 0xff, 0xff, 0xff, 0xff, 0x7f])],
    ['memory entries shorter than the section says', new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 5, 1, 1, 1, 2, 0])],
    ['unknown section id', cell({ extra: section(14, [0]) })],
    ['unknown import kind', cell({ importSection: vector([[...text('env'), ...text('x'), 0x07, 0]]) })],
  ] as const)('unparsable binary: %s', async (_label, bytes) => {
    await refusedBeforeCompile(bytes as Uint8Array<ArrayBuffer>, 'MODULE_BINARY')
  })

  it('a custom section that spells out a small memory changes nothing (text is never read)', async () => {
    const decoy = section(0, [...text('(memory 1 2)'), ...new TextEncoder().encode('(memory (export "memory") 1 2)')])
    await refusedBeforeCompile(cell({ memorySection: memories([0, 1]), extra: decoy }), 'MODULE_MEMORY_UNBOUNDED')
    await expect(admitCell('probe', pinOf(cell({ extra: decoy })), cell({ extra: decoy }))).resolves.toBeInstanceOf(WebAssembly.Module)
  })

  it('guest skills are held to the 16-page skill ceiling on their binary', async () => {
    await refusedBeforeCompile(cell({ memorySection: memories([1, 1, SKILL_MAX_MEMORY_PAGES + 1]) }), 'MODULE_MEMORY_LIMIT', SKILL_MAX_MEMORY_PAGES)
    const fits = cell({ memorySection: memories([1, 1, SKILL_MAX_MEMORY_PAGES]) })
    await expect(admitCell('probe', pinOf(fits), fits, SKILL_MAX_MEMORY_PAGES)).resolves.toBeInstanceOf(WebAssembly.Module)
  })

  it('the engine enforces the admitted maximum: memory.grow past it fails, inside it succeeds', async () => {
    const bytes = cell({ memorySection: memories([1, 1, 2]) })
    const module = await admitCell('probe', pinOf(bytes), bytes)
    const memory = new WebAssembly.Instance(module, {}).exports.memory as WebAssembly.Memory
    expect(() => memory.grow(2)).toThrow(RangeError)
    expect(memory.grow(1)).toBe(1)
    expect(memory.buffer.byteLength).toBe(2 * 65_536)
    expect(() => memory.grow(1)).toThrow(RangeError)
  })

  it('closes the WAT-regex bypass: a comment that looks bounded no longer smuggles an oversized memory through skillsmith', async () => {
    const cells = testHost({ origin: ORIGIN, fetchImpl: served() })
    const valid = (memory: string, decoy = '') => `(module
      ${decoy}
      ${memory}
      (func (export "mv_abi_version") (result i32) i32.const 1)
      (func (export "mv_alloc") (param i32) (result i32) i32.const 4096)
      (data (i32.const 1024) "{\\22abi\\22:1,\\22result\\22:{\\22answer\\22:42},\\22seq\\22:1,\\22status\\22:\\22ok\\22}")
      (func (export "mv_run") (param i32 i32) (result i64) i64.const 231928235008))`
    // Control: the honest 2-page skill runs.
    expect(await cells.compileAndRun({ wat: valid('(memory (export "memory") 1 2)'), name: 'honest', fuel: 50_000 }))
      .toMatchObject({ ok: true, result: { answer: 42 } })
    // The regex sees exactly one "(memory 1 2)" (in a comment) and passes; the real memory is named, so the regex never
    // sees it. The binary says 32 pages (or no maximum), and that is what is now judged.
    const oversized = await cells.compileAndRun({ wat: valid('(memory $m (export "memory") 1 32)', ';; (memory 1 2)'), name: 'smuggle', fuel: 50_000 })
    expect(oversized).toMatchObject({ ok: false, code: 'MODULE_MEMORY_LIMIT' })
    const unbounded = await cells.compileAndRun({ wat: valid('(memory $m (export "memory") 1)', ';; (memory 1 2)'), name: 'smuggle', fuel: 50_000 })
    // skillsmith itself already refuses a memory with no maximum (its own MEMORY_MAXIMUM); either refusal is closed.
    expect(unbounded.ok).toBe(false)
    expect(['MEMORY_MAXIMUM', 'MODULE_MEMORY_UNBOUNDED']).toContain(unbounded.ok ? '' : unbounded.code)
  }, 60_000)
})

describe('Probe 15: a one-byte flip of a pinned cell fails the pin before compiling', () => {
  it.each(['first code byte', 'memory maximum byte', 'last byte'] as const)('%s', async (where) => {
    const original = new Uint8Array(await readFile(new URL('seed-judge.wasm', CELLS)))
    const pin = CELL_PINS['seed-judge']!
    const flipped = Uint8Array.from(original)
    const index = where === 'last byte' ? flipped.length - 1 : where === 'first code byte' ? 8 : (() => {
      // Locate the memory section's maximum: flip it to make the declared memory larger.
      for (let i = 8; i < flipped.length - 4; i += 1) if (flipped[i] === 5 && flipped[i + 2] === 1 && flipped[i + 3] === 1) return i + 5
      throw new Error('memory section not found')
    })()
    flipped[index] = (flipped[index] ?? 0) ^ 0x01
    const compile = vi.spyOn(WebAssembly, 'compile')
    await expect(admitCell('seed-judge', pin, flipped)).rejects.toMatchObject({ code: 'MODULE_HASH' })
    expect(compile).not.toHaveBeenCalled()
    const cells = testHost({ origin: ORIGIN, fetchImpl: served({ 'seed-judge': flipped }) })
    expect(await cells.invoke('seed-judge', 'seed.platform', { platform: 'browser' })).toMatchObject({ ok: false, code: expect.stringMatching(/^MODULE_HASH/) })
    expect(compile).not.toHaveBeenCalled()
  })
})

describe('Probe 16: a runaway cell is killed at the deadline without wedging the host', () => {
  it('an infinite loop in mv_run times out in its own worker; the host event loop keeps ticking and the next cell answers', async () => {
    const runaway = cell({ loop: true })
    const cells = testHost({ origin: ORIGIN, fetchImpl: served({ runaway }), pins: { runaway: pinOf(runaway), 'nostr-core': CELL_PINS['nostr-core']! } })
    let ticks = 0
    const ticker = setInterval(() => { ticks += 1 }, 20)
    const started = performance.now()
    try {
      const result = await cells.invoke('runaway', 'run')
      const elapsed = performance.now() - started
      expect(result).toMatchObject({ ok: false, code: 'TIMEOUT', fuelUsed: null })
      expect(elapsed).toBeGreaterThanOrEqual(CELL_EXECUTION_TIMEOUT_MS - 10)
      expect(elapsed).toBeLessThan(CELL_EXECUTION_TIMEOUT_MS + 5000)
      // ~250 ticks at 20 ms in 5 s; a host blocked by the loop would record none.
      expect(ticks).toBeGreaterThan(100)
    } finally { clearInterval(ticker) }
    expect(workers.size).toBe(0)
    expect(await cells.invoke('nostr-core', 'nostr.ping')).toMatchObject({ ok: true, result: { pong: true } })
  }, 30_000)
})
