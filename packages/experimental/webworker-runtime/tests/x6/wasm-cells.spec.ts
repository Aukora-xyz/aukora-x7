/** Auma's pinned Wasm cells, admitted and run exactly as her browser worker runs them (real cell bytes). */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { CELL_EXECUTION_TIMEOUT_MS, CELL_BROWSER_FUEL_CAP, CELL_PINS, METERED_CELL_EXPORTS, SKILL_EXPECTED_EXPORTS, admitCell, cellCanonicalJson, createCellHost, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'

const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const ORIGIN = 'https://x61.example.invalid'
/** The page origin's static files, as the edge serves apps/web/dist. */
const served = (override: Record<string, Uint8Array<ArrayBuffer> | number> = {}) => (async (input: RequestInfo | URL) => {
  const url = new URL(String(input))
  const name = url.pathname.replace(/^\/cells\//, '').replace(/\.wasm$/, '')
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/cells/')) return new Response('no', { status: 404 })
  const replaced = override[name]
  if (typeof replaced === 'number') return new Response('gone', { status: replaced })
  const bytes = replaced ?? new Uint8Array(await readFile(new URL(`${name}.wasm`, CELLS)))
  return new Response(bytes, { headers: { 'content-type': 'application/wasm' } })
}) as typeof fetch

const hosts = new Set<CellHost>()
const workers = new Set<Worker>()
let createdWorkers = 0
let terminatedWorkers = 0
const nodeCellWorker = (source: string): CellWorker => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = value => parentPort.postMessage(value);
    parentPort.on('message', data => globalThis.onmessage({ data }));
    ${source}
  `, { eval: true, execArgv: [] })
  workers.add(worker)
  createdWorkers += 1
  return {
    listen(onMessage, onFailure) {
      worker.on('message', onMessage)
      worker.on('error', onFailure)
      worker.on('messageerror', onFailure)
    },
    postMessage: message => worker.postMessage(message),
    async terminate() {
      await worker.terminate()
      worker.removeAllListeners()
      workers.delete(worker)
      terminatedWorkers += 1
    },
  }
}
const testHost = (deps: Parameters<typeof createCellHost>[0]): CellHost => {
  const host = createCellHost({ createWorker: nodeCellWorker, ...deps })
  hosts.add(host)
  return host
}
afterEach(async () => {
  try { await Promise.all([...hosts].map(host => host.dispose())) }
  finally {
    hosts.clear()
    await Promise.all([...workers].map(worker => worker.terminate()))
    workers.clear()
  }
})

describe('Wasm cells in the worker', () => {
  it('ships exactly the pinned cells: every file hashes to its pin, has zero imports and the metered ABI v1 exports', async () => {
    const files = (await readdir(CELLS)).filter(name => name.endsWith('.wasm')).map(name => name.slice(0, -5)).sort()
    expect(files).toEqual(Object.keys(CELL_PINS).sort())
    expect(files).toHaveLength(25)
    for (const name of files) {
      const bytes = new Uint8Array(await readFile(new URL(`${name}.wasm`, CELLS)))
      const pin = CELL_PINS[name]!
      expect([bytes.byteLength, createHash('sha256').update(bytes).digest('hex')], name).toEqual([pin.bytes, pin.sha256])
      const module = await admitCell(name, pin, bytes)
      expect(WebAssembly.Module.imports(module)).toEqual([])
      expect(WebAssembly.Module.exports(module).map(entry => entry.name).sort()).toEqual([...METERED_CELL_EXPORTS])
    }
  })

  it('runs real ops with a fresh fuel grant, and passes a cell\'s own refusal back by its code', async () => {
    const cells = testHost({ origin: ORIGIN, fetchImpl: served() })
    expect(await cells.invoke('nostr-core', 'nostr.ping')).toMatchObject({ ok: true, result: { pong: true, version: 1 },
      sha256: CELL_PINS['nostr-core']!.sha256 })
    expect(await cells.invoke('kira-membrane', 'kira.membrane_ping')).toMatchObject({ ok: true, result: { pong: true, version: 1 } })
    expect(await cells.invoke('seed-judge', 'seed.platform', { platform: 'browser' })).toMatchObject({ ok: true, result: { code: 0 } })
    expect(await cells.invoke('seed-judge', 'seed.merge', { baseline: 'allow', kind: 'tool', verdict: 'ask' }))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(await cells.invoke('seed-judge', 'seed.merge', { baseline: 'not-a-verdict' })).toMatchObject({ ok: false, code: 'MALFORMED' })
    const ping = await cells.invoke('nostr-core', 'nostr.ping')
    expect(ping.ok && ping.fuelUsed > 0 && ping.fuelUsed < CELL_PINS['nostr-core']!.fuel).toBe(true)
  })

  it('refuses tampered bytes before compiling, unknown cells and malformed ops, and never throws', async () => {
    const tampered = new Uint8Array(await readFile(new URL('seed-judge.wasm', CELLS)))
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
    const cells = testHost({ origin: ORIGIN, fetchImpl: served({ 'seed-judge': tampered, 'gate-judge': 404 }) })
    expect(await cells.invoke('seed-judge', 'seed.platform', { platform: 'browser' })).toMatchObject({ ok: false, code: expect.stringMatching(/^MODULE_HASH/) })
    expect(await cells.invoke('gate-judge', 'gate.step', {})).toMatchObject({ ok: false, code: 'MODULE_UNAVAILABLE (HTTP 404)' })
    expect(await cells.invoke('no-such-cell', 'x.y')).toMatchObject({ ok: false, code: 'CELL_UNKNOWN' })
    expect(await cells.invoke('nostr-core', 'ping; drop')).toMatchObject({ ok: false, code: 'OP_INVALID' })
    expect(await cells.invoke('nostr-core', 'nostr.ping', { ratio: 0.5 })).toMatchObject({ ok: false, code: expect.stringMatching(/^UNREPRESENTABLE/) })
    const oversized = new Uint8Array((CELL_PINS['laya']!.bytes) + 1)
    expect(await testHost({ origin: ORIGIN, fetchImpl: served({ laya: oversized }) }).invoke('laya', 'laya.manifest'))
      .toMatchObject({ ok: false, code: expect.stringMatching(/^MODULE_BOUND/) })
  })

  it('stops a call that runs out of fuel, and the next call starts a fresh instance', async () => {
    const pins = { 'nostr-core': { ...CELL_PINS['nostr-core']!, fuel: 1000 } }
    const cells = testHost({ origin: ORIGIN, fetchImpl: served(), pins })
    // The meter traps before a debit it cannot cover; a bulk memory debit reports TRAP (as the predecessor's caller does).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const starved = await cells.invoke('nostr-core', 'nostr.ping')
      expect(starved.ok).toBe(false)
      expect(['FUEL', 'TRAP']).toContain(starved.ok ? '' : starved.code)
    }
    // The same cell with its real grant answers: the starved instance was discarded, not reused.
    expect(await testHost({ origin: ORIGIN, fetchImpl: served() }).invoke('nostr-core', 'nostr.ping')).toMatchObject({ ok: true })
  })

  it('reaches ops whose names carry digits (NIP-44), caps fuel per call for this thread, and takes organism-tools\' larger requests', async () => {
    const cells = testHost({ origin: ORIGIN, fetchImpl: served() })
    expect(await cells.invoke('nostr-core', 'nostr.nip44_padded_len', { length: 5 })).not.toMatchObject({ code: 'OP_INVALID' })
    expect(cells.list().every(row => row.fuel <= CELL_BROWSER_FUEL_CAP)).toBe(true)
    expect(cells.list().find(row => row.cell === 'organism-tools')?.fuel).toBe(CELL_BROWSER_FUEL_CAP)
    const large = 'x'.repeat(2 * 1024 * 1024)
    expect(await cells.invoke('nostr-core', 'nostr.ping', { large })).toMatchObject({ ok: false, code: 'REQUEST_BOUND' })
    expect(await cells.invoke('organism-tools', 'tools.ping', { large })).not.toMatchObject({ code: 'REQUEST_BOUND' })
  })

  it('encodes canonical JSON as the ABI requires', () => {
    expect(cellCanonicalJson({ b: 1, a: [true, null, 'x"\\\u0001'], é: 2, z: undefined })).toBe('{"a":[true,null,"x\\"\\\\\\u0001"],"b":1,"é":2}')
    expect(() => cellCanonicalJson(1.5)).toThrow()
  })

  it('compiles WAT via skillsmith, meters and admits it under zero-import/16-page caps, and executes it', async () => {
    const cells = testHost({ origin: ORIGIN, fetchImpl: served() })
    const validWat = `(module
      (memory (export "memory") 1 2)
      (func (export "mv_abi_version") (result i32) i32.const 1)
      (func (export "mv_alloc") (param i32) (result i32) i32.const 4096)
      (data (i32.const 1024) "{\\22abi\\22:1,\\22result\\22:{\\22answer\\22:42},\\22seq\\22:1,\\22status\\22:\\22ok\\22}")
      (func (export "mv_run") (param i32 i32) (result i64) i64.const 231928235008))`
    const res = await cells.compileAndRun({ wat: validWat, name: 'answer', fuel: 50_000 })
    expect(res).toMatchObject({ ok: true, cell: 'answer', op: 'run', result: { answer: 42 } })
    expect(res.ok && res.fuelUsed > 0).toBe(true)
    expect(res.codeSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(res.meteredSha256).toMatch(/^[0-9a-f]{64}$/u)

    const unboundedMemoryWat = validWat.replace('(memory (export "memory") 1 2)', '(memory (export "memory") 1 32)')
    expect(await cells.compileAndRun({ wat: unboundedMemoryWat, name: 'answer' }))
      .toMatchObject({ ok: false, code: 'SKILL_MEMORY_LIMIT' })

    const legacyAliasWat = validWat
      .replace('(export "mv_abi_version")', '(export "aukora_abi_version")')
      .replace('(export "mv_alloc")', '(export "aukora_alloc")')
      .replace('(export "mv_run")', '(export "aukora_call")')
    const aliasRes = await cells.compileAndRun({ wat: legacyAliasWat, name: 'alias-answer', fuel: 50_000 })
    expect(aliasRes).toMatchObject({ ok: true, cell: 'alias-answer', op: 'run', result: { answer: 42 } })

    const badExportsWat = `(module
      (memory (export "memory") 1 2)
      (func (export "wrong_fn") (result i32) i32.const 1))`
    const badRes = await cells.compileAndRun({ wat: badExportsWat, name: 'bad-exports', fuel: 50_000 })
    expect(badRes).toMatchObject({
      ok: false,
      code: 'EXPORTS',
      sha256: null,
      cellSha256: CELL_PINS['skillsmith']!.sha256,
      expectedExports: SKILL_EXPECTED_EXPORTS,
      gotExports: ['memory', 'wrong_fn'],
    })

    // Synthesized WAT skills run on a single-call MeteredCell where seq may be omitted or constant (0).
    const omittedSeqPayload = '{"abi":1,"status":"ok","result":{"echo":true}}'
    const omittedSeqPacked = (BigInt(omittedSeqPayload.length) << 32n) | 1024n
    const omittedSeqWat = `(module
      (memory (export "memory") 1 2)
      (func (export "mv_abi_version") (result i32) i32.const 1)
      (func (export "mv_alloc") (param i32) (result i32) i32.const 4096)
      (data (i32.const 1024) "${omittedSeqPayload.replace(/"/gu, '\\22')}")
      (func (export "mv_run") (param i32 i32) (result i64) i64.const ${String(omittedSeqPacked)}))`
    const omittedSeqRes = await cells.compileAndRun({ wat: omittedSeqWat, name: 'skill-echo', fuel: 50_000 })
    expect(omittedSeqRes).toMatchObject({ ok: true, cell: 'skill-echo', op: 'run', result: { echo: true } })

    const malformedPayload = '{"ok":true,"data":123}'
    const malformedPacked = (BigInt(malformedPayload.length) << 32n) | 1024n
    const malformedWat = `(module
      (memory (export "memory") 1 2)
      (func (export "mv_abi_version") (result i32) i32.const 1)
      (func (export "mv_alloc") (param i32) (result i32) i32.const 4096)
      (data (i32.const 1024) "${malformedPayload.replace(/"/gu, '\\22')}")
      (func (export "mv_run") (param i32 i32) (result i64) i64.const ${String(malformedPacked)}))`
    const malformedRes = await cells.compileAndRun({ wat: malformedWat, name: 'bad-envelope', fuel: 50_000 })
    expect(malformedRes).toMatchObject({
      ok: false,
      code: 'MALFORMED_RESPONSE',
      expected: { abi: 1, status: 'ok | refused', result: '<json>', seq: 'optional integer' },
      got: { abi: null, seq: null, status: null, hasResult: false },
    })
  })
})

// Real unmetered modules with the legacy metering export names. Admission cannot infer instruction coverage.
function legacyCell(stage: 'none' | 'start' | 'abi' | 'alloc' | 'run' | 'fuel-set' | 'fuel-remaining', payload = '{"abi":1,"seq":1,"status":"ok","result":true}'): Uint8Array<ArrayBuffer> {
  const unsigned = (value: number): number[] => {
    const bytes: number[] = []
    do { const byte = value & 127; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)) } while (value)
    return bytes
  }
  const signed = (value: bigint): number[] => {
    const bytes: number[] = []
    while (true) {
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
  const loop = [0x03, 0x40, 0x0c, 0x00, 0x0b]
  const body = (which: typeof stage, output: number[]): number[] => {
    const instructions = [0, ...(stage === which ? loop : []), ...output, 0x0b]
    return [...unsigned(instructions.length), ...instructions]
  }
  const output = [...new TextEncoder().encode(payload)]
  const packed = (BigInt(output.length) << 32n) | 1024n
  return new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, vector([
      [0x60, 0, 1, 0x7f], [0x60, 1, 0x7f, 1, 0x7f], [0x60, 2, 0x7f, 0x7f, 1, 0x7e],
      [0x60, 1, 0x7e, 0], [0x60, 0, 1, 0x7e], [0x60, 0, 0],
    ])),
    ...section(3, vector([[0], [1], [2], [3], [4], [5]])),
    ...section(5, [1, 1, 1, 1]),
    ...section(7, vector([
      [...text('memory'), 2, 0], [...text('mv_abi_version'), 0, 0], [...text('mv_alloc'), 0, 1],
      [...text('mv_run'), 0, 2], [...text('__mv_fuel_set'), 0, 3], [...text('__mv_fuel_remaining'), 0, 4],
    ])),
    ...(stage === 'start' ? section(8, [5]) : []),
    ...section(10, vector([
      body('abi', [0x41, 1]), body('alloc', [0x41, ...signed(4096n)]), body('run', [0x42, ...signed(packed)]),
      body('fuel-set', []), body('fuel-remaining', [0x42, 0]), body('start', []),
    ])),
    ...section(11, [1, 0, 0x41, ...signed(1024n), 0x0b, ...unsigned(output.length), ...output]),
  ])
}
const legacyHost = (bytes: Uint8Array<ArrayBuffer>, createWorker = nodeCellWorker): CellHost => testHost({
  origin: ORIGIN,
  fetchImpl: served({ legacy: bytes }),
  createWorker,
  pins: { legacy: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), fuel: 100_000 } },
})

describe('independent Wasm execution deadline', () => {
  it.each(['start', 'abi', 'alloc', 'run', 'fuel-set', 'fuel-remaining'] as const)(
    'terminates a real unmetered %s loop without blocking the host', async (stage) => {
      const cells = legacyHost(legacyCell(stage))
      const beforeTerminations = terminatedWorkers
      const started = performance.now()
      const pending = cells.invoke('legacy', 'run')
      let settled = false
      void pending.then(() => { settled = true })
      // Yield on this event loop while the other thread is trapped in Wasm.
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(settled).toBe(false)
      const result = await pending
      expect(result).toMatchObject({ ok: false, code: 'TIMEOUT', fuelUsed: null })
      expect(performance.now() - started).toBeGreaterThanOrEqual(CELL_EXECUTION_TIMEOUT_MS - 10)
      expect(terminatedWorkers - beforeTerminations).toBe(1)
      expect(workers.size).toBe(0)
      await cells.dispose()
    }, 20_000,
  )

  it('starts a fresh worker after a timeout and preserves other cached module admission', async () => {
    const bytes = legacyCell('run')
    const cells = testHost({ origin: ORIGIN, fetchImpl: served({ legacy: bytes }), pins: {
      legacy: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), fuel: 100_000 },
      'nostr-core': CELL_PINS['nostr-core']!,
    } })
    const beforeWorkers = createdWorkers
    const pending = cells.invoke('legacy', 'run')
    const healthy = cells.invoke('nostr-core', 'nostr.ping')
    expect(await pending).toMatchObject({ ok: false, code: 'TIMEOUT' })
    expect(await healthy).toMatchObject({ ok: true, result: { pong: true } })
    expect(createdWorkers - beforeWorkers).toBe(2)
  }, 20_000)

  it('keeps per-cell sequences correct for overlapping callers and reuses the host worker', async () => {
    const cells = testHost({ origin: ORIGIN, fetchImpl: served() })
    const beforeWorkers = createdWorkers
    const replies = await Promise.all(Array.from({ length: 8 }, () => cells.invoke('nostr-core', 'nostr.ping')))
    expect(replies.every(reply => reply.ok)).toBe(true)
    expect(createdWorkers - beforeWorkers).toBe(1)
    await cells.dispose()
    expect(await cells.invoke('nostr-core', 'nostr.ping')).toMatchObject({ ok: false, code: 'CELL_HOST_DISPOSED' })
    expect(workers.size).toBe(0)
  })

  it('fails closed when independent workers are unavailable', async () => {
    const cells = legacyHost(legacyCell('run'), () => { throw new Error('unavailable') })
    expect(await cells.invoke('legacy', 'run')).toMatchObject({ ok: false, code: 'CELL_WORKER_UNAVAILABLE' })
  })

  it('terminates in-flight execution on host disposal and settles queued work', async () => {
    let started: (() => void) | undefined
    const dispatched = new Promise<void>((resolve) => { started = resolve })
    const cells = legacyHost(legacyCell('run'), (source) => {
      const worker = nodeCellWorker(source)
      return { ...worker, postMessage(message) { worker.postMessage(message); started?.() } }
    })
    const pending = cells.invoke('legacy', 'run')
    const queued = cells.invoke('legacy', 'run')
    await dispatched
    await cells.dispose()
    expect(await pending).toMatchObject({ ok: false, code: 'CELL_HOST_DISPOSED' })
    expect(await queued).toMatchObject({ ok: false, code: 'CELL_HOST_DISPOSED' })
    expect(workers.size).toBe(0)
  })

  it('rejects fractional and unsafe request/receipt numbers without rejecting finite floating results', async () => {
    const values = [0.5, -1.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, NaN, Infinity, -Infinity]
    const cells = legacyHost(legacyCell('none', '{"abi":1,"seq":1,"status":"ok","result":{"ratio":0.5}}'))
    const beforeWorkers = createdWorkers
    for (const value of values) {
      expect(() => cellCanonicalJson({ receipt: { amount: value } })).toThrow('integers only')
      expect(await cells.invoke('legacy', 'run', { value })).toMatchObject({ ok: false, code: expect.stringMatching(/^UNREPRESENTABLE/) })
    }
    expect(createdWorkers).toBe(beforeWorkers)
    expect(cellCanonicalJson({ a: Number.MIN_SAFE_INTEGER, z: Number.MAX_SAFE_INTEGER }))
      .toBe('{"a":-9007199254740991,"z":9007199254740991}')
    expect(await cells.invoke('legacy', 'run')).toMatchObject({ ok: true, result: { ratio: 0.5 } })
  })
})
