/**
 * The Aura focus cell (a shadow of computeAuraFocusShadow, no authority) through her own admission and execution
 * code: the pin, inspectWasmMemory, admitCell, the integer-only rule of its profile, a real call through
 * createCellHost on a separate worker (Node worker_threads standing in for the browser worker), and a rebuild from
 * its WAT through compileAndRun with the pinned skillsmith cell. Exactness against the JavaScript reference on
 * 80,548 inputs is server/aura-focus-cell-shadow.test.mjs.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { CELL_MAX_MEMORY_PAGES, CELL_PINS, METERED_CELL_EXPORTS, admitCell, createCellHost, inspectWasmMemory, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'

const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const ORIGIN = 'https://x61.example.invalid'
const PIN = CELL_PINS['aura-focus']!
type Served = Record<string, Uint8Array<ArrayBuffer>>
const served = (override: Served = {}): typeof fetch => async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const name = url.pathname.replace(/^\/cells\//, '').replace(/\.wasm$/, '')
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/cells/')) return new Response('no', { status: 404 })
  const bytes = override[name] ?? new Uint8Array(await readFile(new URL(`${name}.wasm`, CELLS)))
  return new Response(bytes, { headers: { 'content-type': 'application/wasm' } })
}

const hosts = new Set<CellHost>()
const workers = new Set<Worker>()
const nodeCellWorker = (source: string): CellWorker => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = value => parentPort.postMessage(value);
    parentPort.on('message', data => globalThis.onmessage({ data }));
    ${source}
  `, { eval: true, execArgv: [] })
  workers.add(worker)
  return {
    listen(onMessage, onFailure) {
      worker.on('message', onMessage)
      worker.on('error', onFailure)
      worker.on('messageerror', onFailure)
    },
    postMessage: (message) => { worker.postMessage(message) },
    async terminate() {
      await worker.terminate()
      worker.removeAllListeners()
      workers.delete(worker)
    },
  }
}
const testHost = (fetchImpl: typeof fetch): CellHost => {
  const host = createCellHost({ origin: ORIGIN, fetchImpl, createWorker: nodeCellWorker })
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

/** Read an unsigned LEB128 at `at`; returns [value, next]. */
const uleb = (bytes: Uint8Array, at: number): [number, number] => {
  let value = 0
  for (let shift = 0; ; shift += 7) {
    const byte = bytes[at++]
    if (byte === undefined || shift > 28) throw new Error(`LEB128 at ${String(at)}`)
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return [value, at]
  }
}
const sleb = (bytes: Uint8Array, at: number): number => {
  for (let index = 0; index < 10; index += 1) if (((bytes[at++] ?? 0) & 0x80) === 0) return at
  throw new Error(`signed LEB128 at ${String(at)}`)
}

/**
 * Walk every function body and global initializer and accept only an allowlist of integer, control and memory
 * opcodes; any float opcode, float value type or unknown opcode fails. Returns the opcodes seen.
 */
function integerOnlyOpcodes(bytes: Uint8Array): Set<number> {
  const INTEGER_TYPES = new Set([0x7f, 0x7e])
  const allowed = (op: number): boolean => (op >= 0x00 && op <= 0x05) || (op >= 0x0b && op <= 0x11) || op === 0x1a || op === 0x1b
    || (op >= 0x20 && op <= 0x24) || op === 0x28 || op === 0x29 || (op >= 0x2c && op <= 0x37) || (op >= 0x3a && op <= 0x42)
    || (op >= 0x45 && op <= 0x5a) || (op >= 0x67 && op <= 0x8a) || op === 0xa7 || op === 0xac || op === 0xad || (op >= 0xc0 && op <= 0xc4)
  const seen = new Set<number>()
  const expr = (at: number, end: number): number => {
    let depth = 1
    while (at < end) {
      const op = bytes[at++] ?? -1
      if (!allowed(op)) throw new Error(`opcode 0x${op.toString(16)} at ${String(at - 1)}`)
      seen.add(op)
      if (op === 0x02 || op === 0x03 || op === 0x04) {
        const type = bytes[at] ?? 0
        if (type === 0x40 || INTEGER_TYPES.has(type)) at += 1
        else if (type === 0x7d || type === 0x7c) throw new Error('float block type')
        else at = sleb(bytes, at)
        depth += 1
      } else if (op === 0x0b) { depth -= 1; if (depth === 0) return at }
      else if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x24)) [, at] = uleb(bytes, at)
      else if (op === 0x0e) {
        let count; [count, at] = uleb(bytes, at)
        for (let index = 0; index <= count; index += 1) [, at] = uleb(bytes, at)
      }
      else if (op === 0x11) { [, at] = uleb(bytes, at); [, at] = uleb(bytes, at) }
      else if ((op >= 0x28 && op <= 0x3e)) { [, at] = uleb(bytes, at); [, at] = uleb(bytes, at) }
      else if (op === 0x3f || op === 0x40) at += 1
      else if (op === 0x41 || op === 0x42) at = sleb(bytes, at)
    }
    throw new Error('expression runs past its end')
  }
  let pos = 8, bodies = 0
  while (pos < bytes.length) {
    const id = bytes[pos++] ?? -1
    let size; [size, pos] = uleb(bytes, pos)
    const end = pos + size
    if (id === 1) { // types: no float parameter or result
      let count, at; [count, at] = uleb(bytes, pos)
      for (; count > 0; count -= 1) {
        if (bytes[at++] !== 0x60) throw new Error('function type')
        for (let side = 0; side < 2; side += 1) {
          let n; [n, at] = uleb(bytes, at)
          for (; n > 0; n -= 1) if (!INTEGER_TYPES.has(bytes[at++] ?? 0)) throw new Error('non-integer value type')
        }
      }
    } else if (id === 6) { // globals: integer type, integer initializer
      let count, at; [count, at] = uleb(bytes, pos)
      for (; count > 0; count -= 1) {
        if (!INTEGER_TYPES.has(bytes[at] ?? 0)) throw new Error('non-integer global')
        at = expr(at + 2, end)
      }
    } else if (id === 10) { // code: integer locals, allowlisted instructions
      let count, at; [count, at] = uleb(bytes, pos)
      for (; count > 0; count -= 1) {
        let bodySize; [bodySize, at] = uleb(bytes, at)
        const bodyEnd = at + bodySize
        let groups; [groups, at] = uleb(bytes, at)
        for (; groups > 0; groups -= 1) { [, at] = uleb(bytes, at); if (!INTEGER_TYPES.has(bytes[at++] ?? 0)) throw new Error('non-integer local') }
        if (expr(at, bodyEnd) !== bodyEnd) throw new Error('body length')
        at = bodyEnd
        bodies += 1
      }
    }
    pos = end
  }
  if (bodies === 0) throw new Error('no code')
  return seen
}

describe('Aura focus cell: admitted and run by her own cell code (shadow only)', () => {
  it('is pinned, one fixed page of memory, zero imports, the metered exports, integer opcodes only', async () => {
    const bytes = new Uint8Array(await readFile(new URL('aura-focus.wasm', CELLS)))
    expect([bytes.byteLength, createHash('sha256').update(bytes).digest('hex')]).toEqual([PIN.bytes, PIN.sha256])
    expect(PIN.ops).toEqual(['aura.focus', 'aura.focus_both', 'aura.decide_net', 'aura.decide_both'])
    expect(inspectWasmMemory('aura-focus', bytes, CELL_MAX_MEMORY_PAGES)).toEqual({ initial: 1, maximum: 1 })
    const module = await admitCell('aura-focus', PIN, bytes)
    expect(WebAssembly.Module.imports(module)).toEqual([])
    expect(WebAssembly.Module.exports(module).map(entry => entry.name).sort()).toEqual([...METERED_CELL_EXPORTS])
    expect(integerOnlyOpcodes(bytes).size).toBeGreaterThan(20)
    // The walker is not vacuous: one f64.const appended to a function body fails it.
    const floatBody = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 10, 14, 1, 12, 0, 0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0x1a, 0x0b])
    expect(() => integerOnlyOpcodes(floatBody)).toThrow(/opcode 0x44/)
    const changed = Uint8Array.from(bytes)
    changed[bytes.byteLength >> 1] = (changed[bytes.byteLength >> 1] ?? 0) ^ 0x01
    await expect(admitCell('aura-focus', PIN, changed)).rejects.toMatchObject({ name: 'CellError', code: 'MODULE_HASH' })
  })

  it('answers on a separate worker through createCellHost, refuses out of profile, and a changed byte is refused by the pin', async () => {
    const cells = testHost(served())
    const counts = [10, 10, 10, 10, 9, 10, 0, 0, 20]
    // activeOrgans 9 of 10: the reference says consolidate, coherence-deficit (aura-focus-shadow.test.mjs).
    const consolidate = await cells.invoke('aura-focus', 'aura.focus', { counts, heartbeat: [0, 0], mismatch: 0, scores: [] })
    expect(consolidate).toMatchObject({ ok: true, sha256: PIN.sha256, result: { status: 1, focus: 2, reason: 9, checks: [0, 0, 0, 0, 0] } })
    expect(consolidate.ok && consolidate.fuelUsed > 0 && consolidate.fuelUsed < PIN.fuel).toBe(true)
    // Heartbeat exactly 0.7 (0x3FE6666666666666): boundary, no focus.
    expect(await cells.invoke('aura-focus', 'aura.focus', { counts, heartbeat: [0x3fe66666, 0x66666666], mismatch: 0, scores: [] }))
      .toMatchObject({ ok: true, result: { status: 2, focus: 0, reason: 3 } })
    expect(await cells.invoke('aura-focus', 'aura.focus', { counts: [10, 0, 10, 10, 10, 10, 0, 0, 20], heartbeat: [0, 0], mismatch: 0, scores: [] }))
      .toMatchObject({ ok: false, code: 'INPUTS_INCOMPLETE' })
    expect(await cells.invoke('aura-focus', 'aura.focus', { counts, heartbeat: [0, 0], mismatch: 0, scores: Array(6).fill([0, 0]) }))
      .toMatchObject({ ok: false, code: 'SCORES_OVER_FIVE' })
    expect(await cells.invoke('aura-focus', 'aura.focus', { counts, heartbeat: [0x7ff80000, 0], mismatch: 0, scores: [] }))
      .toMatchObject({ ok: false, code: 'INPUTS_INCOMPLETE' })
    const tampered = new Uint8Array(await readFile(new URL('aura-focus.wasm', CELLS)))
    tampered[100] = (tampered[100] ?? 0) ^ 0x01
    const refused = await testHost(served({ 'aura-focus': tampered })).invoke('aura-focus', 'aura.focus', { counts, heartbeat: [0, 0], mismatch: 0, scores: [] })
    expect(!refused.ok && refused.code.startsWith('MODULE_HASH')).toBe(true)
  })

  it('rebuilds from its WAT through compileAndRun to exactly the pinned bytes', async () => {
    const wat = await readFile(new URL('aura-focus.wat', CELLS), 'utf8')
    const built = await testHost(served()).compileAndRun({ wat, name: 'aura-focus', version: 'v1', op: 'aura.focus',
      input: { counts: [10, 10, 10, 10, 10, 10, 0, 0, 20], heartbeat: [0, 0], mismatch: 0, scores: [] } })
    expect(built).toMatchObject({ ok: true, meteredSha256: PIN.sha256, cellSha256: CELL_PINS['skillsmith']!.sha256,
      result: { status: 1, focus: 1, reason: 10, checks: [0, 0, 0, 0, 2] } })
  }, 60_000)
})
