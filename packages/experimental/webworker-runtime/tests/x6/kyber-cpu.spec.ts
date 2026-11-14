/**
 * The Kyber Kernel weight CPU as the pinned zero-import cell `kyber-cpu`, its
 * serialized weights as the machine, and the first skill she can keep (`aukora.skill.v1` since the skills).
 *
 * Three independent constructions of one machine are held equal:
 *   - the ISA oracle (tests/x6/kyber-isa.ts): a switch on the opcode, written from the report's description;
 *   - the serialized affine/ReLU weight graph (apps/web/public/cells/kyber/cpu-weights.json, her exact bytes) run by a
 *     generic evaluator that knows no opcode (tests/x6/kyber-affine-relu.ts);
 *   - the cell (apps/web/public/cells/kyber-cpu.wat: the circuit of her 9,010-byte lowering re-expressed under Microverse
 *     ABI v1, built and metered by the pinned skillsmith cell), called through its own ABI on the admitted module.
 * The exhaustive comparison calls the admitted module in-process exactly as her execution worker does (fresh fuel grant,
 * mv_alloc, mv_run, response descriptor); the host path itself (createCellHost on a separate worker) is exercised on
 * fewer calls, because a worker round trip per transition would take minutes.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { CELL_BROWSER_FUEL_CAP, CELL_MAX_MEMORY_PAGES, CELL_PINS, METERED_CELL_EXPORTS, admitCell, cellCanonicalJson, createCellHost, inspectWasmMemory, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'
import { artifactDigest, encodeSkill, skillId, verifySkill, type SkillRecord } from '../../src/x6/skill-record.ts'
import { compileAffineRelu } from './kyber-affine-relu.ts'
import { COUNTDOWN_ROM, KYBER_MAX_STEPS, OP, countdownCases, countdownRecord, isaRun, isaStep, kyberCheck, pack, unpack, word, type KyberRun, type KyberState } from './kyber-isa.ts'

const REPO = new URL('../../../../../', import.meta.url)
const CELLS = new URL('apps/web/public/cells/', REPO)
const ORIGIN = 'https://node.example.invalid'
const PIN = CELL_PINS['kyber-cpu']!
/** The weight graph, unchanged from the Kyber Kernel evidence (cpu/cpu-weights.json, SHA256SUMS). */
const DOT_WEIGHTS_SHA256 = '6856c5fcdb0d50ebb8b1e402afa85385e307c58d1922a3bf7f73462539acf61c'
/** The shipped countdown skill's id: sha256(utf8("aukora.skill.v1\n") || countdown.json). */
const COUNTDOWN_ID = '1205ded1b88bba84abc4fd171529b7ae2fc35e1cd8890f68651e745d8e1fcada'

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
const testHost = (fetchImpl: typeof fetch, pins?: typeof CELL_PINS): CellHost => {
  const host = createCellHost({ origin: ORIGIN, fetchImpl, createWorker: nodeCellWorker, ...(pins ? { pins } : {}) })
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

const readCell = async (): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await readFile(new URL('kyber-cpu.wasm', CELLS)))
const readKyber = async (path: string): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await readFile(new URL(`kyber/${path}`, CELLS)))

interface Exports {
  memory: WebAssembly.Memory
  mv_alloc(length: number): number
  mv_run(pointer: number, length: number): bigint
  __mv_fuel_set(fuel: bigint): void
  __mv_fuel_remaining(): bigint
}

/**
 * The admitted module, called in-process the way cellWorkerMain calls it: fuel grant, mv_alloc, mv_run, descriptor.
 * `raw` takes the exact request text; `call` builds it with the ABI's own canonical JSON.
 */
async function directCell(fuel = Math.min(PIN.fuel, CELL_BROWSER_FUEL_CAP)) {
  const module = await admitCell('kyber-cpu', PIN, await readCell())
  const exports = new WebAssembly.Instance(module, {}).exports as unknown as Exports
  const grant = BigInt(fuel)
  const encoder = new TextEncoder(), decoder = new TextDecoder()
  let seq = 0
  let lastFuel = 0
  const raw = (text: string): string => {
    exports.__mv_fuel_set(grant)
    const pointer = exports.mv_alloc(text.length)
    if (pointer < 64) throw new Error('ALLOC')
    const { written } = encoder.encodeInto(text, new Uint8Array(exports.memory.buffer, pointer, text.length))
    exports.__mv_fuel_set(grant)
    const packed = exports.mv_run(pointer, written)
    lastFuel = Number(grant - exports.__mv_fuel_remaining())
    const length = Number(packed >> 32n), offset = Number(packed & 0xffff_ffffn)
    return decoder.decode(new Uint8Array(exports.memory.buffer, offset, length))
  }
  return {
    nextSeq: () => ++seq,
    raw,
    call(op: string, input: unknown): { text: string; answer: Record<string, unknown> } {
      const text = raw(cellCanonicalJson({ abi: 1, input, op, seq: ++seq }))
      return { text, answer: JSON.parse(text) as Record<string, unknown> }
    },
    fuel: () => lastFuel,
  }
}

interface Checkpoint { check: number; rom: number[]; state: KyberState; steps: number; stepsTaken: number }
const stateText = (s: KyberState): string => `{"a":${String(s.a)},"b":${String(s.b)},"halted":${String(s.halted)},"pc":${String(s.pc)}}`

/**
 * The graph's input layout (serialize_graph.py): a bits, b bits, pc one-hot, halt, then per ROM word 8 op one-hot,
 * 4 imm bits, 8 target one-hot.
 */
function graphInput(packed: number, rom: readonly number[], into = new Int32Array(177)): Int32Array {
  const { a, b, halted, pc } = unpack(packed)
  for (let i = 0; i < 4; i += 1) { into[i] = (a >> i) & 1; into[4 + i] = (b >> i) & 1 }
  for (let j = 0; j < 8; j += 1) into[8 + j] = pc === j ? 1 : 0
  into[16] = halted
  rom.forEach((w, j) => {
    const base = 17 + 20 * j
    for (let k = 0; k < 8; k += 1) into[base + k] = (w & 7) === k ? 1 : 0
    for (let k = 0; k < 4; k += 1) into[base + 8 + k] = (w >> (3 + k)) & 1
    for (let k = 0; k < 8; k += 1) into[base + 12 + k] = (w >> 7) === k ? 1 : 0
  })
  return into
}
/** The graph's 17 outputs back to a packed state; anything not 0/1 or a pc that is not one-hot is -1. */
function graphPacked(out: Int32Array): number {
  let packed = 0, hot = 0, pc = 0
  for (let i = 0; i < 17; i += 1) if (out[i] !== 0 && out[i] !== 1) return -1
  for (let i = 0; i < 8; i += 1) packed |= out[i]! << i
  for (let j = 0; j < 8; j += 1) if (out[8 + j] === 1) { hot += 1; pc = j }
  if (hot !== 1) return -1
  return packed | (pc << 8) | (out[16]! << 11)
}

let rng = 0x9e3779b9
const next = (): number => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return rng >>> 0 }

/** Walk every function body and global initializer against an integer-only opcode allowlist (from aura-focus-cell.spec.ts). */
function integerOnlyOpcodes(bytes: Uint8Array): Set<number> {
  const INTEGER_TYPES = new Set([0x7f, 0x7e])
  const allowed = (op: number): boolean => (op >= 0x00 && op <= 0x05) || (op >= 0x0b && op <= 0x11) || op === 0x1a || op === 0x1b
    || (op >= 0x20 && op <= 0x24) || op === 0x28 || op === 0x29 || (op >= 0x2c && op <= 0x37) || (op >= 0x3a && op <= 0x42)
    || (op >= 0x45 && op <= 0x5a) || (op >= 0x67 && op <= 0x8a) || op === 0xa7 || op === 0xac || op === 0xad || (op >= 0xc0 && op <= 0xc4)
  const uleb = (at: number): [number, number] => {
    let value = 0
    for (let shift = 0; ; shift += 7) {
      const byte = bytes[at++]
      if (byte === undefined || shift > 28) throw new Error(`LEB128 at ${String(at)}`)
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return [value, at]
    }
  }
  const sleb = (at: number): number => {
    for (let index = 0; index < 10; index += 1) if (((bytes[at++] ?? 0) & 0x80) === 0) return at
    throw new Error(`signed LEB128 at ${String(at)}`)
  }
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
        else at = sleb(at)
        depth += 1
      } else if (op === 0x0b) { depth -= 1; if (depth === 0) return at }
      else if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x24)) [, at] = uleb(at)
      else if (op === 0x0e) {
        let count; [count, at] = uleb(at)
        for (let index = 0; index <= count; index += 1) [, at] = uleb(at)
      }
      else if (op === 0x11) { [, at] = uleb(at); [, at] = uleb(at) }
      else if (op >= 0x28 && op <= 0x3e) { [, at] = uleb(at); [, at] = uleb(at) }
      else if (op === 0x3f || op === 0x40) at += 1
      else if (op === 0x41 || op === 0x42) at = sleb(at)
    }
    throw new Error('expression runs past its end')
  }
  let pos = 8, bodies = 0
  while (pos < bytes.length) {
    const id = bytes[pos++] ?? -1
    let size; [size, pos] = uleb(pos)
    const end = pos + size
    if (id === 1) {
      let count, at; [count, at] = uleb(pos)
      for (; count > 0; count -= 1) {
        if (bytes[at++] !== 0x60) throw new Error('function type')
        for (let side = 0; side < 2; side += 1) {
          let n; [n, at] = uleb(at)
          for (; n > 0; n -= 1) if (!INTEGER_TYPES.has(bytes[at++] ?? 0)) throw new Error('non-integer value type')
        }
      }
    } else if (id === 6) {
      let count, at; [count, at] = uleb(pos)
      for (; count > 0; count -= 1) {
        if (!INTEGER_TYPES.has(bytes[at] ?? 0)) throw new Error('non-integer global')
        at = expr(at + 2, end)
      }
    } else if (id === 10) {
      let count, at; [count, at] = uleb(pos)
      for (; count > 0; count -= 1) {
        let bodySize; [bodySize, at] = uleb(at)
        const bodyEnd = at + bodySize
        let groups; [groups, at] = uleb(at)
        for (; groups > 0; groups -= 1) { [, at] = uleb(at); if (!INTEGER_TYPES.has(bytes[at++] ?? 0)) throw new Error('non-integer local') }
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

describe('kyber-cpu: the Kyber Kernel weight CPU as a pinned cell (an instrument, no authority)', () => {
  it('is pinned: exact size and sha256, one fixed 12-page memory, zero imports, the metered exports, integer opcodes only', async () => {
    const bytes = await readCell()
    expect([bytes.byteLength, createHash('sha256').update(bytes).digest('hex')]).toEqual([PIN.bytes, PIN.sha256])
    expect([PIN.bytes, PIN.fuel]).toEqual([9750, 250_000_000])
    expect(PIN.fuel).toBeLessThanOrEqual(CELL_BROWSER_FUEL_CAP)
    expect(PIN.ops).toEqual(['cpu.step', 'cpu.run', 'cpu.resume'])
    expect(inspectWasmMemory('kyber-cpu', bytes, CELL_MAX_MEMORY_PAGES)).toEqual({ initial: 12, maximum: 12 })
    const module = await admitCell('kyber-cpu', PIN, bytes)
    expect(WebAssembly.Module.imports(module)).toEqual([])
    expect(WebAssembly.Module.exports(module).map(entry => entry.name).sort()).toEqual([...METERED_CELL_EXPORTS])
    expect(integerOnlyOpcodes(bytes).size).toBeGreaterThan(20)
    const changed = Uint8Array.from(bytes)
    changed[bytes.byteLength >> 1] = (changed[bytes.byteLength >> 1] ?? 0) ^ 0x01
    await expect(admitCell('kyber-cpu', PIN, changed)).rejects.toMatchObject({ name: 'CellError', code: 'MODULE_HASH' })
  })

  it('rebuilds from its WAT through compileAndRun (pinned skillsmith build + meter) to exactly the pinned bytes', async () => {
    const wat = await readFile(new URL('kyber-cpu.wat', CELLS), 'utf8')
    const built = await testHost(served()).compileAndRun({ wat, name: 'kyber-cpu', version: 'v1', op: 'cpu.run',
      input: { rom: [...COUNTDOWN_ROM], state: { a: 0, b: 2, halted: 0, pc: 0 }, steps: 64 } })
    expect(built).toMatchObject({ ok: true, meteredSha256: PIN.sha256, cellSha256: CELL_PINS['skillsmith']!.sha256,
      result: { halted: 1, state: { a: 2, b: 0, halted: 1, pc: 6 }, stepsTaken: 9 } })
  }, 60_000)

  it('the weights are the machine: oracle, generic evaluator over the shipped weights, and the cell agree on all 2,097,152 active and 2,048 halted transitions', async () => {
    const weightBytes = await readKyber('cpu-weights.json')
    expect(createHash('sha256').update(weightBytes).digest('hex')).toBe(DOT_WEIGHTS_SHA256)
    const graph = compileAffineRelu(JSON.parse(new TextDecoder().decode(weightBytes)))
    expect([graph.inputs, graph.nodes, graph.edges, graph.scalars]).toEqual([177, 384, 945, 1329])
    const cell = await directCell()
    // The hand-built request below is exactly the ABI's canonical JSON.
    const probeRom = [1, 2, 3, 4, 5, 6, 7, 1023]
    const probeState = { a: 1, b: 2, halted: 0, pc: 3 }
    const canonical = cellCanonicalJson({ abi: 1, input: { rom: probeRom, state: probeState }, op: 'cpu.step', seq: 7 })
    expect(canonical).toBe(`{"abi":1,"input":{"rom":[${probeRom.join(',')}],"state":${stateText(probeState)}},"op":"cpu.step","seq":7}`)

    const started = performance.now()
    const input = new Int32Array(177)
    const rom = new Array<number>(8).fill(0)
    let active = 0, halted = 0
    const check = (packed: number): void => {
      const expected = isaStep(packed, rom)
      const viaWeights = graphPacked(graph.forward(graphInput(packed, rom, input)))
      const seq = cell.nextSeq()
      const text = cell.raw(`{"abi":1,"input":{"rom":[${rom.join(',')}],"state":${stateText(unpack(packed))}},"op":"cpu.step","seq":${String(seq)}}`)
      const want = `{"abi":1,"result":{"state":${stateText(unpack(expected))}},"seq":${String(seq)},"status":"ok"}`
      if (viaWeights !== expected || text !== want) {
        throw new Error(`mismatch at state ${String(packed)} rom ${rom.join(',')}: oracle ${String(expected)} weights ${String(viaWeights)} cell ${text}`)
      }
    }
    // Every active local transition: 8 pcs x 1,024 words at that pc x 256 register pairs. The seven other words are
    // masked by the one-hot pc; they vary (xorshift) so the mask itself is exercised.
    for (let pc = 0; pc < 8; pc += 1) {
      for (let w = 0; w < 1024; w += 1) {
        for (let j = 0; j < 8; j += 1) rom[j] = next() & 1023
        rom[pc] = w
        for (let ab = 0; ab < 256; ab += 1) { check(pack({ a: ab & 15, b: ab >> 4, halted: 0, pc })); active += 1 }
      }
    }
    // Every halted state: the machine stays exactly where it is.
    for (let pc = 0; pc < 8; pc += 1) {
      for (let j = 0; j < 8; j += 1) rom[j] = next() & 1023
      for (let ab = 0; ab < 256; ab += 1) { check(pack({ a: ab & 15, b: ab >> 4, halted: 1, pc })); halted += 1 }
    }
    const seconds = (performance.now() - started) / 1000
    console.log(`kyber three-way: ${String(active)} active + ${String(halted)} halted transitions, 0 mismatches, ${seconds.toFixed(1)} s`)
    expect([active, halted]).toEqual([2_097_152, 2_048])
  }, 300_000)

  it('multi-step: 4,096 random ROMs and states, up to 64 steps, oracle = weights stepped = cell.run, halting included', async () => {
    const graph = compileAffineRelu(JSON.parse(new TextDecoder().decode(await readKyber('cpu-weights.json'))))
    const cell = await directCell()
    let haltedRuns = 0
    for (let trial = 0; trial < 4096; trial += 1) {
      const rom = Array.from({ length: 8 }, () => next() & 1023)
      const state = unpack(next() & 0x7ff)
      const steps = next() % 65
      const expected = isaRun(state, rom, steps)
      let packed = pack(state), taken = 0
      while (taken < steps && ((packed >> 11) & 1) === 0) { packed = graphPacked(graph.forward(graphInput(packed, rom))); taken += 1 }
      expect({ halted: (packed >> 11) & 1, state: unpack(packed), stepsTaken: taken }).toEqual(expected)
      expect(cell.call('cpu.run', { rom, state, steps }).answer).toMatchObject({ status: 'ok', result: expected })
      haltedRuns += expected.halted
    }
    expect(haltedRuns).toBeGreaterThan(100)
  }, 120_000)

  it('answers on a separate worker through createCellHost; she lists it; malformed input, halting and fuel exhaustion are refusals', async () => {
    const cells = testHost(served())
    expect(cells.list().find(entry => entry.cell === 'kyber-cpu')).toEqual({
      cell: 'kyber-cpu', sha256: PIN.sha256, bytes: 9750, fuel: 250_000_000, ops: ['cpu.step', 'cpu.run', 'cpu.resume'],
      loaded: 'not-loaded' })
    // The worked call in docs/auma/kyber-cpu.md: countdown from b = 7.
    const seven = await cells.invoke('kyber-cpu', 'cpu.run', { rom: [5, 388, 6, 3, 0, 388, 6, 6], state: { a: 0, b: 7, halted: 0, pc: 0 }, steps: 64 })
    expect(seven).toMatchObject({ ok: true, sha256: PIN.sha256,
      result: { halted: 1, state: { a: 7, b: 0, halted: 1, pc: 6 }, stepsTaken: 24 } })
    expect(seven.ok && seven.fuelUsed > 0 && seven.fuelUsed < PIN.fuel).toBe(true)
    // Short op names resolve through the manifest, as for every cell.
    expect(await cells.invoke('kyber-cpu', 'step', { rom: [...COUNTDOWN_ROM], state: { a: 3, b: 4, halted: 0, pc: 0 } }))
      .toMatchObject({ ok: true, op: 'cpu.step', result: { state: { a: 0, b: 4, halted: 0, pc: 1 } } })
    const state = { a: 0, b: 1, halted: 0, pc: 0 }
    const refusals: Array<[string, unknown, string]> = [
      ['cpu.run', { rom: [5, 388, 6, 3, 0, 388, 6], state, steps: 4 }, 'ROM_INVALID'],
      ['cpu.run', { rom: [5, 388, 6, 3, 0, 388, 6, 6, 6], state, steps: 4 }, 'ROM_INVALID'],
      ['cpu.run', { rom: [], state, steps: 4 }, 'ROM_INVALID'],
      ['cpu.run', { rom: [5, 388, 6, 3, 0, 388, 6, 1024], state, steps: 4 }, 'ROM_INVALID'],
      ['cpu.run', { rom: [5, 388, 6, 3, 0, 388, 6, -1], state, steps: 4 }, 'MALFORMED'],
      ['cpu.run', { rom: [5, 388, 6, 3, 0, 388, 6, '6'], state, steps: 4 }, 'MALFORMED'],
      ['cpu.run', { rom: 'countdown', state, steps: 4 }, 'MALFORMED'],
      ['cpu.run', { rom: [...COUNTDOWN_ROM], state: { ...state, a: 16 }, steps: 4 }, 'STATE_INVALID'],
      ['cpu.run', { rom: [...COUNTDOWN_ROM], state: { ...state, pc: 8 }, steps: 4 }, 'STATE_INVALID'],
      ['cpu.run', { rom: [...COUNTDOWN_ROM], state: { ...state, halted: 2 }, steps: 4 }, 'STATE_INVALID'],
      ['cpu.run', { rom: [...COUNTDOWN_ROM], state: { a: 0, b: 1, pc: 0 }, steps: 4 }, 'MALFORMED'],
      ['cpu.run', { rom: [...COUNTDOWN_ROM], state, steps: KYBER_MAX_STEPS + 1 }, 'STEPS_INVALID'],
      ['cpu.run', { checkpointEvery: 0, rom: [...COUNTDOWN_ROM], state, steps: 4 }, 'STEPS_INVALID'],
      ['cpu.run', { checkpointEvery: 2, rom: [...COUNTDOWN_ROM], state }, 'INPUT_SHAPE'],
      ['cpu.run', { rom: [...COUNTDOWN_ROM], state }, 'INPUT_SHAPE'],
      ['cpu.step', { rom: [...COUNTDOWN_ROM], state, steps: 4 }, 'INPUT_SHAPE'],
      ['cpu.resume', { rom: [...COUNTDOWN_ROM], state, steps: 4 }, 'INPUT_SHAPE'],
      ['cpu.jump', { rom: [...COUNTDOWN_ROM], state }, 'OP_UNKNOWN'],
      ['cpu.run', { rom: [...COUNTDOWN_ROM], state, steps: 4, extra: 1 }, 'MALFORMED'],
    ]
    for (const [op, input, code] of refusals) {
      expect(await cells.invoke('kyber-cpu', op, input), `${op} ${JSON.stringify(input)}`).toMatchObject({ ok: false, code })
    }
    // Halting: a halted machine takes no step and stays where it is.
    expect(await cells.invoke('kyber-cpu', 'cpu.run', { rom: [...COUNTDOWN_ROM], state: { a: 9, b: 9, halted: 1, pc: 5 }, steps: 64 }))
      .toMatchObject({ ok: true, result: { halted: 1, state: { a: 9, b: 9, halted: 1, pc: 5 }, stepsTaken: 0 } })
    expect(await cells.invoke('kyber-cpu', 'cpu.step', { rom: [...COUNTDOWN_ROM], state: { a: 9, b: 9, halted: 1, pc: 5 } }))
      .toMatchObject({ ok: true, result: { state: { a: 9, b: 9, halted: 1, pc: 5 } } })
    // A program that never halts runs exactly its budget; 4,096 steps with a checkpoint at every step fits the pinned fuel.
    const loop = [word(OP.INC0), word(OP.SWAP), word(OP.ADD01), word(OP.SWAP), word(OP.XOR01), word(OP.SWAP), word(OP.DEC1), word(OP.SWAP)]
    const worst = await cells.invoke('kyber-cpu', 'cpu.run', { checkpointEvery: 1, rom: [1023, 1023, 1023, 1023, 1023, 1023, 1023, 1023], state: { a: 15, b: 15, halted: 0, pc: 7 }, steps: KYBER_MAX_STEPS })
    expect(worst.ok && (worst.result as { checkpoints: unknown[] }).checkpoints.length).toBe(KYBER_MAX_STEPS + 1)
    expect(worst.ok && worst.fuelUsed < PIN.fuel).toBe(true)
    expect(await cells.invoke('kyber-cpu', 'cpu.run', { rom: loop, state: { a: 1, b: 2, halted: 0, pc: 0 }, steps: KYBER_MAX_STEPS }))
      .toMatchObject({ ok: true,
        result: { ...isaRun({ a: 1, b: 2, halted: 0, pc: 0 }, loop, KYBER_MAX_STEPS), halted: 0, stepsTaken: KYBER_MAX_STEPS } })
    // Fuel exhaustion: the same pinned bytes on a smaller grant trap and come back as FUEL, never as a value.
    const starved = testHost(served(), { 'kyber-cpu': { ...PIN, fuel: 200_000 } })
    expect(await starved.invoke('kyber-cpu', 'cpu.run', { rom: [...COUNTDOWN_ROM], state: { a: 0, b: 15, halted: 0, pc: 0 }, steps: 64 }))
      .toMatchObject({ ok: false, code: 'FUEL' })
    // A changed byte is refused by the pin before it compiles.
    const tampered = await readCell()
    tampered[100] = (tampered[100] ?? 0) ^ 0x01
    const refused = await testHost(served({ 'kyber-cpu': tampered })).invoke('kyber-cpu', 'cpu.run', { rom: [...COUNTDOWN_ROM], state, steps: 4 })
    expect(!refused.ok && refused.code.startsWith('MODULE_HASH')).toBe(true)
  }, 60_000)

  it('cpu.resume from any checkpoint the cell emitted gives the uninterrupted terminal state, at every cut of three programs', async () => {
    const cell = await directCell()
    const dotRom = [260, 6, 0, 3, 260, 6, 101, 7] // the evidence's rom.json
    const loop = [word(OP.INC0), word(OP.SWAP), word(OP.ADD01), word(OP.SWAP), word(OP.XOR01), word(OP.SWAP), word(OP.DEC1), word(OP.SWAP)]
    const programs: Array<[string, readonly number[], KyberState[], number]> = [
      ['countdown', COUNTDOWN_ROM, Array.from({ length: 16 }, (_, b) => ({ a: 0, b, halted: 0, pc: 0 })), 64],
      ['dot-rom', dotRom, Array.from({ length: 16 }, (_, i) => unpack((i * 97) & 0x7ff)), 48],
      ['never-halts', loop, [{ a: 1, b: 2, halted: 0, pc: 0 }, { a: 15, b: 0, halted: 0, pc: 3 }], 300],
    ]
    let cuts = 0
    for (const [name, rom, starts, steps] of programs) {
      for (const state of starts) {
        const plain = cell.call('cpu.run', { rom, state, steps }).answer
        const expected: KyberRun = isaRun(state, rom, steps)
        expect(plain, name).toMatchObject({ status: 'ok', result: expected })
        for (const every of [1, 7]) {
          const marked = cell.call('cpu.run', { checkpointEvery: every, rom, state, steps }).answer
          const result = marked.result as KyberRun & { checkpoints: Checkpoint[] }
          expect({ halted: result.halted, state: result.state, stepsTaken: result.stepsTaken }).toEqual(expected)
          expect(result.checkpoints.map(entry => entry.stepsTaken))
            .toEqual(Array.from({ length: Math.floor(expected.stepsTaken / every) + 1 }, (_, k) => k * every))
          for (const checkpoint of result.checkpoints) {
            // The check is exactly the documented function, and the state at the cut is the oracle's.
            expect(checkpoint.check).toBe(kyberCheck(rom, checkpoint.state, steps, checkpoint.stepsTaken))
            expect(checkpoint.state).toEqual(isaRun(state, rom, checkpoint.stepsTaken).state)
            expect(cell.call('cpu.resume', { checkpoint }).answer).toMatchObject({ status: 'ok', result: expected })
            cuts += 1
          }
        }
      }
    }
    expect(cuts).toBeGreaterThan(1000)
    // A changed checkpoint is refused; the check catches an edit. It is a checksum: a checkpoint made by hand with the
    // public function is accepted, which is why a checkpoint is evidence of a run, never permission for anything.
    const { checkpoints } = cell.call('cpu.run', { checkpointEvery: 3, rom: [...COUNTDOWN_ROM], state: { a: 0, b: 9, halted: 0, pc: 0 }, steps: 64 }).answer.result as { checkpoints: Array<Record<string, unknown> & { state: KyberState; rom: number[] }> }
    const cut = checkpoints[2]!
    const edits: Array<Record<string, unknown>> = [
      { ...cut, check: ((cut.check as number) ^ 1) >>> 0 },
      { ...cut, state: { ...cut.state, a: (cut.state.a + 1) & 15 } },
      { ...cut, state: { ...cut.state, b: (cut.state.b + 1) & 15 } },
      { ...cut, rom: cut.rom.map((w, i) => i === 3 ? w ^ 8 : w) },
      { ...cut, steps: (cut.steps as number) + 1 },
      { ...cut, stepsTaken: (cut.stepsTaken as number) + 1 },
    ]
    for (const checkpoint of edits) expect(cell.call('cpu.resume', { checkpoint }).answer).toMatchObject({ status: 'refused', code: 'CHECKPOINT_INVALID' })
    const overdrawn = { check: kyberCheck(COUNTDOWN_ROM, cut.state, 5, 6), rom: cut.rom, state: cut.state, steps: 5, stepsTaken: 6 }
    expect(cell.call('cpu.resume', { checkpoint: overdrawn }).answer).toMatchObject({ status: 'refused', code: 'CHECKPOINT_INVALID' })
    const handmade = { a: 0, b: 2, halted: 0, pc: 3 }
    expect(cell.call('cpu.resume', { checkpoint: { check: kyberCheck(COUNTDOWN_ROM, handmade, 64, 0), rom: [...COUNTDOWN_ROM], state: handmade, steps: 64, stepsTaken: 0 } }).answer)
      .toMatchObject({ status: 'ok', result: isaRun(handmade, COUNTDOWN_ROM, 64) })
  }, 120_000)
})

describe('aukora.skill.v1: a skill she can keep', () => {
  it('the shipped countdown record is rebuilt from the oracle byte for byte, its id is pinned, and its evidence replays on the cell', async () => {
    const cellBytes = await readCell()
    const program = await readKyber('skills/countdown.rom.json')
    const weights = await readKyber('cpu-weights.json')
    const shipped = await readKyber('skills/countdown.json')
    expect(new TextDecoder().decode(program)).toBe(`{"rom":[${COUNTDOWN_ROM.join(',')}]}`)
    const rebuilt = encodeSkill(countdownRecord({
      cell: await artifactDigest(cellBytes), program: await artifactDigest(program),
      weights: await artifactDigest(weights), scalars: 1329 }))
    expect(Buffer.from(rebuilt).equals(Buffer.from(shipped))).toBe(true)
    expect(await skillId(shipped)).toBe(COUNTDOWN_ID)
    // The id is the plain sha256 of the domain line and the record's bytes, computed here independently of the module.
    expect(createHash('sha256').update('aukora.skill.v1\n').update(shipped).digest('hex')).toBe(COUNTDOWN_ID)
    // The record's bytes are the cell ABI's canonical JSON of what they say.
    expect(new TextDecoder().decode(shipped)).toBe(cellCanonicalJson(JSON.parse(new TextDecoder().decode(shipped))))
    const verdict = await verifySkill(shipped, { cell: cellBytes, program, weights }, COUNTDOWN_ID)
    expect(verdict).toMatchObject({ ok: true, id: COUNTDOWN_ID, record: { name: 'countdown', op: 'cpu.run',
      cell: { kind: 'pinned', name: 'kyber-cpu', sha256: PIN.sha256, abi: 1 }, weights: { digest: DOT_WEIGHTS_SHA256, scalars: 1329 } } })
    expect(await verifySkill(shipped, { cell: cellBytes, program, weights })).toMatchObject({ ok: true, id: COUNTDOWN_ID })
    // The record names exactly the pinned cell; each evidence case gives the same answer on the cell and the oracle.
    const cell = await directCell()
    const cases = countdownCases()
    expect(cases.map(entry => (entry.output as KyberRun).state.a)).toEqual(Array.from({ length: 16 }, (_, b) => b))
    for (const entry of cases) expect(cell.call(entry.op, entry.input).answer).toEqual(expect.objectContaining({ status: 'ok', result: entry.output }))
  })

  it('verifySkill refuses evidence about another ROM without a presented id, including checkpoint ROMs', async () => {
    const cellBytes = await readCell()
    const program = await readKyber('skills/countdown.rom.json')
    const weights = await readKyber('cpu-weights.json')
    const shipped = await readKyber('skills/countdown.json')
    const record = JSON.parse(new TextDecoder().decode(shipped)) as SkillRecord
    const changedRom = COUNTDOWN_ROM.map((w, i) => i === 3 ? w ^ 8 : w)
    const first = record.evidence.cases[0]!
    const input = first.input as { rom: number[]; state: KyberState; steps: number }
    const check = kyberCheck(COUNTDOWN_ROM, input.state, input.steps, 0)
    const checkpoint = { check, rom: [...COUNTDOWN_ROM], state: input.state, steps: input.steps, stepsTaken: 0 }
    const resumed = encodeSkill({ ...record, evidence: { ...record.evidence, cases: [
      { ...first, op: 'cpu.resume', input: { checkpoint } }, ...record.evidence.cases.slice(1),
    ] } })
    expect(await verifySkill(resumed, { cell: cellBytes, program, weights })).toMatchObject({ ok: true })
    for (const entry of [
      { ...first, input: { ...input, rom: changedRom } },
      { ...first, op: 'cpu.resume', input: { checkpoint: { ...checkpoint, rom: changedRom } } },
      { ...first, input: { ...input, checkpoint: { ...checkpoint, rom: changedRom } } },
    ]) {
      const changed = encodeSkill({ ...record, evidence: { ...record.evidence, cases: [entry, ...record.evidence.cases.slice(1)] } })
      expect(await verifySkill(changed, { cell: cellBytes, program, weights })).toMatchObject({ ok: false, code: 'SKILL_EVIDENCE_MISMATCH' })
    }
  })

  it('verifySkill refuses an invalid program even when its digest matches', async () => {
    const cellBytes = await readCell()
    const weights = await readKyber('cpu-weights.json')
    const shipped = await readKyber('skills/countdown.json')
    const record = JSON.parse(new TextDecoder().decode(shipped)) as SkillRecord
    for (const text of ['{', '{}', '{"rom":[5]}', '{"rom":[5,388,6,3,0,388,6,1024]}']) {
      const program = new TextEncoder().encode(text)
      const changed = encodeSkill({ ...record, program: { digest: await artifactDigest(program) } })
      expect(await verifySkill(changed, { cell: cellBytes, program, weights })).toMatchObject({ ok: false, code: 'SKILL_PROGRAM_MISMATCH' })
    }
  })

  it('verifySkill refuses a weight scalar count off by one without a presented id', async () => {
    const cellBytes = await readCell()
    const program = await readKyber('skills/countdown.rom.json')
    const weights = await readKyber('cpu-weights.json')
    const shipped = await readKyber('skills/countdown.json')
    const record = JSON.parse(new TextDecoder().decode(shipped)) as SkillRecord
    const changed = encodeSkill({ ...record, weights: { ...record.weights!, scalars: record.weights!.scalars + 1 } })
    expect(await verifySkill(changed, { cell: cellBytes, program, weights })).toMatchObject({ ok: false, code: 'SKILL_WEIGHTS_MISMATCH' })
  })

  it('verifySkill refuses one changed byte in the cell, the program, the weights, and anywhere in the record', async () => {
    const cellBytes = await readCell()
    const program = await readKyber('skills/countdown.rom.json')
    const weights = await readKyber('cpu-weights.json')
    const shipped = await readKyber('skills/countdown.json')
    const flip = (bytes: Uint8Array, at: number): Uint8Array => {
      const copy = Uint8Array.from(bytes)
      copy[at] = (copy[at] ?? 0) ^ 0x01
      return copy
    }
    expect(await verifySkill(shipped, { cell: flip(cellBytes, 4000), program, weights }, COUNTDOWN_ID)).toMatchObject({ ok: false, code: 'SKILL_CELL_MISMATCH' })
    expect(await verifySkill(shipped, { cell: cellBytes, program: flip(program, 10), weights }, COUNTDOWN_ID)).toMatchObject({ ok: false, code: 'SKILL_PROGRAM_MISMATCH' })
    expect(await verifySkill(shipped, { cell: cellBytes, program, weights: flip(weights, 5000) }, COUNTDOWN_ID)).toMatchObject({ ok: false, code: 'SKILL_WEIGHTS_MISMATCH' })
    expect(await verifySkill(shipped, { cell: cellBytes, program, weights: null }, COUNTDOWN_ID)).toMatchObject({ ok: false, code: 'SKILL_WEIGHTS_MISMATCH' })
    // Every single-bit change anywhere in the record is refused under its id, before the bytes are parsed.
    for (let at = 0; at < shipped.byteLength; at += 1) {
      const verdict = await verifySkill(flip(shipped, at), { cell: cellBytes, program, weights }, COUNTDOWN_ID)
      if (verdict.ok || verdict.code !== 'SKILL_ID_MISMATCH') throw new Error(`byte ${String(at)} not refused: ${JSON.stringify(verdict)}`)
    }
    // Without an id, a changed byte is still refused by a digest, the shape or the canon: a digest character, a key, a colon.
    const text = new TextDecoder().decode(shipped)
    const at = text.indexOf(PIN.sha256)
    expect(await verifySkill(flip(shipped, at), { cell: cellBytes, program, weights })).toMatchObject({ ok: false, code: 'SKILL_CELL_MISMATCH' })
    expect(await verifySkill(flip(shipped, text.indexOf('"digest"') + 1), { cell: cellBytes, program, weights })).toMatchObject({ ok: false, code: 'SKILL_SHAPE' })
    expect(await verifySkill(flip(shipped, text.indexOf('"digest"') + 8), { cell: cellBytes, program, weights })).toMatchObject({ ok: false, code: 'SKILL_NOT_CANONICAL' })
    expect(await verifySkill(flip(shipped, 0), { cell: cellBytes, program, weights })).toMatchObject({ ok: false, code: 'SKILL_NOT_CANONICAL' })
  }, 60_000)

  /**
   * the skills changed this scan honestly. BEFORE: the words `kyber` and `skill-record` were refused everywhere in
   * the runtime source and the edge, except skill-record.ts itself, the KYBERCPU block of wasm-cells.ts and the x6_cell
   * description. AFTER: her own skills tool now reads skills on purpose, so the scan lists EXACTLY the places that may
   * name a skill or the kyber cell, each by file and by its marked blocks with their exact count, and refuses any other.
   * The needles: `kyber`, `skill-record`, `x6_skill`/`x6-skill`, `aukora.skill`, `/dsh/home/skills`, `/cells/kyber/`,
   * and the skills tool's own names (`listKeptSkills`, `SKILLS_DIR`, `SKILLS_MAX`, `SKILL_INDEX*`, `keptSkillRows`,
   * `createSkillShelf`), so importing the shelf's reader by name is caught too.
   * The trees walked (which had walked only the runtime's src and deploy/cloudflare/src): the
   * runtime's src; packages/client/ui-layout/src (her promotion, staging and approval code: portal/promotion-sources.ts,
   * SovereigntySurface.tsx, aumlok/class3-approval.ts, head-promotion.ts); apps/web/src; server/; all of deploy/ (the
   * edge, its CI). Every `__tests__` directory is skipped. In them, only the listed files and blocks may name a skill.
   * the cord-echo skill (one ongoing Cord skill) added protection only. BEFORE it the needle covered the skill and kyber names
   * above. AFTER it the needle also covers the cord names (`cord-echo`, `cord-run`, `cord-observe`, `/dsh/home/cord`,
   * `aukora.cord`), and the list names exactly the new places: cord-run.ts, cord-observe.ts, server/cord-echo-cell.build.mjs
   * and deploy/cloudflare/src/cord-echo-cell.mjs whole; the CORDECHO blocks of ball-loader.ts (5), wasm-cells.ts,
   * write-set-inventory.ts and voice-read-only.ts (1 each). kyber-cell.mjs stays listed whole, as before.
   */
  it('her authority path never reads a skill or the kyber cell: only the listed files and marked blocks may name them', async () => {
    const NEEDLE = new RegExp([String.raw`kyber`, String.raw`skill-record`, String.raw`x6[-_]skill`, String.raw`aukora\.skill`, String.raw`/dsh/home/skills`,
      String.raw`/cells/kyber/`, 'listKeptSkills', 'SKILLS_DIR', String.raw`\bSKILLS_MAX`, 'SKILL_INDEX', 'keptSkillRows', 'createSkillShelf',
      'cord-echo', 'cord-run', 'cord-observe', '/dsh/home/cord', String.raw`aukora\.cord`,
      'menger-hive', 'menger-run', 'menger-observe', 'MENGERHIVE', String.raw`aukora\.menger`, '[\'"`]hive[\'"`]'].join('|'), 'iu')
    const RUNTIME = 'packages/experimental/webworker-runtime/src/'
    /** Every tree the scan walks (each path relative to the repo, ending in `/`). */
    const TREES = [RUNTIME, 'packages/client/ui-layout/src/', 'apps/web/src/', 'server/', 'deploy/']
    /** Marked regions: `// ---- <begin> begin ----` to the next `// ---- <end> end ----`. */
    const region = (begin: string, end: string) => new RegExp(`// ---- ${begin} begin ----[\\s\\S]*?// ---- ${end} end ----`, 'gu')
    const KYBERCPU = region('KYBERCPU block', 'KYBERCPU block')
    const KYBERSKILL = region('KYBERSKILL (?:block|field)', 'KYBERSKILL (?:block|field)')
    const PENTCODEC = region('PENTCODEC block', 'PENTCODEC block')
    const CORDECHO = region('CORDECHO block', 'CORDECHO block')
    const MENGERHIVE = region('MENGERHIVE block', 'MENGERHIVE block')
    /** The ONE marked route hunk of the edge's router (at most eight lines, no marker inside it). */
    const mark = (end: string): string => `[ \\t]*// ---- KYBERHAND hook ${end} ----\\n`
    const KYBERHAND = new RegExp(`${mark('begin')}(?:(?![ \\t]*// ---- KYBERHAND)[^\\n]*\\n){1,8}?${mark('end')}`, 'gu')
    /** The only files that may name them, how (whole file, or marked blocks and how many), and why. */
    const ALLOWED: Record<string, { whole?: true; blocks?: Array<[pattern: RegExp, count: number]>; x6CellDescription?: true }> = {
      // The skill record module itself (pure: no I/O; imported by ball-loader.ts's KYBERSKILL import block and the build script).
      [`${RUNTIME}x6/skill-record.ts`]: { whole: true },
      // The self-check is a read-only instrument: it reports worked examples and nothing decides on its answer.
      [`${RUNTIME}x6/self-check.ts`]: { whole: true },
      // The pin table names the cell inside its KYBERCPU block; the cell host adds `verifiedBytes` without naming it.
      [`${RUNTIME}x6/wasm-cells.ts`]: { blocks: [[KYBERCPU, 1], [CORDECHO, 1], [MENGERHIVE, 1]] },
      // Her skills tool: the import, the `check` classification, the shelf, her self-state registry field, the tool.
      [`${RUNTIME}x6/ball-loader.ts`]: { blocks: [[KYBERSKILL, 5], [PENTCODEC, 1], [CORDECHO, 5], [MENGERHIVE, 6]], x6CellDescription: true },
      // Her self-state's `skills` field: its description names the tool (the rows are names and ids only).
      [`${RUNTIME}x6/self-state.ts`]: { blocks: [[KYBERSKILL, 1]] },
      // Attribution only: the write-set inventory lists the kept-skill store so every write to it is classified.
      [`${RUNTIME}x6/write-set-inventory.ts`]: { blocks: [[KYBERSKILL, 1], [CORDECHO, 1]] },
      // A refusal only: the voice record lists the tool as refused from a look-only voice turn.
      [`${RUNTIME}x6/voice-read-only.ts`]: { blocks: [[KYBERSKILL, 1], [CORDECHO, 1]] },
      // Build scripts, run by hand or in a gate, never by her body: they write the shipped cell and skill files.
      'server/kyber-cpu-cell.build.mjs': { whole: true },
      'server/kyber-skills.build.mjs': { whole: true },
      // The pentora-codec cell's build script (hand-run, like the two above): it names her weights file only to write the
      // test fixture that holds the carry's packets equal to the reference packets.
      'server/pentora-codec.build.mjs': { whole: true },
      // A computation that grants nothing and stores nothing. Her runtime's handoff
      // module and the edge's cell module (admission and one run, no storage) name the cell openly; the edge's router
      // names it only inside ONE marked route hunk (a second hunk, or a stray marker, is an offender: the needle
      // matches the marker's own name).
      [`${RUNTIME}x6/cell-handoff.ts`]: { whole: true },
      'deploy/cloudflare/src/kyber-cell.mjs': { whole: true },
      'deploy/cloudflare/src/worker.mjs': { blocks: [[KYBERHAND, 1]] },
      // x6_cell `carry` reads her weights file and the shipped record for ONE compute through the
      // pentora-codec cell: a computation, nothing decides on it. Exactly one marked block in each file (the whole of
      // pentora-carry.ts above; the `carry` parameters in ball-loader.ts): a second block, or the names outside it, fails.
      [`${RUNTIME}x6/pentora-carry.ts`]: { blocks: [[PENTCODEC, 1]] },
      // Her shelf module (reads the shipped record, calls the edge, writes only
      // /dsh/home/cord/), the blind-twin function (pure), the cell's build script (hand-run) and the edge's loader for
      // the second allow-listed cell (names bytes only). Nothing in her authority path reads any of them.
      [`${RUNTIME}x6/cord-run.ts`]: { whole: true },
      [`${RUNTIME}x6/cord-observe.ts`]: { whole: true },
      'server/cord-echo-cell.build.mjs': { whole: true },
      'deploy/cloudflare/src/cord-echo-cell.mjs': { whole: true },
      // Split-body wave runner (stateless edge calls, zero storage), pure observability/twin oracle,
      // hand-run build script, and edge CompiledWasm loader. Nothing in her authority path reads any of them.
      [`${RUNTIME}x6/menger-run.ts`]: { whole: true },
      [`${RUNTIME}x6/menger-observe.ts`]: { whole: true },
      'server/menger-hive-cell.build.mjs': { whole: true },
      'deploy/cloudflare/src/menger-hive-cell.mjs': { whole: true },
      // A protection only: the frozen-path list and its card copy name cord-run.ts and menger-run.ts so that no proposal can
      // change them (two marked entries each: the frozen files and the closed-inside-open list). The list's own test names them.
      'deploy/ci/frozen-paths.mjs': { blocks: [[CORDECHO, 2], [MENGERHIVE, 2]] },
      'packages/client/ui-layout/src/client/spatial/aumlok/frozen-paths.ts': { blocks: [[CORDECHO, 2], [MENGERHIVE, 2]] },
      'deploy/ci/frozen-paths.test.mjs': { whole: true },
    }
    const offenders: string[] = []
    const seen = new Set<string>()
    const walk = async (dir: URL, base: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === '__tests__') continue
        const path = `${base}${entry.name}`
        if (entry.isDirectory()) { await walk(new URL(`${entry.name}/`, dir), `${path}/`); continue }
        if (!/\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|json)$/.test(entry.name)) continue
        let source = await readFile(new URL(entry.name, dir), 'utf8')
        const allowed = ALLOWED[path]
        if (allowed) seen.add(path)
        if (allowed?.whole) continue
        for (const [pattern, count] of allowed?.blocks ?? []) {
          const found = source.match(pattern)?.length ?? 0
          if (found !== count) offenders.push(`${path}: ${String(found)} marked blocks, expected ${String(count)}`)
          source = source.replace(pattern, '')
        }
        if (allowed?.x6CellDescription) source = source.replace(/(name: 'x6_cell',\s+description:)[\s\S]*?(?=\n      parameters:)/u, '$1')
        if (NEEDLE.test(source)) offenders.push(path)
      }
    }
    for (const tree of TREES) await walk(new URL(tree, REPO), tree)
    expect(offenders).toEqual([])
    // A walker that found none of the listed files proves nothing.
    expect([...seen].sort()).toEqual(Object.keys(ALLOWED).sort())
    // Among her runtime, pages, server and edge sources the skill record module is imported only by ball-loader.ts (inside
    // its KYBERSKILL import block) and by server/kyber-skills.build.mjs (listed whole above: it encodes the shipped record).
    const loader = await readFile(new URL(`${RUNTIME}x6/ball-loader.ts`, REPO), 'utf8')
    expect(loader.replace(KYBERSKILL, '')).not.toMatch(/skill-record/u)
    // The carry module is imported by ball-loader.ts alone (the self-check names its probe after it and imports nothing).
    const carryUsers: string[] = []
    for (const name of await readdir(new URL(`${RUNTIME}x6/`, REPO))) {
      if (!name.endsWith('.ts') || name === 'pentora-carry.ts') continue
      if (/from '\.\/pentora-carry\.ts'/u.test(await readFile(new URL(`${RUNTIME}x6/${name}`, REPO), 'utf8'))) carryUsers.push(name)
    }
    expect(carryUsers).toEqual(['ball-loader.ts'])
  })
})
